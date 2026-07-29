// git-skill cache tests.
//
// These exercise the on-disk clone cache (`cloneGitRepo`) against an in-memory
// filesystem (memfs) with a mocked `git` helper, so they verify cache creation,
// reuse, refresh, recovery, and the concurrent-clone race **without touching the
// real user filesystem** — not even the default `~/.cache` location, which is
// resolved and written entirely in memory here.

import { join } from 'node:path';
import { vol } from 'memfs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from './errors.js';

const { gitMock, ctl } = vi.hoisted(() => ({
  gitMock: vi.fn(),
  // `failRename` forces the post-clone `rename` to fail, simulating a
  // concurrent clone winning the race (memfs's rename, unlike Node's, does not
  // throw on a non-empty target on its own).
  ctl: { failRename: false },
}));

vi.mock('node:fs', async () => {
  const memfs = await import('memfs');
  return { ...memfs.fs, default: memfs.fs };
});
vi.mock('node:fs/promises', async () => {
  const memfs = await import('memfs');
  const real = memfs.fs.promises;
  return {
    ...real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (ctl.failRename) {
        const error = new Error('simulated rename failure') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      return real.rename(...args);
    },
    default: real,
  };
});
vi.mock('./git.js', () => ({ git: gitMock }));

const { gitSkillCacheKey, loadNamedSkill, resolveSkillCacheDir } = await import('./skills.js');

