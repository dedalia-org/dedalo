/**
 * THE DRAFT and its completion (spec S1, S6, §4.3 `declaration.*`). A draft is the declaration
 * format with the fields discovery can fill left out, plus the draft-only `layout`
 * (`home` | `system`). `completeDraft` fills every missing field from the host facts, names the
 * source of each, and lists the choices it had to make as DECISIONS (fixed ids, compare turns
 * them into items). It never refuses: a field it cannot fill is `unfilled`, a value derive()
 * refuses is `layoutError` — compare shows both, init acts on neither.
 *
 * Answers (the `--decide` map merged with what the operator typed) steer the completion; an
 * answer is only ever one of the options the decision offered (run.ts validates them against
 * compare's items, `unknownAnswers`). Until a decision is answered its DEFAULT fills the field,
 * so the second observe pass (observeDeclared) sees a whole declaration — but the decision stays
 * open: a default is shown, never taken (spec §1.2 TTY).
 *
 * Layout (decision B, S6): `home` = /home/<domain>/{dedalo, host_agent, .bun/bin/bun, logs} is the
 * default when the draft has a site; `system` = /srv + /opt is the alternative, the only layout
 * without a site, and the automatic fallback when the home cannot be given to root
 * (homeCannotBeRoot: a symlink, a non-root ancestor, a network filesystem, `noexec`, a web/FPM
 * unit sandbox hiding it). A hosting panel is NOT a reason: host.panel blocks on its own.
 *
 * PURE, ZERO-DEPENDENCY: node: builtins, layout.ts, selinux.ts, the init contract (types.ts) and
 * the discovery parsers' pure helpers (parse/mounts, parse/systemd) — reused, never restated.
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  AgentLayout,
  DeclaredListen,
  FpmFlavor,
  HostDeclaration,
  LayoutKind,
  NginxMapMode,
  OsFamily,
  WebServer,
} from '../layout';
import {
  ABSOLUTE_PATH_PATTERN,
  FORBIDDEN_V1_USERS,
  HOME_LAYOUT_NAMES,
  HOME_RELOCATED_NAMES,
  LayoutError,
  UNIT_NAME_PATTERN,
  UNIX_NAME_PATTERN,
  V1_PHP_FLOOR,
  derive,
  fpmLayout,
  inferLayout,
  layoutPaths,
} from '../layout';
import { labelScope } from '../selinux';
import { unitOptionId } from './pair';
import { isNetworkFs, mountOf } from './parse/mounts';
import { sandboxHides } from './parse/systemd';
import type { DeclaredFacts, FpmInstall, HostFacts, ItemArea, ItemOption, Vhost, WorkUnit } from './types';

export { isNetworkFs, mountOf, sandboxHides, unitOptionId };

/* ── the draft ───────────────────────────────────────────────────────────────────────── */

/**
 * The draft-only API choice (draft_schema.ts header): `v2_only` (recommended for a new site: no
 * PHP anywhere) or `v1_and_v2` (the legacy Publication API v1 too, for a v6-era website).
 */
export type DraftApis = 'v2_only' | 'v1_and_v2';

/** Does this draft serve v1? `apis` when given, else the draft's own `v1` block (a declaration's rule). */
export function draftServesV1(draft: Pick<DraftDeclaration, 'apis' | 'v1'>): boolean {
  return draft.apis === undefined ? draft.v1 !== undefined : draft.apis === 'v1_and_v2';
}

/** The declaration with every discoverable field optional, plus the draft-only `layout` and `apis` (S1). */
export interface DraftDeclaration {
  readonly instance: string;
  readonly layout?: LayoutKind;
  readonly apis?: DraftApis;
  readonly listen?: DeclaredListen;
  readonly agent_user?: string;
  readonly engine_group?: string;
  readonly agent_dir?: string;
  readonly web?: {
    readonly server?: WebServer;
    readonly unit?: string;
    readonly nginx_map?: NginxMapMode;
    readonly log_dirs?: readonly string[];
  };
  readonly site?: {
    readonly domain: string;
    readonly home?: string;
    readonly os_family?: OsFamily;
    readonly api_paths?: { readonly v1?: string; readonly v2: string };
    readonly fpm?: { readonly flavor: FpmFlavor; readonly version: string };
  };
  readonly v1?: { readonly user?: string };
  readonly state_root?: string;
  readonly media: HostDeclaration['media'];
  readonly php_bin?: string;
  readonly bun_bin?: string;
  readonly v2?: Partial<HostDeclaration['v2']>;
  readonly releases_retained?: number;
  readonly paths?: HostDeclaration['paths'];
}

/**
 * The shared-media SELinux consent (`media.selinux_label`, spec S9 row M): stated by the draft,
 * given now (`selinux.media_access=act`), or kept from the existing declaration for the SAME
 * shared root. Only shared mode carries it (copy mode is always labelled).
 */
function mediaWithConsent(media: HostDeclaration['media'], existing: HostDeclaration | null, answers: ReadonlyMap<string, string>): HostDeclaration['media'] {
  if (media.mode !== 'shared') return media;
  const kept = existing?.media.selinux_label === true && existing.media.mode === 'shared' && existing.media.root === media.root;
  if (media.selinux_label === true || answers.get('selinux.media_access') === 'act' || kept) return { ...media, selinux_label: true };
  return media;
}

/** The layout kinds a draft may name (draft_schema.ts's enum; S6). */
export const LAYOUTS: readonly LayoutKind[] = Object.freeze(['home', 'system']);

