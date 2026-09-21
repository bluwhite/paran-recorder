$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Paran Recorder - Dev Environment Check'

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
Write-Host " Paran Recorder development environment check"
Write-Host "==============================================="
Write-Host ""

$failed = $false

if (Has-Command 'node') {
    Ok ("Node.js " + (node --version))
} else {
    Fail "Node.js is not installed."
    Write-Host "  Run INSTALL_DEV_TOOLS.bat from the project folder."
    $failed = $true
}

if (Has-Command 'npm') {
    Ok ("npm " + (npm --version))
} else {
    Fail "npm was not found."
    $failed = $true
}

if (Has-Command 'rustc') {
    Ok (rustc --version)
} else {
    Fail "Rust is not installed."
    Write-Host "  Run INSTALL_DEV_TOOLS.bat from the project folder."
    $failed = $true
}

if (Has-Command 'cargo') {
    Ok (cargo --version)
} else {
    Fail "Cargo was not found."
    $failed = $true
}

$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vsPath) {
        Ok "Visual Studio C++ Build Tools"
    } else {
        Warn "Visual Studio was found, but C++ Build Tools were not detected."
        Write-Host "  Add the 'Desktop development with C++' workload."
        $failed = $true
    }
} else {
    Warn "Visual Studio C++ Build Tools could not be detected."
    Write-Host "  Run INSTALL_DEV_TOOLS.bat to install the C++ workload automatically."
}

if ($failed) {
    Write-Host ""
    Fail "Required development tools are missing."
    exit 1
}

Write-Host ""
Write-Host "[1/3] Checking npm packages..."
& npm install --no-audit --no-fund --no-package-lock
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
Ok "npm packages ready"

Write-Host ""
Write-Host "[2/3] Checking Tauri CLI..."
& npm run tauri -- --version
if ($LASTEXITCODE -ne 0) { throw "Tauri CLI check failed" }
Ok "Tauri CLI ready"

Write-Host ""
Write-Host "[3/3] Fetching Rust dependencies..."
& cargo fetch --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw "cargo fetch failed" }
Ok "Rust dependencies ready"

Set-Content -Path (Join-Path $Root '.dev-setup-ok') -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding ASCII

Write-Host ""
Write-Host "==============================================="
Write-Host " Development environment is ready."
Write-Host " You can now use START_DEV.bat."
Write-Host "==============================================="
Write-Host ""
