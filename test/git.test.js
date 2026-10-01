import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../src/proc.js';
import * as git from '../src/git.js';

let dir;
const g = (args) => run('git', args, { cwd: dir });

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'hvd-git-'));
  await g(['init', '-q', '-b', 'dev']);
  await g(['config', 'user.email', 't@t.t']);
  await g(['config', 'user.name', 'T']);
  await g(['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(dir, 'app.js'), 'export const secure = false;\n');
  await g(['add', '-A']);
  await g(['commit', '-q', '-m', 'init']);
});

after(() => rmSync(dir, { recursive: true, force: true }));

// Each test starts from a clean dev checkout, even if a previous one threw before its cleanup.
beforeEach(async () => {
  await g(['checkout', '-f', 'dev']);
  await g(['reset', '--hard']);
  await g(['clean', '-fd']);
});

const GIT = { remote: 'origin', targetBranch: 'dev', branchPrefix: 'hvd/', push: false, mrLabels: ['security'] };

test('keepOnlyProof keeps the test dir and reverts app-code changes', async () => {
  await git.startBranch(dir, GIT, 'hvd/t1');
  // Hacker writes a proof AND (wrongly) edits app code.
  mkdirSync(path.join(dir, '__hvd__'), { recursive: true });
  writeFileSync(path.join(dir, '__hvd__', 'poc.test.js'), '// failing test\n');
  writeFileSync(path.join(dir, 'app.js'), 'export const secure = true; // tampered\n');

  await git.keepOnlyProof(dir, '__hvd__');

  assert.ok(existsSync(path.join(dir, '__hvd__', 'poc.test.js')), 'proof kept');
  assert.equal(readFileSync(path.join(dir, 'app.js'), 'utf8'), 'export const secure = false;\n', 'app code reverted');
  assert.ok(await git.hasChanges(dir));
  await git.cleanup(dir, GIT, 'hvd/t1');
});

test('restoreProof reverts Developer edits to the test dir', async () => {
  await git.startBranch(dir, GIT, 'hvd/t2');
  mkdirSync(path.join(dir, '__hvd__'), { recursive: true });
  writeFileSync(path.join(dir, '__hvd__', 'poc.test.js'), 'ORIGINAL PROOF\n');
  await git.keepOnlyProof(dir, '__hvd__');
  // Developer tampers with the proof and fixes code.
  writeFileSync(path.join(dir, '__hvd__', 'poc.test.js'), 'WEAKENED\n');
  writeFileSync(path.join(dir, 'app.js'), 'export const secure = true;\n');

  await git.restoreProof(dir, '__hvd__');

  assert.equal(readFileSync(path.join(dir, '__hvd__', 'poc.test.js'), 'utf8'), 'ORIGINAL PROOF\n', 'proof restored');
  assert.ok(await git.changedOutside(dir, '__hvd__'), 'app code change detected');
  await git.cleanup(dir, GIT, 'hvd/t2');
});

test('commitRound commits locally without pushing when push=false', async () => {
  await git.startBranch(dir, GIT, 'hvd/t3');
  mkdirSync(path.join(dir, '__hvd__'), { recursive: true });
  writeFileSync(path.join(dir, '__hvd__', 'poc.test.js'), 'proof\n');
  writeFileSync(path.join(dir, 'app.js'), 'export const secure = true;\n');
  const { sha, mrUrl, pushed } = await git.commitRound(dir, GIT, 'hvd/t3', 'fix: secure', 'fix title');
  assert.ok(/^[0-9a-f]{7,}$/.test(sha));
  assert.equal(pushed, false);
  assert.equal(mrUrl, '');
  await git.cleanup(dir, GIT, 'hvd/t3');
  // back on dev, branch gone
  const branches = (await g(['branch'])).stdout;
  assert.ok(!branches.includes('hvd/t3'));
});

test('startBranch refuses a dirty tree', async () => {
  writeFileSync(path.join(dir, 'app.js'), 'dirty\n');
  await assert.rejects(() => git.startBranch(dir, GIT, 'hvd/dirty'), /uncommitted changes/);
  await g(['checkout', '--', 'app.js']);
});
