import {
  buildReconPrompt, parseFindings, buildProofPrompt, buildRematchPrompt, parseRematch,
  severityRank, findingId,
} from './hacker.js';
import { buildFixPrompt } from './developer.js';
import { jevReferee, applyReferee } from './jev.js';

const branchFor = (prefix, finding) => {
  const slug = finding.title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
  return `${prefix}${finding.id}${slug ? `-${slug}` : ''}`;
};

const PROOF_RE = /^PROOF:\s*(.+)$/im;

/** WhatsApp text for an outcome. */
export function notifyText(outcome, repo, detail = '') {
  const icon = { fixed: '✅', unresolved: '⚠️', ready: '🏁' }[outcome] ?? 'ℹ️';
  return [`${icon} Hacker vs Developer: ${outcome.toUpperCase()} · ${repo.name}`, detail.trim()].filter(Boolean).join('\n\n');
}

/**
 * One finding, end to end: prove it (test must fail), fix it (suite must pass), rematch (bypass
 * reopens). Returns the outcome. `deps` = { runClaude, git, verify, judge } (injected for tests).
 */
async function handleFinding(finding, { cfg, repo, branch, deps, tx, state, notify }) {
  const { git, verify } = deps;

  // Prove: the Hacker writes a regression test under testDir; everything else is reverted.
  const proof = await deps.runClaude(
    { bin: cfg.claude.bin, ...cfg.claude.hacker, tools: cfg.claude.proofTools, timeoutMs: cfg.claude.hackerTimeoutMs },
    repo.path, buildProofPrompt(repo, finding, cfg.testDir),
  );
  if (!proof.ok) throw new Error(`Hacker proof step failed: ${proof.text}`);
  if (/^CANNOT:/im.test(proof.text)) {
    tx.say('hacker', 'proof-result', `No failing test could be written: ${proof.text}`, finding);
    return 'dismissed';
  }
  await git.keepOnlyProof(repo.path, cfg.testDir);
  if (!(await git.hasChanges(repo.path))) {
    tx.say('hacker', 'proof-result', 'Proof step produced no test file under the test dir — dropped.', finding);
    return 'dismissed';
  }
  const proofPath = proof.text.match(PROOF_RE)?.[1]?.trim() ?? `(under ${cfg.testDir}/)`;
  tx.say('hacker', 'proof', `${finding.summary}\nProof → ${proofPath}`, finding);

  // Gate V1: the proof must FAIL on current code.
  const v1 = await verify.proofFails(repo.test, repo.path, cfg.testTimeoutMs);
  if (!v1.proven) {
    tx.say('referee', 'proof-result', 'Test PASSES on current code → nothing proven. Dropped as a bluff.', finding);
    return 'unproven';
  }
  tx.say('referee', 'proof-result', 'Test FAILS on current code. Challenge stands.', finding);

  // Fix, up to maxRounds attempts.
  let fixSummary = '';
  for (let attempt = 1; attempt <= cfg.loop.maxRounds; attempt++) {
    const fix = await deps.runClaude(
      { bin: cfg.claude.bin, ...cfg.claude.developer, tools: cfg.claude.devTools, timeoutMs: cfg.claude.devTimeoutMs },
      repo.path, buildFixPrompt(repo, finding, proofPath, cfg.testDir),
    );
    if (!fix.ok) throw new Error(`Developer step failed: ${fix.text}`);
    await git.restoreProof(repo.path, cfg.testDir); // the proof is read-only to the Developer

    if (/^BLOCKED:/im.test(fix.text)) {
      tx.say('developer', 'fix', fix.text, finding);
      if (attempt >= cfg.loop.maxRounds) return 'unresolved';
      continue;
    }
    if (!(await git.changedOutside(repo.path, cfg.testDir))) {
      tx.say('developer', 'fix', `No application code changed (attempt ${attempt}).`, finding);
      if (attempt >= cfg.loop.maxRounds) return 'unresolved';
      continue;
    }
    fixSummary = fix.text;
    tx.say('developer', 'fix', fix.text, finding);

    // Gate V2: the whole suite (proof included) must PASS.
    const v2 = await verify.fixPasses(repo.test, repo.path, cfg.testTimeoutMs);
    if (v2.passed) { tx.say('referee', 'test-result', 'Regression test PASSES. Full suite PASSES.', finding); break; }
    tx.say('referee', 'test-result', `Suite still red (attempt ${attempt}/${cfg.loop.maxRounds}).\n${v2.tail.slice(-500)}`, finding);
    if (attempt >= cfg.loop.maxRounds) return 'unresolved';
  }

  // Rematch: one read-only attempt to bypass the fix.
  const rematch = await deps.runClaude(
    { bin: cfg.claude.bin, ...cfg.claude.hacker, tools: cfg.claude.reconTools, timeoutMs: cfg.claude.hackerTimeoutMs },
    repo.path, buildRematchPrompt(repo, finding, fixSummary, cfg.testDir),
  );
  const rm = rematch.ok ? parseRematch(rematch.text) : { bypass: false, reason: 'rematch unavailable' };
  if (rm.bypass) {
    // The bypass is a new, related finding for a later round.
    const variant = { ...finding, id: findingId({ ...finding, title: `${finding.title} (bypass)` }), title: `${finding.title} (bypass)`, summary: rm.reason, proofIdea: rm.proofIdea || finding.proofIdea };
    state.set(variant.id, { kind: 'finding', outcome: 'open', ...variant });
    tx.say('hacker', 'rematch', `Bypass found: ${rm.reason}. Opened as a follow-up finding.`, finding);
  } else {
    tx.say('hacker', 'rematch', `Tried to bypass the fix — ${rm.reason}. Holds.`, finding);
  }

  // Commit the round (fix + proof), push + MR if configured.
  const title = `[security] ${finding.title} (${finding.cwe})`;
  const msg = `[security] fix ${finding.cwe}: ${finding.title}\n\n${finding.summary}\n\nFinding ${finding.id}, proven by a regression test under ${cfg.testDir}/.\nHardened by hacker-vs-developer.`;
  const { sha, mrUrl, pushed } = await git.commitRound(repo.path, cfg.git, branch, msg, title);
  const link = mrUrl || (pushed ? '(see remote)' : '(local branch only)');
  tx.say('referee', 'round-result', `FIXED · ${branch} (${sha})${pushed ? ` · MR ${link}` : ` · ${link}`}`, finding);
  await notify('fixed', notifyText('fixed', repo,
    `[${finding.cwe}] ${finding.title} (${finding.severity})\nBranch ${branch} (${sha})\n${pushed ? `MR: ${link}` : 'Local branch only'}`));
  state.set(finding.id, { kind: 'finding', outcome: 'fixed', ...finding, branch, sha, mrUrl, costUsd: proof.costUsd });
  return 'fixed';
}

