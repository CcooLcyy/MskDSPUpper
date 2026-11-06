@echo off
if not defined UPPER_CARGO_PYTHON exit /b 1
"%UPPER_CARGO_PYTHON%" -B "%~dp0cargo_cache.py" wrapper %*
exit /b %errorlevel%
