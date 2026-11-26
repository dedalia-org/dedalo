/**
 * DISCOVERY: nginx (spec §3.2 rows nginx, Web run user, Web versions; §4.3 `web.vhost`,
 * `web.manual_lines`, `web.nginx_manual_map`, `web.nginx_map`; §13.6).
 *
 * The one text is `nginx -T` (provisionExec nginxDump): the syntax verdict, then every loaded
 * file as `# configuration file <path>:` followed by its bytes, each file ONCE (a file included
 * from several places is printed the first time). splitNginxT cuts it back into files;
 * tokenizeNginx + parseNginx build each file's directive tree; expandIncludes splices every
 * `include` (glob, relative to the main file's directory) with the dumped files it matches,
 * keeping the include node, so a walker knows both what is loaded and where the include
 * stood. The dump lives in observe.ts's memory only and never leaves it.
 *
 * PURE, ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts): node:path, ../types and ./redirect only.
 */
import { dirname, isAbsolute, join } from 'node:path';
import type { MapDef } from '../types';
import { isAbsoluteRedirectTarget, isCatchAllPattern } from './redirect';

/* ── -T → files ──────────────────────────────────────────────────────────────────── */

export interface DumpedFile {
  readonly file: string;
  readonly text: string;
}

/** `nginx -T` → the dumped files, in dump order (the main file first). */
export function splitNginxT(text: string): DumpedFile[] {
  const out: { file: string; lines: string[] }[] = [];
  for (const raw of text.split('\n')) {
    const header = /^# configuration file (\/.+):$/.exec(raw.replace(/\r$/, ''));
    if (header) {
      out.push({ file: header[1] as string, lines: [] });
      continue;
    }
    out[out.length - 1]?.lines.push(raw);
  }
  return out.map(entry => Object.freeze({ file: entry.file, text: entry.lines.join('\n') }));
}

/* ── tokens and the tree ─────────────────────────────────────────────────────────── */

export interface NginxToken {
  readonly kind: 'word' | '{' | '}' | ';';
  /** A word's value, quotes removed and escapes resolved. */
  readonly value: string;
  readonly line: number;
}

/**
 * ngx_conf_read_token's escapes: a `\` makes the next character part of the word; when the
 * word is copied, `\"`, `\'` and `\\` lose the backslash, `\t`/`\r`/`\n` become the control
 * character, and any other pair KEEPS its backslash (`~^www\d+\.x$` stays a regex).
 */
function unescape(next: string): string {
  if (next === '"' || next === "'" || next === '\\') return next;
  if (next === 't') return '\t';
  if (next === 'r') return '\r';
  if (next === 'n') return '\n';
  return `\\${next}`;
}

/** nginx's lexer: words (quoted or bare, `\` escapes as nginx copies them), `{`, `}`, `;`; a `#` at a token start runs to the line end. */
export function tokenizeNginx(text: string): NginxToken[] {
  const tokens: NginxToken[] = [];
  let line = 1;
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '\n') {
      line++;
      index++;
      continue;
    }
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (char === '{' || char === '}' || char === ';') {
      tokens.push({ kind: char, value: char, line });
      index++;
      continue;
    }
    const start = line;
    let value = '';
    if (char === '"' || char === "'") {
      const quote = char;
      index++;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\' && index + 1 < text.length) {
          value += unescape(text[index + 1] as string);
          index += 2;
          continue;
        }
        if (text[index] === '\n') line++;
        value += text[index];
        index++;
      }
      if (index >= text.length) throw new Error(`parse(nginx): unterminated ${quote} string starting at line ${start}`);
      index++;
    } else {
      while (index < text.length && !/[\s{};]/.test(text[index] as string)) {
        if (text[index] === '\\' && index + 1 < text.length) {
          value += unescape(text[index + 1] as string);
          index += 2;
          continue;
        }
        value += text[index];
        index++;
      }
    }
    tokens.push({ kind: 'word', value, line: start });
  }
  return tokens;
}

