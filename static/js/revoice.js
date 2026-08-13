/* revoice.js — pure logic for the Revoice dialog (plan.md §17): swapping which of the four
   barbershop parts sings a given pitch, and bumping a single part up/down an octave. No DOM here
   — both the standalone Chord editor (main.js) and the /score chord-picker (score.js) import
   these and wire them into their own local staged-preview UI and commit path, since the two hosts
   have different DOM structures and different ways of committing a finished chord. */
import { getAbsSemitone, getVariations } from './spelling.js';

export const VOICE_LABELS = ['Bass', 'Bari', 'Lead', 'Tenor'];

// All C(4,2) = 6 ways to pick two of the four parts to swap.
export const SWAP_PAIRS = [
    [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
];

/**
 * Exchanges the pitch (and cents, if a tuning array is given) currently sung by two parts,
 * leaving every other voice untouched. Each voice's own `.part` tag stays fixed to its array
 * index — only the pitch data moves — since everything else in the app (VOICE_ORDER,
 * WAV_PART_TO_VOICE_IDX, the /score table's columns) assumes a fixed part-per-index convention.
 * Cents travels with the pitch, not the singer: a note's cents offset depends on its harmonic role
 * (interval from the chord root — see theory.js/ChordLabel.kt's tuning tables), not on which voice
 * happens to sing it, so swapping two voices' pitches without also swapping their cents would
 * leave the cents attached to the wrong note.
 */
export function swapVoices(voices, tuning, idxA, idxB) {
    const newVoices = voices.slice();
    const a = voices[idxA], b = voices[idxB];
    newVoices[idxA] = Object.assign({}, a, { step: b.step, acc: b.acc, oct: b.oct, rest: b.rest });
    newVoices[idxB] = Object.assign({}, b, { step: a.step, acc: a.acc, oct: a.oct, rest: a.rest });
    let newTuning = tuning;
    if (tuning) {
        newTuning = tuning.slice();
        newTuning[idxA] = tuning[idxB];
        newTuning[idxB] = tuning[idxA];
    }
    return { voices: newVoices, tuning: newTuning };
}

/**
 * Moves one part's pitch up or down exactly one octave (direction +1/-1), respelling via the same
 * false-relation-aware logic every other note edit in this app uses (spelling.js's
 * getVariations()) — identical math to main.js's updateNote(idx, ±12), just returning a new array
 * instead of mutating appState directly, so a staged preview can call it repeatedly without
 * touching the real chord until Apply.
 */
export function bumpOctave(voices, idx, direction) {
    const v = voices[idx];
    const context = voices
        .map((s, i) => ({ step: s.step, semi: getAbsSemitone(s), idx: i }))
        .filter(n => n.idx !== idx);
    const newVoices = voices.slice();
    newVoices[idx] = Object.assign({}, v, getVariations(getAbsSemitone(v) + direction * 12, v.oct, context)[0]);
    return newVoices;
}
