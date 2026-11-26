/**
 * THE LAYOUT — every path, owner and mode of ONE publication-host agent instance, DERIVED
 * from its declaration (`/etc/dedalo_publication_host/<instance>.json`). Nothing on the
 * host is spelled anywhere else: renderers, plan, apply and the CLI read it from here.
 *
 * Shape copied from publication/site_builder/src/provision/layout.ts (INSTANCE_PATTERN, the
 * MODES matrix, derive()), reduced to one agent and no fleet (D10). Nothing is imported
 * from there: separate deployables.
 *
 * The state-root marker, the state tree's role names and WHO OWNS EACH PART of it are
 * src/instance/roots.ts's (the agent's boot preflight reads the same exports): imported
 * here, never restated. The configtest binaries are defined HERE, once (a closed list per
 * server); src/exec.ts re-exports it, so the agent's sudo argv, the plan's trust check and the
 * sudoers rule all name one path from that list — the one derive() picked for this host.
 *
 * ZERO-DEPENDENCY (Global Constraints): root-repo tests import this module. node: builtins
 * and ../instance/roots only (itself builtins + one type-only import);
 * tests/provision_zero_dep.test.ts holds both. Written to compile under the engine's
 * `noUncheckedIndexedAccess`.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { join, normalize } from 'node:path';
import {
  AUDIT_DIR,
  AUDIT_FILE_NAME,
  INSTANCE_MARKER,
  PUBLICATION_API_DIR,
  RULES_DIR,
  STATE_TREE_OWNERSHIP,
  markerContent,
} from '../instance/roots';

export { INSTANCE_MARKER, markerContent };

/* ── grammars ─────────────────────────────────────────────────────────────────────── */

/** Same grammar as AgentConfig.INSTANCE (src/config.ts). Pinned equal by tests/provision_layout.test.ts. */
export const INSTANCE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
export const UNIX_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
/** A systemd unit name WITHOUT the `.service` suffix. Same grammar as AgentConfig's UNIT_PATTERN
 *  (WEB_UNIT/V2_UNIT, src/config.ts), pinned equal by tests/provision_layout.test.ts: a unit
 *  derive() accepts is always one the agent's config resolves. */
export const UNIT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$/;
/** Absolute, conservative character set: every path lands unquoted in a unit or sudoers line. */
export const ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]*$/;
/** The IPv4 half of the listen-host grammar: a canonical, non-zero dotted quad (no DNS name, no
 *  leading zeros) — it becomes the server certificate's SAN and the agent's TLS_HOST, which
 *  refuses anything else (spec §2.2). The whole grammar (IPv4 OR a private IPv6) is
 *  listenHostProblem(); this pattern stays exported for the IPv4 examples the docs carry. */
