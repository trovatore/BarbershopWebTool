/* audio.js Serial: #021 */
import { getAbsSemitone } from './spelling.js';

export const SERIAL = "#024";

let audioCtx = null;
let sharedNoiseBuffer = null;

function getNoiseBuffer(ctx) {
    if (sharedNoiseBuffer) return sharedNoiseBuffer;
    const size = ctx.sampleRate * 2;
    sharedNoiseBuffer = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = sharedNoiseBuffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    return sharedNoiseBuffer;
}

// Attack/release scale with this voice's own duration (capped at the original fixed values) --
// Mike reported live that whole-score playback/Save .wav "continues with silence at the end" of
// most chords, confirmed by decoding a real rendered .wav's actual sample data (not just reading
// the code): a typical short score chord (e.g. a 1-beat chord at a normal tempo, floored to
// MIN_CHORD_SECONDS=0.7s by buildScoreSchedule) spent barely 0.05s at full volume before a fixed
// 0.5s release began -- 71% of the chord's entire ring time was an exponential decay toward
// near-silence, not a sustained tone. The fixed 0.15s/0.5s envelope was tuned for the single-chord
// page, where `duration` is always several seconds (§10.5.1's own comment says as much) -- fine
// there, wrong for a real score's much shorter per-chord durations. Capping each at a fraction of
// `duration` preserves the exact original 0.15/0.5 feel for anything long enough to not need
// scaling (duration >= 1s for attack, >= 1.67s for release) while guaranteeing a real sustained
// majority of any short chord's ring time instead of a near-immediate decay. Also structurally
// guarantees attack+release < duration for any positive duration (0.15+0.3 of duration < duration),
// though MIN_CHORD_SECONDS is left as-is -- this only fixes the envelope shape, not whether/how far
// a too-short beat value gets floored.
function createVoice(ctx, freq, startTime, duration, targetGain, opts) {
    const attack = Math.min(0.15, duration * 0.15);
    const release = Math.min(0.5, duration * 0.3);
    // Defensive coding: ensure all formants have numeric fallbacks to prevent crash
    const formants = [
        opts.f1 || 500, 
        opts.f2 || 1500, 
        opts.f3 || 2500, 
        opts.f4 || 3500, 
        opts.f5 || 4500
    ];

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, startTime);

    // Register Tilt: highshelf filter to dampen buzz (Chest vs Falsetto)
    const tiltFilter = ctx.createBiquadFilter();
    tiltFilter.type = 'highshelf';
    tiltFilter.frequency.setValueAtTime(1000, startTime);
    tiltFilter.gain.setValueAtTime((opts.tilt ?? 0) * -20, startTime);
    osc.connect(tiltFilter);

    const noise = ctx.createBufferSource();
    noise.buffer = getNoiseBuffer(ctx);
    noise.loop = true;

    const jitterFilter = ctx.createBiquadFilter();
    jitterFilter.type = 'lowpass';
    jitterFilter.frequency.value = opts.vibratoJitterCutoff;
    jitterFilter.Q.value = 0.5;

    const noiseGain = ctx.createGain();
    noiseGain.gain.value = opts.vibratoJitterAmount; 
    noise.connect(jitterFilter);
    jitterFilter.connect(noiseGain);
    // `vibrato` oscillator will not be meaningfully used if vibratoRateMean is 0, but still needs to be defined in this scope because it is started
    //  outside of this function.
    const vibrato = ctx.createOscillator();

    if (opts.vibratoRateMean > 0.01) {
        // Vibrato rate uniformly jittered around mean, with range defined by user.
        vibrato.frequency.value = opts.vibratoRateMean + ((Math.random() * 2 - 1) * opts.vibratoRateRange / 2);

        const vibratoGain = ctx.createGain();
        vibratoGain.gain.value = freq * opts.vibratoDepth;

        vibrato.connect(vibratoGain);
        noiseGain.connect(vibratoGain);
        vibratoGain.connect(osc.frequency);
    } else {
        // This is an easter egg to allow users to apply FM noise to the pitch without periodic vibrato.
        // In this case, the noise source directly jitters the pitch without going through a low-frequency vibrato oscillator.
        noiseGain.connect(osc.frequency);
    }

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, startTime);
    voiceGain.gain.linearRampToValueAtTime(targetGain, startTime + attack);
    voiceGain.gain.setValueAtTime(targetGain, startTime + duration - release);
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    formants.forEach((f, idx) => {
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = f;
        filter.Q.value = idx === 0 ? opts.q1 : (idx > 2 ? opts.q2 / 2 : opts.q2);
        
        const fGain = ctx.createGain();
        const baseGain = idx === 3 ? (opts.f4Gain ?? 0) : (idx === 4 ? (opts.f5Gain ?? 0) : 1.0);
        // Subtle volume boost to compensate for energy loss when tilting
        fGain.gain.value = baseGain * (1.0 + (opts.tilt ?? 0) * 0.5);

        tiltFilter.connect(filter);
        filter.connect(fGain);
        fGain.connect(voiceGain);
    });

    return { osc, vibrato, noise, gain: voiceGain };
}

