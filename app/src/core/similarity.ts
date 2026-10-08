// String similarity used by the heuristic matcher.

import { damerauLevenshtein } from './reference.js';

export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) {
        am[i] = bm[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  return (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
}

export function jaroWinkler(a: string, b: string, p = 0.1): number {
  const j = jaro(a, b);
  let l = 0;
  while (l < 4 && l < a.length && l < b.length && a[l] === b[l]) l++;
  return j + l * p * (1 - j);
}

/**
 * Token-set name similarity: for each observed (bank-side) token, the best
 * match among the expected (customer) tokens; mean over observed tokens.
 * Truncation-aware: an observed token that is a prefix (>= 3 chars) of an
 * expected token scores 0.95; a single initial matching a first letter 0.8.
 */
export function nameSimilarity(observed: string[], expected: string[]): number {
  if (!observed.length || !expected.length) return 0;
  let total = 0;
  for (const o of observed) {
    let best = 0;
    for (const e of expected) {
      let s = jaroWinkler(o, e);
      if (o.length >= 3 && e.startsWith(o) && o !== e) s = Math.max(s, 0.95);
      if (o.length === 1 && e[0] === o) s = Math.max(s, 0.8);
      best = Math.max(best, s);
    }
    total += best;
  }
  return total / observed.length;
}

/** 1 - DL / max length, floored at 0. */
export function dlSimilarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  return Math.max(0, 1 - damerauLevenshtein(a, b) / Math.max(a.length, b.length));
}

export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
