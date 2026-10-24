/**
 * THE SELINUX POLICY MODULE (spec §9.8, owner decisions 2026-10-09): the v2 tree of EVERY layout is
 * typed `dedalo_publication_v2_t`, the one type of the provisioner's own CIL module. Held here: the
 * renderer (what the module grants, and to whom), the identity guard (ours / older / foreign), the
 * `semodule --list-modules=full` grammar, and the plan/apply lifecycle on the FakeHost's policy store
 * — written and installed BEFORE the import that names the type (the fake store refuses that import
 * otherwise, as libsemanage does), before the relabel and every unit start; upgraded in place;
 * refused when foreign; removed AFTER the import that unregistered its last rule, only when no
 * declaration on the host needs it; and the migration of a home-layout install an earlier
 * provisioner typed `data_home_t` (re-typed in place, idempotently).
 */
import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { apply } from '../src/provision/apply';
import { HOST_STAMP_INSTANCE, hasDrifted, parseStamp, stamp } from '../src/provision/hash';
import { parseSemoduleList } from '../src/provision/init/parse/selinux';
import type { AgentLayout, HostDeclaration } from '../src/provision/layout';
import { derive } from '../src/provision/layout';
import type { Action, HostState, SelinuxImportAction, SelinuxModuleInstallAction, SelinuxModulePlan, SelinuxObserved, SiblingFacts, WriteAction } from '../src/provision/plan';
import { PlanRefused, assertPlanIsCoherent, plan, planReport, selinuxModulePlan, selinuxPaths } from '../src/provision/plan';
import { HTTPD_READABLE_TYPES, encodeSelinuxState, parseSelinuxState, restoreconTargets } from '../src/provision/selinux';
import {
  NO_MODULE,
  SELINUX_MODULE_FILE,
  SELINUX_MODULE_FILE_MODE,
  SELINUX_MODULE_KIND,
  SELINUX_MODULE_NAME,
  V2_TREE_TYPE,
  installedModule,
  moduleSourceProblem,
  renderSelinuxModule,
  selinuxModuleBody,
  selinuxModulePath,
} from '../src/provision/selinux_module';
import { unixDeclaration } from './fixtures/provision_declaration';
import { FakeInitHost } from './support/provision_fake_host';
import { escapeRegExp } from '../../../test/helpers/regex_escape.ts';

/* ── the renderer ─────────────────────────────────────────────────────────────────── */

