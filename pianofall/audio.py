"""Deterministic offline SF2 synthesis; no audio device or FluidSynth install."""
from pathlib import Path
import wave
import numpy as np
from tinysoundfont import _tinysoundfont as tsf

RATE = 44100
TAIL = 2.0


class Cancelled(Exception):
    pass


def check_cancel(cancel):
    if cancel and cancel.is_set():
        raise Cancelled('キャンセルしました。')


def open_font(path):
    # Bytes also support Windows paths containing Japanese characters.
    sf = tsf.SoundFont(Path(path).read_bytes())
    sf.set_output(tsf.OutputMode.StereoInterleaved, RATE, -12.0)
    sf.set_max_voices(512)
    for ch in range(16):
        sf.channel_set_preset_number(ch, 0, ch == 9)
    return sf


def synthesize(song, font_path, target, hidden=(), progress=lambda x: None, cancel=None, programs=None, volumes=None, master_volume=1.0, include_parts=None):
    sf = open_font(font_path)
    hidden = set(hidden)
    programs, volumes = programs or {}, volumes or {}
    # Virtual synth channels isolate each track/channel, including shared-channel files.
    # include_parts is used by the browser realtime mixer to render one isolated stem
    # without changing the existing full-mix/video export path.
    include_parts = set(include_parts or ())
    parts = sorted({(n['track'], n['channel']) for n in song.notes
                    if n['track'] not in hidden and
                    (not include_parts or f"{n['track']}:{n['channel']}" in include_parts)})
    if include_parts and not parts:
        raise ValueError('指定されたMIDIパートに発音ノートがありません。')
    routes = {part: index for index, part in enumerate(parts)}
    by_channel = {ch: [(f'{tr}:{ch}', dest) for (tr, original), dest in routes.items() if original == ch] for ch in range(16)}
    for (tr, ch), dest in routes.items():
        override = programs.get(f'{tr}:{ch}')
        if override is not None and sf.get_preset_index(128 if ch == 9 else 0, override) < 0:
            raise ValueError(f'Track {tr+1} / CH {ch+1} の指定音色はこのSoundFontにありません。音色または音源を選び直してください。')
        sf.channel_set_preset_number(dest, programs.get(f'{tr}:{ch}', 0), ch == 9)
        sf.channel_set_volume(dest, volumes.get(f'{tr}:{ch}', 1))
    # Read back unscaled MIDI volume after controller updates; don't compound user gain.
    midi_volumes = {dest: 1.0 for dest in routes.values()}
    # Keep channel controllers even on a muted track: their state is channel-global in MIDI.
    events = [e for e in song.events if e['type'] not in ('note_on', 'note_off') or e['track'] not in hidden]
    total = round((song.duration + TAIL) * RATE)
    position = 0
    with wave.open(str(target), 'wb') as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(RATE)
        def render_until(end):
            nonlocal position
            while position < end:
                check_cancel(cancel)
                length = min(8192, end - position)
                buffer = np.zeros((length, 2), dtype=np.float32)
                sf.render(buffer)
                # Apply a master gain after synthesis. TinySoundFont already renders with
                # headroom (-12 dB), and the final clip prevents integer overflow.
                scaled = np.clip(buffer * float(master_volume), -1, 1)
                out.writeframesraw((scaled * 32767).astype('<i2').tobytes())
                position += length
                progress(position / total)
        for event in events:
            render_until(min(total, round(event['time'] * RATE)))
            ch, kind = event['channel'], event['type']
            if kind in ('note_on', 'note_off'):
                dest = routes.get((event['track'], ch))
                if dest is None:
                    continue
                if kind == 'note_on' and event['velocity']:
                    sf.channel_note_on(dest, event['note'], event['velocity'] / 127)
                else:
                    sf.channel_note_off(dest, event['note'])
                continue
            # MIDI controllers and original program changes are channel-global.
            for part, dest in by_channel[ch]:
                if kind == 'program_change' and part not in programs:
                    sf.channel_set_preset_number(dest, event['program'], ch == 9)
                elif kind == 'control_change':
                    sf.channel_set_volume(dest, midi_volumes[dest])
                    sf.channel_midi_control(dest, event['control'], event['value'])
                    midi_volumes[dest] = sf.channel_get_volume(dest)
                    sf.channel_set_volume(dest, midi_volumes[dest] * volumes.get(part, 1))
                elif kind == 'pitchwheel':
                    sf.channel_set_pitch_wheel(dest, event['pitch'] + 8192)
        render_until(round(song.duration * RATE))
        for dest in routes.values():
            sf.channel_midi_control(dest, 64, 0)
            sf.channel_midi_control(dest, 123, 0)
        render_until(total)
    return Path(target)
