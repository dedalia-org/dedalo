/**
 * init/observe.ts — both discovery passes over fake hosts built from the §3.2 fixtures:
 *   - EL 9 (Rocky, captured package output) with SELinux ENFORCING (typed), httpd, AppStream +
 *     Remi php82 (no CLI) + php84 (inactive), a template work unit; the same world over the
 *     captured EL 10 (Rocky 10) output, and Remi's mod_php under prefork (captured on Rocky 10);
 *   - Debian 12 Apache (captured -S, sites-enabled → sites-available links), SELinux absent;
 *   - Debian 12 nginx (typed -T with the guide's hand map), FPM 8.2 + 8.4 (captured -tt).
 * The fake exec is a Proxy that throws on any command it was not given and records every
 * call: discovery must be READ-ONLY. Seam: ObservePorts / DeclaredPorts (no host is touched).
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { InitExec, ProvisionExec } from '../src/provision/exec_contract';
import { DEFAULT_PATHS, derive } from '../src/provision/layout';
import type { HostState, PathFacts } from '../src/provision/plan';
import { PlanRefused } from '../src/provision/plan';
import { FINGERPRINT_PENDING } from '../src/provision/render/engine_fragment';
import { parseDeclaration } from '../src/provision/schema';
import { HOME_TRAVERSE_TYPE } from '../src/provision/selinux';
import type { DeclaredPorts, ObserveFs, ObservePorts } from '../src/provision/init/observe';
import {
  ENGINE_FRAGMENT_NAME,
  OUR_MAP_VARIABLES,
  declaredWritePaths,
  hostObserveFs,
  observeDeclared,
  observeHostWide,
} from '../src/provision/init/observe';
import { completeDraft } from '../src/provision/init/draft';
import type { TreeReader } from '../src/provision/init/tree_copy';
import { treeDigest } from '../src/provision/init/tree_copy';
import type { ExecResult, HostFacts } from '../src/provision/init/types';
import { sandboxHides } from '../src/provision/init/parse/systemd';
import { fixture } from './fixtures/init/load';

type AnyExec = ProvisionExec & InitExec;
type Handlers = Partial<Record<keyof AnyExec, (...args: never[]) => unknown>>;

const r = (stdout: string, code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr });

/** Every command discovery may run. Anything else (a creator, setsebool, an import, a reload) is a defect. */
const READ_ONLY = new Set<string>([
  'unameMachine',
  'passwdDb',
  'groupDb',
  'unitShow',
  'listCandidateUnits',
  'polkitVersion',
  'apacheVhosts',
  'apacheModules',
  'fpmDump',
  'phpVersion',
  'webVersion',
  'bunVersion',
  'selinuxMode',
  'semanageLocal',
  'semanagePortList',
  'getsebool',
  'systemdVersion',
  'selinuxLabel',
  'nginxDump',
  'unitState',
  'restorecon', // dry-run only: asserted per call below
]);

function fakeExec(handlers: Handlers, calls: { name: string; args: unknown[] }[]): AnyExec {
  return new Proxy({} as AnyExec, {
    get(_, name: string) {
      return (...args: unknown[]) => {
        calls.push({ name, args });
        const handler = handlers[name as keyof AnyExec] as ((...a: unknown[]) => unknown) | undefined;
        if (handler === undefined) throw new Error(`fake exec: unexpected command ${name}`);
        return handler(...args);
      };
    },
  });
}

const DIR = (uid = 0, mode = 0o755): PathFacts => ({ type: 'dir', uid, gid: uid, mode });
const FILE = (uid = 0, mode = 0o644): PathFacts => ({ type: 'file', uid, gid: uid, mode });

interface FakeHost {
  readonly files: Map<string, string>;
  readonly proc: Map<string, string>;
  readonly entries: Map<string, PathFacts>;
  readonly dirs: Map<string, string[]>;
  readonly links: Map<string, string>;
  readonly handlers: Handlers;
  readonly calls: { name: string; args: unknown[] }[];
}

function newHost(): FakeHost {
  return { files: new Map(), proc: new Map(), entries: new Map(), dirs: new Map(), links: new Map(), handlers: {}, calls: [] };
}

/** Adds a file (and its text) with root-owned ancestors. */
function put(host: FakeHost, path: string, text: string | null, facts: PathFacts = FILE()): void {
  if (text !== null) host.files.set(path, text);
  host.entries.set(path, facts);
  for (let dir = path.slice(0, path.lastIndexOf('/')); dir !== ''; dir = dir.slice(0, dir.lastIndexOf('/'))) {
    if (!host.entries.has(dir)) host.entries.set(dir, DIR());
  }
  host.entries.set('/', host.entries.get('/') ?? DIR());
}

function fakeFs(host: FakeHost): ObserveFs {
  return {
    lstat: path => host.entries.get(path) ?? null,
    readDir: path => (host.dirs.has(path) ? [...(host.dirs.get(path) as string[])].sort() : null),
    realpath: path => host.links.get(path) ?? (host.entries.has(path) ? path : null),
  };
}

function ports(host: FakeHost): ObservePorts {
  return {
    io: {
      readRootFile: path => host.files.get(path) ?? null,
      readProcFile: path => host.proc.get(path) ?? null,
      readOperatorFile: path => {
        const text = host.files.get(path);
        if (text === undefined) throw new Error(`fake io: no operator file ${path}`);
        const bytes = new TextEncoder().encode(text);
        const facts = host.entries.get(path) ?? FILE();
        return { bytes, uid: facts.uid, gid: facts.gid, mode: facts.mode, sha: createHash('sha256').update(bytes).digest('hex') };
      },
    },
    exec: fakeExec(host.handlers, host.calls),
    fs: fakeFs(host),
  };
}

/** Maps → objects, so a JSON search sees every value the facts hold. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_, inner) => (inner instanceof Map ? Object.fromEntries(inner) : inner instanceof Set ? [...inner] : inner));
}

function assertReadOnly(host: FakeHost): void {
  for (const call of host.calls) {
    expect(READ_ONLY.has(call.name)).toBe(true);
    if (call.name === 'restorecon') expect(call.args[1]).toBe(true);
  }
}

const show = (name: string) => fixture(`typed/systemd/${name}`);

/* ── the EL 9 (and EL 10) enforcing host ──────────────────────────────────────────── */

const MUSEUM_PASSWD = 'museum:x:1002:1002::/home/museum.org:/bin/bash\ndedalo_site:x:1500:1500::/srv/dedalo:/bin/bash\n';
const MUSEUM_GROUP = 'museum:x:1002:\ndedalo_site:x:1500:\ndedalo_pubhost:x:980:\n';

