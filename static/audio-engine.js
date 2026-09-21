// Browser-side SoundFont synthesizer for realtime preview.
//
// Unlike the previous stem mixer, this engine does not ask Flask/TinySoundFont
// to render one full-song WAV per part.  It loads the selected SF2 once into a
// browser AudioWorklet and schedules MIDI events directly in the user's browser.
// Server-side TinySoundFont remains only for deterministic WAV/MP4 export.
//
// SpessaSynth is loaded lazily from jsDelivr so the rest of Piano Fall still
// opens even when the synth dependency cannot be reached.  For production the
// same pinned files can be bundled/self-hosted without changing this class.
const SPESSA_VERSION='4.3.14';
const SPESSA_MODULE=`https://cdn.jsdelivr.net/npm/spessasynth_lib@${SPESSA_VERSION}/+esm`;
// The processor is deliberately self-hosted from the same origin.
// SpessaSynth's documentation requires the processor file to match the library
// version and be registered with audioWorklet.addModule() before constructing
// WorkletSynthesizer. start.bat/setup.bat download the pinned file here.
const SPESSA_WORKLET='/static/vendor/spessasynth_processor.min.js';

function lowerBound(events,time){
  let lo=0,hi=events.length;
  while(lo<hi){const m=(lo+hi)>>1;if(Number(events[m].time)<time)lo=m+1;else hi=m;}
  return lo;
}

export class RealtimeAudioEngine {
  constructor({onProgress=()=>{},onState=()=>{}}={}) {
    this.onProgress=onProgress;
    this.onState=onState;
    this.context=null;
    this.synth=null;
    this.WorkletSynthesizer=null;
    this.workletLoaded=false;
    this.song=null;
    this.fontId='';
    this.fontUrl='';
    this.loadedFontId='';
    this.preparedSongId='';
    this.cfg=null;
    this.partToChannel=new Map();
    this.byOriginalChannel=new Map();
    this.events=[];
    this.eventIndex=0;
    this.timer=null;
    this.playing=false;
    this.startContextTime=0;
    this.startPosition=0;
    this.speed=1;
    this.masterMuted=false;
    this.prepareToken=0;
  }

  ensureContext(){
    if(this.context)return this.context;
    const Context=window.AudioContext||window.webkitAudioContext;
    if(!Context)throw new Error('このブラウザはWeb Audio APIに対応していません。');
    this.context=new Context({latencyHint:'interactive'});
    return this.context;
  }

  async unlock(){
    const ctx=this.ensureContext();
    if(ctx.state==='suspended')await ctx.resume();
  }

  async ensureLibrary(){
    if(this.WorkletSynthesizer)return;
    let module;
    try{module=await import(SPESSA_MODULE);}catch(e){
      throw new Error(`ブラウザ音源ライブラリを読み込めません。インターネット接続を確認してください (${e.message})`);
    }
    if(!module?.WorkletSynthesizer)throw new Error('ブラウザ音源ライブラリの形式が想定と異なります。');
    this.WorkletSynthesizer=module.WorkletSynthesizer;
  }

  async ensureWorklet(){
    const ctx=this.ensureContext();
    if(this.workletLoaded)return;
    try{
      // Register the exact processor file as a real same-origin module.
      // Do not wrap it in a Blob: WorkletSynthesizer expects the processor
      // shipped with the same spessasynth_lib version to have registered its
      // AudioWorkletProcessor before the synthesizer is constructed.
      await ctx.audioWorklet.addModule(`${SPESSA_WORKLET}?v=${SPESSA_VERSION}`);
      this.workletLoaded=true;
    }catch(e){
      throw new Error(`AudioWorkletを準備できません。start.batを再起動してブラウザを強制再読み込みしてください (${e.message})`);
    }
  }

  destroySynth(){
    this.stopScheduler();
    this.playing=false;
    if(this.synth){try{this.synth.stopAll(true);}catch{}try{this.synth.destroy();}catch{}}
    this.synth=null;
    this.loadedFontId='';
    this.preparedSongId='';
    this.partToChannel.clear();
    this.byOriginalChannel.clear();
  }

