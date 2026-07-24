/* main.js Serial: #067-STABLE */
import { getAbsSemitone, getVariations, STR_TO_ACC, STEP_TO_SEMI, SERIAL as S_SPEL } from './spelling.js';
import { renderControls, handleGlobalKey, SERIAL as S_UI } from './ui-controls.js';
import { drawChord, SERIAL as S_NOT } from './notation.js';
import { playChord, saveChordAsWav, analyzeAndShow, primeAudioContext, SERIAL as S_AUD } from './audio.js';
import { analyzeChord, SERIAL as S_THY } from './theory.js';
import { appState, syncInputsToState, syncStateToInputs, loadStateFromURL, generatePermalink, getNoteString, syncChordToScoreDocument, syncChordToStandaloneDocument, isScoreDocumentDirty, isChordDocumentDirty, establishFreshChordBaseline, chordDocStore, VOWEL_PRESETS_LEGACY, VOWEL_PRESETS_EAR } from './state.js';
import { createDocumentStore } from './document-store.js';
import { readChordDocument } from './chord-store.js';
import { swapVoices, bumpOctave, SWAP_PAIRS, VOICE_LABELS } from './revoice.js';

const S_IDX = "#067-STABLE";
const SHOW_SERIALS = false;

// True only until the very first, page-load-triggered analysis pass settles (cleared at the end
// of init(), below). Guards updateAnalysisResult()'s sync calls -- see the comment there.
let bootstrapping = true;

// Fine-grained undo stack scoped to just the one chord being edited (plan.md §10.7.3/§10.7.4),
// used only for a live ?sid= Score-chord edit -- deliberately NOT persisted (plan.md §10.8.4,
// confirmed with Mike): a ?sid= tab is a transient view onto one chord inside score:current, not
// itself a document you'd expect to revisit later and still have undo history for -- closer to a
// modal editing session than a standing page. Ctrl+Z there already only reaches back to edits made
// since *this tab* was opened, since a fresh page load always starts this store empty -- there was
// never a risk of it reaching into a change made before the tab existed, in a different tab.
const chordUndoStore = createDocumentStore('chord:undo-scratch');

// The standalone case (no ?sid=) instead pushes/pops through state.js's own chordDocStore
// (persistHistory: true) -- same instance that file's markImported()/markExported() calls already
// use for chord:current's dirty tracking, so import/export correctly clear/persist one shared
// history rather than main.js keeping a second, independent copy that could drift. A bare visit to
// `/` is a real, revisited-over-time document (same reasoning as score.js's scoreStore), unlike a
// ?sid= tab.
function activeUndoStore() {
    return appState.ui.editingScoreChordId ? chordUndoStore : chordDocStore;
}

// The snapshot bundles the chord together with settings.intonation, even though intonation is a
// global setting, not a chord field -- because updateAnalysisResult() overwrites chord.tuning
// off of whatever intonation currently is, any time it isn't 'custom'. Snapshotting the chord
// alone would let a later triggerMutation() (including the one undo/redo() themselves call, to
// refresh chord.analysis for the restored notes) immediately re-fetch analysis and re-clobber
// the just-restored tuning with fresh values for whatever intonation is *currently* selected --
// caught live in a real browser: switching to "Just" then Ctrl+Z left the custom cents undone
// only for an instant before the undo's own re-analysis silently wrote them right back over.
// Other global settings (rootless, offline, audio/vibrato prefs, part volume/mute) don't have
// this problem -- they don't gate whether chord.tuning gets overwritten -- so they stay out of
// scope, along with continuous drag inputs (f1/f2/f3, vibrato sliders, part dials), which fire on
// every 'input' tick and don't go through triggerMutation()/sync to score:current today either
// (a pre-existing gap, not something this pass changes).
function undoRedoContent() {
    return {
        chord: appState.chords[appState.activeChordIndex],
        intonation: appState.settings.intonation,
    };
}

function applyUndoRedoContent(snap) {
    appState.chords[appState.activeChordIndex] = snap.chord;
    appState.settings.intonation = snap.intonation;
}

// Call as the first thing inside any handler that's about to mutate the active chord's own
// fields (voices/tuning/vowel/formants) or flip intonation.
function pushChordUndo() {
    activeUndoStore().pushUndo(undoRedoContent());
}

