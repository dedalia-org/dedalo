/**
 * VALUE-LAW AGREEMENT — the HERMETIC half (P2-17: DATA-14, DATA-26, DATA-27,
 * DATA-32, DATA-33). A value law is a question the engine answers about a
 * component or a section — "is this model single-value?", "what is this
 * section's real section?", "is this text a record address?", "which id does
 * a blank slot pair at?", "is this table covered by its derived store?" — and
 * each of the five findings was TWO answers to one question. The fix gives
 * each question ONE home; this file refuses a second copy, tree-wide:
 *
 *   DATA-14  the `monovalue` descriptor facet (registry isMonovalueModel) is
 *            the list — pinned against the frozen PHP array, no literal copy
 *            anywhere under src/ or tools/, every consumer imports the accessor;
 *   DATA-33  getSectionRealTipo (ontology/resolver.ts) is the virtual→real
 *            law — no `relations[0]` copy anywhere, one definition;
 *   DATA-26  sectionIdAddressSqlPredicate (concepts/section_id.ts) is the SQL
 *            record-address predicate — the trigger body in
 *            db_pg_definitions.json carries it verbatim, the loose `^-?[0-9]+$`
 *            filter is gone, every `::int` cast of a locator id sits behind it;
 *   DATA-27  the blank dataframe slot is counter+1 on both sides of the wire;
 *   DATA-32  derived-store coverage is per (store, table) — no store-wide
 *            emptiness probe, both gates route through tableCoveredByStore.
 *
 * Census is TOTAL where the audit says TOTAL: the descriptor set, the source
 * tree, the definitions file — each derived, each with a floor, and each
 * scanner proven on a planted offender. The behavioural half runs on the suite
 * database: test/unit/value_law_agreement_native.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	allComponentModels,
	getComponentModel,
	isMonovalueModel,
} from '../../src/core/components/registry.ts';
import {
	INT4_MAX,
	INT4_MIN,
	isConvertibleSectionIdString,
	SECTION_ID_ADDRESS_SQL_PATTERN,
	sectionIdAddressSqlPredicate,
} from '../../src/core/concepts/section_id.ts';
import {
	type AssetEntry,
	decideSearchStores,
	RELATION_INDEX_ADDRESS_PREDICATE,
	SEARCH_STORE_BACKFILLS,
} from '../../src/core/db/db_assets.ts';
import definitions from '../../src/core/db/db_pg_definitions.json';
import { stripComments } from '../helpers/strip_comments.ts';
import { WRITE_PATH_CORPUS_FLOOR, writePathSourceFiles } from '../helpers/write_path_corpus.ts';

const ROOT = resolve(import.meta.dir, '../..');

/**
 * The corpus is THE registered write-path lister (src/ + tools/ + scripts/):
 * roots are declared there, never chosen in this file (census_derivation).
 */
const ENGINE_FILES = writePathSourceFiles();
/** Floor on the engine census — a walk that lost a root is not a census. */
const ENGINE_FILES_FLOOR = WRITE_PATH_CORPUS_FLOOR;

function code(rel: string): string {
	return stripComments(readFileSync(join(ROOT, rel), 'utf8'));
}

// ---------------------------------------------------------------------------
// DATA-14 — the monovalue law
// ---------------------------------------------------------------------------

/**
 * PHP component_common::$components_monovalue, class.component_common.php:180-196
 * — the FROZEN oracle list, the only copy of it in this repository.
 */
const PHP_COMPONENTS_MONOVALUE = [
	'component_3d',
	'component_av',
	'component_geolocation',
	'component_image',
	'component_json',
	'component_password',
	'component_pdf',
	'component_publication',
	'component_model',
	'component_section_id',
	'component_security_access',
	'component_select',
	'component_select_lang',
	'component_svg',
	'component_text_area',
];

/**
 * The PHP names that are NOT registered TS models — each with its reason, and
 * each MEASURED below (the exemption holds only while the model is unregistered;
 * registering it makes this pin fail, which is the intended ratchet).
 */
const PHP_NAMES_NOT_REGISTERED: Record<string, string> = {
	component_model:
		'PHP-only: the ontology-editor model picker never ported (no descriptor, no column, no node dispatches on it).',
};

