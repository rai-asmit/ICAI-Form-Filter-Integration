"use strict";

/**
 * examination/builders.js — Payload builders for Exam Enrollment & Other Forms
 *
 * Builds NetSuite payloads for the simple flow:
 *   Sales Order → Customer Deposit → Invoice
 *
 * Item lookup uses internal_id_details.json (fee head code → item mapping).
 * Config: Subsidiary 171 (Examination), Department 227, Location 286.
 */

const internalIdDetails = require("../internal_id_details.json");

// ── Item Lookup Map (built once at startup) ─────────────────────────────────

const itemLookupMap = {};

function flattenItems(obj) {
  for (const key in obj) {
    if (Array.isArray(obj[key])) {
      for (const itemDef of obj[key]) {
        if (itemDef.item) {
          const code = itemDef.item.split(" ")[0];
          itemLookupMap[code] = itemDef;
        }
      }
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      flattenItems(obj[key]);
    }
  }
}

if (internalIdDetails && internalIdDetails.records) {
  flattenItems(internalIdDetails.records);
}

// ── Constants from internal_id_details.json ─────────────────────────────────

const SUBSIDIARY_ID = String(internalIdDetails.subsidiary_branch?.internal_id || "171");
const DEPARTMENT_ID = String(internalIdDetails.cost_center?.internal_id || "227");
const LOCATION_ID = "286";
const CD_ACCOUNT_ID = "3341";

// ── Date helpers ────────────────────────────────────────────────────────────

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

// ── Fee Head Parser ─────────────────────────────────────────────────────────

/**
 * Parse fee heads dynamically from the Fee_Head array.
 * Handles numbered suffixes (FeeHeadCode1, FeeAmount2, etc.)
 * so it works for both single and multiple fee heads.
 */
function parseFeeHeads(feeHeadArray) {
  if (!Array.isArray(feeHeadArray)) return [];

  const results = [];

  for (const entry of feeHeadArray) {
    for (const key of Object.keys(entry)) {
      if (key.startsWith("FeeHeadCode")) {
        const num = key.replace("FeeHeadCode", "");
        const code = entry[key];
        const description = entry[`FeeHead${num}`] || "";
        const amount = parseFloat(entry[`FeeAmount${num}`]) || 0;
        if (code) {
          results.push({ code, description, amount });
        }
      }
    }
  }

  return results;
}

// ── Item matcher ────────────────────────────────────────────────────────────

function getMatchedItem(feeHeadCode) {
  return feeHeadCode ? itemLookupMap[feeHeadCode] : null;
}

// ── Sales Order Builder ─────────────────────────────────────────────────────

