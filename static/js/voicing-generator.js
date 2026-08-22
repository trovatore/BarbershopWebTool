/* voicing-generator.js — chord-name parsing + a data-driven voicing template library, so a
   score chord can be generated from a name (with a choice of voicings/inversions) or searched
   for by fixing 1-2 specific voice pitches (plan.md §10.9, Mike's ask 2026-07-23). Deliberately
   extensible: VOICING_TEMPLATES is a flat list, one entry per named voicing shape -- adding a
   new one (a different doubling, an inversion, anything) is one new list entry, never a change
   to the search logic itself. Pure JS, no engine-kt/Android involvement -- this only needs to
   exist on /score. */
import { STR_TO_ACC, getAbsSemitone, getVariations } from './spelling.js';
import { CHORD_PATTERNS, countChromaticPitchClasses, ROLE_MAP } from './theory.js';

export const SERIAL = "#003";

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

// Ranking preferences for the combinatorial fixed-note search (plan.md §41.2, Mike's own asks,
// 2026-08-12) -- same "first guess, easy to retune once there's real output to react to" spirit
// as CHROMATIC_PENALTY_PER_NOTE above, not measured constants.
//   - Bass prefers the chord's root or 5th over its other tones (real barbershop convention, not
//     a hard rule -- inversions with Bass on the 3rd/7th are still valid, just ranked lower).
//   - A doubled tone preferentially involves Bass, not two of Bari/Lead/Tenor -- a real 4-voice
//     unison passage (all four voices on the same pitch class, common in intros) is a distinct
//     musical idea that never arises inside this search at all (every CHORD_PATTERNS entry has
//     3-4 *distinct* tones by definition), so this penalty applies with no exception needed.
const BASS_OFF_ROOT_FIFTH_PENALTY = 1.0;
const INNER_VOICE_DOUBLING_PENALTY = 1.0;
// Folds §41.1's "prefer the exact requested octave when reachable" preference into this same
// unified scoring pass instead of a separate hard exact/fallback branch -- a pitch-class-only
// match can still surface (ranked lower) instead of being silently dropped whenever no exact
// placement exists for that particular shape.
const INEXACT_FIXED_MATCH_PENALTY = 0.5;

// Every semitone within voiceIdx's own range whose pitch class is a chord tone -- or, if this
// voice is fixed, only the semitones matching the fixed pitch class specifically (still every
// octave of it, not one exact semitone -- an exact-octave match and a same-pitch-class
// different-octave match both stay in play for scoreShape() below to rank between, rather than a
// hard exact/fallback branch). Empty when the fixed pitch class isn't actually one of this
// chord's own tones -- the one case a real chord can never reach, matching the old engine's
// "impossible fixed constraint returns no candidates" behavior (js-tests.html 20.18).
function voiceCandidates(voiceIdx, chordPcs, fixedSemi) {
    const [lo, hi] = VOICE_RANGES[voiceIdx];
    let pcsToMatch = chordPcs;
    if (fixedSemi !== undefined) {
        const fixedPc = pitchClass(fixedSemi);
        if (!chordPcs.includes(fixedPc)) return [];
        pcsToMatch = [fixedPc];
    }
    const candidates = [];
    for (let s = lo; s <= hi; s++) {
        if (pcsToMatch.includes(pitchClass(s))) candidates.push(s);
    }
    return candidates;
}

// The blended rankScore (plan.md §23's barbershoppiness+chromatic-penalty base, plus §41.2's new
// bass-role/doubling/exactness terms) for one fully-assigned [Bass,Bari,Lead,Tenor] voicing.
function scoreShape(voiceSemis, patternKey, rootPc, fifthOffset, fixedByVoice, keyFifths) {
    const chromaticNotes = countChromaticPitchClasses(voiceSemis.map(pitchClass), keyFifths);
    let score = BARBERSHOPPINESS_RANK[patternKey] + chromaticNotes * CHROMATIC_PENALTY_PER_NOTE;

    const bassOffset = ((pitchClass(voiceSemis[0]) - rootPc) % 12 + 12) % 12;
    const bassIsRootOrFifth = bassOffset === 0 || (fifthOffset !== undefined && bassOffset === fifthOffset);
    if (!bassIsRootOrFifth) score += BASS_OFF_ROOT_FIFTH_PENALTY;

    const pcCounts = {};
    voiceSemis.forEach(s => {
        const pc = pitchClass(s);
        pcCounts[pc] = (pcCounts[pc] || 0) + 1;
    });
    const doubledPc = Object.keys(pcCounts).find(pc => pcCounts[pc] > 1);
    if (doubledPc !== undefined) {
        const doublingVoices = [0, 1, 2, 3].filter(i => pitchClass(voiceSemis[i]) === Number(doubledPc));
        if (!doublingVoices.includes(0)) score += INNER_VOICE_DOUBLING_PENALTY;
    }

    Object.entries(fixedByVoice).forEach(([voiceStr, semi]) => {
        if (voiceSemis[Number(voiceStr)] !== semi) score += INEXACT_FIXED_MATCH_PENALTY;
    });

    return score;
}

