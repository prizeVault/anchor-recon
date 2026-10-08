// One interface, two implementations (HeuristicProvider, LlmProvider).
// The provider only proposes: matches with a score and band, exception
// explanations, and report drafts. It never decides a match, closes an
// exception, computes a figure or signs anything.

import type { BankLine, ChainOp, Explanation, PlatformTx, ProposalKind, ReconException } from '../types.js';
import type { Customer } from '../match/context.js';
import type { Tolerances } from '../match/tolerance.js';

export interface BankLineView {
  id: string;
  account: string;
  direction: 'credit' | 'debit';
  amount: string; // cents
  currency: string;
  valueDate: string;
  narrative: string;
  counterparty?: string;
  endToEndId?: string;
  charges?: string;
}

export interface PlatformTxView {
  id: string;
  sep: number;
  kind: string;
  status: string;
  amountIn: string;
  assetIn: string;
  amountOut: string;
  assetOut: string;
  bankRef?: string;
  externalId?: string;
  memo?: string;
  memoType?: string;
  anchorDate: string;
  customerNameTokens: string[];
}

export interface ChainOpView {
  id: string;
  txHash: string;
  day: string;
  direction: 'in' | 'out';
  account: string;
  asset: string;
  amount: string; // 7 dp units
  memo?: string;
  memoType?: string;
}

export interface ProposeInput {
  day: string;
  block: {
    bankLines: BankLineView[];
    platformTxs: PlatformTxView[];
    chainOps: ChainOpView[];
    splitHints: { platformId: string; lineIds: string[] }[];
  };
  feeSchedule: { feeAbs: string; feeBps: string; fxBandBps: string; charges: string[] };
  holidays: string[];
}

export interface ProposalOut {
  bankLineIds: string[];
  chainOpIds: string[];
  platformId: string;
  kind: ProposalKind;
  score: number;
  band: 'high' | 'review';
  reasons: string[];
}

export interface ProposeOutput {
  proposals: ProposalOut[];
  provider: 'heuristic' | 'llm';
}

export interface ExplainInput {
  exception: ReconException;
  evidence: Record<string, unknown>;
}

export interface ReportInput {
  kind: 'daily' | 'monthly';
  figures: Record<string, unknown>;
}

export interface AiProvider {
  readonly name: 'heuristic' | 'llm';
  proposeMatches(input: ProposeInput): Promise<ProposeOutput>;
  explainException(input: ExplainInput): Promise<Explanation>;
  draftReport(input: ReportInput): Promise<{ markdown: string; provider: string; fellBack: boolean }>;
}

export function bankLineView(l: BankLine): BankLineView {
  return {
    id: l.id,
    account: l.account,
    direction: l.direction,
    amount: l.amount.toString(),
    currency: l.currency,
    valueDate: l.valueDate,
    narrative: l.narrative,
    counterparty: l.counterparty,
    endToEndId: l.endToEndId,
    charges: l.charges?.toString(),
  };
}

export function chainOpView(o: ChainOp): ChainOpView {
  return { id: o.opId, txHash: o.txHash, day: o.day, direction: o.direction, account: o.account, asset: o.asset, amount: o.amount.toString(), memo: o.memo, memoType: o.memoType };
}

export function platformTxView(p: PlatformTx, customers: Map<string, Customer>, anchorDate: string, pseudo?: (t: string) => string): PlatformTxView {
  const tokens = (p.customerRef && customers.get(p.customerRef)?.tokens) || [];
  return {
    id: p.id,
    sep: p.sep,
    kind: p.kind,
    status: p.status,
    amountIn: p.amountIn.toString(),
    assetIn: p.assetIn,
    amountOut: p.amountOut.toString(),
    assetOut: p.assetOut,
    bankRef: p.bankRef,
    externalId: p.externalId,
    memo: p.memo,
    memoType: p.memoType,
    anchorDate,
    customerNameTokens: pseudo ? tokens.map(pseudo) : tokens,
  };
}

export function feeView(t: Tolerances): ProposeInput['feeSchedule'] {
  return { feeAbs: t.feeAbs.toString(), feeBps: t.feeBps.toString(), fxBandBps: t.fxBandBps.toString(), charges: t.charges.map(String) };
}

export function bandOf(score: number): 'high' | 'review' | undefined {
  if (score >= 0.9) return 'high';
  if (score >= 0.6) return 'review';
  return undefined;
}