export interface NginxDirective {
  readonly name: string;
  readonly args: readonly string[];
  readonly file: string;
  readonly line: number;
  /** The line of the closing `}` (a block) or of the `;`. */
  readonly endLine: number;
  /** The block's children; null for a simple directive. */
  readonly block: readonly NginxDirective[] | null;
  /** For `include`: the parsed directives of the files it matched (expandIncludes); else empty. */
  readonly included: readonly NginxDirective[];
}

/** One file's directive tree. Throws on unbalanced braces or a directive without `;`. */
export function parseNginx(text: string, file: string): NginxDirective[] {
  const tokens = tokenizeNginx(text);
  let position = 0;
  const parseBlock = (depth: number): NginxDirective[] => {
    const out: NginxDirective[] = [];
    while (position < tokens.length) {
      const token = tokens[position] as NginxToken;
      if (token.kind === '}') {
        if (depth === 0) throw new Error(`parse(nginx): ${file}:${token.line}: unexpected '}'`);
        return out;
      }
      if (token.kind !== 'word') throw new Error(`parse(nginx): ${file}:${token.line}: unexpected '${token.value}'`);
      const name = token.value;
      const args: string[] = [];
      position++;
      for (;;) {
        const next = tokens[position];
        if (next === undefined) throw new Error(`parse(nginx): ${file}:${token.line}: '${name}' has no ';' or '{'`);
        if (next.kind === 'word') {
          args.push(next.value);
          position++;
          continue;
        }
        if (next.kind === ';') {
          out.push(Object.freeze({ name, args: Object.freeze(args), file, line: token.line, endLine: next.line, block: null, included: Object.freeze([]) }));
          position++;
          break;
        }
        if (next.kind === '{') {
          position++;
          const children = parseBlock(depth + 1);
          const close = tokens[position];
          if (close === undefined || close.kind !== '}') throw new Error(`parse(nginx): ${file}:${token.line}: '${name}' block is not closed`);
          position++;
          out.push(Object.freeze({ name, args: Object.freeze(args), file, line: token.line, endLine: close.line, block: Object.freeze(children), included: Object.freeze([]) }));
          break;
        }
        throw new Error(`parse(nginx): ${file}:${next.line}: unexpected '}' inside '${name}'`);
      }
    }
    if (depth > 0) throw new Error(`parse(nginx): ${file}: a block is not closed at the end of the file`);
    return out;
  };
  return parseBlock(0);
}

/* ── includes ────────────────────────────────────────────────────────────────────── */

/** nginx's include glob (glob(3): `*`, `?`, `[…]`) as a RegExp over a whole path. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] as string;
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const close = glob.indexOf(']', index + 1);
      if (close === -1) source += '\\[';
      else {
        source += `[${glob.slice(index + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        index = close;
      }
    } else source += char.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

const INCLUDE_DEPTH_CAP = 16;

/**
 * The main file's tree with every `include` filled from the dump (sorted matches, as nginx's
 * glob does). A path is relative to the main file's directory (nginx's conf prefix).
 */
export function expandIncludes(files: readonly DumpedFile[]): NginxDirective[] {
  const main = files[0];
  if (main === undefined) return [];
  const prefix = dirname(main.file);
  const parsed = new Map<string, NginxDirective[]>();
  const tree = (file: DumpedFile): NginxDirective[] => {
    let found = parsed.get(file.file);
    if (found === undefined) {
      found = parseNginx(file.text, file.file);
      parsed.set(file.file, found);
    }
    return found;
  };
  const expand = (directives: readonly NginxDirective[], depth: number): NginxDirective[] =>
    directives.map(directive => {
      if (directive.name === 'include' && directive.block === null) {
        if (depth >= INCLUDE_DEPTH_CAP) throw new Error(`parse(nginx): includes nest deeper than ${INCLUDE_DEPTH_CAP} at ${directive.file}:${directive.line}`);
        const pattern = directive.args[0] ?? '';
        const absolute = isAbsolute(pattern) ? pattern : join(prefix, pattern);
        const matcher = globToRegExp(absolute);
        const matched = files.filter(file => matcher.test(file.file)).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
        const included = matched.flatMap(file => expand(tree(file), depth + 1));
        return Object.freeze({ ...directive, included: Object.freeze(included) });
      }
      if (directive.block !== null) return Object.freeze({ ...directive, block: Object.freeze(expand(directive.block, depth)) });
      return directive;
    });
  return expand(tree(main), 0);
}

