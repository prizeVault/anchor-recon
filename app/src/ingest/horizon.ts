// Horizon account-operations ingestion (`/accounts/{id}/operations?join=transactions`).
// Emits ChainOp for payment, path payments and claimable-balance create/claim.
// M-addresses are split into the base G-address and the muxed id. Amounts are
// 7-decimal strings converted to bigint. Offline source: fixtures in Horizon
// JSON shape. Horizon is nearing end-of-life and SDF's public instance keeps
// one year of history, so the tool keeps its own daily index (see ARCHITECTURE.md).

import { readFileSync } from 'node:fs';
import { StrKey } from '@stellar/stellar-sdk';
import { parseMoney } from '../core/money.js';
import type { ChainOp, ChainOpType } from '../types.js';

export interface ChainSource {
  name: string;
  operations(day: string): Promise<ChainOp[]>;
}

type Rec = Record<string, unknown>;

const TYPE_MAP: Record<string, ChainOpType> = {
  payment: 'payment',
  path_payment_strict_receive: 'path_payment',
  path_payment_strict_send: 'path_payment',
  create_claimable_balance: 'create_cb',
  claim_claimable_balance: 'claim_cb',
};

/** Splits an M-address into base G-address and id; returns G-addresses unchanged. */
export function splitMuxed(addr: string): { base: string; id?: string } {
  if (addr.startsWith('M')) {
    const raw = StrKey.decodeMed25519PublicKey(addr);
    const base = StrKey.encodeEd25519PublicKey(Buffer.from(raw.subarray(0, 32)));
    const id = Buffer.from(raw.subarray(32, 40)).readBigUInt64BE().toString();
    return { base, id };
  }
  return { base: addr };
}

export function makeMuxed(base: string, id: bigint | string): string {
  const raw = Buffer.alloc(40);
  Buffer.from(StrKey.decodeEd25519PublicKey(base)).copy(raw, 0);
  raw.writeBigUInt64BE(BigInt(id), 32);
  return StrKey.encodeMed25519PublicKey(raw);
}

function assetOf(r: Rec, prefix = ''): string {
  const t = r[`${prefix}asset_type`];
  if (t === 'native') return 'XLM';
  const code = r[`${prefix}asset_code`];
  if (typeof code === 'string') return code;
  const a = r['asset'];
  if (typeof a === 'string') return a === 'native' ? 'XLM' : a.split(':')[0];
  return 'UNKNOWN';
}

export function normaliseHorizonOp(r: Rec, anchorAccounts: string[]): ChainOp | undefined {
  const type = TYPE_MAP[String(r.type)];
  if (!type) return undefined;
  const tx = (r.transaction as Rec | undefined) ?? {};
  const created = String(r.created_at ?? tx.created_at ?? '');
  let from = String(r.from ?? r.source_account ?? '');
  let to = String(r.to ?? '');
  let muxedId: string | undefined;
  if (r.to_muxed) {
    const s = splitMuxed(String(r.to_muxed));
    to = s.base;
    muxedId = r.to_muxed_id !== undefined ? String(r.to_muxed_id) : s.id;
  } else if (to.startsWith('M')) {
    const s = splitMuxed(to);
    to = s.base;
    muxedId = s.id;
  }
  if (from.startsWith('M')) from = splitMuxed(from).base;
  let cbId: string | undefined;
  if (type === 'create_cb') {
    // Horizon puts the balance id on the effect, not the operation; the
    // fixture shape carries it as `balance_id` (verify-first item (d)).
    cbId = r.balance_id ? String(r.balance_id) : undefined;
    const claimants = (r.claimants as { destination: string }[] | undefined) ?? [];
    to = claimants[0]?.destination ?? '';
  }
  if (type === 'claim_cb') {
    cbId = String(r.balance_id ?? '');
    from = String(r.claimant ?? from);
    to = String(r.sponsor ?? '');
  }
  const amountStr = r.amount !== undefined ? String(r.amount) : '0';
  const asset = type === 'claim_cb' ? String(r.asset ?? 'UNKNOWN').split(':')[0] : assetOf(r);
  const account = anchorAccounts.find((a) => a === to || a === from) ?? '';
  const direction: 'in' | 'out' = anchorAccounts.includes(to) && !anchorAccounts.includes(from) ? 'in' : 'out';
  const memoType = tx.memo_type === 'text' || tx.memo_type === 'id' || tx.memo_type === 'hash' ? (tx.memo_type as 'text' | 'id' | 'hash') : undefined;
  return {
    opId: String(r.id),
    txHash: String(r.transaction_hash ?? tx.hash ?? ''),
    ledgerCloseTime: created,
    type,
    from,
    to,
    asset,
    amount: parseMoney(amountStr, 7),
    memo: memoType && tx.memo !== undefined ? String(tx.memo) : undefined,
    memoType,
    muxedId,
    cbId,
    account,
    direction,
    day: created.slice(0, 10),
  };
}

export function parseHorizonPage(json: unknown, anchorAccounts: string[]): ChainOp[] {
  const recs = ((json as { _embedded?: { records?: Rec[] } })?._embedded?.records ?? (Array.isArray(json) ? json : undefined)) as Rec[] | undefined;
  if (!recs) throw new Error('not a Horizon operations page');
  return recs.map((r) => normaliseHorizonOp(r, anchorAccounts)).filter((x): x is ChainOp => !!x);
}

export function readHorizonFile(path: string, anchorAccounts: string[]): ChainOp[] {
  return parseHorizonPage(JSON.parse(readFileSync(path, 'utf8')), anchorAccounts);
}

/** Online Horizon source (pages until the day is exhausted). Not exercised offline. */
export class HorizonSource implements ChainSource {
  readonly name = 'horizon';
  constructor(private readonly url: string, private readonly accounts: string[]) {}
  async operations(day: string): Promise<ChainOp[]> {
    const out: ChainOp[] = [];
    for (const acct of this.accounts) {
      let next: string | undefined = `${this.url.replace(/\/$/, '')}/accounts/${acct}/operations?join=transactions&order=desc&limit=200`;
      while (next) {
        const res = await fetch(next);
        if (!res.ok) throw new Error(`Horizon returned ${res.status}`);
        const page = (await res.json()) as { _embedded: { records: Rec[] }; _links: { next?: { href: string } } };
        const ops = parseHorizonPage(page, this.accounts);
        out.push(...ops.filter((o) => o.day === day));
        const oldest = page._embedded.records.at(-1)?.created_at as string | undefined;
        next = page._embedded.records.length && oldest && oldest.slice(0, 10) >= day ? page._links.next?.href : undefined;
      }
    }
    const seen = new Set<string>();
    return out.filter((o) => (seen.has(o.opId) ? false : (seen.add(o.opId), true)));
  }
}
