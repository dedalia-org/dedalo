/**
 * A model='label' node is NEVER resolved through the ontology (owner decision
 * 2026-10-12; guard + rationale in src/core/ontology/label_node_guard.ts).
 *
 * Program strings come from the labels engine (src/core/labels/, getLabels);
 * the v7 master ontology may reuse a retired label tipo for another node, so a
 * term lookup on one serves whatever owns that tipo today. OUTCOME legs, on a
 * situation this file builds (a zzlbl scratch TLD on the suite database,
 * assertTestDatabase first, torn down after), for EVERY guarded home of
 * TERM_READ_LEDGER (RESOLVERS below; a ledger `guarded` file without one reds),
 * each through a public caller or its exported seam:
 *
 *  - FAIL-LOUD (this test process): a typed internal.invariant on every call;
 *  - PRODUCTION (seam: runWithLabelGuardTestPosture({testProcess:false}) with
 *    DEDALO_DEV_MODE=false): the resolver's documented fallback, no throw,
 *    exactly ONE log line per tipo across repeated calls, and the fallback is
 *    NOT cached (the very next fail-loud call still throws — no cache clear in
 *    between, so a cached refusal would answer instead; a home with its own
 *    cache — diffusion's ctx.sectionLabelCache — is asserted to hold no entry
 *    for the refused tipo, and to hold one for a resolved tipo);
 *  - DEDALO_DEV_MODE ALONE arms fail-loud (test-process flag simulated off);
 *  - a node reused under a non-label model resolves its term after the
 *    ontology caches clear (the refusal left nothing behind);
 *  - a non-label node beside it resolves normally.
 *
 * CENSUS leg: every SQL string/template LITERAL in src/ that SELECTs `term` (or
 * `*`) FROM dd_ontology — a select-list `${IDENT}` hole resolved to a same-file
 * const string, an unresolved hole counted as a term read — is ledgered per
 * file, counted per statically checked basis (see CensusBasis). A new literal,
 * a removed one, or a ledger claim the literal does not satisfy reds it. It
 * checks the SQL text and the containing function's refuseLabelNode call only:
 * SQL assembled outside one literal, and what a `full-row` consumer does with
 * `model`, are NOT checked.
 *
 * SEAM leg: runWithLabelGuardTestPosture refuses (internal.invariant) in a real
 * NODE_ENV=production child process, with a NODE_ENV=test control.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from 'bun:test';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parse } from '@babel/parser';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	LABEL_NODE_MODEL,
	runWithLabelGuardTestPosture,
} from '../../src/core/ontology/label_node_guard.ts';
import {
	getOntologyTermLabel,
	labelByTipo,
	ontologyTermLabel,
	termByTipo,
} from '../../src/core/ontology/labels.ts';
import { getTermByTipo } from '../../src/core/ontology/resolver.ts';
import { buildRecordMetadata } from '../../src/core/section/record/create_record.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { sectionLabelAtoms } from '../../src/diffusion/resolve/resolver.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { ENGINE_SRC, engineSourceFiles } from '../helpers/engine_source_corpus.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { extractSourceLiterals, normalizeSqlLiteral } from '../helpers/sql_literals.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const TLD = 'zzlbl';
const LABEL_NODE = `${TLD}1`;
const PLAIN_NODE = `${TLD}2`;
const REUSED_NODE = `${TLD}3`;
const LANG = 'lg-eng';

interface GuardedResolver {
	readonly name: string;
	readonly run: (tipo: string) => Promise<unknown>;
	/** The documented production answer for a refused label node. */
	readonly fallback: (tipo: string) => unknown;
	/** The home's TERM_READ_LEDGER file (every `guarded` file needs a resolver). */
	readonly file: string;
	/** A home with its own cache: does it hold an entry for `tipo`? */
	readonly cached?: (tipo: string) => boolean;
}

/**
 * diffusion sectionLabelAtoms' per-run cache: ONE run per test (reset in
 * beforeEach), so repeated calls inside a test share it as a real run would.
 */
let diffusionRun: { sectionLabelCache: Map<string, Record<string, string> | null> } = {
	sectionLabelCache: new Map(),
};

