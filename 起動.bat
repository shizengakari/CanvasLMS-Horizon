@echo off
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   Canvas Horizon - Starting Application...
echo ==========================================================

if exist "node_modules\.bin\electron.cmd" (
    call "node_modules\.bin\electron.cmd" . --disable-http-cache
) else (
    call npx electron . --disable-http-cache
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo ==========================================================
    echo [ERROR] Launch failed with code %ERRORLEVEL%
    echo ==========================================================
    pause
)
