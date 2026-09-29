#!/bin/bash
set -euo pipefail

# Only run in Claude Code on the web (remote) sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# npm install (not npm ci) so the cached container's node_modules is reused.
# --no-save keeps the container's npm from rewriting package-lock.json.
npm install --no-save --no-audit --no-fund

# Generate Next.js route types (LayoutProps, PageProps, ...) so `tsc --noEmit` works.
npx next typegen
