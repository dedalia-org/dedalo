/**
 * THE BULK REVERT OVER THE UNDO LOG (WC-2026-09-27-bulk-revert-undo-log
 * §2.5-§2.7, decisions D1-D5) — the scenario catalogue, driven through the real
 * `bulk_revert_process` door against runs written by the real doors.
 *
 * Written by an author independent of the code under test. Every case pins an
 * OUTCOME the operator sees — the live value after the revert, and the report
 * (`counter`, `unchanged`, `exact`, `skipped[]`, `inexact[]`) — never the
 * mechanism.
 *
 * WHAT IS COVERED (each `describe` names its catalogue source):
 *   §2.9 additions — a two-language run; an edit after the run, a TM-off write
 *   mid-run, a delete after the run; an empty and an absent before-value;
 *   created records (deleted if safe, kept otherwise); a main+slot unit; an
 *   unsliced key saved under two request languages (one lg-nolan lane); two runs reverted LIFO and
 *   in the wrong order; revert of a revert, a double revert, two concurrent
 *   reverts; a live-run refusal; a cascade (soft: the wiped data restored; a
 *   record a REVERT deleted, D2: undeleted by the revert of that revert — the
 *   one producer of a row-deleted cascade target since the dataframe hard
 *   delete was retired, WC-2026-09-29-dataframe-hard-delete-retired; a HARD
 *   undelete's media FILES, standalone and re-linked by a unit; a missing target
 *   refused before its scope was judged, never located — SEC-16); legacy runs (born in the run vs not); the propagate
 *   region on a translatable UNSLICED model (M2).
 *   The Part-1 catalogue (deleted import_csv_append_native titles) and its
 *   addendum (preBatchLangSlice rules, the per-language legacy walk, the wipe
 *   and lone-clear shapes, PHP-era lang-less values, composed snapshots).
 *
 * N/A, WITH WHY (catalogue titles that pinned a Part-1 MECHANISM, not an outcome):
 *   - "the baseline row is written once, and never for an empty component" —
 *     the undo log writes no baseline; its twin (an append over an empty key
 *     is exactly one B/A pair, B absent) is pinned by bulk_undo_capture_native
 *     and its revert here ("an absent before-value").
 *   - "the append baseline probe reads the same history" — no probe exists
 *     any more; the per-language legacy walk it fed is pinned below.
 *   - "the batch row composes the post-row slot" — since the amendment
 *     (2026-09-27) EVERY row of a dataframe main is composed (main + its slots'
 *     full frames) and a slot save writes its main's composed pair
 *     (bulk_undo_capture_native, "a SLOT save"); the outcome it protected is
 *     pinned here (the composed unit, frameless run B).
 *   - the pre-amendment MAIN+SLOT unit coupling (and its stranded-frames
 *     check) — N/A: the frames ride the main's rows, so the main's unit IS the
 *     coupling; its scenarios are re-covered by the composed-unit describes.
 *
 * SITUATION: a `zzbru` scratch section on `test1` (→ matrix_test) with a
 * translatable input_text, portals whose request_config names their dataframe
 * slots (an unlink slot shared with a second main, a second unlink slot shared
 * by HMAIN/HMAIN2, a SOFT one), a translatable portal and a date. Runs are REAL dd800 records (the
 * legacy born-in-run rule reads their created_date); legacy runs are built by
 * test/helpers/legacy_bulk_run.ts. Everything is swept; the situation drop
 * asserts zero residue. assertTestDatabase before the first write.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { decodeTmImage, recordBulkBirth } from '../../src/core/db/time_machine.ts';
import { avIngestTarget } from '../../src/core/media/av_versions.ts';
import { mediaJobs } from '../../src/core/media/jobs.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import {
	CREATED_DATE,
	createSectionRecord,
	MODIFIED_DATE,
} from '../../src/core/section/record/create_record.ts';
import {
	deleteSectionData,
	deleteSectionRecord,
} from '../../src/core/section/record/delete_record.ts';
import {
	metadataPatchFromAuditValue,
	setRecordMetadata,
} from '../../src/core/section/record/record_metadata.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { principalCanAccessRecord } from '../../src/core/security/record_scope.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { withLiveBulkRun } from '../../src/core/tools/bulk_run_registry.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import {
	type BulkRevertSkipped,
	toolTimeMachineBulkRevert,
} from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { preBatchLangSlice } from '../../tools/tool_time_machine/server/bulk_revert_legacy.ts';
import type { RunRow } from '../../tools/tool_time_machine/server/bulk_revert_plan.ts';
import {
	deleteBornRecords,
	undeleteCascadeRecord,
} from '../../tools/tool_time_machine/server/bulk_revert_records.ts';
import { resolveDataframeSlotTipos } from '../../tools/tool_time_machine/server/dataframe_restore.ts';
import {
	restoreAbsentSectionRow,
	toolTimeMachineApplyValue,
} from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import {
	ACL_NON_ADMIN_PROFILE_ID,
	ACL_NON_ADMIN_USER_ID,
	clearAclIdentityCaches,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { mustGet } from '../helpers/assert.ts';
import { demoteToLegacyRun, insertLegacyBulkRow } from '../helpers/legacy_bulk_run.ts';
import { refusalOf } from '../helpers/refusal.ts';

const TLD = 'zzbru';
const SECTION = `${TLD}1`;
const MAIN = `${TLD}2`; // portal → SLOT (unlink)
const SLOT = `${TLD}3`;
const TEXT = `${TLD}4`; // input_text, translatable (lang-SLICED)
const TPORTAL = `${TLD}5`; // portal whose ontology node says translatable — unsliced: lg-nolan lane only
const HMAIN = `${TLD}6`; // portal → HSLOT (unlink; the frame chain the revert-of-revert re-links)
const HSLOT = `${TLD}7`;
const SMAIN = `${TLD}8`; // portal → SSLOT (soft delete: delete_target)
const SSLOT = `${TLD}9`;
const MAIN2 = `${TLD}10`; // a second portal whose frames live in SLOT too
const DATE = `${TLD}11`; // component_date (a wipe sibling)
const FSECTION = `${TLD}12`; // a section with a PROJECT FILTER and a dato_default
const FILTER = `${TLD}13`; // FSECTION's component_filter (every born record carries it)
const DEFAULTED = `${TLD}14`; // input_text with properties.dato_default
const FTEXT = `${TLD}15`; // input_text, translatable — what a run writes in FSECTION
const IMAGE = `${TLD}16`; // component_image (a SOFT cascade moves its files)
const LMAIN = `${TLD}17`; // input_text, translatable (lang-SLICED) WITH a dataframe slot
const LSLOT = `${TLD}18`;
const HMAIN2 = `${TLD}19`; // a second portal whose frames live in HSLOT too (a SHARED slot)
const OSLOT = `${TLD}20`; // a dataframe slot NO component declares (parent: the section) — orphan frames
const AV = `${TLD}21`; // component_av (a live build holds the record's undelete — A1-01 F5)
const TABLE = 'matrix_test';
const USER_ID = -1;

const portalWithSlot = (tipo: string, slot: string) => ({
	tipo,
	parent: SECTION,
	model: 'component_portal',
	term: { 'lg-eng': `Main ${tipo}` },
	properties: {
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
					show: { ddo_map: [{ tipo: slot, parent: 'self', section_tipo: SECTION }] },
				},
			],
		},
	},
});

const SITUATION = situation({
	tld: TLD,
	name: 'bulk_revert_undo',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Undo revert' } },
		portalWithSlot(MAIN, SLOT),
		{ tipo: SLOT, parent: MAIN, model: 'component_dataframe', term: { 'lg-eng': 'Slot' } },
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: true,
		},
		{
			tipo: TPORTAL,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Translatable portal' },
			is_translatable: true,
		},
		portalWithSlot(HMAIN, HSLOT),
		{
			tipo: HSLOT,
			parent: HMAIN,
			model: 'component_dataframe',
			// unlink: no policy removes a frame target row (WC-2026-09-29)
			term: { 'lg-eng': 'Shared slot' },
		},
		portalWithSlot(SMAIN, SSLOT),
		{
			tipo: SSLOT,
			parent: SMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Soft slot' },
			properties: { dataframe: { delete_policy: 'delete_target' } },
		},
		portalWithSlot(MAIN2, SLOT),
		portalWithSlot(HMAIN2, HSLOT),
		{ tipo: DATE, parent: SECTION, model: 'component_date', term: { 'lg-eng': 'Date' } },
		{ tipo: IMAGE, parent: SECTION, model: 'component_image', term: { 'lg-eng': 'Image' } },
		{ tipo: AV, parent: SECTION, model: 'component_av', term: { 'lg-eng': 'Audiovisual' } },
		{
			tipo: LMAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Literal main' },
			is_translatable: true,
			properties: { has_dataframe: true },
		},
		{
			tipo: LSLOT,
			parent: LMAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Literal slot' },
		},
		{
			tipo: OSLOT,
			parent: SECTION,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Undeclared slot' },
		},
		{ tipo: FSECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Filtered' } },
		{ tipo: FILTER, parent: FSECTION, model: 'component_filter', term: { 'lg-eng': 'Projects' } },
		{
			tipo: DEFAULTED,
			parent: FSECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Defaulted' },
			is_translatable: false,
			properties: { dato_default: [{ id: 1, lang: 'lg-nolan', value: 'born default' }] },
		},
		{
			tipo: FTEXT,
			parent: FSECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: true,
		},
	],
});

const minted: number[] = [];
/** Live media files a case planted; each is swept with its deleted/ versions. */
const plantedMedia: string[] = [];
let bulkTable = '';

/** A creation instant a minute ahead — a record born AFTER the ones a case made before it. */
const laterBirth = (): Date => new Date(Date.now() + 60_000);

type Item = Record<string, unknown>;

interface RevertData {
	counter: number;
	unchanged: number;
	bulk_process_id: number;
	exact: 'full' | 'partial' | 'none';
	skipped: BulkRevertSkipped[];
	inexact: {
		basis: string;
		section_tipo: string;
		section_id: number;
		tipo?: string;
		lang?: string;
	}[];
}

async function context(options: Record<string, unknown>): Promise<ToolActionContext> {
	return {
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options,
		background: false,
	};
}

/** A REAL dd800 run record (the legacy born-in-run rule reads its created_date). */
async function mint(): Promise<number> {
	const id = await createSectionRecord('dd800', USER_ID);
	minted.push(id);
	return id;
}

async function revert(bulk: number): Promise<RevertData> {
	const response = await toolTimeMachineBulkRevert(await context({ bulk_process_id: bulk }));
	expect(response.ok).toBe(true);
	const data = response.data as RevertData;
	minted.push(data.bulk_process_id);
	return data;
}

async function rec(bulk: number | null = null): Promise<number> {
	return createSectionRecord(SECTION, USER_ID, new Date(), undefined, { bulkProcessId: bulk });
}

async function save(
	sectionId: number,
	componentTipo: string,
	lang: string,
	changedData: unknown[],
	extra: { bulk?: number | null; saveTm?: boolean; callerDataframe?: unknown } = {},
): Promise<Item[]> {
	const saved = await saveComponentData({
		componentTipo,
		sectionTipo: SECTION,
		sectionId,
		lang,
		changedData: changedData as never,
		userId: USER_ID,
		bulkProcessId: extra.bulk ?? null,
		saveTm: extra.saveTm,
		callerDataframe: extra.callerDataframe as never,
	});
	expect(saved.ok).toBe(true);
	return (saved.data ?? []) as Item[];
}

/** set_data of ONE item (id 1) in `lang` — the shape a CSV replace cell writes. */
function setText(
	id: number,
	lang: string,
	value: string,
	extra: { bulk?: number | null; saveTm?: boolean } = {},
) {
	return save(id, TEXT, lang, [{ action: 'set_data', value: [{ id: 1, lang, value }] }], extra);
}

/** set_data of ONE item (id 1) of the SLICED literal main LMAIN in `lang`. */
function setLText(id: number, lang: string, value: string, bulk: number | null = null) {
	return save(id, LMAIN, lang, [{ action: 'set_data', value: [{ id: 1, lang, value }] }], { bulk });
}

/** Append one locator to a portal; returns the new item's id. */
async function insertLocator(
	id: number,
	main: string,
	target: number,
	bulk: number | null = null,
): Promise<number> {
	const items = await save(
		id,
		main,
		'lg-nolan',
		[{ action: 'insert', value: { section_tipo: SECTION, section_id: String(target) } }],
		{ bulk },
	);
	const found = items.find((item) => Number(item.section_id) === target);
	return Number(mustGet(found, 'inserted locator').id);
}

/** Insert one frame into `slot`, paired to `main`'s item `idKey`. */
function insertFrame(
	id: number,
	slot: string,
	main: string,
	idKey: number,
	target: number,
	bulk: number | null = null,
) {
	return save(
		id,
		slot,
		'lg-nolan',
		[{ action: 'insert', value: { section_tipo: SECTION, section_id: String(target) } }],
		{ bulk, callerDataframe: { main_component_tipo: main, id_key: idKey } },
	);
}

/** The stored key: `undefined` = absent, 'NO-RECORD' = the record is gone. */
async function stored(id: number, column: string, key: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, key],
	)) as { present: boolean | null; v: unknown }[];
	if (rows.length === 0) return 'NO-RECORD';
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

async function seed(id: number, column: string, key: string, value: unknown): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET ${column} = COALESCE(${column}, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, key, JSON.stringify(value)],
	);
}

/** A key's items as sorted `lang:value` strings (language order is not content). */
const texts = (value: unknown): string[] =>
	(Array.isArray(value) ? (value as Item[]) : [])
		.map((item) => `${String(item.lang ?? '∅')}:${String(item.value)}`)
		.sort();
const targetsOf = (value: unknown): number[] =>
	(Array.isArray(value) ? (value as Item[]) : []).map((item) => Number(item.section_id)).sort();
const reasons = (data: RevertData): string[] => data.skipped.map((entry) => entry.reason).sort();
const frame = (idKey: number, target: number, main = MAIN, slot = SLOT) => ({
	type: 'dd490',
	id_key: idKey,
	section_tipo: SECTION,
	section_id: target,
	from_component_tipo: slot,
	main_component_tipo: main,
});
const locator = (id: number, target: number, main = MAIN) => ({
	id,
	type: 'dd151',
	section_tipo: SECTION,
	section_id: target,
	from_component_tipo: main,
});
/** Frames as comparable (id_key, target) pairs, ignoring the stamped frame id. */
const framePairs = (value: unknown): string[] =>
	(Array.isArray(value) ? (value as Item[]) : [])
		.map(
			(entry) =>
				`${String(entry.main_component_tipo)}#${Number(entry.id_key)}->${Number(entry.section_id)}`,
		)
		.sort();

/** A planted live file and every deleted/ version of it that exists. */
function plantedVersions(live: string): string[] {
	const stem = basename(live).replace(/\.[^.]+$/, '');
	const deletedDir = join(dirname(live), 'deleted');
	const versions = existsSync(deletedDir)
		? readdirSync(deletedDir)
				.filter((name) => name.startsWith(`${stem}_deleted_`))
				.map((name) => join(deletedDir, name))
		: [];
	return [...(existsSync(live) ? [live] : []), ...versions];
}

/**
 * Plant a live image FILE for `id`'s IMAGE key (and the key itself, id 1) at
 * the path the media doors resolve; swept in afterAll with its deleted/ versions.
 */
async function plantImage(id: number, content: string): Promise<string> {
	const spec = mustGet(mediaTypeOf('component_image'), 'image spec');
	await seed(id, 'media', IMAGE, [{ id: 1 }]);
	const live = buildMediaLocation(
		spec,
		{ componentTipo: IMAGE, sectionTipo: SECTION, sectionId: id, lang: null },
		spec.defaultQuality,
		spec.defaultExtension,
		await resolveMediaPathOptions(IMAGE, SECTION, id),
	).absolutePath;
	mkdirSync(dirname(live), { recursive: true });
	writeFileSync(live, content);
	plantedMedia.push(live);
	return live;
}

/** The deleted/ versions of a planted file (the live path excluded). */
const deletedVersionsOf = (live: string): string[] =>
	plantedVersions(live).filter((path) => path !== live);

/**
 * FLOOR of a hard delete's file half: the delete moved the live file into
 * deleted/ — so a passing undelete below proves the files came BACK.
 */
function expectMovedToDeleted(live: string): void {
	expect(existsSync(live)).toBe(false);
	expect(deletedVersionsOf(live).length).toBe(1);
}

/** The undelete put the file back at its live path, and left no deleted/ version behind. */
function expectBackLive(live: string, content: string): void {
	expect(existsSync(live), 'the undeleted media key points at a live path with no file').toBe(true);
	expect(readFileSync(live, 'utf8')).toBe(content);
	expect(deletedVersionsOf(live)).toEqual([]);
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
	await assertTestDatabase('bulk_revert_undo_native');
	await ensureSituation(SITUATION);
	// STRUCTURE FLOOR — the units the revert builds depend on it.
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	expect(await resolveDataframeSlotTipos(MAIN)).toEqual([SLOT]);
	expect(await resolveDataframeSlotTipos(HMAIN)).toEqual([HSLOT]);
	expect(await resolveDataframeSlotTipos(SMAIN)).toEqual([SSLOT]);
	expect(await resolveDataframeSlotTipos(LMAIN)).toEqual([LSLOT]);
	expect(await resolveDataframeSlotTipos(HMAIN2)).toEqual([HSLOT]);
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
}, 60_000);

afterAll(async () => {
	for (const section of [SECTION, FSECTION]) {
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [section]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [section]);
		await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [section]);
	}
	for (const id of minted) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	for (const section of [SECTION, FSECTION]) {
		await sql.unsafe(`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1`, [section]);
	}
	for (const live of plantedMedia) {
		for (const path of plantedVersions(live)) rmSync(path, { force: true });
		expect(plantedVersions(live)).toEqual([]);
	}
	expect(await dropSituation(SITUATION)).toBe(0);
});

// ================================================================ §2.9 core