/** The directives of one context with every include spliced in place (the include node itself kept first). */
function flatten(directives: readonly NginxDirective[]): NginxDirective[] {
  const out: NginxDirective[] = [];
  for (const directive of directives) {
    out.push(directive);
    if (directive.included.length > 0) out.push(...flatten(directive.included));
  }
  return out;
}

/** Every directive anywhere below `directives` (blocks and includes), depth-first. */
function walk(directives: readonly NginxDirective[], visit: (directive: NginxDirective, parents: readonly NginxDirective[]) => void, parents: NginxDirective[] = []): void {
  for (const directive of flatten(directives)) {
    visit(directive, parents);
    if (directive.block !== null) walk(directive.block, visit, [...parents, directive]);
  }
}

/** The `http {}` block of the main context, or null. */
export function findHttpBlock(tree: readonly NginxDirective[]): NginxDirective | null {
  return flatten(tree).find(directive => directive.name === 'http' && directive.block !== null) ?? null;
}

/**
 * Whether a file named `<confD>/<name>` would be loaded INSIDE http{} — some `include` of the
 * http context (not of a server) matches it (§13.6: init sets `web.nginx_map = conf_d` then).
 * null when there is no http block.
 */
export function confDIncludedInHttp(tree: readonly NginxDirective[], confD: string, name: string): boolean | null {
  const http = findHttpBlock(tree);
  if (http === null || http.block === null) return null;
  const prefix = http.file === '' ? '/' : dirname(http.file);
  const target = join(confD, name);
  return flatten(http.block).some(directive => {
    if (directive.name !== 'include') return false;
    const pattern = directive.args[0] ?? '';
    return globToRegExp(isAbsolute(pattern) ? pattern : join(prefix, pattern)).test(target);
  });
}

/** The main context's `user` (nginx's worker account), or null (nginx's compiled-in default then applies). */
export function nginxRunUser(tree: readonly NginxDirective[]): { readonly user: string; readonly group: string | null } | null {
  const directive = flatten(tree).find(entry => entry.name === 'user');
  if (directive === undefined) return null;
  return Object.freeze({ user: directive.args[0] ?? '', group: directive.args[1] ?? null });
}

/** Every `map <source> <$variable> {…}` defining one of `vars` (§4.3 web.nginx_manual_map). */
export function findMapDefinitions(tree: readonly NginxDirective[], vars: readonly string[]): MapDef[] {
  const out: MapDef[] = [];
  walk(tree, directive => {
    if (directive.name === 'map' && directive.block !== null && vars.includes(directive.args[1] ?? '')) {
      out.push(Object.freeze({ file: directive.file, line: directive.line, variable: directive.args[1] as string }));
    }
  });
  return out;
}

/* ── server blocks ───────────────────────────────────────────────────────────────── */

export interface NginxListen {
  /**
   * The address part, as written: `*` for a bare port (nginx binds 0.0.0.0 — IPv4 only),
   * `[::]` / `[2001:db8::1]` (IPv6, bracketed), `127.0.0.1`, `localhost`. observe.ts keeps every
   * address of one port on ONE vhost row (a dual-stack `listen 443; listen [::]:443;` is one site).
   */
  readonly address: string;
  readonly port: number;
  readonly ssl: boolean;
  readonly defaultServer: boolean;
}

/** `listen 443 ssl http2` / `[::]:443 ssl` / `127.0.0.1:8080` / `80 default_server`; null for a unix socket. */
export function parseListen(args: readonly string[]): NginxListen | null {
  const spec = args[0] ?? '';
  if (spec.startsWith('unix:')) return null;
  let address: string;
  let port: string | null;
  const withPort = /^(.+):(\d{1,5})$/.exec(spec);
  if (withPort) {
    address = withPort[1] as string;
    port = withPort[2] as string;
  } else if (/^\d{1,5}$/.test(spec)) {
    address = '*';
    port = spec;
  } else {
    // An address without a port (`localhost`, `127.0.0.1`) listens on 80.
    address = spec;
    port = /^[\w.-]+$/.test(spec) ? '80' : null;
  }
  if (port === null) throw new Error(`parse(nginx): listen '${spec}' has no port`);
  return Object.freeze({
    address,
    port: Number(port),
    ssl: args.includes('ssl') || args.includes('quic'),
    defaultServer: args.includes('default_server') || args.includes('default'),
  });
}

