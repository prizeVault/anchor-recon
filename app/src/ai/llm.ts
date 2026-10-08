// LlmProvider: calls the Anthropic Messages API when LLM_API_KEY is set
// (model from LLM_MODEL, default claude-sonnet-5), with strict JSON output,
// ajv validation and one retry that feeds the errors back.
// - proposeMatches: the heuristic runs first; only blocks with a review-band
//   proposal are sent to the model, which may re-score and add reasons. The
//   guard rejects unknown ids, amounts that do not reconcile and kinds that
//   contradict the arithmetic; on rejection the heuristic proposal stands.
// - explainException: guarded (type, evidence ids, numbers, allowed action);
//   falls back to the heuristic template.
// - draftReport: numbers guard; falls back to the template.
// Customer name tokens are pseudonymised unless LLM_PERSONAL_DATA_ALLOWED=true.
// Tests never call the network: they inject a fake client with recorded replies.

import Anthropic from '@anthropic-ai/sdk';
import type { Explanation } from '../types.js';
import { guardExplanation, guardProposals, guardReport } from './guard.js';
import { heuristicExplanation, heuristicProposals } from './heuristic.js';
import type { AiProvider, ExplainInput, ProposalOut, ProposeInput, ProposeOutput, ReportInput } from './provider.js';
import { EXPLANATION_SCHEMA, PROPOSALS_SCHEMA, validateExplanation, validateProposals } from './schemas.js';
import { renderTemplate } from './template.js';
import { Pseudonymiser, personalDataAllowed } from './pseudonymise.js';

export const DEFAULT_LLM_MODEL = 'claude-sonnet-5';

export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface LlmOptions {
  apiKey?: string;
  model?: string;
  client?: MessagesClient;
  maxAttempts?: number;
  personalData?: boolean;
  pseudoSalt?: string;
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}

const MATCH_SYSTEM = `You re-score reconciliation match proposals for a Stellar anchor's operations analyst.
You receive one block: bank lines, platform transactions (SEP-6/24/31) and optionally chain operations, the fee schedule, and the heuristic proposals.
Amounts are integer minor units (EUR cents; 7-decimal units on chain). Never invent ids. Never change which items a proposal links unless the arithmetic in the block supports it.
A split must sum to the transaction amount within the fee schedule; a fee_diff must equal a listed bank charge; an fx_diff applies only to SEP-31 payouts within fx_band_bps.
Score between 0 and 1: >= 0.90 band "high", 0.60 to 0.90 band "review". Add short reasons citing ids and amounts from the block only.
A human analyst accepts or rejects every proposal. Return one JSON object matching the schema.`;

const EXPLAIN_SYSTEM = `You explain one reconciliation exception to an anchor's operations analyst in at most 400 characters.
Cite only evidence ids you were given and only numbers that appear in the evidence. Choose likelyCause and suggestedAction from the schema enums.
Return one JSON object matching the schema.`;

const REPORT_SYSTEM = `You draft a safeguarding reconciliation report in markdown for sign-off by a compliance officer.
Use only the figures provided; do not compute new numbers, do not round, do not add numbers that are not in the figures.
The draft is not legal advice. Keep it short and factual.`;

export class LlmProvider implements AiProvider {
  readonly name = 'llm' as const;
  readonly model: string;
  private readonly client: MessagesClient;
  private readonly maxAttempts: number;
  private readonly pseudo?: Pseudonymiser;
  readonly log: string[] = [];

  constructor(opts: LlmOptions = {}) {
    this.model = opts.model ?? process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
    this.maxAttempts = opts.maxAttempts ?? 2;
    const allowed = opts.personalData ?? personalDataAllowed();
    this.pseudo = allowed ? undefined : new Pseudonymiser(opts.pseudoSalt);
    if (opts.client) this.client = opts.client;
    else {
      const apiKey = opts.apiKey ?? process.env.LLM_API_KEY;
      if (!apiKey) throw new Error('LlmProvider needs LLM_API_KEY (or an injected client)');
      this.client = new Anthropic({ apiKey });
    }
  }

