# Regulatory mapping

**Draft, not legal advice.** This page maps regulatory concepts to what the tool computes. It
does not say what any firm must do. The compliance officer decides which transaction states count
as owed (`safeguarding.json`), approves every report, and decides top-ups. The tool files nothing
with any regulator.

## UK CASS 15 (payment and e-money firms, from 7 May 2026)

Source: research 11-R5; fca.org.uk.

| Requirement (as researched) | Tool output | Status |
|---|---|---|
| Internal safeguarding reconciliation every reconciliation day | the daily `figures.json` safeguarding section: requirement vs resource, shortfall or excess | computed from configured owed states. **Assumption:** which states count is the firm's call |
| External reconciliation every reconciliation day | per designated account: the internal record (previous CLBD + the day's booked lines) vs the bank's CLBD | computed |
| Top up any shortfall immediately | a "top-up required today" line, and the `TOPPED_UP` resolution code | the tool reports; people act |
| Monthly return (REP027) | `monthly-<YYYY-MM>.md` and `.figures.json`, labelled **REP027-style draft** | **the REP027 field list is not verified** (verify-first item (c)); only the figures we compute are printed |
| Resolution packs retrievable within 48 h | `var/<day>/pack*.json`, `figures.json` and `report.md`, kept by the anchor | retention policy is the anchor's |

**Requirement.** The requirement is the sum, at cut-off, of transactions in the configured owed
states, plus open `REVERSAL_OPEN` returns. The seed's owed states are:

- deposits in `pending_anchor` or `pending_stellar`, counted at `amount_in`;
- withdrawals in `pending_anchor` or `pending_external`, counted at `amount_out`;
- receives in `pending_receiver` or `pending_external`, counted at `amount_out`.

**Resource.** The resource is the CLBD closing balance of each designated safeguarding account.
If a statement is missing, the figure is blocked (`STATEMENT_MISSING`). An analyst-entered
balance is flagged `manual` in the report.

## EU MiCA (CASPs)

MiCA's daily reconciliation obligation for CASPs is researched from a law-firm excerpt (11-R5).
**The article number is unchecked.** The same daily figures and packs apply. No MiCA-specific
return is drafted.

## Travel rule (absorbed check, detection only)

SEP-31 specifies no travel-rule format. The EU threshold is zero from 2026, and FATF revised R.16
in June 2025 (10-R10). The tool only detects a missing, malformed or unlogged reference
(`TRAVEL_RULE_MISSING`). Screening and envelope exchange stay with the anchor's travel-rule
provider.

## What the registry adds for a regulator or auditor

The registry does not show that the figures are true. It adds these:

- a timestamp the firm cannot backdate, and a `late` flag;
- visible restatements with reasons;
- a missed-day flag that anyone can raise;
- auditor countersignatures.

Whether a regulator would give any weight to these is untested.
