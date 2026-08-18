@echo off
REM ---------------------------------------------------------------------
REM  WaifuCode - one-click packager.  Double-click me.
REM
REM  This file is deliberately PURE ASCII, and deliberately does NOT run
REM  `chcp 65001`.  Both on purpose:
REM
REM  cmd.exe tracks its read position inside a .bat file as a BYTE offset,
REM  but after `chcp 65001` it decodes the file as UTF-8.  Multi-byte
REM  characters shift the offsets, so cmd resumes parsing in the MIDDLE of
REM  a line and executes the tail as a command.  You get gems like
REM  `'https:' is not recognized as an internal or external command`
REM  from a line that was only ever an `echo`.  Been there.
REM
REM  So: all Chinese output lives in tools/pack.js instead.  Node on Windows
REM  writes to a console with WriteConsoleW, which is codepage-independent,
REM  so it prints correctly no matter what chcp says.
REM ---------------------------------------------------------------------

cd /d "%~dp0"

REM  Keep Electron's ~110MB download out of C:.
REM
REM  electron/install.js reads exactly `process.env.electron_config_cache`.
REM  Putting it in .npmrc does NOT work: npm exports .npmrc keys as
REM  `npm_config_<key>`, so it arrives as `npm_config_electron_config_cache`
REM  and install.js never looks at that name.  Verified, not guessed.
REM  An env var set right here is the thing that actually works.
set "electron_config_cache=%~dp0.cache\electron"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found - please install it first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo.
  echo   Installing dependencies, this happens only once...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   npm install failed - check your network and try again.
    echo.
    pause
    exit /b 1
  )
)

node "tools\pack.js"
set PACK_CODE=%errorlevel%

if "%PACK_CODE%"=="0" start "" "%~dp0dist"

echo.
pause
