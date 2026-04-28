// Tiny in-process metrics: counters and gauges. Returns plain JSON via
// /metrics — good enough for "is the watcher healthy" dashboards without
// the complexity of Prometheus.
//
// Counters are monotonically increasing totals since process start.
// Gauges represent a current value (set to whatever).
//
// Usage:
//   const m = createMetrics();
//   m.inc("polls");
//   m.inc("base44_errors", 1, { entity: "Whisper" });
//   m.gauge("locked_pending_reveal", 3);
//   m.snapshot();   // -> JSON-able object

function createMetrics({ now = Date.now } = {}) {
  const startedAt = now();
  const counters = new Map();   // name -> total
  const labeled = new Map();    // name -> Map(labelKey -> count)
  const gauges = new Map();     // name -> value

  function inc(name, amount = 1, labels) {
    counters.set(name, (counters.get(name) || 0) + amount);
    if (labels) {
      const key = stableKey(labels);
      const sub = labeled.get(name) || new Map();
      sub.set(key, (sub.get(key) || 0) + amount);
      labeled.set(name, sub);
    }
  }

  function gauge(name, value) {
    gauges.set(name, value);
  }

  function snapshot() {
    const out = {
      started_at: new Date(startedAt).toISOString(),
      uptime_seconds: Math.floor((now() - startedAt) / 1000),
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      labeled: {},
    };
    for (const [name, sub] of labeled) {
      out.labeled[name] = Object.fromEntries(sub);
    }
    return out;
  }

  function reset() {
    counters.clear();
    labeled.clear();
    gauges.clear();
  }

  return { inc, gauge, snapshot, reset };
}

function stableKey(obj) {
  return Object.keys(obj).sort().map((k) => `${k}=${obj[k]}`).join(",");
}

module.exports = { createMetrics };
