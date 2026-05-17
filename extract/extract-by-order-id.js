"use strict";

/**
 * extract-by-order-id.js — Pull transactions out of incoming.json by Payment_Order_Id.
 *
 * Reads a single CSV/XLSX from extract/upload/ that has a `Payment_Order_Id`
 * column, walks every `data/2026/<MM>/<DD>/incoming.json` day-by-day, and
 * writes the matching records to extract/runs/<timestamp>/<input-stem>.json
 * (e.g. annual-renewal-form.csv → annual-renewal-form.json).
 *
 * This is a read-only extractor — it does NOT call NetSuite or process anything.
 * Use rerun/rerun-failed-records-csv.js if you want the matches processed.
 *
 * Convention: keep exactly one .csv/.xlsx in extract/upload/. After the run
 * the upload is renamed to <name>.done-<timestamp> so the next run starts clean.
 *
 * Run: node extract/extract-by-order-id.js
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const PROJECT_ROOT = path.join(__dirname, "..");
const DATA_ROOT = path.join(PROJECT_ROOT, "data", "2026");
const UPLOAD_DIR = path.join(__dirname, "upload");
const RUNS_ROOT = path.join(__dirname, "runs");

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
      } else field += c;
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

async function loadIdsFromSpreadsheet(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let header = [];
  let dataRows = [];

  if (ext === ".csv") {
    let text = fs.readFileSync(filePath, "utf8");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
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
    throw new Error(`Unsupported spreadsheet extension: ${ext}`);
  }

  const idx = header.findIndex(h => h.toLowerCase() === "payment_order_id");
  if (idx === -1) {
    throw new Error(`Missing Payment_Order_Id column (got: ${header.join(", ")})`);
  }

  const ids = [];
  const seen = new Set();
  for (const row of dataRows) {
    const v = String(row[idx] || "").trim();
    if (v && !seen.has(v)) { seen.add(v); ids.push(v); }
  }
  return ids;
}

function findUploadFile() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    throw new Error(`No upload directory: ${UPLOAD_DIR}`);
  }
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(n => /\.(csv|xlsx)$/i.test(n) && !n.includes(".done-"));
  if (files.length === 0) throw new Error(`No .csv/.xlsx in ${UPLOAD_DIR}/`);
  if (files.length > 1) {
    throw new Error(`Multiple uploads in ${UPLOAD_DIR}/ — keep one: ${files.join(", ")}`);
  }
  return path.join(UPLOAD_DIR, files[0]);
}

function listDirs(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (err) {
    console.error(`  ! Failed to parse ${p}: ${err.message}`);
    return null;
  }
}

function collectMatchingRecords(wantedIds) {
  const wanted = new Set(wantedIds);
  const matched = new Map(); // id -> { record, file } — first match wins
  let scannedFiles = 0;
  let scannedRecords = 0;

  for (const mm of listDirs(DATA_ROOT)) {
    const monthPath = path.join(DATA_ROOT, mm);
    for (const dd of listDirs(monthPath)) {
      const file = path.join(monthPath, dd, "incoming.json");
      const arr = readJsonSafe(file);
      if (!Array.isArray(arr)) continue;
      scannedFiles++;
      const rel = path.relative(PROJECT_ROOT, file);
      for (const r of arr) {
        if (!r || !r.Payment_Order_Id) continue;
        scannedRecords++;
        if (!wanted.has(r.Payment_Order_Id)) continue;
        if (matched.has(r.Payment_Order_Id)) continue;
        matched.set(r.Payment_Order_Id, { record: r, file: rel });
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
  const stem = path.basename(uploadFile, path.extname(uploadFile));
  const outFile = path.join(runDir, `${stem}.json`);

  console.log(`\n[Extract] ════════════════════════════════════════`);
  console.log(`[Extract] Upload:     ${uploadFile}`);
  console.log(`[Extract] Output dir: ${runDir}`);
  console.log(`[Extract] Output JSON: ${path.basename(outFile)}`);
  console.log(`[Extract] ════════════════════════════════════════\n`);

  const ids = await loadIdsFromSpreadsheet(uploadFile);
  console.log(`[Extract] Unique Payment_Order_Ids in upload: ${ids.length}`);
  if (ids.length === 0) { console.log(`[Extract] Nothing to do.`); return; }

  const { matched, scannedFiles, scannedRecords } = collectMatchingRecords(ids);
  const matchedRecords = [...matched.values()].map(v => v.record);
  const missing = ids.filter(id => !matched.has(id));

  fs.writeFileSync(outFile, JSON.stringify(matchedRecords, null, 2), "utf-8");

  const sourceMap = Object.fromEntries(
    [...matched.entries()].map(([id, v]) => [id, v.file])
  );
  fs.writeFileSync(
    path.join(runDir, `${stem}.source-map.json`),
    JSON.stringify(sourceMap, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(runDir, `${stem}.missing.json`),
    JSON.stringify(missing, null, 2),
    "utf-8"
  );

  const summary = {
    startedAt: new Date(startTime).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    uploadFile: path.relative(PROJECT_ROOT, uploadFile),
    outputFile: path.relative(PROJECT_ROOT, outFile),
    inputIds: ids.length,
    matched: matchedRecords.length,
    missing: missing.length,
    scannedFiles,
    scannedRecords,
  };
  fs.writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8"
  );

  // Archive the upload so the next run isn't ambiguous.
  const archived = path.join(UPLOAD_DIR, `${path.basename(uploadFile)}.done-${ts}`);
  fs.renameSync(uploadFile, archived);

  console.log(`\n[Extract] ════════════════════════════════════════`);
  console.log(`[Extract] EXTRACT COMPLETE`);
  console.log(`[Extract]   incoming.json files scanned : ${scannedFiles}`);
  console.log(`[Extract]   records scanned             : ${scannedRecords}`);
  console.log(`[Extract]   input IDs                   : ${ids.length}`);
  console.log(`[Extract]   matched                     : ${matchedRecords.length}`);
  console.log(`[Extract]   missing                     : ${missing.length}`);
  console.log(`[Extract]   wrote                       : ${path.relative(PROJECT_ROOT, outFile)}`);
  console.log(`[Extract]   archived upload as          : ${path.basename(archived)}`);
  console.log(`[Extract] ════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error(`[Extract] Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
