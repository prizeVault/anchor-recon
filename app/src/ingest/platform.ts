// Anchor Platform export ingestion through platform-map.json (JSON paths per
// field; "a|b" means first present). The field names in the default map are
// working assumptions for Anchor Platform 4.8.0 (verify-first item (a), see
// docs/ANCHOR-PLATFORM-MAPPING.md). The online path (GET /transactions) is
// provided but not exercised by tests.

import { readFileSync } from 'node:fs';
import { assetCode, decimalsOf, parseMoney } from '../core/money.js';
import type { Kind, PlatformTx, Sep } from '../types.js';

export type PlatformMap = Record<string, string>;

export const DEFAULT_PLATFORM_MAP: PlatformMap = {
  id: 'id',
  sep: 'sep',
  kind: 'kind',
  status: 'status',
  amountIn: 'amount_in.amount',
  assetIn: 'amount_in.asset',
  amountOut: 'amount_out.amount',
  assetOut: 'amount_out.asset',
  amountFee: 'amount_fee.amount|fee_details.total',
  assetFee: 'amount_fee.asset|fee_details.asset',
  memo: 'memo',
  memoType: 'memo_type',
  stellarTransactions: 'stellar_transactions',
  refundPayments: 'refunds.payments',
  claimableBalanceId: 'claimable_balance_id',
  externalId: 'external_transaction_id',
  bankRef: 'bank_ref',
  customerRef: 'customers.sender.id|customers.receiver.id',
  receiverRef: 'customers.receiver.id',
  travelRuleRef: 'travel_rule_ref',
  quoteId: 'quote_id',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  updatedAt: 'updated_at',
};

export function getPath(obj: unknown, path: string): unknown {
  for (const alt of path.split('|')) {
    let cur: unknown = obj;
    for (const part of alt.split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[part];
    }
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

const KIND_ALIASES: Record<string, Kind> = {
  deposit: 'deposit',
  'deposit-exchange': 'deposit',
  withdrawal: 'withdrawal',
  'withdrawal-exchange': 'withdrawal',
  receive: 'receive',
};

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

export function normalisePlatformRecord(raw: Record<string, unknown>, map: PlatformMap = DEFAULT_PLATFORM_MAP, asOf?: string): PlatformTx {
  const g = (k: string) => (map[k] ? getPath(raw, map[k]) : undefined);
  const id = str(g('id'));
  if (!id) throw new Error('platform record without id');
  const sepN = Number(g('sep'));
  if (![6, 24, 31].includes(sepN)) throw new Error(`platform ${id}: unsupported sep "${g('sep')}"`);
  const sep = sepN as Sep;
  const kindRaw = str(g('kind')) ?? (sep === 31 ? 'receive' : undefined);
  const kind = kindRaw ? KIND_ALIASES[kindRaw] : undefined;
  if (!kind) throw new Error(`platform ${id}: unknown kind "${kindRaw}"`);
  const assetIn = assetCode(str(g('assetIn')) ?? '');
  const assetOut = assetCode(str(g('assetOut')) ?? '');
  const assetFee = assetCode(str(g('assetFee')) ?? assetIn);
  const money = (k: string, asset: string) => {
    const v = str(g(k));
    return v === undefined ? 0n : parseMoney(v, decimalsOf(asset));
  };
  const stx = (g('stellarTransactions') as { id?: string }[] | undefined) ?? [];
  const refunds = (g('refundPayments') as { id?: string; id_type?: string }[] | undefined) ?? [];
  const memoTypeRaw = str(g('memoType'));
  const memoType = memoTypeRaw === 'text' || memoTypeRaw === 'id' || memoTypeRaw === 'hash' ? memoTypeRaw : undefined;
  const onChain = kind === 'deposit' ? assetOut : assetIn;
  const fiat = kind === 'deposit' ? assetIn : assetOut;
  const customerRef = kind === 'deposit' ? str(getPath(raw, 'customers.sender.id')) ?? str(g('customerRef')) : str(g('receiverRef')) ?? str(g('customerRef'));
  return {
    id,
    sep,
    kind,
    status: str(g('status')) ?? 'unknown',
    amountIn: money('amountIn', assetIn),
    assetIn,
    amountOut: money('amountOut', assetOut),
    assetOut,
    amountFee: money('amountFee', assetFee),
    assetFee,
    assetOnChain: onChain,
    assetFiat: fiat,
    memo: str(g('memo')),
    memoType,
    stellarTxHashes: stx.map((s) => String(s.id)).filter(Boolean),
    refundTxHashes: refunds.filter((r) => !r.id_type || r.id_type === 'stellar').map((r) => String(r.id)).filter(Boolean),
    claimableBalanceId: str(g('claimableBalanceId')),
    externalId: str(g('externalId')),
    bankRef: str(g('bankRef')),
    customerRef,
    travelRuleRef: str(g('travelRuleRef')),
    quoteId: str(g('quoteId')),
    startedAt: str(g('startedAt')) ?? '',
    completedAt: str(g('completedAt')),
    updatedAt: str(g('updatedAt')),
    asOf,
  };
}

export function parsePlatformExport(json: unknown, map?: PlatformMap, asOf?: string): PlatformTx[] {
  const arr = Array.isArray(json) ? json : (json as { records?: unknown[]; transactions?: unknown[] })?.records ?? (json as { transactions?: unknown[] })?.transactions;
  if (!Array.isArray(arr)) throw new Error('platform export must be a JSON array (or {records|transactions: []})');
  return arr.map((r) => normalisePlatformRecord(r as Record<string, unknown>, map, asOf));
}

export function readPlatformFile(path: string, map?: PlatformMap, asOf?: string): PlatformTx[] {
  return parsePlatformExport(JSON.parse(readFileSync(path, 'utf8')), map, asOf);
}

/** Online path: GET {ANCHOR_PLATFORM_URL}/transactions?sep=… (not exercised offline). */
export async function fetchPlatform(baseUrl: string, token: string, sep: Sep, map?: PlatformMap): Promise<PlatformTx[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/transactions?sep=${sep}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Anchor Platform returned ${res.status}`);
  return parsePlatformExport(await res.json(), map);
}
