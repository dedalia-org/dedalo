/**
 * A relation column in a picker's SEARCH map is searched through what it
 * DISPLAYS (relations/request_config/search_display_paths.ts,
 * WC-2026-10-01-relation-search-display-paths).
 *
 * The client mints one filter_free leaf per leaf ddo of its search map
 * (common.js build_rqo_search). A relation ddo without declared children used
 * to be such a leaf, and the typed word reached a locator column (refused,
 * WC-2026-09-23). The expansion writes the relation's own display ddos under
 * it into the item's OWN `search_paths` key — read only by that path builder —
 * so `show` / `search` / `choose` (result columns, search-mode columns, export)
 * stay exactly as they were.
 *
 * Structure: repo-owned `test` TLD nodes — test54 (component_relation_related,
 * list config shows test52 on test3), test78 (portal whose display includes the
 * relation hierarchy27, expanded through ITS config), test156
 * (component_relation_children — computed), test60 (component_dataframe). The
 * end-to-end case creates its own test3 records at explicit ids, swept after.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import type {
	ParsedRequestConfigItem,
	ProcessedDdo,
} from '../../src/core/relations/request_config/explicit.ts';
import { withSearchDisplayPaths } from '../../src/core/relations/request_config/search_display_paths.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const OWNER = 'zzpicker';

async function ddo(tipo: string, parent = OWNER): Promise<ProcessedDdo> {
	return {
		tipo,
		model: (await getModelByTipo(tipo)) ?? '',
		parent,
		section_tipo: ['test3'],
		mode: 'list',
		label: tipo,
	};
}

function item(
	show: ProcessedDdo[],
	extra: Partial<ParsedRequestConfigItem> = {},
): ParsedRequestConfigItem {
	return {
		api_engine: 'dedalo',
		type: 'main',
		sqo: { section_tipo: [] },
		show: { ddo_map: show },
		search: null,
		choose: null,
		hide: null,
		api_config: null,
		...extra,
	};
}

async function expand(config: ParsedRequestConfigItem): Promise<ParsedRequestConfigItem> {
	const [result] = await withSearchDisplayPaths([config], OWNER, 'component_portal');
	return result as ParsedRequestConfigItem;
}

const shape = (map: ProcessedDdo[] | undefined) =>
	(map ?? []).map((entry) => `${entry.tipo}<${entry.parent}`);

describe.if(DB_READY)('search display paths', () => {
	test('a childless relation column gets its display ddos in search_paths; show/search/choose untouched', async () => {
		const show = [await ddo('test52'), await ddo('test54')];
		const result = await expand(item(show));
		expect(shape(result.search_paths)).toEqual([
			`test52<${OWNER}`,
			`test54<${OWNER}`,
			'test52<test54',
		]);
		const child = result.search_paths?.at(-1) as ProcessedDdo;
		expect(child.section_tipo).toEqual(['test3']);
		expect(child.model).toBe('component_input_text');
		expect(result.show?.ddo_map).toBe(show);
		expect(result.search).toBeNull();
		expect(result.choose).toBeNull();
	});

	test('a display relation descends through its own config', async () => {
		const result = await expand(item([await ddo('test78')]));
		expect(shape(result.search_paths)).toEqual([
			`test78<${OWNER}`,
			'hierarchy25<test78',
			'hierarchy27<test78',
			'hierarchy25<hierarchy27',
		]);
	});

	test('a declared search map is the base; declared blocks are untouched', async () => {
		const declaredSearch = { ddo_map: [await ddo('test54')] };
		const declaredChoose = { ddo_map: [await ddo('test52')] };
		const result = await expand(
			item([await ddo('test52')], { search: declaredSearch, choose: declaredChoose }),
		);
		expect(shape(result.search_paths)).toEqual([`test54<${OWNER}`, 'test52<test54']);
		expect(result.search).toBe(declaredSearch);
		expect(result.choose).toBe(declaredChoose);
	});

	test('nothing to expand: the item is returned as is', async () => {
		const declared = item([await ddo('test54'), await ddo('test52', 'test54')]);
		expect(await expand(declared)).toBe(declared);
		const plain = item([await ddo('test52')]);
		expect(await expand(plain)).toBe(plain);
	});

	test('a section owner is returned as is (its maps are its own columns)', async () => {
		const items = [item([await ddo('test54')])];
		expect(await withSearchDisplayPaths(items, 'test3', 'section')).toBe(items);
	});

	test('a dataframe slot is not a column: left alone', async () => {
		const config = item([await ddo('test60')]);
		expect(await expand(config)).toBe(config);
	});

	test('a non-dedalo engine item (zenon) is never expanded', async () => {
		const zenon = item([await ddo('test54')], { api_engine: 'zenon' });
		expect(await expand(zenon)).toBe(zenon);
	});

	test('component_external is not a hop: an item showing it is left alone', async () => {
		const external = item([await ddo('test52'), await ddo('test215')]);
		expect(external.show?.ddo_map[1]?.model).toBe('component_external');
		expect(await expand(external)).toBe(external);
	});

	test('a computed relation displays nothing searchable: left out of search_paths, loudly (once)', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const config = item([await ddo('test52'), await ddo('test156')]);
			const result = await expand(config);
			expect(shape(result.search_paths)).toEqual([`test52<${OWNER}`]);
			expect(result.show?.ddo_map).toHaveLength(2);
			await expand(config);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain('test156');
		} finally {
			warn.mockRestore();
		}
	});

	test('an expansion that leaves no path is not emitted', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const onlyComputed = item([await ddo('test192')]);
			expect(await expand(onlyComputed)).toBe(onlyComputed);
		} finally {
			warn.mockRestore();
		}
	});
});

// End to end: the path the client mints from the expanded map (common.js
// get_ar_inverted_paths, reversed, section_tipo[0]) answers the typed word.
const SECTION = 'test3';
const TABLE = 'matrix_test';
const T1 = 932301; // shows 'zzfree alpha one'
const T2 = 932302; // shows 'zzfree beta two'
const M1 = 932311; // → T1
const M2 = 932312; // → T2
const M3 = 932313; // → T1, T2
const M4 = 932314; // no locator
const MAINS = [M1, M2, M3, M4];

async function insert(sectionId: number, columns: Record<string, unknown>): Promise<void> {
	const names = ['"section_tipo"', '"section_id"'];
	const values = ['$1', '$2'];
	const params: (string | number)[] = [SECTION, sectionId];
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		params.push(encodeForJsonb(value));
		values.push(`$${params.length}::text::jsonb`);
	}
	await sql.unsafe(
		`INSERT INTO ${TABLE} (${names.join(', ')}) VALUES (${values.join(', ')})`,
		params,
	);
}

const shown = (value: string) => ({ string: { test52: [{ id: 1, lang: 'lg-nolan', value }] } });
const links = (...ids: number[]) => ({
	relation: {
		test54: ids.map((id) => ({
			id: 1,
			type: 'dd151',
			section_id: id,
			section_tipo: SECTION,
			from_component_tipo: 'test54',
		})),
	},
});

async function purge(): Promise<void> {
	for (const id of [T1, T2, ...MAINS]) await deleteMatrixRecord(TABLE, SECTION, id);
}

/** The filter_free path the client builds for the expanded map's last leaf. */
async function clientPath(): Promise<Record<string, unknown>[]> {
	const result = await expand(item([await ddo('test54')]));
	const map = result.search_paths ?? [];
	const leaf = map.at(-1) as ProcessedDdo;
	const parent = map.find((entry) => entry.tipo === leaf.parent) as ProcessedDdo;
	return [parent, leaf].map((entry) => ({
		...entry,
		section_tipo: Array.isArray(entry.section_tipo) ? entry.section_tipo[0] : entry.section_tipo,
		component_tipo: entry.tipo,
	}));
}

