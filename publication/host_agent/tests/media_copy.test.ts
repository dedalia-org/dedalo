/**
 * Copy-mode media commands (src/media/copy.ts) over the suite's scratch media root, driven
 * as a COPY target. The suite's .env.test is MEDIA_MODE=shared, and routes_media.test.ts
 * pins that as refused through the router. Review focus 2 (an unpublish while a put
 * streams) is "an unpublish that lands while a put streams wins". Verified deletion has no
 * blind spot: a symlink, a dotfile, a hidden directory or a fifo under the copy root is
 * REPORTED (irregular) and deletable. Generic `test` TLD names only; out-of-root trees are
 * gate-owned scratch corners (scratchPath), created and removed here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { readAudit } from '../src/audit';
import { ApiError } from '../src/errors';
import {
  type CopyTarget,
  INCOMING_DIR,
  MANIFEST_MAX_LIMIT,
  MAX_DELETE_PATHS,
  decodeCursor,
  deleteMediaFiles,
  encodeCursor,
  markKey,
  mediaManifest,
  putMediaFile,
  requireCopyRoot,
  withKeyLock,
} from '../src/media/copy';
import { setOwnershipForTests } from '../src/media/fs_modes';
import { PUB_DIR } from '../src/media/probe';
import {
  COPY_STATE_DIR,
  SHA_INDEX_FILE,
  lookupSha,
  resetShaIndexForTests,
  shaIndexEntries,
} from '../src/media/sha_index';
import { resetInstance, roots, scratchPath } from './fixtures/instance';

const ROOT = roots.mediaRoot as string;
const COPY: CopyTarget = { mode: 'copy', root: ROOT };
const ACTOR = 'tester';
const P1 = 'image/1.5MB/0/test99_test3_1.jpg';
const P1_THUMB = 'image/thumb/0/test99_test3_1.jpg';
const K1 = 'test3_1';
const AV2 = 'av/404/test95_test3_2.mp4';
const K2 = 'test3_2';

/** The scratch corners this file owns (outside the media root, inside .test-tmp/). */
const CORNERS = ['outside_put', 'outside_delete', 'outside_master'] as const;

/** The permission bits of a path under the media root. */
function modeOf(rel: string): number {
  return statSync(join(ROOT, rel)).mode & 0o777;
}

/** A fresh, empty corner: scratchPath only names the path, so it is (re)created here. */
function corner(name: (typeof CORNERS)[number]): string {
  const dir = scratchPath(name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sha(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}
function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>;
}
async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal, got a result');
}
function reasonOf(error: ApiError): unknown {
  return error.extensions?.reason;
}
function put(
  path: string,
  bytes: Uint8Array,
  over: { sha256?: string; size?: number; body?: ReadableStream<Uint8Array> | null } = {},
) {
  return putMediaFile(COPY, {
    path,
    sha256: over.sha256 ?? sha(bytes),
    size: over.size ?? bytes.byteLength,
    actor: ACTOR,
    body: over.body === undefined ? streamOf(bytes) : over.body,
  });
}
function incomingEntries(): string[] {
  const dir = join(ROOT, INCOMING_DIR);
  return existsSync(dir) ? readdirSync(dir) : [];
}
function plant(path: string, text: string): void {
  mkdirSync(dirname(join(ROOT, path)), { recursive: true });
  writeFileSync(join(ROOT, path), text);
}
/** A body the test feeds by hand, to hold a put mid-stream. */
function heldStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (bytes: Uint8Array) => controller?.enqueue(bytes),
    end: () => controller?.close(),
  };
}

beforeEach(async () => {
  await resetInstance();
  resetShaIndexForTests();
});
afterEach(() => {
  resetShaIndexForTests();
  for (const name of CORNERS) rmSync(scratchPath(name), { recursive: true, force: true });
});

