@echo off
title SHREE GADISTHAN JETPUR - HISAB ONLINE LAUNCHER
color 0E
cd /d "%~dp0"

echo ================================================================
echo         SHREE GADISTHAN JETPUR - HISAB PRO ONLINE
echo ================================================================
echo.
echo [1/3] Server checking...

:: Start node server if not running
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if %errorlevel% neq 0 (
    echo [INFO] Starting Node.js backend server...
    start /b "" node server.js
    timeout /t 3 /nobreak >nul
) else (
    echo [INFO] Server is already active on port 3000.
)

echo.
echo [2/3] Starting Secure Cloud Tunnel...
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 1 /nobreak >nul

del /f /q tunnel.log >nul 2>&1
start /b "" "%~dp0cloudflared.exe" tunnel --url http://localhost:3000 > tunnel.log 2>&1

echo [INFO] Connecting to Cloudflare Global Network...
timeout /t 6 /nobreak >nul

:: Extract URL
set "ONLINE_URL="
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "(Get-Content tunnel.log -ErrorAction SilentlyContinue | Select-String 'trycloudflare.com' | Select-Object -Last 1) -replace '.*(https://[^\s]+).*', '$1'"') do (
    set "ONLINE_URL=%%i"
)

echo.
echo ================================================================
echo  LIVE ONLINE WEB LINK (Windows 7 / Mobile / Anywhere):
if defined ONLINE_URL (
    color 0A
    echo.
    echo    %ONLINE_URL%
    echo.
    echo ================================================================
    echo  Login Email   : Teraiya.Kaushik24@gmail.com
    echo  Login Password: (Stored securely)
    echo ================================================================
    echo.
    echo Opening in browser...
    start "" "%ONLINE_URL%"
) else (
    echo  Link generating in background. Check: http://localhost:3000
    start "" "http://localhost:3000"
)

echo.
echo NOTE: Aa window chalu rakhvi je thi Windows 7 ma online chale.
echo Minimize kari shako cho.
pause >nul