export interface NginxServerContext {
  /** Our stamped reference's include argument (`<configBase>/<instance>/web.nginx.con[f]`). */
  readonly referenceInclude: string;
}

export interface NginxServer {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly names: readonly string[];
  readonly listens: readonly NginxListen[];
  readonly root: string | null;
  readonly errorLog: string | null;
  readonly accessLogs: readonly string[];
  /** The FPM socket of the server's own fastcgi_pass (an upstream name resolved), not a guide-style one. */
  readonly fpmHandler: string | null;
  readonly ourReference: boolean;
  readonly manualLines: readonly { readonly line: number; readonly text: string }[];
  /**
   * The server answers every request with a redirect to an absolute URL, decided at the server's
   * own level (not inside `if`/`location`, which select): `return 301|302|303|307|308 <URL>`,
   * `return <http(s) URL>`, or `rewrite <catch-all> <absolute URL> …`. A server-level `return` runs
   * before any location is chosen, so it holds whatever locations follow. Never an APIs candidate.
   */
  readonly redirectOnly: boolean;
}

const REDIRECT_CODES = new Set(['301', '302', '303', '307', '308']);

/** One server-level directive that redirects every request away (see NginxServer.redirectOnly). */
function wholeServerRedirect(directive: NginxDirective): boolean {
  if (directive.name === 'return') {
    const [code = '', target] = directive.args;
    // `return <URL>` (one argument) is a 302 when the URL starts with http://, https:// or $scheme.
    if (target === undefined) return isAbsoluteRedirectTarget(code);
    return REDIRECT_CODES.has(code) && isAbsoluteRedirectTarget(target);
  }
  if (directive.name === 'rewrite') {
    const [pattern = '', target = ''] = directive.args;
    // An absolute replacement redirects whatever the flag (nginx: http://, https://, $scheme).
    return isCatchAllPattern(pattern) && isAbsoluteRedirectTarget(target);
  }
  return false;
}

const MEDIA_RULES_INCLUDE = /\/dedalo_media_publication\.nginx\.conf$/;
const GUIDE_LOCATION = /\/server_api\/v[12]\/?$/;

