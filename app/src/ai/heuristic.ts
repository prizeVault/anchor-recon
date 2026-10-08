// HeuristicProvider: deterministic rules for all three AI tasks.
//
// proposeMatches score = 0.40 x reference similarity
//                      + 0.25 x amount closeness (1 exact, 0.8 explained fee/FX, else no proposal)
//                      + 0.15 x date proximity (1 - |business days| / 4)
//                      + 0.20 x name similarity (Jaro-Winkler over token sets, truncation-aware)
// Reference similarity: valid AR token or end-to-end id equal = 1; an invalid
// token within one edit of the transaction's token (check digit caught the
// typo) = 0.9; a truncated token prefix = 0.5 + 0.5 x prefix/13; another
// AR-like token = 0.5 x DL similarity; chain memos: exact = 1, else 0.8 x DL.
// Bands: >= 0.90 high, 0.60-0.90 review, below 0.60 no proposal. Selection is
// greedy by score, ties broken by platform id, each item used once.

import { dayOf } from '../core/dates.js';
import { formatMoney } from '../core/money.js';
import { findRefPrefix, findRefs, damerauLevenshtein } from '../core/reference.js';
import { dlSimilarity, nameSimilarity, round3 } from '../core/similarity.js';
import { nameTokens, narrativeNameTokens } from '../ingest/normalise.js';
import { fitAmount } from '../match/tolerance.js';
import { hashHex } from '../match/deterministic.js';
import type { Explanation, ExceptionType, Kind, ProposalKind, SuggestedAction } from '../types.js';
import { calendarOfInput, guardExplanation, tolerancesOfInput } from './guard.js';
import type { AiProvider, BankLineView, ChainOpView, ExplainInput, PlatformTxView, ProposalOut, ProposeInput, ProposeOutput, ReportInput } from './provider.js';
import { bandOf } from './provider.js';
import { renderTemplate } from './template.js';

export const WEIGHTS = { ref: 0.4, amount: 0.25, date: 0.15, name: 0.2 } as const;
const TOKEN_LEN = 13; // "AR-XXXXXXXX-C"

export function refSimilarity(line: BankLineView, tx: PlatformTxView, blockRefs: string[]): { score: number; reason: string } {
  const toks = findRefs(line.narrative);
  if (tx.bankRef && toks.some((t) => t.valid && t.canonical === tx.bankRef)) return { score: 1, reason: 'valid AR token equals bank reference' };
  if (tx.externalId && line.endToEndId) {
    if (line.endToEndId === tx.externalId) return { score: 1, reason: 'end-to-end id equals external id' };
    if (damerauLevenshtein(line.endToEndId, tx.externalId) === 1) return { score: 0.8, reason: 'end-to-end id one edit from external id' };
  }
  if (tx.bankRef) {
    for (const t of toks.filter((x) => !x.valid)) {
      if (damerauLevenshtein(t.canonical, tx.bankRef) === 1) {
        const rivals = blockRefs.filter((r) => r !== tx.bankRef && damerauLevenshtein(t.canonical, r) === 1).length;
        return rivals
          ? { score: 0.6, reason: `invalid token ${t.canonical} is one edit from several references` }
          : { score: 0.9, reason: `check digit rejects ${t.canonical}; one-edit correction is ${tx.bankRef}` };
      }
    }
    const prefix = findRefPrefix(line.narrative);
    if (prefix && prefix.length >= 5 && tx.bankRef.startsWith(prefix)) {
      return { score: round3(0.5 + (0.5 * prefix.length) / TOKEN_LEN), reason: `truncated token ${prefix} is a prefix of ${tx.bankRef}` };
    }
    if (toks.length) {
      const best = Math.max(...toks.map((t) => dlSimilarity(t.canonical, tx.bankRef!)));
      return { score: round3(0.5 * best), reason: `other AR token, similarity ${round3(best)}` };
    }
  }
  return { score: 0, reason: 'no reference' };
}

