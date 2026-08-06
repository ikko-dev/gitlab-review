/**
 * Shared SWE-PRBench eval helpers: fixture loading, materialized-checkout config,
 * running the reviewer with file access, and a two-part scorer.
 *
 * The scorer is split so a depth×thinking SWEEP stays comparable across cells:
 *   - `triageGold` depends only on (diff, gold comments), NOT on our findings, so
 *     it is computed ONCE per PR and frozen in a cache. Which gold comments are
 *     "real defects" must not drift between cells.
 *   - `matchAndVerdict` depends on our findings, so it runs per review: it maps
 *     each gold to a specific finding index (validated) and labels each finding
 *     CONFIRMED / PLAUSIBLE / FABRICATED.
 */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../src/config.js';
import { resolveProviderApiKey } from '../../src/config.js';
import { runReview } from '../../src/gitlab-review.js';
import { parseReviewMarkdownWithWarnings } from '../../src/parser.js';
import type { ReviewDepth, ThinkingLevel } from '../../src/types.js';
import { judgeRaw } from './review-suite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = join(HERE, 'fixtures', 'swe-prbench', 'tsjs-subset.jsonl');
export const REPOS = join(HERE, 'fixtures', 'swe-prbench', 'repos');
export const RESULTS_DIR = join(HERE, '..', '..', 'test-results');
export const TRIAGE_CACHE = join(RESULTS_DIR, 'swe-prbench-triage.json');

export type GoldComment = {
  author: string;
  body: string;
  path: string;
  line: number | null;
  diffHunk: string;
};

export type Instance = {
  task_id: string;
  repo: string;
  pr_url: string;
  language: string;
  pr_type: string;
  difficulty: string;
  rvs_score: number;
  title: string;
  description: string;
  diff_patch: string;
  gold_comments_code: GoldComment[];
};

export type OurFinding = { file: string; line: number; severity: string; body: string };

export type ReviewKnobs = { model: string; depth: ReviewDepth; thinking: ThinkingLevel };

export type ReviewOut = {
  findings: OurFinding[];
  costTotal: number;
  tokensTotal: number;
  latencyMs: number;
  error?: string;
};

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function repoDirFor(taskId: string): string {
  return join(REPOS, taskId);
}

export async function isMaterialized(taskId: string): Promise<boolean> {
  return exists(join(repoDirFor(taskId), '.materialized'));
}

export async function loadInstances(
  opts: { only?: string; limit?: number } = {},
): Promise<Instance[]> {
  const raw = await readFile(FIXTURE, 'utf8');
  let all = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Instance);
  if (opts.only) {
    const set = new Set(opts.only.split(','));
    all = all.filter((i) => set.has(i.task_id));
  }
  return opts.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all;
}

function makeConfig(knobs: ReviewKnobs, repoDir: string, outDir: string): Config {
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
    model: knobs.model,
    modelPool: [],
    minSeverity: 'info',
    thinkingLevel: knobs.thinking,
    verifyModel: '',
    postingMode: 'direct',
    reviewDepth: knobs.depth,
    apiKey: resolveProviderApiKey(knobs.model),
    baseUrl: '',
    maxTokens: Number(process.env.GITLAB_REVIEW_MAX_TOKENS ?? 0),
    reviewFile: join(outDir, 'gitlab-review.md'),
    output: join(outDir, 'review-comments.json'),
    maxDiffChars: 0,
    decomposeHintLines: 0,
    diffContext: 0,
    retrieveSkipped: false,
    dryRun: true,
    noPost: true,
    postSummary: false,
    forceReview: false,
    verbose: false,
    cwd: repoDir,
    skills: ['code-review'],
    marketplaces: [],
    refreshGitSkills: false,
  };
}

