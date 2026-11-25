/**
 * init/act.ts — executeItems and resumeOpen on the FakeInitHost (tests/support/
 * provision_fake_host.ts): a Debian and an EL (SELinux enforcing) world, the journal on the
 * same virtual tree, and test doubles for the other packages' ports (P5 Bun install, P6
 * web_txn + web_edit, P7 B4/B5, cli.ts apply) that record what act handed them.
 *
 * Each action: acts once, records begin → done; is a `noop` (zero mutations) when its fact is
 * already right; and fails or refuses loudly, stopping the run. The mutation targets of spec §9
 * that live here are marked MUTATION.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ActContext, ActPorts, MapSeedRequest, OperatorEditRequest, TxnResult } from '../src/provision/init/act';
import { cleanupAfterSuccess, executeItems, readSebool, relocationFileType, relocationLines, resumeOpen, seededPaths, specPath } from '../src/provision/init/act';
import type { V1Values, V2Values } from '../src/provision/init/api_config';
import { openJournal } from '../src/provision/init/journal';
import { decodeJournal } from '../src/provision/init/journal_format';
import { newPathOf, prevPathOf, treeDigest } from '../src/provision/init/tree_copy';
import { insertApacheReference, insertNginxReference, removeManualLines } from '../src/provision/init/web_edit';
import type { InitAction, Item, ItemList } from '../src/provision/init/types';
import type { AgentLayout, HostDeclaration } from '../src/provision/layout';
import { canonicalDeclaration, derive, HOME_ROOT_MODE } from '../src/provision/layout';
import type { LockHandle } from '../src/provision/lock';
import { FakeInitHost, type FakeOs, siteHomeDeclaration } from './support/provision_fake_host';

const INIT_DIR = '/var/lib/dedalo_publication_host_init/test';
const HOME = '/home/example.org';
const SELINUX_TYPES = ['usr_t', 'bin_t', 'home_root_t', 'httpd_sys_content_t', 'httpd_sys_rw_content_t', 'httpd_log_t', 'httpd_config_t'];
/** Built at runtime: a fixture, never a credential-shaped literal (.gitleaks.toml). */
const PASSWORD = ['Pz', '7', 'q', 'LmW'].join('-');
const CODE = ['uc', 'K4', 'r9Qt', 'x2'].join('');
const V2_SAMPLE = `${INIT_DIR}/kept/.env.example`;
const V1_SAMPLE = `${INIT_DIR}/kept/sample.server_config_api.php`;
const V2_TEMPLATE = ['DEPLOYMENT_MODE=apache', 'DB_SOCKET=', 'DB_HOST=localhost', 'DB_PORT=3306', 'DB_USER=readonly_user', 'DB_PASSWORD=secret', 'DB_NAMES=dedalo_web', 'DB_POOL_MAX=10', ''].join('\n');
const V1_TEMPLATE = [
  '<?php',
  "\tdefine('API_ROOT', dirname(__FILE__, 2));",
  "\tdefine('API_ENTITY', 'my_organization');",
  "\t$DEFAULT_DDBB\t\t= 'web_XXXXXXXXX';",
  "\tdefine('API_WEB_USER_CODE', 'XXXXXXXXXXXXXXXXXXXXXXXXXXX');",
  "\tdefine('MYSQL_DEDALO_HOSTNAME_CONN'\t, 'localhost');",
  "\tdefine('MYSQL_DEDALO_USERNAME_CONN'\t, 'read_only_user');",
  "\tdefine('MYSQL_DEDALO_PASSWORD_CONN'\t, 'XXXXXXXXXXXXX..');",
  "\tdefine('MYSQL_DEDALO_DATABASE_CONN'\t, $db_name);",
  "\tdefine('MYSQL_DEDALO_DB_PORT_CONN'\t, null);",
  "\tdefine('MYSQL_DEDALO_SOCKET_CONN'\t, null);",
  '',
].join('\n');
const V2_VALUES: V2Values = { host: 'localhost', port: '3306', socket: null, user: 'web_ro', password: PASSWORD, dbNames: ['web_one'], deploymentMode: 'apache' };
const V1_VALUES: V1Values = { host: 'localhost', user: 'web_ro', password: PASSWORD, entity: 'museum', webUserCode: CODE, db: 'web_one', transport: 'socket', socket: '/run/mysqld/mysqld.sock', port: null };
const VHOST = '/etc/apache2/sites-available/example.org-le-ssl.conf';
const VHOST_TEXT = '<IfModule mod_ssl.c>\n<VirtualHost *:443>\n  ServerName example.org\n  Alias /dedalo/media /x\n</VirtualHost>\n</IfModule>\n';

