import { MAX_MESSAGE_CHARS } from './model.js';

// Invisible characters that let a message hide text or reorder it visually (spoofing):
// zero-width space, word joiner, BOM, and the bidi embedding/override/isolate controls.
// ZWJ/ZWNJ are kept because emoji sequences and several scripts need them.
const INVISIBLE = /[\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;

/**
 * Normalises message text. The result is PLAIN TEXT: it is deliberately not HTML-escaped here, because escaping is the job
 * of the output layer (React renders it as text; nothing renders message bodies as HTML). Escaping on write would
 * double-escape and would still be the wrong defence.
 */
export function sanitizeMessageBody(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const withinLimit = (s: string): boolean => Array.from(s).length <= MAX_MESSAGE_CHARS;
