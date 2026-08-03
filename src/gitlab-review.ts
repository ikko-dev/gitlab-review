import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { createReadOnlyTools } from '@earendil-works/pi-coding-agent';
import type { Config } from './config.js';
import { resolveProviderApiKey } from './config.js';
import { formatError, isQuotaExceededMessage, ReviewerError } from './errors.js';
import { createGitTools } from './git-tool.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';
import type { MarketplaceRef } from './marketplaces.js';
import { buildMarketplaceRegistry, loadMarketplaceSkill } from './marketplaces.js';
import { parseReviewMarkdownWithWarnings } from './parser.js';
import type { PriorThread } from './prior-threads.js';
import { renderPriorThreadsBlock } from './prior-threads.js';
import type { Skill } from './skills.js';
import { loadAutoDiscoveredSkills, loadNamedSkill, parseSkillSpec } from './skills.js';
import {
  cleanupSkippedDiffs,
  renderRetrievableSkippedBlock,
  type SkippedDiffFile,
  writeSkippedDiffs,
} from './skipped-retrieval.js';
import { REVIEW_ANGLES, triageFindings, type AuthoredFinding, type ReviewAngle } from './triage.js';
import type { GitLabReviewSeverity, SizeSkippedFile, ThinkingLevel } from './types.js';
import { splitModel, toGitLabReviewSeverity } from './types.js';
import {
  applyVerdicts,
  buildVerifySystemPrompt,
  buildVerifyUserPrompt,
  parseVerdict,
  synthesizeReviewJson,
  type Verdict,
} from './verify.js';

export interface UsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * MR size signals derived from the reviewed diff: files dropped for exceeding
 * the char budget, and an optional "this MR is too big — decompose it" hint when
 * the reviewed changed-line count crosses the configured threshold.
 */
export interface ReviewSizeNotice {
  sizeSkippedFiles: SizeSkippedFile[];
  decomposeHint?: { lines: number; threshold: number };
  /**
   * Diff coverage when files were dropped for the char budget: how many changed
   * lines were actually reviewed vs the total. Present only when something was
   * size-skipped, so a partial review reports its coverage instead of reading as
   * a confident full review.
   */
  coverage?: { reviewedLines: number; totalLines: number };
  /**
   * True when the size-dropped diffs were staged on disk for on-demand retrieval
   * (retrieval mode). The summary callout then frames them as staged-and-readable
   * rather than lost, and defers the read/not-read account to the reviewer.
   */
  retrieved?: boolean;
}

/** Token and cost usage attributed to a single pool member. */
export interface ModelUsage {
  model: string;
  tokens: UsageBreakdown;
  cost: UsageBreakdown;
}

export interface ReviewUsage {
  model: string;
  /** Reasoning effort the main agent ran at, surfaced alongside the model in the footer. */
  thinkingLevel: ThinkingLevel;
  tokens: UsageBreakdown;
  cost: UsageBreakdown;
  /**
   * Per-pool-member usage breakdown for heterogeneous `full`-depth runs. Each
   * entry attributes the tokens/cost of the agents that ran on that pool member.
   * The top-level `model`/`tokens`/`cost` stay the main model and the totals (the
   * sum of all entries). Present only when more than one distinct model ran; the
   * single-model path leaves it undefined so output is byte-identical to before.
   */
  byModel?: ModelUsage[];
  skills: string[];
  /**
   * Size signals for surfacing in the MR summary. `sizeSkippedFiles` lists files
   * dropped for the char budget; `decomposeHint` is set when the reviewed diff is
   * past the configured line threshold. Both feed the prominent summary callout.
   */
  sizeNotice: ReviewSizeNotice;
}

export interface AgentLike {
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  prompt(input: string): Promise<void>;
}

export interface CreateAgentParams {
  systemPrompt: string;
  model: Model<string>;
  tools: AgentTool[];
  thinkingLevel: ThinkingLevel;
  getApiKey: () => Promise<string>;
}

export type CreateAgent = (params: CreateAgentParams) => AgentLike;

export interface RunReviewOptions {
  cwd?: string;
  diff: string;
  /**
   * Commit messages for all non-merge commits in the MR (merge-base…HEAD),
   * in chronological order. When provided, a `<commits>` section is prepended
   * to the user prompt so the reviewer understands the intent behind each change.
   * Produced by `getMergeCommitLog` in `src/git.ts`.
   */
  commitLog?: string;
  createAgent?: CreateAgent;
  timeoutMs?: number;
  logger?: Logger;
  /**
   * Prior developer replies to bot-posted review threads on the MR.
   * When provided, a `<prior_review_feedback>` section is appended to the user
   * prompt after `<diff>` so the reviewer can avoid re-raising already-acknowledged
   * concerns and can provide contextual follow-up.
   * Produced by `extractPriorThreads` in `src/prior-threads.ts`.
   */
  priorThreads?: PriorThread[];
  /**
   * Author-declared intent for the MR (title + description). When present and
   * non-empty, an `<intent>` block is prepended to the user prompt so the
   * reviewer can check the diff against the stated purpose and flag code/intent
   * mismatches. A missing or empty description degrades gracefully (no block).
   * Sourced from the GitLab MR via `getMergeRequest` in `src/gitlab.ts`.
   */
  intent?: ReviewIntent;
  /**
   * Called with the agent after it is created, before the first prompt.
   * Use this to attach telemetry (e.g. `otelBridge.createAgentTelemetry(runId)`).
   * The returned function, if any, is called after the review completes.
   */
  attachTelemetry?: (agent: AgentLike) => (() => void) | undefined;
  /**
   * Called with the latest accumulated usage snapshot as the review runs —
   * always at least once, and crucially even when the review then throws
   * (timeout, agent error, quota exhaustion). Callers use it to record the real
   * partial cost/tokens of a run that failed mid-flight; without it the per-turn
   * `gen_ai.client.cost` telemetry counts money already spent while the
   * review-level total silently drops it, so the two diverge on failed runs.
   */
  onUsage?: (usage: ReviewUsage) => void;
  /**
   * `commits` input mode only: the last-reviewed commit (a ref/sha). When set,
   * the commit-exploration prompt tells the agent to review only the commits
   * after it (incremental review); when absent, the whole history is in scope.
   */
  sinceRef?: string;
}

const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

interface ContextFile {
  path: string;
  content: string;
}

interface ReviewContext {
  conventions: ContextFile[];
  reviewRules: ContextFile[];
  skills: Skill[];
}

const DEFAULT_MAX_DIFF_CHARS = 100_000;
const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const REVIEW_RULE_FILES = ['REVIEW.md'];
const CONFIG_DIRS = ['.pi', '.claude', '.agents'];

// Files whose diffs carry no review signal — dependency lockfiles, generated
// output, minified/compiled bundles, type declarations. They are filtered out
// before the size budget so real source is never crowded out by machine-written
// churn. Detection is layered rather than a flat path allowlist: a name list
// alone let `composer.lock` and Shopify's `web/assets/theme.js` slip through and
// consume ~80% of a real MR's budget. The layers, cheapest first:
//   1. path patterns — well-known generated locations and suffixes,
//   2. lockfile basenames — matched anywhere (monorepo lockfiles nest),
//   3. content heuristics — generated banners and minified blobs, which catch
//      compiled assets regardless of what they are named.

// Directory/suffix patterns. Directory patterns match at any depth (`(^|/)`) so
// a nested `packages/x/dist/…` is caught, not just a root-level `dist/`.
const NOISE_PATH_PATTERNS: RegExp[] = [
  /^gitlab-review\.md$/,
  /(^|\/)\.yarn\//,
  /(^|\/)(dist|build|out|coverage|node_modules|\.next)\//,
  /\.min\.(js|css)$/,
  /\.generated\.(ts|js)$/,
  /\.d\.ts$/,
  /\.(js|css)\.map$/,
];

// Dependency lockfiles across ecosystems, matched by basename (case-insensitive)
// so they are skipped wherever they live in the tree.
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'go.sum',
  'packages.lock.json',
  'flake.lock',
  'podfile.lock',
  'mix.lock',
  'pubspec.lock',
  'gradle.lockfile',
  'deno.lock',
  'uv.lock',
]);

// A single added line this long is effectively never hand-written source: it
// signals a minified bundle or an embedded/compiled asset (e.g. a Shopify
// `theme.js`). Catching it by shape means we do not need to enumerate every
// possible name a build tool might emit.
const MINIFIED_LINE_THRESHOLD = 2000;

