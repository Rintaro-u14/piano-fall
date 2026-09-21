"""Original sample. No borrowed melodies or assets. Type 1, tempo & meter changes."""
from pathlib import Path
import mido


def make_sample(path):
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    def track(name, events):
        tr = mido.MidiTrack([mido.MetaMessage('track_name', name=name)])
        previous = 0
        for tick, msg in sorted(events, key=lambda e: e[0]):
            tr.append(msg.copy(time=tick - previous))
            previous = tick
        tr.append(mido.MetaMessage('end_of_track', time=max(0, 7680-previous)))
        mid.tracks.append(tr)
    track('Conductor', [(0, mido.MetaMessage('set_tempo', tempo=500000)),
                        (0, mido.MetaMessage('time_signature', numerator=4, denominator=4)),
                        (3840, mido.MetaMessage('set_tempo', tempo=666667)),
                        (3840, mido.MetaMessage('time_signature', numerator=3, denominator=4)),
                        (6720, mido.MetaMessage('set_tempo', tempo=400000)),
                        (6720, mido.MetaMessage('time_signature', numerator=2, denominator=4))])
    for ch, name, program in [(0, 'Glass melody', 0), (1, 'Warm arpeggio', 10), (2, 'Low tide', 32), (9, 'Soft pulse', 0)]:
        events = [(0, mido.Message('program_change', channel=ch, program=program))]
        def note(t, pitch, dur, velocity):
            events.append((t, mido.Message('note_on', channel=ch, note=pitch, velocity=velocity)))
            events.append((t+dur, mido.Message('note_off', channel=ch, note=pitch, velocity=0)))
        if ch == 0:
            melody = [72, 76, 79, 74, 77, 81, 79, 76, 74, 71, 72, 76, 79, 83, 81, 72]
            for i, p in enumerate(melody):
                note(i*480, p, 420, 82 + i%3*6)
            # A held note crossing a tempo boundary, plus pedal controls.
            note(3600, 67, 960, 52)
            events.extend([(3360, mido.Message('control_change', channel=ch, control=64, value=127)),
                           (4800, mido.Message('control_change', channel=ch, control=64, value=0))])
        elif ch == 1:
            for i in range(32):
                note(i*240, [48,55,60,64,50,57,62,65][i%8], 210, 56)
        elif ch == 2:
            for i, p in enumerate([36,38,33,31,36,38,43,36]):
                note(i*960, p, 880, 75)
        else:
            for i in range(16):
                note(i*480, 36 if i%2==0 else 38, 100, 46)
        track(name, events)
    mid.save(path)


if __name__ == '__main__':
    make_sample(Path(__file__).with_name('Aurora_Study.mid'))
