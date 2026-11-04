/**
 * THE `own` CONTEXT CENSUS — every structure-context door that does NOT
 * serialise its request_config from an element node is named here, with its
 * reason (nested-ddo_map W3, 2026-11-03).
 *
 * buildStructureContext takes a REQUIRED `configFrom`
 * (resolve/structure_context.ts ContextConfigSource): `emission` (the element
 * node the data half resolved — the context and the data cannot disagree) or
 * `own` with a reason from the CLOSED list OWN_CONTEXT_REASONS. An `own` build
 * of an element that a read DID emit is exactly the tch197 defect (rsc1400's
 * context shipped its own [rsc85, rsc86] while its data followed the caller's
 * [rsc86, rsc85]), so a new `own` door must be a decision, not a default:
 *
 *  - every `own` site in src/ + tools/ + scripts/ spells its reason as a LITERAL key of
 *    OWN_CONTEXT_REASONS (no computed reason, no unknown key);
 *  - the (file, reason) → count map below is EXACT: a new `own` caller fails
 *    until it is added here with its reason; a removed one fails until the map
 *    shrinks (the census stays true);
 *  - `unit-test` never appears in production code;
 *  - every reason (but `unit-test`) is used by some site, so the closed list
 *    carries no dead justification;
 *  - the CALL SITES are censused too (CALL_SITES): every `buildStructureContext(`
 *    call is classified by its `configFrom` expression — a literal own source,
 *    a node-else-own ternary, or a call to a CLOSED helper (CONFIG_HELPERS,
 *    each mentioned only in its home file) — and the (file, kind) → count map
 *    is EXACT. A reason literal counted once can feed many doors through a
 *    shared helper or a hoisted constant; counting the calls closes that.
 *
 * ONE door ships an own-config ddo echo WITHOUT buildStructureContext, named
 * in NON_BUILDER_DOORS with its reason (it is not a structure context: a
 * search answer's column echo).
 *
 * Comments are stripped before scanning (test/helpers/strip_comments.ts): a doc
 * naming a reason is not a door.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWN_CONTEXT_REASONS } from '../../src/core/resolve/structure_context.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

/** THE CENSUS: `file :: reason` → number of `own` sites. */
const OWN_SITES: Readonly<Record<string, number>> = {
	// start / menu / tool-shell builds: no caller, no data emission
	'src/core/api/handlers/dd_core_api.ts :: area-or-menu': 5,
	// get_element_context: one element built in isolation
	'src/core/api/handlers/dd_core_api.ts :: element-context-request': 1,
	'src/core/area/read.ts :: area-or-menu': 1,
	// the picker caller's view probe (no read, no caller)
	'src/core/area/read.ts :: element-context-request': 1,
	// filter_by_list + section_elements_context: the search panel's simple contexts
	'src/core/relations/request_config/filters.ts :: search-panel-element': 1,
	'src/core/resolve/section_elements_context.ts :: search-panel-element': 2,
	// dd15: the TM section itself; a column with no emitted cell (empty page)
	'src/core/resolve/read_tm.ts :: section-root': 1,
	'src/core/resolve/read_tm.ts :: tm-column-without-cell': 1,
	// derived item contexts that a node cannot stand for (node_contexts.ts itemConfigSource)
	'src/core/section/node_contexts.ts :: item-without-node': 1,
	'src/core/section/node_contexts.ts :: one-level-expansion': 1,
	'src/core/section/node_contexts.ts :: item-mode-restamped': 1,
	// the section read's own section entry WITHOUT a client show (a client show
	// builds it from stage 1); a component-sourced read's caller entry; a
	// grouper/button column; the dd560 frame; a get_data main with no resolvable node
	'src/core/section/read.ts :: section-root': 1,
	'src/core/section/read.ts :: component-sourced-root': 1,
	'src/core/section/read.ts :: non-component-element': 1,
	'src/core/section/read.ts :: iri-label-dataframe': 1,
	'src/core/section/read.ts :: item-without-node': 1,
};

/**
 * THE CALL-SITE CENSUS: `file :: kind` → number of buildStructureContext calls,
 * kind = the call's configFrom (callSiteKind): `own:<reason>` (a literal),
 * `node|own:<reason>` (emission when a node exists, else that literal),
 * `helper:<name>` (a CONFIG_HELPERS call), `param:<name>` (a pass-through
 * parameter — only inside a helper's home file).
 */
const CALL_SITES: Readonly<Record<string, number>> = {
	'src/core/api/handlers/dd_core_api.ts :: own:area-or-menu': 5,
	'src/core/api/handlers/dd_core_api.ts :: own:element-context-request': 1,
	'src/core/area/read.ts :: own:area-or-menu': 1,
	'src/core/area/read.ts :: own:element-context-request': 1,
	'src/core/relations/request_config/filters.ts :: own:search-panel-element': 1,
	'src/core/resolve/section_elements_context.ts :: own:search-panel-element': 2,
	'src/core/resolve/read_tm.ts :: own:section-root': 1,
	'src/core/resolve/read_tm.ts :: helper:tmColumnConfigFrom': 1,
	// buildItemEntry: its configFrom is itemConfigSource's (appendItemContexts)
	'src/core/section/node_contexts.ts :: param:configFrom': 1,
	// buildSectionEntry: stage 1 for a client show, else own (sectionEntryConfigFrom)
	'src/core/section/read.ts :: helper:sectionEntryConfigFrom': 1,
	'src/core/section/read.ts :: node|own:non-component-element': 1,
	// the dd560 frame: from the emitted frame's node, synthetic only when none was emitted
	'src/core/section/read.ts :: node|own:iri-label-dataframe': 1,
	'src/core/section/read.ts :: node|own:item-without-node': 1,
};

