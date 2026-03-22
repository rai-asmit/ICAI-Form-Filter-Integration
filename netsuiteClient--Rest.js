/**
 * NetSuite REST Example – Query Customers (SuiteQL + Pagination) & Create Sales Order
 * Auth: OAuth 1.0a (HMAC-SHA256)
 */

const OAuth = require("oauth-1.0a");
const crypto = require("crypto");
const axios = require("axios");
require("dotenv").config();

// ─────────────────────────────────────────────
// 🔧 CONFIGURATION
// ─────────────────────────────────────────────
// const ACCOUNT_ID = process.env.; // ← replace with your account ID
const BASE_URL = process.env.NS_BASE_URL || `https://5003897-sb1.suitetalk.api.netsuite.com/services/rest`;
const REALM = process.env.NS_ACCOUNT;

// load credentials from env vars
const oauth = OAuth({
  consumer: {
    key: process.env.NS_CONSUMER_KEY,
    secret: process.env.NS_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA256",
  hash_function(base_string, key) {
    return crypto.createHmac("sha256", key).update(base_string).digest("base64");
  },
});

const token = {
  key: process.env.NS_TOKEN_ID,
  secret: process.env.NS_TOKEN_SECRET,
};

// ─────────────────────────────────────────────
// 🔹 Generic REST request helper
// ─────────────────────────────────────────────
async function netsuiteRequest(method, endpoint, body = null) {
  // If endpoint already starts with /services/rest, and BASE_URL ends with it, let's fix the double path
  let finalEndpoint = endpoint;
  if (BASE_URL.endsWith('/services/rest') && endpoint.startsWith('/services/rest')) {
    finalEndpoint = endpoint.replace('/services/rest', '');
  }
  const url = `${BASE_URL}${finalEndpoint}`;
  const requestData = { url, method };

  const headers = {
    ...oauth.toHeader(oauth.authorize(requestData, token)),
    realm: process.env.NS_ACCOUNT,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "transient",
  };

  headers.Authorization = headers.Authorization.replace(
    /^OAuth /,
    `OAuth realm="${REALM}", `
  );

  const config = { method, url, headers };
  if (body) config.data = JSON.stringify(body);

  try {
    const res = await axios(config);

    if (res.status === 204 && res.headers['location']) {
      const respData = { ...res.data, id: res.headers['location'].split('/').pop() };
      return respData
    }
    else {
      return res.data;
    }


  } catch (err) {
    console.error("NetSuite API Error:", err.response?.data || err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
// 🔹 SuiteQL query (with pagination support)
// ─────────────────────────────────────────────
async function queryCustomerByEntityIdBulk(entityIds, limit = 100, offset = 0) {
  if (!entityIds?.length) throw new Error("Customer Id list cannot be empty.");

  const entityIdList = entityIds.map((e) => `'${e}'`).join(",");
  const query = ` SELECT id, entityid, email FROM customer WHERE entityId IN (${entityIdList}) ORDER BY id`;

  const endpoint =
    `/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;

  return netsuiteRequest("POST", endpoint, { q: query });
}


// 🌀 Auto-pagination until all results are fetched
async function fetchAllCustomers(entityIds, limit = 100) {
  let all = [];
  let offset = 0;

  while (true) {
    console.log(`Executing fetchAllCustomers with entityIds:`, entityIds);
    const res = await queryCustomerByEntityIdBulk(entityIds, limit, offset);
    console.log(`Raw query result:`, res);
    const items = res.items || [];
    all = all.concat(items);

    console.log(`Fetched ${items.length} customers (offset=${offset})`);

    // SuiteQL REST returns `hasMore` if more results exist
    if (!res.hasMore || items.length < limit) break;

    offset += limit;
  }

  return all;
}


// ─────────────────────────────────────────────
// 🔹 Create Sales Order
// ─────────────────────────────────────────────
async function createSalesOrder(data) {
  const salesOrderNSData = data;

  return netsuiteRequest("POST", `/services/rest/record/v1/salesOrder`, salesOrderNSData);
}


/**
 * Create Invoice for Sales Order
 * JSON structure based on NetSuite REST API schema gainst the salesOrder record.
 * https://www.netsuite.com/portal/developers/resources/apis/rest-api/schema-records/invoice.shtml

{
  "salesorder": { "id": "5298034" },
  "item": [
    {
      "item": { "id": "12345" },
      "quantity": 2,
      "rate": 100.00
    }
  ],
  "memo": "Invoice created via REST API",
  "location": { "id": "1" }
}
 */

async function createTransFormRecordInvoice(salesOrderId, body = {}) {
  return netsuiteRequest("POST", `/services/rest/record/v1/salesOrder/${salesOrderId}/!transform/invoice`, body);
}

// /***
//  * Customer Deposit (COMMENTED OUT — replaced by Customer Payment)
//  * JSON structure based on NetSuite REST API schema gainst the salesOrder record.
//  * https://www.netsuite.com/portal/developers/resources/apis/rest-api/schema-records/customerDeposit.shtml
//
// {
//   "salesorder": { "id": "5298034" },
//   "payment": 500.00,
//   "memo": "Deposit created via REST API"
// }
//
//  */
//
//
// async function createCustomerDeposit(data) {
//   const customerDepositNSData = data;
//
//   return netsuiteRequest("POST", `/services/rest/record/v1/customerDeposit`, customerDepositNSData);
// }

/***
 * Customer Payment
 * Replaces Customer Deposit — directly settles open invoices.
 * Uses autoApply: true to auto-match against oldest open invoices.
 * https://www.netsuite.com/portal/developers/resources/apis/rest-api/schema-records/customerPayment.shtml
 *
 * {
 *   "customer": { "id": "12345", "type": "customer" },
 *   "payment": 500.00,
 *   "autoApply": true,
 *   "memo": "Payment created via REST API"
 * }
 */
async function createCustomerPayment(data) {
  return netsuiteRequest("POST", `/services/rest/record/v1/customerPayment`, data);
}

// ─────────────────────────────────────────────
// 🚀 MAIN
// ─────────────────────────────────────────────
// (async () => {
//   try {
//     // example customer emails to query
//     const emails = ["KUSHALKABRA4@GMAIL.COM", "CKUMARDEV@GMAIL.COM"];
//     const customers = await fetchAllCustomers(emails, 100);
//     console.log("Fetched customers:", customers.length);

//     // mock mapping external → NetSuite internal IDs
//     const customerMap = { "CUST-123": 56789 };

//     // example sales order input
//     const data = {
//       Customer_ID: "CUST-123",
//       Payment_Date: "29/10/2025",
//       Reference_Number: "INV-2025-0001",
//       Quantity: "2",
//       Payment_Amount: "450.75",
//     };

//     const newOrder = await createSalesOrder(data, customerMap);
//     console.log("Created Sales Order:", JSON.stringify(newOrder, null, 2));
//   } catch (err) {
//     console.error("Fatal Error:", err.response?.data || err.message);
//   }
// })();

module.exports = {
  fetchAllCustomers,
  createSalesOrder,
  netsuiteRequest,
  // createCustomerDeposit,  // COMMENTED OUT — replaced by Customer Payment
  createCustomerPayment,
  createTransFormRecordInvoice
};
