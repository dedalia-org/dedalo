/**
 * ONE PROVENANCE KERNEL — the two regenerate doors (tool_update_cache
 * update_cache, tool_media_versions sync_files) restore a lost
 * `original_file_name` the SAME way (T1-P04).
 *
 * PHP: both doors called ONE function, `component_media_common::
 * regenerate_component` (v6 :2668-2705, frozen v7 :3232-3278, step 1): when
 * `data[0]` (of the request's data lang) has no `original_file_name` and the
 * component declares `properties.target_filename`, the name is read from that
 * sibling (lg-nolan), and `original_normalized_name` = `get_id() . '.' .
 * lowercase(ext)` is set when absent; `Save()` then re-scans with the repaired
 * cue. The TS doors had drifted: sync_files had NO repair, update_cache had a
 * private copy that kept the extension's case, dropped the lang suffix, wrote
 * `items[0]` whatever its lang, and applied the repair AFTER the rescan.
 *
 * LEGS (each runs BOTH doors unless stated)
 *   P1/P2 a non-translatable image recovers name + `<id>.tif` (lowercase) — and
 *         the two doors write the SAME provenance keys.
 *   P3    a translatable image: the DATA-LANG item gets the name and the
 *         lang-suffixed normalized name; the other lang's item is untouched.
 *   P4    a curator's name wins (fill-only-absent).
 *   P5    no sibling value → no `original_*` key invented.
 *   P6    sync_files on an `additional_path` component re-indexes the NAMED
 *         bucket, never wipes it from the numeric one (record-scoped path).
 *   P7    ORDER: the rescan reads the REPAIRED cue — a raw original whose
 *         extension the scanner does not manage is indexed only through it.
 *
 * SITUATION: a `zzpv` scratch section (→ matrix_test); records created at
 * runtime; files seeded under the lane's marked suite media root and swept by
 * the `zzpv` prefix. assertTestDatabase before the first write; the situation
 * drop asserts zero residue.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import { buildMediaLocation, type MediaIdentity } from '../../src/core/media/path.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { sweepSeededMediaEntries } from '../helpers/media_seed_sweep.ts';

const SECTION = 'zzpv1';
const IMAGE = 'zzpv2';
const NAME = 'zzpv3';
const IMAGE_I18N = 'zzpv4';
const IMAGE_BUCKET = 'zzpv5';
const BUCKET = 'zzpv6';
const TABLE = 'matrix_test';
const USER_ID = -1;
/** The named bucket folder — `zzpv`-prefixed so the sweep removes it whole. */
const BUCKET_NAME = 'zzpv_box_a';

const SITUATION = situation({
	tld: 'zzpv',
	name: 'media provenance repair',
	nodes: [
		{ tipo: SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: IMAGE,
			model: 'component_image',
			parent: SECTION,
			properties: { target_filename: NAME },
		},
		{ tipo: NAME, model: 'component_input_text', parent: SECTION },
		{
			tipo: IMAGE_I18N,
			model: 'component_image',
			parent: SECTION,
			is_translatable: true,
			properties: { target_filename: NAME },
		},
		{
			tipo: IMAGE_BUCKET,
			model: 'component_image',
			parent: SECTION,
			properties: { additional_path: BUCKET },
		},
		{ tipo: BUCKET, model: 'component_input_text', parent: SECTION },
	],
});

const image = mediaTypeOf('component_image')!;
/** A derived tier that is neither default, original, master nor thumb (as the lost-update gate). */
const PLAIN_QUALITY = image.qualities.find(
	(quality) =>
		quality !== image.defaultQuality &&
		quality !== image.originalQuality &&
		!image.masterQualities.includes(quality) &&
		quality !== config.media.thumb.quality,
) as string;
/** An extension the scanner does NOT manage: indexed only through the provenance cue. */
const RAW_EXTENSION = 'zzraw';

const bulkRuns: number[] = [];
let bulkTable = '';

type Item = Record<string, unknown>;

const identityOf = (componentTipo: string, sectionId: number, lang: string | null = null) =>
	({ componentTipo, sectionTipo: SECTION, sectionId, lang }) satisfies MediaIdentity;

async function seedFile(
	componentTipo: string,
	sectionId: number,
	quality: string,
	extension: string,
	lang: string | null = null,
): Promise<string> {
	const opts = await resolveMediaPathOptions(componentTipo, SECTION, sectionId);
	const path = buildMediaLocation(
		image,
		identityOf(componentTipo, sectionId, lang),
		quality,
		extension,
		opts,
	).absolutePath;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `media_provenance_repair ${sectionId}`);
	return path;
}

