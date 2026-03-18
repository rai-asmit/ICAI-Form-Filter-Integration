# Dry Run Walkthrough — Membership & Student Sync

This document walks through **exactly what happens** for each form type
when the webhook `/webhook/membership/:id` is triggered.

We use the **real sample data** you provided.

---

## HOW IT STARTS

1. Someone hits: `POST http://your-server/webhook/membership/123`
2. Code authenticates with ICAI portal (username/password → token)
3. Fetches ALL transactions for the date range (e.g., yesterday)
4. Filters: keeps only **Form 2, Form 6, Form 3/Fellowship, Student Registration Form**
5. Fetches all matching customers from NetSuite (bulk lookup)
6. Processes each transaction one by one (5 at a time in parallel)

---

## CASE 1: Form 2 — New Membership (Rs. 9,080)

### Input Transaction:
```
Customer_ID     : CRO0203923 (existing student)
Application_number: 5819010 (new member ID)
Payment_Amount  : 9080
IGST            : 1080
Form_Description: Form 2

Fee_Head:
  M08 = 2000  (Member Entrance Fee)       → REGULAR
  M99 = -500  (e-Journal Discount)         → DISCOUNT
  M23 = 500   (SVA Voluntary Contribution) → CONTRIBUTION
  M15 = 500   (CABF Voluntary)             → CONTRIBUTION
  M07 = 3000  (Member COP Fee)             → REGULAR
  M18 = 1000  (SVA Life Contribution)      → CONTRIBUTION
  M05 = 1500  (Membership Fee - Associate) → REGULAR
```

### Step 1: Classify Fee Heads

The code splits these into two groups:

```
INVOICE ITEMS (go on Sales Order & Invoice):
  M08 = 2000  (Regular)
  M99 = -500  (Discount)
  M07 = 3000  (Regular)
  M05 = 1500  (Regular)
  ─────────────
  Subtotal = 6,000

CONTRIBUTION ITEMS (go on Journal Voucher ONLY):
  M23 = 500
  M15 = 500
  M18 = 1000
  ─────────────
  Subtotal = 2,000
```

### Step 2: Duplicate Customer (Form 2 ONLY)

```
BEFORE:
  Search NetSuite for customer: entityid = "CRO0203923"
  Found: id=1751391, category=Student, subsidiary=Noida

AFTER:
  Create NEW customer in NetSuite:
    entityid    = "5819010"        ← Application_number
    category    = Member (id: 1)   ← changed from Student
    subsidiary  = Delhi (id: 168)  ← changed from Noida
    isPerson    = true
    firstName   = (copied from CRO0203923)
    lastName    = (copied from CRO0203923)
    email       = (copied from CRO0203923)
    phone       = (copied from CRO0203923)
    gender      = (copied)
    region      = (copied)
    father_name = (copied)
    address     = (copied)
    receivablesaccount = { id: "2724" }  ← AR Member

  NetSuite returns: new customer id = 2463268
```

**Why?** Because a student becomes a member. ICAI needs a separate
customer record with category "Member" for all future member transactions.

### Step 3: Create Sales Order

```
POST /record/v1/salesOrder

{
  entity: { id: "2463268" }          ← the NEW member customer
  tranDate: "2025-10-28"
  subsidiary: { id: "168" }          ← Delhi
  location: { id: "285" }
  department: { id: "267" }

  item: {
    items: [
      {
        item: { id: "619" }          ← M08 (Member Entrance Fee)
        quantity: 1
        rate: 2000
        amount: 2000
        tax1amt: 360                 ← 18% of 2000
        grossamt: 2360               ← 2000 + 360
        custcol_in_gst_rate: { id: "4" }
      },
      {
        item: { id: "631" }          ← M99 (e-Journal Discount)
        rate: -500
        amount: -500
        tax1amt: -90                 ← 18% of -500
        grossamt: -590
      },
      {
        item: { id: "618" }          ← M07 (COP Fee)
        rate: 3000
        amount: 3000
        tax1amt: 540
        grossamt: 3540
      },
      {
        item: { id: "616" }          ← M05 (Membership Fee)
        rate: 1500
        amount: 1500
        tax1amt: 270
        grossamt: 1770
      }
    ]
  }

  subtotal: 6000
  taxtotal: 1080
  total: 7080
}
```

