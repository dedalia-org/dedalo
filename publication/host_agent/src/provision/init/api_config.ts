/**
 * THE API CONFIGURATION GRAMMARS (spec §5.8) — v2's `v2.env` and v1's `server_config_api.php`,
 * rendered from the source's own templates (`publication/server_api/v2/.env.example`,
 * `publication/server_api/v1/config_api/sample.server_config_api.php`) by ONE-LINE
 * replacements: every other line of the template is kept byte for byte.
 *
 * The values are database credentials typed on the publication host (D6). So:
 *   - every value passes a closed grammar BEFORE it is placed (a single quote, a backslash and
 *     a dollar sign are refused in a secret — Bun's env loader expands a dollar sign even inside
 *     single quotes —, a dollar sign in a user or database name), and every v2 value is
 *     single-quoted — systemd,
 *     a dotenv loader and parseEnvFile all read `'…'` literally; PHP reads `'…'` literally when
 *     it holds neither `'` nor `\`;
 *   - a refusal names the field and the forbidden CLASS of character, never the value;
 *   - each key must match exactly ONE line of the template (absent or repeated is a refusal:
 *     a template that changed shape is caught here, not at the first request);
 *   - nothing here prints, journals or digests a value (act.ts writes the bytes, root 0600 temp).
 *
 * v2's round trip (`parseEnvFile(rendered)` returns exactly the typed values) is
 * `verifyV2RoundTrip`, with the parser injected: this module stays zero-dependency, the
 * caller (act.ts) passes src/env_file.ts parseEnvFile — the agent package's one env grammar.
 *
 * PURE, ZERO-DEPENDENCY: node: builtins and ../layout only.
 */
import type { WebServer } from '../layout';

/** The v2.env keys init sets (every other template line is kept). */
export const V2_KEYS = Object.freeze(['DB_HOST', 'DB_PORT', 'DB_SOCKET', 'DB_USER', 'DB_PASSWORD', 'DB_NAMES', 'DEPLOYMENT_MODE'] as const);
export type V2Key = (typeof V2_KEYS)[number];

/** The v1 `define()` keys init sets; `$DEFAULT_DDBB` is the one variable. `$db_name` and MYSQL_DEDALO_DATABASE_CONN are never touched. */
export const V1_DEFINE_KEYS = Object.freeze([
  'MYSQL_DEDALO_HOSTNAME_CONN',
  'MYSQL_DEDALO_USERNAME_CONN',
  'MYSQL_DEDALO_PASSWORD_CONN',
  'API_ENTITY',
  'API_WEB_USER_CODE',
  'MYSQL_DEDALO_SOCKET_CONN',
  'MYSQL_DEDALO_DB_PORT_CONN',
] as const);
export const V1_DB_VARIABLE = '$DEFAULT_DDBB';
export const V1_KEYS: readonly string[] = Object.freeze([...V1_DEFINE_KEYS, V1_DB_VARIABLE]);
/**
 * The sample's `define('API_ROOT', dirname(__FILE__, 2));` assumes the config sits in the release's
 * own `config_api/`. On a publication host it lives in `v1/shared/` and is LINKED into every release
 * (D8), and PHP's __FILE__ is the resolved path: API_ROOT became `<state>/publication_api/v1`, every
 * include of `common/` failed and v1 answered "Class manager not found" with HTTP 200 (measured, RHEL
 * 10.2 two-machine drill, 2026-10-09). The entry script (json/index.php, subtitles/index.php: one
 * level below the release root) names the release that runs.
 */
export const V1_API_ROOT_LINE =
  "define('API_ROOT', dirname(get_included_files()[0], 2)); // the release of the entry script: this file lives in shared/, linked into every release";
const V1_API_ROOT_PATTERN = /^(\s*)define\(\s*'API_ROOT'\s*,.*\);.*$/;

/** Lines the v1 render must leave exactly as the template has them. */
export const V1_UNTOUCHED = Object.freeze(['$db_name', 'MYSQL_DEDALO_DATABASE_CONN'] as const);

export const DEPLOYMENT_MODES: readonly (WebServer | 'standalone')[] = Object.freeze(['apache', 'nginx', 'standalone']);