/** The EL world over a capture: `rocky9` (default) or `rocky10`, with that release's typed kernel. */
function elHost(release: 'rocky9' | 'rocky10' = 'rocky9'): FakeHost {
  const host = newHost();
  const c = (name: string) => fixture(`captured/${release}/${name}`);
  put(host, '/etc/os-release', c('os-release'));
  put(host, '/etc/selinux/config', c('selinux_config'));
  host.entries.set('/etc/selinux/targeted', DIR());
  for (const tool of ['/usr/sbin/semanage', '/usr/sbin/setfiles', '/usr/sbin/getsebool']) put(host, tool, null, FILE(0, 0o755));
  // policycoreutils ships restorecon as a link to setfiles (measured, RHEL 9.8: `restorecon -> setfiles`).
  host.entries.set('/usr/sbin/restorecon', { type: 'symlink', uid: 0, gid: 0, mode: 0o777 });
  host.links.set('/usr/sbin/restorecon', '/usr/sbin/setfiles');
  put(host, '/etc/sudoers', c('sudoers'), FILE(0, 0o440));
  host.entries.set('/etc/sudoers.d', DIR(0, 0o750));
  put(host, '/proc/cpuinfo', fixture('typed/cpu/cpuinfo_x86_avx2.txt'));
  put(host, '/etc/nsswitch.conf', c('nsswitch.conf'));
  put(host, '/etc/sssd/sssd.conf', fixture('typed/accounts/sssd_no_domains.conf'), FILE(0, 0o600));
  put(host, '/etc/shells', c('shells'));
  put(host, '/usr/bin/unzip', null, FILE(0, 0o755));
  put(host, '/usr/bin/chattr', null, FILE(0, 0o755));
  host.dirs.set('/lib', ['ld-linux-x86-64.so.2', 'modules']);
  // httpd
  put(host, '/usr/sbin/httpd', null, FILE(0, 0o755));
  put(host, '/usr/sbin/apachectl', null, FILE(0, 0o755));
  put(host, '/etc/httpd/conf.d/php.conf', c('php.conf'));
  const modulesD = ['00-base.conf', '00-mpm.conf', '00-optional.conf', '00-proxy.conf', '00-ssl.conf', '10-proxy_h2.conf'];
  host.dirs.set('/etc/httpd/conf.modules.d', [...modulesD, 'README']);
  for (const name of modulesD) put(host, `/etc/httpd/conf.modules.d/${name}`, c(`conf.modules.d/${name}`));
  put(host, '/etc/httpd/conf.d/museum.org-le-ssl.conf', fixture('typed/apache/sites/el_museum.org-le-ssl.conf'));
  put(host, '/etc/httpd/conf.d/ssl.conf', c('ssl.conf'));
  // FPM: AppStream (a site pool + www with an env[] secret), Remi php82 (no CLI), php84 (inactive)
  put(host, '/usr/sbin/php-fpm', null, FILE(0, 0o755));
  put(host, '/usr/bin/php', null, FILE(0, 0o755));
  host.dirs.set('/etc/php-fpm.d', ['museum.conf', 'www.conf']);
  put(host, '/etc/php-fpm.d/museum.conf', fixture('typed/fpm/pool_site.conf'));
  put(host, '/etc/php-fpm.d/www.conf', fixture('typed/fpm/pool_www.conf'));
  host.dirs.set('/etc/opt/remi', c('ls_etc_opt_remi.txt').trim().split('\n'));
  for (const nn of ['82', '84']) {
    put(host, `/opt/remi/php${nn}/root/usr/sbin/php-fpm`, null, FILE(0, 0o755));
    host.entries.set(`/var/opt/remi/php${nn}/run/php-fpm`, DIR());
  }
  put(host, '/opt/remi/php84/root/usr/bin/php', null, FILE(0, 0o755));
  host.entries.set('/run/php-fpm', DIR());
  // the site home, the work engine's private dir, our fragment (still PENDING)
  host.entries.set('/home', DIR());
  host.entries.set('/home/museum.org', DIR(1002, 0o750));
  host.entries.set('/srv/dedalo/site/private', DIR(1500, 0o700));
  put(host, `/etc/dedalo_publication_host/museum_org/${ENGINE_FRAGMENT_NAME}`, `DEDALO_PUBLICATION_HOST_FINGERPRINT="${FINGERPRINT_PENDING}"\n`);

  host.proc.set('/proc/sys/kernel/osrelease', fixture(release === 'rocky10' ? 'typed/kernel/osrelease_el10' : 'typed/kernel/osrelease_el9'));
  host.proc.set('/proc/self/mountinfo', fixture('typed/mounts/mountinfo_cis.txt'));
  host.proc.set('/proc/self/attr/current', fixture('typed/selinux/attr_current_unconfined'));
  host.proc.set('/proc/net/tcp', fixture('typed/net/proc_net_tcp.txt'));
  host.proc.set('/proc/net/tcp6', fixture('typed/net/proc_net_tcp6.txt'));

  const labels = fixture('typed/selinux/stat_labels.txt').trim().split('\n');
  const remi84 = c('remi82_fpm_tt.txt').replaceAll('php82', 'php84'); // derived: the php84 twin of the captured php82 dump
  Object.assign(host.handlers, {
    listCandidateUnits: () => r(show('list_units_el9.txt')),
    passwdDb: () => r(c('getent_passwd.txt') + MUSEUM_PASSWD),
    groupDb: () => r(c('getent_group.txt') + MUSEUM_GROUP),
    unameMachine: () => r('x86_64\n'),
    unitShow: (unit: string) =>
      r(
        unit === 'fapolicyd'
          ? show('show_fapolicyd_active.txt')
          : unit === 'polkit'
            ? fixture('captured/debian13/systemctl_show_polkit.txt') // listed active on this host; asked only when it is not
            : unit === 'httpd'
            ? show('show_web_default.txt')
            : unit === 'dedalo-ts@site'
              ? show('show_dedalo_ts_at_site.txt')
              : show('show_fpm_readonly_varlib.txt'),
      ),
    systemdVersion: () => r(c('systemctl_version.txt')),
    polkitVersion: () => r(c('pkaction_version.txt')),
    selinuxMode: () => r(fixture('typed/selinux/getenforce_enforcing.txt')),
    getsebool: (name: string) =>
      name === 'httpd_use_fusefs'
        ? r('', 1, fixture('typed/selinux/getsebool_unknown_stderr.txt'))
        : r(`${name} --> ${name === 'httpd_can_network_relay' || name === 'httpd_graceful_shutdown' ? 'on' : 'off'}\n`),
    semanageLocal: (kind: string) => r(fixture(kind === 'fcontext' ? 'typed/selinux/fcontext_local_ours.txt' : 'typed/selinux/port_local_ours.txt')),
    semanagePortList: () => r(c('semanage_port_l.txt')),
    selinuxLabel: (paths: readonly string[]) =>
      r(
        paths
          .map(path => labels.find(line => line.endsWith(` ${path}`)) ?? `system_u:object_r:var_run_t:s0 ${path}`)
          .join('\n'),
      ),
    webVersion: () => r(c('apache_v.txt')),
    apacheVhosts: () => r('', 0, c('apache_S.txt')),
    apacheModules: () => r(c('apache_M.txt')),
    fpmDump: (bin: string) =>
      bin === '/usr/sbin/php-fpm'
        ? r('', 0, fixture('typed/fpm/fpm_tt_site.txt'))
        : r('', 0, bin.includes('php82') ? c('remi82_fpm_tt.txt') : remi84),
    phpVersion: (cli: string) => r(cli === '/usr/bin/php' ? c('php_version.txt') : c('remi84_php_version.txt')),
  } satisfies Handlers);
  return host;
}

const EL_DRAFT = { apis: 'v1_and_v2' as const, instance: 'museum_org', site: { domain: 'museum.org' }, web: { server: 'apache' as const } };

describe('observeHostWide — EL 10 (captured Rocky 10): the same world, the EL 10 row', () => {
  const facts = observeHostWide(EL_DRAFT, ports(elHost('rocky10')));

  test('OS row 10 (no dnf modules), kernel 6.12, systemd 257, polkit 125, httpd 2.4.63, AppStream PHP 8.3 + Remi', () => {
    expect(facts.os).toMatchObject({ id: 'rocky', versionId: '10.2', family: 'el', supported: true });
    expect(facts.os.support).toMatchObject({ version: '10', dnfModules: false, webUser: 'apache', apacheFlavor: 'el' });
    expect(facts.kernel).toEqual({ release: '6.12.0-211.62.1.el10_2.x86_64', meetsFloor: true });
    expect(facts.systemd).toBe(257);
    expect(facts.polkit).toEqual({ version: 125, state: 'running' });
    expect(facts.web).toMatchObject({ server: 'apache', unit: 'httpd', version: '2.4.63', runUser: 'apache' });
    expect(facts.fpm.map(install => `${install.flavor}:${install.version}`)).toEqual(['el:8.3', 'remi:8.2', 'remi:8.4']);
    expect(facts.nss).toMatchObject({ passwdFilesOnly: true, groupFilesOnly: true });
  });
});

describe('observeHostWide — EL 10 unit sandboxes as the RHEL 10.2 drill VM measured them (captured/rhel10_drill_vm)', () => {
  const host = elHost('rocky10');
  const base = host.handlers.unitShow as (unit: string) => ReturnType<typeof r>;
  host.handlers.unitShow = (unit: string) =>
    unit === 'httpd'
      ? r(fixture('captured/rhel10_drill_vm/show_web_default.txt'))
      : unit === 'polkit'
        ? r(fixture('captured/rhel10_drill_vm/show_polkit.txt'))
        : base(unit);
  const facts = observeHostWide(EL_DRAFT, ports(host));

  test('httpd: ProtectHome=read-only, ProtectSystem=yes (read, so the home layout stays offered: sandboxHides with write=false)', () => {
    expect(facts.web.unitSandbox).toMatchObject({ protectHome: 'read-only', protectSystem: 'yes', inaccessible: [], readOnly: [], tmpfs: [] });
    expect(sandboxHides(facts.web.unitSandbox as NonNullable<typeof facts.web.unitSandbox>, '/home/museum.org/dedalo')).toEqual([]);
  });

  test('polkit.service sandboxed (ProtectSystem=strict, User=polkitd) is still the running polkit 125', () => {
    expect(facts.polkit).toEqual({ version: 125, state: 'running' });
  });
});

