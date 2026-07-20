/* document-store.js — generic persisted-document + dirty-tracking + undo/redo (plan.md §10.7).
   Generalizes the pattern score-store.js established for the Score document so the same shape
   works for the new standalone Chord-page document too. One `createDocumentStore()` instance per
   document type (Score, standalone Chord) — each page's own module owns its instance, per
   §10.7.6's "instantiated separately by each page" call. Not yet wired into score.js/state.js;
   this is the store, not the UI. */

export function createDocumentStore(storageKey, { undoLimit = 50 } = {}) {
    let undoStack = [];
    let redoStack = [];

    function read() {
        try {
            const raw = localStorage.getItem(storageKey);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            console.error(`Failed to read document ${storageKey}`, e);
            return null;
        }
    }

    function write(doc) {
        localStorage.setItem(storageKey, JSON.stringify(doc));
    }

    // The two moments that define "saved" per plan.md §10.7.2 -- everything else (every field
    // edit) writes through to localStorage same as always, but doesn't move this baseline.
    function snapshot(content, label) {
        return {
            content,
            sourceLabel: label,
            sourceSnapshot: JSON.stringify(content),
            updatedAt: Date.now(),
        };
    }

    // A new document (file chosen, permalink opened): resets undo/redo, since old snapshots may
    // not even share the previous document's shape (different chord count/ids) and undoing into
    // them would be meaningless at best, corrupting at worst.
    function markImported(content, label) {
        undoStack = [];
        redoStack = [];
        return snapshot(content, label);
    }

    // Same document, just recording that its current content now also matches the file on disk
    // (download / copy-link). Edit history is still valid -- undo should still reach past this
    // point -- so the stacks are left alone.
    function markExported(doc, label) {
        return Object.assign({}, doc, {
            sourceSnapshot: JSON.stringify(doc.content),
            sourceLabel: label !== undefined ? label : doc.sourceLabel,
            updatedAt: Date.now(),
        });
    }

    // No sourceSnapshot yet (never imported/exported) counts as dirty -- an unsaved-since-
    // creation document should read as unsaved, same as any editor's "Untitled" buffer.
    function isDirty(doc) {
        return !!doc && (!doc.sourceSnapshot || JSON.stringify(doc.content) !== doc.sourceSnapshot);
    }

    // Call with the pre-mutation content immediately before applying an edit.
    function pushUndo(content) {
        undoStack.push(JSON.stringify(content));
        if (undoStack.length > undoLimit) undoStack.shift();
        redoStack = [];
    }

    function canUndo() { return undoStack.length > 0; }
    function canRedo() { return redoStack.length > 0; }

    // Returns the restored content, or null if there's nothing to undo. Caller is responsible
    // for writing the restored content back into its own document/UI state.
    function undo(currentContent) {
        if (!undoStack.length) return null;
        redoStack.push(JSON.stringify(currentContent));
        return JSON.parse(undoStack.pop());
    }

    function redo(currentContent) {
        if (!redoStack.length) return null;
        undoStack.push(JSON.stringify(currentContent));
        return JSON.parse(redoStack.pop());
    }

    return { read, write, markImported, markExported, isDirty, pushUndo, undo, redo, canUndo, canRedo };
}