// High-precision generated-file banners. Each requires generation context (not a
// bare "do not edit") so a source comment does not misclassify real code, and is
// matched against added lines only so prose that merely mentions codegen is safe.
const GENERATED_CONTENT_MARKERS: RegExp[] = [
  /@(?:auto-?)?generated\b/i,
  /\bcode generated by\b/i,
  /this file (?:is|was) (?:auto[- ]?generated|generated by)/i,
  /\bdo not edit\b[^\n]*\b(?:auto-?)?generated\b/i,
  /\b(?:auto-?)?generated\b[^\n]*\bdo not edit\b/i,
];

const SEVERITY_RULE: Record<GitLabReviewSeverity, string | null> = {
  INFO: null,
  WARN: '- Only report CRITICAL and WARN issues — skip INFO',
  CRITICAL: '- Only report CRITICAL issues — skip WARN and INFO',
};

const exec = promisify(execFile);

function defaultCreateAgent(params: CreateAgentParams): AgentLike {
  return new Agent({
    initialState: {
      systemPrompt: params.systemPrompt,
      model: params.model,
      tools: params.tools,
      thinkingLevel: params.thinkingLevel,
    },
    getApiKey: params.getApiKey,
    // pi-ai >=0.82 requires an explicit stream function (earlier versions built
    // one internally from model + getApiKey). streamSimple is pi-ai's drop-in
    // with the matching StreamFn signature.
    streamFn: streamSimple,
  });
}

async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

async function readFirstMatch(dir: string, filenames: string[]): Promise<ContextFile | null> {
  for (const candidate of [dir, ...CONFIG_DIRS.map((d) => join(dir, d))]) {
    let entries: string[];
    try {
      entries = await readdir(candidate);
    } catch {
      continue;
    }
    const wanted = new Set(filenames.map((f) => f.toLowerCase()));
    const match = entries.find((entry) => wanted.has(entry.toLowerCase()));
    if (!match) continue;
    const fullPath = join(candidate, match);
    try {
      const content = await readFile(fullPath, 'utf8');
      return { path: fullPath, content };
    } catch {
      continue;
    }
  }
  return null;
}

async function walkUpContextFiles(
  cwd: string,
  filenames: string[],
  gitRoot: string,
): Promise<ContextFile[]> {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (current === gitRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const result: ContextFile[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const file = await readFirstMatch(dir, filenames);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    result.push({ path: relative(cwd, file.path) || file.path, content: file.content });
  }
  return result;
}

export interface LoadReviewContextOptions {
  /** Re-clone `git:` / `git+ssh:` skills, bypassing the on-disk clone cache. */
  refreshGitSkills?: boolean;
  /** Registered Claude-plugin marketplaces referenced by name in skill specs. */
  marketplaces?: readonly MarketplaceRef[];
}

export async function loadReviewContext(
  cwd: string,
  skillNames: string[] = [],
  warn?: (msg: string) => void,
  options: LoadReviewContextOptions = {},
): Promise<ReviewContext> {
  const gitRoot = await findGitRoot(cwd);
  const [conventions, reviewRules, discovered] = await Promise.all([
    walkUpContextFiles(cwd, CONVENTION_FILES, gitRoot),
    walkUpContextFiles(cwd, REVIEW_RULE_FILES, gitRoot),
    loadAutoDiscoveredSkills(cwd, gitRoot, warn),
  ]);

  const registry = buildMarketplaceRegistry(options.marketplaces ?? []);
  const knownMarketplaces = new Set(registry.keys());

  const skills = [...discovered];
  const discoveredNames = new Set(discovered.map((s) => s.name));
  const named = await Promise.all(
    skillNames
      .filter((n) => !discoveredNames.has(n))
      .map(async (n) => {
        try {
          const spec = parseSkillSpec(n, knownMarketplaces);
          if (spec.protocol === 'marketplace') {
            return await loadMarketplaceSkill(spec, registry, {
              refresh: options.refreshGitSkills,
            });
          }
          return await loadNamedSkill(n, cwd, { refresh: options.refreshGitSkills });
        } catch (error) {
          // A skill is auxiliary guidance, not part of the diff under review.
          // Failing to load one (e.g. an external `git:` clone that can't be
          // downloaded) must not abort the whole review — warn and skip so the
          // review still runs with whatever skills did load.
          warn?.(`Skipping skill "${n}": ${formatError(error)}`);
          return null;
        }
      }),
  );
  skills.push(...named.filter((s): s is Skill => s !== null));

  return { conventions, reviewRules, skills };
}

export interface FilteredDiff {
  diff: string;
  /** Files dropped because they matched a noise pattern (lockfiles, generated, build output). */
  noiseSkippedFiles: string[];
  /** Files dropped because including them would exceed the char budget, with their diff size. */
  sizeSkippedFiles: SizeSkippedFile[];
  /** Number of added/removed lines in the reviewed (included) diff. */
  reviewedChangedLines: number;
  /** Number of added/removed lines in files dropped for the char budget. */
  skippedChangedLines: number;
  /**
   * The raw diff text of each size-dropped file, keyed by path. Lets the caller
   * write them to disk so an agentic reviewer can read the dropped diffs on
   * demand instead of losing them entirely (opt-in retrieval).
   */
  sizeSkippedSections: Array<{ path: string; section: string }>;
  /**
   * Every non-noise file section (path + raw diff), regardless of the char
   * budget. Disk input mode stages all of these so the reviewer reads them on
   * demand instead of receiving any diff inline.
   */
  allSections: Array<{ path: string; section: string; changedLines: number }>;
}

function parseFilePath(header: string): string | null {
  const match = header.match(/^diff --git a\/.+ b\/(.+)$/);
  return match?.[1] ?? null;
}

function basename(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? filePath : filePath.slice(slash + 1);
}

/**
 * Changed lines of a diff section, leading `+`/`-` stripped and the file headers
 * (`+++`/`---`) excluded. `onlyAdded` restricts to additions — used for the
 * generated-banner check, which is about what the change introduces; the blob
 * check scans both sides so an edit to an existing minified file is still caught.
 */
function changedLines(diffSection: string, onlyAdded: boolean): string[] {
  const out: string[] = [];
  for (const line of diffSection.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) out.push(line.slice(1));
    else if (!onlyAdded && line.startsWith('-')) out.push(line.slice(1));
  }
  return out;
}

/**
 * Classify a file as review-noise from its path and diff content. The content
 * layers (minified blobs, generated banners) only run once the path layers miss,
 * and only inspect changed lines, so unchanged context never triggers a skip.
 */
function isNoise(filePath: string, diffSection: string): boolean {
  if (NOISE_PATH_PATTERNS.some((re) => re.test(filePath))) return true;
  if (LOCKFILE_BASENAMES.has(basename(filePath).toLowerCase())) return true;
  if (changedLines(diffSection, false).some((line) => line.length > MINIFIED_LINE_THRESHOLD)) {
    return true;
  }
  if (
    changedLines(diffSection, true).some((line) =>
      GENERATED_CONTENT_MARKERS.some((re) => re.test(line)),
    )
  ) {
    return true;
  }
  return false;
}

function countChangedLines(diffSection: string): number {
  let count = 0;
  for (const line of diffSection.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) count += 1;
  }
  return count;
}

/** Added lines only (excluding the `+++` header) — the review-worthiness signal. */
function countAddedLines(diffSection: string): number {
  let count = 0;
  for (const line of diffSection.split('\n')) {
    if (line.startsWith('+++')) continue;
    if (line.startsWith('+')) count += 1;
  }
  return count;
}

export function filterDiff(raw: string, maxChars = DEFAULT_MAX_DIFF_CHARS): FilteredDiff {
  const sections = raw.split(/(?=^diff --git )/m).filter((section) => section.trim());
  const kept: string[] = [];
  const noiseSkippedFiles: string[] = [];

  for (const section of sections) {
    const firstLine = section.split('\n', 1)[0] ?? '';
    const filePath = parseFilePath(firstLine);
    if (filePath && isNoise(filePath, section)) {
      noiseSkippedFiles.push(filePath);
    } else {
      kept.push(section);
    }
  }

  // Rank-before-drop: only when the budget will actually truncate. Under budget,
  // the original diff order is preserved so the common case is byte-identical.
  // When we must drop, spend the budget on the most review-worthy files first
  // (most added lines) instead of whatever happens to sort early in the diff.
  const totalKeptChars = kept.reduce((total, section) => total + section.length, 0);
  const ordered =
    totalKeptChars <= maxChars
      ? kept
      : kept.toSorted((a, b) => countAddedLines(b) - countAddedLines(a));

  const included: string[] = [];
  const sizeSkippedFiles: SizeSkippedFile[] = [];
  const sizeSkippedSections: Array<{ path: string; section: string }> = [];
  let totalChars = 0;
  let reviewedChangedLines = 0;
  let skippedChangedLines = 0;
  for (const section of ordered) {
    const changedLines = countChangedLines(section);
    if (totalChars + section.length > maxChars) {
      const firstLine = section.split('\n', 1)[0] ?? '';
      const filePath = parseFilePath(firstLine);
      if (filePath) {
        sizeSkippedFiles.push({ path: filePath, chars: section.length, changedLines });
        sizeSkippedSections.push({ path: filePath, section });
      }
      skippedChangedLines += changedLines;
      continue;
    }
    included.push(section);
    totalChars += section.length;
    reviewedChangedLines += changedLines;
  }

  const allSections = kept
    .map((section) => {
      const filePath = parseFilePath(section.split('\n', 1)[0] ?? '');
      return filePath
        ? { path: filePath, section, changedLines: countChangedLines(section) }
        : null;
    })
    .filter(
      (entry): entry is { path: string; section: string; changedLines: number } => entry !== null,
    );

  return {
    diff: included.join(''),
    noiseSkippedFiles,
    sizeSkippedFiles,
    reviewedChangedLines,
    skippedChangedLines,
    sizeSkippedSections,
    allSections,
  };
}

