import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptBand, decideProposal, highBandSample, manualMatch } from '../src/match/engine.js';
import { JsonlStore } from '../src/store/store.js';
import { main } from '../src/cli.js';
import { runFixture } from './helpers.js';
import type { Proposal } from '../src/types.js';

test('review: attest is refused with undecided proposals, then with an unapproved report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recon-review-'));
  try {
    const { state } = await runFixture('fee-diff');
    const store = new JsonlStore(dir);
    store.save(state);
    const out: string[] = [];
    await assert.rejects(main(['attest', '--day', '2026-08-11', '--data-dir', dir, '--dry-run', '--offline'], (s) => out.push(s)), /undecided proposal/);
    const s2 = store.load();
    for (const p of s2.proposals) decideProposal(s2, p.id, 'accept', 'Test Analyst');
    store.save(s2);
    await assert.rejects(main(['attest', '--day', '2026-08-11', '--data-dir', dir, '--dry-run', '--offline'], (s) => out.push(s)), /not approved/);
    assert.equal(await main(['report', '--day', '2026-08-11', '--data-dir', dir, '--offline'], (s) => out.push(s)), 0);
    assert.equal(await main(['report', '--day', '2026-08-11', '--data-dir', dir, '--approve', 'C. Compliance'], (s) => out.push(s)), 0);
    assert.equal(await main(['attest', '--day', '2026-08-11', '--data-dir', dir, '--dry-run', '--offline'], (s) => out.push(s)), 0);
    assert.ok(out.join('\n').includes('"method": "attest"'));
    await assert.rejects(main(['attest', '--day', '2026-08-11', '--data-dir', dir, '--offline'], () => {}), /--offline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review: the decision log carries the reviewer name; a name is required', async () => {
  const { state } = await runFixture('truncated');
  const [p] = state.proposals;
  assert.throws(() => decideProposal(state, p.id, 'accept', '  '), /reviewer name/);
  decideProposal(state, p.id, 'accept', 'R. Reviewer', { note: 'checked portal' });
  const last = state.decisions.at(-1)!;
  assert.equal(last.by, 'R. Reviewer');
  assert.equal(last.action, 'proposal:accept');
  assert.equal(last.note, 'checked portal');
  const g = state.groups.find((x) => x.proposalId === p.id)!;
  assert.equal(g.decidedBy, 'R. Reviewer');
  assert.equal(g.method, 'heuristic');
  assert.throws(() => decideProposal(state, p.id, 'reject', 'R. Reviewer'), /already accepted/);
});

test('review: the high-band re-check sample is deterministic per day (10%, at least one)', () => {
  const ps = Array.from({ length: 23 }, (_, i) => ({ id: `P-${i}`, band: 'high' }) as Proposal);
  const a = highBandSample('2026-08-18', ps);
  assert.equal(a.length, 3);
  assert.deepEqual(highBandSample('2026-08-18', [...ps].reverse()), a);
  assert.notDeepEqual(highBandSample('2026-08-19', ps), a);
  assert.deepEqual(highBandSample('2026-08-18', [{ id: 'X', band: 'review' } as Proposal]), []);
});

test('review: accept-band records the sampled items; manual match uses method analyst', async () => {
  const { state } = await runFixture('split');
  const r = acceptBand(state, '2026-08-11', 'high', 'Band Accepter');
  assert.equal(r.accepted.length, 1);
  assert.equal(r.sampled.length, 1);
  assert.ok(state.decisions.some((d) => d.action === 'band:accept' && d.by === 'Band Accepter'));
  const { state: s2 } = await runFixture('orphan');
  assert.throws(() => manualMatch(s2, '2026-08-11', 'nope', ['A:orph'], 'X'), /unknown platform/);
});
