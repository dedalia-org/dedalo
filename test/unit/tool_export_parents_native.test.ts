/**
 * WC-049 gate — the export parents chain (per-ddo value_with_parents).
 *
 * Contract under test (tools/tool_export + src/diffusion/export/atoms.ts):
 *  - a grid_value export ddo with value_with_parents:true emits each relation
 *    locator TARGET's ancestor chain (getParentsRecursive nearest-first ×
 *    thesaurus term resolver, ' > ' joined, self excluded) as ONE sibling
 *    column whose key ends '#parents' and whose label leaf is 'parents';
 *  - both relation paths emit: the WC-008 compact portal cell AND the
 *    request-config fan-out (autocomplete family);
 *  - the flag is PER-DDO ONLY (the legacy request-global option is ignored);
 *  - the VALUE format (WC-049 addendum 2026-09-25) grows ONE sibling column
 *    `<top>#parents` right after its term column. The cell MIRRORS the term
 *    cell: same separators at the same levels (multi-hop paths too), one
 *    chain per term piece (a target whose text splits into n pieces carries
 *    its chain n times), a target with no term contributes nothing, a
 *    parent-less target an EMPTY slot; absent only when every slot is empty;
 *    flag off (or a literal leaf) → byte-identical output; dedalo_raw never
 *    grows parents (derived data — the client disables the checkbox there);
 *  - targets without hierarchy emit NOTHING (no empty column);
 *  - tool_export.components_with_parent answers the client checkbox gate
 *    (relation component with a hierarchical target → true).
 *
 * Fixture: the canonical test3 playground (matrix_test — the ONE scratch
 * surface). test3 owns a component_relation_parent (test71, group test45), a
 * portal targeting test3 itself (test80) and an autocomplete_hi (test9), and
 * its section_map declares the thesaurus scope (term = test52). The suite
 * builds the ancestor chain 27→2→1 on the scratch rows, stamps known lg-spa
 * test52 term values on the ancestors, and restores the canonical fixture
 * afterwards — PORTABLE across installs, unlike real-thesaurus content.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { restoreCanonicalTest3 } from '../../src/core/test_data/seed.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { clearTermCache } from '../../src/core/ts_object/term_resolver.ts';
import {
	toolExportComponentsWithParent,
	toolExportGetExportGrid,
} from '../../tools/tool_export/server/tool_export.ts';
import { refusalOf } from '../helpers/refusal.ts';

const SECTION = 'test3';
const PORTAL = 'test80'; // component_portal → test3 (compact WC-008 cell)
const AUTOCOMPLETE = 'test9'; // component_autocomplete_hi (fan-out path)
const PARENT_LINK = 'test71'; // test3's component_relation_parent
const LITERAL = 'test52'; // component_input_text (never eligible)
const HIERARCHY_TERM = 'hierarchy25'; // test9's show child (read on the target record)

let principal!: Principal;

const contextOf = (options: Record<string, unknown>): ToolActionContext =>
	({ principal, userId: -1, options, background: false }) as ToolActionContext;

/** One scratch parent link ON a test3 row (the canonical shape test71 stores). */
const parentLocator = (parentId: number): Record<string, unknown> => ({
	id: 1,
	type: 'dd47',
	section_id: String(parentId),
	section_tipo: SECTION,
	from_component_tipo: PARENT_LINK,
});

const setColumnSlot = async (
	column: 'relation' | 'string',
	sectionId: number,
	componentTipo: string,
	items: Record<string, unknown>[],
): Promise<void> => {
	// $2::text::jsonb — bind as TEXT so postgres parses it (a bare ::jsonb bind
	// stores a jsonb STRING scalar — the ledgered Bun.sql trap, json_codec.ts).
	await sql.unsafe(
		`UPDATE matrix_test
		SET ${column} = jsonb_set(COALESCE(${column}, '{}'::jsonb), $1::text[], $2::text::jsonb)
		WHERE section_tipo = $3 AND section_id = $4`,
		[`{${componentTipo}}`, JSON.stringify(items), SECTION, sectionId],
	);
};

