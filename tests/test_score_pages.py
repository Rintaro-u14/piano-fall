import io
from pathlib import Path
import mido
import numpy as np
import pytest
from PIL import Image
from app import create_app
from pianofall.midi import parse_midi
from pianofall.music import ScorePresentation, MusicAnalysis
from pianofall.settings import settings
from pianofall.render import Renderer
from test_core import pack


def sample():return parse_midi((Path(__file__).parents[1]/'samples/Aurora_Study.mid').read_bytes())


def test_default_four_measures_and_page_boundaries():
    assert settings()['scoreMeasures']==4
    presentation=ScorePresentation(sample(),['1:0','2:1'],4)
    assert presentation.height==560
    assert presentation.page_at(0)==0 and presentation.page_at(7.99)==0
    assert presentation.page_at(8.1)==4
    assert presentation.page_at(2.1)==0 # backward seek
    data=presentation.public();bar=data['measures'][2]
    assert bar['page']==0 and bar['xStart']>1030 # room for 3/4 change
    x=presentation.cursor(4.7,0)
    assert bar['xStart']<x<bar['xEnd']
    assert len(presentation.cursors(4.7,0))==2
    assert presentation.score(0).size==(1920,560)
    assert presentation.score(4).size==(1920,560) # partial last page
    # Noteheads must stay in their measure, not overlap the clef/left margin.
    pixels=np.array(ScorePresentation(sample(),['1:0'],4).score(0))
    mint=np.all(pixels==[155,231,203],axis=2)
    assert not mint[:,:150].any() and mint[:,190:].any()


def test_selection_none_and_visual_independence():
    song=sample()
    selection=ScorePresentation(song,['3:2','1:0','3:2'],2)
    assert selection.selected==['1:0','3:2']
    assert [row.selected['id'] for row in selection.rows]==selection.selected
    assert {n['track'] for row in selection.rows for n in row.notes}=={1,3}
    empty=ScorePresentation(song,[],4)
    assert empty.rows==[] and empty.height==100 and empty.cursors(1,0)==[]
    cfg=settings({'scoreParts':['1:0','2:1'],'hiddenTracks':[1],'mutedTracks':[2]})
    rendered=Renderer(song,cfg)
    assert rendered.music.selected==['1:0','2:1'] and rendered.top==560
    assert len(rendered.notes)<len(song.notes)


@pytest.mark.parametrize('bad',[{'scoreMeasures':0},{'scoreMeasures':9},{'scoreMeasures':2.5},{'scoreParts':'1:0'},{'scoreParts':['4:99']}])
def test_score_settings_bounds(bad):
    with pytest.raises(ValueError):settings(bad)


def test_multi_score_api_and_empty_selection(tmp_path):
    app=create_app(tmp_path);c=app.test_client()
    try:
        sid=c.post('/api/sample').json['id']
        query='parts=1:0,2:1&measures=4'
        data=c.get(f'/api/music/{sid}?{query}').json
        assert data['scoreParts']==['1:0','2:1'] and data['scoreMeasures']==4
        response=c.get(f'/api/score/{sid}/0.png?{query}')
        assert Image.open(io.BytesIO(response.data)).size==(1920,560)
        assert c.get(f'/api/score/{sid}/4.png?{query}').status_code==200
        assert c.get(f'/api/score/{sid}/1.png?{query}').status_code==400
        assert c.get(f'/api/music/{sid}?parts=&measures=4').json['scoreParts']==[]
        assert c.get(f'/api/music/{sid}?parts=4:9&measures=4').status_code==400
        assert c.get(f'/api/music/{sid}?parts=1:0&measures=9').status_code==400
    finally:app.extensions['pianofall']['executor'].shutdown()


def test_chords_use_only_piano_and_change_on_bar_heads():
    # Piano C major then F major, with a conflicting violin B major throughout.
    piano=[mido.Message('program_change',program=0)]
    for chord in [(60,64,67),(65,69,72)]:
        piano += [mido.Message('note_on',note=p,velocity=90) for p in chord]
        piano += [mido.Message('note_off',note=p,time=1920 if i==0 else 0) for i,p in enumerate(chord)]
    violin=[mido.Message('program_change',channel=1,program=40)]
    violin += [mido.Message('note_on',channel=1,note=p,velocity=127) for p in (59,63,66)]
    violin += [mido.Message('note_off',channel=1,note=p,time=3840 if i==0 else 0) for i,p in enumerate((59,63,66))]
    s=parse_midi(pack([piano,violin]))
    a=MusicAnalysis(s)
    assert a.public()['chordParts']==['0:0']
    assert [(c['start'],c['label']) for c in a.chords]==[(0,'C'),(2,'F')]
    assert a.chord_at(.5)['label']==a.chord_at(1.999)['label']=='C'
    assert a.chord_at(2)['label']=='F'
    # Choosing violin for the score cannot change the piano chord source.
    assert ScorePresentation(s,['1:1'],4).base.chords==a.chords
