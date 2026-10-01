import { writeFileSync } from 'node:fs';
import path from 'node:path';

const ORDER = ['fixed', 'unresolved', 'needs-triage', 'below-threshold', 'unproven', 'dismissed', 'open'];

/** Tally findings by outcome from state. */
export function scoreboard(state) {
  const findings = Object.values(state.data).filter((e) => e.kind === 'finding');
  const by = {};
  for (const f of findings) by[f.outcome] = (by[f.outcome] ?? 0) + 1;
  return { total: findings.length, by, findings };
}

/** One-line-per-outcome console summary. */
export function printScoreboard(state, log = console.log) {
  const { total, by } = scoreboard(state);
  log(`Findings: ${total}`);
  for (const k of ORDER) if (by[k]) log(`  ${k.padEnd(16)} ${by[k]}`);
}

/** Write a markdown report of the run next to the transcript. */
export function writeReport(dir, repo, run, state) {
  const { findings } = scoreboard(state);
  const rows = findings.filter((f) => f.repo ? f.repo === repo.name : true)
    .sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome))
    .map((f) => `| ${f.outcome} | ${f.severity ?? '-'} | ${f.cwe ?? '-'} | ${f.title ?? ''} | ${f.location ?? ''} | ${f.mrUrl || f.branch || '-'} |`)
    .join('\n');
  const md = `# Hacker vs Developer — ${repo.name}

- Verdict: **${run.verdict}**${run.ready ? ' 🏁' : ''}
- Passes: ${run.passes}
- Open (unresolved / needs-triage): ${run.open}
- Generated: ${new Date().toISOString()}

| Outcome | Severity | CWE | Title | Location | Fix |
|---|---|---|---|---|---|
${rows || '| _no findings_ | | | | | |'}

The full dialogue is in \`conversation.log\`; structured events in \`transcript.jsonl\`.
`;
  const file = path.join(dir, 'report.md');
  writeFileSync(file, md);
  return file;
}
