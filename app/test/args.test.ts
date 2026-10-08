import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP, main, parseArgs, validDay } from '../src/cli.js';

test('args: commands, flags, boolean flags, = syntax and --decide <id> <decision>', () => {
  assert.deepEqual(parseArgs(['match', '--day', '2026-08-18', '--provider', 'heuristic']), { cmd: 'match', positional: [], flags: { day: '2026-08-18', provider: 'heuristic' } });
  assert.deepEqual(parseArgs(['ingest', 'bank', '--offline', '--day=2026-08-18']).flags, { offline: true, day: '2026-08-18' });
  assert.deepEqual(parseArgs(['ingest', 'bank']).positional, ['bank']);
  const r = parseArgs(['review', '--day', '2026-08-18', '--decide', 'P-1', 'accept', '--by', 'Ana']);
  assert.equal(r.flags.decide, 'P-1');
  assert.equal(r.flags.decision, 'accept');
  assert.equal(r.flags.by, 'Ana');
  assert.equal(parseArgs([]).cmd, 'help');
  assert.throws(() => parseArgs(['match', '--day']), /needs a value/);
  assert.throws(() => parseArgs(['match', '--day', '--offline']), /needs a value/);
});

test('args: day validation', () => {
  assert.equal(validDay('2026-08-31'), '2026-08-31');
  assert.throws(() => validDay('2026-02-30'), /invalid --day/);
  assert.throws(() => validDay('18/08/2026'), /invalid --day/);
});

test('cli: help, unknown command, missing flags and provider checks', async () => {
  const out: string[] = [];
  assert.equal(await main(['help'], (s) => out.push(s)), 0);
  assert.equal(out[0], HELP);
  assert.ok(HELP.includes('testnet scripts not executed'));
  assert.equal(await main(['frobnicate'], () => {}), 2);
  await assert.rejects(main(['match'], () => {}), /--day is required/);
  await assert.rejects(main(['match', '--day', '2026-08-18', '--provider', 'llm', '--offline'], () => {}), /needs the network/);
  await assert.rejects(main(['match', '--day', '2026-08-18', '--provider', 'magic', '--data-dir', '/nonexistent-recon'], () => {}), /unknown provider/);
  await assert.rejects(main(['review', '--day', '2026-08-18', '--by', 'x', '--data-dir', '/nonexistent-recon'], () => {}), /review needs/);
  await assert.rejects(main(['simulate', '--days', '31'], () => {}), /--days/);
});
