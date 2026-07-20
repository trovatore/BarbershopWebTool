/* main.js Serial: #067-STABLE */
import { getAbsSemitone, getVariations, STR_TO_ACC, STEP_TO_SEMI, SERIAL as S_SPEL } from './spelling.js';
import { renderControls, handleGlobalKey, SERIAL as S_UI } from './ui-controls.js';
import { drawChord, SERIAL as S_NOT } from './notation.js';
import { playChord, saveChordAsWav, analyzeAndShow, SERIAL as S_AUD } from './audio.js';
import { analyzeChord, SERIAL as S_THY } from './theory.js';
import { appState, syncInputsToState, syncStateToInputs, loadStateFromURL, generatePermalink, getNoteString, syncChordToScoreDocument, VOWEL_PRESETS_LEGACY, VOWEL_PRESETS_EAR } from './state.js';

const S_IDX = "#067-STABLE";
const SHOW_SERIALS = false;

function getAudioSettings() {
    return {
        ...appState.settings.audio,
        ...appState.chords[appState.activeChordIndex].formants,
        partSettings: appState.settings.partSettings,
        vps: appState.settings.vps,
        duration: appState.settings.duration,
        volume: appState.settings.volume
    };
}

async function fetchAnalysis() {
    const currentId = ++appState.ui.analysisId;
    const chord = appState.chords[appState.activeChordIndex];
    const noteStrs = chord.voices.map(s => getNoteString(s));

    if (appState.ui.offlineMode) {
        const data = analyzeChord(noteStrs, { 
            allow_rootless: appState.ui.rootless, 
            tuning_style: appState.settings.intonation 
        });
        updateAnalysisResult(data, chord);
        return;
    }

    const resultEl = document.getElementById('analysis-result');
    const pendingEl = document.getElementById('pendingIndicator');
    if (resultEl) resultEl.classList.add('pending');
    if (pendingEl) pendingEl.style.display = 'inline';

    try {
        const res = await fetch('/analyze', { 
            method: 'POST', headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ 
                notes: noteStrs, 
                allow_rootless: appState.ui.rootless, 
                tuning_style: appState.settings.intonation 
            }) 
        });
        const data = await res.json();
        if (currentId === appState.ui.analysisId && !data.error) {
            updateAnalysisResult(data, chord);
        }
    } catch (e) {
        console.error('Falling back to client-side analysis (no /analyze backend reachable):', e);
        if (currentId === appState.ui.analysisId) {
            const data = analyzeChord(noteStrs, {
                allow_rootless: appState.ui.rootless,
                tuning_style: appState.settings.intonation
            });
            updateAnalysisResult(data, chord);
        }
    }
    finally {
        if (currentId === appState.ui.analysisId && resultEl) {
            resultEl.classList.remove('pending');
            if (pendingEl) pendingEl.style.display = 'none';
        }
    }
}

function updateAnalysisResult(data, chord) {
    chord.analysis = data;
    const nameEl = document.getElementById('chordName');
    if (nameEl) nameEl.innerText = data.common_name || "Unknown Chord";
    const metaEl = document.getElementById('meta');
    if (metaEl) metaEl.innerText = (data.inversion + " - " + data.voicing).toUpperCase();
    const rolesEl = document.getElementById('roles');
    if (rolesEl) rolesEl.innerHTML = (data.notes || []).map(n => "<div>" + n.part + ": <strong>" + n.role + "</strong></div>").join('');
    
    if (appState.settings.intonation !== 'custom' && data.notes) {
        chord.tuning = data.notes.map(n => n.tuning);
        // Analysis resolves after triggerMutation()'s own (necessarily pre-analysis) sync call
        // already ran, so that earlier sync persisted stale tuning -- this is the point where
        // the real, up-to-date values exist, and the only place that syncs them.
        syncChordToScoreDocument();
    }
    renderUI();
}

