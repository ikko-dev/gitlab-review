/**
 * Shared review-eval suite: scenarios, judges, rubrics, and a transport-aware
 * LLM judge. Consumed by the measurement harnesses (`model-comparison.eval.ts`,
 * `depth-thinking-sweep.eval.ts`) so the fixture set and grading stay in lockstep
 * across every comparison axis (model, depth, thinking level).
 *
 * The judge picks its transport from the environment:
 *   - an Anthropic key (GITLAB_REVIEW_API_KEY / ANTHROPIC_API_KEY / CLAUDE_API_KEY)
 *     → Messages API on api.anthropic.com (claude-haiku-4.5)
 *   - else OPENROUTER_API_KEY → OpenRouter chat-completions (anthropic/claude-haiku-4.5)
 * Either way the judge is a Claude model, independent of the model under test.
 */
import type { PriorThread } from '../../src/prior-threads.js';
import type { ReviewDepth } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Result shape produced by a single review run.
// ---------------------------------------------------------------------------
export type ReviewComment = {
  file: string;
  line: number;
  side: string;
  severity: 'critical' | 'warn' | 'info';
  confidence: string;
  body: string;
};

export type ReviewResult = {
  summary: string;
  comments: ReviewComment[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  error?: string;
};

// ---------------------------------------------------------------------------
// Transport-aware LLM judge.
// ---------------------------------------------------------------------------
type JudgeTransport = {
  provider: 'anthropic' | 'openrouter';
  model: string;
  baseUrl: string;
  apiKey: string;
};

/**
 * Resolve the judge transport from the environment. Prefers a real Anthropic key
 * (matches the original harness exactly); otherwise falls back to OpenRouter,
 * which every dev box here already has a key for. Returns null when neither is
 * available, so callers can skip gracefully.
 */
export function resolveJudgeTransport(): JudgeTransport | null {
  const anthropicKey =
    process.env.GITLAB_REVIEW_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    '';
  if (anthropicKey) {
    return {
      provider: 'anthropic',
      model: process.env.GITLAB_REVIEW_EVAL_JUDGE_MODEL ?? 'claude-haiku-4-5-20251001',
      baseUrl: process.env.GITLAB_REVIEW_EVAL_JUDGE_BASE_URL ?? 'https://api.anthropic.com',
      apiKey: anthropicKey,
    };
  }
  const openrouterKey = process.env.OPENROUTER_API_KEY || '';
  if (openrouterKey) {
    return {
      provider: 'openrouter',
      model: process.env.GITLAB_REVIEW_EVAL_JUDGE_MODEL ?? 'anthropic/claude-haiku-4.5',
      baseUrl: process.env.GITLAB_REVIEW_EVAL_JUDGE_BASE_URL ?? 'https://openrouter.ai/api/v1',
      apiKey: openrouterKey,
    };
  }
  return null;
}

export function judgeAvailable(): boolean {
  return resolveJudgeTransport() !== null;
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

export function renderReview(r: ReviewResult): string {
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

function extractVerdict(text: string): 0 | 1 {
  const objMatch = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!objMatch) return 0;
  try {
    const parsed = JSON.parse(objMatch[0]) as { score?: unknown };
    return parsed.score === 1 || parsed.score === '1' || parsed.score === true ? 1 : 0;
  } catch {
    return 0;
  }
}

async function judgeAnthropic(
  t: JudgeTransport,
  system: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(`${t.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': t.apiKey,
    },
    body: JSON.stringify({
      model: t.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`judge ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')
    .trim();
}

async function judgeOpenRouter(
  t: JudgeTransport,
  system: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch(`${t.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${t.apiKey}`,
    },
    body: JSON.stringify({
      model: t.model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`judge ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

/**
 * Low-level judge call: send a system+user prompt to the resolved Claude judge
 * (Anthropic or OpenRouter transport) and return the raw response text. Shared by
 * the 0/1 rubric judge and richer JSON-scoring harnesses (e.g. SWE-PRBench).
 */
export async function judgeRaw(system: string, user: string, maxTokens = 512): Promise<string> {
  const t = resolveJudgeTransport();
  if (!t) throw new Error('LLM judge requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY in env');
  return t.provider === 'anthropic'
    ? judgeAnthropic(t, system, user, maxTokens)
    : judgeOpenRouter(t, system, user, maxTokens);
}

export async function llmJudge(rubric: string, r: ReviewResult): Promise<0 | 1> {
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
  return extractVerdict(await judgeRaw(JUDGE_SYSTEM, userPrompt));
}

// ---------------------------------------------------------------------------
// Code judges (deterministic) — no LLM needed.
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

export const codeJudge: Record<string, (r: ReviewResult) => 0 | 1> = {
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

// ---------------------------------------------------------------------------
// LLM rubrics.
// ---------------------------------------------------------------------------
export const RUBRICS = {
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
// Judge spec + scenario definitions.
//   expected: 1 | 0  -> counts toward accuracy (correct = score === expected)
//   expected: null   -> diagnostic only (recorded, excluded from accuracy)
// ---------------------------------------------------------------------------
export type JudgeSpec = {
  name: string;
  kind: 'llm' | 'code';
  expected: 0 | 1 | null;
  category: 'recall' | 'precision' | 'format' | 'context';
};

export type Scenario = {
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

export const SCENARIOS: Scenario[] = [
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
