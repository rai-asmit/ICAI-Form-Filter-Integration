"use strict";

/**
 * syncFormBasedTransactions.js — Unified Orchestrator
 *
 * Single entry point that:
 *   1. Authenticates with ICAI once
 *   2. Fetches ALL transactions once
 *   3. Saves raw transactions to transaction.json
 *   4. Splits by form type:
 *      - Membership/Student forms → syncMembershipStudent processor
 *      - Exam/Other forms → syncExamEnrollment processor
 *   5. Returns combined results
 */

require("dotenv").config();
const { Mutex } = require("async-mutex");

const { getToken, fetchTransactions } = require("./membership/icaiClient");
const { getAllAllowedForms } = require("./membership/helpers");
const stateManager = require("./membership/stateManager");
const { runMembershipStudentSync } = require("./syncMembershipStudent");
const { runExamEnrollmentSync } = require("./syncExamEnrollment");

const syncMutex = new Mutex();

async function runFormBasedSync({ integrationId, fromDate, toDate } = {}) {
  if (syncMutex.isLocked()) {
    console.log("[FormSync] Sync already running — request cancelled.");
    return {
      success: false,
      message: "Form-based sync already in progress. Try again later.",
    };
  }

  const release = await syncMutex.acquire();
  const startTime = Date.now();

  try {
    // ── 1. Initialize daily data directory ────────────────────────────────
    const dailyDir = stateManager.getDailyDir();
    console.log(`[FormSync] Daily data directory: ${dailyDir}`);

    // ── 2. Get token (uses cache or authenticates fresh) ──────────────────
    const tokenid = await getToken();

    // ── 3. Fetch ALL transactions (once) ──────────────────────────────────
    if (fromDate && toDate) {
      console.log(`[FormSync] Using date range from request — fromDate: ${fromDate} | toDate: ${toDate}`);
    }
    const allTransactions = await fetchTransactions(tokenid, { fromDate, toDate });
    console.log(`[FormSync] Total fetched from ICAI: ${allTransactions.length}`);

    // Save all raw transactions
    stateManager.writeFile(dailyDir, "transaction.json", allTransactions);
    console.log(`[FormSync] Saved ${allTransactions.length} raw transactions to transaction.json`);

    if (allTransactions.length === 0) {
      return {
        success: true,
        message: "No transactions fetched from ICAI",
        totalFetched: 0,
        membership: { processed: 0 },
        examination: { processed: 0 },
      };
    }

    // ── 4. Split transactions by form type ────────────────────────────────
    const allowedForms = getAllAllowedForms();

    const membershipTransactions = allTransactions.filter((t) =>
      allowedForms.includes(t.Form_Description)
    );
    const examTransactions = allTransactions.filter(
      (t) => !allowedForms.includes(t.Form_Description)
    );

    console.log(
      `[FormSync] Membership/Student: ${membershipTransactions.length} | Exam/Other: ${examTransactions.length}`
    );

    if (membershipTransactions.length > 0) {
      const membershipForms = [...new Set(membershipTransactions.map((t) => t.Form_Description))];
      console.log(`[FormSync] Membership form types: ${membershipForms.join(", ")}`);
    }
    if (examTransactions.length > 0) {
      const examForms = [...new Set(examTransactions.map((t) => t.Form_Description))];
      console.log(`[FormSync] Exam/Other form types: ${examForms.join(", ")}`);
    }

    // ── 5. Process membership/student transactions ────────────────────────
    console.log(`\n[FormSync] ═══ Starting Membership/Student Processing ═══`);
    const membershipResult = await runMembershipStudentSync({
      integrationId,
      transactions: membershipTransactions,
    });
    console.log(`[FormSync] Membership/Student done — processed: ${membershipResult.processed || 0}, failed: ${membershipResult.failed || 0}`);

    // ── 6. Process exam/other transactions ────────────────────────────────
    console.log(`\n[FormSync] ═══ Starting Exam/Other Processing ═══`);
    const examResult = await runExamEnrollmentSync({
      integrationId,
      transactions: examTransactions,
    });
    console.log(`[FormSync] Exam/Other done — processed: ${examResult.processed || 0}, failed: ${examResult.failed || 0}`);

    // ── 7. Combined summary ──────────────────────────────────────────────
    const durationMs = Date.now() - startTime;
    const totalProcessed = (membershipResult.processed || 0) + (examResult.processed || 0);
    const totalFailed = (membershipResult.failed || 0) + (examResult.failed || 0);

    console.log(`\n[FormSync] ════════════════════════════════════════`);
    console.log(`[FormSync] COMBINED SYNC COMPLETE`);
    console.log(`[FormSync]   Total Fetched         : ${allTransactions.length}`);
    console.log(`[FormSync]   Membership/Student    : ${membershipTransactions.length}`);
    console.log(`[FormSync]   Exam/Other            : ${examTransactions.length}`);
    console.log(`[FormSync]   Total Processed       : ${totalProcessed}`);
    console.log(`[FormSync]   Total Failed          : ${totalFailed}`);
    console.log(`[FormSync]   Duration              : ${durationMs}ms`);
    console.log(`[FormSync] ════════════════════════════════════════\n`);

    return {
      success: true,
      message: `Processed ${totalProcessed} transactions successfully, ${totalFailed} failed`,
      totalFetched: allTransactions.length,
      membershipCount: membershipTransactions.length,
      examCount: examTransactions.length,
      totalProcessed,
      totalFailed,
      durationMs,
      membership: membershipResult,
      examination: examResult,
    };
  } catch (err) {
    console.error("[FormSync] Fatal error:", err);
    throw err;
  } finally {
    release();
  }
}

module.exports = { runFormBasedSync };
