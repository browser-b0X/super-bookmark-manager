@echo off
setlocal
set "PYTHONIOENCODING=utf-8"
if defined SAVED_POSTS_PYTHON goto explicit
py -3.12 -c "import sys; sys.exit(sys.version_info[:2] != (3,12))" >nul 2>&1
if not errorlevel 1 goto pylauncher
set "SAVED_POSTS_PYTHON=%LOCALAPPDATA%\Python\pythoncore-3.12-64\python.exe"
if exist "%SAVED_POSTS_PYTHON%" goto explicit
set "SAVED_POSTS_PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if exist "%SAVED_POSTS_PYTHON%" goto explicit
set "SAVED_POSTS_PYTHON=python"
:explicit
"%SAVED_POSTS_PYTHON%" -c "import sys; sys.exit(sys.version_info[:2] != (3,12))" >nul 2>&1
if errorlevel 1 goto missing
"%SAVED_POSTS_PYTHON%" "%~dp0package_start.py" %*
goto result
:pylauncher
py -3.12 "%~dp0package_start.py" %*
goto result
:missing
echo Python 3.12 could not be started. Install Python 3.12 for this user,
echo or set SAVED_POSTS_PYTHON to its python.exe. No admin or PATH change is required.
set "result=1"
goto finish
:result
set "result=%errorlevel%"
:finish
if "%result%"=="0" exit /b 0
echo.
echo Startup did not complete. See the message above and BUILD_AND_RUN.md.
if not defined SAVED_POSTS_NO_PAUSE pause
exit /b %result%
