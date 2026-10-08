// Day pack: salted leaves, root, figures and report hash. Kept private by the
// anchor (48 h retrievable under CASS 15); only the root goes on-chain.

import type { ReconState } from '../store/store.js';
import { type Counts } from './entryHash.js';
import { exceptionLeafBody, groupLeafBody, makeLeaf, verifyLeaf, type PackLeaf, type SaltSource } from './leaf.js';
import { merkleProof, merkleRoot, verifyProof, type ProofStep } from './merkle.js';
import { dayCounts } from '../report/figures.js';

export interface Pack {
  format: 'anchor-recon-pack/1';
  day: string;
  version: number;
  root: string;
  leaves: PackLeaf[];
  counts: Counts;
  shortfall: string;
  figuresHash: string;
  reportHash: string;
}

export function dayLeaves(state: ReconState, day: string, salt: SaltSource): PackLeaf[] {
  const leaves: PackLeaf[] = [];
  for (const g of state.groups.filter((x) => x.day === day)) leaves.push(makeLeaf(groupLeafBody(g), salt));
  for (const e of state.exceptions.filter((x) => x.openedOn === day)) leaves.push(makeLeaf(exceptionLeafBody(e, 'open'), salt));
  for (const e of state.exceptions.filter((x) => x.closedOn === day)) leaves.push(makeLeaf(exceptionLeafBody(e, 'closed'), salt));
  return leaves.sort((a, b) => (a.hash < b.hash ? -1 : 1));
}

export function buildPack(state: ReconState, day: string, version: number, salt: SaltSource, shortfall: string, figuresHash: string, reportHash: string): Pack {
  const leaves = dayLeaves(state, day, salt);
  return {
    format: 'anchor-recon-pack/1',
    day,
    version,
    root: merkleRoot(leaves.map((l) => l.hash)),
    leaves,
    counts: dayCounts(state, day),
    shortfall,
    figuresHash,
    reportHash,
  };
}

export interface PackCheck {
  ok: boolean;
  root: string;
  errors: string[];
}

/** Recomputes every leaf hash from salt + body and the root from the leaves. */
export function verifyPack(pack: Pack, expectedRoot?: string): PackCheck {
  const errors: string[] = [];
  for (const l of pack.leaves) if (!verifyLeaf(l)) errors.push(`leaf ${l.body.groupId} does not hash to ${l.hash}`);
  const root = merkleRoot(pack.leaves.map((l) => l.hash));
  if (root !== pack.root) errors.push(`pack root ${pack.root} != recomputed ${root}`);
  if (expectedRoot && root !== expectedRoot.toLowerCase()) errors.push(`registry root ${expectedRoot} != recomputed ${root}`);
  return { ok: errors.length === 0, root, errors };
}

export interface InclusionProof {
  format: 'anchor-recon-proof/1';
  day: string;
  version: number;
  root: string;
  leaf: PackLeaf;
  proof: ProofStep[];
}

export function proofFor(pack: Pack, platformTxId: string): InclusionProof[] {
  const hashes = pack.leaves.map((l) => l.hash);
  return pack.leaves
    .filter((l) => l.body.platformIds.includes(platformTxId))
    .map((leaf) => ({ format: 'anchor-recon-proof/1', day: pack.day, version: pack.version, root: pack.root, leaf, proof: merkleProof(hashes, leaf.hash) }));
}

export function verifyInclusion(p: InclusionProof, platformTxId: string, registryRoot?: string): PackCheck {
  const errors: string[] = [];
  if (!verifyLeaf(p.leaf)) errors.push('leaf body does not hash to the leaf hash');
  if (!p.leaf.body.platformIds.includes(platformTxId)) errors.push(`leaf does not name ${platformTxId}`);
  if (!verifyProof(p.leaf.hash, p.proof, p.root)) errors.push('Merkle path does not reach the root');
  if (registryRoot && registryRoot.toLowerCase() !== p.root.toLowerCase()) errors.push('root differs from the registry');
  return { ok: errors.length === 0, root: p.root, errors };
}
