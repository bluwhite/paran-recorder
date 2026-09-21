$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Paran Recorder - Latest Dev Test'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

function Has-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ok([string]$Text) { Write-Host "[OK]   $Text" -ForegroundColor Green }
function Fail([string]$Text) { Write-Host "[FAIL] $Text" -ForegroundColor Red }

Write-Host ""
Write-Host "==============================================="
Write-Host " Paran Recorder local development test"
Write-Host "==============================================="
Write-Host ""

foreach ($cmd in @('node','npm','cargo','rustc')) {
    if (-not (Has-Command $cmd)) {
        Fail "$cmd was not found."
        Write-Host "Run SETUP_DEV.bat first."
        exit 1
    }
}

Write-Host "[1/2] Checking npm packages..."
& npm install --no-audit --no-fund --no-package-lock
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
Ok "npm packages ready"

Write-Host ""
Write-Host "[2/2] Starting Tauri development app..."
Write-Host ""
Write-Host "Keep this console window open while testing."
Write-Host "Frontend changes reload automatically."
Write-Host "Rust changes are recompiled automatically."
Write-Host "Use Ctrl+C here to stop the development server."
Write-Host ""

$env:RUST_BACKTRACE = '1'
& npm run tauri:dev
if ($LASTEXITCODE -ne 0) {
    Fail "The development app stopped with an error."
    exit $LASTEXITCODE
}
