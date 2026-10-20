@echo off
title HISAB PRO - Daily Accounting Software
color 0A
echo ================================================================
echo           HISAB 
echo ================================================================
echo.
echo Server shuru ho raha hai...
echo Krupya aa window bandh na karvi (Keep this window open).
echo.

cd /d "%~dp0"

:: Open browser automatically
start "" "http://localhost:3000"

:: Start server
node server.js
if %errorlevel% neq 0 (
    echo.
    echo Server bandh thayu che athva error aavi che.
    pause
)
