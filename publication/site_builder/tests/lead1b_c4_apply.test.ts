/**
 * LEAD-1b G18 (commit C4) — ROOT DOES THE UPGRADE IN THE SPEC §5 ORDER.
 *
 * Written BEFORE the implementation (audits/2026-09-26_full/LEAD-1b_SPEC.md §6); every row
 * is red on the pre-LEAD-1b HEAD, and says why.
 *
 * Recorded io over a synthetic host, for install, upgrade, site removal and instance removal:
 * private group → identity → membership; the daemon STOPPED before ownership is normalised;
 * units written, reloaded and their sockets enabled; the rule NARROWED before the daemon is
 * started (an old daemon's transient start is denied from then on); the legacy agent LOCKED,
 * its HOME ARCHIVED (never copied: it was the cross-site plant channel); removal narrows the
 * rule before a site's units go; `userdel` never appears.
 *
 * Written red-first against 75ccb35a38 (the pre-LEAD-1b HEAD); parked as `.gate.ts` until
 * the implementation it gates landed, and renamed into the suite by that same change.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { legacyTransientUnitGlob } from '../src/drivers/agent_identity';
import { apply, type ExecResult, type PathFacts, type ProvisionIo, turnHomeListings } from '../src/provision/apply';
import { derive, markerContent, type InstanceLayout, type InstanceManifest } from '../src/provision/layout';
import { type Action, changesTheHost, type HostState, markedRoots, markerPath, observedPaths, plan } from '../src/provision/plan';
import { ledgerOrdinals } from '../src/provision/identities';
import { removalPlan } from '../src/provision/remove';
import { renderAll } from '../src/provision/render';
import { parseManifest } from '../src/provision/schema';
import { caught, gateManifestDoc, identityName, loadRule, type AgentLedger, type LedgerAccount, type LedgerGroup } from './support/lead1b_contract';
import { type FakeAccount, fakeLedger, useraddAccount, usermodAccount } from './support/fake_accounts';
import { escapeRegExp } from '../../../test/helpers/regex_escape.ts';

const prefixes: string[] = [];
afterAll(() => {
  for (const prefix of prefixes) rmSync(prefix, { recursive: true, force: true });
});

const INSTANCE = 'museo';
const SVC = `dedalo-site-${INSTANCE}`;
const LEGACY = `dedalo-agent-${INSTANCE}`;
const SVC_UID = 990;
const INSTANCE_GID = 990;

/** Site k's identity (the leaf's spelling, or the spec's while the leaf is absent — G1 owns that red). */
function identity(k: number): Promise<string> {
  return identityName(INSTANCE, k);
}

/** Every command a plan contains, as argv arrays, in plan order. */
function commandsOf(actions: readonly Action[]): string[][] {
  return actions.filter(action => 'argv' in action).map(action => [...(action as { argv: readonly string[] }).argv]);
}

function literalBody(action: Action): string | null {
  return action.kind === 'file' && action.content.source === 'literal' ? action.content.body : null;
}

/* ────────────────────────────────────────────────────────────────────────────────────
 * G18 — a synthetic host, recorded
 * ──────────────────────────────────────────────────────────────────────────────────── */

interface FakeHost {
  readonly accounts: Map<string, FakeAccount>;
  readonly groups: Map<string, LedgerGroup>;
  unitEnabled: boolean;
  unitActive: boolean;
  readonly enabledSockets: Set<string>;
  nextUid: number;
  nextGid: number;
  /** Accounts with a process still running (what `pgrep -U` finds). */
  liveUids?: Set<string>;
}

interface Op {
  readonly op: string;
  readonly args: readonly unknown[];
}

interface Synthetic {
  readonly prefix: string;
  readonly layout: InstanceLayout;
  readonly manifest: InstanceManifest;
  readonly host: FakeHost;
  readonly ops: Op[];
  readonly access: Map<string, { owner: string; group: string; mode: number }>;
  io: ProvisionIo;
}

function relocate(value: unknown, prefix: string): unknown {
  if (typeof value === 'string') return value.startsWith('/') ? join(prefix, value) : value;
  if (Array.isArray(value)) return value.map(entry => relocate(entry, prefix));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, relocate(entry, prefix)]));
  }
  return value;
}

function declare(prefix: string, slugs: readonly string[]): { layout: InstanceLayout; manifest: InstanceManifest } {
  const raw = relocate(gateManifestDoc(INSTANCE, slugs), prefix) as Record<string, any>;
  raw.webspace_base = join(prefix, 'srv/www');
  raw.paths = {
    config_base: join(prefix, 'etc/dedalo_sites/instances'),
    state_base: join(prefix, 'var/lib/dedalo_sites'),
    unit_dir: join(prefix, 'etc/systemd/system'),
    vhost_dir: join(prefix, 'etc/nginx/sites-available'),
    polkit_rules_dir: join(prefix, 'etc/polkit-1/rules.d'),
    tmpfiles_dir: join(prefix, 'etc/tmpfiles.d'),
  };
  const manifest = parseManifest(raw, { source: 'G18' });
  return { layout: derive(manifest), manifest };
}

