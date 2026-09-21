@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "%~dp0.dev-setup-ok" (
  echo.
  echo [Paran Recorder] 첫 실행입니다. 개발환경을 먼저 준비합니다.
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-check.ps1"
  if errorlevel 1 (
    echo.
    echo 개발환경 준비에 실패했습니다.
    echo 위 메시지를 확인한 뒤 다시 실행해 주세요.
    echo.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-sync-run.ps1"
if errorlevel 1 (
  echo.
  echo 실행 중 오류가 발생했습니다.
  echo 위 메시지를 확인해 주세요.
  echo.
  pause
)
