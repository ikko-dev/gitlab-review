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
    name: 'ikko',
    owner: { name: 'Ikko' },
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
    expect(parseMarketplaceEntry('ikko=https://host/group/tools.git#0.6.13')).toEqual({
      name: 'ikko',
      format: 'anthropic',
      url: 'https://host/group/tools.git',
      ref: '0.6.13',
    });
  });

  it('accepts an explicit anthropic: format prefix', () => {
    expect(parseMarketplaceEntry('ikko=anthropic:https://host/group/tools.git#1.0.0')).toEqual({
      name: 'ikko',
      format: 'anthropic',
      url: 'https://host/group/tools.git',
      ref: '1.0.0',
    });
  });

  it('normalizes git+ssh:// to ssh:// and keeps the whole fragment as the ref', () => {
    expect(parseMarketplaceEntry('ikko=git+ssh://git@host/group/tools.git#feature/x')).toEqual({
      name: 'ikko',
      format: 'anthropic',
      url: 'ssh://git@host/group/tools.git',
      ref: 'feature/x',
    });
  });

  it('defaults ref to empty when no fragment is given', () => {
    expect(parseMarketplaceEntry('ikko=https://host/group/tools.git').ref).toBe('');
  });

  it('throws on a missing "="', () => {
    expect(() => parseMarketplaceEntry('ikko https://host/tools.git')).toThrow(ConfigError);
  });

  it('throws on a reserved name', () => {
    expect(() => parseMarketplaceEntry('git=https://host/tools.git')).toThrow(/reserved/);
  });

  it('throws on an invalid name', () => {
    expect(() => parseMarketplaceEntry('bad name=https://host/tools.git')).toThrow(ConfigError);
  });

  it('throws on an unknown format prefix', () => {
    expect(() => parseMarketplaceEntry('ikko=codex:https://host/tools.git')).toThrow(/format/);
  });

  it('throws on an invalid URL', () => {
    expect(() => parseMarketplaceEntry('ikko=not a url')).toThrow(ConfigError);
  });

  it('rejects scp-style shorthand (ambiguous), pointing at the ssh:// form', () => {
    expect(() => parseMarketplaceEntry('ikko=git@host:group/repo.git')).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// buildMarketplaceRegistry
// ---------------------------------------------------------------------------

describe('buildMarketplaceRegistry', () => {
  it('keys refs by name', () => {
    const reg = buildMarketplaceRegistry([
      parseMarketplaceEntry('ikko=https://host/a.git'),
      parseMarketplaceEntry('acme=https://host/b.git'),
    ]);
    expect([...reg.keys()]).toEqual(['ikko', 'acme']);
  });

  it('throws on a duplicate name', () => {
    expect(() =>
      buildMarketplaceRegistry([
        parseMarketplaceEntry('ikko=https://host/a.git'),
        parseMarketplaceEntry('ikko=https://host/b.git'),
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
    marketplace: 'ikko',
    plugin: 'dev',
    skill: 'aria-apg',
  };
  const registry = () =>
    buildMarketplaceRegistry([parseMarketplaceEntry('ikko=https://host/group/tools.git#0.6.13')]);

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
    expect(error.hint).toMatch(/No marketplace named "ikko"/);
  });

  it('redacts credentials from the clone-failure hint', async () => {
    ctl.failClone = true;
    const reg = buildMarketplaceRegistry([
      parseMarketplaceEntry('ikko=https://foxy:secret-token@host/group/tools.git#0.6.13'),
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
