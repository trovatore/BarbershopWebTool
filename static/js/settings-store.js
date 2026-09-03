/* settings-store.js — the persisted global-settings document, "settings:current" (plan.md §38).
   Mirrors chord-store.js/score-store.js's plain localStorage-read/write shape rather than
   document-store.js's undo/dirty machinery: v1 has no explicit save/load, so there's no "file"
   baseline for dirty-tracking to mean anything against -- every field just writes straight
   through, the same discipline chord:current/score:current already use for every other edit.

   Deliberately excludes intonation/tuningPin (Mike's own framing, 2026-08-30: these are "hear the
   difference right now" toggles, not longer-lived choices -- see plan.md §38's scoping) and every
   partSettings[i].mute (session-only "hear various combinations of voices" exploration, not a
   default worth remembering). Everything else in appState.settings is a real, persisted default. */

export const SETTINGS_STORAGE_KEY = 'settings:current';

// Per-part fields that get persisted -- deliberately omits 'mute' and the part's own 'name'
// (name is fixed by array position, not user data).
const PART_FIELDS = ['f4', 'f5', 'ping', 'tilt', 'volume'];

export function readSettingsDocument() {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.error('Failed to read settings document', e);
        return null;
    }
}

export function writeSettingsDocument(doc) {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(doc));
}

/* Builds the persisted document from a live appState.settings-shaped object -- pure, no
   localStorage access, so callers control exactly when a write happens. */
export function extractPersistedSettings(settings) {
    return {
        vps: settings.vps,
        duration: settings.duration,
        volume: settings.volume,
        presetVersion: settings.presetVersion,
        rootless: settings.rootless,
        offlineMode: settings.offlineMode,
        audio: { ...settings.audio },
        partSettings: settings.partSettings.map(part => {
            const out = {};
            PART_FIELDS.forEach(f => out[f] = part[f]);
            return out;
        }),
    };
}

/* Merges a persisted document onto a live appState.settings-shaped object, in place. Tolerant of
   a missing/partial/legacy document (an absent key just leaves the current default untouched) --
   there's no schema version to check, just per-field presence, same defensive style
   score.js's resumeDocument() already uses for a pre-§26 document with no keyChanges at all. */
export function applyPersistedSettings(settings, doc) {
    if (!doc) return;
    ['vps', 'duration', 'volume', 'presetVersion', 'rootless', 'offlineMode'].forEach(key => {
        if (doc[key] !== undefined) settings[key] = doc[key];
    });
    if (doc.audio) Object.assign(settings.audio, doc.audio);
    if (doc.partSettings) {
        doc.partSettings.forEach((part, i) => {
            if (!settings.partSettings[i]) return;
            PART_FIELDS.forEach(f => {
                if (part[f] !== undefined) settings.partSettings[i][f] = part[f];
            });
        });
    }
}