const setRelationSlot = (
	sectionId: number,
	componentTipo: string,
	items: Record<string, unknown>[],
): Promise<void> => setColumnSlot('relation', sectionId, componentTipo, items);

beforeAll(async () => {
	principal = await resolvePrincipal(-1);
	await restoreCanonicalTest3();
	// Ancestor chain on the scratch rows: 27 → 2 → 1 (record 1's test71 stays
	// the canonical [] — the walk stops there).
	await setRelationSlot(27, PARENT_LINK, [parentLocator(2)]);
	await setRelationSlot(2, PARENT_LINK, [parentLocator(1)]);
	// Known lg-spa THESAURUS TERM values on the ancestors (test3's section_map
	// thesaurus term = test52) — what the chain resolves and joins.
	await setColumnSlot('string', 2, LITERAL, [{ id: 1, lang: 'lg-spa', value: 'Parent A' }]);
	await setColumnSlot('string', 1, LITERAL, [{ id: 1, lang: 'lg-spa', value: 'Root B' }]);
	// test9's own request_config shows hierarchy25 (the thesaurus term) — give
	// its target one, or the value-format term cell is empty and (by the
	// alignment law) so is its parents mirror.
	await setColumnSlot('string', 27, HIERARCHY_TERM, [
		{ id: 1, lang: 'lg-spa', value: 'Autocomplete leaf' },
	]);
	// The export source row: record 1 already points test80 → test3/27
	// (canonical); give the autocomplete the same target for the fan-out path.
	await setRelationSlot(1, AUTOCOMPLETE, [
		{
			id: 1,
			type: 'dd151',
			section_id: '27',
			section_tipo: SECTION,
			from_component_tipo: AUTOCOMPLETE,
		},
	]);
});

afterAll(async () => {
	await restoreCanonicalTest3(); // healing — leave the playground canonical
});

/** getParentsRecursive(27) nearest-first × the test52 term values stamped above. */
const EXPECTED_CHAIN = 'Parent A > Root B';

const ddo = (
	componentTipo: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	path: [{ section_tipo: SECTION, component_tipo: componentTipo, name: componentTipo }],
	...extra,
});

const exportOptions = (
	dataFormat: string,
	ddos: Record<string, unknown>[],
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	section_tipo: SECTION,
	model: 'section',
	data_format: dataFormat,
	breakdown: 'default',
	ar_ddo_to_export: ddos,
	sqo: {
		section_tipo: [SECTION],
		limit: 0,
		offset: 0,
		filter_by_locators: [{ section_tipo: SECTION, section_id: '1' }],
	},
	...extra,
});

type ProtocolLine = { t: string; i?: number; key?: string; ar_labels?: string[] } & Record<
	string,
	unknown
>;

const runExport = async (
	options: Record<string, unknown>,
): Promise<{ columns: ProtocolLine[]; rows: ProtocolLine[] }> => {
	const response: ToolResponse = await toolExportGetExportGrid(contextOf(options));
	const result = response.data as { columns: ProtocolLine[]; rows: ProtocolLine[] };
	expect(Array.isArray(result?.columns)).toBe(true);
	return result;
};

const parentsColumns = (columns: ProtocolLine[]): ProtocolLine[] =>
	columns.filter((column) => String(column.key ?? '').includes('#parents'));

const cellOf = (rows: ProtocolLine[], ordinal: number): string | undefined => {
	for (const row of rows) {
		const cells = row.c as Record<string, string> | undefined;
		const value = cells?.[String(ordinal)];
		if (value !== undefined) return value;
	}
	return undefined;
};

