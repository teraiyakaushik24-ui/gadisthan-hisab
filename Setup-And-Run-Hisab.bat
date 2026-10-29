@echo off
title HISAB PRO - Auto Setup & Launcher
color 0b
cd /d "%~dp0"

echo ======================================================================
echo                     HISAB PRO - DAILY ACCOUNTING
echo             Automated Cloud Setup & 1-Click Local Runner
echo ======================================================================
echo.

:: Detect installation drive (Prefer D:, fallback to C:)
set "TARGET_DIR=D:\hisab-software"
if not exist "D:\" set "TARGET_DIR=C:\hisab-software"

if exist "%TARGET_DIR%\server.js" (
    if exist "%TARGET_DIR%\node.exe" (
        goto :LAUNCH
    )
)

echo [1/4] HISAB PRO is not yet installed on this PC.
echo       Target Location: %TARGET_DIR%
echo.
echo [2/4] Downloading latest complete package from GitHub...
echo       Please wait 10-20 seconds...
echo.

set "ZIP_URL=https://github.com/teraiyakaushik24-ui/gadisthan-hisab/releases/download/v1.0.0/hisab-software-portable.zip"
set "TEMP_ZIP=%TEMP%\hisab-portable-%RANDOM%.zip"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls; " ^
    "$wc = New-Object System.Net.WebClient; " ^
    "$wc.Headers.Add('User-Agent', 'HISAB-PRO-Installer'); " ^
    "Write-Host 'Downloading...'; " ^
    "$wc.DownloadFile('%ZIP_URL%', '%TEMP_ZIP%'); " ^
    "Write-Host 'Download complete!';"

if not exist "%TEMP_ZIP%" (
    echo [ERROR] Download failed. Please check your internet connection.
    pause
    exit /b
)

echo.
echo [3/4] Extracting software to %TARGET_DIR%...
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; " ^
    "[System.IO.Compression.ZipFile]::ExtractToDirectory('%TEMP_ZIP%', '%TARGET_DIR%');"

del "%TEMP_ZIP%" /f /q 2>nul

:: Install Emoji font for Windows 7 automatically
if exist "%TARGET_DIR%\public\fonts\seguiemj.ttf" (
    copy /y "%TARGET_DIR%\public\fonts\seguiemj.ttf" "%windir%\Fonts\seguiemj.ttf" >nul 2>&1
    reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts" /v "Segoe UI Emoji (TrueType)" /t REG_SZ /d "seguiemj.ttf" /f >nul 2>&1
)

:: Create Desktop Shortcut
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ws = New-Object -ComObject WScript.Shell; " ^
    "$desk = [Environment]::GetFolderPath('Desktop'); " ^
    "$sc = $ws.CreateShortcut($desk + '\HISAB PRO.lnk'); " ^
    "$sc.TargetPath = '%TARGET_DIR%\Start-Hisab-Pro-Silent.vbs'; " ^
    "$sc.WorkingDirectory = '%TARGET_DIR%'; " ^
    "$sc.IconLocation = '%TARGET_DIR%\public\favicon.ico'; " ^
    "$sc.Description = 'HISAB PRO Accounting Software'; " ^
    "$sc.Save();"

echo.
echo [4/4] Installation completed successfully!
echo       Desktop shortcut has been created.
echo.

:LAUNCH
echo Starting HISAB PRO server on http://localhost:3000 ...
cd /d "%TARGET_DIR%"
start "" "%TARGET_DIR%\Start-Hisab-Pro-Silent.vbs"
timeout /t 2 /nobreak >nul
exit