// Does some common rootSemiBase reproduce this exact voicing via one of the curated
// VOICING_TEMPLATES entries? If so, the combinatorial search rediscovered one of Mike's own
// vetted shapes -- reuse its real description/tentative flag instead of an auto-generated one.
function matchTemplate(voiceSemis, patternKey, rootPc) {
    for (const t of VOICING_TEMPLATES) {
        if (t.pattern !== patternKey) continue;
        const bases = t.offsets.map((o, i) => voiceSemis[i] - o);
        if (bases.every(b => b === bases[0]) && pitchClass(bases[0]) === rootPc) {
            return t;
        }
    }
    return null;
}

// A plain-language description in the curated templates' own naming style ("Root position, 5th
// doubled", "3rd in bass") for a combinatorial result that isn't one of Mike's vetted shapes.
function autoDescription(voiceSemis, rootPc) {
    const bassOffset = ((pitchClass(voiceSemis[0]) - rootPc) % 12 + 12) % 12;
    const bassPart = bassOffset === 0 ? 'Root position' : `${ROLE_MAP[bassOffset]} in bass`;

    const pcCounts = {};
    voiceSemis.forEach(s => {
        const pc = pitchClass(s);
        pcCounts[pc] = (pcCounts[pc] || 0) + 1;
    });
    const doubledPc = Object.keys(pcCounts).find(pc => pcCounts[pc] > 1);
    if (doubledPc === undefined) return bassPart;

    const doubledOffset = ((Number(doubledPc) - rootPc) % 12 + 12) % 12;
    return `${bassPart}, ${ROLE_MAP[doubledOffset]} doubled`;
}

/**
 * The fixed-note search path (plan.md §41.2, 2026-08-12) -- used only when at least one voice is
 * fixed. Considers every valid arrangement of each chord quality's own tones across the 4 voices
 * (all chord tones present, Bass lowest/Tenor highest, Bari/Lead free to cross -- same structural
 * invariants every curated template already respects), not just the ~20 hand-picked shapes in
 * VOICING_TEMPLATES. Mike's own framing: "we should see all vocab chords in which the lead is on
 * C4, even if they're not one of the 'template' voicings." Reopens a design call §10.9 originally
 * made the other way (curated-only, specifically to avoid an algorithmically-guessed doubling) --
 * this time Mike's own concrete ranking rules (scoreShape above) stand in for "vetted by ear," and
 * the curated templates aren't discarded, just reused as a description/tentative lookup (see
 * matchTemplate) for any result that happens to match one exactly.
 */
function generateVoicingsWithFixedNotes({ pattern, rootPc, fixed, keyFifths }) {
    const results = [];
    const fixedByVoice = {};
    fixed.forEach(f => { fixedByVoice[f.voice] = f.semi; });

    for (const patternKey of Object.keys(CHORD_PATTERNS)) {
        if (pattern !== undefined && patternKey !== pattern) continue;
        const offsets = patternKey.split(',').map(Number);
        // Whichever offset actually functions as this chord's 5th -- absent entirely for the
        // no-fifth ninth (0,2,4,10), where Bass's preference falls back to root only, a
        // deliberate simplification for that one quality (plan.md §41.2).
        const fifthOffset = offsets.find(o => o === 6 || o === 7 || o === 8);

        for (let candidateRootPc = 0; candidateRootPc < 12; candidateRootPc++) {
            if (rootPc !== undefined && candidateRootPc !== rootPc) continue;

            const chordPcs = [...new Set(offsets.map(o => ((candidateRootPc + o) % 12 + 12) % 12))];
            const candidatesByVoice = [0, 1, 2, 3].map(v => voiceCandidates(v, chordPcs, fixedByVoice[v]));
            if (candidatesByVoice.some(c => c.length === 0)) continue;

            // Brute-force the small (a few hundred to ~4000) cartesian product -- trivial for a
            // browser on a picker-search click, not a per-keystroke path (plan.md §41.2).
            const shapes = [];
            for (const bassSemi of candidatesByVoice[0]) {
                for (const bariSemi of candidatesByVoice[1]) {
                    for (const leadSemi of candidatesByVoice[2]) {
                        for (const tenorSemi of candidatesByVoice[3]) {
                            const voiceSemis = [bassSemi, bariSemi, leadSemi, tenorSemi];
                            if (bassSemi !== Math.min(...voiceSemis)) continue;
                            if (tenorSemi !== Math.max(...voiceSemis)) continue;
                            const covered = new Set(voiceSemis.map(pitchClass));
                            if (!chordPcs.every(pc => covered.has(pc))) continue;
                            shapes.push(voiceSemis);
                        }
                    }
                }
            }

            // Dedup to one best-ranked representative per relative shape (offsets from Bass's own
            // semitone) -- collapses the same voicing repeated a uniform octave higher, exactly
            // like the old per-template dedup, without collapsing two shapes that only happen to
            // share a root/pattern but differ in which voice sings what.
            const bestByShapeKey = new Map();
            for (const voiceSemis of shapes) {
                const score = scoreShape(voiceSemis, patternKey, candidateRootPc, fifthOffset, fixedByVoice, keyFifths);
                const shapeKey = JSON.stringify(voiceSemis.map(s => s - voiceSemis[0]));
                const existing = bestByShapeKey.get(shapeKey);
                if (!existing || score < existing.score) {
                    bestByShapeKey.set(shapeKey, { voiceSemis, score });
                }
            }

            for (const { voiceSemis, score } of bestByShapeKey.values()) {
                const template = matchTemplate(voiceSemis, patternKey, candidateRootPc);
                results.push({
                    pattern: patternKey,
                    rootPc: candidateRootPc,
                    description: template ? template.description : autoDescription(voiceSemis, candidateRootPc),
                    tentative: template ? !!template.tentative : true,
                    voices: spellVoices(voiceSemis),
                    rankScore: score,
                });
            }
        }
    }

    results.sort((a, b) => a.rankScore - b.rankScore);
    return results;
}

