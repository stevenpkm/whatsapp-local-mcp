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
    echo ERROR: Node.js is not on PATH.
    echo Install LTS from https://nodejs.org/ then run this again.
    pause
    popd
    exit /b 1
)

REM 1) npm install
if not exist "node_modules" (
    echo [1/2] Installing npm dependencies ^(1-2 minutes^)...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo ERROR: npm install failed.
        pause
        popd
        exit /b 1
    )
) else (
    echo [1/2] Dependencies already installed.
)
echo.

REM 2) Wire into Claude Desktop / Cowork
echo [2/2] Writing the MCP config so Claude Desktop / Cowork auto-starts the server...
call node scripts\install-mcp-config.mjs
if errorlevel 1 (
    echo ERROR: failed to write the MCP config.
    pause
    popd
    exit /b 1
)
echo.

echo ===========================================
echo   ALL DONE.
echo.
echo   Next:
echo     1. ^(Optional^) drop your OpenAI API key in
echo        %MCP_DIR%api-key.txt
echo        ^(only needed for voice transcription^)
echo     2. Open Claude Desktop / Cowork.
echo     3. In chat, ask Claude: "scan my WhatsApp"
echo        - Claude will render a QR code in chat to scan.
echo     4. The bridge stays alive 24/7 after that,
echo        even when you close the chat app.
echo ===========================================
echo.
pause
popd
