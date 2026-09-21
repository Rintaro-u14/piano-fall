@echo off
setlocal
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Run setup.bat first.
  pause
  exit /b 1
)

set "SF2_DIR=%~dp0data\soundfonts"
set "SF2_FILE=%SF2_DIR%\GeneralUser-GS.sf2"
if not exist "%SF2_FILE%" (
  if not exist "%SF2_DIR%" mkdir "%SF2_DIR%"
  echo Default SoundFont is missing. Downloading GeneralUser GS ^(~31 MB^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dst='%SF2_FILE%'; $tmp=$dst+'.download'; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2' -OutFile $tmp; Move-Item -Force $tmp $dst; Write-Host 'SoundFont download complete.' } catch { if (Test-Path $tmp) { Remove-Item -Force $tmp }; Write-Warning ('SoundFont download failed: ' + $_.Exception.Message); exit 1 }"
  if errorlevel 1 (
    echo Continuing without audio. You can choose a .sf2 file from the app later.
  )
)

set "SPESSA_DIR=%~dp0static\vendor"
set "SPESSA_FILE=%SPESSA_DIR%\spessasynth_processor.min.js"
if not exist "%SPESSA_FILE%" (
  if not exist "%SPESSA_DIR%" mkdir "%SPESSA_DIR%"
  echo Browser synth processor is missing. Downloading SpessaSynth 4.3.14 worklet...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dst='%SPESSA_FILE%'; $tmp=$dst+'.download'; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://cdn.jsdelivr.net/npm/spessasynth_lib@4.3.14/dist/spessasynth_processor.min.js' -OutFile $tmp; if ((Get-Item $tmp).Length -lt 100000) { throw 'Downloaded worklet file is unexpectedly small.' }; Move-Item -Force $tmp $dst; Write-Host 'SpessaSynth worklet download complete.' } catch { if (Test-Path $tmp) { Remove-Item -Force $tmp }; Write-Warning ('SpessaSynth worklet download failed: ' + $_.Exception.Message); exit 1 }"
  if errorlevel 1 (
    echo Browser audio will not work until static\vendor\spessasynth_processor.min.js is installed.
  )
)

.venv\Scripts\python.exe app.py
pause
