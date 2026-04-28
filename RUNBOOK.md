# Runbook

How to respond when something goes wrong with the Amphoracle watcher.

Triage order: confirm impact → check observability → fix → verify.

## Quick triage commands

```sh
# Is the process serving?
curl -s https://amphoracle-watcher-production.up.railway.app/healthz

# Is it ready to handle traffic?
curl -s https://amphoracle-watcher-production.up.railway.app/readyz

# What is it doing right now?
curl -s https://amphoracle-watcher-production.up.railway.app/metrics | jq .

# In Railway: view live logs from the latest deploy
# (Railway UI → Deployments → topmost deploy → Deploy Logs)
```

The most reliable real-world test is **does Archon work in the Base44
app**. If yes, the watcher is functioning correctly end-to-end regardless
of what the browser shows.

---

## Incident: "Application failed to respond" in browser

**First check:** does Archon work in Base44?

- **Yes** → cosmetic only. Railway's edge proxy is showing a stale 502
  from a deploy transition. The watcher is alive. Tell users to ignore.
- **No** → the app is genuinely down. Continue below.

**Steps:**

1. Open Railway → service → **Deployments** tab
2. Look at the topmost deploy. If status is **Crashed** or **Failed**,
   click into it and read the **Deploy Logs**
3. If logs show a startup error, fix locally and redeploy via
   `./deploy.sh`
4. **Emergency rollback:** click the three-dots menu on the last known-
   good deploy (the previous successful one) → **Redeploy**. Service is
   back in ~30s.

---

## Incident: A whisper is stuck "locked" for more than 15 minutes

The reveal timer should have fired. If it didn't:

1. Check `/metrics` — look at `gauges.reveal_timers_pending`
   - If 0, no timer is pending — likely the container restarted and
     `recoverRevealTimers` should have run on boot
2. Restart the service (Railway → service → Settings → **Restart**)
   - On boot, recovery queries Base44 for `Whisper?status=locked` and
     re-schedules each one based on its `reveal_scheduled_for` field
3. If still stuck after restart, the whisper may have a missing or
   malformed `reveal_scheduled_for`. Inspect in Base44 directly. Worst
   case, manually `PATCH /api/.../entities/Whisper/<id>` to mark it
   revealed or unverifiable.

---

## Incident: Anthropic spending is way higher than expected

1. Hit `/metrics` and look at `counters.claude_cost_usd_micros` (in
   millionths of a dollar — divide by 1,000,000 for USD)
2. Compare with `counters.claude_calls` to spot per-call cost spikes
3. Check `counters.http_retries` — repeated retries multiply cost
4. Common causes:
   - The poll loop is running too aggressively because many whispers
     are past their `check_after_date`. Inspect `gauges.active_watchers`
     and the poll-interval ladder in `lib/poll-interval.js`
   - Someone is hammering `/scout` or `/reveal` from the public internet.
     Check Railway HTTP Logs for unfamiliar IPs and confirm `WATCHER_AUTH_KEY`
     is set in Railway and the Base44 functions are sending it
   - Large `urls` arrays causing big `checkForEvidence` prompts (each URL
     contributes up to 5000 chars of input)

**Mitigations:**

- Set `FETCH_URL_ALLOWLIST` to constrain `fetchURL` to a small list of
  trusted domains
- Lower `CONFIDENCE_THRESHOLD` is **not** a fix — that triggers more
  locks. Higher threshold reduces locks but doesn't reduce calls (still
  asking Claude every poll cycle)
- Worst case: rotate `WATCHER_AUTH_KEY` (in Railway and in Base44 secrets)
  and observe whether traffic drops — if yes, you had a leaked key

---

## Incident: Circuit breaker is open (Base44 calls failing fast)

`/metrics` shows `counters.circuit_state_changes{circuit=base44,to=open}`
incremented and recent log entries `circuit_state_change`.

**Steps:**

1. Verify Base44 itself is up — log in to the Base44 dashboard and try
   any action
