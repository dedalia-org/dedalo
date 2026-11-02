/**
 * MOCK ISOLATION — `bun test` shares ONE process, so a module mock and a global
 * stub are not scoped to the file that installs them.
 *
 * WHY THIS EXISTS (measured 2026-08-21). Two files were quietly corrupting
 * every other file in the tier, and neither of the victims mocked anything:
 *
 *   - `client_upload_queue_render` replaced `globalThis.URL` with a plain
 *     object carrying `createObjectURL`/`revokeObjectURL`. A plain object is
 *     NOT a constructor, so every `new URL(...)` elsewhere in the process threw
 *     "Object is not a constructor". The visible symptom was
 *     `external_transport_native` reporting `bad_config` where it asserts
 *     `blocked_host` — a SECURITY gate naming the wrong reason for a refusal,
 *     in a file that touches no globals at all.
 *   - `client_tm_list_destroy_race` mocked `events.js` with only the one export
 *     it uses. `mock.module` is process-global, so the module was TRUNCATED for
 *     everyone: another file importing it died at import with "Export named
 *     'dd_request_idle_callback' not found", nowhere near the cause.
 *
 * Both were invisible in isolation and only appeared in certain file ORDERS,
 * which is the worst property a gate can have: the suite's own signal stops
 * being trustworthy, and a real regression can hide in the noise.
 *
 * ── THE TWO RULES ────────────────────────────────────────────────────────────
 *  1. A `mock.module` factory returning an object literal must not NARROW the
 *     module's export surface: it either spreads the real module (`...real`) or
 *     covers every one of its exports — or carries a named exemption.
 *  2. A file that installs a module mock must restore it (`mock.restore()`), or
 *     say why it does not need to.
 *
 * ── HOW RULE 1 IS MEASURED (rebuilt 2026-08-22) ───────────────────────────────
 * The scan used to match `mock.module\([^,]+,` — a module-id group that CANNOT
 * contain a comma, so every `mock.module(join(DIR, 'a', 'b'), …)` site was
 * INVISIBLE (10 of them, the whole client-module family). Both css.js
 * truncations lived in that blind spot and were reported as engine failures in
 * unrelated files. The site scanner now brace-walks the argument list instead of
 * regexing it, RESOLVES the module id (evaluating `join()` over string literals,
 * `import.meta.dir` and file-local consts) and compares the factory's top-level
 * keys against the REAL module's exports. That is strictly stronger than
 * "must contain `...`": a single-export module (ui.js exports only `ui`) is
 * whole without a spread, and a 5-export module stubbed with 1 key is caught
 * whether or not it spreads something else.
 *
 * ── HONEST LIMITATIONS ───────────────────────────────────────────────────────
 *  - It reads SOURCE, not behaviour: a factory that spreads the wrong module
 *    passes. The rules make the common accident impossible, not every accident.
 *  - A module id it cannot resolve statically, or one that names no file on
 *    disk (a VIRTUAL id), has no surface to compare — those fall back to the
 *    spread rule and are listed in the baseline with that reason.
 *  - GLOBAL STUBS ARE NOW COVERED (2026-08-24) — this limitation is retired.
 *    Three rules below scan every `globalThis.X =`, `(globalThis as T).X =` and
 *    alias form (`const globals = globalThis as …`), which is how the corpus is
 *    actually written. What they still CANNOT see, stated plainly:
 *      · a PARTIAL restore — `tool_transcription.test.ts` restores three of the
 *        six globals it assigns, and a file-level rule cannot tell that from a
 *        complete one. Per-key detection is not textually possible: the
 *        compliant files restore in a LOOP over a saved map, so demanding a
 *        per-key restore statement would redden correct teardown.
 *      · a computed-key write (`globals[name] = …`) or a write inside an
 *        imported helper. Neither shape exists in the tree today.
 *      · a stub of a global that is NOT a runtime constructor here (Bun has no
 *        DOM, so `Node`/`Option`/`XMLHttpRequest`/`DocumentFragment` are
 *        undefined and assigning them defines a shim rather than destroying a
 *        builtin) — those are allowed deliberately, not overlooked.
 *
 * ── SCOPE (widened 2026-08-25) ───────────────────────────────────────────────
 * The scan used to read `test/unit/` ONLY (`UNIT_DIR = import.meta.dir`), while
 * `bun test` runs test/unit, test/parity AND test/integration in the SAME
 * process — a mock installed by a parity or integration file was invisible to
 * this gate by construction. The scan now walks `test/**` for `*.test.ts`
 * (fixtures carry no `.test.ts` files, and the gate excludes itself), and file
 * identity is the path RELATIVE TO `test/` (`unit/foo.test.ts`), so two tiers
 * can never collide on a basename. Measured at the widening: the 82 files
 * outside test/unit install NO module mock and assign NO global — the only
 * occurrence of `mock.module(` outside unit/ is PROSE in
 * `integration/publication_api_v2_smoke.test.ts`'s header (it describes a mock
 * in the publication app's OWN suite, a separate Bun process), which is why the
 * restore rule now CONVICTS on comment-stripped source: a gate must not
 * baseline a file for MENTIONING the thing it bans. (Its acquittal side stays
 * raw — see `installsWithoutRestore` for the measured reason.)
 *
 * HERMETIC: filesystem reads of tracked test source. No DB, no network, no clock.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Glob } from 'bun';
import { stripComments } from '../helpers/strip_comments.ts';

/** The scan root: all of `test/`, not just this gate's own tier. */
const TEST_DIR = join(import.meta.dir, '..');

