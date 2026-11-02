/**
 * THE REAL HOST I/O — the seam `tests/provision_apply.test.ts` deliberately replaces.
 *
 * That gate drives every apply through a FAKE `ProvisionIo`, which is right: it is about
 * the PLAN, and a plan gate that touched a real machine could not run in a suite. But it
 * means `hostIo()` itself — the only code in the subsystem that writes to a host — was
 * never executed by anything. Coverage said so: the whole function was unrun, and the
 * chown-failure throw survived a mutation sweep. It is the same shape as the earlier
 * parseManifest-vs-derive defect, one altitude up: a gate that routes around the thing it
 * is named for.
 *
 * The `$2y$` prefix was the sharpest case. `tests/provision_apply.test.ts` asserts it
 * against `const HASH_PREFIX = '$2y$fake$'` — a value the test itself computes and its own
 * fake returns — so an htpasswd full of `$2b$` hashes, which not every crypt(3) a museum's
 * distro ships will accept, would have shipped green.
 *
 * WHAT THIS FILE CAN AND CANNOT DO. It writes into its own scratch corner as the user
 * running the suite: modes, atomicity, the hash and the exec wrapper are all real here.
 * `chown` to another owner is not — that needs root — so the chown assertion is the one
 * that matters without it: a chown that FAILS must throw rather than be quietly skipped,
 * which is provable by naming an owner that does not exist.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRATCH_ROOT } from './fixtures/instance';
import { hostIo } from '../src/provision/apply';

/** This gate's own corner, outside every root, so no reset walks over it. */
const GATE_DIR = join(SCRATCH_ROOT, 'host_io_gate');

afterEach(() => rmSync(GATE_DIR, { recursive: true, force: true }));

function dir(): string {
  mkdirSync(GATE_DIR, { recursive: true });
  return GATE_DIR;
}

