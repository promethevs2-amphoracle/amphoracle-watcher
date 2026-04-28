// Tiny structured logger. One JSON object per line, written to stdout/stderr.
//
// Keeps the existing console.log lines that are useful as "is this thing
// alive" signals — those are still readable at a glance in Railway. New
// observability emits via this logger so external tools can ingest it
// without parsing free-form strings.
//
// Usage:
//   const log = createLogger({ service: "amphoracle-watcher" });
//   log.info("poll_complete", { count: 3, duration_ms: 142 });
//   log.error("base44_error", { entity: "Whisper", message: e.message });

function createLogger({ service = "amphoracle-watcher", out = console } = {}) {
  function emit(level, event, fields) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      service,
      event,
      ...(fields || {}),
    };
    const line = JSON.stringify(entry);
    if (level === "error") out.error(line);
    else out.log(line);
  }

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    debug: (event, fields) => emit("debug", event, fields),
  };
}

module.exports = { createLogger };
