@echo off
title Horizon Browser - Build
cd /d "%~dp0"

echo.
echo ==========================================
echo   Horizon Browser - Windows Build
echo ==========================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Install Node.js 20 or newer from https://nodejs.org
    pause
    exit /b 1
)

echo [1/2] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo.
echo [2/2] Building Horizon (installer + portable)...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo Done! Files are in the "dist" folder:
echo   Horizon-Setup-x.y.z.exe     (installer - this is what auto-update uses)
echo   Horizon-Portable-x.y.z.exe  (portable, updates manually)
echo.
pause
