"use strict";

const {
  netsuiteRequest,
  fetchAllCustomers,
} = require("../netsuiteClient--Rest");
const { withRetry } = require("./helpers");

async function fetchCustomerByEntityId(entityId) {
  const safeId = entityId.replace(/'/g, "''");
  const result = await netsuiteRequest(
    "POST",
    "/services/rest/query/v1/suiteql?limit=1",
    { q: `SELECT id FROM customer WHERE entityid = '${safeId}'` }
  );
  const row = result.items?.[0];
  if (!row) return null;

  const fullRecord = await netsuiteRequest(
    "GET",
    `/services/rest/record/v1/customer/${row.id}?expandSubResources=true`
  );
  return fullRecord;
}

async function createCustomerRecord(data) {
  return netsuiteRequest("POST", "/services/rest/record/v1/customer", data);
}

/**
 * Form 2 — New Membership:
 *   1. Check if member customer (Customer_ID-1) already exists
 *   2. If exists → reuse it
 *   3. If not → duplicate student customer as member with entityid = Customer_ID-1
 */
async function duplicateCustomerAsMember(customerEntityId, transaction) {
  // Fetch original student customer first to get appseq_no for entityid
  console.log(
    `[MembershipSync] [Form 2] Fetching student customer: ${customerEntityId}`
  );
  const c = await fetchCustomerByEntityId(customerEntityId);
  if (!c) {
    throw new Error(`Student customer not found in NetSuite: ${customerEntityId}`);
  }
  console.log(
    `[MembershipSync] [Form 2] Found student: id=${c.id}, entityid=${c.entityId || c.entityid}`
  );

  const appseqNo = c.custentity_ino_icai_appseq_no;
  if (!appseqNo) {
    throw new Error(`custentity_ino_icai_appseq_no missing on student customer: ${customerEntityId}`);
  }

  const memberEntityId = `${appseqNo}-1`;

  // Check if member customer already exists
  const existing = await fetchCustomerByEntityId(memberEntityId);
  if (existing) {
    console.log(
      `[MembershipSync] [Form 2] Member customer already exists: entityid=${memberEntityId}, id=${existing.id} — reusing`
    );
    return existing;
  }

  function pickId(field) {
    if (!field) return null;
    if (typeof field === "object" && field.id) return { id: String(field.id) };
    return field;
  }

  const gstin = c.custentity_ino_icai_gstin || "";
  const hasGSTIN = typeof gstin === "string" && gstin.trim().length > 0;

  const newCustomerData = {
    autoname: false,
    entityid: memberEntityId,
    isPerson: true,
    firstName: c.firstName || "",
    middleName: c.middleName || "",
    lastName: c.lastName || ".",
    email: c.email || c.altEmail || `${memberEntityId}@placeholder.icai.org`,
    altEmail: c.altEmail || "",
    phone: c.phone || "",
    altPhone: c.altPhone || "",

    subsidiary: { id: "168" },
    category: { id: "1" },
    custentity_ino_icai_nationality: 1,

    receivablesaccount: { id: "2724" },

    custentity_ino_icai_appseq_no: c.custentity_ino_icai_appseq_no || "",
    custentity_ino_icai_father_name: c.custentity_ino_icai_father_name || "",
    custentity_ino_icai_dob: c.custentity_ino_icai_dob || "",
    custentity_permanent_account_number: c.custentity_permanent_account_number || "",
    custentity_ino_icai_regno: c.custentity_ino_icai_regno || "",
    custentity_ino_icai_source_portal: "SSP",

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
    `[MembershipSync] [Form 2] Creating member customer: entityid=${memberEntityId}`
  );

  const newCustomer = await withRetry(
    () => createCustomerRecord(newCustomerData),
    `CreateCustomer:${memberEntityId}`
  );

  console.log(
    `[MembershipSync] [Form 2] Member customer created: id=${newCustomer.id}`
  );

  return newCustomer;
}

function checkStudentMember(item) {
  const sub = item.Subsidiary;
  if (sub === "Examination") {
    return {
      category:                { id: "2" },
      subsidiary:              { id: "171" },
      additionalSubsidiaryIds: ["168", "170"],
    };
  }
  if (sub === "Delhi") {
    return {
      category:                { id: "1" },
      subsidiary:              { id: "168" },
      additionalSubsidiaryIds: ["170", "171"],
    };
  }
  // Noida → student
  return {
    category:                { id: "2" },
    subsidiary:              { id: "170" },
    additionalSubsidiaryIds: ["168", "171"],
  };
}

async function addAdditionalSubsidiary(customerId, additionalSubsidiaryIds) {
  if (!additionalSubsidiaryIds || additionalSubsidiaryIds.length === 0) return;

  const existing = await netsuiteRequest(
    "POST",
    "/services/rest/query/v1/suiteql?limit=100",
    { q: `SELECT subsidiary FROM customersubsidiaryrelationship WHERE entity = ${customerId}` }
  );
  const existingIds = new Set((existing.items || []).map(r => String(r.subsidiary)));

  for (const subsidiaryId of additionalSubsidiaryIds) {
    if (existingIds.has(String(subsidiaryId))) {
      console.log(`[SUBSIDIARY] Subsidiary ${subsidiaryId} already linked to customer ${customerId} — skipping`);
      continue;
    }
    try {
      await netsuiteRequest(
        "POST",
        "/services/rest/record/v1/customersubsidiaryrelationship",
        {
          entity:     { id: String(customerId) },
          subsidiary: { id: String(subsidiaryId) },
        }
      );
      console.log(`[SUBSIDIARY] Linked subsidiary ${subsidiaryId} to customer ${customerId}`);
    } catch (err) {
      const detail = err.response?.data?.["o:errorDetails"]?.[0]?.detail || "";
      console.error(`[SUBSIDIARY] Failed subsidiary ${subsidiaryId} for customer ${customerId}: ${detail || err.message}`);
    }
  }
}

module.exports = { duplicateCustomerAsMember, fetchCustomerByEntityId, checkStudentMember, addAdditionalSubsidiary };
