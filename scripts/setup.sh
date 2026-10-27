#!/usr/bin/env bash
# ==============================================================================
# Ghita Agent v1.0.0 — One-command setup (Linux / macOS)
# ==============================================================================
# Usage (from the repo root):
#     bash scripts/setup.sh
#
# What it does:
#   1. Verifies Node.js >= 20
#   2. Enables corepack so the pinned pnpm version is used
#   3. Runs `pnpm doctor` and stops early if required tools are missing
#   4. Installs dependencies (pnpm bootstrap) and builds all packages
# ==============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

echo ''
echo '=== Ghita Agent - Setup (v1.0.0) ==='

# --- 1. Node.js ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    echo '[x] Node.js not found. Install Node >= 20 (e.g. via nvm: nvm install 20).'
    exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "[x] Node.js $(node -v) is too old (>= 20 required)."
    exit 1
fi
echo "[ok] Node.js $(node -v)"

# --- 2. pnpm via corepack ------------------------------------------------------
corepack enable 2>/dev/null || true
if ! command -v pnpm >/dev/null 2>&1; then
    echo '[x] pnpm unavailable even after corepack enable.'
    echo '    Fallback: npm install -g pnpm'
    exit 1
fi
echo "[ok] pnpm $(pnpm -v)"

# --- 3. Doctor gate -------------------------------------------------------------
echo ''
if ! node scripts/doctor.mjs; then
    echo ''
    echo 'Setup stopped: fix the problems above, then re-run setup.sh'
    exit 1
fi

# --- 4. Install + build ---------------------------------------------------------
echo ''
echo '=== Installing dependencies (pnpm bootstrap)... ==='
pnpm bootstrap

echo ''
echo '=== Building workspace packages... ==='
pnpm build:packages

echo ''
echo '=== Building sidecar... ==='
node apps/desktop/scripts/build-sidecar.mjs

echo ''
echo '============================================='
echo ' Setup complete!'
echo ''
echo ' Start the desktop app (dev):  pnpm dev:desktop'
echo ' Build installer:              pnpm build:desktop'
echo ' Health check anytime:         pnpm doctor'
echo '============================================='
