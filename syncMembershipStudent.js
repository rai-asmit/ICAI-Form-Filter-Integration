"use strict";

/**
 * syncMembershipStudent.js
 *
 * Handles processing for:
 *   - Form 2   (New Membership)        → Duplicate Customer + SO + CD + Invoice + JV + DepositApp
 *   - Form 6   (COP Application)       → SO + CD + Invoice + JV (if contributions) + DepositApp
 *   - Form 3/Fellowship                → SO + CD + Invoice + JV (if contributions) + DepositApp
 *   - Student Registration Form        → SO + CD + Invoice + DepositApp (no JV — no contributions)
 *
 * Fee head classification:
 *   - Regular + Discount items (M05, M06, M07, M08, M09, M10, M99) → Sales Order & Invoice
 *   - Contribution items (M15, M18, M23, M22, M13) → Journal Voucher (Debit 2724, Credit 2764)
 *   - Customer Deposit captures FULL payment amount (all items + tax)
 *
 * Key differences from existing exam flow:
 *   - Multiple line items per SO (fee heads parsed individually)
 *   - Tax (18%) calculated and passed per line item
 *   - Invoice created immediately via SO transform (not via cron)
 *   - Deposit Application applied to close invoice
 *   - Form 2 creates a duplicate customer (Student → Member, category=1)
 *   - Different subsidiary (168 Delhi for membership, 170 Noida for student)
 *   - Different location (285/287), department (267), class (123)
 *
 * INDEPENDENT of existing exam flow — does not modify icaiSync.js or syncSalesOrderAndDeposit.js
 */

require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const pLimit = require("p-limit").default;
const { Mutex } = require("async-mutex");

const {
  netsuiteRequest,
  fetchAllCustomers,
  createSalesOrder,
  createCustomerDeposit,
  createTransFormRecordInvoice,
} = require("./netsuiteClient--Rest");

const msConfig = require("./membershipStudentConfig.json");

// ─── Mutex — one run at a time ───────────────────────────────────────────────
const syncMutex = new Mutex();

// ─── Constants ───────────────────────────────────────────────────────────────
const CONCURRENCY_LIMIT = 5;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000;

// ═══════════════════════════════════════════════════════════════════════════════
// ICAI AUTHENTICATION & FETCH 
// ═══════════════════════════════════════════════════════════════════════════════

const AUTH_URL = "https://eservices.icai.org/iONBizServices/Authenticate";
const SERVICE_URL = "https://eservices.icai.org/EForms/CustomWebserviceServlet";

let cachedToken = null;
let tokenExpiry = null;

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

async function authenticate() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry - 30000) {
    console.log("[MembershipSync] Using cached token");
    return cachedToken;
  }

  console.log("[MembershipSync] Authenticating with ICAI...");
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
    throw new Error(`ICAI Auth failed: ${parsed.message}`);
  }

  cachedToken = parsed.tokenId;
  tokenExpiry = Date.now() + 4 * 60 * 1000;
  console.log("[MembershipSync] Token obtained");
  return cachedToken;
}