describe('the copy-mode gate', () => {
  test('shared and none hosts refuse every media command with 409 media_mode', async () => {
    const targets: CopyTarget[] = [
      { mode: 'shared', root: ROOT },
      { mode: 'none', root: null },
    ];
    for (const target of targets) {
      const refusals = await Promise.all([
        caught(putMediaFile(target, { path: P1, sha256: 'a'.repeat(64), size: 0, actor: ACTOR, body: null })),
        caught(deleteMediaFiles(target, [P1], ACTOR)),
        caught(markKey(target, K1, true, ACTOR)),
        caught(mediaManifest(target, null, 10)),
      ]);
      expect(refusals.map(e => [e.status, reasonOf(e)])).toEqual(Array(4).fill([409, 'media_mode']));
    }
    expect(existsSync(join(ROOT, '.publication'))).toBe(false);
  });

  test('a copy root that is not a directory is refused the same way', async () => {
    const error = await caught(mediaManifest({ mode: 'copy', root: join(ROOT, 'missing') }, null, 10));
    expect([error.status, reasonOf(error)]).toEqual([409, 'media_mode']);
    expect(requireCopyRoot(COPY)).toBe(ROOT);
  });
});

describe('media.put', () => {
  test('a put for an unmarked record is refused and writes nothing', async () => {
    const error = await caught(put(P1, bytesOf('jpeg')));
    expect([error.status, reasonOf(error)]).toEqual([409, 'key_unpublished']);
    expect(existsSync(join(ROOT, P1))).toBe(false);
    expect(incomingEntries()).toEqual([]);
  });

  test('mark → put lands the verified bytes, world-readable, recorded in the sha index', async () => {
    await markKey(COPY, K1, true, ACTOR);
    const bytes = bytesOf('jpeg-bytes');
    expect(await put(P1, bytes)).toEqual({
      path: P1,
      key: K1,
      size: bytes.byteLength,
      sha256: sha(bytes),
      replaced: false,
      unchanged: false,
    });
    const file = join(ROOT, P1);
    expect(readFileSync(file, 'utf8')).toBe('jpeg-bytes');
    const st = statSync(file);
    expect(st.mode & 0o777).toBe(0o644);
    expect(lookupSha(ROOT, P1, st.size, st.mtimeMs)).toBe(sha(bytes));
    expect(incomingEntries()).toEqual([]);
    expect(statSync(join(ROOT, COPY_STATE_DIR)).mode & 0o077).toBe(0);
    expect((await readAudit())[0]).toMatchObject({ actor: ACTOR, action: 'media.put', outcome: 'ok' });
  });

  test('a body that does not hash to X-Sha256 is refused; nothing lands', async () => {
    await markKey(COPY, K1, true, ACTOR);
    const error = await caught(put(P1, bytesOf('jpeg'), { sha256: 'f'.repeat(64) }));
    expect([error.status, reasonOf(error)]).toEqual([422, 'hash_mismatch']);
    expect(existsSync(join(ROOT, P1))).toBe(false);
    expect(incomingEntries()).toEqual([]);
  });

  test('a body longer or shorter than X-Size is refused; nothing lands', async () => {
    await markKey(COPY, K1, true, ACTOR);
    const bytes = bytesOf('12345');
    for (const size of [6, 4]) {
      const error = await caught(put(P1, bytes, { size }));
      expect([error.status, reasonOf(error)]).toEqual([422, 'size_mismatch']);
    }
    expect(existsSync(join(ROOT, P1))).toBe(false);
    expect(incomingEntries()).toEqual([]);
  });

  test('a malformed X-Sha256 or X-Size is a 400 before any work, not audited', async () => {
    await markKey(COPY, K1, true, ACTOR);
    const before = (await readAudit()).length;
    for (const over of [{ sha256: 'ABC' }, { size: -1 }, { size: Number.NaN }]) {
      const error = await caught(put(P1, bytesOf('jpeg'), over));
      expect([error.status, reasonOf(error)]).toEqual([400, 'body_invalid']);
    }
    expect((await readAudit()).length).toBe(before);
  });

  test('a master tier is refused (422 media_path_refused) and the refusal is audited', async () => {
    const error = await caught(put('image/original/0/test99_test3_1.tif', bytesOf('master')));
    expect([error.status, reasonOf(error), error.extensions?.path_reason]).toEqual([
      422,
      'media_path_refused',
      'master_tier',
    ]);
    expect((await readAudit())[0]).toMatchObject({
      action: 'media.put',
      outcome: 'refused',
      detail: { path: 'image/original/0/test99_test3_1.tif', reason: 'media_path_refused' },
    });
  });

  test('the same bytes again answer unchanged without reading the body', async () => {
    await markKey(COPY, K1, true, ACTOR);
    const bytes = bytesOf('same');
    await put(P1, bytes);
    const body = streamOf(bytes);
    expect(await put(P1, bytes, { body })).toEqual({
      path: P1,
      key: K1,
      size: 4,
      sha256: sha(bytes),
      replaced: true,
      unchanged: true,
    });
    expect(body.locked).toBe(false);
  });

  test('new bytes replace the file', async () => {
    await markKey(COPY, K1, true, ACTOR);
    await put(P1, bytesOf('old!'));
    expect(await put(P1, bytesOf('new bytes'))).toMatchObject({ replaced: true, unchanged: false });
    expect(readFileSync(join(ROOT, P1), 'utf8')).toBe('new bytes');
  });

  test('REVIEW FOCUS 2: an unpublish that lands while a put streams wins — the put never lands', async () => {
    await markKey(COPY, K1, true, ACTOR);
    const bytes = bytesOf('abcdef');
    const held = heldStream();
    held.push(bytes.slice(0, 3));
    const inflight = putMediaFile(COPY, { path: P1, sha256: sha(bytes), size: 6, actor: ACTOR, body: held.stream });
    await Bun.sleep(20);
    expect(await markKey(COPY, K1, false, ACTOR)).toEqual({ key: K1, published: false, changed: true });
    held.push(bytes.slice(3));
    held.end();
    const error = await caught(inflight);
    expect([error.status, reasonOf(error)]).toEqual([409, 'key_unpublished']);
    expect(existsSync(join(ROOT, P1))).toBe(false);
    expect(existsSync(join(ROOT, PUB_DIR, K1))).toBe(false);
    expect(incomingEntries()).toEqual([]);
  });

  test('a second put of the same path while one streams is 409 busy', async () => {
    await markKey(COPY, K1, true, ACTOR);
    const bytes = bytesOf('slow');
    const held = heldStream();
    const first = putMediaFile(COPY, { path: P1, sha256: sha(bytes), size: 4, actor: ACTOR, body: held.stream });
    await Bun.sleep(20);
    const second = await caught(put(P1, bytes));
    expect([second.status, reasonOf(second)]).toEqual([409, 'busy']);
    held.push(bytes);
    held.end();
    expect((await first).unchanged).toBe(false);
  });

  test('a symlinked directory cannot carry a put outside the root', async () => {
    const outside = corner('outside_put');
    symlinkSync(outside, join(ROOT, 'image'));
    await markKey(COPY, K1, true, ACTOR);
    const error = await caught(put(P1, bytesOf('jpeg')));
    expect([error.status, error.extensions?.path_reason]).toEqual([422, 'escapes_root']);
    expect(readdirSync(outside)).toEqual([]);
  });
});

