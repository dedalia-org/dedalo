/**
 * THE REPORT (spec §1.2 TTY, §4.1) — what `provision init` prints before it acts: three lists,
 * rendered WHOLE before the first journal `begin`:
 *   1. already right — nothing to do;
 *   2. will change   — the exact commands and the (redacted) diffs;
 *   3. needs your decision — one block per item, its options (the default marked; whether Enter
 *      takes it is decision_class.ts's rule, stated beside a `typed` decision);
 *   4. needs your action — the decisions whose every option is `manual` (decision_class.ts
 *      `needs_action`): init can do nothing about them, so they are not asked; their facts and
 *      commands are what the operator does. Printed only when there is one, and only for a run on
 *      a terminal: `needs_action` is applied on interactive runs only (decision_class.ts — `--yes`
 *      resolves no decision), so WITHOUT a terminal they stay in list 3, open decisions answered
 *      by `--decide <id>=<manual option>`, exactly as run.ts then refuses them. Before (review
 *      lane A) list 4 said "they are not asked" and the --yes refusal said "need your decision".
 * Then, after acting, the outcomes, what is still to do, and the "needs your action" summary with
 * the re-run command (renderNeedsAction).
 *
 * THE OUTPUT LAW (spec §1.2, §8 row Output): every line init prints passes
 *   redactLine (on text that came from an operator file: diffs and facts) → sanitizeLine → the
 *   cli.ts `guarded` sink (the caller's). redactLine replaces the VALUE of every directive that
 *   can carry a credential (SetEnv/PassEnv/SetEnvIf, env[...], php_value/php_admin_value with a
 *   credential-shaped key, fastcgi_param, proxy_set_header/RequestHeader naming Authorization or
 *   Cookie, any KEY/TOKEN/SECRET/PASS assignment) with REDACTED, which is short on purpose: the
 *   guard refuses a credential-shaped assignment of 8 characters or more, and the placeholder
 *   must never trip it. sanitizeLine strips C0/C1 controls (`\n` aside) and ESC sequences
 *   (CSI, OSC — OSC 52 writes the clipboard —, DCS, single-character escapes), so an operator
 *   file, a child's output or a log line cannot drive the terminal.
 *
 * PURE, ZERO-DEPENDENCY (tests/provision_zero_dep.test.ts): node: builtins, ./types and ./decision_class only.
 */
import { classifyDecision } from './decision_class';
import type { Item } from './types';

/** What a redacted value becomes. Three characters: below the guard's 8-character secret floor. */
export const REDACTED = '***';

/* ── sanitize ─────────────────────────────────────────────────────────────────────── */

/** ESC sequences: CSI (`ESC [ … final`), OSC/DCS/APC/PM/SOS (`ESC ] … BEL|ST`), and two-byte escapes. */
const ESCAPE_SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[ -/]*[0-~]?/g;
/** C0 controls except `\n`, DEL, and the C1 range (U+0080–U+009F, which includes the 8-bit CSI/OSC introducers). */
const CONTROLS = /[\x00-\x09\x0b-\x1f\x7f\x80-\x9f]/g;

/**
 * One line made inert for a terminal: ESC sequences removed first (their parameters with them),
 * a tab becomes one space (a vhost indents with tabs; gluing words would misreport a diff), then
 * every other control is removed.
 */
export function sanitizeLine(line: string): string {
  return line.replace(ESCAPE_SEQUENCES, '').replace(/\t/g, ' ').replace(CONTROLS, '');
}

/* ── redact ───────────────────────────────────────────────────────────────────────── */

/** A name that may hold a credential. */
const CREDENTIAL_NAME = /(KEY|TOKEN|SECRET|PASS|PWD|AUTH|COOKIE|CREDENTIAL)/i;

interface Rule {
  readonly pattern: RegExp;
  readonly replace: (...groups: string[]) => string;
}

/**
 * The redaction rules, applied in order to one line. Each keeps the directive and its NAME (an
 * operator recognises the line) and replaces only the value. Patterns are unanchored on the left
 * so a unified-diff prefix (`+`, `-`, ` `) or indentation never hides a line.
 */
