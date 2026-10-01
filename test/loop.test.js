import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { State } from '../src/state.js';
import { Transcript } from '../src/transcript.js';
import { harden, notifyText } from '../src/loop.js';

const repo = { name: 'app', path: '/clone/app', test: 'npm test' };

function baseCfg() {
  return {
    testDir: '__hvd__',
    claude: { bin: 'claude', hacker: { provider: 'anthropic' }, developer: { provider: 'anthropic' }, reconTools: [], proofTools: [], devTools: [], hackerTimeoutMs: 1, devTimeoutMs: 1 },
    git: { remote: 'origin', targetBranch: 'dev', branchPrefix: 'hvd/', push: true, mrLabels: ['security'] },
    jev: { apiKey: '', minConfidence: 0.7 },
    loop: { severityMin: 'medium', cleanPasses: 1, maxRounds: 3, maxTotalRounds: 5, maxFindingsPerPass: 5, scope: [] },
    testTimeoutMs: 1,
  };
}

// Scripted runClaude keyed on the prompt. `reconReplies` is consumed one per recon call.
function makeDeps(reconReplies, { fixText = 'Fixed by adding an ownership check.', bypass = false, proofPasses = false } = {}) {
  const calls = { recon: 0, proof: 0, fix: 0, rematch: 0, commits: 0 };
  const runClaude = async (_opts, _cwd, prompt) => {
    if (prompt.includes('senior application-security reviewer')) return { ok: true, text: reconReplies[calls.recon++] ?? '[]' };
    if (prompt.includes('write ONE automated regression test')) { calls.proof++; return { ok: true, text: 'PROOF: __hvd__/poc.test.js' }; }
    if (prompt.includes('You are a developer securing')) { calls.fix++; return { ok: true, text: fixText }; }
    if (prompt.includes('look for a BYPASS')) { calls.rematch++; return { ok: true, text: JSON.stringify({ bypass, reason: bypass ? 'sibling path' : 'all variants blocked', proof_idea: 'x' }) }; }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 40)}`);
  };
  const git = {
    startBranch: async () => {},
    hasChanges: async () => true,
    changedOutside: async () => true,
    keepOnlyProof: async () => {},
    restoreProof: async () => {},
    commitRound: async () => { calls.commits++; return { sha: 'abc1234', mrUrl: 'https://gl/-/merge_requests/1', pushed: true }; },
    cleanup: async () => {},
  };
  const verify = {
    proofFails: async () => ({ proven: true, tail: '' }),
    fixPasses: async () => ({ passed: true, tail: '' }),
  };
  return { deps: { runClaude, git, verify, judge: null }, calls };
}

function harness(cfg) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hvd-loop-'));
  const state = new State(path.join(dir, 'state.json'));
  const tx = new Transcript(dir, { repo: repo.name });
  tx.quiet = true;
  const events = [];
  const orig = tx.say.bind(tx);
  tx.say = (actor, kind, text, fields) => { events.push({ actor, kind, text, fields }); orig(actor, kind, text, fields); };
  const sent = [];
  const notify = async (event, text) => sent.push({ event, text });
  return { dir, state, tx, events, sent, notify, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const oneFinding = JSON.stringify([{ title: 'IDOR on orders', cwe: 'CWE-639', severity: 'high', location: 'src/orders.js:42', summary: 'no ownership check', proof_idea: 'as A read B order' }]);

test('a proven finding is fixed, pushed, and notified; a clean pass reaches production-ready', async () => {
  const cfg = baseCfg();
  const { deps, calls } = makeDeps([oneFinding, '[]']); // pass1 finds one, pass2 clean
  const h = harness(cfg);
  const run = await harden(repo, { cfg, deps, tx: h.tx, state: h.state, notify: h.notify });

  assert.equal(run.ready, true);
  assert.equal(run.verdict, 'production-ready');
  assert.equal(calls.commits, 1, 'one fix committed');
  const fixed = Object.values(h.state.data).find((e) => e.kind === 'finding' && e.outcome === 'fixed');
  assert.ok(fixed, 'finding recorded as fixed');
  assert.ok(h.sent.some((m) => m.event === 'fixed'), 'fix notification sent');
  assert.ok(h.sent.some((m) => m.event === 'ready'), 'ready notification sent');
  // the conversation carried challenge -> proof -> fix -> round-result
  const kinds = h.events.map((e) => e.kind);
  for (const k of ['challenge', 'proof', 'fix', 'round-result']) assert.ok(kinds.includes(k), `transcript has ${k}`);
  h.cleanup();
});

test('an unprovable challenge (test passes on current code) is dropped, never fixed', async () => {
  const cfg = baseCfg();
  const { deps, calls } = makeDeps([oneFinding, '[]']);
  deps.verify.proofFails = async () => ({ proven: false, tail: '' }); // test does NOT fail -> bluff
  const h = harness(cfg);
  const run = await harden(repo, { cfg, deps, tx: h.tx, state: h.state, notify: h.notify });
  assert.equal(calls.commits, 0, 'nothing committed for a bluff');
  assert.equal(h.state.data[Object.keys(h.state.data)[0]].outcome, 'unproven');
  assert.equal(run.ready, true); // no actionable fix, so it still converges
  h.cleanup();
});

test('a fix that never passes ends unresolved and blocks production-ready', async () => {
  const cfg = baseCfg();
  const { deps } = makeDeps([oneFinding, '[]', '[]']);
  deps.verify.fixPasses = async () => ({ passed: false, tail: 'still red' });
  const h = harness(cfg);
  const run = await harden(repo, { cfg, deps, tx: h.tx, state: h.state, notify: h.notify });
  const unresolved = Object.values(h.state.data).find((e) => e.outcome === 'unresolved');
  assert.ok(unresolved, 'recorded unresolved');
  assert.equal(run.ready, false);
  assert.equal(run.verdict, 'ceiling-reached');
  assert.ok(h.sent.some((m) => m.event === 'unresolved'));
  h.cleanup();
});

test('a found bypass is opened as a follow-up finding', async () => {
  const cfg = baseCfg();
  const { deps } = makeDeps([oneFinding, '[]'], { bypass: true });
  const h = harness(cfg);
  await harden(repo, { cfg, deps, tx: h.tx, state: h.state, notify: h.notify });
  const variant = Object.values(h.state.data).find((e) => e.title?.includes('(bypass)'));
  assert.ok(variant, 'bypass recorded as a new finding');
  h.cleanup();
});

test('below-threshold findings are logged, not fixed', async () => {
  const cfg = baseCfg();
  cfg.loop.severityMin = 'critical';
  const { deps, calls } = makeDeps([oneFinding, '[]']);
  const h = harness(cfg);
  await harden(repo, { cfg, deps, tx: h.tx, state: h.state, notify: h.notify });
  assert.equal(calls.commits, 0, 'high finding below critical bar is not fixed');
  assert.equal(Object.values(h.state.data)[0].outcome, 'below-threshold');
  h.cleanup();
});

test('notifyText formats the outcome line', () => {
  assert.match(notifyText('fixed', repo, 'detail'), /FIXED · app/);
  assert.match(notifyText('ready', repo, 'done'), /🏁|READY/);
});
