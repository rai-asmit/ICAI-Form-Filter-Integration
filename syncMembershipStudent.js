"use strict";

/**
 * syncMembershipStudent.js — Orchestrator
 *
 * Handles processing for:
 *   - Student Registration Form        → SO + Customer Deposit (no Invoice, no JV, no CP)
 *   - Form 2   (New Membership)        → Duplicate Customer + SO + Invoice + Customer Payment + JV
 *   - Form 6   (COP Application)       → SO + Invoice + Customer Payment + JV (if contributions)
 *   - Form 3/Fellowship                → SO + Invoice + Customer Payment + JV (if contributions)
 *   - Other Forms                      → SO + Customer Deposit + Invoice
 *
 * Data pipeline:
 *   1. Fetch transactions from ICAI
 *   2. Verify duplicates (Reference_Number + Payment_Order_Id)
 *   3. Save unique records → incoming.json
 *   4. Process each record — log step results to per-step success/failure files
 *   5. Save sync-summary.json
 *
 * Daily directory: data/YYYY/MM/DD/
 *   incoming.json, duplicates.json,
 *   sales-order-success.json, sales-order-failure.json,
 *   invoice-success.json, invoice-failure.json,
 *   customer-payment-success.json, customer-payment-failure.json,
 *   journal-voucher-success.json, journal-voucher-failure.json,
 *   sync-summary.json
 */

require("dotenv").config();
const pLimit = require("p-limit").default;
const { Mutex } = require("async-mutex");

const {
  netsuiteRequest,
  fetchAllCustomers,
  createSalesOrder,
  createCustomerDeposit,
  createCustomerPayment,
  createTransFormRecordInvoice,
} = require("./netsuiteClient--Rest");

const msConfig = require("./membershipStudentConfig.json");

// ── Modules ──────────────────────────────────────────────────────────────────
const { authenticate, fetchTransactions } = require("./membership/icaiClient");
const {
  parseFeeHeads,
  classifyFeeHeads,
  getConfigForForm,
  getAllAllowedForms,
  withRetry,
} = require("./membership/helpers");
const {
  buildSalesOrderData,
  buildCustomerDepositData,
  buildCustomerPaymentData,
  buildInvoiceBody,
  buildJournalEntryData,
} = require("./membership/builders");
const { duplicateCustomerAsMember } = require("./membership/customerDuplicate");
const stateManager = require("./membership/stateManager");

// ── Constants ────────────────────────────────────────────────────────────────
const CONCURRENCY_LIMIT = 3;
const syncMutex = new Mutex();

