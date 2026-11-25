/**
 * DISCOVERY: Apache (spec §3.2 rows Web, Apache, Web run user, Web versions; §4.3
 * `host.php_mode`, `web.modules`, `web.manual_lines`, `web.vhost`).
 *
 * The texts: `<dump bin> -S` (vhosts, run user), `-M` (loaded modules), `-t -D DUMP_INCLUDES`
 * (the files the server really loads), `-v`; on EL the `LoadModule` lines of
 * /etc/httpd/conf.modules.d/*.conf and /etc/httpd/conf.d/php.conf; and each vhost FILE (read
 * by observe.ts through readOperatorFile), because `-S` lists a vhost's aliases only when its
 * address holds several vhosts — a single vhost's ServerAlias is visible only in its file.
 *
 * MEASURED (container captures, tests/fixtures/init/*): the AppStream php.conf of EL 9 (php
 * 8.0, and the php:8.2 stream) and EL 10 (php 8.3, no streams) and Remi's php82-php.conf set
 * the server-wide FPM handler in a plain `<FilesMatch \.(php|phar)$>` inside `<IfModule
 * !mod_php…>` — NOT inside an `<If>`. parsePhpConf reports `insideIf` as found; the spec's
 * platform fact assumed `<If>` (a disagreement changes the spec, never the fixture).
 *
 * MATCHING (security, spec §3.2): a vhost is a candidate only on an EXACT ServerName match;
 * an alias-only or wildcard-only match is reported as such (compare makes it a blocking
 * decision), never edited.
 *
 * PURE, ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts): ../types, ./nginx and ./redirect only.
 */
import type { ModuleLine } from '../types';
import { parseNginxVersion } from './nginx';
import { isAbsoluteRedirectTarget, isCatchAllPattern } from './redirect';

/* ── `-S` ────────────────────────────────────────────────────────────────────────── */

/**
 * ONE vhost on ONE port, whatever addresses it listens on. `<VirtualHost 192.0.2.1:443
 * [2001:db8::1]:443>` (or `*:443` + `[::]:443`) is printed by `-S` once per address — under each
 * address's own NameVirtualHost section, IPv6 bracketed (`[2001:db8::1]:443`) — but it is ONE
 * block, edited once: the entries are keyed on file + line + port, the addresses collected in the
 * order `-S` prints them. Two rows for one block made draft.ts chooseVhost call the site "crowded"
 * (a blocking manual-only decision) on every dual-stack host.
 */
export interface ApacheSEntry {
  /** Every address `-S` lists for this block on this port: `*`, `_default_`, `192.0.2.10`, `[::1]`. */
  readonly addresses: readonly string[];
  readonly port: number;
  /** The name `-S` prints (ServerName, or the host's name for a vhost without one). */
  readonly serverName: string;
  readonly file: string;
  /** The `<VirtualHost` line. */
  readonly line: number;
  /** Only printed for name-based addresses (several vhosts); read the file for the rest. */
  readonly aliases: readonly string[];
  readonly isDefault: boolean;
}

export interface ApacheS {
  readonly entries: readonly ApacheSEntry[];
  readonly user: string | null;
  readonly group: string | null;
}