function mergeContent(files: ContextFile[]): string {
  return files.map((file) => file.content).join('\n\n');
}

function buildSkillSection(skill: Skill): string {
  const lines = [
    `<skill name="${skill.name}">`,
    `<description>${skill.description}</description>`,
    `<skill_file>${skill.filePath}</skill_file>`,
  ];
  if (skill.resourceDirs.length > 0) {
    const dirList = skill.resourceDirs.map((d) => `${d}/`).join(', ');
    lines.push(
      '',
      '<skill_resources>',
      `This skill is located at: ${skill.rootDir}`,
      `You can read files from ${dirList} using the Read tool with the full path.`,
      '</skill_resources>',
    );
  }
  lines.push('</skill>');
  return lines.join('\n');
}

function buildSharedBase(minSeverity: GitLabReviewSeverity): string[] {
  const rule = SEVERITY_RULE[minSeverity];
  const today = new Date().toISOString().slice(0, 10);
  return [
    `You are a code reviewer. Review the following PR diff carefully. Today's date is ${today}.`,
    '',
    '<severity_tiers>',
    'Severity reflects the IMPACT of the defect if it occurs. It is independent of how certain you are the code is wrong (that is `confidence`, see below).',
    '',
    '- CRITICAL: runtime failure, data loss or corruption, security vulnerability, broken auth, or production outage. Affects users, persistence, money, or availability.',
    '- WARN: logic error, dropped error, type-unsafe access, or contract break that produces wrong behaviour but does not rise to runtime failure or data loss.',
    '- INFO: nits, style, naming, hints, suggestions, questions. Things that are not concrete defects.',
    '</severity_tiers>',
    '',
    '<confidence_tiers>',
    'Confidence reflects how certain you are that the code is actually wrong. It is independent of severity (impact).',
    '',
    '- high: the defect is demonstrable from the diff alone. You can name the failing input or the exact line, and the violated contract is visible in the diff, the surrounding code, or referenced docs/tests.',
    '- medium: a defect is likely but depends on assumptions about caller behaviour, external state, or runtime context not fully visible in the diff.',
    '- low: a defect is plausible but you cannot prove it from the diff alone — you are reporting a smell or pattern that usually indicates a bug but might be intentional here.',
    '</confidence_tiers>',
    '',
    '<severity_confidence_interaction>',
    '- A CRITICAL finding MUST be high confidence. If you cannot prove the failure path from the diff, either downgrade severity (WARN/INFO) or downgrade confidence and re-evaluate severity.',
    '- A WARN finding at low confidence SHOULD be re-classified as INFO unless the impact is severe enough that even a chance is worth flagging.',
    '- When a commit message, prior thread reply, or in-file ADR/incident reference justifies a pattern that would otherwise be CRITICAL or WARN, do not raise it as severe — surface it in the summary Notes section instead.',
    '- Silence beats fabrication: a confident wrong CRITICAL is worse than a missed bug.',
    '</severity_confidence_interaction>',
    '',
    '<rules>',
    '- Only flag what is actually wrong in the diff — no hypotheticals',
    '- Before reporting a runtime failure (crash, null/undefined dereference, unhandled case, missing check), re-read the function entry and the lines adjacent to your target: if a guard, early return, default value, optional chaining, or a type already prevents that failure, do NOT report it. "It crashes when X" only stands when X is reachable past the guards visible in the code — e.g. do not claim a value is dereferenced unchecked when the function opens with `if (!value) return;`.',
    '- If nothing is wrong, say so clearly',
    '- Do not make claims about external state (dates, library versions, deprecation status, API availability) that cannot be verified from the diff itself',
    '- A finding that asserts something about the literal text of the code — a typo, a misspelled or wrong identifier, a missing or duplicated character, wrong casing — MUST quote the offending token verbatim and only stands if that exact token appears in the diff character-for-character. Re-read the line before reporting: if the spelling you claim is correct already matches the code, the finding is fabricated — drop it.',
    '- Write declaratively. Avoid "consider", "might want to", "could potentially", "you may want to" in issue and suggestion subjects. State the defect and the fix directly. If unsure it is wrong, omit it. (The question and thought labels are inherently tentative and exempt.)',
    '- The summary lists findings by their Conventional Comment subject only; it MUST NOT repeat the discussion, impact ("why it matters"), or suggested fix from any inline comment',
    '- Cross-cutting content (suppressed findings, unreviewed files, overall verdict) goes in the summary, never in inline comments',
    '- When a commit message, prior thread reply, or in-file ADR/incident reference suppresses what would otherwise be a CRITICAL or WARN finding, you MUST add a one-line bullet to the summary Notes section naming the file:line, the pattern, and the context that suppressed it (e.g. "src/probe.ts:13 — empty .catch() suppressed per ADR-042 / INC-2891"). Silent suppression is not acceptable: the developer must be able to audit what context you applied.',
    "- An `<intent>` block, when present, is the author's declared purpose (MR title/description) — a lens for reading the diff, NOT a review target. Finding demonstrable code defects is the job; intent is secondary and must never displace or outrank it. Concretely: NEVER raise an inline comment on a README/description/doc line just because it promises behaviour the diff does not implement, and NEVER let an unmet or exceeded promise be a CRITICAL or blocking finding — code defects alone set severity and the risk line. If the change omits something the description promised, or does something it never claimed (scope creep), note it in ONE line of the summary overview or Notes so the author is aware; do not manufacture inline findings for it. A terse description is not a mismatch, and the description is never proof the code is right.",
    ...(rule ? [rule] : []),
    '</rules>',
  ];
}