describe('observeHostWide — EL 9, SELinux enforcing, httpd, AppStream + Remi', () => {
  const host = elHost();
  const facts = observeHostWide(EL_DRAFT, ports(host));

  test('OS, kernel, panel, systemd, polkit, sudo, cpu, tools, ports, fapolicyd', () => {
    expect(facts.os).toMatchObject({ id: 'rocky', versionId: '9.8', family: 'el', supported: true });
    expect(facts.os.support?.version).toBe('9');
    expect(facts.kernel).toEqual({ release: '5.14.0-427.el9.x86_64', meetsFloor: true });
    expect(facts.panel).toBeNull();
    expect(facts.systemd).toBe(252);
    expect(facts.polkit).toEqual({ version: 117, state: 'running' });
    expect(facts.sudo).toEqual({ present: true, includedir: true, flavor: 'sudo', policyFile: '/etc/sudoers', skipped: [] });
    expect(facts.cpu).toEqual({ arch: 'x64', avx2: true, musl: false });
    expect(facts.tools).toEqual({ unzip: true, chattr: true });
    expect(facts.ports).toEqual([22, 80, 443, 3100]);
    expect(facts.fapolicyd.active).toBe(true);
    expect(facts.mounts.find(row => row.mountPoint === '/home')?.noexec).toBe(true);
  });

  test('SELinux tools: restorecon is a link to setfiles (EL); a dangling link is a missing tool', () => {
    expect(facts.selinux.tools.restorecon).toBe(true);
    const dangling = elHost();
    dangling.links.delete('/usr/sbin/restorecon');
    dangling.entries.delete('/usr/sbin/setfiles');
    expect(observeHostWide(EL_DRAFT, ports(dangling)).selinux.tools).toEqual({ semanage: true, restorecon: false, getsebool: true });
  });

  test('NSS: authselect sss files systemd with sssd domain-less is files-only', () => {
    expect(facts.nss).toEqual({ passwdFilesOnly: true, groupFilesOnly: true, sssDomains: false });
    expect(facts.accounts.users.find(user => user.name === 'apache')?.uid).toBe(48);
    expect(facts.shells).toContain('/bin/bash');
  });

  test('SELinux: mode, policy, store, tools, the unconfined root, booleans (an unknown one left out), local rules, port types, labels', () => {
    const selinux = facts.selinux;
    expect(selinux).toMatchObject({ mode: 'enforcing', policy: 'targeted', storePresent: true, tools: { semanage: true, restorecon: true, getsebool: true } });
    expect(selinux.rootContext).toBe('unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023');
    expect(selinux.booleans.httpd_can_network_relay).toBe(true);
    expect(selinux.booleans.httpd_graceful_shutdown).toBe(true);
    expect(selinux.booleans.httpd_enable_homedirs).toBe(false);
    expect('httpd_use_fusefs' in selinux.booleans).toBe(false);
    expect(selinux.localFcontext).toHaveLength(11);
    expect(selinux.localFcontext[0]).toMatchObject({ spec: '/home/museum\\.org', type: 'home_root_t' });
    expect(selinux.localPorts).toEqual([3100, 3101, 3102, 3103, 3104].map(port => ({ type: 'http_port_t', proto: 'tcp', port })));
    expect(selinux.portTypes.get(8443)).toBe('http_port_t');
    expect(selinux.portTypes.get(3306)).toBe('mysqld_port_t');
    expect(selinux.labels.get('/home/museum.org')).toBe('user_home_dir_t');
    expect(selinux.labels.get('/var/opt/remi/php82/run/php-fpm')).toBe('httpd_var_run_t');
    const labelled = host.calls.find(call => call.name === 'selinuxLabel')?.args[0] as string[];
    expect(labelled).toEqual(['/home/museum.org', '/home', '/run/php-fpm', '/var/opt/remi/php82/run/php-fpm', '/var/opt/remi/php84/run/php-fpm']);
  });

  test('FPM: AppStream 8.0 (from its CLI) with its pools; Remi 8.2 without a CLI; Remi 8.4 inactive; socket labels', () => {
    expect(facts.fpm.map(install => `${install.flavor}:${install.version}`)).toEqual(['el:8.0', 'remi:8.2', 'remi:8.4']);
    const [appstream, remi82, remi84] = facts.fpm;
    expect(appstream).toMatchObject({ bin: '/usr/sbin/php-fpm', unit: 'php-fpm', unitActive: true, cli: '/usr/bin/php', cliVersion: '8.0.30', socketDirLabel: 'var_run_t' });
    expect(appstream?.pools.map(pool => [pool.name, pool.file])).toEqual([
      ['museum_org', '/etc/php-fpm.d/museum.conf'],
      ['www', '/etc/php-fpm.d/www.conf'],
    ]);
    expect(appstream?.unitSandbox).toMatchObject({ protectHome: 'read-only', readOnly: ['/var/lib'] });
    expect(remi82).toMatchObject({ cli: null, cliVersion: null, unitActive: true, socketDirLabel: 'httpd_var_run_t' });
    expect(remi82?.pools[0]?.listen).toBe('/var/opt/remi/php82/run/php-fpm/www.sock');
    expect(remi84).toMatchObject({ unitActive: false, cliVersion: '8.4.26', socketDirLabel: 'var_t' });
  });

  test('httpd: el flavor, dump binary, version, run user, modules, conf.modules.d, the server-wide php.conf handler (not inside <If>)', () => {
    expect(facts.web).toMatchObject({
      candidates: ['apache'],
      server: 'apache',
      unit: 'httpd',
      flavor: 'el',
      configtestBin: '/usr/sbin/apachectl',
      dumpBin: '/usr/sbin/httpd',
      version: '2.4.62',
      runUser: 'apache',
      runGroup: 'apache',
      phpModule: false,
      phpModuleOnly: false,
      globalPhpHandler: { file: '/etc/httpd/conf.d/php.conf', pattern: '\\.(php|phar)$', insideIf: false },
      confDInHttp: null,
      foreignMaps: [],
    });
    expect(facts.web.modules).toContain('ssl');
    expect(facts.web.modulesD.some(line => line.module === 'ssl_module' && !line.commented)).toBe(true);
    expect(facts.web.unitSandbox?.protectHome).toBe('no');
  });

  test('vhosts: only the one claiming museum.org (ssl.conf\'s _default_ does not), with file sha and a clean trust', () => {
    expect(facts.web.vhosts).toHaveLength(1);
    const vhost = facts.web.vhosts[0];
    expect(vhost).toMatchObject({
      file: '/etc/httpd/conf.d/museum.org-le-ssl.conf',
      realpath: '/etc/httpd/conf.d/museum.org-le-ssl.conf',
      line: 2,
      endLine: 10,
      port: 443,
      ssl: true,
      serverName: 'museum.org',
      matchedBy: 'servername',
      documentRoot: '/home/museum.org/httpdocs',
      ourReference: false,
      manualLines: [],
      fileTrust: [],
    });
    expect(vhost?.fileSha).toBe(createHash('sha256').update(fixture('typed/apache/sites/el_museum.org-le-ssl.conf')).digest('hex'));
  });

  test('the work unit: template instance, User from a drop-in, group from passwd, privateDir defaulted, the fragment PENDING', () => {
    expect(facts.work).toEqual([
      {
        unit: 'dedalo-ts@site',
        user: 'dedalo_site',
        group: 'dedalo_site',
        checkout: '/srv/dedalo/site/master_dedalo',
        bun: '/usr/local/bin/bun',
        env: {},
        privateDir: '/srv/dedalo/site/private',
        privateUid: 1500,
        fragmentPending: true,
      },
    ]);
  });

  test('NO CREDENTIAL IN FACTS and NO RAW DUMP: secrets of pool files, -tt, sssd.conf never appear', () => {
    const text = serialize(facts);
    expect(text).not.toContain('not-a-real-secret');
    expect(text).not.toContain('Syntax OK');
    expect(text).not.toContain('LoadModule');
    expect(text).not.toContain('pm.status_listen');
  });

  test('discovery is read-only', () => assertReadOnly(host));
});

