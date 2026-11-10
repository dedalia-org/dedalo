/**
 * B5 — PAIR THE NEW AGENT WITH THE WORK SYSTEM ON THIS MACHINE, OR SAY HOW (spec §6, D5).
 *
 * One machine: a running Dédalo work engine (`dedalo-ts` / `dedalo-ts@<site>`) is found among
 * the discovered units, and the work system's OWN pairing command
 * (scripts/publication_host_pair.ts — the only way in, spec §2.1) is run AS THE ENGINE USER
 * through initExec().pairAsEngine: `setsid --wait runuser -u <user> -- <bun> --no-install
 * <checkout>/scripts/publication_host_pair.ts add|replace <name> --fragment <f> --token-stdin`.
 * The token reaches the child's STDIN ONLY (exec.ts refuses it anywhere else); `setsid` leaves
 * the child without a controlling terminal; `runuser` writes no sudo log; the environment is
 * the unit's `DEDALO_*` entries plus PATH, HOME, LC_ALL — never NODE_ENV, never the unit's
 * EnvironmentFile (init never reads the engine's env file).
 *
 * Two machines (a tls listener): `pair.package` seals the engine fragment, the token and the
 * engine bundle into ONE file under a one-time passphrase (pairing_package.ts), shown once on the
 * terminal; the work host opens it with `dedalo:pair-publication-host add <name> --package`.
 * `--no-pair` or no work unit on a socket listener: nothing is run; twoMachineInstructions
 * prints the guide's step 6/8 commands with this instance's paths (the loose-file path, D5).
 *
 * WHAT THIS MODULE DECIDES, and what it leaves to the orchestrator: `pairPlan` (pure) turns the
 * facts into one of five shapes and `pairItem` (pure) into the §4.1 Item the report shows;
 * `pairOneMachine` (I/O through the injected exec) runs the dry run, then the real pairing,
 * and classifies the child's exit (spec §6 B5 step 5). Choosing among several units, the
 * EnvironmentFile decision and the replace/twin decisions are the operator's, asked by the
 * orchestrator with the options returned here.
 *
 * ZERO-DEPENDENCY-COMPATIBLE: the I/O is injected (PairPorts), and every import is
 * exec_contract.ts, layout.ts or the init contract — draft.ts (pure) imports `unitOptionId`
 * from here, so this file must stay importable by a zero-dep module.
 *
 * OUTPUT LAW: every child line passes `ports.sanitize` (report.ts sanitizeLine in production)
 * and any occurrence of the token is replaced before a line is returned — the token, read here
 * as root from the credential file, never leaves this module.
 */

import { join } from 'node:path';
import { AUDIT_ACTION_ORIGIN } from '../../audit_actions';
import { PAIR_NAME_PATTERN } from '../exec_contract';
import type { InitExec } from '../exec_contract';
import type { AgentLayout } from '../layout';
import { INIT_BASE } from '../lock';
import { FINGERPRINT_PENDING } from '../render/engine_fragment';
import { newPassphrase, PairingPackageRefused, sealPairingPackage } from '../pairing_package';
import type { GroupRow, HostFacts, InitArgs, InitIo, Item, ItemOption, PairInvocation, PasswdRow, WorkUnit } from './types';

/** The work engine's units (spec §6 B5 step 1). */
export const WORK_UNIT_PATTERN = /^dedalo-ts(@[A-Za-z0-9_.-]{1,64})?$/;
/** PATH of the pairing child (spec §6 B5 step 2). */
export const PAIR_CHILD_PATH = '/usr/local/bin:/usr/bin:/bin';
/** The unit Environment= keys that may reach the child (exec.ts PAIR_ENV_KEY, DEDALO_* half). */
const DEDALO_ENV_KEY = /^DEDALO_[A-Z0-9_]+$/;
/** The work system's pairing command, as run from its checkout (package.json script). */
export const PAIR_SCRIPT_NAME = 'dedalo:pair-publication-host';
/** The pairing CLI's two slot refusals (scripts/publication_host_pair.ts assertSlot). */
export const ALREADY_REGISTERED = /already registered\. Use `replace`/;
export const TWIN_REGISTERED = /this agent is already registered as '([a-z][a-z0-9_]{1,31})'/;
/** The pairing CLI's exit codes (scripts/publication_host_pair.ts EXIT). */
const PAIR_EXIT = Object.freeze({ ok: 0, usage: 2, refused: 3, failed: 4 });
const TIMEOUT_EXIT = 124;
const MIN_TOKEN_LENGTH = 32;

