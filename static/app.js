import {musicOverlay,scoreHeight} from './music.js';
import {programSelect} from './instruments.js';
import {setupLibrary} from './library.js';
import {RealtimeAudioEngine} from './audio-engine.js';
const $ = id => document.getElementById(id);
const canvas = $('piano'), ctx = canvas.getContext('2d');
const palette = ['#77e4c8','#ac9bff','#ffbd78','#78baff','#f18bb5','#e5db84','#86d78a','#f08d85'];
const sectionStateKey='pianofall.settings.sections';
function setupCollapsibleSettings(){
  let saved={};
  try{saved=JSON.parse(localStorage.getItem(sectionStateKey))||{};}catch{}
  for(const section of document.querySelectorAll('.collapsible-settings[data-settings-section]')){
    const key=section.dataset.settingsSection;
    if(Object.hasOwn(saved,key))section.open=!!saved[key];
    section.addEventListener('toggle',()=>{
      let state={};
      try{state=JSON.parse(localStorage.getItem(sectionStateKey))||{};}catch{}
      state[key]=section.open;
      localStorage.setItem(sectionStateKey,JSON.stringify(state));
    });
  }
}
const defaults = {background:'#10191e',colorMode:'track',colors:{},keyboardHeight:.22,fallSeconds:3.5,minPitch:21,maxPitch:108,hiddenTracks:[],mutedTracks:[],speed:1,fps:30,showScore:true,showChords:true,scorePart:'auto',scoreParts:null,scoreMeasures:4,partPrograms:{},partVolumes:{},masterVolume:1.6};
let cfg = structuredClone(defaults), song = null, playing = false, position = 0, anchor = 0, dirty = true;
let keyList = [], keyMap = new Map(), busy = null, audioReady = false, audioDirty = true, audioPreparing = false, masterMuted = false, noticeTimer;
const fontDetails=new Map();
let startupError=null;
let preparedNotes = [], starts = [], longest = 0;
try { const saved = JSON.parse(localStorage.getItem('pianofall.settings')); if(saved) cfg = {...defaults,...saved, hiddenTracks:[], mutedTracks:[],scorePart:'auto',scoreParts:null,partPrograms:{},partVolumes:{}}; } catch {}
if(!Number.isInteger(cfg.scoreMeasures)||cfg.scoreMeasures<1||cfg.scoreMeasures>8)cfg.scoreMeasures=4;
if(!Number.isFinite(Number(cfg.masterVolume))||cfg.masterVolume<0||cfg.masterVolume>3.2)cfg.masterVolume=1.6;
const music=musicOverlay({api,changed:()=>{dirty=true;},notice});
const clock = () => playing ? (audioReady ? audioEngine.position(position) : position+(performance.now()-anchor)/1000*cfg.speed) : position;
const duration = () => song ? song.duration+2 : 0;
const timeText = t => `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,error?10000:5000);}
async function api(url, options={}){const res=await fetch(url,options);let body;try{body=await res.json();}catch{throw new Error(`サーバー応答エラー (${res.status})`);}if(!res.ok)throw new Error(body.error||'処理に失敗しました');return body;}
const post = (url,body) => api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const audioEngine=new RealtimeAudioEngine({
  onProgress:(done,total,phase='ブラウザ音源を準備中')=>{
    if(audioPreparing){$('audioState').textContent=`● ${phase} ${done}/${total}`;}
  },
  onState:()=>{audioReady=audioEngine.isReady();audioDirty=!audioReady;updateAudioState();}
});
function persist(){try{localStorage.setItem('pianofall.settings',JSON.stringify(cfg));}catch{}dirty=true;}
function buildKeys(){
  const locations=[];let white=0;
  for(let p=0;p<128;p++){const black=[1,3,6,8,10].includes(p%12);locations.push({pitch:p,x:black?white-.31:white,width:black?.62:1,black});if(!black)white++;}
  keyList=locations.slice(cfg.minPitch,cfg.maxPitch+1);
  const left=Math.min(...keyList.map(k=>k.x)),right=Math.max(...keyList.map(k=>k.x+k.width)),scale=1920/(right-left);
  keyList=keyList.map(k=>({...k,x:(k.x-left)*scale,width:k.width*scale}));keyMap=new Map(keyList.map(k=>[k.pitch,k]));
  prepareNotes();dirty=true;
}
function prepareNotes(){preparedNotes=song?song.notes.filter(n=>!cfg.hiddenTracks.includes(n.track)&&keyMap.has(n.pitch)):[];starts=preparedNotes.map(n=>n.start);longest=preparedNotes.reduce((m,n)=>Math.max(m,n.end-n.start),0);}
function lowerBound(a,v){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m]<v)lo=m+1;else hi=m;}return lo;}
function color(n){const id=n[cfg.colorMode];return cfg.colors[`${cfg.colorMode}:${id}`]||palette[id%palette.length];}
function rect(x,y,w,h,r,fill){if(w<=0||h<=0)return;ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(x,y,w,h,Math.min(r,w/2,h/2));ctx.fill();}
function draw(t){
  const W=1920,H=1080,line=Math.round(H*(1-cfg.keyboardHeight)),top=song&&cfg.showScore?scoreHeight(cfg):0,scale=(line-top)/cfg.fallSeconds;
  ctx.fillStyle=cfg.background;ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(180,214,226,.06)';ctx.lineWidth=1;
  for(const k of keyList)if(!k.black){ctx.beginPath();ctx.moveTo(k.x,0);ctx.lineTo(k.x,line);ctx.stroke();}
  if(song){
    const beatTimes=song.beatTimes;
    for(let i=lowerBound(beatTimes,t);i<song.beats.length&&beatTimes[i]<=t+cfg.fallSeconds;i++){
      const b=song.beats[i],y=line-(b.time-t)*scale;ctx.strokeStyle=b.strong?'rgba(180,214,226,.13)':'rgba(180,214,226,.06)';ctx.lineWidth=b.strong?2:1;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();
    }
  }
  const active=new Map();
  for(let i=lowerBound(starts,t-longest);i<preparedNotes.length&&starts[i]<=t+cfg.fallSeconds;i++){
    const n=preparedNotes[i];if(n.end<=t)continue;
    const k=keyMap.get(n.pitch),y0=Math.max(top,line-(n.end-t)*scale),y1=Math.min(line,line-(n.start-t)*scale),c=color(n);
    if(y1>y0){rect(k.x+2,y0,k.width-4,y1-y0,5,c);ctx.fillStyle='rgba(255,255,255,.29)';ctx.fillRect(k.x+4,y0+2,2,Math.max(0,y1-y0-3));}
    if(n.start<=t&&t<n.end)active.set(n.pitch,c);
  }
  for(const black of [false,true])for(const k of keyList){if(k.black!==black)continue;
    const h=(H-line)*(black?.63:1),c=active.get(k.pitch)||(black?'#202b32':'#e8efed');rect(k.x+1,line,k.width-2,h-4,3,c);
    if(!black&&k.pitch%12===0){ctx.fillStyle='#5b696e';ctx.font='19px sans-serif';ctx.fillText(`C${Math.floor(k.pitch/12)-1}`,k.x+4,H-12);}
    if(active.has(k.pitch)){ctx.fillStyle=c;ctx.fillRect(k.x+1,line-5,k.width-2,9);}
  }
  ctx.fillStyle='rgba(119,228,200,.8)';ctx.fillRect(0,line,1920,3);
  if(song){
    const tempo=[...song.tempos].reverse().find(x=>x.time<=t)||song.tempos[0];const sig=[...song.signatures].reverse().find(x=>x.time<=t)||song.signatures[0];
    rect(28,top+24,237,69,10,'rgba(9,17,23,.86)');ctx.fillStyle='#dce7e7';ctx.font='25px sans-serif';ctx.fillText('PIANO FALL',46,top+57);ctx.fillStyle='#80a29f';ctx.font='19px sans-serif';ctx.fillText(`${Math.round(tempo.bpm*cfg.speed)} BPM  /  ${t.toFixed(1).padStart(5,'0')}s`,46,top+83);
    music.draw(ctx,t,cfg);
    $('tempo').textContent=`${Math.round(tempo.bpm*cfg.speed)} BPM`;$('meter').textContent=`${sig.numerator}/${sig.denominator}`;
  }
}
function frame(){if(playing||dirty){let t=Math.min(duration(),clock());if(playing&&t>=duration())pause();draw(t);$('seek').value=t;$('currentTime').textContent=timeText(t);dirty=false;}requestAnimationFrame(frame);}
function pause(){
  position=Math.min(duration(),clock());
  if(audioReady)position=Math.min(duration(),audioEngine.pause(position));
  playing=false;$('play').textContent='▶';$('play').setAttribute('aria-label','再生');dirty=true;
}
function seek(t){
  position=Math.max(0,Math.min(duration(),t));anchor=performance.now();
  if(audioReady&&playing)audioEngine.seek(position,cfg.speed).catch(e=>notice(e.message,true));
  dirty=true;
}
async function toggle(){
  if(!song||busy||audioPreparing)return;if(playing){pause();return;}
  if($('fontSelect').value&&audioDirty){try{await prepareAudio();}catch(e){notice(e.message,true);return;}}
  if(position>=duration()-.03)seek(0);
  if(audioReady){try{await audioEngine.play(position,cfg.speed);}catch(e){notice(e.message,true);return;}}
  anchor=performance.now();playing=true;$('play').textContent='Ⅱ';$('play').setAttribute('aria-label','一時停止');
}
function resetAudio(){
  pause();audioReady=false;audioDirty=true;audioPreparing=false;
  const fid=$('fontSelect').value;
  audioEngine.configure(song,fid,cfg,fontDetails.get(fid)?.browserUrl||'');
  updateAudioState();
}
function updateAudioState(){
  const font=$('fontSelect').value;
  if(!audioPreparing)$('audioState').textContent=audioReady?'● ブラウザ内SoundFont再生を準備済み':font?'音源を選択済み · 初回再生時にブラウザへSoundFontを読み込みます':'音声なしのプレビュー · .sf2を選ぶと音が付きます';
  $('prepareAudio').disabled=!song||!font||!!busy||audioPreparing;
  for(const id of ['export','exportTop'])$(id).disabled=!song||!font||!!busy;
  $('play').disabled=!song||!!busy||audioPreparing;
}
function renderTracks(){
  $('tracks').replaceChildren();const tracks=song?.tracks.filter(t=>t.count)||[];$('trackCount').textContent=`${tracks.length} TRACKS`;
  for(const t of tracks){
    const row=document.createElement('div');row.className='track';
    const controls=document.createElement('div');controls.className='track-controls';
    for(const [key,caption] of [['hiddenTracks','表示'],['mutedTracks','音声']]){
      const controlLabel=document.createElement('label');controlLabel.className='track-toggle';
      const toggle=document.createElement('input');toggle.type='checkbox';toggle.id=`${key}-${t.id}`;toggle.checked=!cfg[key].includes(t.id);toggle.disabled=!!busy;
      toggle.setAttribute('aria-label',`${t.name} の${caption}`);
      toggle.addEventListener('change',()=>{
        cfg[key]=toggle.checked?cfg[key].filter(x=>x!==t.id):[...cfg[key],t.id];
        if(key==='mutedTracks')audioEngine.syncMix(cfg);else prepareNotes();
        persist();
      });
      controlLabel.append(toggle,document.createTextNode(caption));controls.append(controlLabel);
    }
    const text=document.createElement('div');text.className='track-text';const label=document.createElement('span');label.className='track-name';label.textContent=t.name;
    const detail=document.createElement('small');detail.textContent=`CH ${t.channels.map(n=>n+1).join(', ')} · ${t.count.toLocaleString()} notes`;text.append(label,detail);
    const swatch=document.createElement('input');swatch.type='color';swatch.value=cfg.colors[`track:${t.id}`]||palette[t.id%8];swatch.setAttribute('aria-label',`${t.name} の色`);swatch.disabled=cfg.colorMode!=='track'||!!busy;
    swatch.addEventListener('input',()=>{cfg.colors[`track:${t.id}`]=swatch.value;persist();});row.append(text,controls,swatch);
    const mixer=document.createElement('div');mixer.className='part-mixer';
    for(const part of (song.parts||[]).filter(p=>p.track===t.id)){
      const panel=document.createElement('div');panel.className='part-row';
      const toneLabel=document.createElement('label');toneLabel.textContent=`CH ${part.channel+1} の音色`;
      const tone=programSelect(part,cfg.partPrograms[part.id],fontDetails.get($('fontSelect').value)?.drumkits||[]);tone.id=`program-${part.id}`;tone.setAttribute('aria-label',`${part.name} CH ${part.channel+1} の音色`);tone.disabled=!!busy;
      tone.onchange=()=>{if(tone.value==='')delete cfg.partPrograms[part.id];else cfg.partPrograms[part.id]=Number(tone.value);persist();if($('fontSelect').value){audioEngine.changeProgram(part.id,cfg).then(()=>{audioReady=audioEngine.isReady();audioDirty=!audioReady;updateAudioState();}).catch(e=>notice(`音色の変更に失敗しました: ${e.message}`,true));}};toneLabel.append(tone);
      const volLabel=document.createElement('label');volLabel.className='part-volume';
      const caption=document.createElement('span');caption.textContent='音量';const output=document.createElement('output');output.textContent=`${Math.round((cfg.partVolumes[part.id]??1)*100)}%`;
      const volume=document.createElement('input');volume.type='range';volume.min=0;volume.max=200;volume.step=5;volume.value=Math.round((cfg.partVolumes[part.id]??1)*100);volume.id=`volume-${part.id}`;volume.disabled=!!busy;volume.setAttribute('aria-label',`${part.name} CH ${part.channel+1} の音量`);
      volume.oninput=()=>{output.textContent=`${volume.value}%`;cfg.partVolumes[part.id]=Number(volume.value)/100;audioEngine.syncMix(cfg);};volume.onchange=()=>persist();volLabel.append(caption,output,volume);panel.append(toneLabel,volLabel);mixer.append(panel);
    }
    row.append(mixer);$('tracks').append(row);
  }
  $('channelColors').replaceChildren();$('channelColors').hidden=cfg.colorMode!=='channel';
  for(const ch of [...new Set(song?.notes.map(n=>n.channel)||[])].sort((a,b)=>a-b)){
    const label=document.createElement('label');label.textContent=`CH ${ch+1}`;const input=document.createElement('input');input.type='color';input.value=cfg.colors[`channel:${ch}`]||palette[ch%8];input.setAttribute('aria-label',`チャンネル ${ch+1} の色`);input.disabled=!!busy;input.oninput=()=>{cfg.colors[`channel:${ch}`]=input.value;persist();};label.append(input);$('channelColors').append(label);
  }
}
function updateScoreDownloadState(){
  $('downloadScore').disabled=!song||!(cfg.scoreParts||[]).length||!!busy;
}
function renderScoreParts(){
  const container=$('scoreParts');container.replaceChildren();
  const pitched=(song?.parts||[]).filter(p=>!p.drums);
  for(const part of pitched){
    const label=document.createElement('label');const input=document.createElement('input');input.type='checkbox';input.value=part.id;input.checked=(cfg.scoreParts||[]).includes(part.id);input.disabled=!!busy;input.id=`score-part-${part.id}`;
    const text=document.createElement('span');text.textContent=`${part.name} / CH ${part.channel+1}`;
    input.onchange=()=>{cfg.scoreParts=input.checked?[...(cfg.scoreParts||[]),part.id]:(cfg.scoreParts||[]).filter(x=>x!==part.id);music.load(song,cfg);persist();};
    label.append(input,text);container.append(label);
  }
  if(!pitched.length){const hint=document.createElement('span');hint.className='hint';hint.textContent=song?'音程のあるパートがありません。':'MIDIを読み込むと選択できます。';container.append(hint);}
  updateScoreDownloadState();
}
function syncSettings(){
  for(const id of ['showScore','showChords'])$(id).checked=cfg[id];$('scoreMeasures').value=cfg.scoreMeasures;renderScoreParts();
  $('masterVolume').value=Math.round(cfg.masterVolume/1.6*100);$('masterVolumeValue').textContent=`${Math.round(cfg.masterVolume/1.6*100)}%`;
  for(const id of ['background','colorMode','fallSeconds','minPitch','maxPitch','speed'])$(id).value=cfg[id];
  $('keyboardHeight').value=Math.round(cfg.keyboardHeight*100);$('keyboardValue').textContent=`${Math.round(cfg.keyboardHeight*100)}%`;$('fallValue').textContent=`${cfg.fallSeconds.toFixed(1)} 秒`;
  for(const fps of [30,60]){$(`fps${fps}`).classList.toggle('selected',cfg.fps===fps);$(`fps${fps}`).setAttribute('aria-pressed',cfg.fps===fps);}
  $('rangePreset').value=cfg.minPitch===21&&cfg.maxPitch===108?'88':'custom';buildKeys();if(song)renderTracks();persist();
}
function setBusy(id){
  busy=id;
  for(const el of document.querySelectorAll('.settings input,.settings select,.settings button,#importMidi,#chooseMidi,#sample,#reset,#importUrl,#openSavedMidi'))el.disabled=!!id;
  $('cancelJob').disabled=false;if(song)renderTracks();updateAudioState();updateScoreDownloadState();
}
async function loadSong(loader){
  if(startupError){notice(startupError,true);return;}
  if(busy){notice('処理が完了してからMIDIを変更してください。');return;}
  try{
    pause();$('notice').hidden=true;setBusy('midi');const result=await loader();song={...result,beatTimes:result.beats.map(b=>b.time)};position=0;cfg.hiddenTracks=[];cfg.mutedTracks=[];cfg.partPrograms={};cfg.partVolumes={};cfg.scorePart='auto';resetAudio();$('welcome').hidden=true;
    $('midiOrigin').hidden=false;$('saveMidi').href=song.midiUrl;$('saveMidi').download=song.name;$('midiSource').hidden=!song.sourceUrl;if(song.sourceUrl)$('midiSource').href=song.sourceUrl;
    const pitched=(song.parts||[]).filter(p=>!p.drums),piano=pitched.find(p=>p.program<8)||pitched[0];cfg.scoreParts=piano?[piano.id]:[];renderScoreParts();music.load(song,cfg);
    $('songName').textContent=song.name;$('songInfo').textContent=`${song.notes.length.toLocaleString()} notes · ${song.tracks.filter(t=>t.count).length} tracks · ${song.tempos.length} tempo events · PPQN ${song.ppqn}`;
    $('seek').max=duration();$('seek').disabled=false;$('restart').disabled=false;$('totalTime').textContent=timeText(duration());$('download').hidden=true;buildKeys();renderTracks();updateAudioState();dirty=true;
    if(song.warnings.length)notice(song.warnings.join(' '));
  }catch(e){notice(`MIDIを読み込めません: ${e.message}`,true);}finally{setBusy(null);}
}
async function uploadMidi(file){if(!file)return;const data=new FormData();data.append('file',file);await loadSong(()=>api('/api/midi',{method:'POST',body:data}));}
async function runJob(kind){
  if(busy)throw new Error('別の処理が進行中です。');
  pause();setBusy('starting');$('jobPanel').hidden=false;$('jobPhase').textContent='準備中';$('progress').value=0;$('jobPercent').textContent='0%';
  try{
    const start=await post('/api/jobs',{kind,songId:song.id,fontId:$('fontSelect').value,settings:cfg});busy=start.id;
    while(true){
      const job=await api(`/api/jobs/${start.id}`);$('jobPhase').textContent=job.phase;$('progress').value=job.progress;$('jobPercent').textContent=`${Math.round(job.progress*100)}%`;
      if(job.status==='complete')return job;
      if(job.status==='failed')throw new Error(job.error||'処理に失敗しました');
      if(job.status==='cancelled')throw new Error('処理をキャンセルしました。');
      await new Promise(resolve=>setTimeout(resolve,400));
    }
  }finally{setBusy(null);$('jobPanel').hidden=true;}
}
async function prepareAudio(){
  if(!song||!$('fontSelect').value)return;
  audioPreparing=true;updateAudioState();
  try{
    const fid=$('fontSelect').value;
    audioEngine.setFont(fid,cfg,fontDetails.get(fid)?.browserUrl||'');
    await audioEngine.prepareAll(cfg);
    audioReady=audioEngine.isReady();audioDirty=!audioReady;
    if(!audioReady)throw new Error('音色設定が準備中に変更されました。もう一度再生してください。');
  }finally{audioPreparing=false;updateAudioState();}
}
async function exportMovie(){if(!song||busy)return;try{$('download').hidden=true;const job=await runJob('video');$('download').href=job.url;$('download').download=job.filename;$('download').hidden=false;notice('音声付きMP4が完成しました。保存リンクからダウンロードできます。');}catch(e){notice(e.message,true);}}
$('play').onclick=toggle;$('restart').onclick=()=>seek(0);$('seek').oninput=()=>seek(Number($('seek').value));
$('speed').onchange=async()=>{const t=clock();cfg.speed=Number($('speed').value);position=t;anchor=performance.now();if(audioReady&&playing){try{position=await audioEngine.setSpeed(cfg.speed,t);}catch(e){notice(e.message,true);}}persist();};
$('mute').onclick=()=>{masterMuted=!masterMuted;audioEngine.setMasterMuted(masterMuted);$('mute').textContent=masterMuted?'×':'♪';$('mute').setAttribute('aria-label',masterMuted?'ミュート解除':'ミュート');};
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','BUTTON','TEXTAREA','A','SUMMARY'].includes(document.activeElement.tagName)){e.preventDefault();toggle();}});
for(const id of ['chooseMidi','importMidi'])$(id).onclick=()=>$('midiFile').click();
$('midiFile').onchange=async()=>{await uploadMidi($('midiFile').files[0]);$('midiFile').value='';};$('sample').onclick=()=>loadSong(()=>post('/api/sample',{}));
let dragDepth=0;const stage=$('dropZone');
for(const name of ['dragenter','dragover','dragleave','drop'])document.addEventListener(name,e=>e.preventDefault());
stage.addEventListener('dragenter',()=>{dragDepth++;stage.classList.add('drag');});stage.addEventListener('dragleave',()=>{if(--dragDepth<=0)stage.classList.remove('drag');});stage.addEventListener('drop',e=>{dragDepth=0;stage.classList.remove('drag');uploadMidi(e.dataTransfer.files[0]);});
function addFont(font){if(!font.browserUrl)font.browserUrl=`/api/files/soundfont/${font.id}.sf2`;fontDetails.set(font.id,font);if(![...$('fontSelect').options].some(o=>o.value===font.id))$('fontSelect').add(new Option(font.name,font.id));$('fontSelect').value=font.id;if(song)resetAudio();}
$('chooseFont').onclick=()=>$('fontFile').click();$('fontFile').onchange=async()=>{const file=$('fontFile').files[0];if(!file)return;try{setBusy('font');const data=new FormData();data.append('file',file);notice('SoundFontを読み込んでいます…');const font=await api('/api/soundfont',{method:'POST',body:data});addFont(font);notice('SoundFontを読み込みました。');}catch(e){notice(e.message,true);}finally{setBusy(null);$('fontFile').value='';}};
$('fontSelect').onchange=()=>{resetAudio();if(song)renderTracks();};$('prepareAudio').onclick=()=>prepareAudio().catch(e=>notice(e.message,true));
$('masterVolume').oninput=()=>{$('masterVolumeValue').textContent=`${$('masterVolume').value}%`;cfg.masterVolume=Number($('masterVolume').value)/100*1.6;audioEngine.syncMix(cfg);};
$('masterVolume').onchange=()=>persist();
for(const id of ['export','exportTop'])$(id).onclick=exportMovie;
$('cancelJob').onclick=async()=>{if(busy&&busy!=='starting'&&busy!=='font'){try{await post(`/api/jobs/${busy}/cancel`,{});$('cancelJob').disabled=true;}catch(e){notice(e.message,true);}}};
for(const fps of [30,60])$(`fps${fps}`).onclick=()=>{cfg.fps=fps;syncSettings();};
$('background').oninput=()=>{cfg.background=$('background').value;persist();};$('colorMode').onchange=()=>{cfg.colorMode=$('colorMode').value;renderTracks();persist();};
$('keyboardHeight').oninput=()=>{cfg.keyboardHeight=Number($('keyboardHeight').value)/100;$('keyboardValue').textContent=`${$('keyboardHeight').value}%`;persist();};$('fallSeconds').oninput=()=>{cfg.fallSeconds=Number($('fallSeconds').value);$('fallValue').textContent=`${cfg.fallSeconds.toFixed(1)} 秒`;persist();};
function setRange(lo,hi){if(!Number.isInteger(lo)||!Number.isInteger(hi)||lo<0||hi>127||lo>=hi){notice('鍵域は0〜127で、最低音より最高音を大きくしてください。',true);return false;}cfg.minPitch=lo;cfg.maxPitch=hi;syncSettings();return true;}
for(const id of ['minPitch','maxPitch'])$(id).onchange=()=>{if(!setRange(Number($('minPitch').value),Number($('maxPitch').value)))syncSettings();};
$('rangePreset').onchange=()=>{if($('rangePreset').value==='88')setRange(21,108);else if($('rangePreset').value==='auto'){if(!song){notice('先にMIDIを読み込んでください。');syncSettings();return;}const pitches=song.notes.filter(n=>!cfg.hiddenTracks.includes(n.track)).map(n=>n.pitch);if(!pitches.length){notice('表示するトラックがありません。');syncSettings();return;}let lo=127,hi=0;for(const p of pitches){lo=Math.min(lo,p);hi=Math.max(hi,p);}setRange(Math.max(0,lo-2),Math.min(127,hi+2));$('rangePreset').value='auto';}};
for(const id of ['showScore','showChords'])$(id).onchange=()=>{cfg[id]=$(id).checked;persist();};
$('scoreMeasures').onchange=()=>{const n=Number($('scoreMeasures').value);if(!Number.isInteger(n)||n<1||n>8){$('scoreMeasures').value=cfg.scoreMeasures;notice('表示小節数は1〜8で指定してください。',true);return;}cfg.scoreMeasures=n;if(song)music.load(song,cfg);persist();};
$('downloadScore').onclick=()=>{
  if(!song||!(cfg.scoreParts||[]).length||busy)return;
  const query=new URLSearchParams({parts:(cfg.scoreParts||[]).join(','),measures:String(cfg.scoreMeasures)});
  const link=document.createElement('a');link.href=`/api/score/${song.id}.pdf?${query}`;link.style.display='none';document.body.append(link);link.click();link.remove();
};
$('scoreAll').onclick=()=>{cfg.scoreParts=(song?.parts||[]).filter(p=>!p.drums).map(p=>p.id);renderScoreParts();if(song)music.load(song,cfg);persist();};
$('scoreNone').onclick=()=>{cfg.scoreParts=[];renderScoreParts();if(song)music.load(song,cfg);persist();};
$('reset').onclick=()=>{pause();cfg=structuredClone(defaults);resetAudio();syncSettings();if(song){const p=song.parts.filter(p=>!p.drums),first=p.find(p=>p.program<8)||p[0];cfg.scoreParts=first?[first.id]:[];renderScoreParts();music.load(song,cfg);}};
async function init(){
  setupCollapsibleSettings();
  setBusy('initializing');
  try{const status=await api('/api/status',{cache:'no-store'});
    if(status.apiVersion!==9)throw new Error('古いサーバーが動いています。起動用ターミナルをCtrl+Cで終了し、start.batで起動し直してから画面を更新してください。');
    setupLibrary({api,post,loadSong,notice,chooseFile:()=>$('midiFile').click(),isBusy:()=>!!busy});if(status.fonts.length){$('fontSelect').options[0].textContent='音声なし';for(const f of status.fonts)addFont(f);}syncSettings();setBusy(null);requestAnimationFrame(frame);
  }catch(e){startupError=`起動エラー: ${e.message}`;$('songInfo').textContent=startupError;$('audioState').textContent='サーバーの再起動が必要です';notice(startupError,true);}
}
init();
