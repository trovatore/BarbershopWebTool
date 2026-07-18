export const SERIAL = "#022";
export const STEP_TO_SEMI = { 'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11 };
export const ACC_TO_STR = { "-2": "bb", "-1": "b", "0": "", "1": "#", "2": "x" };
export const STR_TO_ACC = { "bb": -2, "b": -1, "": 0, "#": 1, "x": 2 };

// Preference: Natural (0) > Flat (-1) > Sharp (1) > Double-Flat (-2) > Double-Sharp (2)
const ACC_PREFERENCE = { "0": 0, "-1": 1, "1": 2, "-2": 3, "2": 4 };

export function getAbsSemitone(noteObj) {
    if (!noteObj) return 0;
    return (Number(noteObj.oct) * 12) + STEP_TO_SEMI[noteObj.step] + Number(noteObj.acc);
}

export function getVariations(targetSemi, currentOct, existingNotes) {
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

        // 2. Accidental Preference Priority
        const prefA = ACC_PREFERENCE[String(a.acc)] !== undefined ? ACC_PREFERENCE[String(a.acc)] : 99;
        const prefB = ACC_PREFERENCE[String(b.acc)] !== undefined ? ACC_PREFERENCE[String(b.acc)] : 99;
        
        return prefA - prefB;
    });
}