const express = require("express");
const { runMembershipStudentSync } = require("./syncMembershipStudent");
const { runExamEnrollmentSync } = require("./syncExamEnrollment");

const app = express();
app.use(express.json());

const cors = require('cors');

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
    console.log = originalLog;
    console.error = originalError;
  }
}

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

// Exam Enrollment & Other Forms — SO + Customer Deposit + Invoice
// Handles: All forms NOT handled by membership/student (Exam Enrollment, etc.)
app.post("/webhook/examination/:id", async (req, res) => {
  const integrationId = req.params.id;

  if (!integrationId) {
    return res.status(400).json({
      success: false,
      error: "Integration ID is required",
    });
  }

  try {
    streamLog(integrationId, "info", "[Exam Webhook] Starting Exam Enrollment Sync...", "webhook");
    const result = await runWithLogging(
      integrationId,
      "Exam Enrollment Sync",
      () => runExamEnrollmentSync({ integrationId })
    );
    streamLog(integrationId, "info", `[Exam Webhook] Sync completed: ${JSON.stringify({ processed: result.processed, failed: result.failed })}`, "webhook");

    res.json(result);
  } catch (e) {
    streamLog(integrationId, "error", `[Exam Webhook] Error: ${e.message}`, "webhook");
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

const PORT = process.env.PORT || 3003;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Endpoints:");
  console.log("  POST /webhook/membership/:id    -> Auth + Fetch ICAI + SO + Invoice + CP + JV (Membership/Student)");
  console.log("  POST /webhook/examination/:id   -> Auth + Fetch ICAI + SO + Customer Deposit + Invoice (Exam/Other)");
});
