@echo off
title HISAB PRO Software Launcher
cd /d "%~dp0"

echo ===================================================
echo     HISAB PRO - Fast Silent Startup Launcher
echo ===================================================

:: Check if server is already running on port 3000
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if %errorlevel% equ 0 (
    echo Server is already active on port 3000.
) else (
    echo Starting HISAB local server...
    start /b "" node server.js
    timeout /t 2 /nobreak >nul
)

:: Open in default web browser
echo Opening HISAB in browser...
start "" "http://localhost:3000/"

exit