  configure(song,fontId,cfg,fontUrl=''){
    this.pause(0);
    const nextFont=fontId||'';
    if(nextFont!==this.fontId)this.destroySynth();
    this.song=song||null;
    this.fontId=nextFont;
    this.fontUrl=fontUrl||'';
    this.cfg=cfg||null;
    this.preparedSongId='';
    this.events=[];
    this.startPosition=0;
    this.onState();
  }

  setFont(fontId,cfg,fontUrl=''){
    const next=fontId||'';
    if(next!==this.fontId){this.configure(this.song,next,cfg,fontUrl);return;}
    this.cfg=cfg||this.cfg;
    this.fontUrl=fontUrl||this.fontUrl;
    this.syncMix(this.cfg);
  }

  isReady(){
    return !!(this.song&&this.fontId&&this.synth&&this.loadedFontId===this.fontId&&this.preparedSongId===this.song.id);
  }

  async ensureSynth(token){
    await this.unlock();
    await this.ensureLibrary();
    await this.ensureWorklet();
    if(token!==this.prepareToken)throw new Error('音源準備が更新されました。');
    if(this.synth&&this.loadedFontId===this.fontId)return;
    this.destroySynth();
    if(!this.fontUrl)throw new Error('ブラウザ用SoundFont URLがありません。アプリを再起動してください。');
    const synth=new this.WorkletSynthesizer(this.context,{eventsEnabled:false,oneOutput:true});
    this.onProgress(1,3,'SoundFontを読み込み中');
    let response;
    try{response=await fetch(this.fontUrl,{cache:'force-cache'});}catch(e){try{synth.destroy();}catch{};throw new Error(`SoundFontを取得できません (${e.message})`);}
    if(!response.ok){try{synth.destroy();}catch{};throw new Error(`SoundFontを取得できません (HTTP ${response.status})`);}
    const soundBank=await response.arrayBuffer();
    if(token!==this.prepareToken){try{synth.destroy();}catch{};throw new Error('音源準備が更新されました。');}
    this.onProgress(2,3,'SoundFontをブラウザに展開中');
    await synth.soundBankManager.addSoundBank(soundBank,'main');
    await synth.isReady;
    synth.setLogLevel(false,true,false);
    this.synth=synth;
    this.loadedFontId=this.fontId;
  }

  buildRouting(){
    const parts=this.song?.parts||[];
    this.partToChannel.clear();
    this.byOriginalChannel.clear();
    parts.forEach((part,index)=>{
      this.partToChannel.set(part.id,index);
      if(!this.byOriginalChannel.has(part.channel))this.byOriginalChannel.set(part.channel,[]);
      this.byOriginalChannel.get(part.channel).push(part);
    });
  }

  async ensureChannelCount(count){
    if(!this.synth)return;
    let current=Number(this.synth.channelCount||this.synth.midiChannels?.length||16);
    for(let i=current;i<count;i++)await this.synth.addNewChannel();
    const deadline=performance.now()+5000;
    while((this.synth.midiChannels?.length||0)<count&&performance.now()<deadline){
      await new Promise(r=>setTimeout(r,20));
    }
    if((this.synth.midiChannels?.length||0)<count)throw new Error(`MIDIパート数 (${count}) に必要な音源チャンネルを作れませんでした。`);
  }

  buildEvents(){
    // The server already parses the MIDI for visualization. Reusing those
    // parsed channel events keeps this migration small; later the raw MIDI can
    // be parsed in-browser as well, removing even this light server work.
    this.events=[...(this.song?.audioEvents||[])].sort((a,b)=>Number(a.time)-Number(b.time));
  }

