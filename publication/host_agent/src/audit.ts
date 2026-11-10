/**
 * The audit trail — append-only NDJSON at <STATE_ROOT>/audit/audit.jsonl, plus a journal
 * echo (one `[audit] {...}` stdout line, captured by systemd).
 *
 * Copied from publication/site_builder/src/audit.ts. Changes: the actor is the
 * `X-Dedalo-Actor` string; `action` is the closed set of mutating §6 commands plus the
 * automatic rollback and the copy-mode boot repair; an `outcome` field; no `site`; the path comes from instance/roots.ts;
 * no mkdir (the provisioner creates the root-owned directory and the file, the preflight
 * proves the rest); `readAudit` reads a given path (no route serves the trail in this phase).
 *
 * APPEND-ONLY IS ENFORCED, NOT HOPED (instance/roots.ts bootPreflight refuses to boot
 * otherwise, outside NODE_ENV=test): audit/ is root:root 0755, so the agent cannot unlink,
 * rename or re-create the file; STATE_ROOT and every ancestor up to / are root-owned and not
 * writable by others (sticky excepted), so it cannot rename audit/ itself aside either (a
 * directory rename is a permission on the PARENT); audit.jsonl is agent-owned 0600 WITH the
 * append-only attribute (chattr +a), so the kernel refuses a truncate or a non-append write —
 * even by its owner — and only CAP_LINUX_IMMUTABLE could clear it. The journald echo is the second,
 * independent record: the journal is not writable by the agent user, so a line it emits
 * cannot be taken back. `audit()` never throws into the request path.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditAction } from './audit_actions';
import { type AgentConfig, config } from './config';
import { AUDIT_DIR, AUDIT_FILE_NAME } from './instance/roots';

export type { AuditAction } from './audit_actions';
export { AUDIT_ACTION_ORIGIN } from './audit_actions';
export type AuditOutcome = 'ok' | 'refused' | 'failed';

export interface AuditEntry {
  ts: string;
  actor: string;
  action: AuditAction;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

export function auditPath(cfg: Pick<AgentConfig, 'STATE_ROOT'> = config): string {
  return join(cfg.STATE_ROOT, AUDIT_DIR, AUDIT_FILE_NAME);
}

export async function audit(entry: Omit<AuditEntry, 'ts'>, path: string = auditPath()): Promise<void> {
  const line: AuditEntry = { ts: new Date().toISOString(), ...entry };
  const serialized = JSON.stringify(line);
  console.log(`[audit] ${serialized}`);
  try {
    // flag 'a' = O_APPEND: the only open an append-only (chattr +a) file accepts.
    await appendFile(path, `${serialized}\n`, { encoding: 'utf8', flag: 'a' });
  } catch (error) {
    console.error('[audit] FAILED to persist audit line — investigate:', error);
  }
}

/** The trail, newest first, at most `limit` (1–1000) entries; corrupt lines skipped. */
export async function readAudit(path: string = auditPath(), limit = 100): Promise<AuditEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // a corrupt line is skipped, never fatal
    }
  }
  return entries.reverse().slice(0, Math.min(Math.max(limit, 1), 1000));
}
