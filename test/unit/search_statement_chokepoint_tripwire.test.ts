/**
 * THE SEARCH-STATEMENT CHOKEPOINT — hermetic tripwire
 * (WC-2026-10-30-search-referenced-by-leaf; core: src/core/search/search_statement.ts).
 *
 * Every statement the search assembler builds (`buildSearchSql`: the plain
 * search and the children_recursive pre-pass) is an OPAQUE `SearchStatement`
 * that runs only through the one executor — so a statement a `referenced_by`
 * leaf rendered into is ALWAYS bounded (REFERENCED_BY_SEARCH_BUDGET_MS). The
 * lock has four parts, each asserted here:
 *
 *  (1) OPACITY, measured on a real instance: the text and values are `#private`
 *      — no own or inherited property, no JSON/string coercion yields them; the
 *      class cannot be constructed or opened without the module's capability.
 *      The assembler's declared return type IS SearchStatement (compile-time
 *      assertion below; `tsc` runs in the hermetic tier), so `.sql` on a search
 *      outside the executor is a compile error.
 *  (2) THE ESCAPE DOORS ARE PINNED: the importers of each non-executing door of
 *      search_statement.ts are EXACT sets over the shipped trees
 *      (test/helpers/shipped_text_corpus.ts SHIPPED_TEXT_ROOTS)
 *      (a new importer, or a stale entry, is red); `withSearchBudgetOverride` (a
 *      test seam) has NO production importer; `SearchStatement.open` is called
 *      nowhere else; no production file imports the gate-side text helper.
 *  (2b) THE RAW-SQL HELPERS THAT CAN EMIT THE LEAF are pinned the same way —
 *      `buildScopedRowSetSql` / `renderConformedFilter` (sql_assembler.ts),
 *      `conformFilter` (conform.ts) and EVERY value export of the leaf builder
 *      (builder_referenced_by.ts: `buildOwnerRelationScope`,
 *      `conformReferencedBy`, `storedLocatorExpansionSql`) hand back SQL TEXT a
 *      `referenced_by` leaf may have rendered into, outside any SearchStatement;
 *      each legitimate importer carries the reason its text is still bounded.
 *      The leaf builder's door set is DERIVED: its value exports are parsed and
 *      must equal its pinned doors, so a new export is red until classified.
 *  (3) THE ASSEMBLER'S OWN STATEMENTS: the BuiltQuery body (`assemblePlainSearch`)
 *      is consumed only by `buildPlainSearchSql`, which wraps it; the
 *      children_recursive roots pass runs through `runSearch`. A SPELLING hint
 *      only: the outcome (the roots pass of a leaf search refused past the
 *      budget, at build) is measured in referenced_by_filter_native.
 *
 * THE SCANNER IS A PARSER, not a regex (a regex copy of the first version was
 * bypassed by a renamed destructure, a backtick specifier, an extensionless
 * specifier and a re-export from a pinned file). Every file is parsed with
 * @babel/parser (typescript); every module reference — static import, dynamic
 * `import()`, `export … from`, `export * from`, `require`, `import x =
 * require` — is RESOLVED against the importing file (relative, absolute, with
 * or without `.ts`/`.js`/…, `/index`) and compared to the guarded module, so
 * the spelling of the path is irrelevant. Names are the IMPORTED names (a
 * rename `{ a as b }` / `{ a: b }` records `a`). Any reference the scanner
 * cannot read exactly — a namespace or default import, an undestructured or
 * `.then`-consumed `import()`, a computed or rest destructure, `require`, a
 * value re-export (`export {x} from`, `export * from`, or a local `export {x}`
 * / `export const y = x` / `export default x` of an imported door), and any
 * OTHER string literal naming a guarded file (e.g. a computed `import(join(…))`)
 * — is a LOUD finding, never silently skipped.
 *
 * Anti-vacuity: a corpus floor, a floor of `buildSearchSql` call files and of
 * `runSearch` importers, and a planted control for every form above.
 *
 * Honest limits: a specifier assembled at run time from pieces none of which
 * names the file (`import(`../search/${x}.ts`)`) is invisible to any static
 * scan; so is a door handed out wrapped inside another value. The bound itself
 * (that a leaf statement is cut, at every door, inside a caller transaction, in
 * the export cursor) is a DB fact, asserted in
 * test/unit/referenced_by_filter_native.test.ts — not here.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative } from 'node:path';
import { parse } from '@babel/parser';
import {
	createSearchStatement,
	SearchStatement,
	searchStatementText,
} from '../../src/core/search/search_statement.ts';
import type { buildSearchSql } from '../../src/core/search/sql_assembler.ts';
import { shippedTextFiles } from '../helpers/shipped_text_corpus.ts';

const REPO = join(import.meta.dir, '..', '..');

// (1, compile time) the assembler's result IS the opaque statement.
type Assert<T extends true> = T;
type _BuildReturnsStatement = Assert<
	Awaited<ReturnType<typeof buildSearchSql>> extends SearchStatement ? true : false
>;

/** A pinned door: its EXACT production importers, each with why it is legitimate. */
type Door = Readonly<Record<string, string>>;

