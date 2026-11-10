/**
 * APPLIED MODES — the one door every directory and file the agent creates under the media
 * root goes through (T0-6).
 *
 * WHY: the generated unit runs the agent under `UMask=0027` (provision/render/unit_agent.ts),
 * its least-privilege floor, and a mode passed to mkdir/open/writeFile is only REQUESTED: the
 * kernel lands `mode & ~umask`. Requested 0755 dirs landed 0750, and the web server user (not
 * in the agent's group) could neither stat `.publication/pub/<key>` (the Rule-B gate) nor
 * traverse a media dir: every published file answered 404. So here the mode is APPLIED on a
 * descriptor (fchmod), never requested, and is exact under any umask — the agent's house rule
 * (releases/ustar.ts ensureDir, provision/apply.ts).
 *
 * WHAT: `ensureDirExact` walks a relative path under a base level by level — non-recursive
 * mkdir (EEXIST fine), then open O_DIRECTORY|O_NOFOLLOW (a symlinked level is refused
 * `escapes_root`, never followed), fchmod iff the bits differ. EXISTING levels are asserted
 * too: the same call that mints a level repairs a dark one.
 *
 * NOT THE AGENT'S: a level the agent does not own is never chmodded (the agent does not fight
 * an operator), and judged by NEED, not by exact mode (`meetsNeed`): a public dir needs o+x
 * (the web user searches it — 0775 or 0711 serve), a private one (`.publication/copy`) must
 * grant no group/other bit, a marker is only stat'ed. A level that fails its need refuses the
 * put/mark path with its own reason, 409 `media_level_foreign`; the boot repair (repair.ts)
 * lists it instead. Agent-owned levels keep their EXACT mode.
 * Files: `createFileExact` (O_EXCL, then fchmod) and `writePrivateSync` (the sha index).
 *
 * Ownership is injectable (`Ownership`, `setOwnershipForTests`): the foreign branch cannot be
 * produced honestly by a suite that runs as one user. Module state: that one test seam.
 */

import { closeSync, constants as FS, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, type Stats, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config';
import { ConflictError, RefusedError } from '../errors';

/** Public media dirs, `.publication`, `pub`: the web user searches them. */
export const PUBLIC_DIR_MODE = 0o755;
/** `.publication/copy` and below: the agent's own state. */
export const PRIVATE_DIR_MODE = 0o700;
/** Served media files and markers. */
export const PUBLIC_FILE_MODE = 0o644;
/** Temp bodies, the sha index, probe files. */
export const PRIVATE_FILE_MODE = 0o600;

/** Does the agent own this inode? Only an owned inode is ever chmodded. */
export type Ownership = (st: Stats, path: string) => boolean;
export const ownedByAgent: Ownership = st => st.uid === process.getuid?.();

let ownershipOverride: Ownership | null = null;

/** The ownership every default caller uses: the real uid check, or the suite's injection. */
export const agentOwnership: Ownership = (st, path) => (ownershipOverride ?? ownedByAgent)(st, path);

/** Inject an ownership for the put/mark path (null restores the uid check). Refused outside NODE_ENV=test. */
export function setOwnershipForTests(owns: Ownership | null): void {
  if (config.NODE_ENV !== 'test') throw new Error('setOwnershipForTests is refused outside NODE_ENV=test');
  ownershipOverride = owns;
}

/** What asserting a mode did: already right (or a foreign mode that serves), changed, or a foreign mode that does not. */
export type ModeVerdict = 'kept' | 'fixed' | 'foreign';
export type InodeKind = 'dir' | 'file';

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8);
}

/**
 * Does a mode the agent may not change still do its job? Private (`wanted` grants no
 * group/other bit): `found` must grant none either. Public dir: o+x, the web user's search.
 * Public file (a marker): the gate only stats it — any mode serves.
 */
export function meetsNeed(found: number, wanted: number, kind: InodeKind): boolean {
  if ((wanted & 0o077) === 0) return (found & 0o077) === 0;
  return kind === 'file' || (found & 0o001) !== 0;
}

export function escapesRoot(path: string): RefusedError {
  return new RefusedError(`${path} resolves outside the copy root; nothing was changed`, 'media_path_refused', {
    path_reason: 'escapes_root',
  });
}

function foreignLevel(path: string, found: number, wanted: number): ConflictError {
  const need = (wanted & 0o077) === 0 ? 'grants access to other users' : 'has no search bit for others';
  return new ConflictError(
    `${path} belongs to another user and is mode ${octal(found)}, which ${need}; the agent never changes a ` +
      `directory it does not own. Fix its owner or mode by hand; the file was not written`,
    'media_level_foreign',
  );
}

