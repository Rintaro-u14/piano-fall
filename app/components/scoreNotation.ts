export type ScoreFormat = "auto" | "staff" | "tab" | "drums";
export type ScoreNote = { id: string; start: number; end: number; pitch: number };
export type GuitarPosition = { string: number; fret: number };

// Standard guitar tuning, from the high E string to the low E string.
export const GUITAR_OPEN_PITCHES = [64, 59, 55, 50, 45, 40];
export const GUITAR_STRING_LABELS = ["e", "B", "G", "D", "A", "E"];

export function defaultScoreFormat(drums: boolean, program: number): Exclude<ScoreFormat, "auto"> {
  return drums ? "drums" : program >= 24 && program <= 31 ? "tab" : "staff";
}

export function resolveScoreFormat(format: ScoreFormat, drums: boolean, program: number): Exclude<ScoreFormat, "auto"> {
  if (drums) return "drums";
  if (format === "auto" || format === "drums") return defaultScoreFormat(false, program);
  return format;
}

export function guitarPositions(notes: ScoreNote[]): Map<string, GuitarPosition> {
  type Assignment = { positions: (GuitarPosition | null)[]; mask: number; handFret: number | null; cost: number };
  type State = { cost: number; heldUntil: number[]; handFret: number | null; mask: number; previous: State | null; notes: ScoreNote[]; assignment: Assignment | null };
  const ordered = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const assignmentCache = new Map<string, Assignment[]>();
  const bitCounts = Array.from({ length: 64 }, (_, mask) => mask.toString(2).replace(/0/g, "").length);
  let states: State[] = [{ cost: 0, heldUntil: Array(6).fill(-Infinity), handFret: null, mask: 0, previous: null, notes: [], assignment: null }];

  for (let i = 0; i < ordered.length;) {
    const onset = ordered[i].start;
    const chord: ScoreNote[] = [];
    while (i < ordered.length && ordered[i].start - onset < .025) chord.push(ordered[i++]);
    // MIDI can contain pitches outside the guitar range or more than six notes.
    const playable = chord.filter((note) => GUITAR_OPEN_PITCHES.some((open) => note.pitch >= open && note.pitch <= open + 24)).slice(0, 6);
    if (!playable.length) continue;

    const pitches = playable.map((note) => note.pitch).join(",");
    let assignments = assignmentCache.get(pitches);
    if (!assignments) {
      const options = playable.map((note) => GUITAR_OPEN_PITCHES.flatMap((open, string) => {
        const fret = note.pitch - open;
        return fret >= 0 && fret <= 24 ? [{ string, fret }] : [];
      }));
      const byMask = new Map<number, Assignment[]>();
      const chosen: (GuitarPosition | null)[] = [];
      const search = (index: number, mask: number, omitted: number) => {
        if (index === playable.length) {
          const frets = chosen.flatMap((position) => position && position.fret ? [position.fret] : []);
          const span = frets.length ? Math.max(...frets) - Math.min(...frets) : 0;
          const assignment: Assignment = {
            positions: [...chosen], mask,
            handFret: frets.length ? frets.reduce((sum, fret) => sum + fret, 0) / frets.length : null,
            cost: omitted * 100 + span + Math.max(0, span - 4) ** 2 * 12
              + chosen.reduce((sum, position) => sum + (position ? position.fret * .13 + Math.max(0, position.fret - 12) * 2 : 0), 0),
          };
          const alternatives = byMask.get(mask) ?? [];
          alternatives.push(assignment);
          alternatives.sort((a, b) => a.cost - b.cost);
          if (alternatives.length > 4) alternatives.pop();
          byMask.set(mask, alternatives);
          return;
        }
        for (const position of options[index]) {
          if (mask & (1 << position.string)) continue;
          chosen.push(position);
          search(index + 1, mask | (1 << position.string), omitted);
          chosen.pop();
        }
        chosen.push(null);
        search(index + 1, mask, omitted + 1);
        chosen.pop();
      };
      search(0, 0, 0);
      assignments = [...byMask.values()].flat();
      assignmentCache.set(pitches, assignments);
    }
    const next = new Map<string, State>();
    for (const state of states) for (const assignment of assignments) {
      if (assignment.positions.some((position, index) => position && state.heldUntil[position.string] > playable[index].start + .005)) continue;
      const heldUntil = [...state.heldUntil];
      assignment.positions.forEach((position, index) => {
        if (position) heldUntil[position.string] = Math.max(heldUntil[position.string], playable[index].end);
      });
      const handFret = assignment.handFret ?? state.handFret;
      const changedStrings = bitCounts[state.mask ^ assignment.mask];
      const movement = state.handFret === null || handFret === null ? 0 : Math.abs(handFret - state.handFret) * 1.5;
      const cost = state.cost + assignment.cost + movement + (state.previous ? changedStrings * .25 : 0);
      const key = `${heldUntil.map((end) => end > onset ? end : 0).join(",")}|${handFret}|${assignment.mask}`;
      if (cost < (next.get(key)?.cost ?? Infinity)) next.set(key, { cost, heldUntil, handFret, mask: assignment.mask, previous: state, notes: playable, assignment });
    }
    // The held-string state depends on earlier choices, so keep several paths.
    states = [...next.values()].sort((a, b) => a.cost - b.cost).slice(0, 32);
  }

  const result = new Map<string, GuitarPosition>();
  let state: State | null = states[0] ?? null;
  while (state?.previous) {
    state.assignment?.positions.forEach((position, index) => {
      if (position) result.set(state!.notes[index].id, position);
    });
    state = state.previous;
  }
  return result;
}

export type DrumLane = { row: number; head: "normal" | "cross" | "open" };

export function drumLane(pitch: number): DrumLane {
  if ([35, 36].includes(pitch)) return { row: 4, head: "normal" }; // kick
  if ([37, 38, 40].includes(pitch)) return { row: 3, head: "normal" }; // snare
  if ([41, 43, 45, 47, 48, 50].includes(pitch)) return { row: 2, head: "normal" }; // toms
  if ([42, 44].includes(pitch)) return { row: 1, head: "cross" }; // closed/pedal hi-hat
  if (pitch === 46) return { row: 1, head: "open" }; // open hi-hat
  if ([49, 52, 55, 57].includes(pitch)) return { row: 0, head: "cross" }; // crash/china
  if ([51, 53, 59].includes(pitch)) return { row: 0, head: "normal" }; // ride
  return { row: 2, head: "cross" }; // other GM percussion
}