/** The value grammars (spec §5.8). */
export const VALUE_GRAMMARS = Object.freeze({
  host: /^[A-Za-z0-9.-]{1,253}$/,
  socket: /^\/[A-Za-z0-9._/-]{1,200}$/,
  port: /^[0-9]{1,5}$/,
  user: /^[A-Za-z0-9_.@-]{1,80}$/,
  db: /^[A-Za-z0-9_.@-]{1,80}$/,
  entity: /^[A-Za-z0-9_.-]{1,80}$/,
  // Any VISIBLE character, letters of every script included (ñ, ç, ü…): written as UTF-8, read
  // back as the same bytes by PHP, Bun and systemd. Refused: whitespace, control/format/private/
  // unassigned/surrogate code points, every Default_Ignorable (zero-width, variation selector,
  // Hangul filler, CGJ: they render as nothing, so the operator cannot see what was typed), U+FFFD
  // (the mark of a decoding that went wrong — never a key someone pressed), and ' \ $ — the v2 env
  // file is read by three grammars (Bun: `\$` and `$NAME` special even inside single quotes, measured
  // Bun 1.4.4; the agent's parseEnvFile: literal; systemd/`. env`: literal), so no escape means one
  // thing to all.
  secret: /^[^\s\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\uFFFD'\\$]{8,256}$/u,
});
export type ValueClass = keyof typeof VALUE_GRAMMARS;

/** A refusal: the field and what is wrong with it — never the value. */
export class ApiConfigRefused extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`api config: ${field}: ${message}`);
    this.name = 'ApiConfigRefused';
    this.field = field;
  }
}

/** What is wrong with a value, by class, without quoting it. */
function forbiddenClass(value: string): string {
  if (value.length === 0) return 'it is empty';
  if (/[\0]/.test(value)) return 'it contains a NUL byte';
  if (/[\r\n]/.test(value)) return 'it contains a line break';
  if (/\p{Cc}/u.test(value)) return 'it contains a control character';
  if (/\s/.test(value)) return 'it contains whitespace';
  if (value.includes("'")) return "it contains a single quote (')";
  if (value.includes('\\')) return 'it contains a backslash';
  if (value.includes('$')) return "it contains '$'";
  if (value.includes('\uFFFD')) return 'it contains U+FFFD, the replacement character (the input was not read as UTF-8)';
  if (/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(value)) return 'it contains an invisible character (zero-width, variation selector, filler)';
  if (/[\p{Co}\p{Cn}\p{Cs}]/u.test(value)) return 'it contains a private-use, unassigned or broken (lone surrogate) character';
  return 'it contains a character outside its grammar';
}

/** Checks one value against its class. Throws ApiConfigRefused naming the field and the class. */
export function checkValue(field: string, cls: ValueClass, value: unknown): string {
  if (typeof value !== 'string') throw new ApiConfigRefused(field, 'must be text');
  const grammar = VALUE_GRAMMARS[cls];
  if (cls === 'secret') {
    // A dollar sign too: Bun's env-file loader expands $NAME even inside single quotes (measured
    // on Bun 1.4.2 and 1.4.4 — test/unit/publication_host_init_v2_env_native.test.ts): v2 would read another value.
    if (value.includes("'") || value.includes('\\') || value.includes('$')) throw new ApiConfigRefused(field, `${forbiddenClass(value)} — a secret may not hold ', \\ or a dollar sign`);
    // Length in characters (code points), as the grammar counts them: 'ñ' is one, not two.
    const length = [...value].length;
    if (length < 8) throw new ApiConfigRefused(field, 'is shorter than 8 characters');
    if (length > 256) throw new ApiConfigRefused(field, 'is longer than 256 characters');
  }
  if (!grammar.test(value)) throw new ApiConfigRefused(field, `${forbiddenClass(value)} (${cls} grammar ${grammar.source})`);
  if (cls === 'socket' && value.split('/').includes('..')) throw new ApiConfigRefused(field, "must not contain '..'");
  if (cls === 'port') {
    const port = Number(value);
    if (port < 1 || port > 65535) throw new ApiConfigRefused(field, 'must be a port between 1 and 65535');
  }
  return value;
}