// ── NetSuite JV creation ─────────────────────────────────────────────────────
async function createJournalEntry(data) {
  return netsuiteRequest("POST", "/services/rest/record/v1/journalEntry", data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE TRANSACTION PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process one transaction end-to-end:
 *   1. Parse & classify fee heads (Regular/Discount → SO, Contribution → JV)
 *   2. [Form 2] Duplicate customer (Student → Member)
 *   3. Create Sales Order (Regular + Discount items only, with tax)
 *   4. Transform SO → Invoice (skip for Student Registration Form)
 *   5. Create Journal Voucher (contribution items only, if any)
 *   6. Create Customer Payment
 *
 * Each step's result is logged to the appropriate success/failure file.
 */
async function processTransaction(transaction, customerMap, formConfig, dailyDir) {
  const ref = transaction.Reference_Number;
  const form = transaction.Form_Description;

  const result = {
    reference: ref,
    form,
    customerId: transaction.Customer_ID,
    paymentAmount: transaction.Payment_Amount,
    steps: {},
    success: false,
    error: null,
  };

  // Helper — log step result to the correct daily file
  const logStep = (step, success, extra = {}) => {
    stateManager.logStepResult(dailyDir, step, {
      reference: ref,
      form,
      customerId: transaction.Customer_ID,
      paymentOrderId: transaction.Payment_Order_Id,
      success,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  };

  let currentStep = "init";

  try {
    // ── Step 1: Parse & classify fee heads ────────────────────────────────────
    const allFeeHeads = parseFeeHeads(transaction.Fee_Head);
    if (allFeeHeads.length === 0) {
      throw new Error("No fee heads found in transaction");
    }

    const { invoiceItems, contributionItems } = classifyFeeHeads(
      allFeeHeads,
      formConfig.contribution_codes || []
    );

    result.steps.parseFeeHeads = {
      total: allFeeHeads.length,
      invoiceCount: invoiceItems.length,
      contributionCount: contributionItems.length,
      invoiceItems: invoiceItems.map((f) => `${f.code}(${f.amount})`),
      contributionItems: contributionItems.map((f) => `${f.code}(${f.amount})`),
    };

    console.log(
      `[MembershipSync] [${ref}] Fee heads: ${allFeeHeads.length} total | Invoice: ${invoiceItems.length} | Contributions: ${contributionItems.length}`
    );

    // ── Step 2: Resolve customer ─────────────────────────────────────────────
    let customerInternalId = customerMap[transaction.Customer_ID];

    if (form === "Form 2") {
      try {
        const newCustomer = await duplicateCustomerAsMember(
          transaction.Customer_ID,
          transaction
        );
        customerInternalId = newCustomer.id;
        result.steps.customerDuplication = {
          success: true,
          newCustomerId: newCustomer.id,
        };
      } catch (err) {
        console.error(
          `[MembershipSync] [${ref}] Customer duplication failed: ${err.message}`
        );
        result.steps.customerDuplication = {
          success: false,
          error: err.message,
        };
        if (!customerInternalId) {
          throw new Error(
            `Customer ${transaction.Customer_ID} not found and duplication failed: ${err.message}`
          );
        }
        console.warn(
          `[MembershipSync] [${ref}] Falling back to existing customer: ${customerInternalId}`
        );
      }
    } else {
      if (!customerInternalId) {
        throw new Error(
          `Customer ${transaction.Customer_ID} not found in NetSuite`
        );
      }
    }

    result.steps.customer = {
      entityId: transaction.Customer_ID,
      internalId: customerInternalId,
    };

    // ── Step 3: Create Sales Order (Regular + Discount items only) ────────────
    currentStep = "sales-order";

    if (invoiceItems.length === 0) {
      throw new Error(
        "No invoice items (Regular/Discount) found — cannot create Sales Order"
      );
    }

    const soData = buildSalesOrderData(
      transaction,
      customerInternalId,
      invoiceItems,
      formConfig
    );
    if (!soData) {
      throw new Error(
        "Failed to build Sales Order — no valid line items with internal IDs"
      );
    }

    console.log(`[MembershipSync] [${ref}] Creating Sales Order...`);
    const soResponse = await withRetry(
      () => createSalesOrder(soData),
      `SO:${ref}`
    );
    if (!soResponse || !soResponse.id) {
      console.error(`[MembershipSync] [${ref}] SO response was null/empty:`, JSON.stringify(soResponse));
      throw new Error(`Sales Order creation returned no ID — response: ${JSON.stringify(soResponse)}`);
    }
    const soId = soResponse.id;
    result.steps.salesOrder = {
      success: true,
      id: soId,
      tranId: soResponse.tranid || null,
    };
    console.log(`[MembershipSync] [${ref}] SO created: ${soId}`);
    logStep("sales-order", true, { salesOrderId: soId, tranId: soResponse.tranid || null });

    const isStudentRegistration = formConfig.type === "student_registration";
    const isMembershipForm = formConfig.type === "membership";

    if (isStudentRegistration) {
      // ── Student Registration: SO + Customer Deposit ─────────────────────────
      currentStep = "customer-deposit";
      const cdData = buildCustomerDepositData(soId, transaction, formConfig);
      console.log(
        `[MembershipSync] [${ref}] Creating Customer Deposit (amount: ${transaction.Payment_Amount}, MID: ${transaction.MID || "N/A"})...`
      );
      const cdResponse = await withRetry(
        () => createCustomerDeposit(cdData),
        `CD:${ref}`
      );
      if (!cdResponse || !cdResponse.id) {
        console.error(`[MembershipSync] [${ref}] CD response was null/empty:`, JSON.stringify(cdResponse));
        throw new Error(`Customer Deposit creation returned no ID — response: ${JSON.stringify(cdResponse)}`);
      }
      const cdId = cdResponse.id;
      result.steps.customerDeposit = { success: true, id: cdId };
      console.log(`[MembershipSync] [${ref}] Customer Deposit created: ${cdId}`);
      logStep("customer-deposit", true, { customerDepositId: cdId, amount: transaction.Payment_Amount });

    } else if (isMembershipForm) {
      // ── Membership (Form 2 / 3 / 6): SO + Invoice + JV (if any) + Customer Payment ──

      // Step 4: Invoice
      currentStep = "invoice";
      const invoiceBody = buildInvoiceBody(transaction, formConfig);
      console.log(`[MembershipSync] [${ref}] Creating Invoice from SO ${soId}...`);
      const invoiceResponse = await withRetry(
        () => createTransFormRecordInvoice(soId, invoiceBody),
        `Invoice:${ref}`
      );
      if (!invoiceResponse || !invoiceResponse.id) {
        console.error(`[MembershipSync] [${ref}] Invoice response was null/empty:`, JSON.stringify(invoiceResponse));
        throw new Error(`Invoice creation returned no ID — response: ${JSON.stringify(invoiceResponse)}`);
      }
      const invoiceId = invoiceResponse.id;
      result.steps.invoice = { success: true, id: invoiceId };
      console.log(`[MembershipSync] [${ref}] Invoice created: ${invoiceId}`);
      logStep("invoice", true, { invoiceId, salesOrderId: soId });

      // Step 5: JV for contributions (if any) — must be before CP
      let jvId = null;
      let totalContribution = 0;
      if (contributionItems.length > 0) {
        currentStep = "journal-voucher";
        try {
          const vendorMap = msConfig.contribution_vendor_mapping || {};
          totalContribution = contributionItems.reduce((sum, item) => sum + item.amount, 0);
          const jvData = buildJournalEntryData(transaction, contributionItems, formConfig, customerInternalId, vendorMap);
          if (jvData) {
            console.log(
              `[MembershipSync] [${ref}] Creating JV for ${contributionItems.length} contribution item(s) (total: ${totalContribution})...`
            );
            const jvResponse = await withRetry(() => createJournalEntry(jvData), `JV:${ref}`);
            jvId = jvResponse.id;
            result.steps.journalVoucher = { success: true, id: jvId };
            console.log(`[MembershipSync] [${ref}] JV created: ${jvId}`);
            logStep("journal-voucher", true, { journalVoucherId: jvId, amount: totalContribution });
          }
        } catch (err) {
          console.error(
            `[MembershipSync] [${ref}] JV creation failed (non-blocking): ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`
          );
          result.steps.journalVoucher = { success: false, error: err.response?.data ?? err.message };
          logStep("journal-voucher", false, { error: err.response?.data ?? err.message, amount: totalContribution });
        }
      }

      // Step 6: Customer Payment — applied to Invoice + JV
      currentStep = "customer-payment";
      const cpData = buildCustomerPaymentData(customerInternalId, transaction, formConfig, invoiceId, jvId, totalContribution);
      const applyDesc = jvId ? `Invoice ${invoiceId} + JV ${jvId}` : `Invoice ${invoiceId}`;
      console.log(
        `[MembershipSync] [${ref}] Creating Customer Payment (amount: ${transaction.Payment_Amount}, MID: ${transaction.MID || "N/A"}, apply → ${applyDesc})...`
      );
      const cpResponse = await withRetry(() => createCustomerPayment(cpData), `CP:${ref}`);
      if (!cpResponse || !cpResponse.id) {
        console.error(`[MembershipSync] [${ref}] CP response was null/empty:`, JSON.stringify(cpResponse));
        throw new Error(`Customer Payment creation returned no ID — response: ${JSON.stringify(cpResponse)}`);
      }
      const cpId = cpResponse.id;
      result.steps.customerPayment = { success: true, id: cpId };
      console.log(`[MembershipSync] [${ref}] Customer Payment created: ${cpId} (applied → ${applyDesc})`);
      logStep("customer-payment", true, { customerPaymentId: cpId, amount: transaction.Payment_Amount });

    } else {
      // ── Other Forms: SO + Customer Deposit + Invoice ────────────────────────

      // Step 4: Customer Deposit
      currentStep = "customer-deposit";
      const cdData = buildCustomerDepositData(soId, transaction, formConfig);
      console.log(
        `[MembershipSync] [${ref}] Creating Customer Deposit (amount: ${transaction.Payment_Amount}, MID: ${transaction.MID || "N/A"})...`
      );
      const cdResponse = await withRetry(() => createCustomerDeposit(cdData), `CD:${ref}`);
      if (!cdResponse || !cdResponse.id) {
        console.error(`[MembershipSync] [${ref}] CD response was null/empty:`, JSON.stringify(cdResponse));
        throw new Error(`Customer Deposit creation returned no ID — response: ${JSON.stringify(cdResponse)}`);
      }
      const cdId = cdResponse.id;
      result.steps.customerDeposit = { success: true, id: cdId };
      console.log(`[MembershipSync] [${ref}] Customer Deposit created: ${cdId}`);
      logStep("customer-deposit", true, { customerDepositId: cdId, amount: transaction.Payment_Amount });

      // Step 5: Invoice
      currentStep = "invoice";
      const invoiceBody = buildInvoiceBody(transaction, formConfig);
      console.log(`[MembershipSync] [${ref}] Creating Invoice from SO ${soId}...`);
      const invoiceResponse = await withRetry(
        () => createTransFormRecordInvoice(soId, invoiceBody),
        `Invoice:${ref}`
      );
      if (!invoiceResponse || !invoiceResponse.id) {
        console.error(`[MembershipSync] [${ref}] Invoice response was null/empty:`, JSON.stringify(invoiceResponse));
        throw new Error(`Invoice creation returned no ID — response: ${JSON.stringify(invoiceResponse)}`);
      }
      const invoiceId = invoiceResponse.id;
      result.steps.invoice = { success: true, id: invoiceId };
      console.log(`[MembershipSync] [${ref}] Invoice created: ${invoiceId}`);
      logStep("invoice", true, { invoiceId, salesOrderId: soId });
    }

    result.success = true;
    console.log(
      `[MembershipSync] [${ref}] Transaction processed successfully`
    );
  } catch (err) {
    result.success = false;
    result.error = err.response?.data ?? err.message;
    console.error(
      `[MembershipSync] [${ref}] Transaction FAILED: ${JSON.stringify(result.error)}`
    );

    // Log failure for the step that threw (JV logs its own failure — it's non-blocking)
    if (["sales-order", "customer-deposit", "invoice", "customer-payment"].includes(currentStep)) {
      logStep(currentStep, false, { error: err.response?.data ?? err.message });
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function runMembershipStudentSync({ integrationId } = {}) {
  if (syncMutex.isLocked()) {
    console.log(
      "[MembershipSync] Sync already running — request cancelled."
    );
    return {
      success: false,
      message: "Membership/Student sync already in progress. Try again later.",
    };
  }

  const release = await syncMutex.acquire();
  const startTime = Date.now();

  try {
    // ── 1. Initialize daily data directory ──────────────────────────────────
    const dailyDir = stateManager.getDailyDir();
    console.log(`[MembershipSync] Daily data directory: ${dailyDir}`);

    // ── 2. Authenticate ──────────────────────────────────────────────────────
    const tokenid = await authenticate();

    // ── 3. Fetch transactions ────────────────────────────────────────────────
    const allTransactions = await fetchTransactions(tokenid);
    console.log(
      `[MembershipSync] Total fetched from ICAI: ${allTransactions.length}`
    );

    // Save all raw transactions from ICAI before any filtering
    stateManager.writeFile(dailyDir, "transaction.json", allTransactions);
    console.log(`[MembershipSync] Saved ${allTransactions.length} raw transactions to transaction.json`);

    if (allTransactions.length === 0) {
      return {
        success: true,
        message: "No transactions fetched from ICAI",
        processed: 0,
      };
    }

    // ── 4. Filter for membership/student forms ───────────────────────────────
    const allowedForms = getAllAllowedForms();
    const matchingTransactions = allTransactions.filter((t) =>
      allowedForms.includes(t.Form_Description)
    );
    const rejectedTransactions = allTransactions.filter(
      (t) => !allowedForms.includes(t.Form_Description)
    );

    console.log(
      `[MembershipSync] Matching: ${matchingTransactions.length} | ` +
        `Rejected: ${rejectedTransactions.length}`
    );

    if (rejectedTransactions.length > 0) {
      const rejectedForms = [
        ...new Set(rejectedTransactions.map((t) => t.Form_Description)),
      ];
      console.log(
        `[MembershipSync] Rejected form types: ${rejectedForms.join(", ")}`
      );
    }

    if (matchingTransactions.length === 0) {
      return {
        success: true,
        message: "No matching membership/student transactions found",
        totalFetched: allTransactions.length,
        processed: 0,
      };
    }

    // ── 5. Pre-validate: check subsidiary config ─────────────────────────────
    const invalidTransactions = [];
    const validTransactions = [];

    for (const t of matchingTransactions) {
      const cfg = getConfigForForm(t.Form_Description);
      if (!cfg || !cfg.subsidiary_id) {
        invalidTransactions.push({
          reference: t.Reference_Number,
          form: t.Form_Description,
          reason: `Subsidiary ID not configured for ${cfg?.type || "unknown"}. Update membershipStudentConfig.json`,
        });
      } else {
        validTransactions.push(t);
      }
    }

    if (invalidTransactions.length > 0) {
      console.warn(
        `[MembershipSync] ${invalidTransactions.length} transactions skipped (missing subsidiary config):`
      );
      for (const inv of invalidTransactions) {
        console.warn(
          `  - ${inv.reference} (${inv.form}): ${inv.reason}`
        );
      }
    }

    if (validTransactions.length === 0) {
      return {
        success: true,
        message: "All matching transactions skipped due to missing config",
        totalFetched: allTransactions.length,
        totalMatching: matchingTransactions.length,
        skipped: invalidTransactions,
        processed: 0,
      };
    }

    // ── 6. Filter duplicates (by Reference_Number + Payment_Order_Id) ────────
    const { unique, duplicates } = stateManager.filterDuplicates(validTransactions);

    console.log(
      `[MembershipSync] Unique: ${unique.length} | Duplicates: ${duplicates.length}`
    );

    // Save incoming unique records and duplicates to daily directory
    stateManager.appendToFile(dailyDir, "incoming.json", unique);
    if (duplicates.length > 0) {
      stateManager.appendToFile(dailyDir, "duplicates.json", duplicates);
      console.log(
        `[MembershipSync] Duplicate references: ${duplicates.map((d) => d.Reference_Number).join(", ")}`
      );
    }

    // Mark as processed to prevent re-processing on next sync
    stateManager.markAsProcessed(unique);

    if (unique.length === 0) {
      return {
        success: true,
        message: "All valid transactions are duplicates — already processed",
        totalFetched: allTransactions.length,
        totalMatching: matchingTransactions.length,
        duplicatesSkipped: duplicates.length,
        processed: 0,
      };
    }

    // ── 7. Fetch customers from NetSuite (batched) ───────────────────────────
    const uniqueCustomerIds = [
      ...new Set(unique.map((t) => t.Customer_ID)),
    ];
    console.log(
      `[MembershipSync] Fetching ${uniqueCustomerIds.length} customers from NetSuite...`
    );

    const CUSTOMER_BATCH_SIZE = 50;
    const customers = [];
    for (let i = 0; i < uniqueCustomerIds.length; i += CUSTOMER_BATCH_SIZE) {
      const batch = uniqueCustomerIds.slice(i, i + CUSTOMER_BATCH_SIZE);
      console.log(
        `[MembershipSync] Customer batch ${Math.floor(i / CUSTOMER_BATCH_SIZE) + 1}/${Math.ceil(uniqueCustomerIds.length / CUSTOMER_BATCH_SIZE)} (${batch.length} IDs)...`
      );
      const batchResults = await fetchAllCustomers(batch);
      customers.push(...batchResults);
    }
    console.log(
      `[MembershipSync] Total customers fetched: ${customers.length}/${uniqueCustomerIds.length}`
    );
    const customerMap = {};
    for (const c of customers) {
      if (c.entityid) customerMap[c.entityid] = c.id;
    }
    console.log(
      `[MembershipSync] Found ${Object.keys(customerMap).length}/${uniqueCustomerIds.length} customers`
    );

    // ── 8. Process each transaction ──────────────────────────────────────────
    const limit = pLimit(CONCURRENCY_LIMIT);
    const allResults = [];

    const tasks = unique.map((transaction, index) =>
      limit(async () => {
        const formConfig = getConfigForForm(transaction.Form_Description);
        console.log(
          `\n[MembershipSync] ── [${index + 1}/${unique.length}] ${transaction.Reference_Number} (${transaction.Form_Description}) ──`
        );
        return processTransaction(transaction, customerMap, formConfig, dailyDir);
      })
    );

    const results = await Promise.all(tasks);
    allResults.push(...results);

    // ── 9. Save sync summary ─────────────────────────────────────────────────
    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;
    const durationMs = Date.now() - startTime;

    stateManager.writeFile(dailyDir, "sync-summary.json", {
      syncedAt: new Date().toISOString(),
      durationMs,
      totalFetched: allTransactions.length,
      totalMatching: matchingTransactions.length,
      totalValid: validTransactions.length,
      duplicatesSkipped: duplicates.length,
      configSkipped: invalidTransactions.length,
      totalProcessed: unique.length,
      successCount,
      failCount,
      results: allResults,
    });

    // ── 10. Console summary ──────────────────────────────────────────────────
    console.log(
      `\n[MembershipSync] ════════════════════════════════════════`
    );
    console.log(`[MembershipSync] SYNC COMPLETE`);
    console.log(
      `[MembershipSync]   Total Fetched    : ${allTransactions.length}`
    );
    console.log(
      `[MembershipSync]   Matching Forms   : ${matchingTransactions.length}`
    );
    console.log(
      `[MembershipSync]   Duplicates       : ${duplicates.length}`
    );
    console.log(
      `[MembershipSync]   Processed        : ${unique.length}`
    );
    console.log(
      `[MembershipSync]   Success          : ${successCount}`
    );
    console.log(
      `[MembershipSync]   Failed           : ${failCount}`
    );
    console.log(
      `[MembershipSync]   Config Skipped   : ${invalidTransactions.length}`
    );
    console.log(
      `[MembershipSync]   Duration         : ${durationMs}ms`
    );
    console.log(
      `[MembershipSync] ════════════════════════════════════════\n`
    );

    return {
      success: true,
      message: `Processed ${successCount} transactions successfully, ${failCount} failed`,
      totalFetched: allTransactions.length,
      totalMatching: matchingTransactions.length,
      processed: successCount,
      failed: failCount,
      duplicatesSkipped: duplicates.length,
      configSkipped: invalidTransactions.length,
      durationMs,
      dailyDir,
      details: allResults.map((r) => ({
        reference: r.reference,
        form: r.form,
        customerId: r.customerId,
        success: r.success,
        error: r.error || null,
        steps: r.steps || {},
      })),
    };
  } catch (err) {
    console.error("[MembershipSync] Fatal error:", err);
    throw err;
  } finally {
    release();
  }
}

module.exports = { runMembershipStudentSync };
