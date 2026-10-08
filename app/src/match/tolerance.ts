// Amount tolerance from fee-schedule.json.
// Fee difference: |Δ| <= max(fee_abs, fee_bps × amount) AND Δ equals a listed
// bank charge or the entry's own Chrgs. FX difference (SEP-31 payouts only):
// |Δ| / amountOut <= fx_band_bps. Anything else is unexplained.

import { abs, bps, max } from '../core/money.js';
import type { FeeSchedule, Kind } from '../types.js';

export interface Tolerances {
  feeAbs: bigint;
  feeBps: bigint;
  fxBandBps: bigint;
  charges: bigint[];
}

export function tolerancesFrom(f: FeeSchedule): Tolerances {
  return {
    feeAbs: BigInt(f.fee_abs),
    feeBps: BigInt(f.fee_bps),
    fxBandBps: BigInt(f.fx_band_bps),
    charges: f.bank_charges.map((c) => BigInt(c.amount)),
  };
}

export type AmountFit = { closeness: 1 | 0.8 | 0; kind: 'exact' | 'fee_diff' | 'fx_diff' | 'none'; delta: bigint; reason: string };

/**
 * expected: what the platform says the bank leg should be (cents).
 * observed: the bank amount (sum of lines for splits).
 * charges: Chrgs reported on the entry, if any.
 */
export function fitAmount(expected: bigint, observed: bigint, kind: Kind, t: Tolerances, charges?: bigint): AmountFit {
  const delta = expected - observed;
  if (delta === 0n) return { closeness: 1, kind: 'exact', delta, reason: 'amount exact' };
  const feeCap = max(t.feeAbs, (abs(expected) * t.feeBps) / 10_000n);
  const listed = t.charges.includes(abs(delta)) || (charges !== undefined && charges === abs(delta));
  if (abs(delta) <= feeCap && listed) {
    return { closeness: 0.8, kind: 'fee_diff', delta, reason: `difference ${delta} equals a listed bank charge` };
  }
  if (kind === 'receive') {
    const b = bps(delta, expected);
    if (b <= t.fxBandBps) return { closeness: 0.8, kind: 'fx_diff', delta, reason: `FX difference ${b} bps within ${t.fxBandBps} bps band` };
  }
  return { closeness: 0, kind: 'none', delta, reason: `difference ${delta} unexplained` };
}