export function memoSimilarity(op: ChainOpView, tx: PlatformTxView): number {
  if (!op.memo || !tx.memo) return 0;
  if (op.memoType === 'hash' && tx.memoType === 'hash') return hashHex(op.memo) === hashHex(tx.memo) ? 1 : 0;
  if (op.memo === tx.memo) return 1;
  return round3(0.8 * dlSimilarity(op.memo, tx.memo));
}

function dateScore(input: ProposeInput, anchor: string, d: string): number {
  const cal = calendarOfInput(input);
  const diff = Math.abs(cal.diff(dayOf(anchor), dayOf(d)));
  return Math.max(0, 1 - diff / 4);
}

function nameScore(lines: BankLineView[], tx: PlatformTxView): number {
  let best = 0;
  for (const l of lines) {
    const obs = l.counterparty ? nameTokens(l.counterparty) : narrativeNameTokens(l.narrative);
    best = Math.max(best, nameSimilarity(obs, tx.customerNameTokens));
  }
  return best;
}

interface Scored extends ProposalOut {
  sortKey: string;
}

function score(parts: { ref: number; amount: number; date: number; name: number }): number {
  return round3(WEIGHTS.ref * parts.ref + WEIGHTS.amount * parts.amount + WEIGHTS.date * parts.date + WEIGHTS.name * parts.name);
}

export function scoreBankProposal(input: ProposeInput, lines: BankLineView[], tx: PlatformTxView, kindHint?: 'split'): Scored | undefined {
  const tol = tolerancesOfInput(input);
  const kind = tx.kind as Kind;
  const expected = BigInt(kind === 'deposit' ? tx.amountIn : tx.amountOut);
  const total = lines.reduce((a, l) => a + BigInt(l.amount), 0n);
  const charges = lines.reduce((a, l) => a + BigInt(l.charges ?? 0), 0n);
  const fit = fitAmount(expected, total, kind, tol, charges || undefined);
  if (fit.closeness === 0) return undefined;
  const refs = input.block.platformTxs.map((p) => p.bankRef).filter((x): x is string => !!x);
  const r = lines.map((l) => refSimilarity(l, tx, refs)).sort((a, b) => b.score - a.score)[0];
  const date = Math.min(...lines.map((l) => dateScore(input, tx.anchorDate, l.valueDate)));
  const name = nameScore(lines, tx);
  const s = score({ ref: r.score, amount: fit.closeness, date, name });
  const band = bandOf(s);
  if (!band) return undefined;
  const pk: ProposalKind = kindHint ?? (fit.kind === 'exact' ? 'single' : fit.kind === 'fee_diff' ? 'fee_diff' : 'fx_diff');
  return {
    bankLineIds: lines.map((l) => l.id).sort(),
    chainOpIds: [],
    platformId: tx.id,
    kind: pk,
    score: s,
    band,
    reasons: [`reference ${r.score}: ${r.reason}`, `amount ${fit.closeness}: ${fit.reason}`, `date ${round3(date)}`, `name ${round3(name)}`],
    sortKey: tx.id,
  };
}

export function scoreChainProposal(input: ProposeInput, op: ChainOpView, tx: PlatformTxView): Scored | undefined {
  const ref = memoSimilarity(op, tx);
  const date = dateScore(input, tx.anchorDate, op.day);
  const s = score({ ref, amount: 1, date, name: 0 });
  const band = bandOf(s);
  if (!band) return undefined;
  return {
    bankLineIds: [],
    chainOpIds: [op.id],
    platformId: tx.id,
    kind: 'single',
    score: s,
    band,
    reasons: [`memo similarity ${ref}`, 'amount exact', `date ${round3(date)}`],
    sortKey: tx.id,
  };
}

/** Greedy selection: highest score first, ties by platform id, each item once. */
export function selectProposals(all: Scored[]): ProposalOut[] {
  const sorted = [...all].sort((a, b) => b.score - a.score || (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0) || (a.bankLineIds.join() < b.bankLineIds.join() ? -1 : 1));
  const used = new Set<string>();
  const out: ProposalOut[] = [];
  for (const p of sorted) {
    const items = [...p.bankLineIds.map((x) => `L:${x}`), ...p.chainOpIds.map((x) => `O:${x}`), `P:${p.platformId}:${p.bankLineIds.length ? 'bank' : 'chain'}`];
    if (items.some((i) => used.has(i))) continue;
    items.forEach((i) => used.add(i));
    const { sortKey: _s, ...rest } = p;
    out.push(rest);
  }
  return out;
}

