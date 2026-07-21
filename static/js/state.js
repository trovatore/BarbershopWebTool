/* state.js Serial: #012 */
import { STR_TO_ACC, ACC_TO_STR } from './spelling.js';
import { readScoreDocument, writeScoreDocument, SCORE_STORAGE_KEY } from './score-store.js';
import { readChordDocument, writeChordDocument, CHORD_STORAGE_KEY } from './chord-store.js';
import { createDocumentStore } from './document-store.js';

// This tab's own store instance for reading score:current's dirty state (plan.md §10.7.4) --
// never used for undo/redo here (a ?sid= Chord-editor tab's undo stack is local to that one
// chord's fields, a different concern from the Score document's own import/export baseline; see
// isScoreDocumentDirty() below and syncChordToScoreDocument() further down).
const scoreDocStore = createDocumentStore(SCORE_STORAGE_KEY);

// The standalone Chord page's own document (plan.md §10.7.1) -- only relevant when this tab
// isn't live-editing a Score chord via ?sid= (see isChordDocumentDirty/syncChordToStandaloneDocument).
const chordDocStore = createDocumentStore(CHORD_STORAGE_KEY);

export const VOWEL_PRESETS_LEGACY = {
    'i': [270, 2290, 3010], 'y': [270, 1800, 2300], 'ɪ': [390, 1990, 2550],
    'e': [390, 2300, 2850], 'ɛ': [530, 1840, 2480], 'æ': [660, 1720, 2410],
    'a': [730, 1090, 2440], 'ə': [500, 1500, 2500], 'ʌ': [640, 1190, 2390],
    'ɑ': [700, 1100, 2400], 'ɒ': [600, 900, 2400], 'ɔ': [570, 840, 2410],
    'o': [460, 1100, 2490], 'ʊ': [440, 1020, 2240], 'u': [300, 870, 2240],
    'ɚ': [500, 1400, 1600], 'ɑ˞': [700, 1100, 1600], 'ɔ˞': [570, 840, 1600]
};

export const VOWEL_PRESETS_EAR = {
    'i': [270, 2290, 3010], 'y': [270, 1800, 2300], 'ɪ': [390, 1990, 2550],
    'e': [480, 2000, 2600], 'ɛ': [530, 1840, 2480], 'æ': [660, 1720, 2410],
    'a': [730, 1090, 2440], 'ə': [500, 1500, 2500], 'ʌ': [640, 1190, 2390],
    'ɑ': [700, 1100, 2400], 'ɒ': [600, 900, 2400], 'ɔ': [570, 840, 2410],
    'o': [442, 780, 2490], 'ʊ': [440, 1020, 2240], 'u': [300, 750, 1900],
    'ɚ': [500, 1300, 1750], 'ɑ˞': [680, 1250, 1900], 'ɔ˞': [550, 1000, 1900]
};

const AUDIO_MAP = {
    'jc': 'vibratoJitterCutoff',
    'ja': 'vibratoJitterAmount',
    'pj': 'phaseJitter',
    'vd': 'vibratoDepth',
    'rm': 'vibratoRateMean',
    'rr': 'vibratoRateRange',
    'q1': 'q1',
    'q2': 'q2'
};

const PART_PROPS = { 'p': 'ping', 't': 'tilt', '4': 'f4', '5': 'f5' };

export const appState = {
    chords: [{
        voices: [
            { part: 'Bass', step: 'g', acc: 0, oct: 3 },
            { part: 'Bari', step: 'b', acc: 0, oct: 3 },
            { part: 'Lead', step: 'd', acc: 0, oct: 4 },
            { part: 'Tenor', step: 'f', acc: 0, oct: 4 }
        ],
        tuning: [0, 0, 0, 0],
        // Vowel is per-chord (the user's original ask, confirmed 2026-07-12) — formants live
        // alongside it rather than in settings.audio, since the vowel *is* the formant triple.
        vowel: 'a',
        formants: { f1: 730, f2: 1090, f3: 2440 },
        analysis: null
    }],
    activeChordIndex: 0,
    ui: {
        selectedIdx: 2,
        focusedElementId: null,
        analysisId: 0,
        offlineMode: false,
        rootless: false,
        // Set when this tab was opened from a Score row (plan.md §10.2) via ?sid=<chord id>.
        // null means "editing the global default" — see the §8 Q2 labeling this drives.
        editingScoreChordId: null,
        scoreChordPosition: null,
        scoreChordNotFound: false
    },
    settings: {
        intonation: 'just',
        vps: 4,
        duration: 5,
        volume: 0.05,
        presetVersion: 'ear',
        audio: {
            vibratoJitterCutoff: 100, vibratoJitterAmount: 2.5,
            phaseJitter: 0.08, vibratoDepth: 0.006,
            vibratoRateMean: 5.2, vibratoRateRange: 1.2,
            q1: 10, q2: 15
        },
        partSettings: [
            { name: 'Bass', f4: 3500, f5: 4500, ping: 0.0, tilt: 0.0, volume: 1.0, mute: false },
            { name: 'Bari', f4: 3500, f5: 4500, ping: 0.0, tilt: 0.0, volume: 1.0, mute: false },
            { name: 'Lead', f4: 3500, f5: 4500, ping: 0.0, tilt: 0.0, volume: 1.0, mute: false },
            { name: 'Tenor', f4: 3500, f5: 4500, ping: 0.0, tilt: 0.0, volume: 1.0, mute: false }
        ]
    }
};

