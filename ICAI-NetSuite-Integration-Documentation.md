# ICAI to NetSuite Transaction Sync - Integration Documentation

---

## Table of Contents

1. [Overview](#1-overview)
2. [How the Integration Works](#2-how-the-integration-works)
3. [Webhook Endpoint](#3-webhook-endpoint)
4. [Supported Form Types](#4-supported-form-types)
5. [What Gets Created in NetSuite](#5-what-gets-created-in-netsuite)
6. [Sample API Response](#6-sample-api-response)
7. [Where Data Is Stored](#7-where-data-is-stored)
8. [Logs and Monitoring](#8-logs-and-monitoring)
9. [Duplicate Handling](#9-duplicate-handling)
10. [Error Handling and Retries](#10-error-handling-and-retries)
11. [Environment Configuration](#11-environment-configuration)
12. [Frequently Asked Questions](#12-frequently-asked-questions)

---

## 1. Overview

This integration automates the daily synchronization of financial transactions between the **ICAI eServices Portal** and **NetSuite ERP**.

**In simple terms:** Every day, this system pulls all new transactions (membership fees, student registrations, exam enrollments, etc.) from the ICAI portal and automatically creates the corresponding financial records (Sales Orders, Invoices, Payments, Journal Entries) in NetSuite - without any manual data entry.

### Key Highlights

- **Fully automated** - Triggered via a single webhook call (can be scheduled externally)
- **Two processing pipelines** - Membership/Student transactions and Examination transactions are handled separately with their own business rules
- **Duplicate-safe** - Transactions that have already been processed are automatically skipped
- **Real-time logging** - All activity is streamed to a remote logging dashboard for monitoring
- **Daily file storage** - Every transaction and its processing result is saved in organized daily folders for audit and troubleshooting

---

## 2. How the Integration Works

The integration follows a straightforward step-by-step process each time it runs:

### Step-by-Step Flow

```
Step 1: AUTHENTICATE
   The system logs into the ICAI portal using stored credentials
   and receives a temporary access token.

Step 2: FETCH TRANSACTIONS
   Using the access token, the system pulls all transactions
   from yesterday's date. Transactions are fetched in batches
   of 800 records at a time until all records are retrieved.

Step 3: SAVE RAW DATA
   All fetched transactions are saved as-is to a file
   (transaction.json) for reference and audit purposes.

Step 4: SPLIT BY FORM TYPE
   Transactions are automatically separated into two groups:
   - Group A: Membership & Student Registration forms
   - Group B: Examination Enrollment forms

Step 5: PROCESS BOTH GROUPS (in parallel)
   Both groups are processed at the same time for speed.
   Each transaction goes through its own pipeline to create
   the appropriate NetSuite records.

Step 6: RETURN RESULTS
   A summary of what was processed, what succeeded, and what
   failed is returned as the API response.
```

### Visual Flow

```
ICAI Portal ──> Webhook Triggered ──> Fetch Transactions
                                           │
                              ┌─────────────┴─────────────┐
                              │                           │
                    Membership/Student              Examination
                       Pipeline                     Pipeline
                         │                             │
                   ┌─────┴─────┐                 ┌─────┴─────┐
                   │           │                 │           │
              Sales Order  Journal          Sales Order  Customer
                   │       Entry                │        Deposit
                Invoice                      Invoice
                   │
            Customer Payment
                              │                           │
                              └─────────────┬─────────────┘
                                            │
                                     Combined Results
                                     + Daily Log Files
```

---

## 3. Webhook Endpoint

### Endpoint Details

| Property     | Value                                          |
|-------------|------------------------------------------------|
| **Method**  | `POST`                                         |
| **URL**     | `/webhook/form-based-transactions/:id`         |
| **Port**    | `3003` (default)                               |

### How to Call It

Send a **POST** request to:

```
http://<server-address>:3003/webhook/form-based-transactions/<integrationId>
```

**Parameters:**

| Parameter       | Location | Required | Description                                                  |
|----------------|----------|----------|--------------------------------------------------------------|
| `id`           | URL Path | Yes      | A unique identifier for this integration run. Used to tag all logs so you can filter and trace a specific run in the logging dashboard. |

**Request Body:** None required. The endpoint does not expect any body payload.

### Example Call

```
POST http://localhost:3003/webhook/form-based-transactions/run-2026-03-25
```

No headers or body needed - just the URL with your chosen integration ID.

### What Happens When You Call It

1. The system authenticates with ICAI
2. Fetches all yesterday's transactions
3. Filters out duplicates (already processed)
4. Creates NetSuite records for new transactions
5. Returns a summary response

### Response Codes

| Status Code | Meaning                                                       |
|-------------|---------------------------------------------------------------|
| `200`       | Sync completed (check response body for individual transaction results) |
| `400`       | Missing integration ID in the URL                             |
| `500`       | A fatal error occurred (authentication failure, network error, etc.) |

> **Note:** A `200` response means the sync process ran successfully, but some individual transactions within the batch may have failed. Always check the response body for detailed results.

---

## 4. Supported Form Types

The integration handles two categories of forms, each with its own processing rules:

### Category A: Membership & Student Forms

| Form Name                    | Description                               |
|------------------------------|-------------------------------------------|
| **Form 2**                   | New Membership Application                |
| **Form 6**                   | Certificate of Practice (COP) Application |
| **Form 3 / Fellowship**      | Fellowship Application                    |
| **Student Registration Form** | New Student Registration                  |

### Category B: Examination Forms

| Form Name                              | Description                               |
|----------------------------------------|-------------------------------------------|
| **Exam Enrollment Final**              | Final exam enrollment                     |
| **Exam Enrollment Intermediate**       | Intermediate exam enrollment              |
| **Exam Enrollment Foundation**         | Foundation exam enrollment                |
| **Exam Enrollment Correction** (all variants) | Correction requests for exam enrollments |
| All other non-membership forms          | Routed to examination pipeline            |

> Any transaction that does not match a Membership/Student form is automatically routed to the Examination pipeline.

---

## 5. What Gets Created in NetSuite

Depending on the form type, different records are created in NetSuite for each transaction:

### For Membership & Student Transactions

| Step | NetSuite Record     | Purpose                                                                                    |
|------|---------------------|--------------------------------------------------------------------------------------------|
| 1    | **Sales Order**      | The primary order record with all fee line items, tax calculations, and reference numbers  |
| 2    | **Customer Duplicate** (Form 2 only) | For new memberships, the student record is duplicated as a member record in NetSuite |
| 3    | **Invoice**          | Created from the Sales Order to record the receivable                                     |
| 4    | **Journal Entry**    | Created only if the transaction includes contribution items (e.g., Benevolent Fund, CA Foundation) |
| 5    | **Customer Payment** | Records the actual payment received, applied against the Invoice and Journal Entry        |

### For Examination Transactions

| Step | NetSuite Record       | Purpose                                                                   |
|------|-----------------------|---------------------------------------------------------------------------|
| 1    | **Sales Order**        | Order record with exam fee line items and event/seminar classification   |
| 2    | **Customer Deposit**   | Records the payment as a deposit linked to the Sales Order              |
| 3    | **Invoice**            | Created from the Sales Order to record the receivable                   |

### Key Details

- **Tax Handling:** Membership/Student transactions include 18% GST calculated per line item. Examination transactions do not include tax.
- **Customer Lookup:** Before processing, the system checks NetSuite for the customer using their ICAI membership/student ID.
- **Form 2 Special Handling:** When a student becomes a member (Form 2), the system automatically creates a copy of the student record as a new member record in NetSuite, including addresses and personal details.

---

## 6. Sample API Response

When the webhook is called, it returns a JSON response with a complete summary:

### Successful Sync Response

```json
{
  "success": true,
  "message": "Form-based transaction sync completed",
  "totalFetched": 500,
  "membershipCount": 200,
  "examCount": 300,
  "totalProcessed": 485,
  "totalFailed": 15,
  "durationMs": 45000,
  "membership": {
    "processed": 190,
    "failed": 10,
    "duplicatesSkipped": 5,
    "salesOrders": {
      "success": 190,
      "failure": 10
    },
    "invoices": {
      "success": 188,
      "failure": 2
    },
    "customerPayments": {
      "success": 185,
      "failure": 5
    },
    "journalEntries": {
      "success": 30,
      "failure": 2
    }
  },
  "examination": {
    "processed": 295,
    "failed": 5,
    "duplicatesSkipped": 8,
    "salesOrders": {
      "success": 295,
      "failure": 5
    },
    "customerDeposits": {
      "success": 293,
      "failure": 2
    },
    "invoices": {
      "success": 290,
      "failure": 5
    }
  }
}
```

### Response Fields Explained

| Field              | Description                                                          |
|--------------------|----------------------------------------------------------------------|
| `success`          | Whether the overall sync process completed without a fatal error     |
| `totalFetched`     | Total number of transactions pulled from ICAI                        |
| `membershipCount`  | How many transactions were routed to the Membership/Student pipeline |
| `examCount`        | How many transactions were routed to the Examination pipeline        |
| `totalProcessed`   | Total transactions successfully processed across both pipelines      |
| `totalFailed`      | Total transactions that failed across both pipelines                 |
| `durationMs`       | How long the entire sync took in milliseconds                        |
| `membership`       | Detailed breakdown of the Membership/Student pipeline results        |
| `examination`      | Detailed breakdown of the Examination pipeline results               |

### Error Response (Missing Integration ID)

```json
{
  "error": "Missing integrationId"
}
```

### Error Response (Fatal Failure)

```json
{
  "success": false,
  "error": "Authentication failed: Invalid credentials"
}
```

---

## 7. Where Data Is Stored

All transaction data and processing results are stored in **daily folders** on the server's file system. This makes it easy to find, audit, and troubleshoot any specific day's sync.

### Folder Structure

```
data/
└── 2026/
    └── 03/
        └── 25/
            ├── transaction.json              ← All raw transactions fetched from ICAI
            ├── incoming.json                 ← New (unique) transactions to be processed
            ├── duplicates.json               ← Transactions skipped (already processed before)
            ├── sales-order-success.json       ← Successfully created Sales Orders
            ├── sales-order-failure.json       ← Failed Sales Order creations
            ├── invoice-success.json           ← Successfully created Invoices
            ├── invoice-failure.json           ← Failed Invoice creations
            ├── customer-payment-success.json  ← Successfully created Customer Payments
            ├── customer-payment-failure.json  ← Failed Customer Payment creations
            ├── journal-voucher-success.json   ← Successfully created Journal Entries
            ├── journal-voucher-failure.json   ← Failed Journal Entry creations
            ├── customer-deposit-success.json  ← Successfully created Customer Deposits
            ├── customer-deposit-failure.json  ← Failed Customer Deposit creations
            ├── sync-summary.json             ← Final summary for Membership pipeline
            └── exam-sync-summary.json        ← Final summary for Examination pipeline
```

### File Details

| File                     | What It Contains                                                                                  |
|--------------------------|---------------------------------------------------------------------------------------------------|
| `transaction.json`       | The complete raw data as received from ICAI - useful for verifying what was fetched               |
| `incoming.json`          | Only the new, unique transactions that were actually processed (duplicates removed)               |
| `duplicates.json`        | List of transactions that were skipped because they had already been processed in a previous run  |
| `*-success.json`         | Details of each successfully created NetSuite record (includes NetSuite record IDs)               |
| `*-failure.json`         | Details of each failed record creation (includes the error message and transaction data)          |
| `sync-summary.json`      | Complete end-to-end summary of the Membership/Student pipeline run                               |
| `exam-sync-summary.json` | Complete end-to-end summary of the Examination pipeline run                                      |

### Global Tracking File

```
data/
└── processed-records.json    ← Master list of all previously processed transactions
```

This file keeps track of every transaction that has been successfully processed across all days. It is used to prevent duplicate processing (see Section 9).

> **Tip:** To investigate a specific day's sync, navigate to `data/YYYY/MM/DD/` and review the relevant files. The `*-failure.json` files are the best starting point for troubleshooting.

---

## 8. Logs and Monitoring

### Real-Time Log Streaming

All logs from every sync run are streamed in real-time to the **Nidish Logging Dashboard**:

- **Log Dashboard URL:** `https://api.nidish.com/api/logs/stream`
- **Filtering:** Each log entry is tagged with the `integrationId` you provide when calling the webhook, so you can filter logs for a specific run

### What Gets Logged

| Log Event                        | Example Message                                                         |
|----------------------------------|-------------------------------------------------------------------------|
| Sync started                     | `"Starting form-based transaction sync..."`                             |
| Authentication result            | `"Authenticated with ICAI successfully"`                                |
| Transaction fetch progress       | `"Fetched batch 1: 800 records (total so far: 800)"`                   |
| Duplicate detection              | `"Skipping 12 duplicate transactions"`                                  |
| Sales Order created              | `"Sales Order created for REF-12345 (NetSuite ID: 98765)"`             |
| Invoice created                  | `"Invoice created for REF-12345"`                                       |
| Payment applied                  | `"Customer Payment created for REF-12345"`                              |
| Errors                           | `"Failed to create Sales Order for REF-12345: Customer not found"`      |
| Sync completed                   | `"Sync complete. Processed: 485, Failed: 15, Duration: 45s"`           |

### Log Entry Format

Each log entry contains:

| Field            | Description                                              |
|------------------|----------------------------------------------------------|
| `integrationId`  | The ID you provided when triggering the webhook          |
| `message`        | The log message describing what happened                 |
| `level`          | Either `info` (normal activity) or `error` (something went wrong) |
| `source`         | Which part of the system generated the log (e.g., "Form-Based Transaction Sync") |
| `timestamp`      | The exact date and time of the log event                 |

### How to Monitor a Sync Run

1. Trigger the webhook with a meaningful integration ID (e.g., `daily-sync-2026-03-25`)
2. Open the Nidish logging dashboard
3. Filter by the integration ID you used
4. Watch the logs stream in real-time as the sync progresses
5. Look for any `error` level logs to identify issues

> **Note:** Logs are sent in batches (every 500 milliseconds) for efficiency, so there may be a slight delay between when an action occurs and when it appears in the dashboard.

---

## 9. Duplicate Handling

The system has built-in protection against processing the same transaction twice.

### How It Works

1. Every transaction from ICAI has a unique combination of **Reference Number** and **Payment Order ID**
2. When a transaction is successfully processed, this unique key is saved to the master tracking file (`data/processed-records.json`)
3. On the next run, before processing any transaction, the system checks if it has already been processed
4. If a match is found, the transaction is skipped and logged in `duplicates.json` for that day

### What This Means

- **Safe to re-run:** You can trigger the webhook multiple times for the same day without worrying about creating duplicate records in NetSuite
- **Audit trail:** Skipped duplicates are recorded in the daily `duplicates.json` file, so you can verify what was skipped and why
- **Cross-day protection:** The master tracking file persists across days, so even if ICAI returns old transactions, they will not be reprocessed

---

## 10. Error Handling and Retries

### Automatic Retries

The system automatically retries failed operations in two areas:

| Operation             | Retry Attempts | Wait Between Retries       | What Triggers a Retry                    |
|-----------------------|----------------|----------------------------|------------------------------------------|
| ICAI data fetch       | Up to 3 times  | 5 seconds                  | Network timeout or server error          |
| NetSuite API calls    | Up to 3 times  | Increasing (2s, 4s, 8s)   | Rate limiting (429) or server errors (503, 504) |

### Transaction-Level Error Handling

- Each transaction is processed **independently** - if one transaction fails, it does not affect the others
- Each step within a transaction (Sales Order, Invoice, Payment, etc.) is tracked separately
- If a Journal Entry fails, the rest of the transaction (Invoice, Payment) still continues
- All failures are recorded in the daily `*-failure.json` files with the error details

### Common Error Scenarios

| Scenario                         | What Happens                                                          |
|----------------------------------|-----------------------------------------------------------------------|
| ICAI portal is down              | Authentication fails, sync stops, error returned in response          |
| Customer not found in NetSuite   | That specific transaction fails, others continue normally             |
| NetSuite rate limit hit          | System waits and retries automatically (up to 3 times)                |
| Network timeout                  | System retries automatically                                          |
| Duplicate transaction detected   | Transaction is skipped (not an error)                                 |
| Invalid fee code in transaction  | A warning is logged, and if other valid items exist, the order is still created |

---

## 11. Environment Configuration

The integration requires the following configuration to be set up before it can run:

### Required Settings

| Setting             | Purpose                                                    |
|---------------------|------------------------------------------------------------|
| **ICAI Credentials** | Username and password for the ICAI eServices portal       |
| **ICAI Org ID**      | Organization identifier for ICAI API access               |
| **NetSuite Account** | The NetSuite account ID                                   |
| **NetSuite OAuth Keys** | Consumer Key, Consumer Secret, Token ID, Token Secret (OAuth 1.0a authentication) |
| **Server Port**      | The port the webhook runs on (default: 3003)              |

### Optional Settings

| Setting             | Purpose                                                    |
|---------------------|------------------------------------------------------------|
| **FRONTEND_URL**     | If a frontend dashboard is used, its URL for CORS access  |
| **ENVIRONMENT**      | Set to `test` or `production` to control behavior         |

> **Important:** All credentials and keys are stored securely in the server's environment configuration file (`.env`) and are never exposed in API responses or logs.

---

## 12. Frequently Asked Questions

### General

**Q: How often does this sync run?**
A: The sync runs each time the webhook endpoint is called. It can be triggered manually or set up with an external scheduler (e.g., a daily cron job) to run automatically at a specific time.

**Q: What date range does it process?**
A: By default, it fetches all transactions from **yesterday's date**. This ensures that a full day's worth of transactions is captured after the day has ended.

**Q: How long does a typical sync take?**
A: This depends on the number of transactions. As a rough guide, 500 transactions typically complete in 1-2 minutes.

**Q: Can I run it multiple times in a day?**
A: Yes. The duplicate protection ensures that already-processed transactions are automatically skipped on subsequent runs.

### Troubleshooting

**Q: Some transactions failed. How do I find out why?**
A: Check the daily `*-failure.json` files in `data/YYYY/MM/DD/`. Each failure entry includes the transaction details and the specific error message. You can also filter the logging dashboard by your integration ID to see real-time error logs.

**Q: A transaction was skipped as a duplicate, but I don't see it in NetSuite. What happened?**
A: Check the `data/processed-records.json` file to confirm the transaction key exists. If it does but the NetSuite record is missing, the record may have been deleted in NetSuite after processing. Remove the entry from `processed-records.json` and re-run the sync to reprocess it.

**Q: The sync returned 200 but many transactions failed. Is that normal?**
A: Yes. A `200` response means the sync process itself ran without a fatal error. Individual transaction failures (e.g., customer not found, invalid data) are expected in some cases. Review the response body and failure files for details.

**Q: The webhook is returning a 500 error. What should I check?**
A: Common causes include:
  - ICAI portal credentials have expired or changed
  - NetSuite OAuth tokens have been revoked or expired
  - The server cannot reach the ICAI or NetSuite APIs (network issue)
  - Check the logging dashboard for the specific error message

**Q: How do I verify that records were created correctly in NetSuite?**
A: The `*-success.json` files contain the NetSuite record IDs for every successfully created record. You can use these IDs to look up the records directly in NetSuite.

---

*This document covers the ICAI to NetSuite Transaction Sync integration. For technical implementation details, refer to the source code and inline comments.*
