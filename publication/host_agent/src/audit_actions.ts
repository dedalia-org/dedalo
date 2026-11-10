/**
 * THE AUDIT ACTIONS — a LEAF (no config import): the provisioner's init (provision/init/pair.ts,
 * run as root without the agent's env) reads the origin map, and importing audit.ts would load
 * the agent config. audit.ts re-exports both names.
 */

export type AuditAction =
  | 'rules.apply'
  /** The host-wide nginx map contribution (src/rules/map.ts, spec §13.5). */
  | 'rules.map'
  | 'release.install'
  | 'release.rollback'
  | 'release.auto_rollback'
  | 'media.put'
  | 'media.delete'
  | 'media.mark'
  /** The copy-mode boot repair (src/media/repair.ts): automatic, not an engine command. */
  | 'media.repair';

/**
 * WHO ASKED FOR EACH ACTION: `engine` = an authenticated work-host command (proof the work host
 * holds the pairing credentials, provision/init/pair.ts engineContactSince); `agent` = an
 * automatic record the agent writes on its own. Exhaustive by type: a new action does not
 * compile until it is classified.
 */
export const AUDIT_ACTION_ORIGIN: Readonly<Record<AuditAction, 'engine' | 'agent'>> = Object.freeze({
  'rules.apply': 'engine',
  'rules.map': 'engine',
  'release.install': 'engine',
  'release.rollback': 'engine',
  'release.auto_rollback': 'agent',
  'media.put': 'engine',
  'media.delete': 'engine',
  'media.mark': 'engine',
  'media.repair': 'agent',
});
