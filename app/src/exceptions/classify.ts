// Exception classification over what the deterministic and fuzzy passes left.
// Leftover items wait `hold_business_days` (default 1) before they are raised,
// so a split deposit's first part or a next-day payout is not reported as a
// break. Deterministic breaks (duplicates, reversals, non-customer debits from
// safeguarding, travel rule, missing statements) are raised immediately.

import { dayOf } from '../core/dates.js';
import { correctRef, findRefs } from '../core/reference.js';
import { parseMoney } from '../core/money.js';
import type { BankLine, PlatformTx, ReconException } from '../types.js';
import type { ReconState } from '../store/store.js';
import type { ReconContext } from '../match/context.js';
import { addException, bankExpectation, bankItem, chainExpectation, legs, memoEquals, opItem, ptxId } from '../match/deterministic.js';
import { leftoverLines, leftoverOps } from '../match/candidates.js';
import { fitAmount } from '../match/tolerance.js';
import { checkTravelRule } from './travelRule.js';

const CHAIN_DUE: Record<string, string[]> = {
  deposit: ['completed'],
  withdrawal: ['pending_anchor', 'pending_external', 'completed'],
  receive: ['pending_receiver', 'pending_external', 'completed'],
};
const BANK_DUE: Record<string, string[]> = {
  deposit: ['pending_anchor', 'pending_stellar', 'completed'],
  withdrawal: ['completed'],
  receive: ['completed'],
};
const STALE_STATES = ['pending_anchor', 'pending_external'];
const FAILED_STATES = ['error', 'expired'];

function aged(ctx: ReconContext, itemDay: string, today: string): boolean {
  return ctx.cal.diff(dayOf(itemDay), dayOf(today)) >= ctx.sg.hold_business_days;
}

/** A leftover bank line linked by an exact key (valid or one-edit-corrected AR token, E2E id) to an open transaction. */
export function keyLinked(state: ReconState, line: BankLine): PlatformTx | undefined {
  const open = Object.values(state.platform).filter((p) => !legs(state, p.id).bank && !legs(state, p.id).blockedBank);
  const byE2e = open.find((p) => p.externalId && line.endToEndId === p.externalId);
  if (byE2e) return byE2e;
  const refs = findRefs(line.narrative);
  const valid = refs.find((r) => r.valid && open.some((p) => p.bankRef === r.canonical));
  if (valid) return open.find((p) => p.bankRef === valid.canonical);
  for (const r of refs.filter((x) => !x.valid)) {
    const hits = correctRef(r, open.map((p) => p.bankRef).filter((x): x is string => !!x));
    if (hits.length === 1) return open.find((p) => p.bankRef === hits[0]);
  }
  return undefined;
}