describe('WC-049 parents chain — grid_value emission', () => {
	test(
		'compact portal cell (WC-008) grows a sibling #parents column with the ' +
			"nearest-first ' > ' chain",
		async () => {
			const { columns, rows } = await runExport(
				exportOptions('grid_value', [ddo(PORTAL, { value_with_parents: true })]),
			);
			const parents = parentsColumns(columns);
			expect(parents).toHaveLength(1);
			const column = parents[0] as ProtocolLine;
			expect(column.key).toBe(`${SECTION}_${PORTAL}.${SECTION}_${PORTAL}#parents`);
			// the sub_id labels the column leaf verbatim
			expect((column.ar_labels ?? []).at(-1)).toBe('parents');
			expect(cellOf(rows, column.i as number)).toBe(EXPECTED_CHAIN);
		},
	);

	test('request-config fan-out (autocomplete family) emits the SAME chain shape', async () => {
		const { columns, rows } = await runExport(
			exportOptions('grid_value', [ddo(AUTOCOMPLETE, { value_with_parents: true })]),
		);
		const parents = parentsColumns(columns);
		expect(parents).toHaveLength(1);
		const column = parents[0] as ProtocolLine;
		expect(column.key).toBe(`${SECTION}_${AUTOCOMPLETE}.${SECTION}_${AUTOCOMPLETE}#parents`);
		expect(cellOf(rows, column.i as number)).toBe(EXPECTED_CHAIN);
	});

	test('per-ddo flag off → no #parents column', async () => {
		const { columns } = await runExport(exportOptions('grid_value', [ddo(PORTAL)]));
		expect(parentsColumns(columns)).toHaveLength(0);
	});

	test('the legacy request-global option is IGNORED (WC-049 per-ddo only)', async () => {
		const { columns } = await runExport(
			exportOptions('grid_value', [ddo(PORTAL)], { value_with_parents: true }),
		);
		expect(parentsColumns(columns)).toHaveLength(0);
	});

	test('a parent-less target emits NOTHING (no empty column)', async () => {
		// record 2's portal → nothing; point the export at record 2 whose test80
		// is canonically absent — and at record 27 via a fresh source: use a ddo
		// on record 1 AFTER stripping the chain below record 27's parent.
		await setRelationSlot(27, PARENT_LINK, []);
		try {
			const { columns } = await runExport(
				exportOptions('grid_value', [ddo(PORTAL, { value_with_parents: true })]),
			);
			expect(parentsColumns(columns)).toHaveLength(0);
		} finally {
			await setRelationSlot(27, PARENT_LINK, [parentLocator(2)]);
		}
	});
});

type ExportResult = { columns: ProtocolLine[]; rows: ProtocolLine[]; end?: ProtocolLine };

/**
 * An export as ordinal-FREE data: every col line keyed by its column key (the
 * ordinal is dropped — it shifts when a column mints in between), the display
 * order as keys, every row's cells re-keyed by column key. Two exports that
 * normalize equal differ in nothing but ordinals.
 */
const normalizeExport = (result: ExportResult, dropKey: (key: string) => boolean = () => false) => {
	const keyOf = new Map<number, string>();
	const cols: Record<string, unknown>[] = [];
	for (const column of result.columns) {
		keyOf.set(column.i as number, String(column.key));
		if (dropKey(String(column.key))) continue;
		const { i: _i, after: _after, ...rest } = column;
		cols.push(rest);
	}
	const order = ((result.end?.columns as number[] | undefined) ?? [])
		.map((ordinal) => keyOf.get(ordinal) as string)
		.filter((key) => !dropKey(key));
	const rows = result.rows.map((row) => {
		const cells: Record<string, string> = {};
		for (const [ordinal, value] of Object.entries((row.c as Record<string, string>) ?? {})) {
			const key = keyOf.get(Number(ordinal)) as string;
			if (!dropKey(key)) cells[key] = value;
		}
		return { rec: row.rec, sub: row.sub, c: cells };
	});
	return { cols, order, rows };
};

const isParentsKey = (key: string): boolean => key.includes('#parents');

/** The display order (end line) as column keys. */
const displayOrder = (result: ExportResult): string[] => {
	const keyOf = new Map(result.columns.map((column) => [column.i as number, String(column.key)]));
	return ((result.end?.columns as number[] | undefined) ?? []).map(
		(ordinal) => keyOf.get(ordinal) as string,
	);
};

