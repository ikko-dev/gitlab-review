/**
 * SWE-PRBench TS/JS depth×thinking sweep, WITH FILE ACCESS (measurement harness).
 *
 * Fixes the luna model and sweeps review-depth {single,verify,full} × thinking
 * {low,medium,high} over the materialized TS/JS checkouts, so we can see how the
 * knobs move recall/precision on REAL diffs with the agent exploring the repo —
 * the file-access analogue of the earlier synthetic depth×thinking sweep.
 *
 * Gold triage is computed ONCE per PR and frozen (test-results/swe-prbench-triage.json)
 * so "which gold are real defects" is identical across all 9 cells; only the
 * match+verdict step (which depends on our findings) runs per review.
 *
 * Prereq: materialize first — `node tests/evals/fixtures/swe-prbench/materialize.mjs`.
 * Writes test-results/swe-prbench-sweep.{json,md}.
 *
 * Env: GITLAB_REVIEW_SWEPR_MODEL / _DEPTHS / _THINKING / _TRIALS / _CONCURRENCY /
 *      _LIMIT / _ONLY / _FRESH.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { ReviewDepth, ThinkingLevel } from '../../src/types.js';
import { judgeAvailable } from './review-suite.js';
import {
  isMaterialized,
  loadInstances,
  loadTriageCache,
  matchAndVerdict,
  repoDirFor,
  runReviewer,
  triageGold,
  validMatch,
  RESULTS_DIR,
  TRIAGE_CACHE,
  type Instance,
  type TriageEntry,
} from './swe-prbench-lib.js';

const MODEL = process.env.GITLAB_REVIEW_SWEPR_MODEL ?? 'openrouter/openai/gpt-5.6-luna';
const DEPTHS = (process.env.GITLAB_REVIEW_SWEPR_DEPTHS?.split(',') ?? [
  'single',
  'verify',
  'full',
]) as ReviewDepth[];
const THINKINGS = (process.env.GITLAB_REVIEW_SWEPR_THINKING?.split(',') ?? [
  'low',
  'medium',
  'high',
]) as ThinkingLevel[];
const TRIALS = Number(process.env.GITLAB_REVIEW_SWEPR_TRIALS ?? 1);

const cellKey = (d: string, k: string, t: string, tr: number): string => `${d}|${k}|${t}|${tr}`;

type SweepRecord = {
  depth: ReviewDepth;
  thinking: ThinkingLevel;
  task_id: string;
  difficulty: string;
  trial: number;
  error?: string;
  costTotal: number;
  tokensTotal: number;
  latencyMs: number;
  numFindings: number;
  goldCode: number;
  goldDefects: number;
  goldDefectsMatched: number;
  goldMatchedAny: number;
  verdicts: { CONFIRMED: number; PLAUSIBLE: number; FABRICATED: number };
};

test(
  'swe-prbench depth x thinking sweep (file access)',
  async () => {
    if (!judgeAvailable()) {
      console.warn('[swepr-sweep] No judge key — skipping.');
      return;
    }
    await mkdir(RESULTS_DIR, { recursive: true });

    const all = await loadInstances({
      only: process.env.GITLAB_REVIEW_SWEPR_ONLY,
      limit: Number(process.env.GITLAB_REVIEW_SWEPR_LIMIT ?? 0),
    });
    const runnable: Instance[] = [];
    const skipped: string[] = [];
    for (const inst of all) {
      if (await isMaterialized(inst.task_id)) runnable.push(inst);
      else skipped.push(inst.task_id);
    }
    if (!runnable.length) {
      console.warn('[swepr-sweep] Nothing materialized; run materialize.mjs first. Skipping.');
      return;
    }
    if (skipped.length) console.warn(`[swepr-sweep] ${skipped.length} not materialized — skipped.`);

    // --- Triage phase: freeze is_defect per PR (shared across all cells). ---
    const triage = await loadTriageCache();
    const needTriage = runnable.filter((i) => !triage[i.task_id]);
    if (needTriage.length) {
      console.log(`[swepr-sweep] triaging ${needTriage.length} PR(s) (frozen across cells)…`);
      let ci = 0;
      const triageWorker = async (): Promise<void> => {
        while (ci < needTriage.length) {
          const inst = needTriage[ci++];
          triage[inst.task_id] = await triageGold(inst);
          await writeFile(TRIAGE_CACHE, JSON.stringify(triage, null, 2));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, needTriage.length) }, triageWorker));
    }
    const defectIdx = (taskId: string): Set<number> =>
      new Set((triage[taskId] ?? []).filter((g: TriageEntry) => g.is_defect).map((g) => g.i));

    // --- Sweep phase. ---
    const records: SweepRecord[] = [];
    const completed = new Set<string>();
    if (process.env.GITLAB_REVIEW_SWEPR_FRESH !== '1') {
      try {
        const prior = JSON.parse(
          await readFile(join(RESULTS_DIR, 'swe-prbench-sweep.json'), 'utf8'),
        ) as {
          config?: { model: string };
          records?: SweepRecord[];
        };
        if (prior.config?.model === MODEL)
          for (const r of prior.records ?? []) {
            if (r.error) continue;
            records.push(r);
            completed.add(cellKey(r.depth, r.thinking, r.task_id, r.trial));
          }
        if (records.length) console.log(`[resume] loaded ${records.length} records`);
      } catch {
        // fresh
      }
    }

    const tasks: Array<{
      depth: ReviewDepth;
      thinking: ThinkingLevel;
      inst: Instance;
      trial: number;
    }> = [];
    for (const depth of DEPTHS)
      for (const thinking of THINKINGS)
        for (const inst of runnable)
          for (let trial = 0; trial < TRIALS; trial++) {
            if (completed.has(cellKey(depth, thinking, inst.task_id, trial))) continue;
            tasks.push({ depth, thinking, inst, trial });
          }

    const total = tasks.length;
    const concurrency = Number(process.env.GITLAB_REVIEW_SWEPR_CONCURRENCY ?? 3);
    console.log(
      `[swepr-sweep] model=${MODEL} depths=${DEPTHS.join(',')} thinking=${THINKINGS.join(',')} ` +
        `PRs=${runnable.length} trials=${TRIALS} → ${total} reviews (concurrency ${concurrency})`,
    );

    let done = 0;
    let cursor = 0;
    let chain: Promise<void> = Promise.resolve();
    const checkpoint = (): Promise<void> => {
      const run = chain.then(() =>
        writeFile(
          join(RESULTS_DIR, 'swe-prbench-sweep.json'),
          JSON.stringify(
            {
              config: {
                model: MODEL,
                depths: DEPTHS,
                thinking: THINKINGS,
                trials: TRIALS,
                fileAccess: true,
              },
              records,
            },
            null,
            2,
          ),
        ),
      );
      chain = run.catch(() => {});
      return run;
    };

    async function processOne(t: (typeof tasks)[number]): Promise<void> {
      const { depth, thinking, inst, trial } = t;
      const review = await runReviewer(inst, repoDirFor(inst.task_id), {
        model: MODEL,
        depth,
        thinking,
      });
      const nf = review.findings.length;
      const verdicts = { CONFIRMED: 0, PLAUSIBLE: 0, FABRICATED: 0 };
      let matchedAny = 0;
      let defectsMatched = 0;
      const defects = defectIdx(inst.task_id);
      if (!review.error) {
        const scored = await matchAndVerdict(inst, review.findings).catch(() => null);
        for (const f of scored?.findings ?? []) if (f.verdict in verdicts) verdicts[f.verdict]++;
        for (const g of scored?.gold ?? []) {
          if (!validMatch(g.matched_finding_index, nf)) continue;
          matchedAny++;
          if (defects.has(g.i)) defectsMatched++;
        }
      }
      records.push({
        depth,
        thinking,
        task_id: inst.task_id,
        difficulty: inst.difficulty,
        trial,
        error: review.error,
        costTotal: review.costTotal,
        tokensTotal: review.tokensTotal,
        latencyMs: review.latencyMs,
        numFindings: nf,
        goldCode: inst.gold_comments_code.length,
        goldDefects: defects.size,
        goldDefectsMatched: defectsMatched,
        goldMatchedAny: matchedAny,
        verdicts,
      });
      done++;
      const tag = review.error
        ? `ERROR ${review.error.slice(0, 40)}`
        : `ok ${(review.latencyMs / 1000).toFixed(0)}s ${nf}f`;
      console.log(`[${done}/${total}] ${depth}/${thinking} · ${inst.task_id} · t${trial} → ${tag}`);
      await checkpoint();
    }

    async function worker(): Promise<void> {
      while (cursor < tasks.length) await processOne(tasks[cursor++]);
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length || 1) }, worker));
    await chain;

    const md = buildReport(records);
    await writeFile(join(RESULTS_DIR, 'swe-prbench-sweep.md'), md);
    console.log('\n' + md);
    expect(records.length).toBe(DEPTHS.length * THINKINGS.length * runnable.length * TRIALS);
  },
  8 * 60 * 60 * 1000,
);

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function buildReport(records: SweepRecord[]): string {
  const depths = [...new Set(records.map((r) => r.depth))];
  const thinks = [...new Set(records.map((r) => r.thinking))];
  const cell = (d: string, k: string): SweepRecord[] =>
    records.filter((r) => r.depth === d && r.thinking === k && !r.error);
  const lines: string[] = [`# SWE-PRBench depth × thinking sweep (file access) — ${MODEL}`, ''];

  const matrix = (title: string, fmt: (rs: SweepRecord[]) => string): void => {
    lines.push(`## ${title}`, '');
    lines.push('| depth \\ thinking | ' + thinks.join(' | ') + ' |');
    lines.push('|---|' + thinks.map(() => '---').join('|') + '|');
    for (const d of depths)
      lines.push(`| **${d}** | ${thinks.map((k) => fmt(cell(d, k))).join(' | ')} |`);
    lines.push('');
  };

  const recall = (rs: SweepRecord[]): string => {
    const gd = rs.reduce((a, r) => a + r.goldDefects, 0);
    const gdm = rs.reduce((a, r) => a + r.goldDefectsMatched, 0);
    return gd ? `${((gdm / gd) * 100).toFixed(0)}% (${gdm}/${gd})` : '—';
  };
  matrix('Defect recall (matched real defects / real defects)', recall);
  matrix('Findings per PR', (rs) =>
    rs.length ? (rs.reduce((a, r) => a + r.numFindings, 0) / rs.length).toFixed(1) : '—',
  );
  matrix('Fabrication rate (FABRICATED / findings)', (rs) => {
    const f = rs.reduce((a, r) => a + r.numFindings, 0);
    const fb = rs.reduce((a, r) => a + r.verdicts.FABRICATED, 0);
    return f ? `${((fb / f) * 100).toFixed(0)}% (${fb}/${f})` : '—';
  });
  matrix('$/review', (rs) =>
    rs.length ? `$${(rs.reduce((a, r) => a + r.costTotal, 0) / rs.length).toFixed(4)}` : '—',
  );
  matrix('p50 latency (s)', (rs) =>
    rs.length
      ? (
          percentile(
            rs.map((r) => r.latencyMs),
            50,
          ) / 1000
        ).toFixed(0)
      : '—',
  );

  lines.push('## Per-cell detail', '');
  lines.push(
    '| depth | thinking | PRs | defect recall | findings/PR | confirmed | fabricated | $/review | p50 s |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const d of depths)
    for (const k of thinks) {
      const rs = cell(d, k);
      const fnd = rs.reduce((a, r) => a + r.numFindings, 0);
      const conf = rs.reduce((a, r) => a + r.verdicts.CONFIRMED, 0);
      const fab = rs.reduce((a, r) => a + r.verdicts.FABRICATED, 0);
      const cost = rs.length ? rs.reduce((a, r) => a + r.costTotal, 0) / rs.length : 0;
      const p50 = rs.length
        ? percentile(
            rs.map((r) => r.latencyMs),
            50,
          ) / 1000
        : 0;
      lines.push(
        `| ${d} | ${k} | ${rs.length} | ${recall(rs)} | ${rs.length ? (fnd / rs.length).toFixed(1) : '—'} | ${conf} | ${fab} | $${cost.toFixed(4)} | ${p50.toFixed(0)} |`,
      );
    }
  lines.push('');
  const errs = records.filter((r) => r.error).length;
  lines.push(
    `_File access on (real checkouts, agent explores repo). Gold triage frozen across all cells. ` +
      `${TRIALS} trial(s)/cell. ${errs} errored review(s). Defect recall = matched real defects / triaged real defects. Fabrication is gold-independent._`,
  );
  return lines.join('\n');
}
