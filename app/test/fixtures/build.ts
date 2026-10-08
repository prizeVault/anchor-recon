// Builds the matcher fixtures (exact, memo, cb, dup, split, fee-diff, fx-diff,
// reversal, truncated, orphan) in source shapes: Anchor Platform records,
// Horizon operation records and bank lines. Run `npm run fixtures` to rewrite
// test/fixtures/*.json. All values are simulated.

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';
import { sha256, sha256Hex } from '../../src/core/hash.js';
import { makeBankRef } from '../../src/core/reference.js';
import { makeMuxed } from '../../src/ingest/horizon.js';
import { ACCOUNTS } from '../../src/seed/generate.js';

export interface FixtureLine {
  id: string;
  account: string;
  direction: 'credit' | 'debit';
  amount: string;
  valueDate: string;
  narrative: string;
  counterparty?: string;
  endToEndId?: string;
  charges?: string;
  reversal?: boolean;
}

export interface Fixture {
  name: string;
  days: string[];
  customers: { id: string; name: string }[];
  platform: Record<string, Record<string, unknown>[]>; // day -> records
  chain: Record<string, Record<string, unknown>[]>; // day -> horizon records
  bank: Record<string, FixtureLine[]>; // day -> lines
  expect: Record<string, unknown>;
}

export const user = (n: string) => Keypair.fromRawEd25519Seed(Buffer.from(sha256(`fixture-user|${n}`))).publicKey();
export const partner = Keypair.fromRawEd25519Seed(Buffer.from(sha256('fixture-partner'))).publicKey();
export const stranger = Keypair.fromRawEd25519Seed(Buffer.from(sha256('fixture-stranger'))).publicKey();
export const txh = (l: string) => sha256Hex(`fixture-tx|${l}`);
let opSeq = 1;
const opId = () => ((58_100_000n << 32n) | (BigInt(opSeq++) << 12n) | 1n).toString();

export function ptx(p: {
  id: string;
  sep: number;
  kind: string;
  status: string;
  inAmt: string;
  inAsset: string;
  outAmt: string;
  outAsset: string;
  fee?: string;
  memo?: string;
  memoType?: string;
  stx?: string[];
  external?: string;
  cb?: string;
  customer: string;
  started: string;
  completed?: string;
  refunds?: string[];
  tr?: string;
}): Record<string, unknown> {
  const a = (code: string) => (code === 'EUR' ? 'iso4217:EUR' : `stellar:${code}:${ACCOUNTS.issuer}`);
  return {
    id: p.id,
    sep: String(p.sep),
    kind: p.kind,
    status: p.status,
    amount_in: { amount: p.inAmt, asset: a(p.inAsset) },
    amount_out: { amount: p.outAmt, asset: a(p.outAsset) },
    amount_fee: { amount: p.fee ?? '1.00', asset: a(p.kind === 'deposit' ? 'EUR' : p.inAsset) },
    started_at: `${p.started}T09:00:00Z`,
    completed_at: p.completed ? `${p.completed}T15:00:00Z` : undefined,
    updated_at: `${p.completed ?? p.started}T15:00:00Z`,
    memo: p.memo,
    memo_type: p.memoType,
    stellar_transactions: (p.stx ?? []).map((id) => ({ id, memo: p.memo, memo_type: p.memoType, payments: [] })),
    external_transaction_id: p.external,
    claimable_balance_id: p.cb,
    bank_ref: makeBankRef(p.id),
    customers: p.kind === 'receive' ? { sender: { id: 'EXT-1' }, receiver: { id: p.customer } } : { sender: { id: p.customer } },
    refunds: p.refunds ? { payments: p.refunds.map((id) => ({ id, id_type: 'stellar' })) } : undefined,
    travel_rule_ref: p.tr,
  };
}

