/**
 * THE CROSS-PACKAGE CONTRACT of `provision init` (spec §3.1, §4.1, §4.2, §2.2) — every type the
 * discovery parsers (parse/*), the two observe passes, draft, compare, act, the journal, the TTY
 * and the orchestrator exchange. Frozen in the day-0 commit: a package that needs a change here
 * asks its owner (P1). Code spells `flavor` (spec §0.2).
 *
 * Every row type HostFacts and DeclaredFacts name is defined HERE (or re-exported from the one
 * module that already defines it), so this file imports nothing that does not exist yet.
 *
 * PURE, types only. ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts) with ONE named exemption:
 * the type-only import of ../apply (InitIo extends ProvisionIo, spec §2.2) — erased at runtime.
 */
import type { ProvisionIo } from '../apply';
import type { ExecResult, InitExec, PairInvocation, ProvisionExec } from '../exec_contract';
import type { FpmFlavor, LayoutKind, WebServer } from '../layout';
import type { LockIo, LockState } from '../lock';
import type { Action, HostState, PathFacts, PinExpectation, PlanRefused, UnitFacts } from '../plan';
import type { Sibling } from '../siblings';
import type { PolkitState } from './parse/polkit';
import type { SudoFlavor } from './parse/sudoers';

export type { Action, ExecResult, HostState, LockState, PairInvocation, PathFacts, PlanRefused, Sibling, UnitFacts };

/* ── HostFacts (pass 1: host-wide, spec §3.1/§3.2) ───────────────────────────────────── */

export type OsFamily = 'debian' | 'ubuntu' | 'el' | 'other';
export type PackageTool = 'apt' | 'dnf';

/** One row of OS_SUPPORT (parse/os.ts, spec S8). */
export interface OsSupport {
  /** `os-release` ID values this row covers (e.g. ['rhel','rocky','almalinux']). */
  readonly ids: readonly string[];
  /** The major VERSION_ID this row covers (e.g. '12', '24.04', '26.04', '9', '10'). */
  readonly version: string;
  readonly family: Exclude<OsFamily, 'other'>;
  readonly packageTool: PackageTool;
  /** The distribution's web-server account for Apache (www-data / apache). */
  readonly webUser: string;
  readonly apacheFlavor: 'debian' | 'el';
  readonly fpmFlavors: readonly FpmFlavor[];
  readonly nologinShells: readonly string[];
  /**
   * EL only: AppStream ships PHP and nginx as `dnf module` streams (EL 9). EL 10 has no modules —
   * one non-modular version each — so a stream command would fail there.
   */
  readonly dnfModules: boolean;
  /**
   * EL without modules (EL 10): the ONE PHP version AppStream ships (measured: 8.3), so an `el`
   * FPM of any other version cannot come from `dnf install php-fpm`. null where the version is
   * chosen otherwise (Debian/Ubuntu: apt names it; EL 9: module streams).
   */
  readonly appStreamPhp: string | null;
  /** BUN_KERNEL_FLOOR (every supported row's distribution kernel is above it). */
  readonly kernelFloor: string;
}

export interface MountRow {
  readonly mountPoint: string;
  readonly fsType: string;
  readonly readOnly: boolean;
  readonly noexec: boolean;
  readonly seclabel: boolean;
  /** The `context=` mount option, or null. */
  readonly context: string | null;
}

export interface PasswdRow {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly shell: string;
}

export interface GroupRow {
  readonly name: string;
  readonly gid: number;
  /** Supplementary members (the 4th field); the primary members are PasswdRow.gid. */
  readonly members: readonly string[];
}

/** An EL `LoadModule` line from /etc/httpd/conf.modules.d/*.conf (parseModulesD). */
export interface ModuleLine {
  readonly file: string;
  readonly line: number;
  /** The module identifier (`proxy_fcgi_module`). */
  readonly module: string;
  readonly commented: boolean;
}

/** A unit's sandbox values (systemctl show), spec §3.2 hardened hosts. */
export interface UnitSandbox {
  readonly protectHome: string;
  readonly protectSystem: string;
  readonly inaccessible: readonly string[];
  readonly readOnly: readonly string[];
  readonly tmpfs: readonly string[];
}

