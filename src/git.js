import { run } from './proc.js';

async function git(cwd, args) {
  const res = await run('git', args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`);
  return { out: res.stdout.trim(), all: `${res.stdout}\n${res.stderr}` };
}

/**
 * Start a fresh round branch. When pushing, base it on an up-to-date <remote>/<target>;
 * offline (GIT_PUSH=false) base it on the current HEAD so no network is needed.
 * Refuses to touch a dirty tree: REPOS must point at a dedicated clean clone.
 */
export async function startBranch(cwd, { remote, targetBranch, push }, branch) {
  if ((await git(cwd, ['status', '--porcelain'])).out) {
    throw new Error(`${cwd} has uncommitted changes: point REPOS at a dedicated clean clone`);
  }
  if (push) {
    await git(cwd, ['fetch', remote, targetBranch]);
    await git(cwd, ['checkout', '-B', branch, `${remote}/${targetBranch}`]);
  } else {
    await git(cwd, ['checkout', '-B', branch]);
  }
}

export async function hasChanges(cwd) {
  return Boolean((await git(cwd, ['status', '--porcelain'])).out);
}

/** True if anything changed outside `keepDir` (used to confirm the fix actually touched code). */
export async function changedOutside(cwd, keepDir) {
  const names = (await git(cwd, ['status', '--porcelain', '--untracked-files=all'])).out;
  return names.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
    .some((p) => !p.replace(/^"|"$/g, '').startsWith(`${keepDir}/`));
}

/**
 * Keep only the Hacker's proof: stage `keepDir`, then revert every other change (tracked
 * edits and new untracked files) so the proof step can never modify application code.
 */
export async function keepOnlyProof(cwd, keepDir) {
  await git(cwd, ['add', '--', keepDir]);
  await git(cwd, ['checkout', '--', '.']);
  await git(cwd, ['clean', '-fd', '-e', `/${keepDir}/`, '-e', `/${keepDir}`]);
}

/** Restore the staged proof tests, discarding any edit the Developer made inside `keepDir`. */
export async function restoreProof(cwd, keepDir) {
  await git(cwd, ['checkout', '--', keepDir]).catch(() => {});
}

/**
 * Commit the round (fix + proof). When `push` is set, push the branch and ask GitLab to open a
 * merge request into <target> through push options (no API token). Returns the short sha, the MR
 * url (if any) and whether it was pushed.
 */
export async function commitRound(cwd, { remote, targetBranch, push, mrLabels }, branch, message, title) {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
  const sha = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).out;
  if (!push) return { sha, mrUrl: '', pushed: false };

  const opts = [
    '-o', 'merge_request.create',
    '-o', `merge_request.target=${targetBranch}`,
    '-o', `merge_request.title=${title.replace(/[\r\n]+/g, ' ')}`,
    '-o', 'merge_request.remove_source_branch',
  ];
  for (const label of mrLabels) opts.push('-o', `merge_request.label=${label}`);
  const pushRes = await git(cwd, ['push', '--force-with-lease', '-u', remote, branch, ...opts]);
  const mrUrl = pushRes.all.match(/https?:\/\/\S+\/-\/merge_requests\/\d+/)?.[0] ?? '';
  return { sha, mrUrl, pushed: true };
}

/** Back to <target>, dropping the round branch and anything left in the tree (ignored files kept). */
export async function cleanup(cwd, { remote, targetBranch, push }, branch) {
  await git(cwd, ['reset', '--hard']);
  await git(cwd, ['clean', '-fd']);
  const base = push ? [`${remote}/${targetBranch}`] : [];
  await git(cwd, ['checkout', '-B', targetBranch, ...base]).catch(async () => {
    await git(cwd, ['checkout', targetBranch]).catch(() => {});
  });
  await git(cwd, ['branch', '-D', branch]).catch(() => {});
}
