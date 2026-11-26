/**
 * ACT (spec §5, §7) — `executeItems(items, ctx)` runs the confirmed items, in the order compare
 * gave them (§4.3, dependency order), under the instance lock the caller holds, with one
 * journal. Each action records `begin` BEFORE it acts and `done`, `noop`, `failed` or
 * `rolled_back` after; the first failure stops the run (later items are `not reached`).
 *
 *   - IDEMPOTENT: just before acting, the single fact the action changes is re-observed; when it
 *     is already right the record is `noop` and nothing is touched.
 *   - DECIDES NOTHING: an item that is still a `decision` (or a `right` one) never reaches an
 *     action here — `--yes`, a typed answer, `--decide` are run.ts's; an unresolved decision
 *     handed to act is REFUSED before anything runs (the second wall behind the report).
 *   - ACCOUNTS (§5.1) and SELinux BOOLEANS (§5.3) are created/set ONLY here: this file is the one
 *     caller of the InitExec creators and of setsebool (tests/init_account_door.test.ts).
 *   - SECRETS (§5.8): the API configs are rendered from the templates with values typed before
 *     the first `begin` (ctx.secrets), written root 0600 temp → chown → chmod → rename, and
 *     journaled as `{exists, uid, gid, mode}` only — journal_format.ts refuses anything else.
 *   - OPERATOR FILES (§5.10): act re-reads the vhost (realpath, then the bytes) and refuses when
 *     its sha is not the one shown (TOCTOU); it computes `after` HERE with web_edit.ts's pure
 *     edits (ctx.ports.webEdit) from those re-read bytes, then hands the transaction (backup,
 *     write, configtest, reload, rollback — under the host web lock) to web_txn (ctx.ports).
 *
 * `resumeOpen(open, ctx)` (§7 `--resume`) closes the `begin` records an earlier run left open:
 * code trees restored, operator files settled by their sha (configtest+reload, or restore),
 * temps removed, the rest left to the re-run (every action is idempotent; correctness never
 * depends on the journal).
 *
 * The packages this one calls but does not own come in as ctx.ports (typed here, wired by
 * run.ts at integration): P5's Bun install, P6's operator-file transaction and map seed and
 * web_edit.ts, P7's B4/B5, cli.ts's in-process `apply`.
 */
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parseEnvFile } from '../../env_file';
import type { InitExec, ProvisionExec, RestoreconTarget } from '../exec_contract';
import { NOLOGIN_SHELLS, SELINUX_READ_ONLY_BOOLEANS } from '../exec_contract';
import type { AgentLayout, HostDeclaration, WebServer } from '../layout';
import { ABSOLUTE_PATH_PATTERN, canonicalDeclaration, HOME_ROOT_MODE, MODES } from '../layout';
import type { LockHandle } from '../lock';
import type { PathFacts, PinExpectation } from '../plan';
import type { V1Values, V2Values } from './api_config';
import { ApiConfigRefused, renderV1Config, renderV2Env, verifyV2RoundTrip } from './api_config';
import { KEPT_DIR_NAME, RERUN_ENV_NAME, STAGE_DIR_NAME } from './constants';
import { ensureDir, initTempPath, INIT_TEMP_SUFFIX } from './host_io';
import { PAIRING_PACKAGE_MODE } from './pair';
import { packageHeaderProblem } from '../pairing_package';
import type { Journal } from './journal';
import { JournalFormatError } from './journal_format';
import type { TreeReader, TreeWriter } from './tree_copy';
import { commitTree, installTree, newPathOf, prevPathOf, restoreTree, treeDigest } from './tree_copy';
import type { InitAction, InitIo, Item, JournalRecord, PairInvocation, SelinuxMode } from './types';

/* ── the ports (other packages' modules, wired at integration) ───────────────────────── */

/** web_edit.ts (P6) — the day-0 signatures (spec §2.1): pure text edits, idempotent, CRLF-preserving. */
export interface WebEdit {
  insertApacheReference(text: string, instance: string, includePath: string, atLine?: number): string;
  insertNginxReference(text: string, instance: string, includePath: string, atLine?: number): string;
  removeManualLines(text: string, lines: readonly number[]): string;
}

/** What act hands the operator-file transaction (web_txn.editOperatorFile, P6, spec §5.10). */
export interface OperatorEditRequest {
  readonly item: string;
  /** The realpath act re-read. */
  readonly target: string;
  readonly beforeSha: string;
  readonly after: Uint8Array;
  readonly afterSha: string;
  readonly server: WebServer;
  /** `<INIT_BASE>/<instance>/backup/<seq>-<basename>` (0600), chosen by act and journaled. */
  readonly backup: string;
  /** Debian: the modules to a2enmod inside the same transaction (the ones absent before). */
  readonly mods: readonly string[];
}

export interface TxnResult {
  readonly outcome: 'done' | 'rolled_back' | 'failed';
  /** One of OUR sentences (never file content). */
  readonly reason?: string;
  readonly exit1?: number;
  readonly exit2?: number;
  readonly modsEnabled?: readonly string[];
}

/** The hand-map migration (nginx_map_seed, spec §5.10), one transaction under the host web lock. */
export interface MapSeedRequest {
  readonly item: string;
  readonly target: string;
  readonly beforeSha: string;
  readonly standalone: boolean;
  readonly backup: string;
  /** The files the seed creates (removed again on failure / by resume). */
  readonly seeded: readonly string[];
}

export interface PortResult {
  readonly outcome: 'done' | 'noop' | 'failed' | 'refused';
  readonly reason?: string;
}

export interface BunInstallRequest {
  readonly archive: string;
  readonly sums: string | null;
  readonly asset: string;
  readonly pin: string;
  readonly table: string;
  readonly target: string;
}

export interface ActPorts {
  readonly webEdit: WebEdit;
  /** web_txn.editOperatorFile (P6). */
  editOperatorFile(request: OperatorEditRequest): TxnResult;
  /** The nginx_map_seed transaction (P6 web_txn + P8 renderHostMap). */
  seedNginxMap(request: MapSeedRequest): TxnResult;
  /** bun_install.ts installBun (P5): verify, unzip, version, atomic write. */
  installBun(request: BunInstallRequest): PortResult;
  /** cli.ts `run(['apply', instance], {deps, out, err, lockHeld})`: its exit code. */
  runApply(instance: string): number;
  /** parseDeclaration + declarationTrustProblems + siblingProblems of the body about to be written. */
  declarationProblems(body: string): readonly string[];
  /** verify.ts verifyAgent (P7, B4). */
  verifyAgent(): PortResult;
  /** pair.ts (P7, B5): the invocation plus the token it reads itself. */
  pair(invocation: Omit<PairInvocation, 'token'>): PortResult;
  /**
   * pair.ts writePairingPackage (B5, two machines): seals and writes the package, then shows its
   * passphrase ONCE on the terminal. The result never carries the passphrase (it is journaled).
   */
  pairPackage(action: Extract<InitAction, { kind: 'pair_package' }>): PortResult;
}

/* ── the context ──────────────────────────────────────────────────────────────────── */

