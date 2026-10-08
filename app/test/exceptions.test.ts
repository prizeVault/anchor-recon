import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../src/core/hash.js';
import { makeBankRef } from '../src/core/reference.js';
import { ACCOUNTS } from '../src/seed/generate.js';
import { emptyState } from '../src/store/store.js';
import { matchDay } from '../src/match/engine.js';
import { checkTravelRule } from '../src/exceptions/travelRule.js';
import { EXCEPTION_TYPES } from '../src/exceptions/types.js';
import { heuristicExplanation } from '../src/ai/heuristic.js';
import { guardExplanation, ALLOWED_ACTIONS } from '../src/ai/guard.js';
import { evidenceFor } from '../src/match/engine.js';
import type { Fixture, FixtureLine } from './fixtures/build.js';
import { op, ptx, user, stranger, partner, txh } from './fixtures/build.js';
import { ingestFixtureDay, runFixture, testCtx } from './helpers.js';
import type { PlatformTx, SafeguardingConfig } from '../src/types.js';

const D1 = '2026-08-10';
const D2 = '2026-08-11';
const D3 = '2026-08-12';
const D4 = '2026-08-13';
const D5 = '2026-08-14';
const customers = [{ id: 'C1', name: 'Ana Costa' }];

async function run(fx: Partial<Fixture> & { days: string[] }, over: Partial<SafeguardingConfig> = {}) {
  const f: Fixture = { name: 't', customers, platform: {}, chain: {}, bank: {}, expect: {}, ...fx };
  const ctx = testCtx(f.customers, over);
  const state = emptyState();
  for (const d of f.days) {
    ingestFixtureDay(state, ctx, f, d);
    await matchDay(state, ctx, d);
    state.processedDays.push(d);
  }
  return { state, ctx };
}
const types = (s: { exceptions: { type: string }[] }) => s.exceptions.map((e) => e.type).sort();
const line = (id: string, account: string, direction: 'credit' | 'debit', amount: string, narrative: string, extra: Partial<FixtureLine> = {}): FixtureLine => ({ id, account, direction, amount, valueDate: D1, narrative, ...extra });

test('exceptions: every type code has a template explanation that passes its own guard', () => {
  for (const t of EXCEPTION_TYPES) {
    const e = { id: `EX-${t}`, type: t, day: D1, openedOn: D1, status: 'open' as const, evidenceIds: ['bank:x'], amount: '12345', currency: 'EUR', subReason: t === 'TRAVEL_RULE_MISSING' ? 'EMPTY' : undefined };
    const x = heuristicExplanation({ exception: e, evidence: { 'bank:x': { amount: '12345' } } });
    assert.equal(x.type, t);
    assert.ok(ALLOWED_ACTIONS[t].includes(x.suggestedAction), t);
    assert.ok(guardExplanation({ exception: e, evidence: {} }, x).ok, t);
  }
  assert.equal(EXCEPTION_TYPES.length, 17);
});

test('PLATFORM_NO_CHAIN_LEG: completed deposit, bank credit present, no chain payment', async () => {
  const { state } = await run({
    days: [D1, D2],
    platform: { [D1]: [ptx({ id: 'k01', sep: 24, kind: 'deposit', status: 'completed', inAmt: '90.00', inAsset: 'EUR', outAmt: '89.00', outAsset: 'EURC', stx: [txh('never')], customer: 'C1', started: D1, completed: D1 })] },
    bank: { [D1]: [line('A:1', 'bank-a', 'credit', '9000', `${makeBankRef('k01')} ANA COSTA`)] },
  });
  assert.deepEqual(types(state), ['PLATFORM_NO_CHAIN_LEG']);
  assert.equal(state.exceptions[0].day, D2);
});

test('PLATFORM_NO_BANK_LEG: completed withdrawal with no payout line', async () => {
  const { state } = await run({
    days: [D1, D2],
    platform: { [D1]: [ptx({ id: 'nb', sep: 24, kind: 'withdrawal', status: 'completed', inAmt: '41.00', inAsset: 'EURC', outAmt: '40.00', outAsset: 'EUR', memo: '77', memoType: 'id', customer: 'C1', started: D1, completed: D1 })] },
    chain: { [D1]: [op({ label: 'nb', day: D1, from: user('C1'), to: ACCOUNTS.receive, code: 'EURC', amount: '41.0000000', memo: { type: 'id', value: '77' } })] },
  });
  assert.deepEqual(types(state), ['PLATFORM_NO_BANK_LEG']);
});

test('DUPLICATE_CHAIN_PAYMENT and DUPLICATE_PAYOUT', async () => {
  const { state } = await runFixture('dup');
  assert.deepEqual(types(state), ['DUPLICATE_CHAIN_PAYMENT', 'DUPLICATE_PAYOUT']);
});

