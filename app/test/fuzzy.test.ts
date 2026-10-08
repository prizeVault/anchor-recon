import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { runFixture, loadFixture, testCtx, ingestFixtureDay } from './helpers.js';
import { decideProposal, matchDay, reclassify } from '../src/match/engine.js';
import { emptyState } from '../src/store/store.js';
import { LlmProvider, extractJson, type MessagesClient } from '../src/ai/llm.js';
import { guardProposals } from '../src/ai/guard.js';
import { heuristicProposals } from '../src/ai/heuristic.js';
import { validateProposals } from '../src/ai/schemas.js';
import type { ProposeInput } from '../src/ai/provider.js';
import { buildBlocks, anchorDate } from '../src/match/candidates.js';
import { bankLineView, chainOpView, feeView, platformTxView } from '../src/ai/provider.js';

test('fuzzy: splits of 2 lines (same day) and 3 lines (over 2 business days)', async () => {
  const { state, results } = await runFixture('split');
  assert.equal(results[0].proposals.filter((p) => p.kind === 'split').length, 1, 'day 1: only the complete 2-line split');
  assert.equal(state.exceptions.length, 0, 'the first parts of the 3-line split are held, not raised');
  const splits = state.proposals.filter((p) => p.kind === 'split');
  const byTx = Object.fromEntries(splits.map((p) => [p.platformId, p.bankLineIds]));
  assert.deepEqual(byTx, { 'tx-split-2': ['A:s1', 'A:s2'], 'tx-split-3': ['A:t1', 'A:t2', 'A:t3'] });
  assert.ok(splits.every((p) => p.band === 'high'));
});

test('fuzzy: a fee inside the schedule matches; one outside raises AMOUNT_MISMATCH', async () => {
  const { state } = await runFixture('fee-diff');
  const p = state.proposals.find((x) => x.platformId === 'tx-fee-in')!;
  assert.equal(p.kind, 'fee_diff');
  assert.ok(p.reasons.some((r) => r.includes('listed bank charge')));
  assert.equal(state.proposals.some((x) => x.platformId === 'tx-fee-out'), false);
  const ex = state.exceptions.find((e) => e.evidenceIds.includes('ptx:tx-fee-out'))!;
  assert.equal(ex.type, 'AMOUNT_MISMATCH');
  assert.equal(ex.day, '2026-08-11', 'raised after the one-business-day hold');
});

test('fuzzy: FX at 49 bps matches, at 51 bps is raised', async () => {
  const { state } = await runFixture('fx-diff');
  const p = state.proposals.find((x) => x.platformId === 'tx-fx-49')!;
  assert.equal(p.kind, 'fx_diff');
  assert.equal(p.band, 'high');
  assert.equal(state.proposals.some((x) => x.platformId === 'tx-fx-51'), false);
  const ex = state.exceptions.find((e) => e.evidenceIds.includes('ptx:tx-fx-51'))!;
  assert.equal(ex.type, 'SHORT_PAYOUT');
});

test('fuzzy: a closed reversal pair is matched; an open one raises REVERSAL_OPEN', async () => {
  const { state } = await runFixture('reversal');
  const rp = state.proposals.find((p) => p.kind === 'reversal_pair')!;
  assert.equal(rp.platformId, 'tx-rev-closed');
  assert.deepEqual(rp.bankLineIds, ['B:r1ret']);
  decideProposal(state, rp.id, 'accept', 'Test Analyst');
  assert.ok(state.groups.some((g) => g.leg === 'reversal' && g.platformIds[0] === 'tx-rev-closed' && g.decidedBy === 'Test Analyst'));
  assert.ok(state.groups.some((g) => g.leg === 'refund' && g.platformIds[0] === 'tx-rev-closed'), 'refund payment matched by refund tx hash');
  const open = state.exceptions.find((e) => e.type === 'REVERSAL_OPEN')!;
  assert.ok(open.evidenceIds.includes('ptx:tx-rev-open'));
  assert.ok(open.evidenceIds.includes('bank:B:r2ret'));
  assert.equal(open.amount, '60000');
});

