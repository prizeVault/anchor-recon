// `recon simulate --days 30`: offline end-to-end over the seed with the
// scripted analyst decisions (data/seed/decisions.jsonl) and registryModel.ts
// (an in-memory MODEL of the contract rules; the contract itself is tested in
// Rust). Every number it prints is from SIMULATED data.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { dayOf, isoOf } from './core/dates.js';
import { sha256 } from './core/hash.js';
import { readCamtFile } from './ingest/camt053.js';
import { readCsvFile, type CsvProfile } from './ingest/csvBank.js';
import { readHorizonFile } from './ingest/horizon.js';
import { readPlatformFile, type PlatformMap } from './ingest/platform.js';
import type { AiProvider } from './ai/provider.js';
import { HeuristicProvider } from './ai/heuristic.js';
import { loadContext, type ReconContext } from './match/context.js';
import { acceptBand, closeException, decideProposal, highBandSample, ingestInto, manualMatch, matchDay, pendingProposals, reclassify, type IngestBundle } from './match/engine.js';
import { emptyState, MemoryStore, type ReconState, type Store, toJsonl } from './store/store.js';
import { dailyFigures, monthlyFigures, type DailyFigures } from './report/figures.js';
import { approveReport, draftReport, reportHash } from './report/daily.js';
import { buildPack, verifyPack, type Pack } from './attest/pack.js';
import { seededSalt } from './attest/leaf.js';
import { OPINIONS, RESTATE_REASONS, RegistryModel } from './attest/registryModel.js';
import { ANCHOR_NAME, SEED, type Expected } from './seed/generate.js';
import type { Resolution } from './types.js';

export function readDayInputs(seedDir: string, day: string, ctx: ReconContext): IngestBundle {
  const map = JSON.parse(readFileSync(join(seedDir, 'platform-map.json'), 'utf8')) as PlatformMap;
  delete (map as Record<string, string>)._note;
  const profile = JSON.parse(readFileSync(join(seedDir, 'bank-b-profile.json'), 'utf8')) as CsvProfile;
  const pdir = join(seedDir, 'platform');
  const platform = existsSync(pdir)
    ? readdirSync(pdir)
        .filter((f) => f.startsWith(`${day}.`) && f.endsWith('.json'))
        .sort()
        .flatMap((f) => readPlatformFile(join(pdir, f), map, day))
    : [];
  const chainFile = join(seedDir, 'chain', `${day}.json`);
  const chain = existsSync(chainFile) ? readHorizonFile(chainFile, [ctx.sg.anchor_accounts.distribution, ctx.sg.anchor_accounts.receive]) : [];
  const statements = [];
  const a = join(seedDir, 'bank-a', `${day}.xml`);
  if (existsSync(a)) statements.push(...readCamtFile(a, 'bank-a'));
  const b = join(seedDir, 'bank-b', `${day}.csv`);
  if (existsSync(b)) statements.push(readCsvFile(b, profile, 'bank-b', `SIMB-${day.replace(/-/g, '')}`, { closingDate: day }));
  return { platform, chain, statements };
}

export interface Decision {
  action: string;
  platformId?: string;
  kind?: string;
  bankLineIds?: string[];
  planted?: string;
  resolution?: string;
  on?: string;
  by: string;
  note?: string;
}