async function run(q: string): Promise<number[]> {
	const filter = { $and: [{ $and: [{ q, q_split: true, path: await clientPath() }] }] };
	const built = await buildSearchSql(
		sanitizeClientSqo(structuredClone({ section_tipo: [SECTION], limit: 1000, filter }) as never),
		{},
	);
	const found = (await sql.unsafe(built.sql, built.params as never[])) as { section_id: number }[];
	return found
		.map((row) => Number(row.section_id))
		.filter((id) => MAINS.includes(id))
		.sort();
}

describe.if(DB_READY)('search display paths — the minted path answers the word', () => {
	beforeAll(async () => {
		await assertTestDatabase('search_display_paths_native');
		await purge();
		await insert(T1, shown('zzfree alpha one'));
		await insert(T2, shown('zzfree beta two'));
		await insert(M1, links(T1));
		await insert(M2, links(T2));
		await insert(M3, links(T1, T2));
		await insert(M4, {});
	});
	afterAll(purge);

	test('a word matches the mains whose related record shows it', async () => {
		expect(await run('zzfree')).toHaveLength(3);
		expect(await run('zzfree alpha')).toEqual([M1, M3]);
		expect(await run('zzfree beta')).toEqual([M2, M3]);
		expect(await run('zzfree nowhere')).toEqual([]);
	});

	test('negation means no related record shows it', async () => {
		expect(await run('-alpha')).toEqual([M2, M4]);
	});
});
