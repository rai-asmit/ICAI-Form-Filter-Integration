/*
 * Standalone export script (does NOT touch production flow).
 *
 * Scans data/2026/ for ALL April 2026 records (no Fee_Head / Form_Description
 * filter) and writes them as CSV:
 *
 *   april-records/passed.csv   (all successful refs, deduped)
 *   april-records/failed.csv   (all failed refs, deduped)
 *
 * Success refs  = union of every *-success.json step file
 * Failed refs   = union of every *-failure.json step file
 * Dedup by Reference_Number within each bucket independently.
 *
 * Fee_Head is an array of {FeeAmountN, FeeHeadCodeN, FeeHeadN}; it is flattened
 * into columns FeeAmount1, FeeHeadCode1, FeeHead1, FeeAmount2, ... up to the
 * max number of fee entries seen in the bucket. The original Fee_Head column
 * is also kept as a JSON string for reference.
 *
 * Run: node aprilRecordsByDate.js
 */

const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.join(__dirname, 'data', '2026');
const OUT_DIR = path.join(__dirname, 'april-records');

const SUCCESS_FILES = [
  'sales-order-success.json',
  'invoice-success.json',
  'customer-payment-success.json',
  'customer-deposit-success.json',
  'journal-voucher-success.json',
];

const FAILURE_FILES = [
  'sales-order-failure.json',
  'customer-payment-failure.json',
];

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`  ! Failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}

function listDirs(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

function isAprilDate(paymentDate) {
  if (typeof paymentDate !== 'string') return false;
  const parts = paymentDate.split('/');
  if (parts.length !== 3) return false;
  const [dd, mm, yyyy] = parts;
  if (mm !== '04' || yyyy !== '2026') return false;
  const n = Number(dd);
  return Number.isInteger(n) && n >= 1 && n <= 30;
}

function collect(files) {
  const refs = new Map(); // ref -> record
  const months = listDirs(DATA_ROOT);
  for (const mm of months) {
    const monthPath = path.join(DATA_ROOT, mm);
    for (const dd of listDirs(monthPath)) {
      const folder = path.join(monthPath, dd);
      for (const fname of files) {
        const arr = readJsonSafe(path.join(folder, fname));
        if (!Array.isArray(arr)) continue;
        for (const r of arr) {
          if (!r) continue;
          if (!isAprilDate(r.Payment_Date)) continue;
          const ref = r.Reference_Number != null ? String(r.Reference_Number) : null;
          if (!ref) continue;
          if (refs.has(ref)) continue;
          refs.set(ref, r);
        }
      }
    }
  }
  return [...refs.values()];
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// CSV escaping per RFC 4180: wrap in quotes if value contains comma, quote, CR, or LF.
// Escape internal quotes by doubling them.
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : String(v);
  // Normalise line breaks to space — CSV readers vary on embedded newlines.
  s = s.replace(/\r?\n/g, ' ');
  if (/[",]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Pull FeeAmountN / FeeHeadCodeN / FeeHeadN from a Fee_Head value into a flat map.
// Fee_Head can be: an array of objects, a single object, or empty/null.
// Each object may itself carry multiple numbered keys (FeeAmount1, FeeAmount2, ...).
// Returns { 1: {amount, code, head}, 2: {...}, ... } keyed by index, plus maxIdx.
function flattenFeeHead(feeHeadField) {
  const byIdx = {};
  if (!feeHeadField) return { byIdx, maxIdx: 0 };
  const arr = Array.isArray(feeHeadField) ? feeHeadField : [feeHeadField];
  let autoIdx = 0;
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    // Group numbered keys by their suffix number within this object.
    const localGroups = {}; // n -> { amount, code, head }
    for (const [k, v] of Object.entries(item)) {
      const mA = /^FeeAmount(\d*)$/.exec(k);
      const mC = /^FeeHeadCode(\d*)$/.exec(k);
      const mH = /^FeeHead(\d*)$/.exec(k);
      if (!mA && !mC && !mH) continue;
      const nStr = (mA || mC || mH)[1];
      const n = nStr === '' ? 1 : Number(nStr);
      if (!localGroups[n]) localGroups[n] = {};
      if (mA) localGroups[n].amount = v;
      else if (mC) localGroups[n].code = v;
      else if (mH) localGroups[n].head = v;
    }
    const ns = Object.keys(localGroups).map(Number).sort((a, b) => a - b);
    for (const n of ns) {
      autoIdx += 1;
      byIdx[autoIdx] = localGroups[n];
    }
  }
  const maxIdx = Object.keys(byIdx).reduce((m, k) => Math.max(m, Number(k)), 0);
  return { byIdx, maxIdx };
}

function buildCsv(records) {
  if (records.length === 0) return '';

  // 1. Collect top-level keys (union, preserving first-seen order).
  const topKeys = [];
  const topSeen = new Set();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!topSeen.has(k)) { topSeen.add(k); topKeys.push(k); }
    }
  }

  // 2. Pre-flatten Fee_Head for every record + find max fee count.
  let maxFee = 0;
  const flatList = records.map(r => {
    const flat = flattenFeeHead(r.Fee_Head);
    if (flat.maxIdx > maxFee) maxFee = flat.maxIdx;
    return flat;
  });

  // 3. Build final column order: top-level keys (Fee_Head kept as JSON string),
  //    followed by FeeAmount1, FeeHeadCode1, FeeHead1, FeeAmount2, ... up to maxFee.
  const columns = [...topKeys];
  for (let i = 1; i <= maxFee; i++) {
    columns.push(`FeeAmount${i}`);
    columns.push(`FeeHeadCode${i}`);
    columns.push(`FeeHead${i}`);
  }

  // 4. Emit rows.
  const lines = [];
  lines.push(columns.map(csvEscape).join(','));
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const flat = flatList[i].byIdx;
    const row = [];
    for (const col of topKeys) {
      let v = r[col];
      if (col === 'Fee_Head') {
        v = v == null ? '' : JSON.stringify(v);
      } else if (v !== null && typeof v === 'object') {
        v = JSON.stringify(v);
      }
      row.push(csvEscape(v));
    }
    for (let n = 1; n <= maxFee; n++) {
      const g = flat[n] || {};
      row.push(csvEscape(g.amount));
      row.push(csvEscape(g.code));
      row.push(csvEscape(g.head));
    }
    lines.push(row.join(','));
  }
  return lines.join('\n') + '\n';
}

// ── Run ─────────────────────────────────────────────────────────────────────
console.log(`\n#  April 2026 — Export records to CSV`);
console.log(`#  Data root: ${DATA_ROOT}`);
console.log(`#  Out dir  : ${OUT_DIR}\n`);

ensureDir(OUT_DIR);

const successRecords = collect(SUCCESS_FILES);
const failureRecords = collect(FAILURE_FILES);

const passedCsv = buildCsv(successRecords);
const failedCsv = buildCsv(failureRecords);

const passedPath = path.join(OUT_DIR, 'passed.csv');
const failedPath = path.join(OUT_DIR, 'failed.csv');

fs.writeFileSync(passedPath, passedCsv);
fs.writeFileSync(failedPath, failedCsv);

console.log(`  passed.csv  ->  ${successRecords.length} records  ->  ${passedPath}`);
console.log(`  failed.csv  ->  ${failureRecords.length} records  ->  ${failedPath}`);
console.log('');
