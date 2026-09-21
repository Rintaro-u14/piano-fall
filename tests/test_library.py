import io
from pathlib import Path
from urllib.error import HTTPError
from email.message import Message
import time
import pytest
from app import create_app
from pianofall import library

SAMPLE=(Path(__file__).parents[1]/'samples/Aurora_Study.mid').read_bytes()


def test_search_sources_are_supported_set():
    rows=library.search_sources('月光 & Beethoven')['sources']
    assert [r['id'] for r in rows]==['bitmidi','midiworld','midisfree','mididb','by_cif']
    assert all(r['home'].startswith('https://') for r in rows)


@pytest.mark.parametrize('url',[
    'http://bitmidi.com/a.mid','https://127.0.0.1/a.mid','https://bitmidi.com.evil.test/a.mid',
    'https://evil.bitmidi.com/a.mid','https://user@bitmidi.com/a.mid','https://bitmidi.com:8000/a.mid',
    'file:///etc/passwd'
])
def test_import_url_restrictions(url):
    with pytest.raises(ValueError):library.checked_url(url)


def test_getuploader_delivery_hosts_are_allowed():
    assert library.checked_url('https://uu.getuploader.com/by_cif/download/675')
    assert library.checked_url('https://dl1.getuploader.com/g/by_cif/675/test.mid')


def test_redirect_revalidated_and_size_bound(monkeypatch):
    monkeypatch.setattr(library,'public_host',lambda url:None)
    class Redirect:
        def open(self,*args,**kwargs):
            headers=Message();headers['Location']='http://127.0.0.1/private'
            raise HTTPError('https://bitmidi.com/a',302,'redirect',headers,io.BytesIO())
    monkeypatch.setattr(library,'build_opener',lambda *a:Redirect())
    with pytest.raises(ValueError,match='HTTPS'):library.fetch('https://bitmidi.com/a',10,time.monotonic()+10)
    class Response(io.BytesIO):headers={}
    class Oversize:
        def open(self,*args,**kwargs):return Response(b'12345678901')
    monkeypatch.setattr(library,'build_opener',lambda *a:Oversize())
    with pytest.raises(ValueError,match='上限'):library.fetch('https://bitmidi.com/a',10,time.monotonic()+10)


def test_direct_bitmidi_search_and_import(tmp_path, monkeypatch):
    calls=[]
    search_html=b'''<html><body>
    <a href="/beethoven-moonlight-sonata-mid">Beethoven-Moonlight-Sonata.mid</a>
    <a href="/search?page=2&q=beethoven">2</a>
    <a href="/beethoven-opus-57-mid">Beethoven-Opus-57.mid</a>
    <a href="/popular-random-mid">Totally-Unrelated-Popular.mid</a>
    </body></html>'''
    song_html=b'<h1>Beethoven-Moonlight-Sonata.mid</h1><a href="/uploads/123.mid">Download</a>'
    def fake_fetch(url, limit, deadline):
        calls.append(url)
        if '/search?' in url:return search_html,url,{}
        if url.endswith('/beethoven-moonlight-sonata-mid'):return song_html,url,{}
        if url.endswith('/uploads/123.mid'):return SAMPLE,url,{}
        raise AssertionError(url)
    monkeypatch.setattr(library,'fetch',fake_fetch)
    assert [x['name'] for x in library.search_bitmidi('beethoven')]==['Beethoven-Moonlight-Sonata.mid','Beethoven-Opus-57.mid']
    content,name,_=library.download_midi('https://bitmidi.com/beethoven-moonlight-sonata-mid')
    assert content==SAMPLE and name=='Beethoven-Moonlight-Sonata.mid'


def test_mididb_search_and_page_import(monkeypatch):
    search=b'<a href="/beethoven/moonlight-sonata-midi/">Beethoven Moonlight Sonata</a><a href="/random/pop-hit-midi/">Random Pop Hit</a>'
    page=b'<h1>Moonlight Sonata Beethoven FREE MIDI</h1><a href="/midi-download/AUD_AP1212H.mid">Download Free MIDI</a>'
    def fake_fetch(url,limit,deadline):
        if 'search.asp?' in url:return search,url,{}
        if 'moonlight-sonata-midi' in url:return page,url,{}
        if '/midi-download/' in url:return SAMPLE,url,{}
        raise AssertionError(url)
    monkeypatch.setattr(library,'fetch',fake_fetch)
    rows=library.search_mididb('beethoven')
    assert [r['name'] for r in rows]==['Beethoven Moonlight Sonata']
    content,name,_=library.download_midi(rows[0]['pageUrl'])
    assert content==SAMPLE and name.lower().endswith(('.mid','.midi'))


