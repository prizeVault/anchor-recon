import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PLATFORM_MAP, getPath, normalisePlatformRecord, parsePlatformExport } from '../src/ingest/platform.js';
import { loadFixture, SEED_DIR } from './helpers.js';

test('platform: SEP-24 deposit, SEP-24 withdrawal normalised through the map', () => {
  const fx = loadFixture('exact');
  const [dep, wd] = parsePlatformExport(fx.platform['2026-08-10'], DEFAULT_PLATFORM_MAP, '2026-08-10');
  assert.equal(dep.sep, 24);
  assert.equal(dep.kind, 'deposit');
  assert.equal(dep.status, 'completed');
  assert.equal(dep.amountIn, 25000n);
  assert.equal(dep.assetIn, 'EUR');
  assert.equal(dep.amountOut, 2_487_500_000n, 'EURC amounts are 7-decimal units');
  assert.equal(dep.assetOnChain, 'EURC');
  assert.equal(dep.memoType, 'hash');
  assert.equal(dep.stellarTxHashes.length, 1);
  assert.match(dep.bankRef!, /^AR-[0-9A-Z]{8}-[0-9A-Z]$/);
  assert.equal(dep.customerRef, 'C1');
  assert.equal(wd.kind, 'withdrawal');
  assert.equal(wd.amountOut, 10000n);
  assert.equal(wd.memoType, 'id');
  assert.equal(wd.externalId, 'E2EAAAA0001');
  assert.equal(wd.customerRef, 'C2');
});

test('platform: SEP-31 receive, SEP-6 text memo, receiver customer and travel-rule ref', () => {
  const fx = loadFixture('memo');
  const [txt, hash, mux] = parsePlatformExport(fx.platform['2026-08-10']);
  assert.equal(txt.sep, 6);
  assert.equal(txt.memoType, 'text');
  assert.equal(txt.status, 'pending_anchor');
  assert.equal(hash.sep, 31);
  assert.equal(hash.kind, 'receive');
  assert.equal(hash.assetIn, 'USDC');
  assert.equal(hash.customerRef, 'C5', 'receiver, not the sending anchor customer');
  assert.equal(hash.travelRuleRef, 'TRP-ABCDEF123456');
  assert.equal(mux.memo, '900017');
});

test('platform: alternative JSON paths via a custom map, and errors', () => {
  const rec = { txid: 'x1', sep: 24, kind: 'withdrawal-exchange', status: 'pending_external', amount_in: { amount: '10.5', asset: 'stellar:EURC:G' }, amount_out: { amount: '10.00', asset: 'iso4217:EUR' }, fee_details: { total: '0.5', asset: 'stellar:EURC:G' }, started_at: '2026-08-10T00:00:00Z' };
  const p = normalisePlatformRecord(rec, { ...DEFAULT_PLATFORM_MAP, id: 'id|txid' });
  assert.equal(p.id, 'x1');
  assert.equal(p.kind, 'withdrawal');
  assert.equal(p.amountFee, 5_000_000n);
  assert.equal(getPath({ a: { b: '' }, c: 1 }, 'a.b|c'), 1, 'empty values fall through to the next path');
  assert.throws(() => normalisePlatformRecord({ sep: 24 }), /without id/);
  assert.throws(() => normalisePlatformRecord({ id: 'z', sep: 12, kind: 'deposit' }), /unsupported sep/);
  assert.throws(() => normalisePlatformRecord({ id: 'z', sep: 24, kind: 'swap' }), /unknown kind/);
  assert.throws(() => parsePlatformExport({ nope: 1 }), /JSON array/);
});

test('platform: seed exports contain exactly 400 transactions with the planned SEP mix', () => {
  const dir = join(SEED_DIR, 'platform');
  const seen = new Map<string, number>();
  for (const f of readdirSync(dir)) for (const p of parsePlatformExport(JSON.parse(readFileSync(join(dir, f), 'utf8')))) seen.set(p.id, p.sep);
  assert.equal(seen.size, 400);
  const bySep = [...seen.values()].reduce<Record<number, number>>((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {});
  assert.deepEqual(bySep, { 6: 60, 24: 180, 31: 160 });
});
