import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './errors.js';
import { git } from './git.js';

export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the SKILL.md file. Used to reference skill content in prompts. */
  filePath: string;
  rootDir: string;
  resourceDirs: string[];
  source: 'builtin' | 'project' | 'npm' | 'file' | 'git' | 'marketplace';
}

/**
 * A parsed skill spec descriptor. Produced by `parseSkillSpec`.
 *
 * - `builtin`  — bare name resolved from the package's bundled `skills/` dir
 * - `npm`      — package in `node_modules`, optionally with a sub-directory
 * - `file`     — explicit filesystem path (relative or absolute)
 * - `git`      — shallow git clone at a pinned ref, optionally with a sub-directory
 * - `marketplace` — a skill inside a Claude-plugin marketplace registered by name
 *   (resolved via its `.claude-plugin/marketplace.json`); see `marketplaces.ts`
 */
export type SkillSpec =
  | { protocol: 'builtin'; name: string }
  | { protocol: 'npm'; packageName: string; subpath: string }
  | { protocol: 'file'; path: string }
  | { protocol: 'git'; url: string; ref: string; subpath: string }
  | { protocol: 'marketplace'; marketplace: string; plugin: string; skill: string };

const SKILL_DIRS = ['.agents/skills', '.claude/skills'] as const;
const RESOURCE_DIRS = ['references'] as const;

function parseFrontmatter(content: string): { name: string; description: string } | null {
  // Locate the leading `---` … `---` fence, then hand the inner block to a real
  // YAML parser rather than matching keys with regex. Invalid YAML (e.g. an
  // unquoted value containing `: `) yields null and the skill is skipped.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== 'string' || typeof description !== 'string') return null;
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  if (!trimmedName || !trimmedDescription) return null;
  return { name: trimmedName, description: trimmedDescription };
}

