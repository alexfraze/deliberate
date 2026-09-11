#!/bin/bash
# SessionStart hook: make `pnpm test` / `pnpm lint` work in Claude Code on the web.
# Runs only in remote sessions; local checkouts manage their own installs.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null 2>&1
fi

# `pnpm install` (not `--frozen-lockfile`) so a branch that legitimately adds a dependency still
# gets a working environment; CI is where the lockfile is enforced.
pnpm install --prefer-offline

echo "session-start: dependencies installed (node $(node --version), pnpm $(pnpm --version))"
