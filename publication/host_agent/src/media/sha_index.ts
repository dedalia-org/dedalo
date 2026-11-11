/**
 * THE AGENT'S SHA INDEX — (path → size, mtimeMs, sha256) for the copy root (spec §5.2, M5),
 * persisted at <MEDIA_ROOT>/.publication/copy/sha_index.ndjson.
 *
 * A CACHE, NEVER THE TRUTH: media.manifest (copy.ts) walks the disk and takes a file's sha
 * from here only while the file's size AND mtimeMs still equal the recorded pair; anything
 * else is re-hashed and re-recorded. A hand-edited file, a restored backup or a lost index
 * costs hashing time, never a wrong answer. Corrupt lines are skipped for the same reason.
 *
 * WHY INSIDE THE MEDIA ROOT: it describes the bytes beside it; the media root is the one
 * tree a copy-mode agent writes (ReadWritePaths=), and `.publication/` is never served
 * (rule 0 of the publication_host profile) and is a RESERVED_TOP_LEVEL entry (never listed,
 * never deletable). `.publication/` itself stays traversable (0755) because the web server
 * stats `.publication/pub/<key>`; `.publication/copy/` is 0700, the index file 0600.
 *
 * MODES ARE APPLIED, NOT REQUESTED (fs_modes.ts): the unit's UMask=0027 turned a requested
 * 0755 `.publication/` into 0750 — the web user could not stat a marker and every file 404'd.
 * Both levels are asserted on every append, so an operator-widened `copy/` is pulled back.
 *
 * FORMAT: append-only NDJSON — {"p":path,"s":size,"m":mtimeMs,"h":sha256} records a file,
 * {"p":path,"d":1} forgets one. Loaded once per root by replay; compacted (tmp + rename)
 * when the log exceeds twice the live entries plus COMPACT_SLACK lines. Synchronous I/O:
 * one agent process, so an append and a compaction can never interleave.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { PRIVATE_DIR_MODE, PUBLIC_DIR_MODE, ensureDirExact, writePrivateSync } from './fs_modes';

export interface ShaRecord {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export const COPY_STATE_DIR = join('.publication', 'copy');
export const SHA_INDEX_FILE = join(COPY_STATE_DIR, 'sha_index.ndjson');
export const COMPACT_SLACK = 1000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface IndexState {
  file: string;
  entries: Map<string, ShaRecord>;
  lines: number;
}

/** One loaded index per copy root (the suite drives more than one root). */
const states = new Map<string, IndexState>();

/** `.publication/` traversable for the gate, `.publication/copy/` private to the agent. */
export function ensureCopyStateDir(root: string): void {
  ensureDirExact(root, '.publication', PUBLIC_DIR_MODE);
  ensureDirExact(join(root, '.publication'), 'copy', PRIVATE_DIR_MODE);
}

function isRecord(value: Record<string, unknown>): boolean {
  const { s, m, h } = value;
  return typeof s === 'number' && typeof m === 'number' && typeof h === 'string' && SHA256_HEX.test(h);
}

function applyLine(line: string, entries: Map<string, ShaRecord>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const value = parsed as Record<string, unknown>;
  if (typeof value.p !== 'string') return;
  if (value.d === 1) {
    entries.delete(value.p);
    return;
  }
  if (isRecord(value)) {
    entries.set(value.p, { size: value.s as number, mtimeMs: value.m as number, sha256: value.h as string });
  }
}

function load(root: string): IndexState {
  const cached = states.get(root);
  if (cached !== undefined) return cached;
  const file = join(root, SHA_INDEX_FILE);
  const entries = new Map<string, ShaRecord>();
  let lines = 0;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    lines++;
    applyLine(line, entries);
  }
  const state: IndexState = { file, entries, lines };
  states.set(root, state);
  return state;
}

function serialize(path: string, record: ShaRecord): string {
  return JSON.stringify({ p: path, s: record.size, m: record.mtimeMs, h: record.sha256 });
}

function compact(state: IndexState): void {
  const tmp = `${state.file}.compact`;
  const body = [...state.entries].map(([path, record]) => `${serialize(path, record)}\n`).join('');
  writePrivateSync(tmp, body, 'replace');
  renameSync(tmp, state.file);
  state.lines = state.entries.size;
}

function append(root: string, state: IndexState, line: string): void {
  ensureCopyStateDir(root);
  writePrivateSync(state.file, `${line}\n`, 'append');
  state.lines++;
  if (state.lines > state.entries.size * 2 + COMPACT_SLACK) compact(state);
}

/** The recorded sha, ONLY when size and mtime still match; null means "hash it". */
export function lookupSha(root: string, path: string, size: number, mtimeMs: number): string | null {
  const record = load(root).entries.get(path);
  if (record === undefined || record.size !== size || record.mtimeMs !== mtimeMs) return null;
  return record.sha256;
}

export function recordSha(root: string, path: string, record: ShaRecord): void {
  const state = load(root);
  state.entries.set(path, record);
  append(root, state, serialize(path, record));
}

export function forgetSha(root: string, path: string): void {
  const state = load(root);
  if (!state.entries.delete(path)) return;
  append(root, state, JSON.stringify({ p: path, d: 1 }));
}

export function shaIndexEntries(root: string): number {
  return load(root).entries.size;
}

/** Drop every loaded index (the next call replays from disk). Refused outside NODE_ENV=test. */
export function resetShaIndexForTests(): void {
  if (config.NODE_ENV !== 'test') throw new Error('resetShaIndexForTests is refused outside NODE_ENV=test');
  states.clear();
}
