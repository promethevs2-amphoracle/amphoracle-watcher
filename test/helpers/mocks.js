// Shared mock factories for test files.

// Build a Claude API response body shaped like what callClaude expects,
// wrapping a given assistant text payload.
function claudeResponse(text) {
  return { status: 200, data: { content: [{ type: "text", text }] } };
}

// Build a Base44 list response.
function base44List(entities) {
  return { status: 200, data: { entities } };
}

// Build a Base44 single-entity / ack response.
function base44Ok(data = { ok: true }) {
  return { status: 200, data };
}

// Build a fetchURL-shaped result.
function fetchResult(url, content, success = true) {
  return { url, content, success };
}

// Make a spy that records every call and returns queued responses in order.
// If a call has no queued response, it returns the fallback.
function queuedHttpRequest(queue, fallback = { status: 200, data: {} }) {
  const calls = [];
  const pending = queue.slice();
  const fn = async (options, body) => {
    calls.push({ options, body });
    if (pending.length === 0) return fallback;
    const next = pending.shift();
    if (typeof next === "function") return next(options, body);
    return next;
  };
  fn.calls = calls;
  return fn;
}

// Simple fetchURL mock returning a canned string per URL.
function stubFetchURL(map) {
  return async (url) => {
    if (!(url in map)) return fetchResult(url, null, false);
    return fetchResult(url, map[url]);
  };
}

module.exports = {
  claudeResponse,
  base44List,
  base44Ok,
  fetchResult,
  queuedHttpRequest,
  stubFetchURL,
};
