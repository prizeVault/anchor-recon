// Narrative canonicalisation: uppercase, strip diacritics, collapse
// whitespace; extract AR- tokens (with check-digit validation), IBAN-like ids
// and end-to-end ids.

import { findRefs, findRefPrefix, type ParsedRef } from '../core/reference.js';

const SPECIAL: Record<string, string> = { Ł: 'L', ł: 'l', Ø: 'O', ø: 'o', ß: 'SS', Æ: 'AE', æ: 'ae', Œ: 'OE', œ: 'oe', Đ: 'D', đ: 'd' };

export function stripDiacritics(s: string): string {
  return s
    .replace(/[ŁłØøßÆæŒœĐđ]/g, (c) => SPECIAL[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function normaliseNarrative(s: string): string {
  return stripDiacritics(s)
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Name -> sorted-insensitive token list: uppercase ASCII words, punctuation split. */
export function nameTokens(s: string): string[] {
  return normaliseNarrative(s)
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0);
}

export function normaliseCounterparty(s: string | undefined): string {
  if (!s) return '';
  return nameTokens(s).sort().join(' ');
}

export interface Extracted {
  refs: ParsedRef[];
  refPrefix?: string;
  ibans: string[];
  e2e: string[];
}

export function extract(narrative: string): Extracted {
  const n = normaliseNarrative(narrative);
  const ibans = [...n.matchAll(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g)].map((m) => m[0]).filter((x) => !x.startsWith('AR'));
  const e2e = [...n.matchAll(/\bE2E[-A-Z0-9]{6,32}\b/g)].map((m) => m[0]);
  return { refs: findRefs(n), refPrefix: findRefPrefix(n), ibans, e2e };
}

/** Words that carry no name information in bank narratives. */
export const NARRATIVE_STOPWORDS = new Set([
  'SEPA', 'CT', 'SCT', 'INST', 'FROM', 'TO', 'REF', 'PAYOUT', 'PAYMENT', 'TRANSFER', 'TRF', 'CREDIT', 'DEBIT',
  'PART', 'OF', 'THE', 'AND', 'EUR', 'FOR', 'DEPOSIT', 'WITHDRAWAL', 'RETURN', 'RTN', 'REVERSAL', 'ACC', 'ACCOUNT',
  'CLOSED', 'INVALID', 'IBAN', 'NOTPROVIDED', 'BY', 'ORDER', 'MR', 'MRS', 'MS', 'DR', 'SIM', 'ANCHOR', 'EMI',
]);

export function narrativeNameTokens(narrative: string): string[] {
  return nameTokens(narrative).filter((t) => !NARRATIVE_STOPWORDS.has(t) && !/\d/.test(t) && !t.startsWith('AR'));
}