describe('the module source (CIL)', () => {
  const text = renderSelinuxModule();
  const body = selinuxModuleBody();
  const forms = body.split('\n').filter(line => line.startsWith('('));

  test('stamped host-wide with the CIL comment prefix; pure; the file is named after the module', () => {
    expect(text.split('\n')[0]).toMatch(new RegExp(`^; dedalo-provision: ${HOST_STAMP_INSTANCE} ${SELINUX_MODULE_KIND} [0-9a-f]{64}$`));
    expect(parseStamp(text)?.body).toBe(body);
    expect(hasDrifted(text)).toBe(false);
    expect(renderSelinuxModule()).toBe(text);
    expect(SELINUX_MODULE_FILE).toBe(`${SELINUX_MODULE_NAME}.cil`);
    expect(SELINUX_MODULE_FILE_MODE).toBe(0o644);
  });

  test('ONE file type, a normal one (files_type()), and only init_t is granted anything — never httpd', () => {
    expect(forms).toEqual([
      `(type ${V2_TREE_TYPE})`,
      `(roletype object_r ${V2_TREE_TYPE})`,
      `(typeattributeset file_type (${V2_TREE_TYPE}))`,
      `(typeattributeset non_security_file_type (${V2_TREE_TYPE}))`,
      `(typeattributeset non_auth_file_type (${V2_TREE_TYPE}))`,
      `(allow init_t ${V2_TREE_TYPE} (dir (getattr open read search)))`,
      `(allow init_t ${V2_TREE_TYPE} (file (getattr open read)))`,
      `(allow init_t ${V2_TREE_TYPE} (lnk_file (getattr read)))`,
    ]);
    // Read-only: no write/create/execute/relabel/setattr permission for anyone.
    for (const form of forms.filter(f => f.startsWith('(allow'))) {
      expect(form).not.toMatch(/\b(write|create|add_name|remove_name|unlink|rename|execute|relabelfrom|relabelto|setattr|append)\b/);
    }
    expect(forms.join('\n')).not.toMatch(/httpd/);
    // No form other than those: no typetransition, no boolean, no domain.
    expect(body).not.toMatch(/\((typetransition|boolean|booleanif|tunable|typealias|allowx|neverallow)\b/);
    expect(HTTPD_READABLE_TYPES).not.toContain(V2_TREE_TYPE);
  });
});

/* ── the identity guard ───────────────────────────────────────────────────────────── */

describe('installedModule: ours (current / older) or foreign, never guessed', () => {
  const row = (priority = 400, lang = 'cil', disabled = false) => ({ priority, lang, disabled });
  const older = stamp(SELINUX_MODULE_KIND, HOST_STAMP_INSTANCE, '; an older renderer\n(type dedalo_publication_v2_t)\n', ';');

  test('absent, current, older', () => {
    expect(installedModule(NO_MODULE)).toEqual({ kind: 'absent' });
    expect(installedModule({ listed: [row()], source: renderSelinuxModule() })).toEqual({ kind: 'ours', current: true });
    expect(installedModule({ listed: [row()], source: older })).toEqual({ kind: 'ours', current: false });
  });

  test('another priority, another language, disabled, unstamped, hand-edited, unreadable, another stamp: foreign', () => {
    const cases: [Parameters<typeof installedModule>[0], RegExp][] = [
      [{ listed: [row(100)], source: null }, /priority 100, not 400/],
      [{ listed: [row(), row(300)], source: renderSelinuxModule() }, /priority 300/],
      [{ listed: [row(400, 'pp')], source: 'x' }, /'pp' module/],
      [{ listed: [row(400, 'cil', true)], source: renderSelinuxModule() }, /disabled/],
      [{ listed: [row()], source: '(type dedalo_publication_v2_t)\n' }, /not written by this provisioner/],
      [{ listed: [row()], source: `${renderSelinuxModule()}(allow httpd_t ${V2_TREE_TYPE} (file (read)))\n` }, /edited by hand/],
      [{ listed: [row()], source: null }, /could not be read/],
      [{ listed: [row()], source: stamp('unit_agent', 'test', 'x') }, /not written by this provisioner/],
    ];
    for (const [observed, reason] of cases) {
      const judged = installedModule(observed);
      expect(judged.kind, JSON.stringify(observed)).toBe('foreign');
      expect(judged.kind === 'foreign' ? judged.reason : '').toMatch(reason);
    }
  });

  test('moduleSourceProblem: null only for a stamped, unedited source of ours', () => {
    expect(moduleSourceProblem('x', renderSelinuxModule())).toBeNull();
    expect(moduleSourceProblem('x', older)).toBeNull();
    expect(moduleSourceProblem('x', `${renderSelinuxModule()} `)).toMatch(/edited by hand/);
    expect(moduleSourceProblem('x', '')).toMatch(/not written/);
  });
});

describe('parseSemoduleList (measured RHEL 9.8 lines)', () => {
  test('priority, name, language, disabled', () => {
    expect(parseSemoduleList('400 permissive_rhcd_t cil         \n200 adcli             pp          \n100 abrt              pp  disabled\n')).toEqual([
      { priority: 400, name: 'permissive_rhcd_t', lang: 'cil', disabled: false },
      { priority: 200, name: 'adcli', lang: 'pp', disabled: false },
      { priority: 100, name: 'abrt', lang: 'pp', disabled: true },
    ]);
    expect(parseSemoduleList('')).toEqual([]);
  });
  test('a malformed line throws (a half-read list would call a foreign module absent)', () => {
    expect(() => parseSemoduleList('400 dedalo_publication_host\n')).toThrow(/parse\(selinux\)/);
    expect(() => parseSemoduleList('x dedalo cil\n')).toThrow(/parse\(selinux\)/);
  });
});

/* ── plan / apply on the FakeHost's policy store ──────────────────────────────────── */

const SYSTEM_PATHS = {
  agent_dir: '/opt/dedalo_publication_host/host_agent',
  bun_bin: '/opt/dedalo_publication_host/bun/bin/bun',
  state_root: '/srv/dedalo_publication_host/test',
};

function siteDecl(extra: Partial<HostDeclaration> = {}): HostDeclaration {
  return {
    ...unixDeclaration(),
    web: { server: 'apache', unit: 'httpd' },
    site: { domain: 'museum.example.org', fpm: { flavor: 'el', version: '8.2' } },
    ...extra,
  } as HostDeclaration;
}
const systemDecl = (extra: Partial<HostDeclaration> = {}): HostDeclaration => siteDecl({ ...SYSTEM_PATHS, ...extra });
const homeDecl = (): HostDeclaration =>
  siteDecl({ agent_dir: '/home/museum.example.org/host_agent', bun_bin: '/home/museum.example.org/.bun/bin/bun', state_root: '/home/museum.example.org/dedalo' });

class Host extends FakeInitHost {
  sleepSync(ms: number): void {
    this.lockIo.sleepSync(ms);
  }
}

function hostFor(l: AgentLayout, selinux: 'enforcing' | 'disabled' = 'enforcing'): Host {
  const host = new Host(l, { os: 'el', selinux });
  if (l.site?.v1 != null) {
    host.seedFile(l.site.v1.fpm.bin, '', 0o755);
    host.seedDir(dirname(l.site.v1.fpm.poolFile));
    host.units.set(l.site.v1.fpm.unit, { enabled: true, active: true });
  }
  host.units.set(l.web.unit, { enabled: true, active: true });
  host.seedDir('/var/lib');
  return host;
}

/** What apply.ts observeHost reports of the fake's store (its own restorecon -n computes pending). */
function selinuxOf(host: Host, l: AgentLayout): SelinuxObserved {
  const targets = restoreconTargets(l).filter(t => host.entries.has(t.path));
  const dry = targets.length === 0 ? '' : host.exec.restorecon(targets, true).stdout;
  return {
    mode: host.selinuxMode,
    storePresent: true,
    localFcontext: host.fcontext.map(rule => ({ spec: rule.spec, type: rule.type })),
    localPorts: [...host.localPorts].map(([port, type]) => ({ type, proto: 'tcp', port })),
    portTypes: new Map<number, string>([...host.portTypes, ...host.localPorts]),
    pending: dry
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [, path = '', from = '', to = ''] = /^Would relabel (\S+) from \S+?:\S+?:(\S+?):\S+ to \S+?:\S+?:(\S+?):\S+$/.exec(line) ?? [];
        return { path, from, to };
      }),
    state: host.body(selinuxPaths(l).stateFile) ?? null,
    booleans: Object.fromEntries(host.booleans),
    mediaLabelable: true,
    module: host.moduleObserved(),
  };
}