/** A test80 locator to a test3 record (the canonical portal locator shape). */
const portalTarget = (id: number): Record<string, unknown> => ({
	id,
	type: 'dd151',
	section_id: String(id),
	section_tipo: SECTION,
	from_component_tipo: PORTAL,
});

/** Snapshot the named slots, run `work`, then write every slot back verbatim. */
const withSlotsRestored = async (
	slots: ['relation' | 'string', number, string][],
	work: () => Promise<void>,
): Promise<void> => {
	const saved: Record<string, unknown>[][] = [];
	for (const [column, sectionId, componentTipo] of slots) {
		const [row] = (await sql.unsafe(
			`SELECT ${column}->$1 AS slot FROM matrix_test WHERE section_tipo = $2 AND section_id = $3`,
			[componentTipo, SECTION, sectionId],
		)) as { slot: Record<string, unknown>[] | null }[];
		saved.push(row?.slot ?? []);
	}
	try {
		await work();
	} finally {
		for (const [position, [column, sectionId, componentTipo]] of slots.entries()) {
			await setColumnSlot(column, sectionId, componentTipo, saved[position] ?? []);
		}
	}
};

/** The term cell and the parents cell of one value-format export of `component`. */
const termAndParents = async (
	options: Record<string, unknown>,
	component: string,
): Promise<{ term: string | undefined; parents: string | undefined }> => {
	const result = await runExport(options);
	const term = result.columns.find((c) => c.key === `${SECTION}_${component}`) as ProtocolLine;
	const parents = parentsColumns(result.columns);
	expect(parents).toHaveLength(1);
	return {
		term: cellOf(result.rows, term.i as number),
		parents: cellOf(result.rows, (parents[0] as ProtocolLine).i as number),
	};
};

