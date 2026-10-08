// Shared test vectors for the entry hash and the Merkle tree. Written to
// app/test/vectors/*.json by `recon vectors` and read by both `node --test`
// and the Rust tests (include_str!), so the two implementations are checked
// against the same bytes.

import { sha256Hex } from '../core/hash.js';
import { emptyCounts, entryHash, type Counts, COUNT_FIELDS, ZERO32 } from './entryHash.js';
import { merkleRoot, sortLeaves } from './merkle.js';

export interface EntryVector {
  name: string;
  prev: string;
  day: number;
  version: number;
  root: string;
  counts: number[];
  shortfall: string;
  reportHash: string;
  signerEpoch: number;
  attestedAt: number;
  late: boolean;
  reason: number;
  expected: string;
}

function countsFrom(arr: number[]): Counts {
  const c = emptyCounts();
  COUNT_FIELDS.forEach((f, i) => (c[f] = arr[i]));
  return c;
}

export function makeEntryVectors(): EntryVector[] {
  const base = {
    day: 20668,
    root: sha256Hex('root|2026-08-03'),
    counts: [19, 20, 23, 36, 33, 2, 0, 1, 1, 2, 0, 0],
    shortfall: '0',
    reportHash: sha256Hex('report|2026-08-03'),
    signerEpoch: 0,
  };
  const out: EntryVector[] = [];
  const v0 = { name: 'genesis-attest', prev: ZERO32, version: 0, attestedAt: 20668 * 86400 + 64800, late: false, reason: 0, ...base };
  out.push({ ...v0, expected: entryHash({ ...v0, counts: countsFrom(v0.counts), shortfall: 0n }) });
  const v1 = {
    ...base,
    name: 'restate-late-bank-item',
    prev: out[0].expected,
    version: 1,
    root: sha256Hex('root|2026-08-03|v1'),
    attestedAt: 20669 * 86400 + 36000,
    late: false,
    reason: 1,
  };
  out.push({ ...v1, expected: entryHash({ ...v1, counts: countsFrom(v1.counts), shortfall: 0n }) });
  const v2 = {
    name: 'shortfall-late-epoch1',
    prev: out[1].expected,
    day: 20683,
    version: 0,
    root: sha256Hex('root|2026-08-18'),
    counts: [21, 22, 26, 40, 36, 3, 0, 1, 2, 3, 1, 1],
    shortfall: '341250',
    reportHash: sha256Hex('report|2026-08-18'),
    signerEpoch: 1,
    attestedAt: 20684 * 86400 + 50000,
    late: true,
    reason: 0,
  };
  out.push({ ...v2, expected: entryHash({ ...v2, counts: countsFrom(v2.counts), shortfall: 341250n }) });
  const v3 = {
    name: 'max-values',
    prev: sha256Hex('prev'),
    day: 0xffffffff,
    version: 15,
    root: 'ff'.repeat(32),
    counts: new Array(12).fill(0xffffffff),
    shortfall: ((1n << 127n) - 1n).toString(),
    reportHash: '00'.repeat(32),
    signerEpoch: 0xffffffff,
    attestedAt: 2 ** 53 - 1,
    late: true,
    reason: 4,
  };
  out.push({ ...v3, expected: entryHash({ ...v3, counts: countsFrom(v3.counts), shortfall: BigInt(v3.shortfall) }) });
  return out;
}

export interface MerkleVector {
  name: string;
  leaves: string[];
  root: string;
}

export function makeMerkleVectors(): MerkleVector[] {
  const leaf = (i: number) => sha256Hex(`leaf-${i}`);
  const sets: [string, number][] = [
    ['empty', 0],
    ['one', 1],
    ['two', 2],
    ['three-odd', 3],
    ['five-odd', 5],
    ['eight', 8],
  ];
  return sets.map(([name, n]) => {
    const leaves = sortLeaves(Array.from({ length: n }, (_, i) => leaf(i)));
    return { name, leaves, root: merkleRoot(leaves) };
  });
}