// Exported for the document-strip UI to disable/enable Undo/Redo buttons, and used directly by
// the test suite below.
export function canUndoChord() { return activeUndoStore().canUndo(); }
export function canRedoChord() { return activeUndoStore().canRedo(); }

export function undoChordEdit() {
    const restored = activeUndoStore().undo(undoRedoContent());
    if (!restored) return;
    applyUndoRedoContent(restored);
    // skipSync=true: the DOM still shows the pre-undo values (radios, sliders) -- pulling them
    // in via syncInputsToState() would immediately clobber the just-restored chord. renderUI()
    // pushes the restored state back OUT to the DOM instead, same trick applyDetectedVoices/the
    // vowel and legacy-vowel handlers already rely on.
    triggerMutation(true);
}

export function redoChordEdit() {
    const restored = activeUndoStore().redo(undoRedoContent());
    if (!restored) return;
    applyUndoRedoContent(restored);
    triggerMutation(true);
}

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
        // the real, up-to-date values exist, and the only place that syncs them. Skipped during
        // the very first (page-load-triggered) analysis pass -- caught live: opening a ?sid=
        // chord for editing and touching nothing still silently overwrote its stored tuning in
        // score:current with a fresh recompute, the same over-triggering bug just fixed for the
        // standalone case (establishFreshChordBaseline), just with no clean way to "re-baseline"
        // a shared multi-chord document the same way -- so here the fix is simpler: don't sync a
        // computation nobody asked for. A genuine edit's own commit point still syncs normally.
        if (!bootstrapping) {
            syncChordToScoreDocument();
            syncChordToStandaloneDocument();
        }
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

    updateDocStrip();
}

// Document label + dirty indicator + Undo/Redo enabled-state (plan.md §10.7.5). A ?sid= tab's
// dirty flag mirrors the *Score* document's own (§10.7.4 -- this tab has no independent dirty
// concept, every edit already writes straight through), including while editingLabel is showing
// the "not found" fallback, where nothing here is meaningfully trackable either way.
function updateDocStrip() {
    const labelEl = document.getElementById('docLabel');
    if (labelEl) {
        if (appState.ui.editingScoreChordId) {
            labelEl.textContent = '';
        } else {
            const doc = readChordDocument();
            labelEl.textContent = (doc && doc.sourceLabel) ? doc.sourceLabel : 'Untitled chord';
        }
    }

    const dirtyEl = document.getElementById('docDirtyIndicator');
    if (dirtyEl) {
        const dirty = appState.ui.editingScoreChordId
            ? (!appState.ui.scoreChordNotFound && isScoreDocumentDirty())
            : isChordDocumentDirty();
        dirtyEl.textContent = dirty ? '● Unsaved changes' : '';
    }

    const undoBtn = document.getElementById('undoBtn');
    if (undoBtn) undoBtn.disabled = !canUndoChord();
    const redoBtn = document.getElementById('redoBtn');
    if (redoBtn) redoBtn.disabled = !canRedoChord();
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
    if (!notes.length) return;
    const chord = appState.chords[appState.activeChordIndex];
    pushChordUndo();
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
    syncChordToStandaloneDocument();
    renderUI();
    fetchAnalysis();
}

export function updateNote(idx, semiChange) {
    const chord = appState.chords[appState.activeChordIndex];
    pushChordUndo();
    const context = chord.voices.map((s, i) => ({ step: s.step, semi: getAbsSemitone(s), idx: i })).filter(n => n.idx !== idx);
    chord.voices[idx] = Object.assign({}, chord.voices[idx], getVariations(getAbsSemitone(chord.voices[idx]) + semiChange, chord.voices[idx].oct, context)[0]);
    triggerMutation();
}

