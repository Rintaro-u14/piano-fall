@echo off
setlocal
cd /d "%~dp0"
for %%V in (3.12 3.11 3.10) do (
  py -%%V -c "import struct; assert struct.calcsize('P') == 8" >nul 2>&1
  if not errorlevel 1 (
    set "PIANOFALL_PY=%%V"
    goto found
  )
)
echo Python 3.10, 3.11 or 3.12 64-bit is required. Install from python.org.
pause
exit /b 1
:found
py -%PIANOFALL_PY% -m venv .venv
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install --no-deps tinysoundfont==0.3.7
if errorlevel 1 goto failed
.venv\Scripts\python.exe -c "from tinysoundfont import Synth; import imageio_ffmpeg; print('FFmpeg:', imageio_ffmpeg.get_ffmpeg_exe())"
if errorlevel 1 goto failed
set "SF2_DIR=%~dp0data\soundfonts"
set "SF2_FILE=%SF2_DIR%\GeneralUser-GS.sf2"
if not exist "%SF2_FILE%" (
  if not exist "%SF2_DIR%" mkdir "%SF2_DIR%"
  echo Downloading default GeneralUser GS SoundFont ^(~31 MB^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $dst='%SF2_FILE%'; $tmp=$dst+'.download'; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2' -OutFile $tmp; Move-Item -Force $tmp $dst } catch { if (Test-Path $tmp) { Remove-Item -Force $tmp }; exit 1 }"
  if errorlevel 1 (
    echo Default SoundFont download failed. You can still choose a .sf2 file manually in the app.
  ) else (
    echo Default SoundFont installed.
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

echo Setup complete. Double-click start.bat.
pause
exit /b 0
:failed
echo Setup failed. Check the error above and your internet connection.
pause
exit /b 1