test('fuzzy: truncated narrative and a 1-edit AR typo corrected by the check digit', async () => {
  const { state, fx } = await runFixture('truncated');
  const tr = state.proposals.find((p) => p.platformId === 'tx-trunc')!;
  assert.deepEqual(tr.bankLineIds, ['B:tr']);
  assert.ok(tr.reasons[0].includes('truncated token'));
  const rv = state.proposals.find((p) => p.platformId === 'tx-review')!;
  assert.equal(rv.band, 'review', 'short prefix and initials only: the analyst decides');
  const ty = state.proposals.find((p) => p.platformId === 'tx-typo')!;
  assert.deepEqual(ty.bankLineIds, ['A:ty']);
  assert.ok(ty.reasons[0].includes(`check digit rejects ${fx.expect.typoToken}`));
  assert.equal(ty.band, 'high');
});

test('fuzzy: an orphan becomes an exception after the hold', async () => {
  const { state, results } = await runFixture('orphan');
  assert.equal(results[0].exceptions.length, 0, 'held on the booking day');
  assert.deepEqual(state.exceptions.map((e) => e.type).sort(), ['UNMATCHED_BANK_CREDIT', 'UNMATCHED_CHAIN_IN']);
  assert.ok(state.exceptions.every((e) => e.explanation && e.explanation.summary.length <= 400));
});

test('fuzzy: a rejected proposal frees its items and they surface as exceptions', async () => {
  const fx = loadFixture('fee-diff');
  const ctx = testCtx(fx.customers);
  const state = emptyState();
  ingestFixtureDay(state, ctx, fx, '2026-08-10');
  await matchDay(state, ctx, '2026-08-10');
  const p = state.proposals.find((x) => x.platformId === 'tx-fee-in')!;
  decideProposal(state, p.id, 'reject', 'Test Analyst', { note: 'not this one' });
  ingestFixtureDay(state, ctx, fx, '2026-08-11');
  await reclassify(state, ctx, '2026-08-11');
  // the rejected line is not forced onto the transaction: it is an unmatched credit, and the deposit has no bank leg
  assert.ok(state.exceptions.some((e) => e.type === 'UNMATCHED_BANK_CREDIT' && e.evidenceIds.includes('bank:A:f1')));
  assert.ok(state.exceptions.some((e) => e.type === 'PLATFORM_NO_BANK_LEG' && e.evidenceIds.includes('ptx:tx-fee-in')));
  assert.equal(state.decisions.at(-1)!.by, 'Test Analyst');
});

test('fuzzy: output is deterministic', async () => {
  const a = await runFixture('truncated');
  const b = await runFixture('truncated');
  const strip = (s: typeof a.state) => s.proposals.map((p) => [p.platformId, p.bankLineIds, p.score, p.band, p.kind, p.reasons]);
  assert.deepEqual(strip(a.state), strip(b.state));
});

// ------------------------------------------------------------------ LLM provider with recorded replies

async function blockInput(name: string, pid?: string): Promise<ProposeInput> {
  const fx = loadFixture(name);
  const ctx = testCtx(fx.customers);
  const state = emptyState();
  ingestFixtureDay(state, ctx, fx, fx.days[0]);
  const { deterministicPass } = await import('../src/match/deterministic.js');
  deterministicPass(state, ctx, fx.days[0]);
  const blocks = buildBlocks(state, ctx);
  const b = (pid && blocks.find((x) => x.platformTxs.some((p) => p.id === pid))) || blocks.find((x) => x.bankLines.length > 0)!;
  return {
    day: fx.days[0],
    block: {
      bankLines: b.bankLines.map(bankLineView),
      platformTxs: b.platformTxs.map((p) => platformTxView(p, ctx.customers, anchorDate(p))),
      chainOps: b.chainOps.map(chainOpView),
      splitHints: b.splits.map((s) => ({ platformId: s.platformId, lineIds: s.lineIds })),
    },
    feeSchedule: feeView(ctx.tol),
    holidays: ctx.sg.holidays,
  };
}

