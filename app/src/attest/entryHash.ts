// Entry hash, identical to recon_registry::entry_hash:
// sha256(prev ‖ day:u32be ‖ version:u32be ‖ root ‖ counts…:u32be ‖
//        shortfall:i128be ‖ report_hash ‖ signer_epoch:u32be ‖
//        attested_at:u64be ‖ late:u8 ‖ reason:u32be)

import { fromHex, sha256, toHex, concat } from '../core/hash.js';

export const COUNT_FIELDS = [
  'platform_txs',
  'chain_ops',
  'bank_lines',
  'matched_groups',
  'matched_rule',
  'matched_heuristic',
  'matched_llm',
  'matched_analyst',
  'exceptions_new',
  'exceptions_open',
  'exceptions_closed',
  'travel_rule_missing',
] as const;

export type Counts = Record<(typeof COUNT_FIELDS)[number], number>;

export const ZERO32 = '0'.repeat(64);

export function emptyCounts(): Counts {
  return Object.fromEntries(COUNT_FIELDS.map((f) => [f, 0])) as Counts;
}

function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`u32 out of range: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function u64(n: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

export function i128be(v: bigint): Uint8Array {
  const b = new Uint8Array(16);
  let x = BigInt.asUintN(128, v);
  for (let i = 15; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

export interface EntryInput {
  prev: string;
  day: number;
  version: number;
  root: string;
  counts: Counts;
  shortfall: bigint;
  reportHash: string;
  signerEpoch: number;
  attestedAt: number;
  late: boolean;
  reason: number;
}

export function entryHash(e: EntryInput): string {
  return toHex(
    sha256(
      concat(
        fromHex(e.prev),
        u32(e.day),
        u32(e.version),
        fromHex(e.root),
        ...COUNT_FIELDS.map((f) => u32(e.counts[f])),
        i128be(e.shortfall),
        fromHex(e.reportHash),
        u32(e.signerEpoch),
        u64(e.attestedAt),
        new Uint8Array([e.late ? 1 : 0]),
        u32(e.reason),
      ),
    ),
  );
}
