import { run } from './proc.js';

/**
 * Run the repository's own test command, the service's independent check of the agents' work.
 * Returns ok (exit 0, not timed out) and a trimmed tail of the output for the transcript.
 */
export async function runSuite(command, cwd, timeoutMs) {
  if (!command) return { ok: true, tail: '(no test command configured)' };
  const res = await run(command, [], { cwd, timeoutMs, shell: true });
  const tail = `${res.stdout}\n${res.stderr}`.trim().slice(-3000);
  return { ok: res.code === 0 && !res.timedOut, tail: res.timedOut ? `timed out\n${tail}` : tail };
}

/**
 * Proof gate (V1): with the Hacker's regression test added, the suite must FAIL on unmodified
 * code. A failing suite proves the weakness is real; a passing suite means nothing was proven.
 */
export async function proofFails(command, cwd, timeoutMs) {
  const res = await runSuite(command, cwd, timeoutMs);
  return { proven: !res.ok, tail: res.tail };
}

/**
 * Fix gate (V2): after the Developer's change, the full suite (the regression test included)
 * must PASS.
 */
export async function fixPasses(command, cwd, timeoutMs) {
  const res = await runSuite(command, cwd, timeoutMs);
  return { passed: res.ok, tail: res.tail };
}
