"use client";

import { UserButton } from "@clerk/nextjs";
import { Midi } from "@tonejs/midi";
import { useEffect, useRef, useState } from "react";

type Note = { id: string; start: number; end: number; pitch: number; velocity: number; track: number; channel: number };
type Track = { id: number; name: string; channel: number; program: number; count: number; drums: boolean };
type Song = { name: string; duration: number; notes: Note[]; tracks: Track[]; tempos: { time: number; bpm: number }[]; signatures: { time: number; numerator: number; denominator: number }[]; beats: { time: number; strong: boolean }[] };
type Settings = { background: string; colorMode: "track" | "channel"; colors: Record<string, string>; trackVolumes: Record<string, number>; keyboardHeight: number; fallSeconds: number; minPitch: number; maxPitch: number; speed: number; showScore: boolean; showChords: boolean; scoreMeasures: number; masterVolume: number };
type MidiSearchResult = { source: string; name: string; pageUrl: string; importUrl?: string };

const palette = ["#77e4c8", "#ac9bff", "#ffbd78", "#78baff", "#f18bb5", "#e5db84", "#86d78a", "#f08d85"];
const defaults: Settings = { background: "#10191e", colorMode: "track", colors: {}, trackVolumes: {}, keyboardHeight: .22, fallSeconds: 3.5, minPitch: 21, maxPitch: 108, speed: 1, showScore: true, showChords: true, scoreMeasures: 4, masterVolume: 1 };

