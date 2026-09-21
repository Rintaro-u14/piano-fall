"""Tempo-aware measure map, conservative chord estimates and a compact grand staff."""
from bisect import bisect_right, bisect_left
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFont

SCORE_H = 280
FONT = Path(__file__).resolve().parents[1] / 'static/fonts/Bravura.otf'
NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
PATTERNS = [('', (0,4,7)), ('m',(0,3,7)), ('7',(0,4,7,10)), ('maj7',(0,4,7,11)),
            ('m7',(0,3,7,10)), ('dim',(0,3,6)), ('aug',(0,4,8)), ('sus2',(0,2,7)), ('sus4',(0,5,7))]


def parts(song):
    grouped = {}
    state = [0] * 16
    for e in song.events:
        if e['type'] == 'program_change':
            state[e['channel']] = e['program']
        elif e['type'] == 'note_on' and e['velocity']:
            key = f"{e['track']}:{e['channel']}"
            if key not in grouped:
                grouped[key] = dict(id=key, track=e['track'], channel=e['channel'],
                                    name=song.tracks[e['track']]['name'], program=state[e['channel']],
                                    drums=e['channel'] == 9, count=0)
            grouped[key]['count'] += 1
    return list(grouped.values())


class Timeline:
    def __init__(self, song):
        self.song = song
        self.ticks = [x['tick'] for x in song.tempos]
        self.times = [x['time'] for x in song.tempos]
    def seconds(self, tick):
        x = self.song.tempos[max(0, bisect_right(self.ticks, tick)-1)]
        return x['time'] + (tick-x['tick']) * x['tempo'] / self.song.ppqn / 1e6
    def tick(self, seconds):
        x = self.song.tempos[max(0, bisect_right(self.times, seconds)-1)]
        return x['tick'] + (seconds-x['time']) * self.song.ppqn * 1e6 / x['tempo']
    def measures(self):
        end = max(self.song.ppqn, self.tick(self.song.duration), max(n['endTick'] for n in self.song.notes))
        bars = []
        for i, sig in enumerate(self.song.signatures):
            stop = min(end, self.song.signatures[i+1]['tick']) if i+1 < len(self.song.signatures) else end
            step = self.song.ppqn * 4 * max(1, sig['numerator']) / sig['denominator']
            tick = sig['tick']
            while tick < stop - 1e-6:
                # Preserve full final measure; split a measure at an explicit meter change.
                last = min(tick+step, stop) if i+1 < len(self.song.signatures) else tick+step
                bars.append(dict(index=len(bars), startTick=tick, endTick=last,
                                 start=self.seconds(tick), end=self.seconds(last),
                                 numerator=sig['numerator'], denominator=sig['denominator']))
                tick = last
                if len(bars) > 20000:
                    raise ValueError('小節数が多すぎるため楽譜を作成できません。')
        return bars


def estimate(weights, bass):
    if not weights:
        return 'N.C.', 0.0
    total = sum(weights.values())
    present = {p for p,w in weights.items() if w >= total*.06}
    if len(present) < 3:
        return '?', 0.0
    candidates = []
    for root in range(12):
        for suffix, offsets in PATTERNS:
            tones = {(root+x)%12 for x in offsets}
            if not tones <= present:
                continue
            coverage = sum(weights.get(x,0) for x in tones) / total
            score = coverage - .025*(len(tones)-3) + (.025 if bass%12 == root else 0)
            candidates.append((score, coverage, root, suffix, tones))
    if not candidates:
        return '?', 0.0
    _, confidence, root, suffix, tones = max(candidates, key=lambda x:x[0])
    if confidence < .78:
        return '?', round(confidence,2)
    inversion = '/' + NAMES[bass%12] if bass%12 in tones and bass%12 != root else ''
    return NAMES[root]+suffix+inversion, round(confidence,2)