export function buildJSONSystemPrompt(
  context: ReviewContext,
  minSeverity: GitLabReviewSeverity,
): string {
  const base = [
    ...buildSharedBase(minSeverity),
    '- Do not repeat what the project conventions already enforce',
    '',
    'Return only a JSON object matching this schema exactly (no markdown fences, no extra text, no extra fields — do not include the diff or any other field):',
    '<output_format>',
    '{',
    '  "summary": "Overall review in **Markdown**, following the <summary_skeleton> below.",',
    '  "comments": [',
    '    { "file": "src/auth.ts", "line": 42, "side": "RIGHT", "severity": "CRITICAL", "confidence": "high", "body": "issue (blocking): <subject>\\n\\n<discussion>" }',
    '  ]',
    '}',
    '</output_format>',
    '',
    'The output MUST be valid JSON: the "summary" and "body" fields carry Markdown (quotes, backticks, code, newlines), so every double quote inside a string value must be escaped as \\", every backslash as \\\\, and every newline as \\n. A single unescaped quote makes the entire review unparseable and is discarded.',
    '',
    'Field rules:',
    '- summary: overall review written in Markdown, following <summary_skeleton>',
    '- comments: inline comments attached to specific diff lines (may be empty [])',
    '- file: relative path from repo root',
    '- line: line number in the file (not the diff position)',
    '- side: "RIGHT" for added/context lines, "LEFT" for removed lines',
    '- severity: "CRITICAL" | "WARN" | "INFO" — the IMPACT tier from <severity_tiers>',
    '- confidence: "high" | "medium" | "low" — your CERTAINTY the code is wrong, from <confidence_tiers>. Required on every comment.',
    '- body: a Conventional Comment, see <comment_format>',
    '',
    '<comment_format>',
    'Each comment body is a Conventional Comment (https://conventionalcomments.org/) with this shape:',
    '',
    '  <label> [decoration]: <Subject — short, action-oriented, 5-10 words>',
    '',
    '  <Discussion: 1-2 sentences stating the concrete defect and observable impact, then the suggested fix. Prefer a fenced ```suggestion``` block when the fix is a small edit on the line(s) being commented; otherwise use prose or a ```diff``` block.>',
    '',
    'Allowed labels: issue, suggestion, nitpick, question, todo, chore, note, thought',
    'Allowed decorations: (blocking), (non-blocking), (if-minor)',
    'Do NOT emit "praise:" comments — out of scope for this reviewer.',
    '',
    'Label and decoration must match the severity field:',
    '- CRITICAL → "issue (blocking): ..."',
    '- WARN     → "issue: ..."  (no decoration; an unmarked issue is implicitly blocking per the spec)',
    '- INFO     → choose the fitting label: "nitpick: ...", "suggestion (non-blocking): ...", "note: ...", "question: ...", or "thought: ..."',
    '</comment_format>',
    '',
    '<summary_skeleton>',
    'The summary is rendered under a fixed "### Code Review" heading so every review looks the same and is easy to scan. Write the summary content in this EXACT order. The risk line and the overview are ALWAYS present; the issues block and the notes block appear only when they have content.',
    '',
    '  **Risk: <Low | Medium | High>** — <one sentence: the impact of merging this MR and how it should be handled. Low = no blocking issues, safe to merge aside from nits. Medium = wrong behaviour or missed cases that should be fixed before merge. High = data loss, security, broken auth, or a critical-path crash — do not merge until resolved. Anchor the level to the most severe finding.>',
    '',
    '  <2-3 sentence plain-prose overview of what the MR does. ALWAYS present, including on a clean review.>',
    '',
    '  **<N> issue(s) found:**',
    '  - **<label>** — `file:line` — <subject>',
    '  <One bullet per inline comment. Show only the subject (the text after the comment label); never restate the discussion, impact, or fix — those live in the inline comment. Omit this entire block when there are no inline comments.>',
    '',
    '  **Notes:**',
    '  <Only when there is something to surface: suppressed CRITICAL/WARN findings (one bullet each — file:line, the pattern, and the commit/ADR/prior-thread that justified leaving it un-flagged) and any unreviewed/skipped files. Omit this entire block when there is nothing to note.>',
    '</summary_skeleton>',
    '',
    '<example>',
    'Example output for a diff that introduces one real bug and one style nit:',
    '```json',
    '{',
    '  "summary": "**Risk: High** — The retry loop overcharges customers on the free-tier path; do not merge until the off-by-one is fixed.\\n\\nAdds a checkout retry helper used by the cart route, with one blocking off-by-one and one naming nit.\\n\\n**2 issues found:**\\n- **issue (blocking)** — `src/cart/retry.ts:42` — Loop runs N+1 attempts on first call\\n- **nitpick** — `src/cart/retry.ts:8` — Helper name shadows the `Retry` type",',
    '  "comments": [',
    '    {',
    '      "file": "src/cart/retry.ts",',
    '      "line": 42,',
    '      "side": "RIGHT",',
    '      "severity": "CRITICAL",',
    '      "confidence": "high",',
    '      "body": "issue (blocking): Loop runs N+1 attempts on first call\\n\\nThe `attempt <= maxAttempts` predicate executes the body one extra time when `maxAttempts === 0`, which is the configured value for the free-tier path. The first call therefore charges the customer twice on a 5xx response.\\n\\n```suggestion\\nwhile (attempt < maxAttempts) {\\n```"',
    '    },',
    '    {',
    '      "file": "src/cart/retry.ts",',
    '      "line": 8,',
    '      "side": "RIGHT",',
    '      "severity": "INFO",',
    '      "confidence": "high",',
    '      "body": "nitpick: Helper name shadows the `Retry` type\\n\\nNaming the local `Retry` shadows the imported `Retry` type from `./types.ts`. Rename to `runWithRetry`."',
    '    }',
    '  ]',
    '}',
    '```',
    '</example>',
  ].join('\n');

  const sections = [base];
  const conventions = mergeContent(context.conventions).trim();
  if (conventions) sections.push(`<conventions>\n${conventions}\n</conventions>`);
  const reviewRules = mergeContent(context.reviewRules).trim();
  if (reviewRules) sections.push(`<review_rules>\n${reviewRules}\n</review_rules>`);
  if (context.skills.length > 0) {
    const preamble = [
      'Read each skill file before applying it. Skills are mandatory rule sets — the actual review criteria live in the SKILL.md body, not in the one-line description below.',
      '',
      'For every skill listed below, you MUST:',
      '  1. Call the Read tool with the path in <skill_file> to load the SKILL.md content. Example: Read({ file_path: "/abs/path/to/skills/code-review/SKILL.md" }).',
      '  2. If the skill lists <skill_resources>, Read the references relevant to the languages or frameworks present in this diff (skip references that do not match the diff).',
      "  3. Apply the skill's criteria when forming and grading findings.",
      '',
      'A skill loaded but never read is a no-op — the description alone is not enough to apply the rules correctly.',
    ].join('\n');
    const skillSections = context.skills.map(buildSkillSection).join('\n\n');
    sections.push(`<skills>\n${preamble}\n\n${skillSections}\n</skills>`);
  }
  return sections.join('\n\n');
}

/**
 * Author-declared intent for the change, sourced from the GitLab MR.
 * Both fields are optional and may be empty/whitespace — the renderer degrades
 * gracefully and emits no intent block when there is nothing meaningful to show.
 */
export interface ReviewIntent {
  title?: string;
  description?: string | null;
}

/** Max characters of MR description injected into the prompt to bound token cost. */
const MAX_INTENT_DESCRIPTION_CHARS = 4_000;

/**
 * Renders the author-declared intent (MR title + description) as a clearly
 * delimited `<intent>` block. Returns an empty string when neither field has
 * meaningful content, so a missing/empty description degrades gracefully.
 * The description is trimmed and length-capped to bound token cost.
 */
function renderIntentBlock(intent: ReviewIntent | undefined): string {
  if (!intent) return '';
  const title = intent.title?.trim() ?? '';
  let description = intent.description?.trim() ?? '';
  if (!title && !description) return '';

  if (description.length > MAX_INTENT_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_INTENT_DESCRIPTION_CHARS)}\n… (description truncated)`;
  }

  const lines = ['<intent>'];
  if (title) lines.push(`<title>${title}</title>`);
  if (description) lines.push(`<description>\n${description}\n</description>`);
  lines.push('</intent>');
  return lines.join('\n');
}

/**
 * Build a Find system prompt specialised to one review angle. Used by `full`
 * depth, which runs one finder per angle. The base prompt (severity/confidence
 * tiers, output format, skills, conventions) is unchanged; an `<review_angle>`
 * section narrows the finder to its lane so the finders cover breadth rather
 * than all re-finding the same top issue.
 */
export function buildAngleSystemPrompt(
  context: ReviewContext,
  minSeverity: GitLabReviewSeverity,
  angle: ReviewAngle,
): string {
  return [
    buildJSONSystemPrompt(context, minSeverity),
    '',
    '<review_angle>',
    `You are ONE of several reviewers working in parallel, each assigned a different angle. Your assigned angle is "${angle.key}".`,
    angle.directive,
    'Report ONLY findings that fall within your angle — other reviewers cover the rest, so do not stray into their scope or duplicate it. If your angle surfaces nothing, return an empty comments array. The severity and confidence bars from the base instructions still apply.',
    '</review_angle>',
  ].join('\n');
}

export function buildUserPrompt(
  diff: string,
  skippedFiles: string[] = [],
  commitLog?: string,
  priorThreads?: PriorThread[],
  intent?: ReviewIntent,
  coverage?: { reviewedLines: number; totalLines: number },
  retrievableSkipped?: SkippedDiffFile[],
  omitInlineDiff = false,
  commitExploration?: { sinceRef?: string },
): string {
  const parts: string[] = [];
  const intentBlock = renderIntentBlock(intent);
  if (intentBlock) {
    parts.push(
      `The author described the purpose of this change below. Use it as context for reading the diff. If the code omits something promised or adds something never claimed, note it in one line of the summary — do not raise inline findings on the description text itself:\n${intentBlock}`,
    );
  }
  if (commitLog?.trim()) {
    parts.push(`Commits in this MR (oldest first):\n<commits>\n${commitLog.trim()}\n</commits>`);
  }
  // Commit-exploration mode (Mode C): no diff is inlined; the agent walks the
  // change with the read-only git tools.
  if (commitExploration) {
    const since = commitExploration.sinceRef;
    parts.push(
      [
        'This review has NO diff inline. Explore the change with the read-only git tools:',
        since
          ? `- \`git_log\` with since="${since}" lists the commits you have NOT reviewed yet (everything after ${since}). Review exactly those commits.`
          : '- `git_log` lists the commits in this change. Review all of them.',
        "- `git_show <sha>` shows a commit's message and full diff. Open every commit in scope.",
        '- `git_diff <from> <to>` shows the combined diff between two points if you prefer to review the range at once.',
        'A commit you do not open is code you did not review. In your summary, state which commits you reviewed.',
      ].join('\n'),
    );
  }
  // Disk input mode (omitInlineDiff): the whole change is staged on disk, so no
  // <diff> block is emitted and the staged-files block carries the full change.
  if (!omitInlineDiff && !commitExploration) {
    parts.push(`Review this diff:\n<diff>\n${diff}\n</diff>`);
  }
  if (retrievableSkipped && retrievableSkipped.length > 0) {
    // Retrieval mode (partial): size-dropped diffs are staged alongside an inline
    // diff. Disk mode (full): the staged files ARE the whole change.
    parts.push(
      renderRetrievableSkippedBlock(retrievableSkipped, omitInlineDiff ? 'full' : 'partial'),
    );
  } else if (skippedFiles.length > 0) {
    parts.push(
      `<skipped_files>\n${skippedFiles
        .map((file) => `- ${file}`)
        .join(
          '\n',
        )}\n</skipped_files>\nThe above files were not included because the diff exceeded the size limit. They are already surfaced to the reader in the MR summary, so do not re-list them; just do not assume they are clean, since you did not see them.`,
    );
  }
  if (coverage && coverage.totalLines > 0 && coverage.reviewedLines < coverage.totalLines) {
    const pct = Math.round((coverage.reviewedLines / coverage.totalLines) * 100);
    parts.push(
      `<coverage>You reviewed ${coverage.reviewedLines} of ${coverage.totalLines} changed lines (~${pct}%). The rest were dropped for the size budget and you did NOT see them. The MR summary already reports this partial coverage to the reader, so do not restate it; just do not imply the unreviewed files are clean — their absence from your findings is not a clearance.</coverage>`,
    );
  }
  if (priorThreads && priorThreads.length > 0) {
    const block = renderPriorThreadsBlock(priorThreads);
    if (block) {
      parts.push(
        `The following threads were posted by a previous review run and have received developer replies. Use this context to avoid repeating already-acknowledged concerns and to provide informed follow-up:\n${block}`,
      );
    }
  }
  return parts.join('\n\n');
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

