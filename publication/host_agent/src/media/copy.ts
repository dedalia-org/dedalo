/**
 * COPY-MODE MEDIA COMMANDS — media.put / media.delete / media.mark / media.manifest
 * (spec §5.2, §6). Every one is refused (409 media_mode) unless MEDIA_MODE=copy.
 *
 * THE INVARIANT — what makes an unpublish safe against an in-flight put: a file LANDS only
 * while its record's marker `pub/<key>` exists, and that check and the final rename run
 * under the SAME per-key lock media.mark takes. Once `mark {key, published:false}` has
 * answered, no put for that key can land, whatever was already streaming. The engine
 * orders publish as mark(true) → puts and unpublish as mark(false) → delete → manifest
 * (verified absence). Between mark(false) and the delete the gate already answers 404: the
 * copy root is served by the publication_host profile, whose Rule B stats pub/<key>.
 *
 * PUT: shape check (media/grammar.ts) → marker present → confined → (size, sha) already
 * there? answer `unchanged` with the body unread → stream into
 * <root>/.publication/copy/incoming/<random>.part (same filesystem, so the rename is
 * atomic; `.publication/` is never served) → size + sha256 verified → per-key lock: marker
 * re-checked, confined mkdir, rename, sha index. The temp file is removed on every path.
 *
 * MODES ARE APPLIED, NOT REQUESTED (fs_modes.ts, T0-6). The unit runs the agent under
 * UMask=0027, so a mode passed to mkdir/writeFile landed `mode & ~0027`: media dirs,
 * `.publication/` and `pub/` came out 0750, the web user (not in the agent's group) could not
 * stat a marker nor traverse a dir, and every published file 404'd. Every level a put or a
 * mark walks is now asserted on a descriptor — media dirs, `.publication`, `pub` 0755, the
 * marker and the landed file 0644, `copy/` and `incoming/` 0700, a temp body 0600 — existing
 * levels included, so a put repairs the chain it lands in (the after-listen pass, repair.ts,
 * repairs the rest). A symlinked level is refused, never followed; a level the agent does not
 * own is never chmodded — judged by need (o+x public, nothing for others private), and one that
 * fails it refuses the put/mark 409 `media_level_foreign`.
 *
 * CONFINEMENT: the grammar refuses absolute, `.`/`..` and empty segments (and, for a put,
 * hidden ones; for a delete, the reserved top-level names); then the REAL path of the
 * deepest existing ancestor must lie inside the real root BEFORE anything is created, and
 * again before the rename / unlink. A symlinked directory inside the root can never carry a
 * write or a delete outside it; a symlink that IS the named path is unlinked as itself.
 *
 * MANIFEST — NOTHING IS INVISIBLE but RESERVED_TOP_LEVEL. One path-ordered walk: a regular
 * file with no hidden segment is an `entries` row (sha256 from the index, else re-hashed —
 * the disk is the truth); EVERY other non-directory entry (a symlink, never followed nor
 * descended; a fifo, socket or device; a hidden file; a file under a hidden directory) is
 * an `irregular` path on the page where it falls. A planted link or dotfile is therefore
 * visible to reconcile and to deletion verification, and deletable. An unreadable
 * directory FAILS the call: a shorter list would let the engine record an unpublish as
 * verified while the bytes are still there.
 *
 * AUDIT: every put, delete and mark is audited (actor = X-Dedalo-Actor), including a put's
 * path refusal (what a put of a master looks like). A wrong media mode, malformed headers
 * or body and a busy path are refused before any work and are not audited (the phase-2
 * release routes' rule).
 *
 * Module state: `keyLocks` (per-key promise chains, shape copied from
 * src/diffusion/targets/mediastore/media_index.ts withKeyLock — entries deleted once their
 * chain drains) and `puttingPaths` (single-flight per path). Pure serialization; no request
 * identity is held.
 */

import { randomBytes } from 'node:crypto';
import { type Dirent, type Stats, existsSync, statSync } from 'node:fs';
import {
  type FileHandle,
  lstat,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { type AuditAction, audit } from '../audit';
import { config } from '../config';
import { ApiError, ConflictError, RefusedError, ValidationError } from '../errors';
import {
  MARKER_KEY,
  MAX_MEDIA_FILE_BYTES,
  type MediaPathVerdict,
  RESERVED_TOP_LEVEL,
  classifyMediaPath,
} from './grammar';
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  PUBLIC_DIR_MODE,
  PUBLIC_FILE_MODE,
  createFileExact,
  ensureDirExact,
  escapesRoot,
} from './fs_modes';
import { PUB_DIR } from './probe';
import { COPY_STATE_DIR, ensureCopyStateDir, forgetSha, lookupSha, recordSha } from './sha_index';

