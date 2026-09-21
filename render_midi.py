"""Optional CLI for unattended, reproducible exports."""
from pathlib import Path
import argparse
import json
import tempfile
from pianofall.midi import parse_midi
from pianofall.settings import settings
from pianofall.audio import synthesize
from pianofall.render import encode_video


def main():
    parser=argparse.ArgumentParser(description='MIDI + SF2 -> 1080p H.264/AAC MP4')
    parser.add_argument('midi',type=Path)
    parser.add_argument('--sf2',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=Path('movie.mp4'))
    parser.add_argument('--fps',type=int,choices=[30,60],default=30)
    parser.add_argument('--speed',type=float,default=1)
    parser.add_argument('--settings',type=Path,help='Optional JSON visual settings')
    parser.add_argument('--start',type=float,default=0,help='Start in original MIDI seconds')
    parser.add_argument('--end',type=float,help='End in original MIDI seconds')
    args=parser.parse_args()
    config=json.loads(args.settings.read_text(encoding='utf-8')) if args.settings else {}
    config=settings({**config,'fps':args.fps,'speed':args.speed})
    song=parse_midi(args.midi.read_bytes(),args.midi.name)
    end=args.end if args.end is not None else song.duration+2
    if not 0<=args.start<end<=song.duration+2:
        parser.error('start/end must lie inside the song duration + 2 seconds')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pianofall-') as tmp:
        wav=Path(tmp)/'audio.wav'
        print('Synthesizing SoundFont audio...',flush=True)
        synthesize(song,args.sf2,wav,config['mutedTracks'],programs=config['partPrograms'],volumes=config['partVolumes'],master_volume=config['masterVolume'])
        print('Rendering 1920x1080 video...',flush=True)
        encode_video(song,config,wav,args.output,lambda p:print(f'{p*100:.0f}%',flush=True),start=args.start,end=end)
    print(args.output.resolve())


if __name__=='__main__':
    main()