export interface ActContext {
  readonly instance: string;
  /** The final declaration's layout. */
  readonly layout: AgentLayout;
  /** `<INIT_BASE>/<instance>` (the lock directory: root's own, proven by the instance lock). */
  readonly initDir: string;
  readonly io: InitIo;
  readonly exec: ProvisionExec & InitExec;
  readonly journal: Journal;
  /** lstat, never following a link (production: host_io.ts lstatFacts; the FakeHost's own in tests). */
  readonly lstat: (path: string) => PathFacts | null;
  /** realpath, or null (an operator file is edited at its realpath only). */
  readonly realpath: (path: string) => string | null;
  /** The filesystem type holding a path (parse/mounts.ts fsTypeOf over /proc/self/mountinfo). */
  readonly fsTypeOf: (path: string) => string | null;
  readonly tree: { readonly reader: TreeReader; readonly writer: TreeWriter };
  /** The host web lock (lock.ts acquireHostLockSync('web', …)): held around every configtest+reload act runs itself. */
  readonly webLock: () => LockHandle;
  readonly selinux: {
    readonly mode: SelinuxMode;
    /** selinux.ts REMOVABLE_SELINUX_TYPES (P6): the closed type set a `-d` import line may name (ours and the retired). */
    readonly types: readonly string[];
    /** The `A(/.*)?` rule is already registered (a re-run): restorecon the new agent tree after the swap. */
    readonly agentRuleRegistered: boolean;
  };
  /** The OS row's package family: a2enmod/a2dismod are Debian-only. */
  readonly family: 'debian' | 'el';
  /** Typed BEFORE the first begin (spec §1.2 TTY); absent = nothing typed (no TTY, or aborted). */
  readonly secrets: { readonly v2?: V2Values; readonly v1?: V1Values };
  /** Who "root" is for what act creates (0:0 in production; a scratch gate's own ids). */
  readonly root?: { readonly uid: number; readonly gid: number };
  readonly ports: ActPorts;
  readonly sleepSync: (ms: number) => void;
}

/* ── the report ───────────────────────────────────────────────────────────────────── */

export type ActStatus = 'done' | 'noop' | 'failed' | 'rolled_back' | 'refused' | 'not_reached';

export interface ActOutcome {
  readonly item: string;
  readonly status: ActStatus;
  /** One line. Never a secret, never file content. */
  readonly detail: string;
}

export interface ActReport {
  readonly ok: boolean;
  /** 0 ok, 3 refused, 4 failed (cli.ts EXIT). */
  readonly exit: 0 | 3 | 4;
  readonly outcomes: readonly ActOutcome[];
  /** Commands the operator may run to undo what stayed changed (home.root, booleans), printed under "still to do". */
  readonly stillToDo: readonly string[];
}

const EXIT_OK = 0;
const EXIT_REFUSED = 3;
const EXIT_FAILED = 4;

/** The active poll after a restart or reload (spec §5.7, §5.9: 5 s). */
export const ACTIVE_POLL = Object.freeze({ tries: 10, intervalMs: 500 });
/** The filesystems a home may not be given to root on (spec S6). */
export const NETWORK_FILESYSTEMS: readonly string[] = Object.freeze(['nfs', 'nfs4', 'cifs', 'smb3', 'autofs']);
export const BACKUP_DIR_NAME = 'backup';
/** rerun.env's two lines (install.sh step 2 reads them back with these exact patterns). */
export const RERUN_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

/** A refusal (exit 3) or a failure (exit 4), with its one line and the journal detail. */
class StepError extends Error {
  readonly refused: boolean;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly rolledBack: boolean;
  constructor(message: string, options: { refused?: boolean; detail?: Record<string, unknown>; rolledBack?: boolean } = {}) {
    super(message);
    this.name = 'StepError';
    this.refused = options.refused ?? false;
    this.detail = options.detail ?? {};
    this.rolledBack = options.rolledBack ?? false;
  }
}