function setupAudioGraph(ctx, chordState, startTime, duration, tuningData, opts, multiChannel = false) {
    let merger = null;
    if (multiChannel) {
        merger = ctx.createChannelMerger(4);
        merger.connect(ctx.destination);
    }
    
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-10, ctx.currentTime);
    compressor.knee.setValueAtTime(40, ctx.currentTime);
    compressor.ratio.setValueAtTime(12, ctx.currentTime);
    compressor.attack.setValueAtTime(0, ctx.currentTime);
    compressor.release.setValueAtTime(0.25, ctx.currentTime);

    const individualGainBase = opts.volume / Math.sqrt(Math.max(1, opts.vps));

    chordState.forEach((note, i) => {
        if (note.rest) return; // a resting voice contributes no sound at all, not a quiet one
        const baseCents = (tuningData && tuningData[i] !== undefined) ? tuningData[i] : 0;
        const partSpec = opts.partSettings ? opts.partSettings[i] : null;
        
        const partGain = (partSpec?.mute) ? 0 : (individualGainBase * (partSpec?.volume ?? 1.0));

        for (let v = 0; v < opts.vps; v++) {
            const phaseJitter = Math.random() * opts.phaseJitter;
            const voiceStart = startTime + phaseJitter;
            const microtuning = (Math.random() - 0.5) * 2;
            const freq = 440 * Math.pow(2, (getAbsSemitone(note) - 57 + ((baseCents + microtuning) / 100)) / 12);
            
            const partSpec = opts.partSettings ? opts.partSettings[i] : null;
            const voiceOpts = {
                ...opts,
                f4: partSpec?.f4,
                f5: partSpec?.f5,
                f4Gain: partSpec?.ping,
                f5Gain: partSpec?.ping,
                tilt: partSpec?.tilt
            };
            
            const voice = createVoice(ctx, freq, voiceStart, duration, partGain, voiceOpts);
            
            if (multiChannel) voice.gain.connect(merger, 0, i);
            else voice.gain.connect(compressor);
            
            voice.osc.start(voiceStart); 
            voice.vibrato.start(voiceStart);
            voice.noise.start(voiceStart, Math.random() * 2);
            voice.osc.stop(voiceStart + duration); 
            voice.vibrato.stop(voiceStart + duration);
            voice.noise.stop(voiceStart + duration);
        }
    });
    if (!multiChannel) compressor.connect(ctx.destination);
}

// currentTime is frozen for the entire time a context is 'suspended' and only resumes ticking
// once it's genuinely 'running' again -- it does not jump forward to account for the suspension.
// Scheduling from currentTime before resume() has actually settled captures a stale baseline, so
// everything scheduled against it is already "in the past" the instant the context wakes up and
// gets silently skipped. ensureRunning() below always waits out the real resume() rather than
// giving up early on a timeout and scheduling anyway -- only times out to report a genuine
// failure. See primeAudioContext() for hiding that latency instead of waiting through it inline.
const PLAYBACK_LEAD_IN = 0.05;
const RESUME_TIMEOUT_MS = 10000;

