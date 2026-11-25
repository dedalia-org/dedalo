/**
 * init/compare.ts — the item list (spec §4, B2). ONE ROW PER §4.3 BRANCH: each row builds its
 * situation from literal facts (tests/fixtures/init_drafts.ts), runs the real completeDraft →
 * compare, and pins the branch's list, flags and options. Then the laws over every item every
 * row produced: fixed ids that round-trip through `--decide` (parseInitArgs), `after` naming only
 * earlier items, the --yes law (a hostWide or operatorFile item is never a plain change), vhost
 * edits as {path, beforeSha, edit}, the declaration body = canonicalDeclaration.
 */
import { describe, expect, test } from 'bun:test';
import { HOME_ROOT_MODE } from '../src/provision/layout';
import type { HostDeclaration } from '../src/provision/layout';
import { parseInitArgs } from '../src/provision/init/args';
import type { ComparedItem } from '../src/provision/init/compare';
import { ITEM_IDS, compare, isKnownItemId, unknownAnswers } from '../src/provision/init/compare';
import { TYPED_ACTION_KINDS, classifyDecision, typedMarkProblems } from '../src/provision/init/decision_class';
import type { DraftDeclaration } from '../src/provision/init/draft';
import { completeDraft, vhostSha8 } from '../src/provision/init/draft';
import type { CompareCtx, DeclaredFacts, HostFacts, InitAction } from '../src/provision/init/types';
import { insertApacheReference, insertNginxReference } from '../src/provision/init/web_edit';
import { canonicalDeclaration } from '../src/provision/schema';
import { stamp } from '../src/provision/hash';
import type { HostState } from '../src/provision/plan';
import type { SelinuxModuleObserved } from '../src/provision/selinux_module';
import { SELINUX_MODULE_KIND, renderSelinuxModule } from '../src/provision/selinux_module';
import {
  DOMAIN,
  HOME,
  INSTANCE,
  PIN,
  appStreamFpm,
  args,
  compareCtx,
  debianFpm,
  debianHost,
  declaredConverged,
  declaredFresh,
  draft,
  elHost,
  remiFpm,
  stagedSource,
  v2Draft,
  vhost,
  withInstanceAccounts,
  workUnit,
} from './fixtures/init_drafts';

/* ── the harness ─────────────────────────────────────────────────────────────────────── */

interface Scn {
  readonly facts?: HostFacts;
  readonly draft?: DraftDeclaration;
  /** `null` = no second pass; a function receives the completion's layout. */
  readonly declared?: DeclaredFacts | null | ((layout: NonNullable<ReturnType<typeof completeDraft>['layout']>) => DeclaredFacts);
  readonly ctx?: Partial<CompareCtx>;
  readonly existing?: HostDeclaration | null;
  readonly answers?: Readonly<Record<string, string>>;
}

const ALL: ComparedItem[] = [];

/** declaredFresh() whose observed host holds this policy module (selinux.v2_policy). */
function withModule(module: SelinuxModuleObserved): DeclaredFacts {
  return { ...declaredFresh(), hostState: { selinux: { module } } as unknown as HostState };
}

function run(scn: Scn = {}) {
  const facts = scn.facts ?? debianHost();
  const answers = new Map(Object.entries(scn.answers ?? {}));
  const options = { existing: scn.existing ?? null, answers };
  let declared: DeclaredFacts | null;
  if (typeof scn.declared === 'function') {
    const first = completeDraft(scn.draft ?? draft(), facts, options);
    if (first.layout === null) throw new Error(`no layout: ${first.layoutError} ${JSON.stringify(first.unfilled)}`);
    declared = scn.declared(first.layout);
  } else declared = scn.declared === undefined ? declaredFresh() : scn.declared;
  const completion = completeDraft(scn.draft ?? draft(), facts, { ...options, declared });
  const items = compare(facts, completion, declared, compareCtx(scn.ctx));
  ALL.push(...items);
  return { items, completion, get: (id: string) => items.find(row => row.id === id) };
}

const nginx = (patch: Partial<HostFacts['web']> = {}): HostFacts => {
  const base = debianHost();
  return {
    ...base,
    web: {
      ...base.web,
      candidates: ['nginx'],
      server: 'nginx',
      unit: 'nginx',
      configtestBin: '/usr/sbin/nginx',
      dumpBin: '/usr/sbin/nginx',
      version: '1.22.1',
      runUser: 'www-data',
      modules: [],
      confDInHttp: true,
      vhosts: [vhost({ file: '/etc/nginx/sites-enabled/example.org', realpath: '/etc/nginx/sites-available/example.org', fpmHandler: null })],
      ...patch,
    },
  };
};

const withSelinux = (facts: HostFacts, patch: Partial<HostFacts['selinux']>): HostFacts => ({ ...facts, selinux: { ...facts.selinux, ...patch } });
const booleans = (patch: Record<string, boolean>) => ({ ...elHost().selinux.booleans, ...patch });
const SANDBOX = { protectHome: 'no', protectSystem: 'no', inaccessible: [] as string[], readOnly: [] as string[], tmpfs: [] as string[] };

/** A host where everything already converged (the second run of spec §9 init_run case 1). */
function converged(facts = withInstanceAccounts(debianHost()), extra: Partial<DeclaredFacts> = {}): Scn {
  const first = completeDraft(draft(), facts);
  if (first.declaration === null || first.layout === null) throw new Error('fixture does not complete');
  const settled = {
    ...facts,
    web: { ...facts.web, vhosts: facts.web.vhosts.map(row => ({ ...row, ourReference: true })) },
    work: [workUnit({ fragmentPending: false })],
  };
  return {
    facts: settled,
    draft: first.declaration,
    existing: first.declaration,
    declared: declaredConverged(first.layout, extra),
    ctx: { source: null, bunArchive: null, args: args({ draft: null, source: null, sourceDigestConfirmed: null, bunArchive: null }) },
  };
}

/* ── one row per §4.3 branch ─────────────────────────────────────────────────────────── */

interface Expect {
  readonly list?: ComparedItem['list'];
  readonly blocking?: boolean;
  readonly hostWide?: boolean;
  readonly operatorFile?: boolean;
  readonly optional?: boolean;
  readonly options?: readonly string[];
  readonly defaultOption?: string;
  readonly fact?: RegExp;
  readonly command?: RegExp;
  readonly action?: InitAction['kind'] | null;
  readonly after?: readonly string[];
  readonly absent?: true;
}

/** fapolicyd installed and running, reading trust.d, integrity = sha256. */
const FAPOLICYD: HostFacts['fapolicyd'] = { active: true, installed: true, conf: { trust: ['rpmdb', 'file'], integrity: 'sha256', filesystemMark: true } };

/** EL 10: the EL 9 facts on the EL 10 row (no dnf modules; AppStream PHP 8.3). */
function el10Host(): HostFacts {
  const el = elHost();
  const support = el.os.support as NonNullable<HostFacts['os']['support']>;
  return { ...el, os: { ...el.os, versionId: '10.2', support: { ...support, version: '10', dnfModules: false, appStreamPhp: '8.3' } }, fpm: [appStreamFpm('8.3')] };
}