export const LISTEN_HOST_PATTERN =
  /^(?!0\.0\.0\.0$)(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/* ── the listen host: IPv4 or a private IPv6 (spec §2.2) ──────────────────────────── */

/**
 * The RFC 5952 canonical text of an IPv6 literal (lower case, no leading zeros, the FIRST
 * longest run of two or more zero hextets compressed to `::`), or null when `text` is not a
 * bare IPv6 literal. A zone id (`fe80::1%eth0`) or brackets are NOT a bare literal: neither a
 * certificate SAN nor an https URL authority can carry a zone, so it has no canonical form here.
 *
 * WHATWG URL's IPv6 serializer IS RFC 5952 §4 (minus §5's dotted tail for IPv4-mapped forms,
 * which the listen grammar refuses anyway): one standard algorithm, the same in Bun, Node and
 * every browser, instead of a second hand-written compressor. `node:net` isIPv6 gates the input
 * first, so the URL parser only ever sees a literal.
 */
export function canonicalIpv6(text: string): string | null {
  if (!isIPv6(text) || text.includes('%')) return null;
  try {
    const host = new URL(`http://[${text}]/`).hostname;
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : null;
  } catch {
    return null;
  }
}

/** The 16 bytes of a CANONICAL IPv6 literal (canonicalIpv6's output: hex hextets, at most one `::`). */
function ipv6Bytes(canonical: string): number[] {
  const [head = '', tail] = canonical.split('::');
  const hextets = (part: string): number[] => (part === '' ? [] : part.split(':').map(h => Number.parseInt(h, 16)));
  const left = hextets(head);
  const right = tail === undefined ? [] : hextets(tail);
  const all = tail === undefined ? left : [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  return all.flatMap(h => [h >> 8, h & 0xff]);
}

/**
 * Why an IPv6 listen host cannot be the channel's, or null. The channel binds ONE PRIVATE
 * interface (spec §2.2), so the IPv6 universe is closed to:
 *   - a unique local address, fc00::/7 (RFC 4193; in practice fd00::/8): the private network
 *     a WireGuard peer or a LAN segment gives two machines;
 *   - the loopback ::1, the IPv6 twin of the 127.0.0.0/8 the IPv4 grammar admits (one host).
 * Refused, each by name:
 *   - link-local fe80::/10: binding it needs a zone id (fe80::1%eth0) the certificate SAN, the
 *     engine's https URL and the registry cannot carry, and the address is ambiguous without
 *     one — use a ULA on the private link instead;
 *   - the unspecified ::, and multicast ff00::/8: never one interface;
 *   - an IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96) form: write the IPv4 itself;
 *   - every other address (global unicast, documentation, 6to4, Teredo, the retired site-local
 *     fec0::/10): not a private interface.
 * `canonical` is canonicalIpv6()'s output.
 */
function ipv6ListenProblem(canonical: string): string | null {
  const bytes = ipv6Bytes(canonical);
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (canonical === '::1') return null;
  if ((first & 0xfe) === 0xfc) return null;
  if (canonical === '::') return 'is the unspecified address (every interface), never one private interface';
  if (first === 0xfe && (second & 0xc0) === 0x80) {
    return (
      'is a link-local address: binding it needs a zone id (fe80::1%eth0) that neither the certificate ' +
      "SAN nor the engine's https URL can carry. Use a unique local address (fd00::/8) on the private network"
    );
  }
  if (first === 0xff) return 'is a multicast address, never one interface';
  const top80Zero = bytes.slice(0, 10).every(b => b === 0);
  if (top80Zero && bytes[10] === 0xff && bytes[11] === 0xff) return 'is an IPv4-mapped IPv6 address: write the IPv4 address itself';
  if (top80Zero && bytes[10] === 0 && bytes[11] === 0) return 'is an IPv4-compatible IPv6 address: write the IPv4 address itself';
  return (
    'is not a private IPv6 address: the channel binds one private interface (spec §2.2) — a unique local ' +
    'address (fc00::/7, e.g. fd00::/8) or ::1'
  );
}

/**
 * THE LISTEN-HOST GRAMMAR (spec §2.2): why `value` is not a TLS listen host, or null. A host is
 * EITHER a canonical non-zero IPv4 dotted quad (LISTEN_HOST_PATTERN) OR a private IPv6 literal
 * (ipv6ListenProblem) written in its RFC 5952 canonical form — a non-canonical spelling is
 * refused WITH the canonical one (only once the address itself is admissible: a refused
 * family is named first), because the declared text is compared verbatim downstream
 * (the sibling check, the engine's draft ↔ registry ↔ pairing-fragment binding) and must have
 * exactly one spelling. Never a DNS name, a wildcard, brackets or a zone id.
 */
export function listenHostProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return 'must be an IP address literal';
  if (LISTEN_HOST_PATTERN.test(value)) return null;
  if (isIPv4(value) || /^[0-9.]+$/.test(value)) {
    return 'must be a canonical non-zero IPv4 dotted quad (no leading zeros, not 0.0.0.0)';
  }
  if (value.startsWith('[') || value.includes('%')) {
    return 'must be a bare IPv6 literal: no brackets, no zone id (fe80::1%eth0 cannot be bound by the channel)';
  }
  const canonical = canonicalIpv6(value);
  if (canonical === null) {
    return 'must be an IP address literal (a private IPv4 or a unique local IPv6), never a hostname or wildcard';
  }
  // The FAMILY refusal wins over the SPELLING one: an address that can never be a listen
  // host (IPv4-mapped `::ffff:10.0.0.2`, link-local, global…) must be refused for what it
  // IS, not told to rewrite itself into a canonical form the next run refuses anyway.
  const familyProblem = ipv6ListenProblem(canonical);
  if (familyProblem !== null) return familyProblem;
  if (canonical !== value) return `must be written in its canonical form (RFC 5952): '${canonical}'`;
  return null;
}

/**
 * The ONE spelling of a host for a COMPARISON: an IPv6 literal (bracketed or bare) → its RFC 5952
 * canonical text; anything else (an IPv4, a DNS name) unchanged. Every place two listen hosts
 * are compared goes through this — the sibling check here, the engine's same-machine, paired-
 * record, pairing-binding and registry-slot checks — so `FD00:0::1` and `fd00::1` are one machine
 * even where a hand-written file did not use the canonical form.
 */
export function comparableHost(host: string): string {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return canonicalIpv6(bare) ?? host;
}

/** Are two listen hosts the same address (comparableHost on both sides)? */
export function sameListenHost(a: string, b: string): boolean {
  return comparableHost(a) === comparableHost(b);
}

/** A loopback listen host (127.0.0.0/8 or ::1): it shares the loopback the v2 API binds. */
export function isLoopbackListenHost(host: string): boolean {
  return host.startsWith('127.') || comparableHost(host) === '::1';
}
export const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
/** An env key that names a credential. The env file may never carry one (render/env.ts). */
export const SECRET_LOOKING_KEY = /(TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|_KEY)$/;

/* ── constants ────────────────────────────────────────────────────────────────────── */

/** The systemd credential id the agent reads at $CREDENTIALS_DIRECTORY/SERVICE_TOKEN. */
export const SERVICE_TOKEN_CREDENTIAL = 'SERVICE_TOKEN';
/** 32 random bytes → 43 base64url chars (AgentConfig demands ≥ 32). */
export const SERVICE_TOKEN_BYTES = 32;

export const RELEASES_RETAINED_DEFAULT = 3;
export const RELEASES_RETAINED_MIN = 2;
export const RELEASES_RETAINED_MAX = 20;

export type WebServer = 'apache' | 'nginx';
export type MediaMode = 'shared' | 'copy' | 'none';
export type ProvisionApi = 'v1' | 'v2';

/**
 * THE configtest binaries per server — the one definition, a CLOSED list in preference
 * order. The agent runs `sudo -n <bin> -t` (src/exec.ts re-exports it), the plan requires
 * it root-owned with a root-owned, non-writable ancestry, and the sudoers rule (render/)
 * grants exactly it. One path cannot serve every distribution: Debian/Ubuntu ship the real
 * `apache2ctl` (it sources /etc/apache2/envvars; `apachectl` is only a symlink to it), RHEL
 * and upstream ship a real `apachectl`. derive() picks the first candidate that is a real
 * file on the host (pickConfigtestBinary) and renders it into BOTH the sudoers rule and the
 * agent env (WEB_CONFIGTEST_BIN), so the two can never disagree. It is never declared: a
 * free path would widen what root runs; the list is the whole universe.
 */
export const WEB_CONFIGTEST_CANDIDATES: Readonly<Record<WebServer, readonly string[]>> = Object.freeze({
  apache: Object.freeze(['/usr/sbin/apache2ctl', '/usr/sbin/apachectl']),
  nginx: Object.freeze(['/usr/sbin/nginx']),
});

export function isConfigtestBinary(server: WebServer, bin: string): boolean {
  return WEB_CONFIGTEST_CANDIDATES[server].includes(bin);
}

/**
 * The first candidate `isRealFile` accepts (an lstat regular file, never a symlink), else the
 * first candidate: the plan then refuses it by name, listing every candidate. Without a probe
 * (render, examples, tests) the first candidate stands.
 */
export function pickConfigtestBinary(server: WebServer, isRealFile?: (path: string) => boolean): string {
  const candidates = WEB_CONFIGTEST_CANDIDATES[server];
  const found = isRealFile ? candidates.find(path => isRealFile(path)) : undefined;
  const picked = found ?? candidates[0];
  if (picked === undefined) throw new Error(`layout: no configtest candidate for '${server}'`);
  return picked;
}

/**
 * The binaries `-S`/`-M`/`-t -D DUMP_INCLUDES`/`-v` run against (spec §2.2): Debian's real
 * `apache2ctl`, and on EL `httpd` itself — EL's `apachectl` is a reduced script that is fine for
 * `-t` but not relied on for the dumps.
 */
export const APACHE_DUMP_CANDIDATES: readonly string[] = Object.freeze(['/usr/sbin/apache2ctl', '/usr/sbin/httpd']);

/** A PHP-FPM master: Debian `php-fpm<v>`, EL AppStream `php-fpm`, Remi SCL `php<NN>` (spec S5). */
export const FPM_BIN_PATTERN = /^(\/usr\/sbin\/php-fpm(\d+\.\d+)?|\/opt\/remi\/php\d{2}\/root\/usr\/sbin\/php-fpm)$/;
/** A PHP CLI, after realpath: Debian `php<v>`, EL `php`, Remi `php<NN>`'s (spec S5). */
export const PHP_CLI_PATTERN = /^(\/usr\/bin\/php(\d+\.\d+)?|\/opt\/remi\/php\d{2}\/root\/usr\/bin\/php)$/;

/**
 * HOST-WIDE STATE (spec S11): what several instances on one host share. An instance name cannot
 * start with '_' (INSTANCE_PATTERN), so `_host` never collides with an instance's own directory
 * under V1_VAR_BASE. The `paths.host_base` override repoints the whole tree (scratch gates only).
 */
export const V1_VAR_BASE = '/var/lib/dedalo_publication_host';
export const HOST_BASE = '/var/lib/dedalo_publication_host/_host';
export const HOST_LOCKS_DIR = `${HOST_BASE}/locks`;
export const HOST_NGINX_MAP_DIR = `${HOST_BASE}/nginx_map`;
export const HOST_NGINX_CONTRIB_DIR = `${HOST_NGINX_MAP_DIR}/contrib`;
export const HOST_MAP_RENDERER_DIR = `${HOST_BASE}/map_renderer`;
/** The root oneshot that renders the host-wide nginx map (spec §13.5), a bare unit name. */
export const HOST_MAP_UNIT = 'dedalo-pubhost-map';
/**
 * FAPOLICYD (owner decision 2026-10-09, spec §9.11). On a host where fapolicyd is INSTALLED (its
 * CLI is a real file: derive()'s DeriveHost.fapolicyd, the one host probe) each instance gets ONE
 * trust file, `<FAPOLICYD_TRUST_DIR>/dedalo_<instance>`, root-written by the trust program
 * (fapolicyd_trust.ts: derived from the declaration, never from an argument), and the root oneshot
 * `dedalo-pubhost-trust-<instance>.service` that rewrites it (render/trust_unit.ts) — the one unit
 * the agent may `start` after a release install or rollback (render/polkit.ts). Its result record
 * is `<config_base>/<instance>/fapolicyd_trust.json` (root 0644: the agent reads it for status).
 */
export const FAPOLICYD_CLI = '/usr/sbin/fapolicyd-cli';
export const FAPOLICYD_CONF = '/etc/fapolicyd/fapolicyd.conf';
export const FAPOLICYD_TRUST_DIR = '/etc/fapolicyd/trust.d';
export const FAPOLICYD_UNIT = 'fapolicyd.service';
export const TRUST_UNIT_PREFIX = 'dedalo-pubhost-trust-';
export const TRUST_RESULT_NAME = 'fapolicyd_trust.json';
/** The trust file's name in FAPOLICYD_TRUST_DIR (never `dedalo`: the name of the old hand-run lines' file). */
export function trustFileName(instance: string): string {
  return `dedalo_${instance}`;
}
/** The group every agent unit gets through SupplementaryGroups= (spec S11). Created only by init (D2). */
export const PUBHOST_GROUP = 'dedalo_pubhost';
export const DEFAULT_NGINX_CONF_D = '/etc/nginx/conf.d';
export const NGINX_MAP_INCLUDE_NAME = 'dedalo_media_map.conf';
export const NGINX_MAP_INCLUDE_PATH = `${DEFAULT_NGINX_CONF_D}/${NGINX_MAP_INCLUDE_NAME}`;
/** The lock files in HOST_LOCKS_DIR (spec S12, §7): root-created, flocked, never removed. */
export const HOST_LOCK_FILES = Object.freeze({ provision: 'provision.lock', web: 'web.lock' } as const);
export type HostLockName = keyof typeof HOST_LOCK_FILES;

/**
 * The per-site home made root-owned by init (decision B). 0755 as decided; owner question 1 asks
 * for 0711 (search without listing). One constant: changing it changes init and the guide together.
 */
export const HOME_ROOT_MODE = 0o755;
/** The Linux kernel floor Bun documents for the pinned version (spec S8); moves with `.bun-version`. */
export const BUN_KERNEL_FLOOR = '5.1';
/** The lowest PHP the v1 API runs on — provisional, measured by the EL drill (spec S5). */
export const V1_PHP_FLOOR = '8.1';
/** The lowest nginx the rendered include and map parse on — provisional, measured by the drills. */
export const NGINX_FLOOR = '1.14';
/**
 * The oldest systemd the rendered units run on (spec S10): LoadCredential= and ProtectProc= are
 * 247. ONE profile — every supported OS ships more (Debian 12 and EL 9: 252, Ubuntu 24.04: 255,
 * Debian 13 and EL 10: 257, Ubuntu 26.04: 259); below it `host.systemd` blocks init and plan
 * refuses.
 */
export const SYSTEMD_FLOOR = 247;

/** A site's domain (spec S6). Lower case: it names a home directory and a pool. */
export const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** A declared PHP version, `<major>.<minor>` (spec S6). */
export const FPM_VERSION_PATTERN = /^\d+\.\d+$/;
/** A URL path the web include serves an API under (spec S6). No `..`, no trailing '/' (checked apart). */
export const API_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;
export const DEFAULT_API_PATHS = Object.freeze({
  v1: '/dedalo/publication/server_api/v1',
  v2: '/dedalo/publication/server_api/v2',
});
/** A site home may never be one of these: they hold other sites (spec S6). */
export const FORBIDDEN_HOMES: readonly string[] = Object.freeze(['/', '/home', '/var/www', '/var/www/html', '/srv']);
/** v1 runs as its own account, never a web or catch-all one (spec S5, decision A). */
export const FORBIDDEN_V1_USERS: readonly string[] = Object.freeze(['www-data', 'apache', 'nginx', 'www', 'nobody']);

export type FpmFlavor = 'debian' | 'el' | 'remi';
export const FPM_FLAVORS: readonly FpmFlavor[] = Object.freeze(['debian', 'el', 'remi']);
/** Where each flavour keeps its pools (`<v>` = the version, `<NN>` = it without its dot). */
export const FPM_POOL_DIRS: Readonly<Record<FpmFlavor, string>> = Object.freeze({
  debian: '/etc/php/<v>/fpm/pool.d',
  el: '/etc/php-fpm.d',
  remi: '/etc/opt/remi/php<NN>/php-fpm.d',
});

export type LayoutKind = 'home' | 'system';
/** The directory names of the per-site home layout (decision B), and their relocations (S6). */
export const HOME_LAYOUT_NAMES = Object.freeze({ stateRoot: 'dedalo', agentDir: 'host_agent', bunDir: '.bun' });

/**
 * THE SITE'S WEB SERVER LOGS (owner decision 1(c), 2026-10-09): OUTSIDE the home, in the
 * distribution's own log directory, one subdirectory per site — `/var/log/apache2/<domain>`
 * (Debian, Ubuntu), `/var/log/httpd/<domain>` (EL), `/var/log/nginx/<domain>` (every family).
 * Ubuntu 26.04's apache2.service is sandboxed (ProtectHome=read-only, ProtectSystem=full,
 * ReadWritePaths=/var/log/apache2): a log under /home passes `apache2ctl -t` but the unit cannot
 * start. The distribution's directory is writable by every web server unit, labelled httpd_log_t by
 * the policy's own `/var/log/(httpd|nginx)(/.*)?` rule on EL (no rule of ours), and root's.
 * `paths.web_log_base` repoints the base (scratch gates only).
 */
export function webLogBase(server: WebServer, family: OsFamily): string {
  if (server === 'nginx') return '/var/log/nginx';
  return family === 'debian' ? '/var/log/apache2' : '/var/log/httpd';
}

/**
 * THE SITE'S DISTRIBUTION FAMILY (spec S6): what the site's web logs and their rotation depend on
 * (webLogBase, render/logrotate.ts's log group). A v1 site gets it from its FPM flavour (Remi is
 * an EL repository); a v2-only site — no PHP anywhere — declares it (`site.os_family`). Declared
 * beside an FPM flavour, the two must agree.
 */
export type OsFamily = 'debian' | 'el';
export const OS_FAMILIES: readonly OsFamily[] = Object.freeze(['debian', 'el']);
export function familyOfFlavor(flavor: FpmFlavor): OsFamily {
  return flavor === 'debian' ? 'debian' : 'el';
}
export const HOME_RELOCATED_NAMES = Object.freeze({
  stateRoot: 'dedalo_publication',
  agentDir: 'dedalo_host_agent',
  bunDir: '.dedalo_bun',
});
export const SYSTEM_LAYOUT = Object.freeze({
  stateBase: '/srv/dedalo_publication_host',
  agentDir: '/opt/dedalo_publication_host/host_agent',
  bunBin: '/opt/dedalo_publication_host/bun/bin/bun',
});

export const DEFAULT_PATHS = Object.freeze({
  configBase: '/etc/dedalo_publication_host',
  unitDir: '/etc/systemd/system',
  sudoersDir: '/etc/sudoers.d',
  polkitRulesDir: '/etc/polkit-1/rules.d',
  /** The per-site web log rotation (render/logrotate.ts): the distribution's own files glob /var/log/<server>/*.log only. */
  logrotateDir: '/etc/logrotate.d',
  runtimeBase: '/run/dedalo_publication_host',
  hostBase: HOST_BASE,
  nginxConfD: DEFAULT_NGINX_CONF_D,
  v1VarBase: V1_VAR_BASE,
});

export const AGENT_UNIT_PREFIX = 'dedalo-publication-host-';
/**
 * The v2 scratch boot's TEMPLATE unit is `<v2.unit>-scratch@.service`; an
 * instance is `<v2.unit>-scratch@<port>.service` (render/unit_v2.ts, the polkit start/stop grant).
 */
export const V2_SCRATCH_TEMPLATE_SUFFIX = '-scratch@';

/* ── the declaration (validated structurally by schema.ts, semantically by derive) ── */

export type DeclaredListen =
  | { readonly kind: 'unix' }
  | { readonly kind: 'tls'; readonly host: string; readonly port: number };

export interface HostDeclaration {
  readonly instance: string;
  readonly listen: DeclaredListen;
  readonly agent_user: string;
  /** Required for a unix listener (socket group, spec §1.1); refused for tls. */
  readonly engine_group?: string;
  /** The checkout of publication/host_agent on this host (the unit's WorkingDirectory). */
  readonly agent_dir: string;
  readonly web: {
    readonly server: WebServer;
    readonly unit: string;
    /**
     * nginx only: who defines the host-wide http{} media map (spec §13.6). `conf_d`: the
     * provisioned include + the root map renderer; `none` (default): the operator's hand map.
     */
    readonly nginx_map?: NginxMapMode;
    /** Every directory of a declared vhost log path (spec §5.9): the agent's `nginx -t` opens them. */
    readonly log_dirs?: readonly string[];
  };
  /**
   * The website this instance serves under (spec S6). Optional: a declaration without it keeps
   * its bytes and its meaning; every site renderer applies only when it is present.
   */
  readonly site?: DeclaredSite;
  /**
   * THE PUBLICATION API v1 — OPTIONAL (legacy: v6-era websites). A declaration WITHOUT it is a
   * v2-only instance with no PHP anywhere: no php_bin, no site.fpm, no v1 pool, no v1 tree, no v1
   * web handler, no v1 log rotation; the agent refuses a v1 release (no PHP_BIN). The v1-only keys
   * (php_bin, site.fpm, site.api_paths.v1, paths.fpm_pool_dir, paths.v1_var_base) are refused
   * without it, by name, and php_bin (+ site.fpm with a site) is required with it.
   *
   * `user`: the USER the Publication API v1 runs as — the user of v1's OWN dedicated PHP-FPM pool
   * (decision A, spec S5: with `site` the provisioner renders that pool; never the website's
   * pool, never a web or catch-all account — FORBIDDEN_V1_USERS). It
   * OWNS the v1 configuration (shared/server_config_api.php, mode 0400/0600): the group
   * cannot separate sites that share it, the owner can. The agent never reads that file — it
   * stats and links it — so v1/shared is root:root 0711 and the agent joins no v1 group.
   * releases/install.ts refuses a configuration readable by group or others.
   */
  readonly v1?: {
    readonly user: string;
  };
  readonly state_root: string;
  /**
   * `selinux_label` (shared mode only): the operator's consent that `provision apply` labels their
   * shared media directory `httpd_sys_content_t` (the S9 `M(/.*)?` rule + `restorecon -R`). It is
   * `provision init`'s `selinux.media_access=act` answer, kept where apply and check read it; copy
   * mode is the agent's own tree and is always labelled. Ignored on a host without SELinux.
   */
  readonly media: { readonly mode: MediaMode; readonly root?: string; readonly selinux_label?: true };
  /** The PHP CLI the agent lints a v1 release with. Only with `v1` (and then required). */
  readonly php_bin?: string;
  readonly bun_bin: string;
  readonly v2: {
    readonly unit: string;
    readonly user: string;
    readonly group: string;
    readonly port: number;
    readonly health_url: string;
  };
  readonly releases_retained?: number;
  /** Host-directory overrides. Production omits it; the scratch-root tests use it. */
  readonly paths?: {
    readonly config_base?: string;
    readonly unit_dir?: string;
    readonly sudoers_dir?: string;
    readonly polkit_rules_dir?: string;
    /** HOST_BASE (spec §2.2 scratch-root override; `provision check` prints a set one as a fact). */
    readonly host_base?: string;
    /** nginx's conf.d, where NGINX_MAP_INCLUDE_NAME lands. */
    readonly nginx_conf_d?: string;
    /** Replaces the FPM flavour's pool directory. */
    readonly fpm_pool_dir?: string;
    /** V1_VAR_BASE (`<v1_var_base>/<instance>/v1`). */
    readonly v1_var_base?: string;
    /** Replaces webLogBase() (the site's log directory is `<web_log_base>/<domain>`). */
    readonly web_log_base?: string;
    /** DEFAULT_PATHS.logrotateDir. */
    readonly logrotate_dir?: string;
  };
}

export type NginxMapMode = 'conf_d' | 'none';

export interface DeclaredSite {
  readonly domain: string;
  /** Default `/home/<domain>`. */
  readonly home?: string;
  /** Required for a v2-only site (no FPM flavour to derive it from); else it must agree with site.fpm.flavor. */
  readonly os_family?: OsFamily;
  /** Default DEFAULT_API_PATHS. `v1` only with the v1 block. */
  readonly api_paths?: { readonly v1?: string; readonly v2: string };
  /** The FPM install the dedicated v1 pool runs in. Required with `v1`, refused without it. */
  readonly fpm?: { readonly flavor: FpmFlavor; readonly version: string };
}

/* ── the modes matrix: a renderer or the plan names a ROW, never an owner or a number ── */

export type ModeOwner = 'root' | 'agent' | 'v1';
export type ModeGroup = 'root' | 'v2Group' | 'engineGroup' | 'pubhost';

export interface ArtifactMode {
  readonly owner: ModeOwner;
  readonly group: ModeGroup;
  readonly mode: number;
}

function row(owner: ModeOwner, group: ModeGroup, mode: number): ArtifactMode {
  return Object.freeze({ owner, group, mode });
}

/**
 * The state-tree rows take their OWNER from STATE_TREE_OWNERSHIP (instance/roots.ts): the
 * agent's preflight and this matrix cannot disagree about who owns what. No row inside the
 * state tree is group- or world-writable (the preflight refuses that).
 */
export const MODES = Object.freeze({
  configBase: row('root', 'root', 0o755),
  instanceDir: row('root', 'root', 0o755),
  credentialsDir: row('root', 'root', 0o700),
  credential: row('root', 'root', 0o600),
  envFile: row('root', 'root', 0o644),
  tlsDir: row('root', 'root', 0o755),
  tlsPublic: row('root', 'root', 0o644),
  tlsCaKey: row('root', 'root', 0o600),
  tlsServerKey: row('agent', 'root', 0o400),
  engineBundleDir: row('root', 'root', 0o700),
  engineBundleFile: row('root', 'root', 0o600),
  engineFragment: row('root', 'root', 0o644),
  unitFile: row('root', 'root', 0o644),
  sudoers: row('root', 'root', 0o440),
  polkit: row('root', 'root', 0o644),
  stateRoot: row(STATE_TREE_OWNERSHIP.stateRoot, 'root', 0o755),
  marker: row('root', 'root', 0o644),
  publicationApi: row(STATE_TREE_OWNERSHIP.publicationApi, 'root', 0o755),
  apiRoot: row('agent', 'root', 0o755),
  releases: row('agent', 'root', 0o755),
  staging: row('agent', 'root', 0o700),
  // Traverse only: the agent stats and links its files, the v1 pool user reads the one it owns.
  v1Shared: row('root', 'root', 0o711),
  v2Shared: row('root', 'v2Group', 0o750),
  rules: row(STATE_TREE_OWNERSHIP.rules, 'root', 0o755),
  audit: row(STATE_TREE_OWNERSHIP.audit, 'root', 0o755),
  // The audit contract (instance/roots.ts): agent-owned 0600, then append-only (chattr +a — plan.ts/apply.ts).
  auditFile: row(STATE_TREE_OWNERSHIP.auditFile, 'root', 0o600),
  mediaCopy: row('agent', 'root', 0o755),
  // ── provision init, step 1 (spec §2.2, §5, §7, §13.2) ──
  /** v2/shared/v2.env: the v2 service reads it through systemd EnvironmentFile=. */
  v2Env: row('root', 'v2Group', 0o640),
  /** v1/shared/server_config_api.php: owned by the v1 pool's user (decision A), never group-readable. */
  v1Config: row('v1', 'root', 0o400),
  /** `<configBase>/<instance>/web.<server>.conf`, the stamped web include (spec S4). */
  webInclude: row('root', 'root', 0o644),
  /** The dedicated v1 pool (spec S5). */
  fpmPool: row('root', 'root', 0o644),
  /** `<webLogBase>/<domain>`: the server's master writes it as root (layout.ts webLogBase). */
  webLogs: row('root', 'root', 0o755),
  /** `<logrotate_dir>/dedalo_<instance>_web` and `…_v1` (render/logrotate.ts). */
  logrotate: row('root', 'root', 0o644),
  /** NGINX_MAP_INCLUDE_PATH, host-wide (spec §13.6). */
  nginxMapInclude: row('root', 'root', 0o644),
  /** `<v1_var_base>/<instance>/v1`: traverse only. */
  v1Var: row('root', 'root', 0o711),
  /** `<v1Var>/tmp` and `<v1Var>/log`: the v1 pool's own. */
  v1VarWork: row('v1', 'root', 0o700),
  hostBase: row('root', 'root', 0o755),
  /** Agents flock web.lock read-only and can create, rename or remove nothing here (spec §7). */
  hostLocks: row('root', 'pubhost', 0o750),
  hostProvisionLock: row('root', 'root', 0o600),
  hostWebLock: row('root', 'pubhost', 0o640),
  /** The live host map: root-written only (spec §13.5). */
  hostNginxMap: row('root', 'root', 0o755),
  /** Sticky + setgid: an agent replaces or removes only its own contribution. */
  hostNginxContrib: row('root', 'pubhost', 0o3770),
  hostMapRenderer: row('root', 'root', 0o755),
  /** `<INIT_BASE>` and `<INIT_BASE>/<instance>` (spec §7). */
  initState: row('root', 'root', 0o700),
  journal: row('root', 'root', 0o600),
  /** `<INIT_BASE>/<instance>/init.lock` (+ its owner record), spec §7. */
  initLock: row('root', 'root', 0o600),
  /** `<config_base>/<instance>/provisioned.json`: what apply provisioned that a later declaration may retire (retire.ts). */
  provisionRecord: row('root', 'root', 0o644),
});

export type ModeKey = keyof typeof MODES;

export interface DirSpec {
  readonly path: string;
  readonly modeKey: ModeKey;
}

/* ── the derived layout ───────────────────────────────────────────────────────────── */

export interface ApiDirs {
  readonly root: string;
  readonly releases: string;
  readonly shared: string;
  readonly staging: string;
  /** The `current` symlink. Created by the agent (store.ts promote), never by the provisioner. */
  readonly current: string;
  /**
   * The `scratch` symlink the v2 scratch template unit runs from. Repointed by the agent before
   * each scratch boot (a release under test), never created by the provisioner.
   */
  readonly scratch: string;
}

export interface UnixListenLayout {
  readonly kind: 'unix';
  /** For the unit's RuntimeDirectory= (relative to /run). */
  readonly runtimeDirectory: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
}

export interface TlsListenLayout {
  readonly kind: 'tls';
  readonly host: string;
  readonly port: number;
}

export interface TlsPaths {
  readonly dir: string;
  readonly caCert: string;
  readonly caKey: string;
  readonly serverCert: string;
  readonly serverKey: string;
  /** The agent pins its OWN CA as the only client CA (D2). */
  readonly clientCa: string;
}

/** The derived FPM install the dedicated v1 pool runs in (spec S5 table). */
export interface FpmLayout {
  readonly flavor: FpmFlavor;
  readonly version: string;
  /** `dedalo_<instance>_v1`. */
  readonly pool: string;
  readonly poolFile: string;
  /** Bare unit name (no `.service`). */
  readonly unit: string;
  readonly bin: string;
  readonly cli: string;
  /** The pool's unix socket. */
  readonly listen: string;
  /** listen.owner / listen.group: the web server's user (derived, never discovered at render time). */
  readonly webUser: string;
}

/** The v1 half of a site: present exactly when the declaration has `v1` (spec S5). */
export interface SiteV1Layout {
  readonly apiPath: string;
  readonly fpm: FpmLayout;
  /** `<v1_var_base>/<instance>/v1` and its pool-owned `tmp/`, `log/`. */
  readonly var: { readonly root: string; readonly tmp: string; readonly log: string };
}

export interface SiteLayout {
  readonly domain: string;
  readonly home: string;
  /** site.os_family, or the FPM flavour's family (familyOfFlavor). */
  readonly family: OsFamily;
  /**
   * The site's web server log directory, `<webLogBase()>/<domain>` (root:root, MODES.webLogs):
   * created by provision apply in the home layout, rotated by render/logrotate.ts. Never under the home.
   */
  readonly webLogsDir: string;
  readonly v2ApiPath: string;
  /** null on a v2-only instance. */
  readonly v1: SiteV1Layout | null;
}

/** THE PUBLICATION API v1 of this instance — null on a v2-only one (no PHP anywhere). */
export interface V1Layout {
  /** HostDeclaration.v1.user: owns the v1 configuration and runs the v1 pool. */
  readonly user: string;
  /** HostDeclaration.php_bin: the agent's PHP_BIN (`php -l` of a v1 release). */
  readonly phpBin: string;
  /** `<publication_api>/v1`. */
  readonly dirs: ApiDirs;
  /** `<logrotate_dir>/dedalo_<instance>_v1`: the rotation of site.v1.var.log (render/logrotate.ts; every site). */
  readonly logrotatePath: string;
}

export interface HostPaths {
  readonly base: string;
  readonly locksDir: string;
  readonly provisionLock: string;
  readonly webLock: string;
  readonly nginxMapDir: string;
  readonly nginxContribDir: string;
  readonly mapRendererDir: string;
  readonly nginxConfD: string;
  readonly nginxMapInclude: string;
}

/** What an instance on a fapolicyd host owns of it (layout.ts FAPOLICYD_*). */
export interface TrustLayout {
  /** `dedalo-pubhost-trust-<instance>` (bare). */
  readonly unit: string;
  readonly unitPath: string;
  /** `<FAPOLICYD_TRUST_DIR>/dedalo_<instance>`. */
  readonly file: string;
  /** `<config_base>/<instance>/fapolicyd_trust.json`. */
  readonly result: string;
}

export interface AgentLayout {
  readonly instance: string;
  readonly declarationPath: string;
  readonly listen: UnixListenLayout | TlsListenLayout;
  readonly identity: {
    readonly agentUser: string;
    readonly engineGroup: string | null;
    readonly v2User: string;
    readonly v2Group: string;
    /**
     * The agent unit's SupplementaryGroups= (render/unit_agent.ts renders exactly this): the agent
     * reads v2/shared (root:v2Group 0750) — exec.ts's scratch boot checks v2.env. v1/shared needs
     * no group (root:root 0711: the agent only stats and links there).
     */
    readonly agentSupplementaryGroups: readonly string[];
  };
  readonly web: {
    readonly server: WebServer;
    readonly unit: string;
    readonly configtestBin: string;
    /** Always 'none' on apache. */
    readonly nginxMap: NginxMapMode;
    readonly logDirs: readonly string[];
  };
  /** null when the declaration has no `site` block (no site renderer applies). */
  readonly site: SiteLayout | null;
  /**
   * The HOST-WIDE ProtectHome= value every agent unit renders (spec S10): `read-only` when this
   * declaration or ANY sibling (DeriveHost.anyHomeBound) has a path under a home tree, else `yes`.
   */
  readonly protectHome: 'read-only' | 'yes';
  /** True when this declaration's own paths lie under a home tree (siblings read it for protectHome). */
  readonly homeBound: boolean;
  /** Host-wide paths (spec S11, §13.2), from `paths.host_base` / `paths.nginx_conf_d`. */
  readonly host: HostPaths;
  readonly agentDir: string;
  readonly agentEntry: string;
  readonly bunBin: string;
  /** null on a v2-only instance (the declaration has no `v1`). */
  readonly v1: V1Layout | null;
  /** The APIs this instance serves, in ['v1', 'v2'] order: ['v2'] on a v2-only instance. */
  readonly servedApis: readonly ProvisionApi[];
  /** `selinuxLabel`: the declaration's `media.selinux_label` (shared mode only; false otherwise). */
  readonly media: { readonly mode: MediaMode; readonly root: string | null; readonly selinuxLabel: boolean };
  readonly v2: { readonly unit: string; readonly port: number; readonly healthUrl: string };
  readonly releasesRetained: number;
  readonly configBase: string;
  readonly instanceDir: string;
  readonly credentialsDir: string;
  readonly serviceTokenPath: string;
  readonly envFile: string;
  readonly tls: TlsPaths | null;
  readonly engineBundleDir: string;
  /** The engine's client cert + key + CA, one root 0600 file the operator carries (tls.ts). */
  readonly engineBundlePath: string;
  /** What the engine will need to pair (render/engine_fragment.ts); secret-free. */
  readonly engineFragmentPath: string;
  readonly agentUnitName: string;
  readonly agentUnitPath: string;
  readonly v2UnitPath: string;
  /** The v2 scratch boot's template unit, `<v2.unit>-scratch@.service` (render/unit_v2.ts). */
  readonly v2ScratchUnitPath: string;
  readonly sudoersPath: string;
  readonly polkitPath: string;
  /** `<logrotate_dir>/dedalo_<instance>_web`: the rotation of site.webLogsDir (render/logrotate.ts; home layout only). */
  readonly logrotatePath: string;
  readonly state: {
    readonly root: string;
    readonly marker: string;
    readonly publicationApi: string;
    /** v2 only: the v1 tree is layout.v1.dirs (absent on a v2-only instance). */
    readonly apis: { readonly v2: ApiDirs };
    readonly rules: string;
    readonly audit: string;
    /** The agent's append-only trail: created empty, agent-owned, never rewritten. */
    readonly auditFile: string;
  };
  /**
   * fapolicyd is installed on this host (DeriveHost.fapolicyd): the trust unit, its trust file and
   * its result record. null = no fapolicyd: nothing of it is rendered (and a recorded one is retired).
   */
  readonly trust: TrustLayout | null;
  /** Every directory the plan ensures, sorted so a parent precedes its children. */
  readonly directories: readonly DirSpec[];
  /** The agent's env file (src/config.ts's env-file keys only), rendered by render/env.ts. */
  readonly envVars: Readonly<Record<string, string>>;
}

/* ── errors + helpers ─────────────────────────────────────────────────────────────── */

export class LayoutError extends Error {
  readonly field: string;
  /** The refusal sentence alone (without `layout: <field>:`): what a form shows beside the field. */
  readonly reason: string;
  constructor(field: string, message: string) {
    super(`layout: ${field}: ${message}`);
    this.name = 'LayoutError';
    this.field = field;
    this.reason = message;
  }
}

function matches(pattern: RegExp, field: string, value: unknown): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new LayoutError(field, `'${String(value)}' must match ${pattern.source}`);
  }
  return value;
}