/**
 * The CLOSED set of helpers that compute a configFrom, each with the ONE file
 * allowed to name it (no importer elsewhere: a new door cannot borrow a
 * helper's `own` branch past the census).
 */
const CONFIG_HELPERS: Readonly<Record<string, string>> = {
	itemConfigSource: 'src/core/section/node_contexts.ts',
	tmColumnConfigFrom: 'src/core/resolve/read_tm.ts',
	sectionEntryConfigFrom: 'src/core/section/read.ts',
};

/**
 * Doors that ship an OWN-config ddo as wire `context` without
 * buildStructureContext: `file :: function` → reason. Each named function must
 * still exist in its file (a refactor revisits the entry).
 */
const NON_BUILDER_DOORS: Readonly<Record<string, string>> = {
	'src/core/api/handlers/dd_external_api.ts :: resolveExternalSearchTarget':
		'external search (service_autocomplete): the answer echoes the caller element OWN external ' +
		"engine ddos as its column context. The rqo carries only the caller's tipo/section (no " +
		'caller chain), and the request that leaves the installation is built from the ontology ' +
		'only (EXTERNAL_SPEC) — a caller-injected external show map is not resolvable here',
};

/** A literal `own` source: `source: 'own', reason: '<key>'`. */
const OWN_LITERAL = /source:\s*'own',\s*reason:\s*'([a-z-]+)'/g;
/** Any `own` source spelling (literal or not) — each must be a literal above. */
const OWN_ANY = /source:\s*'own'/g;

