import io
import wave
from pathlib import Path
import mido
import numpy as np
import pytest
from pianofall.midi import parse_midi
from pianofall.music import MusicAnalysis, Timeline, estimate, parts
from pianofall.settings import settings
from pianofall.render import Renderer
from app import create_app
from test_core import pack
from test_integration import FONT
from pianofall.audio import synthesize


def test_tick_score_tempo_meter_and_page_api(tmp_path):
    app=create_app(tmp_path);client=app.test_client()
    try:
        sample=client.post('/api/sample').json;sid=sample['id']
        song=app.extensions['pianofall']['songs'][sid]
        timeline=Timeline(song)
        for note in song.notes:
            assert timeline.seconds(note['startTick'])==pytest.approx(note['start'])
            assert timeline.seconds(note['endTick'])==pytest.approx(note['end'])
        music=MusicAnalysis(song)
        assert [(b['numerator'],b['start']) for b in music.measures][:3]==[(4,0),(4,2),(3,4)]
        assert music.measure_at(4.1)==2 and music.measure_at(2.1)==1
        assert music.cursor(4.666667,2)==pytest.approx(750)
        data=client.get(f'/api/music/{sid}?part=2:1').json
        assert data['scorePart']=='2:1' and len(data['parts'])==4
        image=client.get(f'/api/score/{sid}/2.png?part=2:1')
        assert image.status_code==200 and image.data.startswith(b'\x89PNG')
        assert client.get(f'/api/music/{sid}?part=4:9').status_code==400
        assert client.get(f'/api/score/{sid}/999.png').status_code==400
        assert Renderer(song,settings({'showScore':True})).frame(1).getpixel((10,10))==(19,33,39)
        assert Renderer(song,settings({'showScore':False})).frame(1).getpixel((10,10))!=(19,33,39)
    finally:app.extensions['pianofall']['executor'].shutdown()


def test_chords_triad_inversion_seventh_and_ambiguity():
    assert estimate({0:1,4:1,7:1},48)[0]=='C'
    assert estimate({0:1,4:1,7:1},52)[0]=='C/E'
    assert estimate({0:1,3:1,7:1,10:1},48)[0]=='Cm7'
    assert estimate({0:1,4:1},48)[1]==0
    assert estimate({},48)[0]=='N.C.'
    s=parse_midi(pack([[mido.Message('note_on',channel=9,note=36),mido.Message('note_off',channel=9,note=36,time=480)]]))
    a=MusicAnalysis(s)
    assert a.selected is None and a.chords[0]['label']=='?'
    assert a.score(0).size==(1920,280)


def test_type0_parts_and_bar_crossing():
    s=parse_midi(pack([[mido.Message('program_change',channel=1,program=40),mido.Message('note_on',channel=0,note=60),mido.Message('note_on',channel=1,note=67),mido.Message('note_off',channel=0,note=60,time=2400),mido.Message('note_off',channel=1,note=67)]],kind=0))
    assert {p['id']:p['program'] for p in parts(s)}=={'0:0':0,'0:1':40}
    a=MusicAnalysis(s)
    assert len(a.bar_notes[0])==1 and len(a.bar_notes[1])==1
    assert a.score(0).tobytes()!=a.score(1).tobytes()

@pytest.mark.parametrize('bad',[{'partVolumes':{'0:0':-1}},{'partVolumes':{'0:0':float('nan')}},{'partPrograms':{'0:0':128}},{'partPrograms':{'0:0':1.5}},{'scorePart':'x'},{'showScore':'false'}])
def test_mixer_settings_bounds(bad):
    with pytest.raises(ValueError):settings(bad)

@pytest.mark.skipif(not FONT,reason='SoundFont required')
def test_shared_channel_isolation_program_gain_and_cc(tmp_path):
    # Two tracks share CH1 and pitch; one is silent with independent instrument/gain.
    notes=[mido.Message('note_on',note=60,velocity=100),mido.Message('control_change',control=7,value=90,time=240),mido.Message('control_change',control=11,value=100,time=240),mido.Message('note_off',note=60,time=480)]
    song=parse_midi(pack([notes,notes]))
    def render(name,**kwargs):
        path=tmp_path/f'{name}.wav';synthesize(song,FONT,path,**kwargs)
        with wave.open(str(path)) as w:return np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype(float)
    reference=render('reference',hidden=[1])
    half=render('half',hidden=[1],volumes={'0:0':.5})
    rms=lambda x:np.sqrt(np.mean(x*x))
    assert rms(half)/rms(reference)==pytest.approx(.5,abs=.015)
    isolated=render('isolated',volumes={'1:0':0})
    assert np.max(np.abs(reference-isolated))<=1
    changed=render('changed',hidden=[1],programs={'0:0':40})
    assert not np.array_equal(reference,changed)
    silent=render('silent',volumes={'0:0':0,'1:0':0})
    assert not np.any(silent)