/** A link refused by O_NOFOLLOW: ELOOP (Linux), ENOTDIR when O_DIRECTORY is set too (macOS). */
function isLinkRefusal(path: string, code: string): boolean {
  if (code === 'ELOOP') return true;
  return code === 'ENOTDIR' && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

function openRefusal(path: string, error: unknown): unknown {
  return isLinkRefusal(path, errnoOf(error)) ? escapesRoot(path) : error;
}

/** O_NOFOLLOW (+ O_DIRECTORY for a dir): a symlink is refused, never followed; O_NONBLOCK: a fifo never hangs. */
function openNoFollow(path: string, kind: InodeKind): number {
  const directory = kind === 'dir' ? FS.O_DIRECTORY : 0;
  try {
    return openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | directory);
  } catch (error) {
    throw openRefusal(path, error);
  }
}

type Decision = 'kept' | 'chmod' | 'foreign';

/** Owned: exact mode. Not owned: never touched — 'kept' when it serves its need, else 'foreign'. */
function decide(st: Stats, path: string, mode: number, kind: InodeKind, owns: Ownership): Decision {
  if ((st.mode & 0o777) === mode) return 'kept';
  if (owns(st, path)) return 'chmod';
  return meetsNeed(st.mode, mode, kind) ? 'kept' : 'foreign';
}

/** setuid/setgid/sticky are an operator's choice: kept. */
function withSpecialBits(st: Stats, mode: number): number {
  return (st.mode & 0o7000) | mode;
}

function verdictOf(decision: Decision): ModeVerdict {
  return decision === 'chmod' ? 'fixed' : decision;
}

interface Settled {
  verdict: ModeVerdict;
  found: number;
}

function settleMode(fd: number, path: string, mode: number, kind: InodeKind, owns: Ownership): Settled {
  const st = fstatSync(fd);
  const decision = decide(st, path, mode, kind, owns);
  if (decision === 'chmod') fchmodSync(fd, withSpecialBits(st, mode));
  return { verdict: verdictOf(decision), found: st.mode };
}

function settle(path: string, mode: number, kind: InodeKind, owns: Ownership): Settled {
  const fd = openNoFollow(path, kind);
  try {
    return settleMode(fd, path, mode, kind, owns);
  } finally {
    closeSync(fd);
  }
}

/** Assert `mode` on one existing inode, on its own descriptor (synchronous: the put/mark door). */
export function applyMode(path: string, mode: number, kind: InodeKind, owns: Ownership = agentOwnership): ModeVerdict {
  return settle(path, mode, kind, owns).verdict;
}

async function openNoFollowAsync(path: string, kind: InodeKind): Promise<FileHandle> {
  const directory = kind === 'dir' ? FS.O_DIRECTORY : 0;
  try {
    return await open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | directory);
  } catch (error) {
    throw openRefusal(path, error);
  }
}

async function settleHandle(handle: FileHandle, path: string, mode: number, kind: InodeKind, owns: Ownership): Promise<ModeVerdict> {
  const st = await handle.stat();
  const decision = decide(st, path, mode, kind, owns);
  if (decision === 'chmod') await handle.chmod(withSpecialBits(st, mode));
  return verdictOf(decision);
}

/** `applyMode` on the event loop's terms (the boot repair walks a whole tree with it). */
export async function applyModeAsync(path: string, mode: number, kind: InodeKind, owns: Ownership = agentOwnership): Promise<ModeVerdict> {
  const handle = await openNoFollowAsync(path, kind);
  try {
    return await settleHandle(handle, path, mode, kind, owns);
  } finally {
    await handle.close();
  }
}

function makeLevel(path: string): void {
  try {
    mkdirSync(path);
  } catch (error) {
    if (errnoOf(error) !== 'EEXIST') throw error;
  }
}

/**
 * Every level of `rel` under `base` exists, is a real directory and carries `mode` — exactly
 * when the agent owns it, by need when it does not (`meetsNeed`; else 409 media_level_foreign).
 * `base` itself is never touched (the copy root is provisioner-owned).
 */
export function ensureDirExact(base: string, rel: string, mode: number, owns: Ownership = agentOwnership): void {
  let current = base;
  for (const segment of rel.split('/').filter(part => part !== '')) {
    current = join(current, segment);
    makeLevel(current);
    const settled = settle(current, mode, 'dir', owns);
    if (settled.verdict === 'foreign') throw foreignLevel(current, settled.found, mode);
  }
}

/** A NEW file (O_CREAT|O_EXCL: never clobbers, never follows a planted link) with `mode` applied. */
export async function createFileExact(path: string, mode: number): Promise<FileHandle> {
  const handle = await open(path, 'wx');
  try {
    await handle.chmod(mode);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

/** `text` replacing or appended to an agent-private file, mode 0600 applied on every write. */
export function writePrivateSync(path: string, text: string, how: 'replace' | 'append'): void {
  const tail = how === 'append' ? FS.O_APPEND : FS.O_TRUNC;
  const fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_NOFOLLOW | tail);
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
