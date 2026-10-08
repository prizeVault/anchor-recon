// engine: ingest -> deterministic pass -> reversals -> fuzzy pass (AiProvider)
// -> exception classification (incl. travel rule) -> explanations.
// Review actions (accept/reject proposals, accept a band, close exceptions)
// are separate functions so every non-deterministic outcome carries a
// named analyst.

import { dayOf } from '../core/dates.js';
import { sha256Hex } from '../core/hash.js';
import type { Statement } from '../ingest/camt053.js';
import { bankLineView, chainOpView, feeView, platformTxView, bandOf, type ProposalOut } from '../ai/provider.js';
import { scoreReversal } from '../ai/heuristic.js';
import { classify } from '../exceptions/classify.js';
import type { ChainOp, PlatformTx, Proposal, ReconException, Resolution } from '../types.js';
import type { ReconState } from '../store/store.js';
import type { ReconContext } from './context.js';
import { addException, addGroup, bankItem, deterministicPass, legs, opItem, ptxId } from './deterministic.js';
import { anchorDate, buildBlocks, leftoverLines } from './candidates.js';
import { findReversals } from './reversal.js';

export interface IngestBundle {
  platform: PlatformTx[];
  chain: ChainOp[];
  statements: Statement[];
}

export interface IngestSummary {
  platform: number;
  chain: number;
  bankLines: number;
  statementsSkipped: number;
}

export function ingestInto(state: ReconState, day: string, b: IngestBundle): IngestSummary {
  let skipped = 0;
  let bankLines = 0;
  for (const p of b.platform) {
    const prev = state.platform[p.id];
    state.platform[p.id] = p;
    if (!state.firstSeen[p.id]) state.firstSeen[p.id] = day;
    if (!prev || prev.status !== p.status) state.statusSince[p.id] = { status: p.status, since: day };
    const ex = (state.exportDays[day] ??= []);
    if (!ex.includes(p.id)) ex.push(p.id);
  }
  for (const o of b.chain) if (!state.chain[o.opId]) state.chain[o.opId] = o;
  for (const st of b.statements) {
    const key = `${st.account}|${st.stmtId}|${st.seq}`;
    if (state.statements.includes(key)) {
      skipped++;
      continue;
    }
    state.statements.push(key);
    const days = (state.statementDays[st.account] ??= []);
    const stDay = st.balances.find((x) => x.type === 'CLBD')?.date ?? st.lines[0]?.bookingDate ?? day;
    if (!days.includes(stDay)) days.push(stDay);
    for (const l of st.lines) {
      if (!state.bank[l.id]) {
        state.bank[l.id] = l;
        bankLines++;
      }
    }
    state.balances.push(...st.balances);
  }
  return { platform: b.platform.length, chain: b.chain.length, bankLines, statementsSkipped: skipped };
}

function newProposalId(state: ReconState, day: string): string {
  state.seq.proposal += 1;
  return `P-${day.replace(/-/g, '')}-${String(state.seq.proposal).padStart(4, '0')}`;
}

function reserve(state: ReconState, p: Proposal) {
  for (const b of p.bankLineIds) state.itemUse[bankItem(b)] = `prop:${p.id}`;
  for (const o of p.chainOpIds) state.itemUse[opItem(o)] = `prop:${p.id}`;
}

function release(state: ReconState, p: Proposal) {
  for (const b of p.bankLineIds) if (state.itemUse[bankItem(b)] === `prop:${p.id}`) delete state.itemUse[bankItem(b)];
  for (const o of p.chainOpIds) if (state.itemUse[opItem(o)] === `prop:${p.id}`) delete state.itemUse[opItem(o)];
}

export interface MatchSummary {
  day: string;
  ruleGroups: number;
  proposals: Proposal[];
  exceptions: ReconException[];
  providerCalls: number;
  llmBlocks: number;
}

