// Exception type codes and resolution codes (see docs/EXCEPTION-TYPES.md).

import type { ExceptionType, Resolution } from '../types.js';

export const EXCEPTION_TYPES: ExceptionType[] = [
  'PLATFORM_NO_CHAIN_LEG',
  'PLATFORM_NO_BANK_LEG',
  'DUPLICATE_CHAIN_PAYMENT',
  'DUPLICATE_PAYOUT',
  'SHORT_PAYOUT',
  'AMOUNT_MISMATCH',
  'WRONG_MEMO',
  'UNMATCHED_CHAIN_IN',
  'UNMATCHED_CHAIN_OUT',
  'UNMATCHED_BANK_CREDIT',
  'UNMATCHED_BANK_DEBIT',
  'STATUS_MISMATCH',
  'REVERSAL_OPEN',
  'STALE_PENDING',
  'NON_CUSTOMER_DEBIT_FROM_SAFEGUARDING',
  'STATEMENT_MISSING',
  'TRAVEL_RULE_MISSING',
];

export const RESOLUTIONS: Resolution[] = [
  'CHASED_BANK',
  'REFUNDED_USER',
  'REPAID_ONCHAIN',
  'TOPPED_UP',
  'PARTNER_CONFIRMED',
  'TR_DATA_RECEIVED',
  'WRITTEN_OFF_APPROVED',
  'FALSE_POSITIVE',
];

export function isResolution(x: string): x is Resolution {
  return (RESOLUTIONS as string[]).includes(x);
}