export interface CopyTarget {
  mode: 'shared' | 'copy' | 'none';
  root: string | null;
}

export const INCOMING_DIR = join(COPY_STATE_DIR, 'incoming');
export const MAX_DELETE_PATHS = 1000;
export const MANIFEST_DEFAULT_LIMIT = 1000;
export const MANIFEST_MAX_LIMIT = 5000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,2000}$/;

// ── the target ───────────────────────────────────────────────────────────────

/** The configured media mode and root. No route takes a root. */
export function configuredCopyTarget(): CopyTarget {
  return { mode: config.MEDIA_MODE, root: config.MEDIA_ROOT ?? null };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The copy root, or 409 media_mode: a shared or none host never runs a media command. */
export function requireCopyRoot(target: CopyTarget): string {
  if (target.mode !== 'copy' || target.root === null) {
    throw new ConflictError(
      `media commands run only on a copy-mode host; this agent is MEDIA_MODE=${target.mode}`,
      'media_mode',
    );
  }
  if (!isDirectory(target.root)) {
    throw new ConflictError(`the copy root ${target.root} is not a directory; nothing was done`, 'media_mode');
  }
  return target.root;
}

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

// ── serialization ────────────────────────────────────────────────────────────

const keyLocks = new Map<string, Promise<void>>();

/** Runs `fn` after every earlier holder of `key` has settled (a throwing holder releases too). */
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = keyLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  keyLocks.set(key, settled);
  try {
    return await next;
  } finally {
    if (keyLocks.get(key) === settled) keyLocks.delete(key);
  }
}

const puttingPaths = new Set<string>();

/** Claimed SYNCHRONOUSLY, so two puts of one path in the same tick cannot both pass. */
function claimPath(path: string): () => void {
  if (puttingPaths.has(path)) {
    throw new ConflictError(`a put of ${path} is already running; this one was refused. Retry when it finishes.`, 'busy');
  }
  puttingPaths.add(path);
  return () => {
    puttingPaths.delete(path);
  };
}

// ── confinement ──────────────────────────────────────────────────────────────

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  return lstat(path).catch(() => null);
}

async function exists(path: string): Promise<boolean> {
  return (await lstatOrNull(path)) !== null;
}

