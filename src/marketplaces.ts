import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ConfigError } from './errors.js';
import {
  cloneGitRepo,
  loadSkillFromDir,
  normalizeGitUrl,
  redactUrl,
  resolveSkillCacheDir,
  type Skill,
  type SkillSpec,
} from './skills.js';

/**
 * Marketplace manifest formats we know how to read. Different vendors ship the
 * same open SKILL.md standard but package it differently: Claude Code uses a
 * `.claude-plugin/marketplace.json` catalog (`anthropic`), OpenAI Codex uses a
 * `.codex-plugin/` layout (a future `codex` format). Only `anthropic` is
 * implemented today; the type is the extension point for the rest.
 */
export const MARKETPLACE_FORMATS = ['anthropic'] as const;
export type MarketplaceFormat = (typeof MARKETPLACE_FORMATS)[number];

/** The default format assumed when a marketplace declaration omits a prefix. */
export const DEFAULT_MARKETPLACE_FORMAT: MarketplaceFormat = 'anthropic';

/**
 * Marketplace names that collide with skill-spec protocol prefixes
 * (`npm:`, `file:`, `git:`) or the bare-name builtin lookup, and so cannot be
 * used as a marketplace name — `<name>:<plugin>/<skill>` would be ambiguous.
 */
export const RESERVED_MARKETPLACE_NAMES: ReadonlySet<string> = new Set([
  'npm',
  'file',
  'git',
  'builtin',
]);

/** A registered marketplace: a git repo cloned once, then read per its format. */
export interface MarketplaceRef {
  /** Short name used in skill specs (`<name>:<plugin>/<skill>`). */
  name: string;
  format: MarketplaceFormat;
  /** Clone URL (credentials may be embedded; always redact before logging). */
  url: string;
  /** Pinned ref (tag/branch/SHA); empty resolves the remote's default branch. */
  ref: string;
}

export type MarketplaceRegistry = ReadonlyMap<string, MarketplaceRef>;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A leading `<token>:` that is NOT part of a URL scheme (`https://`, `ssh://`).
// The negative lookahead on `//` is what distinguishes a format tag from a
// scheme, so `anthropic:https://…` splits but `https://…` does not.
const FORMAT_PREFIX_PATTERN = /^([a-z][a-z0-9-]*):(?!\/\/)/;

/**
 * Parse a single marketplace declaration: `<name>=<[format:]url[#ref]>`.
 *
 * - `acme=https://host/group/tools.git#1.0.0` → default `anthropic` format
 * - `acme=anthropic:https://host/group/tools.git#1.0.0` → explicit format
 * - `acme=git+ssh://git@host/group/tools.git#main` → SSH transport
 *
 * The `#<ref>` fragment is taken whole as the ref (branch names may contain
 * `/`). Throws a `ConfigError` with an actionable hint on any malformed input.
 */
export function parseMarketplaceEntry(entry: string): MarketplaceRef {
  const eqIdx = entry.indexOf('=');
  if (eqIdx <= 0) {
    throw new ConfigError(`Invalid marketplace declaration: "${entry}"`, {
      hint: 'Use <name>=<git-url>[#ref], e.g. acme=https://host/group/tools.git#1.0.0.',
    });
  }
  const name = entry.slice(0, eqIdx).trim();
  if (!NAME_PATTERN.test(name)) {
    throw new ConfigError(`Invalid marketplace name: "${name}"`, {
      hint: 'Names must start with a letter or digit and contain only letters, digits, ".", "_", or "-".',
    });
  }
  if (RESERVED_MARKETPLACE_NAMES.has(name)) {
    throw new ConfigError(`Marketplace name "${name}" is reserved`, {
      hint: `Choose another name — ${[...RESERVED_MARKETPLACE_NAMES].join(', ')} collide with skill-spec protocols.`,
    });
  }

  let rhs = entry.slice(eqIdx + 1).trim();
  let format: MarketplaceFormat = DEFAULT_MARKETPLACE_FORMAT;
  const formatMatch = rhs.match(FORMAT_PREFIX_PATTERN);
  if (formatMatch) {
    const token = formatMatch[1];
    if (!(MARKETPLACE_FORMATS as readonly string[]).includes(token)) {
      throw new ConfigError(`Unknown marketplace format "${token}" in "${entry}"`, {
        hint: `Supported formats: ${MARKETPLACE_FORMATS.join(', ')}. Omit the prefix (e.g. "${name}=https://…") to default to "${DEFAULT_MARKETPLACE_FORMAT}".`,
      });
    }
    format = token as MarketplaceFormat;
    rhs = rhs.slice(formatMatch[0].length);
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizeGitUrl(rhs));
  } catch {
    throw new ConfigError(`Invalid marketplace URL for "${name}": "${redactUrl(rhs)}"`, {
      hint: 'Expected a git URL like https://host/group/tools.git or git+ssh://git@host/group/tools.git. scp-style (git@host:group/repo.git) is not supported — use the ssh:// form.',
    });
  }
  const ref = parsed.hash ? parsed.hash.slice(1) : '';
  parsed.hash = '';
  return { name, format, url: parsed.toString(), ref };
}