/** A record with `items` on `componentTipo` and `siblings` (input_text tipo → value) in the string column. */
async function record(
	componentTipo: string,
	items: Item[],
	siblings: Record<string, string> = {},
): Promise<number> {
	const id = await createSectionRecord(SECTION, USER_ID);
	const strings = Object.fromEntries(
		Object.entries(siblings).map(([tipo, value]) => [tipo, [{ id: 1, lang: 'lg-nolan', value }]]),
	);
	await sql.unsafe(
		`UPDATE "${TABLE}" SET media = jsonb_build_object($3::text, $4::text::jsonb),
		        string = $5::text::jsonb
		  WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, componentTipo, JSON.stringify(items), JSON.stringify(strings)],
	);
	return id;
}

async function storedItems(componentTipo: string, sectionId: number): Promise<Item[]> {
	const rows = (await sql.unsafe(
		`SELECT media->$3 AS items FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, componentTipo],
	)) as { items: Item[] | null }[];
	return rows[0]?.items ?? [];
}

/** The provenance keys of an item (what the two doors must agree on). */
const provenance = (item: Item | undefined): Item =>
	Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => key.startsWith('original_')));

const DATA_LANG = 'lg-spa';
const inLang = <T>(work: () => Promise<T>): Promise<T> =>
	runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: DATA_LANG }, work);

async function updateCache(componentTipo: string, sectionId: number): Promise<void> {
	const loaded = await getLoadedTool('tool_update_cache');
	const action = loaded?.module.apiActions.update_cache;
	if (action === undefined) throw new Error('tool_update_cache.update_cache is not registered');
	const response = await inLang(async () =>
		action.handler({
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			background: true,
			options: {
				section_tipo: SECTION,
				components_selection: [{ tipo: componentTipo }],
				sqo: {
					section_tipo: [SECTION],
					filter_by_locators: [{ section_tipo: SECTION, section_id: String(sectionId) }],
				},
			},
		}),
	);
	expect(response.ok).toBe(true);
	const data = response.data as { regenerated: number; bulk_process_id: number };
	bulkRuns.push(data.bulk_process_id);
	expect(data.regenerated, 'update_cache did not process the record').toBe(1);
}

async function mediaVersions(
	actionName: 'sync_files' | 'get_files_info',
	componentTipo: string,
	sectionId: number,
): Promise<unknown> {
	const loaded = await getLoadedTool('tool_media_versions');
	const action = loaded?.module.apiActions[actionName];
	if (action === undefined) throw new Error(`tool_media_versions.${actionName} is not registered`);
	const response = await inLang(async () =>
		action.handler({
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			background: false,
			options: { tipo: componentTipo, section_tipo: SECTION, section_id: sectionId },
		}),
	);
	expect(response.ok, `${actionName} failed`).toBe(true);
	return response.data;
}

const syncFiles = (componentTipo: string, sectionId: number) =>
	mediaVersions('sync_files', componentTipo, sectionId);

const DOORS = {
	update_cache: updateCache,
	sync_files: syncFiles,
} as const;

const isSeeded = (name: string): boolean => name.startsWith('zzpv');
const sweepSeededFiles = (): string[] =>
	sweepSeededMediaEntries(config.media.rootPath, image.typeFolder, isSeeded);

beforeAll(async () => {
	await assertTestDatabase('media_provenance_repair_native');
	sweepSeededFiles();
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	expect(await getModelByTipo(IMAGE)).toBe('component_image');
	expect(config.media.rootPath, 'no suite media root — the preload did not arm it').not.toBeNull();
	expect(PLAIN_QUALITY).toBeDefined();
	expect(image.managedExtensions).not.toContain(RAW_EXTENSION);
	expect(image.qualities).toContain(image.originalQuality);
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
}, 60_000);

afterAll(async () => {
	for (const id of bulkRuns) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [SECTION]);
	await sweepActivityRows(SECTION);
	await sweepActivityRows('dd800', bulkRuns);
	expect(
		(await countActivityRows(SECTION)) + (await countActivityRows('dd800', bulkRuns)),
		'activity residue after the sweep',
	).toBe(0);
	sweepSeededFiles();
	expect(await dropSituation(SITUATION), 'zzpv residue after drop').toBe(0);
}, 60_000);

