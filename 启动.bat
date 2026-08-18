@echo off
rem 双击这个文件就能把她叫出来。
rem start 后面那个空引号是窗口标题占位，不能省 —— 省了 start 会把
rem 后面的路径当成标题，程序根本起不来。
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
exit
