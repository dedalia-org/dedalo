/**
 * component_relation_children WRITE-THROUGH (RELATIONS_SPEC §6.3 addendum,
 * src/core/relations/children_write.ts,
 * WC-2026-10-02-relation-children-write-through) — a save on the children
 * component IS a set of `saveComponentData` calls on each affected CHILD's
 * component_relation_parent (+ its sibling order); the component's own column
 * is never written.
 *
 * THE DEFECT THIS GATE CLOSES: the generic engine stored the client's locators
 * under the children tipo in the HOST's own relation column — bytes no read
 * consults — and answered ok:true while no child changed. Every write case
 * below goes red with the saveComponentData branch removed.
 *
 * ALSO PINNED: the per-child authorization (every child asked BEFORE any is
 * written — joining AND leaving: an unlink re-parents the child too — and a
 * refused child leaves the others untouched), the bulk id on each child's Time
 * Machine rows (and the bulk revert restoring them), the derived facet's
 * consumers (update_cache skips the field, propagate refuses it, the CSV import
 * refuses the column — at the door AND at the executor's backstop).
 *
 * ANTI-VACUITY: every case proves the child IS read as a child before a write
 * that removes it (a clear of an empty list is free), and every "nothing
 * written" assertion reads the raw rows.
 *
 * SITUATION: fresh test3 records created at runtime on the generic test TLD
 * (test3's section_map pairs children test201 ↔ parent test71, order test22);
 * hand-seeded links go in by direct SQL so no save-path side effect shapes the
 * fixture. The authz identities are the shared door fixture's (TREE_EDITOR,
 * SECTION_ONLY); records it scopes are created through it and swept by it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { saveComponentValue } from '../../src/ai/mcp/tools/records_write.ts';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { getChildren, getParentTipo } from '../../src/core/relations/children.ts';
import { sweepRelationChildrenOrphans } from '../../src/core/relations/children_orphan_sweep.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	type ChangedDataItem,
	type SaveResult,
	saveComponentData,
} from '../../src/core/section/record/save_component.ts';
import {
	type Principal,
	resolvePrincipal,
	SUPERUSER_ID,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { executeCsvImport } from '../../src/core/tools/import_csv_execute.ts';
import { importMappedRecords } from '../../src/core/tools/import_execute.ts';
import type { ImportFileReport } from '../../src/core/tools/import_wire.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { sweepActivityRows } from '../helpers/activity_rows.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	AUTHZ_PROJECT_P,
	AUTHZ_PROJECT_Q,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const CHILDREN_TIPO = 'test201'; // component_relation_children
const PARENT_TIPO = 'test71'; // component_relation_parent (paired)
const ORDER_TIPO = 'test22'; // section_map thesaurus.order (component_number)
const CSV_USER = 987673; // this gate's own CSV import dir
const LITERAL_TIPO = 'test52'; // component_input_text (the non-children control)

const created: number[] = [];
const runs: number[] = [];
let principal: Principal;
let ids: AuthzIdentities;
let bulkTable = '';

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, SUPERUSER_ID);
	created.push(id);
	return id;
}

/** Store `locators` as the child's test71 value, bypassing the save path. */
async function seedParentLinks(
	childId: number,
	locators: Record<string, unknown>[],
): Promise<void> {
	await seedKey(childId, PARENT_TIPO, locators);
}

async function seedKey(id: number, tipo: string, items: unknown[]): Promise<void> {
	await sql.unsafe(
		`UPDATE ${TABLE}
		    SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, tipo, JSON.stringify(items)],
	);
}

function link(parentId: number, type: string, id?: number): Record<string, unknown> {
	return {
		...(id === undefined ? {} : { id }),
		type,
		section_id: parentId,
		section_tipo: SECTION,
		from_component_tipo: PARENT_TIPO,
	};
}

/** A record's raw jsonb column (`{}` when null). */
async function columnOf(
	id: number,
	column: 'relation' | 'number',
): Promise<Record<string, Record<string, unknown>[]>> {
	const rows = (await sql.unsafe(
		`SELECT ${column}::text AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id],
	)) as { value: string | null }[];
	const row = rows[0];
	if (row === undefined) throw new Error(`columnOf: ${SECTION}/${id} is gone`);
	return row.value === null ? {} : JSON.parse(row.value);
}

