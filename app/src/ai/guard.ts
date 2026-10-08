// Guards applied to anything a model returns. Rejected output never reaches
// the analyst: the heuristic proposal, the template explanation or the
// template report stands instead.

import { BusinessCalendar } from '../core/dates.js';
import { formatMoney } from '../core/money.js';
import { fitAmount, type Tolerances } from '../match/tolerance.js';
import type { ExceptionType, Explanation, Kind, SuggestedAction } from '../types.js';
import type { ExplainInput, ProposalOut, ProposeInput } from './provider.js';

export interface GuardResult {
  ok: boolean;
  errors: string[];
}

export function tolerancesOfInput(input: ProposeInput): Tolerances {
  return {
    feeAbs: BigInt(input.feeSchedule.feeAbs),
    feeBps: BigInt(input.feeSchedule.feeBps),
    fxBandBps: BigInt(input.feeSchedule.fxBandBps),
    charges: input.feeSchedule.charges.map((c) => BigInt(c)),
  };
}

export function calendarOfInput(input: ProposeInput): BusinessCalendar {
  return new BusinessCalendar(input.holidays);
}

export function guardProposals(input: ProposeInput, proposals: ProposalOut[]): GuardResult {
  const errors: string[] = [];
  const lines = new Map(input.block.bankLines.map((l) => [l.id, l]));
  const ops = new Map(input.block.chainOps.map((o) => [o.id, o]));
  const txs = new Map(input.block.platformTxs.map((p) => [p.id, p]));
  const tol = tolerancesOfInput(input);
  const used = new Set<string>();
  proposals.forEach((p, i) => {
    const tag = `proposal ${i}`;
    const tx = txs.get(p.platformId);
    if (!tx) errors.push(`${tag}: unknown platformId ${p.platformId}`);
    for (const id of p.bankLineIds) if (!lines.has(id)) errors.push(`${tag}: unknown bank line ${id}`);
    for (const id of p.chainOpIds) if (!ops.has(id)) errors.push(`${tag}: unknown chain op ${id}`);
    for (const id of [...p.bankLineIds, ...p.chainOpIds, `P:${p.platformId}`]) {
      if (used.has(id)) errors.push(`${tag}: item ${id} used twice`);
      used.add(id);
    }
    if (p.band === 'high' && p.score < 0.9) errors.push(`${tag}: band high with score ${p.score}`);
    if (p.band === 'review' && (p.score < 0.6 || p.score >= 0.9)) errors.push(`${tag}: band review with score ${p.score}`);
    if (!tx || errors.length) return;
    if (p.kind === 'reversal_pair') {
      errors.push(`${tag}: reversal pairs are detected by rule, not proposed by the model`);
      return;
    }
    if (p.bankLineIds.length) {
      const kind = tx.kind as Kind;
      const expected = BigInt(kind === 'deposit' ? tx.amountIn : tx.amountOut);
      const ls = p.bankLineIds.map((id) => lines.get(id)!);
      const dir = kind === 'deposit' ? 'credit' : 'debit';
      if (ls.some((l) => l.direction !== dir)) errors.push(`${tag}: bank direction contradicts ${kind}`);
      const total = ls.reduce((a, l) => a + BigInt(l.amount), 0n);
      const charges = ls.reduce((a, l) => a + BigInt(l.charges ?? 0), 0n);
      const fit = fitAmount(expected, total, kind, tol, charges || undefined);
      if (fit.closeness === 0) errors.push(`${tag}: amounts do not reconcile (expected ${expected}, got ${total})`);
      if (p.kind === 'split' && ls.length < 2) errors.push(`${tag}: split with fewer than 2 lines`);
      if (p.kind !== 'split' && ls.length > 1) errors.push(`${tag}: ${p.kind} with ${ls.length} lines`);
      if (p.kind === 'single' && fit.kind !== 'exact') errors.push(`${tag}: single but amounts differ`);
      if (p.kind === 'fee_diff' && fit.kind !== 'fee_diff') errors.push(`${tag}: fee_diff not explained by a listed charge`);
      if (p.kind === 'fx_diff' && fit.kind !== 'fx_diff') errors.push(`${tag}: fx_diff outside the FX band`);
    } else if (p.chainOpIds.length) {
      const expected = tx.kind === 'deposit' ? tx.amountOut : tx.amountIn;
      const total = p.chainOpIds.reduce((a, id) => a + BigInt(ops.get(id)!.amount), 0n);
      if (total.toString() !== expected) errors.push(`${tag}: chain amount ${total} != ${expected}`);
    } else {
      errors.push(`${tag}: no items`);
    }
  });
  return { ok: errors.length === 0, errors };
}

