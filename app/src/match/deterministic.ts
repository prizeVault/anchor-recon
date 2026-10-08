// Deterministic pass. Each item is used at most once.
//   Platform <-> chain: (1) txHash in stellarTxHashes, (2) claimable balance id,
//   (3) memo equality (type-aware: text, id, hash in hex or base64) with the
//   same asset and exact amount, (4) SEP-31 muxed id equal to the platform memo.
//   Platform <-> bank: (1) end-to-end id == external id, (2) a valid AR- token
//   equal to bankRef; both with the exact amount (amountIn for deposit
//   credits, amountOut for payout debits).
// If one platform transaction matches two or more chain ops (or payout
// debits) by an exact key, none is matched and DUPLICATE_CHAIN_PAYMENT /
// DUPLICATE_PAYOUT is raised instead.

import { rescale } from '../core/money.js';
import { sha256Hex } from '../core/hash.js';
import type { BankLine, ChainOp, Group, PlatformTx, ReconException } from '../types.js';
import type { ReconState } from '../store/store.js';
import type { ReconContext } from './context.js';
import { findRefs } from '../core/reference.js';

export const ptxId = (id: string) => `ptx:${id}`;
export const opItem = (id: string) => `op:${id}`;
export const bankItem = (id: string) => `bank:${id}`;

export function isUsed(state: ReconState, item: string): boolean {
  return state.itemUse[item] !== undefined;
}

export function legs(state: ReconState, pid: string) {
  if (!state.legs[pid]) state.legs[pid] = { refund: [] };
  return state.legs[pid];
}

/** Anchor account and direction a platform transaction's chain leg uses. */
export function chainExpectation(p: PlatformTx, ctx: ReconContext): { account: string; direction: 'in' | 'out'; amount7: bigint; asset: string } {
  if (p.kind === 'deposit') {
    return { account: ctx.sg.anchor_accounts.distribution, direction: 'out', amount7: rescale(p.amountOut, 7, 7), asset: p.assetOut };
  }
  return { account: ctx.sg.anchor_accounts.receive, direction: 'in', amount7: p.amountIn, asset: p.assetIn };
}

/** Direction and EUR amount of the bank leg. */
export function bankExpectation(p: PlatformTx): { direction: 'credit' | 'debit'; amount: bigint } {
  return p.kind === 'deposit' ? { direction: 'credit', amount: p.amountIn } : { direction: 'debit', amount: p.amountOut };
}

export function hashHex(memo: string): string | undefined {
  if (/^[0-9a-fA-F]{64}$/.test(memo)) return memo.toLowerCase();
  try {
    const b = Buffer.from(memo, 'base64');
    if (b.length === 32) return b.toString('hex');
  } catch {
    /* not base64 */
  }
  return undefined;
}

export function memoEquals(p: PlatformTx, op: ChainOp): boolean {
  if (!p.memo || !op.memo || !op.memoType) return false;
  const pt = p.memoType ?? 'text';
  if (pt !== op.memoType) return false;
  if (pt === 'hash') {
    const a = hashHex(p.memo);
    const b = hashHex(op.memo);
    return !!a && a === b;
  }
  if (pt === 'id') {
    try {
      return BigInt(p.memo) === BigInt(op.memo);
    } catch {
      return false;
    }
  }
  return p.memo.trim() === op.memo.trim();
}

export function exceptionId(type: string, day: string, evidence: string[]): string {
  return `EX-${type}-${sha256Hex(type + '|' + [...evidence].sort().join(',')).slice(0, 10)}`;
}

export function newGroupId(state: ReconState, day: string): string {
  state.seq.group += 1;
  return `G-${day.replace(/-/g, '')}-${String(state.seq.group).padStart(5, '0')}`;
}

/** Group day: latest of the item dates (bank value date, ledger date), never after today. */
export function groupDay(state: ReconState, today: string, bankIds: string[], opIds: string[]): string {
  const dates = [...bankIds.map((b) => state.bank[b].valueDate), ...opIds.map((o) => state.chain[o].day)];
  const d = dates.length ? dates.sort().at(-1)! : today;
  return d > today ? today : d;
}