async function ensureRunning(ctx) {
    if (ctx.state !== 'suspended') return;
    const result = await Promise.race([
        ctx.resume().then(() => 'resumed'),
        new Promise(resolve => setTimeout(() => resolve('timeout'), RESUME_TIMEOUT_MS)),
    ]);
    if (result === 'timeout') {
        throw new Error('Audio did not start in time -- try again, or reload the page if it keeps happening.');
    }
}

// Best-effort, fire-and-forget: creates (and starts resuming) the shared AudioContext on the
// page's first genuine user gesture, well before Play is actually clicked, so any resume()
// latency happens in the background while the user is still looking at the loaded score/
// adjusting settings, instead of being fully in the way the moment they hit Play. Safe to call
// redundantly -- playChord/playScore still properly await readiness themselves regardless of
// whether this warm-up finished, this purely improves perceived latency, changes no behavior.
export function primeAudioContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

export async function playChord(chordState, tuningData, opts) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await ensureRunning(audioCtx);
    setupAudioGraph(audioCtx, chordState, audioCtx.currentTime + PLAYBACK_LEAD_IN, opts.duration, tuningData, opts);
}

export async function saveChordAsWav(chordState, tuningData, opts) {
    const duration = opts.duration, sr = 44100;
    const offlineCtx = new OfflineAudioContext(4, sr * duration, sr);
    setupAudioGraph(offlineCtx, chordState, 0, duration, tuningData, opts, true);
    const buffer = await offlineCtx.startRendering();
    const data = new Float32Array(buffer.length * 4);
    for (let i = 0; i < buffer.length; i++) {
        for (let ch = 0; ch < 4; ch++) data[i * 4 + ch] = buffer.getChannelData(ch)[i];
    }
    const blob = encodeWAV(data, 4, sr);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `chord_custom_vlq.wav`;
    link.click();
}

// createVoice's envelope is a fixed attack(0.15s) + release(0.5s), regardless of note duration --
// fine for the single-chord page (duration is always several seconds), but a real score's short
// notes (an eighth note at a fast tempo can be well under 0.65s) would push the release ramp's
// start time before the attack ramp's end time, an invalid (out-of-order) automation schedule.
// Floors each chord's *ring* duration at a safe minimum above that, while start TIMES still
// advance on the literal beat -- a short chord rings past its nominal slot into the next chord's
// attack, the same overlap a real singer's legato would produce, rather than truncating the
// release or inverting the envelope.
const MIN_CHORD_SECONDS = 0.7;

// Shared by playScore/saveScoreAsWav so live playback and the rendered .wav can never disagree
// about timing. Returns each chord's {start, duration} in seconds from t=0, plus the total
// render length -- which is NOT simply the last chord's end, since an earlier short chord's
// floored ring-out can (rarely) extend past a later chord's own nominal end if several short
// chords cluster together; take the max across every chord's own end, not just the last one.
//
// Mike's own real report: a real in-progress arrangement ("Soft Kitty," only the first few
// measures actually voiced) played for a full 96 seconds at 80 BPM even though the arranged music
// itself is over in a few seconds -- root-caused directly against the real file, not guessed: its
// last "chord" is a single 112-beat entry with all four voices resting (the rest of the piece's
// nominal measure count, never arranged). setupAudioGraph() already skips a resting voice
// outright (no oscillator/node ever gets created for one), so that trailing stretch was always
// silent -- it just kept inflating totalSeconds (and so the exported .wav's length and the Play
// button's own reset timer) to the score's full nominal beat count regardless of how much of it
// is actually real, sounding content. A genuine rest in the *middle* of a real arrangement still
// needs its full real time (subsequent chords must stay correctly placed against it) -- this only
// trims TRAILING dead air after the last chord that has any voice actually sounding.
// Exported for direct unit testing (plan.md §68's follow-up bug) -- pure function, no audio-graph
// side effects, so this doesn't need the live-audio-decode technique the envelope fix above did.
export function buildScoreSchedule(chords, bpm) {
    const secondsPerBeat = 60 / bpm;
    let lastSoundingIdx = -1;
    chords.forEach((chord, i) => {
        if (chord.voices.some(v => !v.rest)) lastSoundingIdx = i;
    });

    let t = 0;
    let maxEnd = 0;
    let tAtLastSounding = 0;
    const scheduled = chords.map((chord, i) => {
        const beatSeconds = chord.beats * secondsPerBeat;
        const duration = Math.max(beatSeconds, MIN_CHORD_SECONDS);
        const entry = { chord, start: t, duration };
        if (i <= lastSoundingIdx) {
            maxEnd = Math.max(maxEnd, t + duration);
            tAtLastSounding = t + beatSeconds;
        }
        t += beatSeconds;
        return entry;
    });
    return { scheduled, totalSeconds: lastSoundingIdx === -1 ? 0 : Math.max(maxEnd, tAtLastSounding) };
}