export async function matchDay(state: ReconState, ctx: ReconContext, day: string): Promise<MatchSummary> {
  const det = deterministicPass(state, ctx, day);
  const exceptions: ReconException[] = [...det.exceptions];
  const proposals: Proposal[] = [];

  // reversals
  for (const r of findReversals(state, ctx, leftoverLines(state))) {
    const ret = state.bank[r.returnLineId];
    const orig = state.bank[r.originalLineId];
    if (r.closed && r.platformId) {
      const tx = state.platform[r.platformId];
      const bdays = ctx.cal.diff(dayOf(orig.valueDate), dayOf(ret.valueDate));
      const s = scoreReversal(bankLineView(ret), platformTxView(tx, ctx.customers, anchorDate(tx)), bdays);
      const band = bandOf(s.score) ?? 'review';
      const p: Proposal = {
        id: newProposalId(state, day),
        day,
        bankLineIds: [ret.id],
        chainOpIds: [],
        platformId: r.platformId,
        kind: 'reversal_pair',
        score: s.score,
        band,
        reasons: [`returns ${orig.id}`, ...s.reasons],
        provider: 'heuristic',
        status: 'pending',
      };
      state.proposals.push(p);
      reserve(state, p);
      proposals.push(p);
    } else {
      const ev = [bankItem(ret.id), bankItem(orig.id), ...(r.platformId ? [ptxId(r.platformId)] : [])];
      const ex = addException(state, { type: 'REVERSAL_OPEN', day, evidenceIds: ev, amount: ret.amount.toString(), currency: ret.currency });
      if (ex) exceptions.push(ex);
    }
  }

  // fuzzy pass
  let calls = 0;
  let llmBlocks = 0;
  for (const block of buildBlocks(state, ctx)) {
    const input = {
      day,
      block: {
        bankLines: block.bankLines.map(bankLineView),
        platformTxs: block.platformTxs.map((p) => platformTxView(p, ctx.customers, anchorDate(p))),
        chainOps: block.chainOps.map(chainOpView),
        splitHints: block.splits.map((s) => ({ platformId: s.platformId, lineIds: s.lineIds })),
      },
      feeSchedule: feeView(ctx.tol),
      holidays: ctx.sg.holidays,
    };
    calls++;
    const out = await ctx.provider.proposeMatches(input);
    if (out.provider === 'llm') llmBlocks++;
    for (const po of out.proposals) proposals.push(recordProposal(state, day, po, out.provider));
  }

  exceptions.push(...classify(state, ctx, day));
  await explainNew(state, ctx, exceptions);
  return { day, ruleGroups: det.groups.length, proposals, exceptions, providerCalls: calls, llmBlocks };
}

function recordProposal(state: ReconState, day: string, po: ProposalOut, provider: 'heuristic' | 'llm'): Proposal {
  const p: Proposal = { id: newProposalId(state, day), day, ...po, provider, status: 'pending' };
  state.proposals.push(p);
  reserve(state, p);
  return p;
}

export function evidenceFor(state: ReconState, e: ReconException): Record<string, unknown> {
  const ev: Record<string, unknown> = {};
  for (const id of e.evidenceIds) {
    if (id.startsWith('ptx:')) {
      const p = state.platform[id.slice(4)];
      if (p) ev[id] = { sep: p.sep, kind: p.kind, status: p.status, amountIn: p.amountIn.toString(), assetIn: p.assetIn, amountOut: p.amountOut.toString(), assetOut: p.assetOut, startedAt: p.startedAt, completedAt: p.completedAt, travelRuleRef: p.travelRuleRef };
    } else if (id.startsWith('op:')) {
      const o = state.chain[id.slice(3)];
      if (o) ev[id] = { ...chainOpView(o) };
    } else if (id.startsWith('bank:')) {
      const l = state.bank[id.slice(5)];
      if (l) ev[id] = { ...bankLineView(l) };
    } else ev[id] = {};
  }
  return ev;
}

async function explainNew(state: ReconState, ctx: ReconContext, list: ReconException[]) {
  for (const e of list) {
    if (e.explanation) continue;
    e.explanation = await ctx.provider.explainException({ exception: { ...e }, evidence: evidenceFor(state, e) });
  }
}

/** Re-runs classification after review (rejected proposals free their items). */
export async function reclassify(state: ReconState, ctx: ReconContext, day: string): Promise<ReconException[]> {
  const raised = classify(state, ctx, day);
  await explainNew(state, ctx, raised);
  return raised;
}

// ------------------------------------------------------------------ review