describe('T1-P04 one provenance kernel behind both regenerate doors', () => {
	const recovered: Record<string, Item> = {};

	for (const [door, run] of Object.entries(DOORS)) {
		test(`P1 ${door}: a lost original_file_name is recovered from target_filename, extension lowercased`, async () => {
			const id = await record(IMAGE, [{ id: 1, files_info: [] }], { [NAME]: 'My Scan.TIF' });
			await seedFile(IMAGE, id, PLAIN_QUALITY, image.defaultExtension);
			await run(IMAGE, id);
			const item = (await storedItems(IMAGE, id))[0];
			expect(item?.original_file_name, `${door} did not recover the name`).toBe('My Scan.TIF');
			expect(item?.original_normalized_name).toBe(`${IMAGE}_${SECTION}_${id}.tif`);
			// The section_id differs per record: compare the door's shape, not the id.
			recovered[door] = {
				...provenance(item),
				original_normalized_name: String(item?.original_normalized_name).replace(`_${id}.`, '_N.'),
			};
		}, 90_000);
	}

	test('P2 door parity: update_cache and sync_files write the SAME provenance keys', () => {
		expect(recovered.update_cache).toBeDefined();
		expect(recovered.sync_files).toBeDefined();
		expect(recovered.update_cache).toEqual(recovered.sync_files as Item);
	});

	for (const [door, run] of Object.entries(DOORS)) {
		test(`P3 ${door}: a translatable image repairs the DATA-LANG item, lang-suffixed; the other lang is untouched`, async () => {
			const id = await record(
				IMAGE_I18N,
				[
					{ id: 1, lang: 'lg-eng', files_info: [] },
					{ id: 2, lang: DATA_LANG, files_info: [] },
				],
				{ [NAME]: 'Scan.JPG' },
			);
			await seedFile(IMAGE_I18N, id, PLAIN_QUALITY, image.defaultExtension, DATA_LANG);
			await run(IMAGE_I18N, id);
			const items = await storedItems(IMAGE_I18N, id);
			const eng = items.find((item) => item.lang === 'lg-eng');
			const spa = items.find((item) => item.lang === DATA_LANG);
			expect(provenance(eng), `${door} wrote provenance onto the lg-eng item`).toEqual({});
			expect(spa?.original_file_name).toBe('Scan.JPG');
			expect(spa?.original_normalized_name).toBe(`${IMAGE_I18N}_${SECTION}_${id}_${DATA_LANG}.jpg`);
		}, 90_000);

		test(`P4 ${door}: a curator's original_file_name wins (fill only what is absent)`, async () => {
			const id = await record(
				IMAGE,
				[
					{
						id: 1,
						files_info: [],
						original_file_name: 'keep.tif',
						original_normalized_name: 'keep_normalized.tif',
					},
				],
				{ [NAME]: 'Other.PNG' },
			);
			await seedFile(IMAGE, id, PLAIN_QUALITY, image.defaultExtension);
			await run(IMAGE, id);
			expect(provenance((await storedItems(IMAGE, id))[0])).toEqual({
				original_file_name: 'keep.tif',
				original_normalized_name: 'keep_normalized.tif',
			});
		}, 90_000);

		test(`P5 ${door}: no target_filename value → no original_* key is invented`, async () => {
			const id = await record(IMAGE, [{ id: 1, files_info: [] }]);
			await seedFile(IMAGE, id, PLAIN_QUALITY, image.defaultExtension);
			await run(IMAGE, id);
			expect(provenance((await storedItems(IMAGE, id))[0])).toEqual({});
		}, 90_000);

		test(`P7 ${door}: the rescan reads the REPAIRED cue (an unmanaged raw original is indexed)`, async () => {
			const id = await record(IMAGE, [{ id: 1, files_info: [] }], {
				[NAME]: `Raw Shot.${RAW_EXTENSION.toUpperCase()}`,
			});
			await seedFile(IMAGE, id, PLAIN_QUALITY, image.defaultExtension);
			await seedFile(IMAGE, id, image.originalQuality, RAW_EXTENSION);
			await run(IMAGE, id);
			const item = (await storedItems(IMAGE, id))[0];
			expect(item?.original_normalized_name).toBe(`${IMAGE}_${SECTION}_${id}.${RAW_EXTENSION}`);
			const raw = ((item?.files_info ?? []) as Item[]).filter(
				(entry) => entry.extension === RAW_EXTENSION && entry.file_exist === true,
			);
			expect(raw, `${door} rescanned BEFORE the cue was repaired`).toHaveLength(1);
		}, 90_000);
	}

	test('P6 sync_files on an additional_path component re-indexes the NAMED bucket, never wipes it', async () => {
		const id = await record(IMAGE_BUCKET, [{ id: 1, files_info: [] }], { [BUCKET]: BUCKET_NAME });
		const path = await seedFile(IMAGE_BUCKET, id, PLAIN_QUALITY, image.defaultExtension);
		expect(path, 'the seed did not land in the named bucket').toContain(`/${BUCKET_NAME}/`);
		await syncFiles(IMAGE_BUCKET, id);
		const indexed = (((await storedItems(IMAGE_BUCKET, id))[0]?.files_info ?? []) as Item[]).filter(
			(entry) => entry.file_exist === true && entry.quality === PLAIN_QUALITY,
		);
		expect(indexed, 'sync_files scanned the numeric bucket').toHaveLength(1);
		expect(String(indexed[0]?.file_path)).toContain(`/${BUCKET_NAME}/`);
		const panel = (await mediaVersions('get_files_info', IMAGE_BUCKET, id)) as {
			files_info?: Item[];
		};
		const listed = (panel.files_info ?? []).filter(
			(entry) => entry.file_exist === true && entry.quality === PLAIN_QUALITY,
		);
		expect(listed, 'the panel disk view reads another folder').toHaveLength(1);
	}, 90_000);
});
