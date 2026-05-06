const express = require("express");
const path = require("path");
const fs = require("fs");
const { runFormBasedSync } = require("./syncFormBasedTransactions");

const app = express();
app.use(express.json());

// --- File Browser ---
const DATA_DIR = path.join(__dirname, "data");
const FB_USER = process.env.FILE_BROWSER_USER || "admin";
const FB_PASS = process.env.FILE_BROWSER_PASS || "admin123";

function basicAuth(req, res, next) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    if (user === FB_USER && pass === FB_PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Data Browser"');
  return res.status(401).send("Unauthorized");
}

function fileBrowser(baseDir) {
  return (req, res, next) => {
    const fullPath = path.join(baseDir, req.path);
    let stat;
    try { stat = fs.statSync(fullPath); } catch { return next(); }

    if (stat.isFile()) return res.sendFile(fullPath);

    if (stat.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(fullPath, { withFileTypes: true }); } catch { return next(); }

      const isRoot = req.path === "/" || req.path === "";
      const rows = entries
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
        .map(e => {
          const href = e.isDirectory() ? `${e.name}/` : e.name;
          const icon = e.isDirectory() ? "&#128193;" : "&#128196;";
          return `<tr><td>${icon}</td><td><a href="${href}">${e.name}</a></td><td style="color:#888;padding-left:20px">${e.isDirectory() ? "folder" : ""}</td></tr>`;
        });

      if (!isRoot) rows.unshift(`<tr><td>&#128281;</td><td><a href="../">.. (up)</a></td><td></td></tr>`);

      res.setHeader("Content-Type", "text/html");
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Data Browser</title>
<style>body{font-family:monospace;padding:24px;background:#f9f9f9}h2{margin-bottom:16px}table{border-collapse:collapse;background:#fff;border-radius:6px;box-shadow:0 1px 4px #0001}td{padding:6px 16px}tr:hover{background:#f0f4ff}a{text-decoration:none;color:#1a73e8}a:hover{text-decoration:underline}</style>
</head><body><h2>&#128202; Data Browser &mdash; ${req.path}</h2>
<table>${rows.join("")}</table></body></html>`);
    }
  };
}

app.use("/webhook/files", basicAuth, fileBrowser(DATA_DIR));

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
    streamLog(integrationId, "info", [
      `[FormSync] ---- FINAL SUMMARY ----`,
      `Total Fetched     : ${result.totalFetched ?? 0}`,
      `Membership        : ${result.membershipCount ?? 0}`,
      `Exam/Other        : ${result.examCount ?? 0}`,
      `Total Processed   : ${result.totalProcessed ?? 0}`,
      `Total Failed      : ${result.totalFailed ?? 0}`,
      `Duration          : ${result.durationMs ?? 0}ms`,
      `Status            : ${result.success ? "SUCCESS" : "FAILED"}`,
    ].join(" | "), "webhook");

    res.json(result);
  } catch (e) {
    streamLog(integrationId, "error", `[FormSync Webhook] Error: ${e.message}`, "webhook");
    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

// Date-range variant — accepts ?fromDate=DD/MM/YYYY&toDate=DD/MM/YYYY query params.
// If both are omitted, falls back to the default (yesterday) behaviour.
const DATE_RE = /^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/;

app.post("/webhook/form-based-transactions-range/:id", async (req, res) => {
  const integrationId = req.params.id;
  const { fromDate, toDate } = req.query;

  if (!integrationId) {
    return res.status(400).json({
      success: false,
      error: "Integration ID is required",
    });
  }

  if ((fromDate && !toDate) || (!fromDate && toDate)) {
    return res.status(400).json({
      success: false,
      error: "Both fromDate and toDate must be provided together",
    });
  }

  if (fromDate && (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate))) {
    return res.status(400).json({
      success: false,
      error: "fromDate and toDate must be in DD/MM/YYYY format",
    });
  }

  try {
    const rangeLabel = fromDate ? ` for range ${fromDate} → ${toDate}` : " (default: yesterday)";
    streamLog(integrationId, "info", `[FormSync Webhook] Starting Form-Based Transaction Sync${rangeLabel}...`, "webhook");
    const result = await runWithLogging(
      integrationId,
      "Form-Based Transaction Sync (Date Range)",
      () => runFormBasedSync({ integrationId, fromDate, toDate })
    );
    streamLog(integrationId, "info", [
      `[FormSync] ---- FINAL SUMMARY ----`,
      `Range             : ${fromDate ?? "default"} -> ${toDate ?? "default"}`,
      `Total Fetched     : ${result.totalFetched ?? 0}`,
      `Membership        : ${result.membershipCount ?? 0}`,
      `Exam/Other        : ${result.examCount ?? 0}`,
      `Total Processed   : ${result.totalProcessed ?? 0}`,
      `Total Failed      : ${result.totalFailed ?? 0}`,
      `Duration          : ${result.durationMs ?? 0}ms`,
      `Status            : ${result.success ? "SUCCESS" : "FAILED"}`,
    ].join(" | "), "webhook");

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
  console.log("  POST /webhook/form-based-transactions/:id");
  console.log("  POST /webhook/form-based-transactions-range/:id?fromDate=DD/MM/YYYY&toDate=DD/MM/YYYY");
  console.log(`  GET  /webhook/files  ->  Data browser (user: ${FB_USER})`);
});