/** `httpd -S` / `apache2ctl -S` (stdout and stderr together; AH… warnings are skipped). */
export function parseApacheS(text: string): ApacheS {
  const entries: { addresses: string[]; port: number; serverName: string; file: string; line: number; aliases: string[]; isDefault: boolean }[] = [];
  let user: string | null = null;
  let group: string | null = null;
  let address: { address: string; port: number } | null = null;
  let defaultAt: string | null = null;
  // One entry per block and port (file + line + port): a block listening on several addresses is
  // printed once per address, and every printing adds its address to the same entry. Aliases are
  // printed again under each address: kept once.
  const add = (where: { address: string; port: number }, serverName: string, file: string, line: number, isDefault: boolean) => {
    const existing = entries.find(entry => entry.file === file && entry.line === line && entry.port === where.port);
    if (existing) {
      existing.isDefault ||= isDefault;
      if (!existing.addresses.includes(where.address)) existing.addresses.push(where.address);
      return existing;
    }
    const entry = { addresses: [where.address], port: where.port, serverName, file, line, aliases: [] as string[], isDefault };
    entries.push(entry);
    return entry;
  };
  let last: (typeof entries)[number] | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const named = /^(\S+):(\d+)\s+is a NameVirtualHost$/.exec(trimmed);
    if (named) {
      address = { address: named[1] as string, port: Number(named[2]) };
      defaultAt = null;
      last = null;
      continue;
    }
    const single = /^(\S+):(\d+)\s+(\S+)\s+\((\/.+):(\d+)\)$/.exec(trimmed);
    if (single && !line.startsWith(' ')) {
      address = null;
      last = add({ address: single[1] as string, port: Number(single[2]) }, single[3] as string, single[4] as string, Number(single[5]), true);
      continue;
    }
    const dflt = /^default server (\S+) \((\/.+):(\d+)\)$/.exec(trimmed);
    if (dflt && address) {
      defaultAt = `${dflt[2]}:${dflt[3]}`;
      continue;
    }
    const nv = /^port (\d+) namevhost (\S+) \((\/.+):(\d+)\)$/.exec(trimmed);
    if (nv && address) {
      const where = { address: address.address, port: Number(nv[1]) };
      last = add(where, nv[2] as string, nv[3] as string, Number(nv[4]), defaultAt === `${nv[3]}:${nv[4]}`);
      continue;
    }
    const alias = /^(?:wild )?alias (\S+)$/.exec(trimmed);
    if (alias && last) {
      if (!last.aliases.includes(alias[1] as string)) last.aliases.push(alias[1] as string);
      continue;
    }
    const account = /^(User|Group): name="([^"]*)"/.exec(trimmed);
    if (account) {
      if (account[1] === 'User') user = account[2] as string;
      else group = account[2] as string;
      continue;
    }
    last = null; // ServerRoot:, Mutex, Define:, AH… warnings, "VirtualHost configuration:"
  }
  return Object.freeze({
    entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry, addresses: Object.freeze(entry.addresses), aliases: Object.freeze(entry.aliases) }))),
    user,
    group,
  });
}

/* ── `-t -D DUMP_INCLUDES`, `-M`, conf.modules.d ─────────────────────────────────── */

/** The files the server loads, in load order: `(*) /etc/httpd/conf/httpd.conf`, `(47) /etc/…`. */
export function parseDumpIncludes(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const match = /^\s*\((?:\*|\d+)\)\s+(\/\S.*?)\s*$/.exec(raw);
    if (match) out.push(match[1] as string);
  }
  return out;
}

/**
 * `-M` → the loaded modules' SHORT names (`proxy_fcgi_module` → `proxy_fcgi`, `php7_module`
 * → `php7`), the names a2enmod and APACHE_MODULES use.
 */
export function parseModules(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const match = /^\s+([A-Za-z0-9_]+)_module\s+\((?:static|shared)\)\s*$/.exec(raw);
    if (match) out.push(match[1] as string);
  }
  return out;
}

/** A loaded mod_php, any generation (`php`, `php7`, `php5`). */
export function hasPhpModule(modules: readonly string[]): boolean {
  return modules.some(name => /^php\d*$/.test(name));
}

