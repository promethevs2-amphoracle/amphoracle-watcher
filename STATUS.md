# Amphoracle Watcher — Launch Status

_Snapshot of the watcher backend as of the most recent deploy._

---

## What's running in production

**Live URL:** `https://amphoracle-watcher-production.up.railway.app`

**Source of truth:** `gitlab.com/amphoracle-group/Amphoracle-project` (`main` branch)

**Deploy method:** Railway CLI (`railway up`) from local zip — manual, your control.

---

## Resilience features in production

### Phase 1 — launch blockers (items #1–#7)

| # | Feature                          | Why it matters |
|---|----------------------------------|----------------|
| 1 | Boot reveal-timer recovery       | Restarts no longer strand locked whispers — pending reveals re-hydrate from Base44 on boot |
| 2 | Shared-secret auth + rate limits | `/scout`, `/reveal`, `/recommend-date` require `Authorization: Bearer`; per-IP limits prevent token-spend DoS |
| 3 | SSRF guard on `fetchURL`         | Blocks private IPs (RFC1918), loopback, AWS/GCP metadata IP, IPv6 ULA, file://, gopher://, etc. |
| 4 | Retries on transient failures    | Network blips and 5xx/429 self-heal in seconds instead of stranding whispers for hours |
| 5 | Structured logs + `/metrics`     | JSON-line logs; in-process counters/gauges scrapable from `/metrics` |
| 6 | State map pruning                | `lastChecked`/`locked` shrink as whispers age out — bounded memory |
| 7 | Graceful shutdown on SIGTERM     | Railway redeploys drain HTTP cleanly; reveal timers re-recover on next boot |

### Phase 2 — polish (items #1–#10)

| # | Feature                                  | Why it matters |
|---|------------------------------------------|----------------|
| 1 | Anthropic cost tracking                  | `claude_cost_usd_micros{model=…}` in `/metrics` — see spend before the bill arrives |
| 2 | Logging redaction                        | Known secrets (env values + token patterns) never reach log output |
| 3 | `/healthz` + `/readyz` probes            | Separate "process alive" from "ready to serve" — load balancer can route correctly |
| 4 | Circuit breaker on Base44                | After 5 consecutive failures, fails fast for 60s — protects Anthropic budget when Base44 wobbles |
| 5 | `fetchURL` per-request dedup             | `checkForDisruption` and `checkForEvidence` share one cache per watcher iteration |
| 6 | Honor `Retry-After` header               | When Anthropic says "wait 7s," we wait 7s — caps at 60s |
| 7 | GitLab CI pipeline                       | `npm test` runs on every push; catches regressions before deploy |
| 8 | `deploy.sh` helper                       | One command: install deps → tests → `railway up` |
| 9 | `README.md`                              | Architecture, env vars, deploy process |
| 10| `RUNBOOK.md`                             | Common incidents and how to handle them |

---

## Endpoint reference

| Path             | Method | Auth   | Purpose                                          |
|------------------|--------|--------|--------------------------------------------------|
| `/`              | GET    | open   | Public health JSON                               |
| `/healthz`       | GET    | open   | Liveness probe                                   |
| `/readyz`        | GET    | open   | Readiness probe (503 if env unset / boot pending)|
| `/metrics`       | GET    | open   | JSON snapshot of counters/gauges                 |
| `/scout`         | POST   | Bearer | Find 3 real upcoming events to predict (10/min)  |
| `/reveal`        | POST   | Bearer | Manual reveal trigger (30/min)                   |
| `/recommend-date`| POST   | Bearer | Suggest verification date for a whisper (20/min) |

---

## Test suite

**225 tests passing**, ~2 seconds to run. All network mocked at the boundary — no Base44 credits or Anthropic tokens consumed.

