/* theory.js Serial: #007 */
import { getAbsSemitone, ACC_TO_STR } from './spelling.js';

export const SERIAL = "#007";

// Exported (plan.md §10.9) so voicing-generator.js's chord-name parser and voicing templates
// reuse this exact table instead of restating it -- same "don't let two tables drift apart"
// discipline as JUST_OFFSETS/PYTH_OFFSETS already follow relative to ChordLabel.kt's copies.
export const CHORD_PATTERNS = {
    "0,4,7": { name: "Major triad", type: "triad" },
    "0,3,7": { name: "Minor triad", type: "triad" },
    "0,4,7,10": { name: "Dominant seventh", type: "seventh" },
    "0,3,6,10": { name: "Half-diminished seventh", type: "seventh" },
    "0,3,6,9": { name: "Diminished seventh", type: "seventh" },
    "0,4,7,11": { name: "Major seventh", type: "seventh" },
    "0,3,7,10": { name: "Minor seventh", type: "seventh" },
    "0,4,8": { name: "Augmented triad", type: "triad" },
    // The barbershop no-fifth ninth (root/3rd/b7/9th, root present) -- matches ChordLabel.kt's
    // own "0,2,4,10" entry exactly (plan.md §10.9). Distinct from the existing rootless-9th
    // *reinterpretation* of a half-diminished shape below (allow_rootless) -- that's a different
    // 4-note pitch-class set (3rd/5th/b7/9th, root absent) serving a different purpose (an
    // alternate reading of notes already on the page), not a generatable shape of its own.
    "0,2,4,10": { name: "Dominant ninth (no fifth)", type: "seventh" }
};

// Exported alongside CHORD_PATTERNS (plan.md §10.9) so js-tests.html's voicing-template
// round-trip check can invert this table itself rather than hand-transcribing a second copy of
// "which role name means which interval" -- role names here are generic (interval-based, e.g.
// "Minor 6th" for a raised 5th in an augmented triad), not chord-aware relabeling.
export const ROLE_MAP = {
    0: "Root", 1: "Minor 2nd", 2: "Major 2nd", 3: "Minor 3rd",
    4: "Major 3rd", 5: "Perfect 4th", 6: "Dim 5th", 7: "Fifth",
    8: "Minor 6th", 9: "Major 6th", 10: "Flat 7th", 11: "Major 7th"
};

const JUST_OFFSETS = {
    "Root": 0.0, "Ninth": 3.9, "Major 2nd": 3.9, "Minor 3rd": 15.6,
    "Major 3rd": -13.7, "Perfect 4th": -2.0, "Dim 5th": -17.5,
    "Fifth": 2.0, "Aug 5th": -13.7, "Minor 6th": 13.7,
    "Major 6th": -15.6, "Dim 7th": -33.1, "Flat 7th": -31.2,
    "Major 7th": -11.7
};

const PYTH_OFFSETS = {
    "Root": 0.0, "Ninth": 3.9, "Major 2nd": 3.9, "Minor 3rd": -5.9,
    "Major 3rd": 7.8, "Perfect 4th": -2.0, "Dim 5th": -13.7,
    "Fifth": 2.0, "Aug 5th": 9.8, "Minor 6th": -7.8,
    "Major 6th": 5.9, "Dim 7th": -17.6, "Flat 7th": -3.9,
    "Major 7th": 9.8
};

