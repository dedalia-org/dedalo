/**
 * DATALIST BUILD — `getDatalist` (src/core/relations/datalist.ts:340), the
 * option list behind every select / radio / check_box / autocomplete widget.
 *
 * What is gated here (the branch inventory of the function, not just its happy
 * path):
 *  - target-section enumeration, including a target whose tipo resolves an
 *    ontology model but NO matrix table (skipped, never fatal);
 *  - the label projection: EVERY component-model show ddo joined with exactly
 *    ' | ', non-component ddos dropped;
 *  - the DEFAULT ordering — strnatcmp on the label ("Item 1 / Item 2 /
 *    Item 10 / Item 20", not the lexicographic "Item 1 / Item 10 / Item 2").
 *    strnatcmp itself is gated directly by test/unit/strnatcmp.test.ts; what
 *    is gated HERE is the WIRING (that the default comparator is that one);
 *  - the properties.sort_by custom rule: DESC / omitted direction / a
 *    non-numeric path / a path no item carries (the `?? 0` fallback);
 *  - fixed_filter narrowing: the FIRST expanded group becomes the option
 *    search's filter, and a fixed_filter that expands to NO group leaves the
 *    enumeration unnarrowed;
 *  - the dd1067 security-tools enrichment (tool_name / always_active /
 *    tool_description), absent
 *    on every other component;
 *  - the CACHE: key `${componentTipo}_${ownerSectionTipo}_${lang}_<labels>|<hides>|
 *    <enumeration fingerprints>` (the owner section joined the key on
 *    2026-08-14 — a component's target sections can resolve FROM THE CALLER, so
 *    one node serves different option lists to different owners; see
 *    datalist_cache_key_native.test.ts; the enumeration statement on
 *    2026-11-12 — the record-resolved filter and the caller's record ACL, see
 *    datalist_record_filter_native / datalist_projects_scope_native),
 *    eviction through the section-data listener, and the agreement between a
 *    cold `probeDatalistSize` and the built list.
 *
 * CACHE DISCIPLINE. Each variant still uses its OWN componentTipo and clears the
 * cache, so a case never depends on what an earlier one cached.
 *
 * SCRATCH SURFACE: test3 (matrix_test) records 929001-929999 ONLY — seeded by
 * this file, swept in afterAll (rows + their TM tail, fail-loud). The canonical
 * playground records (test3/1, /2, /27) are never asserted against; every
 * assertion projects the built list onto the seeded id range, because the suite
 * DB is shared and other section rows come and go.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearDatalistCache,
	type DatalistItem,
	getDatalist as getComponentDatalist,
	probeDatalistSize,
} from '../../src/core/relations/datalist.ts';
import { fireSaveEvent } from '../../src/core/section_record/save_event.ts';
import { PROFILE_TOOLS_COMPONENT } from '../../src/core/tools/ontology_map.ts';

/**
 * These gates exercise the GENERIC target-section option list (their components
 * declare no model `datalistSource`), so the wider door type narrows here.
 */
const getDatalist = (...args: Parameters<typeof getComponentDatalist>) =>
	getComponentDatalist(...args) as Promise<DatalistItem[]>;

const SECTION = 'test3'; // matrix_test
const LABEL_DDO = 'test52'; // component_input_text
const SECOND_DDO = 'test17'; // component_text_area — the ' | ' join partner
const MARKER_DDO = 'test162'; // component_input_text — the fixed_filter axis
const NOT_A_COMPONENT_DDO = 'test45'; // model 'section_group' — must be dropped
const LANG = 'lg-eng';

/** The seeded options. `marker` is the axis the fixed_filter narrows on. */
const OPTIONS = [
	{ section_id: 929001, label: 'Item 1', second: 'note one', marker: 'KEEPTHIS' },
	{ section_id: 929002, label: 'Item 2', second: 'note two', marker: 'KEEPTHIS' },
	{ section_id: 929010, label: 'Item 10', second: 'note ten', marker: 'DROPTHIS' },
	{ section_id: 929020, label: 'Item 20', second: 'note twenty', marker: 'DROPTHIS' },
];
// WC-2026-08-10-section-id-int-canonical: datalist emits INT record addresses,
// so the projection key is the int id (was String(...)).
const SEEDED_IDS = OPTIONS.map((option) => option.section_id);
/** An extra id used only by the cache-eviction case (seeded mid-test). */
const LATE_ID = 929030;