export interface FpmPool {
  readonly name: string;
  readonly file: string;
  readonly user: string;
  readonly group: string;
  readonly listen: string;
}

export interface FpmInstall {
  readonly flavor: FpmFlavor;
  readonly version: string;
  readonly bin: string;
  readonly unit: string;
  readonly unitActive: boolean;
  readonly unitSandbox: UnitSandbox | null;
  readonly poolDir: string;
  readonly socketDir: string;
  /** The socket directory's SELinux type (stat %C), or null (no SELinux / unprobed). */
  readonly socketDirLabel: string | null;
  readonly cli: string | null;
  readonly cliVersion: string | null;
  readonly pools: readonly FpmPool[];
}

/** An nginx `map` that defines one of our variables outside our files (web.nginx_manual_map). */
export interface MapDef {
  readonly file: string;
  readonly line: number;
  readonly variable: string;
}

/**
 * ONE ROW PER VHOST AND PORT, never per listen address: a block on several addresses of one port
 * (Apache `<VirtualHost 192.0.2.1:443 [2001:db8::1]:443>`, nginx `listen 443; listen [::]:443;`)
 * is one row whose `addresses` lists them all. Two SEPARATE blocks of one site, one per address
 * family, stay two rows: draft.ts chooseVhost pairs them (the site's `vhostTwins`).
 */
export interface Vhost {
  readonly file: string;
  readonly realpath: string;
  readonly line: number;
  readonly endLine: number;
  /** Every address this block listens on at `port`, as the server prints it (`*`, `_default_`, `192.0.2.1`, `[::]`), in its order. */
  readonly addresses: readonly string[];
  readonly port: number;
  readonly ssl: boolean;
  /** Every request is redirected to an absolute URL (the :80 → https:// block): never a candidate for the include. */
  readonly redirectOnly: boolean;
  readonly serverName: string;
  readonly matchedBy: 'servername' | 'alias' | 'wildcard' | 'regex';
  readonly documentRoot: string | null;
  readonly errorLog: string | null;
  readonly accessLogs: readonly string[];
  /** The FPM socket the vhost's existing handler names, or null. */
  readonly fpmHandler: string | null;
  /** Our stamped reference is present. */
  readonly ourReference: boolean;
  /** Guide-style hand-written Dédalo lines (web.manual_lines). */
  readonly manualLines: readonly { readonly line: number; readonly text: string }[];
  readonly fileSha: string;
  /** Trust problems of the file and its ancestry (non-empty: reported, never edited). */
  readonly fileTrust: readonly string[];
}

/** A running Dédalo work engine on this machine (pair.engine, spec §6 B5). */
export interface WorkUnit {
  readonly unit: string;
  readonly user: string;
  readonly group: string;
  readonly checkout: string;
  readonly bun: string;
  readonly env: Readonly<Record<string, string>>;
  readonly privateDir: string;
  readonly privateUid: number | null;
  /** The engine fragment exists and is not PENDING; null = no fragment yet. */
  readonly fragmentPending: boolean | null;
}

export type SelinuxMode = 'absent' | 'disabled' | 'permissive' | 'enforcing';