export function analyzeChord(notes, options = {}) {
    const allowRootless = options.allow_rootless !== undefined ? options.allow_rootless : false;
    const tuningStyle = options.tuning_style || "just";
    // Key signature for spelling the chord's root (plan.md §15) -- 0/omitted means "no key
    // context" (e.g. the standalone Chord page, which has no key-signature concept at all) and
    // keeps this function's output byte-identical to before this option existed.
    const keyFifths = options.keyFifths || 0;
    // Major/minor mode (plan.md §46) -- 'major'/omitted keeps every existing caller's Roman-numeral
    // output byte-identical, same "new option defaults to old behavior" convention keyFifths itself
    // used when it was added.
    const mode = options.mode || 'major';
    // Which voice reads 0 cents (plan.md §29, Mike's ask, 2026-08-23) -- 'root' (this function's
    // only behavior until now), or a specific voice ('bass'/'bari'/'lead'/'tenor'), regardless of
    // which chord tone that voice happens to be singing. Defaults to 'lead', a real, deliberate
    // change from the previous implicit root-pin, not just a new option with an old-behavior
    // default (barbershop convention usually locks onto the lead, not the root).
    const pin = options.pin || 'lead';
    
    // idx is each note's position in the *original* notes array (Bass/Bari/Lead/Tenor, index
    // 0-3) -- threaded through every stage below so the final notes[].part label stays correct
    // even when a rest ("–", or any other unparseable entry) gets filtered out here. Without this,
    // a chord with e.g. only Bass resting would silently relabel Bari's own entry as "Bass" (the
    // old code used the *filtered* array's index, not the voice's real position).
    const pObjs = notes.map((n, idx) => {
        const match = n.match(/^([a-gA-G])(bb|b|#|x)?([0-8])$/i);
        if (!match) return null;
        const stepMap = { 'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11 };
        const acc = match[2] ? (match[2] === 'x' ? 2 : (match[2] === 'bb' ? -2 : (match[2] === '#' ? 1 : -1))) : 0;
        return { name: n, semi: (parseInt(match[3]) * 12) + stepMap[match[1].toLowerCase()] + acc, idx };
    }).filter(p => p !== null);

    if (pObjs.length === 0) return { common_name: "Unknown Chord", inversion: "N/A", voicing: "N/A", notes: [], roman_numeral: null };

    const sortedPitches = [...pObjs].sort((a, b) => a.semi - b.semi);
    const span = sortedPitches[sortedPitches.length - 1].semi - sortedPitches[0].semi;
    const currentVoicing = span <= 12 ? "Closed" : "Open";

    if (pObjs.length < 3) return { common_name: "Unknown Chord", inversion: "N/A", voicing: currentVoicing, notes: [], roman_numeral: null };

    const uniquePCs = [...new Set(sortedPitches.map(p => p.semi % 12))];
    let bestMatch = null;
    let rootPC = -1;
    let matchedPattern = null;

    for (let pc of uniquePCs) {
        const pattern = uniquePCs.map(x => (x - pc + 12) % 12).sort((a, b) => a - b).join(',');
        if (CHORD_PATTERNS[pattern]) {
            bestMatch = { ...CHORD_PATTERNS[pattern] };
            rootPC = pc;
            matchedPattern = pattern;
            break;
        }
    }

    // Unrecognized chord shape -- still real voices with real notes, just no harmonic role to
    // hang a just/Pythagorean offset off of. `notes: []` here used to make main.js's tuning-scatter
    // guard (`data.notes.forEach(...)`) silently do nothing, leaving chord.tuning frozen at
    // whatever it was before -- reproduced live with an "Unknown Chord" (G3/C4/D4/F4) already
    // sitting in localStorage: every intonation radio, including Equal, appeared to do nothing.
    // Equal temperament needs no role at all (always 0 cents), and just/Pythagorean have nothing
    // sensible to compute without a root, so 0.0 for every voice is the correct answer here, not a
    // fallback to avoid.
    if (!bestMatch) return {
        common_name: "Unknown Chord",
        inversion: "N/A",
        voicing: currentVoicing,
        notes: pObjs.map(p => ({
            part: ["Bass", "Bari", "Lead", "Tenor"][p.idx],
            note: p.name,
            role: "Unknown",
            tuning: 0.0
        })),
        roman_numeral: null,
    };

    // Computed from the original matched pattern/root, before any rootless-9th relabeling below
    // (plan.md §34) -- that relabeling is a letter-naming convenience specific to the barbershop
    // "rootless 9th" idiom, not something Roman-numeral analysis needs to mirror.
    const romanNumeral = getRomanNumeral(rootPC, matchedPattern, keyFifths, mode);

    let tuningRootPC = rootPC;
    let virtualRootMode = false;
    if (bestMatch.name === "Half-diminished seventh" && allowRootless) {
        const virtualRoot = (rootPC - 4 + 12) % 12;
        bestMatch.name = `${getKeyAwarePCName(virtualRoot, keyFifths)} dominant 9th chord (rootless)`;
        tuningRootPC = virtualRoot;
        virtualRootMode = true;
    }

    const lowestPC = sortedPitches[0].semi % 12;
    const relSortedPCs = uniquePCs.map(pc => (pc - rootPC + 12) % 12).sort((a, b) => a - b);
    const invIdx = relSortedPCs.indexOf((lowestPC - rootPC + 12) % 12);
    
    const invNames = ["Root Position", "1st Inversion", "2nd Inversion", "3rd Inversion"];
    let invName = invNames[invIdx] || `${invIdx} Inversion`;
    if (virtualRootMode) {
        invName = invNames[(invIdx + 1) % 4] || "Inversion";
    }

    const offsets = tuningStyle === "pythagorean" ? PYTH_OFFSETS : (tuningStyle === "equal" ? {} : JUST_OFFSETS);
    const voiceRoles = pObjs.map(p => {
        let diff = (p.semi % 12 - tuningRootPC + 12) % 12;
        let role = ROLE_MAP[diff];
        if (virtualRootMode && diff === 2) role = "Ninth";
        return { name: p.name, semi: p.semi, role: role, rawOffset: offsets[role] || 0.0, idx: p.idx };
    });

    const rootPitch = virtualRootMode ? (tuningRootPC + 4) % 12 : rootPC;
    const rootRoleObj = voiceRoles.find(v => (v.semi % 12) === rootPitch);
    const rootOffset = rootRoleObj ? rootRoleObj.rawOffset : 0.0;

    // Redirects the same subtraction above to whichever voice is the chosen pin, instead of
    // always the root -- 'root' keeps today's exact behavior (rootOffset, matched by pitch class,
    // wherever the root is actually voiced); a specific part looks up by .idx, which already
    // survives resting-voice gaps correctly (see the pObjs mapping's own comment above). Falls
    // back to rootOffset -- the same value an unmatched root already fell back to -- when the
    // requested voice isn't present at all (e.g. pin="tenor" on a 3-voice chord).
    let pinOffset = rootOffset;
    if (pin !== 'root') {
        const pinIdx = ['bass', 'bari', 'lead', 'tenor'].indexOf(pin);
        const pinVoice = voiceRoles.find(v => v.idx === pinIdx);
        if (pinVoice) pinOffset = pinVoice.rawOffset;
    }

    return {
        common_name: (tuningStyle === 'just' && !virtualRootMode && !bestMatch.name.includes("triad")) ?
                      getKeyAwarePCName(rootPC, keyFifths) + " " + bestMatch.name.toLowerCase() :
                      (bestMatch.name.includes("triad") ? getKeyAwarePCName(rootPC, keyFifths) + "-" + bestMatch.name.toLowerCase() : bestMatch.name),
        inversion: invName,
        voicing: currentVoicing,
        notes: voiceRoles.map(v => ({
            part: ["Bass", "Bari", "Lead", "Tenor"][v.idx],
            note: v.name,
            role: v.role,
            tuning: tuningStyle === "equal" ? 0.0 : Math.round((v.rawOffset - pinOffset) * 10) / 10
        })),
        roman_numeral: romanNumeral,
    };
}

// Exported (plan.md §10.9) so the chord-picker UI can label a search result ("C minor seventh")
// without a second hardcoded copy of this table.
export function getPCName(pc) {
    return ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][pc];
}

// Circle-of-fifths order a key signature adds sharps/flats in -- standard convention, not
// something specific to this app. Indexed by natural step letter so a sharp/flat can be applied
// directly to that letter's own natural pitch class below.
const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];
const NATURAL_STEP_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** The 7 pitch classes belonging to a key signature (plan.md §23) -- mode-agnostic on purpose,
    since `keyFifths` alone can't distinguish a major key from its relative minor (same
    signature, e.g. 1 sharp is either G major or E minor) and this app doesn't track mode
    separately. [keyFifths] follows MusicXML's own convention (positive = sharps, negative =
    flats, matching ScoreMetadata.keyFifths). Reusable beyond the chord-picker ranking this was
    built for -- also what a real fix for the enharmonic-spelling-ignores-key gap (plan.md §15)
    would need. */
