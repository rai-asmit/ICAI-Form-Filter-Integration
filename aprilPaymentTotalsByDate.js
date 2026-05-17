/*
 * Standalone reporting script (does NOT touch production flow).
 *
 * Scans the entire data/2026/ tree, picks records that:
 *   - have Payment_Date in April 2026 (01/04/2026 .. 30/04/2026)
 *   - match one of the configured (Fee_Head, Form_Description) filters
 *
 * Successful refs   -> union of every *-success.json step file
 * Failed refs       -> union of every *-failure.json step file
 * A reference appearing in BOTH is counted in both (per user spec — no exclusion).
 *
 * Files are read across all day-folders. Success/failure files are appended on
 * every run (see stateManager.appendToFile) so they survive folder reuse.
 * Dedup is by Reference_Number within each bucket (successful / failed).
 *
 * Run: node aprilPaymentTotalsByDate.js
 */

const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.join(__dirname, 'data', '2026');

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

// (Fee_Head, Form_Description) filter. Empty feeHead = match by Form_Description only.
const FORM_FILTERS = [
  { feeHead: 'S118', form: 'Student Revalidation Form',     label: 'Revalidation Fee - Intermediate' },
  { feeHead: 'S138', form: 'Student Registration Form',     label: 'Foundation Tution Fee' },
  { feeHead: 'S142', form: 'Student Registration Form',     label: 'FOUNDATION FOREIGN STUDENT PROSPECTUS FEES' },
  { feeHead: 'S143', form: 'Student Registration Form',     label: 'Prospectus Fees - Foundation (Foundation Foreign Student)' },
  { feeHead: 'S145', form: 'Student Registration Form',     label: 'Registration Fee - Intermediate' },
  { feeHead: 'S146', form: 'Student Registration Form',     label: 'Student Activities Fees/Direct Entry Fees' },
  { feeHead: 'S147', form: 'Student Registration Form',     label: 'Registration Fees as Article Assistant' },
  { feeHead: 'S148', form: 'Student Registration Form',     label: 'Prospectus Fee - Intermediate' },
  { feeHead: 'S152', form: 'Student Registration Form',     label: 'Registration Fees - Intermediate (Foreign Student)' },
  { feeHead: 'S154', form: 'Student Registration Form',     label: 'Registration Fee - Final' },
  { feeHead: 'S156', form: 'Student Registration Form',     label: 'Foreign Student Fees - Final' },
  { feeHead: 'S158', form: 'Form 103 Registration Fee',     label: 'Direct Entry Fees' },
  { feeHead: '',     form: 'Form 103',                      label: 'Form 103 (no Fee_Head)' },
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

function extractFeeHeadCodes(feeHeadField) {
  // Fee_Head can be: an array of objects with FeeHeadCode1/FeeHeadCode2/... keys,
  // a single object, an empty string, null, or absent. Return the set of codes.
  const codes = new Set();
  if (!feeHeadField) return codes;
  const arr = Array.isArray(feeHeadField) ? feeHeadField : [feeHeadField];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    for (const [k, v] of Object.entries(item)) {
      if (/^FeeHeadCode\d*$/.test(k) && v) codes.add(String(v).trim());
    }
  }
  return codes;
}

function matchesFilter(r) {
  const form = String(r.Form_Description ?? '').trim();
  const codes = extractFeeHeadCodes(r.Fee_Head);
  for (let i = 0; i < FORM_FILTERS.length; i++) {
    const f = FORM_FILTERS[i];
    if (form !== f.form) continue;
    const feeOk = f.feeHead === '' ? true : codes.has(f.feeHead);
    if (feeOk) return i;
  }
  return -1;
}

function collect(files) {
  // ref -> { paymentDate, amount, filterIdx, fromFolder }
  const refs = new Map();
  let rowsSeen = 0;
  let nonApril = 0;
  let noMatch = 0;
  let badAmount = 0;
  let dupRef = 0;

  const months = listDirs(DATA_ROOT);
  for (const mm of months) {
    const monthPath = path.join(DATA_ROOT, mm);
    for (const dd of listDirs(monthPath)) {
      const folder = path.join(monthPath, dd);
      const label = `2026/${mm}/${dd}`;

      for (const fname of files) {
        const arr = readJsonSafe(path.join(folder, fname));
        if (!Array.isArray(arr)) continue;
        for (const r of arr) {
          if (!r) continue;
          rowsSeen++;
          if (!isAprilDate(r.Payment_Date)) { nonApril++; continue; }
          const idx = matchesFilter(r);
          if (idx === -1) { noMatch++; continue; }
          const ref = r.Reference_Number != null ? String(r.Reference_Number) : null;
          if (!ref) continue;
          const amt = parseFloat(r.Payment_Amount);
          if (!Number.isFinite(amt)) { badAmount++; continue; }
          if (refs.has(ref)) { dupRef++; continue; }
          refs.set(ref, { paymentDate: r.Payment_Date, amount: amt, filterIdx: idx, fromFolder: `${label}/${fname}` });
        }
      }
    }
  }
  return { refs, rowsSeen, nonApril, noMatch, badAmount, dupRef };
}