// mixer: [{volume, mute}, ...] indexed Bass/Bari/Lead/Tenor same as everywhere else in the app --
// a score-playback-only 4-part balance (plan.md §10.5), never persisted to score:current or the
// exported file, distinct from any chord/part's own settings. Each chord's own vowel formants
// (f1/f2/f3) are used as-is -- unlike the single-chord page, a score chord already carries its
// own real vowel, no global override needed.
//
// Building every chord's audio graph in one synchronous loop up front disrupts real-time output:
// at vps=4, a 16-chord score is on the order of 2500 individual WebAudio nodes (16 chords x 4
// parts x 4 voices-per-part x ~10 nodes/voice), and connecting all of them to an already-live
// graph in a single burst audibly glitches audio that's already playing -- below what Web Audio's
// own JS-visible clock (currentTime) can see, so it can't be detected from JS. Staggering each
// chord's node construction across the actual playback timeline (via setTimeout, built shortly
// before it's due) keeps any single moment's new-node count to roughly one chord's worth instead
// of the whole score's.
const CHORD_BUILD_LOOKAHEAD_SECONDS = 0.3;
let pendingChordBuilds = [];

export async function playScore(chords, bpm, mixer, baseOpts) {
    pendingChordBuilds.forEach(id => clearTimeout(id));
    pendingChordBuilds = [];
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await ensureRunning(audioCtx);
    // f4/f5/ping/tilt (plan.md §38) come from baseOpts.partSettings, if the caller supplied it --
    // the real persisted per-part formant defaults, previously not wired into score playback at
    // all. volume/mute always come from the live mixer regardless -- session-only by design, and
    // must win even when baseOpts.partSettings has its own (default) volume for the same part.
    const partSettings = mixer.map((m, i) => ({
        ...(baseOpts.partSettings ? baseOpts.partSettings[i] : null),
        volume: m.volume,
        mute: m.mute,
    }));
    const { scheduled, totalSeconds } = buildScoreSchedule(chords, bpm);
    const startAt = audioCtx.currentTime + PLAYBACK_LEAD_IN;
    scheduled.forEach(({ chord, start, duration }) => {
        const buildAtCtxTime = startAt + start - CHORD_BUILD_LOOKAHEAD_SECONDS;
        const delayMs = Math.max(0, (buildAtCtxTime - audioCtx.currentTime) * 1000);
        const id = setTimeout(() => {
            setupAudioGraph(audioCtx, chord.voices, startAt + start, duration, chord.tuning, {
                ...baseOpts, ...chord.formants, partSettings,
            });
        }, delayMs);
        pendingChordBuilds.push(id);
    });
    return totalSeconds + PLAYBACK_LEAD_IN;
}

// Closing the context stops every currently-scheduled node at once -- WebAudio has no single
// "cancel everything I scheduled" call otherwise. The next playScore() call creates a fresh one.
// Also cancels any not-yet-fired staggered chord-build timers so a chord can't get built (and
// briefly play) after the user has explicitly stopped playback.
export function stopScorePlayback() {
    pendingChordBuilds.forEach(id => clearTimeout(id));
    pendingChordBuilds = [];
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
}