export function classify(state: ReconState, ctx: ReconContext, today: string): ReconException[] {
  const raised: ReconException[] = [];
  const push = (e: ReconException | undefined) => {
    if (e) raised.push(e);
  };
  const allowedDebit = ctx.sg.allowed_debit_patterns.map((p) => new RegExp(p));

  // --- leftover bank lines
  for (const l of leftoverLines(state)) {
    if (state.itemUse[bankItem(l.id)]) continue;
    const isSafeguarding = ctx.sg.safeguarding_accounts.includes(l.account);
    if (l.direction === 'debit' && isSafeguarding && !allowedDebit.some((re) => re.test(l.narrative)) && !keyLinked(state, l)) {
      push(addException(state, { type: 'NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING', day: today, evidenceIds: [bankItem(l.id)], amount: l.amount.toString(), currency: l.currency }));
      continue;
    }
    if (!aged(ctx, l.day, today)) continue;
    const p = keyLinked(state, l);
    if (p) {
      const exp = bankExpectation(p);
      if (exp.direction === l.direction) {
        const fit = fitAmount(exp.amount, l.amount, p.kind, ctx.tol, l.charges);
        if (fit.closeness === 0) {
          const type = l.direction === 'debit' && l.amount < exp.amount ? 'SHORT_PAYOUT' : 'AMOUNT_MISMATCH';
          const ex = addException(state, { type, day: today, evidenceIds: [ptxId(p.id), bankItem(l.id)], amount: l.amount.toString(), currency: l.currency });
          if (ex) {
            legs(state, p.id).blockedBank = ex.id;
            push(ex);
          }
          continue;
        }
      }
    }
    push(
      addException(state, {
        type: l.direction === 'credit' ? 'UNMATCHED_BANK_CREDIT' : 'UNMATCHED_BANK_DEBIT',
        day: today,
        evidenceIds: [bankItem(l.id)],
        amount: l.amount.toString(),
        currency: l.currency,
      }),
    );
  }

  // --- leftover chain ops
  const openChain = Object.values(state.platform).filter((p) => !legs(state, p.id).chain);
  for (const o of leftoverOps(state)) {
    if (state.itemUse[opItem(o.opId)] || !aged(ctx, o.day, today)) continue;
    let type: ReconException['type'];
    if (o.direction === 'in') {
      const toReceive = o.account === ctx.sg.anchor_accounts.receive;
      const memoHitsOpen = openChain.some((p) => memoEquals(p, o));
      type = toReceive && o.memo && !memoHitsOpen ? 'WRONG_MEMO' : 'UNMATCHED_CHAIN_IN';
    } else type = 'UNMATCHED_CHAIN_OUT';
    push(addException(state, { type, day: today, evidenceIds: [opItem(o.opId)], amount: o.amount.toString(), currency: o.asset }));
  }

  // --- platform-level checks
  for (const p of Object.values(state.platform).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const L = legs(state, p.id);
    const since = state.statusSince[p.id]?.since ?? today;
    const exists = (type: string) => state.exceptions.some((e) => e.type === type && e.evidenceIds.includes(ptxId(p.id)));
    // a proposal awaiting the analyst covers the missing leg until it is decided
    const pendingBank = state.proposals.some((x) => x.status === 'pending' && x.platformId === p.id && x.bankLineIds.length > 0);
    const pendingChain = state.proposals.some((x) => x.status === 'pending' && x.platformId === p.id && x.chainOpIds.length > 0);
    if (FAILED_STATES.includes(p.status) && L.chain && !exists('STATUS_MISMATCH')) {
      push(addException(state, { type: 'STATUS_MISMATCH', subReason: `status ${p.status} but chain delivery observed`, day: today, evidenceIds: [ptxId(p.id), ...state.groups.filter((g) => g.id === L.chain).flatMap((g) => g.chainOpIds.map(opItem))], amount: (p.kind === 'deposit' ? p.amountOut : p.amountIn).toString(), currency: p.assetOnChain }));
    }
    if (CHAIN_DUE[p.kind].includes(p.status) && !L.chain && !L.blockedChain && !pendingChain && aged(ctx, since, today) && !exists('PLATFORM_NO_CHAIN_LEG')) {
      const exp = chainExpectation(p, ctx);
      const ex = addException(state, { type: 'PLATFORM_NO_CHAIN_LEG', day: today, evidenceIds: [ptxId(p.id)], amount: exp.amount7.toString(), currency: exp.asset });
      if (ex) {
        L.blockedChain = ex.id;
        push(ex);
      }
    }
    if (BANK_DUE[p.kind].includes(p.status) && !L.bank && !L.blockedBank && !pendingBank && aged(ctx, since, today) && !exists('PLATFORM_NO_BANK_LEG')) {
      const exp = bankExpectation(p);
      push(addException(state, { type: 'PLATFORM_NO_BANK_LEG', day: today, evidenceIds: [ptxId(p.id)], amount: exp.amount.toString(), currency: p.assetFiat }));
    }
    if (STALE_STATES.includes(p.status) && ctx.cal.diff(dayOf(since), dayOf(today)) > ctx.sg.stale_days && !exists('STALE_PENDING')) {
      push(addException(state, { type: 'STALE_PENDING', subReason: p.status, day: today, evidenceIds: [ptxId(p.id)], amount: (p.kind === 'deposit' ? p.amountIn : p.amountOut).toString(), currency: p.assetFiat }));
    }
    if (state.firstSeen[p.id] === today) {
      const tr = checkTravelRule(p, parseMoney(ctx.sg.travel_rule_threshold, 0), ctx.sg.travel_rule_provider_patterns, ctx.travelLog);
      if (tr && !tr.ok && !exists('TRAVEL_RULE_MISSING')) {
        push(addException(state, { type: 'TRAVEL_RULE_MISSING', subReason: tr.subReason, day: today, evidenceIds: [ptxId(p.id)], amount: p.amountIn.toString(), currency: p.assetIn }));
      }
    }
  }

  // --- statements
  const bd = ctx.cal.isBusinessDay(dayOf(today));
  if (bd) {
    for (const acct of ctx.sg.expected_accounts) {
      if (!(state.statementDays[acct] ?? []).includes(today)) {
        push(addException(state, { type: 'STATEMENT_MISSING', day: today, evidenceIds: [`stmt:${acct}:${today}`] }));
      }
    }
  }
  return raised;
}