export async function runReviewer(
  inst: Instance,
  repoDir: string,
  knobs: ReviewKnobs,
): Promise<ReviewOut> {
  const outDir = await mkdtemp(join(tmpdir(), 'swepr-out-'));
  const started = Date.now();
  try {
    const config = makeConfig(knobs, repoDir, outDir);
    const usage = await runReview(config, {
      diff: inst.diff_patch,
      intent: { title: inst.title, description: inst.description },
    });
    const parsed = parseReviewMarkdownWithWarnings(await readFile(config.reviewFile, 'utf8'));
    return {
      latencyMs: Date.now() - started,
      costTotal: usage.cost.total,
      tokensTotal: usage.tokens.total,
      findings: parsed.comments.map((c) => ({
        file: c.file,
        line: c.line,
        severity: c.severity,
        body: c.body,
      })),
    };
  } catch (err) {
    return {
      latencyMs: Date.now() - started,
      costTotal: 0,
      tokensTotal: 0,
      findings: [],
      error: (err as Error).message,
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function renderGold(gold: GoldComment[]): string {
  return gold
    .map((c, i) => `[gold ${i}] ${c.path}:${c.line ?? '?'}\n${c.body.trim()}`)
    .join('\n\n');
}

function renderFindings(f: OurFinding[]): string {
  if (!f.length) return '(no findings)';
  return f
    .map((c, i) => `[finding ${i}] (${c.severity}) ${c.file}:${c.line}\n${c.body.trim()}`)
    .join('\n\n');
}

function clampDiff(diff: string): string {
  return diff.length > 24000 ? diff.slice(0, 24000) + '\n…[truncated]' : diff;
}

// --- Triage (frozen per PR) -------------------------------------------------
const TRIAGE_SYSTEM = [
  'You classify human code-review comments. For each gold comment decide is_defect:',
  '  true  = it identifies a concrete CODE DEFECT (bug, wrong logic, missing check, race,',
  '          security hole, data loss, crash, broken behaviour).',
  '  false = it is a style/naming/formatting/refactor SUGGESTION, a QUESTION, a conversational',
  '          reply, a changelog/doc wording note, or otherwise not a concrete defect.',
  'Return ONE JSON object, nothing else: {"gold":[{"i":0,"is_defect":true}]}',
].join('\n');

export type TriageEntry = { i: number; is_defect: boolean };

export async function triageGold(inst: Instance): Promise<TriageEntry[]> {
  const user = [
    '<diff>',
    clampDiff(inst.diff_patch),
    '</diff>',
    '',
    '<gold_comments>',
    renderGold(inst.gold_comments_code),
    '</gold_comments>',
    '',
    'Return the JSON now.',
  ].join('\n');
  const text = await judgeRaw(TRIAGE_SYSTEM, user, 1500);
  const m = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!m) return inst.gold_comments_code.map((_, i) => ({ i, is_defect: false }));
  try {
    const parsed = JSON.parse(m[0]) as { gold?: TriageEntry[] };
    return parsed.gold ?? [];
  } catch {
    return inst.gold_comments_code.map((_, i) => ({ i, is_defect: false }));
  }
}

// --- Match + verdict (per review) -------------------------------------------
const MATCH_SYSTEM = [
  'You evaluate an automated code review against a PR. You are given the diff, the human gold',
  'comments, and the automated reviewer findings. Do TWO things, return ONE JSON object only.',
  '',
  '1. MATCH. For each gold comment set matched_finding_index to the index of the reviewer finding',
  '   about the SAME underlying issue at ~the same location (same file, overlapping lines or same',
  '   symbol) and semantically equivalent — or null if none matches. Different file, or different',
  '   issue in the same file, does NOT count. If there are no findings, all indices MUST be null.',
  '',
  '2. VERDICT. For each reviewer finding classify:',
  '   CONFIRMED  = a real issue clearly supported by the diff.',
  '   PLAUSIBLE  = defensible but not clearly provable from the diff alone.',
  '   FABRICATED = references code not present in the diff, or makes a factually incorrect claim.',
  '',
  'Return: {"gold":[{"i":0,"matched_finding_index":null}],"findings":[{"i":0,"verdict":"CONFIRMED"}]}',
].join('\n');

export type MatchResult = {
  gold: Array<{ i: number; matched_finding_index: number | null }>;
  findings: Array<{ i: number; verdict: 'CONFIRMED' | 'PLAUSIBLE' | 'FABRICATED' }>;
};

export async function matchAndVerdict(
  inst: Instance,
  findings: OurFinding[],
): Promise<MatchResult | null> {
  const user = [
    '<diff>',
    clampDiff(inst.diff_patch),
    '</diff>',
    '',
    '<gold_comments>',
    renderGold(inst.gold_comments_code),
    '</gold_comments>',
    '',
    '<reviewer_findings>',
    renderFindings(findings),
    '</reviewer_findings>',
    '',
    'Return the JSON now.',
  ].join('\n');
  const text = await judgeRaw(MATCH_SYSTEM, user, 3000);
  const m = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as MatchResult;
  } catch {
    return null;
  }
}

/** A gold comment counts as matched only if the scorer points at a real finding index. */
export function validMatch(idx: number | null | undefined, numFindings: number): boolean {
  return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < numFindings;
}

// --- Triage cache -----------------------------------------------------------
export async function loadTriageCache(): Promise<Record<string, TriageEntry[]>> {
  try {
    return JSON.parse(await readFile(TRIAGE_CACHE, 'utf8')) as Record<string, TriageEntry[]>;
  } catch {
    return {};
  }
}
