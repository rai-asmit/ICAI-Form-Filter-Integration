// Ultra-simple log streaming - KISS principle
function setupLogStreaming({ integrationId, source }) {
  async function sendLog(level, message) {
    try {
      await fetch('https://localhost/3000/logs/stream', {
      // await fetch('https://api.nidish.com/api/logs/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integrationId,
          message,
          level,
          source,
          timestamp: new Date().toISOString(),
        })
      });
    } catch (error) {
      // Ignore errors - fire and forget
    }
  }

  // Preserve originals
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => {
    originalLog(...args);
    sendLog(
      "info",
      args.map(a =>
        typeof a === "object" ? JSON.stringify(a) : String(a)
      ).join(" ")
    );
  };

  console.error = (...args) => {
    originalError(...args);
    sendLog(
      "error",
      args.map(a =>
        typeof a === "object" ? JSON.stringify(a) : String(a)
      ).join(" ")
    );
  };

  console.log("🚀 Remote log streaming enabled");
}

module.exports = { setupLogStreaming };