/**
 * THE 404 BUG (T0-6): the unit runs the agent under UMask=0027, so a REQUESTED mode lands
 * `mode & ~0027` — dirs 0750, the web user (not in the agent's group) cannot stat
 * `.publication/pub/<key>` nor traverse a media dir, and every published file 404s. Modes
 * are APPLIED (fchmod), so they are exact under any umask. The umask is process-wide:
 * restored after every test, whatever the outcome.
 */
describe('modes under UMask=0027', () => {
  let saved = 0o022;
  beforeEach(() => {
    saved = process.umask(0o027);
  });
  // afterEach runs whatever the test did: neither the umask nor an injected ownership leaks.
  afterEach(() => {
    process.umask(saved);
    setOwnershipForTests(null);
  });

  test('mark → put: every level the agent mints is 0755, marker and files 0644, the private state 0700/0600', async () => {
    await markKey(COPY, K1, true, ACTOR);
    await markKey(COPY, K2, true, ACTOR);
    await put(P1, bytesOf('jpeg'));
    await put(AV2, bytesOf('mp4'));
    const publicDirs = ['.publication', PUB_DIR, 'image', 'image/1.5MB', 'image/1.5MB/0', 'av', 'av/404'];
    const publicFiles = [join(PUB_DIR, K1), join(PUB_DIR, K2), P1, AV2];
    const modes = (paths: string[]) => Object.fromEntries(paths.map(path => [path, modeOf(path)]));
    const all = (paths: string[], mode: number) => Object.fromEntries(paths.map(path => [path, mode]));
    expect(modes(publicDirs)).toEqual(all(publicDirs, 0o755));
    expect(modes(publicFiles)).toEqual(all(publicFiles, 0o644));
    expect(modes([COPY_STATE_DIR, INCOMING_DIR])).toEqual(all([COPY_STATE_DIR, INCOMING_DIR], 0o700));
    expect(modeOf(SHA_INDEX_FILE)).toBe(0o600);
  });

  test('the sha index reached before any mark (a manifest): .publication is 0755, copy/ 0700', async () => {
    plant(P1_THUMB, 'planted');
    await mediaManifest(COPY, null, 10);
    expect([modeOf('.publication'), modeOf(COPY_STATE_DIR), modeOf(SHA_INDEX_FILE)]).toEqual([0o755, 0o700, 0o600]);
  });

  test('an operator-widened copy/ is pulled back to 0700, a dark .publication opened to 0755', async () => {
    mkdirSync(join(ROOT, COPY_STATE_DIR), { recursive: true });
    chmodSync(join(ROOT, '.publication'), 0o750);
    chmodSync(join(ROOT, COPY_STATE_DIR), 0o755);
    await markKey(COPY, K1, true, ACTOR);
    await put(P1, bytesOf('jpeg'));
    expect([modeOf('.publication'), modeOf(COPY_STATE_DIR)]).toEqual([0o755, 0o700]);
  });

  test('an existing dark media level on the put path is opened to 0755 (the lazy repair)', async () => {
    mkdirSync(join(ROOT, 'image', '1.5MB', '0'), { recursive: true });
    chmodSync(join(ROOT, 'image', '1.5MB'), 0o750);
    await markKey(COPY, K1, true, ACTOR);
    await put(P1, bytesOf('jpeg'));
    expect(modeOf('image/1.5MB')).toBe(0o755);
  });

  test('a level the agent does NOT own that meets the need (0775: o+x) is left alone and the put lands', async () => {
    mkdirSync(join(ROOT, 'image'), { recursive: true });
    chmodSync(join(ROOT, 'image'), 0o775);
    const foreign = join(ROOT, 'image');
    setOwnershipForTests((_st, path) => path !== foreign);
    await markKey(COPY, K1, true, ACTOR);
    await put(P1, bytesOf('jpeg'));
    expect([modeOf('image'), modeOf('image/1.5MB'), readFileSync(join(ROOT, P1), 'utf8')]).toEqual([0o775, 0o755, 'jpeg']);
  });

  test('a DARK level the agent does not own refuses the put (409 media_level_foreign), audited, never chmodded', async () => {
    mkdirSync(join(ROOT, 'image'), { recursive: true });
    chmodSync(join(ROOT, 'image'), 0o750);
    const foreign = join(ROOT, 'image');
    setOwnershipForTests((_st, path) => path !== foreign);
    await markKey(COPY, K1, true, ACTOR);
    const error = await caught(put(P1, bytesOf('jpeg')));
    expect([error.status, reasonOf(error)]).toEqual([409, 'media_level_foreign']);
    expect(modeOf('image')).toBe(0o750);
    expect(existsSync(join(ROOT, P1))).toBe(false);
    expect((await readAudit())[0]).toMatchObject({ action: 'media.put', outcome: 'refused', detail: { reason: 'media_level_foreign' } });
  });

  test('a symlinked level INSIDE the root is refused, never followed; the link target keeps its mode', async () => {
    const target = join(ROOT, 'elsewhere');
    mkdirSync(join(ROOT, 'image'), { recursive: true });
    mkdirSync(target);
    chmodSync(target, 0o700);
    symlinkSync(target, join(ROOT, 'image', '1.5MB'));
    await markKey(COPY, K1, true, ACTOR);
    const error = await caught(put(P1, bytesOf('jpeg')));
    expect([error.status, error.extensions?.path_reason]).toEqual([422, 'escapes_root']);
    expect(modeOf('elsewhere')).toBe(0o700);
    expect(readdirSync(target)).toEqual([]);
  });
});

