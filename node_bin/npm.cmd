@echo off
set "NODE_BIN=%~dp0"
if exist "%NODE_BIN%node_modules\npm\bin\npm-cli.js" (
    "%NODE_BIN%node.exe" "%NODE_BIN%node_modules\npm\bin\npm-cli.js" %*
) else (
    echo npm nao instalado em node_bin. Use npm install -g npm ou execute start_app.bat diretamente.
    exit /b 1
)