describe('the exact path (§2.9)', () => {
	test('a TWO-LANGUAGE run reverts both languages exactly; one unit per language region', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'old');
		await setText(id, 'lg-eng', 'oldE');
		const run = await mint();
		await setText(id, 'lg-spa', 'new', { bulk: run });
		await setText(id, 'lg-eng', 'newE', { bulk: run });
		const data = await revert(run);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-eng:oldE', 'lg-spa:old']);
		expect(data).toMatchObject({
			counter: 2,
			unchanged: 0,
			exact: 'full',
			skipped: [],
			inexact: [],
		});
	});

	test('each LANGUAGE region is its own unit: an edit after the run to one language does not block the other', async () => {
		// §2.5 step 5: "A dataframe main (every language) plus the slot keys …
		// form one unit. Every other key is its own unit." A translatable text
		// is not a dataframe main: its spa region reverts while its eng region —
		// edited after the run — is refused on its own.
		const id = await rec();
		await setText(id, 'lg-spa', 'oldS');
		await setText(id, 'lg-eng', 'oldE');
		const run = await mint();
		await setText(id, 'lg-spa', 'runS', { bulk: run });
		await setText(id, 'lg-eng', 'runE', { bulk: run });
		await setText(id, 'lg-eng', 'curator E');
		const data = await revert(run);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-eng:curator E', 'lg-spa:oldS']);
		expect(data.skipped).toEqual([
			{
				reason: 'changed_since_run',
				section_tipo: SECTION,
				tipo: TEXT,
				section_id: id,
				lang: 'lg-eng',
			},
		]);
		expect(data).toMatchObject({ counter: 1, exact: 'partial' });
	});

	test('a one-language run leaves the OTHER language byte-identical (the region law)', async () => {
		const id = await rec();
		await seed(id, 'string', TEXT, [
			{ id: 1, lang: 'lg-eng', value: 'E', extra: { keep: [1, 2] } },
			{ id: 1, lang: 'lg-spa', value: 'S' },
		]);
		const run = await mint();
		await setText(id, 'lg-spa', 'S2', { bulk: run });
		await setText(id, 'lg-eng', 'E-after-run'); // another language edited after the run
		const data = await revert(run);
		const live = (await stored(id, 'string', TEXT)) as Item[];
		expect(live.filter((item) => item.lang === 'lg-eng')).toEqual([
			{ id: 1, lang: 'lg-eng', value: 'E-after-run' },
		]);
		expect(live.filter((item) => item.lang === 'lg-spa')).toEqual([
			{ id: 1, lang: 'lg-spa', value: 'S' },
		]);
		expect(data.exact).toBe('full');
	});

	test('an EDIT after the run: changed_since_run, nothing written, located', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'old');
		const run = await mint();
		await setText(id, 'lg-spa', 'run', { bulk: run });
		await setText(id, 'lg-spa', 'curator edit');
		const data = await revert(run);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:curator edit']);
		expect(data.skipped).toEqual([
			{
				reason: 'changed_since_run',
				section_tipo: SECTION,
				tipo: TEXT,
				section_id: id,
				lang: 'lg-spa',
			},
		]);
		expect(data).toMatchObject({ counter: 0, exact: 'none' });
		const written = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_time_machine WHERE bulk_process_id = $1',
			[data.bulk_process_id],
		)) as { n: number }[];
		expect(written[0]?.n).toBe(0);
	});

	test('a TM-OFF write BETWEEN two of the run’s writes (catalogue wt:1242): interleaved_write, nothing written', async () => {
		// Decided and pinned: the earliest BEFORE is no longer what undoing THIS
		// run alone returns to — a write nobody recorded sits between — so the
		// key is refused, never restored past the unrecorded write.
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const run = await mint();
		await setText(id, 'lg-spa', 'run-1', { bulk: run });
		await setText(id, 'lg-spa', 'tm-off', { saveTm: false });
		await setText(id, 'lg-spa', 'run-2', { bulk: run });
		const data = await revert(run);
		expect(reasons(data)).toEqual(['interleaved_write']);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:run-2']);
		expect(data.exact).toBe('none');
	});

	test('a DELETE after the run: changed_since_run — the revert never recreates a record', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const run = await mint();
		await setText(id, 'lg-spa', 'run', { bulk: run });
		await deleteSectionRecord(SECTION, id, USER_ID);
		const data = await revert(run);
		expect(reasons(data)).toEqual(['changed_since_run']);
		expect(await stored(id, 'string', TEXT)).toBe('NO-RECORD');
	});

	test('an EMPTY before-value comes back as [] — an ABSENT one as absence', async () => {
		const empty = await rec();
		await seed(empty, 'relation', TPORTAL, []);
		const absent = await rec();
		const target = await rec();
		const run = await mint();
		await insertLocator(empty, TPORTAL, target, run);
		await insertLocator(absent, TPORTAL, target, run);
		const data = await revert(run);
		expect(await stored(empty, 'relation', TPORTAL)).toEqual([]);
		expect(await stored(absent, 'relation', TPORTAL)).toBeUndefined();
		expect(data.exact).toBe('full');
	});

	test('an UNSLICED key saved under TWO request languages is ONE key, reverted once', async () => {
		const id = await rec();
		const [a, b, c] = [await rec(), await rec(), await rec()];
		await seed(id, 'relation', MAIN2, [locator(1, a, MAIN2)]);
		const run = await mint();
		await save(
			id,
			MAIN2,
			'lg-spa',
			[{ action: 'insert', value: { section_tipo: SECTION, section_id: String(b) } }],
			{
				bulk: run,
			},
		);
		await save(
			id,
			MAIN2,
			'lg-eng',
			[{ action: 'insert', value: { section_tipo: SECTION, section_id: String(c) } }],
			{
				bulk: run,
			},
		);
		// ONE lane, lg-nolan, whatever the request language (decision 2026-09-29).
		const tags = (await sql.unsafe(
			'SELECT DISTINCT lang FROM matrix_time_machine WHERE bulk_process_id = $1 AND tipo = $2',
			[run, MAIN2],
		)) as { lang: string }[];
		expect(tags.map((row) => row.lang)).toEqual(['lg-nolan']);
		const data = await revert(run);
		expect(await stored(id, 'relation', MAIN2)).toEqual([locator(1, a, MAIN2)]);
		expect(data).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
	});
});

describe('two runs, revert of a revert, double and concurrent reverts (§2.9)', () => {
	test('two runs on one key: LIFO restores the pre-state; the WRONG order refuses', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const run1 = await mint();
		await setText(id, 'lg-spa', 'one', { bulk: run1 });
		const run2 = await mint();
		await setText(id, 'lg-spa', 'two', { bulk: run2 });
		// wrong order first: run1's last after-image ('one') is not live
		const wrong = await revert(run1);
		expect(reasons(wrong)).toEqual(['changed_since_run']);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:two']);
		// LIFO
		expect((await revert(run2)).exact).toBe('full');
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:one']);
		expect((await revert(run1)).exact).toBe('full');
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:pre']);
	});

	test('reverting the REVERT is exact; a DOUBLE revert writes nothing and says unchanged', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const run = await mint();
		await setText(id, 'lg-spa', 'run', { bulk: run });
		const first = await revert(run);
		expect(first).toMatchObject({ counter: 1, exact: 'full' });
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, unchanged: 1, skipped: [] });
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:pre']);
		const back = await revert(first.bulk_process_id);
		expect(back).toMatchObject({ counter: 1, exact: 'full' });
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:run']);
	});

	test('two CONCURRENT reverts of one run: exactly one runs, the other is refused tool.bulk_run_live', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const run = await mint();
		await setText(id, 'lg-spa', 'run', { bulk: run });
		const settled = await Promise.allSettled([
			toolTimeMachineBulkRevert(await context({ bulk_process_id: run })),
			toolTimeMachineBulkRevert(await context({ bulk_process_id: run })),
		]);
		const fulfilled = settled.filter((s) => s.status === 'fulfilled');
		const rejected = settled.filter((s) => s.status === 'rejected');
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		for (const s of fulfilled)
			minted.push((s as PromiseFulfilledResult<{ data: RevertData }>).value.data.bulk_process_id);
		const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
		expect(reason.code).toBe('tool.bulk_run_live');
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:pre']);
	});

	test('a LIVE run is refused (D5), and revertable once it ends', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const run = await mint();
		await withLiveBulkRun(run, async () => {
			await setText(id, 'lg-spa', 'mid-run', { bulk: run });
			const refusal = await refusalOf(
				toolTimeMachineBulkRevert(await context({ bulk_process_id: run })),
			);
			expect(refusal.code).toBe('tool.bulk_run_live');
			expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:mid-run']);
		});
		expect((await revert(run)).exact).toBe('full');
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:pre']);
	});
});

describe('records the run created (D2)', () => {
	test('a record born in the run with only the run’s values is DELETED; reverting the revert brings it back', async () => {
		const target = await rec();
		const run = await mint();
		const born = await rec(run);
		await setText(born, 'lg-spa', 'imported', { bulk: run });
		await insertLocator(born, TPORTAL, target, run);
		const data = await revert(run);
		expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
		expect(data).toMatchObject({ exact: 'full', skipped: [] });
		const back = await revert(data.bulk_process_id);
		expect(texts(await stored(born, 'string', TEXT))).toEqual(['lg-spa:imported']);
		expect(targetsOf(await stored(born, 'relation', TPORTAL))).toEqual([target]);
		expect(back.skipped).toEqual([]);
	});

	test('a born record someone ELSE wrote to is KEPT (created_record_kept); its run keys still revert', async () => {
		const run = await mint();
		const born = await rec(run);
		await setText(born, 'lg-spa', 'imported', { bulk: run });
		await save(born, DATE, 'lg-nolan', [{ action: 'insert', value: { start: { year: 1999 } } }]);
		const data = await revert(run);
		expect(await stored(born, 'string', TEXT)).toBeUndefined();
		expect(await stored(born, 'date', DATE)).not.toBe('NO-RECORD');
		expect(data.skipped).toEqual([
			{ reason: 'created_record_kept', section_tipo: SECTION, tipo: SECTION, section_id: born },
		]);
		expect(data.exact).toBe('partial');
	});

	test('a born record another record REFERENCES is kept', async () => {
		const run = await mint();
		const born = await rec(run);
		await setText(born, 'lg-spa', 'imported', { bulk: run });
		const referrer = await rec();
		await insertLocator(referrer, TPORTAL, born);
		const data = await revert(run);
		expect(await stored(born, 'string', TEXT)).toBeUndefined();
		// Located: D2's gate judged the record's scope before keeping it (SEC-16).
		expect(data.skipped).toEqual([
			{ reason: 'created_record_kept', section_tipo: SECTION, tipo: SECTION, section_id: born },
		]);
		expect(targetsOf(await stored(referrer, 'relation', TPORTAL))).toEqual([born]);
	});

	test('a born record whose delete FAILS behind its scope gate is `failed`, located, with the error’s CODE', async () => {
		// WC-2026-10-11-parent-link-cycle-every-door: every LOCATED `failed` entry
		// carries the converter's wire code of what failed the unit — a code,
		// never the words. Situation: the run created a record in a section the
		// ontology no longer declares (a node removed after the run). Its marker
		// passes the scope gate (an admin; an unresolvable section is not proven
		// gone), then the delete door refuses it with a TYPED error. The run's
		// other born record is still deleted: one marker's failure never aborts
		// the others.
		const gone = `${TLD}999`; // no ontology node: resolves no matrix table
		const run = await mint();
		const born = await rec(run);
		try {
			expect(await getMatrixTableFromTipo(gone)).toBeNull();
			expect(
				await recordBulkBirth({ sectionTipo: gone, sectionId: born, userId: USER_ID, bulkId: run }),
			).not.toBeNull();
			const quiet = console.error;
			console.error = () => {};
			const data = await revert(run).finally(() => {
				console.error = quiet;
			});
			expect(data.skipped).toEqual([
				{
					reason: 'failed',
					section_tipo: gone,
					tipo: gone,
					section_id: born,
					code: 'section.no_matrix_table',
				},
			]);
			expect(JSON.stringify(data)).not.toContain('no matrix table');
			expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
		} finally {
			await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [gone]);
		}
	});

	test('born records referencing EACH OTHER are all deleted (repeated passes)', async () => {
		const run = await mint();
		const a = await rec(run);
		const b = await rec(run);
		await insertLocator(a, TPORTAL, b, run);
		await insertLocator(b, TPORTAL, a, run);
		const data = await revert(run);
		expect(await stored(a, 'relation', TPORTAL)).toBe('NO-RECORD');
		expect(await stored(b, 'relation', TPORTAL)).toBe('NO-RECORD');
		expect(data.skipped).toEqual([]);
	});
});

describe('a MAIN and its frames are ONE composed unit (§2.9, amendment 2026-09-27; catalogue wt:1051, wt:1665, wt:1769)', () => {
	test('an append whose main already had FRAMES: the new item and its frame go, the old frame stays', async () => {
		const host = await rec();
		const [t1, t2, r1, r2] = [await rec(), await rec(), await rec(), await rec()];
		// pre-run state written with the time machine OFF (no history at all)
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		await seed(host, 'relation', SLOT, [frame(1, r1)]);
		const run = await mint();
		const item2 = await insertLocator(host, MAIN, t2, run);
		await insertFrame(host, SLOT, MAIN, item2, r2, run);
		const data = await revert(run);
		expect(targetsOf(await stored(host, 'relation', MAIN))).toEqual([t1]);
		expect(framePairs(await stored(host, 'relation', SLOT))).toEqual([`${MAIN}#1->${r1}`]);
		// ONE unit (main + its slot), all-or-nothing
		expect(data).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
	});

	test('a unit is ALL-OR-NOTHING: a slot edited after the run refuses the main too', async () => {
		const host = await rec();
		const [t1, t2, r2, r3] = [await rec(), await rec(), await rec(), await rec()];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		const run = await mint();
		const item2 = await insertLocator(host, MAIN, t2, run);
		await insertFrame(host, SLOT, MAIN, item2, r2, run);
		await insertFrame(host, SLOT, MAIN, 1, r3); // curator, after the run
		const mainAfterRun = await stored(host, 'relation', MAIN);
		const data = await revert(run);
		expect(reasons(data)).toEqual(['changed_since_run']);
		expect(await stored(host, 'relation', MAIN)).toEqual(mainAfterRun);
		expect(framePairs(await stored(host, 'relation', SLOT)).length).toBe(2);
	});

	test('a main whose ONLY slot is UNDECLARED is ONE unit across its lanes: a frame edited after the run refuses its language lane too — nothing written, never an orphan', async () => {
		const host = await rec();
		const [r1, r2] = [await rec(), await rec()];
		const run = await mint();
		await setText(host, 'lg-spa', 'Casa', { bulk: run }); // the run adds spa item 1…
		await insertFrame(host, OSLOT, TEXT, 1, r1, run); // …and its frame, in a slot TEXT never declares
		// FLOOR: the run left a language lane AND a frame lane under the main
		const lanes = new Set(
			(await runRowsOf(SECTION, host, run))
				.filter((row) => row.tipo === TEXT)
				.map((row) => row.lang),
		);
		expect([...lanes].sort()).toEqual(['lg-nolan', 'lg-spa']);
		const live = mustGet(
			(await stored(host, 'relation', OSLOT)) as Item[] | undefined,
			'the frame',
		)[0] as Item;
		await save(
			host,
			OSLOT,
			'lg-nolan',
			[{ action: 'update', id: live.id, value: { ...live, section_id: String(r2) } }],
			{ callerDataframe: { main_component_tipo: TEXT, id_key: 1 } },
		); // curator, after the run
		const textAfterRun = await stored(host, 'string', TEXT);
		const slotAfterEdit = await stored(host, 'relation', OSLOT);
		expect(framePairs(slotAfterEdit)).toEqual([`${TEXT}#1->${r2}`]); // FLOOR
		const data = await revert(run);
		expect(reasons(data)).toEqual(['changed_since_run']);
		expect(await stored(host, 'string', TEXT)).toEqual(textAfterRun);
		expect(await stored(host, 'relation', OSLOT)).toEqual(slotAfterEdit);
	});

	test('a later FRAMELESS run B reverts to A: the frames A paired survive', async () => {
		const host = await rec();
		const [t1, t2, t3, r2] = [await rec(), await rec(), await rec(), await rec()];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		const runA = await mint();
		const item2 = await insertLocator(host, MAIN, t2, runA);
		await insertFrame(host, SLOT, MAIN, item2, r2, runA);
		const afterA = {
			main: await stored(host, 'relation', MAIN),
			slot: await stored(host, 'relation', SLOT),
		};
		const runB = await mint();
		await insertLocator(host, MAIN, t3, runB); // touches the main only
		const data = await revert(runB);
		expect(await stored(host, 'relation', MAIN)).toEqual(afterA.main);
		expect(await stored(host, 'relation', SLOT)).toEqual(afterA.slot);
		expect(data.exact).toBe('full');
	});

	test('catalogue wt:1792: an edit to a frame BEFORE run B is part of B’s pre-state and survives B’s revert; another main’s frame in the shared slot is kept', async () => {
		// Part-1 expected `changed_since_run` for a stale COMPOSED snapshot. The
		// undo log records B's exact BEFORE, so an edit made before B is not a
		// conflict: it is what B's revert returns to. The outcome the title
		// protected — the edit survives, nothing else's frame is lost — holds.
		const host = await rec();
		const [t1, t2, rA, rEdit, rOther] = [
			await rec(),
			await rec(),
			await rec(),
			await rec(),
			await rec(),
		];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		const runA = await mint();
		const item2 = await insertLocator(host, MAIN, t2, runA);
		await insertFrame(host, SLOT, MAIN, item2, rA, runA);
		await insertFrame(host, SLOT, MAIN, 1, rEdit); // the later frame edit
		await seed(host, 'relation', MAIN2, [locator(1, t1, MAIN2)]);
		await insertFrame(host, SLOT, MAIN2, 1, rOther); // another main's frame, shared slot
		const beforeB = await stored(host, 'relation', SLOT);
		const runB = await mint();
		await save(host, MAIN, 'lg-nolan', [{ action: 'remove', id: item2, value: null }], {
			bulk: runB,
		});
		const data = await revert(runB);
		expect(framePairs(await stored(host, 'relation', SLOT))).toEqual(framePairs(beforeB));
		expect(framePairs(await stored(host, 'relation', SLOT))).toContain(`${MAIN2}#1->${rOther}`);
		expect(framePairs(await stored(host, 'relation', SLOT))).toContain(`${MAIN}#1->${rEdit}`);
		expect(data.skipped).toEqual([]);
	});
});

