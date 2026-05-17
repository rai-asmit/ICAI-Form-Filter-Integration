"use strict";

/**
 * find-missing-order-ids.js — Lookup utility for Payment_Order_Id presence.
 *
 * Recursively scans every `incoming.json` under data/ AND data-backup/ (any
 * depth, any year/month/day layout), and for a given list of Payment_Order_Ids
 * reports:
 *   - which were found and in which file(s)
 *   - which are missing entirely
 *   - per-date breakdown of the missing set (by the yyyymmdd embedded in the ID)
 *
 * Input options (first one wins):
 *   1. CLI args:                node rerun/find-missing-order-ids.js ID1 ID2 ...
 *   2. File of IDs (one/line):  node rerun/find-missing-order-ids.js --file path/to/ids.txt
 *   3. xlsx/csv from upload/:   node rerun/find-missing-order-ids.js --upload
 *      (uses the same single-file convention as rerun-failed-records-csv.js)
 *
 * Output: rerun/lookups/<timestamp>/{found.json, missing.json, summary.json}
 *
 * Run: node rerun/find-missing-order-ids.js --upload
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const PROJECT_ROOT = path.join(__dirname, "..");
const SCAN_ROOTS = [
  path.join(PROJECT_ROOT, "data"),
  path.join(PROJECT_ROOT, "data-backup"),
];
const UPLOAD_DIR = path.join(__dirname, "upload");
const OUT_ROOT = path.join(__dirname, "lookups");

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
  if (idx === -1) throw new Error(`Missing Payment_Order_Id column (got: ${header.join(", ")})`);

  const ids = [];
  const seen = new Set();
  for (const row of dataRows) {
    const v = String(row[idx] || "").trim();
    if (v && !seen.has(v)) { seen.add(v); ids.push(v); }
  }
  return ids;
}

function findSingleUpload() {
  if (!fs.existsSync(UPLOAD_DIR)) throw new Error(`No upload dir: ${UPLOAD_DIR}`);
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter(n => /\.(csv|xlsx)$/i.test(n) && !n.includes(".done-"));
  if (files.length === 0) throw new Error(`No .csv/.xlsx in ${UPLOAD_DIR}/`);
  if (files.length > 1) throw new Error(`Multiple uploads in ${UPLOAD_DIR}/ — keep one: ${files.join(", ")}`);
  return path.join(UPLOAD_DIR, files[0]);
}

async function loadInputIds() {
  const args = process.argv.slice(2);
  if (args[0] === "--upload") {
    const f = findSingleUpload();
    console.log(`[Lookup] Reading IDs from upload: ${f}`);
    return loadIdsFromSpreadsheet(f);
  }
  if (args[0] === "--file") {
    if (!args[1]) throw new Error(`--file needs a path`);
    const text = fs.readFileSync(args[1], "utf8");
    return [...new Set(text.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  }
  if (args.length > 0) {
    return [...new Set(args.map(s => s.trim()).filter(Boolean))];
  }
  throw new Error(
    "No input. Use:\n" +
    "  node rerun/find-missing-order-ids.js --upload\n" +
    "  node rerun/find-missing-order-ids.js --file ids.txt\n" +
    "  node rerun/find-missing-order-ids.js ID1 ID2 ..."
  );
}

// ── Recursively walk every incoming.json under the given roots ──────────────
function* walkIncomingJsons(roots) {
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && e.name === "incoming.json") yield p;
      }
    }
  }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (err) {
    console.error(`  ! Failed to parse ${p}: ${err.message}`);
    return null;
  }
}

function relFromProject(p) {
  return path.relative(PROJECT_ROOT, p);
}

async function main() {
  const ids = await loadInputIds();
  console.log(`[Lookup] Unique input IDs: ${ids.length}`);
  if (ids.length === 0) { console.log("[Lookup] Nothing to do."); return; }

  const wanted = new Set(ids);
  const foundLocations = new Map(); // id -> [{file, payment_date}]
  let scannedFiles = 0;
  let scannedRecords = 0;

  for (const file of walkIncomingJsons(SCAN_ROOTS)) {
    const arr = readJsonSafe(file);
    if (!Array.isArray(arr)) continue;
    scannedFiles++;
    const rel = relFromProject(file);
    for (const r of arr) {
      if (!r || !r.Payment_Order_Id) continue;
      scannedRecords++;
      const id = r.Payment_Order_Id;
      if (!wanted.has(id)) continue;
      if (!foundLocations.has(id)) foundLocations.set(id, []);
      foundLocations.get(id).push({ file: rel, payment_date: r.Payment_Date || null });
    }
  }

  const found = ids.filter(id => foundLocations.has(id));
  const missing = ids.filter(id => !foundLocations.has(id));

  // Group missing by embedded yyyymmdd (the 2026-prefixed 8-digit run inside the ID).
  const missingByDate = {};
  for (const m of missing) {
    const d = (m.match(/(2026\d{4})/) || [])[1] || "unknown";
    (missingByDate[d] = missingByDate[d] || []).push(m);
  }
  const missingDateCounts = Object.fromEntries(
    Object.entries(missingByDate).sort().map(([d, arr]) => [d, arr.length])
  );

  // ── Write outputs ─────────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(OUT_ROOT, ts);
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(
    path.join(outDir, "found.json"),
    JSON.stringify(Object.fromEntries(foundLocations), null, 2),
    "utf-8"
  );
  fs.writeFileSync(path.join(outDir, "missing.json"), JSON.stringify(missing, null, 2), "utf-8");
  fs.writeFileSync(path.join(outDir, "missing.txt"), missing.join("\n") + "\n", "utf-8");
  fs.writeFileSync(
    path.join(outDir, "missing-by-date.json"),
    JSON.stringify(missingByDate, null, 2),
    "utf-8"
  );

  const summary = {
    finishedAt: new Date().toISOString(),
    scanRoots: SCAN_ROOTS.map(relFromProject),
    scannedFiles,
    scannedRecords,
    inputIds: ids.length,
    found: found.length,
    missing: missing.length,
    missingByDate: missingDateCounts,
    outputDir: relFromProject(outDir),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  // ── Console report ────────────────────────────────────────────────────────
  console.log(`\n[Lookup] ════════════════════════════════════════`);
  console.log(`[Lookup] Scan roots         : ${summary.scanRoots.join(", ")}`);
  console.log(`[Lookup] incoming.json files: ${scannedFiles}`);
  console.log(`[Lookup] Records scanned    : ${scannedRecords}`);
  console.log(`[Lookup] Input IDs          : ${ids.length}`);
  console.log(`[Lookup] Found              : ${found.length}`);
  console.log(`[Lookup] Missing            : ${missing.length}`);
  if (missing.length) {
    console.log(`[Lookup] Missing by embedded yyyymmdd:`);
    for (const [d, n] of Object.entries(missingDateCounts)) console.log(`           ${d} -> ${n}`);
  }
  console.log(`[Lookup] Output dir         : ${summary.outputDir}`);
  console.log(`[Lookup] ════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error(`[Lookup] Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
