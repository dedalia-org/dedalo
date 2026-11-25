/**
 * Literal facts for the draft and compare gates (spec §9: "facts are literals") — no host is
 * read, nothing is spawned. Two reference hosts, each a value a test copies and bends:
 *
 *   debianHost()  Debian 12, Apache 2.4 + PHP-FPM 8.2, one exact TLS vhost for example.org,
 *                 a Dédalo work unit, SELinux absent.
 *   elHost()      Rocky 9, httpd + Remi php84 beside AppStream 8.0, SELinux enforcing/targeted.
 *
 * `declaredFor(layout)` is the second pass of a FRESH host (nothing of ours exists yet);
 * `compareCtx()` a source-mode run. Instance `demo`, domain `example.org` (RFC 2606).
 */
import type { AgentLayout } from '../../src/provision/layout';
import type { DraftDeclaration } from '../../src/provision/init/draft';
import type {
  CompareCtx,
  DeclaredFacts,
  FpmInstall,
  HostFacts,
  InitArgs,
  PathFacts,
  StagedSource,
  Vhost,
  WorkUnit,
} from '../../src/provision/init/types';

export const INSTANCE = 'demo';
export const DOMAIN = 'example.org';
export const HOME = `/home/${DOMAIN}`;
export const PIN = '1.4.3';

const SANDBOX = Object.freeze({ protectHome: 'no', protectSystem: 'no', inaccessible: [], readOnly: [], tmpfs: [] });

export function vhost(overrides: Partial<Vhost> = {}): Vhost {
  return {
    file: '/etc/apache2/sites-enabled/example.org-le-ssl.conf',
    realpath: '/etc/apache2/sites-available/example.org-le-ssl.conf',
    line: 2,
    endLine: 30,
    addresses: ['*'],
    port: 443,
    ssl: true,
    redirectOnly: false,
    serverName: DOMAIN,
    matchedBy: 'servername',
    documentRoot: `${HOME}/public_html`,
    // owner decision 1(c): the site logs are in the distribution's log dir, per site (layout.ts webLogBase)
    errorLog: `/var/log/apache2/${DOMAIN}/error.log`,
    accessLogs: [`/var/log/apache2/${DOMAIN}/access.log`],
    fpmHandler: 'proxy:unix:/run/php/php8.2-fpm.sock|fcgi://localhost',
    ourReference: false,
    manualLines: [],
    fileSha: 'a'.repeat(64),
    fileTrust: [],
    ...overrides,
  };
}

export function debianFpm(version = '8.2', overrides: Partial<FpmInstall> = {}): FpmInstall {
  return {
    flavor: 'debian',
    version,
    bin: `/usr/sbin/php-fpm${version}`,
    unit: `php${version}-fpm`,
    unitActive: true,
    unitSandbox: SANDBOX,
    poolDir: `/etc/php/${version}/fpm/pool.d`,
    socketDir: '/run/php',
    socketDirLabel: null,
    cli: `/usr/bin/php${version}`,
    cliVersion: `${version}.7`,
    pools: [{ name: 'www', file: `/etc/php/${version}/fpm/pool.d/www.conf`, user: 'www-data', group: 'www-data', listen: `/run/php/php${version}-fpm.sock` }],
    ...overrides,
  };
}

export function remiFpm(version = '8.4', overrides: Partial<FpmInstall> = {}): FpmInstall {
  const nn = version.replace('.', '');
  return {
    flavor: 'remi',
    version,
    bin: `/opt/remi/php${nn}/root/usr/sbin/php-fpm`,
    unit: `php${nn}-php-fpm`,
    unitActive: true,
    unitSandbox: SANDBOX,
    poolDir: `/etc/opt/remi/php${nn}/php-fpm.d`,
    socketDir: `/var/opt/remi/php${nn}/run/php-fpm`,
    socketDirLabel: 'httpd_var_run_t',
    cli: `/opt/remi/php${nn}/root/usr/bin/php`,
    cliVersion: `${version}.1`,
    pools: [],
    ...overrides,
  };
}

export function appStreamFpm(version = '8.0', overrides: Partial<FpmInstall> = {}): FpmInstall {
  return {
    flavor: 'el',
    version,
    bin: '/usr/sbin/php-fpm',
    unit: 'php-fpm',
    unitActive: true,
    unitSandbox: SANDBOX,
    poolDir: '/etc/php-fpm.d',
    socketDir: '/run/php-fpm',
    socketDirLabel: 'httpd_var_run_t',
    cli: '/usr/bin/php',
    cliVersion: `${version}.30`,
    pools: [{ name: 'www', file: '/etc/php-fpm.d/www.conf', user: 'apache', group: 'apache', listen: '/run/php-fpm/www.sock' }],
    ...overrides,
  };
}

