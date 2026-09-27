@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo ==========================================================
echo   Canvas Horizon - デスクトップアプリを起動中...
echo ==========================================================

REM node_modules内のelectronバイナリを直接呼び出し
if exist "node_modules\.bin\electron.cmd" (
    call "node_modules\.bin\electron.cmd" .
) else (
    REM 万一ローカルに見当たらない場合はnpx経由
    call npx.cmd electron .
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo ==========================================================
    echo [ERROR] 起動中にエラーが発生しました (終了コード: %ERRORLEVEL%)
    echo ==========================================================
    pause
)