describe('the COMPOSED revert (amendment 2026-09-27: main + frames from one row)', () => {
	test('a two-language run over a SLICED main with frames: the frame chain is language-blind; revert and revert-of-revert are exact', async () => {
		const id = await rec();
		const t1 = await rec();
		await setLText(id, 'lg-spa', 'pre spa');
		await setLText(id, 'lg-eng', 'pre eng');
		const run = await mint();
		await setLText(id, 'lg-spa', 'run spa', run);
		await insertFrame(id, LSLOT, LMAIN, 1, t1, run); // recorded under LMAIN, lg-nolan
		await setLText(id, 'lg-eng', 'run eng', run);
		const afterRun = {
			main: texts(await stored(id, 'string', LMAIN)),
			slot: framePairs(await stored(id, 'relation', LSLOT)),
		};
		expect(afterRun.slot).toEqual([`${LMAIN}#1->${t1}`]);
		// FLOOR: the slot has no row of its own — every pair sits on the main.
		const slotRows = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_time_machine WHERE bulk_process_id = $1 AND tipo = $2',
			[run, LSLOT],
		)) as { n: number }[];
		expect(slotRows[0]?.n).toBe(0);
		const data = await revert(run);
		expect(texts(await stored(id, 'string', LMAIN))).toEqual(['lg-eng:pre eng', 'lg-spa:pre spa']);
		expect(framePairs(await stored(id, 'relation', LSLOT))).toEqual([]);
		expect(data).toMatchObject({ counter: 1, exact: 'full', skipped: [], inexact: [] });
		const again = await revert(data.bulk_process_id);
		expect(texts(await stored(id, 'string', LMAIN))).toEqual(afterRun.main);
		expect(framePairs(await stored(id, 'relation', LSLOT))).toEqual(afterRun.slot);
		expect(again).toMatchObject({ counter: 1, exact: 'full', skipped: [], inexact: [] });
	});

	test('a frame of the main written BETWEEN two of the run’s frame writes: interleaved_write, nothing written', async () => {
		const host = await rec();
		const [t1, r1, r2, r3] = [await rec(), await rec(), await rec(), await rec()];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		const run = await mint();
		await insertFrame(host, SLOT, MAIN, 1, r1, run);
		await insertFrame(host, SLOT, MAIN, 1, r2); // curator, mid-run
		await insertFrame(host, SLOT, MAIN, 1, r3, run);
		const slotBefore = await stored(host, 'relation', SLOT);
		const data = await revert(run);
		expect(reasons(data)).toEqual(['interleaved_write']);
		expect(await stored(host, 'relation', SLOT)).toEqual(slotBefore);
	});

	test('another main’s frame added to the SHARED slot after the run is not this unit’s: the revert is exact and keeps it', async () => {
		const host = await rec();
		const [t1, t2, r2, rOther] = [await rec(), await rec(), await rec(), await rec()];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		await seed(host, 'relation', MAIN2, [locator(1, t1, MAIN2)]);
		const run = await mint();
		const item2 = await insertLocator(host, MAIN, t2, run);
		await insertFrame(host, SLOT, MAIN, item2, r2, run);
		await insertFrame(host, SLOT, MAIN2, 1, rOther); // MAIN2's, after the run
		const data = await revert(run);
		expect(targetsOf(await stored(host, 'relation', MAIN))).toEqual([t1]);
		expect(framePairs(await stored(host, 'relation', SLOT))).toEqual([`${MAIN2}#1->${rOther}`]);
		expect(data).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
	});

	test('a non-admin with the MAIN’s grant but not the SLOT’s: out_of_scope, nothing written (the slot is gated too)', async () => {
		await installAclIdentityFixture();
		try {
			const grants = [
				{ id: 50, tipo: SECTION, section_tipo: SECTION, value: 2 },
				{ id: 52, tipo: HMAIN, section_tipo: SECTION, value: 2 },
			];
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
			);
			clearAclIdentityCaches();
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			const host = await rec();
			const [t1, role] = [await rec(), await rec()];
			await setText(role, 'lg-spa', 'role record');
			await seed(host, 'relation', HMAIN, [locator(1, t1, HMAIN)]);
			await seed(host, 'relation', HSLOT, [{ id: 1, ...frame(1, role, HMAIN, HSLOT) }]);
			const run = await mint();
			await save(host, HSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], {
				bulk: run,
			});
			// FLOOR: the record itself is in the reader's scope — only the slot grant is missing.
			expect(reader.isGlobalAdmin).toBe(false);
			expect(await principalCanAccessRecord(SECTION, host, reader)).toBe(true);
			const response = await toolTimeMachineBulkRevert({
				principal: reader,
				userId: ACL_NON_ADMIN_USER_ID,
				options: { bulk_process_id: run },
				background: false,
			});
			const data = response.data as RevertData;
			minted.push(data.bulk_process_id);
			// an unlink slot: the target was never touched, and the frame stays out
			expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:role record']);
			expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([]);
			expect(data.skipped.map((entry) => entry.reason)).toContain('out_of_scope');
			expect(data.counter).toBe(0);
		} finally {
			await removeAclIdentityFixture();
		}
	});
});

describe('pre-run values the time machine never saw (catalogue wt:1051, wt:1159)', () => {
	test('a portal seeded with the TM OFF: its locator survives the revert; only the appended one goes', async () => {
		const host = await rec();
		const [a, b] = [await rec(), await rec()];
		await seed(host, 'relation', MAIN2, [locator(1, a, MAIN2)]);
		const run = await mint();
		await insertLocator(host, MAIN2, b, run);
		await revert(run);
		expect(await stored(host, 'relation', MAIN2)).toEqual([locator(1, a, MAIN2)]);
	});

	test('slot frames written by a legacy REPLACE (saveTm:false) before the run survive an append’s revert', async () => {
		const host = await rec();
		const [t1, t2, r1, r2] = [await rec(), await rec(), await rec(), await rec()];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		await insertFrame(host, SLOT, MAIN, 1, r1);
		await save(host, SLOT, 'lg-nolan', [{ action: 'set_data', value: [frame(1, r1)] }], {
			saveTm: false,
		});
		const slotPre = await stored(host, 'relation', SLOT);
		const run = await mint();
		const item2 = await insertLocator(host, MAIN, t2, run);
		await insertFrame(host, SLOT, MAIN, item2, r2, run);
		await revert(run);
		expect(await stored(host, 'relation', SLOT)).toEqual(slotPre);
		expect(targetsOf(await stored(host, 'relation', MAIN))).toEqual([t1]);
	});

	test('STALE history (portal): TM-on v1, TM-off v2, then a run — the revert keeps v2, never v1', async () => {
		const host = await rec();
		const [a, b, c] = [await rec(), await rec(), await rec()];
		await insertLocator(host, MAIN2, a); // v1, with history
		await save(host, MAIN2, 'lg-nolan', [{ action: 'set_data', value: [locator(1, b, MAIN2)] }], {
			saveTm: false,
		}); // v2, no history
		const v2 = await stored(host, 'relation', MAIN2);
		const run = await mint();
		await insertLocator(host, MAIN2, c, run);
		expect((await revert(run)).exact).toBe('full');
		expect(await stored(host, 'relation', MAIN2)).toEqual(v2);
	});

	test('STALE history (slot): a TM row, then legacy REPLACE frames, then an append — the replace frames stay', async () => {
		const host = await rec();
		const [t1, t2, r1, rReplace, r2] = [
			await rec(),
			await rec(),
			await rec(),
			await rec(),
			await rec(),
		];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		await insertFrame(host, SLOT, MAIN, 1, r1); // TM row
		await save(host, SLOT, 'lg-nolan', [{ action: 'set_data', value: [frame(1, rReplace)] }], {
			saveTm: false,
		});
		const slotPre = await stored(host, 'relation', SLOT);
		const run = await mint();
		const item2 = await insertLocator(host, MAIN, t2, run);
		await insertFrame(host, SLOT, MAIN, item2, r2, run);
		await revert(run);
		expect(await stored(host, 'relation', SLOT)).toEqual(slotPre);
	});
});

describe('multi-language appends (catalogue wt:1351)', () => {
	test('stored eng only, no history: a spa+eng run reverts to the stored eng value, spa gone', async () => {
		const id = await rec();
		await seed(id, 'string', TEXT, [{ id: 1, lang: 'lg-eng', value: 'E' }]);
		const run = await mint();
		await save(id, TEXT, 'lg-spa', [{ action: 'insert', value: { value: 'S+' } }], { bulk: run });
		await save(id, TEXT, 'lg-eng', [{ action: 'insert', value: { value: 'E+' } }], { bulk: run });
		expect((await revert(run)).exact).toBe('full');
		expect(await stored(id, 'string', TEXT)).toEqual([{ id: 1, lang: 'lg-eng', value: 'E' }]);
	});

	test('stored eng + spa, no history: both languages revert to their pre slice', async () => {
		const id = await rec();
		const pre = [
			{ id: 1, lang: 'lg-eng', value: 'E' },
			{ id: 1, lang: 'lg-spa', value: 'S' },
		];
		await seed(id, 'string', TEXT, pre);
		const run = await mint();
		await save(id, TEXT, 'lg-spa', [{ action: 'insert', value: { value: 'S+' } }], { bulk: run });
		await save(id, TEXT, 'lg-eng', [{ action: 'insert', value: { value: 'E+' } }], { bulk: run });
		await revert(run);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(texts(pre));
	});

	test('history only in ANOTHER language: the appended language still reverts', async () => {
		const id = await rec();
		await setText(id, 'lg-eng', 'E'); // history: eng only
		const run = await mint();
		await save(id, TEXT, 'lg-spa', [{ action: 'insert', value: { value: 'S+' } }], { bulk: run });
		await revert(run);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-eng:E']);
	});
});

describe('PHP-era LANG-LESS values (catalogue wt:1486)', () => {
	test('a REPLACE run over a lang-less value brings it back (never blanks it)', async () => {
		const id = await rec();
		const pre = [{ id: 1, value: 'php era' }];
		await seed(id, 'string', TEXT, pre);
		const run = await mint();
		await setText(id, 'lg-spa', 'replaced', { bulk: run });
		await revert(run);
		expect(await stored(id, 'string', TEXT)).toEqual(pre);
	});

	test('an APPEND run over a lang-less value restores it byte-exact, once', async () => {
		const id = await rec();
		const pre = [{ id: 1, value: 'php era' }];
		await seed(id, 'string', TEXT, pre);
		const run = await mint();
		await save(id, TEXT, 'lg-spa', [{ action: 'insert', value: { value: 'added' } }], {
			bulk: run,
		});
		await revert(run);
		expect(await stored(id, 'string', TEXT)).toEqual(pre);
	});

	test('an insert run that KEEPS the lang-less item restores it once, never twice', async () => {
		const id = await rec();
		const pre = [
			{ id: 1, value: 'php era' },
			{ id: 2, lang: 'lg-eng', value: 'E' },
		];
		await seed(id, 'string', TEXT, pre);
		const run = await mint();
		await save(id, TEXT, 'lg-spa', [{ action: 'insert', value: { value: 'S' } }], { bulk: run });
		await save(id, TEXT, 'lg-eng', [{ action: 'insert', value: { value: 'E2' } }], { bulk: run });
		await revert(run);
		const live = (await stored(id, 'string', TEXT)) as Item[];
		expect(live.filter((item) => item.value === 'php era').length).toBe(1);
		expect(texts(live)).toEqual(texts(pre));
	});

	test('a NON-ARRAY lang-less value, then a later eng edit: the spa revert restores it beside eng, full', async () => {
		// A PHP-era key stored as ONE object (no array, no lang). The spa run
		// replaces it; a curator then adds eng. The spa region is unchanged since
		// the run, so the revert runs: the object comes back as the one item it
		// is, and the eng edit stays (an edit to one language never blocks
		// another's revert).
		const id = await rec();
		const pre = { id: 1, value: 'php object' };
		await seed(id, 'string', TEXT, pre);
		const run = await mint();
		await setText(id, 'lg-spa', 'run S', { bulk: run });
		await setText(id, 'lg-eng', 'curator E');
		const data = await revert(run);
		expect(data).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
		const live = (await stored(id, 'string', TEXT)) as Item[];
		expect(texts(live)).toEqual(['lg-eng:curator E', '∅:php object']);
	});
});

describe('wipes and clears (catalogue wt:1559 first case)', () => {
	test('stored eng + spa, WIPED (delete data), then a run writes spa: the revert leaves it empty', async () => {
		const id = await rec();
		await seed(id, 'string', TEXT, [
			{ id: 1, lang: 'lg-eng', value: 'E' },
			{ id: 1, lang: 'lg-spa', value: 'S' },
		]);
		await deleteSectionData(SECTION, id, USER_ID);
		const run = await mint();
		await setText(id, 'lg-spa', 'after wipe', { bulk: run });
		await revert(run);
		const live = await stored(id, 'string', TEXT);
		expect(live === undefined || (Array.isArray(live) && live.length === 0)).toBe(true);
	});
});

/**
 * THE PRODUCER of a ROW-DELETED cascade target (no dataframe policy removes a
 * frame target row any more: WC-2026-09-29-dataframe-hard-delete-retired). A
 * run A creates `target` and frames it from `host` (HSLOT, paired to HMAIN's
 * pre-run item 1); the revert R of A takes the frame away, and D2 deletes the
 * now unreferenced born record UNDER R's BULK ID — a role-4 twin. The revert
 * of R is the one that must re-link and undelete it. `link` adds more links
 * under A (each is reverted by R before D2 runs).
 */
async function revertDeletedTarget(
	options: {
		text?: string | null;
		birth?: Date;
		link?: (target: number, run: number) => Promise<void>;
	} = {},
): Promise<{ host: number; target: number; run: number; revertId: number }> {
	const text = options.text === undefined ? 'role record' : options.text;
	const host = await rec();
	const t1 = await rec();
	await seed(host, 'relation', HMAIN, [locator(1, t1, HMAIN)]);
	const run = await mint();
	const target = await createSectionRecord(
		SECTION,
		USER_ID,
		options.birth ?? new Date(),
		undefined,
		{
			bulkProcessId: run,
		},
	);
	if (text !== null) await setText(target, 'lg-spa', text, { bulk: run });
	await insertFrame(host, HSLOT, HMAIN, 1, target, run);
	if (options.link !== undefined) await options.link(target, run);
	const first = await revert(run);
	// FLOOR: D2 deleted the target under the revert's id (its role-4 twin), and
	// the frame that linked it is gone — so the next revert has a row to undelete.
	expect(first.skipped).toEqual([]);
	expect(await stored(target, 'data', 'section_id')).toBe('NO-RECORD');
	expect(
		(await runRowsOf(SECTION, target, first.bulk_process_id)).some((row) => row.tm_role === 4),
	).toBe(true);
	expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([]);
	return { host, target, run, revertId: first.bulk_process_id };
}