export function getKeyDiatonicPitchClasses(keyFifths) {
    const pcs = { ...NATURAL_STEP_PC };
    if (keyFifths > 0) {
        for (let i = 0; i < keyFifths && i < SHARP_ORDER.length; i++) {
            const step = SHARP_ORDER[i];
            pcs[step] = (pcs[step] + 1 + 12) % 12;
        }
    } else if (keyFifths < 0) {
        for (let i = 0; i < -keyFifths && i < FLAT_ORDER.length; i++) {
            const step = FLAT_ORDER[i];
            pcs[step] = (pcs[step] - 1 + 12) % 12;
        }
    }
    return new Set(Object.values(pcs));
}

/** How many of [pitchClasses] fall outside the key signature's own 7-note collection -- 0 means
    fully diatonic ("in-key"), used as the chromatic-ness measure for chord-picker ranking
    (plan.md §23). */
export function countChromaticPitchClasses(pitchClasses, keyFifths) {
    const diatonic = getKeyDiatonicPitchClasses(keyFifths);
    return pitchClasses.filter(pc => !diatonic.has(((pc % 12) + 12) % 12)).length;
}

/** Resolves the key signature (a `keyFifths` int) actually in effect at [beat], given a piece's
    full [keyChanges] list -- `[{atBeat, keyFifths}, ...]`, sorted ascending, as produced by the
    Kotlin engine's `ScoreMetadata.keyChanges` (plan.md §26, mid-piece key signature changes).
    Used by the chord picker to rank a chord against the key actually active where it sits in the
    piece, rather than the score's beat-0 key for every chord regardless of position. */
