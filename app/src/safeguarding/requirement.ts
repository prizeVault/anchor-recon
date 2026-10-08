// Safeguarding requirement: the sum, at the cut-off, of platform transactions
// in the configured "owed" states, plus open REVERSAL_OPEN returns. Which
// states count is the compliance officer's call (safeguarding.json,
// docs/REGULATORY-MAPPING.md). Assumption, not legal advice.

import type { PlatformTx, ReconException, SafeguardingConfig } from '../types.js';

export interface RequirementLine {
  ref: string;
  status: string;
  amount: bigint;
}

export interface Requirement {
  total: bigint;
  lines: RequirementLine[];
}

export function requirement(platform: Iterable<PlatformTx>, cfg: SafeguardingConfig, openExceptions: ReconException[] = []): Requirement {
  const lines: RequirementLine[] = [];
  for (const p of platform) {
    for (const rule of cfg.owed_states) {
      if (rule.kind !== p.kind || !rule.statuses.includes(p.status)) continue;
      const asset = rule.amount === 'amountIn' ? p.assetIn : p.assetOut;
      if (asset !== cfg.currency) throw new Error(`owed amount of ${p.id} is in ${asset}, not ${cfg.currency}`);
      lines.push({ ref: `ptx:${p.id}`, status: p.status, amount: rule.amount === 'amountIn' ? p.amountIn : p.amountOut });
    }
  }
  if (cfg.include_open_reversals) {
    for (const e of openExceptions) {
      if (e.type === 'REVERSAL_OPEN' && e.status === 'open' && e.amount) lines.push({ ref: e.id, status: 'REVERSAL_OPEN', amount: BigInt(e.amount) });
    }
  }
  lines.sort((a, b) => (a.ref < b.ref ? -1 : 1));
  return { total: lines.reduce((a, l) => a + l.amount, 0n), lines };
}
