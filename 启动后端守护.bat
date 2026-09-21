@echo off
chcp 65001 >nul
title Campus Errand Backend Keep-Alive
cd /d "%~dp0"
echo ============================================================
echo  Campus Errand backend keep-alive (auto restart + cpolar URL)
echo  Close this window or press Ctrl+C to stop.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto-restart-backend.ps1" %*
echo.
echo [Stop] keep-alive exited.
pause