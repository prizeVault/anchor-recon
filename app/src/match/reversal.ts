// Reversals: opposite-direction bank lines on the same account with equal
// amount within 5 business days, where RvslInd is set or the narrative
// matches RETURN|RTN|REVERSAL|R0\d|AC0\d. The pair is REVERSED_PAIR. If the
// linked platform transaction is `refunded` the group closes (a reversal_pair
// proposal for the analyst); otherwise REVERSAL_OPEN is raised.

import { dayOf } from '../core/dates.js';
import type { BankLine } from '../types.js';
import type { ReconState } from '../store/store.js';
import type { ReconContext } from './context.js';

export const REVERSAL_RE = /\b(RETURN|RTN|REVERSAL|R0\d|AC0\d)\b/;

export interface ReversalPair {
  returnLineId: string;
  originalLineId: string;
  platformId?: string;
  closed: boolean;
}

export function isReversalLine(l: BankLine): boolean {
  return l.reversal || REVERSAL_RE.test(l.narrative);
}

export function findReversals(state: ReconState, ctx: ReconContext, leftover: BankLine[]): ReversalPair[] {
  const out: ReversalPair[] = [];
  const usedOriginals = new Set<string>();
  for (const r of leftover.filter(isReversalLine)) {
    const candidates = Object.values(state.bank)
      .filter(
        (o) =>
          o.id !== r.id &&
          o.account === r.account &&
          o.direction !== r.direction &&
          o.amount === r.amount &&
          !usedOriginals.has(o.id) &&
          o.valueDate <= r.valueDate &&
          ctx.cal.diff(dayOf(o.valueDate), dayOf(r.valueDate)) <= 5,
      )
      .sort((a, b) => (a.valueDate === b.valueDate ? (a.id < b.id ? -1 : 1) : a.valueDate > b.valueDate ? -1 : 1));
    const orig = candidates[0];
    if (!orig) continue;
    usedOriginals.add(orig.id);
    const use = state.itemUse[`bank:${orig.id}`];
    const g = use?.startsWith('group:') ? state.groups.find((x) => x.id === use.slice(6)) : undefined;
    const pid = g?.platformIds[0];
    const closed = !!pid && state.platform[pid]?.status === 'refunded';
    out.push({ returnLineId: r.id, originalLineId: orig.id, platformId: pid, closed });
  }
  return out;
}
