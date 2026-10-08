import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BusinessCalendar } from '../src/core/dates.js';
import { nameTokens, normaliseNarrative } from '../src/ingest/normalise.js';
import { parsePlatformExport, DEFAULT_PLATFORM_MAP } from '../src/ingest/platform.js';
import { parseHorizonPage } from '../src/ingest/horizon.js';
import type { Statement } from '../src/ingest/camt053.js';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import type { AiProvider } from '../src/ai/provider.js';
import type { ReconContext } from '../src/match/context.js';
import { tolerancesFrom } from '../src/match/tolerance.js';
import { ingestInto, matchDay } from '../src/match/engine.js';
import { emptyState, type ReconState } from '../src/store/store.js';
import { FEE_SCHEDULE, SG_CONFIG_FOR_SEED } from '../src/seed/generate.js';
import type { BankLine, FeeSchedule, SafeguardingConfig } from '../src/types.js';
import type { Fixture, FixtureLine } from './fixtures/build.js';

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(here, '..', '..');
export const PROJECT_ROOT = resolve(APP_ROOT, '..');
export const FIXTURES = join(APP_ROOT, 'test', 'fixtures');
export const SEED_DIR = join(PROJECT_ROOT, 'data', 'seed');

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture;
}

export function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(APP_ROOT, rel), 'utf8')) as T;
}

export function testCtx(customers: { id: string; name: string }[] = [], over: Partial<SafeguardingConfig> = {}, provider: AiProvider = new HeuristicProvider()): ReconContext {
  const sg = { ...SG_CONFIG_FOR_SEED(), expected_accounts: [], ...over };
  const fees = FEE_SCHEDULE as FeeSchedule;
  return {
    fees,
    tol: tolerancesFrom(fees),
    sg,
    cal: new BusinessCalendar(sg.holidays),
    customers: new Map(customers.map((c) => [c.id, { id: c.id, name: c.name, tokens: nameTokens(c.name) }])),
    travelLog: new Set(['TRP-ABCDEF123456', 'TRP-ABCDEF654321', 'TRP-000000000001', 'TRP-FFFFFFFFFFF1', 'TRP-FFFFFFFFFFF2', 'TRP-EEEEEEEEEEE1']),
    provider,
  };
}

export function toLine(l: FixtureLine, day: string): BankLine {
  return {
    id: l.id,
    account: l.account,
    direction: l.direction,
    amount: BigInt(l.amount),
    currency: 'EUR',
    bookingDate: day,
    valueDate: l.valueDate,
    narrative: normaliseNarrative(l.narrative),
    rawNarrative: l.narrative,
    counterparty: l.counterparty ? normaliseNarrative(l.counterparty) : undefined,
    endToEndId: l.endToEndId,
    reversal: !!l.reversal,
    charges: l.charges ? BigInt(l.charges) : undefined,
    day,
  };
}

export function ingestFixtureDay(state: ReconState, ctx: ReconContext, fx: Fixture, day: string) {
  const platform = parsePlatformExport(fx.platform[day] ?? [], DEFAULT_PLATFORM_MAP, day);
  const chain = parseHorizonPage({ _embedded: { records: fx.chain[day] ?? [] } }, [ctx.sg.anchor_accounts.distribution, ctx.sg.anchor_accounts.receive]);
  const byAcct = new Map<string, BankLine[]>();
  for (const l of fx.bank[day] ?? []) {
    const b = toLine(l, day);
    if (!byAcct.has(b.account)) byAcct.set(b.account, []);
    byAcct.get(b.account)!.push(b);
  }
  const statements: Statement[] = [...byAcct].map(([account, lines]) => ({ stmtId: `${account}-${day}`, seq: '0', account, lines, balances: [] }));
  ingestInto(state, day, { platform, chain, statements });
}

/** Ingests and matches every day of a fixture (no review decisions). */
export async function runFixture(name: string, provider?: AiProvider) {
  const fx = loadFixture(name);
  const ctx = testCtx(fx.customers, {}, provider);
  const state = emptyState();
  const results = [];
  for (const d of fx.days) {
    ingestFixtureDay(state, ctx, fx, d);
    results.push(await matchDay(state, ctx, d));
    state.processedDays.push(d);
  }
  return { fx, ctx, state, results };
}
