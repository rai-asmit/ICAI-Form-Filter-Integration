"use strict";

/**
 * rerunFailedDeposits.js — Rerun records from a customer-deposit-failure.json.
 *
 * Flow:
 *   1. Read the failure JSON directly (records are self-contained — no mapping
 *      back to April-Records-April.json is performed).
 *   2. Strip the failure metadata (`success`, `timestamp`, `reason`) from each
 *      record so what we hand to the processors looks like a fresh transaction.
 *   3. Classify into membership/student vs. exam by Form_Description, fetch
 *      customers, and run through the same processors the main pipeline uses.
 *   4. Per-step logs + summary go to rerun/failure-runs/<timestamp>/. The
 *      original failure file is left untouched.
 *
 * Run: node rerunFailedDeposits.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit").default;

const { fetchAllCustomers } = require("./netsuiteClient--Rest");
const { processTransaction: processMembership } = require("./syncMembershipStudent");
const { processTransaction: processExam } = require("./syncExamEnrollment");
const { getAllAllowedForms, getConfigForForm } = require("./membership/helpers");

const CONCURRENCY_LIMIT = 40;
const CUSTOMER_BATCH_SIZE = 50;

const SOURCE_FAILURE_JSON = path.join(
  __dirname,
  "rerun",
  "runs",
  "2026-05-15T11-22-04-461Z",
  "customer-deposit-failure.json"
);
const RUNS_ROOT = path.join(__dirname, "rerun", "failure-runs");

// Fields appended by the original run that must be stripped before reprocessing.
const FAILURE_META_KEYS = ["success", "timestamp", "reason"];

function sanitize(record) {
  const clean = { ...record };
  for (const k of FAILURE_META_KEYS) delete clean[k];
  return clean;
}

function loadFailedRecords() {
  if (!fs.existsSync(SOURCE_FAILURE_JSON)) {
    throw new Error(`Failure JSON not found at ${SOURCE_FAILURE_JSON}`);
  }
  const arr = JSON.parse(fs.readFileSync(SOURCE_FAILURE_JSON, "utf8"));
  if (!Array.isArray(arr)) throw new Error(`${SOURCE_FAILURE_JSON} is not a JSON array`);
  return arr.map(sanitize);
}

async function main() {
  const startTime = Date.now();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(RUNS_ROOT, ts);
  fs.mkdirSync(runDir, { recursive: true });

  console.log(`\n[RerunFailures] ════════════════════════════════════════`);
  console.log(`[RerunFailures] Source:     ${SOURCE_FAILURE_JSON}`);
  console.log(`[RerunFailures] Output dir: ${runDir}`);
  console.log(`[RerunFailures] ════════════════════════════════════════\n`);

  const records = loadFailedRecords();
  console.log(`[RerunFailures] Failed records loaded: ${records.length}`);
  if (records.length === 0) {
    console.log(`[RerunFailures] Nothing to do.`);
    return;
  }

  // Snapshot the sanitized input alongside logs so the run is reproducible.
  fs.writeFileSync(
    path.join(runDir, "input.json"),
    JSON.stringify(records, null, 2),
    "utf-8"
  );

  const allowedForms = getAllAllowedForms();
  const membership = records.filter(t => allowedForms.includes(t.Form_Description));
  const exam = records.filter(t => !allowedForms.includes(t.Form_Description));
  console.log(`[RerunFailures] Membership/Student: ${membership.length} | Exam/Other: ${exam.length}`);

  const uniqueCustomerIds = [...new Set(records.map(t => t.Customer_ID).filter(Boolean))];
  console.log(`[RerunFailures] Fetching ${uniqueCustomerIds.length} customers from NetSuite...`);
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
  console.log(`[RerunFailures] Resolved ${Object.keys(customerMap).length}/${uniqueCustomerIds.length} customers`);

  const limit = pLimit(CONCURRENCY_LIMIT);
  const passed = [];
  const failed = [];

  const membershipTasks = membership.map((t, i) => limit(async () => {
    const cfg = getConfigForForm(t.Form_Description);
    console.log(`\n[RerunFailures] ── [M ${i + 1}/${membership.length}] ${t.Reference_Number} (${t.Form_Description}) ──`);
    const r = await processMembership(t, customerMap, cfg, runDir);
    if (r.success) passed.push({ reference: t.Reference_Number, form: t.Form_Description });
    else failed.push({ reference: t.Reference_Number, form: t.Form_Description, reason: r.error || "unknown" });
  }));

  const examTasks = exam.map((t, i) => limit(async () => {
    console.log(`\n[RerunFailures] ── [E ${i + 1}/${exam.length}] ${t.Reference_Number} (${t.Form_Description}) ──`);
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
    sourceFailureJson: SOURCE_FAILURE_JSON,
    outputDir: runDir,
    counts: {
      total: records.length,
      membership: membership.length,
      exam: exam.length,
      passed: passed.length,
      failed: failed.length,
    },
    passed,
    failed,
  };
  fs.writeFileSync(path.join(runDir, "rerun-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  console.log(`\n[RerunFailures] ════════════════════════════════════════`);
  console.log(`[RerunFailures] RERUN COMPLETE`);
  console.log(`[RerunFailures]   Total failed records : ${records.length}`);
  console.log(`[RerunFailures]   Membership/Student   : ${membership.length}`);
  console.log(`[RerunFailures]   Exam/Other           : ${exam.length}`);
  console.log(`[RerunFailures]   Passed               : ${passed.length}`);
  console.log(`[RerunFailures]   Failed               : ${failed.length}`);
  console.log(`[RerunFailures]   Duration             : ${durationMs}ms`);
  console.log(`[RerunFailures]   Output dir           : ${runDir}`);
  console.log(`[RerunFailures] ════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error(`[RerunFailures] Fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
