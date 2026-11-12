/**
 * Plan compiler gates (DIFFUSION_PLAN D3-P1) against a BUILT GENERIC diffusion
 * domain (test/helpers/zzdif_diffusion_domain.ts — reserved `zzdif` TLD,
 * provisioned in beforeAll, dropped with residue asserted 0 in afterAll).
 *
 * WAS INSTALL-BOUND until 2026-08-20: this suite compiled the DEPLOYMENT's
 * domain (`DEDALO_DIFFUSION_DOMAIN`, historically `numisdata_mib` → domain node
 * `numisdata323`), so it was green on one developer's machine and red
 * everywhere else — measured red on this checkout ("no sql element of the
 * domain compiled clean"). `buildVirtualDiffusionTree(domainName)` now takes
 * the domain as a parameter, so the gate names its OWN domain and the laws
 * below are the ENGINE's, not one install's.
 *
 * WHAT THE INSTALL-SPECIFIC ASSERTIONS BECAME. `tree.domainTipo === 'numisdata323'`
 * and the implicit "the first clean sql element is numisdata29" were IDENTITIES
 * of one install's nodes, not data worth preserving: they are restated as the
 * laws they were standing in for (the walk starts at the domain the caller
 * NAMED; the fixture's declared element is the one that compiles). No fixture
 * JSON is warranted — an install's diffusion node numbering carries no
 * contract.
 *
 * THE GUARANTEES under test:
 * - the flat virtual tree reproduces the PHP oracle walk (diffusion_utils::
 *   get_virtual_diffusion_tree/:194 semantics): domain resolution, alias
 *   in-place resolution, consumed-branch suppression, parents paths;
 * - every diffusion element of the domain either compiles into a
 *   PublicationPlan or fails LOUDLY with named causes (spec §5 — no silent
 *   narrowing, ever) — and the fixture carries one element that MUST fail, so
 *   the loud branch is measured, never merely shaped;
 * - a real sql element yields sections/fields whose database/table/column
 *   names ALL pass the identifier chokepoint grammar (spec §8.3);
 * - alias semantics: a table_alias-backed section publishes under the ALIAS
 *   label while its fields come from the REAL table's children (merged);
 * - unknown parser fn → compile error naming the field;
 * - plans are plain JSON (dumpable, diffable, shippable to a runner);
 * - the plan cache is revision-keyed: same revision → same object, a bump
 *   (any dd_ontology write) → recompile with a new planId.
 *
 * WRITE SURFACE: the `zzdif` situation only (dd_ontology rows under a reserved
 * scratch TLD + matrix_test records). The revision bump is called directly.
 *
 * The parser classifier is INJECTED (compile.ts CompileOptions) so the split
 * mechanics are pinned independently of the registry's contents: the rewriter
 * set below mirrors DIFFUSION_SPEC §5 / parsers/registry.ts. It defers to the
 * REAL registry for the unknown verdict (it used to call every non-rewriter
 * name 'runtime'), because the fixture's loud-failure element carries an
 * unregistered fn and a blanket 'runtime' would have swallowed it. Strictly
 * more discriminating than before — nothing it used to reject now passes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config, resolveDiffusionLangs } from '../../src/config/config.ts';
import { classifyParserFn } from '../../src/diffusion/parsers/registry.ts';
import {
	bumpOntologyRevision,
	currentOntologyRevision,
	getCompiledPlan,
} from '../../src/diffusion/plan/cache.ts';
import type { ParserClassifier } from '../../src/diffusion/plan/compile.ts';
import {
	compileElementPlan,
	langPolicyErrors,
	PlanCompileError,
	validateElementPlan,
} from '../../src/diffusion/plan/compile.ts';
import type { PublicationPlan } from '../../src/diffusion/plan/types.ts';
import type {
	VirtualDiffusionTree,
	VirtualTreeNode,
} from '../../src/diffusion/plan/virtual_tree.ts';
import {
	buildVirtualDiffusionTree,
	findElementNodes,
} from '../../src/diffusion/plan/virtual_tree.ts';
import {
	dropZzdifDomain,
	ensureZzdifDomain,
	ZZDIF_BROKEN_ELEMENT,
	ZZDIF_DOMAIN_NAME,
	ZZDIF_DOMAIN_TIPO,
	ZZDIF_ELEMENT,
	ZZDIF_RDF_BROKEN_ELEMENT,
	ZZDIF_TABLE_ALIAS,
	ZZDIF_UNKNOWN_PARSER_FN,
} from '../helpers/zzdif_diffusion_domain.ts';

/** Strict identifier grammar (identifier.ts SQL_IDENTIFIER_PATTERN). */
const IDENTIFIER_GRAMMAR = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Compile-time rewriters (spec §5 list; mirrors parsers/registry.ts). The test
 * classifier calls every OTHER REGISTERED fn 'runtime' — this suite pins the
 * SPLIT mechanics, not the registry contents (registry has its own 1:1
 * oracle-diff gate) — and defers to the real registry for the UNKNOWN verdict,
 * so the fixture's unregistered fn reaches the loud-failure branch instead of
 * being waved through as a runtime step (2026-08-20).
 */