2. If Base44 is up: check `BASE44_API_KEY` in Railway is correct (not
   expired/revoked). Recovery from the breaker happens automatically
   60s after the last failure
3. If Base44 is genuinely down: nothing to do — the breaker is correctly
   protecting your Anthropic budget. Wait for Base44 to recover. Watcher
   self-heals on the next probe

---

## Incident: GitLab account suspended (deploy blocked)

We've been here before — the playbook:

1. **Don't restart Railway.** The current container keeps serving from
   the last successful deploy. Touching it forces a re-pull from GitLab
2. Submit a support ticket via `https://support.github.com` (the
   `support.github.com/contact-next/product-selection/account-restrictions`
   path). Be specific about what the project is and that it's solo work
3. While waiting, you can still deploy local code via Railway CLI:
   ```sh
   ./deploy.sh
   ```
   This works as long as the local folder is up-to-date

---

## Incident: Railway redeployed unexpectedly and lost reveal timers

Railway's auto-redeploy can fire on env var changes. Boot recovery should
re-hydrate the timers from Base44, but verify:

1. After deploy, check Deploy Logs for `[RECOVERY] Found N locked whisper(s)`
2. Hit `/metrics` and confirm `gauges.reveal_timers_pending` matches the
   number of locked whispers in Base44
3. If recovery didn't fire (e.g. logs show `[RECOVERY] Boot error`), the
   most likely cause is a stale `BASE44_API_KEY`. Fix the key, restart

---

## Incident: WATCHER_AUTH_KEY rotated, Base44 functions getting 401

Both sides must match exactly. If you rotated the Railway env var
without updating Base44, every Archon/Reveal call will return 401 and
seers will see broken interactions.

**Fix order (zero-downtime):**

1. Update Base44 secrets first (`WATCHER_AUTH_KEY` in Application Secrets)
2. The Base44 functions read env via `Deno.env.get(...)` on each invocation, so the change is immediate
3. Then update Railway. The watcher reads env via `() => process.env.WATCHER_AUTH_KEY` per request, so the change is immediate after Railway redeploys

If you do it the other way (Railway first), there's a window where Base44
still sends the old key and gets 401s. ~30-60 second window during the
Railway redeploy.

**Emergency:** unset the Railway `WATCHER_AUTH_KEY` env var entirely.
The middleware fail-opens with a startup warning. Endpoints become
unauthenticated but functional. Use as a last resort if you can't
quickly re-sync.

---

## Diagnostic patterns

- **Logs are noisy / hard to grep** — every JSON log line has `level`,
  `event`, `service`. Filter with `jq 'select(.event=="whisper_locked")'`
  or by level
- **Need to test a fix without deploying** — `npm test` runs the full
  suite locally with all I/O mocked. ~2 seconds
- **Need to test against real Base44 without spending Anthropic** — start
  the server with `WATCHER_AUTH_KEY=...` and hit `/healthz`/`/readyz`/
  `/metrics`. None of those touch Anthropic
- **Need to inspect production state** — `/metrics` is the always-on
  source of truth. No SSH or shell access needed

---

## Emergency contact paths

- Railway dashboard: `railway.com` (your account)
- Base44 admin: `base44.com/apps/69d1545f93121e831922ce33`
- GitLab repo: `gitlab.com/amphoracle-group/Amphoracle-project`
- Anthropic console (token usage): `console.anthropic.com`

---

## Conventions when changing this watcher

- **Run tests before pushing.** `./deploy.sh` does this for you
- **Don't add new runtime dependencies** without strong justification
- **Don't put secrets in metric names or values** — `/metrics` is open
- **Don't change `LOCK_TO_REVEAL_MS`** without coordinating with the
  frontend (the user-visible 15-minute countdown is hardcoded there too)
- **New endpoints** that spend Anthropic tokens or write to Base44 must
  go through `requireAuth` and a per-IP rate limit
