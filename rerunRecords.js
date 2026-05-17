"use strict";

/**
 * rerunRecords.js — Standalone rerun script.
 *
 * Flow:
 *   1. Read rerun/data.csv. ONLY the Payment_Order_Id column is used; every
 *      other column in the CSV is ignored.
 *   2. Read April-Records-April.json (the curated April source export).
 *   3. For each Payment_Order_Id in the CSV, look up the full record in the
 *      JSON. Unmatched IDs are logged and skipped.
 *   4. Process each matched record exactly like the main pipeline does
 *      (membership/student vs. exam classification, customer fetch, etc.).
 *   5. Per-step success/failure logs + summary are written to a dedicated
 *      rerun/runs/<timestamp>/ folder. Main pipeline state is untouched.
 *
 * Run: node rerunRecords.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit").default;

const { fetchAllCustomers } = require("./netsuiteClient--Rest");
const { processTransaction: processMembership } = require("./syncMembershipStudent");
const { processTransaction: processExam } = require("./syncExamEnrollment");
const { getAllAllowedForms, getConfigForForm } = require("./membership/helpers");

const CONCURRENCY_LIMIT = 40;
const CUSTOMER_BATCH_SIZE = 50;

const RERUN_DIR = path.join(__dirname, "rerun");
const RERUN_CSV = path.join(RERUN_DIR, "data.csv");
const RUNS_ROOT = path.join(RERUN_DIR, "runs");
const SOURCE_JSON = path.join(__dirname, "April-Records-April.json");

// ── Minimal CSV parser (handles quoted fields & escaped quotes) ─────────────
function parseCsv(text) {
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
      else if (c === "\r") { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.length > 0 && !(r.length === 1 && r[0] === ""));
}

function loadPaymentOrderIds() {
  if (!fs.existsSync(RERUN_CSV)) {
    throw new Error(`Rerun CSV not found at ${RERUN_CSV}`);
  }
  let text = fs.readFileSync(RERUN_CSV, "utf8");
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip UTF-8 BOM
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim());
  const idx = header.findIndex(h => h.toLowerCase() === "payment_order_id");
  if (idx === -1) {
    throw new Error(`CSV must contain a Payment_Order_Id column (got: ${header.join(", ")})`);
  }

  const ids = [];
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const v = (rows[i][idx] || "").trim();
    if (v && !seen.has(v)) { seen.add(v); ids.push(v); }
  }
  return ids;
}

function loadSourceRecords() {
  if (!fs.existsSync(SOURCE_JSON)) {
    throw new Error(`Source JSON not found at ${SOURCE_JSON} — run aprilIncomingRecords.js first.`);
  }
  const arr = JSON.parse(fs.readFileSync(SOURCE_JSON, "utf8"));
  if (!Array.isArray(arr)) throw new Error(`${SOURCE_JSON} is not a JSON array`);
  return arr;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS_ROOT, ts);
  fs.mkdirSync(runDir, { recursive: true });

  console.log(`\n[Rerun] ════════════════════════════════════════`);
  console.log(`[Rerun] CSV:        ${RERUN_CSV}`);
  console.log(`[Rerun] Source:     ${SOURCE_JSON}`);
  console.log(`[Rerun] Output dir: ${runDir}`);
  console.log(`[Rerun] ════════════════════════════════════════\n`);

  const ids = loadPaymentOrderIds();
  console.log(`[Rerun] Unique Payment_Order_Ids in CSV: ${ids.length}`);
  if (ids.length === 0) {
    console.log(`[Rerun] Nothing to do.`);
    return;
  }

  const source = loadSourceRecords();
  console.log(`[Rerun] Source records loaded: ${source.length}`);

  // Index source by Payment_Order_Id. First occurrence wins on duplicates.
  const byOrderId = new Map();
  let dupes = 0;
  for (const r of source) {
    const k = r && r.Payment_Order_Id;
    if (!k) continue;
    if (byOrderId.has(k)) { dupes++; continue; }
    byOrderId.set(k, r);
  }
  if (dupes > 0) {
    console.warn(`[Rerun] Note: ${dupes} duplicate Payment_Order_Ids in source — kept first occurrence`);
  }

  const records = [];
  const missing = [];
  for (const id of ids) {
    const r = byOrderId.get(id);
    if (r) records.push(r);
    else missing.push(id);
  }
  console.log(`[Rerun] Matched: ${records.length}/${ids.length}`);
  if (missing.length > 0) {
    console.warn(`[Rerun] Unmatched Payment_Order_Ids (${missing.length}):`);
    for (const m of missing.slice(0, 20)) console.warn(`  - ${m}`);
    if (missing.length > 20) console.warn(`  ...and ${missing.length - 20} more`);
  }

  if (records.length === 0) {
    console.log(`[Rerun] No matched records — exiting.`);
    return;
  }

  // Snapshot the input CSV alongside the logs so the run is reproducible.
  fs.copyFileSync(RERUN_CSV, path.join(runDir, "input.csv"));

  const allowedForms = getAllAllowedForms();
  const membership = records.filter(t => allowedForms.includes(t.Form_Description));
  const exam = records.filter(t => !allowedForms.includes(t.Form_Description));
  console.log(`[Rerun] Membership/Student: ${membership.length} | Exam/Other: ${exam.length}`);

  const uniqueCustomerIds = [...new Set(records.map(t => t.Customer_ID).filter(Boolean))];
  console.log(`[Rerun] Fetching ${uniqueCustomerIds.length} customers from NetSuite...`);
  const customers = [];
  for (let i = 0; i < uniqueCustomerIds.length; i += CUSTOMER_BATCH_SIZE) {
    const batch = uniqueCustomerIds.slice(i, i + CUSTOMER_BATCH_SIZE);
    const part = await fetchAllCustomers(batch);
    customers.push(...part);
  }
  const customerMap = {};
  for (const c of customers) {
    if (c.entityid) customerMap[c.entityid] = c.id;
  }
  console.log(`[Rerun] Resolved ${Object.keys(customerMap).length}/${uniqueCustomerIds.length} customers`);

  const limit = pLimit(CONCURRENCY_LIMIT);
  const passed = [];
  const failed = [];

  const membershipTasks = membership.map((t, i) => limit(async () => {
    const cfg = getConfigForForm(t.Form_Description);
    console.log(`\n[Rerun] ── [M ${i + 1}/${membership.length}] ${t.Reference_Number} (${t.Form_Description}) ──`);
    const r = await processMembership(t, customerMap, cfg, runDir);
    if (r.success) passed.push({ reference: t.Reference_Number, form: t.Form_Description });
    else failed.push({ reference: t.Reference_Number, form: t.Form_Description, reason: r.error || "unknown" });
  }));

  const examTasks = exam.map((t, i) => limit(async () => {
    console.log(`\n[Rerun] ── [E ${i + 1}/${exam.length}] ${t.Reference_Number} (${t.Form_Description}) ──`);
    const r = await processExam(t, customerMap, runDir);
    if (r.success) passed.push({ reference: t.Reference_Number, form: t.Form_Description });
    else failed.push({ reference: t.Reference_Number, form: t.Form_Description, reason: r.error || "unknown" });
  }));

  await Promise.all([...membershipTasks, ...examTasks]);

  const durationMs = Date.now() - startTime;
  const summary = {
    startedAt: new Date(startTime).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs,
    csv: RERUN_CSV,
    sourceJson: SOURCE_JSON,
    outputDir: runDir,
    counts: {
      csvOrderIds: ids.length,
      matched: records.length,
      unmatched: missing.length,
      membership: membership.length,
      exam: exam.length,
      passed: passed.length,
      failed: failed.length,
    },
    unmatched: missing,
    passed,
    failed,
  };
  fs.writeFileSync(path.join(runDir, "rerun-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  // Archive the CSV so the next run doesn't accidentally repeat it.
  const archived = path.join(RERUN_DIR, `data.csv.done-${ts}`);
  fs.renameSync(RERUN_CSV, archived);

  console.log(`\n[Rerun] ════════════════════════════════════════`);
  console.log(`[Rerun] RERUN COMPLETE`);
  console.log(`[Rerun]   CSV Order IDs      : ${ids.length}`);
  console.log(`[Rerun]   Matched in source  : ${records.length}`);
  console.log(`[Rerun]   Unmatched (skipped): ${missing.length}`);
  console.log(`[Rerun]   Membership/Student : ${membership.length}`);
  console.log(`[Rerun]   Exam/Other         : ${exam.length}`);
  console.log(`[Rerun]   Passed             : ${passed.length}`);
  console.log(`[Rerun]   Failed             : ${failed.length}`);
  console.log(`[Rerun]   Duration           : ${durationMs}ms`);
  console.log(`[Rerun]   Output dir         : ${runDir}`);
  console.log(`[Rerun]   CSV archived to    : ${archived}`);
  console.log(`[Rerun] ════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error(`[Rerun] Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
