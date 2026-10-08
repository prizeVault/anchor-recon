# Anchor Recon architecture

> **The on-chain part is thin.** Publishing the same signed daily hash on the anchor's website, or
> through an RFC 3161 timestamping service or a transparency log, gets most of what the registry
> gives (Assumption). The registry adds four things: a ledger timestamp the anchor cannot backdate;
> append-only versions instead of overwrites; a permissionless missed-day flag; and one place for
> countersignatures and signer history. Everything else here is off-chain tooling.

## Verify-first items (each with a fallback)

| # | Item | Status | Fallback in the code |
|---|---|---|---|
| (a) | Anchor Platform 4.8.0 transaction JSON field names for SEP-6/24/31 (`amount_in{amount,asset}`, `amount_fee`/`fee_details`, `stellar_transactions[]`, `external_transaction_id`, `claimable_balance_id`, `refunds`, ...) | **Unverified working assumption** | Every field is read through `platform-map.json` (JSON paths, `a\|b` alternatives). Custom columns (`bank_ref`, `travel_rule_ref`) are assumed to come from the business server. See `docs/ANCHOR-PLATFORM-MAPPING.md`. |
| (b) | SEP-1 parsers ignore an unknown top-level `RECON_REGISTRY` key | **Unverified** | `[DOCUMENTATION] ORG_RECON_REGISTRY="<url ending in the contract id>"` is also accepted (`src/attest/stellarToml.ts`). |
| (c) | REP027 field list | **Not in the research** | The monthly output is labelled "REP027-style draft" and prints only the figures we compute. |
| (d) | Horizon account operations include `create_claimable_balance` / `claim_claimable_balance` with the balance id (RPC has no claimable-balance history) | **Unverified**: Horizon exposes the id on the effect, not the create operation | The deterministic pass matches the platform's own `claimable_balance_id` against the fixture field `balance_id`. A production ingester should join the effect or look up the balance's existence. |

## Components

```
Anchor Platform export ─┐
Horizon / RPC events ───┼─► ingest/normalise ─► Store (JsonlStore: var/state.json + var/<day>/*.jsonl)
CAMT.053 + bank CSV ────┘                          │
                                                   ▼
             deterministic pass (hash, memo, CB id, muxed id, AR- token, E2E id, exact amount)
                                                   │ leftovers
                                                   ▼
             reversal.ts (REVERSED_PAIR / REVERSAL_OPEN)
             candidates.ts + split.ts ─► AiProvider.proposeMatches (heuristic | LLM + guard) ─► proposals
                                                   │
             exceptions/classify (+ travelRule) ─► AiProvider.explainException (guarded)
                                                   │
                               analyst: recon review (accept / reject / accept-band / close / manual match)
                                                   │
             safeguarding: requirement vs CLBD resource ─► figures.json ─► draftReport (numbers guard) ─► approve
                                                   │
             leaves (salted, JCS) ─► Merkle root ─► pack.json (private, kept by the anchor)
                                                   │
             signer key ─► recon_registry.attest / restate ─► events ─► the tool's own index
  anyone ─► mark_gaps        auditor ─► countersign (after recon verify)
  partner ─► recon verify --item --proof         stellar.toml RECON_REGISTRY ⇄ registry.home_domain
```