**Notice:** M23, M15, M18 (contributions) are NOT here. They go to JV.

NetSuite returns: `SO id = 7441083`

### Step 4: Create Customer Deposit

```
POST /record/v1/customerDeposit

{
  salesorder: { id: "7441083" }      ← linked to SO
  payment: 9080                      ← FULL amount (includes contributions!)
  tranDate: "2025-10-28"
  custbody_inoday_icai_igst_val: 1080  ← IGST present, so use IGST field

  memo: "ONC000019777620251028171739657"
  department: { id: "267" }
  location: { id: "285" }
}
```

**Why full 9080?** Because the customer actually paid 9080 to ICAI.
The CD must match what the bank received. The split between invoice
and contribution happens in accounting (SO vs JV), not in CD.

NetSuite returns: `CD id = 7441084`

### Step 5: Create Invoice (SO → Invoice Transform)

```
POST /record/v1/salesOrder/7441083/!transform/invoice

{
  approvalStatus: { id: "2" }
  tranDate: "2025-10-28"
  department: { id: "267" }
  location: { id: "285" }
}
```

NetSuite takes SO 7441083 and creates an Invoice with the SAME line items:
- M08 = 2000 + tax
- M99 = -500 + tax
- M07 = 3000 + tax
- M05 = 1500 + tax

**Invoice total = 7,080** (6000 + 1080 tax)

NetSuite returns: `Invoice id = 7441183`

### Step 6: Create Journal Voucher (Contributions)

```
POST /record/v1/journalEntry

{
  tranDate: "2025-10-28"
  subsidiary: { id: "168" }
  memo: "Contribution JV - ONC000019777620251028171739657"

  line: {
    items: [
      {
        account: { id: "2724" }      ← DEBIT (total contribution)
        debit: 2000                  ← 500 + 500 + 1000
      },
      {
        account: { id: "2764" }      ← CREDIT (SVA Voluntary)
        credit: 500
        entity: { id: "630" }        ← Vendor: SVA Fund
        custcol_inoday_icai_type: { id: "213" }
        custcol_ino_icia_duplicate_class: { id: "414" }
      },
      {
        account: { id: "2764" }      ← CREDIT (CABF)
        credit: 500
        entity: { id: "627" }        ← Vendor: CABF
      },
      {
        account: { id: "2764" }      ← CREDIT (SVA Life)
        credit: 1000
        entity: { id: "628" }        ← Vendor: SVA Life Fund
      }
    ]
  }
}
```

**Why JV?** Because contributions are NOT revenue for ICAI.
They are funds collected on behalf of CABF / S.Vaidyanathan Fund.
JV moves the money from ICAI's receivable (2724) to the fund account (2764).

NetSuite returns: `JV id = 7441200`

### Step 7: Deposit Application

```
POST /record/v1/customerDeposit/7441084/!transform/depositApplication

{
  apply: {
    items: [
      {
        apply: true,
        doc: { id: 7441183, type: "invoice" }
      }
    ]
  }
}
```

This tells NetSuite: "The money in CD 7441084 (Rs 9080) should be
applied against Invoice 7441183 (Rs 7080)."

This **closes the invoice** — marks it as PAID.

NetSuite returns: `DepositApp id = 7441250`

### Final Result for Form 2:
```
Customer Duplication : 2463268 (new member)
Sales Order          : 7441083 (4 line items, Rs 7,080 with tax)
Customer Deposit     : 7441084 (Rs 9,080 — full payment)
Invoice              : 7441183 (Rs 7,080 — same as SO)
Journal Voucher      : 7441200 (Rs 2,000 — contributions only)
Deposit Application  : 7441250 (closes invoice)
```

