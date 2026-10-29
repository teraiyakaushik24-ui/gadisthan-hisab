@echo off
title HISAB PRO - Stop Service
echo Stopping all HISAB PRO background processes...
taskkill /f /im node.exe >nul 2>&1
echo Done! All background servers stopped.
timeout /t 2 >nul

