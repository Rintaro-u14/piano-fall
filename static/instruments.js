// General MIDI program numbers are zero-based internally.
const groups=[
['Piano','Acoustic Grand|Bright Piano|Electric Grand|Honky-tonk|Electric Piano 1|Electric Piano 2|Harpsichord|Clavinet'],
['Chromatic Percussion','Celesta|Glockenspiel|Music Box|Vibraphone|Marimba|Xylophone|Tubular Bells|Dulcimer'],
['Organ','Drawbar Organ|Percussive Organ|Rock Organ|Church Organ|Reed Organ|Accordion|Harmonica|Tango Accordion'],
['Guitar','Nylon Guitar|Steel Guitar|Jazz Guitar|Clean Guitar|Muted Guitar|Overdriven Guitar|Distortion Guitar|Guitar Harmonics'],
['Bass','Acoustic Bass|Finger Bass|Pick Bass|Fretless Bass|Slap Bass 1|Slap Bass 2|Synth Bass 1|Synth Bass 2'],
['Strings','Violin|Viola|Cello|Contrabass|Tremolo Strings|Pizzicato Strings|Orchestral Harp|Timpani'],
['Ensemble','String Ensemble 1|String Ensemble 2|Synth Strings 1|Synth Strings 2|Choir Aahs|Voice Oohs|Synth Voice|Orchestra Hit'],
['Brass','Trumpet|Trombone|Tuba|Muted Trumpet|French Horn|Brass Section|Synth Brass 1|Synth Brass 2'],
['Reed','Soprano Sax|Alto Sax|Tenor Sax|Baritone Sax|Oboe|English Horn|Bassoon|Clarinet'],
['Pipe','Piccolo|Flute|Recorder|Pan Flute|Blown Bottle|Shakuhachi|Whistle|Ocarina'],
['Synth Lead','Square Lead|Saw Lead|Calliope Lead|Chiff Lead|Charang Lead|Voice Lead|Fifths Lead|Bass + Lead'],
['Synth Pad','New Age Pad|Warm Pad|Polysynth Pad|Choir Pad|Bowed Pad|Metallic Pad|Halo Pad|Sweep Pad'],
['Synth FX','Rain|Soundtrack|Crystal|Atmosphere|Brightness|Goblins|Echoes|Sci-fi'],
['Ethnic','Sitar|Banjo|Shamisen|Koto|Kalimba|Bagpipe|Fiddle|Shanai'],
['Percussive','Tinkle Bell|Agogo|Steel Drums|Woodblock|Taiko Drum|Melodic Tom|Synth Drum|Reverse Cymbal'],
['Sound Effects','Guitar Fret Noise|Breath Noise|Seashore|Bird Tweet|Telephone Ring|Helicopter|Applause|Gunshot']];
const names=groups.flatMap(g=>g[1].split('|'));
export function programSelect(part,value,drumkits=[]) {
  const select=document.createElement('select');
  select.add(new Option(`MIDIの音色 (${part.drums?'Drum Kit':names[part.program]})`,''));
  if(part.drums){for(const kit of drumkits)select.add(new Option(kit.name,String(kit.program)));}
  else groups.forEach(([group,items],g)=>{const opt=document.createElement('optgroup');opt.label=group;items.split('|').forEach((name,i)=>opt.append(new Option(`${g*8+i+1}. ${name}`,String(g*8+i))));select.append(opt);});
  if(value!==undefined&&![...select.options].some(o=>o.value===String(value)))select.add(new Option(`指定音色 ${value+1}（この音源では未収録）`,String(value)));
  select.value=value===undefined?'':String(value);
  return select;
}
