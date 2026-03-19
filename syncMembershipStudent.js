"use strict";

/**
 * syncMembershipStudent.js — Orchestrator
 *
 * Handles processing for:
 *   - Form 2   (New Membership)        → Duplicate Customer + SO + CD + Invoice + JV + DepositApp
 *   - Form 6   (COP Application)       → SO + CD + Invoice + JV (if contributions) + DepositApp
 *   - Form 3/Fellowship                → SO + CD + Invoice + JV (if contributions) + DepositApp
 *   - Student Registration Form        → SO + CD + Invoice + DepositApp (no JV — no contributions)
 *
 * Fee head classification:
 *   - Regular + Discount items (M05, M06, M07, M08, M09, M10, M99) → Sales Order & Invoice
 *   - Contribution items (M15, M18, M23, M22, M13) → Journal Voucher (Debit 2724, Credit 2764)
 *   - Customer Deposit captures FULL payment amount (all items + tax)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit").default;
const { Mutex } = require("async-mutex");

const {
  netsuiteRequest,
  fetchAllCustomers,
  createSalesOrder,
  createCustomerDeposit,
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
  buildInvoiceBody,
  buildJournalEntryData,
} = require("./membership/builders");
const { duplicateCustomerAsMember } = require("./membership/customerDuplicate");

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
 *   4. Create Customer Deposit (full Payment_Amount)
 *   5. Transform SO → Invoice
 *   6. Create Journal Voucher (contribution items only, if any)
 *   7. Apply Deposit to Invoice (Deposit Application)
 */
async function processTransaction(transaction, customerMap, formConfig) {
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

    // ── Step 4: Create Customer Deposit (full payment amount) ─────────────────
    const cdData = buildCustomerDepositData(soId, transaction, formConfig);
    const resolvedCdAccount = cdData.account?.id || "unknown";
    console.log(
      `[MembershipSync] [${ref}] Creating Customer Deposit (amount: ${transaction.Payment_Amount}, MID: ${transaction.MID || "N/A"}, account: ${resolvedCdAccount})...`
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
    console.log(`[MembershipSync] [${ref}] CD created: ${cdId}`);

    // ── Step 5: Transform SO → Invoice ───────────────────────────────────────
    const invoiceBody = buildInvoiceBody(transaction, formConfig);
    console.log(
      `[MembershipSync] [${ref}] Creating Invoice from SO ${soId}...`
    );
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

    // ── Step 6: Create JV for contributions (if any) ─────────────────────────
    if (contributionItems.length > 0) {
      try {
        const vendorMap = msConfig.contribution_vendor_mapping || {};

        const jvData = buildJournalEntryData(
          transaction,
          contributionItems,
          formConfig,
          customerInternalId,
          vendorMap
        );
        if (jvData) {
          console.log(
            `[MembershipSync] [${ref}] Creating JV for ${contributionItems.length} contribution item(s)...`
          );
          const jvResponse = await withRetry(
            () => createJournalEntry(jvData),
            `JV:${ref}`
          );
          result.steps.journalVoucher = { success: true, id: jvResponse.id };
          console.log(`[MembershipSync] [${ref}] JV created: ${jvResponse.id}`);
        }
      } catch (err) {
        console.error(
          `[MembershipSync] [${ref}] JV creation failed (non-blocking): ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`
        );
        result.steps.journalVoucher = {
          success: false,
          error: err.response?.data ?? err.message,
        };
      }
    }

    // ── Step 7: Deposit Application ──────────────────────────────────────────
    console.log(
      `[MembershipSync] [${ref}] Deposit auto-applied by NetSuite (CD ${cdId} → Invoice ${invoiceId})`
    );
    result.steps.depositApplication = {
      success: true,
      id: null,
      skipped: true,
      reason: "NetSuite auto-applies deposit when invoice is created from the same SO",
    };

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
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS LOGGER
// ═══════════════════════════════════════════════════════════════════════════════

function saveResults(results) {
  const now = new Date();
  const dateDir = path.join(
    __dirname,
    "data",
    "membership",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );

  if (!fs.existsSync(dateDir)) {
    fs.mkdirSync(dateDir, { recursive: true });
  }

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dateDir, `sync-results-${timestamp}.json`);

  fs.writeFileSync(filePath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`[MembershipSync] Results saved: ${filePath}`);
  return filePath;
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
    // ── 1. Authenticate ──────────────────────────────────────────────────────
    const tokenid = await authenticate();

    // ── 2. Fetch transactions ────────────────────────────────────────────────
    const allTransactions = await fetchTransactions(tokenid);
    console.log(
      `[MembershipSync] Total fetched from ICAI: ${allTransactions.length}`
    );

    if (allTransactions.length === 0) {
      return {
        success: true,
        message: "No transactions fetched from ICAI",
        processed: 0,
      };
    }

    // ── 3. Filter for membership/student forms ───────────────────────────────
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

    // ── 4. Pre-validate: check subsidiary config ─────────────────────────────
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

    // ── 5. Fetch customers from NetSuite (batched) ───────────────────────────
    const uniqueCustomerIds = [
      ...new Set(validTransactions.map((t) => t.Customer_ID)),
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

    // ── 6. Process each transaction ──────────────────────────────────────────
    const limit = pLimit(CONCURRENCY_LIMIT);
    const allResults = [];

    const tasks = validTransactions.map((transaction, index) =>
      limit(async () => {
        const formConfig = getConfigForForm(transaction.Form_Description);
        console.log(
          `\n[MembershipSync] ── [${index + 1}/${validTransactions.length}] ${transaction.Reference_Number} (${transaction.Form_Description}) ──`
        );
        return processTransaction(transaction, customerMap, formConfig);
      })
    );

    const results = await Promise.all(tasks);
    allResults.push(...results);

    // ── 7. Save results ──────────────────────────────────────────────────────
    const resultsFile = saveResults({
      syncedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      totalFetched: allTransactions.length,
      totalMatching: matchingTransactions.length,
      totalProcessed: validTransactions.length,
      skipped: invalidTransactions,
      results: allResults,
    });

    // ── 8. Summary ───────────────────────────────────────────────────────────
    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;
    const durationMs = Date.now() - startTime;

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
      `[MembershipSync]   Processed        : ${validTransactions.length}`
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
      configSkipped: invalidTransactions.length,
      durationMs,
      resultsFile,
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
