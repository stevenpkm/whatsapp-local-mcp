@echo off
setlocal
title WhatsApp MCP - Install

REM Project root is one level up from this .bat (located in windows/).
set "MCP_DIR=%~dp0..\"
pushd "%MCP_DIR%" >nul

cls
echo ===========================================
echo   WhatsApp MCP - Install
echo ===========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo ===========================================
    echo   Node.js is NOT installed on this computer
    echo ===========================================
    echo.
    echo WhatsApp MCP needs Node.js to run. It's free,
    echo takes 2 minutes, and you only do it once.
    echo.
    echo Steps:
    echo   1. Press any key - your browser will open to nodejs.org
    echo   2. Click the big GREEN "LTS" button to download
    echo   3. Run the installer: just click Next, Next, Install
    echo   4. When that finishes, come back and double-click install.bat again
    echo.
    pause >nul
    start "" https://nodejs.org/
    echo.
    echo After Node.js is installed, double-click install.bat again.
    echo.
    pause
    popd
    exit /b 1
)

REM 1) npm install
if not exist "node_modules" (
    echo [1/2] Installing dependencies. This takes 2-3 minutes - please wait.
    echo       npm shows no progress bar, but it IS working. Don't close this.
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed. See messages above.
        pause
        popd
        exit /b 1
    )
) else (
    echo [1/2] Dependencies already installed - skipping.
)
echo.

REM 2) Wire into Claude Desktop / Cowork
echo [2