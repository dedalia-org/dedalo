/**
 * THE TRAMPOLINE, deploy/install.sh (spec §1.1, §1.3, §9 "Trampoline").
 *
 * - `sh -n`, and shellcheck: RED on Linux when shellcheck is missing (CI must have it),
 *   skipped with its reason on Darwin only.
 * - its constants are parsed and held EQUAL to the TS ones (BUN_ASSETS, INIT_BASE,
 *   SOURCE_MANIFEST, the hand-over flags, the table header grammar, the instance grammar);
 * - the library (`set -- --lib; . install.sh`, POSIX/BSD tools only) is driven for real:
 *   verify_bun over in-test fake Bun archives (a mutated byte, a table/sums disagreement, a
 *   header pin mismatch, a missing signed-by line, exit 126, a wrong --version — each exit 3
 *   with the stage removed); check_tree (an escaping link, an absolute link, a dangling link,
 *   a FIFO — each exit 3); tree_digest equal to the §1.3 algorithm computed here in TS;
 *   family_of on Debian/Ubuntu/EL os-release fixtures, never sourcing the file; refuse_host;
 *   pick_asset;
 * - main itself, as this non-root user, exits 3.
 *
 * The shipped file has no test bypass: library mode only defines functions.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../../test/helpers/scratch_dir';
import { BUN_ASSETS } from '../src/provision/exec_contract';
import { INIT_FLAGS } from '../src/provision/init/args';
import { BUN_RELEASE_BASE, SHA_TABLE_PIN_LINE, SHA_TABLE_SIGNED_BY_LINE, sha256Hex } from '../src/provision/init/bun_asset';
import {
  BUN_HANDOVER_FLAGS,
  EMPTY_BUNFIG_NAME,
  INIT_FLAGS_HANDOVER,
  INSTALL_LOCK_NAME,
  RERUN_ENV_NAME,
  SOURCE_MANIFEST,
  STAGE_DIR_NAME,
} from '../src/provision/init/constants';
import { OS_SUPPORT } from '../src/provision/init/parse/os';
import { BUN_KERNEL_FLOOR, INSTANCE_PATTERN } from '../src/provision/layout';
import { INIT_BASE } from '../src/provision/lock';
import { fakeBunZip, shaTable } from './fixtures/bun/zip_store';

const INSTALL_SH = join(import.meta.dir, '..', 'deploy', 'install.sh');
const OS_RELEASE = join(import.meta.dir, 'fixtures', 'bun', 'os-release');
/**
 * OUTSIDE the checkout on purpose: this gate plants FIFOs and dangling links, which a
 * repo-walking gate running in parallel must never meet (a FIFO blocks a reader).
 */
const SCRATCH = scratchDir('dd_p5_install_sh', { realpath: true });
const TEXT = readFileSync(INSTALL_SH, 'utf8');
const LINUX = process.platform === 'linux';

/** Runs `<fn> <args…>` with the file sourced in library mode. */
function lib(fn: string, ...args: string[]): { code: number; out: string; err: string } {
  const run = spawnSync('sh', ['-c', 'script=$0; set -- --lib "$@"; . "$script"; shift; "$@"', INSTALL_SH, fn, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
  });
  return { code: run.status ?? -1, out: run.stdout, err: run.stderr };
}

/** A top-level `NAME=value` / `NAME='value'` assignment of the sh file. */
function shConst(name: string): string {
  const match = new RegExp(`^${name}=(?:'([^']*)'|(\\S+))$`, 'm').exec(TEXT);
  if (match === null) throw new Error(`install.sh has no ${name}=`);
  return match[1] ?? match[2] ?? '';
}

describe('install.sh syntax', () => {
  test('sh -n', () => {
    expect(spawnSync('sh', ['-n', INSTALL_SH]).status).toBe(0);
  });

  const shellcheck = Bun.which('shellcheck');
  if (shellcheck === null && !LINUX) {
    test.skip('shellcheck — not installed on this Darwin machine (required, and RED, on Linux CI)', () => {});
  } else {
    test('shellcheck -s sh is clean', () => {
      expect(shellcheck, 'shellcheck is required on Linux (apt install shellcheck)').not.toBeNull();
      const run = spawnSync(shellcheck as string, ['-s', 'sh', INSTALL_SH], { encoding: 'utf8' });
      expect(run.stdout + run.stderr).toBe('');
      expect(run.status).toBe(0);
    });
  }
});

