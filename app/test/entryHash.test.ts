import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryHash, i128be, COUNT_FIELDS, emptyCounts } from '../src/attest/entryHash.js';
import { makeEntryVectors, type EntryVector } from '../src/attest/vectors.js';
import { RegistryModel, verifyChain, RegistryError } from '../src/attest/registryModel.js';
import { readJson } from './helpers.js';

function fromVector(v: EntryVector) {
  const counts = emptyCounts();
  COUNT_FIELDS.forEach((f, i) => (counts[f] = v.counts[i]));
  return { ...v, counts, shortfall: BigInt(v.shortfall) };
}

test('entry hash: shared vectors (the Rust tests read the same file)', () => {
  const vs = readJson<EntryVector[]>('test/vectors/entry-hash.json');
  assert.ok(vs.length >= 4);
  for (const v of vs) assert.equal(entryHash(fromVector(v)), v.expected, v.name);
  assert.deepEqual(makeEntryVectors(), vs, 'committed vectors equal the generator output');
});

test('entry hash: i128 big-endian two-complement encoding', () => {
  assert.equal(Buffer.from(i128be(1n)).toString('hex'), '0'.repeat(31) + '1');
  assert.equal(Buffer.from(i128be(-1n)).toString('hex'), 'f'.repeat(32));
  assert.equal(Buffer.from(i128be(341250n)).toString('hex'), '0'.repeat(26) + '053502');
});

test('registry model: chain of attest + restate reproduces head; tampering breaks it', () => {
  const m = new RegistryModel();
  m.now = 20668 * 86400 + 7 * 3600;
  m.init('ADMIN', 'S0', 20668, 31, 43200, 'EUR', 2, 'sim-anchor.example');
  const c = emptyCounts();
  m.now = 20668 * 86400 + 18 * 3600;
  m.attest('S0', 20668, 'aa'.repeat(32), c, 0n, 'bb'.repeat(32));
  m.now += 3600;
  m.restate('S0', 20668, 'cc'.repeat(32), c, 0n, 'bb'.repeat(32), 1);
  const exp = m.export();
  const v = verifyChain(exp.attestations);
  assert.equal(v.ok, true);
  assert.equal(v.head, exp.head.hash);
  const tampered = exp.attestations.map((a, i) => (i === 0 ? { ...a, shortfall: '1' } : a));
  assert.equal(verifyChain(tampered).ok, false);
  assert.throws(() => m.attest('S0', 20668, 'aa'.repeat(32), c, 0n, 'bb'.repeat(32)), (e: unknown) => e instanceof RegistryError && e.code === 'AlreadyAttested');
  assert.throws(() => m.attest('S0', 20669, 'aa'.repeat(32), c, -1n, 'bb'.repeat(32)), /FutureDay/);
  assert.throws(() => m.attest('S0', 20668 - 1, 'aa'.repeat(32), c, 0n, 'bb'.repeat(32)), /BeforeStart/);
  assert.throws(() => m.attest('OTHER', 20668, 'aa'.repeat(32), c, 0n, 'bb'.repeat(32)), /auth/);
  const bad = { ...c, matched_groups: 1 };
  m.now = 20669 * 86400 + 18 * 3600;
  assert.throws(() => m.attest('S0', 20669, 'aa'.repeat(32), bad, 0n, 'bb'.repeat(32)), /InvalidCounts/);
});
