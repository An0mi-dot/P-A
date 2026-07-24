@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

set HTTP_PROXY=http://B624140:JkhJkhGIT19!@proxyzsneoclb.neoenergia.net:80
set HTTPS_PROXY=http://B624140:JkhJkhGIT19!@proxyzsneoclb.neoenergia.net:80

echo Abrindo EXTRATJUD...
echo.

"%CD%\node_bin\node.exe" "%CD%\node_modules\electron\cli.js" .

if errorlevel 1 (
    echo.
    echo ERRO: Falha ao iniciar o app
    pause
    exit /b 1
)