export async function saveScoreAsWav(chords, bpm, mixer, baseOpts) {
    const sr = 44100;
    // Same f4/f5/ping/tilt-from-baseOpts, volume/mute-from-mixer merge as playScore() above.
    const partSettings = mixer.map((m, i) => ({
        ...(baseOpts.partSettings ? baseOpts.partSettings[i] : null),
        volume: m.volume,
        mute: m.mute,
    }));
    const { scheduled, totalSeconds } = buildScoreSchedule(chords, bpm);
    const offlineCtx = new OfflineAudioContext(4, Math.ceil(sr * totalSeconds), sr);
    scheduled.forEach(({ chord, start, duration }) => {
        setupAudioGraph(offlineCtx, chord.voices, start, duration, chord.tuning, {
            ...baseOpts, ...chord.formants, partSettings,
        }, true);
    });
    const buffer = await offlineCtx.startRendering();
    const data = new Float32Array(buffer.length * 4);
    for (let i = 0; i < buffer.length; i++) {
        for (let ch = 0; ch < 4; ch++) data[i * 4 + ch] = buffer.getChannelData(ch)[i];
    }
    const blob = encodeWAV(data, 4, sr);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `score.wav`;
    link.click();
}

/**
 * Standard Radix-2 FFT Implementation
 */
export function fft(real, imag) {
    const n = real.length;
    if (n <= 1) return;
    const evenReal = new Float32Array(n / 2), evenImag = new Float32Array(n / 2);
    const oddReal = new Float32Array(n / 2), oddImag = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        evenReal[i] = real[2 * i]; evenImag[i] = imag[2 * i];
        oddReal[i] = real[2 * i + 1]; oddImag[i] = imag[2 * i + 1];
    }
    fft(evenReal, evenImag); fft(oddReal, oddImag);
    for (let k = 0; k < n / 2; k++) {
        const angle = -2 * Math.PI * k / n;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const tReal = oddReal[k] * cos - oddImag[k] * sin;
        const tImag = oddReal[k] * sin + oddImag[k] * cos;
        real[k] = evenReal[k] + tReal; imag[k] = evenImag[k] + tImag;
        real[k + n / 2] = evenReal[k] - tReal; imag[k + n / 2] = evenImag[k] - tImag;
    }
}

export function getMagnitudes(signal, sr) {
    const n = signal.length;
    const real = new Float32Array(signal), imag = new Float32Array(n);
    fft(real, imag);
    const mag = new Float32Array(n / 2);
    const freqs = new Float32Array(n / 2).map((_, i) => i * sr / n);
    for (let i = 0; i < n / 2; i++) {
        const m = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / n;
        mag[i] = 20 * Math.log10(m + 1e-9);
    }
    return { freqs, mag };
}

const VOICE_NAMES = ['Bass', 'Bari', 'Lead', 'Tenor'];

// The same fundamental-frequency formula setupAudioGraph() uses per voice-copy (line ~125), minus
// the unknowable ±1-cent microtuning jitter -- that's randomized per rendered voice-copy and small
// enough (~±0.06%) that findPeaksNearCandidates()'s own search window absorbs it. This is the one
// place both the harmonic-candidate search and the chart's axis bounds get "what pitch is this
// voice actually at" from, so the two can never disagree with each other.
//
// A muted voice is skipped exactly like a resting one, not just a quiet one. setupAudioGraph()
// zeroes a muted voice's partGain outright (line ~119), so its rendered channel is pure silence --
// searching it anyway would report whatever floating-point noise a windowed near-zero signal FFTs
// to as a "peak" (found live: a muted voice still showed one spurious peak, purely numerical, not
// real content). partSettings is optional so every existing caller/test that omits it is unaffected.
//
// tuningData is optional too, for a different reason: omitting it (rather than passing an array of
// zeros) gives the *nominal* 12TET frequency for each note, real tuning cents left out entirely --
// used for the chart's x-axis specifically, so retuning a voice to compare the effect doesn't also
// shift the axis the retuning is being compared against.
export function computeFundamentals(chordState, tuningData, partSettings) {
    const out = [];
    chordState.forEach((note, i) => {
        if (note.rest) return;
        if (partSettings && partSettings[i] && partSettings[i].mute) return;
        const baseCents = (tuningData && tuningData[i] !== undefined) ? tuningData[i] : 0;
        const freq = 440 * Math.pow(2, (getAbsSemitone(note) - 57 + baseCents / 100) / 12);
        out.push({ index: i, name: VOICE_NAMES[i], freq });
    });
    return out;
}