/**
 * A SHRINK-ONLY BASELINE, not an approval list.
 *
 * Two of these were proved to corrupt other files (see the header) and are
 * fixed; the rest are UNVETTED — they may be harmless, and asserting otherwise
 * without measuring would be a claim this gate cannot support. So the rule is
 * the honest one: these exist, and NO MORE may appear. Removing a name is a
 * one-line change in the commit that fixes it; adding one is refused.
 *
 * Three entries are known-good by inspection and noted as such: they capture
 * the REAL module up front and re-mock it back, which is a restore by another
 * name.
 */
const PARTIAL_MOCK_BASELINE: readonly string[] = [
	// Captures the REAL module up front and re-mocks it back (a restore by
	// another name), but the stub is narrower than record_scope.ts while active.
	// (tools_record_tipo_permission left the list 2026-09-30: rewritten without
	// mocks, on real identities.)
	'unit/record_scope_gates.test.ts',
	// A VIRTUAL module id ('/virtual/…'): there is no file on disk to spread.
	'unit/transcription_status_panel.test.ts',
	// (The css.js truncations in client_render_queue_deadlock and
	// client_show_interface_ownership were FIXED, not baselined, in the same
	// change that gave this gate its eyes — they were the two the old
	// comma-blind regex could not see. The ui.js family left the list without
	// any edit: ui.js has exactly ONE export, so `{ ui: … }` never narrowed it.)
];

/** Same shape: files that install a module mock and never call `mock.restore()`. */
const NO_RESTORE_BASELINE: readonly string[] = [
	'unit/client_open_window_guard.test.ts',
	'unit/client_show_interface_ownership.test.ts',
	// (media_master_qualities_config and tm_bulk_revert left the list 2026-10-01:
	// both re-mock every replaced module from a spread snapshot in teardown — the
	// restore that works — and the outcome acquittal now sees it.)
];

interface Site {
	file: string;
	/** The mocking file's own directory — the base a RELATIVE module id resolves from. */
	fileDir: string;
	body: string;
	/** Absolute module id, or null when it could not be resolved statically. */
	moduleId: string | null;
}

// ── GLOBAL STUBS (2026-08-24) ─────────────────────────────────────────────────
//
// The header's stated blind spot — "It cannot see a global stub at all" — closed.
// The originating incident: replacing `globalThis.URL` with a PLAIN OBJECT broke
// `new URL(...)` process-wide and made a security gate report `bad_config` where
// it asserts `blocked_host`. One process, so a global is everyone's.
//
// WHAT COUNTS AS DANGEROUS, measured rather than assumed. Only a global that is
// a REAL CONSTRUCTOR IN THIS RUNTIME can be clobbered; Bun has no DOM, so
// `Node`, `DocumentFragment`, `Option` and `XMLHttpRequest` are undefined here
// and a test assigning them is DEFINING a shim, not destroying a builtin. The
// list below is therefore the runtime-real set, verified with `typeof` under the
// Bun this suite runs on — not a textbook list of "browser constructors".
const RUNTIME_CONSTRUCTOR_GLOBALS: readonly string[] = [
	'URL',
	'Date',
	'Response',
	'Request',
	'Headers',
	'FormData',
	'WebSocket',
	'Blob',
	'AbortController',
];

/**
 * Files that assign a global and never restore it. SHRINK-ONLY.
 *
 * Seeded with the one real offender rather than empty: an earlier plan asserted
 * "all of them already restore", which was false and would have landed this gate
 * red on its first commit.
 */
const GLOBAL_NO_RESTORE_BASELINE: readonly string[] = [
	// Assigns SHOW_DEBUG in `beforeAll`; its `afterAll` restores console.warn /
	// console.error only, so the flag leaks to every later file in the process.
	'unit/component_change_value_refresh.test.ts',
];

/** `const x = globalThis;` / `const x = globalThis as …;` — an ALIAS, not a save. */
const GLOBAL_ALIAS =
	/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*globalThis\s*(?:as\b[^;=]*)?\s*;/g;

/** Assignments through `globalThis.X =` and `(globalThis as T).X =`. */
const DIRECT_ASSIGN = /\bglobalThis\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g;
const PAREN_ASSIGN = /\(\s*globalThis\s+as[^)]*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g;

type GlobalSite = { file: string; key: string; rhs: string; line: number };

/** Every global assignment in a unit test, through any alias spelling. */
function globalAssignments(): GlobalSite[] {
	const sites: GlobalSite[] = [];
	for (const file of testFiles()) {
		const source = readFileSync(join(TEST_DIR, file), 'utf8');
		const targets = new Set<string>(['globalThis']);
		for (const m of source.matchAll(GLOBAL_ALIAS)) targets.add(m[1] as string);

		const patterns = [DIRECT_ASSIGN, PAREN_ASSIGN].map((re) => new RegExp(re.source, 'g'));
		for (const alias of targets) {
			if (alias === 'globalThis') continue;
			patterns.push(new RegExp(`\\b${alias}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*=(?!=)`, 'g'));
		}
		for (const re of patterns) {
			for (const m of source.matchAll(re)) {
				const at = m.index ?? 0;
				const rhs = source.slice(at + m[0].length, source.indexOf('\n', at) + 1 || undefined);
				sites.push({
					file,
					key: m[1] as string,
					rhs: rhs.trim(),
					line: source.slice(0, at).split('\n').length,
				});
			}
		}
	}
	return sites;
}

/** Files with teardown (`afterAll`/`afterEach`/`finally`) that touches a global. */
function filesRestoringGlobals(): Set<string> {
	const restoring = new Set<string>();
	for (const file of testFiles()) {
		const source = readFileSync(join(TEST_DIR, file), 'utf8');
		const targets = new Set<string>(['globalThis']);
		for (const m of source.matchAll(GLOBAL_ALIAS)) targets.add(m[1] as string);

		const bodies = teardownBodies(source);
		if (bodies.some((body) => [...targets].some((t) => body.includes(t)))) restoring.add(file);
	}
	return restoring;
}