function buildExamSalesOrderData(transaction, customerInternalId) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);

  // Parse all fee heads dynamically
  const feeHeads = parseFeeHeads(transaction.Fee_Head);

  if (feeHeads.length === 0) {
    console.error(
      `[ExamSync] No fee heads found for SO — Ref: ${transaction.Reference_Number}`
    );
    return null;
  }

  // Build one line item per fee head
  const lineItems = [];
  const unmappedCodes = [];
  let firstMatchedItem = null;

  for (const feeHead of feeHeads) {
    const matchedItem = getMatchedItem(feeHead.code);

    if (!matchedItem) {
      unmappedCodes.push(feeHead.code);
      console.warn(
        `[ExamSync] Fee head code "${feeHead.code}" (${feeHead.description}) not found in item map — skipping line`
      );
      continue;
    }

    // Track first matched item for header-level fields
    if (!firstMatchedItem) {
      firstMatchedItem = matchedItem;
    }

    lineItems.push({
      item: { id: String(matchedItem.item_internal_id) },
      quantity: parseInt(transaction.Quantity) || 1,
      rate: feeHead.amount,
      amount: feeHead.amount,
      description: feeHead.description || transaction.Form_Description || "",
      custcol_in_nature_of_item: { id: "3" },
      department: { id: DEPARTMENT_ID },
      ...(matchedItem.events_seminars_internal_id
        ? { class: { id: String(matchedItem.events_seminars_internal_id) } }
        : {}),
      ...(transaction.Start_Date
        ? { custcol_inoday_inv_startdate: parseDateDDMMYYYY(transaction.Start_Date) }
        : {}),
      ...(transaction.End_Date
        ? { custcol_inoday_inv_enddate: parseDateDDMMYYYY(transaction.End_Date) }
        : {}),
      ...(matchedItem.event_seminar_type_internal_id
        ? { custcol_inoday_icai_type: { id: String(matchedItem.event_seminar_type_internal_id) } }
        : {}),
      ...(matchedItem.event_seminar_sub_type_internal_id
        ? { custcol_ino_icia_duplicate_class: { id: String(matchedItem.event_seminar_sub_type_internal_id) } }
        : {}),
    });
  }

  if (lineItems.length === 0) {
    console.error(
      `[ExamSync] No valid line items for SO — all fee head codes unmapped: ${unmappedCodes.join(", ")} — Ref: ${transaction.Reference_Number}`
    );
    return null;
  }

  if (unmappedCodes.length > 0) {
    console.warn(
      `[ExamSync] Unmapped fee head codes (need entries in internal_id_details.json): ${unmappedCodes.join(", ")}`
    );
  }

  const soData = {
    entity: { id: customerInternalId, type: "customer" },
    tranDate,
    custbody_in_return_form_period: { refName: getMonthYear(tranDate) },
    memo: transaction.Payment_Order_Id,
    custbody_inoday_payment_ref: transaction.Payment_Order_Id,
    custbody_ino_icai_reference_number: transaction.Reference_Number,
    custbody_ino_icai_utr: transaction.Reference_Number,
    custbody_ino_icai_source_portal: "SSP",
    custbody_ino_icai_source_portal_url: "https://eservices.icai.org/",
    custbody_sspformtype: transaction.Form_Description || "",
    custbodycreate_middleware: true,
    custbody_process_invoice: true,
    subsidiary: { id: SUBSIDIARY_ID, type: "subsidiary" },
    location: { id: LOCATION_ID, type: "location" },
    department: { id: DEPARTMENT_ID, type: "department" },

    orderStatus: { id: "B" },
    paymentAmount: parseFloat(transaction.Payment_Amount) || 0.0,

    item: { items: lineItems },
  };

  // Header-level event/seminar classification from first matched item
  if (firstMatchedItem?.events_seminars_internal_id) {
    soData.events_seminars_internal_id = {
      id: String(firstMatchedItem.events_seminars_internal_id),
    };
  }

  return soData;
}

// ── Customer Deposit Builder ────────────────────────────────────────────────

function buildExamCustomerDepositData(salesOrderId, transaction, tranDate, matchedItem) {
  return {
    salesorder: { id: salesOrderId },
    account: { id: CD_ACCOUNT_ID },
    payment: parseFloat(transaction.Payment_Amount) || 0.0,
    memo: transaction.Payment_Order_Id,
    tranDate,
    custbody_in_return_form_period: { refName: getMonthYear(tranDate) },
    custbody_inoday_payment_ref: transaction.Payment_Order_Id,
    custbody_ino_icai_reference_number: transaction.Reference_Number,
    custbodypayment_reference_number: transaction.Reference_Number,
    custbody_ino_icai_utr: transaction.Reference_Number,
    custbodycreate_middleware: true,
    custbody_ino_icai_source_portal: "SSP",
    custbody_ino_icai_source_portal_url: "https://eservices.icai.org/",
    custbody_sspformtype: transaction.Form_Description || "",
    department: { id: DEPARTMENT_ID },
    location: { id: LOCATION_ID },
    ...(matchedItem?.events_seminars_internal_id
      ? { class: { id: String(matchedItem.events_seminars_internal_id) } }
      : {}),
    ...(matchedItem?.event_seminar_type_internal_id
      ? { custcol_inoday_icai_type: { id: String(matchedItem.event_seminar_type_internal_id) } }
      : {}),
    ...(matchedItem?.event_seminar_sub_type_internal_id
      ? { custcol_ino_icia_duplicate_class: { id: String(matchedItem.event_seminar_sub_type_internal_id) } }
      : {}),
  };
}

// ── Invoice Body Builder (SO → Invoice transform) ───────────────────────────

function buildExamInvoiceBody(transaction) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);
  return {
    approvalStatus: { id: "2" },
    tranDate,
    custbody_in_return_form_period: { refName: getMonthYear(tranDate) },
    custbody_sspformtype: transaction.Form_Description || "",
    custbodycreate_middleware: true,
  };
}

module.exports = {
  buildExamSalesOrderData,
  buildExamCustomerDepositData,
  buildExamInvoiceBody,
  parseFeeHeads,
  getMatchedItem,
  parseDateDDMMYYYY,
  itemLookupMap,
};