def test_midisfree_search_and_wpdmdl_import(monkeypatch):
    search=b'<a href="/download/beethoven-ode-to-joy-9th-mid/">Beethoven - Ode To Joy (9th).mid</a>'
    page=b'<h1>Beethoven - Ode To Joy (9th).mid</h1><a href="/?wpdmdl=123">Download</a>'
    def fake_fetch(url,limit,deadline):
        if '?s=beethoven' in url:return search,url,{}
        if '/download/beethoven-' in url:return page,url,{}
        if 'wpdmdl=123' in url:return SAMPLE,url,{}
        raise AssertionError(url)
    monkeypatch.setattr(library,'fetch',fake_fetch)
    rows=library.search_midisfree('beethoven')
    assert rows and rows[0]['name'].endswith('.mid')
    content,_,_=library.download_midi(rows[0]['pageUrl'])
    assert content==SAMPLE


def test_midiworld_artist_fallback_returns_direct_downloads(monkeypatch):
    broken=b'SQLSTATE[HY000] [2002] No such file or directory'
    index=b'<a href="/files/8/">Beethoven Ludwig van</a>'
    artist=b'<ul><li>Symphony No.5 Mvt.1 (Beethoven Ludwig van) - <a href="/download/12">download</a></li></ul>'
    def fake_fetch(url,limit,deadline):
        if '/search/?' in url:return broken,url,{}
        if '/files/B/all/' in url:return index,url,{}
        if url.endswith('/files/8/'):return artist,url,{}
        if url.endswith('/download/12'):return SAMPLE,url,{}
        raise AssertionError(url)
    monkeypatch.setattr(library,'fetch',fake_fetch)
    monkeypatch.setattr(library,'_probe_direct_midi',lambda url, deadline=None: True)
    rows=library.search_midiworld('Beethoven')
    assert rows and 'Symphony' in rows[0]['name']
    assert rows[0]['importUrl'].endswith('/download/12')
    assert library.download_midi(rows[0]['importUrl'])[0]==SAMPLE


def test_uploader_catalog_search_and_page_resolution(monkeypatch):
    library._UPLOADER_CACHE={'at':0.0,'rows':[]}
    monkeypatch.setattr(library,'_uploader_catalog',lambda:[
        library._row('Midi uploader.jp','RED ZONE.mid','https://uu.getuploader.com/by_cif/download/1'),
        library._row('Midi uploader.jp','Other.mid','https://uu.getuploader.com/by_cif/download/2'),
    ])
    rows=library.search_uploader('red zone')
    assert [r['name'] for r in rows]==['RED ZONE.mid']
    page=b'<h1>RED ZONE.mid</h1><input value="https://dl1.getuploader.com/g/by_cif/1/RED%20ZONE.mid">'
    def fake_fetch(url,limit,deadline):
        if 'uu.getuploader.com' in url:return page,url,{}
        if 'dl1.getuploader.com' in url:return SAMPLE,url,{}
        raise AssertionError(url)
    monkeypatch.setattr(library,'fetch',fake_fetch)
    content,name,_=library.download_midi(rows[0]['pageUrl'])
    assert content==SAMPLE and name=='RED ZONE.mid'


def test_unified_search_dedupes_provider_titles(monkeypatch):
    monkeypatch.setattr(library,'SEARCHERS',{
        'a':lambda q:[library._row('A','Song.mid','https://bitmidi.com/song')],
        'b':lambda q:[library._row('B','Song.MIDI','https://midisfree.com/download/song/')],
        'c':lambda q:[library._row('C','Song live.mid','https://www.mididb.com/a/song-live-midi/')],
    })
    result=library.search_library('song')
    assert [r['name'] for r in result['results']]==['Song.mid','Song live.mid']


def test_midiworld_search_drops_confirmed_dead_direct_result(monkeypatch):
    search=(
        b'<ul>'
        b'<li>Megalovania (Undertale) - <a href="/download/4838">download</a></li>'
        b'<li>Megalovania (Undertale) - <a href="/download/4884">download</a></li>'
        b'<li>Megalovania Remix by J.W. (Toby Fox) - <a href="/download/5234">download</a></li>'
        b'</ul>'
    )
    def fake_fetch(url,limit,deadline):
        if '/search/?' in url:return search,url,{}
        raise AssertionError(url)
    monkeypatch.setattr(library,'fetch',fake_fetch)
    monkeypatch.setattr(library,'_probe_direct_midi',lambda url, deadline=None: not url.endswith('/5234'))
    rows=library.search_midiworld('MEGALOVANIA')
    assert [r['importUrl'].rsplit('/',1)[-1] for r in rows]==['4838','4884']