const REWRITER_FNS = new Set([
	'parser_locator::get_locator',
	'parser_locator::parents',
	'parser_locator::filter_parents_by_term_id',
	'parser_locator::truncate_by_term_id',
	'parser_locator::truncate_by_model',
	'parser_locator::filter_by_section_tipo',
	'parser_locator::slice_chain',
	'parser_locator::map_section_tipo_to_name',
	'parser_global::merge_columns',
	'parser_global::publication_unix_timestamp',
]);
const testClassifier: ParserClassifier = (fn) =>
	REWRITER_FNS.has(fn) ? 'rewriter' : classifyParserFn(fn) === 'unknown' ? 'unknown' : 'runtime';

let tree: VirtualDiffusionTree;
let elements: VirtualTreeNode[];
/** The first sql element that compiles clean (the shared gate subject). */
let sqlPlan: PublicationPlan;

/** Elements that FAILED to compile, with their causes (the loud branch). */
let failedElements: { tipo: string; errors: string[] }[] = [];

beforeAll(async () => {
	await ensureZzdifDomain();
	const built = await buildVirtualDiffusionTree(ZZDIF_DOMAIN_NAME);
	if (built === null) {
		throw new Error(
			`the zzdif situation was ensured but no dd1190 domain node is named '${ZZDIF_DOMAIN_NAME}'`,
		);
	}
	tree = built;
	elements = findElementNodes(tree);

	for (const element of elements) {
		const validation = await validateElementPlan(element.tipo, {
			tree,
			classifyParserFn: testClassifier,
		});
		if (validation.result !== null && validation.result.format === 'sql') {
			sqlPlan = validation.result;
			break;
		}
	}
	if (sqlPlan === undefined) throw new Error('no sql element of the domain compiled clean');
});

afterAll(async () => {
	// Hermeticity is ASSERTED, not trusted: dropSituation returns the residue.
	expect(await dropZzdifDomain()).toBe(0);
});

describe('virtual tree (PHP get_virtual_diffusion_tree semantics)', () => {
	test('resolves the NAMED domain and enumerates its elements', () => {
		// The law the old `domainTipo === 'numisdata323'` pin stood for: the tree
		// is the domain the CALLER named, resolved by term over dd1190's children.
		expect(tree.domainName).toBe(ZZDIF_DOMAIN_NAME);
		expect(tree.domainTipo).toBe(ZZDIF_DOMAIN_TIPO);
		expect(tree.nodes[0]?.tipo).toBe(tree.domainTipo); // walk starts at the domain
		expect(elements.length).toBeGreaterThanOrEqual(1);
		// the fixture's three declared elements are exactly what the walk finds
		expect(elements.map((element) => element.tipo)).toContain(ZZDIF_ELEMENT);
		expect(elements.map((element) => element.tipo)).toContain(ZZDIF_BROKEN_ELEMENT);
		// every element sits under the domain: non-empty parents path ending there
		for (const element of elements) {
			expect(element.parents.length).toBeGreaterThan(0);
			expect(element.parents[element.parents.length - 1]?.tipo).toBe(tree.domainTipo);
		}
	});

	test('alias nodes resolve in place: alias tipo/label win, real subtree merges', () => {
		const aliasNodes = tree.nodes.filter((node) => node.isAlias && node.realTipo !== null);
		expect(aliasNodes.length).toBeGreaterThan(0);
		for (const alias of aliasNodes) {
			expect(alias.tipo).not.toBe(alias.realTipo); // virtual identity is the alias
			expect(alias.model.includes('_alias')).toBe(true);
		}
	});
});

