# AgyClient Startup Script for Windows (PowerShell)
param(
    [int]$Port = 3000,
    [string]$HostAddress = "127.0.0.1",
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Starting AgyClient - Antigravity Control Center" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

if (-not (Test-Path "node_modules")) {
    Write-Host "[1/3] Installing npm dependencies..." -ForegroundColor Yellow
    npm install
}

if ($Rebuild -or -not (Test-Path "apps/server/dist/index.js") -or -not (Test-Path "apps/web/dist/index.html")) {
    Write-Host "[2/3] Building AgyClient packages, backend, and web dashboard..." -ForegroundColor Yellow
    npm run build
}

$env:AGYCLIENT_HOST = $HostAddress
$env:AGYCLIENT_PORT = "$Port"

Write-Host "[3/3] Launching AgyClient at http://${HostAddress}:${Port} ..." -ForegroundColor Green
node apps/server/dist/index.js
