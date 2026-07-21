/* audio.js Serial: #020 */
import { getAbsSemitone } from './spelling.js';

export const SERIAL = "#020";

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

function createVoice(ctx, freq, startTime, duration, targetGain, opts) {
    const attack = 0.15, release = 0.5;
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
function buildScoreSchedule(chords, bpm) {
    const secondsPerBeat = 60 / bpm;
    let t = 0;
    let maxEnd = 0;
    const scheduled = chords.map(chord => {
        const beatSeconds = chord.beats * secondsPerBeat;
        const duration = Math.max(beatSeconds, MIN_CHORD_SECONDS);
        const entry = { chord, start: t, duration };
        maxEnd = Math.max(maxEnd, t + duration);
        t += beatSeconds;
        return entry;
    });
    return { scheduled, totalSeconds: Math.max(maxEnd, t) };
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
    const partSettings = mixer.map(m => ({ volume: m.volume, mute: m.mute }));
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
    const partSettings = mixer.map(m => ({ volume: m.volume, mute: m.mute }));
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

export async function analyzeAndShow(chordState, tuningData, opts) {
    const renderDuration = opts.duration;
    const sr = 44100, N = 16384; 
    const offlineCtx = new OfflineAudioContext(4, sr * renderDuration, sr);
    setupAudioGraph(offlineCtx, chordState, 0, renderDuration, tuningData, opts, true);
    const buffer = await offlineCtx.startRendering();
    
    const analysis = { freqs: [], parts: [] };
    const hann = new Float32Array(N).map((_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1))));
    const names = ['Bass', 'Bari', 'Lead', 'Tenor'];
    const summedData = new Float32Array(N);

    // Calculate a safe sample offset (center of the clip, avoiding attack/release)
    const sliceStart = Math.max(0, Math.floor((renderDuration / 2) * sr) - (N / 2));

    for (let ch = 0; ch < 4; ch++) {
        const samples = buffer.getChannelData(ch).slice(sliceStart, sliceStart + N);
        const windowed = samples.map((s, i) => s * hann[i]);
        const { freqs, mag } = getMagnitudes(windowed, sr);
        if (ch === 0) analysis.freqs = Array.from(freqs);
        analysis.parts.push({ name: names[ch], magnitudes: Array.from(mag), peaks: findPeaks(mag, freqs) });
        samples.forEach((s, i) => summedData[i] += s / 4);
    }

    const summedMag = getMagnitudes(summedData.map((s, i) => s * hann[i]), sr).mag;
    analysis.parts.push({ name: 'Summed', magnitudes: Array.from(summedMag), peaks: findPeaks(summedMag, analysis.freqs) });

    localStorage.setItem('chordAnalysisData', JSON.stringify(analysis));
    window.open('analysis/', '_blank');
}

export function findPeaks(mag, freqs) {
    const peaks = [];
    const minSNR = 10;
    for (let i = 2; i < mag.length - 2; i++) {
        if (mag[i] > mag[i-1] && mag[i] > mag[i+1] && mag[i] > -70) {
            const localMean = (mag[i-2] + mag[i-1] + mag[i+1] + mag[i+2]) / 4;
            if (mag[i] - localMean > minSNR) {
                const alpha = mag[i-1], beta = mag[i], gamma = mag[i+1];
                const p = 0.5 * (alpha - gamma) / (alpha - 2*beta + gamma);
                const preciseFreq = freqs[i] + p * (freqs[1] - freqs[0]);
                peaks.push({ freq: Math.round(preciseFreq * 10) / 10, db: Math.round(beta), ...getNoteInfo(preciseFreq) });
            }
        }
    }
    return peaks.sort((a, b) => b.db - a.db).slice(0, 10);
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