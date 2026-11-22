/**
 * MEDIA-ICONS tc GATE (T2-WID-3, owner FYI-5 / C52 — WC-2026-11-22-media-icons-tc).
 *
 * The tc column of the media_icons widget shows an interview tape's duration.
 * Before: a tape with no stored duration showed `00:00:00.000` — a fabricated
 * measurement (C52), and the ingest companion wrote the same zero when the file
 * could not be probed. Now:
 *
 *  1. no file on this server, nothing stored → the cell carries NO value (the
 *     client renders it empty), and nothing is written;
 *  2. a file, nothing stored → the file is MEASURED, read-only: the cell shows
 *     the real duration and the read writes nothing;
 *  3. a stored duration wins over the file;
 *  4. tool_update_cache's regenerate of the component_av re-runs the duration
 *     companion: the measurement is STORED in the declared target_duration,
 *     under the run's bulk id;
 *  5. an unreadable file: no tc value on read, and the regenerate writes nothing
 *     (an error line, never `00:00:00.000`);
 *  6. the read-only measurement is probed once per file stamp (path + mtime +
 *     size): a repeat read spawns no ffprobe, a replaced file is re-measured.
 *
 * SITUATION: a `zzmit` scratch ontology on the suite's matrix_test (an AV section
 * whose component_av declares target_duration, an interview section whose portal
 * points at the tapes), records created at runtime, media bytes under the
 * suite media root at the engine's own grammar location — all swept after.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../src/config/config.ts';
import { media_icons } from '../../src/core/components/component_info/widgets/oh/media_icons.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import * as ffmpeg from '../../src/core/media/engine/ffmpeg.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';

const USER_ID = -1;
const HAVE_FFMPEG =
	Bun.which(config.media.binaries.ffmpeg) !== null &&
	Bun.which(config.media.binaries.ffprobe) !== null;

const TAPE = 'zzmit1';
const AV = 'zzmit3';
const DURATION = 'zzmit4';
const INTERVIEW = 'zzmit10';
const PORTAL = 'zzmit12';

const ONTOLOGY = situation({
	name: 'media_icons tc',
	tld: 'zzmit',
	nodes: [
		{
			tipo: TAPE,
			parent: 'test1',
			model: 'section',
			order_number: 92,
			term: { 'lg-eng': 'media_icons tc — tapes' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzmit2', parent: TAPE, model: 'section_group', order_number: 1 },
		{
			tipo: AV,
			parent: 'zzmit2',
			model: 'component_av',
			order_number: 1,
			properties: { target_duration: DURATION },
		},
		{
			tipo: DURATION,
			parent: 'zzmit2',
			model: 'component_input_text',
			order_number: 2,
			term: { 'lg-eng': 'Duration' },
		},
		{
			tipo: INTERVIEW,
			parent: 'test1',
			model: 'section',
			order_number: 93,
			term: { 'lg-eng': 'media_icons tc — interviews' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzmit11', parent: INTERVIEW, model: 'section_group', order_number: 1 },
		{
			tipo: PORTAL,
			parent: 'zzmit11',
			model: 'component_portal',
			order_number: 1,
			term: { 'lg-eng': 'Tapes' },
		},
	],
});

const records: { sectionTipo: string; sectionId: number }[] = [];
const mediaFiles: string[] = [];
const bulkIds: number[] = [];
let table = '';

async function newRecord(sectionTipo: string): Promise<number> {
	const sectionId = await createSectionRecord(sectionTipo, USER_ID);
	records.push({ sectionTipo, sectionId });
	return sectionId;
}

/** A tape record (with a stored av item, so a regenerate has something to repair). */
async function newTape(): Promise<number> {
	const id = await newRecord(TAPE);
	await sql.unsafe(
		`UPDATE "${table}" SET media = COALESCE(media, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[TAPE, id, AV, JSON.stringify([{ id: 1, lang: 'lg-nolan', files_info: [] }])],
	);
	return id;
}

/** An interview whose portal points at `tapeId` — the widget's source. */
async function interviewOf(tapeId: number): Promise<number> {
	const id = await newRecord(INTERVIEW);
	const locator = {
		id: 1,
		type: 'dd151',
		section_tipo: TAPE,
		section_id: tapeId,
		from_component_tipo: PORTAL,
	};
	await sql.unsafe(
		`UPDATE "${table}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[INTERVIEW, id, PORTAL, JSON.stringify([locator])],
	);
	return id;
}