export async function loadSkillFromDir(
  dirPath: string,
  source: Skill['source'],
): Promise<Skill | null> {
  const skillMdPath = join(dirPath, 'SKILL.md');
  let content: string;
  try {
    content = await readFile(skillMdPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  const resourceDirs = RESOURCE_DIRS.filter((d) => existsSync(join(dirPath, d)));
  return {
    name: parsed.name,
    description: parsed.description,
    filePath: skillMdPath,
    rootDir: dirPath,
    resourceDirs,
    source,
  };
}

export function resolveBuiltinSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

export async function loadBuiltinSkill(name: string): Promise<Skill | null> {
  return loadSkillFromDir(join(resolveBuiltinSkillsDir(), name), 'builtin');
}

export async function loadAutoDiscoveredSkills(
  cwd: string,
  gitRoot: string,
  warn?: (msg: string) => void,
): Promise<Skill[]> {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (current === gitRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Walk gitRoot → cwd so the last write wins (cwd-closest overrides ancestors)
  const found = new Map<string, Skill>();
  for (const dir of dirs) {
    for (const skillDir of SKILL_DIRS) {
      const skillsPath = join(dir, skillDir);
      let entries: string[];
      try {
        entries = await readdir(skillsPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const entryPath = join(skillsPath, entry);
        const skill = await loadSkillFromDir(entryPath, 'project');
        if (skill) {
          found.set(skill.name, skill);
        } else if (warn && existsSync(join(entryPath, 'SKILL.md'))) {
          warn(
            `Skill at ${entryPath} has a SKILL.md but is missing required frontmatter fields (name, description) — skill not loaded.`,
          );
        }
      }
    }
  }

  return [...found.values()];
}

/**
 * Parse a skill spec string into a typed `SkillSpec` descriptor.
 *
 * Supported spec formats:
 *
 * | Input                              | Result                                            |
 * |------------------------------------|---------------------------------------------------|
 * | `code-review`                      | `{ protocol: 'builtin', name: 'code-review' }`    |
 * | `npm:my-skill`                     | `{ protocol: 'npm', packageName: 'my-skill', ... }`|
 * | `npm:@scope/pkg`                   | `{ protocol: 'npm', packageName: '@scope/pkg', ... }`|
 * | `npm:@scope/bundle/security`       | `{ protocol: 'npm', packageName: '@scope/bundle', subpath: 'security' }`|
 * | `npm:bundle/security`              | `{ protocol: 'npm', packageName: 'bundle', subpath: 'security' }`|
 * | `file:./path/to/skill`             | `{ protocol: 'file', path: './path/to/skill' }`   |
 * | `file:/absolute/path`              | `{ protocol: 'file', path: '/absolute/path' }`    |
 * | `git:https://host/org/s.git`       | `{ protocol: 'git', url: 'https://host/org/s.git', ref: '', subpath: '' }` |
 * | `git:https://host/org/b.git#v1/sec`| `{ protocol: 'git', url: 'https://host/org/b.git', ref: 'v1', subpath: 'sec' }` |
 * | `git+ssh://git@host/org/s.git`     | `{ protocol: 'git', url: 'ssh://git@host/org/s.git', ref: '', subpath: '' }` |
 * | `acme:dev/aria-apg` (acme known)   | `{ protocol: 'marketplace', marketplace: 'acme', plugin: 'dev', skill: 'aria-apg' }` |
 *
 * A spec whose portion before the first `:` matches a registered marketplace
 * name (from `knownMarketplaces`) is parsed as a `marketplace` reference. The
 * remainder must be `<plugin>/<skill>` — an explicit skill is always required.
 */
export function parseSkillSpec(
  spec: string,
  knownMarketplaces: ReadonlySet<string> = new Set(),
): SkillSpec {
  if (spec.startsWith('file:')) {
    return { protocol: 'file', path: spec.slice('file:'.length) };
  }

  if (spec.startsWith('npm:')) {
    const rest = spec.slice('npm:'.length);
    if (rest.startsWith('@')) {
      // Scoped package: @scope/pkg[/subpath...]
      const parts = rest.split('/');
      if (parts.length < 2) {
        // Malformed scoped spec — treat the whole thing as the package name
        return { protocol: 'npm', packageName: rest, subpath: '' };
      }
      const packageName = `${parts[0]}/${parts[1]}`;
      const subpath = parts.slice(2).join('/');
      return { protocol: 'npm', packageName, subpath };
    }
    // Unscoped package: pkg[/subpath...]
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      return { protocol: 'npm', packageName: rest, subpath: '' };
    }
    return {
      protocol: 'npm',
      packageName: rest.slice(0, slashIdx),
      subpath: rest.slice(slashIdx + 1),
    };
  }

  // git: and git+ssh: (and other git+<transport>:// forms)
  if (spec.startsWith('git+') || spec.startsWith('git:')) {
    return parseGitSpec(spec);
  }

  // <marketplace>:<plugin>/<skill> — only when the prefix names a registered
  // marketplace, so a bare skill name with no colon still resolves as builtin.
  const colonIdx = spec.indexOf(':');
  if (colonIdx > 0 && knownMarketplaces.has(spec.slice(0, colonIdx))) {
    return parseMarketplaceSkillSpec(spec, colonIdx);
  }

  // Bare name → builtin
  return { protocol: 'builtin', name: spec };
}

/**
 * Parse the `<marketplace>:<plugin>/<skill>` selector into its parts. The
 * marketplace name has already been matched against the registry by the caller;
 * `colonIdx` is the index of the separating `:`. Throws a `ConfigError` when the
 * `<plugin>/<skill>` remainder is malformed (a skill name is always required).
 */
function parseMarketplaceSkillSpec(
  spec: string,
  colonIdx: number,
): Extract<SkillSpec, { protocol: 'marketplace' }> {
  const marketplace = spec.slice(0, colonIdx);
  const rest = spec.slice(colonIdx + 1);
  const slashIdx = rest.indexOf('/');
  const plugin = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const skill = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
  if (!plugin || !skill || skill.includes('/')) {
    throw new ConfigError(`Cannot load skill: "${spec}"`, {
      hint: `Marketplace skills use the form "<marketplace>:<plugin>/<skill>", e.g. "${marketplace}:dev/aria-apg".`,
    });
  }
  return { protocol: 'marketplace', marketplace, plugin, skill };
}

/**
 * Parse a `git:` / `git+ssh:` skill spec into its URL, pinned ref, and subpath.
 *
 * - `git:<url>`         strips the `git:` marker; what follows is the clone URL
 *   (e.g. `git:https://host/org/repo.git`).
 * - `git+<transport>://…` strips the leading `git+`, leaving a URL git
 *   understands directly (`git+ssh://git@host/…` → `ssh://git@host/…`), matching
 *   npm's `package.json` git-dependency convention.
 *
 * An optional `#<ref>[/<subpath>]` fragment pins the ref (tag, branch, or
 * commit) and, after the first `/`, points at a skill directory inside the repo.
 */
function parseGitSpec(spec: string): Extract<SkillSpec, { protocol: 'git' }> {
  const raw = spec.startsWith('git+') ? spec.slice('git+'.length) : spec.slice('git:'.length);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Not a standard URL (e.g. scp-style `git@host:org/repo.git`, which is
    // intentionally unsupported to avoid `:`/`#` ambiguity). Hand the raw value
    // to git unchanged with no ref/subpath rather than rejecting outright.
    return { protocol: 'git', url: raw, ref: '', subpath: '' };
  }

  // The `#<ref>[/<subpath>]` fragment is our own convention layered on top of
  // the URL: the ref ends at the first `/`, the rest points at a skill dir.
  const fragment = parsed.hash ? parsed.hash.slice(1) : '';
  parsed.hash = '';
  const url = parsed.toString();
  const slashIdx = fragment.indexOf('/');
  if (slashIdx === -1) {
    return { protocol: 'git', url, ref: fragment, subpath: '' };
  }
  return {
    protocol: 'git',
    url,
    ref: fragment.slice(0, slashIdx),
    subpath: fragment.slice(slashIdx + 1),
  };
}

/**
 * Resolve the directory for an npm-installed skill by walking `node_modules`
 * upward from `cwd` (supports monorepo hoisting). Returns the resolved path
 * or `null` if the package / subpath cannot be found.
 */
export async function resolveNpmSkillDir(
  packageName: string,
  subpath: string,
  cwd: string,
): Promise<string | null> {
  let current = cwd;
  while (true) {
    const candidate = subpath
      ? join(current, 'node_modules', packageName, subpath)
      : join(current, 'node_modules', packageName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Strip a leading `git+` transport marker (`git+ssh://…` → `ssh://…`). */
export function normalizeGitUrl(raw: string): string {
  return raw.startsWith('git+') ? raw.slice('git+'.length) : raw;
}

/**
 * Remove embedded credentials from a URL so it is safe to show in logs, hints,
 * and errors. `https://user:token@host/path` becomes `https://***@host/path`.
 * Non-URL strings are returned with a best-effort `//user@` → `//***@` scrub.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^/@]+@/, '//***@');
  }
}

/** Base directory for cached git-skill clones (honours `XDG_CACHE_HOME`). */
export function resolveSkillCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache');
  return join(base, 'code-review', 'skills');
}

/**
 * Stable cache-directory name for a git skill. Keyed on the clone URL plus the
 * pinned ref so that two refs of the same repo never share a cache entry.
 */
export function gitSkillCacheKey(url: string, ref: string): string {
  return createHash('sha256').update(`${url}#${ref}`).digest('hex').slice(0, 16);
}

/**
 * Shallow-clone `url` at `ref` into `dir`. Using init + a single-ref fetch +
 * `checkout FETCH_HEAD` (rather than `clone --branch`) means a branch, tag, or
 * commit SHA all resolve through the same path; an empty `ref` fetches the
 * remote's default branch via `HEAD`.
 */
async function gitShallowClone(url: string, ref: string, dir: string): Promise<void> {
  await git(['init', '--quiet', dir]);
  await git(['remote', 'add', 'origin', url], { cwd: dir });
  await git(['fetch', '--depth', '1', '--quiet', 'origin', ref || 'HEAD'], { cwd: dir });
  await git(['checkout', '--quiet', 'FETCH_HEAD'], { cwd: dir });
}

/**
 * Resolve a git URL + ref to a local clone directory, reusing the on-disk cache
 * when possible. The clone lands in a temp sibling first and is renamed into
 * place atomically, so a crashed or concurrent clone never leaves a half-written
 * cache entry. With `refresh`, any cached copy is discarded first. Shared by
 * `git:` skills and Claude-plugin marketplaces (see `marketplaces.ts`).
 */
export async function cloneGitRepo(
  url: string,
  ref: string,
  options: { cacheDir: string; refresh: boolean },
): Promise<string> {
  const repoDir = join(options.cacheDir, gitSkillCacheKey(url, ref));

  if (options.refresh) {
    await rm(repoDir, { recursive: true, force: true });
  } else if (existsSync(join(repoDir, '.git'))) {
    return repoDir;
  } else if (existsSync(repoDir)) {
    // A leftover dir without `.git` is a partial/corrupt prior clone — drop it.
    await rm(repoDir, { recursive: true, force: true });
  }

  await mkdir(options.cacheDir, { recursive: true });
  const tmpDir = `${repoDir}.tmp-${process.pid}`;
  await rm(tmpDir, { recursive: true, force: true });
  try {
    await gitShallowClone(url, ref, tmpDir);
    try {
      await rename(tmpDir, repoDir);
    } catch (error) {
      // A concurrent clone won the race and populated `repoDir` first — reuse it.
      if (existsSync(join(repoDir, '.git'))) {
        await rm(tmpDir, { recursive: true, force: true });
        return repoDir;
      }
      throw error;
    }
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
  return repoDir;
}

/** Options controlling how external skills are resolved. */
export interface LoadNamedSkillOptions {
  /** Override the git-skill clone cache directory (defaults to the XDG cache). */
  cacheDir?: string;
  /** Re-clone git skills even when a cached copy exists. */
  refresh?: boolean;
}

/**
 * Load a skill by its spec string (`code-review`, `npm:@scope/pkg`, `file:./path`,
 * `git:https://…`, …).
 *
 * Resolution order:
 * 1. `builtin` — package-bundled `skills/<name>/`
 * 2. `npm:`    — `node_modules/<packageName>[/subpath]` walked up from `cwd`
 * 3. `file:`   — direct filesystem path (relative paths resolved from `cwd`)
 * 4. `git:` / `git+ssh:` — shallow clone at the pinned ref, cached on disk,
 *    loading `SKILL.md` from the repo root or the `#<ref>/<subpath>` directory
 *
 * Throws a `ConfigError` if the spec cannot be resolved or the resolved
 * directory does not contain a valid `SKILL.md`.
 */
export async function loadNamedSkill(
  spec: string,
  cwd: string,
  options: LoadNamedSkillOptions = {},
): Promise<Skill> {
  const parsed = parseSkillSpec(spec);

  if (parsed.protocol === 'builtin') {
    const skill = await loadBuiltinSkill(parsed.name);
    if (!skill) {
      throw new ConfigError(`Cannot load skill: "${spec}"`, {
        hint: `No built-in skill named "${parsed.name}" was found. Check the skill name, or use npm: / file: to reference external skills.`,
      });
    }
    return skill;
  }

  if (parsed.protocol === 'npm') {
    const dir = await resolveNpmSkillDir(parsed.packageName, parsed.subpath, cwd);
    if (dir === null) {
      const pkgRef = parsed.subpath
        ? `${parsed.packageName} (subpath "${parsed.subpath}")`
        : parsed.packageName;
      throw new ConfigError(`Cannot load skill: "${spec}"`, {
        hint: `Package ${pkgRef} was not found in node_modules. Run \`npm install ${parsed.packageName}\` in the project.`,
      });
    }
    const skill = await loadSkillFromDir(dir, 'npm');
    if (!skill) {
      throw new ConfigError(`Cannot load skill: "${spec}"`, {
        hint: `The package at ${dir} does not contain a valid SKILL.md.`,
      });
    }
    return skill;
  }

  if (parsed.protocol === 'file') {
    const resolvedPath = parsed.path.startsWith('/') ? parsed.path : join(cwd, parsed.path);
    const skill = await loadSkillFromDir(resolvedPath, 'file');
    if (!skill) {
      throw new ConfigError(`Cannot load skill: "${spec}"`, {
        hint: `No valid SKILL.md was found at "${resolvedPath}". Check that the path points to a skill directory.`,
      });
    }
    return skill;
  }

  if (parsed.protocol === 'marketplace') {
    // Marketplace specs are dispatched to `loadMarketplaceSkill` before reaching
    // here (this function's own `parseSkillSpec` call passes no known
    // marketplaces, so this branch is unreachable in practice). Guard defensively
    // and narrow the type for the `git` block below.
    throw new ConfigError(`Cannot load skill: "${spec}"`, {
      hint: 'Marketplace skills must be resolved through a registered marketplace, not loaded directly.',
    });
  }

  // git: / git+ssh: — shallow clone at a pinned ref, then load from the cache.
  let repoDir: string;
  try {
    repoDir = await cloneGitRepo(parsed.url, parsed.ref, {
      cacheDir: options.cacheDir ?? resolveSkillCacheDir(),
      refresh: options.refresh ?? false,
    });
  } catch (error) {
    const atRef = parsed.ref ? ` at ref "${parsed.ref}"` : '';
    throw new ConfigError(`Cannot load skill: "${spec}"`, {
      cause: error,
      hint: `Failed to clone "${redactUrl(parsed.url)}"${atRef}. Check the URL, the ref, and your git credentials. For GitLab, prefer the SSH form: git+ssh://git@host/group/project.git`,
    });
  }

  const skillDir = parsed.subpath ? join(repoDir, parsed.subpath) : repoDir;
  const skill = await loadSkillFromDir(skillDir, 'git');
  if (!skill) {
    throw new ConfigError(`Cannot load skill: "${spec}"`, {
      hint: parsed.subpath
        ? `The cloned repository has no valid SKILL.md at subpath "${parsed.subpath}".`
        : 'The cloned repository has no valid SKILL.md at its root. If the skill lives in a subdirectory, point at it with "#<ref>/<subpath>".',
    });
  }
  return skill;
}