export function keyFifthsAtBeat(keyChanges, beat) {
    let active = keyChanges[0]?.keyFifths ?? 0;
    for (const change of keyChanges) {
        if (change.atBeat <= beat + 1e-9) active = change.keyFifths;
        else break;
    }
    return active;
}

/** Mode equivalent of [keyFifthsAtBeat] (plan.md §46) -- resolves the "major"/"minor" mode
    actually in effect at [beat] from the same `keyChanges` list. A missing `.mode` on an entry
    (a document persisted before this field existed) falls back to 'major', same default
    [KeyChange] itself uses. */
export function keyModeAtBeat(keyChanges, beat) {
    let active = keyChanges[0]?.mode ?? 'major';
    for (const change of keyChanges) {
        if (change.atBeat <= beat + 1e-9) active = change.mode || 'major';
        else break;
    }
    return active;
}

// Two full 12-entry fallback spelling tables (all-sharp / all-flat), built once by inverting
// NATURAL_STEP_PC -- every natural step spells its own pitch class exactly (pass 1); each of the
// 5 remaining "black key" pitch classes is spelled as the natural step below it, raised (sharp
// table), or the natural step above it, lowered (flat table) (pass 2, guarded so it never
// overwrites a natural). Used below for pitch classes outside a key's own 7-note diatonic
// collection (plan.md §15).
const SHARP_SPELLING_BY_PC = {};
const FLAT_SPELLING_BY_PC = {};
Object.entries(NATURAL_STEP_PC).forEach(([step, pc]) => {
    SHARP_SPELLING_BY_PC[pc] = { step, alter: 0 };
    FLAT_SPELLING_BY_PC[pc] = { step, alter: 0 };
});
Object.entries(NATURAL_STEP_PC).forEach(([step, pc]) => {
    const upPc = (pc + 1) % 12;
    if (!(upPc in SHARP_SPELLING_BY_PC)) SHARP_SPELLING_BY_PC[upPc] = { step, alter: 1 };
    const downPc = (pc - 1 + 12) % 12;
    if (!(downPc in FLAT_SPELLING_BY_PC)) FLAT_SPELLING_BY_PC[downPc] = { step, alter: -1 };
});

/** For each of a key's 7 diatonic pitch classes, the exact `{step, alter}` spelling that key's
    own signature implies -- e.g. for Db major (keyFifths=-5), pitch class 1 spells as
    `{step:'d', alter:-1}` (Db), not a generic "nearest black key" guess. Companion to
    [getKeyDiatonicPitchClasses], which only tracks set membership -- this keeps the letter
    identity too (plan.md §15). Same sharp/flat walk, just building a full `{step, alter}` object
    per step instead of collecting only the resulting pitch classes into a `Set`. */