/** Absolute, no `.`/`..` segment, no `//`, no trailing slash (except `/` itself). */
export function cleanAbsolute(field: string, value: unknown): string {
  const path = matches(ABSOLUTE_PATH_PATTERN, field, value);
  const segments = path.split('/');
  if (segments.includes('..') || segments.includes('.')) {
    throw new LayoutError(field, `'${path}' must not contain '.' or '..' segments`);
  }
  const tidy = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (normalize(tidy) !== tidy) {
    throw new LayoutError(field, `'${path}' is not in normal form (repeated '/')`);
  }
  return tidy;
}

export function pathsOverlap(a: string, b: string): boolean {
  if (a === '/' || b === '/') return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function unitName(field: string, value: unknown): string {
  const unit = matches(UNIT_NAME_PATTERN, field, value);
  if (unit.endsWith('.service')) {
    throw new LayoutError(field, `'${unit}': name the unit without the '.service' suffix`);
  }
  return unit;
}

/** `listen.host` through the one grammar (listenHostProblem): IPv4, or a private canonical IPv6. */
function listenHost(value: unknown): string {
  const problem = listenHostProblem(value);
  if (problem !== null) throw new LayoutError('listen.host', `'${String(value)}' ${problem}`);
  return value as string;
}

function tcpPort(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new LayoutError(field, `'${String(value)}' must be an integer port 1-65535`);
  }
  return value;
}

