@echo off
setlocal EnableExtensions

echo.
echo ===============================================
echo  Paran Recorder Development Tools Installer
echo ===============================================
echo.
echo This installs:
echo   1. Node.js LTS
echo   2. Rustup / Rust MSVC toolchain
echo   3. Visual Studio 2022 Build Tools - C++ workload
echo.
echo The Visual Studio component is large and may take some time.
echo.

where winget >nul 2>&1
if errorlevel 1 (
  echo [ERROR] winget was not found.
  echo Install or update "App Installer" from Microsoft Store, then try again.
  echo.
  pause
  exit /b 1
)

echo [1/3] Installing Node.js LTS...
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements --silent
if errorlevel 1 (
  echo [WARN] Node.js install returned a non-zero code.
  echo It may already be installed or may require attention.
)

echo.
echo [2/3] Installing Rustup...
winget install --id Rustlang.Rustup -e --source winget --accept-package-agreements --accept-source-agreements --silent
if errorlevel 1 (
  echo [WARN] Rustup install returned a non-zero code.
  echo It may already be installed or may require attention.
)

set "PATH=%ProgramFiles%\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"

if exist "%USERPROFILE%\.cargo\bin\rustup.exe" (
  echo.
  echo Configuring stable Rust MSVC toolchain...
  "%USERPROFILE%\.cargo\bin\rustup.exe" toolchain install stable-x86_64-pc-windows-msvc
  "%USERPROFILE%\.cargo\bin\rustup.exe" default stable-x86_64-pc-windows-msvc
)

echo.
echo [3/3] Installing Visual Studio 2022 C++ Build Tools...
echo This is the largest download.
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --accept-package-agreements --accept-source-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
if errorlevel 1 (
  echo.
  echo [WARN] Visual Studio Build Tools returned a non-zero code.
  echo If the installer reports that a restart is required, restart Windows first.
)

echo.
echo ===============================================
echo  Installation step finished.
echo ===============================================
echo.
echo Close this window, then run:
echo   ParanRecorder_DEV_START_NOGIT.bat
echo.
echo If Windows asks for a restart, restart first.
echo.
pause
endlocal
