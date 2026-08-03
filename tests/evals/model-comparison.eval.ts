/**
 * Model comparison runner (not a pass/fail eval — a measurement harness).
 *
 * Runs the full review-eval fixture suite across several models and records,
 * per (model, scenario, trial):
 *   - each judge's score (LLM judges + code judges, mirroring review.eval.ts)
 *   - whether the score matched the *expected* value (correctness)
 *   - real token usage and real cost (computed by pi-ai, cache-aware)
 *
 * It then aggregates per-model accuracy and cost and writes:
 *   - test-results/model-comparison.json   (raw + aggregates)
 *   - test-results/model-comparison.md      (human-readable comparison)
 *
 * Reviewer model is set per row; the API key is resolved per-provider via
 * resolveProviderApiKey (so GPT-via-Cloudflare-gateway uses CLOUDFLARE_API_KEY,
 * Anthropic uses ANTHROPIC_API_KEY). The LLM judge always runs on Anthropic
 * (claude-haiku-4-5) so grading is fair and independent of the model under test.
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
 * comparison), or fix the model and run twice at different efforts. Useful for
 * cost/quality trade-offs like "advanced model at low effort" vs "cheaper model
 * at high effort".
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
import type { PriorThread } from '../../src/prior-threads.js';
import type { ReviewDepth, ThinkingLevel } from '../../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const RESULTS_DIR = join(HERE, '..', '..', 'test-results');

/** Resume checkpoint key for a single (model, scenario, trial) combination. */
const recordKey = (m: string, s: string, t: number): string => `${m}|${s}|${t}`;

type ReviewComment = {
  file: string;
  line: number;
  side: string;
  severity: 'critical' | 'warn' | 'info';
  confidence: string;
  body: string;
};

