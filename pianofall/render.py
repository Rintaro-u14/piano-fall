"""Frame-by-frame Pillow renderer piped to FFmpeg, independent of UI/GPU clocks."""
from bisect import bisect_left, bisect_right
from pathlib import Path
import math
import subprocess
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont
from .music import ScorePresentation
from .settings import keys, note_color
from .audio import check_cancel

W, H = 1920, 1080


class Renderer:
    def __init__(self, song, config):
        self.song, self.c = song, config
        self.keys = keys(config['minPitch'], config['maxPitch'], W)
        self.by_pitch = {k['pitch']: k for k in self.keys}
        self.line = round(H * (1 - config['keyboardHeight']))
        self.music = ScorePresentation(song, config['scoreParts'], config['scoreMeasures'], config['scorePart']) if config['showScore'] or config['showChords'] else None
        self.top = self.music.height if config['showScore'] else 0
        self.scale = (self.line-self.top) / config['fallSeconds']
        self.notes = [n for n in song.notes if n['track'] not in config['hiddenTracks'] and n['pitch'] in self.by_pitch]
        self.starts = [n['start'] for n in self.notes]
        self.longest = max((n['end'] - n['start'] for n in self.notes), default=0)
        self.beat_times = [b['time'] for b in song.beats]
        self.base = Image.new('RGB', (W, H), config['background'])
        d = ImageDraw.Draw(self.base, 'RGBA')
        for k in self.keys:
            if not k['black']:
                d.line((round(k['x']), 0, round(k['x']), self.line), fill=(180, 214, 226, 15), width=1)
        self.font = ImageFont.load_default(size=19)
        self.big = ImageFont.load_default(size=25)

    def frame(self, t):
        im = self.base.copy()
        d = ImageDraw.Draw(im, 'RGBA')
        line, scale = self.line, self.scale
        a = bisect_left(self.beat_times, t)
        b = bisect_right(self.beat_times, t + self.c['fallSeconds'])
        for beat in self.song.beats[a:b]:
            y = round(line - (beat['time'] - t) * scale)
            d.line((0, y, W, y), fill=(180, 214, 226, 34 if beat['strong'] else 15), width=2 if beat['strong'] else 1)
        active = {}
        a = bisect_left(self.starts, t - self.longest)
        b = bisect_right(self.starts, t + self.c['fallSeconds'])
        for n in self.notes[a:b]:
            if n['end'] <= t:
                continue
            k = self.by_pitch[n['pitch']]
            color = note_color(n, self.c)
            y0 = max(self.top, line - (n['end'] - t) * scale)
            y1 = min(line, line - (n['start'] - t) * scale)
            if y1 > y0:
                x0, x1 = k['x'] + 2, k['x'] + k['width'] - 2
                if x1 > x0:
                    d.rounded_rectangle((x0, y0, x1, y1), radius=min(5, (x1-x0)/2, (y1-y0)/2), fill=color)
                    d.line((x0 + 2, y0 + 2, x0 + 2, y1 - 1), fill=(255,255,255,75), width=2)
            if n['start'] <= t < n['end']:
                active[n['pitch']] = color
        for black in (False, True):
            for k in self.keys:
                if k['black'] != black:
                    continue
                bottom = line + (H-line) * (.63 if black else 1)
                color = active.get(k['pitch'], '#202b32' if black else '#e8efed')
                d.rounded_rectangle((k['x']+1, line, k['x']+k['width']-1, bottom-4), radius=3, fill=color)
                if not black and k['pitch'] % 12 == 0:
                    d.text((k['x'] + 4, H - 31), f"C{k['pitch']//12-1}", fill='#5b696e', font=self.font)
                if k['pitch'] in active:
                    d.rectangle((k['x']+1, line-5, k['x']+k['width']-1, line+4), fill=color)
        d.line((0,line,W,line), fill=(119,228,200,200), width=3)
        # A quiet, original title plate, identically positioned in the preview.
        top = self.top
        d.rounded_rectangle((28,top+24,265,top+93), radius=10, fill=(9,17,23,220))
        d.text((46,top+34), 'PIANO FALL', font=self.big, fill='#dce7e7')
        tempo = next(x for x in reversed(self.song.tempos) if x['time'] <= max(0,t))
        d.text((46,top+65), f"{tempo['bpm'] * self.c['speed']:.0f} BPM  /  {max(0,t):05.1f}s", font=self.font, fill='#80a29f')
        if self.c['showChords']:
            chord = self.music.chord_at(t)
            d.rounded_rectangle((28,top+110,265,top+221), radius=10, fill=(9,17,23,230))
            d.text((46,top+121), 'PIANO CHORD / EST.', font=self.font, fill='#80a29f')
            d.text((46,top+154), chord['label'], font=ImageFont.load_default(size=36), fill='#9be7cb')
        if self.c['showScore'] and self.music.base.measures:
            index = self.music.page_at(t)
            im.paste(self.music.score(index),(0,0))
            for x,y0,y1 in self.music.cursors(t,index):
                d.line((x,y0,x,y1),fill=(119,228,200,190),width=3)
        return im


def encode_video(song, config, wav, target, progress=lambda x: None, cancel=None, start=0, end=None):
    end = song.duration + 2 if end is None else end
    speed, fps = config['speed'], config['fps']
    seconds = (end - start) / speed
    frames = math.ceil(seconds * fps)
    renderer = Renderer(song, config)
    target = Path(target)
    partial = target.with_suffix('.partial.mp4')
    log = target.with_suffix('.ffmpeg.log')
    # atempo preserves pitch just like HTMLAudioElement.preservesPitch.
    filters = 'atempo=0.5,atempo=0.5' if speed == .25 else (f'atempo=0.5,atempo={speed*2}' if speed < .5 else f'atempo={speed}')
    command = [imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y',
               '-f', 'rawvideo', '-vcodec', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
               '-r', str(fps), '-i', '-', '-ss', str(start), '-i', str(wav),
               '-map', '0:v:0', '-map', '1:a:0', '-af', filters,
               '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
               '-threads', '4', '-c:a', 'aac', '-b:a', '192k', '-t', str(seconds),
               '-movflags', '+faststart', str(partial)]
    with log.open('w', encoding='utf-8') as err:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=err)
        try:
            for i in range(frames):
                check_cancel(cancel)
                proc.stdin.write(renderer.frame(start + i / fps * speed).tobytes())
                if i % fps == 0:
                    progress(i / frames)
            proc.stdin.close()
            while proc.poll() is None:
                check_cancel(cancel)
                try:
                    proc.wait(timeout=.25)
                except subprocess.TimeoutExpired:
                    pass
            if proc.returncode:
                raise RuntimeError('FFmpegの書き出しに失敗しました: ' + log.read_text(encoding='utf-8')[-1500:])
            partial.replace(target)
            progress(1)
        except BaseException:
            proc.kill()
            proc.wait()
            partial.unlink(missing_ok=True)
            raise
    log.unlink(missing_ok=True)
    return target