function stateOf(host: Host, l: AgentLayout, siblings?: readonly SiblingFacts[]): HostState {
  return { ...host.state(), selinux: selinuxOf(host, l), ...(siblings === undefined ? {} : { siblings }) };
}

function refusalsOf(l: AgentLayout, state: HostState): string {
  try {
    plan(l, state);
  } catch (error) {
    if (error instanceof PlanRefused) return error.reasons.join('\n');
    throw error;
  }
  throw new Error('plan did not refuse');
}

const ops = (actions: readonly Action[]): string[] => actions.map(action => action.op);

function converged(decl: HostDeclaration = systemDecl()): { l: AgentLayout; host: Host } {
  const l = derive(decl);
  const host = hostFor(l);
  if (l.state.root.startsWith('/home/')) seedHome(host);
  const report = apply(plan(l, stateOf(host, l, [])), host);
  expect(report.failure).toBeNull();
  return { l, host };
}

describe('every layout: written, installed before the import that names its type, the tree labelled', () => {
  test('a fresh plan: the stamped source (root 0644), then semodule -i BEFORE the import, the relabel and every unit op', () => {
    const l = derive(systemDecl());
    const host = hostFor(l);
    const actions = plan(l, stateOf(host, l, []));
    const write = actions.find(a => a.op === 'write' && a.label === 'selinux_module') as WriteAction;
    expect(write).toMatchObject({ path: selinuxModulePath(l), disposition: 'create', mode: 0o644, owner: 'root', group: 'root', validate: null });
    expect(write.content).toEqual({ source: 'literal', body: renderSelinuxModule() });
    expect(selinuxModulePath(l)).toBe(`${l.host.base}/${SELINUX_MODULE_FILE}`);
    const install = actions.find(a => a.op === 'selinux-module-install') as SelinuxModuleInstallAction;
    expect(install).toEqual({ op: 'selinux-module-install', file: selinuxModulePath(l), body: renderSelinuxModule(), why: 'absent' });
    const list = ops(actions);
    const at = list.indexOf('selinux-module-install');
    expect(list.indexOf('write')).toBeLessThan(at);
    for (const later of ['selinux-import', 'selinux-restorecon', 'fpm-configtest', 'web-configtest', 'enable', 'start']) {
      expect(list.indexOf(later), later).toBeGreaterThan(at);
    }
    const imp = actions.find(a => a.op === 'selinux-import') as SelinuxImportAction;
    expect(imp.lines).toContain(`fcontext -a -f a -t ${V2_TREE_TYPE} '${escapeRegExp(l.state.apis.v2.root)}(/.*)?'`);
  });

  test("a fresh system host: the state root's missing parent (/srv/dedalo_publication_host) is created root 0755, under a temporary name", () => {
    const l = derive(systemDecl());
    const host = hostFor(l);
    const base = dirname(l.state.root);
    host.entries.delete(base);
    const mk = plan(l, stateOf(host, l, [])).find(a => a.op === 'mkdir' && a.path === base);
    expect(mk).toMatchObject({ owner: 'root', group: 'root', mode: 0o755 });
    expect((mk as { via?: string }).via).toBeDefined();
    expect(apply(plan(l, stateOf(host, l, [])), host).failure).toBeNull();
    expect(host.entries.get(base)).toMatchObject({ type: 'dir', uid: 0, mode: 0o755 });
  });

  test('apply converges: the store holds our source, the v2 tree is typed by it (httpd-unreadable), a second plan is empty', () => {
    const { l, host } = converged();
    expect(host.modules).toEqual([{ name: SELINUX_MODULE_NAME, priority: 400, lang: 'cil', disabled: false, source: renderSelinuxModule() }]);
    expect(host.body(selinuxModulePath(l))).toBe(renderSelinuxModule());
    for (const path of [l.state.apis.v2.root, l.state.apis.v2.shared]) expect(host.labels.get(path), path).toBe(V2_TREE_TYPE);
    expect(host.labels.get(l.state.root)).toBe('usr_t');
    expect(plan(l, stateOf(host, l, []))).toEqual([]);
    expect(planReport(l, stateOf(host, l, [])).facts).toContain(`SELinux policy module ${SELINUX_MODULE_NAME} (type ${V2_TREE_TYPE}, the v2 tree): installed, current`);
  });

  test('THE ORDER IS LOAD-BEARING: without the install, the import naming the type fails (the store does not know it)', () => {
    const l = derive(systemDecl());
    const host = hostFor(l);
    const actions = plan(l, stateOf(host, l, [])).filter(a => a.op !== 'selinux-module-install');
    const report = apply(actions, host);
    expect(report.failure?.detail).toMatch(/semanage import/);
    expect(host.fcontext).toEqual([]);
  });

  test('apply holds the installed module to the rendered bytes: a store that keeps something else fails the op', () => {
    const l = derive(systemDecl());
    const host = hostFor(l);
    const exec = host.exec;
    (host as unknown as { exec: typeof exec }).exec = { ...exec, semoduleExtract: () => ({ result: { code: 0, stdout: '', stderr: '' }, text: '; something else\n' }) };
    const report = apply(plan(l, stateOf(host, l, [])), host);
    expect(report.failure?.detail).toMatch(/is not the rendered source/);
  });

  test('the home layout installs it too (one v2 type on every layout): written, installed before the import, the tree typed by it', () => {
    const l = derive(homeDecl());
    const host = hostFor(l);
    seedHome(host);
    const actions = plan(l, stateOf(host, l, []));
    const list = ops(actions);
    expect(actions.some(a => a.op === 'write' && a.label === 'selinux_module')).toBe(true);
    expect(list.indexOf('selinux-module-install')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('selinux-module-install')).toBeLessThan(list.indexOf('selinux-import'));
    const imp = actions.find(a => a.op === 'selinux-import') as SelinuxImportAction;
    expect(imp.lines).toContain(`fcontext -a -f a -t ${V2_TREE_TYPE} '${escapeRegExp(l.state.apis.v2.root)}(/.*)?'`);
    expect(imp.lines.some(line => line.includes('data_home_t'))).toBe(false);
    expect(apply(actions, host).failure).toBeNull();
    for (const path of [l.state.apis.v2.root, l.state.apis.v2.shared]) expect(host.labels.get(path), path).toBe(V2_TREE_TYPE);
    expect(plan(l, stateOf(host, l, []))).toEqual([]);
  });

  test('SELinux disabled with the store: written and installed (rules registered for a later enable), nothing relabelled', () => {
    const l = derive(systemDecl());
    const host = hostFor(l, 'disabled');
    const list = ops(plan(l, stateOf(host, l, [])));
    expect(list).toContain('selinux-module-install');
    expect(list).not.toContain('selinux-restorecon');
  });

  test('an older module of ours is upgraded in place: source rewritten, semodule -i (outdated)', () => {
    const { l, host } = converged();
    const older = stamp(SELINUX_MODULE_KIND, HOST_STAMP_INSTANCE, '; an older renderer\n', ';');
    (host.modules[0] as { source: string }).source = older;
    host.seedFile(selinuxModulePath(l), older);
    const actions = plan(l, stateOf(host, l, []));
    expect(actions.find(a => a.op === 'write' && a.label === 'selinux_module')).toMatchObject({ disposition: 'rewrite' });
    expect(actions.find(a => a.op === 'selinux-module-install')).toMatchObject({ why: 'outdated' });
    expect(apply(actions, host).failure).toBeNull();
    expect(host.modules[0]?.source).toBe(renderSelinuxModule());
    expect(plan(l, stateOf(host, l, []))).toEqual([]);
  });

  test('a FOREIGN module of our name, or a source file that is not ours, is REFUSED — never replaced', () => {
    const cases: [(host: Host, l: AgentLayout) => void, RegExp][] = [
      [host => host.modules.push({ name: SELINUX_MODULE_NAME, priority: 100, lang: 'pp', disabled: false, source: 'x' }), /priority 100, not 400/],
      [host => host.modules.push({ name: SELINUX_MODULE_NAME, priority: 400, lang: 'cil', disabled: false, source: '(type dedalo_publication_v2_t)\n' }), /not written by this provisioner/],
      [host => host.modules.push({ name: SELINUX_MODULE_NAME, priority: 400, lang: 'cil', disabled: true, source: renderSelinuxModule() }), /disabled/],
      [(host, l) => host.seedFile(selinuxModulePath(l), '(type x_t)\n'), /SELinux policy module source\) was not written by this provisioner .* never overwritten/],
      [(host, l) => host.seedFile(selinuxModulePath(l), `${renderSelinuxModule()}; mine\n`), /edited by hand .* never overwritten/],
    ];
    for (const [arrange, reason] of cases) {
      const l = derive(systemDecl());
      const host = hostFor(l);
      arrange(host, l);
      const reasons = refusalsOf(l, stateOf(host, l, []));
      expect(reasons).toMatch(reason);
    }
    // the instance's labels name the type: the refusal says so and how to look
    const l = derive(systemDecl());
    const host = hostFor(l);
    host.modules.push({ name: SELINUX_MODULE_NAME, priority: 200, lang: 'cil', disabled: false, source: '' });
    expect(refusalsOf(l, stateOf(host, l, []))).toContain(`need its type ${V2_TREE_TYPE}, and a module that is not ours is never replaced: semodule --list-modules=full`);
  });
});

