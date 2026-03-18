/**
 * Transaction State Manager
 * Handles state-based transaction processing with file-based persistence.
 *
 * Folder structure (date-based):
 *   data/incoming.json                  ← queue (flat, spans days)
 *   data/YYYY/MM/DD/sales-order-done.json
 *   data/YYYY/MM/DD/sales-order-failed.json
 *   data/YYYY/MM/DD/customer-deposit-done.json
 *   data/YYYY/MM/DD/customer-deposit-failed.json
 *   data/YYYY/MM/DD/invoice-done.json
 *   data/YYYY/MM/DD/invoice-failed.json
 *   data/YYYY/MM/DD/icai-fetch-errors.json
 */

const fs = require("fs");
const path = require("path");

// Root data directory
const ROOT_DATA_DIR = path.join(__dirname, "data");

// ─── Date Folder Helper ───────────────────────────────────────────────────────

/**
 * Returns today's date folder segment: "YYYY/MM/DD"
 * Uses local time parts to match what the user sees on disk.
 */
function getDateFolder() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}/${mm}/${dd}`;
}

/**
 * Returns the full dated directory path for today: data/YYYY/MM/DD
 */
function getDatedDataDir() {
    return path.join(ROOT_DATA_DIR, getDateFolder());
}

// ─── State File Definitions ───────────────────────────────────────────────────

/**
 * States that live in the dated folder (data/YYYY/MM/DD/)
 */
const DATED_STATE_FILES = {
    sales_order_done: "sales-order-done.json",
    sales_order_failed: "sales-order-failed.json",
    customer_deposit_done: "customer-deposit-done.json",
    customer_deposit_failed: "customer-deposit-failed.json",
    invoice_done: "invoice-done.json",
    invoice_failed: "invoice-failed.json",
    icai_fetch_errors: "icai-fetch-errors.json",
};

/**
 * States that live at root data/ (queue files, not day-specific)
 */
const ROOT_STATE_FILES = {
    incoming: "incoming.json",
};

// Combined — for validation
const ALL_STATE_KEYS = new Set([
    ...Object.keys(DATED_STATE_FILES),
    ...Object.keys(ROOT_STATE_FILES),
]);

// ─── Path Resolution ──────────────────────────────────────────────────────────

/**
 * Ensure a directory exists (creates recursively if needed).
 */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Get full file path for a given state key.
 * – Root states → data/<file>
 * – Dated states → data/YYYY/MM/DD/<file>
 */
function getStatePath(stateName) {
    if (!ALL_STATE_KEYS.has(stateName)) {
        throw new Error(
            `Invalid state: "${stateName}". Valid states: ${[...ALL_STATE_KEYS].join(", ")}`
        );
    }

    if (ROOT_STATE_FILES[stateName]) {
        ensureDir(ROOT_DATA_DIR);
        return path.join(ROOT_DATA_DIR, ROOT_STATE_FILES[stateName]);
    }

    const datedDir = getDatedDataDir();
    ensureDir(datedDir);
    return path.join(datedDir, DATED_STATE_FILES[stateName]);
}

// ─── Core CRUD ────────────────────────────────────────────────────────────────

/**
 * Read records from a state file.
 * @param {string} stateName
 * @returns {Array}
 */
function readState(stateName) {
    const filePath = getStatePath(stateName);

    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8");
            const data = JSON.parse(content);
            return Array.isArray(data.records) ? data.records : [];
        }
    } catch (err) {
        console.error(`[StateManager] Error reading "${stateName}":`, err.message);
    }

    return [];
}

/**
 * Write records to a state file (atomic write via temp file).
 * @param {string} stateName
 * @param {Array} records
 */
function writeState(stateName, records) {
    const filePath = getStatePath(stateName);

    const data = {
        updatedAt: new Date().toISOString(),
        count: records.length,
        records,
    };

    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tempPath, filePath);

    console.log(`[StateManager] Wrote ${records.length} records → ${path.relative(__dirname, filePath)}`);
}

/**
 * Append records to a state file.
 * @param {string} stateName
 * @param {Array} newRecords
 */
function appendToState(stateName, newRecords) {
    const existing = readState(stateName);
    writeState(stateName, [...existing, ...newRecords]);
}

// ─── Compound Helpers ─────────────────────────────────────────────────────────

/**
 * Append failed records with strict stage validation.
 * @param {Array} records
 * @param {"sales_order" | "customer_deposit" | "invoice"} stage
 * @param {Object} errorContext
 */
function appendToFailed(records, stage, errorContext = {}) {
    if (!records || records.length === 0) return;

    const validStages = ["sales_order", "customer_deposit", "invoice"];
    if (!validStages.includes(stage)) {
        throw new Error(`Invalid failure stage: "${stage}". Valid: ${validStages.join(", ")}`);
    }

    const stateKey =
        stage === "invoice" ? "invoice_failed" :
            stage === "customer_deposit" ? "customer_deposit_failed" :
                "sales_order_failed";

    const enriched = records.map((record) => ({
        ...record,
        _failedStage: stage,
        _error: errorContext,
        _failedAt: new Date().toISOString(),
    }));

    appendToState(stateKey, enriched);
}

/**
 * Remove specific records from a state.
 * @param {string} stateName
 * @param {Array} recordsToRemove
 */
function removeRecords(stateName, recordsToRemove) {
    if (!recordsToRemove || recordsToRemove.length === 0) return;

    const records = readState(stateName);
    const keysToRemove = new Set(recordsToRemove.map(getRecordKey));
    const remaining = records.filter((r) => !keysToRemove.has(getRecordKey(r)));

    writeState(stateName, remaining);

    console.log(
        `[StateManager] Removed ${records.length - remaining.length} records from "${stateName}"`
    );
}

/**
 * Prevent reprocessing of already-completed records.
 * Checks both done buckets for today's day folder.
 * @param {Array} records
 */
function filterAlreadyProcessed(records) {
    const processedKeys = new Set([
        ...readState("sales_order_done").map(getRecordKey),
        ...readState("invoice_done").map(getRecordKey),
    ]);

    const newRecords = [];
    const alreadyProcessed = [];

    for (const record of records) {
        const key = getRecordKey(record);
        processedKeys.has(key)
            ? alreadyProcessed.push(record)
            : newRecords.push(record);
    }

    if (alreadyProcessed.length > 0) {
        console.log(
            `[StateManager] Skipped ${alreadyProcessed.length} already-processed records`
        );
    }

    return { newRecords, alreadyProcessed };
}

/**
 * Summary of record counts across all state files.
 */
function getStateSummary() {
    return {
        incoming: readState("incoming").length,
        sales_order_done: readState("sales_order_done").length,
        sales_order_failed: readState("sales_order_failed").length,
        customer_deposit_done: readState("customer_deposit_done").length,
        customer_deposit_failed: readState("customer_deposit_failed").length,
        invoice_done: readState("invoice_done").length,
        invoice_failed: readState("invoice_failed").length,
    };
}

/**
 * Unique key for a transaction record.
 */
function getRecordKey(record) {
    return `${record.Reference_Number}_${record.Payment_Order_Id}`;
}

module.exports = {
    readState,
    writeState,
    appendToState,
    appendToFailed,
    removeRecords,
    getRecordKey,
    filterAlreadyProcessed,
    getStateSummary,
    getDateFolder,
    getDatedDataDir,
    // expose dirs for consumers that need them (e.g. log placement)
    ROOT_DATA_DIR,
};
