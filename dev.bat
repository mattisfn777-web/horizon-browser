@echo off
title Horizon Browser - Dev Mode
cd /d "%~dp0"

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing dependencies first...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

call npm start
