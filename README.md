# Anchor Recon

> **The on-chain part is thin, and that is deliberate.** An anchor that publishes the same signed
> daily hash on its website, or passes it through an RFC 3161 timestamping service or a public
> transparency log, gets most of what the Soroban registry gives. The registry adds four things:
> a ledger timestamp the anchor cannot backdate; no overwrite or silent deletion, because a
> correction is a new visible version; a missed-day flag that anyone can trigger; and one place
> for an auditor's countersignature and the signer-rotation history. The value of this project
> is in the off-chain matcher and review workflow. If you only read one thing, read
> `ARCHITECTURE.md` "The no-chain alternative".

**Problem.** Every cash-in and cash-out at a Stellar anchor leaves three records: the Anchor
Platform (SEP-6/24/31) transaction, the Stellar payment and the bank line. A live Stellar project
puts it this way: "nobody can answer 'did every withdrawal we started get exactly one matching
on-chain transfer, and did the anchor pay out what it quoted?'" (research 11-R5; Quay issue #243).
Wrong memos, duplicates and short payouts go unnoticed. Since 7 May 2026, UK payment and e-money
firms under CASS 15 must reconcile safeguarded funds every reconciliation day, top up any
shortfall and file a monthly return. MiCA requires daily reconciliation for CASPs (researched,
11-R5; the MiCA article number is unchecked).

**User.** The operations or finance analyst at a Stellar anchor or stablecoin PSP who runs the
daily cash-in/cash-out book. Secondary: the compliance officer who signs the daily safeguarding
reconciliation. Tertiary: the external auditor and partner (sending) anchors.

## What the MVP does

`recon` is a TypeScript CLI with five stages. A Soroban contract, `recon_registry`, records the
result of the fifth.

1. **Ingest.** Anchor Platform exports (through a `platform-map.json` of JSON paths), Horizon
   operations (payments, path payments, claimable-balance create/claim, M-address split), an RPC
   `getEvents` fallback, CAMT.053 statements and profile-driven bank CSVs, all into one store.
   Amounts are bigint minor units throughout. There are no floats.
2. **Match.**
   - **Deterministic pass:** tx hash, claimable-balance id, type-aware memo, SEP-31 muxed id,
     end-to-end id, and the anchor's check-digited bank reference `AR-XXXXXXXX-C`, all with exact
     amounts.
   - **Duplicate check:** a duplicate key raises an exception instead of matching.
   - **Fuzzy pass (`AiProvider.proposeMatches`):** scored proposals for split deposits (subset
     sum of up to 3 lines), fee and FX differences, reversal pairs, truncated narratives and
     1-edit reference typos caught by the check digit. Each proposal has a confidence band:
     high ≥ 0.90, review 0.60 to 0.90.
3. **Review.** A named analyst accepts or rejects every non-deterministic match. "Accept the high
   band" records a deterministic 10% re-check sample. Every exception (17 type codes, including
   the absorbed SEP-31 travel-rule check) carries an explanation, a likely cause and a suggested
   action.
4. **Report.** The tool computes the safeguarding requirement from configured transaction states
   and the resource from the designated account's closing balance (CLBD), then derives the
   shortfall or excess. It drafts a daily report and a REP027-style monthly draft from those
   figures. A numbers guard checks every draft, and a draft stays `DRAFT` until a named person
   approves it.
5. **Attest.** The tool builds a Merkle root over salted, JCS-canonical leaves and writes the day's
   private pack. The signer calls `recon_registry.attest` or `restate`. Anyone can call
   `mark_gaps`, and an auditor can `countersign` after `recon verify`. A partner anchor can check
   that one SEP-31 payment is included, using an inclusion proof and without seeing the rest of
   the day.

The AI never decides anything. `HeuristicProvider` does all three AI tasks (match proposals,
exception explanations, report drafts) deterministically, and every test uses it. `LlmProvider`
calls the Anthropic Messages API only when `LLM_API_KEY` is set. It re-scores only review-band
blocks, customer name tokens are pseudonymised by default, and any output that fails the schema
or the guard is replaced by the heuristic or template output.

## Quickstart

```bash
cargo test                        # contract: unit, negative, property (300 random sequences) and scenario tests
stellar contract build            # target/wasm32v1-none/release/recon_registry.wasm
cd app && npm install && npm test # 103 offline tests (node --test); no network, no key
npm run build && node dist/src/cli.js simulate --days 30
```

