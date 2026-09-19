@echo off
title START Switchboard Stack
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Stack.ps1" -Action Start
if errorlevel 1 (
  pause
  exit /b 1
)