export function heuristicProposals(input: ProposeInput): ProposalOut[] {
  const all: Scored[] = [];
  const { bankLines, platformTxs, chainOps, splitHints } = input.block;
  for (const tx of platformTxs) {
    for (const l of bankLines) {
      const s = scoreBankProposal(input, [l], tx);
      if (s) all.push(s);
    }
    for (const o of chainOps) {
      const exp = tx.kind === 'deposit' ? tx.amountOut : tx.amountIn;
      if (o.amount !== exp) continue;
      const s = scoreChainProposal(input, o, tx);
      if (s) all.push(s);
    }
  }
  const lineById = new Map(bankLines.map((l) => [l.id, l]));
  const txById = new Map(platformTxs.map((p) => [p.id, p]));
  for (const h of splitHints) {
    const tx = txById.get(h.platformId);
    const ls = h.lineIds.map((id) => lineById.get(id)).filter((x): x is BankLineView => !!x);
    if (!tx || ls.length !== h.lineIds.length) continue;
    const s = scoreBankProposal(input, ls, tx, 'split');
    if (s) all.push(s);
  }
  return selectProposals(all);
}

/** Reversal pairs are found by rule (reversal.ts) and scored here. */
export function scoreReversal(returnLine: BankLineView, tx: PlatformTxView | undefined, businessDays: number): { score: number; reasons: string[] } {
  const name = tx ? nameScore([returnLine], tx) : 0;
  const date = Math.max(0, 1 - businessDays / 6);
  const s = score({ ref: tx ? 1 : 0, amount: 1, date, name });
  return { score: s, reasons: ['original debit matched by rule to the transaction', 'return amount equals original', `returned after ${businessDays} business days`, `name ${round3(name)}`] };
}

// ------------------------------------------------------------------ explanations

interface ExplainTemplate {
  cause: Explanation['likelyCause'];
  action: SuggestedAction;
  text: (a: string, cur: string) => string;
}