describe('media.delete', () => {
  test('deletes, reports absent paths, dedupes, and forgets the sha', async () => {
    await markKey(COPY, K1, true, ACTOR);
    await put(P1, bytesOf('one'));
    await put(P1_THUMB, bytesOf('two'));
    const missing = 'image/1.5MB/0/test99_test3_9.jpg';
    expect(await deleteMediaFiles(COPY, [P1, P1, missing], ACTOR)).toEqual({
      deleted: [P1],
      absent: [missing],
      failed: [],
    });
    expect(existsSync(join(ROOT, P1))).toBe(false);
    expect(existsSync(join(ROOT, P1_THUMB))).toBe(true);
    resetShaIndexForTests();
    expect(shaIndexEntries(ROOT)).toBe(1);
    expect((await readAudit())[0]).toMatchObject({ action: 'media.delete', outcome: 'ok' });
  });

  test('a stray and a master can be deleted: reconcile removes what must not be there', async () => {
    plant('image/original/0/test99_test3_1.tif', 'master');
    plant('stray.txt', 'stray');
    expect(await deleteMediaFiles(COPY, ['image/original/0/test99_test3_1.tif', 'stray.txt'], ACTOR)).toEqual({
      deleted: ['image/original/0/test99_test3_1.tif', 'stray.txt'],
      absent: [],
      failed: [],
    });
  });

  test('a malformed request is 400, a reserved path 422, and then nothing is deleted', async () => {
    for (const bad of [[], 'x', Array(MAX_DELETE_PATHS + 1).fill(P1), [1]]) {
      const error = await caught(deleteMediaFiles(COPY, bad, ACTOR));
      expect([error.status, reasonOf(error)]).toEqual([400, 'body_invalid']);
    }
    plant(P1, 'keep');
    const error = await caught(deleteMediaFiles(COPY, [P1, '.publication/pub/test3_1'], ACTOR));
    expect([error.status, reasonOf(error), error.extensions?.path_reason, error.extensions?.index]).toEqual([
      422,
      'media_path_refused',
      'reserved_segment',
      1,
    ]);
    expect(existsSync(join(ROOT, P1))).toBe(true);
  });

  test('a symlinked directory cannot carry a delete outside the root', async () => {
    const outside = corner('outside_delete');
    mkdirSync(join(outside, '1.5MB', '0'), { recursive: true });
    const victim = join(outside, '1.5MB', '0', 'test99_test3_1.jpg');
    writeFileSync(victim, 'not yours');
    symlinkSync(outside, join(ROOT, 'image'));
    expect(await deleteMediaFiles(COPY, [P1], ACTOR)).toEqual({
      deleted: [],
      absent: [],
      failed: [{ path: P1, error: 'escapes_root' }],
    });
    expect(existsSync(victim)).toBe(true);
    expect((await readAudit())[0]).toMatchObject({ action: 'media.delete', outcome: 'failed' });
  });
});

