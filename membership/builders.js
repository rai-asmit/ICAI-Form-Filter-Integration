"use strict";

const msConfig = require("../membershipStudentConfig.json");
const {
  parseDateDDMMYYYY,
  getMonthYear,
  toSelectField,
  firstNonEmpty,
  TAX_RATE,
  GST_RATE_ID,
} = require("./helpers");

/**
 * Build Sales Order payload.
 * ONLY Regular + Discount items go on the SO. Contribution items are excluded.
 * Tax (18%) is calculated and passed explicitly per line item.
 */
function buildSalesOrderData(transaction, customerInternalId, invoiceFeeHeads, formConfig) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);
  const HSN_CODE_ID = "1377"; // HSN 999512 internal ID in NetSuite

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

  const hasTax =
    parseFloat(transaction.SGST || 0) > 0 ||
    parseFloat(transaction.CGST || 0) > 0 ||
    parseFloat(transaction.IGST || 0) > 0 ||
    parseFloat(transaction.Total_Tax || 0) > 0;

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
    const taxAmount = hasTax ? (amount * TAX_RATE) / 100 : 0;
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
      ...(hasTax ? { custcol_in_gst_rate: { id: GST_RATE_ID } } : {}),
      ...(hasTax ? { custcol_in_hsn_code: { id: HSN_CODE_ID } } : {}),
      department: { id: formConfig.department_id },
      ...(formConfig.class_id ? { class: { id: formConfig.class_id } } : {}),
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
 * Used by: Student Registration (SO + CD) and Other Forms (SO + CD + Invoice).
 * CD captures the FULL payment amount and is linked to the Sales Order.
 */
function buildCustomerDepositData(soId, transaction, formConfig) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);

  const igst = parseFloat(transaction.IGST) || 0;
  const cgst = parseFloat(transaction.CGST) || 0;
  const sgst = parseFloat(transaction.SGST) || 0;
  const taxTotal = Number.parseFloat(transaction.Total_Tax);
  const mid = firstNonEmpty(transaction.MID);

  const gstFields = {};
  if (igst > 0) {
    gstFields.custbody_inoday_icai_igst_val = igst;
  } else if (cgst > 0 || sgst > 0) {
    gstFields.custbody_ino_icai_gst_value = cgst;
    gstFields.custbody_inoday_icai_sgst_val = sgst;
  }

  const midToAccount = msConfig.mid_to_account || {};
  const cdAccountId = (mid && midToAccount[mid]) ? midToAccount[mid] : null;

  if (mid && !midToAccount[mid]) {
    console.warn(
      `[MembershipSync] MID "${mid}" not found in mid_to_account mapping — skipping account field on Customer Deposit`
    );
  }

  // const cdAccountId = "2770"; // TEMP: hardcoded account ID, revert when mid_to_account mapping is fixed

  return {
    salesorder: { id: String(soId) },
    ...(cdAccountId ? { account: { id: String(cdAccountId) } } : {}),
    payment: parseFloat(transaction.Payment_Amount) || 0,
    memo: transaction.Payment_Order_Id,
    tranDate,
    custbody_in_return_form_period: { refName: getMonthYear(tranDate) },
    custbody_ino_icai_reference_number: transaction.Reference_Number,
    custbodypayment_reference_number: transaction.Reference_Number,
    custbody_ino_icai_utr: transaction.Reference_Number,
    custbody_ino_icai_source_portal: formConfig.source_portal || "SSP",
    custbody_ino_icai_source_portal_url:
      formConfig.source_portal_url || "https://eservices.icai.org/",
    custbodycreate_middleware: true,
    ...(mid ? { custbody_icai_ino_mid: mid } : {}),
    ...(Number.isFinite(taxTotal) ? { custbody_ino_icai_taxtotal: taxTotal } : {}),
    department: { id: formConfig.department_id },
    location: { id: formConfig.location_id },
    ...(formConfig.class_id ? { class: { id: formConfig.class_id } } : {}),
    ...gstFields,
  };
}

