@echo off
title Enable Auto-Start on Windows Boot
cd /d "%~dp0"

set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0Start-Hisab-Pro-Silent.vbs"
set "SHORTCUT=%STARTUP_DIR%\HISAB PRO.lnk"

:: Create shortcut in Startup folder using VBScript
(
echo Set oWS = WScript.CreateObject^("WScript.Shell"^)
echo sLinkFile = "%SHORTCUT%"
echo Set oLink = oWS.CreateShortcut^(sLinkFile^)
echo oLink.TargetPath = "%TARGET%"
echo oLink.WorkingDirectory = "%~dp0"
echo oLink.WindowStyle = 1
echo oLink.Description = "HISAB PRO Auto-Start"
echo oLink.Save
) > "%temp%\create_startup_shortcut.vbs"

cscript //nologo "%temp%\create_startup_shortcut.vbs"
del "%temp%\create_startup_shortcut.vbs" 2>nul

echo ========================================================
echo   [OK] HISAB PRO will now automatically start and open
echo   in your browser whenever you turn on this PC!
echo ========================================================
echo.
pause

