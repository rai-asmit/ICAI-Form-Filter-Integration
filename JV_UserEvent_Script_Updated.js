/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define([
  "N/record",
  "N/search",
  "N/error",
  "N/runtime",
  "N/currentRecord"
],
function (record, search, error, runtime, currentRecord)
{
  var accountEnvironment = (runtime.envType == "SANDBOX") ? true : false;

  // PRODUCTION
  var FRA_Array = {
    "debit": "2770", // Customer Deposits
    "credit": [
        {
          "SFRA": "482", // FRA - Students
          "MFRA": "483", // FRA - Members
          "OFRA": "484"  // FRA - Others
        }
      ]
  };

  var GST_Array = {
    "IGST": [
      {
        "debit": "1199",    //GST on Advance IGST
        "credit": "451",    //Indirect taxes : Output IGST
        "invigst": "451"    //Indirect taxes : Output IGST
      }
    ],
    "CGST": [
      {
        "debit": "1197",    //GST on Advance CGST
        "credit": "449",    //Indirect taxes : Output CGST
        "invcgst": "449"    //Indirect taxes : Output CGST
      }
    ],
    "SGST": [
      {
        "debit": "1198",    //GST on Advance SGST
        "credit": "450",    //Indirect taxes : Output SGST
        "invsgst": "450"    //Indirect taxes : Output SGST
      }
    ]
  };

  var exports = {};

  // ─────────────────────────────────────────────────────────────────────────────
  // afterSubmit Entry Point
  // • Gate: only proceeds if custbodycreate_middleware checkbox is checked
  // ─────────────────────────────────────────────────────────────────────────────
  function crateJournal(context)
  {
    try
    {
      var currRecord = context.newRecord;

      // ── GATE: only proceed if custbodycreate_middleware is checked ──────────
      var createMiddleware = currRecord.getValue('custbodycreate_middleware');
      if (!createMiddleware)
      {
        log.audit('crateJournal', 'custbodycreate_middleware is not checked — script skipped.');
        return;
      }
      // ────────────────────────────────────────────────────────────────────────

      log.debug('Context', JSON.stringify(context));
      log.debug('Context.newRecord', JSON.stringify(context.newRecord));

      var jvtobecreated = currRecord.getValue('custbody40');
      var linkedJV      = currRecord.getValue('custbody_inoday_linked_jv');
      log.emergency('Context.linkedJV#', JSON.stringify(linkedJV));
      // FIX: linkedJV may be null/undefined — guard before reading .length to avoid TypeError
      log.emergency('Context.linkedJV#.linkedJV', JSON.stringify(linkedJV ? linkedJV.length : 0));
      log.debug('jvtobecreated', jvtobecreated);
      log.audit('jvtobecreated', jvtobecreated);

      if (currRecord.type == 'customerdeposit' &&
          (context.type == 'create' || context.type == 'edit' || context.type == 'xedit') &&
          linkedJV == '')
      {
        JVAgainstDeposite(currRecord);
      }
      else if (currRecord.type == 'invoice' &&
               (context.type == 'create' || context.type == 'edit' || context.type == 'xedit') &&
               linkedJV == '')
      {
        JVAgainstInvoice(context);
      }
    }
    catch (e)
    {
      log.error("error--!", JSON.stringify(e));
      log.error("error", e.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // JV Against Customer Deposit
  // • Always creates a JV with FRA + GST lines
  // • Updates Sales Order fields ONLY when a SO is linked
  // ─────────────────────────────────────────────────────────────────────────────
  function JVAgainstDeposite(currRecord)
  {
    var depositId = currRecord.id;

    var currRecord = record.load({
      type: 'customerdeposit',
      id: depositId,
      isDynamic: false
    });
    log.audit('currRecord', JSON.stringify(currRecord));

    var cust_category = currRecord.getValue('custbody_ino_icai_std_category');
    var igst          = currRecord.getValue('custbody_inoday_icai_igst_val') || 0;
    var cgst          = currRecord.getValue('custbody_ino_icai_gst_value')   || 0;
    var sgst          = currRecord.getValue('custbody_inoday_icai_sgst_val') || 0;
    var branch        = currRecord.getValue('subsidiary');
    var __trandate    = currRecord.getText('trandate');
    var totalAmount   = currRecord.getValue('payment');
    var entityId      = currRecord.getValue('customer');
    var so_Id         = currRecord.getValue('salesorder'); // may be null/empty

    log.emergency('deposit trandate', __trandate);
    log.audit('depositId', depositId);
    log.audit('so_Id', so_Id);

    // Update SO fields only when a SO is linked
    if (so_Id)
    {
      var so_sub_total = parseFloat(totalAmount) - parseFloat(cgst) - parseFloat(sgst) - parseFloat(igst);
      record.submitFields({
        type: 'salesorder',
        id:   so_Id,
        values: {
          custbody_ino_remain_cdamount_adjust: so_sub_total,
          custbody_ino_remain_cgstadjust:      cgst,
          custbody_ino_remain_sgstadjust:      sgst,
          custbody_ino_remain_igstadjust:      igst
        }
      });
      log.audit('SO fields updated', so_Id);
    }
    else
    {
      log.audit('JVAgainstDeposite', 'No Sales Order linked — SO field update skipped. JV will still be created.');
    }

    // Always create JV (regardless of whether SO exists)
    if (cust_category != 5)
    {
      var jeRec = record.create({
        type: record.Type.JOURNAL_ENTRY,
        isDynamic: true
      });

      jeRec.setValue({ fieldId: 'subsidiary',                  value: branch });
      jeRec.setText({ fieldId: 'trandate',                     text: __trandate });
      jeRec.setValue({ fieldId: 'approvalstatus',              value: 2 });
      jeRec.setValue({ fieldId: 'custbody_inoday_linked_bill', value: depositId });

      // FRA lines
      var debitAccountNo  = FRA_Array.debit;
      var creditAccountNo;
      if (cust_category == '2')       creditAccountNo = FRA_Array.credit[0].SFRA; // Student
      else if (cust_category == '1')  creditAccountNo = FRA_Array.credit[0].MFRA; // Member
      else                            creditAccountNo = FRA_Array.credit[0].OFRA; // Others

      addLines(jeRec, 'debit',  totalAmount, debitAccountNo,  entityId);
      addLines(jeRec, 'credit', totalAmount, creditAccountNo, entityId);

      // GST lines
      if (igst > 0)
      {
        addLines(jeRec, 'debit',  igst, GST_Array.IGST[0].debit,  entityId);
        addLines(jeRec, 'credit', igst, GST_Array.IGST[0].credit, entityId);
      }
      if (cgst > 0)
      {
        addLines(jeRec, 'debit',  cgst, GST_Array.CGST[0].debit,  entityId);
        addLines(jeRec, 'credit', cgst, GST_Array.CGST[0].credit, entityId);
      }
      if (sgst > 0)
      {
        addLines(jeRec, 'debit',  sgst, GST_Array.SGST[0].debit,  entityId);
        addLines(jeRec, 'credit', sgst, GST_Array.SGST[0].credit, entityId);
      }

      var jeId = jeRec.save();
      log.debug('Journal Created - ', jeId);

      // Always link the JV back to the Customer Deposit
      record.submitFields({
        type: 'customerdeposit',
        id:   currRecord.id,
        values: {
          custbody_inoday_linked_jv:    jeId,
          custbodyino_linked_jv_amount: totalAmount
        }
      });
      log.debug('Linked JV Updated on Deposit', 'done');

      // Update SO with JV tranid only when SO is linked
      if (so_Id)
      {
        var jv_linked_field = search.lookupFields({
          type: search.Type.JOURNAL_ENTRY,
          id:   jeId,
          columns: ['tranid']
        });
        log.debug('#CustomerDeposite: jv_linked_field', jv_linked_field);

        record.submitFields({
          type: 'salesorder',
          id:   so_Id,
          values: {
            custbody34: jv_linked_field.tranid,
            custbody35: totalAmount
          }
        });
        log.audit('SO JV tranid updated', so_Id);
      }
      else
      {
        log.audit('JVAgainstDeposite', 'No Sales Order linked — SO JV tranid update skipped.');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // JV Against Invoice
  // • Gate (per requirement): Subsidiary = Delhi (168) | Source Portal = 'SSP' | Category = Member (1)
  // • Only creates a JV when BOTH conditions are met:
  //     1. A Customer Deposit linked to the same Sales Order exists
  //        OR a standalone Customer Deposit (no SO) exists for the same customer
  //     2. That Customer Deposit has a linked FRA JV (custbody_inoday_linked_jv)
  // • Knock-off line amounts use Math.min(invoiceTotal, depositTotal)
  //   so the JV never exceeds what was actually collected up front
  // ─────────────────────────────────────────────────────────────────────────────
  function JVAgainstInvoice(context)
  {
    var currentRecordContex = context.newRecord;
    log.debug("JVAgainstInvoice : Id:type ", currentRecordContex.id + ":" + currentRecordContex.type);

    var invoiceId = currentRecordContex.id;

    var rec = record.load({
      type: currentRecordContex.type,
      id:   currentRecordContex.id,
      isDynamic: true
    });

    var entityId   = rec.getValue({ fieldId: 'entity' });
    var __trandate = rec.getText({ fieldId: 'trandate' });

    // ── FIX: Flow 2 Gate (per requirement Step 1) ─────────────────────────────
    // Subsidiary = Delhi (internal id 168) | Source Portal = 'SSP' | Category = Member (1)
    var invoiceSubsidiary = rec.getValue({ fieldId: 'subsidiary' });
    var source            = rec.getValue({ fieldId: 'custbody_ino_icai_source_portal' });
    var category          = rec.getValue({ fieldId: 'category' });

    if (String(invoiceSubsidiary) !== '168' || source !== 'SSP' || String(category) !== '1')
    {
      log.audit('JVAgainstInvoice',
        'Gate failed — subsidiary=' + invoiceSubsidiary + ' source=' + source + ' category=' + category + ' — skipping.');
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Duplicate JV guard ───────────────────────────────────────────────────
    // getValue() on a record-link field can return: [], "", null, 0, or an ID.
    // [] (empty array) is TRUTHY in JS — must explicitly check for it.
    var existingLinkedJV = rec.getValue({ fieldId: 'custbody_inoday_linked_jv' });
    log.audit('INV:existingLinkedJV raw', JSON.stringify(existingLinkedJV) + ' | type=' + typeof existingLinkedJV);

    var jvAlreadyExists = existingLinkedJV !== null &&
                          existingLinkedJV !== undefined &&
                          !Array.isArray(existingLinkedJV) &&
                          String(existingLinkedJV).trim() !== '' &&
                          String(existingLinkedJV).trim() !== '0';

    if (jvAlreadyExists)
    {
      try
      {
        var existingJVFields = search.lookupFields({
          type:    search.Type.JOURNAL_ENTRY,
          id:      existingLinkedJV,
          columns: ['tranid']
        });
        log.emergency('INV:custbody_inoday_linked_jv# DUPLICATE BLOCK',
          'JV already linked — internal id: ' + existingLinkedJV +
          ' | JV Doc No: '  + existingJVFields.tranid +
          ' — skipping JV creation.');
      }
      catch (lookupErr)
      {
        log.emergency('INV:custbody_inoday_linked_jv# DUPLICATE BLOCK',
          'JV already linked — internal id: ' + existingLinkedJV +
          ' (tranid lookup failed: ' + lookupErr.message + ') — skipping.');
      }
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    var createdfromSalesOrderId = rec.getValue({ fieldId: 'createdfrom' }); // may be null/empty
    log.debug("createdfromSalesOrderId", createdfromSalesOrderId);

    // ── GUARD: resolve which deposit path to use ──────────────────────────────
    // Path A — Invoice created from a Sales Order: look for an SO-linked deposit
    // Path B — Standalone invoice: look for a standalone deposit by customer
    // ─────────────────────────────────────────────────────────────────────────
    var linkedDeposit;

    if (createdfromSalesOrderId)
    {
      // Path A: Invoice was created from a Sales Order
      // First try an SO-linked deposit; if none found, fall back to a
      // standalone deposit for the same customer (deposit has no SO).
      linkedDeposit = getLinkedDepositWithFRA(createdfromSalesOrderId);
      if (linkedDeposit)
      {
        log.audit('JVAgainstInvoice', 'Path A — SO-linked deposit found: ' + JSON.stringify(linkedDeposit));
      }
      else
      {
        log.audit('JVAgainstInvoice',
          'Path A — No SO-linked deposit found for SO ' + createdfromSalesOrderId +
          '. Falling back to standalone deposit for customer ' + entityId);
        linkedDeposit = getStandaloneDepositWithFRA(entityId);
        if (linkedDeposit)
        {
          log.audit('JVAgainstInvoice', 'Path A-fallback — Standalone deposit found: ' + JSON.stringify(linkedDeposit));
        }
        else
        {
          log.audit('JVAgainstInvoice',
            'Path A-fallback — No standalone deposit with FRA JV found for customer ' +
            entityId + ' — JV creation skipped.');
          return;
        }
      }
    }
    else
    {
      // Path B: Standalone invoice (no SO) — look for standalone deposit by customer
      linkedDeposit = getStandaloneDepositWithFRA(entityId);
      if (!linkedDeposit)
      {
        log.audit('JVAgainstInvoice',
          'Path B — No standalone Customer Deposit with a linked FRA JV found for customer ' +
          entityId + ' — JV creation skipped.');
        return;
      }
      log.audit('JVAgainstInvoice', 'Path B — Standalone deposit found: ' + JSON.stringify(linkedDeposit));
    }
    // ─────────────────────────────────────────────────────────────────────────

    var depositTotalAmount = parseFloat(linkedDeposit.depositAmount) || 0;
    log.audit('JVAgainstInvoice', 'Deposit amount: ' + depositTotalAmount + ' | Deposit Id: ' + linkedDeposit.depositId);

    // Load customer for category
    var custObj           = record.load({ type: 'customer', id: entityId, isDynamic: true });
    var receiableTotalAmt = parseFloat(rec.getValue({ fieldId: 'total' })) || 0;

    var igst = parseFloat(rec.getValue('taxtotal2')) || 0;
    var cgst = parseFloat(rec.getValue('taxtotal3')) || 0;
    var sgst = parseFloat(rec.getValue('taxtotal4')) || 0;

    log.audit('JVAgainstInvoice', 'Invoice total: ' + receiableTotalAmt + ' | igst: ' + igst + ' | cgst: ' + cgst + ' | sgst: ' + sgst);

    // ── Determine knock-off amounts: use whichever is less ───────────────────
    // Load the deposit's GST amounts to cap each GST component independently
    var depositRec   = record.load({ type: 'customerdeposit', id: linkedDeposit.depositId, isDynamic: false });
    var depositIgst  = parseFloat(depositRec.getValue('custbody_inoday_icai_igst_val')) || 0;
    var depositCgst  = parseFloat(depositRec.getValue('custbody_ino_icai_gst_value'))   || 0;
    var depositSgst  = parseFloat(depositRec.getValue('custbody_inoday_icai_sgst_val')) || 0;

    // Net (ex-GST) amounts for the knock-off base
    var invoiceNet  = receiableTotalAmt - igst - cgst - sgst;
    var depositNet  = depositTotalAmount - depositIgst - depositCgst - depositSgst;

    var knockOffNet  = Math.min(invoiceNet,  depositNet);
    var knockOffIgst = Math.min(igst,        depositIgst);
    var knockOffCgst = Math.min(cgst,        depositCgst);
    var knockOffSgst = Math.min(sgst,        depositSgst);

    // Total knock-off (used for FRA lines which carry the full inclusive amount)
    var knockOffTotal = knockOffNet + knockOffIgst + knockOffCgst + knockOffSgst;

    log.audit('JVAgainstInvoice',
      'Knock-off — total: ' + knockOffTotal +
      ' | net: '  + knockOffNet  +
      ' | igst: ' + knockOffIgst +
      ' | cgst: ' + knockOffCgst +
      ' | sgst: ' + knockOffSgst);
    // ─────────────────────────────────────────────────────────────────────────

    // Create the JV
    var jeRec = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });

    jeRec.setValue({ fieldId: 'subsidiary',                  value: invoiceSubsidiary });
    jeRec.setText({ fieldId: 'trandate',                     text: __trandate });
    jeRec.setValue({ fieldId: 'approvalstatus',              value: 2 });
    jeRec.setValue({ fieldId: 'custbody_inoday_linked_bill', value: invoiceId });

    try
    {
      jeRec.setValue({ fieldId: 'custbody_ino_set_mark', value: true });
    }
    catch (ex1)
    {
      log.debug('JVAgainstInvoice.ex1', JSON.stringify(ex1));
      log.emergency('JVAgainstInvoice.ex1', JSON.stringify(ex1));
    }

    // ── FRA knock-off lines (capped to knock-off total) ──────────────────────
    // Credit: Customer Deposits clearing account (FRA_Array.debit = "2770")
    // Debit : FRA revenue account based on customer category
    addLines(jeRec, 'credit', knockOffTotal, FRA_Array.debit, entityId);

    var customerCategory = custObj.getValue({ fieldId: 'category' });
    var fraAccount;
    if (customerCategory == '2')       fraAccount = FRA_Array.credit[0].SFRA; // Student
    else if (customerCategory == '1')  fraAccount = FRA_Array.credit[0].MFRA; // Member
    else                               fraAccount = FRA_Array.credit[0].OFRA; // Others

    addLines(jeRec, 'debit', knockOffTotal, fraAccount, entityId);

    // ── GST reverse lines (each component capped independently) ──────────────
    if (knockOffIgst > 0)
    {
      addLines(jeRec, 'credit', knockOffIgst, GST_Array.IGST[0].debit,   entityId);
      addLines(jeRec, 'debit',  knockOffIgst, GST_Array.IGST[0].invigst, entityId);
    }
    if (knockOffCgst > 0)
    {
      addLines(jeRec, 'credit', knockOffCgst, GST_Array.CGST[0].debit,   entityId);
      addLines(jeRec, 'debit',  knockOffCgst, GST_Array.CGST[0].invcgst, entityId);
    }
    if (knockOffSgst > 0)
    {
      addLines(jeRec, 'credit', knockOffSgst, GST_Array.SGST[0].debit,   entityId);
      addLines(jeRec, 'debit',  knockOffSgst, GST_Array.SGST[0].invsgst, entityId);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Save and link JV back to the Invoice
    var jeId = jeRec.save({ enableSourcing: true, ignoreMandatoryFields: true });

    // Log the JV internal id AND document number immediately
    try
    {
      var savedJVFields = search.lookupFields({
        type:    search.Type.JOURNAL_ENTRY,
        id:      jeId,
        columns: ['tranid']
      });
      log.emergency('JVAgainstInvoice: JV CREATED',
        'Internal Id: ' + jeId + ' | JV Doc No: ' + savedJVFields.tranid);
    }
    catch (jeLogErr)
    {
      log.emergency('JVAgainstInvoice: JV CREATED', 'Internal Id: ' + jeId + ' (tranid lookup failed)');
    }

    // ── Link JV back to Invoice ────────────────────────────────────────────────────────────
    record.submitFields({
      type:   'invoice',
      id:     invoiceId,
      values: { custbody_inoday_linked_jv: jeId }
    });
    log.audit('Linked JV Updated on Invoice', jeId);

  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper: Find the first Customer Deposit for a given Sales Order that ALSO
  //         has a linked FRA JV (custbody_inoday_linked_jv is non-empty).
  //
  // Returns: { depositId, depositAmount } or null if none found.
  // ─────────────────────────────────────────────────────────────────────────────
  function getLinkedDepositWithFRA(salesOrderInternalId)
  {
    var depositSearch = search.create({
      type: "customerdeposit",
      filters: [
        ["type",       "anyof",      "CustDep"],
        "AND",
        ["salesorder", "anyof",      salesOrderInternalId],
        "AND",
        // isnotempty is the correct operator for record-link / text fields
        ["custbody_inoday_linked_jv", "isnotempty", ""]
      ],
      columns: [
        search.createColumn({ name: "internalid", label: "Internal ID" }),
        search.createColumn({ name: "amount",     label: "Amount" })
      ]
    });

    var result = null;
    depositSearch.run().each(function(row)
    {
      result = {
        depositId:     row.getValue({ name: "internalid" }),
        depositAmount: row.getValue({ name: "amount" })
      };
      return false; // stop after first match
    });

    log.debug('getLinkedDepositWithFRA', JSON.stringify(result));
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper: Find a standalone Customer Deposit (no SO linked) for a given
  //         customer that already has a linked FRA JV AND has NOT yet been
  //         knocked off against an invoice JV.
  //
  // Anti-duplicate strategy (no custom field needed):
  //   After finding each candidate deposit, check whether a Journal Entry
  //   already exists where custbody_inoday_linked_bill = that deposit's id
  //   AND custbody_ino_set_mark = true (the invoice-JV marker set in
  //   JVAgainstInvoice). If one is found the deposit is already consumed
  //   and is skipped.
  //
  // Returns: { depositId, depositAmount } or null if none found.
  // ─────────────────────────────────────────────────────────────────────────────
  function getStandaloneDepositWithFRA(customerId)
  {
    log.audit('getStandaloneDepositWithFRA', 'Searching for customerId: ' + customerId);

    // ── Find deposits: no SO, FRA JV exists ──────────────────────────────────
    var depositSearch = search.create({
      type: "customerdeposit",
      filters: [
        ["type",       "anyof",      "CustDep"],
        "AND",
        ["entity",     "anyof",      customerId],
        "AND",
        ["salesorder", "isempty",    ""],           // no SO linked
        "AND",
        ["custbody_inoday_linked_jv", "isnotempty", ""]  // FRA JV exists
      ],
      columns: [
        search.createColumn({ name: "internalid", label: "Internal ID" }),
        search.createColumn({ name: "amount",     label: "Amount" }),
        search.createColumn({ name: "custbody_inoday_linked_jv", label: "Linked FRA JV" })
      ]
    });

    var result = null;
    depositSearch.run().each(function(row)
    {
      var depositId     = row.getValue({ name: "internalid" });
      var depositAmount = row.getValue({ name: "amount" });
      var fraJvId       = row.getValue({ name: "custbody_inoday_linked_jv" });

      log.audit('getStandaloneDepositWithFRA:CANDIDATE',
        'depositId=' + depositId + ' | amount=' + depositAmount + ' | fraJvId=' + fraJvId);

      // ── Anti-duplicate check: has this deposit already been knocked off? ───
      // Search for a JE where custbody_inoday_linked_bill = invoiceId
      // AND custbody_ino_set_mark = true (set only by JVAgainstInvoice).
      // If found, this deposit is consumed — skip it.
      var invoiceJvCheck = search.create({
        type: "journalentry",
        filters: [
          ["custbody_inoday_linked_bill", "anyof",   depositId],
          "AND",
          ["custbody_ino_set_mark",       "is",      "T"]
        ],
        columns: [
          search.createColumn({ name: "internalid" }),
          search.createColumn({ name: "tranid" })
        ]
      });

      var alreadyConsumed = false;
      invoiceJvCheck.run().each(function(jeRow)
      {
        log.audit('getStandaloneDepositWithFRA:CONSUMED',
          'Deposit ' + depositId + ' already knocked off by JV: ' +
          jeRow.getValue({ name: "tranid" }) +
          ' (id=' + jeRow.getValue({ name: "internalid" }) + ') — skipping.');
        alreadyConsumed = true;
        return false; // stop after first hit
      });

      if (!alreadyConsumed)
      {
        result = { depositId: depositId, depositAmount: depositAmount };
        return false; // stop — first unconsumed deposit found
      }

      return true; // continue to next deposit
    });

    log.audit('getStandaloneDepositWithFRA', 'Result: ' + JSON.stringify(result));
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper: Search for existing Customer Deposits against a Sales Order
  // ─────────────────────────────────────────────────────────────────────────────
  function getFRAExist(salesOrderInternalId)
  {
    var customerdepositSearchObj = search.create({
      type: "customerdeposit",
      filters:
      [
        ["type", "anyof", "CustDep"],
        "AND",
        ["salesorder", "anyof", salesOrderInternalId]
      ],
      columns:
      [
        search.createColumn({ name: "trandate", label: "Date" }),
        search.createColumn({ name: "tranid",   label: "Document Number" }),
        search.createColumn({ name: "entity",   label: "Name" }),
        search.createColumn({ name: "account",  label: "Account" }),
        search.createColumn({ name: "memo",     label: "Memo" }),
        search.createColumn({ name: "amount",   label: "Amount" })
      ]
    });
    var searchResultCount = customerdepositSearchObj.runPaged().count;
    log.debug("customerdepositSearchObj result count", searchResultCount);
    return searchResultCount;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper: Add a single debit or credit line to a Journal Entry
  // ─────────────────────────────────────────────────────────────────────────────
  function addLines(jeRec, amountType, amount, accountNo, entityId)
  {
    jeRec.selectNewLine({ sublistId: 'line' });
    jeRec.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account',    value: accountNo });
    jeRec.setCurrentSublistValue({ sublistId: 'line', fieldId: amountType,   value: amount });
    jeRec.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity',     value: entityId });
    jeRec.setCurrentSublistValue({ sublistId: 'line', fieldId: 'department', value: 456 });
    jeRec.setCurrentSublistValue({ sublistId: 'line', fieldId: 'class',      value: 407 });
    jeRec.commitLine({ sublistId: 'line' });
  }

  exports.afterSubmit = crateJournal;
  return exports;
});