/** One pass: recon → (referee) → per-finding rounds. Returns findings acted on at/above the bar. */
async function runPass(passNo, { cfg, repo, deps, tx, state, notify }) {
  const known = Object.values(state.data).filter((e) => e.kind === 'finding')
    .map((e) => ({ cwe: e.cwe, location: e.location, title: e.title }));
  const recon = await deps.runClaude(
    { bin: cfg.claude.bin, ...cfg.claude.hacker, tools: cfg.claude.reconTools, timeoutMs: cfg.claude.hackerTimeoutMs },
    repo.path, buildReconPrompt(repo, { scope: cfg.loop.scope, known, max: cfg.loop.maxFindingsPerPass }),
  );
  if (!recon.ok) throw new Error(`Hacker recon failed: ${recon.text}`);
  let findings = parseFindings(recon.text)
    .filter((f) => !state.get(f.id) || state.get(f.id).outcome === 'open')
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, cfg.loop.maxFindingsPerPass);

  if (!findings.length) { tx.say('hacker', 'challenge', 'No new provable weaknesses found this pass.'); return { actionable: 0 }; }

  const minRank = severityRank(cfg.loop.severityMin);
  let actionable = 0;
  for (const finding of findings) {
    tx.say('hacker', 'challenge', `${finding.summary}\n(${finding.location})`, finding);

    // Referee: Jev (optional) decides real / in-scope / dup / severity.
    let f = finding;
    if (deps.judge) {
      try {
        const verdict = await deps.judge({ repo, finding, known });
        const decided = applyReferee(finding, verdict, cfg.jev.minConfidence);
        tx.say('referee', 'verdict', `${verdict.jev ?? decided.jev} → ${decided.action}`, finding);
        if (decided.action !== 'accept') { state.set(finding.id, { kind: 'finding', outcome: decided.action, ...finding }); continue; }
        f = decided.finding;
      } catch (err) {
        tx.say('referee', 'verdict', `Jev unavailable, keeping the Hacker's call: ${err.message}`, finding);
      }
    }

    if (severityRank(f.severity) < minRank) {
      tx.say('referee', 'verdict', `Below SEVERITY_MIN (${cfg.loop.severityMin}); logged, not fixed.`, f);
      state.set(f.id, { kind: 'finding', outcome: 'below-threshold', ...f });
      continue;
    }

    actionable++;
    const branch = branchFor(cfg.git.branchPrefix, f);
    await deps.git.startBranch(repo.path, cfg.git, branch);
    try {
      const outcome = await handleFinding(f, { cfg, repo, branch, deps, tx, state, notify });
      if (outcome === 'unresolved') {
        state.set(f.id, { kind: 'finding', outcome: 'unresolved', ...f });
        await notify('unresolved', notifyText('unresolved', repo, `[${f.cwe}] ${f.title}: could not be fixed automatically after ${cfg.loop.maxRounds} attempt(s).`));
      } else if (!['fixed'].includes(outcome)) {
        state.set(f.id, { kind: 'finding', outcome, ...f });
      }
    } finally {
      await deps.git.cleanup(repo.path, cfg.git, branch).catch((e) => tx.say('referee', 'verdict', `cleanup failed: ${e.message}`));
    }
  }
  return { actionable };
}

/**
 * The outer loop: run passes until CLEAN_PASSES consecutive clean passes (nothing actionable),
 * or MAX_TOTAL_ROUNDS is hit. Returns a run summary.
 */
export async function harden(repo, { cfg, deps, tx, state, notify, maxPasses = Infinity }) {
  let clean = 0;
  let pass = 0;
  for (; pass < cfg.loop.maxTotalRounds && clean < cfg.loop.cleanPasses && pass < maxPasses; pass++) {
    tx.startRound(pass + 1);
    const { actionable } = await runPass(pass + 1, { cfg, repo, deps, tx, state, notify });
    clean = actionable === 0 ? clean + 1 : 0;
  }
  const open = Object.values(state.data).filter((e) => e.kind === 'finding' && ['unresolved', 'needs-triage'].includes(e.outcome));
  const ready = clean >= cfg.loop.cleanPasses && open.length === 0;
  const verdict = ready ? 'production-ready' : 'ceiling-reached';
  const summary = ready
    ? `${pass} pass(es), ${clean} clean in a row. No findings at or above ${cfg.loop.severityMin} remain.`
    : `Stopped after ${pass} pass(es). Open: ${open.map((o) => `${o.cwe} ${o.title}`).join('; ') || 'none'}.`;
  tx.close(verdict, summary);
  if (ready) await notify('ready', notifyText('ready', repo, summary));
  return { verdict, ready, passes: pass, open: open.length };
}
