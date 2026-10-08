// Tree: leaves sorted by hash; node = sha256(0x01 ‖ left ‖ right); an odd node
// is promoted unchanged; the empty set has root sha256(0x00).

import { concat, fromHex, sha256, toHex } from '../core/hash.js';

export const EMPTY_ROOT = toHex(sha256(new Uint8Array([0])));

function node(l: Uint8Array, r: Uint8Array): Uint8Array {
  return sha256(concat(new Uint8Array([1]), l, r));
}

export function sortLeaves(hexes: string[]): string[] {
  return [...hexes].map((h) => h.toLowerCase()).sort();
}

export function merkleRoot(leafHexes: string[]): string {
  if (leafHexes.length === 0) return EMPTY_ROOT;
  let level = sortLeaves(leafHexes).map(fromHex);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? node(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return toHex(level[0]);
}

export interface ProofStep {
  side: 'L' | 'R'; // side of the sibling
  hash: string;
}

export function merkleProof(leafHexes: string[], target: string): ProofStep[] {
  let level = sortLeaves(leafHexes);
  let idx = level.indexOf(target.toLowerCase());
  if (idx < 0) throw new Error('leaf not in set');
  const proof: ProofStep[] = [];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? toHex(node(fromHex(level[i]), fromHex(level[i + 1]))) : level[i]);
    }
    if (idx % 2 === 0) {
      if (idx + 1 < level.length) proof.push({ side: 'R', hash: level[idx + 1] });
    } else {
      proof.push({ side: 'L', hash: level[idx - 1] });
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

export function verifyProof(leaf: string, proof: ProofStep[], root: string): boolean {
  let h = fromHex(leaf);
  for (const s of proof) {
    h = s.side === 'L' ? node(fromHex(s.hash), h) : node(h, fromHex(s.hash));
  }
  return toHex(h) === root.toLowerCase();
}
