#!/usr/bin/env bash
#
# Local deploy helper. Runs the test suite, then ships via Railway CLI.
# Use whenever you've replaced the project folder with a fresh GitLab zip
# (or pulled the latest via git) and want to push to Railway production.
#
# Usage:
#   ./deploy.sh          # standard deploy: test then ship
#   ./deploy.sh --skip-tests   # only if you trust the code; not recommended

set -euo pipefail

cd "$(dirname "$0")"

echo "==> deploy.sh starting in $(pwd)"

if [[ "${1:-}" != "--skip-tests" ]]; then
  if [[ -f package-lock.json ]]; then
    echo "==> Installing dependencies (npm ci)"
    npm ci --no-audit --no-fund
  else
    echo "==> Installing dependencies (npm install)"
    npm install --no-audit --no-fund
  fi

  echo "==> Running test suite"
  npm test
else
  echo "==> Skipping tests (per --skip-tests)"
fi

echo "==> Deploying to Railway"
if ! command -v railway >/dev/null 2>&1; then
  echo "ERROR: 'railway' CLI not found in PATH."
  echo "Install with: curl -fsSL cli.new | sh"
  exit 1
fi

railway up

echo "==> Deploy submitted."
echo "==> Verify Archon in Base44, or hit:"
echo "    https://amphoracle-watcher-production.up.railway.app/healthz"
echo "    https://amphoracle-watcher-production.up.railway.app/readyz"
echo "    https://amphoracle-watcher-production.up.railway.app/metrics"