describe('the dataframe cascade of a run (D3)', () => {
	test('a record a REVERT deleted (D2) is UNDELETED by the revert of that revert, with its frame (inexact: cascade_undelete)', async () => {
		const { host, target, revertId } = await revertDeletedTarget();
		const data = await revert(revertId);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:role record']);
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([`${HMAIN}#1->${target}`]);
		expect(data.inexact).toEqual([
			{ basis: 'cascade_undelete', section_tipo: SECTION, section_id: target, tipo: SECTION },
		]);
		expect(data.exact).toBe('partial');
	});

	test('address taken again before the revert of the revert: cascade_delete_not_reverted, the new record untouched', async () => {
		const { host, target, revertId } = await revertDeletedTarget({ text: null });
		// A new record born at the address (a create at an explicit id opens an epoch).
		await createSectionRecord(SECTION, USER_ID, laterBirth(), target);
		await setText(target, 'lg-spa', 'a new record here');
		const data = await revert(revertId);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:a new record here']);
		// The target refuses the UNIT that re-links it (located at the unit, which
		// passed its gate): the frame is NOT restored onto the foreign record.
		expect(data.skipped).toEqual([
			{
				reason: 'cascade_delete_not_reverted',
				section_tipo: SECTION,
				// the unit is the MAIN's composed unit (its frames ride its rows)
				tipo: HMAIN,
				section_id: host,
			},
		]);
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([]);
	});

	test('linked by a MAIN locator: the composed row re-links through its MAIN part, and the target comes back with it', async () => {
		// What the revert of the revert re-links must come back with the unit, or
		// the restored locator points at a record that is gone. (§2.3 item 7, M1 —
		// the cascade a MAIN item removal fires — is pinned by the SOFT test
		// 'via a MAIN item removal' below.)
		const host = await rec();
		const t1 = await rec();
		await seed(host, 'relation', HMAIN, [locator(1, t1, HMAIN)]);
		const run = await mint();
		const target = await rec(run);
		await setText(target, 'lg-spa', 'role record', { bulk: run });
		await insertLocator(host, HMAIN, target, run);
		const first = await revert(run);
		// FLOOR: D2 deleted the target under the revert's id.
		expect(await stored(target, 'string', TEXT)).toBe('NO-RECORD');
		expect(targetsOf(await stored(host, 'relation', HMAIN))).toEqual([t1]);
		await revert(first.bulk_process_id);
		expect(targetsOf(await stored(host, 'relation', HMAIN))).toEqual([t1, target].sort());
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:role record']);
	});

	test('SOFT (delete_target): the target’s WIPED data comes back — the row was never gone', async () => {
		// Decision D3 covers every cascade the run fired. A soft cascade wipes
		// the target's components and keeps the row: its role-4 snapshot must be
		// restored INTO the surviving row, not refused as "address occupied".
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'role record');
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		expect(await stored(role, 'string', TEXT)).not.toEqual([
			{ id: 1, lang: 'lg-spa', value: 'role record' },
		]);
		await revert(run);
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:role record']);
	});

	test('SOFT, via a MAIN item removal: the cascade carries the run id, and the revert restores main, frame and the wiped target together', async () => {
		// §2.3 item 7 (M1): the cascade a main removal fires must reach the revert,
		// or the restored frame points at a record whose data is gone.
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'role record');
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SMAIN, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: the main item, its frame and the target's data are gone; the row stays.
		expect(targetsOf(await stored(host, 'relation', SMAIN))).toEqual([]);
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([]);
		expect(texts(await stored(role, 'string', TEXT))).toEqual([]);
		expect(await stored(role, 'data', 'section_id')).not.toBe('NO-RECORD');
		const data = await revert(run);
		expect(targetsOf(await stored(host, 'relation', SMAIN))).toEqual([t1]);
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([`${SMAIN}#1->${role}`]);
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:role record']);
		expect(data.inexact.map((entry) => entry.basis)).toEqual(['cascade_undelete']);
	});

	test('SOFT, the target holds an ORPHAN frame (a slot no main declares, a main the ontology lacks): undeleted, never failed', async () => {
		// The wipe drops a frame no main owns without history (orphan 'skip');
		// its restore must do the same — else engine.uncovered_scope fails the
		// unit re-linking the target, on every attempt.
		const host = await rec();
		const [t1, role, other] = [await rec(), await rec(), await rec()];
		await setText(role, 'lg-spa', 'role record');
		const orphan = { id: 1, ...frame(1, other, `${TLD}999`, OSLOT) };
		await seed(role, 'relation', OSLOT, [orphan]);
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: the wipe removed the orphan slot and the text.
		expect(await stored(role, 'relation', OSLOT)).toBeUndefined();
		expect(await stored(role, 'string', TEXT)).toBeUndefined();
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.inexact.map((entry) => entry.basis)).toEqual(['cascade_undelete']);
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:role record']);
		expect(await stored(role, 'relation', OSLOT)).toEqual([orphan]);
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([`${SMAIN}#1->${role}`]);
		// No history for the orphan slot: the wipe wrote none, nor does its restore.
		const rows = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
			[SECTION, role, OSLOT],
		)) as { n: number }[];
		expect(rows[0]?.n).toBe(0);
	});

	test('SOFT, curator in lg-eng: the wipe row of a TRANSLATABLE-flagged portal and its undelete pair are both lg-nolan — one timeline', async () => {
		// Decision 2026-09-29: a relation holds locators, never translatable —
		// the wipe (deleteSectionData) and its undo (mainKeySteps) both file an
		// unsliced main in lg-nolan, whatever its ontology flag and whatever the
		// curator's language (DATA-01: never the install's menu lang either).
		const requestLang = 'lg-eng';
		expect((config.menu as { dataLang?: string }).dataLang).not.toBe(requestLang);
		const host = await rec();
		const [t1, role, kept] = [await rec(), await rec(), await rec()];
		await seed(role, 'relation', TPORTAL, [locator(1, kept, TPORTAL)]);
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const langs = { applicationLang: requestLang, dataLang: requestLang };
		const run = await mint();
		await runWithRequestLangs(langs, () =>
			save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run }),
		);
		expect(await stored(role, 'relation', TPORTAL)).toBeUndefined();
		const data = await runWithRequestLangs(langs, () => revert(run));
		expect(data.skipped).toEqual([]);
		expect(targetsOf(await stored(role, 'relation', TPORTAL))).toEqual([kept]);
		const rows = (await sql.unsafe(
			`SELECT lang FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id`,
			[SECTION, role, TPORTAL],
		)) as { lang: string }[];
		// backfill + wipe, then the revert's pair: every row in the one lg-nolan lane.
		expect(rows.length).toBeGreaterThanOrEqual(3);
		expect([...new Set(rows.map((row) => row.lang))]).toEqual(['lg-nolan']);
	});

	test('SOFT: the wipe moved the target’s media FILES into deleted/; the revert moves them back', async () => {
		const spec = mustGet(mediaTypeOf('component_image'), 'image spec');
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'role record');
		await seed(role, 'media', IMAGE, [{ id: 1 }]);
		const live = buildMediaLocation(
			spec,
			{ componentTipo: IMAGE, sectionTipo: SECTION, sectionId: role, lang: null },
			spec.defaultQuality,
			spec.defaultExtension,
			await resolveMediaPathOptions(IMAGE, SECTION, role),
		).absolutePath;
		mkdirSync(dirname(live), { recursive: true });
		writeFileSync(live, 'soft-cascade-image');
		plantedMedia.push(live);
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: the wipe emptied the key and moved the file out of the live path.
		expect(await stored(role, 'media', IMAGE)).toBeUndefined();
		expect(existsSync(live)).toBe(false);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(await stored(role, 'media', IMAGE)).toEqual([{ id: 1 }]);
		expect(existsSync(live), 'the restored media key points at a live path with no file').toBe(
			true,
		);
		expect(readFileSync(live, 'utf8')).toBe('soft-cascade-image');
	});

	test('SOFT, target edited after the wipe: the edit survives, the record is reported — the unit re-linking it still runs', async () => {
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'role record');
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		await setText(role, 'lg-spa', 'written after the wipe');
		const data = await revert(run);
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:written after the wipe']);
		// The target is neither missing nor foreign (no rebirth since): the
		// frame comes back onto it; the target itself is what is reported.
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([`${SMAIN}#1->${role}`]);
		expect(data.skipped).toEqual([
			{
				reason: 'cascade_delete_not_reverted',
				section_tipo: SECTION,
				tipo: SECTION,
				section_id: role,
			},
		]);
	});
});

describe('generations and cascade targets across reverts (review 2026-09-27)', () => {
	test('run A creates N, N is deleted, run B re-creates N with the SAME values: reverting A leaves B’s record intact', async () => {
		const other = await rec();
		await setText(other, 'lg-spa', 'pre');
		const runA = await mint();
		const n = await rec(runA);
		await setText(n, 'lg-spa', 'imported', { bulk: runA });
		await setText(other, 'lg-spa', 'by A', { bulk: runA });
		await deleteSectionRecord(SECTION, n, USER_ID);
		// The same CSV imported again, with its section_id column (the CSV door's call).
		const runB = await mint();
		await createSectionRecord(SECTION, USER_ID, laterBirth(), n, {
			conflictTolerant: true,
			bulkProcessId: runB,
		});
		await setText(n, 'lg-spa', 'imported', { bulk: runB });
		const a = await revert(runA);
		expect(texts(await stored(n, 'string', TEXT))).toEqual(['lg-spa:imported']);
		expect(texts(await stored(other, 'string', TEXT))).toEqual(['lg-spa:pre']);
		expect(a).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
		// B's own revert is untouched by A's: its record, born in B alone, goes.
		const b = await revert(runB);
		expect(await stored(n, 'string', TEXT)).toBe('NO-RECORD');
		expect(b).toMatchObject({ exact: 'full', skipped: [] });
	});

	test('a target that refused one unit refuses EVERY unit re-linking it — no locator onto a foreign record', async () => {
		const owner = await rec();
		// Two units re-link it: host's slot, and owner's portal — both linked in the run.
		const { host, target, revertId } = await revertDeletedTarget({
			text: null,
			link: async (target, run) => {
				await insertLocator(owner, TPORTAL, target, run);
			},
		});
		expect(targetsOf(await stored(owner, 'relation', TPORTAL))).toEqual([]);
		await createSectionRecord(SECTION, USER_ID, laterBirth(), target);
		await setText(target, 'lg-spa', 'a new record here');
		const data = await revert(revertId);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:a new record here']);
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([]);
		expect(targetsOf(await stored(owner, 'relation', TPORTAL))).toEqual([]);
		expect(reasons(data)).toEqual(['cascade_delete_not_reverted', 'cascade_delete_not_reverted']);
		expect(data.counter).toBe(0);
	});

	test('a cascade target re-created by a BULK run at its explicit id (a new epoch) still refuses the unit re-linking it', async () => {
		const { host, target, revertId } = await revertDeletedTarget({ text: null });
		const reimport = await mint();
		await createSectionRecord(SECTION, USER_ID, laterBirth(), target, {
			conflictTolerant: true,
			bulkProcessId: reimport,
		});
		await setText(target, 'lg-spa', 'imported again', { bulk: reimport });
		const data = await revert(revertId);
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([]);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:imported again']);
		expect(data.skipped).toEqual([
			{
				reason: 'cascade_delete_not_reverted',
				section_tipo: SECTION,
				// the unit is the MAIN's composed unit (its frames ride its rows)
				tipo: HMAIN,
				section_id: host,
			},
		]);
	});

	test('a SECOND revert of a run whose cascade target is back: unchanged, full — no cascade_undelete, no refusal', async () => {
		// text: null — the target carries no key of its own run. (With one, D2's
		// role-4 snapshot is taken AFTER the revert cleared that key, so once the
		// key's own unit writes it back the row differs from the snapshot and a
		// repeat revert reports it `kept` — an open revert defect, ledgered in
		// rewrite/LEDGER.md 2026-09-29, not pinned here.)
		const { host, target, revertId } = await revertDeletedTarget({ text: null });
		expect((await revert(revertId)).inexact.map((entry) => entry.basis)).toEqual([
			'cascade_undelete',
		]);
		const again = await revert(revertId);
		expect(again).toMatchObject({ counter: 0, exact: 'full', skipped: [], inexact: [] });
		expect(again.unchanged).toBeGreaterThan(0);
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([`${HMAIN}#1->${target}`]);
	});

	test('a SECOND revert of a run whose cascade target CARRIES run keys: unchanged, full — the keys its own units put back are not "written since"', async () => {
		// D2's snapshot is taken AFTER the revert cleared the target's run keys;
		// the revert of that revert undeletes the row, then the target's OWN units
		// write the keys back. A repeat revert must judge the record against the
		// state the revert produces (snapshot + its own units' restore images),
		// not the bare snapshot — else it reports the unit's own value as a
		// foreign write (`kept`, cascade_delete_not_reverted).
		const { host, target, revertId } = await revertDeletedTarget();
		// FLOOR: the snapshot lacks the text the units restore
		const twin = (await runRowsOf(SECTION, target, revertId)).find((row) => row.tm_role === 4);
		expect(JSON.stringify(twin?.data)).not.toContain('role record');
		const first = await revert(revertId);
		expect(first.inexact.map((entry) => entry.basis)).toEqual(['cascade_undelete']);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:role record']);
		const again = await revert(revertId);
		expect(again).toMatchObject({ counter: 0, exact: 'full', skipped: [], inexact: [] });
		expect(again.unchanged).toBeGreaterThan(0);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:role record']);
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([`${HMAIN}#1->${target}`]);
	});

	test('a SECOND revert of a run whose cascade target carries its OWN framed main: the slot frames its units restore are not "written since"', async () => {
		// The composed branch of producedStateOf: the target's own main (MAIN, a
		// portal with dataframe slot SLOT) was written by the run with a frame.
		// Its composed unit restores main + frames; the snapshot holds neither,
		// so the slot is judged against the produced state, not the bare snapshot.
		const [linked, frameTarget] = [await rec(), await rec()];
		const { target, revertId } = await revertDeletedTarget({
			text: null,
			link: async (born, run) => {
				const item = await insertLocator(born, MAIN, linked, run);
				await insertFrame(born, SLOT, MAIN, item, frameTarget, run);
			},
		});
		const first = await revert(revertId);
		expect(first.skipped).toEqual([]);
		// FLOOR: the target's own main and its frame are back
		expect(targetsOf(await stored(target, 'relation', MAIN))).toEqual([linked]);
		expect(framePairs(await stored(target, 'relation', SLOT)).length).toBe(1);
		const again = await revert(revertId);
		expect(again).toMatchObject({ counter: 0, exact: 'full', skipped: [], inexact: [] });
		expect(framePairs(await stored(target, 'relation', SLOT)).length).toBe(1);
	});

	test('a second revert after a curator EDITED a run key of the undeleted target: the edit survives, reported at the record AND the key', async () => {
		// The positive control of the test above: a value that is neither the
		// snapshot's nor the one the revert's own units produce IS a later write —
		// the record is `kept` (cascade_delete_not_reverted) and the key's unit
		// refuses it (changed_since_run).
		const { target, revertId } = await revertDeletedTarget();
		await revert(revertId);
		await setText(target, 'lg-spa', 'edited after the undelete');
		const again = await revert(revertId);
		expect(texts(await stored(target, 'string', TEXT))).toEqual([
			'lg-spa:edited after the undelete',
		]);
		expect(reasons(again)).toEqual(['cascade_delete_not_reverted', 'changed_since_run'].sort());
	});

	test('a repeat revert after a curator added ANOTHER LANGUAGE to a run key of the undeleted target: a write since, never settled', async () => {
		// The unit of the run's lane (lg-spa) is unchanged here, so only the
		// per-lane PRODUCED value catches the curator's lg-eng: the revert does
		// not produce it, so the record is kept (cascade_delete_not_reverted).
		const { target, revertId } = await revertDeletedTarget();
		await revert(revertId);
		await setText(target, 'lg-eng', 'curator eng');
		const again = await revert(revertId);
		expect(reasons(again)).toEqual(['cascade_delete_not_reverted']);
		expect(texts(await stored(target, 'string', TEXT)).sort()).toEqual(
			['lg-eng:curator eng', 'lg-spa:role record'].sort(),
		);
	});

	test('SOFT, a run key whose PRE-RUN value was EMPTY: a repeat revert is unchanged, full (a run key emptied by its unit is not "wiped")', async () => {
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await setText(role, 'lg-spa', 'written by the run', { bulk: run });
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: the wipe snapshot holds the run's value
		const twin = (await runRowsOf(SECTION, role, run)).find((row) => row.tm_role === 4);
		expect(JSON.stringify(twin?.data)).toContain('written by the run');
		const first = await revert(run);
		expect(first.skipped).toEqual([]);
		expect(texts(await stored(role, 'string', TEXT))).toEqual([]);
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([`${SMAIN}#1->${role}`]);
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, exact: 'full', skipped: [], inexact: [] });
		expect(texts(await stored(role, 'string', TEXT))).toEqual([]);
	});

	test('SOFT, an UNSLICED run key whose pre-run value was a stored `[]`: restored to `[]`, exact — and a repeat is unchanged, full', async () => {
		// An unsliced `[]` is a PRESENT key (lang_region.ts). The wipe removed it:
		// absent live must NOT read as "already at the produced `[]`" — the unit's
		// own law is strict (planExactKey), so a lenient judgement would skip the
		// put-back and the unit would refuse it (changed_since_run).
		const host = await rec();
		const [t1, role, linked] = [await rec(), await rec(), await rec()];
		await seed(role, 'relation', TPORTAL, []);
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await insertLocator(role, TPORTAL, linked, run);
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: the wipe removed the key, and the pre-run value really was a stored []
		expect(await stored(role, 'relation', TPORTAL)).toBeUndefined();
		const first = await revert(run);
		expect(first.skipped).toEqual([]);
		expect(await stored(role, 'relation', TPORTAL)).toEqual([]);
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, exact: 'full', skipped: [], inexact: [] });
		expect(await stored(role, 'relation', TPORTAL)).toEqual([]);
	});

	test('SOFT, a COMPOSED main of the target, empty before the run: the run framed an item, the cascade wiped it — a repeat revert is unchanged, full', async () => {
		// The composed twin of the pre-run-empty tests: the produced main is the
		// earliest BEFORE (empty) and the produced slot is emptied — the unit's
		// own equalities (sameMain, slotWrite's "empty stays empty") must judge
		// absent and [] alike, or the repeat reads a write since.
		const host = await rec();
		const [t1, role, linked, frameTarget] = [await rec(), await rec(), await rec(), await rec()];
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		const item = await insertLocator(role, MAIN, linked, run);
		await insertFrame(role, SLOT, MAIN, item, frameTarget, run);
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: the wipe emptied the target's main and slot, and the run's value is in the snapshot
		expect(targetsOf(await stored(role, 'relation', MAIN))).toEqual([]);
		const twin = (await runRowsOf(SECTION, role, run)).find((row) => row.tm_role === 4);
		expect(JSON.stringify(twin?.data)).toContain(String(frameTarget));
		const first = await revert(run);
		expect(first.skipped).toEqual([]);
		expect(targetsOf(await stored(role, 'relation', MAIN))).toEqual([]);
		expect(framePairs(await stored(role, 'relation', SLOT))).toEqual([]);
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, exact: 'full', skipped: [], inexact: [] });
	});

	test('SOFT, a COMPOSED main stored as `[]` before the run, absent after the wipe: already at the produced state — no put-back, no cascade_undelete', async () => {
		// A composed main's `[]` and absence are one state to its unit (sameMain,
		// planPart), and an emptied slot is absent (slotWrite). The judgement uses
		// the SAME equalities: a strict one would put the wiped snapshot back and
		// have the unit revert it again (a spurious write + cascade_undelete).
		const host = await rec();
		const [t1, role, linked, frameTarget] = [await rec(), await rec(), await rec(), await rec()];
		await seed(role, 'relation', MAIN, []);
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		const item = await insertLocator(role, MAIN, linked, run);
		await insertFrame(role, SLOT, MAIN, item, frameTarget, run);
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: the wipe left the main and the slot absent
		expect(await stored(role, 'relation', MAIN)).toBeUndefined();
		expect(await stored(role, 'relation', SLOT)).toBeUndefined();
		// …and another writer (a legacy path, a repair) stores the empty slot as
		// `[]` — to slotWrite an empty slot is empty, whatever its shape
		await seed(role, 'relation', SLOT, []);
		const first = await revert(run);
		expect(first.skipped).toEqual([]);
		expect(first.inexact).toEqual([]);
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([`${SMAIN}#1->${role}`]);
		expect(targetsOf(await stored(role, 'relation', MAIN))).toEqual([]);
	});

	test('SOFT, a curator wrote ANOTHER LANGUAGE of a run-written key after the wipe: a write since — the record is kept, never "present"', async () => {
		// A FIRST-PASS control: the record is not settled, so nothing hides the
		// conflict. (The per-LANE law itself is discriminated by the repeat-pass
		// twin 'a repeat revert after a curator added ANOTHER LANGUAGE…', where
		// the run's own lane IS at its produced value.)
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'pre-run');
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await setText(role, 'lg-spa', 'written by the run', { bulk: run });
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: the wipe emptied the key; only the curator's lg-eng is live
		expect(texts(await stored(role, 'string', TEXT))).toEqual([]);
		await setText(role, 'lg-eng', 'curator eng');
		const first = await revert(run);
		// kept at the record; the run's lg-spa lane (wiped, not at its last after)
		// is refused by its own unit — the curator's lg-eng is never overwritten
		expect(reasons(first)).toEqual(['cascade_delete_not_reverted', 'changed_since_run'].sort());
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-eng:curator eng']);
	});

	test('SOFT: a run that wrote a key on a frame target and then wiped it — a repeat revert is unchanged, full', async () => {
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'pre-run');
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await setText(role, 'lg-spa', 'written by the run', { bulk: run });
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		// FLOOR: wiped, row kept
		expect(await stored(role, 'data', 'section_id')).not.toBe('NO-RECORD');
		expect(texts(await stored(role, 'string', TEXT))).toEqual([]);
		const first = await revert(run);
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:pre-run']);
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([`${SMAIN}#1->${role}`]);
		expect(first.skipped).toEqual([]);
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, exact: 'full', skipped: [], inexact: [] });
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:pre-run']);
	});

	test('a second revert after a curator EDITED the undeleted target: the unit is not refused, the edit survives', async () => {
		const { host, target, revertId } = await revertDeletedTarget({ text: null });
		await revert(revertId);
		expect(await stored(target, 'data', 'section_id')).not.toBe('NO-RECORD'); // FLOOR: back
		await setText(target, 'lg-spa', 'edited after the undelete');
		const again = await revert(revertId);
		expect(texts(await stored(target, 'string', TEXT))).toEqual([
			'lg-spa:edited after the undelete',
		]);
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([`${HMAIN}#1->${target}`]);
		// The referencing unit ran (its keys already at their pre-run value);
		// only the target is reported — at the record, never at the unit.
		expect(again.unchanged).toBeGreaterThan(0);
		expect(again.skipped).toEqual([
			{
				reason: 'cascade_delete_not_reverted',
				section_tipo: SECTION,
				tipo: SECTION,
				section_id: target,
			},
		]);
	});

	test('reborn with the SAME created_date + created_by_user_id: still foreign (the epoch decides, not the forgeable birth stamp)', async () => {
		// A CSV re-import with its section_id AND dd199/dd200 columns recreates a
		// record whose birth stamp equals the dead one's. The dead snapshot's
		// values must not be poured into it, nor the frame restored onto it.
		const birth = new Date('2026-01-02T03:04:05.000Z');
		const { host, target, revertId } = await revertDeletedTarget({
			text: 'the dead record',
			birth,
		});
		await createSectionRecord(SECTION, USER_ID, birth, target);
		const data = await revert(revertId);
		expect(await stored(target, 'string', TEXT)).toBeUndefined();
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([]);
		expect(data.skipped).toEqual([
			{
				reason: 'cascade_delete_not_reverted',
				section_tipo: SECTION,
				// the unit is the MAIN's composed unit (its frames ride its rows)
				tipo: HMAIN,
				section_id: host,
			},
		]);
	});

	test('a deleted snapshot WITH values, its address reborn with the SAME birth stamp: nothing is poured into the new record', async () => {
		// Companion of the test above. There the snapshot holds no values (the
		// revert cleared the run's keys before D2), so the re-linking unit is
		// what gets refused. Here the snapshot carries text, via the delete door
		// under a bulk id, and nothing re-links the record: the standalone undelete
		// must refuse the reborn address rather than restore the old values into it.
		const birth = new Date('2026-01-02T03:04:05.000Z');
		const target = await createSectionRecord(SECTION, USER_ID, birth);
		await setText(target, 'lg-spa', 'the dead record');
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, target, USER_ID, undefined, { bulkProcessId: id }))
				.removed,
		).toBe(true);
		// FLOOR: the snapshot under the run carries the text
		const twin = (await runRowsOf(SECTION, target, id)).find((row) => row.tm_role === 4);
		expect(JSON.stringify(twin?.data)).toContain('the dead record');
		await createSectionRecord(SECTION, USER_ID, birth, target);
		const data = await revert(id);
		expect(await stored(target, 'string', TEXT)).toBeUndefined();
		// Located: the row at the address was there, and its scope judged (SEC-16).
		expect(data.skipped).toEqual([
			{
				reason: 'cascade_delete_not_reverted',
				section_tipo: SECTION,
				tipo: SECTION,
				section_id: target,
			},
		]);
	});

	test('SOFT-wiped target whose created_date was REWRITTEN since (a CSV dd199 column): the same record, restored', async () => {
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'role record');
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		await seed(role, 'data', 'created_date', '2001-01-01 00:00:00');
		const data = await revert(run);
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:role record']);
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([`${SMAIN}#1->${role}`]);
		expect(data.skipped).toEqual([]);
	});
});

