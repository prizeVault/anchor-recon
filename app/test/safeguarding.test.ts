import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirement } from '../src/safeguarding/requirement.js';
import { externalReconciliation, resource, shortfallExcess } from '../src/safeguarding/resource.js';
import { SG_CONFIG_FOR_SEED } from '../src/seed/generate.js';
import { emptyState } from '../src/store/store.js';
import { safeguardingFigures } from '../src/report/figures.js';
import { classify } from '../src/exceptions/classify.js';
import { testCtx } from './helpers.js';
import type { Balance, BankLine, PlatformTx, ReconException } from '../src/types.js';

const cfg = SG_CONFIG_FOR_SEED();
const tx = (id: string, kind: PlatformTx['kind'], status: string, amountIn: bigint, amountOut: bigint): PlatformTx =>
  ({ id, kind, status, amountIn, amountOut, assetIn: kind === 'deposit' ? 'EUR' : kind === 'withdrawal' ? 'EURC' : 'USDC', assetOut: kind === 'deposit' ? 'EURC' : 'EUR' }) as PlatformTx;

test('requirement: owed states from config; other states and fee-free legs excluded', () => {
  const r = requirement(
    [
      tx('d1', 'deposit', 'pending_anchor', 10_000n, 99_000_000n),
      tx('d2', 'deposit', 'completed', 20_000n, 0n),
      tx('d3', 'deposit', 'pending_user_transfer_start', 30_000n, 0n),
      tx('w1', 'withdrawal', 'pending_anchor', 0n, 5_000n),
      tx('w2', 'withdrawal', 'pending_external', 0n, 7_000n),
      tx('r1', 'receive', 'pending_receiver', 0n, 1_234n),
      tx('r2', 'receive', 'completed', 0n, 9_999n),
    ],
    cfg,
  );
  assert.equal(r.total, 10_000n + 5_000n + 7_000n + 1_234n);
  assert.deepEqual(r.lines.map((l) => l.ref), ['ptx:d1', 'ptx:r1', 'ptx:w1', 'ptx:w2']);
});

test('requirement: open REVERSAL_OPEN returns are added; closed ones and other types are not', () => {
  const ex = (id: string, type: string, status: 'open' | 'closed', amount: string) => ({ id, type, status, amount }) as ReconException;
  const r = requirement([], cfg, [ex('a', 'REVERSAL_OPEN', 'open', '60000'), ex('b', 'REVERSAL_OPEN', 'closed', '1'), ex('c', 'SHORT_PAYOUT', 'open', '5')]);
  assert.equal(r.total, 60_000n);
  assert.equal(requirement([], { ...cfg, include_open_reversals: false }, [ex('a', 'REVERSAL_OPEN', 'open', '60000')]).total, 0n);
  assert.throws(() => requirement([{ ...tx('x', 'deposit', 'pending_anchor', 1n, 1n), assetIn: 'USD' }], cfg), /not EUR/);
});

test('resource: CLBD of designated accounts; manual balance flagged; missing blocks', () => {
  const bal = (account: string, amount: bigint, source: Balance['source'] = 'statement', type: Balance['type'] = 'CLBD'): Balance => ({ account, date: '2026-08-18', type, amount, source });
  const r = resource([bal('bank-a', 1_000n), bal('bank-b', 50_000n)], cfg, '2026-08-18');
  assert.equal(r.total, 1_000n, 'only designated safeguarding accounts count');
  assert.equal(r.source, 'statement');
  const m = resource([bal('bank-a', 1_000n), bal('bank-a', 2_000n, 'manual')], cfg, '2026-08-18');
  assert.equal(m.total, 2_000n);
  assert.equal(m.source, 'manual');
  const missing = resource([], cfg, '2026-08-18');
  assert.equal(missing.blocked, true);
  assert.equal(missing.total, undefined);
});

test('shortfall and excess', () => {
  assert.deepEqual(shortfallExcess(1_000_000n, 658_750n), { shortfall: 341_250n, excess: 0n });
  assert.deepEqual(shortfallExcess(100n, 150n), { shortfall: 0n, excess: 50n });
  assert.deepEqual(shortfallExcess(100n, undefined), {});
});

test('external reconciliation: previous CLBD + booked lines vs bank CLBD, with a difference', () => {
  const balances: Balance[] = [
    { account: 'bank-a', date: '2026-08-17', type: 'CLBD', amount: 10_000n, source: 'statement' },
    { account: 'bank-a', date: '2026-08-18', type: 'CLBD', amount: 12_000n, source: 'statement' },
  ];
  const lines = [
    { account: 'bank-a', bookingDate: '2026-08-18', direction: 'credit', amount: 2_500n },
    { account: 'bank-a', bookingDate: '2026-08-18', direction: 'debit', amount: 400n },
    { account: 'bank-b', bookingDate: '2026-08-18', direction: 'debit', amount: 9n },
  ] as BankLine[];
  const x = externalReconciliation(balances, lines, 'bank-a', '2026-08-18', '2026-08-17');
  assert.equal(x.internal, 12_100n);
  assert.equal(x.bank, 12_000n);
  assert.equal(x.difference, -100n);
});

test('STATEMENT_MISSING blocks the resource figure', () => {
  const ctx = testCtx([], { expected_accounts: ['bank-a'] });
  const state = emptyState();
  state.platform.d = { ...tx('d', 'deposit', 'pending_anchor', 5_000n, 0n), stellarTxHashes: [], refundTxHashes: [], startedAt: '2026-08-18T09:00:00Z' };
  classify(state, ctx, '2026-08-18');
  assert.ok(state.exceptions.some((e) => e.type === 'STATEMENT_MISSING'));
  const f = safeguardingFigures(state, ctx, '2026-08-18');
  assert.equal(f.blocked, true);
  assert.equal(f.resource, undefined);
  assert.equal(f.shortfall, undefined);
  assert.equal(f.requirement, '5000');
  // an analyst-entered manual balance lifts the block
  state.balances.push({ account: 'bank-a', date: '2026-08-18', type: 'CLBD', amount: 4_000n, source: 'manual' });
  const g = safeguardingFigures(state, ctx, '2026-08-18');
  assert.equal(g.blocked, false);
  assert.equal(g.resourceSource, 'manual');
  assert.equal(g.shortfall, '1000');
});
