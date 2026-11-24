/*
 * tracker-core.js — the counting logic, with no network code.
 * Works in the browser (window.TrackerCore) and in Node (require) for tests.
 *
 * Rules (agreed with the original user):
 *  - Only the main text of a doc counts: headers, footers and footnotes are ignored.
 *  - A "word" is any run of non-space characters containing a letter or digit,
 *    so standalone punctuation like — or … is not counted.
 *  - Docs that weren't edited during the session are not reported.
 */
(function (root) {
  'use strict';

  const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

  /** Split text into countable words. */
  function countableWords(text) {
    return (String(text || '').replace(/﻿/g, '').match(/\S+/g) || [])
      .filter(w => HAS_LETTER_OR_DIGIT.test(w));
  }

  /**
   * Main text of a Google Doc, from a Docs API `documents.get` response.
   * Headers, footers, footnotes and the generated table of contents are skipped.
   * Supports docs with tabs (request with includeTabsContent=true).
   */
  function mainTextOfDocument(doc) {
    if (doc && Array.isArray(doc.tabs)) {
      const parts = [];
      (function visit(tabs) {
        tabs.forEach(tab => {
          if (tab.documentTab) parts.push(textOfBody(tab.documentTab.body));
          if (tab.childTabs) visit(tab.childTabs);
        });
      })(doc.tabs);
      return parts.join('\n');
    }
    return textOfBody(doc && doc.body);
  }

  function textOfBody(body) {
    const out = [];
    (function walk(content) {
      (content || []).forEach(el => {
        if (el.paragraph) {
          (el.paragraph.elements || []).forEach(pe => {
            if (pe.textRun && pe.textRun.content) out.push(pe.textRun.content);
          });
        } else if (el.table) {
          (el.table.tableRows || []).forEach(row =>
            (row.tableCells || []).forEach(cell => walk(cell.content)));
        }
        // tableOfContents and sectionBreak are intentionally skipped
      });
    })(body && body.content);
    return out.join('');
  }

  /**
   * Words added and removed between two versions of a text.
   * Uses the longest common sequence of words, so moving past unchanged text is free
   * and a reworded phrase counts as the old words removed plus the new words added.
   */
  function compareTexts(before, after) {
    const A = countableWords(before), B = countableWords(after);
    let s = 0;
    while (s < A.length && s < B.length && A[s] === B[s]) s++;
    let ea = A.length, eb = B.length;
    while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
    const x = A.slice(s, ea), y = B.slice(s, eb);

    let common = 0;
    if (x.length && y.length) {
      common = x.length * y.length <= 25e6 ? lcsLength(x, y) : sharedWordCount(x, y);
    }
    return { added: y.length - common, removed: x.length - common, total: B.length };
  }

  function lcsLength(x, y) {
    const ids = new Map();
    const id = w => { let v = ids.get(w); if (v === undefined) { v = ids.size; ids.set(w, v); } return v; };
    const X = Int32Array.from(x, id), Y = Int32Array.from(y, id);
    let prev = new Uint32Array(Y.length + 1), cur = new Uint32Array(Y.length + 1);
    for (let i = 1; i <= X.length; i++) {
      const xi = X[i - 1];
      for (let j = 1; j <= Y.length; j++) {
        cur[j] = xi === Y[j - 1] ? prev[j - 1] + 1 : (prev[j] > cur[j - 1] ? prev[j] : cur[j - 1]);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[Y.length];
  }

  /** Fallback for very large rewrites: words in common regardless of order. */
  function sharedWordCount(x, y) {
    const counts = new Map();
    x.forEach(w => counts.set(w, (counts.get(w) || 0) + 1));
    let shared = 0;
    y.forEach(w => { const c = counts.get(w); if (c) { shared++; counts.set(w, c - 1); } });
    return shared;
  }

  /**
   * Build the session result — the ONLY thing sent to Quilltrack.
   * @param snapshot  { sessionId, startedAt, docs: { [id]: { name, modifiedTime, text } } }
   * @param endDocs   { [id]: { name, modifiedTime, text } } — only docs edited since Start need `text`
   * @param endedAt   ISO time the session ended
   * @param closedBy  'user' | 'inactivity'
   */
  function buildSessionResult(snapshot, endDocs, endedAt, closedBy) {
    const docs = [];
    Object.keys(endDocs).forEach(id => {
      const now = endDocs[id];
      const before = snapshot.docs[id];
      if (before && !wasEditedSince(now, before)) return;   // untouched doc: nothing to log
      if (typeof now.text !== 'string') return;
      const d = compareTexts(before ? before.text : '', now.text);
      if (d.added === 0 && d.removed === 0) return;          // e.g. only formatting or header changed
      docs.push({ name: now.name, added: d.added, removed: d.removed, total: d.total });
    });

    const added = docs.reduce((n, d) => n + d.added, 0);
    const removed = docs.reduce((n, d) => n + d.removed, 0);
    const minutes = Math.max(1, Math.round((new Date(endedAt) - new Date(snapshot.startedAt)) / 60000));
    return {
      sessionId: snapshot.sessionId,
      startedAt: snapshot.startedAt,
      endedAt: new Date(endedAt).toISOString(),
      minutes,
      wordsAdded: added,
      wordsRemoved: removed,
      netChange: added - removed,
      closedBy,
      docs
    };
  }

  function wasEditedSince(now, before) {
    return new Date(now.modifiedTime) > new Date(before.modifiedTime);
  }

  /**
   * Auto-close: the time of the most recent edit made during the session
   * (or the start time if nothing was edited yet).
   */
  function lastEditTime(snapshot, currentMeta) {
    let last = new Date(snapshot.startedAt).getTime();
    Object.keys(currentMeta).forEach(id => {
      const before = snapshot.docs[id];
      const t = new Date(currentMeta[id].modifiedTime).getTime();
      const editedNow = !before || t > new Date(before.modifiedTime).getTime();
      if (editedNow && t > last) last = t;
    });
    return new Date(last);
  }

  /** True when the user has been inactive for at least `inactivityMinutes` (0 = auto-close off). */
  function shouldAutoClose(lastEdit, now, inactivityMinutes) {
    return inactivityMinutes > 0 && (new Date(now) - new Date(lastEdit)) >= inactivityMinutes * 60000;
  }

  const api = { countableWords, mainTextOfDocument, compareTexts, buildSessionResult, lastEditTime, shouldAutoClose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrackerCore = api;
})(typeof window !== 'undefined' ? window : this);
