@echo off
title Install Segoe UI Emoji for Windows 7
cd /d "%~dp0"
echo ========================================================
echo   Installing Emoji Font for Windows 7 (Segoe UI Emoji)
echo ========================================================
echo.

set "FONT_SOURCE=%~dp0public\fonts\seguiemj.ttf"
if not exist "%FONT_SOURCE%" (
    if exist "%~dp0seguiemj.ttf" (
        set "FONT_SOURCE=%~dp0seguiemj.ttf"
    )
)

if exist "%FONT_SOURCE%" (
    copy /y "%FONT_SOURCE%" "%windir%\Fonts\seguiemj.ttf" >nul
    reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts" /v "Segoe UI Emoji (TrueType)" /t REG_SZ /d "seguiemj.ttf" /f >nul
    echo [OK] Emoji font installed successfully!
    echo All icons and emojis will now display properly.
    echo Please restart Google Chrome to view the changes.
) else (
    echo [ERROR] Font file not found in public\fonts\seguiemj.ttf.
)
echo.
pause
