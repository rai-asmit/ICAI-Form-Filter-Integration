"use strict";

const msConfig = require("../membershipStudentConfig.json");

const TAX_RATE = 18;
const GST_RATE_ID = "4"; // 18% GST rate in NetSuite
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 2000;

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

function parseFeeHeads(feeHeadArray) {
  if (!Array.isArray(feeHeadArray)) return [];

  return feeHeadArray
    .map((entry, index) => {
      const n = index + 1;
      let code = entry[`FeeHeadCode${n}`] || null;
      let description = entry[`FeeHead${n}`] || "";
      let amount = parseFloat(entry[`FeeAmount${n}`]) || 0;

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

module.exports = {
  TAX_RATE,
  GST_RATE_ID,
  parseDateDDMMYYYY,
  getMonthYear,
  toSelectField,
  firstNonEmpty,
  parseFeeHeads,
  classifyFeeHeads,
  getConfigForForm,
  getAllAllowedForms,
  withRetry,
};
