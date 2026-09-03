#!/bin/bash

##############################################################################
# Amphoracle Oracle Watcher Health Check
#
# Monitors and restores health of stuck/failed watchers by:
# 1. Finding watchers stuck in 'fetching' state for >30 min
# 2. Finding watchers in 'failed' state
# 3. Resetting them to 'pending' for retry
# 4. Logging the maintenance action
#
# Usage: ./scripts/health-check.sh
##############################################################################

set -euo pipefail

# Configuration
API_BASE="https://api.base44.com/api/apps/69d1545f93121e831922ce33"
API_KEY="${BASE44_API_KEY:?ERROR: BASE44_API_KEY environment variable not set}"
ENTITY_TYPE="OracleWatcher"
LOG_LEVEL="${LOG_LEVEL:-info}"

# Counters
STUCK_RESET=0
FAILED_RESET=0
ERRORS=0

##############################################################################
# Logging Functions
##############################################################################

log_info() {
  echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') - $*"
}

log_error() {
  echo "[ERROR] $(date '+%Y-%m-%d %H:%M:%S') - $*" >&2
}

log_debug() {
  if [[ "${LOG_LEVEL}" == "debug" ]]; then
    echo "[DEBUG] $(date '+%Y-%m-%d %H:%M:%S') - $*"
  fi
}

##############################################################################
# Retry Function for Network Resilience
##############################################################################

retry_with_backoff() {
  local max_attempts=4
  local backoff=2
  local attempt=1

  while [[ $attempt -le $max_attempts ]]; do
    if "$@"; then
      return 0
    fi

    if [[ $attempt -lt $max_attempts ]]; then
      log_info "Attempt $attempt failed, retrying in ${backoff}s..."
      sleep "$backoff"
      backoff=$((backoff * 2))
    fi
    attempt=$((attempt + 1))
  done

  log_error "Command failed after $max_attempts attempts: $*"
  return 1
}

##############################################################################
# API Functions
##############################################################################

api_get() {
  local endpoint="$1"
  local url="${API_BASE}${endpoint}"

  log_debug "GET $url"

  curl -s -f \
    -X GET \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    "$url"
}

api_patch() {
  local endpoint="$1"
  local data="$2"
  local url="${API_BASE}${endpoint}"

  log_debug "PATCH $url"
  log_debug "Body: $data"

  curl -s -f \
    -X PATCH \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$data" \
    "$url"
}

api_post() {
  local endpoint="$1"
  local data="$2"
  local url="${API_BASE}${endpoint}"

  log_debug "POST $url"
  log_debug "Body: $data"

  curl -s -f \
    -X POST \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$data" \
    "$url"
}

##############################################################################
# Step 1: Reset Stuck Watchers
##############################################################################

check_and_reset_stuck_watchers() {
  log_info "Step 1: Checking for stuck watchers (fetching > 30 min)..."

  local response
  response=$(retry_with_backoff api_get "/entities/${ENTITY_TYPE}?status=fetching&limit=100")

  local count=$(echo "$response" | jq -r '.items | length // 0')
  log_info "Found $count stuck watchers in 'fetching' state"

  if [[ $count -eq 0 ]]; then
    return 0
  fi

  # Process each stuck watcher
  echo "$response" | jq -r '.items[] | .id' | while read -r watcher_id; do
    log_info "Resetting stuck watcher: $watcher_id"

    local reset_data='{"status":"pending"}'

    if retry_with_backoff api_patch "/entities/${ENTITY_TYPE}/${watcher_id}" "$reset_data"; then
      log_info "✓ Successfully reset $watcher_id"
      STUCK_RESET=$((STUCK_RESET + 1))
    else
      log_error "✗ Failed to reset $watcher_id"
      ERRORS=$((ERRORS + 1))
    fi
  done
}

##############################################################################
# Step 2: Reset Failed Watchers
##############################################################################

check_and_reset_failed_watchers() {
  log_info "Step 2: Checking for failed watchers..."

  local response
  response=$(retry_with_backoff api_get "/entities/${ENTITY_TYPE}?status=failed&limit=100")

  local count=$(echo "$response" | jq -r '.items | length // 0')
  log_info "Found $count watchers in 'failed' state"

  if [[ $count -eq 0 ]]; then
    return 0
  fi

  # Process each failed watcher
  echo "$response" | jq -r '.items[] | .id' | while read -r watcher_id; do
    log_info "Resetting failed watcher: $watcher_id"

    local reset_data='{"status":"pending"}'

    if retry_with_backoff api_patch "/entities/${ENTITY_TYPE}/${watcher_id}" "$reset_data"; then
      log_info "✓ Successfully reset $watcher_id"
      FAILED_RESET=$((FAILED_RESET + 1))
    else
      log_error "✗ Failed to reset $watcher_id"
      ERRORS=$((ERRORS + 1))
    fi
  done
}

##############################################################################
# Step 3: Log Health Check Result
##############################################################################

log_health_check_result() {
  log_info "Step 3: Logging health check result..."

  local status="success"
  [[ $ERRORS -gt 0 ]] && status="partial"

  local summary="Health check complete — ${STUCK_RESET} stuck watchers reset, ${FAILED_RESET} failed watchers reset"

  local log_data=$(jq -n \
    --arg action_type "admin_command" \
    --arg agent "archon" \
    --arg status "$status" \
    --arg summary "$summary" \
    --arg triggered_by "schedule" \
    '{
      action_type: $action_type,
      agent: $agent,
      status: $status,
      summary: $summary,
      triggered_by: $triggered_by,
      timestamp: now | todate
    }')

  if retry_with_backoff api_post "/entities/ArchonLog" "$log_data"; then
    log_info "✓ Health check logged successfully"
  else
    log_error "✗ Failed to log health check (non-fatal)"
  fi
}

##############################################################################
# Main Execution
##############################################################################

main() {
  log_info "=========================================="
  log_info "Amphoracle Health Check Started"
  log_info "=========================================="

  # Verify API key is set
  if [[ -z "${BASE44_API_KEY:-}" ]]; then
    log_error "BASE44_API_KEY not configured"
    exit 1
  fi

  # Run health checks
  check_and_reset_stuck_watchers || true
  check_and_reset_failed_watchers || true
  log_health_check_result || true

  log_info "=========================================="
  log_info "Health Check Complete"
  log_info "Results: $STUCK_RESET stuck reset, $FAILED_RESET failed reset"
  log_info "Errors: $ERRORS"
  log_info "=========================================="

  if [[ $ERRORS -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
