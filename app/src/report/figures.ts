// figures.json: every number a report may print, computed deterministically
// from the state. The model never computes a figure.

import { dayOf, isoOf } from '../core/dates.js';
import { formatMoney } from '../core/money.js';
import type { ReconState } from '../store/store.js';
import type { ReconContext } from '../match/context.js';
import { requirement } from '../safeguarding/requirement.js';
import { externalReconciliation, resource, shortfallExcess } from '../safeguarding/resource.js';
import type { Counts } from '../attest/entryHash.js';
import { EXCEPTION_TYPES } from '../exceptions/types.js';
import type { ReconException } from '../types.js';
import { highBandSample } from '../match/engine.js';

export interface SafeguardingFigures {
  requirement: string;
  requirementLines: number;
  resource?: string;
  resourceSource: string;
  shortfall?: string;
  excess?: string;
  topUpRequired: string;
  blocked: boolean;
  external: { account: string; internal?: string; bank?: string; difference?: string }[];
}

export interface DailyFigures {
  kind: 'daily';
  day: string;
  anchor: string;
  currency: string;
  counts: Counts;
  exceptions: {
    new: Record<string, number>;
    open: Record<string, number>;
    closed: Record<string, number>;
    aged: number;
    totals: { new: number; open: number; closed: number };
  };
  safeguarding: SafeguardingFigures;
  nonRuleMatches: { groupId: string; platformId: string; kind: string; method: string; decidedBy?: string; score: string }[];
  proposals: { high: number; review: number; pending: number };
  sample: string[];
  formatted: Record<string, string>;
}

export function openAt(e: ReconException, day: string): boolean {
  return e.openedOn <= day && (e.status === 'open' || (e.closedOn !== undefined && e.closedOn > day));
}

