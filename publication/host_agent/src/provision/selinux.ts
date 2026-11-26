/**
 * SELinux LABELS of one instance (spec S9, decision C) — pure: a function of the derived layout.
 *
 * PRINCIPLE: label only what `httpd_t` (httpd, nginx and php-fpm all run in it) must reach, as
 * narrowly as the access needs. A directory httpd only TRAVERSES gets an exact directory rule
 * (`-f d`, no `(/.*)?`); content it reads gets `httpd_sys_content_t` on that subtree only.
 * Everything else keeps a type httpd cannot read — under the home layout the policy's
 * `user_home_t`, under the system layout the path's default (`var_t` under /srv) — so the secrets
 * (`v2/shared/v2.env`, `audit/`, the v2 releases and staging) are never covered by a rule with an
 * httpd-readable type (HTTPD_READABLE_TYPES; tests/provision_selinux.test.ts holds it). The v2 tree
 * (row S/publication_api/v2) is one systemd must read — its env file and its links — which it may
 * not under `user_home_t` (measured, RHEL 9.8) nor under `var_t` (sesearch, RHEL 9.8): EVERY layout
 * gives it `dedalo_publication_v2_t`, the one type of the provisioner's own policy module
 * (./selinux_module.ts: init_t reads it, httpd_t is given nothing; owner decision 2026-10-09 — one v2
 * type on every EL layout). An earlier provisioner typed the home layout's tree `data_home_t`
 * (RETIRED_SELINUX_TYPES): a plan re-types that rule of ours in place. The v1
 * configuration under `S/publication_api/v1/shared` IS httpd-readable by MAC (the v1 pool runs
 * httpd_t and must read it); it is protected by DAC (`v1:root 0400`) and by the dedicated pool
 * user (decision A).
 *
 * THE ONE RULE ON A PATH THE PROVISIONER DID NOT CREATE is the exact `-f d` rule on the site home
 * (row H: one inode, never `(/.*)?`, never `restorecon -R`). The Remi socket directory is not ours
 * and is never labelled (a wrong label there is init's `host.remi_label`). Never `/`, `/home`,
 * `/var/www`, `/srv` (FORBIDDEN_LABEL_PATHS, refused).
 *
 * The import file (apply.ts) is one `semanage import` transaction; every line is re-checked
 * against IMPORT_LINE_PATTERN (closed types, closed spec grammar, `-a` and `-d`, `-f a|d|f`).
 *
 * Booleans are init's host-wide decisions only (SELINUX_BOOLEANS, defined in ./exec_contract
 * where the exec validators need it, re-exported here); this module never sets one.
 *
 * ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts): node: builtins, ./layout, ./exec_contract,
 * ./selinux_module.
 */
import { dirname, join } from 'node:path';
import type { RestoreconTarget } from './exec_contract';
import { SELINUX_BOOLEANS, SELINUX_READ_ONLY_BOOLEANS } from './exec_contract';
import type { AgentLayout } from './layout';
import { ABSOLUTE_PATH_PATTERN } from './layout';
import { V2_TREE_TYPE } from './selinux_module';

export { SELINUX_BOOLEANS, SELINUX_READ_ONLY_BOOLEANS };
export type { RestoreconTarget };

/** The closed set of types the provisioner ever registers (spec S9). */
export const SELINUX_TYPES = Object.freeze([
  'usr_t',
  'bin_t',
  'home_root_t',
  'httpd_sys_content_t',
  'httpd_sys_rw_content_t',
  'httpd_log_t',
  'httpd_config_t',
  // The provisioner's own policy module (./selinux_module.ts): the v2 tree, every layout.
  V2_TREE_TYPE,
] as const);
export type SelinuxType = (typeof SELINUX_TYPES)[number];

/**
 * Types an EARLIER provisioner registered and this one never registers again: they may appear only in
 * a `-d` import line, which unregisters (or re-types) a rule of ours a previous apply recorded in
 * `selinux.state`. `data_home_t`: the home layout's v2 tree until 2026-10-09 (now V2_TREE_TYPE).
 */
export const RETIRED_SELINUX_TYPES = Object.freeze(['data_home_t'] as const);
/** Every type a `-d` import line may name: ours, and the retired ones. */
export const REMOVABLE_SELINUX_TYPES: readonly string[] = Object.freeze([...SELINUX_TYPES, ...RETIRED_SELINUX_TYPES]);