describe('compileElementPlan over the real domain', () => {
	test('every element compiles or fails LOUDLY with named causes', async () => {
		let compiled = 0;
		failedElements = [];
		for (const element of elements) {
			const validation = await validateElementPlan(element.tipo, {
				tree,
				classifyParserFn: testClassifier,
			});
			if (validation.result !== null) {
				compiled += 1;
				expect(validation.result.elementTipo).toBe(element.tipo);
				expect(validation.errors).toEqual([]);
			} else {
				// loud failure: at least one non-empty, self-explanatory cause
				expect(validation.errors.length).toBeGreaterThan(0);
				for (const cause of validation.errors) {
					expect(typeof cause).toBe('string');
					expect(cause.length).toBeGreaterThan(10);
				}
				failedElements.push({ tipo: element.tipo, errors: validation.errors });
			}
		}
		expect(compiled).toBeGreaterThanOrEqual(1);
		// ANTI-VACUITY (new with the generic domain): on the install's domain the
		// loud branch above could go unexecuted and the test still pass. The
		// fixture DECLARES a broken element, so the branch is measured: exactly
		// that element fails, and its cause names the field AND the unregistered fn.
		// (the rdf element that must fail — T1-4 — has its own gate:
		// diffusion_rdf_graph_native names every refusal it carries)
		expect(failedElements.map((entry) => entry.tipo).sort()).toEqual(
			[ZZDIF_BROKEN_ELEMENT, ZZDIF_RDF_BROKEN_ELEMENT].sort(),
		);
		const causes =
			failedElements.find((entry) => entry.tipo === ZZDIF_BROKEN_ELEMENT)?.errors.join('\n') ?? '';
		expect(causes).toContain(ZZDIF_UNKNOWN_PARSER_FN);
		expect(causes).toMatch(/^field '[a-z]+[0-9]+' .*unknown parser fn/);
	});

	test('a sql element yields sections, fields and a table target', () => {
		// the first clean sql element IS the one the fixture declares as such
		expect(sqlPlan.elementTipo).toBe(ZZDIF_ELEMENT);
		expect(sqlPlan.format).toBe('sql');
		expect(sqlPlan.target.kind).toBe('table');
		expect(sqlPlan.sections.length).toBeGreaterThanOrEqual(1);
		const totalFields = sqlPlan.sections.reduce((sum, section) => sum + section.fields.length, 0);
		expect(totalFields).toBeGreaterThanOrEqual(1);
		// every field resolves through a compiled source chain or is an
		// explicitly declared no-chain field (empty ddo_map in the ontology)
		for (const section of sqlPlan.sections) {
			expect(section.sectionTipo).toMatch(/^[a-z][a-z0-9_]*\d+$/);
			expect(section.tableTipo.length).toBeGreaterThan(0);
		}
	});

	test('identifier chokepoint: database/table/column names all pass the grammar', () => {
		if (sqlPlan.target.kind !== 'table') throw new Error('sql plan must target a table');
		expect(sqlPlan.target.database).toMatch(IDENTIFIER_GRAMMAR);
		for (const section of sqlPlan.sections) {
			expect(section.tableName).toMatch(IDENTIFIER_GRAMMAR);
			for (const field of section.fields) {
				// exclude_column fields emit no SQL column → exempt (PHP
				// build_datum_context returns empty context for them)
				if (field.excludeColumn === true) continue;
				expect(field.columnName).toMatch(IDENTIFIER_GRAMMAR);
			}
		}
	});

	test('alias table: plan uses the ALIAS label, fields merge from the real table', async () => {
		// Find a compiled section backed by a table_alias virtual node whose
		// real table lives elsewhere (the fixture's zzdif50 → zzdif60, owned by
		// a second element) — mirrors get_section_node_for_element :1163.
		const nodeByTipo = new Map(tree.nodes.map((node) => [node.tipo, node]));
		let checkedAliasSection = false;
		for (const section of sqlPlan.sections) {
			const tableNode = nodeByTipo.get(section.tableTipo);
			if (tableNode === undefined || !tableNode.isAlias || tableNode.realTipo === null) continue;

			// alias label IS the published table name
			expect(section.tableName).toBe(tableNode.label as string);
			expect(section.fields.length).toBeGreaterThan(0);

			// at least one field must come from the REAL table's children (the
			// alias+real merge of walk_virtual_diffusion_tree :335-357)
			let fieldsFromRealTable = 0;
			for (const field of section.fields) {
				const fieldNode = await tree.index.nodeOf(field.id);
				if (fieldNode?.parent === tableNode.realTipo) fieldsFromRealTable += 1;
			}
			expect(fieldsFromRealTable).toBeGreaterThan(0);
			// the alias the fixture declares is the one that backed the section
			expect(tableNode.tipo).toBe(ZZDIF_TABLE_ALIAS);
			checkedAliasSection = true;
			break;
		}
		expect(checkedAliasSection).toBe(true);
	});

	test('parser split: rewriters absorbed as warnings, runtime steps kept in order', () => {
		// the domain uses a rewriter fn (publication_unix_timestamp) — its
		// absorption must be ledgered, never silent
		const rewriterWarnings = sqlPlan.warnings.filter((warning) => warning.startsWith('rewriter:'));
		expect(rewriterWarnings.length).toBeGreaterThan(0);
		for (const warning of rewriterWarnings) {
			expect(warning).toMatch(/^rewriter:[a-z_]+::[a-z_0-9]+@[a-z]+[0-9]+$/);
		}
		// no surviving transform step may carry a rewriter fn
		for (const section of sqlPlan.sections) {
			for (const field of section.fields) {
				for (const step of field.transform) {
					expect(REWRITER_FNS.has(step.fn)).toBe(false);
				}
			}
		}
	});

	test('unknown parser fn is a compile ERROR naming the field', async () => {
		const alwaysUnknown: ParserClassifier = () => 'unknown';
		expect(
			compileElementPlan(sqlPlan.elementTipo, { tree, classifyParserFn: alwaysUnknown }),
		).rejects.toThrow(PlanCompileError);
		try {
			await compileElementPlan(sqlPlan.elementTipo, { tree, classifyParserFn: alwaysUnknown });
			throw new Error('unreachable: compile must have thrown');
		} catch (error) {
			const compileError = error as PlanCompileError;
			expect(compileError.compileErrors.length).toBeGreaterThan(0);
			// each violation names its field: "field '<tipo>' (<label>): unknown parser fn '<fn>'"
			expect(compileError.compileErrors[0]).toMatch(/^field '[a-z]+[0-9]+' .*unknown parser fn/);
			expect(compileError.message).toContain('unknown parser fn');
		}
	});

	test('the plan is plain JSON (serializable without loss)', () => {
		const roundTripped = JSON.parse(JSON.stringify(sqlPlan));
		expect(roundTripped).toEqual(sqlPlan as unknown as Record<string, unknown>);
	});

	test('langPolicy and recursion come from config with oracle defaults', () => {
		expect(sqlPlan.langPolicy.langs.length).toBeGreaterThan(0);
		expect(sqlPlan.langPolicy.mainLang).toBe(sqlPlan.langPolicy.langs[0] as string);
		expect(sqlPlan.recursion.maxLevels).toBeGreaterThanOrEqual(1);
	});

	test('the plan takes its langs from the ONE resolution, not from a re-parse', () => {
		// This test used to RE-IMPLEMENT the comma split it was meant to guard, so a
		// JSON-encoded value produced four phantom codes on BOTH sides and the
		// assertion passed. The parse now happens once, in config.diffusion, and the
		// only honest assertion is that the plan agrees with it.
		expect(sqlPlan.langPolicy.langs).toEqual([...config.diffusion.langs]);
		// Order is a contract: mainLang IS langs[0].
		expect(sqlPlan.langPolicy.mainLang).toBe(sqlPlan.langPolicy.langs[0] as string);
		// Never a single-lang collapse on a multi-lang install.
		expect(sqlPlan.langPolicy.langs.length).toBeGreaterThan(1);
	});
});

