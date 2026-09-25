import assert from "node:assert/strict";
import test from "node:test";
import { defaultScoreFormat, drumLane, guitarPositions, resolveScoreFormat } from "../app/components/scoreNotation.ts";

test("automatic score format follows the MIDI track", () => {
  assert.equal(defaultScoreFormat(true, 0), "drums");
  assert.equal(defaultScoreFormat(false, 24), "tab");
  assert.equal(defaultScoreFormat(false, 0), "staff");
  assert.equal(resolveScoreFormat("staff", true, 0), "drums");
});

test("guitar chord uses playable, distinct strings", () => {
  const notes = [40, 45, 50, 55, 59, 64].map((pitch, index) => ({ id: String(index), start: 0, end: 1, pitch }));
  const positions = guitarPositions(notes);
  assert.equal(positions.size, 6);
  assert.equal(new Set([...positions.values()].map((position) => position.string)).size, 6);
  assert.ok([...positions.values()].every((position) => position.fret === 0));
});

test("guitar assignment respects held strings and unplayable notes", () => {
  const positions = guitarPositions([
    { id: "held", start: 0, end: 2, pitch: 64 },
    { id: "later", start: 1, end: 1.5, pitch: 64 },
    { id: "below", start: 1, end: 1.5, pitch: 35 },
  ]);
  assert.equal(positions.has("held"), true);
  assert.equal(positions.has("later"), true);
  assert.notEqual(positions.get("held")?.string, positions.get("later")?.string);
  assert.equal(positions.has("below"), false);
});

test("guitar assignment chooses a position that fits the following phrase", () => {
  const notes = [63, 72, 62, 63].map((pitch, index) => ({
    id: String(index), start: index, end: index + .5, pitch,
  }));
  const positions = guitarPositions(notes);
  assert.deepEqual(positions.get("0"), { string: 2, fret: 8 });
  assert.deepEqual(positions.get("1"), { string: 0, fret: 8 });
  assert.deepEqual(positions.get("2"), { string: 2, fret: 7 });
  assert.deepEqual(positions.get("3"), { string: 2, fret: 8 });
});

test("common GM percussion pitches map to distinct lanes", () => {
  assert.deepEqual(drumLane(36), { row: 4, head: "normal" });
  assert.deepEqual(drumLane(38), { row: 3, head: "normal" });
  assert.deepEqual(drumLane(42), { row: 1, head: "cross" });
  assert.deepEqual(drumLane(46), { row: 1, head: "open" });
  assert.deepEqual(drumLane(49), { row: 0, head: "cross" });
});