### Money Flow:
```
Customer paid         = 9,080
Invoice (revenue)     = 7,080  (6,000 fees + 1,080 tax)
JV (fund transfer)    = 2,000  (contributions to CABF/SVA)
CD (bank receipt)     = 9,080  (matches bank statement)
                        ─────
                        9,080 = 7,080 + 2,000  ✓ balanced
```

---

## CASE 2: Form 6 — COP & Differential Fees (Rs. 4,012)

### Input Transaction:
```
Customer_ID     : 044406 (existing member — no duplication)
Payment_Amount  : 4012
IGST            : 612
Form_Description: Form 6

Fee_Head:
  M07 = 3000  (Member COP Fee)            → REGULAR
  M05 = 400   (Membership Fee - Associate) → REGULAR
```

### What's Different from Form 2?

1. **NO customer duplication** — customer 044406 already exists as a member
2. **NO contributions** — only M07 and M05 (both Regular)
3. **NO Journal Voucher** — skipped because contributionItems = []

### Step by Step:

```
Step 1: Classify
  Invoice items: M07(3000), M05(400) → subtotal = 3,400
  Contributions: none

Step 2: Customer
  Skip duplication (not Form 2)
  Use existing customer 044406 from NetSuite

Step 3: Sales Order
  2 line items:
    M07: rate=3000, tax1amt=540, grossamt=3540
    M05: rate=400,  tax1amt=72,  grossamt=472
  subtotal=3400, taxtotal=612, total=4012

Step 4: Customer Deposit
  payment = 4012 (full amount)
  IGST = 612

Step 5: Invoice (from SO transform)
  Same 2 line items, total = 4,012

Step 6: Journal Voucher
  SKIPPED — no contribution items

Step 7: Deposit Application
  Apply CD to Invoice → Invoice marked as PAID
```

### Final Result for Form 6:
```
Customer Duplication : SKIPPED (not Form 2)
Sales Order          : created (2 items, Rs 4,012)
Customer Deposit     : created (Rs 4,012)
Invoice              : created (Rs 4,012)
Journal Voucher      : SKIPPED (no contributions)
Deposit Application  : created (closes invoice)
```

---

## CASE 3: Form 3/Fellowship — Applied for Fellowship (Rs. 5,900)

### Input Transaction:
```
Customer_ID     : 310179 (existing member — no duplication)
Payment_Amount  : 5900
IGST            : 900
Form_Description: Form 3/Fellowship

Fee_Head:
  M10 = 1500  (Member-Fellow Conversion)   → REGULAR
  M07 = 1000  (Member COP Fee - Fellow)    → REGULAR
  M09 = 2500  (Member-Fellow Admission)    → REGULAR
```

### What's Different?

- Same as Form 6 — no duplication, no contributions
- Different item codes: M10 (id:621), M09 (id:620) are Fellowship-specific
- Everything else identical

### Step by Step:

```
Step 1: Classify
  Invoice items: M10(1500), M07(1000), M09(2500) → subtotal = 5,000
  Contributions: none

Step 2: Customer
  Skip duplication (not Form 2)
  Use existing customer 310179

Step 3: Sales Order
  3 line items:
    M10: rate=1500, tax1amt=270, grossamt=1770
    M07: rate=1000, tax1amt=180, grossamt=1180
    M09: rate=2500, tax1amt=450, grossamt=2950
  subtotal=5000, taxtotal=900, total=5900

Step 4: Customer Deposit
  payment = 5900
  IGST = 900

Step 5: Invoice (from SO transform)
  Same 3 items, total = 5,900

Step 6: Journal Voucher
  SKIPPED — no contributions

Step 7: Deposit Application
  Apply CD to Invoice → PAID
```

### Final Result for Form 3:
```
Customer Duplication : SKIPPED
Sales Order          : created (3 items, Rs 5,900)
Customer Deposit     : created (Rs 5,900)
Invoice              : created (Rs 5,900)
Journal Voucher      : SKIPPED
Deposit Application  : created
```