describe('media.mark', () => {
  test('publishes and unpublishes the marker the gate stats, idempotently, every call audited', async () => {
    const marker = join(ROOT, PUB_DIR, K1);
    expect(await markKey(COPY, K1, true, ACTOR)).toEqual({ key: K1, published: true, changed: true });
    expect(statSync(marker).size).toBe(0);
    expect((await markKey(COPY, K1, true, ACTOR)).changed).toBe(false);
    expect(await markKey(COPY, K1, false, ACTOR)).toEqual({ key: K1, published: false, changed: true });
    expect(existsSync(marker)).toBe(false);
    expect((await markKey(COPY, K1, false, ACTOR)).changed).toBe(false);
    const marks = (await readAudit()).filter(entry => entry.action === 'media.mark');
    expect(marks.map(entry => entry.detail?.changed)).toEqual([false, true, false, true]);
  });

  test('refuses a key the grammar cannot produce (422) and a non-boolean (400)', async () => {
    for (const key of ['TEST3_1', '../x', 'test3', 7]) {
      const error = await caught(markKey(COPY, key, true, ACTOR));
      expect([error.status, reasonOf(error)]).toEqual([422, 'key_invalid']);
    }
    const error = await caught(markKey(COPY, K1, 'yes', ACTOR));
    expect([error.status, reasonOf(error)]).toEqual([400, 'body_invalid']);
    expect(existsSync(join(ROOT, PUB_DIR))).toBe(false);
  });
});