/**
 * Build a name→ref registry from parsed marketplace declarations, rejecting
 * duplicate names (a later entry silently shadowing an earlier one is a config
 * bug worth surfacing).
 */
export function buildMarketplaceRegistry(refs: readonly MarketplaceRef[]): MarketplaceRegistry {
  const registry = new Map<string, MarketplaceRef>();
  for (const ref of refs) {
    if (registry.has(ref.name)) {
      throw new ConfigError(`Duplicate marketplace name "${ref.name}"`, {
        hint: 'Each marketplace must be declared once. Remove the duplicate declaration.',
      });
    }
    registry.set(ref.name, ref);
  }
  return registry;
}

/** Minimal shape of a plugin entry in a `.claude-plugin/marketplace.json`. */
interface AnthropicPluginEntry {
  name?: unknown;
  source?: unknown;
  /** Extra skill directories, added to the default `skills/` scan. */
  skills?: unknown;
  /** When `false`, the marketplace entry is the sole component definition. */
  strict?: unknown;
}

/** Minimal shape of the fields we read from a `.claude-plugin/marketplace.json`. */
interface AnthropicMarketplaceManifest {
  metadata?: { pluginRoot?: unknown };
  plugins?: AnthropicPluginEntry[];
}

/** Minimal shape of the fields we read from a plugin's `.claude-plugin/plugin.json`. */
interface AnthropicPluginManifest {
  skills?: unknown;
}

type MarketplaceSkillSpec = Extract<SkillSpec, { protocol: 'marketplace' }>;

/**
 * Resolve a `<marketplace>:<plugin>/<skill>` reference to a loaded {@link Skill}.
 *
 * Clones the marketplace repo (reusing the shared on-disk clone cache), then
 * dispatches to the format-specific resolver. Throws a `ConfigError` with a
 * redacted, actionable hint when the marketplace, plugin, or skill cannot be
 * resolved — the caller treats that as a skip-and-warn, not a fatal error.
 */
export async function loadMarketplaceSkill(
  spec: MarketplaceSkillSpec,
  registry: MarketplaceRegistry,
  options: { cacheDir?: string; refresh?: boolean } = {},
): Promise<Skill> {
  const ref = `${spec.marketplace}:${spec.plugin}/${spec.skill}`;
  const mp = registry.get(spec.marketplace);
  if (!mp) {
    throw new ConfigError(`Cannot load skill: "${ref}"`, {
      hint: `No marketplace named "${spec.marketplace}" is registered. Declare it with CODE_REVIEW_MARKETPLACES or --marketplace.`,
    });
  }

  let repoDir: string;
  try {
    repoDir = await cloneGitRepo(mp.url, mp.ref, {
      cacheDir: options.cacheDir ?? resolveSkillCacheDir(),
      refresh: options.refresh ?? false,
    });
  } catch (error) {
    const atRef = mp.ref ? ` at ref "${mp.ref}"` : '';
    throw new ConfigError(`Cannot load marketplace "${mp.name}"`, {
      cause: error,
      hint: `Failed to clone "${redactUrl(mp.url)}"${atRef}. Check the URL, the ref, and your git credentials. For private GitLab, prefer git+ssh://git@host/group/project.git.`,
    });
  }

  switch (mp.format) {
    case 'anthropic':
      return resolveAnthropicSkill(repoDir, mp, spec);
    default: {
      const exhaustive: never = mp.format;
      throw new ConfigError(`Unsupported marketplace format: "${String(exhaustive)}"`, {
        hint: `Supported formats: ${MARKETPLACE_FORMATS.join(', ')}.`,
      });
    }
  }
}

