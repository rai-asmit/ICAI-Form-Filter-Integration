"use strict";

const pLimit = require("p-limit").default;
const { Mutex } = require("async-mutex");

const {
  netsuiteRequest,
  createTransFormRecordInvoice,
} = require("./netsuiteClient--Rest");

const internalIdDetails = require("./internal_id_details.json");

// ─── Item Lookup Map (same as syncInvoice.js) ─────────────────────────────────
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

// ─── Mutex — one run at a time ────────────────────────────────────────────────
const invoiceCronMutex = new Mutex();

// ─── Constants ────────────────────────────────────────────────────────────────
const CONCURRENCY_LIMIT = 50;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000; // ms

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute "last day of the month" from a date string.
 * Input:  "YYYY-MM-DD" (from SuiteQL trandate) or "DD/MM/YYYY"
 * Output: "YYYY-MM-DD" — last day of that month.
 */
function getLastDayOfMonth(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;

  let year, month;

  if (dateStr.includes("/")) {
    // DD/MM/YYYY format
    const parts = dateStr.split("/");
    if (parts.length !== 3) return null;
    year = parseInt(parts[2], 10);
    month = parseInt(parts[1], 10);
  } else {
    // YYYY-MM-DD or similar format (from SuiteQL)
    const parts = dateStr.split("-");
    if (parts.length < 2) return null;
    year = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
  }

  if (isNaN(year) || isNaN(month)) return null;

  // Day 0 of the *next* month = last day of *this* month
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────
async function withRetry(fn, label = "") {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || status === 503 || status === 504 || !status;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY * Math.pow(2, attempt - 1);
        console.warn(`[Retry] ${label} attempt ${attempt}/${MAX_RETRIES} failed (HTTP ${status ?? "network"}). Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Fetch Sales Orders whose customer deposit end_date is today or before today,
 * and whose source portal is NOT 'SSP'.
 */
async function fetchEligibleSalesOrdersForCron() {
  console.log("🔍 [Invoice Cron] Fetching eligible Sales Orders from NetSuite...");
  console.log("   Filter: end_date <= today AND source != SSP");

  const allItems = [];
  const pageSize = 1000;
  let offset = 0;
  let hasMore = true;
  const MAX_OFFSET = 50000;

  // Build today's date string (YYYY-MM-DD) without timezone shift
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  console.log(`   📅 Today's date: ${todayStr}`);

  while (hasMore && offset < MAX_OFFSET) {
    const query = `SELECT
  t.id,
  t.tranid,
  t.trandate,
  t.createddate,
  t.status,
  t.subsidiary,
  t.location,
  t.memo,
  t.custbody_ino_icai_reference_number AS portal_order_id,
  t.custbody_inoday_payment_ref AS payment_ref,
  MAX(tl.custcol_inoday_inv_enddate) AS end_date
FROM transaction t
  LEFT JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'F'
WHERE t.type = 'SalesOrd'
  AND t.subsidiary = 171
  AND t.status = 'F'
  AND t.custbodycreate_middleware = 'T'
  AND (t.custbody_ino_icai_source_portal != 'SSP' OR t.custbody_ino_icai_source_portal IS NULL)
GROUP BY t.id, t.tranid, t.trandate, t.createddate, t.status,
  t.subsidiary, t.location, t.memo,
  t.custbody_ino_icai_reference_number, t.custbody_inoday_payment_ref
HAVING MAX(tl.custcol_inoday_inv_enddate) IS NOT NULL
  AND MAX(tl.custcol_inoday_inv_enddate) <= SYSDATE
ORDER BY t.id DESC`;

    try {
      const res = await netsuiteRequest(
        "POST",
        `/services/rest/query/v1/suiteql?limit=${pageSize}&offset=${offset}`,
        { q: query }
      );

      const items = res.items || [];
      allItems.push(...items);

      console.log(`   📥 Fetched ${items.length} records (offset: ${offset}, total: ${allItems.length})`);

      if (items.length < pageSize) {
        hasMore = false;
      } else {
        offset += pageSize;
        console.log("   ⏳ Waiting 500ms before next page...");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (err) {
      console.error(`   ❌ Error at offset ${offset}:`, err.response?.data || err.message);
      hasMore = false;
    }
  }

  if (offset >= MAX_OFFSET) {
    console.warn(`⚠️ Reached max offset (${MAX_OFFSET}). Some records may not be fetched.`);
  }

  console.log(`📦 Total eligible Sales Orders for cron: ${allItems.length}`);
  return allItems;
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

function buildInvoiceBody(so) {
  const dateSource = so.end_date || so.trandate;
  const invoiceDate = getLastDayOfMonth(dateSource);

  const body = {
    approvalStatus: { id: "2" },

    // #1 — Date: last day of the month of the End Date (exam period)
    ...(invoiceDate ? { tranDate: invoiceDate } : {}),

    // return from period
    ...(invoiceDate ? { custbody_in_return_form_period: { refName: getMonthYear(invoiceDate) } } : {}),

    // #2 — Memo/UTR = Payment Order Id (from SO memo field)
    ...(so.memo ? { memo: so.memo } : {}),

    // #3 — Created by Middleware = true
    custbodycreate_middleware: true,

    // Classification
    department: { id: "227" },                     // Cost centre
    location: { id: "286" },                       // Warehouse

    // Source portal fields
    custbody_ino_icai_source_portal: "SSP",
    custbody_ino_icai_source_portal_url: "https://eservices.icai.org/",

    // GL account: 310400 Fees : Exam Fees — internal id 626
    // account: { id: "626" },
  };

  return body;
}

/**
 * Run Invoice Cron Sync.
 * Fetches Sales Orders where:
 *   - end_date (customer deposit end date) is today or before today
 *   - source portal is NOT 'SSP'
 * Protected by mutex — only one execution runs at a time.
 */
async function runInvoiceCronSync() {
  if (invoiceCronMutex.isLocked()) {
    console.log("⚠️ Invoice cron sync already running — request cancelled.");
    return { success: false, message: "Invoice cron sync already in progress. Try again later." };
  }

  const release = await invoiceCronMutex.acquire();

  try {
    // ── STEP 1: Fetch eligible SOs ────────────────────────────────────────────
    const salesOrders = await fetchEligibleSalesOrdersForCron();

    if (!salesOrders.length) {
      console.log("ℹ️ No eligible Sales Orders found for invoice cron creation.");
      return { success: true, message: "No eligible Sales Orders", results: [] };
    }

    console.log(`\n🚀 Creating invoices for ${salesOrders.length} Sales Orders (concurrency: ${CONCURRENCY_LIMIT})...\n`);

    // ── STEP 2: Create Invoices ───────────────────────────────────────────────
    const limit = pLimit(CONCURRENCY_LIMIT);
    const allResults = [];

    const tasks = salesOrders.map((so, index) =>
      limit(async () => {
        try {
          console.log(`🚀 [${index + 1}/${salesOrders.length}] Creating Invoice for SO ${so.id} (${so.tranid || "N/A"})`);

          const invoiceBody = buildInvoiceBody(so);

          const response = await withRetry(
            () => createTransFormRecordInvoice(so.id, invoiceBody),
            `Invoice:SO-${so.id}`
          );

          allResults.push({
            success: true,
            soId: so.id,
            tranid: so.tranid,
            portalOrderId: so.portal_order_id,
            invoiceId: response.id,
          });

          console.log(`✅ Invoice created for SO ${so.id} → Invoice ${response.id}`);
        } catch (err) {
          const errMsg = err.response?.data || err.message;
          console.error(`❌ Failed for SO ${so.id}:`, errMsg);
          allResults.push({
            success: false,
            soId: so.id,
            tranid: so.tranid,
            portalOrderId: so.portal_order_id,
            error: errMsg,
          });
        }
      })
    );

    await Promise.all(tasks);

    // ── STEP 3: Summary ───────────────────────────────────────────────────────
    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;

    console.log(`\n📊 Invoice Cron Sync Summary:`);
    console.log(`   - Total : ${salesOrders.length}`);
    console.log(`   - ✅ Success: ${successCount}`);
    console.log(`   - ❌ Failed : ${failCount}`);

    if (failCount > 0) {
      console.log(`\n❌ Failed Invoices (first 10):`);
      allResults
        .filter((r) => !r.success)
        .slice(0, 10)
        .forEach((r) =>
          console.log(`   - SO ${r.soId} (${r.tranid}): ${JSON.stringify(r.error).substring(0, 150)}`)
        );

      if (failCount > 10) {
        console.log(`   ... and ${failCount - 10} more`);
      }
    }

    return {
      success: true,
      message: `Created ${successCount} invoices, ${failCount} failed`,
      summary: {
        total: salesOrders.length,
        successful: successCount,
        failed: failCount,
      },
      results: allResults,
    };

  } catch (err) {
    console.error("❌ Fatal Error in runInvoiceCronSync:", err);
    throw err;
  } finally {
    release();
  }
}

module.exports = { runInvoiceCronSync };