describe('the file writer', () => {
  test('creates the file with the FINAL mode — never briefly wider', () => {
    // A minted token is written this way. "Briefly world-readable" is not a smaller version
    // of the problem: on a shared host it is the whole of it.
    const path = join(dir(), 'secret');
    hostIo().writeFile(path, 'a-minted-token\n', 0o600);
    expect(statSync(path).mode & 0o7777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('a-minted-token\n');
  });

  test('the requested mode survives the process umask, because it is asserted after the write', () => {
    // `writeFileSync` honours the umask on CREATION, so a mode carrying a bit the umask
    // strips — 0660, which is the daemon SOCKET's mode in §3's matrix — comes out 0640 on
    // an ordinary umask 022 host unless the explicit chmod puts it back. The group bit is
    // the whole access decision for that socket: the engine reaches the daemon because it
    // group-owns it.
    const previous = process.umask(0o022);
    try {
      const path = join(dir(), 'group-readable-and-writable');
      hostIo().writeFile(path, 'x', 0o660);
      expect((statSync(path).mode & 0o7777).toString(8)).toBe('660');
    } finally {
      process.umask(previous);
    }
  });

  test('a rewrite is atomic — the reader sees the old bytes or the new ones', () => {
    const path = join(dir(), 'vhost.conf');
    hostIo().writeFile(path, 'server { listen 80; }\n', 0o644);
    hostIo().writeFile(path, 'server { listen 443; }\n', 0o644);
    expect(readFileSync(path, 'utf8')).toBe('server { listen 443; }\n');
    // And no temporary is left behind — a `.tmp` beside a vhost is a file the web server
    // may or may not read depending on its include glob.
    expect(readdirSync(GATE_DIR)).toEqual(['vhost.conf']);
  });

  test('a write whose RENAME fails leaves no temporary behind', () => {
    // The temporary really is created here and the rename really does fail — a directory
    // standing where the file should be. A `.dedalo-provision.tmp` left beside a vhost is a
    // file the web server may or may not read depending on its include glob, and it would
    // carry the bytes of whatever was being written, secrets included.
    const path = join(dir(), 'occupied');
    mkdirSync(path, { recursive: true });
    expect(() => hostIo().writeFile(path, 'a-minted-token', 0o600)).toThrow();
    expect(readdirSync(GATE_DIR).sort()).toEqual(['occupied']);
  });

  test('a write into a directory that does not exist fails and creates nothing', () => {
    const path = join(GATE_DIR, 'no-such-directory', 'file');
    mkdirSync(GATE_DIR, { recursive: true });
    expect(() => hostIo().writeFile(path, 'x', 0o644)).toThrow();
    expect(existsSync(join(GATE_DIR, 'no-such-directory'))).toBe(false);
    expect(readdirSync(GATE_DIR)).toEqual([]);
  });
});

describe('the password hash is the one a museum web server will actually read', () => {
  test("it is bcrypt, and it is spelled $2y$ — not the $2b$ most libraries emit", () => {
    // Apache's htpasswd and nginx's auth_basic both read `$2y$`; `$2b$` is not recognised
    // by every crypt(3) a museum's distro might ship. The hashes are identical otherwise,
    // which is exactly why this can only be caught by looking at the real one.
    const hash = hostIo().hashPassword('a-preview-password');
    expect(hash.startsWith('$2y$')).toBe(true);
    expect(hash).not.toContain('$2b$');
    // A REAL bcrypt hash, not a prefix on something else: it verifies.
    expect(Bun.password.verifySync('a-preview-password', hash)).toBe(true);
    expect(Bun.password.verifySync('the-wrong-password', hash)).toBe(false);
    // Three bcrypt operations at the production cost (12) ON PURPOSE — the real hash is
    // the point. ~1 s on a desk; GitHub ci 41327866839 measured 5237 ms against Bun's
    // 5000 ms default on a contended runner. The cap is sized to the work, not widened.
  }, 30000);

  test('two hashes of one password differ — the salt is real', () => {
    const io = hostIo();
    expect(io.hashPassword('same')).not.toBe(io.hashPassword('same'));
    // two cost-12 hashes: same reasoning as above
  }, 30000);
});

describe('the rest of the seam', () => {
  test('a chown that FAILS throws — a half-owned tree is not a converged host', () => {
    // Without the status check the provisioner reports success over a webspace still owned
    // by root, which the daemon then refuses to boot against (assertRunningAs) — a failure
    // one layer away from its cause. Root is not needed to prove it: an owner that cannot
    // exist fails for everyone.
    const path = join(dir(), 'owned');
    writeFileSync(path, 'x', 'utf8');
    expect(() =>
      hostIo().chown(path, 'no-such-user-ffffffff', 'no-such-group-ffffffff'),
    ).toThrow(/chown -h/);
  });

  test('a minted token is base64url and long enough to be one', () => {
    const token = hostIo().mintToken(32, 'base64url');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hostIo().mintToken(32, 'base64url')).not.toBe(token);
  });

  test('exec reports a command that could not be run at all as 127, not as success', () => {
    const result = hostIo().exec(['/no/such/binary/anywhere', '--version']);
    expect(result.code).toBe(127);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test('exec reports a real command faithfully', () => {
    const ok = hostIo().exec(['/usr/bin/true']);
    expect(ok.code).toBe(0);
    const bad = hostIo().exec(['/usr/bin/false']);
    expect(bad.code).toBe(1);
  });

  test('stat reports the type, mode, owner and group of what is really there', () => {
    const path = join(dir(), 'a-directory');
    mkdirSync(path, { recursive: true });
    const facts = hostIo().stat(path);
    expect(facts?.type).toBe('dir');
    expect(facts?.mode).toBe(statSync(path).mode & 0o7777);
    expect(hostIo().stat(join(GATE_DIR, 'nothing-here'))).toBeNull();
  });

  test('a symlink is reported as a symlink, not as what it points at', () => {
    // `chown -h` and the mode matrix both depend on this: a link reported as its target
    // would be a served link whose ownership was checked against the release behind it.
    const target = join(dir(), 'target');
    mkdirSync(target, { recursive: true });
    const link = join(GATE_DIR, 'link');
    hostIo().symlink(link, target);
    expect(hostIo().stat(link)?.type).toBe('symlink');
  });
});