| Module | Responsibility |
|---|---|
| `ingest/platform.ts` | Anchor Platform records → `PlatformTx` via `platform-map.json`. The online `GET /transactions` path exists but is not tested. |
| `ingest/horizon.ts` | Horizon operations → `ChainOp`. M-address split. 7-dp amounts → bigint. `ChainSource` interface. |
| `ingest/rpcEvents.ts` | SAC `transfer` events via `getEvents`. Recent days only (about 7 days of retention) and best-effort (CAP-67 emission). |
| `ingest/camt053.ts` | CAMT.053 with `fast-xml-parser`: balances, entries, `RvslInd`, multi-line `Ustrd`, charges. Re-importing a statement is a no-op. |
| `ingest/csvBank.ts` | Profile-driven CSV: BOM, delimiter, date format, decimal comma, debit/credit columns. A manual closing balance is flagged. |
| `match/deterministic.ts` | Exact-key pass, duplicate detection, refund and claim legs, internal lines (sweeps, charges, interest, top-ups). |
| `match/candidates.ts`, `split.ts`, `reversal.ts`, `tolerance.ts` | Blocking, subset-sum splits, reversal pairs, fee/FX tolerance. |
| `match/engine.ts` | Orchestration, review actions, high-band sample, manual match. |
| `exceptions/classify.ts`, `travelRule.ts` | 17 exception types, the one-business-day hold, the absorbed travel-rule check. |
| `safeguarding/*` | Requirement from configured owed states plus open reversals. Resource from CLBD. External reconciliation. |
| `ai/*` | Provider interface, heuristic, LLM, ajv schemas, guards, templates, pseudonymisation. |
| `report/*` | `figures.json` (every printed number), daily and monthly drafts, approval stamp. |
| `attest/*` | Leaves, Merkle tree and proofs, entry hash, packs, the registry model, the Soroban client, the `stellar.toml` binding. |

## Contract interface (`contracts/recon_registry`)

One instance per anchor and safeguarding currency. There is no token and no funds, no delete,
and no admin override of an attestation.

- **Types.** `Config`, `Counts` (12 × u32), `Attestation`, `Countersig`, `SignerEpoch`, `DayStatus`.
  `day` counts whole days since 1970-01-01 UTC, and `weekday(day) = (day + 3) % 7` (Mon = 0).
  Bit `1 << weekday` of `weekday_mask` marks an expected day. The deadline is
  `(d + 1) × 86400 + grace_secs`.
- **Writes.**
  - `init`: admin auth, once. The mask must be non-zero and < 128.
  - `attest`: current signer. Checks `BeforeStart`, `FutureDay`, `AlreadyAttested`,
    `NegativeShortfall`, `InvalidCounts`. Sets `late = now > deadline`.
  - `restate`: current signer. Reason must be 1 to 4. At most 16 versions per day.
  - `declare_non_recon_day` (signer) and `admin_declare_non_recon_day`: only before the deadline,
    on an expected and unattested day.
  - `mark_gaps(up_to)`: anyone. At most 62 days per call. Idempotent.
  - `set_auditor`, `countersign`: at most 8 per version, one per auditor.
  - `rotate_signer`: `SCHEDULED` or `COMPROMISE` with a `compromised_since` time.
  - `set_schedule`: applies from the gap cursor on.
  - `transfer_admin`: needs both admins' auth.
- **Views.** `config`, `signer`, `head`, `get`, `latest`, `versions`, `status`, `gaps` (range ≤ 62),
  `countersigs`, `is_suspect`, `signer_epoch`, `gap_cursor`.
- **Entry hash chain.**
  `sha256(prev ‖ day ‖ version ‖ root ‖ counts… ‖ shortfall:i128 ‖ report_hash ‖ signer_epoch ‖ attested_at ‖ late ‖ reason)`
  with every integer big-endian, over all versions in `seq` order. TypeScript
  (`attest/entryHash.ts`) and Rust read the same vectors in `app/test/vectors/`.
- **Events.** `attest`, `restate`, `cosign`, `gap`, `nonrecon`, `rotate`, `auditor`, each with
  `#[contractevent]`.
- **Errors.** `AlreadyInitialised=1` … `RangeTooLarge=19`, exactly as in the spec.
- **Storage.** Config, signer, epoch, head and gap cursor live in instance storage. Attestations,
  versions, gaps, non-recon days, auditors, countersignatures and signer history live in
  persistent storage. Every write extends the TTL to the network maximum.

`registryModel.ts` is a **model** of these rules in TypeScript, used by `simulate` and offline
verification. The contract itself is tested in Rust: unit tests, negative tests (auth and
deadlines), a 300-sequence xorshift property test and `scenario_month_of_reconciliation`.

## Data flow for one day

1. `recon ingest platform|chain|bank --day d` adds records. A platform record replaces the
   previous snapshot of that transaction, and a status change resets its `statusSince`.
