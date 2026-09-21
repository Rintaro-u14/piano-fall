import io
import math
from pathlib import Path
import mido
import pytest
from pianofall.midi import parse_midi
from pianofall.settings import keys, settings
from pianofall.render import Renderer


def pack(tracks, kind=1, ppqn=480):
    mid=mido.MidiFile(type=kind,ticks_per_beat=ppqn)
    mid.tracks.extend(mido.MidiTrack(t) for t in tracks)
    buf=io.BytesIO();mid.save(file=buf);return buf.getvalue()


def test_global_tempo_across_tracks_and_zero_velocity():
    data=pack([
        [mido.MetaMessage('set_tempo',tempo=500000),mido.MetaMessage('set_tempo',tempo=1000000,time=480)],
        [mido.Message('note_on',note=60,velocity=100,time=240),mido.Message('note_on',note=60,velocity=0,time=720)],
    ])
    s=parse_midi(data)
    assert s.notes[0]['start']==pytest.approx(.25)
    assert s.notes[0]['end']==pytest.approx(1.5)
    assert s.notes[0]['track']==1
    assert s.duration==pytest.approx(mido.MidiFile(file=io.BytesIO(data)).length)


def test_overlap_tracks_channels_and_dangling():
    data=pack([
        [mido.Message('note_on',channel=0,note=60,velocity=100),mido.Message('note_on',channel=0,note=60,velocity=80,time=120),mido.Message('note_off',channel=0,note=60,time=120),mido.Message('note_off',channel=0,note=60,time=240)],
        [mido.Message('note_on',channel=1,note=60,velocity=90),mido.MetaMessage('end_of_track',time=960)]
    ])
    s=parse_midi(data)
    a=[n for n in s.notes if n['channel']==0]
    assert [(n['start'],n['end']) for n in a]==[(0,.25),(.125,.5)]
    assert [n for n in s.notes if n['channel']==1][0]['end']==1
    assert s.warnings
    assert s.events[-1]['type']=='note_off'


def test_meter_does_not_change_quarter_note_tempo():
    s=parse_midi(pack([[mido.MetaMessage('time_signature',numerator=6,denominator=8),mido.Message('note_on',note=60),mido.Message('note_off',note=60,time=960)]]))
    assert s.duration==1
    assert [b['time'] for b in s.beats]==[0,.25,.5,.75,1]
    assert s.signatures[0]['numerator']==6


def test_type0_and_rejections():
    note=[mido.Message('note_on',note=60),mido.Message('note_off',note=60,time=480)]
    assert parse_midi(pack([note],kind=0)).duration==.5
    with pytest.raises(ValueError,match='Type 2'):parse_midi(pack([note],kind=2))
    with pytest.raises(ValueError,match='SMPTE'):parse_midi(pack([note],ppqn=-6360))
    with pytest.raises((ValueError,EOFError,OSError)):parse_midi(b'not a midi')
    with pytest.raises(ValueError,match='ノート'):parse_midi(pack([[]]))
    with pytest.raises(ValueError,match='tempo=0'):parse_midi(pack([[mido.MetaMessage('set_tempo',tempo=0)]+note]))


def test_keyboard_and_narrow_black_range():
    k=keys(21,108)
    assert len(k)==88
    assert sum(not x['black'] for x in k)==52
    assert min(x['x'] for x in k)==0
    assert max(x['x']+x['width'] for x in k)==pytest.approx(1920)
    for low,high in [(61,63),(0,127),(22,108)]:
        assert all(-1e-6<=x['x']<=1920 and x['width']>0 for x in keys(low,high))


@pytest.mark.parametrize('bad',[{'speed':float('nan')},{'minPitch':80,'maxPitch':60},{'background':'red'},{'fps':45},{'speed':0},{'colorMode':'bad'}])
def test_bad_settings(bad):
    with pytest.raises(ValueError):settings(bad)


def test_note_impact_pixel_and_hidden_track():
    s=parse_midi(pack([[mido.Message('note_on',note=60,velocity=100,time=480),mido.Message('note_off',note=60,time=480)]]))
    cfg=settings({'minPitch':59,'maxPitch':62,'colors':{'track:0':'#ff0000'}})
    r=Renderer(s,cfg)
    k=r.by_pitch[60];x=round(k['x']+k['width']/2)
    # Below the black keys: white C4 should be red exactly at note-on.
    y=1040
    assert r.frame(.49).getpixel((x,y))!=(255,0,0)
    assert r.frame(.5).getpixel((x,y))==(255,0,0)
    assert r.frame(1).getpixel((x,y))!=(255,0,0)
    hidden=Renderer(s,settings({**cfg,'hiddenTracks':[0]}))
    assert hidden.frame(.5).getpixel((x,y))!=(255,0,0)


def test_sample_matches_mido_length():
    path=Path(__file__).parents[1]/'samples'/'Aurora_Study.mid'
    s=parse_midi(path.read_bytes())
    assert s.duration==pytest.approx(mido.MidiFile(path).length)
    assert len(s.notes)==73
    assert len(s.tempos)==3
    assert len(s.signatures)==3