/** Types `httpd_t` can read (spec S9). No rule covering a secret subtree may use one. */
export const HTTPD_READABLE_TYPES: readonly string[] = Object.freeze([
  'usr_t',
  'httpd_sys_content_t',
  'httpd_config_t',
  'etc_t',
]);

/**
 * The search-only type of the site home's exact directory rule (row H). Candidate, measured by the
 * EL drill (httpd_t can search it; sshd/login of the site user still work).
 */
export const HOME_TRAVERSE_TYPE: SelinuxType = 'home_root_t';

/** The only port type the provisioner registers (the v2 port, proxied by httpd). */
export const V2_PORT_TYPE = 'http_port_t';

/**
 * Paths no rule may ever name: they hold other sites, or they are the system's own trees (a
 * recursive `usr_t` on /usr/local/bin would strip `bin_t` from every program in it).
 */
export const FORBIDDEN_LABEL_PATHS: readonly string[] = Object.freeze([
  '/',
  '/home',
  '/var/www',
  '/var/www/html',
  '/srv',
  '/bin',
  '/sbin',
  '/etc',
  '/opt',
  '/usr',
  '/usr/bin',
  '/usr/sbin',
  '/usr/local',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/var',
  '/var/lib',
  '/var/log',
  '/run',
  '/tmp',
  '/mnt',
]);

/**
 * The bun directory rule (`dirname(B)(/.*)?`) applies only to a DEDICATED bun tree — `<x>/bun/bin`,
 * `<x>/.bun/bin`, `<x>/.dedalo_bun/bin` (the layouts of spec S6) — never to a shared bin directory a
 * hand-written declaration may name (`/usr/local/bin/bun`): there only the binary itself (row B) is labelled.
 */
export const BUN_TREE_NAMES: readonly string[] = Object.freeze(['bun', '.bun', '.dedalo_bun']);

export function dedicatedBunDir(bunBin: string): string | null {
  const bin = dirname(bunBin);
  const tree = dirname(bin);
  const name = tree.slice(tree.lastIndexOf('/') + 1);
  return bin.endsWith('/bin') && BUN_TREE_NAMES.includes(name) ? bin : null;
}

/** `semanage fcontext -f`: a = all files, d = directory, f = regular file. */
export type FileType = 'a' | 'd' | 'f';

export interface FcontextRule {
  /** The S9 table's row name (H, S, S/publication_api, …), for messages and tests. */
  readonly row: string;
  /** The path the rule is about (the directory, file or subtree root). */
  readonly path: string;
  readonly fileType: FileType;
  readonly type: SelinuxType;
  /** `(/.*)?` appended: the subtree. */
  readonly recursive: boolean;
  /** The `semanage fcontext` regex. */
  readonly spec: string;
}

export interface PortRule {
  readonly type: typeof V2_PORT_TYPE;
  readonly proto: 'tcp';
  readonly port: number;
}

/**
 * What the table needs beyond the layout: the media root's eligibility (the plan learns it from the
 * mount table and from the declaration's consent field `media.selinux_label`) and how the home is
 * made traversable.
 */
export interface SelinuxRuleFacts {
  /** The media root lies on a local or `seclabel` filesystem (a network one is labelled by its mount). */
  readonly mediaLabelable: boolean;
  /** Shared media: the declaration says `media.selinux_label: true` (init's `selinux.media_access=act`; an operator path). */
  readonly sharedMediaAccepted: boolean;
  /** `httpd_enable_homedirs` was chosen instead of the H row (init's `selinux.home_traverse` boolean). */
  readonly homeTraverseByBoolean: boolean;
}

export const DEFAULT_RULE_FACTS: SelinuxRuleFacts = Object.freeze({
  mediaLabelable: true,
  sharedMediaAccepted: false,
  homeTraverseByBoolean: false,
});

/** `.` escaped: every path matches ABSOLUTE_PATH_PATTERN, so `.` is its only regex metacharacter. */
export function escapeSpec(path: string): string {
  if (!ABSOLUTE_PATH_PATTERN.test(path) || path.split('/').includes('..')) {
    throw new Error(`selinux: '${path}' is not a clean absolute path`);
  }
  return path.replace(/\./g, '\\.');
}