/** The default-quality file location of a tape, where the engine looks for it. */
async function tapeFile(tapeId: number): Promise<string> {
	const spec = mustGet(mediaTypeOf('component_av'), 'component_av spec');
	const location = buildMediaLocation(
		spec,
		{ componentTipo: AV, sectionTipo: TAPE, sectionId: tapeId, lang: null },
		spec.defaultQuality,
		spec.defaultExtension,
		await resolveMediaPathOptions(AV, TAPE, tapeId),
	);
	mkdirSync(dirname(location.absolutePath), { recursive: true });
	mediaFiles.push(location.absolutePath);
	return location.absolutePath;
}

/** A real `seconds`-long mp4 (2 s by default) at the tape's default-quality location. */
async function stageVideo(tapeId: number, seconds = 2): Promise<void> {
	const path = await tapeFile(tapeId);
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			`testsrc=duration=${seconds}:size=160x120:rate=10`,
			'-t',
			String(seconds),
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			path,
		],
		{ nice: false },
	);
	expect(existsSync(path)).toBe(true);
}

/** The tc cell the widget computes for one interview → tape chain. */
async function tcCell(interviewId: number): Promise<Record<string, unknown>> {
	const ipo = [
		{
			input: {
				source: [
					{
						type: 'component',
						section_tipo: 'current',
						section_id: 'current',
						component_tipo: PORTAL,
					},
				],
				paths: [[{ section_tipo: TAPE, component_tipo: AV }]],
			},
			output: [{ id: 'tc' }],
		},
	];
	if (!('computeData' in media_icons)) throw new Error('media_icons is not a computed widget');
	const rows = (await media_icons.computeData(ipo, {
		sectionTipo: INTERVIEW,
		sectionId: interviewId,
		mode: 'list',
		lang: 'lg-eng',
	})) as Record<string, Record<string, unknown>>[];
	expect(rows.length).toBe(1);
	return mustGet(rows[0]?.tc, 'tc cell');
}