export interface HostFacts {
  readonly os: {
    readonly id: string;
    readonly versionId: string;
    readonly family: OsFamily;
    readonly supported: boolean;
    /** The OS_SUPPORT row, or null for an unsupported OS. */
    readonly support: OsSupport | null;
  };
  /** A hosting panel's name (PANEL_MARKERS), or null. */
  readonly panel: string | null;
  /** /proc/sys/kernel/osrelease vs BUN_KERNEL_FLOOR (spec S8). */
  readonly kernel: { readonly release: string; readonly meetsFloor: boolean };
  /**
   * fapolicyd: `installed` = its CLI is a real file (layout.ts FAPOLICYD_CLI — the provisioner's
   * fact, so the trust unit renders exactly where init judged); `conf` = fapolicyd.conf's `trust`
   * backends and `integrity` mode (parse/fapolicyd.ts), null when it could not be read.
   */
  readonly fapolicyd: {
    readonly active: boolean;
    readonly installed: boolean;
    readonly conf: { readonly trust: readonly string[]; readonly integrity: string; readonly filesystemMark: boolean } | null;
  };
  readonly selinux: {
    readonly mode: SelinuxMode;
    /** SELINUXTYPE. */
    readonly policy: string | null;
    /** /etc/selinux/<type>/ exists (S9 disabled branch). */
    readonly storePresent: boolean;
    readonly tools: { readonly semanage: boolean; readonly restorecon: boolean; readonly getsebool: boolean };
    /** /proc/self/attr/current. */
    readonly rootContext: string | null;
    /** SELINUX_BOOLEANS as read. */
    readonly booleans: Readonly<Record<string, boolean>>;
    readonly localFcontext: readonly { readonly spec: string; readonly type: string }[];
    readonly localPorts: readonly { readonly type: string; readonly proto: string; readonly port: number }[];
    /** `semanage port -l` (tcp): port → type. */
    readonly portTypes: ReadonlyMap<number, string>;
    /** `stat -c %C` of the probed paths: path → type. */
    readonly labels: ReadonlyMap<string, string>;
  };
  /** /proc/self/mountinfo. */
  readonly mounts: readonly MountRow[];
  /** `systemctl --version`, or null. */
  readonly systemd: number | null;
  /** `pkaction --version`, and whether polkit answers (parse/polkit.ts polkitState: D-Bus starts it on demand). */
  readonly polkit: { readonly version: number | null; readonly state: PolkitState };
  /**
   * `flavor` from realpath(/usr/bin/sudo); `policyFile` the file that sudo reads (sudo-rs:
   * /etc/sudoers-rs when it exists); `includedir`: it, or a file it includes, includes the sudoers dir.
   */
  readonly sudo: {
    readonly present: boolean;
    readonly includedir: boolean;
    readonly flavor: SudoFlavor;
    readonly policyFile: string;
    /** Included files the walk did not follow (`<path>: <why>`): not root's / writable by others, or naming `%h` (parse/sudoers.ts). */
    readonly skipped: readonly string[];
  };
  readonly cpu: { readonly arch: 'x64' | 'aarch64' | 'other'; readonly avx2: boolean; readonly musl: boolean };
  /** `unzip` (bun.install extracts with it); `chattr` (e2fsprogs: provision apply makes the audit trail append-only with it). */
  readonly tools: { readonly unzip: boolean; readonly chattr: boolean };
  readonly nss: { readonly passwdFilesOnly: boolean; readonly groupFilesOnly: boolean; readonly sssDomains: boolean };
  readonly accounts: { readonly users: readonly PasswdRow[]; readonly groups: readonly GroupRow[] };
  /** /etc/shells entries. */
  readonly shells: readonly string[];
  readonly web: {
    readonly candidates: readonly WebServer[];
    readonly server: WebServer | null;
    readonly unit: string | null;
    readonly flavor: 'debian' | 'el' | null;
    readonly configtestBin: string | null;
    readonly dumpBin: string | null;
    readonly version: string | null;
    /** The web unit's ProtectHome/…/TemporaryFileSystem. */
    readonly unitSandbox: UnitSandbox | null;
    readonly runUser: string | null;
    readonly runGroup: string | null;
    readonly modules: readonly string[];
    readonly modulesD: readonly ModuleLine[];
    readonly phpModule: boolean;
    /** mod_php with no active FPM handler (EL: Remi's php<NN>-php under prefork — EL 9/10 AppStream ships no mod_php). */
    readonly phpModuleOnly: boolean;
    /** EL php.conf's server-wide FilesMatch handler. */
    readonly globalPhpHandler: { readonly file: string; readonly pattern: string; readonly insideIf: boolean } | null;
    /** nginx: conf.d is included inside http{}; null on apache. */
    readonly confDInHttp: boolean | null;
    /** nginx maps that define our variables. */
    readonly foreignMaps: readonly MapDef[];
    readonly vhosts: readonly Vhost[];
  };
  readonly fpm: readonly FpmInstall[];
  /** Listening TCP ports (/proc/net/tcp{,6}). */
  readonly ports: readonly number[];
  /**
   * A LOCAL MariaDB (spec §5.8, the v1 transport): the first MARIADB_SOCKET_CANDIDATES path that is
   * a socket (lstat: not a file, directory or link), or null; and whether anything listens on TCP 3306.
   */
  readonly mariadb: { readonly socket: string | null; readonly tcp3306: boolean };
  readonly work: readonly WorkUnit[];
}

