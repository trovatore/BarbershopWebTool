export const SERIAL = "#023";
export const STEP_TO_SEMI = { 'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11 };
export const ACC_TO_STR = { "-2": "bb", "-1": "b", "0": "", "1": "#", "2": "x" };
export const STR_TO_ACC = { "bb": -2, "b": -1, "": 0, "#": 1, "x": 2 };

// Preference: Natural (0) > Flat (-1) > Sharp (1) > Double-Flat (-2) > Double-Sharp (2)
const ACC_PREFERENCE = { "0": 0, "-1": 1, "1": 2, "-2": 3, "2": 4 };

// Circle-of-fifths order a key signature adds sharps/flats in (plan.md §33) -- duplicated from
// theory.js's own copy, not imported: theory.js already imports getAbsSemitone/ACC_TO_STR *from*
// this file, so importing the reverse direction would create a circular dependency. Keep these
// two copies in sync if either changes, same discipline as JUST_OFFSETS/PYTH_OFFSETS between
// theory.js and ChordLabel.kt. (STEP_TO_SEMI above already doubles as the natural-step-pc map
// theory.js calls NATURAL_STEP_PC -- identical keys/values, no third copy needed.)
const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];

/** Which of the 7 letter-steps a key signature of `keyFifths` alters, and by how much (plan.md
    §44 item 2) -- {c,d,e,f,g,a,b} each 0/1/-1. Exported so notation.js's per-note accidental
    decision can ask "does the key signature already cover this?" instead of duplicating
    SHARP_ORDER/FLAT_ORDER a third time; getKeyPreferredSpelling() below is rebuilt on top of it
    too, rather than keeping its own copy of the same loop. */
export function keySignatureAlterations(keyFifths) {
    const alterByStep = { c: 0, d: 0, e: 0, f: 0, g: 0, a: 0, b: 0 };
    if (keyFifths > 0) {
        for (let i = 0; i < keyFifths && i < SHARP_ORDER.length; i++) alterByStep[SHARP_ORDER[i]] = 1;
    } else if (keyFifths < 0) {
        for (let i = 0; i < -keyFifths && i < FLAT_ORDER.length; i++) alterByStep[FLAT_ORDER[i]] = -1;
    }
    return alterByStep;
}

// Two full 12-entry fallback spelling tables (all-sharp / all-flat), built once by inverting
// STEP_TO_SEMI -- mirrors theory.js's SHARP_SPELLING_BY_PC/FLAT_SPELLING_BY_PC exactly. Every
// natural step spells its own pitch class exactly (pass 1); each of the 5 remaining "black key"
// pitch classes is spelled as the natural step below it, raised (sharp table), or the natural
// step above it, lowered (flat table) (pass 2, guarded so it never overwrites a natural).
const SHARP_SPELLING_BY_PC = {};
const FLAT_SPELLING_BY_PC = {};
Object.entries(STEP_TO_SEMI).forEach(([step, pc]) => {
    SHARP_SPELLING_BY_PC[pc] = { step, acc: 0 };
    FLAT_SPELLING_BY_PC[pc] = { step, acc: 0 };
});
Object.entries(STEP_TO_SEMI).forEach(([step, pc]) => {
    const upPc = (pc + 1) % 12;
    if (!(upPc in SHARP_SPELLING_BY_PC)) SHARP_SPELLING_BY_PC[upPc] = { step, acc: 1 };
    const downPc = (pc - 1 + 12) % 12;
    if (!(downPc in FLAT_SPELLING_BY_PC)) FLAT_SPELLING_BY_PC[downPc] = { step, acc: -1 };
});

/** The key-preferred `{step, acc}` spelling for a pitch class (plan.md §33) -- mirrors
    theory.js's `getKeyAwarePCName`'s own logic, just returning the structured pair instead of a
    formatted string. One of the key's 7 diatonic pitch classes gets the exact spelling that
    key's signature implies; the remaining 5 chromatic pitch classes get the key's overall
    sharp/flat bias. Used by getVariations() below to break a tie between two otherwise-equal
    candidate spellings -- e.g. this is what makes D major's own diatonic F# actually win over
    Gb, which the old key-agnostic tie-break (a blanket flat-over-sharp preference) got wrong for
    any sharp key. */
function getKeyPreferredSpelling(pc, keyFifths) {
    const alterByStep = keySignatureAlterations(keyFifths);
    for (const [step, naturalPc] of Object.entries(STEP_TO_SEMI)) {
        const alter = alterByStep[step];
        const candidatePc = ((naturalPc + alter) % 12 + 12) % 12;
        if (candidatePc === pc) return { step, acc: alter };
    }
    return keyFifths < 0 ? FLAT_SPELLING_BY_PC[pc] : SHARP_SPELLING_BY_PC[pc];
}

export function getAbsSemitone(noteObj) {
    if (!noteObj) return 0;
    return (Number(noteObj.oct) * 12) + STEP_TO_SEMI[noteObj.step] + Number(noteObj.acc);
}

export function getVariations(targetSemi, currentOct, existingNotes, keyFifths = 0) {
    const tSemi = Number(targetSemi);
    const notes = existingNotes || [];
    const steps = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
    const variations = [];
    
    steps.forEach(s => {
        for (let o = currentOct - 1; o <= currentOct + 1; o++) {
            let acc = tSemi - (o * 12 + STEP_TO_SEMI[s]);
            if (Math.abs(acc) <= 2) {
                variations.push({ step: s, acc: acc, oct: o });
            }
        }
    });

    return variations.sort((a, b) => {
        // 1. False Relation Priority
        // Count how many other voices this spelling clashes with.
        // A clash is same letter name but different pitch ignoring octave.
        const getFalseCount = (v) => {
            let count = 0;
            notes.forEach(other => {
                if (other.step === v.step && (Number(other.semi)-tSemi) % 12 !== 0) {
                    count++;
                }
            });
            return count;
        };

        const aFalse = getFalseCount(a);
        const bFalse = getFalseCount(b);

        if (aFalse !== bFalse) {
            return aFalse - bFalse; // Fewer false relations (0) come first
        }

        // 2. Key Preference Priority (plan.md §33) -- only when a key signature is actually
        // given; keyFifths=0 (the default) skips this tier entirely, so every existing caller
        // that doesn't pass a key sees zero behavior change. Sits between false-relation
        // avoidance (a stronger signal -- a key preference shouldn't override avoiding a visual
        // clash) and the old blanket accidental-type tiebreak below, which this tier is meant to
        // correct for: that tiebreak always ranks flat over sharp regardless of context, which
        // is wrong for any sharp key (e.g. D major's own diatonic F#, which it would otherwise
        // misspell as Gb).
        if (keyFifths) {
            const preferred = getKeyPreferredSpelling(((tSemi % 12) + 12) % 12, keyFifths);
            const aMatches = a.step === preferred.step && a.acc === preferred.acc;
            const bMatches = b.step === preferred.step && b.acc === preferred.acc;
            if (aMatches !== bMatches) return aMatches ? -1 : 1;
        }

        // 3. Accidental Preference Priority
        const prefA = ACC_PREFERENCE[String(a.acc)] !== undefined ? ACC_PREFERENCE[String(a.acc)] : 99;
        const prefB = ACC_PREFERENCE[String(b.acc)] !== undefined ? ACC_PREFERENCE[String(b.acc)] : 99;
        
        return prefA - prefB;
    });
}