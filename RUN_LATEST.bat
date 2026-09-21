@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-sync-run.ps1"
if errorlevel 1 (
  echo.
  echo Development run failed.
  echo Check the messages above.
  echo.
  pause
)
