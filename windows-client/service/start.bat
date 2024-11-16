@echo off
cd /d %~dp0
cmd /c stop.bat
remote-keyboard-client-service.exe start
schtasks /run /tn "Remote-Keyboard-Client"
