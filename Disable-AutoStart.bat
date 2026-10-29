@echo off
title Disable Auto-Start
set "SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HISAB PRO.lnk"
if exist "%SHORTCUT%" (
    del "%SHORTCUT%" /f /q 2>nul
    echo ========================================================
    echo   [OK] Auto-start on boot has been disabled.
    echo ========================================================
) else (
    echo Auto-start is not enabled.
)
echo.
pause

