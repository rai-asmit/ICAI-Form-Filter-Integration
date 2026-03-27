"use strict";

require("dotenv").config();
const axios = require("axios");

const AUTH_URL = process.env.AUTH_URL;
const SERVICE_URL = process.env.SERVICE_URL;

// ── Token Manager ─────────────────────────────────────────────────────────────
let _cachedToken = null;

/**
 * Checks if an API response indicates the token has expired or is invalid.
 */
function isTokenExpired(data) {
  const raw = typeof data === "string" ? data : "";
  const msg = (data?.Response_Message || data?.message || raw).toLowerCase();
  return (
    msg.includes("token") &&
    (msg.includes("expire") || msg.includes("invalid") || msg.includes("no token")) ||
    msg.includes("unauthorized") ||
    msg.includes("session expired")
  );
}

async function authenticate() {
  console.log("[MembershipSync] Authenticating with ICAI...");

  const params = new URLSearchParams();
  params.append("usrloginid", process.env.USR_LOGIN_ID);
  params.append("usrpassword", process.env.USR_PASSWORD);

  const { data } = await axios.post(AUTH_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 60000,
    validateStatus: () => true,
  });

  const raw = typeof data === "string" ? data : JSON.stringify(data);

  // The auth endpoint returns XML like:
  //   <RESPONSE><RESULT STATUS='1' TOKENID='abc123' MSG='Success'/></RESPONSE>
  // or on failure:
  //   <RESPONSE><RESULT STATUS='0' TOKENID='0' MSG='Invalid User...'/></RESPONSE>
  if (typeof data === "string" && data.includes("<RESULT")) {
    const statusMatch = data.match(/STATUS\s*=\s*'([^']*)'/i);
    const tokenMatch = data.match(/TOKENID\s*=\s*'([^']*)'/i);
    const msgMatch = data.match(/MSG\s*=\s*'([^']*)'/i);

    const status = statusMatch ? statusMatch[1] : null;
    const tokenid = tokenMatch ? tokenMatch[1] : null;
    const msg = msgMatch ? msgMatch[1] : raw;

    if (status !== "1" || !tokenid || tokenid === "0") {
      throw new Error(`ICAI Auth failed: ${msg}`);
    }

    console.log(`[MembershipSync] Auth OK — tokenid: ${tokenid}`);
    _cachedToken = tokenid;
    return tokenid;
  }

  // Fallback: try JSON parsing
  let parsed;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(`ICAI Auth failed: unexpected response — ${raw}`);
    }
  } else {
    parsed = data;
  }

  if (parsed.status === "false" || !parsed.tokenid) {
    throw new Error(`ICAI Auth failed: ${parsed.message || raw}`);
  }

  console.log(`[MembershipSync] Auth OK — tokenid: ${parsed.tokenid}`);
  _cachedToken = parsed.tokenid;
  return parsed.tokenid;
}

/**
 * Returns a valid token — uses cached token if available, otherwise authenticates.
 * Pass forceRefresh=true to discard the cached token and get a new one.
 */
async function getToken(forceRefresh = false) {
  if (_cachedToken && !forceRefresh) {
    console.log("[MembershipSync] Using cached token");
    return _cachedToken;
  }
  return authenticate();
}

async function fetchTransactions(tokenid) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateFilter = `${String(yesterday.getDate()).padStart(2, "0")}/${String(yesterday.getMonth() + 1).padStart(2, "0")}/${yesterday.getFullYear()}`;

  const fromDate = dateFilter;
  const toDate = dateFilter;

  const NUMBER_OF_RECORDS = 800;
  const DELAY_MS = 3000;
  const FETCH_RETRIES = 3;
  const MAX_TOKEN_REFRESHES = 2;

  let currentToken = tokenid;
  let allTransactions = [];
  let data_offset = 0;
  let batchNumber = 1;
  let tokenRefreshCount = 0;

  console.log(`[MembershipSync] Fetching transactions | fromDate: ${fromDate} | toDate: ${toDate}`);

  while (true) {
    console.log(`[MembershipSync] Batch ${batchNumber} | offset: ${data_offset}`);

    const params = new URLSearchParams();
    params.append("orgId", process.env.ORG_ID);
    params.append("tokenid", currentToken);
    params.append("serviceCalled", process.env.SERVICE_CALLED);
    params.append("actionId", process.env.ACTION_ID);
    params.append("getDetail", process.env.GET_DETAIL_TRANSACTIONS);
    params.append("fromDate", fromDate);
    params.append("toDate", toDate);
    params.append("number_of_records", NUMBER_OF_RECORDS);
    params.append("data_offset", data_offset);

    let response = null;
    for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
      try {
        response = await axios.post(SERVICE_URL, params.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 120000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          maxRedirects: 5,
        });
        break;
      } catch (err) {
        console.error(
          `[MembershipSync] Batch ${batchNumber} attempt ${attempt}/${FETCH_RETRIES} failed: ${err.message}`
        );
        if (attempt < FETCH_RETRIES) {
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    if (!response) {
      console.error(
        `[MembershipSync] Batch ${batchNumber} failed after ${FETCH_RETRIES} attempts — stopping`
      );
      break;
    }

    const data = response.data;

    // ── Token expiry detection & auto-refresh ──────────────────────────────
    if (isTokenExpired(data) && tokenRefreshCount < MAX_TOKEN_REFRESHES) {
      tokenRefreshCount++;
      console.log(
        `[MembershipSync] Token expired during fetch — refreshing (attempt ${tokenRefreshCount}/${MAX_TOKEN_REFRESHES})...`
      );
      currentToken = await getToken(true);

      // Retry the same batch with the new token (don't increment offset)
      console.log(`[MembershipSync] Token refreshed — retrying batch ${batchNumber}`);
      continue;
    }

    const message = (data?.Response_Message || "").toLowerCase();
    if (message.includes("offset")) {
      console.log("[MembershipSync] Portal offset limit reached — stopping");
      break;
    }

    let transactions = [];
    if (data?.Data && Array.isArray(data.Data)) {
      transactions = data.Data;
    } else if (Array.isArray(data)) {
      transactions = data;
    }

    if (transactions.length === 0) {
      console.log(
        `[MembershipSync] No records at offset ${data_offset} — all data fetched`
      );
      break;
    }

    allTransactions = allTransactions.concat(transactions);
    console.log(
      `[MembershipSync] Batch ${batchNumber}: ${transactions.length} records | Total: ${allTransactions.length}`
    );

    data_offset += NUMBER_OF_RECORDS;
    batchNumber++;
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(
    `[MembershipSync] Fetch complete. Total records: ${allTransactions.length}`
  );
  return allTransactions;
}

module.exports = { authenticate, fetchTransactions, getToken };
