/* score.js — MusicXML import demo wired to the Kotlin engine's WebApi (plan.md §5.6/§5.7),
   the data-model bridge into the shared score:current document (§10.2 slice 1), and per-chord
   Edit links + live sync back from the Chord page (§10.2 slice 2). Choosing a file both loads
   and starts editing in one step (plan.md §10.2 UX simplification, 2026-07-12) — there's no
   "preview without committing" state anymore. */
import { STR_TO_ACC, ACC_TO_STR } from './spelling.js';
import { writeScoreDocument, readScoreDocument, newChordId, SCORE_STORAGE_KEY } from './score-store.js';
import { VOWEL_PRESETS_EAR, getNoteString } from './state.js';
import { createDocumentStore } from './document-store.js';
import { analyzeChord } from './theory.js';
import { playScore, stopScorePlayback, saveScoreAsWav } from './audio.js';

// Fixed vibrato/formant-Q defaults, matching state.js's appState.settings.audio -- the Chord
// page's own knobs for these -- since /score has no equivalent UI (plan.md §10.5 only asked for
// tempo + the 4-part mix + mute, not a full audio-settings panel here too). vps/volume match the
// Chord page's own hardcoded defaults for the same reason.
const SCORE_AUDIO_DEFAULTS = {
    vibratoJitterCutoff: 100, vibratoJitterAmount: 2.5,
    phaseJitter: 0.08, vibratoDepth: 0.006,
    vibratoRateMean: 5.2, vibratoRateRange: 1.2,
    q1: 10, q2: 15,
    vps: 4, volume: 0.05,
};