/* ── detection and the plan (pure) ─────────────────────────────────────────────────── */

export type WorkDetection =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly unit: WorkUnit }
  | { readonly kind: 'several'; readonly units: readonly WorkUnit[] };

/** Spec §6 B5 step 1: `dedalo-ts` or `dedalo-ts@*`; several are a decision; none gives instructions. */
export function detectWorkSystem(work: readonly WorkUnit[]): WorkDetection {
  const units = work.filter(unit => WORK_UNIT_PATTERN.test(unit.unit));
  if (units.length === 0) return { kind: 'none' };
  if (units.length === 1) return { kind: 'one', unit: units[0] as WorkUnit };
  return { kind: 'several', units };
}

/** The pairing child's environment (spec §6 B5 step 2): DEDALO_* of the unit + PATH, HOME, LC_ALL. */
export function pairEnv(unit: WorkUnit, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(unit.env)) {
    if (DEDALO_ENV_KEY.test(key) && !/[\0\r\n]/.test(value)) env[key] = value;
  }
  return { ...env, PATH: PAIR_CHILD_PATH, HOME: home, LC_ALL: 'C' };
}

export interface PairChoice {
  readonly name: string;
  readonly verb: 'add' | 'replace';
  readonly dryRun: boolean;
}

/** The token-free invocation (InitAction `pair`); exec.ts validates every field again. */
export function pairInvocation(unit: WorkUnit, layout: AgentLayout, home: string, choice: PairChoice): Omit<PairInvocation, 'token'> {
  if (!PAIR_NAME_PATTERN.test(choice.name)) throw new Error(`pair: '${choice.name}' must match ${PAIR_NAME_PATTERN.source}`);
  return Object.freeze({
    user: unit.user,
    bun: unit.bun,
    checkout: unit.checkout,
    verb: choice.verb,
    name: choice.name,
    fragment: layout.engineFragmentPath,
    dryRun: choice.dryRun,
    env: Object.freeze(pairEnv(unit, home)),
  });
}

function passwdRow(users: readonly PasswdRow[], name: string): PasswdRow | null {
  return users.find(row => row.name === name) ?? null;
}

/** `user` is in group `group` (primary by gid, or a supplementary member). */
function inGroup(accounts: HostFacts['accounts'], user: PasswdRow, group: string): boolean {
  const row: GroupRow | undefined = accounts.groups.find(g => g.name === group);
  if (row === undefined) return false;
  return row.gid === user.gid || row.members.includes(user.name);
}

/**
 * Spec §6 B5 steps 2-3: every reason this unit cannot be paired with in-process, each sentence
 * carrying its fix. Empty = pairable.
 */
