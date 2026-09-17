@echo off
rem Двойной клик открывает Terminal launcher Pixso -> Figma на Windows.
rem
rem Здесь нет никакой migration logic: скрипт находит Node и запускает
rem тот же Launcher/Terminal.js, что и macOS-обёртка.

setlocal
set "PROJECT_DIR=%~dp0"
set "LAUNCHER=%PROJECT_DIR%Launcher\Terminal.js"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден.
  echo Установите его с https://nodejs.org и запустите файл снова.
  echo.
  pause
  exit /b 1
)

if not exist "%LAUNCHER%" (
  echo Не найден "%LAUNCHER%".
  echo Запускайте файл из папки проекта Pixso2Figma.
  echo.
  pause
  exit /b 1
)

rem Direct PIX распаковывает .pix через zlib.zstdDecompressSync: он есть
rem только в Node 22.15+ и 24+.
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
set /a NODE_MAJOR_N=%NODE_MAJOR% 2>nul
set /a NODE_MINOR_N=%NODE_MINOR% 2>nul
if %NODE_MAJOR_N% LSS 22 goto oldnode
if %NODE_MAJOR_N% EQU 22 if %NODE_MINOR_N% LSS 15 goto oldnode
if %NODE_MAJOR_N% EQU 23 goto oldnode
goto runnode

:oldnode
echo Нужен Node.js 22.15+ или 24+, установлен %NODE_MAJOR_N%.%NODE_MINOR_N%.
echo Обновите Node.js с https://nodejs.org и запустите файл снова.
echo.
pause
exit /b 1

:runnode
node "%LAUNCHER%" %*
set "STATUS=%ERRORLEVEL%"

rem 0 — обычный выход. 3 — старое окно закрыть не удалось: launcher всё
rem объяснил сам, добавлять «завершился с кодом» незачем. Остальное — ошибка:
rem окно не закрываем, пока пользователь не увидит сообщение.
if "%STATUS%"=="3" (
  pause
) else if not "%STATUS%"=="0" (
  echo.
  echo Launcher завершился с кодом %STATUS%.
  pause
)

exit /b %STATUS%