export function extractLastAssistantText(messages: AssistantMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractAssistantText(messages[i]);
    if (text) return text;
  }
  return '';
}

/**
 * Build a Model object for an Ollama-hosted model.
 *
 * Ollama exposes an OpenAI-compatible `/v1` endpoint, so we use the
 * `openai-completions` API adapter. The `baseUrl` is taken from the
 * already-resolved config (derived from `OLLAMA_HOST` or `CODE_REVIEW_BASE_URL`).
 * Cost is zero — Ollama runs locally.
 */
function buildOllamaModel(
  modelId: string,
  baseUrl: string,
  maxTokens: number,
): Model<'openai-completions'> {
  const effectiveMaxTokens = maxTokens > 0 ? maxTokens : 4096;
  // Use a generous context window default. Ollama model context sizes vary
  // widely and can only be known by querying the server at runtime. We set a
  // large constant so the agent doesn't truncate context unnecessarily; the
  // model itself will cap actual generation at its own limit.
  const contextWindow = 131072;
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions' as const,
    provider: 'ollama',
    baseUrl,
    reasoning: false,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: effectiveMaxTokens,
  };
}

/**
 * Resolve a model string into a pi-ai `Model` object.
 *
 * The model string must be `"provider/modelId"` where `modelId` may itself
 * contain slashes for providers like OpenRouter (`openrouter/anthropic/claude-3-opus`).
 * Splitting is always done on the **first** slash only.
 *
 * Special providers:
 * - `ollama`: builds a local OpenAI-compatible model with the given `baseUrl`.
 *
 * @param modelString - Full model string, e.g. `"anthropic/claude-sonnet-4-5"`.
 * @param baseUrl     - Custom base URL override (used for Ollama or generic endpoints).
 * @param maxTokens   - Max output tokens; 0 means use the model's default.
 */
function resolveModel(modelString: string, baseUrl: string, maxTokens: number): Model<string> {
  const { provider, modelId } = splitModel(modelString);
  if (provider === undefined || modelId === undefined) {
    throw new ReviewerError(
      `Invalid model format "${modelString}". Expected "provider/modelId" (e.g. "anthropic/claude-sonnet-4-5").`,
    );
  }

  // Built-in Ollama support via the OpenAI-compatible API.
  if (provider === 'ollama') {
    const effectiveBase = baseUrl || 'http://localhost:11434/v1';
    return buildOllamaModel(modelId, effectiveBase, maxTokens);
  }

  const model = getBuiltinModel(provider as never, modelId as never) as Model<string> | undefined;
  if (!model) {
    throw new ReviewerError(`Unknown model "${modelString}".`, {
      hint: `Check that "${provider}" is a valid provider and "${modelId}" is a registered model ID.`,
    });
  }

  // Apply overrides when provided.
  // - baseUrl: redirect to a custom OpenAI-compatible endpoint.
  // - maxTokens: cap output tokens (0 keeps the model's registered default).
  if (baseUrl || maxTokens > 0) {
    return {
      ...model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(maxTokens > 0 ? { maxTokens } : {}),
    };
  }
  return model;
}

/**
 * One usable model in the review pool. `id` is the original `provider/modelId`
 * string — the stable identity used for fixed angle→model mapping, cross-family
 * verifier selection, and per-model usage keying. `getApiKey` resolves THIS
 * member's provider key, so a key for provider X is never sent to provider Y.
 */
export interface PoolMember {
  id: string;
  model: Model<string>;
  getApiKey: () => Promise<string>;
}

/**
 * Build the effective model pool from `config.model` plus `config.modelPool`,
 * resolving each member's own provider key and dropping (with a warning) any
 * member whose key is missing/empty. Order and duplicates from `config.modelPool`
 * are preserved by first occurrence. When the pool is empty or every member is
 * unusable, falls back to a single-member pool of `config.model` (already
 * validated to have a key) — reproducing single-model behaviour exactly.
 *
 * `config.apiKey` (which honours `--api-key`) is used for any member whose id
 * equals `config.model`, so an explicit override key still applies; other members
 * resolve their key via the provider-aware resolver.
 */
export function buildEffectivePool(config: Config, logger: Logger): PoolMember[] {
  const ids = config.modelPool.length > 0 ? config.modelPool : [config.model];
  const seen = new Set<string>();
  const members: PoolMember[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);

    let model: Model<string>;
    try {
      model = resolveModel(id, config.baseUrl ?? '', config.maxTokens ?? 0);
    } catch (error) {
      logger.warn(`Model pool: dropping "${id}" — ${(error as Error).message}`);
      continue;
    }

    // The configured main model already resolved its key into config.apiKey
    // (honouring --api-key); other members resolve their provider key directly.
    const key = id === config.model ? config.apiKey : resolveProviderApiKey(id);
    if (!key) {
      logger.warn(
        `Model pool: dropping "${id}" — no API key found for its provider; set the provider's key env var to use it.`,
      );
      continue;
    }

    members.push({ id, model, getApiKey: async () => key });
  }

  if (members.length === 0) {
    // Every configured member was unusable — fall back to the validated main
    // model so the run still proceeds (single-model behaviour).
    const model = resolveModel(config.model, config.baseUrl ?? '', config.maxTokens ?? 0);
    return [{ id: config.model, model, getApiKey: async () => config.apiKey }];
  }

  return members;
}

/** Blended per-token cost (input + output) used to compare model tiers. */
export function blendedCost(model: Model<string>): number {
  const cost = model.cost;
  if (!cost) return 0;
  return (cost.input ?? 0) + (cost.output ?? 0);
}

/**
 * Resolve `config.verifyModel` into a dedicated Verify-stage pool member. Returns
 * null when unset (Verify falls back to the pool's cross-family pick) or when the
 * model/key can't be resolved (warns and falls back, so a bad value never aborts
 * the run). Also warns when the verify model is a *cheaper* tier than the finder:
 * the Verify stage is a precision-judgment task, and a weak verifier drops real
 * findings (recall loss) — so cheap-find/strong-verify is the intended shape.
 */
export function resolveVerifyMember(
  config: Config,
  primary: PoolMember,
  logger: Logger,
): PoolMember | null {
  const id = config.verifyModel?.trim();
  if (!id) return null;
  if (id === primary.id) return null; // same as finder — nothing to route
  let model: Model<string>;
  try {
    model = resolveModel(id, config.baseUrl ?? '', config.maxTokens ?? 0);
  } catch (error) {
    logger.warn(`Ignoring --verify-model "${id}": ${(error as Error).message}`);
    return null;
  }
  const key = resolveProviderApiKey(id);
  if (!key) {
    logger.warn(
      `Ignoring --verify-model "${id}": no API key for its provider. ` +
        `Set the provider's key (e.g. ANTHROPIC_API_KEY) to route Verify to it.`,
    );
    return null;
  }
  const verifyCost = blendedCost(model);
  const findCost = blendedCost(primary.model);
  if (verifyCost > 0 && findCost > 0 && verifyCost < findCost) {
    logger.warn(
      `--verify-model "${id}" looks cheaper than the find model "${primary.id}". ` +
        `Verify is a precision-judgment task; a weaker verifier tends to drop real ` +
        `findings (recall loss). Prefer a cheap finder with a strong verifier.`,
    );
  }
  logger.info(`Verify stage routed to ${id} (find: ${primary.id}).`);
  return { id, model, getApiKey: async () => key };
}

