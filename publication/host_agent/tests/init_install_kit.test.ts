/**
 * THE KIT'S VERIFICATION in deploy/install.sh (`--kit`, step 2): the library functions that stand
 * between a kit file and anything root runs from it, driven for real in library mode
 * (`set -- --lib; . install.sh`, POSIX/BSD tools only), plus the sh twins of the KIT_* constants
 * (init/constants.ts).
 *
 *   - kit_names_ok: a `tar -tzf` listing with an absolute name, a '..' or '.' segment, a name
 *     outside the grammar, or too many entries is refused BEFORE tar extracts anything;
 *   - kit_types_ok: a `tar -tvzf` listing naming a link, a device or a FIFO is refused;
 *   - verify_kit: the extracted tree must be EXACTLY its MANIFEST — a tampered byte, an extra
 *     file, a missing file, a repeated line, a symlink (to a file, a dir, or out of the tree), a
 *     FIFO, a path with a '..' segment, a bad first line, a missing draft/install.sh/source are
 *     each exit 3 naming the offender; a well-formed kit passes.
 *
 * The other half — the work host's `bun run hostagent:pack` producing a kit this function accepts
 * — is test/unit/publication_host_kit_pack.test.ts (the ROOT suite: the packer is a root script).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  KIT_DOT_SEGMENT_PATTERN,
  KIT_DRAFT_NAME,
  KIT_FORMAT_LINE,
  KIT_INSTALL_NAME,
  KIT_MANIFEST_NAME,
  KIT_MAX_ENTRIES,
  KIT_PATH_PATTERN,
  KIT_SOURCE_DIR,
  SOURCE_MANIFEST,
} from '../src/provision/init/constants';
import { scratchDir } from '../../../test/helpers/scratch_dir.ts';

const INSTALL_SH = join(import.meta.dir, '..', 'deploy', 'install.sh');
const TEXT = readFileSync(INSTALL_SH, 'utf8');
/** Outside the checkout: this gate plants FIFOs and escaping links (see init_install_sh.test.ts). */
const SCRATCH = scratchDir('dd_kit_sh', { realpath: true });
const KIT = join(SCRATCH, 'kit');

function lib(fn: string, ...args: string[]): { code: number; out: string; err: string } {
  const run = spawnSync('sh', ['-c', 'script=$0; set -- --lib "$@"; . "$script"; shift; "$@"', INSTALL_SH, fn, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
  });
  return { code: run.status ?? -1, out: run.stdout, err: run.stderr };
}

function shConst(name: string): string {
  const match = new RegExp(`^${name}=(?:'([^']*)'|(\\S+))$`, 'm').exec(TEXT);
  if (match === null) throw new Error(`install.sh has no ${name}=`);
  return match[1] ?? match[2] ?? '';
}

const sha = (body: string): string => createHash('sha256').update(body).digest('hex');

/** The kit's files (relative → body); the MANIFEST is written from them by `writeManifest`. */
const FILES: Record<string, string> = {
  [KIT_DRAFT_NAME]: '{"instance":"museum"}\n',
  [KIT_INSTALL_NAME]: '#!/bin/sh\n',
  [`${KIT_SOURCE_DIR}/.bun-version`]: '1.4.3\n',
  [`${KIT_SOURCE_DIR}/publication/host_agent/package.json`]: '{}\n',
  [`${KIT_SOURCE_DIR}/publication/host_agent/node_modules/zod/index.js`]: 'export {};\n',
};

function put(rel: string, body: string): void {
  mkdirSync(dirname(join(KIT, rel)), { recursive: true });
  writeFileSync(join(KIT, rel), body);
}

function manifestOf(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(path => `${sha(files[path] as string)}  ${path}`);
  return `${KIT_FORMAT_LINE}\n${lines.join('\n')}\n`;
}

beforeEach(() => {
  // EMPTY the mkdtemp dir, never remove it: re-creating it would trade the atomic,
  // 0700, unguessable directory for a mkdir at the umask in a race window.
  for (const entry of readdirSync(SCRATCH)) rmSync(join(SCRATCH, entry), { recursive: true, force: true });
  mkdirSync(KIT);
  for (const [rel, body] of Object.entries(FILES)) put(rel, body);
  put(KIT_MANIFEST_NAME, manifestOf(FILES));
});
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