export function readDecisions(seedDir: string): Decision[] {
  return readFileSync(join(seedDir, 'decisions.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Decision);
}

export const at = (day: string, hhmm: string): number => dayOf(day) * 86_400 + Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60;
const iso = (unix: number) => new Date(unix * 1000).toISOString();

export const SIM_KEYS = {
  admin: Keypair.fromRawEd25519Seed(Buffer.from(sha256(`${SEED}|key|admin`))).publicKey(),
  signer0: Keypair.fromRawEd25519Seed(Buffer.from(sha256(`${SEED}|key|signer-0`))).publicKey(),
  signer1: Keypair.fromRawEd25519Seed(Buffer.from(sha256(`${SEED}|key|signer-1`))).publicKey(),
  auditor: Keypair.fromRawEd25519Seed(Buffer.from(sha256(`${SEED}|key|auditor`))).publicKey(),
};

export interface SimOptions {
  seedDir: string;
  days?: number;
  provider?: AiProvider;
  store?: Store;
  log?: (s: string) => void;
}

export interface SimResult {
  state: ReconState;
  registry: RegistryModel;
  packs: Map<string, Pack[]>;
  expected: Expected;
  metrics: SeedMetrics;
  ctx: ReconContext;
}

export interface SeedMetrics {
  planted: { id: string; type: string; found: boolean; raisedAs: string[]; day?: string }[];
  plantedFound: number;
  plantedTotal: number;
  exceptionsTotal: number;
  exceptionsOnPlanted: number;
  exceptionsOther: { id: string; type: string; day: string }[];
  hardTotal: number;
  hardMatched: number;
  hardWithException: string[];
  proposals: { total: number; accepted: number; rejected: number; high: number; review: number; pending: number };
  proposalPrecision: number;
  fuzzyRecall: number;
  groups: { total: number; rule: number; heuristic: number; llm: number; analyst: number; internal: number };
  deterministicShareOfCustomerLegs: number;
  shortfall: Record<string, string>;
  registry: { gaps: string[]; restatements: number; attestedDays: number; onTime: number; late: number };
}

export async function simulate(opts: SimOptions): Promise<SimResult> {
  const log = opts.log ?? (() => {});
  const provider = opts.provider ?? new HeuristicProvider();
  const ctx = loadContext(opts.seedDir, provider);
  const store = opts.store ?? new MemoryStore();
  const state = emptyState();
  const expected = JSON.parse(readFileSync(join(opts.seedDir, 'expected.json'), 'utf8')) as Expected;
  const plan = JSON.parse(readFileSync(join(opts.seedDir, 'registry-plan.json'), 'utf8'));
  const decisions = readDecisions(opts.seedDir);
  const approver = decisions.find((d) => d.action === 'approve-reports')?.by ?? 'C. Compliance (simulated)';
  const reg = new RegistryModel();
  const start = expected.calendar.start;
  reg.now = at(start, '07:00');
  reg.init(SIM_KEYS.admin, SIM_KEYS.signer0, plan.start_day, plan.weekday_mask, plan.grace_secs, plan.currency, plan.decimals, plan.home_domain);
  const packs = new Map<string, Pack[]>();
  const nDays = opts.days ?? 30;
  const plantedRefs = new Map(expected.planted.map((p) => [p.id, p]));

  const finishDay = async (d: string, version: number): Promise<Pack> => {
    const prior = state.figures[d] as DailyFigures | undefined;
    const figures = dailyFigures(state, ctx, d, ANCHOR_NAME, version > 0 ? prior?.safeguarding : undefined);
    state.figures[d] = figures;
    const draft = await draftReport(provider, 'daily', d, figures as unknown as Record<string, unknown>);
    const approved = approveReport(draft, approver, iso(at(d, version > 0 ? '18:04' : '17:45')));
    state.reports[version > 0 ? `${d}#v${version}` : d] = approved;
    const pack = buildPack(state, d, version, seededSalt(SEED, `${d}#v${version}`), figures.safeguarding.shortfall ?? '0', draft.figuresHash, reportHash(approved));
    if (!packs.has(d)) packs.set(d, []);
    packs.get(d)!.push(pack);
    store.writeDay(d, version > 0 ? `pack.v${version}.json` : 'pack.json', JSON.stringify(pack, null, 1));
    store.writeDay(d, version > 0 ? `report.v${version}.md` : 'report.md', approved.markdown);
    store.writeDay(d, version > 0 ? `figures.v${version}.json` : 'figures.json', JSON.stringify(figures, null, 1));
    return pack;
  };

  const attest = (d: string, time: string) => {
    const pack = packs.get(d)!.at(-1)!;
    if (pendingProposals(state, d).length) throw new Error(`attest ${d}: undecided proposals`);
    reg.now = at(time.slice(0, 10), time.slice(11));
    reg.attest(reg.signer, dayOf(d), pack.root, pack.counts, BigInt(pack.shortfall), pack.reportHash);
  };

  for (let i = 0; i < nDays; i++) {
    const d = isoOf(dayOf(start) + i);
    // registry events that happen early in the day
    if (d === plan.rotate.on) {
      reg.now = at(d, plan.rotate.at);
      reg.rotateSigner(SIM_KEYS.admin, SIM_KEYS.signer1, plan.rotate.reason === 'compromise' ? 2 : 1, 0);
    }
    if (d === plan.countersign.on) {
      const target = packs.get(plan.countersign.day)?.[plan.countersign.version];
      const onChain = reg.get(dayOf(plan.countersign.day), plan.countersign.version);
      if (target && onChain && verifyPack(target, onChain.root).ok) {
        reg.now = at(d, plan.countersign.at);
        reg.setAuditor(SIM_KEYS.admin, SIM_KEYS.auditor, true);
        reg.countersign(SIM_KEYS.auditor, dayOf(plan.countersign.day), plan.countersign.version, OPINIONS[plan.countersign.opinion], 'cd'.repeat(32));
      } else throw new Error('countersign: verify failed');
    }
    if (d === plan.mark_gaps.on) {
      reg.now = at(d, plan.mark_gaps.at);
      const n = reg.markGaps(dayOf(d));
      log(`${d} mark_gaps flagged ${n}`);
    }
    if (d === plan.late_attest.on) attest(plan.late_attest.day, `${d}T${plan.late_attest.at}`);
    if (!ctx.cal.isBusinessDay(dayOf(d))) continue;

    // ingest, match, review
    ingestInto(state, d, readDayInputs(opts.seedDir, d, ctx));
    const m = await matchDay(state, ctx, d);
    for (const p of state.proposals.filter((x) => x.day === d && x.status === 'pending')) {
      const hit = decisions.find(
        (x) => x.action === 'accept-proposal' && x.platformId === p.platformId && x.kind === p.kind && JSON.stringify([...(x.bankLineIds ?? [])].sort()) === JSON.stringify([...p.bankLineIds].sort()),
      );
      decideProposal(state, p.id, hit ? 'accept' : 'reject', hit?.by ?? 'A. Analyst (simulated)', { at: iso(at(d, '17:00')), note: hit ? 'scripted: matches expected' : 'scripted: not the expected match', today: d });
    }
    for (const dec of decisions.filter((x) => x.action === 'manual-match' && x.on === d)) {
      manualMatch(state, d, dec.platformId!, dec.bankLineIds ?? [], dec.by, dec.note);
    }
    const dayProps = state.proposals.filter((x) => x.day === d && x.status === 'accepted');
    for (const id of highBandSample(d, dayProps)) state.proposals.find((x) => x.id === id)!.sampled = true;
    for (const dec of decisions.filter((x) => x.action === 'close' && x.on === d)) {
      const p = plantedRefs.get(dec.planted ?? '');
      const ex = p && state.exceptions.find((e) => e.status === 'open' && e.type === p.type && p.refs.some((r) => e.evidenceIds.includes(r)));
      if (ex) closeException(state, ex.id, dec.resolution as Resolution, dec.by, d, iso(at(d, '17:10')));
    }
    await reclassify(state, ctx, d);
    state.processedDays.push(d);
    const pack = await finishDay(d, 0);
    store.writeDay(d, 'groups.jsonl', toJsonl(state.groups.filter((g) => g.day === d)));
    store.writeDay(d, 'proposals.jsonl', toJsonl(state.proposals.filter((p) => p.day === d)));
    store.writeDay(d, 'exceptions.jsonl', toJsonl(state.exceptions.filter((e) => e.openedOn === d || e.closedOn === d)));
    log(`${d} groups+${m.ruleGroups} proposals ${m.proposals.length} exceptions ${state.exceptions.filter((e) => e.openedOn === d).length} root ${pack.root.slice(0, 12)}`);

    // restatements for earlier days whose leaf set changed (late bank items)
    for (const past of state.dirtyDays.filter((x) => x !== d).sort()) {
      const v = reg.versions(dayOf(past));
      if (v === 0) continue;
      const p2 = await finishDay(past, v);
      reg.now = at(d, '17:55');
      reg.restate(reg.signer, dayOf(past), p2.root, p2.counts, BigInt(p2.shortfall), p2.reportHash, RESTATE_REASONS[plan.restate.reason]);
      log(`${d} restated ${past} as version ${v}`);
    }
    state.dirtyDays = state.dirtyDays.filter((x) => x === d);

    if (d === plan.declare.on) {
      reg.now = at(d, '17:00');
      reg.declareNonReconDay(reg.signer, dayOf(plan.declare.day), 1);
    }
    if (!plan.skip_on_time.includes(d)) attest(d, `${d}T${plan.attest_time_utc}`);
  }
  store.save(state);
  const metrics = computeMetrics(state, reg, expected);
  return { state, registry: reg, packs, expected, metrics, ctx };
}

export function computeMetrics(state: ReconState, reg: RegistryModel, expected: Expected): SeedMetrics {
  const planted = expected.planted.map((p) => {
    const hits = state.exceptions.filter((e) => p.refs.some((r) => e.evidenceIds.includes(r)));
    const exact = hits.find((e) => e.type === p.type && (!p.subReason || e.subReason === p.subReason));
    return { id: p.id, type: p.type, found: !!exact, raisedAs: hits.map((h) => h.type + (h.subReason ? `/${h.subReason}` : '')), day: exact?.openedOn };
  });
  const plantedIds = new Set(expected.planted.flatMap((p) => state.exceptions.filter((e) => p.refs.some((r) => e.evidenceIds.includes(r))).map((e) => e.id)));
  const hardAll = Object.values(expected.hard).flat();
  const hardWithException = hardAll.filter((h) => state.exceptions.some((e) => h.refs.some((r) => e.evidenceIds.includes(r)))).map((h) => h.platformId);
  const hardMatched = hardAll.filter((h) => {
    const L = state.legs[h.platformId];
    if (!L) return false;
    if (h.expectedKind === 'reversal_pair') return state.groups.some((g) => g.leg === 'reversal' && g.platformIds.includes(h.platformId));
    if (h.expectedKind.startsWith('rule:')) return !!L.chain;
    return !!L.bank && !!L.chain;
  }).length;
  const fuzzyHard = hardAll.filter((h) => !h.expectedKind.startsWith('rule:'));
  const props = state.proposals;
  const accepted = props.filter((p) => p.status === 'accepted');
  const customerGroups = state.groups.filter((g) => g.rule !== 'internal_allowed' && g.leg !== 'claim');
  const g = (m: string) => state.groups.filter((x) => x.method === m).length;
  const exp = reg.export();
  const days = expected.calendar.reconciliationDays;
  const statuses = days.map((d) => reg.status(dayOf(d)));
  return {
    planted,
    plantedFound: planted.filter((p) => p.found).length,
    plantedTotal: planted.length,
    exceptionsTotal: state.exceptions.length,
    exceptionsOnPlanted: plantedIds.size,
    exceptionsOther: state.exceptions.filter((e) => !plantedIds.has(e.id)).map((e) => ({ id: e.id, type: e.type, day: e.openedOn })),
    hardTotal: hardAll.length,
    hardMatched,
    hardWithException,
    proposals: {
      total: props.length,
      accepted: accepted.length,
      rejected: props.filter((p) => p.status === 'rejected').length,
      high: props.filter((p) => p.band === 'high').length,
      review: props.filter((p) => p.band === 'review').length,
      pending: props.filter((p) => p.status === 'pending').length,
    },
    proposalPrecision: props.length ? accepted.length / props.length : 0,
    fuzzyRecall: fuzzyHard.length ? fuzzyHard.filter((h) => accepted.some((p) => p.platformId === h.platformId)).length / fuzzyHard.length : 0,
    groups: { total: state.groups.length, rule: g('rule'), heuristic: g('heuristic'), llm: g('llm'), analyst: g('analyst'), internal: state.groups.filter((x) => x.rule === 'internal_allowed').length },
    deterministicShareOfCustomerLegs: customerGroups.length ? customerGroups.filter((x) => x.method === 'rule').length / customerGroups.length : 0,
    shortfall: Object.fromEntries(Object.entries(state.figures).map(([d, f]) => [d, (f as DailyFigures).safeguarding.shortfall ?? 'blocked'])),
    registry: {
      gaps: reg.gaps(dayOf(days[0]), dayOf(days.at(-1)!)).map(isoOf),
      restatements: exp.attestations.filter((a) => a.version > 0).length,
      attestedDays: new Set(exp.attestations.map((a) => a.day)).size,
      onTime: statuses.filter((s) => s === 'Attested').length,
      late: statuses.filter((s) => s === 'AttestedLate' || s === 'GapThenAttested').length,
    },
  };
}

export function monthlyFromSim(r: SimResult, month: string) {
  const days: { day: string; status: string; versions: number }[] = [];
  for (let d = dayOf(`${month}-01`); isoOf(d).startsWith(month); d++) {
    if (d < r.registry.cfg!.startDay) continue;
    days.push({ day: isoOf(d), status: r.registry.status(d), versions: r.registry.versions(d) });
  }
  return monthlyFigures(r.state, month, ANCHOR_NAME, r.ctx.sg.currency, days);
}

export { acceptBand };