/** The stored duration items of a tape (null = nothing stored). */
async function storedDuration(tapeId: number): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT string->$3 AS v FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`,
		[TAPE, tapeId, DURATION],
	)) as { v: unknown }[];
	return rows[0]?.v ?? null;
}

async function regenerate(tapeId: number): Promise<{ errors: string[]; bulk: number }> {
	const loaded = await getLoadedTool('tool_update_cache');
	const handler = mustGet(loaded?.module.apiActions.update_cache, 'update_cache').handler;
	const response = await handler({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		background: false,
		options: {
			section_tipo: TAPE,
			components_selection: [{ tipo: AV }],
			sqo: {
				section_tipo: [TAPE],
				filter_by_locators: [{ section_tipo: TAPE, section_id: String(tapeId) }],
			},
		},
	});
	const data = response.data as { errors: string[]; bulk_process_id: number };
	bulkIds.push(Number(data.bulk_process_id));
	return { errors: data.errors, bulk: Number(data.bulk_process_id) };
}

beforeAll(async () => {
	await assertTestDatabase('media_icons_tc_native');
	await ensureSituation(ONTOLOGY);
	table = mustGet(await getMatrixTableFromTipo(TAPE), 'matrix table of the tapes');
}, 60_000);

afterAll(async () => {
	const failures: string[] = [];
	for (const { sectionTipo, sectionId } of records) {
		try {
			const outcome = await deleteSectionRecord(sectionTipo, sectionId, USER_ID);
			if (outcome.removed !== true) failures.push(`${sectionTipo}/${sectionId}`);
		} catch (error) {
			failures.push(`${sectionTipo}/${sectionId}: ${(error as Error).message}`);
		}
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[sectionTipo, sectionId],
		);
		await sql.unsafe(
			`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1 AND data->>'section_id' = $2`,
			[sectionTipo, String(sectionId)],
		);
	}
	const bulkTable = mustGet(await getMatrixTableFromTipo('dd800'), 'dd800 table');
	for (const id of bulkIds) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	for (const file of mediaFiles) rmSync(file, { force: true });
	expect(await dropSituation(ONTOLOGY)).toBe(0);
	expect(failures).toEqual([]);
}, 60_000);

describe('media_icons tc: empty when unknown, measured read-only, stored by the regenerate', () => {
	test('no file, nothing stored → NO tc value (never 00:00:00.000), nothing written', async () => {
		const tape = await newTape();
		const cell = await tcCell(await interviewOf(tape));
		expect(cell.widget_id).toBe('tc');
		expect('value' in cell).toBe(false);
		expect(await storedDuration(tape)).toBeNull();
	}, 30_000);

	test('a stored duration is shown as stored', async () => {
		const tape = await newTape();
		await sql.unsafe(
			`UPDATE "${table}" SET string = COALESCE(string, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[TAPE, tape, DURATION, JSON.stringify([{ id: 1, lang: 'lg-nolan', value: '01:02:03.000' }])],
		);
		expect((await tcCell(await interviewOf(tape))).value).toBe('01:02:03.000');
	}, 30_000);

	test.if(HAVE_FFMPEG)(
		'a file, nothing stored → the MEASURED duration, and the read writes nothing (needs ffmpeg)',
		async () => {
			const tape = await newTape();
			await stageVideo(tape);
			const cell = await tcCell(await interviewOf(tape));
			expect(cell.value).toBe('00:00:02.000');
			expect(await storedDuration(tape)).toBeNull();
		},
		60_000,
	);

	test.if(HAVE_FFMPEG)(
		'the read-only measurement is probed ONCE per file stamp: a repeat read spawns no ffprobe, a replaced file is re-measured (needs ffmpeg)',
		async () => {
			const tape = await newTape();
			await stageVideo(tape);
			const interview = await interviewOf(tape);
			const REAL_FFMPEG = { ...ffmpeg };
			let probes = 0;
			mock.module('../../src/core/media/engine/ffmpeg.ts', () => ({
				...REAL_FFMPEG,
				probeFormat: async (source: string) => {
					probes++;
					return await REAL_FFMPEG.probeFormat(source);
				},
			}));
			try {
				expect((await tcCell(interview)).value).toBe('00:00:02.000');
				expect((await tcCell(interview)).value).toBe('00:00:02.000');
				expect(probes).toBe(1);
				// the bytes change (new size + mtime) → a new stamp, never a stale answer
				await stageVideo(tape, 3);
				expect((await tcCell(interview)).value).toBe('00:00:03.000');
				expect(probes).toBe(2);
			} finally {
				mock.module('../../src/core/media/engine/ffmpeg.ts', () => REAL_FFMPEG);
				mock.restore();
			}
			expect(await storedDuration(tape)).toBeNull();
		},
		90_000,
	);

	test.if(HAVE_FFMPEG)(
		'update_cache regenerate of the component_av STORES the measured duration, under the run (needs ffmpeg)',
		async () => {
			const tape = await newTape();
			await stageVideo(tape);
			const { errors, bulk } = await regenerate(tape);
			// (a posterframe line may appear: the derivative rebuild is not this gate's)
			expect(errors.filter((line) => /duration/.test(line))).toEqual([]);
			expect(await storedDuration(tape)).toEqual([
				expect.objectContaining({ value: '00:00:02.000', lang: 'lg-nolan' }),
			]);
			const [row] = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine
				  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND bulk_process_id = $4`,
				[TAPE, tape, DURATION, bulk],
			)) as { n: number }[];
			expect(Number(row?.n ?? 0)).toBeGreaterThan(0);
			// and the widget now reads the stored value
			expect((await tcCell(await interviewOf(tape))).value).toBe('00:00:02.000');
		},
		120_000,
	);

	test.if(HAVE_FFMPEG)(
		'an UNREADABLE file: no tc value on read; the regenerate reports it and writes no 00:00:00.000 (needs ffprobe)',
		async () => {
			const tape = await newTape();
			writeFileSync(await tapeFile(tape), 'not a video');
			expect('value' in (await tcCell(await interviewOf(tape)))).toBe(false);
			const { errors } = await regenerate(tape);
			expect(errors.some((line) => line.includes(`${AV}#${tape}`) && /duration/.test(line))).toBe(
				true,
			);
			expect(await storedDuration(tape)).toBeNull();
		},
		120_000,
	);
});