`simulate` runs the whole month over the committed seed. It ingests, matches, applies the
scripted analyst decisions, approves reports, builds packs, and attests into an in-memory model
of the registry: the rotation, a gap, a late attestation, a restatement and a countersignature.
It then prints seed-only metrics. The steps and the expected output are in `DEMO.md`.

## Results on the simulated seed (seed-only, not a performance claim)

The seed is **simulated**, and it was written by the same team as the matcher. The numbers show
that the pipeline does what the spec asks on data built to exercise it. They are not a measure of
how it performs on a real anchor's books.

| Check (30 days, 400 platform txs, 408 chain ops, 461 bank lines) | Result |
|---|---|
| Planted breaks K01 to K12 raised with the expected type | 12/12 |
| Travel-rule cases T01 to T03 with the right sub-reason (EMPTY, NOT_IN_LOG, MALFORMED) | 3/3 |
| Exceptions outside the planted set | 0 |
| Matchable-but-hard cases matched, with no exception | 57/57 (55 from the spec plus 2 decoys) |
| Proposals: high / review / accepted / rejected | 32 / 10 / 40 / 2 |
| Proposal precision (accepted / proposed) | 95.2% (the 2 wrong ones were the ambiguous pair, rejected and matched by hand) |
| Fuzzy-pass recall on hard cases needing a proposal | 95.2% (40/42) |
| Customer legs matched by the deterministic pass | 94.8% |
| Shortfall | 341250 cents on 2026-08-18 only (the "OFFICE RENT" debit), cleared by the top-up on 08-19 |
| Registry model | gap on 2026-08-20 then attested late; 1 restatement (08-12, late Bank B line); 21 attested days |

## Layout

```
stellar/anchor-recon/
  README.md ARCHITECTURE.md VALIDATION.md DEMO.md .env.example
  Cargo.toml                         workspace + release profile
  contracts/recon_registry/          Soroban contract; src/test.rs (unit/negative/vectors),
                                     src/test_props.rs (property), src/test_scenario.rs, test_snapshots/
  app/                               TypeScript CLI `recon` (Node 22)
    src/ingest/                      platform, horizon, rpcEvents, camt053, csvBank, normalise
    src/match/                       deterministic, candidates, split, reversal, tolerance, engine, context
    src/exceptions/                  types, classify, travelRule
    src/safeguarding/                requirement, resource
    src/attest/                      leaf, merkle, entryHash, pack, registryModel, registryClient, stellarToml, vectors
    src/ai/                          provider, heuristic, llm, schemas, guard, template, pseudonymise
    src/report/                      figures, daily, monthly
    src/store/                       Store, MemoryStore, JsonlStore
    src/seed/generate.ts             deterministic seed generator (fixed seed)
    src/simulate.ts src/cli.ts
    test/                            16 node --test suites, fixtures/ (matcher fixtures), vectors/ (shared with Rust)
  data/seed/                         SIMULATED seed (platform/, chain/, bank-a/ CAMT.053, bank-b/ CSV, configs, expected.json)
  docs/                              MEMO-CONVENTIONS, MATCHING-RULES, EXCEPTION-TYPES, ATTESTATION-FORMAT,
                                     ANCHOR-PLATFORM-MAPPING, REGULATORY-MAPPING, STELLAR-TOML, DATA-PROTECTION
  scripts/                           build.sh, deploy-testnet.sh, e2e-testnet.sh (NOT executed here)
```

## Status

**functional locally.** The contract's tests pass under `cargo test`, `stellar contract build`
produces the wasm, and the app's 103 offline tests and the 30-day simulation pass in this
environment. The scripts `scripts/deploy-testnet.sh` and `scripts/e2e-testnet.sh` are
**testnet-ready**. 

**Deployed Contract on Testnet:**
[CCBIJG32SUNWL4AUEC7SXS6SCIL6LHVXQLAIWPEV3YLCOI2CYBSHA5VW](https://stellar.expert/explorer/testnet/contract/CCBIJG32SUNWL4AUEC7SXS6SCIL6LHVXQLAIWPEV3YLCOI2CYBSHA5VW)

Nothing is deployed to mainnet. No anchor, analyst, auditor or partner has used
or seen the tool. No interviews have taken place, and nothing has been measured on real data. The
on-chain part is thin by design (see the note at the top), and whether any anchor will publish a
daily hash and shortfall at all is killer question 2 in `VALIDATION.md`.
 
