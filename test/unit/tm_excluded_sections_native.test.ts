/**
 * Time Machine EXCLUDED SECTIONS — TS-native gate (T1-20 / O16).
 *
 * PHP v7 never versions three sections (core/tm_record/class.tm_record.php
 * `$excluded_section_tipos` = [dd655, dd15, dd1521], guarded in
 * tm_record::create and again in component_common::save): the per-user
 * editing search preset (dd655, rewritten on every filter edit), the derived
 * daily user-activity aggregate (dd1521, rebuildable by rebuild_user_stats)
 * and the Time Machine section itself (dd15). The TS port carried only dd15,
 * so every search-panel edit appended TM history.
 *
 * Every TM writer funnels through ONE predicate (time_machine.ts
 * isTmAuditedAddress), so the gate drives each DOOR that reaches it and
 * measures the OUTCOME — rows in matrix_time_machine — never the set's
 * spelling alone:
 *   A/B  the save door (saveComponentData) on dd655 / dd1521 persists the
 *        value and writes ZERO TM rows;
 *   C    the delete door writes no record snapshot for either;
 *   D    the bulk undo-log writers (pair / birth / cascade-delete) return
 *        null and write nothing — with differing images, so a null can only
 *        come from the exclusion;
 *   E    the set equals the PHP contract (secondary spelling pin).
 * Non-vacuity controls (F/G): the identical save and bulk pair on test3 DO
 * write rows, so a zero above is the exclusion, not a broken writer.
 *
 * Situation built here: fresh records on dd655 (matrix_list), dd1521
 * (matrix_stats) and test3 (matrix_test) through the engine's create door;
 * rows + TM rows swept in afterAll with a zero-residue assertion.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	TEMP_PRESET_SECTION_TIPO,
	TIME_MACHINE_SECTION_TIPO,
	TM_EXCLUDED_SECTIONS,
	USER_ACTIVITY_SECTION_TIPO,
} from '../../src/core/concepts/section.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	recordBulkBirth,
	recordBulkCascadeDelete,
	recordBulkPair,
} from '../../src/core/db/time_machine.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const ROOT = -1;
const MARKER = 'TM_EXCLUDED_NATIVE';
/** A scratch bulk id no real run holds (rows it would write are swept by address). */
const SCRATCH_BULK_ID = 990_020_001;

interface Surface {
	section: string;
	table: string;
	component: string; // a component_input_text of the section
}

const PRESET: Surface = { section: 'dd655', table: 'matrix_list', component: 'dd624' };
const USER_ACTIVITY: Surface = { section: 'dd1521', table: 'matrix_stats', component: 'dd1531' };
const CONTROL: Surface = { section: 'test3', table: 'matrix_test', component: 'test52' };

/** Every record this file created, swept in afterAll. */
const created: { surface: Surface; id: number }[] = [];

async function freshRecord(surface: Surface): Promise<number> {
	const id = await createSectionRecord(surface.section, ROOT);
	created.push({ surface, id });
	return id;
}

