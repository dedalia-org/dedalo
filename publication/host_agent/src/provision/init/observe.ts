/**
 * THE TWO DISCOVERY PASSES of `provision init` (spec §3, B1). run.ts runs
 *   observeHostWide(draft) → completeDraft → parseDeclaration → observeDeclared(layout, facts) → compare.
 *
 *   - observeHostWide fills HostFacts: what the host IS, before any declaration exists — OS,
 *     kernel, panel, SELinux, mounts, systemd/polkit/sudo, CPU, NSS and accounts, the web
 *     server (vhosts for the draft's domain), the FPM installs, the listening ports, the work
 *     engine's units, fapolicyd.
 *   - observeDeclared fills DeclaredFacts: what the host says about ONE derived layout — its
 *     paths and their ancestry, the agent tree's digest, the pinned Bun, the siblings, the
 *     state root, the site home, pending relabels, the host-wide shared state, the API config
 *     metadata, the provisioner's own plan.
 *
 * THE LAWS:
 *   - RAW DUMPS NEVER LEAVE THIS FILE. `nginx -T`, `-S`, `-tt`, vhost files, pool files and
 *     php.conf are parsed here (parse/*) and only the derived fields go into the facts.
 *   - NO CREDENTIAL IN FACTS. The token, v2.env, the v1 config and sssd.conf are reduced to
 *     stat data or one boolean (sssdHasDomains); a work unit's Environment keeps only its
 *     `DEDALO_*` entries whose names are not secret-shaped (SECRET_LOOKING_KEY). A pool file's
 *     content is reduced to its section names.
 *   - LOUD, NEVER NARROWED. A command that must answer and does not, or a text a parser cannot
 *     read, throws naming it: half-observed facts would let compare call something "right".
 *   - Every command goes through the closed exec sets (ports.exec = provisionExec ∪ initExec);
 *     every read through the injected io/fs doors, so the FakeHost drives both passes.
 *
 * I/O: imports anything but src/config.ts (init/* never does).
 */
import { realpathSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InitExec, ProvisionExec, RestoreconTarget } from '../exec_contract';
import { SELINUX_BOOLEANS } from '../exec_contract';
import { MAP_RENDERER_VERSION_FILE, parseRendererVersion } from '../host_map_renderer';
import type { AgentLayout, WebServer } from '../layout';
import {
  APACHE_DUMP_CANDIDATES,
  DEFAULT_PATHS,
  FAPOLICYD_CLI,
  FAPOLICYD_CONF,
  HOST_BASE,
  NGINX_MAP_INCLUDE_NAME,
  PUBHOST_GROUP,
  SECRET_LOOKING_KEY,
  markerContent,
  pickConfigtestBinary,
} from '../layout';
import type { HostState, PathFacts } from '../plan';
import { PlanRefused, ancestorsBelow, plan, trustProblem } from '../plan';
import { FINGERPRINT_PENDING, renderFacts } from '../render/engine_fragment';
import { parseDeclaration } from '../schema';
import type { SelinuxRuleFacts } from '../selinux';
import { DEFAULT_RULE_FACTS, HOME_TRAVERSE_TYPE, isHomeLayout, restoreconTargets } from '../selinux';
import type { Sibling } from '../siblings';
import { anySiblingHomeBound } from '../siblings';
import { webIncludePath, webReferenceInclude } from '../web_reference';
import { MAP_BLOCKS, SEED_CONTRIBUTION, contributionOf, isMapRefusal, parseNginxMap } from '../../rules/directives';
import type { ForeignMapFacts } from './compare';
import type { DraftApis } from './draft';
import { draftServesV1 } from './draft';
import { handMapLines } from './web_txn';
import { lstatFacts } from './host_io';
import {
  hasPhpModule,
  ifModuleActive,
  matchVhost,
  parseApacheS,
  parseModules,
  parseModulesD,
  parsePhpConf,
  parseWebVersion,
  readVhostBlock,
} from './parse/apache';
import { nssFilesOnly, parseGroup, parseNsswitch, parsePasswd, sssdHasDomains } from './parse/accounts';
import { parseCpu } from './parse/cpu';
import { parseFapolicydConf } from './parse/fapolicyd';
import type { FpmDumpPool } from './parse/fpm';
import { POOL_PATH_KEYS, fpmFlavors, isPhpCliPath, minorOf, parseFpmTT, parsePhpVersion, parsePoolSections } from './parse/fpm';
import { isNetworkFs, mountOf, parseMountinfo } from './parse/mounts';
import { parseProcNetTcp } from './parse/net';
import {
  confDIncludedInHttp,
  expandIncludes,
  findMapDefinitions,
  findServers,
  matchServerNames,
  nginxRunUser,
  splitNginxT,
} from './parse/nginx';
import { detectPanel, kernelFacts, osFamily, osSupportFor, parseOsRelease } from './parse/os';
import { POLKIT_DBUS_SERVICE, parsePolkitVersion, polkitState } from './parse/polkit';
import {
  parseGetenforce,
  parseGetsebool,
  parseRestoreconDryRun,
  parseSelinuxConfig,
  parseSelinuxContext,
  parseSemanageFcontextLocal,
  parseSemanagePorts,
  parseStatContext,
  singlePorts,
  tcpPortTypes,
} from './parse/selinux';
import { SUDO_BIN, policyIncludesDir, sudoFlavor, sudoPolicyFile } from './parse/sudoers';
import type { ListedUnit } from './parse/systemd';
import { parseEnvironmentProp, parseExecStart, parseSystemdVersion, parseUnitList, parseUnitShow, unitSandbox } from './parse/systemd';
import type { TreeReader } from './tree_copy';
import { treeDigest } from './tree_copy';
import { MARIADB_SOCKET_CANDIDATES, MARIADB_TCP_PORT } from './constants';
import type {
  DeclaredFacts,
  ExecResult,
  FpmInstall,
  GroupRow,
  HostFacts,
  InitIo,
  MapDef,
  PasswdRow,
  SecretFileMeta,
  UnitSandbox,
  Vhost,
  WorkUnit,
} from './types';

/* ── the doors ───────────────────────────────────────────────────────────────────── */

/**
 * The directory reads discovery needs beyond InitIo (which has no lstat/readdir/realpath):
 * production hostObserveFs(), the FakeHost its own.
 */