interface ModelUsageBucket {
  tokens: UsageBreakdown;
  cost: UsageBreakdown;
}

interface AggregatedUsage {
  tokens: UsageBreakdown;
  cost: UsageBreakdown;
  /** Per-pool-member buckets, keyed by the member's `provider/modelId` id. */
  byModel: Map<string, ModelUsageBucket>;
}

function emptyBucket(): ModelUsageBucket {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function emptyUsage(): AggregatedUsage {
  return { ...emptyBucket(), byModel: new Map() };
}

function addUsageToBucket(bucket: ModelUsageBucket, message: AssistantMessage): void {
  const usage = message.usage;
  if (!usage) return;
  bucket.tokens.input += usage.input;
  bucket.tokens.output += usage.output;
  bucket.tokens.cacheRead += usage.cacheRead;
  bucket.tokens.cacheWrite += usage.cacheWrite;
  bucket.tokens.total += usage.totalTokens;
  if (usage.cost) {
    bucket.cost.input += usage.cost.input;
    bucket.cost.output += usage.cost.output;
    bucket.cost.cacheRead += usage.cost.cacheRead;
    bucket.cost.cacheWrite += usage.cost.cacheWrite;
    bucket.cost.total += usage.cost.total;
  }
}

/**
 * Add an assistant message's usage to the global totals and, when a pool member
 * id is given, to that member's per-model bucket. `modelId` is the member's
 * `provider/modelId` string — never a key or any secret.
 */
function accumulateUsage(
  target: AggregatedUsage,
  message: AssistantMessage,
  modelId?: string,
): void {
  if (!message.usage) return;
  addUsageToBucket(target, message);
  if (modelId) {
    let bucket = target.byModel.get(modelId);
    if (!bucket) {
      bucket = emptyBucket();
      target.byModel.set(modelId, bucket);
    }
    addUsageToBucket(bucket, message);
  }
}

/**
 * The "consider decomposing this MR" hint: present when a threshold is set
 * (`> 0`) and the change exceeds it. `changedLines` is the count the caller
 * deems reviewed — the budget-fitted subset for inline mode, the whole change
 * for disk/commits mode.
 */
export function resolveDecomposeHint(
  threshold: number,
  reviewedLines: number,
): { lines: number; threshold: number } | undefined {
  return threshold > 0 && reviewedLines > threshold
    ? { lines: reviewedLines, threshold }
    : undefined;
}

export async function runReview(config: Config, options: RunReviewOptions): Promise<ReviewUsage> {
  const cwd = options.cwd ?? config.cwd;
  const minSeverity = toGitLabReviewSeverity(config.minSeverity);
  const logger = options.logger ?? noopLogger;

  const inputMode = config.inputMode ?? 'auto';
  // The read-only git tools are empty unless `cwd` is a real checkout.
  const gitTools = createGitTools(cwd);
  // `commits` mode drives the review entirely through the git tools with no diff
  // inline. Without a checkout those tools are absent, which would leave the
  // agent with neither a diff nor tools — a silent no-op review. Fall back to the
  // size-adaptive `auto` behaviour (the diff is available regardless) instead.
  let commitsMode = inputMode === 'commits';
  if (commitsMode && gitTools.length === 0) {
    logger.warn(
      'Commit-exploration input mode requires a git checkout, but none was found in cwd; falling back to auto input mode.',
    );
    commitsMode = false;
  }
  // After the possible downgrade, `effectiveMode` is what actually drives staging.
  const effectiveMode = commitsMode ? 'commits' : inputMode === 'commits' ? 'auto' : inputMode;

  const maxDiffChars = config.maxDiffChars > 0 ? config.maxDiffChars : DEFAULT_MAX_DIFF_CHARS;
  const {
    diff,
    noiseSkippedFiles,
    sizeSkippedFiles,
    reviewedChangedLines,
    skippedChangedLines,
    sizeSkippedSections,
    allSections,
  } = filterDiff(options.diff, maxDiffChars);

  // Size-adaptive `auto`: review inline while the diff fits the char budget, and
  // switch to disk staging once it overflows. Evals show inline's retrieval
  // fallback is under-used on large diffs, where disk is both more thorough
  // (the agent actually opens every file) and cheaper (the huge diff is never
  // inlined). Explicit `disk` / `commits` / `inline` always win over `auto`.
  const overflowed = sizeSkippedSections.length > 0;
  const diskMode = effectiveMode === 'disk' || (effectiveMode === 'auto' && overflowed);
  if (effectiveMode === 'auto') {
    logger.info(
      diskMode
        ? `Auto input mode: diff exceeds the ${maxDiffChars}-char budget — staging all files on disk for the agent to read.`
        : 'Auto input mode: diff fits the budget — reviewing inline.',
    );
  }

  // Inline mode needs a non-empty inlined diff; disk/commits modes present the
  // change out-of-band, so they require non-noise sections rather than inline text.
  const hasContent = diskMode || commitsMode ? allSections.length > 0 : diff.trim().length > 0;
  if (!hasContent) {
    throw new ReviewerError('No reviewable diff content after filtering noise files.', {
      hint: 'Ensure the merge request introduces changes outside of generated/lock files.',
    });
  }

  // In disk/commits mode the agent reviews the WHOLE change (nothing is dropped
  // to the char budget), so the hint must count all changed lines, not just the
  // budget-fitted subset — otherwise it under-fires on exactly the oversized MRs
  // that trigger disk mode in the first place.
  const decomposeHint = resolveDecomposeHint(
    config.decomposeHintLines,
    diskMode || commitsMode ? reviewedChangedLines + skippedChangedLines : reviewedChangedLines,
  );

  // Resolve how the change reaches the reviewer, and stage diffs on disk.
  let promptDiff: string;
  let promptSkippedFiles: string[];
  let promptCoverage: { reviewedLines: number; totalLines: number } | undefined;
  let retrievableSkipped: SkippedDiffFile[];
  let sizeNotice: ReviewSizeNotice;

  if (commitsMode) {
    // Commit-exploration mode: nothing inlined or staged — the agent walks the
    // change with the git tools (wired into `tools` below).
    retrievableSkipped = [];
    promptDiff = '';
    promptSkippedFiles = [];
    promptCoverage = undefined;
    sizeNotice = { sizeSkippedFiles: [], decomposeHint, retrieved: false };
    logger.info(
      options.sinceRef
        ? `Commit-exploration input mode: reviewing commits since ${options.sinceRef}.`
        : 'Commit-exploration input mode: reviewing the full commit range.',
    );
  } else if (diskMode) {
    // Stage the ENTIRE change on disk; nothing is inlined. The same manifest
    // drives the Verify stage so verifiers read from disk too.
    retrievableSkipped =
      allSections.length > 0
        ? await writeSkippedDiffs(
            cwd,
            allSections.map(({ path, section }) => ({ path, section })),
          )
        : [];
    if (retrievableSkipped.length > 0) {
      logger.info(
        `Disk input mode: staged ${retrievableSkipped.length} file diff(s) for on-demand review.`,
      );
    }
    promptDiff = '';
    promptSkippedFiles = [];
    promptCoverage = undefined;
    // Staging is the mode here, not a budget truncation, so no partial-coverage
    // callout — that would falsely read as "we couldn't review this".
    sizeNotice = { sizeSkippedFiles: [], decomposeHint, retrieved: false };
  } else {
    // The agent still needs to know which files went unreviewed (size + noise);
    // the split/decompose callout is surfaced separately via `sizeNotice`.
    promptSkippedFiles = [...sizeSkippedFiles.map((f) => f.path), ...noiseSkippedFiles];
    // Coverage is only meaningful when the budget actually dropped files.
    promptCoverage =
      sizeSkippedFiles.length > 0
        ? {
            reviewedLines: reviewedChangedLines,
            totalLines: reviewedChangedLines + skippedChangedLines,
          }
        : undefined;
    // Retrieval mode (default on): stage dropped-file diffs on disk so the agent
    // can read the ones it deems risky instead of losing them to the char budget.
    retrievableSkipped =
      config.retrieveSkipped && sizeSkippedSections.length > 0
        ? await writeSkippedDiffs(cwd, sizeSkippedSections)
        : ([] as SkippedDiffFile[]);
    if (retrievableSkipped.length > 0) {
      logger.info(
        `Staged ${retrievableSkipped.length} dropped-file diff(s) on disk for retrieval.`,
      );
    }
    promptDiff = diff;
    sizeNotice = {
      sizeSkippedFiles,
      decomposeHint,
      coverage: promptCoverage,
      retrieved: retrievableSkipped.length > 0,
    };
  }

  const context = await loadReviewContext(cwd, config.skills, (msg) => logger.warn(msg), {
    refreshGitSkills: config.refreshGitSkills,
    marketplaces: config.marketplaces,
  });
  const systemPrompt = buildJSONSystemPrompt(context, minSeverity);
  const userPrompt = buildUserPrompt(
    promptDiff,
    promptSkippedFiles,
    options.commitLog,
    options.priorThreads,
    options.intent,
    promptCoverage,
    retrievableSkipped,
    diskMode,
    commitsMode ? { sinceRef: options.sinceRef } : undefined,
  );

  const skillNames = context.skills.map((s) => s.name);
  if (skillNames.length > 0) {
    logger.debug(`Skills loaded: ${skillNames.join(', ')}`);
  }
  if (context.conventions.length > 0) {
    logger.debug(`Conventions: ${context.conventions.map((f) => f.path).join(', ')}`);
  }
  if (context.reviewRules.length > 0) {
    logger.debug(`Review rules: ${context.reviewRules.map((f) => f.path).join(', ')}`);
  }

  const pool = buildEffectivePool(config, logger);
  if (pool.length > 1) {
    logger.info(`Model pool: ${pool.map((m) => m.id).join(', ')}.`);
  }
  const primary = pool[0];
  // Always offer the read-only file tools plus the read-only git tools (the
  // latter are empty unless `cwd` is a real checkout). This way the agent CAN
  // explore commit history in any mode if it helps, without being forced to;
  // only `commits` mode's prompt actively directs it to walk the change that way.
  const tools = [...createReadOnlyTools(cwd), ...gitTools] as AgentTool[];

  const createAgent = options.createAgent ?? defaultCreateAgent;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const aggregated = emptyUsage();
  const deps: StageDeps = {
    createAgent,
    pool,
    tools,
    thinkingLevel: config.thinkingLevel,
    timeoutMs,
    logger,
    aggregated,
    verifyMember: resolveVerifyMember(config, primary, logger),
    attachTelemetry: options.attachTelemetry,
    verifyStaged: diskMode ? retrievableSkipped : undefined,
  };

  // Snapshot builder for the accumulated usage. Used for the normal return and,
  // via the `finally` below, even when a stage throws — so a run that fails
  // mid-flight (timeout, agent error) still reports the partial cost/tokens it
  // already incurred, matching the per-turn `gen_ai.client.cost` telemetry that
  // fires live as each turn completes.
  const buildUsage = (): ReviewUsage => ({
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    tokens: aggregated.tokens,
    cost: aggregated.cost,
    byModel: buildByModelUsage(aggregated),
    skills: context.skills.map((s) => s.name),
    sizeNotice,
  });

  let outputText: string;

  try {
    if (config.reviewDepth === 'full') {
      // --- Multi-angle Find → Triage → Verify → Synthesize.
      const { findings, summary } = await runMultiAngleFind(context, minSeverity, userPrompt, deps);
      outputText = await verifyAndSynthesize(findings, summary, diff, options.commitLog, deps);
    } else {
      // --- single / verify: one Find pass on the primary model. In `single` depth
      // its output is written verbatim, byte-identical to legacy runs.
      const findAgent = createAgent({
        systemPrompt,
        model: primary.model,
        tools,
        thinkingLevel: config.thinkingLevel,
        getApiKey: primary.getApiKey,
      });

      // Attach telemetry before the first prompt so all events fire.
      const detachTelemetry = options.attachTelemetry?.(findAgent);
      let turnCount = 0;
      let toolCallCount = 0;
      let finalText: string;
      try {
        finalText = await runAgentToCompletion(findAgent, userPrompt, {
          timeoutMs,
          onAssistantMessage: (message) => accumulateUsage(aggregated, message, primary.id),
          onTurnStart: (turn) => {
            turnCount = turn;
            logger.debug(`Turn ${turn} started`);
          },
          onToolStart: (toolName, args) => {
            toolCallCount += 1;
            logger.debug(`  → ${toolName}${formatToolArgs(toolName, args)}`);
          },
        });
      } finally {
        detachTelemetry?.();
      }
      logger.debug(`Agent finished: ${turnCount} turn(s), ${toolCallCount} tool call(s)`);

      outputText =
        config.reviewDepth === 'verify'
          ? await runVerifyStage(finalText, diff, options.commitLog, deps)
          : finalText;
    }
  } finally {
    options.onUsage?.(buildUsage());
  }

  const reviewPath = resolve(cwd, config.reviewFile);
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, outputText, 'utf8');

  // Remove the staged dropped-file diffs now the agent is done reading them.
  if (retrievableSkipped.length > 0) await cleanupSkippedDiffs(cwd);

  return buildUsage();
}