/** The home layout's code and Bun on a host converged in the system layout (a relocation). */
function seedHome(host: Host): void {
  host.seedDir('/home/museum.example.org/host_agent/src');
  host.seedFile('/home/museum.example.org/host_agent/src/index.ts', '');
  host.seedFile('/home/museum.example.org/.bun/bin/bun', '', 0o755);
}

/**
 * The home layout as an earlier provisioner left it (before 2026-10-09): the v2 rule ours with
 * `data_home_t` (recorded in selinux.state), the tree labelled so, and no module on the host.
 */
function legacyHome(): { l: AgentLayout; host: Host; spec: string } {
  const { l, host } = converged(homeDecl());
  const spec = `${escapeRegExp(l.state.apis.v2.root)}(/.*)?`;
  const rule = host.fcontext.find(r => r.spec === spec);
  expect(rule?.type).toBe(V2_TREE_TYPE);
  if (rule !== undefined) rule.type = 'data_home_t';
  for (const [path, type] of host.labels) if (type === V2_TREE_TYPE) host.labels.set(path, 'data_home_t');
  const { stateFile } = selinuxPaths(l);
  const state = parseSelinuxState(host.body(stateFile) ?? null);
  expect(state).not.toBeNull();
  host.seedFile(stateFile, encodeSelinuxState({ v: 1, fcontext: (state?.fcontext ?? []).map(r => (r.spec === spec ? { ...r, type: 'data_home_t' } : r)), ports: state?.ports ?? [] }), 0o644);
  host.modules.length = 0;
  host.entries.delete(selinuxModulePath(l));
  return { l, host, spec };
}

