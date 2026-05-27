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
    echo [1/3] Installing dependencies. This takes 2-3 minutes - please wait.
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
    echo [1/3] Dependencies already installed - skipping.
)
echo.

REM 2) Wire into Claude Desktop / Cowork
echo [2/3] Patching Cowork / Claude Desktop config so it loads the MCP...
call node scripts\install-mcp-config.mjs
if errorlevel 1 (
    echo.
    echo ERROR: failed to write the MCP config.
    pause
    popd
    exit /b 1
)
echo.

REM 3) Create Desktop shortcut to the live QR page
echo [3/3] Creating "Open WhatsApp QR" shortcut on your Desktop...
> "%USERPROFILE%\Desktop\Open WhatsApp QR.url" (
  echo [InternetShortcut]
  echo URL=http://127.0.0.1:8765/qr
  echo IconIndex=0
)
echo.

echo ===========================================
echo   SUCCESS - WhatsApp MCP is installed
echo ===========================================
echo.
echo Next steps:
echo.
echo   1. Close this window.
echo   2. Right-click the Cowork icon in your taskbar (near the clock)
echo      and choose "Quit" (NOT just close the window).
echo   3. Open Cowork again from your Start Menu.
echo   4. In the chat, type:  scan my WhatsApp
echo   5. On your Desktop, double-click "Open WhatsApp QR".
echo      A big QR will open in your browser. Scan from your phone:
echo      WhatsApp - Settings - Linked Devices - Link a Device
echo      (The QR auto-refreshes if it expires; the page shows
echo       "Connected" when scanning succeeds.)
echo.
echo (Optional) For voice-note transcription, drop your OpenAI API
echo key into:  %MCP_DIR%api-key.txt
echo.
pause
popd
