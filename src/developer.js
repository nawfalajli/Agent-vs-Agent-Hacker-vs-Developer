/**
 * Fix prompt. The Developer makes the Hacker's failing regression test pass by changing the
 * application code — never the test. The service holds `testDir` read-only (it reverts any edit
 * the Developer makes there), and re-runs the suite itself before accepting the fix.
 */
export function buildFixPrompt(repo, finding, proofPath, testDir) {
  return `You are a developer securing THIS repository ("${repo.name}"). A security regression test was added that currently FAILS, proving a real weakness:

Finding: ${finding.title} (${finding.cwe}, ${finding.severity})
Location: ${finding.location}
Why: ${finding.summary}
Failing test: ${proofPath || `(under ${testDir}/)`}

Your job:
1. Read the failing test and the code around ${finding.location} to understand the flaw.
2. Fix the APPLICATION CODE so the behaviour is secure. Follow the project's existing conventions and keep the change minimal and correct.
3. Do NOT edit, weaken, delete or skip any test — especially anything under "${testDir}/". The service reverts test changes and re-runs the suite, so tampering only wastes the round.
4. Make sure you do not break existing behaviour: the WHOLE test suite must pass, not just the new test.
5. Do not commit, push or switch branches. The service commits and (if configured) opens a merge request for human review.

If the finding is a false positive or cannot be fixed safely without more information, make no changes and reply with a first line starting "BLOCKED:" followed by the reason.
Otherwise end with a short summary: the root cause, what you changed (files), and why it is now safe. It goes into the conversation log.`;
}
