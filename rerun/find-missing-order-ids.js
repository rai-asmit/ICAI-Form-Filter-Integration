"use strict";

/**
 * find-missing-order-ids.js — Match an ID list against scanned incoming records.
 *
 * Reads an ID list from   rerun/find-data/payment_order_id_list.txt
 * (comma-, whitespace- or newline-separated — any mix), recursively scans every
 * `incoming.json` under data/ and data-backup/, and for each input ID pulls out
 * the matching record(s). Repeated rows (same ID + same Reference_Number, which
 * occur because incoming.json is append-logged) are de-duplicated.
 *
 * NOTE: although the input file is named "payment_order_id_list.txt", its
 * values are actually Customer_ID codes (e.g. CRO0712213, APP4344164). To stay
 * correct regardless, each ID is matched against these record fields in order:
 *     Customer_ID  →  Payment_Order_Id  →  Reference_Number
 * The field that produced the match is recorded per record (`_matchedField`).
 *
 * Output (written to the SAME folder as the input list):
 *     rerun/find-data/result.json
 *       {
 *         generatedAt, inputIdCount, matchedIdCount, missingIdCount,
 *         scannedFiles, scannedRecords, matchFieldCounts,
 *         missingIds: [...],
 *         records:    [ ...matched incoming records, each with
 *                       _sourceFile and _matchedField added ]
 *       }
 *
 * Run: node rerun/find-missing-order-ids.js
 */

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const FIND_DATA_DIR = path.join(__dirname, "find-data");
const INPUT_FILE = path.join(FIND_DATA_DIR, "payment_order_id_list.txt");
const OUTPUT_FILE = path.join(FIND_DATA_DIR, "result.json");
const SCAN_ROOTS = [
  path.join(PROJECT_ROOT, "data"),
  path.join(PROJECT_ROOT, "data-backup"),
];

// Record fields an input ID is tried against, in priority order.
const MATCH_FIELDS = ["Customer_ID", "Payment_Order_Id", "Reference_Number"];

// ── Load & de-duplicate the input ID list ───────────────────────────────────
function loadInputIds() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Input file not found: ${INPUT_FILE}`);
  }
  let text = fs.readFileSync(INPUT_FILE, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  const ids = [];
  const seen = new Set();
  for (const raw of text.split(/[,\s]+/)) {
    const v = raw.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      ids.push(v);
    }
  }
  return ids;
}

// ── Recursively walk every incoming.json under the given roots ──────────────
function* walkIncomingJsons(roots) {
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && e.name === "incoming.json") yield p;
      }
    }
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`  ! Failed to parse ${p}: ${err.message}`);
    return null;
  }
}

function relFromProject(p) {
  return path.relative(PROJECT_ROOT, p);
}

function main() {
  const ids = loadInputIds();
  console.log(`[Match] Input file        : ${relFromProject(INPUT_FILE)}`);
  console.log(`[Match] Unique input IDs  : ${ids.length}`);
  if (ids.length === 0) {
    console.log("[Match] Nothing to do — input list is empty.");
    return;
  }

  const wanted = new Set(ids);

  // id -> the matched records collected for it
  const matchesById = new Map();
  // id -> which field first matched it (for the summary)
  const matchFieldById = new Map();

  let scannedFiles = 0;
  let scannedRecords = 0;

  for (const file of walkIncomingJsons(SCAN_ROOTS)) {
    const arr = readJsonSafe(file);
    if (!Array.isArray(arr)) continue;
    scannedFiles++;
    const rel = relFromProject(file);

    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      scannedRecords++;

      // Try each candidate field; first one whose value is in the wanted set wins.
      let matchedId = null;
      let matchedField = null;
      for (const field of MATCH_FIELDS) {
        const val = r[field];
        if (val != null && wanted.has(String(val).trim())) {
          matchedId = String(val).trim();
          matchedField = field;
          break;
        }
      }
      if (!matchedId) continue;

      if (!matchesById.has(matchedId)) matchesById.set(matchedId, []);
      const bucket = matchesById.get(matchedId);
      // De-duplicate: incoming.json files contain repeated rows from
      // append-based logging. A record is a true duplicate when the same ID
      // points to the same Reference_Number — keep only the first such row.
      const isDup = bucket.some(
        (x) => x.Reference_Number === r.Reference_Number
      );
      if (!isDup) {
        bucket.push({ ...r, _sourceFile: rel, _matchedField: matchedField });
      }
      if (!matchFieldById.has(matchedId)) matchFieldById.set(matchedId, matchedField);
    }
  }

  // Preserve the original input order in the output.
  const matchedIds = ids.filter((id) => matchesById.has(id));
  const missingIds = ids.filter((id) => !matchesById.has(id));

  const records = [];
  for (const id of matchedIds) records.push(...matchesById.get(id));

  // Count how many IDs matched via each field.
  const matchFieldCounts = {};
  for (const field of MATCH_FIELDS) matchFieldCounts[field] = 0;
  for (const field of matchFieldById.values()) matchFieldCounts[field]++;

  const result = {
    generatedAt: new Date().toISOString(),
    inputFile: relFromProject(INPUT_FILE),
    scanRoots: SCAN_ROOTS.map(relFromProject),
    scannedFiles,
    scannedRecords,
    inputIdCount: ids.length,
    matchedIdCount: matchedIds.length,
    missingIdCount: missingIds.length,
    matchedRecordCount: records.length,
    matchFieldCounts,
    missingIds,
    records,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), "utf-8");

  // ── Console report ────────────────────────────────────────────────────────
  console.log(`\n[Match] ════════════════════════════════════════`);
  console.log(`[Match] Scan roots          : ${result.scanRoots.join(", ")}`);
  console.log(`[Match] incoming.json files : ${scannedFiles}`);
  console.log(`[Match] Records scanned     : ${scannedRecords}`);
  console.log(`[Match] Input IDs           : ${ids.length}`);
  console.log(`[Match] Matched IDs         : ${matchedIds.length}`);
  console.log(`[Match] Missing IDs         : ${missingIds.length}`);
  console.log(`[Match] Matched records     : ${records.length}`);
  console.log(`[Match] Match field breakdown:`);
  for (const [field, n] of Object.entries(matchFieldCounts)) {
    console.log(`          ${field.padEnd(18)} -> ${n}`);
  }
  console.log(`[Match] Output              : ${relFromProject(OUTPUT_FILE)}`);
  console.log(`[Match] ════════════════════════════════════════\n`);
}

try {
  main();
} catch (err) {
  console.error(`[Match] Fatal: ${err.stack || err.message}`);
  process.exit(1);
}
