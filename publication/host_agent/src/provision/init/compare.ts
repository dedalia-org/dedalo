/**
 * THE COMPARISON (spec §4, B2): host facts + the completed draft + the facts about the declared
 * layout → the item list, in §4.3's dependency order, every item under a FIXED id
 * (`--decide <id>=<option>` names it; ITEM_IDS is the catalog, tests/init_compare.test.ts runs
 * every emitted id and option through parseInitArgs). Three lists: `right` (nothing to do),
 * `change` (init will do it; `--yes` applies it unless `operatorFile`/`hostWide`), `decision`
 * (the operator answers; `blocking` ones stop the run until answered by an option that acts).
 *
 * Laws this module keeps:
 *   - It never acts and never reads: facts arrive as values (observe.ts, P2), the answers ride
 *     the completion (draft.ts). An item that would need a fact the contract does not carry is a
 *     blocking decision naming the missing fact — never a guess, never silently dropped.
 *   - Operator files are edited only by `{path, beforeSha, edit}` actions: act re-reads the file,
 *     requires the sha, computes the bytes (web_edit.ts) — compare never holds an `after` text.
 *   - The declaration body is canonicalDeclaration(decl) (layout.ts), the one writer.
 *   - A boolean or a label on an operator path is `hostWide` (never `--yes`); per-instance
 *     declarative labels (the exact home directory rule) are changes applied by provision apply.
 *   - An option whose action differs from the item's default carries it in `optionActions`
 *     (ComparedItem, a widening of types.ts Item — see the module's open issue).
 *
 * PURE, ZERO-DEPENDENCY: node: builtins, layout.ts, selinux.ts, the init contract and the pure
 * helpers it reuses (draft.ts, diff.ts, parse/*, pair.ts's planners).
 */
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { APACHE_MODULES, BUN_ASSETS, NOLOGIN_SHELLS } from '../exec_contract';
import type { SelinuxBoolean } from '../exec_contract';
import type { AgentLayout, HostDeclaration } from '../layout';
import {
  BUN_KERNEL_FLOOR,
  DEFAULT_PATHS,
  FAPOLICYD_CONF,
  FAPOLICYD_TRUST_DIR,
  TRUST_UNIT_PREFIX,
  trustFileName,
  HOME_RELOCATED_NAMES,
  HOME_ROOT_MODE,
  MODES,
  NGINX_FLOOR,
  PUBHOST_GROUP,
  SYSTEMD_FLOOR,
  V1_PHP_FLOOR,
  canonicalDeclaration,
} from '../layout';
import { INIT_BASE } from '../lock';
import { HOME_TRAVERSE_TYPE, HTTPD_READABLE_TYPES, escapeSpec, isHomeLayout, moduleNeeded } from '../selinux';
import { FOREIGN_MODULE_HINT, SELINUX_MODULE_NAME, SELINUX_MODULE_PRIORITY, V2_TREE_TYPE, installedModule, selinuxModulePath } from '../selinux_module';
import { unifiedDiff, lineEditDiff } from './diff';
import type { DraftCompletion, DraftDecision } from './draft';
import {
  describeVhost,
  fpmCandidates,
  homeCannotBeRoot,
  isNetworkFs,
  layoutDecisionFor,
  modeText,
  mountOf,
  sandboxHides,
  selinuxRegisters,
  versionAtLeast,
  vhostSha8,
} from './draft';
import { pairItem, pairPlan } from './pair';
import { REFERENCE_MARKER } from './web_edit';
import { soleMemberProblem } from './parse/accounts';
import { unsupportedReason } from './parse/os';
import { STRICT_INTEGRITY } from './parse/fapolicyd';
import { POLKIT_DBUS_SERVICE, POLKIT_JS_FLOOR, POLKIT_UNIT } from './parse/polkit';
import type {
  Action,
  CompareCtx,
  DeclaredFacts,
  FpmInstall,
  HostFacts,
  InitAction,
  Item,
  ItemArea,
  ItemList,
  ItemOption,
  MapDef,
  Vhost,
} from './types';
import { ITEM_ID_PATTERN } from './types';
import { MARIADB_SOCKET_CANDIDATES, MARIADB_TCP_HOST, MARIADB_TCP_PORT } from './constants';

/**
 * What allow_filesystem_mark = 1 does to polkit (measured, RHEL 10.2 two-machine drill, 2026-10-09):
 * polkit.service is sandboxed, so fapolicyd starts checking polkitd, which reads its rules files as
 * language files (application/javascript). fapolicyd-filter.conf leaves /usr/share out of the rpm
 * trust, so at polkit's next reload the distribution's own rules stop loading — host-wide. The
 * agent's own rule is in the instance's trust file (fapolicyd_trust.ts), so the agent keeps its grant.
 */
const FAPOLICYD_POLKIT_FACT =
  "with allow_filesystem_mark = 1 fapolicyd also checks the sandboxed polkit.service: polkitd reads its rules as language files, and the distribution's own rules (/usr/share/polkit-1/rules.d, left out of the rpm trust by fapolicyd-filter.conf) stop loading at polkit's next reload, host-wide (measured, RHEL 10.2: journalctl -u polkit shows 'Error loading script'); this instance's own polkit rule is in its trust file, so the agent keeps its grant";

/* ── the item catalog ─────────────────────────────────────────────────────────────── */

/**
 * An Item, plus what an option other than the default does. GAP (types.ts is P1's): Item carries
 * one `action`, so a decision whose options act differently (`selinux.proxy_connect` relay vs
 * connect, `selinux.home_traverse` boolean, `selinux.media_access` boolean) states the others here.
 */
export interface ComparedItem extends Item {
  readonly optionActions?: Readonly<Record<string, InitAction>>;
  readonly optionCommands?: Readonly<Record<string, readonly string[]>>;
}

/** Every fixed id compare may emit (spec §4.3), in dependency order. */
export const ITEM_IDS = Object.freeze([
  'host.os',
  'host.panel',
  'host.systemd',
  'host.polkit',
  'host.sudo',
  'host.web',
  'host.php_mode',
  'host.fpm_install',
  'host.web_version',
  'host.kernel',
  'host.noexec',
  'host.fapolicyd',
  'host.fapolicyd_integrity',
  'host.fapolicyd_mounts',
  'host.unit_sandbox',
  'host.remi_label',
  'host.fpm_cli',
  'host.cpu',
  'host.tools',
  'host.chattr',
  'host.nss',
  'host.selinux',
  'host.selinux_tools',
  'host.root_context',
  'declaration.fields',
  'declaration.apis',
  'declaration.layout',
  'declaration.fpm',
  'declaration.vhost',
  'declaration.work_unit',
  'declaration.v2_port',
  'declaration.home',
  'declaration.v1_user',
  'declaration.state_root',
  'declaration.layout_dirs',
  'declaration.shared_code',
  'account.pubhost_group',
  'account.v2_group',
  'account.agent_user',
  'account.v2_user',
  'account.v1_user',
  'account.engine_group',
  'home.root',
  'selinux.home_traverse',
  'selinux.proxy_connect',
  'api_config.v1_db_transport',
  'selinux.db_connect',
  'selinux.media_access',
  'selinux.v2_policy',
  'bun.install',
  'code.install',
  'declaration.write',
  'provision.apply',
  'provision.restart',
  'api_config.v2_env',
  'api_config.v1_config',
  'web.modules',
  'web.nginx_map',
  'web.logs',
  'verify.agent',
  'pair.engine',
  'pair.package',
  'pair.instructions',
  'init.keep_ref',
] as const);

/** The id families keyed by a sha8 (spec §4.3 items 13-15). */
export const ITEM_ID_FAMILIES = Object.freeze(['web.manual_lines.', 'web.nginx_manual_map.', 'web.vhost.'] as const);

export function isKnownItemId(id: string): boolean {
  if ((ITEM_IDS as readonly string[]).includes(id)) return true;
  return ITEM_ID_FAMILIES.some(prefix => id.startsWith(prefix) && /^[0-9a-f]{8}$/.test(id.slice(prefix.length)));
}

/**
 * The USAGE check of the answers (spec §1.2 `--decide`: an unknown id or option is USAGE): an id
 * outside the catalog, or an option the emitted decision does not offer. An answer to an item a
 * recompute made `right` (a relocation done) is not an error: it was valid when given.
 */
export function unknownAnswers(items: readonly Item[], answers: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [id, option] of answers) {
    if (!isKnownItemId(id)) {
      problems.push(`--decide ${id}: no such item`);
      continue;
    }
    const item = items.find(row => row.id === id);
    if (item?.options === undefined || item.options.length === 0) continue;
    if (!item.options.some(row => row.id === option)) {
      problems.push(`--decide ${id}=${option}: the options are ${item.options.map(row => row.id).join(', ')}`);
    }
  }
  return problems;
}

/* ── builders ─────────────────────────────────────────────────────────────────────── */

const MANUAL: ItemOption = Object.freeze({ id: 'manual', label: 'I will do it by hand (the commands are printed)', resolves: 'manual' });
const ACT: ItemOption = Object.freeze({ id: 'act', label: 'do it', resolves: 'act' });
const SKIP: ItemOption = Object.freeze({ id: 'skip', label: 'leave it as it is', resolves: 'skip' });
/**
 * `act`, answered only by typing it (decision_class.ts): the option edits an operator file or sets
 * an SELinux boolean / label on the operator's path — Enter never takes it as a default.
 */
const ACT_TYPED: ItemOption = Object.freeze({ ...ACT, confirm: 'typed' });

type Draft = { -readonly [K in keyof ComparedItem]: ComparedItem[K] };

function item(id: string, area: ItemArea, list: ItemList, title: string, extra: Partial<Draft> = {}): ComparedItem {
  if (!ITEM_ID_PATTERN.test(id)) throw new Error(`compare: item id '${id}' breaks ${ITEM_ID_PATTERN.source}`);
  return Object.freeze({
    id,
    area,
    list,
    title,
    facts: [],
    commands: [],
    after: [],
    blocking: false,
    optional: false,
    operatorFile: false,
    hostWide: false,
    ...extra,
  });
}

function right(id: string, area: ItemArea, title: string, facts: readonly string[] = [], extra: Partial<Draft> = {}): ComparedItem {
  return item(id, area, 'right', title, { facts: [...facts], ...extra });
}

/** A decision only the operator can settle by hand: init stops until it is (spec §4.1 `manual`). */
function blocked(id: string, area: ItemArea, title: string, facts: readonly string[], commands: readonly string[] = [], extra: Partial<Draft> = {}): ComparedItem {
  return item(id, area, 'decision', title, {
    facts: [...facts],
    commands: [...commands],
    options: [MANUAL],
    defaultOption: 'manual',
    blocking: true,
    ...extra,
  });
}

function fromDecision(decision: DraftDecision, after: readonly string[] = []): ComparedItem {
  return item(decision.id, decision.area, 'decision', decision.title, {
    facts: [...decision.facts],
    commands: [...decision.commands],
    options: [...decision.options],
    ...(decision.defaultOption === undefined ? {} : { defaultOption: decision.defaultOption }),
    blocking: decision.blocking,
    after: [...after],
  });
}

function sha8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