export function decideProposal(state: ReconState, id: string, decision: 'accept' | 'reject', by: string, opts: { note?: string; at?: string; today?: string } = {}): Proposal {
  if (!by.trim()) throw new Error('a reviewer name is required (--by)');
  const p = state.proposals.find((x) => x.id === id);
  if (!p) throw new Error(`unknown proposal ${id}`);
  if (p.status !== 'pending') throw new Error(`proposal ${id} already ${p.status}`);
  const at = opts.at ?? new Date().toISOString();
  p.status = decision === 'accept' ? 'accepted' : 'rejected';
  p.decidedBy = by;
  p.decidedAt = at;
  p.note = opts.note;
  release(state, p);
  if (decision === 'accept') {
    const L = legs(state, p.platformId);
    const leg = p.kind === 'reversal_pair' ? 'reversal' : p.bankLineIds.length ? 'bank' : 'chain';
    const g = addGroup(state, opts.today ?? p.day, {
      method: p.provider === 'llm' ? 'llm' : 'heuristic',
      leg,
      rule: p.kind,
      platformIds: [p.platformId],
      chainOpIds: p.chainOpIds,
      bankLineIds: p.bankLineIds,
      decidedBy: by,
      proposalId: p.id,
      amounts: { score: String(Math.round(p.score * 1000)) },
    });
    if (leg === 'bank') L.bank = g.id;
    if (leg === 'chain') L.chain = g.id;
  }
  state.decisions.push({ at, day: p.day, action: `proposal:${decision}`, target: id, by, note: opts.note });
  return p;
}

/** Deterministic 10% (at least one) sample of high-band proposals, seeded by day. */
export function highBandSample(day: string, proposals: Proposal[]): string[] {
  const high = proposals.filter((p) => p.band === 'high').map((p) => p.id);
  if (!high.length) return [];
  const n = Math.max(1, Math.ceil(high.length / 10));
  return high.sort((a, b) => (sha256Hex(`${day}|${a}`) < sha256Hex(`${day}|${b}`) ? -1 : 1)).slice(0, n).sort();
}

export function acceptBand(state: ReconState, day: string, band: 'high', by: string, at?: string): { accepted: string[]; sampled: string[] } {
  const pending = state.proposals.filter((p) => p.day === day && p.band === band && p.status === 'pending');
  const sampled = highBandSample(day, pending);
  for (const p of pending) {
    p.sampled = sampled.includes(p.id);
    decideProposal(state, p.id, 'accept', by, { at, note: p.sampled ? 'band accept; in re-check sample' : 'band accept' });
  }
  state.decisions.push({ at: at ?? new Date().toISOString(), day, action: 'band:accept', target: `${band}:${pending.length}`, by, note: `sampled ${sampled.join(',')}` });
  return { accepted: pending.map((p) => p.id), sampled };
}

export function closeException(state: ReconState, id: string, resolution: Resolution, by: string, day: string, at?: string): ReconException {
  if (!by.trim()) throw new Error('a reviewer name is required (--by)');
  const e = state.exceptions.find((x) => x.id === id);
  if (!e) throw new Error(`unknown exception ${id}`);
  if (e.status === 'closed') throw new Error(`exception ${id} already closed`);
  e.status = 'closed';
  e.resolution = resolution;
  e.closedBy = by;
  e.closedOn = day;
  state.decisions.push({ at: at ?? new Date().toISOString(), day, action: `exception:close:${resolution}`, target: id, by });
  return e;
}

export function pendingProposals(state: ReconState, day?: string): Proposal[] {
  return state.proposals.filter((p) => p.status === 'pending' && (!day || p.day <= day));
}

/** Analyst match by hand (method `analyst`), e.g. after rejecting a proposal. */
export function manualMatch(state: ReconState, day: string, platformId: string, bankLineIds: string[], by: string, note?: string, chainOpIds: string[] = []) {
  if (!by.trim()) throw new Error('a reviewer name is required (--by)');
  if (!state.platform[platformId]) throw new Error(`unknown platform transaction ${platformId}`);
  for (const b of bankLineIds) if (state.itemUse[bankItem(b)]) throw new Error(`bank line ${b} is already used (${state.itemUse[bankItem(b)]})`);
  for (const o of chainOpIds) if (state.itemUse[opItem(o)]) throw new Error(`chain op ${o} is already used`);
  const L = legs(state, platformId);
  if (bankLineIds.length && L.bank) throw new Error(`${platformId} already has a bank leg`);
  if (chainOpIds.length && L.chain) throw new Error(`${platformId} already has a chain leg`);
  const g = addGroup(state, day, { method: 'analyst', leg: bankLineIds.length ? 'bank' : 'chain', rule: 'manual', platformIds: [platformId], chainOpIds, bankLineIds, decidedBy: by });
  if (bankLineIds.length) L.bank = g.id;
  if (chainOpIds.length) L.chain = g.id;
  state.decisions.push({ at: new Date(0).toISOString(), day, action: 'manual-match', target: `${platformId}<-${[...bankLineIds, ...chainOpIds].join(',')}`, by, note });
  return g;
}