export interface ObserveFs {
  /** lstat facts, never following a link; null when absent. */
  lstat(path: string): PathFacts | null;
  /** The entry names of a directory, sorted; null when absent or unreadable. */
  readDir(path: string): string[] | null;
  /** realpath, or null when it does not resolve. */
  realpath(path: string): string | null;
}

export interface ObservePorts {
  readonly io: Pick<InitIo, 'readRootFile' | 'readProcFile' | 'readOperatorFile'>;
  readonly exec: ProvisionExec & InitExec;
  readonly fs: ObserveFs;
}

/** Pass 2 adds the provisioner's own host reader and the tree reader treeDigest walks with. */
export interface DeclaredPorts extends ObservePorts {
  /** apply.ts observeHost(layout, exec) in production. */
  observeHost(layout: AgentLayout): HostState;
  /** The `*.json` files directly in a directory (the sibling declarations), sorted. */
  listDeclarations(dir: string): string[];
  readonly treeReader: TreeReader;
}

/** Production ObserveFs (lstat never follows; readdir sorted). */
export function hostObserveFs(): ObserveFs {
  return {
    lstat: lstatFacts,
    readDir: path => {
      try {
        return readdirSync(path).sort();
      } catch {
        return null;
      }
    },
    realpath: path => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    },
  };
}

/**
 * What pass 1 reads from the draft — a structural subset of init/draft.ts DraftDeclaration
 * (every field optional but the instance), so a bare or partial draft is observable.
 */
export interface ObserveDraft {
  readonly instance: string;
  /**
   * Whether PHP is looked for at all (draft.ts draftServesV1): a v2-only draft (`apis: 'v2_only'`,
   * or no `v1` block) runs no PHP discovery — no FPM install, no PHP binary, no php.conf handler.
   */
  readonly apis?: DraftApis;
  readonly v1?: object;
  readonly site?: { readonly domain?: string; readonly home?: string };
  readonly web?: { readonly server?: WebServer };
  readonly media?: { readonly root?: string };
  readonly paths?: {
    readonly config_base?: string;
    readonly sudoers_dir?: string;
    readonly nginx_conf_d?: string;
    readonly host_base?: string;
  };
}

/* ── helpers ─────────────────────────────────────────────────────────────────────── */

