import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from './errors.js';
import {
  gitSkillCacheKey,
  loadAutoDiscoveredSkills,
  loadNamedSkill,
  loadSkillFromDir,
  normalizeGitUrl,
  parseSkillSpec,
  redactUrl,
  resolveNpmSkillDir,
  resolveSkillCacheDir,
} from './skills.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _tmpSeq = 0;
async function makeTmp(prefix = 'skills-test-'): Promise<string> {
  const dir = join(tmpdir(), `${prefix}${process.pid}-${++_tmpSeq}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeSkillMd(
  dir: string,
  name: string,
  description: string,
  body = '',
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// parseSkillSpec
// ---------------------------------------------------------------------------

describe('parseSkillSpec', () => {
  describe('builtin (bare name)', () => {
    it('returns builtin protocol for a bare name', () => {
      expect(parseSkillSpec('code-review')).toEqual({ protocol: 'builtin', name: 'code-review' });
    });

    it('returns builtin for a name without any prefix', () => {
      expect(parseSkillSpec('my-skill')).toEqual({ protocol: 'builtin', name: 'my-skill' });
    });

    it('returns builtin protocol for the test-integrity skill name', () => {
      expect(parseSkillSpec('test-integrity')).toEqual({
        protocol: 'builtin',
        name: 'test-integrity',
      });
    });

    it('returns builtin for a name with only alphanumerics and hyphens', () => {
      expect(parseSkillSpec('security123')).toEqual({ protocol: 'builtin', name: 'security123' });
    });
  });

  describe('npm: protocol', () => {
    it('parses an unscoped package without subpath', () => {
      expect(parseSkillSpec('npm:my-skill')).toEqual({
        protocol: 'npm',
        packageName: 'my-skill',
        subpath: '',
      });
    });

    it('parses an unscoped package with a subpath', () => {
      expect(parseSkillSpec('npm:skills-bundle/security')).toEqual({
        protocol: 'npm',
        packageName: 'skills-bundle',
        subpath: 'security',
      });
    });

    it('parses an unscoped package with a multi-segment subpath', () => {
      expect(parseSkillSpec('npm:bundle/a/b')).toEqual({
        protocol: 'npm',
        packageName: 'bundle',
        subpath: 'a/b',
      });
    });

    it('parses a scoped package without subpath', () => {
      expect(parseSkillSpec('npm:@company/security-skill')).toEqual({
        protocol: 'npm',
        packageName: '@company/security-skill',
        subpath: '',
      });
    });

    it('parses a scoped package with a single subpath segment', () => {
      expect(parseSkillSpec('npm:@company/skills-bundle/security')).toEqual({
        protocol: 'npm',
        packageName: '@company/skills-bundle',
        subpath: 'security',
      });
    });

    it('parses a scoped package with a multi-segment subpath', () => {
      expect(parseSkillSpec('npm:@company/skills-bundle/a/b')).toEqual({
        protocol: 'npm',
        packageName: '@company/skills-bundle',
        subpath: 'a/b',
      });
    });

    it('handles a malformed scoped spec missing the package name', () => {
      // @scope alone (no slash) → treated as packageName = '@scope', subpath = ''
      expect(parseSkillSpec('npm:@scope')).toEqual({
        protocol: 'npm',
        packageName: '@scope',
        subpath: '',
      });
    });
  });

  describe('file: protocol', () => {
    it('parses a relative path', () => {
      expect(parseSkillSpec('file:./path/to/skill')).toEqual({
        protocol: 'file',
        path: './path/to/skill',
      });
    });

    it('parses an absolute path', () => {
      expect(parseSkillSpec('file:/absolute/path/to/skill')).toEqual({
        protocol: 'file',
        path: '/absolute/path/to/skill',
      });
    });

    it('preserves the path exactly as-is', () => {
      expect(parseSkillSpec('file:../../sibling-skill')).toEqual({
        protocol: 'file',
        path: '../../sibling-skill',
      });
    });
  });

  describe('git: protocol', () => {
    it('parses a git: HTTPS URL without a fragment', () => {
      expect(parseSkillSpec('git:https://github.com/org/skill.git')).toEqual({
        protocol: 'git',
        url: 'https://github.com/org/skill.git',
        ref: '',
        subpath: '',
      });
    });

    it('parses a #ref fragment as the ref', () => {
      expect(parseSkillSpec('git:https://github.com/org/skill.git#main')).toEqual({
        protocol: 'git',
        url: 'https://github.com/org/skill.git',
        ref: 'main',
        subpath: '',
      });
    });

    it('parses a #ref/subpath fragment into ref and subpath', () => {
      expect(parseSkillSpec('git:https://github.com/org/bundle.git#main/security')).toEqual({
        protocol: 'git',
        url: 'https://github.com/org/bundle.git',
        ref: 'main',
        subpath: 'security',
      });
    });

    it('keeps a multi-segment subpath after the ref', () => {
      expect(parseSkillSpec('git:https://github.com/org/bundle.git#v1.2.3/a/b')).toEqual({
        protocol: 'git',
        url: 'https://github.com/org/bundle.git',
        ref: 'v1.2.3',
        subpath: 'a/b',
      });
    });

    it('treats a commit SHA as the ref', () => {
      expect(parseSkillSpec('git:https://github.com/org/skill.git#0123abc')).toEqual({
        protocol: 'git',
        url: 'https://github.com/org/skill.git',
        ref: '0123abc',
        subpath: '',
      });
    });

    it('rewrites git+ssh:// to an ssh:// URL git understands', () => {
      expect(parseSkillSpec('git+ssh://git@gitlab.com/org/skill.git')).toEqual({
        protocol: 'git',
        url: 'ssh://git@gitlab.com/org/skill.git',
        ref: '',
        subpath: '',
      });
    });

    it('parses a ref and subpath on a git+ssh:// URL', () => {
      expect(parseSkillSpec('git+ssh://git@gitlab.com/org/bundle.git#release/sub')).toEqual({
        protocol: 'git',
        url: 'ssh://git@gitlab.com/org/bundle.git',
        ref: 'release',
        subpath: 'sub',
      });
    });

    it('hands a non-URL value (scp-style shorthand) to git unchanged', () => {
      // `new URL` rejects scp shorthand; rather than erroring, the raw value is
      // passed through to git with no ref/subpath.
      expect(parseSkillSpec('git:git@gitlab.com:org/skill.git')).toEqual({
        protocol: 'git',
        url: 'git@gitlab.com:org/skill.git',
        ref: '',
        subpath: '',
      });
    });
  });

  describe('marketplace protocol', () => {
    const known = new Set(['acme', 'beta']);

    it('parses <marketplace>:<plugin>/<skill> when the name is registered', () => {
      expect(parseSkillSpec('acme:dev/aria-apg', known)).toEqual({
        protocol: 'marketplace',
        marketplace: 'acme',
        plugin: 'dev',
        skill: 'aria-apg',
      });
    });

    it('treats a colon spec as a builtin name when the prefix is not registered', () => {
      expect(parseSkillSpec('unknown:dev/aria-apg', known)).toEqual({
        protocol: 'builtin',
        name: 'unknown:dev/aria-apg',
      });
    });

    it('defaults to builtin when no marketplaces are known', () => {
      expect(parseSkillSpec('acme:dev/aria-apg')).toEqual({
        protocol: 'builtin',
        name: 'acme:dev/aria-apg',
      });
    });

    it('throws when the skill part is missing (explicit skill required)', () => {
      expect(() => parseSkillSpec('acme:dev', known)).toThrow(ConfigError);
    });

    it('throws when the skill part contains a slash', () => {
      expect(() => parseSkillSpec('acme:dev/a/b', known)).toThrow(ConfigError);
    });

    it('does not shadow the npm:/git:/file: protocols', () => {
      const withNpm = new Set(['npm']);
      expect(parseSkillSpec('npm:my-skill', withNpm)).toEqual({
        protocol: 'npm',
        packageName: 'my-skill',
        subpath: '',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeGitUrl / redactUrl
// ---------------------------------------------------------------------------

describe('normalizeGitUrl', () => {
  it('strips a leading git+ transport marker', () => {
    expect(normalizeGitUrl('git+ssh://git@host/org/repo.git')).toBe('ssh://git@host/org/repo.git');
  });

  it('leaves a plain URL unchanged', () => {
    expect(normalizeGitUrl('https://host/org/repo.git')).toBe('https://host/org/repo.git');
  });
});

describe('redactUrl', () => {
  it('replaces embedded credentials with ***', () => {
    expect(redactUrl('https://ci-bot:secret-token@gitlab.example.com/tools/acme-tools.git')).toBe(
      'https://***@gitlab.example.com/tools/acme-tools.git',
    );
  });

  it('leaves a credential-free URL unchanged', () => {
    expect(redactUrl('https://gitlab.example.com/tools/acme-tools.git')).toBe(
      'https://gitlab.example.com/tools/acme-tools.git',
    );
  });

  it('best-effort scrubs a non-URL string with userinfo', () => {
    expect(redactUrl('ssh://git:token@host:org/repo.git')).toContain('***@');
  });
});

// ---------------------------------------------------------------------------
// resolveNpmSkillDir
// ---------------------------------------------------------------------------

describe('resolveNpmSkillDir', () => {
  it('resolves a package directly in cwd/node_modules', async () => {
    const root = await makeTmp();
    const pkgDir = join(root, 'node_modules', 'my-skill');
    await mkdir(pkgDir, { recursive: true });

    const result = await resolveNpmSkillDir('my-skill', '', root);
    expect(result).toBe(pkgDir);
  });

  it('resolves a scoped package in node_modules', async () => {
    const root = await makeTmp();
    const pkgDir = join(root, 'node_modules', '@company', 'security-skill');
    await mkdir(pkgDir, { recursive: true });

    const result = await resolveNpmSkillDir('@company/security-skill', '', root);
    expect(result).toBe(pkgDir);
  });

  it('resolves a package with a subpath', async () => {
    const root = await makeTmp();
    const subDir = join(root, 'node_modules', '@company', 'bundle', 'security');
    await mkdir(subDir, { recursive: true });

    const result = await resolveNpmSkillDir('@company/bundle', 'security', root);
    expect(result).toBe(subDir);
  });

  it('returns null when the package is not found', async () => {
    const root = await makeTmp();

    const result = await resolveNpmSkillDir('nonexistent-pkg', '', root);
    expect(result).toBeNull();
  });

  it('returns null when the subpath does not exist in the package', async () => {
    const root = await makeTmp();
    const pkgDir = join(root, 'node_modules', 'my-bundle');
    await mkdir(pkgDir, { recursive: true });

    const result = await resolveNpmSkillDir('my-bundle', 'missing-subpath', root);
    expect(result).toBeNull();
  });

  it('walks up from a nested cwd (monorepo hoisting)', async () => {
    const root = await makeTmp();
    // Package installed at the monorepo root's node_modules
    const pkgDir = join(root, 'node_modules', 'shared-skill');
    await mkdir(pkgDir, { recursive: true });
    // cwd is a nested project inside the monorepo
    const nestedCwd = join(root, 'packages', 'web');
    await mkdir(nestedCwd, { recursive: true });

    const result = await resolveNpmSkillDir('shared-skill', '', nestedCwd);
    expect(result).toBe(pkgDir);
  });

  it('prefers a closer node_modules when the same package exists at multiple levels', async () => {
    const root = await makeTmp();
    const nestedCwd = join(root, 'packages', 'web');
    await mkdir(nestedCwd, { recursive: true });

    // Closer copy at nestedCwd
    const closerPkg = join(nestedCwd, 'node_modules', 'my-skill');
    await mkdir(closerPkg, { recursive: true });
    // Farther copy at root
    const fartherPkg = join(root, 'node_modules', 'my-skill');
    await mkdir(fartherPkg, { recursive: true });

    const result = await resolveNpmSkillDir('my-skill', '', nestedCwd);
    expect(result).toBe(closerPkg);
  });
});

// ---------------------------------------------------------------------------
// git-skill cache helpers
// ---------------------------------------------------------------------------

describe('resolveSkillCacheDir', () => {
  it('honours XDG_CACHE_HOME', () => {
    vi.stubEnv('XDG_CACHE_HOME', '/custom/cache');
    try {
      expect(resolveSkillCacheDir()).toBe(join('/custom/cache', 'code-review', 'skills'));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
    vi.stubEnv('XDG_CACHE_HOME', '');
    try {
      expect(resolveSkillCacheDir()).toBe(join(homedir(), '.cache', 'code-review', 'skills'));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('gitSkillCacheKey', () => {
  it('is stable for the same url and ref', () => {
    const a = gitSkillCacheKey('https://host/repo.git', 'v1');
    const b = gitSkillCacheKey('https://host/repo.git', 'v1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs when the ref differs', () => {
    expect(gitSkillCacheKey('https://host/repo.git', 'v1')).not.toBe(
      gitSkillCacheKey('https://host/repo.git', 'v2'),
    );
  });
});

// ---------------------------------------------------------------------------
// loadNamedSkill — integration tests with fixture directories
// ---------------------------------------------------------------------------

describe('loadNamedSkill', () => {
  describe('builtin protocol', () => {
    it('loads the built-in code-review skill', async () => {
      const cwd = await makeTmp();
      const skill = await loadNamedSkill('code-review', cwd);
      expect(skill.source).toBe('builtin');
      expect(skill.name).toBe('code-review');
      expect(skill.description).toBeTruthy();
    });

    it('loads the built-in test-integrity skill', async () => {
      const cwd = await makeTmp();
      const skill = await loadNamedSkill('test-integrity', cwd);
      expect(skill.source).toBe('builtin');
      expect(skill.name).toBe('test-integrity');
      expect(skill.description).toBeTruthy();
    });

    it('the test-integrity skill body covers its key heuristics', async () => {
      const cwd = await makeTmp();
      const skill = await loadNamedSkill('test-integrity', cwd);
      const body = await readFile(skill.filePath, 'utf8');
      expect(body.length).toBeGreaterThan(0);
      // Core heuristics the skill must instruct the reviewer on.
      expect(body).toMatch(/weaken/i);
      expect(body).toMatch(/\.skip/);
      expect(body).toMatch(/toBeDefined/);
      expect(body).toMatch(/CRITICAL/);
      // Honours the same commit-context suppression contract as code-review.
      expect(body).toMatch(/Commit Context/);
    });

    it('throws ConfigError for a non-existent builtin name', async () => {
      const cwd = await makeTmp();
      await expect(loadNamedSkill('no-such-skill', cwd)).rejects.toBeInstanceOf(ConfigError);
    });

    it('error message includes the spec and a hint', async () => {
      const cwd = await makeTmp();
      const err = await loadNamedSkill('no-such-skill', cwd).catch((e) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain('no-such-skill');
      expect(err.hint).toBeTruthy();
    });
  });

  describe('file: protocol', () => {
    it('loads a skill from a relative file: path', async () => {
      const cwd = await makeTmp();
      const skillDir = join(cwd, 'my-skill');
      await writeSkillMd(skillDir, 'my-local-skill', 'A local test skill', 'Do the thing.');

      const skill = await loadNamedSkill('file:./my-skill', cwd);
      expect(skill.source).toBe('file');
      expect(skill.name).toBe('my-local-skill');
      expect(skill.description).toBe('A local test skill');
      expect(skill.filePath).toBe(join(skillDir, 'SKILL.md'));
    });

    it('loads a skill from an absolute file: path', async () => {
      const cwd = await makeTmp();
      const skillDir = join(cwd, 'abs-skill');
      await writeSkillMd(skillDir, 'abs-skill', 'Absolute path skill');

      const skill = await loadNamedSkill(`file:${skillDir}`, cwd);
      expect(skill.source).toBe('file');
      expect(skill.name).toBe('abs-skill');
    });

    it('throws ConfigError when file: path has no SKILL.md', async () => {
      const cwd = await makeTmp();
      const emptyDir = join(cwd, 'empty-dir');
      await mkdir(emptyDir, { recursive: true });

      await expect(loadNamedSkill('file:./empty-dir', cwd)).rejects.toBeInstanceOf(ConfigError);
    });

    it('throws ConfigError when file: path does not exist', async () => {
      const cwd = await makeTmp();
      await expect(loadNamedSkill('file:./does-not-exist', cwd)).rejects.toBeInstanceOf(
        ConfigError,
      );
    });

    it('error message includes the spec and a hint for missing path', async () => {
      const cwd = await makeTmp();
      const err = await loadNamedSkill('file:./missing', cwd).catch((e) => e);
      expect(err.message).toContain('file:./missing');
      expect(err.hint).toBeTruthy();
    });
  });

  describe('npm: protocol', () => {
    it('loads a single-skill npm package', async () => {
      const cwd = await makeTmp();
      const pkgDir = join(cwd, 'node_modules', 'my-npm-skill');
      await writeSkillMd(pkgDir, 'npm-skill', 'An npm skill', 'Review npm packages.');

      const skill = await loadNamedSkill('npm:my-npm-skill', cwd);
      expect(skill.source).toBe('npm');
      expect(skill.name).toBe('npm-skill');
      expect(skill.filePath).toBe(join(pkgDir, 'SKILL.md'));
    });

    it('loads a scoped npm package', async () => {
      const cwd = await makeTmp();
      const pkgDir = join(cwd, 'node_modules', '@company', 'security-skill');
      await writeSkillMd(pkgDir, 'security', 'Company security skill');

      const skill = await loadNamedSkill('npm:@company/security-skill', cwd);
      expect(skill.source).toBe('npm');
      expect(skill.name).toBe('security');
    });

    it('loads a skill from an npm bundle subpath', async () => {
      const cwd = await makeTmp();
      const subDir = join(cwd, 'node_modules', '@company', 'skills-bundle', 'security');
      await writeSkillMd(subDir, 'bundle-security', 'Bundle security sub-skill');

      const skill = await loadNamedSkill('npm:@company/skills-bundle/security', cwd);
      expect(skill.source).toBe('npm');
      expect(skill.name).toBe('bundle-security');
    });

    it('resolves hoisted npm package from a nested cwd', async () => {
      const root = await makeTmp();
      const pkgDir = join(root, 'node_modules', 'shared-skill');
      await writeSkillMd(pkgDir, 'shared', 'A hoisted skill');
      const nestedCwd = join(root, 'packages', 'web');
      await mkdir(nestedCwd, { recursive: true });

      const skill = await loadNamedSkill('npm:shared-skill', nestedCwd);
      expect(skill.source).toBe('npm');
      expect(skill.name).toBe('shared');
    });

    it('throws ConfigError when npm package is not installed', async () => {
      const cwd = await makeTmp();
      await expect(loadNamedSkill('npm:not-installed', cwd)).rejects.toBeInstanceOf(ConfigError);
    });

    it('throws ConfigError when npm package has no valid SKILL.md', async () => {
      const cwd = await makeTmp();
      const pkgDir = join(cwd, 'node_modules', 'no-skill-pkg');
      await mkdir(pkgDir, { recursive: true });
      // No SKILL.md written

      await expect(loadNamedSkill('npm:no-skill-pkg', cwd)).rejects.toBeInstanceOf(ConfigError);
    });

    it('throws ConfigError when npm subpath is not found', async () => {
      const cwd = await makeTmp();
      const pkgDir = join(cwd, 'node_modules', '@company', 'bundle');
      await mkdir(pkgDir, { recursive: true });

      await expect(loadNamedSkill('npm:@company/bundle/missing-sub', cwd)).rejects.toBeInstanceOf(
        ConfigError,
      );
    });

    it('error message includes the spec for an uninstalled package', async () => {
      const cwd = await makeTmp();
      const err = await loadNamedSkill('npm:@org/missing', cwd).catch((e) => e);
      expect(err.message).toContain('npm:@org/missing');
      expect(err.hint).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// loadSkillFromDir — YAML frontmatter parsing
// ---------------------------------------------------------------------------

describe('loadSkillFromDir frontmatter parsing', () => {
  it('parses quoted YAML values, stripping the surrounding quotes', async () => {
    const dir = await makeTmp();
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: "code-review"\ndescription: "Quoted: with a colon"\n---\nbody',
      'utf8',
    );
    const skill = await loadSkillFromDir(dir, 'file');
    expect(skill).toMatchObject({ name: 'code-review', description: 'Quoted: with a colon' });
  });

  it('returns null when the frontmatter is not valid YAML', async () => {
    const dir = await makeTmp();
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: x\ndescription: bad: unquoted: colons\n---\nbody',
      'utf8',
    );
    expect(await loadSkillFromDir(dir, 'file')).toBeNull();
  });

  it('returns null when description is not a string scalar', async () => {
    const dir = await makeTmp();
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: x\ndescription:\n  nested: value\n---\nbody',
      'utf8',
    );
    expect(await loadSkillFromDir(dir, 'file')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadSkillFromDir — source field propagation
// ---------------------------------------------------------------------------

describe('loadSkillFromDir source field', () => {
  it('assigns source = "npm" when requested', async () => {
    const dir = await makeTmp();
    await writeSkillMd(dir, 'test-skill', 'Test');
    const skill = await loadSkillFromDir(dir, 'npm');
    expect(skill?.source).toBe('npm');
  });

  it('assigns source = "file" when requested', async () => {
    const dir = await makeTmp();
    await writeSkillMd(dir, 'test-skill', 'Test');
    const skill = await loadSkillFromDir(dir, 'file');
    expect(skill?.source).toBe('file');
  });
});

// ---------------------------------------------------------------------------
// loadAutoDiscoveredSkills — warn callback for invalid SKILL.md files
// ---------------------------------------------------------------------------

describe('loadAutoDiscoveredSkills warn callback', () => {
  it('calls warn when a SKILL.md exists but is missing required frontmatter fields', async () => {
    const root = await makeTmp('auto-disc-warn-');
    const skillDir = join(root, '.claude', 'skills', 'bento-section');
    await mkdir(skillDir, { recursive: true });
    // description-only: missing required `name:` field
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\ndescription: A skill without a name field.\n---\nSkill body.',
      'utf8',
    );

    const warnings: string[] = [];
    const skills = await loadAutoDiscoveredSkills(root, root, (msg) => warnings.push(msg));

    expect(skills).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/bento-section/);
    expect(warnings[0]).toMatch(/name/);
  });

  it('calls warn once per invalid skill when multiple bad SKILL.md files exist', async () => {
    const root = await makeTmp('auto-disc-multi-warn-');
    for (const name of ['bento-section', 'omy-audit', 'omy-markets']) {
      const skillDir = join(root, '.claude', 'skills', name);
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---\ndescription: Description for ${name}.\n---\n`,
        'utf8',
      );
    }

    const warnings: string[] = [];
    const skills = await loadAutoDiscoveredSkills(root, root, (msg) => warnings.push(msg));

    expect(skills).toHaveLength(0);
    expect(warnings).toHaveLength(3);
  });

  it('does not call warn for directories without a SKILL.md', async () => {
    const root = await makeTmp('auto-disc-no-skill-');
    const emptyDir = join(root, '.claude', 'skills', 'not-a-skill');
    await mkdir(emptyDir, { recursive: true });
    // no SKILL.md

    const warnings: string[] = [];
    await loadAutoDiscoveredSkills(root, root, (msg) => warnings.push(msg));

    expect(warnings).toHaveLength(0);
  });

  it('does not call warn for valid skills', async () => {
    const root = await makeTmp('auto-disc-valid-');
    const skillDir = join(root, '.claude', 'skills', 'good-skill');
    await writeSkillMd(skillDir, 'good-skill', 'A well-formed skill.');

    const warnings: string[] = [];
    const skills = await loadAutoDiscoveredSkills(root, root, (msg) => warnings.push(msg));

    expect(skills).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  it('does not warn when no warn callback is provided (stays backward-compatible)', async () => {
    const root = await makeTmp('auto-disc-no-cb-');
    const skillDir = join(root, '.claude', 'skills', 'broken-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\ndescription: No name.\n---\n', 'utf8');

    // Must not throw when no warn callback is passed
    await expect(loadAutoDiscoveredSkills(root, root)).resolves.toEqual([]);
  });
});
