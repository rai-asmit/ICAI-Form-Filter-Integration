"use strict";

/**
 * rerun-failed-records-csv.js — Rerun failed records from a JSON record dump.
 *
 * Flow:
 *   1. Read the full records straight from rerun/find-data/result.json. That
 *      file is the output of the find-data scan: a JSON object with a `records`
 *      array holding complete records (same shape as the SSP fetch writes to
 *      data/2026/<MM>/<DD>/incoming.json) — no CSV parsing and no data-tree
 *      scan are needed.
 *   2. Snapshot the records to rerun/csv-runs/<timestamp>/incoming.json, then
 *      hand them to the exact same processors the main pipeline uses
 *      (membership/student vs. exam).
 *   3. Per-step logs + summary land in rerun/csv-runs/<timestamp>/. The source
 *      file is archived so it isn't picked up again.
 *
 * Run: node rerun/rerun-failed-records-csv.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit").default;

const { fetchAllCustomers } = require("../netsuiteClient--Rest");
const { processTransaction: processMembership } = require("../syncMembershipStudent");
const { processTransaction: processExam } = require("../syncExamEnrollment");
const { getAllAllowedForms, getConfigForForm } = require("../membership/helpers");

const CONCURRENCY_LIMIT = 40;
const CUSTOMER_BATCH_SIZE = 50;

const RUNS_ROOT = path.join(__dirname, "csv-runs");
const SOURCE_FILE = path.join(__dirname, "find-data", "result.json");

function loadRecords(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
  // result.json is the find-data scan output: { ..., records: [...] }.
  // Accept either that wrapper object or a bare array of records.
  const records = Array.isArray(parsed) ? parsed : parsed && parsed.records;
  if (!Array.isArray(records)) {
    throw new Error(`Source file must contain a records array (or be a JSON array): ${filePath}`);
  }
  return records.filter(r => r && r.Payment_Order_Id);
}

async function main() {
  const startTime = Date.now();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS_ROOT, ts);
  fs.mkdirSync(runDir, { recursive: true });

  console.log(`\n[RerunCSV] ════════════════════════════════════════`);
  console.log(`[RerunCSV] Source:     ${SOURCE_FILE}`);
  console.log(`[RerunCSV] Output dir: ${runDir}`);
  console.log(`[RerunCSV] ════════════════════════════════════════\n`);

  const records = loadRecords(SOURCE_FILE);
  console.log(`[RerunCSV] Records to rerun: ${records.length}`);
  if (records.length === 0) {
    console.log(`[RerunCSV] Nothing to do.`);
    return;
  }

  // Snapshot inputs alongside logs so the run is reproducible. The records are
  // written as `incoming.json` so the run dir mirrors the shape the SSP fetch
  // produces under data/2026/<MM>/<DD>/.
  fs.copyFileSync(SOURCE_FILE, path.join(runDir, "input.json"));
  fs.writeFileSync(path.join(runDir, "incoming.json"), JSON.stringify(records, null, 2), "utf-8");

  const allowedForms = getAllAllowedForms();
  const membership = records.filter(t => allowedForms.includes(t.Form_Description));
  const exam = records.filter(t => !allowedForms.includes(t.Form_Description));
  console.log(`[RerunCSV] Membership/Student: ${membership.length} | Exam/Other: ${exam.length}`);

  const uniqueCustomerIds = [...new Set(records.map(t => t.Customer_ID).filter(Boolean))];
  console.log(`[RerunCSV] Fetching ${uniqueCustomerIds.length} customers from NetSuite...`);
  const customers = [];
  for (let i = 0; i < uniqueCustomerIds.length; i += CUSTOMER_BATCH_SIZE) {
    const batch = uniqueCustomerIds.slice(i, i + CUSTOMER_BATCH_SIZE);
    const part = await fetchAllCustomers(batch);
    customers.push(...part);
  }
  const customerMap = {};
  for (const c of customers) {
    if (c.entityid) customerMap[c.entityid] = c.id;
  }
  console.log(`[RerunCSV] Resolved ${Object.keys(customerMap).length}/${uniqueCustomerIds.length} customers`);

  const limit = pLimit(CONCURRENCY_LIMIT);
  const passed = [];
  const failed = [];

  const membershipTasks = membership.map((t, i) => limit(async () => {
    const cfg = getConfigForForm(t.Form_Description);
    console.log(`\n[RerunCSV] ── [M ${i + 1}/${membership.length}] ${t.Reference_Number} (${t.Form_Description}) ──`);
    const r = await processMembership(t, customerMap, cfg, runDir);
    if (r.success) passed.push({ reference: t.Reference_Number, form: t.Form_Description });
    else failed.push({ reference: t.Reference_Number, form: t.Form_Description, reason: r.error || "unknown" });
  }));

  const examTasks = exam.map((t, i) => limit(async () => {
    console.log(`\n[RerunCSV] ── [E ${i + 1}/${exam.length}] ${t.Reference_Number} (${t.Form_Description}) ──`);
    const r = await processExam(t, customerMap, runDir);
    if (r.success) passed.push({ reference: t.Reference_Number, form: t.Form_Description });
    else failed.push({ reference: t.Reference_Number, form: t.Form_Description, reason: r.error || "unknown" });
  }));

  await Promise.all([...membershipTasks, ...examTasks]);

  const durationMs = Date.now() - startTime;
  const summary = {
    startedAt: new Date(startTime).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs,
    sourceFile: SOURCE_FILE,
    outputDir: runDir,
    counts: {
      records: records.length,
      membership: membership.length,
      exam: exam.length,
      passed: passed.length,
      failed: failed.length,
    },
    passed,
    failed,
  };
  fs.writeFileSync(path.join(runDir, "rerun-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  // Archive the source so the next run doesn't accidentally repeat it.
  const archived = path.join(path.dirname(SOURCE_FILE), `result.json.done-${ts}`);
  fs.renameSync(SOURCE_FILE, archived);

  console.log(`\n[RerunCSV] ════════════════════════════════════════`);
  console.log(`[RerunCSV] RERUN COMPLETE`);
  console.log(`[RerunCSV]   Records            : ${records.length}`);
  console.log(`[RerunCSV]   Membership/Student : ${membership.length}`);
  console.log(`[RerunCSV]   Exam/Other         : ${exam.length}`);
  console.log(`[RerunCSV]   Passed             : ${passed.length}`);
  console.log(`[RerunCSV]   Failed             : ${failed.length}`);
  console.log(`[RerunCSV]   Duration           : ${durationMs}ms`);
  console.log(`[RerunCSV]   Output dir         : ${runDir}`);
  console.log(`[RerunCSV]   Source archived to : ${archived}`);
  console.log(`[RerunCSV] ════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error(`[RerunCSV] Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