export function getNoteString(obj) { 
    if (!obj || !obj.step) return "";
    return obj.step + (ACC_TO_STR[obj.acc] || "") + (obj.oct ?? ""); 
}

export function syncInputsToState() {
    const chord = appState.chords[appState.activeChordIndex];

    const rToggle = document.getElementById('rootlessToggle');
    if (rToggle) appState.ui.rootless = rToggle.checked;

    const oToggle = document.getElementById('offlineToggle');
    if (oToggle) appState.ui.offlineMode = oToggle.checked;

    const vToggle = document.getElementById('legacyVocalToggle');
    if (vToggle) appState.settings.presetVersion = vToggle.checked ? 'legacy' : 'ear';

    const intRad = document.querySelector('input[name="intonation"]:checked');
    if (intRad) appState.settings.intonation = intRad.value;

    const vowRad = document.querySelector('input[name="vowel"]:checked');
    if (vowRad) chord.vowel = vowRad.value;

    // f1/f2/f3 are per-chord (they ARE the vowel) — kept out of AUDIO_MAP, synced explicitly.
    ['f1', 'f2', 'f3'].forEach(key => {
        const el = document.getElementById(key);
        const nel = document.getElementById('n_' + key);
        if (nel && nel === document.activeElement) {
            chord.formants[key] = parseFloat(nel.value) || 0;
        } else if (el) {
            chord.formants[key] = parseFloat(el.value) || 0;
        }
    });

    const vps = document.getElementById('vpsCount');
    if (vps) appState.settings.vps = parseInt(vps.value) || 4;
    
    const dur = document.getElementById('duration');
    if (dur) appState.settings.duration = parseFloat(dur.value) || 5;
    
    const vol = document.getElementById('volume');
    if (vol) appState.settings.volume = parseFloat(vol.value) || 0.05;
    
    Object.values(AUDIO_MAP).forEach(key => {
        const id = (key === 'q1') ? 'formantQ1' : (key === 'q2' ? 'formantQ2' : key);
        const el = document.getElementById(id);
        const nel = document.getElementById('n_' + id);
        if (nel && nel === document.activeElement) {
            appState.settings.audio[key] = parseFloat(nel.value) || 0;
        } else if (el) {
            appState.settings.audio[key] = parseFloat(el.value) || 0;
        }
    });

    appState.settings.partSettings.forEach((part, i) => {
        const pingEl = document.getElementById(`part-ping-${i}`);
        if (pingEl) part.ping = parseFloat(pingEl.value) || 0;
        const tiltEl = document.getElementById(`part-tilt-${i}`);
        if (tiltEl) part.tilt = parseFloat(tiltEl.value) || 0;
        const f4El = document.getElementById(`part-f4-${i}`);
        if (f4El) part.f4 = parseFloat(f4El.value) || 3500;
        const f5El = document.getElementById(`part-f5-${i}`);
        if (f5El) part.f5 = parseFloat(f5El.value) || 4500;
        const vEl = document.getElementById(`part-vol-${i}`);
        if (vEl) part.volume = parseFloat(vEl.value) || 0;
        const mEl = document.getElementById(`part-mute-${i}`);
        if (mEl) part.mute = mEl.classList.contains('active');
    });
}

