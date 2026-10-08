// Safeguarding resource: the CLBD balance of each designated safeguarding
// account for the day, or an analyst-entered balance flagged `manual`. A
// missing statement blocks the resource figure (STATEMENT_MISSING).
// External reconciliation: previous CLBD + the day's booked lines vs the
// bank's CLBD, per designated account.

import type { Balance, BankLine, SafeguardingConfig } from '../types.js';

export interface Resource {
  total?: bigint;
  source: 'statement' | 'manual' | 'mixed' | 'blocked';
  perAccount: Record<string, { amount?: bigint; source: string }>;
  blocked: boolean;
}

export function closing(balances: Balance[], account: string, day: string): Balance | undefined {
  const c = balances.filter((b) => b.account === account && b.date === day && b.type === 'CLBD');
  return c.find((b) => b.source === 'manual') ?? c[0];
}

export function resource(balances: Balance[], cfg: SafeguardingConfig, day: string): Resource {
  const perAccount: Resource['perAccount'] = {};
  let total = 0n;
  let blocked = false;
  const sources = new Set<string>();
  for (const acct of cfg.safeguarding_accounts) {
    const c = closing(balances, acct, day);
    if (!c) {
      blocked = true;
      perAccount[acct] = { source: 'missing' };
      continue;
    }
    perAccount[acct] = { amount: c.amount, source: c.source };
    sources.add(c.source);
    total += c.amount;
  }
  return {
    total: blocked ? undefined : total,
    source: blocked ? 'blocked' : sources.size > 1 ? 'mixed' : ((sources.values().next().value as 'statement' | 'manual' | undefined) ?? 'statement'),
    perAccount,
    blocked,
  };
}

export interface ExternalRec {
  account: string;
  previous?: bigint;
  movements: bigint;
  internal?: bigint;
  bank?: bigint;
  difference?: bigint;
}

export function externalReconciliation(balances: Balance[], lines: BankLine[], account: string, day: string, previousDay?: string): ExternalRec {
  const prev = previousDay ? closing(balances, account, previousDay)?.amount : undefined;
  const opening = balances.find((b) => b.account === account && b.date === day && b.type === 'OPBD')?.amount;
  const base = prev ?? opening;
  const movements = lines.filter((l) => l.account === account && l.bookingDate === day).reduce((a, l) => a + (l.direction === 'credit' ? l.amount : -l.amount), 0n);
  const bank = closing(balances, account, day)?.amount;
  const internal = base === undefined ? undefined : base + movements;
  return { account, previous: base, movements, internal, bank, difference: internal !== undefined && bank !== undefined ? bank - internal : undefined };
}

export function shortfallExcess(req: bigint, res: bigint | undefined): { shortfall?: bigint; excess?: bigint } {
  if (res === undefined) return {};
  return { shortfall: req > res ? req - res : 0n, excess: res > req ? res - req : 0n };
}