describe('observeHostWide — SELinux branches and loud failures', () => {
  test('disabled with the policy store: local rules are still read (S9), no boolean, no label', () => {
    const host = elHost();
    host.handlers.selinuxMode = () => r('Disabled\n');
    const facts = observeHostWide(EL_DRAFT, ports(host));
    expect(facts.selinux.mode).toBe('disabled');
    expect(facts.selinux.localFcontext).toHaveLength(11);
    expect(facts.selinux.booleans).toEqual({});
    expect(facts.selinux.labels.size).toBe(0);
    expect(facts.fpm[1]?.socketDirLabel).toBeNull();
    expect(host.calls.some(call => call.name === 'getsebool' || call.name === 'selinuxLabel')).toBe(false);
  });

  test('absent: no root context read, no semanage when the tool is missing', () => {
    const host = elHost();
    host.handlers.selinuxMode = () => r('', 127);
    host.entries.delete('/usr/sbin/semanage');
    const facts = observeHostWide(EL_DRAFT, ports(host));
    expect(facts.selinux).toMatchObject({ mode: 'absent', rootContext: null, localFcontext: [], localPorts: [] });
    expect(facts.selinux.portTypes.size).toBe(0);
    expect(host.calls.some(call => call.name === 'semanageLocal')).toBe(false);
  });

  test('a sysadm_t root context is reported as such; a malformed one is null', () => {
    const host = elHost();
    host.proc.set('/proc/self/attr/current', fixture('typed/selinux/attr_current_sysadm'));
    expect(observeHostWide(EL_DRAFT, ports(host)).selinux.rootContext).toBe('staff_u:sysadm_r:sysadm_t:s0');
    host.proc.set('/proc/self/attr/current', 'kernel\0');
    expect(observeHostWide(EL_DRAFT, ports(host)).selinux.rootContext).toBeNull();
  });

  test('loud: a getent that fails, an unreadable kernel release, a failed -tt, a failing semanage', () => {
    const failing = elHost();
    failing.handlers.passwdDb = () => r('', 2, 'getent: boom');
    expect(() => observeHostWide(EL_DRAFT, ports(failing))).toThrow('getent passwd exited 2: getent: boom');
    const noKernel = elHost();
    noKernel.proc.delete('/proc/sys/kernel/osrelease');
    expect(() => observeHostWide(EL_DRAFT, ports(noKernel))).toThrow('osrelease is unreadable');
    const brokenFpm = elHost();
    brokenFpm.handlers.fpmDump = () => r('', 78, fixture('typed/fpm/fpm_tt_failed.txt'));
    expect(() => observeHostWide(EL_DRAFT, ports(brokenFpm))).toThrow('-tt exited 78');
    const semanage = elHost();
    semanage.handlers.semanageLocal = () => r('', 1, 'ValueError: SELinux policy is not managed');
    expect(() => observeHostWide(EL_DRAFT, ports(semanage))).toThrow('semanage fcontext -l -C exited 1');
  });

  test('an EL 8 host is unsupported (no row), its kernel below the floor; a panel marker is named', () => {
    const host = elHost();
    host.proc.set('/proc/sys/kernel/osrelease', '4.18.0-553.el8_10.x86_64\n');
    host.files.set('/etc/os-release', 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="8.10"\nPRETTY_NAME="Rocky Linux 8.10 (Green Obsidian)"\n');
    host.entries.set('/usr/local/cwpsrv', DIR());
    const facts = observeHostWide(EL_DRAFT, ports(host));
    expect(facts.os).toMatchObject({ id: 'rocky', versionId: '8.10', family: 'el', supported: false, support: null });
    expect(facts.kernel).toEqual({ release: '4.18.0-553.el8_10.x86_64', meetsFloor: false });
    expect(facts.panel).toBe('cwp');
  });

  test("Remi's mod_php under prefork (captured on EL 10): AppStream php.conf's handler is off → phpModuleOnly", () => {
    const host = elHost('rocky10');
    host.handlers.apacheModules = () => r(fixture('captured/rocky10_prefork_remi/apache_M.txt'));
    host.files.set('/etc/httpd/conf.d/php.conf', fixture('captured/rocky10_prefork_remi/php.conf'));
    const facts = observeHostWide(EL_DRAFT, ports(host));
    expect(facts.web).toMatchObject({ phpModule: true, phpModuleOnly: true, globalPhpHandler: null });
    // Without mod_php (EL 9 and 10 AppStream ship none) the same php.conf IS the server-wide handler.
    expect(observeHostWide(EL_DRAFT, ports(elHost('rocky10'))).web).toMatchObject({ phpModule: false, phpModuleOnly: false, globalPhpHandler: { file: '/etc/httpd/conf.d/php.conf', insideIf: false } });
  });

  test('no draft domain: no vhost is read; no web server at all: empty web facts and no dump', () => {
    const host = elHost();
    const facts = observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(host));
    expect(facts.web.vhosts).toEqual([]);
    expect(host.calls.some(call => call.name === 'apacheVhosts')).toBe(true);
    const bare = elHost();
    bare.handlers.listCandidateUnits = () => r(show('list_units_none.txt'));
    const empty = observeHostWide(EL_DRAFT, ports(bare));
    expect(empty.web).toMatchObject({ candidates: [], server: null, unit: null, vhosts: [] });
    expect(empty.polkit.state).toBe('not_activatable');
    expect(empty.work).toEqual([]);
    expect(bare.calls.some(call => call.name === 'apacheVhosts' || call.name === 'webVersion')).toBe(false);
  });

  test('a web unit without its binary: configtest and dump binaries are null, nothing is dumped', () => {
    const host = elHost();
    host.entries.delete('/usr/sbin/httpd');
    host.entries.delete('/usr/sbin/apachectl');
    const facts = observeHostWide(EL_DRAFT, ports(host));
    expect(facts.web).toMatchObject({ server: 'apache', unit: 'httpd', configtestBin: null, dumpBin: null, version: null });
    expect(host.calls.some(call => call.name === 'apacheVhosts')).toBe(false);
  });
});

/* ── Debian 12 Apache ────────────────────────────────────────────────────────────── */

function debianApacheHost(): FakeHost {
  const host = newHost();
  const c = (name: string) => fixture(`captured/debian12/${name}`);
  put(host, '/etc/os-release', c('os-release'));
  put(host, '/etc/sudoers', c('sudoers'), FILE(0, 0o440));
  host.entries.set('/etc/sudoers.d', DIR(0, 0o755));
  put(host, '/etc/nsswitch.conf', c('nsswitch.conf'));
  put(host, '/etc/shells', c('shells'));
  put(host, '/proc/cpuinfo', fixture('typed/cpu/cpuinfo_x86_noavx2.txt'));
  put(host, '/usr/sbin/apache2ctl', null, FILE(0, 0o755));
  const sites: [string, string, PathFacts][] = [
    ['other.org.conf', fixture('typed/apache/sites/debian_other.org.conf'), FILE()],
    ['museum.org-le-ssl.conf', fixture('typed/apache/sites/debian_museum.org-le-ssl.conf'), FILE(1002, 0o664)],
    ['000-default.conf', c('000-default.conf'), FILE()],
    ['museum.org.conf', fixture('typed/apache/sites/debian_museum.org.conf'), FILE()],
  ];
  for (const [name, text, facts] of sites) {
    put(host, `/etc/apache2/sites-available/${name}`, text, facts);
    host.entries.set(`/etc/apache2/sites-enabled/${name}`, { type: 'symlink', uid: 0, gid: 0, mode: 0o777 });
    host.links.set(`/etc/apache2/sites-enabled/${name}`, `/etc/apache2/sites-available/${name}`);
  }
  host.dirs.set('/etc/php', ['8.2']);
  put(host, '/usr/sbin/php-fpm8.2', null, FILE(0, 0o755));
  put(host, '/usr/bin/php8.2', null, FILE(0, 0o755));
  host.dirs.set('/etc/php/8.2/fpm/pool.d', ['www.conf']);
  put(host, '/etc/php/8.2/fpm/pool.d/www.conf', '[www]\nuser = www-data\n');
  host.entries.set('/home/dedalo/v7/private', DIR(1001, 0o700));
  host.proc.set('/proc/sys/kernel/osrelease', fixture('typed/kernel/osrelease_debian12'));
  host.proc.set('/proc/self/mountinfo', '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n');
  host.proc.set('/proc/net/tcp', fixture('typed/net/proc_net_tcp.txt'));
  Object.assign(host.handlers, {
    listCandidateUnits: () => r(show('list_units_debian_apache.txt')),
    passwdDb: () => r(c('getent_passwd.txt') + 'dedalo:x:1001:1001::/home/dedalo:/bin/bash\n'),
    groupDb: () => r(c('getent_group.txt') + 'dedalo:x:1001:\n'),
    unameMachine: () => r('x86_64\n'),
    unitShow: (unit: string) =>
      r(
        unit === 'dedalo-ts'
          ? show('show_dedalo_ts.txt')
          : unit === 'fapolicyd'
            ? show('show_fapolicyd_notfound.txt')
            : unit === 'polkit'
              ? fixture('captured/debian13/systemctl_show_polkit.txt') // static, inactive: no activation file in this fake
              : show('show_web_default.txt'),
      ),
    systemdVersion: () => r(c('systemctl_version.txt')),
    polkitVersion: () => r(c('pkaction_version.txt')),
    selinuxMode: () => r('', 127),
    webVersion: () => r(c('apache_v.txt')),
    apacheVhosts: () => r('', 0, c('apache_S.txt')),
    apacheModules: () => r(c('apache_M.txt')),
    fpmDump: () => r('', 0, c('fpm_tt.txt')),
    phpVersion: () => r(c('php_version.txt')),
  } satisfies Handlers);
  return host;
}

describe('observeHostWide — Debian 12 Apache, no SELinux', () => {
  const host = debianApacheHost();
  const facts = observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org', site: { domain: 'museum.org' } }, ports(host));

  test('OS, polkit 122, @includedir sudo, no AVX2, no SELinux, no fapolicyd', () => {
    expect(facts.os).toMatchObject({ id: 'debian', family: 'debian', supported: true });
    expect(facts.polkit.version).toBe(122);
    expect(facts.sudo.includedir).toBe(true);
    expect(facts.cpu.avx2).toBe(false);
    expect(facts.selinux).toMatchObject({ mode: 'absent', policy: null, storePresent: false, rootContext: null, booleans: {} });
    expect(facts.fapolicyd.active).toBe(false);
    expect(facts.nss.passwdFilesOnly).toBe(true);
  });

  test('apache2: debian flavor, no php.conf reading, modules, run user', () => {
    expect(facts.web).toMatchObject({ server: 'apache', unit: 'apache2', flavor: 'debian', dumpBin: '/usr/sbin/apache2ctl', configtestBin: '/usr/sbin/apache2ctl', version: '2.4.68', runUser: 'www-data', globalPhpHandler: null, modulesD: [] });
    expect(facts.web.candidates).toEqual(['apache']);
  });

  test('vhosts through sites-enabled links: the :443 (untrusted file) and the :80; the wildcard-only and the default are not', () => {
    expect(facts.web.vhosts.map(vhost => [vhost.port, vhost.matchedBy, vhost.realpath])).toEqual([
      [443, 'servername', '/etc/apache2/sites-available/museum.org-le-ssl.conf'],
      [80, 'servername', '/etc/apache2/sites-available/museum.org.conf'],
    ]);
    const tls = facts.web.vhosts[0];
    expect(tls?.file).toBe('/etc/apache2/sites-enabled/museum.org-le-ssl.conf');
    expect(tls?.fpmHandler).toBe('/run/php/php8.2-fpm-museum.org.sock');
    expect(tls?.fileTrust).toEqual([
      "'/etc/apache2/sites-available/museum.org-le-ssl.conf' is owned by uid 1002, not root",
    ]);
    expect(facts.web.vhosts[1]?.fileTrust).toEqual([]);
  });

  test('FPM 8.2 with its CLI; the work unit keeps only non-secret DEDALO_* entries; no fragment yet', () => {
    expect(facts.fpm).toHaveLength(1);
    expect(facts.fpm[0]).toMatchObject({ flavor: 'debian', version: '8.2', cliVersion: '8.2.34', pools: [{ name: 'www', file: '/etc/php/8.2/fpm/pool.d/www.conf', user: 'www-data' }] });
    expect(facts.work[0]).toMatchObject({
      unit: 'dedalo-ts',
      user: 'dedalo',
      group: 'dedalo',
      env: { DEDALO_PRIVATE_DIR: '/home/dedalo/v7/private', DEDALO_SITE_TITLE: 'Museo de prueba' },
      privateDir: '/home/dedalo/v7/private',
      privateUid: 1001,
      fragmentPending: null,
    });
    expect(serialize(facts)).not.toContain('hunter2');
  });

  test('read-only', () => assertReadOnly(host));
});

