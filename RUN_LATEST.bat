@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-sync-run.ps1"
if errorlevel 1 (
  echo.
  echo 실행 중 오류가 발생했습니다.
  echo 위 메시지를 확인해 주세요.
  echo.
  pause
)