/** A request_config that points a (synthetic) component at the test3 options. */
function properties(options: {
	labelDdos?: string[];
	targets?: string[];
	fixedFilter?: unknown[];
	sortBy?: { path?: string; direction?: string }[];
}): Record<string, unknown> {
	const sqo: Record<string, unknown> = {
		section_tipo: [{ source: 'section', value: options.targets ?? [SECTION] }],
	};
	if (options.fixedFilter !== undefined) sqo.fixed_filter = options.fixedFilter;
	const built: Record<string, unknown> = {
		source: {
			request_config: [
				{
					sqo,
					show: {
						ddo_map: (options.labelDdos ?? [LABEL_DDO]).map((tipo) => ({
							tipo,
							parent: SECTION,
							section_tipo: SECTION,
						})),
					},
				},
			],
		},
	};
	if (options.sortBy !== undefined) built.sort_by = options.sortBy;
	return built;
}

/** fixed_filter descriptor matching the options whose marker contains `q`. */
function markerFilter(q: string): unknown[] {
	return [
		{
			source: 'fixed_dato',
			operator: '$and',
			value: [{ q, path: [{ section_tipo: SECTION, component_tipo: MARKER_DDO }] }],
		},
	];
}

/**
 * Seed (idempotent). Called before EVERY case, not only in beforeAll: the
 * suite DB is shared and any other process's `canonical_test3` preload deletes
 * every test3 row, this file's scratch included. Re-asserting the fixture in
 * the same test body that reads it is the only honest way to depend on it.
 */
async function seedOptions(): Promise<void> {
	for (const option of OPTIONS) {
		await writeOption(option.section_id, option.label, option.second, option.marker);
	}
}

