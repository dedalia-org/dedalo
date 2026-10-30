/**
 * TRIPWIRE — every byte the engine fetches is BOUNDED (P1-26 / CARRY-14).
 *
 * Six outbound sites carried no signal, no timeout and no byte ceiling. That is
 * not a write hazard — an awaited fetch blocks no event loop and holds no
 * transaction, which is Wave 5's own correction to the original finding — but it
 * is LANE OCCUPANCY: background work runs in three shared lanes, so one peer that
 * accepts a connection and then goes quiet holds a lane for as long as it likes,
 * and media, publication and RAG queue behind it. An answer without a ceiling is
 * unbounded ingest on top.
 *
 * The pattern that produced them is what this gate exists to stop: a hardened
 * primitive is written once, and the next caller — whose destination is
 * legitimately private — copies the bare `fetch` instead of the primitive, and
 * copies none of its guarantees. So the census is TOTAL over `src/` and `tools/`,
 * and an exemption must be WRITTEN DOWN here with its reason, never inferred.
 *
 * ITS OWN SCANNER IS THE WEAK POINT, and adversarial review proved it four times
 * before this version. Each is closed and named at the assertion it broke:
 *   - a fixed-width call window ran past the call into the next statements;
 *   - a REGEX LITERAL's escaped paren desynced the bracket count, so the window
 *     ran on and a decoy `signal:` in the following line satisfied it;
 *   - a TYPE ANNOTATION (`as …`, `satisfies …`) sits INSIDE the call's
 *     parentheses, so a pure type spelled `signal: AbortSignal` passed;
 *   - `Bun.fetch(` and any other member spelling were invisible to a census
 *     calling itself TOTAL.
 * A scanner that cannot be sure must FAIL, not guess.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from '@babel/parser';
import { curlArgv } from '../../src/core/ai/model_fetch.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import {
	fetchPinnedHop,
	isAddressRefusal,
	type PinnedHopRequest,
	readBytesCapped,
} from '../../src/core/security/ssrf_guard.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Code with comments, literal bodies AND regex bodies blanked, and `${…}`
 * substitutions kept as code.
 *
 * Every one of those four is load-bearing: a string is not code, a regex body
 * desyncs bracket counting, and a substitution IS code — blanking it hides a
 * call made inside a template.
 */
function code(rel: string): string {
	return stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'), {
		blankStrings: true,
		blankRegexBodies: true,
		keepTemplateSubstitutions: true,
	});
}

/**
 * How each file bounds its RESPONSES, and HOW MANY outbound calls it makes.
 *
 * The count is not bookkeeping: keyed by file alone, a new unbounded call could
 * be added to an already-declared file and the declaration would cover it
 * silently. Adding a call now forces someone to raise the number, which means
 * re-reading the reason and deciding it still applies.
 */
const BOUNDED_BY: Record<string, { sites: number; how: string }> = {
	'src/core/security/ssrf_guard.ts': {
		sites: 2,
		how: "THE primitive: ONE transport core (openHopBudget's total deadline + readHopResponse → readBytesCapped, the ONE streamed capped reader that cancels the body on breach) under fetchBoundedText (a call, unpinned) and fetchPinnedHop (a seam: `deps.fetch ?? fetch`, pinned) — the harvesting door's hop and fetchGuardedText's one call, a redirect body cancelled unread",
	},
	'src/core/update/status.ts': {
		sites: 1,
		how: 'advertisedUrlReachableCheck: a Range 0-0 probe, AbortSignal.timeout at the call; a refusal body is read whole and sliced to 2 KiB — TIME-bounded, not byte-capped',
	},
	'src/ai/agent/openai_compat_provider.ts': {
		sites: 1,
		how: 'operator-configured model endpoint: re-armed IDLE timer on the stream; response.json() of the answer is NOT byte-capped (CARRY-14 debt)',
	},
	'src/ai/rag/llm_provider.ts': {
		sites: 1,
		how: 'operator-configured model endpoint: a timeout at the call; response.json() is NOT byte-capped (CARRY-14 debt)',
	},
	'src/ai/rag/embedding_provider.ts': {
		sites: 1,
		how: 'operator-configured embedding endpoint: a timeout at the call; response.json() is NOT byte-capped (CARRY-14 debt)',
	},
	'src/ai/rag/multimodal_embedding_provider.ts': {
		sites: 1,
		how: 'operator-configured multimodal embedding endpoint: a timeout at the call; res.json() is NOT byte-capped (CARRY-14 debt)',
	},
	'tools/tool_error_report/server/index.ts': {
		sites: 1,
		how: 'relay to the operator-configured master (https, or loopback http): relayTimeoutMs at the call; response.json() of a small envelope is NOT byte-capped (CARRY-14 debt)',
	},
	'src/core/area_maintenance/widgets/site_builder_status.ts': {
		sites: 1,
		how: 'small JSON status payload from the local daemon',
	},
	'src/core/ontology/data_io_import.ts': {
		sites: 2,
		how: 'ontology archive streamed to disk under a declared size',
	},
	'tools/tool_sitebuilder/server/daemon_client.ts': {
		sites: 3,
		how: 'local site_builder daemon over a unix socket',
	},
	'src/core/ai/model_fetch.ts': {
		sites: 1,
		how: 'multi-GB weights: IDLE bound on both transports, bytes hashed against the sha256 pinned in model_pins.json (size pinned too) before the manifest records them',
	},
	'src/core/geoip/download.ts': {
		sites: 1,
		how: 'assertAcceptableResponse caps the declared length',
	},
	'src/core/update/code_download.ts': {
		sites: 1,
		how: 'release archive verified against a declared sha',
	},
	'src/core/update/smoke_boot.ts': {
		sites: 1,
		how: 'own quarantine child over a socket it just made; /health is a fixed small body',
	},
	'src/external/transport.ts': {
		sites: 1,
		how: 'fetchExternalJson: byte cap, breaker and concurrency slot, with its own gate',
	},
	'src/core/publication_host/transport.ts': {
		sites: 1,
		how: 'dialAgent: the shared readBytesCapped (default 1 MiB, ceiling 16 MiB) under ONE AbortSignal.timeout deadline that also bounds the body, an idle bound, redirect manual and any 3xx refused unread',
	},
};