function fakeClient(replies: string[]): MessagesClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const text = replies.shift() ?? '{}';
        return { id: 'msg', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text, citations: null }] } as unknown as Anthropic.Message;
      },
    },
  };
}

test('llm: recorded reply is parsed (code fences tolerated) and re-scores a review-band proposal', async () => {
  const input = await blockInput('truncated', 'tx-review');
  const h = heuristicProposals(input);
  const review = h.find((p) => p.band === 'review');
  assert.ok(review, 'the truncated payout is in the review band');
  const reply = { proposals: h.map((p) => (p === review ? { ...p, score: 0.88, reasons: [...p.reasons, 'initial and surname prefix match the beneficiary'] } : p)) };
  const client = fakeClient(['```json\n' + JSON.stringify(reply) + '\n```']);
  const llm = new LlmProvider({ client, personalData: false, pseudoSalt: 'fixed' });
  const out = await llm.proposeMatches(input);
  assert.equal(out.provider, 'llm');
  assert.equal(client.calls.length, 1);
  const sent = String(client.calls[0].messages[0].content);
  assert.ok(!sent.includes('OSTERGAARD') && sent.includes('customerNameTokens'), 'customer name tokens are pseudonymised by default');
  assert.equal(out.proposals.find((p) => p.platformId === review.platformId)!.score, 0.88);
  assert.deepEqual(extractJson('noise {"a":1} noise'), { a: 1 });
});

test('llm: schema rejection triggers one retry with the validation errors', async () => {
  const input = await blockInput('truncated', 'tx-review');
  const h = heuristicProposals(input);
  const bad = JSON.stringify({ proposals: [{ platformId: 'tx-trunc', score: 2 }] });
  const good = JSON.stringify({ proposals: h });
  const client = fakeClient([bad, good]);
  const llm = new LlmProvider({ client, personalData: true });
  const out = await llm.proposeMatches(input);
  assert.equal(client.calls.length, 2);
  assert.match(String(client.calls[1].messages[0].content), /failed validation/);
  assert.equal(out.provider, 'llm');
  assert.equal(validateProposals(JSON.parse(bad)).ok, false);
});

test('llm: guard rejects an unknown id and an inconsistent split; the heuristic proposal stands', async () => {
  const input = await blockInput('truncated', 'tx-review');
  const h = heuristicProposals(input);
  const unknown = { proposals: [{ ...h[0], bankLineIds: ['B:does-not-exist'] }] };
  assert.equal(guardProposals(input, unknown.proposals).ok, false);
  const llm = new LlmProvider({ client: fakeClient([JSON.stringify(unknown)]), personalData: true });
  const out = await llm.proposeMatches(input);
  assert.equal(out.provider, 'heuristic');
  assert.deepEqual(out.proposals, h);
  assert.match(llm.log[0], /unknown bank line/);

  const split = await blockInput('split');
  const hs = heuristicProposals(split);
  const s = hs.find((p) => p.kind === 'split')!;
  split.block.bankLines.push({ id: 'A:extra', account: 'bank-a', direction: 'credit', amount: '1', currency: 'EUR', valueDate: split.day, narrative: 'X' });
  const wrong = [{ ...s, bankLineIds: s.bankLineIds.slice(0, 1).concat('A:extra') }];
  const g = guardProposals(split, wrong);
  assert.equal(g.ok, false);
  assert.ok(g.errors.some((e) => /do not reconcile/.test(e)), g.errors.join(';'));
  const single = [{ ...s, kind: 'split' as const, bankLineIds: [s.bankLineIds[0]] }];
  assert.ok(guardProposals(split, single).errors.some((e) => /fewer than 2/.test(e)));
});

test('llm: a model failure falls back to the heuristic without throwing', async () => {
  const input = await blockInput('truncated', 'tx-review');
  const client: MessagesClient = { messages: { create: async () => { throw new Error('network down'); } } };
  const llm = new LlmProvider({ client });
  const out = await llm.proposeMatches(input);
  assert.equal(out.provider, 'heuristic');
  if (!process.env.LLM_API_KEY) assert.throws(() => new LlmProvider({ apiKey: undefined, client: undefined }), /LLM_API_KEY/);
});
