@echo off
title HISAB PRO - Daily Accounting
cd /d "%~dp0"

:: Set Node executable path
set "NODE_CMD="
if exist "%~dp0node.exe" (
    set "NODE_CMD=%~dp0node.exe"
) else if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_CMD=%ProgramFiles%\nodejs\node.exe"
) else if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set "NODE_CMD=%ProgramFiles(x86)%\nodejs\node.exe"
) else (
    set "NODE_CMD=node"
)

:: Find Chrome executable
set "BROWSER_CMD="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_CMD=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_CMD=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_CMD=%LocalAppData%\Google\Chrome\Application\chrome.exe"
)

:: Check if server already running on port 3000
netstat -ano | findstr :3000 >nul
if %errorlevel% equ 0 (
    if defined BROWSER_CMD (
        start "" "%BROWSER_CMD%" http://localhost:3000
    ) else (
        start http://localhost:3000
    )
    exit
)

:: Start server in background
start /min "HISAB PRO Server" "%NODE_CMD%" server.js

:: Wait 3 seconds for server initialization
timeout /t 3 /nobreak >nul

:: Open in Chrome or default browser
if defined BROWSER_CMD (
    start "" "%BROWSER_CMD%" http://localhost:3000
) else (
    start http://localhost:3000
)
exit