function formatTime(value: number) {
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

function midiToFrequency(pitch: number) { return 440 * Math.pow(2, (pitch - 69) / 12); }

function parseMidi(buffer: ArrayBuffer, name: string): Song {
  const midi = new Midi(buffer);
  if (!midi.tracks.some((track) => track.notes.length)) throw new Error("発音するノートがありません。");
  const tracks: Track[] = midi.tracks.map((track, index) => ({
    id: index,
    name: track.name || `Track ${index + 1}`,
    channel: track.channel ?? 0,
    program: track.instrument?.number ?? 0,
    count: track.notes.length,
    drums: track.channel === 9,
  }));
  const notes: Note[] = midi.tracks.flatMap((track, trackIndex) => track.notes.map((note, noteIndex) => ({
    id: `${trackIndex}-${noteIndex}`,
    start: note.time,
    end: Math.max(note.time + .08, note.time + note.duration),
    pitch: note.midi,
    velocity: note.velocity,
    track: trackIndex,
    channel: track.channel ?? 0,
  }))).sort((a, b) => a.start - b.start);
  const duration = Math.max(midi.duration, ...notes.map((note) => note.end));
  const tempos = midi.header.tempos.length ? midi.header.tempos.map((tempo) => ({ time: tempo.time ?? midi.header.ticksToSeconds(tempo.ticks), bpm: tempo.bpm })) : [{ time: 0, bpm: 120 }];
  const signatures = midi.header.timeSignatures.length ? midi.header.timeSignatures.map((signature) => ({ time: midi.header.ticksToSeconds(signature.ticks), numerator: signature.timeSignature[0], denominator: signature.timeSignature[1] })) : [{ time: 0, numerator: 4, denominator: 4 }];
  const beats: { time: number; strong: boolean }[] = [];
  for (let time = 0, beat = 0; time <= duration + 1; time += 60 / (tempos.findLast((tempo) => tempo.time <= time)?.bpm ?? 120), beat += 1) beats.push({ time, strong: beat % 4 === 0 });
  return { name: name.replace(/\.(mid|midi)$/i, ""), duration, notes, tracks, tempos, signatures, beats };
}

function estimateChord(song: Song, time: number) {
  const start = Math.floor(time / 2) * 2;
  const notes = song.notes.filter((note) => note.start < start + 2 && note.end > start).map((note) => note.pitch % 12);
  if (notes.length < 3) return "N.C.";
  const counts = new Map<number, number>();
  notes.forEach((pitch) => counts.set(pitch, (counts.get(pitch) ?? 0) + 1));
  const root = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (root === undefined) return "?";
  const names = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const has = (interval: number) => notes.includes((root + interval) % 12);
  return `${names[root]}${has(3) ? "m" : has(4) && has(10) ? "7" : ""}`;
}

export default function PianoFallStudio({ userName }: { userName: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stateRef = useRef({ song: null as Song | null, settings: defaults, position: 0, playing: false, muted: false, hiddenTracks: new Set<number>(), busy: false });
  const positionRef = useRef(0);
  const startPositionRef = useRef(0);
  const playStartedRef = useRef(0);
  const lastUiUpdateRef = useRef(0);
  const scheduledRef = useRef(new Set<string>());
  const voicesRef = useRef(new Set<OscillatorNode>());
  const audioContextRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const trackGainRefs = useRef(new Map<number, GainNode>());
  const recordDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const [song, setSong] = useState<Song | null>(null);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [hiddenTracks, setHiddenTracks] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [midiQuery, setMidiQuery] = useState("");
  const [midiResults, setMidiResults] = useState<MidiSearchResult[]>([]);
  const [midiSearchStatus, setMidiSearchStatus] = useState("曲名・アーティスト名を入力してください。");
  const [midiSearching, setMidiSearching] = useState(false);
  const [midiImporting, setMidiImporting] = useState<string | null>(null);
  const midiSearchVersion = useRef(0);

  useEffect(() => {
    stateRef.current = { song, settings, position: positionRef.current, playing, muted, hiddenTracks, busy: exporting };
    const context = audioContextRef.current;
    if (context) {
      trackGainRefs.current.forEach((gain, trackId) => {
        gain.gain.setTargetAtTime(settings.trackVolumes[String(trackId)] ?? 1, context.currentTime, .015);
      });
    }
    try { localStorage.setItem("pianofall.settings", JSON.stringify(settings)); } catch { /* private browsing */ }
  }, [song, settings, playing, muted, hiddenTracks, exporting]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("pianofall.settings") || "null");
      if (saved) setSettings({ ...defaults, ...saved, colors: saved.colors || {}, trackVolumes: saved.trackVolumes || {} });
    } catch { /* malformed local settings */ }
  }, []);

  function showNotice(text: string, error = false) {
    setNotice({ text, error });
    window.setTimeout(() => setNotice(null), error ? 7000 : 4000);
  }

  function ensureAudio() {
    if (!audioContextRef.current) {
      const context = new AudioContext({ latencyHint: "interactive" });
      const master = context.createGain();
      master.gain.value = settings.masterVolume;
      master.connect(context.destination);
      audioContextRef.current = context;
      masterGainRef.current = master;
    }
    if (audioContextRef.current.state === "suspended") void audioContextRef.current.resume();
    return audioContextRef.current;
  }

  function trackGain(trackId: number) {
    const context = audioContextRef.current;
    const master = masterGainRef.current;
    if (!context || !master) return null;
    let gain = trackGainRefs.current.get(trackId);
    if (!gain) {
      gain = context.createGain();
      gain.gain.value = stateRef.current.settings.trackVolumes[String(trackId)] ?? 1;
      gain.connect(master);
      trackGainRefs.current.set(trackId, gain);
    }
    return gain;
  }

  function stopVoices() {
    voicesRef.current.forEach((voice) => { try { voice.stop(); voice.disconnect(); } catch { /* already stopped */ } });
    voicesRef.current.clear();
  }

  function playNote(note: Note, delay: number) {
    const context = audioContextRef.current;
    if (!context || !masterGainRef.current) return;
    if (stateRef.current.muted || stateRef.current.hiddenTracks.has(note.track)) return;
    const destination = trackGain(note.track);
    if (!destination) return;
    const start = context.currentTime + Math.max(0, delay);
    const length = Math.min(8, Math.max(.08, (note.end - note.start) / stateRef.current.settings.speed));
    const gain = context.createGain();
    const peak = Math.max(.015, Math.min(.18, note.velocity * .0017));
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + .012);
    gain.gain.exponentialRampToValueAtTime(.0001, start + length);
    gain.connect(destination);
    const oscillator = context.createOscillator();
    oscillator.type = "triangle";
    oscillator.frequency.value = midiToFrequency(note.pitch);
    oscillator.connect(gain);
    const overtone = context.createOscillator();
    const overtoneGain = context.createGain();
    overtone.type = "sine";
    overtone.frequency.value = midiToFrequency(note.pitch) * 2;
    overtoneGain.gain.value = .12;
    overtone.connect(overtoneGain).connect(gain);
    oscillator.start(start); overtone.start(start);
    oscillator.stop(start + length + .05); overtone.stop(start + length + .05);
    voicesRef.current.add(oscillator);
    oscillator.addEventListener("ended", () => { voicesRef.current.delete(oscillator); gain.disconnect(); overtoneGain.disconnect(); });
  }

  function scheduleAudio() {
    const current = currentPosition();
    const context = ensureAudio();
    const horizon = current + .22 * stateRef.current.settings.speed;
    stateRef.current.song?.notes.forEach((note) => {
      if (note.start >= current - .03 && note.start <= horizon && !scheduledRef.current.has(note.id)) {
        scheduledRef.current.add(note.id);
        playNote(note, Math.max(0, (note.start - current) / stateRef.current.settings.speed));
      }
    });
    if (context.state === "suspended") void context.resume();
  }

  function currentPosition() {
    if (!stateRef.current.playing) return positionRef.current;
    return Math.min(stateRef.current.song?.duration ?? 0, startPositionRef.current + (performance.now() - playStartedRef.current) / 1000 * stateRef.current.settings.speed);
  }

  function togglePlayback() {
    if (!song) return;
    if (playing) {
      const next = currentPosition();
      positionRef.current = next; setPosition(next); setPlaying(false); stopVoices();
      return;
    }
    ensureAudio();
    scheduledRef.current.clear();
    startPositionRef.current = positionRef.current;
    playStartedRef.current = performance.now();
    setPlaying(true);
  }

  function seek(next: number) {
    positionRef.current = Math.max(0, Math.min(song?.duration ?? 0, next));
    setPosition(positionRef.current);
    scheduledRef.current.clear(); stopVoices();
    if (playing) { startPositionRef.current = positionRef.current; playStartedRef.current = performance.now(); }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!stateRef.current.playing) return;
      scheduleAudio();
      const next = currentPosition();
      positionRef.current = next;
      if (next >= (stateRef.current.song?.duration ?? 0)) { setPlaying(false); stopVoices(); setPosition(0); positionRef.current = 0; scheduledRef.current.clear(); }
    }, 55);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let frame = 0;
    const render = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const current = currentPosition();
        drawCanvas(canvas, stateRef.current.song, stateRef.current.settings, current, stateRef.current.hiddenTracks);
        if (stateRef.current.playing && performance.now() - lastUiUpdateRef.current > 100) { lastUiUpdateRef.current = performance.now(); setPosition(current); }
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, []);

  async function loadFile(file: File): Promise<boolean> {
    if (!file.name.match(/\.(mid|midi)$/i)) { showNotice(".mid または .midi ファイルを選んでください。", true); return false; }
    try {
      const nextSong = parseMidi(await file.arrayBuffer(), file.name);
      stopVoices(); scheduledRef.current.clear(); positionRef.current = 0; setPosition(0); setPlaying(false);
      setHiddenTracks(new Set()); setSong(nextSong); updateSettings({ trackVolumes: {} });
      trackGainRefs.current.forEach((gain) => gain.disconnect()); trackGainRefs.current.clear();
      showNotice(`${nextSong.name} を読み込みました。`);
      return true;
    } catch (error) { showNotice(error instanceof Error ? error.message : "MIDIを読み込めませんでした。", true); return false; }
  }

  async function importSearchResult(item: MidiSearchResult) {
    if (exporting || midiImporting) return;
    setMidiImporting(item.pageUrl);
    setMidiSearchStatus(`「${item.name}」の MIDI を取得中…`);
    try {
      let midiBytes: ArrayBuffer | null = null;
      let filename = item.name;
      if (item.importUrl) {
        try {
          const directUrl = new URL(item.importUrl);
          if (directUrl.origin === "https://bitmidi.com" && /^\/uploads\/\d+\.midi?$/i.test(directUrl.pathname)) {
            const directResponse = await fetch(directUrl.toString(), { cache: "no-store" });
            if (directResponse.ok) {
              const bytes = await directResponse.arrayBuffer();
              if (new TextDecoder().decode(bytes.slice(0, 4)) === "MThd") midiBytes = bytes;
            }
          }
        } catch { /* use the server importer if direct CORS download is unavailable */ }
      }
      if (!midiBytes) {
        const response = await fetch("/api/midi-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: item.pageUrl, name: item.name }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(data?.error || "MIDIを取得できませんでした。別の候補をお試しください。");
        }
        const disposition = response.headers.get("content-disposition") ?? "";
        const encodedName = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
        if (encodedName) {
          try { filename = decodeURIComponent(encodedName.replace(/^"|"$/g, "")); } catch { filename = item.name; }
        }
        midiBytes = await response.arrayBuffer();
      }
      if (!/\.(mid|midi)$/i.test(filename)) filename += ".mid";
      const loaded = await loadFile(new File([midiBytes], filename, { type: "audio/midi" }));
      if (loaded) {
        setShowLibrary(false);
        setMidiSearchStatus(`${filename} を読み込み、動画プレビューと譜面を生成しました。動画ファイルは「動画を保存」から書き出せます。`);
        window.setTimeout(() => document.querySelector(".workspace")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
      } else setMidiSearchStatus("MIDIを読み込めませんでした。別の候補をお試しください。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "MIDIを取得できませんでした。";
      setMidiSearchStatus(message);
      showNotice(message, true);
    } finally {
      setMidiImporting(null);
    }
  }

  async function searchMidi(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = midiQuery.trim();
    const version = ++midiSearchVersion.current;
    if (!query) {
      setMidiResults([]);
      setMidiSearchStatus("曲名・アーティスト名を入力してください。");
      return;
    }
    if (query.length > 160) {
      setMidiSearchStatus("検索語は160文字以内にしてください。");
      return;
    }
    setMidiSearching(true);
    setMidiResults([]);
    setMidiSearchStatus("複数のMIDI配布サイトを横断検索中…");
    const otherSources = fetch(`/api/midi-search?q=${encodeURIComponent(query)}`, { cache: "no-store" }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "他の検索先を検索できませんでした。");
      return data as { results?: MidiSearchResult[]; providerErrors?: string[] };
    });
    const bitMidi = fetch(`https://bitmidi.com/api/midi/search?${new URLSearchParams({ q: query })}`, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("BitMidi を検索できませんでした。");
      const data = await response.json();
      const rows = (data.result?.results ?? []).filter((row: { name?: string; slug?: string; url?: string; downloadUrl?: string }) => row?.name && row?.downloadUrl && (row.slug || row.url));
      return rows.map((row: { name?: string; slug?: string; url?: string; downloadUrl?: string }) => ({
        source: "BitMidi",
        name: row.name || "Untitled.mid",
        pageUrl: new URL(row.url || `/${row.slug}`, "https://bitmidi.com").toString(),
        importUrl: row.downloadUrl ? new URL(row.downloadUrl, "https://bitmidi.com").toString() : undefined,
      } satisfies MidiSearchResult));
    });
    const [otherResults, bitMidiResults] = await Promise.allSettled([otherSources, bitMidi]);
    if (version === midiSearchVersion.current) {
      const results: MidiSearchResult[] = [];
      const failedSources: string[] = [];
      if (bitMidiResults.status === "fulfilled") results.push(...bitMidiResults.value);
      else failedSources.push("BitMidi");
      if (otherResults.status === "fulfilled") {
        results.push(...(otherResults.value.results ?? []));
        failedSources.push(...(otherResults.value.providerErrors ?? []));
      } else failedSources.push("その他の検索先");
      const seenNames = new Set<string>();
      const uniqueResults = results.filter((item) => {
        const key = item.name.normalize("NFKC").toLocaleLowerCase().replace(/\.(?:mid|midi)$/i, "").trim();
        if (seenNames.has(key)) return false;
        seenNames.add(key);
        return true;
      });
      setMidiResults(uniqueResults);
      const uniqueFailures = [...new Set(failedSources)].map((source) => source === "Midi uploader.jp" ? "uploader.jp" : source);
      const partial = uniqueFailures.length ? `（応答なし: ${uniqueFailures.join("、")}）` : "";
      setMidiSearchStatus(uniqueResults.length ? `「${query}」: ${uniqueResults.length}件の候補 ${partial}` : uniqueFailures.length ? `検索結果を取得できませんでした ${partial}。別のキーワードもお試しください。` : `「${query}」の候補は見つかりませんでした。`);
    }
    if (version === midiSearchVersion.current) setMidiSearching(false);
  }

  async function loadSample() {
    try {
      const response = await fetch("/samples/Aurora_Study.mid");
      if (!response.ok) throw new Error("サンプルを読み込めませんでした。");
      await loadFile(new File([await response.arrayBuffer()], "Aurora_Study.mid"));
    } catch (error) { showNotice(error instanceof Error ? error.message : "サンプルを読み込めませんでした。", true); }
  }

  async function handleExport() {
    if (!song || exporting) return;
    try {
      const context = ensureAudio();
      const canvas = canvasRef.current;
      if (!canvas || !canvas.captureStream) throw new Error("このブラウザは動画保存に対応していません。");
      setExporting(true); setPlaying(false); stopVoices(); scheduledRef.current.clear(); seek(0);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const fps = 30;
      const canvasStream = canvas.captureStream(fps);
      const destination = context.createMediaStreamDestination();
      recordDestinationRef.current = destination;
      masterGainRef.current?.connect(destination);
      const stream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
      const mimeType = MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.42E01E,mp4a.40.2") ? "video/mp4;codecs=avc1.42E01E,mp4a.40.2" : "video/webm;codecs=vp9,opus";
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.start(250);
      startPositionRef.current = 0; playStartedRef.current = performance.now(); scheduledRef.current.clear(); setPlaying(true);
      await new Promise((resolve) => window.setTimeout(resolve, (song.duration / settings.speed + .7) * 1000));
      setPlaying(false); stopVoices(); recorder.stop(); await stopped;
      const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
      const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(chunks, { type: mimeType })); link.download = `${song.name || "piano-fall"}.${extension}`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      masterGainRef.current?.disconnect(destination); recordDestinationRef.current = null;
      showNotice(`${extension.toUpperCase()}を書き出しました。`);
    } catch (error) { showNotice(error instanceof Error ? error.message : "動画を書き出せませんでした。", true); }
    finally { setExporting(false); setPlaying(false); }
  }

  function updateSettings(change: Partial<Settings>) { setSettings((current) => ({ ...current, ...change })); }
  function toggleTrack(trackId: number) { setHiddenTracks((current) => { const next = new Set(current); next.has(trackId) ? next.delete(trackId) : next.add(trackId); return next; }); }
  function updateColor(id: string, value: string) { updateSettings({ colors: { ...settings.colors, [id]: value } }); }

  const activeTempo = song ? [...song.tempos].reverse().find((tempo) => tempo.time <= position) ?? song.tempos[0] : null;
  const activeSignature = song ? [...song.signatures].reverse().find((signature) => signature.time <= position) ?? song.signatures[0] : null;

  return (
    <>
      <header className="topbar">
        <a className="brand" href="/"><span className="brand-icon">▥</span>PIANO FALL <span className="edition">BROWSER STUDIO</span></a>
        <div className="top-actions"><button className="outline-button" onClick={() => setShowLibrary((current) => !current)}>⌕ MIDIを探す</button><span className="local-dot">ブラウザで処理</span><button className="primary-button" disabled={!song || exporting} onClick={handleExport}>↗ 動画を保存</button><UserButton /></div>
      </header>
      <main className="main">
        <div className="intro"><div><div className="eyebrow">MIDI → PIANO MOVIE</div><h1>音を、眺めよう。</h1><p>MIDIを読み込んで、自分だけのピアノ動画に。</p></div><span className="format-badge">ブラウザ完結 <span>•</span> Web Audio + Canvas</span></div>
        {showLibrary && <section className="track-panel midi-library"><div className="section-head"><div><div className="eyebrow">MIDI SOURCES</div><h2>MIDIをまとめて検索</h2></div><button className="text-button" onClick={() => setShowLibrary(false)}>閉じる</button></div><p className="hint">曲名やアーティスト名を入力すると複数の配布サイトを一度に検索します。候補のボタンから MIDI を読み込むと、動画プレビューと譜面を表示します。</p><form className="midi-search-form" onSubmit={searchMidi}><label htmlFor="midiQuery">曲名・アーティスト名</label><div className="midi-search-row"><input id="midiQuery" type="search" maxLength={160} value={midiQuery} onChange={(event) => { setMidiQuery(event.target.value); midiSearchVersion.current += 1; setMidiSearching(false); setMidiResults([]); setMidiSearchStatus("Enterまたは「MIDIを検索」で横断検索します。"); }} placeholder="例: Beethoven / 月光 / 曲名" autoComplete="off" /><button className="primary-button" type="submit" disabled={midiSearching || !!midiImporting}>{midiSearching ? "検索中…" : "MIDIを検索"}</button></div></form><p className="hint" aria-live="polite">{midiSearchStatus}</p>{midiResults.length > 0 && <div className="midi-search-results">{midiResults.map((item) => <article className="midi-search-result" key={`${item.source}:${item.pageUrl}`}><div><strong>{item.name}</strong><span>{item.source}</span></div><button className="primary-button midi-load-button" type="button" disabled={!!midiImporting || exporting} onClick={() => void importSearchResult(item)}>{midiImporting === item.pageUrl ? "取得して読み込み中…" : "＋ MIDIを読み込む"}</button></article>)}</div>}<div className="midi-search-import"><span className="hint">配布サイトの利用条件をご確認ください。</span><button className="outline-button" onClick={() => fileRef.current?.click()}>＋ MIDIファイルを開く</button></div><p className="hint">検索先: BitMidi / MIDI World / MidisFree / MIDI DB / uploader.jp</p></section>}
        <div className="workspace">
          <section className="editor">
            <div className="scene-top"><div className="song-title"><span className="song-icon">♫</span><div><strong>{song?.name ?? "新しいセッション"}</strong><small>{song ? `${song.notes.length} notes · ${formatTime(song.duration)}` : "まずはMIDIを読み込んでください"}</small></div></div><span className="preview-badge">LIVE PREVIEW</span></div>
            <div className={`stage${dragging ? " dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void loadFile(file); }}>
              <canvas ref={canvasRef} width={1920} height={1080} aria-label="落下するノートとピアノ鍵盤" />
              {!song && <div className="welcome"><div className="upload-icon">↥</div><h2>MIDIから、動き出す。</h2><p>ファイルをここにドラッグ＆ドロップ</p><button className="primary-button" onClick={() => fileRef.current?.click()}>MIDIファイルを選ぶ</button><button className="text-button" onClick={() => void loadSample()}>または、サンプルを試す →</button><small>.mid / .midi · 複数トラック対応</small></div>}
            </div>
            <div className="transport"><div className="timeline"><span>{formatTime(position)}</span><input type="range" min="0" max={song?.duration ?? 1} step="0.01" value={position} disabled={!song} onChange={(event) => seek(Number(event.target.value))} /><span>{formatTime(song?.duration ?? 0)}</span></div><div className="transport-row"><div className="play-controls"><button className="icon-button" disabled={!song} onClick={() => seek(0)} aria-label="先頭へ">↶</button><button className="play-button" disabled={!song} onClick={togglePlayback} aria-label={playing ? "停止" : "再生"}>{playing ? "Ⅱ" : "▶"}</button><button className="outline-button" onClick={() => fileRef.current?.click()}>＋ MIDIを開く</button></div><div className="play-meta"><span>{activeTempo ? `${Math.round(activeTempo.bpm * settings.speed)} BPM` : "— BPM"}</span><span className="separator" /><span>{activeSignature ? `${activeSignature.numerator}/${activeSignature.denominator}` : "4/4"}</span><select aria-label="再生速度" value={settings.speed} onChange={(event) => updateSettings({ speed: Number(event.target.value) })}>{[.25, .5, .75, 1, 1.25, 1.5, 2].map((speed) => <option key={speed} value={speed}>{speed.toFixed(2)}×</option>)}</select><span className="separator" /><label className="transport-volume">VOL <input type="range" min="0" max="2" step=".05" value={settings.masterVolume} onChange={(event) => { const value = Number(event.target.value); updateSettings({ masterVolume: value }); if (masterGainRef.current) masterGainRef.current.gain.value = value; }} /><output>{Math.round(settings.masterVolume * 100)}%</output></label><button className="icon-button" onClick={() => setMuted((current) => !current)} aria-label="ミュート">{muted ? "×" : "♪"}</button></div></div></div>
            <div className="below-preview"><span><span className="status-dot" />Web Audioのブラウザピアノ</span><span>SPACE 再生 / 停止</span></div>
            <div className="track-panel"><div className="section-head"><h2>トラック</h2><span className="track-count">{song ? `${song.tracks.length} TRACKS` : "0 TRACKS"}</span></div><div className="track-list">{song ? song.tracks.map((track) => { const trackVolume = settings.trackVolumes[String(track.id)] ?? 1; return <div className="track-row" key={track.id}><span className="track-color" style={{ background: settings.colors[`track:${track.id}`] || palette[track.id % palette.length] }} /><div><div className="track-name">{track.name}</div><div className="track-detail">{track.drums ? "Drums" : `CH ${track.channel + 1} · Program ${track.program + 1}`} · {track.count} notes</div></div><div className="track-controls"><label>表示 <input type="checkbox" checked={!hiddenTracks.has(track.id)} onChange={() => toggleTrack(track.id)} /></label><label>色 <input type="color" value={settings.colors[`track:${track.id}`] || palette[track.id % palette.length]} onChange={(event) => updateColor(`track:${track.id}`, event.target.value)} /></label></div><label className="track-volume"><span>音量 <output>{Math.round(trackVolume * 100)}%</output></span><input type="range" min="0" max="200" step="5" value={Math.round(trackVolume * 100)} aria-label={`${track.name}の音量`} onChange={(event) => updateSettings({ trackVolumes: { ...settings.trackVolumes, [String(track.id)]: Number(event.target.value) / 100 } })} /></label></div>; }) : <p className="empty">読み込んだMIDIのパートがここに表示されます。</p>}</div><p className="hint">トラックごとに表示・色・音量を調整できます。音量は再生と書き出し動画の両方に反映されます。</p></div>
          </section>
          <aside className="settings"><div className="settings-title"><h2>スタジオ設定</h2><button className="text-button" onClick={() => { setSettings(defaults); setHiddenTracks(new Set()); }}>リセット</button></div>
            <details className="settings-section" open><summary><span><span className="eyebrow">01 / APPEARANCE</span><strong>映像</strong></span><span className="chevron">⌄</span></summary><div className="settings-body"><label className="setting-line">背景色 <input type="color" value={settings.background} onChange={(event) => updateSettings({ background: event.target.value })} /></label><label className="setting-line">ノートの色分け <select value={settings.colorMode} onChange={(event) => updateSettings({ colorMode: event.target.value as Settings["colorMode"] })}><option value="track">トラック別</option><option value="channel">チャンネル別</option></select></label><label className="setting-line">鍵盤の高さ <span className="range-output">{Math.round(settings.keyboardHeight * 100)}%</span></label><input type="range" min=".12" max=".4" step=".01" value={settings.keyboardHeight} onChange={(event) => updateSettings({ keyboardHeight: Number(event.target.value) })} /><label className="setting-line">落下の見通し <span className="range-output">{settings.fallSeconds.toFixed(1)} 秒</span></label><input type="range" min="1" max="10" step=".1" value={settings.fallSeconds} onChange={(event) => updateSettings({ fallSeconds: Number(event.target.value) })} /><label className="setting-line">最低音 <input type="number" min="0" max="126" value={settings.minPitch} onChange={(event) => updateSettings({ minPitch: Number(event.target.value) })} /></label><label className="setting-line">最高音 <input type="number" min="1" max="127" value={settings.maxPitch} onChange={(event) => updateSettings({ maxPitch: Number(event.target.value) })} /></label></div></details>
            <details className="settings-section" open><summary><span><span className="eyebrow">02 / SCORE & CHORDS</span><strong>楽譜・推定コード</strong></span><span className="chevron">⌄</span></summary><div className="settings-body"><label className="setting-line">上部に楽譜を表示 <input type="checkbox" checked={settings.showScore} onChange={(event) => updateSettings({ showScore: event.target.checked })} /></label><label className="setting-line">同時に表示する小節数 <input type="number" min="1" max="8" value={settings.scoreMeasures} onChange={(event) => updateSettings({ scoreMeasures: Math.max(1, Math.min(8, Number(event.target.value))) })} /></label><label className="setting-line">左端に推定コードを表示 <input type="checkbox" checked={settings.showChords} onChange={(event) => updateSettings({ showChords: event.target.checked })} /></label><p className="hint">ブラウザ版では簡易スタッフ表示と、現在位置周辺の音から推定したコードを表示します。</p></div></details>
            <details className="settings-section" open><summary><span><span className="eyebrow">03 / AUDIO</span><strong>ブラウザ音源</strong></span><span className="chevron">⌄</span></summary><div className="settings-body"><p className="hint">SoundFontやサーバーを使わず、Web Audio APIでピアノ風の音を合成します。読み込んだMIDIと設定は外部へ送信しません。</p><button className="outline-button full" onClick={() => { ensureAudio(); showNotice("ブラウザ音源を準備しました。"); }}>♪ 音源を準備</button></div></details>
            <details className="settings-section" open><summary><span><span className="eyebrow">04 / EXPORT</span><strong>動画を書き出す</strong></span><span className="chevron">⌄</span></summary><div className="settings-body"><div className="export-spec"><strong>Canvas</strong><span>1920 × 1080 / 30 fps</span></div><button className="primary-button full" disabled={!song || exporting} onClick={handleExport}>{exporting ? "リアルタイムで書き出し中…" : "↗ 動画を保存"}</button><p className="hint">ブラウザの対応形式に応じてMP4またはWebMを、再生時間と同じ速度で保存します。</p></div></details>
          </aside>
        </div>
        <footer><span>PIANO FALL <span className="muted">/</span> MIDI MOVIE STUDIO</span><span>Googleアカウント限定 · ブラウザ音源 · ローカル処理</span></footer>
      </main>
      <input ref={fileRef} type="file" accept=".mid,.midi" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadFile(file); event.target.value = ""; }} />
      {notice && <div className={`notice${notice.error ? " error" : ""}`} role="status">{notice.text}</div>}
    </>
  );
}

function drawCanvas(canvas: HTMLCanvasElement, song: Song | null, settings: Settings, time: number, hiddenTracks: Set<number>) {
  const ctx = canvas.getContext("2d"); if (!ctx) return;
  const W = 1920, H = 1080; const line = Math.round(H * (1 - settings.keyboardHeight)); const scoreHeight = song && settings.showScore ? 155 : 0; const top = scoreHeight; const scale = (line - top) / settings.fallSeconds;
  ctx.clearRect(0, 0, W, H); ctx.fillStyle = settings.background; ctx.fillRect(0, 0, W, H);
  const minPitch = Math.max(0, Math.min(126, settings.minPitch)); const maxPitch = Math.max(minPitch + 1, Math.min(127, settings.maxPitch));
  const whiteKeys = Array.from({ length: maxPitch - minPitch + 1 }, (_, index) => minPitch + index).filter((pitch) => ![1, 3, 6, 8, 10].includes(pitch % 12));
  const noteColor = (note: Note) => { const id = settings.colorMode === "track" ? note.track : note.channel; return settings.colors[`${settings.colorMode}:${id}`] || palette[id % palette.length]; };
  const keyWidth = W / whiteKeys.length; const keyPosition = (pitch: number) => { const whiteIndex = whiteKeys.indexOf(pitch); if (whiteIndex >= 0) return { x: whiteIndex * keyWidth, width: keyWidth, black: false }; const before = whiteKeys.filter((value) => value < pitch).length; return { x: before * keyWidth - keyWidth * .32, width: keyWidth * .64, black: true }; };
  ctx.strokeStyle = "rgba(180,214,226,.06)"; ctx.lineWidth = 1; whiteKeys.forEach((pitch) => { const key = keyPosition(pitch); ctx.beginPath(); ctx.moveTo(key.x, 0); ctx.lineTo(key.x, line); ctx.stroke(); });
  if (song) {
    song.beats.filter((beat) => beat.time >= time && beat.time <= time + settings.fallSeconds).forEach((beat) => { const y = line - (beat.time - time) * scale; ctx.strokeStyle = beat.strong ? "rgba(180,214,226,.15)" : "rgba(180,214,226,.06)"; ctx.lineWidth = beat.strong ? 2 : 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); });
    song.notes.filter((note) => !hiddenTracks.has(note.track) && note.pitch >= minPitch && note.pitch <= maxPitch && note.end >= time && note.start <= time + settings.fallSeconds).forEach((note) => { const key = keyPosition(note.pitch); const y0 = Math.max(top, line - (note.end - time) * scale); const y1 = Math.min(line, line - (note.start - time) * scale); if (y1 > y0) { ctx.fillStyle = noteColor(note); ctx.beginPath(); ctx.roundRect(key.x + 2, y0, key.width - 4, y1 - y0, 5); ctx.fill(); ctx.fillStyle = "rgba(255,255,255,.3)"; ctx.fillRect(key.x + 4, y0 + 2, 2, Math.max(0, y1 - y0 - 3)); } });
    drawScore(ctx, song, settings, time, scoreHeight);
  }
  const active = new Map<number, string>();
  song?.notes.filter((note) => !hiddenTracks.has(note.track) && note.start <= time && note.end > time).forEach((note) => active.set(note.pitch, noteColor(note)));
  ctx.fillStyle = "rgba(119,228,200,.85)"; ctx.fillRect(0, line, W, 3);
  [false, true].forEach((black) => { for (let pitch = minPitch; pitch <= maxPitch; pitch += 1) { const key = keyPosition(pitch); if (key.black !== black) continue; const keyBedHeight = H - line; const keyHeight = black ? keyBedHeight * .62 : keyBedHeight; ctx.fillStyle = active.get(pitch) || (black ? "#202b32" : "#e8efed"); ctx.beginPath(); ctx.roundRect(key.x + 1, line, key.width - 2, keyHeight - (black ? 5 : 8), 3); ctx.fill(); if (!black && pitch % 12 === 0) { ctx.fillStyle = "#5b696e"; ctx.font = "19px sans-serif"; ctx.fillText(`C${Math.floor(pitch / 12) - 1}`, key.x + 4, H - 12); } } });
}

function drawScore(ctx: CanvasRenderingContext2D, song: Song, settings: Settings, time: number, height: number) {
  ctx.fillStyle = "rgba(8,16,21,.86)"; ctx.fillRect(0, 0, 1920, height); ctx.fillStyle = "#b9cfcd"; ctx.font = "20px sans-serif"; ctx.fillText("PIANO FALL · SIMPLE SCORE", 28, 27); if (settings.showChords) { ctx.fillStyle = "#77e4c8"; ctx.font = "24px sans-serif"; ctx.fillText(estimateChord(song, time), 28, 66); }
  const left = 145, right = 1882, staffTop = 46, staffGap = 37; ctx.strokeStyle = "rgba(211,230,227,.55)"; ctx.lineWidth = 1; for (let staff = 0; staff < 2; staff += 1) for (let row = 0; row < 5; row += 1) { const y = staffTop + staff * staffGap + row * 8; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); }
  ctx.fillStyle = "#e6f0ee"; ctx.font = "32px serif"; ctx.fillText("𝄞", 104, 83); ctx.font = "26px serif"; ctx.fillText("𝄢", 105, 122); const windowStart = Math.max(0, Math.floor(time / 8) * 8); const notes = song.notes.filter((note) => note.start >= windowStart && note.start < windowStart + 8).slice(0, 100); notes.forEach((note) => { const x = left + ((note.start - windowStart) / 8) * (right - left); const staff = note.pitch >= 60 ? 0 : 1; const y = staffTop + staff * staffGap + (staff === 0 ? 32 - (note.pitch - 60) * 2.3 : 32 - (note.pitch - 36) * 2.3); ctx.fillStyle = palette[note.track % palette.length]; ctx.beginPath(); ctx.ellipse(x, y, 6, 4, -.25, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(x + 5, y - 22, 2, 22); });
}