/**
 * Generates candidate voicings, optionally filtered by quality/root and/or 1-2 fixed voice
 * pitches -- the same one search serves both "generate by name" (quality+root given, no fixed
 * notes) and "search by fixed notes" (quality/root left open) per the unified design agreed with
 * Mike, not two separate mechanisms.
 *
 * When `opts.fixed` is non-empty, delegates entirely to `generateVoicingsWithFixedNotes()` above
 * (plan.md §41.2, 2026-08-12) -- every valid arrangement of a chord's own tones, not just the
 * curated `VOICING_TEMPLATES` shapes below, since that's specifically the case Mike found the
 * curated list too narrow for. Plain by-name/root browsing (no fixed notes at all) keeps scanning
 * only the curated templates, unchanged from before -- deliberately, so casual browsing still
 * shows only Mike's own vetted shapes rather than every mathematically valid one.
 *
 * Results are ranked (plan.md §23, 2026-07-25) by a blended score: `BARBERSHOPPINESS_RANK` for
 * the quality, plus `CHROMATIC_PENALTY_PER_NOTE` for every note outside `opts.keyFifths`'s key
 * signature -- a rarer-but-in-key chord can outrank a commoner-but-chromatic one, which is what
 * Mike asked for over a simpler "quality first, in-key only as a tiebreaker" scheme. `keyFifths`
 * checks against the score's one whole-piece key signature (plan.md §20's mid-piece-key-change
 * gap means this can't yet be more precise than that for a piece that actually changes key).
 * Deduplicated *within* each template (same pattern+rootPc+description) to just one octave
 * placement -- collapses the biggest source of clutter (the same shape repeated every octave)
 * without collapsing genuinely different named voicings across templates, even ones that happen
 * to be reachable from each other via Revoice (e.g. the major triad's "close" and "ringing
 * (2:3:4:5)" templates) -- those stay deliberately distinct, separately-selectable options, per
 * Mike's explicit call when this was raised. That one placement is normally the lowest valid
 * octave, except when `opts.fixed` is given and a higher placement exists that matches every
 * fixed voice's exact requested semitone -- see `opts.fixed` below (plan.md §41.1).
 *
 * @param {object} [opts]
 * @param {string} [opts.pattern] - a CHORD_PATTERNS key (e.g. "0,4,7") to restrict to one quality.
 * @param {number} [opts.rootPc] - a pitch class 0-11 to restrict to one root.
 * @param {Array<{voice: number, semi: number}>} [opts.fixed] - pitch-class constraints per voice
 *   index (0=Bass..3=Tenor) -- "the lead sings C4" means *some* C, not C4 specifically (changed
 *   2026-07-25, Mike: "I thought we were listing all chords that match the notes" -- exact-octave
 *   matching was silently excluding musically-valid quality/root matches whenever reaching the
 *   fixed voice's *exact* octave pushed some other voice out of its own range, plan.md §22/§24).
 *   Where a template has more than one valid placement, the one landing every fixed voice on its
 *   *exact* requested semitone is preferred when one exists within range; only a placement that
 *   merely matches by pitch class (a different octave than asked for) is returned otherwise
 *   (fixed 2026-08-06, plan.md §41.1 -- the dedup below used to keep whichever placement it
 *   scanned first regardless of exactness, silently discarding a real exact match found later in
 *   the same scan). A voice can still land in a different octave than requested when no exact
 *   placement is reachable at all -- Revoice's octave-bump remains the way to reach it from there.
 * @param {number} [opts.keyFifths] - the score's key signature (MusicXML <fifths> convention),
 *   for in-key/chromatic ranking. Defaults to 0 (no sharps/flats) if omitted.
 * @returns {Array<{pattern: string, rootPc: number, description: string, tentative: boolean,
 *   voices: Array<{step: string, acc: number, oct: number}>, rankScore: number}>} sorted
 *   ascending by rankScore (lower = shown first).
 */