function healthUrl(value: unknown, port: number): string {
  if (typeof value !== 'string') throw new LayoutError('v2.health_url', 'must be a string');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LayoutError('v2.health_url', `'${value}' is not a URL`);
  }
  if (url.protocol !== 'http:') {
    throw new LayoutError('v2.health_url', 'must be http: — v2 listens on loopback behind the web server');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new LayoutError('v2.health_url', `host '${url.hostname}' is not loopback`);
  }
  const urlPort = url.port === '' ? 80 : Number(url.port);
  if (urlPort !== port) {
    throw new LayoutError('v2.health_url', `port ${urlPort} disagrees with v2.port ${port}`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new LayoutError('v2.health_url', 'must carry no userinfo, query or fragment');
  }
  return url.href;
}

function apiDirs(publicationApi: string, api: ProvisionApi): ApiDirs {
  const root = join(publicationApi, api);
  return Object.freeze({
    root,
    releases: join(root, 'releases'),
    shared: join(root, 'shared'),
    staging: join(root, 'staging'),
    current: join(root, 'current'),
    scratch: join(root, 'scratch'),
  });
}

export function ownerName(layout: AgentLayout, owner: ModeOwner): string {
  switch (owner) {
    case 'root':
      return 'root';
    case 'agent':
      return layout.identity.agentUser;
    case 'v1':
      if (layout.v1 === null) {
        throw new LayoutError('v1', 'a v2-only instance has no v1 user; no artifact may name that row');
      }
      return layout.v1.user;
    default: {
      const unreachable: never = owner;
      throw new Error(`layout: unknown mode owner '${String(unreachable)}'`);
    }
  }
}

