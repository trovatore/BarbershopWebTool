/* score.js — MusicXML import demo wired to the Kotlin engine's WebApi (plan.md §5.6/§5.7),
   the data-model bridge into the shared score:current document (§10.2 slice 1), and per-chord
   Edit links + live sync back from the Chord page (§10.2 slice 2). Choosing a file both loads
   and starts editing in one step (plan.md §10.2 UX simplification, 2026-07-12) — there's no
   "preview without committing" state anymore. */
import { STR_TO_ACC, ACC_TO_STR, getAbsSemitone } from './spelling.js';
import { writeScoreDocument, readScoreDocument, newChordId, SCORE_STORAGE_KEY } from './score-store.js';
import { VOWEL_PRESETS_EAR, getNoteString, AUDIO_DEFAULTS } from './state.js';
import { createDocumentStore } from './document-store.js';
import { analyzeChord, CHORD_PATTERNS, getKeyAwarePCName, keyFifthsAtBeat, parseRomanNumeral, chordPitchClasses, checkPillarConsistency } from './theory.js';
import { playScore, stopScorePlayback, saveScoreAsWav, primeAudioContext } from './audio.js';
import { parseChordName, generateVoicings } from './voicing-generator.js';
import { swapVoices, bumpOctave, SWAP_PAIRS, VOICE_LABELS } from './revoice.js';
import { drawChord } from './notation.js';

// Best-effort warm-up on the page's first genuine user gesture (any click/keypress/etc, not
// necessarily on a playback control) -- see primeAudioContext()'s own doc comment in audio.js.
// Hides most of the real several-second resume() latency by starting it in the background while
// the user is still choosing a file / looking over the loaded score, well before they click Play.
window.addEventListener('pointerdown', primeAudioContext, { once: true, capture: true });

// Fixed vibrato/formant-Q/vps/volume defaults for whole-score playback -- /score has no
// equivalent UI for these (plan.md §10.5 only asked for tempo + the 4-part mix + mute, not a full
// audio-settings panel here too), so it needs a stable, independent snapshot rather than reading
// live appState.settings from the Chord page (which could reflect a one-off customization made
// there). Derived from state.js's own AUDIO_DEFAULTS (plan.md §37) instead of a hand-copied
// literal, so there's one place left to edit when a default changes.
const SCORE_AUDIO_DEFAULTS = { ...AUDIO_DEFAULTS.audio, vps: AUDIO_DEFAULTS.vps, volume: AUDIO_DEFAULTS.volume };

