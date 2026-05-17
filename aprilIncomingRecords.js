/*
 * Standalone export script (does NOT touch production flow).
 *
 * Scans data/2026/<MM>/<DD>/incoming.json across ALL months and writes every
 * record that matches BOTH:
 *   - Payment_Date falls in April 1–30, 2026
 *   - Form_Description is one of the allowed forms below
 * to a single JSON file: April-Records-April.json
 *
 * Run: node aprilIncomingRecords.js
 */

const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.join(__dirname, 'data', '2026');
const OUT_FILE = path.join(__dirname, 'April-Records-April.json');

const ALLOWED_FORMS = new Set([
  'Student Revalidation Form',
  'Student Registration Form',
  'Form 103 Registration Fee',
  'Form 103',
]);

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

function collect() {
  const out = [];
  const months = listDirs(DATA_ROOT);
  for (const mm of months) {
    const monthPath = path.join(DATA_ROOT, mm);
    for (const dd of listDirs(monthPath)) {
      const folder = path.join(monthPath, dd);
      const arr = readJsonSafe(path.join(folder, 'incoming.json'));
      if (!Array.isArray(arr)) continue;
      for (const r of arr) {
        if (!r) continue;
        if (!isAprilDate(r.Payment_Date)) continue;
        if (!ALLOWED_FORMS.has(r.Form_Description)) continue;
        out.push(r);
      }
    }
  }
  return out;
}

console.log(`\n#  April 2026 — Export filtered incoming records to JSON`);
console.log(`#  Data root: ${DATA_ROOT}`);
console.log(`#  Out file : ${OUT_FILE}`);
console.log(`#  Forms    : ${[...ALLOWED_FORMS].join(', ')}\n`);

const records = collect();
fs.writeFileSync(OUT_FILE, JSON.stringify(records, null, 2));

// Per-form breakdown so the count is auditable at a glance.
const byForm = {};
for (const r of records) byForm[r.Form_Description] = (byForm[r.Form_Description] || 0) + 1;

console.log(`  Wrote ${records.length} records -> ${OUT_FILE}`);
for (const [form, count] of Object.entries(byForm).sort()) {
  console.log(`    ${form.padEnd(32)} ${count}`);
}
console.log('');
