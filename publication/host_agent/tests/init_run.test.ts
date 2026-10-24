/**
 * init/run.ts — THE INTEGRATION (spec §9 init_run cases 1-21): runInit end to end on a FakeInitHost
 * (tests/support/provision_fake_host.ts) dressed as a whole host — os-release, the unit list, the
 * Apache `-S` / `-M` / DUMP_INCLUDES answers (computed from the vhost file the run edits), the FPM
 * install, /proc, the mount table, SELinux (EL) — so the REAL observe passes, draft, compare, act,
 * plan/apply (in-process, through cli.ts run), web_txn, bun_install, verify and pair all run on it.
 * Nothing touches the machine: every door is the fake's. Seams: InitWorld (run.ts), the fake
 * LockIo's clock, a scripted prompter (tty.ts scriptedPrompter), a fake health fetch, and two
 * hooks on the fake exec (a configtest that fails, a master that dies on reload).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { ProvisionDeps } from '../src/provision/cli';
import { EXIT, run } from '../src/provision/cli';
import type { ExecResult } from '../src/provision/exec_contract';
import type { AgentLayout, HostDeclaration } from '../src/provision/layout';
import { canonicalDeclaration, derive } from '../src/provision/layout';
import type { HostState, SelinuxObserved } from '../src/provision/plan';
import { ruleFacts } from '../src/provision/plan';
import { restoreconTargets, selinuxRules } from '../src/provision/selinux';
import { INIT_BASE, acquireInstanceLockSync, instanceLockPath } from '../src/provision/lock';
import { instanceFingerprint } from '../src/security/pairing';
import type { DraftDeclaration } from '../src/provision/init/draft';
import { vhostSha8 } from '../src/provision/init/draft';
import { encodeRecord } from '../src/provision/init/journal_format';
import { NGINX_MAP_PINS, envelopePcre } from '../src/rules/directives';
import { renderHostMap } from '../src/rules/host_map';
import { parseRestoreconDryRun } from '../src/provision/init/parse/selinux';
import { footgunProblems, initHostDeps, productionWorld, runInit, SECRET_PROMPTS } from '../src/provision/init/run';
import type { InitWorld } from '../src/provision/init/run';
import { sourceDigest } from '../src/provision/init/source';
import { openPairingPackage } from '../src/provision/pairing_package';
import type { ScriptedAnswers } from '../src/provision/init/tty';
import { scriptedPrompter } from '../src/provision/init/tty';
import type { MountRow, Prompter } from '../src/provision/init/types';
import { fixture } from './fixtures/init/load';
import type { FakeOs } from './support/provision_fake_host';
import { FAKE_TOKEN, FakeInitHost } from './support/provision_fake_host';

const REPO = join(import.meta.dir, '..', '..', '..');
const INIT = '/var/lib/dedalo_publication_host_init';
const STAGE = `${INIT}/test/stage`;
const SOURCE = `${STAGE}/source`;
const ARCHIVE = `${STAGE}/bun/bun-linux-x64.zip`;
const JOURNAL = `${INIT}/test/journal.jsonl`;
const PIN = '1.4.3';
const HOME = '/home/example.org';
const SITE_UID = 1001;
const ZIP = 'a fake bun zip';
const PASSWORD = 'correct-horse-battery';
const WEB_CODE = 'web-user-code-123';
const MARKER = 'vhost_reference';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

/* ── the two host profiles ───────────────────────────────────────────────────────── */

interface Profile {
  readonly os: FakeOs;
  readonly server: 'apache' | 'nginx';
  readonly osRelease: string;
  readonly vhost: string;
  readonly webUnit: string;
  readonly configtestBin: string;
  readonly dumpBin: string;
  readonly fpm: { readonly flavor: 'debian' | 'el'; readonly version: string; readonly unit: string; readonly bin: string; readonly cli: string; readonly poolDir: string };
  readonly runUser: string;
}

const PROFILES: Readonly<Record<FakeOs, Profile>> = {
  debian: {
    os: 'debian',
    server: 'apache',
    osRelease: 'captured/debian12/os-release',
    vhost: '/etc/apache2/sites-enabled/example.org.conf',
    webUnit: 'apache2',
    configtestBin: '/usr/sbin/apache2ctl',
    dumpBin: '/usr/sbin/apache2ctl',
    fpm: { flavor: 'debian', version: '8.4', unit: 'php8.4-fpm', bin: '/usr/sbin/php-fpm8.4', cli: '/usr/bin/php8.4', poolDir: '/etc/php/8.4/fpm/pool.d' },
    runUser: 'www-data',
  },
  el: {
    os: 'el',
    server: 'apache',
    osRelease: 'captured/rocky9/os-release',
    vhost: '/etc/httpd/conf.d/example.org.conf',
    webUnit: 'httpd',
    configtestBin: '/usr/sbin/apachectl',
    dumpBin: '/usr/sbin/httpd',
    fpm: { flavor: 'el', version: '8.2', unit: 'php-fpm', bin: '/usr/sbin/php-fpm', cli: '/usr/bin/php', poolDir: '/etc/php-fpm.d' },
    runUser: 'apache',
  },
};

/** EL 10 (Rocky 10, captured os-release): AppStream PHP 8.3, no dnf modules, kernel 6.12. */
const EL10_PROFILE: Profile = {
  ...PROFILES.el,
  osRelease: 'captured/rocky10/os-release',
  fpm: { ...PROFILES.el.fpm, version: '8.3' },
};

/** Debian with nginx: conf.d is included inside http{}, so the host map is provisioned (Q1). */
const NGINX_PROFILE: Profile = {
  ...PROFILES.debian,
  server: 'nginx',
  vhost: '/etc/nginx/sites-enabled/example.org',
  webUnit: 'nginx',
  configtestBin: '/usr/sbin/nginx',
  dumpBin: '/usr/sbin/nginx',
};
const HAND_MAP = '/etc/nginx/conf.d/dedalo_hand_map.conf';

/** The .bun-sha256 table for the fake archive (the other two assets' lines are placeholders). */
function shaTable(): string {
  return [`# bun-v${PIN}`, `# signed-by: ${'A'.repeat(40)}`, `${'1'.repeat(64)}  bun-linux-aarch64.zip`, `${'2'.repeat(64)}  bun-linux-x64-baseline.zip`, `${sha(ZIP)}  bun-linux-x64.zip`, ''].join('\n');
}

function mountinfo(rows: readonly MountRow[]): string {
  return rows
    .map((row, index) => {
      const options = [row.readOnly ? 'ro' : 'rw', ...(row.noexec ? ['noexec'] : []), ...(row.context ? [`context="${row.context}"`] : [])].join(',');
      return `${20 + index} 1 8:${index} / ${row.mountPoint} ${options} shared:1 - ${row.fsType} /dev/x${index} rw${row.seclabel ? ',seclabel' : ''}`;
    })
    .join('\n');
}

/** The final declaration the default draft completes to. */
function expectedDeclaration(profile: Profile, overrides: Partial<HostDeclaration> = {}): HostDeclaration {
  return {
    instance: 'test',
    listen: { kind: 'unix' },
    agent_user: 'test_agent',
    engine_group: 'dedalo',
    agent_dir: `${HOME}/host_agent`,
    web: profile.server === 'nginx' ? { server: 'nginx', unit: 'nginx', nginx_map: 'conf_d' } : { server: 'apache', unit: profile.webUnit },
    site: { domain: 'example.org', fpm: { flavor: profile.fpm.flavor, version: profile.fpm.version } },
    v1: { user: 'test_v1' },
    state_root: `${HOME}/dedalo`,
    media: { mode: 'copy', root: '/srv/dedalo_media' },
    php_bin: profile.fpm.cli,
    bun_bin: `${HOME}/.bun/bin/bun`,
    v2: { unit: 'dedalo-publication-api-v2-test', user: 'test_v2', group: 'test_v2', port: 3100, health_url: 'http://127.0.0.1:3100/health' },
    ...overrides,
  };
}

/* ── the world ───────────────────────────────────────────────────────────────────── */

interface World {
  readonly host: FakeInitHost;
  readonly world: InitWorld;
  readonly profile: Profile;
  readonly layout: AgentLayout;
  readonly out: string[];
  readonly err: string[];
  readonly proc: Map<string, string>;
  /** The vhost text -S reports (null: the vhost is not configured). */
  vhostText: string | null;
  /** -S's view of the vhost (its server names). */
  serverLine: string;
  health: { status: number; body: string } | 'down';
  /** A configtest fails while this answers true. */
  configtestFails: (host: FakeInitHost) => boolean;
  /** The unit's master dies at this reload. */
  reloadKills: (unit: string, host: FakeInitHost) => boolean;
  prompter: Prompter & { readonly asked?: string[] };
}

interface WorldOptions {
  readonly os?: FakeOs;
  /** Debian with nginx instead of Apache. */
  readonly nginx?: boolean;
  readonly answers?: ScriptedAnswers;
  readonly declaration?: HostDeclaration;
  /** EL 10 instead of EL 9 (with `os: 'el'`). */
  readonly el10?: boolean;
}

function seedSource(host: FakeInitHost): void {
  host.seedFile(`${SOURCE}/.bun-version`, `${PIN}\n`, 0o644);
  host.seedFile(`${SOURCE}/.bun-sha256`, shaTable(), 0o644);
  const agent = `${SOURCE}/publication/host_agent`;
  host.seedFile(`${agent}/package.json`, JSON.stringify({ dependencies: { zod: '^4' }, devDependencies: { typescript: '^7' } }));
  host.seedFile(`${agent}/src/index.ts`, 'export {};\n');
  host.seedFile(`${agent}/src/provision/init/run.ts`, 'export {};\n');
  host.seedFile(`${agent}/node_modules/zod/package.json`, '{}');
  host.seedFile(`${SOURCE}/publication/server_api/v2/.env.example`, readFileSync(join(REPO, 'publication/server_api/v2/.env.example'), 'utf8'));
  host.seedFile(
    `${SOURCE}/publication/server_api/v1/config_api/sample.server_config_api.php`,
    readFileSync(join(REPO, 'publication/server_api/v1/config_api/sample.server_config_api.php'), 'utf8'),
  );
  host.seedFile(ARCHIVE, ZIP, 0o600);
  host.seedFile(`${STAGE}/empty.bunfig.toml`, '', 0o600);
  host.seedFile(`${STAGE}/bun/bun`, 'BUN', 0o755);
  for (const dir of [INIT, `${INIT}/test`, STAGE, `${STAGE}/bun`]) Object.assign(host.entries.get(dir) as object, { mode: 0o700 });
}

/** The fake's SELinux store as apply.ts observeHost would report it (S9). */
function selinuxObserved(host: FakeInitHost, layout: AgentLayout): SelinuxObserved {
  const base: SelinuxObserved = {
    mode: host.selinuxMode,
    storePresent: host.selinuxMode !== 'absent',
    localFcontext: host.fcontext.map(rule => ({ spec: rule.spec, type: rule.type })),
    localPorts: [...host.localPorts].map(([port, type]) => ({ type, proto: 'tcp', port })),
    portTypes: new Map([...host.portTypes, ...host.localPorts]),
    pending: [],
    state: host.readRootFile(join(layout.instanceDir, 'selinux.state')),
    booleans: Object.fromEntries(host.booleans),
    mediaLabelable: true,
    module: host.moduleObserved(),
  };
  if (host.selinuxMode !== 'enforcing' && host.selinuxMode !== 'permissive') return base;
  const targets = restoreconTargets(layout, ruleFacts(layout, base)).filter(target => host.lstat(target.path) !== null);
  const dry = targets.length === 0 ? OK : host.exec.restorecon(targets, true);
  return { ...base, pending: parseRestoreconDryRun(dry.stdout) };
}

