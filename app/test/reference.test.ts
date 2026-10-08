import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CROCKFORD, correctRef, damerauLevenshtein, findRefPrefix, findRefs, luhn32, makeBankRef, parseRef } from '../src/core/reference.js';

test('reference: AR- token generation is deterministic and check-digit valid', () => {
  const r = makeBankRef('tx-1');
  assert.match(r, /^AR-[0-9A-HJKMNP-TV-Z]{8}-[0-9A-HJKMNP-TV-Z]$/);
  assert.equal(r, makeBankRef('tx-1'));
  assert.notEqual(r, makeBankRef('tx-2'));
  assert.equal(parseRef(r)!.valid, true);
  for (let i = 0; i < 200; i++) assert.equal(parseRef(makeBankRef(`id-${i}`))!.valid, true);
});

test('reference: vectors for the Luhn mod 32 check character', () => {
  assert.equal(luhn32('00000000'), '0');
  assert.equal(luhn32('00000001'), 'Y');
  assert.equal(luhn32('ZZZZZZZZ'), luhn32('ZZZZZZZZ'));
  assert.throws(() => luhn32('0000000U'), /Crockford/);
});

test('reference: every single-character substitution is detected', () => {
  const r = makeBankRef('tx-subst');
  const body = r.slice(3, 11);
  let n = 0;
  for (let i = 0; i < 8; i++) {
    for (const c of CROCKFORD) {
      if (c === body[i]) continue;
      const t = `AR-${body.slice(0, i)}${c}${body.slice(i + 1)}-${r[12]}`;
      assert.equal(parseRef(t)!.valid, false, t);
      n++;
    }
  }
  assert.equal(n, 8 * 31);
});

test('reference: most adjacent transpositions are detected', () => {
  let detected = 0;
  let total = 0;
  for (let k = 0; k < 100; k++) {
    const r = makeBankRef(`tx-t-${k}`);
    const b = r.slice(3, 11);
    for (let i = 0; i < 7; i++) {
      if (b[i] === b[i + 1]) continue;
      total++;
      const t = `AR-${b.slice(0, i)}${b[i + 1]}${b[i]}${b.slice(i + 2)}-${r[12]}`;
      if (!parseRef(t)!.valid) detected++;
    }
  }
  assert.ok(detected / total > 0.9, `${detected}/${total}`);
});

test('reference: parsing tolerates missing dashes, spaces, lowercase and Crockford aliases', () => {
  const r = makeBankRef('tx-parse');
  assert.equal(parseRef(r.replace(/-/g, ''))!.canonical, r);
  assert.equal(parseRef(r.replace(/-/g, ' ').toLowerCase())!.canonical, r);
  const withAlias = r.replace(/0/g, 'O').replace(/1/g, 'I');
  assert.equal(parseRef(withAlias)!.canonical, r);
  assert.equal(parseRef('AR-123'), undefined);
});

test('reference: 1-edit detection and correction against open references', () => {
  const r = makeBankRef('tx-correct');
  const b = r.slice(3, 11);
  const typo = parseRef(`AR-${b[1]}${b[0]}${b.slice(2)}-${r[12]}`)!;
  if (b[0] !== b[1]) {
    assert.equal(typo.valid, false);
    assert.deepEqual(correctRef(typo, [r, makeBankRef('other-1'), makeBankRef('other-2')]), [r]);
  }
  const sub = parseRef(`AR-${b.slice(0, 7)}${b[7] === 'Z' ? 'Y' : 'Z'}-${r[12]}`)!;
  assert.deepEqual(correctRef(sub, [r]), [r]);
  assert.deepEqual(correctRef(parseRef(r)!, [r]), [], 'valid tokens are not corrected');
  assert.equal(damerauLevenshtein('ABCD', 'BACD'), 1);
  assert.equal(damerauLevenshtein('ABCD', 'ABD'), 1);
  assert.equal(damerauLevenshtein('', 'AB'), 2);
});

test('reference: tokens in narratives, not inside longer words; truncated prefixes', () => {
  const r = makeBankRef('tx-find');
  assert.deepEqual(findRefs(`SEPA CT ${r} MARIA`).map((x) => x.canonical), [r]);
  assert.equal(findRefs(`BAR${r.slice(2)}`).length, 0, 'no match inside a word');
  assert.equal(findRefPrefix(`PAYOUT MARIA JOSEFA ${r.slice(0, 7)}`), r.slice(0, 7));
  assert.equal(findRefPrefix(`PAYOUT ${r}`), undefined, 'complete token is not a prefix');
  assert.equal(findRefPrefix('PAYOUT MARIA'), undefined);
});