class MusicAnalysis:
    def __init__(self, song, part='auto', shared=None):
        self.song, self.timeline = song, shared.timeline if shared else Timeline(song)
        self.parts = shared.parts if shared else parts(song)
        pitched = [p for p in self.parts if not p['drums']]
        selected = next((p for p in pitched if p['id'] == part), None)
        if part != 'auto' and selected is None:
            raise ValueError('楽譜に表示する音程楽器のパートを選んでください。')
        if selected is None:
            selected = next((p for p in pitched if p['program'] < 8), pitched[0] if pitched else None)
        self.selected = selected
        self.measures = shared.measures if shared else self.timeline.measures()
        self.bar_starts = [b['start'] for b in self.measures]
        self.notes = [n for n in song.notes if selected and f"{n['track']}:{n['channel']}" == selected['id']]
        # Index notes once so long scores do not rescan every note on every page.
        self.bar_notes = defaultdict(list)
        starts = [b['startTick'] for b in self.measures]
        for n in self.notes:
            a = max(0, bisect_right(starts,n['startTick'])-1)
            b = min(len(starts), bisect_left(starts,n['endTick']))
            for index in range(a, max(a+1,b)):
                if index < len(starts): self.bar_notes[index].append(n)
        self.chords = shared.chords if shared else self.make_chords()
        self.chord_starts = [c['start'] for c in self.chords]

    def make_chords(self):
        # Combine piano parts (including separate hands); emit exactly one estimate per bar.
        piano={(p['track'],p['channel']) for p in self.parts if not p['drums'] and p['program']<8}
        weights=defaultdict(lambda:defaultdict(float));lows={}
        starts=[b['startTick'] for b in self.measures]
        for n in self.song.notes:
            if (n['track'],n['channel']) not in piano or n['endTick']<=n['startTick']:continue
            first=max(0,bisect_right(starts,n['startTick'])-1)
            last=min(len(starts),bisect_left(starts,n['endTick']))
            for k in range(first,last):
                bar=self.measures[k]
                overlap=min(n['endTick'],bar['endTick'])-max(n['startTick'],bar['startTick'])
                if overlap<=0:continue
                weights[k][n['pitch']%12]+=overlap*n['velocity']
                lows[k]=min(lows.get(k,127),n['pitch'])
        result=[]
        for k,bar in enumerate(self.measures):
            label,confidence=estimate(weights[k],lows.get(k,60))
            result.append(dict(start=bar['start'],end=min(bar['end'],self.song.duration),
                               label=label if piano else '?',confidence=confidence,measure=k))
        return result

    def public(self):
        return dict(parts=self.parts, scorePart=self.selected['id'] if self.selected else None,
                    measures=self.measures, chords=self.chords,
                    chordParts=[p['id'] for p in self.parts if not p['drums'] and p['program']<8])
    def measure_at(self,t):
        return max(0,min(len(self.measures)-1,bisect_right(self.bar_starts,t)-1))
    def chord_at(self,t):
        i=bisect_right(self.chord_starts,t)-1
        return self.chords[i] if i>=0 and t<self.chords[i]['end'] else dict(label='N.C.',confidence=0)
    def page_at(self,t,count=4):
        return self.measure_at(t)//count*count

    def bar_geometry(self,index,page,count):
        width=1680/count
        left=190+(index-page)*width
        change=index>page and any(self.measures[index][k]!=self.measures[index-1][k] for k in ('numerator','denominator'))
        return left+(36 if change else 0), left+width-(16 if count>1 else 0)

    def cursor(self,t,index,count=1):
        current=min(index+count-1,self.measure_at(t))
        current=max(index,current)
        b=self.measures[current]
        left,right=self.bar_geometry(current,index,count)
        fraction=min(1,max(0,(self.timeline.tick(t)-b['startTick'])/(b['endTick']-b['startTick'])))
        return left+fraction*(right-left)

    @lru_cache(maxsize=12)
    def score(self,index,count=1):
        if not 0 <= index < len(self.measures): raise ValueError('小節番号が不正です。')
        if not isinstance(count,int) or not 1<=count<=8: raise ValueError('表示小節数は1〜8で指定してください。')
        bars=self.measures[index:index+count]
        im=Image.new('RGB',(1920,SCORE_H),'#132127');d=ImageDraw.Draw(im)
        ink='#dce7e7';muted='#859f9f'
        font=ImageFont.truetype(str(FONT),40);small=ImageFont.load_default(size=17)
        def glyph(x,y,code): d.text((x,y),chr(code),font=font,fill=ink,anchor='ls')
        def text(x,y,value): d.text((x,y),value,font=small,fill=muted)
        text(28,12,'AUTO SCORE / 1/16 grid')
        text(360,12,f"MEASURES {index+1} - {index+len(bars)}")
        if self.selected: text(740,12,f"TRACK {self.selected['track']+1} / CH {self.selected['channel']+1}")
        else: text(740,12,'NO PITCHED PART')
        for bottom in (115,225):
            for j in range(5): d.line((28,bottom-j*10,1888,bottom-j*10),fill='#536b72',width=1)
            text(126,bottom-44,str(bars[0]['numerator']));text(126,bottom-21,str(bars[0]['denominator']))
        glyph(48,105,0xE050);glyph(48,195,0xE062)
        d.line((28,75,28,225),fill=muted,width=2)
        for bar in bars:
            bi=bar['index'];left,right=self.bar_geometry(bi,index,count)
            slot_left=190+(bi-index)*1680/count
            text(slot_left,43,str(bi+1))
            if left>slot_left:
                for bottom in (115,225):
                    text(slot_left,bottom-44,str(bar['numerator']));text(slot_left,bottom-21,str(bar['denominator']))
            self._draw_bar(d,bi,left,right,font,small)
            boundary=190+(bi-index+1)*1680/count
            for bottom in (115,225):d.line((boundary,bottom-40,boundary,bottom),fill=muted,width=2)
        text(1510,251,'MIDI transcription / simplified')
        return im

    def _draw_bar(self,d,index,left,right,font,small):
        bar=self.measures[index]
        ink='#dce7e7';muted='#859f9f';active='#9be7cb'
        def glyph(x,y,code,fill=ink):d.text((x,y),chr(code),font=font,fill=fill,anchor='ls')
        def text(x,y,value,fill=muted):d.text((x,y),value,font=small,fill=fill)
        grid=self.song.ppqn/4
        units=(bar['endTick']-bar['startTick'])/grid
        def xpos(u): return left+u/max(1,units)*(right-left)
        groups=defaultdict(list)
        for n in self.bar_notes[index]:
            start=max(0,round((n['startTick']-bar['startTick'])/grid))
            end=min(units,max(start+1,round((n['endTick']-bar['startTick'])/grid)))
            if start>=units: continue
            # Split at bar boundaries and express long/irregular values with ties.
            remaining=end-start;pos=start
            while remaining>0:
                length=next((v for v in (16,12,8,6,4,3,2,1) if v<=remaining+1e-6),1)
                length=min(length,remaining)
                groups[(pos,length,n['pitch']>=60)].append((n,pos>start or n['startTick']<bar['startTick'],pos+length<end or n['endTick']>bar['endTick']))
                pos+=length;remaining-=length
        occupied=defaultdict(list)
        accidental_state={}
        for (pos,length,treble),members in sorted(groups.items()):
            bottom=115 if treble else 225;x=xpos(pos)
            occupied[treble].append((pos,pos+length))
            ys=[]
            for n,tie_in,tie_out in members:
                pitch=n['pitch'];octave=0
                while pitch>79: pitch-=12;octave+=1
                while pitch<36: pitch+=12;octave-=1
                # C D E F G A B; explicit sharps with naturals on cancellation.
                degree=[0,0,1,1,2,3,3,4,4,5,5,6][pitch%12]+7*(pitch//12-1)
                y=bottom-(degree-(30 if treble else 18))*5
                ys.append(y)
                for ledger in range(bottom+10,math.ceil(y/10)*10+1,10): d.line((x-6,ledger,x+18,ledger),fill=muted,width=1)
                for ledger in range(bottom-50,math.floor(y/10)*10-1,-10): d.line((x-6,ledger,x+18,ledger),fill=muted,width=1)
                sharp=pitch%12 in (1,3,6,8,10)
                key=(treble,degree)
                if sharp: glyph(x-18,y,0xE262)
                elif accidental_state.get(key): glyph(x-18,y,0xE261)
                accidental_state[key]=sharp
                glyph(x,y,0xE0A2 if length>=16 else 0xE0A3 if length>=8 else 0xE0A4,active)
                if length in (3,6,12): d.ellipse((x+17,y-2,x+20,y+1),fill=ink)
                if octave: text(x-4,y-36,('8va' if octave==1 else '15ma') if octave>0 else ('8vb' if octave==-1 else '15mb'))
                if tie_in: d.arc((x-27,y+1,x+7,y+15),0,165,fill=active,width=2)
                if tie_out and min(right-4,xpos(pos+length)-5)>x+5: d.arc((x+5,y+1,min(right-4,xpos(pos+length)-5),y+15),15,180,fill=active,width=2)
            if ys and length<16:
                stemx=x+11;top=min(ys)-32
                d.line((stemx,top,stemx,max(ys)),fill=active,width=2)
                if length<=3: glyph(stemx,top,0xE242 if length<=1 else 0xE240,active)
        # Fill silent spans on each staff; fully silent bars use a whole rest.
        for treble,bottom in ((True,115),(False,225)):
            spans=sorted(occupied[treble]);cursor=0;gaps=[]
            for start,end in spans:
                if start>cursor:gaps.append((cursor,start))
                cursor=max(cursor,end)
            if cursor<units:gaps.append((cursor,units))
            if not spans:glyph((left+right)/2,bottom-30,0xE4E3);continue
            for start,end in gaps:
                while start<end-.01:
                    length=next((v for v in (16,8,4,2,1) if v<=end-start+.01),1)
                    code={16:0xE4E3,8:0xE4E4,4:0xE4E5,2:0xE4E6,1:0xE4E7}[length]
                    glyph(xpos(start),bottom-20,code,muted);start+=length


def score_height(part_count):
    return min(560, SCORE_H*part_count) if part_count else 100


class ScorePresentation:
    """The same multi-part page and coordinates feed Canvas and offline export."""
    def __init__(self,song,selected=None,count=4,legacy='auto'):
        if not isinstance(count,int) or not 1<=count<=8:
            raise ValueError('表示小節数は1〜8で指定してください。')
        if selected is not None and (not isinstance(selected,list) or any(not isinstance(p,str) for p in selected)):
            raise ValueError('楽譜のパート選択が不正です。')
        self.base=MusicAnalysis(song,selected[0] if selected else legacy if selected is None else 'auto')
        if selected is None:selected=[self.base.selected['id']] if self.base.selected else []
        available={p['id'] for p in self.base.parts if not p['drums']}
        if any(p not in available for p in selected):raise ValueError('楽譜には音程楽器のパートを選んでください。')
        # Stable MIDI order, independent of checkbox click order.
        self.selected=[p['id'] for p in self.base.parts if p['id'] in selected]
        self.count=count;self.height=score_height(len(self.selected))
        self.rows=[self.base if self.base.selected and part==self.base.selected['id'] else MusicAnalysis(song,part,shared=self.base) for part in self.selected]
    def public(self):
        data=self.base.public()
        data.update(scoreParts=self.selected,scoreMeasures=self.count,scoreHeight=self.height)
        data['measures']=[dict(b,page=b['index']//self.count*self.count,
                               xStart=self.base.bar_geometry(b['index'],b['index']//self.count*self.count,self.count)[0],
                               xEnd=self.base.bar_geometry(b['index'],b['index']//self.count*self.count,self.count)[1]) for b in self.base.measures]
        return data
    def page_at(self,t):return self.base.page_at(t,self.count)
    def cursor(self,t,page):return self.base.cursor(t,page,self.count)
    def chord_at(self,t):return self.base.chord_at(t)
    @lru_cache(maxsize=6)
    def score(self,page):
        if not 0<=page<len(self.base.measures) or page%self.count:
            raise ValueError('楽譜のページ番号が不正です。')
        im=Image.new('RGB',(1920,self.height),'#132127')
        if not self.rows:
            ImageDraw.Draw(im).text((40,35),'Select score parts in Studio settings',font=ImageFont.load_default(size=24),fill='#859f9f')
            return im
        for i,row in enumerate(self.rows):
            y0=round(i*self.height/len(self.rows));y1=round((i+1)*self.height/len(self.rows))
            image=row.score(page,self.count)
            if image.height!=y1-y0:image=image.resize((1920,y1-y0),Image.Resampling.LANCZOS)
            im.paste(image,(0,y0))
            if i:ImageDraw.Draw(im).line((0,y0,1920,y0),fill='#536b72',width=1)
        return im
    def cursors(self,t,page):
        x=self.cursor(t,page)
        return [(x,round((i*SCORE_H+48)*self.height/(len(self.rows)*SCORE_H)),
                 round((i*SCORE_H+245)*self.height/(len(self.rows)*SCORE_H))) for i in range(len(self.rows))]