function renderUI() {
    const container = document.querySelector('.controls');
    if (!container) return; 

    const chord = appState.chords[appState.activeChordIndex];
    renderControls(container, chord.voices, appState.ui.selectedIdx, chord.tuning, manualUpdate, updateNote, cycleEnharmonic, appState.settings.partSettings);
    drawChord("notation", chord.voices);
    
    syncStateToInputs();

    if (appState.ui.focusedElementId) {
        const el = document.getElementById(appState.ui.focusedElementId);
        if (el) el.focus();
    }

    const editingLabelEl = document.getElementById('editingLabel');
    if (editingLabelEl) {
        if (!appState.ui.editingScoreChordId) {
            editingLabelEl.textContent = 'Editing: Global Default';
            editingLabelEl.className = 'editing-label';
        } else if (appState.ui.scoreChordNotFound) {
            editingLabelEl.textContent = 'Score chord not found (stale link?) — editing a local copy instead, changes won\'t rejoin the score';
            editingLabelEl.className = 'editing-label error';
        } else {
            const pos = appState.ui.scoreChordPosition;
            editingLabelEl.textContent = `Editing: Chord ${pos.index + 1} of ${pos.total} (from Score) — edits save back live`;
            editingLabelEl.className = 'editing-label live';
        }
    }

    const manifestEl = document.getElementById('manifest');
    if (manifestEl) {
        const docsLink = "<a href='help/' target='_blank'>Documentation</a>";
        if (SHOW_SERIALS) {
            manifestEl.innerHTML = `index: ${S_IDX} | ${docsLink}<br>spel: ${S_SPEL} | ui: ${S_UI} | not: ${S_NOT} | aud: ${S_AUD} | thy: ${S_THY}`;
        } else {
            manifestEl.innerHTML = docsLink;
        }
    }
}

// Maps engine/wav_chord_detector.py's output onto this chord's voices/tuning. Spelling is
// resolved here (not server-side) via the same getVariations() logic used for every other
// note edit in this app, spelling each voice in turn with the already-placed voices as
// false-relation context -- low to high, same order a person would spell a chord by hand.
// The detector only labels however many distinct voices it actually found (see its
// docstring), so a chord with a unison/octave doubling leaves the remaining voice(s)
// untouched rather than guessing.
const WAV_PART_TO_VOICE_IDX = { Bass: 0, Bari: 1, Lead: 2, Tenor: 3 };

function applyDetectedVoices(notes) {
    const chord = appState.chords[appState.activeChordIndex];
    const context = [];
    notes.forEach(n => {
        const idx = WAV_PART_TO_VOICE_IDX[n.part];
        if (idx === undefined) return;
        const guessOct = Math.floor(n.app_semitone / 12);
        const spelled = getVariations(n.app_semitone, guessOct, context)[0];
        chord.voices[idx] = Object.assign({}, chord.voices[idx], spelled, { rest: false });
        chord.tuning[idx] = n.cents;
        context.push({ step: spelled.step, semi: n.app_semitone });
    });
    // The whole point is to capture the *real* sung cents -- switch to custom intonation so
    // the next analysis pass doesn't immediately overwrite them with a computed value (same
    // protection the tuningUpdate manual-edit path already relies on).
    appState.settings.intonation = 'custom';
    const customInt = document.querySelector('input[name="intonation"][value="custom"]');
    if (customInt) customInt.checked = true;
    triggerMutation(true);
}

async function loadChordFromWav() {
    const fileInput = document.getElementById('wavChordFile');
    const statusEl = document.getElementById('wavChordStatus');
    const file = fileInput && fileInput.files[0];
    if (!file) return;

    if (statusEl) statusEl.textContent = 'Analyzing...';
    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('detect-chord-wav', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) {
            if (statusEl) statusEl.textContent = 'Error: ' + data.error;
            return;
        }
        applyDetectedVoices(data.notes);
        const warning = (data.warnings || [])[0];
        if (statusEl) statusEl.textContent = warning || `Loaded ${data.notes.length} voice(s).`;
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Analysis failed: ' + e.message;
    } finally {
        fileInput.value = '';
    }
}

export function triggerMutation(skipSync = false) {
    // Explicitly check for boolean true to avoid treating Event objects as 'skipSync'
    if (skipSync !== true) syncInputsToState();
    syncChordToScoreDocument();
    renderUI();
    fetchAnalysis();
}