describe('migration: a home-layout install typed data_home_t is re-typed in place, idempotently', () => {
  test('module installed, then ONE import: -d of our recorded data_home_t rule, -a of the module type; the tree relabelled; a second plan is empty', () => {
    const { l, host, spec } = legacyHome();
    expect(host.labels.get(l.state.apis.v2.shared)).toBe('data_home_t');
    const actions = plan(l, stateOf(host, l, []));
    const list = ops(actions);
    expect(list.indexOf('selinux-module-install')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('selinux-module-install')).toBeLessThan(list.indexOf('selinux-import'));
    expect(list.indexOf('selinux-import')).toBeLessThan(list.indexOf('selinux-restorecon'));
    const imp = actions.find(a => a.op === 'selinux-import') as SelinuxImportAction;
    expect(imp.lines).toEqual([`fcontext -d -f a -t data_home_t '${spec}'`, `fcontext -a -f a -t ${V2_TREE_TYPE} '${spec}'`]);
    const restorecon = actions.find(a => a.op === 'selinux-restorecon') as { readonly targets: readonly { readonly path: string; readonly recursive: boolean }[] };
    expect(restorecon.targets).toContainEqual({ path: l.state.apis.v2.root, recursive: true });
    expect(apply(actions, host).failure).toBeNull();
    expect(host.fcontext.filter(r => r.spec === spec)).toEqual([{ spec, ftype: 'a', type: V2_TREE_TYPE }]);
    for (const path of [l.state.apis.v2.root, l.state.apis.v2.shared]) expect(host.labels.get(path), path).toBe(V2_TREE_TYPE);
    expect([...host.labels.values()]).not.toContain('data_home_t');
    expect(parseSelinuxState(host.body(selinuxPaths(l).stateFile) ?? null)?.fcontext.find(r => r.spec === spec)?.type).toBe(V2_TREE_TYPE);
    expect(plan(l, stateOf(host, l, []))).toEqual([]);
  });

  test('a data_home_t rule on our spec that our selinux.state does NOT record is the operator\'s: refused, never re-typed', () => {
    const { l, host } = legacyHome();
    const { stateFile } = selinuxPaths(l);
    const legacy = host.body(stateFile) ?? '';
    // no history at all
    host.entries.delete(stateFile);
    expect(refusalsOf(l, stateOf(host, l, []))).toMatch(/types it 'data_home_t', not 'dedalo_publication_v2_t' .* never overridden/);
    // our history recorded ANOTHER type there: someone re-typed our rule since — theirs now
    host.seedFile(stateFile, legacy.replace('"data_home_t"', `"${V2_TREE_TYPE}"`), 0o644);
    expect(refusalsOf(l, stateOf(host, l, []))).toMatch(/types it 'data_home_t', not 'dedalo_publication_v2_t' .* never overridden/);
  });
});

