// Shared-secret auth middleware.
//
// Rollout safety: when the expected key is unset (getKey() returns a
// falsy value), requests pass through and a one-time warning is logged.
// This lets the env var be deployed before the frontend is updated with
// the key. Set WATCHER_AUTH_KEY in Railway to turn auth on.
//
// When the key is set, requests must send
//   Authorization: Bearer <key>
// or they get a 401.
function makeAuthMiddleware(getKey, { logger = console } = {}) {
  let warned = false;

  return function authMiddleware(req, res, next) {
    const expected = getKey();
    if (!expected) {
      if (!warned) {
        logger.warn("[AUTH] WATCHER_AUTH_KEY is unset — endpoints are UNPROTECTED");
        warned = true;
      }
      return next();
    }

    const header = req.headers["authorization"] || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match ? match[1].trim() : null;

    if (provided && timingSafeEqual(provided, expected)) {
      return next();
    }

    return res.status(401).json({ error: "Unauthorized" });
  };
}

// Constant-time comparison to prevent timing side-channels on the shared secret.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

module.exports = { makeAuthMiddleware, timingSafeEqual };