const ROWS: readonly (readonly [string, () => Scn, string, Expect])[] = [
  // host.os
  ['os supported', () => ({}), 'host.os', { list: 'right' }],
  ['os ubuntu 22.04', () => ({ facts: { ...debianHost(), os: { ...debianHost().os, id: 'ubuntu', versionId: '22.04', supported: false, support: null } } }), 'host.os', { list: 'decision', blocking: true, fact: /polkit 0\.105/ }],
  ['os el 10', () => ({ facts: el10Host() }), 'host.os', { list: 'right', fact: /rocky 10\.2: supported/ }],
  ['os el 8', () => ({ facts: { ...elHost(), os: { ...elHost().os, id: 'rocky', versionId: '8.10', supported: false, support: null } } }), 'host.os', { blocking: true, fact: /EL 8 \(systemd 239, kernel 4\.18\).*upgrade to RHEL, Rocky or Alma 9 or 10/ }],
  ['os centos stream', () => ({ facts: { ...elHost(), os: { ...elHost().os, id: 'centos', versionId: '10', supported: false, support: null } } }), 'host.os', { blocking: true, fact: /is not supported \(RHEL, Rocky and Alma 9 and 10 are\)/ }],
  ['os other', () => ({ facts: { ...debianHost(), os: { ...debianHost().os, id: 'arch', versionId: 'rolling', family: 'other', supported: false, support: null } } }), 'host.os', { blocking: true, fact: /not supported \(Debian 12\/13, Ubuntu 24\.04\/26\.04, RHEL\/Rocky\/Alma 9 and 10\)/ }],
  // host.panel
  ['no panel', () => ({}), 'host.panel', { list: 'right' }],
  ['panel', () => ({ facts: { ...debianHost(), panel: 'plesk' } }), 'host.panel', { blocking: true, options: ['manual'], fact: /plesk/ }],
  // host.systemd
  ['systemd full', () => ({}), 'host.systemd', { list: 'right', fact: /≥ 247/ }],
  ['systemd below the floor (EL 8 239)', () => ({ facts: { ...debianHost(), systemd: 239 } }), 'host.systemd', { blocking: true, fact: /systemd 239: below 247/ }],
  ['systemd too old', () => ({ facts: { ...debianHost(), systemd: 237 } }), 'host.systemd', { blocking: true }],
  ['systemd unknown', () => ({ facts: { ...debianHost(), systemd: null } }), 'host.systemd', { blocking: true }],
  // host.polkit
  ['polkit missing debian', () => ({ facts: { ...debianHost(), polkit: { version: null, state: 'not_activatable' } } }), 'host.polkit', { blocking: true, command: /^apt install polkitd$/ }],
  ['polkit missing el', () => ({ facts: { ...elHost(), polkit: { version: null, state: 'not_activatable' } } }), 'host.polkit', { blocking: true, command: /^dnf install polkit$/ }],
  ['polkit 0.105', () => ({ facts: { ...debianHost(), polkit: { version: 105, state: 'running' } } }), 'host.polkit', { blocking: true, fact: /0\.105/ }],
  // D-Bus-activated: an idle host's polkit is not running, and that is right (the drill's Debian 13 / Ubuntu 26.04 case).
  ['polkit activatable', () => ({ facts: { ...debianHost(), polkit: { version: 126, state: 'activatable' } } }), 'host.polkit', { list: 'right', fact: /started on demand by the system bus/ }],
  ['polkit masked', () => ({ facts: { ...debianHost(), polkit: { version: 126, state: 'masked' } } }), 'host.polkit', { blocking: true, command: /^systemctl unmask polkit\.service$/ }],
  ['polkit not activatable', () => ({ facts: { ...debianHost(), polkit: { version: 122, state: 'not_activatable' } } }), 'host.polkit', { blocking: true, fact: /system bus cannot start it/, command: /^apt reinstall polkitd$/ }],
  ['polkit right', () => ({}), 'host.polkit', { list: 'right' }],
  // host.sudo
  ['sudo absent', () => ({ facts: { ...debianHost(), sudo: { present: false, includedir: false, flavor: 'sudo', policyFile: '/etc/sudoers', skipped: [] } } }), 'host.sudo', { blocking: true, command: /install sudo/ }],
  ['sudo no includedir', () => ({ facts: { ...debianHost(), sudo: { present: true, includedir: false, flavor: 'sudo', policyFile: '/etc/sudoers', skipped: [] } } }), 'host.sudo', { blocking: true, command: /includedir/ }],
  // sudo-rs with its own policy file: the fix names THAT file (editing /etc/sudoers would change nothing).
  ['sudo-rs no includedir', () => ({ facts: { ...debianHost(), sudo: { present: true, includedir: false, flavor: 'sudo-rs', policyFile: '/etc/sudoers-rs', skipped: [] } } }), 'host.sudo', { blocking: true, fact: /^\/etc\/sudoers-rs \(the policy sudo-rs reads\)/, command: /^visudo -f \/etc\/sudoers-rs/ }],
  ['sudo-rs right', () => ({ facts: { ...debianHost(), sudo: { present: true, includedir: true, flavor: 'sudo-rs', policyFile: '/etc/sudoers-rs', skipped: [] } } }), 'host.sudo', { list: 'right', fact: /sudo-rs reads \/etc\/sudoers\.d \(through \/etc\/sudoers-rs\)/ }],
  // S3-3: what the include walk did not follow is named in the item.
  ['sudo skipped include', () => ({ facts: { ...debianHost(), sudo: { present: true, includedir: false, flavor: 'sudo', policyFile: '/etc/sudoers', skipped: ['/etc/sudoers.local: mode 0666 is group- or world-writable — sudo does not read it'] } } }), 'host.sudo', { blocking: true, fact: /not followed: \/etc\/sudoers\.local: mode 0666/ }],
  ['sudo right', () => ({}), 'host.sudo', { list: 'right' }],
  // host.web
  ['web none', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, candidates: [] } } }), 'host.web', { blocking: true }],
  ['web both', () => ({ facts: nginx({ candidates: ['apache', 'nginx'] }) }), 'host.web', { list: 'decision', options: ['apache', 'nginx'], defaultOption: 'nginx', blocking: false }],
  ['web one', () => ({}), 'host.web', { list: 'right' }],
  // host.php_mode
  ['php mode debian mod_php', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, phpModule: true } } }), 'host.php_mode', { list: 'right', fact: /alongside mod_php/ }],
  ['php mode el php.conf', () => ({ facts: elHost() }), 'host.php_mode', { list: 'right', fact: /inside <If>/ }],
  ['php mode el prefork', () => ({ facts: { ...elHost(), web: { ...elHost().web, phpModuleOnly: true, globalPhpHandler: null } } }), 'host.php_mode', { list: 'right', fact: /prefork/ }],
  ['php mode none', () => ({}), 'host.php_mode', { list: 'right', fact: /no server-wide PHP handler/ }],
  ['php mode nginx: absent', () => ({ facts: nginx() }), 'host.php_mode', { absent: true }],
  // host.fpm_install
  ['fpm none', () => ({ facts: { ...debianHost(), fpm: [] } }), 'host.fpm_install', { blocking: true, command: /php-fpm/ }],
  ['fpm only below the floor (el 9 AppStream 8.0: a module stream)', () => ({ facts: { ...elHost(), fpm: [appStreamFpm('8.0')] } }), 'host.fpm_install', { blocking: true, fact: /below the v1 floor/, command: /dnf module reset php && dnf module enable php:8\.1/ }],
  ['fpm only below the floor on el 10: no module stream', () => ({ facts: { ...el10Host(), fpm: [appStreamFpm('8.0')] } }), 'host.fpm_install', { blocking: true, command: /^dnf install php-fpm php-cli$/ }],
  ['fpm declared el missing (el 9: module stream)', () => ({ draft: draft({ site: { domain: DOMAIN, fpm: { flavor: 'el', version: '8.2' } } }), facts: elHost() }), 'host.fpm_install', { blocking: true, command: /^dnf module reset php && dnf module enable php:8\.2 && dnf install php-fpm php-cli$/ }],
  ['fpm none on el 9: the module stream (the default AppStream 8.0 is below the floor)', () => ({ facts: { ...elHost(), fpm: [] } }), 'host.fpm_install', { blocking: true, command: /^dnf module reset php && dnf module enable php:8\.1 && dnf install php-fpm php-cli$/ }],
  ['fpm none on el 10: AppStream (8.3, no module)', () => ({ facts: { ...el10Host(), fpm: [] } }), 'host.fpm_install', { blocking: true, command: /^dnf install php-fpm php-cli$/ }],
  ['fpm declared el missing (el 10: the AppStream version)', () => ({ draft: draft({ site: { domain: DOMAIN, fpm: { flavor: 'el', version: '8.3' } } }), facts: { ...el10Host(), fpm: [remiFpm('8.4')] } }), 'host.fpm_install', { blocking: true, command: /^dnf install php-fpm php-cli$/ }],
  // Measured RHEL 10.2: AppStream ships php8.4-fpm as an alternative to its default php-fpm 8.3 (same paths, flavor
  // 'el', Conflicts: php-fpm < 8.4), so over the installed 8.3 only `--allowerasing` installs it.
  ['fpm declared el missing (el 10: the alternative package over the installed default)', () => ({ draft: draft({ site: { domain: DOMAIN, fpm: { flavor: 'el', version: '8.4' } } }), facts: el10Host() }), 'host.fpm_install', { blocking: true, fact: /replaces the installed el PHP 8\.3/, command: /^dnf install --allowerasing php8\.4-fpm php8\.4-cli /}],
  ['fpm declared el missing (el 10: the alternative package, nothing to replace)', () => ({ draft: draft({ site: { domain: DOMAIN, fpm: { flavor: 'el', version: '8.4' } } }), facts: { ...el10Host(), fpm: [remiFpm('8.2')] } }), 'host.fpm_install', { blocking: true, fact: /alternative package php8\.4-fpm \(the same paths, flavor 'el'\)/, command: /^dnf install php8\.4-fpm php8\.4-cli /}],
  ['fpm declared el missing (el 10: Remi stays an alternative)', () => ({ draft: draft({ site: { domain: DOMAIN, fpm: { flavor: 'el', version: '8.4' } } }), facts: el10Host() }), 'host.fpm_install', { blocking: true, command: /^dnf install php84-php-fpm php84-php-cli .*"flavor": "remi"/ }],
  ['fpm declared missing', () => ({ draft: draft({ site: { domain: DOMAIN, fpm: { flavor: 'debian', version: '8.4' } } }) }), 'host.fpm_install', { blocking: true, command: /apt install php8\.4-fpm/ }],
  ['fpm right, below-floor listed', () => ({ facts: elHost() }), 'host.fpm_install', { list: 'right', fact: /el PHP 8\.0 .*below the v1 floor/ }],
  ['fpm without a site: absent', () => ({ draft: draft({ site: undefined }) }), 'host.fpm_install', { absent: true }],
  // host.web_version
  ['nginx too old', () => ({ facts: nginx({ version: '1.12.2' }) }), 'host.web_version', { blocking: true, fact: /below 1\.14/ }],
  ['nginx too old el', () => ({ facts: { ...nginx({ version: '1.12.2' }), os: elHost().os } }), 'host.web_version', { blocking: true, command: /dnf module reset nginx/ }],
  ['nginx too old el 10', () => ({ facts: { ...nginx({ version: '1.12.2' }), os: el10Host().os } }), 'host.web_version', { blocking: true, command: /^dnf upgrade nginx$/ }],
  ['web version unread', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, version: null } } }), 'host.web_version', { blocking: true }],
  ['web version right', () => ({}), 'host.web_version', { list: 'right' }],
  // host.kernel
  ['kernel right', () => ({}), 'host.kernel', { list: 'right' }],
  ['kernel below the floor', () => ({ facts: { ...elHost(), kernel: { release: '4.18.0-553.el8_10.x86_64', meetsFloor: false } } }), 'host.kernel', { blocking: true, fact: /below Bun's documented floor 5\.1/ }],
  // host.noexec
  ['noexec /opt under system', () => ({ draft: draft({ layout: 'system' }), facts: { ...debianHost(), mounts: [...debianHost().mounts, { mountPoint: '/opt', fsType: 'ext4', readOnly: false, noexec: true, seclabel: false, context: null }] } }), 'host.noexec', { blocking: true, fact: /noexec/, command: /findmnt -T/ }],
  ['noexec INIT_BASE', () => ({ facts: { ...debianHost(), mounts: [...debianHost().mounts, { mountPoint: '/var', fsType: 'ext4', readOnly: false, noexec: true, seclabel: false, context: null }] } }), 'host.noexec', { blocking: true, fact: /INIT_BASE/ }],
  ['noexec home under home layout: a layout reason, not this item', () => ({ draft: draft({ layout: 'home' }), facts: { ...debianHost(), mounts: [...debianHost().mounts, { mountPoint: '/home', fsType: 'ext4', readOnly: false, noexec: true, seclabel: false, context: null }] } }), 'host.noexec', { list: 'right' }],
  ['noexec home → layout system/manual', () => ({ facts: { ...debianHost(), mounts: [...debianHost().mounts, { mountPoint: '/home', fsType: 'ext4', readOnly: false, noexec: true, seclabel: false, context: null }] } }), 'declaration.layout', { list: 'decision', blocking: true, options: ['system', 'manual'] }],
  // host.fapolicyd, host.fapolicyd_integrity (owner decision 2026-10-09): the trust is AUTOMATIC
  // (provision apply writes the instance's trust file; the agent starts its trust oneshot) — init
  // only judges whether fapolicyd reads trust.d and how it re-checks a trusted file.
  ['fapolicyd not installed', () => ({}), 'host.fapolicyd', { list: 'right', fact: /fapolicyd is not installed/ }],
  ['fapolicyd not installed: no integrity item', () => ({}), 'host.fapolicyd_integrity', { absent: true }],
  ['fapolicyd installed: automatic, no command', () => ({ facts: { ...elHost(), fapolicyd: FAPOLICYD } }), 'host.fapolicyd', { list: 'right', fact: /trust is automatic: provision apply writes \/etc\/fapolicyd\/trust\.d\/dedalo_demo .*dedalo-pubhost-trust-demo\.service/ }],
  ['fapolicyd installed but stopped: still automatic', () => ({ facts: { ...elHost(), fapolicyd: { ...FAPOLICYD, active: false } } }), 'host.fapolicyd', { list: 'right', fact: /not running/ }],
  ['fapolicyd without the file backend: blocking, host-wide', () => ({ facts: { ...elHost(), fapolicyd: { ...FAPOLICYD, conf: { trust: ['rpmdb'], integrity: 'sha256', filesystemMark: true } } } }), 'host.fapolicyd', { list: 'decision', blocking: true, hostWide: true, options: ['manual'], fact: /no 'file' backend/, command: /,file\/' \/etc\/fapolicyd\/fapolicyd\.conf$/ }],
  ['fapolicyd.conf unreadable: blocking', () => ({ facts: { ...elHost(), fapolicyd: { ...FAPOLICYD, conf: null } } }), 'host.fapolicyd', { list: 'decision', blocking: true, fact: /could not be read/ }],
  ['integrity sha256: right', () => ({ facts: { ...elHost(), fapolicyd: FAPOLICYD } }), 'host.fapolicyd_integrity', { list: 'right', fact: /integrity = sha256/ }],
  ['integrity none: an optional host-wide warning recommending sha256', () => ({ facts: { ...elHost(), fapolicyd: { ...FAPOLICYD, conf: { trust: ['rpmdb', 'file'], integrity: 'none', filesystemMark: true } } } }), 'host.fapolicyd_integrity', { list: 'decision', blocking: false, optional: true, hostWide: true, options: ['manual', 'skip'], defaultOption: 'manual', fact: /its path only — a release or agent file changed AFTER it was trusted would still run/, command: /integrity = sha256/ }],
  ['allow_filesystem_mark = 1: right', () => ({ facts: { ...elHost(), fapolicyd: FAPOLICYD } }), 'host.fapolicyd_mounts', { list: 'right', fact: /checks what the sandboxed services open/ }],
  ['allow_filesystem_mark = 0 (the default): an optional host-wide warning — the units run unchecked', () => ({ facts: { ...elHost(), fapolicyd: { ...FAPOLICYD, conf: { trust: ['rpmdb', 'file'], integrity: 'sha256', filesystemMark: false } } } }), 'host.fapolicyd_mounts', { list: 'decision', blocking: false, optional: true, hostWide: true, options: ['manual', 'skip'], fact: /run unchecked, trusted or not/, command: /allow_filesystem_mark = 1/ }],
  ['fapolicyd not installed: no mounts item', () => ({}), 'host.fapolicyd_mounts', { absent: true }],
  ['integrity size: the same warning', () => ({ facts: { ...elHost(), fapolicyd: { ...FAPOLICYD, conf: { trust: ['rpmdb', 'file'], integrity: 'size', filesystemMark: true } } } }), 'host.fapolicyd_integrity', { list: 'decision', fact: /its size only/ }],
  // host.unit_sandbox
  ['web unit hides the system state root', () => ({ draft: draft({ layout: 'system' }), facts: { ...debianHost(), web: { ...debianHost().web, unitSandbox: { ...SANDBOX, inaccessible: ['/srv'] } } } }), 'host.unit_sandbox', { blocking: true, fact: /apache2: InaccessiblePaths=\/srv/, command: /systemctl edit apache2/ }],
  ['fpm unit read-only on v1Var', () => ({ facts: { ...debianHost(), fpm: [debianFpm('8.2', { unitSandbox: { ...SANDBOX, readOnly: ['/var/lib'] } })] } }), 'host.unit_sandbox', { blocking: true, fact: /php8\.2-fpm: ReadOnlyPaths=\/var\/lib/ }],
  ['ProtectHome under home: the layout item, not this one', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, unitSandbox: { ...SANDBOX, protectHome: 'yes' } } } }), 'declaration.layout', { blocking: true, options: ['system', 'manual'] }],
  ['ProtectHome with home insisted: reported once, by the layout', () => ({ draft: draft({ layout: 'home' }), facts: { ...debianHost(), web: { ...debianHost().web, unitSandbox: { ...SANDBOX, protectHome: 'yes' } } } }), 'host.unit_sandbox', { list: 'right' }],
  ['unit sandbox right', () => ({}), 'host.unit_sandbox', { list: 'right' }],
  // host.remi_label
  ['remi label broken', () => ({ facts: { ...elHost(), fpm: [appStreamFpm(), remiFpm('8.4', { socketDirLabel: 'var_t' })] } }), 'host.remi_label', { blocking: true, command: /restorecon -Rv \/var\/opt\/remi\/php84\/run/ }],
  ['remi label right', () => ({ facts: elHost() }), 'host.remi_label', { list: 'right' }],
  ['remi label not on debian', () => ({}), 'host.remi_label', { absent: true }],
  // host.fpm_cli
  ['fpm cli missing', () => ({ facts: { ...debianHost(), fpm: [debianFpm('8.2', { cli: null })] } }), 'host.fpm_cli', { blocking: true, command: /apt install php8\.2-cli/ }],
  ['fpm cli missing remi', () => ({ facts: { ...elHost(), fpm: [remiFpm('8.4', { cli: null })] } }), 'host.fpm_cli', { blocking: true, command: /dnf install php84-php-cli/ }],
  ['fpm cli right', () => ({}), 'host.fpm_cli', { list: 'right' }],
  // host.cpu
  ['cpu musl', () => ({ facts: { ...debianHost(), cpu: { arch: 'x64', avx2: true, musl: true } } }), 'host.cpu', { blocking: true, fact: /musl/ }],
  ['cpu other', () => ({ facts: { ...debianHost(), cpu: { arch: 'other', avx2: false, musl: false } } }), 'host.cpu', { blocking: true }],
  ['cpu baseline', () => ({ facts: { ...debianHost(), cpu: { arch: 'x64', avx2: false, musl: false } } }), 'host.cpu', { list: 'right', fact: /baseline/ }],
  // host.tools
  ['unzip missing, Bun to install', () => ({ facts: { ...debianHost(), tools: { unzip: false, chattr: true } } }), 'host.tools', { blocking: true, command: /apt install unzip/ }],
  // A slim image without e2fsprogs: apply's chattr +a on the audit trail failed late (the Debian drill, exit 127).
  ['chattr missing', () => ({ facts: { ...debianHost(), tools: { unzip: true, chattr: false } } }), 'host.chattr', { blocking: true, command: /^apt install e2fsprogs$/ }],
  ['chattr missing el', () => ({ facts: { ...elHost(), tools: { unzip: true, chattr: false } } }), 'host.chattr', { blocking: true, command: /^dnf install e2fsprogs$/ }],
  ['chattr present', () => ({}), 'host.chattr', { list: 'right' }],
  ['unzip missing, nothing needs it', () => ({ facts: { ...debianHost(), tools: { unzip: false, chattr: true } }, ctx: { bunArchive: null } }), 'host.tools', { list: 'right', fact: /nothing needs it/ }],
  ['bun.install waits for host.tools', () => ({}), 'bun.install', { list: 'change', after: ['home.root', 'host.tools'] }],
  // host.nss
  ['nss files', () => ({}), 'host.nss', { list: 'right', fact: /local files/ }],
  ['nss directory: engine group by hand', () => ({ facts: { ...debianHost(), nss: { passwdFilesOnly: false, groupFilesOnly: true, sssDomains: true } } }), 'account.engine_group', { blocking: true, fact: /directory service/, command: /getent group dedalo/ }],
  // host.selinux / tools / root context
  ['selinux absent', () => ({}), 'host.selinux', { list: 'right', fact: /no labels needed/ }],
  ['selinux disabled with the store', () => ({ facts: withSelinux(elHost(), { mode: 'disabled' }) }), 'host.selinux', { list: 'right', fact: /registered for a later enable/ }],
  ['selinux enforcing el', () => ({ facts: elHost() }), 'host.selinux', { list: 'right', fact: /labels will be managed/ }],
  ['selinux enforcing debian', () => ({ facts: withSelinux(debianHost(), { mode: 'enforcing', policy: 'default' }) }), 'host.selinux', { blocking: true, fact: /debian system: not supported/ }],
  ['selinux mls', () => ({ facts: withSelinux(elHost(), { policy: 'mls' }) }), 'host.selinux', { blocking: true, fact: /mls/ }],
  ['selinux tools missing', () => ({ facts: withSelinux(elHost(), { tools: { semanage: false, restorecon: false, getsebool: true } }) }), 'host.selinux_tools', { blocking: true, command: /policycoreutils-python-utils/ }],
  ['selinux tools right', () => ({ facts: elHost() }), 'host.selinux_tools', { list: 'right' }],
  ['root context sysadm', () => ({ facts: withSelinux(elHost(), { rootContext: 'staff_u:sysadm_r:sysadm_t:s0' }) }), 'host.root_context', { blocking: true, fact: /unconfined/ }],
  ['root context right', () => ({ facts: elHost() }), 'host.root_context', { list: 'right' }],
  ['root context without selinux: absent', () => ({}), 'host.root_context', { absent: true }],
  // declaration.*
  ['fields right', () => ({}), 'declaration.fields', { list: 'right', fact: /web\.server = apache/ }],
  ['fields unfilled', () => ({ facts: { ...debianHost(), work: [] } }), 'declaration.fields', { blocking: true, fact: /engine_group/ }],
  ['fields layout error', () => ({ draft: draft({ media: { mode: 'shared' } }) }), 'declaration.fields', { blocking: true, fact: /media\.root/ }],
  ['layout proposed', () => ({}), 'declaration.layout', { list: 'decision', options: ['home', 'system'], defaultOption: 'home', blocking: false }],
  ['layout named', () => ({ draft: draft({ layout: 'home' }) }), 'declaration.layout', { list: 'right', fact: /named by the draft/ }],
  ['layout no site', () => ({ draft: draft({ site: undefined }) }), 'declaration.layout', { list: 'right', fact: /no site/ }],
  ['layout: symlinked home seen by the second pass', () => ({ draft: draft({ layout: 'home' }), declared: { ...declaredFresh(), home: { ...declaredFresh().home, facts: { type: 'symlink', uid: 1002, gid: 1002, mode: 0o777 } } } }), 'declaration.layout', { blocking: true, options: ['system', 'manual'], fact: /symlink/ }],
  ['fpm several', () => ({ facts: { ...elHost(), fpm: [appStreamFpm('8.1'), remiFpm('8.4')] } }), 'declaration.fpm', { list: 'decision', options: ['el-8-1', 'remi-8-4'], defaultOption: 'remi-8-4' }],
  ['fpm one', () => ({}), 'declaration.fpm', { list: 'right' }],
  ['vhost alias only', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ matchedBy: 'alias' })] } } }), 'declaration.vhost', { blocking: true, options: ['manual'] }],
  ['vhost right', () => ({}), 'declaration.vhost', { list: 'right' }],
  ['work unit several', () => ({ facts: { ...debianHost(), work: [workUnit(), workUnit({ unit: 'dedalo-ts@b', group: 'dedalo' })] } }), 'declaration.work_unit', { list: 'decision', options: ['dedalo-ts', 'dedalo-ts_b'] }],
  ['work unit none (unix)', () => ({ facts: { ...debianHost(), work: [] } }), 'declaration.work_unit', { blocking: true }],
  ['work unit tls: absent', () => ({ draft: draft({ listen: { kind: 'tls', host: '10.8.0.2', port: 7443 } }) }), 'declaration.work_unit', { absent: true }],
  ['v2 port busy', () => ({ facts: { ...debianHost(), ports: [3100] } }), 'declaration.v2_port', { list: 'decision', options: ['port-3101', 'manual'], defaultOption: 'port-3101' }],
  ['v2 port right', () => ({}), 'declaration.v2_port', { list: 'right' }],
  ['home shared with another vhost', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost(), vhost({ serverName: 'other.example.org', documentRoot: `${HOME}/other` })] } } }), 'declaration.home', { blocking: true, fact: /other\.example\.org/ }],
  ['home documentroot elsewhere', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ documentRoot: '/var/www/example' })] } } }), 'declaration.home', { list: 'right', fact: /outside/ }],
  ['home forbidden', () => ({ draft: draft({ site: { domain: DOMAIN, home: '/srv' }, layout: 'system' }) }), 'declaration.home', { blocking: true, fact: /holds other sites/ }],
  ['v1 user www-data', () => ({ draft: draft({ v1: { user: 'www-data' } }) }), 'declaration.v1_user', { blocking: true, options: ['act', 'manual'] }],
  ['v1 user right', () => ({}), 'declaration.v1_user', { list: 'right', fact: /decision A/ }],
  ['state root foreign (home)', () => ({ draft: draft({ layout: 'home' }), declared: { ...declaredFresh(), stateRoot: 'foreign' } }), 'declaration.state_root', { blocking: true, options: ['relocate', 'manual'], defaultOption: 'relocate', fact: /dedalo_publication/ }],
  ['state root foreign (system)', () => ({ draft: draft({ layout: 'system' }), declared: { ...declaredFresh(), stateRoot: 'foreign' } }), 'declaration.state_root', { blocking: true, options: ['manual'] }],
  ['state root right', () => ({}), 'declaration.state_root', { list: 'right' }],
  ['layout dirs foreign .bun', () => ({ draft: draft({ layout: 'home' }), declared: { ...declaredFresh(), home: { ...declaredFresh().home, layoutDirs: { ...declaredFresh().home.layoutDirs, '.bun': { type: 'dir', uid: 1002, gid: 1002, mode: 0o755 } } } } }), 'declaration.layout_dirs', { blocking: true, options: ['relocate', 'manual'], fact: /\.dedalo_bun/ }],
  ['layout dirs relocated: right', () => ({ draft: draft({ layout: 'home' }), answers: { 'declaration.layout_dirs': 'relocate' }, declared: { ...declaredFresh(), home: { ...declaredFresh().home, layoutDirs: { ...declaredFresh().home.layoutDirs, '.bun': { type: 'dir', uid: 1002, gid: 1002, mode: 0o755 } } } } }), 'declaration.layout_dirs', { list: 'right' }],
  [
    'shared code',
    () => ({
      draft: draft({ layout: 'system' }),
      declared: layout => ({ ...declaredFresh(), siblings: [{ source: '/etc/dedalo_publication_host/other.json', layout: { ...layout, instance: 'other', agentUnitName: 'dedalo-publication-host-other' } }] }),
    }),
    'declaration.shared_code',
    { list: 'decision', options: ['act', 'manual'], defaultOption: 'manual', fact: /dedalo-publication-host-other/ },
  ],
  // account.*
  ['pubhost group missing', () => ({}), 'account.pubhost_group', { list: 'change', action: 'group_add', command: /groupadd --system dedalo_pubhost/ }],
  ['pubhost group not a system group', () => ({ facts: { ...debianHost(), accounts: { ...debianHost().accounts, groups: [...debianHost().accounts.groups, { name: 'dedalo_pubhost', gid: 1500, members: [] }] } } }), 'account.pubhost_group', { blocking: true }],
  ['pubhost group right', () => ({ facts: withInstanceAccounts(debianHost()) }), 'account.pubhost_group', { list: 'right' }],
  ['v2 group missing', () => ({}), 'account.v2_group', { list: 'change', action: 'group_add' }],
  ['agent user missing', () => ({}), 'account.agent_user', { list: 'change', action: 'user_add_own', command: /useradd --system --no-create-home --shell \/usr\/sbin\/nologin --user-group demo_agent/ }],
  ['v2 user in its group', () => ({}), 'account.v2_user', { list: 'change', action: 'user_add_in', after: ['account.v2_group'] }],
  ['v1 user wrong shell', () => ({ facts: (() => { const f = withInstanceAccounts(debianHost()); return { ...f, accounts: { ...f.accounts, users: f.accounts.users.map(u => (u.name === 'demo_v1' ? { ...u, shell: '/bin/bash' } : u)) } }; })() }), 'account.v1_user', { blocking: true, fact: /never modified/ }],
  ['v1 user right', () => ({ facts: withInstanceAccounts(debianHost()) }), 'account.v1_user', { list: 'right' }],
  ['engine group missing', () => ({ draft: draft({ engine_group: 'nosuch' }) }), 'account.engine_group', { blocking: true, fact: /never creates/ }],
  ['engine group holds our account', () => ({ facts: (() => { const f = withInstanceAccounts(debianHost()); return { ...f, accounts: { ...f.accounts, groups: f.accounts.groups.map(g => (g.name === 'dedalo' ? { ...g, members: ['demo_agent'] } : g)) } }; })() }), 'account.engine_group', { blocking: true, fact: /demo_agent is in 'dedalo'/ }],
  ['engine group right', () => ({}), 'account.engine_group', { list: 'right' }],
  ['engine group tls: absent', () => ({ draft: draft({ listen: { kind: 'tls', host: '10.8.0.2', port: 7443 } }) }), 'account.engine_group', { absent: true }],
  // home.*
  ['home missing', () => ({ declared: { ...declaredFresh(), home: { ...declaredFresh().home, facts: null } } }), 'home.root', { list: 'change', action: 'mkdir', command: /^mkdir -m 0755 \/home\/example\.org$/ }],
  ['home 0700 widens', () => ({}), 'home.root', { list: 'change', action: 'path_meta', command: /^chown root:root \/home\/example\.org && chmod 0755 \/home\/example\.org$/, fact: /widens from 0700 to 0755/ }],
  ['home root-owned but group-writable', () => ({ declared: { ...declaredFresh(), home: { ...declaredFresh().home, facts: { type: 'dir', uid: 0, gid: 1002, mode: 0o775 } } } }), 'home.root', { list: 'change', action: 'path_meta' }],
  ['home root right', () => ({ declared: { ...declaredFresh(), home: { ...declaredFresh().home, facts: { type: 'dir', uid: 0, gid: 0, mode: 0o711 } } } }), 'home.root', { list: 'right' }],
  ['home under system: absent', () => ({ draft: draft({ layout: 'system' }) }), 'home.root', { absent: true }],
  ['home on nfs4: no home.root', () => ({ facts: { ...debianHost(), mounts: [...debianHost().mounts, { mountPoint: '/home', fsType: 'nfs4', readOnly: false, noexec: false, seclabel: false, context: null }] } }), 'home.root', { absent: true }],
  // selinux.*
  ['home traverse: the exact rule, a change', () => ({ facts: elHost() }), 'selinux.home_traverse', { list: 'change', blocking: true, hostWide: false, options: ['act', 'boolean', 'relocate'], defaultOption: 'act', command: /^semanage fcontext -a -f d -t home_root_t '\/home\/example\\\.org'$/ }],
  ['home traverse right (label)', () => ({ facts: elHost(), declared: { ...declaredFresh(), home: { ...declaredFresh().home, traversable: true } } }), 'selinux.home_traverse', { list: 'right' }],
  ['home traverse right (boolean)', () => ({ facts: withSelinux(elHost(), { booleans: booleans({ httpd_enable_homedirs: true }) }) }), 'selinux.home_traverse', { list: 'right', fact: /httpd_enable_homedirs/ }],
  ['home traverse not on debian', () => ({}), 'selinux.home_traverse', { absent: true }],
  ['proxy connect right (graceful)', () => ({ facts: elHost() }), 'selinux.proxy_connect', { list: 'right' }],
  ['proxy connect booleans off', () => ({ facts: withSelinux(elHost(), { booleans: booleans({ httpd_graceful_shutdown: false }) }) }), 'selinux.proxy_connect', { list: 'decision', hostWide: true, options: ['act', 'connect', 'manual'], action: 'sebool' }],
  ['proxy connect right (connect)', () => ({ facts: withSelinux(elHost(), { booleans: booleans({ httpd_graceful_shutdown: false, httpd_can_network_connect: true }) }) }), 'selinux.proxy_connect', { list: 'right' }],
  ['db transport asked', () => ({}), 'api_config.v1_db_transport', { list: 'decision', options: ['socket', 'tcp'], defaultOption: 'socket' }],
  // B4: no local socket → TCP 127.0.0.1:3306 is the default, still a decision; the default drives what follows.
  ['db transport no socket', () => ({ facts: { ...debianHost(), mariadb: { socket: null, tcp3306: false } } }), 'api_config.v1_db_transport', { list: 'decision', defaultOption: 'tcp', fact: /no local MariaDB socket .*default is TCP 127\.0\.0\.1:3306[\s\S]*nothing listens on TCP 3306/ }],
  ['db transport socket named', () => ({}), 'api_config.v1_db_transport', { fact: /a local MariaDB socket: \/run\/mysqld\/mysqld\.sock/ }],
  ['db connect by the tcp default', () => ({ facts: { ...elHost(), mariadb: { socket: null, tcp3306: true } } }), 'selinux.db_connect', { list: 'decision', hostWide: true, action: 'sebool' }],
  ['db connect not asked with a socket default', () => ({ facts: elHost() }), 'selinux.db_connect', { absent: true }],
  ['db transport not asked once v1 exists', () => converged(), 'api_config.v1_db_transport', { absent: true }],
  ['db connect over tcp', () => ({ facts: elHost(), answers: { 'api_config.v1_db_transport': 'tcp' } }), 'selinux.db_connect', { list: 'decision', hostWide: true, action: 'sebool', after: ['api_config.v1_db_transport'] }],
  ['db connect right', () => ({ facts: withSelinux(elHost(), { booleans: booleans({ httpd_can_network_connect_db: true }) }), answers: { 'api_config.v1_db_transport': 'tcp' } }), 'selinux.db_connect', { list: 'right' }],
  ['db connect socket: absent', () => ({ facts: elHost() }), 'selinux.db_connect', { absent: true }],
  // selinux.v2_policy (spec §9.8): the v2 tree of every layout, typed by the provisioner's module
  ['v2 policy: system layout, no module yet', () => ({ facts: elHost(), draft: draft({ layout: 'system' }) }), 'selinux.v2_policy', { list: 'change', hostWide: false, command: /^semodule -X 400 -i \/var\/lib\/dedalo_publication_host\/_host\/dedalo_publication_host\.cil$/, fact: /var_t under \/srv/ }],
  ['v2 policy: an older module of ours', () => ({ facts: elHost(), draft: draft({ layout: 'system' }), declared: withModule({ listed: [{ priority: 400, lang: 'cil', disabled: false }], source: stamp(SELINUX_MODULE_KIND, '_host', '; older\n', ';') }) }), 'selinux.v2_policy', { list: 'change', fact: /older version/ }],
  ['v2 policy right (ours, current)', () => ({ facts: elHost(), draft: draft({ layout: 'system' }), declared: withModule({ listed: [{ priority: 400, lang: 'cil', disabled: false }], source: renderSelinuxModule() }) }), 'selinux.v2_policy', { list: 'right', fact: /installed and current/ }],
  ['v2 policy: a foreign module blocks', () => ({ facts: elHost(), draft: draft({ layout: 'system' }), declared: withModule({ listed: [{ priority: 100, lang: 'pp', disabled: false }], source: null }) }), 'selinux.v2_policy', { blocking: true, fact: /priority 100/, command: /semodule --list-modules=full/ }],
  // One v2 type on every layout (2026-10-09): the home layout lists it too, naming the home's own type.
  ['v2 policy: home layout, no module yet', () => ({ facts: elHost() }), 'selinux.v2_policy', { list: 'change', hostWide: false, command: /^semodule -X 400 -i \/var\/lib\/dedalo_publication_host\/_host\/dedalo_publication_host\.cil$/, fact: /the home's own type \(user_home_t\)/ }],
  ['v2 policy right on the home layout (ours, current)', () => ({ facts: elHost(), declared: withModule({ listed: [{ priority: 400, lang: 'cil', disabled: false }], source: renderSelinuxModule() }) }), 'selinux.v2_policy', { list: 'right', fact: /installed and current/ }],
  ['v2 policy: no SELinux, none', () => ({ draft: draft({ layout: 'system' }) }), 'selinux.v2_policy', { absent: true }],
  ['media on nfs4: mount option default', () => ({ facts: { ...elHost(), mounts: [...elHost().mounts, { mountPoint: '/mnt/dedalo_media', fsType: 'nfs4', readOnly: true, noexec: false, seclabel: false, context: null }] } }), 'selinux.media_access', { list: 'decision', hostWide: true, options: ['mount', 'boolean'], defaultOption: 'mount', command: /context="system_u:object_r:httpd_sys_content_t:s0"/ }],
  ['media on cifs with the boolean', () => ({ facts: { ...withSelinux(elHost(), { booleans: booleans({ httpd_use_cifs: true }) }), mounts: [...elHost().mounts, { mountPoint: '/mnt/dedalo_media', fsType: 'cifs', readOnly: true, noexec: false, seclabel: false, context: null }] } }), 'selinux.media_access', { list: 'right' }],
  ['media mount context=', () => ({ facts: { ...elHost(), mounts: [...elHost().mounts, { mountPoint: '/mnt/dedalo_media', fsType: 'nfs4', readOnly: true, noexec: false, seclabel: false, context: '"system_u:object_r:httpd_sys_content_t:s0"' }] } }), 'selinux.media_access', { list: 'right' }],
  ['media local shared unlabelled', () => ({ facts: elHost() }), 'selinux.media_access', { list: 'decision', hostWide: true, operatorFile: true, options: ['act', 'manual'] }],
  ['media local labelled', () => ({ facts: withSelinux(elHost(), { labels: new Map([['/mnt/dedalo_media', 'httpd_sys_content_t']]) }) }), 'selinux.media_access', { list: 'right' }],
  // The consent folds into the declaration (media.selinux_label), so provision apply labels it.
  ['media local shared, answered act: the consent is declared', () => ({ facts: elHost(), answers: { 'selinux.media_access': 'act' } }), 'selinux.media_access', { list: 'right', fact: /media\.selinux_label/ }],
  ['media local shared, consent in the draft', () => ({ facts: elHost(), draft: draft({ media: { mode: 'shared', root: '/mnt/dedalo_media', selinux_label: true } }) }), 'selinux.media_access', { list: 'right', fact: /provision apply registers/ }],
  ['media copy local: the provisioner labels it', () => ({ facts: elHost(), draft: draft({ media: { mode: 'copy', root: '/srv/dedalo_media' } }) }), 'selinux.media_access', { absent: true }],
  // bun.install
  ['bun change', () => ({}), 'bun.install', { list: 'change', action: 'bun_install' }],
  ['bun right', () => ({ declared: { ...declaredFresh(), bunVersion: PIN } }), 'bun.install', { list: 'right' }],
  ['bun no source', () => ({ ctx: { source: null, pin: null } }), 'bun.install', { list: 'right', fact: /no source/ }],
  ['bun no archive', () => ({ ctx: { bunArchive: null } }), 'bun.install', { blocking: true, command: /--source/ }],
  ['bun unknown asset', () => ({ ctx: { bunArchive: '/stage/bun/bun-darwin.zip' } }), 'bun.install', { blocking: true, fact: /no known Bun asset/ }],
  ['bun system ancestor problem', () => ({ draft: draft({ layout: 'system' }), declared: { ...declaredFresh(), ancestorProblems: new Map([['/opt/dedalo_publication_host/bun/bin/bun', ['/opt/dedalo_publication_host is owned by uid 1000']]]) } }), 'bun.install', { blocking: true, fact: /never chowned/ }],
  // code.install
  ['code change', () => ({}), 'code.install', { list: 'change', action: 'code_install', fact: /treeDigest/ }],
  ['code right', () => ({ declared: { ...declaredFresh(), agentTreeDigest: 'd'.repeat(64) } }), 'code.install', { list: 'right' }],
  ['code differs', () => ({ declared: { ...declaredFresh(), agentTreeDigest: 'e'.repeat(64) } }), 'code.install', { list: 'change', action: 'code_install', fact: /installed eeeeeeeeeeee/ }],
  ['code no source', () => ({ ctx: { source: null } }), 'code.install', { list: 'right' }],
  ['code dev deps', () => ({ ctx: { source: stagedSource({ devDependenciesPresent: ['typescript'] }) } }), 'code.install', { blocking: true, command: /rm -rf node_modules && sudo -u .* bun install --frozen-lockfile --production/ }],
  ['code missing deps', () => ({ ctx: { source: stagedSource({ missingDependencies: ['zod'] }) } }), 'code.install', { blocking: true, fact: /zod/ }],
  // declaration.write
  ['declaration new', () => ({}), 'declaration.write', { list: 'change', action: 'write_declaration' }],
  ['declaration up to date', () => converged(), 'declaration.write', { list: 'right' }],
  ['declaration draft differs from the host', () => ({ existing: { ...(completeDraft(draft(), debianHost()).declaration as HostDeclaration), releases_retained: 5 } }), 'declaration.write', { list: 'decision', options: ['act', 'skip'], action: 'write_declaration' }],
  ['declaration changed without a draft', () => ({ existing: { ...(completeDraft(draft(), debianHost()).declaration as HostDeclaration), releases_retained: 5 }, ctx: { args: args({ draft: null }) } }), 'declaration.write', { list: 'change' }],
  // provision.apply
  ['apply pending', () => ({}), 'provision.apply', { list: 'change', action: 'provision_apply', after: ['declaration.write'] }],
  ['apply nothing to do', () => converged(), 'provision.apply', { list: 'right' }],
  ['apply steps', () => ({ declared: { ...declaredFresh(), plan: [{ op: 'daemon-reload' }, { op: 'restart', unit: 'x' }], selinuxPending: [{ path: '/a', from: 'var_t', to: 'usr_t' }] } }), 'provision.apply', { list: 'change', fact: /relabel \/a: var_t → usr_t/ }],
  ['apply hand-edited artifact', () => ({ declared: { ...declaredFresh(), plan: { reasons: ["'/etc/x' (web_include) was edited by hand since the provisioner wrote it — move it aside or restore it"] } as never } }), 'provision.apply', { list: 'decision', options: ['manual', 'skip'], blocking: false }],
  ['apply selinux refusal', () => ({ declared: { ...declaredFresh(), plan: { reasons: ["an operator fcontext rule on '/x' has type var_t"] } as never } }), 'provision.apply', { blocking: true, command: /semanage fcontext -l -C/ }],
  ['apply refusal before the accounts', () => ({ declared: { ...declaredFresh(), plan: { reasons: ["user 'demo_agent' does not exist"] } as never } }), 'provision.apply', { list: 'change', fact: /recomputed after/ }],
  ['apply refusal on a converged host', () => converged(undefined, { plan: { reasons: ['something else'] } as never }), 'provision.apply', { blocking: true }],
  // provision.restart
  ['restart after code', () => ({}), 'provision.restart', { list: 'change', action: 'unit_restart', after: ['provision.apply', 'code.install', 'bun.install'] }],
  ['restart nothing', () => converged(), 'provision.restart', { list: 'right' }],
  [
    'restart siblings on act',
    () => ({
      draft: draft({ layout: 'system' }),
      answers: { 'declaration.shared_code': 'act' },
      declared: layout => ({ ...declaredFresh(), siblings: [{ source: '/etc/dedalo_publication_host/other.json', layout: { ...layout, instance: 'other', agentUnitName: 'dedalo-publication-host-other' } }] }),
    }),
    'provision.restart',
    { command: /systemctl restart dedalo-publication-host-other\.service/ },
  ],
  [
    'restart for a rewritten unit file the plan does not restart',
    () => ({
      declared: layout => ({ ...declaredFresh(), agentTreeDigest: 'd'.repeat(64), bunVersion: PIN, plan: [{ op: 'write', path: layout.agentUnitPath } as never] }),
    }),
    'provision.restart',
    { list: 'change', fact: /unit files change/ },
  ],
  // api_config.*
  ['v2 env missing', () => ({}), 'api_config.v2_env', { list: 'change', action: 'v2_env', after: ['provision.apply'] }],
  ['v2 env right', () => converged(), 'api_config.v2_env', { list: 'right' }],
  ['v2 env metadata', () => converged(undefined, { apiConfig: { v2: { exists: true, uid: 0, gid: 0, mode: 0o644 }, v1: { exists: true, uid: 2001, gid: 0, mode: 0o400 } } }), 'api_config.v2_env', { list: 'change', action: 'path_meta' }],
  ['v2 env metadata, group unknown', () => ({ declared: { ...declaredFresh(), apiConfig: { v2: { exists: true, uid: 0, gid: 0, mode: 0o644 }, v1: null } } }), 'api_config.v2_env', { blocking: true }],
  ['v2 env no template', () => ({ ctx: { source: null, kept: null } }), 'api_config.v2_env', { blocking: true, command: /--source/ }],
  ['v2 env from kept', () => ({ ctx: { source: null, kept: { dir: '/var/lib/dedalo_publication_host_init/demo/kept', files: { '.env.example': 'e'.repeat(64) } } } }), 'api_config.v2_env', { list: 'change' }],
  ['v1 config missing', () => ({}), 'api_config.v1_config', { list: 'change', action: 'v1_config', after: ['provision.apply', 'api_config.v1_db_transport'] }],
  ['v1 config right', () => converged(), 'api_config.v1_config', { list: 'right' }],
  ['v1 config, source without the v1 sample (a v2-only kit)', () => ({ ctx: { source: stagedSource({ v1Sample: null }) } }), 'api_config.v1_config', { blocking: true, fact: /carries no v1 sample/, command: /hostagent:pack -- --draft/ }],
  ['v2 env, source without the v1 sample (a v2-only kit)', () => ({ draft: v2Draft(), ctx: { source: stagedSource({ v1Sample: null }) } }), 'api_config.v2_env', { list: 'change', action: 'v2_env' }],
  // web.modules
  ['modules debian missing', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, modules: ['ssl_module', 'proxy_module'] } } }), 'web.modules', { list: 'change', action: 'apache_modules', command: /^a2enmod -q proxy_http proxy_fcgi headers rewrite$/ }],
  ['modules el ssl', () => ({ facts: { ...elHost(), web: { ...elHost().web, modules: ['proxy_module', 'proxy_http_module', 'proxy_fcgi_module', 'headers_module', 'rewrite_module'] } } }), 'web.modules', { blocking: true, command: /^dnf install mod_ssl$/ }],
  ['modules el commented', () => ({ facts: { ...elHost(), web: { ...elHost().web, modules: ['ssl_module', 'proxy_module', 'proxy_http_module', 'headers_module', 'rewrite_module'], modulesD: [{ file: '/etc/httpd/conf.modules.d/00-proxy.conf', line: 9, module: 'proxy_fcgi_module', commented: true }] } } }), 'web.modules', { blocking: true, fact: /00-proxy\.conf:9/ }],
  ['modules el gone', () => ({ facts: { ...elHost(), web: { ...elHost().web, modules: ['ssl_module'] } } }), 'web.modules', { blocking: true, command: /dnf reinstall httpd/ }],
  ['modules right', () => ({}), 'web.modules', { list: 'right' }],
  ['modules nginx: absent', () => ({ facts: nginx() }), 'web.modules', { absent: true }],
  // web.manual_lines / nginx_manual_map / vhost
  ['manual lines', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ manualLines: [{ line: 7, text: '  Alias /dedalo/publication/server_api/v1 /x' }] })] } } }), `web.manual_lines.${vhostSha8(vhost())}`, { list: 'decision', operatorFile: true, options: ['act', 'manual'], action: 'vhost_manual_removal' }],
  ['manual lines untrusted', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ manualLines: [{ line: 7, text: 'x' }], fileTrust: ['/etc/apache2/sites-available is group-writable'] })] } } }), `web.manual_lines.${vhostSha8(vhost())}`, { blocking: true, fact: /never edited/ }],
  ['nginx hand map, hashed', () => ({ facts: nginx({ foreignMaps: [{ file: '/etc/nginx/conf.d/dedalo_map.conf', line: 1, variable: 'dedalo_auth_key', fileSha: 'b'.repeat(64), standalone: true } as never] }) }), `web.nginx_manual_map.${sha8('/etc/nginx/conf.d/dedalo_map.conf')}`, { list: 'decision', operatorFile: true, options: ['act', 'manual'], action: 'nginx_map_seed' }],
  ['nginx hand map, not hashed', () => ({ facts: nginx({ foreignMaps: [{ file: '/etc/nginx/nginx.conf', line: 30, variable: 'dedalo_svg_csp' }] }) }), `web.nginx_manual_map.${sha8('/etc/nginx/nginx.conf')}`, { blocking: true, fact: /did not hash/ }],
  ['nginx hand map, unparsable', () => ({ facts: nginx({ foreignMaps: [{ file: '/etc/nginx/nginx.conf', line: 30, variable: 'dedalo_svg_csp', fileSha: 'b'.repeat(64), parseProblem: 'a fourth map' } as never] }) }), `web.nginx_manual_map.${sha8('/etc/nginx/nginx.conf')}`, { blocking: true, fact: /a fourth map/ }],
  ['nginx our own map file is not foreign', () => ({ facts: nginx({ foreignMaps: [{ file: '/etc/nginx/conf.d/dedalo_media_map.conf', line: 1, variable: 'dedalo_auth_key' }] }) }), `web.nginx_manual_map.${sha8('/etc/nginx/conf.d/dedalo_media_map.conf')}`, { absent: true }],
  ['vhost reference', () => ({}), `web.vhost.${vhostSha8(vhost())}`, { list: 'decision', operatorFile: true, options: ['act', 'manual'], action: 'vhost_reference', command: /^IncludeOptional \/etc\/dedalo_publication_host\/demo\/web\.apache\.conf$/ }],
  ['vhost reference nginx', () => ({ facts: nginx() }), `web.vhost.${vhostSha8(nginx().web.vhosts[0] as never)}`, { command: /^include \/etc\/dedalo_publication_host\/demo\/web\.nginx\.con\[f\];$/ }],
  ['vhost present', () => converged(), `web.vhost.${vhostSha8(vhost())}`, { list: 'right' }],
  ['vhost untrusted', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ fileTrust: ['owned by uid 1002'] })] } } }), `web.vhost.${vhostSha8(vhost())}`, { blocking: true }],
  // web.nginx_map / web.logs
  ['nginx map conf_d', () => ({ facts: nginx() }), 'web.nginx_map', { list: 'right', fact: /one map serves every instance/ }],
  ['nginx map none', () => ({ facts: nginx({ confDInHttp: false }) }), 'web.nginx_map', { list: 'decision', optional: true, blocking: false, command: /^include \/etc\/nginx\/conf\.d\/dedalo_media_map\.conf;$/ }],
  ['nginx map none by choice', () => ({ facts: nginx(), draft: draft({ web: { nginx_map: 'none' } }) }), 'web.nginx_map', { list: 'right', fact: /operator's/ }],
  ['logs outside', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ errorLog: '/var/log/apache2/example.err' })] } } }), 'web.logs', { list: 'decision', optional: true, after: ['provision.apply'] }],
  ['logs right', () => ({}), 'web.logs', { list: 'right', fact: /logrotate\.d\/dedalo_demo_web rotates \/var\/log\/apache2\/example\.org/ }],
  // owner decision 1(c): a log under the home is never the default; under a sandboxed unit (Ubuntu 26.04's
  // ProtectHome=read-only apache2.service) the unit cannot start, so nothing can be skipped.
  ['logs in the home', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ errorLog: `${HOME}/logs/error.log` })] } } }), 'web.logs', { list: 'decision', optional: false, defaultOption: 'manual', options: ['manual', 'skip'], fact: /reserves for the site/ }],
  ['logs in the home, sandboxed unit', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, unitSandbox: { ...SANDBOX, protectHome: 'read-only' }, vhosts: [vhost({ errorLog: `${HOME}/logs/error.log` })] } } }), 'web.logs', { list: 'decision', blocking: true, options: ['manual'], fact: /ProtectHome=.*cannot start/ }],
  // verify / pair / keep_ref
  ['verify after changes', () => ({}), 'verify.agent', { list: 'change', action: 'verify_agent' }],
  ['verify converged', () => converged(), 'verify.agent', { list: 'right', action: 'verify_agent' }],
  ['pair instructions', () => ({ ctx: { args: args({ noPair: true }) } }), 'pair.instructions', { list: 'decision' }],
  ['pair engine', () => converged(), 'pair.engine', { list: 'change', action: 'pair' }],
  ['keep ref', () => ({}), 'init.keep_ref', { list: 'change', action: 'keep_ref' }],
  ['keep ref no source', () => ({ ctx: { source: null } }), 'init.keep_ref', { list: 'right' }],
  // v2-only (no v1 block in the draft, or apis 'v2_only'): no PHP item at all.
  ['apis v1+v2', () => ({}), 'declaration.apis', { list: 'right', fact: /^v1 and v2: the Publication API v1 \(legacy/ }],
  ['apis v2 only', () => ({ draft: v2Draft() }), 'declaration.apis', { list: 'right', fact: /^v2 only: no PHP anywhere/ }],
  ['apis v2 only, said by apis', () => ({ draft: v2Draft({ apis: 'v2_only' }) }), 'declaration.apis', { list: 'right', fact: /^v2 only/ }],
  ['v2 only: no php mode', () => ({ draft: v2Draft() }), 'host.php_mode', { absent: true }],
  ['v2 only: no fpm install, even with none installed', () => ({ facts: { ...debianHost(), fpm: [] }, draft: v2Draft() }), 'host.fpm_install', { absent: true }],
  ['v2 only: no fpm cli', () => ({ draft: v2Draft() }), 'host.fpm_cli', { absent: true }],
  ['v2 only: no remi label', () => ({ facts: elHost(), draft: v2Draft() }), 'host.remi_label', { absent: true }],
  ['v2 only: no fpm decision with several installs', () => ({ facts: { ...elHost(), fpm: [remiFpm('8.2'), remiFpm('8.4')] }, draft: v2Draft() }), 'declaration.fpm', { absent: true }],
  ['v2 only: no v1 account decision', () => ({ draft: v2Draft() }), 'declaration.v1_user', { absent: true }],
  ['v2 only: no v1 account', () => ({ draft: v2Draft() }), 'account.v1_user', { absent: true }],
  ['v2 only: no v1 db transport', () => ({ facts: { ...elHost(), mariadb: { socket: null, tcp3306: true } }, draft: v2Draft() }), 'api_config.v1_db_transport', { absent: true }],
  ['v2 only: no v1 db connect boolean', () => ({ facts: { ...elHost(), mariadb: { socket: null, tcp3306: true } }, draft: v2Draft() }), 'selinux.db_connect', { absent: true }],
  ['v2 only: no v1 config', () => ({ draft: v2Draft() }), 'api_config.v1_config', { absent: true }],
  ['v2 only: the v2 env stays', () => ({ draft: v2Draft() }), 'api_config.v2_env', { list: 'change', action: 'v2_env' }],
  ['v2 only: proxy_fcgi is not needed', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, modules: ['ssl_module', 'proxy_module', 'proxy_http_module', 'headers_module', 'rewrite_module'] } }, draft: v2Draft() }), 'web.modules', { list: 'right', fact: /^ssl, proxy, proxy_http, headers, rewrite are loaded$/ }],
  ['v1: proxy_fcgi is needed', () => ({ facts: { ...debianHost(), web: { ...debianHost().web, modules: ['ssl_module', 'proxy_module', 'proxy_http_module', 'headers_module', 'rewrite_module'] } } }), 'web.modules', { list: 'change', command: /^a2enmod -q proxy_fcgi$/ }],
  ['v2 only: keeps no v1 sample', () => ({ draft: v2Draft() }), 'init.keep_ref', { list: 'change', fact: /the v2 API's sample/ }],
];

function sha8(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 8);
}