async function fetchTransactions(tokenid) {
  // Auto date: yesterday (date - 1) in DD/MM/YYYY format
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const autoDate = `${String(yesterday.getDate()).padStart(2, "0")}/${String(yesterday.getMonth() + 1).padStart(2, "0")}/${yesterday.getFullYear()}`;

  // const fromDate = autoDate;
  // const toDate = autoDate;
  const fromDate = process.env.FROM_DATE || "12/03/2026";
  const toDate = process.env.TO_DATE || fromDate;

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

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function parseDateDDMMYYYY(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const parts = dateStr.split("/");
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function getMonthYear(dateString) {
  if (!dateString) return null;
  const parts = dateString.split("-");
  if (parts.length < 2) return null;
  const yyyy = parts[0];
  const mm = parseInt(parts[1], 10);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[mm - 1]} ${yyyy}`;
}

function toSelectField(value) {
  if (value == null) return null;
  if (typeof value === "object" && (value.id || value.refName)) return value;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return { id: text };
  return { refName: text };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "object") {
      if (value.id || value.refName) return value;
      continue;
    }
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}


// ─── Tax constants ───────────────────────────────────────────────────────────
const TAX_RATE = 18;
const GST_RATE_ID = "4"; // 18% GST rate in NetSuite

function parseFeeHeads(feeHeadArray) {
  if (!Array.isArray(feeHeadArray)) return [];

  return feeHeadArray
    .map((entry, index) => {
      const n = index + 1;
      let code = entry[`FeeHeadCode${n}`] || null;
      let description = entry[`FeeHead${n}`] || "";
      let amount = parseFloat(entry[`FeeAmount${n}`]) || 0;

      // Fallback: if numbered keys don't match position, scan for any FeeHeadCode key
      if (!code) {
        for (const key of Object.keys(entry)) {
          if (key.startsWith("FeeHeadCode")) {
            const num = key.replace("FeeHeadCode", "");
            code = entry[key];
            description = entry[`FeeHead${num}`] || "";
            amount = parseFloat(entry[`FeeAmount${num}`]) || 0;
            break;
          }
        }
      }

      if (!code) return null;
      return { code, description, amount };
    })
    .filter(Boolean);
}

/**
 * Split parsed fee heads into invoice items (Regular + Discount) vs contribution items.
 * Contribution items go to JV, NOT to SO/Invoice.
 */
function classifyFeeHeads(allFeeHeads, contributionCodes) {
  const invoiceItems = [];
  const contributionItems = [];

  for (const fh of allFeeHeads) {
    if (contributionCodes.includes(fh.code)) {
      contributionItems.push(fh);
    } else {
      invoiceItems.push(fh);
    }
  }

  return { invoiceItems, contributionItems };
}

/**
 * Determine which config section applies based on Form_Description.
 * Returns null if form is not handled by this sync.
 */
function getConfigForForm(formDescription) {
  if (!formDescription) return null;

  if (msConfig.membership.allowed_forms.includes(formDescription)) {
    return { type: "membership", ...msConfig.membership };
  }
  if (msConfig.student_registration.allowed_forms.includes(formDescription)) {
    return { type: "student_registration", ...msConfig.student_registration };
  }
  return null;
}

function getAllAllowedForms() {
  return [
    ...msConfig.membership.allowed_forms,
    ...msConfig.student_registration.allowed_forms,
  ];
}

// ─── Retry wrapper ───────────────────────────────────────────────────────────
async function withRetry(fn, label = "") {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isRetryable =
        status === 429 || status === 503 || status === 504 || !status;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY * Math.pow(2, attempt - 1);
        console.warn(
          `[Retry] ${label} attempt ${attempt}/${MAX_RETRIES} failed (HTTP ${status ?? "network"}). Retrying in ${delay}ms...`
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NETSUITE OPERATIONS 
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchCustomerByEntityId(entityId) {
  // Step 1: Get internal ID via SuiteQL
  const safeId = entityId.replace(/'/g, "''");
  const result = await netsuiteRequest(
    "POST",
    "/services/rest/query/v1/suiteql?limit=1",
    { q: `SELECT id FROM customer WHERE entityid = '${safeId}'` }
  );
  const row = result.items?.[0];
  if (!row) return null;

  // Step 2: Fetch FULL customer record via REST GET
  const fullRecord = await netsuiteRequest(
    "GET",
    `/services/rest/record/v1/customer/${row.id}?expandSubResources=true`
  );
  return fullRecord;
}

async function createCustomerRecord(data) {
  return netsuiteRequest("POST", "/services/rest/record/v1/customer", data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILDERS — Sales Order, Customer Deposit, Invoice
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build Sales Order payload.
 * ONLY Regular + Discount items go on the SO. Contribution items are excluded.
 * Tax (18%) is calculated and passed explicitly per line item.
 */
function buildSalesOrderData(
  transaction,
  customerInternalId,
  invoiceFeeHeads,
  formConfig
) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);
  const hsnCode = firstNonEmpty(transaction.HSN_SAC_Code);
  const hsnInternalId = firstNonEmpty(
    formConfig.hsn_code_internal_id,
    hsnCode && formConfig.hsn_code_map ? formConfig.hsn_code_map[hsnCode] : null,
    hsnCode === "9995" ? "1377" : null
  );
  const gstPosField = toSelectField(
    firstNonEmpty(
      transaction.GST_POS_ID,
      transaction.GST_POS,
      formConfig.gst_pos_id,
      formConfig.gst_pos_name
    )
  );
  const billAddressValue = firstNonEmpty(
    transaction.BILLADDRESSLIST_ID,
    transaction.billaddresslist,
    formConfig.billaddresslist_id
  );
  const billAddressList = (billAddressValue && typeof billAddressValue === "object")
    ? firstNonEmpty(billAddressValue.id, billAddressValue.refName)
    : billAddressValue;
  const entityTaxRegField = toSelectField(
    firstNonEmpty(
      transaction.ENTITYTAXREGNUMBER_ID,
      transaction.entitytaxregnumber,
      formConfig.entitytaxregnumber_id,
      formConfig.entitytaxregnumber_name
    )
  );
  const remarks = firstNonEmpty(
    transaction.Remarks,
    transaction.custbody_remarks,
    transaction.Financial_Year ? `FY ${transaction.Financial_Year}` : null
  );

  const lineItems = [];
  const unmappedItems = [];
  let subtotal = 0;
  let taxTotal = 0;

  for (const feeHead of invoiceFeeHeads) {
    const itemDef = formConfig.items[feeHead.code];
    const internalId = itemDef?.internal_id;

    if (!internalId) {
      unmappedItems.push(feeHead.code);
      console.warn(
        `[MembershipSync] Item ${feeHead.code} (${feeHead.description}) has no internal ID — skipping SO line`
      );
      continue;
    }

    const amount = feeHead.amount;
    const taxAmount = (amount * TAX_RATE) / 100;
    const grossAmount = amount + taxAmount;
    subtotal += amount;
    taxTotal += taxAmount;

    lineItems.push({
      item: { id: String(internalId) },
      quantity: 1,
      rate: amount,
      amount: amount,
      tax1amt: taxAmount,
      grossamt: grossAmount,
      description: feeHead.description,
      custcol_in_nature_of_item: { id: "3" },
      custcol_in_gst_rate: { id: GST_RATE_ID },
      ...(hsnInternalId ? { custcol_in_hsn_code: { id: String(hsnInternalId) } } : {}),
      department: { id: formConfig.department_id },
      ...(formConfig.class_id
        ? { class: { id: formConfig.class_id } }
        : {}),
    });
  }

  if (lineItems.length === 0) {
    console.error(
      `[MembershipSync] No valid line items for SO — Ref: ${transaction.Reference_Number}`
    );
    return null;
  }

  if (unmappedItems.length > 0) {
    console.warn(
      `[MembershipSync] Unmapped items (need internal IDs in membershipStudentConfig.json): ${unmappedItems.join(", ")}`
    );
  }

  return {
    entity: { id: String(customerInternalId), type: "customer" },
    tranDate,
    custbody_in_return_form_period: { refName: getMonthYear(tranDate) },
    memo: transaction.Payment_Order_Id,
    custbody_inoday_payment_ref: transaction.Payment_Order_Id,
    custbody_ino_icai_reference_number: transaction.Reference_Number,
    custbody_ino_icai_utr: transaction.Reference_Number,
    custbody_ino_icai_source_portal: formConfig.source_portal || "SSP",
    custbody_ino_icai_source_portal_url:
      formConfig.source_portal_url || "https://eservices.icai.org/",
    custbodycreate_middleware: true,
    custbody_process_invoice: true,

    subsidiary: { id: formConfig.subsidiary_id },
    location: { id: formConfig.location_id },
    department: { id: formConfig.department_id },

    orderStatus: { id: "B" },

    // Header-level tax totals
    subtotal,
    taxtotal: taxTotal,
    total: subtotal + taxTotal,
    ...(gstPosField ? { custbody_in_gst_pos: gstPosField } : {}),
    ...(billAddressList ? { billaddresslist: billAddressList } : {}),
    ...(entityTaxRegField ? { entitytaxregnumber: entityTaxRegField } : {}),
    ...(remarks ? { custbody_remarks: remarks } : {}),

    item: { items: lineItems },
  };
}

/**
 * Build Customer Deposit payload.
 * Same pattern as syncSalesOrderAndDeposit.js — CD linked to the SO.
 * CD captures the FULL payment amount (includes contributions + tax).
 * GST split: if IGST present → IGST field, else split 50/50 CGST/SGST.
 */
function buildCustomerDepositData(soId, transaction, formConfig) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);

  const igst = parseFloat(transaction.IGST) || 0;
  const cgst = parseFloat(transaction.CGST) || 0;
  const sgst = parseFloat(transaction.SGST) || 0;
  const taxTotal = Number.parseFloat(transaction.Total_Tax);
  const mid = firstNonEmpty(transaction.MID);

  // GST split logic: if IGST present use it, else split CGST/SGST
  const gstFields = {};
  if (igst > 0) {
    gstFields.custbody_inoday_icai_igst_val = igst;
  } else if (cgst > 0 || sgst > 0) {
    gstFields.custbody_ino_icai_gst_value = cgst;
    gstFields.custbody_inoday_icai_sgst_val = sgst;
  }

  // Resolve CD account from MID mapping → fallback to config → fallback to 3341
  const midToAccount = msConfig.mid_to_account || {};
  const cdAccountId = (mid && midToAccount[mid])
    ? midToAccount[mid]
    : (msConfig.cd_fallback_account || formConfig.cd_account_id || "3341");

  if (mid && !midToAccount[mid]) {
    console.warn(
      `[MembershipSync] MID "${mid}" not found in mid_to_account mapping — using fallback account ${cdAccountId}`
    );
  }

  return {
    salesorder: { id: String(soId) },
    account: { id: String(cdAccountId) },
    payment: parseFloat(transaction.Payment_Amount) || 0,
    memo: transaction.Payment_Order_Id,
    tranDate,
    custbody_in_return_form_period: { refName: getMonthYear(tranDate) },
    custbody_inoday_payment_ref: transaction.Payment_Order_Id,
    custbody_ino_icai_reference_number: transaction.Reference_Number,
    custbodypayment_reference_number: transaction.Reference_Number,
    custbody_ino_icai_utr: transaction.Reference_Number,
    custbody_ino_icai_source_portal: formConfig.source_portal || "SSP",
    custbody_ino_icai_source_portal_url:
      formConfig.source_portal_url || "https://eservices.icai.org/",
    custbody40: true,
    ...(mid ? { custbody_icai_ino_mid: mid } : {}),
    ...(Number.isFinite(taxTotal)
      ? { custbody_ino_icai_taxtotal: taxTotal }
      : {}),
    department: { id: formConfig.department_id },
    location: { id: formConfig.location_id },
    ...(formConfig.class_id
      ? { class: { id: formConfig.class_id } }
      : {}),
    ...gstFields,
  };
}

/**
 * Build Invoice body for SO → Invoice transformation.
 * Uses the same transaction date as the SO.
 */
function buildInvoiceBody(transaction, formConfig) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);

  return {
    approvalStatus: { id: "2" },
    tranDate,
    custbody_in_return_form_period: { refName: getMonthYear(tranDate) },
    memo: transaction.Payment_Order_Id,
    custbodycreate_middleware: true,
    department: { id: formConfig.department_id },
    location: { id: formConfig.location_id },
    custbody_ino_icai_source_portal: formConfig.source_portal || "SSP",
    custbody_ino_icai_source_portal_url:
      formConfig.source_portal_url || "https://eservices.icai.org/",
  };
}

/**
 * Build Journal Voucher (JV) payload for contribution/fund items.
 * Debit: Account 2724 (total contribution amount) — single line
 * Credit: Account 2764 — one line per contribution item with vendor mapping
 *
 * eventSeminarType = 213, eventSeminarSubtype = 414 for all contribution items.
 */
function buildJournalEntryData(transaction, contributionItems, formConfig, customerInternalId, vendorMap) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);
  const totalContribution = contributionItems.reduce((sum, item) => sum + item.amount, 0);

  if (totalContribution <= 0) return null;

  const debitLine = {
    account: { id: formConfig.jv_debit_account },
    debit: totalContribution,
    memo: `Membership Contribution Debit - Customer ID ${customerInternalId}`,
    ...(customerInternalId
      ? { entity: { id: String(customerInternalId) } }
      : {}),
  };

  // Credit lines
  const creditLines = contributionItems
    .filter((item) => item.amount > 0)
    .map((item) => {
      const vendorInternalId = vendorMap?.[item.code] || null;
      return {
        account: { id: formConfig.jv_credit_account || "2764" },
        credit: item.amount,
        memo: `Membership Contribution Credit - ${item.description} - Customer ID ${customerInternalId}`,
        department: { id: 267 },
        location: { id: formConfig.location_id },
        ...(vendorInternalId ? { entity: { id: vendorInternalId } } : {}),
        // custcol_inoday_icai_type: { id: "213" },
        // custcol_ino_icia_duplicate_class: { id: "414" },
      };
    });

  return {
    approvalStatus: { id: "2" },
    tranDate,
    subsidiary: { id: formConfig.subsidiary_id },
    memo: `Membership Contribution - Customer ID ${customerInternalId}`,
    custbody_ino_icai_reference_number: transaction.Reference_Number,
    custbody_inoday_payment_ref: transaction.Payment_Order_Id,
    custbodypayment_reference_number: transaction.Reference_Number,
    custbody_ino_icai_source_portal: formConfig.source_portal || "SSP",
    custbody_ino_icai_source_portal_url:
      formConfig.source_portal_url || "https://eservices.icai.org/",
    line: { items: [debitLine, ...creditLines] },
  };
}

/**
 * Create Journal Entry via NetSuite REST API.
 */
async function createJournalEntry(data) {
  return netsuiteRequest("POST", "/services/rest/record/v1/journalEntry", data);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMER DUPLICATION (Form 2 only)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Form 2 — New Membership:
 *   1. Fetch existing customer by Customer_ID (category: Student)
 *   2. Create a duplicate customer with category: Member, copying all fields
 *   3. The new customer's entityid = Application_number from the transaction
 */
async function duplicateCustomerAsMember(customerEntityId, transaction) {
  console.log(
    `[MembershipSync] [Form 2] Fetching student customer: ${customerEntityId}`
  );

  const c = await fetchCustomerByEntityId(customerEntityId);
  if (!c) {
    throw new Error(`Student customer not found in NetSuite: ${customerEntityId}`);
  }

  const originalInternalId = c.id;
  const originalEntityId = c.entityId || c.entityid;
  console.log(
    `[MembershipSync] [Form 2] Found student: id=${originalInternalId}, entityid=${originalEntityId}`
  );

  const newEntityId = `${transaction.Customer_ID}-1`;

  // Helper: extract id from REST select field (returns { id, refName } or raw value)
  function pickId(field) {
    if (!field) return null;
    if (typeof field === "object" && field.id) return { id: String(field.id) };
    return field;
  }

  const gstin = c.custentity_ino_icai_gstin || "";
  const hasGSTIN = typeof gstin === "string" && gstin.trim().length > 0;
  const hasMembershipId = newEntityId && newEntityId.trim().length > 0;

  const newCustomerData = {
    entityid: newEntityId,
    isPerson: true,
    firstName: c.firstName || "",
    middleName: c.middleName || "",
    lastName: c.lastName || ".",
    email: c.email || c.altEmail || `${newEntityId}@placeholder.icai.org`,
    altEmail: c.altEmail || "",
    phone: c.phone || "",
    altPhone: c.altPhone || "",

    // Hardcoded
    subsidiary: { id: "168" },
    category: { id: "1" },
    custentity_ino_icai_nationality: 1,

    // Receivables account: Member (2724) if has Membership_ID, else Applicant (2725)
    receivablesaccount: { id: hasMembershipId ? "2724" : "2725" },

    // Copied from original student record
    custentity_ino_icai_appseq_no: `${transaction.Customer_ID}-1`,
    custentity_ino_icai_father_name: c.custentity_ino_icai_father_name || "",
    custentity_ino_icai_dob: c.custentity_ino_icai_dob || "",
    custentity_permanent_account_number: c.custentity_permanent_account_number || "",
    custentity_ino_icai_regno: c.custentity_ino_icai_regno || "",
    custentity_ino_icai_source_portal: "SSP",

    // Select fields — copy as { id } objects from REST response
    ...(pickId(c.custentity_ino_icai_membership_type)
      ? { custentity_ino_icai_membership_type: pickId(c.custentity_ino_icai_membership_type) }
      : {}),
    ...(c.custentity_ino_icai_date_membrshp_held
      ? { custentity_ino_icai_date_membrshp_held: c.custentity_ino_icai_date_membrshp_held }
      : {}),
    ...(pickId(c.custentity_ino_icai_gender)
      ? { custentity_ino_icai_gender: pickId(c.custentity_ino_icai_gender) }
      : {}),
    ...(pickId(c.custentity_ino_icai_status)
      ? { custentity_ino_icai_status: pickId(c.custentity_ino_icai_status) }
      : {}),
    ...(pickId(c.custentity_ino_icai_region)
      ? { custentity_ino_icai_region: pickId(c.custentity_ino_icai_region) }
      : {}),

    // GSTIN — only if present
    ...(hasGSTIN
      ? {
          custentity_ino_icai_gstin: gstin,
          custentity2: c.custentity2 || "",
          custentity_in_gst_vendor_regist_type: { id: "1" },
        }
      : {
          custentity_in_gst_vendor_regist_type: { id: "4" },
        }),
  };

  // Copy address book from original customer
  const addressBook = c.addressBook?.items || c.addressbook?.items || [];
  if (addressBook.length > 0) {
    newCustomerData.addressBook = {
      items: addressBook.map((addr) => {
        const addrData = addr.addressBookAddress || addr.addressbookaddress || {};
        return {
          defaultShipping: addr.defaultShipping || false,
          defaultBilling: addr.defaultBilling || false,
          label: addr.label || "",
          addressBookAddress: {
            addr1: addrData.addr1 || "",
            addr2: addrData.addr2 || "",
            addr3: addrData.addr3 || "",
            city: addrData.city || "",
            state: addrData.state || pickId(addrData.state) || "",
            zip: addrData.zip || "",
            country: addrData.country || pickId(addrData.country) || "",
            addressee: addrData.addressee || "",
            phone: addrData.phone || "",
          },
        };
      }),
    };
    console.log(
      `[MembershipSync] [Form 2] Copying ${addressBook.length} address(es) from student`
    );
  }

  console.log(
    `[MembershipSync] [Form 2] Creating member customer: entityid=${newEntityId}`
  );

  const newCustomer = await withRetry(
  () => createCustomerRecord(newCustomerData),
  `CreateCustomer:${newEntityId}`
);

await netsuiteRequest(
  "PATCH",
  `/services/rest/record/v1/customer/${newCustomer.id}`,
  {
    entityid: `${transaction.Customer_ID}-1`
  }
);

  console.log(
    `[MembershipSync] [Form 2] Member customer created: id=${newCustomer.id}`
  );


  return newCustomer;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE TRANSACTION PROCESSOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process one transaction end-to-end:
 *   1. Parse & classify fee heads (Regular/Discount → SO, Contribution → JV)
 *   2. [Form 2] Duplicate customer (Student → Member)
 *   3. Create Sales Order (Regular + Discount items only, with tax)
 *   4. Create Customer Deposit (full Payment_Amount)
 *   5. Transform SO → Invoice
 *   6. Create Journal Voucher (contribution items only, if any)
 *   7. Apply Deposit to Invoice (Deposit Application)
 */
async function processTransaction(transaction, customerMap, formConfig) {
  const ref = transaction.Reference_Number;
  const form = transaction.Form_Description;

  const result = {
    reference: ref,
    form,
    customerId: transaction.Customer_ID,
    paymentAmount: transaction.Payment_Amount,
    steps: {},
    success: false,
    error: null,
  };

  try {
    // ── Step 1: Parse & classify fee heads ────────────────────────────────────
    const allFeeHeads = parseFeeHeads(transaction.Fee_Head);
    if (allFeeHeads.length === 0) {
      throw new Error("No fee heads found in transaction");
    }

    const { invoiceItems, contributionItems } = classifyFeeHeads(
      allFeeHeads,
      formConfig.contribution_codes || []
    );

    result.steps.parseFeeHeads = {
      total: allFeeHeads.length,
      invoiceCount: invoiceItems.length,
      contributionCount: contributionItems.length,
      invoiceItems: invoiceItems.map((f) => `${f.code}(${f.amount})`),
      contributionItems: contributionItems.map((f) => `${f.code}(${f.amount})`),
    };

    console.log(
      `[MembershipSync] [${ref}] Fee heads: ${allFeeHeads.length} total | Invoice: ${invoiceItems.length} | Contributions: ${contributionItems.length}`
    );

    // ── Step 2: Resolve customer ─────────────────────────────────────────────
    let customerInternalId = customerMap[transaction.Customer_ID];

    if (form === "Form 2") {
      // Form 2: Create duplicate customer as Member
      try {
       const newCustomer = await duplicateCustomerAsMember(
  transaction.Customer_ID,
  transaction
);
        customerInternalId = newCustomer.id;
        result.steps.customerDuplication = {
          success: true,
          newCustomerId: newCustomer.id,
        };
      } catch (err) {
        console.error(
          `[MembershipSync] [${ref}] Customer duplication failed: ${err.message}`
        );
        result.steps.customerDuplication = {
          success: false,
          error: err.message,
        };
        // Fall back to existing customer if duplication fails
        if (!customerInternalId) {
          throw new Error(
            `Customer ${transaction.Customer_ID} not found and duplication failed: ${err.message}`
          );
        }
        console.warn(
          `[MembershipSync] [${ref}] Falling back to existing customer: ${customerInternalId}`
        );
      }
    } else {
      // Form 6 / Form 3 / Student Registration: use existing customer
      if (!customerInternalId) {
        throw new Error(
          `Customer ${transaction.Customer_ID} not found in NetSuite`
        );
      }
    }

    result.steps.customer = {
      entityId: transaction.Customer_ID,
      internalId: customerInternalId,
    };

    // ── Step 3: Create Sales Order (Regular + Discount items only) ────────────
    if (invoiceItems.length === 0) {
      throw new Error(
        "No invoice items (Regular/Discount) found — cannot create Sales Order"
      );
    }

    const soData = buildSalesOrderData(
      transaction,
      customerInternalId,
      invoiceItems, // ← only Regular + Discount, NOT contributions
      formConfig
    );
    if (!soData) {
      throw new Error(
        "Failed to build Sales Order — no valid line items with internal IDs"
      );
    }

    console.log(`[MembershipSync] [${ref}] Creating Sales Order...`);
    const soResponse = await withRetry(
      () => createSalesOrder(soData),
      `SO:${ref}`
    );
    if (!soResponse || !soResponse.id) {
      console.error(`[MembershipSync] [${ref}] SO response was null/empty:`, JSON.stringify(soResponse));
      throw new Error(`Sales Order creation returned no ID — response: ${JSON.stringify(soResponse)}`);
    }
    const soId = soResponse.id;
    result.steps.salesOrder = {
      success: true,
      id: soId,
      tranId: soResponse.tranid || null,
    };
    console.log(`[MembershipSync] [${ref}] SO created: ${soId}`);

    // ── Step 4: Create Customer Deposit (full payment amount) ─────────────────
    const cdData = buildCustomerDepositData(soId, transaction, formConfig);
    const resolvedCdAccount = cdData.account?.id || "unknown";
    console.log(
      `[MembershipSync] [${ref}] Creating Customer Deposit (amount: ${transaction.Payment_Amount}, MID: ${transaction.MID || "N/A"}, account: ${resolvedCdAccount})...`
    );
    const cdResponse = await withRetry(
      () => createCustomerDeposit(cdData),
      `CD:${ref}`
    );
    if (!cdResponse || !cdResponse.id) {
      console.error(`[MembershipSync] [${ref}] CD response was null/empty:`, JSON.stringify(cdResponse));
      throw new Error(`Customer Deposit creation returned no ID — response: ${JSON.stringify(cdResponse)}`);
    }
    const cdId = cdResponse.id;
    result.steps.customerDeposit = { success: true, id: cdId };
    console.log(`[MembershipSync] [${ref}] CD created: ${cdId}`);

    // ── Step 5: Transform SO → Invoice ───────────────────────────────────────
    const invoiceBody = buildInvoiceBody(transaction, formConfig);
    console.log(
      `[MembershipSync] [${ref}] Creating Invoice from SO ${soId}...`
    );
    const invoiceResponse = await withRetry(
      () => createTransFormRecordInvoice(soId, invoiceBody),
      `Invoice:${ref}`
    );
    if (!invoiceResponse || !invoiceResponse.id) {
      console.error(`[MembershipSync] [${ref}] Invoice response was null/empty:`, JSON.stringify(invoiceResponse));
      throw new Error(`Invoice creation returned no ID — response: ${JSON.stringify(invoiceResponse)}`);
    }
    const invoiceId = invoiceResponse.id;
    result.steps.invoice = { success: true, id: invoiceId };
    console.log(`[MembershipSync] [${ref}] Invoice created: ${invoiceId}`);

    // ── Step 6: Create JV for contributions (if any) ─────────────────────────
    if (contributionItems.length > 0) {
      try {
        // Use vendor internal IDs directly from config (no SuiteQL lookup needed)
        const vendorMap = msConfig.contribution_vendor_mapping || {};

        const jvData = buildJournalEntryData(
          transaction,
          contributionItems,
          formConfig,
          customerInternalId,
          vendorMap
        );
        if (jvData) {
          console.log(
            `[MembershipSync] [${ref}] Creating JV for ${contributionItems.length} contribution item(s)...`
          );
          const jvResponse = await withRetry(
            () => createJournalEntry(jvData),
            `JV:${ref}`
          );
          result.steps.journalVoucher = { success: true, id: jvResponse.id };
          console.log(`[MembershipSync] [${ref}] JV created: ${jvResponse.id}`);
        }
      } catch (err) {
        console.error(
          `[MembershipSync] [${ref}] JV creation failed (non-blocking): ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`
        );
        result.steps.journalVoucher = {
          success: false,
          error: err.response?.data ?? err.message,
        };
      }
    }

    // ── Step 7: Deposit Application ──────────────────────────────────────────
    // NetSuite auto-applies the Customer Deposit to the Invoice when the
    // Invoice is created from the same Sales Order the CD is linked to.
    // No manual deposit application step is needed.
    console.log(
      `[MembershipSync] [${ref}] Deposit auto-applied by NetSuite (CD ${cdId} → Invoice ${invoiceId})`
    );
    result.steps.depositApplication = {
      success: true,
      id: null,
      skipped: true,
      reason: "NetSuite auto-applies deposit when invoice is created from the same SO",
    };

    result.success = true;
    console.log(
      `[MembershipSync] [${ref}] Transaction processed successfully`
    );
  } catch (err) {
    result.success = false;
    result.error = err.response?.data ?? err.message;
    console.error(
      `[MembershipSync] [${ref}] Transaction FAILED: ${JSON.stringify(result.error)}`
    );
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS LOGGER
// ═══════════════════════════════════════════════════════════════════════════════

function saveResults(results) {
  const now = new Date();
  const dateDir = path.join(
    __dirname,
    "data",
    "membership",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  );

  if (!fs.existsSync(dateDir)) {
    fs.mkdirSync(dateDir, { recursive: true });
  }

  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(dateDir, `sync-results-${timestamp}.json`);

  fs.writeFileSync(filePath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`[MembershipSync] Results saved: ${filePath}`);
  return filePath;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the full Membership & Student Registration sync:
 *   1. Authenticate with ICAI
 *   2. Fetch transactions from SSP portal
 *   3. Filter for Form 2, Form 6, Form 3/Fellowship, Student Registration
 *   4. Fetch matching customers from NetSuite
 *   5. Process each transaction (SO + Invoice)
 *   6. Save and return results
 */
async function runMembershipStudentSync({ integrationId } = {}) {
  if (syncMutex.isLocked()) {
    console.log(
      "[MembershipSync] Sync already running — request cancelled."
    );
    return {
      success: false,
      message: "Membership/Student sync already in progress. Try again later.",
    };
  }

  const release = await syncMutex.acquire();
  const startTime = Date.now();

  try {
    // ── 1. Authenticate ──────────────────────────────────────────────────────
    const tokenid = await authenticate();

    // ── 2. Fetch transactions ────────────────────────────────────────────────
    const allTransactions = await fetchTransactions(tokenid);
    console.log(
      `[MembershipSync] Total fetched from ICAI: ${allTransactions.length}`
    );

    if (allTransactions.length === 0) {
      return {
        success: true,
        message: "No transactions fetched from ICAI",
        processed: 0,
      };
    }

    // ── 3. Filter for membership/student forms ───────────────────────────────
    const allowedForms = getAllAllowedForms();
    const matchingTransactions = allTransactions.filter((t) =>
      allowedForms.includes(t.Form_Description)
    );
    const rejectedTransactions = allTransactions.filter(
      (t) => !allowedForms.includes(t.Form_Description)
    );

    console.log(
      `[MembershipSync] Matching: ${matchingTransactions.length} | ` +
        `Rejected: ${rejectedTransactions.length}`
    );

    if (rejectedTransactions.length > 0) {
      const rejectedForms = [
        ...new Set(rejectedTransactions.map((t) => t.Form_Description)),
      ];
      console.log(
        `[MembershipSync] Rejected form types: ${rejectedForms.join(", ")}`
      );
    }

    if (matchingTransactions.length === 0) {
      return {
        success: true,
        message: "No matching membership/student transactions found",
        totalFetched: allTransactions.length,
        processed: 0,
      };
    }

    // ── 4. Pre-validate: check subsidiary config ─────────────────────────────
    const invalidTransactions = [];
    const validTransactions = [];

    for (const t of matchingTransactions) {
      const cfg = getConfigForForm(t.Form_Description);
      if (!cfg || !cfg.subsidiary_id) {
        invalidTransactions.push({
          reference: t.Reference_Number,
          form: t.Form_Description,
          reason: `Subsidiary ID not configured for ${cfg?.type || "unknown"}. Update membershipStudentConfig.json`,
        });
      } else {
        validTransactions.push(t);
      }
    }

    if (invalidTransactions.length > 0) {
      console.warn(
        `[MembershipSync] ${invalidTransactions.length} transactions skipped (missing subsidiary config):`
      );
      for (const inv of invalidTransactions) {
        console.warn(
          `  - ${inv.reference} (${inv.form}): ${inv.reason}`
        );
      }
    }

    if (validTransactions.length === 0) {
      return {
        success: true,
        message: "All matching transactions skipped due to missing config",
        totalFetched: allTransactions.length,
        totalMatching: matchingTransactions.length,
        skipped: invalidTransactions,
        processed: 0,
      };
    }

    // ── 5. Fetch customers from NetSuite (batched to avoid SuiteQL length limits) ─
    const uniqueCustomerIds = [
      ...new Set(validTransactions.map((t) => t.Customer_ID)),
    ];
    console.log(
      `[MembershipSync] Fetching ${uniqueCustomerIds.length} customers from NetSuite...`
    );

    // Batch into chunks of 50 to stay within SuiteQL IN-clause limits
    const CUSTOMER_BATCH_SIZE = 50;
    const customers = [];
    for (let i = 0; i < uniqueCustomerIds.length; i += CUSTOMER_BATCH_SIZE) {
      const batch = uniqueCustomerIds.slice(i, i + CUSTOMER_BATCH_SIZE);
      console.log(
        `[MembershipSync] Customer batch ${Math.floor(i / CUSTOMER_BATCH_SIZE) + 1}/${Math.ceil(uniqueCustomerIds.length / CUSTOMER_BATCH_SIZE)} (${batch.length} IDs)...`
      );
      const batchResults = await fetchAllCustomers(batch);
      customers.push(...batchResults);
    }
    console.log(
      `[MembershipSync] Total customers fetched: ${customers.length}/${uniqueCustomerIds.length}`
    );
    const customerMap = {};
    for (const c of customers) {
      if (c.entityid) customerMap[c.entityid] = c.id;
    }
    console.log(
      `[MembershipSync] Found ${Object.keys(customerMap).length}/${uniqueCustomerIds.length} customers`
    );

    // ── 6. Process each transaction ──────────────────────────────────────────
    const limit = pLimit(CONCURRENCY_LIMIT);
    const allResults = [];

    const tasks = validTransactions.map((transaction, index) =>
      limit(async () => {
        const formConfig = getConfigForForm(transaction.Form_Description);
        console.log(
          `\n[MembershipSync] ── [${index + 1}/${validTransactions.length}] ${transaction.Reference_Number} (${transaction.Form_Description}) ──`
        );
        return processTransaction(transaction, customerMap, formConfig);
      })
    );

    const results = await Promise.all(tasks);
    allResults.push(...results);

    // ── 7. Save results ──────────────────────────────────────────────────────
    const resultsFile = saveResults({
      syncedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      totalFetched: allTransactions.length,
      totalMatching: matchingTransactions.length,
      totalProcessed: validTransactions.length,
      skipped: invalidTransactions,
      results: allResults,
    });

    // ── 8. Summary ───────────────────────────────────────────────────────────
    const successCount = allResults.filter((r) => r.success).length;
    const failCount = allResults.filter((r) => !r.success).length;
    const durationMs = Date.now() - startTime;

    console.log(
      `\n[MembershipSync] ════════════════════════════════════════`
    );
    console.log(`[MembershipSync] SYNC COMPLETE`);
    console.log(
      `[MembershipSync]   Total Fetched    : ${allTransactions.length}`
    );
    console.log(
      `[MembershipSync]   Matching Forms   : ${matchingTransactions.length}`
    );
    console.log(
      `[MembershipSync]   Processed        : ${validTransactions.length}`
    );
    console.log(
      `[MembershipSync]   Success          : ${successCount}`
    );
    console.log(
      `[MembershipSync]   Failed           : ${failCount}`
    );
    console.log(
      `[MembershipSync]   Config Skipped   : ${invalidTransactions.length}`
    );
    console.log(
      `[MembershipSync]   Duration         : ${durationMs}ms`
    );
    console.log(
      `[MembershipSync] ════════════════════════════════════════\n`
    );

    return {
      success: true,
      message: `Processed ${successCount} transactions successfully, ${failCount} failed`,
      totalFetched: allTransactions.length,
      totalMatching: matchingTransactions.length,
      processed: successCount,
      failed: failCount,
      configSkipped: invalidTransactions.length,
      durationMs,
      resultsFile,
      details: allResults.map((r) => ({
        reference: r.reference,
        form: r.form,
        customerId: r.customerId,
        success: r.success,
        error: r.error || null,
        steps: r.steps || {},
      })),
    };
  } catch (err) {
    console.error("[MembershipSync] Fatal error:", err);
    throw err;
  } finally {
    release();
  }
}

module.exports = { runMembershipStudentSync };
