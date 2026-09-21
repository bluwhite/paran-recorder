@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-check.ps1"
if errorlevel 1 (
  echo.
  echo Development environment check failed.
)
echo.
pause