describe('compare: one row per §4.3 branch', () => {
  for (const [name, scn, id, want] of ROWS) {
    test(`${id}: ${name}`, () => {
      const { get } = run(scn());
      const row = get(id);
      if (want.absent) {
        expect(row).toBeUndefined();
        return;
      }
      if (row === undefined) throw new Error(`${id} not emitted`);
      if (want.list !== undefined) expect(row.list).toBe(want.list);
      if (want.blocking !== undefined) expect(row.blocking).toBe(want.blocking);
      if (want.hostWide !== undefined) expect(row.hostWide).toBe(want.hostWide);
      if (want.operatorFile !== undefined) expect(row.operatorFile).toBe(want.operatorFile);
      if (want.optional !== undefined) expect(row.optional).toBe(want.optional);
      if (want.options !== undefined) expect(row.options?.map(option => option.id)).toEqual([...want.options]);
      if (want.defaultOption !== undefined) expect(row.defaultOption).toBe(want.defaultOption);
      if (want.fact !== undefined) expect(row.facts.join('\n')).toMatch(want.fact);
      if (want.command !== undefined) expect(row.commands.some(command => (want.command as RegExp).test(command))).toBe(true);
      if (want.action !== undefined) expect(row.action?.kind ?? null).toBe(want.action);
      if (want.after !== undefined) expect([...row.after].sort()).toEqual([...want.after].sort());
      if (row.blocking) expect(row.list).not.toBe('right');
    });
  }
});

