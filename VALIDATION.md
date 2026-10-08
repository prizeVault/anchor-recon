# Anchor Recon validation

Evidence labels: **Researched** (a cited source in the research dossiers), **Observed** (seen in
this build), **Assumption** (team judgement), **Hypothesis** (to be tested), **Simulated** (seed
or demo data). Section ids refer to `research/`: `11-R5` is `11-round2-crosscutting-problems.md`
§R5, `01-§n` is `01-stellar-ecosystem.md` section n, and `10-R10` is
`10-round2-stellar-problems.md` §R10.

**Proof level now: 0.** This is an idea backed by researched evidence, plus a working build. No
anchor, analyst, compliance officer, auditor or partner anchor has seen it.

## Researched evidence

- A live Stellar project states the problem in its own issue tracker: "nobody can answer 'did
  every withdrawal we started get exactly one matching on-chain transfer, and did the anchor pay
  out what it quoted?'" Wrong memos, duplicates and short payouts go unnoticed (11-R5;
  https://github.com/determined-001/Quay/issues/243). This is the **only** direct demand signal:
  one community issue.
- Crypto finance teams have "no canonical statement, the API and CSV exports often disagree".
  Accountants spend hours tracing one USDC transfer (11-R5; eco.com and wag3s.io write-ups,
  which are vendor content).
- UK CASS 15 has applied since 7 May 2026: daily internal and external safeguarding
  reconciliation, immediate top-up of a shortfall, a monthly REP027 and resolution packs
  retrievable within 48 h (11-R5; fca.org.uk). MiCA requires daily reconciliation for CASPs
  (11-R5; a law-firm excerpt; the article number is **unchecked**).
- Anchor Platform 4.8.0 stores SEP-6/24/31 transactions and documents no reconciliation module
  (01-§5; the absence is marked `[estimate]` in 11-R5).
- There are "dozens" of anchors, and the Integration List names nine ramps (01-§5, 01-§13). The
  only Stellar prior art is `anchor-watch` (pre-alpha, 0 stars, 3 commits; 11-R5).
- SEP-31 specifies no travel-rule format. The EU threshold is zero from 2026 (10-R10).
- The data layer constrains ingestion. Horizon is nearing end-of-life, SDF's public Horizon keeps
  one year of history, RPC has no claimable-balance history, and RPC events are retained for
  about 7 days (01-§3, 01-§14).
- General finance-ops benchmarks (not anchors, and vendor-reported): account reconciliation takes
  20 to 50 h a month, and bank reconciliation takes 22% of capacity in 10–50-person firms (03-D1).
  These are only a proxy.

## Observed facts (this build)

- `cargo test`: 38 tests pass. They cover unit and negative tests (auth, deadlines, the 16-version
  and 8-countersignature caps, the 62-day scan limit), the shared entry-hash and weekday vectors,
  a 300-sequence random property test, and a one-month scenario.
- `stellar contract build` produces `recon_registry.wasm` (22,008 bytes).
- `npm test`: 103 offline tests pass (node --test). No network or API key is needed.
- `recon simulate --days 30` over the committed seed prints the figures in the Simulated section
  below.
- The CLI refuses `attest` while any proposal is undecided or the daily report is unapproved.
  This was observed in the single-day run in `DEMO.md`.
- A one-byte change in any pack fails `verify` (asserted in `scenario.test.ts`).
- **Not observed:** no testnet deployment. `scripts/deploy-testnet.sh` and `scripts/e2e-testnet.sh`
  are written and pass `bash -n`, but were not executed, because testnet RPC, Horizon and
  Friendbot were unreachable from the build environment. The same applies to
  `recon registry export` and the online `invoke` path: they compile but have never run against
  an RPC. The LLM provider has been exercised only against a fake client with recorded replies.

## Team assumptions

- The analyst's current workflow is export, pull from Horizon, download statements, match in a
  spreadsheet and chase by email. This is reconstructed from the Quay issue and the vendor
  write-ups. No anchor has described its process to us.
- The anchors that care most are licensed in the UK, the EU or a similar regime. Many directory
  anchors (LatAm, Africa, SEA) may not reconcile daily at all.