function both(result: ExecResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function must(result: ExecResult, what: string): ExecResult {
  if (result.code !== 0) {
    const line = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '';
    throw new Error(`init observe: ${what} exited ${result.code}: ${line.slice(0, 200)}`);
  }
  return result;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function isFile(fs: ObserveFs, path: string): boolean {
  return fs.lstat(path)?.type === 'file';
}

/**
 * A tool the exec contract runs BY NAME (PROVISION_PATH): present when its path is a regular file OR
 * a link resolving to one — EL's policycoreutils ships /usr/sbin/restorecon as a link to setfiles
 * (measured, RHEL 9.8). Presence only: no trust is judged (nothing is pinned to this path).
 */
function isTool(fs: ObserveFs, path: string): boolean {
  const found = fs.lstat(path);
  if (found?.type === 'file') return true;
  if (found?.type !== 'symlink') return false;
  const target = fs.realpath(path);
  return target !== null && fs.lstat(target)?.type === 'file';
}

/** A pool's effective values when pass 1 kept them (FpmDumpPool, stored as FpmPool in the facts); else none. */
function poolValues(pool: unknown): Readonly<Record<string, string>> {
  return typeof pool === 'object' && pool !== null && 'values' in pool ? (pool as FpmDumpPool).values : {};
}

/** The variables the host-wide nginx map defines (rules/directives.ts MAP_BLOCKS, §13). */
export const OUR_MAP_VARIABLES: readonly string[] = Object.freeze(MAP_BLOCKS.map(block => block[1]));

/** The engine fragment's name in the instance's config dir (layout.ts derive engineFragmentPath; tests hold them equal). */
export const ENGINE_FRAGMENT_NAME = 'engine.env.fragment';

/** The web include our vhost reference points at, from the draft (pass 1 has no layout). */
function draftConfigBase(draft: ObserveDraft): string {
  return draft.paths?.config_base ?? DEFAULT_PATHS.configBase;
}

/** Where e2fsprogs puts chattr (usrmerge: both resolve to /usr/bin; EL: /usr/bin). PROVISION_PATH searches every one. */
const CHATTR_PATHS = Object.freeze(['/usr/bin/chattr', '/bin/chattr', '/usr/sbin/chattr', '/sbin/chattr']);

/* ── pass 1 ──────────────────────────────────────────────────────────────────────── */

/** HostFacts for this host (spec §3.2). */
export function observeHostWide(draft: ObserveDraft, ports: ObservePorts): HostFacts {
  const { io, exec, fs } = ports;

  // OS, panel, kernel.
  const osText = io.readRootFile('/etc/os-release') ?? io.readRootFile('/usr/lib/os-release') ?? '';
  const release = parseOsRelease(osText);
  const support = osSupportFor(release);
  const os = Object.freeze({ id: release.id, versionId: release.versionId, family: osFamily(release), supported: support !== null, support });
  const panel = detectPanel(path => fs.lstat(path) !== null);
  const kernelText = io.readProcFile('/proc/sys/kernel/osrelease');
  if (kernelText === null) throw new Error('init observe: /proc/sys/kernel/osrelease is unreadable');
  const kernel = kernelFacts(kernelText, support);

  // Units first: web, FPM, polkit and the work engine are judged from the same listing.
  const units = parseUnitList(must(exec.listCandidateUnits(), 'systemctl list-units').stdout);
  const mounts = parseMountinfo(io.readProcFile('/proc/self/mountinfo') ?? '');
  const accounts = observeAccounts(ports);

  const servesV1 = draftServesV1(draft);
  const web = observeWeb(draft, ports, units, os.family, servesV1);
  // No PHP discovery for a v2-only draft: no PHP binary runs (php -v, php-fpm -tt).
  const fpm = servesV1 ? observeFpm(ports, units) : [];
  const selinux = observeSelinux(draft, ports, fpm);
  const fpmLabelled = fpm.map(install =>
    Object.freeze({ ...install, socketDirLabel: selinux.labels.get(install.socketDir) ?? null }),
  );

  // sudo: the policy file the INSTALLED sudo reads (sudo-rs: /etc/sudoers-rs when it exists) and its includes.
  const sudoersDir = draft.paths?.sudoers_dir ?? DEFAULT_PATHS.sudoersDir;
  const flavor = sudoFlavor(fs.realpath(SUDO_BIN));
  const policyFile = sudoPolicyFile(flavor, path => fs.lstat(path)?.type === 'file');
  // Each file read through one O_NOFOLLOW descriptor with its owner and mode (sudo's own file rule: parse/sudoers.ts).
  const policy = policyIncludesDir(
    policyFile,
    path => {
      try {
        const file = io.readOperatorFile(path);
        return { text: new TextDecoder().decode(file.bytes), uid: file.uid, gid: file.gid, mode: file.mode };
      } catch {
        return null;
      }
    },
    sudoersDir,
  );
  // polkit: D-Bus-activated, so "not running" is an idle host's normal state (parse/polkit.ts).
  const polkitVersion = exec.polkitVersion();
  const polkitListed = units.some(unit => unit.unit === 'polkit.service' && unit.active === 'active');
  const polkit =
    polkitVersion.code !== 0
      ? 'not_activatable'
      : polkitState(polkitListed, polkitListed ? new Map<string, string>() : parseUnitShow(exec.unitShow('polkit').stdout), polkitListed ? null : io.readRootFile(POLKIT_DBUS_SERVICE));

  const listening = parseProcNetTcp(`${io.readProcFile('/proc/net/tcp') ?? ''}\n${io.readProcFile('/proc/net/tcp6') ?? ''}`);

  return Object.freeze({
    os,
    panel,
    kernel,
    fapolicyd: observeFapolicyd(ports),
    selinux,
    mounts: Object.freeze(mounts),
    systemd: parseSystemdVersion(exec.systemdVersion().stdout),
    polkit: Object.freeze({
      version: polkitVersion.code === 0 ? parsePolkitVersion(polkitVersion.stdout) : null,
      state: polkit,
    }),
    sudo: Object.freeze({
      present: policy.present,
      includedir: policy.includes && fs.lstat(sudoersDir)?.type === 'dir',
      flavor,
      policyFile,
      skipped: Object.freeze(policy.skipped.map(skip => `${skip.path}: ${skip.reason}`)),
    }),
    cpu: parseCpu(
      must(exec.unameMachine(), 'uname -m').stdout,
      io.readRootFile('/proc/cpuinfo') ?? '',
      (fs.readDir('/lib') ?? []).some(name => name.startsWith('ld-musl-')),
    ),
    tools: Object.freeze({ unzip: isFile(fs, '/usr/bin/unzip'), chattr: CHATTR_PATHS.some(path => isFile(fs, path)) }),
    nss: observeNss(ports),
    accounts,
    shells: Object.freeze((io.readRootFile('/etc/shells') ?? '').split('\n').map(line => line.trim()).filter(line => line.startsWith('/'))),
    web,
    fpm: Object.freeze(fpmLabelled),
    ports: Object.freeze(listening),
    mariadb: Object.freeze({
      // A socket is what lstat reports as none of file, directory or link (PathFacts 'other').
      socket: MARIADB_SOCKET_CANDIDATES.find(path => fs.lstat(path)?.type === 'other') ?? null,
      tcp3306: listening.includes(MARIADB_TCP_PORT),
    }),
    work: Object.freeze(observeWork(draft, ports, units, accounts.users, accounts.groups)),
  });
}

function observeAccounts(ports: ObservePorts): HostFacts['accounts'] {
  const users = parsePasswd(must(ports.exec.passwdDb(), 'getent passwd').stdout);
  const groups = parseGroup(must(ports.exec.groupDb(), 'getent group').stdout);
  return Object.freeze({ users: Object.freeze(users), groups: Object.freeze(groups) });
}

function observeNss(ports: ObservePorts): HostFacts['nss'] {
  const { io, fs } = ports;
  const sources = parseNsswitch(io.readRootFile('/etc/nsswitch.conf') ?? '');
  // sssd.conf holds credentials: only the one boolean leaves this function.
  const sssdTexts = [io.readRootFile('/etc/sssd/sssd.conf') ?? ''];
  for (const name of fs.readDir('/etc/sssd/conf.d') ?? []) {
    if (name.endsWith('.conf')) sssdTexts.push(io.readRootFile(join('/etc/sssd/conf.d', name)) ?? '');
  }
  const sssDomains = sssdTexts.some(sssdHasDomains);
  return Object.freeze({
    passwdFilesOnly: nssFilesOnly(sources.passwd, sssDomains),
    groupFilesOnly: nssFilesOnly(sources.group, sssDomains),
    sssDomains,
  });
}

/* ── SELinux ─────────────────────────────────────────────────────────────────────── */

const SELINUX_TOOLS = Object.freeze({ semanage: '/usr/sbin/semanage', restorecon: '/usr/sbin/restorecon', getsebool: '/usr/sbin/getsebool' });

function enabled(mode: HostFacts['selinux']['mode']): boolean {
  return mode === 'enforcing' || mode === 'permissive';
}

function observeSelinux(draft: ObserveDraft, ports: ObservePorts, fpm: readonly FpmInstall[]): HostFacts['selinux'] {
  const { io, exec, fs } = ports;
  const mode = parseGetenforce(exec.selinuxMode());
  const config = parseSelinuxConfig(io.readRootFile('/etc/selinux/config') ?? '');
  const policy = config.type;
  const storePresent = policy !== null && fs.lstat(join('/etc/selinux', policy))?.type === 'dir';
  const tools = Object.freeze({
    semanage: isTool(fs, SELINUX_TOOLS.semanage),
    restorecon: isTool(fs, SELINUX_TOOLS.restorecon),
    getsebool: isTool(fs, SELINUX_TOOLS.getsebool),
  });
  const contextText = mode === 'absent' ? null : io.readProcFile('/proc/self/attr/current');
  const rootContext = contextText === null ? null : (parseSelinuxContext(contextText) === null ? null : contextText.replace(/[\0\n\r]+$/g, '').trim());

  const booleans: Record<string, boolean> = {};
  if (enabled(mode) && tools.getsebool) {
    for (const name of SELINUX_BOOLEANS) {
      const value = parseGetsebool(name, exec.getsebool(name));
      if (value !== null) booleans[name] = value;
    }
  }
  // Local rules are readable (and registrable) whenever the policy store exists, enabled or not (S9).
  let localFcontext: HostFacts['selinux']['localFcontext'] = [];
  let localPorts: HostFacts['selinux']['localPorts'] = [];
  let portTypes = new Map<number, string>();
  if (tools.semanage && (enabled(mode) || storePresent)) {
    localFcontext = parseSemanageFcontextLocal(must(exec.semanageLocal('fcontext'), 'semanage fcontext -l -C').stdout).rules;
    localPorts = singlePorts(parseSemanagePorts(must(exec.semanageLocal('port'), 'semanage port -l -C').stdout));
    portTypes = tcpPortTypes(parseSemanagePorts(must(exec.semanagePortList(), 'semanage port -l').stdout));
  }
  // Labels of the paths compare judges: the home, /home, the FPM socket dirs, the media root.
  let labels = new Map<string, string>();
  if (enabled(mode)) {
    const home = draft.site?.home ?? (draft.site?.domain ? join('/home', draft.site.domain) : null);
    const wanted = [home, '/home', ...fpm.map(install => install.socketDir), draft.media?.root ?? null].filter(
      (path): path is string => path !== null && fs.lstat(path) !== null,
    );
    const unique = [...new Set(wanted)].slice(0, 32);
    if (unique.length > 0) labels = parseStatContext(must(exec.selinuxLabel(unique), 'stat -c %C').stdout);
  }
  return Object.freeze({
    mode,
    policy,
    storePresent,
    tools,
    rootContext,
    booleans: Object.freeze(booleans),
    localFcontext: Object.freeze(localFcontext),
    localPorts: Object.freeze(localPorts),
    portTypes,
    labels,
  });
}

/* ── the web server ──────────────────────────────────────────────────────────────── */

const WEB_UNITS: readonly { readonly unit: string; readonly server: WebServer; readonly flavor: 'debian' | 'el' | null }[] = Object.freeze([
  { unit: 'apache2', server: 'apache', flavor: 'debian' },
  { unit: 'httpd', server: 'apache', flavor: 'el' },
  { unit: 'nginx', server: 'nginx', flavor: null },
]);

function loaded(units: readonly ListedUnit[], unit: string): ListedUnit | undefined {
  return units.find(entry => entry.unit === `${unit}.service` && entry.load === 'loaded');
}

function sandboxOf(ports: ObservePorts, unit: string): UnitSandbox {
  return unitSandbox(parseUnitShow(ports.exec.unitShow(unit).stdout));
}

/** The trust problems of a file and of every ancestor up to '/' (lstat, never followed). */
function fileTrustProblems(fs: ObserveFs, path: string, rootUid: number): string[] {
  const problems: string[] = [];
  const facts = fs.lstat(path);
  if (facts === null) return [`'${path}' does not exist`];
  if (facts.type !== 'file') problems.push(`'${path}' is a ${facts.type}, not a regular file`);
  const own = trustProblem(facts, rootUid);
  if (own) problems.push(`'${path}' is ${own}`);
  problems.push(...judgeAncestorsLocal(path, '/', p => fs.lstat(p), rootUid, new Set()));
  return problems;
}

/**
 * plan.ts's ancestor judgement (its `judgeAncestors` closure), restated with the signature P6's
 * day-0 export will have: `(label, path, trustRoot, lstat, rootUid, judged) → refusals`. Replace
 * with the export once it lands (open issue); the wording is plan.ts's.
 */
function judgeAncestorsLocal(
  path: string,
  trustRoot: string,
  lstat: (path: string) => PathFacts | null,
  rootUid: number,
  judged: Set<string>,
  label = `'${path}'`,
): string[] {
  const refusals: string[] = [];
  for (const dir of ancestorsBelow(path, trustRoot)) {
    if (judged.has(dir)) continue;
    judged.add(dir);
    const facts = lstat(dir);
    if (!facts) continue;
    if (facts.type !== 'dir') {
      refusals.push(`'${dir}' (above ${label}) is a ${facts.type}, not a real directory — declare the canonical path`);
      continue;
    }
    const problem = trustProblem(facts, rootUid);
    if (problem) refusals.push(`'${dir}' (above ${label}) is ${problem}`);
  }
  return refusals;
}

function observeWeb(
  draft: ObserveDraft,
  ports: ObservePorts,
  units: readonly ListedUnit[],
  family: HostFacts['os']['family'],
  servesV1: boolean,
): HostFacts['web'] {
  const { exec, fs } = ports;
  const present = WEB_UNITS.filter(entry => loaded(units, entry.unit) !== undefined);
  const candidates = [...new Set(present.map(entry => entry.server))];
  const wanted = draft.web?.server;
  // Both installed and the draft silent: the one that RUNS is the site's (host.web still asks, with it
  // as the default). A stopped, disabled unit can stay loaded on a real host (measured: Ubuntu 24.04's
  // apache2 after `systemctl disable --now`), so "loaded" alone never decides.
  const running = [...new Set(present.filter(entry => loaded(units, entry.unit)?.active === 'active').map(entry => entry.server))];
  const server: WebServer | null =
    wanted !== undefined && candidates.includes(wanted)
      ? wanted
      : candidates.length === 1
        ? (candidates[0] as WebServer)
        : running.length === 1
          ? (running[0] as WebServer)
          : null;
  const empty = {
    candidates: Object.freeze(candidates),
    server,
    unit: null,
    flavor: null,
    configtestBin: null,
    dumpBin: null,
    version: null,
    unitSandbox: null,
    runUser: null,
    runGroup: null,
    modules: Object.freeze([]),
    modulesD: Object.freeze([]),
    phpModule: false,
    phpModuleOnly: false,
    globalPhpHandler: null,
    confDInHttp: null,
    foreignMaps: Object.freeze([]),
    vhosts: Object.freeze([]),
  } satisfies HostFacts['web'];
  if (server === null) return Object.freeze(empty);

  const entry = present.find(candidate => candidate.server === server) as (typeof WEB_UNITS)[number];
  const flavor = entry.flavor ?? (family === 'el' ? 'el' : family === 'debian' || family === 'ubuntu' ? 'debian' : null);
  // pickConfigtestBinary falls back to the first candidate; a fact is only a REAL file (plan
  // refuses the missing one by name: "install <server> first").
  const picked = pickConfigtestBinary(server, path => isFile(fs, path));
  const configtestBin = isFile(fs, picked) ? picked : null;
  const dumpBin = server === 'apache' ? (APACHE_DUMP_CANDIDATES.find(path => isFile(fs, path)) ?? null) : configtestBin;
  const version = dumpBin === null ? null : parseWebVersion(server, both(exec.webVersion(dumpBin)));
  const base = { ...empty, unit: entry.unit, flavor, configtestBin, dumpBin, version, unitSandbox: sandboxOf(ports, entry.unit) };
  if (dumpBin === null) return Object.freeze(base);

  const domain = draft.site?.domain ?? null;
  const configBase = draftConfigBase(draft);
  const rootUid = 0;
  if (server === 'apache') {
    const vhostsS = parseApacheS(both(must(exec.apacheVhosts(dumpBin), `${dumpBin} -S`)));
    const modules = parseModules(must(exec.apacheModules(dumpBin), `${dumpBin} -M`).stdout);
    const phpModule = hasPhpModule(modules);
    let modulesD: HostFacts['web']['modulesD'] = [];
    let globalPhpHandler: HostFacts['web']['globalPhpHandler'] = null;
    if (flavor === 'el') {
      const dir = '/etc/httpd/conf.modules.d';
      const files = (fs.readDir(dir) ?? [])
        .filter(name => name.endsWith('.conf'))
        .map(name => join(dir, name))
        .filter(path => isFile(fs, path))
        .map(path => ({ file: path, text: decode(ports.io.readOperatorFile(path).bytes) }));
      modulesD = parseModulesD(files);
      const phpConf = '/etc/httpd/conf.d/php.conf';
      // The server-wide PHP handler matters only to the v1 tree's own handler: v2-only reads no php.conf.
      if (servesV1 && isFile(fs, phpConf)) {
        const handler = parsePhpConf(decode(ports.io.readOperatorFile(phpConf).bytes), phpConf);
        if (handler !== null && handler.ifModules.every(condition => ifModuleActive(condition, modules))) {
          globalPhpHandler = Object.freeze({ file: handler.file, pattern: handler.pattern, insideIf: handler.insideIf });
        }
      }
    }
    const vhosts: Vhost[] = [];
    if (domain !== null) {
      const referencePath = webIncludePath(configBase, draft.instance, 'apache');
      const read = new Map<string, { realpath: string; text: string; sha: string; trust: string[] }>();
      for (const sEntry of vhostsS.entries) {
        let file = read.get(sEntry.file);
        if (file === undefined) {
          const realpath = fs.realpath(sEntry.file) ?? sEntry.file;
          const operator = ports.io.readOperatorFile(realpath);
          file = { realpath, text: decode(operator.bytes), sha: operator.sha, trust: fileTrustProblems(fs, realpath, rootUid) };
          read.set(sEntry.file, file);
        }
        const block = readVhostBlock(file.text, sEntry.line, { referencePath });
        const aliases = [...new Set([...block.aliases, ...sEntry.aliases.map(alias => alias.toLowerCase())])];
        const matchedBy = matchVhost(block.serverName, aliases, domain);
        if (matchedBy === null) continue;
        vhosts.push(
          Object.freeze({
            file: sEntry.file,
            realpath: file.realpath,
            line: block.line,
            endLine: block.endLine,
            addresses: sEntry.addresses,
            port: sEntry.port,
            ssl: block.ssl,
            redirectOnly: block.redirectOnly,
            serverName: block.serverName ?? sEntry.serverName,
            matchedBy,
            documentRoot: block.documentRoot,
            errorLog: block.errorLog,
            accessLogs: block.accessLogs,
            fpmHandler: block.fpmHandler,
            ourReference: block.ourReference,
            manualLines: block.manualLines,
            fileSha: file.sha,
            fileTrust: Object.freeze(file.trust),
          }),
        );
      }
    }
    return Object.freeze({
      ...base,
      runUser: vhostsS.user,
      runGroup: vhostsS.group,
      modules: Object.freeze(modules),
      modulesD: Object.freeze(modulesD),
      phpModule,
      // v2-only: no php.conf was read, so "mod_php with no FPM handler" is not claimed.
      phpModuleOnly: servesV1 && flavor === 'el' && phpModule && globalPhpHandler === null,
      globalPhpHandler,
      vhosts: Object.freeze(vhosts),
    });
  }

  // nginx: the dump stays in this function.
  const files = splitNginxT(must(exec.nginxDump(dumpBin), `${dumpBin} -T`).stdout);
  const tree = expandIncludes(files);
  const runAs = nginxRunUser(tree);
  const confD = draft.paths?.nginx_conf_d ?? DEFAULT_PATHS.nginxConfD;
  const hostBase = draft.paths?.host_base ?? HOST_BASE;
  const ownMapFiles = (file: string): boolean => file === join(confD, NGINX_MAP_INCLUDE_NAME) || file.startsWith(`${hostBase}/`);
  const foreignMaps: MapDef[] = foreignMapFacts(ports, findMapDefinitions(tree, OUR_MAP_VARIABLES).filter(map => !ownMapFiles(map.file)));
  const vhosts: Vhost[] = [];
  if (domain !== null) {
    const servers = findServers(tree, files, { referenceInclude: webReferenceInclude(configBase, draft.instance) });
    const read = new Map<string, { realpath: string; sha: string; trust: string[] }>();
    for (const server of servers) {
      const matchedBy = matchServerNames(server.names, domain);
      if (matchedBy === null) continue;
      let file = read.get(server.file);
      if (file === undefined) {
        const realpath = fs.realpath(server.file) ?? server.file;
        file = { realpath, sha: ports.io.readOperatorFile(realpath).sha, trust: fileTrustProblems(fs, realpath, rootUid) };
        read.set(server.file, file);
      }
      // ONE row per port and TLS-ness, never per `listen`: `listen 443 ssl; listen [::]:443 ssl;`
      // is one site on two address families (types.ts Vhost). A port listened on both with and
      // without ssl is two rows — two different services, never merged.
      const rows = new Map<string, { port: number; ssl: boolean; addresses: string[] }>();
      for (const listen of server.listens) {
        const key = `${listen.port}\0${listen.ssl}`;
        const row = rows.get(key) ?? { port: listen.port, ssl: listen.ssl, addresses: [] };
        if (!row.addresses.includes(listen.address)) row.addresses.push(listen.address);
        rows.set(key, row);
      }
      for (const listen of rows.values()) {
        vhosts.push(
          Object.freeze({
            file: server.file,
            realpath: file.realpath,
            line: server.line,
            endLine: server.endLine,
            addresses: Object.freeze(listen.addresses),
            port: listen.port,
            ssl: listen.ssl,
            redirectOnly: server.redirectOnly,
            serverName: server.names.find(name => name === domain.toLowerCase()) ?? server.names[0] ?? '',
            matchedBy,
            documentRoot: server.root,
            errorLog: server.errorLog,
            accessLogs: server.accessLogs,
            fpmHandler: server.fpmHandler,
            ourReference: server.ourReference,
            manualLines: server.manualLines,
            fileSha: file.sha,
            fileTrust: Object.freeze(file.trust),
          }),
        );
      }
    }
  }
  return Object.freeze({
    ...base,
    runUser: runAs?.user ?? null,
    runGroup: runAs?.group ?? runAs?.user ?? null,
    confDInHttp: confDIncludedInHttp(tree, confD, NGINX_MAP_INCLUDE_NAME),
    foreignMaps: Object.freeze(foreignMaps),
    vhosts: Object.freeze(vhosts),
  });
}

/**
 * What the hand-map migration (compare `web.nginx_manual_map`, act `nginx_map_seed`) needs of each
 * file a foreign map lives in: its sha (act proves it unchanged), whether it holds only the maps
 * (`standalone`: the file is removed, else only the blocks), and why its blocks would not pass the
 * map grammar as one contribution (null: they do). The same reading web_txn.seedNginxMap performs.
 */
function foreignMapFacts(ports: ObservePorts, maps: readonly MapDef[]): ForeignMapFacts[] {
  const byFile = new Map<string, { fileSha: string; standalone: boolean; parseProblem: string | null }>();
  for (const map of maps) {
    if (byFile.has(map.file)) continue;
    const realpath = ports.fs.realpath(map.file) ?? map.file;
    const file = ports.io.readOperatorFile(realpath);
    const text = decode(file.bytes);
    const found = handMapLines(text);
    if ('why' in found) {
      byFile.set(map.file, { fileSha: file.sha, standalone: false, parseProblem: found.why });
      continue;
    }
    const all = text.split('\n');
    const own = new Set(found.lines);
    const standalone = all.every((line, index) => own.has(index) || line.trim() === '' || line.trim().startsWith('#'));
    const parsed = parseNginxMap(standalone ? text : `${found.lines.map(index => all[index]).join('\n')}\n`);
    let parseProblem: string | null = null;
    if (isMapRefusal(parsed)) parseProblem = `line ${parsed.line}: ${parsed.why}`;
    else {
      const contribution = contributionOf(parsed, SEED_CONTRIBUTION);
      if (typeof contribution === 'string') parseProblem = contribution;
    }
    byFile.set(map.file, { fileSha: file.sha, standalone, parseProblem });
  }
  return maps.map(map => Object.freeze({ ...map, ...(byFile.get(map.file) as object) }) as ForeignMapFacts);
}

/* ── fapolicyd ────────────────────────────────────────────────────────────────────── */

/** Its unit's state, the provisioner's "installed" fact (the CLI is a real file) and its two config keys. */
function observeFapolicyd(ports: ObservePorts): HostFacts['fapolicyd'] {
  const { io, exec, fs } = ports;
  const installed = isFile(fs, FAPOLICYD_CLI);
  const text = installed ? io.readRootFile(FAPOLICYD_CONF) : null;
  return Object.freeze({
    active: parseUnitShow(exec.unitShow('fapolicyd').stdout).get('ActiveState') === 'active',
    installed,
    conf: text === null ? null : parseFapolicydConf(text),
  });
}

/* ── PHP-FPM ─────────────────────────────────────────────────────────────────────── */

function observeFpm(ports: ObservePorts, units: readonly ListedUnit[]): FpmInstall[] {
  const { io, exec, fs } = ports;
  const candidates = fpmFlavors({
    debianVersions: fs.readDir('/etc/php') ?? [],
    remiNames: fs.readDir('/etc/opt/remi') ?? [],
    isRealFile: path => isFile(fs, path),
  });
  return candidates.map(found => {
    // The CLI: present when its realpath is a PHP_CLI_PATTERN binary (phpVersion's own rule).
    const cliReal = fs.lstat(found.cli) === null ? null : fs.realpath(found.cli);
    const cli = cliReal !== null && isPhpCliPath(cliReal) ? found.cli : null;
    const cliVersion = cli === null ? null : (() => {
      const result = exec.phpVersion(cli);
      return result.code === 0 ? parsePhpVersion(result.stdout) : null;
    })();
    const version = found.flavor === 'el' ? (cliVersion === null ? '' : minorOf(cliVersion)) : found.version;
    const sections = new Map<string, string>();
    for (const name of fs.readDir(found.poolDir) ?? []) {
      if (!name.endsWith('.conf')) continue;
      const path = join(found.poolDir, name);
      for (const section of parsePoolSections(io.readRootFile(path) ?? '')) if (!sections.has(section)) sections.set(section, path);
    }
    const pools = parseFpmTT(both(must(exec.fpmDump(found.bin), `${found.bin} -tt`)), sections);
    return Object.freeze({
      flavor: found.flavor,
      version,
      bin: found.bin,
      unit: found.unit,
      unitActive: units.some(unit => unit.unit === `${found.unit}.service` && unit.active === 'active'),
      unitSandbox: sandboxOf(ports, found.unit),
      poolDir: found.poolDir,
      socketDir: found.socketDir,
      socketDirLabel: null,
      cli,
      cliVersion,
      pools: Object.freeze(pools),
    });
  });
}

/* ── the work engine (B5) ────────────────────────────────────────────────────────── */

const WORK_UNIT = /^(dedalo-ts(?:@[^.]+)?)\.service$/;

function observeWork(
  draft: ObserveDraft,
  ports: ObservePorts,
  units: readonly ListedUnit[],
  users: readonly PasswdRow[],
  groups: readonly GroupRow[],
): WorkUnit[] {
  const { io, exec, fs } = ports;
  const fragment = join(draftConfigBase(draft), draft.instance, ENGINE_FRAGMENT_NAME);
  const fragmentText = io.readRootFile(fragment);
  const fragmentPending = fragmentText === null ? null : fragmentText.includes(FINGERPRINT_PENDING);
  const out: WorkUnit[] = [];
  for (const listed of units) {
    const match = WORK_UNIT.exec(listed.unit);
    if (!match || listed.load !== 'loaded') continue;
    const show = parseUnitShow(exec.unitShow(match[1] as string).stdout);
    const user = show.get('User') ?? '';
    const primary = users.find(row => row.name === user);
    const group = show.get('Group') || (groups.find(row => row.gid === primary?.gid)?.name ?? '');
    const checkout = show.get('WorkingDirectory') ?? '';
    const command = parseExecStart(show.get('ExecStart') ?? '')[0];
    const environment = parseEnvironmentProp(show.get('Environment') ?? '');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(environment)) {
      if (key.startsWith('DEDALO_') && !SECRET_LOOKING_KEY.test(key)) env[key] = value;
    }
    const privateDir = environment.DEDALO_PRIVATE_DIR ?? (checkout === '' ? '' : join(checkout, '..', 'private'));
    out.push(
      Object.freeze({
        unit: match[1] as string,
        user,
        group,
        checkout,
        bun: command?.argv[0] ?? command?.path ?? '',
        env: Object.freeze(env),
        privateDir,
        privateUid: privateDir === '' ? null : (fs.lstat(privateDir)?.uid ?? null),
        fragmentPending,
      }),
    );
  }
  return out;
}

/* ── pass 2 ──────────────────────────────────────────────────────────────────────── */

export interface DeclaredOptions {
  /** selinux.ts SelinuxRuleFacts for the restorecon dry run. Default: DEFAULT_RULE_FACTS with mediaLabelable from the mount table. */
  readonly ruleFacts?: SelinuxRuleFacts;
  /** Types httpd_t can search (selinux.home_traverse); default [HOME_TRAVERSE_TYPE] until the EL drill measures more. */
  readonly homeTraverseTypes?: readonly string[];
  /** Ancestors at or above this are not judged. Production '/'. */
  readonly trustRoot?: string;
  /** home.root's widening fact: the most world-readable names listed. */
  readonly worldReadableCap?: number;
}

const WORLD_READABLE_CAP = 20;

/** The declared root write paths pass 2 lstats and judges (spec §3.2 row Declared). */
export function declaredWritePaths(layout: AgentLayout): string[] {
  const paths = [
    layout.state.root,
    layout.agentDir,
    layout.bunBin,
    dirname(layout.bunBin),
    layout.configBase,
    layout.instanceDir,
    dirname(layout.agentUnitPath),
    dirname(layout.sudoersPath),
    dirname(layout.polkitPath),
    layout.host.base,
  ];
  if (layout.web.server === 'nginx') paths.push(dirname(layout.host.nginxMapInclude));
  if (layout.site !== null) {
    paths.push(layout.site.home);
    // …and the v1 pool's own paths and log rotation, every site with v1 (render/logrotate.ts v1LogrotateRenderer).
    if (layout.site.v1 !== null && layout.v1 !== null) {
      paths.push(dirname(layout.site.v1.fpm.poolFile), dirname(layout.site.v1.var.root), dirname(layout.v1.logrotatePath));
    }
    // The home layout's web logs and their rotation (layout.ts webLogBase, render/logrotate.ts).
    if (isHomeLayout(layout)) paths.push(layout.site.webLogsDir, dirname(layout.logrotatePath));
  }
  return [...new Set(paths)];
}

function secretMeta(fs: ObserveFs, path: string): SecretFileMeta | null {
  const facts = fs.lstat(path);
  if (facts === null) return null;
  // Something that is not a regular file there (a symlink, a directory) is reported as not existing-as-a-file.
  return Object.freeze({ exists: facts.type === 'file', uid: facts.uid, gid: facts.gid, mode: facts.mode });
}

function stateRootKind(fs: ObserveFs, io: ObservePorts['io'], layout: AgentLayout): DeclaredFacts['stateRoot'] {
  const facts = fs.lstat(layout.state.root);
  if (facts === null) return 'absent';
  if (facts.type !== 'dir') return 'foreign';
  const entries = fs.readDir(layout.state.root) ?? [];
  if (entries.length === 0) return 'ours';
  return io.readRootFile(layout.state.marker) === markerContent(layout.instance) ? 'ours' : 'foreign';
}

/** World-readable regular files at depth ≤ 2 under `home`, relative names, sorted; never following links. */
function worldReadableFiles(fs: ObserveFs, home: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string, depth: number) => {
    for (const name of fs.readDir(dir) ?? []) {
      const path = join(dir, name);
      const facts = fs.lstat(path);
      if (facts === null) continue;
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      if (facts.type === 'file' && (facts.mode & 0o004) !== 0) out.push(relative);
      else if (facts.type === 'dir' && depth < 2) visit(path, relative, depth + 1);
    }
  };
  visit(home, '', 1);
  return out.sort();
}