test('SHORT_PAYOUT: payout debit below amountOut beyond tolerance', async () => {
  const { state } = await run({
    days: [D1, D2],
    platform: { [D1]: [ptx({ id: 'k03', sep: 24, kind: 'withdrawal', status: 'completed', inAmt: '251.25', inAsset: 'EURC', outAmt: '250.00', outAsset: 'EUR', memo: '31', memoType: 'id', customer: 'C1', started: D1, completed: D1 })] },
    chain: { [D1]: [op({ label: 'k03', day: D1, from: user('C1'), to: ACCOUNTS.receive, code: 'EURC', amount: '251.2500000', memo: { type: 'id', value: '31' } })] },
    bank: { [D1]: [line('B:1', 'bank-b', 'debit', '22500', `SEPA CT ${makeBankRef('k03')} ANA`)] },
  });
  assert.deepEqual(types(state), ['SHORT_PAYOUT']);
  assert.equal(state.exceptions[0].amount, '22500');
});

test('AMOUNT_MISMATCH: deposit credit 480.00 against 500.00 with no listed fee', async () => {
  const { state } = await run({
    days: [D1, D2],
    platform: { [D1]: [ptx({ id: 'k09', sep: 24, kind: 'deposit', status: 'pending_anchor', inAmt: '500.00', inAsset: 'EUR', outAmt: '497.50', outAsset: 'EURC', customer: 'C1', started: D1 })] },
    bank: { [D1]: [line('A:1', 'bank-a', 'credit', '48000', `${makeBankRef('k09')} ANA COSTA`)] },
  });
  assert.deepEqual(types(state), ['AMOUNT_MISMATCH']);
});

test('WRONG_MEMO and UNMATCHED_CHAIN_IN / UNMATCHED_CHAIN_OUT', async () => {
  const { state } = await run({
    days: [D1, D2],
    chain: {
      [D1]: [
        op({ label: 'wm', day: D1, from: stranger, to: ACCOUNTS.receive, code: 'EURC', amount: '315.7700000', memo: { type: 'text', value: 'WD-88213-X' } }),
        op({ label: 'uin', day: D1, from: stranger, to: ACCOUNTS.receive, code: 'USDC', amount: '1250.0000000' }),
        op({ label: 'uout', day: D1, from: ACCOUNTS.distribution, to: stranger, code: 'EURC', amount: '10.0000000' }),
      ],
    },
  });
  assert.deepEqual(types(state), ['UNMATCHED_CHAIN_IN', 'UNMATCHED_CHAIN_OUT', 'WRONG_MEMO']);
});

test('UNMATCHED_BANK_CREDIT and UNMATCHED_BANK_DEBIT', async () => {
  const { state } = await run({
    days: [D1, D2],
    bank: { [D1]: [line('A:1', 'bank-a', 'credit', '74000', 'TRANSFER', { counterparty: 'M KOWALSKY' }), line('B:1', 'bank-b', 'debit', '1999', 'CARD FEE REFUND XYZ')] },
  });
  assert.deepEqual(types(state), ['UNMATCHED_BANK_CREDIT', 'UNMATCHED_BANK_DEBIT']);
});

test('STATUS_MISMATCH: SEP-6 deposit in error although chain delivery succeeded', async () => {
  const m = sha256Hex('k12');
  const { state } = await run({
    days: [D1],
    platform: { [D1]: [ptx({ id: 'k12', sep: 6, kind: 'deposit', status: 'error', inAmt: '60.00', inAsset: 'EUR', outAmt: '59.00', outAsset: 'EURC', memo: m, memoType: 'hash', customer: 'C1', started: D1 })] },
    chain: { [D1]: [op({ label: 'k12', day: D1, from: ACCOUNTS.distribution, to: user('C1'), code: 'EURC', amount: '59.0000000', memo: { type: 'hash', value: m } })] },
    bank: { [D1]: [line('A:1', 'bank-a', 'credit', '6000', `${makeBankRef('k12')} ANA COSTA`)] },
  });
  assert.deepEqual(types(state), ['STATUS_MISMATCH']);
});

test('REVERSAL_OPEN: payout returned while the platform still says completed', async () => {
  const { state } = await runFixture('reversal');
  assert.ok(types(state).includes('REVERSAL_OPEN'));
});

test('STALE_PENDING: pending_anchor for more than 3 business days, raised once', async () => {
  const rec = ptx({ id: 'k08', sep: 24, kind: 'withdrawal', status: 'pending_anchor', inAmt: '81.00', inAsset: 'EURC', outAmt: '80.00', outAsset: 'EUR', memo: '88', memoType: 'id', customer: 'C1', started: D1 });
  const { state } = await run({
    days: [D1, D2, D3, D4, D5, '2026-08-17'],
    platform: { [D1]: [rec] },
    chain: { [D1]: [op({ label: 'k08', day: D1, from: user('C1'), to: ACCOUNTS.receive, code: 'EURC', amount: '81.0000000', memo: { type: 'id', value: '88' } })] },
  });
  assert.deepEqual(types(state), ['STALE_PENDING']);
  assert.equal(state.exceptions[0].day, D5);
});