function aggregateByDate(refs) {
  const byDate = new Map();
  for (const { paymentDate, amount } of refs.values()) {
    const cur = byDate.get(paymentDate) || { count: 0, amount: 0 };
    cur.count += 1;
    cur.amount += amount;
    byDate.set(paymentDate, cur);
  }
  return byDate;
}

function printDayTable(title, byDate) {
  console.log('=====================================================================');
  console.log(` ${title}`);
  console.log('=====================================================================');
  console.log(' Payment_Date     |  records  |   total Payment_Amount');
  console.log('---------------------------------------------------------------------');
  let totRec = 0, totAmt = 0;
  const daysSeen = new Set();
  for (let d = 1; d <= 30; d++) {
    const key = `${String(d).padStart(2, '0')}/04/2026`;
    const e = byDate.get(key);
    if (e) {
      totRec += e.count; totAmt += e.amount;
      daysSeen.add(key.slice(0, 2));
      console.log(`   ${key.padEnd(13)}|  ${String(e.count).padStart(6)}   |   ${e.amount.toFixed(2)}`);
    } else {
      console.log(`   ${key.padEnd(13)}|     -     |   not present`);
    }
  }
  console.log('---------------------------------------------------------------------');
  console.log(` TOTAL  -> records: ${totRec}   amount: ${totAmt.toFixed(2)}`);
  const missing = [];
  for (let d = 1; d <= 30; d++) {
    const dd = String(d).padStart(2, '0');
    if (!daysSeen.has(dd)) missing.push(dd);
  }
  console.log(` Distinct April day-numbers with data: ${daysSeen.size} / 30`);
  console.log(` Missing April day-numbers: ${missing.length ? missing.join(', ') : 'none'}`);
  return { totRec, totAmt };
}

function printFilterCoverage(title, refs) {
  console.log('=====================================================================');
  console.log(` ${title}`);
  console.log('=====================================================================');
  const counts = new Array(FORM_FILTERS.length).fill(0);
  const amounts = new Array(FORM_FILTERS.length).fill(0);
  for (const v of refs.values()) {
    counts[v.filterIdx] += 1;
    amounts[v.filterIdx] += v.amount;
  }
  for (let i = 0; i < FORM_FILTERS.length; i++) {
    const f = FORM_FILTERS[i];
    const tag = f.feeHead ? f.feeHead : '(none)';
    const line = `   ${tag.padEnd(8)}| ${f.form.padEnd(30)}| ${f.label}`;
    if (counts[i] === 0) {
      console.log(`${line}\n     -> not found in this bucket`);
    } else {
      console.log(`${line}\n     -> records: ${counts[i]}   amount: ${amounts[i].toFixed(2)}`);
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
const success = collect(SUCCESS_FILES);
const failure = collect(FAILURE_FILES);

console.log('\n#####################################################################');
console.log('#  April 2026 — Payment_Amount totals (filtered by Fee_Head / Form)');
console.log(`#  Data root: ${DATA_ROOT}`);
console.log(`#  Success source: ${SUCCESS_FILES.join(', ')}`);
console.log(`#  Failure source: ${FAILURE_FILES.join(', ')}`);
console.log('#  Dedup: by Reference_Number within each bucket independently.');
console.log('#####################################################################\n');

const successByDate = aggregateByDate(success.refs);
const sucTotals = printDayTable('SUCCESSFUL — by Payment_Date', successByDate);

console.log('');
const failureByDate = aggregateByDate(failure.refs);
const failTotals = printDayTable('FAILED — by Payment_Date', failureByDate);

console.log('');
printFilterCoverage('SUCCESSFUL — by filter (Fee_Head / Form_Description)', success.refs);
console.log('');
printFilterCoverage('FAILED — by filter (Fee_Head / Form_Description)', failure.refs);

console.log('\n=====================================================================');
console.log(' GRAND SUMMARY (April 2026, filtered)');
console.log('=====================================================================');
console.log(`   Successful : ${sucTotals.totRec} records   amount: ${sucTotals.totAmt.toFixed(2)}`);
console.log(`   Failed     : ${failTotals.totRec} records   amount: ${failTotals.totAmt.toFixed(2)}`);

console.log('\n Diagnostics (success scan):');
console.log(`   rows seen           : ${success.rowsSeen}`);
console.log(`   skipped non-April   : ${success.nonApril}`);
console.log(`   skipped non-matching: ${success.noMatch}`);
console.log(`   skipped bad amount  : ${success.badAmount}`);
console.log(`   dedup duplicates    : ${success.dupRef}`);

console.log(' Diagnostics (failure scan):');
console.log(`   rows seen           : ${failure.rowsSeen}`);
console.log(`   skipped non-April   : ${failure.nonApril}`);
console.log(`   skipped non-matching: ${failure.noMatch}`);
console.log(`   skipped bad amount  : ${failure.badAmount}`);
console.log(`   dedup duplicates    : ${failure.dupRef}`);
console.log('=====================================================================');