function observeHome(layout: AgentLayout, facts: HostFacts, ports: DeclaredPorts, options: DeclaredOptions): DeclaredFacts['home'] {
  const { fs, exec } = ports;
  const site = layout.site;
  if (site === null) {
    return Object.freeze({
      facts: null,
      fsType: null,
      topEntries: Object.freeze([]),
      homeOf: Object.freeze([]),
      poolRefs: Object.freeze([]),
      layoutDirs: Object.freeze({ '.bun': null, host_agent: null, dedalo: null, logs: null }),
      traversable: null,
      worldReadable: Object.freeze([]),
      worldReadableCount: 0,
    });
  }
  const home = site.home;
  const homeFacts = fs.lstat(home);
  const isDir = homeFacts?.type === 'dir';
  const topEntries = isDir
    ? (fs.readDir(home) ?? []).flatMap(name => {
        const entry = fs.lstat(join(home, name));
        return entry === null ? [] : [Object.freeze({ name, uid: entry.uid })];
      })
    : [];
  const inside = (value: string) => value === home || value.startsWith(`${home}/`);
  const poolRefs: string[] = [];
  for (const install of facts.fpm) {
    for (const pool of install.pools) {
      for (const key of POOL_PATH_KEYS) {
        const value = poolValues(pool)[key];
        if (value !== undefined && inside(value)) poolRefs.push(`${pool.file || install.poolDir}: [${pool.name}] ${key} = ${value}`);
      }
    }
  }
  let traversable: boolean | null = null;
  if (enabled(facts.selinux.mode)) {
    let label = facts.selinux.labels.get(home) ?? null;
    if (label === null && homeFacts !== null) label = parseStatContext(must(exec.selinuxLabel([home]), 'stat -c %C').stdout).get(home) ?? null;
    const searchable = options.homeTraverseTypes ?? [HOME_TRAVERSE_TYPE];
    traversable = (label !== null && searchable.includes(label)) || facts.selinux.booleans.httpd_enable_homedirs === true;
  }
  const world = isDir ? worldReadableFiles(fs, home) : [];
  const cap = options.worldReadableCap ?? WORLD_READABLE_CAP;
  return Object.freeze({
    facts: homeFacts,
    fsType: mountOf(home, facts.mounts)?.fsType ?? null,
    topEntries: Object.freeze(topEntries),
    homeOf: Object.freeze(facts.accounts.users.filter(user => user.home === home).map(user => user.name)),
    poolRefs: Object.freeze(poolRefs),
    layoutDirs: Object.freeze({
      '.bun': fs.lstat(join(home, '.bun')),
      host_agent: fs.lstat(join(home, 'host_agent')),
      dedalo: fs.lstat(join(home, 'dedalo')),
    }),
    traversable,
    worldReadable: Object.freeze(world.slice(0, cap)),
    worldReadableCount: world.length,
  });
}

