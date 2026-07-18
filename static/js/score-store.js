/* score-store.js — the shared "score:current" document (plan.md §6.2). One fixed localStorage
   key holds the canonical, live copy of the whole imported chord list; both /score and (once
   §10.2's editor-tab wiring exists) the Chord page read/write it, kept in sync via the browser's
   native `storage` event. Deliberately not a live channel (window.opener/BroadcastChannel) — see
   §6.1 for why, chiefly Android-portability. */

export const SCORE_STORAGE_KEY = 'score:current';

export function readScoreDocument() {
    try {
        const raw = localStorage.getItem(SCORE_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.error('Failed to read score document', e);
        return null;
    }
}

export function writeScoreDocument(doc) {
    localStorage.setItem(SCORE_STORAGE_KEY, JSON.stringify(doc));
}

export function newChordId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}