export function op(p: { label: string; day: string; from: string; to: string; code: string; amount: string; memo?: { type: string; value: string }; type?: string; toMuxedId?: string; balanceId?: string; claimant?: string }): Record<string, unknown> {
  const id = opId();
  const hash = txh(p.label);
  const memo = p.memo ? { memo_type: p.memo.type, memo: p.memo.type === 'hash' ? Buffer.from(p.memo.value, 'hex').toString('base64') : p.memo.value } : { memo_type: 'none' };
  const base: Record<string, unknown> = {
    id,
    paging_token: id,
    transaction_successful: true,
    created_at: `${p.day}T12:00:00Z`,
    transaction_hash: hash,
    type: p.type ?? 'payment',
    source_account: p.from,
    transaction: { hash, created_at: `${p.day}T12:00:00Z`, ...memo },
  };
  if ((p.type ?? 'payment') === 'payment') Object.assign(base, { from: p.from, to: p.to, asset_type: 'credit_alphanum4', asset_code: p.code, asset_issuer: ACCOUNTS.issuer, amount: p.amount });
  if (p.toMuxedId) Object.assign(base, { to_muxed: makeMuxed(p.to, BigInt(p.toMuxedId)), to_muxed_id: p.toMuxedId });
  if (p.type === 'create_claimable_balance') Object.assign(base, { asset: `${p.code}:${ACCOUNTS.issuer}`, amount: p.amount, claimants: [{ destination: p.to, predicate: { unconditional: true } }], balance_id: p.balanceId });
  if (p.type === 'claim_claimable_balance') Object.assign(base, { balance_id: p.balanceId, claimant: p.claimant, sponsor: ACCOUNTS.distribution, asset: `${p.code}:${ACCOUNTS.issuer}` });
  return base;
}

const D1 = '2026-08-10';
const D2 = '2026-08-11';
const D3 = '2026-08-12';
const customers = [
  { id: 'C1', name: 'José Luis Pérez García' },
  { id: 'C2', name: 'Małgorzata Wiśniewska' },
  { id: 'C3', name: 'Chukwuemeka Obinna Nwankwo-Eze Okafor' },
  { id: 'C4', name: 'Aoife Fitzgerald' },
  { id: 'C5', name: 'Søren Østergaard' },
];