function sha(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

interface World {
  readonly host: FakeInitHost;
  readonly layout: AgentLayout;
  readonly ctx: ActContext;
  readonly calls: string[];
  /** Mutable port behaviour. */
  readonly behave: { apply: number; verify: 'done' | 'failed'; pair: 'done' | 'refused'; bun: 'done' | 'refused' | 'failed'; problems: string[]; locks: number };
  readonly edits: OperatorEditRequest[];
  readonly seeds: MapSeedRequest[];
  journalText(): string;
}

/** A web_txn double: backup → write → configtest → reload + active poll, restoring on failure (spec §5.10). */
function fakeTxn(host: FakeInitHost, layout: AgentLayout, request: OperatorEditRequest): TxnResult {
  const before = host.readOperatorFile(request.target);
  host.writeBytesAtomic(request.backup, before.bytes, 0o600, 0, 0);
  host.writeBytesAtomic(request.target, request.after, before.mode, before.uid, before.gid);
  const test1 = host.exec.webConfigtest(layout.web.configtestBin, layout.web.server);
  if (test1.code !== 0) {
    host.writeBytesAtomic(request.target, before.bytes, before.mode, before.uid, before.gid);
    return { outcome: 'rolled_back', reason: 'configtest failed; restored', exit1: test1.code, exit2: host.exec.webConfigtest(layout.web.configtestBin, layout.web.server).code };
  }
  host.exec.reloadUnit(layout.web.unit);
  return { outcome: 'done' };
}

function makeWorld(options: { os?: FakeOs; decl?: HostDeclaration; selinux?: 'absent' | 'disabled' | 'permissive' | 'enforcing'; agentRule?: boolean; secrets?: boolean } = {}): World {
  const layout = derive(options.decl ?? siteHomeDeclaration());
  const host = new FakeInitHost(layout, { os: options.os ?? 'debian', ...(options.selinux ? { selinux: options.selinux } : {}) });
  host.seedDir(INIT_DIR);
  host.seedFile(V2_SAMPLE, V2_TEMPLATE, 0o600);
  host.seedFile(V1_SAMPLE, V1_TEMPLATE, 0o600);
  const calls: string[] = [];
  const edits: OperatorEditRequest[] = [];
  const seeds: MapSeedRequest[] = [];
  const behave = { apply: 0, verify: 'done' as 'done' | 'failed', pair: 'done' as 'done' | 'refused', bun: 'done' as 'done' | 'refused' | 'failed', problems: [] as string[], locks: 0 };
  const journal = openJournal(INIT_DIR, host, { now: () => new Date('2026-10-08T12:00:00.000Z'), run: '00000000000000aa' });
  const ports: ActPorts = {
    webEdit: {
      insertApacheReference: (text, instance, include) =>
        text.includes(`# dedalo-provision: ${instance} vhost_reference`)
          ? text
          : text.replace(/(<VirtualHost[^\n]*>\n)/, `$1# dedalo-provision: ${instance} vhost_reference\nIncludeOptional ${include}\n`),
      insertNginxReference: (text, instance, include) => text.replace(/(server \{\n)/, `$1# dedalo-provision: ${instance} vhost_reference\ninclude ${include.replace(/f$/, '[f]')};\n`),
      removeManualLines: (text, lines) => text.split('\n').filter((_, index) => !lines.includes(index + 1)).join('\n'),
    },
    editOperatorFile: request => {
      edits.push(request);
      return fakeTxn(host, layout, request);
    },
    seedNginxMap: request => {
      seeds.push(request);
      return { outcome: 'done' };
    },
    installBun: request => {
      calls.push(`installBun ${request.target}`);
      if (behave.bun !== 'done') return { outcome: behave.bun, reason: `bun ${behave.bun}` };
      host.writeBytesAtomic(request.target, new Uint8Array([1]), 0o755, 0, 0);
      host.bunVersions.set(request.target, request.pin);
      return { outcome: 'done' };
    },
    runApply: instance => {
      calls.push(`apply ${instance}`);
      return behave.apply;
    },
    declarationProblems: () => behave.problems,
    verifyAgent: () => {
      calls.push('verify');
      return { outcome: behave.verify, reason: 'the agent did not answer /health' };
    },
    pair: invocation => {
      calls.push(`pair ${invocation.name}`);
      return { outcome: behave.pair, reason: 'already registered. Use `replace`' };
    },
    pairPackage: action => {
      calls.push(`pairPackage ${action.name} ${action.path}`);
      return { outcome: behave.pair, reason: 'the engine bundle does not exist' };
    },
  };
  const ctx: ActContext = {
    instance: 'test',
    layout,
    initDir: INIT_DIR,
    io: host,
    exec: host.exec,
    journal,
    lstat: path => host.lstat(path),
    realpath: path => host.realpath(path),
    fsTypeOf: path => host.fsTypeOf(path),
    tree: { reader: host.treeReader, writer: host.treeWriter },
    webLock: (): LockHandle => {
      behave.locks += 1;
      calls.push('web-lock');
      return { path: '/x/web.lock', mode: 'ex', instance: null, release: () => calls.push('web-unlock') };
    },
    selinux: { mode: host.selinuxMode, types: SELINUX_TYPES, agentRuleRegistered: options.agentRule ?? false },
    family: host.os,
    secrets: options.secrets === false ? {} : { v2: V2_VALUES, v1: V1_VALUES },
    ports,
    sleepSync: () => {},
  };
  return { host, layout, ctx, calls, behave, edits, seeds, journalText: () => host.body(journal.path) ?? '' };
}

let counter = 0;
function item(action: InitAction, list: ItemList = 'change', id?: string): Item {
  counter += 1;
  return {
    id: id ?? `t.${action.kind}.${counter}`,
    list,
    area: 'host',
    title: action.kind,
    facts: [],
    commands: [],
    after: [],
    action,
    blocking: false,
    optional: false,
    operatorFile: false,
    hostWide: false,
  };
}

function phases(world: World, id: string): string[] {
  return decodeJournal(world.journalText()).records.filter(r => r.item === id).map(r => r.phase);
}

describe('executeItems decides nothing', () => {
  test('MUTATION: an item still in the decision list is REFUSED before anything runs', () => {
    const w = makeWorld();
    const report = executeItems([item({ kind: 'group_add', name: 'dedalo_pubhost' }), item({ kind: 'sebool', name: 'httpd_enable_homedirs', value: true, previous: false }, 'decision', 'selinux.home_traverse')], w.ctx);
    expect(report.exit).toBe(3);
    expect(report.outcomes).toEqual([{ item: 'selinux.home_traverse', status: 'refused', detail: 'still needs your decision — nothing was done' }]);
    expect(w.host.mutations).toBe(0);
    expect(w.host.groups.has('dedalo_pubhost')).toBe(true); // seeded; nothing else created
    expect(w.journalText()).toBe('');
  });

  test('right items and items without an action are passed over', () => {
    const w = makeWorld();
    const right = { ...item({ kind: 'group_add', name: 'newgroup' }), list: 'right' as const };
    const bare = { ...item({ kind: 'verify_agent' }) };
    delete (bare as { action?: InitAction }).action;
    const report = executeItems([right, bare], w.ctx);
    expect(report).toEqual({ ok: true, exit: 0, outcomes: [], stillToDo: [] });
    expect(w.host.groups.has('newgroup')).toBe(false);
  });
});

describe('accounts (§5.1)', () => {
  test('created when absent (begin → done), a noop when present; the nologin shell is the first real one', () => {
    for (const os of ['debian', 'el'] as const) {
      const w = makeWorld({ os });
      const items = [
        item({ kind: 'group_add', name: 'test_v2' }, 'change', 'account.v2_group'),
        item({ kind: 'user_add_own', name: 'test_agent' }, 'change', 'account.agent_user'),
        item({ kind: 'user_add_in', name: 'test_v2', group: 'test_v2' }, 'change', 'account.v2_user'),
        item({ kind: 'user_add_own', name: 'test_v1' }, 'change', 'account.v1_user'),
      ];
      expect(executeItems(items, w.ctx).exit).toBe(0);
      expect(w.host.users.has('test_agent') && w.host.users.has('test_v2') && w.host.users.has('test_v1')).toBe(true);
      expect(w.host.shells.get('test_agent')).toBe(os === 'debian' ? '/usr/sbin/nologin' : '/sbin/nologin');
      expect(w.host.accountGroups.get('test_v2')?.primary).toBe(w.host.groups.get('test_v2'));
      expect(phases(w, 'account.agent_user')).toEqual(['begin', 'done']);
      const again = executeItems(items, w.ctx);
      expect(again.outcomes.map(o => o.status)).toEqual(['noop', 'noop', 'noop', 'noop']);
      expect(w.calls.filter(c => c.startsWith('useradd'))).toEqual([]);
    }
  });

  test('a lost race (useradd exit 9) is re-observed; an unknown lookup stops the run', () => {
    const w = makeWorld();
    const racing = w.host.exec.userAddOwnGroup;
    (w.ctx as { exec: typeof w.host.exec }).exec = {
      ...w.host.exec,
      userAddOwnGroup: (name: string, shell: string) => {
        racing(name, shell); // another process created it first
        return { code: 9, stdout: '', stderr: 'exists' };
      },
    };
    expect(executeItems([item({ kind: 'user_add_own', name: 'racer' })], w.ctx).outcomes[0]?.status).toBe('noop');
    (w.ctx as { exec: typeof w.host.exec }).exec = { ...w.host.exec, groupLookup: () => ({ code: 1, stdout: '', stderr: 'nss down' }) };
    const report = executeItems([item({ kind: 'group_add', name: 'x' })], w.ctx);
    expect(report.exit).toBe(4);
    expect(report.outcomes[0]?.detail).toContain('cannot tell whether it exists');
  });

  test('a failing useradd is FAILED naming the exit; a missing group fails user_add_in', () => {
    const w = makeWorld();
    w.host.failOn = 'useradd broken';
    const report = executeItems([item({ kind: 'user_add_own', name: 'broken' }), item({ kind: 'group_add', name: 'later' })], w.ctx);
    expect(report.exit).toBe(4);
    expect(report.outcomes.map(o => o.status)).toEqual(['failed', 'not_reached']);
    expect(report.outcomes[0]?.detail).toContain('useradd broken exited 1');
    const w2 = makeWorld();
    expect(executeItems([item({ kind: 'user_add_in', name: 'u', group: 'absent' })], w2.ctx).outcomes[0]?.detail).toContain('exited 6');
  });

  test('no nologin shell on the host is a failure, not a login shell', () => {
    const w = makeWorld();
    w.host.entries.delete('/usr/sbin/nologin');
    expect(executeItems([item({ kind: 'user_add_own', name: 'u1' })], w.ctx).outcomes[0]?.detail).toContain('no nologin shell');
  });
});

describe('home.root and directories (§5.2)', () => {
  function homeWorld(): World {
    const w = makeWorld();
    w.host.seedDir(HOME);
    Object.assign(w.host.entries.get(HOME) as object, { uid: 1001, gid: 1001, mode: 0o700 });
    return w;
  }
  const homeRoot = (): Item => item({ kind: 'path_meta', path: HOME, uid: 0, gid: 0, mode: 0o755 }, 'change', 'home.root');

  test('given to root through the io doors; the previous owner/mode are journaled; a re-run is a noop', () => {
    const w = homeWorld();
    expect(executeItems([homeRoot()], w.ctx).exit).toBe(0);
    expect(w.host.lstat(HOME)).toEqual({ type: 'dir', uid: 0, gid: 0, mode: 0o755 });
    const done = decodeJournal(w.journalText()).records.find(r => r.phase === 'done');
    expect(done?.detail.previous).toEqual({ uid: 1001, gid: 1001, mode: 0o700 });
    const before = w.host.mutations;
    expect(executeItems([homeRoot()], w.ctx).outcomes[0]?.status).toBe('noop');
    expect(w.host.mutations - before).toBe(2); // the journal's own append + nothing else on the home
  });

  test('refused: a symlinked home, a non-root /home, a network filesystem — nothing changed', () => {
    const cases: [string, (w: World) => void, string][] = [
      ['symlink', w => w.host.seedLink(HOME, '/srv/elsewhere', '/srv/elsewhere'), 'symbolic link'],
      ['/home not root', w => Object.assign(w.host.entries.get('/home') as object, { uid: 1000 }), 'not a root-owned directory'],
      ['/home other-writable', w => Object.assign(w.host.entries.get('/home') as object, { mode: 0o777 }), 'not a root-owned directory'],
      ['nfs4', w => w.host.mounts.push({ mountPoint: '/home', fsType: 'nfs4', readOnly: false, noexec: false, seclabel: false, context: null }), 'network filesystem (nfs4)'],
      ['fuse', w => w.host.mounts.push({ mountPoint: HOME, fsType: 'fuse.sshfs', readOnly: false, noexec: false, seclabel: false, context: null }), 'network filesystem'],
    ];
    for (const [, plant, why] of cases) {
      const w = homeWorld();
      plant(w);
      const report = executeItems([homeRoot()], w.ctx);
      expect(report.exit).toBe(3);
      expect(report.outcomes[0]?.detail).toContain(why);
      expect(w.host.calls.filter(c => c === `chown ${HOME}` || c === `chmod ${HOME}`)).toEqual([]);
    }
    const w = makeWorld();
    w.host.removeTree(HOME, '/home');
    expect(executeItems([homeRoot()], w.ctx).outcomes[0]?.detail).toContain('does not exist');
    w.host.seedFile(HOME, '');
    expect(executeItems([homeRoot()], w.ctx).outcomes[0]?.detail).toContain('not a directory');
  });

  test('MUTATION: home.root is exactly root:root HOME_ROOT_MODE on the site home — nothing else', () => {
    for (const action of [
      { kind: 'path_meta' as const, path: HOME, uid: 0, gid: 0, mode: 0o777 },
      { kind: 'path_meta' as const, path: HOME, uid: 1001, gid: 0, mode: 0o755 },
      { kind: 'path_meta' as const, path: '/home', uid: 0, gid: 0, mode: 0o755 },
    ]) {
      const w = homeWorld();
      const report = executeItems([item(action, 'change', 'home.root')], w.ctx);
      expect(report.exit).toBe(3);
      expect(report.outcomes[0]?.detail).toBe(`home.root must make the site home ${HOME} root:root 0755, nothing else`);
      expect(w.host.lstat(HOME)?.uid).toBe(1001);
    }
    expect(HOME_ROOT_MODE).toBe(0o755);
  });

  test('MUTATION: a later failure leaves the home as requested and prints the restoring command under "still to do"', () => {
    const w = homeWorld();
    w.behave.apply = 4;
    const report = executeItems([homeRoot(), item({ kind: 'provision_apply', instance: 'test' })], w.ctx);
    expect(report.exit).toBe(4);
    expect(w.host.lstat(HOME)?.uid).toBe(0);
    expect(report.stillToDo).toEqual([`chown 1001:1001 '${HOME}' && chmod 0700 '${HOME}'`]);
  });

  test('mkdir creates root-owned; never chowns an existing directory with other metadata', () => {
    const w = makeWorld();
    w.host.seedDir(HOME);
    const logs = item({ kind: 'mkdir', path: `${HOME}/logs`, uid: 0, gid: 0, mode: 0o755 }, 'change', 'home.dirs');
    expect(executeItems([logs], w.ctx).exit).toBe(0);
    expect(w.host.lstat(`${HOME}/logs`)).toEqual({ type: 'dir', uid: 0, gid: 0, mode: 0o755 });
    expect(executeItems([logs], w.ctx).outcomes[0]?.status).toBe('noop');
    Object.assign(w.host.entries.get(`${HOME}/logs`) as object, { uid: 1001 });
    const report = executeItems([logs], w.ctx);
    expect(report.exit).toBe(3);
    expect(report.outcomes[0]?.detail).toContain('never changed by init');
    expect(w.host.lstat(`${HOME}/logs`)?.uid).toBe(1001);
  });
});

describe('SELinux booleans (§5.3)', () => {
  const relay = (): Item => item({ kind: 'sebool', name: 'httpd_can_network_relay', value: true, previous: false }, 'change', 'selinux.proxy_connect');

  test('set with its previous value journaled; a noop when already set', () => {
    const w = makeWorld({ os: 'el' });
    expect(executeItems([relay()], w.ctx).exit).toBe(0);
    expect(w.host.booleans.get('httpd_can_network_relay')).toBe(true);
    expect(decodeJournal(w.journalText()).records.at(-1)?.detail).toEqual({ name: 'httpd_can_network_relay', value: true, previous: false });
    expect(executeItems([relay()], w.ctx).outcomes[0]?.status).toBe('noop');
    expect(w.calls.filter(c => c.startsWith('setsebool'))).toEqual([]);
    expect(w.host.calls.filter(c => c.startsWith('setsebool'))).toHaveLength(1);
  });

  test('read-only httpd_graceful_shutdown is refused; a failing setsebool is FAILED; a later failure prints the restoring setsebool', () => {
    const w = makeWorld({ os: 'el' });
    const readOnly = executeItems([item({ kind: 'sebool', name: 'httpd_graceful_shutdown', value: false, previous: true })], w.ctx);
    expect(readOnly.exit).toBe(3);
    expect(readOnly.outcomes[0]?.detail).toBe("'httpd_graceful_shutdown' is read, never written");
    expect(w.host.calls.some(c => c.startsWith('getsebool httpd_graceful') || c.startsWith('setsebool'))).toBe(false);
    w.host.failOn = 'setsebool -P httpd_can_network_relay on';
    const failed = executeItems([relay()], w.ctx);
    expect(failed.exit).toBe(4);
    expect(failed.outcomes[0]?.detail).toContain('exited 1');
    w.host.failOn = null;
    w.behave.verify = 'failed';
    const later = executeItems([relay(), item({ kind: 'verify_agent' })], w.ctx);
    expect(later.stillToDo).toEqual(['setsebool -P httpd_can_network_relay off']);
  });

  test('an unreadable boolean is a failure; readSebool parses only its own line', () => {
    const w = makeWorld({ os: 'el' });
    w.host.booleans.delete('httpd_use_nfs');
    expect(executeItems([item({ kind: 'sebool', name: 'httpd_use_nfs', value: true, previous: false })], w.ctx).outcomes[0]?.detail).toContain('gave no value');
    expect(readSebool({ getsebool: () => ({ code: 0, stdout: 'other_bool --> on\n', stderr: '' }) } as never, 'httpd_use_nfs')).toBeNull();
  });
});

describe('fcontext_relocate (§5.2)', () => {
  const oldRules = [
    { spec: '/home/example\\.org/dedalo/publication_api/v1(/.*)?', type: 'httpd_sys_content_t' },
    { spec: '/home/example\\.org/\\.bun/bin/bun', type: 'bin_t' },
    { spec: '/home/example\\.org', type: 'home_root_t' },
  ];

  test('-d lines with the right file type go through one import; the old paths that still exist are relabelled', () => {
    const w = makeWorld({ os: 'el' });
    w.host.importRules(relocationLines(oldRules, SELINUX_TYPES).map(l => l.replace(' -d ', ' -a ')).join('\n'));
    expect(w.host.fcontext).toHaveLength(3);
    w.host.seedDir(`${HOME}/dedalo/publication_api/v1`);
    const report = executeItems([item({ kind: 'fcontext_relocate', remove: oldRules }, 'change', 'declaration.layout')], w.ctx);
    expect(report.exit).toBe(0);
    expect(w.host.fcontext).toEqual([]);
    expect(w.host.calls).toContain('semanage import /etc/dedalo_publication_host/test/selinux.import.dedalo-provision.tmp');
    expect(w.host.calls).toContain(`restorecon -R ${HOME}/dedalo/publication_api/v1 ${HOME}/.bun/bin/bun ${HOME}`);
    expect(w.journalText()).toContain('"remove":[');
    expect(w.host.entries.has('/etc/dedalo_publication_host/test/selinux.import.dedalo-provision.tmp')).toBe(false);
    expect(relocationLines(oldRules, SELINUX_TYPES)).toEqual([
      "fcontext -d -f a -t httpd_sys_content_t '/home/example\\.org/dedalo/publication_api/v1(/.*)?'",
      "fcontext -d -f f -t bin_t '/home/example\\.org/\\.bun/bin/bun'",
      "fcontext -d -f d -t home_root_t '/home/example\\.org'",
    ]);
  });

  test('disabled with the store: import only, no restorecon; absent: a noop', () => {
    const w = makeWorld({ os: 'el', selinux: 'disabled' });
    w.host.seedDir(HOME);
    executeItems([item({ kind: 'fcontext_relocate', remove: oldRules })], w.ctx);
    expect(w.host.calls.some(c => c.startsWith('semanage import'))).toBe(true);
    expect(w.host.calls.some(c => c.startsWith('restorecon'))).toBe(false);
    const a = makeWorld({ selinux: 'absent' });
    expect(executeItems([item({ kind: 'fcontext_relocate', remove: oldRules })], a.ctx).outcomes[0]?.status).toBe('noop');
  });

  test('the closed grammar: a foreign type, a broad path, a quote — refused before anything is written', () => {
    const w = makeWorld({ os: 'el' });
    for (const [rules, why] of [
      [[{ spec: '/srv/x(/.*)?', type: 'shadow_t' }], 'not one of ours'],
      [[{ spec: '/home', type: 'usr_t' }], "refusing a rule on '/home'"],
      [[{ spec: "/srv/x'y", type: 'usr_t' }], 'outside the label grammar'],
      [[{ spec: '/srv/../etc', type: 'usr_t' }], 'outside the label grammar'],
    ] as const) {
      const report = executeItems([item({ kind: 'fcontext_relocate', remove: rules })], w.ctx);
      expect(report.exit).toBe(3);
      expect(report.outcomes[0]?.detail).toContain(why);
    }
    expect(w.host.calls.some(c => c.startsWith('writeTemp'))).toBe(false);
    w.host.failOn = 'semanage import /etc/dedalo_publication_host/test/selinux.import.dedalo-provision.tmp';
    expect(executeItems([item({ kind: 'fcontext_relocate', remove: oldRules })], w.ctx).outcomes[0]?.detail).toContain('semanage import exited 1');
    expect(w.host.entries.has('/etc/dedalo_publication_host/test/selinux.import.dedalo-provision.tmp')).toBe(false);
  });

  test('specPath / relocationFileType', () => {
    expect(specPath('/a\\.b(/.*)?')).toEqual({ path: '/a.b', recursive: true });
    expect(specPath('/a/b')).toEqual({ path: '/a/b', recursive: false });
    expect(relocationFileType({ spec: '/x', type: 'usr_t' })).toBe('d');
  });
});

describe('Bun (§5.4) and agent code (§5.5)', () => {
  const bun = (): Item =>
    item({ kind: 'bun_install', archive: `${INIT_DIR}/stage/bun/bun-linux-x64.zip`, sums: null, asset: 'bun-linux-x64', pin: '1.4.3', table: '# bun-v1.4.3', target: `${HOME}/.bun/bin/bun` }, 'change', 'bun.install');

  test('installed through the P5 port and re-verified; a noop at the pin; refusals and failures propagate', () => {
    const w = makeWorld();
    expect(executeItems([bun()], w.ctx).exit).toBe(0);
    expect(w.calls).toEqual([`installBun ${HOME}/.bun/bin/bun`]);
    expect(executeItems([bun()], w.ctx).outcomes[0]?.status).toBe('noop');
    const r = makeWorld();
    r.behave.bun = 'refused';
    expect(executeItems([bun()], r.ctx).exit).toBe(3);
    const f = makeWorld();
    f.behave.bun = 'failed';
    expect(executeItems([bun()], f.ctx).exit).toBe(4);
    const wrong = makeWorld();
    (wrong.ctx.ports as { installBun: ActPorts['installBun'] }).installBun = req => {
      wrong.host.writeBytesAtomic(req.target, new Uint8Array([1]), 0o755, 0, 0);
      wrong.host.bunVersions.set(req.target, '1.3.0');
      return { outcome: 'done' };
    };
    expect(executeItems([bun()], wrong.ctx).outcomes[0]?.detail).toContain('not the pin 1.4.3');
  });

  const SRC = `${INIT_DIR}/stage/source/publication/host_agent`;
  const DST = `${HOME}/host_agent`;
  function codeWorld(options: { selinux?: 'enforcing'; agentRule?: boolean } = {}): World {
    const w = makeWorld({ os: options.selinux ? 'el' : 'debian', ...(options.agentRule ? { agentRule: true } : {}) });
    w.host.removeTree(DST, HOME); // the base FakeHost seeds agent_dir's entry point: start from no tree
    w.host.seedFile(`${SRC}/package.json`, '{}');
    w.host.seedFile(`${SRC}/src/index.ts`, 'export {};\n');
    w.host.seedDir(HOME);
    return w;
  }
  const code = (w: World): Item => item({ kind: 'code_install', src: SRC, dst: DST, digest: treeDigest(SRC, w.host.treeReader) }, 'change', 'code.install');

  test('installed, kept as .prev until the restart succeeds, then committed', () => {
    const w = codeWorld();
    w.host.seedFile(`${DST}/old.ts`, 'old');
    const restart = item({ kind: 'unit_restart', units: ['dedalo-publication-host-test'] }, 'change', 'provision.restart');
    const report = executeItems([code(w), restart], w.ctx);
    expect(report.exit).toBe(0);
    expect(w.host.body(`${DST}/src/index.ts`)).toBe('export {};\n');
    expect(w.host.lstat(prevPathOf(DST))).toBeNull();
    expect(w.host.lstat(`${DST}/old.ts`)).toBeNull();
    expect(executeItems([code(w)], w.ctx).outcomes[0]?.status).toBe('noop');
  });

  test('MUTATION: a later failure before the restart puts the previous tree back', () => {
    const w = codeWorld();
    w.host.seedFile(`${DST}/old.ts`, 'old');
    w.behave.apply = 4;
    const report = executeItems([code(w), item({ kind: 'provision_apply', instance: 'test' }, 'change', 'provision.apply')], w.ctx);
    expect(report.exit).toBe(4);
    expect(w.host.body(`${DST}/old.ts`)).toBe('old');
    expect(w.host.lstat(`${DST}/src/index.ts`)).toBeNull();
    expect(w.host.lstat(prevPathOf(DST))).toBeNull();
    expect(phases(w, 'code.install')).toEqual(['begin', 'done', 'rolled_back']);
  });

  test('a restart that fails is FAILED naming journalctl, and the tree goes back', () => {
    const w = codeWorld();
    w.host.seedFile(`${DST}/old.ts`, 'old');
    w.host.restartFails.add('dedalo-publication-host-test');
    const report = executeItems([code(w), item({ kind: 'unit_restart', units: ['dedalo-publication-host-test'] })], w.ctx);
    expect(report.exit).toBe(4);
    expect(report.outcomes[1]?.detail).toContain('journalctl -u dedalo-publication-host-test --since -2min -o cat');
    expect(w.host.body(`${DST}/old.ts`)).toBe('old');
    w.host.failOn = 'restart x';
    expect(executeItems([item({ kind: 'unit_restart', units: ['x'] })], w.ctx).outcomes[0]?.detail).toContain('systemctl restart x exited 1');
  });

  test('SELinux with the agent rule registered: restorecon -R right after the swap', () => {
    const w = codeWorld({ selinux: 'enforcing', agentRule: true });
    expect(executeItems([code(w)], w.ctx).exit).toBe(0);
    expect(w.host.calls).toContain(`restorecon -R ${DST}`);
    const n = codeWorld();
    executeItems([code(n)], n.ctx);
    expect(n.host.calls.some(c => c.startsWith('restorecon'))).toBe(false);
    const f = codeWorld({ selinux: 'enforcing', agentRule: true });
    f.host.seedFile(`${DST}/old.ts`, 'old');
    f.host.failOn = `restorecon -R ${DST}`;
    expect(executeItems([code(f)], f.ctx).exit).toBe(4);
    expect(f.host.body(`${DST}/old.ts`)).toBe('old');
  });

  test('a source that changed since compare is refused (installTree’s digest)', () => {
    const w = codeWorld();
    const shown = code(w);
    w.host.seedFile(`${SRC}/src/index.ts`, 'tampered');
    const report = executeItems([shown], w.ctx);
    expect(report.exit).toBe(4);
    expect(report.outcomes[0]?.detail).toContain('changed since it was compared');
    expect(w.host.lstat(DST)).toBeNull();
    expect(w.host.lstat(newPathOf(DST))).toBeNull();
  });
});

describe('the declaration (§5.6), apply (§5.7), B4/B5', () => {
  const BODY = canonicalDeclaration(siteHomeDeclaration());
  test('written 0644 root after validation; a noop when identical; refused when it would not validate', () => {
    const w = makeWorld();
    w.host.entries.delete('/etc/dedalo_publication_host');
    const write = (): Item => item({ kind: 'write_declaration', body: BODY }, 'change', 'declaration.write');
    expect(executeItems([write()], w.ctx).exit).toBe(0);
    expect(w.host.body('/etc/dedalo_publication_host/test.json')).toBe(BODY);
    expect(w.host.lstat('/etc/dedalo_publication_host')).toEqual({ type: 'dir', uid: 0, gid: 0, mode: 0o755 });
    expect(w.host.lstat('/etc/dedalo_publication_host/test.json')?.mode).toBe(0o644);
    expect(executeItems([write()], w.ctx).outcomes[0]?.status).toBe('noop');
    w.behave.problems = ["site.domain: 'x' must match …"];
    const other = canonicalDeclaration(siteHomeDeclaration({ v2: { ...siteHomeDeclaration().v2, port: 3101 } }));
    const refused = executeItems([item({ kind: 'write_declaration', body: other })], w.ctx);
    expect(refused.exit).toBe(3);
    expect(w.host.body('/etc/dedalo_publication_host/test.json')).toBe(BODY);
  });

  test('MUTATION: a body that is not canonicalDeclaration() output is refused (one body writer)', () => {
    const w = makeWorld();
    for (const body of [JSON.stringify(siteHomeDeclaration()), `${BODY}\n`, 'not json']) {
      const report = executeItems([item({ kind: 'write_declaration', body })], w.ctx);
      expect(report.exit).toBe(3);
      expect(report.outcomes[0]?.detail).toBe('the declaration body is not canonicalDeclaration() output');
    }
    expect(w.host.calls.some(c => c.startsWith('writeBytesAtomic /etc/dedalo_publication_host/test.json'))).toBe(false);
  });

  test('provision apply: 0 done, 3 REFUSED, anything else FAILED', () => {
    for (const [code, exit] of [[0, 0], [3, 3], [4, 4], [1, 4]] as const) {
      const w = makeWorld();
      w.behave.apply = code;
      expect(executeItems([item({ kind: 'provision_apply', instance: 'test' })], w.ctx).exit).toBe(exit);
    }
  });

  test('verify and pair go through their ports; a refusal is REFUSED', () => {
    const w = makeWorld();
    const invocation = { user: 'dedalo', bun: '/usr/local/bin/bun', checkout: '/opt/dedalo', verb: 'add' as const, name: 'test', fragment: '/etc/x.json', dryRun: false, env: {} };
    expect(executeItems([item({ kind: 'verify_agent' }), item({ kind: 'pair', invocation })], w.ctx).exit).toBe(0);
    expect(w.calls).toEqual(['verify', 'pair test']);
    w.behave.pair = 'refused';
    expect(executeItems([item({ kind: 'pair', invocation })], w.ctx).exit).toBe(3);
    w.behave.verify = 'failed';
    expect(executeItems([item({ kind: 'verify_agent' })], w.ctx).outcomes[0]?.detail).toBe('the agent did not answer /health');
  });

  test('the sealed package goes through its port; the journal records the name and path only', () => {
    const w = makeWorld();
    const action = { kind: 'pair_package' as const, name: 'test', path: `${INIT_DIR}/test.pairing` };
    expect(executeItems([item(action)], w.ctx).exit).toBe(0);
    expect(w.calls).toEqual([`pairPackage test ${INIT_DIR}/test.pairing`]);
    w.behave.pair = 'refused';
    expect(executeItems([item(action)], w.ctx).exit).toBe(3);
  });
});

describe('API config (§5.8)', () => {
  const v2Path = `${HOME}/dedalo/publication_api/v2/shared/v2.env`;
  const v1Path = `${HOME}/dedalo/publication_api/v1/shared/server_config_api.php`;
  function apiWorld(secrets = true): World {
    const w = makeWorld({ secrets });
    w.host.seedDir(`${HOME}/dedalo/publication_api/v2/shared`);
    w.host.seedDir(`${HOME}/dedalo/publication_api/v1/shared`);
    w.host.groups.set('test_v2', 3001);
    w.host.users.set('test_v1', 3002);
    return w;
  }
  const v2 = (): Item => item({ kind: 'v2_env', sample: V2_SAMPLE, path: v2Path, deploymentMode: 'nginx', socket: '/run/mysqld/mysqld.sock' }, 'change', 'api_config.v2_env');
  const v1 = (transport: 'socket' | 'tcp' = 'socket'): Item => item({ kind: 'v1_config', sample: V1_SAMPLE, path: v1Path, owner: 'test_v1', transport, socket: '/run/mysqld/mysqld.sock' }, 'change', 'api_config.v1_config');

  test('rendered from the template, written with the MODES rows; the action’s deployment mode wins', () => {
    const w = apiWorld();
    expect(executeItems([v2(), v1()], w.ctx).exit).toBe(0);
    expect(w.host.lstat(v2Path)).toEqual({ type: 'file', uid: 0, gid: 3001, mode: 0o640 });
    expect(w.host.lstat(v1Path)).toEqual({ type: 'file', uid: 3002, gid: 0, mode: 0o400 });
    expect(w.host.body(v2Path)).toContain("DEPLOYMENT_MODE='nginx'");
    expect(w.host.body(v2Path)).toContain(`DB_PASSWORD='${PASSWORD}'`);
    expect(w.host.body(v1Path)).toContain(`define('API_WEB_USER_CODE', '${CODE}');`);
  });

  test('S3-1: each write states the shared/ directory it expects — the MODES row (v2Shared root:<v2 group> 0750, v1Shared root:root 0711)', () => {
    const w = apiWorld();
    expect(executeItems([v2(), v1()], w.ctx).exit).toBe(0);
    expect(w.host.pins.get(`writeBytesAtomic ${v2Path}`)).toEqual({ parent: `${HOME}/dedalo/publication_api/v2/shared`, uid: 0, gid: 3001, mode: 0o750 });
    expect(w.host.pins.get(`writeBytesAtomic ${v1Path}`)).toEqual({ parent: `${HOME}/dedalo/publication_api/v1/shared`, uid: 0, gid: 0, mode: 0o711 });
  });

  test('S3-1: a drifted API config file is fixed through the same pin (the one FILE path_meta takes); any other file is refused', () => {
    const w = apiWorld();
    w.host.seedFile(v2Path, 'OPERATOR=1\n', 0o644, 0, 0);
    const fix = item({ kind: 'path_meta', path: v2Path, uid: 0, gid: 3001, mode: 0o640 }, 'change', 'api_config.v2_env');
    expect(executeItems([fix], w.ctx).exit).toBe(0);
    expect(w.host.lstat(v2Path)).toEqual({ type: 'file', uid: 0, gid: 3001, mode: 0o640 });
    expect(w.host.pins.get(`chmod ${v2Path}`)).toEqual({ parent: `${HOME}/dedalo/publication_api/v2/shared`, uid: 0, gid: 3001, mode: 0o750 });
    const other = apiWorld();
    other.host.seedFile(`${HOME}/dedalo/x.txt`, 'x', 0o644, 0, 0);
    const wrong = item({ kind: 'path_meta', path: `${HOME}/dedalo/x.txt`, uid: 0, gid: 0, mode: 0o600 }, 'change', 'api_config.v2_env');
    expect(executeItems([wrong], other.ctx).outcomes[0]?.detail).toContain('not a directory');
  });

  test('MUTATION: the password and the user code never reach the journal, the calls or a digest', () => {
    const w = apiWorld();
    executeItems([v2(), v1()], w.ctx);
    const journal = w.journalText();
    for (const secret of [PASSWORD, CODE]) {
      expect(journal).not.toContain(secret);
      expect(w.host.calls.join('\n')).not.toContain(secret);
      expect(w.calls.join('\n')).not.toContain(secret);
    }
    const records = decodeJournal(journal).records.filter(r => r.item.startsWith('api_config.'));
    expect(records.map(r => r.phase)).toEqual(['begin', 'done', 'begin', 'done']);
    for (const r of records) expect(Object.keys(r.detail).some(k => /sha|digest/i.test(k))).toBe(false);
    expect(records[1]?.detail).toEqual({ path: v2Path, exists: true, uid: 0, gid: 3001, mode: 0o640 });
  });

  test('an existing file is never overwritten', () => {
    const w = apiWorld();
    w.host.seedFile(v2Path, 'OPERATOR=1\n', 0o640, 0, 3001);
    expect(executeItems([v2()], w.ctx).outcomes[0]?.status).toBe('noop');
    expect(w.host.body(v2Path)).toBe('OPERATOR=1\n');
  });

  test('no values typed (no TTY) → REFUSED writing nothing; a bad value → REFUSED naming the field, not the value', () => {
    const w = apiWorld(false);
    const report = executeItems([v2()], w.ctx);
    expect(report.exit).toBe(3);
    expect(report.outcomes[0]?.detail).toContain('a secret step needs a terminal');
    expect(w.host.lstat(v2Path)).toBeNull();
    const w2 = apiWorld(false);
    expect(executeItems([v1()], w2.ctx).exit).toBe(3);
    const bad = apiWorld();
    (bad.ctx as { secrets: ActContext['secrets'] }).secrets = { v2: { ...V2_VALUES, password: `bad'quote1` } };
    const refused = executeItems([v2()], bad.ctx);
    expect(refused.exit).toBe(3);
    expect(refused.outcomes[0]?.detail).toContain('DB_PASSWORD');
    expect(refused.outcomes[0]?.detail).not.toContain(`bad'quote1`);
    expect(bad.journalText()).not.toContain('quote1');
  });

  test('a missing template, a missing group or owner fail loudly', () => {
    const w = apiWorld();
    w.host.entries.delete(V2_SAMPLE);
    expect(executeItems([v2()], w.ctx).outcomes[0]?.detail).toContain('re-run deploy/install.sh with --source');
    const g = apiWorld();
    g.host.groups.delete('test_v2');
    expect(executeItems([v2()], g.ctx).outcomes[0]?.detail).toContain("group 'test_v2' has no id");
    const u = apiWorld();
    u.host.users.delete('test_v1');
    (u.ctx as { secrets: ActContext['secrets'] }).secrets = { v1: { ...V1_VALUES, port: '3306' } };
    expect(executeItems([v1('tcp')], u.ctx).outcomes[0]?.detail).toContain("user 'test_v1' has no id");
  });
});

describe('Apache modules (§5.9, Debian only)', () => {
  const mods = (): Item => item({ kind: 'apache_modules', mods: ['rewrite', 'proxy_fcgi'] }, 'change', 'web.modules');

  test('a2enmod, configtest, reload, under the host web lock', () => {
    const w = makeWorld();
    expect(executeItems([mods()], w.ctx).exit).toBe(0);
    expect(w.host.apacheMods.has('rewrite')).toBe(true);
    expect(w.host.calls.filter(c => /a2enmod|configtest|reload/.test(c))).toEqual(['a2enmod rewrite proxy_fcgi', 'configtest apache', 'reload apache2']);
    expect(w.calls).toEqual(['web-lock', 'web-unlock']);
  });

  test('MUTATION: a failing configtest → a2dismod + a second configtest, no reload, rolled back', () => {
    const w = makeWorld();
    w.host.configtestBreakers.push('ServerName example.org');
    w.host.seedFile('/etc/apache2/sites-enabled/x.conf', 'ServerName example.org');
    const report = executeItems([mods()], w.ctx);
    expect(report.exit).toBe(4);
    expect(report.outcomes[0]?.status).toBe('rolled_back');
    expect(w.host.apacheMods.has('rewrite')).toBe(false);
    expect(w.host.calls.filter(c => /a2(en|dis)mod|configtest|reload/.test(c))).toEqual(['a2enmod rewrite proxy_fcgi', 'configtest apache', 'a2dismod rewrite proxy_fcgi', 'configtest apache']);
    expect(w.calls).toEqual(['web-lock', 'web-unlock']);
  });

  test('MUTATION: the web master dying on reload (the EL AVC case) → undo, configtest, restart, rolled back', () => {
    const w = makeWorld();
    w.host.reloadKills.add('apache2');
    const report = executeItems([mods()], w.ctx);
    expect(report.outcomes[0]?.status).toBe('rolled_back');
    expect(report.outcomes[0]?.detail).toContain('was not active after the reload');
    expect(w.host.calls.filter(c => /a2(en|dis)mod|configtest|reload|restart/.test(c))).toEqual([
      'a2enmod rewrite proxy_fcgi',
      'configtest apache',
      'reload apache2',
      'a2dismod rewrite proxy_fcgi',
      'configtest apache',
      'restart apache2',
    ]);
    expect(w.host.units.get('apache2')?.active).toBe(true);
  });

  test('EL is refused (conf.modules.d is the operator’s); nothing to enable is a noop; a2enmod failing is FAILED', () => {
    const el = makeWorld({ os: 'el' });
    expect(executeItems([mods()], el.ctx).exit).toBe(3);
    expect(el.host.calls.some(c => c.startsWith('a2enmod'))).toBe(false);
    const w = makeWorld();
    expect(executeItems([item({ kind: 'apache_modules', mods: [] })], w.ctx).outcomes[0]?.status).toBe('noop');
    w.host.failOn = 'a2enmod rewrite proxy_fcgi';
    expect(executeItems([mods()], w.ctx).outcomes[0]?.detail).toContain('a2enmod exited 1');
    const nginx = makeWorld({ decl: siteHomeDeclaration({ web: { server: 'nginx', unit: 'nginx' } }) });
    expect(executeItems([mods()], nginx.ctx).outcomes[0]?.detail).toContain('non-apache');
  });
});

describe('operator files (§5.10)', () => {
  function vhostWorld(): World {
    const w = makeWorld();
    w.host.seedFile(VHOST, VHOST_TEXT);
    return w;
  }
  const reference = (beforeSha = sha(VHOST_TEXT)): Item => item({ kind: 'vhost_reference', path: VHOST, beforeSha, server: 'apache', edit: 'reference', line: 2 }, 'change', 'web.vhost.0a1b2c3d');

  test('act computes `after` from the RE-READ bytes and hands the transaction a journaled backup path', () => {
    const w = vhostWorld();
    expect(executeItems([reference()], w.ctx).exit).toBe(0);
    const [request] = w.edits;
    expect(request?.target).toBe(VHOST);
    expect(request?.backup).toBe(`${INIT_DIR}/backup/1-example.org-le-ssl.conf`);
    expect(Buffer.from(request?.after ?? []).toString()).toContain('IncludeOptional /etc/dedalo_publication_host/test/web.apache.conf');
    expect(request?.afterSha).toBe(sha(request?.after ?? new Uint8Array()));
    expect(w.host.lstat(`${INIT_DIR}/backup`)?.mode).toBe(0o700);
    const begin = decodeJournal(w.journalText()).records.find(r => r.phase === 'begin');
    expect(begin?.detail).toMatchObject({ target: VHOST, backup: request?.backup, beforeSha: sha(VHOST_TEXT), afterSha: request?.afterSha });
    expect(phases(w, 'web.vhost.0a1b2c3d')).toEqual(['begin', 'done']);
    // Idempotent: the reference is there now → after === before → a noop, no transaction.
    const now = w.host.readOperatorFile(VHOST).sha;
    expect(executeItems([reference(now)], w.ctx).outcomes[0]?.status).toBe('noop');
    expect(w.edits).toHaveLength(1);
  });

  test('a file holding two vhosts (a :80 redirect and the TLS one): the edit lands in the one compare named', () => {
    const w = makeWorld();
    const two = '<VirtualHost *:80>\n  Redirect / https://example.org/\n</VirtualHost>\n<VirtualHost *:443>\n  ServerName example.org\n</VirtualHost>\n';
    w.host.seedFile(VHOST, two);
    // The REAL web_edit (the stub above edits the first opener): it refuses a two-opener file without atLine.
    const ctx = { ...w.ctx, ports: { ...w.ctx.ports, webEdit: { insertApacheReference, insertNginxReference, removeManualLines } } };
    expect(executeItems([item({ kind: 'vhost_reference', path: VHOST, beforeSha: sha(two), server: 'apache', edit: 'reference', line: 4 })], ctx).exit).toBe(0);
    const after = Buffer.from(w.edits[0]?.after ?? []).toString().split('\n');
    expect(after[3]).toBe('<VirtualHost *:443>');
    expect(after[5]).toBe('    IncludeOptional /etc/dedalo_publication_host/test/web.apache.conf');
    expect(after.slice(0, 3).join('\n')).not.toContain('IncludeOptional');
  });

  test('address-family twins in ONE file (alsoLines): one edit, one transaction, the include after EACH opener — bottom-up, idempotent', () => {
    const w = makeWorld();
    const twins = '<VirtualHost 0.0.0.0:443>\n  ServerName example.org\n</VirtualHost>\n<VirtualHost [::]:443>\n  ServerName example.org\n</VirtualHost>\n';
    w.host.seedFile(VHOST, twins);
    const ctx = { ...w.ctx, ports: { ...w.ctx.ports, webEdit: { insertApacheReference, insertNginxReference, removeManualLines } } };
    const twinItem = (beforeSha: string, also: number) => item({ kind: 'vhost_reference', path: VHOST, beforeSha, server: 'apache', edit: 'reference', line: 1, alsoLines: [also] }, 'change', 'web.vhost.0a1b2c3d');
    expect(executeItems([twinItem(sha(twins), 4)], ctx).exit).toBe(0);
    expect(w.edits).toHaveLength(1);
    const after = Buffer.from(w.edits[0]?.after ?? []).toString().split('\n');
    expect(after.filter(line => line.trim() === 'IncludeOptional /etc/dedalo_publication_host/test/web.apache.conf')).toHaveLength(2);
    // Each include sits right after its own opener (the second opener moved down by the first insertion).
    expect([after[0], after[2], after[5], after[7]]).toEqual([
      '<VirtualHost 0.0.0.0:443>',
      '    IncludeOptional /etc/dedalo_publication_host/test/web.apache.conf',
      '<VirtualHost [::]:443>',
      '    IncludeOptional /etc/dedalo_publication_host/test/web.apache.conf',
    ]);
    // Both present now (a re-run names the openers where they now stand, 1 and 6): a noop, no second transaction.
    expect(executeItems([twinItem(w.host.readOperatorFile(VHOST).sha, 6)], ctx).outcomes[0]?.status).toBe('noop');
    expect(w.edits).toHaveLength(1);
  });

  test('MUTATION: TOCTOU — a file changed since shown is never edited', () => {
    const w = vhostWorld();
    const shown = reference();
    w.host.seedFile(VHOST, `${VHOST_TEXT}# edited meanwhile\n`);
    const report = executeItems([shown], w.ctx);
    expect(report.exit).toBe(4);
    expect(report.outcomes[0]?.detail).toContain('changed since shown; re-run');
    expect(w.edits).toEqual([]);
    const gone = vhostWorld();
    gone.host.entries.delete(VHOST);
    expect(executeItems([reference()], gone.ctx).outcomes[0]?.detail).toContain('does not resolve');
  });

  test('edited at its realpath: a symlinked sites-enabled entry is followed by realpath only, then re-read', () => {
    const w = vhostWorld();
    w.host.seedLink('/etc/apache2/sites-enabled/example.conf', '../sites-available/example.org-le-ssl.conf', VHOST);
    executeItems([item({ kind: 'vhost_reference', path: '/etc/apache2/sites-enabled/example.conf', beforeSha: sha(VHOST_TEXT), server: 'apache', edit: 'reference', line: 2 })], w.ctx);
    expect(w.edits[0]?.target).toBe(VHOST);
  });

  test('a rolled-back transaction is FAILED with its exits journaled; manual-line removal uses the given lines', () => {
    const w = vhostWorld();
    w.host.configtestBreakers.push('IncludeOptional /etc/dedalo_publication_host');
    const report = executeItems([reference()], w.ctx);
    expect(report.exit).toBe(4);
    expect(report.outcomes[0]?.status).toBe('rolled_back');
    expect(decodeJournal(w.journalText()).records.at(-1)?.detail).toMatchObject({ exit1: 1, exit2: 0 });
    expect(w.host.body(VHOST)).toBe(VHOST_TEXT);
    const m = vhostWorld();
    executeItems([item({ kind: 'vhost_manual_removal', path: VHOST, beforeSha: sha(VHOST_TEXT), server: 'apache', edit: 'remove_manual', lines: [4] }, 'change', 'web.manual_lines.0a1b2c3d')], m.ctx);
    expect(m.host.body(VHOST)).not.toContain('Alias /dedalo/media');
    const n = makeWorld({ decl: siteHomeDeclaration({ web: { server: 'nginx', unit: 'nginx' } }) });
    n.host.seedFile('/etc/nginx/sites-available/x', 'server {\n  server_name example.org;\n}\n');
    executeItems([item({ kind: 'vhost_reference', path: '/etc/nginx/sites-available/x', beforeSha: sha('server {\n  server_name example.org;\n}\n'), server: 'nginx', edit: 'reference', line: 1 })], n.ctx);
    expect(Buffer.from(n.edits[0]?.after ?? []).toString()).toContain('include /etc/dedalo_publication_host/test/web.nginx.con[f];');
  });

  test('nginx_map_seed: re-read under TOCTOU, the seeded paths named up front (the include only when absent)', () => {
    const n = makeWorld({ decl: siteHomeDeclaration({ web: { server: 'nginx', unit: 'nginx' } }) });
    const map = '/etc/nginx/conf.d/dedalo_map.conf';
    n.host.seedFile(map, 'map $cookie_dedalo_media_auth $dedalo_auth_key { }\n');
    const seed = item({ kind: 'nginx_map_seed', path: map, beforeSha: sha('map $cookie_dedalo_media_auth $dedalo_auth_key { }\n'), standalone: true }, 'change', 'web.nginx_manual_map.0a1b2c3d');
    expect(executeItems([seed], n.ctx).exit).toBe(0);
    expect(n.seeds[0]?.seeded).toEqual([
      '/var/lib/dedalo_publication_host/_host/nginx_map/dedalo_media_map.nginx.conf',
      '/var/lib/dedalo_publication_host/_host/nginx_map/contrib/_seed.json',
      '/etc/nginx/conf.d/dedalo_media_map.conf',
    ]);
    n.host.seedFile('/etc/nginx/conf.d/dedalo_media_map.conf', '');
    expect(seededPaths(n.ctx)).toHaveLength(2);
    expect(decodeJournal(n.journalText()).records.find(r => r.phase === 'begin')?.detail).toMatchObject({ standalone: true, target: map });
  });
});

describe('keep_ref (spec §4.3 item 20)', () => {
  test('the templates are kept root 0600 and rerun.env holds exactly BUN= and AGENT=', () => {
    const w = makeWorld();
    w.host.seedFile(`${INIT_DIR}/stage/source/.bun-version`, '1.4.3\n');
    const report = executeItems([item({ kind: 'keep_ref', files: [`${INIT_DIR}/stage/source/.bun-version`, V2_SAMPLE] }, 'change', 'init.keep_ref')], w.ctx);
    expect(report.exit).toBe(0);
    expect(w.host.body(`${INIT_DIR}/kept/.bun-version`)).toBe('1.4.3\n');
    expect(w.host.lstat(`${INIT_DIR}/kept/.bun-version`)?.mode).toBe(0o600);
    expect(w.host.body(`${INIT_DIR}/rerun.env`)).toBe(`BUN=${HOME}/.bun/bin/bun\nAGENT=${HOME}/host_agent\n`);
    expect(w.host.lstat(`${INIT_DIR}/rerun.env`)?.mode).toBe(0o600);
    for (const line of (w.host.body(`${INIT_DIR}/rerun.env`) as string).trim().split('\n')) expect(line).toMatch(/^(BUN|AGENT)=\/[A-Za-z0-9._/-]+$/);
  });
});

describe('cleanupAfterSuccess (§7 on success)', () => {
  test('stage/ and bun_extract/ go; the journal, kept/ and rerun.env stay', () => {
    const w = makeWorld();
    w.host.seedFile(`${INIT_DIR}/stage/source/x`, '');
    w.host.seedFile(`${INIT_DIR}/bun_extract/bun`, '');
    w.host.seedFile(`${INIT_DIR}/rerun.env`, 'BUN=/x\n');
    w.ctx.journal.append('init.keep_ref', 'done');
    expect(cleanupAfterSuccess(w.ctx)).toEqual([`${INIT_DIR}/stage`, `${INIT_DIR}/bun_extract`]);
    expect(w.host.lstat(`${INIT_DIR}/stage`)).toBeNull();
    expect(w.host.lstat(`${INIT_DIR}/rerun.env`)).not.toBeNull();
    expect(w.host.lstat(V2_SAMPLE)).not.toBeNull();
    expect(cleanupAfterSuccess(w.ctx)).toEqual([]);
  });
});

describe('resumeOpen (§7 --resume)', () => {
  test('a code tree swapped but never restarted goes back; a half-built .new is cleared', () => {
    const w = makeWorld();
    const dst = `${HOME}/host_agent`;
    w.host.seedFile(`${prevPathOf(dst)}/old.ts`, 'old');
    w.host.seedFile(`${dst}/new.ts`, 'new');
    w.ctx.journal.append('code.install', 'begin', { src: '/x', dst, new: newPathOf(dst), prev: prevPathOf(dst) });
    const report = resumeOpen(w.ctx.journal.unfinished(), w.ctx);
    expect(report.settled).toEqual([{ item: 'code.install', phase: 'rolled_back', detail: 'code tree: previous restored' }]);
    expect(report.rerun).toEqual(['code.install']);
    expect(w.host.body(`${dst}/old.ts`)).toBe('old');
    expect(w.host.lstat(newPathOf(dst))).toBeNull();
    expect(w.ctx.journal.unfinished()).toEqual([]);
  });

  function crashedEdit(w: World, current: string | null, mods: string[] = []): void {
    w.host.seedFile(`${INIT_DIR}/backup/3-x.conf`, VHOST_TEXT, 0o600);
    if (current !== null) w.host.seedFile(VHOST, current, 0o640, 0, 4);
    else w.host.entries.delete(VHOST);
    w.ctx.journal.append('web.vhost.0a1b2c3d', 'begin', {
      target: VHOST,
      backup: `${INIT_DIR}/backup/3-x.conf`,
      beforeSha: sha(VHOST_TEXT),
      afterSha: sha('AFTER\n'),
      server: 'apache',
      mods,
      previous: { uid: 0, gid: 4, mode: 0o640 },
    });
  }

  test('an operator file AT afterSha: configtest + reload → done; failing → restored + dismod → rolled back', () => {
    const w = makeWorld();
    crashedEdit(w, 'AFTER\n', ['rewrite']);
    expect(resumeOpen(w.ctx.journal.unfinished(), w.ctx).settled[0]?.phase).toBe('done');
    expect(w.host.calls.filter(c => /configtest|reload/.test(c))).toEqual(['configtest apache', 'reload apache2']);
    const f = makeWorld();
    crashedEdit(f, 'AFTER\n', ['rewrite']);
    f.host.configtestBreakers.push('AFTER');
    const report = resumeOpen(f.ctx.journal.unfinished(), f.ctx);
    expect(report.settled[0]?.phase).toBe('rolled_back');
    expect(f.host.body(VHOST)).toBe(VHOST_TEXT);
    expect(f.host.lstat(VHOST)).toEqual({ type: 'file', uid: 0, gid: 4, mode: 0o640 });
    expect(f.host.calls).toContain('a2dismod rewrite');
    expect(f.calls.filter(c => c.startsWith('web-'))).toEqual(['web-lock', 'web-unlock']);
  });

  test('an operator file AT beforeSha: dismod + configtest → rolled back; anything else → a decision, untouched', () => {
    const w = makeWorld();
    crashedEdit(w, VHOST_TEXT, ['headers']);
    const report = resumeOpen(w.ctx.journal.unfinished(), w.ctx);
    expect(report.settled[0]).toMatchObject({ phase: 'rolled_back', detail: 'the file was untouched; configtest exit 0' });
    expect(w.host.calls).toContain('a2dismod headers');
    const d = makeWorld();
    crashedEdit(d, 'SOMETHING ELSE\n');
    const decided = resumeOpen(d.ctx.journal.unfinished(), d.ctx);
    expect(decided.decisions).toEqual([{ item: 'web.vhost.0a1b2c3d', target: VHOST, backup: `${INIT_DIR}/backup/3-x.conf` }]);
    expect(d.host.body(VHOST)).toBe('SOMETHING ELSE\n');
    expect(d.ctx.journal.unfinished()).toHaveLength(1);
  });

  test('a stand-alone hand-map seed: unlinked → configtest+reload; failing → hand map restored, seeded files removed', () => {
    const map = '/etc/nginx/conf.d/dedalo_map.conf';
    const seeded = ['/var/lib/dedalo_publication_host/_host/nginx_map/dedalo_media_map.nginx.conf', '/var/lib/dedalo_publication_host/_host/nginx_map/contrib/_seed.json'];
    const setup = (): World => {
      const w = makeWorld({ decl: siteHomeDeclaration({ web: { server: 'nginx', unit: 'nginx' } }) });
      w.host.seedFile(`${INIT_DIR}/backup/5-dedalo_map.conf`, 'MAP\n', 0o600);
      w.host.seedDir('/etc/nginx/conf.d');
      for (const path of seeded) w.host.seedFile(path, 'seed');
      w.ctx.journal.append('web.nginx_manual_map.0a1b2c3d', 'begin', { target: map, backup: `${INIT_DIR}/backup/5-dedalo_map.conf`, beforeSha: sha('MAP\n'), standalone: true, seeded, previous: { uid: 0, gid: 0, mode: 0o644 } });
      return w;
    };
    const ok = setup();
    expect(resumeOpen(ok.ctx.journal.unfinished(), ok.ctx).settled[0]?.phase).toBe('done');
    const bad = setup();
    bad.host.configtestBreakers.push('seed');
    expect(resumeOpen(bad.ctx.journal.unfinished(), bad.ctx).settled[0]?.phase).toBe('rolled_back');
    expect(bad.host.body(map)).toBe('MAP\n');
    for (const path of seeded) expect(bad.host.lstat(path)).toBeNull();
    const untouched = setup();
    untouched.host.seedFile(map, 'MAP\n');
    expect(resumeOpen(untouched.ctx.journal.unfinished(), untouched.ctx).settled[0]?.detail).toContain('untouched');
    for (const path of seeded) expect(untouched.host.lstat(path)).toBeNull();
  });

  test('temps removed; a boolean already set is done; the rest is left to the idempotent re-run', () => {
    const w = makeWorld({ os: 'el' });
    const temp = `${HOME}/dedalo/publication_api/v2/shared/.v2.env.dedalo-init.tmp`;
    w.host.seedFile(temp, 'partial', 0o600);
    w.host.booleans.set('httpd_can_network_relay', true);
    w.ctx.journal.append('api_config.v2_env', 'begin', { path: `${HOME}/dedalo/publication_api/v2/shared/v2.env`, exists: false, temps: [temp] });
    w.ctx.journal.append('selinux.proxy_connect', 'begin', { name: 'httpd_can_network_relay', value: true, previous: false });
    w.ctx.journal.append('selinux.db_connect', 'begin', { name: 'httpd_can_network_connect_db', value: true, previous: false });
    w.ctx.journal.append('provision.apply', 'begin', { instance: 'test' });
    w.ctx.journal.append('web.vhost.ffffffff', 'begin', { path: VHOST, beforeSha: sha('x') });
    const report = resumeOpen(w.ctx.journal.unfinished(), w.ctx);
    expect(w.host.lstat(temp)).toBeNull();
    expect(report.settled.map(s => `${s.item}:${s.phase}`)).toEqual(['selinux.proxy_connect:done', 'web.vhost.ffffffff:rolled_back']);
    expect(report.rerun).toEqual(['api_config.v2_env', 'selinux.db_connect', 'provision.apply']);
  });
});

/**
 * The FakeInitHost itself (spec §9 FakeHost): its outputs follow the real commands' formats the
 * parsers read, its SELinux store computes `restorecon -n` from the rules, its FakeLockIo drives
 * lock.ts like flock(2) would. A fake that silently answered "ok" to everything would make every
 * init gate above it vacuous.
 */
describe('the FakeInitHost world', () => {
  test('discovery commands answer in the real formats; scripted outputs and failOn apply', () => {
    const w = makeWorld({ os: 'el' });
    const exec = w.host.exec;
    expect(exec.unameMachine().stdout).toBe('x86_64\n');
    expect(exec.passwdDb().stdout).toContain('root:x:0:0::/nonexistent:/usr/sbin/nologin\n');
    expect(exec.groupDb().stdout).toContain('dedalo_pubhost:x:989:\n');
    expect(exec.passwdLookup('nobody-here').code).toBe(2);
    expect(exec.groupLookup('root')).toEqual({ code: 0, stdout: 'root:x:0:\n', stderr: '' });
    expect(exec.unitShow('fapolicyd').stdout).toBe('ActiveState=inactive\n');
    w.host.unitProps.set('httpd', { LoadState: 'loaded', ProtectHome: 'yes' });
    expect(exec.unitShow('httpd').stdout).toBe('LoadState=loaded\nProtectHome=yes\n');
    expect(exec.unitShow('absent').stdout).toBe('LoadState=not-found\n');
    w.host.candidateUnits.push('httpd.service');
    expect(exec.listCandidateUnits().stdout).toBe('httpd.service loaded active running httpd.service\n');
    expect(exec.polkitVersion().stdout).toBe('pkaction version 126\n');
    w.host.polkit = 115;
    expect(exec.polkitVersion().stdout).toBe('pkaction version 0.115\n');
    w.host.polkit = null;
    expect(exec.polkitVersion().code).toBe(127);
    w.host.outputs.set('apache -S /usr/sbin/httpd', { code: 0, stdout: 'VirtualHost configuration:\n', stderr: '' });
    expect(exec.apacheVhosts('/usr/sbin/httpd').stdout).toBe('VirtualHost configuration:\n');
    expect(exec.apacheModules('/usr/sbin/httpd').stdout).toContain(' ssl_module (shared)\n');
    w.host.outputs.set('apache -M /usr/sbin/httpd', { code: 1, stdout: '', stderr: 'bad' });
    expect(exec.apacheModules('/usr/sbin/httpd').code).toBe(1);
    expect(exec.fpmDump('/usr/sbin/php-fpm').code).toBe(0);
    expect(exec.phpVersion('/usr/bin/php').code).toBe(0);
    expect(exec.webVersion('/usr/sbin/httpd').code).toBe(0);
    expect(exec.unzipBun('/z.zip', 'bun-linux-x64', '/d').code).toBe(0);
    w.host.failOn = 'uname -m';
    expect(exec.unameMachine().code).toBe(1);
    w.host.failOn = 'fpm -tt /usr/sbin/php-fpm';
    expect(exec.fpmDump('/usr/sbin/php-fpm').code).toBe(1);
    expect(() => exec.enableApacheModules(['ssl'])).toThrow('Debian family');
    expect(() => exec.disableApacheModules(['ssl'])).toThrow('Debian family');
    expect(() => exec.setsebool('httpd_graceful_shutdown', false)).toThrow('read, never written');
    expect(w.host.readProcFile('/proc/sys/kernel/osrelease')).toBe('6.1.0-25-amd64\n');
    w.host.procFiles.set('/proc/self/environ', 'PATH=/usr/bin\0');
    expect(w.host.readProcFile('/proc/self/environ')).toBe('PATH=/usr/bin\0');
    expect(w.host.readProcFile('/proc/locks')).toBeNull();
    expect(() => w.host.readProcFile('/proc/cpuinfo')).toThrow('allowlist');
  });

  test('pairing child: recorded, never with a token in what the fake logs', () => {
    const w = makeWorld();
    const invocation = { user: 'dedalo', bun: '/usr/local/bin/bun', checkout: '/opt/dedalo', verb: 'add' as const, name: 'test', fragment: '/etc/f.json', dryRun: true, env: {}, token: 'tok' };
    expect(w.host.exec.pairAsEngine(invocation)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(w.host.calls).toContain('pair add test --dry-run');
    expect(w.host.pairCalls).toHaveLength(1);
  });

  test('the SELinux store: getenforce, local rules, ports, labels; restorecon -n is computed from the rules', () => {
    const w = makeWorld({ os: 'el' });
    const exec = w.host.exec;
    expect(exec.selinuxMode().stdout).toBe('Enforcing\n');
    w.host.seedDir(`${HOME}/dedalo/publication_api/v1/current`);
    w.host.labels.set(`${HOME}/dedalo/publication_api/v1`, 'user_home_t');
    w.host.importRules(["fcontext -a -f a -t httpd_sys_content_t '/home/example\\.org/dedalo/publication_api/v1(/.*)?'", 'port -a -t http_port_t -p tcp 3100', 'garbage line'].join('\n'));
    expect(exec.semanageLocal('fcontext').stdout).toBe('/home/example\\.org/dedalo/publication_api/v1(/.*)?    all files    system_u:object_r:httpd_sys_content_t:s0\n');
    expect(exec.semanageLocal('port').stdout).toBe('http_port_t    tcp    3100\n');
    expect(exec.semanagePortList().stdout).toContain('http_port_t    tcp    80, 443, 3100\n');
    const dry = exec.restorecon([{ path: `${HOME}/dedalo/publication_api/v1`, recursive: true }], true);
    expect(dry.stdout).toBe(
      `Would relabel ${HOME}/dedalo/publication_api/v1 from system_u:object_r:user_home_t:s0 to system_u:object_r:httpd_sys_content_t:s0\n` +
        `Would relabel ${HOME}/dedalo/publication_api/v1/current from ? to system_u:object_r:httpd_sys_content_t:s0\n`,
    );
    exec.restorecon([{ path: `${HOME}/dedalo/publication_api/v1`, recursive: true }], false);
    expect(exec.restorecon([{ path: `${HOME}/dedalo/publication_api/v1`, recursive: true }], true).stdout).toBe('');
    expect(exec.selinuxLabel([`${HOME}/dedalo/publication_api/v1`, '/nolabel']).stdout).toBe(`system_u:object_r:httpd_sys_content_t:s0 ${HOME}/dedalo/publication_api/v1\n? /nolabel\n`);
    w.host.importRules("fcontext -d -f a -t httpd_sys_content_t '/home/example\\.org/dedalo/publication_api/v1(/.*)?'\nport -d -t http_port_t -p tcp 3100");
    expect(w.host.fcontext).toEqual([]);
    expect(w.host.localPorts.size).toBe(0);
    w.host.failOn = 'restorecon -n /x';
    expect(exec.restorecon([{ path: '/x', recursive: false }], true).code).toBe(1);
    w.host.selinuxMode = 'absent';
    expect(exec.selinuxMode().code).toBe(127);
    expect(exec.getsebool('not_a_boolean').code).toBe(1);
    expect(exec.systemdVersion().stdout).toStartWith('systemd 252 (252)');
    expect(exec.fpmConfigtest('/usr/sbin/php-fpm').code).toBe(0);
    w.host.webDump = 'Included configuration files:\n';
    expect(exec.apacheIncludes('/usr/sbin/httpd').stdout).toBe('Included configuration files:\n');
    expect(exec.nginxDump('/usr/sbin/nginx').stdout).toBe('Included configuration files:\n');
  });

  test('the virtual tree: links, renames, removals, siblings, the tree doors', () => {
    const w = makeWorld();
    const path = w.host.addSibling(siteHomeDeclaration({ instance: 'other' }));
    expect(path).toBe('/etc/dedalo_publication_host/other.json');
    expect(JSON.parse(w.host.body(path) as string).instance).toBe('other');
    w.host.seedFile('/srv/a/f', 'x');
    w.host.seedLink('/srv/a/l', 'f', '/srv/a/f');
    expect(w.host.treeReader.readlink('/srv/a/l')).toBe('f');
    expect(() => w.host.treeReader.readlink('/srv/a/f')).toThrow('EINVAL');
    expect(() => w.host.treeReader.readdir('/srv/a/f')).toThrow('ENOTDIR');
    expect(() => w.host.treeReader.readFile('/srv/a')).toThrow('not a regular file');
    expect(w.host.realpath('/srv/a/l')).toBe('/srv/a/f');
    expect(w.host.realpath('/srv/none')).toBeNull();
    w.host.treeWriter.symlink('f', '/srv/a/l2');
    expect(w.host.lstat('/srv/a/l2')?.type).toBe('symlink');
    expect(() => w.host.chown('/srv/a/l', 0, 0)).toThrow('ELOOP');
    expect(() => w.host.chmod('/srv/a/l', 0o600)).toThrow('ELOOP');
    expect(() => w.host.renameDir('/srv/a/f', '/srv/b')).toThrow('not a real directory');
    w.host.seedDir('/srv/c');
    expect(() => w.host.renameDir('/srv/a', '/srv/c')).toThrow('it exists');
    w.host.failOn = 'renameDir /srv/a /srv/d';
    expect(() => w.host.renameDir('/srv/a', '/srv/d')).toThrow('simulated');
    w.host.failOn = null;
    expect(() => w.host.removeTree('/srv/a', '/opt')).toThrow('not under');
    expect(() => w.host.removeInitTemp('/srv/a/f')).toThrow('not an init temp');
    expect(() => w.host.writeTempNamed('/srv/a', 'x/y', new Uint8Array(), 0o600)).toThrow('temp name');
    expect(() => w.host.writeTempNamed('/srv/none', 'x', new Uint8Array(), 0o600)).toThrow('ENOENT');
    expect(() => w.host.writeTempNamed('/srv/a', 'f', new Uint8Array(), 0o600)).toThrow('EEXIST');
    expect(() => w.host.writeBytesAtomic('/none/x', new Uint8Array(), 0o600, 0, 0)).toThrow('ENOENT');
    expect(() => w.host.writeBytesAtomic('/srv/a', new Uint8Array(), 0o600, 0, 0)).toThrow('EISDIR');
    w.host.failOn = 'writeBytesAtomic /srv/a/g';
    expect(() => w.host.writeBytesAtomic('/srv/a/g', new Uint8Array(), 0o600, 0, 0)).toThrow('simulated');
    expect(() => w.host.appendSync('/none/j', 'x')).toThrow('ENOENT');
    expect(() => w.host.appendSync('/srv/a/l', 'x')).toThrow('ELOOP');
    expect(() => w.host.readOperatorFile('/srv/a')).toThrow('not a regular file');
    expect(w.host.readRootFile('/srv/a')).toBeNull();
    expect(w.host.fsTypeOf('/home/example.org')).toBe('ext4');
  });

  test('FakeLockIo drives lock.ts: scripted holders, the fake clock, conflicting own descriptors', async () => {
    const { acquireInstanceLockSync, acquireHostLockAsync, LockBusy, peekInstanceLock } = await import('../src/provision/lock');
    const w = makeWorld();
    const lockIo = w.host.lockIo;
    const path = '/var/lib/dedalo_publication_host_init/test/init.lock';
    lockIo.holders.push({ path, mode: 'ex', pid: 777, untilMs: lockIo.clock + 2_000 });
    const started = lockIo.clock;
    const held = acquireInstanceLockSync('test', 'ex', { base: '/var/lib/dedalo_publication_host_init', io: lockIo, verb: 'init', pid: 4242 });
    expect(lockIo.clock - started).toBeGreaterThanOrEqual(2_000);
    expect(lockIo.heldBySelf(path)).toBe('ex');
    expect(peekInstanceLock('test', { base: '/var/lib/dedalo_publication_host_init', io: lockIo })).toMatchObject({ held: true, holder: { pid: 4242, verb: 'init' } });
    expect(() => acquireInstanceLockSync('test', 'sh', { base: '/var/lib/dedalo_publication_host_init', io: lockIo, verb: 'check' })).toThrow(LockBusy);
    held.release();
    expect(lockIo.heldBySelf(path)).toBeNull();
    lockIo.holders.push({ path: '/locks/web.lock', mode: 'ex', pid: 9, untilMs: Number.POSITIVE_INFINITY });
    lockIo.mkdir('/locks', 0o750, 0, 989);
    await expect(acquireHostLockAsync('web', { dir: '/locks', io: lockIo, gid: 989 })).rejects.toThrow('pid 9');
    lockIo.files.set('/locks/odd', { type: 'dir', uid: 0, gid: 0, mode: 0o700 });
    expect(() => lockIo.openLockFile('/locks/odd', { uid: 0, gid: 0, mode: 0o600, create: true })).toThrow('ELOOP');
    expect(() => lockIo.openLockFile('/locks/absent', { uid: 0, gid: 0, mode: 0o600, create: false })).toThrow('ENOENT');
    expect(() => lockIo.tryFlock(999, 'ex')).toThrow('EBADF');
  });

  test('siteSystemDeclaration derives the system layout paths', async () => {
    const { siteSystemDeclaration } = await import('./support/provision_fake_host');
    const layout = derive(siteSystemDeclaration());
    expect([layout.state.root, layout.agentDir, layout.bunBin]).toEqual(['/srv/dedalo_publication_host/test', '/opt/dedalo_publication_host/host_agent', '/opt/dedalo_publication_host/bun/bin/bun']);
  });
});
