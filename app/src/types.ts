// Domain model. Amounts are bigint minor units of the named asset
// (EUR cents; EURC/USDC in 7-decimal stroop units). Days are ISO dates.

export type Sep = 6 | 24 | 31;
export type Kind = 'deposit' | 'withdrawal' | 'receive';

export interface PlatformTx {
  id: string;
  sep: Sep;
  kind: Kind;
  status: string;
  amountIn: bigint;
  assetIn: string; // asset code: EUR | EURC | USDC
  amountOut: bigint;
  assetOut: string;
  amountFee: bigint;
  assetFee: string;
  assetOnChain: string;
  assetFiat: string;
  memo?: string;
  memoType?: 'text' | 'id' | 'hash';
  stellarTxHashes: string[];
  refundTxHashes: string[];
  claimableBalanceId?: string;
  externalId?: string;
  bankRef?: string;
  customerRef?: string;
  travelRuleRef?: string;
  quoteId?: string;
  quoteRate?: string; // decimal string, fiat per on-chain unit (SEP-38)
  startedAt: string; // ISO timestamp
  completedAt?: string;
  updatedAt?: string;
  /** Day of the export snapshot this record came from. */
  asOf?: string;
}

export type ChainOpType = 'payment' | 'path_payment' | 'create_cb' | 'claim_cb';

export interface ChainOp {
  opId: string;
  txHash: string;
  ledgerCloseTime: string;
  type: ChainOpType;
  from: string;
  to: string;
  asset: string; // asset code
  amount: bigint; // 7 dp
  memo?: string;
  memoType?: 'text' | 'id' | 'hash';
  muxedId?: string;
  cbId?: string;
  /** Which of our accounts this op touched and the direction. */
  account: string;
  direction: 'in' | 'out';
  day: string;
}

export interface BankLine {
  id: string;
  account: string; // alias
  direction: 'credit' | 'debit';
  amount: bigint; // cents, positive
  currency: string;
  bookingDate: string;
  valueDate: string;
  narrative: string; // normalised
  rawNarrative: string;
  counterparty?: string;
  endToEndId?: string;
  reversal: boolean;
  charges?: bigint;
  day: string; // statement day
}

export interface Balance {
  account: string;
  date: string;
  type: 'OPBD' | 'CLBD';
  amount: bigint; // signed cents
  source: 'statement' | 'manual';
}

export type Method = 'rule' | 'heuristic' | 'llm' | 'analyst';

export interface Group {
  id: string;
  day: string;
  kind: 'match';
  method: Method;
  leg: 'chain' | 'bank' | 'refund' | 'reversal' | 'claim';
  rule?: string;
  platformIds: string[];
  chainRefs: string[]; // "txHash:opId"
  chainOpIds: string[];
  bankLineIds: string[];
  amounts: Record<string, string>;
  decidedBy?: string;
  proposalId?: string;
}

export type ProposalKind = 'single' | 'split' | 'fee_diff' | 'fx_diff' | 'reversal_pair';
export type Band = 'high' | 'review';

export interface Proposal {
  id: string;
  day: string;
  bankLineIds: string[];
  chainOpIds: string[];
  platformId: string;
  kind: ProposalKind;
  score: number; // 0..1, three decimals
  band: Band;
  reasons: string[];
  provider: 'heuristic' | 'llm';
  status: 'pending' | 'accepted' | 'rejected';
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
  sampled?: boolean;
}

export type ExceptionType =
  | 'PLATFORM_NO_CHAIN_LEG'
  | 'PLATFORM_NO_BANK_LEG'
  | 'DUPLICATE_CHAIN_PAYMENT'
  | 'DUPLICATE_PAYOUT'
  | 'SHORT_PAYOUT'
  | 'AMOUNT_MISMATCH'
  | 'WRONG_MEMO'
  | 'UNMATCHED_CHAIN_IN'
  | 'UNMATCHED_CHAIN_OUT'
  | 'UNMATCHED_BANK_CREDIT'
  | 'UNMATCHED_BANK_DEBIT'
  | 'STATUS_MISMATCH'
  | 'REVERSAL_OPEN'
  | 'STALE_PENDING'
  | 'NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING'
  | 'STATEMENT_MISSING'
  | 'TRAVEL_RULE_MISSING';

export type Resolution =
  | 'CHASED_BANK'
  | 'REFUNDED_USER'
  | 'REPAID_ONCHAIN'
  | 'TOPPED_UP'
  | 'PARTNER_CONFIRMED'
  | 'TR_DATA_RECEIVED'
  | 'WRITTEN_OFF_APPROVED'
  | 'FALSE_POSITIVE';

export interface ReconException {
  id: string;
  type: ExceptionType;
  subReason?: string;
  day: string; // day raised
  evidenceIds: string[];
  amount?: string; // minor units as string
  currency?: string;
  openedOn: string;
  status: 'open' | 'closed';
  resolution?: Resolution;
  closedBy?: string;
  closedOn?: string;
  explanation?: Explanation;
}

export type SuggestedAction =
  | 'CHASE_BANK'
  | 'REFUND_USER'
  | 'REPAY_ONCHAIN'
  | 'TOP_UP_SAFEGUARDING'
  | 'CONTACT_PARTNER_ANCHOR'
  | 'REQUEST_TRAVEL_RULE_DATA'
  | 'REVIEW_WRITE_OFF'
  | 'NONE';

export interface Explanation {
  exceptionId: string;
  type: ExceptionType;
  summary: string;
  likelyCause: string;
  suggestedAction: SuggestedAction;
  evidenceIds: string[];
  provider: 'heuristic' | 'llm';
}

export interface FeeSchedule {
  currency: string;
  fee_abs: string; // minor units
  fee_bps: number;
  bank_charges: { code: string; amount: string; description: string }[];
  fx_band_bps: number;
}

export interface SafeguardingConfig {
  currency: string;
  safeguarding_accounts: string[];
  owed_states: { kind: Kind; statuses: string[]; amount: 'amountIn' | 'amountOut' }[];
  include_open_reversals: boolean;
  allowed_debit_patterns: string[];
  internal_credit_patterns: string[];
  expected_accounts: string[];
  stale_days: number;
  hold_business_days: number;
  travel_rule_threshold: string; // minor units of the receive asset
  travel_rule_provider_patterns: string[];
  holidays: string[];
  anchor_accounts: { receive: string; distribution: string };
}

export interface DayInputs {
  day: string;
  platform: PlatformTx[];
  chain: ChainOp[];
  bank: BankLine[];
  balances: Balance[];
}
