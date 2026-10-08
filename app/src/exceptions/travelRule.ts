// Absorbed compliance check (detection only): a SEP-31 receive with
// amountIn >= TRAVEL_RULE_THRESHOLD (default 0, the EU zero threshold) must
// carry a travel-rule reference that is a 64-hex envelope hash or matches a
// configured provider-id pattern, and that appears in the imported log.
// Screening and envelope exchange stay with the anchor's travel-rule provider.

import type { PlatformTx } from '../types.js';

export type TravelRuleResult = { ok: true } | { ok: false; subReason: 'EMPTY' | 'MALFORMED' | 'NOT_IN_LOG' };

export const ENVELOPE_HASH_RE = /^[0-9a-f]{64}$/i;

export function checkTravelRule(p: PlatformTx, threshold: bigint, providerPatterns: string[], log: Set<string>): TravelRuleResult | undefined {
  if (p.sep !== 31 || p.kind !== 'receive') return undefined;
  if (p.amountIn < threshold) return undefined;
  const ref = (p.travelRuleRef ?? '').trim();
  if (!ref) return { ok: false, subReason: 'EMPTY' };
  const wellFormed = ENVELOPE_HASH_RE.test(ref) || providerPatterns.some((re) => new RegExp(re).test(ref));
  if (!wellFormed) return { ok: false, subReason: 'MALFORMED' };
  if (!log.has(ref) && !log.has(ref.toLowerCase())) return { ok: false, subReason: 'NOT_IN_LOG' };
  return { ok: true };
}