/* ── Debian 12 nginx ─────────────────────────────────────────────────────────────── */

function debianNginxHost(): FakeHost {
  const host = debianApacheHost();
  host.entries.delete('/usr/sbin/apache2ctl');
  put(host, '/usr/sbin/nginx', null, FILE(0, 0o755));
  put(host, '/etc/nginx/conf.d/museum.org.conf', 'server {}\n');
  // The hand map as a file too (the dump's section): the migration facts read it.
  const dump = fixture('typed/nginx/nginx_T_typed.txt');
  const section = dump.split('# configuration file /etc/nginx/conf.d/dedalo_hand_map.conf:\n')[1]?.split('\n# configuration file ')[0] ?? '';
  put(host, '/etc/nginx/conf.d/dedalo_hand_map.conf', section);
  host.dirs.set('/etc/php', ['8.2', '8.4']);
  put(host, '/usr/sbin/php-fpm8.4', null, FILE(0, 0o755));
  Object.assign(host.handlers, {
    listCandidateUnits: () => r(show('list_units_debian_nginx.txt')),
    nginxDump: () => r(fixture('typed/nginx/nginx_T_typed.txt')),
    webVersion: () => r('', 0, fixture('captured/debian12/nginx_v.txt')),
    fpmDump: (bin: string) => r('', 0, fixture(bin.endsWith('8.4') ? 'captured/debian13/fpm_tt.txt' : 'captured/debian12/fpm_tt.txt')),
  } satisfies Handlers);
  return host;
}

describe('observeHostWide — a local MariaDB (B4: the v1 transport default)', () => {
  const SOCKET: PathFacts = { type: 'other', uid: 0, gid: 0, mode: 0o777 };
  test('the first candidate that is a socket; a file there is not one; none → null; TCP 3306 from /proc/net/tcp', () => {
    const none = observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(debianApacheHost())).mariadb;
    expect(none.socket).toBeNull();
    const debian = debianApacheHost();
    put(debian, '/run/mysqld/mysqld.sock', null, SOCKET);
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(debian)).mariadb.socket).toBe('/run/mysqld/mysqld.sock');
    const el = debianApacheHost();
    put(el, '/run/mysqld/mysqld.sock', null, FILE());
    put(el, '/var/lib/mysql/mysql.sock', null, SOCKET);
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(el)).mariadb.socket).toBe('/var/lib/mysql/mysql.sock');
    const facts = observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(debianApacheHost()));
    expect(facts.mariadb.tcp3306).toBe(facts.ports.includes(3306));
  });
});

describe('observeHostWide — Debian 12 nginx, the guide\'s hand map', () => {
  const host = debianNginxHost();
  const facts = observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org', site: { domain: 'museum.org' } }, ports(host));

  test('nginx facts: version, run user, conf.d in http{}, the hand map as foreign, our map include excluded', () => {
    expect(facts.web).toMatchObject({ server: 'nginx', unit: 'nginx', flavor: 'debian', configtestBin: '/usr/sbin/nginx', dumpBin: '/usr/sbin/nginx', version: '1.22.1', runUser: 'nginx', runGroup: 'nginx', confDInHttp: true });
    expect(facts.web.foreignMaps.map(map => map.variable)).toEqual([...OUR_MAP_VARIABLES]);
    expect(facts.web.foreignMaps.every(map => map.file === '/etc/nginx/conf.d/dedalo_hand_map.conf')).toBe(true);
    // The migration facts (compare web.nginx_manual_map): hashed, stand-alone, and — this typed map
    // is not the generated one — a grammar problem named, so the seed is never offered for it.
    const row = facts.web.foreignMaps[0] as { fileSha?: string; standalone?: boolean; parseProblem?: string | null };
    expect(row.fileSha).toMatch(/^[0-9a-f]{64}$/);
    expect(row.standalone).toBe(true);
    expect(row.parseProblem).toMatch(/^line \d+: /);
  });

  test('vhosts: the exact server ONCE for both listens (443 + [::]:443), our reference, guide lines; the .x wildcard (a redirect); the uncompilable regex claims', () => {
    expect(facts.web.vhosts.map(vhost => [vhost.port, vhost.matchedBy, vhost.serverName, vhost.addresses, vhost.redirectOnly])).toEqual([
      [443, 'servername', 'museum.org', ['*', '[::]'], false],
      [80, 'wildcard', '_', ['*'], true],
      [8080, 'regex', '~^www\\d+\\.museum\\.org$', ['127.0.0.1'], false],
    ]);
    expect(facts.web.vhosts[0]).toMatchObject({ ourReference: true, fpmHandler: '/run/php-fpm/www.sock', ssl: true, documentRoot: '/home/museum.org/httpdocs' });
    expect(facts.web.vhosts[0]?.manualLines).toHaveLength(10);
  });

  test('FPM 8.2 + 8.4; polkit inactive; a hand map in our own host dir would not be foreign', () => {
    expect(facts.fpm.map(install => install.version)).toEqual(['8.2', '8.4']);
    expect(facts.fpm[1]?.pools[0]?.listen).toBe('/run/php/php8.4-fpm.sock');
    expect(facts.fpm[1]?.cli).toBeNull();
    // Not listed, and this fake's polkit unit is not D-Bus-activatable: nothing starts it.
    expect(facts.polkit.state).toBe('not_activatable');
    const own = debianNginxHost();
    own.handlers.nginxDump = () =>
      r(fixture('typed/nginx/nginx_T_typed.txt').replace('/etc/nginx/conf.d/dedalo_hand_map.conf', '/var/lib/dedalo_publication_host/_host/nginx_map/dedalo_media_map.nginx.conf'));
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(own)).web.foreignMaps).toEqual([]);
  });

  test('both servers installed: the draft picks; without one, no server is chosen', () => {
    const both = debianNginxHost();
    put(both, '/usr/sbin/apache2ctl', null, FILE(0, 0o755));
    both.handlers.listCandidateUnits = () => r(show('list_units_both.txt'));
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org', web: { server: 'nginx' } }, ports(both)).web).toMatchObject({ candidates: ['apache', 'nginx'], server: 'nginx' });
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(both)).web).toMatchObject({ candidates: ['apache', 'nginx'], server: null, unit: null });
  });

  test.each(['ubuntu2404_drill_vm', 'ubuntu2604_drill_vm'])('both installed, only nginx running (%s keeps a stopped, disabled apache2 loaded — measured): nginx is observed', vm => {
    const both = debianNginxHost();
    put(both, '/usr/sbin/apache2ctl', null, FILE(0, 0o755));
    both.handlers.listCandidateUnits = () => r(fixture(`captured/${vm}/list_units_debian.txt`));
    const web = observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(both)).web;
    expect(web).toMatchObject({ candidates: ['apache', 'nginx'], server: 'nginx', unit: 'nginx' });
    expect(web.configtestBin).toBe('/usr/sbin/nginx');
    expect(web.confDInHttp).toBe(true);
    // The draft still wins over the running one.
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org', web: { server: 'apache' } }, ports(both)).web).toMatchObject({ server: 'apache' });
  });

  test('read-only', () => assertReadOnly(host));
});

/* ── pass 2 ──────────────────────────────────────────────────────────────────────── */

const HOME_DECLARATION = {
  instance: 'museum_org',
  listen: { kind: 'unix' },
  agent_user: 'museum_org_agent',
  engine_group: 'dedalo_site',
  agent_dir: '/home/museum.org/host_agent',
  web: { server: 'apache', unit: 'httpd' },
  site: { domain: 'museum.org', fpm: { flavor: 'remi', version: '8.2' } },
  v1: { user: 'museum_org_v1' },
  state_root: '/home/museum.org/dedalo',
  media: { mode: 'none' },
  php_bin: '/usr/bin/php',
  bun_bin: '/home/museum.org/.bun/bin/bun',
  v2: { unit: 'museum_org_v2', user: 'museum_org_v2', group: 'museum_org_v2', port: 3100, health_url: 'http://127.0.0.1:3100/health' },
};

const SYSTEM_SIBLING = {
  ...HOME_DECLARATION,
  instance: 'other_org',
  agent_user: 'other_org_agent',
  agent_dir: '/opt/dedalo_publication_host/host_agent',
  site: undefined,
  v1: { user: 'other_org_v1' },
  state_root: '/srv/dedalo_publication_host/other_org',
  bun_bin: '/opt/dedalo_publication_host/bun/bin/bun',
  v2: { unit: 'other_org_v2', user: 'other_org_v2', group: 'other_org_v2', port: 3101, health_url: 'http://127.0.0.1:3101/health' },
};