/** Resolve a skill inside a Claude Code (`anthropic`) plugin marketplace. */
async function resolveAnthropicSkill(
  repoDir: string,
  mp: MarketplaceRef,
  spec: MarketplaceSkillSpec,
): Promise<Skill> {
  const ref = `${mp.name}:${spec.plugin}/${spec.skill}`;
  const manifestPath = join(repoDir, '.claude-plugin', 'marketplace.json');
  let manifest: AnthropicMarketplaceManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as AnthropicMarketplaceManifest;
  } catch (error) {
    throw new ConfigError(`Marketplace "${mp.name}" is not a valid Anthropic plugin marketplace`, {
      cause: error,
      hint: `Expected a readable .claude-plugin/marketplace.json at "${redactUrl(mp.url)}"${mp.ref ? ` (ref "${mp.ref}")` : ''}.`,
    });
  }

  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  const entry = plugins.find((p) => p && p.name === spec.plugin);
  if (!entry) {
    const available = plugins
      .map((p) => (typeof p?.name === 'string' ? p.name : null))
      .filter((n): n is string => Boolean(n));
    throw new ConfigError(`Plugin "${spec.plugin}" not found in marketplace "${mp.name}"`, {
      hint: available.length
        ? `Available plugins: ${available.join(', ')}.`
        : 'The marketplace lists no plugins.',
    });
  }

  const pluginDir = resolvePluginDir(repoDir, manifest, entry.source, mp, spec);
  const pluginManifest = await readPluginManifest(pluginDir);
  const bases = computeSkillBases(repoDir, pluginDir, entry, pluginManifest, ref);

  const skill = await findSkillInBases(repoDir, bases, pluginDir, spec.skill, ref);
  if (!skill) {
    throw new ConfigError(`Cannot load skill: "${ref}"`, {
      hint: `No skill "${spec.skill}" found in plugin "${spec.plugin}". Looked under the default skills/ directory${bases.length > 1 ? ' and the plugin\'s custom "skills" paths' : ''}. Check the skill name against the marketplace.`,
    });
  }
  return skill;
}

/** Read a plugin's optional `.claude-plugin/plugin.json`; returns null if absent. */
async function readPluginManifest(pluginDir: string): Promise<AnthropicPluginManifest | null> {
  try {
    const raw = await readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8');
    return JSON.parse(raw) as AnthropicPluginManifest;
  } catch {
    return null;
  }
}

/** Normalize a `skills`/`commands` manifest field (string | string[]) to a path list. */
function toPathArray(value: unknown): string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Compute the directories to search for a named skill, per the plugin schema:
 * the default `<plugin>/skills/` scan plus any directories declared in the
 * `skills` field of the marketplace entry and (unless `strict: false`) the
 * plugin's own `plugin.json`. When the plugin source resolves to the marketplace
 * root and the entry lists specific `skills` subdirectories, those replace the
 * default scan rather than adding to it.
 */
function computeSkillBases(
  repoDir: string,
  pluginDir: string,
  entry: AnthropicPluginEntry,
  pluginManifest: AnthropicPluginManifest | null,
  ref: string,
): string[] {
  const strict = entry.strict !== false;
  const entrySkills = toPathArray(entry.skills);
  const declared = strict ? [...entrySkills, ...toPathArray(pluginManifest?.skills)] : entrySkills;
  const custom = declared.map((p) => resolveUnderPlugin(repoDir, pluginDir, p, ref));

  const rootSourceException = resolve(pluginDir) === resolve(repoDir) && entrySkills.length > 0;
  const bases = rootSourceException ? custom : [join(pluginDir, 'skills'), ...custom];
  return [...new Set(bases)];
}