export function pairPreconditions(unit: WorkUnit, layout: AgentLayout, accounts: HostFacts['accounts']): string[] {
  const problems: string[] = [];
  if (unit.user === '' || unit.user === 'root') {
    problems.push(
      `${unit.unit}.service runs as ${unit.user === '' ? 'no named user' : 'root'}: the pairing command runs only as the user that owns the work system's private directory (set User= in the unit)`,
    );
    return problems;
  }
  if (!unit.checkout.startsWith('/')) problems.push(`${unit.unit}.service has no absolute WorkingDirectory: the pairing command runs from the work checkout`);
  if (!unit.bun.startsWith('/')) problems.push(`${unit.unit}.service's ExecStart does not start with an absolute Bun path`);
  const user = passwdRow(accounts.users, unit.user);
  if (user === null) {
    problems.push(`the engine user '${unit.user}' is not in the user database (getent passwd ${unit.user})`);
    return problems;
  }
  if (user.uid === 0) problems.push(`the engine user '${unit.user}' has uid 0; the pairing command refuses root`);
  if (unit.privateUid === null) {
    problems.push(`the work system's private directory ${unit.privateDir} does not exist: start the work system once, then re-run init`);
  } else if (unit.privateUid !== user.uid) {
    problems.push(
      `the work system's private directory ${unit.privateDir} is owned by uid ${unit.privateUid}, not by '${unit.user}': chown -R ${unit.user} ${unit.privateDir}`,
    );
  }
  const engineGroup = layout.identity.engineGroup;
  if (engineGroup !== null && !inGroup(accounts, user, engineGroup)) {
    problems.push(
      `'${unit.user}' is not in engine_group '${engineGroup}', so it cannot open the agent's socket: declare the group the work system runs with (systemctl show -p Group --value ${unit.unit})`,
    );
  }
  if (unit.fragmentPending === null) {
    problems.push(`the engine fragment ${layout.engineFragmentPath} does not exist yet: provision apply writes it`);
  } else if (unit.fragmentPending) {
    problems.push(`the engine fragment ${layout.engineFragmentPath} still holds a pending fingerprint: re-run provision apply ${layout.instance}`);
  }
  return problems;
}

export type PairPlan =
  | { readonly kind: 'instructions'; readonly reason: string; readonly lines: readonly string[] }
  /** Two machines: write the sealed package at `path`; `lines` say what to do with it on the work host. */
  | { readonly kind: 'package'; readonly name: string; readonly path: string; readonly lines: readonly string[]; readonly manual: readonly string[] }
  | { readonly kind: 'blocked'; readonly unit: WorkUnit; readonly problems: readonly string[]; readonly lines: readonly string[] }
  | {
      readonly kind: 'environment_files';
      readonly unit: WorkUnit;
      readonly files: readonly string[];
      readonly invocation: Omit<PairInvocation, 'token'>;
      readonly lines: readonly string[];
    }
  | { readonly kind: 'invoke'; readonly unit: WorkUnit; readonly invocation: Omit<PairInvocation, 'token'> };

export interface PairPlanOptions {
  /**
   * The unit's EnvironmentFiles= per unit name (systemctl show). GAP: WorkUnit (types.ts) does
   * not carry it yet, so the orchestrator passes it here; a unit with any is a decision.
   */
  readonly environmentFiles?: ReadonlyMap<string, readonly string[]>;
  /**
   * The unit chosen among several: draft.ts's `declaration.work_unit` answer (its
   * `completion.workUnit.unit`). Without it, several units block B5 with that decision named.
   */
  readonly chosenUnit?: string;
  /** The operator answered `pair.engine=replace` (the name is already registered): verb `replace`. */
  readonly replace?: boolean;
  /** `<INIT_BASE>/<instance>` (default: the production INIT_BASE): where the sealed package is written. */
  readonly initDir?: string;
}

/* ── the package after the pairing (stale, removed) ───────────────────────────────── */

/** `--decide pair.package=remove` / `=keep`: the written package's decision (writtenPackageItem). */
export const PACKAGE_REMOVE = 'remove';
export const PACKAGE_KEEP = 'keep';

/** Automatic records, not work-host commands: they prove nothing about the pairing (derived, never listed). */
const NOT_ENGINE_ACTIONS: ReadonlySet<string> = new Set(
  Object.entries(AUDIT_ACTION_ORIGIN)
    .filter(([, origin]) => origin === 'agent')
    .map(([action]) => action),
);

/**
 * THE HOST ANSWERS AS PAIRED: the agent's own audit trail (root reads it) records a command after
 * `since` (the journal's `done` of pair.package). The agent audits only what an AUTHENTICATED
 * request asked for — the engine's bearer over its mTLS client certificate, the very credentials
 * the package seals — so such a record means the work host holds them: the package is stale. The
 * pairing's own live proof is read-only and never audited; the first command after it (the panel's
 * or the CLI's apply_rules) is. ISO-8601 UTC timestamps on both sides compare as text.
 */
