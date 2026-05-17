"use strict";

/**
 * rerun-failed-records-csv.js — Rerun failed records sourced from a CSV/XLSX upload.
 *
 * Flow:
 *   1. Pick up a single CSV/XLSX file from rerun/upload/. Only the
 *      Payment_Order_Id column is consumed — every other column is ignored.
 *   2. Walk data/2026/<MM>/<DD>/incoming.json across ALL months and collect
 *      every record whose Payment_Order_Id is in the upload. No date filter.
 *   3. Snapshot the matched records to rerun/csv-runs/<timestamp>/incoming.json
 *      (the same shape the SSP fetch writes), then hand them to the exact same
 *      processors the main pipeline uses (membership/student vs. exam).
 *   4. Per-step logs + summary land in rerun/csv-runs/<timestamp>/. The original
 *      upload is archived so it isn't picked up again.
 *
 * Run: node rerun/rerun-failed-records-csv.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit").default;
const ExcelJS = require("exceljs");

const { fetchAllCustomers } = require("../netsuiteClient--Rest");
const { processTransaction: processMembership } = require("../syncMembershipStudent");
const { processTransaction: processExam } = require("../syncExamEnrollment");
const { getAllAllowedForms, getConfigForForm } = require("../membership/helpers");

const CONCURRENCY_LIMIT = 40;
const CUSTOMER_BATCH_SIZE = 50;

const PROJECT_ROOT = path.join(__dirname, "..");
const UPLOAD_DIR = path.join(__dirname, "upload");
const RUNS_ROOT = path.join(__dirname, "csv-runs");
const DATA_ROOT = path.join(PROJECT_ROOT, "data", "2026");

// ── CSV parser (handles quoted fields & escaped quotes) ─────────────────────
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

function findUploadFile() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    throw new Error(`No upload found. Drop a CSV/XLSX into ${UPLOAD_DIR}/`);
  }
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(name => /\.(csv|xlsx)$/i.test(name))
    .filter(name => !name.includes(".done-"));
  if (files.length === 0) {
    throw new Error(`No .csv or .xlsx file in ${UPLOAD_DIR}/`);
  }
  if (files.length > 1) {
    throw new Error(`Multiple uploads found in ${UPLOAD_DIR}/ — keep only one: ${files.join(", ")}`);
  }
  return path.join(UPLOAD_DIR, files[0]);
}

async function loadPaymentOrderIds(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  let header = [];
  let dataRows = [];

  if (ext === ".csv") {
    let text = fs.readFileSync(filePath, "utf8");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip UTF-8 BOM
    const rows = parseCsv(text);
    if (rows.length < 2) return [];
    header = rows[0].map(h => String(h).trim());
    dataRows = rows.slice(1);
  } else if (ext === ".xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows = [];
    ws.eachRow({ includeEmpty: false }, row => {
      // row.values is 1-indexed; drop the leading undefined
      const vals = row.values.slice(1).map(v => {
        if (v == null) return "";
        if (typeof v === "object" && "text" in v) return String(v.text);
        if (typeof v === "object" && "result" in v) return String(v.result);
        return String(v);
      });
      rows.push(vals);
    });
    if (rows.length < 2) return [];
    header = rows[0].map(h => String(h).trim());
    dataRows = rows.slice(1);
  } else {
    throw new Error(`Unsupported upload extension: ${ext}`);
  }

  const idx = header.findIndex(h => h.toLowerCase() === "payment_order_id");
  if (idx === -1) {
    throw new Error(`Upload must contain a Payment_Order_Id column (got: ${header.join(", ")})`);
  }

  const ids = [];
  const seen = new Set();
  for (const row of dataRows) {
    const v = String(row[idx] || "").trim();
    if (v && !seen.has(v)) { seen.add(v); ids.push(v); }
  }
  return ids;
}

function listDirs(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (err) {
    console.error(`  ! Failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}

function collectMatchingRecords(wantedIds) {
  const wanted = new Set(wantedIds);
  const matched = new Map(); // Payment_Order_Id -> record (first match wins)
  let scannedFiles = 0;
  let scannedRecords = 0;

  for (const mm of listDirs(DATA_ROOT)) {
    const monthPath = path.join(DATA_ROOT, mm);
    for (const dd of listDirs(monthPath)) {
      const file = path.join(monthPath, dd, "incoming.json");
      const arr = readJsonSafe(file);
      if (!Array.isArray(arr)) continue;
      scannedFiles++;
      for (const r of arr) {
        if (!r || !r.Payment_Order_Id) continue;
        scannedRecords++;
        if (!wanted.has(r.Payment_Order_Id)) continue;
        if (matched.has(r.Payment_Order_Id)) continue;
        matched.set(r.Payment_Order_Id, r);
      }
    }
  }
  return { matched, scannedFiles, scannedRecords };
}

async function main() {
  const startTime = Date.now();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS_ROOT, ts);
  fs.mkdirSync(runDir, { recursive: true });

  const uploadFile = findUploadFile();

  console.log(`\n[RerunCSV] ════════════════════════════════════════`);
  console.log(`[RerunCSV] Upload:     ${uploadFile}`);
  console.log(`[RerunCSV] Data root:  ${DATA_ROOT}`);
  console.log(`[RerunCSV] Output dir: ${runDir}`);
  console.log(`[RerunCSV] ════════════════════════════════════════\n`);

  const ids = await loadPaymentOrderIds(uploadFile);
  console.log(`[RerunCSV] Unique Payment_Order_Ids in upload: ${ids.length}`);
  if (ids.length === 0) {
    console.log(`[RerunCSV] Nothing to do.`);
    return;
  }

  const { matched, scannedFiles, scannedRecords } = collectMatchingRecords(ids);
  const records = [...matched.values()];
  const missing = ids.filter(id => !matched.has(id));

  console.log(`[RerunCSV] Scanned incoming.json files: ${scannedFiles}`);
  console.log(`[RerunCSV] Scanned records total       : ${scannedRecords}`);
  console.log(`[RerunCSV] Matched                     : ${records.length}/${ids.length}`);
  if (missing.length > 0) {
    console.warn(`[RerunCSV] Unmatched Payment_Order_Ids (${missing.length}):`);
    for (const m of missing.slice(0, 20)) console.warn(`  - ${m}`);
    if (missing.length > 20) console.warn(`  ...and ${missing.length - 20} more`);
  }

  if (records.length === 0) {
    console.log(`[RerunCSV] No matched records — exiting.`);
    return;
  }

  // Snapshot inputs alongside logs so the run is reproducible. The matched
  // records are written as `incoming.json` so the run dir mirrors the shape
  // the SSP fetch produces under data/2026/<MM>/<DD>/.
  fs.copyFileSync(uploadFile, path.join(runDir, "input" + path.extname(uploadFile)));
  fs.writeFileSync(path.join(runDir, "incoming.json"), JSON.stringify(records, null, 2), "utf-8");
  fs.writeFileSync(path.join(runDir, "unmatched.json"), JSON.stringify(missing, null, 2), "utf-8");

  const allowedForms = getAllAllowedForms();
  const membership = records.filter(t => allowedForms.includes(t.Form_Description));
  const exam = records.filter(t => !allowedForms.includes(t.Form_Description));
  console.log(`[RerunCSV] Membership/Student: ${membership.length} | Exam/Other: ${exam.length}`);

  const uniqueCustomerIds = [...new Set(records.map(t => t.Customer_ID).filter(Boolean))];
  console.log(`[RerunCSV] Fetching ${uniqueCustomerIds.length} customers from NetSuite...`);
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
  console.log(`[RerunCSV] Resolved ${Object.keys(customerMap).length}/${uniqueCustomerIds.length} customers`);

  const limit = pLimit(CONCURRENCY_LIMIT);
  const passed = [];
  const failed = [];

  const membershipTasks = membership.map((t, i) => limit(async () => {
    const cfg = getConfigForForm(t.Form_Description);
    console.log(`\n[RerunCSV] ── [M ${i + 1}/${membership.length}] ${t.Reference_Number} (${t.Form_Description}) ──`);
    const r = await processMembership(t, customerMap, cfg, runDir);
    if (r.success) passed.push({ reference: t.Reference_Number, form: t.Form_Description });
    else failed.push({ reference: t.Reference_Number, form: t.Form_Description, reason: r.error || "unknown" });
  }));

  const examTasks = exam.map((t, i) => limit(async () => {
    console.log(`\n[RerunCSV] ── [E ${i + 1}/${exam.length}] ${t.Reference_Number} (${t.Form_Description}) ──`);
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
    uploadFile,
    dataRoot: DATA_ROOT,
    outputDir: runDir,
    counts: {
      uploadOrderIds: ids.length,
      scannedFiles,
      scannedRecords,
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

  // Archive the upload so the next run doesn't accidentally repeat it.
  const ext = path.extname(uploadFile);
  const base = path.basename(uploadFile, ext);
  const archived = path.join(UPLOAD_DIR, `${base}${ext}.done-${ts}`);
  fs.renameSync(uploadFile, archived);

  console.log(`\n[RerunCSV] ════════════════════════════════════════`);
  console.log(`[RerunCSV] RERUN COMPLETE`);
  console.log(`[RerunCSV]   Upload Order IDs   : ${ids.length}`);
  console.log(`[RerunCSV]   Matched in source  : ${records.length}`);
  console.log(`[RerunCSV]   Unmatched (skipped): ${missing.length}`);
  console.log(`[RerunCSV]   Membership/Student : ${membership.length}`);
  console.log(`[RerunCSV]   Exam/Other         : ${exam.length}`);
  console.log(`[RerunCSV]   Passed             : ${passed.length}`);
  console.log(`[RerunCSV]   Failed             : ${failed.length}`);
  console.log(`[RerunCSV]   Duration           : ${durationMs}ms`);
  console.log(`[RerunCSV]   Output dir         : ${runDir}`);
  console.log(`[RerunCSV]   Upload archived to : ${archived}`);
  console.log(`[RerunCSV] ════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error(`[RerunCSV] Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