export function manualUpdate(idx, val) {
    const match = val.match(/^([a-gA-G])(bb|b|#|x)?([0-8])$/i);
    if (match) {
        const step = match[1].toLowerCase();
        const acc = STR_TO_ACC[match[2] ? match[2].toLowerCase() : ""];
        const oct = parseInt(match[3]);
        const chord = appState.chords[appState.activeChordIndex];
        pushChordUndo();
        const context = chord.voices.map((s, i) => ({ step: s.step, semi: getAbsSemitone(s), idx: i })).filter(n => n.idx !== idx);
        chord.voices[idx] = Object.assign({}, chord.voices[idx], getVariations((oct * 12) + STEP_TO_SEMI[step] + acc, chord.voices[idx].oct, context)[0]);
        triggerMutation();
    }
}

export function cycleEnharmonic(idx) {
    const chord = appState.chords[appState.activeChordIndex];
    pushChordUndo();
    const vars = getVariations(getAbsSemitone(chord.voices[idx]), chord.voices[idx].oct, chord.voices.map((s, i) => ({ step: s.step, semi: getAbsSemitone(s), idx: i })).filter(n => n.idx !== idx));
    let curIdx = vars.findIndex(v => v.step === chord.voices[idx].step && v.acc === chord.voices[idx].acc && v.oct === chord.voices[idx].oct);
    chord.voices[idx] = Object.assign({}, chord.voices[idx], vars[(curIdx + 1) % vars.length]);
    triggerMutation();
}

// Revoice dialog (plan.md §17): swap which part sings which note, or bump a part an octave, with
// a live grandstaff preview -- staged locally in revoiceVoices/revoiceTuning while the dialog is
// open, only written into the real chord on Apply (one undo entry for the whole session, matching
// how the vowel radio/intonation switch already commit as a single step, not one per click).
// Cents travel with the pitch on a swap (see revoice.js's own doc comment on why), but not on an
// octave bump (an octave doesn't change a note's harmonic role/interval from the root). Applying
// while intonation isn't 'custom' gets the swapped cents immediately overwritten by triggerMutation
// -> fetchAnalysis()'s fresh recompute anyway -- carrying them through is only load-bearing for
// 'custom', where nothing else would fix up the cents to follow the pitch.
let revoiceVoices = null;
let revoiceTuning = null;

function renderRevoiceDialog() {
    drawChord('revoiceNotation', revoiceVoices);

    const swapsEl = document.getElementById('revoiceSwaps');
    if (swapsEl) {
        swapsEl.innerHTML = SWAP_PAIRS.map(([a, b], i) =>
            `<button data-swap-idx="${i}">${VOICE_LABELS[a]} ↔ ${VOICE_LABELS[b]}</button>`
        ).join('');
        swapsEl.querySelectorAll('button').forEach((btn, i) => {
            btn.onclick = () => {
                const [a, b] = SWAP_PAIRS[i];
                const result = swapVoices(revoiceVoices, revoiceTuning, a, b);
                revoiceVoices = result.voices;
                revoiceTuning = result.tuning;
                renderRevoiceDialog();
            };
        });
    }

    const octEl = document.getElementById('revoiceOctaves');
    if (octEl) {
        octEl.innerHTML = VOICE_LABELS.map((label, i) =>
            `<span class="revoice-octave-col">${label}
                <span>
                    <button data-oct-idx="${i}" data-oct-dir="1" title="Up an octave">▲</button>
                    <button data-oct-idx="${i}" data-oct-dir="-1" title="Down an octave">▼</button>
                </span>
            </span>`
        ).join('');
        octEl.querySelectorAll('button').forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.octIdx, 10);
                const dir = parseInt(btn.dataset.octDir, 10);
                revoiceVoices = bumpOctave(revoiceVoices, idx, dir);
                renderRevoiceDialog();
            };
        });
    }
}

