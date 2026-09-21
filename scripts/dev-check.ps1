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
Write-Host " Paran Recorder 개발환경 확인"
Write-Host "==============================================="
Write-Host ""

$failed = $false

if (Has-Command 'git') {
    Ok ("Git " + ((git --version) -replace '^git version\s*',''))
} else {
    Fail "Git이 설치되어 있지 않습니다."
    Write-Host "  설치: https://git-scm.com/download/win"
    $failed = $true
}

if (Has-Command 'node') {
    $nodeVersion = node --version
    Ok "Node.js $nodeVersion"
} else {
    Fail "Node.js가 설치되어 있지 않습니다."
    Write-Host "  설치: https://nodejs.org/"
    $failed = $true
}

if (Has-Command 'npm') {
    Ok ("npm " + (npm --version))
} else {
    Fail "npm을 찾을 수 없습니다."
    $failed = $true
}

if (Has-Command 'rustc') {
    Ok (rustc --version)
} else {
    Fail "Rust가 설치되어 있지 않습니다."
    Write-Host "  설치: https://rustup.rs/"
    $failed = $true
}

if (Has-Command 'cargo') {
    Ok (cargo --version)
} else {
    Fail "Cargo를 찾을 수 없습니다."
    $failed = $true
}

$programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
$vswhere = Join-Path $programFilesX86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path $vswhere) {
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($vsPath) {
        Ok "Visual Studio C++ Build Tools"
    } else {
        Warn "Visual Studio는 있지만 C++ Build Tools가 확인되지 않았습니다."
        Write-Host "  Visual Studio Installer에서 'Desktop development with C++'를 추가하세요."
        $failed = $true
    }
} else {
    Warn "Visual Studio C++ Build Tools 설치 여부를 확인하지 못했습니다."
    Write-Host "  Tauri Rust 컴파일 오류가 나면 Visual Studio Build Tools의"
    Write-Host "  'Desktop development with C++' 워크로드를 설치하세요."
}

if ($failed) {
    Write-Host ""
    Fail "필수 개발환경이 부족합니다. 위 항목을 설치한 뒤 이 파일을 다시 실행하세요."
    exit 1
}

Write-Host ""
Write-Host "[1/3] npm 패키지 확인..."
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install 실패" }
Ok "npm 패키지 준비 완료"

Write-Host ""
Write-Host "[2/3] Tauri CLI 확인..."
& npm run tauri -- --version
if ($LASTEXITCODE -ne 0) { throw "Tauri CLI 확인 실패" }
Ok "Tauri CLI 준비 완료"

Write-Host ""
Write-Host "[3/3] Rust 의존성 미리 받기..."
& cargo fetch --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw "cargo fetch 실패" }
Ok "Rust 의존성 준비 완료"

Set-Content -Path (Join-Path $Root '.dev-setup-ok') -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding ASCII

Write-Host ""
Write-Host "==============================================="
Write-Host " 개발환경 준비 완료"
Write-Host " 이제 RUN_LATEST.bat만 더블클릭하면 됩니다."
Write-Host "==============================================="
Write-Host ""
