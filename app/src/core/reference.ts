// The anchor's bank reference token: `AR-` + 8 Crockford base32 characters +
// `-` + 1 check character. The body is the first 40 bits of
// sha256(platform transaction id); the check character is Luhn mod 32 over the
// Crockford alphabet, which detects every single-character substitution and
// most adjacent transpositions while staying inside the bank-safe alphabet
// (Crockford's own mod-37 check adds *~$=U, which bank narratives strip).

import { sha256 } from './hash.js';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford decoding aliases: O -> 0, I/L -> 1. */
export function crockfordNormalise(s: string): string {
  return s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}

export function luhn32(body: string): string {
  const n = 32;
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const cp = CROCKFORD.indexOf(body[i]);
    if (cp < 0) throw new Error(`not a Crockford character: ${body[i]}`);
    let addend = factor * cp;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return CROCKFORD[(n - (sum % n)) % n];
}

function body40(txId: string): string {
  const h = sha256(txId);
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(h[i]);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

export function makeBankRef(txId: string): string {
  const b = body40(txId);
  return `AR-${b}-${luhn32(b)}`;
}

export interface ParsedRef {
  raw: string;
  body: string;
  check: string;
  canonical: string;
  valid: boolean;
}

/** Parses "AR-XXXXXXXX-C", tolerating missing dashes, spaces and Crockford aliases. */
export function parseRef(raw: string): ParsedRef | undefined {
  const m = /^AR[-\s]?([0-9A-Z]{8})[-\s]?([0-9A-Z])$/.exec(raw.toUpperCase().trim());
  if (!m) return undefined;
  const body = crockfordNormalise(m[1]);
  const check = crockfordNormalise(m[2]);
  let valid = false;
  try {
    valid = luhn32(body) === check;
  } catch {
    valid = false;
  }
  return { raw, body, check, canonical: `AR-${body}-${check}`, valid };
}

/** Every AR token (complete or not) found in a narrative. */
export function findRefs(narrative: string): ParsedRef[] {
  const out: ParsedRef[] = [];
  const re = /(?<![0-9A-Z])AR[-\s]?[0-9A-Z]{8}[-\s]?[0-9A-Z](?![0-9A-Z])/g;
  for (const m of narrative.toUpperCase().matchAll(re)) {
    const p = parseRef(m[0]);
    if (p) out.push(p);
  }
  return out;
}

/** Trailing, cut-off token prefix such as "AR-7KQ" (truncated narratives). */
export function findRefPrefix(narrative: string): string | undefined {
  const m = /(?:^|\s)AR-?([0-9A-Z]{1,8})-?([0-9A-Z]?)$/.exec(narrative.toUpperCase().trimEnd());
  if (!m) return undefined;
  const full = findRefs(narrative);
  if (full.length && narrative.toUpperCase().trimEnd().endsWith(full[full.length - 1].raw.toUpperCase())) return undefined;
  return 'AR-' + crockfordNormalise(m[1]) + (m[2] ? '-' + crockfordNormalise(m[2]) : '');
}

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function damerauLevenshtein(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Among `candidates` (valid tokens), those within one edit of an invalid
 * token. A unique hit is a check-digit-backed correction.
 */
export function correctRef(token: ParsedRef, candidates: Iterable<string>): string[] {
  if (token.valid) return [];
  const hits: string[] = [];
  for (const c of candidates) {
    if (damerauLevenshtein(token.canonical, c) === 1) hits.push(c);
  }
  return hits;
}