/**
 * Build Customer Payment payload.
 * Replaces Customer Deposit — directly settles open invoices + JV via manual apply.
 * Same mapping & process as CD but uses customerPayment endpoint.
 * Payment amount = FULL payment (all items + tax).
 *
 * @param {string} customerInternalId - NetSuite internal customer ID
 * @param {object} transaction - SSP transaction data
 * @param {object} formConfig - Config for this form type
 * @param {string} invoiceId - Invoice ID to apply payment against
 * @param {string|null} jvId - Journal Voucher ID to apply payment against (if contributions exist)
 * @param {number} totalContribution - Total contribution amount from JV (0 if no JV)
 */
function buildCustomerPaymentData(customerInternalId, transaction, formConfig, invoiceId, jvId, totalContribution) {
  const tranDate = parseDateDDMMYYYY(transaction.Payment_Date);
  const mid = firstNonEmpty(transaction.MID);
  const paymentAmount = parseFloat(transaction.Payment_Amount) || 0;

  const midToAccount = msConfig.mid_to_account || {};
  const cpAccountId = mid ? midToAccount[mid] : null;

  if (!cpAccountId) {
    console.warn(
      `[MembershipSync] MID "${mid ?? "(missing)"}" not found in mid_to_account mapping — skipping account field on Customer Payment`
    );
  }

  // Build manual apply list — invoice + JV (if created)
  const invoiceAmount = paymentAmount - (totalContribution || 0);
  const applyItems = [];
  if (invoiceId) {
    applyItems.push({
      apply: true,
      doc: { id: String(invoiceId), type: "invoice" },
      amount: invoiceAmount,
    });
  }
  if (jvId && totalContribution > 0) {
    applyItems.push({
      apply: true,
      doc: { id: String(jvId), type: "journalEntry" },
      amount: totalContribution,
    });
  }

  return {
    // ── Required fields ──
    customer: { id: String(customerInternalId), type: "customer" },
    payment: paymentAmount,

    // ── Classification (same as CD) ──
    department: { id: formConfig.department_id },
    location: { id: formConfig.location_id },
    ...(formConfig.class_id ? { class: { id: formConfig.class_id } } : {}),

    ...(cpAccountId ? { account: { id: String(cpAccountId) } } : {}),

    // ── Apply — manual if invoice/JV exist, auto otherwise ──
    autoApply: false,
    apply: { items: applyItems },

    // ── Date & period ──
    tranDate,
    custbody_in_return_form_period: { refName: getMonthYear(tranDate) },

    // ── Custom fields ──
    custbodycreate_middleware: true,
    custbody_ino_icai_reference_number: transaction.Reference_Number,
    custbody_ino_payment_amount_po: Number(transaction.Payment_Amount) || 0,
    custbodypayment_reference_number: transaction.Reference_Number,
    custbody_ino_icai_utr: transaction.Reference_Number,
    memo: transaction.Payment_Order_Id,

    // ── Source portal ──
    custbody_ino_icai_source_portal: formConfig.source_portal || "SSP",
    custbody_ino_icai_source_portal_url:
      formConfig.source_portal_url || "https://eservices.icai.org/",

    // ── MID tracking ──
    ...(mid ? { custbody_icai_ino_mid: mid } : {}),
  };
}

/**
 * Build Invoice body for SO -> Invoice transformation.
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
      };
    });

  return {
    approvalStatus: { id: "2" },
    tranDate,
    subsidiary: { id: formConfig.subsidiary_id },
    memo: transaction.Payment_Order_Id,
    custbody_ino_icai_reference_number: transaction.Reference_Number,
    custbodypayment_reference_number: transaction.Reference_Number,
    custbody_ino_icai_source_portal: formConfig.source_portal || "SSP",
    custbody_ino_icai_source_portal_url:
      formConfig.source_portal_url || "https://eservices.icai.org/",
    custbodycreate_middleware: true,
    line: { items: [debitLine, ...creditLines] },
  };
}

module.exports = {
  buildSalesOrderData,
  buildCustomerDepositData,
  buildCustomerPaymentData,
  buildInvoiceBody,
  buildJournalEntryData,
};