describe('WC-049 parents chain — value format (addendum 2026-09-25)', () => {
	for (const component of [PORTAL, AUTOCOMPLETE]) {
		test(`${component}: a sibling '<top>#parents' column right after the term column`, async () => {
			const result = (await runExport(
				exportOptions('value', [ddo(component, { value_with_parents: true })]),
			)) as ExportResult;
			const parents = parentsColumns(result.columns);
			expect(parents).toHaveLength(1);
			const column = parents[0] as ProtocolLine;
			expect(column.key).toBe(`${SECTION}_${component}#parents`);
			expect((column.ar_labels ?? []).at(-1)).toBe('parents');
			expect(String(column.label)).toEndWith(' | parents');
			expect(column.cell_type).toBe('text');
			expect(cellOf(result.rows, column.i as number)).toBe(EXPECTED_CHAIN);
			// placement: immediately after its own term column
			expect(displayOrder(result)).toEqual([
				`${SECTION}_${component}`,
				`${SECTION}_${component}#parents`,
			]);
			// the term cell stays clean — no chain folded into it
			const term = result.columns.find((c) => c.key === `${SECTION}_${component}`);
			const termCell = cellOf(result.rows, term?.i as number);
			// a chain pairs with a term piece — never with an empty term cell
			expect(termCell ?? '').not.toBe('');
			expect(termCell).not.toContain(EXPECTED_CHAIN);
		});
	}

	test("multi-item: one chain per item, ' | '-aligned with the term cell, a parent-less item keeps an EMPTY slot", async () => {
		const [stored] = (await sql.unsafe(
			`SELECT relation->'${PORTAL}' AS slot FROM matrix_test WHERE section_tipo = $1 AND section_id = 1`,
			[SECTION],
		)) as { slot: Record<string, unknown>[] | null }[];
		const [storedTerm] = (await sql.unsafe(
			`SELECT string->'${LITERAL}' AS slot FROM matrix_test WHERE section_tipo = $1 AND section_id = 27`,
			[SECTION],
		)) as { slot: Record<string, unknown>[] | null }[];
		const target = (id: number): Record<string, unknown> => ({
			id,
			type: 'dd151',
			section_id: String(id),
			section_tipo: SECTION,
			from_component_tipo: PORTAL,
		});
		// items: 27 (chain 'Parent A > Root B'), 1 (no parents), 2 (chain 'Root B')
		await setColumnSlot('string', 27, LITERAL, [{ id: 1, lang: 'lg-spa', value: 'Leaf C' }]);
		await setRelationSlot(1, PORTAL, [target(27), target(1), target(2)]);
		try {
			const result = (await runExport(
				exportOptions('value', [ddo(PORTAL, { value_with_parents: true })]),
			)) as ExportResult;
			const term = result.columns.find((c) => c.key === `${SECTION}_${PORTAL}`) as ProtocolLine;
			const column = parentsColumns(result.columns)[0] as ProtocolLine;
			expect(cellOf(result.rows, term.i as number)).toBe('Leaf C | Root B | Parent A');
			expect(cellOf(result.rows, column.i as number)).toBe(`${EXPECTED_CHAIN} |  | Root B`);
		} finally {
			await setRelationSlot(1, PORTAL, stored?.slot ?? []);
			await setColumnSlot('string', 27, LITERAL, storedTerm?.slot ?? []);
		}
	});

	test('two ddos: each grows its OWN parents column after its own term column', async () => {
		const result = (await runExport(
			exportOptions('value', [
				ddo(PORTAL, { value_with_parents: true }),
				ddo(AUTOCOMPLETE, { value_with_parents: true }),
			]),
		)) as ExportResult;
		expect(displayOrder(result)).toEqual([
			`${SECTION}_${PORTAL}`,
			`${SECTION}_${PORTAL}#parents`,
			`${SECTION}_${AUTOCOMPLETE}`,
			`${SECTION}_${AUTOCOMPLETE}#parents`,
		]);
	});

	test('every target parent-less → the column still mints, the cell is EMPTY', async () => {
		await setRelationSlot(27, PARENT_LINK, []);
		try {
			const result = (await runExport(
				exportOptions('value', [ddo(PORTAL, { value_with_parents: true })]),
			)) as ExportResult;
			const parents = parentsColumns(result.columns);
			expect(parents).toHaveLength(1);
			expect(cellOf(result.rows, (parents[0] as ProtocolLine).i as number)).toBeUndefined();
		} finally {
			await setRelationSlot(27, PARENT_LINK, [parentLocator(2)]);
		}
	});

	// ---- ALIGNMENT: the parents cell has the term cell's exact join structure
	// (review 2026-09-25 — the three ways a flat per-locator list mis-paired).

	test('multi-hop path: the parents cell mirrors the term cell level by level', async () => {
		// [test3/test80 → test3/test80]: level 0 joins hops with ' | ', the leaf
		// joins its items with test80's fields_separator (', ' — the default).
		await withSlotsRestored(
			[
				['relation', 1, PORTAL],
				['relation', 27, PORTAL],
				['relation', 2, PORTAL],
				['string', 27, LITERAL],
			],
			async () => {
				await setColumnSlot('string', 27, LITERAL, [{ id: 1, lang: 'lg-spa', value: 'Leaf C' }]);
				await setRelationSlot(1, PORTAL, [portalTarget(27), portalTarget(2)]);
				await setRelationSlot(27, PORTAL, [portalTarget(27), portalTarget(2)]);
				await setRelationSlot(2, PORTAL, [portalTarget(27)]);
				const deep = {
					path: [
						{ section_tipo: SECTION, component_tipo: PORTAL, name: PORTAL },
						{ section_tipo: SECTION, component_tipo: PORTAL, name: PORTAL },
					],
					value_with_parents: true,
				};
				const { term, parents } = await termAndParents(exportOptions('value', [deep]), PORTAL);
				// hop 27 → leaf [27, 2]; hop 2 → leaf [27]
				expect(term).toBe('Leaf C, Parent A | Leaf C');
				expect(parents).toBe(`${EXPECTED_CHAIN}, Root B | ${EXPECTED_CHAIN}`);
				// three steps: the INTERMEDIATE level joins with its own
				// fields_separator (', '), never the records separator
				const deeper = { ...deep, path: [...deep.path, deep.path[0]] };
				const three = await termAndParents(exportOptions('value', [deeper]), PORTAL);
				// hop 27 → [27 → leaf [27, 2], 2 → leaf [27]]; hop 2 → [27 → leaf [27, 2]]
				expect(three.term).toBe('Leaf C, Parent A, Leaf C | Leaf C, Parent A');
				expect(three.parents).toBe(
					`${EXPECTED_CHAIN}, Root B, ${EXPECTED_CHAIN} | ${EXPECTED_CHAIN}, Root B`,
				);
			},
		);
	});

	test('a target whose term is EMPTY drops from BOTH cells (no orphan chain slot)', async () => {
		await withSlotsRestored(
			[
				['relation', 1, PORTAL],
				['string', 27, LITERAL],
			],
			async () => {
				// 27 has a chain but no term; 2 has term 'Parent A' and chain 'Root B'
				await setColumnSlot('string', 27, LITERAL, []);
				await setRelationSlot(1, PORTAL, [portalTarget(27), portalTarget(2)]);
				const { term, parents } = await termAndParents(
					exportOptions('value', [ddo(PORTAL, { value_with_parents: true })]),
					PORTAL,
				);
				expect(term).toBe('Parent A');
				expect(parents).toBe('Root B');
			},
		);
	});

	test("a target whose text holds the item separator gets one chain PER ' | ' piece", async () => {
		// The same shape a request_config fields_separator ' | ' over two or more
		// show children produces (rsc368-like 'A | 1 | B | 2'): the pieces a
		// consumer splits out of ONE target all carry that target's chain.
		await withSlotsRestored(
			[
				['relation', 1, PORTAL],
				['string', 27, LITERAL],
			],
			async () => {
				await setColumnSlot('string', 27, LITERAL, [{ id: 1, lang: 'lg-spa', value: 'A | 1' }]);
				await setRelationSlot(1, PORTAL, [portalTarget(27), portalTarget(2)]);
				const { term, parents } = await termAndParents(
					exportOptions('value', [ddo(PORTAL, { value_with_parents: true })]),
					PORTAL,
				);
				expect(term).toBe('A | 1 | Parent A');
				expect(parents).toBe(`${EXPECTED_CHAIN} | ${EXPECTED_CHAIN} | Root B`);
				expect((parents ?? '').split(' | ')).toHaveLength((term ?? '').split(' | ').length);
			},
		);
	});

	test('flag ON changes NOTHING but the added parents columns (term cells, labels, order)', async () => {
		const ddos = (flag: boolean) => [
			ddo(PORTAL, { value_with_parents: flag }),
			ddo(AUTOCOMPLETE, { value_with_parents: flag }),
			ddo(LITERAL),
		];
		const off = (await runExport(exportOptions('value', ddos(false)))) as ExportResult;
		const on = (await runExport(exportOptions('value', ddos(true)))) as ExportResult;
		expect(parentsColumns(off.columns)).toHaveLength(0);
		expect(parentsColumns(on.columns)).toHaveLength(2);
		expect(normalizeExport(on, isParentsKey)).toEqual(normalizeExport(off));
	});

	test('flag on a LITERAL leaf → byte-identical to flag off (no column, no cell)', async () => {
		const off = await runExport(exportOptions('value', [ddo(LITERAL)]));
		const on = await runExport(
			exportOptions('value', [ddo(LITERAL, { value_with_parents: true })]),
		);
		expect(JSON.stringify(on)).toBe(JSON.stringify(off));
	});

	test('flag off → byte-identical to a ddo without the key at all', async () => {
		const without = await runExport(exportOptions('value', [ddo(PORTAL), ddo(AUTOCOMPLETE)]));
		const off = await runExport(
			exportOptions('value', [
				ddo(PORTAL, { value_with_parents: false }),
				ddo(AUTOCOMPLETE, { value_with_parents: false }),
			]),
		);
		expect(JSON.stringify(off)).toBe(JSON.stringify(without));
		expect(parentsColumns(without.columns)).toHaveLength(0);
	});
});

