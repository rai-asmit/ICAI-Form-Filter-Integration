"use strict";

/**
 * syncSalesOrderAndDeposit.js — Production Ready
 *
 * Fixes applied:
 *  #1  Mutex prevents race condition / double-processing across concurrent requests
 *  #2  Concurrency reduced to 5 (NetSuite safe limit) + exponential backoff retry
 *  #3  Separate pLimit instances for SO and CD tasks
 *  #4  Memory-efficient: only minimal fields stored in result arrays
 *  #5  Removed unused `salesOrdersToCreate` array
 *  #6  Date parsing never uses `new Date()` — pure string split, no timezone shift
 *  #7  Batch processing (BATCH_SIZE = 500) — state written after every batch
 *  #8  Skipped-customer records go to failed state only once, not twice
 *  #9  console.log override replaced with a scoped logger (no global mutation)
 */

const path = require("path");
const fs = require("fs");
const pLimit = require("p-limit").default;
const { Mutex } = require("async-mutex"); // npm install async-mutex

const {
  fetchAllCustomers,
  createSalesOrder,
  createCustomerDeposit,
} = require("./netsuiteClient--Rest");

const {
  rootDirectory,
  AssetsFolderName,
  logsFolderName,
} = require("./commonFolderNames");

const { getDatedDataDir } = require("./transactionStateManager");

const internalIdDetails = require("./internal_id_details.json");

// ─── Item Lookup Map (O(1), built once at startup) ───────────────────────────
const itemLookupMap = {};

function flattenItems(obj) {
  for (const key in obj) {
    if (Array.isArray(obj[key])) {
      for (const itemDef of obj[key]) {
        if (itemDef.item) {
          const code = itemDef.item.split(" ")[0];
          itemLookupMap[code] = itemDef;
        }
      }
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      flattenItems(obj[key]);
    }
  }
}

if (internalIdDetails && internalIdDetails.records) {
  flattenItems(internalIdDetails.records);
}

// ─── State Manager ───────────────────────────────────────────────────────────
const {
  readState,
  writeState,
  appendToState,
  getRecordKey,
  getStateSummary,
} = require("./transactionStateManager");

// ─── Mutex — one run at a time (Fix #1) ──────────────────────────────────────
const syncMutex = new Mutex();

// ─── Constants ────────────────────────────────────────────────────────────────
const CONCURRENCY_LIMIT = 5; // Fix #2 — NetSuite safe concurrency
const BATCH_SIZE = 500; // Fix #7 — process in chunks
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000; // ms

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fix #6 — Safe date parser. Converts "DD/MM/YYYY" → "YYYY-MM-DD" string.
 * Never uses `new Date()` so timezone cannot shift the date by a day.
 */