function observeSiblings(layout: AgentLayout, ports: DeclaredPorts): Sibling[] {
  const own = join(layout.configBase, `${layout.instance}.json`);
  const siblings: Sibling[] = [];
  for (const path of ports.listDeclarations(layout.configBase)) {
    if (path === own || path === layout.declarationPath) continue;
    const text = ports.io.readRootFile(path);
    if (text === null) continue;
    try {
      // Facts only: an untrusted or unparseable sibling is REFUSED by cli.ts siblingProblems (run.ts), not here.
      siblings.push(Object.freeze({ source: path, layout: parseDeclaration(JSON.parse(text), path).layout }));
    } catch {
      // see above
    }
  }
  return siblings;
}

/** DeclaredFacts for one derived layout (spec §3.1). */
export function observeDeclared(layout: AgentLayout, facts: HostFacts, ports: DeclaredPorts, options: DeclaredOptions = {}): DeclaredFacts {
  const { fs, io, exec } = ports;
  const trustRoot = options.trustRoot ?? '/';
  const rootUid = facts.accounts.users.find(user => user.name === 'root')?.uid ?? 0;

  const paths = new Map<string, PathFacts>();
  const ancestorProblems = new Map<string, readonly string[]>();
  for (const path of declaredWritePaths(layout)) {
    const found = fs.lstat(path);
    if (found) paths.set(path, found);
    // Judged per path (a fresh set): compare names every path a bad ancestor puts at risk.
    const problems = path === trustRoot ? [] : judgeAncestorsLocal(path, trustRoot, p => fs.lstat(p), rootUid, new Set());
    if (problems.length > 0) ancestorProblems.set(path, Object.freeze(problems));
  }

  const agentFacts = fs.lstat(layout.agentDir);
  const agentTreeDigest = agentFacts?.type === 'dir' ? treeDigest(layout.agentDir, ports.treeReader) : null;

  // The pinned Bun runs only when it passes the trust law (root runs it).
  const bunFacts = fs.lstat(layout.bunBin);
  const bunTrusted =
    bunFacts !== null &&
    bunFacts.type === 'file' &&
    trustProblem(bunFacts, rootUid) === null &&
    judgeAncestorsLocal(layout.bunBin, trustRoot, p => fs.lstat(p), rootUid, new Set()).length === 0;
  const bunResult = bunTrusted ? exec.bunVersion(layout.bunBin) : null;
  const bunVersion = bunResult !== null && bunResult.code === 0 ? bunResult.stdout.trim() || null : null;

  const siblings = observeSiblings(layout, ports);

  // SELinux: what restorecon would change on our targets (existing ones only).
  let selinuxPending: DeclaredFacts['selinuxPending'] = [];
  if (enabled(facts.selinux.mode) && facts.selinux.tools.restorecon) {
    const mediaMount = layout.media.root === null ? null : mountOf(layout.media.root, facts.mounts);
    const ruleFacts = options.ruleFacts ?? {
      ...DEFAULT_RULE_FACTS,
      mediaLabelable: mediaMount === null || !isNetworkFs(mediaMount.fsType) || mediaMount.seclabel,
    };
    const targets: RestoreconTarget[] = restoreconTargets(layout, ruleFacts).filter(target => fs.lstat(target.path) !== null);
    if (targets.length > 0) selinuxPending = Object.freeze(parseRestoreconDryRun(must(exec.restorecon(targets, true), 'restorecon -n').stdout));
  }

  const v2Shared = layout.state.apis.v2.shared;
  const renderer = parseRendererVersion(io.readRootFile(join(layout.host.mapRendererDir, MAP_RENDERER_VERSION_FILE)));

  let hostState: HostState | null = null;
  let planned: DeclaredFacts['plan'] = null;
  hostState = ports.observeHost(layout);
  try {
    // The token's fingerprint as cli.ts's apply renders it: a converged host plans nothing.
    planned = Object.freeze(plan(layout, hostState, renderFacts(layout, path => io.readRootFile(path))));
  } catch (error) {
    if (!(error instanceof PlanRefused)) throw error;
    planned = error;
  }

  return Object.freeze({
    paths,
    ancestorProblems,
    agentTreeDigest,
    bunVersion,
    siblings: Object.freeze(siblings),
    stateRoot: stateRootKind(fs, io, layout),
    home: observeHome(layout, facts, ports, options),
    selinuxPending,
    hostShared: Object.freeze({
      group: facts.accounts.groups.some(group => group.name === PUBHOST_GROUP),
      locks: fs.lstat(layout.host.locksDir),
      nginxMap: fs.lstat(layout.host.nginxMapDir),
      mapInclude: fs.lstat(layout.host.nginxMapInclude),
      renderer: renderer === null ? null : Object.freeze({ grammar: renderer.grammar, digest: renderer.digest }),
      anyHomeBound: layout.homeBound || anySiblingHomeBound(siblings),
    }),
    apiConfig: Object.freeze({
      v2: secretMeta(fs, join(v2Shared, 'v2.env')),
      // No v1 tree on a v2-only instance: nothing to look at.
      v1: layout.v1 === null ? null : secretMeta(fs, join(layout.v1.dirs.shared, 'server_config_api.php')),
    }),
    hostState,
    plan: planned,
    agentUnit: exec.unitState(layout.agentUnitName),
    v2Unit: exec.unitState(layout.v2.unit),
  });
}