(function () {
    const engine = window["barbershop-engine"];
    const WebApi = engine && engine.barbershop && engine.barbershop.web && engine.barbershop.web.WebApi;

    const fileInput = document.getElementById('xmlFile');
    const exportBtn = document.getElementById('exportBtn');
    const retuneBtn = document.getElementById('retuneBtn');
    const retuneIntonationEl = document.getElementById('retuneIntonation');
    const retuneRootlessEl = document.getElementById('retuneRootless');
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
    const scoreStore = createDocumentStore(SCORE_STORAGE_KEY);

    function scoreContent(doc) {
        return { chords: doc.chords, metadata: doc.metadata };
    }

    // Document label + dirty indicator (plan.md §10.7.5) -- no Undo/Redo here, deliberately: the
    // two Score-level mutations (import, bulk re-tune below) both get a confirm-before-discard/
    // -overwrite guard instead, matching §10.7.9's resolution that a prompt is protection enough
    // without a separate undo mechanism. Per-chord undo lives on the Chord-editor side.
    function updateDocStrip() {
        if (docLabelEl) docLabelEl.textContent = (currentDoc && currentDoc.sourceLabel) || 'No file loaded';
        if (!dirtyIndicatorEl) return;
        const dirty = !!currentDoc && scoreStore.isDirty({
            content: scoreContent(currentDoc),
            sourceSnapshot: currentDoc.sourceSnapshot,
        });
        dirtyIndicatorEl.textContent = dirty ? '● Unsaved changes' : '';
    }

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
    function toStateChord(c) {
        const vowelKey = c.vowelKey || 'a';
        const isCustom = vowelKey === 'custom';
        const preset = !isCustom && VOWEL_PRESETS_EAR[vowelKey];
        const formants = isCustom
            ? { f1: c.vowelF1, f2: c.vowelF2, f3: c.vowelF3 }
            : preset
                ? { f1: preset[0], f2: preset[1], f3: preset[2] }
                : { f1: 730, f2: 1090, f3: 2440 }; // unrecognized key — same fallback as no-vowel-data
        return {
            id: newChordId(),
            beats: c.beats,
            voices: VOICE_ORDER.map(({ part, field, fallback }) =>
                Object.assign({ part }, parseVoiceString(c[field], fallback))
            ),
            tuning: VOICE_ORDER.map(({ part }) => c[CENTS_FIELD[part]] || 0),
            vowel: preset || isCustom ? vowelKey : 'a',
            formants,
            volumePerPart: [1, 1, 1, 1],
            analysis: null,
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

    function render() {
        const result = currentResult;
        if (!result) return;
        summaryEl.textContent = `Key: ${result.keyFifths} fifths  |  Time: ${result.timeBeats}/${result.timeBeatType}  |  ${result.chords.length} chords`;

        warningsEl.innerHTML = result.warnings.length
            ? '<strong>' + result.warnings.length + ' warning(s):</strong><ul>' +
              result.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>'
            : '';

        const boundaries = result.measureBoundariesBeats;
        const EPS = 1e-6;
        let boundaryIdx = 0;
        let pos = 0;
        const rows = [];
        const docChords = currentDoc ? currentDoc.chords : null;
        result.chords.forEach((c, i) => {
            while (boundaryIdx < boundaries.length - 1 && pos >= boundaries[boundaryIdx] - EPS) {
                rows.push(`<tr class="measure-row"><td colspan="9">Measure ${boundaryIdx + 1}</td></tr>`);
                boundaryIdx++;
            }
            // If this score has been saved for editing, prefer the live voices out of
            // score:current over the import-time summary — reflects edits made in another tab
            // (§10.2 slice 2). The chord *name* isn't re-derived here (that needs a real
            // analysis pass, not just a display concern) so it can go stale after an edit.
            const docChord = docChords ? docChords[i] : null;
            const tenor = appendCents(docChord ? voiceDisplayString(docChord.voices[3]) : c.tenor, docChord ? docChord.tuning[3] : c.tenorCents);
            const lead = appendCents(docChord ? voiceDisplayString(docChord.voices[2]) : c.lead, docChord ? docChord.tuning[2] : c.leadCents);
            const bari = appendCents(docChord ? voiceDisplayString(docChord.voices[1]) : c.bari, docChord ? docChord.tuning[1] : c.bariCents);
            const bass = appendCents(docChord ? voiceDisplayString(docChord.voices[0]) : c.bass, docChord ? docChord.tuning[0] : c.bassCents);
            const vowel = vowelDisplayString(docChord ? docChord.vowel : c.vowelKey);
            const editLink = docChord
                ? `<a href="../?sid=${encodeURIComponent(docChord.id)}" target="_blank">Edit</a>`
                : '';
            rows.push(`<tr>
                <td>${i}</td><td>${c.beats}</td><td>${escapeHtml(c.name)}</td>
                <td class="vowel-col">${escapeHtml(vowel)}</td>
                <td class="cents-note">${escapeHtml(tenor)}</td><td class="cents-note">${escapeHtml(lead)}</td>
                <td class="cents-note">${escapeHtml(bari)}</td><td class="cents-note">${escapeHtml(bass)}</td>
                <td>${editLink}</td>
            </tr>`);
            pos += c.beats;
        });
        chordsEl.innerHTML = rows.join('');
    }

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
            currentDoc = {
                chords: currentResult.chords.map(toStateChord),
                metadata: {
                    keyFifths: currentResult.keyFifths,
                    timeBeats: currentResult.timeBeats,
                    timeBeatType: currentResult.timeBeatType,
                    measureBoundariesBeats: Array.from(currentResult.measureBoundariesBeats),
                },
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
            chord.beats, voices, vowel, formants.f1 || 0, formants.f2 || 0, formants.f3 || 0
        );
    }

    exportBtn.onclick = () => {
        if (!WebApi || !currentDoc) return;
        try {
            const jsChords = currentDoc.chords.map(toJsEditedChord);
            const meta = currentDoc.metadata;
            const exported = WebApi.exportEditedScore(
                jsChords, meta.keyFifths, meta.timeBeats, meta.timeBeatType,
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
    // intonation setting has a 'custom' mode, chords here are just numbers) -- so this is
    // confirmed like any other bulk-overwrite action rather than getting its own undo mechanism,
    // matching §10.7.9's resolution that a prompt is sufficient protection.
    retuneBtn.onclick = () => {
        if (!currentDoc) return;
        const tuningStyle = retuneIntonationEl.value;
        const allowRootless = retuneRootlessEl.checked;
        const total = currentDoc.chords.length;
        if (!window.confirm(`Recompute cents for all ${total} chords using ${retuneIntonationEl.options[retuneIntonationEl.selectedIndex].text} tuning? This overwrites any existing cents, including manual ones.`)) {
            return;
        }

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
        setStatus(`Re-tuned ${retuned} of ${total} chords to ${tuningStyle}` + (skipped ? ` (${skipped} unrecognized chord(s) left unchanged).` : '.'));
    };

    // Whole-score playback (plan.md §10.5): converts each chord's beats into real seconds via the
    // BPM field, plays every chord back to back through the same synthesis engine the Chord page
    // uses. The 4-part mix/mute is playback-only -- read fresh from the sliders, never written to
    // score:current or the exported file.
    playScoreBtn.onclick = () => {
        if (!currentDoc || !currentDoc.chords.length) return;
        const bpm = parseFloat(scoreBpmEl.value) || 120;
        stopScorePlayback(); // in case a previous playback is still ringing out
        const totalSeconds = playScore(currentDoc.chords, bpm, readMixer(), SCORE_AUDIO_DEFAULTS);
        setPlaybackButtonsEnabled(false);
        stopScoreBtn.disabled = false;
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

    if (!WebApi) {
        setStatus('Engine bundle not loaded — run `./gradlew jsBrowserDevelopmentWebpack` in engine-kt/ first.', true);
        fileInput.disabled = true;
    }
})();