function makeWorld(options: WorldOptions = {}): World {
  const profile = options.nginx === true ? NGINX_PROFILE : options.el10 === true ? EL10_PROFILE : PROFILES[options.os ?? 'debian'];
  const declaration = options.declaration ?? expectedDeclaration(profile);
  const layout = derive(declaration, { isRealFile: path => path === profile.configtestBin });
  const host = new FakeInitHost(layout, { os: profile.os, selinux: profile.os === 'el' ? 'enforcing' : 'absent' });
  // A FRESH host: nothing of ours under the site home (FakeHost seeds the layout's own paths).
  for (const path of [...host.entries.keys()]) if (path === HOME || path.startsWith(`${HOME}/`)) host.entries.delete(path);
  host.seedDir(HOME);
  Object.assign(host.entries.get(HOME) as object, { uid: SITE_UID, gid: SITE_UID, mode: 0o700 });
  host.seedFile(`${HOME}/public_html/index.html`, '<p>hi</p>', 0o644, SITE_UID, SITE_UID);
  host.users.set('site', SITE_UID);
  host.groups.set('site', SITE_UID);
  host.groups.delete('dedalo_pubhost');
  host.users.set(profile.runUser, profile.os === 'el' ? 48 : 33);
  host.groups.set(profile.runUser, profile.os === 'el' ? 48 : 33);
  // The OS.
  host.seedFile('/etc/os-release', fixture(profile.osRelease));
  host.seedFile('/etc/sudoers', `${profile.os === 'el' ? '#' : '@'}includedir /etc/sudoers.d\n`, 0o440);
  host.seedFile('/etc/nsswitch.conf', 'passwd: files systemd\ngroup: files systemd\n');
  host.seedFile('/etc/shells', '/bin/sh\n/bin/bash\n');
  host.seedFile('/proc/cpuinfo', 'flags\t\t: fpu sse avx2\n');
  host.seedFile('/usr/bin/unzip', '', 0o755);
  host.seedFile('/usr/bin/chattr', '', 0o755);
  host.seedDir('/lib');
  host.seedDir('/srv/dedalo_media');
  // The web server and PHP-FPM.
  host.candidateUnits.push(`${profile.webUnit}.service`, `${profile.fpm.unit}.service`, 'polkit.service');
  host.units.set(profile.fpm.unit, { enabled: true, active: true });
  host.seedFile(profile.configtestBin, '', 0o755);
  host.seedFile(profile.dumpBin, '', 0o755);
  if (profile.server === 'nginx') {
    host.entries.delete('/usr/sbin/apache2ctl');
    host.units.delete('apache2');
    host.units.set('nginx', { enabled: true, active: true });
    host.seedFile('/etc/nginx/nginx.conf', 'user www-data;\nevents {}\nhttp {\n    include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;\n}\n');
  }
  if (profile.os === 'el') {
    host.entries.delete('/usr/sbin/apache2ctl');
    for (const mod of ['proxy_fcgi', 'rewrite']) host.apacheMods.add(mod);
    host.seedDir('/run/php-fpm');
    host.seedFile('/etc/selinux/config', 'SELINUX=enforcing\nSELINUXTYPE=targeted\n');
    host.seedDir('/etc/selinux/targeted');
    for (const tool of ['/usr/sbin/semanage', '/usr/sbin/setfiles', '/usr/sbin/getsebool']) host.seedFile(tool, '', 0o755);
    host.seedLink('/usr/sbin/restorecon', 'setfiles', '/usr/sbin/setfiles'); // policycoreutils' shape (measured, RHEL 9.8)
    host.seedFile('/sys/fs/selinux/enforce', '1');
    host.labels.set(HOME, 'user_home_dir_t');
    host.labels.set('/home', 'home_root_t');
    host.mounts.splice(0, host.mounts.length, { mountPoint: '/', fsType: 'xfs', readOnly: false, noexec: false, seclabel: true, context: null });
    host.kernelRelease = profile === EL10_PROFILE ? '6.12.0-211.62.1.el10_2.x86_64' : '5.14.0-427.el9.x86_64';
  } else {
    host.seedDir('/etc/php');
    host.seedDir('/run/php');
  }
  host.seedDir(profile.fpm.poolDir);
  host.seedFile(profile.fpm.bin, '', 0o755);
  host.seedFile(profile.fpm.cli, '', 0o755);
  host.outputs.set(
    `web -v ${profile.dumpBin}`,
    profile.server === 'nginx'
      ? { code: 0, stdout: '', stderr: 'nginx version: nginx/1.22.1\n' }
      : { code: 0, stdout: `Server version: Apache/${profile === EL10_PROFILE ? '2.4.63' : '2.4.62'} (${profile.os === 'el' ? 'Rocky Linux' : 'Debian'})\n`, stderr: '' },
  );
  host.outputs.set(`php version ${profile.fpm.cli}`, { code: 0, stdout: `${profile.fpm.version}.11`, stderr: '' });
  host.outputs.set(`fpm -tt ${profile.fpm.bin}`, { code: 0, stdout: '', stderr: fixture('captured/debian12/fpm_tt.txt') });
  // The source install.sh staged, and the Bun it verified.
  seedSource(host);
  host.bunVersions.set(layout.bunBin, PIN);

  const proc = new Map<string, string>([
    ['/proc/self/environ', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin\0HOME=/root\0LC_ALL=C\0'],
    ['/proc/self/cmdline', `${STAGE}/bun/bun\0--no-env-file\0--no-install\0--config=${STAGE}/empty.bunfig.toml\0${SOURCE}/publication/host_agent/src/provision/cli.ts\0init\0test\0`],
    ['/proc/self/attr/current', 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023\n'],
  ]);
  const out: string[] = [];
  const err: string[] = [];

  const w = {
    host,
    profile,
    layout,
    out,
    err,
    proc,
    vhostText:
      profile.server === 'nginx'
        ? 'server {\n    listen 443 ssl;\n    server_name example.org;\n    root /home/example.org/public_html;\n}\n'
        : '<VirtualHost *:443>\n  ServerName example.org\n  DocumentRoot /home/example.org/public_html\n  SSLEngine on\n</VirtualHost>\n',
    serverLine: 'example.org',
    health: { status: 200, body: '' },
    configtestFails: () => false,
    reloadKills: () => false,
    prompter: scriptedPrompter(options.answers ?? { interactive: false }),
  } as unknown as World;
  if (w.vhostText !== null) host.seedFile(profile.vhost, w.vhostText);

  const include = join(layout.instanceDir, 'web.apache.conf');
  const apacheS = () =>
    `VirtualHost configuration:\n${host.body(profile.vhost) === undefined ? '' : `*:443                  ${w.serverLine} (${profile.vhost}:1)\n`}` +
    `ServerRoot: "/etc/apache2"\nUser: name="${profile.runUser}" id=33\nGroup: name="${profile.runUser}" id=33\n`;
  const dumpIncludes = (l: AgentLayout = layout) => {
    const lines = ['Included configuration files:', '  (*) /etc/apache2/apache2.conf', `    (1) ${profile.vhost}`];
    const own = join(l.instanceDir, 'web.apache.conf');
    if ((host.body(profile.vhost) ?? '').includes(`IncludeOptional ${own}`) && host.body(own) !== undefined) lines.push(`      (2) ${own}`);
    return `${lines.join('\n')}\n`;
  };
  void include;
  /** `nginx -T`: every file under /etc/nginx, our include when the vhost references it, the live map when the include exists. */
  const nginxT = (l: AgentLayout = layout): string => {
    // The main file first, as nginx -T prints it.
    const files = [...host.entries.keys()]
      .filter(path => path.startsWith('/etc/nginx/') && host.entries.get(path)?.type === 'file')
      .sort((a, b) => (a === '/etc/nginx/nginx.conf' ? -1 : b === '/etc/nginx/nginx.conf' ? 1 : a < b ? -1 : 1));
    const own = join(l.instanceDir, 'web.nginx.conf');
    if ((host.body(profile.vhost) ?? '').includes(`include ${own.slice(0, -1)}[f];`) && host.body(own) !== undefined) files.push(own);
    const live = join(l.host.nginxMapDir, 'dedalo_media_map.nginx.conf');
    if (host.body(l.host.nginxMapInclude) !== undefined && host.body(live) !== undefined) files.push(live);
    return `nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\n${files.map(path => `# configuration file ${path}:\n${host.body(path)}\n`).join('')}`;
  };
  const exec = new Proxy(host.exec, {
    get(target, name: string) {
      const real = Reflect.get(target, name) as (...args: unknown[]) => ExecResult;
      if (name === 'apacheVhosts') return () => ({ code: 0, stdout: apacheS(), stderr: '' });
      if (name === 'apacheIncludes') return () => ({ code: 0, stdout: dumpIncludes(), stderr: '' });
      if (name === 'nginxDump') return () => ({ code: 0, stdout: nginxT(), stderr: '' });
      if (name === 'webConfigtest' || name === 'fpmConfigtest') {
        return (...args: unknown[]) => {
          const result = real(...args);
          return result.code === 0 && w.configtestFails(host) ? { code: 1, stdout: '', stderr: 'syntax error' } : result;
        };
      }
      if (name === 'reloadUnit') {
        return (unit: string) => {
          const result = real(unit);
          if (result.code === 0 && w.reloadKills(unit, host)) host.units.set(unit, { ...(host.units.get(unit) ?? { enabled: true }), active: false });
          return result;
        };
      }
      if (name === 'unzipBun') {
        return (zip: string, asset: string, dest: string) => {
          const result = real(zip, asset, dest);
          host.seedFile(`${dest}/bun`, 'BUN', 0o755);
          host.bunVersions.set(`${dest}/bun`, PIN);
          return result;
        };
      }
      return real;
    },
  });
  const readProc = (path: string) => proc.get(path) ?? (path === '/proc/self/mountinfo' ? mountinfo(host.mounts) : host.readProcFile(path));
  const io = new Proxy(host, {
    get(target, name: string) {
      if (name === 'readProcFile') return readProc;
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as InitWorld['io'];
  const readDir = (path: string): string[] | null =>
    host.entries.get(path)?.type === 'dir'
      ? [...host.entries.keys()].filter(p => p !== path && dirname(p) === path).map(p => p.slice(path === '/' ? 1 : path.length + 1)).sort()
      : null;
  const listDeclarations = (dir: string) => (readDir(dir) ?? []).filter(name => name.endsWith('.json')).map(name => join(dir, name));
  const observeHost = (l: AgentLayout): HostState => ({
    // stateFor: plus the fapolicyd trust observation on a fapolicyd layout (the real derivation, on the fake tree).
    ...host.stateFor(l),
    systemdVersion: host.systemd,
    selinux: selinuxObserved(host, l),
    webReference:
      l.site === null
        ? null
        : l.web.server === 'nginx'
          ? nginxT(l).includes(`# configuration file ${join(l.instanceDir, 'web.nginx.conf')}:`)
          : dumpIncludes(l).includes(join(l.instanceDir, 'web.apache.conf')),
  });
  const provisionDeps: ProvisionDeps = {
    readDeclaration: path => host.readRootFile(path),
    listDeclarations,
    canonical: path => path,
    lstat: path => host.lstat(path),
    isRealFile: path => host.lstat(path)?.type === 'file',
    isRoot: () => true,
    observeHost: l => observeHost(l),
    io: () => host,
    readRootFile: path => host.readRootFile(path),
    now: () => new Date('2026-10-08T12:00:00Z'),
    lock: (instance, mode, verb) => acquireInstanceLockSync(instance, mode, { base: INIT, io: host.lockIo, verb, pid: 5151 }),
  };
  const world: InitWorld = {
    io,
    exec: exec as InitWorld['exec'],
    lock: host.lockIo,
    get prompter() {
      return w.prompter;
    },
    out: line => out.push(line),
    err: line => err.push(line),
    now: () => new Date('2026-10-08T12:00:00Z'),
    euid: () => 0,
    execPath: `${STAGE}/bun/bun`,
    codeDir: `${SOURCE}/publication/host_agent/src/provision/init`,
    cwd: STAGE,
    fs: { lstat: path => host.lstat(path), readDir, realpath: path => host.realpath(path) },
    tree: { reader: host.treeReader, writer: host.treeWriter },
    listDeclarations,
    observeHost,
    provisionDeps,
    sleepSync: ms => host.lockIo.sleepSync(ms),
    sleep: async ms => host.lockIo.sleepSync(ms),
    healthFetch: async () => {
      const answer = w.health;
      if (answer === 'down') throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      const body = answer.body === '' ? JSON.stringify({ status: 'ok', instance_fingerprint: instanceFingerprint('test', FAKE_TOKEN) }) : answer.body;
      return new Response(body, { status: answer.status });
    },
    initBase: INIT,
    root: { uid: 0, gid: 0 },
    trustRoot: '/',
  };
  (w as { world: InitWorld }).world = world;
  return w;
}

/** The draft install.sh copies into the stage. */
function writeDraft(w: World, draft: DraftDeclaration): string {
  w.host.seedFile(`${STAGE}/draft.json`, JSON.stringify(draft), 0o600);
  return `${STAGE}/draft.json`;
}

const DRAFT: DraftDeclaration = {
  instance: 'test',
  layout: 'home',
  apis: 'v1_and_v2',
  engine_group: 'dedalo',
  site: { domain: 'example.org' },
  media: { mode: 'copy', root: '/srv/dedalo_media' },
};

function sourceArgs(w: World): string[] {
  return ['--source', SOURCE, '--source-digest-confirmed', sourceDigest(SOURCE, w.host.treeReader), '--bun-archive', ARCHIVE];
}

/** A first run's argv: the draft, the source and its digest, the Bun archive. */
function firstRun(w: World, draft: DraftDeclaration = DRAFT, extra: readonly string[] = []): string[] {
  return ['test', '--draft', writeDraft(w, draft), ...sourceArgs(w), ...extra];
}

/**
 * Re-run mode (install.sh step 6): the stage is recreated empty, Bun is the installed bun_bin and
 * the entry is the installed agent_dir's cli.ts.
 */
function rerunMode(w: World): void {
  w.host.seedDir(STAGE);
  Object.assign(w.host.entries.get(STAGE) as object, { mode: 0o700 });
  w.host.seedFile(`${STAGE}/empty.bunfig.toml`, '', 0o600);
  const world = w.world as { -readonly [K in keyof InitWorld]: InitWorld[K] };
  world.execPath = w.layout.bunBin;
  world.codeDir = `${w.layout.agentDir}/src/provision/init`;
  w.proc.set('/proc/self/cmdline', `${w.layout.bunBin}\0--no-env-file\0--no-install\0--config=${STAGE}/empty.bunfig.toml\0${w.layout.agentDir}/src/provision/cli.ts\0init\0test\0`);
}

/** Source mode again (install.sh step 5): the stage re-staged, Bun and the entry from it. */
function sourceMode(w: World): void {
  seedSource(w.host);
  const world = w.world as { -readonly [K in keyof InitWorld]: InitWorld[K] };
  world.execPath = `${STAGE}/bun/bun`;
  world.codeDir = `${SOURCE}/publication/host_agent/src/provision/init`;
  w.proc.set('/proc/self/cmdline', `${STAGE}/bun/bun\0--no-env-file\0--no-install\0--config=${STAGE}/empty.bunfig.toml\0${SOURCE}/publication/host_agent/src/provision/cli.ts\0init\0test\0`);
}

const MUTATING = /^(mkdir|writeTemp|chown|chmod|rename|appendOnly|writeBytesAtomic|writeTempNamed|removeInitTemp|removeTree|renameDir|appendSync|symlink|groupadd|useradd|setsebool|a2enmod|a2dismod|semanage import|reload|restart|start|enable|daemon-reload|pair) /;

/** The host's mutations outside init's own stage (removed on every success; install.sh recreates it). */
function hostMutations(w: World): string[] {
  return w.host.calls.filter(call => (MUTATING.test(call) || call === 'daemon-reload') && !call.startsWith(`removeTree ${STAGE}`));
}

async function init(w: World, argv: readonly string[]): Promise<number> {
  return runInit(argv, { out: line => w.out.push(line), err: line => w.err.push(line), world: () => w.world });
}

const vhostId = (w: World) => `web.vhost.${vhostSha8({ realpath: w.profile.vhost, port: 443, serverName: 'example.org' })}`;
const SECRETS: ScriptedAnswers['secrets'] = {
  [SECRET_PROMPTS.v2.password]: PASSWORD,
  [SECRET_PROMPTS.v1.password]: PASSWORD,
  [SECRET_PROMPTS.v1.webUserCode]: WEB_CODE,
};
const VISIBLE: ScriptedAnswers['visible'] = {
  [SECRET_PROMPTS.v2.user]: 'web_user',
  [SECRET_PROMPTS.v2.names]: 'web_db',
  [SECRET_PROMPTS.v1.user]: 'web_user',
  [SECRET_PROMPTS.v1.db]: 'web_db',
  [SECRET_PROMPTS.v1.entity]: 'museum',
};
/** An operator who answers everything (interactive). */
function operator(w: World, choices: Record<string, string> = {}): ScriptedAnswers {
  return { confirm: true, secrets: SECRETS, visible: VISIBLE, choices: { 'api_config.v1_db_transport': 'socket', [vhostId(w)]: 'act', ...choices } };
}

function useOperator(w: World, choices: Record<string, string> = {}): void {
  w.prompter = scriptedPrompter(operator(w, choices));
}

/** The lines of one item in the printed report. */
function reportOf(w: World, id: string): string[] {
  const start = w.out.findIndex(line => line.startsWith(`  [${id}]`));
  if (start < 0) return [];
  const end = w.out.findIndex((line, index) => index > start && !line.startsWith('      '));
  return w.out.slice(start, end < 0 ? undefined : end);
}

/** Which list an item was printed in (1, 2 or 3), or null. */
function listOf(w: World, id: string): 1 | 2 | 3 | null {
  const at = w.out.findIndex(line => line.startsWith(`  [${id}]`));
  if (at < 0) return null;
  const header = w.out.slice(0, at).reverse().find(line => /^[123]\. /.test(line));
  return header === undefined ? null : (Number(header[0]) as 1 | 2 | 3);
}

/* ── 1. converge, and a second run is all right ──────────────────────────────────── */

describe('case 1: a fresh host converges; a second run is all right with zero mutations', () => {
  for (const variant of ['debian', 'el', 'el10'] as const) {
    const os = variant === 'debian' ? 'debian' : 'el';
    test(variant, async () => {
      const w = makeWorld({ os, el10: variant === 'el10' });
      useOperator(w, os === 'el' ? {} : {});
      const code = await init(w, firstRun(w));
      expect(w.err.filter(line => !line.includes('apply:'))).toEqual([]);
      expect(code).toBe(EXIT.OK);
      // What the run made: the accounts, the home, Bun, the code, the declaration, the API configs, the vhost.
      for (const name of ['test_agent', 'test_v1', 'test_v2']) expect(w.host.users.has(name)).toBe(true);
      expect(w.host.groups.has('dedalo_pubhost')).toBe(true);
      expect(w.host.lstat(HOME)).toMatchObject({ uid: 0, gid: 0, mode: 0o755 });
      expect(w.host.lstat(w.layout.bunBin)?.type).toBe('file');
      expect(w.host.lstat(`${w.layout.agentDir}/src/index.ts`)?.type).toBe('file');
      expect(w.host.body(w.layout.declarationPath)).toBe(canonicalDeclaration(expectedDeclaration(w.profile)));
      expect(w.host.lstat(join(w.layout.state.apis.v2.shared, 'v2.env'))).toMatchObject({ uid: 0, mode: 0o640 });
      expect(w.host.lstat(join(w.layout.v1!.dirs.shared, 'server_config_api.php'))).toMatchObject({ mode: 0o400 });
      expect(w.host.body(w.profile.vhost)).toContain(`IncludeOptional ${w.layout.instanceDir}/web.apache.conf`);
      expect(w.host.body(`${INIT}/test/rerun.env`)).toBe(`BUN=${w.layout.bunBin}\nAGENT=${w.layout.agentDir}\n`);
      expect(w.host.lstat(STAGE)).toBeNull(); // removed on success
      if (os === 'el') {
        // SELinux: the S9 rules registered, nothing pending, the home made traversable by its exact rule.
        expect(w.host.fcontext.length).toBeGreaterThan(0);
        expect(w.host.fcontext.some(rule => rule.spec === '/home/example\\.org' && rule.ftype === 'd' && rule.type === 'home_root_t')).toBe(true);
      }
      // The second run: re-run mode (no source), everything right, nothing touched.
      const before = hostMutations(w).length;
      w.out.length = 0;
      rerunMode(w);
      w.prompter = scriptedPrompter({ interactive: false });
      expect(await init(w, ['test', '--yes'])).toBe(EXIT.OK);
      expect(w.out.find(line => line.startsWith('2. will change'))).toBe('2. will change (0)');
      expect(hostMutations(w).slice(before)).toEqual([]);
      expect(w.out.at(-1)).toBe("provision init: instance 'test' is right; nothing was changed");
    });
  }
});

/* ── 1b. a v2-only site (no v1 block): no PHP anywhere ──────────────────────────────── */

/** The v2-only declaration the v2-only draft completes to: no v1, no php_bin, no site.fpm. */
function expectedV2Only(profile: Profile): HostDeclaration {
  const { v1: _v1, php_bin: _php, ...rest } = expectedDeclaration(profile);
  return { ...rest, site: { domain: 'example.org', os_family: profile.os === 'el' ? 'el' : 'debian' } };
}

describe('case 1b: a v2-only draft converges with no PHP anywhere; a second run is all right', () => {
  for (const os of ['debian', 'el'] as const) {
    test(os, async () => {
      const w = makeWorld({ os, declaration: expectedV2Only(PROFILES[os]) });
      useOperator(w);
      const { apis: _apis, ...v2Draft } = DRAFT;
      expect(await init(w, firstRun(w, v2Draft))).toBe(EXIT.OK);
      expect(w.host.body(w.layout.declarationPath)).toBe(canonicalDeclaration(expectedV2Only(w.profile)));
      expect(w.host.users.has('test_v1')).toBe(false);
      expect(w.host.lstat(join(w.layout.state.apis.v2.shared, 'v2.env'))).toMatchObject({ uid: 0, mode: 0o640 });
      expect(w.host.lstat(`${w.layout.state.publicationApi}/v1`)).toBeNull();
      expect(w.host.lstat(`${w.profile.fpm.poolDir}/dedalo_test_v1.conf`)).toBeNull();
      expect(w.host.lstat('/var/lib/dedalo_publication_host/test')).toBeNull();
      expect(w.host.lstat('/etc/logrotate.d/dedalo_test_v1')).toBeNull();
      const apacheConf = w.host.body(`${w.layout.instanceDir}/web.apache.conf`);
      expect(apacheConf).not.toMatch(/^Alias /m);
      expect(apacheConf).not.toMatch(/SetHandler|fcgi/);
      expect(w.host.body(w.layout.envFile)).not.toContain('PHP_BIN');
      // No PHP binary ran, no PHP item was printed, no v1 secret was asked.
      expect(w.host.calls.some(call => /php/i.test(call))).toBe(false);
      for (const id of ['host.php_mode', 'host.fpm_install', 'host.fpm_cli', 'declaration.fpm', 'declaration.v1_user', 'account.v1_user', 'api_config.v1_db_transport', 'api_config.v1_config']) {
        expect(listOf(w, id)).toBeNull();
      }
      expect(reportOf(w, 'declaration.apis').join('\n')).toContain('v2 only: no PHP anywhere');
      const before = hostMutations(w).length;
      w.out.length = 0;
      rerunMode(w);
      w.prompter = scriptedPrompter({ interactive: false });
      expect(await init(w, ['test', '--yes'])).toBe(EXIT.OK);
      expect(hostMutations(w).slice(before)).toEqual([]);
    });
  }
});

describe("case 1c: an optional decision answered with its default `skip` holds nothing back", () => {
  // Measured on Ubuntu 24.04.5 (two-machine drill, 2026-10-09): the stock vhost logs into
  // ${APACHE_LOG_DIR}/<site>-error.log, so web.logs is an optional decision whose default is
  // `skip`; init.keep_ref ran `after` every earlier item, so the default answer dropped it and
  // init refused: "skipping leaves required items undone: init.keep_ref" (exit 3).
  const LOGGED =
    '<VirtualHost *:443>\n  ServerName example.org\n  DocumentRoot /home/example.org/public_html\n  SSLEngine on\n' +
    '  ErrorLog /var/log/apache2/example.org-error.log\n  CustomLog /var/log/apache2/example.org-access.log combined\n</VirtualHost>\n';
  test('a terminal operator typing the default: converges, the templates are kept', async () => {
    const w = makeWorld();
    w.host.seedFile(w.profile.vhost, LOGGED);
    useOperator(w, { 'web.logs': 'skip' });
    const code = await init(w, firstRun(w));
    expect(w.err.filter(line => !line.includes('apply:'))).toEqual([]);
    expect(code).toBe(EXIT.OK);
    expect(listOf(w, 'web.logs')).toBe(3);
    expect(w.host.body(`${INIT}/test/rerun.env`)).toBe(`BUN=${w.layout.bunBin}\nAGENT=${w.layout.agentDir}\n`);
    // The vhost's own log lines were left as they are.
    expect(w.host.body(w.profile.vhost)).toContain('ErrorLog /var/log/apache2/example.org-error.log');
  });
  test('--yes --decide web.logs=skip (no terminal) converges too', async () => {
    const w = makeWorld();
    w.host.seedFile(w.profile.vhost, LOGGED);
    w.prompter = scriptedPrompter({ interactive: false });
    const code = await init(w, firstRun(w, DRAFT, ['--yes', '--decide', `${vhostId(w)}=act`, '--decide', 'api_config.v1_db_transport=socket', '--decide', 'web.logs=skip']));
    expect(w.err.join('\n')).not.toContain('skipping leaves required items undone');
    // Without a terminal the typed secrets stay open: exit 3 names them (keep_ref waits for them, as it should).
    expect(code).toBe(EXIT.REFUSED);
    expect(w.err.at(-1) ?? '').toContain('api_config.v2_env');
    // Everything before them ran: the vhost include is in, the logs left as they are.
    expect(w.host.body(w.profile.vhost)).toContain(`IncludeOptional ${w.layout.instanceDir}/web.apache.conf`);
  });
});

/** A converged host (case 1's first run), the operator's answers given. */
async function converged(os: FakeOs = 'debian', choices: Record<string, string> = {}): Promise<World> {
  const w = makeWorld({ os });
  useOperator(w, choices);
  expect(await init(w, firstRun(w))).toBe(EXIT.OK);
  w.out.length = 0;
  w.err.length = 0;
  rerunMode(w);
  return w;
}

function journalText(w: World): string {
  return w.host.body(JOURNAL) ?? '';
}

function instanceLockOpens(w: World): number {
  return w.host.lockIo.calls.filter(call => call === `open ${instanceLockPath(INIT, 'test')}`).length;
}

/* ── 2-4. dry run, no TTY, --yes ─────────────────────────────────────────────────── */

describe('B4: the v1 transport defaults follow discovery', () => {
  test('TCP: the typed host defaults to 127.0.0.1 (never localhost: the PHP driver reads it as the socket), the port to 3306', async () => {
    const w = makeWorld({ os: 'debian' });
    useOperator(w, { 'api_config.v1_db_transport': 'tcp' });
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    const v1 = w.host.body(join(w.layout.v1!.dirs.shared, 'server_config_api.php')) ?? '';
    expect(v1).toContain("define('MYSQL_DEDALO_HOSTNAME_CONN', '127.0.0.1');");
    expect(v1).toContain("define('MYSQL_DEDALO_DB_PORT_CONN', 3306);");
    // v2 too: no local socket on this fake host, so its socket default is empty (TCP) and its host the loopback.
    const v2 = w.host.body(join(w.layout.state.apis.v2.shared, 'v2.env')) ?? '';
    expect(v2).toContain("DB_HOST='127.0.0.1'");
    expect(v2).toMatch(/DB_SOCKET=(''|)\n/);
  });
});

describe('case 2: --dry-run', () => {
  test('exit 1, zero mutations, no lock, no journal', async () => {
    const w = makeWorld();
    useOperator(w);
    expect(await init(w, firstRun(w, DRAFT, ['--dry-run']))).toBe(EXIT.DRIFT);
    expect(hostMutations(w)).toEqual([]);
    expect(w.host.lockIo.files.size).toBe(0);
    expect(w.host.lockIo.calls).toEqual([]);
    expect(w.host.lstat(JOURNAL)).toBeNull();
    expect(w.prompter.asked ?? []).toEqual([]); // a dry run asks nothing
    expect(w.out).toContain('2. will change (16)');
  });

  test('a converged host answers 0', async () => {
    const w = await converged();
    expect(await init(w, ['test', '--dry-run'])).toBe(EXIT.OK);
  });
});

describe('case 3: no TTY without --yes is a dry run', () => {
  test('exit 1, the hint, zero mutations, no lock', async () => {
    const w = makeWorld();
    expect(await init(w, firstRun(w))).toBe(EXIT.DRIFT);
    expect(w.out).toContain('not a terminal: re-run with --yes (and --decide …) to act');
    expect(hostMutations(w)).toEqual([]);
    expect(w.host.lockIo.files.size).toBe(0);
  });
});

describe('case 4: --yes without a TTY', () => {
  for (const os of ['debian', 'el'] as const) {
    test(`${os}: applies the changes (home.root included), leaves every decision open, edits no vhost, sets no boolean, ends REFUSED naming them`, async () => {
      const w = makeWorld({ os });
      const vhostBefore = w.host.body(w.profile.vhost);
      const booleans = new Map(w.host.booleans);
      expect(await init(w, firstRun(w, DRAFT, ['--yes']))).toBe(EXIT.REFUSED);
      expect(w.host.lstat(HOME)).toMatchObject({ uid: 0, gid: 0, mode: 0o755 }); // home.root, a will-change item
      expect(w.host.users.has('test_agent')).toBe(true);
      expect(w.host.body(w.profile.vhost)).toBe(vhostBefore);
      expect(w.host.booleans).toEqual(booleans);
      expect(w.host.calls.some(call => call.startsWith('setsebool'))).toBe(false);
      // The secrets became decisions: nothing typed, nothing written.
      expect(w.host.lstat(join(w.layout.state.apis.v2.shared, 'v2.env'))).toBeNull();
      const refusal = w.err.at(-1) ?? '';
      expect(refusal).toStartWith('provision init: REFUSED — still open:');
      for (const id of [vhostId(w), 'api_config.v1_db_transport', 'api_config.v2_env']) expect(refusal).toContain(id);
    });
  }
});

/* ── 5-6. configtest and reload failures ─────────────────────────────────────────── */

describe('case 5: a failing configtest restores, (Debian) disables the modules it enabled, tests again, never reloads', () => {
  test('debian: the web.modules transaction', async () => {
    const w = makeWorld();
    useOperator(w);
    w.configtestFails = host => host.apacheMods.has('rewrite');
    expect(await init(w, firstRun(w))).toBe(EXIT.FAILED);
    const calls = w.host.calls;
    const enabled = calls.indexOf('a2enmod proxy_fcgi rewrite');
    expect(enabled).toBeGreaterThan(-1);
    const after = calls.slice(enabled);
    expect(after.filter(call => call === 'configtest apache')).toHaveLength(2);
    expect(after).toContain('a2dismod proxy_fcgi rewrite');
    expect(after.some(call => call.startsWith('reload '))).toBe(false);
    expect(w.host.apacheMods.has('rewrite')).toBe(false);
    expect(journalText(w)).toContain('"item":"web.modules","phase":"rolled_back"');
  });

  test('el: the vhost transaction restores the file and never runs a2dismod', async () => {
    const w = makeWorld({ os: 'el' });
    useOperator(w);
    const before = w.host.body(w.profile.vhost);
    w.configtestFails = host => (host.body(w.profile.vhost) ?? '').includes(MARKER);
    expect(await init(w, firstRun(w))).toBe(EXIT.FAILED);
    expect(w.host.body(w.profile.vhost)).toBe(before);
    expect(w.host.calls.some(call => call.startsWith('a2dismod') || call.startsWith('a2enmod'))).toBe(false);
    expect(w.err.join('\n')).toContain(vhostId(w));
  });
});

describe('case 6: a master that dies at the reload is restored and restarted', () => {
  test('provision apply: PHP-FPM inactive after its reload → the pool restored, FPM restarted', async () => {
    const w = makeWorld();
    useOperator(w);
    w.host.reloadKills.add('php8.4-fpm'); // apply reloads through the host's own exec
    expect(await init(w, firstRun(w))).toBe(EXIT.FAILED);
    expect(w.host.calls).toContain('restart php8.4-fpm');
    expect(w.host.lstat(w.layout.site?.v1?.fpm.poolFile ?? '')).toBeNull();
    expect(w.host.units.get('php8.4-fpm')?.active).toBe(true);
    expect(w.err.join('\n')).toContain('rolled_back');
  });

  test('provision apply (EL): the web server inactive after a reload that passed configtest → restore, configtest, restart', async () => {
    const w = makeWorld({ os: 'el' });
    useOperator(w);
    w.host.reloadKills.add('httpd'); // apply reloads through the host's own exec
    expect(await init(w, firstRun(w))).toBe(EXIT.FAILED);
    const reload = w.host.calls.indexOf('reload httpd');
    expect(reload).toBeGreaterThan(-1);
    expect(w.host.calls.slice(reload)).toEqual(expect.arrayContaining(['configtest apache', 'restart httpd']));
    expect(w.host.lstat(join(w.layout.instanceDir, 'web.apache.conf'))).toBeNull();
    expect(w.err.join('\n')).toContain('rolled_back{reload}');
  });

  test('web_txn: the web server inactive after the vhost reload → the vhost restored, configtest, restart', async () => {
    const w = makeWorld();
    useOperator(w);
    const before = w.host.body(w.profile.vhost);
    w.reloadKills = (unit, host) => unit === 'apache2' && (host.body(w.profile.vhost) ?? '').includes(MARKER);
    expect(await init(w, firstRun(w))).toBe(EXIT.FAILED);
    expect(w.host.body(w.profile.vhost)).toBe(before);
    expect(w.host.units.get('apache2')?.active).toBe(true);
    expect(w.err.join('\n')).toContain('rolled_back{reload}');
    expect(journalText(w)).toContain(`"item":"${vhostId(w)}","phase":"rolled_back"`);
  });
});

/* ── 7-10. resume, TOCTOU, an aborted prompt, the password ───────────────────────── */

function appendBegin(w: World, item: string, detail: Record<string, unknown>): void {
  const records = journalText(w).split('\n').filter(line => line !== '');
  const line = encodeRecord({ v: 1, seq: records.length + 1, at: '2026-10-08T12:00:00.000Z', run: 'ffffffffffffffff', item, phase: 'begin', detail });
  w.host.seedFile(JOURNAL, `${journalText(w)}${line}`, 0o600);
}

describe('case 7: a crash after a begin', () => {
  test('without --resume: REFUSED naming the item; with --resume: settled and reconverged', async () => {
    const w = await converged();
    appendBegin(w, 'home.dirs', { path: `${HOME}/logs`, uid: 0, gid: 0, mode: 0o755 });
    expect(await init(w, ['test', '--yes'])).toBe(EXIT.REFUSED);
    expect(w.err.join('\n')).toContain('an earlier run did not finish: home.dirs — re-run with --resume');
    rerunMode(w);
    expect(await init(w, ['test', '--yes', '--resume'])).toBe(EXIT.OK);
    expect(w.out).toContain('resume: home.dirs is re-run below');
    // Closed: the next run starts clean.
    rerunMode(w);
    expect(await init(w, ['test', '--yes'])).toBe(EXIT.OK);
  });

  test('a code tree swapped in by a run that died: --resume puts the previous tree back', async () => {
    const w = await converged();
    const dst = w.layout.agentDir;
    w.host.renameDir(dst, `${dst}.dedalo-init.prev`);
    w.host.seedFile(`${dst}/src/index.ts`, 'half-installed', 0o644);
    appendBegin(w, 'code.install', { src: `${SOURCE}/publication/host_agent`, dst, new: `${dst}.dedalo-init.new`, prev: `${dst}.dedalo-init.prev`, digest: 'f'.repeat(64) });
    // The operator starts install.sh again with --source (the installed tree is not one to run).
    sourceMode(w);
    expect(await init(w, ['test', ...sourceArgs(w), '--yes', '--resume'])).toBe(EXIT.OK);
    expect(w.out.some(line => line.startsWith('resume: [rolled_back] code.install'))).toBe(true);
    expect(w.host.body(`${dst}/src/index.ts`)).toBe('export {};\n');
  });
});

describe('case 8: TOCTOU', () => {
  test('a vhost changed between the report and the act is never written', async () => {
    const w = makeWorld();
    const scripted = scriptedPrompter(operator(w));
    w.prompter = {
      ...scripted,
      confirm: async question => {
        w.host.seedFile(w.profile.vhost, `${w.host.body(w.profile.vhost)}# edited meanwhile\n`);
        return scripted.confirm(question);
      },
    };
    expect(await init(w, firstRun(w))).toBe(EXIT.FAILED);
    expect(w.err.join('\n')).toContain('changed since shown; re-run');
    expect(w.host.body(w.profile.vhost)).toEndWith('# edited meanwhile\n');
    expect(w.host.body(w.profile.vhost)).not.toContain(MARKER);
  });
});

describe('case 9: an aborted prompt writes nothing for that item', () => {
  test('the v2 password aborted: no v2.env, its item stays open, REFUSED', async () => {
    const w = makeWorld();
    const answers = operator(w);
    w.prompter = scriptedPrompter({ ...answers, secrets: { ...answers.secrets, [SECRET_PROMPTS.v2.password]: undefined as unknown as string } });
    expect(await init(w, firstRun(w))).toBe(EXIT.REFUSED);
    expect(w.host.lstat(join(w.layout.state.apis.v2.shared, 'v2.env'))).toBeNull();
    expect(journalText(w)).not.toContain('api_config.v2_env');
    expect(w.err.at(-1)).toContain('api_config.v2_env');
  });

  test('a decision aborted: the vhost is not edited', async () => {
    const w = makeWorld();
    const answers = operator(w);
    w.prompter = scriptedPrompter({ ...answers, choices: { 'api_config.v1_db_transport': 'socket' } });
    const before = w.host.body(w.profile.vhost);
    expect(await init(w, firstRun(w))).toBe(EXIT.REFUSED);
    expect(w.host.body(w.profile.vhost)).toBe(before);
  });
});

describe('case 9b: a refused provision apply answered `manual` stops what depends on it', () => {
  // Measured on RHEL 10.2 (two-machine drill, 2026-10-09): a copy-mode media root whose parent
  // did not exist refused apply; `manual` was the only answer, and init then ran
  // api_config.v2_env anyway — it died on the missing state root (ENOENT), exit 4, the operator
  // told "a change failed" instead of "do this first".
  test('the dependents are not run, no journal entry, REFUSED naming them; the refusal reason is printed', async () => {
    const missing = '/srv/no_such_parent/media';
    const declaration = { ...expectedV2Only(PROFILES.el), media: { mode: 'copy' as const, root: missing } };
    const w = makeWorld({ os: 'el', declaration });
    w.host.entries.delete(missing);
    w.host.entries.delete(dirname(missing));
    const { apis: _apis, ...v2Draft } = DRAFT;
    useOperator(w);
    // The first run: the steps before apply run, apply is recomputed after them and refuses (by design).
    expect(await init(w, firstRun(w, { ...v2Draft, media: { mode: 'copy', root: missing } }))).toBe(EXIT.REFUSED);
    expect(w.err.join('\n')).toContain(`parent directory '${dirname(missing)}' of '${missing}' does not exist`);
    // The re-run (install.sh --kit again): apply is now a blocking refusal whose only answer is `manual`.
    w.out.length = 0;
    w.err.length = 0;
    sourceMode(w);
    w.prompter = scriptedPrompter(operator(w, { 'provision.apply': 'manual' }));
    const code = await init(w, firstRun(w, { ...v2Draft, media: { mode: 'copy', root: missing } }));
    expect(reportOf(w, 'provision.apply').join('\n')).toContain(`parent directory '${dirname(missing)}' of '${missing}' does not exist`);
    expect(w.err.filter(line => line.includes('[failed]'))).toEqual([]);
    expect(code).toBe(EXIT.REFUSED);
    expect(w.host.lstat(join(w.layout.state.apis.v2.shared, 'v2.env'))).toBeNull();
    expect(journalText(w)).not.toContain('api_config.v2_env');
    const refusal = w.err.at(-1) ?? '';
    expect(refusal).toContain('api_config.v2_env');
    expect(refusal).toContain('provision.apply');
  });
});

describe('case 10: a typed password never leaves the file it is written to', () => {
  test('not in out, err, the journal, any argv or any child environment', async () => {
    const w = makeWorld();
    useOperator(w);
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    const v2 = w.host.body(join(w.layout.state.apis.v2.shared, 'v2.env')) ?? '';
    expect(v2).toContain(`DB_PASSWORD='${PASSWORD}'`); // anti-vacuity: it was typed and written
    for (const secret of [PASSWORD, WEB_CODE]) {
      expect(w.out.join('\n')).not.toContain(secret);
      expect(w.err.join('\n')).not.toContain(secret);
      expect(journalText(w)).not.toContain(secret);
      expect(w.host.calls.join('\n')).not.toContain(secret);
      expect(JSON.stringify(w.host.pairCalls)).not.toContain(secret);
    }
  });
});

/* ── 11. the footgun guards ──────────────────────────────────────────────────────── */

describe('case 11: the footgun guards', () => {
  const cases: [string, (w: World) => void, string][] = [
    ['a bunfig.toml in the working directory', w => w.host.seedFile(`${STAGE}/bunfig.toml`, ''), "the working directory holds 'bunfig.toml'"],
    ['an .env file in the working directory', w => w.host.seedFile(`${STAGE}/.env.local`, ''), "the working directory holds '.env.local'"],
    ['BUN_OPTIONS in the environment', w => w.proc.set('/proc/self/environ', 'PATH=/usr/bin\0BUN_OPTIONS=--preload x\0'), 'the environment holds BUN_OPTIONS'],
    ['Bun started without --no-install', w => w.proc.set('/proc/self/cmdline', (w.proc.get('/proc/self/cmdline') ?? '').replace('--no-install\0', '')), 'Bun was started without --no-install'],
    ['Bun started with -c instead of --config=', w => w.proc.set('/proc/self/cmdline', (w.proc.get('/proc/self/cmdline') ?? '').replace(`--config=${STAGE}`, `-c\0${STAGE}`)), `Bun was started without --config=${STAGE}/empty.bunfig.toml`],
    ['a sysadm_t root (SELinux)', w => {
      w.host.seedFile('/sys/fs/selinux/enforce', '1');
      w.proc.set('/proc/self/attr/current', 'staff_u:sysadm_r:sysadm_t:s0');
    }, "root's SELinux context is sysadm_t, not unconfined_t"],
    ['not root', w => Object.assign(w.world, { euid: () => 1000 }), 'init runs as root (this process runs as uid 1000)'],
    ['code a non-root account can write', w => Object.assign(w.host.entries.get(STAGE) as object, { mode: 0o777 }), `the working directory '${STAGE}' is`],
  ];
  for (const [name, arrange, says] of cases) {
    test(`${name} → REFUSED, nothing done`, async () => {
      const w = makeWorld();
      useOperator(w);
      arrange(w);
      expect(await init(w, firstRun(w))).toBe(EXIT.REFUSED);
      expect(w.err.some(line => line.includes(says) && line.endsWith('start init through deploy/install.sh'))).toBe(true);
      expect(hostMutations(w)).toEqual([]);
      expect(w.host.lockIo.calls).toEqual([]);
    });
  }

  test('the guards pass on the world install.sh builds', () => {
    expect(footgunProblems(makeWorld().world)).toEqual([]);
  });
});

/* ── 12-14. shared code, an alias-only vhost, a home on NFS ──────────────────────── */

describe('case 12: a shared agent_dir (system layout) restarts the sibling only on act', () => {
  const system = { agent_dir: '/opt/dedalo_publication_host/host_agent', state_root: '/srv/dedalo_publication_host/test', bun_bin: '/opt/dedalo_publication_host/bun/bin/bun' };
  function sharedWorld(): World {
    const w = makeWorld({ declaration: expectedDeclaration(PROFILES.debian, system) });
    w.host.addSibling({
      instance: 'other',
      listen: { kind: 'unix' },
      agent_user: 'other_agent',
      engine_group: 'dedalo',
      agent_dir: system.agent_dir,
      web: { server: 'apache', unit: 'apache2' },
      v1: { user: 'other_v1' },
      state_root: '/srv/dedalo_publication_host/other',
      media: { mode: 'copy', root: '/srv/other_media' },
      php_bin: '/usr/bin/php8.4',
      bun_bin: system.bun_bin,
      v2: { unit: 'dedalo-publication-api-v2-other', user: 'other_v2', group: 'other_v2', port: 3200, health_url: 'http://127.0.0.1:3200/health' },
    });
    return w;
  }
  const draft: DraftDeclaration = { ...DRAFT, layout: 'system' };
  for (const [answer, restarts] of [['act', true], ['manual', false]] as const) {
    test(`declaration.shared_code=${answer}`, async () => {
      const w = sharedWorld();
      useOperator(w, { 'declaration.shared_code': answer });
      expect(await init(w, firstRun(w, draft))).toBe(EXIT.OK);
      expect(reportOf(w, 'declaration.shared_code').length).toBeGreaterThan(0);
      expect(w.host.calls.includes('restart dedalo-publication-host-other')).toBe(restarts);
      expect(w.host.calls).toContain('restart dedalo-publication-host-test');
    });
  }
});

describe('case 13: an alias-only vhost match', () => {
  test('is a blocking decision: nothing is done', async () => {
    const w = makeWorld();
    w.serverLine = 'other.org';
    w.host.seedFile(w.profile.vhost, '<VirtualHost *:443>\n  ServerName other.org\n  ServerAlias example.org\n  SSLEngine on\n</VirtualHost>\n');
    expect(await init(w, firstRun(w, DRAFT, ['--yes']))).toBe(EXIT.REFUSED);
    expect(listOf(w, 'declaration.vhost')).toBe(3);
    expect(reportOf(w, 'declaration.vhost')[0]).toContain('(blocking');
    expect(w.err[0]).toContain('declaration.vhost');
    expect(hostMutations(w)).toEqual([]);
  });
});

describe('case 14: a home on nfs4', () => {
  test('declaration.layout offers system and manual only; system yields the system paths and no home.root', async () => {
    const w = makeWorld();
    w.host.mounts.push({ mountPoint: '/home', fsType: 'nfs4', readOnly: false, noexec: false, seclabel: false, context: null });
    const draft: DraftDeclaration = { ...DRAFT, layout: undefined };
    expect(await init(w, firstRun(w, draft, ['--dry-run']))).toBe(EXIT.DRIFT);
    const layoutItem = reportOf(w, 'declaration.layout');
    expect(layoutItem.filter(line => /^ {6}[a-z]+: /.test(line)).map(line => line.trim().split(':')[0])).toEqual(['system', 'manual']);
    expect(layoutItem.join('\n')).toContain('nfs4');
    w.out.length = 0;
    expect(await init(w, firstRun(w, draft, ['--dry-run', '--decide', 'declaration.layout=system']))).toBe(EXIT.DRIFT);
    expect(w.out.join('\n')).toContain('state_root = /srv/dedalo_publication_host/test');
    expect(reportOf(w, 'home.root')).toEqual([]);
  });
});

/* ── 15. EL enforcing ────────────────────────────────────────────────────────────── */

describe('case 15: EL with SELinux enforcing', () => {
  test('the registered rules are exactly the S9 table for this layout', async () => {
    const w = await converged('el');
    const expected = selinuxRules(w.layout, { mediaLabelable: true, sharedMediaAccepted: false, homeTraverseByBoolean: false })
      .map(rule => `${rule.fileType} ${rule.type} ${rule.spec}`)
      .sort();
    expect(w.host.fcontext.map(rule => `${rule.ftype} ${rule.type} ${rule.spec}`).sort()).toEqual(expected);
    expect([...w.host.localPorts]).toEqual([[3100, 'http_port_t']]);
  });

  test('an operator rule on one of our specs with another type is a blocking decision', async () => {
    const w = await converged('el');
    const rule = w.host.fcontext.find(row => row.spec.endsWith('/publication_api/v1(/.*)?'));
    if (rule === undefined) throw new Error('fixture: no v1 rule');
    rule.type = 'httpd_sys_rw_content_t';
    expect(await init(w, ['test', '--yes'])).toBe(EXIT.REFUSED);
    expect(listOf(w, 'provision.apply')).toBe(3);
    expect(reportOf(w, 'provision.apply').join('\n')).toContain('semanage fcontext -l -C');
  });

  test('a v2 port the policy types otherwise moves declaration.v2_port', async () => {
    const w = makeWorld({ os: 'el' });
    w.host.portTypes.set(3100, 'mysqld_port_t');
    expect(await init(w, firstRun(w, DRAFT, ['--dry-run']))).toBe(EXIT.DRIFT);
    expect(listOf(w, 'declaration.v2_port')).toBe(3);
    expect(reportOf(w, 'declaration.v2_port').join('\n')).toContain('mysqld_port_t');
  });
});

describe('case 15b: EL 10 as the RHEL 10.2 drill VM measured it (captured/rhel10_drill_vm)', () => {
  const props = (name: string) =>
    Object.fromEntries(
      fixture(`captured/rhel10_drill_vm/${name}`)
        .split('\n')
        .filter(line => line.includes('='))
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );

  test('httpd ProtectHome=read-only + ProtectSystem=yes, polkit.service sandboxed, rules.d root:polkitd 0750: the home layout converges', async () => {
    const w = makeWorld({ os: 'el', el10: true });
    const httpd = props('show_web_default.txt');
    expect(httpd).toMatchObject({ ProtectHome: 'read-only', ProtectSystem: 'yes', DropInPaths: '/etc/systemd/system/httpd.service.d/php-fpm.conf' });
    w.host.unitProps.set('httpd', httpd);
    const polkit = props('show_polkit.txt');
    expect(polkit).toMatchObject({ User: 'polkitd', ProtectHome: 'yes', ProtectSystem: 'strict', UnitFileState: 'static' });
    w.host.unitProps.set('polkit', polkit);
    // The package's rules directory (measured: `root:polkitd 750 /etc/polkit-1/rules.d`).
    const rulesD = fixture('captured/rhel10_drill_vm/polkit_rules_d.txt').split('\n').find(line => line.endsWith(' /etc/polkit-1/rules.d'));
    expect(rulesD).toBe('root:polkitd 750 /etc/polkit-1/rules.d');
    w.host.users.set('polkitd', 994);
    w.host.groups.set('polkitd', 994);
    Object.assign(w.host.entries.get(dirname(w.layout.polkitPath)) as object, { uid: 0, gid: 994, mode: 0o750 });
    useOperator(w);
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(listOf(w, 'host.unit_sandbox')).toBe(1);
    expect(reportOf(w, 'host.unit_sandbox').join('\n')).toContain('no unit sandbox hides the declared paths');
    expect(listOf(w, 'host.polkit')).toBe(1);
    expect(w.host.body(w.layout.polkitPath)).toBeDefined();
  });
});

/* ── 16. the locks ───────────────────────────────────────────────────────────────── */

describe('case 16: the instance lock', () => {
  const lockPath = instanceLockPath(INIT, 'test');

  test('held by a running apply: init waits, then REFUSED naming it', async () => {
    const w = makeWorld();
    useOperator(w);
    const started = w.host.lockIo.clock;
    w.host.lockIo.holders.push({ path: lockPath, mode: 'ex', pid: 777, untilMs: Number.POSITIVE_INFINITY });
    w.host.lockIo.records.set(`${lockPath}.owner`, JSON.stringify({ pid: 777, verb: 'apply', started: '2026-10-08T11:59:00Z' }));
    expect(await init(w, firstRun(w))).toBe(EXIT.REFUSED);
    expect(w.err[0]).toBe("provision init: instance 'test' is locked by apply pid 777 since 2026-10-08T11:59:00Z; wait or check that process");
    expect(w.host.lockIo.clock - started).toBeGreaterThanOrEqual(5000);
    expect(hostMutations(w)).toEqual([]);
  });

  test("init's in-process apply runs under init's own lock: it is opened once, never waited on", async () => {
    const w = makeWorld();
    useOperator(w);
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(instanceLockOpens(w)).toBe(1);
    expect(w.host.lockIo.heldBySelf(lockPath)).toBeNull(); // released at the end
  });

  test('check during init ends 5 (BUSY); two checks run together', async () => {
    const w = await converged();
    const check = () => run(['check', 'test'], { deps: w.world.provisionDeps, out: line => w.out.push(line), err: line => w.err.push(line) });
    w.host.lockIo.holders.push({ path: lockPath, mode: 'ex', pid: 778, untilMs: w.host.lockIo.clock + 60_000 });
    expect(check()).toBe(EXIT.BUSY);
    w.host.lockIo.holders.splice(0, 1, { path: lockPath, mode: 'sh', pid: 779, untilMs: Number.POSITIVE_INFINITY });
    expect(check()).toBe(EXIT.OK);
  });
});

/* ── 17. the nginx hand map ──────────────────────────────────────────────────────── */

describe("case 17: an nginx host with the guide's hand map and loaded media includes", () => {
  const pins = NGINX_MAP_PINS.at(-1) as (typeof NGINX_MAP_PINS)[number];
  const handMap = renderHostMap([{ hash: 'c'.repeat(64), envelope: envelopePcre('media', 'image'), pinsId: pins.id }]).text;
  const mapId = `web.nginx_manual_map.${sha(HAND_MAP).slice(0, 8)}`;
  function nginxWorld(): World {
    const w = makeWorld({ nginx: true });
    w.host.seedFile(HAND_MAP, handMap);
    useOperator(w, { [mapId]: 'act' });
    return w;
  }
  const live = (w: World) => join(w.layout.host.nginxMapDir, 'dedalo_media_map.nginx.conf');

  test('act: the seed converges in ONE configtest and ONE reload; the hand map is gone, the live map is its canonical copy', async () => {
    const w = nginxWorld();
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(w.host.body(HAND_MAP)).toBeUndefined();
    expect(w.host.body(live(w))).toBe(handMap);
    expect(w.host.body(join(w.layout.host.nginxContribDir, '_seed.json'))).toBeDefined();
    const calls = w.host.calls;
    const start = calls.indexOf(`writeBytesAtomic ${live(w)}`);
    const end = calls.indexOf('reload nginx', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(calls.slice(start, end + 1).filter(call => call === 'configtest nginx')).toHaveLength(1);
    // The second run sees no hand map and nothing to do.
    rerunMode(w);
    w.out.length = 0;
    w.prompter = scriptedPrompter({ interactive: false });
    expect(await init(w, ['test', '--yes'])).toBe(EXIT.OK);
    expect(reportOf(w, mapId)).toEqual([]);
  });

  test('a failing configtest restores the hand map and removes the seed', async () => {
    const w = nginxWorld();
    w.configtestFails = host => host.body(live(w)) !== undefined;
    expect(await init(w, firstRun(w))).toBe(EXIT.FAILED);
    expect(w.host.body(HAND_MAP)).toBe(handMap);
    expect(w.host.body(live(w))).toBeUndefined();
    expect(w.host.body(join(w.layout.host.nginxContribDir, '_seed.json'))).toBeUndefined();
    expect(w.err.join('\n')).toContain(mapId);
  });
});

describe('case 17b: apache2 and nginx both installed (measured: Ubuntu 24.04 keeps a stopped, disabled apache2 loaded)', () => {
  /** The nginx host with apache2 installed beside it: listed loaded, running or not. */
  function bothWorld(apacheRunning: boolean): World {
    const w = makeWorld({ nginx: true });
    w.host.candidateUnits.push('apache2.service');
    if (!apacheRunning) w.host.listedInactive.add('apache2.service');
    w.host.seedFile('/usr/sbin/apache2ctl', '', 0o755);
    w.host.seedDir('/etc/nginx/conf.d');
    return w;
  }
  const declared = (w: World) => JSON.parse(w.host.body(`/etc/dedalo_publication_host/test.json`) ?? '{}') as { web?: { server?: string; unit?: string } };

  test('the one that runs is proposed and observed: host.web defaults to nginx, its vhost is found, the run converges on nginx', async () => {
    const w = bothWorld(false);
    // The operator types the default, as the pty does (an unanswered decision stays open: REFUSED).
    useOperator(w, { 'host.web': 'nginx' });
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(w.out.join('\n')).toMatch(/both apache and nginx are installed/);
    expect(w.out).toContain('      nginx: nginx (default)');
    expect(declared(w).web).toMatchObject({ server: 'nginx', unit: 'nginx' });
  });

  test('both running: the answer to host.web is OBSERVED again (its vhost, its binaries), not only declared', async () => {
    const w = bothWorld(true);
    useOperator(w, { 'host.web': 'nginx' });
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(declared(w).web).toMatchObject({ server: 'nginx', unit: 'nginx' });
  });

  test('--decide host.web=nginx without a terminal observes nginx from the start', async () => {
    const w = bothWorld(true);
    w.prompter = scriptedPrompter({ interactive: false });
    expect(await init(w, [...firstRun(w), '--yes', '--decide', 'host.web=nginx', '--decide', `${vhostId(w)}=act`])).not.toBe(EXIT.USAGE);
    expect(reportOf(w, vhostId(w)).length).toBeGreaterThan(0);
  });
});

/* ── 18-20. hardened hosts, an EL 8 host, home.root's facts ───────────────────── */

describe('case 18: hardened hosts', () => {
  test('a noexec home: only the system layout is offered', async () => {
    const w = makeWorld();
    w.host.mounts.push({ mountPoint: '/home', fsType: 'ext4', readOnly: false, noexec: true, seclabel: false, context: null });
    expect(await init(w, firstRun(w, { ...DRAFT, layout: undefined }, ['--dry-run']))).toBe(EXIT.DRIFT);
    expect(reportOf(w, 'declaration.layout').join('\n')).toContain('noexec');
    expect(reportOf(w, 'declaration.layout').some(line => line.trim().startsWith('home:'))).toBe(false);
  });

  test('a noexec /opt under the system layout: host.noexec blocks', async () => {
    const w = makeWorld();
    w.host.mounts.push({ mountPoint: '/opt', fsType: 'ext4', readOnly: false, noexec: true, seclabel: false, context: null });
    expect(await init(w, firstRun(w, { ...DRAFT, layout: 'system' }, ['--yes']))).toBe(EXIT.REFUSED);
    expect(listOf(w, 'host.noexec')).toBe(3);
    expect(reportOf(w, 'host.noexec')[0]).toContain('(blocking');
    expect(hostMutations(w)).toEqual([]);
  });

  /** fapolicyd installed (its CLI a real file), running, reading trust.d, with `integrity`. */
  function withFapolicyd(w: World, integrity: string): void {
    w.host.fapolicydActive = true;
    w.host.fapolicydDaemon.active = true;
    w.host.seedFile('/usr/sbin/fapolicyd-cli', '', 0o755);
    w.host.seedFile('/etc/fapolicyd/fapolicyd.conf', `permissive = 0\ntrust = rpmdb,file\nintegrity = ${integrity}\nallow_filesystem_mark = 1\n`);
    w.host.seedDir('/etc/fapolicyd/trust.d');
  }

  test('fapolicyd installed and running: host.fapolicyd is RIGHT (nothing by hand) — the converge trusts bun_bin and the agent tree, renders the trust unit and its one grant, and updates fapolicyd BEFORE the agent starts', async () => {
    const w = makeWorld();
    withFapolicyd(w, 'sha256');
    useOperator(w);
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(listOf(w, 'host.fapolicyd')).toBe(1);
    expect(listOf(w, 'host.fapolicyd_integrity')).toBe(1);
    expect(listOf(w, 'host.fapolicyd_mounts')).toBe(1);
    expect(reportOf(w, 'host.fapolicyd').join('\n')).toContain('trust is automatic');
    const layout = derive(expectedDeclaration(w.profile), { fapolicyd: true });
    const trust = w.host.body('/etc/fapolicyd/trust.d/dedalo_test') ?? '';
    const trusted = trust.split('\n').filter(line => line.startsWith('/')).map(line => line.split(' ')[0]);
    expect(trusted).toContain(layout.bunBin);
    expect(trusted).toContain(layout.agentEntry);
    expect(trusted).toContain(layout.polkitPath);
    expect(trusted.every(path => path === layout.bunBin || path === layout.polkitPath || path.startsWith(`${layout.agentDir}/`))).toBe(true);
    expect(w.host.body('/etc/systemd/system/dedalo-pubhost-trust-test.service')).toContain('Type=oneshot');
    expect(w.host.body(layout.polkitPath)).toContain('unit === "dedalo-pubhost-trust-test.service" && verb === "start"');
    const update = w.host.calls.indexOf('fapolicyd-cli --update');
    expect(update).toBeGreaterThan(-1);
    const start = w.host.calls.findIndex(call => call.startsWith(`start ${layout.agentUnitName}`) || call.startsWith(`restart ${layout.agentUnitName}`));
    expect(start).toBeGreaterThan(update);
    expect(w.host.calls).toContain('fapolicyd-cli --dump-db');
  });

  test('new agent code on a fapolicyd host: provision apply rewrites the trust with the NEW code before the agent restarts (measured, RHEL 10.2: "EPERM reading …/src/index.ts", the agent never came back)', async () => {
    const w = makeWorld();
    withFapolicyd(w, 'sha256');
    useOperator(w);
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    const layout = derive(expectedDeclaration(w.profile), { fapolicyd: true });
    // install.sh --kit with the next release: the same draft, one agent file changed, nothing else drifts.
    w.out.length = 0;
    w.err.length = 0;
    sourceMode(w);
    w.host.seedFile(`${SOURCE}/publication/host_agent/src/index.ts`, 'export const next = 2;\n');
    w.host.calls.length = 0;
    useOperator(w);
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(listOf(w, 'code.install')).toBe(2);
    expect(listOf(w, 'provision.apply')).toBe(2);
    const entry = `${layout.agentDir}/src/index.ts`;
    const line = (w.host.body('/etc/fapolicyd/trust.d/dedalo_test') ?? '').split('\n').find(row => row.startsWith(`${entry} `)) ?? '';
    expect(line).toBe(`${entry} ${'export const next = 2;\n'.length} ${sha('export const next = 2;\n')}`);
    const update = w.host.calls.indexOf('fapolicyd-cli --update');
    const restart = w.host.calls.findIndex(call => call.startsWith(`restart ${layout.agentUnitName}`));
    expect(update).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(update);
  });

  test("fapolicyd's integrity = none: an optional host-wide warning recommending sha256 — the converge still completes", async () => {
    const w = makeWorld();
    withFapolicyd(w, 'none');
    useOperator(w);
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(listOf(w, 'host.fapolicyd_integrity')).toBe(3);
    expect(reportOf(w, 'host.fapolicyd_integrity').join('\n')).toContain('integrity = sha256');
    expect(w.host.body('/etc/fapolicyd/trust.d/dedalo_test')).toBeDefined();
  });

  test('a web unit with ProtectHome=yes: only the system layout', async () => {
    const w = makeWorld();
    w.host.unitProps.set('apache2', { LoadState: 'loaded', ActiveState: 'active', ProtectHome: 'yes' });
    expect(await init(w, firstRun(w, { ...DRAFT, layout: undefined }, ['--dry-run']))).toBe(EXIT.DRIFT);
    const item = reportOf(w, 'declaration.layout').join('\n');
    expect(item).toContain('ProtectHome');
    expect(item).not.toMatch(/^ {6}home:/m);
  });
});

describe('case 19: an EL 8 host (unsupported: systemd 239, kernel 4.18)', () => {
  test('host.os and host.kernel block, naming the upgrade and the manual guide', async () => {
    const w = makeWorld({ os: 'el' });
    w.host.seedFile('/etc/os-release', 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="8.10"\nPRETTY_NAME="Rocky Linux 8.10 (Green Obsidian)"\n');
    w.host.kernelRelease = '4.18.0-553.el8_10.x86_64';
    expect(await init(w, firstRun(w, DRAFT, ['--dry-run']))).toBe(EXIT.DRIFT);
    expect(listOf(w, 'host.os')).toBe(3);
    expect(reportOf(w, 'host.os').join('\n')).toContain('upgrade to RHEL, Rocky or Alma 9 or 10');
    expect(listOf(w, 'host.kernel')).toBe(3);
    expect(reportOf(w, 'host.kernel')[0]).toContain('(blocking');
  });
});

describe('case 20: home.root on a 0700 home', () => {
  test('the facts name the widening and the world-readable files', async () => {
    const w = makeWorld();
    expect(await init(w, firstRun(w, DRAFT, ['--dry-run']))).toBe(EXIT.DRIFT);
    const item = reportOf(w, 'home.root').join('\n');
    expect(item).toContain('the mode widens from 0700 to 0755');
    expect(item).toContain('public_html/index.html');
    expect(item).toContain('chown root:root /home/example.org && chmod 0755 /home/example.org');
  });
});

/* ── 21. a hand-run apply without the host-wide group ────────────────────────────── */

describe('case 21: a hand-run `provision apply` on a host without dedalo_pubhost', () => {
  test('REFUSED with the groupadd line; no unit written', () => {
    const w = makeWorld();
    w.host.seedDir('/etc/dedalo_publication_host');
    w.host.seedFile(w.layout.declarationPath, canonicalDeclaration(expectedDeclaration(w.profile)));
    for (const name of ['test_agent', 'test_v1', 'test_v2']) w.host.users.set(name, 950);
    const err: string[] = [];
    const code = run(['apply', 'test'], { deps: w.world.provisionDeps, out: () => {}, err: line => err.push(line) });
    expect(code).toBe(EXIT.REFUSED);
    expect(err.join('\n')).toContain('groupadd --system dedalo_pubhost');
    expect(w.host.lstat(w.layout.agentUnitPath)).toBeNull();
    expect(hostMutations(w)).toEqual([]);
  });
});

/* ── B5 on one machine ───────────────────────────────────────────────────────────── */

describe('B5: a work engine on this machine', () => {
  function withEngine(): World {
    const w = makeWorld();
    w.host.candidateUnits.push('dedalo-ts.service');
    const props = Object.fromEntries(
      fixture('typed/systemd/show_dedalo_ts.txt')
        .trim()
        .split('\n')
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    w.host.unitProps.set('dedalo-ts', props);
    w.host.users.set('dedalo', 1500);
    w.host.accountGroups.set('dedalo', { primary: 1000, all: [1000] });
    w.host.seedDir('/home/dedalo/v7/private');
    Object.assign(w.host.entries.get('/home/dedalo/v7/private') as object, { uid: 1500, gid: 1000, mode: 0o700 });
    useOperator(w);
    return w;
  }

  test('a fresh host pairs after apply wrote the fragment: dry run, then the real pairing, the token on stdin only', async () => {
    const w = withEngine();
    expect(await init(w, firstRun(w))).toBe(EXIT.OK);
    expect(listOf(w, 'pair.engine')).toBe(2);
    expect(w.host.pairCalls.map(call => [call.verb, call.name, call.dryRun])).toEqual([
      ['add', 'test', true],
      ['add', 'test', false],
    ]);
    expect(w.host.pairCalls.every(call => call.token === FAKE_TOKEN && call.user === 'dedalo')).toBe(true);
    expect(JSON.stringify(w.host.pairCalls.map(call => call.env))).not.toContain('hunter2');
    // Paired in an earlier run: the second run does not pair again.
    rerunMode(w);
    w.out.length = 0;
    w.prompter = scriptedPrompter({ interactive: false });
    expect(await init(w, ['test', '--yes'])).toBe(EXIT.OK);
    expect(listOf(w, 'pair.engine')).toBe(1);
    expect(w.host.pairCalls).toHaveLength(2);
  });

  test("'already registered' from the engine: REFUSED, naming --decide pair.engine=replace", async () => {
    const w = withEngine();
    w.host.pairResult = { code: 3, stdout: '', stderr: "provision: 'test' is already registered. Use `replace`" };
    expect(await init(w, firstRun(w))).toBe(EXIT.REFUSED);
    expect(w.err.join('\n')).toContain('--decide pair.engine=replace');
  });
});

describe('B5 on two machines: the sealed pairing package (tls listener)', () => {
  const TLS_LISTEN = { kind: 'tls' as const, host: '10.8.0.2', port: 7443 };
  const PACKAGE = `${INIT}/test/test.pairing`;
  function tlsWorld(): World {
    const { engine_group: _dropped, ...rest } = expectedDeclaration(PROFILES.debian, { listen: TLS_LISTEN });
    const w = makeWorld({ declaration: rest as HostDeclaration });
    useOperator(w);
    return w;
  }
  const tlsDraft: DraftDeclaration = (() => {
    const { engine_group: _dropped, ...rest } = DRAFT;
    return { ...rest, listen: TLS_LISTEN } as DraftDeclaration;
  })();
  const shownPassphrase = (w: World): string => {
    const shown = (w.prompter as { shown?: string[] }).shown ?? [];
    return shown.map(line => line.trim()).find(line => /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test(line)) ?? '';
  };

  test('written root 0600 after B4; the passphrase shown once on the terminal only — never in out, err or the journal; it opens the package', async () => {
    const w = tlsWorld();
    expect(await init(w, firstRun(w, tlsDraft))).toBe(EXIT.OK);
    expect(listOf(w, 'pair.package')).toBe(2);
    expect(w.host.lstat(PACKAGE)).toMatchObject({ type: 'file', uid: 0, gid: 0, mode: 0o600 });
    const passphrase = shownPassphrase(w);
    expect(passphrase).not.toBe('');
    for (const text of [w.out.join('\n'), w.err.join('\n'), w.host.body(JOURNAL) ?? '']) {
      expect(text).not.toContain(passphrase);
      expect(text).not.toContain(passphrase.replace(/-/g, ''));
    }
    expect(w.host.calls.join('\n')).not.toContain(passphrase);
    expect(w.out.join('\n')).toContain(`pair: wrote ${PACKAGE} (root 0600)`);
    expect(w.host.pairCalls).toEqual([]); // two machines: nothing is paired from here
    const parts = openPairingPackage(w.host.entries.get(PACKAGE)?.bytes ?? new Uint8Array(), passphrase);
    expect(parts.token).toBe(FAKE_TOKEN);
    expect(parts.fragment).toContain('DEDALO_PUBLICATION_HOST_URL=');
    expect(parts.bundle).toContain('-----BEGIN');
  });

  test('a later run: right (no new passphrase); --decide pair.package=again without a terminal stays open, writes nothing', async () => {
    const w = tlsWorld();
    expect(await init(w, firstRun(w, tlsDraft))).toBe(EXIT.OK);
    const first = w.host.body(PACKAGE);
    rerunMode(w);
    w.out.length = 0;
    w.prompter = scriptedPrompter({ interactive: false });
    expect(await init(w, ['test', '--yes'])).toBe(EXIT.OK);
    expect(listOf(w, 'pair.package')).toBe(1);
    rerunMode(w);
    w.out.length = 0;
    expect(await init(w, ['test', '--yes', '--decide', 'pair.package=again'])).toBe(EXIT.OK);
    expect(listOf(w, 'pair.package')).toBe(2);
    expect(w.out.join('\n')).toContain('needs a terminal (the passphrase is shown once)');
    expect(w.host.body(PACKAGE)).toBe(first);
    expect((w.prompter as { shown?: string[] }).shown).toEqual([]);
  });

  /** The agent's trail (provision apply created it, agent-owned, append-only): its bytes only. */
  const trail = (w: World, text: string) => {
    (w.host.entries.get(w.layout.state.auditFile) as { body: string }).body = text;
  };
  /** One audit line as the agent writes it (src/audit.ts). */
  const auditLine = (ts: string, action: string) => `${JSON.stringify({ ts, actor: 'engine', action, outcome: 'ok' })}\n`;

  test('once the agent records a work-host command after it was written: STALE — the decision to remove it; --decide pair.package=remove removes it, journaled', async () => {
    const w = tlsWorld();
    expect(await init(w, firstRun(w, tlsDraft))).toBe(EXIT.OK);
    // Before any work-host command (the trail empty, or an older one): right, naming the decide.
    rerunMode(w);
    w.out.length = 0;
    w.prompter = scriptedPrompter({ interactive: false });
    trail(w, auditLine('2000-01-01T00:00:00.000Z', 'rules.apply'));
    expect(await init(w, ['test', '--dry-run'])).toBe(EXIT.OK);
    expect(listOf(w, 'pair.package')).toBe(1);
    expect(reportOf(w, 'pair.package').join('\n')).toContain('--decide pair.package=remove');
    // An automatic rollback is not the work host: still not stale.
    trail(w, auditLine('2999-01-01T00:00:00.000Z', 'release.auto_rollback'));
    w.out.length = 0;
    expect(await init(w, ['test', '--dry-run'])).toBe(EXIT.OK);
    expect(listOf(w, 'pair.package')).toBe(1);
    // The work host applied its rules after the package was written: stale.
    trail(w, auditLine('2999-01-01T00:00:00.000Z', 'rules.apply'));
    w.out.length = 0;
    expect(await init(w, ['test', '--dry-run'])).toBe(EXIT.OK);
    expect(listOf(w, 'pair.package')).toBe(3);
    expect(reportOf(w, 'pair.package').join('\n')).toContain('the sealed pairing package is stale: the work host used its credentials (rules.apply at 2999-01-01T00:00:00.000Z)');
    expect(w.host.lstat(PACKAGE)?.type).toBe('file');
    // --yes alone never answers the decision; --decide does.
    w.out.length = 0;
    expect(await init(w, ['test', '--yes'])).toBe(EXIT.OK);
    expect(w.host.lstat(PACKAGE)?.type).toBe('file');
    rerunMode(w);
    w.out.length = 0;
    expect(await init(w, ['test', '--yes', '--decide', 'pair.package=remove'])).toBe(EXIT.OK);
    expect(w.host.lstat(PACKAGE)).toBeNull();
    expect(w.host.lstat(`${PACKAGE}.dedalo-init.tmp`)).toBeNull();
    expect(journalText(w)).toMatch(/"item":"pair.package","phase":"done","detail":\{"path":"[^"]+test.pairing"\}/);
    // Gone: right, and never written again.
    rerunMode(w);
    w.out.length = 0;
    expect(await init(w, ['test', '--yes'])).toBe(EXIT.OK);
    expect(listOf(w, 'pair.package')).toBe(1);
    expect(reportOf(w, 'pair.package').join('\n')).toContain('was written and is gone');
    expect(w.host.lstat(PACKAGE)).toBeNull();
  });

  test('pair.package=remove leaves in place, by name, a file that is not the package init wrote (another mode, another format)', async () => {
    for (const replace of [{ mode: 0o644, bytes: null }, { mode: 0o600, bytes: 'NOTAPAIRINGFILE-but-long-enough-to-be-one-0123456789-0123456789' }]) {
      const w = tlsWorld();
      expect(await init(w, firstRun(w, tlsDraft))).toBe(EXIT.OK);
      const entry = w.host.entries.get(PACKAGE) as { mode: number; body: string; bytes?: Uint8Array };
      entry.mode = replace.mode;
      if (replace.bytes !== null) {
        entry.body = replace.bytes;
        entry.bytes = new TextEncoder().encode(replace.bytes);
      }
      rerunMode(w);
      w.out.length = 0;
      w.prompter = scriptedPrompter({ interactive: false });
      expect(await init(w, ['test', '--yes', '--decide', 'pair.package=remove'])).toBe(EXIT.REFUSED);
      expect(w.err.join('\n')).toContain(`'${PACKAGE}' is not the sealed package init wrote`);
      expect(w.host.lstat(PACKAGE)?.type).toBe('file');
    }
  });

  test('--no-pair: no package, the printed instructions only', async () => {
    const w = tlsWorld();
    expect(await init(w, firstRun(w, tlsDraft, ['--no-pair']))).toBe(EXIT.OK);
    expect(listOf(w, 'pair.package')).toBeNull();
    expect(w.host.lstat(PACKAGE)).toBeNull();
    expect(shownPassphrase(w)).toBe('');
  });
});

/* ── the production world ────────────────────────────────────────────────────────── */

describe('initHostDeps', () => {
  test('builds the world on demand only: a USAGE answer touches nothing', async () => {
    const deps = initHostDeps();
    expect(typeof deps.world).toBe('function');
    const err: string[] = [];
    expect(await runInit(['test', '--declaration', '/x'], { ...deps, err: line => err.push(line), world: () => {
      throw new Error('built');
    } })).toBe(EXIT.USAGE);
    expect(err[0]).toBe('provision init: init writes the declaration; give the draft with --draft');
  });

  test('the production world: INIT_BASE, the real trust root, root 0:0, the tty prompter, both exec sets', () => {
    const world = productionWorld();
    expect(world.initBase).toBe(INIT_BASE);
    expect(world.trustRoot).toBe('/');
    expect(world.root).toEqual({ uid: 0, gid: 0 });
    expect(world.cwd).toBe(process.cwd());
    expect(world.execPath).toBe(process.execPath);
    expect(typeof world.exec.groupAdd).toBe('function');
    expect(typeof world.exec.webConfigtest).toBe('function');
    expect(typeof world.prompter.secret).toBe('function');
    expect(world.fs.lstat('/')?.type).toBe('dir');
  });

  test('an unknown --decide id is USAGE before anything is read', async () => {
    const err: string[] = [];
    expect(await runInit(['test', '--decide', 'nope.item=act'], { out: () => {}, err: line => err.push(line), world: () => {
      throw new Error('built');
    } })).toBe(EXIT.USAGE);
    expect(err).toEqual(['provision init: --decide nope.item: no such item']);
  });
});

describe('the kit install.sh was given: offered for removal once the install converged', () => {
  const KIT = '/root/museum_org.kit.tar.gz';
  const KIT_BYTES = 'a kit archive, as the work host built it';
  const kitArgs = (digest = sha(KIT_BYTES)) => ['--kit-file', KIT, '--kit-digest-confirmed', digest];

  test('on a terminal: confirmed → removed (only that file, journaled); the run converged first', async () => {
    const w = makeWorld();
    w.host.seedFile(KIT, KIT_BYTES, 0o600);
    w.host.seedFile('/root/other.tar.gz', KIT_BYTES, 0o600);
    useOperator(w);
    expect(await init(w, firstRun(w, DRAFT, kitArgs()))).toBe(EXIT.OK);
    expect(w.prompter.asked?.some(q => q.includes(`Remove the kit ${KIT} you gave install.sh`))).toBe(true);
    expect(w.host.lstat(KIT)).toBeNull();
    expect(w.host.lstat('/root/other.tar.gz')?.type).toBe('file');
    expect(w.out).toContain(`removed the kit ${KIT}`);
    expect(journalText(w)).toMatch(/"item":"kit.remove","phase":"done","detail":\{"path":"\/root\/museum_org.kit.tar.gz"\}/);
  });

  test('declined on a terminal → kept and named; without a terminal only --yes removes it', async () => {
    const w = await converged();
    w.host.seedFile(KIT, KIT_BYTES, 0o600);
    w.prompter = scriptedPrompter({ ...operator(w), confirm: false });
    expect(await init(w, ['test', ...kitArgs()])).toBe(EXIT.OK);
    expect(w.host.lstat(KIT)?.type).toBe('file');
    expect(w.out.join('\n')).toContain(`the kit ${KIT} is no longer needed here`);
    rerunMode(w);
    w.prompter = scriptedPrompter({ interactive: false });
    expect(await init(w, ['test', ...kitArgs()])).toBe(EXIT.OK); // no terminal, no --yes: a dry run
    expect(w.host.lstat(KIT)?.type).toBe('file');
    rerunMode(w);
    expect(await init(w, ['test', '--yes', ...kitArgs()])).toBe(EXIT.OK);
    expect(w.host.lstat(KIT)).toBeNull();
  });

  test('a file that no longer hashes to the confirmed sha256, or a link, is left in place, by name — the run still succeeds', async () => {
    const w = await converged();
    w.host.seedFile(KIT, 'replaced since install.sh verified it', 0o600);
    w.prompter = scriptedPrompter({ interactive: false });
    expect(await init(w, ['test', '--yes', ...kitArgs()])).toBe(EXIT.OK);
    expect(w.host.lstat(KIT)?.type).toBe('file');
    expect(w.err.join('\n')).toContain(`the kit was left in place: init io: refusing to remove '${KIT}': its sha256 is`);
    expect(journalText(w)).toContain('"item":"kit.remove","phase":"failed"');
    w.host.entries.delete(KIT);
    w.host.entries.set(KIT, { type: 'symlink', uid: 0, gid: 0, mode: 0o777, body: '', target: '/etc/passwd' });
    rerunMode(w);
    w.err.length = 0;
    expect(await init(w, ['test', '--yes', ...kitArgs()])).toBe(EXIT.OK);
    expect(w.host.lstat(KIT)?.type).toBe('symlink');
    expect(w.err.join('\n')).toContain('it is a symbolic link');
  });

  test('a run that does not converge offers nothing', async () => {
    const w = makeWorld();
    w.host.seedFile(KIT, KIT_BYTES, 0o600);
    w.prompter = scriptedPrompter({ interactive: false });
    // --yes without a terminal: the decisions and secrets stay open → REFUSED, the kit untouched.
    expect(await init(w, firstRun(w, DRAFT, ['--yes', ...kitArgs()]))).toBe(EXIT.REFUSED);
    expect(w.host.lstat(KIT)?.type).toBe('file');
  });
});