/* ── DeclaredFacts (pass 2: about the declared layout) ───────────────────────────────── */

/** A secret-bearing file reduced to metadata (its content is never read into facts). */
export interface SecretFileMeta {
  readonly exists: boolean;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export interface DeclaredFacts {
  /** lstat facts of every declared root write path. */
  readonly paths: ReadonlyMap<string, PathFacts>;
  /** judgeAncestors' refusals per declared path. */
  readonly ancestorProblems: ReadonlyMap<string, readonly string[]>;
  readonly agentTreeDigest: string | null;
  readonly bunVersion: string | null;
  readonly siblings: readonly Sibling[];
  readonly stateRoot: 'absent' | 'ours' | 'foreign';
  readonly home: {
    readonly facts: PathFacts | null;
    readonly fsType: string | null;
    readonly topEntries: readonly { readonly name: string; readonly uid: number }[];
    /** Accounts whose passwd home is the site home. */
    readonly homeOf: readonly string[];
    /** Pool `chdir`/`error_log`/`session.save_path`/`upload_tmp_dir` lines pointing into it. */
    readonly poolRefs: readonly string[];
    readonly layoutDirs: Readonly<Record<'.bun' | 'host_agent' | 'dedalo', PathFacts | null>>;
    /** SELinux: httpd_t can search it (§4.3 selinux.home_traverse); null without SELinux. */
    readonly traversable: boolean | null;
    /** World-readable regular files at depth ≤ 2 (names only, capped; home.root's widening fact). */
    readonly worldReadable: readonly string[];
    readonly worldReadableCount: number;
  };
  /** `restorecon -n -v` on our targets. */
  readonly selinuxPending: readonly { readonly path: string; readonly from: string; readonly to: string }[];
  readonly hostShared: {
    /** dedalo_pubhost exists. */
    readonly group: boolean;
    readonly locks: PathFacts | null;
    readonly nginxMap: PathFacts | null;
    readonly mapInclude: PathFacts | null;
    readonly renderer: { readonly grammar: number; readonly digest: string } | null;
    /** S10: any declaration in configBase is home-bound. */
    readonly anyHomeBound: boolean;
  };
  readonly apiConfig: { readonly v2: SecretFileMeta | null; readonly v1: SecretFileMeta | null };
  readonly hostState: HostState | null;
  readonly plan: readonly Action[] | PlanRefused | null;
  readonly agentUnit: UnitFacts;
  readonly v2Unit: UnitFacts;
}

/* ── the source, kept templates, the compare context ─────────────────────────────────── */

/** The staged source (`<INIT_BASE>/<instance>/stage/source`, init/source.ts readStagedSource). */
export interface StagedSource {
  readonly dir: string;
  /** sourceDigest of the whole manifest (the operator's confirmation). */
  readonly digest: string;
  /** `.bun-version`. */
  readonly pin: string;
  /** `.bun-sha256` text. */
  readonly shaTable: string;
  /** `<dir>/publication/host_agent`. */
  readonly agentDir: string;
  /** treeDigest(agentDir), compared with treeDigest(agent_dir) by code.install. */
  readonly agentDigest: string;
  readonly v2EnvExample: string;
  /** null: the source carries no v1 sample (a kit built from a v2-only draft; SOURCE_MANIFEST `optional`). */
  readonly v1Sample: string | null;
  /** package.json `dependencies` names missing under node_modules; dev dependencies present. */
  readonly missingDependencies: readonly string[];
  readonly devDependenciesPresent: readonly string[];
  readonly testScratchPresent: boolean;
}

/** `<INIT_BASE>/<instance>/kept/`: root copies written on success (spec §1.2 --source). */
export interface KeptRef {
  readonly dir: string;
  /** File name → sha256 of the kept copy. */
  readonly files: Readonly<Record<string, string>>;
}

export interface InitArgs {
  readonly instance: string;
  readonly draft: string | null;
  readonly source: string | null;
  readonly sourceDigestConfirmed: string | null;
  readonly bunArchive: string | null;
  readonly bunSums: string | null;
  /** `--kit-file` / `--kit-digest-confirmed` (install.sh's hand-over): the kit file the operator gave it, and its verified sha256. */
  readonly kitFile: string | null;
  readonly kitDigestConfirmed: string | null;
  readonly yes: boolean;
  /** `--decide <item-id>=<option>`, in command-line order (an id at most once). */
  readonly decide: ReadonlyMap<string, string>;
  readonly resume: boolean;
  readonly dryRun: boolean;
  readonly pairName: string;
  readonly noPair: boolean;
}

/** One journal line (spec §7): detail holds no secret, ever. */
export type JournalPhase = 'begin' | 'done' | 'noop' | 'failed' | 'rolled_back' | 'skipped';
export interface JournalRecord {
  readonly v: 1;
  readonly seq: number;
  readonly at: string;
  /** 16 hex: one run. */
  readonly run: string;
  readonly item: string;
  readonly phase: JournalPhase;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface CompareCtx {
  readonly source: StagedSource | null;
  readonly kept: KeptRef | null;
  readonly pin: string | null;
  readonly bunArchive: string | null;
  readonly args: InitArgs;
  /** Journal records of an unfinished run (`begin` without a terminal record). */
  readonly journalOpen: readonly JournalRecord[];
  readonly lock: LockState;
}

/* ── items (spec §4.1) ───────────────────────────────────────────────────────────────── */

export type ItemList = 'right' | 'change' | 'decision';
export type ItemArea =
  | 'host'
  | 'selinux'
  | 'account'
  | 'home'
  | 'bun'
  | 'code'
  | 'declaration'
  | 'provision'
  | 'api_config'
  | 'web'
  | 'verify'
  | 'pair'
  | 'init';

export interface ItemOption {
  readonly id: string;
  readonly label: string;
  readonly resolves: 'act' | 'skip' | 'manual' | 'relocate' | 'replace';
  /**
   * 'typed' ⇒ this option edits an operator file, replaces a pairing, removes something, or sets an
   * SELinux boolean / mount option: a decision offering it is answered only by TYPING an option id —
   * Enter never takes its default, and it is never resolved as "the only option" (decision_class.ts).
   * Set by the PRODUCER (compare.ts, pair.ts), never inferred from a label; the agreement with the
   * action kinds is gated (decision_class.ts typedMarkProblems).
   */
  readonly confirm?: 'typed';
}

/** The item id grammar (stable across runs; `--decide` takes it). */
export const ITEM_ID_PATTERN = /^[a-z0-9_.-]+$/;

export interface Item {
  readonly id: string;
  readonly list: ItemList;
  readonly area: ItemArea;
  readonly title: string;
  readonly facts: readonly string[];
  readonly commands: readonly string[];
  readonly diff?: { readonly path: string; readonly unified: string };
  readonly options?: readonly ItemOption[];
  readonly defaultOption?: string;
  /** Ids of the items this one runs after. */
  readonly after: readonly string[];
  readonly action?: InitAction;
  readonly secret?: 'v2_env' | 'v1_config';
  readonly blocking: boolean;
  readonly optional: boolean;
  /** true ⇒ only a typed answer or --decide resolves it, never --yes. */
  readonly operatorFile: boolean;
  /** true ⇒ the change affects every site on the host; never --yes. */
  readonly hostWide: boolean;
}

/* ── actions (spec §4.2) ─────────────────────────────────────────────────────────────── */

export type InitAction =
  | { readonly kind: 'group_add'; readonly name: string }
  | { readonly kind: 'user_add_own'; readonly name: string }
  | { readonly kind: 'user_add_in'; readonly name: string; readonly group: string }
  | { readonly kind: 'path_meta'; readonly path: string; readonly uid: number; readonly gid: number; readonly mode: number }
  | { readonly kind: 'mkdir'; readonly path: string; readonly uid: number; readonly gid: number; readonly mode: number }
  | { readonly kind: 'sebool'; readonly name: string; readonly value: boolean; readonly previous: boolean | null }
  | { readonly kind: 'fcontext_relocate'; readonly remove: readonly { readonly spec: string; readonly type: string }[] }
  | {
      readonly kind: 'bun_install';
      readonly archive: string;
      readonly sums: string | null;
      readonly asset: string;
      readonly pin: string;
      readonly table: string;
      readonly target: string;
    }
  | { readonly kind: 'code_install'; readonly src: string; readonly dst: string; readonly digest: string }
  /** `body` = canonicalDeclaration(decl) (layout.ts / schema.ts). */
  | { readonly kind: 'write_declaration'; readonly body: string }
  | { readonly kind: 'provision_apply'; readonly instance: string }
  | { readonly kind: 'unit_restart'; readonly units: readonly string[] }
  /** `socket`: the local MariaDB socket discovery found (facts.mariadb), the typed prompt's default; null = TCP by default. Never a secret. */
  | { readonly kind: 'v2_env'; readonly sample: string; readonly path: string; readonly deploymentMode: WebServer | 'standalone'; readonly socket: string | null }
  | {
      readonly kind: 'v1_config';
      readonly sample: string;
      readonly path: string;
      readonly owner: string;
      readonly transport: 'socket' | 'tcp';
      readonly socket: string | null;
    }
  | { readonly kind: 'apache_modules'; readonly mods: readonly string[] }
  /** act computes `after` with web_edit.ts, re-read under the TOCTOU check (beforeSha). */
  /**
   * `line`: the 1-based opener line (Vhost.line) — a file may hold several vhosts (a :80 redirect and the TLS one).
   * `alsoLines`: the openers of the same site's address-family twins IN THE SAME FILE (draft.ts
   * vhostTwins): one edit of the file, one transaction, so the second insertion never meets a
   * beforeSha the first one already changed. Absent = `line` only.
   */
  | {
      readonly kind: 'vhost_reference';
      readonly path: string;
      readonly beforeSha: string;
      readonly server: WebServer;
      readonly edit: 'reference';
      readonly line: number;
      readonly alsoLines?: readonly number[];
    }
  | {
      readonly kind: 'vhost_manual_removal';
      readonly path: string;
      readonly beforeSha: string;
      readonly server: WebServer;
      readonly edit: 'remove_manual';
      readonly lines: readonly number[];
    }
  | { readonly kind: 'nginx_map_seed'; readonly path: string; readonly beforeSha: string; readonly standalone: boolean }
  | { readonly kind: 'keep_ref'; readonly files: readonly string[] }
  | { readonly kind: 'verify_agent' }
  | { readonly kind: 'pair'; readonly invocation: Omit<PairInvocation, 'token'> }
  /** B5 on two machines: seal the fragment, the token and the engine bundle into `path` (root 0600). */
  | { readonly kind: 'pair_package'; readonly name: string; readonly path: string }
  /** The sealed package, no longer needed once the work host paired: removed only when it is still init's (root 0600, the format's magic). */
  | { readonly kind: 'pair_package_remove'; readonly path: string };

export type InitActionKind = InitAction['kind'];

/* ── the operator (init/tty.ts) ──────────────────────────────────────────────────────── */

export interface Prompter {
  /** stdin and stdout are both TTYs. */
  readonly interactive: boolean;
  /** `<question> [y/N]`; false on anything but y/yes. */
  confirm(question: string): Promise<boolean>;
  /**
   * One decision: the option id chosen; null = aborted. Enter answers the shown default unless the
   * decision is `typed` (decision_class.ts classifyDecision — the one rule both prompters follow).
   */
  choose(item: Item): Promise<string | null>;
  /** A visible value with a default; null = aborted. */
  visible(label: string, defaultValue: string | null): Promise<string | null>;
  /** Hidden input, asked twice and compared; null = aborted (Ctrl-C/Ctrl-D). Never echoed. */
  secret(label: string): Promise<string | null>;
  /**
   * Lines shown ONCE on the terminal and nowhere else (the pairing package's passphrase): never
   * through the report sinks, the journal or a log. Interactive only; a non-interactive prompter
   * shows nothing.
   */
  showOnce(lines: readonly string[]): void;
}

/* ── the I/O doors (init/host_io.ts, spec §2.2) ──────────────────────────────────────── */

/**
 * The cap a caller may raise InitIo.readOperatorFile to for a BINARY it must hash in process: the
 * Bun archive (~37 MB) and the extracted `bun` (~95 MB on x64) are read whole by bun_install.ts —
 * the 8 MiB text cap (host_io.ts READ_CAP_BYTES) refused the real archive (measured: the Debian
 * drill's bun-linux-aarch64.zip is 36 602 920 bytes). A larger requested cap is clamped to this.
 */
export const BINARY_READ_CAP_BYTES = 256 * 1024 * 1024;

export interface OperatorFile {
  readonly bytes: Uint8Array;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly sha: string;
}

/** The provisioner's doors plus init's own, on the same O_NOFOLLOW + assertSafeParent rules. */
export interface InitIo extends ProvisionIo {
  /**
   * Temp `<dir>/.<base>.dedalo-init.tmp` (O_EXCL|O_NOFOLLOW), fsync, chown/chmod, rename. `pin`: what
   * the parent must be when only the grandparent is untrusted (the state tree's `shared/`; apply.ts
   * withPinnedDir) — such a path is refused without it.
   */
  writeBytesAtomic(path: string, bytes: Uint8Array, mode: number, uid: number, gid: number, pin?: PinExpectation): void;
  /** `<dir>/<name>` created O_EXCL|O_NOFOLLOW with `mode`; returns its path. */
  writeTempNamed(dir: string, name: string, bytes: Uint8Array, mode: number): string;
  /** Removes a `*.dedalo-init.tmp` file only (`pin`: as writeBytesAtomic's, for a temp beside a pinned write). */
  removeInitTemp(path: string, pin?: PinExpectation): void;
  /** Removes a tree that lies under `mustBeUnder`, never following a link. */
  removeTree(path: string, mustBeUnder: string): void;
  renameDir(from: string, to: string): void;
  /** O_APPEND + fsync (the journal). */
  appendSync(path: string, text: string): void;
  /** Bytes + owner + mode + sha, one descriptor; capped at READ_CAP_BYTES unless `capBytes` raises it (≤ BINARY_READ_CAP_BYTES: the Bun archive and binary). */
  readOperatorFile(path: string, capBytes?: number): OperatorFile;
  /** A root-only file's text, or null (absent or unreadable). */
  readRootFile(path: string): string | null;
  /**
   * Removes the operator's file at `path` only when it is still the one confirmed: a regular file
   * (never a link) whose bytes hash to `sha256`, unlinked by name after the descriptor read proved
   * it the same inode. Throws, naming why, and removes nothing otherwise.
   */
  removeOperatorFile(path: string, sha256: string): void;
  /** /proc/self/*, /proc/net/*, /proc/sys/kernel/{random/boot_id,osrelease}, /proc/locks only. */
  readProcFile(path: string): string | null;
}

/** What runInit's world is made of (production: init/run.ts initHostDeps()). */
export interface InitPorts {
  readonly io: InitIo;
  /** provisionExec() ∪ initExec(): a command lives in exactly one of the two sets. */
  readonly exec: ProvisionExec & InitExec;
  readonly lock: LockIo;
  readonly prompter: Prompter;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now: () => Date;
  /** process.geteuid(). */
  readonly euid: () => number | null;
  /** process.execPath, import.meta.dir, process.cwd() — the footgun guards' inputs. */
  readonly execPath: string;
  readonly codeDir: string;
  readonly cwd: string;
}

/** The draft-only layout choice (spec S6), named here for the draft/compare contract. */
export type DraftLayout = LayoutKind;