/**
 * DEFAULT-VALUED SEAMS: files that hand the real `fetch` over as a VALUE — a
 * default parameter (`impl: typeof fetch = fetch`), a fallback
 * (`deps.fetch ?? fetch`), an object property (`fetchImpl: fetch`) — and call it
 * later under another name. The call is invisible to a textual census, so the
 * VALUE REFERENCE is what is counted as the file's outbound site. Banning the idiom
 * would be wrong (it is the tree's way to make an outbound call testable), so it is
 * enumerated, and each one must bound the call it makes (asserted below).
 *
 * Measured 2026-09-29: the census knew only the default-parameter spelling, and
 * SIX files passed `fetch` as a value past both outbound gates — the four model
 * providers, the error-report relay, and the pinned hop the harvesting door was
 * just built on. Pre-existing debt newly SEEN, not new doors.
 */
const FETCH_SEAMS: Record<string, string> = {
	'src/core/update/status.ts':
		'advertisedUrlReachableCheck — bounded by AbortSignal.timeout(REACHABILITY_TIMEOUT_MS) at its own call',
	'src/core/security/ssrf_guard.ts':
		'fetchPinnedHop — `deps.fetch ?? fetch`; the init carries the hop budget signal, and the closure + driven tests below prove the deadline, pin and ceiling',
	'src/ai/agent/openai_compat_provider.ts':
		'OpenAiCompatProvider — `cfg.fetchImpl ?? fetch`, the call carries signal: controller.signal (idle timer re-armed per chunk)',
	'src/ai/rag/llm_provider.ts':
		'LlmProvider — `cfg.fetchImpl ?? fetch`, the call carries signal: controller.signal',
	'src/ai/rag/embedding_provider.ts':
		'EmbeddingProvider — `config.fetchImpl ?? fetch`, the call carries signal: controller.signal',
	'src/ai/rag/multimodal_embedding_provider.ts':
		'MultimodalEmbeddingProvider — `config.fetchImpl ?? fetch`, the call carries signal: controller.signal',
	'tools/tool_error_report/server/index.ts':
		'send_report defaultDeps — `fetchImpl: fetch`, the relay call carries signal: controller.signal',
};

/**
 * `fetch` as a VALUE: not called (`fetch(`), not a key or member (`fetch:`,
 * `fetch?:`, `x.fetch`), not a type (`typeof fetch`). Run on code with literals
 * blanked, so a sentence that says "fetch" is not a site.
 */