export function engineContactSince(auditText: string | null, since: string): { readonly action: string; readonly ts: string } | null {
  if (auditText === null) return null;
  for (const line of auditText.split('\n')) {
    let entry: { ts?: unknown; action?: unknown } | null = null;
    try {
      entry = JSON.parse(line) as { ts?: unknown; action?: unknown };
    } catch {
      continue; // a torn or foreign line proves nothing
    }
    if (typeof entry?.ts !== 'string' || typeof entry.action !== 'string' || NOT_ENGINE_ACTIONS.has(entry.action)) continue;
    if (entry.ts > since) return { action: entry.action, ts: entry.ts };
  }
  return null;
}

/**
 * The package an earlier run wrote: gone (removed) → right; stale (`contact`) or the operator asked
 * (`--decide pair.package=remove`) → the decision to remove it, `remove` by default; else right,
 * naming how to remove it once the work host is paired.
 */
export function writtenPackageItem(
  planned: Item,
  path: string,
  state: { readonly present: boolean; readonly contact: { readonly action: string; readonly ts: string } | null; readonly removeAsked: boolean },
): Item {
  const again = `a new one (new passphrase), if a work host must pair again: --decide pair.package=again`;
  if (!state.present) {
    return Object.freeze({ ...planned, list: 'right', title: `the sealed pairing package was written and is gone (${path})`, facts: [again], commands: [], action: undefined });
  }
  if (state.contact === null && !state.removeAsked) {
    return Object.freeze({
      ...planned,
      list: 'right',
      title: `the sealed pairing package was written (${path})`,
      facts: [
        'an earlier run wrote it (journal); the agent has recorded no work-host command since, so the pairing is not proved yet',
        `remove it once the work host is paired: --decide pair.package=${PACKAGE_REMOVE}`,
        again,
      ],
      commands: [],
      action: undefined,
    });
  }
  return Object.freeze({
    ...planned,
    list: 'decision',
    title:
      state.contact === null
        ? `remove the sealed pairing package (${path})`
        : `the sealed pairing package is stale: the work host used its credentials (${state.contact.action} at ${state.contact.ts})`,
    facts: [
      `${path} seals the agent's service token and the engine TLS key; once the work host is paired nothing needs it, and a copy of it is a copy of those secrets`,
      again,
    ],
    commands: [],
    options: [
      { id: PACKAGE_REMOVE, label: `remove ${path}`, resolves: 'act' as const },
      { id: PACKAGE_KEEP, label: 'keep it', resolves: 'skip' as const },
    ],
    defaultOption: PACKAGE_REMOVE,
    action: { kind: 'pair_package_remove' as const, path },
  });
}

/** The file name of the sealed package under `<INIT_BASE>/<instance>/`. */
export const PAIRING_PACKAGE_SUFFIX = '.pairing';
/** Root 0600: written so, and removed (pair.package=remove) only while it still is. */
export const PAIRING_PACKAGE_MODE = 0o600;

export function pairingPackagePath(initDir: string, name: string): string {
  if (!PAIR_NAME_PATTERN.test(name)) throw new Error(`pair: '${name}' must match ${PAIR_NAME_PATTERN.source}`);
  return join(initDir, `${name}${PAIRING_PACKAGE_SUFFIX}`);
}