describe('install.sh constants equal the TS ones', () => {
  test('INIT_BASE, BUN_ASSETS, the release base', () => {
    expect(shConst('INIT_BASE')).toBe(INIT_BASE);
    expect(shConst('BUN_ASSETS').split(' ')).toEqual([...BUN_ASSETS]);
    expect(shConst('BUN_RELEASE_BASE')).toBe(BUN_RELEASE_BASE);
  });

  test('SOURCE_MANIFEST (order, kinds) and its excludes', () => {
    expect(shConst('SOURCE_MANIFEST').split(' ')).toEqual(SOURCE_MANIFEST.map(e => `${e.path}:${e.kind}`));
    const excludes = SOURCE_MANIFEST.flatMap(e => e.exclude);
    expect(shConst('SOURCE_EXCLUDES').split(' ')).toEqual(excludes);
    // the sh copy skips an exclude only as a DIRECT child of its tree
    for (const entry of SOURCE_MANIFEST) for (const ex of entry.exclude) expect(ex.slice(entry.path.length + 1)).not.toContain('/');
  });

  test('the hand-over: flags, Bun flags, stage names', () => {
    expect(shConst('HANDOVER_FLAGS').split(' ')).toEqual([...INIT_FLAGS_HANDOVER]);
    for (const flag of INIT_FLAGS_HANDOVER) expect(INIT_FLAGS.map(f => f.flag)).toContain(flag);
    expect(shConst('BUN_HANDOVER_FLAGS').split(' ')).toEqual([...BUN_HANDOVER_FLAGS]);
    expect(shConst('EMPTY_BUNFIG_NAME')).toBe(EMPTY_BUNFIG_NAME);
    expect(shConst('STAGE_DIR_NAME')).toBe(STAGE_DIR_NAME);
    expect(shConst('RERUN_ENV_NAME')).toBe(RERUN_ENV_NAME);
    expect(shConst('INSTALL_LOCK_NAME')).toBe(INSTALL_LOCK_NAME);
    expect(shConst('ENTRY_REL')).toBe('publication/host_agent/src/provision/cli.ts');
  });

  test('the EL release floor and the kernel floor are the TS ones (parse/os.ts rows, layout.ts)', () => {
    expect(shConst('BUN_KERNEL_FLOOR')).toBe(BUN_KERNEL_FLOOR);
    expect(BUN_KERNEL_FLOOR).toMatch(/^\d+\.\d+$/); // refuse_kernel compares <major>.<minor> only
    const elMajors = OS_SUPPORT.filter(row => row.family === 'el').map(row => Number(row.version));
    expect(Number(shConst('EL_MAJOR_FLOOR'))).toBe(Math.min(...elMajors));
  });

  test('main: the release/kernel refusals come before any Bun is fetched; the lock before the stage is cleared', () => {
    const at = (needle: string): number => {
      const index = TEXT.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const fetch = at('fetch_https "$BASE'); // main's first download (the door: init_install_sh_fetch.test.ts)
    expect(at('FAMILY=$(family_of /etc/os-release) || exit 3')).toBeLessThan(fetch);
    expect(at('refuse_kernel "$(uname -r)"')).toBeLessThan(fetch);
    expect(at('hold_install_lock "$STATE"')).toBeLessThan(at('rm -rf "$STAGE"'));
    // no `set -e`: a function that dies inside $(…) exits only the subshell — main must stop too
    const captured = [...TEXT.matchAll(/^\s*[A-Z_]+=\$\((family_of|pick_asset|tree_digest|refuse_kernel)\b[^\n]*$/gm)];
    expect(captured.length).toBe(3);
    for (const line of captured) expect(line[0].trimEnd(), line[0]).toMatch(/\) \|\| exit 3$/);
  });

  test('the exec line: env -i, fixed PATH/HOME/LC_ALL, the Bun flags, the empty bunfig (--config=, never -c), init', () => {
    // bun 1.4.2, measured: `-c <file>` runs <file> as the entry; `-c=<file>` still loads $cwd/bunfig.toml.
    expect(TEXT).not.toMatch(/"\$BUNX"[^\n]* -c[ =]/);
    const exec = /exec env -i PATH=\$HANDOVER_PATH HOME=\/root LC_ALL=C \\\n\s+"\$BUNX" \$BUN_HANDOVER_FLAGS --config="\$STAGE\/\$EMPTY_BUNFIG_NAME" "\$ENTRY" init "\$INSTANCE" "\$@"/;
    expect(TEXT).toMatch(exec);
    expect(shConst('HANDOVER_PATH')).toBe('/usr/sbin:/usr/bin:/sbin:/bin');
  });

  test('the hand-over flags are prepended in INIT_FLAGS_HANDOVER order', () => {
    // The `set --` lines PREPEND, so the last one executed comes first on the command line.
    const sets = [...TEXT.matchAll(/set -- (--[a-z-]+ "[^"]+"(?: --[a-z-]+ "[^"]+")*) "\$@"/g)].map(m =>
      [...(m[1] ?? '').matchAll(/(--[a-z-]+) /g)].map(f => f[1]),
    );
    expect(sets.reverse().flat()).toEqual([...INIT_FLAGS_HANDOVER]);
  });

  test('the table header and instance grammars equal the TS patterns', () => {
    const strip = (re: RegExp): string => re.source.replace(/[()]/g, '');
    expect(shConst('TABLE_PIN_RE')).toBe(strip(SHA_TABLE_PIN_LINE));
    expect(shConst('TABLE_SIGNED_BY_RE')).toBe(strip(SHA_TABLE_SIGNED_BY_LINE));
    expect(shConst('INSTANCE_RE')).toBe(INSTANCE_PATTERN.source);
  });
});

