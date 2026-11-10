/**
 * media.probe — every branch of probeMediaTarget, through an injected ProbeFs (the read-only
 * branch cannot be produced honestly by a suite that may run as root), plus the real
 * nodeProbeFs over a scratch root under the marker-guarded state root, plus the route.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config';
import {
  PROBE_FILE_PREFIX,
  PUB_DIR,
  READ_ONLY_CODES,
  nodeProbeFs,
  probeMedia,
  probeMediaTarget,
  type MediaProbe,
  type ProbeFs,
} from '../src/media/probe';
import { routeRequest } from '../src/router';
import { resetInstance, roots } from './fixtures/instance';

const BASE = '/publication/host_agent';
const AUTH = { authorization: `Bearer ${config.SERVICE_TOKEN}` };
const ROOT = '/srv/dedalo_media_fake';

beforeEach(resetInstance);
afterEach(resetInstance);

function errno(code: string): Error {
  return Object.assign(new Error(`fake ${code}`), { code });
}

function fakeFs(over: Partial<ProbeFs> = {}): { fs: ProbeFs; created: string[]; removed: string[] } {
  const created: string[] = [];
  const removed: string[] = [];
  const fs: ProbeFs = {
    isDirectory: async () => true,
    createExclusive: async (path) => {
      created.push(path);
    },
    remove: async (path) => {
      removed.push(path);
    },
    countFiles: async () => 3,
    modeOf: async () => 0o40755,
    ...over,
  };
  return { fs, created, removed };
}

const refuse = async (): Promise<never> => {
  throw new Error('the probe touched the filesystem');
};
const untouchable: ProbeFs = {
  isDirectory: refuse,
  createExclusive: refuse,
  remove: refuse,
  countFiles: refuse,
  modeOf: refuse,
};

describe('probeMediaTarget — modes without a root', () => {
  test('none probes nothing and reports nothing', async () => {
    expect(await probeMediaTarget({ mode: 'none', root: null }, untouchable)).toEqual({
      mode: 'none',
      root: null,
      present: false,
      read_only: null,
      pub_readable: null,
      pub_markers: null,
      web_traversable: null,
      problems: [],
    });
  });

  test('shared without a root is a problem, not a throw', async () => {
    const probe = await probeMediaTarget({ mode: 'shared', root: null }, untouchable);
    expect(probe.present).toBe(false);
    expect(probe.read_only).toBeNull();
    expect(probe.problems).toEqual([
      'MEDIA_MODE=shared declares a media root but MEDIA_ROOT is not set: nothing can be probed',
    ]);
  });
});

describe('probeMediaTarget — present', () => {
  test('absent shared root: the mount is missing, nothing else probed', async () => {
    const { fs, created } = fakeFs({ isDirectory: async () => false, countFiles: refuse });
    const probe = await probeMediaTarget({ mode: 'shared', root: ROOT }, fs);
    expect(probe).toEqual({
      mode: 'shared',
      root: ROOT,
      present: false,
      read_only: null,
      pub_readable: null,
      pub_markers: null,
      web_traversable: null,
      problems: [`media root ${ROOT} is not a directory: the read-only mount is missing`],
    });
    expect(created).toEqual([]);
  });

  test('absent copy root names the copy target', async () => {
    const { fs } = fakeFs({ isDirectory: async () => false });
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(probe.problems).toEqual([`media root ${ROOT} is not a directory: the copy target was never created`]);
  });

  test('an uninspectable root names its errno', async () => {
    const { fs } = fakeFs({
      isDirectory: async () => {
        throw errno('EACCES');
      },
    });
    const probe = await probeMediaTarget({ mode: 'shared', root: ROOT }, fs);
    expect(probe.present).toBe(false);
    expect(probe.problems).toEqual([`media root ${ROOT} cannot be inspected (EACCES)`]);
  });
});

describe('probeMediaTarget — read_only is measured by a write that must fail', () => {
  for (const code of READ_ONLY_CODES) {
    test(`${code} on the write probe ⇒ read_only true, no file, no problem (shared)`, async () => {
      const { fs, removed } = fakeFs({
        createExclusive: async () => {
          throw errno(code);
        },
      });
      const probe = await probeMediaTarget({ mode: 'shared', root: ROOT }, fs);
      expect(probe).toEqual({
        mode: 'shared',
        root: ROOT,
        present: true,
        read_only: true,
        pub_readable: true,
        pub_markers: 3,
        web_traversable: true,
        problems: [],
      });
      expect(removed).toEqual([]);
    });
  }

  test('a writable shared root is a problem, and the probe file is removed at once', async () => {
    const { fs, created, removed } = fakeFs();
    const probe = await probeMediaTarget({ mode: 'shared', root: ROOT }, fs);
    expect(probe.read_only).toBe(false);
    expect(created).toHaveLength(1);
    expect(created[0].startsWith(`${ROOT}/${PROBE_FILE_PREFIX}`)).toBe(true);
    expect(removed).toEqual(created);
    expect(probe.problems).toEqual([
      `media root ${ROOT} is WRITABLE by the agent: shared mode requires a read-only mount (spec §5.1)`,
    ]);
  });

  test('each probe uses a fresh file name', async () => {
    const { fs, created } = fakeFs();
    await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(new Set(created).size).toBe(2);
  });

  test('a probe file that cannot be removed is named, never left silently', async () => {
    const { fs, created } = fakeFs({
      remove: async () => {
        throw errno('EBUSY');
      },
    });
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(probe.read_only).toBe(false);
    expect(probe.problems).toEqual([
      `write probe ${created[0]} was created but could not be removed (EBUSY): delete it by hand`,
    ]);
  });

  test('any other errno ⇒ read_only unknown, explained', async () => {
    const { fs } = fakeFs({
      createExclusive: async () => {
        throw errno('ENOSPC');
      },
    });
    const probe = await probeMediaTarget({ mode: 'shared', root: ROOT }, fs);
    expect(probe.read_only).toBeNull();
    expect(probe.problems).toEqual([`write probe in ${ROOT} failed with ENOSPC: read-only state unknown`]);
  });

  test('an errno-less failure is reported as unknown error', async () => {
    const { fs } = fakeFs({
      createExclusive: async () => {
        throw new Error('no code');
      },
    });
    const probe = await probeMediaTarget({ mode: 'shared', root: ROOT }, fs);
    expect(probe.problems).toEqual([`write probe in ${ROOT} failed with unknown error: read-only state unknown`]);
  });

  test('a read-only copy root is a problem (the agent is its only writer)', async () => {
    const { fs } = fakeFs({
      createExclusive: async () => {
        throw errno('EROFS');
      },
    });
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(probe.read_only).toBe(true);
    expect(probe.problems).toEqual([
      `media root ${ROOT} is read-only: copy mode needs the agent to write it (spec §5.2)`,
    ]);
  });

  test('a writable copy root is the expected state', async () => {
    const { fs } = fakeFs();
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(probe.read_only).toBe(false);
    expect(probe.problems).toEqual([]);
  });
});

describe('probeMediaTarget — pub/', () => {
  test('an unlistable pub/ is explained: every media request will 404', async () => {
    const { fs } = fakeFs({
      createExclusive: async () => {
        throw errno('EROFS');
      },
      countFiles: async () => {
        throw errno('ENOENT');
      },
    });
    const probe = await probeMediaTarget({ mode: 'shared', root: ROOT }, fs);
    expect(probe.pub_readable).toBe(false);
    expect(probe.pub_markers).toBeNull();
    expect(probe.problems).toEqual([
      `${join(ROOT, PUB_DIR)} cannot be listed (ENOENT): the generated rules answer 404 for every media file`,
    ]);
  });

  test('copy mode, nothing copied yet: no pub/ is zero markers, not a problem (the agent creates it with the first marker)', async () => {
    // Measured on RHEL 10.2 (two-machine drill, 2026-10-09): a freshly paired copy host's first
    // "Probe media" answered "found 1 problem(s)" for the absent pub/, which only the first copy creates.
    const { fs } = fakeFs({
      countFiles: async () => {
        throw errno('ENOENT');
      },
    });
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(probe.pub_readable).toBe(true);
    expect(probe.pub_markers).toBe(0);
    expect(probe.problems).toEqual([]);
  });

  test('copy mode: any other errno on pub/ is still a problem', async () => {
    const { fs } = fakeFs({
      countFiles: async () => {
        throw errno('EACCES');
      },
    });
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(probe.pub_readable).toBe(false);
    expect(probe.problems).toEqual([
      `${join(ROOT, PUB_DIR)} cannot be listed (EACCES): the generated rules answer 404 for every media file`,
    ]);
  });
});

describe('probeMediaTarget — web_traversable (the web user must search every level down to pub/)', () => {
  const dark = (path: string) =>
    `${path} has no search bit for others (mode 750): the web server cannot stat the markers below it and the generated rules answer 404 for every media file`;

  test('every level 0755 ⇒ true, no problem', async () => {
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fakeFs().fs);
    expect(probe.web_traversable).toBe(true);
    expect(probe.problems).toEqual([]);
  });

  test('a 0750 pub/ ⇒ false, the problem names pub/', async () => {
    const pub = join(ROOT, PUB_DIR);
    const { fs } = fakeFs({ modeOf: async path => (path === pub ? 0o40750 : 0o40755) });
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(probe.web_traversable).toBe(false);
    expect(probe.problems).toEqual([dark(pub)]);
  });

  test('the FIRST dark level is named; an absent level ends the walk (deepest existing)', async () => {
    const dot = join(ROOT, '.publication');
    const { fs } = fakeFs({ modeOf: async path => (path === ROOT ? 0o40755 : path === dot ? 0o40750 : null) });
    expect((await probeMediaTarget({ mode: 'copy', root: ROOT }, fs)).problems).toEqual([dark(dot)]);
    const absent = fakeFs({ modeOf: async path => (path === ROOT ? 0o40755 : null) });
    expect((await probeMediaTarget({ mode: 'copy', root: ROOT }, absent.fs)).web_traversable).toBe(true);
  });

  test('shared mode: a dark level is still false, but the line is ADVISORY (owner/group access not verified)', async () => {
    const { fs } = fakeFs({
      createExclusive: async () => {
        throw errno('EROFS');
      },
      modeOf: async path => (path === ROOT ? 0o40750 : 0o40755),
    });
    const probe = await probeMediaTarget({ mode: 'shared', root: ROOT }, fs);
    expect(probe.web_traversable).toBe(false);
    expect(probe.problems).toEqual([
      `${ROOT} has no search bit for others (mode 750) (advisory: access as the owner or group is not verified): unless the web server reaches the export as its owner or group, the generated rules answer 404 for every media file`,
    ]);
  });

  test('an uninspectable level is null, explained', async () => {
    const { fs } = fakeFs({
      modeOf: async () => {
        throw errno('EACCES');
      },
    });
    const probe = await probeMediaTarget({ mode: 'copy', root: ROOT }, fs);
    expect(probe.web_traversable).toBeNull();
    expect(probe.problems).toEqual([`web traversability of ${ROOT} cannot be measured (EACCES)`]);
  });
});

describe('nodeProbeFs — the real filesystem', () => {
  // The real-fs cases create dirs by plain mkdir: pin the umask so a hardened runner (0027,
  // 0077) does not turn a "healthy" fixture dark. Restored whatever the test did.
  let savedUmask = 0o022;
  beforeEach(() => {
    savedUmask = process.umask(0o022);
  });
  afterEach(() => {
    process.umask(savedUmask);
  });

  test('writable root, two markers, a subdirectory is not a marker, no probe file left behind', async () => {
    const root = join(roots.stateRoot, 'media_probe_root');
    await mkdir(join(root, PUB_DIR), { recursive: true });
    await writeFile(join(root, PUB_DIR, 'test3_1'), '');
    await writeFile(join(root, PUB_DIR, 'test3_2'), '');
    await mkdir(join(root, PUB_DIR, 'not_a_marker'));

    const probe = await probeMediaTarget({ mode: 'copy', root }, nodeProbeFs);

    expect(probe).toEqual({
      mode: 'copy',
      root,
      present: true,
      read_only: false,
      pub_readable: true,
      pub_markers: 2,
      web_traversable: true,
      problems: [],
    });
    expect((await readdir(root)).filter((name) => name.startsWith(PROBE_FILE_PREFIX))).toEqual([]);
  });

  test('a real 0750 pub/ is not web-traversable and is named', async () => {
    const root = join(roots.stateRoot, 'media_probe_dark');
    await mkdir(join(root, PUB_DIR), { recursive: true });
    await chmod(join(root, PUB_DIR), 0o750);
    const probe = await probeMediaTarget({ mode: 'copy', root }, nodeProbeFs);
    expect(probe.web_traversable).toBe(false);
    expect(probe.problems).toEqual([
      `${join(root, PUB_DIR)} has no search bit for others (mode 750): the web server cannot stat the markers below it and the generated rules answer 404 for every media file`,
    ]);
  });

  test('a missing root and a path through a file are both "not a directory"', async () => {
    const file = join(roots.stateRoot, 'media_probe_file');
    await writeFile(file, '');
    expect(await nodeProbeFs.isDirectory(join(roots.stateRoot, 'media_probe_absent'))).toBe(false);
    expect(await nodeProbeFs.isDirectory(file)).toBe(false);
    expect(await nodeProbeFs.isDirectory(join(file, 'below'))).toBe(false);
  });

  test('createExclusive never clobbers an existing file', async () => {
    const file = join(roots.stateRoot, 'media_probe_existing');
    await writeFile(file, 'keep');
    await expect(nodeProbeFs.createExclusive(file)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await Bun.file(file).text()).toBe('keep');
  });
});

describe('probeMedia() and GET /v1/media/probe', () => {
  test('probeMedia reads the configured mode and root', async () => {
    const probe = await probeMedia();
    expect(probe.mode).toBe(config.MEDIA_MODE);
    expect(probe.root).toBe(config.MEDIA_ROOT ?? null);
  });

  test('the route is behind the bearer and answers the configured probe, no-store', async () => {
    const unauth = await routeRequest(new Request(`http://localhost${BASE}/v1/media/probe`));
    expect(unauth.status).toBe(401);

    const res = await routeRequest(new Request(`http://localhost${BASE}/v1/media/probe`, { headers: AUTH }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as MediaProbe;
    expect(body).toEqual(await probeMedia());
  });
});
