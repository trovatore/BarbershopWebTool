/* voicing-generator.js — chord-name parsing + a data-driven voicing template library, so a
   score chord can be generated from a name (with a choice of voicings/inversions) or searched
   for by fixing 1-2 specific voice pitches (plan.md §10.9, Mike's ask 2026-07-23). Deliberately
   extensible: VOICING_TEMPLATES is a flat list, one entry per named voicing shape -- adding a
   new one (a different doubling, an inversion, anything) is one new list entry, never a change
   to the search logic itself. Pure JS, no engine-kt/Android involvement -- this only needs to
   exist on /score. */
import { STR_TO_ACC, getAbsSemitone, getVariations } from './spelling.js';
import { CHORD_PATTERNS } from './theory.js';

export const SERIAL = "#001";

// Chord-name suffix -> CHORD_PATTERNS key. Root letter + accidental is parsed separately
// (parseChordName below); this table only has to cover what's left over. Case matters where it
// has to (m7 vs M7/maj7 -- minor vs major -- are genuinely different chords), so suffixes are
// matched verbatim, not case-folded.
const QUALITY_SUFFIXES = [
    { suffixes: ['m7b5', 'min7b5', 'm7-5', 'ø7', 'ø'], pattern: '0,3,6,10' },
    { suffixes: ['dim7', 'o7', '°7', 'dim'], pattern: '0,3,6,9' },
    { suffixes: ['maj7', 'M7', 'Δ7', 'Δ'], pattern: '0,4,7,11' },
    { suffixes: ['m7', 'min7', '-7'], pattern: '0,3,7,10' },
    { suffixes: ['9'], pattern: '0,2,4,10' }, // barbershop shorthand for the no-fifth ninth
    { suffixes: ['7'], pattern: '0,4,7,10' },
    { suffixes: ['+', 'aug'], pattern: '0,4,8' },
    { suffixes: ['m', 'min', '-'], pattern: '0,3,7' },
    { suffixes: [''], pattern: '0,4,7' }, // nothing left over after the root = plain major
];

/** "Cm7" -> { rootStep: 'c', rootAcc: -1, pattern: '0,3,7,10' }. Returns null for anything that
    doesn't start with a real note letter or whose suffix isn't a recognized quality -- callers
    show that as "chord not recognized", same spirit as ChordLabel's "no guess rather than a
    wrong guess" policy. */