describe('install.sh library', () => {
  const PIN = '9.9.9';
  const ASSET = 'bun-linux-x64';
  let zip = '';
  let table = '';
  let sums = '';
  const stage = (): string => join(SCRATCH, 'stage_bun');

  beforeAll(() => {
    // SCRATCH is the fresh mkdtemp dir (atomic, 0700): written into, never re-created.
    const bytes = fakeBunZip(ASSET, PIN);
    zip = join(SCRATCH, `${ASSET}.zip`);
    writeFileSync(zip, bytes);
    table = join(SCRATCH, 'table');
    writeFileSync(table, shaTable(PIN, { [ASSET]: sha256Hex(bytes) }));
    sums = join(SCRATCH, 'SHASUMS256.txt');
    writeFileSync(sums, `${'1'.repeat(64)}  bun-linux-aarch64.zip\n${sha256Hex(bytes)}  ${ASSET}.zip\n${'2'.repeat(64)}  bun-linux-x64-baseline.zip\n`);
  });
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  test('verify_bun accepts the pinned archive, with and without sums, and leaves bun', () => {
    for (const s of [sums, '-']) {
      rmSync(stage(), { recursive: true, force: true });
      const run = lib('verify_bun', zip, s, ASSET, PIN, table, stage());
      expect(run.err).toBe('');
      expect(run.code).toBe(0);
      expect(readdirSync(stage())).toEqual(['bun']);
    }
  });

  const refused = (what: string, args: () => string[], message: RegExp) =>
    test(`verify_bun refuses ${what} (exit 3, stage removed)`, () => {
      rmSync(stage(), { recursive: true, force: true });
      mkdirSync(stage());
      const run = lib('verify_bun', ...args());
      expect(run.code).toBe(3);
      expect(run.err).toMatch(message);
      expect(existsSync(stage())).toBe(false);
    });

  refused(
    'a mutated byte',
    () => {
      const bad = new Uint8Array(readFileSync(zip));
      bad[60] = (bad[60] ?? 0) ^ 1;
      writeFileSync(join(SCRATCH, 'bad.zip'), bad);
      return [join(SCRATCH, 'bad.zip'), sums, ASSET, PIN, table, stage()];
    },
    /not the pinned release/,
  );
  refused(
    'a table/sums disagreement',
    () => {
      writeFileSync(join(SCRATCH, 'sums_other'), `${'3'.repeat(64)}  ${ASSET}.zip\n`);
      return [zip, join(SCRATCH, 'sums_other'), ASSET, PIN, table, stage()];
    },
    /disagrees/,
  );
  refused(
    'sums naming the asset twice',
    () => {
      writeFileSync(join(SCRATCH, 'sums_twice'), `${readFileSync(sums, 'utf8')}${readFileSync(sums, 'utf8')}`);
      return [zip, join(SCRATCH, 'sums_twice'), ASSET, PIN, table, stage()];
    },
    /2 times/,
  );
  refused('a header pin mismatch', () => [zip, sums, ASSET, '9.9.8', table, stage()], /line 1/);
  refused(
    'a missing signed-by line',
    () => {
      writeFileSync(join(SCRATCH, 'table_unsigned'), readFileSync(table, 'utf8').replace(/# signed-by: .*\n/, ''));
      return [zip, sums, ASSET, PIN, join(SCRATCH, 'table_unsigned'), stage()];
    },
    /line 2/,
  );
  refused('a foreign asset', () => [zip, sums, 'bun-darwin-x64', PIN, table, stage()], /not a Bun asset/);
  refused(
    'exit 126 of bun --version (names noexec, findmnt and fapolicyd)',
    () => {
      const bytes = fakeBunZip(ASSET, PIN, 126);
      writeFileSync(join(SCRATCH, 'noexec.zip'), bytes);
      writeFileSync(join(SCRATCH, 'table_noexec'), shaTable(PIN, { [ASSET]: sha256Hex(bytes) }));
      return [join(SCRATCH, 'noexec.zip'), '-', ASSET, PIN, join(SCRATCH, 'table_noexec'), stage()];
    },
    new RegExp(`${INIT_BASE} is on a noexec filesystem \\(or fapolicyd denies it\\): see \`findmnt -T ${INIT_BASE}\``),
  );
  refused(
    'a --version that is not the pin',
    () => {
      const bytes = fakeBunZip(ASSET, '1.0.0');
      writeFileSync(join(SCRATCH, 'other.zip'), bytes);
      writeFileSync(join(SCRATCH, 'table_other'), shaTable(PIN, { [ASSET]: sha256Hex(bytes) }));
      return [join(SCRATCH, 'other.zip'), '-', ASSET, PIN, join(SCRATCH, 'table_other'), stage()];
    },
    /says '1.0.0', the pin is 9.9.9/,
  );

  describe('check_tree and tree_digest', () => {
    const tree = (): string => join(SCRATCH, 'tree');
    const fresh = (): string => {
      rmSync(tree(), { recursive: true, force: true });
      mkdirSync(join(tree(), 'a', 'b c'), { recursive: true });
      writeFileSync(join(tree(), 'a', 'b c', 'f.txt'), 'one\n');
      writeFileSync(join(tree(), 'Z.txt'), 'two');
      writeFileSync(join(tree(), '.hidden'), '');
      symlinkSync('../Z.txt', join(tree(), 'a', 'up'));
      symlinkSync('b c/f.txt', join(tree(), 'a', 'in'));
      return tree();
    };

    test('a clean tree with internal relative links passes', () => {
      const run = lib('check_tree', fresh());
      expect(run.err).toBe('');
      expect(run.code).toBe(0);
    });

    test.each([
      ['a link escaping the tree', (root: string) => symlinkSync('../../outside', join(root, 'a', 'esc')), /leaves the source: .*\/a\/esc$/m],
      ['an absolute link, even into the tree', (root: string) => symlinkSync(join(root, 'Z.txt'), join(root, 'abs')), /absolute.*\/abs$/m],
      ['a dangling link', (root: string) => symlinkSync('nowhere', join(root, 'dangling')), /dangling.*\/dangling$/m],
      ['a link to the tree root itself', (root: string) => symlinkSync('..', join(root, 'a', 'root')), /leaves the source: .*\/a\/root$/m],
      ['a FIFO', (root: string) => expect(spawnSync('mkfifo', [join(root, 'pipe')]).status).toBe(0), /special file.*\/pipe$/m],
      ['a name with a newline', (root: string) => writeFileSync(join(root, 'x\ny'), ''), /newline/],
    ] as const)('check_tree refuses %s (exit 3)', (_what, plant, message) => {
      const root = fresh();
      writeFileSync(join(SCRATCH, 'outside'), '');
      plant(root);
      const run = lib('check_tree', root);
      expect(run.code).toBe(3);
      expect(run.err).toMatch(message);
    });

    /** spec §1.3, recomputed independently in TS. */
    function referenceDigest(root: string): string {
      const lines: { path: string; line: string }[] = [];
      const walk = (rel: string): void => {
        for (const name of readdirSync(join(root, rel))) {
          const r = rel === '' ? name : `${rel}/${name}`;
          const p = `./${r}`;
          const st = lstatSync(join(root, r));
          if (st.isSymbolicLink()) lines.push({ path: p, line: `L ${readlinkSync(join(root, r))} ${p}` });
          else if (st.isDirectory()) {
            lines.push({ path: p, line: `D ${p}` });
            walk(r);
          } else lines.push({ path: p, line: `F ${sha256Hex(readFileSync(join(root, r)))} ${p}` });
        }
      };
      walk('');
      lines.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      return createHash('sha256')
        .update(lines.map(l => l.line).join('\n'))
        .digest('hex');
    }

    test('tree_digest equals the §1.3 algorithm', () => {
      const root = fresh();
      const run = lib('tree_digest', root);
      expect(run.code).toBe(0);
      expect(run.out.trim()).toBe(referenceDigest(root));
    });

    test('tree_digest moves with a byte, a link target and an empty directory', () => {
      const root = fresh();
      const base = lib('tree_digest', root).out;
      writeFileSync(join(root, 'Z.txt'), 'twO');
      const byte = lib('tree_digest', root).out;
      expect(byte).not.toBe(base);
      rmSync(join(root, 'a', 'in'));
      symlinkSync('b c', join(root, 'a', 'in'));
      const link = lib('tree_digest', root).out;
      expect(link).not.toBe(byte);
      mkdirSync(join(root, 'empty'));
      expect(lib('tree_digest', root).out).not.toBe(link);
      expect(lib('tree_digest', root).out.trim()).toBe(referenceDigest(root));
    });
  });

  test('family_of names debian or el, and the install command follows', () => {
    for (const [file, family] of [
      ['debian12', 'debian'],
      ['ubuntu2404', 'debian'],
      ['ubuntu2604', 'debian'],
      ['rhel9', 'el'],
      ['rhel_bare', 'el'], // no ID_LIKE: ID alone names the family
      ['rocky10', 'el'],
      ['alma9', 'el'],
    ] as const) {
      const run = lib('family_of', join(OS_RELEASE, file));
      expect(run.code).toBe(0);
      expect(run.out.trim()).toBe(family);
      expect(lib('pkg_hint', family).out.trim()).toBe(`${family === 'el' ? 'dnf' : 'apt'} install curl unzip coreutils util-linux`);
    }
  });

  test('family_of refuses EL 8 (and an EL without a numeric VERSION_ID) before any Bun is fetched', () => {
    for (const file of ['rocky8', 'alma8', 'rhel8']) {
      const run = lib('family_of', join(OS_RELEASE, file));
      expect(run.code, file).toBe(3);
      expect(run.out, file).toBe('');
      expect(run.err, file).toContain('EL 8.10');
      expect(run.err, file).toContain('upgrade to RHEL, Rocky or Alma 9 or 10');
    }
    const bare = lib('family_of', join(OS_RELEASE, 'el_no_version'));
    expect(bare.code).toBe(3);
    expect(bare.err).toContain('without a numeric VERSION_ID');
  });

  test("refuse_kernel: below Bun's floor exits 3, at or above it passes", () => {
    for (const release of ['4.18.0-553.el8_10.x86_64', '5.0.21', '3.10.0-1160.el7.x86_64']) {
      const run = lib('refuse_kernel', release);
      expect(run.code, release).toBe(3);
      expect(run.err, release).toContain(`below Bun's floor ${BUN_KERNEL_FLOOR}`);
    }
    for (const release of ['5.1.0', '5.14.0-427.el9.x86_64', '6.12.0-55.el10.x86_64', '10.0.1']) {
      expect(lib('refuse_kernel', release).code, release).toBe(0);
    }
    expect(lib('refuse_kernel', 'garbage').err).toContain('has no <major>.<minor>');
  });

  test('hold_install_lock: a held lock (flock -n fails) exits 3 naming the cause; a free one passes', () => {
    const state = join(SCRATCH, 'lock_state');
    mkdirSync(state, { recursive: true });
    const withFlock = (exit: number): { code: number; err: string } => {
      const bin = join(SCRATCH, `flock_${exit}`);
      mkdirSync(bin, { recursive: true });
      // a stand-in for util-linux flock (absent on Darwin): records its argv, answers `exit`.
      // printf, never echo: dash (Debian's /bin/sh) takes the recorded `-n` as echo's own flag.
      writeFileSync(join(bin, 'flock'), `#!/bin/sh\nprintf '%s\\n' "$*" >"${bin}/argv"\nexit ${exit}\n`);
      chmodSync(join(bin, 'flock'), 0o755);
      const run = spawnSync(
        'sh',
        ['-c', 'script=$0; set -- --lib "$@"; . "$script"; shift; "$@"', INSTALL_SH, 'hold_install_lock', state],
        { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, LC_ALL: 'C' } },
      );
      expect(readFileSync(join(bin, 'argv'), 'utf8').trim()).toBe('-n 9');
      return { code: run.status ?? -1, err: run.stderr };
    };
    expect(withFlock(0).code).toBe(0);
    expect(existsSync(join(state, INSTALL_LOCK_NAME))).toBe(true);
    const held = withFlock(1);
    expect(held.code).toBe(3);
    expect(held.err).toContain('another install.sh (or its init) is running for this instance');
    rmSync(join(state, INSTALL_LOCK_NAME));
    symlinkSync('/etc/passwd', join(state, INSTALL_LOCK_NAME));
    expect(withFlock(0)).toMatchObject({ code: 3 });
  });

  test('family_of refuses another OS and a missing file, and never sources the file', () => {
    expect(lib('family_of', join(OS_RELEASE, 'alpine')).code).toBe(3);
    expect(lib('family_of', join(OS_RELEASE, 'absent')).code).toBe(3);
    rmSync('/tmp/dd_os_release_was_sourced', { force: true });
    expect(lib('family_of', join(OS_RELEASE, 'hostile')).code).toBe(3);
    expect(existsSync('/tmp/dd_os_release_was_sourced')).toBe(false);
  });

  test('refuse_host: non-root and non-Linux each exit 3; root on Linux passes', () => {
    expect(lib('refuse_host', '1000', 'Linux')).toMatchObject({ code: 3 });
    expect(lib('refuse_host', '1000', 'Linux').err).toContain('run as root');
    expect(lib('refuse_host', '0', 'Darwin').err).toContain('runs Linux (this is Darwin)');
    expect(lib('refuse_host', '0', 'Darwin').code).toBe(3);
    expect(lib('refuse_host', '0', 'Linux').code).toBe(0);
  });

  test('pick_asset', () => {
    writeFileSync(join(SCRATCH, 'cpu_avx2'), 'flags\t\t: fpu sse2 avx avx2 bmi2\n');
    writeFileSync(join(SCRATCH, 'cpu_old'), 'flags\t\t: fpu sse2 avx\n');
    expect(lib('pick_asset', 'x86_64', join(SCRATCH, 'cpu_avx2')).out.trim()).toBe('bun-linux-x64');
    expect(lib('pick_asset', 'x86_64', join(SCRATCH, 'cpu_old')).out.trim()).toBe('bun-linux-x64-baseline');
    expect(lib('pick_asset', 'aarch64', '/nonexistent').out.trim()).toBe('bun-linux-aarch64');
    expect(lib('pick_asset', 'riscv64', '/nonexistent').code).toBe(3);
  });
});

describe('install.sh main', () => {
  const root = process.getuid?.() === 0;
  test.skipIf(root)('as a non-root user, main refuses with exit 3 before touching anything', () => {
    const run = spawnSync('sh', [INSTALL_SH, 'test_instance', '--source', '/nonexistent'], { encoding: 'utf8' });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('run as root');
  });
});

/**
 * fapolicyd (measured, RHEL 9.8, fapolicyd 1.4.5 default rules): root may execute the untrusted Bun,
 * but that Bun may not read the TypeScript it runs ("EPERM reading …/cli.ts"). install.sh probes the
 * read before the hand-over and refuses with the line that trusts that Bun — never an EPERM trace.
 */
describe('install.sh fapolicyd_gate', () => {
  const dir = scratchDir('dd_install_sh_fapolicyd', { realpath: true });
  const shims = join(dir, 'bin');
  const bun = join(dir, 'bun');
  const marker = join(dir, 'ran');
  beforeAll(() => {
    mkdirSync(shims, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** fapolicyd active or not (a `systemctl` shim), the Bun's read allowed or denied (a fake Bun). */
  function gate(active: boolean, readable: boolean): { code: number; err: string; ran: boolean } {
    writeFileSync(join(shims, 'systemctl'), `#!/bin/sh\n[ "$*" = 'is-active --quiet fapolicyd' ] && exit ${active ? 0 : 3}\nexit 1\n`);
    chmodSync(join(shims, 'systemctl'), 0o755);
    writeFileSync(bun, `#!/bin/sh\necho "$@" > ${marker}\nexit ${readable ? 0 : 1}\n`);
    chmodSync(bun, 0o755);
    rmSync(marker, { force: true });
    const run = spawnSync('sh', ['-c', 'script=$0; set -- --lib "$@"; . "$script"; shift; fapolicyd_gate "$@"', INSTALL_SH, bun, '/opt/x/src/provision/cli.ts', '/opt/x/empty.bunfig.toml', 'museum_org'], {
      encoding: 'utf8',
      env: { PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, LC_ALL: 'C' },
    });
    return { code: run.status ?? -1, err: run.stderr, ran: existsSync(marker) };
  }

  test('fapolicyd inactive: nothing is probed', () => {
    expect(gate(false, false)).toEqual({ code: 0, err: '', ran: false });
  });

  test('active and the read allowed: through, the probe ran with the hand-over flags and the empty bunfig', () => {
    const got = gate(true, true);
    expect(got.code).toBe(0);
    expect(readFileSync(marker, 'utf8')).toContain(`${BUN_HANDOVER_FLAGS.join(' ')} --config=/opt/x/empty.bunfig.toml -e require('node:fs').readFileSync('/opt/x/src/provision/cli.ts')`);
  });

  test('active and the read denied: exit 3 with the line that trusts that Bun', () => {
    const got = gate(true, false);
    expect(got.code).toBe(3);
    expect(got.err).toContain(`fapolicyd denies ${bun} the code it runs`);
    // the instance's own init trust file (never a shared `dedalo` one), and when to remove it
    expect(got.err).toContain(`fapolicyd-cli --file add ${bun} --trust-file dedalo_init_museum_org || fapolicyd-cli --file update ${bun} --trust-file dedalo_init_museum_org`);
    expect(got.err).toContain('fapolicyd-cli --update');
    expect(got.err).toContain('rm /etc/fapolicyd/trust.d/dedalo_init_museum_org && fapolicyd-cli --update');
  });

  test('main calls it right before the hand-over', () => {
    expect(TEXT).toMatch(/cd "\$STAGE" \|\| die "cannot enter \$STAGE"\n {2}fapolicyd_gate "\$BUNX" "\$ENTRY" "\$STAGE\/\$EMPTY_BUNFIG_NAME" "\$INSTANCE"\n/);
  });
});
