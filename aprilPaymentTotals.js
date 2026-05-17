/*
 * Standalone reporting script (does NOT touch production flow).
 * Calculates per-day total Payment_Amount of records that were:
 *   - successfully created in NetSuite (success === true in sync-summary)
 *   - have Payment_Date in April 2026 (DD/04/2026)
 *
 * Scans day folders: 2026/04/22 .. 2026/04/30 and 2026/05/01
 * Run: node aprilPaymentTotals.js
 */

const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.join(__dirname, 'data');

const dayFolders = [
  ['2026', '04', '22'],
  ['2026', '04', '23'],
  ['2026', '04', '24'],
  ['2026', '04', '25'],
  ['2026', '04', '26'],
  ['2026', '04', '27'],
  ['2026', '04', '28'],
  ['2026', '04', '29'],
  ['2026', '04', '30'],
  ['2026', '05', '01'],
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

function isAprilPaymentDate(paymentDate) {
  // Expected format: DD/MM/YYYY -> e.g. "30/04/2026"
  if (typeof paymentDate !== 'string') return false;
  const parts = paymentDate.split('/');
  if (parts.length !== 3) return false;
  return parts[1] === '04' && parts[2] === '2026';
}

let grandTotal = 0;
let grandCount = 0;

console.log('================================================================');
console.log(' April-2026 successful NetSuite Payment_Amount totals (per day)');
console.log('================================================================');

for (const parts of dayFolders) {
  const folderLabel = parts.join('/');
  const folderPath = path.join(DATA_ROOT, ...parts);

  if (!fs.existsSync(folderPath)) {
    console.log(`\n[${folderLabel}] folder missing — skipping`);
    continue;
  }

  const summary = readJsonSafe(path.join(folderPath, 'sync-summary.json'));
  const transactions = readJsonSafe(path.join(folderPath, 'transaction.json'));

  if (!summary || !Array.isArray(summary.results)) {
    console.log(`\n[${folderLabel}] no usable sync-summary.json — skipping`);
    continue;
  }
  if (!Array.isArray(transactions)) {
    console.log(`\n[${folderLabel}] no usable transaction.json — skipping`);
    continue;
  }

  // Build Reference_Number -> Payment_Date map
  const paymentDateByRef = new Map();
  for (const tx of transactions) {
    if (tx && tx.Reference_Number) {
      paymentDateByRef.set(String(tx.Reference_Number), tx.Payment_Date);
    }
  }

  let dayTotal = 0;
  let dayCount = 0;
  let missingPaymentDate = 0;
  let nonAprilSkipped = 0;
  let failureSkipped = 0;

  for (const result of summary.results) {
    if (!result || result.success !== true) {
      failureSkipped++;
      continue;
    }
    const ref = String(result.reference);
    const paymentDate = paymentDateByRef.get(ref);

    if (!paymentDate) {
      missingPaymentDate++;
      continue;
    }
    if (!isAprilPaymentDate(paymentDate)) {
      nonAprilSkipped++;
      continue;
    }

    const amt = parseFloat(result.paymentAmount);
    if (!Number.isFinite(amt)) continue;

    dayTotal += amt;
    dayCount++;
  }

  grandTotal += dayTotal;
  grandCount += dayCount;

  console.log(`\n[${folderLabel}]`);
  console.log(`  successful records counted : ${dayCount}`);
  console.log(`  total Payment_Amount       : ${dayTotal.toFixed(2)}`);
  console.log(`  (skipped: failures=${failureSkipped}, non-April Payment_Date=${nonAprilSkipped}, no Payment_Date match=${missingPaymentDate})`);
}

console.log('\n----------------------------------------------------------------');
console.log(` GRAND TOTAL across all listed days`);
console.log(`   successful records counted : ${grandCount}`);
console.log(`   total Payment_Amount       : ${grandTotal.toFixed(2)}`);
console.log('================================================================');
