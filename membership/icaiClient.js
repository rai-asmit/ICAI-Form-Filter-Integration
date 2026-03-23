"use strict";

require("dotenv").config();
const axios = require("axios");

const SERVICE_URL = process.env.SERVICE_URL;

async function authenticate() {
  console.log("[MembershipSync] Authenticating with ICAI...");

  const params = new URLSearchParams();
  params.append("orgId", process.env.ORG_ID);
  params.append("userName", process.env.USER_NAME);
  params.append("password", process.env.PASSWORD);
  params.append("serviceCalled", process.env.SERVICE_CALLED);
  params.append("actionId", process.env.AUTH_ACTION_ID);

  const { data } = await axios.post(SERVICE_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  if (parsed.status === "false" || !parsed.tokenid) {
    throw new Error(`ICAI Auth failed: ${parsed.message}`);
  }

  console.log(`[MembershipSync] Auth OK — tokenid: ${parsed.tokenid}`);
  return parsed.tokenid;
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

  let allTransactions = [];
  let data_offset = 0;
  let batchNumber = 1;

  console.log(`[MembershipSync] Fetching transactions | fromDate: ${fromDate} | toDate: ${toDate}`);

  while (true) {
    console.log(`[MembershipSync] Batch ${batchNumber} | offset: ${data_offset}`);

    const params = new URLSearchParams();
    params.append("orgId", process.env.ORG_ID);
    params.append("tokenid", tokenid);
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

module.exports = { authenticate, fetchTransactions };
