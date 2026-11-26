/**
 * `provision init` — THE ORCHESTRATOR (spec §3.1 flow, §1.2 footgun guards and TTY, §7 locks and
 * journal). Reached ONLY through `deploy/install.sh` (spec S3), which stages the code root-owned,
 * verifies Bun and starts it with `cd $STAGE`, `env -i`, `--no-env-file`, `--no-install`,
 * `--config=<empty bunfig>` — those are the REAL controls; the guards below are footgun guards
 * against a hand start, and say so.
 *
 * One run, in this order (nothing is written before step 8's first journal `begin`, except the
 * instance lock and its directories):
 *   1. arguments (USAGE), the footgun guards (REFUSED: "start init through deploy/install.sh");
 *   2. the INSTANCE lock, exclusive (`--dry-run`: a peek, never a wait, never a write), and
 *      INIT_BASE's ancestry judged; the journal opened (an unfinished `begin` needs --resume);
 *   3. the staged source (its digest re-computed and required equal to the confirmed one) or the
 *      kept templates; the draft, or the existing final declaration as the draft;
 *   4. observeHostWide → completeDraft → observeDeclared → completeDraft again (the home reasons,
 *      the relocations) → compare: the three lists. `--resume` settles the open records first and
 *      the host is observed again;
 *   5. the report, rendered WHOLE (report.ts redacts and sanitizes; every line then passes cli.ts
 *      `guarded`); then, on a terminal, each unanswered decision by its class (decision_class.ts
 *      classifyDecision, the one rule — owner-approved 2026-11, P2):
 *        - needs_action (every option is `manual`: init can do nothing) — NOT asked: answered
 *          manual, and listed at the end under "needs your action" with the re-run command;
 *        - auto (exactly one option, not manual, not typed) — answered with it, reported
 *          "auto: the only option";
 *        - typed (edits an operator file, replaces a pairing, removes something, sets an SELinux
 *          boolean / mount option) — asked; the option must be typed, Enter takes nothing;
 *        - choose (the rest) — asked; Enter takes the shown default;
 *      the list recomputed after each answer; `Apply these N changes? [y/N]`; then the secrets
 *      (hidden, twice). No TTY: without --yes a dry run; with --yes the change items run and every
 *      decision stays open — none of the classes above applies (--yes never resolves a decision,
 *      never edits an operator file, never sets a boolean, never types a secret); `--decide`
 *      answers any decision, of any class, before it is classified;
 *   6. act (init/act.ts executeItems, one journal) in §4.3 order — `provision apply` in-process
 *      with the held lock, so it does not take it again;
 *   7. B4 (verify.ts, async — run between the two act phases) and B5 (pair.ts: pairing runs after
 *      apply wrote the fragment, from facts re-read then);
 *   8. on success the stage and the Bun extract go; "still to do" lists what stayed open.
 *
 * Exit codes are cli.ts EXIT: 0, 1 (dry run / no TTY and something would change), 2, 3, 4.
 *
 * I/O: everything goes through the injected InitWorld (production: initHostDeps()). init/* never
 * imports src/config.ts.
 */
import { join } from 'node:path';
import { hostTreeReader, hostTreeWriter, type TreeReader, type TreeWriter } from './tree_copy';
import { observeHost as observeProvisionHost } from '../apply';
import { EXIT, SecretOutputRefused, declarationTrustProblems, guarded, hostDeps, run as runProvision, siblingProblems } from '../cli';
import type { ProvisionDeps } from '../cli';
import type { BunAsset } from '../exec_contract';
import { initExec, provisionExec } from '../../exec';
import { flockIo } from '../flock';
import type { AgentLayout, HostDeclaration } from '../layout';
import { DEFAULT_PATHS, PUBHOST_GROUP, canonicalDeclaration } from '../layout';
import type { LockHandle, LockState } from '../lock';
import { INIT_BASE, LockBusy, LockRefused, acquireHostLockSync, acquireInstanceLockSync, describeHolder, peekInstanceLock } from '../lock';
import type { HostState } from '../plan';
import { judgeAncestors, trustProblem } from '../plan';
import { FINGERPRINT_PENDING } from '../render/engine_fragment';
import { DeclarationError, parseDeclaration } from '../schema';
import { REMOVABLE_SELINUX_TYPES, escapeSpec } from '../selinux';
import type { Sibling } from '../siblings';
import type { ActContext, ActPorts, ActReport, PortResult } from './act';
import { cleanupAfterSuccess, executeItems, resumeOpen } from './act';
import type { V1Values, V2Values } from './api_config';
import { ApiConfigRefused, v1Literals, v2Assignments } from './api_config';
import { initUsageLines, parseInitArgs } from './args';
import { BunInstallFailed, BunInstallRefused, installBun } from './bun_install';
import type { ComparedItem } from './compare';
import { compare, isKnownItemId, unknownAnswers } from './compare';
import { classifyDecision } from './decision_class';
import { BUN_CONFIG_FLAG_PREFIX, BUN_HANDOVER_FLAGS, EMPTY_BUNFIG_NAME, KEPT_DIR_NAME, MARIADB_SOCKET_CANDIDATES, MARIADB_TCP_HOST, MARIADB_TCP_PORT, RERUN_ENV_NAME } from './constants';
import type { DraftCompletion, DraftDeclaration } from './draft';
import { completeDraft } from './draft';
import { DraftError, parseDraft } from './draft_schema';
import { initHostIo } from './host_io';
import type { Journal } from './journal';
import { JOURNAL_NAME, openJournal } from './journal';
import { JournalFormatError, decodeJournal, unfinished as unfinishedOf } from './journal_format';
import type { DeclaredPorts, ObserveFs } from './observe';
import { hostObserveFs, observeDeclared, observeHostWide } from './observe';
import { PACKAGE_REMOVE, engineContactSince, pairItem, pairOneMachine, pairPlan, pairPortResult, twoMachineInstructions, writePairingPackage, writtenPackageItem } from './pair';
import { fsTypeOf } from './parse/mounts';
import { parseSelinuxContext } from './parse/selinux';
import { countLine, renderLists, renderNeedsAction, sanitizeLine } from './report';
import { SourceRefused, confirmedDigestProblem, readStagedSource } from './source';
import { ttyPrompter } from './tty';
import type { DeclaredFacts, HostFacts, InitAction, InitArgs, InitPorts, Item, JournalRecord, KeptRef, Prompter, StagedSource } from './types';
import type { HealthFetch } from './verify';
import { verifyAgent, verifyPortResult } from './verify';
import { editOperatorFile, seedNginxMap } from './web_txn';
import type { WebTxnPorts } from './web_txn';
import { insertApacheReference, insertNginxReference, removeManualLines } from './web_edit';

/* ── the world ───────────────────────────────────────────────────────────────────── */

/**
 * Everything a run touches. InitPorts (types.ts, the day-0 contract) plus the doors the packages
 * turned out to need beyond it (each named by its consumer): discovery's directory reads, the
 * tree walk, the provisioner's own host reader and in-process CLI, the sleeps, B4's request.
 */
