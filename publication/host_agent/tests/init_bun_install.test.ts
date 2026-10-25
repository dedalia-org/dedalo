/**
 * bun_install.ts — `bun.install` (spec §5 step 4): hash before anything runs, the extracted
 * `--version` before anything is written, a missing bin chain created root 0755 while an
 * existing directory is never touched, the atomic write, the post-write `--version` with the
 * previous bytes restored on failure, and the extract directory always removed.
 *
 * Two layers:
 *   - a recording fake of the ports (every door call in order), for the rules;
 *   - real unzip + the real initExec spawner + a real filesystem under the OS tmpdir, with a thin
 *     io that REPORTS uid 0 for files this (non-root) user owns — the one seam, named here —
 *     so the chain runs end to end on macOS and Linux alike.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initExec } from '../src/exec';
import type { ExecResult } from '../src/provision/exec_contract';
import type { DirFacts } from '../src/provision/lock';
import { sha256Hex } from '../src/provision/init/bun_asset';
import { BUN_EXTRACT_DIR_NAME, BunInstallFailed, type BunInstallPorts, BunInstallRefused, installBun } from '../src/provision/init/bun_install';
import { READ_CAP_BYTES } from '../src/provision/init/host_io';
import type { OperatorFile } from '../src/provision/init/types';
import { BINARY_READ_CAP_BYTES } from '../src/provision/init/types';
import { fakeBun, fakeBunZip, shaTable } from './fixtures/bun/zip_store';
import { scratchDir } from '../../../test/helpers/scratch_dir.ts';

const PIN = '9.9.9';
const ASSET = 'bun-linux-x64';
const ZIP = fakeBunZip(ASSET, PIN);
const TABLE = shaTable(PIN, { [ASSET]: sha256Hex(ZIP) });
const enc = new TextEncoder();

/* ── layer 1: the recording fake ─────────────────────────────────────────────────── */

interface FakeWorld {
  files: Map<string, { bytes: Uint8Array; uid: number; mode: number }>;
  dirs: Map<string, { uid: number; mode: number; symlink?: boolean }>;
  calls: string[];
  versions: Map<string, ExecResult>;
  unzipCode: number;
  /** A file's size as the door sees it, when it differs from its (small, fake) bytes. */
  sizes: Map<string, number>;
}

function world(): FakeWorld {
  const dirs = new Map<string, { uid: number; mode: number; symlink?: boolean }>();
  for (const d of ['/var', '/var/lib', '/var/lib/dd_init', '/var/lib/dd_init/inst', '/opt']) dirs.set(d, { uid: 0, mode: 0o755 });
  const files = new Map<string, { bytes: Uint8Array; uid: number; mode: number }>();
  files.set('/var/lib/dd_init/inst/stage/bun/bun-linux-x64.zip', { bytes: ZIP, uid: 0, mode: 0o600 });
  return { files, dirs, calls: [], versions: new Map(), unzipCode: 0, sizes: new Map() };
}

