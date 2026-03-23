"use strict";

/**
 * syncExamEnrollment.js — Orchestrator for Exam Enrollment & Other Forms
 *
 * Handles ALL forms that are NOT handled by syncMembershipStudent.js:
 *   - NOT: Form 2, Form 6, Form 3/Fellowship, Student Registration Form
 *   - YES: Exam Enrollment (Final, Intermediate, Foundation, Corrections), etc.
 *
 * Simple flow per transaction:
 *   1. Create Sales Order
 *   2. Create Customer Deposit (linked to SO)
 *   3. Transform SO → Invoice
 *
 * Daily directory: data/YYYY/MM/DD/
 *   transaction.json, incoming.json, duplicates.json,
 *   sales-order-success.json, sales-order-failure.json,
 *   customer-deposit-success.json, customer-deposit-failure.json,
 *   invoice-success.json, invoice-failure.json,
 *   exam-sync-summary.json
 */

require("dotenv").config();
const pLimit = require("p-limit").default;
const { Mutex } = require("async-mutex");

const {
  fetchAllCustomers,
  createSalesOrder,
  createCustomerDeposit,
  createTransFormRecordInvoice,
} = require("./netsuiteClient--Rest");

const { authenticate, fetchTransactions } = require("./membership/icaiClient");
const { getAllAllowedForms, withRetry } = require("./membership/helpers");
const stateManager = require("./membership/stateManager");
const {
  buildExamSalesOrderData,
  buildExamCustomerDepositData,
  buildExamInvoiceBody,
  getMatchedItem,
  parseDateDDMMYYYY,
} = require("./examination/builders");

// ── Constants ────────────────────────────────────────────────────────────────
const CONCURRENCY_LIMIT = 3;
const syncMutex = new Mutex();

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE TRANSACTION PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process one exam transaction:
 *   1. Resolve customer
 *   2. Create Sales Order
 *   3. Create Customer Deposit (linked to SO)
 *   4. Transform SO → Invoice
 */
