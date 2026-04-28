// Tiny structured logger. One JSON object per line, written to stdout/stderr.
//
// Keeps the existing console.log lines that are useful as "is this thing
// alive" signals — those are still readable at a glance in Railway. New
// observability emits via this logger so external tools can ingest it
// without parsing free-form strings.
//
// Secret redaction: any string field whose VALUE matches a configured
// secret env var (or a known token pattern) is replaced with the literal
// string "***REDACTED***" before serialization. Belt-and-suspenders so
// a careless log line can't leak WATCHER_AUTH_KEY / BASE44_API_KEY /
// ANTHROPIC_API_KEY into Railway's log stream.
//
// Usage:
//   const log = createLogger({ service: "amphoracle-watcher" });
//   log.info("poll_complete", { count: 3, duration_ms: 142 });
//   log.error("base44_error", { entity: "Whisper", message: e.message });

const TOKEN_PATTERNS = [
  /^sk-ant-[\w-]+$/,                  // Anthropic API key
  /^glpat-[\w.-]+$/,                  // GitLab personal access token
  /^ghp_[\w]+$/,                      // GitHub personal access token
  /^Bearer\s+[\w.\-]+$/i,             // Authorization header value
];

function createLogger({
  service = "amphoracle-watcher",
  out = console,
  secretSources = defaultSecretSources,
} = {}) {
  function getSecrets() {
    return secretSources()
      .map((s) => (typeof s === "string" ? s : ""))
      .filter((s) => s && s.length >= 8); // ignore short/empty values
  }

  function redactValue(value) {
    if (value == null) return value;
    if (typeof value !== "string") return value;
    for (const secret of getSecrets()) {
      if (value.includes(secret)) return "***REDACTED***";
    }
    for (const pattern of TOKEN_PATTERNS) {
      if (pattern.test(value)) return "***REDACTED***";
    }
    return value;
  }

  function redactFields(fields) {
    if (!fields || typeof fields !== "object") return fields;
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = redactValue(v);
    }
    return out;
  }

  function emit(level, event, fields) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      service,
      event,
      ...redactFields(fields),
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
    // exposed for tests and direct usage
    redactValue,
    redactFields,
  };
}

function defaultSecretSources() {
  return [
    process.env.WATCHER_AUTH_KEY,
    process.env.BASE44_API_KEY,
    process.env.amphoracle_railway, // Anthropic key in this project
    process.env.ANTHROPIC_API_KEY,
  ];
}

module.exports = { createLogger, TOKEN_PATTERNS };