function fakePorts(w: FakeWorld, table = TABLE): BunInstallPorts {
  // The door's cap is the host_io one (8 MiB text cap unless raised): a real Bun archive is ~37 MB.
  const op = (path: string, capBytes: number = READ_CAP_BYTES): OperatorFile => {
    const f = w.files.get(path);
    if (f === undefined) throw new Error(`ENOENT ${path}`);
    const size = w.sizes.get(path) ?? f.bytes.length;
    if (size > capBytes) throw new Error(`init io: refusing '${path}': ${size} bytes is over the ${capBytes}-byte cap`);
    return { bytes: f.bytes, uid: f.uid, gid: 0, mode: f.mode, sha: sha256Hex(f.bytes) };
  };
  return {
    table,
    stateDir: '/var/lib/dd_init/inst',
    lstat: (path: string): DirFacts | null => {
      const d = w.dirs.get(path);
      if (d !== undefined) return { type: d.symlink ? 'symlink' : 'dir', uid: d.uid, mode: d.mode };
      const f = w.files.get(path);
      return f === undefined ? null : { type: 'file', uid: f.uid, mode: f.mode };
    },
    io: {
      readOperatorFile: op,
      readRootFile: (path: string) => {
        const f = w.files.get(path);
        return f === undefined ? null : new TextDecoder().decode(f.bytes);
      },
      mkdir: (path: string, mode: number) => {
        w.calls.push(`mkdir ${path} ${mode.toString(8)}`);
        w.dirs.set(path, { uid: 501, mode });
      },
      chown: (path: string, uid: number, gid: number) => {
        w.calls.push(`chown ${path} ${uid}:${gid}`);
        const d = w.dirs.get(path);
        if (d !== undefined) d.uid = uid;
      },
      chmod: (path: string, mode: number) => w.calls.push(`chmod ${path} ${mode.toString(8)}`),
      writeBytesAtomic: (path: string, bytes: Uint8Array, mode: number, uid: number, gid: number) => {
        w.calls.push(`write ${path} ${mode.toString(8)} ${uid}:${gid} ${new TextDecoder().decode(bytes).includes('OLD') ? 'old' : 'new'}`);
        w.files.set(path, { bytes, uid, mode });
      },
      removeTree: (path: string, under: string) => {
        w.calls.push(`rmtree ${path} under ${under}`);
        w.dirs.delete(path);
        for (const k of [...w.files.keys()]) if (k.startsWith(`${path}/`)) w.files.delete(k);
      },
    },
    exec: {
      unzipBun: (zip: string, asset: string, dest: string) => {
        w.calls.push(`unzip ${zip} ${asset} ${dest}`);
        if (w.unzipCode === 0) w.files.set(`${dest}/bun`, { bytes: enc.encode(fakeBun(PIN)), uid: 0, mode: 0o755 });
        return { code: w.unzipCode, stdout: '', stderr: '' };
      },
      bunVersion: (bin: string) => {
        w.calls.push(`version ${bin}`);
        return w.versions.get(bin) ?? { code: 0, stdout: `${PIN}\n`, stderr: '' };
      },
    },
  };
}

const ARCHIVE = '/var/lib/dd_init/inst/stage/bun/bun-linux-x64.zip';
const EXTRACT = `/var/lib/dd_init/inst/${BUN_EXTRACT_DIR_NAME}`;
const CPU = { arch: 'x64', avx2: true, musl: false } as const;

