/* voicing-generator.js — chord-name parsing + a data-driven voicing template library, so a
   score chord can be generated from a name (with a choice of voicings/inversions) or searched
   for by fixing 1-2 specific voice pitches (plan.md §10.9, Mike's ask 2026-07-23). Deliberately
   extensible: VOICING_TEMPLATES is a flat list, one entry per named voicing shape -- adding a
   new one (a different doubling, an inversion, anything) is one new list entry, never a change
   to the search logic itself. Pure JS, no engine-kt/Android involvement -- this only needs to
   exist on /score. */
import { STR_TO_ACC, getAbsSemitone, getVariations } from './spelling.js';
import { CHORD_PATTERNS, countChromaticPitchClasses } from './theory.js';

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
//   - All three triad qualities also get a "2nd inversion, 5th doubled" voicing (Bass/Bari both
//     on the 5th -- one an octave down, one at the chord's own octave -- Lead on the 3rd, Tenor
//     on the root an octave up). Added 2026-07-25 after Mike hit a real gap: every original triad
//     template put Lead on the root or the 5th, never the 3rd, so a search fixing Lead to a pitch
//     only reachable as some chord's 3rd (e.g. Lead=G4 for an Eb major triad) silently dropped
//     every triad of that quality/root, even though "leads do get the third from time to time" is
//     just normal barbershop, not a corner case. This keeps Bass lowest/Tenor highest like every
//     other template (js-tests.html 20.16) -- a specific arrangement where Lead sits *above*
//     Tenor (Mike's own example: a "tenor melody" score where the single treble voice, defaulted
//     to Lead per plan.md §21, is actually the top line) isn't baked in here as a general shape;
//     that's what the Revoice dialog's octave-bump is for on the one chord that needs it.
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
    { pattern: '0,4,7', description: '2nd inversion, 5th doubled (Lead on 3rd)', offsets: [-5, 7, 4, 12] },

    { pattern: '0,3,7', description: 'Root doubled, close', offsets: [0, 3, 7, 12] },
    { pattern: '0,3,7', description: '3rd doubled', offsets: [0, 3, 7, 15] },
    { pattern: '0,3,7', description: '2nd inversion, 5th doubled (Lead on 3rd)', offsets: [-5, 7, 3, 12] },

    { pattern: '0,4,8', description: 'Root doubled, close', offsets: [0, 4, 8, 12] },
    { pattern: '0,4,8', description: '3rd doubled', offsets: [0, 4, 8, 16] },
    { pattern: '0,4,8', description: '2nd inversion, 5th doubled (Lead on 3rd)', offsets: [-4, 8, 4, 12] },

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

function pitchClass(semi) {
    return ((semi % 12) + 12) % 12;
}

// How idiomatic/common each quality is in barbershop, lowest = most common -- used to rank
// chord-picker search results (plan.md §23, Mike's own list, 2026-07-25): "major triad, dominant
// seventh, minor triad, minor seventh, ninth, half-diminished, diminished seventh". Major seventh
// and augmented triad weren't in that list -- placed last as a placeholder (Mike: "we can start
// with that list... ideally the design will be flexible enough that it can be easily tweaked
// later"), not a genre judgment -- this table is the one place to reorder if that's wrong.
export const BARBERSHOPPINESS_RANK = {
    '0,4,7': 0,       // Major triad
    '0,4,7,10': 1,    // Dominant seventh
    '0,3,7': 2,       // Minor triad
    '0,3,7,10': 3,    // Minor seventh
    '0,2,4,10': 4,    // Dominant ninth (no fifth)
    '0,3,6,10': 5,    // Half-diminished seventh
    '0,3,6,9': 6,     // Diminished seventh
    '0,4,7,11': 7,    // Major seventh -- placeholder position, not in Mike's list
    '0,4,8': 8,       // Augmented triad -- placeholder position, not in Mike's list
};

// How many "barbershoppiness ranks" one out-of-key note costs when blending the two factors into
// a single ordering (plan.md §23) -- Mike was explicit he's not sure how to weight these against
// each other, so this is a first guess to be tuned once there's real search output to react to,
// not a measured constant. Deliberately a single named constant, not buried in a formula, so it's
// obvious where to change it.
const CHROMATIC_PENALTY_PER_NOTE = 1.5;

