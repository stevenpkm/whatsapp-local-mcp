@echo off
setlocal
title Restart WhatsApp Bridge

set "MCP_DIR=%~dp0..\"
set "PIDFILE=%MCP_DIR%data\bridge.pid"

cls
echo ============================================
echo   Restart WhatsApp Bridge
echo ============================================
echo.

REM Stop old bridge if running
if exist "%PIDFILE%" (
    set /p OLDPID=<"%PIDFILE%"
    setlocal enabledelayedexpansion
    echo Stopping old bridge ^(pid !OLDPID!^)...
    tasklist /FI "PID eq !OLDPID!" | findstr /I "node.exe" >nul
    if not errorlevel 1 (
        taskkill /PID !OLDPID! /F >nul 2>&1
        echo OK old bridge stopped.
    ) else (
        echo No live process at that pid - stale PID file.
    )
    endlocal
    del /q "%PIDFILE%" >nul 2>&1
) else (
    echo No PID file - no old bridge to stop.
)
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js is not on PATH.
    pause
    exit /b 1
)

echo Starting fresh bridge in background...
pushd "%MCP_DIR%" >nul
start "" /B /MIN cmd /c "node src\bridge.js >> data\bridge.log 2>>&1"
popd >nul

echo Waiting for bridge to be ready ^(up to ~15s^)...
set "READY=0"
for /L %%i in (1,1,15) do (
    timeout /t 1 /nobreak >nul
    curl -s -m 1 http://127.0.0.1:8765/healthz >nul 2>&1
    if not errorlevel 1 (
        echo Bridge is up after %%is.
        set "READY=1"
        goto :done
    )
)
:done
if "%READY%"=="0" (
    echo WARNING: bridge did not respond in 15s. Check data\bridge.log for errors.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   DONE. Bridge is running.
echo   Logs: %MCP_DIR%data\bridge.log
echo ============================================
echo.
pause