function updateNote(idx, semiChange) {
    const chord = appState.chords[appState.activeChordIndex];
    const context = chord.voices.map((s, i) => ({ step: s.step, semi: getAbsSemitone(s), idx: i })).filter(n => n.idx !== idx);
    chord.voices[idx] = Object.assign({}, chord.voices[idx], getVariations(getAbsSemitone(chord.voices[idx]) + semiChange, chord.voices[idx].oct, context)[0]);
    triggerMutation();
}

function manualUpdate(idx, val) {
    const match = val.match(/^([a-gA-G])(bb|b|#|x)?([0-8])$/i);
    if (match) {
        const step = match[1].toLowerCase();
        const acc = STR_TO_ACC[match[2] ? match[2].toLowerCase() : ""];
        const oct = parseInt(match[3]);
        const chord = appState.chords[appState.activeChordIndex];
        const context = chord.voices.map((s, i) => ({ step: s.step, semi: getAbsSemitone(s), idx: i })).filter(n => n.idx !== idx);
        chord.voices[idx] = Object.assign({}, chord.voices[idx], getVariations((oct * 12) + STEP_TO_SEMI[step] + acc, chord.voices[idx].oct, context)[0]);
        triggerMutation();
    }
}

function cycleEnharmonic(idx) {
    const chord = appState.chords[appState.activeChordIndex];
    const vars = getVariations(getAbsSemitone(chord.voices[idx]), chord.voices[idx].oct, chord.voices.map((s, i) => ({ step: s.step, semi: getAbsSemitone(s), idx: i })).filter(n => n.idx !== idx));
    let curIdx = vars.findIndex(v => v.step === chord.voices[idx].step && v.acc === chord.voices[idx].acc && v.oct === chord.voices[idx].oct);
    chord.voices[idx] = Object.assign({}, chord.voices[idx], vars[(curIdx + 1) % vars.length]);
    triggerMutation();
}

function init() {
    loadStateFromURL();
    syncStateToInputs();

    const safeListen = (id, evt, fn) => {
        const el = document.getElementById(id);
        if (el) el[evt] = fn;
    };

    safeListen('rootlessToggle', 'onchange', triggerMutation);
    safeListen('offlineToggle', 'onchange', triggerMutation);
    safeListen('wavChordFile', 'onchange', loadChordFromWav);
    safeListen('legacyVocalToggle', 'onchange', () => {
        appState.settings.presetVersion = document.getElementById('legacyVocalToggle').checked ? 'legacy' : 'ear';
        const chord = appState.chords[appState.activeChordIndex];
        if (chord.vowel !== 'custom') {
            const presets = appState.settings.presetVersion === 'legacy' ? VOWEL_PRESETS_LEGACY : VOWEL_PRESETS_EAR;
            const freqs = presets[chord.vowel];
            if (freqs) {
                chord.formants.f1 = freqs[0];
                chord.formants.f2 = freqs[1];
                chord.formants.f3 = freqs[2];
            }
        }
        triggerMutation(true);
    });

    const audioPrefHandler = () => {
        syncInputsToState();
        syncStateToInputs();
    };

    safeListen('vpsCount', 'oninput', audioPrefHandler);
    safeListen('duration', 'oninput', audioPrefHandler);
    safeListen('volume', 'oninput', audioPrefHandler);
    
    document.querySelectorAll('input[name="intonation"]').forEach(r => r.onchange = triggerMutation);
    
    document.querySelectorAll('input[name="vowel"]').forEach(radio => {
        radio.onchange = () => {
            const chord = appState.chords[appState.activeChordIndex];
            chord.vowel = radio.value;
            if (radio.value === 'custom') {
                const adv = document.getElementById('advDetails');
                if (adv) adv.open = true;
            } else {
                const presets = appState.settings.presetVersion === 'legacy' ? VOWEL_PRESETS_LEGACY : VOWEL_PRESETS_EAR;
                const freqs = presets[radio.value];
                if (freqs) {
                    chord.formants.f1 = freqs[0];
                    chord.formants.f2 = freqs[1];
                    chord.formants.f3 = freqs[2];
                }
            }
            triggerMutation(true);
        }
    });

    ['f1', 'f2', 'f3', 'vibratoJitterCutoff', 'vibratoJitterAmount', 'phaseJitter',
     'vibratoDepth', 'vibratoRateMean', 'vibratoRateRange', 'formantQ1', 'formantQ2'].forEach(id => {
        const el = document.getElementById(id);
        const nel = document.getElementById('n_' + id);
        const handler = () => {
            if (id.startsWith('f') && !id.includes('Q')) {
                const customRad = document.querySelector('input[name="vowel"][value="custom"]');
                if (customRad) customRad.checked = true;
                appState.chords[appState.activeChordIndex].vowel = 'custom';
            }
            syncInputsToState();
            syncStateToInputs();
        };
        if (el) el.oninput = handler;
        if (nel) nel.oninput = handler;
    });

    for (let i = 0; i < 4; i++) {
        ['ping', 'tilt', 'f4', 'f5'].forEach(key => {
            const el = document.getElementById(`part-${key}-${i}`);
            if (el) {
                el.oninput = () => {
                    syncInputsToState();
                    syncStateToInputs();
                };
            }
        });
    }

    safeListen('playBtn', 'onclick', () => playChord(appState.chords[appState.activeChordIndex].voices, appState.chords[appState.activeChordIndex].tuning, getAudioSettings()));
    safeListen('saveBtn', 'onclick', () => saveChordAsWav(appState.chords[appState.activeChordIndex].voices, appState.chords[appState.activeChordIndex].tuning, getAudioSettings()));
    safeListen('shareBtn', 'onclick', generatePermalink);
    safeListen('analyzeBtn', 'onclick', async () => {
        const btn = document.getElementById('analyzeBtn');
        btn.disabled = true;
        setTimeout(async () => {
            try { await analyzeAndShow(appState.chords[appState.activeChordIndex].voices, appState.chords[appState.activeChordIndex].tuning, getAudioSettings()); }
            finally { btn.disabled = false; }
        }, 50);
    });

    window.addEventListener('selectPart', (e) => {
        appState.ui.selectedIdx = e.detail;
        appState.ui.focusedElementId = null;
        renderUI();
    });

    window.addEventListener('inputFocus', (e) => {
        appState.ui.selectedIdx = e.detail.idx;
        appState.ui.focusedElementId = e.detail.id;
        document.querySelectorAll('.part-ctrl').forEach((c, i) => c.classList.toggle('active', i === appState.ui.selectedIdx));
    });

    window.addEventListener('tuningUpdate', (e) => {
        const chord = appState.chords[appState.activeChordIndex];
        const val = parseFloat(e.detail.val);
        chord.tuning[e.detail.idx] = isNaN(val) ? e.detail.val : val;
        if (e.detail.manual) {
            appState.settings.intonation = 'custom';
            const customInt = document.querySelector('input[name="intonation"][value="custom"]');
            if (customInt) customInt.checked = true;
        }
        syncChordToScoreDocument();
    });

    window.addEventListener('partAudioUpdate', (e) => {
        const { idx, volume, mute } = e.detail;
        const part = appState.settings.partSettings[idx];
        if (volume !== undefined) part.volume = volume;
        if (mute !== undefined) part.mute = mute;
        renderUI();
    });

    window.addEventListener('keydown', (e) => {
        handleGlobalKey(e, 
            { selectedIdx: appState.ui.selectedIdx, isTyping: document.activeElement.tagName === 'INPUT' },
            {
                updateNote, cycleEnharmonic, renderUI,
                playChord: () => {
                   const btn = document.getElementById('playBtn');
                   if (btn) btn.click();
                },
                navigate: (idx) => {
                    appState.ui.selectedIdx = idx;
                    appState.ui.focusedElementId = null;
                    renderUI();
                }
            }
        );
    });

    renderUI();
    fetchAnalysis();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('notation')) init();
    });
} else {
    if (document.getElementById('notation')) init();
}