#!/usr/bin/env node
/**
 * Materialize SWE-PRBench instances into real, explorable checkouts so the
 * reviewer agent has file access (not just the patch).
 *
 * Strategy per instance: blobless clone (history metadata, lazy blobs) → fetch +
 * checkout `base_commit` (the fork point, which IS in the base repo's history;
 * the PR `head_commit` usually is not) → `git apply` the diff → commit. The
 * resulting working tree is the project AT THE REVIEWED STATE, and `git log`/
 * blame stay coherent.
 *
 * Output: repos/<task_id>/ (gitignored). A `.materialized` marker holds the
 * base SHA on success. `repos/manifest.json` records ok/failed/skipped.
 *
 * Usage:
 *   node materialize.mjs                       # all instances
 *   node materialize.mjs --limit 6             # first N
 *   node materialize.mjs --only zod__5578,vega__4219
 *   node materialize.mjs --repos stylelint,zod # substring match on repo/task
 *   node materialize.mjs --fresh               # re-clone even if present
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const JSONL = join(HERE, 'tsjs-subset.jsonl');
const REPOS = join(HERE, 'repos');

function parseArgs(argv) {
  const a = { limit: 0, only: null, repos: null, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') a.limit = Number(argv[++i]);
    else if (argv[i] === '--only') a.only = new Set(argv[++i].split(','));
    else if (argv[i] === '--repos') a.repos = argv[++i].split(',');
    else if (argv[i] === '--fresh') a.fresh = true;
  }
  return a;
}

const cloneUrl = (repo) => `https://github.com/${repo}.git`;

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd, args, opts = {}) {
  return pexec('git', args, { cwd, maxBuffer: 1024 * 1024 * 64, ...opts });
}

async function materializeOne(inst) {
  const dir = join(REPOS, inst.task_id);
  const marker = join(dir, '.materialized');
  if (await exists(marker)) return { task_id: inst.task_id, status: 'cached' };

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // Write the diff OUTSIDE the repo so it never enters the committed tree (else
  // the agent could read the answer key straight off disk).
  const diffPath = join(tmpdir(), `swepr-${inst.task_id}.diff`);

  try {
    // 1. blobless clone, no checkout (fast; history metadata only).
    await git(REPOS, [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      cloneUrl(inst.repo),
      inst.task_id,
    ]);
    // 2. fetch the exact base commit, then check it out.
    await git(dir, ['fetch', '--filter=blob:none', 'origin', inst.base_commit]);
    await git(dir, ['checkout', '--force', inst.base_commit]);
    // 3. apply the PR diff to reach the reviewed (head) state.
    await writeFile(diffPath, inst.diff_patch);
    let applied = false;
    for (const extra of [[], ['--3way'], ['--reject', '--whitespace=nowarn']]) {
      try {
        await git(dir, ['apply', ...extra, diffPath]);
        applied = true;
        break;
      } catch {
        /* try next strategy */
      }
    }
    if (!applied) throw new Error('git apply failed (all strategies)');
    // 4. commit so the checkout is a clean, blame-coherent state.
    await git(dir, ['add', '-A']);
    await git(dir, [
      '-c',
      'user.email=eval@local',
      '-c',
      'user.name=eval',
      'commit',
      '--no-verify',
      '-m',
      `SWE-PRBench ${inst.task_id} (PR #${inst.pr_number})`,
    ]);
    await rm(diffPath, { force: true });
    await writeFile(marker, inst.base_commit + '\n');
    return { task_id: inst.task_id, status: 'ok' };
  } catch (err) {
    return { task_id: inst.task_id, status: 'failed', error: String(err).slice(0, 300) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(REPOS, { recursive: true });
  let insts = (await readFile(JSONL, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  if (args.only) insts = insts.filter((i) => args.only.has(i.task_id));
  if (args.repos)
    insts = insts.filter((i) => args.repos.some((s) => i.repo.includes(s) || i.task_id.includes(s)));
  if (args.fresh)
    await Promise.all(
      insts.map((i) => rm(join(REPOS, i.task_id), { recursive: true, force: true })),
    );
  if (args.limit > 0) insts = insts.slice(0, args.limit);

  console.log(`Materializing ${insts.length} instance(s) into ${REPOS}`);
  const results = [];
  // Clone serially — network + disk bound, and large repos benefit from not
  // competing for bandwidth.
  for (const inst of insts) {
    process.stdout.write(`  ${inst.task_id} (${inst.repo}) … `);
    const r = await materializeOne(inst);
    results.push(r);
    console.log(r.status === 'failed' ? `FAILED: ${r.error}` : r.status);
  }

  const manifest = join(REPOS, 'manifest.json');
  let prior = {};
  if (await exists(manifest)) prior = JSON.parse(await readFile(manifest, 'utf8'));
  for (const r of results) prior[r.task_id] = r;
  await writeFile(manifest, JSON.stringify(prior, null, 2));

  const ok = results.filter((r) => r.status === 'ok' || r.status === 'cached').length;
  const failed = results.filter((r) => r.status === 'failed');
  console.log(`\nDone: ${ok} ok/cached, ${failed.length} failed.`);
  if (failed.length) for (const f of failed) console.log(`  FAILED ${f.task_id}: ${f.error}`);
}

await main();
