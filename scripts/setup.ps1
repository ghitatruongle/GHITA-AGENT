# ==============================================================================
# Ghita Agent v1.0.0 — One-command setup (Windows)
# ==============================================================================
# Usage (PowerShell, from the repo root):
#     powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
#
# What it does:
#   1. Verifies Node.js >= 20 (offers winget install when missing)
#   2. Enables corepack so the pinned pnpm version is used
#   3. Runs `pnpm doctor` and stops early if required tools are missing
#   4. Installs dependencies (pnpm bootstrap) and builds all packages
# ==============================================================================

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

Write-Host ''
Write-Host '=== Ghita Agent - Setup (v1.0.0) ===' -ForegroundColor Cyan

# --- 1. Node.js ---------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '[x] Node.js not found.' -ForegroundColor Red
    Write-Host '    Install it with:  winget install OpenJS.NodeJS.LTS'
    Write-Host '    Then re-run this script.'
    exit 1
}
$nodeVersion = (node -v) -replace '^v', ''
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 20) {
    Write-Host "[x] Node.js $nodeVersion is too old (>= 20 required)." -ForegroundColor Red
    Write-Host '    Update with:  winget upgrade OpenJS.NodeJS.LTS'
    exit 1
}
Write-Host "[ok] Node.js $nodeVersion" -ForegroundColor Green

# --- 2. pnpm via corepack ------------------------------------------------------
try {
    corepack enable 2>$null
} catch { }
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Write-Host '[x] pnpm unavailable even after corepack enable.' -ForegroundColor Red
    Write-Host '    Fallback:  npm install -g pnpm'
    exit 1
}
Write-Host "[ok] pnpm $(pnpm -v)" -ForegroundColor Green

# --- 3. Doctor gate -------------------------------------------------------------
Write-Host ''
node scripts/doctor.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'Setup stopped: fix the problems above, then re-run setup.ps1' -ForegroundColor Yellow
    exit 1
}

# --- 4. Install + build ---------------------------------------------------------
Write-Host ''
Write-Host '=== Installing dependencies (pnpm bootstrap)... ===' -ForegroundColor Cyan
pnpm bootstrap
if ($LASTEXITCODE -ne 0) { Write-Host 'Install failed.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '=== Building workspace packages... ===' -ForegroundColor Cyan
pnpm build:packages
if ($LASTEXITCODE -ne 0) { Write-Host 'Package build failed.' -ForegroundColor Red; exit 1 }

Write-Host ''
Write-Host '=== Building sidecar... ===' -ForegroundColor Cyan
node apps/desktop/scripts/build-sidecar.mjs

Write-Host ''
Write-Host '=============================================' -ForegroundColor Green
Write-Host ' Setup complete!' -ForegroundColor Green
Write-Host ''
Write-Host ' Start the desktop app (dev):  pnpm dev:desktop'
Write-Host ' Build installer:              pnpm build:desktop'
Write-Host ' Health check anytime:         pnpm doctor'
Write-Host '=============================================' -ForegroundColor Green