// Integer harmonics of f0 up to maxFreq -- bounded by the chart's own a priori display ceiling
// (see analyzeAndShow below), not by Nyquist, since there's no point searching for (or storing)
// harmonics that will never be drawn.
export function harmonicCandidates(f0, maxFreq) {
    const out = [];
    for (let n = 1; f0 * n <= maxFreq; n++) out.push(f0 * n);
    return out;
}

// How far (in dB) the signal has to fall off before two nearby a priori candidates count as
// separate peaks rather than one blended bump. Also doubles as the width of the window used to
// report each peak's own centroid -- a peak's region extends outward from its local max until the
// signal has fallen off by this same margin. Half of the existing 10dB local-SNR test the old
// findPeaks() used; a reasonable starting point, easy to retune once live against a real chord.
const PEAK_FALLOFF_DB = 6;

// How far below THIS SPECTRUM's own loudest bin a candidate's local max must clear to count as
// real energy, not noise floor. Deliberately relative, not an absolute dB number -- these are FFT-
// magnitude-in-dB values with no calibrated SPL reference, and a fixed absolute floor (the old
// findPeaks()'s -70dB) turned out live to hide real, visibly-structured harmonics: a barbershop
// chord's fundamental already sits close to that floor by itself, so an absolute cutoff left only
// the fundamental of each voice surviving even though the chart's own line clearly shows several
// more genuine harmonic bumps above the signal's actual noise floor before it trails into clutter.
const NOISE_FLOOR_RANGE_DB = 70;