function openRevoiceDialog() {
    const chord = appState.chords[appState.activeChordIndex];
    revoiceVoices = chord.voices.map(v => Object.assign({}, v));
    revoiceTuning = chord.tuning.slice();
    renderRevoiceDialog();
    const overlay = document.getElementById('revoiceOverlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRevoiceDialog() {
    const overlay = document.getElementById('revoiceOverlay');
    if (overlay) overlay.style.display = 'none';
    revoiceVoices = null;
    revoiceTuning = null;
}

function applyRevoiceDialog() {
    const chord = appState.chords[appState.activeChordIndex];
    pushChordUndo();
    chord.voices = revoiceVoices;
    chord.tuning = revoiceTuning;
    closeRevoiceDialog();
    triggerMutation(true);
}

function init() {
    const resumedExistingDocument = loadStateFromURL();
    syncStateToInputs();

    const safeListen = (id, evt, fn) => {
        const el = document.getElementById(id);
        if (el) el[evt] = fn;
    };

    safeListen('rootlessToggle', 'onchange', triggerMutation);
    safeListen('offlineToggle', 'onchange', triggerMutation);
    safeListen('wavChordFile', 'onchange', loadChordFromWav);
    safeListen('legacyVocalToggle', 'onchange', () => {
        const chord = appState.chords[appState.activeChordIndex];
        if (chord.vowel !== 'custom') pushChordUndo();
        appState.settings.presetVersion = document.getElementById('legacyVocalToggle').checked ? 'legacy' : 'ear';
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
    
    // Intonation itself isn't a chord field, but flipping it re-derives chord.tuning
    // asynchronously via fetchAnalysis() -> updateAnalysisResult() at the end of triggerMutation
    // -- snapshotting here is what lets Ctrl+Z undo "I switched to equal temperament and lost my
    // custom cents," even though the mutation that actually changes tuning hasn't happened yet
    // at the point this handler runs.
    document.querySelectorAll('input[name="intonation"]').forEach(r => r.onchange = () => {
        pushChordUndo();
        triggerMutation();
    });

    document.querySelectorAll('input[name="vowel"]').forEach(radio => {
        radio.onchange = () => {
            const chord = appState.chords[appState.activeChordIndex];
            pushChordUndo();
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
    safeListen('undoBtn', 'onclick', undoChordEdit);
    safeListen('redoBtn', 'onclick', redoChordEdit);
    safeListen('revoiceBtn', 'onclick', openRevoiceDialog);
    safeListen('revoiceCloseBtn', 'onclick', closeRevoiceDialog);
    safeListen('revoiceCancelBtn', 'onclick', closeRevoiceDialog);
    safeListen('revoiceApplyBtn', 'onclick', applyRevoiceDialog);
    safeListen('analyzeBtn', 'onclick', async () => {
        const btn = document.getElementById('analyzeBtn');
        btn.disabled = true;
        setTimeout(async () => {
            try { await analyzeAndShow(appState.chords[appState.activeChordIndex].voices, appState.chords[appState.activeChordIndex].tuning, getAudioSettings()); }
            finally { btn.disabled = false; }
        }, 50);
    });

    // Best-effort audio-context warm-up on the page's first gesture (plan.md §10.5.2's fix,
    // applied here too -- same latent resume() latency exists on this page's own Play button,
    // just less noticeable against a multi-second flat duration than /score's short chords).
    window.addEventListener('pointerdown', primeAudioContext, { once: true, capture: true });

    window.addEventListener('selectPart', (e) => {
        appState.ui.selectedIdx = e.detail;
        appState.ui.focusedElementId = null;
        renderUI();
    });

    window.addEventListener('inputFocus', (e) => {
        // The cents field dispatches tuningUpdate on every keystroke (continuous, like a slider
        // drag), not just on commit -- unlike note-input's onchange, which only fires once. So
        // the undo snapshot has to happen here, once per edit session at focus-in, rather than
        // inside the tuningUpdate handler itself (which would push one entry per keystroke).
        if (e.detail.id && e.detail.id.startsWith('tuning-')) pushChordUndo();
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
        syncChordToStandaloneDocument();
    });

    window.addEventListener('partAudioUpdate', (e) => {
        const { idx, volume, mute } = e.detail;
        const part = appState.settings.partSettings[idx];
        if (volume !== undefined) part.volume = volume;
        if (mute !== undefined) part.mute = mute;
        renderUI();
    });

    window.addEventListener('keydown', (e) => {
        // Always runs the app's own undo/redo, deliberately not deferring to native per-field
        // text undo even while focused in note-input/tuning-input -- those are this app's only
        // free-text fields, and both are chord fields already captured by the undo stack anyway,
        // so there's no real "different" undo a native handler would offer here. (An earlier
        // version tried to detect "genuinely typing" via document.activeElement and defer to
        // native undo there, but renderUI() re-focuses appState.ui.focusedElementId on every
        // render -- including the render this very undo call triggers -- so focus routinely
        // sits in the last-edited field long after the user has moved on to other controls.
        // Caught live: clicking an intonation radio, then Ctrl+Z, silently did nothing because
        // focus had already been steered back into the cents field from the edit before it.)
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) redoChordEdit(); else undoChordEdit();
            return;
        }
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
    // On a truly fresh bare visit (nothing to resume), the initial analysis pass's own real
    // tuning computation would otherwise sync into chord:current with no baseline, reading as
    // "unsaved changes" before the user has done anything -- establish it as the baseline instead,
    // once, right after this first pass settles.
    fetchAnalysis().then(() => {
        if (!resumedExistingDocument) establishFreshChordBaseline();
        bootstrapping = false;
        updateDocStrip();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('notation')) init();
    });
} else {
    if (document.getElementById('notation')) init();
}