function getKeyDiatonicSpellingByPC(keyFifths) {
    const alterByStep = { c: 0, d: 0, e: 0, f: 0, g: 0, a: 0, b: 0 };
    if (keyFifths > 0) {
        for (let i = 0; i < keyFifths && i < SHARP_ORDER.length; i++) alterByStep[SHARP_ORDER[i]] = 1;
    } else if (keyFifths < 0) {
        for (let i = 0; i < -keyFifths && i < FLAT_ORDER.length; i++) alterByStep[FLAT_ORDER[i]] = -1;
    }
    const byPC = {};
    Object.entries(NATURAL_STEP_PC).forEach(([step, naturalPC]) => {
        const alter = alterByStep[step];
        const pc = ((naturalPC + alter) % 12 + 12) % 12;
        byPC[pc] = { step, alter };
    });
    return byPC;
}

/** Key-aware version of [getPCName] (plan.md §15) -- fixes the reported bug where a Db-major
    triad displayed as "C#-major triad" on `/score`. For `keyFifths === 0` (or omitted -- the
    common no-key-context case, e.g. the standalone Chord page, which has no key-signature concept
    at all) this returns *exactly* what [getPCName] does, byte-for-byte, so nothing changes for
    existing callers that don't pass a key. For a real key: one of the 7 diatonic pitch classes
    gets the exact spelling that key's signature implies ([getKeyDiatonicSpellingByPC]); the
    remaining 5 chromatic pitch classes get the key's overall sharp/flat bias -- flat keys spell
    chromatics with flats, sharp keys with sharps, the "standard approach" this section's own
    plan.md text already named. */
export function getKeyAwarePCName(pc, keyFifths = 0) {
    if (!keyFifths) return getPCName(pc);
    const diatonic = getKeyDiatonicSpellingByPC(keyFifths);
    const spelling = diatonic[pc] || (keyFifths < 0 ? FLAT_SPELLING_BY_PC[pc] : SHARP_SPELLING_BY_PC[pc]);
    return spelling.step.toUpperCase() + ACC_TO_STR[spelling.alter];
}

/** Human-readable key name, e.g. "G major"/"E minor" (plan.md §46) -- powers the /score summary
    line and the per-key-change callout rows. No new per-fifths name table needed: the relative-
    minor tonic is always the major tonic + 9 semitones, and getKeyAwarePCName already spells any
    pitch class correctly for a given keyFifths signature (plan.md §15), so this just composes it. */
export function getKeyName(keyFifths, mode = 'major') {
    const majorTonicPC = ((7 * keyFifths) % 12 + 12) % 12;
    const tonicPC = mode === 'minor' ? (majorTonicPC + 9) % 12 : majorTonicPC;
    return `${getKeyAwarePCName(tonicPC, keyFifths)} ${mode === 'minor' ? 'minor' : 'major'}`;
}

// Major-key scale-degree semitone offsets from the tonic (plan.md §34) -- root-finding/chromatic-
// alteration math always runs relative to the MAJOR tonic, even for a minor-mode key (plan.md §46).
// This is deliberate, not an oversight: natural minor shares the *exact same 7 pitch classes* as
// its relative major, only the tonic (starting point) differs, so re-deriving a whole separate
// natural-minor-steps table and a second closest-step search would just recompute the identical
// answer a different way. getRomanNumeral()/parseRomanNumeral() below instead apply a mode-
// conditional *rotation* to the already-correct degreeIdx this table produces -- see MINOR_ROTATE.
const MAJOR_SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11];
const DEGREE_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
// Major's own scale-degree-6 (index 5, "VI") is its relative minor's own tonic ("i", index 0) --
// e.g. C major's VI is A, and A minor's own tonic is A. Rotating a major-tonic-relative degreeIdx
// by this amount (mod 7) relabels it in the relative minor's own numbering without touching the
// underlying MAJOR_SCALE_STEPS search at all -- see getRomanNumeral()/parseRomanNumeral() below.
const MINOR_ROTATE = 5;

// Case + suffix per chord quality (plan.md §34), keyed by the exact same CHORD_PATTERNS pattern
// strings analyzeChord() already matches against -- no separate chord-shape detection needed.
const ROMAN_NUMERAL_QUALITY = {
    "0,4,7": { upper: true, suffix: "" },
    "0,3,7": { upper: false, suffix: "" },
    "0,4,7,10": { upper: true, suffix: "7" },
    "0,3,6,10": { upper: false, suffix: "ø7" }, // ø7 -- half-diminished
    "0,3,6,9": { upper: false, suffix: "°7" }, // °7 -- diminished
    "0,4,7,11": { upper: true, suffix: "maj7" },
    "0,3,7,10": { upper: false, suffix: "7" },
    "0,4,8": { upper: true, suffix: "+" },
    "0,2,4,10": { upper: true, suffix: "9" },
};