Files:
- `test/parse-claude-json.test.js`
- `test/poll-interval.test.js`
- `test/lock-reveal.test.js`
- `test/notify-fanout.test.js`
- `test/confidence-gate.test.js`
- `test/http-helpers.test.js`
- `test/endpoint-validation.test.js`
- `test/scout-filter.test.js`
- `test/recover-reveal-timers.test.js`
- `test/auth.test.js`
- `test/rate-limit.test.js`
- `test/endpoint-auth-ratelimit.test.js`
- `test/url-guard.test.js`
- `test/fetchURL-ssrf.test.js`
- `test/retry.test.js`
- `test/prune-state.test.js`
- `test/graceful-shutdown.test.js`
- `test/logger.test.js`
- `test/metrics.test.js`
- `test/metrics-endpoint.test.js`
- `test/anthropic-usage.test.js`
- `test/circuit-breaker.test.js`
- `test/health-probes.test.js`
- `test/url-cache.test.js`
- `test/filter-future-whispers.test.js`

---

## Observability

`/metrics` exposes:

**Counters (totals since process start):**
- `polls` — poll cycles
- `whispers_locked{verdict=…}` — by verdict
- `whispers_revealed{verdict=…}` — by verdict
- `whispers_disrupted` — marked unverifiable
- `state_pruned` — stale entries removed
- `poll_errors{phase=…}` — per_watcher / outer
- `http_retries{reason=…}` — transient-failure recoveries
- `circuit_state_changes{circuit=base44,to=…}` — breaker transitions
- `claude_calls{model=…}` — total API calls
- `claude_input_tokens{model=…}`, `claude_output_tokens{model=…}`
- `claude_cost_usd_micros{model=…}` — estimated USD * 1,000,000 (divide for dollars)

**Gauges (current values):**
- `active_watchers` — count from last poll
- `locked_pending_reveal` — currently locked
- `last_checked_size` — entries in `lastChecked` map
- `reveal_timers_pending` — scheduled timers in memory

---

## Deploy workflow

### Standard deploy (when you have new code from GitLab)

1. Download zip from `gitlab.com/amphoracle-group/Amphoracle-project` → Code → Download zip
2. Delete old `~/Desktop/amphoracle-watcher` folder
3. Unzip new download, rename folder to `amphoracle-watcher`
4. Move it to `~/Desktop/`
5. Open Terminal:
   ```sh
   cd ~/Desktop/amphoracle-watcher
   railway link    # only needed first time after replacing folder
   railway up
   ```
6. Verify Archon works in Base44

### If `railway link` is missing
You'll be asked to pick:
- Workspace: `promethevs2-amphoracle's Projects`
- Project: `honest-tenderness`
- Environment: `production`
- Service: `amphoracle-watcher`

---

## Environment variables in Railway

| Name                  | Required | Notes                                              |
|-----------------------|----------|----------------------------------------------------|
| `BASE44_API_KEY`      | yes      | Base44 API key                                     |
| `amphoracle_railway`  | yes      | Anthropic API key                                  |
| `WATCHER_AUTH_KEY`    | yes      | Shared secret with Base44; matches `Bearer` header |
| `FETCH_URL_ALLOWLIST` | optional | Comma-separated public domains to restrict outbound fetches to |
| `PORT`                | auto     | Railway sets automatically                         |

The same `WATCHER_AUTH_KEY` must also be set in Base44 Application Secrets so the frontend functions can include it on POSTs.

---

## Known caveats

- **GitHub account is suspended.** Repo on GitHub is locked. Only GitLab is the source of truth right now. Railway no longer pulls from GitHub.
- **GitLab CI is configured but not yet exercised** — runs on every push to `main`.
- **No automated CI deploy.** All deploys are manual via `railway up`.
- **Local Node.js not installed** on this machine, so `deploy.sh --skip-tests` (or `railway up` directly) is the operative deploy path.

---

## What's intentionally NOT yet built

These would be next reasonable improvements but aren't blockers:

- Webhook integrations (Slack/Discord notifications on reveal)
- Admin endpoints to flush stuck whispers / dump live state
- Pre-launch admin dashboard rendering `/metrics` graphically
- Per-domain outbound rate limiting on `fetchURL`
- Dark-launching scout under a feature flag
- Automated load tests

Discuss before adding any of these — current footprint is intentionally minimal.

---

_Last updated by Claude on the day of the polish-batch deploy._
