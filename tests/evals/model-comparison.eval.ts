/**
 * Model comparison runner (not a pass/fail eval — a measurement harness).
 *
 * Runs the full review-eval fixture suite across several models and records,
 * per (model, scenario, trial):
 *   - each judge's score (LLM judges + code judges, from ./review-suite.ts)
 *   - whether the score matched the *expected* value (correctness)
 *   - real token usage and real cost (computed by pi-ai, cache-aware)
 *
 * It then aggregates per-model accuracy and cost and writes:
 *   - test-results/model-comparison.json   (raw + aggregates)
 *   - test-results/model-comparison.md      (human-readable comparison)
 *
 * Reviewer model is set per row; the API key is resolved per-provider via
 * resolveProviderApiKey (so GPT-via-Cloudflare-gateway uses CLOUDFLARE_API_KEY,
 * Anthropic uses ANTHROPIC_API_KEY). The LLM judge always runs on a Claude model,
 * independent of the model under test (see review-suite.ts for transport).
 *
 * Config via env:
 *   GITLAB_REVIEW_COMPARE_MODELS    comma-separated provider/modelId list
 *   GITLAB_REVIEW_COMPARE_TRIALS    integer (default 3)
 *   GITLAB_REVIEW_COMPARE_THINKING  reviewer reasoning effort for every model
 *                                   (off|minimal|low|medium|high|xhigh; default off)
 *   GITLAB_REVIEW_COMPARE_SMOKE     "1" → 1 model, 1 trial, 2 scenarios (wiring check)
 *
 * THINKING is applied uniformly to all models in a run, which makes both
 * comparison axes cheap to explore: fix the effort and vary the model (tier
 * comparison), or fix the model and run twice at different efforts.
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

/** Resume checkpoint key for a single (model, scenario, trial) combination. */
const recordKey = (m: string, s: string, t: number): string => `${m}|${s}|${t}`;

// ---------------------------------------------------------------------------
// Run config
// ---------------------------------------------------------------------------
const SMOKE = process.env.GITLAB_REVIEW_COMPARE_SMOKE === '1';
// Head-to-head: gpt-5.6-luna (cheap new candidate) vs gpt-5.4 (prior choice).
// Both routed via OpenRouter so the harness, key, and cost accounting are
// identical for both rows; pi-ai computes real cache-aware cost either way.
const DEFAULT_MODELS = ['openrouter/openai/gpt-5.6-luna', 'openrouter/openai/gpt-5.4'];
const MODELS = SMOKE
  ? (process.env.GITLAB_REVIEW_COMPARE_MODELS?.split(',') ?? ['openai/gpt-5.4-nano'])
  : (process.env.GITLAB_REVIEW_COMPARE_MODELS?.split(',') ?? DEFAULT_MODELS);
const TRIALS = SMOKE ? 1 : Number(process.env.GITLAB_REVIEW_COMPARE_TRIALS ?? 3);
const RUN_SCENARIOS = SMOKE ? SCENARIOS.slice(0, 2) : SCENARIOS;
// Reviewer reasoning effort applied to every model in the run. 'off' matches the
// original baseline; set GITLAB_REVIEW_COMPARE_THINKING=xhigh to test whether
// higher reasoning lifts precision (e.g. respecting prior-thread justifications).
const THINKING = (process.env.GITLAB_REVIEW_COMPARE_THINKING ?? 'off') as ThinkingLevel;