test('NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING: immediate; allowed sweeps and charges are not', async () => {
  const { state } = await run({
    days: [D1],
    bank: {
      [D1]: [
        line('A:rent', 'bank-a', 'debit', '341250', 'OFFICE RENT AUG 2026 SIM PROPERTIES LTD'),
        line('A:sweep', 'bank-a', 'debit', '100000', 'SWEEP TO PAYOUT ACCT'),
        line('A:chg', 'bank-a', 'debit', '2500', 'BANK CHARGES ACCOUNT FEE'),
      ],
    },
  });
  assert.deepEqual(types(state), ['NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING']);
  assert.equal(state.exceptions[0].day, D1);
  assert.equal(state.groups.filter((g) => g.rule === 'internal_allowed').length, 2);
});

test('STATEMENT_MISSING: an expected account without a statement on a business day', async () => {
  const { state } = await run({ days: [D1], bank: { [D1]: [line('A:x', 'bank-a', 'debit', '100', 'SWEEP TO PAYOUT ACCT')] } }, { expected_accounts: ['bank-a', 'bank-b'] });
  assert.deepEqual(types(state), ['STATEMENT_MISSING']);
  assert.deepEqual(state.exceptions[0].evidenceIds, [`stmt:bank-b:${D1}`]);
});

test('TRAVEL_RULE_MISSING: EMPTY, MALFORMED, NOT_IN_LOG through the matcher', async () => {
  const r = (id: string, tr: string) => ptx({ id, sep: 31, kind: 'receive', status: 'pending_receiver', inAmt: '100.00', inAsset: 'USDC', outAmt: '91.00', outAsset: 'EUR', memo: id.length.toString(), memoType: 'text', customer: 'C1', started: D1, tr });
  const { state } = await run({ days: [D1], platform: { [D1]: [r('t01', ''), r('t02', 'ab'.repeat(32)), r('t03', 'TR-REF-MISSING'), r('tok', 'TRP-ABCDEF123456')] } });
  const tr = state.exceptions.filter((e) => e.type === 'TRAVEL_RULE_MISSING').map((e) => [e.evidenceIds[0], e.subReason]).sort();
  assert.deepEqual(tr, [
    ['ptx:t01', 'EMPTY'],
    ['ptx:t02', 'NOT_IN_LOG'],
    ['ptx:t03', 'MALFORMED'],
  ]);
  void partner;
});

test('TRAVEL_RULE_MISSING: threshold boundary (at threshold checked, below not)', () => {
  const p = { sep: 31, kind: 'receive', amountIn: 1_000_000_000n, travelRuleRef: '' } as PlatformTx;
  assert.deepEqual(checkTravelRule(p, 1_000_000_000n, [], new Set()), { ok: false, subReason: 'EMPTY' });
  assert.equal(checkTravelRule(p, 1_000_000_001n, [], new Set()), undefined);
  assert.equal(checkTravelRule({ ...p, sep: 24, kind: 'withdrawal' } as PlatformTx, 0n, [], new Set()), undefined);
  assert.deepEqual(checkTravelRule({ ...p, travelRuleRef: 'TRP-ABCDEF123456' } as PlatformTx, 0n, ['^TRP-[0-9A-F]{12}$'], new Set(['TRP-ABCDEF123456'])), { ok: true });
});

test('explanations cite only evidence and pass the guard; an invented number is rejected', async () => {
  const { state } = await runFixture('dup');
  for (const e of state.exceptions) {
    const g = guardExplanation({ exception: e, evidence: evidenceFor(state, e) }, e.explanation!);
    assert.ok(g.ok, g.errors.join(';'));
    assert.ok(e.explanation!.evidenceIds.every((id) => e.evidenceIds.includes(id)));
  }
  const e = state.exceptions[0];
  const bad = { ...e.explanation!, summary: 'Overpaid by 999.99 EUR.' };
  assert.equal(guardExplanation({ exception: e, evidence: evidenceFor(state, e) }, bad).ok, false);
  const badId = { ...e.explanation!, evidenceIds: ['bank:invented'] };
  assert.equal(guardExplanation({ exception: e, evidence: {} }, badId).ok, false);
  const badAction = { ...e.explanation!, suggestedAction: 'TOP_UP_SAFEGUARDING' as const };
  assert.equal(guardExplanation({ exception: e, evidence: {} }, badAction).ok, false);
});