function rule(row: string, path: string, fileType: FileType, type: SelinuxType, recursive: boolean): FcontextRule {
  if (FORBIDDEN_LABEL_PATHS.includes(path)) throw new Error(`selinux: refusing a rule on '${path}' (it holds other sites)`);
  if (recursive && fileType !== 'a') throw new Error(`selinux: a recursive rule is '-f a' (${row})`);
  const spec = `${escapeSpec(path)}${recursive ? '(/.*)?' : ''}`;
  return Object.freeze({ row, path, fileType, type, recursive, spec });
}

/** The layout is the per-site home one (decision B): its three roots live under `site.home`. */
export function isHomeLayout(layout: AgentLayout): boolean {
  if (layout.site === null) return false;
  const under = (path: string): boolean => path.startsWith(`${layout.site?.home}/`);
  return under(layout.state.root) && under(layout.agentDir) && under(layout.bunBin);
}

/** The S9 label table for this layout, in table order. */
export function selinuxRules(layout: AgentLayout, facts: SelinuxRuleFacts = DEFAULT_RULE_FACTS): FcontextRule[] {
  const S = layout.state.root;
  const rules: FcontextRule[] = [];
  const home = isHomeLayout(layout) ? (layout.site?.home ?? null) : null;
  if (home !== null && !facts.homeTraverseByBoolean) rules.push(rule('H', home, 'd', HOME_TRAVERSE_TYPE, false));
  rules.push(
    rule('S', S, 'd', 'usr_t', false),
    rule('S/publication_api', layout.state.publicationApi, 'd', 'usr_t', false),
  );
  // The v1 tree the web server serves (and the v1 pool runs): none on a v2-only instance.
  if (layout.v1 !== null) rules.push(rule('S/publication_api/v1', layout.v1.dirs.root, 'a', 'httpd_sys_content_t', true));
  // The v2 tree, EVERY layout: its default type is one systemd (init_t) may not read — `user_home_t`
  // under the home layout (measured RHEL 9.8: AVC init_t read on lnk_file/file), `var_t` under /srv
  // (sesearch) — neither `shared/v2.env` (the units' EnvironmentFile=) nor the agent's
  // `current`/`scratch` links (WorkingDirectory=, AssertPathIsDirectory=), so no v2 unit could start.
  // The type is the provisioner's own module's (moduleNeeded): init_t reads it (read-only), httpd_t
  // may not read it under any boolean; what the agent creates in it (links, releases) inherits it.
  // Under /home the local rule beats the policy's generic home-directory entries (a longer stem:
  // matchpathcon and restorecon, measured RHEL 9.8, also after `semodule -B`).
  rules.push(rule('S/publication_api/v2', layout.state.apis.v2.root, 'a', V2_TREE_TYPE, true));
  rules.push(
    rule('S/rules', layout.state.rules, 'a', 'httpd_config_t', true),
    rule('A', layout.agentDir, 'a', 'usr_t', true),
  );
  const bunDir = dedicatedBunDir(layout.bunBin);
  if (bunDir !== null) rules.push(rule('dirname(B)', bunDir, 'a', 'usr_t', true));
  rules.push(rule('B', layout.bunBin, 'f', 'bin_t', false));
  // No rule for the site's web logs: they live in /var/log/<server>/<domain> (layout.ts webLogBase),
  // which the policy's own `/var/log/(httpd|nginx)(/.*)?` rule already types httpd_log_t.
  if (layout.site?.v1 != null) {
    rules.push(
      rule('V/tmp', layout.site.v1.var.tmp, 'a', 'httpd_sys_rw_content_t', true),
      rule('V/log', layout.site.v1.var.log, 'a', 'httpd_log_t', true),
    );
  }
  if (layout.media.root !== null && facts.mediaLabelable) {
    if (layout.media.mode === 'copy' || (layout.media.mode === 'shared' && facts.sharedMediaAccepted)) {
      rules.push(rule('M', layout.media.root, 'a', 'httpd_sys_content_t', true));
    }
  }
  if (layout.web.server === 'nginx' && layout.web.nginxMap === 'conf_d') {
    rules.push(
      rule('N', layout.host.nginxMapDir, 'a', 'httpd_config_t', true),
      rule('R', layout.host.mapRendererDir, 'a', 'usr_t', true),
      rule('R/bun', join(layout.host.mapRendererDir, 'bun'), 'f', 'bin_t', false),
    );
  }
  return rules;
}