const linksOf = async (id: number) => (await columnOf(id, 'relation'))[PARENT_TIPO] ?? [];
const orderOf = async (id: number) => (await columnOf(id, 'number'))[ORDER_TIPO] ?? [];

async function childIds(parentId: number): Promise<number[]> {
	return (await getChildren(parentId, SECTION, CHILDREN_TIPO))
		.map((c) => Number(c.section_id))
		.sort((a, b) => a - b);
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);

function save(
	parentId: number,
	changedData: ChangedDataItem[],
	options: { actor?: Principal; bulkProcessId?: number } = {},
): Promise<SaveResult> {
	const actor = options.actor ?? principal;
	return saveComponentData({
		componentTipo: CHILDREN_TIPO,
		sectionTipo: SECTION,
		sectionId: parentId,
		lang: 'lg-nolan',
		changedData,
		userId: actor.userId,
		principal: actor,
		bulkProcessId: options.bulkProcessId,
	});
}

/** The highest dd800 run id (proves a refusal minted no run record). */
async function maxDd800(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT COALESCE(MAX(section_id), 0)::int AS id FROM "${bulkTable}" WHERE section_tipo = 'dd800'`,
	)) as { id: number }[];
	return Number(rows[0]?.id ?? 0);
}

function childLocator(id: number, section_tipo = SECTION): Record<string, unknown> {
	return { section_tipo, section_id: id, from_component_tipo: CHILDREN_TIPO, type: 'dd48' };
}

/** The error code a rejected promise carried (null when it resolved). */
async function codeOf(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
		return null;
	} catch (error) {
		if (isDedaloError(error)) return error.code;
		throw error;
	}
}

beforeAll(async () => {
	await assertTestDatabase('relation_children_write_through_native');
	// The fixture's premise: the pair really is children ↔ parent (+ the order number).
	expect(await getModelByTipo(CHILDREN_TIPO)).toBe('component_relation_children');
	expect(await getModelByTipo(PARENT_TIPO)).toBe('component_relation_parent');
	expect(await getModelByTipo(ORDER_TIPO)).toBe('component_number');
	// The dd128 census's `not-dd128` verdict for the write-through rests on this.
	expect(await getParentTipo('dd128')).toBeNull();
	principal = await resolvePrincipal(SUPERUSER_ID);
	await installAuthzDoorFixture();
	ids = await resolveAuthzIdentities();
	await assertAuthzDoorContrast(ids);
	bulkTable = String(
		(await (await import('../../src/core/ontology/resolver.ts')).getMatrixTableFromTipo('dd800')) ??
			'',
	);
	mkdirSync(csvDir(), { recursive: true });
}, 60_000);

afterAll(async () => {
	for (const id of created) await cleanScratchRecord(SECTION, id, TABLE);
	await sweepActivityRows(SECTION, created);
	for (const id of runs) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	await sweepActivityRows('dd800', runs);
	await removeAuthzDoorFixture();
	rmSync(csvDir(), { recursive: true, force: true });
}, 60_000);

describe('a children save writes through each child’s parent link', () => {
	test('set_data(null) unlinks EVERY child — a mistyped (dd151) link included — and never writes its own column', async () => {
		const parent = await newRecord();
		const canonical = await newRecord();
		const mistyped = await newRecord();
		await seedParentLinks(canonical, [link(parent, 'dd47', 1)]);
		await seedParentLinks(mistyped, [link(parent, 'dd151', 1)]);
		expect(await childIds(parent)).toEqual(sorted([canonical, mistyped]));

		const outcome = await save(parent, [{ action: 'set_data', id: null, value: null }]);

		expect(outcome.ok).toBe(true);
		expect(outcome.data).toEqual([]);
		expect(await childIds(parent)).toEqual([]);
		expect(await linksOf(canonical)).toEqual([]);
		expect(await linksOf(mistyped)).toEqual([]);
		expect(CHILDREN_TIPO in (await columnOf(parent, 'relation'))).toBe(false);
	});

	test('insert links the child with the canonical dd47 link AND its sibling order paired by id_key', async () => {
		const parent = await newRecord();
		const child = await newRecord();
		expect(await childIds(parent)).toEqual([]);

		const outcome = await save(parent, [
			{ action: 'insert', id: null, value: childLocator(child) },
		]);

		expect(outcome.ok).toBe(true);
		expect(
			(outcome.data ?? []).map((c) => Number((c as { section_id: unknown }).section_id)),
		).toEqual([child]);
		expect(await childIds(parent)).toEqual([child]);
		const links = await linksOf(child);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({
			type: 'dd47',
			section_tipo: SECTION,
			section_id: parent,
			from_component_tipo: PARENT_TIPO,
		});
		const linkId = Number(links[0]?.id);
		expect(linkId).toBeGreaterThan(0);
		// PHP set_child_order: descriptor-children count (0 — the fresh child is no
		// descriptor) + 1, paired to the link's item id.
		expect(await orderOf(child)).toEqual([{ id: linkId, value: 1 }]);
		expect(CHILDREN_TIPO in (await columnOf(parent, 'relation'))).toBe(false);
	});

	test('set_data replaces the list: the kept child keeps its SAME stored link, the new one joins, the dropped one leaves', async () => {
		const parent = await newRecord();
		const kept = await newRecord();
		const dropped = await newRecord();
		const joined = await newRecord();
		await seedParentLinks(kept, [link(parent, 'dd47', 7)]);
		await seedParentLinks(dropped, [link(parent, 'dd47', 1)]);
		expect(await childIds(parent)).toEqual(sorted([kept, dropped]));

		const outcome = await save(parent, [
			{ action: 'set_data', id: null, value: [childLocator(kept), childLocator(joined)] },
		]);

		expect(outcome.ok).toBe(true);
		expect(await childIds(parent)).toEqual(sorted([kept, joined]));
		expect(await linksOf(kept)).toEqual([link(parent, 'dd47', 7)]);
		expect(await linksOf(dropped)).toEqual([]);
		expect(await linksOf(joined)).toHaveLength(1);
	});

	test('remove BY LOCATOR unlinks that child only, and drops the order value paired to its link', async () => {
		const parent = await newRecord();
		const a = await newRecord();
		const b = await newRecord();
		expect((await save(parent, [{ action: 'insert', id: null, value: childLocator(a) }])).ok).toBe(
			true,
		);
		expect((await save(parent, [{ action: 'insert', id: null, value: childLocator(b) }])).ok).toBe(
			true,
		);
		expect(await childIds(parent)).toEqual(sorted([a, b]));
		expect(await orderOf(a)).toHaveLength(1);

		const outcome = await save(parent, [{ action: 'remove', id: null, value: childLocator(a) }]);

		expect(outcome.ok).toBe(true);
		expect(await childIds(parent)).toEqual([b]);
		expect(await linksOf(a)).toEqual([]);
		expect(await orderOf(a)).toEqual([]);
		expect(await linksOf(b)).toHaveLength(1);
	});

	test('a PHP-era link WITHOUT an item id is still removed (set_data of the links that stay)', async () => {
		const parent = await newRecord();
		const other = await newRecord();
		const child = await newRecord();
		await seedParentLinks(child, [link(parent, 'dd47'), link(other, 'dd47', 3)]);
		expect(await childIds(parent)).toEqual([child]);

		const outcome = await save(parent, [{ action: 'clear', id: null, value: null }]);

		expect(outcome.ok).toBe(true);
		expect(await childIds(parent)).toEqual([]);
		// The link to the OTHER parent stays, with its id.
		const links = await linksOf(child);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ id: 3, section_id: other, type: 'dd47' });
	});

	test('add_new_element creates a record in the named section and makes it a child', async () => {
		const parent = await newRecord();
		const outcome = await save(parent, [{ action: 'add_new_element', id: null, value: SECTION }]);
		expect(outcome.ok).toBe(true);
		const fresh = Number(outcome.created_section_id);
		expect(fresh).toBeGreaterThan(0);
		created.push(fresh);
		expect(await childIds(parent)).toEqual([fresh]);
		expect((await linksOf(fresh))[0]).toMatchObject({ type: 'dd47', section_id: parent });
	});

	test('a missing target and the record itself are silent no-ops (link_record then answers false)', async () => {
		const parent = await newRecord();
		const gone = await newRecord();
		await cleanScratchRecord(SECTION, gone, TABLE);

		const outcome = await save(parent, [
			{ action: 'insert', id: null, value: childLocator(gone) },
			{ action: 'insert', id: null, value: childLocator(parent) },
		]);

		expect(outcome.ok).toBe(true);
		expect(await childIds(parent)).toEqual([]);
		expect(await linksOf(parent)).toEqual([]);
		expect(CHILDREN_TIPO in (await columnOf(parent, 'relation'))).toBe(false);
	});
});

describe('refusals are loud and leave nothing written', () => {
	test('a link that would close a cycle refuses with tree.cycle', async () => {
		const parent = await newRecord();
		const grandParent = await newRecord();
		await seedParentLinks(parent, [link(grandParent, 'dd47', 1)]);

		expect(
			await codeOf(
				save(parent, [{ action: 'insert', id: null, value: childLocator(grandParent) }]),
			),
		).toBe('tree.cycle');
		expect(await childIds(parent)).toEqual([]);
		expect(await linksOf(grandParent)).toEqual([]);
	});

	test('a cycle on the SECOND joining child rolls back the first', async () => {
		const parent = await newRecord();
		const grandParent = await newRecord();
		const fine = await newRecord();
		await seedParentLinks(parent, [link(grandParent, 'dd47', 1)]);

		expect(
			await codeOf(
				save(parent, [
					{ action: 'insert', id: null, value: childLocator(fine) },
					{ action: 'insert', id: null, value: childLocator(grandParent) },
				]),
			),
		).toBe('tree.cycle');
		expect(await linksOf(fine)).toEqual([]);
		expect(await orderOf(fine)).toEqual([]);
	});

	test('a child outside the hierarchy (a section without this parent component) refuses', async () => {
		const parent = await newRecord();
		expect(
			await codeOf(
				save(parent, [
					{ action: 'insert', id: null, value: { section_tipo: 'dd64', section_id: 1 } },
				]),
			),
		).toBe('request.invalid_data');
	});

	test('sort_data, update and an id-only remove refuse (children order is each child’s own value; removal is by locator)', async () => {
		const parent = await newRecord();
		const child = await newRecord();
		await seedParentLinks(child, [link(parent, 'dd47', 1)]);
		for (const change of [
			{ action: 'sort_data', id: null, value: childLocator(child), source_key: 0, target_key: 1 },
			{ action: 'update', id: 1, value: childLocator(child) },
			{ action: 'remove', id: 1, value: null },
			// DATA-06: a remove naming NOTHING is never a wipe here either.
			{ action: 'remove', id: null, value: null },
		] as ChangedDataItem[]) {
			expect(await codeOf(save(parent, [change])), change.action).toBe('request.invalid_data');
		}
		expect(await childIds(parent)).toEqual([child]);
		expect(await linksOf(child)).toEqual([link(parent, 'dd47', 1)]);
	});
});

describe('every child is authorized before any is written', () => {
	test('a non-superuser with write on the parent link writes in-scope children (positive control)', async () => {
		const parent = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const child = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const outcome = await save(
			parent,
			[{ action: 'insert', id: null, value: childLocator(child) }],
			{
				actor: ids.treeEditor,
			},
		);
		expect(outcome.ok).toBe(true);
		expect(await childIds(parent)).toEqual([child]);
	});

	test('no write on the parent link: perm.denied, nothing written', async () => {
		const parent = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const child = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		expect(
			await codeOf(
				save(parent, [{ action: 'insert', id: null, value: childLocator(child) }], {
					actor: ids.sectionOnly,
				}),
			),
		).toBe('perm.denied');
		expect(await linksOf(child)).toEqual([]);
	});

	test('ONE out-of-scope child among N refuses the whole save — the in-scope one is not written either', async () => {
		const parent = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const inScope = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const outOfScope = await createDoorRecord(SECTION, AUTHZ_PROJECT_Q);
		expect(
			await codeOf(
				save(
					parent,
					[
						{ action: 'insert', id: null, value: childLocator(inScope) },
						{ action: 'insert', id: null, value: childLocator(outOfScope) },
					],
					{ actor: ids.treeEditor },
				),
			),
		).toBe('perm.out_of_scope');
		expect(await linksOf(inScope)).toEqual([]);
		expect(await orderOf(inScope)).toEqual([]);
		expect(await linksOf(outOfScope)).toEqual([]);
	});
});

describe('a LEAVING child is authorized too — unlinking re-parents it', () => {
	test('clearing the field with an out-of-scope child refuses; every child keeps its link', async () => {
		const parent = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const inScope = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const outOfScope = await createDoorRecord(SECTION, AUTHZ_PROJECT_Q);
		await seedParentLinks(inScope, [link(parent, 'dd47', 1)]);
		await seedParentLinks(outOfScope, [link(parent, 'dd47', 1)]);
		// Anti-vacuity: both ARE read as children before the clear.
		expect(await childIds(parent)).toEqual(sorted([inScope, outOfScope]));

		expect(
			await codeOf(
				save(parent, [{ action: 'clear', id: null, value: null }], { actor: ids.treeEditor }),
			),
		).toBe('perm.out_of_scope');
		expect(await linksOf(inScope)).toEqual([link(parent, 'dd47', 1)]);
		expect(await linksOf(outOfScope)).toEqual([link(parent, 'dd47', 1)]);
		expect(await childIds(parent)).toEqual(sorted([inScope, outOfScope]));
	});

	test('removing an out-of-scope child by locator refuses; it keeps its link', async () => {
		const parent = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const outOfScope = await createDoorRecord(SECTION, AUTHZ_PROJECT_Q);
		await seedParentLinks(outOfScope, [link(parent, 'dd47', 1)]);
		expect(await childIds(parent)).toEqual([outOfScope]);

		expect(
			await codeOf(
				save(parent, [{ action: 'remove', id: null, value: childLocator(outOfScope) }], {
					actor: ids.treeEditor,
				}),
			),
		).toBe('perm.out_of_scope');
		expect(await linksOf(outOfScope)).toEqual([link(parent, 'dd47', 1)]);
	});

	test('removing an in-scope child by locator writes (positive control for the two refusals)', async () => {
		const parent = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		const inScope = await createDoorRecord(SECTION, AUTHZ_PROJECT_P);
		await seedParentLinks(inScope, [link(parent, 'dd47', 1)]);
		expect(await childIds(parent)).toEqual([inScope]);

		const outcome = await save(
			parent,
			[{ action: 'remove', id: null, value: childLocator(inScope) }],
			{ actor: ids.treeEditor },
		);
		expect(outcome.ok).toBe(true);
		expect(await linksOf(inScope)).toEqual([]);
	});
});

describe('history: each child carries the caller’s bulk id, and the bulk revert restores it', () => {
	test('one TM row per child key under the run id; reverting the run relinks the removed child', async () => {
		const parent = await newRecord();
		const a = await newRecord();
		const b = await newRecord();
		await seedParentLinks(a, [link(parent, 'dd47', 1)]);
		await seedParentLinks(b, [link(parent, 'dd47', 1)]);
		const run = await createSectionRecord('dd800', SUPERUSER_ID);
		runs.push(run);

		const outcome = await save(parent, [{ action: 'clear', id: null, value: null }], {
			bulkProcessId: run,
		});
		expect(outcome.ok).toBe(true);
		expect(await childIds(parent)).toEqual([]);

		const rows = (await sql.unsafe(
			`SELECT section_id, tipo FROM matrix_time_machine
			  WHERE bulk_process_id = $1 AND section_tipo = $2 ORDER BY section_id`,
			[run, SECTION],
		)) as { section_id: number; tipo: string }[];
		// Each child's parent key is in the run's undo log; the host is not.
		expect(new Set(rows.map((r) => Number(r.section_id)))).toEqual(new Set([a, b]));
		expect(new Set(rows.map((r) => r.tipo))).toEqual(new Set([PARENT_TIPO]));

		const response = await toolTimeMachineBulkRevert({
			principal,
			userId: SUPERUSER_ID,
			options: { bulk_process_id: run },
			background: false,
		} as never);
		expect(response.ok).toBe(true);
		runs.push((response.data as { bulk_process_id: number }).bulk_process_id);
		expect(await childIds(parent)).toEqual(sorted([a, b]));
		expect(await linksOf(a)).toEqual([link(parent, 'dd47', 1)]);
	}, 60_000);
});

describe('the derived facet: no door replays a children field’s own bytes', () => {
	test('update_cache on the children field is a no-op — leftover bytes never re-parent anything', async () => {
		const parent = await newRecord();
		const child = await newRecord();
		const stranger = await newRecord();
		await seedParentLinks(child, [link(parent, 'dd47', 1)]);
		// An old no-op save's leftovers under the children tipo, naming a stranger.
		const leftover = [{ id: 1, ...childLocator(stranger) }];
		await seedKey(parent, CHILDREN_TIPO, leftover);
		expect(await childIds(parent)).toEqual([child]);

		const loaded = await getLoadedTool('tool_update_cache');
		const res = await mustGet(loaded?.module.apiActions.update_cache, 'update_cache').handler({
			principal,
			userId: SUPERUSER_ID,
			background: false,
			options: {
				section_tipo: SECTION,
				components_selection: [{ tipo: CHILDREN_TIPO }],
				sqo: {
					section_tipo: [SECTION],
					filter_by_locators: [{ section_tipo: SECTION, section_id: String(parent) }],
				},
			},
		});
		expect(res.ok).toBe(true);
		const data = res.data as {
			regenerated: number;
			derived_skipped: string[];
			bulk_process_id: unknown;
		};
		if (typeof data.bulk_process_id === 'number') runs.push(data.bulk_process_id);
		expect(data.derived_skipped).toEqual([CHILDREN_TIPO]);
		expect(data.regenerated).toBe(0);
		expect(await childIds(parent)).toEqual([child]);
		expect(await linksOf(stranger)).toEqual([]);
		expect((await columnOf(parent, 'relation'))[CHILDREN_TIPO]).toEqual(leftover);
	}, 60_000);

	test('tool_propagate_component_data refuses a children field — leftover bytes never re-parent anything', async () => {
		const parent = await newRecord();
		const child = await newRecord();
		const stranger = await newRecord();
		await seedParentLinks(child, [link(parent, 'dd47', 1)]);
		// Leftovers under the children tipo: the region propagate would decide over.
		await seedKey(parent, CHILDREN_TIPO, []);
		expect(await childIds(parent)).toEqual([child]);
		const dd800Before = await maxDd800();

		const loaded = await getLoadedTool('tool_propagate_component_data');
		const handler = mustGet(
			loaded?.module.apiActions.propagate_component_data,
			'propagate_component_data',
		).handler;
		for (const action of ['add', 'replace', 'delete']) {
			const code = await codeOf(
				handler({
					principal,
					userId: SUPERUSER_ID,
					background: false,
					options: {
						section_tipo: SECTION,
						component_tipo: CHILDREN_TIPO,
						action,
						lang: 'lg-nolan',
						total: 1,
						propagate_data_value: [childLocator(stranger)],
						sqo: {
							section_tipo: [SECTION],
							filter_by_locators: [{ section_tipo: SECTION, section_id: String(parent) }],
						},
					},
				}),
			);
			expect(code, action).toBe('request.invalid_options');
		}
		expect(await childIds(parent)).toEqual([child]);
		expect(await linksOf(child)).toEqual([link(parent, 'dd47', 1)]);
		expect(await linksOf(stranger)).toEqual([]);
		// Refused before the run record is minted.
		expect(await maxDd800()).toBe(dd800Before);
	}, 60_000);

	test('the CSV import refuses a children column (replace mode too) — the file, before any dd800 or write', async () => {
		const parent = await newRecord();
		const child = await newRecord();
		const file = `children_refused_${parent}.csv`;
		const cell = JSON.stringify([childLocator(child)]).replace(/"/g, '""');
		writeFileSync(resolve(csvDir(), file), `section_id;${CHILDREN_TIPO}\n${parent};"${cell}"\n`);
		const columnsMap = [
			{ tipo: 'section_id', model: 'section_id' },
			{
				tipo: CHILDREN_TIPO,
				model: 'component_relation_children',
				checked: true,
				map_to: CHILDREN_TIPO,
			},
		];
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const context = {
			principal,
			userId: CSV_USER,
			background: false,
			options: {
				files: [
					{ file, section_tipo: SECTION, bulk_process_label: file, ar_columns_map: columnsMap },
				],
			},
		};
		const validated = await mustGet(
			loaded?.module.apiActions.validate_import,
			'validate_import',
		).handler(context);
		expect(JSON.stringify(validated.data)).toContain(
			`${CHILDREN_TIPO}, component_relation_children): refused`,
		);

		const res = await mustGet(loaded?.module.apiActions.import_files, 'import_files').handler(
			context,
		);
		const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
		if (report.bulk_process_id !== null) runs.push(report.bulk_process_id);
		expect(report.bulk_process_id).toBeNull();
		expect(report.errors.join(' ')).toContain('import the parent on the child records');
		expect(await childIds(parent)).toEqual([]);
		expect(await linksOf(child)).toEqual([]);
	}, 60_000);

	test('the executor backstop refuses a planned children column even past the door', async () => {
		const parent = await newRecord();
		const code = await codeOf(
			executeCsvImport({
				plan: [
					{
						sectionId: parent,
						keyError: null,
						row: 2,
						columns: [
							{
								tipo: CHILDREN_TIPO,
								model: 'component_relation_children',
								lang: 'lg-nolan',
								conform: { value: [] },
								dataframe: null,
								hasData: true,
								mode: 'replace',
							},
						],
					},
				],
				sectionTipo: SECTION,
				principal,
				bulkProcessId: 0,
				errors: [],
				notices: [],
				progress: {
					file: 'backstop.csv',
					fileIndex: 0,
					filesTotal: 1,
					labels: new Map(),
					publish: () => {},
				},
			} as never),
		);
		expect(code).toBe('request.invalid_data');
		expect(CHILDREN_TIPO in (await columnOf(parent, 'relation'))).toBe(false);
	});
});

describe('the derived facet at the mapped (MARC21/Zotero/RDF) importer', () => {
	test('a mapped children field refuses the RUN — typed, named, before any dd800 or write', async () => {
		const parent = await newRecord();
		const child = await newRecord();
		const dd800Before = await maxDd800();
		let refusal: unknown = null;
		try {
			const report = await importMappedRecords(
				[
					{
						sectionId: parent,
						fields: [
							{ component_tipo: CHILDREN_TIPO, values: [JSON.stringify([childLocator(child)])] },
						],
					},
				],
				SECTION,
				principal,
			);
			// A run that wrote: record its dd800 for the sweep, then fail below.
			if (report.bulkProcessId !== null) runs.push(report.bulkProcessId);
		} catch (error) {
			refusal = error;
		}
		expect(isDedaloError(refusal) ? refusal.code : refusal).toBe('request.invalid_data');
		expect(String((refusal as Error).message)).toContain(
			`'${CHILDREN_TIPO}' (component_relation_children) is derived`,
		);
		// Nothing minted, nothing linked, nothing stored under the children tipo.
		expect(await maxDd800()).toBe(dd800Before);
		expect(await childIds(parent)).toEqual([]);
		expect(await linksOf(child)).toEqual([]);
		expect(CHILDREN_TIPO in (await columnOf(parent, 'relation'))).toBe(false);
	}, 60_000);
});

describe('the MCP save door removes a child BY LOCATOR (plan item 2)', () => {
	/** The child's TM rows for its parent key. */
	async function tmRows(childId: number): Promise<number> {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
			[SECTION, childId, PARENT_TIPO],
		)) as { n: number }[];
		return Number(rows[0]?.n ?? 0);
	}

	test('dedalo_save_component remove {value: locator} unlinks exactly that child, with its TM row', async () => {
		const parent = await newRecord();
		const a = await newRecord();
		const b = await newRecord();
		await seedParentLinks(a, [link(parent, 'dd47', 1)]);
		await seedParentLinks(b, [link(parent, 'dd47', 1)]);
		expect(await childIds(parent)).toEqual(sorted([a, b]));
		const tmBeforeA = await tmRows(a);
		const tmBeforeB = await tmRows(b);

		const outcome = await saveComponentValue(principal, {
			section_tipo: SECTION,
			tipo: CHILDREN_TIPO,
			section_id: parent,
			action: 'remove',
			value: childLocator(a),
		});

		expect(outcome.ok).toBe(true);
		expect(await childIds(parent)).toEqual([b]);
		expect(await linksOf(a)).toEqual([]);
		expect(await linksOf(b)).toEqual([link(parent, 'dd47', 1)]);
		// + a's save-before row: its links were seeded RAW, no history (re-pinned
		// 2026-11-12, T1-21); b is untouched — no row, no probe answer needed.
		expect(await tmRows(a)).toBe(tmBeforeA + 2);
		expect(await tmRows(b)).toBe(tmBeforeB);
		expect(CHILDREN_TIPO in (await columnOf(parent, 'relation'))).toBe(false);
	}, 60_000);

	test('a children remove whose value names no record is refused by the write-through (never a wipe)', async () => {
		const parent = await newRecord();
		const a = await newRecord();
		await seedParentLinks(a, [link(parent, 'dd47', 1)]);
		const code = await codeOf(
			saveComponentValue(principal, {
				section_tipo: SECTION,
				tipo: CHILDREN_TIPO,
				section_id: parent,
				action: 'remove',
			}),
		);
		expect(code).toBe('request.invalid_data');
		expect(await childIds(parent)).toEqual([a]);
	});

	test('the SAME id-less shape on any other model is still refused AT THE DOOR (record.remove_without_id)', async () => {
		const parent = await newRecord();
		expect(await getModelByTipo(LITERAL_TIPO)).toBe('component_input_text');
		// A principal with NO grants: the door's refusal precedes the permission
		// probe, so a door that let the shape past answers perm.* here instead —
		// the engine's own sentinel cannot mask a door regression.
		const nobody = { userId: -999, isGlobalAdmin: false, isDeveloper: false } as never;
		const code = await codeOf(
			saveComponentValue(nobody, {
				section_tipo: SECTION,
				tipo: LITERAL_TIPO,
				section_id: parent,
				action: 'remove',
				value: childLocator(parent),
			}),
		);
		expect(code).toBe('record.remove_without_id');
		// …and on the paired parent field, a relation model whose items DO carry ids.
		const viaParent = await codeOf(
			saveComponentValue(nobody, {
				section_tipo: SECTION,
				tipo: PARENT_TIPO,
				section_id: parent,
				action: 'remove',
				value: link(parent, 'dd47'),
			}),
		);
		expect(viaParent).toBe('record.remove_without_id');
		// Control: the children field lets the same principal PAST the door, to
		// the permission probe (the door is not what refuses it).
		const viaChildren = await codeOf(
			saveComponentValue(nobody, {
				section_tipo: SECTION,
				tipo: CHILDREN_TIPO,
				section_id: parent,
				action: 'remove',
				value: childLocator(parent),
			}),
		);
		expect(viaChildren).toMatch(/^perm\./);
	});
});

describe('the orphan-bytes sweep (scripts/relation_children_orphan_sweep.ts)', () => {
	test('dry-run reports the leftover key with its bytes and writes nothing; apply removes only that key', async () => {
		const parent = await newRecord();
		const child = await newRecord();
		await seedParentLinks(child, [link(parent, 'dd47', 1)]);
		const leftover = [{ id: 1, ...childLocator(child) }];
		await seedKey(parent, CHILDREN_TIPO, leftover);
		const scope = { onlySections: [SECTION], onlyIds: [parent, child], actor: SUPERUSER_ID };

		const dry = await sweepRelationChildrenOrphans({ ...scope, apply: false });
		// The census is DERIVED: test3's children tipo is found from the ontology.
		expect(dry.childrenTipos).toContain(CHILDREN_TIPO);
		expect(dry.tables).toContain(TABLE);
		expect(dry.found).toEqual([
			{
				table: TABLE,
				sectionTipo: SECTION,
				sectionId: parent,
				tipo: CHILDREN_TIPO,
				value: leftover,
			},
		]);
		expect(dry.removed).toBe(0);
		expect((await columnOf(parent, 'relation'))[CHILDREN_TIPO]).toEqual(leftover);

		const applied = await sweepRelationChildrenOrphans({ ...scope, apply: true });
		expect(applied.removed).toBe(1);
		expect(CHILDREN_TIPO in (await columnOf(parent, 'relation'))).toBe(false);
		// What the reads serve is untouched: the child is still a child.
		expect(await childIds(parent)).toEqual([child]);
		expect(await linksOf(child)).toEqual([link(parent, 'dd47', 1)]);
		expect((await sweepRelationChildrenOrphans({ ...scope, apply: false })).found).toEqual([]);
	});
});

function csvDir(): string {
	return resolve(config.media.rootPath ?? '', 'import/files', String(CSV_USER));
}
