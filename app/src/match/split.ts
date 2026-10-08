// Split deposits: subset-sum over at most 3 leftover bank credits from the
// same normalised counterparty within 2 business days, summing to amountIn
// within fee tolerance.

import { dayOf } from '../core/dates.js';
import { normaliseCounterparty, narrativeNameTokens } from '../ingest/normalise.js';
import type { BankLine, PlatformTx } from '../types.js';
import type { ReconContext } from './context.js';
import { fitAmount, type AmountFit } from './tolerance.js';
import { inWindow } from './candidates.js';

export interface SplitCandidate {
  platformId: string;
  lineIds: string[];
  fit: AmountFit;
}

export function counterpartyKey(l: BankLine): string {
  return normaliseCounterparty(l.counterparty) || narrativeNameTokens(l.narrative).sort().join(' ');
}

function combos<T>(xs: T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of combos(xs.slice(i + 1), k - 1)) out.push([x, ...rest]);
  });
  return out;
}

export function splitCandidates(lines: BankLine[], open: PlatformTx[], ctx: ReconContext): SplitCandidate[] {
  const credits = lines.filter((l) => l.direction === 'credit');
  const byCp = new Map<string, BankLine[]>();
  for (const l of credits) {
    const k = counterpartyKey(l);
    if (!k) continue;
    if (!byCp.has(k)) byCp.set(k, []);
    byCp.get(k)!.push(l);
  }
  const out: SplitCandidate[] = [];
  for (const p of open.filter((x) => x.kind === 'deposit')) {
    for (const group of byCp.values()) {
      if (group.length < 2) continue;
      for (const k of [2, 3]) {
        for (const c of combos(group, k)) {
          const days = c.map((l) => dayOf(l.valueDate));
          if (ctx.cal.diff(Math.min(...days), Math.max(...days)) > 2) continue;
          if (!c.every((l) => inWindow(ctx, p, l.valueDate))) continue;
          const total = c.reduce((a, l) => a + l.amount, 0n);
          const charges = c.reduce((a, l) => a + (l.charges ?? 0n), 0n);
          const fit = fitAmount(p.amountIn, total, 'deposit', ctx.tol, charges || undefined);
          if (fit.closeness > 0) out.push({ platformId: p.id, lineIds: c.map((l) => l.id).sort(), fit });
        }
      }
    }
  }
  return out;
}