/**
 * The guarded modules (repo path WITHOUT extension) → door name → importer → reason.
 * A module listed with `refuseAll` may not be referenced by production at all.
 */
const GUARDED: Readonly<Record<string, { doors: Readonly<Record<string, Door>> }>> = {
	'src/core/search/search_statement': {
		doors: {
			createSearchStatement: {
				'src/core/search/sql_assembler.ts':
					'the assembler builds every statement (its ParamsCollector sets the flag)',
			},
			searchStatementText: {
				'src/core/api/handlers/dd_utils_api.ts':
					'INSPECTION: the admin SQL console shows the text it runs through runSearch',
			},
			searchCursorSource: {
				'src/diffusion/export/selection_cursor.ts':
					'the export selection cursor declares the selection and arms the budget',
			},
			wrapSearch: {
				'src/diffusion/resolve/selection.ts':
					'the diffusion keyset batch embeds the selection (the flag is inherited)',
			},
			// The test seam: never production.
			withSearchBudgetOverride: {},
		},
	},
	'src/core/search/sql_assembler': {
		doors: {
			buildScopedRowSetSql: {
				'src/core/search/builders/builder_referenced_by.ts':
					'the leaf builder: its row-set fragment is embedded in the leaf it renders, ' +
					'which flags the enclosing statement (ParamsCollector) → bounded by runSearch',
				'src/core/search/relation_targets.ts':
					'the relation-targets census: FILTERLESS row sets (`{ section_tipo }` only, no ' +
					'leaf can render) run under its own deadline (RELATION_TARGETS_BUDGET_MS)',
			},
			// Test-only (search_date_and_ancestors_native); the assembler's own
			// filter rendering runs inside the statement it builds.
			renderConformedFilter: {},
		},
	},
	'src/core/search/conform': {
		doors: {
			conformFilter: {
				'src/core/search/sql_assembler.ts':
					'the assembler conforms the filter of the statement it builds (flag set there)',
			},
		},
	},
	// EVERY value export (derived: see the export-census test).
	'src/core/search/builders/builder_referenced_by': {
		doors: {
			buildOwnerRelationScope: {
				'src/core/search/relation_targets.ts':
					'the relation-targets census: the FILTERED source row set (the caller source, ' +
					'nested leaves included) runs only inside the census transaction, under its ' +
					'whole-census clock (RELATION_TARGETS_BUDGET_MS, SET LOCAL before each ' +
					'statement); inside a CALLER transaction the clock is null and that ' +
					'transaction’s ceiling governs (no wire caller runs it there)',
			},
			conformReferencedBy: {
				'src/core/search/conform.ts':
					'the leaf renderer, reached only through conformFilter inside the statement the ' +
					'assembler builds (the leaf flags it: ParamsCollector) → bounded by runSearch',
			},
			// Module-internal helper; no importer.
			storedLocatorExpansionSql: {},
		},
	},
};

/** The module whose WHOLE value-export set is its door set (derived, not listed). */
const LEAF_BUILDER = 'src/core/search/builders/builder_referenced_by';

/** Referenced by NO production file, in any form. */
const REFUSED_MODULES: Readonly<Record<string, string>> = {
	'test/helpers/search_sql': 'the gate-side text helper',
};

/** The module that defines the capability: its own `.open` calls are the executor. */
const STATEMENT_FILE = 'src/core/search/search_statement.ts';

/**
 * The scanned corpus: every TypeScript file of the shipped first-party trees,
 * from the REGISTERED shared lister (test/helpers/shipped_text_corpus.ts —
 * client, tools, src, scripts, publication, deploy). The roots are the
 * lister's, never chosen here (census_derivation_tripwire).
 */