2. `recon match --day d` runs the deterministic pass, then reversal detection, then the fuzzy
   pass per connected block of candidates, then classification. Leftover items wait one business
   day before they become exceptions, so a first split part or a next-day payout is not reported
   as a break. Duplicates, reversals, non-customer debits from safeguarding, missing statements
   and travel-rule gaps are raised at once. A pending proposal covers the missing leg of its
   transaction until someone decides it.
3. `recon review` accepts or rejects proposals (with a name), accepts a band (with a sample) or
   closes exceptions with a resolution code. A rejected proposal frees its items.
4. `recon report --day d` computes `figures.json` and drafts the report.
   `--approve <name>` stamps the name, the time and the figures hash.
5. `recon attest --day d` refuses while a proposal is undecided or the report is unapproved. It
   builds `pack.json` (leaves with salts, root, figures hash, report hash) and invokes `attest`, or
   `restate` with `--restate --reason`.
6. **Late items.** A group's day is the latest value date or ledger date of its items. If an
   item value-dated on an already attested day matches later (the seed's 08-12 Bank B line
   arrives on 08-13), that day's leaf set changes and it is restated with `LATE_BANK_ITEM`.
   Exception leaves are split into an "opened" leaf (immutable facts) and a "closed" leaf on the
   closing day, so closing an exception never rewrites an earlier root.

## Trust assumptions

- The registry proves *when* the anchor committed to *what*. It does not prove that the underlying
  records are true: garbage in gives a well-timestamped hash of garbage.
- A countersignature is only as good as the auditor. The CLI refuses to countersign unless
  `verify` passes first, but the contract cannot enforce that.
- The anchor holds the admin and signer keys. Rotation is public. A compromise marks later
  entries of the old epoch as suspect instead of deleting them, and the new signer restates them.
- Nothing personal goes on-chain. The counts and the shortfall are public by design. That reveals
  volume, and whether anchors accept that is a validation question.
- The matcher trusts the bank statement and the platform export as delivered. It detects
  inconsistencies between the three sources. It cannot detect a consistent lie told in all three.

## The no-chain alternative

The same daily pack, root and report hash could be signed with the anchor's `SIGNING_KEY` and
published at a URL listed in `stellar.toml`, then timestamped with RFC 3161 or appended to a
transparency log. That delivers tamper-evidence and a timestamp. It does not deliver:

- a missed-day flag that anyone can raise without trusting the anchor's web server;
- visible, ordered restatements with reasons;
- auditor countersignatures stored next to the attestation;
- a signer-rotation history that marks compromised entries.

Each of those could be rebuilt off-chain with more parties. The registry is kept because it
costs a sub-cent fee per day and sits next to the anchor's existing Stellar identity. That is
convenience and ecosystem fit, not necessity. If anchors refuse to publish a daily shortfall
(killer question 2), the registry becomes an optional private-log mode and the tool is matching
software.

## Limits

- **Horizon is nearing end-of-life**, and SDF's public Horizon keeps one year of history. Mainnet
  history comes from third parties. Ingestion must run daily and keep its own index (the
  JsonlStore plus the registry export).
- **RPC events are retained for about 7 days.** `rpcEvents.ts` refuses older days. Classic
  payments emit SAC events only where CAP-67 emission is enabled, so the fallback is best-effort.
- **State archival.** Old attestations need TTL extension or restoring. Every write extends the
  TTL to the maximum, but entries that are never touched again will archive. `recon registry
  export` plus the packs are the long-term record, and a restore is needed before on-chain reads
  of archived days.
- **One currency per registry** (EUR in the seed). Multi-currency needs one instance per currency.
- **Bank data:** file import only (CAMT.053, CSV). No open-banking APIs.
- **FX tolerance:** compared with `amountOut` from the platform. SEP-38 quote records are not
  ingested separately.
- **Scale:** the fuzzy pass blocks candidates by direction, date window and explainable amount,
  then scores each connected block. The simulated volume is about 20 transactions a day. Larger
  books have not been tried.
- **Monthly draft** from the CLI needs registry statuses. `simulate` produces it. The online path
  would read `status(day)` from the registry.