/* ── laws over every item ────────────────────────────────────────────────────────────── */

describe('compare: a dual-stack site (address-family twins, draft.ts vhostTwins)', () => {
  const V6 = '/etc/apache2/sites-available/example.org-v6.conf';
  const v4 = (patch: Parameters<typeof vhost>[0] = {}) => vhost({ addresses: ['0.0.0.0'], ...patch });
  const v6 = (patch: Parameters<typeof vhost>[0] = {}) => vhost({ addresses: ['[::]'], realpath: V6, file: V6, fileSha: 'b'.repeat(64), ...patch });
  const site = (...vhosts: ReturnType<typeof vhost>[]): Scn => ({ facts: { ...debianHost(), web: { ...debianHost().web, vhosts } } });

  test('twins in TWO files: one web.vhost item per file — its own path, sha, opener, transaction; the ids differ', () => {
    const { get, items, completion } = run(site(v4(), v6()));
    expect(completion.decisions.find(row => row.id === 'declaration.vhost')).toBeUndefined();
    const ids = items.filter(row => row.id.startsWith('web.vhost.')).map(row => row.id);
    expect(ids).toEqual([`web.vhost.${vhostSha8(v4())}`, `web.vhost.${vhostSha8(v6())}`]);
    const first = get(ids[0] as string);
    const second = get(ids[1] as string);
    expect(first?.action).toEqual({ kind: 'vhost_reference', path: v4().realpath, beforeSha: 'a'.repeat(64), server: 'apache', edit: 'reference', line: 2 });
    expect(second?.action).toEqual({ kind: 'vhost_reference', path: V6, beforeSha: 'b'.repeat(64), server: 'apache', edit: 'reference', line: 2 });
    for (const row of [first, second]) {
      expect(row).toMatchObject({ list: 'decision', operatorFile: true, defaultOption: 'act' });
      expect(row?.facts.join('\n')).toContain('serve one site on two address families: each block gets the include, one configtest-and-rollback transaction per file');
    }
    // The report names both blocks, every address.
    expect(get('declaration.vhost')?.facts[0]).toBe(`${v4().realpath}:2 port 443 on 0.0.0.0 (TLS) + ${V6}:2 port 443 on [::] (TLS)`);
  });

  test('twins in ONE file: ONE item, both openers (alsoLines), a diff with both insertions; the reference text is what web_edit inserts at each', () => {
    const { items, get } = run(site(vhost({ addresses: ['*'], line: 2 }), vhost({ addresses: ['[::]'], line: 20 })));
    expect(items.filter(row => row.id.startsWith('web.vhost.')).map(row => row.id)).toEqual([`web.vhost.${vhostSha8(vhost())}`]);
    const row = get(`web.vhost.${vhostSha8(vhost())}`);
    expect(row?.action).toEqual({ kind: 'vhost_reference', path: vhost().realpath, beforeSha: 'a'.repeat(64), server: 'apache', edit: 'reference', line: 2, alsoLines: [20] });
    const hunks = (row?.diff?.unified ?? '').split('\n').filter(line => line.startsWith('@@'));
    expect(hunks).toEqual(['@@ -2,0 +3,2 @@', '@@ -20,0 +23,2 @@']);
    const text = ['<VirtualHost *:443>', '  ServerName example.org', '</VirtualHost>', '<VirtualHost [::]:443>', '  ServerName example.org', '</VirtualHost>', ''].join('\n');
    const both = insertApacheReference(insertApacheReference(text, INSTANCE, '/etc/dedalo_publication_host/demo/web.apache.conf', 4), INSTANCE, '/etc/dedalo_publication_host/demo/web.apache.conf', 1);
    expect(both.split('\n').filter(line => line.trim() === row?.commands?.[1])).toHaveLength(2);
  });

  test('a twin that already holds the reference: right for it, the item only for the other (in its file, or alone in a shared file)', () => {
    const split = run(site(v4({ ourReference: true }), v6()));
    expect(split.get(`web.vhost.${vhostSha8(v4())}`)?.list).toBe('right');
    expect(split.get(`web.vhost.${vhostSha8(v6())}`)?.list).toBe('decision');
    const shared = run(site(vhost({ addresses: ['*'], ourReference: true }), vhost({ addresses: ['[::]'], line: 20 })));
    expect(shared.get(`web.vhost.${vhostSha8(vhost())}`)?.action).toEqual({ kind: 'vhost_reference', path: vhost().realpath, beforeSha: 'a'.repeat(64), server: 'apache', edit: 'reference', line: 20 });
    const done = run(site(v4({ ourReference: true }), v6({ ourReference: true })));
    expect([done.get(`web.vhost.${vhostSha8(v4())}`)?.list, done.get(`web.vhost.${vhostSha8(v6())}`)?.list]).toEqual(['right', 'right']);
  });

  test("a twin's own hand-written lines, an untrusted twin file, and a twin's logs are judged like the chosen vhost's", () => {
    const manual = run(site(v4(), v6({ manualLines: [{ line: 5, text: '  Alias /dedalo/publication/server_api/v1 /x' }] })));
    const removal = manual.get(`web.manual_lines.${vhostSha8(v6())}`);
    expect(removal?.action).toEqual({ kind: 'vhost_manual_removal', path: V6, beforeSha: 'b'.repeat(64), server: 'apache', edit: 'remove_manual', lines: [5] });
    expect(manual.get(`web.vhost.${vhostSha8(v6())}`)?.after).toContain(`web.manual_lines.${vhostSha8(v6())}`);
    const untrusted = run(site(v4(), v6({ fileTrust: ['owned by uid 1002'] })));
    expect(untrusted.get(`web.vhost.${vhostSha8(v6())}`)).toMatchObject({ blocking: true });
    expect(untrusted.get(`web.vhost.${vhostSha8(v4())}`)?.list).toBe('decision');
    const logs = run(site(v4(), v6({ errorLog: '/var/log/apache2/example.err' }))).get('web.logs');
    expect(logs?.list).toBe('decision');
    expect(logs?.facts).toContain(`${V6}: /var/log/apache2/example.err`);
  });

  test('a :80 redirect-only block beside the site gets nothing', () => {
    const redirect = vhost({ port: 80, ssl: false, redirectOnly: true, addresses: ['*', '[::]'], realpath: '/etc/apache2/sites-available/example.org.conf' });
    const { items } = run(site(redirect, vhost({ addresses: ['*', '[::]'] })));
    expect(items.filter(row => row.id.startsWith('web.vhost.')).map(row => row.id)).toEqual([`web.vhost.${vhostSha8(vhost())}`]);
  });
});

