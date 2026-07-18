/* score.js — MusicXML import demo wired to the Kotlin engine's WebApi (plan.md §5.6/§5.7),
   the data-model bridge into the shared score:current document (§10.2 slice 1), and per-chord
   Edit links + live sync back from the Chord page (§10.2 slice 2). Choosing a file both loads
   and starts editing in one step (plan.md §10.2 UX simplification, 2026-07-12) — there's no
   "preview without committing" state anymore. */
import { STR_TO_ACC, ACC_TO_STR } from './spelling.js';
import { writeScoreDocument, readScoreDocument, newChordId, SCORE_STORAGE_KEY } from './score-store.js';
import { VOWEL_PRESETS_EAR } from './state.js';

(function () {
    const engine = window["barbershop-engine"];
    const WebApi = engine && engine.barbershop && engine.barbershop.web && engine.barbershop.web.WebApi;

    const fileInput = document.getElementById('xmlFile');
    const exportBtn = document.getElementById('exportBtn');
    const statusEl = document.getElementById('status');
    const summaryEl = document.getElementById('summary');
    const warningsEl = document.getElementById('warnings');
    const chordsEl = document.getElementById('chords');

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
                rows.push(`<tr class="measure-row"><td colspan="8">Measure ${boundaryIdx + 1}</td></tr>`);
                boundaryIdx++;
            }
            // If this score has been saved for editing, prefer the live voices out of
            // score:current over the import-time summary — reflects edits made in another tab
            // (§10.2 slice 2). The chord *name* isn't re-derived here (that needs a real
            // analysis pass, not just a display concern) so it can go stale after an edit.
            const docChord = docChords ? docChords[i] : null;
            const tenor = docChord ? voiceDisplayString(docChord.voices[3]) : c.tenor;
            const lead = docChord ? voiceDisplayString(docChord.voices[2]) : c.lead;
            const bari = docChord ? voiceDisplayString(docChord.voices[1]) : c.bari;
            const bass = docChord ? voiceDisplayString(docChord.voices[0]) : c.bass;
            const editLink = docChord
                ? `<a href="../?sid=${encodeURIComponent(docChord.id)}" target="_blank">Edit</a>`
                : '';
            rows.push(`<tr>
                <td>${i}</td><td>${c.beats}</td><td>${escapeHtml(c.name)}</td>
                <td>${escapeHtml(tenor)}</td><td>${escapeHtml(lead)}</td>
                <td>${escapeHtml(bari)}</td><td>${escapeHtml(bass)}</td>
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
            writeScoreDocument(currentDoc);
            render();
            exportBtn.disabled = false;
            setStatus(`Loaded ${file.name} (${currentDoc.chords.length} chords) — click "Edit" on a row to open it.`);
        } catch (e) {
            currentResult = null;
            currentDoc = null;
            setStatus('Import failed: ' + e.message, true);
            exportBtn.disabled = true;
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
            setStatus('Exported current edits to reexported.musicxml.');
        } catch (e) {
            setStatus('Export failed: ' + e.message, true);
        }
    };

    if (!WebApi) {
        setStatus('Engine bundle not loaded — run `./gradlew jsBrowserDevelopmentWebpack` in engine-kt/ first.', true);
        fileInput.disabled = true;
    }
})();
