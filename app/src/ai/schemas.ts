// Strict JSON schemas for model output, validated with ajv.

import { Ajv } from 'ajv';

export const PROPOSALS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['bankLineIds', 'chainOpIds', 'platformId', 'kind', 'score', 'band', 'reasons'],
        properties: {
          bankLineIds: { type: 'array', items: { type: 'string' } },
          chainOpIds: { type: 'array', items: { type: 'string' } },
          platformId: { type: 'string' },
          kind: { type: 'string', enum: ['single', 'split', 'fee_diff', 'fx_diff', 'reversal_pair'] },
          score: { type: 'number', minimum: 0, maximum: 1 },
          band: { type: 'string', enum: ['high', 'review'] },
          reasons: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 8 },
        },
      },
    },
  },
} as const;

export const LIKELY_CAUSES = [
  'MISSING_ONCHAIN_DELIVERY',
  'DUPLICATE_PROCESSING',
  'PARTIAL_OR_SHORT_PAYOUT',
  'SENDER_ERROR',
  'UNIDENTIFIED_FUNDS',
  'BENEFICIARY_BANK_RETURN',
  'PROCESSING_DELAY',
  'UNAUTHORISED_OR_NON_CUSTOMER_DEBIT',
  'STATUS_NOT_UPDATED',
  'MISSING_TRAVEL_RULE_DATA',
  'MISSING_STATEMENT',
  'MISSING_BANK_LEG',
  'UNKNOWN',
] as const;

export const ACTIONS = ['CHASE_BANK', 'REFUND_USER', 'REPAY_ONCHAIN', 'TOP_UP_SAFEGUARDING', 'CONTACT_PARTNER_ANCHOR', 'REQUEST_TRAVEL_RULE_DATA', 'REVIEW_WRITE_OFF', 'NONE'] as const;

export const EXPLANATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['exceptionId', 'type', 'summary', 'likelyCause', 'suggestedAction', 'evidenceIds'],
  properties: {
    exceptionId: { type: 'string' },
    type: { type: 'string' },
    summary: { type: 'string', maxLength: 400 },
    likelyCause: { type: 'string', enum: [...LIKELY_CAUSES] },
    suggestedAction: { type: 'string', enum: [...ACTIONS] },
    evidenceIds: { type: 'array', items: { type: 'string' } },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const vProposals = ajv.compile(PROPOSALS_SCHEMA);
const vExplanation = ajv.compile(EXPLANATION_SCHEMA);

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function run<T>(v: ReturnType<typeof ajv.compile>, x: unknown): Validation<T> {
  if (v(x)) return { ok: true, value: x as T };
  return { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`) };
}

export const validateProposals = <T>(x: unknown) => run<T>(vProposals, x);
export const validateExplanation = <T>(x: unknown) => run<T>(vExplanation, x);