---

## CASE 4: Student Registration — Intermediate (Rs. 18,000)

### Input Transaction:
```
Customer_ID     : WRO0865842 (existing student)
Payment_Amount  : 18000
IGST            : (empty — no tax for student)
Subsidiary      : Noida
Form_Description: Student Registration Form

Fee_Head:
  S146 = 2000   (Student Activities Fees)          → REGULAR
  S147 = 1000   (Registration Fees as Article)     → REGULAR
  S145 = 15000  (Intermediate Reg Fees with BOS)   → REGULAR
```

### What's Different?

1. **Different subsidiary** — Noida (170) instead of Delhi (168)
2. **Different location** — 287 instead of 285
3. **NO tax** — Student registration has no GST (IGST is empty)
4. **NO contributions** — Student fees don't have fund items
5. **NO customer duplication** — not Form 2
6. **NO Journal Voucher** — no contributions

### Step by Step:

```
Step 1: Classify
  Invoice items: S146(2000), S147(1000), S145(15000) → subtotal = 18,000
  Contributions: none (student config has contribution_codes = [])

Step 2: Customer
  Use existing student customer WRO0865842

Step 3: Sales Order
  subsidiary = 170 (Noida)
  location = 287
  3 line items:
    S146: item id=641, rate=2000, tax1amt=360, grossamt=2360
    S147: item id=646, rate=1000, tax1amt=180, grossamt=1180
    S145: item id=640, rate=15000, tax1amt=2700, grossamt=17700

  NOTE: Tax IS calculated at 18% per line item in the code.
  If student fees should NOT have tax, this needs to be discussed.
  The ICAI portal sends empty IGST for students — but the code
  currently applies 18% regardless. Let me know if student fees
  should have 0% tax.

Step 4: Customer Deposit
  payment = 18000
  No GST fields (IGST/CGST/SGST all empty)

Step 5: Invoice (from SO transform)
  Same 3 items

Step 6: Journal Voucher
  SKIPPED — no contributions

Step 7: Deposit Application
  Apply CD to Invoice → PAID
```

### Final Result for Student Registration (Intermediate):
```
Customer Duplication : SKIPPED
Sales Order          : created (3 items, subsidiary=Noida)
Customer Deposit     : created (Rs 18,000)
Invoice              : created
Journal Voucher      : SKIPPED
Deposit Application  : created
```

---

## CASE 5: Student Registration — Final (Rs. 22,000)

### Input Transaction:
```
Customer_ID     : WRO0790590
Payment_Amount  : 22000
Form_Description: Student Registration Form

Fee_Head:
  S154 = 22000 (Final Registration Fee) → REGULAR
```

### Same as Case 4, but:
- Only 1 line item (S154, id=643)
- Higher amount

```
Sales Order : 1 line item (S154 = 22000)
CD          : 22000
Invoice     : 22000
JV          : SKIPPED
DepositApp  : created
```

---

## CASE 6: Student Registration — Foundation (Rs. 9,000)

### Input Transaction:
```
Customer_ID     : APP4108754
Payment_Amount  : 9000
Form_Description: Student Registration Form

Fee_Head:
  S138 = 9000 (Foundation Tuition Fee) → REGULAR
```

### Same as Case 4, but:
- Only 1 line item (S138, id=637)

```
Sales Order : 1 line item (S138 = 9000)
CD          : 9000
Invoice     : 9000
JV          : SKIPPED
DepositApp  : created
```

---

## COMPARISON TABLE — All 6 Cases