const LABELS_TS = 'src/core/ontology/labels.ts';
const RESOLVERS: readonly GuardedResolver[] = [
	{
		name: 'termByTipo',
		file: LABELS_TS,
		run: (tipo) => termByTipo(tipo, LANG),
		fallback: (tipo) => tipo,
	},
	{
		name: 'labelByTipo',
		file: LABELS_TS,
		run: (tipo) => labelByTipo(tipo, LANG),
		fallback: () => null,
	},
	{
		name: 'ontologyTermLabel',
		file: LABELS_TS,
		run: (tipo) => ontologyTermLabel(tipo, LANG),
		fallback: (tipo) => `${tipo} [${tipo}]`,
	},
	{
		name: 'getTermByTipo',
		file: 'src/core/ontology/resolver.ts',
		run: (tipo) => getTermByTipo(tipo, LANG),
		fallback: () => null,
	},
	{
		name: 'getOntologyTermLabel',
		file: LABELS_TS,
		run: (tipo) => getOntologyTermLabel(tipo),
		fallback: () => '',
	},
	{
		// Public caller: the fresh-record metadata's `label`.
		name: 'resolveSectionLabel (buildRecordMetadata)',
		file: 'src/core/section/record/create_record.ts',
		run: async (tipo) => (await buildRecordMetadata(tipo, 1, new Date())).label,
		fallback: () => '',
	},
	{
		// Exported seam; one link per call, the atoms' values.
		name: 'sectionLabelAtoms',
		file: 'src/diffusion/resolve/resolver.ts',
		run: async (tipo) =>
			(
				await sectionLabelAtoms(
					diffusionRun,
					[{ sectionTipo: tipo, sectionId: 1 }],
					`${TLD}9`,
					undefined,
				)
			).map((atom) => (atom as { value?: unknown }).value),
		fallback: () => [],
		cached: (tipo) => diffusionRun.sectionLabelCache.has(tipo),
	},
];

/** The non-label answer for a node whose only term is `{lg-eng: text}`. */
function resolvedAs(resolver: GuardedResolver, tipo: string, text: string): unknown {
	if (resolver.name === 'ontologyTermLabel') return `${text} [${tipo}]`;
	if (resolver.name === 'sectionLabelAtoms') return [text];
	return text;
}

/** Run `fn` as a non-test process would, with DEDALO_DEV_MODE set to `devMode`. */
async function asServer<T>(devMode: boolean, fn: () => Promise<T>): Promise<T> {
	const saved = process.env.DEDALO_DEV_MODE;
	process.env.DEDALO_DEV_MODE = devMode ? 'true' : 'false';
	try {
		return await runWithLabelGuardTestPosture({ testProcess: false }, fn);
	} finally {
		if (saved === undefined) delete process.env.DEDALO_DEV_MODE;
		else process.env.DEDALO_DEV_MODE = saved;
	}
}

async function upsertNode(tipo: string, model: string, text: string): Promise<void> {
	await upsertDdOntologyNode({ tipo, model, tld: TLD, term: { [LANG]: text } });
}