describe('the kit constants: sh twins equal the TS ones', () => {
  test('names, format line, grammars, cap', () => {
    expect(shConst('KIT_FORMAT_LINE')).toBe(KIT_FORMAT_LINE);
    expect(shConst('KIT_MANIFEST_NAME')).toBe(KIT_MANIFEST_NAME);
    expect(shConst('KIT_DRAFT_NAME')).toBe(KIT_DRAFT_NAME);
    expect(shConst('KIT_INSTALL_NAME')).toBe(KIT_INSTALL_NAME);
    expect(shConst('KIT_SOURCE_DIR')).toBe(KIT_SOURCE_DIR);
    expect(shConst('KIT_PATH_RE')).toBe(KIT_PATH_PATTERN.source.replace(/\\\//g, '/'));
    expect(shConst('KIT_DOT_SEGMENT_RE')).toBe(KIT_DOT_SEGMENT_PATTERN.source.replace(/\\\//g, '/'));
    expect(Number(shConst('KIT_MAX_ENTRIES'))).toBe(KIT_MAX_ENTRIES);
  });

  test("SOURCE_OPTIONAL is exactly the manifest's optional entries", () => {
    expect(shConst('SOURCE_OPTIONAL').split(' ')).toEqual(SOURCE_MANIFEST.filter(e => e.optional).map(e => e.path));
    expect(SOURCE_MANIFEST.filter(e => e.optional).map(e => e.path)).toEqual(['publication/server_api/v1/config_api/sample.server_config_api.php']);
  });

  test('main: the kit is hashed BEFORE tar reads it, listed before it is extracted, verified before it is used', () => {
    const at = (needle: string): number => {
      const index = TEXT.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const hashed = at('KIT_SHA=$(sha_of "$_kitcopy")');
    const listed = at('tar -tzf "$_kitcopy"');
    const extracted = at('tar -xzf "$_kitcopy"');
    expect(hashed).toBeLessThan(listed);
    expect(at('kit_names_ok "$STAGE/kit.list"')).toBeLessThan(extracted);
    expect(at('kit_types_ok "$STAGE/kit.vlist"')).toBeLessThan(extracted);
    expect(at('[ "$KIT_SHA_GIVEN" = "$KIT_SHA" ]')).toBeLessThan(listed);
    expect(extracted).toBeLessThan(at('verify_kit "$STAGE/kit"'));
    expect(at('verify_kit "$STAGE/kit"')).toBeLessThan(at('mv "$STAGE/kit/$KIT_SOURCE_DIR" "$STAGE/source"'));
    // extraction never keeps the archive's owners or modes
    expect(TEXT).toContain('tar -xzf "$_kitcopy" -C "$STAGE/kit" --no-same-owner --no-same-permissions');
  });
});

describe('kit_names_ok (before extraction)', () => {
  const listing = (lines: string[]): string => {
    const path = join(SCRATCH, 'list');
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  };

  test('a clean listing passes (directories with their trailing /)', () => {
    const run = lib('kit_names_ok', listing(['MANIFEST', 'draft.json', 'source/', 'source/.bun-version', 'source/publication/host_agent/node_modules/@scope/pkg+x/a.js']));
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
  });

  for (const [what, name, message] of [
    ['an absolute name', '/etc/passwd', /outside the kit path grammar/],
    ['a .. segment', 'source/../../etc/cron.d/x', /'\.' or '\.\.' segment/],
    ['a leading ..', '../x', /'\.' or '\.\.' segment/],
    ['a . segment', 'source/./x', /'\.' or '\.\.' segment/],
    ['a space', 'source/a b', /outside the kit path grammar/],
    ['a backslash', 'source\\x', /outside the kit path grammar/],
  ] as const) {
    test(`refuses ${what} (exit 3, named)`, () => {
      const run = lib('kit_names_ok', listing(['MANIFEST', name]));
      expect(run.code).toBe(3);
      expect(run.err).toMatch(message);
    });
  }

  test('refuses more than KIT_MAX_ENTRIES members', () => {
    const run = lib('kit_names_ok', listing(Array.from({ length: KIT_MAX_ENTRIES + 1 }, (_, i) => `f${i}`)));
    expect(run.code).toBe(3);
    expect(run.err).toContain('entries (at most');
  });
});

describe('kit_types_ok (before extraction)', () => {
  test('regular files and directories pass; a symlink, a hard link, a device, a FIFO member is refused', () => {
    const path = join(SCRATCH, 'vlist');
    const ok = ['-rw-r--r--  0 root   root      12 Jan  1  1970 MANIFEST', 'drwxr-xr-x  0 root   root       0 Jan  1  1970 source/'];
    writeFileSync(path, `${ok.join('\n')}\n`);
    expect(lib('kit_types_ok', path).code).toBe(0);
    for (const bad of ['lrwxrwxrwx  0 root root 0 Jan  1  1970 source/x -> /etc', 'hrw-r--r--  0 root root 0 Jan  1  1970 a link to b', 'crw-r--r--  0 root root 0 Jan  1  1970 dev', 'prw-r--r--  0 root root 0 Jan  1  1970 fifo']) {
      writeFileSync(path, `${[...ok, bad].join('\n')}\n`);
      const run = lib('kit_types_ok', path);
      expect(run.code, bad).toBe(3);
      expect(run.err).toContain('not a regular file or directory');
    }
  });
});

describe('verify_kit (after extraction, before use)', () => {
  const verify = () => lib('verify_kit', KIT);

  test('a kit equal to its MANIFEST passes', () => {
    const run = verify();
    expect(run.err).toBe('');
    expect(run.code).toBe(0);
  });

  test('a tampered file is refused, naming it', () => {
    put(`${KIT_SOURCE_DIR}/.bun-version`, '1.4.4\n');
    const run = verify();
    expect(run.code).toBe(3);
    expect(run.err).toContain("the kit's 'source/.bun-version' has sha256");
    expect(run.err).toContain('the kit was altered');
  });

  test('an extra file is refused, naming it', () => {
    put(`${KIT_SOURCE_DIR}/publication/host_agent/src/evil.ts`, 'process.exit(0)\n');
    const run = verify();
    expect(run.code).toBe(3);
    expect(run.err).toContain("the kit holds 'source/publication/host_agent/src/evil.ts', which its MANIFEST does not list");
  });

  test('a missing file is refused', () => {
    rmSync(join(KIT, `${KIT_SOURCE_DIR}/publication/host_agent/package.json`));
    const run = verify();
    expect(run.code).toBe(3);
    expect(run.err).toContain('a listed file is missing, or a line is repeated');
  });

  test('a repeated MANIFEST line is refused', () => {
    const text = readFileSync(join(KIT, KIT_MANIFEST_NAME), 'utf8');
    const line = text.split('\n')[1] as string;
    writeFileSync(join(KIT, KIT_MANIFEST_NAME), `${text}${line}\n`);
    const run = verify();
    expect(run.code).toBe(3);
    expect(run.err).toContain('a line is repeated');
  });

  test('a symlink (to a listed file, out of the tree, to a dir) is refused — never followed', () => {
    for (const target of ['../draft.json', '/etc/passwd', '/etc']) {
      rmSync(join(KIT, `${KIT_SOURCE_DIR}/.bun-version`), { force: true, recursive: true });
      symlinkSync(target, join(KIT, `${KIT_SOURCE_DIR}/.bun-version`));
      const run = verify();
      expect(run.code, target).toBe(3);
      expect(run.err).toContain('not a regular file or directory: source/.bun-version');
    }
  });

  test('a FIFO is refused', () => {
    spawnSync('mkfifo', [join(KIT, `${KIT_SOURCE_DIR}/fifo`)]);
    const run = verify();
    expect(run.code).toBe(3);
    expect(run.err).toContain('not a regular file or directory: source/fifo');
  });

  test('a MANIFEST path with a .. segment (path traversal) is refused before any file is hashed', () => {
    const files = { ...FILES, '../outside': 'x' };
    writeFileSync(join(KIT, KIT_MANIFEST_NAME), manifestOf(files));
    const run = verify();
    expect(run.code).toBe(3);
    expect(run.err).toContain("a MANIFEST path has a '.' or '..' segment: '../outside'");
    const absolute = manifestOf(FILES).replace(`  ${KIT_DRAFT_NAME}`, '  /etc/shadow');
    writeFileSync(join(KIT, KIT_MANIFEST_NAME), absolute);
    expect(verify().err).toContain("outside the kit path grammar: '/etc/shadow'");
  });

  test('a MANIFEST that is not one (first line, line shape, absent) is refused', () => {
    writeFileSync(join(KIT, KIT_MANIFEST_NAME), manifestOf(FILES).replace(KIT_FORMAT_LINE, '# something else'));
    expect(verify().err).toContain(`does not start with '${KIT_FORMAT_LINE}'`);
    writeFileSync(join(KIT, KIT_MANIFEST_NAME), `${manifestOf(FILES)}deadbeef  draft.json\n`);
    expect(verify().err).toContain("is not '<sha256>  <path>'");
    rmSync(join(KIT, KIT_MANIFEST_NAME));
    const run = verify();
    expect(run.code).toBe(3);
    expect(run.err).toContain('the kit has no MANIFEST');
  });

  test('a kit without its draft, install.sh or source/ is refused even when its MANIFEST agrees', () => {
    for (const missing of [KIT_DRAFT_NAME, KIT_INSTALL_NAME]) {
      const files = { ...FILES };
      delete files[missing];
      rmSync(KIT, { recursive: true, force: true });
      mkdirSync(KIT, { recursive: true });
      for (const [rel, body] of Object.entries(files)) put(rel, body);
      put(KIT_MANIFEST_NAME, manifestOf(files));
      const run = verify();
      expect(run.code, missing).toBe(3);
      expect(run.err).toContain(`the kit has no ${missing}`);
    }
    const files = { [KIT_DRAFT_NAME]: 'x', [KIT_INSTALL_NAME]: 'y' };
    rmSync(KIT, { recursive: true, force: true });
    mkdirSync(KIT, { recursive: true });
    for (const [rel, body] of Object.entries(files)) put(rel, body);
    put(KIT_MANIFEST_NAME, manifestOf(files));
    expect(verify().err).toContain('the kit has no source/ directory');
  });
});