describe('installBun (fake ports)', () => {
  test('a fresh install: hash, extract, version, chain, write, version, cleanup — in that order', () => {
    const w = world();
    const result = installBun(ARCHIVE, null, PIN, CPU, '/opt/dedalo_publication_host/bun/bin/bun', fakePorts(w));
    expect(result).toEqual({ asset: ASSET, sha: sha256Hex(ZIP), target: '/opt/dedalo_publication_host/bun/bin/bun', replaced: false });
    expect(w.calls).toEqual([
      `mkdir ${EXTRACT} 700`,
      `chown ${EXTRACT} 0:0`,
      `chmod ${EXTRACT} 700`,
      `unzip ${ARCHIVE} ${ASSET} ${EXTRACT}`,
      `version ${EXTRACT}/bun`,
      'mkdir /opt/dedalo_publication_host 755',
      'chown /opt/dedalo_publication_host 0:0',
      'chmod /opt/dedalo_publication_host 755',
      'mkdir /opt/dedalo_publication_host/bun 755',
      'chown /opt/dedalo_publication_host/bun 0:0',
      'chmod /opt/dedalo_publication_host/bun 755',
      'mkdir /opt/dedalo_publication_host/bun/bin 755',
      'chown /opt/dedalo_publication_host/bun/bin 0:0',
      'chmod /opt/dedalo_publication_host/bun/bin 755',
      'write /opt/dedalo_publication_host/bun/bin/bun 755 0:0 new',
      'version /opt/dedalo_publication_host/bun/bin/bun',
      `rmtree ${EXTRACT} under /var/lib/dd_init/inst`,
    ]);
  });

  test("a REAL-SIZED archive and binary (the drill's 36 602 920-byte aarch64 zip, a ~95 MB x64 bun) are read under the binary cap, not the 8 MiB text cap", () => {
    const w = world();
    w.sizes.set('/var/lib/dd_init/inst/stage/bun/bun-linux-x64.zip', 36_602_920);
    w.sizes.set(`/var/lib/dd_init/inst/${BUN_EXTRACT_DIR_NAME}/bun`, 95_000_000);
    expect(36_602_920).toBeGreaterThan(READ_CAP_BYTES);
    expect(95_000_000).toBeLessThan(BINARY_READ_CAP_BYTES);
    const done = installBun('/var/lib/dd_init/inst/stage/bun/bun-linux-x64.zip', null, PIN, CPU, '/opt/dd/bun/bin/bun', fakePorts(w));
    expect(done.asset).toBe(ASSET);
    // A previous bun_bin of real size is read under the same cap (the restore path needs its bytes).
    w.sizes.set('/opt/dd/bun/bin/bun', 95_000_000);
    expect(installBun('/var/lib/dd_init/inst/stage/bun/bun-linux-x64.zip', null, PIN, CPU, '/opt/dd/bun/bin/bun', fakePorts(w)).replaced).toBe(true);
  });

  test('the asset compare chose is accepted in place of the cpu row', () => {
    const w = world();
    expect(installBun(ARCHIVE, null, PIN, ASSET, '/opt/bun', fakePorts(w)).asset).toBe(ASSET);
  });

  test('a mutated archive is refused before anything is unpacked or run', () => {
    const w = world();
    const bad = ZIP.slice();
    bad[50] = (bad[50] ?? 0) ^ 0xff;
    w.files.set(ARCHIVE, { bytes: bad, uid: 0, mode: 0o600 });
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(BunInstallRefused);
    expect(w.calls).toEqual([]);
  });

  test('SHASUMS disagreeing, or unreadable, is refused before anything runs', () => {
    const w = world();
    w.files.set('/var/lib/dd_init/inst/stage/bun/SHASUMS256.txt', { bytes: enc.encode(`${'1'.repeat(64)}  ${ASSET}.zip\n`), uid: 0, mode: 0o600 });
    expect(() => installBun(ARCHIVE, '/var/lib/dd_init/inst/stage/bun/SHASUMS256.txt', PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/disagrees/);
    expect(() => installBun(ARCHIVE, '/var/lib/dd_init/inst/stage/bun/none.txt', PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/cannot be read/);
    expect(w.calls).toEqual([]);
  });

  test('a matching SHASUMS cross-check passes', () => {
    const w = world();
    w.files.set('/var/lib/dd_init/inst/stage/bun/SHASUMS256.txt', { bytes: enc.encode(`${sha256Hex(ZIP)}  ${ASSET}.zip\n`), uid: 0, mode: 0o600 });
    expect(installBun(ARCHIVE, '/var/lib/dd_init/inst/stage/bun/SHASUMS256.txt', PIN, CPU, '/opt/bun', fakePorts(w)).asset).toBe(ASSET);
  });

  test('an archive not owned by root, or writable by others, is refused', () => {
    for (const meta of [{ uid: 501, mode: 0o600 }, { uid: 0, mode: 0o620 }]) {
      const w = world();
      w.files.set(ARCHIVE, { bytes: ZIP, ...meta });
      expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/root-owned/);
    }
  });

  test('a table for another pin is refused', () => {
    const w = world();
    expect(() => installBun(ARCHIVE, null, '9.9.8', CPU, '/opt/bun', fakePorts(w))).toThrow(/disagree/);
  });

  test('exit 126 of the extracted bun names noexec/fapolicyd, and nothing is written', () => {
    const w = world();
    w.versions.set(`${EXTRACT}/bun`, { code: 126, stdout: '', stderr: '' });
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/noexec.*findmnt -T \/var\/lib\/dd_init\/inst.*fapolicyd/);
    expect(w.calls.some(c => c.startsWith('write'))).toBe(false);
    expect(w.calls.at(-1)).toBe(`rmtree ${EXTRACT} under /var/lib/dd_init/inst`);
  });

  test('another --version failure names glibc; a wrong version names the pin', () => {
    const w = world();
    w.versions.set(`${EXTRACT}/bun`, { code: 1, stdout: '', stderr: 'GLIBC_2.27 not found' });
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/getconf GNU_LIBC_VERSION/);
    const v = world();
    v.versions.set(`${EXTRACT}/bun`, { code: 0, stdout: '1.0.0\n', stderr: '' });
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(v))).toThrow(/says '1.0.0', the pin is 9.9.9/);
    expect(v.calls.some(c => c.startsWith('write'))).toBe(false);
  });

  test('unzip failure is FAILED, bun_bin unchanged, extract removed', () => {
    const w = world();
    w.unzipCode = 9;
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(BunInstallFailed);
    expect(w.calls.some(c => c.startsWith('write') || c.startsWith('version'))).toBe(false);
    expect(w.calls.at(-1)).toStartWith('rmtree');
  });

  test('a stale extract directory is wiped first', () => {
    const w = world();
    w.dirs.set(EXTRACT, { uid: 0, mode: 0o700 });
    installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w));
    expect(w.calls[0]).toBe(`rmtree ${EXTRACT} under /var/lib/dd_init/inst`);
  });

  test('an existing ancestor is never chowned or chmodded', () => {
    const w = world();
    w.dirs.set('/opt/dedalo_publication_host', { uid: 0, mode: 0o755 });
    installBun(ARCHIVE, null, PIN, CPU, '/opt/dedalo_publication_host/bun/bin/bun', fakePorts(w));
    expect(w.calls.filter(c => / \/opt(\/dedalo_publication_host)? /.test(`${c} `))).toEqual([]);
  });

  test('an ancestor that is not root-owned, is writable by others, or is a symlink: refused before any change', () => {
    for (const meta of [{ uid: 1000, mode: 0o755 }, { uid: 0, mode: 0o775 }, { uid: 0, mode: 0o755, symlink: true }]) {
      const w = world();
      w.dirs.set('/home', { uid: 0, mode: 0o755 });
      w.dirs.set('/home/site.example.org', meta);
      expect(() => installBun(ARCHIVE, null, PIN, CPU, '/home/site.example.org/.bun/bin/bun', fakePorts(w))).toThrow(BunInstallRefused);
      expect(w.calls).toEqual([]);
    }
  });

  test('a target that is a directory or a symlink is refused', () => {
    const w = world();
    w.dirs.set('/opt/bun', { uid: 0, mode: 0o755 });
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/is a dir/);
    w.dirs.set('/opt/bun', { uid: 0, mode: 0o777, symlink: true });
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/is a symlink/);
  });

  test('a failing post-write --version restores the previous bytes', () => {
    const w = world();
    w.files.set('/opt/bun', { bytes: enc.encode('OLD bun'), uid: 0, mode: 0o755 });
    w.versions.set('/opt/bun', { code: 126, stdout: '', stderr: '' });
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/previous bun_bin was restored/);
    expect(w.calls.filter(c => c.startsWith('write'))).toEqual(['write /opt/bun 755 0:0 new', 'write /opt/bun 755 0:0 old']);
    expect(new TextDecoder().decode(w.files.get('/opt/bun')?.bytes)).toBe('OLD bun');
  });

  test('a failing post-write --version without a previous file says so', () => {
    const w = world();
    w.versions.set('/opt/bun', { code: 0, stdout: '0.0.1\n', stderr: '' });
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/no previous bun_bin/);
  });

  test('a replaced file is reported', () => {
    const w = world();
    w.files.set('/opt/bun', { bytes: enc.encode('OLD bun'), uid: 0, mode: 0o755 });
    expect(installBun(ARCHIVE, null, PIN, CPU, '/opt/bun', fakePorts(w)).replaced).toBe(true);
  });

  test('unclean paths and a foreign asset are refused', () => {
    const w = world();
    expect(() => installBun('relative.zip', null, PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/clean absolute/);
    expect(() => installBun(ARCHIVE, '/x/../y', PIN, CPU, '/opt/bun', fakePorts(w))).toThrow(/clean absolute/);
    expect(() => installBun(ARCHIVE, null, PIN, CPU, '/opt/../bun', fakePorts(w))).toThrow(/clean absolute/);
    expect(() => installBun(ARCHIVE, null, PIN, 'bun-darwin-x64' as never, '/opt/bun', fakePorts(w))).toThrow(/not a Bun asset/);
    expect(() => installBun(ARCHIVE, null, PIN, { arch: 'other', avx2: false, musl: false }, '/opt/bun', fakePorts(w))).toThrow(/no Bun build/);
  });
});

