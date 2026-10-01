import { createHash } from 'node:crypto';

export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const severityRank = (s) => Math.max(0, SEVERITIES.indexOf(String(s).toLowerCase()));

/** Stable id for a finding, so the same weakness is not re-hunted pass after pass. */
export function findingId(f) {
  return createHash('sha1').update(`${f.cwe}\n${f.location}\n${f.title}`).digest('hex').slice(0, 12);
}

const scopeLine = (scope) => (scope?.length ? `\nStay within these paths: ${scope.join(', ')}.` : '');

/**
 * Recon prompt. The Hacker reviews the code read-only and reports provable weaknesses as a JSON
 * array — a challenge is only worth raising if it can be demonstrated with an automated test.
 */
export function buildReconPrompt(repo, { scope = [], known = [], max = 5 } = {}) {
  const avoid = known.length
    ? `\nAlready handled (do NOT report these again):\n${known.map((k) => `- ${k.cwe} @ ${k.location}: ${k.title}`).join('\n')}`
    : '';
  return `You are a senior application-security reviewer auditing THIS repository ("${repo.name}"), which the operator owns and has authorised you to test. Work read-only: Read, Glob, Grep. Change nothing.

Find real, provable security weaknesses in the code: missing authorization/ownership checks, injection (SQL/command/path), unsafe deserialization, auth/session flaws, secrets committed in source, SSRF, unsafe redirects, missing output encoding, and similar. Only report a weakness you could demonstrate with an automated regression test against this codebase — not theoretical or dependency-advisory noise.${scopeLine(scope)}${avoid}

Report at most ${max} findings, most severe first. Reply with ONLY a JSON array, no other text:
[{"title":"<short>","cwe":"CWE-###","severity":"low|medium|high|critical","location":"<file:line>","summary":"<what is wrong and why it is exploitable, 1-2 sentences>","proof_idea":"<the regression test to write: the behaviour to drive and the result that proves the flaw, e.g. 'as user A, request B's order and assert 403 not that order'>"}]
If you find nothing provable, reply with exactly: []`;
}

/** Parse the recon JSON into clean findings, dropping malformed entries. */
export function parseFindings(text) {
  const json = text.match(/\[[\s\S]*\]/)?.[0];
  let arr;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map((f) => ({
    title: String(f.title ?? '').trim(),
    cwe: String(f.cwe ?? 'CWE-0').trim(),
    severity: SEVERITIES.includes(String(f.severity).toLowerCase()) ? String(f.severity).toLowerCase() : 'medium',
    location: String(f.location ?? '').trim(),
    summary: String(f.summary ?? '').trim(),
    proofIdea: String(f.proof_idea ?? f.proofIdea ?? '').trim(),
  })).filter((f) => f.title && f.location).map((f) => ({ id: findingId(f), ...f }));
}

/**
 * Proof prompt. The Hacker writes ONE regression test that fails on the current code. It may only
 * write under `testDir`; the service reverts anything else, so the proof can never alter app code.
 */
export function buildProofPrompt(repo, finding, testDir) {
  return `You proved the following weakness exists in THIS repository ("${repo.name}"). Now write ONE automated regression test that FAILS against the current (unfixed) code and will PASS once the weakness is fixed.

Finding: ${finding.title} (${finding.cwe}, ${finding.severity})
Location: ${finding.location}
Why: ${finding.summary}
Test to write: ${finding.proofIdea}

Rules:
- Create the test ONLY inside the "${testDir}/" directory, using this project's own test framework and conventions (look at the existing tests first). Name it so the project's test command discovers it.
- Do NOT modify any application code, configuration, or existing tests. Only add your new file(s) under "${testDir}/". The service discards any change outside "${testDir}/".
- The test must assert the SECURE behaviour, so it fails now (insecure) and passes after the fix. Do not write a test that merely documents the bug as "expected".
- Keep it deterministic and self-contained; no network calls to real hosts.

Reply with a single line: the path of the test file you created, prefixed with "PROOF:". If you cannot write a failing test for this finding, reply with a line starting "CANNOT:" and the reason.`;
}

/**
 * Rematch prompt. After a fix passes, the Hacker gets one read-only attempt to find a bypass
 * variant. A bypass reopens the round; otherwise the fix holds.
 */
export function buildRematchPrompt(repo, finding, fixSummary, testDir) {
  return `A fix was just applied in "${repo.name}" for: ${finding.title} (${finding.cwe}) at ${finding.location}.
Developer's summary of the fix:
${fixSummary || '(none)'}

Read-only (Read, Glob, Grep), look for a BYPASS: a variant of the same weakness the fix missed (another path, parameter, encoding, method, or sibling endpoint with the same flaw). Change nothing.

Reply with ONLY a JSON object:
{"bypass": true|false, "reason": "<one sentence>", "proof_idea": "<if bypass: the regression test that would demonstrate the variant>"}`;
}

export function parseRematch(text) {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  try {
    const d = JSON.parse(json);
    return { bypass: d.bypass === true, reason: String(d.reason ?? '').trim(), proofIdea: String(d.proof_idea ?? '').trim() };
  } catch {
    return { bypass: false, reason: 'rematch returned no valid JSON', proofIdea: '' };
  }
}