function corpusFiles(): string[] {
	return shippedTextFiles().filter(
		(file) => /\.(ts|tsx|mts|cts)$/.test(file) && !file.endsWith('.d.ts'),
	);
}

// --- the parser-backed scanner ------------------------------------------------

type AstNode = { type: string; [key: string]: unknown };

const NOT_CODE_KEYS = new Set([
	'loc',
	'extra',
	'leadingComments',
	'trailingComments',
	'innerComments',
	'comments',
	'tokens',
]);

/** Depth-first visit with the ancestor chain (nearest last). */
function visit(
	root: unknown,
	fn: (node: AstNode, ancestors: readonly AstNode[]) => void,
	ancestors: AstNode[] = [],
): void {
	if (Array.isArray(root)) {
		for (const child of root) visit(child, fn, ancestors);
		return;
	}
	if (root === null || typeof root !== 'object' || typeof (root as AstNode).type !== 'string') {
		return;
	}
	const node = root as AstNode;
	fn(node, ancestors);
	ancestors.push(node);
	for (const [key, child] of Object.entries(node)) {
		if (!NOT_CODE_KEYS.has(key) && child !== null && typeof child === 'object') {
			visit(child, fn, ancestors);
		}
	}
	ancestors.pop();
}

/** The exact text of a string literal or an expression-free template literal. */
function literalText(node: unknown): string | null {
	const n = node as AstNode | null | undefined;
	if (n?.type === 'StringLiteral') return n.value as string;
	if (n?.type === 'TemplateLiteral' && (n.expressions as unknown[]).length === 0) {
		const quasi = (n.quasis as AstNode[])[0];
		return ((quasi?.value as { cooked?: string } | undefined)?.cooked ?? null) as string | null;
	}
	return null;
}

const EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The repo module a specifier names, as a repo path WITHOUT extension (and
 * without a trailing `/index`), or null for a package / outside the repo.
 */
function resolveSpecifier(file: string, specifier: string): string | null {
	let target: string;
	if (specifier.startsWith('.')) target = posix.join(posix.dirname(file), specifier);
	else if (isAbsolute(specifier)) {
		const rel = relative(REPO, specifier);
		if (rel.startsWith('..')) return null;
		target = rel.split('\\').join('/');
	} else if (specifier.startsWith('file://')) {
		return resolveSpecifier(file, new URL(specifier).pathname);
	} else return null;
	return posix
		.normalize(target)
		.replace(EXTENSION, '')
		.replace(/\/index$/, '');
}

/** Basenames of every watched module (a literal naming one outside an import is loud). */
const WATCHED = [...Object.keys(GUARDED), ...Object.keys(REFUSED_MODULES)];
const WATCHED_BASENAMES = WATCHED.map((key) => posix.basename(key));

/** Does a free string literal (not in an import position) name a watched file? */
function namesWatchedFile(text: string): boolean {
	const normalized = text.split('\\').join('/');
	// A specifier has no whitespace: a sentence naming the file is prose.
	if (/\s/.test(normalized)) return false;
	return WATCHED_BASENAMES.some((base) => {
		const match = new RegExp(`(?:^|/)${base}(\\.[cm]?[jt]sx?)?$`).exec(normalized);
		// A bare word ('conform') is a key, not a path: a path has a '/' or an extension.
		return match !== null && (normalized.includes('/') || match[1] !== undefined);
	});
}

interface FileScan {
	/** watched module → IMPORTED names (value imports; renames normalised). */
	imports: Map<string, Set<string>>;
	/** Loud findings: forms the scanner cannot read exactly, re-exports, `.open`. */
	loud: string[];
}

function parseSource(source: string): AstNode {
	return parse(source, {
		sourceType: 'module',
		plugins: ['typescript', 'decorators-legacy'],
		errorRecovery: false,
	}) as unknown as AstNode;
}

