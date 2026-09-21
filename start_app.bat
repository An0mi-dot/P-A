@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

set HTTP_PROXY=
set HTTPS_PROXY=
set http_proxy=
set https_proxy=

echo Abrindo...
echo.

"%CD%\node_bin\node.exe" "%CD%\node_modules\electron\cli.js" .

if errorlevel 1 (
    echo.
    echo ERRO: Falha ao iniciar o app
    pause
    exit /b 1
)