export function parseChordName(text) {
    const trimmed = (text || '').trim();
    const m = trimmed.match(/^([A-Ga-g])(bb|b|#|x)?/);
    if (!m) return null;
    const rootStep = m[1].toLowerCase();
    const rootAcc = STR_TO_ACC[m[2] || ''] ?? 0;
    const suffix = trimmed.slice(m[0].length).trim();

    const entry = QUALITY_SUFFIXES.find(e => e.suffixes.includes(suffix));
    return entry ? { rootStep, rootAcc, pattern: entry.pattern } : null;
}

// Offsets are semitones above the chord's own root for [Bass, Bari, Lead, Tenor] -- negative
// values put that voice below the root's own octave (an inversion: e.g. the 5th dropped an
// octave into the bass). Every entry's pitch-class set was checked against CHORD_PATTERNS's own
// key (js-tests.html verifies this computationally via analyzeChord(), the same round-trip
// discipline the Android quiz app's templates used) -- these are the *musical* choices, made
// with Mike (2026-07-23):
//   - Major triad: root-doubled close voicing, the 2:3:4:5 "ringing" overtone-series voicing
//     (root doubled between Bass and Lead, not Tenor -- Bass:Bari:Lead:Tenor = 2:3:4:5, which is
//     why it's specific to major/dominant sonorities, not something with a minor-triad analogue),
//     and a less-common but real 3rd-doubled voicing.
//   - Minor/augmented triads: root-doubled and 3rd-doubled only -- no 2:3:4:5-style "spread"
//     entry, since that shape falls directly out of the major triad's presence in the natural
//     harmonic series and has no equivalent for a minor 3rd.
//   - Seventh chords: root position plus second inversion (5th in the bass), applied by the same
//     mechanical construction across all five seventh qualities for consistency.
//   - Minor seventh's voicings are a mechanical placeholder, not vetted by ear -- Mike was
//     explicit he isn't confident about m7 voicings either. `tentative: true` flags this so a
//     future UI can show a caveat; easy to replace once it's actually been heard.
//   - The no-fifth ninth has no 5th at all, so "second inversion" doesn't map onto it the normal
//     way -- root position only for now.
export const VOICING_TEMPLATES = [
    { pattern: '0,4,7', description: 'Root doubled, close', offsets: [0, 4, 7, 12] },
    { pattern: '0,4,7', description: 'Root doubled, ringing (2:3:4:5)', offsets: [0, 7, 12, 16] },
    { pattern: '0,4,7', description: '3rd doubled', offsets: [0, 4, 7, 16] },

    { pattern: '0,3,7', description: 'Root doubled, close', offsets: [0, 3, 7, 12] },
    { pattern: '0,3,7', description: '3rd doubled', offsets: [0, 3, 7, 15] },

    { pattern: '0,4,8', description: 'Root doubled, close', offsets: [0, 4, 8, 12] },
    { pattern: '0,4,8', description: '3rd doubled', offsets: [0, 4, 8, 16] },

    { pattern: '0,4,7,10', description: 'Root position', offsets: [0, 4, 7, 10] },
    { pattern: '0,4,7,10', description: '2nd inversion (5th in bass)', offsets: [-5, 0, 4, 10] },

    { pattern: '0,4,7,11', description: 'Root position', offsets: [0, 4, 7, 11] },
    { pattern: '0,4,7,11', description: '2nd inversion (5th in bass)', offsets: [-5, 0, 4, 11] },

    {
        pattern: '0,3,7,10', description: 'Root position', offsets: [0, 3, 7, 10],
        tentative: true,
    },
    {
        pattern: '0,3,7,10', description: '2nd inversion (5th in bass)', offsets: [-5, 0, 3, 10],
        tentative: true,
    },

    { pattern: '0,3,6,9', description: 'Root position', offsets: [0, 3, 6, 9] },
    { pattern: '0,3,6,9', description: '2nd inversion (dim5th in bass)', offsets: [-6, 0, 3, 9] },

    { pattern: '0,3,6,10', description: 'Root position', offsets: [0, 3, 6, 10] },
    { pattern: '0,3,6,10', description: '2nd inversion (dim5th in bass)', offsets: [-6, 0, 3, 10] },

    { pattern: '0,2,4,10', description: 'Root position', offsets: [0, 10, 4, 14] },
];

// Guessed, not measured -- flagged exactly like the templates' own tentative flag, easy to
// tighten/loosen once this is actually driven from a UI and Mike can react to real output.
// [minSemi, maxSemi] per voice, same semitone convention as spelling.js's getAbsSemitone
// (C0 = 0), Bass/Bari/Lead/Tenor order.
export const VOICE_RANGES = [
    [28, 52], // Bass: E2-E4
    [31, 55], // Bari: G2-G4
    [33, 57], // Lead: A2-A4
    [45, 69], // Tenor: A3-A5
];

function withinRange(semi, voiceIndex) {
    const [lo, hi] = VOICE_RANGES[voiceIndex];
    return semi >= lo && semi <= hi;
}

/**
 * Generates candidate voicings, optionally filtered by quality/root and/or 1-2 fixed voice
 * pitches -- the same one search serves both "generate by name" (quality+root given, no fixed
 * notes) and "search by fixed notes" (quality/root left open) per the unified design agreed with
 * Mike, not two separate mechanisms.
 *
 * @param {object} [opts]
 * @param {string} [opts.pattern] - a CHORD_PATTERNS key (e.g. "0,4,7") to restrict to one quality.
 * @param {number} [opts.rootPc] - a pitch class 0-11 to restrict to one root.
 * @param {Array<{voice: number, semi: number}>} [opts.fixed] - exact semitone constraints per
 *   voice index (0=Bass..3=Tenor). A candidate must match every entry exactly (same octave, not
 *   just pitch class) -- "the lead sings C4" means C4, not C in any octave.
 * @returns {Array<{pattern: string, rootPc: number, description: string, tentative: boolean,
 *   voices: Array<{step: string, acc: number, oct: number}>}>}
 */
export function generateVoicings(opts = {}) {
    const { pattern, rootPc, fixed = [] } = opts;
    const results = [];

    for (const template of VOICING_TEMPLATES) {
        if (pattern !== undefined && template.pattern !== pattern) continue;

        for (let candidateRootPc = 0; candidateRootPc < 12; candidateRootPc++) {
            if (rootPc !== undefined && candidateRootPc !== rootPc) continue;

            // Scan root placements across several octaves -- VOICE_RANGES bounds which ones
            // actually survive, brute force is fine given how small this search space is (a few
            // hundred template x root x octave combinations at most).
            for (let rootSemi = candidateRootPc; rootSemi <= candidateRootPc + 96; rootSemi += 12) {
                const voiceSemis = template.offsets.map(o => rootSemi + o);
                if (!voiceSemis.every((s, i) => withinRange(s, i))) continue;
                if (!fixed.every(f => voiceSemis[f.voice] === f.semi)) continue;

                results.push({
                    pattern: template.pattern,
                    rootPc: candidateRootPc,
                    description: template.description,
                    tentative: !!template.tentative,
                    voices: spellVoices(voiceSemis),
                });
            }
        }
    }

    return results;
}

// Spells low-to-high so each voice's false-relation check (getVariations' own existingNotes
// param) sees the others already chosen -- same order-dependent trick main.js's updateNote()
// relies on, not something new invented here.
function spellVoices(voiceSemis) {
    const chosen = [];
    return voiceSemis.map(semi => {
        const variation = getVariations(semi, Math.floor(semi / 12), chosen)[0];
        const withSemi = { ...variation, semi };
        chosen.push(withSemi);
        return { step: variation.step, acc: variation.acc, oct: variation.oct };
    });
}