const T: Record<string, ExplainTemplate> = {
  PLATFORM_NO_CHAIN_LEG: { cause: 'MISSING_ONCHAIN_DELIVERY', action: 'REPAY_ONCHAIN', text: (a, c) => `The platform shows this transaction as done but no matching Stellar payment of ${a} ${c} was observed on the anchor's accounts.` },
  PLATFORM_NO_BANK_LEG: { cause: 'MISSING_BANK_LEG', action: 'CHASE_BANK', text: (a, c) => `The platform shows this transaction as completed but no bank line of ${a} ${c} was found on the statements.` },
  DUPLICATE_CHAIN_PAYMENT: { cause: 'DUPLICATE_PROCESSING', action: 'REVIEW_WRITE_OFF', text: (a, c) => `More than one Stellar payment of ${a} ${c} carries this transaction's keys; the extra payment is an overpayment to recover or write off.` },
  DUPLICATE_PAYOUT: { cause: 'DUPLICATE_PROCESSING', action: 'CHASE_BANK', text: (a, c) => `The payout of ${a} ${c} was debited more than once; ask the bank to recall the duplicate.` },
  SHORT_PAYOUT: { cause: 'PARTIAL_OR_SHORT_PAYOUT', action: 'CHASE_BANK', text: (a, c) => `The bank paid out ${a} ${c}, less than the amount quoted to the customer.` },
  AMOUNT_MISMATCH: { cause: 'SENDER_ERROR', action: 'CHASE_BANK', text: (a, c) => `The bank credit of ${a} ${c} differs from the deposit amount beyond the fee schedule.` },
  WRONG_MEMO: { cause: 'SENDER_ERROR', action: 'REFUND_USER', text: (a, c) => `An inbound payment of ${a} ${c} carries a memo that matches no open transaction.` },
  UNMATCHED_CHAIN_IN: { cause: 'UNIDENTIFIED_FUNDS', action: 'REFUND_USER', text: (a, c) => `An inbound Stellar payment of ${a} ${c} matches no platform transaction.` },
  UNMATCHED_CHAIN_OUT: { cause: 'UNKNOWN', action: 'REVIEW_WRITE_OFF', text: (a, c) => `An outbound Stellar payment of ${a} ${c} matches no platform transaction.` },
  UNMATCHED_BANK_CREDIT: { cause: 'UNIDENTIFIED_FUNDS', action: 'CHASE_BANK', text: (a, c) => `A bank credit of ${a} ${c} has no usable reference and no open deposit fits it.` },
  UNMATCHED_BANK_DEBIT: { cause: 'UNKNOWN', action: 'CHASE_BANK', text: (a, c) => `A bank debit of ${a} ${c} matches no payout.` },
  STATUS_MISMATCH: { cause: 'STATUS_NOT_UPDATED', action: 'NONE', text: (a, c) => `The platform marks this transaction as failed but its Stellar delivery of ${a} ${c} succeeded; correct the status.` },
  REVERSAL_OPEN: { cause: 'BENEFICIARY_BANK_RETURN', action: 'REFUND_USER', text: (a, c) => `A payout of ${a} ${c} came back from the beneficiary bank while the platform still shows it as completed; the funds are owed again.` },
  STALE_PENDING: { cause: 'PROCESSING_DELAY', action: 'CHASE_BANK', text: (a, c) => `This transaction of ${a} ${c} has been waiting on the anchor longer than the configured limit.` },
  NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING: { cause: 'UNAUTHORISED_OR_NON_CUSTOMER_DEBIT', action: 'TOP_UP_SAFEGUARDING', text: (a, c) => `A debit of ${a} ${c} left the safeguarding account without a customer transaction or allowed sweep; top up and investigate.` },
  STATEMENT_MISSING: { cause: 'MISSING_STATEMENT', action: 'CHASE_BANK', text: () => `No statement was received for this account; the safeguarding resource cannot be computed from the bank.` },
  TRAVEL_RULE_MISSING: { cause: 'MISSING_TRAVEL_RULE_DATA', action: 'REQUEST_TRAVEL_RULE_DATA', text: (a, c) => `A SEP-31 receive of ${a} ${c} has no valid travel-rule reference.` },
};

const TR_SUB: Record<string, string> = {
  EMPTY: 'the reference is empty',
  MALFORMED: 'the reference is neither an envelope hash nor a provider id',
  NOT_IN_LOG: 'the reference is not in the imported travel-rule log',
};

export function heuristicExplanation(input: ExplainInput): Explanation {
  const e = input.exception;
  const t = T[e.type];
  const cur = e.currency ?? '';
  const dec = cur === 'EUR' ? 2 : 7;
  const a = e.amount ? formatMoney(BigInt(e.amount), dec) : '';
  let summary = t.text(a, cur).replace(/ of {2}/, ' ').replace(/  +/g, ' ');
  if (e.type === 'TRAVEL_RULE_MISSING' && e.subReason) summary += ` Sub-reason ${e.subReason}: ${TR_SUB[e.subReason] ?? e.subReason}.`;
  return {
    exceptionId: e.id,
    type: e.type as ExceptionType,
    summary: summary.slice(0, 400),
    likelyCause: t.cause,
    suggestedAction: t.action,
    evidenceIds: [...e.evidenceIds],
    provider: 'heuristic',
  };
}

export class HeuristicProvider implements AiProvider {
  readonly name = 'heuristic' as const;
  async proposeMatches(input: ProposeInput): Promise<ProposeOutput> {
    return { proposals: heuristicProposals(input), provider: 'heuristic' };
  }
  async explainException(input: ExplainInput): Promise<Explanation> {
    const e = heuristicExplanation(input);
    const g = guardExplanation(input, e);
    if (!g.ok) throw new Error(`heuristic explanation failed its own guard: ${g.errors.join('; ')}`);
    return e;
  }
  async draftReport(input: ReportInput): Promise<{ markdown: string; provider: string; fellBack: boolean }> {
    return { markdown: renderTemplate(input.kind, input.figures), provider: 'template', fellBack: false };
  }
}