describe('the propagate region on a translatable, UNSLICED model (M2)', () => {
	test('replace writes the WHOLE key (every language’s locators) and the revert restores the whole key', async () => {
		const [a, b, c] = [await rec(), await rec(), await rec()];
		const id = await rec();
		const pre = [
			{ ...locator(1, a, TPORTAL), lang: 'lg-spa' },
			{ ...locator(2, b, TPORTAL), lang: 'lg-eng' },
		];
		await seed(id, 'relation', TPORTAL, pre);
		const loaded = await getLoadedTool('tool_propagate_component_data');
		const handler = mustGet(
			loaded?.module.apiActions.propagate_component_data,
			'propagate',
		).handler;
		const response = await handler(
			await context({
				section_tipo: SECTION,
				component_tipo: TPORTAL,
				action: 'replace',
				lang: 'lg-spa',
				total: 1,
				propagate_data_value: [{ type: 'dd151', section_tipo: SECTION, section_id: String(c) }],
				sqo: {
					section_tipo: [SECTION],
					filter_by_locators: [{ section_tipo: SECTION, section_id: String(id) }],
				},
			}),
		);
		const run = (response.data as { bulk_process_id: number }).bulk_process_id;
		minted.push(run);
		// PINNED (M2, WC-2026-09-27-bulk-revert-undo-log): the region of an
		// unsliced model is the whole key — the eng locator is replaced too.
		expect(targetsOf(await stored(id, 'relation', TPORTAL))).toEqual([c]);
		// …and its pair is ONE lg-nolan pair, never tagged with the request lang.
		const tags = (await sql.unsafe(
			'SELECT lang FROM matrix_time_machine WHERE bulk_process_id = $1 AND tipo = $2',
			[run, TPORTAL],
		)) as { lang: string }[];
		expect(tags.map((row) => row.lang)).toEqual(['lg-nolan', 'lg-nolan']);
		const data = await revert(run);
		expect(await stored(id, 'relation', TPORTAL)).toEqual(pre);
		expect(data.exact).toBe('full');
	});
});

// ================================================================ legacy runs (§2.6)

describe('LEGACY runs — made before the undo log (§2.6)', () => {
	let run = 0;
	let born = 0;
	let olderBornless = 0;

	beforeAll(async () => {
		olderBornless = await rec();
		// created_date has one-second resolution: the run must be strictly later
		await new Promise((resolve) => setTimeout(resolve, 1100));
		run = await mint();
		born = await rec();
	}, 30_000);

	test('born in the run vs not: blank the born record’s key (inexact), refuse the older one (no_pre_batch_state)', async () => {
		for (const id of [olderBornless, born]) {
			await seed(id, 'string', TEXT, [{ id: 1, lang: 'lg-spa', value: 'batch' }]);
			await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: id,
				tipo: TEXT,
				lang: 'lg-spa',
				bulkId: run,
				data: [{ id: 1, lang: 'lg-spa', value: 'batch' }],
			});
		}
		const data = await revert(run);
		expect(await stored(born, 'string', TEXT)).toBeUndefined();
		expect(texts(await stored(olderBornless, 'string', TEXT))).toEqual(['lg-spa:batch']);
		expect(data.skipped).toEqual([
			{
				reason: 'no_pre_batch_state',
				section_tipo: SECTION,
				tipo: TEXT,
				section_id: olderBornless,
				lang: 'lg-spa',
			},
		]);
		expect(data.inexact).toEqual([
			{
				basis: 'legacy_born_in_run',
				section_tipo: SECTION,
				section_id: born,
				tipo: TEXT,
				lang: 'lg-spa',
			},
		]);
		expect(data.exact).toBe('none');
	});

	test('a run written TODAY with its undo log stripped takes the legacy path, inexact — and the revert itself is exact', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const legacy = await mint();
		await setText(id, 'lg-spa', 'batch', { bulk: legacy });
		expect(await demoteToLegacyRun(legacy)).toBe(1);
		const data = await revert(legacy);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:pre']);
		expect(data.inexact.map((entry) => entry.basis)).toEqual(['legacy_inference']);
		// the revert wrote a real pair: undoing it is exact
		const back = await revert(data.bulk_process_id);
		expect(back.exact).toBe('full');
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:batch']);
	});

	test('legacy conflict: a key changed after the legacy run is refused (changed_since_run)', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const legacy = await mint();
		await setText(id, 'lg-spa', 'batch', { bulk: legacy });
		await demoteToLegacyRun(legacy);
		await setText(id, 'lg-spa', 'edited later');
		const data = await revert(legacy);
		expect(reasons(data)).toEqual(['changed_since_run']);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:edited later']);
	});

	test('the pre-run row is the one older than the run’s EARLIEST row, never an interleaved row', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const legacy = await mint();
		await setText(id, 'lg-spa', 'run-1', { bulk: legacy });
		await setText(id, 'lg-spa', 'interleaved'); // visible, not the run's
		await setText(id, 'lg-spa', 'run-2', { bulk: legacy });
		await demoteToLegacyRun(legacy);
		await revert(legacy);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:pre']);
	});
});

describe('LEGACY per-language history (catalogue wt:1419, wt:1559 second case, wt:1633)', () => {
	/** A legacy history row + the matching live value, in insertion (= id) order. */
	async function history(
		id: number,
		rows: {
			lang: string | null;
			data: unknown;
			bulk?: number;
			timestamp?: string;
			tipo?: string;
		}[],
	) {
		for (const row of rows) {
			await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: id,
				tipo: row.tipo ?? TEXT,
				lang: row.lang,
				bulkId: row.bulk ?? null,
				data: row.data,
				timestamp: row.timestamp,
			});
		}
	}

	test('an older eng-TAGGED all-language row never puts a stale spa value back', async () => {
		const id = await rec();
		const run = await mint();
		await history(id, [
			{
				lang: 'lg-eng',
				data: [
					{ id: 1, lang: 'lg-eng', value: 'E' },
					{ id: 1, lang: 'lg-spa', value: 'STALE' },
				],
			},
			{ lang: 'lg-spa', data: [{ id: 1, lang: 'lg-spa', value: 'GOOD' }] },
			{ lang: 'lg-spa', data: [{ id: 1, lang: 'lg-spa', value: 'RUN' }], bulk: run },
		]);
		await seed(id, 'string', TEXT, [
			{ id: 1, lang: 'lg-eng', value: 'E' },
			{ id: 1, lang: 'lg-spa', value: 'RUN' },
		]);
		await revert(run);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-eng:E', 'lg-spa:GOOD']);
	});

	test('a language recorded only inside ANOTHER-tagged row (duplicate backfill) is restored, not blanked', async () => {
		const id = await rec();
		const run = await mint();
		await history(id, [
			{
				lang: 'lg-eng',
				data: [
					{ id: 1, lang: 'lg-eng', value: 'E' },
					{ id: 1, lang: 'lg-spa', value: 'S0' },
				],
			},
			{ lang: 'lg-spa', data: [{ id: 1, lang: 'lg-spa', value: 'RUN' }], bulk: run },
		]);
		await seed(id, 'string', TEXT, [
			{ id: 1, lang: 'lg-eng', value: 'E' },
			{ id: 1, lang: 'lg-spa', value: 'RUN' },
		]);
		await revert(run);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-eng:E', 'lg-spa:S0']);
	});

	test('an EXISTING single-tag WIPE row (data null + a null sibling) blanks the other language too', async () => {
		const id = await rec();
		const run = await mint();
		const wipeAt = '2026-01-02 03:04:05';
		await history(id, [
			{ lang: 'lg-spa', data: [{ id: 1, lang: 'lg-spa', value: 'S0' }] },
			{ lang: 'lg-eng', data: null, timestamp: wipeAt },
			{ lang: 'lg-nolan', data: null, timestamp: wipeAt, tipo: DATE },
			{ lang: 'lg-spa', data: [{ id: 1, lang: 'lg-spa', value: 'RUN' }], bulk: run },
		]);
		await seed(id, 'string', TEXT, [{ id: 1, lang: 'lg-spa', value: 'RUN' }]);
		await revert(run);
		const live = await stored(id, 'string', TEXT);
		expect(live === undefined || texts(live).length === 0).toBe(true);
	});

	test('a LONE per-language clear (spa-tagged null, no sibling) is NOT a wipe: eng is restored', async () => {
		const id = await rec();
		const run = await mint();
		await history(id, [
			{ lang: 'lg-eng', data: [{ id: 1, lang: 'lg-eng', value: 'E0' }] },
			{ lang: 'lg-spa', data: null },
			{ lang: 'lg-eng', data: [{ id: 1, lang: 'lg-eng', value: 'RUN' }], bulk: run },
		]);
		await seed(id, 'string', TEXT, [{ id: 1, lang: 'lg-eng', value: 'RUN' }]);
		await revert(run);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-eng:E0']);
	});
});

describe('LEGACY composed snapshots (catalogue wt:1878)', () => {
	test('legacy envelope frames: a PHP-era composed main row restores the main AND its frames', async () => {
		const host = await rec();
		const [t1, t2, r1, r2] = [await rec(), await rec(), await rec(), await rec()];
		const run = await mint();
		// pre-run: the PHP-era composed snapshot (main items + their frames in one row)
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: host,
			tipo: MAIN,
			lang: 'lg-nolan',
			bulkId: null,
			data: [locator(1, t1), frame(1, r1)],
		});
		const batchMain = [locator(1, t1), locator(2, t2)];
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: host,
			tipo: MAIN,
			lang: 'lg-nolan',
			bulkId: run,
			data: [...batchMain, frame(1, r1), frame(2, r2)],
		});
		await seed(host, 'relation', MAIN, batchMain);
		await seed(host, 'relation', SLOT, [frame(1, r1), frame(2, r2)]);
		const data = await revert(run);
		expect(targetsOf(await stored(host, 'relation', MAIN))).toEqual([t1]);
		expect(framePairs(await stored(host, 'relation', SLOT))).toEqual([`${MAIN}#1->${r1}`]);
		expect(data.skipped).toEqual([]);
		expect(data.inexact.map((entry) => entry.basis)).toEqual(['legacy_inference']);
	});
	test('a non-admin with the MAIN’s grant but not the SLOT’s reverting a LEGACY framed run: out_of_scope, the slot unchanged (the legacy unit gates its slots too)', async () => {
		await installAclIdentityFixture();
		try {
			const grants = [
				{ id: 50, tipo: SECTION, section_tipo: SECTION, value: 2 },
				{ id: 52, tipo: HMAIN, section_tipo: SECTION, value: 2 },
				{ id: 53, tipo: HSLOT, section_tipo: SECTION, value: 1 },
			];
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
			);
			clearAclIdentityCaches();
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			const host = await rec();
			const [t1, t2, r1, r2] = [await rec(), await rec(), await rec(), await rec()];
			const run = await mint();
			await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: host,
				tipo: HMAIN,
				lang: 'lg-nolan',
				bulkId: null,
				data: [locator(1, t1, HMAIN), frame(1, r1, HMAIN, HSLOT)],
			});
			const batchMain = [locator(1, t1, HMAIN), locator(2, t2, HMAIN)];
			const batchSlot = [frame(1, r1, HMAIN, HSLOT), frame(2, r2, HMAIN, HSLOT)];
			await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: host,
				tipo: HMAIN,
				lang: 'lg-nolan',
				bulkId: run,
				data: [...batchMain, ...batchSlot],
			});
			await seed(host, 'relation', HMAIN, batchMain);
			await seed(host, 'relation', HSLOT, batchSlot);
			// FLOOR: the record is in scope; the reader can edit the main, not the slot.
			expect(reader.isGlobalAdmin).toBe(false);
			expect(await principalCanAccessRecord(SECTION, host, reader)).toBe(true);
			const response = await toolTimeMachineBulkRevert({
				principal: reader,
				userId: ACL_NON_ADMIN_USER_ID,
				options: { bulk_process_id: run },
				background: false,
			});
			const data = response.data as RevertData;
			minted.push(data.bulk_process_id);
			expect(data.skipped.map((entry) => entry.reason)).toEqual(['out_of_scope']);
			expect(data.counter).toBe(0);
			expect(await stored(host, 'relation', HMAIN)).toEqual(batchMain);
			expect(await stored(host, 'relation', HSLOT)).toEqual(batchSlot);
		} finally {
			await removeAclIdentityFixture();
		}
	});
	test('a LEGACY frame half that would write a slot no run row names (named only by the pre-run row) needs the caller’s grant on it: out_of_scope, nothing written', async () => {
		await installAclIdentityFixture();
		try {
			const grants = [
				{ id: 50, tipo: SECTION, section_tipo: SECTION, value: 2 },
				{ id: 52, tipo: HMAIN, section_tipo: SECTION, value: 2 },
				{ id: 53, tipo: HSLOT, section_tipo: SECTION, value: 2 },
				{ id: 54, tipo: OSLOT, section_tipo: SECTION, value: 1 },
			];
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
			);
			clearAclIdentityCaches();
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			const host = await rec();
			const [t1, t2, r1] = [await rec(), await rec(), await rec()];
			const run = await mint();
			// pre-run: a frame in OSLOT (no component declares it); the run's row is silent about it
			await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: host,
				tipo: HMAIN,
				lang: 'lg-nolan',
				bulkId: null,
				data: [locator(1, t1, HMAIN), frame(1, r1, HMAIN, OSLOT)],
			});
			const batchMain = [locator(1, t1, HMAIN), locator(2, t2, HMAIN)];
			await insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: host,
				tipo: HMAIN,
				lang: 'lg-nolan',
				bulkId: run,
				data: batchMain,
			});
			await seed(host, 'relation', HMAIN, batchMain);
			expect(reader.isGlobalAdmin).toBe(false);
			expect(await principalCanAccessRecord(SECTION, host, reader)).toBe(true);
			const response = await toolTimeMachineBulkRevert({
				principal: reader,
				userId: ACL_NON_ADMIN_USER_ID,
				options: { bulk_process_id: run },
				background: false,
			});
			const data = response.data as RevertData;
			minted.push(data.bulk_process_id);
			expect(data.skipped.map((entry) => entry.reason)).toEqual(['out_of_scope']);
			expect(data.counter).toBe(0);
			expect(await stored(host, 'relation', HMAIN)).toEqual(batchMain);
			expect(await stored(host, 'relation', OSLOT)).toBeUndefined();
		} finally {
			await removeAclIdentityFixture();
		}
	});
	// (A legacy run carrying rows under the SLOT tipo — a TS-era beta CSV
	// replace — is unsupported history since 2026-09-28: tm_composed_rows_native
	// 'a SLOT row with no BEFORE' pins it `failed`.)
});