function parseDateDDMMYYYY(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const parts = dateStr.split("/");
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function getMonthYear(dateString) {
  if (!dateString) return null;
  const parts = dateString.split("-");
  if (parts.length < 2) return null;
  const yyyy = parts[0];
  const mm = parseInt(parts[1], 10);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[mm - 1]} ${yyyy}`;
}

/**
 * Fix #2 — Exponential backoff retry wrapper.
 * Retries on 429 / 503 / 504 / network errors.
 */
async function withRetry(fn, label = "") {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable =
        status === 429 || status === 503 || status === 504 || !status;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY * Math.pow(2, attempt - 1); // 1s → 2s → 4s
        console.warn(
          `[Retry] ${label} attempt ${attempt}/${MAX_RETRIES} failed (HTTP ${status ?? "network"}). Retrying in ${delay}ms...`,
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function createLogger(tag) {
  return {
    info: (...args) => console.log(`[${tag}]`, ...args),
    warn: (...args) => console.warn(`[${tag}]`, ...args),
    error: (...args) => console.error(`[${tag}]`, ...args),
  };
}

function buildSOData(data, customerMap) {
  const internalId = customerMap[data.Customer_ID];
  if (!internalId) return null;

  // Fee head code → item lookup
  const feeHeadCode = data.Fee_Head?.[0]?.FeeHeadCode1 ?? null;
  const matchedItem = feeHeadCode ? itemLookupMap[feeHeadCode] : null;
  const itemInternalId = matchedItem
    ? String(matchedItem.item_internal_id)
    : "3019";

  const tranDateFormatted = parseDateDDMMYYYY(data.Payment_Date);

  const soData = {
    //customer
    entity: { id: internalId, type: "customer" },

    tranDate: tranDateFormatted,

    // return from period
    custbody_in_return_form_period: { refName: getMonthYear(tranDateFormatted) },

    //protal order id
    memo: data.Payment_Order_Id,
    //acknowledgement number
    custbody_inoday_payment_ref: data.Payment_Order_Id,
    //payment transcation number
    custbody_ino_icai_reference_number: data.Reference_Number,
    //utr number
    custbody_ino_icai_utr: data.Reference_Number,
    custbody_ino_icai_source_portal: "SSP",
    custbody_ino_icai_source_portal_url: "https://eservices.icai.org/",
    custbodycreate_middleware: true,
    custbody_process_invoice: true,

    subsidiary: { id: "171", type: "subsidiary" },
    location: { id: "286", type: "location" },
    department: { id: "227", type: "department" },

    orderStatus: { id: "B" },
    paymentAmount: parseFloat(data.Payment_Amount) || 0.0,

    item: {
      items: [
        {
          item: { id: itemInternalId },
          quantity: parseInt(data.Quantity) || 1,
          rate: parseFloat(data.Payment_Amount) || 0.0,
          amount: parseFloat(data.Payment_Amount) || 0.0,
          description:
            data.Fee_Head?.[0]?.FeeHead1 || data.Form_Description || "",

          // Tax — only include when non-empty
          // ...(data.Total_Tax && parseFloat(data.Total_Tax) > 0
          //   ? { taxAmount: parseFloat(data.Total_Tax) }
          //   : {}),

          // HSN code — 9995 always maps to internal id 1377 in NetSuite
          // custcol_in_hsn_code: { id: "1377" },

          // India Nature of Item — "Services" (id: 3)
          custcol_in_nature_of_item: { id: "3" },

          // Cost Centre & Events/Seminars — required at line level
          department: { id: "227" },
          ...(matchedItem?.events_seminars_internal_id
            ? { class: { id: String(matchedItem.events_seminars_internal_id) } }
            : {}),

          // Line-level dates
          ...(data.Start_Date
            ? {
              custcol_inoday_inv_startdate: parseDateDDMMYYYY(
                data.Start_Date,
              ),
            }
            : {}),
          ...(data.End_Date
            ? { custcol_inoday_inv_enddate: parseDateDDMMYYYY(data.End_Date) }
            : {}),

          // Exam type fields (from item lookup)
          ...(matchedItem?.event_seminar_type_internal_id
            ? {
              custcol_inoday_icai_type: {
                id: String(matchedItem.event_seminar_type_internal_id),
              },
            }
            : {}),
          ...(matchedItem?.event_seminar_sub_type_internal_id
            ? {
              custcol_ino_icia_duplicate_class: {
                id: String(matchedItem.event_seminar_sub_type_internal_id),
              },
            }
            : {}),
        },
      ],
    },
  };

  // Header-level seminar field
  if (matchedItem?.events_seminars_internal_id) {
    soData.events_seminars_internal_id = {
      id: String(matchedItem.events_seminars_internal_id),
    };
  }

  return soData;
}



// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Run Sales Order and Customer Deposit sync.
 * Protected by mutex — only one execution runs at a time.
 */
async function runSalesOrderAndDepositSync() {
  if (syncMutex.isLocked()) {
    console.log("⚠️ Sales Order sync already running — request cancelled.");
    return {
      success: false,
      message: "Sales Order sync already in progress. Try again later.",
    };
  }

  // Acquire lock for this run
  const release = await syncMutex.acquire();

  const runId = Date.now().toString(36).toUpperCase();
  const log = createLogger(`SO-SYNC:${runId}`);

  try {
    // ── STEP 1: Read incoming queue ──────────────────────────────────────────
    const incomingRecords = readState("incoming");

    if (!incomingRecords.length) {
      log.info("No transactions in incoming queue. Run ICAI sync first.");
      return {
        success: true,
        message: "No incoming transactions",
        processed: 0,
      };
    }

    log.info(`Found ${incomingRecords.length} transactions in incoming queue`);

    // De-duplicate (same Reference_Number + Payment_Order_Id)
    const seenKeys = new Set();
    const uniqueTransactions = [];
    for (const tx of incomingRecords) {
      const k = getRecordKey(tx);
      if (!seenKeys.has(k)) {
        seenKeys.add(k);
        uniqueTransactions.push(tx);
      }
    }

    log.info(`Unique transactions after de-dup: ${uniqueTransactions.length}`);

    // ── STEP 2: Fetch customers once for the entire run ──────────────────────
    const uniqueCustomerIds = [
      ...new Set(uniqueTransactions.map((d) => d.Customer_ID)),
    ];
    const customers = await fetchAllCustomers(uniqueCustomerIds);

    const customerMap = {};
    for (const c of customers) {
      if (c.entityid) customerMap[c.entityid] = c.id;
    }

    // ── STEP 3: Split into batches (Fix #7) ──────────────────────────────────
    const batches = [];
    for (let i = 0; i < uniqueTransactions.length; i += BATCH_SIZE) {
      batches.push(uniqueTransactions.slice(i, i + BATCH_SIZE));
    }

    log.info(
      `Processing ${uniqueTransactions.length} records in ${batches.length} batch(es) of up to ${BATCH_SIZE}`,
    );

    // Accumulators across all batches (for final summary + logs)
    const allSOResultsForLog = [];
    const allCDResultsForLog = [];
    let totalSuccess = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalCDSuccess = 0;
    let totalCDFailed = 0;

    // ── STEP 4: Process each batch ───────────────────────────────────────────
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      log.info(
        `--- Batch ${batchIndex + 1}/${batches.length} (${batch.length} records) ---`,
      );

      // Fix #3 — separate limiters per batch, per stage
      const soLimit = pLimit(CONCURRENCY_LIMIT);
      const cdLimit = pLimit(CONCURRENCY_LIMIT);

      const recordToSOMap = []; // { originalRecord, soData, paymentAmount, memo }
      const batchSkipped = [];

      // Build SO payloads for this batch
      for (const data of batch) {
        const soData = buildSOData(data, customerMap);
        if (!soData) {
          log.warn(`Customer_ID ${data.Customer_ID} not found — skipping`);
          batchSkipped.push(data);
          continue;
        }
        recordToSOMap.push({
          originalRecord: data,
          soData,
          // Fix #4 — store only what CD needs, not the full soData object
          paymentAmount: soData.paymentAmount,
          memo: soData.memo,
          soTranDate: soData.tranDate, // CD uses same date as SO (Feedback #1)
        });
      }

      // Fix #8 — write skipped to failed state exactly once here, not again later
      if (batchSkipped.length > 0) {
        const enriched = batchSkipped.map((r) => ({
          ...r,
          _failedStage: "sales_order",
          _error: { reason: "Customer not found in NetSuite" },
          _failedAt: new Date().toISOString(),
        }));
        appendToState("sales_order_failed", enriched);
        totalSkipped += batchSkipped.length;
      }

      // ── 4a: Create Sales Orders ────────────────────────────────────────────
      // Fix #4 — soResults holds only minimal fields, not full soData
      const soResults = []; // { success, soId, soTranId, paymentAmount, memo, originalRecord, error }

      const soTasks = recordToSOMap.map(
        ({ originalRecord, soData, paymentAmount, memo, soTranDate }, idx) =>
          soLimit(async () => {
            try {
              log.info(
                `[SO ${idx + 1}/${recordToSOMap.length}] Creating for customer ${soData.entity.id}`,
              );
              const response = await withRetry(
                () => createSalesOrder(soData),
                `SO:${originalRecord.Reference_Number}`,
              );
              soResults.push({
                success: true,
                soId: response.id,
                soTranId: response.tranid,
                paymentAmount,
                memo,
                soTranDate,
                originalRecord,
              });
              log.info(`[SO ${idx + 1}] ✅ Created — id: ${response.id}`);
            } catch (err) {
              const errMsg = err.response?.data ?? err.message;
              log.error(
                `[SO ${idx + 1}] ❌ Failed for ${soData.entity.id}:`,
                errMsg,
              );
              soResults.push({
                success: false,
                originalRecord,
                error: errMsg,
              });
            }
          }),
      );

      await Promise.all(soTasks);

      // ── 4b: Create Customer Deposits for successful SOs ────────────────────
      const cdResults = []; // { success, soId, originalRecord, error }
      const soSuccesses = soResults.filter((r) => r.success);

      const cdTasks = soSuccesses.map((soResult, idx) =>
        cdLimit(async () => {
          try {
            log.info(
              `[CD ${idx + 1}/${soSuccesses.length}] Creating for SO ${soResult.soId}`
            );
            const feeHeadCode = soResult.originalRecord?.Fee_Head?.[0]?.FeeHeadCode1 ?? null;
            const matchedItem = feeHeadCode ? itemLookupMap[feeHeadCode] : null;

            const cdData = {
              salesorder: { id: soResult.soId },
              // account: { id: "3227" },
              account: { id: "3341" },
                // account: { id: "626" },
              payment: soResult.paymentAmount,
              memo: soResult.originalRecord.Payment_Order_Id,                      // #6 — GL Impact memo = Payment Order Id
              tranDate: soResult.soTranDate,                                       // #1 — same date as Sales Order
              // return from period
              custbody_in_return_form_period: { refName: getMonthYear(soResult.soTranDate) },
              custbody_inoday_payment_ref: soResult.originalRecord.Payment_Order_Id,           // acknowledgement number (matches SO mapping)
              custbody_ino_icai_reference_number: soResult.originalRecord.Reference_Number,  // payment transaction number (matches SO mapping)
              custbodypayment_reference_number: soResult.originalRecord.Reference_Number,    // Payment referance number
              custbody_ino_icai_utr: soResult.originalRecord.Reference_Number,               // UTR number (was missing)
              custbody_ino_icai_source_portal: "SSP",
              custbody_ino_icai_source_portal_url: "https://eservices.icai.org/",  // match SO
              department: { id: "227" },                                           // #4 — cost centre
              location: { id: "286" },                                             // #4 — warehouse
              ...(matchedItem?.events_seminars_internal_id                          // #4 — events/seminars classification
                ? {
                  class: {
                    id: String(matchedItem.events_seminars_internal_id),
                  },
                }
                : {}),
              // Event/Seminar type
              ...(matchedItem?.event_seminar_type_internal_id
                ? {
                  custcol_inoday_icai_type: {
                    id: String(matchedItem.event_seminar_type_internal_id),
                  },
                }
                : {}),
              // Event/Seminar sub type
              ...(matchedItem?.event_seminar_sub_type_internal_id
                ? {
                  custcol_ino_icia_duplicate_class: {
                    id: String(matchedItem.event_seminar_sub_type_internal_id),
                  },
                }
                : {}),
            };
            const response = await withRetry(
              () => createCustomerDeposit(cdData),
              `CD:${soResult.soId}`,
            );
            cdResults.push({
              success: true,
              soId: soResult.soId,
              originalRecord: soResult.originalRecord,
              cdId: response.id,
            });
            log.info(`[CD ${idx + 1}] ✅ Created — id: ${response.id}`);
          } catch (err) {
            const errMsg = err.response?.data ?? err.message;
            log.error(
              `[CD ${idx + 1}] ❌ Failed for SO ${soResult.soId}:`,
              errMsg,
            );
            cdResults.push({
              success: false,
              soId: soResult.soId,
              originalRecord: soResult.originalRecord,
              error: errMsg,
            });
          }
        }),
      );

      await Promise.all(cdTasks);

      // ── 4c: Classify results for this batch ───────────────────────────
      const batchSOSuccess = [];
      const batchSOFailed = [];
      const batchCDSuccess = [];
      const batchCDFailed = [];
      const now = new Date().toISOString();

      // SO failures
      for (const r of soResults.filter((r) => !r.success)) {
        batchSOFailed.push({
          ...r.originalRecord,
          _failedStage: "sales_order",
          _error: r.error,
          _failedAt: now,
        });
      }

      // CD successes & failures
      const cdSuccessIds = new Set(
        cdResults.filter((r) => r.success).map((r) => r.soId),
      );
      for (const r of cdResults.filter((r) => r.success)) {
        batchCDSuccess.push({
          ...r.originalRecord,
          _state: "CUSTOMER_DEPOSIT_DONE",
          _soId: r.soId,
          _cdId: r.cdId,
          _processedAt: now,
        });
      }
      for (const r of cdResults.filter((r) => !r.success)) {
        batchCDFailed.push({
          ...r.originalRecord,
          _failedStage: "customer_deposit",
          _soId: r.soId,
          _error: r.error,
          _failedAt: now,
        });
      }

      // SO successes (SO created, regardless of CD outcome)
      for (const so of soResults.filter((r) => r.success)) {
        batchSOSuccess.push({
          ...so.originalRecord,
          _state: "SALES_ORDER_DONE",
          _soId: so.soId,
          _soTranId: so.soTranId,
          _processedAt: now,
        });
      }

      // ── 4d: Update state files after each batch (Fix #7) ──────────────
      // Remove this batch's processed records from incoming atomically
      const processedKeys = new Set([
        ...batchSOSuccess.map(getRecordKey),
        ...batchSOFailed.map(getRecordKey),
        ...batchSkipped.map(getRecordKey),
      ]);

      const currentIncoming = readState("incoming");
      const remainingIncoming = currentIncoming.filter(
        (r) => !processedKeys.has(getRecordKey(r)),
      );
      writeState("incoming", remainingIncoming);

      if (batchSOSuccess.length > 0)
        appendToState("sales_order_done", batchSOSuccess);
      if (batchSOFailed.length > 0)
        appendToState("sales_order_failed", batchSOFailed);
      if (batchCDSuccess.length > 0)
        appendToState("customer_deposit_done", batchCDSuccess);
      if (batchCDFailed.length > 0)
        appendToState("customer_deposit_failed", batchCDFailed);

      totalSuccess += batchSOSuccess.length;
      totalFailed += batchSOFailed.length;
      totalCDSuccess += batchCDSuccess.length;
      totalCDFailed += batchCDFailed.length;

      log.info(
        `Batch ${batchIndex + 1} complete — SO ✅ ${batchSOSuccess.length} success ❌ ${batchSOFailed.length} failed | CD ✅ ${batchCDSuccess.length} success ❌ ${batchCDFailed.length} failed | ⏭ ${batchSkipped.length} skipped`,
      );

      // Collect for log files (Fix #4 — push minimal data only)
      for (const r of soResults)
        allSOResultsForLog.push({ ...r, originalRecord: undefined });
      for (const r of cdResults)
        allCDResultsForLog.push({ ...r, originalRecord: undefined });
    } // end batch loop

    // ── STEP 5: Write log files ───────────────────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    // Logs are day-partitioned: assets/logs/YYYY/MM/DD/
    const { getDateFolder } = require("./transactionStateManager");
    const logDir = path.join(rootDirectory, AssetsFolderName, logsFolderName, getDateFolder());
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    const soLogFile = path.join(
      logDir,
      `salesOrderResponses-${timestamp}.json`,
    );
    const cdLogFile = path.join(
      logDir,
      `customerDepositResponses-${timestamp}.json`,
    );

    fs.writeFileSync(soLogFile, JSON.stringify(allSOResultsForLog, null, 2));
    fs.writeFileSync(cdLogFile, JSON.stringify(allCDResultsForLog, null, 2));

    // ── STEP 6: Final summary ─────────────────────────────────────────────────
    const stateSummary = getStateSummary();

    log.info(`
📊 Run Summary [${runId}]:
    Processed      : ${uniqueTransactions.length}
    SO ✅ Success  : ${totalSuccess}
    SO ❌ Failed   : ${totalFailed}
    CD ✅ Success  : ${totalCDSuccess}
    CD ❌ Failed   : ${totalCDFailed}
    ⏭  Skipped    : ${totalSkipped}

📊 State Totals (today):
    Incoming               : ${stateSummary.incoming}
    Sales Order Done       : ${stateSummary.sales_order_done}
    Sales Order Failed     : ${stateSummary.sales_order_failed}
    Customer Deposit Done  : ${stateSummary.customer_deposit_done}
    Customer Deposit Failed: ${stateSummary.customer_deposit_failed}
    Invoice Done           : ${stateSummary.invoice_done}
    Invoice Failed         : ${stateSummary.invoice_failed}

📁 SO Log : ${soLogFile}
📁 CD Log : ${cdLogFile}`);

    return {
      success: true,
      message: `Processed ${totalSuccess} SO and ${totalCDSuccess} CD records successfully`,
      summary: {
        processed: uniqueTransactions.length,
        soSuccessful: totalSuccess,
        soFailed: totalFailed,
        cdSuccessful: totalCDSuccess,
        cdFailed: totalCDFailed,
        skipped: totalSkipped,
      },
    };
  } catch (err) {
    log.error("Fatal error in runSalesOrderAndDepositSync:", err);
    throw err;
  } finally {
    release(); // Fix #1 — always release mutex
  }
}

module.exports = { runSalesOrderAndDepositSync };
