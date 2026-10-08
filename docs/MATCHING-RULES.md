# Matching rules

Amounts are bigint minor units everywhere: bank amounts at the currency's decimals, and chain
amounts at 7 decimals. No floats are used in any comparison.

## 1. Deterministic pass (`app/src/match/deterministic.ts`)

Each item is used at most once. A match needs an exact key **and** the exact amount.

**Platform ↔ chain**, in order:

1. The operation's transaction hash is in `stellar_transactions[]`.
2. The claimable-balance id.
3. Memo equality (type-aware, see `MEMO-CONVENTIONS.md`), with the same asset, account and
   amount.
4. The SEP-31 muxed id equals the Platform memo.

**Platform ↔ bank**, in order:

1. The end-to-end id equals `external_transaction_id`.
2. A **valid** `AR-` token equals the transaction's bank reference.

Deposits compare `amount_in` with a credit. Withdrawals and receives compare `amount_out` with a
debit.

**Refund and claim legs.** Refund payments listed in `refunds.payments[]` and claims of the
transaction's claimable balance attach to the transaction's group.

**Duplicates.** If one transaction matches two or more chain operations (or two or more payout
debits) by an exact key, none of them is matched. `DUPLICATE_CHAIN_PAYMENT` or
`DUPLICATE_PAYOUT` is raised instead. For duplicate *credits*, the earliest line matches and the
other stays as a leftover.

**Internal lines.** Sweeps (`^SWEEP TO/FROM`), interest, safeguarding top-ups and bank charges
match the patterns in `safeguarding.json`. They become internal groups: not customer legs, but
still leaves in the pack.

## 2. Reversals (`reversal.ts`)

A reversal pair is two opposite-direction lines on the same account for the same amount, within
5 business days, where `RvslInd` is set or the narrative matches
`RETURN|RTN|REVERSAL|R0\d|AC0\d`.

- If the linked transaction is `refunded`, the pair becomes a `reversal_pair` proposal for the
  analyst.
- Otherwise `REVERSAL_OPEN` is raised, and the amount counts towards the safeguarding
  requirement while the reversal is open (`include_open_reversals`).

## 3. Fuzzy pass (`candidates.ts`, `split.ts`, `tolerance.ts`, `ai/heuristic.ts`)

**Blocking.** A leftover bank line and an open transaction are candidates when all of these
hold:

- they have the same direction;
- the value date is between −1 and +3 business days of `started_at` (deposits) or `completed_at`
  (payouts);
- the amount is explained by the tolerance below.

Leftover chain operations need the same account, asset and exact amount. Candidates form
connected blocks, and each block is scored separately.

**Tolerance** (`fee-schedule.json`):

- **Fee difference.** `|Δ| ≤ max(fee_abs, fee_bps × amount)`, **and** Δ equals a listed bank
  charge or the entry's own CAMT `Chrgs`.
- **FX difference.** SEP-31 payouts only: `|Δ| / amount_out ≤ fx_band_bps` (50 bps in the seed).
- Any other difference is unexplained, and no proposal is made.

**Split deposits.** A subset sum over at most 3 leftover credits from the same normalised
counterparty, within 2 business days, that equals `amount_in` within the fee tolerance.

**Score.**

```
score = 0.40 × reference + 0.25 × amount + 0.15 × date + 0.20 × name
```

| Part | Scoring |
|---|---|
| Reference | 1 for a valid token or an end-to-end id match. 0.9 for an invalid token one edit from the transaction's token (the check digit caught the typo). 0.5 + 0.5 × prefix/13 for a truncated prefix. 0.5 × Damerau-Levenshtein similarity for another AR-like token. Chain memos: 1 if exact, 0.8 × DL similarity otherwise. |
| Amount | 1 if exact, 0.8 for an explained fee or FX difference. |
| Date | 1 − \|business days\| / 4 |
| Name | Jaro-Winkler over token sets, aware of truncation, against the local customer export. |

**Bands.** High ≥ 0.90, review 0.60 to 0.90, and nothing below 0.60. Selection is greedy by
score, with ties broken by platform id, and each item is used once.

**LLM (optional).** It re-scores only blocks that contain a review-band proposal. The guard
rejects any output that:

- names unknown ids;
- has amounts that do not reconcile under the tolerance;
- uses a kind that contradicts the arithmetic.

When the guard rejects the output, the heuristic proposal stands.

## 4. Review

- Every non-rule match needs a named decision.
- `--accept-band high` accepts the day's high band and marks a deterministic sample of 10%
  (rounded up, at least one), seeded by day, for re-checking.
- A rejected proposal frees its items for the next run.
- A pending proposal covers its transaction's missing leg, so no `PLATFORM_NO_*_LEG` is raised
  while it waits.
- `attest` refuses while any proposal for the day is undecided.

## 5. Hold before an exception

Leftover items wait `hold_business_days` (1 in the seed) before they become exceptions. This
keeps the first part of a split deposit or a next-day payout from being reported as a break.
Duplicates, reversals, non-customer debits from safeguarding, travel-rule gaps and missing
statements are raised immediately.

## 6. Which day a group belongs to

A group belongs to the latest value date or ledger date among its items. If a late item joins a
group of an already attested day, that day's leaf set changes, and it is restated with
`LATE_BANK_ITEM`.
