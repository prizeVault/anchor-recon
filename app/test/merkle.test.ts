import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../src/core/hash.js';
import { EMPTY_ROOT, merkleProof, merkleRoot, verifyProof } from '../src/attest/merkle.js';
import { leafHash, makeLeaf, seededSalt, verifyLeaf, type LeafBody } from '../src/attest/leaf.js';
import { jcs } from '../src/core/hash.js';
import { readJson } from './helpers.js';
import type { MerkleVector } from '../src/attest/vectors.js';

test('merkle: shared vectors (also checked by the Rust tests)', () => {
  const vs = readJson<MerkleVector[]>('test/vectors/merkle.json');
  assert.ok(vs.length >= 5);
  for (const v of vs) assert.equal(merkleRoot(v.leaves), v.root, v.name);
});

test('merkle: empty root is sha256(0x00); single leaf is its own root; order-independent', () => {
  assert.equal(EMPTY_ROOT, sha256Hex(new Uint8Array([0])));
  assert.equal(merkleRoot([]), EMPTY_ROOT);
  const a = sha256Hex('a');
  assert.equal(merkleRoot([a]), a);
  const xs = ['1', '2', '3', '4', '5'].map((x) => sha256Hex(x));
  assert.equal(merkleRoot(xs), merkleRoot([...xs].reverse()));
});

test('merkle: inclusion proofs for every leaf at odd and even counts', () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const xs = Array.from({ length: n }, (_, i) => sha256Hex(`leaf${i}`));
    const root = merkleRoot(xs);
    for (const x of xs) assert.ok(verifyProof(x, merkleProof(xs, x), root), `n=${n}`);
  }
  assert.throws(() => merkleProof([sha256Hex('a')], sha256Hex('b')), /not in set/);
});

test('merkle: a tampered leaf or path fails', () => {
  const xs = Array.from({ length: 6 }, (_, i) => sha256Hex(`t${i}`));
  const root = merkleRoot(xs);
  const p = merkleProof(xs, xs[2]);
  assert.equal(verifyProof(sha256Hex('evil'), p, root), false);
  const bad = p.map((s, i) => (i === 0 ? { ...s, hash: sha256Hex('x') } : s));
  assert.equal(verifyProof(xs[2], bad, root), false);
});

test('leaf: salted JCS canonical hash; arrays sorted; body change detected', () => {
  const body: LeafBody = { groupId: 'G1', kind: 'match', method: 'rule', platformIds: ['b', 'a'], chainRefs: [], bankRefs: ['y', 'x'], amounts: { bank: '100' } };
  const salt = seededSalt('s', '2026-08-10');
  const l = makeLeaf(body, salt);
  assert.deepEqual(l.body.platformIds, ['a', 'b']);
  assert.ok(verifyLeaf(l));
  assert.equal(makeLeaf(body, salt).hash, l.hash, 'deterministic for a seeded salt');
  assert.notEqual(makeLeaf(body, seededSalt('s', '2026-08-11')).hash, l.hash, 'salt changes the hash');
  assert.equal(verifyLeaf({ ...l, body: { ...l.body, amounts: { bank: '101' } } }), false);
  assert.throws(() => leafHash(new Uint8Array(15), body), /16 bytes/);
  assert.equal(jcs({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => jcs({ x: 1.5 }), /non-integer/);
});
