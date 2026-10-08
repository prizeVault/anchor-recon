#!/usr/bin/env node
// recon: three-way reconciliation for a Stellar anchor (Anchor Platform,
// Stellar ledger, bank statements), with a human review queue, safeguarding
// figures, report drafts and a Soroban attestation registry.
// --offline never touches the network. --data-dir defaults to var/.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dayOf, isoOf } from './core/dates.js';
import { formatMoney, parseMoney } from './core/money.js';
import { sha256Hex } from './core/hash.js';
import { SEED_DIR, VECTORS_DIR } from './paths.js';
import type { AiProvider } from './ai/provider.js';
import { HeuristicProvider } from './ai/heuristic.js';
import { LlmProvider } from './ai/llm.js';
import { loadContext } from './match/context.js';
import { acceptBand, closeException, decideProposal, ingestInto, matchDay, pendingProposals, reclassify } from './match/engine.js';
import { JsonlStore, toJsonl } from './store/store.js';
import { readPlatformFile, type PlatformMap } from './ingest/platform.js';
import { readHorizonFile } from './ingest/horizon.js';
import { readCamtFile } from './ingest/camt053.js';
import { readCsvFile, type CsvProfile } from './ingest/csvBank.js';
import { dailyFigures } from './report/figures.js';
import { approveReport, draftReport, reportHash } from './report/daily.js';
import { buildPack, proofFor, verifyInclusion, verifyPack, type InclusionProof, type Pack } from './attest/pack.js';
import { cryptoSalt } from './attest/leaf.js';
import { args as regArgs, describeInvoke, fetchExport, invoke, rpcConfigFromEnv, type Method } from './attest/registryClient.js';
import { OPINIONS, RESTATE_REASONS, verifyChain, type RegistryExport } from './attest/registryModel.js';
import { verifyTomlBinding } from './attest/stellarToml.js';
import { isResolution } from './exceptions/types.js';
import { makeEntryVectors, makeMerkleVectors } from './attest/vectors.js';
import { ANCHOR_NAME, generate } from './seed/generate.js';
import { monthlyFromSim, simulate } from './simulate.js';
import type { DailyFigures } from './report/figures.js';

export interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOL_FLAGS = new Set(['offline', 'dry-run', 'list', 'restate', 'chain', 'json', 'help', 'quiet']);

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) flags[name] = true;
      else {
        const v = rest[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
        flags[name] = v;
        i++;
        // `--decide <id> accept|reject`
        if (name === 'decide' && rest[i + 1] && !rest[i + 1].startsWith('--')) {
          flags['decision'] = rest[i + 1];
          i++;
        }
      }
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

function need(f: ParsedArgs['flags'], name: string): string {
  const v = f[name];
  if (typeof v !== 'string' || !v) throw new Error(`--${name} is required`);
  return v;
}

export function validDay(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isoOf(dayOf(s)) !== s) throw new Error(`invalid --day "${s}" (YYYY-MM-DD)`);
  return s;
}

function providerFrom(f: ParsedArgs['flags']): AiProvider {
  const p = (f.provider as string) ?? process.env.RECON_PROVIDER ?? 'heuristic';
  if (p === 'heuristic') return new HeuristicProvider();
  if (p === 'llm') {
    if (f.offline) throw new Error('--provider llm needs the network; drop --offline');
    return new LlmProvider();
  }
  throw new Error(`unknown provider "${p}" (heuristic|llm)`);
}

export const HELP = `recon - three-way reconciliation for Stellar anchors (functional locally; testnet scripts not executed)

  recon seed [--out <dir>]                          regenerate data/seed from the fixed seed
  recon simulate [--days 30] [--data-dir var/sim] [--json]
  recon ingest platform|chain|bank --day <d> --file <path> [--format camt053|csv --profile <json> --account <alias> --closing <amt>]
  recon match --day <d> [--provider heuristic|llm]
  recon review --day <d> --list
  recon review --day <d> --decide <proposalId> accept|reject --by <name> [--note <text>]
  recon review --day <d> --accept-band high --by <name>
  recon review --day <d> --close <exceptionId> --resolution <code> --by <name>
  recon report --day <d> [--approve <name>]
  recon attest --day <d> [--restate --reason late_bank_item|error_correction|signer_compromise|auditor_adjustment] [--dry-run]
  recon verify --day <d> --pack <pack.json> [--registry <export.json>] [--version n]
  recon verify --item <platformTxId> --proof <proof.json> [--registry <export.json>]
  recon verify --chain --registry <export.json> [--from-seq n]
  recon verify --toml <file> --registry <export.json> --registry-id <C...> --domain <home domain>
  recon proof --day <d> --item <platformTxId> --out <proof.json> [--pack <pack.json>]
  recon countersign --day <d> --version <n> --opinion agreed|agreed_with_exceptions|disagreed --pack <pack.json> --note <file> [--registry <export.json>] [--dry-run]
  recon registry init|rotate|auditor|holiday|gaps [--dry-run] (see DEMO.md)
  recon registry export --from <d> --to <d> --out <export.json>   (online: read a deployed registry)
  recon registry status --registry <export.json>
  recon vectors                                     rewrite app/test/vectors/*.json

Global: --data-dir <dir> (default var/), --offline, --provider heuristic|llm`;

