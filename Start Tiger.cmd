@echo off
rem Starts Tiger's local server (if it isn't running yet) and opens Tiger in your browser.
setlocal
set PORT=47123
set PING=try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://localhost:%PORT%/__ping ^| Out-Null; exit 0 } catch { exit 1 }

powershell -NoProfile -Command "%PING%"
if errorlevel 1 (
  start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0server.ps1" -Port %PORT%
  for /l %%i in (1,1,20) do (
    powershell -NoProfile -Command "Start-Sleep -Milliseconds 250; %PING%" && goto open
  )
  echo Tiger could not start its local server on port %PORT%.
  echo Opening it straight from disk instead - video and audio tools will be unavailable.
  start "" "%~dp0index.html"
  pause
  exit /b 1
)
:open
start "" http://localhost:%PORT%/