function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody.`;
}

/** Default git mock: `init` makes a `.git`, `checkout` writes a root SKILL.md. */
function installCloneMock(skillRelPath = 'SKILL.md', name = 'cloned', description = 'A git skill') {
  gitMock.mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
    const { fs } = await import('memfs');
    if (args[0] === 'init') {
      await fs.promises.mkdir(join(args[args.length - 1], '.git'), { recursive: true });
    } else if (args[0] === 'checkout') {
      await fs.promises.mkdir(join(opts!.cwd!, skillRelPath, '..'), { recursive: true });
      await fs.promises.writeFile(join(opts!.cwd!, skillRelPath), skillMd(name, description));
    }
    return '';
  });
}

beforeEach(async () => {
  vol.reset();
  ctl.failRename = false;
  gitMock.mockReset();
  installCloneMock();
  await vol.promises.mkdir('/work', { recursive: true });
});

describe('cloneGitRepo — fresh clone', () => {
  it('clones into the default cache dir entirely in memory', async () => {
    const skill = await loadNamedSkill('git:https://host/org/repo.git', '/work');
    expect(skill.source).toBe('git');
    expect(skill.name).toBe('cloned');
    // The default (XDG/home) cache dir was used — but it lives in memfs, so the
    // real `~/.cache` is never touched.
    expect(skill.rootDir.startsWith(resolveSkillCacheDir())).toBe(true);
    expect(gitMock).toHaveBeenCalled();
  });

  it('shallow-fetches the pinned ref, then checks out FETCH_HEAD', async () => {
    await loadNamedSkill('git:https://host/org/repo.git#v1.2.0', '/work', { cacheDir: '/cache' });
    const calls = gitMock.mock.calls.map((c) => c[0] as string[]);
    expect(calls[0]).toEqual(['init', '--quiet', expect.stringContaining('/cache/')]);
    expect(calls[1].slice(0, 3)).toEqual(['remote', 'add', 'origin']);
    expect(calls[2]).toEqual(['fetch', '--depth', '1', '--quiet', 'origin', 'v1.2.0']);
    expect(calls[3]).toEqual(['checkout', '--quiet', 'FETCH_HEAD']);
  });

  it('fetches HEAD (default branch) when no ref is pinned', async () => {
    await loadNamedSkill('git:https://host/org/repo.git', '/work', { cacheDir: '/cache' });
    const fetchCall = gitMock.mock.calls.map((c) => c[0] as string[]).find((a) => a[0] === 'fetch');
    expect(fetchCall).toEqual(['fetch', '--depth', '1', '--quiet', 'origin', 'HEAD']);
  });

  it('rewrites git+ssh:// to an ssh:// remote URL', async () => {
    await loadNamedSkill('git+ssh://git@host/org/repo.git', '/work', { cacheDir: '/cache' });
    const remoteCall = gitMock.mock.calls
      .map((c) => c[0] as string[])
      .find((a) => a[0] === 'remote');
    expect(remoteCall).toEqual(['remote', 'add', 'origin', 'ssh://git@host/org/repo.git']);
  });

  it('loads a skill from a #ref/subpath directory', async () => {
    installCloneMock('security/SKILL.md', 'bundle-sec', 'Security sub-skill');
    const skill = await loadNamedSkill('git:https://host/org/bundle.git#v1/security', '/work', {
      cacheDir: '/cache',
    });
    expect(skill.name).toBe('bundle-sec');
  });
});

describe('cloneGitRepo — cache reuse and refresh', () => {
  async function seedCache(url: string, ref = '', name = 'cached'): Promise<string> {
    const { fs } = await import('memfs');
    const repoDir = join('/cache', gitSkillCacheKey(url, ref));
    await fs.promises.mkdir(join(repoDir, '.git'), { recursive: true });
    await fs.promises.writeFile(join(repoDir, 'SKILL.md'), skillMd(name, 'desc'));
    return repoDir;
  }

  it('reuses a cached clone without invoking git', async () => {
    const url = 'https://host/org/repo.git';
    const repoDir = await seedCache(url);
    const skill = await loadNamedSkill(`git:${url}`, '/work', { cacheDir: '/cache' });
    expect(skill.rootDir).toBe(repoDir);
    expect(skill.name).toBe('cached');
    expect(gitMock).not.toHaveBeenCalled();
  });

  it('re-clones when refresh is set, discarding the cached copy', async () => {
    const url = 'https://host/org/repo.git';
    await seedCache(url, '', 'stale');
    const skill = await loadNamedSkill(`git:${url}`, '/work', {
      cacheDir: '/cache',
      refresh: true,
    });
    // The fresh clone mock writes name 'cloned', proving the stale copy was dropped.
    expect(skill.name).toBe('cloned');
    expect(gitMock).toHaveBeenCalled();
  });

  it('recovers when a partial (non-.git) dir occupies the cache slot', async () => {
    const { fs } = await import('memfs');
    const url = 'https://host/org/repo.git';
    const repoDir = join('/cache', gitSkillCacheKey(url, ''));
    await fs.promises.mkdir(repoDir, { recursive: true });
    await fs.promises.writeFile(join(repoDir, 'junk.txt'), 'partial');

    const skill = await loadNamedSkill(`git:${url}`, '/work', { cacheDir: '/cache' });
    expect(skill.name).toBe('cloned');
    expect(gitMock).toHaveBeenCalled();
  });
});

describe('cloneGitRepo — concurrent-clone race', () => {
  it('adopts the cache entry a concurrent clone created when rename fails', async () => {
    const { fs } = await import('memfs');
    const url = 'https://host/org/repo.git';
    const repoDir = join('/cache', gitSkillCacheKey(url, ''));
    gitMock.mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
      if (args[0] === 'init') {
        await fs.promises.mkdir(join(args[args.length - 1], '.git'), { recursive: true });
      } else if (args[0] === 'checkout') {
        await fs.promises.writeFile(join(opts!.cwd!, 'SKILL.md'), skillMd('ours', 'ours'));
        // A concurrent clone finished first and populated the final cache dir.
        await fs.promises.mkdir(join(repoDir, '.git'), { recursive: true });
        await fs.promises.writeFile(join(repoDir, 'SKILL.md'), skillMd('winner', 'winner'));
      }
      return '';
    });
    ctl.failRename = true;

    const skill = await loadNamedSkill(`git:${url}`, '/work', { cacheDir: '/cache' });
    expect(skill.rootDir).toBe(repoDir);
    expect(skill.name).toBe('winner');
  });

  it('rethrows as a ConfigError when rename fails with no clone to adopt', async () => {
    ctl.failRename = true;
    await expect(
      loadNamedSkill('git:https://host/org/repo.git', '/work', { cacheDir: '/cache' }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('cloneGitRepo — failure paths', () => {
  it('throws ConfigError when the clone fails, leaving no cache entry', async () => {
    const { fs } = await import('memfs');
    gitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'fetch') throw new Error('repository not found');
      if (args[0] === 'init') {
        await fs.promises.mkdir(join(args[args.length - 1], '.git'), { recursive: true });
      }
      return '';
    });

    await expect(
      loadNamedSkill('git:https://host/org/missing.git', '/work', { cacheDir: '/cache' }),
    ).rejects.toBeInstanceOf(ConfigError);
    // The temp clone dir was cleaned up; the cache holds no committed entry.
    const entries = vol.existsSync('/cache') ? await vol.promises.readdir('/cache') : [];
    expect(entries).toEqual([]);
  });

  it('names the pinned ref in the hint when a pinned clone fails', async () => {
    gitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'fetch') throw new Error('unknown ref');
      const { fs } = await import('memfs');
      if (args[0] === 'init') {
        await fs.promises.mkdir(join(args[args.length - 1], '.git'), { recursive: true });
      }
      return '';
    });
    const err = await loadNamedSkill('git:https://host/org/repo.git#v9.9.9', '/work', {
      cacheDir: '/cache',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.hint).toContain('v9.9.9');
  });

  it('throws ConfigError when the cloned repo has no SKILL.md', async () => {
    gitMock.mockImplementation(async (args: string[]) => {
      const { fs } = await import('memfs');
      if (args[0] === 'init') {
        await fs.promises.mkdir(join(args[args.length - 1], '.git'), { recursive: true });
      }
      // checkout writes nothing — no SKILL.md in the working tree
      return '';
    });
    await expect(
      loadNamedSkill('git:https://host/org/repo.git', '/work', { cacheDir: '/cache' }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when the subpath has no SKILL.md', async () => {
    // Default mock writes SKILL.md at the repo root, not at the requested subpath.
    await expect(
      loadNamedSkill('git:https://host/org/repo.git#v1/missing', '/work', { cacheDir: '/cache' }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
