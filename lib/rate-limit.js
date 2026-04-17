// In-memory sliding-window rate limiter.
//
// Tracks the timestamps of recent requests per key (default: remote IP)
// and rejects with 429 once `max` requests in the last `windowMs` is
// exceeded. Memory is bounded by `maxKeys` and an internal sweep that
// drops keys whose newest sample is older than the window.
//
// Single-instance only — sufficient for Railway's 1-container deploy.
// If we ever scale horizontally, swap this for Redis.
function makeRateLimit({
  windowMs = 60_000,
  max = 30,
  maxKeys = 10_000,
  keyFn = defaultKey,
  now = Date.now,
} = {}) {
  const buckets = new Map(); // key -> number[] (timestamps, ascending)
  let lastSweep = now();

  function sweep(nowMs) {
    if (nowMs - lastSweep < windowMs) return;
    for (const [k, ts] of buckets) {
      const last = ts[ts.length - 1];
      if (last === undefined || nowMs - last >= windowMs) buckets.delete(k);
    }
    lastSweep = nowMs;
  }

  function evict() {
    // Bound the map size defensively so a flood of unique keys can't
    // grow memory without bound between sweeps.
    if (buckets.size <= maxKeys) return;
    const drop = buckets.size - maxKeys;
    let i = 0;
    for (const k of buckets.keys()) {
      if (i++ >= drop) break;
      buckets.delete(k);
    }
  }

  function middleware(req, res, next) {
    const nowMs = now();
    sweep(nowMs);

    const key = keyFn(req);
    const cutoff = nowMs - windowMs;

    let ts = buckets.get(key);
    if (!ts) {
      ts = [];
      buckets.set(key, ts);
      evict();
    }

    // Drop samples older than the window.
    while (ts.length && ts[0] <= cutoff) ts.shift();

    if (ts.length >= max) {
      const retryAfterMs = ts[0] + windowMs - nowMs;
      const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.set("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "Too many requests", retry_after_seconds: retryAfterSec });
    }

    ts.push(nowMs);
    return next();
  }

  middleware._buckets = buckets; // for tests
  middleware._reset = () => { buckets.clear(); lastSweep = now(); };
  return middleware;
}

function defaultKey(req) {
  // req.ip honors trust-proxy; fall back to socket remote address.
  return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

module.exports = { makeRateLimit };