export function syncStateToInputs() {
    const chord = appState.chords[appState.activeChordIndex];

    const rToggle = document.getElementById('rootlessToggle');
    if (rToggle) rToggle.checked = appState.ui.rootless;

    const oToggle = document.getElementById('offlineToggle');
    if (oToggle) oToggle.checked = appState.ui.offlineMode;

    const vToggle = document.getElementById('legacyVocalToggle');
    if (vToggle) vToggle.checked = (appState.settings.presetVersion === 'legacy');

    const intRad = document.querySelector(`input[name="intonation"][value="${appState.settings.intonation}"]`);
    if (intRad) intRad.checked = true;

    const vowRad = document.querySelector(`input[name="vowel"][value="${chord.vowel}"]`);
    if (vowRad) vowRad.checked = true;

    ['f1', 'f2', 'f3'].forEach(key => {
        const el = document.getElementById(key);
        const nel = document.getElementById('n_' + key);
        const val = chord.formants[key];

        if (el && document.activeElement !== el) el.value = val;
        if (nel && document.activeElement !== nel) nel.value = val;

        const disp = document.getElementById('v_' + key);
        if (disp) disp.innerText = val + "Hz";
    });

    const vps = document.getElementById('vpsCount');
    if (vps && document.activeElement !== vps) vps.value = appState.settings.vps;
    
    const dur = document.getElementById('duration');
    if (dur && document.activeElement !== dur) dur.value = appState.settings.duration;
    
    const vol = document.getElementById('volume');
    if (vol && document.activeElement !== vol) vol.value = appState.settings.volume;

    Object.entries(AUDIO_MAP).forEach(([code, key]) => {
        const id = (key === 'q1') ? 'formantQ1' : (key === 'q2' ? 'formantQ2' : key);
        const el = document.getElementById(id);
        const nel = document.getElementById('n_' + id);
        const val = appState.settings.audio[key];
        
        if (el && document.activeElement !== el) el.value = val;
        if (nel && document.activeElement !== nel) nel.value = val;

        const disp = document.getElementById('v_' + id);
        if (disp) {
            let suffix = (id.includes('Rate') || id.includes('Cutoff') || (id.startsWith('f') && !id.includes('Q'))) ? "Hz" : (id === 'phaseJitter' ? "s" : "");
            disp.innerText = val + suffix;
        }
    });

    appState.settings.partSettings.forEach((part, i) => {
        ['ping', 'tilt', 'f4', 'f5', 'vol'].forEach(k => {
            const id = `part-${k}-${i}`;
            const el = document.getElementById(id);
            const val = part[k === 'vol' ? 'volume' : k];
            if (el && document.activeElement !== el) el.value = val;

            const disp = document.getElementById('v_' + id);
            if (disp) {
                if (k === 'ping' || k === 'tilt') disp.innerText = val.toFixed(2);
                else if (k === 'f4' || k === 'f5') disp.innerText = Math.round(val) + "Hz";
            }
        });
        const mEl = document.getElementById(`part-mute-${i}`);
        if (mEl) mEl.classList.toggle('active', part.mute);
    });
}

/**
 * Returns false only for a truly first-ever bare visit -- no ?sid=, no ?n=, and nothing in
 * chord:current to resume -- so main.js knows whether it's safe to bless the freshly-computed
 * default chord as "not dirty" once the initial analysis pass settles (establishFreshChordBaseline()
 * below). Every other case returns true, since a real document (resumed, imported, or a live Score
 * chord) already has its own legitimate dirty state that must NOT be silently overwritten.
 */
