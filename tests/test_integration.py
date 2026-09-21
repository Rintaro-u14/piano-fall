"""Run with PIANOFALL_TEST_SF2 pointing to a General MIDI .sf2."""
import io
import os
import time
import wave
from pathlib import Path
import mido
import numpy as np
import pytest
from app import create_app
from pianofall.midi import parse_midi
from pianofall.audio import synthesize, RATE

FONT=os.environ.get('PIANOFALL_TEST_SF2')
pytestmark=pytest.mark.skipif(not FONT,reason='Set PIANOFALL_TEST_SF2 for SoundFont integration tests')


def test_sound_onset_and_track_mute(tmp_path):
    midi=mido.MidiFile()
    midi.tracks.append(mido.MidiTrack([mido.Message('note_on',note=60,velocity=100,time=480),mido.Message('note_off',note=60,time=480)]))
    data=io.BytesIO();midi.save(file=data);song=parse_midi(data.getvalue())
    def samples(path):
        with wave.open(str(path)) as f:
            assert f.getframerate()==RATE and f.getnchannels()==2
            return np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').reshape(-1,2)
    synthesize(song,FONT,tmp_path/'audible.wav')
    audio=samples(tmp_path/'audible.wav')
    assert np.max(np.abs(audio[:int(.5*RATE)].astype(int)))==0
    assert np.max(np.abs(audio[int(.53*RATE):int(.8*RATE)].astype(int)))>100
    synthesize(song,FONT,tmp_path/'muted.wav',hidden=[0])
    assert np.max(np.abs(samples(tmp_path/'muted.wav').astype(int)))==0


def test_job_completion_download_and_cancel(tmp_path):
    app=create_app(tmp_path);client=app.test_client()
    font=client.post('/api/soundfont',json={'path':FONT})
    assert font.status_code==200
    sample=client.post('/api/sample').json
    payload=dict(songId=sample['id'],fontId=font.json['id'],kind='audio')
    def wait(jid):
        for _ in range(300):
            state=client.get(f'/api/jobs/{jid}').json
            if state['status'] in ('complete','failed','cancelled'):return state
            time.sleep(.05)
        pytest.fail('job timeout')
    jid=client.post('/api/jobs',json=payload).json['id']
    complete=wait(jid)
    assert complete['status']=='complete'
    wav=client.get(complete['url'])
    assert wav.status_code==200 and wav.data[:4]==b'RIFF'
    # Real video request, with a queued/running conflict and cancellation.
    payload.update(kind='video',settings={'fps':60})
    jid=client.post('/api/jobs',json=payload).json['id']
    assert client.post('/api/jobs',json=payload).status_code==409
    assert client.post(f'/api/jobs/{jid}/cancel').status_code==200
    assert wait(jid)['status']=='cancelled'
    assert not list((tmp_path/'exports').glob('*.partial.mp4'))
    # Cache is reusable after cancellation; short real encode and ranged download.
    payload.update(start=0,end=.5)
    jid=client.post('/api/jobs',json=payload).json['id']
    complete=wait(jid)
    assert complete['status']=='complete'
    video=client.get(complete['url'],headers={'Range':'bytes=0-99'})
    assert video.status_code==206 and b'ftyp' in video.data
    app.extensions['pianofall']['executor'].shutdown()


def test_visibility_and_audio_are_independent(tmp_path):
    from pianofall.settings import settings
    from pianofall.render import Renderer
    app=create_app(tmp_path);client=app.test_client()
    font=client.post('/api/soundfont',json={'path':FONT}).json
    sample=client.post('/api/sample').json
    parsed=app.extensions['pianofall']['songs'][sample['id']]
    ids=[t['id'] for t in sample['tracks'] if t['count']]
    def run(config):
        reply=client.post('/api/jobs',json=dict(songId=sample['id'],fontId=font['id'],kind='audio',settings=config))
        assert reply.status_code==202
        for _ in range(300):
            state=client.get('/api/jobs/'+reply.json['id']).json
            if state['status'] in ('complete','failed'):break
            time.sleep(.05)
        assert state['status']=='complete',state
        return state['url'],client.get(state['url']).data
    try:
        all_url,all_audio=run({})
        hidden_url,hidden_audio=run({'hiddenTracks':ids,'mutedTracks':[]})
        assert hidden_url==all_url and hidden_audio==all_audio
        assert Renderer(parsed,settings({'hiddenTracks':ids})).notes==[]
        muted_url,muted_audio=run({'hiddenTracks':[],'mutedTracks':ids})
        assert muted_url!=all_url
        with wave.open(io.BytesIO(muted_audio)) as w:
            assert not np.any(np.frombuffer(w.readframes(w.getnframes()),dtype='<i2'))
        assert len(Renderer(parsed,settings({'mutedTracks':ids})).notes)==len(parsed.notes)
        # Piano/melody only on screen; other instruments still audible.
        config={'hiddenTracks':ids[1:],'mutedTracks':[]}
        assert {n['track'] for n in Renderer(parsed,settings(config)).notes}=={ids[0]}
        assert run(config)[0]==all_url
    finally:
        app.extensions['pianofall']['executor'].shutdown()