const RULES: readonly Rule[] = Object.freeze([
  // Apache: SetEnv NAME value / PassEnv NAME… / SetEnvIf attr regex env[=value]…
  { pattern: /\b(SetEnv)(\s+)(\S+)(\s+)(.+)$/i, replace: (_m, d, s1, name, s2) => `${d}${s1}${name}${s2}${REDACTED}` },
  { pattern: /\b(SetEnvIf(?:NoCase)?|PassEnv)(\s+)(.+)$/i, replace: (_m, d, s1) => `${d}${s1}${REDACTED}` },
  // PHP-FPM pools: env[NAME] = value
  { pattern: /\b(env\[[^\]\r\n]*\])(\s*=\s*)(.*)$/i, replace: (_m, key, eq) => `${key}${eq}${REDACTED}` },
  // php_value / php_admin_value / php_flag … with a credential-shaped key (FPM `[key] = v` or Apache `key v`).
  {
    pattern: /\b(php_(?:admin_)?(?:value|flag))(\[[^\]\r\n]*\]\s*=\s*|\s+\S+\s+)(.+)$/i,
    replace: (m, d, key) => (CREDENTIAL_NAME.test(key) ? `${d}${key}${REDACTED}` : m),
  },
  // nginx: every fastcgi_param value (they carry DB credentials in hand-written vhosts).
  { pattern: /\b(fastcgi_param)(\s+)(\S+)(\s+)([^;]*)(;?.*)$/i, replace: (_m, d, s1, name, s2, _v, tail) => `${d}${s1}${name}${s2}${REDACTED}${tail.startsWith(';') ? ';' : ''}` },
  // proxy_set_header / RequestHeader / Header naming Authorization or Cookie.
  {
    pattern: /\b(proxy_set_header|RequestHeader|Header)(\s+(?:(?:set|append|add|merge|setifempty|edit\*?|always|onsuccess)\s+)*)(Authorization|Proxy-Authorization|Cookie|Set-Cookie)(\s+)(.+)$/i,
    replace: (_m, d, mid, name, s) => `${d}${mid}${name}${s}${REDACTED}`,
  },
  // Any KEY/TOKEN/SECRET/PASS-shaped name assigned with '=' or ':' (shell, env files, JSON, define()).
  {
    pattern: /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)(\1)(\s*[=:]\s*|['"]\s*,\s*)("[^"]*"|'[^']*'|[^\s,;)]+)/g,
    replace: (m, q, name, q2, sep) => (CREDENTIAL_NAME.test(name) ? `${q}${name}${q2}${sep}${REDACTED}` : m),
  },
]);

/** One line with every credential-carrying value replaced by REDACTED (spec §1.2). */
export function redactLine(line: string): string {
  let out = line;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: string[]) => string);
  return out;
}

/* ── the three lists ──────────────────────────────────────────────────────────────── */

export interface RenderOptions {
  /** The answers already given (`--decide` and typed): shown beside their decision. */
  readonly answers?: ReadonlyMap<string, string>;
  /**
   * The run has a terminal (run.ts: the prompter's, not `--dry-run`'s — a dry run on a terminal
   * previews the interactive run). Required: whether a manual-only decision is "needs your action"
   * (list 4) or an open decision (list 3) depends on it, so no caller may leave it implicit.
   */
  readonly interactive: boolean;
}

/** Text from an operator file or a host fact: redacted, then sanitized. */
function factLine(text: string): string {
  return sanitizeLine(redactLine(text));
}

function bullet(prefix: string, text: string): string[] {
  return factLine(text)
    .split('\n')
    .map((line, index) => `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`);
}