export interface InitWorld extends InitPorts {
  /** observe.ts ObserveFs: lstat (never followed), readDir, realpath. */
  readonly fs: ObserveFs;
  /** tree_copy.ts: the agent tree's walk and its writer (code.install). */
  readonly tree: { readonly reader: TreeReader; readonly writer: TreeWriter };
  /** The `*.json` files directly in a directory, sorted (the sibling declarations). */
  listDeclarations(dir: string): string[];
  /** apply.ts observeHost(layout, exec, {siblings}) — plan()'s facts. */
  observeHost(layout: AgentLayout, siblings?: readonly Sibling[]): HostState;
  /** The in-process `provision apply` (cli.ts run) and the sibling check read the host through these. */
  readonly provisionDeps: ProvisionDeps;
  readonly sleepSync: (ms: number) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** B4's request (default: the global fetch). */
  readonly healthFetch?: HealthFetch;
  /** INIT_BASE in production; a scratch directory in a gate. */
  readonly initBase: string;
  /** Who "root" is: 0:0 in production; a scratch gate's own ids. */
  readonly root: { readonly uid: number; readonly gid: number };
  /** Ancestors at or above this are not judged. Production '/'. */
  readonly trustRoot: string;
}

export interface InitDeps {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Built on demand (production: spawns `id -u root` while building), so USAGE touches nothing. */
  readonly world?: () => InitWorld;
}

/** The production world. */
export function productionWorld(): InitWorld {
  const exec = { ...provisionExec(), ...initExec() };
  const io = initHostIo(exec);
  const lock = flockIo();
  const provision = hostDeps();
  return {
    io,
    exec,
    lock,
    prompter: ttyPrompter(),
    out: line => console.log(line),
    err: line => console.error(line),
    now: () => new Date(),
    euid: () => (typeof process.geteuid === 'function' ? process.geteuid() : null),
    execPath: process.execPath,
    codeDir: import.meta.dir,
    cwd: process.cwd(),
    fs: hostObserveFs(),
    tree: { reader: hostTreeReader(), writer: hostTreeWriter(io) },
    listDeclarations: dir => provision.listDeclarations(dir),
    observeHost: (layout, siblings) => observeProvisionHost(layout, exec, siblings === undefined ? {} : { siblings }),
    provisionDeps: provision,
    sleepSync: ms => Bun.sleepSync(ms),
    sleep: ms => Bun.sleep(ms),
    initBase: INIT_BASE,
    root: { uid: 0, gid: 0 },
    trustRoot: '/',
  };
}

export function initHostDeps(): InitDeps {
  return {
    out: line => console.log(line),
    err: line => console.error(line),
    world: productionWorld,
  };
}

/* ── the footgun guards (spec §1.2) ─────────────────────────────────────────────── */

const HANDOVER_HINT = 'start init through deploy/install.sh';
/** cwd may hold none of these: Bun would read them (a preload, an env file, a tsconfig). */
const CWD_FORBIDDEN = /^(bunfig\.toml|\.env(\..*)?|tsconfig\.json)$/;
/** /proc/self/environ may hold none of these keys. */
const ENVIRON_FORBIDDEN = /^(BUN_|NODE_|DEDALO_|LD_)/;

function pathTrust(world: InitWorld, label: string, path: string): string[] {
  const problems: string[] = [];
  const facts = world.fs.lstat(path);
  if (facts === null) return [`${label} '${path}' cannot be inspected`];
  const own = trustProblem(facts, world.root.uid);
  if (own) problems.push(`${label} '${path}' is ${own}`);
  problems.push(...judgeAncestors(`${label} '${path}'`, path, world.trustRoot, p => world.fs.lstat(p), world.root.uid, new Set()));
  return problems;
}

/** Every footgun guard's refusal; empty = this process was started the way install.sh starts it. */
export function footgunProblems(world: InitWorld): string[] {
  const problems: string[] = [];
  const euid = world.euid();
  if (euid !== world.root.uid) problems.push(`init runs as root (this process runs as uid ${euid ?? 'unknown'})`);
  problems.push(...pathTrust(world, 'the Bun binary', world.execPath));
  problems.push(...pathTrust(world, 'the init code', world.codeDir));
  problems.push(...pathTrust(world, 'the working directory', world.cwd));
  for (const name of world.fs.readDir(world.cwd) ?? []) {
    if (CWD_FORBIDDEN.test(name)) problems.push(`the working directory holds '${name}', which Bun would read`);
  }
  const environ = world.io.readProcFile('/proc/self/environ');
  if (environ === null) problems.push('/proc/self/environ cannot be read');
  else {
    for (const entry of environ.split('\0')) {
      const key = entry.split('=')[0] ?? '';
      if (ENVIRON_FORBIDDEN.test(key)) problems.push(`the environment holds ${key} (install.sh starts Bun with env -i)`);
    }
  }
  const cmdline = world.io.readProcFile('/proc/self/cmdline');
  if (cmdline === null) problems.push('/proc/self/cmdline cannot be read');
  else {
    const argv = cmdline.split('\0');
    for (const flag of BUN_HANDOVER_FLAGS) if (!argv.includes(flag)) problems.push(`Bun was started without ${flag}`);
    const config = `${BUN_CONFIG_FLAG_PREFIX}${join(world.cwd, EMPTY_BUNFIG_NAME)}`;
    if (!argv.includes(config)) problems.push(`Bun was started without ${config}`);
  }
  if (world.fs.lstat('/sys/fs/selinux/enforce') !== null) {
    const context = world.io.readProcFile('/proc/self/attr/current');
    const type = context === null ? null : (parseSelinuxContext(context)?.type ?? null);
    if (type !== 'unconfined_t') problems.push(`root's SELinux context is ${type ?? 'unreadable'}, not unconfined_t: run install.sh from an unconfined root shell`);
  }
  return problems;
}

/* ── the run's state ─────────────────────────────────────────────────────────────── */

