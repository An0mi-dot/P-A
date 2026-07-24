@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo Abrindo EXTRATJUD...
echo.

"%CD%\node_bin\node.exe" "%CD%\node_modules\electron\cli.js" .

if errorlevel 1 (
    echo.
    echo ERRO: Falha ao iniciar o app
    pause
    exit /b 1
)