async function runRegistryCall(f: ParsedArgs['flags'], method: Method, a: ReturnType<(typeof regArgs)[Method]>, secretEnv: string): Promise<unknown> {
  const desc = describeInvoke(method, a as never);
  if (f['dry-run']) return { dryRun: true, contract: process.env.RECON_REGISTRY_ID ?? '(RECON_REGISTRY_ID unset)', ...desc };
  if (f.offline) throw new Error(`${method}: --offline set; use --dry-run to print the invocation`);
  const secret = process.env[secretEnv];
  if (!secret) throw new Error(`${secretEnv} is not set`);
  return invoke(rpcConfigFromEnv(), secret, method, a as never);
}

function loadExport(path: string): RegistryExport {
  return JSON.parse(readFileSync(path, 'utf8')) as RegistryExport;
}

export async function main(argv: string[], out: (s: string) => void = (s) => console.log(s)): Promise<number> {
  const a = parseArgs(argv);
  const f = a.flags;
  if (a.cmd === 'help' || f.help) {
    out(HELP);
    return 0;
  }
  const dataDir = resolve((f['data-dir'] as string) ?? 'var');
  const seedDir = resolve((f['seed-dir'] as string) ?? SEED_DIR);

  switch (a.cmd) {
    case 'seed': {
      const dir = resolve((f.out as string) ?? SEED_DIR);
      const r = generate(dir);
      out(`wrote ${r.files.length} files to ${dir}`);
      out(`platform ${r.expected.counts.platform} (sep6 ${r.expected.counts.bySep.sep6}, sep24 ${r.expected.counts.bySep.sep24}, sep31 ${r.expected.counts.bySep.sep31}), chain ops ${r.expected.counts.chainOps}, bank A lines ${r.expected.counts.bankA}, bank B lines ${r.expected.counts.bankB}`);
      return 0;
    }
    case 'vectors': {
      mkdirSync(VECTORS_DIR, { recursive: true });
      writeFileSync(join(VECTORS_DIR, 'entry-hash.json'), JSON.stringify(makeEntryVectors(), null, 2) + '\n');
      writeFileSync(join(VECTORS_DIR, 'merkle.json'), JSON.stringify(makeMerkleVectors(), null, 2) + '\n');
      out(`wrote vectors to ${VECTORS_DIR}`);
      return 0;
    }
    case 'simulate': {
      const days = Number(f.days ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('--days must be 1..30');
      const store = f['data-dir'] ? new JsonlStore(dataDir) : undefined;
      const r = await simulate({ seedDir, days, provider: providerFrom(f), store, log: f.quiet ? undefined : (s) => out(`  ${s}`) });
      if (store) writeFileSync(join(dataDir, 'registry-export.json'), JSON.stringify(r.registry.export(), null, 1));
      const m = r.metrics;
      if (f.json) {
        out(JSON.stringify(m, null, 2));
        return m.plantedFound === m.plantedTotal ? 0 : 1;
      }
      out('');
      out('SIMULATED DATA ONLY. Seed-only numbers; not a measurement on real anchor data.');
      out(`planted breaks found with the expected type: ${m.plantedFound}/${m.plantedTotal}`);
      for (const p of m.planted) out(`  ${p.id} ${p.type.padEnd(38)} ${p.found ? 'found' : 'MISSED'} ${p.day ?? ''} ${p.found ? '' : p.raisedAs.join(',')}`);
      out(`exceptions raised: ${m.exceptionsTotal} (on planted items ${m.exceptionsOnPlanted}, other ${m.exceptionsOther.length})`);
      for (const o of m.exceptionsOther) out(`  other: ${o.type} ${o.day} ${o.id}`);
      out(`matchable-hard cases matched: ${m.hardMatched}/${m.hardTotal}; hard cases with an exception: ${m.hardWithException.length}`);
      out(`proposals: ${m.proposals.total} (high ${m.proposals.high}, review ${m.proposals.review}); accepted ${m.proposals.accepted}, rejected ${m.proposals.rejected}`);
      out(`proposal precision (accepted/proposed): ${(m.proposalPrecision * 100).toFixed(1)}%  fuzzy recall on hard cases: ${(m.fuzzyRecall * 100).toFixed(1)}%`);
      out(`groups: ${m.groups.total} (rule ${m.groups.rule}, heuristic ${m.groups.heuristic}, llm ${m.groups.llm}, analyst ${m.groups.analyst}; internal lines ${m.groups.internal}); deterministic share of customer legs ${(m.deterministicShareOfCustomerLegs * 100).toFixed(1)}%`);
      const sf = Object.entries(m.shortfall).filter(([, v]) => v !== '0');
      out(`shortfall days: ${sf.map(([d, v]) => `${d} ${formatMoney(BigInt(v), 2)} EUR`).join(', ') || 'none'}`);
      out(`registry (model): gaps ${m.registry.gaps.join(',') || 'none'}; restatements ${m.registry.restatements}; attested days ${m.registry.attestedDays} (on time ${m.registry.onTime}, late ${m.registry.late})`);
      const month = monthlyFromSim(r, '2026-08');
      if (store) {
        const draft = await draftReport(r.ctx.provider, 'monthly', '2026-08', month as unknown as Record<string, unknown>);
        writeFileSync(join(dataDir, 'monthly-2026-08.figures.json'), JSON.stringify(month, null, 1));
        writeFileSync(join(dataDir, 'monthly-2026-08.md'), draft.markdown);
        out(`monthly REP027-style draft (DRAFT, needs approval): ${join(dataDir, 'monthly-2026-08.md')}`);
      }
      out(`monthly (2026-08): expected ${month.expectedDays}, on time ${month.onTime}, late ${month.late}, gaps ${month.gaps}, restatements ${month.restatements}, shortfall days ${month.shortfallDays}`);
      return m.plantedFound === m.plantedTotal ? 0 : 1;
    }
    case 'ingest': {
      const what = a.positional[0];
      const day = validDay(need(f, 'day'));
      const ctx = loadContext(seedDir, new HeuristicProvider());
      const store = new JsonlStore(dataDir);
      const state = store.load();
      const file = need(f, 'file');
      let bundle;
      if (what === 'platform') {
        const map = JSON.parse(readFileSync(join(seedDir, 'platform-map.json'), 'utf8')) as PlatformMap;
        bundle = { platform: readPlatformFile(file, map, day), chain: [], statements: [] };
      } else if (what === 'chain') {
        bundle = { platform: [], chain: readHorizonFile(file, [ctx.sg.anchor_accounts.distribution, ctx.sg.anchor_accounts.receive]), statements: [] };
      } else if (what === 'bank') {
        const fmt = need(f, 'format');
        const account = need(f, 'account');
        if (fmt === 'camt053') bundle = { platform: [], chain: [], statements: readCamtFile(file, account) };
        else if (fmt === 'csv') {
          const profile = JSON.parse(readFileSync(need(f, 'profile'), 'utf8')) as CsvProfile;
          const closing = typeof f.closing === 'string' ? parseMoney(f.closing, 2) : undefined;
          bundle = { platform: [], chain: [], statements: [readCsvFile(file, profile, account, `${account.toUpperCase()}-${day.replace(/-/g, '')}`, { closing, closingDate: day })] };
        } else throw new Error(`unknown --format ${fmt} (camt053|csv)`);
      } else throw new Error('ingest platform|chain|bank');
      const s = ingestInto(state, day, bundle);
      store.save(state);
      out(`ingested ${what} for ${day}: platform ${s.platform}, chain ${s.chain}, bank lines ${s.bankLines}${s.statementsSkipped ? `, ${s.statementsSkipped} statement(s) already imported (no-op)` : ''}`);
      return 0;
    }
    case 'match': {
      const day = validDay(need(f, 'day'));
      const ctx = loadContext(seedDir, providerFrom(f));
      const store = new JsonlStore(dataDir);
      const state = store.load();
      const m = await matchDay(state, ctx, day);
      if (!state.processedDays.includes(day)) state.processedDays.push(day);
      store.save(state);
      store.writeDay(day, 'groups.jsonl', toJsonl(state.groups.filter((g) => g.day === day)));
      store.writeDay(day, 'proposals.jsonl', toJsonl(state.proposals.filter((p) => p.day === day)));
      store.writeDay(day, 'exceptions.jsonl', toJsonl(state.exceptions.filter((e) => e.openedOn === day)));
      out(`match ${day}: rule groups ${m.ruleGroups}, proposals ${m.proposals.length} (high ${m.proposals.filter((p) => p.band === 'high').length}, review ${m.proposals.filter((p) => p.band === 'review').length}), new exceptions ${m.exceptions.length}`);
      for (const e of m.exceptions) out(`  ${e.id} ${e.type}${e.subReason ? '/' + e.subReason : ''} ${e.amount ?? ''} ${e.currency ?? ''}`);
      return 0;
    }
    case 'review': {
      const day = validDay(need(f, 'day'));
      const store = new JsonlStore(dataDir);
      const state = store.load();
      if (f.list) {
        for (const p of state.proposals.filter((x) => x.day === day)) out(`${p.id} [${p.status}] ${p.band} ${p.score.toFixed(3)} ${p.kind} ${p.platformId} <- ${[...p.bankLineIds, ...p.chainOpIds].join(', ')}\n    ${p.reasons.join('; ')}`);
        for (const e of state.exceptions.filter((x) => x.status === 'open')) out(`${e.id} ${e.type}${e.subReason ? '/' + e.subReason : ''} opened ${e.openedOn}: ${e.explanation?.summary ?? ''} -> ${e.explanation?.suggestedAction ?? ''}`);
        return 0;
      }
      const by = need(f, 'by');
      if (typeof f.decide === 'string') {
        const dec = f.decision;
        if (dec !== 'accept' && dec !== 'reject') throw new Error('--decide <id> accept|reject');
        const p = decideProposal(state, f.decide, dec, by, { note: f.note as string | undefined, today: day });
        out(`${p.id} ${p.status} by ${by}`);
      } else if (f['accept-band'] === 'high') {
        const r = acceptBand(state, day, 'high', by);
        out(`accepted ${r.accepted.length} high-band proposals; re-check sample: ${r.sampled.join(', ') || 'none'}`);
      } else if (typeof f.close === 'string') {
        const res = need(f, 'resolution');
        if (!isResolution(res)) throw new Error(`unknown resolution ${res}`);
        const e = closeException(state, f.close, res, by, day);
        out(`${e.id} closed ${res} by ${by}`);
      } else throw new Error('review needs --list, --decide, --accept-band high or --close');
      await reclassify(state, loadContext(seedDir, new HeuristicProvider()), day);
      store.save(state);
      return 0;
    }
    case 'report': {
      const store = new JsonlStore(dataDir);
      const state = store.load();
      const ctx = loadContext(seedDir, providerFrom(f));
      if (typeof f.month === 'string') throw new Error('monthly drafts need registry status per day: run `recon simulate --data-dir <dir>` (it writes the REP027-style draft) or see DEMO.md');
      const day = validDay(need(f, 'day'));
      if (typeof f.approve === 'string') {
        const r = state.reports[day];
        if (!r) throw new Error(`no draft for ${day}; run recon report --day ${day} first`);
        state.reports[day] = approveReport(r, f.approve, new Date().toISOString());
        store.writeDay(day, 'report.md', state.reports[day].markdown);
        store.save(state);
        out(`report ${day} approved by ${f.approve}; report_hash ${reportHash(state.reports[day])}`);
        return 0;
      }
      const figures = dailyFigures(state, ctx, day, ANCHOR_NAME);
      state.figures[day] = figures;
      const r = await draftReport(ctx.provider, 'daily', day, figures as unknown as Record<string, unknown>);
      state.reports[day] = r;
      store.writeDay(day, 'figures.json', JSON.stringify(figures, null, 1));
      store.writeDay(day, 'report.md', r.markdown);
      store.save(state);
      out(r.markdown);
      return 0;
    }
    case 'attest': {
      const day = validDay(need(f, 'day'));
      const store = new JsonlStore(dataDir);
      const state = store.load();
      const pending = pendingProposals(state, day);
      if (pending.length) throw new Error(`refusing to attest ${day}: ${pending.length} undecided proposal(s)`);
      const r = state.reports[day];
      if (!r?.approvedBy) throw new Error(`refusing to attest ${day}: daily report not approved`);
      const figures = state.figures[day] as DailyFigures;
      const version = f.restate ? Number(f.version ?? 1) : 0;
      const pack = buildPack(state, day, version, cryptoSalt, figures.safeguarding.shortfall ?? '0', r.figuresHash, reportHash(r));
      store.writeDay(day, version ? `pack.v${version}.json` : 'pack.json', JSON.stringify(pack, null, 1));
      const d = dayOf(day);
      let res: unknown;
      if (f.restate) {
        const reason = RESTATE_REASONS[need(f, 'reason')];
        if (!reason) throw new Error('--reason late_bank_item|error_correction|signer_compromise|auditor_adjustment');
        res = await runRegistryCall(f, 'restate', regArgs.restate(d, pack.root, pack.counts, BigInt(pack.shortfall), pack.reportHash, reason), 'RECON_SIGNER_SECRET');
      } else res = await runRegistryCall(f, 'attest', regArgs.attest(d, pack.root, pack.counts, BigInt(pack.shortfall), pack.reportHash), 'RECON_SIGNER_SECRET');
      out(`pack written: ${join(dataDir, day)} root ${pack.root}`);
      out(JSON.stringify(res, null, 1));
      return 0;
    }
    case 'verify': {
      if (typeof f.item === 'string') {
        const proof = JSON.parse(readFileSync(need(f, 'proof'), 'utf8')) as InclusionProof;
        const exp = typeof f.registry === 'string' ? loadExport(f.registry) : undefined;
        const onChain = exp?.attestations.filter((x) => x.day === dayOf(proof.day) && x.version === proof.version)[0];
        const r = verifyInclusion(proof, f.item, onChain?.root);
        out(r.ok ? `OK: ${f.item} is in the attested set of ${proof.day} v${proof.version} (root ${proof.root})` : `FAIL: ${r.errors.join('; ')}`);
        return r.ok ? 0 : 1;
      }
      if (f.chain) {
        const exp = loadExport(need(f, 'registry'));
        const r = verifyChain(exp.attestations, Number(f['from-seq'] ?? 1));
        const ok = r.ok && r.head === exp.head.hash;
        out(ok ? `OK: entry-hash chain of ${exp.attestations.length} entries reproduces head ${exp.head.hash}` : `FAIL: chain broken at seq ${r.brokenAt ?? '?'}`);
        return ok ? 0 : 1;
      }
      if (typeof f.toml === 'string') {
        const exp = loadExport(need(f, 'registry'));
        const r = verifyTomlBinding(readFileSync(f.toml, 'utf8'), need(f, 'registry-id'), exp.config.homeDomain, need(f, 'domain'));
        out(r.ok ? 'OK: stellar.toml names the registry and the registry names the home domain' : `FAIL: ${r.errors.join('; ')}`);
        return r.ok ? 0 : 1;
      }
      const day = validDay(need(f, 'day'));
      const pack = JSON.parse(readFileSync(need(f, 'pack'), 'utf8')) as Pack;
      const version = Number(f.version ?? pack.version ?? 0);
      const exp = typeof f.registry === 'string' ? loadExport(f.registry) : undefined;
      const onChain = exp?.attestations.find((x) => x.day === dayOf(day) && x.version === version);
      if (exp && !onChain) throw new Error(`registry export has no attestation for ${day} v${version}`);
      const r = verifyPack(pack, onChain?.root);
      out(r.ok ? `OK: ${day} v${version} root ${r.root}${onChain ? ' matches the registry' : ' (no registry given; pack self-consistent)'}` : `FAIL: ${r.errors.join('; ')}`);
      return r.ok ? 0 : 1;
    }
    case 'proof': {
      const day = validDay(need(f, 'day'));
      const packPath = (f.pack as string) ?? join(dataDir, day, 'pack.json');
      const pack = JSON.parse(readFileSync(packPath, 'utf8')) as Pack;
      const proofs = proofFor(pack, need(f, 'item'));
      if (!proofs.length) throw new Error(`${f.item} is not in the ${day} pack`);
      writeFileSync(need(f, 'out'), JSON.stringify(proofs[0], null, 1));
      out(`wrote proof for ${f.item} (${proofs.length} leaf/leaves name it; first written)`);
      return 0;
    }
    case 'countersign': {
      const day = validDay(need(f, 'day'));
      const version = Number(need(f, 'version'));
      const opinion = OPINIONS[need(f, 'opinion')];
      if (!opinion) throw new Error('--opinion agreed|agreed_with_exceptions|disagreed');
      const pack = JSON.parse(readFileSync(need(f, 'pack'), 'utf8')) as Pack;
      const exp = typeof f.registry === 'string' ? loadExport(f.registry) : undefined;
      const onChain = exp?.attestations.find((x) => x.day === dayOf(day) && x.version === version);
      const v = verifyPack(pack, onChain?.root);
      if (!v.ok) {
        out(`refusing to countersign: ${v.errors.join('; ')}`);
        return 1;
      }
      const noteHash = sha256Hex(readFileSync(need(f, 'note')));
      const auditor = process.env.AUDITOR_PUBLIC ?? need(f, 'auditor');
      const res = await runRegistryCall(f, 'countersign', regArgs.countersign(auditor, dayOf(day), version, opinion, noteHash), 'AUDITOR_SECRET');
      out(JSON.stringify(res, null, 1));
      return 0;
    }
    case 'registry': {
      const sub = a.positional[0];
      let res: unknown;
      if (sub === 'init') {
        res = await runRegistryCall(
          f,
          'init' as Method,
          regArgs.init({
            admin: need(f, 'admin'),
            signer: need(f, 'signer'),
            startDay: dayOf(validDay(need(f, 'start'))),
            weekdayMask: Number(f.mask ?? 31),
            graceSecs: Number(f.grace ?? 43200),
            currency: (f.currency as string) ?? 'EUR',
            decimals: Number(f.decimals ?? 2),
            homeDomain: need(f, 'home-domain'),
          }) as never,
          'RECON_ADMIN_SECRET',
        );
      } else if (sub === 'rotate') res = await runRegistryCall(f, 'rotate_signer', regArgs.rotate_signer(need(f, 'new-signer'), f.reason === 'compromise' ? 2 : 1, Number(f['compromised-since'] ?? 0)), 'RECON_ADMIN_SECRET');
      else if (sub === 'auditor') res = await runRegistryCall(f, 'set_auditor', regArgs.set_auditor(need(f, 'auditor'), f.active !== 'false'), 'RECON_ADMIN_SECRET');
      else if (sub === 'holiday') res = await runRegistryCall(f, 'declare_non_recon_day', regArgs.declare_non_recon_day(dayOf(validDay(need(f, 'day'))), f.reason === 'other' ? 2 : 1), 'RECON_SIGNER_SECRET');
      else if (sub === 'gaps') res = await runRegistryCall(f, 'mark_gaps', regArgs.mark_gaps(dayOf(validDay(need(f, 'up-to')))), 'RECON_ANYONE_SECRET');
      else if (sub === 'export') {
        if (f.offline) throw new Error('registry export reads a deployed registry; drop --offline');
        const from = dayOf(validDay(need(f, 'from')));
        const to = dayOf(validDay(need(f, 'to')));
        if (to < from) throw new Error('--to is before --from');
        const exp = await fetchExport(rpcConfigFromEnv(), from, to);
        writeFileSync(need(f, 'out'), JSON.stringify(exp, null, 1));
        res = { wrote: f.out, attestations: exp.attestations.length, head: exp.head, gaps: Object.keys(exp.gaps).map((d) => isoOf(Number(d))) };
      } else if (sub === 'status') {
        const exp = loadExport(need(f, 'registry'));
        const rows = exp.attestations.map((x) => `${isoOf(x.day)} v${x.version} seq ${x.seq} late ${x.late} shortfall ${x.shortfall} root ${x.root.slice(0, 16)}...`);
        res = { head: exp.head, gaps: Object.keys(exp.gaps).map((d) => isoOf(Number(d))), attestations: rows };
      } else throw new Error('registry init|rotate|auditor|holiday|gaps|export|status');
      out(JSON.stringify(res, null, 1));
      return 0;
    }
    default:
      out(HELP);
      return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '') && process.argv[1].endsWith('cli.js');
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: Error) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    });
}

