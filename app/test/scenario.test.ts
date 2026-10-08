// scenario: `recon simulate --days 30` over the committed seed, asserted
// against expected.json. SIMULATED data; acceptance thresholds, not claims.

import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayOf, isoOf } from '../src/core/dates.js';
import { simulate, type SimResult } from '../src/simulate.js';
import { verifyPack, proofFor, verifyInclusion, type Pack } from '../src/attest/pack.js';
import { verifyChain } from '../src/attest/registryModel.js';
import { generate } from '../src/seed/generate.js';
import { main } from '../src/cli.js';
import { SEED_DIR } from './helpers.js';

let r: SimResult;
before(async () => {
  r = await simulate({ seedDir: SEED_DIR, days: 30 });
});

test('scenario: seed counts match the spec', () => {
  const c = r.expected.counts;
  assert.equal(c.platform, 400);
  assert.deepEqual(c.bySep, { sep6: 60, sep24: 180, sep31: 160 });
  assert.equal(c.travelLog, 157);
  assert.equal(r.expected.calendar.reconciliationDays.length, 21);
  assert.equal(Object.keys(r.state.platform).length, 400);
});

test('scenario: 12/12 planted breaks raised with exactly the expected type', () => {
  const k = r.metrics.planted.filter((p) => p.id.startsWith('K'));
  assert.equal(k.length, 12);
  for (const p of k) assert.ok(p.found, `${p.id} expected ${p.type}, raised ${p.raisedAs.join(',') || 'nothing'}`);
});

test('scenario: 3/3 travel-rule exceptions with the right sub-reason', () => {
  const t = r.metrics.planted.filter((p) => p.id.startsWith('T'));
  assert.equal(t.length, 3);
  for (const p of t) assert.ok(p.found, `${p.id} raised ${p.raisedAs.join(',')}`);
});

test('scenario: 0 exceptions on the matchable-hard ids once scripted decisions are applied', () => {
  assert.deepEqual(r.metrics.hardWithException, []);
  assert.equal(r.metrics.hardMatched, r.metrics.hardTotal);
  const h = r.expected.hard;
  assert.equal(h.split.length, 6);
  assert.equal(h.split.filter((s) => s.refs.filter((x) => x.startsWith('bank:')).length === 3).length, 2);
  assert.equal(h.feeDiff.length, 10);
  assert.equal(h.typo.length + h.truncated.length, 15);
  assert.equal(h.typo.length, 5);
  assert.equal(h.reversal.length, 4);
  assert.equal(h.fxDiff.length, 5);
  assert.equal(h.claimableBalance.length, 3);
  assert.equal(h.muxed.length, 12);
});

test('scenario: no exception outside the planted set; review band stays within 25', () => {
  assert.deepEqual(r.metrics.exceptionsOther, []);
  assert.ok(r.metrics.proposals.review <= 25, `review band ${r.metrics.proposals.review}`);
  assert.equal(r.metrics.proposals.pending, 0);
});

test('scenario: shortfall 341250 on 2026-08-18 and 0 on every other day', () => {
  for (const d of r.expected.calendar.reconciliationDays) {
    assert.equal(r.metrics.shortfall[d], d === '2026-08-18' ? '341250' : '0', d);
    assert.equal(r.expected.shortfall[d], r.metrics.shortfall[d], `generator and tool agree on ${d}`);
  }
});

test('scenario: model registry gaps [2026-08-20], one restatement, 21 on-time-or-late attestations', () => {
  const m = r.metrics.registry;
  assert.deepEqual(m.gaps, ['2026-08-20']);
  assert.equal(m.restatements, 1);
  assert.equal(m.attestedDays, 21);
  assert.equal(m.onTime + m.late, 21);
  assert.equal(r.registry.status(dayOf('2026-08-20')), 'GapThenAttested');
  assert.equal(r.registry.status(dayOf('2026-08-31')), 'NonReconDay');
  assert.equal(r.registry.versions(dayOf('2026-08-12')), 2);
  assert.equal(r.registry.get(dayOf('2026-08-12'), 1)!.reason, 1);
  assert.equal(r.registry.get(dayOf('2026-08-18'), 0)!.shortfall, '341250');
  assert.equal(r.registry.cosigs.get(`${dayOf('2026-08-28')}:0`)?.length, 1);
  assert.equal(r.registry.epoch, 1);
  const exp = r.registry.export();
  const chain = verifyChain(exp.attestations);
  assert.ok(chain.ok);
  assert.equal(chain.head, exp.head.hash);
});