export function groupName(layout: AgentLayout, group: ModeGroup): string {
  switch (group) {
    case 'root':
      return 'root';
    case 'pubhost':
      return PUBHOST_GROUP;
    case 'v2Group':
      return layout.identity.v2Group;
    case 'engineGroup':
      if (layout.identity.engineGroup === null) {
        throw new LayoutError('engine_group', 'a tls instance has no engine group; no artifact may name that row');
      }
      return layout.identity.engineGroup;
    default: {
      const unreachable: never = group;
      throw new Error(`layout: unknown mode group '${String(unreachable)}'`);
    }
  }
}

/* ── site, FPM and layout helpers (spec S5, S6) ───────────────────────────────────── */

/** The FPM pool's listen owner (spec S5): Debian's www-data; on EL the server's own account. */
export function webUserFor(flavor: FpmFlavor, server: WebServer): string {
  if (flavor === 'debian') return 'www-data';
  return server === 'apache' ? 'apache' : 'nginx';
}

/** The trees systemd's ProtectHome= governs (render/unit_agent.ts reads layout.protectHome). */
export const HOME_TREES = /^\/(home|root|run\/user)(\/|$)/;

function versionAtLeast(version: string, floor: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [floorMajor = 0, floorMinor = 0] = floor.split('.').map(Number);
  return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}

/** The S5 table, one row per flavour. `poolDir` replaces the flavour's directory (the scratch override). */
export function fpmLayout(
  instance: string,
  flavor: FpmFlavor,
  version: string,
  server: WebServer,
  poolDir?: string,
): FpmLayout {
  const nn = version.replace('.', '');
  const pool = `dedalo_${instance}_v1`;
  const socket = `dedalo-${instance}-v1.sock`;
  const dir = poolDir ?? FPM_POOL_DIRS[flavor].replace('<v>', version).replace('<NN>', nn);
  const rows: Record<FpmFlavor, Omit<FpmLayout, 'flavor' | 'version' | 'pool' | 'poolFile' | 'webUser'>> = {
    debian: { unit: `php${version}-fpm`, bin: `/usr/sbin/php-fpm${version}`, cli: `/usr/bin/php${version}`, listen: `/run/php/${socket}` },
    el: { unit: 'php-fpm', bin: '/usr/sbin/php-fpm', cli: '/usr/bin/php', listen: `/run/php-fpm/${socket}` },
    remi: {
      unit: `php${nn}-php-fpm`,
      bin: `/opt/remi/php${nn}/root/usr/sbin/php-fpm`,
      cli: `/opt/remi/php${nn}/root/usr/bin/php`,
      listen: `/var/opt/remi/php${nn}/run/php-fpm/${socket}`,
    },
  };
  return Object.freeze({
    flavor,
    version,
    pool,
    poolFile: join(dir, `${pool}.conf`),
    ...rows[flavor],
    webUser: webUserFor(flavor, server),
  });
}