/**
 * Convert the per-model usage buckets into the public {@link ModelUsage} array,
 * sorted by model id for deterministic output. Returns `undefined` when fewer
 * than two distinct models ran, so single-model runs stay byte-identical.
 */
function buildByModelUsage(aggregated: AggregatedUsage): ModelUsage[] | undefined {
  if (aggregated.byModel.size < 2) return undefined;
  return [...aggregated.byModel.entries()]
    .map(([model, bucket]) => ({ model, tokens: bucket.tokens, cost: bucket.cost }))
    .toSorted((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

interface RunAgentCallbacks {
  timeoutMs: number;
  onAssistantMessage?: (message: AssistantMessage) => void;
  onTurnStart?: (turn: number) => void;
  onToolStart?: (toolName: string, args: unknown) => void;
}

/**
 * Drive an agent through a single prompt to completion and return its final
 * assistant text. Shared by the Find pass and each Verify agent so the
 * subscribe/timeout/error handling lives in one place.
 */
async function runAgentToCompletion(
  agent: AgentLike,
  userPrompt: string,
  callbacks: RunAgentCallbacks,
): Promise<string> {
  const collected: AssistantMessage[] = [];
  let turnCount = 0;
  let unsubscribe: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let finalText = '';
  try {
    const ended = new Promise<void>((resolvePromise, rejectPromise) => {
      unsubscribe = agent.subscribe(async (event) => {
        if (event.type === 'turn_start') {
          turnCount += 1;
          callbacks.onTurnStart?.(turnCount);
        }
        if (event.type === 'tool_execution_start') {
          callbacks.onToolStart?.(event.toolName, event.args);
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const assistant = event.message as AssistantMessage;
          collected.push(assistant);
          callbacks.onAssistantMessage?.(assistant);
        }
        if (event.type !== 'agent_end') return;
        const messages = event.messages.filter(
          (message): message is AssistantMessage => message.role === 'assistant',
        );
        const last = messages[messages.length - 1];
        if (last?.stopReason === 'error' || last?.errorMessage) {
          const message = last.errorMessage ?? 'unknown error';
          const quotaExceeded = isQuotaExceededMessage(message);
          rejectPromise(
            new ReviewerError(`Agent failed: ${message}`, {
              quotaExceeded,
              hint: quotaExceeded
                ? 'The model provider reported exhausted credits/quota. Top up the provider account or switch --model.'
                : undefined,
            }),
          );
          return;
        }
        finalText = extractLastAssistantText(collected.length > 0 ? collected : messages);
        if (!finalText) {
          rejectPromise(new ReviewerError('Agent returned an empty response.'));
          return;
        }
        resolvePromise();
      });
    });

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new ReviewerError(`Review timed out after ${Math.round(callbacks.timeoutMs / 1000)}s`, {
              timeout: true,
              hint: 'Increase timeoutMs or reduce the diff size.',
            }),
          ),
        callbacks.timeoutMs,
      );
    });

    await agent.prompt(userPrompt);
    await Promise.race([ended, timeout]);
  } finally {
    clearTimeout(timeoutId);
    unsubscribe?.();
  }
  return finalText;
}

/** Run async tasks with a bounded number running concurrently. */
async function runBounded(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      const task = tasks[index];
      if (task) await task();
    }
  });
  await Promise.all(workers);
}

const VERIFY_CONCURRENCY = Number(process.env.CODE_REVIEW_VERIFY_CONCURRENCY) || 4;
const FIND_CONCURRENCY = 3;