/** EL `LoadModule` lines (commented or not) of /etc/httpd/conf.modules.d/*.conf. */
export function parseModulesD(files: readonly { readonly file: string; readonly text: string }[]): ModuleLine[] {
  const out: ModuleLine[] = [];
  for (const { file, text } of files) {
    text.split('\n').forEach((raw, index) => {
      const match = /^\s*(#\s*)?LoadModule\s+([A-Za-z0-9_]+)\s+\S+/.exec(raw);
      if (match) out.push(Object.freeze({ file, line: index + 1, module: match[2] as string, commented: match[1] !== undefined }));
    });
  }
  return out;
}

/**
 * Whether an `<IfModule …>` argument holds for these loaded short names: `mod_php7.c` /
 * `php7_module` / `prefork.c` (= mpm_prefork), `!` negates.
 */
export function ifModuleActive(condition: string, modules: readonly string[]): boolean {
  const negated = condition.startsWith('!');
  const name = condition.replace(/^!/, '');
  const short = /^mod_(.+)\.c$/.exec(name)?.[1] ?? /^(.+)_module$/.exec(name)?.[1] ?? name.replace(/\.c$/, '');
  const loaded = modules.includes(short) || modules.includes(`mpm_${short}`);
  return negated ? !loaded : loaded;
}

/* ── directive lines (shared by php.conf and the vhost reader) ───────────────────── */

interface DirectiveLine {
  /** 1-based, the FIRST physical line of a continued directive. */
  readonly line: number;
  /** The last physical line (continuations with a trailing `\`). */
  readonly endLine: number;
  readonly name: string;
  readonly args: readonly string[];
  /** `<Section …>` opens, `</Section>` closes, otherwise a directive. */
  readonly kind: 'open' | 'close' | 'directive';
}

/** Splits an argument string, honouring double and single quotes. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) out.push(match[1] ?? match[2] ?? (match[3] as string));
  return out;
}

/** Apache's line grammar: `#` comments (only at a line's start), `\` continuations, `<Sections>`. */
function directiveLines(text: string): DirectiveLine[] {
  const physical = text.split('\n').map(line => line.replace(/\r$/, ''));
  const out: DirectiveLine[] = [];
  for (let index = 0; index < physical.length; index++) {
    const start = index;
    let content = physical[index] as string;
    while (content.endsWith('\\') && index + 1 < physical.length) content = content.slice(0, -1) + (physical[++index] as string);
    const trimmed = content.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const close = /^<\/([A-Za-z]+)\s*>$/.exec(trimmed);
    if (close) {
      out.push({ line: start + 1, endLine: index + 1, name: (close[1] as string).toLowerCase(), args: [], kind: 'close' });
      continue;
    }
    const open = /^<([A-Za-z]+)(?:\s+(.*?))?\s*>$/.exec(trimmed);
    if (open) {
      out.push({ line: start + 1, endLine: index + 1, name: (open[1] as string).toLowerCase(), args: splitArgs(open[2] ?? ''), kind: 'open' });
      continue;
    }
    const [name = '', ...args] = splitArgs(trimmed);
    out.push({ line: start + 1, endLine: index + 1, name: name.toLowerCase(), args, kind: 'directive' });
  }
  return out;
}

/**
 * `proxy:unix:/run/php-fpm/www.sock|fcgi://localhost` (SetHandler) or `unix:/…|fcgi://…`
 * (ProxyPassMatch's target) → the socket path; null for anything else.
 */
export function fpmSocketOfHandler(handler: string): string | null {
  const match = /^(?:proxy:)?unix:(\/[^|]+)\|fcgi:/i.exec(handler.trim());
  return match ? (match[1] as string) : null;
}

/* ── EL php.conf (§4.3 host.php_mode) ────────────────────────────────────────────── */

export interface PhpConfHandler {
  readonly file: string;
  /** The enclosing `<FilesMatch>` pattern (`\.(php|phar)$`). */
  readonly pattern: string;
  /** The handler sits inside an `<If>` (merged last). */
  readonly insideIf: boolean;
  /** The FPM socket it sends to. */
  readonly socket: string;
  /** The `<IfModule>` conditions around it, outermost first (`!mod_php7.c`). */
  readonly ifModules: readonly string[];
}

/** The first server-wide FPM handler (`SetHandler "proxy:unix:…"` inside a `<FilesMatch>`) of a php.conf, or null. */
export function parsePhpConf(text: string, file: string): PhpConfHandler | null {
  const stack: DirectiveLine[] = [];
  for (const entry of directiveLines(text)) {
    if (entry.kind === 'open') stack.push(entry);
    else if (entry.kind === 'close') stack.pop();
    else if (entry.name === 'sethandler') {
      const socket = fpmSocketOfHandler(entry.args[0] ?? '');
      const filesMatch = [...stack].reverse().find(section => section.name === 'filesmatch');
      if (socket === null || filesMatch === undefined) continue;
      return Object.freeze({
        file,
        pattern: filesMatch.args[0] ?? '',
        insideIf: stack.some(section => section.name === 'if'),
        socket,
        ifModules: Object.freeze(stack.filter(section => section.name === 'ifmodule').map(section => section.args[0] ?? '')),
      });
    }
  }
  return null;
}

/* ── one vhost's block ───────────────────────────────────────────────────────────── */

export interface VhostReadContext {
  /** Our stamped reference's include target (`<configBase>/<instance>/web.apache.conf`). */
  readonly referencePath: string;
}

export interface VhostBlock {
  readonly line: number;
  readonly endLine: number;
  readonly serverName: string | null;
  readonly aliases: readonly string[];
  readonly ssl: boolean;
  readonly documentRoot: string | null;
  readonly errorLog: string | null;
  readonly accessLogs: readonly string[];
  /** The FPM socket the vhost's OWN handler names (not one inside a guide-style v1 block). */
  readonly fpmHandler: string | null;
  readonly ourReference: boolean;
  /** Guide-style hand-written Dédalo lines (web.manual_lines): every physical line, in order. */
  readonly manualLines: readonly { readonly line: number; readonly text: string }[];
  /**
   * Every request is answered with a redirect to an absolute URL (the :80 → https:// vhost, a
   * canonical-host redirect): the block serves nothing, so it is never a candidate for the APIs
   * include (draft.ts chooseVhost). The closed set of forms: wholeSiteRedirect, wholeSiteRewrite
   * (whose RewriteConds must hold for every request the block serves: conditionsWholeSite).
   */
  readonly redirectOnly: boolean;
}

/* ── redirect-only blocks (./redirect holds the patterns nginx shares) ───────────── */

/** mod_alias status words and codes that redirect (`gone` does not). */
const REDIRECT_STATUS = /^(?:permanent|temp|seeother|3\d\d)$/i;

/**
 * What a block serves, as far as a RewriteCond can test it: its names (ServerName + every
 * ServerAlias), whether it speaks TLS, and the ports its `<VirtualHost>` addresses name (null when
 * one address names none: `%{SERVER_PORT}` cannot be judged).
 */
interface BlockScope {
  readonly names: readonly string[];
  readonly ssl: boolean;
  readonly ports: readonly string[] | null;
}

/** `[OR]`, `[NC,OR]`, `[ornext]` … → the lower-case flag words. */
function conditionFlags(args: readonly string[]): string[] {
  const list = /^\[(.*)\]$/.exec(args[2] ?? '')?.[1] ?? '';
  return list.split(',').map(flag => flag.trim().toLowerCase()).filter(flag => flag !== '');
}

/**
 * One CondPattern against one value, as mod_rewrite reads it: a leading `!` negates, `=x` is a
 * string equality, anything else a regex (PCRE; the simple patterns operators write are the same
 * in JS). The other comparison forms (`-f`, `<x`, `-ipmatch` …) and an uncompilable regex answer
 * null: unknown, so the caller keeps the block a candidate.
 */
function conditionHolds(pattern: string, nocase: boolean, value: string): boolean | null {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  let holds: boolean;
  if (body.startsWith('=')) holds = nocase ? body.slice(1).toLowerCase() === value.toLowerCase() : body.slice(1) === value;
  else if (/^(?:-|<|>)/.test(body)) return null;
  else {
    try {
      holds = new RegExp(body, nocase ? 'i' : '').test(value);
    } catch {
      return null;
    }
  }
  return negated ? !holds : holds;
}

/**
 * True when ONE RewriteCond is true for EVERY request the block serves — so it cannot spare any of
 * them from the redirect. Owner-reviewed narrowing (2026-11, review lane A): before it, ANY test
 * of a host or scheme variable counted as "only selects which host/scheme is redirected", so a
 * TLS vhost that serves museum.org and redirects only `www.` (or only "not the canonical host",
 * or `%{HTTPS} off` inside the :443 block) came out redirect-only and was dropped from the APIs
 * candidates (draft.ts chooseVhost) — a blocking "the TLS vhost is missing" on a correct host, or
 * the plain :80 block chosen silently. The closed set that may hold for every request:
 *   - the ACME exception, `%{REQUEST_URI} !…well-known…` (certbot's renewal path: the block serves
 *     only the challenge files, never the site);
 *   - a POSITIVE host test (`%{SERVER_NAME}` / `%{HTTP_HOST}`, `=name` or a regex) only as part of
 *     an [OR] chain that, together, matches the ServerName and every ServerAlias (certbot's
 *     `=museum.org [OR]` + `=www.museum.org`) — judged by groupWholeSite, never alone here;
 *   - a scheme/port test that is true for the block's OWN scheme and ports: `%{HTTPS}` against
 *     on/off from the block's TLS, `%{REQUEST_SCHEME}` against https/http, `%{SERVER_PORT}`
 *     against its `<VirtualHost>` ports (so `%{HTTPS} off` holds on :80 and NEVER on :443).
 * `%{HTTP:X-Forwarded-Proto}` is a request header (a TLS-terminating proxy sets it per request):
 * never whole-site. Anything else selects which requests are redirected.
 */
function conditionAlwaysHolds(args: readonly string[], scope: BlockScope): boolean {
  const variable = (args[0] ?? '').toUpperCase();
  const pattern = args[1] ?? '';
  const nocase = conditionFlags(args).some(flag => flag === 'nc' || flag === 'nocase');
  if (variable === '%{REQUEST_URI}') return pattern.startsWith('!') && pattern.includes('.well-known');
  const values =
    variable === '%{HTTPS}'
      ? [scope.ssl ? 'on' : 'off']
      : variable === '%{REQUEST_SCHEME}'
        ? [scope.ssl ? 'https' : 'http']
        : variable === '%{SERVER_PORT}'
          ? scope.ports
          : null;
  if (values === null || values.length === 0) return false;
  return values.every(value => conditionHolds(pattern, nocase, value) === true);
}

/**
 * A positive host test's names: true when this condition matches `name`. A negated test
 * (`!^museum\.org$`, "not the canonical host") is never counted: it is how a block redirects the
 * names it does NOT serve as its own, while serving the rest.
 */
function hostTestMatches(args: readonly string[], name: string): boolean {
  const variable = (args[0] ?? '').toUpperCase();
  const pattern = args[1] ?? '';
  if ((variable !== '%{SERVER_NAME}' && variable !== '%{HTTP_HOST}') || pattern.startsWith('!')) return false;
  // Host names are case-insensitive (the block's are lower-cased, browsers send them so): compare
  // them so whatever the [NC] flag says.
  return conditionHolds(pattern, true, name) === true;
}

/**
 * One [OR] chain (a lone condition is a chain of one) is true for every request the block serves
 * when one member always holds (conditionAlwaysHolds), or when its positive host tests together
 * match every name the block serves. A wildcard name (`*.museum.org`) or a block without a
 * ServerName cannot be covered by a list of names: the chain selects.
 */
function chainWholeSite(chain: readonly (readonly string[])[], scope: BlockScope): boolean {
  if (chain.some(args => conditionAlwaysHolds(args, scope))) return true;
  if (scope.names.length === 0 || scope.names.some(name => /[*?]/.test(name))) return false;
  return scope.names.every(name => chain.some(args => hostTestMatches(args, name)));
}

/**
 * The conditions of one RewriteRule (they bind to the NEXT rule only) are true for every request
 * the block serves: mod_rewrite ANDs them, except that `[OR]` joins a condition to the next one.
 */
function conditionsWholeSite(conditions: readonly (readonly string[])[], scope: BlockScope): boolean {
  let chain: (readonly string[])[] = [];
  for (const args of conditions) {
    chain.push(args);
    if (conditionFlags(args).some(flag => flag === 'or' || flag === 'ornext')) continue;
    if (!chainWholeSite(chain, scope)) return false;
    chain = [];
  }
  // A trailing [OR] has no right-hand side; mod_rewrite ignores the flag there.
  return chain.length === 0 || chainWholeSite(chain, scope);
}

/** The ports a `<VirtualHost>`'s addresses name (`*:80`, `[::]:443`); null when one names none. */
function virtualHostPorts(addresses: readonly string[]): string[] | null {
  const ports = addresses.map(address => /:(\d+)$/.exec(address)?.[1] ?? null);
  return ports.length > 0 && ports.every((port): port is string => port !== null) ? [...new Set(ports)] : null;
}

/** The guide's (docs/install/publication_host.md step 9) hand-written Dédalo lines. */
const MEDIA_RULES_FILE = /\/dedalo_media_publication\.apache\.conf$/;
const V1_TREE = /\/publication_api\/v1(?:\/|$)/;
const GUIDE_COMMENT = /^\s*#.*(?:media rules|Publication API)/i;

/**
 * Reads the `<VirtualHost>` that starts at `line` (the line `-S` names) to its
 * `</VirtualHost>`. Throws when that line is not a `<VirtualHost` (the file changed since
 * `-S`, or `-S` named an Include's line we cannot attribute).
 */
export function readVhostBlock(text: string, line: number, context: VhostReadContext): VhostBlock {
  const physical = text.split('\n').map(entry => entry.replace(/\r$/, ''));
  const entries = directiveLines(text);
  const startIndex = entries.findIndex(entry => entry.line === line);
  const start = entries[startIndex];
  if (start === undefined || start.kind !== 'open' || start.name !== 'virtualhost') {
    throw new Error(`parse(apache): line ${line} is not a <VirtualHost> (the file changed since -S?)`);
  }
  let endLine = -1;
  let serverName: string | null = null;
  const aliases: string[] = [];
  let sslEngine = false;
  let certificate = false;
  let documentRoot: string | null = null;
  let errorLog: string | null = null;
  const accessLogs: string[] = [];
  let fpmHandler: string | null = null;
  let ourReference = false;
  // Redirect-only: a catch-all redirect to an absolute URL at the block's top level (or inside
  // <IfModule> only — the usual `<IfModule mod_rewrite.c>` wrapper). A redirect inside
  // <Directory>/<Location>/<If> is per-path, so the block still serves.
  let rewriteEngine = false;
  let rewriteConditions: (readonly string[])[] = [];
  let redirectOnly = false;
  // Each catch-all `RewriteRule … [R]` at block level, with the conditions bound to it.
  const catchAllRules: (readonly (readonly string[])[])[] = [];
  const manual = new Set<number>();
  const markRange = (from: number, to: number) => {
    for (let at = from; at <= to; at++) manual.add(at);
  };
  const stack: DirectiveLine[] = [];
  for (let index = startIndex + 1; index < entries.length; index++) {
    const entry = entries[index] as DirectiveLine;
    if (entry.kind === 'close' && entry.name === 'virtualhost' && stack.length === 0) {
      endLine = entry.line;
      break;
    }
    if (entry.kind === 'open') {
      stack.push(entry);
      const path = entry.args[0] ?? '';
      const guideBlock =
        stack.length === 1 &&
        ((entry.name === 'directory' && V1_TREE.test(path)) || (entry.name === 'location' && /\/server_api\/v2\/?$/.test(path)));
      if (guideBlock) {
        // The whole block is manual: find its close at the same depth.
        let depth = 0;
        let close = entry.endLine;
        for (let inner = index + 1; inner < entries.length; inner++) {
          const next = entries[inner] as DirectiveLine;
          if (next.kind === 'open') depth++;
          else if (next.kind === 'close') {
            if (depth === 0) {
              close = next.endLine;
              break;
            }
            depth--;
          }
        }
        markRange(entry.line, close);
      }
      continue;
    }
    if (entry.kind === 'close') {
      stack.pop();
      continue;
    }
    const arg = entry.args[0] ?? '';
    const blockLevel = stack.every(section => section.name === 'ifmodule');
    if (blockLevel) {
      // RewriteCond lines bind to the NEXT RewriteRule only.
      if (entry.name === 'rewritecond') rewriteConditions.push(entry.args);
      else if (entry.name === 'rewriterule') {
        const conditions = rewriteConditions;
        rewriteConditions = [];
        // Judged after the block is read: the conditions are weighed against its names, TLS and ports.
        if (rewriteEngine && wholeSiteRewrite(entry.args)) catchAllRules.push(conditions);
      } else if (entry.name === 'rewriteengine') rewriteEngine = arg.toLowerCase() === 'on';
      else if (wholeSiteRedirect(entry.name, entry.args)) redirectOnly = true;
    }
    switch (entry.name) {
      case 'servername':
        if (stack.length === 0) serverName = arg.replace(/:\d+$/, '').toLowerCase();
        break;
      case 'serveralias':
        if (stack.length === 0) aliases.push(...entry.args.map(name => name.toLowerCase()));
        break;
      case 'sslengine':
        sslEngine ||= arg.toLowerCase() === 'on';
        break;
      case 'sslcertificatefile':
        certificate = true;
        break;
      case 'documentroot':
        if (stack.length === 0) documentRoot = arg;
        break;
      case 'errorlog':
        if (stack.length === 0) errorLog = arg;
        break;
      case 'customlog':
      case 'transferlog':
        if (stack.length === 0) accessLogs.push(arg);
        break;
      case 'include':
      case 'includeoptional':
        if (arg === context.referencePath) ourReference = true;
        else if (MEDIA_RULES_FILE.test(arg)) markRange(entry.line, entry.endLine);
        break;
      case 'alias':
        if (V1_TREE.test(entry.args[1] ?? '')) markRange(entry.line, entry.endLine);
        break;
      case 'sethandler': {
        const socket = fpmSocketOfHandler(arg);
        if (socket !== null && fpmHandler === null && !manual.has(entry.line)) fpmHandler = socket;
        break;
      }
      case 'proxypassmatch': {
        const socket = fpmSocketOfHandler((entry.args[1] ?? '').replace(/^"|"$/g, ''));
        if (socket !== null && fpmHandler === null && !manual.has(entry.line)) fpmHandler = socket;
        break;
      }
    }
  }
  if (endLine === -1) throw new Error(`parse(apache): the <VirtualHost> at line ${line} has no </VirtualHost>`);
  const ssl = sslEngine || certificate;
  const scope: BlockScope = { names: serverName === null ? [] : [serverName, ...aliases], ssl, ports: virtualHostPorts(start.args) };
  if (catchAllRules.some(conditions => conditionsWholeSite(conditions, scope))) redirectOnly = true;
  // The guide's own comment lines directly above a manual block are part of it.
  for (const at of [...manual].sort((a, b) => a - b)) {
    for (let above = at - 1; above > line && !manual.has(above) && GUIDE_COMMENT.test(physical[above - 1] ?? ''); above--) manual.add(above);
  }
  const manualLines = [...manual]
    .filter(at => at > line && at < endLine)
    .sort((a, b) => a - b)
    .map(at => Object.freeze({ line: at, text: physical[at - 1] ?? '' }));
  return Object.freeze({
    line,
    endLine,
    serverName,
    aliases: Object.freeze(aliases),
    ssl,
    documentRoot,
    errorLog,
    accessLogs: Object.freeze(accessLogs),
    fpmHandler,
    ourReference,
    manualLines: Object.freeze(manualLines),
    redirectOnly,
  });
}

/**
 * mod_alias: `Redirect [status] / <absolute URL>`, `RedirectPermanent|RedirectTemp / <URL>`,
 * `RedirectMatch [status] <catch-all regex> <URL>`. `Redirect` matches by prefix, so only `/` is
 * every request.
 */
function wholeSiteRedirect(name: string, args: readonly string[]): boolean {
  const withStatus = args.length === 3;
  if (withStatus && !REDIRECT_STATUS.test(args[0] ?? '')) return false;
  const [path, target] = withStatus ? [args[1] ?? '', args[2] ?? ''] : [args[0] ?? '', args[1] ?? ''];
  if (!isAbsoluteRedirectTarget(target)) return false;
  switch (name) {
    case 'redirect':
      return path === '/';
    case 'redirectpermanent':
    case 'redirecttemp':
      return !withStatus && path === '/';
    case 'redirectmatch':
      return isCatchAllPattern(path);
    default:
      return false;
  }
}

/**
 * mod_rewrite: `RewriteRule <catch-all> <absolute URL> [..R..]`. The R flag is required: without it
 * mod_rewrite strips a substitution naming the current host and serves it internally.
 */
function wholeSiteRewrite(args: readonly string[]): boolean {
  const [pattern = '', target = '', flags = ''] = args;
  if (!isCatchAllPattern(pattern) || !isAbsoluteRedirectTarget(target)) return false;
  const list = /^\[(.*)\]$/.exec(flags)?.[1]?.split(',') ?? [];
  return list.some(flag => /^(?:R|redirect)(?:=.*)?$/i.test(flag.trim()));
}

/* ── matching (security) ─────────────────────────────────────────────────────────── */

export type VhostMatch = 'servername' | 'alias' | 'wildcard' | 'regex';

/** Apache's wildcard names (`*`, `?`), case-insensitive. */
function wildcardMatches(pattern: string, domain: string): boolean {
  if (!/[*?]/.test(pattern)) return false;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(domain);
}

/**
 * How a vhost claims `domain`: its ServerName exactly (the ONLY candidate kind), an alias
 * exactly, or a wildcard name; null when it does not claim it.
 */
export function matchVhost(serverName: string | null, aliases: readonly string[], domain: string): VhostMatch | null {
  const wanted = domain.toLowerCase();
  if (serverName !== null && serverName.toLowerCase() === wanted) return 'servername';
  if (aliases.some(alias => alias.toLowerCase() === wanted)) return 'alias';
  if ([serverName ?? '', ...aliases].some(name => wildcardMatches(name, wanted))) return 'wildcard';
  return null;
}

/** Every block that claims `domain`, with how. */
export function matchVhosts<T extends { readonly serverName: string | null; readonly aliases: readonly string[] }>(
  blocks: readonly T[],
  domain: string,
): { readonly block: T; readonly matchedBy: VhostMatch }[] {
  const out: { block: T; matchedBy: VhostMatch }[] = [];
  for (const block of blocks) {
    const matchedBy = matchVhost(block.serverName, block.aliases, domain);
    if (matchedBy !== null) out.push({ block, matchedBy });
  }
  return out;
}

/* ── versions ────────────────────────────────────────────────────────────────────── */

/** `-v`: `Server version: Apache/2.4.62 (Rocky Linux)` → `2.4.62`; null when absent. */
export function parseApacheVersion(text: string): string | null {
  return /Server version:\s*Apache\/(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null;
}

/** `webVersion(bin)` text → the version, per server (spec §3.2 row Web/FPM versions). */
export function parseWebVersion(server: 'apache' | 'nginx', text: string): string | null {
  return server === 'apache' ? parseApacheVersion(text) : parseNginxVersion(text);
}