/** Spec §6 B5: what pairing will do, from the facts alone. */
export function pairPlan(
  layout: AgentLayout,
  facts: Pick<HostFacts, 'work' | 'accounts'>,
  args: Pick<InitArgs, 'pairName' | 'noPair'>,
  options: PairPlanOptions = {},
): PairPlan {
  const detection = detectWorkSystem(facts.work);
  const anyUnit = detection.kind === 'one' ? detection.unit : null;
  const instructions = (reason: string, engine: WorkUnit | null = anyUnit): PairPlan => ({
    kind: 'instructions',
    reason,
    lines: twoMachineInstructions(layout, args.pairName, engine),
  });
  if (args.noPair) return instructions('--no-pair: pairing is printed, not run');
  if (layout.listen.kind === 'tls') {
    const path = pairingPackagePath(options.initDir ?? join(INIT_BASE, layout.instance), args.pairName);
    return { kind: 'package', name: args.pairName, path, lines: packageInstructions(path, args.pairName), manual: twoMachineInstructions(layout, args.pairName, null) };
  }
  if (detection.kind === 'none') return instructions('no Dédalo work unit (dedalo-ts, dedalo-ts@*) runs on this machine', null);
  let unit: WorkUnit;
  if (detection.kind === 'several') {
    const chosen = detection.units.find(u => u.unit === options.chosenUnit);
    if (chosen === undefined) {
      // The choice is draft.ts's `declaration.work_unit` decision (it also fills engine_group);
      // B5 never asks it a second time.
      const first = detection.units[0] as WorkUnit;
      const ids = detection.units.map(u => unitOptionId(u.unit)).join(' | ');
      return {
        kind: 'blocked',
        unit: first,
        problems: [`several Dédalo work units run here and none was chosen: answer --decide declaration.work_unit=<${ids}>`],
        lines: twoMachineInstructions(layout, args.pairName, null),
      };
    }
    unit = chosen;
  } else {
    unit = detection.unit;
  }
  const problems = pairPreconditions(unit, layout, facts.accounts);
  if (problems.length > 0) return { kind: 'blocked', unit, problems, lines: twoMachineInstructions(layout, args.pairName, unit) };
  const home = passwdRow(facts.accounts.users, unit.user)?.home ?? '/nonexistent';
  const invocation = pairInvocation(unit, layout, home, { name: args.pairName, verb: options.replace === true ? 'replace' : 'add', dryRun: false });
  const files = options.environmentFiles?.get(unit.unit) ?? [];
  if (files.length > 0) {
    return { kind: 'environment_files', unit, files, invocation, lines: twoMachineInstructions(layout, args.pairName, unit) };
  }
  return { kind: 'invoke', unit, invocation };
}

/** A stable `--decide` option id for a unit name (`dedalo-ts@museum` → `dedalo-ts_museum`). */
export function unitOptionId(unit: string): string {
  return unit.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
}

const MANUAL: ItemOption = Object.freeze({ id: 'manual', label: 'pair by hand later (the commands are printed)', resolves: 'manual' });

/** The §4.3 item 19 the report shows: `pair.engine` (one machine) or `pair.instructions`. */
export function pairItem(plan: PairPlan, layout: AgentLayout): Item {
  const base = { area: 'pair' as const, after: ['verify.agent'], blocking: false, optional: true, operatorFile: false, hostWide: false };
  switch (plan.kind) {
    case 'instructions':
      return {
        ...base,
        id: 'pair.instructions',
        list: 'decision',
        title: 'pair the agent with the work system (by hand)',
        facts: [plan.reason],
        commands: plan.lines,
        options: [MANUAL],
        defaultOption: 'manual',
      };
    case 'package':
      return {
        ...base,
        id: 'pair.package',
        list: 'change',
        title: `write the sealed pairing package for the work host (${plan.path})`,
        facts: [
          'two machines: the engine fragment, the service token and the engine TLS bundle, sealed in one file (root 0600)',
          'its one-time passphrase is shown ONCE on this terminal, never stored or logged; without a terminal the package is not written',
          'the loose-file pairing (--fragment, --bundle, --token-file) stays available: see the guide',
        ],
        commands: plan.lines,
        action: { kind: 'pair_package', name: plan.name, path: plan.path },
      };
    case 'blocked':
      return {
        ...base,
        id: 'pair.engine',
        list: 'decision',
        title: `pairing through ${plan.unit.unit}.service cannot run yet`,
        facts: plan.problems,
        commands: plan.lines,
        options: [MANUAL],
        defaultOption: 'manual',
      };
    case 'environment_files':
      return {
        ...base,
        id: 'pair.engine',
        list: 'decision',
        title: `${plan.unit.unit}.service reads an EnvironmentFile init never reads`,
        facts: [`EnvironmentFile: ${plan.files.join(', ')}`, 'pairing with the unit\'s Environment= entries only may miss a key the pairing command needs (DEDALO_PRIVATE_DIR)'],
        commands: plan.lines,
        options: [{ id: 'act', label: "pair with the unit's Environment only", resolves: 'act' }, MANUAL],
        action: { kind: 'pair', invocation: plan.invocation },
      };
    case 'invoke':
      return {
        ...base,
        id: 'pair.engine',
        list: 'change',
        title: `pair '${plan.invocation.name}' with the work system as ${plan.invocation.user} (${plan.unit.unit}.service)`,
        facts: [
          `the work system's own pairing command runs as ${plan.invocation.user}, from ${plan.invocation.checkout}; the token reaches it on stdin only`,
          `fragment: ${layout.engineFragmentPath}`,
        ],
        commands: [displayCommand(plan.invocation, layout)],
        action: { kind: 'pair', invocation: plan.invocation },
      };
  }
}