const EMPTY_HOST_STATE: HostState = {
  trustRoot: '/',
  appendOnly: new Set(),
  paths: new Map(),
  contents: new Map(),
  users: new Map(),
  groups: new Map(),
  units: new Map(),
  accountGroups: new Map(),
  agentTree: { paths: [], incomplete: null },
};

function treeReader(files: Record<string, string>): TreeReader {
  const root = '/home/museum.org/host_agent';
  return {
    lstat: path => (path === root || path === `${root}/src` ? DIR() : files[path] !== undefined ? FILE() : null),
    readdir: path => (path === root ? ['package.json', 'src'] : path === `${root}/src` ? ['index.ts'] : []),
    readlink: () => {
      throw new Error('no links');
    },
    realpath: path => path,
    readFile: path => new TextEncoder().encode(files[path] ?? ''),
  };
}

function declaredHost(homeUid = 1002): { host: FakeHost; declared: DeclaredPorts; layout: ReturnType<typeof derive> } {
  const host = elHost();
  const { layout } = parseDeclaration(JSON.parse(JSON.stringify(HOME_DECLARATION)), '/etc/dedalo_publication_host/museum_org.json');
  const H = '/home/museum.org';
  host.entries.set(H, DIR(homeUid, homeUid === 0 ? 0o755 : 0o750));
  host.dirs.set(H, ['.bash_history', 'dedalo', 'host_agent', 'httpdocs', 'logs', '.bun']);
  host.entries.set(`${H}/.bash_history`, FILE(1002, 0o600));
  host.entries.set(`${H}/httpdocs`, DIR(1002));
  host.dirs.set(`${H}/httpdocs`, ['index.html', 'private.php', 'deep']);
  host.entries.set(`${H}/httpdocs/index.html`, FILE(1002, 0o644));
  host.entries.set(`${H}/httpdocs/private.php`, FILE(1002, 0o640));
  host.entries.set(`${H}/httpdocs/deep`, DIR(1002));
  host.dirs.set(`${H}/httpdocs/deep`, ['too_deep.html']);
  host.entries.set(`${H}/httpdocs/deep/too_deep.html`, FILE(1002, 0o644));
  host.entries.set(`${H}/logs`, DIR(1002));
  host.dirs.set(`${H}/logs`, ['access.log']);
  host.entries.set(`${H}/logs/access.log`, FILE(1002, 0o644));
  host.entries.set(`${H}/host_agent`, DIR());
  host.entries.set(`${H}/.bun`, DIR());
  host.entries.set(`${H}/.bun/bin`, DIR());
  host.entries.set(`${H}/.bun/bin/bun`, FILE(0, 0o755));
  host.entries.set(`${H}/dedalo`, DIR());
  host.dirs.set(`${H}/dedalo`, ['.dedalo_host_agent_instance', 'publication_api']);
  put(host, `${H}/dedalo/.dedalo_host_agent_instance`, 'museum_org\n');
  put(host, `${H}/dedalo/publication_api/v2/shared/v2.env`, null, FILE(0, 0o640));
  host.entries.set(layout.host.locksDir, DIR(0, 0o750));
  put(host, `${layout.host.mapRendererDir}/VERSION`, `${JSON.stringify({ digest: 'a'.repeat(64), from: 'other_org', grammar: 2 })}\n`);
  host.files.set('/etc/dedalo_publication_host/other_org.json', JSON.stringify(SYSTEM_SIBLING));
  host.files.set('/etc/dedalo_publication_host/broken.json', '{ not json');
  Object.assign(host.handlers, {
    restorecon: () => r(fixture('typed/selinux/restorecon_n.txt')),
    unitState: () => ({ enabled: false, active: false }),
    bunVersion: () => r('1.4.3\n'),
  } satisfies Handlers);
  const base = ports(host);
  const declared: DeclaredPorts = {
    ...base,
    observeHost: () => EMPTY_HOST_STATE,
    listDeclarations: dir =>
      dir === '/etc/dedalo_publication_host'
        ? ['/etc/dedalo_publication_host/broken.json', '/etc/dedalo_publication_host/museum_org.json', '/etc/dedalo_publication_host/other_org.json']
        : [],
    treeReader: treeReader({ '/home/museum.org/host_agent/package.json': '{}', '/home/museum.org/host_agent/src/index.ts': 'export {};\n' }),
  };
  return { host, declared, layout };
}

/* ── dual stack: one vhost per VHOST, not per listen address ──────────────────────── */

/**
 * The guided install on a site served on IPv4 + IPv6 (the bug: init blocked with a manual-only
 * "crowded" decision). Each world is the Debian 12 host with its vhosts replaced by a typed
 * dual-stack case; the gate runs discovery AND the draft completion: one site, no decision.
 */