  private async ask(system: string, user: string, schema: object, validate: (x: unknown) => { ok: boolean; errors?: string[]; value?: unknown }): Promise<unknown> {
    let errors: string[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const content = attempt === 1 ? user : `${user}\n\nYour previous answer failed validation:\n${errors.map((e) => `- ${e}`).join('\n')}\nReturn a corrected JSON object.`;
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
      } as Anthropic.MessageCreateParamsNonStreaming);
      if (res.stop_reason === 'refusal') throw new Error('model declined');
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      let parsed: unknown;
      try {
        parsed = extractJson(text);
      } catch (e) {
        errors = [`not valid JSON: ${(e as Error).message}`];
        continue;
      }
      const v = validate(parsed);
      if (v.ok) return parsed;
      errors = v.errors ?? ['invalid'];
    }
    throw new Error(`model output failed schema validation after ${this.maxAttempts} attempts: ${errors.slice(0, 4).join('; ')}`);
  }

  private maskInput(input: ProposeInput): ProposeInput {
    if (!this.pseudo) return input;
    const p = this.pseudo;
    const tokens = input.block.platformTxs.flatMap((t) => t.customerNameTokens);
    return {
      ...input,
      block: {
        ...input.block,
        platformTxs: input.block.platformTxs.map((t) => ({ ...t, customerNameTokens: t.customerNameTokens.map(p.token) })),
        bankLines: input.block.bankLines.map((l) => ({ ...l, narrative: p.text(l.narrative, tokens), counterparty: l.counterparty ? p.text(l.counterparty, tokens) : undefined })),
      },
    };
  }

  async proposeMatches(input: ProposeInput): Promise<ProposeOutput> {
    const heuristic = heuristicProposals(input);
    if (!heuristic.some((p) => p.band === 'review')) return { proposals: heuristic, provider: 'heuristic' };
    const masked = this.maskInput(input);
    try {
      const raw = (await this.ask(
        MATCH_SYSTEM,
        JSON.stringify({ block: masked.block, feeSchedule: masked.feeSchedule, heuristicProposals: heuristic }),
        PROPOSALS_SCHEMA,
        (x) => validateProposals(x),
      )) as { proposals: ProposalOut[] };
      const g = guardProposals(input, raw.proposals);
      if (!g.ok) {
        this.log.push(`guard rejected model proposals: ${g.errors.join('; ')}`);
        return { proposals: heuristic, provider: 'heuristic' };
      }
      // Only review-band re-scores are taken; high-band heuristic proposals stand.
      const keep = heuristic.filter((p) => p.band === 'high');
      const keepItems = new Set(keep.flatMap((p) => [...p.bankLineIds, ...p.chainOpIds, p.platformId]));
      const fromModel = raw.proposals.filter((p) => ![...p.bankLineIds, ...p.chainOpIds, p.platformId].some((i) => keepItems.has(i)));
      return { proposals: [...keep, ...fromModel], provider: 'llm' };
    } catch (e) {
      this.log.push(`model call failed, heuristic stands: ${(e as Error).message}`);
      return { proposals: heuristic, provider: 'heuristic' };
    }
  }

  async explainException(input: ExplainInput): Promise<Explanation> {
    try {
      const raw = (await this.ask(EXPLAIN_SYSTEM, JSON.stringify({ exception: input.exception, evidence: input.evidence }), EXPLANATION_SCHEMA, (x) => validateExplanation(x))) as Omit<Explanation, 'provider'>;
      const e: Explanation = { ...raw, provider: 'llm' } as Explanation;
      const g = guardExplanation(input, e);
      if (g.ok) return e;
      this.log.push(`guard rejected explanation: ${g.errors.join('; ')}`);
    } catch (err) {
      this.log.push(`explanation call failed: ${(err as Error).message}`);
    }
    return heuristicExplanation(input);
  }

  async draftReport(input: ReportInput): Promise<{ markdown: string; provider: string; fellBack: boolean }> {
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system: REPORT_SYSTEM,
        messages: [{ role: 'user', content: `Figures (JSON):\n${JSON.stringify(input.figures)}` }],
      });
      const md = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const g = guardReport(md, input.figures);
      if (g.ok) return { markdown: md, provider: 'llm', fellBack: false };
      this.log.push(`numbers guard rejected draft: ${g.errors.slice(0, 5).join('; ')}`);
    } catch (err) {
      this.log.push(`report call failed: ${(err as Error).message}`);
    }
    return { markdown: renderTemplate(input.kind, input.figures), provider: 'template', fellBack: true };
  }
}