describe('retirement: removed AFTER the import that unregistered its rules, only when no declaration needs it', () => {
  // Every layout needs the module now (moduleNeeded): plan() never retires it while a declaration
  // exists. The retirement half is held through selinuxModulePlan with needed = false.
  const sibling = (decl: HostDeclaration): SiblingFacts => ({ layout: derive({ ...decl, instance: 'other', agent_user: 'other_agent' } as HostDeclaration), agentUid: 2001 });
  const retire = (l: AgentLayout, state: HostState): { result: SelinuxModulePlan; refusals: string[] } => {
    const refusals: string[] = [];
    const result = selinuxModulePlan(l, state, state.selinux as SelinuxObserved, refusals, false);
    return { result, refusals };
  };

  test('no declaration needs it (siblings observed, none needing): semodule -r of ours, its source with it', () => {
    const { l, host } = converged();
    const { result, refusals } = retire(l, stateOf(host, l, []));
    expect(refusals).toEqual([]);
    expect(result.tail).toEqual([{ op: 'selinux-module-remove', file: selinuxModulePath(l) }]);
  });

  test('a sibling still needs it: kept; siblings not observed: kept, and the report says nothing is removed', () => {
    const { l, host } = converged();
    expect(retire(l, stateOf(host, l, [sibling(homeDecl())])).result.tail).toEqual([]);
    expect(retire(l, stateOf(host, l)).result.tail).toEqual([]);
  });

  test('a foreign module of our name is never removed; a hand-edited leftover source is refused, never removed', () => {
    const l = derive(systemDecl());
    const host = hostFor(l);
    host.modules.push({ name: SELINUX_MODULE_NAME, priority: 400, lang: 'cil', disabled: false, source: '(type x_t)\n' });
    expect(retire(l, stateOf(host, l, [])).result.tail).toEqual([]);
    host.seedFile(selinuxModulePath(l), `${renderSelinuxModule()}; mine\n`);
    expect(retire(l, stateOf(host, l, [])).refusals.join('\n')).toMatch(/edited by hand .* it is not removed/);
  });

  test('our leftover source with no module installed is removed through the remove door', () => {
    const l = derive(systemDecl());
    const host = hostFor(l);
    host.seedFile(selinuxModulePath(l), renderSelinuxModule());
    const { result } = retire(l, stateOf(host, l, []));
    expect(result.removeSource).toBe(selinuxModulePath(l));
    expect(result.tail).toEqual([]);
  });

  test('from plan(): never retired while a declaration exists — home and system layouts both keep it', () => {
    for (const decl of [homeDecl(), systemDecl()]) {
      const { l, host } = converged(decl);
      expect(ops(plan(l, stateOf(host, l, []))).filter(op => op.startsWith('selinux-module'))).toEqual([]);
      expect(host.moduleInstalled()).toBe(true);
    }
  });

  test('semodule refuses a removal while a rule names the type: the fake store holds that law too', () => {
    const { host } = converged();
    expect(host.exec.semoduleRemove().code).toBe(1);
    expect(host.moduleInstalled()).toBe(true);
  });
});