function makeConfig(
  model: string,
  dir: string,
  skills: string[],
  reviewDepth: ReviewDepth,
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
    model,
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: THINKING,
    verifyModel: '',
    postingMode: 'direct',
    reviewDepth,
    // Resolve the key for THIS model's provider. This is the real production
    // behaviour: openrouter/* → OPENROUTER_API_KEY, anthropic/* → ANTHROPIC_API_KEY.
    apiKey: resolveProviderApiKey(model),
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

async function runOne(model: string, scenario: Scenario): Promise<ReviewResult> {
  const dir = await mkdtemp(join(tmpdir(), 'model-cmp-'));
  try {
    const diff = await readFile(join(FIXTURES, scenario.fixture), 'utf8');
    const commitLog = scenario.commitLog
      ? await readFile(join(FIXTURES, scenario.commitLog), 'utf8')
      : undefined;
    const config = makeConfig(model, dir, scenario.skills, scenario.reviewDepth ?? 'single');
    const usage = await runReview(config, {
      diff,
      commitLog,
      priorThreads: scenario.priorThreads,
    });
    const raw = await readFile(join(dir, config.reviewFile), 'utf8');
    const parsed = parseReviewMarkdownWithWarnings(raw);
    return {
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
    };
  } catch (err) {
    return {
      summary: '',
      comments: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      error: (err as Error).message,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type TrialRecord = {
  model: string;
  scenario: string;
  trial: number;
  error?: string;
  costTotal: number;
  tokensTotal: number;
  judges: Array<{
    name: string;
    category: string;
    score: number;
    expected: number | null;
    correct: number | null;
  }>;
};

test(
  'model comparison',
  async () => {
    if (!judgeAvailable()) {
      console.warn(
        '[model-comparison] No judge key (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) — skipping.',
      );
      return;
    }
    await mkdir(RESULTS_DIR, { recursive: true });
    const records: TrialRecord[] = [];

    // Resume support: if a checkpoint exists, seed the already-completed records
    // and skip those (model|scenario|trial) combos so a crash mid-run is cheap to
    // recover from. Set GITLAB_REVIEW_COMPARE_FRESH=1 to ignore the checkpoint.
    const completed = new Set<string>();
    if (process.env.GITLAB_REVIEW_COMPARE_FRESH !== '1') {
      // Only resume records that belong to the CURRENT run configuration. A
      // checkpoint from a different MODELS/TRIALS/scenario set (e.g. after
      // changing env or toggling smoke mode) would otherwise pollute the report
      // and break the final records.length assertion.
      const modelSet = new Set(MODELS);
      const scenarioSet = new Set(RUN_SCENARIOS.map((s) => s.id));
      try {
        const prior = JSON.parse(
          await readFile(join(RESULTS_DIR, 'model-comparison.json'), 'utf8'),
        ) as {
          records?: TrialRecord[];
        };
        let skipped = 0;
        for (const rec of prior.records ?? []) {
          if (rec.error) continue; // re-run failed trials
          if (
            !modelSet.has(rec.model) ||
            !scenarioSet.has(rec.scenario) ||
            rec.trial < 0 ||
            rec.trial >= TRIALS
          ) {
            skipped++;
            continue; // record is from a different run configuration
          }
          records.push(rec);
          completed.add(recordKey(rec.model, rec.scenario, rec.trial));
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

    // Flat task list across (model, scenario, trial), processed by a bounded
    // worker pool so the ~350-review suite finishes in a reasonable wall time
    // without hammering provider rate limits.
    const tasks: Array<{ model: string; scenario: Scenario; trial: number }> = [];
    for (const model of MODELS)
      for (const scenario of RUN_SCENARIOS)
        for (let trial = 0; trial < TRIALS; trial++) {
          if (completed.has(recordKey(model, scenario.id, trial))) continue;
          tasks.push({ model, scenario, trial });
        }

    const total = tasks.length;
    const concurrency = Number(process.env.GITLAB_REVIEW_COMPARE_CONCURRENCY ?? 4);
    let done = 0;
    let cursor = 0;

    // Checkpoint writes are funnelled through a single-writer queue. Many workers
    // finish concurrently, and unsynchronized writeFile calls to the same path can
    // interleave (corrupting the JSON) or land out of order — an older snapshot
    // overwriting a newer one and dropping completed records. The queue runs one
    // write at a time; each snapshots the latest `records` when it actually runs.
    // A failed write doesn't break the queue, but its own caller still sees the error.
    let checkpointChain: Promise<void> = Promise.resolve();
    function writeCheckpoint(): Promise<void> {
      const run = checkpointChain.then(() =>
        writeFile(
          join(RESULTS_DIR, 'model-comparison.json'),
          JSON.stringify(
            { models: MODELS, trials: TRIALS, scenarios: RUN_SCENARIOS.length, records },
            null,
            2,
          ),
        ),
      );
      checkpointChain = run.catch(() => {});
      return run;
    }

    async function processTask(t: (typeof tasks)[number]): Promise<void> {
      const result = await runOne(t.model, t.scenario);
      const judges: TrialRecord['judges'] = [];
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
        model: t.model,
        scenario: t.scenario.id,
        trial: t.trial,
        error: result.error,
        costTotal: result.cost.total,
        tokensTotal: result.tokens.total,
        judges,
      });
      done++;
      const tag = result.error ? `ERROR ${result.error.slice(0, 60)}` : 'ok';
      console.log(`[${done}/${total}] ${t.model} · ${t.scenario.id} · t${t.trial} → ${tag}`);
      // Checkpoint after every record so a crash mid-run keeps partial data.
      // Serialized via writeCheckpoint so concurrent workers can't interleave
      // writes or overwrite a newer snapshot with an older one.
      await writeCheckpoint();
    }

    async function worker(): Promise<void> {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        await processTask(t);
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    // Flush any checkpoint write still queued behind the last records.
    await checkpointChain;

    // Aggregate per model.
    const md = buildReport(records);
    await writeFile(join(RESULTS_DIR, 'model-comparison.md'), md);
    console.log('\n' + md);
    expect(records.length).toBe(MODELS.length * RUN_SCENARIOS.length * TRIALS);
  },
  4 * 60 * 60 * 1000,
);

function buildReport(records: TrialRecord[]): string {
  const models = [...new Set(records.map((x) => x.model))];
  const cats = ['recall', 'precision', 'format', 'context'] as const;
  const lines: string[] = ['# Model comparison — cost vs accuracy', ''];

  // Overall table.
  lines.push('## Overall', '');
  lines.push('| Model | Accuracy | Cost (total) | $/review | Avg tokens | Errors |');
  lines.push('|---|---|---|---|---|---|');
  for (const m of models) {
    const rs = records.filter((x) => x.model === m);
    const correctness = rs
      .flatMap((x) => x.judges.map((j) => j.correct))
      .filter((c): c is number => c !== null);
    const acc = correctness.length
      ? correctness.reduce((a, b) => a + b, 0) / correctness.length
      : 0;
    const reviews = rs.filter((x) => !x.error);
    const cost = rs.reduce((a, x) => a + x.costTotal, 0);
    const avgTok = reviews.length
      ? Math.round(reviews.reduce((a, x) => a + x.tokensTotal, 0) / reviews.length)
      : 0;
    const perReview = reviews.length ? cost / reviews.length : 0;
    const errors = rs.filter((x) => x.error).length;
    lines.push(
      `| ${m} | ${(acc * 100).toFixed(1)}% | $${cost.toFixed(4)} | $${perReview.toFixed(5)} | ${avgTok.toLocaleString()} | ${errors} |`,
    );
  }

  // Category breakdown.
  lines.push('', '## Accuracy by category', '');
  lines.push('| Model | ' + cats.map((c) => c).join(' | ') + ' |');
  lines.push('|---|' + cats.map(() => '---').join('|') + '|');
  for (const m of models) {
    const rs = records.filter((x) => x.model === m);
    const cells = cats.map((cat) => {
      const cc = rs
        .flatMap((x) => x.judges.filter((j) => j.category === cat).map((j) => j.correct))
        .filter((c): c is number => c !== null);
      return cc.length ? `${((cc.reduce((a, b) => a + b, 0) / cc.length) * 100).toFixed(0)}%` : '—';
    });
    lines.push(`| ${m} | ${cells.join(' | ')} |`);
  }

  // Per-scenario per-judge (accuracy across trials).
  lines.push('', '## Per-scenario judge accuracy (mean across trials)', '');
  const scenarios = [...new Set(records.map((x) => x.scenario))];
  lines.push('| Scenario · Judge (exp) | ' + models.map((m) => shortModel(m)).join(' | ') + ' |');
  lines.push('|---|' + models.map(() => '---').join('|') + '|');
  for (const sc of scenarios) {
    const judgeNames = [
      ...new Set(
        records.filter((x) => x.scenario === sc).flatMap((x) => x.judges.map((j) => j.name)),
      ),
    ];
    for (const jn of judgeNames) {
      const cells = models.map((m) => {
        const js = records
          .filter((x) => x.model === m && x.scenario === sc && !x.error)
          .flatMap((x) => x.judges.filter((j) => j.name === jn));
        if (!js.length) return '—';
        const meanScore = js.reduce((a, j) => a + j.score, 0) / js.length;
        return (meanScore * 100).toFixed(0);
      });
      const exp = records
        .filter((x) => x.scenario === sc)
        .flatMap((x) => x.judges.filter((j) => j.name === jn))[0]?.expected;
      const expTag = exp === null || exp === undefined ? 'diag' : `→${exp}`;
      lines.push(`| ${sc} · ${jn} (${expTag}) | ${cells.join(' | ')} |`);
    }
  }
  lines.push(
    '',
    '_Per-scenario cells are mean raw judge score (%); "exp" is the desired value. Cost is real, computed by pi-ai (cache-aware)._',
  );
  return lines.join('\n');
}

function shortModel(m: string): string {
  return m.split('/').pop() ?? m;
}