export function buildFixtures(): Fixture[] {
  opSeq = 1;
  const out: Fixture[] = [];
  const DIST = ACCOUNTS.distribution;
  const RECV = ACCOUNTS.receive;

  // exact: tx hash, AR token, E2E id, memo id
  {
    const depHash = txh('exact-dep');
    const depMemo = sha256Hex('tx-exact-dep');
    out.push({
      name: 'exact',
      days: [D1],
      customers,
      platform: {
        [D1]: [
          ptx({ id: 'tx-exact-dep', sep: 24, kind: 'deposit', status: 'completed', inAmt: '250.00', inAsset: 'EUR', outAmt: '248.75', outAsset: 'EURC', fee: '1.25', memo: depMemo, memoType: 'hash', stx: [depHash], customer: 'C1', started: D1, completed: D1 }),
          ptx({ id: 'tx-exact-wd', sep: 24, kind: 'withdrawal', status: 'completed', inAmt: '101.00', inAsset: 'EURC', outAmt: '100.00', outAsset: 'EUR', memo: '4401', memoType: 'id', external: 'E2EAAAA0001', customer: 'C2', started: D1, completed: D1 }),
        ],
      },
      chain: {
        [D1]: [
          { ...op({ label: 'exact-dep', day: D1, from: DIST, to: user('C1'), code: 'EURC', amount: '248.7500000', memo: { type: 'hash', value: depMemo } }) },
          op({ label: 'exact-wd', day: D1, from: user('C2'), to: RECV, code: 'EURC', amount: '101.0000000', memo: { type: 'id', value: '4401' } }),
        ],
      },
      bank: {
        [D1]: [
          { id: 'A:1', account: 'bank-a', direction: 'credit', amount: '25000', valueDate: D1, narrative: `${makeBankRef('tx-exact-dep')} JOSE LUIS PEREZ GARCIA`, counterparty: 'JOSE LUIS PEREZ GARCIA' },
          { id: 'B:1', account: 'bank-b', direction: 'debit', amount: '10000', valueDate: D1, narrative: 'SEPA CT MALGORZATA WISNIEWSKA', endToEndId: 'E2EAAAA0001' },
        ],
      },
      expect: { rules: ['tx_hash', 'ar_token', 'e2e_id', 'memo'] },
    });
  }

  // memo: text memo, hash memo hex on platform vs base64 on chain, muxed id
  {
    const hm = sha256Hex('memo-hash-receive');
    out.push({
      name: 'memo',
      days: [D1],
      customers,
      platform: {
        [D1]: [
          ptx({ id: 'tx-memo-text', sep: 6, kind: 'withdrawal', status: 'pending_anchor', inAmt: '51.00', inAsset: 'EURC', outAmt: '50.00', outAsset: 'EUR', memo: 'WD12345', memoType: 'text', customer: 'C4', started: D1 }),
          ptx({ id: 'tx-memo-hash', sep: 31, kind: 'receive', status: 'pending_receiver', inAmt: '300.00', inAsset: 'USDC', outAmt: '271.23', outAsset: 'EUR', memo: hm, memoType: 'hash', customer: 'C5', started: D1, tr: 'TRP-ABCDEF123456' }),
          ptx({ id: 'tx-memo-mux', sep: 31, kind: 'receive', status: 'pending_receiver', inAmt: '120.00', inAsset: 'USDC', outAmt: '108.50', outAsset: 'EUR', memo: '900017', memoType: 'id', customer: 'C1', started: D1, tr: 'TRP-ABCDEF654321' }),
        ],
      },
      chain: {
        [D1]: [
          op({ label: 'memo-text', day: D1, from: user('C4'), to: RECV, code: 'EURC', amount: '51.0000000', memo: { type: 'text', value: 'WD12345' } }),
          op({ label: 'memo-hash', day: D1, from: partner, to: RECV, code: 'USDC', amount: '300.0000000', memo: { type: 'hash', value: hm } }),
          op({ label: 'memo-mux', day: D1, from: partner, to: RECV, code: 'USDC', amount: '120.0000000', toMuxedId: '900017' }),
        ],
      },
      bank: {},
      expect: { rules: ['memo', 'memo', 'muxed_id'] },
    });
  }

  // cb: claimable-balance delivery and claim
  {
    const bal = '00000000' + sha256Hex('fixture-cb');
    out.push({
      name: 'cb',
      days: [D1, D2],
      customers,
      platform: { [D1]: [ptx({ id: 'tx-cb', sep: 6, kind: 'deposit', status: 'completed', inAmt: '80.00', inAsset: 'EUR', outAmt: '79.00', outAsset: 'EURC', memo: sha256Hex('tx-cb'), memoType: 'hash', cb: bal, customer: 'C4', started: D1, completed: D1 })] },
      chain: {
        [D1]: [op({ label: 'cb-create', day: D1, from: DIST, to: user('C4'), code: 'EURC', amount: '79.0000000', type: 'create_claimable_balance', balanceId: bal })],
        [D2]: [op({ label: 'cb-claim', day: D2, from: user('C4'), to: DIST, code: 'EURC', amount: '0', type: 'claim_claimable_balance', balanceId: bal, claimant: user('C4') })],
      },
      bank: { [D1]: [{ id: 'A:cb', account: 'bank-a', direction: 'credit', amount: '8000', valueDate: D1, narrative: `${makeBankRef('tx-cb')} AOIFE FITZGERALD`, counterparty: 'AOIFE FITZGERALD' }] },
      expect: { rules: ['cb_id', 'ar_token', 'cb_claim'] },
    });
  }

  // dup: duplicate chain payment and duplicate payout
  {
    const m = sha256Hex('tx-dup-dep');
    out.push({
      name: 'dup',
      days: [D1],
      customers,
      platform: {
        [D1]: [
          ptx({ id: 'tx-dup-dep', sep: 6, kind: 'deposit', status: 'completed', inAmt: '400.00', inAsset: 'EUR', outAmt: '398.00', outAsset: 'EURC', fee: '2.00', memo: m, memoType: 'hash', stx: [txh('dup-1')], customer: 'C2', started: D1, completed: D1 }),
          ptx({ id: 'tx-dup-pay', sep: 31, kind: 'receive', status: 'completed', inAmt: '500.00', inAsset: 'USDC', outAmt: '455.10', outAsset: 'EUR', memo: 'S31-77', memoType: 'text', external: 'E2EDUP0001', customer: 'C3', started: D1, completed: D1, tr: 'TRP-000000000001' }),
        ],
      },
      chain: {
        [D1]: [
          op({ label: 'dup-1', day: D1, from: DIST, to: user('C2'), code: 'EURC', amount: '398.0000000', memo: { type: 'hash', value: m } }),
          op({ label: 'dup-2', day: D1, from: DIST, to: user('C2'), code: 'EURC', amount: '398.0000000', memo: { type: 'hash', value: m } }),
          op({ label: 'dup-pay-in', day: D1, from: partner, to: RECV, code: 'USDC', amount: '500.0000000', memo: { type: 'text', value: 'S31-77' } }),
        ],
      },
      bank: {
        [D1]: [
          { id: 'A:dup', account: 'bank-a', direction: 'credit', amount: '40000', valueDate: D1, narrative: `${makeBankRef('tx-dup-dep')} MALGORZATA WISNIEWSKA`, counterparty: 'MALGORZATA WISNIEWSKA' },
          { id: 'B:dup1', account: 'bank-b', direction: 'debit', amount: '45510', valueDate: D1, narrative: 'SEPA CT CHUKWUEMEKA OKAFOR', endToEndId: 'E2EDUP0001' },
          { id: 'B:dup2', account: 'bank-b', direction: 'debit', amount: '45510', valueDate: D1, narrative: 'SEPA CT CHUKWUEMEKA OKAFOR', endToEndId: 'E2EDUP0001' },
        ],
      },
      expect: { exceptions: ['DUPLICATE_CHAIN_PAYMENT', 'DUPLICATE_PAYOUT'] },
    });
  }

  // split: 2 lines same day, 3 lines over 2 business days
  out.push({
    name: 'split',
    days: [D1, D2],
    customers,
    platform: {
      [D1]: [
        ptx({ id: 'tx-split-2', sep: 24, kind: 'deposit', status: 'pending_anchor', inAmt: '1000.00', inAsset: 'EUR', outAmt: '995.00', outAsset: 'EURC', fee: '5.00', customer: 'C1', started: D1 }),
        ptx({ id: 'tx-split-3', sep: 24, kind: 'deposit', status: 'pending_user_transfer_start', inAmt: '900.00', inAsset: 'EUR', outAmt: '895.50', outAsset: 'EURC', fee: '4.50', customer: 'C2', started: D1 }),
      ],
    },
    chain: {},
    bank: {
      [D1]: [
        { id: 'A:s1', account: 'bank-a', direction: 'credit', amount: '40000', valueDate: D1, narrative: `${makeBankRef('tx-split-2')} PART 1`, counterparty: 'PEREZ GARCIA JOSE LUIS' },
        { id: 'A:s2', account: 'bank-a', direction: 'credit', amount: '60000', valueDate: D1, narrative: 'PART 2 PEREZ GARCIA JOSE LUIS', counterparty: 'PEREZ GARCIA JOSE LUIS' },
        { id: 'A:t1', account: 'bank-a', direction: 'credit', amount: '30000', valueDate: D1, narrative: `${makeBankRef('tx-split-3')} PART 1`, counterparty: 'M WISNIEWSKA' },
        { id: 'A:t2', account: 'bank-a', direction: 'credit', amount: '25000', valueDate: D1, narrative: 'PART 2', counterparty: 'M WISNIEWSKA' },
      ],
      [D2]: [{ id: 'A:t3', account: 'bank-a', direction: 'credit', amount: '35000', valueDate: D2, narrative: 'PART 3', counterparty: 'M WISNIEWSKA' }],
    },
    expect: { splits: { 'tx-split-2': ['A:s1', 'A:s2'], 'tx-split-3': ['A:t1', 'A:t2', 'A:t3'] } },
  });

  // fee-diff: 0.35 listed charge inside schedule vs 0.50 unlisted
  out.push({
    name: 'fee-diff',
    days: [D1, D2],
    customers,
    platform: {
      [D1]: [
        ptx({ id: 'tx-fee-in', sep: 24, kind: 'deposit', status: 'completed', inAmt: '500.00', inAsset: 'EUR', outAmt: '497.50', outAsset: 'EURC', fee: '2.50', customer: 'C4', started: D1, completed: D1 }),
        ptx({ id: 'tx-fee-out', sep: 24, kind: 'deposit', status: 'completed', inAmt: '700.00', inAsset: 'EUR', outAmt: '696.50', outAsset: 'EURC', fee: '3.50', customer: 'C5', started: D1, completed: D1 }),
      ],
    },
    chain: {},
    bank: {
      [D1]: [
        { id: 'A:f1', account: 'bank-a', direction: 'credit', amount: '49965', valueDate: D1, narrative: `${makeBankRef('tx-fee-in')} AOIFE FITZGERALD`, counterparty: 'AOIFE FITZGERALD', charges: '35' },
        { id: 'A:f2', account: 'bank-a', direction: 'credit', amount: '69950', valueDate: D1, narrative: `${makeBankRef('tx-fee-out')} SOREN OSTERGAARD`, counterparty: 'SOREN OSTERGAARD' },
      ],
    },
    expect: { proposal: 'tx-fee-in', mismatch: 'tx-fee-out' },
  });

  // fx-diff: 49 bps inside the band, 51 bps outside
  out.push({
    name: 'fx-diff',
    days: [D1, D2],
    customers,
    platform: {
      [D1]: [
        ptx({ id: 'tx-fx-49', sep: 31, kind: 'receive', status: 'completed', inAmt: '1100.00', inAsset: 'USDC', outAmt: '1000.00', outAsset: 'EUR', external: 'E2EFX49', customer: 'C3', started: D1, completed: D1, tr: 'TRP-FFFFFFFFFFF1' }),
        ptx({ id: 'tx-fx-51', sep: 31, kind: 'receive', status: 'completed', inAmt: '2200.00', inAsset: 'USDC', outAmt: '2000.00', outAsset: 'EUR', external: 'E2EFX51', customer: 'C1', started: D1, completed: D1, tr: 'TRP-FFFFFFFFFFF2' }),
      ],
    },
    chain: {},
    bank: {
      [D1]: [
        { id: 'B:fx49', account: 'bank-b', direction: 'debit', amount: '99510', valueDate: D1, narrative: `SEPA CT ${makeBankRef('tx-fx-49')} CHUKWUEMEKA`, endToEndId: 'E2EFX49' },
        { id: 'B:fx51', account: 'bank-b', direction: 'debit', amount: '198980', valueDate: D1, narrative: `SEPA CT ${makeBankRef('tx-fx-51')} JOSE LUIS PEREZ`, endToEndId: 'E2EFX51' },
      ],
    },
    expect: { proposal: 'tx-fx-49', raised: 'tx-fx-51' },
  });

  // reversal: closed (refunded) and open (still completed)
  {
    const refundHash = txh('rev-refund');
    out.push({
      name: 'reversal',
      days: [D1, D3],
      customers,
      platform: {
        [D1]: [
          ptx({ id: 'tx-rev-closed', sep: 24, kind: 'withdrawal', status: 'completed', inAmt: '301.50', inAsset: 'EURC', outAmt: '300.00', outAsset: 'EUR', fee: '1.50', memo: '5501', memoType: 'id', external: 'E2EREV1', customer: 'C4', started: D1, completed: D1 }),
          ptx({ id: 'tx-rev-open', sep: 31, kind: 'receive', status: 'completed', inAmt: '660.00', inAsset: 'USDC', outAmt: '600.00', outAsset: 'EUR', memo: '5502', memoType: 'id', external: 'E2EREV2', customer: 'C5', started: D1, completed: D1, tr: 'TRP-EEEEEEEEEEE1' }),
        ],
        [D3]: [ptx({ id: 'tx-rev-closed', sep: 24, kind: 'withdrawal', status: 'refunded', inAmt: '301.50', inAsset: 'EURC', outAmt: '300.00', outAsset: 'EUR', fee: '1.50', memo: '5501', memoType: 'id', external: 'E2EREV1', customer: 'C4', started: D1, completed: D1, refunds: [refundHash] })],
      },
      chain: {
        [D1]: [
          op({ label: 'rev-in-1', day: D1, from: user('C4'), to: RECV, code: 'EURC', amount: '301.5000000', memo: { type: 'id', value: '5501' } }),
          op({ label: 'rev-in-2', day: D1, from: partner, to: RECV, code: 'USDC', amount: '660.0000000', memo: { type: 'id', value: '5502' } }),
        ],
        [D3]: [op({ label: 'rev-refund', day: D3, from: DIST, to: user('C4'), code: 'EURC', amount: '301.5000000', memo: { type: 'hash', value: sha256Hex('tx-rev-closed') } })],
      },
      bank: {
        [D1]: [
          { id: 'B:r1', account: 'bank-b', direction: 'debit', amount: '30000', valueDate: D1, narrative: 'SEPA CT AOIFE FITZGERALD', endToEndId: 'E2EREV1' },
          { id: 'B:r2', account: 'bank-b', direction: 'debit', amount: '60000', valueDate: D1, narrative: 'SEPA CT SOREN OSTERGAARD', endToEndId: 'E2EREV2' },
        ],
        [D3]: [
          { id: 'B:r1ret', account: 'bank-b', direction: 'credit', amount: '30000', valueDate: D3, narrative: 'RETURN AC04 AOIFE FITZGERALD' },
          { id: 'B:r2ret', account: 'bank-b', direction: 'credit', amount: '60000', valueDate: D3, narrative: 'RTN R03 SOREN OSTERGAARD' },
        ],
      },
      expect: { closed: 'tx-rev-closed', open: 'tx-rev-open' },
    });
  }

  // truncated: 35-char truncated payout narrative and a 1-edit AR typo
  {
    const ref = makeBankRef('tx-trunc');
    const typoRef = makeBankRef('tx-typo');
    const body = typoRef.slice(3, 11);
    const swapped = `AR-${body[1]}${body[0]}${body.slice(2)}-${typoRef.slice(12)}`;
    out.push({
      name: 'truncated',
      days: [D1],
      customers,
      platform: {
        [D1]: [
          ptx({ id: 'tx-trunc', sep: 24, kind: 'withdrawal', status: 'completed', inAmt: '4213.37', inAsset: 'EURC', outAmt: '4192.41', outAsset: 'EUR', fee: '20.96', memo: '6601', memoType: 'id', customer: 'C3', started: D1, completed: D1 }),
          ptx({ id: 'tx-typo', sep: 24, kind: 'deposit', status: 'completed', inAmt: '812.40', inAsset: 'EUR', outAmt: '808.34', outAsset: 'EURC', fee: '4.06', customer: 'C1', started: D1, completed: D1 }),
          ptx({ id: 'tx-review', sep: 31, kind: 'receive', status: 'completed', inAmt: '1500.00', inAsset: 'USDC', outAmt: '1366.62', outAsset: 'EUR', memo: '6602', memoType: 'id', customer: 'C5', started: D1, completed: D1, tr: 'TRP-EEEEEEEEEEE1' }),
        ],
      },
      chain: {},
      bank: {
        [D1]: [
          { id: 'B:tr', account: 'bank-b', direction: 'debit', amount: '419241', valueDate: D1, narrative: `PAYOUT CHUKWUEMEKA OBINNA ${ref}`.slice(0, 35) },
          { id: 'A:ty', account: 'bank-a', direction: 'credit', amount: '81240', valueDate: D1, narrative: `${swapped} JOSE LUIS PERES GARCIA`, counterparty: 'JOSE LUIS PERES GARCIA' },
          { id: 'B:rv', account: 'bank-b', direction: 'debit', amount: '136662', valueDate: D1, narrative: `PAYOUT S OSTERG ${makeBankRef('tx-review').slice(0, 5)}` },
        ],
      },
      expect: { truncated: 'tx-trunc', typo: 'tx-typo', typoToken: swapped, review: 'tx-review' },
    });
  }

  // orphan: no reference, no open deposit fits; and an unknown inbound payment
  out.push({
    name: 'orphan',
    days: [D1, D2],
    customers,
    platform: {},
    chain: { [D1]: [op({ label: 'orphan-in', day: D1, from: stranger, to: RECV, code: 'USDC', amount: '1250.0000000' })] },
    bank: { [D1]: [{ id: 'A:orph', account: 'bank-a', direction: 'credit', amount: '74000', valueDate: D1, narrative: 'TRANSFER', counterparty: 'M KOWALSKY' }] },
    expect: { exceptions: ['UNMATCHED_BANK_CREDIT', 'UNMATCHED_CHAIN_IN'] },
  });
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && process.argv[1].endsWith('fixtures/build.js')) {
  const dir = resolve(here, '..', '..', '..', 'test', 'fixtures');
  for (const f of buildFixtures()) writeFileSync(join(dir, `${f.name}.json`), JSON.stringify(f, null, 1) + '\n');
  console.log(`wrote fixtures to ${dir}`);
}