test('scenario: verify succeeds for every day and version; a one-byte change in any pack fails', () => {
  let n = 0;
  for (const [day, packs] of r.packs) {
    for (const p of packs) {
      const onChain = r.registry.get(dayOf(day), p.version);
      assert.ok(onChain, `${day} v${p.version} attested`);
      assert.ok(verifyPack(p, onChain.root).ok, `${day} v${p.version}`);
      const json = JSON.stringify(p);
      // flip one character inside a leaf body (a digit in an amount or id)
      const i = json.indexOf('"body"') + 20;
      const c = json[i];
      const flipped = json.slice(0, i) + (c === 'a' ? 'b' : 'a') + json.slice(i + 1);
      let tampered: Pack | undefined;
      try {
        tampered = JSON.parse(flipped) as Pack;
      } catch {
        tampered = undefined; // a broken pack also fails verification
      }
      assert.ok(!tampered || !verifyPack(tampered, onChain.root).ok, `tampered ${day} v${p.version} must fail`);
      n++;
    }
  }
  assert.equal(n, 22);
});

test('scenario: a partner can check one SEP-31 payment with an inclusion proof', () => {
  const day = '2026-08-19';
  const pack = r.packs.get(day)![0];
  const sep31 = pack.leaves.find((l) => l.body.kind === 'match' && r.state.platform[l.body.platformIds[0]]?.sep === 31)!;
  const pid = sep31.body.platformIds[0];
  const [proof] = proofFor(pack, pid);
  assert.ok(verifyInclusion(proof, pid, r.registry.get(dayOf(day), 0)!.root).ok);
  assert.equal(verifyInclusion(proof, 'someone-else', undefined).ok, false);
  assert.equal(verifyInclusion({ ...proof, root: '00'.repeat(32) }, pid).ok, false);
});

test('scenario: the late Bank B line is value-dated 08-12 and drives the 08-12 restatement', () => {
  const g = r.state.groups.find((x) => x.bankLineIds.includes(r.expected.lateBankItem.line.slice(5)))!;
  assert.equal(g.day, '2026-08-12');
  const [v0, v1] = r.packs.get('2026-08-12')!;
  assert.notEqual(v0.root, v1.root);
  assert.equal(v1.counts.bank_lines, v0.counts.bank_lines, 'booked on 08-13, so the 08-12 bank line count is unchanged');
  assert.equal(v1.counts.matched_groups, v0.counts.matched_groups + 1);
});

test('scenario: the seed generator is deterministic (regenerated expected.json equals the committed one)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recon-seed-'));
  try {
    const g = generate(dir);
    const committed = JSON.parse(readFileSync(join(SEED_DIR, 'expected.json'), 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(g.expected)), committed);
    assert.equal(readFileSync(join(dir, 'bank-a', '2026-08-18.xml'), 'utf8'), readFileSync(join(SEED_DIR, 'bank-a', '2026-08-18.xml'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scenario: CLI simulate prints seed-only metrics and verify/chain commands work on its output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recon-sim-'));
  try {
    const out: string[] = [];
    assert.equal(await main(['simulate', '--days', '30', '--data-dir', dir, '--quiet'], (s) => out.push(s)), 0);
    const text = out.join('\n');
    assert.match(text, /SIMULATED DATA ONLY/);
    assert.match(text, /planted breaks found with the expected type: 15\/15/);
    const reg = join(dir, 'registry-export.json');
    assert.equal(await main(['verify', '--day', '2026-08-18', '--pack', join(dir, '2026-08-18', 'pack.json'), '--registry', reg], () => {}), 0);
    assert.equal(await main(['verify', '--chain', '--registry', reg], () => {}), 0);
    const proof = join(dir, 'proof.json');
    const pack = JSON.parse(readFileSync(join(dir, '2026-08-19', 'pack.json'), 'utf8')) as Pack;
    const pid = pack.leaves.find((l) => l.body.kind === 'match' && l.body.platformIds.length)!.body.platformIds[0];
    assert.equal(await main(['proof', '--day', '2026-08-19', '--item', pid, '--out', proof, '--pack', join(dir, '2026-08-19', 'pack.json')], () => {}), 0);
    assert.equal(await main(['verify', '--item', pid, '--proof', proof, '--registry', reg], () => {}), 0);
    assert.equal(isoOf(dayOf('2026-08-19')), '2026-08-19');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