  async prepareAll(cfg=this.cfg){
    if(!this.song||!this.fontId)throw new Error('SoundFontを選択してください。');
    const token=++this.prepareToken;
    this.cfg=cfg;
    this.onProgress(0,3,'ブラウザ音源を初期化中');
    await this.ensureSynth(token);
    if(token!==this.prepareToken)return;
    this.buildRouting();
    await this.ensureChannelCount((this.song.parts||[]).length);
    this.buildEvents();
    this.onProgress(3,3,'MIDIルーティングを準備中');
    this.preparedSongId=this.song.id;
    this.resetAt(0);
    this.syncMix(cfg);
    this.onState();
  }

  partsForOriginalChannel(ch){return this.byOriginalChannel.get(Number(ch))||[];}

  configurePart(part){
    if(!this.synth)return;
    const dest=this.partToChannel.get(part.id);
    if(dest===undefined)return;
    const channel=this.synth.midiChannels?.[dest];
    if(channel){
      try{channel.setDrums(!!part.drums);}catch{}
      try{channel.setSystemParameter('gain',Number(this.cfg?.partVolumes?.[part.id]??1));}catch{}
      try{channel.setSystemParameter('isMuted',new Set(this.cfg?.mutedTracks||[]).has(part.track));}catch{}
    }
    const override=this.cfg?.partPrograms?.[part.id];
    this.synth.programChange(dest,override===undefined?Number(part.program||0):Number(override));
  }

  resetAt(position=0){
    if(!this.synth||!this.song)return;
    this.stopScheduler();
    try{this.synth.stopAll(true);}catch{}
    try{this.synth.reset('gm');}catch{try{this.synth.reset();}catch{}}
    for(const part of this.song.parts||[])this.configurePart(part);
    this.applyMaster();
    // Rebuild controller/program/pitch state at the seek position without
    // replaying notes. Program overrides remain authoritative.
    const end=lowerBound(this.events,position);
    for(let i=0;i<end;i++){
      const event=this.events[i];
      if(event.type!=='note_on'&&event.type!=='note_off')this.dispatch(event,undefined,true);
    }
    // Restore notes that cross the seek point. Their Note Offs remain in the
    // event list and will be scheduled normally from this position onward.
    for(const note of this.song.notes||[]){
      if(note.start<position&&note.end>position){
        const dest=this.partToChannel.get(`${note.track}:${note.channel}`);
        if(dest!==undefined)this.synth.noteOn(dest,note.pitch,note.velocity);
      }
    }
    this.eventIndex=lowerBound(this.events,position);
    this.startPosition=Math.max(0,Number(position)||0);
    if(this.context)this.startContextTime=this.context.currentTime;
  }

  dispatch(event,when,restoring=false){
    if(!this.synth)return;
    const options=when===undefined?undefined:{time:when};
    const ch=Number(event.channel);
    const kind=event.type;
    if(kind==='note_on'||kind==='note_off'){
      const dest=this.partToChannel.get(`${event.track}:${ch}`);
      if(dest===undefined)return;
      if(kind==='note_on'&&Number(event.velocity)>0)this.synth.noteOn(dest,Number(event.note),Number(event.velocity),options);
      else this.synth.noteOff(dest,Number(event.note),options);
      return;
    }
    const parts=this.partsForOriginalChannel(ch);
    for(const part of parts){
      const dest=this.partToChannel.get(part.id);
      if(dest===undefined)continue;
      if(kind==='program_change'){
        if(this.cfg?.partPrograms?.[part.id]===undefined)this.synth.programChange(dest,Number(event.program),options);
      }else if(kind==='control_change'){
        this.synth.controllerChange(dest,Number(event.control),Number(event.value),options);
      }else if(kind==='pitchwheel'){
        this.synth.pitchWheel(dest,Math.max(0,Math.min(16383,Number(event.pitch)+8192)),options);
      }else if(kind==='aftertouch'&&this.synth.channelPressure){
        this.synth.channelPressure(dest,Number(event.value),options);
      }else if(kind==='polytouch'&&this.synth.polyPressure){
        this.synth.polyPressure(dest,Number(event.note),Number(event.value),options);
      }
    }
  }

