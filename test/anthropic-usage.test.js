const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PRICING_USD_PER_M_TOKENS,
  priceFor,
  estimatedCostUsd,
  extractUsage,
  recordUsage,
} = require("../lib/anthropic-usage");
const { createMetrics } = require("../lib/metrics");

test("priceFor: returns the entry for a known model", () => {
  assert.deepEqual(priceFor("claude-opus-4-6"), { input: 5, output: 25 });
  assert.deepEqual(priceFor("claude-sonnet-4-6"), { input: 3, output: 15 });
  assert.deepEqual(priceFor("claude-sonnet-5-5"), { input: 2, output: 10 });
});

test("priceFor: falls back to opus pricing for unknown models", () => {
  // Defensive — better to overcount cost than to silently zero it out
  // for a freshly released model.
  assert.deepEqual(priceFor("claude-zeta-9"), { input: 15, output: 75 });
});

test("estimatedCostUsd: zero tokens => zero cost", () => {
  assert.equal(estimatedCostUsd({ model: "claude-opus-4-6", input_tokens: 0, output_tokens: 0 }), 0);
});

test("estimatedCostUsd: opus 1k in / 1k out", () => {
  // 1000 in @ $5/M = $0.005; 1000 out @ $25/M = $0.025; total $0.03
  const cost = estimatedCostUsd({ model: "claude-opus-4-6", input_tokens: 1000, output_tokens: 1000 });
  assert.equal(cost, 0.03);
});

test("estimatedCostUsd: sonnet 10k in / 2k out", () => {
  // 10000 @ $3/M = $0.03; 2000 @ $15/M = $0.03; total $0.06
  const cost = estimatedCostUsd({ model: "claude-sonnet-4-6", input_tokens: 10_000, output_tokens: 2_000 });
  assert.equal(cost, 0.06);
});

test("extractUsage: pulls fields from response shape", () => {
  const usage = extractUsage({
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 25 },
    content: [{ type: "text", text: "x" }],
  });
  assert.equal(usage.input_tokens, 100);
  assert.equal(usage.output_tokens, 50);
  assert.equal(usage.cache_read_input_tokens, 25);
  assert.equal(usage.cache_creation_input_tokens, 0);
});

test("extractUsage: returns zeros when usage field missing", () => {
  const usage = extractUsage({ content: [] });
  assert.deepEqual(usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
});

test("extractUsage: tolerates null/undefined response", () => {
  assert.deepEqual(extractUsage(null).input_tokens, 0);
  assert.deepEqual(extractUsage(undefined).input_tokens, 0);
});

test("recordUsage: increments call/token counters labeled by model", () => {
  const m = createMetrics();
  recordUsage(m, {
    model: "claude-opus-4-6",
    usage: { input_tokens: 500, output_tokens: 200 },
  });
  const snap = m.snapshot();
  assert.equal(snap.counters.claude_calls, 1);
  assert.equal(snap.counters.claude_input_tokens, 500);
  assert.equal(snap.counters.claude_output_tokens, 200);
  assert.equal(snap.labeled.claude_input_tokens["model=claude-opus-4-6"], 500);
});

test("recordUsage: claude_cost_usd_micros accumulates", () => {
  const m = createMetrics();
  recordUsage(m, { model: "claude-opus-4-6", usage: { input_tokens: 1000, output_tokens: 1000 } });
  recordUsage(m, { model: "claude-opus-4-6", usage: { input_tokens: 1000, output_tokens: 1000 } });
  // 0.03 USD per call * 2 = 0.06 USD = 60_000 micros
  assert.equal(m.snapshot().counters.claude_cost_usd_micros, 60_000);
});

test("recordUsage: cache token counters only emit when > 0", () => {
  const m = createMetrics();
  recordUsage(m, {
    model: "claude-opus-4-6",
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 },
  });
  const snap = m.snapshot();
  assert.equal(snap.counters.claude_cache_read_input_tokens, 200);
  assert.equal(snap.counters.claude_cache_creation_input_tokens, undefined);
});

test("PRICING_USD_PER_M_TOKENS exports the table for callers to inspect", () => {
  assert.ok(typeof PRICING_USD_PER_M_TOKENS === "object");
  assert.ok(PRICING_USD_PER_M_TOKENS["claude-opus-4-6"]);
});
