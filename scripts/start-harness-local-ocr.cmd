@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-harness-local-ocr.ps1" %*
exit /b %ERRORLEVEL%
