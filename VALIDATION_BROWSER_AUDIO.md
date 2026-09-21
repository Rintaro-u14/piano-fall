# Browser audio migration validation

- Python syntax: `python -m py_compile app.py pianofall/*.py`
- JavaScript syntax: `node --check static/audio-engine.js` and `node --check static/app.js`
- API version bumped to 8 to prevent old local server/front-end mixing.
- Realtime UI no longer calls `/api/stem`; one SF2 fetch initializes the browser synth.
- `audioEvents` exposes parsed MIDI channel events required by the browser scheduler.
- SoundFont bytes are available through `/api/files/soundfont/<id>.sf2`.
- Existing server-side TinySoundFont export path remains unchanged.

Full pytest could not run in the artifact environment because Flask and TinySoundFont
are not installed there. The normal Windows `.venv` created by `setup.bat` contains
those dependencies.


## v12 AudioWorklet bootstrap fix
- `spessasynth_processor.min.js` is loaded as a real same-origin module from `/static/vendor/`.
- `setup.bat` and `start.bat` download the exact processor for spessasynth_lib 4.3.14 when missing.
- Blob-wrapping the processor was removed because it can register inconsistently with the library/worklet bootstrap.
- The synthesizer is created only after `audioWorklet.addModule()` resolves, and readiness is awaited after the SoundFont is added.