const FETCH_VALUE = /(?<![\w$.])fetch(?![\w$])(?!\s*(?:\(|\??:))/g;

/** Lines where `rel` hands the real fetch over as a value. */
function fetchValueRefs(rel: string): number[] {
	const source = code(rel);
	const lines: number[] = [];
	for (const match of source.matchAll(FETCH_VALUE)) {
		const index = match.index as number;
		if (/typeof\s+$/.test(source.slice(Math.max(0, index - 40), index))) continue;
		lines.push(source.slice(0, index).split('\n').length);
	}
	return lines;
}

/** Every value reference in the tree, as `file:line`. */
function seamSites(): Array<{ file: string; line: number }> {
	return sourceFiles().flatMap((file) => fetchValueRefs(file).map((line) => ({ file, line })));
}

/**
 * Sites that arm the signal on an init object BEFORE the call rather than in it.
 * Enumerated AND checked below — an enumerated file that stops arming its init
 * is exactly as naked as an unlisted one.
 */
const SIGNAL_SET_ON_INIT = new Set(['src/external/transport.ts']);

/**
 * Every caller of the no-address-policy transport must apply a policy of its
 * own, and say which. `fetchBoundedText` is deliberately an unguarded door — it
 * exists so a private-destination caller need not copy a bare `fetch` — so the
 * thing that keeps it safe is this census, not the function.
 */
const ADDRESS_POLICY: Record<string, string> = {
	'src/core/security/ssrf_guard.ts':
		'defines fetchBoundedText (no policy, no pin); fetchGuardedText vets, pins and caps through fetchPinnedHop and never calls it',
	'src/core/tools/transcription_local_asr.ts':
		'isSafeLocalAsrUrl: http(s) only, private hosts ONLY behind DEDALO_TRANSCRIBER_ALLOW_PRIVATE_HOSTS',
	'src/core/ontology/ontology_manifest.ts':
		'assertConfiguredMasterUrl: the URL must be EXACTLY (normalized) a configured ontology-master API URL (ONTOLOGY_SERVERS / the install plan official constant) — operator configuration, never client text; a LAN master is legitimate, so the public-address policy does not apply',
	'src/core/update/code_manifest_pin.ts':
		'assertConfiguredMasterUrl: the URL must be EXACTLY (normalized) a configured CODE_SERVERS entry (already https-filtered, U-24) — the master the requested archive came from, resolved from configuration, never client text (U-41)',
	// Not a fetchBoundedText caller: a private-destination DOOR with its own call, held to
	// the same rule — its one URL is its policy's output (asserted below).
	'src/core/publication_host/transport.ts':
		'agentTarget: the EXACT registry entry of a paired agent — https host:port with mTLS from the engine bundle, or the unix socket — never caller text',
};

/**
 * Source files in both trees, WALKED FROM DISK.
 *
 * `git ls-files` would miss a file that is not staged yet — so the census was
 * blind to exactly the code most likely to be wrong: the file the author is
 * still writing. A tripwire that only sees committed work is a tripwire that
 * reports after the fact.
 */
function sourceFiles(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
			const rel = `${dir}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist') continue;
				walk(rel);
			} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
				found.push(rel);
			}
		}
	};
	walk('src');
	walk('tools');
	return found.sort();
}

/** Index of the `)` matching the `(` at or after `from`, or -1 when unbalanced. */
function matchingClose(source: string, from: number): number {
	const open = source.indexOf('(', from);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const char = source[i];
		if (char === '(') depth++;
		else if (char === ')') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Argument `index` of a balanced argument list, split on DEPTH-0 commas. */
function callArgument(call: string, index: number): string {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < call.length; i++) {
		const char = call[i];
		if (char === '{' || char === '[' || char === '(') depth++;
		else if (char === '}' || char === ']' || char === ')') depth--;
		else if (char === ',' && depth === 0) {
			parts.push(call.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(call.slice(start));
	return parts[index] ?? '';
}

/** The text between `fetch(` and its matching close paren, brackets balanced. */
function callArguments(source: string, fetchIndex: number): string {
	const open = source.indexOf('(', fetchIndex);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const char = source[i];
		if (char === '(') depth++;
		else if (char === ')') {
			depth--;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	// Unbalanced: the scanner does not know where the call ends, so it must not
	// pretend. Empty text carries no `signal`, so the site reports as naked.
	return '';
}

/**
 * Blank TypeScript `as` / `satisfies` assertions, braces and type arguments
 * included. A type is not code, and both keywords put one INSIDE the call's
 * parentheses where bracket balancing cannot reach it.
 */
function withoutTypeAssertions(call: string): string {
	let out = call;
	for (;;) {
		const match = /\b(?:as|satisfies)\s/.exec(out);
		if (match === null) return out;
		const at = match.index;
		let i = at + match[0].length;
		let braces = 0;
		let angles = 0;
		for (; i < out.length; i++) {
			const char = out[i];
			if (char === '{') braces++;
			else if (char === '}') braces--;
			else if (char === '<') angles++;
			else if (char === '>') angles--;
			// A comma inside `Partial<{a, b}>` does NOT end the annotation — the
			// early-exit version left the type's own `signal:` behind.
			else if (char === ',' && braces === 0 && angles === 0) break;
		}
		out = `${out.slice(0, at)}${' '.repeat(i - at)}${out.slice(i)}`;
	}
}

/**
 * Does the init object carry `signal` as a TOP-LEVEL key?
 *
 * Testing the flattened argument text counted a `signal` at ANY nesting depth:
 * measured, `fetch(url, { headers: { accept: 'text/plain', signal: 'none' } })`
 * — no controller, no timeout, no cancellation of any kind — passed. The
 * scanner already balances brackets, so it can look only where the property
 * would actually take effect.
 */
function hasTopLevelSignal(call: string): boolean {
	// THE SECOND ARGUMENT, not the first `{` in the text. A URL built from a
	// template literal — `fetch(`${base}/health`, { … })` — opens a brace inside
	// argument ONE, and starting there closed at the substitution's own `}` and
	// reported a properly bounded call as naked.
	const init = callArgument(call, 1);
	const open = init.indexOf('{');
	if (open === -1) return false;
	let depth = 0;
	for (let i = open; i < init.length; i++) {
		const char = init[i];
		if (char === '{' || char === '[' || char === '(') depth++;
		else if (char === '}' || char === ']' || char === ')') {
			depth--;
			if (depth === 0) return false; // the init object closed without one
		} else if (depth === 1 && /[\w$]/.test(char as string)) {
			const rest = init.slice(i);
			const key = /^(signal)\s*(?::|,|\})/.exec(rest);
			if (key !== null) return true;
			// skip the whole token so `resignal` cannot match mid-word
			i += (/^[\w$]+/.exec(rest) as RegExpExecArray)[0].length - 1;
		}
	}
	return false;
}

/**
 * Outbound `fetch(` sites, INCLUDING member spellings (`Bun.fetch(`,
 * `globalThis.fetch(`). A census that only knew the bare identifier called
 * itself TOTAL while `Bun.fetch(` walked straight past it.
 */
function fetchSites(): Array<{ file: string; line: number; call: string }> {
	const sites: Array<{ file: string; line: number; call: string }> = [];
	for (const file of sourceFiles()) {
		const source = code(file);
		// Dotted (`Bun.fetch(`), optional (`globalThis?.fetch(`) AND COMPUTED
		// (`globalThis['fetch'](`) — a census that recognised only the first two
		// still called itself TOTAL while a legal spelling walked past it.
		const SITE =
			/(?<![\w$])(?:[\w$]+(?:\??\.[\w$]+)*\??\.)?fetch\s*\(|\[\s*(?:'|")fetch(?:'|")\s*\]\s*\(/g;
		for (const match of source.matchAll(SITE)) {
			const index = match.index as number;
			if (/typeof\s+$/.test(source.slice(Math.max(0, index - 40), index))) continue;
			// `fetch(request, server) { … }` is Bun.serve's INBOUND handler — a method
			// definition, not a call. The discriminator is what follows the matching
			// close paren: a body brace means a definition, and this server defines
			// two of them.
			const closeAt = matchingClose(source, index + match[0].length - 1);
			if (closeAt !== -1 && /^\s*\{/.test(source.slice(closeAt + 1, closeAt + 4))) continue;
			sites.push({
				file,
				line: source.slice(0, index).split('\n').length,
				call: callArguments(source, index + match[0].length - 1),
			});
		}
	}
	return sites;
}

// ---------------------------------------------------------------------------
// THE PRIMITIVE'S OWN GUARANTEES, read from its AST.
//
// A door's guarantees are what its CALL CLOSURE does: the functions of the guard
// module it reaches, directly or through helpers. Slicing a function's text from
// `export async function X(` to the next `\n}` stopped at the first helper split,
// which the complexity cap makes routine; the closure survives both a split and a
// rename, because it follows references, not spellings.
// ---------------------------------------------------------------------------

type AstNode = { type: string; [key: string]: unknown };

const NOT_CODE_KEYS = new Set([
	'loc',
	'extra',
	'leadingComments',
	'trailingComments',
	'innerComments',
]);

/** Visit every AST node under `root`, depth-first. */
function visitAst(root: unknown, visit: (node: AstNode) => void): void {
	if (Array.isArray(root)) {
		for (const child of root) visitAst(child, visit);
		return;
	}
	if (root === null || typeof root !== 'object') return;
	visit(root as AstNode);
	for (const [key, child] of Object.entries(root)) {
		if (!NOT_CODE_KEYS.has(key) && typeof child === 'object') visitAst(child, visit);
	}
}

function parseModule(rel: string): AstNode {
	const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
	const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'] });
	return ast.program as unknown as AstNode;
}

/** Top-level functions of a module — declarations and `const f = () => …` — by name. */
function topLevelFunctions(program: AstNode): Map<string, AstNode> {
	const functions = new Map<string, AstNode>();
	for (const statement of program.body as AstNode[]) {
		const declaration = (statement.declaration as AstNode | undefined) ?? statement;
		if (declaration.type === 'FunctionDeclaration') {
			functions.set((declaration.id as AstNode).name as string, declaration);
		}
		for (const declarator of (declaration.declarations ?? []) as AstNode[]) {
			const init = declarator.init as AstNode | null;
			if (init !== null && /FunctionExpression$/.test(init.type)) {
				functions.set((declarator.id as AstNode).name as string, init);
			}
		}
	}
	return functions;
}

/** The name a call is made BY: `f(` → f, `a.b.f(` → f. */
function calleeName(callee: AstNode): string | null {
	if (callee.type === 'Identifier') return callee.name as string;
	const property = callee.property as AstNode | undefined;
	const isMember = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression';
	return isMember && callee.computed !== true ? (property?.name as string) : null;
}

/** `setTimeout(() => x.abort(), …)` or `AbortSignal.timeout(…)`: a deadline that aborts. */
function isAbortTimer(call: AstNode): boolean {
	const callee = call.callee as AstNode;
	if (
		calleeName(callee) === 'timeout' &&
		(callee.object as AstNode | undefined)?.name === 'AbortSignal'
	) {
		return true;
	}
	if (calleeName(callee) !== 'setTimeout') return false;
	let aborts = false;
	visitAst((call.arguments as unknown[])[0], (node) => {
		if (node.type === 'CallExpression' && calleeName(node.callee as AstNode) === 'abort')
			aborts = true;
	});
	return aborts;
}

/** `redirect: 'x'` in an object literal, or `init.redirect = 'x'`. */
function redirectMode(node: AstNode): string | null {
	const key = (node.type === 'ObjectProperty' ? node.key : node.left) as AstNode | undefined;
	const value = (node.type === 'ObjectProperty' ? node.value : node.right) as AstNode | undefined;
	const named = key?.type === 'MemberExpression' ? (key.property as AstNode) : key;
	const isRedirect = (named?.name ?? named?.value) === 'redirect';
	if (!isRedirect || !/^(ObjectProperty|AssignmentExpression)$/.test(node.type)) return null;
	return value?.type === 'StringLiteral' ? (value.value as string) : '<computed>';
}

interface ClosureFacts {
	functions: Set<string>;
	calls: Set<string>;
	redirectModes: Set<string>;
	abortTimer: boolean;
}

/** `f()`, `a?.f()` and `new F()` — every way a function body invokes something. */
const CALL_TYPES = new Set(['CallExpression', 'OptionalCallExpression', 'NewExpression']);

/** Record what one function body does, and queue the guard functions it references. */
function scanFunction(
	body: AstNode,
	known: Map<string, AstNode>,
	facts: ClosureFacts,
	queue: string[],
): void {
	visitAst(body, (node) => {
		if (node.type === 'Identifier' && known.has(node.name as string))
			queue.push(node.name as string);
		const mode = redirectMode(node);
		if (mode !== null) facts.redirectModes.add(mode);
		if (!CALL_TYPES.has(node.type)) return;
		const name = calleeName(node.callee as AstNode);
		if (name !== null) facts.calls.add(name);
		if (isAbortTimer(node)) facts.abortTimer = true;
	});
}

/** Everything `root` does, through every function of the guard module it reaches. */
function guardClosure(root: string): ClosureFacts {
	const known = topLevelFunctions(parseModule('src/core/security/ssrf_guard.ts'));
	expect(known.has(root), `ssrf_guard.ts no longer defines ${root}`).toBe(true);
	const facts: ClosureFacts = {
		functions: new Set(),
		calls: new Set(),
		redirectModes: new Set(),
		abortTimer: false,
	};
	const queue = [root];
	for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
		if (facts.functions.has(name)) continue;
		facts.functions.add(name);
		scanFunction(known.get(name) as AstNode, known, facts, queue);
	}
	return facts;
}

/** The names from `fromModule` that `rel` imports AND calls — under whatever local name. */
function importedCalls(rel: string, fromModule: string): string[] {
	const program = parseModule(rel);
	const locals = new Map<string, string>();
	for (const statement of program.body as AstNode[]) {
		const specifier = (statement.source as AstNode | undefined)?.value as string | undefined;
		if (statement.type !== 'ImportDeclaration' || specifier === undefined) continue;
		if (join(dirname(rel), specifier) !== fromModule) continue;
		for (const binding of statement.specifiers as AstNode[]) {
			const imported = binding.imported as AstNode | undefined;
			if (imported !== undefined)
				locals.set((binding.local as AstNode).name as string, imported.name as string);
		}
	}
	const called = new Set<string>();
	visitAst(program, (node) => {
		const callee = CALL_TYPES.has(node.type) ? (node.callee as AstNode) : null;
		const imported = callee?.type === 'Identifier' ? locals.get(callee.name as string) : undefined;
		if (imported !== undefined) called.add(imported);
	});
	return [...called].sort();
}

describe('no outbound fetch is unbounded', () => {
	test('the census finds the call sites it is supposed to', () => {
		// A floor, because a broken pathspec or a stripper change would make every
		// assertion below pass by finding nothing.
		const files = sourceFiles();
		expect(files.length, 'the source census found almost nothing').toBeGreaterThan(500);
		const sites = fetchSites();
		expect(sites.length, 'the outbound census found almost nothing').toBeGreaterThan(8);
		expect(
			sites.some((s) => s.file.startsWith('tools/')),
			'the tools tree is missing',
		).toBe(true);
	});

	test('every outbound fetch carries a cancellation signal', () => {
		const naked: string[] = [];
		for (const site of fetchSites()) {
			const inCall = hasTopLevelSignal(withoutTypeAssertions(site.call));
			const armedAbove =
				SIGNAL_SET_ON_INIT.has(site.file) && /\binit\.signal\s*=/.test(code(site.file));
			if (!inCall && !armedAbove) naked.push(`${site.file}:${site.line}`);
		}
		expect(
			naked,
			'an outbound fetch with no signal holds a background lane until the peer decides otherwise',
		).toEqual([]);
	});

	test('fetch is never aliased out of the census', () => {
		// `const f = fetch; f(url)` is invisible to any textual census, so the
		// aliasing itself is banned rather than chased. Injectable `fetchImpl`
		// parameters are a different thing: they are DECLARED seams whose callers
		// are the sites above.
		// Every form measured to slip past the first version of this ban:
		//   const f = fetch                     — the plain one
		//   const { fetch: go } = globalThis    — renamed destructuring
		//   const b = globalThis.fetch.bind(…)  — a trailing method call
		//   private readonly grab = fetch       — a class field, no const/let/var
		//   function pull(impl = fetch)         — a DEFAULT-VALUED seam, which is
		//     itself the outbound site: the seam reasoning below holds only when a
		//     CALLER supplies the implementation.
		const ALIAS_FORMS: Array<[RegExp, string]> = [
			[
				/(?:const|let|var)\s+[\w$]+\s*(?::[^=;]+)?=\s*(?:globalThis|Bun)?\??\.?fetch\s*(?:[;,\n)]|\.bind)/g,
				'assigned',
			],
			[/\{\s*fetch\s*(?::\s*[\w$]+)?\s*\}\s*=/g, 'destructured'],
			[
				/(?:readonly\s+)?[\w$]+\s*(?::[^=;]+)?=\s*(?:globalThis|Bun)?\??\.?fetch\s*;/g,
				'class field',
			],
			[
				/[\w$]+\s*(?::\s*typeof\s+fetch)?\s*=\s*(?:globalThis|Bun)?\??\.?fetch\s*[,)]/g,
				'default parameter',
			],
			// …and the one no spelling list can finish: `deps.fetch ?? fetch`,
			// `fetchImpl: fetch`, `connect(url, fetch)`. Any VALUE reference.
			[FETCH_VALUE, 'value reference'],
		];
		const SEAM_FORMS = new Set(['default parameter', 'value reference']);
		// A seam is a real outbound site when nobody passes an implementation: it is
		// exempt here only because FETCH_SEAMS enumerates it, and it is counted as a
		// site in BOUNDED_BY below.
		const aliases: string[] = [];
		for (const file of sourceFiles()) {
			const source = code(file);
			for (const [pattern, form] of ALIAS_FORMS) {
				for (const match of source.matchAll(pattern)) {
					const line = source.slice(0, match.index as number).split('\n').length;
					if (
						/typeof\s+$/.test(source.slice(Math.max(0, (match.index as number) - 40), match.index))
					)
						continue;
					if (SEAM_FORMS.has(form) && FETCH_SEAMS[file] !== undefined) continue;
					aliases.push(`${file}:${line} (${form})`);
				}
			}
		}
		expect(aliases, 'an aliased fetch cannot be censused — call it directly').toEqual([]);

		// The enumerated seams must still be bounded — the exemption covers being
		// invisible to the census, never being unbounded.
		const unboundedSeams = Object.keys(FETCH_SEAMS).filter(
			(f) => !/signal:\s*AbortSignal\.timeout\(|signal:\s*\w+\.signal/.test(code(f)),
		);
		expect(unboundedSeams, 'a declared fetch seam makes an unbounded call').toEqual([]);
		// Shrink-only: a seam row whose file no longer hands fetch over is cover for
		// the next one.
		const seamFiles = new Set(seamSites().map((site) => site.file));
		const staleSeams = Object.keys(FETCH_SEAMS).filter((f) => !seamFiles.has(f));
		expect(staleSeams, 'FETCH_SEAMS names files that no longer pass fetch as a value').toEqual([]);
	});

	test('every fetching file declares how its responses are bounded, and how many calls it makes', () => {
		// A seam's value reference IS its outbound site (FETCH_SEAMS), so it counts.
		const perFile = new Map<string, number>();
		for (const site of [...fetchSites(), ...seamSites()]) {
			perFile.set(site.file, (perFile.get(site.file) ?? 0) + 1);
		}
		const problems: string[] = [];
		for (const [file, count] of perFile) {
			const declared = BOUNDED_BY[file];
			if (declared === undefined) {
				problems.push(`${file}: undeclared — state its byte bound in BOUNDED_BY`);
			} else if (declared.sites !== count) {
				problems.push(
					`${file}: ${count} outbound calls, ${declared.sites} declared — a new call is not covered by an old reason`,
				);
			}
		}
		expect(problems).toEqual([]);
	});

	test('the declarations describe files that still fetch', () => {
		// The converse, so the list cannot rot into claims about code that is gone
		// and become cover for something new.
		const fetching = new Set([...fetchSites(), ...seamSites()].map((s) => s.file));
		const stale = Object.keys(BOUNDED_BY).filter((f) => !fetching.has(f));
		expect(stale, 'BOUNDED_BY names files that no longer fetch — delete the rows').toEqual([]);
	});

	test('the guarded primitive is what applies the public-address policy', () => {
		// One primitive, two entry policies. If the split collapses, the next
		// private-destination caller copies a bare fetch — which is how this
		// happened the first time. Measured over each door's CALL CLOSURE (every
		// function of the guard it reaches), not its own body: a policy moved into a
		// helper is still applied, and one smuggled in through a helper is still seen.
		const guarded = guardClosure('fetchGuardedText');
		expect(guarded.calls, 'fetchGuardedText must still apply the address policy').toContain(
			'assertPublicUrl',
		);
		// SURF-2 (2026-09-30): that the public door CONNECTS TO WHAT IT VETTED (one
		// connection, to the vetted IP, the name resolved once) is an OUTCOME, and its
		// gate of record is test/unit/guarded_text_pin_native.test.ts (a rebinding
		// resolver through the door's seam) — not helper names in this closure, which a
		// rename would defeat.

		const transport = guardClosure('fetchBoundedText');
		expect(
			transport.calls,
			'the transport half must stay usable by a private destination',
		).not.toContain('assertPublicUrl');

		// AND IT MUST ENFORCE WHAT BOUNDED_BY CLAIMS FOR IT. A written claim nobody
		// checks is worth nothing, and this one is load-bearing for every delegator.
		// These are STRUCTURE checks, secondary: the OUTCOMES — a 302 refused with its
		// Location never contacted, a closed port typed transport/connect, the caller's
		// deadline and the 15 s default, the job's stop reaching the connect — are gated
		// on a loopback peer in guarded_text_pin_native (its fetchBoundedText describe).
		expect(transport.abortTimer, 'no abort timer').toBe(true);
		expect(transport.calls, 'the byte ceiling is not the shared capped reader').toContain(
			'readBytesCapped',
		);
		// The VALUE, read from the AST: this file blanks string literals for the
		// census, so a text check could only have seen the property name.
		expect([...transport.redirectModes], 'a redirect re-chooses the target').toEqual(['error']);
	});

	test('the pinned hop enforces what BOUNDED_BY claims for it — the same ceiling, its own redirect policy', () => {
		// BOUNDED_BY says "in fetchBoundedText AND in fetchPinnedHop". Only the first
		// half used to be asserted, so the harvesting door's primitive could lose its
		// timer, its ceiling or its pin with this gate green.
		const hop = guardClosure('fetchPinnedHop');
		expect(
			hop.calls,
			'the guard must run INSIDE the primitive, never be left to its caller',
		).toContain('assertPublicUrl');
		expect(hop.calls, 'the socket is not pinned to the vetted address').toContain(
			'pinToVettedAddress',
		);
		expect(hop.calls, 'the body is not read through the shared capped reader').toContain(
			'readBytesCapped',
		);
		expect(hop.abortTimer, 'no total deadline').toBe(true);
		expect(
			[...hop.redirectModes],
			'the hop must hand a redirect BACK (manual), never follow it or throw on it',
		).toEqual(['manual']);
		expect(
			hop.calls,
			'the hop must not ride the single-call door and its redirect refusal',
		).not.toContain('fetchBoundedText');

		const reader = guardClosure('readBytesCapped');
		expect(reader.calls, 'over the ceiling the body must be cancelled, not drained').toContain(
			'cancel',
		);
	});

	test('the external door uses the SAME reader and the SAME pin, not copies of them', () => {
		// `transport.ts` once carried its own byte-cap loop ("a streamed cap is four
		// lines"). Two copies of a security primitive drift; the fix is one copy.
		const calls = importedCalls('src/external/transport.ts', 'src/core/security/ssrf_guard.ts');
		expect(calls, 'transport.ts reads its body with its own loop again').toContain(
			'readBytesCapped',
		);
		expect(calls, 'transport.ts pins its socket with its own code again').toContain(
			'pinToVettedAddress',
		);
	});

	test('every caller of the unguarded transport applies an address policy', () => {
		// fetchBoundedText is an outbound door with no address check by design.
		// What keeps it safe is this census.
		const callers = sourceFiles().filter((f) => /\bfetchBoundedText\s*\(/.test(code(f)));
		expect(callers.length, 'the transport has no callers — has it been renamed?').toBeGreaterThan(
			1,
		);
		const undeclared = callers.filter((f) => ADDRESS_POLICY[f] === undefined);
		expect(
			undeclared,
			'a caller of the unguarded transport must declare its own address policy in ADDRESS_POLICY',
		).toEqual([]);
		// …and the policy must GUARD the call, not merely appear in the file. Every
		// exported entry point that reaches the transport has to run the check
		// itself: a policy called once, somewhere else, guards nothing.
		const notApplied: string[] = [];
		for (const file of callers) {
			const source = code(file);
			const policy = /isSafeLocalAsrUrl\(|assertPublicUrl\(|assertConfiguredMasterUrl\(/g;
			const guards = [...source.matchAll(policy)].length;
			const uses = [...source.matchAll(/fetchBoundedText\s*\(/g)].length;
			if (guards < uses) {
				notApplied.push(`${file}: ${uses} transport calls, ${guards} address checks`);
			}
		}
		expect(
			notApplied,
			'a caller reaches the unguarded transport more often than it checks the address',
		).toEqual([]);
	});

	test('the private agent channel dials only what its own address policy produced', () => {
		const door = 'src/core/publication_host/transport.ts';
		expect(
			ADDRESS_POLICY[door],
			'the agent channel lost its declared address policy',
		).toBeDefined();
		const sites = fetchSites().filter((site) => site.file === door);
		expect(sites.length, 'the agent channel makes exactly one call').toBe(1);
		expect(
			callArgument(sites[0]?.call ?? '', 0).trim(),
			'the URL dialled is not the policy’s output',
		).toBe('target.url');
		const source = code(door);
		expect(source, 'agentTarget is gone').toMatch(/function agentTarget\s*\(/);
		expect(source, 'the target is not built by agentTarget').toMatch(
			/const\s+target\s*=\s*agentTarget\s*\(/,
		);
		expect(
			importedCalls(door, 'src/core/security/ssrf_guard.ts'),
			'the agent channel reads its body with a loop of its own',
		).toContain('readBytesCapped');
	});

	test('the ontology manifest client judges the URL it dials, then uses the primitive', () => {
		// Behaviour (a non-configured URL refused before any socket, the stand-in
		// counting zero requests) is test/unit/ontology_manifest_native.test.ts; this
		// leg pins that the ONE transport call dials the URL the policy just judged.
		const manifest = code('src/core/ontology/ontology_manifest.ts');
		expect(manifest, 'the manifest client re-grew its own transport').not.toMatch(
			/(?<![\w$.])fetch\s*\(/,
		);
		const calls = [...manifest.matchAll(/fetchBoundedText\s*\(\s*([\w.]+)/g)];
		expect(calls.length, 'the manifest client makes exactly one transport call').toBe(1);
		const dialled = calls[0]?.[1] as string;
		const judged = new RegExp(
			`assertConfiguredMasterUrl\\(\\s*${dialled.replace('.', '\\.')}\\s*,`,
		);
		const policyAt = manifest.search(judged);
		expect(
			policyAt,
			`the URL dialled (${dialled}) is not the one the policy judged`,
		).toBeGreaterThan(-1);
		expect(policyAt, 'the policy must run BEFORE the transport call').toBeLessThan(
			calls[0]?.index as number,
		);
	});

	test('the on-premise transcriber uses the primitive, not a third copy', () => {
		const asr = code('src/core/tools/transcription_local_asr.ts');
		expect(asr, 'the ASR provider re-grew its own transport').not.toMatch(/(?<![\w$.])fetch\s*\(/);
		expect(asr).toMatch(/fetchBoundedText\(/);
		expect(asr).toMatch(/isSafeLocalAsrUrl\(/);
	});

	test('BOTH model transports are idle-bounded, including the default one', () => {
		// curl is the DEFAULT path (`haveCurl() ? curlFetch : plainFetch`), so a
		// gate that only watched the fallback watched the minority of installs.
		// An IDLE bound, never a total one: a multi-GB artifact on a museum's
		// uplink legitimately runs for hours, and what must not last is silence.
		// CALL IT AND READ THE ARGV. Asserting that the flag STRINGS appear in the
		// body proved nothing: measured, `'--speed-limit','0','--speed-time','0'`
		// — which disables curl's idle abort entirely, so curl waits forever, the
		// exact condition this bound exists to forbid — passed, and so did
		// `...(false ? [...] : [])`, an argv with no bound at all reachable.
		const argv = curlArgv('/tmp/t', 'https://example.invalid/w', true);
		const bound = (flag: string): number => {
			const at = argv.indexOf(flag);
			expect(at, `${flag} never reaches the argv`).toBeGreaterThan(-1);
			return Number(argv[at + 1]);
		};
		expect(bound('--speed-limit'), 'a floor of 0 bytes/s means curl waits forever').toBeGreaterThan(
			0,
		);
		expect(bound('--speed-time'), 'a window of 0 disables the abort').toBeGreaterThan(0);
		// A TOTAL deadline would kill a healthy multi-GB transfer on a museum's
		// uplink; the bound must stay a bound on SILENCE.
		expect(argv, 'a total deadline is the wrong instrument here').not.toContain('--max-time');

		// The FALLBACK transport's bound is not asserted here at all any more. It is
		// behavioural — "a stalled peer stops holding the lane and leaves nothing on
		// disk" — and the source-shape version of it was measured to be defeated by
		// renaming one local (`const sink = target; await Bun.write(sink, …)` left
		// the gate green over the exact >8s hang). It is driven against a loopback
		// peer in ai_model_fetch_native.test.ts, "the fallback transport is bounded
		// by silence, not by hope". This assertion only pins that the two live in
		// the same place, so deleting the behavioural gate is visible from here.
		expect(
			readFileSync(join(REPO_ROOT, 'test/unit/ai_model_fetch_native.test.ts'), 'utf8'),
			'the behavioural bound gate for plainFetch is gone',
		).toContain('bounded by silence, not by hope');
	});
});

// ---------------------------------------------------------------------------
// …AND DRIVEN. The AST closure above proves the pieces are WIRED; these prove
// they WORK: the ceiling holds and cancels, the pin reaches the socket, the
// guard runs before one opens. Hermetic — the resolver and the socket are the
// primitive's own injectable seams, so no packet leaves the machine.
// ---------------------------------------------------------------------------

/** A body of `chunks` (sizes in bytes) that records whether it was cancelled; `stall` never ends. */
function body(
	chunks: readonly number[],
	stall = false,
): { response: Response; cancelled: () => boolean } {
	let cancelled = false;
	let next = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			const size = chunks[next++];
			if (size !== undefined) controller.enqueue(new Uint8Array(size));
			else if (stall) return new Promise<void>(() => undefined);
			else controller.close();
			return undefined;
		},
		cancel() {
			cancelled = true;
		},
	});
	return { response: new Response(stream), cancelled: () => cancelled };
}

/** The error a promise rejects with (fails the test when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection, got an answer');
}

function reasonOf(error: unknown): string | number | undefined {
	return isDedaloError(error) ? error.coordinates?.reason : undefined;
}

const PUBLIC_ADDRESS = '93.184.216.34';

/** A hop to a public NAME, with the resolver and the socket replaced by recorders. */
function hopRig(
	answer: (init: RequestInit) => Promise<Response> | Response,
	address = PUBLIC_ADDRESS,
) {
	const sent: Array<{ url: string; init: RequestInit & { tls?: { serverName?: string } } }> = [];
	const deps = {
		lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
		fetch: async (url: string | URL | Request, init?: RequestInit) => {
			sent.push({ url: String(url), init: init ?? {} });
			return answer(init ?? {});
		},
	};
	const request: PinnedHopRequest = {
		url: new URL('https://catalogue.example/lot/1'),
		method: 'GET',
		headers: new Headers(),
		maxBytes: 64,
		timeoutMs: 2_000,
	};
	return { sent, deps: deps as unknown as Parameters<typeof fetchPinnedHop>[1], request };
}

describe('the primitives, driven', () => {
	test('readBytesCapped: over the ceiling it refuses AND cancels the body', async () => {
		const peer = body([40, 40, 40]);
		const error = await rejection(readBytesCapped(peer.response, 64));
		expect(reasonOf(error), 'the breach is not the typed body_cap refusal').toBe('body_cap');
		expect(peer.cancelled(), 'the rest of the body was drained, not cancelled').toBe(true);
	});

	test('readBytesCapped: truncate mode keeps the ceiling, says so, and cancels', async () => {
		const peer = body([40, 40, 40]);
		const read = await readBytesCapped(peer.response, 64, { overflow: 'truncate' });
		expect(read.truncated).toBe(true);
		expect(read.bytes.byteLength).toBeLessThanOrEqual(64);
		expect(peer.cancelled()).toBe(true);
	});

	test('readBytesCapped: a body under the ceiling arrives whole, untruncated', async () => {
		const read = await readBytesCapped(body([10, 20]).response, 64);
		expect(read.bytes.byteLength).toBe(30);
		expect(read.truncated).toBe(false);
	});

	test('readBytesCapped: a peer that goes SILENT is a FAILURE at the idle bound, never a short success', async () => {
		// Cancelling the stream settles its pending read as `done`; if that wins the
		// race, the first bytes come back as the WHOLE body (`truncated: false`) —
		// a half catalogue page accepted as the page. Measured 2026-09-29.
		const started = Date.now();
		const error = await rejection(
			readBytesCapped(body([10], true).response, 64, { idleTimeoutMs: 50 }),
		);
		expect(reasonOf(error), 'a stalled body must fail as idle').toBe('idle');
		expect(Date.now() - started, 'the idle bound did not bound anything').toBeLessThan(1_500);
	});

	test('fetchPinnedHop: the socket goes to the VETTED address, redirect manual, a signal armed', async () => {
		const rig = hopRig(() => new Response('ok'));
		const answer = await fetchPinnedHop(rig.request, rig.deps);
		expect(answer.status).toBe(200);
		const sent = rig.sent[0];
		expect(new URL(sent?.url ?? 'http://x').hostname, 'the socket re-resolved the name').toBe(
			PUBLIC_ADDRESS,
		);
		expect(new Headers(sent?.init.headers).get('host'), 'the real host was lost').toBe(
			'catalogue.example',
		);
		expect(sent?.init.tls?.serverName, 'TLS would verify the IP, not the host').toBe(
			'catalogue.example',
		);
		expect(sent?.init.redirect).toBe('manual');
		expect(sent?.init.signal instanceof AbortSignal, 'no cancellation reaches the socket').toBe(
			true,
		);
	});

	test('fetchPinnedHop: an inward address is refused BEFORE any socket opens', async () => {
		for (const inward of ['127.0.0.1', '10.0.0.7', '::ffff:7f00:1', '169.254.169.254']) {
			const rig = hopRig(() => new Response('secret'), inward);
			const error = await rejection(fetchPinnedHop(rig.request, rig.deps));
			expect(isAddressRefusal(error), `${inward}: not an address refusal`).toBe(true);
			expect(rig.sent, `${inward}: a socket opened to it`).toEqual([]);
		}
	});

	test('fetchPinnedHop: a redirect comes back unread, for the caller to vet', async () => {
		const peer = body([40, 40, 40]);
		const rig = hopRig(
			() => new Response(peer.response.body, { status: 302, headers: { location: '/moved' } }),
		);
		const answer = await fetchPinnedHop(rig.request, rig.deps);
		expect(answer.location).toBe('/moved');
		expect(answer.bytes.byteLength).toBe(0);
		expect(rig.sent.length, 'the primitive followed the redirect itself').toBe(1);
	});

	test('fetchPinnedHop: the byte ceiling and the deadline hold', async () => {
		const big = hopRig(() => body([40, 40, 40]).response);
		expect(reasonOf(await rejection(fetchPinnedHop(big.request, big.deps)))).toBe('body_cap');

		const silent = hopRig(
			(init) =>
				new Promise<Response>((_, reject) => {
					init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
				}),
		);
		const started = Date.now();
		const error = await rejection(
			fetchPinnedHop({ ...silent.request, timeoutMs: 50 }, silent.deps),
		);
		expect(reasonOf(error)).toBe('timeout');
		expect(Date.now() - started).toBeLessThan(1_500);

		// The TOTAL deadline covers the body too: a body that stalls past it is a
		// failure, never its first bytes returned as a complete 200.
		const stalls = hopRig(() => body([10], true).response);
		const cut = await rejection(fetchPinnedHop({ ...stalls.request, timeoutMs: 50 }, stalls.deps));
		expect(reasonOf(cut), 'a body cut by the deadline came back as a whole answer').toBe('timeout');
		const idle = hopRig(() => body([10], true).response);
		const quiet = await rejection(
			fetchPinnedHop({ ...idle.request, timeoutMs: 5_000, idleTimeoutMs: 50 }, idle.deps),
		);
		expect(reasonOf(quiet), 'a silent body came back as a whole answer').toBe('idle');
	});
});
