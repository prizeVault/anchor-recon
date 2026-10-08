# Memo and reference conventions (proposed community convention)

**Status: proposal.** Nobody outside this project has reviewed it. It is meant to be posted as a
GitHub discussion on the Anchor Platform repository (see `VALIDATION.md`, week 2). The matcher
works without it, but the share of deterministic matches depends on it.

## 1. The bank reference token: `AR-XXXXXXXX-C`

The anchor puts one token in every fiat instruction it controls: the deposit instructions it
shows the customer (SEP-6/24 `how` / `instructions`), and the remittance information of every
payout it sends.

```
AR-  8 Crockford base32 characters  -  1 check character
```

- **Body:** the first 40 bits of `sha256(platform transaction id)`, in Crockford base32
  (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`). The Platform transaction id alone reproduces the token,
  so the anchor does not need to store it (though it may, as `bank_ref`).
- **Check character:** Luhn mod 32 over the same alphabet. It catches every single-character
  substitution and most adjacent transpositions. Crockford's own mod-37 check symbols
  (`*~$=U`) are avoided because bank narratives strip them.
- **Parsing tolerates** missing or space-separated dashes, lower case, and the Crockford aliases
  `O→0`, `I/L→1` and `U→V`.
- **Why 13 characters.** A token this short survives the 18–35-character remittance fields that
  many banks truncate. Even when it is truncated, the prefix still ranks the right candidate
  (reference similarity `0.5 + 0.5 × prefix/13`).
- **Collision space.** 40 bits is about 1.1 × 10¹². The matcher never relies on the token alone:
  a deterministic match also requires the exact amount.

A token whose check digit fails is never matched deterministically. If exactly one open
transaction's token is one edit away, the fuzzy pass proposes it with reference score 0.9. The
analyst still decides.

`app/src/core/reference.ts` implements the token, and `app/test/reference.test.ts` tests it.

## 2. On-chain memos per flow

| Flow | Leg | Key the matcher uses |
|---|---|---|
| SEP-24 / SEP-6 withdrawal | customer → anchor receive account | the anchor-issued `withdraw_memo` / `memo` with its `memo_type` (text, id, hash). Type-aware equality: hash memos compare as bytes, hex or base64; id memos compare as integers |
| SEP-24 / SEP-6 deposit | anchor distribution → customer | the transaction hash recorded in `stellar_transactions[]` |
| SEP-6 deposit via claimable balance | create claimable balance | `claimable_balance_id` on the Platform record |
| SEP-31 receive | sending anchor → receive account | the Platform `memo`, or the muxed id of an `M…` destination (split into the base `G…` and the id at ingestion) |
| Refund | anchor → customer | the hashes in `refunds.payments[]` |

**Recommendation to anchors:** use a distinct memo per transaction, never a per-customer one, and
prefer `hash` or `id` memos over free text. Partner anchors sending SEP-31 payments should send
to the muxed account the receiver quotes, not rely on a text memo.

## 3. Bank end-to-end ids

If the anchor's payout rail carries an ISO 20022 end-to-end id, set it to the Platform
`external_transaction_id`. The deterministic pass matches `EndToEndId == external id` with the
exact amount before it looks at the narrative.

## 4. Travel-rule reference (SEP-31)

Store the travel-rule envelope reference on the Platform record (`travel_rule_ref` in the default
map). It must be either a 64-hex envelope hash or an id matching a configured provider pattern,
and it must appear in the imported provider log. Otherwise `TRAVEL_RULE_MISSING` is raised with
`EMPTY`, `MALFORMED` or `NOT_IN_LOG`. The EU threshold is zero, and the default
`travel_rule_threshold` is `0`.
