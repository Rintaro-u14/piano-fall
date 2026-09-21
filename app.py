from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock, Timer, Semaphore
from urllib.parse import urlsplit
import argparse
import io
from collections import OrderedDict
import hashlib
import json
import math
import os
import uuid
import webbrowser
from flask import Flask, jsonify, request, send_file
from werkzeug.exceptions import HTTPException
from pianofall.music import ScorePresentation, parts
from pianofall.library import search_sources, search_library, download_midi, checked_url
from pianofall.midi import parse_midi
from pianofall.settings import settings, DEFAULTS, PALETTE, keys
from pianofall.audio import synthesize, open_font, Cancelled
from pianofall.render import encode_video

ROOT = Path(__file__).resolve().parent


def create_app(data_dir=None):
    app = Flask(__name__, static_folder='static')
    app.config['MAX_CONTENT_LENGTH'] = 520 * 1024 * 1024
    data = Path(data_dir or ROOT / 'data')
    for name in ('midi', 'soundfonts', 'audio', 'exports'):
        (data / name).mkdir(parents=True, exist_ok=True)
    songs, fonts, jobs = {}, {}, {}
    executor = ThreadPoolExecutor(max_workers=1)
    lock = Lock()
    import_lock = Lock()
    analysis_lock = Lock()
    stem_guard = Lock()
    stem_locks = {}
    stem_slots = Semaphore(2)
    analyses = OrderedDict()
    app.extensions['pianofall'] = dict(songs=songs, fonts=fonts, jobs=jobs, executor=executor, data=data)

    def register_font(path):
        path = Path(path)
        if not path.is_file() or path.suffix.lower() != '.sf2':
            raise ValueError('有効な.sf2ファイルを指定してください。')
        if path.stat().st_size > 512 * 1024 * 1024:
            raise ValueError('SoundFontは512MB以下にしてください。')
        with path.open('rb') as f:
            header = f.read(12)
        if header[:4] != b'RIFF' or header[8:12] != b'sfbk':
            raise ValueError('SoundFont 2形式ではありません。')
        soundfont = open_font(path)
        drumkits = [dict(program=p, name=soundfont.get_preset_name(soundfont.get_preset_index(128, p)))
                    for p in range(128) if soundfont.get_preset_index(128, p) >= 0]
        fid = hashlib.sha256(path.read_bytes()).hexdigest()[:20]
        fonts[fid] = dict(id=fid, name=path.name, path=path, drumkits=drumkits)
        return dict(id=fid, name=path.name, drumkits=drumkits, browserUrl=f'/api/files/soundfont/{fid}.sf2')

    for font in sorted((ROOT / 'soundfonts').glob('*.sf2')) + sorted((data / 'soundfonts').glob('*.sf2')):
        try:
            register_font(font)
        except Exception:
            app.logger.warning('SoundFontを読み込めません: %s', font.name)
    if os.environ.get('PIANOFALL_SF2'):
        register_font(os.environ['PIANOFALL_SF2'])

    @app.before_request
    def local_only():
        if request.host.split(':')[0] not in ('127.0.0.1', 'localhost'):
            return jsonify(error='localhostで開いてください。'), 403
        origin = request.headers.get('Origin')
        if origin and urlsplit(origin).netloc != request.host:
            return jsonify(error='別のサイトからのリクエストは許可されません。'), 403

    @app.after_request
    def log_api_failure(response):
        if request.path.startswith('/api/') and response.status_code >= 400:
            app.logger.warning('API %s %s -> %s', request.method, request.path, response.status_code)
        return response

    @app.errorhandler(Exception)
    def failure(error):
        if isinstance(error, HTTPException):
            if error.code == 404 and request.path.startswith('/api/'):
                return jsonify(error='このAPIは見つかりません。アプリを再起動して画面を更新してください。', path=request.path), 404
            return jsonify(error=error.description), error.code
        if isinstance(error, (ValueError, KeyError, TypeError, EOFError, OSError)):
            return jsonify(error=str(error) or 'ファイルを読み込めません。形式を確認してください。'), 400
        app.logger.exception('Request failed')
        return jsonify(error='処理に失敗しました。ターミナルのログを確認してください。'), 500

    @app.get('/')
    def index():
        return app.send_static_file('index.html')

    @app.get('/favicon.ico')
    def favicon():
        return '', 204

    @app.get('/api/status')
    def status():
        return jsonify(apiVersion=9, defaults=DEFAULTS, palette=PALETTE, audioBackend='browser-spessasynth',
                       fonts=[dict(id=f['id'], name=f['name'], drumkits=f['drumkits'], browserUrl=f'/api/files/soundfont/{f["id"]}.sf2') for f in fonts.values()],
                       exportDirectory=str((data / 'exports').resolve()))

    def add_song(content, name, source=None):
        sid = hashlib.sha256(content).hexdigest()[:20]
        song = parse_midi(content, Path(name.replace('\\', '/')).name)
        songs[sid] = song
        (data / 'midi' / f'{sid}.mid').write_bytes(content)
        return jsonify(id=sid, midiUrl=f'/api/files/midi/{sid}.mid', sourceUrl=source, parts=parts(song),
                       audioEvents=song.events, **song.public())

    @app.get('/api/midi-sources')
    def midi_sources():
        return jsonify(search_sources(request.args.get('q', '')))

    @app.get('/api/midi-search')
    def midi_search():
        return jsonify(search_library(request.args.get('q', '')))

    @app.post('/api/midi-url')
    def midi_url():
        body = request.get_json() or {}
        url = checked_url(body.get('url', ''))
        source = checked_url(body.get('pageUrl', url))
        if not import_lock.acquire(blocking=False):
            return jsonify(error='別のMIDIを取り込み中です。完了後に実行してください。'), 409
        try:
            content, name, _ = download_midi(url)
            return add_song(content, name, source=source)
        finally:
            import_lock.release()

    @app.post('/api/midi')
    def upload():
        file = request.files['file']
        return add_song(file.stream.read(20 * 1024 * 1024 + 1), file.filename or 'Untitled.mid')

    @app.post('/api/sample')
    def sample():
        return add_song((ROOT / 'samples' / 'Aurora_Study.mid').read_bytes(), 'Aurora Study.mid')

    @app.post('/api/soundfont')
    def font_upload():
        if 'file' in request.files:
            file = request.files['file']
            name = Path((file.filename or 'SoundFont.sf2').replace('\\', '/')).name
            if not name.lower().endswith('.sf2'):
                raise ValueError('.sf2ファイルを指定してください。')
            path = data / 'soundfonts' / f'{uuid.uuid4().hex[:8]}_{name}'
            file.save(path)
            try:
                return jsonify(register_font(path))
            except Exception:
                path.unlink(missing_ok=True)
                raise
        return jsonify(register_font(Path(request.json['path']).expanduser()))

    @app.post('/api/geometry')
    def geometry():
        cfg = settings(request.json)
        return jsonify(keys=keys(cfg['minPitch'], cfg['maxPitch']))

    def get_song(sid):
        if sid not in songs:
            path = data / 'midi' / f'{sid}.mid'
            if not sid.isalnum() or not path.is_file():
                raise ValueError('MIDIを読み込み直してください。')
            songs[sid] = parse_midi(path.read_bytes())
        return songs[sid]

    def analysis(sid):
        selected=request.args.get('parts')
        selected=selected.split(',') if selected else [] if selected is not None else None
        part=request.args.get('part','auto')
        count=int(request.args.get('measures','1'))
        cfg=settings(dict(scoreParts=selected,scorePart=part,scoreMeasures=count))
        key=(sid,tuple(cfg['scoreParts']) if cfg['scoreParts'] is not None else None,part,count)
        with analysis_lock:
            if key not in analyses:
                analyses[key]=ScorePresentation(get_song(sid),cfg['scoreParts'],count,part)
                while len(analyses)>6:analyses.popitem(last=False)
            analyses.move_to_end(key)
            return analyses[key]

    @app.get('/api/music/<sid>')
    def music_analysis(sid):
        return jsonify(analysis(sid).public())

    @app.get('/api/score/<sid>/<int:index>.png')
    def score_image(sid,index):
        score=analysis(sid).score(index)
        buffer=io.BytesIO();score.save(buffer,format='PNG');buffer.seek(0)
        return send_file(buffer,mimetype='image/png',max_age=3600)

    @app.get('/api/score/<sid>.pdf')
    def score_pdf(sid):
        presentation = analysis(sid)
        if not presentation.selected:
            raise ValueError('楽譜に表示するパートを1つ以上選択してください。')
        pages = range(0, len(presentation.base.measures), presentation.count)
        first_page = next(iter(pages), None)
        if first_page is None:
            raise ValueError('楽譜に書き出せる小節がありません。')
        first = presentation.score(first_page).convert('RGB')
        rest = (presentation.score(page).convert('RGB')
                for page in range(first_page + presentation.count, len(presentation.base.measures), presentation.count))
        buffer = io.BytesIO()
        first.save(buffer, format='PDF', save_all=True, append_images=rest, resolution=150.0)
        buffer.seek(0)
        stem = Path(get_song(sid).name).stem
        safe = ''.join(ch if ch.isalnum() or ch in ' _-' else '_' for ch in stem).strip() or 'score'
        return send_file(buffer, mimetype='application/pdf', as_attachment=True,
                         download_name=f'{safe}_score.pdf', max_age=0)

    @app.post('/api/stem')
    def render_stem():
        """Render and cache one isolated MIDI part for the browser Web Audio mixer.

        Mixer gain/mute changes happen in the browser and therefore never require a
        re-render.  A program change only invalidates this one stem; the rest of the
        song can keep playing while this request is synthesized.
        """
        body = request.get_json() or {}
        sid, fid, part_id = str(body.get('songId', '')), str(body.get('fontId', '')), str(body.get('partId', ''))
        if fid not in fonts:
            raise ValueError('リアルタイム再生用のSoundFontを選択してください。')
        song = get_song(sid)
        available = {p['id']: p for p in parts(song)}
        if part_id not in available:
            raise ValueError('MIDIパートが見つかりません。MIDIを読み込み直してください。')
        program = body.get('program', None)
        if program in ('', None):
            program = None
        else:
            program = int(program)
            if not 0 <= program <= 127:
                raise ValueError('音色番号は0〜127で指定してください。')
        cache_key = hashlib.sha256(json.dumps(['stem-v1', sid, fid, part_id, program], sort_keys=True).encode()).hexdigest()[:24]
        wav = data / 'audio' / f'stem_{cache_key}.wav'
        with stem_guard:
            part_lock = stem_locks.setdefault(cache_key, Lock())
        with part_lock:
            if not wav.exists():
                temp = wav.with_suffix('.partial.wav')
                try:
                    with stem_slots:
                        programs = {part_id: program} if program is not None else {}
                        synthesize(song, fonts[fid]['path'], temp, programs=programs,
                                   volumes={part_id: 1.0}, master_volume=1.0,
                                   include_parts={part_id})
                    temp.replace(wav)
                finally:
                    temp.unlink(missing_ok=True)
        return jsonify(url=f'/api/files/audio/{wav.name}', partId=part_id, program=program)

    @app.post('/api/jobs')
    def start_job():
        body = request.get_json()
        sid, fid, kind = body['songId'], body['fontId'], body['kind']
        if kind not in ('audio', 'video') or fid not in fonts:
            raise ValueError('音声合成用のSoundFontを選択してください。')
        song, cfg = get_song(sid), settings(body.get('settings'))
        start = float(body.get('start', 0))
        end = float(body.get('end', song.duration + 2))
        if not all(math.isfinite(x) for x in (start, end)) or not 0 <= start < end <= song.duration + 2:
            raise ValueError('書き出し範囲が不正です。')
        with lock:
            if any(j['status'] in ('queued', 'running') for j in jobs.values()):
                return jsonify(error='別の処理が進行中です。完了またはキャンセル後に実行してください。'), 409
            jid = uuid.uuid4().hex
            job = dict(id=jid, kind=kind, status='queued', progress=0, phase='準備中', cancel=Event())
            jobs[jid] = job
        font_path = fonts[fid]['path']
        audio_key = hashlib.sha256(json.dumps(['mixer-v3', sid, fid, cfg['mutedTracks'], cfg['partPrograms'], cfg['partVolumes'], cfg['masterVolume']], sort_keys=True).encode()).hexdigest()[:24]
        wav = data / 'audio' / f'{audio_key}.wav'
        def run():
            job['status'] = 'running'
            try:
                if not wav.exists():
                    job['phase'] = 'SoundFontで音声を合成中'
                    temp = wav.with_suffix('.partial.wav')
                    try:
                        synthesize(song, font_path, temp, cfg['mutedTracks'],
                                   lambda p: job.update(progress=p * (0.25 if kind == 'video' else 1)), job['cancel'], programs=cfg['partPrograms'], volumes=cfg['partVolumes'], master_volume=cfg['masterVolume'])
                        check = job['cancel'].is_set()
                        if check:
                            raise Cancelled()
                        temp.replace(wav)
                    finally:
                        temp.unlink(missing_ok=True)
                if kind == 'video':
                    job.update(phase='1080pの動画を書き出し中', progress=.25)
                    target = data / 'exports' / f'PianoFall_{jid[:10]}_{cfg["fps"]}fps.mp4'
                    encode_video(song, cfg, wav, target, lambda p: job.update(progress=.25 + .75 * p), job['cancel'], start, end)
                    job['url'] = f'/api/files/video/{target.name}'
                    job['filename'] = target.name
                else:
                    job['url'] = f'/api/files/audio/{wav.name}'
                job.update(status='complete', progress=1, phase='完了')
            except Cancelled:
                job.update(status='cancelled', phase='キャンセルしました')
            except Exception as e:
                app.logger.exception('Job failed')
                job.update(status='failed', error=str(e), phase='処理に失敗しました')
        executor.submit(run)
        return jsonify(id=jid), 202

    @app.get('/api/jobs/<jid>')
    def job_status(jid):
        return jsonify({k: v for k, v in jobs[jid].items() if k != 'cancel'})

    @app.post('/api/jobs/<jid>/cancel')
    def cancel(jid):
        jobs[jid]['cancel'].set()
        return jsonify(ok=True)

    @app.get('/api/files/soundfont/<fid>.sf2')
    def soundfont_file(fid):
        if fid not in fonts:
            return '', 404
        path = Path(fonts[fid]['path'])
        if not path.is_file():
            return '', 404
        return send_file(path.resolve(), mimetype='application/octet-stream', conditional=True, max_age=86400)

    @app.get('/api/files/<kind>/<name>')
    def result(kind, name):
        folder = {'audio': 'audio', 'video': 'exports', 'midi': 'midi'}.get(kind)
        if not folder or Path(name).name != name or not name.replace('.', '').replace('_', '').isalnum():
            return '', 404
        path = data / folder / name
        if not path.is_file() or path.suffix != {'audio': '.wav', 'video': '.mp4', 'midi': '.mid'}[kind]:
            return '', 404
        return send_file(path.resolve(), conditional=True, as_attachment=kind != 'audio',
                         download_name=songs[path.stem].name if kind == 'midi' and path.stem in songs else path.name)

    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    app = create_app()
    url = f'http://127.0.0.1:{args.port}'
    print(f'Piano Fall: {url}', flush=True)
    if not args.no_browser:
        Timer(1, lambda: webbrowser.open(url)).start()
    from waitress import serve
    serve(app, host='127.0.0.1', port=args.port, threads=16)