/** Every `server {}` inside http{} with what compare needs. `files` gives the manual lines' text. */
export function findServers(tree: readonly NginxDirective[], files: readonly DumpedFile[], context: NginxServerContext): NginxServer[] {
  const http = findHttpBlock(tree);
  if (http === null || http.block === null) return [];
  const upstreams = new Map<string, string>();
  for (const directive of flatten(http.block)) {
    if (directive.name !== 'upstream' || directive.block === null) continue;
    const server = flatten(directive.block).find(entry => entry.name === 'server' && (entry.args[0] ?? '').startsWith('unix:'));
    if (server) upstreams.set(directive.args[0] ?? '', (server.args[0] as string).slice('unix:'.length));
  }
  const text = new Map(files.map(file => [file.file, file.text.split('\n')]));
  const lineText = (file: string, line: number): string => (text.get(file)?.[line - 1] ?? '').replace(/\r$/, '');
  const servers: NginxServer[] = [];
  for (const server of flatten(http.block)) {
    if (server.name !== 'server' || server.block === null) continue;
    const names: string[] = [];
    const listens: NginxListen[] = [];
    let root: string | null = null;
    let errorLog: string | null = null;
    const accessLogs: string[] = [];
    let fpmHandler: string | null = null;
    let ourReference = false;
    let sslOn = false;
    let redirectOnly = false;
    const manual = new Map<string, Set<number>>();
    const mark = (file: string, from: number, to: number) => {
      const set = manual.get(file) ?? new Set<number>();
      for (let at = from; at <= to; at++) set.add(at);
      manual.set(file, set);
    };
    walk(server.block, (directive, parents) => {
      const top = parents.length === 0;
      const insideManual = parents.some(parent => parent.name === 'location' && GUIDE_LOCATION.test(parent.args[parent.args.length - 1] ?? ''));
      if (top && wholeServerRedirect(directive)) redirectOnly = true;
      switch (directive.name) {
        case 'server_name':
          if (top) names.push(...directive.args.map(name => name.toLowerCase()));
          break;
        case 'listen':
          if (top) {
            const parsed = parseListen(directive.args);
            if (parsed) listens.push(parsed);
          }
          break;
        case 'ssl':
          if (top && directive.args[0] === 'on') sslOn = true;
          break;
        case 'root':
          if (top) root = directive.args[0] ?? null;
          break;
        case 'error_log':
          if (top) errorLog = directive.args[0] ?? null;
          break;
        case 'access_log':
          if (top && directive.args[0] !== 'off') accessLogs.push(directive.args[0] ?? '');
          break;
        case 'include': {
          const target = directive.args[0] ?? '';
          if (target === context.referenceInclude) ourReference = true;
          else if (MEDIA_RULES_INCLUDE.test(target)) mark(directive.file, directive.line, directive.endLine);
          break;
        }
        case 'location':
          if (parents.length === 0 && GUIDE_LOCATION.test(directive.args[directive.args.length - 1] ?? '')) {
            mark(directive.file, directive.line, directive.endLine);
          }
          break;
        case 'fastcgi_pass': {
          if (insideManual || fpmHandler !== null) break;
          const target = directive.args[0] ?? '';
          fpmHandler = target.startsWith('unix:') ? target.slice('unix:'.length) : (upstreams.get(target) ?? null);
          break;
        }
      }
    });
    const listen = listens.length > 0 ? listens : [Object.freeze({ address: '*', port: 80, ssl: false, defaultServer: false })];
    const manualLines = (manual.get(server.file) ? [...(manual.get(server.file) as Set<number>)] : [])
      .filter(at => at > server.line && at < server.endLine)
      .sort((a, b) => a - b)
      .map(at => Object.freeze({ line: at, text: lineText(server.file, at) }));
    servers.push(
      Object.freeze({
        file: server.file,
        line: server.line,
        endLine: server.endLine,
        names: Object.freeze(names),
        listens: Object.freeze(listen.map(entry => (sslOn ? Object.freeze({ ...entry, ssl: true }) : entry))),
        root,
        errorLog,
        accessLogs: Object.freeze(accessLogs),
        fpmHandler,
        ourReference,
        manualLines: Object.freeze(manualLines),
        redirectOnly,
      }),
    );
  }
  return servers;
}

/**
 * How a server's `server_name` list claims `domain`: an exact name; a wildcard (`*.x`, `x.*`,
 * `.x` — which also matches `x` itself); a regex (`~…`; one this engine cannot compile counts
 * as a claim: it may match); null when none does.
 */
export function matchServerNames(names: readonly string[], domain: string): 'servername' | 'wildcard' | 'regex' | null {
  const wanted = domain.toLowerCase();
  if (names.some(name => name === wanted)) return 'servername';
  for (const name of names) {
    if (name.startsWith('.') && (wanted === name.slice(1) || wanted.endsWith(name))) return 'wildcard';
    if (name.startsWith('*.') && wanted.endsWith(name.slice(1))) return 'wildcard';
    if (name.endsWith('.*') && wanted.startsWith(name.slice(0, -1))) return 'wildcard';
  }
  for (const name of names) {
    if (!name.startsWith('~')) continue;
    try {
      if (new RegExp(name.slice(1), 'i').test(wanted)) return 'regex';
    } catch {
      return 'regex';
    }
  }
  return null;
}

/** `nginx -v` (on stderr): `nginx version: nginx/1.20.1` → `1.20.1`; null when absent. */
export function parseNginxVersion(text: string): string | null {
  return /nginx version:\s*nginx\/(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null;
}