async function deepestExisting(dir: string): Promise<string> {
  let current = dir;
  while (!(await exists(current))) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

async function assertConfined(root: string, dir: string, path: string): Promise<void> {
  const realRoot = await realpath(root);
  const realDir = await realpath(await deepestExisting(dir)).catch(() => null);
  if (realDir === null || !inside(realRoot, realDir)) throw escapesRoot(path);
}

function pathRefused(label: string, verdict: MediaPathVerdict, extensions: Record<string, unknown> = {}): RefusedError {
  const reason = verdict.ok ? 'grammar' : verdict.reason;
  const detail = verdict.ok ? 'it names no record' : verdict.detail;
  return new RefusedError(`${label} was refused: ${detail}; nothing was changed`, 'media_path_refused', {
    path_reason: reason,
    ...extensions,
  });
}

// ── audit ────────────────────────────────────────────────────────────────────

async function auditFailure(
  action: AuditAction,
  actor: string,
  detail: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  const refused = error instanceof ApiError && error.status < 500;
  await audit({
    actor,
    action,
    outcome: refused ? 'refused' : 'failed',
    detail: {
      ...detail,
      reason: error instanceof ApiError ? (error.extensions?.reason ?? null) : null,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

// ── media.put ────────────────────────────────────────────────────────────────

export interface PutRequest {
  path: string;
  sha256: string;
  size: number;
  actor: string;
  body: ReadableStream<Uint8Array> | null;
}

export interface PutResult {
  path: string;
  key: string;
  size: number;
  sha256: string;
  replaced: boolean;
  unchanged: boolean;
}

export async function putMediaFile(target: CopyTarget, req: PutRequest): Promise<PutResult> {
  const root = requireCopyRoot(target);
  validatePutHeaders(req);
  const key = await acceptPutPath(req);
  const release = claimPath(req.path);
  try {
    const result = await putClaimed(root, key, req);
    await audit({
      actor: req.actor,
      action: 'media.put',
      outcome: 'ok',
      detail: { path: req.path, key, size: req.size, sha256: req.sha256, replaced: result.replaced, unchanged: result.unchanged },
    });
    return result;
  } catch (error) {
    await auditFailure('media.put', req.actor, { path: req.path, key, size: req.size, sha256: req.sha256 }, error);
    throw error;
  } finally {
    release();
  }
}

function validatePutHeaders(req: PutRequest): void {
  if (!SHA256_HEX.test(req.sha256)) {
    throw new ValidationError('X-Sha256 must be 64 lowercase hex characters', 'body_invalid');
  }
  if (!Number.isSafeInteger(req.size) || req.size < 0 || req.size > MAX_MEDIA_FILE_BYTES) {
    throw new ValidationError(`X-Size must be an integer from 0 to ${MAX_MEDIA_FILE_BYTES}`, 'body_invalid');
  }
}

/** A path refusal IS audited: it is what a put of a master or of a hidden file looks like. */
async function acceptPutPath(req: PutRequest): Promise<string> {
  const verdict = classifyMediaPath(req.path, 'put');
  if (verdict.ok && verdict.key !== null) return verdict.key;
  const error = pathRefused('the media path', verdict);
  await auditFailure('media.put', req.actor, { path: req.path }, error);
  throw error;
}

function assertMarked(root: string, key: string, path: string): void {
  if (existsSync(join(root, PUB_DIR, key))) return;
  throw new ConflictError(
    `${path}: record ${key} is not marked published on this host (media.mark first); a file never lands for an unpublished record`,
    'key_unpublished',
  );
}

async function putClaimed(root: string, key: string, req: PutRequest): Promise<PutResult> {
  assertMarked(root, key, req.path);
  const finalPath = join(root, req.path);
  await assertConfined(root, dirname(finalPath), req.path);
  if (await isUnchanged(root, finalPath, req)) {
    await req.body?.cancel().catch(() => undefined);
    return withKeyLock(key, async () => {
      assertMarked(root, key, req.path);
      return putResult(key, req, true, true);
    });
  }
  const temp = await receive(root, req);
  try {
    return await withKeyLock(key, () => land(root, key, finalPath, temp, req));
  } finally {
    await rm(temp, { force: true });
  }
}

async function isUnchanged(root: string, finalPath: string, req: PutRequest): Promise<boolean> {
  const st = await lstatOrNull(finalPath);
  if (st === null || !st.isFile() || st.size !== req.size) return false;
  return lookupSha(root, req.path, st.size, st.mtimeMs) === req.sha256;
}

async function receive(root: string, req: PutRequest): Promise<string> {
  ensureCopyStateDir(root);
  ensureDirExact(join(root, COPY_STATE_DIR), 'incoming', PRIVATE_DIR_MODE);
  const temp = join(root, INCOMING_DIR, `${randomBytes(12).toString('hex')}.part`);
  try {
    assertReceived(await writeBody(temp, req.body, req.size), req);
    return temp;
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    offset += bytesWritten;
  }
}

async function writeBody(
  temp: string,
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await createFileExact(temp, PRIVATE_FILE_MODE);
  const hasher = new Bun.CryptoHasher('sha256');
  let bytes = 0;
  try {
    if (body !== null) {
      for await (const chunk of body) {
        bytes += chunk.byteLength;
        if (bytes > cap) {
          throw new RefusedError(`the body is longer than the declared X-Size ${cap}; nothing was changed`, 'size_mismatch');
        }
        hasher.update(chunk);
        await writeAll(handle, chunk);
      }
    }
    await handle.chmod(PUBLIC_FILE_MODE);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hasher.digest('hex') };
}

function assertReceived(received: { bytes: number; sha256: string }, req: PutRequest): void {
  if (received.bytes !== req.size) {
    throw new RefusedError(`received ${received.bytes} bytes, X-Size declared ${req.size}; nothing was changed`, 'size_mismatch');
  }
  if (received.sha256 !== req.sha256) {
    throw new RefusedError(`the body hashes to ${received.sha256}, not the declared X-Sha256; nothing was changed`, 'hash_mismatch');
  }
}

/** Runs under the key lock: the marker is re-checked HERE, after the whole body arrived. */
async function land(root: string, key: string, finalPath: string, temp: string, req: PutRequest): Promise<PutResult> {
  assertMarked(root, key, req.path);
  const dir = dirname(finalPath);
  await assertConfined(root, dir, req.path);
  ensureDirExact(root, dirname(req.path), PUBLIC_DIR_MODE);
  await assertConfined(root, dir, req.path);
  const replaced = await exists(finalPath);
  await rename(temp, finalPath);
  const landed = await stat(finalPath);
  recordSha(root, req.path, { size: landed.size, mtimeMs: landed.mtimeMs, sha256: req.sha256 });
  return putResult(key, req, replaced, false);
}

function putResult(key: string, req: PutRequest, replaced: boolean, unchanged: boolean): PutResult {
  return { path: req.path, key, size: req.size, sha256: req.sha256, replaced, unchanged };
}

// ── media.delete ─────────────────────────────────────────────────────────────

export interface DeleteResult {
  deleted: string[];
  absent: string[];
  failed: { path: string; error: string }[];
}

/** Shape-checks EVERY path first (one refusal refuses the request, nothing deleted), then deletes. */
export async function deleteMediaFiles(target: CopyTarget, paths: unknown, actor: string): Promise<DeleteResult> {
  const root = requireCopyRoot(target);
  const accepted = acceptDeletePaths(paths);
  const result: DeleteResult = { deleted: [], absent: [], failed: [] };
  for (const entry of accepted) {
    await withKeyLock(entry.key ?? `path:${entry.path}`, () => deleteOne(root, entry.path, result));
  }
  await audit({
    actor,
    action: 'media.delete',
    outcome: result.failed.length === 0 ? 'ok' : 'failed',
    detail: { deleted: result.deleted, absent: result.absent, failed: result.failed },
  });
  return result;
}

function acceptDeletePaths(paths: unknown): { path: string; key: string | null }[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_DELETE_PATHS) {
    throw new ValidationError(`paths must be an array of 1 to ${MAX_DELETE_PATHS} strings`, 'body_invalid');
  }
  const accepted = new Map<string, { path: string; key: string | null }>();
  for (const [index, raw] of paths.entries()) {
    if (typeof raw !== 'string') throw new ValidationError(`paths[${index}] must be a string`, 'body_invalid');
    const verdict = classifyMediaPath(raw, 'delete');
    if (!verdict.ok) throw pathRefused(`paths[${index}]`, verdict, { index });
    accepted.set(verdict.path, { path: verdict.path, key: verdict.key });
  }
  return [...accepted.values()];
}

/** unlink removes the named entry itself: a symlink goes, its target is never touched. */
async function deleteOne(root: string, path: string, result: DeleteResult): Promise<void> {
  const full = join(root, path);
  try {
    await assertConfined(root, dirname(full), path);
    await unlink(full);
    forgetSha(root, path);
    result.deleted.push(path);
  } catch (error) {
    noteDeleteFailure(root, path, error, result);
  }
}

function noteDeleteFailure(root: string, path: string, error: unknown, result: DeleteResult): void {
  if (errnoOf(error) === 'ENOENT') {
    forgetSha(root, path);
    result.absent.push(path);
    return;
  }
  result.failed.push({ path, error: error instanceof RefusedError ? 'escapes_root' : errnoOf(error) });
}

// ── media.mark ───────────────────────────────────────────────────────────────

export interface MarkResult {
  key: string;
  published: boolean;
  changed: boolean;
}

export async function markKey(target: CopyTarget, key: unknown, published: unknown, actor: string): Promise<MarkResult> {
  const root = requireCopyRoot(target);
  if (typeof key !== 'string' || !MARKER_KEY.test(key)) {
    throw new RefusedError(`key must match ${MARKER_KEY.source} (the record a media filename names)`, 'key_invalid');
  }
  if (typeof published !== 'boolean') throw new ValidationError('published must be a boolean', 'body_invalid');
  try {
    const changed = await withKeyLock(key, () => setMarker(root, key, published));
    await audit({ actor, action: 'media.mark', outcome: 'ok', detail: { key, published, changed } });
    return { key, published, changed };
  } catch (error) {
    await auditFailure('media.mark', actor, { key, published }, error);
    throw error;
  }
}

/** lstat, not existsSync: a dangling or foreign marker link is present and removed by mark(false). */
async function setMarker(root: string, key: string, published: boolean): Promise<boolean> {
  const marker = join(root, PUB_DIR, key);
  const st = await lstatOrNull(marker);
  const present = st !== null && !st.isDirectory();
  if (present === published) return false;
  if (!published) {
    await unlink(marker);
    return true;
  }
  ensureDirExact(root, PUB_DIR, PUBLIC_DIR_MODE);
  await (await createFileExact(marker, PUBLIC_FILE_MODE)).close();
  return true;
}

// ── media.manifest ───────────────────────────────────────────────────────────

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ManifestPage {
  /** Regular files with no hidden segment, with their sha256. */
  entries: ManifestEntry[];
  /** Every other non-directory entry on this page (symlink, fifo, socket, device, hidden). */
  irregular: string[];
  /** Every non-directory `pub/` entry named like a key, sorted — first page only; later pages carry []. */
  markers: string[];
  next: string | null;
}

export function encodeCursor(path: string): string {
  return Buffer.from(path, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const path = CURSOR.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  if (!classifyMediaPath(path, 'delete').ok) {
    throw new ValidationError('cursor is not a manifest cursor from this agent', 'body_invalid');
  }
  return path;
}

interface Listed {
  path: string;
  irregular: boolean;
}

export async function mediaManifest(target: CopyTarget, cursor: string | null, limit: number): Promise<ManifestPage> {
  const root = requireCopyRoot(target);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MANIFEST_MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer from 1 to ${MANIFEST_MAX_LIMIT}`, 'body_invalid');
  }
  const after = cursor === null ? null : decodeCursor(cursor);
  const listed: Listed[] = [];
  await walk(root, '', false, after, limit + 1, listed);
  const page = listed.slice(0, limit);
  const { entries, irregular } = await describePage(root, page);
  const last = page[page.length - 1];
  return {
    entries,
    irregular,
    markers: after === null ? await listMarkers(root) : [],
    next: listed.length > limit && last !== undefined ? encodeCursor(last.path) : null,
  };
}

async function describePage(root: string, page: Listed[]): Promise<{ entries: ManifestEntry[]; irregular: string[] }> {
  const entries: ManifestEntry[] = [];
  const irregular: string[] = [];
  for (const item of page) {
    const described = item.irregular ? 'irregular' : await describeFile(root, item.path);
    if (described === 'irregular') irregular.push(item.path);
    else if (described !== null) entries.push(described);
  }
  return { entries, irregular };
}

interface Child {
  name: string;
  kind: 'dir' | 'file' | 'irregular';
}

/** A directory sorts as `name/`, so the depth-first order IS the full-path string order. */
function sortKey(child: Child): string {
  return child.kind === 'dir' ? `${child.name}/` : child.name;
}

/** Dirents never follow links: a symlink (to a dir too) is a leaf, never descended. */
function childKind(dirent: Dirent): Child['kind'] {
  if (dirent.isDirectory()) return 'dir';
  return dirent.isFile() && !dirent.name.startsWith('.') ? 'file' : 'irregular';
}

function isReservedTopLevel(rel: string, name: string): boolean {
  return rel === '' && (RESERVED_TOP_LEVEL as readonly string[]).includes(name);
}

async function children(root: string, rel: string): Promise<Child[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return [];
    throw error;
  }
  return dirents
    .filter(d => !isReservedTopLevel(rel, d.name))
    .map(d => ({ name: d.name, kind: childKind(d) }))
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/** Every string with prefix `prefix` sorts before `after` — the whole subtree is already paged. */
function subtreeBefore(prefix: string, after: string | null): boolean {
  return after !== null && prefix < after && !after.startsWith(prefix);
}

/** `hidden`: an ancestor segment starts with '.' — every leaf below it is irregular. */
async function walk(
  root: string,
  rel: string,
  hidden: boolean,
  after: string | null,
  max: number,
  out: Listed[],
): Promise<void> {
  for (const child of await children(root, rel)) {
    if (out.length >= max) return;
    const path = rel === '' ? child.name : `${rel}/${child.name}`;
    if (child.kind !== 'dir') {
      if (after === null || path > after) out.push({ path, irregular: hidden || child.kind === 'irregular' });
      continue;
    }
    if (!subtreeBefore(`${path}/`, after)) await walk(root, path, hidden || child.name.startsWith('.'), after, max, out);
  }
}

async function hashFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

/**
 * null = vanished between the listing and the stat (gone: truthful). 'irregular' = it is no
 * longer a regular file (swapped for a link or a fifo): reported, never hidden.
 */
async function describeFile(root: string, path: string): Promise<ManifestEntry | 'irregular' | null> {
  const full = join(root, path);
  const st = await lstatOrNull(full);
  if (st === null) return null;
  if (!st.isFile()) return 'irregular';
  const cached = lookupSha(root, path, st.size, st.mtimeMs);
  if (cached !== null) return { path, size: st.size, sha256: cached };
  const sha256 = await hashFile(full);
  recordSha(root, path, { size: st.size, mtimeMs: st.mtimeMs, sha256 });
  return { path, size: st.size, sha256 };
}

/** Any non-directory entry named like a key: the gate follows a marker link, so the engine must see it. */
async function listMarkers(root: string): Promise<string[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(join(root, PUB_DIR), { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return [];
    throw error;
  }
  return dirents
    .filter(d => !d.isDirectory() && MARKER_KEY.test(d.name))
    .map(d => d.name)
    .sort();
}
