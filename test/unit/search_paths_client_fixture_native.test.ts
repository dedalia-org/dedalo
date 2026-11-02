/**
 * THE SERVER HALF of the search_paths fixture the client gate runs on
 * (client/dedalo/test/client/js/search_paths_fixture.js).
 *
 * A relation column in a picker's search map is searched through what it
 * DISPLAYS: the engine writes the display ddos into the item's `search_paths`
 * (relations/request_config/search_display_paths.ts) and the CLIENT mints the
 * deep filter paths from them (common.js build_rqo_search). The client half is
 * the Mocha case in test_service_autocomplete.js, which runs the shipped
 * build_rqo_search over the fixture's `search_paths` and asserts it mints the
 * fixture's `expected_filter_paths`. This file pins the other two joints, so
 * the fixture can never drift into a shape neither engine produces nor answers:
 *
 *  1. the engine EMITS the fixture's `search_paths` (on the keys the client
 *     path builder reads) for the fixture's show map;
 *  2. the search engine ANSWERS the fixture's `expected_filter_paths` with a
 *     word, and REFUSES the relation leaf alone (`relation_leaf_path` — what the
 *     client sent before search_paths: a word on a locator column,
 *     WC-2026-09-23-relation-q-is-a-locator) — the negative control proving the
 *     expected path is the one that matters.
 *
 * Structure: repo-owned `test` TLD nodes only (test54, test52 on test3); no
 * record is written.
 */

import { describe, expect, test } from 'bun:test';
import {
	expected_filter_paths,
	relation_leaf_path,
	SEARCH_PATHS_OWNER,
	search_paths,
	show_ddo_map,
} from '../../client/dedalo/test/client/js/search_paths_fixture.js';
import { sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import type {
	ParsedRequestConfigItem,
	ProcessedDdo,
} from '../../src/core/relations/request_config/explicit.ts';
import { withSearchDisplayPaths } from '../../src/core/relations/request_config/search_display_paths.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const CLIENT_KEYS = ['tipo', 'parent', 'section_tipo', 'model'] as const;

function item(show: ProcessedDdo[]): ParsedRequestConfigItem {
	return {
		api_engine: 'dedalo',
		type: 'main',
		sqo: { section_tipo: [] },
		show: { ddo_map: show },
		search: null,
		choose: null,
		hide: null,
		api_config: null,
	};
}

const project = (entry: Record<string, unknown>) =>
	Object.fromEntries(CLIENT_KEYS.map((key) => [key, entry[key]]));

async function build(path: Record<string, unknown>[], q: string) {
	const filter = { $and: [{ $or: [{ q, q_split: true, path }] }] };
	return buildSearchSql(
		sanitizeClientSqo(structuredClone({ section_tipo: ['test3'], limit: 10, filter }) as never),
		{},
	);
}

describe.if(DB_READY)('search_paths fixture — the server half', () => {
	test('the engine emits the fixture search_paths for the fixture show map', async () => {
		const show = structuredClone(show_ddo_map).map((entry) => ({
			...entry,
			label: entry.tipo,
		})) as ProcessedDdo[];
		const [expanded] = await withSearchDisplayPaths(
			[item(show)],
			SEARCH_PATHS_OWNER,
			'component_portal',
		);
		const emitted = (expanded as ParsedRequestConfigItem).search_paths ?? [];
		expect(emitted.map((entry) => project(entry as unknown as Record<string, unknown>))).toEqual(
			search_paths,
		);
	});

	test('the search engine answers the expected client path with a word', async () => {
		expect(expected_filter_paths).toHaveLength(1);
		const [path] = expected_filter_paths;
		if (path === undefined) throw new Error('fixture: no expected path');
		const built = await build(structuredClone(path), 'zzfixtureword');
		expect(built.sql.length).toBeGreaterThan(0);
	});

	test('negative control: the relation leaf alone is refused (a word on a locator column)', async () => {
		await expect(build(structuredClone(relation_leaf_path), 'zzfixtureword')).rejects.toMatchObject(
			{
				code: 'request.invalid',
			},
		);
	});
});