async function tmRowCount(section: string, id: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
		[section, id],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function rowText(surface: Surface, id: number): Promise<string | null> {
	const rows = (await sql.unsafe(
		`SELECT to_jsonb(t)::text AS body FROM "${surface.table}" t WHERE section_tipo = $1 AND section_id = $2`,
		[surface.section, id],
	)) as { body: string }[];
	return rows[0]?.body ?? null;
}

async function saveMarker(surface: Surface, id: number, tag: string) {
	return saveComponentData({
		componentTipo: surface.component,
		sectionTipo: surface.section,
		sectionId: id,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', value: [{ id: 1, value: `${MARKER}_${tag}` }] }],
		userId: ROOT,
	});
}

describe.if(DB_READY)('Time Machine excluded sections (dd655 / dd1521)', () => {
	beforeAll(async () => {
		// The ambient suite DB must hold the sections this gate builds on.
		const rows = (await sql.unsafe(
			`SELECT tipo FROM dd_ontology WHERE tipo = ANY($1::text[]) AND model = 'section'`,
			[[PRESET.section, USER_ACTIVITY.section, CONTROL.section]],
		)) as { tipo: string }[];
		expect(rows.map((row) => row.tipo).sort()).toEqual(
			[PRESET.section, USER_ACTIVITY.section, CONTROL.section].sort(),
		);
	});

	afterAll(async () => {
		for (const { surface, id } of created)
			await cleanScratchRecord(surface.section, id, surface.table);
		for (const { surface, id } of created) {
			expect(await rowText(surface, id)).toBeNull();
			expect(await tmRowCount(surface.section, id)).toBe(0);
		}
	});

	test('E: the excluded set is the PHP contract {dd15, dd655, dd1521}', () => {
		expect([...TM_EXCLUDED_SECTIONS].sort()).toEqual(['dd1521', 'dd15', 'dd655'].sort());
		expect(TM_EXCLUDED_SECTIONS.has(TIME_MACHINE_SECTION_TIPO)).toBe(true);
		expect(TEMP_PRESET_SECTION_TIPO).toBe(PRESET.section);
		expect(USER_ACTIVITY_SECTION_TIPO).toBe(USER_ACTIVITY.section);
	});

	for (const [label, surface] of [
		['A: dd655 editing preset', PRESET],
		['B: dd1521 user activity', USER_ACTIVITY],
	] as const) {
		test(`${label} — the save persists the value and writes zero TM rows`, async () => {
			const id = await freshRecord(surface);
			const outcome = await saveMarker(surface, id, surface.section);
			expect(outcome.ok).toBe(true);
			expect(await rowText(surface, id)).toContain(`${MARKER}_${surface.section}`);
			expect(await tmRowCount(surface.section, id)).toBe(0);
		}, 30000);

		test(`C: ${surface.section} — the delete door writes no record snapshot`, async () => {
			const id = await freshRecord(surface);
			const outcome = await deleteSectionRecord(surface.section, id, ROOT);
			expect(outcome.deleted).toEqual([id]);
			expect(await rowText(surface, id)).toBeNull();
			expect(await tmRowCount(surface.section, id)).toBe(0);
		}, 30000);

		test(`D: ${surface.section} — the bulk undo-log writers return null and write nothing`, async () => {
			const id = await freshRecord(surface);
			const pair = await recordBulkPair({
				coords: { sectionTipo: surface.section, sectionId: id, componentTipo: surface.component },
				lang: 'lg-nolan',
				userId: ROOT,
				bulkId: SCRATCH_BULK_ID,
				before: [{ id: 1, value: 'before' }],
				after: [{ id: 1, value: 'after' }],
			});
			const birth = await recordBulkBirth({
				sectionTipo: surface.section,
				sectionId: id,
				userId: ROOT,
				bulkId: SCRATCH_BULK_ID,
				image: { string: { [surface.component]: [{ id: 1, value: 'born' }] } },
			});
			const cascade = await recordBulkCascadeDelete({
				sectionTipo: surface.section,
				sectionId: id,
				userId: ROOT,
				bulkId: SCRATCH_BULK_ID,
				snapshot: { string: { [surface.component]: [{ id: 1, value: 'gone' }] } },
			});
			expect(pair).toBeNull();
			expect(birth).toBeNull();
			expect(cascade).toBeNull();
			expect(await tmRowCount(surface.section, id)).toBe(0);
		}, 30000);
	}

	test('F (control): the identical save on test3 DOES write TM history', async () => {
		const id = await freshRecord(CONTROL);
		const outcome = await saveMarker(CONTROL, id, 'control');
		expect(outcome.ok).toBe(true);
		expect(await rowText(CONTROL, id)).toContain(`${MARKER}_control`);
		expect(await tmRowCount(CONTROL.section, id)).toBeGreaterThan(0);
	}, 30000);

	test('G (control): the identical bulk pair on test3 DOES write the undo pair', async () => {
		const id = await freshRecord(CONTROL);
		const pair = await recordBulkPair({
			coords: { sectionTipo: CONTROL.section, sectionId: id, componentTipo: CONTROL.component },
			lang: 'lg-nolan',
			userId: ROOT,
			bulkId: SCRATCH_BULK_ID,
			before: [{ id: 1, value: 'before' }],
			after: [{ id: 1, value: 'after' }],
		});
		expect(pair).not.toBeNull();
		expect(await tmRowCount(CONTROL.section, id)).toBe(2);
	}, 30000);
});
