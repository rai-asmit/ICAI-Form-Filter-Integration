const express = require("express");
const { runFormBasedSync } = require("./syncFormBasedTransactions");

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

// Unified Form-Based Transactions — fetches once, splits by form, processes both pipelines
app.post("/webhook/form-based-transactions/:id", async (req, res) => {
  const integrationId = req.params.id;

  if (!integrationId) {
    return res.status(400).json({
      success: false,
      error: "Integration ID is required",
    });
  }

  try {
    streamLog(integrationId, "info", "[FormSync Webhook] Starting Form-Based Transaction Sync...", "webhook");
    const result = await runWithLogging(
      integrationId,
      "Form-Based Transaction Sync",
      () => runFormBasedSync({ integrationId })
    );
    streamLog(integrationId, "info", `[FormSync Webhook] Sync completed: ${JSON.stringify({ totalProcessed: result.totalProcessed, totalFailed: result.totalFailed })}`, "webhook");

    res.json(result);
  } catch (e) {
    streamLog(integrationId, "error", `[FormSync Webhook] Error: ${e.message}`, "webhook");
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
  console.log("  POST /webhook/form-based-transactions/:id -> Fetch ICAI once, split by form, process Membership + Exam pipelines");
});