export const ALLOWED_ACTIONS: Record<ExceptionType, SuggestedAction[]> = {
  PLATFORM_NO_CHAIN_LEG: ['REPAY_ONCHAIN', 'CHASE_BANK', 'NONE'],
  PLATFORM_NO_BANK_LEG: ['CHASE_BANK', 'NONE'],
  DUPLICATE_CHAIN_PAYMENT: ['REVIEW_WRITE_OFF', 'REFUND_USER', 'NONE'],
  DUPLICATE_PAYOUT: ['CHASE_BANK', 'REVIEW_WRITE_OFF', 'TOP_UP_SAFEGUARDING'],
  SHORT_PAYOUT: ['CHASE_BANK', 'REFUND_USER', 'CONTACT_PARTNER_ANCHOR'],
  AMOUNT_MISMATCH: ['CHASE_BANK', 'REFUND_USER', 'REVIEW_WRITE_OFF'],
  WRONG_MEMO: ['REFUND_USER', 'CONTACT_PARTNER_ANCHOR', 'NONE'],
  UNMATCHED_CHAIN_IN: ['REFUND_USER', 'CONTACT_PARTNER_ANCHOR', 'NONE'],
  UNMATCHED_CHAIN_OUT: ['REVIEW_WRITE_OFF', 'NONE'],
  UNMATCHED_BANK_CREDIT: ['CHASE_BANK', 'REFUND_USER', 'NONE'],
  UNMATCHED_BANK_DEBIT: ['CHASE_BANK', 'REVIEW_WRITE_OFF'],
  STATUS_MISMATCH: ['NONE', 'REFUND_USER'],
  REVERSAL_OPEN: ['REFUND_USER', 'CONTACT_PARTNER_ANCHOR', 'CHASE_BANK'],
  STALE_PENDING: ['CHASE_BANK', 'REFUND_USER', 'NONE'],
  NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING: ['TOP_UP_SAFEGUARDING'],
  STATEMENT_MISSING: ['CHASE_BANK'],
  TRAVEL_RULE_MISSING: ['REQUEST_TRAVEL_RULE_DATA', 'CONTACT_PARTNER_ANCHOR'],
};

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUM_RE = /(?<![A-Za-z0-9_:-])\d+(?:[.,]\d+)*(?![A-Za-z0-9_])/g;

/** Every number-looking token a text may legitimately contain, derived from evidence values. */
export function allowedNumbers(values: unknown): { numbers: Set<string>; dates: Set<string> } {
  const numbers = new Set<string>();
  const dates = new Set<string>();
  const visit = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'bigint' || typeof v === 'number') return add(String(v));
    if (typeof v === 'string') {
      for (const d of v.match(DATE_RE) ?? []) dates.add(d);
      if (/^-?\d+$/.test(v)) add(v);
      for (const m of v.replace(DATE_RE, ' ').match(NUM_RE) ?? []) numbers.add(m.replace(/,/g, ''));
      return;
    }
    if (Array.isArray(v)) return v.forEach(visit);
    if (typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(visit);
  };
  const add = (s: string) => {
    numbers.add(s.replace(/^-/, ''));
    const n = BigInt(s.replace(/^-/, ''));
    numbers.add(formatMoney(n, 2));
    numbers.add(formatMoney(n, 7));
    numbers.add(formatMoney(n, 7, 0));
  };
  visit(values);
  return { numbers, dates };
}

/** Numbers and dates in `text` that do not appear in `values`. */
export function unknownNumbers(text: string, values: unknown, extra: string[] = []): string[] {
  const { numbers, dates } = allowedNumbers(values);
  for (const e of extra) numbers.add(e);
  const bad: string[] = [];
  for (const d of text.match(DATE_RE) ?? []) if (!dates.has(d)) bad.push(d);
  for (const m of text.replace(DATE_RE, ' ').match(NUM_RE) ?? []) {
    const n = m.replace(/,(?=\d{3}\b)/g, '');
    if (!numbers.has(n)) bad.push(m);
  }
  return bad;
}

export function guardExplanation(input: ExplainInput, e: Explanation): GuardResult {
  const errors: string[] = [];
  if (e.exceptionId !== input.exception.id) errors.push('exceptionId differs from input');
  if (e.type !== input.exception.type) errors.push(`type ${e.type} != ${input.exception.type}`);
  const allowedIds = new Set(input.exception.evidenceIds);
  for (const id of e.evidenceIds) if (!allowedIds.has(id)) errors.push(`evidence id ${id} not in input`);
  if (e.summary.length > 400) errors.push('summary longer than 400 chars');
  const bad = unknownNumbers(e.summary, { evidence: input.evidence, exception: { ...input.exception, id: undefined, evidenceIds: undefined, explanation: undefined } });
  if (bad.length) errors.push(`summary numbers not in evidence: ${bad.join(', ')}`);
  if (!ALLOWED_ACTIONS[input.exception.type].includes(e.suggestedAction)) errors.push(`action ${e.suggestedAction} not allowed for ${input.exception.type}`);
  return { ok: errors.length === 0, errors };
}

/** Numbers guard for report drafts: every number must come from the figures. */
export function guardReport(markdown: string, figures: unknown): GuardResult {
  const bad = unknownNumbers(markdown, figures, ['15', '48']);
  return { ok: bad.length === 0, errors: bad.map((b) => `number not in figures: ${b}`) };
}
