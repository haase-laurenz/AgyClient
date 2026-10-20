# AgyClient CLI Installer for Windows (PowerShell)
param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if ($Uninstall) {
    Write-Host "Unlinking agyclient global CLI..." -ForegroundColor Yellow
    npm unlink -g agy-client
    Write-Host "Removed global agyclient link." -ForegroundColor Green
    exit 0
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  AgyClient CLI Installer (Windows)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

Write-Host "[1/4] Installing npm dependencies..." -ForegroundColor Yellow
npm install

Write-Host "[2/4] Building AgyClient packages, CLI, and web dashboard..." -ForegroundColor Yellow
npm run build

Write-Host "[3/4] Linking 'agyclient' and 'agy-client' globally via npm link..." -ForegroundColor Yellow
npm link

Write-Host "[4/4] Verifying Windows PATH configuration..." -ForegroundColor Yellow
$NpmGlobalBin = (npm prefix -g).Trim()
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$NpmGlobalBin*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$NpmGlobalBin", "User")
    $env:Path = "$env:Path;$NpmGlobalBin"
    Write-Host "  Added '$NpmGlobalBin' to your Windows User PATH." -ForegroundColor Green
} else {
    Write-Host "  '$NpmGlobalBin' is already in your Windows PATH." -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Green
Write-Host "  AgyClient installed! You can now run from any terminal:" -ForegroundColor Green
Write-Host "    agyclient start --open" -ForegroundColor White
Write-Host "    agyclient doctor" -ForegroundColor White
Write-Host "    agyclient status" -ForegroundColor White
Write-Host "    agyclient run `"Analyze this repository`"" -ForegroundColor White
Write-Host "    agyclient --help" -ForegroundColor White
Write-Host "========================================================" -ForegroundColor Green
