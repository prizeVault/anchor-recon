import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { makeMuxed, normaliseHorizonOp, parseHorizonPage, readHorizonFile, splitMuxed } from '../src/ingest/horizon.js';
import { ACCOUNTS } from '../src/seed/generate.js';
import { loadFixture, readJson, SEED_DIR } from './helpers.js';
import type { Expected } from '../src/seed/generate.js';

const ANCHOR = [ACCOUNTS.distribution, ACCOUNTS.receive];

test('horizon: payment with memo, 7-decimal amounts and direction', () => {
  const fx = loadFixture('exact');
  const [out, inn] = parseHorizonPage({ _embedded: { records: fx.chain['2026-08-10'] } }, ANCHOR);
  assert.equal(out.type, 'payment');
  assert.equal(out.direction, 'out');
  assert.equal(out.account, ACCOUNTS.distribution);
  assert.equal(out.amount, 2_487_500_000n);
  assert.equal(out.memoType, 'hash');
  assert.equal(inn.direction, 'in');
  assert.equal(inn.memo, '4401');
  assert.equal(inn.day, '2026-08-10');
});

test('horizon: M-address split into base account and muxed id', () => {
  const base = Keypair.random().publicKey();
  const m = makeMuxed(base, 900017n);
  assert.ok(m.startsWith('M'));
  assert.deepEqual(splitMuxed(m), { base, id: '900017' });
  assert.deepEqual(splitMuxed(base), { base });
  const fx = loadFixture('memo');
  const ops = parseHorizonPage({ _embedded: { records: fx.chain['2026-08-10'] } }, ANCHOR);
  const mux = ops.find((o) => o.muxedId)!;
  assert.equal(mux.to, ACCOUNTS.receive);
  assert.equal(mux.muxedId, '900017');
  assert.equal(mux.memo, undefined);
});

test('horizon: claimable balance create and claim, path payment', () => {
  const fx = loadFixture('cb');
  const [create] = parseHorizonPage({ _embedded: { records: fx.chain['2026-08-10'] } }, ANCHOR);
  assert.equal(create.type, 'create_cb');
  assert.equal(create.asset, 'EURC');
  assert.equal(create.amount, 790_000_000n);
  assert.ok(create.cbId?.startsWith('00000000'));
  const [claim] = parseHorizonPage({ _embedded: { records: fx.chain['2026-08-11'] } }, ANCHOR);
  assert.equal(claim.type, 'claim_cb');
  assert.equal(claim.cbId, create.cbId);
  const pp = normaliseHorizonOp(
    { id: '1', type: 'path_payment_strict_send', transaction_hash: 'h', created_at: '2026-08-10T10:00:00Z', from: 'GX', to: ACCOUNTS.receive, asset_type: 'credit_alphanum4', asset_code: 'USDC', amount: '12.3456789', transaction: { memo_type: 'text', memo: 'S31-1' } },
    ANCHOR,
  )!;
  assert.equal(pp.type, 'path_payment');
  assert.equal(pp.amount, 123_456_789n);
  assert.equal(pp.memo, 'S31-1');
  assert.equal(normaliseHorizonOp({ id: '2', type: 'manage_data' }, ANCHOR), undefined, 'irrelevant op types are skipped');
  assert.throws(() => parseHorizonPage({}, ANCHOR), /Horizon/);
});

test('horizon: seed chain files hold the expected number of operations', () => {
  const exp = readJson<Expected>('../data/seed/expected.json');
  const dir = join(SEED_DIR, 'chain');
  const n = readdirSync(dir).reduce((a, f) => a + readHorizonFile(join(dir, f), ANCHOR).length, 0);
  assert.equal(n, exp.counts.chainOps);
  assert.ok(n >= 400 && n <= 420, `about 410 ops, got ${n}`);
});