/**
 * Generates candidate voicings, optionally filtered by quality/root and/or 1-2 fixed voice
 * pitches -- the same one search serves both "generate by name" (quality+root given, no fixed
 * notes) and "search by fixed notes" (quality/root left open) per the unified design agreed with
 * Mike, not two separate mechanisms.
 *
 * Results are ranked (plan.md §23, 2026-07-25) by a blended score: `BARBERSHOPPINESS_RANK` for
 * the quality, plus `CHROMATIC_PENALTY_PER_NOTE` for every note outside `opts.keyFifths`'s key
 * signature -- a rarer-but-in-key chord can outrank a commoner-but-chromatic one, which is what
 * Mike asked for over a simpler "quality first, in-key only as a tiebreaker" scheme. `keyFifths`
 * checks against the score's one whole-piece key signature (plan.md §20's mid-piece-key-change
 * gap means this can't yet be more precise than that for a piece that actually changes key).
 * Deduplicated *within* each template (same pattern+rootPc+description) to just its lowest valid
 * octave placement -- collapses the biggest source of clutter (the same shape repeated every
 * octave) without collapsing genuinely different named voicings across templates, even ones
 * that happen to be reachable from each other via Revoice (e.g. the major triad's "close" and
 * "ringing (2:3:4:5)" templates) -- those stay deliberately distinct, separately-selectable
 * options, per Mike's explicit call when this was raised.
 *
 * @param {object} [opts]
 * @param {string} [opts.pattern] - a CHORD_PATTERNS key (e.g. "0,4,7") to restrict to one quality.
 * @param {number} [opts.rootPc] - a pitch class 0-11 to restrict to one root.
 * @param {Array<{voice: number, semi: number}>} [opts.fixed] - pitch-class constraints per voice
 *   index (0=Bass..3=Tenor) -- "the lead sings C4" means *some* C, matched against whichever
 *   octave a template naturally lands that voice in, not C4 specifically (changed 2026-07-25,
 *   Mike: "I thought we were listing all chords that match the notes" -- exact-octave matching
 *   was silently excluding musically-valid quality/root matches whenever reaching the fixed
 *   voice's *exact* octave pushed some other voice out of its own range, same failure mode twice
 *   over in plan.md §22/§24). A voice landing in a different octave than what's actually in the
 *   current chord is expected -- Revoice's octave-bump moves it to the exact target afterward.
 * @param {number} [opts.keyFifths] - the score's key signature (MusicXML <fifths> convention),
 *   for in-key/chromatic ranking. Defaults to 0 (no sharps/flats) if omitted.
 * @returns {Array<{pattern: string, rootPc: number, description: string, tentative: boolean,
 *   voices: Array<{step: string, acc: number, oct: number}>, rankScore: number}>} sorted
 *   ascending by rankScore (lower = shown first).
 */
export function generateVoicings(opts = {}) {
    const { pattern, rootPc, fixed = [], keyFifths = 0 } = opts;
    const results = [];
    const seenTemplateKeys = new Set();

    for (const template of VOICING_TEMPLATES) {
        if (pattern !== undefined && template.pattern !== pattern) continue;

        for (let candidateRootPc = 0; candidateRootPc < 12; candidateRootPc++) {
            if (rootPc !== undefined && candidateRootPc !== rootPc) continue;

            // Only the lowest valid octave placement per (template, root) survives when nothing
            // fixes a specific pitch -- every other placement is the exact same voicing shape an
            // octave (or more) higher, not a musically distinct option.
            const templateKey = `${template.pattern}|${candidateRootPc}|${template.description}`;

            // Scan root placements across several octaves -- VOICE_RANGES bounds which ones
            // actually survive, brute force is fine given how small this search space is (a few
            // hundred template x root x octave combinations at most).
            for (let rootSemi = candidateRootPc; rootSemi <= candidateRootPc + 96; rootSemi += 12) {
                const voiceSemis = template.offsets.map(o => rootSemi + o);
                if (!voiceSemis.every((s, i) => withinRange(s, i))) continue;
                if (!fixed.every(f => pitchClass(voiceSemis[f.voice]) === pitchClass(f.semi))) continue;
                if (seenTemplateKeys.has(templateKey)) continue;
                seenTemplateKeys.add(templateKey);

                const chromaticNotes = countChromaticPitchClasses(voiceSemis.map(pitchClass), keyFifths);
                results.push({
                    pattern: template.pattern,
                    rootPc: candidateRootPc,
                    description: template.description,
                    tentative: !!template.tentative,
                    voices: spellVoices(voiceSemis),
                    rankScore: BARBERSHOPPINESS_RANK[template.pattern] + chromaticNotes * CHROMATIC_PENALTY_PER_NOTE,
                });
            }
        }
    }

    results.sort((a, b) => a.rankScore - b.rankScore);
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
