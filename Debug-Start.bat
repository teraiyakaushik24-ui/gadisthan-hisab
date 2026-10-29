@echo off
title HISAB PRO - Diagnostics
cd /d "%~dp0"

echo ========================================================
echo        HISAB PRO - Diagnostics & Startup
echo ========================================================
echo.

set "NODE_CMD="
if exist "%~dp0node.exe" (
    set "NODE_CMD=%~dp0node.exe"
    echo [OK] Using bundled node.exe in this folder
) else if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_CMD=%ProgramFiles%\nodejs\node.exe"
    echo [OK] Using installed Node at %ProgramFiles%\nodejs\node.exe
) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set "NODE_CMD=%ProgramFiles(x86)%\nodejs\node.exe"
    echo [OK] Using installed Node at %ProgramFiles(x86)%\nodejs\node.exe
) else (
    set "NODE_CMD=node"
    echo [INFO] Using system PATH node
)

echo.
echo Checking Node version:
"%NODE_CMD%" -v
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Node.js was not found!
    echo Please make sure node.exe is in this folder or node-v13.14.0-x64.msi is installed.
    pause
    exit /b
)

echo.
echo Starting HISAB PRO server on port 3000...
echo.
start http://localhost:3000
"%NODE_CMD%" server.js
pause