interface StageDeps {
  createAgent: CreateAgent;
  /**
   * Effective model pool. `pool[0]` is the primary model (used by `single`/`verify`
   * depth and as the default). `full` depth maps angles across all members and
   * verifies with a member other than a finding's author.
   */
  pool: PoolMember[];
  tools: AgentTool[];
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
  logger: Logger;
  aggregated: AggregatedUsage;
  /**
   * Explicit Verify-stage model (from `--verify-model`). When set, every verifier
   * runs on this member instead of the pool's cross-family pick. Null keeps the
   * pool-based selection.
   */
  verifyMember?: PoolMember | null;
  /**
   * Optional telemetry attach hook, applied to EVERY agent the stages spawn
   * (multi-angle finders and per-finding verifiers), not just the single/verify
   * Find agent. Returns a detach callback run when that agent finishes. Without
   * this, read-coverage/trajectory measurement silently misses every agent above
   * `single` depth.
   */
  attachTelemetry?: (agent: AgentLike) => (() => void) | undefined;
  /**
   * Disk input mode: the staged manifest for the whole change. When set, the
   * Verify stage omits the inline diff from its system prompt and points
   * verifiers at the staged files instead, so "nothing inline" holds at every
   * depth (otherwise verifiers would still receive the diff and the mode's cost
   * profile wouldn't transfer past `single`).
   */
  verifyStaged?: SkippedDiffFile[];
}

/**
 * Pick a deterministic verifier for a finding authored by `authorModelId`: the
 * first pool member whose id differs, by pool order. With a 1-model pool (or when
 * no other member exists) this degenerates to the author itself — today's
 * behaviour. The author is never preferred when an alternative exists, so the
 * verifier shares fewer blind spots with the finder.
 */
function pickVerifier(pool: PoolMember[], authorModelId: string): PoolMember {
  const other = pool.find((member) => member.id !== authorModelId);
  return other ?? pool[0];
}

/**
 * Multi-angle Find (used by `full` depth). Runs one finder per review angle
 * concurrently — each with the same diff, skills, and read-only repo tools, but
 * a system prompt narrowed to its lane — then merges and deduplicates their
 * findings via Triage. Returns the triaged comments plus the first non-empty
 * finder summary to seed the synthesized overview.
 */
async function runMultiAngleFind(
  context: ReviewContext,
  minSeverity: GitLabReviewSeverity,
  userPrompt: string,
  deps: StageDeps,
): Promise<{ findings: AuthoredFinding[]; summary: string | null }> {
  const groups: AuthoredFinding[][] = REVIEW_ANGLES.map(() => []);
  const summaries: Array<string | null> = REVIEW_ANGLES.map(() => null);

  const tasks = REVIEW_ANGLES.map((angle, index) => async () => {
    // Fixed angle→model mapping: angle `i` runs on pool member `i % pool.length`.
    // Deterministic and stable for a given (MR, commit) — no randomness.
    const member = deps.pool[index % deps.pool.length];
    const agent = deps.createAgent({
      systemPrompt: buildAngleSystemPrompt(context, minSeverity, angle),
      model: member.model,
      tools: deps.tools,
      thinkingLevel: deps.thinkingLevel,
      getApiKey: member.getApiKey,
    });
    const detachTelemetry = deps.attachTelemetry?.(agent);
    try {
      const text = await runAgentToCompletion(agent, userPrompt, {
        timeoutMs: deps.timeoutMs,
        onAssistantMessage: (message) => accumulateUsage(deps.aggregated, message, member.id),
        onToolStart: (toolName, args) =>
          deps.logger.debug(`  [${angle.key}] → ${toolName}${formatToolArgs(toolName, args)}`),
      });
      const parsed = parseReviewMarkdownWithWarnings(text);
      // Annotate each finding with the model that authored it. This is internal
      // pipeline metadata for cross-family verification — it never reaches a
      // posted comment, fingerprint, or the summary.
      groups[index] = parsed.comments.map((comment) => ({ comment, authorModel: member.id }));
      summaries[index] = parsed.summary;
    } catch (error) {
      deps.logger.warn(`Find angle "${angle.key}" failed: ${(error as Error).message}; skipping.`);
    } finally {
      detachTelemetry?.();
    }
  });

  await runBounded(tasks, FIND_CONCURRENCY);

  const raw = groups.reduce((total, group) => total + group.length, 0);
  const findings = triageFindings(groups);
  deps.logger.info(
    `Multi-angle Find: ${REVIEW_ANGLES.length} angles → ${raw} raw finding(s), ${findings.length} after triage.`,
  );
  const summary = summaries.find((value) => value && value.trim()) ?? null;
  return { findings, summary };
}

/**
 * Verify + Synthesize, shared by `verify` and `full` depth. Hands each severe
 * (CRITICAL/WARN) finding to a separate adversarial agent that tries to refute
 * it, deterministically applies the verdicts, and synthesizes the canonical
 * `{ summary, comments }` JSON. INFO findings are not verified — they are not
 * the precision risk and re-checking them wastes tokens.
 */
async function verifyAndSynthesize(
  findings: AuthoredFinding[],
  summary: string | null,
  diff: string,
  commitLog: string | undefined,
  deps: StageDeps,
): Promise<string> {
  const comments = findings.map((f) => f.comment);
  const severe = findings
    .map((finding, index) => ({ finding, index }))
    .filter(
      ({ finding }) =>
        finding.comment.severity === 'critical' || finding.comment.severity === 'warn',
    );

  const verdicts = new Map<number, Verdict>();
  if (severe.length > 0) {
    // Disk input mode: verifiers read the staged files instead of an inline diff.
    const verifySystemPrompt = buildVerifySystemPrompt(diff, commitLog, deps.verifyStaged);
    const tasks = severe.map(({ finding, index }) => async () => {
      const comment = finding.comment;
      // Explicit --verify-model wins; otherwise a cross-family verifier: a pool
      // member other than the one that authored the finding (degenerates to the
      // author with a 1-model pool).
      const verifierMember = deps.verifyMember ?? pickVerifier(deps.pool, finding.authorModel);
      const verifier = deps.createAgent({
        systemPrompt: verifySystemPrompt,
        model: verifierMember.model,
        tools: deps.tools,
        thinkingLevel: deps.thinkingLevel,
        getApiKey: verifierMember.getApiKey,
      });
      const detachTelemetry = deps.attachTelemetry?.(verifier);
      try {
        const text = await runAgentToCompletion(verifier, buildVerifyUserPrompt(comment), {
          timeoutMs: deps.timeoutMs,
          onAssistantMessage: (message) =>
            accumulateUsage(deps.aggregated, message, verifierMember.id),
        });
        verdicts.set(index, parseVerdict(text));
      } catch (error) {
        deps.logger.warn(
          `Verify failed for ${comment.file}:${comment.line}: ${(error as Error).message}; keeping finding.`,
        );
        verdicts.set(index, { decision: 'keep', reason: 'verifier error; finding kept' });
      } finally {
        detachTelemetry?.();
      }
    });
    await runBounded(tasks, VERIFY_CONCURRENCY);
  }

  const result = applyVerdicts(comments, verdicts);
  const dropped = result.audit.filter((entry) => entry.action === 'dropped').length;
  const downgraded = result.audit.filter((entry) => entry.action === 'downgraded').length;
  deps.logger.info(
    `Verify: re-checked ${severe.length} severe finding(s) — ${dropped} dropped, ${downgraded} downgraded.`,
  );

  return synthesizeReviewJson(summary, result);
}

/**
 * `verify` depth wrapper: when the Find pass produced nothing severe, the model
 * output is returned verbatim (byte-identical to a plain Find); otherwise the
 * severe findings are verified and the review re-synthesized.
 */
async function runVerifyStage(
  finalText: string,
  diff: string,
  commitLog: string | undefined,
  deps: StageDeps,
): Promise<string> {
  const parsed = parseReviewMarkdownWithWarnings(finalText);
  const hasSevere = parsed.comments.some(
    (comment) => comment.severity === 'critical' || comment.severity === 'warn',
  );
  if (!hasSevere) return finalText;
  // `verify` depth has a single Find pass on the primary model, so all findings
  // are authored by `pool[0]`; the verifier picks a different member when one
  // exists, otherwise re-uses the primary (today's behaviour).
  const findings: AuthoredFinding[] = parsed.comments.map((comment) => ({
    comment,
    authorModel: deps.pool[0].id,
  }));
  return verifyAndSynthesize(findings, parsed.summary, diff, commitLog, deps);
}

function formatToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  if (toolName === 'Read' || toolName === 'read') {
    return typeof obj.file_path === 'string' ? ` ${obj.file_path}` : '';
  }
  if (toolName === 'Bash' || toolName === 'bash') {
    return typeof obj.command === 'string' ? ` ${obj.command.slice(0, 80)}` : '';
  }
  const entries = Object.entries(obj)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return entries.length > 0 ? ` ${entries.join(' ')}` : '';
}