/* ── the templates: exactly-one-line replacement ─────────────────────────────────────── */

interface TemplateLines {
  readonly lines: string[];
  /** The line ending the template uses (CRLF preserved). */
  readonly eol: string;
}

function split(template: string): TemplateLines {
  const eol = template.includes('\r\n') ? '\r\n' : '\n';
  return { lines: template.split(eol), eol };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The one line index matching `pattern`; absent or repeated is a refusal naming the key. */
function oneLine(lines: readonly string[], pattern: RegExp, key: string, template: string): number {
  const found = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));
  if (found.length === 0) throw new ApiConfigRefused(key, `the ${template} has no line setting it`);
  if (found.length > 1) throw new ApiConfigRefused(key, `the ${template} sets it on ${found.length} lines (${found.map(i => i + 1).join(', ')}); exactly one is required`);
  return found[0] as number;
}

/* ── v2 ───────────────────────────────────────────────────────────────────────────── */

export interface V2Values {
  readonly host: string;
  readonly port: string;
  /** The unix socket; null for the TCP transport (DB_SOCKET is then rendered empty). */
  readonly socket: string | null;
  readonly user: string;
  readonly password: string;
  /** DB_NAMES: the comma list's members. */
  readonly dbNames: readonly string[];
  readonly deploymentMode: WebServer | 'standalone';
}

/** The validated key → value map v2.env must carry. */
export function v2Assignments(values: V2Values): Readonly<Record<V2Key, string>> {
  if (!Array.isArray(values.dbNames) || values.dbNames.length === 0) throw new ApiConfigRefused('DB_NAMES', 'needs at least one database');
  values.dbNames.forEach((name, index) => checkValue(`DB_NAMES[${index}]`, 'db', name));
  if (new Set(values.dbNames).size !== values.dbNames.length) throw new ApiConfigRefused('DB_NAMES', 'names a database twice');
  if (!DEPLOYMENT_MODES.includes(values.deploymentMode)) {
    throw new ApiConfigRefused('DEPLOYMENT_MODE', `must be one of ${DEPLOYMENT_MODES.join(', ')}`);
  }
  return Object.freeze({
    DB_HOST: checkValue('DB_HOST', 'host', values.host),
    DB_PORT: checkValue('DB_PORT', 'port', values.port),
    DB_SOCKET: values.socket === null ? '' : checkValue('DB_SOCKET', 'socket', values.socket),
    DB_USER: checkValue('DB_USER', 'user', values.user),
    DB_PASSWORD: checkValue('DB_PASSWORD', 'secret', values.password),
    DB_NAMES: values.dbNames.join(','),
    DEPLOYMENT_MODE: values.deploymentMode,
  });
}

/**
 * v2.env from `.env.example`: each V2_KEYS line (`KEY=…`, not a comment) replaced by
 * `KEY='<value>'`; every other line kept.
 */
export function renderV2Env(template: string, values: V2Values): string {
  const assignments = v2Assignments(values);
  const { lines, eol } = split(template);
  for (const key of V2_KEYS) {
    const index = oneLine(lines, new RegExp(`^\\s*(?:export\\s+)?${escapeRegex(key)}\\s*=`), key, 'v2 template (.env.example)');
    lines[index] = `${key}='${assignments[key]}'`;
  }
  return lines.join(eol);
}

/**
 * The round trip (spec §5.8): the env grammar the agent package reads (`parse`, src/env_file.ts
 * parseEnvFile) must return exactly the typed values. Throws ApiConfigRefused naming the key —
 * the caller then writes nothing.
 */
export function verifyV2RoundTrip(
  rendered: string,
  values: V2Values,
  parse: (text: string, path: string) => Record<string, string>,
): void {
  const expected = v2Assignments(values);
  let parsed: Record<string, string>;
  try {
    parsed = parse(rendered, 'v2.env (rendered)');
  } catch {
    throw new ApiConfigRefused('v2.env', 'the rendered file does not parse in the env grammar');
  }
  for (const key of V2_KEYS) {
    if (parsed[key] !== expected[key]) throw new ApiConfigRefused(key, 'does not read back as typed (env grammar round trip)');
  }
}

/* ── v1 ───────────────────────────────────────────────────────────────────────────── */

