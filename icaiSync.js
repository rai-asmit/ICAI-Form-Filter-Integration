require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// State Manager for transaction lifecycle
const {
    writeState,
    appendToState,
    readState,
    getRecordKey,
    filterAlreadyProcessed
} = require("./transactionStateManager");

// ICAI API URLs
const AUTH_URL = "https://eservices.icai.org/iONBizServices/Authenticate";
const SERVICE_URL = "https://eservices.icai.org/EForms/CustomWebserviceServlet";

// Token storage
let cachedToken = null;
let tokenExpiry = null;


// Send one structured log to backend
async function sendStructuredLog(integrationId, source, level, report) {
    if (!integrationId) return;
    try {
        await fetch('https://localhost/3000/logs/stream', {
        // await fetch('https://api.nidish.com/api/logs/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                integrationId,
                level,
                message: report,
                timestamp: new Date().toISOString(),
                source
            })
        });
    } catch (e) {
        // fire and forget
    }
}

// Getting tokenid status and message during
function parseTokenFromXML(xmlString) {
    const tokenMatch = xmlString.match(/TOKENID\s*=\s*['"]([^'"]+)['"]/i);
    const statusMatch = xmlString.match(/STATUS\s*=\s*['"]([^'"]+)['"]/i);
    const msgMatch = xmlString.match(/MSG\s*=\s*['"]([^'"]+)['"]/i);
    return {
        tokenId: tokenMatch ? tokenMatch[1] : null,
        status: statusMatch ? statusMatch[1] : null,
        message: msgMatch ? msgMatch[1] : null,
    };
}

// Authentication
async function authenticate() {
    // 30 second buffer so token never expires mid-request
    if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 30000) {
        console.log("[ICAI] Using cached token");
        return cachedToken;
    }

    console.log("[ICAI] Authenticating...");

    const params = new URLSearchParams();
    params.append("usrloginid", process.env.USR_LOGIN_ID);
    params.append("usrpassword", process.env.USR_PASSWORD);

    const response = await axios.post(AUTH_URL, params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 60000,
        maxRedirects: 5,
    });

    const parsed = parseTokenFromXML(response.data);
    if (parsed.status !== "1" || !parsed.tokenId) {
        throw new Error(`Auth failed: ${parsed.message}`);
    }

    cachedToken = parsed.tokenId;
    tokenExpiry = Date.now() + 4 * 60 * 1000; // 4 minutes

    console.log("[ICAI] Token:", cachedToken);
    return cachedToken;
}

