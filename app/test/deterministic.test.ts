import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoEquals, hashHex } from '../src/match/deterministic.js';
import { runFixture } from './helpers.js';
import type { ChainOp, PlatformTx } from '../src/types.js';

test('deterministic: exact matches by tx hash, AR token, end-to-end id and memo', async () => {
  const { state } = await runFixture('exact');
  const rules = state.groups.map((g) => g.rule).sort();
  assert.deepEqual(rules, ['ar_token', 'e2e_id', 'memo', 'tx_hash']);
  assert.ok(state.groups.every((g) => g.method === 'rule'));
  assert.equal(state.legs['tx-exact-dep'].chain !== undefined && state.legs['tx-exact-dep'].bank !== undefined, true);
  assert.equal(state.proposals.length, 0);
  assert.equal(state.exceptions.length, 0);
});

test('deterministic: memo variants (text, hash hex vs base64) and SEP-31 muxed id', async () => {
  const { state } = await runFixture('memo');
  const byTx = Object.fromEntries(state.groups.map((g) => [g.platformIds[0], g.rule]));
  assert.deepEqual(byTx, { 'tx-memo-text': 'memo', 'tx-memo-hash': 'memo', 'tx-memo-mux': 'muxed_id' });
});

test('deterministic: claimable-balance delivery by balance id, claim linked later', async () => {
  const { state } = await runFixture('cb');
  assert.deepEqual(state.groups.map((g) => g.rule), ['cb_id', 'ar_token', 'cb_claim']);
  assert.equal(state.exceptions.length, 0);
});

test('deterministic: a duplicate is flagged, not matched', async () => {
  const { state } = await runFixture('dup');
  const types = state.exceptions.map((e) => e.type).sort();
  assert.deepEqual(types, ['DUPLICATE_CHAIN_PAYMENT', 'DUPLICATE_PAYOUT']);
  const dupChain = state.exceptions.find((e) => e.type === 'DUPLICATE_CHAIN_PAYMENT')!;
  assert.equal(dupChain.evidenceIds.filter((i) => i.startsWith('op:')).length, 2);
  assert.equal(state.legs['tx-dup-dep'].chain, undefined, 'neither payment is matched');
  assert.ok(state.legs['tx-dup-dep'].bank, 'the bank leg still matches');
  const dupPay = state.exceptions.find((e) => e.type === 'DUPLICATE_PAYOUT')!;
  assert.deepEqual(dupPay.evidenceIds.filter((i) => i.startsWith('bank:')).sort(), ['bank:B:dup1', 'bank:B:dup2']);
  assert.equal(state.legs['tx-dup-pay'].bank, undefined);
  assert.ok(state.legs['tx-dup-pay'].chain);
});

test('deterministic: memo equality is type-aware', () => {
  const h = 'ab'.repeat(32);
  const b64 = Buffer.from(h, 'hex').toString('base64');
  const p = { memo: h, memoType: 'hash' } as PlatformTx;
  assert.equal(memoEquals(p, { memo: b64, memoType: 'hash' } as ChainOp), true);
  assert.equal(memoEquals(p, { memo: b64, memoType: 'text' } as ChainOp), false);
  assert.equal(memoEquals({ memo: '007', memoType: 'id' } as PlatformTx, { memo: '7', memoType: 'id' } as ChainOp), true);
  assert.equal(memoEquals({ memo: 'WD1 ', memoType: 'text' } as PlatformTx, { memo: 'WD1', memoType: 'text' } as ChainOp), true);
  assert.equal(memoEquals({ memo: 'x', memoType: 'id' } as PlatformTx, { memo: 'y', memoType: 'id' } as ChainOp), false);
  assert.equal(hashHex('nothex'), undefined);
});
