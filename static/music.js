const $=id=>document.getElementById(id);
export function scoreHeight(cfg){const n=cfg.scoreParts?.length??1;return n?Math.min(560,280*n):100;}
export function musicOverlay({api,changed,notice}) {
  let song=null,data=null,version=0,query='';const images=new Map();
  const current=(items,t,key='start')=>{let lo=0,hi=items.length;while(lo<hi){const m=(lo+hi)>>1;if(items[m][key]<=t)lo=m+1;else hi=m;}return Math.max(0,lo-1);};
  function page(index){
    if(!data||index>=data.measures.length)return null;
    if(!images.has(index)){
      const im=new Image(),id=version;images.set(index,im);
      im.onload=()=>{if(id===version)changed();};im.onerror=()=>{if(id===version)notice('楽譜画像を読み込めません。パートを選択し直してください。',true);};
      im.src=`/api/score/${song.id}/${index}.png?${query}`;
      while(images.size>8)images.delete(images.keys().next().value);
    }
    return images.get(index);
  }
  async function load(nextSong,cfg){
    const id=++version;song=nextSong;data=null;images.clear();changed();
    query=new URLSearchParams({parts:(cfg.scoreParts||[]).join(','),measures:String(cfg.scoreMeasures)}).toString();
    try{
      const result=await api(`/api/music/${song.id}?${query}`);if(id!==version)return;
      data=result;page(0);page(data.scoreMeasures);changed();
      $('scoreStatus').textContent=data.scoreParts.length?`${data.scoreParts.length}パート・${data.scoreMeasures}小節ずつ表示。16分音符単位の簡易採譜です。`:'楽譜に表示するパートをチェックしてください。';
      $('chordStatus').textContent=data.chordParts.length?'ピアノパートから小節ごとに推定し、小節頭で切り替えます。':'MIDIの音色情報にピアノパートがないため、コードは「?」になります。';
    }catch(e){if(id===version){$('scoreStatus').textContent=e.message;notice(e.message,true);}}
  }
  function draw(ctx,t,cfg){
    const top=cfg.showScore?scoreHeight(cfg):0;
    if(cfg.showChords&&data){
      const c=data.chords[current(data.chords,t)],label=c&&t<c.end?c.label:'N.C.';
      ctx.fillStyle='rgba(9,17,23,.90)';ctx.beginPath();ctx.roundRect(28,top+110,237,111,10);ctx.fill();
      ctx.fillStyle='#80a29f';ctx.font='19px sans-serif';ctx.fillText('PIANO CHORD / EST.',46,top+143);
      ctx.fillStyle='#9be7cb';ctx.font='36px sans-serif';ctx.fillText(label,46,top+188);
    }
    if(!cfg.showScore)return;
    ctx.fillStyle='#132127';ctx.fillRect(0,0,1920,top);
    if(!data||!data.measures.length){ctx.fillStyle='#859f9f';ctx.font='22px sans-serif';ctx.fillText('Preparing score…',40,70);return;}
    const bar=data.measures[current(data.measures,t)],im=page(bar.page);page(bar.page+data.scoreMeasures);
    if(im?.complete&&im.naturalWidth)ctx.drawImage(im,0,0);
    const tempo=song.tempos[current(song.tempos,t,'time')];
    const tick=tempo.tick+(t-tempo.time)*song.ppqn*1e6/tempo.tempo;
    const x=bar.xStart+Math.min(1,Math.max(0,(tick-bar.startTick)/(bar.endTick-bar.startTick)))*(bar.xEnd-bar.xStart);
    const n=data.scoreParts.length;
    ctx.strokeStyle='rgba(119,228,200,.75)';ctx.lineWidth=3;
    for(let i=0;i<n;i++){ctx.beginPath();ctx.moveTo(x,Math.round((i*280+48)*top/(n*280)));ctx.lineTo(x,Math.round((i*280+245)*top/(n*280)));ctx.stroke();}
  }
  return {load,draw};
}
