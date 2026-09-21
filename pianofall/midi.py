"""Standard MIDI 0/1 -> one global, tempo-aware seconds timeline."""
from bisect import bisect_right
from collections import defaultdict, deque
from dataclasses import dataclass
import io
import mido


@dataclass
class Song:
    name: str
    notes: list
    events: list
    tracks: list
    tempos: list
    signatures: list
    beats: list
    duration: float
    ppqn: int
    warnings: list

    def public(self):
        return {k: v for k, v in vars(self).items() if k != 'events'}


def parse_midi(data: bytes, name='Untitled.mid') -> Song:
    if len(data) > 20 * 1024 * 1024:
        raise ValueError('MIDIは20MB以下にしてください。')
    mid = mido.MidiFile(file=io.BytesIO(data), charset='latin1')
    if mid.type == 2:
        raise ValueError('非同期のType 2 MIDIは未対応です。Type 0/1で保存してください。')
    if mid.ticks_per_beat <= 0:
        raise ValueError('SMPTE time divisionは未対応です。PPQNで保存してください。')
    raw, tracks = [], []
    for ti, tr in enumerate(mid.tracks):
        tick, channels, programs = 0, set(), set()
        for ei, msg in enumerate(tr):
            tick += msg.time
            raw.append((tick, ti, ei, msg))
            if hasattr(msg, 'channel'):
                channels.add(msg.channel)
            if msg.type == 'program_change':
                programs.add(msg.program)
        tracks.append(dict(id=ti, name=tr.name or f'Track {ti + 1}', channels=sorted(channels), programs=sorted(programs), count=0))
    if len(raw) > 500_000:
        raise ValueError('MIDIイベント数が上限（50万）を超えています。')
    raw.sort(key=lambda e: e[:3])
    tempo, previous, seconds = 500000, 0, 0.0
    tempos = [dict(tick=0, time=0, tempo=tempo, bpm=120)]
    signatures = [dict(tick=0, time=0, numerator=4, denominator=4)]
    notes, events, warnings = [], [], []
    active = defaultdict(deque)
    orphan = 0
    for tick, ti, ei, msg in raw:
        seconds += (tick - previous) * tempo / mid.ticks_per_beat / 1_000_000
        previous = tick
        if seconds > 3600:
            raise ValueError('MVPでは1時間以下のMIDIに対応しています。')
        if msg.type == 'set_tempo':
            if msg.tempo <= 0:
                raise ValueError('MIDIに不正なtempo=0があります。')
            tempo = msg.tempo
            item = dict(tick=tick, time=seconds, tempo=tempo, bpm=60_000_000 / tempo)
            if tempos[-1]['tick'] == tick:
                tempos[-1] = item
            else:
                tempos.append(item)
        elif msg.type == 'time_signature':
            item = dict(tick=tick, time=seconds, numerator=msg.numerator, denominator=msg.denominator)
            if signatures[-1]['tick'] == tick:
                signatures[-1] = item
            else:
                signatures.append(item)
        if not msg.is_meta and hasattr(msg, 'channel'):
            event = msg.dict()
            event.update(time=seconds, track=ti, tick=tick)
            events.append(event)
        if msg.type in ('note_on', 'note_off'):
            key = (ti, msg.channel, msg.note)
            if msg.type == 'note_on' and msg.velocity > 0:
                note = dict(start=seconds, end=seconds, startTick=tick, endTick=tick, pitch=msg.note, velocity=msg.velocity, track=ti, channel=msg.channel)
                active[key].append(note)
                notes.append(note)
                tracks[ti]['count'] += 1
            elif active[key]:
                ended = active[key].popleft()
                ended.update(end=seconds, endTick=tick)
            else:
                orphan += 1
        # Channel mode messages terminate held visual keys as well.
        if msg.type == 'control_change' and msg.control in (120, 123):
            for key, queue in active.items():
                if key[1] == msg.channel:
                    while queue:
                        ended = queue.popleft()
                        ended.update(end=seconds, endTick=tick)
    dangling = 0
    for queue in active.values():
        while queue:
            note = queue.popleft()
            note['end'] = max(seconds, note['start'] + .1)
            note['endTick'] = max(previous, note['startTick'] + mid.ticks_per_beat / 4)
            # Ensure incomplete MIDI cannot leave the synth sounding through the tail.
            events.append(dict(type='note_off', channel=note['channel'], note=note['pitch'], velocity=0,
                               time=note['end'], track=note['track'], tick=previous))
            dangling += 1
    if dangling:
        warnings.append(f'Note Offがない{dangling}音を曲末で終了しました。')
    if orphan:
        warnings.append(f'対応するNote OnがないNote Offを{orphan}件検出しました。')
    if any(e[3].type == 'sysex' for e in raw):
        warnings.append('SysExは音声合成に反映されません（GM音源を使用）。')
    if not notes:
        raise ValueError('発音するノートがありません。')
    duration = max(seconds, max(n['end'] for n in notes))
    tempo_ticks = [t['tick'] for t in tempos]

    def to_seconds(tick):
        t = tempos[bisect_right(tempo_ticks, tick) - 1]
        return t['time'] + (tick - t['tick']) * t['tempo'] / mid.ticks_per_beat / 1_000_000

    beats = []
    for si, sig in enumerate(signatures):
        stop = signatures[si + 1]['tick'] if si + 1 < len(signatures) else previous + 1
        step = mid.ticks_per_beat * 4 / sig['denominator']
        tick, index = sig['tick'], 0
        while tick < stop and len(beats) < 100_000:
            beats.append(dict(time=to_seconds(tick), strong=index % max(1, sig['numerator']) == 0))
            tick += step
            index += 1
    notes.sort(key=lambda n: n['start'])
    events.sort(key=lambda e: e['time'])
    return Song(name, notes, events, tracks, tempos, signatures, beats, duration, mid.ticks_per_beat, warnings)