export function generateVoicings(opts = {}) {
    const { pattern, rootPc, fixed = [], keyFifths = 0 } = opts;

    if (fixed.length > 0) {
        return generateVoicingsWithFixedNotes({ pattern, rootPc, fixed, keyFifths });
    }

    const results = [];

    for (const template of VOICING_TEMPLATES) {
        if (pattern !== undefined && template.pattern !== pattern) continue;

        for (let candidateRootPc = 0; candidateRootPc < 12; candidateRootPc++) {
            if (rootPc !== undefined && candidateRootPc !== rootPc) continue;

            // Scan every octave placement of this (template, root) once, keeping at most one
            // result -- every other placement is the exact same voicing shape an octave (or more)
            // higher, not a musically distinct option. Prefer the first (lowest) placement where
            // every fixed voice lands on its *exact* requested semitone, if one exists within
            // range; only fall back to the first placement that merely matches by pitch class
            // (plan.md §25) when no exact placement is reachable at all. Without this, a
            // pitch-class-only match scanned earlier (lower) could win by default and silently
            // discard an exact match found later in the same scan -- a real interaction between
            // this dedup and §25's relaxation, not by design (plan.md §41.1). When `fixed` is
            // empty, `every()` over it is vacuously true, so the very first in-range placement is
            // immediately both the exact and fallback match -- unchanged from before.
            let exactMatch = null;
            let fallbackMatch = null;

            // Scan root placements across several octaves -- VOICE_RANGES bounds which ones
            // actually survive, brute force is fine given how small this search space is (a few
            // hundred template x root x octave combinations at most).
            for (let rootSemi = candidateRootPc; rootSemi <= candidateRootPc + 96; rootSemi += 12) {
                const voiceSemis = template.offsets.map(o => rootSemi + o);
                if (!voiceSemis.every((s, i) => withinRange(s, i))) continue;
                if (!fixed.every(f => pitchClass(voiceSemis[f.voice]) === pitchClass(f.semi))) continue;

                if (!fallbackMatch) fallbackMatch = voiceSemis;
                if (fixed.every(f => voiceSemis[f.voice] === f.semi)) {
                    exactMatch = voiceSemis;
                    break; // unique -- a template's fixed voice(s) can only land on their exact
                            // requested semitone(s) at one rootSemi per octave scan, so no later
                            // placement could be a "better" exact match than this one.
                }
            }

            const voiceSemis = exactMatch || fallbackMatch;
            if (!voiceSemis) continue;

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

    results.sort((a, b) => a.rankScore - b.rankScore);
    return results;
}

// Groups a rankScore-sorted flat result list (generateVoicings()'s own return shape) into one row
// per distinct chord identity -- pattern+rootPc, e.g. "F minor" or "G dominant 7th" (plan.md §49,
// Mike's ask 2026-08-22: search results should present as chord-first, voicing-second, with the
// individual voicings a drill-down rather than all flattened together). Deliberately a pure
// post-processing pass over the existing search output, not a change to the search itself --
// generateVoicings()/generateVoicingsWithFixedNotes() are untouched, so every existing test of
// their own output (20.x/23.x/25.x/29.x) still holds exactly as before. A group's own `voicings`
// stays in the same already-best-first order the flat list was already sorted in; first-occurrence
// order for the groups themselves is therefore also already best-first, no separate re-sort
// needed. This is also why §23's explicit call to keep the major triad's "close" and "2:3:4:5
// ringing" templates separate (real distinct harmonic significance, not just different octaves of
// the same shape) is automatically honored, not overridden -- they share one pattern+rootPc, so
// they land in the same group as two distinct level-2 entries, never merged into one.
export function groupResultsByChord(results) {
    const groups = [];
    const byKey = new Map();
    for (const r of results) {
        const key = `${r.pattern}|${r.rootPc}`;
        let group = byKey.get(key);
        if (!group) {
            group = { pattern: r.pattern, rootPc: r.rootPc, voicings: [] };
            byKey.set(key, group);
            groups.push(group);
        }
        group.voicings.push(r);
    }
    return groups;
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