describe('preBatchLangSlice — the legacy slice rules (catalogue addendum)', () => {
	test('a lang-less item belongs to its ROW’s tag, and is stamped with it', () => {
		expect(preBatchLangSlice([{ id: 1, value: 'x' }], 'lg-spa', 'lg-spa')).toEqual({
			items: [{ id: 1, value: 'x', lang: 'lg-spa' }],
			adoptsLangless: true,
		});
	});

	test('a row tagged another language — or none — adopts nothing', () => {
		expect(preBatchLangSlice([{ id: 1, value: 'x' }], 'lg-spa', 'lg-eng')).toEqual({
			items: [],
			adoptsLangless: false,
		});
		expect(preBatchLangSlice([{ id: 1, value: 'x' }], 'lg-spa', null)).toEqual({
			items: [],
			adoptsLangless: false,
		});
	});

	test('other languages’ items never join; the language’s own are kept verbatim', () => {
		const own = { id: 1, lang: 'lg-spa', value: 's' };
		expect(
			preBatchLangSlice([own, { id: 1, lang: 'lg-eng', value: 'e' }], 'lg-spa', 'lg-eng').items,
		).toEqual([own]);
	});

	test('a non-array snapshot is the EMPTY slice', () => {
		for (const snapshot of [null, undefined, 'text', 7, { value: 'x' }]) {
			expect(preBatchLangSlice(snapshot, 'lg-spa', 'lg-spa')).toEqual({
				items: [],
				adoptsLangless: false,
			});
		}
	});
});

// ======================================================= review 2026-09-27

/** The stored key of a record in any section (`undefined` absent, 'NO-RECORD' gone). */
async function storedIn(
	section: string,
	id: number,
	column: string,
	key: string,
): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[section, id, key],
	)) as { present: boolean | null; v: unknown }[];
	if (rows.length === 0) return 'NO-RECORD';
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

/** A save in any section (the zzbru helpers are bound to SECTION). */
async function saveIn(
	section: string,
	sectionId: number,
	componentTipo: string,
	lang: string,
	changedData: unknown[],
	bulk: number | null = null,
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo,
		sectionTipo: section,
		sectionId,
		lang,
		changedData: changedData as never,
		userId: USER_ID,
		bulkProcessId: bulk,
	});
	expect(saved.ok).toBe(true);
}

/** A run's rows of one record, every role, id ASC. */
async function runRowsOf(section: string, id: number, bulk: number): Promise<RunRow[]> {
	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, tipo, lang, data, data IS NULL AS data_absent, tm_role
		 FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND bulk_process_id = $3
		 ORDER BY id ASC`,
		[section, id, bulk],
	)) as RunRow[];
	return rows.map((row) => ({
		...row,
		id: Number(row.id),
		section_id: Number(row.section_id),
		tm_role: row.tm_role === null ? null : Number(row.tm_role),
	}));
}

describe('records born in a REAL section: the birth defaults are the record’s own (D2)', () => {
	test('a born record carrying a PROJECT FILTER and a dato_default is DELETED — exact', async () => {
		const run = await mint();
		const born = await createSectionRecord(FSECTION, USER_ID, new Date(), undefined, {
			bulkProcessId: run,
		});
		// FLOOR: the INSERT carried both birth defaults — without them the case is
		// the zzbru1 one and proves nothing.
		expect(Array.isArray(await storedIn(FSECTION, born, 'relation', FILTER))).toBe(true);
		expect(texts(await storedIn(FSECTION, born, 'string', DEFAULTED))).toEqual([
			'lg-nolan:born default',
		]);
		await saveIn(
			FSECTION,
			born,
			FTEXT,
			'lg-spa',
			[{ action: 'set_data', value: [{ id: 1, lang: 'lg-spa', value: 'imported' }] }],
			run,
		);
		const data = await revert(run);
		expect(await storedIn(FSECTION, born, 'string', FTEXT)).toBe('NO-RECORD');
		expect(data).toMatchObject({ exact: 'full', skipped: [] });
	});

	test('a born record whose DEFAULT someone changed after the run is KEPT', async () => {
		const run = await mint();
		const born = await createSectionRecord(FSECTION, USER_ID, new Date(), undefined, {
			bulkProcessId: run,
		});
		await saveIn(
			FSECTION,
			born,
			FTEXT,
			'lg-spa',
			[{ action: 'set_data', value: [{ id: 1, lang: 'lg-spa', value: 'imported' }] }],
			run,
		);
		await saveIn(FSECTION, born, DEFAULTED, 'lg-nolan', [
			{ action: 'set_data', value: [{ id: 1, lang: 'lg-nolan', value: 'a curator’s value' }] },
		]);
		const data = await revert(run);
		expect(texts(await storedIn(FSECTION, born, 'string', DEFAULTED))).toEqual([
			'lg-nolan:a curator’s value',
		]);
		expect(reasons(data)).toEqual(['created_record_kept']);
	});
});

describe('the revert’s own record deletes and undeletes are revertible (D2/D3)', () => {
	test('reverting the revert of an undelete deletes the target again', async () => {
		const { host, target, revertId } = await revertDeletedTarget();
		const data = await revert(revertId);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:role record']);
		// The undelete is the revert's BIRTH: its revert deletes the record again
		// (the restored snapshot is its birth image, not "someone else's value").
		const back = await revert(data.bulk_process_id);
		expect(await stored(target, 'string', TEXT)).toBe('NO-RECORD');
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([]);
		expect(back.skipped).toEqual([]);
	});

	test('a born record’s delete runs under the REVERT’s bulk id: its nested (soft) cascade is revertible too', async () => {
		// deleteBornRecords over a born record that still holds a `delete_target`
		// frame AS ITS BIRTH VALUE (an undelete's birth image is the whole restored
		// snapshot, frames included): the delete door WIPES the frame target
		// through the record's own frame policy. That nested wipe must carry the
		// revert's id, or nothing can restore it.
		const run = await mint();
		const role = await rec();
		await setText(role, 'lg-spa', 'nested target');
		const born = await rec(run);
		const t1 = await rec();
		await seed(born, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(born, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const marker = mustGet(
			(await runRowsOf(SECTION, born, run)).find((row) => row.tm_role === 3),
			'birth marker',
		);
		const birthImage = marker.data as Record<string, unknown>;
		const [{ relation }] = (await sql.unsafe(
			`SELECT relation FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, born],
		)) as [{ relation: unknown }];
		const birth = { ...marker, data: { ...birthImage, relation } };
		const revertId = await mint();
		const outcomes = await deleteBornRecords(
			[{ sectionTipo: SECTION, sectionId: born, row: birth }],
			{ principal: await resolvePrincipal(USER_ID), userId: USER_ID, newBulkId: revertId },
			new Set(),
		);
		expect([...outcomes.values()]).toEqual([{ kind: 'done' }]);
		expect(await stored(born, 'relation', SMAIN)).toBe('NO-RECORD');
		// the nested target is WIPED, its row kept (no policy removes a frame target row)
		expect(await stored(role, 'string', TEXT)).toBeUndefined();
		// both carry the revert's id — the born record's delete AND the nested wipe
		const twins = (await sql.unsafe(
			`SELECT section_id FROM matrix_time_machine
			 WHERE section_tipo = $1 AND bulk_process_id = $2 AND tm_role = 4 ORDER BY section_id`,
			[SECTION, revertId],
		)) as { section_id: number }[];
		expect(twins.map((row) => Number(row.section_id)).sort()).toEqual([born, role].sort());
	});
});

describe('a cascade target another record REFERENCED (inverse references, D3)', () => {
	test('the revert puts the stripped PORTAL locator back, with the target', async () => {
		// The producer is the delete door under a bulk id. Since
		// WC-2026-09-29-dataframe-hard-delete-retired only a revert's D2 calls it
		// that way, and D2 refuses a referenced record, so the strip happens only
		// in D2's KNOWN WINDOW (bulk_revert_records.ts header): a locator committed
		// after the precondition. That race cannot be scheduled from a test, so
		// the door is driven directly on a referenced record, as D2 would drive it.
		const [role, other] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'role record');
		await seed(other, 'relation', MAIN2, [locator(1, role, MAIN2)]);
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, role, USER_ID, undefined, { bulkProcessId: id })).removed,
		).toBe(true);
		// FLOOR: the record is gone and the delete stripped the other record's locator.
		expect(await stored(role, 'string', TEXT)).toBe('NO-RECORD');
		expect(targetsOf(await stored(other, 'relation', MAIN2))).toEqual([]);
		const data = await revert(id);
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:role record']);
		expect(targetsOf(await stored(other, 'relation', MAIN2))).toEqual([role]);
		expect(data.skipped).toEqual([]);
		expect(data.inexact.map((entry) => entry.basis)).toEqual(['cascade_undelete']);
	});
});

/** A live av upload of `id`'s AV component, in a lang its data never named (another lang's build). */
function holdAvBuild(id: number): () => void {
	const av = mustGet(mediaTypeOf('component_av'), 'av spec');
	const claim = mustGet(
		mediaJobs.claimTarget(
			avIngestTarget(av, {
				componentTipo: AV,
				sectionTipo: SECTION,
				sectionId: id,
				lang: 'lg-fra',
			}),
		),
		'av upload claim',
	);
	return () => claim.release();
}

/** Run `fn` while the directory of `live` refuses new entries (a mover cannot put a file back). */
async function withLiveDirReadOnly<T>(live: string, fn: () => Promise<T>): Promise<T> {
	chmodSync(dirname(live), 0o555);
	try {
		return await fn();
	} finally {
		chmodSync(dirname(live), 0o775);
	}
}

describe('the undelete WAITS for a live av build, and reports files that did not come back (A1-01 F5)', () => {
	test('STANDALONE: a live build refuses the group BEFORE its row comes back; freed, it comes back', async () => {
		const target = await rec();
		await setText(target, 'lg-spa', 'av record');
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, target, USER_ID, undefined, { bulkProcessId: id }))
				.removed,
		).toBe(true);
		const release = holdAvBuild(target);
		try {
			const data = await revert(id);
			expect(await stored(target, 'data', 'section_id')).toBe('NO-RECORD');
			// Refused before the record's scope verdict: the reason alone (SEC-16).
			expect(data.skipped).toEqual([{ reason: 'failed' }]);
		} finally {
			release();
		}
		const back = await revert(id);
		expect(back.skipped).toEqual([]);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:av record']);
	});

	test('RE-LINKED BY A UNIT: a live build refuses the unit (failed, media.build_running) before the row comes back', async () => {
		const [target, other] = [await rec(), await rec()];
		await setText(target, 'lg-spa', 'relinked av record');
		await seed(other, 'relation', MAIN2, [locator(1, target, MAIN2)]);
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, target, USER_ID, undefined, { bulkProcessId: id }))
				.removed,
		).toBe(true);
		expect(targetsOf(await stored(other, 'relation', MAIN2))).toEqual([]);
		const release = holdAvBuild(target);
		try {
			const data = await revert(id);
			expect(await stored(target, 'data', 'section_id')).toBe('NO-RECORD');
			expect(targetsOf(await stored(other, 'relation', MAIN2))).toEqual([]);
			expect(data.skipped).toEqual([
				{
					reason: 'failed',
					section_tipo: SECTION,
					tipo: MAIN2,
					section_id: other,
					code: 'media.build_running',
				},
				// The target its refused unit would have re-linked stays deleted: counted, unlocated.
				{ reason: 'cascade_delete_not_reverted' },
			]);
		} finally {
			release();
		}
		const back = await revert(id);
		expect(back.skipped).toEqual([]);
		expect(targetsOf(await stored(other, 'relation', MAIN2))).toEqual([target]);
	});

	test('the file half moves the AV files back under the SAME hold the row half took (no self-refusal)', async () => {
		const avSpec = mustGet(mediaTypeOf('component_av'), 'av spec');
		const target = await rec();
		await setText(target, 'lg-spa', 'record with an av file');
		await seed(target, 'media', AV, [{ id: 1 }]);
		const live = buildMediaLocation(
			avSpec,
			{ componentTipo: AV, sectionTipo: SECTION, sectionId: target, lang: null },
			avSpec.defaultQuality,
			'mp4',
			await resolveMediaPathOptions(AV, SECTION, target),
		).absolutePath;
		mkdirSync(dirname(live), { recursive: true });
		writeFileSync(live, 'av-bytes');
		plantedMedia.push(live);
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, target, USER_ID, undefined, { bulkProcessId: id }))
				.removed,
		).toBe(true);
		expectMovedToDeleted(live);
		const data = await revert(id);
		expect(data.skipped).toEqual([]);
		expect(data.inexact.map((entry) => entry.basis)).toEqual(['cascade_undelete']);
		expectBackLive(live, 'av-bytes');
	});

	test('SOFT (a wiped row): its AV files come back under the SAME hold too', async () => {
		const avSpec = mustGet(mediaTypeOf('component_av'), 'av spec');
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		await setText(role, 'lg-spa', 'role record');
		await seed(role, 'media', AV, [{ id: 1 }]);
		const live = buildMediaLocation(
			avSpec,
			{ componentTipo: AV, sectionTipo: SECTION, sectionId: role, lang: null },
			avSpec.defaultQuality,
			'mp4',
			await resolveMediaPathOptions(AV, SECTION, role),
		).absolutePath;
		mkdirSync(dirname(live), { recursive: true });
		writeFileSync(live, 'soft-av-bytes');
		plantedMedia.push(live);
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		expect(await stored(role, 'media', AV)).toBeUndefined();
		expectMovedToDeleted(live);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.inexact.map((entry) => entry.basis)).not.toContain('media_not_restored');
		expectBackLive(live, 'soft-av-bytes');
	});

	test('a file the mover could not put back is REPORTED (inexact: media_not_restored), never only logged', async () => {
		const target = await rec();
		await setText(target, 'lg-spa', 'record whose file stays out');
		const live = await plantImage(target, 'stays-in-deleted');
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, target, USER_ID, undefined, { bulkProcessId: id }))
				.removed,
		).toBe(true);
		expectMovedToDeleted(live);
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		const data = await withLiveDirReadOnly(live, () => revert(id)).finally(() =>
			errors.mockRestore(),
		);
		expect(texts(await stored(target, 'string', TEXT))).toEqual([
			'lg-spa:record whose file stays out',
		]);
		expect(data.skipped).toEqual([]);
		expect(data.inexact.map((entry) => entry.basis).sort()).toEqual([
			'cascade_undelete',
			'media_not_restored',
		]);
		expect(data.inexact).toContainEqual({
			basis: 'media_not_restored',
			section_tipo: SECTION,
			section_id: target,
			tipo: SECTION,
		});
		expectMovedToDeleted(live); // still recoverable in deleted/
	});
});

describe('the HARD (missing-row) undelete brings the record’s media FILES back (P1-11/LIFE-08)', () => {
	// The delete door under a bulk id moves every media file of the record into
	// deleted/ (after its COMMIT); the undelete is its inverse, or the record
	// comes back with media keys pointing at live paths with no file. Producer:
	// the delete door under a bulk id, as above (D2's known window; the hard
	// cascade runs recorded before WC-2026-09-29-dataframe-hard-delete-retired).
	// A record BORN in a run never reaches D2 with a media key the run wrote: the
	// unit reverting that key empties it first.

	test('STANDALONE (no unit re-links it): the undelete moves the files back after its group commits', async () => {
		const target = await rec();
		await setText(target, 'lg-spa', 'standalone record');
		const live = await plantImage(target, 'standalone-image');
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, target, USER_ID, undefined, { bulkProcessId: id }))
				.removed,
		).toBe(true);
		expect(await stored(target, 'data', 'section_id')).toBe('NO-RECORD');
		expectMovedToDeleted(live);
		const data = await revert(id);
		expect(data.skipped).toEqual([]);
		expect(data.inexact.map((entry) => entry.basis)).toEqual(['cascade_undelete']);
		expect(texts(await stored(target, 'string', TEXT))).toEqual(['lg-spa:standalone record']);
		expect(await stored(target, 'media', IMAGE)).toEqual([{ id: 1 }]);
		expectBackLive(live, 'standalone-image');
	});

	test('RE-LINKED BY A UNIT (the stripped locator’s): the files come back after the unit commits', async () => {
		const [target, other] = [await rec(), await rec()];
		await setText(target, 'lg-spa', 'relinked record');
		const live = await plantImage(target, 'relinked-image');
		await seed(other, 'relation', MAIN2, [locator(1, target, MAIN2)]);
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, target, USER_ID, undefined, { bulkProcessId: id }))
				.removed,
		).toBe(true);
		// FLOOR: gone, the locator stripped under the run (the unit that re-links
		// it), and the files moved.
		expect(await stored(target, 'data', 'section_id')).toBe('NO-RECORD');
		expect(targetsOf(await stored(other, 'relation', MAIN2))).toEqual([]);
		expectMovedToDeleted(live);
		const data = await revert(id);
		expect(data.skipped).toEqual([]);
		expect(targetsOf(await stored(other, 'relation', MAIN2))).toEqual([target]);
		expect(await stored(target, 'media', IMAGE)).toEqual([{ id: 1 }]);
		expectBackLive(live, 'relinked-image');
	});
});

describe('the undelete is COUPLED to the unit that re-links it (D3)', () => {
	test('the re-linking unit is REFUSED: the target stays deleted — never an orphan', async () => {
		const { host, target, revertId } = await revertDeletedTarget({ text: null });
		// an edit to the slot after the revert: its unit refuses (changed_since_run)
		const t2 = await rec();
		await insertFrame(host, HSLOT, HMAIN, 1, t2);
		const data = await revert(revertId);
		expect(await stored(target, 'data', 'section_id')).toBe('NO-RECORD');
		expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([`${HMAIN}#1->${t2}`]);
		expect(reasons(data)).toEqual(['cascade_delete_not_reverted', 'changed_since_run']);
		expect(data.inexact).toEqual([]);
	});

	test('a NON-ADMIN reverts the revert that deleted a framed record: the missing target is authorized by its unit, and comes back', async () => {
		const { host, target, revertId } = await revertDeletedTarget({ text: null });
		await installAclIdentityFixture();
		try {
			// level 2 on the section, the main and the slot of the unit — nothing else
			// (a composed unit is gated on its main AND every slot it may write).
			const grants = [
				{ id: 50, tipo: SECTION, section_tipo: SECTION, value: 2 },
				{ id: 51, tipo: HSLOT, section_tipo: SECTION, value: 2 },
				{ id: 52, tipo: HMAIN, section_tipo: SECTION, value: 2 },
			];
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
			);
			clearAclIdentityCaches();
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			// FLOOR: the non-admin passes the unit's gate (else nothing is tested).
			expect(reader.isGlobalAdmin).toBe(false);
			expect(await principalCanAccessRecord(SECTION, host, reader)).toBe(true);
			const response = await toolTimeMachineBulkRevert({
				principal: reader,
				userId: ACL_NON_ADMIN_USER_ID,
				options: { bulk_process_id: revertId },
				background: false,
			});
			const data = response.data as RevertData;
			minted.push(data.bulk_process_id);
			expect(await stored(target, 'data', 'section_id')).not.toBe('NO-RECORD');
			expect(framePairs(await stored(host, 'relation', HSLOT))).toEqual([`${HMAIN}#1->${target}`]);
			expect(data.skipped).toEqual([]);
		} finally {
			await removeAclIdentityFixture();
		}
	});
});