/** What discovery cannot find and a draft did not say: the proposals (spec S5, §4.3). */
export const DEFAULTS = Object.freeze({
  listen: Object.freeze({ kind: 'unix' }) as DeclaredListen,
  v2Port: 3100,
  phpBin: '/usr/bin/php',
  agentUser: (instance: string) => `${instance}_agent`,
  v1User: (instance: string) => `${instance}_v1`,
  v2User: (instance: string) => `${instance}_v2`,
  v2Unit: (instance: string) => `dedalo-publication-api-v2-${instance}`,
  webUnit: Object.freeze({ apache: Object.freeze({ debian: 'apache2', el: 'httpd' }), nginx: 'nginx' }),
});

/* ── decisions the completion makes (compare renders them as items) ───────────────────── */

/** The completion's decision ids — a subset of compare's fixed catalog (ITEM_IDS). */
export const DRAFT_DECISION_IDS = Object.freeze([
  'host.web',
  'declaration.layout',
  'declaration.fpm',
  'declaration.vhost',
  'declaration.work_unit',
  'declaration.v2_port',
  'declaration.v1_user',
] as const);
export type DraftDecisionId = (typeof DRAFT_DECISION_IDS)[number];

export interface DraftDecision {
  readonly id: DraftDecisionId;
  readonly area: ItemArea;
  readonly title: string;
  readonly facts: readonly string[];
  readonly commands: readonly string[];
  readonly options: readonly ItemOption[];
  readonly defaultOption?: string;
  /** No option lets init continue (only `manual`), or the choice is unsafe to default. */
  readonly blocking: boolean;
}

export interface DraftCompletion {
  /** null when a required field could not be filled (`unfilled`). May still fail derive (`layoutError`). */
  readonly declaration: HostDeclaration | null;
  /** derive(declaration), or null (no declaration, or `layoutError`). */
  readonly layout: AgentLayout | null;
  readonly layoutError: string | null;
  /** The layout the paths follow (S6); null without a declaration. */
  readonly kind: LayoutKind | null;
  /** How the kind was settled: named by the draft, fixed by the existing declaration or the draft's paths, or proposed. */
  readonly kindSource: 'draft' | 'existing' | 'paths' | 'no_site' | 'proposed' | 'answered' | null;
  /** Field path → where its value came from (`declaration.fields`), for every field the draft left out. */
  readonly sources: ReadonlyMap<string, string>;
  readonly decisions: readonly DraftDecision[];
  readonly unfilled: readonly { readonly field: string; readonly reason: string }[];
  /** Why the site home cannot be given to root (S6); empty when it can (or there is no site). */
  readonly homeReasons: readonly string[];
  /** The site's chosen vhost / FPM install / work unit, when there is one. */
  readonly vhost: Vhost | null;
  /**
   * The chosen vhost's ADDRESS-FAMILY TWINS: separate blocks of the same site — same exact
   * ServerName, port and TLS-ness, one on IPv4/wildcard and one on IPv6 (chooseVhost). Each receives
   * the same include (compare web.vhost.<sha8>); `vhost` stays the one the FPM pick and the
   * per-site facts read. Empty for a site served by one block.
   */
  readonly vhostTwins: readonly Vhost[];
  readonly fpm: FpmInstall | null;
  readonly workUnit: WorkUnit | null;
  /** The final declaration already on the host, the diff base (spec §1.2). */
  readonly existing: HostDeclaration | null;
  /** The draft's site domain (the site exists even when its declaration could not be completed). */
  readonly siteDomain: string | null;
  /** The answers this completion applied (compare reads option-dependent output from them). */
  readonly answers: ReadonlyMap<string, string>;
  /** Does the instance serve the Publication API v1 (draftServesV1)? False: v2-only, no PHP item. */
  readonly servesV1: boolean;
}

export interface CompleteOptions {
  /** The final declaration already on the host, when there is one. */
  readonly existing?: HostDeclaration | null;
  /** `--decide` merged with the operator's typed answers. */
  readonly answers?: ReadonlyMap<string, string>;
  /** The second observe pass, on a recompute: settles the home reasons and the relocations. */
  readonly declared?: DeclaredFacts | null;
}

/* ── helpers shared with compare ──────────────────────────────────────────────────────── */

/** `sha8` of a vhost (spec §4.3 web.vhost): first 8 hex of sha256(realpath\0port\0serverName). */
export function vhostSha8(vhost: Pick<Vhost, 'realpath' | 'port' | 'serverName'>): string {
  return createHash('sha256').update(`${vhost.realpath}\0${vhost.port}\0${vhost.serverName}`).digest('hex').slice(0, 8);
}

