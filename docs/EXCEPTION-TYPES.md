# Exception types

`app/src/exceptions/types.ts` defines the 17 types, and `classify.ts` and `travelRule.ts` raise
them. Every exception carries evidence ids (`ptx:`, `op:`, `bank:`, `stmt:`) and an amount where
one applies. It also carries an explanation with a summary, a likely cause and a suggested action,
drafted by the heuristic template or a guarded LLM.

"Held" means the item waits `hold_business_days` before it is raised. "Immediate" means it is
raised on the day it is seen.

| Type | Raised when | Timing |
|---|---|---|
| `PLATFORM_NO_CHAIN_LEG` | A transaction in a state that requires a chain leg has none, and no proposal is pending | held from the status change |
| `PLATFORM_NO_BANK_LEG` | The same, for the bank leg | held |
| `DUPLICATE_CHAIN_PAYMENT` | Two or more chain operations match one transaction by an exact key | immediate |
| `DUPLICATE_PAYOUT` | Two or more payout debits match one transaction by an exact key | immediate |
| `SHORT_PAYOUT` | A key-linked payout debit is below the expected amount and outside tolerance | held |
| `AMOUNT_MISMATCH` | Any other key-linked amount difference outside tolerance | held |
| `WRONG_MEMO` | An inbound payment to the receive account carries a memo that matches no open transaction | held |
| `UNMATCHED_CHAIN_IN` | Any other unmatched inbound chain operation | held |
| `UNMATCHED_CHAIN_OUT` | An unmatched outbound chain operation | held |
| `UNMATCHED_BANK_CREDIT` | An unmatched credit, not internal and not key-linked | held |
| `UNMATCHED_BANK_DEBIT` | An unmatched debit on a non-safeguarding account | held |
| `STATUS_MISMATCH` | The status is `error` or `expired`, but a chain delivery was observed | immediate |
| `REVERSAL_OPEN` | A reversal pair whose transaction is not `refunded` | immediate |
| `STALE_PENDING` | `pending_anchor` or `pending_external` for more than `stale_days` business days | on the day it becomes stale |
| `NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING` | A debit from a designated safeguarding account that matches no allowed pattern and no transaction | immediate |
| `STATEMENT_MISSING` | An expected account has no statement on a business day. This blocks the resource figure | immediate |
| `TRAVEL_RULE_MISSING` | A SEP-31 receive at or above the threshold has no valid, logged travel-rule reference. Sub-reason: `EMPTY`, `MALFORMED` or `NOT_IN_LOG` | on first sight |

**Resolution codes** (`recon review --close <id> --resolution <code> --by <name>`):
`CHASED_BANK`, `REFUNDED_USER`, `REPAID_ONCHAIN`, `TOPPED_UP`, `PARTNER_CONFIRMED`,
`TR_DATA_RECEIVED`, `WRITTEN_OFF_APPROVED`, `FALSE_POSITIVE`.

**Leaves.** An exception produces an "opened" leaf with its immutable facts on the day it is
raised. When it is closed, it produces a separate "closed" leaf (`<id>#closed`, with the status,
resolution and closer) on the closing day. Closing an exception therefore never changes an
earlier day's root.

## Failure handling around exceptions

- **A statement is missing.** `STATEMENT_MISSING` blocks the resource figure. The analyst either
  enters a portal balance, flagged `manual` in the report, or attests late. If the deadline
  passes first, anyone can flag the day as a gap.
- **The platform export is incomplete.** The bank and chain lines it should have matched surface
  as `UNMATCHED_*` exceptions. They never pass silently.
- **A wrong fuzzy match was accepted.** A later statement or an auditor exposes it. The fix is
  `attest --restate --reason error_correction`, and the original version stays visible.
- **The travel-rule log is stale.** This produces `NOT_IN_LOG` false positives. Re-import the log
  and close them with `TR_DATA_RECEIVED`.
- **The LLM output is invalid.** It fails the schema or a guard, and the template explanation is
  used instead.
