@echo off
setlocal

rem Keep cmd.exe intentionally thin. Runtime selection and Terminal.js launch
rem live in one PowerShell process so Unicode paths never cross a for /f pipe.
set "STARTER=%~dp0Launcher\StartWindows.ps1"

echo Pixso2Figma: starting...
if not exist "%STARTER%" (
  echo.
  echo Missing "%STARTER%".
  echo Restore the complete Pixso2Figma folder.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%STARTER%" %*
set "STATUS=%ERRORLEVEL%"

rem Any early PowerShell/bootstrap/launcher failure remains visible. Code 3 is
rem also intentionally held open: Terminal.js uses it for a failed takeover.
if not "%STATUS%"=="0" (
  echo.
  echo Pixso2Figma exited with code %STATUS%.
  echo Press any key to close this window.
  pause >nul
)

exit /b %STATUS%
