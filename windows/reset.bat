@echo off
setlocal
title Reset WhatsApp MCP

set "MCP_DIR=%~dp0..\"

cls
echo ============================================
echo   Reset WhatsApp MCP ^(nuclear option^)
echo ============================================
echo.
echo This will:
echo   1. Stop the running bridge process
echo   2. Delete saved WhatsApp credentials ^(auth\^)
echo   3. Delete the local message cache ^(data\^)
echo.
echo Use only if the normal "re-link" in chat is not working.
echo.
echo BEFORE continuing:
echo   - QUIT Claude Desktop / Cowork
echo   - On your phone: WhatsApp -^> Settings -^> Linked Devices
echo     -^> tap the Mac OS / Cowork entry -^> Log out
echo.
set /p CONFIRM="Type YES to continue: "
if /i not "%CONFIRM%"=="YES" (
    echo Aborted. Nothing was changed.
    pause
    exit /b 0
)

echo.

if exist "%MCP_DIR%data\bridge.pid" (
    for /f %%P in (%MCP_DIR%data\bridge.pid) do (
        echo Stopping bridge process pid=%%P ...
        taskkill /PID %%P /F >nul 2>&1
    )
    del /q "%MCP_DIR%data\bridge.pid" >nul 2>&1
)

if exist "%MCP_DIR%auth" (
    rmdir /s /q "%MCP_DIR%auth"
    echo Deleted: auth\
)

if exist "%MCP_DIR%data\store.json"        del /q "%MCP_DIR%data\store.json"        >nul 2>&1
if exist "%MCP_DIR%data\store.json.backup" del /q "%MCP_DIR%data\store.json.backup" >nul 2>&1
if exist "%MCP_DIR%data\store.json.tmp"    del /q "%MCP_DIR%data\store.json.tmp"    >nul 2>&1
if exist "%MCP_DIR%data\brief.json"        del /q "%MCP_DIR%data\brief.json"        >nul 2>&1
echo Deleted: data\ files

echo.
echo ============================================
echo   Reset complete.
echo.
echo   Next: open Claude Desktop / Cowork.
echo   Then ask Claude: "scan my WhatsApp"
echo ============================================
echo.
pause