/**
 * This layout's labels need the provisioner's SELinux policy module (./selinux_module.ts): its S9
 * table names V2_TREE_TYPE — every layout (the v2 tree; owner decision 2026-10-09). Host-wide: the
 * module stays while any instance on the host needs it.
 */
export function moduleNeeded(layout: AgentLayout): boolean {
  return selinuxRules(layout).some(r => r.type === V2_TREE_TYPE);
}

/** The v2 port label (spec S9): v2 is always declared and httpd proxies to it. */
export function selinuxPort(layout: AgentLayout): PortRule {
  return Object.freeze({ type: V2_PORT_TYPE, proto: 'tcp', port: layout.v2.port });
}

/**
 * restorecon targets for the rules: a recursive row relabels its subtree (`-R`), an exact `-f d` /
 * `-f f` row only its own inode (the H directory is never `-R`). Deduplicated, table order.
 */
export function restoreconTargets(layout: AgentLayout, facts: SelinuxRuleFacts = DEFAULT_RULE_FACTS): RestoreconTarget[] {
  const out: RestoreconTarget[] = [];
  const seen = new Set<string>();
  for (const r of selinuxRules(layout, facts)) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(Object.freeze({ path: r.path, recursive: r.recursive }));
  }
  return out;
}

/* ── the import file ──────────────────────────────────────────────────────────────── */

export type ImportEntry =
  | { readonly kind: 'fcontext'; readonly fileType: FileType; readonly type: string; readonly spec: string }
  | { readonly kind: 'port'; readonly type: string; readonly port: number };

const TYPE_ALTERNATION = SELINUX_TYPES.join('|');
/** A spec: an escaped clean absolute path, optionally `(/.*)?`. No quote, no space, no other metacharacter. */
const SPEC_BODY = String.raw`/(?:[A-Za-z0-9_/-]|\\\.)*(?:\(/\.\*\)\?)?`;
const PORT_NUMBER = String.raw`(?:6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3})`;

const REMOVABLE_ALTERNATION = REMOVABLE_SELINUX_TYPES.join('|');

/**
 * Every line an import file may hold (spec §5.9). The renderer re-checks each line against it. An
 * `-a` names one of SELINUX_TYPES; a `-d` may also name a RETIRED type (a rule an earlier
 * provisioner registered, unregistered or re-typed).
 */
export const IMPORT_LINE_PATTERN = new RegExp(
  `^(?:fcontext -a -f [adf] -t (?:${TYPE_ALTERNATION}) '${SPEC_BODY}'|fcontext -d -f [adf] -t (?:${REMOVABLE_ALTERNATION}) '${SPEC_BODY}'|port -[ad] -t ${V2_PORT_TYPE} -p tcp ${PORT_NUMBER})$`,
);

function line(op: 'a' | 'd', entry: ImportEntry): string {
  const text =
    entry.kind === 'fcontext'
      ? `fcontext -${op} -f ${entry.fileType} -t ${entry.type} '${entry.spec}'`
      : `port -${op} -t ${entry.type} -p tcp ${entry.port}`;
  if (!IMPORT_LINE_PATTERN.test(text)) throw new Error(`selinux: refusing the import line ${JSON.stringify(text)}`);
  if (entry.kind === 'fcontext') {
    // `(/.*)?` only on an `-f a` rule: an exact directory/file rule never covers a subtree.
    if (entry.spec.endsWith('(/.*)?') && entry.fileType !== 'a') {
      throw new Error(`selinux: refusing ${JSON.stringify(text)} — a '-f ${entry.fileType}' rule is exact, never '(/.*)?'`);
    }
    const bare = entry.spec.replace(/\(\/\.\*\)\?$/, '').replace(/\\\./g, '.');
    if (FORBIDDEN_LABEL_PATHS.includes(bare)) throw new Error(`selinux: refusing a rule on '${bare}'`);
  }
  return text;
}

/** The import file's lines: every `-d` first (a relocation, a port change), then every `-a`. */
export function importLines(add: readonly ImportEntry[], del: readonly ImportEntry[] = []): string[] {
  return [...del.map(entry => line('d', entry)), ...add.map(entry => line('a', entry))];
}