// Fetch Transactions
async function fetchTransactions(tokenid) {
    const dateFilter = "12/03/2026";
    // For dynamic yesterday, replace the line above with:
    // const yesterday = new Date();
    // yesterday.setDate(yesterday.getDate() - 1);
    // const dateFilter = `${String(yesterday.getDate()).padStart(2,'0')}/${String(yesterday.getMonth()+1).padStart(2,'0')}/${yesterday.getFullYear()}`;

    const NUMBER_OF_RECORDS = 800;
    const DELAY_MS = 3000;
    const MAX_RETRIES = 3;

    let allTransactions = [];
    let data_offset = 0;
    let batchNumber = 1;

    console.log(`[ICAI] Starting fetch for date: ${dateFilter}`);

    while (true) {
        console.log(`[ICAI] Batch ${batchNumber} | offset: ${data_offset}`);

        const params = new URLSearchParams();
        params.append("orgId", process.env.ORG_ID);
        params.append("tokenid", tokenid);
        params.append("serviceCalled", process.env.SERVICE_CALLED);
        params.append("actionId", process.env.ACTION_ID);
        params.append("getDetail", process.env.GET_DETAIL_TRANSACTIONS);
        params.append("fromDate", dateFilter);
        params.append("toDate", dateFilter);
        params.append("number_of_records", NUMBER_OF_RECORDS);
        params.append("data_offset", data_offset);

        // Retry logic — transient errors should not kill the whole loop
        let response = null;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                response = await axios.post(SERVICE_URL, params.toString(), {
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    timeout: 120000,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    maxRedirects: 5,
                });
                break; // success — exit retry loop
            } catch (err) {
                console.error(`[ICAI] Batch ${batchNumber} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
                if (attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }

        if (!response) {
            console.error(`[ICAI] ❌ Batch ${batchNumber} failed after ${MAX_RETRIES} attempts — stopping`);
            break;
        }

        const data = response.data;
        console.log(`[ICAI] Batch ${batchNumber} Response_Message: ${data?.Response_Message}`);

        // Portal offset limit reached — stop cleanly
        const message = (data?.Response_Message || "").toLowerCase();
        if (message.includes("offset")) {
            console.log(`[ICAI] ✅ Portal offset limit reached at page ${data_offset} — stopping`);
            break;
        }

        // Extract records — handle both response shapes from the portal
        let transactions = [];
        if (data?.Data && Array.isArray(data.Data)) {
            transactions = data.Data;
        } else if (Array.isArray(data)) {
            transactions = data;
        }

        // Empty response = no more pages left
        if (transactions.length === 0) {
            console.log(`[ICAI] ✅ No records at offset ${data_offset} — all data fetched`);
            break;
        }

        allTransactions = allTransactions.concat(transactions);
        console.log(`[ICAI] Batch ${batchNumber}: ${transactions.length} records | Total so far: ${allTransactions.length}`);

        data_offset += NUMBER_OF_RECORDS; // 1 → 801 → 1601 → ...
        batchNumber++;

        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    console.log(`[ICAI] ✅ Fetch complete. Total records: ${allTransactions.length}`);
    return allTransactions;
}

// Load existing transactions from file (to append new data)
function loadExistingTransactions() {
    const filePath = path.join(__dirname, "transactions.json");
    try {
        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            const existing = JSON.parse(fileContent);
            if (existing.data?.Data && Array.isArray(existing.data.Data)) {
                return existing.data.Data;
            } else if (existing.Data && Array.isArray(existing.Data)) {
                return existing.Data;
            }
        }
    } catch (err) {
        console.log("[ICAI] No existing transactions or error reading file, starting fresh");
    }
    return [];
}

// Save transactions (returns stats for structured report)
function saveTransactionsToJSON(newTransactions, tokenid) {
    const filePath = path.join(__dirname, "transactions.json");
    const saveStats = { existingInFile: 0, duplicatesSkipped: 0, uniqueNew: 0, totalAfterMerge: 0, addedToQueue: 0, alreadyProcessed: 0 };

    // Load existing transactions
    const existingTransactions = loadExistingTransactions();
    saveStats.existingInFile = existingTransactions.length;
    console.log(`[ICAI] Existing transactions in file: ${existingTransactions.length}`);

    // Duplicate Prevention using getRecordKey
    const existingKeys = new Set(existingTransactions.map(getRecordKey));
    const uniqueNewTransactions = newTransactions.filter(t => !existingKeys.has(getRecordKey(t)));
    saveStats.duplicatesSkipped = newTransactions.length - uniqueNewTransactions.length;
    saveStats.uniqueNew = uniqueNewTransactions.length;

    console.log(`[ICAI] New transactions: ${newTransactions.length}, Unique (non-duplicate): ${uniqueNewTransactions.length}`);

    if (uniqueNewTransactions.length === 0) {
        console.log(`[ICAI] ⚠️ All ${newTransactions.length} transactions already exist - skipping save`);
        return { filePath, saveStats };
    }

    // Combine existing + unique new
    const allTransactions = [...existingTransactions, ...uniqueNewTransactions];
    saveStats.totalAfterMerge = allTransactions.length;
    console.log(`[ICAI] Total after adding new: ${allTransactions.length}`);

    // Save combined data
    const dataToSave = {
        fetchedAt: new Date().toISOString(),
        tokenId: tokenid,
        totalRecords: allTransactions.length,
        data: {
            Response_Message: "Transactional Data Fetched",
            Data: allTransactions
        }
    };

    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 4), "utf-8");
    console.log(`[ICAI] Saved: transactions.json (${allTransactions.length} total records)`);

    const { newRecords } = filterAlreadyProcessed(uniqueNewTransactions);

    if (newRecords.length > 0) {
        appendToState("incoming", newRecords);
        saveStats.addedToQueue = newRecords.length;
        console.log(`[ICAI] ✅ Added ${newRecords.length} records to incoming queue`);
    } else {
        saveStats.alreadyProcessed = uniqueNewTransactions.length;
        console.log(`[ICAI] ⚠️ All records already processed - incoming queue not updated`);
    }

    return { filePath, saveStats };
}

// Main sync
async function runICAISync({ integrationId } = {}) {
    const syncStart = Date.now();
    const report = {
        outcome: "success",
        auth: null,
        fetch: { dateFilter: null, totalFetched: 0, batches: 0 },
        allFetchedRecords: [],
        formFilter: { allowed: [], rejected: [], allowedForms: [] },
        save: null,
        error: null
    };

    console.log("[ICAI] Starting sync...");
    const tokenid = await authenticate();
    report.auth = cachedToken && tokenExpiry && Date.now() < tokenExpiry ? "cached_token" : "new_token";

    try {
        console.log("[ICAI] Fetching transactions...");
        const filterTransations = await fetchTransactions(tokenid);

        // Build fetch report
        report.fetch.totalFetched = filterTransations.length;
        report.allFetchedRecords = filterTransations.map(r => ({
            Reference_Number: r.Reference_Number,
            Form_Description: r.Form_Description,
            Customer_ID: r.Customer_ID,
            Payment_Amount: r.Payment_Amount,
            Payment_Order_Id: r.Payment_Order_Id,
            Payment_Date: r.Payment_Date
        }));

        // Filter Form Description
        const allowedForms = [
            "Exam Enrollment Final Form",
            "Exam Enrollment Foundation Form",
            "Exam Enrollment Intermediate Form",
            "Exam Enrollment Correction Intermediate Form",
            "Exam Enrollment Correction Final Form",
            "Exam Enrollment Correction Foundation Form"
        ];
        report.formFilter.allowedForms = allowedForms;

        const newTransactions = filterTransations.filter(value => allowedForms.includes(value.Form_Description));
        const rejectedTransactions = filterTransations.filter(value => !allowedForms.includes(value.Form_Description));

        report.formFilter.allowed = newTransactions.map(r => ({
            ref: r.Reference_Number,
            form: r.Form_Description,
            amount: r.Payment_Amount
        }));
        report.formFilter.rejected = rejectedTransactions.map(r => ({
            ref: r.Reference_Number,
            form: r.Form_Description,
            reason: "Form not in allowed list"
        }));

        if (filterTransations.length > 0 && newTransactions.length == 0) {
            console.log("[ICAI] Transations Filtered Out. Details:");
            console.log(
                filterTransations.map(value =>
                    `[${value.Payment_Date}] Ref: ${value.Reference_Number} | Customer: ${value.Customer_ID} | OrderID: ${value.Payment_Order_Id || 'N/A'} | Amt: ₹${value.Payment_Amount || 0} | Form: ${value.Form_Description}`
                )
            );
        }

        // ONLY save if we actually got new records
        if (newTransactions.length > 0) {
            const { saveStats } = saveTransactionsToJSON(newTransactions, tokenid);
            report.save = saveStats;
            console.log(`[ICAI] ✅ Added ${newTransactions.length} new transactions`);
            console.log(newTransactions.map(value => value.Reference_Number));
        } else {
            report.save = { existingInFile: 0, duplicatesSkipped: 0, uniqueNew: 0, addedToQueue: 0, alreadyProcessed: 0 };
            report.outcome = filterTransations.length === 0 ? "no_data" : "no_matching_forms";
            console.log("[ICAI] ⚠️ No new transactions fetched - file NOT updated");
        }
    } catch (err) {
        report.outcome = "failed";
        report.error = { message: err.message, stack: err.stack };
        console.error("[ICAI] Transactions error:", err.message);

        const { getDatedDataDir } = require("./transactionStateManager");
        const errorLogPath = path.join(getDatedDataDir(), "icai-fetch-errors.json");
        const existingErrors = fs.existsSync(errorLogPath)
            ? JSON.parse(fs.readFileSync(errorLogPath, "utf-8"))
            : { errors: [] };

        existingErrors.errors.push({
            timestamp: new Date().toISOString(),
            error: err.message,
            stack: err.stack,
            tokenId: tokenid
        });

        fs.writeFileSync(errorLogPath, JSON.stringify(existingErrors, null, 2), "utf-8");
        console.log(`[ICAI] ❌ Error logged to data/${require("./transactionStateManager").getDateFolder()}/icai-fetch-errors.json`);
    }

    // Build and send ONE structured summary
    report.durationMs = Date.now() - syncStart;
    report.summary = [
        `Outcome: ${report.outcome}`,
        `Duration: ${report.durationMs}ms`,
        `Fetched: ${report.fetch.totalFetched} records`,
        `Form Filter: ${report.formFilter.allowed.length} allowed, ${report.formFilter.rejected.length} rejected`,
        report.save ? `Dedup: ${report.save.duplicatesSkipped} duplicates skipped, ${report.save.uniqueNew} unique new` : null,
        report.save ? `Queue: ${report.save.addedToQueue} added, ${report.save.alreadyProcessed} already processed` : null,
        report.error ? `Error: ${report.error.message}` : null
    ].filter(Boolean).join(" | ");

    await sendStructuredLog(
        integrationId,
        "ICAI Sync Report",
        report.outcome === "failed" ? "error" : "info",
        report
    );

    console.log("[ICAI] Sync complete!");
    return { success: report.outcome !== "failed", message: "ICAI sync completed", tokenId: tokenid };
}

module.exports = { runICAISync };