interface StepDone {
  readonly outcome: 'done' | 'noop';
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly line?: string;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function firstLine(text: string): string {
  return (text.split('\n').find(line => line.trim() !== '') ?? '').slice(0, 200);
}

function rootIds(ctx: ActContext): { uid: number; gid: number } {
  return ctx.root ?? { uid: 0, gid: 0 };
}

function octal(mode: number): string {
  return `0${(mode & 0o7777).toString(8)}`;
}

function isNetworkFs(type: string | null): boolean {
  return type !== null && (NETWORK_FILESYSTEMS.includes(type) || type.startsWith('fuse.'));
}

/* ── accounts (§5.1) — the ONLY caller of the creators ───────────────────────────── */

/** The first real file among the nologin shells (spec §5.1). */
function nologinShell(ctx: ActContext): string {
  const shell = NOLOGIN_SHELLS.find(path => ctx.lstat(path)?.type === 'file');
  if (shell === undefined) throw new StepError(`no nologin shell on this host (${NOLOGIN_SHELLS.join(', ')})`);
  return shell;
}

/** exit 0 = present, 2 = absent (getent); anything else is unknown and stops the run. */
function lookup(result: { code: number }, what: string, name: string): boolean {
  if (result.code === 0) return true;
  if (result.code === 2) return false;
  throw new StepError(`getent ${what} ${name} exited ${result.code}: cannot tell whether it exists`);
}

function createAccount(
  ctx: ActContext,
  kind: 'group' | 'user',
  name: string,
  create: () => { code: number; stderr: string; stdout: string },
): StepDone {
  const exists = () =>
    kind === 'group' ? lookup(ctx.exec.groupLookup(name), 'group', name) : lookup(ctx.exec.passwdLookup(name), 'passwd', name);
  if (exists()) return { outcome: 'noop', detail: { name } };
  const result = create();
  if (result.code === 0) return { outcome: 'done', detail: { name } };
  // useradd 9 (name in use) / 4 (uid in use): another process raced us — re-observe.
  if ((result.code === 9 || result.code === 4) && exists()) return { outcome: 'noop', detail: { name, exit: result.code } };
  throw new StepError(`${kind === 'group' ? 'groupadd' : 'useradd'} ${name} exited ${result.code}: ${firstLine(result.stderr) || firstLine(result.stdout) || 'no output'}`, {
    detail: { name, exit: result.code },
  });
}

/* ── paths (§5.2) ─────────────────────────────────────────────────────────────────── */

/** The one item that gives a directory init did not create to root (decision B): its target metadata is fixed. */
export const HOME_ROOT_ITEM = 'home.root';

function pathMeta(ctx: ActContext, item: Item, action: Extract<InitAction, { kind: 'path_meta' }>): StepDone {
  if (item.id === HOME_ROOT_ITEM) {
    const { uid, gid } = rootIds(ctx);
    if (action.uid !== uid || action.gid !== gid || action.mode !== HOME_ROOT_MODE || ctx.layout.site?.home !== action.path) {
      throw new StepError(`home.root must make the site home ${ctx.layout.site?.home ?? '(none: no site)'} root:root ${octal(HOME_ROOT_MODE)}, nothing else`, { refused: true });
    }
  }
  const facts = ctx.lstat(action.path);
  if (facts === null) throw new StepError(`'${action.path}' does not exist`);
  if (facts.type === 'symlink') throw new StepError(`'${action.path}' is a symbolic link — never given to root`, { refused: true });
  // The API config files (compare.ts api_config.*: a file in the state tree's `shared/`) are the one
  // file this step fixes, and only through the pinned parent (sharedPin); every other target is a directory.
  const pin = sharedPin(ctx, action.path);
  const fileAllowed = item.id.startsWith('api_config.') && pin !== undefined;
  if (facts.type !== 'dir' && !(fileAllowed && facts.type === 'file')) {
    throw new StepError(`'${action.path}' is a ${facts.type}, not a directory`, { refused: true });
  }
  const parent = dirname(action.path);
  const parentFacts = ctx.lstat(parent);
  if (parentFacts?.type !== 'dir' || (parentFacts.uid !== 0 && parentFacts.uid !== rootIds(ctx).uid) || (parentFacts.mode & 0o002) !== 0) {
    throw new StepError(`'${parent}' is not a root-owned directory others cannot write; '${action.path}' cannot be given to root`, { refused: true });
  }
  const fs = ctx.fsTypeOf(action.path);
  if (isNetworkFs(fs)) throw new StepError(`'${action.path}' is on a network filesystem (${fs}); it cannot be given to root`, { refused: true });
  const previous = { uid: facts.uid, gid: facts.gid, mode: facts.mode };
  if (facts.uid === action.uid && facts.gid === action.gid && facts.mode === action.mode) {
    return { outcome: 'noop', detail: { path: action.path, previous } };
  }
  ctx.io.chown(action.path, action.uid, action.gid, pin);
  ctx.io.chmod(action.path, action.mode, pin);
  return { outcome: 'done', detail: { path: action.path, uid: action.uid, gid: action.gid, mode: action.mode, previous } };
}

/**
 * What the state tree's `shared/` must be when init writes in it (security review S3-1): its
 * grandparent `publication_api/<api>/` is the agent's, so the door pins `shared/` and refuses any
 * directory but this one — the MODES row exactly (v1Shared root:root, v2Shared root:<v2 group>).
 * Undefined for a path whose parent is not one of the two (or while the v2 group has no id).
 */
export function sharedPin(ctx: Pick<ActContext, 'layout' | 'exec' | 'root'>, path: string): PinExpectation | undefined {
  const parent = dirname(path);
  const { uid, gid: rootGid } = ctx.root ?? { uid: 0, gid: 0 };
  if (ctx.layout.v1 !== null && parent === ctx.layout.v1.dirs.shared) return { parent, uid, gid: rootGid, mode: MODES.v1Shared.mode };
  if (parent !== ctx.layout.state.apis.v2.shared) return undefined;
  const gid = ctx.exec.groupId(ctx.layout.identity.v2Group);
  // No group, no expectation: a door that must pin the parent then refuses, naming it.
  if (gid === null) return undefined;
  return { parent, uid, gid, mode: MODES.v2Shared.mode };
}

function mkdirStep(ctx: ActContext, action: Extract<InitAction, { kind: 'mkdir' }>): StepDone {
  const facts = ctx.lstat(action.path);
  if (facts !== null) {
    if (facts.type === 'dir' && facts.uid === action.uid && facts.gid === action.gid && facts.mode === action.mode) {
      return { outcome: 'noop', detail: { path: action.path } };
    }
    // Never chown an existing directory (spec §5.2, §5.4): it is reported, the operator decides.
    throw new StepError(
      `'${action.path}' exists as a ${facts.type} owned by ${facts.uid}:${facts.gid} mode ${octal(facts.mode)}, not ${action.uid}:${action.gid} ${octal(action.mode)} — never changed by init`,
      { refused: true },
    );
  }
  ctx.io.mkdir(action.path, action.mode);
  ctx.io.chown(action.path, action.uid, action.gid);
  ctx.io.chmod(action.path, action.mode);
  return { outcome: 'done', detail: { path: action.path, uid: action.uid, gid: action.gid, mode: action.mode } };
}

/* ── SELinux (§5.2 relocation, §5.3 booleans) ──────────────────────────────────────── */

/** `getsebool <name>` → its value, or null when unreadable. */
export function readSebool(exec: ProvisionExec, name: string): boolean | null {
  const result = exec.getsebool(name);
  if (result.code !== 0) return null;
  const match = /^(\S+)\s+-->\s+(on|off)\s*$/.exec(result.stdout.trim());
  if (match === null || match[1] !== name) return null;
  return match[2] === 'on';
}

function seboolStep(ctx: ActContext, action: Extract<InitAction, { kind: 'sebool' }>): StepDone {
  if ((SELINUX_READ_ONLY_BOOLEANS as readonly string[]).includes(action.name)) {
    throw new StepError(`'${action.name}' is read, never written`, { refused: true });
  }
  const current = readSebool(ctx.exec, action.name);
  if (current === null) throw new StepError(`getsebool ${action.name} gave no value`);
  if (current === action.value) return { outcome: 'noop', detail: { name: action.name, value: action.value, previous: current } };
  const result = ctx.exec.setsebool(action.name, action.value);
  if (result.code !== 0) {
    throw new StepError(`setsebool -P ${action.name} ${action.value ? 'on' : 'off'} exited ${result.code}`, {
      detail: { name: action.name, exit: result.code, previous: current },
    });
  }
  if (readSebool(ctx.exec, action.name) !== action.value) throw new StepError(`${action.name} does not read back as set`);
  return { outcome: 'done', detail: { name: action.name, value: action.value, previous: current } };
}

/** `fcontext -d` needs the rule's file type: `(/.*)?` rules are `a`, the bin_t rows `f`, the other exact rows `d` (spec S9 table). */
export function relocationFileType(rule: { readonly spec: string; readonly type: string }): 'a' | 'f' | 'd' {
  if (rule.spec.endsWith('(/.*)?')) return 'a';
  return rule.type === 'bin_t' ? 'f' : 'd';
}

/** The path a spec labels (`\.` unescaped, `(/.*)?` stripped). */
export function specPath(spec: string): { path: string; recursive: boolean } {
  const recursive = spec.endsWith('(/.*)?');
  const path = (recursive ? spec.slice(0, -'(/.*)?'.length) : spec).replace(/\\\./g, '.');
  return { path, recursive };
}

/** The `-d` import lines, each held to the closed grammar (spec §5.9) before anything is written. */
export function relocationLines(remove: readonly { readonly spec: string; readonly type: string }[], types: readonly string[]): string[] {
  return remove.map(rule => {
    if (!types.includes(rule.type)) throw new StepError(`fcontext type '${rule.type}' is not one of ours (${types.join(', ')})`, { refused: true });
    const { path } = specPath(rule.spec);
    if (!ABSOLUTE_PATH_PATTERN.test(path) || path.split('/').includes('..') || !/^\/[A-Za-z0-9_/\\.()?*-]+$/.test(rule.spec)) {
      throw new StepError(`fcontext spec '${rule.spec}' is outside the label grammar`, { refused: true });
    }
    if (['/', '/home', '/srv', '/var/www'].includes(path)) throw new StepError(`refusing a rule on '${path}'`, { refused: true });
    return `fcontext -d -f ${relocationFileType(rule)} -t ${rule.type} '${rule.spec}'`;
  });
}

function fcontextRelocate(ctx: ActContext, action: Extract<InitAction, { kind: 'fcontext_relocate' }>): StepDone {
  if (ctx.selinux.mode === 'absent' || action.remove.length === 0) return { outcome: 'noop', detail: { remove: action.remove } };
  const lines = relocationLines(action.remove, ctx.selinux.types);
  const owner = rootIds(ctx);
  ensureDir(ctx.io, ctx.layout.configBase, MODES.configBase.mode, owner.uid, owner.gid, ctx.lstat);
  ensureDir(ctx.io, ctx.layout.instanceDir, MODES.instanceDir.mode, owner.uid, owner.gid, ctx.lstat);
  const temp = ctx.io.writeTemp(join(ctx.layout.instanceDir, 'selinux.import'), `${lines.join('\n')}\n`, 0o600);
  try {
    const { uid, gid } = rootIds(ctx);
    ctx.io.chown(temp, uid, gid);
    ctx.io.chmod(temp, 0o600);
    const result = ctx.exec.semanageImport(temp);
    if (result.code !== 0) throw new StepError(`semanage import exited ${result.code}: ${firstLine(result.stderr) || 'no output'}`, { detail: { exit: result.code, remove: action.remove } });
  } finally {
    ctx.io.removeTemp(temp);
  }
  if (ctx.selinux.mode === 'permissive' || ctx.selinux.mode === 'enforcing') {
    const targets: RestoreconTarget[] = action.remove.map(rule => specPath(rule.spec)).filter(t => ctx.lstat(t.path) !== null);
    for (let i = 0; i < targets.length; i += 16) {
      const result = ctx.exec.restorecon(targets.slice(i, i + 16), false);
      if (result.code !== 0) throw new StepError(`restorecon exited ${result.code} on the previous layout's paths`, { detail: { exit: result.code, remove: action.remove } });
    }
  }
  return { outcome: 'done', detail: { remove: action.remove } };
}

/* ── Bun and code (§5.4, §5.5) ────────────────────────────────────────────────────── */

function bunVersionOf(ctx: ActContext, bin: string): string | null {
  if (ctx.lstat(bin)?.type !== 'file') return null;
  const result = ctx.exec.bunVersion(bin);
  return result.code === 0 ? result.stdout.trim().replace(/^v/, '') : null;
}

function bunInstall(ctx: ActContext, action: Extract<InitAction, { kind: 'bun_install' }>): StepDone {
  const detail = { archive: action.archive, asset: action.asset, pin: action.pin, path: action.target };
  if (bunVersionOf(ctx, action.target) === action.pin) return { outcome: 'noop', detail };
  const result = ctx.ports.installBun(action);
  if (result.outcome === 'refused') throw new StepError(result.reason ?? 'the Bun archive was refused', { refused: true, detail });
  if (result.outcome === 'failed') throw new StepError(result.reason ?? 'the Bun install failed', { detail });
  const version = bunVersionOf(ctx, action.target);
  if (version !== action.pin) throw new StepError(`'${action.target}' --version is ${version ?? 'unreadable'}, not the pin ${action.pin}`, { detail });
  return { outcome: 'done', detail };
}

function digestOrNull(ctx: ActContext, dir: string): string | null {
  if (ctx.lstat(dir)?.type !== 'dir') return null;
  try {
    return treeDigest(dir, ctx.tree.reader);
  } catch {
    return null; // not a code tree as it stands: it is replaced
  }
}

/* ── the declaration (§5.6) ───────────────────────────────────────────────────────── */

function writeDeclaration(ctx: ActContext, action: Extract<InitAction, { kind: 'write_declaration' }>): StepDone {
  const path = ctx.layout.declarationPath;
  // ONE body writer (spec §2.2): what lands on disk is canonicalDeclaration's bytes, never another serialisation.
  let canonical: string | null = null;
  try {
    canonical = canonicalDeclaration(JSON.parse(action.body) as HostDeclaration);
  } catch {
    canonical = null;
  }
  if (canonical !== action.body) throw new StepError('the declaration body is not canonicalDeclaration() output', { refused: true, detail: { path } });
  const problems = ctx.ports.declarationProblems(action.body);
  if (problems.length > 0) throw new StepError(`the declaration would not validate: ${problems[0]}`, { refused: true, detail: { path } });
  const existing = ctx.io.readRootFile(path);
  if (existing === action.body) return { outcome: 'noop', detail: { path, sha: sha256(action.body) } };
  const { uid, gid } = rootIds(ctx);
  ensureDir(ctx.io, ctx.layout.configBase, MODES.configBase.mode, uid, gid, ctx.lstat);
  ctx.io.writeBytesAtomic(path, new TextEncoder().encode(action.body), 0o644, uid, gid);
  return { outcome: 'done', detail: { path, sha: sha256(action.body), hadPrevious: existing !== null } };
}

/* ── units (§5.7) ─────────────────────────────────────────────────────────────────── */

function pollActive(ctx: ActContext, unit: string): boolean {
  for (let attempt = 0; attempt < ACTIVE_POLL.tries; attempt += 1) {
    if (ctx.exec.unitState(unit).active) return true;
    if (attempt < ACTIVE_POLL.tries - 1) ctx.sleepSync(ACTIVE_POLL.intervalMs);
  }
  return false;
}

function restartUnits(ctx: ActContext, units: readonly string[]): StepDone {
  for (const unit of units) {
    const result = ctx.exec.restartUnit(unit);
    if (result.code !== 0) throw new StepError(`systemctl restart ${unit} exited ${result.code}; see journalctl -u ${unit} --since -2min -o cat`, { detail: { unit, exit: result.code } });
    if (!pollActive(ctx, unit)) throw new StepError(`${unit} is not active after its restart; see journalctl -u ${unit} --since -2min -o cat`, { detail: { unit } });
  }
  return { outcome: 'done', detail: { units } };
}

/* ── API config (§5.8) ────────────────────────────────────────────────────────────── */

function secretMeta(ctx: ActContext, path: string): Record<string, unknown> {
  const facts = ctx.lstat(path);
  return facts === null ? { path, exists: false } : { path, exists: true, uid: facts.uid, gid: facts.gid, mode: facts.mode };
}

function templateText(ctx: ActContext, path: string): string {
  const text = ctx.io.readRootFile(path);
  if (text === null) throw new StepError(`the template '${path}' cannot be read — re-run deploy/install.sh with --source`);
  return text;
}

function apiConfig(ctx: ActContext, action: Extract<InitAction, { kind: 'v2_env' | 'v1_config' }>): StepDone {
  // An existing file is never overwritten (spec §4.3 item 11: replacing it is a decision).
  if (ctx.lstat(action.path) !== null) return { outcome: 'noop', detail: secretMeta(ctx, action.path) };
  const template = templateText(ctx, action.sample);
  let bytes: Uint8Array;
  let uid: number;
  let gid: number;
  try {
    if (action.kind === 'v2_env') {
      const typed = ctx.secrets.v2;
      if (typed === undefined) throw new StepError('no database values were typed for v2.env (a secret step needs a terminal)', { refused: true, detail: { path: action.path, exists: false } });
      const values = { ...typed, deploymentMode: action.deploymentMode };
      const rendered = renderV2Env(template, values);
      verifyV2RoundTrip(rendered, values, parseEnvFile);
      bytes = new TextEncoder().encode(rendered);
      const groupId = ctx.exec.groupId(ctx.layout.identity.v2Group);
      if (groupId === null) throw new StepError(`group '${ctx.layout.identity.v2Group}' has no id on this host`);
      uid = rootIds(ctx).uid;
      gid = groupId;
    } else {
      const typed = ctx.secrets.v1;
      if (typed === undefined) throw new StepError('no database values were typed for the v1 configuration (a secret step needs a terminal)', { refused: true, detail: { path: action.path, exists: false } });
      bytes = new TextEncoder().encode(renderV1Config(template, { ...typed, transport: action.transport }));
      const userId = ctx.exec.userId(action.owner);
      if (userId === null) throw new StepError(`user '${action.owner}' has no id on this host`);
      uid = userId;
      gid = rootIds(ctx).gid;
    }
  } catch (error) {
    if (error instanceof ApiConfigRefused) throw new StepError(error.message, { refused: true, detail: { path: action.path, exists: false } });
    throw error;
  }
  const mode = action.kind === 'v2_env' ? MODES.v2Env.mode : MODES.v1Config.mode;
  ctx.io.writeBytesAtomic(action.path, bytes, mode, uid, gid, sharedPin(ctx, action.path));
  return { outcome: 'done', detail: secretMeta(ctx, action.path) };
}

/* ── the web server (§5.9 modules, §5.10 operator files) ──────────────────────────── */

/**
 * configtest → reload → active poll, the caller holding the host web lock. On a failed
 * configtest `undo()` runs and configtest is repeated; on an inactive master after the reload
 * `undo()` runs, then configtest and restart (the EL AVC case, spec §5.9).
 */
function configtestAndReload(ctx: ActContext, undo: () => void): { outcome: 'done' | 'rolled_back'; reason?: string; exit1?: number; exit2?: number } {
  const server = ctx.layout.web.server;
  const first = ctx.exec.webConfigtest(ctx.layout.web.configtestBin, server);
  if (first.code !== 0) {
    undo();
    const second = ctx.exec.webConfigtest(ctx.layout.web.configtestBin, server);
    return { outcome: 'rolled_back', reason: `configtest failed (exit ${first.code}); restored, configtest again exit ${second.code}`, exit1: first.code, exit2: second.code };
  }
  const reload = ctx.exec.reloadUnit(ctx.layout.web.unit);
  if (reload.code === 0 && pollActive(ctx, ctx.layout.web.unit)) return { outcome: 'done' };
  undo();
  const second = ctx.exec.webConfigtest(ctx.layout.web.configtestBin, server);
  const restart = ctx.exec.restartUnit(ctx.layout.web.unit);
  const back = restart.code === 0 && pollActive(ctx, ctx.layout.web.unit);
  return {
    outcome: 'rolled_back',
    reason: `${ctx.layout.web.unit} was not active after the reload; restored, configtest exit ${second.code}, restart ${back ? 'brought it back' : 'did NOT bring it back'}`,
    exit1: reload.code,
    exit2: second.code,
  };
}

function apacheModules(ctx: ActContext, action: Extract<InitAction, { kind: 'apache_modules' }>): StepDone {
  if (ctx.family !== 'debian') throw new StepError('apache modules are enabled by init on Debian/Ubuntu only (EL: conf.modules.d is the operator\'s)', { refused: true });
  if (ctx.layout.web.server !== 'apache') throw new StepError('apache modules on a non-apache host', { refused: true });
  if (action.mods.length === 0) return { outcome: 'noop', detail: { mods: [] } };
  const lock = ctx.webLock();
  try {
    const enabled = ctx.exec.enableApacheModules(action.mods);
    if (enabled.code !== 0) throw new StepError(`a2enmod exited ${enabled.code}`, { detail: { mods: action.mods, exit: enabled.code } });
    const result = configtestAndReload(ctx, () => {
      ctx.exec.disableApacheModules(action.mods);
    });
    if (result.outcome === 'rolled_back') {
      throw new StepError(result.reason as string, { rolledBack: true, detail: { mods: action.mods, exit1: result.exit1 ?? 0, exit2: result.exit2 ?? 0 } });
    }
    return { outcome: 'done', detail: { mods: action.mods, modsEnabled: action.mods } };
  } finally {
    lock.release();
  }
}

/** Re-reads an operator file at its realpath and requires the sha that was shown (spec §5.10 steps 1-2). */
function reread(ctx: ActContext, path: string, beforeSha: string): { real: string; text: string; uid: number; gid: number; mode: number } {
  const real = ctx.realpath(path);
  if (real === null) throw new StepError(`'${path}' does not resolve — changed since shown; re-run`, { detail: { path, beforeSha } });
  const file = ctx.io.readOperatorFile(real);
  if (file.sha !== beforeSha) throw new StepError(`'${real}' changed since shown; re-run`, { detail: { path, realpath: real, beforeSha } });
  return { real, text: Buffer.from(file.bytes).toString('utf8'), uid: file.uid, gid: file.gid, mode: file.mode };
}

function backupPath(ctx: ActContext, target: string): string {
  return join(ctx.initDir, BACKUP_DIR_NAME, `${ctx.journal.peekSeq()}-${basename(target)}`);
}

function ensureBackupDir(ctx: ActContext): void {
  const { uid, gid } = rootIds(ctx);
  ensureDir(ctx.io, join(ctx.initDir, BACKUP_DIR_NAME), MODES.initState.mode, uid, gid, ctx.lstat);
}

function webIncludePath(ctx: ActContext, server: WebServer): string {
  return join(ctx.layout.instanceDir, `web.${server}.conf`);
}

/** The vhost edit's `after`, computed now from the re-read bytes (spec §4.2). */
function vhostAfter(ctx: ActContext, action: Extract<InitAction, { kind: 'vhost_reference' | 'vhost_manual_removal' }>, text: string): string {
  if (action.kind === 'vhost_manual_removal') return ctx.ports.webEdit.removeManualLines(text, action.lines);
  const include = webIncludePath(ctx, action.server);
  // The site's address-family twins in this file (compare siteFiles) are inserted in the same
  // edit, BOTTOM-UP: an insertion shifts only the lines below it, so every opener line still
  // names its opener when its turn comes. Each insertion is idempotent per opener.
  const openers = [...new Set([action.line, ...(action.alsoLines ?? [])])].sort((x, y) => y - x);
  let after = text;
  for (const line of openers) {
    after =
      action.server === 'apache'
        ? ctx.ports.webEdit.insertApacheReference(after, ctx.instance, include, line)
        : ctx.ports.webEdit.insertNginxReference(after, ctx.instance, include, line);
  }
  return after;
}

/* ── one item ─────────────────────────────────────────────────────────────────────── */

interface RunState {
  /** code_install trees swapped in this run whose `.prev` waits for the restart. */
  readonly pendingTrees: { item: string; dst: string }[];
  readonly undo: string[];
}

/** The begin record's detail: what resume needs, never a secret. */
function beginDetail(ctx: ActContext, action: InitAction): Record<string, unknown> {
  switch (action.kind) {
    case 'group_add':
    case 'user_add_own':
      return { name: action.name };
    case 'user_add_in':
      return { name: action.name, group: action.group };
    case 'path_meta':
    case 'mkdir':
      return { path: action.path, uid: action.uid, gid: action.gid, mode: action.mode };
    case 'sebool':
      return { name: action.name, value: action.value, previous: action.previous };
    case 'fcontext_relocate':
      return { remove: action.remove };
    case 'bun_install':
      return { archive: action.archive, asset: action.asset, pin: action.pin, path: action.target, temps: [initTempPath(action.target)] };
    case 'code_install':
      return { src: action.src, dst: action.dst, new: newPathOf(action.dst), prev: prevPathOf(action.dst), digest: action.digest };
    case 'write_declaration':
      return { path: ctx.layout.declarationPath, sha: sha256(action.body), temps: [initTempPath(ctx.layout.declarationPath)] };
    case 'provision_apply':
      return { instance: action.instance };
    case 'unit_restart':
      return { units: action.units };
    case 'v2_env':
    case 'v1_config':
      return { path: action.path, exists: ctx.lstat(action.path) !== null, temps: [initTempPath(action.path)] };
    case 'apache_modules':
      return { mods: action.mods };
    case 'vhost_reference':
    case 'vhost_manual_removal':
    case 'nginx_map_seed':
      // Not used: the transaction writes its own begin once it has re-read the file (operatorEdit, mapSeed).
      return { path: action.path, beforeSha: action.beforeSha };
    case 'keep_ref':
      return { files: action.files.map(file => basename(file)) };
    case 'verify_agent':
      return {};
    case 'pair':
      return { name: action.invocation.name };
    case 'pair_package':
      return { name: action.name, path: action.path };
    case 'pair_package_remove':
      return { path: action.path, temps: [initTempPath(action.path)] };
    default: {
      const unreachable: never = action;
      throw new StepError(`unknown action ${JSON.stringify(unreachable)}`);
    }
  }
}

function operatorEdit(ctx: ActContext, item: Item, action: Extract<InitAction, { kind: 'vhost_reference' | 'vhost_manual_removal' }>): StepDone {
  const file = reread(ctx, action.path, action.beforeSha);
  const after = vhostAfter(ctx, action, file.text);
  if (after === file.text) return { outcome: 'noop', detail: { path: action.path, realpath: file.real, sha: action.beforeSha } };
  ensureBackupDir(ctx);
  const bytes = new TextEncoder().encode(after);
  const request: OperatorEditRequest = {
    item: item.id,
    target: file.real,
    beforeSha: action.beforeSha,
    after: bytes,
    afterSha: sha256(bytes),
    server: action.server,
    backup: backupPath(ctx, file.real),
    mods: [],
  };
  // The transaction's own begin: everything resume needs to settle the file by its sha.
  ctx.journal.append(item.id, 'begin', {
    target: request.target,
    backup: request.backup,
    beforeSha: request.beforeSha,
    afterSha: request.afterSha,
    server: action.server,
    mods: request.mods,
    previous: { uid: file.uid, gid: file.gid, mode: file.mode },
  });
  return settleTxn(ctx.ports.editOperatorFile(request), { target: request.target, afterSha: request.afterSha });
}

function settleTxn(result: TxnResult, detail: Record<string, unknown>): StepDone {
  const terms = { ...detail, ...(result.exit1 === undefined ? {} : { exit1: result.exit1 }), ...(result.exit2 === undefined ? {} : { exit2: result.exit2 }) };
  if (result.outcome === 'done') return { outcome: 'done', detail: { ...detail, ...(result.modsEnabled ? { modsEnabled: result.modsEnabled } : {}) } };
  throw new StepError(result.reason ?? `the transaction ${result.outcome === 'rolled_back' ? 'was rolled back' : 'failed'}`, {
    rolledBack: result.outcome === 'rolled_back',
    detail: terms,
  });
}

/** The files the hand-map seed creates (spec §5.10): the live map, `_seed.json`, and the include when absent now. */
export function seededPaths(ctx: ActContext): string[] {
  const host = ctx.layout.host;
  const seeded = [join(host.nginxMapDir, 'dedalo_media_map.nginx.conf'), join(host.nginxContribDir, '_seed.json')];
  if (ctx.lstat(host.nginxMapInclude) === null) seeded.push(host.nginxMapInclude);
  return seeded;
}

function mapSeed(ctx: ActContext, item: Item, action: Extract<InitAction, { kind: 'nginx_map_seed' }>): StepDone {
  const file = reread(ctx, action.path, action.beforeSha);
  ensureBackupDir(ctx);
  const request: MapSeedRequest = {
    item: item.id,
    target: file.real,
    beforeSha: action.beforeSha,
    standalone: action.standalone,
    backup: backupPath(ctx, file.real),
    seeded: seededPaths(ctx),
  };
  ctx.journal.append(item.id, 'begin', {
    target: request.target,
    backup: request.backup,
    beforeSha: request.beforeSha,
    standalone: request.standalone,
    seeded: request.seeded,
    previous: { uid: file.uid, gid: file.gid, mode: file.mode },
  });
  return settleTxn(ctx.ports.seedNginxMap(request), { target: request.target });
}

function keepRef(ctx: ActContext, action: Extract<InitAction, { kind: 'keep_ref' }>): StepDone {
  const { uid, gid } = rootIds(ctx);
  const kept = join(ctx.initDir, KEPT_DIR_NAME);
  ensureDir(ctx.io, kept, MODES.initState.mode, uid, gid, ctx.lstat);
  const names: string[] = [];
  for (const file of action.files) {
    const bytes = ctx.io.readOperatorFile(file).bytes;
    ctx.io.writeBytesAtomic(join(kept, basename(file)), bytes, 0o600, uid, gid);
    names.push(basename(file));
  }
  for (const [key, value] of [['BUN', ctx.layout.bunBin], ['AGENT', ctx.layout.agentDir]] as const) {
    if (!RERUN_PATH_PATTERN.test(value)) throw new StepError(`rerun.env ${key} '${value}' is outside ${RERUN_PATH_PATTERN.source}`, { refused: true });
  }
  const rerun = `BUN=${ctx.layout.bunBin}\nAGENT=${ctx.layout.agentDir}\n`;
  ctx.io.writeBytesAtomic(join(ctx.initDir, RERUN_ENV_NAME), new TextEncoder().encode(rerun), 0o600, uid, gid);
  return { outcome: 'done', detail: { files: names, path: join(ctx.initDir, RERUN_ENV_NAME) } };
}

function fromPort(result: PortResult, what: string): StepDone {
  if (result.outcome === 'done' || result.outcome === 'noop') return { outcome: result.outcome };
  throw new StepError(result.reason ?? `${what} ${result.outcome}`, { refused: result.outcome === 'refused' });
}

function step(ctx: ActContext, item: Item, action: InitAction, state: RunState): StepDone {
  switch (action.kind) {
    case 'group_add':
      return createAccount(ctx, 'group', action.name, () => ctx.exec.groupAdd(action.name));
    case 'user_add_own':
      return createAccount(ctx, 'user', action.name, () => ctx.exec.userAddOwnGroup(action.name, nologinShell(ctx)));
    case 'user_add_in':
      return createAccount(ctx, 'user', action.name, () => ctx.exec.userAddInGroup(action.name, action.group, nologinShell(ctx)));
    case 'path_meta': {
      const done = pathMeta(ctx, item, action);
      if (done.outcome === 'done') {
        const previous = done.detail?.previous as { uid: number; gid: number; mode: number };
        state.undo.push(`chown ${previous.uid}:${previous.gid} '${action.path}' && chmod ${octal(previous.mode)} '${action.path}'`);
      }
      return done;
    }
    case 'mkdir':
      return mkdirStep(ctx, action);
    case 'sebool': {
      const done = seboolStep(ctx, action);
      if (done.outcome === 'done') state.undo.push(`setsebool -P ${action.name} ${(done.detail?.previous as boolean) ? 'on' : 'off'}`);
      return done;
    }
    case 'fcontext_relocate':
      return fcontextRelocate(ctx, action);
    case 'bun_install':
      return bunInstall(ctx, action);
    case 'code_install': {
      if (digestOrNull(ctx, action.dst) === action.digest) return { outcome: 'noop', detail: { dst: action.dst, digest: action.digest } };
      const { uid, gid } = rootIds(ctx);
      const installed = installTree(action.src, action.dst, ctx.tree.reader, ctx.tree.writer, { uid, gid, expectedDigest: action.digest });
      state.pendingTrees.push({ item: item.id, dst: action.dst });
      if (ctx.selinux.agentRuleRegistered && (ctx.selinux.mode === 'permissive' || ctx.selinux.mode === 'enforcing')) {
        const result = ctx.exec.restorecon([{ path: action.dst, recursive: true }], false);
        if (result.code !== 0) throw new StepError(`restorecon -R ${action.dst} exited ${result.code}`, { detail: { dst: action.dst, exit: result.code } });
      }
      return { outcome: 'done', detail: { dst: action.dst, digest: installed.digest, swapped: true, ...(installed.prev ? { prev: installed.prev } : {}) } };
    }
    case 'write_declaration':
      return writeDeclaration(ctx, action);
    case 'provision_apply': {
      const code = ctx.ports.runApply(action.instance);
      if (code === EXIT_OK) return { outcome: 'done', detail: { exit: code } };
      throw new StepError(`provision apply exited ${code}`, { refused: code === EXIT_REFUSED, detail: { exit: code } });
    }
    case 'unit_restart': {
      const done = restartUnits(ctx, action.units);
      commitTrees(ctx, state);
      return done;
    }
    case 'v2_env':
    case 'v1_config':
      return apiConfig(ctx, action);
    case 'apache_modules':
      return apacheModules(ctx, action);
    case 'vhost_reference':
    case 'vhost_manual_removal':
      return operatorEdit(ctx, item, action);
    case 'nginx_map_seed':
      return mapSeed(ctx, item, action);
    case 'keep_ref':
      return keepRef(ctx, action);
    case 'verify_agent':
      return fromPort(ctx.ports.verifyAgent(), 'the agent check (B4)');
    case 'pair':
      return fromPort(ctx.ports.pair(action.invocation), 'pairing (B5)');
    case 'pair_package':
      return fromPort(ctx.ports.pairPackage(action), 'the sealed pairing package (B5)');
    case 'pair_package_remove':
      return removePairingPackage(ctx, action);
    default: {
      const unreachable: never = action;
      throw new StepError(`unknown action ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The sealed package, once the work host paired: removed only while it is still the file init
 * wrote — a regular root 0600 file in the pairing format (its magic and parameters; the
 * passphrase is gone, so nothing more can be read). Anything else is left in place, by name.
 * Renamed to init's temp name, then removed (the temp is what --resume finishes).
 */
function removePairingPackage(ctx: ActContext, action: Extract<InitAction, { kind: 'pair_package_remove' }>): StepDone {
  if (ctx.lstat(action.path) === null) return { outcome: 'noop', detail: { path: action.path } };
  const file = ctx.io.readOperatorFile(action.path);
  const problem = file.uid !== rootIds(ctx).uid || file.mode !== PAIRING_PACKAGE_MODE ? 'it is not root 0600' : packageHeaderProblem(file.bytes);
  if (problem !== null) {
    throw new StepError(`'${action.path}' is not the sealed package init wrote (${problem}): it was left in place — remove it by hand if it is yours`, {
      refused: true,
      detail: { path: action.path },
    });
  }
  const temp = initTempPath(action.path);
  ctx.io.rename(action.path, temp);
  ctx.io.removeInitTemp(temp);
  return { outcome: 'done', detail: { path: action.path } };
}

function commitTrees(ctx: ActContext, state: RunState): void {
  while (state.pendingTrees.length > 0) {
    const tree = state.pendingTrees.shift() as { item: string; dst: string };
    commitTree(tree.dst, ctx.tree.reader, ctx.io);
  }
}

/** A later step failed before the restart succeeded: every tree swapped in this run goes back (spec §5.5). */
function restoreTrees(ctx: ActContext, state: RunState): string[] {
  const lines: string[] = [];
  while (state.pendingTrees.length > 0) {
    const tree = state.pendingTrees.pop() as { item: string; dst: string };
    const did = restoreTree(tree.dst, ctx.tree.reader, ctx.io);
    ctx.journal.append(tree.item, 'rolled_back', { dst: tree.dst, outcome: did, reason: 'a later step failed before the restart' });
    lines.push(`${tree.dst}: previous tree ${did}`);
  }
  return lines;
}

/** The operator file an action edits (checked BEFORE its own begin: the transaction writes the begin with the backup). */
function ownBegin(action: InitAction): boolean {
  return action.kind !== 'vhost_reference' && action.kind !== 'vhost_manual_removal' && action.kind !== 'nginx_map_seed';
}

/**
 * Runs `items` in order. Items without an action and `right` items are passed over; an item
 * still in the `decision` list is a refusal before anything runs (act decides nothing).
 */
export function executeItems(items: readonly Item[], ctx: ActContext): ActReport {
  const unresolved = items.filter(item => item.list === 'decision');
  if (unresolved.length > 0) {
    return {
      ok: false,
      exit: EXIT_REFUSED,
      outcomes: unresolved.map(item => ({ item: item.id, status: 'refused', detail: 'still needs your decision — nothing was done' })),
      stillToDo: [],
    };
  }
  const outcomes: ActOutcome[] = [];
  const state: RunState = { pendingTrees: [], undo: [] };
  let exit: 0 | 3 | 4 = EXIT_OK;
  for (const item of items) {
    if (item.list !== 'change' || item.action === undefined) continue;
    if (exit !== EXIT_OK) {
      outcomes.push({ item: item.id, status: 'not_reached', detail: 'not reached — an earlier item did not finish' });
      continue;
    }
    const action = item.action;
    try {
      // The closed label grammar is checked before anything is journaled or written.
      if (action.kind === 'fcontext_relocate') relocationLines(action.remove, ctx.selinux.types);
      if (ownBegin(action)) ctx.journal.append(item.id, 'begin', beginDetail(ctx, action));
      const done = step(ctx, item, action, state);
      ctx.journal.append(item.id, done.outcome, done.detail ?? {});
      outcomes.push({ item: item.id, status: done.outcome, detail: done.line ?? (done.outcome === 'noop' ? 'already right' : 'done') });
    } catch (error) {
      // A detail the journal grammar refuses means the input itself is not admissible: nothing ran, so it is a refusal.
      const failure =
        error instanceof StepError
          ? error
          : new StepError(error instanceof Error ? (error.message.split('\n')[0] as string) : String(error), { refused: error instanceof JournalFormatError });
      const phase = failure.rolledBack ? 'rolled_back' : 'failed';
      const reason = failure.message.slice(0, 300).replace(/[\x00-\x1f\x7f]/g, ' ');
      try {
        ctx.journal.append(item.id, phase, { ...failure.detail, reason });
      } catch {
        ctx.journal.append(item.id, phase, { reason: 'the failure detail is not journalable; see the output' });
      }
      outcomes.push({ item: item.id, status: failure.refused ? 'refused' : phase, detail: failure.message });
      exit = failure.refused ? EXIT_REFUSED : EXIT_FAILED;
      for (const line of restoreTrees(ctx, state)) outcomes.push({ item: item.id, status: 'rolled_back', detail: line });
    }
  }
  if (exit === EXIT_OK) commitTrees(ctx, state);
  return { ok: exit === EXIT_OK, exit, outcomes, stillToDo: exit === EXIT_OK ? [] : [...state.undo] };
}

/**
 * On success (spec §7): the stage and the Bun extract directory go; the journal, kept/ and
 * rerun.env stay. Only directories under the instance's own init directory are ever removed.
 */
export const EXTRACT_DIR_NAME = 'bun_extract';
export function cleanupAfterSuccess(ctx: Pick<ActContext, 'initDir' | 'io' | 'lstat'>): string[] {
  const removed: string[] = [];
  for (const name of [STAGE_DIR_NAME, EXTRACT_DIR_NAME]) {
    const path = join(ctx.initDir, name);
    if (ctx.lstat(path) === null) continue;
    ctx.io.removeTree(path, ctx.initDir);
    removed.push(path);
  }
  return removed;
}

/* ── resume (§7) ──────────────────────────────────────────────────────────────────── */

export interface ResumeReport {
  /** Items whose open begin was closed here, and how. */
  readonly settled: readonly { readonly item: string; readonly phase: 'done' | 'rolled_back' | 'failed'; readonly detail: string }[];
  /** Items whose state matches neither side: a decision showing the diff against the backup (run.ts renders it). */
  readonly decisions: readonly { readonly item: string; readonly target: string; readonly backup: string }[];
  /** Items left to the re-run (idempotent actions; secrets are prompted again). */
  readonly rerun: readonly string[];
}

function str(detail: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = detail[key];
  return typeof value === 'string' ? value : null;
}

function strings(detail: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = detail[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function removeTemps(ctx: ActContext, temps: readonly string[]): void {
  for (const temp of temps) {
    if (ctx.lstat(temp) === null) continue;
    if (temp.endsWith(INIT_TEMP_SUFFIX)) ctx.io.removeInitTemp(temp, sharedPin(ctx, temp));
    else if (temp.endsWith('.dedalo-provision.tmp')) ctx.io.removeTemp(temp);
  }
}

/** The current sha of a file, or null when it is absent. */
function shaOf(ctx: ActContext, path: string): string | null {
  if (ctx.lstat(path) === null) return null;
  return ctx.io.readOperatorFile(path).sha;
}

function restoreBackup(ctx: ActContext, target: string, backup: string, previous: unknown): void {
  const meta = previous as { uid: number; gid: number; mode: number } | null;
  const bytes = ctx.io.readOperatorFile(backup).bytes;
  ctx.io.writeBytesAtomic(target, bytes, meta?.mode ?? 0o644, meta?.uid ?? 0, meta?.gid ?? 0);
  if (ctx.selinux.mode === 'permissive' || ctx.selinux.mode === 'enforcing') ctx.exec.restorecon([{ path: target, recursive: false }], false);
}

function dismod(ctx: ActContext, mods: readonly string[]): void {
  if (ctx.family === 'debian' && mods.length > 0) ctx.exec.disableApacheModules(mods);
}

/** An operator-file transaction's open begin, settled by the target's sha (spec §7). */
function resumeOperatorFile(ctx: ActContext, record: JournalRecord): { phase: 'done' | 'rolled_back'; detail: string } | 'decision' {
  const d = record.detail;
  const target = str(d, 'target');
  const backup = str(d, 'backup');
  const beforeSha = str(d, 'beforeSha');
  if (target === null || backup === null || beforeSha === null) {
    // The run died before the transaction's own begin: nothing was touched.
    return { phase: 'rolled_back', detail: 'the transaction never started; nothing to undo' };
  }
  const mods = strings(d, 'mods');
  const seeded = strings(d, 'seeded');
  const isSeed = record.item.startsWith('web.nginx_manual_map') || 'standalone' in d;
  const current = shaOf(ctx, target);
  const backupExists = ctx.lstat(backup) !== null;
  const undo = (): void => {
    if (backupExists && current !== beforeSha) restoreBackup(ctx, target, backup, d.previous);
    for (const path of seeded) if (ctx.lstat(path) !== null) ctx.io.removeTree(path, dirname(path));
    dismod(ctx, mods);
  };
  const lock = ctx.webLock();
  try {
    const afterSha = str(d, 'afterSha');
    const reachedAfter = isSeed ? (d.standalone === true ? current === null : false) : afterSha !== null && current === afterSha;
    if (reachedAfter) {
      const settled = configtestAndReload(ctx, undo);
      return settled.outcome === 'done'
        ? { phase: 'done', detail: 'the edit was in place: configtest and reload passed' }
        : { phase: 'rolled_back', detail: settled.reason as string };
    }
    if (current === beforeSha) {
      for (const path of seeded) if (ctx.lstat(path) !== null) ctx.io.removeTree(path, dirname(path));
      dismod(ctx, mods);
      const test = ctx.exec.webConfigtest(ctx.layout.web.configtestBin, ctx.layout.web.server);
      return { phase: 'rolled_back', detail: `the file was untouched; configtest exit ${test.code}` };
    }
    return 'decision';
  } finally {
    lock.release();
  }
}

/**
 * `--resume`: closes every open begin (oldest first). Never decides an operator file whose
 * bytes match neither side — that becomes a decision for the operator.
 */
export function resumeOpen(open: readonly JournalRecord[], ctx: ActContext): ResumeReport {
  const settled: { item: string; phase: 'done' | 'rolled_back' | 'failed'; detail: string }[] = [];
  const decisions: { item: string; target: string; backup: string }[] = [];
  const rerun: string[] = [];
  const close = (record: JournalRecord, phase: 'done' | 'rolled_back' | 'failed', detail: string): void => {
    ctx.journal.append(record.item, phase, { resumed: true, reason: detail });
    settled.push({ item: record.item, phase, detail });
  };
  for (const record of open) {
    const d = record.detail;
    removeTemps(ctx, strings(d, 'temps'));
    if ('dst' in d && 'new' in d) {
      const dst = str(d, 'dst') as string;
      const did = restoreTree(dst, ctx.tree.reader, ctx.io);
      close(record, 'rolled_back', `code tree: previous ${did}`);
      rerun.push(record.item);
    } else if ('target' in d || 'beforeSha' in d) {
      const result = resumeOperatorFile(ctx, record);
      if (result === 'decision') decisions.push({ item: record.item, target: str(d, 'target') ?? '', backup: str(d, 'backup') ?? '' });
      else close(record, result.phase, result.detail);
    } else if ('name' in d && 'value' in d && typeof d.value === 'boolean') {
      const name = str(d, 'name') as string;
      if (readSebool(ctx.exec, name) === d.value) close(record, 'done', `${name} has the requested value`);
      else rerun.push(record.item);
    } else {
      // Accounts, paths, the declaration, apply, restarts, API configs (temp removed above; the
      // secret is prompted again): every one is idempotent — the re-run re-observes and acts.
      rerun.push(record.item);
    }
  }
  return { settled, decisions, rerun };
}
