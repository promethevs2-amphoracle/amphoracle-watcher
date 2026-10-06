// Anthropic usage and cost accounting.
//
// Captures input/output tokens from a Claude API response and emits
// counters + estimated USD cost.
//
// Pricing is the publicly listed per-million-token rate at the time of
// writing. Update PRICING below if Anthropic changes their list. Cost is
// an *estimate* — actual billing comes from Anthropic's dashboard.

const PRICING_USD_PER_M_TOKENS = {
  // model_id -> { input, output } (USD per 1M tokens)
  "claude-opus-4-6":     { input: 15, output: 75 },
  "claude-opus-4-7":     { input: 15, output: 75 },
  "claude-sonnet-4-5":   { input: 3,  output: 15 },
  "claude-sonnet-4-6":   { input: 3,  output: 15 },
  "claude-sonnet-4-7":   { input: 3,  output: 15 },
  "claude-haiku-4-5":    { input: 1,  output: 5 },
};

// Looks up the pricing entry for a given model id; falls back to the
// most expensive (Opus) so we don't undercount cost when a model is new
// and not yet listed here.
function priceFor(modelId) {
  return PRICING_USD_PER_M_TOKENS[modelId] ?? PRICING_USD_PER_M_TOKENS["claude-opus-4-6"];
}

function estimatedCostUsd({ model, input_tokens = 0, output_tokens = 0 }) {
  const p = priceFor(model);
  const cost = (input_tokens * p.input + output_tokens * p.output) / 1_000_000;
  return Number(cost.toFixed(6));
}

// Pulls token counts out of the response shape Anthropic returns.
// Tolerates missing usage field (returns zeros).
function extractUsage(responseData) {
  const u = (responseData && responseData.usage) || {};
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}

// Wires usage into a metrics instance. Counts tokens by model and
// accumulates a `claude_cost_usd_micros` counter (in millionths to
// keep it integer-friendly).
function recordUsage(metrics, { model, usage }) {
  metrics.inc("claude_calls", 1, { model });
  metrics.inc("claude_input_tokens", usage.input_tokens, { model });
  metrics.inc("claude_output_tokens", usage.output_tokens, { model });
  if (usage.cache_creation_input_tokens) {
    metrics.inc("claude_cache_creation_input_tokens", usage.cache_creation_input_tokens, { model });
  }
  if (usage.cache_read_input_tokens) {
    metrics.inc("claude_cache_read_input_tokens", usage.cache_read_input_tokens, { model });
  }
  const cost = estimatedCostUsd({ model, ...usage });
  // Store as micros (USD * 1_000_000) so the counter is integer.
  metrics.inc("claude_cost_usd_micros", Math.round(cost * 1_000_000), { model });
}

module.exports = {
  PRICING_USD_PER_M_TOKENS,
  priceFor,
  estimatedCostUsd,
  extractUsage,
  recordUsage,
};
