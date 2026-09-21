import math
import re

PALETTE = ['#77e4c8', '#ac9bff', '#ffbd78', '#78baff', '#f18bb5', '#e5db84', '#86d78a', '#f08d85']
DEFAULTS = dict(background='#10191e', colorMode='track', colors={}, keyboardHeight=0.22,
                fallSeconds=3.5, minPitch=21, maxPitch=108, hiddenTracks=[], mutedTracks=[], speed=1, fps=30, showScore=True, showChords=True, scorePart="auto", scoreMeasures=4, scoreParts=None, partPrograms={}, partVolumes={}, masterVolume=1.6)


def settings(data=None):
    d = {**DEFAULTS, **(data or {})}
    def number(key, lo, hi, integer=False):
        val = float(d[key])
        if not math.isfinite(val) or not lo <= val <= hi:
            raise ValueError(f'{key}は{lo}〜{hi}の範囲にしてください。')
        if integer and val != int(val):
            raise ValueError(f'{key}は整数にしてください。')
        return int(val) if integer else val
    def color(v):
        if not isinstance(v, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', v):
            raise ValueError('色は#RRGGBBで指定してください。')
        return v
    result = dict(background=color(d['background']), colorMode=d['colorMode'],
                  keyboardHeight=number('keyboardHeight', .12, .4), fallSeconds=number('fallSeconds', 1, 10),
                  minPitch=number('minPitch', 0, 127, True), maxPitch=number('maxPitch', 0, 127, True),
                  speed=number('speed', .25, 2), fps=number('fps', 30, 60, True), masterVolume=number('masterVolume', 0, 3.2))
    if result['maxPitch'] <= result['minPitch'] or result['fps'] not in (30, 60):
        raise ValueError('鍵域またはFPSが不正です。')
    if d['colorMode'] not in ('track', 'channel'):
        raise ValueError('色分けはtrackまたはchannelです。')
    result['colors'] = {str(k): color(v) for k, v in d['colors'].items()}
    for key in ('hiddenTracks', 'mutedTracks'):
        result[key] = sorted(set(int(v) for v in d[key]))
    for key in ('showScore', 'showChords'):
        if not isinstance(d[key], bool):
            raise ValueError(f'{key}は真偽値にしてください。')
        result[key] = d[key]
    if not isinstance(d['scorePart'], str) or not re.fullmatch(r'auto|[0-9]{1,6}:(?:[0-9]|1[0-5])', d['scorePart']):
        raise ValueError('楽譜パートが不正です。')
    result['scorePart'] = d['scorePart']
    result['scoreMeasures'] = number('scoreMeasures',1,8,True)
    selected=d['scoreParts']
    if selected is not None and (not isinstance(selected,list) or any(not isinstance(p,str) or not re.fullmatch(r'[0-9]{1,6}:(?:[0-9]|1[0-5])',p) for p in selected)):
        raise ValueError('楽譜パートはIDの配列で指定してください。')
    result['scoreParts'] = list(dict.fromkeys(selected)) if selected is not None else None
    for key, hi in (('partPrograms', 127), ('partVolumes', 2)):
        if not isinstance(d[key], dict) or len(d[key]) > 4096:
            raise ValueError('楽器設定が不正です。')
        result[key] = {}
        for part, value in d[key].items():
            if not re.fullmatch(r'[0-9]{1,6}:(?:[0-9]|1[0-5])', str(part)):
                raise ValueError('楽器IDが不正です。')
            val = float(value)
            if not math.isfinite(val) or not 0 <= val <= hi or (key == 'partPrograms' and val != int(val)):
                raise ValueError('音色または音量の範囲が不正です。')
            result[key][str(part)] = int(val) if key == 'partPrograms' else val
    return result


def note_color(note, config):
    n = note[config['colorMode']]
    return config['colors'].get(f"{config['colorMode']}:{n}", PALETTE[n % len(PALETTE)])


def keys(low, high, width=1920):
    def black(p):
        return p % 12 in (1, 3, 6, 8, 10)
    # Extend the coordinate system to neighboring white keys, then crop to chosen range.
    locations, white_index = {}, 0
    for p in range(128):
        if black(p):
            locations[p] = (white_index - .31, .62, True)
        else:
            locations[p] = (white_index, 1, False)
            white_index += 1
    left = min(locations[p][0] for p in range(low, high + 1))
    right = max(locations[p][0] + locations[p][1] for p in range(low, high + 1))
    scale = width / (right - left)
    return [dict(pitch=p, x=(locations[p][0] - left) * scale, width=locations[p][1] * scale,
                 black=locations[p][2]) for p in range(low, high + 1)]