/**
 * THES-01 on a PUBLISHED value (B6 review M2): the parents chain reads each
 * ancestor through getTermByLocator — the door the diffusion resolver and every
 * export share — so it carries the one term fallback chain
 * (WC-2026-11-22-term-fallback-chain): export lang → hierarchy main lang →
 * lg-nolan → the project langs in config order, then STOP; plain text, never
 * markup. Langs come from the install config, never module literals.
 */
describe('THES-01 — the published chain reads the one term fallback chain', () => {
	const EXPORT_LANG = config.menu.dataLang;
	// the test TLD has no hierarchy registry row → term_resolver getMainLang's tail
	const MAIN = 'lg-eng';
	const FAR = [...config.menu.projectsDefaultLangs]
		.reverse()
		.find((code) => code !== EXPORT_LANG && code !== MAIN) as string;
	// a real lang code no project declares (the configured list never holds Klingon)
	const NON_PROJECT = 'lg-tlh';

	const chainWithParentIn = async (lang: string): Promise<string | undefined> => {
		let cell: string | undefined;
		await withSlotsRestored(
			[
				['string', 2, LITERAL],
				['string', 1, LITERAL],
			],
			async () => {
				await setColumnSlot('string', 2, LITERAL, [{ id: 1, lang, value: 'Far parent' }]);
				await setColumnSlot('string', 1, LITERAL, [{ id: 1, lang: EXPORT_LANG, value: 'Root B' }]);
				clearTermCache(); // the slots were written behind the engine's back
				try {
					const { columns, rows } = await runExport(
						exportOptions('grid_value', [ddo(PORTAL, { value_with_parents: true })], {
							lang: EXPORT_LANG,
						}),
					);
					const parents = parentsColumns(columns);
					expect(parents).toHaveLength(1);
					cell = cellOf(rows, (parents[0] as ProtocolLine).i as number);
				} finally {
					clearTermCache();
				}
			},
		);
		return cell;
	};

	test('precondition: the export lang, the main lang, a later project lang and a non-project lang are four', () => {
		expect(typeof FAR).toBe('string');
		expect(config.menu.projectsDefaultLangs).not.toContain(NON_PROJECT);
		expect(new Set([EXPORT_LANG, MAIN, FAR, NON_PROJECT, 'lg-nolan']).size).toBe(5);
	});

	test('an ancestor named only in a later PROJECT lang publishes that text, plain', async () => {
		expect(await chainWithParentIn(FAR)).toBe('Far parent > Root B');
	});

	test('an ancestor named only in a NON-project lang is not published — the chain stops', async () => {
		expect(await chainWithParentIn(NON_PROJECT)).toBe('Root B');
	});
});

describe('WC-049 parents chain — format confinement', () => {
	test("'dedalo_raw' format never grows parents columns", async () => {
		const { columns } = await runExport(
			exportOptions('dedalo_raw', [ddo(PORTAL, { value_with_parents: true })]),
		);
		expect(parentsColumns(columns)).toHaveLength(0);
	});
});

describe('tool_export.components_with_parent (client checkbox gate)', () => {
	test('relation component with a hierarchical target → true; literal → false', async () => {
		const response = await toolExportComponentsWithParent(
			contextOf({
				section_tipo: SECTION,
				components: [
					{ tipo: PORTAL, section_tipo: SECTION },
					{ tipo: LITERAL, section_tipo: SECTION },
				],
			}),
		);
		expect(response.data).toEqual({ [PORTAL]: true, [LITERAL]: false });
	});

	test('empty/invalid input is REFUSED with a registered code', async () => {
		const refusal = await refusalOf(
			toolExportComponentsWithParent(contextOf({ section_tipo: SECTION, components: [] })),
		);
		expect(refusal.code).toBe('request.invalid_options');
	});
});
