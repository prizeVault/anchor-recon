// Leaf = sha256(0x00 ‖ salt16 ‖ JCS(canonical JSON)). Arrays are sorted so the
// same set always hashes the same way. Salts hide the leaf contents from
// anyone holding only a proof for a different leaf.

import { randomBytes } from 'node:crypto';
import { concat, jcs, sha256, sha256Hex, toHex, fromHex } from '../core/hash.js';
import type { Group, Method, ReconException } from '../types.js';

export interface LeafBody {
  groupId: string;
  kind: 'match' | 'exception';
  method: Method | 'rule';
  platformIds: string[];
  chainRefs: string[];
  bankRefs: string[];
  amounts: Record<string, string>;
  type?: string;
  subReason?: string;
  status?: string;
  decidedBy?: string;
}

export interface PackLeaf {
  salt: string; // 32 hex chars
  body: LeafBody;
  hash: string; // hex
}

export function canonicalLeafBody(b: LeafBody): LeafBody {
  return {
    ...b,
    platformIds: [...b.platformIds].sort(),
    chainRefs: [...b.chainRefs].sort(),
    bankRefs: [...b.bankRefs].sort(),
  };
}

export function leafHash(salt: Uint8Array, body: LeafBody): Uint8Array {
  if (salt.length !== 16) throw new Error('salt must be 16 bytes');
  return sha256(concat(new Uint8Array([0]), salt, new TextEncoder().encode(jcs(canonicalLeafBody(body)))));
}

export type SaltSource = (groupId: string) => Uint8Array;

/** Production salts: CSPRNG. */
export const cryptoSalt: SaltSource = () => new Uint8Array(randomBytes(16));

/** Test/simulation salts: derived from a fixed seed, day and group id. */
export function seededSalt(seed: string, day: string): SaltSource {
  return (groupId) => fromHex(sha256Hex(`salt|${seed}|${day}|${groupId}`)).slice(0, 16);
}

export function makeLeaf(body: LeafBody, salt: SaltSource): PackLeaf {
  const s = salt(body.groupId);
  const cb = canonicalLeafBody(body);
  return { salt: toHex(s), body: cb, hash: toHex(leafHash(s, cb)) };
}

export function groupLeafBody(g: Group): LeafBody {
  return {
    groupId: g.id,
    kind: 'match',
    method: g.method,
    platformIds: g.platformIds,
    chainRefs: g.chainRefs,
    bankRefs: g.bankLineIds,
    amounts: g.amounts,
    decidedBy: g.decidedBy,
  };
}

/** Opening leaf (immutable facts) or closing leaf (status, resolution, closer). */
export function exceptionLeafBody(e: ReconException, mode: 'open' | 'closed' = 'open'): LeafBody {
  const platformIds = e.evidenceIds.filter((id) => id.startsWith('ptx:')).map((id) => id.slice(4));
  const chainRefs = e.evidenceIds.filter((id) => id.startsWith('op:')).map((id) => id.slice(3));
  const bankRefs = e.evidenceIds.filter((id) => id.startsWith('bank:')).map((id) => id.slice(5));
  return {
    groupId: mode === 'open' ? e.id : `${e.id}#closed`,
    kind: 'exception',
    method: 'rule',
    platformIds,
    chainRefs,
    bankRefs,
    amounts: e.amount ? { amount: e.amount, currency: e.currency ?? '' } : {},
    type: e.type,
    subReason: e.subReason,
    status: mode === 'open' ? 'open' : `closed:${e.resolution ?? ''}`,
    decidedBy: mode === 'open' ? undefined : e.closedBy,
  };
}

export function verifyLeaf(l: PackLeaf): boolean {
  return toHex(leafHash(fromHex(l.salt), l.body)) === l.hash;
}