export interface V1Values {
  readonly host: string;
  readonly user: string;
  readonly password: string;
  readonly entity: string;
  readonly webUserCode: string;
  readonly db: string;
  readonly transport: 'socket' | 'tcp';
  /** Required for the socket transport. */
  readonly socket: string | null;
  /** Required for the TCP transport. */
  readonly port: string | null;
}

function defineLine(key: string): RegExp {
  return new RegExp(`^(\\s*)define\\(\\s*'${escapeRegex(key)}'\\s*,.*\\);\\s*$`);
}

/** The validated v1 values, keyed by what is replaced (a PHP literal per key). */
export function v1Literals(values: V1Values): Readonly<Record<string, string>> {
  if (values.transport !== 'socket' && values.transport !== 'tcp') throw new ApiConfigRefused('transport', "must be 'socket' or 'tcp'");
  const literals: Record<string, string> = {
    MYSQL_DEDALO_HOSTNAME_CONN: `'${checkValue('MYSQL_DEDALO_HOSTNAME_CONN', 'host', values.host)}'`,
    MYSQL_DEDALO_USERNAME_CONN: `'${checkValue('MYSQL_DEDALO_USERNAME_CONN', 'user', values.user)}'`,
    MYSQL_DEDALO_PASSWORD_CONN: `'${checkValue('MYSQL_DEDALO_PASSWORD_CONN', 'secret', values.password)}'`,
    API_ENTITY: `'${checkValue('API_ENTITY', 'entity', values.entity)}'`,
    API_WEB_USER_CODE: `'${checkValue('API_WEB_USER_CODE', 'secret', values.webUserCode)}'`,
    [V1_DB_VARIABLE]: `'${checkValue('$DEFAULT_DDBB', 'db', values.db)}'`,
  };
  if (values.transport === 'socket') {
    literals.MYSQL_DEDALO_SOCKET_CONN = `'${checkValue('MYSQL_DEDALO_SOCKET_CONN', 'socket', values.socket)}'`;
  } else {
    literals.MYSQL_DEDALO_DB_PORT_CONN = String(Number(checkValue('MYSQL_DEDALO_DB_PORT_CONN', 'port', values.port)));
  }
  return Object.freeze(literals);
}

/**
 * server_config_api.php from the sample: API_ROOT from the entry script (V1_API_ROOT_LINE),
 * `define('KEY', <literal>);` for each set key (the
 * socket for the socket transport, the port for TCP — the other stays the sample's `null`),
 * `$DEFAULT_DDBB = '<db>';`. Every other line kept; `$db_name` and MYSQL_DEDALO_DATABASE_CONN
 * untouched. Every define key must match exactly one line even when its value is not set, so a
 * changed sample is caught whichever transport is chosen.
 */
export function renderV1Config(template: string, values: V1Values): string {
  const literals = v1Literals(values);
  const { lines, eol } = split(template);
  for (const key of V1_DEFINE_KEYS) {
    const pattern = defineLine(key);
    const index = oneLine(lines, pattern, key, 'v1 sample (sample.server_config_api.php)');
    const literal = literals[key];
    if (literal === undefined) continue;
    const indent = (pattern.exec(lines[index] as string) as RegExpExecArray)[1] as string;
    lines[index] = `${indent}define('${key}', ${literal});`;
  }
  const rootIndex = oneLine(lines, V1_API_ROOT_PATTERN, 'API_ROOT', 'v1 sample (sample.server_config_api.php)');
  lines[rootIndex] = `${(V1_API_ROOT_PATTERN.exec(lines[rootIndex] as string) as RegExpExecArray)[1] as string}${V1_API_ROOT_LINE}`;
  const dbPattern = /^(\s*)\$DEFAULT_DDBB\s*=.*;\s*$/;
  const dbIndex = oneLine(lines, dbPattern, V1_DB_VARIABLE, 'v1 sample (sample.server_config_api.php)');
  const indent = (dbPattern.exec(lines[dbIndex] as string) as RegExpExecArray)[1] as string;
  lines[dbIndex] = `${indent}$DEFAULT_DDBB = ${literals[V1_DB_VARIABLE]};`;
  return lines.join(eol);
}
