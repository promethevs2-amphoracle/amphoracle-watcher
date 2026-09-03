# Amphoracle Scripts

## Health Check (`health-check.sh`)

Automated health monitoring and recovery for Oracle Watchers.

### What it does

The health check performs three automated maintenance tasks:

1. **Detects Stuck Watchers** — Finds watchers stuck in `fetching` state for >30 minutes
2. **Resets Failed Watchers** — Finds watchers in `failed` state
3. **Recovers** — Resets all stuck/failed watchers to `pending` for automatic retry
4. **Logs Results** — Records all maintenance actions to `ArchonLog` for audit

### Features

- ✅ **Resilient** — Built-in retry logic with exponential backoff (2s, 4s, 8s, 16s)
- ✅ **Safe** — Idempotent operations; can run multiple times without side effects
- ✅ **Observable** — Detailed logging at INFO (default) or DEBUG level
- ✅ **Reliable** — Never fails silently; reports all errors

### Setup

1. **Configure API Key** (local environment):
   ```bash
   cp .env.example .env
   # Edit .env and set your BASE44_API_KEY
   ```

2. **Run Manually**:
   ```bash
   export BASE44_API_KEY="your-api-key-here"
   ./scripts/health-check.sh
   ```

3. **Schedule with cron** (recommended):
   ```bash
   # Every 5 minutes
   */5 * * * * cd /path/to/amphoracle-watcher && BASE44_API_KEY="xxx" ./scripts/health-check.sh >> logs/health-check.log 2>&1
   ```

4. **Use in CI/CD** (GitHub Actions example):
   ```yaml
   - name: Oracle Watcher Health Check
     env:
       BASE44_API_KEY: ${{ secrets.BASE44_API_KEY }}
     run: ./scripts/health-check.sh
   ```

### Logging

**Output example:**
```
[INFO] 2026-09-03 09:56:10 - Amphoracle Health Check Started
[INFO] 2026-09-03 09:56:10 - Step 1: Checking for stuck watchers (fetching > 30 min)...
[INFO] 2026-09-03 09:56:10 - Found 3 stuck watchers in 'fetching' state
[INFO] 2026-09-03 09:56:11 - Resetting stuck watcher: watcher-001
[INFO] 2026-09-03 09:56:12 - ✓ Successfully reset watcher-001
...
[INFO] 2026-09-03 09:56:56 - Health Check Complete
[INFO] 2026-09-03 09:56:56 - Results: 3 stuck reset, 2 failed reset
[INFO] 2026-09-03 09:56:56 - Errors: 0
```

**Debug mode:**
```bash
export LOG_LEVEL=debug
./scripts/health-check.sh
```

### Error Handling

- **Connection timeouts** — Automatically retries with exponential backoff (max 4 attempts)
- **API errors** — Logged but non-fatal; health check continues
- **Missing credentials** — Fails fast with clear error message

### Troubleshooting

**"BASE44_API_KEY not configured"**
```bash
export BASE44_API_KEY="your-api-key"
./scripts/health-check.sh
```

**"Command failed after 4 attempts"**
- Check network connectivity to `api.base44.com`
- Verify API key is valid
- Check Base44 service status

**"jq: parse error"**
- API returned non-JSON response (likely error page)
- Check Base44 API endpoint availability
- Verify API credentials

### API Details

Uses the following Base44 entities:

- **OracleWatcher** — Main entity type being monitored
- **ArchonLog** — Audit log for all maintenance actions

### Exit Codes

- `0` — Success (with or without resets)
- `1` — Errors occurred during operation

---

For API documentation, see: https://base44.com/docs/api