// Replaces the old blind local-maximum findPeaks(): rather than scanning the whole spectrum for
// whatever bins happen to poke up, this searches only near the frequencies we already expect energy
// at (harmonics of one or more known voice fundamentals), then reports what's actually there.
//
// candidates: { freq, meta }[] -- meta carries provenance (a harmonic number for a single-voice
// call, { voice, harmonic } for the pooled summed-signal call) and is just carried through into the
// returned peak's own `meta` array, unexamined by this function.
//
// Algorithm: (1) refine each candidate to the true local-max bin within a small window around its
// expected bin, dropping any that never clear the noise floor (opts.floorDb, or NOISE_FLOOR_RANGE_DB
// below this spectrum's own loudest bin by default); (2) walk the refined, frequency-sorted
// maxima and merge adjacent ones whenever the valley between them doesn't dip at least
// PEAK_FALLOFF_DB below the lower of the two -- this is the one threshold the feature needs, doing
// double duty as the merge/split test; (3) for each resulting group, extend a window outward from
// its strongest bin until the signal falls off by PEAK_FALLOFF_DB on each side (or hits the array
// edge / a neighboring group), and report the linear-power-weighted centroid frequency over that
// window -- "center of energy," not just the nearest bin -- alongside the group's own observed peak
// height and the pooled meta of every candidate that fed into it.
export function findPeaksNearCandidates(mag, freqs, candidates, opts = {}) {
    const fallDb = opts.fallDb ?? PEAK_FALLOFF_DB;
    const floorDb = opts.floorDb ?? (Math.max(...mag) - NOISE_FLOOR_RANGE_DB);
    const binHz = freqs.length > 1 ? (freqs[1] - freqs[0]) : 1;
    const n = mag.length;

    const clampBin = (b) => Math.max(0, Math.min(n - 1, b));
    const refineLocalMax = (centerBin, halfWindowBins) => {
        let best = clampBin(centerBin);
        for (let b = clampBin(centerBin - halfWindowBins); b <= clampBin(centerBin + halfWindowBins); b++) {
            if (mag[b] > mag[best]) best = b;
        }
        return best;
    };

    // Refine each candidate to its true local-max bin. Search window is a few bins wide (absorbs
    // FFT resolution + microtuning slop) but never wider than half the gap to the neighboring
    // candidate, so two genuinely close-but-real harmonics don't get refined onto the same bin.
    const sorted = candidates.slice().sort((a, b) => a.freq - b.freq);
    const refined = sorted.map((c, i) => {
        const expectedBin = c.freq / binHz;
        const prevFreq = i > 0 ? sorted[i - 1].freq : 0;
        const nextFreq = i < sorted.length - 1 ? sorted[i + 1].freq : freqs[n - 1];
        const gapBins = Math.min(expectedBin - prevFreq / binHz, nextFreq / binHz - expectedBin);
        const halfWindow = Math.max(1, Math.min(6, Math.floor(gapBins / 2)));
        const bin = refineLocalMax(Math.round(expectedBin), halfWindow);
        return { meta: c.meta, bin, db: mag[bin] };
    }).filter(r => r.db >= floorDb);

    if (refined.length === 0) return [];

    // Group adjacent refined maxima whenever the valley between them doesn't fall off enough to
    // count as a genuinely separate peak.
    const groups = [[refined[0]]];
    for (let i = 1; i < refined.length; i++) {
        const prev = refined[i - 1], cur = refined[i];
        let valley = Infinity;
        for (let b = prev.bin; b <= cur.bin; b++) valley = Math.min(valley, mag[b]);
        const dip = Math.min(prev.db, cur.db) - valley;
        if (dip < fallDb) groups[groups.length - 1].push(cur);
        else groups.push([cur]);
    }

    return groups.map(group => {
        const peakBin = group.reduce((best, r) => (r.db > best.db ? r : best), group[0]).bin;
        const peakDb = mag[peakBin];
        // Extend the reported window outward from the group's own peak bin until the signal falls
        // off by fallDb on each side (or hits an array edge).
        let lo = peakBin, hi = peakBin;
        while (lo > 0 && peakDb - mag[lo - 1] < fallDb) lo--;
        while (hi < n - 1 && peakDb - mag[hi + 1] < fallDb) hi++;
        let sumFP = 0, sumP = 0;
        for (let b = lo; b <= hi; b++) {
            const p = Math.pow(10, mag[b] / 10);
            sumFP += freqs[b] * p;
            sumP += p;
        }
        const centroidFreq = sumP > 0 ? sumFP / sumP : freqs[peakBin];
        return {
            freq: Math.round(centroidFreq * 10) / 10,
            db: Math.round(peakDb),
            ...getNoteInfo(centroidFreq),
            meta: group.map(r => r.meta),
        };
    }).sort((a, b) => a.freq - b.freq);
}

// The x-axis window: a fixed 2 semitones below the lowest fundamental to 3.5 octaves above the
// highest, no longer a "floor to the nearest C"/"at least C8" pair of special cases -- a direct,
// predictable margin either side of the chord's own real range.
const AXIS_MIN_SEMITONES_BELOW = 2;
const AXIS_MAX_OCTAVES_ABOVE = 3.5;

// Deliberately takes a fundamentals list rather than computing one itself: the caller decides
// whether muted voices count (see analyzeAndShow's own two-fundamentals-lists comment below) --
// this function only knows how to turn "the real range" into "the display window" around it.
export function computeAxisBounds(axisFundamentals) {
    const lowestFreq = Math.min(...axisFundamentals.map(f => f.freq));
    const highestFreq = Math.max(...axisFundamentals.map(f => f.freq));
    return {
        xAxisMin: lowestFreq * Math.pow(2, -AXIS_MIN_SEMITONES_BELOW / 12),
        xAxisMax: highestFreq * Math.pow(2, AXIS_MAX_OCTAVES_ABOVE)
    };
}

