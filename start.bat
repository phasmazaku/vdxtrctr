@echo off
REM One-click launcher. Double-click this file, or run: start.bat [--tools] [--dev] [--no-open]
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org ^(version 20 or newer^).
  pause
  exit /b 1
)
node run.js %*
if errorlevel 1 pause
