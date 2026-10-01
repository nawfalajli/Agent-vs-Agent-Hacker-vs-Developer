import { existsSync } from 'node:fs';
import path from 'node:path';
import { PROVIDERS, resolveModel } from './providers.js';

export const ROOT = path.resolve(import.meta.dirname, '..');

const PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  ...new Set(Object.values(PROVIDERS).filter((p) => p.key).map((p) => p.key)),
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
];

// Hacker recon: read-only. Hacker proof: read-only + write (its test file only; the service
// reverts anything outside the test dir). Developer: edit code + run tests, no git writes.
export const RECON_TOOLS = 'Read,Glob,Grep';
export const PROOF_TOOLS = 'Read,Glob,Grep,Write,Edit';
export const DEFAULT_DEV_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npm run typecheck:*)',
  'Bash(npx tsc:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(pytest:*)', 'Bash(go test:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
].join(',');

export function loadEnv(file = path.join(ROOT, '.env')) {
  if (existsSync(file)) process.loadEnvFile(file);
  for (const key of PASSTHROUGH) if (process.env[key] === '') delete process.env[key];
}

const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v));

export function parseRepos(raw) {
  return raw.split(';').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [name, repoPath, test = ''] = entry.split('|').map((s) => s.trim());
    if (!name || !repoPath) throw new Error(`Invalid REPOS entry "${entry}" (expected name|path|test command)`);
    return { name, path: path.resolve(repoPath), test };
  });
}

const WHATSAPP_KEYS = {
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM'],
  meta: ['META_WHATSAPP_TOKEN', 'META_WHATSAPP_PHONE_ID'],
  callmebot: ['CALLMEBOT_API_KEY'],
};

function loadWhatsApp(env) {
  const provider = env.WHATSAPP_PROVIDER?.trim().toLowerCase() || '';
  if (!provider) return { provider: '' };
  if (!WHATSAPP_KEYS[provider]) throw new Error(`WHATSAPP_PROVIDER must be one of: ${Object.keys(WHATSAPP_KEYS).join(', ')}`);
  const missing = ['WHATSAPP_TO', ...WHATSAPP_KEYS[provider]].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`WhatsApp (${provider}) needs in .env: ${missing.join(', ')}`);
  return {
    provider,
    to: env.WHATSAPP_TO.trim(),
    events: list(env.WHATSAPP_EVENTS || 'fixed,unresolved,ready'),
    twilioSid: env.TWILIO_ACCOUNT_SID?.trim(),
    twilioToken: env.TWILIO_AUTH_TOKEN?.trim(),
    from: env.TWILIO_WHATSAPP_FROM?.trim(),
    metaToken: env.META_WHATSAPP_TOKEN?.trim(),
    metaPhoneId: env.META_WHATSAPP_PHONE_ID?.trim(),
    callmebotKey: env.CALLMEBOT_API_KEY?.trim(),
  };
}

export function loadConfig(env = process.env) {
  const missing = ['REPOS'].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')}`);

  const repos = parseRepos(env.REPOS);
  const defaultRepo = env.DEFAULT_REPO || repos[0].name;
  if (!repos.some((r) => r.name === defaultRepo)) throw new Error(`DEFAULT_REPO "${defaultRepo}" is not in REPOS`);

  const provider = env.LLM_PROVIDER || 'anthropic';
  const baseModel = env.LLM_MODEL || '';
  const hacker = resolveModel(env, provider, env.HACKER_MODEL || baseModel);
  const developer = resolveModel(env, provider, env.DEVELOPER_MODEL || baseModel);

  return {
    repos,
    defaultRepo,
    git: {
      remote: env.GIT_REMOTE || 'origin',
      targetBranch: env.GIT_TARGET_BRANCH || 'dev',
      branchPrefix: env.GIT_BRANCH_PREFIX || 'hvd/',
      push: bool(env.GIT_PUSH, true),
      mrLabels: list(env.MR_LABELS || 'security'),
    },
    testDir: (env.HVD_TEST_DIR || '__hvd__').replace(/\/+$/, ''),
    claude: {
      bin: env.CLAUDE_BIN || 'claude',
      hacker,
      developer,
      reconTools: list(RECON_TOOLS),
      proofTools: list(PROOF_TOOLS),
      devTools: list(env.CLAUDE_ALLOWED_TOOLS || DEFAULT_DEV_TOOLS),
      hackerTimeoutMs: num(env.HACKER_TIMEOUT_MINUTES, 15) * 60_000,
      devTimeoutMs: num(env.DEVELOPER_TIMEOUT_MINUTES, 30) * 60_000,
    },
    jev: {
      apiKey: env.TYPESAFE_API_KEY?.trim() || '',
      apiUrl: env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone',
      model: env.JEV_MODEL || 'jev-latest',
      minConfidence: num(env.JEV_MIN_CONFIDENCE, 0.7),
    },
    whatsapp: loadWhatsApp(env),
    loop: {
      severityMin: (env.SEVERITY_MIN || 'medium').toLowerCase(),
      cleanPasses: num(env.CLEAN_PASSES, 2),
      maxRounds: num(env.MAX_ROUNDS, 3),
      maxTotalRounds: num(env.MAX_TOTAL_ROUNDS, 20),
      maxFindingsPerPass: num(env.MAX_FINDINGS_PER_PASS, 5),
      scope: list(env.HUNT_SCOPE),
    },
    testTimeoutMs: num(env.TEST_TIMEOUT_MINUTES, 15) * 60_000,
    reportDir: path.resolve(env.REPORT_DIR || path.join(ROOT, 'reports')),
    stateFile: env.STATE_FILE || path.join(ROOT, 'state.json'),
  };
}