| Step | Form 2 (New Member) | Form 6 (COP) | Form 3 (Fellowship) | Student (Intermediate) | Student (Final) | Student (Foundation) |
|------|---------------------|---------------|----------------------|------------------------|-----------------|----------------------|
| Duplicate Customer | YES (Student→Member) | NO | NO | NO | NO | NO |
| Subsidiary | Delhi (168) | Delhi (168) | Delhi (168) | Noida (170) | Noida (170) | Noida (170) |
| Location | 285 | 285 | 285 | 287 | 287 | 287 |
| SO Line Items | M08,M99,M07,M05 | M07,M05 | M10,M07,M09 | S146,S147,S145 | S154 | S138 |
| Contributions on SO? | NO (excluded) | NO | NO | NO | NO | NO |
| Tax per line? | YES (18%) | YES (18%) | YES (18%) | YES (18%)* | YES (18%)* | YES (18%)* |
| CD Amount | 9,080 (full) | 4,012 (full) | 5,900 (full) | 18,000 (full) | 22,000 (full) | 9,000 (full) |
| Invoice | YES (from SO) | YES (from SO) | YES (from SO) | YES (from SO) | YES (from SO) | YES (from SO) |
| Journal Voucher | YES (M23,M15,M18) | NO | NO | NO | NO | NO |
| Deposit Application | YES | YES | YES | YES | YES | YES |

*Note: Student registration tax may need discussion — ICAI sends empty IGST for students.

---

## WHAT COULD GO WRONG (Common Errors)

| Error | Cause | Fix |
|-------|-------|-----|
| "Customer not found in NetSuite" | Customer_ID doesn't exist | Check if customer was created in NetSuite first |
| "No valid line items for SO" | All fee head codes have null internal_id | Add missing IDs in membershipStudentConfig.json |
| "Invalid Field Value for account" | Wrong account for the subsidiary | Check CD account matches subsidiary |
| "You must apply the deposit to at least one item" | Deposit Application body wrong | Fixed — now passes invoice ID correctly |
| "Company Name required" | Customer duplication missing fields | Fixed — now copies all fields from student |
| SO/CD/Invoice = undefined | Customer not found, silently failed | Check logs for error before the undefined |

---

## THE BIG PICTURE — Why Each Record Exists

```
ICAI SSP Portal                          NetSuite (Accounting System)
─────────────────                        ────────────────────────────

Member pays Rs 9,080
on SSP portal ────────────────────────► Our Webhook receives transaction
                                              │
                                              ▼
                                        ┌─── Classify Fee Heads ───┐
                                        │                          │
                                        ▼                          ▼
                                   Regular Items              Fund Items
                                   (M05,M07,M08,M99)         (M15,M18,M23)
                                        │                          │
                                        ▼                          ▼
                                   Sales Order                Journal Voucher
                                   "What they bought"         "Fund transfers"
                                   = Rs 6,000 + tax           Debit 2724
                                        │                     Credit 2764
                                        ▼                     per fund vendor
                                   Customer Deposit
                                   "Money received"
                                   = Rs 9,080 (full)
                                        │
                                        ▼
                                   Invoice
                                   "Tax receipt"
                                   = Rs 7,080
                                        │
                                        ▼
                                   Deposit Application
                                   "Apply payment to invoice"
                                   → Invoice status = PAID

End result in NetSuite:
  - Bank balance increased by 9,080    ← CD
  - Revenue recorded = 7,080           ← Invoice (membership fees)
  - Fund liability recorded = 2,000    ← JV (CABF/SVA funds)
  - GST liability recorded = 1,080     ← Tax on invoice lines
  - Invoice is PAID                    ← Deposit Application
  - Everything balanced                ← 7,080 + 2,000 = 9,080 ✓
```

---

## QUICK REFERENCE — Config Used

**Membership (Form 2, Form 6, Form 3):**
- Subsidiary: 168 (Delhi)
- Location: 285
- Department: 267
- Class: 123
- JV Debit Account: 2724
- JV Credit Account: 2764
- Contribution Codes: M15, M18, M23, M22

**Student Registration:**
- Subsidiary: 170 (Noida)
- Location: 287
- Department: 267
- Class: 123
- No contributions (empty array)

**Vendor IDs for JV Credit Lines:**
- M15 (CABF Voluntary): 627
- M13 (CABF Annual): 625
- M22 (SVA Annual): 629
- M23 (SVA Voluntary): 630
- M18 (SVA Life): 628