/** Everything `source` (at repo path `file`) does with the watched modules. */
function scanFile(file: string, source: string): FileScan {
	const imports = new Map<string, Set<string>>();
	const loud: string[] = [];
	const ast = parseSource(source);
	const accounted = new Set<unknown>();
	/** local binding → `${module}#${imported}` (value imports of a pinned door). */
	const doorBindings = new Map<string, string>();
	/** local names bound to the imported `SearchStatement` class. */
	const statementClassNames = new Set<string>(['SearchStatement']);

	const watchedModule = (sourceNode: unknown): string | null => {
		const text = literalText(sourceNode);
		if (text === null) return null;
		// An import-position literal is READ here (resolved), whatever it names.
		accounted.add(sourceNode);
		const resolved = resolveSpecifier(file, text);
		return resolved !== null && WATCHED.includes(resolved) ? resolved : null;
	};
	const record = (module: string, imported: string, local: string | null) => {
		if (module in REFUSED_MODULES) {
			loud.push(`${file}: imports ${REFUSED_MODULES[module]} (${module})`);
			return;
		}
		const names = imports.get(module) ?? new Set<string>();
		imports.set(module, names);
		names.add(imported);
		if (local !== null && GUARDED[module]?.doors[imported] !== undefined) {
			doorBindings.set(local, `${module}#${imported}`);
		}
		if (local !== null && imported === 'SearchStatement') statementClassNames.add(local);
	};
	const refused = (module: string, form: string) => {
		loud.push(`${file}: names ${module} in an uncheckable form (${form})`);
	};
	const nameOf = (node: AstNode): string | null =>
		node.type === 'Identifier'
			? (node.name as string)
			: node.type === 'StringLiteral'
				? (node.value as string)
				: null;

	visit(ast, (node, ancestors) => {
		switch (node.type) {
			case 'ImportDeclaration': {
				const module = watchedModule(node.source);
				if (module === null) return;
				const typeOnly = node.importKind === 'type' || node.importKind === 'typeof';
				for (const specifier of node.specifiers as AstNode[]) {
					if (specifier.type === 'ImportSpecifier') {
						if (typeOnly || specifier.importKind === 'type') continue;
						const imported = nameOf(specifier.imported as AstNode);
						if (imported === null) refused(module, 'unreadable import specifier');
						else record(module, imported, (specifier.local as AstNode).name as string);
					} else if (!typeOnly) {
						refused(
							module,
							specifier.type === 'ImportNamespaceSpecifier' ? 'namespace import' : 'default import',
						);
					}
				}
				if ((node.specifiers as AstNode[]).length === 0 && module in REFUSED_MODULES) {
					record(module, '*', null);
				}
				return;
			}
			case 'ExportNamedDeclaration':
			case 'ExportAllDeclaration': {
				if (node.source !== null && node.source !== undefined) {
					const module = watchedModule(node.source);
					if (module === null || node.exportKind === 'type') return;
					const specifiers = (node.specifiers as AstNode[] | undefined) ?? [];
					if (node.type === 'ExportAllDeclaration') {
						loud.push(`${file}: re-exports ${module} (export * from)`);
					} else {
						for (const specifier of specifiers) {
							if (specifier.exportKind === 'type') continue;
							const local = specifier.local as AstNode | undefined;
							loud.push(
								`${file}: re-exports ${module}#${local === undefined ? '*' : nameOf(local)} (export … from)`,
							);
						}
					}
					return;
				}
				if (node.exportKind === 'type') return;
				// A LOCAL re-export of an imported door. Collected now, judged after
				// the walk (the import may follow the export in the file).
				return;
			}
			case 'ImportExpression':
			case 'CallExpression': {
				const isImport =
					node.type === 'ImportExpression' || (node.callee as AstNode).type === 'Import';
				const isRequire =
					node.type === 'CallExpression' &&
					(node.callee as AstNode).type === 'Identifier' &&
					(node.callee as AstNode).name === 'require';
				if (!isImport && !isRequire) return;
				const sourceNode =
					node.type === 'ImportExpression' ? node.source : (node.arguments as unknown[])[0];
				const module = watchedModule(sourceNode);
				if (module === null) return;
				if (isRequire) return refused(module, 'require()');
				// The one readable dynamic form: `const { a, b: c } = await import(…)`.
				const awaitNode = ancestors.at(-1);
				const declarator = ancestors.at(-2);
				const pattern = declarator?.id as AstNode | undefined;
				if (
					awaitNode?.type !== 'AwaitExpression' ||
					declarator?.type !== 'VariableDeclarator' ||
					declarator.init !== awaitNode ||
					pattern?.type !== 'ObjectPattern'
				) {
					return refused(module, 'dynamic import not destructured on the spot');
				}
				for (const property of pattern.properties as AstNode[]) {
					const key = property.key as AstNode | undefined;
					const imported = key === undefined ? null : nameOf(key);
					if (property.type !== 'ObjectProperty' || property.computed === true || !imported) {
						refused(module, 'computed or rest destructure of a dynamic import');
						continue;
					}
					const value = property.value as AstNode;
					const target = value.type === 'AssignmentPattern' ? (value.left as AstNode) : value;
					record(module, imported, target.type === 'Identifier' ? (target.name as string) : null);
				}
				return;
			}
			case 'TSImportType': {
				// A type position (`typeof import('…').X`): no value flows.
				watchedModule(node.argument ?? node.parameter);
				const arg = node.argument as AstNode | undefined;
				if (arg?.type === 'TSLiteralType') watchedModule(arg.literal);
				return;
			}
			case 'TSExternalModuleReference': {
				const module = watchedModule(node.expression);
				if (module !== null) refused(module, 'import = require()');
				return;
			}
			default:
				return;
		}
	});

	// Local re-exports of an imported door, and `.open` on the class.
	visit(ast, (node) => {
		if (node.type === 'ExportNamedDeclaration' && node.source == null) {
			if (node.exportKind === 'type') return;
			for (const specifier of (node.specifiers as AstNode[] | undefined) ?? []) {
				const local = (specifier.local as AstNode | undefined)?.name as string | undefined;
				if (specifier.exportKind !== 'type' && local !== undefined && doorBindings.has(local)) {
					loud.push(`${file}: re-exports ${doorBindings.get(local)} (export { ${local} })`);
				}
			}
			const declaration = node.declaration as AstNode | null;
			for (const declarator of (declaration?.declarations as AstNode[] | undefined) ?? []) {
				const init = declarator.init as AstNode | null;
				if (init?.type === 'Identifier' && doorBindings.has(init.name as string)) {
					loud.push(
						`${file}: re-exports ${doorBindings.get(init.name as string)} (export const … = ${init.name as string})`,
					);
				}
			}
		}
		if (node.type === 'ExportDefaultDeclaration') {
			const declaration = node.declaration as AstNode;
			if (declaration.type === 'Identifier' && doorBindings.has(declaration.name as string)) {
				loud.push(
					`${file}: re-exports ${doorBindings.get(declaration.name as string)} (export default)`,
				);
			}
		}
		if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
			const object = node.object as AstNode;
			const property = node.property as AstNode;
			const propertyName =
				node.computed === true ? literalText(property) : (property.name as string | undefined);
			if (
				file !== STATEMENT_FILE &&
				object.type === 'Identifier' &&
				statementClassNames.has(object.name as string) &&
				propertyName === 'open'
			) {
				loud.push(`${file}: reaches SearchStatement.open (the module's own door)`);
			}
		}
		// Any OTHER literal naming a watched file: a computed import, a
		// `declare module`, a path handed to a loader — unreadable, so loud.
		if (
			(node.type === 'StringLiteral' || node.type === 'TemplateLiteral') &&
			!accounted.has(node)
		) {
			const texts =
				node.type === 'StringLiteral'
					? [node.value as string]
					: (node.quasis as AstNode[]).map(
							(quasi) => (quasi.value as { cooked?: string }).cooked ?? '',
						);
			if (texts.some(namesWatchedFile)) {
				loud.push(
					`${file}: a literal names a guarded file outside a readable import (${JSON.stringify(texts.join('${…}'))})`,
				);
			}
		}
	});
	return { imports, loud };
}

