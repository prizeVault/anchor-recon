// Candidate generation (blocking) for the fuzzy pass.
// Leftover bank lines vs open platform transactions: same direction, value
// date within -1..+3 business days of startedAt (deposits) or completedAt
// (payouts), amount explained by tolerance (exact, listed fee, FX band).
// Leftover chain ops vs open platform transactions: same account, asset and
// exact amount. Candidates are grouped into connected blocks.

import { dayOf } from '../core/dates.js';
import type { BankLine, ChainOp, PlatformTx } from '../types.js';
import type { ReconState } from '../store/store.js';
import type { ReconContext } from './context.js';
import { bankExpectation, bankItem, chainExpectation, isUsed, legs, opItem } from './deterministic.js';
import { fitAmount } from './tolerance.js';
import { splitCandidates, type SplitCandidate } from './split.js';

export interface Block {
  bankLines: BankLine[];
  chainOps: ChainOp[];
  platformTxs: PlatformTx[];
  splits: SplitCandidate[];
}

export function anchorDate(p: PlatformTx): string {
  const d = p.kind === 'deposit' ? p.startedAt : p.completedAt ?? p.updatedAt ?? p.startedAt;
  return d.slice(0, 10);
}

export function inWindow(ctx: ReconContext, p: PlatformTx, valueDate: string): boolean {
  const diff = ctx.cal.diff(dayOf(anchorDate(p)), dayOf(valueDate));
  return diff >= -1 && diff <= 3;
}

/** Platform transactions still missing a bank leg. */
export function openForBank(state: ReconState): PlatformTx[] {
  return Object.values(state.platform)
    .filter((p) => {
      const L = legs(state, p.id);
      return !L.bank && !L.blockedBank && p.status !== 'pending_user_transfer_start_cancelled';
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function openForChain(state: ReconState): PlatformTx[] {
  return Object.values(state.platform)
    .filter((p) => {
      const L = legs(state, p.id);
      return !L.chain && !L.blockedChain;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function leftoverLines(state: ReconState): BankLine[] {
  return Object.values(state.bank)
    .filter((l) => !isUsed(state, bankItem(l.id)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function leftoverOps(state: ReconState): ChainOp[] {
  return Object.values(state.chain)
    .filter((o) => !isUsed(state, opItem(o.opId)) && o.type !== 'claim_cb')
    .sort((a, b) => (a.opId < b.opId ? -1 : 1));
}

export function buildBlocks(state: ReconState, ctx: ReconContext): Block[] {
  const lines = leftoverLines(state);
  const ops = leftoverOps(state);
  const bankOpen = openForBank(state);
  const chainOpen = openForChain(state);
  const edges: [string, string][] = [];
  for (const l of lines) {
    for (const p of bankOpen) {
      const exp = bankExpectation(p);
      if (l.direction !== exp.direction || !inWindow(ctx, p, l.valueDate)) continue;
      if (fitAmount(exp.amount, l.amount, p.kind, ctx.tol, l.charges).closeness > 0) edges.push([`L:${l.id}`, `P:${p.id}`]);
    }
  }
  for (const o of ops) {
    for (const p of chainOpen) {
      const exp = chainExpectation(p, ctx);
      if (o.direction === exp.direction && o.account === exp.account && o.asset === exp.asset && o.amount === exp.amount7) edges.push([`O:${o.opId}`, `P:${p.id}`]);
    }
  }
  const splits = splitCandidates(lines, bankOpen, ctx);
  for (const s of splits) for (const lid of s.lineIds) edges.push([`L:${lid}`, `P:${s.platformId}`]);

  // union-find over nodes
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of edges) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const comps = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    for (const n of [a, b]) {
      const r = find(n);
      if (!comps.has(r)) comps.set(r, new Set());
      comps.get(r)!.add(n);
    }
  }
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const opById = new Map(ops.map((o) => [o.opId, o]));
  return [...comps.keys()].sort().map((k) => {
    const nodes = [...comps.get(k)!].sort();
    const pids = new Set(nodes.filter((n) => n.startsWith('P:')).map((n) => n.slice(2)));
    return {
      bankLines: nodes.filter((n) => n.startsWith('L:')).map((n) => lineById.get(n.slice(2))!),
      chainOps: nodes.filter((n) => n.startsWith('O:')).map((n) => opById.get(n.slice(2))!),
      platformTxs: [...pids].sort().map((id) => state.platform[id]),
      splits: splits.filter((s) => pids.has(s.platformId)),
    };
  });
}