/** Roman-numeral analysis of a chord's root against a key (plan.md §34, mode added §46) -- e.g.
    "V7", "vi", "bVIImaj7". Root-finding/chromatic-alteration math always runs relative to the
    MAJOR tonic (see [MAJOR_SCALE_STEPS]'s own comment); [mode] only relabels which degree name the
    result gets, via [MINOR_ROTATE] -- e.g. for a piece really in E minor (keyFifths=1, same
    signature as G major), its own tonic chord now correctly reads "i", not G major's "vi". The
    tonic pitch class comes from the standard circle-of-fifths formula, not a lookup table.
    [patternKey] is the same `CHORD_PATTERNS` key `analyzeChord()` already matched (e.g. "0,4,7")
    -- returns `null` for a chord quality with no entry in [ROMAN_NUMERAL_QUALITY] (this app's
    vocabulary doesn't cover every possible shape, matching the rest of this app's "no guessed-
    wrong label" philosophy).
    On a tie between two equally-close scale steps (the 5 chromatic pitch classes, each exactly
    one semitone from two different diatonic neighbors), this prefers flattening the *higher*
    step -- e.g. a pitch class between II and III becomes "bIII", not "#II". That matches standard
    convention for 4 of the 5 possible ties (bII/bIII/bVI/bVII are all common borrowed-chord
    labels); the 5th (between IV and V) resolves to "bV" rather than the arguably-more-traditional
    "#IV" -- a deliberate, documented simplification (one consistent tie-break rule beats
    special-casing a single chord), not an oversight. */
export function getRomanNumeral(rootPC, patternKey, keyFifths = 0, mode = 'major') {
    const quality = ROMAN_NUMERAL_QUALITY[patternKey];
    if (!quality) return null;
    const tonicPC = ((7 * keyFifths) % 12 + 12) % 12;
    const semisFromTonic = ((rootPC - tonicPC) % 12 + 12) % 12;
    let degreeIdx = 0;
    let alteration = 0;
    let bestAbsDiff = Infinity;
    for (let i = 0; i < MAJOR_SCALE_STEPS.length; i++) {
        const diff = semisFromTonic - MAJOR_SCALE_STEPS[i];
        const absDiff = Math.abs(diff);
        // <= (not <): on a tie, keep overwriting through to the *later* (higher) scale step, so
        // the tie resolves as a flat on that step rather than a sharp on the earlier one.
        if (absDiff <= bestAbsDiff) {
            degreeIdx = i;
            alteration = diff;
            bestAbsDiff = absDiff;
        }
    }
    const accidental = alteration > 0 ? '#'.repeat(alteration) : alteration < 0 ? 'b'.repeat(-alteration) : '';
    // Relabeling only -- the accidental above is computed relative to the MAJOR scale step
    // regardless of mode (it measures "how far this chord's root deviates from that particular
    // major scale step," not what we call the step), so it stays valid unchanged. Case (upper/
    // lower) and suffix also stay mode-independent: they come from the chord's actually-detected
    // quality, not an assumed scale -- this is also why a harmonic-minor V chord (a major triad,
    // via a raised leading tone) still correctly labels "V" uppercase: the chord's *root* pitch
    // class (scale degree 5) is unaffected by that alteration, only its quality is.
    const labelIdx = mode === 'minor' ? ((degreeIdx - MINOR_ROTATE) % 7 + 7) % 7 : degreeIdx;
    const numeral = quality.upper ? DEGREE_NUMERALS[labelIdx] : DEGREE_NUMERALS[labelIdx].toLowerCase();
    return accidental + numeral + quality.suffix;
}

// Reverse index of ROMAN_NUMERAL_QUALITY, built once at module load so parseRomanNumeral() below
// doesn't hand-roll a second copy of "which (case, suffix) means which quality" (plan.md §40.3).
// Confirmed every one of the 9 CHORD_PATTERNS entries maps to a *distinct* (upper, suffix) pair --
// e.g. dominant seventh's "7" suffix is uppercase-only ("V7"), minor seventh's identical "7"
// suffix is lowercase-only ("ii7"), so case + suffix together are always unambiguous.
const ROMAN_NUMERAL_QUALITY_BY_CASE_AND_SUFFIX = {};
Object.entries(ROMAN_NUMERAL_QUALITY).forEach(([patternKey, quality]) => {
    ROMAN_NUMERAL_QUALITY_BY_CASE_AND_SUFFIX[`${quality.upper}:${quality.suffix}`] = patternKey;
});