/* ── layer 2: real unzip, real spawns, real files ────────────────────────────────── */

const SCRATCH = scratchDir('dd_p5_bun_install', { realpath: true });

/** Real fs doors; the ONE seam: files this user owns are reported as uid 0 (non-root gate). */
function realPorts(stateDir: string): BunInstallPorts {
  const asRoot = (uid: number): number => (uid === process.getuid?.() ? 0 : uid);
  return {
    table: TABLE,
    stateDir,
    lstat: (path: string) => {
      // The scenario is SCRATCH and below. Its ancestors are the test host's own tmpdir chain,
      // which installBun rightly refuses on Linux (/tmp is root 1777: writable by others) and
      // which no install would place bun_bin under; they read as the root-owned 0755 chain a
      // real host has above /opt. The ancestor refusals are the fake-ports tests' job above.
      if (SCRATCH.startsWith(`${path}/`)) return { type: 'dir', uid: 0, mode: 0o755 };
      try {
        const s = lstatSync(path);
        return { type: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', uid: asRoot(s.uid), mode: s.mode & 0o7777 };
      } catch {
        return null;
      }
    },
    io: {
      readOperatorFile: (path: string) => {
        const bytes = new Uint8Array(readFileSync(path));
        const s = statSync(path);
        return { bytes, uid: asRoot(s.uid), gid: 0, mode: s.mode & 0o7777, sha: sha256Hex(bytes) };
      },
      readRootFile: (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
      mkdir: (path: string, mode: number) => mkdirSync(path, { mode }),
      chown: () => {},
      chmod: (path: string, mode: number) => chmodSync(path, mode),
      writeBytesAtomic: (path: string, bytes: Uint8Array, mode: number) => {
        const temp = join(dirname(path), `.${path.split('/').at(-1)}.dedalo-init.tmp`);
        writeFileSync(temp, bytes, { mode, flag: 'wx' });
        chmodSync(temp, mode);
        renameSync(temp, path);
      },
      removeTree: (path: string, under: string) => {
        if (!path.startsWith(`${under}/`)) throw new Error('outside');
        rmSync(path, { recursive: true, force: true });
      },
    },
    exec: initExec(),
  };
}

describe('installBun (real unzip, real files)', () => {
  beforeAll(() => {
    mkdirSync(join(SCRATCH, 'state'), { mode: 0o700 });
    writeFileSync(join(SCRATCH, 'state', 'bun.zip'), ZIP, { mode: 0o600 });
  });
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  test('the fake release installs, runs, and the extract directory is gone', () => {
    const target = join(SCRATCH, 'opt', 'bun', 'bin', 'bun');
    const result = installBun(join(SCRATCH, 'state', 'bun.zip'), null, PIN, ASSET, target, realPorts(join(SCRATCH, 'state')));
    expect(result.replaced).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(fakeBun(PIN));
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(statSync(join(SCRATCH, 'opt', 'bun')).mode & 0o777).toBe(0o755);
    expect(existsSync(join(SCRATCH, 'state', BUN_EXTRACT_DIR_NAME))).toBe(false);
    expect(existsSync(join(SCRATCH, 'state', 'bun.zip'))).toBe(true);
  });

  test('a second run replaces the file in place', () => {
    const target = join(SCRATCH, 'opt', 'bun', 'bin', 'bun');
    expect(installBun(join(SCRATCH, 'state', 'bun.zip'), null, PIN, ASSET, target, realPorts(join(SCRATCH, 'state'))).replaced).toBe(true);
  });
});
