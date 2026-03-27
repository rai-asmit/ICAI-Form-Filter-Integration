"use strict";

const fs = require("fs");
const path = require("path");

const DATA_ROOT = path.join(__dirname, "..", "data");
const PROCESSED_DB = path.join(DATA_ROOT, "processed-records.json");

// ── Data directory ──────────────────────────────────────────────────────────

/**
 * Ensure the root data directory exists and return its path.
 */
function getDailyDir() {
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
  }
  return DATA_ROOT;
}

// ── Duplicate detection ─────────────────────────────────────────────────────

/**
 * Load previously processed record keys from disk.
 * Each key is "Reference_Number|Payment_Order_Id".
 */
function loadProcessedKeys() {
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED_DB, "utf-8")));
  } catch {
    return new Set();
  }
}

/**
 * Persist the processed-records set to disk.
 */
function saveProcessedKeys(keys) {
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
  }
  fs.writeFileSync(PROCESSED_DB, JSON.stringify([...keys], null, 2), "utf-8");
}

/**
 * Split transactions into unique vs already-processed duplicates.
 * Also deduplicates within the current batch.
 */
function filterDuplicates(transactions) {
  const processed = loadProcessedKeys();
  const unique = [];
  const duplicates = [];
  const seen = new Set();

  for (const t of transactions) {
    const key = `${t.Reference_Number}|${t.Payment_Order_Id}`;
    if (processed.has(key) || seen.has(key)) {
      duplicates.push(t);
    } else {
      unique.push(t);
      seen.add(key);
    }
  }

  return { unique, duplicates };
}

/**
 * Mark transactions as processed so future syncs skip them.
 */
function markAsProcessed(transactions) {
  const keys = loadProcessedKeys();
  for (const t of transactions) {
    keys.add(`${t.Reference_Number}|${t.Payment_Order_Id}`);
  }
  saveProcessedKeys(keys);
}

// ── File operations ─────────────────────────────────────────────────────────

/**
 * Append records to a JSON array file in the data directory.
 * Creates the file if it doesn't exist.
 */
function appendToFile(dataDir, fileName, records) {
  if (!records || records.length === 0) return;
  const filePath = path.join(dataDir, fileName);
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    // file doesn't exist or is invalid — start fresh
  }
  existing.push(...records);
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
}

/**
 * Write (overwrite) a JSON file in the data directory.
 */
function writeFile(dataDir, fileName, data) {
  const filePath = path.join(dataDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Step logging ────────────────────────────────────────────────────────────

/**
 * Log a processing step result to the appropriate file.
 * success → {step}-success.json  (stores full transaction record)
 * failure → {step}-failure.json  (stores full transaction record + reason)
 */
function logStepResult(dataDir, step, record) {
  try {
    const suffix = record.success ? "success" : "failure";
    appendToFile(dataDir, `${step}-${suffix}.json`, [record]);
  } catch (err) {
    console.error(`[StateManager] Failed to log ${step} result: ${err.message}`);
  }
}

module.exports = {
  getDailyDir,
  filterDuplicates,
  markAsProcessed,
  appendToFile,
  writeFile,
  logStepResult,
};