describe('a MISSING cascade target refused before any record-scope check is never LOCATED (SEC-16)', () => {
	test('a NON-ADMIN reverts a run whose deleted record’s snapshot is unreadable: a coordinate-free entry', async () => {
		// The missing-row undelete judges the record's scope on the RESTORED row
		// (mayUndelete passes on the section level alone). A refusal decided
		// before that — the snapshot unusable — has judged nothing about the
		// record, so its entry carries the reason and nothing else: the bulk id
		// is enumerable and the run's rows are found without a projects filter.
		const target = await rec();
		await setText(target, 'lg-spa', 'unjudged record');
		const id = await mint();
		expect(
			(await deleteSectionRecord(SECTION, target, USER_ID, undefined, { bulkProcessId: id }))
				.removed,
		).toBe(true);
		const twin = mustGet(
			(await runRowsOf(SECTION, target, id)).find((row) => row.tm_role === 4),
			'the role-4 twin',
		);
		// The unreadable snapshot (the decoder's absent image).
		await sql.unsafe('UPDATE matrix_time_machine SET data = NULL WHERE id = $1', [twin.id]);
		await installAclIdentityFixture();
		try {
			const grants = [{ id: 50, tipo: SECTION, section_tipo: SECTION, value: 2 }];
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
			);
			clearAclIdentityCaches();
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			expect(reader.isGlobalAdmin).toBe(false);
			const response = await toolTimeMachineBulkRevert({
				principal: reader,
				userId: ACL_NON_ADMIN_USER_ID,
				options: { bulk_process_id: id },
				background: false,
			});
			expect(response.ok).toBe(true);
			const data = response.data as RevertData;
			minted.push(data.bulk_process_id);
			expect(await stored(target, 'data', 'section_id')).toBe('NO-RECORD');
			expect(data.skipped).toEqual([{ reason: 'cascade_delete_not_reverted' }]);
		} finally {
			await removeAclIdentityFixture();
		}
	});
});

describe('undo in REVERSE order (LIFO)', () => {
	test('a two-language REPLACE over a lang-less value reverts both languages — exact', async () => {
		// A lang-less orphan belongs to EVERY language's region: the spa save
		// dropped it, so the eng save's BEFORE was recorded over spa's AFTER. Only
		// eng-then-spa undoes it; spa first leaves eng's live region differing from
		// its AFTER (a false changed_since_run).
		const id = await rec();
		const pre = [{ id: 1, value: 'php era' }];
		await seed(id, 'string', TEXT, pre);
		const run = await mint();
		await setText(id, 'lg-spa', 'S', { bulk: run });
		await setText(id, 'lg-eng', 'E', { bulk: run });
		const data = await revert(run);
		expect(await stored(id, 'string', TEXT)).toEqual(pre);
		expect(data).toMatchObject({ exact: 'full', skipped: [] });
	});
});

describe('apply_value on a bulk run’s visible after-row (the region shape)', () => {
	test('an append over a lang-less value, then apply_value of its after-row: the orphan is stored ONCE', async () => {
		const id = await rec();
		await seed(id, 'string', TEXT, [
			{ id: 1, value: 'php era' },
			{ id: 2, lang: 'lg-eng', value: 'E' },
		]);
		const run = await mint();
		await save(id, TEXT, 'lg-eng', [{ action: 'insert', value: { value: 'E2' } }], { bulk: run });
		const after = (await runRowsOf(SECTION, id, run)).find(
			(row) => row.tipo === TEXT && row.tm_role === null,
		);
		// FLOOR: the after-row IS the region shape (it holds the orphan).
		expect(texts(after?.data)).toContain('∅:php era');
		await toolTimeMachineApplyValue({
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			options: {
				section_tipo: SECTION,
				section_id: id,
				tipo: TEXT,
				lang: 'lg-eng',
				matrix_id: after?.id,
			},
			background: false,
		} as never);
		const live = (await stored(id, 'string', TEXT)) as Item[];
		expect(live.filter((item) => item.value === 'php era').length).toBe(1);
		expect(texts(live)).toEqual(['lg-eng:E', 'lg-eng:E2', '∅:php era']);
	});
});

describe('the data-column TWIN of dd199 (a named exemption, re-derived)', () => {
	test('a run that rewrote dd199 AND data.created_date: the revert puts the two back in agreement', async () => {
		const id = await rec();
		const run = await mint();
		await save(
			id,
			CREATED_DATE,
			'lg-nolan',
			[
				{
					action: 'set_data',
					value: [{ id: 1, lang: 'lg-nolan', start: { year: 1998, month: 3, day: 4 } }],
				},
			],
			{ bulk: run },
		);
		await setRecordMetadata(SECTION, id, { createdDate: '1998-03-04 00:00:00' });
		const data = await revert(run);
		const restored = await stored(id, 'date', CREATED_DATE);
		const expected = metadataPatchFromAuditValue(CREATED_DATE, restored).createdDate;
		// FLOOR: the restored dd199 implies a twin, and it is not the imported one.
		expect(expected).toBeDefined();
		expect(expected).not.toBe('1998-03-04 00:00:00');
		const twin = (await stored(id, 'data', 'created_date')) as string;
		expect(twin).toBe(expected as string);
		expect(data.inexact).toContainEqual({
			basis: 'metadata_twin',
			section_tipo: SECTION,
			section_id: id,
			tipo: CREATED_DATE,
		});
	});
});

describe('the report counts `unchanged` in KEYS (WC §5)', () => {
	test('a composed unit with one LANGUAGE already at its pre-run value: counter 1, unchanged 1', async () => {
		const id = await rec();
		await setLText(id, 'lg-spa', 'pre spa');
		await setLText(id, 'lg-eng', 'pre eng');
		const run = await mint();
		await setLText(id, 'lg-spa', 'run spa', run);
		await setLText(id, 'lg-eng', 'run eng', run);
		// the curator put spa back by hand
		await setLText(id, 'lg-spa', 'pre spa');
		const data = await revert(run);
		expect(texts(await stored(id, 'string', LMAIN))).toEqual(['lg-eng:pre eng', 'lg-spa:pre spa']);
		expect(data).toMatchObject({ counter: 1, unchanged: 1, skipped: [], exact: 'full' });
	});

	test('a composed unit whose FRAMES are back but whose main is not: one unit written, nothing unchanged', async () => {
		// N/A as the pre-amendment "main+slot, one key each": the frames are no
		// key of their own, they ride the main's unit.
		const host = await rec();
		const [t1, t2, r2] = [await rec(), await rec(), await rec()];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		const run = await mint();
		const item2 = await insertLocator(host, MAIN, t2, run);
		await insertFrame(host, SLOT, MAIN, item2, r2, run);
		// the curator put the SLOT back by hand (no frames, as before the run)
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = relation - $3::text WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, host, SLOT],
		);
		const data = await revert(run);
		expect(targetsOf(await stored(host, 'relation', MAIN))).toEqual([t1]);
		expect(data).toMatchObject({ counter: 1, unchanged: 0, skipped: [] });
	});
});

// ======================================================= review 2026-09-27 (2)

describe('a run that wrote the MODIFIED stamps itself (a CSV import carrying dd201)', () => {
	test('revert and revert-of-revert are both EXACT: the revert never re-stamps a stamp the run owns', async () => {
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const preStamp = await stored(id, 'date', MODIFIED_DATE);
		const preText = await stored(id, 'string', TEXT);
		const run = await mint();
		// The importer's row shape: every save of the row with the stamp
		// SUPPRESSED (import_csv_execute carriesModifiedMetadata), dd201 first.
		const csvSave = async (tipo: string, lang: string, value: unknown[]) => {
			const saved = await saveComponentData({
				componentTipo: tipo,
				sectionTipo: SECTION,
				sectionId: id,
				lang,
				changedData: [{ action: 'set_data', value }] as never,
				userId: USER_ID,
				bulkProcessId: run,
				skipModifiedStamp: true,
			});
			expect(saved.ok).toBe(true);
		};
		await csvSave(MODIFIED_DATE, 'lg-nolan', [
			{ id: 1, lang: 'lg-nolan', start: { year: 1999, month: 1, day: 2 } },
		]);
		await csvSave(TEXT, 'lg-spa', [{ id: 1, lang: 'lg-spa', value: 'imported' }]);
		const imported = await stored(id, 'date', MODIFIED_DATE);
		// FLOOR: the run really changed the stamp (else nothing is tested).
		expect(JSON.stringify(imported)).not.toBe(JSON.stringify(preStamp));
		const back = await revert(run);
		expect(back).toMatchObject({ exact: 'full', skipped: [] });
		expect(await stored(id, 'date', MODIFIED_DATE)).toEqual(preStamp);
		expect(await stored(id, 'string', TEXT)).toEqual(preText);
		const again = await revert(back.bulk_process_id);
		expect(again).toMatchObject({ exact: 'full', skipped: [] });
		expect(await stored(id, 'date', MODIFIED_DATE)).toEqual(imported);
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:imported']);
	});

	test('NAMED EXEMPTION (WC §2): an ordinary run’s chokepoint restamp has NO pair — the revert is the latest modification', async () => {
		// The stamp is record metadata, not undo-logged: no role-1 row carries
		// dd197/dd201, and after the revert they are NOT the pre-run stamps.
		const id = await rec();
		await setText(id, 'lg-spa', 'pre');
		const oldStamp = [{ id: 1, lang: 'lg-nolan', start: { year: 1999, month: 1, day: 2 } }];
		await seed(id, 'date', MODIFIED_DATE, oldStamp);
		const run = await mint();
		await setText(id, 'lg-spa', 'run', { bulk: run });
		const back = await revert(run);
		expect(back).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
		expect(texts(await stored(id, 'string', TEXT))).toEqual(['lg-spa:pre']);
		const stamp = await stored(id, 'date', MODIFIED_DATE);
		expect(stamp).toBeDefined();
		expect(stamp).not.toEqual(oldStamp);
		const pairs = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo IN ('dd197', 'dd201') AND tm_role = 1`,
			[SECTION, id],
		)) as { n: number }[];
		expect(pairs[0]?.n).toBe(0);
	});
});

describe('a SOFT cascade restore of a key holding ORPHANS and two languages', () => {
	test('the restore, and the revert of the restore, are both clean — the pairs chain like sequential saves', async () => {
		const host = await rec();
		const [t1, role] = [await rec(), await rec()];
		const pre = [
			{ id: 1, value: 'php era' },
			{ id: 2, lang: 'lg-spa', value: 'S' },
			{ id: 3, lang: 'lg-eng', value: 'E' },
		];
		await seed(role, 'string', TEXT, pre);
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		const wiped = await stored(role, 'string', TEXT);
		// FLOOR: the soft cascade wiped the key.
		expect(texts(wiped)).not.toEqual(texts(pre));
		const back = await revert(run);
		expect(back.skipped).toEqual([]);
		expect(texts(await stored(role, 'string', TEXT))).toEqual(texts(pre));
		const again = await revert(back.bulk_process_id);
		expect(again.skipped).toEqual([]);
		expect(await stored(role, 'string', TEXT)).toEqual(wiped);
	});
});

describe('a SOFT cascade restore is tagged with the MAIN’s own row lang (review 2026-09-28)', () => {
	/** The langs of the VISIBLE rows of `tipo` on record `id` under `bulk` (null: the wipe's, which carries none). */
	async function visibleLangs(id: number, tipo: string, bulk: number | null): Promise<string[]> {
		const rows = (await sql.unsafe(
			`SELECT lang FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3
			   AND COALESCE(bulk_process_id, 0) = $4 AND tm_role IS NULL ORDER BY id ASC`,
			[SECTION, id, tipo, bulk ?? 0],
		)) as { lang: string }[];
		return rows.map((row) => row.lang);
	}

	test('a TRANSLATABLE-flagged portal (lg-nolan) and a translatable SLICED main holding only lang-less items (its data lang): the restore row sits in the wipe’s timeline', async () => {
		const host = await rec();
		const [t1, role, other] = [await rec(), await rec(), await rec()];
		await seed(role, 'relation', TPORTAL, [locator(1, other, TPORTAL)]);
		await seed(role, 'string', TEXT, [{ id: 1, value: 'php era' }]);
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(host, 'relation', SSLOT, [{ id: 1, ...frame(1, role, SMAIN, SSLOT) }]);
		const run = await mint();
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		const back = await revert(run);
		expect(back.skipped).toEqual([]);
		expect(targetsOf(await stored(role, 'relation', TPORTAL))).toEqual([other]);
		for (const tipo of [TPORTAL, TEXT]) {
			// The wipe's visible rows (its pre-state backfill, then the wipe itself).
			const wipe = (await visibleLangs(role, tipo, null)).at(-1);
			// An unsliced main's one lane is lg-nolan (decision 2026-09-29); a
			// translatable sliced main's wipe is in its data-lang timeline.
			expect(wipe, `${tipo} wipe lang`).toBeString();
			if (tipo === TPORTAL) expect(wipe, `${tipo} wipe lang`).toBe('lg-nolan');
			else expect(wipe, `${tipo} wipe lang`).not.toBe('lg-nolan');
			expect(await visibleLangs(role, tipo, back.bulk_process_id), `${tipo} restore lang`).toEqual([
				wipe as string,
			]);
		}
	});
});

describe('D2 is not language-blind: a later TRANSLATION of a run key keeps the born record', () => {
	test('run creates B and writes title[spa]; a curator adds title[eng]; the revert keeps B and the eng translation', async () => {
		const run = await mint();
		const born = await rec(run);
		await setText(born, 'lg-spa', 'imported', { bulk: run });
		await setText(born, 'lg-eng', 'a curator’s translation');
		const data = await revert(run);
		expect(texts(await stored(born, 'string', TEXT))).toEqual(['lg-eng:a curator’s translation']);
		expect(data.skipped).toEqual([
			{ reason: 'created_record_kept', section_tipo: SECTION, tipo: SECTION, section_id: born },
		]);
	});
});

describe('the revert of a revert that DELETED a born record (D2), by a NON-ADMIN', () => {
	test('the record comes back with the run’s value: its own units undelete it and judge its scope on the restored row', async () => {
		await installAclIdentityFixture();
		try {
			const grants = [
				{ id: 60, tipo: SECTION, section_tipo: SECTION, value: 2 },
				{ id: 61, tipo: TEXT, section_tipo: SECTION, value: 2 },
			];
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
			);
			clearAclIdentityCaches();
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			const run = await mint();
			const born = await rec(run);
			await setText(born, 'lg-spa', 'imported', { bulk: run });
			// FLOOR: the non-admin can see records of this section.
			expect(reader.isGlobalAdmin).toBe(false);
			expect(await principalCanAccessRecord(SECTION, born, reader)).toBe(true);
			const first = await revert(run);
			expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
			expect(first).toMatchObject({ exact: 'full', skipped: [] });
			const response = await toolTimeMachineBulkRevert({
				principal: reader,
				userId: ACL_NON_ADMIN_USER_ID,
				options: { bulk_process_id: first.bulk_process_id },
				background: false,
			});
			const data = response.data as RevertData;
			minted.push(data.bulk_process_id);
			expect(data.skipped).toEqual([]);
			expect(texts(await stored(born, 'string', TEXT))).toEqual(['lg-spa:imported']);
		} finally {
			await removeAclIdentityFixture();
		}
	});
});

describe('a record born in the run and GONE is at its pre-run state (review 2026-09-27, round 4)', () => {
	test('a NON-ADMIN double revert of a run that created a record: {counter 0, skipped [], full} — never out_of_scope', async () => {
		await installAclIdentityFixture();
		try {
			const grants = [
				{ id: 80, tipo: SECTION, section_tipo: SECTION, value: 2 },
				{ id: 81, tipo: TEXT, section_tipo: SECTION, value: 2 },
			];
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[JSON.stringify(grants), ACL_NON_ADMIN_PROFILE_ID],
			);
			clearAclIdentityCaches();
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			expect(reader.isGlobalAdmin).toBe(false);
			const run = await mint();
			const born = await rec(run);
			await setText(born, 'lg-spa', 'imported', { bulk: run });
			// FLOOR: the non-admin sees the record while it exists.
			expect(await principalCanAccessRecord(SECTION, born, reader)).toBe(true);
			const asReader = async (): Promise<RevertData> => {
				const response = await toolTimeMachineBulkRevert({
					principal: reader,
					userId: ACL_NON_ADMIN_USER_ID,
					options: { bulk_process_id: run },
					background: false,
				});
				expect(response.ok).toBe(true);
				const data = response.data as RevertData;
				minted.push(data.bulk_process_id);
				return data;
			};
			const first = await asReader();
			expect(first).toMatchObject({ exact: 'full', skipped: [] });
			expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
			const again = await asReader();
			expect(again).toMatchObject({ counter: 0, skipped: [], inexact: [], exact: 'full' });
			expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
		} finally {
			await removeAclIdentityFixture();
		}
	});

	test('a run that CREATED a record and cascade-WIPED it, a curator then deleted it: never undeleted — first and repeat revert write nothing for it', async () => {
		// Re-pointed 2026-09-29 (WC-2026-09-29-dataframe-hard-delete-retired): a
		// run's cascade no longer removes a row, so the born record the run wiped
		// is removed by a CURATOR afterwards. The run still holds a birth (3) and
		// a cascade (4) marker for a record that is GONE — goneBornAddresses drops
		// the role-4 marker instead of undeleting it.
		const host = await rec();
		const t1 = await rec();
		await seed(host, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		const run = await mint();
		const born = await rec(run);
		await setText(born, 'lg-spa', 'imported', { bulk: run });
		await insertFrame(host, SSLOT, SMAIN, 1, born, run);
		const frames = (await stored(host, 'relation', SSLOT)) as Item[];
		const frameId = mustGet(frames[0], 'frame').id;
		// The run removes its own frame: the SOFT policy wipes the born record, row kept.
		await save(host, SSLOT, 'lg-nolan', [{ action: 'remove', id: frameId, value: null }], {
			bulk: run,
		});
		expect(await stored(born, 'string', TEXT)).not.toBe('NO-RECORD');
		// FLOOR: the run holds both markers for it — birth (3) and cascade (4).
		const roles = (await runRowsOf(SECTION, born, run)).map((row) => row.tm_role);
		expect(roles).toContain(3);
		expect(roles).toContain(4);
		// A curator deletes the wiped record, outside any run.
		expect((await deleteSectionRecord(SECTION, born, USER_ID)).removed).toBe(true);
		expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
		const rowsOfBorn = async (): Promise<number> =>
			Number(
				(
					(await sql.unsafe(
						'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
						[SECTION, born],
					)) as { n: number }[]
				)[0]?.n,
			);
		const tmBefore = await rowsOfBorn();
		const first = await revert(run);
		expect(first).toMatchObject({ exact: 'full', skipped: [], inexact: [] });
		expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
		expect(framePairs(await stored(host, 'relation', SSLOT))).toEqual([]);
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, skipped: [], inexact: [], exact: 'full' });
		expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
		// Never undeleted, never re-deleted: no new TM row for it at all.
		expect(await rowsOfBorn()).toBe(tmBefore);
	});
});

describe('a deleted record is undeleted WITH its own units, never apart', () => {
	test('a non-admin without the key’s grant: the unit is out_of_scope and the record STAYS deleted (no half-restored record)', async () => {
		await installAclIdentityFixture();
		try {
			// level 2 on the SECTION only — the delete door's level, not the key's.
			await sql.unsafe(
				`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', (misc->'dd774') || $1::text::jsonb)
				 WHERE section_tipo = 'dd234' AND section_id = $2`,
				[
					JSON.stringify([{ id: 70, tipo: SECTION, section_tipo: SECTION, value: 2 }]),
					ACL_NON_ADMIN_PROFILE_ID,
				],
			);
			clearAclIdentityCaches();
			const reader = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
			const run = await mint();
			const born = await rec(run);
			await setText(born, 'lg-spa', 'imported', { bulk: run });
			const first = await revert(run);
			expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
			const response = await toolTimeMachineBulkRevert({
				principal: reader,
				userId: ACL_NON_ADMIN_USER_ID,
				options: { bulk_process_id: first.bulk_process_id },
				background: false,
			});
			const data = response.data as RevertData;
			minted.push(data.bulk_process_id);
			expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
			expect(reasons(data)).toEqual(['cascade_delete_not_reverted', 'out_of_scope']);
		} finally {
			await removeAclIdentityFixture();
		}
	});
});

describe('the undelete of a MISSING row is one transaction, and insert-only', () => {
	/** A record a revert deleted (D2, revertDeletedTarget): the address and its role-4 marker. */
	async function hardCascade(): Promise<{ role: number; marker: RunRow }> {
		const { target, revertId } = await revertDeletedTarget();
		const marker = (await runRowsOf(SECTION, target, revertId)).find((row) => row.tm_role === 4);
		return { role: target, marker: mustGet(marker, 'cascade marker') };
	}

	test('a birth marker that fails to write rolls the restored row back — never a row without its marker', async () => {
		const { role, marker } = await hardCascade();
		const outcome = await undeleteCascadeRecord(
			{ sectionTipo: SECTION, sectionId: role, row: marker },
			// a bulk id out of the integer column's range: the marker INSERT fails
			{ principal: await resolvePrincipal(USER_ID), userId: USER_ID, newBulkId: 2 ** 40 },
		).then(
			() => 'landed',
			() => 'threw',
		);
		expect(outcome).toBe('threw');
		expect(await stored(role, 'string', TEXT)).toBe('NO-RECORD');
	});

	test('an address taken since the delete is never overwritten by the restore', async () => {
		const { role, marker } = await hardCascade();
		const table = mustGet(await getMatrixTableFromTipo(SECTION), 'table');
		await sql.unsafe(
			`INSERT INTO "${TABLE}" (section_tipo, section_id, string) VALUES ($1, $2, $3::text::jsonb)`,
			[SECTION, role, JSON.stringify({ [TEXT]: [{ id: 1, lang: 'lg-spa', value: 'squatter' }] })],
		);
		expect(table).toBe(TABLE);
		const restored = await restoreAbsentSectionRow(
			decodeTmImage(marker.data, marker.data_absent),
			marker.id,
			SECTION,
			role,
			{ userId: USER_ID },
			USER_ID,
		);
		expect(restored).toBeNull();
		expect(texts(await stored(role, 'string', TEXT))).toEqual(['lg-spa:squatter']);
	});
});

describe('a dataframe main whose SLOT the run never touched', () => {
	test('a frame added after the run to an appended item refuses the unit — never stranded on a removed id', async () => {
		const host = await rec();
		const [t1, t2, r2] = [await rec(), await rec(), await rec()];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		const run = await mint();
		const appended = await insertLocator(host, MAIN, t2, run);
		// after the run, a curator frames the appended item (the slot is not a run key)
		await insertFrame(host, SLOT, MAIN, appended, r2);
		const data = await revert(run);
		expect(targetsOf(await stored(host, 'relation', MAIN))).toEqual([t1, t2].sort());
		expect(framePairs(await stored(host, 'relation', SLOT))).toEqual([
			`${MAIN}#${appended}->${r2}`,
		]);
		expect(reasons(data)).toEqual(['changed_since_run']);
	});

	test('with no frame on the appended item the unit reverts, exact', async () => {
		const host = await rec();
		const [t1, t2] = [await rec(), await rec()];
		await seed(host, 'relation', MAIN, [locator(1, t1)]);
		const run = await mint();
		await insertLocator(host, MAIN, t2, run);
		const data = await revert(run);
		expect(targetsOf(await stored(host, 'relation', MAIN))).toEqual([t1]);
		expect(data).toMatchObject({ exact: 'full', skipped: [] });
	});
});