/** Resolve a plugin-relative `skills` path to an absolute dir, guarding escapes. */
function resolveUnderPlugin(repoDir: string, pluginDir: string, rel: string, ref: string): string {
  let p = rel.trim();
  if (p === '.' || p === './') {
    p = '';
  } else if (p.startsWith('./')) {
    p = p.slice(2);
  }
  const dir = join(pluginDir, p);
  ensureInside(repoDir, dir, ref);
  return dir;
}

/**
 * Find `skillName` across the candidate base directories. Each base is either a
 * container of skill sub-directories (`<base>/<skill>/SKILL.md`) or a single
 * skill directory (`<base>/SKILL.md`, matched by its frontmatter `name`). Falls
 * back to a single `SKILL.md` at the plugin root (single-skill plugins).
 *
 * Every candidate is verified with {@link loadSkillIfInside} to resolve through
 * symlinks and reject any directory that escapes the cloned marketplace before a
 * file is read.
 */
async function findSkillInBases(
  repoDir: string,
  bases: string[],
  pluginDir: string,
  skillName: string,
  ref: string,
): Promise<Skill | null> {
  const realRoot = await realpath(repoDir);
  for (const base of bases) {
    // `skillName` is validated to contain no `/`, so this stays within `base`.
    const container = await loadSkillIfInside(realRoot, join(base, skillName), ref);
    if (container) return container;
    const single = await loadSkillIfInside(realRoot, base, ref);
    if (single && single.name === skillName) return single;
  }
  const root = await loadSkillIfInside(realRoot, pluginDir, ref);
  return root && root.name === skillName ? root : null;
}

/**
 * Load a skill from `dir` only if its real path stays within `realRoot`. A
 * missing directory resolves to `null` (nothing to read); a directory that
 * resolves — through `..` or a symlink — outside the marketplace throws a
 * `ConfigError`, so a malicious manifest cannot read files outside the clone.
 */
async function loadSkillIfInside(
  realRoot: string,
  dir: string,
  ref: string,
): Promise<Skill | null> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch {
    return null; // does not exist — nothing is read
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ConfigError(`Refusing to load "${ref}": path escapes the marketplace repository`, {
      hint: 'A plugin "source" or skill directory resolved (via ".." or a symlink) outside the cloned marketplace.',
    });
  }
  return loadSkillFromDir(real, 'marketplace');
}

/**
 * Resolve a plugin entry's `source` to an absolute directory inside the cloned
 * marketplace. Honors `metadata.pluginRoot` for bare (non-`./`) sources, per the
 * marketplace schema. Remote sources (github/url/git-subdir/npm) are rejected —
 * we only resolve plugins that live in the marketplace repository itself.
 */
function resolvePluginDir(
  repoDir: string,
  manifest: AnthropicMarketplaceManifest,
  source: unknown,
  mp: MarketplaceRef,
  spec: MarketplaceSkillSpec,
): string {
  const ref = `${mp.name}:${spec.plugin}/${spec.skill}`;
  if (typeof source !== 'string' || !source.trim()) {
    throw new ConfigError(
      `Plugin "${spec.plugin}" in marketplace "${mp.name}" has no local source`,
      {
        hint: 'Only plugins whose "source" is a relative path within the marketplace repo are supported. Remote plugin sources (github/url/git-subdir/npm) are not fetched.',
      },
    );
  }

  let rel = source.trim();
  if (rel === '.' || rel === './') {
    rel = '';
  } else if (rel.startsWith('./')) {
    rel = rel.slice(2);
  } else {
    const pluginRoot =
      typeof manifest.metadata?.pluginRoot === 'string' ? manifest.metadata.pluginRoot.trim() : '';
    const root = pluginRoot.startsWith('./') ? pluginRoot.slice(2) : pluginRoot;
    rel = root ? `${root.replace(/\/+$/, '')}/${rel}` : rel;
  }

  const dir = join(repoDir, rel);
  ensureInside(repoDir, dir, ref);
  return dir;
}

/** Guard against `..`/symlink escapes: `target` must stay within `root`. */
function ensureInside(root: string, target: string, ref: string): void {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  if (targetResolved !== rootResolved && !targetResolved.startsWith(rootResolved + sep)) {
    throw new ConfigError(`Refusing to load "${ref}": path escapes the marketplace repository`, {
      hint: 'A plugin "source" or skill path resolved outside the cloned marketplace. Check the marketplace manifest.',
    });
  }
}
