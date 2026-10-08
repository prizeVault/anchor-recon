# Anchor Platform mapping

**Verify-first item (a), unverified.** The field names below are working assumptions for Anchor
Platform 4.8.0's transaction object (SEP-6/24/31). They were **not** checked against the Platform
API schema in this build. Every field is therefore read through `platform-map.json`, which uses
JSON paths, and `a|b` means the first one present. A different Platform version, or a business
server's own export, needs only a new map, not code.

| Internal field | Default path | Used for |
|---|---|---|
| `id` | `id` | the transaction id; the `AR-` token is derived from it |
| `sep` / `kind` | `sep` / `kind` | 6, 24 or 31; deposit, withdrawal or receive |
| `status` | `status` | the leg due-rules, the safeguarding owed states, `STALE_PENDING`, `STATUS_MISMATCH` |
| `amountIn` / `assetIn` | `amount_in.amount` / `amount_in.asset` | the deposit bank credit; the withdrawal and receive chain leg |
| `amountOut` / `assetOut` | `amount_out.amount` / `amount_out.asset` | the deposit chain leg; the payout bank debit; the FX band |
| `amountFee` / `assetFee` | `amount_fee.amount\|fee_details.total` / `amount_fee.asset\|fee_details.asset` | reporting only |
| `memo` / `memoType` | `memo` / `memo_type` | chain memo equality (`MEMO-CONVENTIONS.md`) |
| `stellarTransactions` | `stellar_transactions` | the chain hash keys |
| `refundPayments` | `refunds.payments` | refund legs |
| `claimableBalanceId` | `claimable_balance_id` | SEP-6 claimable-balance deposits |
| `externalId` | `external_transaction_id` | the bank end-to-end id |
| `bankRef` | `bank_ref` | **custom:** the `AR-` token, if stored; otherwise derived from `id` |
| `customerRef` / `receiverRef` | `customers.sender.id\|customers.receiver.id` / `customers.receiver.id` | the name lookup in the local customer export |
| `travelRuleRef` | `travel_rule_ref` | **custom:** the SEP-31 travel-rule check |
| `quoteId` | `quote_id` | SEP-38 (not ingested separately in the MVP) |
| `startedAt` / `completedAt` / `updatedAt` | `started_at` / `completed_at` / `updated_at` | the candidate date windows; the status-change time |

**Notes and open questions**

- `bank_ref` and `travel_rule_ref` are **not** Platform fields. They are assumed to come from the
  anchor's business server, or from a join done before export.
- Amounts arrive as decimal strings and are converted at the asset's decimals. A value with more
  decimals than allowed is rejected, not rounded.
- A newer record for the same `id` replaces the old snapshot. When the status changes, the
  status-change time (`statusSince`) is reset.
- The online path (`GET /transactions` on the Platform API) exists in `ingest/platform.ts`, but no
  test exercises it.
- **Horizon.** Claimable-balance ids appear on Horizon *effects*, not on the create operation
  itself (verify-first item (d)). The seed fixture carries `balance_id` on the operation. A
  production ingester should join the `claimable_balance_created` effect.
- SDP 7.0.0 audit tables are out of scope, and are a follow-up.