type ReviewResult = {
  summary: string;
  comments: ReviewComment[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  error?: string;
};

// ---------------------------------------------------------------------------
// LLM judge — replicates tests/evals/llm-judge.ts (Anthropic, fixed model).
// ---------------------------------------------------------------------------
const JUDGE_MODEL = process.env.GITLAB_REVIEW_EVAL_JUDGE_MODEL ?? 'claude-haiku-4-5-20251001';
const JUDGE_BASE_URL = process.env.GITLAB_REVIEW_EVAL_JUDGE_BASE_URL ?? 'https://api.anthropic.com';

function judgeApiKey(): string {
  return (
    process.env.GITLAB_REVIEW_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    ''
  );
}

const JUDGE_SYSTEM = [
  'You are an evaluator of automated code reviews. Apply the rubric strictly:',
  'do not award credit for tangential mentions, vague concerns, or unrelated findings.',
  'Return a single JSON object with this exact shape, and nothing else:',
  '',
  '{"score": 0 | 1, "rationale": "<one short sentence>"}',
  '',
  'score=1 ONLY when the review clearly satisfies the rubric.',
  'score=0 when the review misses, is ambiguous about, or only tangentially touches the target.',
].join('\n');

function renderReview(r: ReviewResult): string {
  const lines = r.comments.map(
    (c, i) => `${i + 1}. [${c.severity.toUpperCase()}] ${c.file}:${c.line}\n${c.body}`,
  );
  return [
    '<summary>',
    r.summary || '(empty)',
    '</summary>',
    '',
    '<inline_comments>',
    lines.length > 0 ? lines.join('\n\n') : '(no inline comments)',
    '</inline_comments>',
  ].join('\n');
}

async function llmJudge(rubric: string, r: ReviewResult): Promise<0 | 1> {
  const apiKey = judgeApiKey();
  if (!apiKey) throw new Error('LLM judge requires ANTHROPIC_API_KEY in env');
  const userPrompt = [
    'Evaluate the automated code review below against the rubric.',
    '',
    '<rubric>',
    rubric,
    '</rubric>',
    '',
    '<review>',
    renderReview(r),
    '</review>',
    '',
    'Return the JSON verdict now.',
  ].join('\n');
  const res = await fetch(`${JUDGE_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 512,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`judge ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')
    .trim();
  const objMatch = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!objMatch) return 0;
  try {
    const parsed = JSON.parse(objMatch[0]) as { score?: unknown };
    return parsed.score === 1 || parsed.score === '1' || parsed.score === true ? 1 : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Code judges (deterministic) — mirror review.eval.ts.
// ---------------------------------------------------------------------------
function severe(r: ReviewResult): ReviewComment[] {
  return r.comments.filter((c) => c.severity === 'critical' || c.severity === 'warn');
}

const ALLOWED_LABELS = [
  'issue',
  'suggestion',
  'nitpick',
  'question',
  'todo',
  'chore',
  'note',
  'thought',
];
const CONVENTIONAL_RE = new RegExp(
  String.raw`^\s*(${ALLOWED_LABELS.join('|')})(\s+\((?:blocking|non-blocking|if-minor)\))?:\s+\S`,
);

const codeJudge: Record<string, (r: ReviewResult) => 0 | 1> = {
  HasSevereFinding: (r) => (severe(r).length > 0 ? 1 : 0),
  NoSevereFindings: (r) => (severe(r).length === 0 ? 1 : 0),
  EmptyCatchFlagged: (r) => {
    const kw = [
      'catch',
      'swallow',
      'suppress',
      'silent',
      'empty',
      'ignore',
      'unhandled',
      'error handling',
      'lost',
    ];
    const t = severe(r)
      .map((c) => c.body)
      .join(' ')
      .toLowerCase();
    return kw.some((k) => t.includes(k)) ? 1 : 0;
  },
  CommitContextSurfaced: (r) => {
    const kw = [
      'adr-042',
      'adr 042',
      'inc-2891',
      'inc 2891',
      'post-mortem',
      'postmortem',
      'pagerduty',
      'dead-letter',
      'dead letter',
      'non-actionable',
      'signed off',
    ];
    const t = [r.summary, ...r.comments.map((c) => c.body)].join(' ').toLowerCase();
    return kw.some((k) => t.includes(k)) ? 1 : 0;
  },
  PriorThreadContextSurfaced: (r) => {
    const kw = [
      'vpn',
      'ingress',
      'subnet',
      'network layer',
      'network-level',
      'infrastructure level',
      '10.',
      'internal network',
    ];
    const t = [r.summary, ...r.comments.map((c) => c.body)].join(' ').toLowerCase();
    return kw.some((k) => t.includes(k)) ? 1 : 0;
  },
  ConventionalCommentFormat: (r) => {
    if (r.comments.length === 0) return 1;
    for (const c of r.comments) {
      const first = c.body.split('\n', 1)[0] ?? '';
      const m = first.match(CONVENTIONAL_RE);
      if (!m) return 0;
      const label = m[1];
      const decoration = (m[2] ?? '').trim();
      if (c.severity === 'critical' && !(label === 'issue' && decoration === '(blocking)'))
        return 0;
      if (c.severity === 'warn' && !(label === 'issue' && decoration === '')) return 0;
      if (c.severity === 'info' && label === 'issue') return 0;
    }
    return 1;
  },
  SummarySkeleton: (r) => {
    const hasRisk = /^\*\*Risk:\s+(Low|Medium|High)\b/m.test(r.summary);
    const hasIssues = /^\*\*\d+\s+issues?\s+found:\*\*/im.test(r.summary);
    const clean = r.comments.length === 0;
    return hasRisk && (clean ? !hasIssues : hasIssues) ? 1 : 0;
  },
  NoDuplication: (r) => {
    if (r.comments.length === 0) return 1;
    for (const c of r.comments) {
      const nl = c.body.indexOf('\n');
      if (nl === -1) continue;
      const discussion = c.body.slice(nl + 1).trim();
      if (!discussion) continue;
      const cleaned = discussion.replace(/^[`*\s>]+/, '').trim();
      const sentence = cleaned.split(/[.!?]\s|\n/)[0]?.trim() ?? '';
      if (sentence.length < 40) continue;
      if (r.summary.includes(sentence)) return 0;
    }
    return 1;
  },
};

// LLM rubrics (verbatim from review.eval.ts).
const RUBRICS = {
  AsyncBugDetected:
    'The review must clearly identify that calling Array.prototype.forEach with an async callback is a bug — either because the returned promises are not awaited, errors are swallowed, or callers cannot observe completion. A bare mention of "promise" or "async" without explaining the forEach-specific problem does NOT pass.',
  StaleClosure:
    'The review must clearly identify a React stale-closure bug: a useEffect (or similar hook) that reads a value but omits it from the dependency array, so the effect captures the stale initial value. A generic warning about "missing dependencies" without explaining the resulting incorrect behaviour does NOT pass.',
  RaceCondition:
    'The review must clearly identify that two concurrent requests can both succeed in claiming the same promo code because the read-then-write sequence is not atomic. Equivalent framings (race condition, non-atomic update, missing row lock, missing transaction, TOCTOU) all count. A vague suggestion to "use a transaction" without naming the race does NOT pass.',
  GlobalCacheBug:
    "The review must clearly identify that a module-level / shared cache is missing a per-user key, so the first user's cached value is returned to every subsequent user. Calling out cross-user leakage, shared state, or that the cache should be keyed by userId all count. A general comment about caching strategy without the cross-user defect does NOT pass.",
  HonestRefusal:
    'Every CRITICAL or WARN finding in the review must point to a real, reproducible defect supported by the diff. Score 0 if any severe finding is speculative ("could potentially..."), stylistic, contradicted by an in-file comment that justifies the pattern, or based on external context not visible in the diff. Score 1 if there are no severe findings OR if every severe finding identifies a concrete defect with observable impact. INFO-level nits and suggestions are out of scope — only judge CRITICAL and WARN.',
  NoFabricatedTypo:
    'Every identifier in this diff is spelled correctly and used consistently. Score 0 if the review contains ANY finding (at any severity) claiming a typo, a misspelled or wrong identifier, a missing/duplicated/wrong character, or incorrect casing — such a finding is necessarily fabricated because the code is correctly spelled. A finding only escapes this if it quotes a token verbatim AND that exact token genuinely appears misspelled in the diff (it does not, so any such claim fails). Score 1 if the review makes no literal-text/spelling claims, or only discusses real semantic concerns. INFO-level non-spelling nits are fine.',
  AuthConcernRaised:
    'The review must raise missing authentication / authorization / access control as a CRITICAL or WARN concern (not just an INFO suggestion). Score=1 only if at least one CRITICAL- or WARN-severity finding clearly flags the lack of auth. INFO-level mentions, suggestions to "consider adding auth", or summary-only remarks without a severe inline finding do NOT pass.',
  NullDereferenceFlagged:
    'The review must flag a concrete null / undefined dereference as CRITICAL or WARN: an optional field (e.g. typed as `Product | undefined`) being accessed without a null check, which will throw a TypeError at runtime. INFO-level suggestions, generic type-safety nits, or a vague mention without identifying the actual unguarded access do NOT pass.',
} as const;

// ---------------------------------------------------------------------------
// Judge spec: name, kind (llm/code), and the *expected* score for THIS scenario.
//   expected: 1 | 0  -> counts toward accuracy (correct = score === expected)
//   expected: null   -> diagnostic only (recorded, excluded from accuracy)
// `category` groups judges for the breakdown table.
// ---------------------------------------------------------------------------
type JudgeSpec = {
  name: string;
  kind: 'llm' | 'code';
  expected: 0 | 1 | null;
  category: 'recall' | 'precision' | 'format' | 'context';
};

type Scenario = {
  id: string;
  fixture: string;
  commitLog?: string;
  priorThreads?: PriorThread[];
  skills: string[];
  reviewDepth?: ReviewDepth;
  judges: JudgeSpec[];
};

const r = (
  name: JudgeSpec['name'],
  category: JudgeSpec['category'],
  expected: 0 | 1 | null,
): JudgeSpec => ({
  name,
  kind: name in RUBRICS ? 'llm' : 'code',
  expected,
  category,
});

const SCENARIOS: Scenario[] = [
  // --- bug detection (skill) ---
  {
    id: 'async-foreach/skill',
    fixture: 'async-foreach-bug.diff',
    skills: ['code-review'],
    judges: [r('AsyncBugDetected', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  {
    id: 'async-foreach/baseline',
    fixture: 'async-foreach-bug.diff',
    skills: [],
    judges: [r('AsyncBugDetected', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  {
    id: 'react-stale/skill',
    fixture: 'react-stale-deps.diff',
    skills: ['code-review'],
    judges: [r('StaleClosure', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  {
    id: 'react-stale/baseline',
    fixture: 'react-stale-deps.diff',
    skills: [],
    judges: [r('StaleClosure', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  {
    id: 'php-race/skill',
    fixture: 'php-promo-race.diff',
    skills: ['code-review'],
    judges: [r('RaceCondition', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  {
    id: 'php-race/baseline',
    fixture: 'php-promo-race.diff',
    skills: [],
    judges: [r('RaceCondition', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  // --- patch-format variants ---
  {
    id: 'async-foreach/patch',
    fixture: 'async-foreach-bug.patch',
    skills: [],
    judges: [r('AsyncBugDetected', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  {
    id: 'php-race/patch',
    fixture: 'php-promo-race.patch',
    skills: [],
    judges: [r('RaceCondition', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  {
    id: 'react-stale/patch',
    fixture: 'react-stale-deps.patch',
    skills: [],
    judges: [r('StaleClosure', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  // --- global cache (flat ambiguous vs patch obvious) ---
  {
    id: 'global-cache/flat',
    fixture: 'global-cache-bug.diff',
    skills: [],
    judges: [r('GlobalCacheBug', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  {
    id: 'global-cache/patch',
    fixture: 'global-cache-bug.patch',
    skills: [],
    judges: [r('GlobalCacheBug', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
  // --- commit-context: intentional empty catch ---
  {
    id: 'empty-catch/flat',
    fixture: 'analytics-fire-and-forget.diff',
    skills: [],
    // flat diff: no context, flagging the pattern as suspicious is correct
    judges: [r('EmptyCatchFlagged', 'precision', 1), r('CommitContextSurfaced', 'context', 0)],
  },
  {
    id: 'empty-catch/commitlog',
    fixture: 'analytics-fire-and-forget.diff',
    commitLog: 'analytics-fire-and-forget.commitlog',
    skills: [],
    // with ADR/INC context: should NOT over-flag, SHOULD surface the context
    judges: [r('EmptyCatchFlagged', 'precision', 0), r('CommitContextSurfaced', 'context', 1)],
  },
  {
    id: 'empty-catch/patch',
    fixture: 'analytics-fire-and-forget.patch',
    skills: [],
    // commit header in diff slot — diagnostic only (model may read it as noise)
    judges: [
      r('EmptyCatchFlagged', 'precision', null),
      r('CommitContextSurfaced', 'context', null),
    ],
  },
  // --- false-positive rate (clean code) ---
  {
    id: 'clean-ts/skill',
    fixture: 'clean-ts.diff',
    skills: ['code-review'],
    judges: [r('NoSevereFindings', 'precision', 1)],
  },
  {
    id: 'clean-ts/baseline',
    fixture: 'clean-ts.diff',
    skills: [],
    judges: [r('NoSevereFindings', 'precision', 1)],
  },
  // --- honesty (suspicious-but-justified) ---
  {
    id: 'justified/skill',
    fixture: 'justified-intentional.diff',
    skills: ['code-review'],
    judges: [r('HonestRefusal', 'precision', 1), r('NoSevereFindings', 'precision', 1)],
  },
  {
    id: 'justified/baseline',
    fixture: 'justified-intentional.diff',
    skills: [],
    judges: [r('HonestRefusal', 'precision', 1), r('NoSevereFindings', 'precision', 1)],
  },
  // --- literal-text grounding (typo bait) ---
  {
    id: 'typo-bait/skill',
    fixture: 'literal-text-typo-bait.diff',
    skills: ['code-review'],
    judges: [r('NoFabricatedTypo', 'precision', 1)],
  },
  {
    id: 'typo-bait/baseline',
    fixture: 'literal-text-typo-bait.diff',
    skills: [],
    judges: [r('NoFabricatedTypo', 'precision', 1)],
  },
  // --- output format ---
  {
    id: 'format/async-foreach',
    fixture: 'async-foreach-bug.diff',
    skills: ['code-review'],
    judges: [
      r('ConventionalCommentFormat', 'format', 1),
      r('SummarySkeleton', 'format', 1),
      r('NoDuplication', 'format', 1),
    ],
  },
  {
    id: 'format/clean',
    fixture: 'clean-ts.diff',
    skills: ['code-review'],
    judges: [
      r('ConventionalCommentFormat', 'format', 1),
      r('SummarySkeleton', 'format', 1),
      r('NoDuplication', 'format', 1),
    ],
  },
  // --- prior review feedback ---
  {
    id: 'admin-auth/no-prior',
    fixture: 'admin-config-endpoint.diff',
    skills: [],
    judges: [r('AuthConcernRaised', 'recall', 1)],
  },
  {
    id: 'admin-auth/with-prior',
    fixture: 'admin-config-endpoint.diff',
    skills: [],
    priorThreads: [
      {
        file: 'src/routes/admin.ts',
        line: 8,
        resolved: false,
        botComment:
          '/admin/config exposes environment variables, database hosts, and integration URLs without any authentication middleware. Any unauthenticated caller with network access can read this data or toggle feature flags via /admin/features/:flag.',
        replies: [
          'These routes are only reachable from inside our private VPN. The ingress controller restricts access to the 10.32.0.0/14 subnet — requests from the public internet never reach the application layer. Application-level auth would be redundant here and adds latency to internal tooling.',
        ],
      },
    ],
    // with a concrete justification: should stop re-raising auth, should surface context
    judges: [r('AuthConcernRaised', 'precision', 0), r('PriorThreadContextSurfaced', 'context', 1)],
  },
  {
    id: 'null-deref/no-prior',
    fixture: 'null-deref-vague-dismissal.diff',
    skills: [],
    judges: [r('NullDereferenceFlagged', 'recall', 1)],
  },
  {
    id: 'null-deref/vague-prior',
    fixture: 'null-deref-vague-dismissal.diff',
    skills: [],
    priorThreads: [
      {
        file: 'src/billing/invoice.ts',
        line: 14,
        resolved: false,
        botComment:
          'item.product is declared as optional (Product | undefined). Accessing item.product.name and item.product.unitPrice without a null check will throw a TypeError at runtime when product is undefined.',
        replies: ["We've never seen this throw in production."],
      },
    ],
    // vague dismissal must NOT suppress a provable bug
    judges: [r('NullDereferenceFlagged', 'recall', 1)],
  },
  // --- verify depth (precision under adversarial re-check) ---
  {
    id: 'justified/verify',
    fixture: 'justified-intentional.diff',
    skills: ['code-review'],
    reviewDepth: 'verify',
    judges: [r('HonestRefusal', 'precision', 1), r('NoSevereFindings', 'precision', 1)],
  },
  {
    id: 'async-foreach/verify',
    fixture: 'async-foreach-bug.diff',
    skills: ['code-review'],
    reviewDepth: 'verify',
    judges: [r('AsyncBugDetected', 'recall', 1), r('HasSevereFinding', 'recall', 1)],
  },
];

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
    if (!judgeApiKey()) {
      console.warn('[model-comparison] No ANTHROPIC_API_KEY — skipping.');
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
    '_Per-scenario cells are mean raw judge score (%); "exp" is the desired value. Cost is real, computed by pi-ai (cache-aware). Sonnet baseline runs direct on Anthropic; GPT models run direct via the OpenAI provider (pi-ai\'s Cloudflare-gateway registry lacks the nano/mini IDs; routing does not change accuracy or per-token cost)._',
  );
  return lines.join('\n');
}

function shortModel(m: string): string {
  return m.split('/').pop() ?? m;
}