/**
 * The list's SIGNATURE: its non-media members. The media models (3d/av/image/
 * pdf/svg) are legitimately enumerated as a FAMILY by the media engines, so
 * they cannot distinguish a monovalue copy from a media list; the other ten
 * names share nothing but this law. A file quoting this many of them as string
 * literals is carrying the list.
 */
const MEDIA_MODELS = new Set([
	'component_3d',
	'component_av',
	'component_image',
	'component_pdf',
	'component_svg',
]);
const LIST_SIGNATURE = PHP_COMPONENTS_MONOVALUE.filter((name) => !MEDIA_MODELS.has(name));
const LIST_COPY_THRESHOLD = 4;

/**
 * The most signature names quoted inside ONE array literal (`[...]`, which is
 * also the body of every `new Set([...])`): a list is names side by side, a
 * dispatch switch is names apart.
 */
function quotedMonovalueNames(source: string): number {
	let most = 0;
	for (const literal of source.match(/\[[^[\]]*\]/g) ?? []) {
		let count = 0;
		for (const name of LIST_SIGNATURE) {
			if (new RegExp(`['"\`]${name}['"\`]`).test(literal)) count++;
		}
		most = Math.max(most, count);
	}
	return most;
}

describe('DATA-14 — the `monovalue` facet IS the PHP registry, and the only copy', () => {
	const descriptors = allComponentModels();
	const descriptorFiles = ENGINE_FILES.filter((rel) =>
		/^src\/core\/components\/component_[a-z0-9_]+\/descriptor\.ts$/.test(rel),
	);

	test('the census is the descriptor tree (floor), one registered model per file', () => {
		expect(descriptorFiles.length).toBeGreaterThan(30);
		expect(descriptors.length).toBe(descriptorFiles.length);
	});

	test('registry-derived monovalue set == frozen PHP list minus the measured non-registered names', () => {
		const derived = descriptors
			.filter((descriptor) => descriptor.monovalue === true)
			.map((descriptor) => descriptor.model)
			.sort();
		const expected = PHP_COMPONENTS_MONOVALUE.filter(
			(name) => PHP_NAMES_NOT_REGISTERED[name] === undefined,
		).sort();
		expect(derived).toEqual(expected);
		for (const [name, reason] of Object.entries(PHP_NAMES_NOT_REGISTERED)) {
			expect(reason.length).toBeGreaterThan(30);
			expect(
				getComponentModel(name),
				`${name} is registered now — drop its exemption`,
			).toBeUndefined();
		}
	});

	test('the facet is declared only as `true`, and alias models inherit it through the canonical hop', () => {
		for (const descriptor of descriptors) {
			expect([undefined, true]).toContain(descriptor.monovalue);
			if (descriptor.alias !== undefined) {
				expect(
					descriptor.monovalue,
					`${descriptor.model}: an alias declares no facet`,
				).toBeUndefined();
				expect(isMonovalueModel(descriptor.model)).toBe(isMonovalueModel(descriptor.alias));
			}
		}
		expect(isMonovalueModel('component_html_text')).toBe(true); // → component_text_area
		expect(isMonovalueModel('component_portal')).toBe(false);
		expect(isMonovalueModel('component_dataframe')).toBe(false);
	});

	test('NO literal copy of the list survives under src/ or tools/ (planted offender detected)', () => {
		expect(ENGINE_FILES.length).toBeGreaterThan(ENGINE_FILES_FLOOR);
		// positive control: the scanner recognises the PHP array itself
		const planted = `const COPY = new Set([${PHP_COMPONENTS_MONOVALUE.map((n) => `'${n}'`).join(', ')}]);`;
		expect(LIST_SIGNATURE.length).toBe(10);
		expect(quotedMonovalueNames(planted)).toBe(LIST_SIGNATURE.length);
		const copies = ENGINE_FILES.filter(
			(rel) => quotedMonovalueNames(code(rel)) >= LIST_COPY_THRESHOLD,
		);
		expect(copies, 'a second monovalue list — link the registry facet instead').toEqual([]);
	});

	test('every writer that decides on monovalue consults the registry accessor (derived consumers, floor)', () => {
		const consumers = ENGINE_FILES.filter(
			(rel) => !rel.startsWith('src/core/components/') && /monovalue/i.test(code(rel)),
		);
		expect(consumers.length).toBeGreaterThanOrEqual(2);
		expect(consumers).toContain('src/core/section/record/save_component.ts');
		expect(consumers).toContain('tools/tool_propagate_component_data/server/index.ts');
		for (const rel of consumers) {
			expect(code(rel), `${rel} decides monovalue without isMonovalueModel`).toMatch(
				/import \{[^}]*\bisMonovalueModel\b[^}]*\} from '[^']*components\/registry\.ts'/,
			);
		}
		// and the write engine consults it on BOTH branches: the insert branch
		// (PHP's) and applyUpdate (the WC-2026-08-08 extension)
		const save = code('src/core/section/record/save_component.ts');
		expect(save).toMatch(/if \(monovalue\) \{[\s\S]*?hasReplacingInserts = true;/);
		expect(save).toMatch(/applyUpdate\([^;]*\bmonovalue\b[^;]*\)/);
	});
});