- An anchor can export its Anchor Platform transactions with a bank reference and a travel-rule
  reference column. Both are custom business-server fields, so this is verify-first item (a).
- Anchors will self-host the tool. Bank statements and customer names do not leave the anchor.
- A signed hash published on the anchor's website would give most of the registry's value (see
  `ARCHITECTURE.md`, "The no-chain alternative").

## Hypotheses (to be tested)

- **H1.** Analysts spend hours a day on the three-way match. The primary outcome is the time from
  the last statement arriving to a signed daily reconciliation, with a target under 30 minutes on
  a normal day. The baseline is unknown.
- **H2.** On real anchor data, the deterministic pass matches most customer legs once the
  `AR-XXXXXXXX-C` reference (or the Platform's own ids) flows through the bank narrative. No
  target is claimed before real data.
- **H3.** The tool finds real breaks that the anchor's current process missed, when run on the
  anchor's own historical data. This is the key value test.
- **H4.** The fuzzy pass's review-band load is small enough that an analyst decides it in minutes
  a day.
- **H5.** At least some anchors will publish a daily signed hash, counts and a shortfall figure
  (killer question 2).
- **H6.** An auditor or compliance consultant finds `recon verify` plus a countersignature useful
  enough to use.
- **H7.** Someone pays $500–5k per month per anchor (11-R5 `[estimate]`), or SCF funds the
  open-source core.

## Simulated / demo data

Everything under `data/seed/` is simulated. The anchor ("SIM ANCHOR EMI (simulated)"), its banks,
customers, partner anchors, keys and amounts are all fictitious. The **same team wrote the
generator and the matcher**, so the planted breaks and hard cases test the spec's own categories.
They say nothing about how often these patterns occur, or which other patterns occur, at a real
anchor.

| Seed-only result (30 days: 400 platform txs, 408 chain ops, 461 bank lines) | Value |
|---|---|
| Planted breaks K01 to K12 raised with the expected type | 12/12 |
| Travel-rule cases T01 to T03 (EMPTY / NOT_IN_LOG / MALFORMED) | 3/3 |
| Exceptions raised outside the planted set | 0 |
| Matchable-hard cases matched, with no exception | 57/57 |
| Proposals (high / review), accepted / rejected by the scripted analyst | 32 / 10, 40 / 2 |
| Proposal precision, fuzzy recall on hard cases | 95.2%, 95.2% |
| Customer legs matched by the deterministic pass | 94.8% |
| Shortfall | EUR 3,412.50 on 2026-08-18 only |
| Registry model: gaps / restatements / attested days | 2026-08-20 / 1 / 21 (1 late) |

The review band held 10 proposals across the month, within the spec's acceptance threshold of at
most 25. That threshold is a limit on simulated data, not a performance claim.

## Actual validation

None. No interviews have taken place, no anchor data has been run, and nothing has been deployed
to testnet. No one outside the team has used the tool.

## Baseline and success metric

- **Primary outcome, not measurable in the MVP:** analyst time from the last bank statement to a
  signed daily reconciliation. The baseline is unknown, to be measured in interviews (H1). The
  target is under 30 minutes on a normal day.
- **MVP-level metrics**, reported by `simulate` and asserted by `scenario.test.ts` on Simulated
  data:
  - the deterministic share of customer legs;
  - 100% of planted breaks with the right type;
  - 100% of travel-rule gaps;
  - zero exceptions on the hard cases;
  - every expected day attested, declared or flagged, so "missed silently" is 0 by construction
    in the registry.
- **Key value test after a pilot:** real breaks found that the anchor's own process missed (H3).

## Experiment plan

**Week 1: 6 to 8 conversations.** Who to reach:

- the Quay maintainers, via issue #243;
- the `anchor-watch` author;
- ops and finance leads at directory and Integration List anchors, through SDF's anchor and SCF
  channels (access to these channels is itself an assumption);
- one UK- or EU-licensed stablecoin PSP.

Ask:

- How do you reconcile today, how often, and how many hours does it take?
- Which regime applies to you (CASS 15, MiCA, other, none)?
- What were your last three breaks, and how were they found?
- Killer questions 1 and 2 below.

Output: named, consented baselines (evidence level Observed).

**Week 2.**

1. One anchor (or Quay on its testnet data) runs `recon` offline on one to four weeks of its own
   exported and, if needed, redacted data. Measure the deterministic match share, the review
   load and the breaks found against their own records. If they agree, attest those days on
   testnet with `scripts/e2e-testnet.sh` adapted to their packs.
2. Their auditor or a compliance consultant reviews one pack with `recon verify` and says whether
   a countersignature would be useful (H6).
3. Publish `docs/MEMO-CONVENTIONS.md` as a GitHub discussion on the Anchor Platform repository and
   record the responses.

**Willingness to pay.** Ask directly: $500–5k per month, or grant-funded open source? Record who
answers.

**Proof levels reachable.**

- **Level 1 (two weeks):** named anchor staff confirm the problem, their hours and their regime.
- **Level 2:** the offline run on an anchor's own history, with the metrics above.
- **Level 3:** at least 20 consecutive days attested by a real anchor, and at least one auditor
  countersignature.

## Killer questions

1. **Would the user care if it disappeared?** Unknown. The researched pain is one community issue
   plus a regulatory duty (CASS 15, MiCA) that applies to an unknown share of Stellar anchors.
   The spec's version is "would you run a tool that needs your platform export and bank
   statements daily?", and no one has been asked.
2. **Did anyone outside the team use it?** No. The spec's second killer question, "would you
   publish a daily signed hash and shortfall figure publicly?", is also unasked. If every
   anchor says no, the registry becomes an optional private log, and the project is pitched
   purely as matching tooling.
3. **Before/after measured?** No. The baseline (analyst hours per day) is unknown, and the only
   numbers are seed-only.
4. **Value lost without AI?** Some. On the seed, the deterministic pass matches 94.8% of customer
   legs without any AI. The fuzzy pass handles the rest: split deposits, fee and FX
   differences, truncated or mistyped references and reversal pairs. The deterministic
   heuristic does all of that, and the LLM only re-scores review-band blocks and drafts prose.
   So the tool's value would survive without an LLM. How much a model adds on real narratives
   is untested, and pseudonymised names limit it by design.
5. **Reason to keep using after the demo?** Yes, if the anchor reconciles daily: the work
   recurs every reconciliation day, and CASS 15 firms must do it. For anchors outside such
   regimes, it is a hypothesis.
6. **Would someone pay?** Hypothesis H7: hosted or supported deployments at $500–5k per month
   (`[estimate]`), or SCF Integration-track or Public Goods funding for the open-source core.
   The buyer set is a few dozen anchors.
7. **Does the chain create value?** A little, and the README says so first. It adds a timestamp
   the anchor cannot backdate, visible restatements, a missed-day flag anyone can raise, and
   countersignatures and signer history in one place. A signed file plus RFC 3161 gets most of
   the rest. The value is in the off-chain matcher.
8. **Why this chain?** The problem only exists here in this form: SEP-6/24/31 transaction
   objects, memos, claimable balances and muxed accounts, with Anchor Platform as the ledger of
   record. The registry sits next to the anchor's `stellar.toml` identity and costs a sub-cent
   fee per day. The matcher is the part that is specific to Stellar. The registry could live
   anywhere.

## Failure modes

The main risks, in order:

1. **Demand is thin.** One issue and a few dozen anchors.
2. **Disclosure is refused** (killer question 2).
3. **Reviewers judge the registry decorative.**
4. **Data access.** Anchors must hand bank statements and customer names to a tool, so
   self-hosting is the default.
5. **Anchor Platform schema drift.** The field names are a working assumption (verify-first
   item (a)).
6. **The data layer.** Horizon's end-of-life, one year of history and RPC's 7-day retention.
7. **The regulatory draft is mistaken for advice.** REP027 fields are unverified.
8. **A wrong high-band match hides a break.** Human acceptance, the 10% re-check sample and the
   listing of every non-rule match reduce this risk but do not remove it.
9. **State archival** of old attestations.

The runtime failure handling (a missing statement, a provider outage, a lost signer key, invalid
LLM output) is described in `ARCHITECTURE.md` and `docs/EXCEPTION-TYPES.md`.
