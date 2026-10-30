/**
 * A list-cell ddo naming an unresolvable tipo is DROPPED (PHP
 * trait.request_config_ddo.php validate_ddo_tipo), never emitted.
 *
 * Live failure (2026-10-30): an install without the optional `tchi` TLD opened
 * an oh1 record; its edit portal shows rsc92/rsc65/rsc119 as list cells, whose
 * own request_config (shipped in `rsc`) names tchi15 — emitDdoData threw
 * request.invalid_tipo and the whole edit page failed.
 *
 * Built situation (scratch TLD zzlcddo*, rows in matrix_test, purged before and
 * after): SECTION record 1 → OUTER portal (edit, explicit builder) → record 2 →
 * INNER portal (list cell, raw map naming FIELD + MISSING) → record 3 (FIELD).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	resolveFrameConfig,
	resolveListCellMap,
	resolveOwnConfigMap,
} from '../../src/core/section/list_definitions/section_list.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzlcddo';
const SECTION = `${TLD}1`;
const INNER = `${TLD}2`; // list-cell portal whose raw map names MISSING
const FIELD = `${TLD}3`;
const OUTER = `${TLD}4`; // edit portal showing INNER as its child
const MISSING = `${TLD}99`; // no node: stands for a tipo of an uninstalled TLD

const locatorOf = (sectionId: number, from: string) => ({
	id: 1,
	type: 'dd151',
	section_id: String(sectionId),
	section_tipo: SECTION,
	from_component_tipo: from,
});

async function sweepRows(table: string): Promise<void> {
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe(`DELETE FROM ${table} WHERE section_tipo = $1`, [SECTION]);
}

let table: string;
let context: ApiRequestContext;
let token: string;

beforeAll(async () => {
	await assertTestDatabase('list_cell_unresolvable_ddo_native');
	await deleteTldNodes(TLD);
	await upsertDdOntologyNode({
		tipo: SECTION,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'List cell ddo section' },
		// matrix_test, never the installation's `matrix`
		relations: [{ tipo: 'test24' }],
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: FIELD,
		model: 'component_input_text',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Name' },
	});
	await upsertDdOntologyNode({
		tipo: INNER,
		model: 'component_portal',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Inner portal' },
		properties: {
			source: {
				request_config: [
					{
						api_engine: 'dedalo',
						sqo: { section_tipo: [SECTION] },
						show: {
							ddo_map: [
								{ tipo: FIELD, section_tipo: 'self', parent: 'self' },
								{ tipo: MISSING, section_tipo: 'self', parent: 'self' },
							],
						},
					},
				],
			},
		},
	});
	await upsertDdOntologyNode({
		tipo: OUTER,
		model: 'component_portal',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Outer portal' },
		properties: {
			source: {
				request_config: [
					{
						api_engine: 'dedalo',
						sqo: { section_tipo: [SECTION] },
						show: { ddo_map: [{ tipo: INNER, section_tipo: 'self', parent: 'self' }] },
					},
				],
			},
		},
	});

	const resolvedTable = await getMatrixTableFromTipo(SECTION);
	if (resolvedTable === null) throw new Error(`No matrix table for ${SECTION}`);
	table = resolvedTable;
	await sweepRows(table);
	const rows: [number, Record<string, unknown>][] = [
		[1, { relation: { [OUTER]: [locatorOf(2, OUTER)] } }],
		[2, { relation: { [INNER]: [locatorOf(3, INNER)] } }],
		[3, { string: { [FIELD]: [{ id: 1, lang: 'lg-nolan', value: 'leaf' }] } }],
	];
	for (const [sectionId, columns] of rows) {
		const names = Object.keys(columns);
		await sql.unsafe(
			`INSERT INTO ${table} (section_id, section_tipo, ${names.join(', ')}) VALUES ($1, $2, ${names
				.map((_, index) => `$${index + 3}::text::jsonb`)
				.join(', ')})`,
			[sectionId, SECTION, ...names.map((name) => JSON.stringify(columns[name]))],
		);
	}

	token = createSession(-1, 'root', true);
	const session = getSession(token);
	context = {
		requestId: 'list_cell_unresolvable_ddo',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	} as ApiRequestContext;
}, 60000);

afterAll(async () => {
	await sweepRows(table);
	await deleteTldNodes(TLD);
});

describe('list-cell maps drop unresolvable ddo tipos', () => {
	test('resolveListCellMap keeps the resolvable child only', async () => {
		const cell = await resolveListCellMap(INNER);
		expect(cell.rawDdos?.map((ddo) => ddo.tipo)).toEqual([FIELD]);
	});

	test('resolveOwnConfigMap keeps the resolvable child only', async () => {
		const own = await resolveOwnConfigMap(INNER);
		expect(own.rawDdos?.map((ddo) => ddo.tipo)).toEqual([FIELD]);
	});

	test('resolveFrameConfig keeps the resolvable child only', async () => {
		const frame = await resolveFrameConfig(INNER);
		expect(frame.ddos.map((ddo) => ddo.tipo)).toEqual([FIELD]);
	});
});

describe('the record read survives a nested list cell naming an unresolvable tipo', () => {
	test('edit read of the outer record answers ok and emits the leaf item', async () => {
		const rqo = {
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: SECTION,
				section_tipo: SECTION,
				action: 'search',
				mode: 'edit',
				lang: 'lg-eng',
			},
			sqo: {
				section_tipo: [SECTION],
				limit: 1,
				offset: 0,
				filter_by_locators: [{ section_tipo: SECTION, section_id: '1' }],
			},
			show: { ddo_map: [{ tipo: OUTER, section_tipo: SECTION, parent: SECTION, mode: 'edit' }] },
		};
		const body = (await dispatchRqo(rqo as never, context as never)).body as {
			ok?: boolean;
			error?: { code?: string };
			data?: { data?: { tipo?: string; section_id?: unknown; value?: unknown }[] };
		};
		expect(body.error?.code).toBeUndefined();
		expect(body.ok).toBe(true);
		const items = body.data?.data ?? [];
		expect(items.some((item) => item.tipo === MISSING)).toBe(false);
		const leaf = items.find((item) => item.tipo === FIELD && String(item.section_id) === '3');
		expect(leaf).toBeDefined(); // expansion reached the leaf through both portals
	});
});
