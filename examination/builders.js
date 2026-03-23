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

// ── Item matcher ────────────────────────────────────────────────────────────

function getMatchedItem(feeHeadCode) {
  return feeHeadCode ? itemLookupMap[feeHeadCode] : null;
}

// ── Sales Order Builder ─────────────────────────────────────────────────────

function buildExamSalesOrderData(transaction, customerInternalId) {
  const feeHeadCode = transaction.Fee_Head?.[0]?.FeeHeadCode1 ?? null;
  const matchedItem = getMatchedItem(feeHeadCode);
  const itemInternalId = matchedItem ? String(matchedItem.item_internal_id) : "3019";
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);

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
    custbodycreate_middleware: true,
    custbody_process_invoice: true,

    subsidiary: { id: SUBSIDIARY_ID, type: "subsidiary" },
    location: { id: LOCATION_ID, type: "location" },
    department: { id: DEPARTMENT_ID, type: "department" },

    orderStatus: { id: "B" },
    paymentAmount: parseFloat(transaction.Payment_Amount) || 0.0,

    item: {
      items: [
        {
          item: { id: itemInternalId },
          quantity: parseInt(transaction.Quantity) || 1,
          rate: parseFloat(transaction.Payment_Amount) || 0.0,
          amount: parseFloat(transaction.Payment_Amount) || 0.0,
          description:
            transaction.Fee_Head?.[0]?.FeeHead1 || transaction.Form_Description || "",
          custcol_in_nature_of_item: { id: "3" },
          department: { id: DEPARTMENT_ID },
          ...(matchedItem?.events_seminars_internal_id
            ? { class: { id: String(matchedItem.events_seminars_internal_id) } }
            : {}),
          ...(transaction.Start_Date
            ? { custcol_inoday_inv_startdate: parseDateDDMMYYYY(transaction.Start_Date) }
            : {}),
          ...(transaction.End_Date
            ? { custcol_inoday_inv_enddate: parseDateDDMMYYYY(transaction.End_Date) }
            : {}),
          ...(matchedItem?.event_seminar_type_internal_id
            ? { custcol_inoday_icai_type: { id: String(matchedItem.event_seminar_type_internal_id) } }
            : {}),
          ...(matchedItem?.event_seminar_sub_type_internal_id
            ? { custcol_ino_icia_duplicate_class: { id: String(matchedItem.event_seminar_sub_type_internal_id) } }
            : {}),
        },
      ],
    },
  };

  if (matchedItem?.events_seminars_internal_id) {
    soData.events_seminars_internal_id = {
      id: String(matchedItem.events_seminars_internal_id),
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
    custbody_ino_icai_source_portal: "SSP",
    custbody_ino_icai_source_portal_url: "https://eservices.icai.org/",
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
  };
}

module.exports = {
  buildExamSalesOrderData,
  buildExamCustomerDepositData,
  buildExamInvoiceBody,
  getMatchedItem,
  parseDateDDMMYYYY,
  itemLookupMap,
};