/** The pairing as a reader would type it (never run as shown: exec.ts builds the real argv). */
function displayCommand(invocation: Omit<PairInvocation, 'token'>, layout: AgentLayout): string {
  return (
    `cat ${layout.serviceTokenPath} | setsid --wait runuser -u ${invocation.user} -- ${invocation.bun} --no-install ` +
    `${invocation.checkout}/scripts/publication_host_pair.ts ${invocation.verb} ${invocation.name} --fragment ${invocation.fragment} --token-stdin`
  );
}

/* ── the instructions (pure) ───────────────────────────────────────────────────────── */

/**
 * The guide's step 6 and step 8 commands for this instance (docs/install/publication_host.md),
 * with the engine's real user, checkout and Bun when a work unit is known, placeholders
 * otherwise. Two machines: carry the bundle and the fragment, never `--bundle` on a socket,
 * the token by a 0600 engine-owned `--token-file` or `--token-stdin`, every copy deleted.
 */
export function twoMachineInstructions(layout: AgentLayout, pairName: string, engine: WorkUnit | null): string[] {
  const user = engine?.user ?? '<engine user>';
  const checkout = engine?.checkout ?? '<work checkout>';
  const bun = engine?.bun ?? '<the work system\'s pinned bun>';
  const pair = `cd ${checkout} && sudo -u ${user} ${bun} run ${PAIR_SCRIPT_NAME}`;
  if (layout.listen.kind === 'unix') {
    return [
      '# one machine: run as root or an administrator; the command itself runs as the engine user',
      `sudo cat ${layout.serviceTokenPath} | (${pair} add ${pairName} --fragment ${layout.engineFragmentPath} --token-stdin)`,
      '# never pass --bundle on a socket pairing: the socket group is the access decision',
    ];
  }
  const dir = '<a 0700 directory the engine user owns, outside the checkout>';
  return [
    '# step 6 — on THIS host, as root: carry these two files to the work host over a channel you trust',
    `#   ${layout.engineBundlePath}`,
    `#   ${layout.engineFragmentPath}`,
    `# on the work host, as root: chown ${user} <the two copies> && chmod 600 <the bundle copy>`,
    `# the token: read it here as root (cat ${layout.serviceTokenPath}); carry it as a 0600 file owned by ${user} (--token-file), or pipe it (--token-stdin) — never as an argument`,
    '# step 8 — on the work host, as root or an administrator; the command runs as the engine user:',
    `${pair} add ${pairName} --fragment ${dir}/engine.env.fragment --bundle ${dir}/engine_bundle.pem --token-file ${dir}/token`,
    '# then delete every copy you carried (the token file, the bundle copy, any client.pem / ca.pem); the work system keeps its own',
  ];
}

/** What the operator does with the sealed package (the passphrase itself is shown separately, once). */
export function packageInstructions(path: string, pairName: string): string[] {
  return [
    `# carry ${path} to the work host over a channel you trust (it is encrypted; the passphrase never travels with it)`,
    '# on the work host, as root: put the copy in a directory the engine user owns (install -d -o <engine user> -m 0700 <dir>; never root\'s home, which it cannot pass), then chown <engine user> <the copy> && chmod 600 <the copy>',
    '# then, as root or an administrator (the command runs as the engine user and asks for the passphrase):',
    `cd <work checkout> && sudo -u <engine user> <the work system's pinned bun> run ${PAIR_SCRIPT_NAME} add ${pairName} --package <the copy>`,
    `# then delete both copies: rm ${path} here, the copy on the work host`,
  ];
}