function onHost(prefix: string, path: string): string {
  return path.startsWith(prefix) ? path : join(prefix, path);
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

/**
 * THE IO, RECORDED — every door in one ordered log. Doors the gate does not know yet (a new
 * io method LEAD-1b adds, e.g. to archive or unlink) are recorded and, for the three
 * obvious spellings, performed; anything else throws naming itself, so the harness is
 * extended here rather than silently skipping an effect.
 */
function makeIo(s: Omit<Synthetic, 'io'>): ProvisionIo {
  const on = (path: string) => onHost(s.prefix, path);
  const record = (op: string, ...args: unknown[]) => s.ops.push({ op, args });
  const base: Record<string, (...args: any[]) => unknown> = {
    stat(path: string): PathFacts | null {
      const real = on(path);
      let entry;
      try {
        entry = lstatSync(real);
      } catch {
        return null;
      }
      const recorded = s.access.get(path);
      return {
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        mode: recorded?.mode ?? entry.mode & 0o7777,
        owner: recorded?.owner ?? 'root',
        group: recorded?.group ?? 'root',
      };
    },
    readFile(path: string): string | null {
      try {
        return readFileSync(on(path), 'utf8');
      } catch {
        return null;
      }
    },
    mkdir(path: string): void {
      record('mkdir', path);
      mkdirSync(on(path), { recursive: true });
    },
    writeFile(path: string, body: string, mode: number): void {
      record('writeFile', path);
      mkdirSync(dirname(on(path)), { recursive: true });
      writeFileSync(on(path), body, 'utf8');
      const recorded = s.access.get(path);
      s.access.set(path, { owner: recorded?.owner ?? 'root', group: recorded?.group ?? 'root', mode });
    },
    symlink(path: string, target: string): void {
      record('symlink', path, target);
      symlinkSync(target, on(path));
    },
    chown(path: string, owner: string, group: string): void {
      record('chown', path, owner, group);
      const recorded = s.access.get(path);
      s.access.set(path, { owner, group, mode: recorded?.mode ?? lstatSync(on(path)).mode & 0o7777 });
    },
    chmod(path: string, mode: number): void {
      record('chmod', path, mode);
      const recorded = s.access.get(path);
      s.access.set(path, { owner: recorded?.owner ?? 'root', group: recorded?.group ?? 'root', mode });
    },
    rename(from: string, to: string): void {
      record('rename', from, to);
      mkdirSync(dirname(on(to)), { recursive: true });
      renameSync(on(from), on(to));
    },
    unlink(path: string): void {
      record('unlink', path);
      rmSync(on(path), { force: true });
    },
    mintToken: () => 'zzz-minted-zzz',
    hashPassword: (password: string) => `$2y$fake$${password.length}`,
    exec(argv: readonly string[]): ExecResult {
      record('exec', [...argv]);
      const host = s.host;
      const name = argv[argv.length - 1] as string;
      if (argv[0] === 'groupadd') host.groups.set(name, { name, gid: host.nextGid++, members: [] });
      if (argv[0] === 'useradd') {
        const primary = host.groups.get(flagValue(argv, '--gid') ?? '');
        host.accounts.set(name, useraddAccount(name, host.nextUid++, primary?.gid ?? -1, flagValue(argv, '--comment') ?? ''));
        for (const extra of (flagValue(argv, '--groups') ?? '').split(',').filter(Boolean)) {
          const group = host.groups.get(extra);
          if (group) host.groups.set(extra, { ...group, members: [...group.members, name] });
        }
      }
      if (argv[0] === 'gpasswd' && argv[1] === '-a') {
        const group = host.groups.get(argv[3] as string);
        if (group && !group.members.includes(argv[2] as string)) host.groups.set(group.name, { ...group, members: [...group.members, argv[2] as string] });
      }
      // A removal or an archive spelled as a command changes the fake host like the io doors do.
      if (argv[0] === 'rm') for (const path of argv.slice(1).filter(arg => arg.startsWith('/'))) rmSync(on(path), { recursive: true, force: true });
      if (argv[0] === 'mv') {
        const [from, to] = argv.slice(1).filter(arg => arg.startsWith('/'));
        if (from && to) {
          mkdirSync(dirname(on(to)), { recursive: true });
          renameSync(on(from), on(to));
        }
      }
      if (argv[0] === 'usermod') {
        const account = host.accounts.get(name);
        if (account) host.accounts.set(name, usermodAccount(account, argv));
      }
      // `systemd-tmpfiles --create <file>`: every `d` line of the file as written, made root's.
      if (argv[0] === 'systemd-tmpfiles' && argv[1] === '--create') {
        for (const line of readFileSync(on(argv[2] as string), 'utf8').split('\n')) {
          const [type, path, mode, owner, group] = line.trim().split(/\s+/);
          if (type !== 'd' || !path || !mode || !owner || !group) continue;
          mkdirSync(on(path), { recursive: true });
          s.access.set(path, { owner, group, mode: Number.parseInt(mode, 8) });
        }
      }
      // `find … -user <svc> … -execdir chmod …` (normalise_modes): RUN FOR REAL over the fake
      // host's tree, where every entry the gate created is the service user's — so the gate
      // reads the modes the real command leaves, not the argv it was handed. The NUMERIC uid,
      // never the name: a uid with no passwd entry (GitLab runs the CI image as bare 1001)
      // has username 'unknown', and `find -user unknown` dies.
      if (argv[0] === 'find') {
        const real = argv.map((arg, index) => (index > 0 && argv[index - 1] === '-user' && arg === SVC ? String(userInfo().uid) : arg));
        const ran = spawnSync(real[0] as string, real.slice(1), { encoding: 'utf8' });
        return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' };
      }
      // `pgrep -U <owner>`: 1 = no process of that uid is left (the quiesce proof).
      if (argv[0] === 'pgrep') return { code: host.liveUids?.has(name) ? 0 : 1, stdout: '', stderr: '' };
      if (argv[0] === 'systemctl') {
        const verb = argv.find((arg, index) => index > 0 && !arg.startsWith('-')) ?? '';
        const units = argv.slice(argv.indexOf(verb) + 1).filter(arg => !arg.startsWith('-'));
        const daemon = units.includes(s.layout.unitName);
        if (verb === 'enable' && daemon) host.unitEnabled = true;
        if ((verb === 'start' || verb === 'restart') && daemon) host.unitActive = true;
        if (verb === 'enable' && argv.includes('--now') && daemon) host.unitActive = true;
        if (verb === 'stop' && daemon) host.unitActive = false;
        for (const unit of units) {
          if (!unit.endsWith('.socket')) continue;
          if (verb === 'enable') host.enabledSockets.add(unit);
          if (verb === 'disable') host.enabledSockets.delete(unit);
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return new Proxy(base, {
    get(target, key) {
      if (typeof key !== 'string' || key in target) return (target as Record<string, unknown>)[key as string];
      if (key === 'then') return undefined;
      return (...args: unknown[]) => {
        record(key, ...args);
        if (key === 'remove' || key === 'rm') {
          rmSync(on(args[0] as string), { recursive: true, force: true });
          return;
        }
        if (key === 'move' || key === 'archive') {
          mkdirSync(dirname(on(args[1] as string)), { recursive: true });
          renameSync(on(args[0] as string), on(args[1] as string));
          return;
        }
        throw new Error(`LEAD-1b G18 harness: apply used an io door the gate does not model: '${key}'. Add it to makeIo().`);
      };
    },
  }) as unknown as ProvisionIo;
}

function observe(s: Synthetic): HostState {
  const entries: HostState['entries'] = {};
  const secretsDir = s.layout.secretsDir;
  const agentLedger = fakeLedger(s.layout, s.host.accounts.values(), s.host.groups.values());
  // As the real observer does: the agent-unit paths of every ordinal the ledger binds.
  for (const path of observedPaths(s.layout, s.manifest, ledgerOrdinals(s.layout, agentLedger))) {
    const facts = s.io.stat(path);
    if (!facts) continue;
    const real = onHost(s.prefix, path);
    (entries as Record<string, unknown>)[path] = {
      type: facts.type,
      mode: facts.mode,
      owner: facts.owner,
      group: facts.group,
      ...(facts.type === 'file' && !path.startsWith(`${secretsDir}/`) ? { content: readFileSync(real, 'utf8') } : {}),
      ...(facts.type === 'symlink' ? { target: readlinkSync(real) } : {}),
      ...(facts.type === 'dir' ? { empty: readdirSync(real).length === 0 } : {}),
      mtimeMs: lstatSync(real).mtimeMs,
    };
  }
  return {
    users: [...s.host.accounts.keys()],
    groups: [...s.host.groups.keys(), 'www-data', `dedalo-${INSTANCE}`],
    entries,
    unitEnabled: s.host.unitEnabled,
    unitActive: s.host.unitActive,
    // As the real observer lists them (`turnHomeListings`, the same function).
    turnHomeEntries: turnHomeListings(s.layout, ledgerOrdinals(s.layout, agentLedger).values(), path => onHost(s.prefix, path)),
    agentLedger,
    pid1Version: 255,
    enabledSockets: [...s.host.enabledSockets],
  } as unknown as HostState;
}

function synthetic(slugs: readonly string[], prefix = mkdtempSync(join(tmpdir(), 'l1b-g18-'))): Synthetic {
  if (!prefixes.includes(prefix)) prefixes.push(prefix);
  const { layout, manifest } = declare(prefix, slugs);
  const s: Omit<Synthetic, 'io'> = {
    prefix,
    layout,
    manifest,
    host: {
      accounts: new Map(),
      groups: new Map(),
      unitEnabled: false,
      unitActive: false,
      enabledSockets: new Set(),
      nextUid: 1000,
      nextGid: 2000,
    },
    ops: [],
    access: new Map(),
  };
  return Object.assign(s, { io: makeIo(s) }) as Synthetic;
}

/** A host as a pre-LEAD-1b `provision apply` left it: both accounts, a running daemon, a used agent HOME. */
function legacyHost(s: Synthetic): void {
  s.host.groups.set(SVC, { name: SVC, gid: INSTANCE_GID, members: [] });
  s.host.accounts.set(SVC, useraddAccount(SVC, SVC_UID, INSTANCE_GID, `Dedalo site builder instance ${INSTANCE}`));
  s.host.accounts.set(LEGACY, useraddAccount(LEGACY, 991, INSTANCE_GID, `Dedalo site builder instance ${INSTANCE}`));
  s.host.unitEnabled = true;
  s.host.unitActive = true;
  // The legacy agent HOME, with a plant in it — the shared cross-site channel LEAD-1b retires.
  const home = onHost(s.prefix, s.layout.roots.home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{"hooks":{"planted":true}}\n');
  s.access.set(s.layout.roots.home, { owner: SVC, group: SVC, mode: 0o2770 });
  // Every root a previous apply created carries its marker (§5) — else plan() refuses it.
  for (const root of markedRoots(s.layout)) {
    mkdirSync(onHost(s.prefix, root), { recursive: true });
    writeFileSync(onHost(s.prefix, markerPath(root)), markerContent(INSTANCE));
  }
}

/**
 * A host as the 2026-07-15 → 2026-09-05 daemon left it: NO per-museum agent ever existed (no
 * migration to trigger), turns and git ran AS THE SERVICE USER under UMask=0027 — so 'alpha''s
 * workspace holds 2750 directories and 0640 files, `.git` included — and 'beta' was declared
 * but never created. Every entry the gate creates plays the service user's.
 */
function svcEraHost(s: Synthetic): { workspace: string; modes: () => Record<string, number> } {
  s.host.groups.set(SVC, { name: SVC, gid: INSTANCE_GID, members: [] });
  s.host.accounts.set(SVC, useraddAccount(SVC, SVC_UID, INSTANCE_GID, `Dedalo site builder instance ${INSTANCE}`));
  s.host.unitEnabled = true;
  s.host.unitActive = true;
  for (const root of markedRoots(s.layout)) {
    mkdirSync(onHost(s.prefix, root), { recursive: true });
    writeFileSync(onHost(s.prefix, markerPath(root)), markerContent(INSTANCE));
  }
  const workspace = onHost(s.prefix, join(s.layout.roots.workspaces, 'alpha'));
  const tree: Array<[string, 'dir' | 'file', number]> = [
    // The workspace itself, as the era's daemon made it under UMask=0027.
    ['.', 'dir', 0o2750],
    ['.git', 'dir', 0o2750],
    ['.git/objects', 'dir', 0o2750],
    ['.git/objects/ab', 'dir', 0o2750],
    ['.git/objects/ab/cdef', 'file', 0o440],
    ['.git/index', 'file', 0o640],
    ['.git/info', 'dir', 0o2750],
    ['src', 'dir', 0o2750],
    ['src/index.html', 'file', 0o640],
    ['.builder', 'dir', 0o700],
    ['.builder/builds', 'dir', 0o700],
    ['.builder/builds/b1.json', 'file', 0o600],
  ];
  mkdirSync(workspace, { recursive: true });
  for (const [path, kind] of tree) {
    if (kind === 'dir') mkdirSync(join(workspace, path), { recursive: true });
    else writeFileSync(join(workspace, path), path);
  }
  for (const [path, , mode] of [...tree].reverse()) chmodSync(join(workspace, path), mode);
  const modes = () => Object.fromEntries(tree.map(([path]) => [path, lstatSync(join(workspace, path)).mode & 0o7777]));
  return { workspace, modes };
}

const execs = (s: Synthetic) => s.ops.map((op, index) => ({ op, index })).filter(({ op }) => op.op === 'exec');
const argvOf = (op: Op) => (op.args[0] as string[]).join(' ');
const firstIndex = (s: Synthetic, predicate: (op: Op) => boolean) => s.ops.findIndex(predicate);
const lastIndex = (s: Synthetic, predicate: (op: Op) => boolean) => {
  for (let i = s.ops.length - 1; i >= 0; i--) if (predicate(s.ops[i] as Op)) return i;
  return -1;
};
const isExec = (pattern: RegExp) => (op: Op) => op.op === 'exec' && pattern.test(argvOf(op));
const isExecLine = (line: string) => (op: Op) => op.op === 'exec' && argvOf(op) === line;
const writes = (path: string) => (op: Op) => op.op === 'writeFile' && op.args[0] === path;

function runApply(s: Synthetic): void {
  const actions = plan(s.layout, s.manifest, observe(s));
  const report = apply(actions, s.io);
  if (!report.ok) throw new Error(`apply failed: ${report.failure?.detail ?? '(no detail)'}`);
}

function agentUnitWrites(s: Synthetic): number[] {
  const unitDir = dirname(s.layout.unitPath);
  return s.ops
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => op.op === 'writeFile' && dirname(op.args[0] as string) === unitDir && (op.args[0] as string).startsWith(`${unitDir}/${s.layout.agentUnitPrefix}`))
    .map(({ index }) => index);
}

describe('G18 — provision apply, in the spec §5 order', () => {
  test('install: identity before membership; units, reload and sockets; the rule and the env BEFORE the daemon starts', async () => {
    const s = synthetic(['alpha', 'beta']);
    runApply(s);
    const unitWrites = agentUnitWrites(s);
    expect(unitWrites.length).toBe(2 * 3 * 3);
    const reload = lastIndex(s, isExec(/^systemctl daemon-reload$/));
    const sockets = execs(s).filter(({ op }) => /^systemctl enable --now .*\.socket/.test(argvOf(op)) || /^systemctl enable .*--now.*\.socket/.test(argvOf(op)));
    const start = lastIndex(s, isExec(new RegExp(`^systemctl (start|restart|enable --now) ${escapeRegExp(s.layout.unitName)}$`)));
    const rule = lastIndex(s, writes(s.layout.agentPolicyPath));
    const env = lastIndex(s, writes(s.layout.envFile));
    expect({
      unitsBeforeReload: Math.max(...unitWrites) < reload,
      socketsEnabled: new Set(sockets.flatMap(({ op }) => (op.args[0] as string[]).filter(arg => arg.endsWith('.socket')))).size,
      socketsAfterReload: sockets.every(({ index }) => index > reload),
      ruleWritten: rule >= 0,
      envWritten: env >= 0,
      daemonStarted: start >= 0,
      socketsBeforeStart: sockets.every(({ index }) => index < start),
      ruleBeforeStart: rule < start,
      envBeforeStart: env < start,
    }).toEqual({
      unitsBeforeReload: true,
      socketsEnabled: 6,
      socketsAfterReload: true,
      ruleWritten: true,
      envWritten: true,
      daemonStarted: true,
      socketsBeforeStart: true,
      ruleBeforeStart: true,
      envBeforeStart: true,
    });
    const [id1, id2] = await Promise.all([1, 2].map(identity));
    for (const id of [id1, id2]) {
      const group = firstIndex(s, isExec(new RegExp(`^groupadd .*${id}$`)));
      const user = firstIndex(s, isExec(new RegExp(`^useradd .*${id}$`)));
      const joined = firstIndex(s, isExec(new RegExp(`^gpasswd -a ${SVC} ${id}$`)));
      expect({ id, group: group >= 0, user: user >= 0, joined: joined >= 0, ordered: group < user && user < joined }).toEqual({
        id,
        group: true,
        user: true,
        joined: true,
        ordered: true,
      });
    }
    expect(execs(s).filter(({ op }) => /^(userdel|groupdel|deluser|delgroup)\b/.test(argvOf(op)))).toEqual([]);
  });

  test('upgrade: stop → legacy runs stopped → proof → normalise ownership → units → rule → env → start → lock legacy → archive HOME (beside itself)', async () => {
    const s = synthetic(['alpha', 'beta']);
    legacyHost(s);
    runApply(s);
    const unitName = escapeRegExp(s.layout.unitName);
    const stop = firstIndex(s, isExec(new RegExp(`^systemctl stop ${unitName}$`)));
    const start = lastIndex(s, isExec(new RegExp(`^systemctl (start|restart) ${unitName}$`)));
    const normalise = execs(s).filter(({ op }) => (op.args[0] as string[])[0] === 'chown');
    const legacyGlob = legacyTransientUnitGlob(s.layout.agentUnitPrefix);
    const legacyStop = firstIndex(s, isExecLine(`systemctl stop ${legacyGlob}`));
    const proof = firstIndex(s, isExecLine(`pgrep -U ${LEGACY}`));
    const [id1, id2] = await Promise.all([1, 2].map(identity));
    const lock = firstIndex(s, isExec(new RegExp(`^usermod .*--lock.* ${LEGACY}$`)));
    const rule = lastIndex(s, writes(s.layout.agentPolicyPath));
    const env = lastIndex(s, writes(s.layout.envFile));
    const unitWrites = agentUnitWrites(s);
    expect({
      stopped: stop >= 0,
      started: start >= 0,
      normalisedSites: normalise.length,
      normaliseWhileStopped: normalise.every(({ index }) => index > stop && index < start),
      // The pre-LEAD-1b transient runs are stopped AS ROOT, then no process of the old owner is
      // proved left, and only then is anything re-owned.
      legacyRunsStoppedFirst: legacyStop > stop && proof > legacyStop && normalise.every(({ index }) => index > proof),
      // coreutils' fts walk: recursive, physical (never follows), the link itself changed, and
      // ONLY the earlier owner's files.
      normaliseTargets: normalise.map(({ op }) => {
        const argv = op.args[0] as string[];
        return { argv: argv.slice(0, 5).join(' '), owner: argv[5], root: argv[6] };
      }),
      unitsAfterStop: unitWrites.every(index => index > stop),
      ruleBeforeStart: rule >= 0 && rule < start,
      envBeforeStart: env >= 0 && env < start,
      // The retirement runs LAST, after the daemon is back: a lock or an archive that fails
      // halts only itself, never the museum's site builder.
      legacyLocked: lock >= 0 && lock > start,
      lastOpStartsTheDaemon: execs(s).filter(({ index }) => index > start).filter(({ op }) => /^systemctl (stop|restart|start) /.test(argvOf(op))).length,
    }).toEqual({
      stopped: true,
      started: true,
      normalisedSites: 2,
      normaliseWhileStopped: true,
      legacyRunsStoppedFirst: true,
      normaliseTargets: [
        { argv: `chown -R -h -P --from=${LEGACY}`, owner: id1, root: join(s.layout.roots.workspaces, 'alpha') },
        { argv: `chown -R -h -P --from=${LEGACY}`, owner: id2, root: join(s.layout.roots.workspaces, 'beta') },
      ],
      unitsAfterStop: true,
      ruleBeforeStart: true,
      envBeforeStart: true,
      legacyLocked: true,
      lastOpStartsTheDaemon: 0,
    });

    // The legacy HOME is ARCHIVED BESIDE ITSELF (`<home>.retired-<utc>`: a rename never leaves
    // its filesystem, and `roots.home` may be declared on any volume), not copied into any
    // per-(site, door) HOME: the plant does not follow any site into its new identity.
    const homeParent = dirname(onHost(s.prefix, s.layout.roots.home));
    const homeName = s.layout.roots.home.split('/').pop() as string;
    const archived = readdirSync(homeParent).filter(name => name.startsWith(`${homeName}.retired-`));
    expect({ archived: archived.length, homeGone: existsSync(onHost(s.prefix, s.layout.roots.home)) }).toEqual({ archived: 1, homeGone: false });
    expect(existsSync(join(homeParent, archived[0] as string, '.claude', 'settings.json'))).toBe(true);
    // …and CLOSED before it moves: root:root 0700, the directory itself (never recursive through
    // whatever the shared agent planted in it). Left as it was (2770 <svc>:<instance group>), the
    // archive beside it sits in a root 0755 state dir every site identity can traverse, and every
    // site's run — the instance group is each identity's PRIMARY group — could read every other
    // site's pre-migration `~/.claude` (round 6, S3).
    const home = s.layout.roots.home;
    const opIndex = (op: string, ...args: unknown[]) => s.ops.findIndex(entry => entry.op === op && JSON.stringify(entry.args) === JSON.stringify(args));
    const moved = s.ops.findIndex(entry => entry.op === 'rename' && entry.args[0] === home);
    expect({
      chownedFirst: opIndex('chown', home, 'root', 'root') >= 0 && opIndex('chown', home, 'root', 'root') < moved,
      closedFirst: opIndex('chmod', home, 0o700) > opIndex('chown', home, 'root', 'root') && opIndex('chmod', home, 0o700) < moved,
      recursive: s.ops.some(entry => entry.op === 'exec' && /^chown -R|^chmod -R/.test((entry.args[0] as string[]).join(' ')) && (entry.args[0] as string[]).includes(home)),
    }).toEqual({ chownedFirst: true, closedFirst: true, recursive: false });
    const stateRoot = (s.layout as unknown as Record<string, string>).agentStateRoot as string;
    const planted: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (lstatSync(path).isDirectory()) walk(path);
        else if (readFileSync(path, 'utf8').includes('"planted":true')) planted.push(path);
      }
    };
    walk(onHost(s.prefix, stateRoot));
    expect(planted).toEqual([]);
    const retiredAccess = s.access.get(join(s.layout.stateDir, 'retired'));
    expect(retiredAccess ? { owner: retiredAccess.owner, mode: retiredAccess.mode } : null).toEqual({ owner: 'root', mode: 0o700 });
    expect(execs(s).filter(({ op }) => /^(userdel|groupdel|deluser|delgroup)\b/.test(argvOf(op)))).toEqual([]);
  });

  test('IDEMPOTENT over the REAL ledger parser: a second plan after install — and after an upgrade — creates, retires, re-owns and re-epochs nothing', async () => {
    // `useradd` leaves every account with the `!` password `passwd -S` calls LOCKED; a ledger
    // that read the lock as retirement would re-create every site here, forever.
    for (const upgrade of [false, true]) {
      const s = synthetic(['alpha', 'beta']);
      if (upgrade) legacyHost(s);
      runApply(s);
      const envBefore = readFileSync(onHost(s.prefix, s.layout.envFile), 'utf8');
      const second = plan(s.layout, s.manifest, observe(s));
      const identityCommands = commandsOf(second)
        .map(argv => argv.join(' '))
        .filter(line => /^(useradd|groupadd|usermod|gpasswd|chown|pgrep)\b/.test(line) || line.startsWith('systemctl stop'));
      expect({ upgrade, identityCommands, changes: second.filter(changesTheHost).length }).toEqual({ upgrade, identityCommands: [], changes: 0 });
      // The env the first apply wrote is the env the second plan keeps: same ordinals, same epoch.
      expect(/^AGENT_IDENTITY_EPOCH="(\d+)"$/m.exec(envBefore)?.[1]).toBe(upgrade ? '1' : '1');
      expect(/^AGENT_IDENTITIES=(.*)$/m.exec(envBefore)?.[1]).toBe(JSON.stringify(JSON.stringify({ alpha: 1, beta: 2 })));
    }
  });

  /**
   * THE FIRST BINDING OF A HOST THAT NEVER MIGRATED. From 2026-07-15 to 2026-09-05 turns and git
   * ran as the SERVICE USER (UMask=0027): `.git` dirs 2750, files 0640, svc's. A host upgraded
   * from then straight to LEAD-1b has no per-museum agent, so no migration — and nothing opened
   * those entries to the group: the site's identity could not create `.git/index.lock`, and every
   * turn's commit failed. Now the first apply that binds identities stops the daemon and opens
   * the service user's entries of every EXISTING workspace to the group — `.builder` not entered,
   * read-only files left read-only, nothing re-owned (the daemon writes back only its own inodes).
   */
  test('svc era → LEAD-1b: the first binding opens the service user’s workspace entries to the group, daemon stopped, .builder untouched; only existing workspaces; once', async () => {
    const { svcModesArgvs } = await import('../src/provision/plan');
    const s = synthetic(['alpha', 'beta']);
    const { modes } = svcEraHost(s);
    const before = modes();
    runApply(s);
    const unitName = escapeRegExp(s.layout.unitName);
    const stop = firstIndex(s, isExec(new RegExp(`^systemctl stop ${unitName}$`)));
    const start = lastIndex(s, isExec(new RegExp(`^systemctl (start|restart) ${unitName}$`)));
    const finds = execs(s).filter(({ op }) => (op.args[0] as string[])[0] === 'find');
    const alphaRoot = join(s.layout.roots.workspaces, 'alpha');
    expect({
      finds: finds.map(({ op }) => op.args[0]),
      whileStopped: finds.every(({ index }) => stop >= 0 && index > stop && index < start),
    }).toEqual({ finds: svcModesArgvs(alphaRoot, SVC), whileStopped: true });
    expect({ before, after: modes() }).toEqual({
      before,
      after: {
        '.': 0o2770,
        '.git': 0o2770,
        '.git/objects': 0o2770,
        '.git/objects/ab': 0o2770,
        // A git object is read-only by design: it stays so (what UMask=0007 would have made).
        '.git/objects/ab/cdef': 0o440,
        '.git/index': 0o660,
        '.git/info': 0o2770,
        src: 0o2770,
        'src/index.html': 0o660,
        // The daemon's own state is not entered.
        '.builder': 0o700,
        '.builder/builds': 0o700,
        '.builder/builds/b1.json': 0o600,
      },
    });
    // Nothing is re-owned: there is no earlier owner, and the daemon owns what it writes back.
    expect(execs(s).filter(({ op }) => (op.args[0] as string[])[0] === 'chown')).toEqual([]);
    // ONCE: the env now binds the sites — the next plan stops nothing and walks nothing.
    const second = plan(s.layout, s.manifest, observe(s));
    const steps = second.map(action => (action.kind === 'exec' ? action.step : action.kind));
    expect({ walks: steps.filter(step => step === 'normalise_modes'), stops: steps.includes('daemon_stop') }).toEqual({ walks: [], stops: false });
  });

  test('a live process of the old owner HALTS the upgrade before anything is re-owned: daemon left stopped, nothing chowned, nothing started', () => {
    const s = synthetic(['alpha', 'beta']);
    legacyHost(s);
    s.host.liveUids = new Set([LEGACY]);
    const actions = plan(s.layout, s.manifest, observe(s));
    const report = apply(actions, s.io);
    const unitName = escapeRegExp(s.layout.unitName);
    expect({
      ok: report.ok,
      failedAt: report.failure?.action.kind === 'exec' ? report.failure.action.step : null,
      stopped: firstIndex(s, isExec(new RegExp(`^systemctl stop ${unitName}$`))) >= 0,
      chowned: execs(s).filter(({ op }) => (op.args[0] as string[])[0] === 'chown').length,
      started: firstIndex(s, isExec(new RegExp(`^systemctl (start|restart) ${unitName}$`))),
    }).toEqual({ ok: false, failedAt: 'quiesce_proof', stopped: true, chowned: 0, started: -1 });
  });

  /**
   * AN ARCHIVE THAT FAILS HALTS ONLY ITSELF. The retired HOME is renamed, and a rename that
   * cannot happen (EXDEV — `roots.home` on another volume — or a mount point, a full disk) used
   * to halt the apply BEFORE the daemon was started, and every re-run stopped it again, bumped
   * the resume epoch again and re-walked every workspace, to halt at the same rename. Now the
   * retirement runs LAST, and a host whose env already binds the sites (the re-own is proved
   * done: the env is written only after it) with the legacy agent retired is not migrating:
   * only the archive is pending, and only the archive is retried.
   */
  test('an archive that FAILS halts only itself: the daemon is up; the re-run stops nothing, re-owns nothing, re-epochs nothing — it retries the archive alone', () => {
    const s = synthetic(['alpha', 'beta']);
    legacyHost(s);
    const exdev = new Proxy(s.io, {
      get(target, key) {
        if (key !== 'rename') return (target as unknown as Record<string | symbol, unknown>)[key];
        return (from: string, to: string) => {
          if (from === s.layout.roots.home) throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`), { code: 'EXDEV' });
          return (target as unknown as { rename: (a: string, b: string) => void }).rename(from, to);
        };
      },
    });
    const first = apply(plan(s.layout, s.manifest, observe(s)), exdev);
    const unitName = escapeRegExp(s.layout.unitName);
    const envAfterFirst = readFileSync(onHost(s.prefix, s.layout.envFile), 'utf8');
    expect({
      ok: first.ok,
      failedOn: first.failure?.action.kind,
      daemonRunning: s.host.unitActive,
      started: firstIndex(s, isExec(new RegExp(`^systemctl (start|restart) ${unitName}$`))) >= 0,
      legacyLocked: firstIndex(s, isExec(new RegExp(`^usermod .*--lock.* ${LEGACY}$`))) >= 0,
    }).toEqual({ ok: false, failedOn: 'archive', daemonRunning: true, started: true, legacyLocked: true });

    const opsBefore = s.ops.length;
    const second = plan(s.layout, s.manifest, observe(s));
    const steps = second.map(action => (action.kind === 'exec' ? action.step : action.kind));
    expect({
      changes: second.filter(changesTheHost).map(action => action.kind),
      stopsTheDaemon: steps.includes('daemon_stop'),
      reOwns: steps.filter(step => step === 'normalise_ownership' || step === 'quiesce_proof' || step === 'legacy_runs_stop'),
      rewritesTheEnv: second.some(action => action.kind === 'file' && action.path === s.layout.envFile),
    }).toEqual({ changes: ['archive'], stopsTheDaemon: false, reOwns: [], rewritesTheEnv: false });
    const report = apply(second, s.io);
    expect({ ok: report.ok, epoch: /^AGENT_IDENTITY_EPOCH="(\d+)"$/m.exec(readFileSync(onHost(s.prefix, s.layout.envFile), 'utf8'))?.[1] }).toEqual({
      ok: true,
      epoch: /^AGENT_IDENTITY_EPOCH="(\d+)"$/m.exec(envAfterFirst)?.[1],
    });
    expect(s.ops.slice(opsBefore).filter(op => op.op === 'exec' && /^systemctl (stop|restart) /.test(argvOf(op)))).toEqual([]);
    expect(existsSync(onHost(s.prefix, s.layout.roots.home))).toBe(false);
  });

  test('site removal: the rule is NARROWED before the removed site’s units are touched; its identity is locked', async () => {
    const prefix = mkdtempSync(join(tmpdir(), 'l1b-g18-'));
    const both = synthetic(['alpha', 'beta'], prefix);
    runApply(both);
    const [, id2] = await Promise.all([1, 2].map(identity));
    // The same host, re-declared without 'beta'.
    const one = synthetic(['alpha'], prefix);
    Object.assign(one.host, both.host);
    for (const [path, access] of both.access) one.access.set(path, access);
    runApply(one);
    const touchesBeta = (op: Op) => JSON.stringify(op.args).includes(`${one.layout.agentUnitPrefix}s2-`);
    const firstBeta = firstIndex(one, op => op.op !== 'writeFile' && touchesBeta(op));
    const narrowed = firstIndex(one, writes(one.layout.agentPolicyPath));
    const ask = await loadRule(readFileSync(onHost(prefix, one.layout.agentPolicyPath), 'utf8'));
    const betaUnitsLeft = readdirSync(onHost(prefix, dirname(one.layout.unitPath))).filter(name => name.startsWith(`${one.layout.agentUnitPrefix}s2-`));
    expect({
      betaTouched: firstBeta >= 0,
      narrowedFirst: narrowed >= 0 && narrowed < firstBeta,
      ruleAnswers: {
        s1: ask({ user: SVC, unit: `${one.layout.agentUnitPrefix}s1-turn@3-100-999.service`, verb: 'stop' }),
        s2: ask({ user: SVC, unit: `${one.layout.agentUnitPrefix}s2-turn@3-100-999.service`, verb: 'stop' }),
      },
      betaSocketsDisabled: one.ops.some(op => op.op === 'exec' && /^systemctl disable --now /.test(argvOf(op)) && touchesBeta(op)),
      betaUnitsLeft,
      locked: one.ops.some(op => op.op === 'exec' && /^usermod .*--lock/.test(argvOf(op)) && argvOf(op).endsWith(` ${id2}`)),
      deleted: one.ops.filter(op => op.op === 'exec' && /^(userdel|groupdel)\b/.test(argvOf(op))).length,
    }).toEqual({
      betaTouched: true,
      narrowedFirst: true,
      ruleAnswers: { s1: 'YES', s2: 'NOT_HANDLED' },
      betaSocketsDisabled: true,
      betaUnitsLeft: [],
      locked: true,
      deleted: 0,
    });
  });

  test('instance removal: every identity locked (never deleted), the rule unlinked before any agent unit', async () => {
    const s = synthetic(['alpha', 'beta']);
    runApply(s);
    const host = observe(s) as unknown as { agentLedger: AgentLedger };
    // CONTRACT: renderAll threads the render facts (spec §2.2) to the renderers that need them.
    const artifacts = (renderAll as (...args: unknown[]) => ReturnType<typeof renderAll>)(s.layout, s.manifest, {
      agentIdentities: new Map([
        ['alpha', 1],
        ['beta', 2],
      ]),
      systemdVersion: 255,
    });
    const present: Record<string, boolean> = {};
    const bodies: Record<string, string> = {};
    for (const artifact of artifacts) {
      const real = onHost(s.prefix, artifact.path);
      if (existsSync(real)) {
        present[artifact.path] = true;
        bodies[artifact.path] = readFileSync(real, 'utf8');
      }
    }
    const steps = removalPlan(
      s.layout,
      artifacts,
      { artifactBodies: bodies, present, links: {}, claims: {}, agentLedger: host.agentLedger } as never,
      new Date('2026-10-01T00:00:00Z'),
    );
    const [id1, id2] = await Promise.all([1, 2].map(identity));
    const argvs = steps.filter(step => step.kind === 'exec').map(step => (step as { argv: readonly string[] }).argv.join(' '));
    const ruleUnlink = steps.findIndex(step => step.kind === 'unlink' && step.path === s.layout.agentPolicyPath);
    const unitUnlinks = steps
      .map((step, index) => ({ step, index }))
      .filter(({ step }) => step.kind === 'unlink' && step.path.includes(`/${s.layout.agentUnitPrefix}s`));
    expect({
      locked: [id1, id2, LEGACY].map(id => argvs.some(line => /^usermod .*--lock/.test(line) && line.endsWith(` ${id}`))),
      deleted: argvs.filter(line => /^(userdel|groupdel)\b/.test(line)).length,
      agentUnitsUnlinked: unitUnlinks.length,
      ruleFirst: ruleUnlink >= 0 && unitUnlinks.every(({ index }) => index > ruleUnlink),
    }).toEqual({ locked: [true, true, true], deleted: 0, agentUnitsUnlinked: 18, ruleFirst: true });
    // The live runs are stopped by ANCHORED globs — one per (site, door), the literal `@` after
    // the door — plus the exact-length pre-LEAD-1b name; never `<prefix>s*@*`, which reaches
    // into a museum whose name extends this one's.
    const prefix = s.layout.agentUnitPrefix;
    expect(argvs.filter(line => line.startsWith('systemctl stop ') && line !== `systemctl stop ${s.layout.unitName}`)).toEqual([
      `systemctl stop ${[1, 2].flatMap(k => ['turn', 'build', 'git'].map(door => `${prefix}s${k}-${door}@*.service`)).join(' ')} ${legacyTransientUnitGlob(prefix)}`,
    ]);
  });
});