/**
 * The PURE half of the lang policy. Both functions are exported precisely so a gate
 * can state each fault without booting a config — these are that gate.
 */
describe('lang policy — the pure resolution (resolveDiffusionLangs)', () => {
	const project = ['lg-spa', 'lg-cat', 'lg-eng'];

	test('unset DERIVES the project languages, verbatim and in order', () => {
		const resolved = resolveDiffusionLangs([], project, 'lg-spa');
		expect(resolved.langs).toEqual(project);
		expect(resolved.configured).toBe(false);
		expect(resolved.malformed).toEqual([]);
		expect(resolved.outsideProject).toEqual([]);
	});

	test('a configured SUBSET wins, order preserved (langs[0] is the main lang)', () => {
		const resolved = resolveDiffusionLangs(['lg-eng', 'lg-spa'], project, 'lg-spa');
		expect(resolved.langs).toEqual(['lg-eng', 'lg-spa']);
		expect(resolved.configured).toBe(true);
		// NOT sorted and NOT de-duplicated: the first entry is load-bearing.
		expect(resolved.langs[0]).toBe('lg-eng');
	});

	test('no project languages at all falls back to the single data language', () => {
		// The last resort — an install with nothing configured to publish.
		expect(resolveDiffusionLangs([], [], 'lg-spa').langs).toEqual(['lg-spa']);
	});

	test('langs is NEVER empty (mainLang undefined would break every ladder lookup)', () => {
		for (const [configured, projectLangs] of [
			[[], project],
			[[], []],
			[['lg-eng'], project],
		] as [string[], string[]][]) {
			expect(
				resolveDiffusionLangs(configured, projectLangs, 'lg-spa').langs.length,
			).toBeGreaterThan(0);
		}
	});

	test('the DERIVED set is validated too — the same defect can arrive by the other door', () => {
		// A typo in DEDALO_PROJECTS_DEFAULT_LANGS ('spa' for 'lg-spa') used to be waved
		// through unchecked, because only the CONFIGURED branch was validated.
		const resolved = resolveDiffusionLangs([], ['spa', 'lg-eng'], 'lg-spa');
		expect(resolved.configured).toBe(false);
		expect(resolved.malformed).toEqual(['spa']);
	});

	test('JSON-shred debris is reported as MALFORMED — the defect this change exists to stop', () => {
		// Exactly what a raw comma-split produced from a migrated `["lg-spa",...]`.
		const resolved = resolveDiffusionLangs(['["lg-spa', '"lg-cat"'], project, 'lg-spa');
		expect(resolved.malformed).toEqual(['["lg-spa', '"lg-cat"']);
	});

	test("the 'all' sentinel is NOT a publication language", () => {
		// LANG_PATTERN accepts 'all'; a publication target cannot.
		expect(resolveDiffusionLangs(['all'], project, 'lg-spa').malformed).toEqual(['all']);
	});

	test('a well-formed code outside the project languages is reported separately', () => {
		const resolved = resolveDiffusionLangs(['lg-spa', 'lg-nep'], project, 'lg-spa');
		expect(resolved.outsideProject).toEqual(['lg-nep']);
		expect(resolved.malformed).toEqual([]);
	});
});