export function workUnit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    unit: 'dedalo-ts',
    user: 'dedalo',
    group: 'dedalo',
    checkout: '/opt/dedalo/master_dedalo',
    bun: '/opt/dedalo/bun/bin/bun',
    env: { DEDALO_PRIVATE_DIR: '/opt/dedalo/private' },
    privateDir: '/opt/dedalo/private',
    privateUid: 1001,
    fragmentPending: null,
    ...overrides,
  };
}

const BOOLEANS_OFF = Object.freeze({
  httpd_can_network_connect: false,
  httpd_can_network_connect_db: false,
  httpd_can_network_relay: false,
  httpd_enable_homedirs: false,
  httpd_graceful_shutdown: false,
  httpd_use_cifs: false,
  httpd_use_fusefs: false,
  httpd_use_nfs: false,
});

export function debianHost(): HostFacts {
  return {
    os: {
      id: 'debian',
      versionId: '12',
      family: 'debian',
      supported: true,
      support: {
        ids: ['debian'],
        version: '12',
        family: 'debian',
        packageTool: 'apt',
        webUser: 'www-data',
        apacheFlavor: 'debian',
        fpmFlavors: ['debian'],
        nologinShells: ['/usr/sbin/nologin'],
        dnfModules: false,
        appStreamPhp: null,
        kernelFloor: '5.1',
      },
    },
    panel: null,
    kernel: { release: '6.1.0-25-amd64', meetsFloor: true},
    fapolicyd: { active: false, installed: false, conf: null },
    selinux: {
      mode: 'absent',
      policy: null,
      storePresent: false,
      tools: { semanage: false, restorecon: false, getsebool: false },
      rootContext: null,
      booleans: {},
      localFcontext: [],
      localPorts: [],
      portTypes: new Map(),
      labels: new Map(),
    },
    mounts: [{ mountPoint: '/', fsType: 'ext4', readOnly: false, noexec: false, seclabel: false, context: null }],
    systemd: 252,
    polkit: { version: 122, state: 'running' },
    sudo: { present: true, includedir: true, flavor: 'sudo', policyFile: '/etc/sudoers', skipped: [] },
    cpu: { arch: 'x64', avx2: true, musl: false },
    tools: { unzip: true, chattr: true },
    nss: { passwdFilesOnly: true, groupFilesOnly: true, sssDomains: false },
    accounts: {
      users: [
        { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash' },
        { name: 'www-data', uid: 33, gid: 33, home: '/var/www', shell: '/usr/sbin/nologin' },
        { name: 'dedalo', uid: 1001, gid: 1001, home: '/home/dedalo', shell: '/bin/bash' },
        { name: 'site', uid: 1002, gid: 1002, home: HOME, shell: '/bin/bash' },
      ],
      groups: [
        { name: 'root', gid: 0, members: [] },
        { name: 'www-data', gid: 33, members: [] },
        { name: 'dedalo', gid: 1001, members: [] },
        { name: 'site', gid: 1002, members: [] },
      ],
    },
    shells: ['/bin/sh', '/bin/bash', '/usr/sbin/nologin'],
    web: {
      candidates: ['apache'],
      server: 'apache',
      unit: 'apache2',
      flavor: 'debian',
      configtestBin: '/usr/sbin/apache2ctl',
      dumpBin: '/usr/sbin/apache2ctl',
      version: '2.4.62',
      unitSandbox: SANDBOX,
      runUser: 'www-data',
      runGroup: 'www-data',
      modules: ['ssl_module', 'proxy_module', 'proxy_http_module', 'proxy_fcgi_module', 'headers_module', 'rewrite_module'],
      modulesD: [],
      phpModule: false,
      phpModuleOnly: false,
      globalPhpHandler: null,
      confDInHttp: null,
      foreignMaps: [],
      vhosts: [vhost()],
    },
    fpm: [debianFpm()],
    ports: [22, 80, 443, 3306],
    mariadb: { socket: '/run/mysqld/mysqld.sock', tcp3306: true },
    work: [workUnit()],
  };
}

/** Rocky 9, httpd, Remi php84 beside AppStream 8.0, SELinux enforcing (targeted). */
export function elHost(): HostFacts {
  const base = debianHost();
  return {
    ...base,
    os: {
      id: 'rocky',
      versionId: '9.4',
      family: 'el',
      supported: true,
      support: {
        ids: ['rhel', 'rocky', 'almalinux'],
        version: '9',
        family: 'el',
        packageTool: 'dnf',
        webUser: 'apache',
        apacheFlavor: 'el',
        fpmFlavors: ['el', 'remi'],
        nologinShells: ['/sbin/nologin', '/usr/sbin/nologin'],
        dnfModules: true,
        appStreamPhp: null,
        kernelFloor: '5.1',
      },
    },
    kernel: { release: '5.14.0-427.el9.x86_64', meetsFloor: true},
    selinux: {
      mode: 'enforcing',
      policy: 'targeted',
      storePresent: true,
      tools: { semanage: true, restorecon: true, getsebool: true },
      rootContext: 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023',
      booleans: { ...BOOLEANS_OFF, httpd_graceful_shutdown: true },
      localFcontext: [],
      localPorts: [],
      portTypes: new Map([
        [80, 'http_port_t'],
        [443, 'http_port_t'],
        [3306, 'mysqld_port_t'],
        [8080, 'http_cache_port_t'],
        [9000, 'http_port_t'],
      ]),
      labels: new Map([[HOME, 'user_home_dir_t']]),
    },
    mounts: [{ mountPoint: '/', fsType: 'xfs', readOnly: false, noexec: false, seclabel: true, context: null }],
    accounts: {
      users: [
        { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash' },
        { name: 'apache', uid: 48, gid: 48, home: '/usr/share/httpd', shell: '/sbin/nologin' },
        { name: 'dedalo', uid: 1001, gid: 1001, home: '/home/dedalo', shell: '/bin/bash' },
        { name: 'site', uid: 1002, gid: 1002, home: HOME, shell: '/bin/bash' },
      ],
      groups: [
        { name: 'root', gid: 0, members: [] },
        { name: 'apache', gid: 48, members: [] },
        { name: 'dedalo', gid: 1001, members: [] },
        { name: 'site', gid: 1002, members: [] },
      ],
    },
    shells: ['/bin/sh', '/bin/bash', '/sbin/nologin'],
    web: {
      ...base.web,
      unit: 'httpd',
      flavor: 'el',
      configtestBin: '/usr/sbin/apachectl',
      dumpBin: '/usr/sbin/httpd',
      version: '2.4.57',
      runUser: 'apache',
      runGroup: 'apache',
      globalPhpHandler: { file: '/etc/httpd/conf.d/php.conf', pattern: '\\.(php|phar)$', insideIf: true },
      vhosts: [
        vhost({
          file: '/etc/httpd/conf.d/example.org-le-ssl.conf',
          realpath: '/etc/httpd/conf.d/example.org-le-ssl.conf',
          fpmHandler: null,
        }),
      ],
    },
    fpm: [appStreamFpm(), remiFpm()],
  };
}

/** The v1+v2 draft most suites judge (the PHP items); v2Draft() is the v2-only one (no PHP anywhere). */
export function draft(overrides: Partial<DraftDeclaration> = {}): DraftDeclaration {
  return {
    instance: INSTANCE,
    apis: 'v1_and_v2',
    site: { domain: DOMAIN },
    media: { mode: 'shared', root: '/mnt/dedalo_media' },
    ...overrides,
  };
}

/** The v2-only draft: no `v1` block and no `apis` — exactly a v2-only declaration's shape. */
export function v2Draft(overrides: Partial<DraftDeclaration> = {}): DraftDeclaration {
  return {
    instance: INSTANCE,
    site: { domain: DOMAIN },
    media: { mode: 'shared', root: '/mnt/dedalo_media' },
    ...overrides,
  };
}

const dir = (uid = 0, mode = 0o755): PathFacts => ({ type: 'dir', uid, gid: uid, mode });

/** The second pass on a fresh host: the home is the site user's 0700 home, nothing of ours exists. */
export function declaredFresh(overrides: Partial<DeclaredFacts> = {}): DeclaredFacts {
  return {
    paths: new Map([
      ['/', dir()],
      ['/home', dir()],
    ]),
    ancestorProblems: new Map(),
    agentTreeDigest: null,
    bunVersion: null,
    siblings: [],
    stateRoot: 'absent',
    home: {
      facts: dir(1002, 0o700),
      fsType: 'ext4',
      topEntries: [
        { name: 'public_html', uid: 1002 },
        { name: '.bashrc', uid: 1002 },
      ],
      homeOf: ['site'],
      poolRefs: [],
      layoutDirs: { '.bun': null, host_agent: null, dedalo: null },
      traversable: null,
      worldReadable: ['public_html/index.html'],
      worldReadableCount: 1,
    },
    selinuxPending: [],
    hostShared: { group: false, locks: null, nginxMap: null, mapInclude: null, renderer: null, anyHomeBound: false },
    apiConfig: { v2: null, v1: null },
    hostState: null,
    plan: null,
    agentUnit: { enabled: false, active: false },
    v2Unit: { enabled: false, active: false },
    ...overrides,
  };
}

/** The second pass after a converged run of `layout`: everything is ours and right. */
export function declaredConverged(layout: AgentLayout, overrides: Partial<DeclaredFacts> = {}): DeclaredFacts {
  const base = declaredFresh();
  return {
    ...base,
    agentTreeDigest: 'd'.repeat(64),
    bunVersion: PIN,
    stateRoot: 'ours',
    home: { ...base.home, facts: dir(0, 0o755), layoutDirs: { '.bun': dir(), host_agent: dir(), dedalo: dir() }, traversable: true },
    hostShared: { ...base.hostShared, group: true },
    apiConfig: {
      v2: { exists: true, uid: 0, gid: 2002, mode: 0o640 },
      v1: { exists: true, uid: 2001, gid: 0, mode: 0o400 },
    },
    plan: [],
    agentUnit: { enabled: true, active: true },
    v2Unit: { enabled: true, active: true },
    ...overrides,
  };
}

export function args(overrides: Partial<InitArgs> = {}): InitArgs {
  return {
    instance: INSTANCE,
    draft: '/var/lib/dedalo_publication_host_init/demo/stage/draft.json',
    source: '/var/lib/dedalo_publication_host_init/demo/stage/source',
    sourceDigestConfirmed: 'c'.repeat(64),
    bunArchive: '/var/lib/dedalo_publication_host_init/demo/stage/bun/bun-linux-x64.zip',
    bunSums: null,
    kitFile: null,
    kitDigestConfirmed: null,
    yes: false,
    decide: new Map(),
    resume: false,
    dryRun: false,
    pairName: INSTANCE,
    noPair: false,
    ...overrides,
  };
}

export function stagedSource(overrides: Partial<StagedSource> = {}): StagedSource {
  const dir_ = '/var/lib/dedalo_publication_host_init/demo/stage/source';
  return {
    dir: dir_,
    digest: 'c'.repeat(64),
    pin: PIN,
    shaTable: `# bun-v${PIN}\n# signed-by: ${'A'.repeat(40)}\n${'1'.repeat(64)}  bun-linux-x64.zip\n`,
    agentDir: `${dir_}/publication/host_agent`,
    agentDigest: 'd'.repeat(64),
    v2EnvExample: 'DB_HOST=localhost\n',
    v1Sample: '<?php\n',
    missingDependencies: [],
    devDependenciesPresent: [],
    testScratchPresent: false,
    ...overrides,
  };
}

export function compareCtx(overrides: Partial<CompareCtx> = {}): CompareCtx {
  return {
    source: stagedSource(),
    kept: null,
    pin: PIN,
    bunArchive: args().bunArchive,
    args: args(),
    journalOpen: [],
    lock: { held: false },
    ...overrides,
  };
}

/** The ids the converged-host accounts get in `declaredConverged`'s secret metadata (2001 v1, 2002 v2 group). */
export function withInstanceAccounts(facts: HostFacts): HostFacts {
  return {
    ...facts,
    accounts: {
      users: [
        ...facts.accounts.users,
        { name: 'demo_agent', uid: 2000, gid: 2000, home: '/nonexistent', shell: '/usr/sbin/nologin' },
        { name: 'demo_v1', uid: 2001, gid: 2001, home: '/nonexistent', shell: '/usr/sbin/nologin' },
        { name: 'demo_v2', uid: 2002, gid: 2002, home: '/nonexistent', shell: '/usr/sbin/nologin' },
      ],
      groups: [
        ...facts.accounts.groups,
        { name: 'demo_agent', gid: 2000, members: [] },
        { name: 'demo_v1', gid: 2001, members: [] },
        { name: 'demo_v2', gid: 2002, members: [] },
        { name: 'dedalo_pubhost', gid: 990, members: [] },
      ],
    },
  };
}
