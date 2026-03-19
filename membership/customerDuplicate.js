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

  function pickId(field) {
    if (!field) return null;
    if (typeof field === "object" && field.id) return { id: String(field.id) };
    return field;
  }

  const gstin = c.custentity_ino_icai_gstin || "";
  const hasGSTIN = typeof gstin === "string" && gstin.trim().length > 0;
  const hasMembershipId = newEntityId && newEntityId.trim().length > 0;

  const newCustomerData = {
    autoname: false,
    entityid: newEntityId,
    isPerson: true,
    firstName: c.firstName || "",
    middleName: c.middleName || "",
    lastName: c.lastName || ".",
    email: c.email || c.altEmail || `${newEntityId}@placeholder.icai.org`,
    altEmail: c.altEmail || "",
    phone: c.phone || "",
    altPhone: c.altPhone || "",

    subsidiary: { id: "168" },
    category: { id: "1" },
    custentity_ino_icai_nationality: 1,

    receivablesaccount: { id: hasMembershipId ? "2724" : "2725" },

    custentity_ino_icai_appseq_no: transaction.Customer_ID,
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

module.exports = { duplicateCustomerAsMember, fetchCustomerByEntityId };
