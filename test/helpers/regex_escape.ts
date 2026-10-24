/**
 * ESCAPES FOR BUILT PATTERNS — the one place a gate, a drill or a script turns a
 * literal into a RegExp source, a SQL LIKE pattern or a Markdown table cell.
 *
 * The tree used to hand-roll each escape at the call site — `x.replace(/\./g,
 * '\\.')`, `/[@.]/g`, `/[$]/g`, `/_/g` — each escaping only the metacharacters its
 * author expected in today's input and never the backslash itself, so the escape
 * is wrong the day the input grows one (CodeQL js/incomplete-sanitization, ~35
 * sites). One complete escape per target language, backslash first-class.
 *
 * CONFIG-FREE (no imports): scripts and test helpers alike can use it.
 */

/**
 * Escape `text` for use as a LITERAL inside a RegExp source: every syntax
 * character (`\ ^ $ . * + ? ( ) [ ] { } |`) gets a backslash. `/` and `-` are
 * left alone — neither is special in a RegExp source outside a class, so a
 * path's escape equals the dot-only escape the engine's SELinux spec emits
 * (asserted by the gates that compare against it).
 */
export function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Escape `text` for use as a LITERAL inside a SQL `LIKE` pattern with the
 * default `\` escape character: `\`, `%` and `_` each get a backslash.
 */
export function escapeLikePattern(text: string): string {
	return text.replace(/[\\%_]/g, '\\$&');
}

/** Escape `text` for one Markdown table cell: `\` and `|` escaped, newlines folded to a space. */
export function escapeMarkdownCell(text: string): string {
	return text.replace(/[\\|]/g, '\\$&').replace(/\s*\n\s*/g, ' ');
}
