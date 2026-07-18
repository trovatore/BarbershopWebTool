/* theory.js Serial: #004 */
import { getAbsSemitone } from './spelling.js';

export const SERIAL = "#004";

const CHORD_PATTERNS = {
    "0,4,7": { name: "Major triad", type: "triad" },
    "0,3,7": { name: "Minor triad", type: "triad" },
    "0,4,7,10": { name: "Dominant seventh", type: "seventh" },
    "0,3,6,10": { name: "Half-diminished seventh", type: "seventh" },
    "0,3,6,9": { name: "Diminished seventh", type: "seventh" },
    "0,4,7,11": { name: "Major seventh", type: "seventh" },
    "0,3,7,10": { name: "Minor seventh", type: "seventh" },
    "0,4,8": { name: "Augmented triad", type: "triad" }
};

const ROLE_MAP = {
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
    
    const pObjs = notes.map(n => {
        const match = n.match(/^([a-gA-G])(bb|b|#|x)?([0-8])$/i);
        if (!match) return null;
        const stepMap = { 'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11 };
        const acc = match[2] ? (match[2] === 'x' ? 2 : (match[2] === 'bb' ? -2 : (match[2] === '#' ? 1 : -1))) : 0;
        return { name: n, semi: (parseInt(match[3]) * 12) + stepMap[match[1].toLowerCase()] + acc };
    }).filter(p => p !== null);

    if (pObjs.length === 0) return { common_name: "Unknown Chord", inversion: "N/A", voicing: "N/A", notes: [] };

    const sortedPitches = [...pObjs].sort((a, b) => a.semi - b.semi);
    const span = sortedPitches[sortedPitches.length - 1].semi - sortedPitches[0].semi;
    const currentVoicing = span <= 12 ? "Closed" : "Open";

    if (pObjs.length < 3) return { common_name: "Unknown Chord", inversion: "N/A", voicing: currentVoicing, notes: [] };

    const uniquePCs = [...new Set(sortedPitches.map(p => p.semi % 12))];
    let bestMatch = null;
    let rootPC = -1;

    for (let pc of uniquePCs) {
        const pattern = uniquePCs.map(x => (x - pc + 12) % 12).sort((a, b) => a - b).join(',');
        if (CHORD_PATTERNS[pattern]) {
            bestMatch = { ...CHORD_PATTERNS[pattern] };
            rootPC = pc;
            break;
        }
    }

    if (!bestMatch) return { common_name: "Unknown Chord", inversion: "N/A", voicing: currentVoicing, notes: [] };

    let tuningRootPC = rootPC;
    let virtualRootMode = false;
    if (bestMatch.name === "Half-diminished seventh" && allowRootless) {
        const virtualRoot = (rootPC - 4 + 12) % 12;
        bestMatch.name = `${getPCName(virtualRoot)} dominant 9th chord (rootless)`;
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
        return { name: p.name, semi: p.semi, role: role, rawOffset: offsets[role] || 0.0 };
    });

    const rootPitch = virtualRootMode ? (tuningRootPC + 4) % 12 : rootPC;
    const rootRoleObj = voiceRoles.find(v => (v.semi % 12) === rootPitch);
    const rootOffset = rootRoleObj ? rootRoleObj.rawOffset : 0.0;
    
    return {
        common_name: (tuningStyle === 'just' && !virtualRootMode && !bestMatch.name.includes("triad")) ? 
                      getPCName(rootPC) + " " + bestMatch.name.toLowerCase() : 
                      (bestMatch.name.includes("triad") ? getPCName(rootPC) + "-" + bestMatch.name.toLowerCase() : bestMatch.name),
        inversion: invName,
        voicing: currentVoicing,
        notes: voiceRoles.map((v, i) => ({
            part: ["Bass", "Bari", "Lead", "Tenor"][i],
            note: v.name,
            role: v.role,
            tuning: tuningStyle === "equal" ? 0.0 : Math.round((v.rawOffset - rootOffset) * 10) / 10
        }))
    };
}

function getPCName(pc) {
    return ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][pc];
}