interface Sinks {
  /** One line through the output law: sanitized, then the guard (throws SecretOutputRefused). */
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

interface Inputs {
  readonly args: InitArgs;
  readonly draft: DraftDeclaration;
  readonly existing: HostDeclaration | null;
  readonly source: StagedSource | null;
  readonly kept: KeptRef | null;
  readonly pin: string | null;
  readonly initDir: string;
  readonly lockState: LockState;
  readonly journalOpen: readonly JournalRecord[];
  /** Every journal record of earlier runs (a pairing done before is not repeated). */
  readonly history: readonly JournalRecord[];
}

interface Computed {
  readonly facts: HostFacts;
  readonly completion: DraftCompletion;
  readonly declared: DeclaredFacts | null;
  readonly items: readonly ComparedItem[];
}

class Refusal extends Error {
  readonly code: number;
  readonly lines: readonly string[];
  constructor(code: number, lines: readonly string[]) {
    super(lines[0] ?? 'refused');
    this.code = code;
    this.lines = lines;
  }
}

const refuse = (...lines: string[]) => new Refusal(EXIT.REFUSED, lines);

/* ── inputs ──────────────────────────────────────────────────────────────────────── */

function readKept(world: InitWorld, initDir: string): KeptRef | null {
  const dir = join(initDir, KEPT_DIR_NAME);
  const names = world.fs.readDir(dir);
  if (names === null) return null;
  const files: Record<string, string> = {};
  for (const name of names) {
    if (world.fs.lstat(join(dir, name))?.type !== 'file') continue;
    files[name] = world.io.readOperatorFile(join(dir, name)).sha;
  }
  return Object.freeze({ dir, files: Object.freeze(files) });
}

function readJson(world: InitWorld, path: string, what: string): unknown {
  const text = world.io.readRootFile(path);
  if (text === null) throw refuse(`provision init: ${what} '${path}' cannot be read`);
  try {
    return JSON.parse(text);
  } catch {
    throw refuse(`provision init: ${what} '${path}' is not JSON`);
  }
}

function readInputs(world: InitWorld, args: InitArgs, initDir: string, journal: Journal | null, lockState: LockState): Inputs {
  // The source: re-digested here and required equal to what the operator confirmed (spec §1.2).
  let source: StagedSource | null = null;
  if (args.source !== null) {
    try {
      source = readStagedSource(args.source, world.tree.reader);
    } catch (error) {
      if (error instanceof SourceRefused) throw refuse(`provision init: ${error.message}`);
      throw error;
    }
    const problem = confirmedDigestProblem(source, args.sourceDigestConfirmed);
    if (problem !== null) throw refuse(`provision init: ${problem}`);
  }
  const kept = source === null ? readKept(world, initDir) : null;
  const keptPin = kept === null ? null : (world.io.readRootFile(join(kept.dir, '.bun-version'))?.trim() ?? null);
  const pin = source?.pin ?? keptPin;

  // The draft (judged before it is read), then the existing final declaration.
  let draft: DraftDeclaration | null = null;
  if (args.draft !== null) {
    const untrusted = declarationTrustProblems(args.draft, 'the draft', path => world.fs.lstat(path));
    if (untrusted.length > 0) throw refuse(...untrusted.map(line => `provision init: ${line}`));
    try {
      draft = parseDraft(readJson(world, args.draft, 'the draft'), args.draft);
    } catch (error) {
      if (error instanceof DraftError) throw refuse(...error.message.split('\n').map(line => `provision init: ${line}`));
      throw error;
    }
    if (draft.instance !== args.instance) throw refuse(`provision init: the draft declares instance '${draft.instance}', not '${args.instance}'`);
  }
  const configBase = draft?.paths?.config_base ?? DEFAULT_PATHS.configBase;
  const finalPath = join(configBase, `${args.instance}.json`);
  let existing: HostDeclaration | null = null;
  if (world.fs.lstat(finalPath) !== null) {
    const untrusted = declarationTrustProblems(finalPath, 'the declaration', path => world.fs.lstat(path));
    if (untrusted.length > 0) throw refuse(...untrusted.map(line => `provision init: ${line}`));
    try {
      existing = parseDeclaration(readJson(world, finalPath, 'the declaration'), finalPath).declaration;
    } catch (error) {
      if (error instanceof DeclarationError) throw refuse(...error.message.split('\n').map(line => `provision init: ${line}`));
      throw error;
    }
  }
  if (draft === null && existing === null) {
    throw new Refusal(EXIT.USAGE, [`provision init: no --draft and no declaration at '${finalPath}' — a first run needs the draft`]);
  }
  const history = journal?.records() ?? decodeJournal(world.io.readRootFile(join(initDir, JOURNAL_NAME)) ?? '').records;
  return {
    args,
    draft: draft ?? (existing as DraftDeclaration),
    existing,
    source,
    kept,
    pin,
    initDir,
    lockState,
    journalOpen: journal?.openUnfinished ?? unfinishedOf(history),
    history,
  };
}

/* ── discovery and comparison ────────────────────────────────────────────────────── */

function declaredPorts(world: InitWorld): DeclaredPorts {
  return {
    io: world.io,
    exec: world.exec,
    fs: world.fs,
    observeHost: layout => world.observeHost(layout),
    listDeclarations: dir => world.listDeclarations(dir),
    treeReader: world.tree.reader,
  };
}

/**
 * Pairing on a FRESH host: the engine fragment does not exist until `provision apply` writes it
 * later in this same run, so pair.ts's preconditions name it missing. When that is the ONLY reason
 * and apply is a change, the item is a change whose invocation is computed after apply (B5 runs
 * after B4). A pairing done in an earlier run (the journal says so) is right: re-pairing needs
 * `--decide pair.engine=replace`.
 */
function adjustPairing(items: ComparedItem[], facts: HostFacts, completion: DraftCompletion, inputs: Inputs, world: InitWorld): ComparedItem[] {
  const layout = completion.layout;
  adjustPackage(items, facts, completion, inputs, world);
  const index = items.findIndex(row => row.id === 'pair.engine');
  if (layout === null || index < 0) return items;
  const current = items[index] as ComparedItem;
  const replace = inputs.args.decide.get('pair.engine') === 'replace';
  // `history` was read before this run appended anything: every record in it is an earlier run's.
  const paired = inputs.history.some(record => record.item === 'pair.engine' && record.phase === 'done');
  if (paired && !replace && current.list === 'change') {
    items[index] = Object.freeze({
      ...current,
      list: 'right',
      title: 'paired with the work system',
      facts: ['an earlier run paired this agent (journal); re-pair with --decide pair.engine=replace'],
      commands: [],
      action: undefined,
    }) as ComparedItem;
    return items;
  }
  const applyChanges = items.some(row => row.id === 'provision.apply' && row.list === 'change');
  if (current.list !== 'decision' || !applyChanges) return items;
  const options = completion.workUnit === null ? {} : { chosenUnit: completion.workUnit.unit };
  const pretend: Pick<HostFacts, 'work' | 'accounts'> = {
    accounts: facts.accounts,
    work: facts.work.map(unit => ({ ...unit, fragmentPending: false })),
  };
  const later = pairPlan(layout, pretend, inputs.args, options);
  const now = pairPlan(layout, facts, inputs.args, options);
  if (now.kind !== 'blocked' || later.kind !== 'invoke') return items;
  const deferred = pairItem(later, layout);
  items[index] = Object.freeze({
    ...deferred,
    facts: [...deferred.facts, 'the engine fragment is written by provision apply earlier in this run; the pairing runs after it'],
  }) as ComparedItem;
  return items;
}

/**
 * The sealed package (two machines): compare planned it under the production INIT_BASE; the path
 * is THIS run's `<INIT_BASE>/<instance>`. A package an earlier run wrote (the journal says so) is
 * not written again (every run would otherwise mint a new passphrase; `--decide pair.package=again`
 * writes a new one, the old passphrase then opens nothing) — and it is STALE once the agent's own
 * audit trail records a work-host command after it was written (writtenPackageItem): the decision
 * to remove it (`--decide pair.package=remove`, the default on a terminal) is offered then, or
 * whenever the operator asks for it.
 */
export const PACKAGE_AGAIN = 'again';

function adjustPackage(items: ComparedItem[], facts: HostFacts, completion: DraftCompletion, inputs: Inputs, world: InitWorld): void {
  const layout = completion.layout;
  const index = items.findIndex(row => row.id === 'pair.package');
  if (layout === null || index < 0) return;
  const plan = pairPlan(layout, facts, inputs.args, { initDir: inputs.initDir });
  if (plan.kind !== 'package') return;
  const planned = pairItem(plan, layout);
  const written = inputs.history.filter(record => record.item === 'pair.package' && record.phase === 'done').at(-1);
  const decided = inputs.args.decide.get('pair.package');
  if (written !== undefined && decided !== PACKAGE_AGAIN) {
    const present = world.fs.lstat(plan.path)?.type === 'file';
    const contact = present ? engineContactSince(world.io.readRootFile(layout.state.auditFile), written.at) : null;
    items[index] = writtenPackageItem(planned, plan.path, { present, contact, removeAsked: decided === PACKAGE_REMOVE }) as ComparedItem;
    return;
  }
  items[index] = Object.freeze({ ...planned }) as ComparedItem;
}

/** The journal item of the kit's removal (not a compared item: the kit is install.sh's, not the host's). */
export const KIT_REMOVE_ITEM = 'kit.remove';

/**
 * THE KIT, ONCE THE INSTALL CONVERGED (`install.sh --kit` hands it over as --kit-file and
 * --kit-digest-confirmed): it is no longer needed — a re-run uses the installed code — so it is
 * offered for removal: confirmed on a terminal (default no), removed under --yes without one,
 * otherwise named. Only the file install.sh was given, and only while it still hashes to the
 * sha256 install.sh verified (InitIo.removeOperatorFile: a regular file, never a link, the same
 * inode). Journaled. A refusal never fails the run: the install itself is done.
 */
async function offerKitRemoval(world: InitWorld, args: InitArgs, sinks: Sinks, journal: Journal | null): Promise<void> {
  const path = args.kitFile;
  const sha = args.kitDigestConfirmed;
  if (path === null || sha === null || world.fs.lstat(path) === null) return;
  const remove = world.prompter.interactive
    ? await world.prompter.confirm(`The install converged. Remove the kit ${path} you gave install.sh (a re-run needs no kit)?`)
    : args.yes;
  if (!remove) {
    sinks.out(`the kit ${path} is no longer needed here: remove it, or keep it to install another host`);
    return;
  }
  journal?.append(KIT_REMOVE_ITEM, 'begin', { path });
  try {
    world.io.removeOperatorFile(path, sha);
  } catch (error) {
    journal?.append(KIT_REMOVE_ITEM, 'failed', { path });
    sinks.err(sanitizeLine(`provision init: the kit was left in place: ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  journal?.append(KIT_REMOVE_ITEM, 'done', { path });
  sinks.out(`removed the kit ${path}`);
}

function compute(world: InitWorld, inputs: Inputs, facts: HostFacts, answers: ReadonlyMap<string, string>): Computed {
  const options = { existing: inputs.existing, answers };
  let completion = completeDraft(inputs.draft, facts, options);
  let declared: DeclaredFacts | null = null;
  // observeDeclared on the completed layout, then the completion again with those facts (the home
  // reasons and the relocations it settles); a relocation moves the paths, so observe again.
  for (let round = 0; round < 3 && completion.layout !== null; round += 1) {
    const layout = completion.layout;
    declared = observeDeclared(layout, facts, declaredPorts(world), { trustRoot: world.trustRoot });
    const next = completeDraft(inputs.draft, facts, { ...options, declared });
    const same =
      next.declaration !== null &&
      completion.declaration !== null &&
      canonicalDeclaration(next.declaration) === canonicalDeclaration(completion.declaration);
    completion = next;
    if (same) break;
  }
  if (completion.layout === null) declared = null;
  const ctx = {
    source: inputs.source,
    kept: inputs.kept,
    pin: inputs.pin,
    bunArchive: inputs.args.bunArchive,
    args: inputs.args,
    journalOpen: inputs.journalOpen,
    lock: inputs.lockState,
  };
  const items = adjustPairing(compare(facts, completion, declared, ctx), facts, completion, inputs, world);
  return { facts, completion, declared, items };
}

/* ── resolution ──────────────────────────────────────────────────────────────────── */

interface Resolution {
  /** The items act runs: every `change`, and every decision answered by an acting option (as a change). */
  readonly acts: Item[];
  /** Decisions nobody answered (or answered by aborting), in order. */
  readonly open: Item[];
  /** Answered `manual`: their commands go to "still to do". */
  readonly manual: Item[];
  /** Answered `skip`, and every item that depends on them. */
  readonly dropped: Item[];
}

function resolve(items: readonly ComparedItem[], answers: ReadonlyMap<string, string>): Resolution {
  const acts: Item[] = [];
  const open: Item[] = [];
  const manual: Item[] = [];
  const dropped = new Set<string>();
  const droppedItems: Item[] = [];
  for (const item of items) {
    if (item.after.some(id => dropped.has(id))) {
      dropped.add(item.id);
      droppedItems.push(item);
      continue;
    }
    if (item.list === 'right') continue;
    const answer = answers.get(item.id);
    if (item.list === 'change') {
      // A change that edits an operator file or the whole host is never a plain change (compare's
      // law); were one to come through, it still needs a typed answer.
      if ((item.operatorFile || item.hostWide) && answer !== 'act') open.push(item);
      else acts.push(item);
      continue;
    }
    const option = item.options?.find(row => row.id === answer);
    if (answer === undefined || option === undefined) {
      open.push(item);
      continue;
    }
    if (option.resolves === 'skip') {
      dropped.add(item.id);
      droppedItems.push(item);
      continue;
    }
    if (option.resolves === 'manual') {
      manual.push(item);
      continue;
    }
    const action = item.optionActions?.[option.id] ?? item.action;
    if (action === undefined) continue; // relocate/replace already folded into the completion
    acts.push(
      Object.freeze({
        ...item,
        list: 'change',
        action,
        commands: item.optionCommands?.[option.id] ?? item.commands,
      }) as Item,
    );
  }
  return { acts, open, manual, dropped: droppedItems };
}

/**
 * The items that may run while `open` decisions stay open: none that (transitively) waits for a
 * REQUIRED one. An optional open item (pairing printed for later, a log suggestion) holds nothing up.
 */
function independent(acts: readonly Item[], open: readonly Item[], items: readonly Item[]): Item[] {
  const blocked = waitingFor(open.filter(row => !row.optional), items);
  return acts.filter(item => !blocked.has(item.id));
}

/** The ids of `prerequisites` and of every item that (transitively) runs after one of them. */
function waitingFor(prerequisites: readonly Item[], items: readonly Item[]): Set<string> {
  const blocked = new Set(prerequisites.map(row => row.id));
  for (const item of items) if (item.after.some(id => blocked.has(id))) blocked.add(item.id);
  return blocked;
}

/**
 * The acts held back by a BLOCKING item answered `manual` (a refusal whose only answer is to fix
 * it by hand): this run does not do that item, so nothing that runs after it may run either. A
 * non-blocking `manual` (restart the siblings yourself, edit the vhost yourself) holds nothing up (measured, RHEL 10.2: provision apply refused — a copy media
 * root whose parent did not exist — answered `manual`, and api_config.v2_env then ran into the state
 * root apply had not created: ENOENT, exit 4, "a change failed" instead of "do this first").
 */
function heldBackByManual(acts: readonly Item[], manual: readonly Item[], items: readonly Item[]): Item[] {
  const required = manual.filter(row => row.blocking && !row.optional);
  if (required.length === 0) return [];
  const waiting = waitingFor(required, items);
  return acts.filter(item => waiting.has(item.id));
}

/** The `manual` items `item` (transitively) waits for, by id. */
function manualPrerequisites(item: Item, manual: readonly Item[], items: readonly Item[]): string[] {
  return manual.filter(row => row.blocking && !row.optional && waitingFor([row], items).has(item.id)).map(row => row.id);
}

/* ── the secrets (spec §5.8) ─────────────────────────────────────────────────────── */

/** The prompt labels (the drill and the gates script them by label). */
export const SECRET_PROMPTS = Object.freeze({
  v2: Object.freeze({
    host: 'v2 database host',
    port: 'v2 database port',
    socket: 'v2 database unix socket (empty: TCP)',
    user: 'v2 database user',
    names: 'v2 database names (comma list)',
    password: 'v2 database password',
  }),
  v1: Object.freeze({
    host: 'v1 database host',
    port: 'v1 database port',
    socket: 'v1 database unix socket',
    user: 'v1 database user',
    db: 'v1 database name',
    entity: 'v1 API entity',
    password: 'v1 database password',
    webUserCode: 'v1 API_WEB_USER_CODE',
  }),
});

/**
 * The prompts' defaults follow discovery (the action's `socket`: facts.mariadb): the local socket
 * when one exists, else TCP 127.0.0.1:3306 — never `localhost` for TCP (v1's PHP driver reads
 * `localhost` as "use the socket", whatever the port).
 */
async function typeV2(world: InitWorld, found: string | null): Promise<Omit<V2Values, 'deploymentMode'> | null> {
  const p = SECRET_PROMPTS.v2;
  const ask = world.prompter;
  const host = await ask.visible(p.host, found !== null ? 'localhost' : MARIADB_TCP_HOST);
  if (host === null) return null;
  const port = await ask.visible(p.port, String(MARIADB_TCP_PORT));
  if (port === null) return null;
  const socket = await ask.visible(p.socket, found ?? '');
  if (socket === null) return null;
  const user = await ask.visible(p.user, null);
  if (user === null) return null;
  const names = await ask.visible(p.names, null);
  if (names === null) return null;
  const password = await ask.secret(p.password);
  if (password === null) return null;
  return {
    host,
    port,
    socket: socket === '' ? null : socket,
    user,
    password,
    dbNames: names.split(',').map(name => name.trim()).filter(name => name !== ''),
  };
}

async function typeV1(world: InitWorld, transport: 'socket' | 'tcp', found: string | null): Promise<Omit<V1Values, 'transport'> | null> {
  const p = SECRET_PROMPTS.v1;
  const ask = world.prompter;
  const host = await ask.visible(p.host, transport === 'tcp' ? MARIADB_TCP_HOST : 'localhost');
  if (host === null) return null;
  const socket = transport === 'socket' ? await ask.visible(p.socket, found ?? MARIADB_SOCKET_CANDIDATES[0] ?? null) : null;
  if (transport === 'socket' && socket === null) return null;
  const port = transport === 'tcp' ? await ask.visible(p.port, String(MARIADB_TCP_PORT)) : null;
  if (transport === 'tcp' && port === null) return null;
  const user = await ask.visible(p.user, null);
  if (user === null) return null;
  const db = await ask.visible(p.db, null);
  if (db === null) return null;
  const entity = await ask.visible(p.entity, null);
  if (entity === null) return null;
  const password = await ask.secret(p.password);
  if (password === null) return null;
  const webUserCode = await ask.secret(p.webUserCode);
  if (webUserCode === null) return null;
  return { host, socket, port, user, db, entity, password, webUserCode };
}

/* ── act ─────────────────────────────────────────────────────────────────────────── */

interface ActWorld {
  readonly world: InitWorld;
  readonly sinks: Sinks;
  readonly layout: AgentLayout;
  readonly facts: HostFacts;
  readonly completion: DraftCompletion;
  readonly inputs: Inputs;
  readonly journal: Journal;
  readonly lock: LockHandle;
  readonly secrets: ActContext['secrets'];
  readonly answers: ReadonlyMap<string, string>;
  /** B4's outcome, computed between the two act phases (verify is async, act is not). */
  verified: PortResult | null;
}

function selinuxOn(facts: HostFacts): boolean {
  return facts.selinux.mode === 'enforcing' || facts.selinux.mode === 'permissive';
}

function pubhostGid(world: InitWorld): number {
  return world.exec.groupId(PUBHOST_GROUP) ?? world.root.gid;
}

function webTxnPorts(a: ActWorld): WebTxnPorts {
  const { world, layout, facts } = a;
  return {
    io: world.io,
    exec: world.exec,
    lockIo: world.lock,
    get webLock() {
      return { dir: layout.host.locksDir, uid: world.root.uid, gid: pubhostGid(world) };
    },
    web: { server: layout.web.server, bin: layout.web.configtestBin, unit: layout.web.unit },
    lstat: path => world.fs.lstat(path),
    trustRoot: world.trustRoot,
    rootUid: world.root.uid,
    rootGid: world.root.gid,
    selinux: selinuxOn(facts),
    debian: facts.os.family !== 'el',
    sleepSync: world.sleepSync,
    layout,
  };
}

/** B5 at the time it runs: the fragment re-read (apply wrote it earlier in this run). */
function pairNow(a: ActWorld): PortResult {
  const { world, layout, facts, completion, inputs, sinks } = a;
  const text = world.io.readRootFile(layout.engineFragmentPath);
  const fresh: Pick<HostFacts, 'work' | 'accounts'> = {
    accounts: facts.accounts,
    work: facts.work.map(unit => ({ ...unit, fragmentPending: text === null ? null : text.includes(FINGERPRINT_PENDING) })),
  };
  const replace = a.answers.get('pair.engine') === 'replace';
  const options = { ...(completion.workUnit === null ? {} : { chosenUnit: completion.workUnit.unit }), replace };
  const planned = pairPlan(layout, fresh, inputs.args, options);
  if (planned.kind === 'blocked') return { outcome: 'refused', reason: planned.problems.join('; ') };
  if (planned.kind === 'instructions') return { outcome: 'refused', reason: planned.reason };
  if (planned.kind === 'package') return { outcome: 'refused', reason: 'a tls listener is paired through the sealed package (pair.package)' };
  const outcome = pairOneMachine(planned.invocation, layout, { exec: world.exec, io: world.io, sanitize: sanitizeLine });
  for (const line of outcome.lines) sinks.out(`pair: ${line}`);
  return pairPortResult(outcome);
}

/**
 * B5 on two machines: the package is sealed and written, THEN its passphrase is shown once through
 * the prompter (the terminal) — never through the sinks, so never through a captured report, and
 * never in the result (the journal records the outcome only).
 */
function pairPackageNow(a: ActWorld, action: Extract<InitAction, { kind: 'pair_package' }>): PortResult {
  const { world, layout, sinks } = a;
  if (!world.prompter.interactive) return { outcome: 'refused', reason: 'the sealed package needs a terminal: its passphrase is shown once' };
  const outcome = writePairingPackage(layout, action.path, { io: world.io, root: world.root });
  if (outcome.kind === 'failed') return { outcome: 'failed', reason: outcome.reason };
  world.prompter.showOnce([
    '',
    `  the passphrase of ${outcome.path} — shown ONCE, stored nowhere; write it down now:`,
    '',
    `      ${outcome.passphrase}`,
    '',
    '  give it to the work host by a different channel than the file (it opens the package once there)',
    '',
  ]);
  sinks.out(`pair: wrote ${outcome.path} (root 0600); its passphrase was shown above, once`);
  return { outcome: 'done' };
}

function declarationProblems(a: ActWorld, body: string): string[] {
  const { world, layout } = a;
  try {
    const parsed = parseDeclaration(JSON.parse(body), layout.declarationPath);
    return siblingProblems(parsed.layout, layout.declarationPath, world.provisionDeps, new Set());
  } catch (error) {
    if (error instanceof DeclarationError) return error.message.split('\n');
    if (error instanceof SyntaxError) return ['the declaration body is not JSON'];
    throw error;
  }
}

function actContext(a: ActWorld): ActContext {
  const { world, layout, facts, journal, sinks } = a;
  const agentSpec = `${escapeSpec(layout.agentDir)}(/.*)?`;
  const ports: ActPorts = {
    webEdit: { insertApacheReference, insertNginxReference, removeManualLines },
    editOperatorFile: request => editOperatorFile(request, webTxnPorts(a)),
    seedNginxMap: request => seedNginxMap(request, webTxnPorts(a)),
    installBun: request => {
      try {
        installBun(request.archive, request.sums, request.pin, request.asset as BunAsset, request.target, {
          io: world.io,
          exec: world.exec,
          lstat: path => world.fs.lstat(path),
          table: request.table,
          stateDir: a.inputs.initDir,
        });
        return { outcome: 'done' };
      } catch (error) {
        if (error instanceof BunInstallRefused) return { outcome: 'refused', reason: error.message };
        if (error instanceof BunInstallFailed) return { outcome: 'failed', reason: error.message };
        throw error;
      }
    },
    runApply: instance =>
      runProvision(['apply', instance, '--declaration', layout.declarationPath], {
        deps: world.provisionDeps,
        out: line => sinks.out(`  apply: ${line}`),
        err: line => sinks.err(`  apply: ${line}`),
        lockHeld: a.lock,
      }),
    declarationProblems: body => declarationProblems(a, body),
    verifyAgent: () => a.verified ?? { outcome: 'failed', reason: 'the agent check (B4) did not run' },
    pair: () => pairNow(a),
    pairPackage: action => pairPackageNow(a, action),
  };
  return {
    instance: layout.instance,
    layout,
    initDir: a.inputs.initDir,
    io: world.io,
    exec: world.exec,
    journal,
    lstat: path => world.fs.lstat(path),
    realpath: path => world.fs.realpath(path),
    fsTypeOf: path => fsTypeOf(path, facts.mounts),
    tree: world.tree,
    webLock: () => acquireHostLockSync('web', { dir: layout.host.locksDir, io: world.lock, uid: world.root.uid, gid: pubhostGid(world), create: true }),
    selinux: {
      mode: facts.selinux.mode,
      types: REMOVABLE_SELINUX_TYPES,
      agentRuleRegistered: facts.selinux.localFcontext.some(rule => rule.spec === agentSpec),
    },
    family: facts.os.family === 'el' ? 'el' : 'debian',
    secrets: a.secrets,
    root: world.root,
    ports,
    sleepSync: world.sleepSync,
  };
}

const B4_ITEMS = new Set(['verify.agent', 'pair.engine', 'pair.package', 'init.keep_ref']);

/** Act in two phases around B4 (async): everything before verify.agent, then B4/B5/keep_ref. */
async function act(a: ActWorld, items: readonly Item[]): Promise<ActReport> {
  const ctx = actContext(a);
  const first = items.filter(item => !B4_ITEMS.has(item.id));
  const second = items.filter(item => B4_ITEMS.has(item.id));
  const before = executeItems(first, ctx);
  if (second.length === 0) return before;
  if (!before.ok) {
    const skipped = second.map(item => ({ item: item.id, status: 'not_reached' as const, detail: 'not reached — an earlier item did not finish' }));
    return { ...before, outcomes: [...before.outcomes, ...skipped] };
  }
  if (second.some(item => item.id === 'verify.agent')) {
    const result = await verifyAgent(a.layout, { io: a.world.io, exec: a.world.exec, sleep: a.world.sleep, ...(a.world.healthFetch === undefined ? {} : { fetch: a.world.healthFetch }) }, { selinux: selinuxOn(a.facts) });
    for (const fact of result.facts) a.sinks.out(`verify: ${fact}`);
    if (!result.ok) for (const command of result.commands) a.sinks.out(`verify: see $ ${command}`);
    a.verified = verifyPortResult(result);
  }
  const after = executeItems(second, ctx);
  return {
    ok: after.ok,
    exit: after.exit,
    outcomes: [...before.outcomes, ...after.outcomes],
    stillToDo: [...before.stillToDo, ...after.stillToDo],
  };
}

/* ── the run ─────────────────────────────────────────────────────────────────────── */

/**
 * The report. `terminal` is the prompter's (NOT `--dry-run`'s): a manual-only decision is "needs
 * your action" only where run.ts applies needs_action — a run on a terminal; a dry run on one
 * previews that run. Without a terminal it is an open decision, as the --yes refusal says.
 */
function printReport(sinks: Sinks, items: readonly Item[], answers: ReadonlyMap<string, string>, terminal: boolean): void {
  for (const line of renderLists(items, { answers, interactive: terminal })) sinks.out(line);
  sinks.out(`provision init: ${countLine(items, terminal)}`);
}

/**
 * The draft discovery reads: the operator's, with host.web's answer as its `web.server` when the draft
 * names none — the web server's facts (its unit, binaries, vhosts, maps) are observed for ONE server,
 * so the answer must reach discovery, not only the completion.
 */
export function observedDraft(draft: Inputs['draft'], answers: ReadonlyMap<string, string>): Inputs['draft'] {
  const answered = answers.get('host.web');
  if (draft.web?.server !== undefined || (answered !== 'apache' && answered !== 'nginx')) return draft;
  return { ...draft, web: { ...draft.web, server: answered } };
}

/** What settleDecisions settled without asking (decision_class.ts): the run reports both. */
export interface Unasked {
  /** `needs_action` decisions answered manual, by id (the end of the run lists them with the re-run command). */
  readonly needsAction: Set<string>;
  /** `auto` decisions: id → the only option. */
  readonly auto: Map<string, string>;
}

/**
 * Settles every unanswered decision (interactive only) by its class (decision_class.ts, the one
 * rule): `needs_action` answered manual and `auto` answered with its only option WITHOUT asking;
 * `typed` and `choose` asked through the prompter (which applies the Enter rule). The list is
 * recomputed after each answer (`recompute`; run.ts: host.web's observes again) — an answer can
 * bring a new decision. A decision the prompter returns null for (aborted, or Enter refused by a
 * script) stays open. Exported for its gates (tests/init_run.test.ts), which recompute nothing.
 */
export async function settleDecisions<T extends { readonly items: readonly Item[] }>(
  prompter: Prompter,
  computed: T,
  answers: Map<string, string>,
  unasked: Unasked,
  recompute: (current: T, id: string, answer: string) => T,
): Promise<T> {
  const declined = new Set<string>();
  let current = computed;
  for (;;) {
    const next = current.items.find(item => item.list === 'decision' && !answers.has(item.id) && !declined.has(item.id) && (item.options?.length ?? 0) > 0);
    if (next === undefined) return current;
    const prompt = classifyDecision(next);
    let answer: string | null;
    if (prompt.kind === 'needs_action') {
      answer = prompt.enter;
      if (answer !== null) unasked.needsAction.add(next.id);
    } else if (prompt.kind === 'auto') {
      answer = prompt.enter;
      if (answer !== null) unasked.auto.set(next.id, answer);
    } else answer = await prompter.choose(next);
    if (answer === null) {
      declined.add(next.id);
      continue;
    }
    answers.set(next.id, answer);
    current = recompute(current, next.id, answer);
  }
}

/** settleDecisions on the run's world: host.web's answer, when it changes the server, observes again. */
function askDecisions(world: InitWorld, inputs: Inputs, computed: Computed, answers: Map<string, string>, observe: () => HostFacts, unasked: Unasked): Promise<Computed> {
  return settleDecisions(world.prompter, computed, answers, unasked, (current, id, answer) => {
    const reobserve = id === 'host.web' && answer !== current.facts.web.server;
    return compute(world, inputs, reobserve ? observe() : current.facts, answers);
  });
}

/**
 * The command that runs init again for this instance (the end of a run that left something to the
 * operator). Once rerun.env exists (keep_ref wrote it: the agent code is installed), the installed
 * install.sh needs no source; before that, the operator's own first command is the only one that
 * works — init never saw it whole (install.sh hands over a staged copy), so it is named, not quoted.
 */
export function rerunCommand(instance: string, agentDir: string | null, rerunEnvPresent: boolean): string {
  if (rerunEnvPresent && agentDir !== null) return `sh ${join(agentDir, 'deploy', 'install.sh')} ${instance}`;
  return `sh install.sh ${instance} with the same --source or --kit as this run (no agent code is installed yet, so a re-run needs it)`;
}

function lockFailure(error: unknown, instance: string): Refusal | null {
  if (error instanceof LockBusy) {
    return refuse(`provision init: instance '${instance}' is locked by ${describeHolder(error.holder)}; wait or check that process`);
  }
  if (error instanceof LockRefused) return refuse(`provision init: ${error.message}`);
  return null;
}

export async function runInit(argv: readonly string[], deps: InitDeps = initHostDeps()): Promise<number> {
  const guardedOut = guarded(deps.out);
  const guardedErr = guarded(deps.err);
  const sinks: Sinks = { out: line => guardedOut(sanitizeLine(line)), err: line => guardedErr(sanitizeLine(line)) };
  const args = parseInitArgs(argv);
  if ('error' in args) {
    deps.err(`provision init: ${args.error}`);
    for (const line of initUsageLines()) deps.err(line);
    return EXIT.USAGE;
  }
  for (const id of args.decide.keys()) {
    if (!isKnownItemId(id)) {
      deps.err(`provision init: --decide ${id}: no such item`);
      return EXIT.USAGE;
    }
  }
  if (deps.world === undefined) {
    deps.err('provision init: no host to act on (this build was given no world)');
    return EXIT.USAGE;
  }
  let lock: LockHandle | null = null;
  try {
    const world = deps.world();
    // 1. The footgun guards, before any other work.
    const guards = footgunProblems(world);
    if (guards.length > 0) throw refuse(...guards.map(line => `provision init: ${line} — ${HANDOVER_HINT}`));

    // 2. INIT_BASE's ancestry, then the instance lock (dry run: a peek).
    const ancestry = judgeAncestors(`INIT_BASE '${world.initBase}'`, join(world.initBase, args.instance), world.trustRoot, p => world.fs.lstat(p), world.root.uid, new Set());
    if (ancestry.length > 0) throw refuse(...ancestry.map(line => `provision init: ${line}`));
    const initDir = join(world.initBase, args.instance);
    // No TTY without --yes IS a dry run (spec §1.2): no lock taken, no journal, nothing written.
    const dry = args.dryRun || (!world.prompter.interactive && !args.yes);
    let lockState: LockState = { held: false };
    if (dry) {
      try {
        lockState = peekInstanceLock(args.instance, { base: world.initBase, io: world.lock, uid: world.root.uid, gid: world.root.gid });
      } catch (error) {
        throw lockFailure(error, args.instance) ?? error;
      }
      if (lockState.held) sinks.out(`provision init: instance '${args.instance}' is being changed by ${describeHolder(lockState.holder)} right now; this report may already be stale`);
    } else {
      try {
        lock = acquireInstanceLockSync(args.instance, 'ex', { base: world.initBase, io: world.lock, verb: 'init', uid: world.root.uid, gid: world.root.gid });
      } catch (error) {
        throw lockFailure(error, args.instance) ?? error;
      }
    }
    let journal: Journal | null = null;
    if (!dry) {
      try {
        journal = openJournal(initDir, world.io, { uid: world.root.uid, gid: world.root.gid, now: world.now });
      } catch (error) {
        if (error instanceof JournalFormatError) throw refuse(`provision init: the journal in ${initDir} is not one init wrote: ${error.message}`);
        throw error;
      }
    }

    // 3. Inputs.
    const inputs = readInputs(world, args, initDir, journal, lockState);
    if (inputs.journalOpen.length > 0 && !args.resume) {
      const names = [...new Set(inputs.journalOpen.map(record => record.item))].join(', ');
      if (dry) sinks.out(`provision init: an earlier run did not finish (${names}); a real run needs --resume`);
      else throw refuse(`provision init: an earlier run did not finish: ${names} — re-run with --resume`);
    }

    // 4. Discovery and comparison.
    const answers = new Map(args.decide);
    const observe = () => observeHostWide(observedDraft(inputs.draft, answers), world);
    let computed = compute(world, inputs, observe(), answers);
    if (args.resume && journal !== null && journal.openUnfinished.length > 0) {
      const layout = computed.completion.layout;
      if (layout === null) throw refuse('provision init: --resume needs a declaration whose layout derives; fix the draft first');
      const resumed = resumeOpen(journal.openUnfinished, actContext({ world, sinks, layout, facts: computed.facts, completion: computed.completion, inputs, journal, lock: lock as LockHandle, secrets: {}, answers, verified: null }));
      for (const row of resumed.settled) sinks.out(`resume: [${row.phase}] ${row.item}: ${row.detail}`);
      // An idempotent action is not settled by resume but by the run below, which re-observes it and
      // acts again with its own begin: its old begin is closed now, or it would stay open forever.
      for (const item of resumed.rerun) {
        if (!resumed.settled.some(row => row.item === item)) {
          journal.append(item, 'skipped', { resumed: true, reason: 'closed by --resume: this run re-observes it and acts again' });
        }
        sinks.out(`resume: ${item} is re-run below`);
      }
      if (resumed.decisions.length > 0) {
        throw refuse(...resumed.decisions.map(row => `provision init: ${row.item}: '${row.target}' matches neither the shown nor the written bytes — compare it with ${row.backup} and fix it by hand, then re-run`));
      }
      computed = compute(world, inputs, observe(), answers);
    }
    const problems = unknownAnswers(computed.items, answers);
    if (problems.length > 0) throw new Refusal(EXIT.USAGE, problems.map(line => `provision init: ${line}`));

    // 5. The report; the decisions; the confirmation; the secrets.
    printReport(sinks, computed.items, answers, world.prompter.interactive);
    const prompter = world.prompter;
    const interactive = prompter.interactive && !args.dryRun;
    const unasked: Unasked = { needsAction: new Set(), auto: new Map() };
    if (interactive) {
      const before = new Map(answers);
      computed = await askDecisions(world, inputs, computed, answers, observe, unasked);
      for (const [id, option] of unasked.auto) {
        // The label of the option as the final list shows it (a recompute may have reworded it).
        const label = computed.items.find(row => row.id === id)?.options?.find(row => row.id === option)?.label ?? option;
        sinks.out(`[${id}] auto: the only option — ${option}: ${label}`);
      }
      if (answers.size !== before.size) {
        sinks.out('provision init: the report with your answers:');
        printReport(sinks, computed.items, answers, true);
      }
    }
    const resolution = resolve(computed.items, answers);
    const somethingToDo = resolution.acts.length > 0 || resolution.open.some(item => !item.optional);
    if (args.dryRun || (!interactive && !args.yes)) {
      if (!args.dryRun) sinks.out('not a terminal: re-run with --yes (and --decide …) to act');
      return somethingToDo ? EXIT.DRIFT : EXIT.OK;
    }
    const nonOptionalDropped = resolution.dropped.filter(item => !item.optional);
    if (nonOptionalDropped.length > 0) {
      throw refuse(`provision init: skipping leaves required items undone: ${nonOptionalDropped.map(item => item.id).join(', ')}`);
    }
    const blockingOpen = resolution.open.filter(item => item.blocking);
    // The decisions init can do nothing about (needs_action: answered manual WITHOUT asking). A
    // blocking one stops the run BEFORE anything is done, exactly as an unanswered blocking decision
    // does: the operator typed nothing, so an unsupported OS or a missing vhost must not let the
    // independent changes run (only an explicit `manual` — typed or --decide — lets them, the
    // pre-P2 rule, heldBackByManual). A non-blocking one is listed at the end of the run.
    const needsAction = resolution.manual.filter(item => unasked.needsAction.has(item.id));
    const blockingAction = needsAction.filter(item => item.blocking && !item.optional);
    const rerun = () => rerunCommand(args.instance, computed.completion.layout?.agentDir ?? null, world.fs.lstat(join(initDir, RERUN_ENV_NAME)) !== null);
    if (blockingOpen.length > 0 || blockingAction.length > 0) {
      if (needsAction.length > 0) for (const line of renderNeedsAction(needsAction, rerun())) sinks.out(line);
      // Without a terminal a manual-only decision stays open (--yes resolves none): the report kept
      // it in list 3 with its --decide; the refusal names what is still the operator's to do by
      // hand and how to run init again, as the report's own line does.
      const manualOnlyOpen = blockingOpen.filter(item => classifyDecision(item).kind === 'needs_action');
      throw refuse(
        ...(blockingOpen.length > 0
          ? [
              `provision init: ${blockingOpen.length} item(s) need your decision before anything is done: ${blockingOpen.map(item => item.id).join(', ')}`,
              ...blockingOpen.flatMap(item => item.commands.map(command => `  $ ${command}`)),
              ...(manualOnlyOpen.length > 0
                ? [`provision init: init cannot do ${manualOnlyOpen.map(item => item.id).join(', ')}: do it by hand (the commands above), then: ${rerun()}`]
                : []),
            ]
          : []),
        ...(blockingAction.length > 0
          ? [`provision init: ${blockingAction.length} item(s) need your action before anything is done: ${blockingAction.map(item => item.id).join(', ')} — do them (the commands are above), then: ${rerun()}`]
          : []),
      );
    }
    // A blocking item answered `manual` holds back what runs after it, exactly as an open decision does.
    const heldBack = heldBackByManual(resolution.acts, resolution.manual, computed.items);
    let runnable = independent(resolution.acts, resolution.open, computed.items).filter(item => !heldBack.includes(item));
    if (interactive && runnable.length > 0) {
      const confirmed = await prompter.confirm(`Apply these ${runnable.length} changes?`);
      if (!confirmed) throw refuse('provision init: declined by the operator; nothing was done');
    }
    // The secrets, typed before the first begin (spec §1.2): no TTY makes each a decision.
    const secrets: { v2?: V2Values; v1?: V1Values } = {};
    const secretOpen: Item[] = [];
    for (const item of runnable.filter(row => row.secret !== undefined)) {
      const action = item.action;
      const typed = !interactive
        ? null
        : item.secret === 'v2_env'
          ? await typeV2(world, action?.kind === 'v2_env' ? action.socket : null)
          : await typeV1(world, action?.kind === 'v1_config' ? action.transport : 'tcp', action?.kind === 'v1_config' ? action.socket : null);
      if (typed === null) {
        secretOpen.push(Object.freeze({ ...item, list: 'decision', title: `${item.title}: create it on a terminal or by hand (guide §5)` }) as Item);
        continue;
      }
      try {
        if (item.secret === 'v2_env' && item.action?.kind === 'v2_env') {
          const values = { ...(typed as Omit<V2Values, 'deploymentMode'>), deploymentMode: item.action.deploymentMode };
          v2Assignments(values);
          secrets.v2 = values;
        } else if (item.action?.kind === 'v1_config') {
          const values = { ...(typed as Omit<V1Values, 'transport'>), transport: item.action.transport };
          v1Literals(values);
          secrets.v1 = values;
        }
      } catch (error) {
        if (!(error instanceof ApiConfigRefused)) throw error;
        sinks.err(`provision init: ${error.message}`);
        secretOpen.push(Object.freeze({ ...item, list: 'decision', title: `${item.title}: the typed value was refused` }) as Item);
      }
    }
    // The sealed package shows its passphrase once on the terminal: without one it is not written
    // (the loose-file pairing instructions stay in its commands).
    if (!interactive) {
      for (const item of runnable.filter(row => row.action?.kind === 'pair_package')) {
        secretOpen.push(Object.freeze({ ...item, list: 'decision', title: `${item.title}: needs a terminal (the passphrase is shown once)`,
          commands: computed.completion.layout === null ? [...item.commands] : twoMachineInstructions(computed.completion.layout, args.pairName, null),
        }) as Item);
      }
    }
    const stillOpen = [...resolution.open, ...secretOpen];
    runnable = independent(runnable.filter(item => !secretOpen.some(open => open.id === item.id)), stillOpen, computed.items);
    const notReached = secretOpen.length === 0 ? heldBack : heldBack.filter(item => !secretOpen.some(open => open.id === item.id));

    // 6-7. Act, B4, B5.
    const layout = computed.completion.layout;
    let report: ActReport = { ok: true, exit: 0, outcomes: [], stillToDo: [] };
    if (runnable.length > 0) {
      if (layout === null || journal === null || lock === null) throw refuse('provision init: there is something to do but no layout derives from the draft');
      report = await act({ world, sinks, layout, facts: computed.facts, completion: computed.completion, inputs, journal, lock, secrets, answers, verified: null }, runnable);
      for (const outcome of report.outcomes) {
        const line = `[${outcome.status}] ${outcome.item}: ${outcome.detail}`;
        if (outcome.status === 'failed' || outcome.status === 'refused' || outcome.status === 'rolled_back') sinks.err(line);
        else sinks.out(line);
      }
    }

    // 8. Still to do; cleanup.
    const still = [
      ...report.stillToDo.map(line => `$ ${line}`),
      ...resolution.manual.filter(item => !unasked.needsAction.has(item.id)).flatMap(item => [`[${item.id}] ${item.title}`, ...item.commands.map(command => `  $ ${command}`)]),
      ...stillOpen.map(item => `[${item.id}] ${item.title} (${item.optional ? 'optional' : 'needs your decision'})`),
      ...notReached.map(item => `[${item.id}] ${item.title} (not done: it runs after ${manualPrerequisites(item, resolution.manual, computed.items).join(', ')})`),
    ];
    if (still.length > 0) {
      sinks.out('still to do:');
      for (const line of still) sinks.out(`  ${line}`);
    }
    // The non-blocking needs_action decisions (a blocking one refused above): last, with their facts
    // and commands, and how to run init again once they are done (rerun.env is read NOW: this run's
    // keep_ref may just have written it).
    if (needsAction.length > 0) for (const line of renderNeedsAction(needsAction, rerun())) sinks.out(line);
    if (!report.ok) return report.exit;
    const requiredOpen = stillOpen.filter(item => !item.optional);
    if (requiredOpen.length > 0) {
      sinks.err(`provision init: REFUSED — still open: ${requiredOpen.map(item => item.id).join(', ')}`);
      return EXIT.REFUSED;
    }
    const requiredNotReached = notReached.filter(item => !item.optional);
    if (requiredNotReached.length > 0) {
      const first = [...new Set(requiredNotReached.flatMap(item => manualPrerequisites(item, resolution.manual, computed.items)))];
      sinks.err(
        `provision init: REFUSED — not done: ${requiredNotReached.map(item => item.id).join(', ')}; ` +
          `they run after ${first.join(', ')}, answered manual: do it (the commands are above), then run init again`,
      );
      return EXIT.REFUSED;
    }
    if (journal !== null) cleanupAfterSuccess({ initDir, io: world.io, lstat: path => world.fs.lstat(path) });
    await offerKitRemoval(world, args, sinks, journal);
    sinks.out(`provision init: instance '${args.instance}' ${runnable.length === 0 ? 'is right; nothing was changed' : 'converged'}`);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof Refusal) {
      for (const line of error.lines) deps.err(sanitizeLine(line));
      return error.code;
    }
    if (error instanceof SecretOutputRefused) {
      deps.err(error.message);
      return EXIT.REFUSED;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.err(sanitizeLine(`provision init: FAILED: ${message.split('\n')[0]}`));
    return EXIT.FAILED;
  } finally {
    lock?.release();
  }
}