// Longest-first within each case so "VII"/"vii" aren't mistaken for a prefix match against
// "VI"/"vi" or "V"/"v" -- same numerals as DEGREE_NUMERALS, just ordered for regex matching.
const ROMAN_NUMERALS_LONGEST_FIRST = ['VII', 'VI', 'IV', 'III', 'II', 'I', 'V'];
const ROMAN_NUMERAL_PARSE_RE = new RegExp(
    `^(b+|#+)?(${ROMAN_NUMERALS_LONGEST_FIRST.join('|')}|${ROMAN_NUMERALS_LONGEST_FIRST.map(n => n.toLowerCase()).join('|')})(.*)$`
);

/** The inverse of getRomanNumeral() (plan.md §40.3, mode added §46) -- "ii7" + a key -> { rootPc,
    pattern }, so a pillar chord can be declared by scale degree alone (Mike's own example: "I know
    I want the pillar chord for measure 4 to be a ii7 chord") with no notes entered anywhere yet.
    [mode] un-rotates the parsed degree back into the major-tonic-relative frame
    MAJOR_SCALE_STEPS expects (the mirror image of getRomanNumeral()'s own [MINOR_ROTATE] step) --
    e.g. "i" under mode='minor' resolves to the *relative minor's* own tonic, not major's I.
    Returns `null` for anything unparseable or outside this app's Roman-numeral vocabulary -- same
    "no guessed-wrong answer" policy as getRomanNumeral()/parseChordName() themselves. */
export function parseRomanNumeral(text, keyFifths = 0, mode = 'major') {
    const trimmed = (text || '').trim();
    const m = trimmed.match(ROMAN_NUMERAL_PARSE_RE);
    if (!m) return null;
    const [, accidentalStr, numeralStr, suffix] = m;
    const upper = numeralStr === numeralStr.toUpperCase();
    const parsedIdx = DEGREE_NUMERALS.indexOf(numeralStr.toUpperCase());
    const degreeIdx = mode === 'minor' ? (parsedIdx + MINOR_ROTATE) % 7 : parsedIdx;
    const patternKey = ROMAN_NUMERAL_QUALITY_BY_CASE_AND_SUFFIX[`${upper}:${suffix}`];
    if (patternKey === undefined) return null;

    const accidental = (accidentalStr || '').split('').reduce((sum, ch) => sum + (ch === '#' ? 1 : -1), 0);
    const tonicPC = ((7 * keyFifths) % 12 + 12) % 12;
    const rootPc = ((tonicPC + MAJOR_SCALE_STEPS[degreeIdx] + accidental) % 12 + 12) % 12;
    return { rootPc, pattern: patternKey };
}

/** The pitch classes (0-11) belonging to a chord quality+root -- e.g. ("0,4,7", 0) -> [0,4,7]
    (plan.md §40.3). Trivial, but exported so callers (checkPillarConsistency below,
    voicing-generator.js's own combinatorial search) don't each hand-roll the same one-liner. */
export function chordPitchClasses(pattern, rootPc) {
    return [...new Set(pattern.split(',').map(o => ((rootPc + Number(o)) % 12 + 12) % 12))];
}

/** Whether a chord's *already-entered* notes are consistent with an active pillar chord (plan.md
    §40.3) -- Mike's own definition: if every voice that's already been sung is a chord tone of
    the pillar, "all you have to pick is the voicing"; if not, something else is going on. Only
    sounding (non-resting) voices are checked -- a voice nobody's entered yet has nothing to be
    consistent or inconsistent *with*. Returns 'undetermined' when nothing at all has been
    entered (not 'consistent' -- an empty chord isn't evidence of anything). */
export function checkPillarConsistency(voices, pillarPitchClasses) {
    const sounding = (voices || []).filter(v => v && !v.rest);
    if (sounding.length === 0) return 'undetermined';
    const allMatch = sounding.every(v => pillarPitchClasses.includes(((getAbsSemitone(v) % 12) + 12) % 12));
    return allMatch ? 'consistent' : 'inconsistent';
}