/** The paths a layout kind gives (spec S6 table). `home` needs the site's home. */
export function layoutPaths(
  kind: LayoutKind,
  instance: string,
  home: string | null,
): { readonly state_root: string; readonly agent_dir: string; readonly bun_bin: string } {
  if (kind === 'home') {
    if (home === null) throw new LayoutError('layout', "the 'home' layout needs a site (no domain, no home path)");
    return Object.freeze({
      state_root: join(home, HOME_LAYOUT_NAMES.stateRoot),
      agent_dir: join(home, HOME_LAYOUT_NAMES.agentDir),
      bun_bin: join(home, HOME_LAYOUT_NAMES.bunDir, 'bin', 'bun'),
    });
  }
  return Object.freeze({
    state_root: join(SYSTEM_LAYOUT.stateBase, instance),
    agent_dir: SYSTEM_LAYOUT.agentDir,
    bun_bin: SYSTEM_LAYOUT.bunBin,
  });
}

/** `site.home`, or its default `/home/<domain>`. */
export function siteHome(site: DeclaredSite): string {
  return site.home ?? join('/home', site.domain);
}

/**
 * Which layout a declaration was built with (spec S6, used on a re-run by draft, compare and
 * plan): `home` when state_root, agent_dir and bun_bin each equal the home column for the site's
 * home — or its relocated name (S6 `declaration.layout_dirs`, `declaration.state_root`) — else
 * `system`. A declaration without `site` is `system`.
 */
export function inferLayout(decl: HostDeclaration): LayoutKind {
  if (decl.site === undefined) return 'system';
  const home = siteHome(decl.site);
  const states = [HOME_LAYOUT_NAMES.stateRoot, HOME_RELOCATED_NAMES.stateRoot].map(name => join(home, name));
  const agents = [HOME_LAYOUT_NAMES.agentDir, HOME_RELOCATED_NAMES.agentDir].map(name => join(home, name));
  const buns = [HOME_LAYOUT_NAMES.bunDir, HOME_RELOCATED_NAMES.bunDir].map(name => join(home, name, 'bin', 'bun'));
  return states.includes(decl.state_root) && agents.includes(decl.agent_dir) && buns.includes(decl.bun_bin)
    ? 'home'
    : 'system';
}

/**
 * THE KEY ORDER of a declaration file — the one body writer's (canonicalDeclaration) and the
 * schema's (schema.ts declares its zod shapes in this order; tests/provision_schema.test.ts holds
 * the two equal, recursively). A nested object names its own order; anything else is a leaf.
 */
type KeyOrder = { readonly [key: string]: KeyOrder | null };
export const DECLARATION_KEY_ORDER: KeyOrder = Object.freeze({
  instance: null,
  listen: Object.freeze({ kind: null, host: null, port: null }),
  agent_user: null,
  engine_group: null,
  agent_dir: null,
  web: Object.freeze({ server: null, unit: null, nginx_map: null, log_dirs: null }),
  site: Object.freeze({
    domain: null,
    home: null,
    os_family: null,
    api_paths: Object.freeze({ v1: null, v2: null }),
    fpm: Object.freeze({ flavor: null, version: null }),
  }),
  v1: Object.freeze({ user: null }),
  state_root: null,
  media: Object.freeze({ mode: null, root: null, selinux_label: null }),
  php_bin: null,
  bun_bin: null,
  v2: Object.freeze({ unit: null, user: null, group: null, port: null, health_url: null }),
  releases_retained: null,
  paths: Object.freeze({
    config_base: null,
    unit_dir: null,
    sudoers_dir: null,
    polkit_rules_dir: null,
    host_base: null,
    nginx_conf_d: null,
    fpm_pool_dir: null,
    v1_var_base: null,
    web_log_base: null,
    logrotate_dir: null,
  }),
});

function ordered(value: unknown, order: KeyOrder | null, at: string): unknown {
  if (order === null || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!(key in order)) throw new LayoutError(at === '' ? key : `${at}.${key}`, 'is not a declaration key');
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(order)) {
    if (source[key] !== undefined) out[key] = ordered(source[key], child, at === '' ? key : `${at}.${key}`);
  }
  return out;
}

/**
 * THE ONE declaration body writer (spec §2.2): two-space JSON, keys in DECLARATION_KEY_ORDER,
 * a trailing newline. `write_declaration`, the examples and compare's diff all use it, so a
 * re-run that changes nothing writes the same bytes. An unknown key throws (never dropped).
 */
export function canonicalDeclaration(decl: HostDeclaration): string {
  return `${JSON.stringify(ordered(decl, DECLARATION_KEY_ORDER, ''), null, 2)}\n`;
}

/* ── derive ───────────────────────────────────────────────────────────────────────── */

/** Host facts derive() may consult. Only the configtest pick, the host-wide ProtectHome fact and fapolicyd's presence depend on the host. */
export interface DeriveHost {
  /** lstat regular file (never a symlink) — chooses among WEB_CONFIGTEST_CANDIDATES. */
  readonly isRealFile?: (path: string) => boolean;
  /**
   * Whether ANY sibling declaration in the config base is home-bound (spec S10): the agent's
   * configtest runs in its mount namespace, so a hidden /home would test a different config.
   * The plan and the CLI pass it; without it only this declaration's own paths count.
   */
  readonly anyHomeBound?: boolean;
  /**
   * fapolicyd is INSTALLED (FAPOLICYD_CLI is a real file; active or not): the instance gets its
   * trust unit and trust file (AgentLayout.trust). The CLI and init pass it; absent = no fapolicyd.
   */
  readonly fapolicyd?: boolean;
}

function apiPath(field: string, value: unknown): string {
  const path = matches(API_PATH_PATTERN, field, value);
  if (path.split('/').includes('..')) throw new LayoutError(field, `'${path}' must not contain '..'`);
  if (path.endsWith('/')) throw new LayoutError(field, `'${path}' must not end with '/'`);
  return path;
}

function deriveSite(
  site: DeclaredSite,
  instance: string,
  server: WebServer,
  v1Declared: boolean,
  paths: { readonly fpm_pool_dir?: string; readonly web_log_base?: string },
  v1VarBase: string,
): SiteLayout {
  const domain = matches(DOMAIN_PATTERN, 'site.domain', site.domain);
  const home = cleanAbsolute('site.home', site.home ?? join('/home', domain));
  if (FORBIDDEN_HOMES.includes(home)) {
    throw new LayoutError('site.home', `'${home}' holds other sites; a site home is its own directory (e.g. /home/${domain})`);
  }
  const v2ApiPath = apiPath('site.api_paths.v2', site.api_paths?.v2 ?? DEFAULT_API_PATHS.v2);
  const declaredFamily = site.os_family;
  if (declaredFamily !== undefined && !OS_FAMILIES.includes(declaredFamily)) {
    throw new LayoutError('site.os_family', `'${String(declaredFamily)}' must be one of ${OS_FAMILIES.join(', ')}`);
  }
  let v1: SiteV1Layout | null = null;
  let family: OsFamily;
  if (!v1Declared) {
    // A v2-only site: no PHP anywhere — every v1-only key is refused by name, never ignored.
    if (site.fpm !== undefined) throw new LayoutError('site.fpm', V1_ONLY('the FPM install of the v1 pool'));
    if (site.api_paths?.v1 !== undefined) throw new LayoutError('site.api_paths.v1', V1_ONLY('the v1 URL path'));
    if (paths.fpm_pool_dir !== undefined) throw new LayoutError('paths.fpm_pool_dir', V1_ONLY('the v1 pool directory'));
    if (declaredFamily === undefined) {
      throw new LayoutError(
        'site.os_family',
        "required for a v2-only site (no site.fpm to derive it from): 'debian' (Debian, Ubuntu) or 'el' (RHEL, Rocky, Alma) — it places the site's web logs",
      );
    }
    family = declaredFamily;
  } else {
    if (site.fpm === undefined) {
      throw new LayoutError('site.fpm', 'required with the v1 block: the FPM install the dedicated v1 pool runs in (spec S5)');
    }
    const v1Path = apiPath('site.api_paths.v1', site.api_paths?.v1 ?? DEFAULT_API_PATHS.v1);
    if (pathsOverlap(v1Path, v2ApiPath)) {
      throw new LayoutError('site.api_paths.v2', `'${v2ApiPath}' overlaps site.api_paths.v1 '${v1Path}'`);
    }
    const flavor = site.fpm.flavor;
    if (!FPM_FLAVORS.includes(flavor)) {
      throw new LayoutError('site.fpm.flavor', `'${String(flavor)}' must be one of ${FPM_FLAVORS.join(', ')}`);
    }
    const version = matches(FPM_VERSION_PATTERN, 'site.fpm.version', site.fpm.version);
    if (!versionAtLeast(version, V1_PHP_FLOOR)) {
      throw new LayoutError('site.fpm.version', `PHP ${version} is below the v1 floor ${V1_PHP_FLOOR}`);
    }
    family = familyOfFlavor(flavor);
    if (declaredFamily !== undefined && declaredFamily !== family) {
      throw new LayoutError('site.os_family', `'${declaredFamily}' disagrees with site.fpm.flavor '${flavor}' (a ${family} install)`);
    }
    const poolDir = paths.fpm_pool_dir === undefined ? undefined : cleanAbsolute('paths.fpm_pool_dir', paths.fpm_pool_dir);
    const fpm = fpmLayout(instance, flavor, version, server, poolDir);
    if (!FPM_BIN_PATTERN.test(fpm.bin) || !PHP_CLI_PATTERN.test(fpm.cli)) {
      throw new LayoutError('site.fpm.version', `'${version}' gives no ${flavor} PHP-FPM install path (${fpm.bin})`);
    }
    // v1.user is never the web user: every webUserFor() value is in FORBIDDEN_V1_USERS, which
    // derive() refuses for any declaration (tests/provision_layout.test.ts holds the inclusion).
    const v1VarRoot = join(v1VarBase, instance, 'v1');
    v1 = Object.freeze({
      apiPath: v1Path,
      fpm,
      var: Object.freeze({ root: v1VarRoot, tmp: join(v1VarRoot, 'tmp'), log: join(v1VarRoot, 'log') }),
    });
  }
  const logBase = cleanAbsolute('paths.web_log_base', paths.web_log_base ?? webLogBase(server, family));
  if (logBase === '/') throw new LayoutError('paths.web_log_base', 'must not be /');
  return Object.freeze({
    domain,
    home,
    family,
    webLogsDir: join(logBase, domain),
    v2ApiPath,
    v1,
  });
}

