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
Write-Host " Paran Recorder 최신 개발판 테스트"
Write-Host "==============================================="
Write-Host ""

foreach ($cmd in @('git','node','npm','cargo','rustc')) {
    if (-not (Has-Command $cmd)) {
        Fail "$cmd 명령을 찾을 수 없습니다."
        Write-Host "먼저 SETUP_DEV.bat를 실행하세요."
        exit 1
    }
}

if (-not (Test-Path '.git')) {
    Fail "이 폴더는 Git 저장소가 아닙니다."
    Write-Host "GitHub에서 저장소를 clone한 폴더에서 실행해야 합니다."
    exit 1
}

$changes = git status --porcelain
if ($changes) {
    Warn "로컬에서 수정된 파일이 있습니다."
    Write-Host "최신 소스를 받으면 충돌할 수 있으므로 자동 업데이트를 중단했습니다."
    Write-Host ""
    git status --short
    Write-Host ""
    Write-Host "수정 내용을 보존하거나 되돌린 뒤 다시 실행하세요."
    exit 1
}

Write-Host "[1/3] GitHub 최신 소스 확인..."
& git checkout main --quiet
if ($LASTEXITCODE -ne 0) { throw "main 브랜치 전환 실패" }
& git pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw "git pull 실패" }
Ok "최신 소스 동기화 완료"

Write-Host ""
Write-Host "[2/3] npm 패키지 확인..."
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install 실패" }
Ok "npm 패키지 확인 완료"

Write-Host ""
Write-Host "[3/3] Tauri 개발판 실행..."
Write-Host ""
Write-Host "이 창은 프로그램을 사용하는 동안 열어 두세요."
Write-Host "종료하려면 Paran Recorder 창을 닫고 이 창에서 Ctrl+C를 누르면 됩니다."
Write-Host "프런트 수정은 자동 반영되고 Rust 수정은 자동 재컴파일됩니다."
Write-Host ""

$env:RUST_BACKTRACE = '1'
& npm run tauri:dev
if ($LASTEXITCODE -ne 0) {
    Fail "개발판 실행이 종료되었습니다. 위 오류 메시지를 확인하세요."
    exit $LASTEXITCODE
}
