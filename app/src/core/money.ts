// Integer money. Every amount is a bigint in the minor units of its asset:
// EUR cents (2 dp), EURC / USDC on Stellar (7 dp). No floats anywhere.

export const DECIMALS: Record<string, number> = { EUR: 2, EURC: 7, USDC: 7, XLM: 7 };

export function decimalsOf(asset: string): number {
  const code = assetCode(asset);
  const d = DECIMALS[code];
  if (d === undefined) throw new Error(`unknown asset decimals for "${asset}"`);
  return d;
}

/** "iso4217:EUR" | "stellar:EURC:G..." | "EURC" -> "EUR" | "EURC". */
export function assetCode(asset: string): string {
  if (asset.startsWith('iso4217:')) return asset.slice(8);
  if (asset.startsWith('stellar:')) return asset.split(':')[1];
  if (asset.includes(':')) return asset.split(':')[0];
  return asset;
}

/** "1234.5" | "1.234,50" (comma decimal) -> minor units. Rejects excess precision. */
export function parseMoney(text: string, decimals: number, decimalSep: '.' | ',' = '.'): bigint {
  let t = String(text).trim().replace(/\s/g, '');
  if (decimalSep === ',') t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new Error(`invalid amount "${text}"`);
  const [, neg, whole, frac = ''] = m;
  const f = frac.replace(/0+$/, '');
  if (f.length > decimals) throw new Error(`amount "${text}" has more than ${decimals} decimals`);
  const v = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return neg ? -v : v;
}

export function formatMoney(units: bigint, decimals: number, minFrac = Math.min(decimals, 2)): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = u / base;
  let frac = (u % base).toString().padStart(decimals, '0');
  while (frac.length > minFrac && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${neg ? '-' : ''}${whole}${frac.length ? '.' + frac : ''}`;
}

/** Converts between scales; throws if precision would be lost. */
export function rescale(units: bigint, from: number, to: number): bigint {
  if (to >= from) return units * 10n ** BigInt(to - from);
  const f = 10n ** BigInt(from - to);
  if (units % f !== 0n) throw new Error(`cannot rescale ${units} from ${from} to ${to} dp without loss`);
  return units / f;
}

/** Rescale rounding half away from zero (used only for FX display, never for matching keys). */
export function rescaleRound(units: bigint, from: number, to: number): bigint {
  if (to >= from) return units * 10n ** BigInt(to - from);
  const f = 10n ** BigInt(from - to);
  const q = units / f;
  const r = units % f;
  const half = f / 2n;
  if (r >= half) return q + 1n;
  if (r <= -half) return q - 1n;
  return q;
}

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);
export const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/** |delta| in basis points of base, integer (floored). */
export function bps(delta: bigint, base: bigint): bigint {
  if (base === 0n) return delta === 0n ? 0n : 1_000_000n;
  return (abs(delta) * 10_000n) / abs(base);
}