export function addGroup(
  state: ReconState,
  today: string,
  g: Omit<Group, 'id' | 'day' | 'chainRefs' | 'amounts' | 'kind'> & { amounts?: Record<string, string> },
): Group {
  const id = newGroupId(state, today);
  const day = groupDay(state, today, g.bankLineIds, g.chainOpIds);
  const amounts: Record<string, string> = { ...(g.amounts ?? {}) };
  if (g.bankLineIds.length) amounts.bank = g.bankLineIds.reduce((a, b) => a + state.bank[b].amount, 0n).toString();
  if (g.chainOpIds.length) amounts.chain = g.chainOpIds.reduce((a, o) => a + state.chain[o].amount, 0n).toString();
  const group: Group = {
    ...g,
    id,
    day,
    kind: 'match',
    chainRefs: g.chainOpIds.map((o) => `${state.chain[o].txHash}:${opIndex(state.chain[o].opId)}`),
    amounts,
  };
  state.groups.push(group);
  for (const b of g.bankLineIds) state.itemUse[bankItem(b)] = `group:${id}`;
  for (const o of g.chainOpIds) state.itemUse[opItem(o)] = `group:${id}`;
  if (day < today && !state.dirtyDays.includes(day) && state.processedDays.includes(day)) state.dirtyDays.push(day);
  return group;
}

export function opIndex(opId: string): number {
  try {
    return Number((BigInt(opId) & 0xfffn) - 1n);
  } catch {
    return 0;
  }
}

export function addException(state: ReconState, e: Omit<ReconException, 'id' | 'status' | 'openedOn'> & { id?: string }): ReconException | undefined {
  const id = e.id ?? exceptionId(e.type, e.day, e.evidenceIds);
  if (state.exceptions.some((x) => x.id === id)) return undefined;
  const ex: ReconException = { ...e, id, status: 'open', openedOn: e.day };
  state.exceptions.push(ex);
  for (const ev of e.evidenceIds) {
    if ((ev.startsWith('op:') || ev.startsWith('bank:')) && !state.itemUse[ev]) state.itemUse[ev] = `exc:${id}`;
  }
  return ex;
}