describe('assertPlanIsCoherent: the module ops are ordered', () => {
  const state = (() => {
    const l = derive(systemDecl());
    return hostFor(l).state();
  })();
  const install: SelinuxModuleInstallAction = { op: 'selinux-module-install', file: '/x/dedalo_publication_host.cil', body: '', why: 'absent' };
  const imp: SelinuxImportAction = { op: 'selinux-import', file: '/etc/x', lines: [], statePath: '/etc/y', stateBody: '', uid: 0, gid: 0 };
  const remove: Action = { op: 'selinux-module-remove', file: null };

  test('install after the import, the relabel or a unit start; removal before the import; both; after a configtest', () => {
    expect(() => assertPlanIsCoherent([imp, install], state)).toThrow(/installed after an op that needs its type/);
    expect(() => assertPlanIsCoherent([{ op: 'selinux-restorecon', targets: [{ path: '/srv', recursive: false }] }, install], state)).toThrow(/installed after/);
    expect(() => assertPlanIsCoherent([{ op: 'start', unit: 'v2' }, install], state)).toThrow(/installed after/);
    expect(() => assertPlanIsCoherent([remove, imp], state)).toThrow(/removed before the import/);
    expect(() => assertPlanIsCoherent([install, remove], state)).toThrow(/both installed and removed/);
    expect(() => assertPlanIsCoherent([{ op: 'fpm-configtest', bin: '/usr/sbin/php-fpm' }, install], state)).toThrow(/after a configtest/);
    expect(() => assertPlanIsCoherent([install, imp], state)).not.toThrow();
    expect(() => assertPlanIsCoherent([imp, remove], state)).not.toThrow();
  });
});