describe('observeHostWide → completeDraft — dual-stack sites resolve to ONE vhost, no blocking decision', () => {
  const DRAFT = { apis: 'v1_and_v2', instance: 'museum_org', site: { domain: 'museum.org' }, media: { mode: 'shared', root: '/mnt/dedalo_media' } } as const;
  const dual = (name: string) => fixture(`typed/apache/dualstack/${name}`);
  const nginxDual = (name: string) => fixture(`typed/nginx/dualstack/${name}`);

  /** The Debian Apache world with these `-S` text and vhost files (real files at the -S paths, no links). */
  function apacheWorld(sText: string, files: Readonly<Record<string, string>>): FakeHost {
    const host = debianApacheHost();
    for (const [path, text] of Object.entries(files)) {
      host.links.delete(path);
      put(host, path, text);
    }
    host.handlers.apacheVhosts = () => r('', 0, sText);
    return host;
  }

  /** The Debian nginx world with this `-T` dump; every dumped file also on disk (observe hashes it). */
  function nginxWorld(dump: string): FakeHost {
    const host = debianNginxHost();
    const sections = dump.split(/^# configuration file (\/.+):$/m);
    for (let index = 1; index < sections.length; index += 2) put(host, sections[index] as string, sections[index + 1] ?? '');
    host.handlers.nginxDump = () => r(dump);
    return host;
  }

  const SITES = '/etc/apache2/sites-enabled';
  const resolve = (host: FakeHost) => {
    const facts = observeHostWide(DRAFT, ports(host));
    const completion = completeDraft(DRAFT, facts);
    return { facts, completion, decision: completion.decisions.find(row => row.id === 'declaration.vhost') };
  };

  test('Apache, ONE block on 192.0.2.1:443 + [2001:db8::1]:443 and a dual-stack :80 redirect: one row each, the redirect excluded, no decision', () => {
    const host = apacheWorld(dual('one_block_S.txt'), {
      [`${SITES}/museum.org-le-ssl.conf`]: dual('one_block.conf'),
      [`${SITES}/museum.org.conf`]: dual('redirect.conf'),
    });
    const { facts, completion, decision } = resolve(host);
    expect(facts.web.vhosts.map(row => [row.port, row.addresses, row.redirectOnly])).toEqual([
      [443, ['192.0.2.1', '[2001:db8::1]'], false],
      [80, ['*', '[::]'], true],
    ]);
    expect(decision).toBeUndefined();
    expect(completion.vhost).toMatchObject({ port: 443, line: 2, ssl: true, addresses: ['192.0.2.1', '[2001:db8::1]'] });
    expect(completion.vhostTwins).toEqual([]);
    assertReadOnly(host);
  });

  test('Apache, the :80 certbot redirect + a TLS site that redirects ONLY www → bare: the TLS site still serves, is chosen, no decision (review lane A)', () => {
    // Before: any %{HTTP_HOST} condition counted as "selects the host only", so the TLS site came
    // out redirect-only and init blocked on "the vhost they send to (the TLS one) is missing".
    const site = dual('one_block.conf').replace(
      '    SSLEngine on\n',
      '    RewriteEngine On\n    RewriteCond %{HTTP_HOST} ^www\\.museum\\.org$ [NC]\n    RewriteRule ^(.*)$ https://museum.org$1 [R=301,L]\n    SSLEngine on\n',
    );
    expect(site).toContain('RewriteCond %{HTTP_HOST}');
    const host = apacheWorld(dual('one_block_S.txt'), {
      [`${SITES}/museum.org-le-ssl.conf`]: site,
      [`${SITES}/museum.org.conf`]: dual('redirect.conf'),
    });
    const { facts, completion, decision } = resolve(host);
    expect(facts.web.vhosts.map(row => [row.port, row.redirectOnly])).toEqual([
      [443, false],
      [80, true],
    ]);
    expect(decision).toBeUndefined();
    expect(completion.vhost).toMatchObject({ port: 443, line: 2, ssl: true });
  });

  test('Apache, one block PER FAMILY (0.0.0.0:443 and [::]:443, separate files) + two :80 redirect blocks: one site of two twins, no decision', () => {
    const host = apacheWorld(dual('two_blocks_S.txt'), {
      [`${SITES}/museum.org-v4.conf`]: dual('two_blocks_v4.conf'),
      [`${SITES}/museum.org-v6.conf`]: dual('two_blocks_v6.conf'),
      [`${SITES}/museum.org-redirect.conf`]: dual('two_blocks_redirect.conf'),
    });
    const { facts, completion, decision } = resolve(host);
    expect(facts.web.vhosts.map(row => [row.port, row.addresses, row.redirectOnly])).toEqual([
      [443, ['0.0.0.0'], false],
      [443, ['[::]'], false],
      [80, ['0.0.0.0'], true],
      [80, ['[::]'], true],
    ]);
    expect(decision).toBeUndefined();
    expect(completion.vhost?.realpath).toBe(`${SITES}/museum.org-v4.conf`);
    expect(completion.vhostTwins.map(row => row.realpath)).toEqual([`${SITES}/museum.org-v6.conf`]);
  });

  test('nginx, ONE server with `listen 443 ssl; listen [::]:443 ssl;` and a dual-stack :80 `return 301`: one row each, no decision', () => {
    const { facts, completion, decision } = resolve(nginxWorld(nginxDual('one_block_T.txt')));
    expect(facts.web.vhosts.map(row => [row.port, row.ssl, row.addresses, row.redirectOnly])).toEqual([
      [80, false, ['*', '[::]'], true],
      [443, true, ['*', '[::]'], false],
    ]);
    expect(decision).toBeUndefined();
    expect(completion.vhost).toMatchObject({ port: 443, line: 7 });
    expect(completion.vhostTwins).toEqual([]);
  });

  test('nginx, one server PER FAMILY in one file (+ a :80 redirect per family): one site of two twins in the same file, no decision', () => {
    const { completion, decision } = resolve(nginxWorld(nginxDual('two_blocks_T.txt')));
    expect(decision).toBeUndefined();
    expect([completion.vhost?.line, completion.vhost?.addresses]).toEqual([12, ['*']]);
    expect(completion.vhostTwins.map(row => [row.line, row.addresses])).toEqual([[19, ['[::]']]]);
  });

  test('NEGATIVE: two genuinely different TLS blocks for one name on one family stay crowded — blocking, manual only (Apache and nginx)', () => {
    const apache = resolve(
      apacheWorld(dual('crowded_S.txt'), { [`${SITES}/museum.org.conf`]: dual('crowded_a.conf'), [`${SITES}/museum-old.conf`]: dual('crowded_b.conf') }),
    );
    expect(apache.decision).toMatchObject({ blocking: true, defaultOption: 'manual' });
    expect(apache.decision?.options.map(option => option.id)).toEqual(['manual']);
    expect(apache.decision?.facts[0]).toBe('port 443 has 2 different vhosts claiming ServerName museum.org:');
    expect(apache.decision?.facts[1]).toContain('on *, [::] (TLS)');
    expect(apache.completion.vhost).toBeNull();
    const nginx = resolve(nginxWorld(nginxDual('crowded_T.txt')));
    expect(nginx.decision).toMatchObject({ blocking: true, defaultOption: 'manual' });
    expect(nginx.completion.vhost).toBeNull();
  });
});

describe('observeDeclared — the home layout on the EL 9 enforcing host', () => {
  const { host, declared, layout } = declaredHost();
  const facts = observeHostWide(EL_DRAFT, ports(host));
  const result = observeDeclared(layout, facts, declared);

  test('paths and ancestry: the user-owned home is named above every path under it', () => {
    expect(result.paths.get(layout.state.root)?.type).toBe('dir');
    expect(result.ancestorProblems.get(layout.bunBin)).toEqual(["'/home/museum.org' (above '/home/museum.org/.bun/bin/bun') is owned by uid 1002, not root"]);
    expect(result.ancestorProblems.get(layout.state.root)).toEqual(["'/home/museum.org' (above '/home/museum.org/dedalo') is owned by uid 1002, not root"]);
    // The home itself is judged as a path, not as its own ancestor; /etc paths are clean.
    expect(result.ancestorProblems.has('/home/museum.org')).toBe(false);
    expect(result.ancestorProblems.has(layout.configBase)).toBe(false);
    expect(declaredWritePaths(layout)).toContain('/etc/opt/remi/php82/php-fpm.d');
    expect(declaredWritePaths(layout)).toContain('/var/lib/dedalo_publication_host/museum_org');
  });

  test('the pinned Bun does not run while its ancestry is untrusted', () => {
    expect(result.bunVersion).toBeNull();
    expect(host.calls.some(call => call.name === 'bunVersion')).toBe(false);
  });

  test('the agent tree digest is treeDigest over the same reader', () => {
    expect(result.agentTreeDigest).toBe(treeDigest(layout.agentDir, declared.treeReader));
    expect(result.agentTreeDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('siblings: the parseable one only (refusals are siblingProblems\'); anyHomeBound', () => {
    expect(result.siblings.map(sibling => sibling.layout.instance)).toEqual(['other_org']);
    expect(result.hostShared.anyHomeBound).toBe(true);
  });

  test('state root ours; home facts: entries, the home of museum, pool refs, layout dirs, traversable=false, the world-readable files ≤ depth 2', () => {
    expect(result.stateRoot).toBe('ours');
    expect(result.home.facts?.uid).toBe(1002);
    expect(result.home.fsType).toBe('xfs');
    expect(result.home.topEntries.map(entry => entry.name)).toContain('.bash_history');
    expect(result.home.homeOf).toEqual(['museum']);
    expect(result.home.poolRefs).toEqual([
      '/etc/php-fpm.d/museum.conf: [museum_org] chdir = /home/museum.org/httpdocs',
      '/etc/php-fpm.d/museum.conf: [museum_org] php_admin_value[error_log] = /home/museum.org/logs/php_error.log',
    ]);
    expect(result.home.layoutDirs['.bun']?.type).toBe('dir');
    expect(result.home.traversable).toBe(false);
    expect(result.home.worldReadable).toEqual(['dedalo/.dedalo_host_agent_instance', 'httpdocs/index.html', 'logs/access.log']);
    expect(result.home.worldReadableCount).toBe(3);
  });

  test('pending relabels from a dry run of existing targets only', () => {
    expect(result.selinuxPending).toEqual([
      { path: '/home/museum.org', from: 'user_home_dir_t', to: 'home_root_t' },
      { path: '/home/museum.org/dedalo/publication_api/v1', from: 'user_home_t', to: 'httpd_sys_content_t' },
    ]);
    const call = host.calls.find(entry => entry.name === 'restorecon');
    const targets = call?.args[0] as { path: string }[];
    expect(call?.args[1]).toBe(true);
    for (const target of targets) expect(host.entries.has(target.path)).toBe(true);
    expect(targets.map(target => target.path)).toContain('/home/museum.org');
  });

  test('host-wide state, API config metadata, the plan refused (accounts missing), the units', () => {
    expect(result.hostShared).toMatchObject({ group: true, nginxMap: null, mapInclude: null, renderer: { grammar: 2, digest: 'a'.repeat(64) } });
    expect(result.hostShared.locks?.mode).toBe(0o750);
    expect(result.apiConfig.v2).toEqual({ exists: true, uid: 0, gid: 0, mode: 0o640 });
    expect(result.apiConfig.v1).toBeNull();
    expect(result.plan).toBeInstanceOf(PlanRefused);
    expect(result.hostState).toBe(EMPTY_HOST_STATE);
    expect(result.agentUnit).toEqual({ enabled: false, active: false });
  });

  test('read-only', () => assertReadOnly(host));
});

describe('observeDeclared — branches', () => {
  test('a root-owned home: the pinned Bun runs and answers', () => {
    const { host, declared, layout } = declaredHost(0);
    const result = observeDeclared(layout, observeHostWide(EL_DRAFT, ports(host)), declared);
    expect(result.ancestorProblems.size).toBe(0);
    expect(result.bunVersion).toBe('1.4.3');
  });

  test('traversable: home_root_t, or httpd_enable_homedirs; null without SELinux; the home probed when pass 1 did not', () => {
    const labelled = declaredHost();
    const facts = observeHostWide(EL_DRAFT, ports(labelled.host));
    const relabelled = { ...facts, selinux: { ...facts.selinux, labels: new Map([['/home/museum.org', HOME_TRAVERSE_TYPE]]) } } as HostFacts;
    expect(observeDeclared(labelled.layout, relabelled, labelled.declared).home.traversable).toBe(true);
    const boolean = { ...facts, selinux: { ...facts.selinux, booleans: { ...facts.selinux.booleans, httpd_enable_homedirs: true } } } as HostFacts;
    expect(observeDeclared(labelled.layout, boolean, labelled.declared).home.traversable).toBe(true);
    const unprobed = { ...facts, selinux: { ...facts.selinux, labels: new Map() } } as HostFacts;
    expect(observeDeclared(labelled.layout, unprobed, labelled.declared).home.traversable).toBe(false);
    expect(labelled.host.calls.filter(call => call.name === 'selinuxLabel').at(-1)?.args[0]).toEqual(['/home/museum.org']);
    const off = { ...facts, selinux: { ...facts.selinux, mode: 'disabled' } } as HostFacts;
    const result = observeDeclared(labelled.layout, off, labelled.declared);
    expect(result.home.traversable).toBeNull();
    expect(result.selinuxPending).toEqual([]);
  });

  test('state root: absent, empty (ours), another instance\'s marker (foreign), a file (foreign)', () => {
    const { host, declared, layout } = declaredHost();
    const facts = observeHostWide(EL_DRAFT, ports(host));
    host.files.set(layout.state.marker, 'other_org\n');
    expect(observeDeclared(layout, facts, declared).stateRoot).toBe('foreign');
    host.dirs.set(layout.state.root, []);
    expect(observeDeclared(layout, facts, declared).stateRoot).toBe('ours');
    host.entries.set(layout.state.root, FILE());
    expect(observeDeclared(layout, facts, declared).stateRoot).toBe('foreign');
    host.entries.delete(layout.state.root);
    expect(observeDeclared(layout, facts, declared).stateRoot).toBe('absent');
  });

  test('a system layout: no home facts; no agent dir → no digest; a secret path that is a symlink is not a file', () => {
    const { host, declared } = declaredHost();
    const { layout } = parseDeclaration(JSON.parse(JSON.stringify(SYSTEM_SIBLING)), '/etc/dedalo_publication_host/other_org.json');
    host.entries.set(`${layout.v1!.dirs.shared}/server_config_api.php`, { type: 'symlink', uid: 1000, gid: 1000, mode: 0o777 });
    const result = observeDeclared(layout, observeHostWide(EL_DRAFT, ports(host)), declared);
    expect(result.home).toMatchObject({ facts: null, traversable: null, topEntries: [], worldReadableCount: 0 });
    expect(result.agentTreeDigest).toBeNull();
    expect(result.apiConfig.v1).toEqual({ exists: false, uid: 1000, gid: 1000, mode: 0o777 });
    // museum_org.json is not readable here: no sibling, and a system layout alone is not home-bound.
    expect(result.siblings).toEqual([]);
    expect(result.hostShared.anyHomeBound).toBe(false);
    // S10: once the home-bound sibling is read, ProtectHome=read-only is host-wide.
    host.files.set('/etc/dedalo_publication_host/museum_org.json', JSON.stringify(HOME_DECLARATION));
    const withSibling = observeDeclared(layout, observeHostWide(EL_DRAFT, ports(host)), declared);
    expect(withSibling.siblings.map(sibling => sibling.layout.instance)).toEqual(['museum_org']);
    expect(withSibling.hostShared.anyHomeBound).toBe(true);
  });

  test('an error from the host reader propagates (only PlanRefused becomes a fact)', () => {
    const { host, declared, layout } = declaredHost();
    const facts = observeHostWide(EL_DRAFT, ports(host));
    const broken: DeclaredPorts = {
      ...declared,
      observeHost: () => {
        throw new TypeError('host reader broke');
      },
    };
    expect(() => observeDeclared(layout, facts, broken)).toThrow('host reader broke');
  });
});

describe('contracts held equal', () => {
  test("ENGINE_FRAGMENT_NAME is derive()'s engineFragmentPath basename", () => {
    const { layout } = parseDeclaration(JSON.parse(JSON.stringify(HOME_DECLARATION)), 'x.json');
    expect(layout.engineFragmentPath).toBe(`${layout.instanceDir}/${ENGINE_FRAGMENT_NAME}`);
    expect(layout.configBase).toBe(DEFAULT_PATHS.configBase);
  });

  test('hostObserveFs reads the real filesystem without following links', () => {
    const fs = hostObserveFs();
    expect(fs.lstat(import.meta.dir)?.type).toBe('dir');
    expect(fs.readDir(import.meta.dir)).toContain('init_observe.test.ts');
    expect(fs.readDir('/nonexistent/dedalo')).toBeNull();
    expect(fs.realpath('/nonexistent/dedalo')).toBeNull();
    expect(fs.realpath(import.meta.dir)).not.toBeNull();
  });
});

/* ── polkit on demand, and sudo-rs's own policy file ─────────────────────────────── */

describe('observeHostWide — D-Bus-activated polkit (captured, systemd PID 1) and sudo-rs', () => {
  for (const release of ['debian13', 'ubuntu2604']) {
    test(`${release}: polkit not listed, static, inactive, activation file naming polkit.service → activatable (the drill's idle host)`, () => {
      const host = debianApacheHost();
      const shown = host.handlers.unitShow as (unit: string) => ExecResult;
      const listed = host.handlers.listCandidateUnits as () => ExecResult;
      // Captured: list-units prints nothing for polkit.service before the first request.
      host.handlers.listCandidateUnits = () => r(listed().stdout.split('\n').filter(line => !line.startsWith('polkit.service')).join('\n'));
      host.handlers.unitShow = (unit: string) => (unit === 'polkit' ? r(fixture(`captured/${release}/systemctl_show_polkit.txt`)) : shown(unit));
      put(host, '/usr/share/dbus-1/system-services/org.freedesktop.PolicyKit1.service', fixture(`captured/${release}/dbus_polkit.service`));
      const facts = observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(host));
      expect(facts.polkit).toEqual({ version: 122, state: 'activatable' });
      expect(host.calls.filter(call => call.name === 'unitShow').map(call => call.args[0])).toContain('polkit');
    });
  }

  test('listed active: running, and systemctl show is not asked', () => {
    const host = debianApacheHost(); // list_units_debian_apache lists polkit.service active
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(host)).polkit.state).toBe('running');
    expect(host.calls.some(call => call.name === 'unitShow' && call.args[0] === 'polkit')).toBe(false);
  });

  const sudoRs = (withOwnPolicy: string | null): FakeHost => {
    const host = debianApacheHost();
    host.files.set('/etc/sudoers', fixture('captured/ubuntu2604_sudo_rs/sudoers'));
    put(host, '/usr/lib/cargo/bin/sudo', null, FILE(0, 0o4755));
    host.entries.set('/usr/bin/sudo', { type: 'symlink', uid: 0, gid: 0, mode: 0o777 });
    host.links.set('/usr/bin/sudo', fixture('captured/ubuntu2604_sudo_rs/realpath.txt').trim());
    if (withOwnPolicy !== null) put(host, '/etc/sudoers-rs', fixture(`typed/sudo/${withOwnPolicy}`), FILE(0, 0o440));
    put(host, '/etc/sudoers-rs.local', fixture('typed/sudo/sudoers-rs.local'), FILE(0, 0o440));
    return host;
  };

  test('sudo-rs without /etc/sudoers-rs reads /etc/sudoers (the stock Ubuntu 26.04 server)', () => {
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(sudoRs(null))).sudo).toEqual({ present: true, includedir: true, flavor: 'sudo-rs', policyFile: '/etc/sudoers', skipped: [] });
  });

  test('sudo-rs with /etc/sudoers-rs reads THAT file: no include there → not policy, although /etc/sudoers includes sudoers.d', () => {
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(sudoRs('sudoers-rs'))).sudo).toEqual({ present: true, includedir: false, flavor: 'sudo-rs', policyFile: '/etc/sudoers-rs', skipped: [] });
  });

  test('sudo-rs with /etc/sudoers-rs reaching sudoers.d through a relative @include: policy', () => {
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(sudoRs('sudoers-rs_include'))).sudo).toEqual({ present: true, includedir: true, flavor: 'sudo-rs', policyFile: '/etc/sudoers-rs', skipped: [] });
  });

  test("S3-3: an included file sudo would not read (writable by others) is not followed, and host.sudo names it", () => {
    const host = sudoRs('sudoers-rs_include');
    put(host, '/etc/sudoers-rs.local', fixture('typed/sudo/sudoers-rs.local'), FILE(0, 0o666));
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(host)).sudo).toEqual({
      present: true,
      includedir: false,
      flavor: 'sudo-rs',
      policyFile: '/etc/sudoers-rs',
      skipped: ['/etc/sudoers-rs.local: mode 0666 is group- or world-writable — sudo does not read it'],
    });
  });

  test('classic sudo ignores an /etc/sudoers-rs', () => {
    const host = debianApacheHost();
    put(host, '/etc/sudoers-rs', fixture('typed/sudo/sudoers-rs'), FILE(0, 0o440));
    expect(observeHostWide({ apis: 'v1_and_v2', instance: 'museum_org' }, ports(host)).sudo).toEqual({ present: true, includedir: true, flavor: 'sudo', policyFile: '/etc/sudoers', skipped: [] });
  });
});