  startScheduler(){
    this.stopScheduler();
    const tick=()=>{
      if(!this.playing||!this.context)return;
      const nowSong=this.position(this.startPosition);
      const wallLookahead=.09;
      const target=nowSong+wallLookahead*this.speed;
      const nowCtx=this.context.currentTime;
      while(this.eventIndex<this.events.length&&Number(this.events[this.eventIndex].time)<=target){
        const event=this.events[this.eventIndex++];
        if(Number(event.time)+.002<nowSong)continue;
        const when=nowCtx+Math.max(0,(Number(event.time)-nowSong)/this.speed);
        this.dispatch(event,when,false);
      }
    };
    tick();
    this.timer=setInterval(tick,20);
  }

  stopScheduler(){if(this.timer){clearInterval(this.timer);this.timer=null;}}

  applyMaster(){
    if(!this.synth)return;
    const gain=this.masterMuted?0:Number(this.cfg?.masterVolume??1.6);
    try{this.synth.setSystemParameter('gain',gain);}catch{}
  }

  syncMix(cfg=this.cfg){
    this.cfg=cfg||this.cfg;
    if(!this.synth||!this.song||!this.cfg)return;
    this.applyMaster();
    const muted=new Set(this.cfg.mutedTracks||[]);
    for(const part of this.song.parts||[]){
      const dest=this.partToChannel.get(part.id);
      const channel=this.synth.midiChannels?.[dest];
      if(!channel)continue;
      try{channel.setSystemParameter('gain',Number(this.cfg.partVolumes?.[part.id]??1));}catch{}
      try{channel.setSystemParameter('isMuted',muted.has(part.track));}catch{}
    }
  }

  setMasterMuted(muted){this.masterMuted=!!muted;this.applyMaster();}

  position(fallback=0){
    if(!this.playing||!this.context)return fallback;
    return this.startPosition+Math.max(0,this.context.currentTime-this.startContextTime)*this.speed;
  }

  async play(position=0,speed=1){
    if(!this.isReady())throw new Error('ブラウザ音源がまだ準備できていません。');
    await this.unlock();
    this.speed=Number(speed)||1;
    this.resetAt(position);
    this.startPosition=Math.max(0,Number(position)||0);
    this.startContextTime=this.context.currentTime;
    this.playing=true;
    this.startScheduler();
  }

  pause(fallback=0){
    const p=this.position(fallback);
    this.playing=false;
    this.stopScheduler();
    if(this.synth)try{this.synth.stopAll(true);}catch{}
    this.startPosition=p;
    return p;
  }

  async seek(position,speed=this.speed){
    const p=Math.max(0,Number(position)||0);
    this.speed=Number(speed)||1;
    const wasPlaying=this.playing;
    this.playing=false;
    this.resetAt(p);
    this.startPosition=p;
    if(this.context)this.startContextTime=this.context.currentTime;
    if(wasPlaying){this.playing=true;this.startScheduler();}
  }

  async setSpeed(speed,fallback=0){
    const p=this.position(fallback);
    this.speed=Number(speed)||1;
    const wasPlaying=this.playing;
    this.playing=false;
    this.resetAt(p);
    this.startPosition=p;
    if(this.context)this.startContextTime=this.context.currentTime;
    if(wasPlaying){this.playing=true;this.startScheduler();}
    return p;
  }

  async changeProgram(partId,cfg=this.cfg){
    this.cfg=cfg;
    if(!this.synth)return;
    const part=(this.song?.parts||[]).find(p=>p.id===partId);
    const dest=this.partToChannel.get(partId);
    if(!part||dest===undefined)return;
    const program=this.cfg?.partPrograms?.[partId];
    this.synth.programChange(dest,program===undefined?Number(part.program||0):Number(program));
    this.syncMix(cfg);
  }

  dispose(){
    this.prepareToken++;
    this.destroySynth();
    if(this.workletBlobUrl){try{URL.revokeObjectURL(this.workletBlobUrl);}catch{}this.workletBlobUrl='';}
    if(this.context)try{this.context.close();}catch{}
    this.context=null;
    this.workletLoaded=false;
  }
}
