/**
 * THE COPY-MODE MEDIA REPAIR (T0-6) — started by index.ts once the listener is up, on a
 * copy-mode host only.
 *
 * WHY: before T0-6 the agent REQUESTED modes under the unit's UMask=0027, so an installed copy
 * root holds 0750 dirs and 0640 markers the web user cannot search: every published file
 * 404s. A put only repairs the chain it lands in, and an unchanged file never reaches it, so
 * the trees already deployed need this pass. It is also the self-heal for operator drift.
 *
 * WHAT: a STREAMING walk (opendir, one entry at a time, every inode on its own async
 * descriptor — fs_modes.applyModeAsync) of the DIRECTORIES under MEDIA_ROOT. Dirents never
 * follow links: a symlinked dir is neither chmodded nor descended. 0755, except
 * `.publication/copy` and everything below it (0700, pulled back when widened); regular files
 * directly in `.publication/pub` (the markers) 0644. Media FILES are not touched (writeBody
 * always applied 0644). The root itself is the provisioner's. A level the agent does not own
 * is judged by need (fs_modes.meetsNeed), never chmodded.
 *
 * AFTER LISTEN, CONCURRENT WITH PUTS — safe because every writer converges on ONE mode per
 * path: a put/mark's ensureDirExact and this pass apply the same constant to the same level
 * (public 0755, private 0700, marker 0644), each on a descriptor, so whatever the
 * interleaving the last chmod writes the same bits; neither ever narrows what the other set.
 * An entry that vanishes mid-walk (an unpublish unlinking a marker) is skipped, not failed.
 * The event loop is never held: SIGTERM drains as on any boot; a walk cut by the exit writes
 * no row and the next boot finishes it.
 *
 * NEVER FAILS THE AGENT: a dark dir the agent does not own is listed in `foreign` (the probe's
 * web_traversable reports it too); an entry that cannot be opened or listed is listed in
 * `failed` with its errno and not descended. Serving the rest beats serving nothing.
 *
 * AUDIT (when the walk ends): ONE `media.repair` row (actor `agent.boot`) only when something
 * was fixed or listed — `ok` when everything is now right, `failed` when a foreign or failed
 * entry remains. BOUNDED: counts plus the first REPAIR_LIST_CAP paths per list, the rest
 * counted in `foreign_more` / `failed_more`. A healthy tree writes ZERO, the row included. One
 * `[media.repair]` stdout line always closes the pass (the journal; the process gate reads it).
 */

import { type Dirent, statSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { audit } from '../audit';
import type { AgentConfig } from '../config';
import { agentOwnership, applyModeAsync, type Ownership, PRIVATE_DIR_MODE, PUBLIC_DIR_MODE, PUBLIC_FILE_MODE } from './fs_modes';
import { PUB_DIR } from './probe';
import { COPY_STATE_DIR } from './sha_index';

export interface RepairReport {
  dirs_fixed: number;
  markers_fixed: number;
  /** The first REPAIR_LIST_CAP wrong-mode entries the agent does not own (absolute): left as they are. */
  foreign: string[];
  foreign_more: number;
  /** The first REPAIR_LIST_CAP entries that could not be opened or listed, with the errno. */
  failed: { path: string; error: string }[];
  failed_more: number;
}

export const REPAIR_ACTOR = 'agent.boot';
/** How many paths a list keeps; the rest is a count (one audit row stays one line). */
export const REPAIR_LIST_CAP = 20;

interface Walk {
  root: string;
  owns: Ownership;
  report: RepairReport;
}

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return (error as { extensions?: { path_reason?: unknown } } | null)?.extensions?.path_reason === 'escapes_root'
    ? 'ELOOP'
    : 'unknown';
}

function isPrivate(rel: string): boolean {
  return rel === COPY_STATE_DIR || rel.startsWith(`${COPY_STATE_DIR}/`);
}

function noteForeign(report: RepairReport, path: string): void {
  if (report.foreign.length < REPAIR_LIST_CAP) report.foreign.push(path);
  else report.foreign_more++;
}

function noteFailed(report: RepairReport, path: string, error: unknown): void {
  if (report.failed.length < REPAIR_LIST_CAP) report.failed.push({ path, error: errnoOf(error) });
  else report.failed_more++;
}

/** One inode asserted, counted. false = it could not be opened (or vanished): do not descend. */
async function settle(walk: Walk, path: string, mode: number, kind: 'dir' | 'file', counter: 'dirs_fixed' | 'markers_fixed'): Promise<boolean> {
  try {
    const verdict = await applyModeAsync(path, mode, kind, walk.owns);
    if (verdict === 'fixed') walk.report[counter]++;
    if (verdict === 'foreign') noteForeign(walk.report, path);
    return true;
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') noteFailed(walk.report, path, error);
    return false;
  }
}

async function visitEntry(walk: Walk, rel: string, dirent: Dirent): Promise<void> {
  const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
  const path = join(walk.root, childRel);
  if (rel === PUB_DIR && dirent.isFile()) await settle(walk, path, PUBLIC_FILE_MODE, 'file', 'markers_fixed');
  if (!dirent.isDirectory()) return;
  const mode = isPrivate(childRel) ? PRIVATE_DIR_MODE : PUBLIC_DIR_MODE;
  if (await settle(walk, path, mode, 'dir', 'dirs_fixed')) await visit(walk, childRel);
}

async function visit(walk: Walk, rel: string): Promise<void> {
  const path = rel === '' ? walk.root : join(walk.root, rel);
  try {
    for await (const dirent of await opendir(path)) await visitEntry(walk, rel, dirent);
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') noteFailed(walk.report, path, error);
  }
}

function emptyReport(): RepairReport {
  return { dirs_fixed: 0, markers_fixed: 0, foreign: [], foreign_more: 0, failed: [], failed_more: 0 };
}

/** The pass itself. Resolves with the report; a filesystem error is an entry, never a rejection. */
export async function repairCopyRoot(root: string, owns: Ownership = agentOwnership): Promise<RepairReport> {
  const walk: Walk = { root, owns, report: emptyReport() };
  await visit(walk, '');
  return walk.report;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function leftovers(report: RepairReport): number {
  return report.foreign.length + report.foreign_more + report.failed.length + report.failed_more;
}

async function auditRepair(root: string, report: RepairReport): Promise<void> {
  if (report.dirs_fixed + report.markers_fixed + leftovers(report) === 0) return;
  await audit({
    actor: REPAIR_ACTOR,
    action: 'media.repair',
    outcome: leftovers(report) === 0 ? 'ok' : 'failed',
    detail: { root, ...report },
  });
}

type RepairConfig = Pick<AgentConfig, 'MEDIA_MODE'> & Partial<Pick<AgentConfig, 'MEDIA_ROOT'>>;

/**
 * The step index.ts runs after the listener is up: null (nothing done, nothing logged) unless
 * MEDIA_MODE=copy with a root that is a directory — an absent root is the probe's finding.
 * Never rejects: an unexpected throw is logged and answered null.
 */
export async function repairMediaAtBoot(cfg: RepairConfig, owns: Ownership = agentOwnership): Promise<RepairReport | null> {
  if (cfg.MEDIA_MODE !== 'copy' || cfg.MEDIA_ROOT === undefined || !isDirectory(cfg.MEDIA_ROOT)) return null;
  try {
    const report = await repairCopyRoot(cfg.MEDIA_ROOT, owns);
    await auditRepair(cfg.MEDIA_ROOT, report);
    console.log(`[media.repair] ${JSON.stringify(report)}`);
    return report;
  } catch (error) {
    console.error('[media.repair] the pass stopped — investigate:', error);
    return null;
  }
}