describe('observeHostWide — a v2-only draft runs no PHP discovery', () => {
  test('no FPM install, no PHP binary run (php -v, php-fpm -tt), no php.conf read; the rest observed as before', () => {
    const host = elHost('rocky9');
    const base = ports(host);
    const operatorReads: string[] = [];
    const recording: ObservePorts = {
      ...base,
      io: { ...base.io, readOperatorFile: path => (operatorReads.push(path), base.io.readOperatorFile(path)) },
    };
    const { apis: _apis, ...v2Only } = EL_DRAFT;
    const facts = observeHostWide(v2Only, recording);
    expect(facts.fpm).toEqual([]);
    expect(host.calls.some(call => call.name === 'fpmDump' || call.name === 'phpVersion')).toBe(false);
    expect(operatorReads).not.toContain('/etc/httpd/conf.d/php.conf');
    expect(facts.web.globalPhpHandler).toBeNull();
    expect(facts.web.phpModuleOnly).toBe(false);
    expect(facts.web).toMatchObject({ server: 'apache', unit: 'httpd', runUser: 'apache' });
    // The contrast: the same host with v1 discovers the installs.
    const withV1 = elHost('rocky9');
    expect(observeHostWide(EL_DRAFT, ports(withV1)).fpm.length).toBeGreaterThan(0);
    expect(withV1.calls.some(call => call.name === 'fpmDump')).toBe(true);
  });
});