/** Parsing is the cost: a file is scanned once per distinct source text. */
const SCAN_CACHE = new Map<string, { source: string; scan: FileScan }>();

function scanCached(file: string, source: string): FileScan {
	const hit = SCAN_CACHE.get(file);
	if (hit !== undefined && hit.source === source) return hit.scan;
	const scan = scanFile(file, source);
	if (hit === undefined) SCAN_CACHE.set(file, { source, scan });
	return scan;
}

/** Production findings over a corpus map (path → source). */
function findings(corpus: ReadonlyMap<string, string>): string[] {
	const out: string[] = [];
	const importers = new Map<string, string[]>();
	for (const [file, source] of corpus) {
		const scan = scanCached(file, source);
		out.push(...scan.loud);
		for (const [module, names] of scan.imports) {
			if (`${module}.ts` === file) continue;
			for (const name of names) {
				if (GUARDED[module]?.doors[name] === undefined) continue;
				const key = `${module}#${name}`;
				importers.set(key, [...(importers.get(key) ?? []), file]);
			}
		}
	}
	for (const [module, { doors }] of Object.entries(GUARDED)) {
		for (const [name, allowed] of Object.entries(doors)) {
			const actual = (importers.get(`${module}#${name}`) ?? []).sort();
			const pinned = Object.keys(allowed).sort();
			if (JSON.stringify(actual) !== JSON.stringify(pinned)) {
				out.push(
					`${module}#${name}: importers ${JSON.stringify(actual)} != pinned ${JSON.stringify(pinned)}`,
				);
			}
		}
	}
	return out;
}