/**
 * Teardown bodies, brace-matched: every `afterAll(…)` / `afterEach(…)` body and
 * every `finally { … }` block. `finally` is included deliberately: files restore
 * per-test in a finally rather than in afterEach, and a rule demanding the
 * restore sit lexically inside afterAll reddens correct code.
 */
function teardownBodies(source: string): string[] {
	return teardownRanges(source).map(([open, end]) => source.slice(open, end));
}

/** `[open, end)` offsets of every teardown body (see {@link teardownBodies}). */
function teardownRanges(source: string): [number, number][] {
	const ranges: [number, number][] = [];
	for (const m of source.matchAll(/\b(?:afterAll|afterEach)\s*\(|\bfinally\s*\{/g)) {
		const open = source.indexOf('{', (m.index ?? 0) + m[0].length - 1);
		if (open === -1) continue;
		let depth = 0;
		let end = open;
		while (end < source.length) {
			if (source[end] === '{') depth += 1;
			else if (source[end] === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
			end += 1;
		}
		ranges.push([open, end]);
	}
	return ranges;
}

/** This file NAMES `mock.module(` in its prose and its regex; it never calls it. */
const SELF = 'unit/mock_isolation_tripwire.test.ts';

function testFiles(): string[] {
	return [...new Glob('**/*.test.ts').scanSync({ cwd: TEST_DIR })]
		.filter((name) => name !== SELF)
		.sort();
}

/** Split a call's argument source on TOP-LEVEL commas. */
function splitArguments(source: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of source) {
		if ('([{'.includes(char)) depth++;
		else if (')]}'.includes(char)) depth--;
		if (char === ',' && depth === 0) {
			out.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	if (current.trim() !== '') out.push(current);
	return out;
}

/**
 * Evaluate the tiny expression language module ids are written in: string
 * literals, `import.meta.dir`, file-local consts and `join(...)` over those.
 * Anything else ⇒ null (unresolvable, handled as its own class).
 */
function evaluatePath(
	expression: string,
	consts: Map<string, string>,
	fileDir: string,
): string | null {
	const text = expression.trim();
	if (/^'[^']*'$/.test(text)) return text.slice(1, -1);
	if (/^`[^`$]*`$/.test(text)) return text.slice(1, -1);
	// `import.meta.dir` is the MOCKING FILE's directory, not this gate's: with the
	// scan spanning tiers the two are no longer the same path, so the caller hands
	// the file's own directory in.
	if (text === 'import.meta.dir') return fileDir;
	const known = consts.get(text);
	if (known !== undefined) return known;
	const call = text.match(/^join\(([\s\S]*)\)$/);
	if (call === null) return null;
	const parts: string[] = [];
	for (const argument of splitArguments(call[1] ?? '')) {
		const value = evaluatePath(argument, consts, fileDir);
		if (value === null) return null;
		parts.push(value);
	}
	return parts.length === 0 ? null : join(...parts);
}

/** File-local `const X = <path expression>` table, in source order. */
function pathConsts(source: string, fileDir: string): Map<string, string> {
	const consts = new Map<string, string>();
	for (const match of source.matchAll(
		/const\s+([A-Za-z_$][\w$]*)\s*=\s*(join\([^;]*?\)|'[^']*'|`[^`$]*`)\s*;/g,
	)) {
		const value = evaluatePath(match[2] ?? '', consts, fileDir);
		if (value !== null) consts.set(match[1] as string, value);
	}
	return consts;
}

/**
 * Split an object literal's body into its TOP-LEVEL ENTRIES (comments removed).
 *
 * A real scanner, not a character regex: it knows string and template literals
 * (their bytes never open a bracket nor end an entry) and splits only on a comma
 * at depth 0. An entry is the unit a key can START — never a char that merely
 * follows whitespace (rebuilt 2026-10-30, re-review finding f).
 */
function topLevelEntries(body: string): string[] {
	const source = stripComments(body);
	const entries: string[] = [];
	let depth = 0;
	let start = 0;
	let index = 0;
	/** Skip a quoted literal opening at `index`; returns the offset after its close. */
	const skipQuoted = (at: number, quote: string): number => {
		let cursor = at + 1;
		while (cursor < source.length && source[cursor] !== quote) {
			if (source[cursor] === '\\') cursor++;
			else if (quote === '`' && source[cursor] === '$' && source[cursor + 1] === '{') {
				// `${…}` — walk to its matching brace (literals inside it skipped too).
				let inner = 1;
				cursor += 2;
				while (cursor < source.length && inner > 0) {
					const c = source[cursor] as string;
					if (c === "'" || c === '"' || c === '`') cursor = skipQuoted(cursor, c) - 1;
					else if (c === '{') inner++;
					else if (c === '}') inner--;
					cursor++;
				}
				continue;
			}
			cursor++;
		}
		return cursor + 1;
	};
	while (index < source.length) {
		const char = source[index] as string;
		if (char === "'" || char === '"' || char === '`') {
			index = skipQuoted(index, char);
			continue;
		}
		if ('([{'.includes(char)) depth++;
		else if (')]}'.includes(char)) depth--;
		else if (char === ',' && depth === 0) {
			entries.push(source.slice(start, index));
			start = index + 1;
		}
		index++;
	}
	entries.push(source.slice(start));
	return entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * The key an object-literal entry DECLARES, or null (a spread, a computed key).
 * Exactly three shapes count: `name: v` / `'name': v` (property), `name` alone
 * (shorthand) and `name(…) {…}` (method, incl. `async`/`get`/`set`/`*`).
 */
function entryKey(entry: string): string | null {
	if (entry.startsWith('...')) return null;
	const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(entry);
	if (shorthand !== null) return shorthand[1] as string;
	const property = /^(?:([A-Za-z_$][\w$]*)|'([A-Za-z_$][\w$]*)'|"([A-Za-z_$][\w$]*)")\s*:/.exec(
		entry,
	);
	if (property !== null) return (property[1] ?? property[2] ?? property[3]) as string;
	const method = /^(?:async\s+)?(?:(?:get|set)\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(entry);
	return method === null ? null : (method[1] as string);
}

/**
 * The factory object literal's TOP-LEVEL keys — only what an entry DECLARES.
 *
 * The previous reader counted any identifier at depth 0 that followed
 * whitespace/`,`/`{` and preceded `:`/`,`/`(` — so a VALUE (`a: real,`), a call
 * (`a: new Map()` → `Map`), a string's content (`a: 'x name: 1'`) or a comment
 * (`// name,`) counted as a key, and an extra key ACQUITS when the real surface
 * names it: a narrowing mock read as full. That is the false-acquittal
 * direction, the one a tripwire may never have.
 */
function topLevelKeys(body: string): Set<string> {
	const keys = new Set<string>();
	for (const entry of topLevelEntries(body)) {
		const key = entryKey(entry);
		if (key !== null) keys.add(key);
	}
	return keys;
}

/** Does the factory literal SPREAD something at top level (not a `...` in a string or comment)? */
function spreadsAtTopLevel(body: string): boolean {
	return topLevelEntries(body).some((entry) => entry.startsWith('...'));
}

/** Named exports of a real module (const/let/var/function/class + `export {}`). */
function moduleExports(path: string): Set<string> {
	const source = readFileSync(path, 'utf8');
	const names = new Set<string>();
	for (const match of source.matchAll(
		/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm,
	)) {
		names.add(match[1] as string);
	}
	for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const part of (match[1] ?? '').split(',')) {
			const name = part
				.trim()
				.split(/\s+as\s+/)
				.pop();
			if (name !== undefined && name !== '') names.add(name);
		}
	}
	return names;
}

/** Every `mock.module(<id>, () => ({ … }))` site — the REPLACEMENT shape. */
function objectLiteralMockSites(): Site[] {
	const sites: Site[] = [];
	for (const file of testFiles()) {
		const source = readFileSync(join(TEST_DIR, file), 'utf8');
		const fileDir = dirname(join(TEST_DIR, file));
		const consts = pathConsts(source, fileDir);
		let cursor = 0;
		while (true) {
			const start = source.indexOf('mock.module(', cursor);
			if (start < 0) break;
			const argsStart = start + 'mock.module('.length;
			let depth = 1;
			let index = argsStart;
			while (index < source.length) {
				const char = source[index] as string;
				if ('([{'.includes(char)) depth++;
				else if (')]}'.includes(char)) depth--;
				else if (char === ',' && depth === 1) break;
				index++;
			}
			cursor = argsStart;
			if (source[index] !== ',') continue;
			const factory = /^\s*(?:async\s*)?\(\)\s*=>\s*\(\{([\s\S]*?)\}\)\s*,?\s*\)/.exec(
				source.slice(index + 1),
			);
			if (factory === null) continue;
			sites.push({
				file,
				fileDir,
				body: factory[1] ?? '',
				moduleId: evaluatePath(source.slice(argsStart, index), consts, fileDir),
			});
		}
	}
	return sites;
}

/**
 * Does this site NARROW its module? Spread ⇒ never. Resolvable + on disk ⇒
 * compare against the real export surface. Otherwise fall back to the spread
 * rule, because there is no surface to compare against.
 */
function narrowsItsModule(site: Site): boolean {
	if (spreadsAtTopLevel(site.body)) return false;
	if (site.moduleId === null) return true;
	const absolute = isAbsolute(site.moduleId) ? site.moduleId : resolve(site.fileDir, site.moduleId);
	if (!existsSync(absolute)) return true; // virtual id: nothing to spread
	const real = moduleExports(absolute);
	if (real.size === 0) return false; // no named exports to lose
	const stubbed = topLevelKeys(site.body);
	return [...real].some((name) => !stubbed.has(name));
}

/** Files whose mock narrows a module (the shrink-only offender set). */
function narrowingFiles(): string[] {
	return [
		...new Set(
			objectLiteralMockSites()
				.filter(narrowsItsModule)
				.map((s) => s.file),
		),
	].sort();
}

/**
 * Does this file install a module mock and never restore it? ASYMMETRIC on
 * purpose, measured 2026-08-25 at the test/** widening:
 *
 *  - CONVICTION reads comment-stripped source. The only `mock.module(` outside
 *    unit/ is PROSE in `integration/publication_api_v2_smoke.test.ts`'s header
 *    (it describes a mock inside the publication app's OWN 253-test suite — a
 *    separate Bun process this gate's process-isolation law does not reach). A
 *    raw read would have baselined a file for MENTIONING the thing the rule bans.
 *  - ACQUITTAL reads RAW source, and that is load-bearing, not sloppiness:
 *    stripping comments here convicted 12 COMPLIANT files. They restore by the
 *    only means that works — `mock.restore()` does NOT revert `mock.module` in
 *    bun, so they snapshot the real module and re-mock it back in teardown —
 *    and each states that fact in a comment naming `mock.restore()`. The raw
 *    match keeps honoring that documented pattern exactly as the rule always
 *    has. The header's honest limitation stands: this reads SOURCE, not
 *    behaviour — and that raw acquittal is still a SPELLING (a comment naming
 *    `mock.restore()` acquits a file that restores nothing).
 *  - A file is ALSO acquitted on what it DOES (2026-10-01): every module it
 *    replaces is re-mocked from a spread snapshot in teardown
 *    ({@link restoresEveryMockFromSnapshot}, reusing RULE 1's id resolver). Two
 *    compliant files were red for lacking only the comment.
 */
function installsWithoutRestore(file: string): boolean {
	const raw = readFileSync(join(TEST_DIR, file), 'utf8');
	if (!stripComments(raw).includes('mock.module(')) return false;
	if (raw.includes('mock.restore()')) return false;
	return !restoresEveryMockFromSnapshot(stripComments(raw), dirname(join(TEST_DIR, file)));
}

/** One `mock.module(<id>, <factory>)` call: its resolved id and what the factory returns. */
interface MockCall {
	/** Resolved module path, or the whitespace-normalized id source when unresolvable. */
	id: string;
	/** `() => IDENT` ⇒ IDENT; any other factory (an object literal, a call) ⇒ null. */
	returnsIdentifier: string | null;
	/** Offset of the call in the comment-stripped source. */
	at: number;
}

/** Every `mock.module(` call of a comment-stripped source, id resolved where possible. */
function mockCalls(source: string, fileDir: string): MockCall[] {
	const consts = pathConsts(source, fileDir);
	const calls: MockCall[] = [];
	let cursor = 0;
	while (true) {
		const start = source.indexOf('mock.module(', cursor);
		if (start < 0) break;
		const argsStart = start + 'mock.module('.length;
		cursor = argsStart;
		let depth = 1;
		let index = argsStart;
		while (index < source.length) {
			const char = source[index] as string;
			if ('([{'.includes(char)) depth++;
			else if (')]}'.includes(char)) {
				depth--;
				if (depth === 0) break;
			} else if (char === ',' && depth === 1) break;
			index++;
		}
		if (source[index] !== ',') continue;
		const idSource = source.slice(argsStart, index);
		const resolved = evaluatePath(idSource, consts, fileDir);
		const identifier = /^\s*(?:async\s*)?\(\)\s*=>\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/.exec(
			source.slice(index + 1),
		);
		calls.push({
			id:
				resolved === null
					? idSource.replace(/\s+/g, ' ').trim()
					: isAbsolute(resolved)
						? resolved
						: resolve(fileDir, resolved),
			returnsIdentifier: identifier === null ? null : (identifier[1] as string),
			at: start,
		});
	}
	return calls;
}

/**
 * RULE 2's OUTCOME acquittal: every module this file REPLACES is put back from
 * a SNAPSHOT in TEARDOWN. Concretely, for every `mock.module(id, …)` whose
 * factory is not a snapshot, the same file holds a `mock.module(<same id>, () =>
 * SNAP)` that (a) sits inside an `afterAll`/`afterEach` body or a `finally`
 * block, and (b) names a `const SNAP = { ...` SPREAD COPY declared in the file
 * (RULE 3 separately refuses a restore from the live namespace). This is the
 * restore that actually works — `mock.restore()` does not revert
 * `mock.module` — so a file that does it is acquitted on what it DOES, not on
 * whether a comment names `mock.restore()` (backup_freshness_deep_native and
 * backup_inflight_native were convicted for that missing spelling,
 * 2026-10-01; media_master_qualities_config and tm_bulk_revert sat in the
 * baseline for it).
 */
function restoresEveryMockFromSnapshot(source: string, fileDir: string): boolean {
	const snapshots = new Set(
		[...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*\.\.\./g)].map(
			(match) => match[1] as string,
		),
	);
	const teardown = teardownRanges(source);
	const calls = mockCalls(source, fileDir);
	const isRestore = (call: MockCall): boolean =>
		call.returnsIdentifier !== null && snapshots.has(call.returnsIdentifier);
	const restoredInTeardown = new Set(
		calls
			.filter(isRestore)
			.filter((call) => teardown.some(([open, end]) => call.at > open && call.at < end))
			.map((call) => call.id),
	);
	const replaced = calls.filter((call) => !isRestore(call));
	return replaced.length > 0 && replaced.every((call) => restoredInTeardown.has(call.id));
}