function tally(list: ReconException[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of EXCEPTION_TYPES) out[t] = 0;
  for (const e of list) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

export function dayCounts(state: ReconState, day: string): Counts {
  const groups = state.groups.filter((g) => g.day === day);
  const by = (m: string) => groups.filter((g) => g.method === m).length;
  return {
    platform_txs: (state.exportDays[day] ?? []).length,
    chain_ops: Object.values(state.chain).filter((o) => o.day === day).length,
    bank_lines: Object.values(state.bank).filter((l) => l.bookingDate === day).length,
    matched_groups: groups.length,
    matched_rule: by('rule'),
    matched_heuristic: by('heuristic'),
    matched_llm: by('llm'),
    matched_analyst: by('analyst'),
    exceptions_new: state.exceptions.filter((e) => e.openedOn === day).length,
    exceptions_open: state.exceptions.filter((e) => openAt(e, day)).length,
    exceptions_closed: state.exceptions.filter((e) => e.closedOn === day).length,
    travel_rule_missing: state.exceptions.filter((e) => e.openedOn === day && e.type === 'TRAVEL_RULE_MISSING').length,
  };
}

export function safeguardingFigures(state: ReconState, ctx: ReconContext, day: string): SafeguardingFigures {
  const req = requirement(Object.values(state.platform), ctx.sg, state.exceptions.filter((e) => openAt(e, day)));
  const res = resource(state.balances, ctx.sg, day);
  const statementMissing = state.exceptions.some((e) => e.type === 'STATEMENT_MISSING' && e.openedOn === day && ctx.sg.safeguarding_accounts.some((a) => e.evidenceIds.includes(`stmt:${a}:${day}`)));
  const blocked = res.blocked || (statementMissing && res.source !== 'manual');
  const se = shortfallExcess(req.total, blocked ? undefined : res.total);
  const prevDay = (() => {
    let d = dayOf(day) - 1;
    for (let i = 0; i < 10; i++, d--) if (ctx.cal.isBusinessDay(d)) return isoOf(d);
    return undefined;
  })();
  const external = ctx.sg.safeguarding_accounts.map((a) => {
    const x = externalReconciliation(state.balances, Object.values(state.bank), a, day, prevDay);
    return { account: a, internal: x.internal?.toString(), bank: x.bank?.toString(), difference: x.difference?.toString() };
  });
  return {
    requirement: req.total.toString(),
    requirementLines: req.lines.length,
    resource: blocked ? undefined : res.total?.toString(),
    resourceSource: blocked ? 'blocked' : res.source,
    shortfall: se.shortfall?.toString(),
    excess: se.excess?.toString(),
    topUpRequired: (se.shortfall ?? 0n).toString(),
    blocked,
    external,
  };
}

export function dailyFigures(state: ReconState, ctx: ReconContext, day: string, anchor: string, reuse?: SafeguardingFigures): DailyFigures {
  const counts = dayCounts(state, day);
  const newEx = state.exceptions.filter((e) => e.openedOn === day);
  const openEx = state.exceptions.filter((e) => openAt(e, day));
  const closedEx = state.exceptions.filter((e) => e.closedOn === day);
  const aged = openEx.filter((e) => ctx.cal.diff(dayOf(e.openedOn), dayOf(day)) > 5).length;
  const sg = reuse ?? safeguardingFigures(state, ctx, day);
  const dayProps = state.proposals.filter((p) => p.day === day);
  const nonRule = state.groups
    .filter((g) => g.day === day && g.method !== 'rule')
    .map((g) => {
      const p = state.proposals.find((x) => x.id === g.proposalId);
      return { groupId: g.id, platformId: g.platformIds[0] ?? '', kind: p?.kind ?? g.rule ?? '', method: g.method, decidedBy: g.decidedBy, score: p ? p.score.toFixed(3) : '' };
    });
  const formatted: Record<string, string> = {};
  for (const [k, v] of Object.entries(sg)) if (typeof v === 'string' && /^\d+$/.test(v)) formatted[k] = formatMoney(BigInt(v), 2);
  return {
    kind: 'daily',
    day,
    anchor,
    currency: ctx.sg.currency,
    counts,
    exceptions: {
      new: tally(newEx),
      open: tally(openEx),
      closed: tally(closedEx),
      aged,
      totals: { new: newEx.length, open: openEx.length, closed: closedEx.length },
    },
    safeguarding: sg,
    nonRuleMatches: nonRule,
    proposals: { high: dayProps.filter((p) => p.band === 'high').length, review: dayProps.filter((p) => p.band === 'review').length, pending: dayProps.filter((p) => p.status === 'pending').length },
    sample: dayProps.filter((p) => p.sampled).map((p) => p.id).sort().concat(dayProps.some((p) => p.sampled) ? [] : highBandSample(day, dayProps.filter((p) => p.status !== 'rejected'))).filter((v, i, a) => a.indexOf(v) === i),
    formatted,
  };
}

export interface MonthlyFigures {
  kind: 'monthly';
  month: string;
  anchor: string;
  currency: string;
  expectedDays: number;
  onTime: number;
  late: number;
  gaps: number;
  restatements: number;
  shortfallDays: number;
  maxShortfall: string;
  totalShortfall: string;
  maxRequirement: string;
  exceptionsByType: Record<string, number>;
  openAtEnd: number;
  days: { day: string; status: string; shortfall: string }[];
}

export interface RegistryDayView {
  day: string;
  status: string;
  versions: number;
}

export function monthlyFigures(state: ReconState, month: string, anchor: string, currency: string, registry: RegistryDayView[]): MonthlyFigures {
  const inMonth = (d: string) => d.startsWith(month);
  const days = registry.filter((r) => inMonth(r.day));
  const expected = days.filter((r) => r.status !== 'NotExpected' && r.status !== 'NonReconDay');
  const sf = expected.map((r) => {
    const f = state.figures[r.day] as DailyFigures | undefined;
    return { day: r.day, status: r.status, shortfall: f?.safeguarding.shortfall ?? '0', requirement: f?.safeguarding.requirement ?? '0' };
  });
  const big = (s: string) => BigInt(s);
  const monthEx = state.exceptions.filter((e) => inMonth(e.openedOn));
  const lastDay = [...days].map((d) => d.day).sort().at(-1) ?? `${month}-01`;
  return {
    kind: 'monthly',
    month,
    anchor,
    currency,
    expectedDays: expected.length,
    onTime: expected.filter((r) => r.status === 'Attested').length,
    late: expected.filter((r) => r.status === 'AttestedLate' || r.status === 'GapThenAttested').length,
    gaps: expected.filter((r) => r.status === 'Gap' || r.status === 'GapThenAttested').length,
    restatements: days.reduce((a, r) => a + Math.max(0, r.versions - 1), 0),
    shortfallDays: sf.filter((x) => big(x.shortfall) > 0n).length,
    maxShortfall: sf.reduce((a, x) => (big(x.shortfall) > a ? big(x.shortfall) : a), 0n).toString(),
    totalShortfall: sf.reduce((a, x) => a + big(x.shortfall), 0n).toString(),
    maxRequirement: sf.reduce((a, x) => (big(x.requirement) > a ? big(x.requirement) : a), 0n).toString(),
    exceptionsByType: tally(monthEx),
    openAtEnd: state.exceptions.filter((e) => openAt(e, lastDay)).length,
    days: sf.map(({ day, status, shortfall }) => ({ day, status, shortfall })),
  };
}