export function loadStateFromURL() {
    const params = new URLSearchParams(window.location.search);
    const chord = appState.chords[0];

    // Opened from a Score row (plan.md §6.2/§10.2) — the chord's id is the source of truth,
    // read straight from the shared document rather than from URL params (which can't cleanly
    // carry the newer per-chord fields like beats/volumePerPart anyway). Skips the rest of this
    // function's normal param parsing entirely, same as §6.2 originally specified.
    const sid = params.get('sid');
    if (sid) {
        const doc = readScoreDocument();
        const idx = doc ? doc.chords.findIndex(c => c.id === sid) : -1;
        if (doc && idx !== -1) {
            appState.chords[0] = doc.chords[idx];
            appState.ui.editingScoreChordId = sid;
            appState.ui.scoreChordPosition = { index: idx, total: doc.chords.length };
            appState.ui.scoreChordNotFound = false;
        } else {
            appState.ui.editingScoreChordId = sid;
            appState.ui.scoreChordNotFound = true;
        }
        syncStateToInputs();
        return true;
    }

    // A ?n= permalink is an explicit import into the standalone chord:current document (plan.md
    // §10.7.1), replacing whatever was there -- same as choosing a file replaces score:current on
    // /score. If that document has real unsaved edits, confirm before silently discarding them
    // rather than building a separate "undo the import" mechanism (resolved 2026-07-20: prompting
    // before a destructive replace is enough, undo-of-import isn't needed on top of that).
    if (params.has('n') && isChordDocumentDirty() &&
        !window.confirm('This link would replace your current unsaved chord. Load it anyway and discard your changes?')) {
        resumeStandaloneDocument();
        syncStateToInputs();
        return true;
    }

    if (params.has('n')) {
        params.get('n').split(',').forEach((n, i) => {
            if (i < 4) {
                const match = n.match(/^([a-gA-G])(bb|b|#|x)?([0-8])$/i);
                if (match) {
                    chord.voices[i].step = match[1].toLowerCase();
                    chord.voices[i].acc = STR_TO_ACC[match[2] ? match[2].toLowerCase() : ""];
                    chord.voices[i].oct = parseInt(match[3]);
                }
            }
        });
    }
    if (params.has('c')) {
        chord.tuning = params.get('c').split(',').map(val => parseFloat(val) || 0);
    }
    if (params.has('t')) appState.settings.intonation = params.get('t');
    if (params.has('v')) {
        chord.vowel = params.get('v');
        const presets = appState.settings.presetVersion === 'legacy' ? VOWEL_PRESETS_LEGACY : VOWEL_PRESETS_EAR;
        const freqs = presets[chord.vowel];
        if (freqs) [chord.formants.f1, chord.formants.f2, chord.formants.f3] = freqs;
    }
    if (params.has('vps')) appState.settings.vps = parseInt(params.get('vps')) || 4;

    if (params.has('a')) {
        params.get('a').split(',').forEach(pair => {
            const [code, val] = pair.split(':');
            const num = parseFloat(val);
            if (isNaN(num)) return;

            if (code === 'f1' || code === 'f2' || code === 'f3') {
                chord.formants[code] = num;
            } else if (AUDIO_MAP[code]) {
                appState.settings.audio[AUDIO_MAP[code]] = num;
            } else if (code.startsWith('p')) {
                const pIdx = parseInt(code[1]);
                const pProp = PART_PROPS[code[2]];
                if (pIdx < 4 && pProp) appState.settings.partSettings[pIdx][pProp] = num;
            }
        });
    }

    if (params.has('n')) {
        // Import moment (plan.md §10.7.2): resets the dirty baseline to this freshly-loaded chord.
        const snap = chordDocStore.markImported(chord, 'Shared link');
        writeChordDocument({ chord: snap.content, sourceLabel: snap.sourceLabel, sourceSnapshot: snap.sourceSnapshot, updatedAt: snap.updatedAt });
        syncStateToInputs();
        return true;
    }

    // Bare visit, no link -- resume the persisted standalone document if this browser has one
    // (survives refresh, plan.md §10.7.1) instead of always resetting to the hardcoded default.
    const resumed = resumeStandaloneDocument();
    syncStateToInputs();
    return resumed;
}

function resumeStandaloneDocument() {
    const doc = readChordDocument();
    if (doc && doc.chord) {
        appState.chords[0] = doc.chord;
        return true;
    }
    return false;
}

/**
 * Called once, only after the very first analysis pass settles on a truly fresh bare visit (no
 * persisted chord:current to resume -- see loadStateFromURL()'s return value). Without this, the
 * default chord's own auto-computed tuning (a real mutation, synced by
 * syncChordToStandaloneDocument() same as any edit) would read as "unsaved changes" the instant
 * the page loads, before the user has done anything -- exactly the over-triggering-indicator
 * problem this project has hit before elsewhere. Blesses that freshly-computed chord as the
 * baseline instead, same as an import would.
 */
export function establishFreshChordBaseline() {
    if (appState.ui.editingScoreChordId) return;
    const chord = appState.chords[appState.activeChordIndex];
    const snap = chordDocStore.markImported(chord, undefined);
    writeChordDocument({ chord: snap.content, sourceLabel: snap.sourceLabel, sourceSnapshot: snap.sourceSnapshot, updatedAt: snap.updatedAt });
}

/**
 * Whether score:current has diverged from the last file it was imported from or exported to
 * (plan.md §10.7.2/§10.7.4). A ?sid= Chord-editor tab has no dirty concept of its own -- every
 * edit already writes straight into score:current live via syncChordToScoreDocument() below, so
 * this mirrors the *Score* document's own baseline rather than computing an independent one.
 * Not yet called from any UI (that's main.js's job, once the document strip exists) -- exported
 * so that wiring can read it directly instead of re-deriving the comparison.
 */
export function isScoreDocumentDirty() {
    const doc = readScoreDocument();
    if (!doc) return false;
    return scoreDocStore.isDirty({
        content: { chords: doc.chords, metadata: doc.metadata },
        sourceSnapshot: doc.sourceSnapshot,
    });
}

export function syncChordToScoreDocument() {
    if (!appState.ui.editingScoreChordId || appState.ui.scoreChordNotFound) return;
    const doc = readScoreDocument();
    if (!doc) return;
    const idx = doc.chords.findIndex(c => c.id === appState.ui.editingScoreChordId);
    if (idx === -1) return;
    doc.chords[idx] = Object.assign({}, appState.chords[appState.activeChordIndex], { updatedAt: Date.now() });
    doc.updatedAt = Date.now();
    writeScoreDocument(doc);
}

/**
 * Whether chord:current (the standalone Chord page's own document, plan.md §10.7.1) has
 * diverged from the last permalink it was loaded from or exported to. Same "no document at all
 * -> not dirty" rule as isScoreDocumentDirty(): a never-touched default chord isn't "unsaved
 * work" worth protecting, only a real edit that hasn't been exported is. Used both by
 * loadStateFromURL()'s confirm-before-discard guard above and, later, by a document-strip UI.
 */
export function isChordDocumentDirty() {
    const doc = readChordDocument();
    if (!doc) return false;
    return chordDocStore.isDirty({ content: doc.chord, sourceSnapshot: doc.sourceSnapshot });
}

/**
 * Writes the currently-edited chord into chord:current, mirroring syncChordToScoreDocument()'s
 * role but for the standalone case -- called from the same commit points, guarded so the two
 * never fire for the same edit (a tab is either editing a live Score chord or the standalone
 * document, never both, per §10.7.4).
 */
export function syncChordToStandaloneDocument() {
    if (appState.ui.editingScoreChordId) return;
    const existing = readChordDocument();
    writeChordDocument({
        chord: appState.chords[appState.activeChordIndex],
        sourceLabel: existing ? existing.sourceLabel : undefined,
        sourceSnapshot: existing ? existing.sourceSnapshot : undefined,
        updatedAt: Date.now(),
    });
}

export function generatePermalink() {
    const chord = appState.chords[appState.activeChordIndex];
    const p = new URLSearchParams();
    
    p.set('n', chord.voices.map(s => getNoteString(s)).join(','));
    p.set('c', chord.tuning.join(','));
    p.set('t', appState.settings.intonation);
    p.set('v', chord.vowel);
    p.set('vps', appState.settings.vps);

    const packed = [];
    if (chord.vowel === 'custom') {
        ['f1', 'f2', 'f3'].forEach(key => packed.push(`${key}:${chord.formants[key]}`));
    }
    Object.entries(AUDIO_MAP).forEach(([code, key]) => {
        packed.push(`${code}:${appState.settings.audio[key]}`);
    });

    appState.settings.partSettings.forEach((ps, i) => {
        Object.entries(PART_PROPS).forEach(([code, key]) => {
            packed.push(`p${i}${code}:${ps[key]}`);
        });
    });

    p.set('a', packed.join(','));
    
    // A detached snapshot link, distinct from the live `?sid=<id>` link this tab may currently be
    // on (plan.md §10.3 — the two link types needing a visible distinction). Deliberately NOT
    // written into the visible address bar via history.replaceState while a live Score-chord edit
    // is in progress: doing so would silently swap the URL bar away from the live ?sid= link out
    // from under the user, even though the tab keeps editing the live score exactly as before
    // (editingLabel still says so) — a real mismatch between what the address bar shows and
    // what's actually happening. For the ordinary (non-live) case, updating the address bar to
    // match the copied link is still useful and unchanged from before.
    const detachedUrl = window.location.origin + window.location.pathname + '?' + p.toString();
    if (!appState.ui.editingScoreChordId) {
        window.history.replaceState({}, '', detachedUrl);
        // Export moment (plan.md §10.7.2) for the standalone document -- unlike a ?sid= tab's
        // detached-link copy (which deliberately does NOT touch score:current's dirty flag, per
        // §10.7.4), this *is* the standalone chord's own document, so copying its link is a real
        // save point for it.
        const existing = readChordDocument();
        const exportSnap = chordDocStore.markExported({
            content: chord,
            sourceLabel: existing ? existing.sourceLabel : undefined,
        });
        writeChordDocument({ chord, sourceLabel: exportSnap.sourceLabel, sourceSnapshot: exportSnap.sourceSnapshot, updatedAt: exportSnap.updatedAt });
    }

    if (navigator.clipboard) {
        navigator.clipboard.writeText(detachedUrl);
    }

    const btn = document.getElementById('shareBtn');
    if (btn) {
        const oldHtml = btn.innerHTML;
        // Explicit "detached" wording so the copied link never reads as if it were the live
        // Score-chord link, regardless of which tab/mode you clicked it from.
        btn.innerHTML = "<span>✅</span> Copied (detached link)!";
        setTimeout(() => btn.innerHTML = oldHtml, 2000);
    }
}