const FILES = corpusFiles();
const CORPUS = new Map(FILES.map((file) => [file, readFileSync(join(REPO, file), 'utf8')]));
const STATEMENT = STATEMENT_FILE.replace(EXTENSION, '');

describe('search statement chokepoint', () => {
	test('(1) OPACITY: no property, coercion or foreign capability reaches the text or values', () => {
		const SENTINEL = 'SELECT 7741 AS zz_chokepoint_sentinel';
		const PARAM = 'zz-chokepoint-param';
		const statement = createSearchStatement(SENTINEL, [PARAM], true);
		const leaks = (value: unknown) =>
			typeof value === 'string' && (value.includes('7741') || value.includes(PARAM));
		expect(Object.keys(statement)).toEqual(['carriesReferencedBy']);
		for (
			let proto: object | null = statement;
			proto !== null;
			proto = Object.getPrototypeOf(proto)
		) {
			for (const key of Object.getOwnPropertyNames(proto)) {
				if (key === 'constructor') continue;
				const value = (statement as unknown as Record<string, unknown>)[key];
				expect({ key, leaks: leaks(value) || (Array.isArray(value) && value.some(leaks)) }).toEqual(
					{
						key,
						leaks: false,
					},
				);
			}
		}
		expect(leaks(JSON.stringify(statement))).toBe(false);
		expect(leaks(String(statement))).toBe(false);
		expect(() => SearchStatement.open(statement, Symbol('foreign'))).toThrow();
		expect(() => new SearchStatement(Symbol('foreign') as never, SENTINEL, [], false)).toThrow();
		// The inspection door is the one that does read it (pinned below).
		expect(searchStatementText(statement)).toEqual({
			sql: SENTINEL,
			params: [PARAM],
			carriesReferencedBy: true,
		});
	});

	test('(2/2b) the escape doors and the raw-SQL helpers are PINNED; nothing names them unreadably (anti-vacuity floors)', () => {
		expect(FILES.length).toBeGreaterThan(400);
		const callFiles = FILES.filter(
			(file) =>
				file !== 'src/core/search/sql_assembler.ts' &&
				/\bbuildSearchSql\(/.test(CORPUS.get(file) ?? ''),
		);
		expect(callFiles.length).toBeGreaterThanOrEqual(24);
		const runSearchImporters = FILES.filter((file) =>
			scanCached(file, CORPUS.get(file) ?? '')
				.imports.get(STATEMENT)
				?.has('runSearch'),
		);
		expect(runSearchImporters.length).toBeGreaterThanOrEqual(20);
		// Every pinned importer is a real file that really imports its door (no dead pin).
		for (const { doors } of Object.values(GUARDED)) {
			for (const allowed of Object.values(doors)) {
				for (const [file, reason] of Object.entries(allowed)) {
					expect({ file, present: CORPUS.has(file) }).toEqual({ file, present: true });
					expect(reason.length).toBeGreaterThan(20);
				}
			}
		}
		expect(findings(CORPUS)).toEqual([]);
	});

	test('(2b) the leaf builder’s door set is DERIVED: every value export is a pinned door', () => {
		const ast = parseSource(CORPUS.get(`${LEAF_BUILDER}.ts`) ?? '');
		const exported: string[] = [];
		for (const node of (ast.program as AstNode).body as AstNode[]) {
			if (node.type !== 'ExportNamedDeclaration') continue;
			if (node.exportKind === 'type') continue;
			const declaration = node.declaration as AstNode | null;
			if (declaration === null || declaration === undefined) {
				// `export { a, b }` — a value re-export of local names.
				for (const specifier of (node.specifiers as AstNode[]) ?? []) {
					if (specifier.exportKind === 'type') continue;
					exported.push(String((specifier.exported as AstNode).name));
				}
			} else if (
				declaration.type === 'FunctionDeclaration' ||
				declaration.type === 'ClassDeclaration'
			) {
				exported.push(String((declaration.id as AstNode).name));
			} else if (declaration.type === 'VariableDeclaration') {
				for (const declarator of declaration.declarations as AstNode[]) {
					exported.push(String((declarator.id as AstNode).name));
				}
			}
		}
		// Anti-vacuity: the three known doors are really exported.
		expect(exported.length).toBeGreaterThanOrEqual(3);
		expect(exported.sort()).toEqual(Object.keys(GUARDED[LEAF_BUILDER]?.doors ?? {}).sort());
	});

	describe('(2, controls) every bypass form goes red', () => {
		// A planted file at src/core/api/ — so `../search/…` resolves to the real module.
		const PLANTED = 'src/core/api/zz_planted.ts';
		const planted = (source: string, at = PLANTED) =>
			findings(new Map([...CORPUS, [at, source]])).filter((line) =>
				line.includes(posix.basename(at)),
			);
		const ABSOLUTE = join(REPO, 'src/core/search/search_statement.ts');

		const red: [form: string, reason: string, source: string][] = [
			[
				'static',
				'importers',
				"import { searchStatementText } from '../search/search_statement.ts';",
			],
			[
				'static rename',
				'importers',
				"import { searchStatementText as t } from '../search/search_statement.ts';",
			],
			[
				'string-named import',
				'importers',
				"import { 'wrapSearch' as w } from '../search/search_statement.ts';",
			],
			['double quotes', 'importers', 'import { wrapSearch } from "../search/search_statement.ts";'],
			[
				'no extension',
				'importers',
				"import { searchStatementText } from '../search/search_statement';",
			],
			['.js extension', 'importers', "import { wrapSearch } from '../search/search_statement.js';"],
			[
				'detour path',
				'importers',
				"import { wrapSearch } from '../../core/search/../search/search_statement';",
			],
			['absolute path', 'importers', `import { wrapSearch } from '${ABSOLUTE}';`],
			[
				'dynamic',
				'importers',
				"const { wrapSearch } = await import('../search/search_statement.ts');",
			],
			[
				'dynamic rename',
				'importers',
				"const { searchStatementText: t } = await import('../search/search_statement.ts');",
			],
			[
				'dynamic backtick',
				'importers',
				'const { wrapSearch } = await import(`../search/search_statement.ts`);',
			],
			[
				'dynamic no extension',
				'importers',
				"const { wrapSearch } = await import('../search/search_statement');",
			],
			['namespace', 'namespace import', "import * as st from '../search/search_statement.ts';"],
			['default', 'default import', "import st from '../search/search_statement.ts';"],
			[
				'undestructured dynamic',
				'not destructured',
				"const m = await import('../search/search_statement.ts');",
			],
			[
				'.then dynamic',
				'not destructured',
				"import('../search/search_statement.ts').then(({ wrapSearch }) => wrapSearch);",
			],
			[
				'computed destructure',
				'computed or rest',
				"const { ['wrapSearch']: w } = await import('../search/search_statement.ts');",
			],
			[
				'rest destructure',
				'computed or rest',
				"const { ...all } = await import('../search/search_statement.ts');",
			],
			['require', 'require()', "const st = require('../search/search_statement.ts');"],
			[
				'import = require',
				'import = require',
				"import st = require('../search/search_statement');",
			],
			[
				'computed specifier',
				'outside a readable import',
				"const st = await import(join(import.meta.dir, '../search/search_statement.ts'));",
			],
			[
				're-export named',
				're-exports',
				"export { searchStatementText } from '../search/search_statement.ts';",
			],
			[
				're-export renamed',
				're-exports',
				"export { wrapSearch as w } from '../search/search_statement';",
			],
			['re-export star', 'export * from', "export * from '../search/search_statement.ts';"],
			['re-export star as', 're-exports', "export * as st from '../search/search_statement.ts';"],
			[
				'SearchStatement.open',
				'SearchStatement.open',
				"import { SearchStatement as S } from '../search/search_statement.ts';\nS.open(x, y);",
			],
			[
				'text helper',
				'text helper',
				"import { buildSearchSql } from '../../../test/helpers/search_sql.ts';",
			],
			[
				'text helper, no extension',
				'text helper',
				"import { buildSearchSql } from '../../../test/helpers/search_sql';",
			],
			[
				'raw-SQL helper',
				'buildScopedRowSetSql: importers',
				"import { buildScopedRowSetSql as b } from '../search/sql_assembler';",
			],
			[
				'raw-SQL helper (render)',
				'renderConformedFilter: importers',
				"import { renderConformedFilter } from '../search/sql_assembler.js';",
			],
			[
				'raw-SQL helper (conform)',
				'conformFilter: importers',
				'const { conformFilter } = await import(`../search/conform`);',
			],
			[
				'raw-SQL helper namespace',
				'namespace import',
				"import * as asm from '../search/sql_assembler.ts';",
			],
			[
				'leaf builder (owner scope)',
				'buildOwnerRelationScope: importers',
				"import { buildOwnerRelationScope } from '../search/builders/builder_referenced_by.ts';",
			],
			[
				'leaf builder (renderer)',
				'conformReferencedBy: importers',
				"const { conformReferencedBy } = await import('../search/builders/builder_referenced_by');",
			],
			[
				'leaf builder (expansion)',
				'storedLocatorExpansionSql: importers',
				"import { storedLocatorExpansionSql as e } from '../search/builders/builder_referenced_by.js';",
			],
		];
		for (const [form, reason, source] of red) {
			test(form, () => {
				// Red, and red for ITS reason (not by accident of another rule).
				const lines = planted(`${source}\n`);
				expect({ form, red: lines.some((line) => line.includes(reason)) }).toEqual({
					form,
					red: true,
				});
			});
		}

		test('a re-export of a door FROM A PINNED FILE (it already imports the door)', () => {
			const pinned = 'src/diffusion/resolve/selection.ts';
			const original = CORPUS.get(pinned) ?? '';
			expect(original).toContain('wrapSearch');
			for (const tail of [
				'export { wrapSearch };',
				'export { wrapSearch as embedSelection };',
				'export const embed = wrapSearch;',
				'export default wrapSearch;',
				"export { wrapSearch as w2 } from '../../core/search/search_statement.ts';",
			]) {
				expect({ tail, red: planted(`${original}\n${tail}\n`, pinned).length > 0 }).toEqual({
					tail,
					red: true,
				});
			}
			// Unchanged, the pinned file is clean (the red above is the tail's).
			expect(planted(original, pinned)).toEqual([]);
		});

		test('the executor and type-only imports are free; prose is not an import', () => {
			expect(planted("import { runSearch } from '../search/search_statement.ts';\n")).toEqual([]);
			expect(
				planted("const { runSearch } = await import('../search/search_statement');\n"),
			).toEqual([]);
			expect(
				planted("import type { SearchStatement } from '../search/search_statement.ts';\n"),
			).toEqual([]);
			expect(
				planted("import { type SearchStatementOptions } from '../search/search_statement.ts';\n"),
			).toEqual([]);
			expect(planted('// searchStatementText from search_statement.ts\n')).toEqual([]);
			expect(planted("/* import { wrapSearch } from '../search/search_statement.ts' */\n")).toEqual(
				[],
			);
			// A same-named module elsewhere is a different module.
			expect(planted("import { wrapSearch } from './search_statement.ts';\n")).toEqual([]);
		});
	});

	test('(3) the assembler wraps its BuiltQuery body exactly once and runs its roots pass through runSearch', () => {
		const assembler = (CORPUS.get('src/core/search/sql_assembler.ts') ?? '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
		expect([...assembler.matchAll(/\bassemblePlainSearch\(/g)].length).toBe(2); // definition + the one call
		expect(assembler).toMatch(
			/async function buildPlainSearchSql\([^)]*\)[^{]*\{[^}]*assemblePlainSearch\([^)]*\);\s*return createSearchStatement\(/,
		);
		const roots =
			/async function searchChildrenRecursiveRoots[\s\S]*?\n\}/.exec(assembler)?.[0] ?? '';
		expect(roots).toContain('runSearch');
		expect(roots).not.toMatch(/\.unsafe\(/);
	});
});