describe('compare: laws', () => {
  test('a converged host compares all right (the second run of init_run case 1), except the pairing call', () => {
    const { items } = run(converged());
    const open = items.filter(row => row.list !== 'right').map(row => row.id);
    expect(open).toEqual(['pair.engine']);
  });

  test('every emitted id is in the catalog, in catalog order, unique', () => {
    const fresh = run().items;
    const ids = fresh.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isKnownItemId(id)).toBe(true);
    const order = ids.filter(id => (ITEM_IDS as readonly string[]).includes(id)).map(id => (ITEM_IDS as readonly string[]).indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(isKnownItemId('web.vhost.0123abcd')).toBe(true);
    expect(isKnownItemId('web.vhost.xyz')).toBe(false);
    expect(isKnownItemId('host.nothing')).toBe(false);
  });

  test('every id and option any row produced round-trips through --decide; every catalog id too', () => {
    expect(ALL.length).toBeGreaterThan(ROWS.length * 20);
    const seen = new Set<string>();
    for (const row of ALL) {
      for (const option of row.options ?? [{ id: 'manual' }]) {
        const key = `${row.id}=${option.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const parsed = parseInitArgs([INSTANCE, '--decide', key]);
        if ('error' in parsed) throw new Error(`${key}: ${parsed.error}`);
        expect(parsed.decide.get(row.id)).toBe(option.id);
      }
    }
    for (const id of ITEM_IDS) expect('error' in parseInitArgs([INSTANCE, '--decide', `${id}=manual`])).toBe(false);
  });

  test("`after` names only items emitted EARLIER in the same list (dependency order)", () => {
    for (const [, scn] of ROWS) {
      const items = run(scn()).items;
      items.forEach((row, index) => {
        for (const dep of row.after) {
          const at = items.findIndex(other => other.id === dep);
          expect(at).toBeGreaterThanOrEqual(0);
          expect(at).toBeLessThan(index);
        }
      });
    }
  });

  test('the --yes law: a hostWide or operatorFile item is never a plain change; a decision offers options; a default is one of them', () => {
    for (const row of ALL) {
      if (row.hostWide || row.operatorFile) expect(row.list).not.toBe('change');
      if (row.list === 'decision') expect((row.options ?? []).length).toBeGreaterThan(0);
      if (row.defaultOption !== undefined) expect(row.options?.map(option => option.id)).toContain(row.defaultOption);
      for (const option of Object.keys(row.optionActions ?? {})) expect(row.options?.map(choice => choice.id)).toContain(option);
    }
  });

  test('P2 typed law: every acting option that edits an operator file, sets a boolean or is host-wide is marked typed AT THE PRODUCER', () => {
    const problems = [...new Set(ALL.flatMap(row => typedMarkProblems(row)))];
    expect(problems).toEqual([]);
    // Anti-vacuity: the scenarios really emit each compare-side typed kind as a decision option.
    const seen = new Set<string>();
    for (const row of ALL) {
      for (const option of row.options ?? []) {
        const action = row.optionActions?.[option.id] ?? (option.resolves === 'act' ? row.action : undefined);
        if (action !== undefined && option.confirm === 'typed') seen.add(action.kind);
      }
    }
    for (const kind of TYPED_ACTION_KINDS.filter(kind => kind !== 'pair_package_remove')) expect(seen).toContain(kind);
    // And such a decision is never resolved by Enter nor as "the only option".
    for (const row of ALL.filter(row => row.list === 'decision' && (row.options ?? []).some(option => option.confirm === 'typed'))) {
      const kind = classifyDecision(row).kind;
      expect(kind === 'typed' || kind === 'needs_action').toBe(true);
    }
  });

  test('operator-file edits carry {path, beforeSha, edit}, never the new bytes', () => {
    const edits = ALL.map(row => row.action).filter((action): action is Extract<InitAction, { kind: 'vhost_reference' | 'vhost_manual_removal' | 'nginx_map_seed' }> =>
      action !== undefined && ['vhost_reference', 'vhost_manual_removal', 'nginx_map_seed'].includes(action.kind),
    );
    expect(new Set(edits.map(action => action.kind)).size).toBe(3);
    for (const action of edits) {
      expect(action.beforeSha).toMatch(/^[0-9a-f]{64}$/);
      expect(action.path.startsWith('/')).toBe(true);
      expect(Object.keys(action).sort()).not.toContain('after');
    }
    const reference = run().get(`web.vhost.${vhostSha8(vhost())}`);
    expect(reference?.action).toEqual({ kind: 'vhost_reference', path: vhost().realpath, beforeSha: vhost().fileSha, server: 'apache', edit: 'reference', line: vhost().line });
    expect(reference?.diff?.unified).toContain('+IncludeOptional /etc/dedalo_publication_host/demo/web.apache.conf');
    const removal = run(ROWS.find(([name]) => name === 'manual lines')?.[1]()).get(`web.manual_lines.${vhostSha8(vhost())}`);
    expect(removal?.action).toEqual({ kind: 'vhost_manual_removal', path: vhost().realpath, beforeSha: vhost().fileSha, server: 'apache', edit: 'remove_manual', lines: [7] });
    expect(removal?.diff?.unified).toContain('-  Alias /dedalo/publication/server_api/v1 /x');
  });

  test('the reference lines shown are exactly the lines web_edit.ts inserts (apache and nginx)', () => {
    const apache = run().get(`web.vhost.${vhostSha8(vhost())}`);
    const text = '<VirtualHost *:443>\n  ServerName example.org\n</VirtualHost>\n';
    const edited = insertApacheReference(text, INSTANCE, '/etc/dedalo_publication_host/demo/web.apache.conf', 1);
    expect(edited.split('\n').slice(1, 3).map(line => line.trim())).toEqual([...(apache?.commands ?? [])]);
    const host = nginx();
    const nginxItem = run({ facts: host }).get(`web.vhost.${vhostSha8(host.web.vhosts[0] as never)}`);
    const block = 'server {\n  server_name example.org;\n}\n';
    const nginxEdited = insertNginxReference(block, INSTANCE, '/etc/dedalo_publication_host/demo/web.nginx.conf', 1);
    expect(nginxEdited.split('\n').slice(1, 3).map(line => line.trim())).toEqual([...(nginxItem?.commands ?? [])]);
  });

  test('write_declaration carries canonicalDeclaration(the completed declaration); its diff is against the existing one', () => {
    const fresh = run();
    const write = fresh.get('declaration.write');
    const body = canonicalDeclaration(fresh.completion.declaration as HostDeclaration);
    expect(write?.action).toEqual({ kind: 'write_declaration', body });
    expect(write?.diff?.path).toBe('/etc/dedalo_publication_host/demo.json');
    expect(write?.diff?.unified).toContain('+  "instance": "demo",');
    const existing = { ...(fresh.completion.declaration as HostDeclaration), releases_retained: 5 };
    const changed = run({ existing, ctx: { args: args({ draft: null }) } }).get('declaration.write');
    expect(changed?.diff?.unified).toContain('-  "releases_retained": 5');
  });

  test('option-specific actions: the second option of a boolean decision acts differently', () => {
    const proxy = run({ facts: withSelinux(elHost(), { booleans: booleans({ httpd_graceful_shutdown: false }) }) }).get('selinux.proxy_connect');
    expect(proxy?.action).toEqual({ kind: 'sebool', name: 'httpd_can_network_relay', value: true, previous: false });
    expect(proxy?.optionActions?.connect).toEqual({ kind: 'sebool', name: 'httpd_can_network_connect', value: true, previous: false });
    const home = run({ facts: elHost() }).get('selinux.home_traverse');
    expect(home?.action).toBeUndefined();
    expect(home?.optionActions?.boolean).toEqual({ kind: 'sebool', name: 'httpd_enable_homedirs', value: true, previous: false });
    expect(home?.optionCommands?.boolean).toEqual(['setsebool -P httpd_enable_homedirs on']);
  });

  test('home.root states the widening, the world-readable files, the other owners and the dotfile consequence', () => {
    const declared = declaredFresh();
    const many = Array.from({ length: 25 }, (_, i) => `public_html/f${i}.html`);
    const item = run({ declared: { ...declared, home: { ...declared.home, worldReadable: many.slice(0, 20), worldReadableCount: 25, poolRefs: ['/etc/php/8.2/fpm/pool.d/site.conf: chdir = /home/example.org'] } } }).get('home.root');
    const text = item?.facts.join('\n') ?? '';
    expect(text).toMatch(/gain r-x/);
    expect(text).toMatch(/f19\.html … and 5 more/);
    expect(text).toMatch(/public_html \(site\)/);
    expect(text).toMatch(/\.bash_history, \.cache, \.config, \.ssh/);
    expect(text).toMatch(/pool\.d\/site\.conf/);
    expect(item?.action).toEqual({ kind: 'path_meta', path: HOME, uid: 0, gid: 0, mode: HOME_ROOT_MODE });
    // A 0755 home owned by the user: ownership changes, no widening.
    const same = run({ declared: { ...declared, home: { ...declared.home, facts: { type: 'dir', uid: 1002, gid: 1002, mode: 0o755 } } } }).get('home.root');
    expect(same?.list).toBe('change');
    expect(same?.facts.join('\n')).not.toMatch(/widens/);
  });

  test('without a valid declaration only what can be judged is emitted (no account/home/apply items)', () => {
    const { items } = run({ facts: { ...debianHost(), work: [] }, declared: null });
    const areas = new Set(items.map(row => row.area));
    expect(areas.has('account')).toBe(false);
    expect(areas.has('provision')).toBe(false);
    expect(items.find(row => row.id === 'declaration.fields')?.blocking).toBe(true);
  });

  test('unknownAnswers: an unknown id or an unoffered option is USAGE; a stale answer to a settled item is not', () => {
    const { items } = run();
    expect(unknownAnswers(items, new Map([['declaration.layout', 'home']]))).toEqual([]);
    expect(unknownAnswers(items, new Map([['host.nothing', 'act']]))[0]).toMatch(/no such item/);
    expect(unknownAnswers(items, new Map([['declaration.layout', 'cloud']]))[0]).toMatch(/the options are home, system/);
    expect(unknownAnswers(items, new Map([['declaration.layout_dirs', 'relocate']]))).toEqual([]);
    expect(unknownAnswers(items, new Map([['web.vhost.zzzzzzzz', 'act']]))[0]).toMatch(/no such item/);
  });

  test('a recompute shows the answered decision again, so the answer stays valid', () => {
    const { items } = run({ answers: { 'declaration.layout': 'system' } });
    expect(items.find(row => row.id === 'declaration.layout')?.options?.map(option => option.id)).toEqual(['home', 'system']);
    expect(items.some(row => row.area === 'home')).toBe(false);
  });

  test('EL fresh host, enforcing: the SELinux items appear in §4.3 order before bun/code', () => {
    const ids = run({ facts: elHost() }).items.map(row => row.id);
    const at = (id: string) => ids.indexOf(id);
    expect(at('selinux.home_traverse')).toBeGreaterThan(at('home.root'));
    expect(at('selinux.media_access')).toBeLessThan(at('bun.install'));
    expect(at('api_config.v1_db_transport')).toBeLessThan(at('api_config.v1_config'));
    expect(ids).toContain('host.remi_label');
  });

  test('two FPM installs on EL: the AppStream one below the floor is not an option', () => {
    const { get } = run({ facts: { ...elHost(), fpm: [appStreamFpm('8.0'), remiFpm('8.2'), remiFpm('8.4')] } });
    expect(get('declaration.fpm')?.options?.map(option => option.id)).toEqual(['remi-8-2', 'remi-8-4']);
  });
});