function itemLines(item: Item, answers: ReadonlyMap<string, string>, interactive: boolean): string[] {
  const lines: string[] = [];
  const flags = [item.blocking ? 'blocking' : null, item.optional ? 'optional' : null, item.hostWide ? 'host-wide' : null, item.operatorFile ? 'edits your file' : null]
    .filter((flag): flag is string => flag !== null);
  lines.push(`  [${item.id}] ${sanitizeLine(item.title)}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`);
  for (const fact of item.facts) lines.push(...bullet('      - ', fact));
  for (const command of item.commands) lines.push(`      $ ${sanitizeLine(command)}`);
  if (item.diff !== undefined) {
    lines.push(`      diff ${sanitizeLine(item.diff.path)}:`);
    for (const line of item.diff.unified.replace(/\n$/, '').split('\n')) lines.push(`        ${factLine(line)}`);
  }
  if (item.list === 'decision' && item.options !== undefined) {
    const { kind, enter } = classifyDecision(item);
    if (kind === 'needs_action' && interactive) {
      lines.push('      init cannot do this: do it by hand (the commands above), then run init again');
      return lines;
    }
    const answered = answers.get(item.id);
    for (const option of item.options) {
      const marks = [option.id === item.defaultOption ? 'default' : null, option.id === answered ? 'answered' : null].filter(Boolean);
      lines.push(`      ${option.id}: ${sanitizeLine(option.label)}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`);
    }
    if (kind === 'typed') lines.push('      type the option: this changes your files or the whole host, so Enter takes nothing');
    if (kind === 'needs_action') {
      lines.push(`      init cannot do this: do it by hand (the commands above), then run init again; without a terminal it stays open until --decide ${item.id}=${enter ?? 'manual'}`);
    }
  }
  return lines;
}

/** A decision init can do nothing about (decision_class.ts needs_action) — list 4 only on a terminal. */
function needsAction(item: Item, interactive: boolean): boolean {
  return interactive && item.list === 'decision' && classifyDecision(item).kind === 'needs_action';
}

/**
 * The report before acting (spec §1.2): list 1, list 2 with its commands and redacted diffs, list
 * 3 with the options. The `declaration.fields` lines are part of list 1.
 */
export function renderLists(items: readonly Item[], options: RenderOptions): string[] {
  const answers = options.answers ?? new Map<string, string>();
  const interactive = options.interactive;
  const right = items.filter(item => item.list === 'right');
  const change = items.filter(item => item.list === 'change');
  const decision = items.filter(item => item.list === 'decision' && !needsAction(item, interactive));
  const action = items.filter(item => needsAction(item, interactive));
  const lines: string[] = [];
  lines.push(`1. already right (${right.length})`);
  for (const item of right) lines.push(...itemLines(item, answers, interactive));
  lines.push(`2. will change (${change.length})`);
  for (const item of change) lines.push(...itemLines(item, answers, interactive));
  lines.push(`3. needs your decision (${decision.length})`);
  for (const item of decision) lines.push(...itemLines(item, answers, interactive));
  if (action.length > 0) {
    lines.push(`4. needs your action (${action.length}) — init cannot do these; they are not asked`);
    for (const item of action) lines.push(...itemLines(item, answers, interactive));
  }
  return lines;
}

/** One summary line per list (the count the confirmation question quotes); `interactive` as RenderOptions. */
export function countLine(items: readonly Item[], interactive: boolean): string {
  const count = (list: Item['list']) => items.filter(item => item.list === list && !needsAction(item, interactive)).length;
  const action = items.filter(item => needsAction(item, interactive)).length;
  return `${count('right')} right, ${count('change')} to change, ${count('decision')} to decide${action > 0 ? `, ${action} need your action` : ''}`;
}

/**
 * The end of a run that left `needs_action` decisions (run.ts): each with its facts and commands
 * (redacted and sanitized like the report), then the one command that runs init again.
 */
export function renderNeedsAction(items: readonly Item[], rerun: string): string[] {
  if (items.length === 0) return [];
  const lines = [`needs your action (${items.length}) — init cannot do these; do them, then run init again:`];
  for (const item of items) {
    lines.push(`  [${item.id}] ${sanitizeLine(item.title)}`);
    for (const fact of item.facts) lines.push(...bullet('      - ', fact));
    for (const command of item.commands) lines.push(`      $ ${sanitizeLine(command)}`);
  }
  lines.push(`then re-run: ${sanitizeLine(rerun)}`);
  return lines;
}
