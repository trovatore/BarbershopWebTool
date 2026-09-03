/* settings.js — the standalone global-settings page (plan.md §38). No chord/document model at
   all, unlike main.js/score.js -- just a thin, direct binding between this page's own controls and
   the persisted settings:current document, via settings-store.js's read/write/extract/apply
   helpers (the same ones state.js and score.js also use, so all three pages agree on shape). */
import { AUDIO_DEFAULTS, PART_SETTINGS_DEFAULTS } from './state.js';
import { readSettingsDocument, writeSettingsDocument, applyPersistedSettings, extractPersistedSettings } from './settings-store.js';

export const SERIAL = "#001";

const AUDIO_KEYS = [
    ['vibratoJitterCutoff', 'vibratoJitterCutoff'],
    ['vibratoJitterAmount', 'vibratoJitterAmount'],
    ['phaseJitter', 'phaseJitter'],
    ['vibratoDepth', 'vibratoDepth'],
    ['vibratoRateMean', 'vibratoRateMean'],
    ['vibratoRateRange', 'vibratoRateRange'],
    ['formantQ1', 'q1'],
    ['formantQ2', 'q2'],
];
const PART_KEYS = ['ping', 'tilt', 'f4', 'f5', 'vol'];
const PART_KEY_TO_FIELD = { vol: 'volume' };

function defaultSettings() {
    return {
        vps: AUDIO_DEFAULTS.vps,
        duration: 5,
        volume: AUDIO_DEFAULTS.volume,
        presetVersion: 'ear',
        rootless: false,
        offlineMode: false,
        audio: { ...AUDIO_DEFAULTS.audio },
        partSettings: PART_SETTINGS_DEFAULTS.map(p => ({ ...p })),
    };
}

let settings = defaultSettings();
applyPersistedSettings(settings, readSettingsDocument());

function persist() {
    writeSettingsDocument(extractPersistedSettings(settings));
}

function setStatus(msg) {
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
}

function syncToInputs() {
    document.getElementById('rootlessToggle').checked = settings.rootless;
    document.getElementById('offlineToggle').checked = settings.offlineMode;
    document.getElementById('legacyVocalToggle').checked = (settings.presetVersion === 'legacy');
    document.getElementById('vpsCount').value = settings.vps;
    document.getElementById('duration').value = settings.duration;
    document.getElementById('volume').value = settings.volume;

    AUDIO_KEYS.forEach(([id, key]) => {
        const el = document.getElementById(id);
        const nel = document.getElementById('n_' + id);
        const val = settings.audio[key];
        if (el) el.value = val;
        if (nel) nel.value = val;
    });

    settings.partSettings.forEach((part, i) => {
        PART_KEYS.forEach(k => {
            const field = PART_KEY_TO_FIELD[k] || k;
            const el = document.getElementById(`part-${k}-${i}`);
            const val = part[field];
            if (el) el.value = val;
            const disp = document.getElementById(`v_part-${k}-${i}`);
            if (disp) {
                if (k === 'ping' || k === 'tilt') disp.innerText = val.toFixed(2);
                else if (k === 'f4' || k === 'f5') disp.innerText = Math.round(val) + 'Hz';
                else disp.innerText = val.toFixed(2);
            }
        });
    });
}

function bindChange(id, apply) {
    const el = document.getElementById(id);
    if (!el) return;
    const handler = () => {
        apply(el);
        persist();
        syncToInputs();
        setStatus('Saved.');
    };
    el.onchange = handler;
    el.oninput = handler;
}

function init() {
    syncToInputs();

    bindChange('rootlessToggle', el => settings.rootless = el.checked);
    bindChange('offlineToggle', el => settings.offlineMode = el.checked);
    bindChange('legacyVocalToggle', el => settings.presetVersion = el.checked ? 'legacy' : 'ear');
    bindChange('vpsCount', el => settings.vps = parseInt(el.value) || AUDIO_DEFAULTS.vps);
    bindChange('duration', el => settings.duration = parseFloat(el.value) || 5);
    bindChange('volume', el => settings.volume = parseFloat(el.value) || AUDIO_DEFAULTS.volume);

    AUDIO_KEYS.forEach(([id, key]) => {
        bindChange(id, el => settings.audio[key] = parseFloat(el.value) || 0);
        bindChange('n_' + id, el => settings.audio[key] = parseFloat(el.value) || 0);
    });

    settings.partSettings.forEach((part, i) => {
        PART_KEYS.forEach(k => {
            const field = PART_KEY_TO_FIELD[k] || k;
            bindChange(`part-${k}-${i}`, el => part[field] = parseFloat(el.value) || 0);
        });
    });

    document.getElementById('resetBtn').onclick = () => {
        if (!window.confirm('Reset all global settings to their defaults? This cannot be undone.')) return;
        settings = defaultSettings();
        persist();
        syncToInputs();
        setStatus('Settings reset to defaults.');
    };
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