// ======================================== nested cascades (review finding)

describe('a NESTED cascade: a deleted record’s own frame target comes back only WITH it (D3)', () => {
	// The unit-re-linked variants ("the re-linking unit lands / is REFUSED / the
	// CHILD cannot come back") were deleted 2026-09-29: they need a ROW-DELETED
	// child under a unit-re-linked parent, and no production path deletes a frame
	// target row any more (WC-2026-09-29-dataframe-hard-delete-retired). A nested
	// child is now a SOFT wipe (a `delete_target` slot on the deleted record);
	// the group law it obeys is pinned by the two standalone cases below.

	/**
	 * born --SSLOT frame--> child. D2's door deletes `born` under the revert's id;
	 * born's own `delete_target` policy WIPES child (row kept) under the same id.
	 * child's marker is referenced by born's snapshot only — never by a unit's
	 * BEFORE image — so it travels with born.
	 */
	async function nestedSoftCascade(): Promise<{ born: number; child: number; revertId: number }> {
		const run = await mint();
		const child = await rec();
		await setText(child, 'lg-spa', 'nested target');
		const born = await rec(run);
		const t1 = await rec();
		await seed(born, 'relation', SMAIN, [locator(1, t1, SMAIN)]);
		await seed(born, 'relation', SSLOT, [{ id: 1, ...frame(1, child, SMAIN, SSLOT) }]);
		const revertId = await mint();
		await deleteSectionRecord(SECTION, born, USER_ID, undefined, { bulkProcessId: revertId });
		// FLOOR: born gone, child WIPED (row kept), both under the revert's id.
		expect(await stored(born, 'relation', SSLOT)).toBe('NO-RECORD');
		expect(await stored(child, 'data', 'section_id')).not.toBe('NO-RECORD');
		expect(await stored(child, 'string', TEXT)).toBeUndefined();
		expect((await runRowsOf(SECTION, child, revertId)).some((row) => row.tm_role === 4)).toBe(true);
		return { born, child, revertId };
	}

	test('a STANDALONE group (no unit re-links the parent) rolls back whole when the child refuses', async () => {
		const { born, child, revertId } = await nestedSoftCascade();
		// The child's address taken by ANOTHER record since: a curator deleted it and
		// a create at its explicit id opened a new epoch.
		await deleteSectionRecord(SECTION, child, USER_ID);
		await createSectionRecord(SECTION, USER_ID, laterBirth(), child);
		await setText(child, 'lg-spa', 'squatter');
		const data = await revert(revertId);
		// never the born record back with a frame onto the squatter
		expect(await stored(born, 'relation', SSLOT)).toBe('NO-RECORD');
		expect(texts(await stored(child, 'string', TEXT))).toEqual(['lg-spa:squatter']);
		expect(reasons(data)).toEqual(['cascade_delete_not_reverted', 'cascade_delete_not_reverted']);
	});

	test('a STANDALONE group lands whole: parent back, child’s wiped data back', async () => {
		const { born, child, revertId } = await nestedSoftCascade();
		const data = await revert(revertId);
		expect(framePairs(await stored(born, 'relation', SSLOT))).toEqual([`${SMAIN}#1->${child}`]);
		expect(texts(await stored(child, 'string', TEXT))).toEqual(['lg-spa:nested target']);
		expect(data.skipped).toEqual([]);
		expect(data.inexact.map((entry) => entry.section_id).sort()).toEqual([born, child].sort());
	});
});

// ================================ undelete stamps (review finding)

describe('a revert of a revert that UNDELETES a born record whose dd201 the run imported', () => {
	test('the undelete writes the snapshot VERBATIM: every stamp unit lands, the imported dd201 comes back', async () => {
		const run = await mint();
		const born = await rec(run);
		// The importer's row shape: stamp SUPPRESSED, dd201 as a column.
		const csvSave = async (tipo: string, lang: string, value: unknown[]) => {
			const saved = await saveComponentData({
				componentTipo: tipo,
				sectionTipo: SECTION,
				sectionId: born,
				lang,
				changedData: [{ action: 'set_data', value }] as never,
				userId: USER_ID,
				bulkProcessId: run,
				skipModifiedStamp: true,
			});
			expect(saved.ok).toBe(true);
		};
		await csvSave(MODIFIED_DATE, 'lg-nolan', [
			{ id: 1, lang: 'lg-nolan', start: { year: 1999, month: 1, day: 2 } },
		]);
		await csvSave(TEXT, 'lg-spa', [{ id: 1, lang: 'lg-spa', value: 'imported' }]);
		const imported = await stored(born, 'date', MODIFIED_DATE);
		const first = await revert(run);
		// FLOOR: the revert deleted the born record (D2) — else nothing is undeleted.
		expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
		expect(first.skipped).toEqual([]);
		const again = await revert(first.bulk_process_id);
		expect(again.skipped).toEqual([]);
		expect(await stored(born, 'date', MODIFIED_DATE)).toEqual(imported);
		expect(texts(await stored(born, 'string', TEXT))).toEqual(['lg-spa:imported']);
	});
});

describe('a SECOND revert of a run finds its keys at their pre-run state (review 2026-09-27, round 3)', () => {
	test('a key stored as JSON NULL: the run is reverted, and a second revert says unchanged — never changed_since_run', async () => {
		// A PHP-era key stored as JSON null — sliced (TEXT) and unsliced (TPORTAL).
		// null is ABSENCE in the undo log (lang_region.ts): the write chokepoint
		// restores it as a key removal, and the second revert reads that removal
		// as the pre-run state.
		const id = await rec();
		const target = await rec();
		await seed(id, 'string', TEXT, null);
		await seed(id, 'relation', TPORTAL, null);
		expect(await stored(id, 'string', TEXT)).toBeNull(); // FLOOR: stored JSON null
		const run = await mint();
		await setText(id, 'lg-spa', 'imported', { bulk: run });
		await insertLocator(id, TPORTAL, target, run);
		const first = await revert(run);
		expect(first).toMatchObject({ counter: 2, exact: 'full', skipped: [] });
		expect(await stored(id, 'string', TEXT)).toBeUndefined();
		expect(await stored(id, 'relation', TPORTAL)).toBeUndefined();
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, unchanged: 2, exact: 'full', skipped: [] });
	});

	test('a TWO-language run over an ABSENT sliced key: the second revert is unchanged 2, full', async () => {
		// spa's pair: B absent. eng's pair: B = "no eng item" in a key spa had
		// just created — the same pre-run state, so ONE image (undefined), or the
		// second revert compares absent with [] and refuses a key already back.
		const id = await rec();
		const run = await mint();
		await setText(id, 'lg-spa', 'spa', { bulk: run });
		await setText(id, 'lg-eng', 'eng', { bulk: run });
		const first = await revert(run);
		expect(first).toMatchObject({ exact: 'full', skipped: [] });
		expect(await stored(id, 'string', TEXT)).toBeUndefined();
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, unchanged: 2, exact: 'full', skipped: [] });
	});

	test('a run that CREATED a record: revert deletes it, a second revert is {counter 0, skipped [], full}', async () => {
		const run = await mint();
		const born = await rec(run);
		await setText(born, 'lg-spa', 'imported', { bulk: run });
		const first = await revert(run);
		expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
		expect(first).toMatchObject({ exact: 'full', skipped: [] });
		const again = await revert(run);
		expect(again).toMatchObject({ counter: 0, skipped: [], inexact: [], exact: 'full' });
		expect(await stored(born, 'string', TEXT)).toBe('NO-RECORD');
	});
});

describe('D2 under concurrency and failure (review 2026-09-27, round 3)', () => {
	test('a save committing while D2 checks a born record is NEVER deleted with it: created_record_kept', async () => {
		// A run that only CREATED the record (no unit locks it first). A curator's
		// save holds the row when the revert reaches D2: the foreign-value check
		// must run behind the delete's own lock, or it reads the pre-save row,
		// finds nothing foreign, and the delete then takes the committed save away.
		const run = await mint();
		const born = await rec(run);
		let signal: () => void = () => {};
		const locked = new Promise<void>((resolve) => {
			signal = resolve;
		});
		const curator = withTransaction(async () => {
			await save(born, DATE, 'lg-nolan', [{ action: 'insert', value: { start: { year: 1999 } } }]);
			signal();
			await Bun.sleep(700);
		});
		await locked;
		const data = await revert(run);
		await curator;
		expect(await stored(born, 'date', DATE)).not.toBe('NO-RECORD');
		expect(Array.isArray(await stored(born, 'date', DATE))).toBe(true);
		expect(reasons(data)).toEqual(['created_record_kept']);
	}, 20_000);

	test('one born record whose delete THROWS is reported failed; the others are still deleted', async () => {
		const run = await mint();
		const good = await rec(run);
		const marker = mustGet(
			(await runRowsOf(SECTION, good, run)).find((row) => row.tm_role === 3),
			'birth marker',
		);
		// A marker on a section with no matrix table: the delete door throws.
		const bad = { sectionTipo: `${TLD}999`, sectionId: good, row: marker };
		const outcomes = await deleteBornRecords(
			[bad, { sectionTipo: SECTION, sectionId: good, row: marker }],
			{ principal: await resolvePrincipal(USER_ID), userId: USER_ID, newBulkId: await mint() },
			new Set(),
		);
		expect([...outcomes.values()].map((outcome) => outcome.kind)).toEqual(['failed', 'done']);
		expect(await stored(good, 'string', TEXT)).toBe('NO-RECORD');
	});
});

// ======================================== review 2026-09-27 (composed-row findings)

describe('a frames-only revert checks PAIRING against the main it leaves, every language (review 2026-09-27)', () => {
	test('a slot pair tagged lg-nolan, a SIBLING-language item deleted after the run: refused, nothing written', async () => {
		const host = await rec();
		const target = await rec();
		const main = [
			{ id: 1, lang: 'lg-eng', value: 'eng' },
			{ id: 2, lang: 'lg-spa', value: 'spa' },
		];
		await seed(host, 'string', LMAIN, [main[0]]);
		// the spa item through a save: its history knows it (two lanes — the
		// frame lane carries no language's value, so the pairing law reads the
		// items from the language lanes' history)
		await save(host, LMAIN, 'lg-spa', [{ action: 'set_data', value: [main[1]] }]);
		await seed(host, 'relation', LSLOT, [{ id: 1, ...frame(2, target, LMAIN, LSLOT) }]);
		const run = await mint();
		await save(host, LSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		expect(framePairs(await stored(host, 'relation', LSLOT))).toEqual([]); // FLOOR
		// after the run a curator removes the spa item the frame paired with
		await save(host, LMAIN, 'lg-spa', [{ action: 'remove', id: 2, value: null }]);
		const data = await revert(run);
		expect(reasons(data)).toEqual(['changed_since_run']);
		expect(framePairs(await stored(host, 'relation', LSLOT))).toEqual([]); // no orphan frame
		expect(texts(await stored(host, 'string', LMAIN))).toEqual(['lg-eng:eng']);
	});

	test('the same run with the paired item still there reverts, exact', async () => {
		const host = await rec();
		const target = await rec();
		await seed(host, 'string', LMAIN, [
			{ id: 1, lang: 'lg-eng', value: 'eng' },
			{ id: 2, lang: 'lg-spa', value: 'spa' },
		]);
		await seed(host, 'relation', LSLOT, [{ id: 1, ...frame(2, target, LMAIN, LSLOT) }]);
		const run = await mint();
		await save(host, LSLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], { bulk: run });
		const data = await revert(run);
		expect(data).toMatchObject({ exact: 'full', skipped: [] });
		expect(framePairs(await stored(host, 'relation', LSLOT))).toEqual([`${LMAIN}#2->${target}`]);
	});
});

describe('a SHARED slot: a composed row re-links through its OWN frames only (review 2026-09-27)', () => {
	test('A saved after B’s frame to a born record, B refused: the target stays deleted, A reverts', async () => {
		const host = await rec();
		const [t1, t2, t3] = [await rec(), await rec(), await rec()];
		await seed(host, 'relation', HMAIN, [locator(1, t1, HMAIN)]);
		await seed(host, 'relation', HMAIN2, [locator(1, t2, HMAIN2)]);
		const run = await mint();
		const role = await rec(run);
		// B frames the born record in the SHARED slot; then A appends — A's composed
		// AFTER carries the FULL shared slot, B's frame → role included.
		await insertFrame(host, HSLOT, HMAIN2, 1, role, run);
		await insertLocator(host, HMAIN, t3, run);
		const first = await revert(run);
		// FLOOR: the revert took both away, and D2 deleted role under its id.
		expect(await stored(role, 'data', 'section_id')).toBe('NO-RECORD');
		expect(targetsOf(await stored(host, 'relation', HMAIN))).toEqual([t1]);
		await insertLocator(host, HMAIN2, t1); // a curator edits B after the revert: B refuses
		// The revert of the revert: A's BEFORE image references role only through
		// B's frame — never A's to re-link.
		const data = await revert(first.bulk_process_id);
		expect(targetsOf(await stored(host, 'relation', HMAIN))).toEqual([t1, t3].sort());
		expect(await stored(role, 'data', 'section_id')).toBe('NO-RECORD'); // never an orphan
		expect(data.skipped.filter((entry) => entry.tipo === HMAIN)).toEqual([]);
		expect(reasons(data)).toContain('changed_since_run');
		expect(data.counter).toBe(1);
	});
});