async function writeOption(
	sectionId: number,
	label: string,
	second: string,
	marker: string,
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO matrix_test (section_id, section_tipo, string, data)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)
		 ON CONFLICT (section_id, section_tipo)
		 DO UPDATE SET string = EXCLUDED.string, data = EXCLUDED.data`,
		[
			sectionId,
			SECTION,
			JSON.stringify({
				[LABEL_DDO]: [{ id: 1, lang: LANG, value: label }],
				[SECOND_DDO]: [{ id: 1, lang: LANG, value: second }],
				// test162 is NON-translatable: the search assembler addresses it
				// with `@.lang == "lg-nolan"`, so a lg-eng entry would be invisible
				// to the fixed_filter (measured — this is not a stylistic choice).
				[MARKER_DDO]: [{ id: 1, lang: 'lg-nolan', value: marker }],
			}),
			JSON.stringify({ section_id: sectionId, section_tipo: SECTION }),
		],
	);
}

/** The built list projected onto the seeded ids, in build order. */
function seededOnly(list: { section_id: number }[]): number[] {
	return list.filter((item) => SEEDED_IDS.includes(item.section_id)).map((i) => i.section_id);
}

beforeAll(async () => {
	// A DB failure must FAIL this file, never skip it: every case below is a
	// DB case, so a silent pass here would be a green gate asserting nothing.
	await sql`SELECT 1`;
	await seedOptions();
});

afterAll(async () => {
	await sql.unsafe(
		'DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id >= 929000 AND section_id <= 929999',
		[SECTION],
	);
	await sql.unsafe(
		'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id >= 929000 AND section_id <= 929999',
		[SECTION],
	);
	const rows = (await sql.unsafe(
		`SELECT
			(SELECT count(*)::int FROM matrix_test
			  WHERE section_tipo = $1 AND section_id BETWEEN 929000 AND 929999) AS records,
			(SELECT count(*)::int FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id BETWEEN 929000 AND 929999) AS tm`,
		[SECTION],
	)) as { records: number; tm: number }[];
	if (rows[0]?.records !== 0 || rows[0]?.tm !== 0) {
		throw new Error(
			`datalist_build_native cleanup did not reach zero: ${rows[0]?.records} records / ${rows[0]?.tm} TM rows left in ${SECTION} 929000-929999`,
		);
	}
	clearDatalistCache();
	await fireSaveEvent(SECTION); // drop any list this file cached for other files
});

describe('getDatalist — label projection and ordering', () => {
	test('default order is strnatcmp on the label, not lexicographic', async () => {
		await seedOptions();
		clearDatalistCache();
		const list = await getDatalist(
			'zzdlorder1',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		// Natural: 1 < 2 < 10 < 20. Byte order would give 1, 10, 2, 20.
		expect(seededOnly(list)).toEqual([929001, 929002, 929010, 929020]);
		const labels = list
			.filter((item) => SEEDED_IDS.includes(item.section_id))
			.map((item) => item.label);
		expect(labels).toEqual(['Item 1', 'Item 2', 'Item 10', 'Item 20']);
	});

	test('every component show ddo joins into the label with exactly " | "', async () => {
		await seedOptions();
		clearDatalistCache();
		const list = await getDatalist(
			'zzdljoin1',
			properties({ labelDdos: [LABEL_DDO, SECOND_DDO] }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		const seeded = list.filter((item) => SEEDED_IDS.includes(item.section_id));
		expect(seeded.map((item) => item.label)).toEqual([
			'Item 1 | note one',
			'Item 2 | note two',
			'Item 10 | note ten',
			'Item 20 | note twenty',
		]);
		// The separator is the PHP implode(' | ') byte-for-byte — no trimming,
		// no ', ', and the parts stay in ddo_map order.
		for (const item of seeded) expect(item.label.split(' | ').length).toBe(2);
	});

	test('a NON-component show ddo contributes nothing to the label', async () => {
		await seedOptions();
		clearDatalistCache();
		// test45 is a section_group: the model filter (`model.startsWith
		// ('component_')`) drops it, so no label part is produced at all.
		const list = await getDatalist(
			'zzdlmodel1',
			properties({ labelDdos: [NOT_A_COMPONENT_DDO] }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		const seeded = list.filter((item) => SEEDED_IDS.includes(item.section_id));
		expect(seeded.length).toBe(OPTIONS.length);
		for (const item of seeded) expect(item.label).toBe('');
		// …and the mixed map keeps only the component half.
		clearDatalistCache();
		const mixed = await getDatalist(
			'zzdlmodel2',
			properties({ labelDdos: [NOT_A_COMPONENT_DDO, LABEL_DDO] }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		// WC-2026-08-10-section-id-int-canonical: int record address.
		expect(mixed.filter((item) => item.section_id === 929001).map((item) => item.label)).toEqual([
			'Item 1',
		]);
	});

	test('each option carries its locator, an int section_id and a hide array', async () => {
		await seedOptions();
		clearDatalistCache();
		const list = await getDatalist(
			'zzdlshape1',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		// WC-2026-08-10-section-id-int-canonical: the datalist emits the record
		// address as an INT (both the option's own section_id and the locator
		// under `value`); the repealed law stringified the raw row value.
		const one = list.find((item) => item.section_id === 929001);
		expect(one).toBeDefined();
		expect(one?.value).toEqual({ section_tipo: SECTION, section_id: 929001 });
		expect(typeof one?.section_id).toBe('number');
		expect(one?.hide).toEqual([]); // no hide ddos declared
		expect(one?.tool_name).toBeUndefined(); // not the security-tools component
		expect(one?.always_active).toBeUndefined();
	});

	test('a target tipo with no matrix table is skipped, never fatal', async () => {
		await seedOptions();
		clearDatalistCache();
		// test52 resolves an ontology model (so it survives check_tipo_is_valid)
		// but is a COMPONENT: getMatrixTableFromTipo returns null for it.
		const list = await getDatalist(
			'zzdlnotable1',
			properties({ targets: [LABEL_DDO, SECTION] }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(seededOnly(list)).toEqual([929001, 929002, 929010, 929020]);
		for (const item of list) expect(item.value.section_tipo).toBe(SECTION);
	});
});

describe('getDatalist — fixed_filter narrowing', () => {
	test('the first fixed_filter group narrows the enumeration', async () => {
		await seedOptions();
		clearDatalistCache();
		const filtered = await getDatalist(
			'zzdlfilter1',
			properties({ fixedFilter: markerFilter('KEEPTHIS') }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(filtered.map((item) => item.section_id)).toEqual([929001, 929002]);

		// The CONTRAST, rebuilt from scratch (own tipo + cleared cache): without
		// the filter the very same options list carries the dropped ids too.
		clearDatalistCache();
		const unfiltered = await getDatalist(
			'zzdlfilter2',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(seededOnly(unfiltered)).toEqual([929001, 929002, 929010, 929020]);
	});

	test('a fixed_filter that expands to NO group leaves the list unnarrowed', async () => {
		await seedOptions();
		clearDatalistCache();
		// A fixed_dato item whose last path tipo is not an installed ontology
		// node is skipped (PHP check_active_tld parity) — the descriptor then
		// contributes zero items, so no group is emitted and `filterGroup`
		// stays undefined. This is the REACHABLE form of "the filter is
		// ignored"; see the unreachable-bad-format case below.
		const unnarrowed = await getDatalist(
			'zzdlfilter3',
			properties({
				fixedFilter: [
					{
						source: 'fixed_dato',
						operator: '$and',
						value: [
							{ q: 'KEEPTHIS', path: [{ section_tipo: SECTION, component_tipo: 'zznosuchtipo1' }] },
						],
					},
				],
			}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(seededOnly(unnarrowed)).toEqual([929001, 929002, 929010, 929020]);
	});

	test('a malformed fixed_filter descriptor is rejected by the config build', async () => {
		await seedOptions();
		clearDatalistCache();
		// MEASURED, and a correction to the plan's "bad entry" case: a
		// `fixed_filter: ['nonsense']` never reaches getDatalist's bad-format
		// branch — expandFixedFilter (request_config/filters.ts:217) throws on
		// the unknown source first. Which means the `console.error("ignored
		// fixed filter, bad format")` arm in datalist.ts is UNREACHABLE through
		// the request_config build path: every entry the parser can put in
		// sqo.fixed_filter is a `{operator: items}` object. Pinned as today's
		// behaviour — if the parser ever starts passing raw descriptors
		// through, this expectation must become the console.error assertion.
		await expect(
			getDatalist(
				'zzdlfilter4',
				properties({ fixedFilter: ['nonsense'] }),
				{ section_tipo: SECTION, section_id: null },
				LANG,
			),
		).rejects.toThrow(/unknown fixed_filter source/);
	});
});

describe('getDatalist — properties.sort_by', () => {
	test('DESC reverses a numeric path, and the omitted direction is ASC', async () => {
		await seedOptions();
		clearDatalistCache();
		const descending = await getDatalist(
			'zzdlsort1',
			properties({
				fixedFilter: markerFilter('KEEPTHIS'),
				sortBy: [{ path: 'section_id', direction: 'DESC' }],
			}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(descending.map((item) => item.section_id)).toEqual([929002, 929001]);

		clearDatalistCache();
		const ascending = await getDatalist(
			'zzdlsort2',
			properties({ fixedFilter: markerFilter('KEEPTHIS'), sortBy: [{ path: 'section_id' }] }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(ascending.map((item) => item.section_id)).toEqual([929001, 929002]);
	});

	test('a non-numeric path falls back to strnatcmp, direction-aware', async () => {
		await seedOptions();
		clearDatalistCache();
		const list = await getDatalist(
			'zzdlsort3',
			properties({ sortBy: [{ path: 'label', direction: 'DESC' }] }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		// Natural order reversed: 20, 10, 2, 1 (byte-reversed would be 20,2,10,1).
		expect(seededOnly(list)).toEqual([929020, 929010, 929002, 929001]);
	});

	test('a path no item carries compares equal (the ?? 0 fallback), order preserved', async () => {
		await seedOptions();
		clearDatalistCache();
		const list = await getDatalist(
			'zzdlsort4',
			properties({ fixedFilter: markerFilter('KEEPTHIS'), sortBy: [{ path: 'nope' }] }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		// Both sides resolve `undefined ?? 0` → 0 → numeric diff 0: no throw and
		// the enumeration order (section_id ascending) survives.
		expect(list.map((item) => item.section_id)).toEqual([929001, 929002]);
	});

	test('only the FIRST sort_by rule is applied', async () => {
		await seedOptions();
		clearDatalistCache();
		const list = await getDatalist(
			'zzdlsort5',
			properties({
				fixedFilter: markerFilter('KEEPTHIS'),
				sortBy: [
					{ path: 'section_id', direction: 'DESC' },
					{ path: 'section_id', direction: 'ASC' },
				],
			}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(list.map((item) => item.section_id)).toEqual([929002, 929001]);
	});
});

describe('getDatalist — the dd1067 security-tools enrichment', () => {
	test('the profile-tools component stamps tool_name / always_active / tool_description on every option', async () => {
		await seedOptions();
		clearDatalistCache();
		const list = await getDatalist(
			PROFILE_TOOLS_COMPONENT,
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		const seeded = list.filter((item) => SEEDED_IDS.includes(item.section_id));
		expect(seeded.length).toBe(OPTIONS.length);
		for (const item of seeded) {
			// These scratch records are not registered tools: PHP's fallback pair.
			expect(item.tool_name).toBe('Unknown');
			expect(item.always_active).toBe(false);
			expect(item.tool_description).toBeNull();
		}
		clearDatalistCache();
		// Same properties, ANY other component tipo: the keys must not appear.
		const plain = await getDatalist(
			'zzdltools1',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		for (const item of plain) {
			expect('tool_name' in item).toBe(false);
			expect('always_active' in item).toBe(false);
			expect('tool_description' in item).toBe(false);
		}
	});

	test('a registered tool carries its dd612 description in the REQUESTED lang', async () => {
		// Expected values come from the repo-owned register.json the suite DB
		// registered the tool from — not from the ambient DB.
		const { getActiveToolMetaBySectionId } = await import('../../src/core/tools/registry.ts');
		const register = (await Bun.file(
			`${import.meta.dir}/../../tools/tool_update_cache/register.json`,
		).json()) as { string: Record<string, { lang: string; value: string }[]> };
		const source = register.string.dd612 ?? [];
		for (const lang of ['lg-eng', 'lg-spa']) {
			const expected = source.find((item) => item.lang === lang)?.value;
			expect(expected).toBeString();
			const metas = [...(await getActiveToolMetaBySectionId(lang)).values()];
			const meta = metas.find((item) => item.name === 'tool_update_cache');
			expect(meta?.description).toBe(expected as string);
		}
	});
});

describe('getDatalist — the cache', () => {
	test('the cache key carries the filter: same tipo, different filter → its own list', async () => {
		await seedOptions();
		clearDatalistCache();
		const first = await getDatalist(
			'zzdlcache1',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(seededOnly(first)).toEqual([929001, 929002, 929010, 929020]);
		// Same tipo + lang, DIFFERENT filter (a record-resolved component_data
		// filter differs exactly like this between two records): its own list.
		// Until 2026-11-12 the key ignored the filter and served `first` here.
		const second = await getDatalist(
			'zzdlcache1',
			properties({ fixedFilter: markerFilter('KEEPTHIS') }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(second).not.toBe(first);
		expect(second.map((item) => item.section_id)).toEqual([929001, 929002]);
		// And the SAME filter again is a cache hit (same reference).
		const again = await getDatalist(
			'zzdlcache1',
			properties({ fixedFilter: markerFilter('KEEPTHIS') }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(again).toBe(second);
	});

	test('the lang is part of the key: a second lang builds its own list', async () => {
		await seedOptions();
		clearDatalistCache();
		const english = await getDatalist(
			'zzdlcache2',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		const spanish = await getDatalist(
			'zzdlcache2',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			'lg-spa',
		);
		expect(spanish).not.toBe(english);
		expect(seededOnly(spanish)).toEqual(seededOnly(english));
	});

	test('a write to the TARGET section evicts the cached list', async () => {
		await seedOptions();
		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
			SECTION,
			LATE_ID,
		]);
		clearDatalistCache();
		const before = await getDatalist(
			'zzdlevict1',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		// WC-2026-08-10-section-id-int-canonical: int record address.
		expect(before.some((item) => item.section_id === LATE_ID)).toBe(false);

		await writeOption(LATE_ID, 'Item 30', 'note thirty', 'DROPTHIS');
		// Still cached — the row alone does not stale it (this half is what
		// proves the next half is not a no-op).
		const stale = await getDatalist(
			'zzdlevict1',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(stale).toBe(before);

		await fireSaveEvent(SECTION); // the durable S1-11 eviction channel
		const after = await getDatalist(
			'zzdlevict1',
			properties({}),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(after).not.toBe(before);
		expect(after.some((item) => item.section_id === LATE_ID)).toBe(true);

		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
			SECTION,
			LATE_ID,
		]);
		await fireSaveEvent(SECTION);
	});
});

describe('probeDatalistSize agrees with the built list', () => {
	test('a COLD probe (SQL path) equals min(list.length, limit)', async () => {
		await seedOptions();
		// Cleared IMMEDIATELY before the probe so it cannot answer from a cached
		// list — this is the case that must take the LIMIT-ed SQL path.
		clearDatalistCache();
		const probedWide = await probeDatalistSize(
			'zzdlprobe1',
			properties({ fixedFilter: markerFilter('KEEPTHIS') }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
			5,
		);
		clearDatalistCache();
		const probedTight = await probeDatalistSize(
			'zzdlprobe1',
			properties({ fixedFilter: markerFilter('KEEPTHIS') }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
			1,
		);
		clearDatalistCache();
		const list = await getDatalist(
			'zzdlprobe1',
			properties({ fixedFilter: markerFilter('KEEPTHIS') }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(list.length).toBe(2);
		expect(probedWide).toBe(Math.min(list.length, 5));
		expect(probedTight).toBe(Math.min(list.length, 1));
		// The probe must NOT populate the cache (that is its whole reason to
		// exist): the list above rebuilt from SQL, and a fresh probe now takes
		// the cached branch instead.
		expect(
			await probeDatalistSize(
				'zzdlprobe1',
				properties({ fixedFilter: markerFilter('KEEPTHIS') }),
				{ section_tipo: SECTION, section_id: null },
				LANG,
				5,
			),
		).toBe(2);
	});

	test('the unfiltered probe counts records up to the limit', async () => {
		await seedOptions();
		clearDatalistCache();
		// No fixed_filter → the plain `LIMIT n` row probe. The section holds the
		// four seeded options plus the canonical playground records, so a
		// 3-limit probe saturates.
		expect(
			await probeDatalistSize(
				'zzdlprobe2',
				properties({}),
				{ section_tipo: SECTION, section_id: null },
				LANG,
				3,
			),
		).toBe(3);
		clearDatalistCache();
		expect(
			await probeDatalistSize(
				'zzdlprobe2',
				properties({}),
				{ section_tipo: SECTION, section_id: null },
				LANG,
				0,
			),
		).toBe(0);
		clearDatalistCache();
		expect(
			await probeDatalistSize(
				'zzdlprobe2',
				properties({}),
				{ section_tipo: SECTION, section_id: null },
				LANG,
				-1,
			),
		).toBe(0);
	});

	test('a cached list answers the probe without touching the DB', async () => {
		await seedOptions();
		clearDatalistCache();
		const list = await getDatalist(
			'zzdlprobe3',
			properties({ fixedFilter: markerFilter('KEEPTHIS') }),
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		expect(list.length).toBe(2);
		// A third matching row lands WITHOUT a save event: the DB now holds 3
		// matches, the cached list 2 — so a probe answering 2 answered from the
		// cache (same key as the build), not from SQL.
		await writeOption(LATE_ID, 'Item 30', 'note thirty', 'KEEPTHIS');
		try {
			const probe = (limit: number) =>
				probeDatalistSize(
					'zzdlprobe3',
					properties({ fixedFilter: markerFilter('KEEPTHIS') }),
					{ section_tipo: SECTION, section_id: null },
					LANG,
					limit,
				);
			expect(await probe(10)).toBe(2);
			expect(await probe(1)).toBe(1);
			// The contrast: cold, the same probe sees the third row.
			clearDatalistCache();
			expect(await probe(10)).toBe(3);
		} finally {
			await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
				SECTION,
				LATE_ID,
			]);
			await fireSaveEvent(SECTION);
		}
	});
});