export function fcontextEntry(r: { readonly fileType: FileType; readonly type: string; readonly spec: string }): ImportEntry {
  return { kind: 'fcontext', fileType: r.fileType, type: r.type, spec: r.spec };
}

export function portEntry(port: number): ImportEntry {
  return { kind: 'port', type: V2_PORT_TYPE, port };
}

/* ── the registration history (spec S9 port lifecycle) ────────────────────────────── */

/** `<configBase>/<instance>/selinux.state` (root 0644): what the last apply registered. */
export const SELINUX_STATE_NAME = 'selinux.state';
/** `<configBase>/<instance>/selinux.import` — written as its provisioner temp, never left behind. */
export const SELINUX_IMPORT_NAME = 'selinux.import';

export interface SelinuxState {
  readonly v: 1;
  readonly fcontext: readonly { readonly spec: string; readonly fileType: FileType; readonly type: string }[];
  readonly ports: readonly number[];
}

export function encodeSelinuxState(state: SelinuxState): string {
  const fcontext = [...state.fcontext].sort((a, b) => (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));
  const ports = [...new Set(state.ports)].sort((a, b) => a - b);
  return `${JSON.stringify({ v: 1, fcontext, ports }, null, 2)}\n`;
}

/** null for anything that is not a well-formed state file (never a throw: the plan then registers anew). */
export function parseSelinuxState(text: string | null): SelinuxState | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.v !== 1 || !Array.isArray(raw.fcontext) || !Array.isArray(raw.ports)) return null;
    const fcontext = raw.fcontext.map(item => {
      const r = item as Record<string, unknown>;
      if (typeof r.spec !== 'string' || typeof r.type !== 'string' || !['a', 'd', 'f'].includes(String(r.fileType))) {
        throw new Error('bad');
      }
      return { spec: r.spec, fileType: r.fileType as FileType, type: r.type };
    });
    const ports = raw.ports.map(port => {
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad');
      return port;
    });
    return { v: 1, fcontext, ports };
  } catch {
    return null;
  }
}

/** Whether labels are managed at all, and how far, for an observed SELinux mode (spec S9). */
export function labelScope(
  mode: 'absent' | 'disabled' | 'permissive' | 'enforcing',
  storePresent: boolean,
): { readonly register: boolean; readonly relabel: boolean } {
  if (mode === 'permissive' || mode === 'enforcing') return { register: true, relabel: true };
  if (mode === 'disabled' && storePresent) return { register: true, relabel: false };
  return { register: false, relabel: false };
}

/**
 * THE EL DRILL'S INPUTS (spec §9.11): the agent-package files (package-relative) whose behaviour only
 * an SELinux-enforcing EL VM can prove — the S9 label table, the renderers EL runs (pool, include,
 * units, their dated directives, the nginx map pieces), the parsers of EL discovery, install.sh, and
 * the fapolicyd trust set, its oneshot and its parser (owner decision 2026-10-09). The
 * drill's `--record` digests them into engineering/el_drill_record.json; the root ratchet
 * (test/unit/publication_host_el_drill_record.test.ts) recomputes the digest and is red when any of
 * them changed after the last recorded drill. Sorted; every entry exists (tests/provision_selinux).
 */
export const EL_DRILL_INPUTS: readonly string[] = Object.freeze([
  'deploy/install.sh',
  'src/provision/fapolicyd_trust.ts',
  'src/provision/fapolicyd_trust_main.ts',
  'src/provision/init/parse/apache.ts',
  'src/provision/init/parse/fapolicyd.ts',
  'src/provision/init/parse/fpm.ts',
  'src/provision/init/parse/mounts.ts',
  'src/provision/init/parse/os.ts',
  // parse/apache.ts's redirect-only classification (which EL vhost may receive the include).
  'src/provision/init/parse/redirect.ts',
  'src/provision/init/parse/selinux.ts',
  'src/provision/render/fpm_pool.ts',
  'src/provision/render/host_map_unit.ts',
  'src/provision/render/nginx_map_include.ts',
  'src/provision/render/systemd_floors.ts',
  'src/provision/render/trust_unit.ts',
  'src/provision/render/unit_agent.ts',
  'src/provision/render/unit_v2.ts',
  'src/provision/render/web_include.ts',
  'src/provision/selinux.ts',
  'src/provision/selinux_module.ts',
]);
