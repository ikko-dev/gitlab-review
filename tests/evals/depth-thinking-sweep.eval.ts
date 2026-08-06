/**
 * Depth × thinking sweep (not a pass/fail eval — a measurement harness).
 *
 * Fixes ONE reviewer model (default: the luna candidate) and sweeps the two
 * review knobs against each other:
 *   - review-depth  ∈ {single, verify, full}
 *   - thinking      ∈ {off, low, medium, high}
 *
 * For every (depth, thinking, scenario, trial) it records the judge scores
 * (from ./review-suite.ts), real cache-aware cost/tokens (from pi-ai), and the
 * wall-clock latency of the review. It aggregates per (depth, thinking) cell and
 * writes:
 *   - test-results/depth-thinking-sweep.json  (raw + config)
 *   - test-results/depth-thinking-sweep.md     (accuracy / cost / latency matrices)
 *
 * Depth is FORCED per cell (scenario-level reviewDepth is ignored), and the two
 * depth-pinned "/verify" scenarios are dropped so the grid stays one clean pass
 * per scenario at each swept depth.
 *
 * Config via env:
 *   GITLAB_REVIEW_SWEEP_MODEL       reviewer model (default openrouter/openai/gpt-5.6-luna)
 *   GITLAB_REVIEW_SWEEP_DEPTHS      comma list (default single,verify,full)
 *   GITLAB_REVIEW_SWEEP_THINKING    comma list (default off,low,medium,high)
 *   GITLAB_REVIEW_SWEEP_TRIALS      integer (default 3)
 *   GITLAB_REVIEW_SWEEP_CONCURRENCY worker pool size (default 4)
 *   GITLAB_REVIEW_SWEEP_FRESH       "1" → ignore checkpoint
 *   GITLAB_REVIEW_SWEEP_SMOKE       "1" → single/off, 2 scenarios, 1 trial (wiring check)
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import type { Config } from '../../src/config.js';
import { resolveProviderApiKey } from '../../src/config.js';
import { runReview } from '../../src/gitlab-review.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';
import type { ReviewDepth, ThinkingLevel } from '../../src/types.js';
import {
  codeJudge,
  judgeAvailable,
  llmJudge,
  RUBRICS,
  SCENARIOS,
  type ReviewResult,
  type Scenario,
} from './review-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const RESULTS_DIR = join(HERE, '..', '..', 'test-results');

const cellKey = (d: string, k: string, s: string, t: number): string => `${d}|${k}|${s}|${t}`;

// ---------------------------------------------------------------------------
// Run config
// ---------------------------------------------------------------------------
const SMOKE = process.env.GITLAB_REVIEW_SWEEP_SMOKE === '1';
const MODEL = process.env.GITLAB_REVIEW_SWEEP_MODEL ?? 'openrouter/openai/gpt-5.6-luna';
const DEPTHS = (
  SMOKE
    ? ['single']
    : (process.env.GITLAB_REVIEW_SWEEP_DEPTHS?.split(',') ?? ['single', 'verify', 'full'])
) as ReviewDepth[];
const THINKINGS = (
  SMOKE
    ? ['off']
    : (process.env.GITLAB_REVIEW_SWEEP_THINKING?.split(',') ?? ['off', 'low', 'medium', 'high'])
) as ThinkingLevel[];
const TRIALS = SMOKE ? 1 : Number(process.env.GITLAB_REVIEW_SWEEP_TRIALS ?? 3);
// Depth is swept, so the depth-pinned `*/verify` scenarios would be duplicates
// of their base scenarios at the `verify` cell — drop them for a clean grid.
const ALL_SCENARIOS = SCENARIOS.filter((s) => !s.id.endsWith('/verify'));
const RUN_SCENARIOS = SMOKE ? ALL_SCENARIOS.slice(0, 2) : ALL_SCENARIOS;

function makeConfig(
  dir: string,
  skills: string[],
  reviewDepth: ReviewDepth,
  thinking: ThinkingLevel,
): Config {
  return {
    platform: 'gitlab',
    project: 'test',
    mr: '1',
    gitlabUrl: 'https://gitlab.example.com',
    gitlabToken: 'test',
    gitlabAuthHeader: 'PRIVATE-TOKEN',
    githubRepository: '',
    githubPr: '',
    githubToken: '',
    githubApiUrl: '',
    githubServerUrl: '',
    model: MODEL,
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: thinking,
    verifyModel: '',
    postingMode: 'direct',
    reviewDepth,
    apiKey: resolveProviderApiKey(MODEL),
    baseUrl: '',
    maxTokens: Number(process.env.GITLAB_REVIEW_MAX_TOKENS ?? 0),
    reviewFile: 'gitlab-review.md',
    output: 'review-comments.json',
    maxDiffChars: 0,
    decomposeHintLines: 0,
    diffContext: 0,
    retrieveSkipped: false,
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: dir,
    skills,
    marketplaces: [],
    refreshGitSkills: false,
  };
}

async function runOne(
  scenario: Scenario,
  depth: ReviewDepth,
  thinking: ThinkingLevel,
): Promise<{ result: ReviewResult; latencyMs: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'depth-sweep-'));
  const started = Date.now();
  try {
    const diff = await readFile(join(FIXTURES, scenario.fixture), 'utf8');
    const commitLog = scenario.commitLog
      ? await readFile(join(FIXTURES, scenario.commitLog), 'utf8')
      : undefined;
    const config = makeConfig(dir, scenario.skills, depth, thinking);
    const usage = await runReview(config, {
      diff,
      commitLog,
      priorThreads: scenario.priorThreads,
    });
    const raw = await readFile(join(dir, config.reviewFile), 'utf8');
    const parsed = parseReviewMarkdownWithWarnings(raw);
    return {
      latencyMs: Date.now() - started,
      result: {
        summary: parsed.summary ?? '',
        comments: parsed.comments.map((c) => ({
          file: c.file,
          line: c.line,
          side: c.side,
          severity: c.severity,
          confidence: c.confidence,
          body: c.body,
        })),
        tokens: usage.tokens,
        cost: usage.cost,
      },
    };
  } catch (err) {
    return {
      latencyMs: Date.now() - started,
      result: {
        summary: '',
        comments: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        error: (err as Error).message,
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type SweepRecord = {
  depth: ReviewDepth;
  thinking: ThinkingLevel;
  scenario: string;
  trial: number;
  error?: string;
  costTotal: number;
  tokensTotal: number;
  latencyMs: number;
  judges: Array<{
    name: string;
    category: string;
    score: number;
    expected: number | null;
    correct: number | null;
  }>;
};

test(
  'depth x thinking sweep',
  async () => {
    if (!judgeAvailable()) {
      console.warn(
        '[depth-sweep] No judge key (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) — skipping.',
      );
      return;
    }
    await mkdir(RESULTS_DIR, { recursive: true });
    const records: SweepRecord[] = [];

    // Resume: seed completed (depth|thinking|scenario|trial) combos from a prior
    // checkpoint that matches the CURRENT run configuration.
    const completed = new Set<string>();
    if (process.env.GITLAB_REVIEW_SWEEP_FRESH !== '1') {
      const depthSet = new Set<string>(DEPTHS);
      const thinkSet = new Set<string>(THINKINGS);
      const scenarioSet = new Set(RUN_SCENARIOS.map((s) => s.id));
      try {
        const prior = JSON.parse(
          await readFile(join(RESULTS_DIR, 'depth-thinking-sweep.json'), 'utf8'),
        ) as { records?: SweepRecord[] };
        let skipped = 0;
        for (const rec of prior.records ?? []) {
          if (rec.error) continue; // re-run failed trials
          if (
            !depthSet.has(rec.depth) ||
            !thinkSet.has(rec.thinking) ||
            !scenarioSet.has(rec.scenario) ||
            rec.trial < 0 ||
            rec.trial >= TRIALS
          ) {
            skipped++;
            continue;
          }
          records.push(rec);
          completed.add(cellKey(rec.depth, rec.thinking, rec.scenario, rec.trial));
        }
        if (records.length || skipped)
          console.log(
            `[resume] loaded ${records.length} completed records` +
              (skipped ? ` (skipped ${skipped} from a different configuration)` : ''),
          );
      } catch {
        // no checkpoint — fresh run
      }
    }

    const tasks: Array<{
      depth: ReviewDepth;
      thinking: ThinkingLevel;
      scenario: Scenario;
      trial: number;
    }> = [];
    for (const depth of DEPTHS)
      for (const thinking of THINKINGS)
        for (const scenario of RUN_SCENARIOS)
          for (let trial = 0; trial < TRIALS; trial++) {
            if (completed.has(cellKey(depth, thinking, scenario.id, trial))) continue;
            tasks.push({ depth, thinking, scenario, trial });
          }

    const total = tasks.length;
    const concurrency = Number(process.env.GITLAB_REVIEW_SWEEP_CONCURRENCY ?? 4);
    console.log(
      `[depth-sweep] model=${MODEL} depths=${DEPTHS.join(',')} thinking=${THINKINGS.join(',')} ` +
        `scenarios=${RUN_SCENARIOS.length} trials=${TRIALS} → ${total} reviews (concurrency ${concurrency})`,
    );
    let done = 0;
    let cursor = 0;

    // Single-writer checkpoint queue (same pattern as model-comparison): serialize
    // concurrent writes so they can't interleave or clobber a newer snapshot.
    let checkpointChain: Promise<void> = Promise.resolve();
    function writeCheckpoint(): Promise<void> {
      const run = checkpointChain.then(() =>
        writeFile(
          join(RESULTS_DIR, 'depth-thinking-sweep.json'),
          JSON.stringify(
            {
              model: MODEL,
              depths: DEPTHS,
              thinking: THINKINGS,
              trials: TRIALS,
              scenarios: RUN_SCENARIOS.length,
              records,
            },
            null,
            2,
          ),
        ),
      );
      checkpointChain = run.catch(() => {});
      return run;
    }

    async function processTask(t: (typeof tasks)[number]): Promise<void> {
      const { result, latencyMs } = await runOne(t.scenario, t.depth, t.thinking);
      const judges: SweepRecord['judges'] = [];
      if (!result.error) {
        for (const j of t.scenario.judges) {
          let score: 0 | 1 = 0;
          try {
            score =
              j.kind === 'llm'
                ? await llmJudge(RUBRICS[j.name as keyof typeof RUBRICS], result)
                : codeJudge[j.name as keyof typeof codeJudge](result);
          } catch (err) {
            console.warn(`[judge ${j.name}] ${(err as Error).message}`);
          }
          judges.push({
            name: j.name,
            category: j.category,
            score,
            expected: j.expected,
            correct: j.expected === null ? null : score === j.expected ? 1 : 0,
          });
        }
      }
      records.push({
        depth: t.depth,
        thinking: t.thinking,
        scenario: t.scenario.id,
        trial: t.trial,
        error: result.error,
        costTotal: result.cost.total,
        tokensTotal: result.tokens.total,
        latencyMs,
        judges,
      });
      done++;
      const tag = result.error
        ? `ERROR ${result.error.slice(0, 60)}`
        : `ok ${(latencyMs / 1000).toFixed(1)}s`;
      console.log(
        `[${done}/${total}] ${t.depth}/${t.thinking} · ${t.scenario.id} · t${t.trial} → ${tag}`,
      );
      await writeCheckpoint();
    }

    async function worker(): Promise<void> {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        await processTask(t);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    await checkpointChain;

    const md = buildReport(records);
    await writeFile(join(RESULTS_DIR, 'depth-thinking-sweep.md'), md);
    console.log('\n' + md);
    expect(records.length).toBe(DEPTHS.length * THINKINGS.length * RUN_SCENARIOS.length * TRIALS);
  },
  6 * 60 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function accuracy(rs: SweepRecord[]): number | null {
  const cc = rs
    .flatMap((x) => x.judges.map((j) => j.correct))
    .filter((c): c is number => c !== null);
  return cc.length ? cc.reduce((a, b) => a + b, 0) / cc.length : null;
}

function categoryAccuracy(rs: SweepRecord[], cat: string): number | null {
  const cc = rs
    .flatMap((x) => x.judges.filter((j) => j.category === cat).map((j) => j.correct))
    .filter((c): c is number => c !== null);
  return cc.length ? cc.reduce((a, b) => a + b, 0) / cc.length : null;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(0)}%`;
}