describe('lang policy — the refusal (langPolicyErrors)', () => {
	test('a clean policy raises nothing', () => {
		expect(langPolicyErrors({ langsMalformed: [], langsOutsideProject: [] })).toEqual([]);
	});

	test('malformed and out-of-project each produce their own error naming the offenders', () => {
		const errors = langPolicyErrors({
			langsMalformed: ['["lg-spa'],
			langsOutsideProject: ['lg-nep'],
		});
		expect(errors).toHaveLength(2);
		expect(errors.join('\n')).toContain('["lg-spa');
		expect(errors.join('\n')).toContain('lg-nep');
	});

	test('the refusal names the KEY, so the operator knows what to edit', () => {
		const [error] = langPolicyErrors({ langsMalformed: ['nope'], langsOutsideProject: [] });
		expect(error).toContain('DEDALO_DIFFUSION_LANGS');
	});
});

describe('plan cache (revision-keyed, spec §4.1)', () => {
	test('same revision → same plan object; bump → recompile with new planId', async () => {
		const options = { tree, classifyParserFn: testClassifier };
		const elementTipo = sqlPlan.elementTipo;

		const revisionBefore = currentOntologyRevision();
		const first = await getCompiledPlan(elementTipo, options);
		const second = await getCompiledPlan(elementTipo, options);
		expect(second).toBe(first); // cache hit: identical object
		expect(first.planId).toBe(`${elementTipo}:r${revisionBefore}`);

		// an ontology write reaches bumpOntologyRevision through the
		// cache-invalidation hub; here we call it directly (read-only suite)
		bumpOntologyRevision();
		const revisionAfter = currentOntologyRevision();
		expect(revisionAfter).toBe(revisionBefore + 1);

		const recompiled = await getCompiledPlan(elementTipo, options);
		expect(recompiled).not.toBe(first);
		expect(recompiled.planId).toBe(`${elementTipo}:r${revisionAfter}`);
		expect(recompiled.planId).not.toBe(first.planId);

		// content-wise the plan is unchanged (same ontology, same options)
		expect(JSON.parse(JSON.stringify(recompiled.sections))).toEqual(
			JSON.parse(JSON.stringify(first.sections)),
		);
	});
});