(function () {
    const engine = window["barbershop-engine"];
    const WebApi = engine && engine.barbershop && engine.barbershop.web && engine.barbershop.web.WebApi;

    const fileInput = document.getElementById('xmlFile');
    const exportBtn = document.getElementById('exportBtn');
    const retuneBtn = document.getElementById('retuneBtn');
    const retuneIntonationEl = document.getElementById('retuneIntonation');
    const retuneRootlessEl = document.getElementById('retuneRootless');
    // Page-local display preference (plan.md §34) -- not persisted to score:current, same
    // treatment as the playback mixer's "for listening only, not saved with the score" sliders.
    const showRomanNumeralsEl = document.getElementById('showRomanNumerals');
    const scoreBpmEl = document.getElementById('scoreBpm');
    const playScoreBtn = document.getElementById('playScoreBtn');
    const stopScoreBtn = document.getElementById('stopScoreBtn');
    const saveScoreWavBtn = document.getElementById('saveScoreWavBtn');
    const scorePlaybackStatusEl = document.getElementById('scorePlaybackStatus');
    const statusEl = document.getElementById('status');
    const summaryEl = document.getElementById('summary');
    const warningsEl = document.getElementById('warnings');
    const chordsEl = document.getElementById('chords');
    const dirtyIndicatorEl = document.getElementById('dirtyIndicator');
    const docLabelEl = document.getElementById('docLabel');
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    const newScoreBtn = document.getElementById('newScoreBtn');
    const resumeBannerEl = document.getElementById('resumeBanner');
    const resumeBannerTextEl = document.getElementById('resumeBannerText');
    const resumeBtn = document.getElementById('resumeBtn');
    const dismissResumeBtn = document.getElementById('dismissResumeBtn');
    const appendChordBtn = document.getElementById('appendChordBtn');
    const chordPickerOverlay = document.getElementById('chordPickerOverlay');
    const pickerTargetLabelEl = document.getElementById('pickerTargetLabel');
    const pickerCloseBtn = document.getElementById('pickerCloseBtn');
    const pickerNameInput = document.getElementById('pickerNameInput');
    const pickerBeatsInput = document.getElementById('pickerBeatsInput');
    const pickerSearchBtn = document.getElementById('pickerSearchBtn');
    const pickerStatusEl = document.getElementById('pickerStatus');
    const pickerResultsEl = document.getElementById('pickerResults');
    const scoreRevoiceOverlay = document.getElementById('scoreRevoiceOverlay');
    const revoiceCloseBtn = document.getElementById('revoiceCloseBtn');
    const revoiceCancelBtn = document.getElementById('revoiceCancelBtn');
    const revoiceApplyBtn = document.getElementById('revoiceApplyBtn');
    let playbackResetTimer = null;

    // [{volume, mute}, ...] indexed Bass/Bari/Lead/Tenor, matching VOICE_ORDER below -- read
    // fresh each time rather than cached, so adjusting a slider mid-playback has no effect on a
    // chord already scheduled (WebAudio's automation is already committed at schedule time) but
    // does apply to the next Play/Save.
    function readMixer() {
        return [0, 1, 2, 3].map(i => ({
            volume: parseFloat(document.getElementById(`mix-vol-${i}`).value) || 0,
            mute: document.getElementById(`mix-mute-${i}`).checked,
        }));
    }

    function setPlaybackButtonsEnabled(enabled) {
        playScoreBtn.disabled = !enabled;
        saveScoreWavBtn.disabled = !enabled;
    }

    // One store instance for this tab, tracking score:current's dirty state (against the last
    // import/export, not against the continuous autosave below) and holding a document-level
    // undo/redo stack (plan.md §10.7). currentDoc itself stays in its existing flat
    // {chords, metadata, updatedAt} shape for compatibility with syncChordToScoreDocument() and
    // the storage-event listener below -- sourceLabel/sourceSnapshot just ride along as extra
    // sibling fields rather than nesting the whole doc under the store's own {content, ...} shape.
    // persistHistory: true (plan.md §10.8.4) -- /score is a view onto a real, revisited-over-time
    // document, not a disposable tab session (unlike main.js's chordUndoStore for a ?sid= tab,
    // which is deliberately NOT persisted -- see that file's own comment on why), so its undo
    // stack should survive navigating away and back the same way the dirty flag already does.
    const scoreStore = createDocumentStore(SCORE_STORAGE_KEY, { persistHistory: true });

    function scoreContent(doc) {
        return { chords: doc.chords, metadata: doc.metadata };
    }

    // Document label + dirty indicator (plan.md §10.7.5).
    function updateDocStrip() {
        if (docLabelEl) docLabelEl.textContent = (currentDoc && currentDoc.sourceLabel) || 'No file loaded';
        if (!dirtyIndicatorEl) return;
        const dirty = !!currentDoc && scoreStore.isDirty({
            content: scoreContent(currentDoc),
            sourceSnapshot: currentDoc.sourceSnapshot,
        });
        dirtyIndicatorEl.textContent = dirty ? '● Unsaved changes' : '';
    }

    // Document-level Undo/Redo (built 2026-07-21, plan.md §10.8.3): reuses scoreStore's own
    // undo/redo stack rather than a separate scratch instance (unlike main.js's chordUndoStore,
    // which has to be separate since it covers both the standalone chord:current document and a
    // live ?sid= Score-chord edit -- two different documents, neither of which /score itself is).
    // score:current is the only document /score ever mutates, so reusing scoreStore gets the
    // "importing a new file wipes old undo history" behavior for free from markImported() (per
    // §10.7.9 -- Mike's call was specifically no undo-*of*-import, not no undo at all; an import
    // still correctly can't be undone, since markImported() clears the stack same as it always
    // has). Covers bulk re-tune and the vowel picker; import/export themselves are never pushed.
    function pushDocUndo() {
        scoreStore.pushUndo(scoreContent(currentDoc));
    }

    function applyDocContent(content) {
        currentDoc.chords = content.chords;
        currentDoc.metadata = content.metadata;
        currentDoc.updatedAt = Date.now();
        writeScoreDocument(currentDoc);
        render();
        updateDocStrip();
        updateUndoRedoButtons();
    }

    function updateUndoRedoButtons() {
        if (undoBtn) undoBtn.disabled = !currentDoc || !scoreStore.canUndo();
        if (redoBtn) redoBtn.disabled = !currentDoc || !scoreStore.canRedo();
    }

    if (undoBtn) undoBtn.onclick = () => {
        if (!currentDoc) return;
        const restored = scoreStore.undo(scoreContent(currentDoc));
        if (!restored) return;
        applyDocContent(restored);
        setStatus('Undid last change.');
    };

    if (redoBtn) redoBtn.onclick = () => {
        if (!currentDoc) return;
        const restored = scoreStore.redo(scoreContent(currentDoc));
        if (!restored) return;
        applyDocContent(restored);
        setStatus('Redid last undone change.');
    };

    // Always runs this page's own undo/redo on Ctrl+Z/Ctrl+Shift+Z, same reasoning as main.js's
    // identical choice not to special-case focus/native text-field undo (see its own comment) --
    // /score has no free-text field where that distinction would matter anyway (Tempo is the only
    // text input, and it isn't part of the document/undo stack at all).
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) { if (redoBtn) redoBtn.onclick(); } else { if (undoBtn) undoBtn.onclick(); }
        }
    });

    let currentXml = null;
    let currentResult = null;
    let currentDoc = null; // set as soon as a file is chosen; has stable chord ids

    // Bass/Bari/Lead/Tenor — matches state.js's existing voice-index convention (settings.
    // partSettings, per-voice tuning, etc. are all keyed by this same order), not the
    // Tenor/Lead/Bari/Bass order JsChordSummary happens to use.
    const VOICE_ORDER = [
        { part: 'Bass', field: 'bass', fallback: { step: 'g', oct: 3 } },
        { part: 'Bari', field: 'bari', fallback: { step: 'b', oct: 3 } },
        { part: 'Lead', field: 'lead', fallback: { step: 'd', oct: 4 } },
        { part: 'Tenor', field: 'tenor', fallback: { step: 'f', oct: 4 } },
    ];

    function parseVoiceString(str, fallback) {
        const m = typeof str === 'string' && str.match(/^([a-gA-G])(bb|b|#|x)?([0-8])$/);
        if (!m) {
            // Resting ("–") or anything else unparseable — keep a plausible pitch so the
            // voice has something sane to start from if it's un-rested later in the editor.
            return { step: fallback.step, acc: 0, oct: fallback.oct, rest: true };
        }
        return { step: m[1].toLowerCase(), acc: STR_TO_ACC[m[2] || ''], oct: parseInt(m[3], 10), rest: false };
    }

    // Bass/Bari/Lead/Tenor cents fields on JsChordSummary, matching VOICE_ORDER's part order —
    // parallel to the .field lookups used for pitch below.
    const CENTS_FIELD = { Bass: 'bassCents', Bari: 'bariCents', Lead: 'leadCents', Tenor: 'tenorCents' };

    /** JsChordSummary (plain display strings + vowel/cents, plan.md §9.9.15-era MusicXML
        round-trip work) -> state.js's chord shape (plan.md §2/§10.2). A preset vowel's f1/f2/f3
        aren't carried through MusicXML (WebApi.kt's doc explains why) — re-derived here from the
        same VOWEL_PRESETS_EAR table the Chord page itself uses, so this can't drift out of sync
        with it. "custom" has no table entry, so its numbers *are* carried through and used as-is.
        A file with no vowel data at all (not a re-import of this app's own export) falls back to
        this screen's existing default. */
    function toStateChord(c, keyFifths = 0) {
        const vowelKey = c.vowelKey || 'a';
        const isCustom = vowelKey === 'custom';
        const preset = !isCustom && VOWEL_PRESETS_EAR[vowelKey];
        const formants = isCustom
            ? { f1: c.vowelF1, f2: c.vowelF2, f3: c.vowelF3 }
            : preset
                ? { f1: preset[0], f2: preset[1], f3: preset[2] }
                : { f1: 730, f2: 1090, f3: 2440 }; // unrecognized key — same fallback as no-vowel-data
        const voices = VOICE_ORDER.map(({ part, field, fallback }) =>
            Object.assign({ part }, parseVoiceString(c[field], fallback))
        );
        return {
            id: newChordId(),
            beats: c.beats,
            voices,
            tuning: VOICE_ORDER.map(({ part }) => c[CENTS_FIELD[part]] || 0),
            vowel: preset || isCustom ? vowelKey : 'a',
            formants,
            // Raw Roman-numeral text of a newly-designated pillar chord at this position (plan.md
            // §40.3), or null -- re-parsed against the locally active key wherever it's needed,
            // never pre-resolved here.
            pillarChord: c.pillarChord || null,
            volumePerPart: [1, 1, 1, 1],
            // Computed once at import (plan.md §10.9), not left null -- render() needs a name
            // source that stays correctly *positioned* even after a chord's inserted/removed
            // elsewhere in the list, which the Kotlin-derived currentResult.chords[i] array can't
            // give it (that array is fixed-length/fixed-order from import time, so any splice
            // desyncs its indices from currentDoc.chords' the moment one happens). Still goes
            // stale after a *live* edit to this same chord's own notes, same as before (a real
            // analysis pass only runs at import/insert/replace time, not on every edit) --
            // unchanged, deliberate limitation, not something this fixes or was meant to.
            analysis: analyzeChord(voices.map(v => voiceDisplayString(v)), { tuning_style: 'just', keyFifths }),
        };
    }

    function voiceDisplayString(v) {
        if (!v || v.rest) return '–';
        return v.step.toUpperCase() + (ACC_TO_STR[v.acc] || '') + v.oct;
    }

    // Cents are shown alongside each note so a retune/edit is actually visible in the table, not
    // just in the underlying data (Mike, 2026-07-20) -- same +/- convention as the Chord editor's
    // own tuning-input display. Skipped for a rest ("–") or when there's no cents value to show.
    function appendCents(noteStr, cents) {
        if (!noteStr || noteStr === '–' || cents === undefined || cents === null) return noteStr;
        return `${noteStr} (${cents > 0 ? '+' + cents : cents})`;
    }

    // Single value per chord (vowel is chord-level, not per-voice) -- a dash for "custom" keeps
    // the column narrow, since the actual formant numbers aren't worth the table space here.
    function vowelDisplayString(vowelKey) {
        return (!vowelKey || vowelKey === 'custom') ? '—' : vowelKey;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function setStatus(msg, isError) {
        statusEl.textContent = msg;
        statusEl.className = isError ? 'status error' : 'status';
    }

    // currentResult (the raw Kotlin import summary) is only ever present alongside currentDoc --
    // set together on import/resume, cleared together on failure -- with one exception: a score
    // created from scratch via "+ New score" (plan.md §15's usability follow-up) has a currentDoc
    // but no currentResult at all, since there's no original file to have imported. render() is
    // keyed entirely off currentDoc/currentDoc.metadata as a result -- currentResult only still
    // supplies import-time warnings, which a hand-created score has none of anyway.
    function render() {
        if (!currentDoc) return;
        const result = currentResult;
        const meta = currentDoc.metadata;
        const keyChangeSuffix = meta.keyChanges && meta.keyChanges.length > 1
            ? ` (+${meta.keyChanges.length - 1} change${meta.keyChanges.length > 2 ? 's' : ''})` : '';
        summaryEl.textContent = `Key: ${meta.keyFifths} fifths${keyChangeSuffix}  |  Time: ${meta.timeBeats}/${meta.timeBeatType}  |  ${currentDoc.chords.length} chords`;

        const warnings = result ? result.warnings : [];
        warningsEl.innerHTML = warnings.length
            ? '<strong>' + warnings.length + ' warning(s):</strong><ul>' +
              warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>'
            : '';

        // currentDoc.metadata.measureBoundariesBeats, not result.measureBoundariesBeats -- the
        // latter is only ever the stale, import-time snapshot, while syncMeasureBoundaries()
        // (plan.md §10.9.2) keeps the former live as chords are inserted/appended/replaced. Using
        // the stale one here (as this used to) meant these on-page "Measure N" dividers could
        // silently disagree with what export actually produces once a picker edit changed the
        // total beat count.
        const boundaries = meta.measureBoundariesBeats;
        const EPS = 1e-6;
        let boundaryIdx = 0;
        let pos = 0;
        // The *active* pillar chord for each row (plan.md §40.3) -- "stays in effect until a new
        // one is designated" resolves for free with a single running variable, since rows are
        // walked in document order: each chord's own declaration (if any) overwrites it before
        // that row is rendered, so every row after sees the nearest preceding declaration.
        let activePillarText = null;
        const rows = [];
        currentDoc.chords.forEach((docChord, i) => {
            while (boundaryIdx < boundaries.length - 1 && pos >= boundaries[boundaryIdx] - EPS) {
                rows.push(`<tr class="measure-row"><td colspan="10">Measure ${boundaryIdx + 1}</td></tr>`);
                boundaryIdx++;
            }
            const tenor = appendCents(voiceDisplayString(docChord.voices[3]), docChord.tuning[3]);
            const lead = appendCents(voiceDisplayString(docChord.voices[2]), docChord.tuning[2]);
            const bari = appendCents(voiceDisplayString(docChord.voices[1]), docChord.tuning[1]);
            const bass = appendCents(voiceDisplayString(docChord.voices[0]), docChord.tuning[0]);
            const vowel = vowelDisplayString(docChord.vowel);
            const beats = docChord.beats;
            // docChord.analysis (computed once at import/insert/replace time, see toStateChord's
            // own comment) is the name source -- stays correctly positioned across a splice,
            // unlike a position-based lookup into a separate array would. Roman-numeral display
            // (plan.md §34) falls back to the letter name for a chord quality with no Roman-
            // numeral convention in this app's vocabulary (roman_numeral is null in that case).
            const showRoman = showRomanNumeralsEl.checked;
            const name = docChord.analysis
                ? (showRoman ? (docChord.analysis.roman_numeral || docChord.analysis.common_name) : docChord.analysis.common_name)
                : '?';
            const editLink = `<a href="../?sid=${encodeURIComponent(docChord.id)}" target="_blank">Edit</a>`;
            // Click-to-edit picker (plan.md §10.2's item 7): a lighter way to change just the
            // vowel without opening the full Chord editor.
            const vowelTd = `<td class="vowel-col vowel-editable" data-idx="${i}" title="Click to change vowel">${escapeHtml(vowel)}</td>`;

            // Pillar-chord designation + consistency indicator (plan.md §40.3).
            if (docChord.pillarChord) activePillarText = docChord.pillarChord;
            const rowKeyFifths = keyFifthsAtBeat(meta.keyChanges, pos);
            const resolvedPillar = activePillarText ? parseRomanNumeral(activePillarText, rowKeyFifths) : null;
            let badge = '';
            let voiceItBtn = '';
            if (activePillarText && !resolvedPillar) {
                badge = `<span class="pillar-badge unparseable" title="&quot;${escapeHtml(activePillarText)}&quot; isn't a recognized Roman numeral">?</span>`;
            } else if (resolvedPillar) {
                const pillarPcs = chordPitchClasses(resolvedPillar.pattern, resolvedPillar.rootPc);
                const verdict = checkPillarConsistency(docChord.voices, pillarPcs);
                if (verdict === 'consistent') {
                    badge = `<span class="pillar-badge consistent" title="Consistent with the active pillar chord (${escapeHtml(activePillarText)})">✓</span>`;
                    voiceItBtn = `<button class="row-action-btn" data-voice-it-idx="${i}" data-voice-it-pattern="${resolvedPillar.pattern}" data-voice-it-root="${resolvedPillar.rootPc}" title="Search voicings of the active pillar chord (${escapeHtml(activePillarText)}) keeping this chord's own notes fixed">🎯 Voice it</button>`;
                } else if (verdict === 'inconsistent') {
                    badge = `<span class="pillar-badge inconsistent" title="Not a chord tone of the active pillar chord (${escapeHtml(activePillarText)})">⚠</span>`;
                }
                // 'undetermined' (nothing entered yet) shows no badge at all -- nothing to flag.
            }
            const pillarTd = `<td class="pillar-col"><input type="text" class="pillar-input" data-idx="${i}"
                value="${escapeHtml(docChord.pillarChord || '')}" placeholder="${activePillarText ? escapeHtml(activePillarText) : '—'}"
                title="Declare this chord as a new pillar (e.g. &quot;ii7&quot;) -- blank inherits from before">${badge}</td>`;

            // Insert-before/Replace (plan.md §10.9's chord picker).
            const rowActions = `${editLink}
                <button class="row-action-btn" data-picker-mode="insert" data-picker-idx="${i}" title="Insert a new chord before this one">⊕ Insert</button>
                <button class="row-action-btn" data-picker-mode="replace" data-picker-idx="${i}" title="Replace this chord">↻ Replace</button>
                ${voiceItBtn}`;
            rows.push(`<tr>
                <td>${i}</td><td>${beats}</td><td>${escapeHtml(name)}</td>
                ${pillarTd}
                ${vowelTd}
                <td class="cents-note">${escapeHtml(tenor)}</td><td class="cents-note">${escapeHtml(lead)}</td>
                <td class="cents-note">${escapeHtml(bari)}</td><td class="cents-note">${escapeHtml(bass)}</td>
                <td>${rowActions}</td>
            </tr>`);
            pos += beats;
        });
        chordsEl.innerHTML = rows.join('');
        appendChordBtn.disabled = !currentDoc;
    }

    // Inline vowel picker (plan.md §10.2's item 7, built 2026-07-21): clicking a chord's vowel
    // cell swaps it for a <select> of the same 18 presets the Chord page's own radio buttons
    // offer, so a vowel-only tweak doesn't require opening the full editor in a new tab. "custom"
    // is shown (disabled) when that's the chord's current vowel, so the cell still reflects real
    // state, but isn't selectable here -- editing a custom vowel's actual f1/f2/f3 numbers still
    // needs the full Chord editor, this picker only knows about the fixed preset table.
    function vowelOptionsHtml(selectedKey) {
        let html = Object.keys(VOWEL_PRESETS_EAR)
            .map(k => `<option value="${k}"${k === selectedKey ? ' selected' : ''}>[${k}]</option>`)
            .join('');
        if (selectedKey === 'custom') {
            html += '<option value="custom" selected disabled>custom</option>';
        }
        return html;
    }

    function openVowelPicker(td, idx) {
        const chord = currentDoc.chords[idx];
        const select = document.createElement('select');
        select.className = 'vowel-picker';
        select.innerHTML = vowelOptionsHtml(chord.vowel);
        td.textContent = '';
        td.appendChild(select);
        select.focus();

        // Applies on change and leaves the cell in a normal (non-editing) state either way --
        // re-rendering after a plain blur-with-no-change just puts the same display text back.
        select.addEventListener('change', () => {
            const key = select.value;
            const preset = VOWEL_PRESETS_EAR[key];
            if (!preset) return; // "custom" is disabled, shouldn't be reachable via change
            pushDocUndo();
            chord.vowel = key;
            chord.formants = { f1: preset[0], f2: preset[1], f3: preset[2] };
            currentDoc.updatedAt = Date.now();
            writeScoreDocument(currentDoc);
            updateDocStrip();
            updateUndoRedoButtons();
            setStatus(`Chord ${idx}: vowel set to [${key}].`);
            render();
        });
        select.addEventListener('blur', () => render());
    }

    // Delegated (rows are fully replaced on every render(), so per-row listeners would be lost) --
    // guards against re-opening a picker that's already open (the select itself is inside the same
    // <td>, so a click to open its native dropdown also bubbles up and matches the selector again).
    chordsEl.addEventListener('click', (e) => {
        const td = e.target.closest('td.vowel-editable');
        if (!td || !currentDoc || td.querySelector('select')) return;
        const idx = parseInt(td.dataset.idx, 10);
        if (Number.isNaN(idx) || !currentDoc.chords[idx]) return;
        openVowelPicker(td, idx);
    });

    // Chord picker (plan.md §10.9): a modal for inserting/appending/replacing a chord in the
    // score's list -- name it, fix 1-2 specific voice pitches, or both, and pick from the real
    // matching voicings voicing-generator.js's search returns. Deliberately a modal, not another
    // ?sid= tab (agreed with Mike) -- it only ever writes into score:current through the same
    // pushDocUndo()/writeScoreDocument() path bulk re-tune and the vowel picker already use, so
    // undo/redo covers it for free, no cross-tab sync to design.
    let pickerTarget = null; // { mode: 'insert' | 'replace' | 'append', index }
    const PICKER_RESULT_CAP = 60;
    const FIX_NOTE_PATTERN = /^([a-gA-G])(bb|b|#|x)?([0-8])$/;

    function parseFixInput(text) {
        const trimmed = (text || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(FIX_NOTE_PATTERN);
        return m ? { step: m[1].toLowerCase(), acc: STR_TO_ACC[m[2] || ''], oct: parseInt(m[3], 10) } : undefined;
    }

    // Cumulative beat position at which currentDoc.chords[index] starts (or, for index ==
    // chords.length, where an appended chord would start) -- same summation render() already
    // does for its measure-boundary rows, pulled out so the picker's per-position key lookup
    // (plan.md §26) can reuse it instead of re-deriving it.
    function chordStartBeat(index) {
        let pos = 0;
        for (let i = 0; i < index; i++) pos += currentDoc.chords[i].beats;
        return pos;
    }

    function openChordPicker(mode, index) {
        if (!currentDoc) return;
        pickerTarget = { mode, index };
        pickerTargetLabelEl.textContent = mode === 'append' ? `Appending chord #${currentDoc.chords.length}`
            : mode === 'insert' ? `Inserting before chord #${index}`
            : `Replacing chord #${index}`;
        pickerNameInput.value = '';
        pickerBeatsInput.value = mode === 'replace' ? String(currentDoc.chords[index].beats) : '1';
        // Replacing a partial chord (one or more voices resting -- e.g. a MuseScore file with
        // only 1-2 voices written in so far, plan.md §18) prepopulates "fix specific notes" with
        // whatever's already sounding, so the first search is already constrained to keep those
        // notes and fill in the rest, instead of the user retyping them by hand. Insert/append
        // have no existing chord to prepopulate from.
        const target = mode === 'replace' ? currentDoc.chords[index] : null;
        [0, 1, 2, 3].forEach(i => {
            const voice = target && target.voices[i];
            document.getElementById(`pickerFix-${i}`).value =
                voice && !voice.rest ? voiceDisplayString(voice) : '';
        });
        showPickerStatus('', false);
        pickerResultsEl.innerHTML = '';
        chordPickerOverlay.style.display = 'flex';
        pickerNameInput.focus();
    }

    function closeChordPicker() {
        chordPickerOverlay.style.display = 'none';
        pickerTarget = null;
    }

    function showPickerStatus(msg, isError) {
        pickerStatusEl.textContent = msg;
        pickerStatusEl.className = isError ? 'status error' : 'status';
    }

    function runPickerSearch() {
        const nameText = pickerNameInput.value.trim();
        const opts = {};

        if (nameText) {
            const parsed = parseChordName(nameText);
            if (!parsed) {
                showPickerStatus(`"${nameText}" isn't a recognized chord name (try e.g. Cm7, F#7, Bbmaj7).`, true);
                pickerResultsEl.innerHTML = '';
                return;
            }
            opts.pattern = parsed.pattern;
            const rootSemi = getAbsSemitone({ step: parsed.rootStep, acc: parsed.rootAcc, oct: 0 });
            opts.rootPc = ((rootSemi % 12) + 12) % 12;
        }

        const fixed = [];
        for (const voice of [0, 1, 2, 3]) {
            const raw = document.getElementById(`pickerFix-${voice}`).value;
            if (!raw.trim()) continue;
            const parsedNote = parseFixInput(raw);
            if (!parsedNote) {
                showPickerStatus(`"${raw}" isn't a recognized note (try e.g. C4, F#3, Bb4).`, true);
                pickerResultsEl.innerHTML = '';
                return;
            }
            fixed.push({ voice, semi: getAbsSemitone(parsedNote) });
        }
        if (fixed.length) opts.fixed = fixed;

        if (!opts.pattern && !fixed.length) {
            showPickerStatus('Enter a chord name and/or fix at least one note to search.', true);
            pickerResultsEl.innerHTML = '';
            return;
        }

        // Ranks results by barbershoppiness + in-key-ness (plan.md §23) against the key signature
        // actually active at this chord's position -- mid-piece key changes are now tracked
        // (plan.md §26), so this is the real local key, not just the score's beat-0 one.
        opts.keyFifths = keyFifthsAtBeat(currentDoc.metadata.keyChanges, chordStartBeat(pickerTarget.index));
        renderPickerResults(generateVoicings(opts), opts.keyFifths);
    }

    function renderPickerResults(results, keyFifths = 0) {
        if (!results.length) {
            showPickerStatus('No matching chords found.', false);
            pickerResultsEl.innerHTML = '';
            return;
        }
        const shown = results.slice(0, PICKER_RESULT_CAP);
        showPickerStatus(
            results.length > PICKER_RESULT_CAP
                ? `Showing first ${PICKER_RESULT_CAP} of ${results.length} matches — narrow your search for more precise results.`
                : `${results.length} match${results.length === 1 ? '' : 'es'}.`,
            false
        );

        pickerResultsEl.innerHTML = shown.map(r => {
            const qualityName = (CHORD_PATTERNS[r.pattern] && CHORD_PATTERNS[r.pattern].name) || r.pattern;
            const label = `${getKeyAwarePCName(r.rootPc, keyFifths)} ${qualityName}`;
            // r.voices is Bass/Bari/Lead/Tenor (index 0-3, matching VOICE_ORDER) -- displayed
            // Tenor-first to match the score table's own column order.
            const notesDisplay = [3, 2, 1, 0].map(i => voiceDisplayString(r.voices[i])).join(' / ');
            const tentativeNote = r.tentative
                ? '<div class="picker-result-tentative">Not yet vetted by ear — may need adjustment</div>' : '';
            return `<div class="picker-result">
                <div>
                    <div>${escapeHtml(label)} — ${escapeHtml(r.description)}</div>
                    <div class="picker-result-notes">${escapeHtml(notesDisplay)}</div>
                    ${tentativeNote}
                </div>
                <button class="picker-result-revoice-btn" data-revoice-idx="${shown.indexOf(r)}" title="Swap parts or bump a part an octave before committing this candidate">🔀 Revoice</button>
            </div>`;
        }).join('');

        pickerResultsEl.querySelectorAll('.picker-result').forEach((el, i) => {
            el.addEventListener('click', () => commitPickerResult(shown[i]));
        });
        // Revoice button lives inside the same clickable row (plan.md §17) -- stopPropagation so
        // clicking it opens the revoice dialog instead of immediately committing the un-revoiced
        // candidate underneath it.
        pickerResultsEl.querySelectorAll('.picker-result-revoice-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                openScoreRevoiceDialog(shown[parseInt(btn.dataset.revoiceIdx, 10)]);
            });
        });
    }

    // Revoice dialog for a not-yet-committed picker candidate (plan.md §17): staged locally in
    // revoiceVoices while open, same shape/behavior as the Chord editor's own revoice dialog
    // (main.js) but committing through commitPickerResult() on Apply instead of writing directly
    // into a chord -- a candidate has no tuning of its own yet (commitPickerResult always
    // re-derives it fresh via analyzeChord(), see its own comment), so unlike main.js's version
    // this one only ever stages voices, never cents.
    let revoiceVoices = null;
    // The picker candidate's own resolved local key (plan.md §33), staged alongside
    // revoiceVoices -- resolved once when the dialog opens, same value runPickerSearch() already
    // used to rank the candidate being revoiced.
    let revoiceKeyFifths = 0;

    function renderScoreRevoiceDialog() {
        drawChord('revoiceNotation', revoiceVoices, revoiceKeyFifths);

        const swapsEl = document.getElementById('revoiceSwaps');
        swapsEl.innerHTML = SWAP_PAIRS.map(([a, b], i) =>
            `<button data-swap-idx="${i}">${VOICE_LABELS[a]} ↔ ${VOICE_LABELS[b]}</button>`
        ).join('');
        swapsEl.querySelectorAll('button').forEach((btn, i) => {
            btn.onclick = () => {
                const [a, b] = SWAP_PAIRS[i];
                revoiceVoices = swapVoices(revoiceVoices, null, a, b).voices;
                renderScoreRevoiceDialog();
            };
        });

        const octEl = document.getElementById('revoiceOctaves');
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
                revoiceVoices = bumpOctave(revoiceVoices, idx, dir, revoiceKeyFifths);
                renderScoreRevoiceDialog();
            };
        });
    }

    function openScoreRevoiceDialog(candidate) {
        revoiceVoices = candidate.voices.map(v => Object.assign({}, v));
        revoiceKeyFifths = pickerTarget
            ? keyFifthsAtBeat(currentDoc.metadata.keyChanges, chordStartBeat(pickerTarget.index))
            : 0;
        renderScoreRevoiceDialog();
        scoreRevoiceOverlay.style.display = 'flex';
    }

    function closeScoreRevoiceDialog() {
        scoreRevoiceOverlay.style.display = 'none';
        revoiceVoices = null;
    }

    revoiceCloseBtn.onclick = closeScoreRevoiceDialog;
    revoiceCancelBtn.onclick = closeScoreRevoiceDialog;
    revoiceApplyBtn.onclick = () => {
        const voices = revoiceVoices;
        closeScoreRevoiceDialog();
        commitPickerResult({ voices });
    };

    // Both the exporter (MusicXmlExporter.buildSlices()/renderPart()) and this page's own
    // "Measure N" divider rows only ever look at content up to metadata.measureBoundariesBeats'
    // own last entry -- anything the chord picker adds beyond that is silently invisible to both,
    // not just mis-displayed. Caught live (2026-07-23, Mike): inserting a chord before the first
    // of a 2-chord/2-beat/2-4-time score dropped the *original second chord* on export -- true
    // data loss, confirmed by reloading the exported file and finding it gone, not just a
    // rendering quirk. Rebuilds boundaries from scratch using uniform measureBeats-length
    // measures (metadata.timeBeats * 4 / timeBeatType quarter-note-beats per measure, matching
    // MusicXML's <divisions> convention of always counting beats in quarter notes) rather than
    // trying to preserve the original file's own boundary positions -- correct for the common
    // case (a regular meter, no pickup measure); a real, accepted simplification for a file with
    // an irregular first/last measure (it gets flattened into a regular one the first time the
    // chord picker touches that score), far better than the silent data loss it replaces.
    function syncMeasureBoundaries(doc) {
        const meta = doc.metadata;
        const totalBeats = doc.chords.reduce((sum, c) => sum + c.beats, 0);
        const measureBeats = meta.timeBeats * 4 / meta.timeBeatType;
        const boundaries = [0];
        while (boundaries[boundaries.length - 1] < totalBeats - 1e-9) {
            boundaries.push(boundaries[boundaries.length - 1] + measureBeats);
        }
        if (boundaries.length < 2) boundaries.push(measureBeats);
        meta.measureBoundariesBeats = boundaries;
    }

    function commitPickerResult(candidate) {
        if (!currentDoc || !pickerTarget) return;

        // candidate.voices is already Bass/Bari/Lead/Tenor (index 0-3), the same order
        // VOICE_ORDER/analyzeChord's positional part-labeling expects -- see VOICE_ORDER's own
        // comment and retuneBtn's identical noteStrs construction.
        const noteStrs = VOICE_ORDER.map((_, i) => voiceDisplayString(candidate.voices[i]));
        // Same key resolution runPickerSearch() already used to rank these results (plan.md
        // §15/§26) -- recomputed here rather than threaded through candidate, since pickerTarget
        // is still valid at commit time and this is cheap.
        const keyFifths = keyFifthsAtBeat(currentDoc.metadata.keyChanges, chordStartBeat(pickerTarget.index));
        const analysis = analyzeChord(noteStrs, { tuning_style: 'just', keyFifths });
        // Every template round-trips through analyzeChord() at every root (js-tests.html group
        // 20) -- this fallback exists so a future template that doesn't would degrade to equal
        // temperament rather than crash, not because it's expected to trigger.
        const tuning = analysis.notes.length === 4 ? analysis.notes.map(n => n.tuning) : [0, 0, 0, 0];

        const newChord = {
            id: newChordId(),
            beats: parseFloat(pickerBeatsInput.value) || 1,
            voices: VOICE_ORDER.map(({ part }, i) => ({
                part, step: candidate.voices[i].step, acc: candidate.voices[i].acc,
                oct: candidate.voices[i].oct, rest: false,
            })),
            tuning,
            // Fixed default vowel/formants ('a', matching toStateChord()'s own import-time
            // fallback) -- the picker is about voicing, not vowel; use the existing vowel picker
            // afterward same as any imported chord.
            vowel: 'a',
            formants: { f1: 730, f2: 1090, f3: 2440 },
            // Replace keeps the slot's own pillar designation (a property of the slot, not the
            // particular voicing picked for it, plan.md §40.3); Insert/Append have no prior slot
            // to inherit from, so they start with none, same as any other new chord.
            pillarChord: pickerTarget.mode === 'replace'
                ? (currentDoc.chords[pickerTarget.index].pillarChord || null) : null,
            volumePerPart: [1, 1, 1, 1],
            analysis,
        };

        pushDocUndo();
        if (pickerTarget.mode === 'append') {
            currentDoc.chords.push(newChord);
        } else if (pickerTarget.mode === 'insert') {
            currentDoc.chords.splice(pickerTarget.index, 0, newChord);
        } else {
            currentDoc.chords[pickerTarget.index] = newChord;
        }
        syncMeasureBoundaries(currentDoc);
        currentDoc.updatedAt = Date.now();
        writeScoreDocument(currentDoc);
        render();
        updateDocStrip();
        updateUndoRedoButtons();
        const verb = { append: 'appended', insert: 'inserted', replace: 'replaced' }[pickerTarget.mode];
        setStatus(`Chord ${verb}.`);
        closeChordPicker();
    }

    // Roman-numeral display toggle (plan.md §34) -- purely re-renders with the already-computed
    // roman_numeral field, no re-analysis needed.
    showRomanNumeralsEl.onchange = () => render();

    appendChordBtn.onclick = () => openChordPicker('append', currentDoc ? currentDoc.chords.length : 0);
    pickerCloseBtn.onclick = () => closeChordPicker();
    pickerSearchBtn.onclick = () => runPickerSearch();
    pickerNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runPickerSearch(); });
    chordPickerOverlay.addEventListener('click', (e) => { if (e.target === chordPickerOverlay) closeChordPicker(); });

    // Delegated for the same reason as the vowel-editable listener above -- rows (and their
    // Insert/Replace buttons) are fully replaced on every render().
    chordsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-picker-mode]');
        if (!btn || !currentDoc) return;
        openChordPicker(btn.dataset.pickerMode, parseInt(btn.dataset.pickerIdx, 10));
    });

    // Pillar-chord declaration (plan.md §40.3): plain always-editable text input, not a
    // click-to-reveal control like the vowel cell -- free text (a Roman numeral), not a choice
    // from a fixed list, so there's nothing to "reveal" a picker for. Commits on blur/Enter;
    // blank means "no new pillar here, inherit from before" (matches the placeholder, which
    // always shows whichever pillar is currently active up to this row).
    function commitPillarInput(input) {
        if (!currentDoc) return;
        const idx = parseInt(input.dataset.idx, 10);
        const chord = currentDoc.chords[idx];
        if (Number.isNaN(idx) || !chord) return;
        const value = input.value.trim() || null;
        if (value === (chord.pillarChord || null)) return; // no real change, skip a no-op undo entry
        pushDocUndo();
        chord.pillarChord = value;
        currentDoc.updatedAt = Date.now();
        writeScoreDocument(currentDoc);
        updateDocStrip();
        updateUndoRedoButtons();
        setStatus(value ? `Chord ${idx}: pillar chord set to "${value}".` : `Chord ${idx}: pillar declaration cleared.`);
        render();
    }
    chordsEl.addEventListener('change', (e) => {
        const input = e.target.closest('input.pillar-input');
        if (input) commitPillarInput(input);
    });
    chordsEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.closest('input.pillar-input')) e.target.blur();
    });

    // "Voice it" (plan.md §40.3): opens the same chord picker Insert/Replace already use, prefilled
    // exactly like Replace (existing non-resting voices locked as fixed), but searches the pillar's
    // own exact quality+root directly via generateVoicings() instead of round-tripping through
    // pickerNameInput's chord-name text parser -- more precise, and the pattern/root are already
    // known from the badge's own consistency check moments ago.
    chordsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-voice-it-idx]');
        if (!btn || !currentDoc) return;
        const idx = parseInt(btn.dataset.voiceItIdx, 10);
        const pattern = btn.dataset.voiceItPattern;
        const rootPc = parseInt(btn.dataset.voiceItRoot, 10);
        openChordPicker('replace', idx);
        const fixed = [];
        [0, 1, 2, 3].forEach(v => {
            const parsed = parseFixInput(document.getElementById(`pickerFix-${v}`).value);
            if (parsed) fixed.push({ voice: v, semi: getAbsSemitone(parsed) });
        });
        const keyFifths = keyFifthsAtBeat(currentDoc.metadata.keyChanges, chordStartBeat(idx));
        renderPickerResults(generateVoicings({ pattern, rootPc, fixed, keyFifths }), keyFifths);
    });

    // Choosing a file both imports it and immediately commits it as the shared score:current
    // document (plan.md §10.2), so every row's "Edit" link is live right away — no separate
    // "Load"/"Start editing" clicks (simplified 2026-07-12, previously two extra steps for no
    // real benefit on a single-user local tool). Re-choosing a file still reassigns fresh chord
    // ids, which orphans any edit tab still open on the old ones — a known v1 limitation, same
    // spirit as the concurrent-edit punt already noted in §6.3.
    fileInput.onchange = async () => {
        if (!WebApi) {
            setStatus('Engine bundle not loaded — run `./gradlew jsBrowserDevelopmentWebpack` in engine-kt/ first.', true);
            return;
        }
        const file = fileInput.files[0];
        if (!file) return;

        // Confirm before silently discarding unsaved edits (resolved 2026-07-20: prompting here
        // is enough, no separate "undo the import" mechanism needed on top of it -- plan.md
        // §10.7.7/§10.7.8). scoreStore.markImported() would otherwise wipe them with no way back.
        if (currentDoc && scoreStore.isDirty({ content: scoreContent(currentDoc), sourceSnapshot: currentDoc.sourceSnapshot }) &&
            !window.confirm('This will replace your current score, which has unsaved changes. Load the new file anyway and discard them?')) {
            fileInput.value = '';
            return;
        }

        try {
            currentXml = await file.text();
            currentResult = WebApi.importSummary(currentXml);
            // Parallel arrays (plan.md §26) zipped into the {atBeat, keyFifths} shape used
            // everywhere else in this file and in theory.js's keyFifthsAtBeat() -- computed here,
            // ahead of currentDoc itself (rather than read off currentDoc.metadata), since the
            // chords map right below needs it and currentDoc doesn't exist yet at this point.
            const keyChanges = Array.from(currentResult.keyChangeBeats).map((atBeat, i) => (
                { atBeat, keyFifths: currentResult.keyChangeFifths[i] }
            ));
            // Resolves each chord's own local key as it's imported (plan.md §15, so a chord
            // after a mid-piece key change gets spelled correctly too) -- a running beat
            // accumulator, mirroring the chord picker's own chordStartBeat()/keyFifthsAtBeat()
            // pattern, just inlined here since there's no currentDoc.chords array yet to sum over.
            let importBeatPos = 0;
            const chords = currentResult.chords.map(c => {
                const keyFifths = keyFifthsAtBeat(keyChanges, importBeatPos);
                importBeatPos += c.beats;
                return toStateChord(c, keyFifths);
            });
            currentDoc = {
                chords,
                metadata: {
                    keyFifths: currentResult.keyFifths,
                    keyChanges,
                    timeBeats: currentResult.timeBeats,
                    timeBeatType: currentResult.timeBeatType,
                    measureBoundariesBeats: Array.from(currentResult.measureBoundariesBeats),
                },
                // Persisted so a later page load (navigating away and back) can regenerate
                // currentResult -- see resumeDocument() below. Not read by state.js's ?sid= path
                // or anything else; an extra field on the same document, not a schema change to
                // what those readers already expect.
                sourceXml: currentXml,
                updatedAt: Date.now(),
            };
            // A new document invalidates any undo/redo history from whatever was open before --
            // see document-store.js's markImported doc comment.
            const importSnap = scoreStore.markImported(scoreContent(currentDoc), file.name);
            currentDoc.sourceLabel = importSnap.sourceLabel;
            currentDoc.sourceSnapshot = importSnap.sourceSnapshot;
            currentDoc.updatedAt = importSnap.updatedAt;
            writeScoreDocument(currentDoc);
            render();
            updateDocStrip();
            updateUndoRedoButtons();
            exportBtn.disabled = false;
            retuneBtn.disabled = false;
            setPlaybackButtonsEnabled(true);
            setStatus(`Loaded ${file.name} (${currentDoc.chords.length} chords) — click "Edit" on a row to open it.`);
        } catch (e) {
            currentResult = null;
            currentDoc = null;
            setStatus('Import failed: ' + e.message, true);
            exportBtn.disabled = true;
            retuneBtn.disabled = true;
            setPlaybackButtonsEnabled(false);
            updateDocStrip();
            updateUndoRedoButtons();
        }
    };

    // Live sync (§6.2/§10.2): another tab (the Chord page, editing one of these chords) writes
    // to score:current, and the `storage` event fires here — refresh the table in place rather
    // than requiring a reload. Deliberately not BroadcastChannel, for the Android-portability
    // reason in §6.1.
    window.addEventListener('storage', (e) => {
        if (e.key !== SCORE_STORAGE_KEY || !currentDoc) return;
        currentDoc = readScoreDocument();
        render();
        updateDocStrip();
        setStatus('Score updated from another tab.');
    });

    // score:current is the source of truth for edits (written by the Chord page, kept fresh here
    // via the `storage` listener below) — exporting from it, not from currentXml, is what makes
    // this an actual edit-save-reload loop rather than a no-op replay of the original file.
    // JsEditedChord/JsEditedVoice are @JsExport Kotlin data classes, constructed from JS the same
    // way any exported class is (positional args via `new`), not passed as plain object literals.
    function toJsEditedChord(chord) {
        const voices = chord.voices.map((v, i) =>
            new engine.barbershop.web.JsEditedVoice(
                v.part, (v.step || 'c').toUpperCase(), v.acc || 0, v.oct, !!v.rest,
                (chord.tuning && chord.tuning[i]) || 0
            )
        );
        const vowel = chord.vowel || null;
        const formants = chord.formants || {};
        return new engine.barbershop.web.JsEditedChord(
            chord.beats, voices, vowel, formants.f1 || 0, formants.f2 || 0, formants.f3 || 0,
            chord.pillarChord || null
        );
    }

    exportBtn.onclick = () => {
        if (!WebApi || !currentDoc) return;
        try {
            const jsChords = currentDoc.chords.map(toJsEditedChord);
            const meta = currentDoc.metadata;
            const exported = WebApi.exportEditedScore(
                jsChords, meta.keyFifths,
                Float64Array.from(meta.keyChanges.map(k => k.atBeat)),
                Int32Array.from(meta.keyChanges.map(k => k.keyFifths)),
                meta.timeBeats, meta.timeBeatType,
                Float64Array.from(meta.measureBoundariesBeats)
            );
            const blob = new Blob([exported], { type: 'application/vnd.recordare.musicxml+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'reexported.musicxml';
            a.click();
            URL.revokeObjectURL(url);
            // The exported content now also matches the file on disk -- move the dirty baseline,
            // but (unlike import) leave undo/redo history alone; it's still the same document,
            // still valid to step back through past this point (plan.md §10.7.2).
            const exportSnap = scoreStore.markExported({
                content: scoreContent(currentDoc),
                sourceLabel: currentDoc.sourceLabel,
            });
            currentDoc.sourceSnapshot = exportSnap.sourceSnapshot;
            currentDoc.updatedAt = exportSnap.updatedAt;
            writeScoreDocument(currentDoc);
            updateDocStrip();
            setStatus('Exported current edits to reexported.musicxml.');
        } catch (e) {
            setStatus('Export failed: ' + e.message, true);
        }
    };

    // Bulk re-tune (plan.md §10.2's Score-page punch list): recompute cents for every chord at
    // once instead of opening each one individually to trigger analysis. Uses the offline
    // theory.js engine directly (synchronous, no network round trips) rather than /analyze --
    // the same engine main.js falls back to in Offline Mode, and fast enough that even a large
    // score needs no progress indicator. allow_rootless is one global choice for the whole run,
    // not per-chord -- the Score data model has no place to store a per-chord override anyway.
    // Unconditionally overwrites every chord's cents, including any set by hand -- there's no
    // "custom, don't touch" flag in this data model (only the Chord-editor page's *global*
    // intonation setting has a 'custom' mode, chords here are just numbers) -- so this keeps its
    // confirm guard (§10.7.9's resolution: a prompt is sufficient protection for a bulk overwrite)
    // even though it's now also on the undo stack (§10.8.3) -- belt and suspenders, not either/or.
    retuneBtn.onclick = () => {
        if (!currentDoc) return;
        const tuningStyle = retuneIntonationEl.value;
        const allowRootless = retuneRootlessEl.checked;
        const total = currentDoc.chords.length;
        if (!window.confirm(`Recompute cents for all ${total} chords using ${retuneIntonationEl.options[retuneIntonationEl.selectedIndex].text} tuning? This overwrites any existing cents, including manual ones.`)) {
            return;
        }
        pushDocUndo();

        let retuned = 0;
        let skipped = 0;
        currentDoc.chords.forEach(chord => {
            const noteStrs = chord.voices.map(v => getNoteString(v));
            const result = analyzeChord(noteStrs, { allow_rootless: allowRootless, tuning_style: tuningStyle });
            // An unrecognized chord (fewer than 3 real notes, or no matching pattern) comes back
            // with notes: [] -- leave its existing cents alone rather than wiping them to nothing.
            if (result.notes && result.notes.length === chord.voices.length) {
                chord.tuning = result.notes.map(n => n.tuning);
                retuned++;
            } else {
                skipped++;
            }
        });

        currentDoc.updatedAt = Date.now();
        writeScoreDocument(currentDoc);
        render();
        updateDocStrip();
        updateUndoRedoButtons();
        setStatus(`Re-tuned ${retuned} of ${total} chords to ${tuningStyle}` + (skipped ? ` (${skipped} unrecognized chord(s) left unchanged).` : '.'));
    };

    // Whole-score playback (plan.md §10.5): converts each chord's beats into real seconds via the
    // BPM field, plays every chord back to back through the same synthesis engine the Chord page
    // uses. The 4-part mix/mute is playback-only -- read fresh from the sliders, never written to
    // score:current or the exported file.
    playScoreBtn.onclick = async () => {
        if (!currentDoc || !currentDoc.chords.length) return;
        const bpm = parseFloat(scoreBpmEl.value) || 120;
        // Only actually stop/close if something is currently playing (stopScoreBtn's disabled
        // state is a reliable proxy for that) -- unconditionally calling stopScorePlayback() here
        // was closing and discarding *any* existing context, including one primeAudioContext()
        // had already warmed up on the page's first click, forcing a cold recreation right before
        // scheduling and defeating priming's whole purpose on exactly the case it matters most
        // for: the first Play click of the session.
        if (!stopScoreBtn.disabled) stopScorePlayback();
        setPlaybackButtonsEnabled(false);
        stopScoreBtn.disabled = false;
        // playScore() properly awaits the audio context becoming ready before scheduling anything
        // -- on a freshly created/suspended context that can take several real seconds (confirmed
        // against a real recording), which is what made the first several chords land dead silent
        // rather than just quiet. Reflect that wait in the status instead of claiming "Playing"
        // before anything's actually scheduled.
        scorePlaybackStatusEl.textContent = 'Starting…';
        let totalSeconds;
        try {
            totalSeconds = await playScore(currentDoc.chords, bpm, readMixer(), SCORE_AUDIO_DEFAULTS);
        } catch (e) {
            scorePlaybackStatusEl.textContent = '';
            setStatus('Playback failed: ' + e.message, true);
            setPlaybackButtonsEnabled(true);
            stopScoreBtn.disabled = true;
            return;
        }
        scorePlaybackStatusEl.textContent = `Playing (${totalSeconds.toFixed(1)}s)…`;
        clearTimeout(playbackResetTimer);
        playbackResetTimer = setTimeout(() => {
            setPlaybackButtonsEnabled(true);
            stopScoreBtn.disabled = true;
            scorePlaybackStatusEl.textContent = '';
        }, totalSeconds * 1000);
    };

    stopScoreBtn.onclick = () => {
        clearTimeout(playbackResetTimer);
        stopScorePlayback();
        setPlaybackButtonsEnabled(true);
        stopScoreBtn.disabled = true;
        scorePlaybackStatusEl.textContent = '';
    };

    saveScoreWavBtn.onclick = async () => {
        if (!currentDoc || !currentDoc.chords.length) return;
        const bpm = parseFloat(scoreBpmEl.value) || 120;
        setPlaybackButtonsEnabled(false);
        scorePlaybackStatusEl.textContent = 'Rendering .wav…';
        try {
            await saveScoreAsWav(currentDoc.chords, bpm, readMixer(), SCORE_AUDIO_DEFAULTS);
            scorePlaybackStatusEl.textContent = '';
        } catch (e) {
            scorePlaybackStatusEl.textContent = '';
            setStatus('Save .wav failed: ' + e.message, true);
        } finally {
            setPlaybackButtonsEnabled(true);
        }
    };

    function hideResumeBanner() {
        resumeBannerEl.style.display = 'none';
    }

    // "+ New score" (plan.md §15's usability follow-up, 2026-07-24): the only way to get a
    // currentDoc used to be importing a file, so "+ Add chord" stayed disabled forever on a page
    // that had never had a file loaded. Reuses the same dirty-confirm guard as choosing a
    // replacement file (fileInput.onchange above) -- starting a new score is the same kind of
    // "discard what's here" action, so it also doubles as the "clear the current score" Mike asked
    // for separately: clearing IS starting fresh here, there's no distinct lighter-weight
    // empty-the-chords-but-keep-the-time-signature action. Time signature is asked up front (a
    // plain prompt, matching this app's existing house style for one-off input -- see the retune
    // confirm above) since the picker's voicing search and measure-boundary math both depend on
    // it and there's no metadata editor UI to fix a wrong default later; key signature has no such
    // UI need yet (nothing reads it besides display/export round-trip) so it silently defaults to
    // 0 (no sharps/flats).
    newScoreBtn.onclick = () => {
        if (currentDoc && scoreStore.isDirty({ content: scoreContent(currentDoc), sourceSnapshot: currentDoc.sourceSnapshot }) &&
            !window.confirm('Starting a new score will discard your current score, which has unsaved changes. Continue and discard them?')) {
            return;
        }
        const input = window.prompt('Time signature for the new score (beats/beat-type), e.g. "4/4":', '4/4');
        if (input === null) return;
        const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(input);
        const timeBeats = m && parseInt(m[1], 10);
        const timeBeatType = m && parseInt(m[2], 10);
        if (!m || timeBeats < 1 || ![1, 2, 4, 8, 16].includes(timeBeatType)) {
            setStatus(`Invalid time signature "${input}" — expected e.g. "4/4", with beat-type one of 1/2/4/8/16. New score not created.`, true);
            return;
        }
        currentXml = null;
        currentResult = null;
        currentDoc = {
            chords: [],
            metadata: { keyFifths: 0, keyChanges: [{ atBeat: 0, keyFifths: 0 }], timeBeats, timeBeatType, measureBoundariesBeats: [0, timeBeats * 4 / timeBeatType] },
            sourceXml: null,
            updatedAt: Date.now(),
        };
        // A new document invalidates any undo/redo history from whatever was open before -- see
        // document-store.js's markImported doc comment (same reasoning fileInput.onchange uses).
        const importSnap = scoreStore.markImported(scoreContent(currentDoc), `New score (${timeBeats}/${timeBeatType})`);
        currentDoc.sourceLabel = importSnap.sourceLabel;
        currentDoc.sourceSnapshot = importSnap.sourceSnapshot;
        currentDoc.updatedAt = importSnap.updatedAt;
        writeScoreDocument(currentDoc);
        hideResumeBanner();
        render();
        updateDocStrip();
        updateUndoRedoButtons();
        exportBtn.disabled = false;
        retuneBtn.disabled = false;
        setPlaybackButtonsEnabled(true);
        setStatus(`New score created (${timeBeats}/${timeBeatType}) — click "+ Add chord" to start.`);
    };

    // Fresh-session bootstrap (plan.md §10.7.9's Chord-page equivalent -- state.js's
    // resumeStandaloneDocument()), reworked 2026-07-24 (plan.md §15): score:current survives
    // navigating away and back (it's just localStorage), and this used to resume it completely
    // silently on every load -- surprising on a genuinely fresh visit, since there was no visible
    // cue that anything had been auto-loaded at all (Mike: "I wasn't expecting to open the page
    // from scratch and see the previous score still loaded"). A fresh load no longer auto-populates
    // the table at all; if a previous document exists, it only offers to resume it via the
    // #resumeBanner, one explicit click away -- nothing is lost, it's just not silent anymore.
    // currentResult (the raw import summary -- chord names, key/time signature, warnings) isn't
    // itself persisted, so for a document that came from a real file it's regenerated by re-running
    // WebApi.importSummary() against the original file text (persisted as sourceXml). A document
    // created via "+ New score" above has no sourceXml at all and resumes with currentResult left
    // null, same as it was when created (see render()'s own comment on why that's fine).
    function resumeDocument(doc) {
        try {
            // A document persisted before plan.md §26 has no metadata.keyChanges at all --
            // backfill a single beat-0 entry so the picker's per-position key lookup doesn't
            // choke on stale localStorage from an earlier session.
            if (doc.metadata && !doc.metadata.keyChanges) {
                doc.metadata.keyChanges = [{ atBeat: 0, keyFifths: doc.metadata.keyFifths || 0 }];
            }
            currentXml = doc.sourceXml || null;
            currentResult = currentXml ? WebApi.importSummary(currentXml) : null;
            currentDoc = doc;
            hideResumeBanner();
            render();
            updateDocStrip();
            updateUndoRedoButtons();
            exportBtn.disabled = false;
            retuneBtn.disabled = false;
            setPlaybackButtonsEnabled(true);
            setStatus(`Resumed ${currentDoc.sourceLabel || 'previous session'} (${currentDoc.chords.length} chords).`);
        } catch (e) {
            setStatus('Could not resume previous score: ' + e.message, true);
        }
    }

    resumeBtn.onclick = () => {
        const doc = readScoreDocument();
        if (doc) resumeDocument(doc);
    };
    dismissResumeBtn.onclick = hideResumeBanner;

    if (!WebApi) {
        setStatus('Engine bundle not loaded — run `./gradlew jsBrowserDevelopmentWebpack` in engine-kt/ first.', true);
        fileInput.disabled = true;
        newScoreBtn.disabled = true;
    } else {
        const doc = readScoreDocument();
        if (doc) {
            resumeBannerTextEl.textContent = `Resume "${doc.sourceLabel || 'previous score'}" (${doc.chords.length} chords)?`;
            resumeBannerEl.style.display = 'flex';
        }
    }
})();