function buildReport(records: SweepRecord[]): string {
  const depths = [...new Set(records.map((x) => x.depth))];
  const thinks = [...new Set(records.map((x) => x.thinking))];
  const cell = (d: string, k: string): SweepRecord[] =>
    records.filter((x) => x.depth === d && x.thinking === k);
  const lines: string[] = [`# Depth × thinking sweep — ${MODEL}`, ''];

  const matrix = (title: string, fmt: (rs: SweepRecord[]) => string): void => {
    lines.push(`## ${title}`, '');
    lines.push('| depth \\ thinking | ' + thinks.join(' | ') + ' |');
    lines.push('|---|' + thinks.map(() => '---').join('|') + '|');
    for (const d of depths) {
      const cells = thinks.map((k) => fmt(cell(d, k)));
      lines.push(`| **${d}** | ${cells.join(' | ')} |`);
    }
    lines.push('');
  };

  matrix('Accuracy (correct vs expected, all judges)', (rs) => pct(accuracy(rs)));
  matrix('Cost — $/review (real, cache-aware)', (rs) => {
    const ok = rs.filter((x) => !x.error);
    if (!ok.length) return '—';
    return `$${(ok.reduce((a, x) => a + x.costTotal, 0) / ok.length).toFixed(5)}`;
  });
  matrix('Latency — p50 (s)', (rs) => {
    const ok = rs.filter((x) => !x.error);
    if (!ok.length) return '—';
    return `${(
      percentile(
        ok.map((x) => x.latencyMs),
        50,
      ) / 1000
    ).toFixed(1)}`;
  });
  matrix('Latency — p95 (s)', (rs) => {
    const ok = rs.filter((x) => !x.error);
    if (!ok.length) return '—';
    return `${(
      percentile(
        ok.map((x) => x.latencyMs),
        95,
      ) / 1000
    ).toFixed(1)}`;
  });

  // Per-cell detail: category accuracy + tokens + errors.
  const cats = ['recall', 'precision', 'format', 'context'] as const;
  lines.push('## Per-cell detail', '');
  lines.push(
    '| depth | thinking | acc | ' +
      cats.join(' | ') +
      ' | $/review | avg tokens | p50 s | errors |',
  );
  lines.push('|---|---|---|' + cats.map(() => '---').join('|') + '|---|---|---|---|');
  for (const d of depths)
    for (const k of thinks) {
      const rs = cell(d, k);
      const ok = rs.filter((x) => !x.error);
      const perReview = ok.length ? ok.reduce((a, x) => a + x.costTotal, 0) / ok.length : 0;
      const avgTok = ok.length
        ? Math.round(ok.reduce((a, x) => a + x.tokensTotal, 0) / ok.length)
        : 0;
      const p50 = ok.length
        ? percentile(
            ok.map((x) => x.latencyMs),
            50,
          ) / 1000
        : 0;
      const errs = rs.filter((x) => x.error).length;
      lines.push(
        `| ${d} | ${k} | ${pct(accuracy(rs))} | ${cats.map((c) => pct(categoryAccuracy(rs, c))).join(' | ')} | $${perReview.toFixed(5)} | ${avgTok.toLocaleString()} | ${p50.toFixed(1)} | ${errs} |`,
      );
    }
  lines.push('');
  lines.push(
    `_Model: ${MODEL}. Accuracy = judge score matched the expected value (diagnostic judges excluded). ` +
      `Cost/tokens are real, computed by pi-ai (cache-aware). Latency is wall-clock per review at concurrency > 1, so treat it as relative between cells, not an absolute single-review time._`,
  );
  return lines.join('\n');
}
