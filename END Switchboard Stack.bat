@echo off
title END Switchboard Stack
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Stack.ps1" -Action Stop
if errorlevel 1 (
  pause
  exit /b 1
)
