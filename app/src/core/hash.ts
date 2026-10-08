// SHA-256 helpers and RFC 8785 (JCS) canonical JSON for the value shapes this
// tool produces: objects, arrays, strings, booleans, null and safe integers.
// Floats are rejected on purpose: amounts are strings of integer minor units.

import { createHash } from 'node:crypto';

export function sha256(...parts: (Uint8Array | string)[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return new Uint8Array(h.digest());
}

export const sha256Hex = (...parts: (Uint8Array | string)[]): string => toHex(sha256(...parts));

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) throw new Error(`invalid hex "${hex}"`);
  return new Uint8Array(Buffer.from(h, 'hex'));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function jcs(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error(`jcs: non-integer number ${value} not allowed`);
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`jcs: unsupported type ${typeof value}`);
  }
}

/** JSON.stringify replacer that writes bigints as strings. */
export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
