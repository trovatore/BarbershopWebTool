/* chord-store.js — the standalone Chord page's own persisted document, "chord:current" (plan.md
   §10.7.1). Mirrors score-store.js's shape exactly, one fixed localStorage key holding the single
   chord being edited when this tab isn't live-editing a Score chord via ?sid=. Lets a bare visit
   survive a refresh instead of always resetting to state.js's hardcoded default. */

export const CHORD_STORAGE_KEY = 'chord:current';

export function readChordDocument() {
    try {
        const raw = localStorage.getItem(CHORD_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.error('Failed to read chord document', e);
        return null;
    }
}

export function writeChordDocument(doc) {
    localStorage.setItem(CHORD_STORAGE_KEY, JSON.stringify(doc));
}
