@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-check.ps1"
if errorlevel 1 (
  echo.
  echo 개발환경 확인 중 오류가 발생했습니다.
)
echo.
pause
