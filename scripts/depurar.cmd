@echo off
rem Abre o programa com o registro de erros ligado e grava tudo em scripts\depurar.log.
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1
"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0.." > "%~dp0depurar.log" 2>&1
echo codigo de saida: %ERRORLEVEL% >> "%~dp0depurar.log"