function selinuxType(context: string | null | undefined): string | null {
  return context?.split(':')[2] ?? null;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The value of a dotted declaration field, as the `declaration.fields` line prints it. */
function fieldValue(decl: HostDeclaration, field: string): string {
  let value: unknown = decl;
  for (const key of field.split('.')) value = (value as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function describeAction(action: Action): string {
  if ('path' in action) return `${action.op} ${action.path}`;
  if ('unit' in action) return `${action.op} ${action.unit}`;
  return action.op;
}

/**
 * The reference comment as web_edit.ts writes it (its marker is web_edit's; the tail is restated
 * until web_edit exports the whole line — open issue to P6). Shown only: act computes the bytes.
 */
const referenceComment = (instance: string) => `# ${REFERENCE_MARKER(instance)} — managed by \`provision init\`; delete both lines to detach`;

/* ── fapolicyd ───────────────────────────────────────────────────────────────────── */

/** `<key> = <value>` in fapolicyd.conf: a line that sets the key is replaced, else one is added. */
function fapolicydSet(key: string, value: string): string {
  return `grep -qE '^[[:space:]]*${key}[[:space:]]*=' ${FAPOLICYD_CONF} && sed -i -E 's/^[[:space:]]*${key}[[:space:]]*=.*/${key} = ${value}/' ${FAPOLICYD_CONF} || echo '${key} = ${value}' >> ${FAPOLICYD_CONF}`;
}

/** `integrity = sha256`, then the restart that reads it. */
export const FAPOLICYD_INTEGRITY_COMMANDS: readonly string[] = Object.freeze([fapolicydSet('integrity', 'sha256'), 'systemctl try-restart fapolicyd']);
/** `allow_filesystem_mark = 1`, then the restart that reads it. */
export const FAPOLICYD_MOUNTS_COMMANDS: readonly string[] = Object.freeze([fapolicydSet('allow_filesystem_mark', '1'), 'systemctl try-restart fapolicyd']);

function fapolicydItems(facts: HostFacts, layout: AgentLayout | null, decl: HostDeclaration | null): ComparedItem[] {
  const fapolicyd = facts.fapolicyd;
  if (!fapolicyd.installed) return [right('host.fapolicyd', 'host', 'fapolicyd', ['fapolicyd is not installed'])];
  const instance = layout?.instance ?? decl?.instance ?? '<instance>';
  const unit = `${TRUST_UNIT_PREFIX}${instance}.service`;
  const file = join(FAPOLICYD_TRUST_DIR, trustFileName(instance));
  const conf = fapolicyd.conf;
  if (conf === null) {
    return [
      blocked('host.fapolicyd', 'host', 'fapolicyd', [`fapolicyd is installed but ${FAPOLICYD_CONF} could not be read: whether it reads ${FAPOLICYD_TRUST_DIR} cannot be judged`], [`fapolicyd-cli --check-config`], { hostWide: true }),
    ];
  }
  const out: ComparedItem[] = [];
  if (!conf.trust.includes('file')) {
    out.push(
      blocked(
        'host.fapolicyd',
        'host',
        'fapolicyd',
        [`fapolicyd's trust = ${conf.trust.join(',') || '(empty)'} has no 'file' backend: it never reads ${FAPOLICYD_TRUST_DIR}, so the agent and its releases would stay untrusted — add it, then answer manual`],
        [`sed -i -E 's/^([[:space:]]*trust[[:space:]]*=[[:space:]]*)(.*)$/\\1\\2,file/' ${FAPOLICYD_CONF}`, 'systemctl try-restart fapolicyd'],
        { hostWide: true },
      ),
    );
  } else {
    out.push(
      right('host.fapolicyd', 'host', 'fapolicyd', [
        `fapolicyd is installed (${fapolicyd.active ? 'running' : 'not running'}; trust = ${conf.trust.join(',')})`,
        `trust is automatic: provision apply writes ${file} (bun_bin, agent_dir and each served API's current and previous release) and renders ${unit}, the one unit the agent may start — after every release install or rollback; nothing to run by hand`,
      ]),
    );
  }
  if (conf.filesystemMark) {
    out.push(right('host.fapolicyd_mounts', 'host', 'fapolicyd and the services', ['allow_filesystem_mark = 1: fapolicyd checks what the sandboxed services open too', FAPOLICYD_POLKIT_FACT]));
  } else {
    out.push(
      item('host.fapolicyd_mounts', 'host', 'decision', 'fapolicyd and the services', {
        facts: [
          "allow_filesystem_mark = 0 (fapolicyd's default): it marks mounts, so it never sees what a service with its own mount namespace opens — the agent, v2 and the trust service (ProtectSystem=, ProtectHome=, PrivateTmp=) run unchecked, trusted or not (measured, RHEL 9.8)",
          'allow_filesystem_mark = 1 makes fapolicyd check them (recommended; host-wide: what containers and overlayfs mounts open is checked too)',
          FAPOLICYD_POLKIT_FACT,
        ],
        commands: [...FAPOLICYD_MOUNTS_COMMANDS],
        options: [MANUAL, SKIP],
        defaultOption: 'manual',
        optional: true,
        hostWide: true,
      }),
    );
  }
  if (STRICT_INTEGRITY.includes(conf.integrity)) {
    out.push(right('host.fapolicyd_integrity', 'host', 'fapolicyd integrity', [`integrity = ${conf.integrity}: a trusted file changed after it was trusted is denied`]));
  } else {
    out.push(
      item('host.fapolicyd_integrity', 'host', 'decision', 'fapolicyd integrity', {
        facts: [
          `integrity = ${conf.integrity}: fapolicyd re-checks a trusted file by ${conf.integrity === 'size' ? 'its size only' : 'its path only'} — a release or agent file changed AFTER it was trusted would still run`,
          'integrity = sha256 makes fapolicyd hash a trusted file when it is opened and deny it on any change (recommended; a host-wide setting — every trusted program pays the first hash)',
        ],
        commands: [...FAPOLICYD_INTEGRITY_COMMANDS],
        options: [MANUAL, SKIP],
        defaultOption: 'manual',
        optional: true,
        hostWide: true,
      }),
    );
  }
  return out;
}

/* ── compare ──────────────────────────────────────────────────────────────────────── */

interface Env {
  readonly facts: HostFacts;
  readonly completion: DraftCompletion;
  readonly declared: DeclaredFacts | null;
  readonly ctx: CompareCtx;
  readonly decl: HostDeclaration | null;
  readonly layout: AgentLayout | null;
  readonly answers: ReadonlyMap<string, string>;
  readonly el: boolean;
  /** SELinux permissive/enforcing on EL (labels applied, booleans read). */
  readonly selinuxOn: boolean;
  readonly pkg: 'apt' | 'dnf';
  /** EL 9: AppStream PHP/nginx are `dnf module` streams; EL 10 has none (OsSupport.dnfModules). */
  readonly dnfModules: boolean;
  /** EL 10: the one PHP version AppStream ships (OsSupport.appStreamPhp); null otherwise. */
  readonly appStreamPhp: string | null;
  readonly homeLayout: boolean;
  readonly home: string | null;
  readonly homeReasons: readonly string[];
  readonly fpm: FpmInstall | null;
  readonly vhost: Vhost | null;
  /** The chosen vhost's address-family twins (completion.vhostTwins): each gets the same include. */
  readonly vhostTwins: readonly Vhost[];
  /**
   * The instance serves the Publication API v1 (completion.servesV1). False = v2-only: no PHP item
   * at all — no FPM, PHP CLI or PHP-handler fact, no v1 account, no v1 database transport, no v1
   * configuration.
   */
  readonly v1: boolean;
}

/**
 * Spec §4: every §4.3 item that applies to this host and draft, in dependency order. `declared` is
 * null when the completion produced no valid layout (nothing declared can be observed then).
 */
export function compare(
  facts: HostFacts,
  completion: DraftCompletion,
  declared: DeclaredFacts | null,
  ctx: CompareCtx,
): ComparedItem[] {
  const layout = completion.layout;
  const el = facts.os.family === 'el';
  const site = layout?.site ?? null;
  const reasons =
    completion.declaration?.site === undefined || completion.declaration === null
      ? []
      : homeCannotBeRoot(site?.home ?? completion.declaration.site.home ?? join('/home', completion.declaration.site.domain), facts, completion.fpm, declared);
  const env: Env = {
    facts,
    completion,
    declared,
    ctx,
    decl: completion.declaration,
    layout,
    answers: completion.answers,
    el,
    selinuxOn: el && (facts.selinux.mode === 'enforcing' || facts.selinux.mode === 'permissive') && facts.selinux.policy === 'targeted',
    pkg: facts.os.support?.packageTool ?? (el ? 'dnf' : 'apt'),
    dnfModules: facts.os.support?.dnfModules ?? false,
    appStreamPhp: facts.os.support?.appStreamPhp ?? null,
    homeLayout: completion.kind === 'home' && site !== null && reasons.length === 0,
    home: site?.home ?? null,
    homeReasons: reasons,
    fpm: completion.fpm,
    vhost: completion.vhost,
    vhostTwins: completion.vhostTwins,
    v1: completion.servesV1,
  };
  const items: ComparedItem[] = [
    ...hostItems(env),
    ...declarationItems(env),
    ...accountItems(env),
    ...homeItems(env),
    ...selinuxItems(env),
  ];
  items.push(...codeItems(env, items));
  items.push(...applyItems(env, items));
  items.push(...apiConfigItems(env));
  items.push(...webItems(env));
  items.push(...tailItems(env, items));
  // `after` names only items this run emits (an absent dependency is no dependency).
  const ids = new Set(items.map(row => row.id));
  return items.map(row => (row.after.every(id => ids.has(id)) ? row : Object.freeze({ ...row, after: row.after.filter(id => ids.has(id)) })));
}

/* ── 1. host.* (never acted on) ───────────────────────────────────────────────────── */

function hostItems(env: Env): ComparedItem[] {
  const { facts, layout, decl, el, pkg } = env;
  const out: ComparedItem[] = [];
  const install = (packages: string) => `${pkg} install ${packages}`;

  // host.os
  const os = `${facts.os.id} ${facts.os.versionId}`;
  if (facts.os.supported && facts.os.support !== null) {
    out.push(right('host.os', 'host', 'operating system', [`${os}: supported (${facts.os.support.packageTool}, ${facts.os.support.apacheFlavor} Apache layout)`]));
  } else {
    // parse/os.ts names why (Ubuntu 22.04: polkit; EL 8: systemd and kernel; the rest: not supported).
    const why = unsupportedReason({ id: facts.os.id, versionId: facts.os.versionId, idLike: facts.os.family === 'el' ? ['rhel'] : [], prettyName: os }) ?? `${os} is not supported`;
    out.push(blocked('host.os', 'host', 'operating system', [why], ['docs/install/publication_host.md (the manual guide)']));
  }

  // host.panel
  out.push(
    facts.panel === null
      ? right('host.panel', 'host', 'hosting panel', ['no hosting panel found'])
      : blocked('host.panel', 'host', 'hosting panel', [`${facts.panel} manages this host: init does not act on a panel host; the manual guide applies`]),
  );

  // host.systemd
  if (facts.systemd === null || facts.systemd < SYSTEMD_FLOOR) {
    out.push(blocked('host.systemd', 'host', 'systemd', [`systemd ${facts.systemd ?? 'unknown'}: below ${SYSTEMD_FLOOR}, the oldest systemd the units are rendered for`]));
  } else {
    out.push(right('host.systemd', 'host', 'systemd', [`systemd ${facts.systemd} ≥ ${SYSTEMD_FLOOR}`]));
  }

  // host.polkit
  if (facts.polkit.version === null) {
    out.push(blocked('host.polkit', 'host', 'polkit', ['polkit is not installed: the agent reloads the web server through a polkit grant'], [install(el ? 'polkit' : 'polkitd')]));
  } else if (facts.polkit.version < POLKIT_JS_FLOOR) {
    out.push(blocked('host.polkit', 'host', 'polkit', [`polkit 0.${facts.polkit.version}: below 0.${POLKIT_JS_FLOOR}, which reads the JavaScript rules the grant is written in`]));
  } else if (facts.polkit.state === 'masked') {
    out.push(blocked('host.polkit', 'host', 'polkit', ['polkit.service is masked: nothing can start it, so every grant is refused'], ['systemctl unmask polkit.service']));
  } else if (facts.polkit.state === 'not_activatable') {
    out.push(
      blocked(
        'host.polkit',
        'host',
        'polkit',
        [`polkit is not running and the system bus cannot start it (${POLKIT_DBUS_SERVICE} does not name ${POLKIT_UNIT})`],
        [`${pkg} reinstall ${el ? 'polkit' : 'polkitd'}`, `systemctl start ${POLKIT_UNIT}`],
      ),
    );
  } else {
    // polkitd is D-Bus-activated: an idle host runs it only after the first request (parse/polkit.ts).
    out.push(right('host.polkit', 'host', 'polkit', [`polkit ${facts.polkit.version}: ${facts.polkit.state === 'running' ? 'running' : 'started on demand by the system bus'}`]));
  }

  // host.sudo
  const sudoersDir = layout === null ? DEFAULT_PATHS.sudoersDir : dirname(layout.sudoersPath);
  if (!facts.sudo.present) out.push(blocked('host.sudo', 'host', 'sudo', ['sudo is not installed: the agent runs its configtest through one sudoers rule'], [install('sudo')]));
  else if (!facts.sudo.includedir) {
    out.push(
      blocked(
        'host.sudo',
        'host',
        'sudo',
        [`${facts.sudo.policyFile} (the policy ${facts.sudo.flavor} reads) does not include ${sudoersDir}`, ...facts.sudo.skipped.map(line => `not followed: ${line}`)],
        [`visudo -f ${facts.sudo.policyFile}   # add the line: @includedir ${sudoersDir}`],
      ),
    );
  } else {
    out.push(right('host.sudo', 'host', 'sudo', [`${facts.sudo.flavor} reads ${sudoersDir} (through ${facts.sudo.policyFile})`, ...facts.sudo.skipped.map(line => `not followed: ${line}`)]));
  }

  // host.web (several servers is a completion decision)
  const webDecision = env.completion.decisions.find(row => row.id === 'host.web');
  if (webDecision !== undefined) out.push(fromDecision(webDecision));
  else if (facts.web.candidates.length === 0) {
    out.push(blocked('host.web', 'host', 'web server', ['no apache2, httpd or nginx unit was found; init never installs one'], [install(el ? 'httpd' : 'apache2')]));
  } else out.push(right('host.web', 'host', 'web server', [`${layout?.web.server ?? facts.web.server ?? facts.web.candidates[0]} (${facts.web.unit ?? 'unit unknown'})`]));

  const server = layout?.web.server ?? decl?.web.server ?? facts.web.server;
  const hasSite = env.completion.siteDomain !== null;

  // host.php_mode (apache + site + v1)
  if (server === 'apache' && hasSite && env.v1) {
    const phpFacts: string[] = [];
    if (facts.web.phpModuleOnly) {
      phpFacts.push(
        'mod_php runs under prefork with no FPM handler: `php_admin_flag engine off` in our <Directory> keeps it off the v1 tree; v1 runs in its own FPM pool',
        'proxy_fcgi must be loaded (10-proxy_h2.conf/00-proxy.conf); web.modules checks it',
      );
    } else if (facts.web.phpModule) {
      phpFacts.push('v1 runs in its own FPM pool alongside mod_php; proxy_fcgi required; the v1 <Directory> turns the module\'s engine off');
    }
    if (facts.web.globalPhpHandler !== null) {
      phpFacts.push(
        `${facts.web.globalPhpHandler.file} sends .php to its pool server-wide${facts.web.globalPhpHandler.insideIf ? ' inside <If>' : ''}; the web include's own <If> handler, merged later inside the vhost, overrides it in the v1 tree`,
      );
    }
    if (phpFacts.length === 0) phpFacts.push('no server-wide PHP handler: the web include adds v1\'s own');
    out.push(right('host.php_mode', 'host', 'how PHP runs in the web server', phpFacts));
  }

  // host.fpm_install (site + v1)
  if (hasSite && env.v1) {
    const candidates = fpmCandidates(facts);
    const below = facts.fpm.filter(row => !candidates.includes(row));
    const belowFact = below.map(row => `${row.flavor} PHP ${row.version} (${row.unit}) is below the v1 floor ${V1_PHP_FLOOR}: not a candidate`);
    const declaredFpm = decl?.site?.fpm;
    if (facts.fpm.length === 0) {
      // EL 9's default AppStream PHP is 8.0, below the floor: the module stream is the only command that works
      out.push(blocked('host.fpm_install', 'host', 'PHP-FPM', ['no PHP-FPM is installed: v1 runs in its own PHP-FPM pool (decision A)'], el ? [fpmInstallCommand('el', V1_PHP_FLOOR, env.dnfModules)] : [install('php-fpm')]));
    } else if (candidates.length === 0) {
      out.push(
        blocked(
          'host.fpm_install',
          'host',
          'PHP-FPM',
          belowFact,
          el
            ? [fpmInstallCommand('el', V1_PHP_FLOOR, env.dnfModules), `dnf install php${V1_PHP_FLOOR.replace('.', '')}-php-fpm php${V1_PHP_FLOOR.replace('.', '')}-php-cli   # the Remi alternative`]
            : [install(`php${V1_PHP_FLOOR}-fpm php${V1_PHP_FLOOR}-cli`)],
        ),
      );
    } else if (declaredFpm !== undefined && env.fpm === null && declaredFpm.flavor === 'el' && env.appStreamPhp !== null && declaredFpm.version !== env.appStreamPhp) {
      // EL 10: no module streams. AppStream's `php-fpm` is its default PHP; another version is an
      // ALTERNATIVE package `php<v>-fpm` (measured RHEL 10.2: php8.4-fpm) installing the same paths
      // (/usr/sbin/php-fpm, php-fpm.service, /etc/php-fpm.d) — flavor 'el' — and conflicting with
      // the default one: one system PHP, so over an installed el PHP it needs --allowerasing.
      const v = declaredFpm.version;
      const nn = v.replace('.', '');
      const installedEl = facts.fpm.filter(row => row.flavor === 'el');
      out.push(
        blocked(
          'host.fpm_install',
          'host',
          'PHP-FPM',
          [
            `the declared el PHP ${v} is not installed. AppStream's php-fpm is PHP ${env.appStreamPhp}; another AppStream PHP is its alternative package php${v}-fpm (the same paths, flavor 'el'), where this release ships it — \`dnf list 'php*-fpm'\` shows which`,
            ...installedEl.map(row => `php${v}-fpm replaces the installed el PHP ${row.version} (${row.unit}): one system PHP, every pool in /etc/php-fpm.d then runs PHP ${v}`),
            ...belowFact,
          ],
          [
            `dnf install ${installedEl.length > 0 ? '--allowerasing ' : ''}php${v}-fpm php${v}-cli   # AppStream's alternative package, where this release ships it`,
            `dnf install php${nn}-php-fpm php${nn}-php-cli   # or Remi, then declare site.fpm {"flavor": "remi", "version": "${v}"}`,
            `dnf install php-fpm php-cli   # or the default AppStream PHP, then declare site.fpm {"flavor": "el", "version": "${env.appStreamPhp}"}`,
          ],
        ),
      );
    } else if (declaredFpm !== undefined && env.fpm === null) {
      out.push(
        blocked('host.fpm_install', 'host', 'PHP-FPM', [`the declared ${declaredFpm.flavor} PHP ${declaredFpm.version} is not installed`, ...belowFact], [fpmInstallCommand(declaredFpm.flavor, declaredFpm.version, env.dnfModules)]),
      );
    } else {
      out.push(right('host.fpm_install', 'host', 'PHP-FPM', [...candidates.map(row => `${row.flavor} PHP ${row.version}: ${row.unit}`), ...belowFact]));
    }
  }

  // host.web_version
  if (server !== null && server !== undefined) {
    const version = facts.web.version;
    const floor = server === 'nginx' ? NGINX_FLOOR : '2.4';
    if (version === null) {
      out.push(blocked('host.web_version', 'host', 'web server version', [`the ${server} version could not be read (${facts.web.dumpBin ?? 'no binary'} -v)`]));
    } else if (!versionAtLeast(version, floor)) {
      out.push(
        blocked('host.web_version', 'host', 'web server version', [`${server} ${version} is below ${floor}`], [
          el
            ? server === 'nginx'
              ? env.dnfModules
                ? 'dnf module reset nginx && dnf module enable nginx:<stream ≥ 1.20> && dnf install nginx'
                : 'dnf upgrade nginx'
              : 'dnf upgrade httpd'
            : install(server === 'nginx' ? 'nginx' : 'apache2'),
        ]),
      );
    } else out.push(right('host.web_version', 'host', 'web server version', [`${server} ${version}`]));
  }

  // host.kernel (S8)
  if (facts.kernel.meetsFloor) out.push(right('host.kernel', 'host', 'kernel', [`${facts.kernel.release} ≥ ${BUN_KERNEL_FLOOR}, Bun's floor`]));
  else {
    out.push(
      blocked('host.kernel', 'host', 'kernel', [
        `${facts.kernel.release} is below Bun's documented floor ${BUN_KERNEL_FLOOR}: boot the distribution's own kernel (every supported release ships a newer one)`,
      ]),
    );
  }

  // host.noexec
  out.push(noexecItem(env));

  // host.fapolicyd, host.fapolicyd_integrity (owner decision 2026-10-09): the trust is AUTOMATIC —
  // provision apply writes the instance's trust file and renders the root oneshot its agent starts
  // after every release change; init only judges whether fapolicyd will read the file.
  out.push(...fapolicydItems(facts, layout, decl));

  // host.unit_sandbox
  out.push(unitSandboxItem(env));

  // host.remi_label (v1, Remi chosen, SELinux enabled)
  if (env.v1 && env.fpm?.flavor === 'remi' && env.selinuxOn) {
    const nn = env.fpm.version.replace('.', '');
    if (env.fpm.socketDirLabel === 'httpd_var_run_t') {
      out.push(right('host.remi_label', 'host', "Remi's PHP-FPM socket directory label", [`${env.fpm.socketDir} is httpd_var_run_t`]));
    } else {
      out.push(
        blocked(
          'host.remi_label',
          'host',
          "Remi's PHP-FPM socket directory label",
          [`${env.fpm.socketDir} is labelled ${env.fpm.socketDirLabel ?? '(unread)'}, not httpd_var_run_t: the package's label is broken, and it is not ours to override`],
          [`restorecon -Rv /var/opt/remi/php${nn}/run`, `dnf reinstall php${nn}-php-fpm   # when restorecon does not fix it`],
        ),
      );
    }
  }

  // host.fpm_cli (v1)
  if (env.v1 && env.fpm !== null) {
    out.push(
      env.fpm.cli === null
        ? blocked('host.fpm_cli', 'host', 'PHP CLI', [`${env.fpm.flavor} PHP ${env.fpm.version} has no CLI`], [fpmCliCommand(env.fpm.flavor, env.fpm.version)])
        : right('host.fpm_cli', 'host', 'PHP CLI', [`${env.fpm.cli}${env.fpm.cliVersion === null ? '' : ` (${env.fpm.cliVersion})`}`]),
    );
  }

  // host.cpu
  if (facts.cpu.musl) out.push(blocked('host.cpu', 'host', 'CPU and C library', ['musl libc: the pinned Bun build needs glibc']));
  else if (facts.cpu.arch === 'other') out.push(blocked('host.cpu', 'host', 'CPU and C library', ['this CPU architecture has no Bun build (x86_64 and aarch64 only)']));
  else out.push(right('host.cpu', 'host', 'CPU and C library', [facts.cpu.arch === 'x64' && !facts.cpu.avx2 ? 'x86_64 without AVX2: the baseline Bun build' : `${facts.cpu.arch}, glibc`]));

  // host.tools: unzip is blocking only when bun.install must extract an archive.
  if (facts.tools.unzip) out.push(right('host.tools', 'host', 'tools', ['unzip present']));
  else if (bunNeedsInstall(env)) out.push(blocked('host.tools', 'host', 'tools', ['unzip is missing: bun.install extracts the verified archive with it'], [install('unzip')]));
  else out.push(right('host.tools', 'host', 'tools', ['unzip is missing; nothing needs it in this run']));
  // chattr: provision apply makes the audit trail append-only (chattr +a) on every run that creates it.
  if (!facts.tools.chattr) {
    out.push(blocked('host.chattr', 'host', 'chattr', ['chattr is missing: provision apply makes the agent\'s audit trail append-only with chattr +a (e2fsprogs)'], [install('e2fsprogs')]));
  } else out.push(right('host.chattr', 'host', 'chattr', ['chattr present (the audit trail is made append-only)']));

  // host.nss
  const filesOnly = facts.nss.passwdFilesOnly && facts.nss.groupFilesOnly;
  out.push(
    right('host.nss', 'host', 'account databases (NSS)', [
      filesOnly
        ? 'passwd and group come from local files'
        : `passwd/group come from a directory service${facts.nss.sssDomains ? ' (sssd with domains)' : ''}: every account is looked up by name before it is created; the engine group is checked by hand`,
    ]),
  );

  // host.selinux / host.selinux_tools / host.root_context
  const mode = facts.selinux.mode;
  if (mode === 'absent' || mode === 'disabled') {
    const registers = selinuxRegisters(facts);
    out.push(
      right('host.selinux', 'host', 'SELinux', [
        registers ? 'SELinux disabled: rules registered for a later enable; nothing relabelled' : `SELinux ${mode}: no labels needed`,
      ]),
    );
  } else if (el && facts.selinux.policy === 'targeted') {
    out.push(right('host.selinux', 'host', 'SELinux', [`SELinux ${mode}, policy targeted: labels will be managed (S9)`]));
    const missing: string[] = [];
    if (!facts.selinux.tools.semanage) missing.push('dnf install policycoreutils-python-utils');
    if (!facts.selinux.tools.restorecon || !facts.selinux.tools.getsebool) missing.push('dnf install policycoreutils libselinux-utils');
    out.push(
      missing.length === 0
        ? right('host.selinux_tools', 'host', 'SELinux tools', ['semanage, restorecon and getsebool present'])
        : blocked('host.selinux_tools', 'host', 'SELinux tools', ['the SELinux management tools are missing'], missing),
    );
  } else {
    out.push(
      blocked('host.selinux', 'host', 'SELinux', [
        !el ? `SELinux ${mode} on a ${facts.os.family} system: not supported (the manual guide applies)` : `SELinux policy '${facts.selinux.policy ?? 'unknown'}': only targeted is supported`,
      ]),
    );
  }
  if (mode === 'enforcing' || mode === 'permissive') {
    const type = selinuxType(facts.selinux.rootContext);
    out.push(
      type === 'unconfined_t'
        ? right('host.root_context', 'host', "root's SELinux context", [facts.selinux.rootContext ?? ''])
        : blocked('host.root_context', 'host', "root's SELinux context", [`root runs as ${facts.selinux.rootContext ?? 'an unknown context'}: run install.sh from an unconfined root shell (id -Z shows unconfined_t)`]),
    );
  }
  return out;
}

/** bun.install will extract the archive: a pin to reach, an installed Bun that differs, an archive given. */
function bunNeedsInstall(env: Env): boolean {
  const pin = env.ctx.pin ?? env.ctx.source?.pin ?? null;
  return pin !== null && env.ctx.bunArchive !== null && env.declared?.bunVersion !== pin;
}

/** The install line for a PHP-FPM; EL AppStream picks the version by module stream on EL 9 only (EL 10 has one, non-modular). */
function fpmInstallCommand(flavor: FpmInstall['flavor'], version: string, dnfModules: boolean): string {
  const nn = version.replace('.', '');
  if (flavor === 'debian') return `apt install php${version}-fpm php${version}-cli`;
  if (flavor === 'remi') return `dnf install php${nn}-php-fpm php${nn}-php-cli`;
  if (!dnfModules) return 'dnf install php-fpm php-cli';
  return `dnf module reset php && dnf module enable php:${version} && dnf install php-fpm php-cli`;
}

function fpmCliCommand(flavor: FpmInstall['flavor'], version: string): string {
  if (flavor === 'debian') return `apt install php${version}-cli`;
  if (flavor === 'remi') return `dnf install php${version.replace('.', '')}-php-cli`;
  return 'dnf install php-cli';
}

function noexecItem(env: Env): ComparedItem {
  const { facts, layout, decl } = env;
  const bun = layout?.bunBin ?? decl?.bun_bin ?? null;
  const agent = layout?.agentDir ?? decl?.agent_dir ?? null;
  const paths: [string, string][] = [['INIT_BASE', INIT_BASE]];
  if (bun !== null) paths.push(["bun_bin's directory", bun.slice(0, bun.lastIndexOf('/')) || '/']);
  if (agent !== null) paths.push(['agent_dir', agent]);
  const hits: string[] = [];
  for (const [label, path] of paths) {
    const mount = mountOf(path, facts.mounts);
    if (mount?.noexec !== true) continue;
    // Under the home layout a noexec home is a home-cannot-be-root reason (declaration.layout).
    if (env.home !== null && env.completion.kind === 'home' && path.startsWith(`${env.home}/`)) continue;
    hits.push(`${label} ${path} is on ${mount.mountPoint} (${mount.fsType}), mounted noexec: root would run code from it`);
  }
  if (hits.length === 0) return right('host.noexec', 'host', 'noexec mounts', ['the paths root runs code from are on exec mounts']);
  return blocked('host.noexec', 'host', 'noexec mounts', hits, paths.map(([, path]) => `findmnt -T ${path}`));
}

function unitSandboxItem(env: Env): ComparedItem {
  const { facts, layout } = env;
  const title = env.v1 ? 'web server and PHP-FPM unit sandboxes' : 'web server unit sandbox';
  if (layout === null) return right('host.unit_sandbox', 'host', title, ['checked once the declaration is complete']);
  const problems: string[] = [];
  const units: string[] = [];
  const check = (unit: string | null, sandbox: HostFacts['web']['unitSandbox'], targets: readonly [string, boolean][]) => {
    if (sandbox === null || unit === null) return;
    for (const [path, write] of targets) {
      // A hidden home is a declaration.layout reason under the home layout (S6).
      const reasons = sandboxHides(sandbox, path, write).filter(why => !(env.completion.kind === 'home' && /ProtectHome/.test(why)));
      if (reasons.length > 0) {
        problems.push(...reasons.map(why => `${unit}: ${why}`));
        if (!units.includes(unit)) units.push(unit);
      }
    }
  };
  check(facts.web.unit, facts.web.unitSandbox, [[layout.state.root, false]]);
  if (layout.site?.v1 != null && env.fpm !== null) {
    check(env.fpm.unit, env.fpm.unitSandbox, [
      [layout.state.root, false],
      [layout.site.v1.var.root, true],
    ]);
  }
  if (problems.length === 0) return right('host.unit_sandbox', 'host', title, ['no unit sandbox hides the declared paths']);
  return blocked('host.unit_sandbox', 'host', title, problems, units.flatMap(unit => [`systemctl cat ${unit}   # the fragment and drop-ins that set it`, `systemctl edit ${unit}`]));
}

/* ── 2. declaration.* ─────────────────────────────────────────────────────────────── */

function declarationItems(env: Env): ComparedItem[] {
  const { completion, decl, declared, facts } = env;
  const out: ComparedItem[] = [];
  const decision = (id: string) => completion.decisions.find(row => row.id === id);

  // declaration.fields
  const lines = decl === null ? [] : [...completion.sources].map(([field, source]) => `${field} = ${fieldValue(decl, field)} (${source})`);
  const problems = [
    ...completion.unfilled.map(row => `${row.field}: ${row.reason}`),
    ...(completion.layoutError === null ? [] : [`the completed declaration is refused: ${completion.layoutError}`]),
  ];
  out.push(
    problems.length > 0
      ? blocked('declaration.fields', 'declaration', 'the declaration fields init fills', [...problems, ...lines], ['edit the draft and re-run install.sh'])
      : right('declaration.fields', 'declaration', 'the declaration fields init fills', lines.length > 0 ? lines : ['the draft names every field']),
  );

  // declaration.apis: which Publication APIs the instance serves (the draft's `apis`, else its v1 block)
  out.push(
    right(
      'declaration.apis',
      'declaration',
      'the Publication APIs this instance serves',
      env.v1
        ? ['v1 and v2: the Publication API v1 (legacy, v6-era websites) runs in its own PHP-FPM pool; v2 behind the web server']
        : ['v2 only: no PHP anywhere (no PHP-FPM pool, no v1 tree, no v1 configuration) — the recommended shape for a new site'],
    ),
  );

  // declaration.layout
  const site = decl?.site;
  if (site === undefined || decl === null) {
    out.push(right('declaration.layout', 'declaration', 'layout', ['no site: the system layout (/srv + /opt)']));
  } else {
    const home = site.home ?? join('/home', site.domain);
    const layoutDecision = layoutDecisionFor({ home, instance: decl.instance, reasons: env.homeReasons, kind: completion.kind, kindSource: completion.kindSource });
    if (layoutDecision !== null) out.push(fromDecision(layoutDecision));
    else {
      const how = completion.kindSource === 'draft' ? 'named by the draft' : completion.kindSource === 'existing' ? 'fixed by the existing declaration' : 'fixed by the declared paths';
      out.push(right('declaration.layout', 'declaration', 'layout', [`the ${completion.kind} layout (${how})`]));
    }
  }

  // declaration.fpm / vhost / work_unit / v2_port / v1_user: completion decisions, else right
  const echo = (id: string, title: string, fact: string | null) => {
    const row = decision(id);
    if (row !== undefined) out.push(fromDecision(row));
    else if (fact !== null) out.push(right(id, 'declaration', title, [fact]));
  };
  if (site !== undefined && env.v1) {
    echo('declaration.fpm', 'PHP-FPM install', env.fpm === null ? null : `${env.fpm.flavor} PHP ${env.fpm.version} (${env.fpm.unit})`);
  }
  if (site !== undefined) {
    echo('declaration.vhost', 'vhost', env.vhost === null ? null : [env.vhost, ...env.vhostTwins].map(describeVhost).join(' + '));
  }
  if (decl?.listen.kind !== 'tls') {
    echo('declaration.work_unit', 'work engine unit', completion.workUnit === null ? null : `${completion.workUnit.unit} (group ${completion.workUnit.group})`);
  }
  echo('declaration.v2_port', 'v2 port', decl === null ? null : `v2 listens on 127.0.0.1:${decl.v2.port}`);

  // declaration.home
  if (site !== undefined && decl !== null) {
    const home = site.home ?? join('/home', site.domain);
    const homeFacts = [`home ${home}`];
    if (env.vhost?.documentRoot && !env.vhost.documentRoot.startsWith(`${home}/`) && env.vhost.documentRoot !== home) {
      homeFacts.push(`the vhost's DocumentRoot ${env.vhost.documentRoot} lies outside ${home}`);
    }
    const sharers = facts.web.vhosts.filter(
      row => row.serverName !== site.domain && row.documentRoot !== null && (row.documentRoot === home || row.documentRoot.startsWith(`${home}/`)),
    );
    const grammar = completion.layoutError?.startsWith('site.home') ? completion.layoutError : null;
    if (sharers.length > 0 || grammar !== null) {
      out.push(
        blocked('declaration.home', 'declaration', 'the site home', [
          ...homeFacts,
          ...sharers.map(row => `${row.serverName} (${row.realpath}) also serves from under ${home}: a home shared with other vhosts cannot become this instance's`),
          ...(grammar === null ? [] : [grammar]),
        ]),
      );
    } else out.push(right('declaration.home', 'declaration', 'the site home', homeFacts));
  }

  // declaration.v1_user
  const v1 = decision('declaration.v1_user');
  if (v1 !== undefined) out.push(fromDecision(v1));
  else if (decl?.v1 !== undefined) out.push(right('declaration.v1_user', 'declaration', 'the v1 account', [`v1 runs as ${decl.v1.user}, in its own PHP-FPM pool (decision A)`]));

  // declaration.state_root
  if (decl !== null && declared !== null) {
    if (declared.stateRoot === 'foreign') {
      const relocatable = env.homeLayout && env.home !== null && !decl.state_root.endsWith(`/${HOME_RELOCATED_NAMES.stateRoot}`);
      const proposal = env.home === null ? null : join(env.home, HOME_RELOCATED_NAMES.stateRoot);
      out.push(
        item('declaration.state_root', 'declaration', 'decision', 'the state root', {
          facts: [`${decl.state_root} exists and is not an agent state tree: it is never taken over`, ...(relocatable ? [`proposed: ${proposal}`] : [])],
          options: relocatable ? [{ id: 'relocate', label: `use ${proposal}`, resolves: 'relocate' }, MANUAL] : [MANUAL],
          defaultOption: relocatable ? 'relocate' : 'manual',
          blocking: true,
        }),
      );
    } else {
      out.push(right('declaration.state_root', 'declaration', 'the state root', [`${decl.state_root}: ${declared.stateRoot === 'ours' ? "this instance's" : 'absent, created by provision apply'}`]));
    }
  }

  // declaration.layout_dirs (home layout)
  if (env.homeLayout && env.home !== null && decl !== null && declared !== null) {
    const home = env.home;
    const foreign: string[] = [];
    const standard = (path: string, name: string) => path === join(home, name) || path.startsWith(`${join(home, name)}/`);
    for (const [name, path, relocatedName] of [
      ['.bun', decl.bun_bin, HOME_RELOCATED_NAMES.bunDir],
      ['host_agent', decl.agent_dir, HOME_RELOCATED_NAMES.agentDir],
    ] as const) {
      const row = declared.home.layoutDirs[name];
      if (row !== null && row.uid !== 0 && standard(path, name)) foreign.push(`${join(home, name)} exists, owned by uid ${row.uid}: never chowned; relocate to ${join(home, relocatedName)}`);
    }
    out.push(
      foreign.length === 0
        ? right('declaration.layout_dirs', 'declaration', 'the home layout directories', ['no existing directory is in the way'])
        : item('declaration.layout_dirs', 'declaration', 'decision', 'the home layout directories', {
            facts: foreign,
            options: [{ id: 'relocate', label: 'use the relocated names', resolves: 'relocate' }, MANUAL],
            defaultOption: 'relocate',
            blocking: true,
          }),
    );
  }

  // declaration.shared_code
  if (decl !== null && declared !== null) {
    const sharing = declared.siblings.filter(row => row.layout.agentDir === decl.agent_dir || row.layout.bunBin === decl.bun_bin);
    if (sharing.length > 0) {
      out.push(
        item('declaration.shared_code', 'declaration', 'decision', 'code shared with other instances', {
          facts: sharing.map(row => `${row.source} uses the same ${row.layout.agentDir === decl.agent_dir ? `agent_dir ${decl.agent_dir}` : `bun_bin ${decl.bun_bin}`}: its agent ${row.layout.agentUnitName} runs the code this run installs`),
          options: [{ id: 'act', label: 'restart them after the update', resolves: 'act' }, MANUAL],
          defaultOption: 'manual',
        }),
      );
    }
  }

  return out;
}

/* ── 3. account.* ─────────────────────────────────────────────────────────────────── */

function accountItems(env: Env): ComparedItem[] {
  const { facts, decl, layout } = env;
  if (decl === null || layout === null) return [];
  const out: ComparedItem[] = [];
  const users = facts.accounts.users;
  const groups = facts.accounts.groups;
  const groupNamed = (name: string) => groups.find(row => row.name === name);
  const shell = facts.os.support?.nologinShells[0] ?? NOLOGIN_SHELLS[0];
  const { agentUser, v2User, v2Group, engineGroup } = layout.identity;
  const v1User = layout.v1?.user ?? null;

  // account.pubhost_group (S11)
  const pubhost = groupNamed(PUBHOST_GROUP);
  if (pubhost === undefined && env.declared?.hostShared.group !== true) {
    out.push(
      item('account.pubhost_group', 'account', 'change', `create the host-wide group ${PUBHOST_GROUP}`, {
        facts: ['every agent unit joins it through SupplementaryGroups= (no existing account is modified)'],
        commands: [`groupadd --system ${PUBHOST_GROUP}`],
        action: { kind: 'group_add', name: PUBHOST_GROUP },
      }),
    );
  } else if (pubhost !== undefined && pubhost.gid >= 1000) {
    out.push(blocked('account.pubhost_group', 'account', `the group ${PUBHOST_GROUP}`, [`${PUBHOST_GROUP} exists with gid ${pubhost.gid}: not a system group; it is never modified`]));
  } else out.push(right('account.pubhost_group', 'account', `the group ${PUBHOST_GROUP}`, [`${PUBHOST_GROUP} exists`]));

  // account.v2_group
  out.push(
    groupNamed(v2Group) === undefined
      ? item('account.v2_group', 'account', 'change', `create the group ${v2Group}`, {
          commands: [`groupadd --system ${v2Group}`],
          action: { kind: 'group_add', name: v2Group },
        })
      : right('account.v2_group', 'account', `the group ${v2Group}`, [`${v2Group} exists`]),
  );

  const accountItem = (id: string, name: string, expected: string, create: InitAction, command: string, after: readonly string[]): ComparedItem => {
    const row = users.find(user => user.name === name);
    if (row === undefined) {
      return item(id, 'account', 'change', `create the account ${name}`, { commands: [command], action: create, after: [...after] });
    }
    const problems: string[] = [];
    const primary = groups.find(group => group.gid === row.gid)?.name ?? `gid ${row.gid}`;
    if (primary !== expected) problems.push(`${name}'s primary group is ${primary}, expected ${expected}`);
    if (!(NOLOGIN_SHELLS as readonly string[]).includes(row.shell)) problems.push(`${name}'s shell is ${row.shell}, not a nologin shell`);
    if (problems.length === 0) return right(id, 'account', `the account ${name}`, [`${name} exists (uid ${row.uid}, group ${expected})`]);
    return blocked(id, 'account', `the account ${name}`, [...problems, 'an existing account is never modified'], [`usermod -g ${expected} -s ${shell} ${name}   # by hand, if this account is meant for it`]);
  };
  out.push(
    accountItem('account.agent_user', agentUser, agentUser, { kind: 'user_add_own', name: agentUser }, `useradd --system --no-create-home --shell ${shell} --user-group ${agentUser}`, []),
    accountItem('account.v2_user', v2User, v2Group, { kind: 'user_add_in', name: v2User, group: v2Group }, `useradd --system --no-create-home --shell ${shell} -g ${v2Group} ${v2User}`, ['account.v2_group']),
  );
  // No v1 account on a v2-only instance.
  if (v1User !== null) {
    out.push(accountItem('account.v1_user', v1User, v1User, { kind: 'user_add_own', name: v1User }, `useradd --system --no-create-home --shell ${shell} --user-group ${v1User}`, []));
  }

  // account.engine_group (unix listener; never acted on)
  if (engineGroup !== null) {
    const filesOnly = facts.nss.passwdFilesOnly && facts.nss.groupFilesOnly;
    const workUser = env.completion.workUnit?.user ?? null;
    const checks = [`getent group ${engineGroup}`, ...(workUser === null ? ['id -nG <the account that runs Dédalo>'] : [`id -nG ${workUser}`])];
    const ours = [agentUser, ...(v1User === null ? [] : [v1User]), v2User];
    const group = groupNamed(engineGroup);
    const problems: string[] = [];
    if (group === undefined) problems.push(`group '${engineGroup}' does not exist: init never creates the engine group; name the group the work system runs with`);
    else {
      const held = ours.filter(name => group.members.includes(name) || users.find(user => user.name === name)?.gid === group.gid);
      if (held.length > 0) problems.push(`${held.join(', ')} ${held.length === 1 ? 'is' : 'are'} in '${engineGroup}': our accounts must not open the agent's socket`);
      if (workUser !== null) {
        const sole = soleMemberProblem(engineGroup, workUser, users, groups);
        if (sole !== null) problems.push(sole);
      }
    }
    if (!filesOnly) problems.push(`passwd/group come from a directory service: '${engineGroup}' is checked by hand`);
    out.push(
      problems.length === 0
        ? right('account.engine_group', 'account', `the engine group ${engineGroup}`, [`${engineGroup}: the work system's group, holding no account of ours`])
        : blocked('account.engine_group', 'account', `the engine group ${engineGroup}`, problems, checks),
    );
  }
  return out;
}

/* ── 4. home.* (layout home) ──────────────────────────────────────────────────────── */

function homeItems(env: Env): ComparedItem[] {
  const { declared, facts } = env;
  if (!env.homeLayout || env.home === null || declared === null) return [];
  const home = env.home;
  const mode = modeText(HOME_ROOT_MODE);
  const out: ComparedItem[] = [];
  const own = declared.home.facts;
  if (own === null) {
    out.push(
      item('home.root', 'home', 'change', `create ${home} root:root ${mode}`, {
        commands: [`mkdir -m ${mode} ${home}`],
        action: { kind: 'mkdir', path: home, uid: 0, gid: 0, mode: HOME_ROOT_MODE },
      }),
    );
  } else if (own.uid === 0 && (own.mode & 0o022) === 0) {
    out.push(right('home.root', 'home', `${home} is root's`, [`${home} is root-owned (${modeText(own.mode)})`]));
  } else {
    const nameOf = (uid: number) => facts.accounts.users.find(row => row.uid === uid)?.name ?? `uid ${uid}`;
    const groupOf = (gid: number) => facts.accounts.groups.find(row => row.gid === gid)?.name ?? `gid ${gid}`;
    const homeFacts = [`${home} is ${nameOf(own.uid)}:${groupOf(own.gid)} ${modeText(own.mode)}; root runs bun_bin and agent_dir from beneath it, so it becomes root:root ${mode} (decision B)`];
    if ((HOME_ROOT_MODE & ~own.mode & 0o077) !== 0) {
      homeFacts.push(
        `the mode widens from ${modeText(own.mode)} to ${mode}: other local accounts, including other sites' PHP-FPM users, gain r-x on ${home}: its listing and every file whose own mode allows it become reachable`,
      );
      const shown = declared.home.worldReadable.slice(0, 20);
      if (shown.length > 0) {
        const more = declared.home.worldReadableCount - shown.length;
        homeFacts.push(`world-readable files at depth ≤ 2: ${shown.join(', ')}${more > 0 ? ` … and ${more} more` : ''}`);
      }
    }
    const others = declared.home.topEntries.filter(row => row.uid !== 0);
    if (others.length > 0) homeFacts.push(`these entries keep their owners: ${others.map(row => `${row.name} (${nameOf(row.uid)})`).join(', ')}`);
    if (declared.home.homeOf.length > 0) {
      homeFacts.push(
        `${declared.home.homeOf.join(', ')} ${declared.home.homeOf.length === 1 ? 'has' : 'have'} it as home: login still works (sshd accepts a root-owned home); they can no longer create new top-level entries, including dotfiles such as .bash_history, .cache, .config, .ssh — existing ones stay writable`,
      );
    }
    if (declared.home.poolRefs.length > 0) homeFacts.push(`PHP-FPM pool paths point into it: ${declared.home.poolRefs.join('; ')}`);
    out.push(
      item('home.root', 'home', 'change', `give ${home} to root`, {
        facts: homeFacts,
        commands: [`chown root:root ${home} && chmod ${mode} ${home}`],
        action: { kind: 'path_meta', path: home, uid: 0, gid: 0, mode: HOME_ROOT_MODE },
      }),
    );
  }

  return out;
}

/* ── 5. selinux.* ─────────────────────────────────────────────────────────────────── */

const MEDIA_BOOLEANS: readonly [RegExp, SelinuxBoolean][] = [
  [/^(nfs|nfs4|autofs)$/, 'httpd_use_nfs'],
  [/^(cifs|smb3)$/, 'httpd_use_cifs'],
  [/^fuse(\.|$)/, 'httpd_use_fusefs'],
];

function sebool(env: Env, name: SelinuxBoolean): InitAction {
  return { kind: 'sebool', name, value: true, previous: env.facts.selinux.booleans[name] ?? null };
}

function selinuxItems(env: Env): ComparedItem[] {
  const { facts, layout, decl } = env;
  const out: ComparedItem[] = [];
  const on = (name: SelinuxBoolean) => facts.selinux.booleans[name] === true;
  const v1Right = env.declared?.apiConfig.v1?.exists === true;

  if (env.selinuxOn && layout !== null) {
    // selinux.home_traverse (home layout)
    if (env.homeLayout && env.home !== null) {
      const home = env.home;
      const traversable = env.declared?.home.traversable === true || on('httpd_enable_homedirs');
      if (traversable) {
        out.push(right('selinux.home_traverse', 'selinux', `httpd can traverse ${home}`, [on('httpd_enable_homedirs') ? 'httpd_enable_homedirs is on' : `${home} carries a type httpd_t can search`]));
      } else {
        out.push(
          item('selinux.home_traverse', 'selinux', 'change', `let httpd traverse ${home}`, {
            facts: [
              `an exact rule on the directory ${home} only (${HOME_TRAVERSE_TYPE}); files under it keep their labels; local rules take precedence over the home-directory templates`,
              'applied by provision apply and monitored by provision check',
              'option boolean: httpd_enable_homedirs lets httpd search every home directory and read httpd_user_content_t content in all of them (host-wide)',
              'option relocate: switch this instance to the system layout (the completion is recomputed and the diff shown)',
            ],
            commands: [`semanage fcontext -a -f d -t ${HOME_TRAVERSE_TYPE} '${escapeSpec(home)}'`, `restorecon -v ${home}`],
            options: [
              { id: 'act', label: `an exact ${HOME_TRAVERSE_TYPE} rule on ${home}`, resolves: 'act' },
              { id: 'boolean', label: 'setsebool -P httpd_enable_homedirs on (every home, host-wide)', resolves: 'act', confirm: 'typed' },
              { id: 'relocate', label: 'use the system layout instead', resolves: 'relocate' },
            ],
            defaultOption: 'act',
            optionActions: { boolean: sebool(env, 'httpd_enable_homedirs') },
            optionCommands: { boolean: ['setsebool -P httpd_enable_homedirs on'] },
            blocking: true,
            after: ['home.root'],
          }),
        );
      }
    }

    // selinux.proxy_connect (a site's web include proxies v2)
    if (layout.site !== null) {
      const port = layout.v2.port;
      const type = facts.selinux.portTypes.get(port);
      const willBeHttp = type === undefined || type === 'http_port_t';
      if ((willBeHttp && (on('httpd_graceful_shutdown') || on('httpd_can_network_relay'))) || on('httpd_can_network_connect')) {
        out.push(right('selinux.proxy_connect', 'selinux', 'httpd may proxy to v2', [`port ${port} is ${type === undefined ? 'labelled http_port_t by provision apply' : type}; httpd may connect to it`]));
      } else {
        out.push(
          item('selinux.proxy_connect', 'selinux', 'decision', 'let httpd proxy to v2', {
            facts: [`httpd connects to 127.0.0.1:${port} (${type ?? 'http_port_t after provision apply'}); neither httpd_graceful_shutdown nor httpd_can_network_relay is on`, 'option connect: httpd_can_network_connect lets httpd connect to any port (host-wide)'],
            commands: ['setsebool -P httpd_can_network_relay on'],
            options: [
              { id: 'act', label: 'setsebool -P httpd_can_network_relay on', resolves: 'act', confirm: 'typed' },
              { id: 'connect', label: 'setsebool -P httpd_can_network_connect on (any port)', resolves: 'act', confirm: 'typed' },
              MANUAL,
            ],
            defaultOption: 'act',
            action: sebool(env, 'httpd_can_network_relay'),
            optionActions: { connect: sebool(env, 'httpd_can_network_connect') },
            optionCommands: { connect: ['setsebool -P httpd_can_network_connect on'] },
            hostWide: true,
          }),
        );
      }
    }
  }

  // api_config.v1_db_transport: asked before the secrets, and before selinux.db_connect. The
  // default follows discovery (facts.mariadb): the local socket when one exists, else TCP
  // 127.0.0.1:3306 — still a decision either way (--yes never settles it).
  const transport = v1Transport(env);
  if (decl !== null && env.v1 && !v1Right) {
    const found = facts.mariadb.socket;
    out.push(
      item('api_config.v1_db_transport', 'api_config', 'decision', 'how v1 reaches MariaDB', {
        facts: [
          found !== null
            ? `a local MariaDB socket: ${found}`
            : `no local MariaDB socket (looked at ${MARIADB_SOCKET_CANDIDATES.join(', ')}); the default is TCP ${MARIADB_TCP_HOST}:${MARIADB_TCP_PORT}`,
          ...(found === null
            ? [facts.mariadb.tcp3306 ? `TCP ${MARIADB_TCP_PORT} is listening on this host` : `nothing listens on TCP ${MARIADB_TCP_PORT} here: if MariaDB is on another host, choose tcp and type its host and port`]
            : []),
          'socket: the MariaDB unix socket; tcp: host and port (never `localhost`: the v1 PHP driver reads it as the socket)',
        ],
        options: [
          { id: 'socket', label: 'the unix socket', resolves: 'act' },
          { id: 'tcp', label: 'TCP (host and port)', resolves: 'act' },
        ],
        defaultOption: found !== null ? 'socket' : 'tcp',
      }),
    );
  }

  if (env.selinuxOn && layout !== null) {
    // selinux.db_connect (v1 over TCP)
    if (env.v1 && transport === 'tcp' && !v1Right) {
      out.push(
        on('httpd_can_network_connect_db')
          ? right('selinux.db_connect', 'selinux', 'v1 may reach MariaDB over TCP', ['httpd_can_network_connect_db is on'])
          : item('selinux.db_connect', 'selinux', 'decision', 'let v1 reach MariaDB over TCP', {
              facts: ['the v1 pool runs as httpd_t: a TCP connection to MariaDB needs httpd_can_network_connect_db (host-wide)'],
              commands: ['setsebool -P httpd_can_network_connect_db on'],
              options: [ACT_TYPED, MANUAL],
              defaultOption: 'act',
              action: sebool(env, 'httpd_can_network_connect_db'),
              hostWide: true,
              after: ['api_config.v1_db_transport'],
            }),
      );
    }

    // selinux.media_access
    const media = layout.media;
    if (media.root !== null && media.mode !== 'none') {
      const mount = mountOf(media.root, facts.mounts);
      const network = mount !== null && isNetworkFs(mount.fsType) && !mount.seclabel;
      if (media.mode === 'shared' || network) out.push(mediaAccessItem(env, media.root, mount, network));
    }

    // selinux.v2_policy (every layout: the v2 tree is typed by the provisioner's own module)
    if (moduleNeeded(layout)) out.push(v2PolicyItem(env, layout));
  }
  return out;
}

/**
 * selinux.v2_policy (spec §9.8): the v2 tree keeps the path's default type (`user_home_t` in a home,
 * `var_t` under /srv), which systemd may not read — no v2 unit could start. provision apply writes and
 * installs the provisioner's policy module (selinux_module.ts) and labels the tree with its type;
 * this item states it (no action of its own: provision.apply does it), right once the module of
 * this provisioner is installed and current, blocked by a module of that name that is not ours.
 */
function v2PolicyItem(env: Env, layout: AgentLayout): ComparedItem {
  const title = 'systemd can read the Publication API v2 tree (SELinux policy module)';
  const v2 = layout.state.apis.v2.root;
  const observed = env.declared?.hostState?.selinux?.module;
  const installed = observed === undefined ? ({ kind: 'absent' } as const) : installedModule(observed);
  if (installed.kind === 'foreign') {
    return blocked('selinux.v2_policy', 'selinux', title, [installed.reason, `the labels of ${v2} need its type ${V2_TREE_TYPE}; a module that is not ours is never replaced`], [FOREIGN_MODULE_HINT]);
  }
  if (installed.kind === 'ours' && installed.current) {
    return right('selinux.v2_policy', 'selinux', title, [`the policy module ${SELINUX_MODULE_NAME} is installed and current: ${v2} is ${V2_TREE_TYPE}, which systemd reads and httpd may not`]);
  }
  const path = selinuxModulePath(layout);
  const fallback = isHomeLayout(layout) ? "the home's own type (user_home_t)" : "the path's default type (var_t under /srv)";
  return item('selinux.v2_policy', 'selinux', 'change', title, {
    facts: [
      `${v2} would keep ${fallback}, which systemd may not read: no v2 unit could start`,
      `provision apply writes ${path} (CIL, stamped; one module for every instance on this host) and installs it: it defines the one file type ${V2_TREE_TYPE}, which systemd (init_t) may read and httpd may not; the v2 service and the agent run unconfined_service_t`,
      ...(installed.kind === 'ours' ? ['an older version of the module is installed: provision apply replaces it in place'] : []),
      'it changes nothing for any other site: the type is only ever given to the v2 trees of this host\'s instances',
      'provision apply removes the module when no instance on this host needs it any more; a module of that name that is not ours is refused, never replaced',
    ],
    commands: [`semodule -X ${SELINUX_MODULE_PRIORITY} -i ${path}`, `semanage fcontext -a -f a -t ${V2_TREE_TYPE} '${escapeSpec(v2)}(/.*)?'`, `restorecon -R -v ${v2}`],
    // Installed once per host, but it widens nothing for another site: its one type is only ever
    // given to our v2 trees, and it grants systemd alone — `--yes` may apply it (not hostWide).
  });
}

function mediaAccessItem(env: Env, root: string, mount: ReturnType<typeof mountOf>, network: boolean): ComparedItem {
  const { facts } = env;
  const title = `httpd can read the media root ${root}`;
  if (network && mount !== null) {
    const contextType = mount.context === null ? null : selinuxType(mount.context.replace(/^"|"$/g, ''));
    const boolean = MEDIA_BOOLEANS.find(([pattern]) => pattern.test(mount.fsType))?.[1] ?? 'httpd_use_nfs';
    if ((contextType !== null && HTTPD_READABLE_TYPES.includes(contextType)) || facts.selinux.booleans[boolean] === true) {
      return right('selinux.media_access', 'selinux', title, [contextType !== null ? `${mount.mountPoint} is mounted context=…${contextType}` : `${boolean} is on`]);
    }
    return item('selinux.media_access', 'selinux', 'decision', title, {
      facts: [
        `${root} is on ${mount.mountPoint} (${mount.fsType}) without seclabel: httpd_t reads it only through the mount's context= or a boolean`,
        `option boolean: ${boolean} lets httpd read every ${mount.fsType} mount on this host (host-wide)`,
      ],
      commands: [
        `in /etc/fstab, add context="system_u:object_r:httpd_sys_content_t:s0" to the options of ${mount.mountPoint} (it labels only that mount), then: umount ${mount.mountPoint} && mount ${mount.mountPoint}`,
      ],
      options: [
        // Both typed: a mount option (done by hand, but a choice about the operator's fstab) and a
        // host-wide boolean are never taken by Enter.
        { id: 'mount', label: 'add the context= mount option (only this mount)', resolves: 'manual', confirm: 'typed' },
        { id: 'boolean', label: `setsebool -P ${boolean} on (every ${mount.fsType} mount)`, resolves: 'act', confirm: 'typed' },
      ],
      defaultOption: 'mount',
      optionActions: { boolean: sebool(env, boolean) },
      optionCommands: { boolean: [`setsebool -P ${boolean} on`] },
      hostWide: true,
    });
  }
  const label = facts.selinux.labels.get(root) ?? null;
  if (label !== null && HTTPD_READABLE_TYPES.includes(label)) return right('selinux.media_access', 'selinux', title, [`${root} is ${label}`]);
  // Consented (the declaration's media.selinux_label — this run's `act` answer folds into it):
  // provision apply registers the M rule and relabels; nothing is left to decide.
  if (env.layout?.media.selinuxLabel === true) {
    return right('selinux.media_access', 'selinux', title, [
      `${root} is ${label ?? 'unlabelled'}; the declaration consents (media.selinux_label): provision apply registers M(/.*)? httpd_sys_content_t and relabels it`,
    ]);
  }
  return item('selinux.media_access', 'selinux', 'decision', title, {
    facts: [`${root} is ${label ?? 'unlabelled'}: labels the operator's media directory ${root} httpd_sys_content_t (provision apply registers the rule)`],
    commands: [`semanage fcontext -a -f a -t httpd_sys_content_t '${escapeSpec(root)}(/.*)?'`, `restorecon -R -v ${root}`],
    options: [ACT_TYPED, MANUAL],
    defaultOption: 'act',
    hostWide: true,
    operatorFile: true,
  });
}

/* ── 6-8. bun.install, code.install, declaration.write ────────────────────────────── */

function codeItems(env: Env, earlier: readonly ComparedItem[]): ComparedItem[] {
  const { ctx, layout, decl, declared } = env;
  const out: ComparedItem[] = [];
  if (decl === null || layout === null) return out;
  const homeAfter = env.homeLayout ? ['home.root'] : [];

  // bun.install
  const pin = ctx.pin ?? ctx.source?.pin ?? null;
  const bunProblems = env.homeLayout ? [] : (declared?.ancestorProblems.get(layout.bunBin) ?? []);
  if (pin === null) out.push(right('bun.install', 'bun', 'Bun', ['no source given: Bun is left as it is']));
  else if (bunProblems.length > 0) {
    out.push(blocked('bun.install', 'bun', 'Bun', [...bunProblems, 'an existing ancestor is never chowned: declare a bun_bin under a root-owned chain']));
  } else if (declared?.bunVersion === pin) {
    out.push(right('bun.install', 'bun', 'Bun', [`${layout.bunBin} is Bun ${pin}`]));
  } else if (ctx.bunArchive === null || ctx.source === null) {
    out.push(blocked('bun.install', 'bun', 'Bun', [`${layout.bunBin} is ${declared?.bunVersion === null || declared === null ? 'missing' : `Bun ${declared.bunVersion}`}, not ${pin}; no verified archive was given`], ['re-run install.sh with --source']));
  } else {
    const asset = basename(ctx.bunArchive).replace(/\.zip$/, '');
    if (!(BUN_ASSETS as readonly string[]).includes(asset)) {
      out.push(blocked('bun.install', 'bun', 'Bun', [`the archive ${ctx.bunArchive} names no known Bun asset (${BUN_ASSETS.join(', ')})`], ['re-run install.sh with --source']));
    } else {
      out.push(
        item('bun.install', 'bun', 'change', `install Bun ${pin} at ${layout.bunBin}`, {
          facts: [`${layout.bunBin} is ${declared?.bunVersion == null ? 'missing' : `Bun ${declared.bunVersion}`}; the archive is checked against .bun-sha256 before anything runs`],
          action: { kind: 'bun_install', archive: ctx.bunArchive, sums: ctx.args.bunSums, asset, pin, table: ctx.source.shaTable, target: layout.bunBin },
          after: [...homeAfter, 'host.tools'],
        }),
      );
    }
  }

  // code.install
  const source = ctx.source;
  if (source === null) out.push(right('code.install', 'code', 'agent code', ['no source given: the installed code is left as it is']));
  else if (source.missingDependencies.length > 0 || source.devDependenciesPresent.length > 0 || source.testScratchPresent) {
    const why = [
      ...(source.missingDependencies.length > 0 ? [`production dependencies missing under node_modules: ${source.missingDependencies.join(', ')}`] : []),
      ...(source.devDependenciesPresent.length > 0 ? [`development dependencies present: ${source.devDependenciesPresent.join(', ')}`] : []),
      ...(source.testScratchPresent ? ['the source holds publication/host_agent/.test-tmp'] : []),
    ];
    const prefix = source.devDependenciesPresent.length > 0 ? 'rm -rf node_modules && ' : '';
    out.push(
      blocked('code.install', 'code', 'agent code', why, [
        `cd <the work checkout>/publication/host_agent && ${prefix}sudo -u <the checkout's owner> bun install --frozen-lockfile --production`,
        'then re-run install.sh with --source',
      ]),
    );
  } else if (declared?.agentTreeDigest === source.agentDigest) {
    out.push(right('code.install', 'code', 'agent code', [`${layout.agentDir} matches the source (${source.agentDigest.slice(0, 12)})`]));
  } else {
    out.push(
      item('code.install', 'code', 'change', `install the agent code at ${layout.agentDir}`, {
        facts: [
          `source ${source.agentDigest.slice(0, 12)} (treeDigest of publication/host_agent), installed ${declared?.agentTreeDigest?.slice(0, 12) ?? 'nothing'}`,
          `the whole source was confirmed by digest ${source.digest}`,
        ],
        commands: [`install ${source.agentDir} → ${layout.agentDir} (root-owned, the previous tree kept until the restart succeeds)`],
        action: { kind: 'code_install', src: source.agentDir, dst: layout.agentDir, digest: source.agentDigest },
        after: homeAfter,
      }),
    );
  }

  // declaration.write
  const body = canonicalDeclaration(decl);
  const existing = env.completion.existing;
  const before = existing === null ? '' : canonicalDeclaration(existing);
  const path = layout.declarationPath;
  const prior = earlier.concat(out).filter(row => /^(account|home|bun|code)\./.test(row.id)).map(row => row.id);
  if (before === body) out.push(right('declaration.write', 'declaration', 'the declaration', [`${path} is up to date`]));
  else {
    const diff = { path, unified: unifiedDiff(path, before, body) };
    const action: InitAction = { kind: 'write_declaration', body };
    out.push(
      existing !== null && ctx.args.draft !== null
        ? item('declaration.write', 'declaration', 'decision', `the draft differs from ${path}`, {
            facts: ['the draft given with --draft and the declaration on the host differ: the diff shows what changes'],
            diff,
            options: [{ id: 'act', label: 'write the draft', resolves: 'act' }, { id: 'skip', label: 'keep the declaration on the host', resolves: 'skip' }],
            defaultOption: 'act',
            action,
            after: prior,
          })
        : item('declaration.write', 'declaration', 'change', existing === null ? `write ${path}` : `update ${path}`, { diff, action, after: prior }),
    );
  }
  return out;
}

/* ── 9-10. provision.apply, provision.restart ─────────────────────────────────────── */

const HAND_EDIT = /edited by hand|not written by this provisioner|is stamped for/;
const SELINUX_REFUSAL = /fcontext|semanage|typed /;

function applyItems(env: Env, earlier: readonly ComparedItem[]): ComparedItem[] {
  const { decl, layout, declared } = env;
  if (decl === null || layout === null) return [];
  const out: ComparedItem[] = [];
  const instance = decl.instance;
  const pending = earlier.filter(row => row.list !== 'right' && /^(account|home|bun|code|declaration\.write)/.test(row.id)).map(row => row.id);
  const after = ['declaration.write'];
  const command = `provision apply ${instance}`;
  const plan = declared?.plan ?? null;
  const pendingFacts = (declared?.selinuxPending ?? []).map(row => `relabel ${row.path}: ${row.from} → ${row.to}`);
  let actions: readonly Action[] = [];
  if (plan === null) {
    out.push(
      item('provision.apply', 'provision', 'change', 'provision apply (after the steps above)', {
        facts: ['the plan is computed once the accounts, code and declaration exist; a refusal then stops the run', ...pendingFacts],
        commands: [command],
        action: { kind: 'provision_apply', instance },
        after,
      }),
    );
  } else if (!Array.isArray(plan)) {
    const reasons = (plan as { readonly reasons: readonly string[] }).reasons;
    const handEdits = reasons.filter(reason => HAND_EDIT.test(reason));
    const selinux = reasons.filter(reason => SELINUX_REFUSAL.test(reason));
    const rest = reasons.filter(reason => !handEdits.includes(reason) && !selinux.includes(reason));
    if (selinux.length > 0) {
      out.push(blocked('provision.apply', 'provision', 'provision apply is refused', reasons, ['semanage fcontext -l -C', 'semanage port -l -C']));
    } else if (rest.length > 0 && pending.length > 0) {
      out.push(
        item('provision.apply', 'provision', 'change', 'provision apply (after the steps above)', {
          facts: [`the plan refuses today, before ${pending.join(', ')}: it is recomputed after them, and a refusal then stops the run`, ...reasons],
          commands: [command],
          action: { kind: 'provision_apply', instance },
          after,
        }),
      );
    } else if (rest.length > 0) {
      out.push(blocked('provision.apply', 'provision', 'provision apply is refused', reasons, [command]));
    } else {
      out.push(
        item('provision.apply', 'provision', 'decision', 'a provisioned file was edited by hand', {
          facts: handEdits,
          commands: ['move it aside or restore it, then re-run'],
          options: [MANUAL, { id: 'skip', label: 'leave provision apply out of this run', resolves: 'skip' }],
          defaultOption: 'manual',
          after,
        }),
      );
    }
  } else {
    actions = plan;
    // fapolicyd: the trust file lists every file of the agent's code and its Bun by sha256, so new
    // code or a new Bun is drift the plan computed NOW cannot see — apply must run after them, or the
    // restart runs code fapolicyd does not trust (measured, RHEL 10.2 two-machine drill, 2026-10-09:
    // an upgrade from a kit with nothing else to change restarted into "EPERM reading …/src/index.ts").
    const retrust =
      layout.trust !== null && earlier.some(row => (row.id === 'code.install' || row.id === 'bun.install') && row.list === 'change');
    out.push(
      actions.length === 0 && pendingFacts.length === 0 && !retrust
        ? right('provision.apply', 'provision', 'provisioned files', ['provision apply has nothing to do'])
        : item('provision.apply', 'provision', 'change', actions.length === 0 ? 'provision apply (after the steps above)' : `provision apply: ${plural(actions.length, 'step')}`, {
            facts: [
              ...actions.map(describeAction),
              ...pendingFacts,
              ...(retrust ? [`fapolicyd: ${layout.trust?.file} is rewritten for the code and Bun this run installs, before the agent restarts`] : []),
            ],
            commands: [command],
            action: { kind: 'provision_apply', instance },
            after: retrust ? [...after, 'code.install', 'bun.install'] : after,
          }),
    );
  }

  // provision.restart
  const changed = (id: string) => earlier.some(row => row.id === id && row.list === 'change');
  const unitWrites = actions.filter(
    row => row.op === 'write' && (row.path === layout.agentUnitPath || row.path === layout.v2UnitPath) && !actions.some(other => other.op === 'restart' && other.unit === unitOf(row.path)),
  );
  const why: string[] = [];
  if (changed('code.install')) why.push('the agent code changes');
  if (changed('bun.install')) why.push('Bun changes');
  if (unitWrites.length > 0) why.push('the unit files change');
  const siblings =
    env.answers.get('declaration.shared_code') === 'act'
      ? (declared?.siblings ?? []).filter(row => row.layout.agentDir === layout.agentDir || row.layout.bunBin === layout.bunBin).map(row => row.layout.agentUnitName)
      : [];
  if (why.length === 0 && siblings.length === 0) {
    out.push(right('provision.restart', 'provision', 'restarts', ['nothing to restart']));
  } else {
    const units = [layout.agentUnitName, ...(declared?.v2Unit.active === true ? [layout.v2.unit] : []), ...siblings];
    out.push(
      item('provision.restart', 'provision', 'change', `restart ${units.join(', ')}`, {
        facts: [...why, ...(siblings.length > 0 ? [`siblings sharing the code: ${siblings.join(', ')}`] : [])],
        commands: units.map(unit => `systemctl restart ${unit}.service`),
        action: { kind: 'unit_restart', units },
        after: ['provision.apply', 'code.install', 'bun.install'],
      }),
    );
  }
  return out;
}

function unitOf(path: string): string {
  return basename(path).replace(/\.service$/, '');
}

/* ── 11. api_config.* (secrets) ───────────────────────────────────────────────────── */
/** The v1 transport: the operator's answer, else discovery's default (a local socket, else TCP). */
function v1Transport(env: Env): 'socket' | 'tcp' {
  const answered = env.answers.get('api_config.v1_db_transport');
  if (answered === 'socket' || answered === 'tcp') return answered;
  return env.facts.mariadb.socket !== null ? 'socket' : 'tcp';
}


function apiConfigItems(env: Env): ComparedItem[] {
  const { decl, layout, declared, ctx, facts } = env;
  if (decl === null || layout === null) return [];
  const out: ComparedItem[] = [];
  const template = (name: '.env.example' | 'sample.server_config_api.php', sourcePath: string): string | null => {
    // A source without the v1 sample (a kit built from a v2-only draft) gives no v1 template.
    if (ctx.source !== null) return name === 'sample.server_config_api.php' && ctx.source.v1Sample === null ? null : join(ctx.source.dir, sourcePath);
    if (ctx.kept !== null && ctx.kept.files[name] !== undefined) return join(ctx.kept.dir, name);
    return null;
  };
  const uidOf = (name: string) => facts.accounts.users.find(row => row.name === name)?.uid ?? null;
  const gidOf = (name: string) => facts.accounts.groups.find(row => row.name === name)?.gid ?? null;
  const v2Row = {
    id: 'api_config.v2_env',
    secret: 'v2_env' as 'v2_env' | 'v1_config',
    path: join(layout.state.apis.v2.shared, 'v2.env'),
    meta: declared?.apiConfig.v2 ?? null,
    uid: 0 as number | null,
    gid: gidOf(layout.identity.v2Group),
    mode: MODES.v2Env.mode,
    owner: `root:${layout.identity.v2Group}`,
    sample: template('.env.example', 'publication/server_api/v2/.env.example'),
    action: (sample: string, path: string): InitAction => ({ kind: 'v2_env', sample, path, deploymentMode: layout.web.server, socket: facts.mariadb.socket }),
  };
  const rows = [v2Row];
  // The v1 configuration: only for an instance that serves v1 (a v2-only one has no v1 tree).
  const v1 = layout.v1;
  if (v1 !== null) {
    rows.push({
      id: 'api_config.v1_config',
      secret: 'v1_config',
      path: join(v1.dirs.shared, 'server_config_api.php'),
      meta: declared?.apiConfig.v1 ?? null,
      uid: uidOf(v1.user),
      gid: 0,
      mode: MODES.v1Config.mode,
      owner: `${v1.user}:root`,
      sample: template('sample.server_config_api.php', 'publication/server_api/v1/config_api/sample.server_config_api.php'),
      action: (sample: string, path: string): InitAction => ({
        kind: 'v1_config',
        sample,
        path,
        owner: v1.user,
        transport: v1Transport(env),
        socket: facts.mariadb.socket,
      }),
    });
  }
  for (const row of rows) {
    const title = `the ${row.secret === 'v2_env' ? 'v2' : 'v1'} database configuration`;
    const after = row.secret === 'v1_config' ? ['provision.apply', 'api_config.v1_db_transport'] : ['provision.apply'];
    if (row.meta?.exists === true) {
      if (row.meta.uid === row.uid && row.meta.gid === row.gid && row.meta.mode === row.mode) {
        out.push(right(row.id, 'api_config', title, [`${row.path} exists (${row.owner} ${modeText(row.mode)}); it is never overwritten`]));
      } else if (row.uid !== null && row.gid !== null) {
        out.push(
          item(row.id, 'api_config', 'change', `fix the owner and mode of ${row.path}`, {
            facts: [`${row.path} is uid ${row.meta.uid} gid ${row.meta.gid} ${modeText(row.meta.mode)}, expected ${row.owner} ${modeText(row.mode)}; its content is kept`],
            commands: [`chown ${row.owner} ${row.path} && chmod ${modeText(row.mode)} ${row.path}`],
            action: { kind: 'path_meta', path: row.path, uid: row.uid, gid: row.gid, mode: row.mode },
            after,
          }),
        );
      } else {
        out.push(blocked(row.id, 'api_config', title, [`${row.path} has the wrong owner or mode and ${row.owner} does not resolve yet`], [`chown ${row.owner} ${row.path} && chmod ${modeText(row.mode)} ${row.path}`]));
      }
    } else if (row.sample === null && ctx.source !== null) {
      out.push(
        blocked(row.id, 'api_config', title, [`${row.path} is missing and the source carries no v1 sample (a kit built from a draft that serves v2 only)`], [
          'on the work host: bun run hostagent:pack -- --draft <a draft that serves v1>, then install that kit',
        ]),
      );
    } else if (row.sample === null) {
      out.push(blocked(row.id, 'api_config', title, [`${row.path} is missing and no template was kept`], ['re-run install.sh with --source']));
    } else {
      out.push(
        item(row.id, 'api_config', 'change', `write ${row.path}`, {
          facts: [`typed on this terminal, never shown or logged; owner ${row.owner} ${modeText(row.mode)}`],
          action: row.action(row.sample, row.path),
          secret: row.secret,
          after,
        }),
      );
    }
  }
  return out;
}

/* ── 12-17. web.* ─────────────────────────────────────────────────────────────────── */

/**
 * A foreign nginx map (spec §4.3 item 14). GAP (types.ts MapDef is P1's, observe.ts P2's): the seed
 * transaction needs the file's sha, whether it holds only the maps, and whether its three blocks
 * pass parseNginxMap — read here when observe adds them; without the sha the item stays a
 * blocking manual decision (act could not prove the file unchanged).
 */
export interface ForeignMapFacts extends MapDef {
  readonly fileSha?: string;
  readonly standalone?: boolean;
  readonly parseProblem?: string | null;
}

/**
 * The site's blocks grouped by FILE: the chosen vhost and its address-family twins (draft.ts
 * vhostTwins), the chosen vhost's file first.
 *
 * THE TRANSACTION CHOICE (spec §5.10): one item — one operator-file transaction (re-read under the
 * TOCTOU sha, backup, configtest, reload, rollback, web_txn.ts editOperatorFile) — per FILE, never
 * one per block and never one across files:
 * - twins in ONE file are ONE edit (vhost_reference `alsoLines`): two items on one file would each
 *   carry the sha discovery read, and the second would always meet "changed since shown".
 * - twins in different files are one item each, run in order. A failure rolls THAT file back and
 *   stops the run (act: the later items are not reached), so what can remain is the include in one
 *   family's block only — a configuration its configtest already passed, never a broken server —
 *   and the next run proposes the rest. One transaction across files would need a multi-file
 *   journal begin and resume (act.ts resumeOpen settles ONE file by its sha), a grammar that does
 *   not exist; it is not invented here for a state that is safe and converges.
 *
 * Each group's id is the sha8 of its LEAD row — the chosen vhost in its own file (the id a
 * one-block site always had), else that file's first twin — so ids are unique (sha8 hashes the realpath).
 */
function siteFiles(primary: Vhost, twins: readonly Vhost[]): { readonly lead: Vhost; readonly rows: readonly Vhost[] }[] {
  const groups = new Map<string, Vhost[]>();
  for (const row of [primary, ...twins]) groups.set(row.realpath, [...(groups.get(row.realpath) ?? []), row]);
  return [...groups.values()].map(rows => {
    const sorted = [...rows].sort((x, y) => x.line - y.line);
    return { lead: rows.includes(primary) ? primary : (sorted[0] as Vhost), rows: sorted };
  });
}

function webItems(env: Env): ComparedItem[] {
  const { facts, layout, decl } = env;
  if (decl === null || layout === null || layout.site === null) return [];
  const out: ComparedItem[] = [];
  const server = layout.web.server;
  const vhost = env.vhost;

  // web.modules (apache)
  if (server === 'apache') {
    const present = new Set(facts.web.modules.map(name => name.replace(/_module$/, '').replace(/^mod_/, '')));
    // proxy_fcgi is the v1 handler's (the web include's SetHandler proxy:unix:…): a v2-only instance needs none.
    const wanted = APACHE_MODULES.filter(name => env.v1 || name !== 'proxy_fcgi');
    const missing = wanted.filter(name => !present.has(name));
    if (missing.length === 0) out.push(right('web.modules', 'web', 'Apache modules', [`${wanted.join(', ')} are loaded`]));
    else if (facts.web.flavor !== 'el') {
      out.push(
        item('web.modules', 'web', 'change', `enable ${missing.join(', ')}`, {
          facts: ['enabled inside the vhost transaction (configtest, then reload; disabled again on failure)'],
          commands: [`a2enmod -q ${missing.join(' ')}`],
          action: { kind: 'apache_modules', mods: missing },
          after: ['provision.apply'],
        }),
      );
    } else {
      const commands: string[] = [];
      const lines: string[] = [];
      for (const name of missing) {
        if (name === 'ssl') {
          commands.push('dnf install mod_ssl');
          continue;
        }
        const row = facts.web.modulesD.find(entry => entry.module === `${name}_module` && entry.commented);
        if (row !== undefined) lines.push(`${row.file}:${row.line} has LoadModule ${name}_module commented out: uncomment it`);
        else if (!commands.includes('dnf reinstall httpd')) commands.push('dnf reinstall httpd');
      }
      out.push(blocked('web.modules', 'web', 'Apache modules', [`missing: ${missing.join(', ')}; init never edits conf.modules.d`, ...lines], commands));
    }
  }

  const groups = vhost === null ? [] : siteFiles(vhost, env.vhostTwins);

  // web.manual_lines.<sha8>: one item per file of the site (the guide's lines may sit in every block).
  const manualIds: string[] = [];
  for (const { lead, rows } of groups) {
    const manualLines = rows.flatMap(row => row.manualLines).sort((x, y) => x.line - y.line);
    if (manualLines.length === 0) continue;
    const id = `web.manual_lines.${vhostSha8(lead)}`;
    manualIds.push(id);
    out.push(
      lead.fileTrust.length > 0
        ? blocked(id, 'web', `hand-written Dédalo lines in ${lead.realpath}`, [...lead.fileTrust, 'this file is reported, never edited'], manualLines.map(row => `remove line ${row.line}: ${row.text}`))
        : item(id, 'web', 'decision', `remove the hand-written Dédalo lines from ${lead.realpath}`, {
            facts: [`${plural(manualLines.length, 'line')} from the manual guide; the provisioned include replaces them`],
            diff: { path: lead.realpath, unified: lineEditDiff(lead.realpath, { removed: manualLines }) },
            options: [ACT_TYPED, MANUAL],
            defaultOption: 'act',
            action: { kind: 'vhost_manual_removal', path: lead.realpath, beforeSha: lead.fileSha, server, edit: 'remove_manual', lines: manualLines.map(row => row.line) },
            operatorFile: true,
            after: ['provision.apply', 'web.modules'],
          }),
    );
  }

  // web.nginx_manual_map.<sha8> (nginx, the host map provisioned)
  const mapIds: string[] = [];
  if (server === 'nginx' && layout.web.nginxMap === 'conf_d') {
    const files = new Map<string, ForeignMapFacts[]>();
    for (const row of facts.web.foreignMaps as readonly ForeignMapFacts[]) {
      if (row.file === layout.host.nginxMapInclude || row.file.startsWith(`${layout.host.nginxMapDir}/`)) continue;
      files.set(row.file, [...(files.get(row.file) ?? []), row]);
    }
    for (const [file, rows] of files) {
      const id = `web.nginx_manual_map.${sha8(file)}`;
      mapIds.push(id);
      const variables = rows.map(row => `$${row.variable.replace(/^\$/, '')} (line ${row.line})`).join(', ');
      const first = rows[0] as ForeignMapFacts;
      const problem = rows.find(row => row.parseProblem)?.parseProblem ?? null;
      const title = `the hand-placed media map in ${file}`;
      const why = `${file} defines ${variables}: removing it first breaks the loaded media includes, adding the host map first defines them twice — so the switch is one transaction`;
      if (problem !== null) out.push(blocked(id, 'web', title, [why, `it does not parse as the generated map: ${problem}`]));
      else if (first.fileSha === undefined) out.push(blocked(id, 'web', title, [why, 'discovery did not hash the file, so init cannot prove it unchanged when it acts'], [`remove the three map blocks from ${file} by hand, then re-run`]));
      else {
        out.push(
          item(id, 'web', 'decision', `move the media map from ${file} into the host map`, {
            facts: [why, first.standalone === true ? `${file} holds only those maps: it is removed (backed up)` : `the three map blocks are removed from ${file} (backed up)`],
            commands: [`one configtest and reload under the host web lock; on failure ${file} is restored`],
            options: [ACT_TYPED, MANUAL],
            defaultOption: 'act',
            action: { kind: 'nginx_map_seed', path: file, beforeSha: first.fileSha, standalone: first.standalone === true },
            operatorFile: true,
            after: ['provision.apply'],
          }),
        );
      }
    }
  }

  // web.vhost.<sha8>: one item per file of the site (siteFiles: the transaction choice).
  const twinned = groups.length > 1 || (groups[0]?.rows.length ?? 0) > 1;
  for (const { lead, rows } of groups) {
    const id = `web.vhost.${vhostSha8(lead)}`;
    const includePath = join(layout.instanceDir, `web.${server}.conf`);
    const lines =
      server === 'apache'
        ? [referenceComment(decl.instance), `IncludeOptional ${includePath}`]
        : [referenceComment(decl.instance), `include ${join(layout.instanceDir, 'web.nginx.con')}[f];`];
    const where = (row: Vhost) => `${row.realpath}:${row.line} (${row.serverName}, port ${row.port}${row.addresses.length > 0 ? ` on ${row.addresses.join(', ')}` : ''})`;
    const pending = rows.filter(row => !row.ourReference).sort((x, y) => x.line - y.line);
    const twinFact = twinned
      ? [`${[vhost, ...env.vhostTwins].filter((row): row is Vhost => row !== null).map(where).join(' and ')} serve one site on two address families: each block gets the include, one configtest-and-rollback transaction per file`]
      : [];
    if (pending.length === 0) out.push(right(id, 'web', 'the vhost includes the instance', rows.map(row => `${where(row)} holds the reference`)));
    else if (lead.fileTrust.length > 0) out.push(blocked(id, 'web', `the vhost ${lead.realpath}`, [...lead.fileTrust, 'this file is reported, never edited', ...twinFact], lines));
    else {
      const [first, ...also] = pending as [Vhost, ...Vhost[]];
      const opener = server === 'apache' ? '<VirtualHost>' : 'server {';
      out.push(
        item(id, 'web', 'decision', `add the instance's include to ${lead.realpath}`, {
          facts: [
            ...pending.map(row => `${where(row)}: two lines after the ${opener} line; a removed instance never breaks the server (zero-match include)`),
            ...twinFact,
          ],
          commands: lines,
          diff: { path: lead.realpath, unified: lineEditDiff(lead.realpath, { inserted: pending.map(row => ({ after: row.line, lines })) }) },
          options: [ACT_TYPED, MANUAL],
          defaultOption: 'act',
          action: {
            kind: 'vhost_reference',
            path: lead.realpath,
            beforeSha: lead.fileSha,
            server,
            edit: 'reference',
            line: first.line,
            ...(also.length > 0 ? { alsoLines: also.map(row => row.line) } : {}),
          },
          operatorFile: true,
          after: ['provision.apply', 'web.modules', ...manualIds, ...mapIds],
        }),
      );
    }
  }

  // web.nginx_map (Q1)
  if (server === 'nginx') {
    const shared = 'one map serves every instance on this host; the panel\'s apply_rules pushes it';
    if (layout.web.nginxMap === 'conf_d') out.push(right('web.nginx_map', 'web', 'the host-wide nginx media map', [`provisioned as ${layout.host.nginxMapInclude}; ${shared}`]));
    else if (facts.web.confDInHttp === false) {
      out.push(
        item('web.nginx_map', 'web', 'decision', 'the host-wide nginx media map', {
          facts: ['conf.d is not included inside http{}: put the one line there, then re-run (init never edits nginx.conf)', shared],
          commands: [`include ${layout.host.nginxMapInclude};`],
          options: [MANUAL, SKIP],
          defaultOption: 'manual',
          optional: true,
        }),
      );
    } else out.push(right('web.nginx_map', 'web', 'the host-wide nginx media map', ["web.nginx_map is 'none': the hand-placed map stays the operator's"]));
  }

  // web.logs (home layout; owner decision 1(c)): OUTSIDE the home, in the distribution's log
  // directory, one per site (layout.ts webLogBase). provision apply creates it root's and renders
  // its rotation (render/logrotate.ts); init never edits the vhost's log destinations.
  if (env.homeLayout && vhost !== null) {
    const logsDir = layout.site.webLogsDir;
    // Every block of the site logs somewhere: the twins' logs are judged with the chosen vhost's.
    const logOf = new Map<string, Vhost>();
    for (const row of [vhost, ...env.vhostTwins]) {
      for (const file of [row.errorLog, ...row.accessLogs]) if (file !== null && !logOf.has(file)) logOf.set(file, row);
    }
    const logs = [...logOf.keys()];
    const outside = logs.filter(file => !file.startsWith(`${logsDir}/`));
    const inHome = outside.filter(file => file === layout.site?.home || file.startsWith(`${layout.site?.home}/`));
    const sandboxed = facts.web.unitSandbox !== null && facts.web.unitSandbox.protectHome !== 'no' && facts.web.unitSandbox.protectHome !== '';
    out.push(
      outside.length === 0
        ? right('web.logs', 'web', 'the site logs', [
            logs.length === 0 ? `the vhost names no log of its own; ${logsDir} is ready for it` : `the vhost logs into ${logsDir}`,
            `${layout.logrotatePath} rotates ${logsDir}/*.log (the distribution's own rotation reads one level only)`,
          ])
        : item('web.logs', 'web', 'decision', `move the vhost logs to ${logsDir}`, {
            facts: [
              `${logsDir}: root's, created by provision apply, rotated by ${layout.logrotatePath}; init never edits log destinations`,
              ...outside.map(file => `${(logOf.get(file) ?? vhost).realpath}: ${file}`),
              ...(inHome.length > 0
                ? [
                    sandboxed
                      ? `${facts.web.unit ?? 'the web server'} runs with ProtectHome=: a log under the home passes the configtest, then the unit cannot start`
                      : 'a log under the home is a file root opens in a directory the home layout reserves for the site; logs stay outside it',
                  ]
                : []),
            ],
            commands: outside.map(file => `${file} → ${join(logsDir, basename(file))}`),
            // A sandboxed unit cannot start with a log under the home: nothing to skip. Otherwise the
            // home is no place for root-opened logs, but the server runs: a recommendation.
            options: inHome.length > 0 && sandboxed ? [MANUAL] : [MANUAL, SKIP],
            defaultOption: inHome.length > 0 ? 'manual' : 'skip',
            optional: inHome.length === 0,
            blocking: inHome.length > 0 && sandboxed,
            after: ['provision.apply'],
          }),
    );
  }
  return out;
}

/* ── 18-20. verify.agent, pair.*, init.keep_ref ───────────────────────────────────── */

function tailItems(env: Env, earlier: readonly ComparedItem[]): ComparedItem[] {
  const { layout, ctx, facts } = env;
  if (layout === null) return [];
  const out: ComparedItem[] = [];
  const changes = earlier.some(row => row.list === 'change');
  out.push(
    item('verify.agent', 'verify', changes ? 'change' : 'right', 'the agent answers its health check', {
      facts: [`${layout.agentUnitName} active, then /health with this instance's fingerprint`],
      action: { kind: 'verify_agent' },
      after: ['provision.restart', 'api_config.v2_env', 'api_config.v1_config'],
    }),
  );
  const chosen = env.completion.workUnit?.unit;
  const plan = pairPlan(layout, facts, ctx.args, chosen === undefined ? {} : { chosenUnit: chosen });
  out.push(Object.freeze({ ...pairItem(plan, layout) }) as ComparedItem);
  // keep_ref runs last, after every item a converged run needs — never after an OPTIONAL one: an
  // optional decision answered `skip` (web.logs's default, a stale pairing package kept) drops what
  // runs after it, and keep_ref is required, so the default answer refused the whole run (measured,
  // Ubuntu 24.04.5 two-machine drill, 2026-10-09: the stock vhost logs into ${APACHE_LOG_DIR}).
  const others = [...earlier, ...out].filter(row => !row.optional).map(row => row.id);
  if (ctx.source === null) out.push(right('init.keep_ref', 'init', 'templates for re-runs', ['no source given: the kept templates stay'], { after: others }));
  else {
    out.push(
      item('init.keep_ref', 'init', 'change', 'keep the templates for re-runs', {
        facts: [`root copies of .bun-version, .bun-sha256 and ${env.v1 ? 'the two API samples' : "the v2 API's sample"}, and rerun.env`],
        action: {
          kind: 'keep_ref',
          files: [
            join(ctx.source.dir, '.bun-version'),
            join(ctx.source.dir, '.bun-sha256'),
            join(ctx.source.dir, 'publication/server_api/v2/.env.example'),
            // The v1 sample only for an instance that serves v1 (a v2-only one keeps no PHP template).
            ...(env.v1 && ctx.source.v1Sample !== null ? [join(ctx.source.dir, 'publication/server_api/v1/config_api/sample.server_config_api.php')] : []),
          ],
        },
        after: others,
      }),
    );
  }
  return out;
}