export interface PackagePorts {
  readonly io: Pick<InitIo, 'readRootFile' | 'writeBytesAtomic'>;
  readonly root: { readonly uid: number; readonly gid: number };
  /** randomBytes in production (a gate fixes it). */
  readonly random?: (n: number) => Uint8Array;
}

export type PackageOutcome =
  | { readonly kind: 'done'; readonly path: string; readonly passphrase: string }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * Seals the three pairing parts into `path` (root 0600, written atomically) and returns the
 * passphrase for the caller to show ONCE. The parts are read as root here and never returned;
 * the passphrase is returned only on success, and never reaches a reason string.
 */
export function writePairingPackage(layout: AgentLayout, path: string, ports: PackagePorts): PackageOutcome {
  const fragment = ports.io.readRootFile(layout.engineFragmentPath);
  if (fragment === null) return { kind: 'failed', reason: `the engine fragment ${layout.engineFragmentPath} does not exist: run provision apply ${layout.instance}` };
  if (fragment.includes(FINGERPRINT_PENDING)) {
    return { kind: 'failed', reason: `the engine fragment ${layout.engineFragmentPath} still holds a pending fingerprint: re-run provision apply ${layout.instance}` };
  }
  const token = ports.io.readRootFile(layout.serviceTokenPath)?.trim() ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    return { kind: 'failed', reason: `the service token at ${layout.serviceTokenPath} is missing or short: run provision apply ${layout.instance}` };
  }
  const bundle = ports.io.readRootFile(layout.engineBundlePath);
  if (bundle === null || bundle.trim() === '') {
    return { kind: 'failed', reason: `the engine bundle ${layout.engineBundlePath} does not exist: run provision apply ${layout.instance}` };
  }
  const passphrase = newPassphrase(ports.random);
  let sealed: Uint8Array;
  try {
    sealed = sealPairingPackage({ fragment, token, bundle }, passphrase, ports.random);
  } catch (error) {
    if (error instanceof PairingPackageRefused) return { kind: 'failed', reason: error.message };
    throw error;
  }
  ports.io.writeBytesAtomic(path, sealed, PAIRING_PACKAGE_MODE, ports.root.uid, ports.root.gid);
  return { kind: 'done', path, passphrase };
}

/* ── running it (I/O through the injected exec) ────────────────────────────────────── */

export interface PairPorts {
  readonly exec: Pick<InitExec, 'pairAsEngine'>;
  readonly io: Pick<InitIo, 'readRootFile'>;
  /** report.ts sanitizeLine in production: strips C0/C1 controls and ESC sequences. */
  readonly sanitize: (line: string) => string;
}

export type PairOutcome =
  | { readonly kind: 'done'; readonly lines: readonly string[] }
  /** `add` met an existing name: the operator chooses replace / skip / manual. */
  | { readonly kind: 'decision'; readonly id: 'replace'; readonly options: readonly ItemOption[]; readonly lines: readonly string[] }
  /** The same agent is registered under another name: manual (remove it, then add) / skip. */
  | {
      readonly kind: 'decision';
      readonly id: 'twin';
      readonly twin: string;
      readonly options: readonly ItemOption[];
      readonly commands: readonly string[];
      readonly lines: readonly string[];
    }
  | { readonly kind: 'refused'; readonly lines: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string; readonly lines: readonly string[] };

/** The child's output, sanitized, the token replaced, empty lines dropped. */
function childLines(stdout: string, stderr: string, token: string, sanitize: (line: string) => string): string[] {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map(line => sanitize(token.length > 0 ? line.split(token).join('[token]') : line))
    .filter(line => line.trim().length > 0);
}

/**
 * Spec §6 B5 steps 4-5: the dry run, then the real pairing (`dryRunOnly` stops after the
 * proof). Exit 0 done; 3 "already registered. Use `replace`" → decision replace/skip/manual;
 * 3 "this agent is already registered as '<twin>'" → decision manual/skip; any other 3 →
 * refused; 4 → failed "safe to re-run"; a timeout → failed.
 */
