import { loadEnv, loadConfig } from './config.js';
import { State } from './state.js';
import { Transcript } from './transcript.js';
import { runClaude } from './agent.js';
import * as git from './git.js';
import * as verify from './verify.js';
import { createNotifier } from './notify.js';
import { jevReferee } from './jev.js';
import { harden } from './loop.js';
import { buildReconPrompt, parseFindings, severityRank } from './hacker.js';
import { printScoreboard, writeReport } from './report.js';
import { describeModel } from './providers.js';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(name);
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

loadEnv();
const cfg = loadConfig();

function pickRepo() {
  const name = arg('--repo') || cfg.defaultRepo;
  const repo = cfg.repos.find((r) => r.name === name);
  if (!repo) throw new Error(`--repo "${name}" is not in REPOS (${cfg.repos.map((r) => r.name).join(', ')})`);
  return repo;
}

async function cmdReport() {
  printScoreboard(new State(cfg.stateFile), log);
}

async function cmdDryRun(repo) {
  const recon = await runClaude(
    { bin: cfg.claude.bin, ...cfg.claude.hacker, tools: cfg.claude.reconTools, timeoutMs: cfg.claude.hackerTimeoutMs },
    repo.path, buildReconPrompt(repo, { scope: cfg.loop.scope, max: cfg.loop.maxFindingsPerPass }),
  );
  if (!recon.ok) throw new Error(`Hacker recon failed: ${recon.text}`);
  const findings = parseFindings(recon.text).sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  log(`[dry-run] ${findings.length} candidate finding(s) in ${repo.name}:`);
  for (const f of findings) log(`  ${f.severity.toUpperCase().padEnd(8)} ${f.cwe.padEnd(9)} ${f.location}  ${f.title}`);
}

async function cmdHarden(repo) {
  const state = new State(cfg.stateFile);
  const tx = new Transcript(cfg.reportDir, { repo: repo.name });
  const notify = createNotifier(cfg.whatsapp, (m) => log(m));
  const judge = cfg.jev.apiKey ? (input) => jevReferee(cfg.jev, input) : null;
  const deps = { runClaude, git, verify, judge };

  tx.open({
    hacker: describeModel(cfg.claude.hacker), developer: describeModel(cfg.claude.developer),
    jev: cfg.jev.apiKey ? cfg.jev.model : 'off', push: cfg.git.push ? `${cfg.git.remote}/${cfg.git.targetBranch}` : 'local only',
  });
  const maxPasses = arg('--rounds') ? Number(arg('--rounds')) : Infinity;
  const run = await harden(repo, { cfg, deps, tx, state, notify, maxPasses });
  const file = writeReport(cfg.reportDir, repo, run, state);
  log(`${run.verdict} · ${run.passes} pass(es) · ${run.open} open · report: ${file}`);
  printScoreboard(state, log);
  process.exit(run.ready ? 0 : 2);
}

const repo = () => {
  const r = pickRepo();
  log(`repo ${r.name} (${r.path}) · hacker ${describeModel(cfg.claude.hacker)} · developer ${describeModel(cfg.claude.developer)} · jev ${cfg.jev.apiKey ? cfg.jev.model : 'off'} · push ${cfg.git.push} · whatsapp ${cfg.whatsapp.provider || 'off'}`);
  return r;
};

const main = has('--report') ? cmdReport
  : has('--dry-run') ? () => cmdDryRun(repo())
  : () => cmdHarden(repo());

main().catch((err) => { console.error(err.message); process.exit(1); });
