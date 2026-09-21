@echo off
cd /d "%~dp0"

if not exist "%~dp0.dev-setup-ok" (
  echo.
  echo [Paran Recorder] First run. Checking the development environment...
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-check.ps1"
  if errorlevel 1 (
    echo.
    echo Development environment setup failed.
    echo Check the messages above and run this file again.
    echo.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-sync-run.ps1"
if errorlevel 1 (
  echo.
  echo Development run failed.
  echo Check the messages above.
  echo.
  pause
)