// ---------------------------------------------------------------------------
// DATA-33 — the virtual→real law
// ---------------------------------------------------------------------------

const RELATIONS_ZERO = /relations\??\.\[0\]|relations\[0\]/;
const SQL_SECTION_TWIN = /rel\.link->>'tipo' AND t\.model = 'section'/;

describe('DATA-33 — getSectionRealTipo is the ONE virtual→real law', () => {
	test('exactly one definition, in ontology/resolver.ts; the datalist module re-exports it', () => {
		const definitions = ENGINE_FILES.filter((rel) =>
			/export async function getSectionRealTipo\(/.test(code(rel)),
		);
		expect(definitions).toEqual(['src/core/ontology/resolver.ts']);
		expect(code('src/core/resolve/security_access_datalist.ts')).toContain(
			"export { getSectionRealTipo } from '../ontology/resolver.ts';",
		);
	});

	test('no `relations[0]` copy anywhere under src/ or tools/ (planted offender detected)', () => {
		expect(ENGINE_FILES.length).toBeGreaterThan(ENGINE_FILES_FLOOR);
		// positive controls: the three spellings the copies used
		expect(RELATIONS_ZERO.test('const real = nodeRows[0]?.relations?.[0]?.tipo;')).toBe(true);
		expect(RELATIONS_ZERO.test('(relations[0] as { tipo?: unknown } | undefined)?.tipo')).toBe(
			true,
		);
		expect(
			SQL_SECTION_TWIN.test(
				"JOIN dd_ontology t ON t.tipo = rel.link->>'tipo' AND t.model = 'section'",
			),
		).toBe(true);
		const offenders = ENGINE_FILES.filter((rel) => {
			const source = code(rel);
			return RELATIONS_ZERO.test(source) || SQL_SECTION_TWIN.test(source);
		});
		expect(offenders, 'a relations[0] copy — call getSectionRealTipo').toEqual([]);
	});

	test('every borrower of a real section`s definitions resolves through the law (derived, floor)', () => {
		// The borrowers are the files that read a section's CHILDREN by model and
		// fall back to another section: they name the accessor, and none of them
		// re-implements the model loop.
		const borrowers = ENGINE_FILES.filter((rel) => /\bgetSectionRealTipo\b/.test(code(rel)));
		expect(borrowers.length).toBeGreaterThanOrEqual(15);
		for (const rel of [
			'src/core/section/list_definitions/node_find.ts',
			'src/core/ontology/section_map.ts',
			'src/core/section/buttons.ts',
			'src/core/ts_object/ts_object.ts',
			'src/core/resolve/relation_index.ts',
			// the record wipe AND the covered-slot recompute share ONE section census
			'src/core/section/record/declared_components.ts',
			'src/core/identify/profile.ts',
			'src/core/identify/profile_source.ts',
			'src/core/relations/request_config/implicit.ts',
			// (explicit.ts LEFT this list with T0-2: its button lookup now DELEGATES
			// to section/buttons.ts sectionButtonRows — listed above — the ONE
			// virtual-aware + exclude_elements-aware button resolution; it no
			// longer names the law because it no longer borrows by itself)
			'src/diffusion/resolve/resolver.ts',
			'src/ai/mcp/tools/discovery.ts',
		]) {
			expect(borrowers, `${rel} no longer resolves through getSectionRealTipo`).toContain(rel);
		}
	});
});

// ---------------------------------------------------------------------------
// DATA-26 — the SQL record-address predicate
// ---------------------------------------------------------------------------

const LOOSE_NUMERIC_FILTER = "'^-?[0-9]+$'";

describe('DATA-26 — the trigger, its twins and the app agree on what a record address is', () => {
	const relationIndexFn = (definitions.ar_function as AssetEntry[]).find(
		(entry) => entry.name === 'matrix_relation_index_sync',
	);
	const relationIndexTable = (definitions.ar_table as AssetEntry[]).find(
		(entry) => entry.name === 'matrix_relation_index',
	);

	test('the trigger body carries the exported predicate VERBATIM, and so does the backfill contract', () => {
		expect(relationIndexFn).toBeDefined();
		expect((relationIndexFn as AssetEntry).add).toContain(RELATION_INDEX_ADDRESS_PREDICATE);
		expect((relationIndexTable as AssetEntry).info).toContain(RELATION_INDEX_ADDRESS_PREDICATE);
		const contract = SEARCH_STORE_BACKFILLS.find(({ store }) => store === 'matrix_relation_index');
		expect(contract?.insert('matrix_test')).toContain(RELATION_INDEX_ADDRESS_PREDICATE);
		expect(contract?.probe('matrix_test')).toContain(RELATION_INDEX_ADDRESS_PREDICATE);
		expect(RELATION_INDEX_ADDRESS_PREDICATE).toBe(sectionIdAddressSqlPredicate("e->>'section_id'"));
	});

	test('the loose `^-?[0-9]+$` filter is gone from the corpus (ts + json), and every locator-id cast sits behind the predicate', () => {
		const files = [...ENGINE_FILES, 'src/core/db/db_pg_definitions.json'];
		expect(files.length).toBeGreaterThan(ENGINE_FILES_FLOOR);
		const loose = files.filter((rel) =>
			readFileSync(join(ROOT, rel), 'utf8').includes(LOOSE_NUMERIC_FILTER),
		);
		// ENUMERATED, shrink-only: the pattern used as a CLASSIFIER arm, never as
		// an admission filter. Each entry must still carry the pattern (stale = red).
		const LOOSE_AS_CLASSIFIER: Record<string, string> = {
			'scripts/census_section_id.ts':
				'the read-only section_id CENSUS: the pattern is one CASE arm of a classifier whose earlier arms already separated the zero-padded (str-leading-zero) and out-of-range classes — it counts and reports, it admits nothing and casts nothing.',
		};
		for (const [rel, reason] of Object.entries(LOOSE_AS_CLASSIFIER)) {
			expect(reason.length).toBeGreaterThan(40);
			expect(loose, `${rel}: stale classifier exemption`).toContain(rel);
		}
		expect(
			loose.filter((rel) => LOOSE_AS_CLASSIFIER[rel] === undefined),
			'the loose numeric filter admits zero-padded external ids',
		).toEqual([]);
		// every file that CASTS a locator's section_id to int, or regex-tests it, names the predicate
		const casters = ENGINE_FILES.filter((rel) => {
			const source = code(rel);
			return /\(e->>'section_id'\)::int/.test(source) || /->>'section_id' !?~/.test(source);
		});
		expect(casters.length).toBeGreaterThanOrEqual(1);
		expect(casters).toContain('src/core/db/db_assets.ts');
		for (const rel of casters) {
			expect(code(rel), `${rel} casts a locator id outside the predicate`).toMatch(
				/RELATION_INDEX_ADDRESS_PREDICATE|sectionIdAddressSqlPredicate\(/,
			);
		}
		// the integrity report enumerates the SKIPPED class with the same predicate
		const report = code('src/core/area_maintenance/widgets/database_info.ts');
		expect(report).toContain('NOT ${sectionIdAddressSqlPredicate("e->>\'section_id\'")}');
		expect(report).toContain('non_numeric_locators_by_table');
	});

	test('the POSIX pattern is the JS rule (hermetic twin over a corpus; int4 bound is SQL-only and declared)', () => {
		const posix = new RegExp(SECTION_ID_ADDRESS_SQL_PATTERN);
		const corpus = [
			'0',
			'7',
			'-1',
			'-666',
			'1338683',
			'001338683',
			'01',
			'-0',
			'-01',
			'Q42',
			'search_1',
			'',
			' 7',
			'7 ',
			'1e3',
			'0x10',
			'1.0',
			String(INT4_MAX),
			String(INT4_MIN),
			'9007199254740991',
		];
		let accepted = 0;
		for (const value of corpus) {
			// within the safe-integer range the two rules coincide exactly
			expect(posix.test(value), JSON.stringify(value)).toBe(isConvertibleSectionIdString(value));
			if (posix.test(value)) accepted++;
		}
		expect(accepted).toBeGreaterThanOrEqual(6);
		expect(corpus.length - accepted).toBeGreaterThanOrEqual(10);
		// the SQL side additionally bounds to int4 — stated in the predicate itself
		expect(RELATION_INDEX_ADDRESS_PREDICATE).toContain(`BETWEEN ${INT4_MIN} AND ${INT4_MAX}`);
		expect(RELATION_INDEX_ADDRESS_PREDICATE).toMatch(/^\(CASE WHEN .* THEN .* ELSE false END\)$/);
	});
});

// ---------------------------------------------------------------------------
// DATA-27 — the blank slot id
// ---------------------------------------------------------------------------

describe('DATA-27 — the blank dataframe slot is counter+1 on both sides of the wire', () => {
	test('the server derives the blank pair id from the counter, never a literal 1', () => {
		const read = code('src/core/section/read.ts');
		expect(read).toContain('[frameCounter + 1]');
		expect(read).not.toMatch(/storedIds\s*:\s*\[1\]/);
	});

	test('the client derives the same id (both derivation sites)', () => {
		for (const rel of [
			'client/dedalo/core/component_common/js/dataframe.js',
			'client/dedalo/core/component_iri/js/render_edit_component_iri.js',
		]) {
			expect(code(rel), rel).toMatch(/\.id \?\? \(self\.data\.counter\s*\+\s*1\)/);
		}
	});
});

// ---------------------------------------------------------------------------
// DATA-32 — per (store, table) coverage
// ---------------------------------------------------------------------------

describe('DATA-32 — derived-store coverage is per (store, table)', () => {
	test('no store-wide emptiness probe; both gates route through tableCoveredByStore', () => {
		const store = code('src/core/search/search_store.ts');
		expect(store).not.toContain('storeIsNonEmpty');
		expect(store).not.toMatch(/FROM "\$\{storeTable\}" LIMIT 1/);
		const covers = /export async function searchStoreCovers[\s\S]*?\n\}/.exec(store)?.[0] ?? '';
		const relation = /export async function relationIndexCovers[\s\S]*?\n\}/.exec(store)?.[0] ?? '';
		expect(covers).toContain('tableCoveredByStore(');
		expect(relation).toContain('tableCoveredByStore(');
		// the backfill contract carries the per-table probes both sides use
		for (const contract of SEARCH_STORE_BACKFILLS) {
			expect(contract.holdsRowsFor('matrix_test')).toContain('LIMIT 1');
			expect(contract.deleteFor('matrix_test')).toMatch(/^\s*DELETE FROM /);
		}
	});

	test('the pure boot fold selects the uncovered table of a store that is populated for another', () => {
		const decision = decideSearchStores({ ddlNeeded: false }, [
			{
				store: 'matrix_string_search',
				table: 'matrix_test',
				exists: true,
				holdsRows: true,
				sourceProducesRows: false,
			},
			{
				store: 'matrix_string_search',
				table: 'matrix_users',
				exists: true,
				holdsRows: false,
				sourceProducesRows: true,
			},
			{
				store: 'matrix_string_search',
				table: 'matrix_langs',
				exists: true,
				holdsRows: false,
				sourceProducesRows: false,
			},
		]);
		expect(decision.tablesNeedingBackfill).toEqual([
			{ store: 'matrix_string_search', table: 'matrix_users' },
		]);
		expect(decision.healthy).toBe(false);
	});
});