describe('media.manifest', () => {
  test('pages every entry in path order: regular files with sha, the rest as irregular; markers on the first page only', async () => {
    const files = [
      'stray.txt',
      'image/thumb/0/test99_test3_1.jpg',
      'image/1.5MB/1000/test99_test3_1001.jpg',
      'image/1.5MB/0/test99_test3_2.jpg',
      'image/1.5MB/0/test99_test3_1.jpg',
      'image/1.5MB.x',
      AV2,
    ];
    for (const file of files) plant(file, `bytes of ${file}`);
    plant('image/.DS_Store', 'hidden');
    symlinkSync(join(ROOT, 'stray.txt'), join(ROOT, 'image', 'link.jpg'));
    await markKey(COPY, K1, true, ACTOR);
    await markKey(COPY, K2, true, ACTOR);

    const seen: string[] = [];
    const irregular: string[] = [];
    const markerPages: string[][] = [];
    let cursor: string | null = null;
    do {
      const page = await mediaManifest(COPY, cursor, 3);
      for (const entry of page.entries) {
        const text = `bytes of ${entry.path}`;
        expect(entry).toEqual({ path: entry.path, size: Buffer.byteLength(text), sha256: sha(text) });
        seen.push(entry.path);
      }
      irregular.push(...page.irregular);
      markerPages.push(page.markers);
      cursor = page.next;
    } while (cursor !== null);

    expect(seen).toEqual([...files].sort());
    expect(irregular).toEqual(['image/.DS_Store', 'image/link.jpg']);
    expect(markerPages.length).toBe(3);
    expect(markerPages[0]).toEqual([K1, K2]);
    expect(markerPages.slice(1)).toEqual([[], []]);
  });

  test('VERIFIED DELETION: a symlink at a public path, a dotfile, a hidden dir, a fifo and a top-level stray are reported and deletable; the link target is never touched; .publication is never listed', async () => {
    const outside = corner('outside_master');
    const master = join(outside, 'test99_test3_1.tif');
    writeFileSync(master, 'a master tree file');
    mkdirSync(join(ROOT, 'image', 'thumb', '0'), { recursive: true });
    symlinkSync(master, join(ROOT, 'image', 'thumb', '0', 'test99_test3_1.jpg'));
    symlinkSync(outside, join(ROOT, 'image', '1.5MB'));
    plant('image/thumb/0/.x_test3_1.jpg', 'dot');
    plant('image/.cache/test99_test3_1.jpg', 'cached');
    plant('.stray', 'top-level');
    plant('image/thumb/0/test99_test3_2.jpg', 'regular');
    expect(Bun.spawnSync(['mkfifo', join(ROOT, 'image', 'thumb', '0', 'queue.fifo')]).exitCode).toBe(0);
    await markKey(COPY, K1, true, ACTOR);

    const irregular = [
      '.stray',
      'image/.cache/test99_test3_1.jpg',
      'image/1.5MB',
      'image/thumb/0/.x_test3_1.jpg',
      'image/thumb/0/queue.fifo',
      'image/thumb/0/test99_test3_1.jpg',
    ];
    const regular = { path: 'image/thumb/0/test99_test3_2.jpg', size: 7, sha256: sha('regular') };
    expect(await mediaManifest(COPY, null, 100)).toEqual({ entries: [regular], irregular, markers: [K1], next: null });

    expect(await deleteMediaFiles(COPY, irregular, ACTOR)).toEqual({ deleted: irregular, absent: [], failed: [] });
    expect(readFileSync(master, 'utf8')).toBe('a master tree file');
    expect(readdirSync(outside)).toEqual(['test99_test3_1.tif']);
    expect(await mediaManifest(COPY, null, 100)).toEqual({ entries: [regular], irregular: [], markers: [K1], next: null });
  });

  test('a file changed behind the index is re-hashed, never served from the cache', async () => {
    await markKey(COPY, K1, true, ACTOR);
    await put(P1, bytesOf('AAAA'));
    const file = join(ROOT, P1);
    writeFileSync(file, 'BBBB');
    const later = new Date(Date.now() + 60_000);
    utimesSync(file, later, later);
    expect((await mediaManifest(COPY, null, 10)).entries).toEqual([{ path: P1, size: 4, sha256: sha('BBBB') }]);
  });

  test('an empty copy root answers an empty first page', async () => {
    expect(await mediaManifest(COPY, null, 10)).toEqual({ entries: [], irregular: [], markers: [], next: null });
  });

  test('a cursor that is not ours, and a limit out of range, are 400', async () => {
    for (const [cursor, limit] of [
      ['not a cursor!', 10],
      [encodeCursor('../x'), 10],
      [encodeCursor('.publication/pub/test3_1'), 10],
      [null, 0],
      [null, MANIFEST_MAX_LIMIT + 1],
    ] as const) {
      const error = await caught(mediaManifest(COPY, cursor, limit));
      expect([error.status, reasonOf(error)]).toEqual([400, 'body_invalid']);
    }
  });

  test('encodeCursor / decodeCursor round-trip, a hidden path included', () => {
    expect(decodeCursor(encodeCursor(P1))).toBe(P1);
    expect(decodeCursor(encodeCursor('image/.DS_Store'))).toBe('image/.DS_Store');
  });

  test.skipIf(process.getuid?.() === 0)('an unreadable directory fails the manifest instead of hiding files', async () => {
    plant(P1, 'hidden by permissions');
    const dir = join(ROOT, 'image', '1.5MB', '0');
    chmodSync(dir, 0o000);
    try {
      await expect(mediaManifest(COPY, null, 10)).rejects.toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('withKeyLock', () => {
  test('serializes per key and survives a throwing holder', async () => {
    const order: string[] = [];
    const first = withKeyLock('k', async () => {
      await Bun.sleep(10);
      order.push('first');
      throw new Error('holder failed');
    });
    const second = withKeyLock('k', async () => {
      order.push('second');
      return 2;
    });
    await expect(first).rejects.toThrow('holder failed');
    expect(await second).toBe(2);
    expect(order).toEqual(['first', 'second']);
  });
});