async function processTransaction(transaction, customerMap, dailyDir) {
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
    // ── Step 1: Resolve customer ──────────────────────────────────────────
    const customerInternalId = customerMap[transaction.Customer_ID];
    if (!customerInternalId) {
      throw new Error(
        `Customer ${transaction.Customer_ID} not found in NetSuite`
      );
    }

    result.steps.customer = {
      entityId: transaction.Customer_ID,
      internalId: customerInternalId,
    };

    // ── Step 2: Create Sales Order ────────────────────────────────────────
    currentStep = "sales-order";
    const soData = buildExamSalesOrderData(transaction, customerInternalId);

    console.log(`[ExamSync] [${ref}] Creating Sales Order...`);
    const soResponse = await withRetry(
      () => createSalesOrder(soData),
      `SO:${ref}`
    );
    if (!soResponse || !soResponse.id) {
      console.error(
        `[ExamSync] [${ref}] SO response was null/empty:`,
        JSON.stringify(soResponse)
      );
      throw new Error(
        `Sales Order creation returned no ID — response: ${JSON.stringify(soResponse)}`
      );
    }

    const soId = soResponse.id;
    const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);
    result.steps.salesOrder = {
      success: true,
      id: soId,
      tranId: soResponse.tranid || null,
    };
    console.log(`[ExamSync] [${ref}] SO created: ${soId}`);
    logStep("sales-order", true, {
      salesOrderId: soId,
      tranId: soResponse.tranid || null,
    });

    // ── Step 3: Create Customer Deposit ───────────────────────────────────
    currentStep = "customer-deposit";
    const feeHeadCode = transaction.Fee_Head?.[0]?.FeeHeadCode1 ?? null;
    const matchedItem = getMatchedItem(feeHeadCode);
    const cdData = buildExamCustomerDepositData(
      soId,
      transaction,
      tranDate,
      matchedItem
    );

    console.log(
      `[ExamSync] [${ref}] Creating Customer Deposit (amount: ${transaction.Payment_Amount})...`
    );
    const cdResponse = await withRetry(
      () => createCustomerDeposit(cdData),
      `CD:${ref}`
    );
    if (!cdResponse || !cdResponse.id) {
      console.error(
        `[ExamSync] [${ref}] CD response was null/empty:`,
        JSON.stringify(cdResponse)
      );
      throw new Error(
        `Customer Deposit creation returned no ID — response: ${JSON.stringify(cdResponse)}`
      );
    }

    const cdId = cdResponse.id;
    result.steps.customerDeposit = { success: true, id: cdId };
    console.log(`[ExamSync] [${ref}] Customer Deposit created: ${cdId}`);
    logStep("customer-deposit", true, {
      customerDepositId: cdId,
      salesOrderId: soId,
      amount: transaction.Payment_Amount,
    });

    // ── Step 4: Transform SO → Invoice ────────────────────────────────────
    currentStep = "invoice";
    const invoiceBody = buildExamInvoiceBody(transaction);

    console.log(
      `[ExamSync] [${ref}] Creating Invoice from SO ${soId}...`
    );
    const invoiceResponse = await withRetry(
      () => createTransFormRecordInvoice(soId, invoiceBody),
      `Invoice:${ref}`
    );
    if (!invoiceResponse || !invoiceResponse.id) {
      console.error(
        `[ExamSync] [${ref}] Invoice response was null/empty:`,
        JSON.stringify(invoiceResponse)
      );
      throw new Error(
        `Invoice creation returned no ID — response: ${JSON.stringify(invoiceResponse)}`
      );
    }

    const invoiceId = invoiceResponse.id;
    result.steps.invoice = { success: true, id: invoiceId };
    console.log(`[ExamSync] [${ref}] Invoice created: ${invoiceId}`);
    logStep("invoice", true, { invoiceId, salesOrderId: soId });

    result.success = true;
    console.log(
      `[ExamSync] [${ref}] Transaction processed successfully`
    );
  } catch (err) {
    result.success = false;
    result.error = err.response?.data ?? err.message;
    console.error(
      `[ExamSync] [${ref}] Transaction FAILED at ${currentStep}: ${JSON.stringify(result.error)}`
    );

    if (["sales-order", "customer-deposit", "invoice"].includes(currentStep)) {
      logStep(currentStep, false, {
        error: err.response?.data ?? err.message,
      });
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

async function runExamEnrollmentSync({ integrationId } = {}) {
  if (syncMutex.isLocked()) {
    console.log("[ExamSync] Sync already running — request cancelled.");
    return {
      success: false,
      message: "Exam Enrollment sync already in progress. Try again later.",
    };
  }

  const release = await syncMutex.acquire();
  const startTime = Date.now();

  try {
    // ── 1. Initialize daily data directory ────────────────────────────────
    const dailyDir = stateManager.getDailyDir();
    console.log(`[ExamSync] Daily data directory: ${dailyDir}`);

    // ── 2. Authenticate ───────────────────────────────────────────────────
    const tokenid = await authenticate();

    // ── 3. Fetch transactions ─────────────────────────────────────────────
    const allTransactions = await fetchTransactions(tokenid);
    console.log(
      `[ExamSync] Total fetched from ICAI: ${allTransactions.length}`
    );

    // Save all raw transactions
    stateManager.writeFile(dailyDir, "transaction.json", allTransactions);

    if (allTransactions.length === 0) {
      return {
        success: true,
        message: "No transactions fetched from ICAI",
        processed: 0,
      };
    }

    // ── 4. Filter: keep ONLY forms NOT handled by membership/student ──────
    const membershipStudentForms = getAllAllowedForms();
    const examTransactions = allTransactions.filter(
      (t) => !membershipStudentForms.includes(t.Form_Description)
    );
    const skippedTransactions = allTransactions.filter((t) =>
      membershipStudentForms.includes(t.Form_Description)
    );

    console.log(
      `[ExamSync] Exam/Other: ${examTransactions.length} | Skipped (membership/student): ${skippedTransactions.length}`
    );

    if (skippedTransactions.length > 0) {
      const skippedForms = [
        ...new Set(skippedTransactions.map((t) => t.Form_Description)),
      ];
      console.log(
        `[ExamSync] Skipped form types: ${skippedForms.join(", ")}`
      );
    }

    if (examTransactions.length === 0) {
      return {
        success: true,
        message: "No exam/other form transactions found",
        totalFetched: allTransactions.length,
        processed: 0,
      };
    }

    // ── 5. Filter duplicates (Reference_Number + Payment_Order_Id) ────────
    const { unique, duplicates } =
      stateManager.filterDuplicates(examTransactions);

    console.log(
      `[ExamSync] Unique: ${unique.length} | Duplicates: ${duplicates.length}`
    );

    stateManager.appendToFile(dailyDir, "incoming.json", unique);
    if (duplicates.length > 0) {
      stateManager.appendToFile(dailyDir, "duplicates.json", duplicates);
      console.log(
        `[ExamSync] Duplicate references: ${duplicates.map((d) => d.Reference_Number).join(", ")}`
      );
    }

    stateManager.markAsProcessed(unique);

    if (unique.length === 0) {
      return {
        success: true,
        message: "All exam transactions are duplicates — already processed",
        totalFetched: allTransactions.length,
        duplicatesSkipped: duplicates.length,
        processed: 0,
      };
    }

    // ── 6. Fetch customers from NetSuite (batched) ────────────────────────
    const uniqueCustomerIds = [
      ...new Set(unique.map((t) => t.Customer_ID)),
    ];
    console.log(
      `[ExamSync] Fetching ${uniqueCustomerIds.length} customers from NetSuite...`
    );

    const CUSTOMER_BATCH_SIZE = 50;
    const customers = [];
    for (let i = 0; i < uniqueCustomerIds.length; i += CUSTOMER_BATCH_SIZE) {
      const batch = uniqueCustomerIds.slice(i, i + CUSTOMER_BATCH_SIZE);
      console.log(
        `[ExamSync] Customer batch ${Math.floor(i / CUSTOMER_BATCH_SIZE) + 1}/${Math.ceil(uniqueCustomerIds.length / CUSTOMER_BATCH_SIZE)} (${batch.length} IDs)...`
      );
      const batchResults = await fetchAllCustomers(batch);
      customers.push(...batchResults);
    }

    const customerMap = {};
    for (const c of customers) {
      if (c.entityid) customerMap[c.entityid] = c.id;
    }
    console.log(
      `[ExamSync] Found ${Object.keys(customerMap).length}/${uniqueCustomerIds.length} customers`
    );

    // ── 7. Process each transaction ───────────────────────────────────────
    const limit = pLimit(CONCURRENCY_LIMIT);
    const allResults = [];

    const tasks = unique.map((transaction, index) =>
      limit(async () => {
        console.log(
          `\n[ExamSync] -- [${index + 1}/${unique.length}] ${transaction.Reference_Number} (${transaction.Form_Description}) --`
        );
        return processTransaction(transaction, customerMap, dailyDir);
      })
    );

    const results = await Promise.all(tasks);
    allResults.push(...results);

    // ── 8. Save sync summary ──────────────────────────────────────────────
    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;
    const durationMs = Date.now() - startTime;

    stateManager.writeFile(dailyDir, "exam-sync-summary.json", {
      syncType: "exam-enrollment",
      syncedAt: new Date().toISOString(),
      durationMs,
      totalFetched: allTransactions.length,
      examMatching: examTransactions.length,
      duplicatesSkipped: duplicates.length,
      totalProcessed: unique.length,
      successCount,
      failCount,
      results: allResults,
    });

    // ── 9. Console summary ────────────────────────────────────────────────
    console.log(`\n[ExamSync] ════════════════════════════════════════`);
    console.log(`[ExamSync] SYNC COMPLETE`);
    console.log(
      `[ExamSync]   Total Fetched    : ${allTransactions.length}`
    );
    console.log(
      `[ExamSync]   Exam/Other Forms : ${examTransactions.length}`
    );
    console.log(
      `[ExamSync]   Duplicates       : ${duplicates.length}`
    );
    console.log(
      `[ExamSync]   Processed        : ${unique.length}`
    );
    console.log(
      `[ExamSync]   Success          : ${successCount}`
    );
    console.log(
      `[ExamSync]   Failed           : ${failCount}`
    );
    console.log(
      `[ExamSync]   Duration         : ${durationMs}ms`
    );
    console.log(`[ExamSync] ════════════════════════════════════════\n`);

    return {
      success: true,
      message: `Processed ${successCount} transactions successfully, ${failCount} failed`,
      totalFetched: allTransactions.length,
      examMatching: examTransactions.length,
      processed: successCount,
      failed: failCount,
      duplicatesSkipped: duplicates.length,
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
    console.error("[ExamSync] Fatal error:", err);
    throw err;
  } finally {
    release();
  }
}

module.exports = { runExamEnrollmentSync };
