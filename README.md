# Amphoracle Watcher

Backend service for the Amphoracle prediction app. Polls active prediction
"whispers" against live web sources, asks Claude whether the predicted
event has occurred, and locks/reveals verdicts to the frontend.

## Architecture

```
┌─────────────┐                                  ┌──────────────┐
│   Base44    │  POST /scout, /reveal,           │   Watcher    │
│  Frontend   │ ────/recommend-date─────────►   │   (Express)   │
│ (functions) │       Authorization: Bearer      │   server.js   │
└─────────────┘                                  └──────┬───────┘
                                                         │
                       ┌────────────────────────────────────────┐
                       │                                        │
                       ▼                                        ▼
                ┌─────────────┐                          ┌──────────────┐
                │   Claude    │                          │    Base44    │
                │  Anthropic  │                          │     API      │
                │     API     │                          │   (entities) │
                └─────────────┘                          └──────────────┘

       In parallel, the watcher polls Base44 every 30s for active watchers,
       fetches their source URLs, asks Claude for a verdict, and writes
       results back to Base44. Reveals are scheduled 15 min after lock.
```

### Core flow

1. `pollWatchers()` runs every 30s
   - Pulls `OracleWatcher?status=pending` from Base44
   - For each whisper not yet locked and past its check interval:
     - Fetches its source URLs (deduped per cycle)
     - Asks Claude two questions in parallel: "is this disrupted?" and "do you see the answer?"
     - If disrupted → marks Whisper unverifiable
     - If confidence ≥ 85 → calls `lockWhisper()`
2. `lockWhisper()` writes status=locked + reveal_scheduled_for, schedules a
   timer for +15 minutes, notifies voters
3. `executeReveal()` (timer fires) writes status=revealed + verdict,
   notifies voters again, cleans up in-memory state
4. On boot, `recoverRevealTimers()` rehydrates pending reveals from Base44
   so a restart doesn't strand any whisper mid-window

## Endpoints

| Path             | Method | Auth | Purpose                                          |
|------------------|--------|------|--------------------------------------------------|
| `/`              | GET    | open | Public health JSON                               |
| `/healthz`       | GET    | open | Liveness probe (always 200 if process alive)     |
| `/readyz`        | GET    | open | Readiness probe (503 if env unset or boot pending) |
| `/metrics`       | GET    | open | JSON snapshot of counters/gauges (uptime, polls, tokens, cost, etc.) |
| `/scout`         | POST   | Bearer | Scout endpoint — finds 3 real upcoming events to predict   |
| `/reveal`        | POST   | Bearer | Manual reveal trigger for a single watcher       |
| `/recommend-date`| POST   | Bearer | Suggests a verification date for a whisper       |

`/scout`, `/reveal`, `/recommend-date` are rate-limited per-IP (10, 30, 20
requests/min respectively).

## Environment variables

| Name                  | Purpose                                                 | Required for prod |
|-----------------------|---------------------------------------------------------|-------------------|
| `BASE44_API_KEY`      | Base44 API key — used as `x-api-key` header             | yes               |
| `amphoracle_railway`  | Anthropic API key                                       | yes               |
| `WATCHER_AUTH_KEY`    | Shared secret for `Authorization: Bearer` on POST endpoints. Fail-open if unset (with warning log). | strongly recommended |
| `FETCH_URL_ALLOWLIST` | Comma-separated public domains. If set, restricts outbound `fetchURL` to subdomains of these. Private-IP blocking always applies. | optional |
| `PORT`                | HTTP port (Railway sets automatically)                  | auto              |

## Local development

```sh
npm install
npm test           # runs the full suite (~225 tests, ~2s)
node server.js     # boots locally (recovery will warn about missing keys, harmless)
```

The test suite mocks all outbound HTTP — no Base44 credits or Anthropic
tokens are spent during testing.

## Deploying

This project deploys via Railway CLI (no GitHub auto-deploy is wired up).

```sh
./deploy.sh        # runs tests, then `railway up`
```

If you don't have the Railway CLI installed:

```sh
curl -fsSL cli.new | sh
railway login
railway link       # pick: honest-tenderness → production → amphoracle-watcher
```

After a deploy, verify:

1. **Archon** in the Base44 app continues to work (server-to-server check)
2. `/healthz` returns 200
3. `/readyz` returns 200
4. `/metrics` shows updating counters

## Layout

```
server.js               # Express app + poll loop + lifecycle
lib/
  parse-claude-json.js  # Tolerant JSON extractor for Claude responses
  poll-interval.js      # Smart polling cadence based on event proximity
  filter-future-whispers.js
  auth.js               # Bearer-token middleware for inbound endpoints
  rate-limit.js         # In-memory sliding-window rate limiter
  url-guard.js          # SSRF guard (blocks private IPs, metadata, file://)
  retry.js              # Exponential-backoff retry honoring Retry-After
  circuit-breaker.js    # Three-state breaker; wraps Base44 calls
  url-cache.js          # Per-request fetchURL memoization
  logger.js             # JSON-line logger with secret redaction
  metrics.js            # In-process counters + gauges
  anthropic-usage.js    # Token + cost accounting from Claude responses
test/                   # node:test suite, all built-in (no Jest)
deploy.sh               # local deploy helper
.gitlab-ci.yml          # CI: runs npm test on every push
```

## Testing philosophy

- **No new runtime dependencies.** Only `express`, `cheerio`, and `https`/`http` from Node stdlib.
- **No Jest or Mocha.** Tests use `node:test` and `node:assert/strict` —
  zero install footprint, runs anywhere Node runs.
- **All network mocked at the boundary.** Tests use `__setHttpRequest`,
  `__setFetchURL`, `__setURLGuard` to replace the network layer.
- **`require.main === module`** guards startup side effects so tests can
  `require('./server')` without binding ports or scheduling polls.

## Resilience features

- **Boot-time reveal recovery** — restarts don't strand locked whispers.
- **Per-IP rate limits** — auth-protected endpoints can't be DoS'd into
  exhausting Anthropic budget.
- **SSRF guard** — `fetchURL` rejects private IPs, cloud metadata IPs,
  IPv6 ULA, link-local, and non-http(s) protocols.
- **Retry with Retry-After** — transient 429/5xx + network errors heal
  in seconds instead of stranding whispers for hours.
- **Circuit breaker on Base44** — opens after 5 consecutive failures,
  cooldown 60s, fails fast while open.
- **Graceful shutdown** — SIGTERM stops poll loop, drains HTTP, clears
  reveal timers (next-boot recovery rehydrates them).
- **State map pruning** — `lastChecked`/`locked` shrink as whispers age out
  of the active set.
- **Secret redaction in logs** — known token patterns and configured env
  values are replaced with `***REDACTED***` before serialization.

## Cost & rate-limit visibility

`/metrics` exposes:

- `claude_calls{model=…}` — total Claude API calls
- `claude_input_tokens{model=…}`, `claude_output_tokens{model=…}` — by model
- `claude_cost_usd_micros{model=…}` — estimated USD cost in micros (millionths of a dollar)
- `http_retries{reason=…}` — transient-failure recoveries
- `circuit_state_changes{circuit=base44,to=…}` — breaker transitions
- `whispers_locked{verdict=…}`, `whispers_revealed{verdict=…}`, `whispers_disrupted`
- `polls`, `state_pruned`, `poll_errors{phase=…}`
- gauges: `active_watchers`, `locked_pending_reveal`, `last_checked_size`, `reveal_timers_pending`

Pricing in `lib/anthropic-usage.js` is current as of writing — update if
Anthropic publishes new rates.

## See also

- `RUNBOOK.md` — common incidents and how to handle them
