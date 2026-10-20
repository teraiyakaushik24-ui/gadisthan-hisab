@echo off
title STOP HISAB PRO Server
cd /d "%~dp0"
echo ================================================================
echo           HISAB PRO - સર્વર બંધ કરી રહ્યું છે...
echo ================================================================
echo.

set FOUND=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /R /C:":3000 .*LISTENING"') do (
    echo Terminating PID: %%a on port 3000...
    taskkill /F /PID %%a >nul 2>&1
    set FOUND=1
)

:: Terminate Cloudflare Tunnel if running
taskkill /F /IM cloudflared.exe >nul 2>&1

if "%FOUND%"=="1" (
    echo.
    echo [SUCCESS] HISAB PRO સર્વર સફળતાપૂર્વક બંધ થઈ ગયું છે.
) else (
    echo.
    echo [INFO] પોર્ટ 3000 પર કોઈ HISAB સર્વર ચાલુ નથી.
)

echo.
ping 127.0.0.1 -n 2 >nul
