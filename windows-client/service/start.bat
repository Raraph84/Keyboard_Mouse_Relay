@echo off
cd /d %~dp0
remote-keyboard-client-service.exe start
schtasks /run /tn "Remote-Keyboard-Client"