/** The refusal of a v1-only key in a declaration without the v1 block. */
const V1_ONLY = (what: string): string =>
  `${what} is a Publication API v1 key, and the declaration has no v1 block (a v2-only instance has no PHP anywhere): remove it, or declare v1`;

export function derive(decl: HostDeclaration, host: DeriveHost = {}): AgentLayout {
  const instance = matches(INSTANCE_PATTERN, 'instance', decl.instance);
  const agentUser = matches(UNIX_NAME_PATTERN, 'agent_user', decl.agent_user);
  const v1User = decl.v1 === undefined ? null : matches(UNIX_NAME_PATTERN, 'v1.user', decl.v1.user);
  const v2User = matches(UNIX_NAME_PATTERN, 'v2.user', decl.v2.user);
  const v2Group = matches(UNIX_NAME_PATTERN, 'v2.group', decl.v2.group);
  // Three principals, three users (two on a v2-only instance): the agent holds the sudo/polkit
  // grants, the TLS key and the token; v1 (the site's pool) and v2 run code the work system pushed.
  // One shared user would hand the pushed code what the agent holds (spec §2.5), and root would
  // hand it everything.
  const principals: [string, string][] = [['agent_user', agentUser]];
  if (v1User !== null) principals.push(['v1.user', v1User]);
  principals.push(['v2.user', v2User]);
  for (const [index, [field, user]] of principals.entries()) {
    if (user === 'root') throw new LayoutError(field, 'must not be root');
    for (const [otherField, other] of principals.slice(index + 1)) {
      if (user === other) throw new LayoutError(otherField, `must differ from ${field} ('${user}')`);
    }
  }

  if (v1User !== null && FORBIDDEN_V1_USERS.includes(v1User)) {
    throw new LayoutError(
      'v1.user',
      `'${v1User}' is a web or catch-all account — v1 runs in its own pool under its own account (e.g. ${instance}_v1)`,
    );
  }

  const server = decl.web.server;
  if (server !== 'apache' && server !== 'nginx') {
    throw new LayoutError('web.server', `'${String(server)}' must be apache or nginx`);
  }
  const webUnit = unitName('web.unit', decl.web.unit);
  const configtestBin = pickConfigtestBinary(server, host.isRealFile);
  const nginxMap = decl.web.nginx_map ?? 'none';
  if (nginxMap !== 'conf_d' && nginxMap !== 'none') {
    throw new LayoutError('web.nginx_map', `'${String(nginxMap)}' must be conf_d or none`);
  }
  if (nginxMap === 'conf_d' && server !== 'nginx') {
    throw new LayoutError('web.nginx_map', "'conf_d' is the nginx http{} map; an apache host has none");
  }
  const logDirs = (decl.web.log_dirs ?? []).map((dir, index) => cleanAbsolute(`web.log_dirs.${index}`, dir));
  if (new Set(logDirs).size !== logDirs.length) throw new LayoutError('web.log_dirs', 'lists a directory twice');
  if (logDirs.includes('/')) throw new LayoutError('web.log_dirs', "'/' is not a log directory");

  const agentDir = cleanAbsolute('agent_dir', decl.agent_dir);
  let phpBin: string | null = null;
  if (decl.v1 === undefined) {
    if (decl.php_bin !== undefined) throw new LayoutError('php_bin', V1_ONLY('the PHP CLI that lints a v1 release'));
  } else {
    if (decl.php_bin === undefined) {
      throw new LayoutError('php_bin', 'required with the v1 block: the PHP CLI the agent lints a v1 release with (php -l)');
    }
    phpBin = cleanAbsolute('php_bin', decl.php_bin);
  }
  const bunBin = cleanAbsolute('bun_bin', decl.bun_bin);
  const stateRoot = cleanAbsolute('state_root', decl.state_root);
  if (stateRoot === '/') throw new LayoutError('state_root', 'must not be /');

  const paths = decl.paths ?? {};
  const configBase = cleanAbsolute('paths.config_base', paths.config_base ?? DEFAULT_PATHS.configBase);
  const unitDir = cleanAbsolute('paths.unit_dir', paths.unit_dir ?? DEFAULT_PATHS.unitDir);
  const sudoersDir = cleanAbsolute('paths.sudoers_dir', paths.sudoers_dir ?? DEFAULT_PATHS.sudoersDir);
  const polkitRulesDir = cleanAbsolute(
    'paths.polkit_rules_dir',
    paths.polkit_rules_dir ?? DEFAULT_PATHS.polkitRulesDir,
  );
  const hostBase = cleanAbsolute('paths.host_base', paths.host_base ?? DEFAULT_PATHS.hostBase);
  const logrotateDir = cleanAbsolute('paths.logrotate_dir', paths.logrotate_dir ?? DEFAULT_PATHS.logrotateDir);
  const nginxConfD = cleanAbsolute('paths.nginx_conf_d', paths.nginx_conf_d ?? DEFAULT_PATHS.nginxConfD);
  if (decl.v1 === undefined && paths.v1_var_base !== undefined) {
    throw new LayoutError('paths.v1_var_base', V1_ONLY('the v1 pool directory base'));
  }
  const v1VarBase = cleanAbsolute('paths.v1_var_base', paths.v1_var_base ?? DEFAULT_PATHS.v1VarBase);
  for (const [field, path] of [['paths.host_base', hostBase], ['paths.v1_var_base', v1VarBase]] as const) {
    if (path === '/') throw new LayoutError(field, 'must not be /');
  }
  const site =
    decl.site === undefined ? null : deriveSite(decl.site, instance, server, decl.v1 !== undefined, paths, v1VarBase);
  const locksDir = join(hostBase, 'locks');
  const nginxMapDir = join(hostBase, 'nginx_map');
  const hostPaths: HostPaths = Object.freeze({
    base: hostBase,
    locksDir,
    provisionLock: join(locksDir, HOST_LOCK_FILES.provision),
    webLock: join(locksDir, HOST_LOCK_FILES.web),
    nginxMapDir,
    nginxContribDir: join(nginxMapDir, 'contrib'),
    mapRendererDir: join(hostBase, 'map_renderer'),
    nginxConfD,
    nginxMapInclude: join(nginxConfD, NGINX_MAP_INCLUDE_NAME),
  });

  let listen: UnixListenLayout | TlsListenLayout;
  let engineGroup: string | null;
  if (decl.listen.kind === 'unix') {
    if (decl.engine_group === undefined) {
      throw new LayoutError('engine_group', 'required for a unix listener — the socket is 0660 with this group');
    }
    engineGroup = matches(UNIX_NAME_PATTERN, 'engine_group', decl.engine_group);
    const runtimeDir = join(DEFAULT_PATHS.runtimeBase, instance);
    listen = Object.freeze({
      kind: 'unix',
      runtimeDirectory: `dedalo_publication_host/${instance}`,
      runtimeDir,
      socketPath: join(runtimeDir, 'agent.sock'),
    });
  } else if (decl.listen.kind === 'tls') {
    if (decl.engine_group !== undefined) {
      throw new LayoutError(
        'engine_group',
        'only a unix listener has an engine group; over mTLS the engine is its client certificate',
      );
    }
    engineGroup = null;
    listen = Object.freeze({
      kind: 'tls',
      host: listenHost(decl.listen.host),
      port: tcpPort('listen.port', decl.listen.port),
    });
  } else {
    throw new LayoutError('listen.kind', `'${String((decl.listen as { kind?: unknown }).kind)}' must be unix or tls`);
  }

  const mediaMode = decl.media.mode;
  if (mediaMode !== 'shared' && mediaMode !== 'copy' && mediaMode !== 'none') {
    throw new LayoutError('media.mode', `'${String(mediaMode)}' must be shared, copy or none`);
  }
  let mediaRoot: string | null = null;
  if (mediaMode === 'none') {
    if (decl.media.root !== undefined) throw new LayoutError('media.root', "must be absent when media.mode is 'none'");
  } else {
    if (decl.media.root === undefined) throw new LayoutError('media.root', `required when media.mode is '${mediaMode}'`);
    mediaRoot = cleanAbsolute('media.root', decl.media.root);
  }
  const selinuxLabel = decl.media.selinux_label;
  if (selinuxLabel !== undefined && selinuxLabel !== true) throw new LayoutError('media.selinux_label', 'must be true or absent');
  if (selinuxLabel === true && mediaMode !== 'shared') {
    throw new LayoutError('media.selinux_label', `only for media.mode 'shared' (${mediaMode === 'copy' ? 'copy mode is always labelled' : 'there is no media root'})`);
  }

  const v2Unit = unitName('v2.unit', decl.v2.unit);
  if (v2Unit === webUnit) throw new LayoutError('v2.unit', 'must differ from web.unit');
  if (v2Unit.includes('@')) {
    throw new LayoutError('v2.unit', `'${v2Unit}': no '@' — the scratch boot's template unit is '<v2.unit>-scratch@.service'`);
  }
  const v2Port = tcpPort('v2.port', decl.v2.port);
  const v2HealthUrl = healthUrl(decl.v2.health_url, v2Port);

  const releasesRetained = decl.releases_retained ?? RELEASES_RETAINED_DEFAULT;
  if (
    !Number.isInteger(releasesRetained) ||
    releasesRetained < RELEASES_RETAINED_MIN ||
    releasesRetained > RELEASES_RETAINED_MAX
  ) {
    throw new LayoutError(
      'releases_retained',
      `'${String(releasesRetained)}' must be an integer ${RELEASES_RETAINED_MIN}-${RELEASES_RETAINED_MAX}`,
    );
  }

  // One root, one owner: no declared tree may contain another.
  const claims: [string, string][] = [
    ['state_root', stateRoot],
    ['paths.config_base', configBase],
    ['agent_dir', agentDir],
    ['paths.unit_dir', unitDir],
    ['paths.sudoers_dir', sudoersDir],
    ['paths.polkit_rules_dir', polkitRulesDir],
  ];
  if (mediaRoot !== null) claims.push(['media.root', mediaRoot]);
  // Host-wide state and the v1 pool's own directories belong to no declared tree.
  claims.push(['paths.host_base', hostBase]);
  if (site?.v1 != null) claims.push(['site.v1Var', site.v1.var.root]);
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const [fieldA, pathA] = claims[i] as [string, string];
      const [fieldB, pathB] = claims[j] as [string, string];
      if (pathsOverlap(pathA, pathB)) {
        throw new LayoutError(fieldB, `'${pathB}' overlaps ${fieldA} '${pathA}'`);
      }
    }
  }

  const instanceDir = join(configBase, instance);
  const credentialsDir = join(instanceDir, 'credentials');
  const engineBundleDir = join(instanceDir, 'engine_bundle');
  const tlsDir = join(instanceDir, 'tls');
  const tls: TlsPaths | null =
    listen.kind === 'tls'
      ? Object.freeze({
          dir: tlsDir,
          caCert: join(tlsDir, 'ca.pem'),
          caKey: join(tlsDir, 'ca.key'),
          serverCert: join(tlsDir, 'server.pem'),
          serverKey: join(tlsDir, 'server.key'),
          clientCa: join(tlsDir, 'ca.pem'),
        })
      : null;

  const publicationApi = join(stateRoot, PUBLICATION_API_DIR);
  const v1Dirs = v1User === null ? null : apiDirs(publicationApi, 'v1');
  const apis = Object.freeze({ v2: apiDirs(publicationApi, 'v2') });
  const rules = join(stateRoot, RULES_DIR);
  const audit = join(stateRoot, AUDIT_DIR);

  const directories: DirSpec[] = [
    { path: configBase, modeKey: 'configBase' },
    { path: instanceDir, modeKey: 'instanceDir' },
    { path: credentialsDir, modeKey: 'credentialsDir' },
    { path: engineBundleDir, modeKey: 'engineBundleDir' },
    { path: stateRoot, modeKey: 'stateRoot' },
    { path: publicationApi, modeKey: 'publicationApi' },
    { path: rules, modeKey: 'rules' },
    { path: audit, modeKey: 'audit' },
  ];
  if (tls !== null) directories.push({ path: tls.dir, modeKey: 'tlsDir' });
  for (const [dirs, sharedKey] of [[v1Dirs, 'v1Shared'], [apis.v2, 'v2Shared']] as const) {
    if (dirs === null) continue;
    directories.push(
      { path: dirs.root, modeKey: 'apiRoot' },
      { path: dirs.releases, modeKey: 'releases' },
      { path: dirs.staging, modeKey: 'staging' },
      { path: dirs.shared, modeKey: sharedKey },
    );
  }
  if (mediaMode === 'copy' && mediaRoot !== null) directories.push({ path: mediaRoot, modeKey: 'mediaCopy' });
  directories.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // The env-file keys (src/config.ts KNOWN_KEYS): the instance key is
  // INSTANCE (= config.INSTANCE); any other spelling is refused as unknown (KNOWN_KEYS).
  const envVars: Record<string, string> = {
    INSTANCE: instance,
    NODE_ENV: 'production',
    LISTEN_KIND: listen.kind,
    STATE_ROOT: stateRoot,
    WEB_SERVER: server,
    WEB_UNIT: webUnit,
    WEB_CONFIGTEST_BIN: configtestBin,
    MEDIA_MODE: mediaMode,
    V2_UNIT: v2Unit,
    V2_HEALTH_URL: v2HealthUrl,
    RELEASES_RETAINED: String(releasesRetained),
  };
  if (listen.kind === 'unix') {
    envVars.SOCKET_PATH = listen.socketPath;
  } else if (tls !== null) {
    envVars.TLS_HOST = listen.host;
    envVars.TLS_PORT = String(listen.port);
    envVars.TLS_CERT_FILE = tls.serverCert;
    envVars.TLS_KEY_FILE = tls.serverKey;
    envVars.TLS_CLIENT_CA_FILE = tls.clientCa;
  }
  if (mediaRoot !== null) envVars.MEDIA_ROOT = mediaRoot;
  // No PHP_BIN on a v2-only instance: the agent then serves v2 only and refuses a v1 release.
  if (phpBin !== null) envVars.PHP_BIN = phpBin;
  for (const key of Object.keys(envVars)) {
    if (!ENV_KEY_PATTERN.test(key) || SECRET_LOOKING_KEY.test(key)) {
      throw new Error(`layout: env key '${key}' is not a non-credential AgentConfig key`);
    }
  }

  const agentUnitName = `${AGENT_UNIT_PREFIX}${instance}`;
  const homeBound = [stateRoot, agentDir, bunBin, mediaRoot ?? ''].some(path => HOME_TREES.test(path));
  return Object.freeze({
    instance,
    declarationPath: join(configBase, `${instance}.json`),
    listen,
    identity: Object.freeze({
      agentUser,
      engineGroup,
      v2User,
      v2Group,
      // Spec S11 adds PUBHOST_GROUP here; it lands in ONE change with the regenerated examples, the
      // plan's missing-group refusal and the FakeHost's group (P6/P4), so no gate is red in between.
      agentSupplementaryGroups: Object.freeze([v2Group]),
    }),
    web: Object.freeze({ server, unit: webUnit, configtestBin, nginxMap, logDirs: Object.freeze(logDirs) }),
    site,
    protectHome: homeBound || host.anyHomeBound === true ? 'read-only' : 'yes',
    homeBound,
    host: hostPaths,
    agentDir,
    agentEntry: join(agentDir, 'src', 'index.ts'),
    bunBin,
    v1:
      v1User === null || phpBin === null || v1Dirs === null
        ? null
        : Object.freeze({
            user: v1User,
            phpBin,
            dirs: v1Dirs,
            logrotatePath: join(logrotateDir, `dedalo_${instance}_v1`),
          }),
    servedApis: Object.freeze(v1User === null ? (['v2'] as const) : (['v1', 'v2'] as const)),
    media: Object.freeze({ mode: mediaMode, root: mediaRoot, selinuxLabel: selinuxLabel === true }),
    v2: Object.freeze({ unit: v2Unit, port: v2Port, healthUrl: v2HealthUrl }),
    releasesRetained,
    configBase,
    instanceDir,
    credentialsDir,
    serviceTokenPath: join(credentialsDir, SERVICE_TOKEN_CREDENTIAL),
    envFile: join(instanceDir, 'agent.env'),
    tls,
    engineBundleDir,
    engineBundlePath: join(engineBundleDir, 'engine_bundle.pem'),
    engineFragmentPath: join(instanceDir, 'engine.env.fragment'),
    agentUnitName,
    agentUnitPath: join(unitDir, `${agentUnitName}.service`),
    v2UnitPath: join(unitDir, `${v2Unit}.service`),
    v2ScratchUnitPath: join(unitDir, `${v2Unit}${V2_SCRATCH_TEMPLATE_SUFFIX}.service`),
    sudoersPath: join(sudoersDir, `dedalo_publication_host_${instance}`),
    polkitPath: join(polkitRulesDir, `60-dedalo-publication-host-${instance}.rules`),
    logrotatePath: join(logrotateDir, `dedalo_${instance}_web`),
    state: Object.freeze({
      root: stateRoot,
      marker: join(stateRoot, INSTANCE_MARKER),
      publicationApi,
      apis,
      rules,
      audit,
      auditFile: join(audit, AUDIT_FILE_NAME),
    }),
    directories: Object.freeze(directories.map(d => Object.freeze(d))),
    envVars: Object.freeze(envVars),
    trust:
      host.fapolicyd === true
        ? Object.freeze({
            unit: `${TRUST_UNIT_PREFIX}${instance}`,
            unitPath: join(unitDir, `${TRUST_UNIT_PREFIX}${instance}.service`),
            file: join(FAPOLICYD_TRUST_DIR, trustFileName(instance)),
            result: join(instanceDir, TRUST_RESULT_NAME),
          })
        : null,
  });
}