/**
 * RULE 3 — A RESTORE MUST COME FROM A SNAPSHOT, NOT THE LIVE NAMESPACE (GATE-01,
 * the blind spot this file's own header named).
 *
 * `import * as NS from 'x'` binds the LIVE module namespace. After
 * `mock.module('x', …)` that binding reflects the MOCK — so a teardown written
 * as `mock.module('x', () => NS)` reinstalls the stub it was meant to remove and
 * hands it to every later file in the tier, which is exactly how 24 media tests
 * came to be silently skipped. The correct shape is a spread COPY captured at
 * import time, before any mock runs:
 *
 *     const REAL_EXPORTS = { ...NS };            // snapshot
 *     mock.module('x', () => REAL_EXPORTS);      // restore
 *
 * Commit 427501d6d4 fixed ONE instance. Two more were still live when this rule
 * was written (media_kill_integrity_native, media_master_qualities_config) —
 * which is the whole argument for a rule instead of a repair.
 */
function namespaceRestores(file: string): string[] {
	return namespaceRestoresIn(stripComments(readFileSync(join(TEST_DIR, file), 'utf8')));
}

/** The pure reader behind {@link namespaceRestores}, so a control can feed it text. */
function namespaceRestoresIn(src: string): string[] {
	if (!src.includes('mock.module(')) return [];
	// Both ways to bind the LIVE namespace: the static `import * as NS` and the
	// dynamic `const NS = await import(…)` (no spread). The second shape hid in
	// transform_run_native until 2026-10-02: its afterAll "restore" re-installed
	// the definitions/tipos mocks, and transform_engine, matrix_counter_monotonic
	// and record_generation went red in every order that ran it first.
	const namespaces = [
		...src.matchAll(/import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s+from/g),
		...src.matchAll(/(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*await\s+import\s*\(/g),
	].map((match) => match[1] as string);
	return namespaces.filter((name) =>
		new RegExp(`mock\\.module\\([^;]*?\\)\\s*=>\\s*${name}\\s*\\)`, 's').test(src),
	);
}

/**
 * RULE 4 — A GATE THAT SUBSTITUTES A CLIENT MODULE RUNS IN ITS OWN PROCESS
 * (2026-10-02, test/helpers/isolated_gate.ts).
 *
 * The client modules under test bind their leaves ONCE per process, and both
 * substitution mechanisms are process-global (a module mock is never reverted,
 * a plugin is never unregistered — and Bun's on-disk transpiler cache even
 * carried a plugin's redirects into LATER processes). Eighteen client gates
 * re-masked ui.js / events.js in turn and each measured the stubs of whichever
 * ran before it: ~30 reds in the CI image's readdir order, none in the Mac's.
 * So a test file that substitutes a module of the client tree (`client/`,
 * `tools/`) — a `mock.module` of such a path, or any in-process `Bun.plugin` —
 * must be an isolated gate: it calls BOTH `isIsolatedGateChild(import.meta.path)`
 * and `mirrorIsolatedGate(import.meta.path)`. A plugin written inside a template
 * literal (a driver a test spawns as its OWN process) is not in-process and is
 * not counted.
 */
const REPO_DIR = join(TEST_DIR, '..');
const CLIENT_TREES = [`${join(REPO_DIR, 'client')}/`, `${join(REPO_DIR, 'tools')}/`];

/** What makes `source` (comment-stripped) a client-substituting file, or null. */
function clientSubstitution(source: string, fileDir: string): string | null {
	const inProcess = source.replace(/`(?:[^`\\]|\\.)*`/gs, '``');
	if (/\b(?:Bun\.)?plugin\(\s*\{/.test(inProcess)) return 'Bun.plugin';
	for (const call of mockCalls(source, fileDir)) {
		if (CLIENT_TREES.some((tree) => call.id.startsWith(tree))) {
			return `mock.module(${call.id.slice(REPO_DIR.length + 1)})`;
		}
	}
	return null;
}

function isIsolatedGate(source: string): boolean {
	return (
		/\bisIsolatedGateChild\(\s*import\.meta\.path\s*\)/.test(source) &&
		/\bmirrorIsolatedGate\(\s*import\.meta\.path\s*\)/.test(source)
	);
}

/** Every test file that substitutes a client module, with what it substitutes. */
function clientSubstitutingFiles(): { file: string; how: string; isolated: boolean }[] {
	return testFiles().flatMap((file) => {
		const path = join(TEST_DIR, file);
		const source = stripComments(readFileSync(path, 'utf8'));
		const how = clientSubstitution(source, dirname(path));
		return how === null ? [] : [{ file, how, isolated: isIsolatedGate(source) }];
	});
}

describe('mock isolation — one process, so a mock is everyone’s', () => {
	test('a restore factory returns a SNAPSHOT, never a live module namespace', () => {
		const offenders = testFiles()
			.flatMap((file) => namespaceRestores(file).map((name) => `${file} (=> ${name})`))
			.sort();
		expect(
			offenders,
			'`import * as NS` is the LIVE namespace: after mock.module it IS the mock, so ' +
				'restoring from it reinstalls the stub for every later file in the tier. Capture a ' +
				'spread copy at import time — `const REAL_EXPORTS = { ...NS }` — and restore from ' +
				`that.\n  ${offenders.join('\n  ')}`,
		).toEqual([]);
	});

	test('POSITIVE CONTROL: the namespace reader sees BOTH live-namespace bindings', () => {
		const planted = [
			"import * as A from '../../src/a.ts';",
			"const B = await import('../../src/b.ts');",
			"const C = { ...(await import('../../src/c.ts')) };",
			"mock.module('../../src/a.ts', () => A);",
			"mock.module('../../src/b.ts', () => B);",
			"mock.module('../../src/c.ts', () => C);",
		].join('\n');
		expect(namespaceRestoresIn(planted)).toEqual(['A', 'B']);
	});

	test('POSITIVE CONTROL: the key reader counts a `(` right after a name, so a full stub reads full', () => {
		// A `(` straight after a key (arrow value, method shorthand) must open depth:
		// skipping it drove depth negative and blinded every later key. A call in a
		// VALUE (`new Map(`, `f(`) is NOT a key — asserted exactly.
		expect([...topLevelKeys('a: () => new Map(), b() { return 1 }, c: 1')].sort()).toEqual([
			'a',
			'b',
			'c',
		]);
		expect(
			[...topLevelKeys('m() { return { x: 1 } }, n: f(1), o: [1, { p: 2 }], q')].sort(),
		).toEqual(['m', 'n', 'o', 'q']);
		expect(
			[
				...topLevelKeys(
					"async r() {}, get s() { return 1 }, 't': 1, \"u\": 2, ...rest, [k]: 3, v,\n w: `x, ${'y'}`",
				),
			].sort(),
		).toEqual(['r', 's', 't', 'u', 'v', 'w']);
		// Against a REAL module surface: every export stubbed with `() => new Map()`
		// is full; drop one and it narrows.
		const fileDir = join(TEST_DIR, 'unit');
		const moduleId = join(import.meta.dir, '../../src/core/concepts/locator.ts');
		const surface = [...moduleExports(moduleId)].sort();
		expect(surface.length).toBeGreaterThanOrEqual(3);
		const bodyOf = (names: string[]) => names.map((name) => `${name}: () => new Map()`).join(', ');
		const site = (body: string): Site => ({ file: 'zz_control.test.ts', fileDir, body, moduleId });
		expect(narrowsItsModule(site(bodyOf(surface)))).toBe(false);
		expect(narrowsItsModule(site(bodyOf(surface.slice(0, -1))))).toBe(true);
		expect(narrowsItsModule(site(bodyOf(surface.slice(1))))).toBe(true);
	});

	test('NEGATIVE CONTROL: a name that is not a declared key never acquits a narrowing mock', () => {
		// Each body stubs every export but MISSING, then names MISSING somewhere that
		// is not a top-level key. The pre-2026-10-30 reader counted every one of
		// these as a key (identifier after whitespace, before `:`/`,`/`(`) and read
		// the mock as FULL — the false-acquittal direction.
		const fileDir = join(TEST_DIR, 'unit');
		const moduleId = join(import.meta.dir, '../../src/core/concepts/locator.ts');
		const surface = [...moduleExports(moduleId)].sort();
		const missing = surface.at(-1) as string;
		const rest = surface
			.slice(0, -1)
			.map((name) => `${name}: () => 1`)
			.join(', ');
		const site = (body: string): Site => ({ file: 'zz_control.test.ts', fileDir, body, moduleId });
		const disguises = {
			'value identifier': `${rest}, zz: ${missing}, zy: 1`,
			'value call': `${rest}, zz: ${missing}(1)`,
			'string literal': `${rest}, zz: 'x ${missing}: 1'`,
			'template literal': `${rest}, zz: \`x \${${missing}}, y\``,
			'line comment': `${rest}, // ${missing},\n zz: 1`,
			'block comment': `${rest}, /* ${missing}: 1 */ zz: 1`,
			nested: `${rest}, zz: { ${missing}: 1 }`,
			'spread in a string': `${rest}, zz: '...'`,
			'spread in a comment': `${rest}, // ...real\n zz: 1`,
			'nested spread': `${rest}, zz: { ...other }`,
		};
		for (const [shape, body] of Object.entries(disguises)) {
			expect(topLevelKeys(body).has(missing), shape).toBe(false);
			expect(narrowsItsModule(site(body)), shape).toBe(true);
		}
		// …while the same name DECLARED, in each genuine shape, acquits.
		for (const declared of [`${missing}: 1`, missing, `${missing}() {}`]) {
			expect(narrowsItsModule(site(`${rest}, ${declared}`)), declared).toBe(false);
		}
		expect(narrowsItsModule(site(`${rest}, ...real`))).toBe(false);
	});

	test('NO NEW partial module mock (shrink-only)', () => {
		const added = narrowingFiles().filter((file) => !PARTIAL_MOCK_BASELINE.includes(file));
		expect(
			added,
			'A partial `mock.module` TRUNCATES that module for every other file in the tier — they fail at import with "Export named \'x\' not found", nowhere near this file. Spread the real module and override only what you stub.',
		).toEqual([]);
	});

	test('the outcome acquittal: a snapshot re-mock in teardown restores, anything less does not (controls)', () => {
		const dir = '/zz/unit';
		const head = 'const NS_REAL = { ...ns };\nconst LIVE = ns;\n';
		const replace = "mock.module('../a.ts', () => ({ ...NS_REAL, f: () => 1 }));\n";
		// Restored in a finally, from a spread snapshot: acquitted.
		expect(
			restoresEveryMockFromSnapshot(
				`${head}try { ${replace} } finally { mock.module('../a.ts', () => NS_REAL); }`,
				dir,
			),
		).toBe(true);
		// Restored in afterAll: acquitted.
		expect(
			restoresEveryMockFromSnapshot(
				`${head}${replace}afterAll(() => { mock.module('../a.ts', () => NS_REAL); });`,
				dir,
			),
		).toBe(true);
		// Never restored.
		expect(restoresEveryMockFromSnapshot(`${head}${replace}`, dir)).toBe(false);
		// "Restored" outside teardown — runs before the test, not after it.
		expect(
			restoresEveryMockFromSnapshot(
				`${head}mock.module('../a.ts', () => NS_REAL);\n${replace}`,
				dir,
			),
		).toBe(false);
		// Restored from a name that is not a spread snapshot.
		expect(
			restoresEveryMockFromSnapshot(
				`${head}${replace}afterAll(() => { mock.module('../a.ts', () => LIVE); });`,
				dir,
			),
		).toBe(false);
		// Two modules replaced, one restored.
		expect(
			restoresEveryMockFromSnapshot(
				`${head}${replace}mock.module('../b.ts', () => ({ g: 1 }));\n` +
					"afterAll(() => { mock.module('../a.ts', () => NS_REAL); });",
				dir,
			),
		).toBe(false);
		// Same id spelled through join(import.meta.dir, …) resolves to the same module.
		expect(
			restoresEveryMockFromSnapshot(
				`${head}${replace}afterAll(() => { mock.module(join(import.meta.dir, '..', 'a.ts'), () => NS_REAL); });`,
				dir,
			),
		).toBe(true);
	});

	test('NO NEW unrestored module mock (shrink-only)', () => {
		const unrestored = testFiles().filter(installsWithoutRestore);
		const added = unrestored.filter((file) => !NO_RESTORE_BASELINE.includes(file));
		expect(
			added,
			'`mock.module` is process-global: a file that never restores hands its stub to every later file importing the same module.',
		).toEqual([]);
	});

	test('the baselines are LIVE — a stale entry is a finding, because it hides a regression', () => {
		const partial = new Set(narrowingFiles());
		expect(
			PARTIAL_MOCK_BASELINE.filter((file) => !partial.has(file)),
			'fixed — delete these names in the same change that fixed them',
		).toEqual([]);
		const unrestored = new Set(testFiles().filter(installsWithoutRestore));
		expect(
			NO_RESTORE_BASELINE.filter((file) => !unrestored.has(file)),
			'fixed — delete these names in the same change that fixed them',
		).toEqual([]);
	});

	test('ANTI-VACUITY: the scan actually finds mock sites', () => {
		const mockers = testFiles().filter((file) =>
			stripComments(readFileSync(join(TEST_DIR, file), 'utf8')).includes('mock.module('),
		);
		// 40+ files mock a module today; a scan that found none would pass every
		// rule above while measuring nothing.
		expect(mockers.length).toBeGreaterThan(20);
		const sites = objectLiteralMockSites();
		expect(sites.length).toBeGreaterThan(5);
		// THE BLIND SPOT THAT EXISTED UNTIL 2026-08-22: the old `[^,]+` module-id
		// group could not match a call expression, so every `mock.module(join(D,
		// 'a', 'b'), …)` site was unseen — and both real truncations lived there.
		// The scan must keep seeing that form, and must keep RESOLVING ids.
		expect(sites.filter((site) => site.moduleId !== null).length).toBeGreaterThan(10);
	});
	// ── global stubs ─────────────────────────────────────────────────────────
	test('no NON-CONSTRUCTOR is assigned over a real runtime constructor global', () => {
		const offenders = globalAssignments()
			.filter((site) => RUNTIME_CONSTRUCTOR_GLOBALS.includes(site.key))
			.filter((site) => {
				// A constructor RHS: a class expression, or an identifier declared
				// `class` in the same file. The one legitimate shape in the tree is
				// `class StubURL extends (globals.URL as typeof URL)` — it SUBCLASSES
				// the real constructor instead of replacing it, and that is the
				// pattern to copy.
				if (/^class\b/.test(site.rhs)) return false;
				const id = site.rhs.match(/^([A-Za-z_$][\w$]*)/)?.[1];
				if (id === undefined) return true;
				const source = readFileSync(join(TEST_DIR, site.file), 'utf8');
				return !new RegExp(`class\\s+${id}\\b`).test(source);
			});
		expect(
			offenders.map((o) => `${o.file}:${o.line} ${o.key} = ${o.rhs}`),
			'a plain object over a real constructor breaks `new X()` for the whole ' +
				'process — subclass it (`class Stub extends (globals.X as typeof X)`) instead',
		).toEqual([]);
	});

	test('every file that assigns a global restores it in teardown', () => {
		const restoring = filesRestoringGlobals();
		const assigning = new Set(globalAssignments().map((s) => s.file));
		const unrestored = [...assigning].filter((f) => !restoring.has(f)).sort();
		expect(
			unrestored.filter((f) => !GLOBAL_NO_RESTORE_BASELINE.includes(f)),
			'a global assigned and never restored leaks into every later file in the process',
		).toEqual([]);
		// Stale baseline entries are red too.
		expect(
			GLOBAL_NO_RESTORE_BASELINE.filter((f) => !unrestored.includes(f)),
			'fixed — delete these names in the same change that fixed them',
		).toEqual([]);
	});

	test('ANTI-VACUITY: the global scan actually finds stub sites', () => {
		const sites = globalAssignments();
		const files = new Set(sites.map((s) => s.file));
		// Measured 2026-08-24: 21 files, across three alias spellings
		// (`globalThis.X`, `const globals = globalThis as …`, `const g = …`).
		// A scan that found none would pass both rules above while measuring nothing.
		expect(files.size).toBeGreaterThanOrEqual(18);
		expect(sites.length).toBeGreaterThan(40);
		// The alias forms must keep being seen: an earlier corpus counted only two
		// spellings and missed three files, two of which were real offenders.
		// File identity is tier-prefixed since the 2026-08-25 widening — a bare
		// /^client_/ would match nothing and make this count vacuous.
		expect([...files].filter((f) => !/^unit\/client_/.test(f)).length).toBeGreaterThan(2);
	});

	test('RULE 4: a gate that substitutes a client module is an ISOLATED gate (its own process)', () => {
		const found = clientSubstitutingFiles();
		// Floor: measured 2026-10-02, 19 files substitute a client module.
		expect(found.length).toBeGreaterThanOrEqual(15);
		const shared = found.filter((f) => !f.isolated).map((f) => `${f.file} (${f.how})`);
		expect(
			shared,
			'these files replace a client module INSIDE the shared tier process, so every later client gate measures their stubs (file order decides the verdict). Make them isolated gates — test/helpers/isolated_gate.ts:\n  ' +
				shared.join('\n  '),
		).toEqual([]);
	});

	test('POSITIVE CONTROL: rule 4 sees a client mock, an in-process plugin, and not a spawned driver', () => {
		const dir = join(TEST_DIR, 'unit');
		expect(
			clientSubstitution(
				"const UI = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core', 'common', 'js', 'ui.js');\nmock.module(UI, () => ({ ui: {} }));",
				dir,
			),
		).toBe('mock.module(client/dedalo/core/common/js/ui.js)');
		expect(clientSubstitution('plugin({ name: "x", setup() {} });', dir)).toBe('Bun.plugin');
		expect(clientSubstitution('const driver = `Bun.plugin({ name: "x" })`;', dir)).toBeNull();
		expect(clientSubstitution("mock.module('../../src/core/x.ts', () => ({}));", dir)).toBeNull();
		expect(
			isIsolatedGate(
				'if (!isIsolatedGateChild(import.meta.path)) mirrorIsolatedGate(import.meta.path);',
			),
		).toBe(true);
		expect(isIsolatedGate('mirrorIsolatedGate(import.meta.path);')).toBe(false);
	});
});