describe.if(DB_READY)('term resolvers refuse a model=label node', () => {
	beforeAll(async () => {
		await assertTestDatabase('term_by_tipo_label_guard');
		await deleteTldNodes(TLD);
		await upsertNode(LABEL_NODE, LABEL_NODE_MODEL, 'Retired label');
		await upsertNode(PLAIN_NODE, 'component_input', 'Plain node');
		await clearOntologyDerivedCaches();
	});

	afterAll(async () => {
		await deleteTldNodes(TLD);
		await clearOntologyDerivedCaches();
	});

	beforeEach(() => {
		diffusionRun = { sectionLabelCache: new Map() };
	});

	for (const resolver of RESOLVERS) {
		test(`${resolver.name}: fail-loud refusal, typed, on every call`, async () => {
			for (let call = 0; call < 2; call++) {
				const refusal = await refusalOf(resolver.run(LABEL_NODE));
				expect(refusal.code).toBe('internal.invariant');
				expect(refusal.coordinates).toEqual({ tipo: LABEL_NODE, model: LABEL_NODE_MODEL });
			}
		});

		test(`${resolver.name}: production answers its fallback, logs once, caches nothing`, async () => {
			await clearOntologyDerivedCaches(); // fresh log-once memory for this tipo
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
			try {
				for (let call = 0; call < 3; call++) {
					expect(await asServer(false, () => resolver.run(LABEL_NODE))).toEqual(
						resolver.fallback(LABEL_NODE),
					);
				}
				const lines = errorSpy.mock.calls.filter((args) =>
					String(args[0]).includes(`tipo=${LABEL_NODE}`),
				);
				expect(lines.length).toBe(1);
				expect(String(lines[0]?.[0])).toContain('internal.invariant');
				if (resolver.cached) {
					expect(resolver.cached(LABEL_NODE)).toBe(false);
					await asServer(false, () => resolver.run(PLAIN_NODE));
					expect(resolver.cached(PLAIN_NODE)).toBe(true); // the probe is not vacuous
				}
			} finally {
				errorSpy.mockRestore();
			}
			// No cache clear: a cached fallback would answer here instead of the throw.
			expect((await refusalOf(resolver.run(LABEL_NODE))).code).toBe('internal.invariant');
		});

		test(`${resolver.name}: DEDALO_DEV_MODE alone arms fail-loud`, async () => {
			const refusal = await refusalOf(asServer(true, () => resolver.run(LABEL_NODE)));
			expect(refusal.code).toBe('internal.invariant');
		});

		test(`${resolver.name}: a tipo reused under a non-label model resolves its term`, async () => {
			await upsertNode(REUSED_NODE, LABEL_NODE_MODEL, 'Reused node');
			await clearOntologyDerivedCaches();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
			try {
				expect(await asServer(false, () => resolver.run(REUSED_NODE))).toEqual(
					resolver.fallback(REUSED_NODE),
				);
			} finally {
				errorSpy.mockRestore();
			}
			await upsertNode(REUSED_NODE, 'component_input', 'Reused node');
			await clearOntologyDerivedCaches();
			expect(await resolver.run(REUSED_NODE)).toEqual(
				resolvedAs(resolver, REUSED_NODE, 'Reused node'),
			);
			expect(await asServer(false, () => resolver.run(REUSED_NODE))).toEqual(
				resolvedAs(resolver, REUSED_NODE, 'Reused node'),
			);
		});

		test(`${resolver.name}: a non-label node beside it resolves normally`, async () => {
			expect(await resolver.run(PLAIN_NODE)).toEqual(
				resolvedAs(resolver, PLAIN_NODE, 'Plain node'),
			);
		});
	}

	test('sectionLabelAtoms: a label link is dropped, the links beside it still publish', async () => {
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
		try {
			const atoms = await asServer(false, () =>
				sectionLabelAtoms(
					diffusionRun,
					[
						{ sectionTipo: PLAIN_NODE, sectionId: 1 },
						{ sectionTipo: LABEL_NODE, sectionId: 2 },
						{ sectionTipo: PLAIN_NODE, sectionId: 3 },
					],
					`${TLD}9`,
					'ddo',
				),
			);
			expect(atoms.map((atom) => (atom as { value?: unknown }).value)).toEqual([
				'Plain node',
				'Plain node',
			]);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// CENSUS — every term read FROM dd_ontology in src/, each on a CHECKED basis.
// ---------------------------------------------------------------------------

/**
 * The basis a term-reading statement stands on. Each is a PREDICATE over the
 * statement text (and, for `guarded`, over the function containing it) that
 * the census evaluates. A statement takes the FIRST basis it satisfies, in this
 * order (strongest exemption first); one satisfying none is `unbased` and is
 * always red.
 *
 *  - guarded         — a SINGLE-tipo read (`tipo = <bound value>`) that selects
 *                      `model`, and the function CONTAINING the statement calls
 *                      `refuseLabelNode(<the bound tipo>, <row>.model)` after it.
 *                      A batched read (`tipo = ANY(…)` / `tipo IN (…)`) is never
 *                      guarded: it needs model-predicate or full-row;
 *  - not-by-tipo     — no by-tipo predicate (`tipo = <bound>`, `tipo = ANY(…)`,
 *                      `tipo IN (…)`);
 *  - model-predicate — a `model = '<literal other than label>'` or
 *                      `model IN (…)` predicate binds the rows to a model set;
 *  - full-row        — the statement selects `model`; the consumer is TRUSTED
 *                      to dispatch on it (NOT machine-checked).
 */
type CensusBasis = 'guarded' | 'not-by-tipo' | 'model-predicate' | 'full-row';
const BASIS_ORDER: readonly CensusBasis[] = [
	'guarded',
	'not-by-tipo',
	'model-predicate',
	'full-row',
];

interface CensusEntry {
	/** Term-reading statements of the file, counted per basis (exact). */
	readonly bases: Readonly<Partial<Record<CensusBasis, number>>>;
	/** Context for a reader; the basis, not this, is what the gate checks. */
	readonly reason: string;
}

/**
 * The ledger — the ONLY list of guarded homes (each has an outcome leg in
 * RESOLVERS). A new by-tipo term read belongs in a guarded home (or calls
 * refuseLabelNode itself in the same function); a ledger edit that claims a
 * basis the statement does not satisfy is red. A `full-row` count claims only
 * that the statement selects `model`; the consumer is trusted to dispatch on
 * it (not machine-checked).
 */
const TERM_READ_LEDGER: Readonly<Record<string, CensusEntry>> = {
	'src/core/ontology/labels.ts': {
		bases: { guarded: 3 },
		reason: 'labelByTipo + termByTipo + getOntologyTermLabel (term_label.ts folded in 2026-11-04)',
	},
	'src/core/ontology/resolver.ts': {
		bases: { guarded: 1, 'not-by-tipo': 3, 'model-predicate': 1, 'full-row': 1 },
		reason:
			'getTermByTipo; subtree/children loaders + listSectionNodes; relatedMatrixTable; the node-row loader (full-row: selects model, consumer trusted)',
	},
	'src/core/section/record/create_record.ts': {
		bases: { guarded: 1 },
		reason: 'resolveSectionLabel',
	},
	'src/diffusion/resolve/resolver.ts': { bases: { guarded: 1 }, reason: 'sectionLabelAtoms' },
	'src/core/api/handlers/menu.ts': { bases: { 'not-by-tipo': 1 }, reason: 'menu walk' },
	'src/core/db/dd_ontology.ts': {
		bases: { 'full-row': 1 },
		reason: 'raw node-row loader of the write layer (full-row: selects model, consumer trusted)',
	},
	'src/core/diffusion_bridge/diffusion_delete.ts': {
		bases: { 'not-by-tipo': 1 },
		reason: 'owl:Class children of a parent',
	},
	'src/core/diffusion_bridge/diffusion_map.ts': {
		bases: { 'full-row': 1 },
		reason: 'diffusion tree node loader (full-row: selects model, consumer trusted)',
	},
	'src/diffusion/plan/virtual_tree.ts': {
		bases: { 'full-row': 2 },
		reason:
			'external-node warm (tipo = ANY) + nodeOf, both SELECT ${NODE_COLUMNS} (resolves to a list with model; consumer trusted)',
	},
	'src/core/ontology/ontology_state.ts': {
		bases: { 'not-by-tipo': 1 },
		reason: 'inspect/rebuild per-TLD full-row read',
	},
	'src/core/resolve/security_access_datalist.ts': {
		bases: { 'not-by-tipo': 1 },
		reason: 'whole-ontology walk for the access tree',
	},
	'src/core/search/search_related.ts': {
		bases: { 'not-by-tipo': 1 },
		reason: 'the dd627 matrix_table children',
	},
};

/** A literal is a term read FROM dd_ontology: a SELECT/WITH naming dd_ontology and reading `term` or `*`. */
function isTermRead(sql: string): boolean {
	if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return false;
	if (!/\bdd_ontology\b/.test(sql)) return false;
	return /\bterm\b/.test(sql) || /\bSELECT\s+(\w+\.)?\*/i.test(sql);
}

/** The SINGLE-tipo predicate `tipo = <bound>`: `${expr}` (tagged template) or `$N` (sql.unsafe params). */
const BY_TIPO = /(?:^|[^\w.])(?:\w+\.)?tipo\s*=\s*(?:\$\{([^}]+)\}|\$(\d+))/;
/** A BATCHED by-tipo predicate: `tipo = ANY(…)` or `tipo IN (…)`. */
const BY_TIPO_BATCH = /(?:^|[^\w.])(?:\w+\.)?tipo\s*(?:=\s*ANY\s*\(|IN\s*\()/i;

/**
 * Same-file `const NAME = '<string>'` values (a plain string or hole-free
 * template literal) — what a select-list `${NAME}` hole resolves to.
 */
function stringConstsOf(source: string): Map<string, string> {
	const consts = new Map<string, string>();
	const pattern =
		/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\]*)`)/g;
	for (const m of source.matchAll(pattern)) {
		consts.set(m[1] as string, (m[2] ?? m[3] ?? m[4]) as string);
	}
	return consts;
}

/**
 * Resolve the `${…}` holes of the first SELECT's select list: an identifier
 * naming a same-file string const becomes its value; ANY other hole becomes
 * `term` (fail-closed — an unresolvable column list is counted as a term read
 * that does not select model).
 */
function resolveSelectList(sql: string, consts: ReadonlyMap<string, string>): string {
	const m = sql.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i);
	if (!m || m.index === undefined || !m[1]?.includes('${')) return sql;
	const listStart = m.index + 'SELECT'.length;
	const list = m[1].replace(/\$\{\s*([^}]*?)\s*\}/g, (_, expr: string) =>
		/^[A-Za-z_$][\w$]*$/.test(expr) && consts.has(expr) ? (consts.get(expr) as string) : 'term',
	);
	return sql.slice(0, listStart) + list + sql.slice(listStart + m[1].length);
}

/** The select list of the statement's first SELECT names `model` (or `*`). */
function selectsModel(sql: string): boolean {
	const list = sql.match(/\bSELECT\b([\s\S]*?)\bFROM\b/i)?.[1] ?? '';
	return /(?:^|[\s,.])model\b/.test(list) || /(?:^|[\s,])(?:\w+\.)?\*/.test(list);
}

/** A model predicate binding the rows to a set without `label`. */
function hasModelPredicate(sql: string): boolean {
	const literals = [...sql.matchAll(/\b(?:\w+\.)?model\s*=\s*'([^']*)'/g)].map((m) => m[1]);
	if (literals.includes(LABEL_NODE_MODEL)) return false;
	return literals.length > 0 || /\b(?:\w+\.)?model\s+IN\s*\(/i.test(sql);
}

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };
const NOT_CODE_KEYS = new Set([
	'loc',
	'extra',
	'leadingComments',
	'trailingComments',
	'innerComments',
]);
const FUNCTION_TYPES = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod',
]);

/** Depth-first walk handing each node its ancestor chain (nearest last). */
function walk(
	node: unknown,
	ancestors: AstNode[],
	visit: (n: AstNode, a: AstNode[]) => void,
): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, ancestors, visit);
		return;
	}
	if (node === null || typeof node !== 'object' || typeof (node as AstNode).type !== 'string')
		return;
	const current = node as AstNode;
	visit(current, ancestors);
	ancestors.push(current);
	for (const [key, child] of Object.entries(current)) {
		if (!NOT_CODE_KEYS.has(key) && typeof child === 'object') walk(child, ancestors, visit);
	}
	ancestors.pop();
}

interface TermStatement {
	readonly sql: string;
	readonly basis: CensusBasis | 'unbased';
}

/**
 * Does the function containing `literal` call refuseLabelNode(<bound tipo>,
 * <x>.model) AFTER the statement? The bound tipo is the `${expr}` hole of the
 * tipo predicate, or the N-th element of the params array beside a `$N` one.
 */
function guardedInContainingFunction(
	source: string,
	literal: AstNode,
	ancestors: readonly AstNode[],
	sql: string,
): boolean {
	const match = sql.match(BY_TIPO);
	if (!match) return false;
	const text = (n: AstNode) => source.slice(n.start, n.end).replace(/\s+/g, '');
	let bound: string | null = match[1] !== undefined ? match[1].replace(/\s+/g, '') : null;
	if (bound === null) {
		const call = ancestors.at(-1);
		const params = (call?.arguments as AstNode[] | undefined)?.[1];
		const element = (params?.elements as AstNode[] | undefined)?.[Number(match[2]) - 1];
		bound = element ? text(element) : null;
	}
	const fn = [...ancestors].reverse().find((a) => FUNCTION_TYPES.has(a.type));
	if (bound === null || fn === undefined) return false;
	let guarded = false;
	walk(fn, [], (node) => {
		if (node.type !== 'CallExpression' || node.start < literal.end) return;
		const callee = node.callee as AstNode;
		if (callee.type !== 'Identifier' || callee.name !== 'refuseLabelNode') return;
		const [tipoArg, modelArg] = node.arguments as AstNode[];
		const property = modelArg?.property as AstNode | undefined;
		if (
			tipoArg !== undefined &&
			text(tipoArg) === bound &&
			/MemberExpression$/.test(modelArg?.type ?? '') &&
			property?.name === 'model'
		) {
			guarded = true;
		}
	});
	return guarded;
}

function classify(sql: string, guarded: boolean): CensusBasis | 'unbased' {
	const single = BY_TIPO.test(sql);
	const batched = BY_TIPO_BATCH.test(sql);
	const byTipo = single || batched;
	const satisfied: Record<CensusBasis, boolean> = {
		guarded: single && !batched && selectsModel(sql) && guarded,
		'not-by-tipo': !byTipo,
		'model-predicate': hasModelPredicate(sql),
		'full-row': selectsModel(sql),
	};
	return BASIS_ORDER.find((basis) => satisfied[basis]) ?? 'unbased';
}

/** Every term-reading statement of one file, classified, from the Babel AST. */
function termStatementsOf(source: string): TermStatement[] {
	const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'] });
	const consts = stringConstsOf(source);
	const found: TermStatement[] = [];
	walk(ast.program, [], (node, ancestors) => {
		if (node.type !== 'StringLiteral' && node.type !== 'TemplateLiteral') return;
		const sql = resolveSelectList(
			normalizeSqlLiteral(source.slice(node.start + 1, node.end - 1)),
			consts,
		);
		if (!isTermRead(sql)) return;
		found.push({
			sql,
			basis: classify(sql, guardedInContainingFunction(source, node, ancestors, sql)),
		});
	});
	return found;
}

/** The literal-walker count (the scanner the SQL gates share) — cross-checks the AST walk. */
function scannerCount(source: string): number {
	const consts = stringConstsOf(source);
	return extractSourceLiterals(stripComments(source))
		.map((literal) => resolveSelectList(normalizeSqlLiteral(literal.text), consts))
		.filter(isTermRead).length;
}

describe('census: every term read FROM dd_ontology in src/ stands on a checked basis', () => {
	const statements = new Map<string, TermStatement[]>();
	const scanned = new Map<string, number>();
	for (const file of engineSourceFiles()) {
		const source = readFileSync(file, 'utf-8');
		const rel = `src/${relative(ENGINE_SRC, file)}`;
		const count = scannerCount(source);
		if (count > 0) scanned.set(rel, count);
		if (count > 0 || /\bdd_ontology\b/.test(source)) {
			const list = termStatementsOf(source);
			if (list.length > 0) statements.set(rel, list);
		}
	}

	test('the AST walk and the shared literal scanner see the same statements', () => {
		expect(scanned.size).toBeGreaterThan(5); // anti-vacuity
		expect(Object.fromEntries([...statements].map(([f, l]) => [f, l.length]))).toEqual(
			Object.fromEntries(scanned),
		);
	});

	test('no term read is unbased (a by-tipo read without model, guard or model predicate)', () => {
		const unbased = [...statements].flatMap(([file, list]) =>
			list.filter((s) => s.basis === 'unbased').map((s) => `${file}: ${s.sql.trim()}`),
		);
		expect(unbased).toEqual([]);
	});

	test('the measured bases equal the ledger exactly (a new door or a wrong claim reds)', () => {
		const measured: Record<string, Partial<Record<string, number>>> = {};
		for (const [file, list] of statements) {
			const counts: Partial<Record<string, number>> = {};
			for (const { basis } of list) counts[basis] = (counts[basis] ?? 0) + 1;
			measured[file] = counts;
		}
		const ledgered = Object.fromEntries(
			Object.entries(TERM_READ_LEDGER).map(([file, entry]) => [file, entry.bases]),
		);
		expect(measured).toEqual(ledgered);
	});

	test('each basis predicate reds the shape it excludes (synthetic statements)', () => {
		const read = (where: string, cols = 'term') => `SELECT ${cols} FROM dd_ontology WHERE ${where}`;
		expect(classify(read('tipo = ${t}', 'term, model'), true)).toBe('guarded');
		expect(classify(read('tipo = ${t}', 'term, model'), false)).toBe('full-row');
		expect(classify(read('tipo = $1'), true)).toBe('unbased'); // guard without model selected
		expect(classify(read('parent = $1'), false)).toBe('not-by-tipo');
		expect(classify(read('tld = $1'), false)).toBe('not-by-tipo');
		expect(classify(read("tipo = $1 AND model = 'section'"), false)).toBe('model-predicate');
		expect(classify(read('tipo = $1 AND model IN (${p})'), false)).toBe('model-predicate');
		expect(classify(read("tipo = $1 AND model = 'label'"), false)).toBe('unbased');
		expect(classify(read('s.tipo = ${x}'), false)).toBe('unbased');
		expect(classify(read('tipo = ${x}', '*'), false)).toBe('full-row');
		// Batched by-tipo reads are by-tipo, and never `guarded` even beside a guard.
		expect(classify(read('tipo = ANY($1::text[])'), false)).toBe('unbased');
		expect(classify(read('tipo IN (${list})'), false)).toBe('unbased');
		expect(classify(read('t.tipo = ANY(${l})', 'term, model'), true)).toBe('full-row');
		expect(classify(read('tipo IN (${l})', 'term, model'), true)).toBe('full-row');
		// A single-tipo predicate beside a batched one: the batch still forbids `guarded`.
		expect(classify(read('tipo = ${t} OR tipo IN (${l})', 'term, model'), true)).toBe('full-row');
		expect(classify(read("tipo = ANY($1) AND model = 'section'"), false)).toBe('model-predicate');
		expect(classify(read('section_tipo IN (${l})'), false)).toBe('not-by-tipo');
	});

	test('a select-list ${IDENT} hole resolves to a same-file const; an unresolved one is a term read', () => {
		const file = (decl: string, cols: string) =>
			`${decl}\nasync function a(t){ return sql\`SELECT \${${cols}} FROM dd_ontology WHERE tipo = \${t}\`; }`;
		const bases = (src: string) => termStatementsOf(src).map((st) => st.basis);
		expect(bases(file("const COLS = 'term';", 'COLS'))).toEqual(['unbased']);
		expect(bases(file("const COLS = 'term, model';", 'COLS'))).toEqual(['full-row']);
		expect(bases(file("const COLS = 'tipo, parent';", 'COLS'))).toEqual([]); // no term read
		expect(bases(file("const COLS = 'tipo, parent';", 'cols'))).toEqual(['unbased']); // unresolved
		expect(bases(file("const COLS = 'tipo, parent';", 'pick(COLS)'))).toEqual(['unbased']);
		// The shared scanner resolves the same way (the cross-check above stays honest).
		expect(scannerCount(file("const COLS = 'term';", 'COLS'))).toBe(1);
		expect(scannerCount(file("const COLS = 'tipo, parent';", 'COLS'))).toBe(0);
		expect(scannerCount(file("const COLS = 'tipo, parent';", 'cols'))).toBe(1);
	});

	test('every ledgered guarded home has an outcome leg (RESOLVERS)', () => {
		const guardedFiles = Object.entries(TERM_READ_LEDGER)
			.filter(([, entry]) => (entry.bases.guarded ?? 0) > 0)
			.map(([file]) => file)
			.sort();
		expect(guardedFiles.length).toBeGreaterThan(0);
		expect([...new Set(RESOLVERS.map((r) => r.file))].sort()).toEqual(guardedFiles);
	});

	test('the guard is tied to the CONTAINING function and its bound tipo', () => {
		const sqlOf = (src: string) => termStatementsOf(src).map((s) => s.basis);
		const q = 'sql`SELECT term, model FROM dd_ontology WHERE tipo = ${tipo}`';
		expect(
			sqlOf(`async function a(tipo){ const r = await ${q}; refuseLabelNode(tipo, r[0]?.model); }`),
		).toEqual(['guarded']);
		// The call lives in ANOTHER function of the file: not a guard.
		expect(
			sqlOf(
				`async function a(tipo){ await ${q}; } function b(tipo,r){ refuseLabelNode(tipo, r.model); }`,
			),
		).toEqual(['full-row']);
		// Wrong tipo, or no `.model` argument, or BEFORE the statement: not a guard.
		expect(
			sqlOf(`async function a(tipo,o){ const r = await ${q}; refuseLabelNode(o, r.model); }`),
		).toEqual(['full-row']);
		expect(
			sqlOf(`async function a(tipo,m){ const r = await ${q}; refuseLabelNode(tipo, m); }`),
		).toEqual(['full-row']);
		expect(
			sqlOf(`async function a(tipo,r){ refuseLabelNode(tipo, r.model); await ${q}; }`),
		).toEqual(['full-row']);
		// $N binds through the params array.
		const unsafe = (arg: string) =>
			`async function a(tipo,o){ const r = await sql.unsafe('SELECT term, model FROM dd_ontology WHERE tipo = $1', [${arg}]); refuseLabelNode(tipo, r[0]?.model); }`;
		expect(sqlOf(unsafe('tipo'))).toEqual(['guarded']);
		expect(sqlOf(unsafe('o'))).toEqual(['full-row']);
		// A batched read beside a matching guard is still not guarded.
		expect(
			sqlOf(
				'async function a(tipo){ const r = await sql`SELECT term, model FROM dd_ontology WHERE tipo = ANY(${tipo})`; refuseLabelNode(tipo, r[0]?.model); }',
			),
		).toEqual(['full-row']);
	});
});

// ---------------------------------------------------------------------------
// THE SEAM REFUSES OUTSIDE A TEST PROCESS — driven in a real child process.
// ---------------------------------------------------------------------------

const GUARD_MODULE = new URL('../../src/core/ontology/label_node_guard.ts', import.meta.url)
	.pathname;
const SEAM_CHILD = `
const { runWithLabelGuardTestPosture } = await import(${JSON.stringify(GUARD_MODULE)});
let verdict;
try {
	verdict = { threw: false, value: runWithLabelGuardTestPosture({ testProcess: false }, () => 'ran') };
} catch (error) {
	verdict = { threw: true, code: error?.code ?? null };
}
console.log('SEAM_VERDICT ' + JSON.stringify(verdict));
`;

/**
 * Run SEAM_CHILD under `nodeEnv`. The child inherits this process's env (the
 * suite preload's repointed DB_NAME / media root — importing the guard builds
 * the pool options lazily and opens nothing) with only NODE_ENV replaced, and
 * `--no-env-file` so no .env re-supplies one. isTestProcess
 * (src/config/suite_database.ts) is exactly `NODE_ENV === 'test'`.
 */
function seamVerdictUnder(nodeEnv: string): unknown {
	const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', SEAM_CHILD], {
		env: { ...process.env, NODE_ENV: nodeEnv },
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
		killSignal: 'SIGKILL',
	});
	const exitCode = child.exitCode as number | null;
	if (child.exitedDueToTimeout || exitCode === null || child.signalCode) {
		throw new Error(
			`seam child timed out (signal ${child.signalCode ?? 'none'}, exit ${exitCode}): ${child.stderr.toString()}`,
		);
	}
	const line = child.stdout
		.toString()
		.split('\n')
		.find((l) => l.startsWith('SEAM_VERDICT '));
	if (line === undefined) {
		throw new Error(
			`seam child printed no verdict (exit ${child.exitCode}): ${child.stderr.toString()}`,
		);
	}
	return JSON.parse(line.slice('SEAM_VERDICT '.length));
}

describe('runWithLabelGuardTestPosture is a test seam only', () => {
	test('a NODE_ENV=production process is refused: internal.invariant, fn never runs', () => {
		expect(seamVerdictUnder('production')).toEqual({ threw: true, code: 'internal.invariant' });
	});

	test('control: the same child under NODE_ENV=test runs fn (the refusal is the posture, not the import)', () => {
		expect(seamVerdictUnder('test')).toEqual({ threw: false, value: 'ran' });
	});
});

const AMBIENT_DEV_MODE = process.env.DEDALO_DEV_MODE;
afterEach(() => {
	// The guard seam is AsyncLocalStorage-scoped (nothing to reset); this hook
	// proves the DEDALO_DEV_MODE override never outlives asServer.
	expect(process.env.DEDALO_DEV_MODE).toBe(AMBIENT_DEV_MODE);
});
