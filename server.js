const express = require("express");
const http = require("http");
const {
  runSalesOrderAndDepositSync,
} = require("./syncSalesOrderAndDeposit");
const { runInvoiceSync } = require("./syncInvoice");
const { runInvoiceCronSync } = require("./syncInvoiceCron");
const { runICAISync } = require("./icaiSync");
const { runMembershipStudentSync } = require("./syncMembershipStudent");

const app = express();
app.use(express.json());

const cors = require('cors');

// Add CORS middleware
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:3000',
      process.env.FRONTEND_URL
    ].filter(Boolean);

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Batch log queue — collects logs and flushes every 500ms
const _logQueue = [];
let _flushTimer = null;

function streamLog(integrationId, level, message, source) {
  _logQueue.push({
    integrationId,
    message: typeof message === 'object' ? JSON.stringify(message) : message,
    level,
    source,
    timestamp: new Date().toISOString(),
  });
  if (!_flushTimer) {
    _flushTimer = setTimeout(_flushLogs, 500);
  }
}

async function _flushLogs() {
  _flushTimer = null;
  const batch = _logQueue.splice(0, _logQueue.length);
  for (const entry of batch) {
  //  await fetch('https://localhost/3000/logs/stream', {
    fetch('https://api.nidish.com/api/logs/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }).catch(() => {});
  }
}

// Wrapper to run function with log streaming
async function runWithLogging(integrationId, source, fn) {
  const originalLog = console.log;
  const originalError = console.error;

  // Override console.log for this execution
  console.log = (...args) => {
    originalLog(...args);
    const message = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
    streamLog(integrationId, "info", message, source);
  };

  console.error = (...args) => {
    originalError(...args);
    const message = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
    streamLog(integrationId, "error", message, source);
  };

  try {
    streamLog(integrationId, "info", `Starting ${source}...`, source);
    const result = await fn();
    streamLog(integrationId, "info", `${source} completed successfully`, source);
    return result;
  } catch (err) {
    streamLog(integrationId, "error", `${source} failed: ${err.message}`, source);
    throw err;
  } finally {
    // Restore original console methods
    console.log = originalLog;
    console.error = originalError;
  }
}

// Runs: 1. ICAI Authentication 2. Fetch Transactions 3. Create Sales Orders 4. Create Customer Deposits
app.post("/webhook/icai/:id", async (req, res) => {
  const integrationId = req.params.id;

  if (!integrationId) {
    return res.status(400).json({
      success: false,
      error: "Integration ID is required",
    });
  }

  try {
    // Step 1: Run ICAI Sync (Authentication + Fetch Transactions)
    streamLog(integrationId, "info", "[Combined Webhook] Starting ICAI Sync...", "webhook");
    const icaiResult = await runWithLogging(
      integrationId,
      "ICAI Sync",
      () => runICAISync({ integrationId })
    );
    streamLog(integrationId, "info", `[Combined Webhook] ICAI Sync completed: ${JSON.stringify(icaiResult)}`, "webhook");

    // Step 2: Run Sales Order + Deposit Sync
    streamLog(integrationId, "info", "[Combined Webhook] Starting Sales Order & Deposit Sync...", "webhook");
    const soResult = await runWithLogging(
      integrationId,
      "Sales Order Sync",
      runSalesOrderAndDepositSync
    );
    streamLog(integrationId, "info", `[Combined Webhook] Sales Order & Deposit Sync completed: ${JSON.stringify(soResult)}`, "webhook");

    res.json({
      success: true,
      message: "ICAI Sync + Sales Orders + Deposits completed",
      icai: icaiResult,
      salesOrder: soResult
    });
  } catch (e) {
    streamLog(integrationId, "error", `[Combined Webhook] Error: ${e.message}`, "webhook");
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

// Membership & Student Registration — SO + CD + JV + Invoice in one flow
// Handles: Form 2 (New Membership), Form 6 (COP), Form 3/Fellowship, Student Registration Form
app.post("/webhook/membership/:id", async (req, res) => {
  const integrationId = req.params.id;

  if (!integrationId) {
    return res.status(400).json({
      success: false,
      error: "Integration ID is required",
    });
  }

  try {
    streamLog(integrationId, "info", "[Membership Webhook] Starting Membership/Student Sync...", "webhook");
    const result = await runWithLogging(
      integrationId,
      "Membership Student Sync",
      () => runMembershipStudentSync({ integrationId })
    );
    streamLog(integrationId, "info", `[Membership Webhook] Sync completed: ${JSON.stringify({ processed: result.processed, failed: result.failed })}`, "webhook");

    res.json(result);
  } catch (e) {
    streamLog(integrationId, "error", `[Membership Webhook] Error: ${e.message}`, "webhook");
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

// Invoice Cron — runs daily, creates invoices for SOs where end_date <= today AND source != SSP
app.post("/webhook/invoice-cron/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const result = await runWithLogging(
      id,
      "Invoice Cron Sync",
      runInvoiceCronSync
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Invoice - Integration ID: 23
app.post("/webhook/invoice/:id", async (req, res) => {
  const id = req.params.id
  try {
    const result = await runWithLogging(
      id,
      "Invoice Sync",
      runInvoiceSync
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// State Status - View current transaction queue states
const { getStateSummary, readState } = require("./transactionStateManager");

app.get("/status", (_, res) => {
  try {
    const summary = getStateSummary();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      states: summary,
      description: {
        incoming: "Transactions waiting for Sales Order creation",
        sales_order_done: "Sales Orders created, waiting for Invoice",
        invoice_done: "Fully processed (Invoice created)",
        sales_order_failed: "Failed during Sales Order/Deposit creation",
        invoice_failed: "Failed during Invoice creation"
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// View records in a specific state
app.get("/status/:state", (req, res) => {
  try {
    const validStates = ["incoming", "sales_order_done", "invoice_done", "sales_order_failed", "invoice_failed"];
    const state = req.params.state;

    if (!validStates.includes(state)) {
      return res.status(400).json({
        success: false,
        error: `Invalid state. Valid states: ${validStates.join(", ")}`
      });
    }

    const records = readState(state);
    res.json({
      success: true,
      state,
      count: records.length,
      records
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});
// Record Deletion Endpoints
const { searchRecords, deleteRecords, MAX_RECORDS_PER_BATCH } = require("./recordDeletion");

// Search/Preview records before deletion
app.post("/records/search", async (req, res) => {
  try {
    const result = await searchRecords(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete records (requires confirmation)
app.post("/records/delete", async (req, res) => {
  try {
    const result = await deleteRecords(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function generateMiniPayload(integrationId, count) {
  return {
    id: integrationId,
    count,
    date: new Date().toISOString(),
    status: Math.random() > 0.5 ? "PASS" : "FAIL"
  };
}

app.post("/webhook/test-stream/:id", async (req, res) => {
  console.log("process started");
  const integrationId = req.params.id;

  if (!integrationId) {
    return res.status(400).json({
      success: false,
      error: "Integration ID required"
    });
  }

  const DURATION = 5 * 60 * 1000;   // 5 minutes
  const MIN_DELAY = 1000;           // 1 sec
  const MAX_DELAY = 2500;           // 2.5 sec

  let count = 0;
  const start = Date.now();

  streamLog(integrationId, "info", "Starting MINI stream...", "Mini Test");

  function send() {

    if (Date.now() - start >= DURATION) {
      streamLog(
        integrationId,
        "info",
        `MINI stream finished. Total sent: ${count}`,
        "Mini Test"
      );
      return;
    }

    count++;

    const payload = generateMiniPayload(integrationId, count);

    // send only small structured data
    streamLog(
      integrationId,
      "info",
      payload,
      "Mini Test"
    );

    const delay =
      Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY)) + MIN_DELAY;

    setTimeout(send, delay);
  }

  send();

  res.json({
    success: true,
    message: "Mini streaming started (5 minutes)",
    integrationId
  });
});


app.listen(3003, () => {
  console.log("Server running on port 3003");
  console.log("Endpoints:");
  console.log("  POST /webhook/icai/:id          -> Auth + Fetch ICAI + Create SOs + Deposits (Exam)");
  console.log("  POST /webhook/membership/:id    -> Auth + Fetch ICAI + SO + CD + JV + Invoice (Membership/Student)");
  console.log("  POST /webhook/invoice/:id       -> Create Invoices from SO queue");
  console.log("  POST /webhook/invoice-cron/:id  -> Create Invoices (end_date <= today, source != SSP)");
  console.log("  GET  /status                -> View queue summary");
  console.log("  GET  /status/:state         -> View records in a state (incoming, sales_order_done, invoice_done, failed)");
  console.log("  POST /records/search        -> Preview records by filter criteria");
  console.log("  POST /records/delete        -> Delete records (requires confirmation)");
});
