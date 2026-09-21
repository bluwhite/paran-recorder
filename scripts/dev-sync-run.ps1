$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Paran Recorder - Latest Dev Test'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $Root

function Has-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ok([string]$Text) { Write-Host "[OK]   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "[WARN] $Text" -ForegroundColor Yellow }
function Fail([string]$Text) { Write-Host "[FAIL] $Text" -ForegroundColor Red }

Write-Host ""
Write-Host "==============================================="
Write-Host " Paran Recorder latest development test"
Write-Host "==============================================="
Write-Host ""

foreach ($cmd in @('git','node','npm','cargo','rustc')) {
    if (-not (Has-Command $cmd)) {
        Fail "$cmd was not found."
        Write-Host "Run SETUP_DEV.bat first."
        exit 1
    }
}

if (-not (Test-Path '.git')) {
    Fail "This folder is not a Git repository."
    exit 1
}

$changes = git status --porcelain
if ($changes) {
    Warn "Local source changes were found."
    Write-Host "Automatic update was stopped to avoid overwriting local work."
    Write-Host ""
    git status --short
    Write-Host ""
    Write-Host "Commit, stash, or revert the local changes, then run again."
    exit 1
}

Write-Host "[1/3] Updating source from GitHub..."
& git checkout main --quiet
if ($LASTEXITCODE -ne 0) { throw "git checkout main failed" }
& git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
Ok "Source is up to date"

Write-Host ""
Write-Host "[2/3] Checking npm packages..."
& npm install --no-audit --no-fund --no-package-lock
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
Ok "npm packages ready"

Write-Host ""
Write-Host "[3/3] Starting Tauri development app..."
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
