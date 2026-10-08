// Name tokens are replaced per run by stable pseudonyms after normalisation:
// equal tokens stay equal, spelling similarity is lost. This is why the LLM
// adds little on name matching unless the anchor has a data-processing
// agreement and sets LLM_PERSONAL_DATA_ALLOWED=true.

import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../core/hash.js';

export class Pseudonymiser {
  private readonly salt: string;
  constructor(salt?: string) {
    this.salt = salt ?? randomBytes(16).toString('hex');
  }
  token = (t: string): string => `N${sha256Hex(this.salt + '|' + t.toUpperCase()).slice(0, 8).toUpperCase()}`;
  /** Replaces every occurrence of the given name tokens in free text. */
  text(s: string, tokens: string[]): string {
    let out = s;
    for (const t of [...new Set(tokens)].sort((a, b) => b.length - a.length)) {
      if (t.length < 2) continue;
      out = out.replace(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), this.token(t));
    }
    return out;
  }
}

export function personalDataAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLM_PERSONAL_DATA_ALLOWED === 'true';
}