export function pairOneMachine(
  invocation: Omit<PairInvocation, 'token'>,
  layout: AgentLayout,
  ports: PairPorts,
  options: { readonly dryRunOnly?: boolean } = {},
): PairOutcome {
  const token = ports.io.readRootFile(layout.serviceTokenPath)?.trim() ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    return { kind: 'failed', reason: `the service token at ${layout.serviceTokenPath} is missing or short: run provision apply ${layout.instance}`, lines: [] };
  }
  const collected: string[] = [];
  for (const dryRun of options.dryRunOnly === true ? [true] : [true, false]) {
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = ports.exec.pairAsEngine({ ...invocation, dryRun, token });
    } catch (error) {
      // exec.ts validation: its messages never carry the token (exec: …).
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'refused', lines: [...collected, ...childLines(message, '', token, ports.sanitize)] };
    }
    const lines = childLines(result.stdout, result.stderr, token, ports.sanitize);
    collected.push(...lines);
    if (result.code === PAIR_EXIT.ok) continue;
    const text = lines.join('\n');
    if (result.code === PAIR_EXIT.refused) {
      if (ALREADY_REGISTERED.test(text)) {
        return {
          kind: 'decision',
          id: 'replace',
          options: [
            { id: 'replace', label: `re-pair '${invocation.name}' (replace keeps its public URL, qualities and probe files)`, resolves: 'replace' },
            { id: 'skip', label: 'leave the existing registration', resolves: 'skip' },
            MANUAL,
          ],
          lines: collected,
        };
      }
      const twin = TWIN_REGISTERED.exec(text)?.[1];
      if (twin !== undefined) {
        const pairCmd = `cd ${invocation.checkout} && sudo -u ${invocation.user} ${invocation.bun} run ${PAIR_SCRIPT_NAME}`;
        return {
          kind: 'decision',
          id: 'twin',
          twin,
          options: [MANUAL, { id: 'skip', label: `keep it registered as '${twin}'`, resolves: 'skip' }],
          commands: [
            `${pairCmd} remove ${twin}`,
            `sudo cat ${layout.serviceTokenPath} | (${pairCmd} add ${invocation.name} --fragment ${invocation.fragment} --token-stdin)`,
          ],
          lines: collected,
        };
      }
      return { kind: 'refused', lines: collected };
    }
    if (result.code === TIMEOUT_EXIT) {
      return { kind: 'failed', reason: 'the pairing command did not finish in time (killed after 120 s); safe to re-run', lines: collected };
    }
    if (result.code === PAIR_EXIT.failed) {
      return { kind: 'failed', reason: `the pairing command failed (exit 4)${dryRun ? ' during its dry run' : ''}; safe to re-run`, lines: collected };
    }
    return { kind: 'failed', reason: `the pairing command ended with exit ${result.code}; safe to re-run`, lines: collected };
  }
  return { kind: 'done', lines: collected };
}

/* ── the act-port adapter ──────────────────────────────────────────────────────────── */

/** act.ts ActPorts.pair's result shape (structural: this file does not import act.ts). */
export interface PairPortResult {
  readonly outcome: 'done' | 'noop' | 'failed' | 'refused';
  readonly reason?: string;
}

/**
 * A PairOutcome as the act loop records it. A decision the child surfaced (replace, twin) is
 * `refused` naming its options: init never re-pairs or removes a registration without the
 * operator's answer.
 */
export function pairPortResult(outcome: PairOutcome): PairPortResult {
  switch (outcome.kind) {
    case 'done':
      return { outcome: 'done' };
    case 'failed':
      return { outcome: 'failed', reason: outcome.reason };
    case 'refused':
      return { outcome: 'refused', reason: outcome.lines.at(-1) ?? 'the pairing command refused' };
    case 'decision':
      return outcome.id === 'replace'
        ? { outcome: 'refused', reason: 'this name is already registered: answer replace, skip or manual (re-run with --decide pair.engine=replace)' }
        : { outcome: 'refused', reason: `this agent is already registered as '${outcome.twin}': ${outcome.commands.join(' ; then ')}` };
  }
}