/** The engine-process corpus (src + tools + scripts — the registered shared lister). */
function scanFiles(): string[] {
	const files = writePathSourceFiles().filter((file) => !file.includes('/node_modules/'));
	expect(files.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
	return files;
}

/** The measured census, plus every non-literal `own` spelling found. */
async function measure(): Promise<{ sites: Record<string, number>; nonLiteral: string[] }> {
	const sites: Record<string, number> = {};
	const nonLiteral: string[] = [];
	for (const file of scanFiles()) {
		const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
		const literal = [...code.matchAll(OWN_LITERAL)];
		const any = [...code.matchAll(OWN_ANY)].length;
		// The ContextConfigSource TYPE spells `source: 'own'; readonly reason:` —
		// a declaration, not a door.
		const declarations =
			file === 'src/core/resolve/structure_context.ts'
				? [...code.matchAll(/source:\s*'own';/g)].length
				: 0;
		if (any - declarations !== literal.length) nonLiteral.push(file);
		for (const match of literal) {
			const key = `${file} :: ${match[1]}`;
			sites[key] = (sites[key] ?? 0) + 1;
		}
	}
	return { sites, nonLiteral };
}

/** The index just past the bracket closing the one opened at `open` (strings skipped). */
function closingIndex(code: string, open: number): number {
	let depth = 0;
	for (let index = open; index < code.length; index += 1) {
		const char = code[index];
		if (char === "'" || char === '"' || char === '`') {
			index = code.indexOf(char, index + 1);
			if (index === -1) return code.length;
			continue;
		}
		if (char === '(' || char === '{' || char === '[') depth += 1;
		if (char === ')' || char === '}' || char === ']') {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	return code.length;
}

/** The configFrom expression of one call's argument text (shorthand = the name), else null. */
function configFromExpression(args: string): string | null {
	const match = /\bconfigFrom\b\s*([:,}\n])/.exec(args);
	if (match === null) return null;
	if (match[1] !== ':') return 'configFrom';
	let index = match.index + match[0].length;
	const start = index;
	let depth = 0;
	for (; index < args.length; index += 1) {
		const char = args[index] as string;
		if (char === "'" || char === '"' || char === '`') {
			index = args.indexOf(char, index + 1);
			continue;
		}
		if ('({['.includes(char)) depth += 1;
		if (')}]'.includes(char)) {
			if (depth === 0) break;
			depth -= 1;
		}
		if (char === ',' && depth === 0) break;
	}
	return args.slice(start, index).replace(/\s+/g, ' ').trim();
}

/** A call's configFrom kind (CALL_SITES), or `other:<expression>`. */
function callSiteKind(expression: string | null): string {
	if (expression === null) return 'missing';
	const own = /^\{ source: 'own', reason: '([a-z-]+)',? \}$/.exec(expression);
	if (own !== null) return `own:${own[1]}`;
	const ternary =
		/^[\w.]+ !== null \? \{ source: 'emission', node(: \w+)? \} : \{ source: 'own', reason: '([a-z-]+)' \}$/.exec(
			expression,
		);
	if (ternary !== null) return `node|own:${ternary[2]}`;
	const helper = /^(\w+)\(/.exec(expression);
	if (helper !== null) return `helper:${helper[1]}`;
	if (/^\w+$/.test(expression)) return `param:${expression}`;
	return `other:${expression}`;
}

/** Every buildStructureContext CALL in `code` (not its declaration), as its kind. */
function callSiteKinds(code: string): string[] {
	const kinds: string[] = [];
	for (const match of code.matchAll(/(function\s+)?\bbuildStructureContext\s*\(/g)) {
		if (match[1] !== undefined) continue;
		const open = (match.index ?? 0) + match[0].length - 1;
		kinds.push(callSiteKind(configFromExpression(code.slice(open, closingIndex(code, open)))));
	}
	return kinds;
}

/** The measured call-site census, and every file naming a helper outside its home. */
function measureCallSites(): { sites: Record<string, number>; strayHelpers: string[] } {
	const sites: Record<string, number> = {};
	const strayHelpers: string[] = [];
	for (const file of scanFiles()) {
		const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
		for (const kind of callSiteKinds(code)) {
			const key = `${file} :: ${kind}`;
			sites[key] = (sites[key] ?? 0) + 1;
		}
		for (const [helper, home] of Object.entries(CONFIG_HELPERS)) {
			if (file !== home && new RegExp(`\\b${helper}\\b`).test(code)) {
				strayHelpers.push(`${file} :: ${helper}`);
			}
		}
	}
	return { sites, strayHelpers };
}

describe('the own-context census', () => {
	test('the corpus walk really read the tree (a floor bound to the walk)', () => {
		const files = scanFiles();
		expect(files.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
	});

	test('every own site spells a LITERAL reason', async () => {
		const { nonLiteral } = await measure();
		expect(nonLiteral, 'an own configFrom with a computed reason — spell the key').toEqual([]);
	});

	test('every reason is a key of OWN_CONTEXT_REASONS', async () => {
		const { sites } = await measure();
		const known = new Set(Object.keys(OWN_CONTEXT_REASONS));
		const unknown = Object.keys(sites).filter((key) => !known.has(key.split(' :: ')[1] ?? ''));
		expect(unknown).toEqual([]);
	});

	test("'unit-test' never appears in production code", async () => {
		const { sites } = await measure();
		expect(Object.keys(sites).filter((key) => key.endsWith(':: unit-test'))).toEqual([]);
	});

	test('the census is EXACT (a new own door is a decision, recorded here)', async () => {
		const { sites } = await measure();
		expect(sites).toEqual(OWN_SITES as Record<string, number>);
	});

	test('every reason but unit-test is used (no dead justification)', () => {
		const used = new Set(Object.keys(OWN_SITES).map((key) => key.split(' :: ')[1]));
		const unused = Object.keys(OWN_CONTEXT_REASONS).filter(
			(reason) => reason !== 'unit-test' && !used.has(reason),
		);
		expect(unused).toEqual([]);
	});

	test('the CALL-SITE census is EXACT (a door reusing an own helper or constant is a decision too)', () => {
		const { sites } = measureCallSites();
		expect(sites).toEqual(CALL_SITES as Record<string, number>);
	});

	test('every configFrom helper is named only in its home file (no importer can borrow its own branch)', () => {
		expect(measureCallSites().strayHelpers).toEqual([]);
	});

	test('every non-builder door still exists where it is named', () => {
		for (const door of Object.keys(NON_BUILDER_DOORS)) {
			const [file, fn] = door.split(' :: ') as [string, string];
			const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
			expect(new RegExp(`function\\s+${fn}\\b`).test(code), door).toBe(true);
		}
	});

	test('positive control: the call-site scanner classifies each configFrom shape', () => {
		const sample = [
			"buildStructureContext({ tipo, configFrom: { source: 'own', reason: 'section-root' } });",
			'buildStructureContext({ a: f(x), configFrom: helperOf(node, item), b: 1 });',
			'buildStructureContext({ tipo, configFrom });',
			"buildStructureContext({ configFrom:\n node !== null\n ? { source: 'emission', node }\n : { source: 'own', reason: 'item-without-node' },\n });",
			"const OWN = { source: 'own', reason: 'section-root' }; buildStructureContext({ configFrom: OWN });",
			'export async function buildStructureContext(options) {}',
		].join('\n');
		expect(callSiteKinds(sample)).toEqual([
			'own:section-root',
			'helper:helperOf',
			'param:configFrom',
			'node|own:item-without-node',
			'param:OWN',
		]);
	});

	test('positive control: the scanner sees a literal and a computed own source', () => {
		const sample = stripComments(
			"x({ configFrom: { source: 'own', reason: 'section-root' } });\n" +
				"// { source: 'own', reason: 'area-or-menu' } (a comment — not a door)\n" +
				"y({ configFrom: { source: 'own', reason } });\n",
		);
		expect([...sample.matchAll(OWN_LITERAL)].map((match) => match[1])).toEqual(['section-root']);
		expect([...sample.matchAll(OWN_ANY)].length).toBe(2);
	});
});
