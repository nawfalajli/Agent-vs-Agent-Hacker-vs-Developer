import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFindings, parseRematch, findingId, severityRank, buildReconPrompt, buildProofPrompt,
} from '../src/hacker.js';

test('parseFindings reads a clean array and assigns stable ids', () => {
  const text = `here you go:
[{"title":"IDOR on orders","cwe":"CWE-639","severity":"high","location":"src/orders.js:42","summary":"no ownership check","proof_idea":"as A read B order expect 403"}]`;
  const [f] = parseFindings(text);
  assert.equal(f.title, 'IDOR on orders');
  assert.equal(f.cwe, 'CWE-639');
  assert.equal(f.severity, 'high');
  assert.equal(f.id, findingId(f));
  assert.equal(f.id.length, 12);
});

test('parseFindings drops malformed entries and normalises severity', () => {
  const text = `[{"title":"ok","location":"a.js:1","severity":"nonsense"},{"title":"","location":"b.js:2"},{"cwe":"x"}]`;
  const out = parseFindings(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'medium'); // unknown severity -> medium
});

test('parseFindings returns [] for non-JSON or empty', () => {
  assert.deepEqual(parseFindings('nothing here'), []);
  assert.deepEqual(parseFindings('[]'), []);
});

test('findingId is stable across severity/summary changes but not location', () => {
  const base = { cwe: 'CWE-89', location: 'db.js:10', title: 'SQLi' };
  assert.equal(findingId({ ...base, severity: 'high' }), findingId({ ...base, severity: 'low' }));
  assert.notEqual(findingId(base), findingId({ ...base, location: 'db.js:11' }));
});

test('severityRank orders low<medium<high<critical', () => {
  assert.ok(severityRank('low') < severityRank('medium'));
  assert.ok(severityRank('medium') < severityRank('high'));
  assert.ok(severityRank('high') < severityRank('critical'));
  assert.equal(severityRank('bogus'), 0);
});

test('parseRematch defaults to no-bypass on bad JSON', () => {
  assert.equal(parseRematch('garbage').bypass, false);
  assert.equal(parseRematch('{"bypass":true,"reason":"array id","proof_idea":"x"}').bypass, true);
});

test('recon prompt lists known findings to avoid and respects scope', () => {
  const p = buildReconPrompt({ name: 'api' }, { scope: ['src/**'], known: [{ cwe: 'CWE-1', location: 'a.js:1', title: 'old' }], max: 3 });
  assert.match(p, /do NOT report these again/);
  assert.match(p, /src\/\*\*/);
  assert.match(p, /at most 3 findings/);
});

test('proof prompt confines writes to the test dir', () => {
  const p = buildProofPrompt({ name: 'api' }, { title: 't', cwe: 'CWE-1', severity: 'high', location: 'a.js:1', summary: 's', proofIdea: 'i' }, '__hvd__');
  assert.match(p, /ONLY inside the "__hvd__\/" directory/);
  assert.match(p, /FAILS against the current/);
});
