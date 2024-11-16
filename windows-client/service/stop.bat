@echo off
cd /d %~dp0
remote-keyboard-client-service.exe stop
wmic process where CommandLine='node index.js remotekeyboard' delete
wmic process where CommandLine='"node" index.js remotekeyboard --logon' delete