function sortedPlatform(state: ReconState): PlatformTx[] {
  return Object.values(state.platform).sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface DeterministicResult {
  groups: Group[];
  exceptions: ReconException[];
}

export function deterministicPass(state: ReconState, ctx: ReconContext, today: string): DeterministicResult {
  const out: DeterministicResult = { groups: [], exceptions: [] };
  const freeOps = () => Object.values(state.chain).filter((o) => !isUsed(state, opItem(o.opId)));
  const freeLines = () => Object.values(state.bank).filter((l) => !isUsed(state, bankItem(l.id)));

  // --- platform <-> chain
  for (const p of sortedPlatform(state)) {
    const L = legs(state, p.id);
    if (L.chain || L.blockedChain) continue;
    const exp = chainExpectation(p, ctx);
    const rules = new Map<string, string>(); // opId -> rule
    for (const op of freeOps()) {
      if (op.type === 'claim_cb') continue;
      if (op.amount !== exp.amount7 || op.direction !== exp.direction) continue;
      if (p.stellarTxHashes.includes(op.txHash)) rules.set(op.opId, rules.get(op.opId) ?? 'tx_hash');
      else if (p.claimableBalanceId && op.type === 'create_cb' && op.cbId === p.claimableBalanceId) rules.set(op.opId, 'cb_id');
      else if (op.asset === exp.asset && op.account === exp.account && memoEquals(p, op)) rules.set(op.opId, 'memo');
      else if (p.sep === 31 && op.muxedId && p.memoType === 'id' && p.memo && BigInt(op.muxedId) === BigInt(p.memo) && op.asset === exp.asset) rules.set(op.opId, 'muxed_id');
    }
    if (rules.size === 1) {
      const [opId, rule] = [...rules][0];
      L.chain = addGroup(state, today, { method: 'rule', leg: 'chain', rule, platformIds: [p.id], chainOpIds: [opId], bankLineIds: [] }).id;
      out.groups.push(state.groups.at(-1)!);
    } else if (rules.size > 1) {
      const ev = [ptxId(p.id), ...[...rules.keys()].map(opItem)];
      const ex = addException(state, {
        type: 'DUPLICATE_CHAIN_PAYMENT',
        day: today,
        evidenceIds: ev,
        amount: exp.amount7.toString(),
        currency: exp.asset,
      });
      if (ex) {
        L.blockedChain = ex.id;
        out.exceptions.push(ex);
      }
    }
  }

  // --- refunds and claimable-balance claims
  for (const p of sortedPlatform(state)) {
    const L = legs(state, p.id);
    for (const op of freeOps()) {
      if (p.refundTxHashes.includes(op.txHash)) {
        const g = addGroup(state, today, { method: 'rule', leg: 'refund', rule: 'refund_tx_hash', platformIds: [p.id], chainOpIds: [op.opId], bankLineIds: [] });
        L.refund.push(g.id);
        out.groups.push(g);
      } else if (op.type === 'claim_cb' && p.claimableBalanceId && op.cbId === p.claimableBalanceId && L.chain) {
        out.groups.push(addGroup(state, today, { method: 'rule', leg: 'claim', rule: 'cb_claim', platformIds: [p.id], chainOpIds: [op.opId], bankLineIds: [] }));
      }
    }
  }

  // --- platform <-> bank
  for (const p of sortedPlatform(state)) {
    const L = legs(state, p.id);
    if (L.bank || L.blockedBank) continue;
    const exp = bankExpectation(p);
    const hits = new Map<string, string>();
    for (const line of freeLines()) {
      if (line.direction !== exp.direction || line.amount !== exp.amount) continue;
      if (p.externalId && line.endToEndId === p.externalId) hits.set(line.id, 'e2e_id');
      else if (p.bankRef && findRefs(line.narrative).some((r) => r.valid && r.canonical === p.bankRef)) hits.set(line.id, 'ar_token');
    }
    if (hits.size === 0) continue;
    if (hits.size > 1 && exp.direction === 'debit') {
      const ev = [ptxId(p.id), ...[...hits.keys()].sort().map(bankItem)];
      const ex = addException(state, { type: 'DUPLICATE_PAYOUT', day: today, evidenceIds: ev, amount: exp.amount.toString(), currency: p.assetFiat });
      if (ex) {
        L.blockedBank = ex.id;
        out.exceptions.push(ex);
      }
      continue;
    }
    // for duplicate credits the earliest line matches; the other stays leftover
    const [lineId, rule] = [...hits].sort((a, b) => (a[0] < b[0] ? -1 : 1))[0];
    L.bank = addGroup(state, today, { method: 'rule', leg: 'bank', rule, platformIds: [p.id], chainOpIds: [], bankLineIds: [lineId] }).id;
    out.groups.push(state.groups.at(-1)!);
  }

  // --- internal bank lines (sweeps, interest, top-ups, bank charges)
  const allowedDebit = ctx.sg.allowed_debit_patterns.map((p) => new RegExp(p));
  const internalCredit = ctx.sg.internal_credit_patterns.map((p) => new RegExp(p));
  for (const line of freeLines()) {
    const pats = line.direction === 'debit' ? allowedDebit : internalCredit;
    if (pats.some((re) => re.test(line.narrative))) {
      out.groups.push(addGroup(state, today, { method: 'rule', leg: 'bank', rule: 'internal_allowed', platformIds: [], chainOpIds: [], bankLineIds: [line.id] }));
    }
  }
  return out;
}

export function lineFor(state: ReconState, id: string): BankLine {
  return state.bank[id];
}