function under(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

/** `<major>.<minor>[.<patch>]` ≥ floor, numerically. */
export function versionAtLeast(version: string, floor: string): boolean {
  const a = version.split('.').map(part => Number.parseInt(part, 10));
  const b = floor.split('.').map(part => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/** The option id of one FPM install (`--decide declaration.fpm=remi-8-4`). */
export function fpmOptionId(install: Pick<FpmInstall, 'flavor' | 'version'>): string {
  return `${install.flavor}-${install.version.replace(/\./g, '-')}`;
}

/** FPM installs v1 may run in: at or above V1_PHP_FLOOR (spec S5, §4.3 host.fpm_install). */
export function fpmCandidates(facts: HostFacts): FpmInstall[] {
  return facts.fpm.filter(install => versionAtLeast(install.version, V1_PHP_FLOOR));
}

/** SELinux rules are registered here (S9): EL, and enabled — or disabled with the policy store and tools present. */
export function selinuxRegisters(facts: HostFacts): boolean {
  const scope = labelScope(facts.selinux.mode, facts.selinux.storePresent);
  return facts.os.family === 'el' && scope.register && (scope.relabel || facts.selinux.tools.semanage);
}

/** A port the policy already types as something other than http_port_t (S9: refused, never relabelled). */
export function portTypedOtherwise(facts: HostFacts, port: number): string | null {
  if (!selinuxRegisters(facts)) return null;
  const type = facts.selinux.portTypes.get(port);
  return type === undefined || type === 'http_port_t' ? null : type;
}

function socketOf(handler: string | null): string | null {
  const match = handler?.match(/unix:(\/[^|"\s]+)/);
  return match?.[1] ?? null;
}

/* ── the home (decision B) ────────────────────────────────────────────────────────────── */

/**
 * Why the site home cannot be given to root (spec S6), one fact per reason. From the host facts:
 * its filesystem (network, `noexec`) and the web/FPM unit sandboxes. From the second pass, when
 * known: the home being a symlink (or not a directory), an ancestor not root-owned or writable by
 * group/other. A hosting panel is not a reason (host.panel blocks on its own).
 */
export function homeCannotBeRoot(
  home: string,
  facts: HostFacts,
  fpm: FpmInstall | null,
  declared?: DeclaredFacts | null,
): string[] {
  const reasons: string[] = [];
  const own = declared?.home.facts ?? null;
  if (own !== null && own.type === 'symlink') reasons.push(`${home} is a symlink${own.target === undefined ? '' : ` (to ${own.target})`}`);
  else if (own !== null && own.type !== 'dir') reasons.push(`${home} exists and is not a directory`);
  if (declared !== null && declared !== undefined) {
    for (let at = dirname(home); ; at = dirname(at)) {
      const row = declared.paths.get(at);
      if (row !== undefined) {
        if (row.type === 'symlink') reasons.push(`${at} (an ancestor of ${home}) is a symlink`);
        else if (row.uid !== 0) reasons.push(`${at} (an ancestor of ${home}) is not root-owned (uid ${row.uid})`);
        else if ((row.mode & 0o022) !== 0) reasons.push(`${at} (an ancestor of ${home}) is group- or other-writable (${modeText(row.mode)})`);
      }
      if (at === '/') break;
    }
  }
  const mount = mountOf(home, facts.mounts);
  if (mount !== null && isNetworkFs(mount.fsType)) {
    reasons.push(`${home} is on a ${mount.fsType} filesystem (${mount.mountPoint}): root cannot own what the server may remap`);
  }
  if (mount !== null && mount.noexec) {
    reasons.push(`${mount.mountPoint} is mounted noexec: root would run bun_bin from under ${home}`);
  }
  if (facts.web.unitSandbox !== null) {
    for (const why of sandboxHides(facts.web.unitSandbox, home)) reasons.push(`the web server's unit (${facts.web.unit ?? 'unknown'}): ${why}`);
  }
  if (fpm !== null && fpm.unitSandbox !== null) {
    for (const why of sandboxHides(fpm.unitSandbox, home)) reasons.push(`the PHP-FPM unit (${fpm.unit}): ${why}`);
  }
  return reasons;
}

export function modeText(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

/* ── completeDraft ────────────────────────────────────────────────────────────────────── */

const MANUAL: ItemOption = Object.freeze({ id: 'manual', label: 'I will settle this by hand (the commands are printed)', resolves: 'manual' });

function pickFpm(candidates: readonly FpmInstall[], vhost: Vhost | null): FpmInstall | null {
  const socket = socketOf(vhost?.fpmHandler ?? null);
  if (socket !== null) {
    const owner = candidates.find(install => under(socket, install.socketDir));
    if (owner !== undefined) return owner;
  }
  const highest = (rows: FpmInstall[]) =>
    rows.sort((x, y) => (versionAtLeast(x.version, y.version) ? -1 : 1))[0] ?? null;
  return (
    highest(candidates.filter(install => install.flavor === 'remi' && install.cli !== null)) ??
    highest(candidates.filter(install => install.flavor === 'el')) ??
    highest(candidates.filter(install => install.flavor === 'debian' && install.cli !== null)) ??
    highest([...candidates])
  );
}

interface VhostChoice {
  readonly vhost: Vhost | null;
  readonly twins: readonly Vhost[];
  readonly decision: DraftDecision | null;
}

/**
 * An address's family. Bracketed or colon-bearing = IPv6; everything else — `*`, `_default_`,
 * `0.0.0.0`, an IPv4 address, a host name — is the IPv4/wildcard side (nginx's bare `listen 443`
 * is IPv4 only; Apache's `*` may also take IPv6, but an operator who wrote a separate `[::]` block
 * meant the two to split the families).
 */
export function addressFamily(address: string): 'ipv4' | 'ipv6' {
  return address.startsWith('[') || address.includes(':') ? 'ipv6' : 'ipv4';
}

function familiesOf(vhost: Vhost): Set<'ipv4' | 'ipv6'> {
  return new Set((vhost.addresses.length > 0 ? vhost.addresses : ['*']).map(addressFamily));
}

/** A row as the report names it: file:line, port, EVERY address it listens on, TLS. */
export function describeVhost(vhost: Vhost): string {
  const on = vhost.addresses.length > 0 ? ` on ${vhost.addresses.join(', ')}` : '';
  return `${vhost.realpath}:${vhost.line} port ${vhost.port}${on}${vhost.ssl ? ' (TLS)' : ''}`;
}

/** One site: the vhost the include and the per-site facts start from, and its address-family twins. */
interface VhostSite {
  readonly primary: Vhost;
  readonly twins: readonly Vhost[];
}

function describeSite(site: VhostSite): string {
  return [site.primary, ...site.twins].map(describeVhost).join(' + ');
}

/**
 * The exact-ServerName serving rows of ONE port → one site, or null when they are genuinely
 * different blocks ("crowded"). Several rows are one site only as address-family twins: the same
 * TLS-ness and pairwise-disjoint families (one IPv4/wildcard block, one IPv6 block). Two blocks
 * sharing a family on one port are two servings of the name — which one Apache or nginx answers
 * with is not init's to guess, so that stays the blocking manual decision. The primary is the
 * IPv4/wildcard row (then by file and line): a fixed choice, so the item ids stay stable.
 */
function siteOfPort(rows: readonly Vhost[]): VhostSite | null {
  const first = rows[0];
  if (first === undefined) return null;
  if (rows.some(row => row.ssl !== first.ssl)) return null;
  const seen = new Set<string>();
  for (const row of rows) {
    for (const family of familiesOf(row)) {
      if (seen.has(family)) return null;
      seen.add(family);
    }
  }
  const sorted = [...rows].sort(
    (x, y) =>
      Number(!familiesOf(x).has('ipv4')) - Number(!familiesOf(y).has('ipv4')) ||
      (x.realpath < y.realpath ? -1 : x.realpath > y.realpath ? 1 : 0) ||
      x.line - y.line,
  );
  return { primary: sorted[0] as Vhost, twins: sorted.slice(1) };
}

/**
 * declaration.vhost (spec §3.2 web.vhost — security: a candidate only on an EXACT ServerName).
 * Redirect-only rows (the :80 → https:// block) are never candidates; only redirects claiming the
 * name is a blocker naming the missing serving vhost. The candidates form one site per port
 * (siteOfPort); one site is taken without asking, several (a plain :80 that serves, and the TLS
 * :443) are a non-blocking decision that proposes the TLS one.
 */
function chooseVhost(domain: string, facts: HostFacts, answer: string | undefined): VhostChoice {
  const exactAll = facts.web.vhosts.filter(vhost => vhost.serverName === domain && vhost.matchedBy === 'servername');
  const redirects = exactAll.filter(vhost => vhost.redirectOnly);
  const exact = exactAll.filter(vhost => !vhost.redirectOnly);
  const loose = facts.web.vhosts.filter(vhost => vhost.serverName === domain && vhost.matchedBy !== 'servername');
  const title = `the vhost that serves ${domain}`;
  const redirectFacts = redirects.map(vhost => `${describeVhost(vhost)} only redirects every request: it never receives the APIs include`);
  const blocking = (facts_: string[]): VhostChoice => ({
    vhost: null,
    twins: [],
    decision: { id: 'declaration.vhost', area: 'declaration', title, facts: facts_, commands: [], options: [MANUAL], defaultOption: 'manual', blocking: true },
  });
  if (exact.length === 0) {
    const server = facts.web.server ?? 'web server';
    if (redirects.length > 0) {
      return blocking([
        ...redirectFacts,
        `no ${server} vhost with ServerName ${domain} serves the site — only redirects claim it: the vhost they send to (the TLS one) is missing; init never creates a vhost`,
        ...loose.map(vhost => `${describeVhost(vhost)} matches ${domain} only by ${vhost.matchedBy}: init edits a vhost only on an exact ServerName`),
      ]);
    }
    return blocking(
      loose.length > 0
        ? loose.map(vhost => `${describeVhost(vhost)} matches ${domain} only by ${vhost.matchedBy}: init edits a vhost only on an exact ServerName`)
        : [`no ${server} vhost has ServerName ${domain}; init never creates a vhost`],
    );
  }
  const ports = new Map<number, Vhost[]>();
  for (const vhost of exact) ports.set(vhost.port, [...(ports.get(vhost.port) ?? []), vhost]);
  const sites: VhostSite[] = [];
  const crowded: [number, Vhost[]][] = [];
  for (const [port, rows] of ports) {
    const site = siteOfPort(rows);
    if (site === null) crowded.push([port, rows]);
    else sites.push(site);
  }
  if (crowded.length > 0) {
    return blocking(
      crowded.flatMap(([port, rows]) => [`port ${port} has ${rows.length} different vhosts claiming ServerName ${domain}:`, ...rows.map(describeVhost)]),
    );
  }
  if (sites.length === 1) {
    const site = sites[0] as VhostSite;
    return { vhost: site.primary, twins: site.twins, decision: null };
  }
  const optionId = (site: VhostSite) => `v-${vhostSha8(site.primary)}`;
  const options = sites.map(site => ({ id: optionId(site), label: describeSite(site), resolves: 'act' as const }));
  const tls = sites.filter(site => site.primary.ssl && site.primary.port !== 80);
  const proposed = tls.length === 1 ? (tls[0] as VhostSite) : null;
  const answered = sites.find(site => answer === optionId(site)) ?? null;
  const chosen = answered ?? proposed;
  return {
    vhost: chosen?.primary ?? null,
    twins: chosen?.twins ?? [],
    decision: {
      id: 'declaration.vhost',
      area: 'declaration',
      title,
      facts: [`${sites.length} vhosts have ServerName ${domain}; the include goes into one`, ...sites.map(describeSite), ...redirectFacts],
      commands: [],
      options,
      ...(proposed === null ? {} : { defaultOption: optionId(proposed) }),
      blocking: false,
    },
  };
}

function nextFreePort(facts: HostFacts, from: number, taken: ReadonlySet<number>): number | null {
  for (let port = from + 1; port <= 65535; port += 1) {
    if (facts.ports.includes(port) || taken.has(port)) continue;
    if (selinuxRegisters(facts) && facts.selinux.portTypes.has(port)) continue;
    return port;
  }
  return null;
}

/** The log directories of the site's blocks (the chosen vhost and its twins: each may name its own). */
function logDirs(vhosts: readonly Vhost[]): string[] {
  const files = vhosts.flatMap(vhost => [vhost.errorLog, ...vhost.accessLogs]).filter((file): file is string => file !== null);
  const dirs = files
    .filter(file => ABSOLUTE_PATH_PATTERN.test(file) && !file.split('/').includes('..'))
    .map(file => dirname(file))
    .filter(dir => dir !== '/');
  return [...new Set(dirs)].sort();
}

/**
 * Fill the draft from the host facts (spec S1, S6, §4.3 `declaration.*`). See the module header.
 */
export function completeDraft(draft: DraftDeclaration, facts: HostFacts, options: CompleteOptions = {}): DraftCompletion {
  const existing = options.existing ?? null;
  const answers = options.answers ?? new Map<string, string>();
  const declared = options.declared ?? null;
  const instance = draft.instance;
  const sources = new Map<string, string>();
  const decisions: DraftDecision[] = [];
  const unfilled: { field: string; reason: string }[] = [];
  const fill = <T>(field: string, given: T | undefined, value: T | undefined, source: string): T | undefined => {
    if (given !== undefined) return given;
    if (value !== undefined) sources.set(field, source);
    return value;
  };
  // v2-only (no v1 block, or apis 'v2_only'): no PHP is looked for, proposed or declared.
  const servesV1 = draftServesV1(draft);

  /* web server */
  let server: WebServer | undefined = draft.web?.server;
  if (server === undefined) {
    const candidates = facts.web.candidates;
    if (candidates.length === 0) {
      unfilled.push({ field: 'web.server', reason: 'no apache or nginx unit was found (host.web)' });
    } else if (candidates.length === 1) {
      server = fill('web.server', undefined, candidates[0], `the only web server unit (${facts.web.unit ?? candidates[0]})`);
    } else {
      const answered = candidates.find(candidate => answers.get('host.web') === candidate);
      const proposed = facts.web.server ?? (candidates[0] as WebServer);
      server = fill('web.server', undefined, answered ?? proposed, answered === undefined ? 'proposed (host.web is open)' : 'answered (host.web)');
      decisions.push({
        id: 'host.web',
        area: 'host',
        title: 'which web server serves the site',
        facts: [`both ${candidates.join(' and ')} are installed; init configures one`],
        commands: [],
        options: candidates.map(candidate => ({ id: candidate, label: candidate, resolves: 'act' as const })),
        defaultOption: proposed,
        blocking: false,
      });
    }
  }
  const webFlavor = facts.web.flavor ?? (facts.os.family === 'el' ? 'el' : 'debian');
  const webUnit =
    server === undefined
      ? undefined
      : fill(
          'web.unit',
          draft.web?.unit,
          server === facts.web.server && facts.web.unit !== null
            ? facts.web.unit
            : server === 'apache'
              ? DEFAULTS.webUnit.apache[webFlavor]
              : DEFAULTS.webUnit.nginx,
          server === facts.web.server && facts.web.unit !== null ? 'the running web server unit' : `the ${webFlavor} ${server} unit name`,
        );

  /* site: vhost, FPM, home */
  const site = draft.site;
  let vhost: Vhost | null = null;
  let vhostTwins: readonly Vhost[] = [];
  let fpm: FpmInstall | null = null;
  let siteFpm: { flavor: FpmFlavor; version: string } | undefined;
  if (site !== undefined) {
    const choice = chooseVhost(site.domain, facts, answers.get('declaration.vhost'));
    vhost = choice.vhost;
    vhostTwins = choice.twins;
    if (choice.decision !== null) decisions.push(choice.decision);
    const candidates = servesV1 ? fpmCandidates(facts) : [];
    if (!servesV1) {
      // A v2-only site: no FPM install is chosen (a declared site.fpm is derive's to refuse, by name).
    } else if (site.fpm !== undefined) {
      siteFpm = { ...site.fpm };
      fpm = facts.fpm.find(install => install.flavor === site.fpm?.flavor && install.version === site.fpm.version) ?? null;
    } else if (candidates.length === 0) {
      unfilled.push({ field: 'site.fpm', reason: `no PHP-FPM ≥ ${V1_PHP_FLOOR} is installed (host.fpm_install)` });
    } else {
      const proposed = pickFpm([...candidates], vhost) as FpmInstall;
      const answered = candidates.find(install => answers.get('declaration.fpm') === fpmOptionId(install)) ?? null;
      fpm = answered ?? proposed;
      siteFpm = { flavor: fpm.flavor, version: fpm.version };
      sources.set(
        'site.fpm',
        candidates.length === 1 ? `the only PHP-FPM ≥ ${V1_PHP_FLOOR} (${fpm.unit})` : answered !== null ? 'answered (declaration.fpm)' : 'proposed (declaration.fpm is open)',
      );
      if (candidates.length > 1) {
        decisions.push({
          id: 'declaration.fpm',
          area: 'declaration',
          title: "the PHP-FPM install v1's own pool runs in",
          facts: candidates.map(install => `${install.flavor} PHP ${install.version}: ${install.unit}${install.cli === null ? ' (no CLI)' : ''}`),
          commands: [],
          options: candidates.map(install => ({ id: fpmOptionId(install), label: `${install.flavor} PHP ${install.version} (${install.unit})`, resolves: 'act' as const })),
          defaultOption: fpmOptionId(proposed),
          blocking: false,
        });
      }
    }
  }

  /* layout (S6) */
  const home = site === undefined ? null : (site.home ?? join('/home', site.domain));
  const homeReasons = home === null ? [] : homeCannotBeRoot(home, facts, fpm, declared);
  const pathsGiven = draft.state_root !== undefined && draft.agent_dir !== undefined && draft.bun_bin !== undefined;
  const layoutAnswer = answers.get('declaration.layout');
  const relocateAnswer = answers.get('selinux.home_traverse') === 'relocate';
  let kind: LayoutKind;
  let kindSource: NonNullable<DraftCompletion['kindSource']>;
  if (site === undefined) {
    kind = 'system';
    kindSource = 'no_site';
  } else if (relocateAnswer || layoutAnswer === 'system' || (layoutAnswer === 'home' && homeReasons.length === 0)) {
    // An answer re-lays the paths even when the draft spelled them (a re-run's draft is the
    // existing declaration: `relocate` must move it, spec §4.3 selinux.home_traverse).
    kind = relocateAnswer ? 'system' : (layoutAnswer as LayoutKind);
    kindSource = 'answered';
  } else if (draft.layout !== undefined) {
    kind = draft.layout;
    kindSource = 'draft';
  } else if (pathsGiven) {
    kind = 'system'; // the draft's own paths stand; inferLayout names their kind below
    kindSource = 'paths';
  } else if (existing !== null) {
    kind = inferLayout(existing);
    kindSource = 'existing';
  } else {
    // The automatic fallback (decision B): a home that cannot be given to root proposes system.
    kind = homeReasons.length > 0 ? 'system' : 'home';
    kindSource = 'proposed';
  }
  const relocated = (name: '.bun' | 'host_agent'): boolean => {
    if (kind !== 'home' || answers.get('declaration.layout_dirs') !== 'relocate') return false;
    const row = declared?.home.layoutDirs[name] ?? null;
    return declared === null || (row !== null && row.uid !== 0);
  };
  let paths: { state_root: string; agent_dir: string; bun_bin: string };
  if (kind === 'home' && home !== null) {
    const base = layoutPaths('home', instance, home);
    paths = {
      state_root: answers.get('declaration.state_root') === 'relocate' ? join(home, HOME_RELOCATED_NAMES.stateRoot) : base.state_root,
      agent_dir: relocated('host_agent') ? join(home, HOME_RELOCATED_NAMES.agentDir) : base.agent_dir,
      bun_bin: relocated('.bun') ? join(home, HOME_RELOCATED_NAMES.bunDir, 'bin', 'bun') : base.bun_bin,
    };
  } else {
    paths = { ...layoutPaths('system', instance, null) };
  }
  const layoutSource = `the ${kind} layout`;
  const ownPaths = kindSource === 'answered' ? undefined : draft;
  const stateRoot = fill('state_root', ownPaths?.state_root, paths.state_root, layoutSource) as string;
  const agentDir = fill('agent_dir', ownPaths?.agent_dir, paths.agent_dir, layoutSource) as string;
  const bunBin = fill('bun_bin', ownPaths?.bun_bin, paths.bun_bin, layoutSource) as string;

  /* accounts and listen */
  const listen = fill('listen', draft.listen, DEFAULTS.listen, 'default: the unix socket (one machine)') as DeclaredListen;
  const named = (field: string, given: string | undefined, proposal: string): string | undefined => {
    if (given !== undefined) return given;
    if (!UNIX_NAME_PATTERN.test(proposal)) {
      unfilled.push({ field, reason: `the proposed name '${proposal}' does not match ${UNIX_NAME_PATTERN.source}; name it in the draft` });
      return undefined;
    }
    sources.set(field, 'proposed: a new account for this instance (D2)');
    return proposal;
  };
  const agentUser = named('agent_user', draft.agent_user, DEFAULTS.agentUser(instance));
  const v2User = named('v2.user', draft.v2?.user, DEFAULTS.v2User(instance));
  const v2Group = draft.v2?.group ?? v2User;
  if (draft.v2?.group === undefined && v2Group !== undefined) sources.set('v2.group', "proposed: the v2 user's own group");

  let v1User = draft.v1?.user;
  const v1Proposal = DEFAULTS.v1User(instance);
  const v1Bad = servesV1 && v1User !== undefined && (FORBIDDEN_V1_USERS.includes(v1User) || v1User === facts.web.runUser);
  if (servesV1 && (v1User === undefined || v1Bad)) {
    const proposalOk = UNIX_NAME_PATTERN.test(v1Proposal);
    if (v1Bad) {
      decisions.push({
        id: 'declaration.v1_user',
        area: 'declaration',
        title: 'the account v1 runs as',
        facts: [
          `v1.user '${v1User}' is a web or catch-all account: v1 runs in its own pool under its own account (decision A)`,
          ...(proposalOk ? [`proposed: a new account '${v1Proposal}' that runs only the v1 pool`] : []),
        ],
        commands: [],
        options: proposalOk ? [{ id: 'act', label: `use '${v1Proposal}'`, resolves: 'replace' }, MANUAL] : [MANUAL],
        defaultOption: proposalOk ? 'act' : 'manual',
        blocking: true,
      });
      if (proposalOk && answers.get('declaration.v1_user') === 'act') {
        v1User = v1Proposal;
        sources.set('v1.user', "answered (declaration.v1_user): the instance's own v1 account");
      }
    } else if (proposalOk) {
      v1User = v1Proposal;
      sources.set('v1.user', 'proposed: a new account that runs only the v1 pool (decision A)');
    } else {
      unfilled.push({ field: 'v1.user', reason: `the proposed name '${v1Proposal}' does not match ${UNIX_NAME_PATTERN.source}; name it in the draft` });
      decisions.push({
        id: 'declaration.v1_user',
        area: 'declaration',
        title: 'the account v1 runs as',
        facts: [`'${v1Proposal}' is too long for an account name: name v1.user in the draft`],
        commands: [],
        options: [MANUAL],
        defaultOption: 'manual',
        blocking: true,
      });
    }
  }

  /* engine group and the work unit (one machine) */
  let workUnit: WorkUnit | null = null;
  let engineGroup = draft.engine_group;
  if (listen.kind === 'unix') {
    const units = facts.work;
    if (units.length === 1) workUnit = units[0] as WorkUnit;
    else if (units.length > 1) {
      const proposed = units[0] as WorkUnit;
      workUnit = units.find(unit => answers.get('declaration.work_unit') === unitOptionId(unit.unit)) ?? proposed;
      decisions.push({
        id: 'declaration.work_unit',
        area: 'declaration',
        title: 'the Dédalo work engine this instance pairs with',
        facts: units.map(unit => `${unit.unit}: user ${unit.user}, group ${unit.group}, ${unit.checkout}`),
        commands: [],
        options: units.map(unit => ({ id: unitOptionId(unit.unit), label: unit.unit, resolves: 'act' as const })),
        defaultOption: unitOptionId(proposed.unit),
        blocking: false,
      });
    }
    if (engineGroup === undefined) {
      if (workUnit !== null && UNIX_NAME_PATTERN.test(workUnit.group)) {
        engineGroup = workUnit.group;
        sources.set('engine_group', `the group of ${workUnit.unit}`);
      } else {
        unfilled.push({ field: 'engine_group', reason: 'no Dédalo work unit runs here; name the group of the account that runs Dédalo' });
        if (units.length === 0) {
          decisions.push({
            id: 'declaration.work_unit',
            area: 'declaration',
            title: 'the group of the account that runs Dédalo (engine_group)',
            facts: ['no dedalo-ts unit was found; a unix listener needs the engine group (the socket is 0660 with it)'],
            commands: ['id -gn <the account that runs Dédalo>'],
            options: [MANUAL],
            defaultOption: 'manual',
            blocking: true,
          });
        }
      }
    }
  }

  /* v2 */
  const givenPort = draft.v2?.port;
  const basePort = givenPort ?? existing?.v2.port ?? DEFAULTS.v2Port;
  const ours = existing !== null && existing.v2.port === basePort;
  const siblingPorts = new Set((declared?.siblings ?? []).map(sibling => sibling.layout.v2.port));
  const busy = facts.ports.includes(basePort) && !ours;
  const typed = portTypedOtherwise(facts, basePort);
  let v2Port = basePort;
  if (givenPort === undefined) sources.set('v2.port', existing !== null && existing.v2.port === basePort ? 'the existing declaration' : 'default');
  if (busy || typed !== null || siblingPorts.has(basePort)) {
    const proposal = nextFreePort(facts, basePort, siblingPorts);
    const answer = answers.get('declaration.v2_port')?.match(/^port-(\d{1,5})$/)?.[1];
    const answered = answer === undefined ? null : Number(answer);
    decisions.push({
      id: 'declaration.v2_port',
      area: 'declaration',
      title: "the loopback port v2 listens on",
      facts: [
        busy ? `port ${basePort} is in use` : siblingPorts.has(basePort) ? `port ${basePort} is a sibling instance's v2 port` : `port ${basePort} is typed ${typed} by the SELinux policy`,
        ...(proposal === null ? ['no free, untyped port found above it'] : [`proposed: ${proposal} (free and untyped)`]),
      ],
      commands: [],
      options: proposal === null ? [MANUAL] : [{ id: `port-${proposal}`, label: `use ${proposal}`, resolves: 'act' }, MANUAL],
      defaultOption: proposal === null ? 'manual' : `port-${proposal}`,
      blocking: proposal === null,
    });
    if (answered !== null && answered >= 1 && answered <= 65535) {
      v2Port = answered;
      sources.set('v2.port', 'answered (declaration.v2_port)');
    } else if (proposal !== null && givenPort === undefined) {
      v2Port = proposal;
      sources.set('v2.port', 'proposed (declaration.v2_port is open)');
    }
  }
  const v2 = {
    unit: fill('v2.unit', draft.v2?.unit, DEFAULTS.v2Unit(instance), "proposed: this instance's v2 unit") as string,
    user: v2User,
    group: v2Group,
    port: v2Port,
    health_url: (draft.v2?.health_url !== undefined && v2Port === basePort
      ? draft.v2.health_url
      : fill('v2.health_url', undefined, `http://127.0.0.1:${v2Port}/health`, 'from v2.port')) as string,
  };
  if (!UNIT_NAME_PATTERN.test(v2.unit)) unfilled.push({ field: 'v2.unit', reason: `'${v2.unit}' is not a unit name; name it in the draft` });

  /* web extras, php, systemd */
  const nginxMap: NginxMapMode | undefined =
    server !== 'nginx'
      ? draft.web?.nginx_map
      : fill('web.nginx_map', draft.web?.nginx_map, facts.web.confDInHttp === true ? 'conf_d' : 'none', facts.web.confDInHttp === true ? 'nginx -T: conf.d is included inside http{}' : 'nginx -T: conf.d is not included inside http{}');
  const dirs = server === 'nginx' && vhost !== null ? logDirs([vhost, ...vhostTwins]) : [];
  const logDirsValue = fill('web.log_dirs', draft.web?.log_dirs, dirs.length > 0 ? dirs : undefined, `the log paths of ${vhost?.realpath ?? 'the vhost'}`);
  const phpBin = !servesV1
    ? draft.php_bin
    : (fill(
        'php_bin',
        draft.php_bin,
        siteFpm !== undefined && server !== undefined
          ? fpmLayout(instance, siteFpm.flavor, siteFpm.version, server).cli
          : (fpmCandidates(facts).find(install => install.cli !== null)?.cli ?? DEFAULTS.phpBin),
        siteFpm !== undefined ? "the site's PHP-FPM install (S5)" : 'the installed PHP CLI',
      ) as string);
  // The family a v2-only site's logs follow (layout.ts OsFamily): no FPM flavour to derive it from.
  const osFamily: OsFamily | undefined =
    site === undefined || servesV1
      ? site?.os_family
      : fill('site.os_family', site.os_family, webFlavor, `the host's ${webFlavor} family (host.os)`);

  /* assemble */
  const layoutDecision = (finalKind: LayoutKind | null): void => {
    if (home === null) return;
    const decision = layoutDecisionFor({ home, instance, reasons: homeReasons, kind: finalKind, kindSource });
    if (decision !== null) decisions.push(decision);
  };
  if (unfilled.length > 0 || server === undefined || webUnit === undefined || agentUser === undefined || (servesV1 && v1User === undefined) || v2User === undefined || v2Group === undefined) {
    layoutDecision(kindSource === 'paths' ? null : kind);
    return freeze({ declaration: null, layout: null, layoutError: null, kind: null, kindSource, sources, decisions, unfilled, homeReasons, vhost, vhostTwins, fpm, workUnit, existing, siteDomain: site?.domain ?? null, answers, servesV1 });
  }
  const web: HostDeclaration['web'] = {
    server,
    unit: webUnit,
    ...(nginxMap === undefined ? {} : { nginx_map: nginxMap }),
    ...(logDirsValue === undefined ? {} : { log_dirs: logDirsValue }),
  };
  const declaration: HostDeclaration = {
    instance,
    listen,
    agent_user: agentUser,
    ...(engineGroup === undefined ? {} : { engine_group: engineGroup }),
    agent_dir: agentDir,
    web,
    ...(site === undefined || (servesV1 && siteFpm === undefined)
      ? {}
      : {
          site: {
            domain: site.domain,
            ...(site.home === undefined ? {} : { home: site.home }),
            ...(osFamily === undefined ? {} : { os_family: osFamily }),
            ...(site.api_paths === undefined ? {} : { api_paths: site.api_paths }),
            // v2-only: a draft's site.fpm is kept so derive() refuses it by name (never dropped).
            ...(siteFpm !== undefined ? { fpm: siteFpm } : site.fpm !== undefined ? { fpm: site.fpm } : {}),
          },
        }),
    ...(servesV1 && v1User !== undefined ? { v1: { user: v1User } } : {}),
    state_root: stateRoot,
    media: mediaWithConsent(draft.media, existing, answers),
    ...(phpBin === undefined ? {} : { php_bin: phpBin }),
    bun_bin: bunBin,
    v2: { ...v2, user: v2User, group: v2Group },
    ...(draft.releases_retained === undefined ? {} : { releases_retained: draft.releases_retained }),
    ...(draft.paths === undefined ? {} : { paths: draft.paths }),
  };
  let layout: AgentLayout | null = null;
  let layoutError: string | null = null;
  try {
    // The configtest binary as `provision apply` derives it (cli.ts passes isRealFile): the one
    // discovery found. Without it EL's /usr/sbin/apachectl would derive as Debian's apache2ctl.
    const configtestBin = facts.web.configtestBin;
    layout = derive(declaration, {
      anyHomeBound: declared?.hostShared.anyHomeBound ?? false,
      // fapolicyd's presence, as cli.ts derives it (the CLI is a real file): the trust unit and its grant.
      fapolicyd: facts.fapolicyd.installed,
      ...(configtestBin === null ? {} : { isRealFile: (path: string) => path === configtestBin }),
    });
  } catch (error) {
    if (!(error instanceof LayoutError)) throw error;
    layoutError = `${error.field}: ${error.message}`;
  }
  const finalKind = kindSource === 'paths' ? inferLayout(declaration) : kind;
  layoutDecision(finalKind);
  return freeze({
    declaration,
    layout,
    layoutError,
    kind: finalKind,
    kindSource,
    sources,
    decisions,
    unfilled,
    homeReasons,
    vhost,
    vhostTwins,
    fpm,
    workUnit,
    existing,
    siteDomain: site?.domain ?? null,
    answers,
    servesV1,
  });
}

/**
 * THE `declaration.layout` decision (S6, decision B) — draft and compare both ask here, so the
 * item a recompute shows is the one the answer was given to. With reasons the home cannot be
 * given to root, only `system` (default) and `manual`, blocking; without, `home` (default) /
 * `system` while the layout is still a proposal. Settled (named by the draft, fixed by the paths
 * or the existing declaration) and reason-free: no decision.
 */
export function layoutDecisionFor(input: {
  readonly home: string;
  readonly instance: string;
  readonly reasons: readonly string[];
  readonly kind: LayoutKind | null;
  readonly kindSource: DraftCompletion['kindSource'];
}): DraftDecision | null {
  const { home, instance, reasons, kind, kindSource } = input;
  const open = kindSource === 'proposed' || kindSource === 'answered';
  if (reasons.length > 0 && (kind === 'home' || open)) {
    return {
      id: 'declaration.layout',
      area: 'declaration',
      title: `where this instance lives (${home} cannot be given to root)`,
      facts: [...reasons, `system layout: ${systemPathsFact(instance)}`],
      commands: [],
      options: [{ id: 'system', label: 'the system layout (/srv + /opt)', resolves: 'act' }, MANUAL],
      defaultOption: 'system',
      blocking: true,
    };
  }
  if (reasons.length === 0 && open) {
    return {
      id: 'declaration.layout',
      area: 'declaration',
      title: 'where this instance lives (decision B)',
      facts: [`home layout: ${homePathsFact(home)}; then ${home} is made root:root (home.root)`, `system layout: ${systemPathsFact(instance)}`],
      commands: [],
      options: [
        { id: 'home', label: `the per-site home ${home}`, resolves: 'act' },
        { id: 'system', label: 'the system layout (/srv + /opt)', resolves: 'act' },
      ],
      defaultOption: 'home',
      blocking: false,
    };
  }
  return null;
}

function homePathsFact(home: string): string {
  const paths = layoutPaths('home', 'x', home);
  return `state_root ${paths.state_root}, agent_dir ${paths.agent_dir}, bun_bin ${paths.bun_bin}`;
}

function systemPathsFact(instance: string): string {
  const paths = layoutPaths('system', instance, null);
  return `state_root ${paths.state_root}, agent_dir ${paths.agent_dir}, bun_bin ${paths.bun_bin}`;
}

function freeze(completion: DraftCompletion): DraftCompletion {
  return Object.freeze(completion);
}
