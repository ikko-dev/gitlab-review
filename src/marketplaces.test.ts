// Marketplace resolution tests.
//
// The pure parsing/registry helpers run without any filesystem. The
// `loadMarketplaceSkill` tests reuse the same in-memory (memfs) + mocked-`git`
// harness as `skills-git-cache.test.ts`, so a marketplace "clone" is simulated
// by having the mocked `checkout` write a `.claude-plugin/marketplace.json` and
// plugin skill files — no real network or user filesystem is touched.

import { join } from 'node:path';
import { vol } from 'memfs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from './errors.js';

const { gitMock, ctl } = vi.hoisted(() => ({
  gitMock: vi.fn(),
  ctl: { files: {} as Record<string, string>, failClone: false },
}));

vi.mock('node:fs', async () => {
  const memfs = await import('memfs');
  return { ...memfs.fs, default: memfs.fs };
});
vi.mock('node:fs/promises', async () => {
  const memfs = await import('memfs');
  return { ...memfs.fs.promises, default: memfs.fs.promises };
});
vi.mock('./git.js', () => ({ git: gitMock }));

const { buildMarketplaceRegistry, loadMarketplaceSkill, parseMarketplaceEntry } =
  await import('./marketplaces.js');
const { gitSkillCacheKey } = await import('./skills.js');

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody.`;
}

/** Mock `git` so `init` makes `.git` and `checkout` writes `ctl.files` into cwd. */
function installCloneMock(): void {
  gitMock.mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
    const { fs } = await import('memfs');
    if (ctl.failClone) throw new Error('simulated clone failure');
    if (args[0] === 'init') {
      await fs.promises.mkdir(join(args[args.length - 1], '.git'), { recursive: true });
    } else if (args[0] === 'checkout') {
      for (const [rel, content] of Object.entries(ctl.files)) {
        const abs = join(opts!.cwd!, rel);
        await fs.promises.mkdir(join(abs, '..'), { recursive: true });
        await fs.promises.writeFile(abs, content);
      }
    }
    return '';
  });
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'acme',
    owner: { name: 'Acme' },
    plugins: [{ name: 'dev', source: './plugins/dev' }],
    ...overrides,
  });
}

const ARIA = skillMd('aria-apg', 'ARIA APG patterns');

beforeEach(async () => {
  vol.reset();
  ctl.files = {
    '.claude-plugin/marketplace.json': manifest(),
    'plugins/dev/skills/aria-apg/SKILL.md': ARIA,
  };
  ctl.failClone = false;
  gitMock.mockReset();
  installCloneMock();
});

// ---------------------------------------------------------------------------
// parseMarketplaceEntry
// ---------------------------------------------------------------------------

describe('parseMarketplaceEntry', () => {
  it('parses <name>=<url>#<ref> with the default anthropic format', () => {
    expect(parseMarketplaceEntry('acme=https://host/group/tools.git#0.6.13')).toEqual({
      name: 'acme',
      format: 'anthropic',
      url: 'https://host/group/tools.git',
      ref: '0.6.13',
    });
  });

  it('accepts an explicit anthropic: format prefix', () => {
    expect(parseMarketplaceEntry('acme=anthropic:https://host/group/tools.git#1.0.0')).toEqual({
      name: 'acme',
      format: 'anthropic',
      url: 'https://host/group/tools.git',
      ref: '1.0.0',
    });
  });

  it('normalizes git+ssh:// to ssh:// and keeps the whole fragment as the ref', () => {
    expect(parseMarketplaceEntry('acme=git+ssh://git@host/group/tools.git#feature/x')).toEqual({
      name: 'acme',
      format: 'anthropic',
      url: 'ssh://git@host/group/tools.git',
      ref: 'feature/x',
    });
  });

  it('defaults ref to empty when no fragment is given', () => {
    expect(parseMarketplaceEntry('acme=https://host/group/tools.git').ref).toBe('');
  });

  it('throws on a missing "="', () => {
    expect(() => parseMarketplaceEntry('acme https://host/tools.git')).toThrow(ConfigError);
  });

  it('throws on a reserved name', () => {
    expect(() => parseMarketplaceEntry('git=https://host/tools.git')).toThrow(/reserved/);
  });

  it('throws on an invalid name', () => {
    expect(() => parseMarketplaceEntry('bad name=https://host/tools.git')).toThrow(ConfigError);
  });

  it('throws on an unknown format prefix', () => {
    expect(() => parseMarketplaceEntry('acme=codex:https://host/tools.git')).toThrow(/format/);
  });

  it('throws on an invalid URL', () => {
    expect(() => parseMarketplaceEntry('acme=not a url')).toThrow(ConfigError);
  });

  it('rejects scp-style shorthand (ambiguous), pointing at the ssh:// form', () => {
    expect(() => parseMarketplaceEntry('acme=git@host:group/repo.git')).toThrow(ConfigError);
  });

  it.each([
    ['invalid URL', 'acme=https://ci-bot:secret-token@bad host'],
    ['missing "=" (raw credentialed URL)', 'https://ci-bot:secret-token@host/repo.git'],
    ['unknown format prefix', 'acme=nope:https://ci-bot:secret-token@host/repo.git'],
  ])('redacts embedded credentials from the %s error', (_label, entry) => {
    let error: ConfigError | undefined;
    try {
      parseMarketplaceEntry(entry);
    } catch (e) {
      error = e as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.message).not.toContain('secret-token');
    expect(error?.message).toContain('***@');
  });
});

// ---------------------------------------------------------------------------
// buildMarketplaceRegistry
// ---------------------------------------------------------------------------

describe('buildMarketplaceRegistry', () => {
  it('keys refs by name', () => {
    const reg = buildMarketplaceRegistry([
      parseMarketplaceEntry('acme=https://host/a.git'),
      parseMarketplaceEntry('beta=https://host/b.git'),
    ]);
    expect([...reg.keys()]).toEqual(['acme', 'beta']);
  });

  it('throws on a duplicate name', () => {
    expect(() =>
      buildMarketplaceRegistry([
        parseMarketplaceEntry('acme=https://host/a.git'),
        parseMarketplaceEntry('acme=https://host/b.git'),
      ]),
    ).toThrow(/[Dd]uplicate/);
  });
});

// ---------------------------------------------------------------------------
// loadMarketplaceSkill
// ---------------------------------------------------------------------------

describe('loadMarketplaceSkill', () => {
  const spec = {
    protocol: 'marketplace' as const,
    marketplace: 'acme',
    plugin: 'dev',
    skill: 'aria-apg',
  };
  const registry = () =>
    buildMarketplaceRegistry([parseMarketplaceEntry('acme=https://host/group/tools.git#0.6.13')]);

  it('resolves a skill via marketplace.json → plugin source → skills/<skill>', async () => {
    const skill = await loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' });
    expect(skill.name).toBe('aria-apg');
    expect(skill.source).toBe('marketplace');
  });

  it('honors metadata.pluginRoot for a bare plugin source', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest({
        metadata: { pluginRoot: './plugins' },
        plugins: [{ name: 'dev', source: 'dev' }],
      }),
      'plugins/dev/skills/aria-apg/SKILL.md': ARIA,
    };
    const skill = await loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' });
    expect(skill.name).toBe('aria-apg');
  });

  it('supports a marketplace-root plugin source (".")', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest({ plugins: [{ name: 'dev', source: '.' }] }),
      'skills/aria-apg/SKILL.md': ARIA,
    };
    const skill = await loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' });
    expect(skill.name).toBe('aria-apg');
  });

  it('honors a custom "skills" path on the marketplace entry (added to default scan)', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest({
        plugins: [{ name: 'dev', source: './plugins/dev', skills: ['./extra-skills/'] }],
      }),
      'plugins/dev/extra-skills/aria-apg/SKILL.md': ARIA,
    };
    const skill = await loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' });
    expect(skill.name).toBe('aria-apg');
  });

  it('honors a "skills" field declared in the plugin\'s plugin.json', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest(),
      'plugins/dev/.claude-plugin/plugin.json': JSON.stringify({
        name: 'dev',
        skills: './custom/skills/',
      }),
      'plugins/dev/custom/skills/aria-apg/SKILL.md': ARIA,
    };
    const skill = await loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' });
    expect(skill.name).toBe('aria-apg');
  });

  it('resolves a "skills" path that points directly at a single skill directory', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest({
        plugins: [{ name: 'dev', source: './plugins/dev', skills: ['./bundled/aria-apg'] }],
      }),
      // The dir is named differently from the skill; the frontmatter name matches.
      'plugins/dev/bundled/aria-apg/SKILL.md': ARIA,
    };
    const skill = await loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' });
    expect(skill.name).toBe('aria-apg');
  });

  it('resolves via a marketplace-root source with specific "skills" subdirs', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest({
        plugins: [{ name: 'dev', source: './', skills: ['./skills/aria-apg'] }],
      }),
      'skills/aria-apg/SKILL.md': ARIA,
    };
    const skill = await loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' });
    expect(skill.name).toBe('aria-apg');
  });

  it('throws with the available plugin list when the plugin is unknown', async () => {
    const bad = { ...spec, plugin: 'nope' };
    const error = await loadMarketplaceSkill(bad, registry(), { cacheDir: '/cache' }).catch(
      (e) => e as ConfigError,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toMatch(/not found in marketplace/);
    expect(error.hint).toMatch(/Available plugins: dev/);
  });

  it('throws when the skill directory has no SKILL.md', async () => {
    const bad = { ...spec, skill: 'ghost' };
    await expect(loadMarketplaceSkill(bad, registry(), { cacheDir: '/cache' })).rejects.toThrow(
      ConfigError,
    );
  });

  it('rejects a remote (object) plugin source', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest({
        plugins: [{ name: 'dev', source: { source: 'github', repo: 'x/y' } }],
      }),
    };
    await expect(loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' })).rejects.toThrow(
      /Remote plugin sources|local source/,
    );
  });

  it('refuses a plugin source that escapes the repo', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest({
        plugins: [{ name: 'dev', source: '../evil' }],
      }),
    };
    await expect(loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' })).rejects.toThrow(
      /escapes the marketplace/,
    );
  });

  it('refuses a skill directory that symlinks outside the repo', async () => {
    // Pre-seed a valid clone so cloneGitRepo short-circuits (no git mock needed),
    // then point a skill dir at a symlink that escapes the marketplace.
    const { fs } = await import('memfs');
    const repoDir = join('/cache', gitSkillCacheKey('https://host/group/tools.git', '0.6.13'));
    await fs.promises.mkdir(join(repoDir, '.git'), { recursive: true });
    await fs.promises.mkdir(join(repoDir, '.claude-plugin'), { recursive: true });
    await fs.promises.writeFile(join(repoDir, '.claude-plugin/marketplace.json'), manifest());
    await fs.promises.mkdir(join(repoDir, 'plugins/dev/skills'), { recursive: true });
    await fs.promises.mkdir('/outside/aria-apg', { recursive: true });
    await fs.promises.writeFile('/outside/aria-apg/SKILL.md', ARIA);
    await fs.promises.symlink('/outside/aria-apg', join(repoDir, 'plugins/dev/skills/aria-apg'));

    await expect(loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' })).rejects.toThrow(
      /escapes the marketplace/,
    );
  });

  it('refuses a plugin source that symlinks outside the repo', async () => {
    const { fs } = await import('memfs');
    const repoDir = join('/cache', gitSkillCacheKey('https://host/group/tools.git', '0.6.13'));
    await fs.promises.mkdir(join(repoDir, '.git'), { recursive: true });
    await fs.promises.mkdir(join(repoDir, '.claude-plugin'), { recursive: true });
    await fs.promises.writeFile(join(repoDir, '.claude-plugin/marketplace.json'), manifest());
    await fs.promises.mkdir(join(repoDir, 'plugins'), { recursive: true });
    await fs.promises.mkdir('/outside/dev/skills/aria-apg', { recursive: true });
    await fs.promises.writeFile('/outside/dev/skills/aria-apg/SKILL.md', ARIA);
    await fs.promises.symlink('/outside/dev', join(repoDir, 'plugins/dev'));

    await expect(loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' })).rejects.toThrow(
      /escapes the marketplace/,
    );
  });

  it('throws on a malformed plugin.json instead of silently ignoring it', async () => {
    ctl.files = {
      '.claude-plugin/marketplace.json': manifest(),
      'plugins/dev/.claude-plugin/plugin.json': '{ not valid json',
      'plugins/dev/skills/aria-apg/SKILL.md': ARIA,
    };
    await expect(loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' })).rejects.toThrow(
      /Malformed plugin.json/,
    );
  });

  it('errors when the repo has no .claude-plugin/marketplace.json', async () => {
    ctl.files = { 'README.md': 'not a marketplace' };
    await expect(loadMarketplaceSkill(spec, registry(), { cacheDir: '/cache' })).rejects.toThrow(
      /valid Anthropic plugin marketplace/,
    );
  });

  it('throws for an unregistered marketplace name', async () => {
    const empty = buildMarketplaceRegistry([]);
    const error = await loadMarketplaceSkill(spec, empty, { cacheDir: '/cache' }).catch(
      (e) => e as ConfigError,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.hint).toMatch(/No marketplace named "acme"/);
  });

  it('redacts credentials from the clone-failure hint', async () => {
    ctl.failClone = true;
    const reg = buildMarketplaceRegistry([
      parseMarketplaceEntry('acme=https://ci-bot:secret-token@host/group/tools.git#0.6.13'),
    ]);
    let hint: string | undefined;
    try {
      await loadMarketplaceSkill(spec, reg, { cacheDir: '/cache' });
    } catch (error) {
      hint = (error as ConfigError).hint;
    }
    expect(hint).toBeDefined();
    expect(hint).not.toContain('secret-token');
    expect(hint).toContain('***@host');
  });
});