export async function analyzeAndShow(chordState, tuningData, opts) {
    const renderDuration = opts.duration;
    const sr = 44100, N = 16384;
    const offlineCtx = new OfflineAudioContext(4, sr * renderDuration, sr);
    setupAudioGraph(offlineCtx, chordState, 0, renderDuration, tuningData, opts, true);
    const buffer = await offlineCtx.startRendering();

    // Two different fundamental sets, deliberately: `fundamentals` (mute-aware, real tuning cents
    // included, feeds the actual peak search below -- there's no point searching a channel that's
    // genuinely silent, and the search needs to know a voice's real detuned frequency to find real
    // peaks near it) vs. `axisFundamentals` (mute-*blind*, and nominal 12TET -- tuning cents
    // omitted entirely) for the x-axis window alone. Both omissions exist for the same reason:
    // muting a voice, or retuning it, should be comparable against a *stable* axis, not one that
    // shifts along with the very thing being compared. computeFundamentals()'s `tuningData` and
    // `partSettings` params are both optional specifically so this second call can skip either
    // without needing parallel "ignoreCents"/"ignoreMute" flags.
    const fundamentals = computeFundamentals(chordState, tuningData, opts.partSettings);
    const axisFundamentals = computeFundamentals(chordState);
    const { xAxisMin, xAxisMax } = computeAxisBounds(axisFundamentals);

    const analysis = { freqs: [], parts: [], fundamentals, xAxisMin, xAxisMax };
    const hann = new Float32Array(N).map((_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1))));
    const summedData = new Float32Array(N);

    // Calculate a safe sample offset (center of the clip, avoiding attack/release)
    const sliceStart = Math.max(0, Math.floor((renderDuration / 2) * sr) - (N / 2));

    for (let ch = 0; ch < 4; ch++) {
        const samples = buffer.getChannelData(ch).slice(sliceStart, sliceStart + N);
        const windowed = samples.map((s, i) => s * hann[i]);
        const { freqs, mag } = getMagnitudes(windowed, sr);
        if (ch === 0) analysis.freqs = Array.from(freqs);
        const fund = fundamentals.find(f => f.index === ch);
        const candidates = fund
            ? harmonicCandidates(fund.freq, xAxisMax).map((freq, i) => ({ freq, meta: { voice: fund.name, harmonic: i + 1 } }))
            : [];
        const peaks = findPeaksNearCandidates(mag, freqs, candidates);
        analysis.parts.push({ name: VOICE_NAMES[ch], magnitudes: Array.from(mag), peaks });
        samples.forEach((s, i) => summedData[i] += s / 4);
    }

    const summedMag = getMagnitudes(summedData.map((s, i) => s * hann[i]), sr).mag;
    const allCandidates = [];
    fundamentals.forEach(f => {
        harmonicCandidates(f.freq, xAxisMax).forEach((freq, i) => allCandidates.push({ freq, meta: { voice: f.name, harmonic: i + 1 } }));
    });
    const summedPeaks = findPeaksNearCandidates(summedMag, analysis.freqs, allCandidates);
    analysis.parts.push({ name: 'Summed', magnitudes: Array.from(summedMag), peaks: summedPeaks });

    localStorage.setItem('chordAnalysisData', JSON.stringify(analysis));
    window.open('analysis/', '_blank');
}

export function getNoteInfo(f) {
    const semis = 12 * Math.log2(f / 440) + 57;
    const noteNames = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
    const rounded = Math.round(semis);
    const note = noteNames[((rounded % 12) + 12) % 12] + Math.floor(rounded / 12);
    const cents = Math.round((semis - rounded) * 100);
    return { note, cents };
}

function encodeWAV(samples, numChannels, sr) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true); view.setUint32(24, sr, true);
    view.setUint32(28, sr * numChannels * 2, true); view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true); writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}