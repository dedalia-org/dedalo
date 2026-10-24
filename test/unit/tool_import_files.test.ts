/**
 * R2 gate: tool_import_files. The basename matcher + named-processor allowlist
 * are unit-tested; the module loads with its 4 actions; file_processor fails
 * CLOSED for unregistered names (SEC-053 collapse). `crop_50` is the first
 * ported processor (`src/core/media/tools/crop_coin_pair.ts`,
 * registered at module load) — its region-detection/pairing pure logic is
 * covered separately in `test/unit/region_split.test.ts` (no ImageMagick spawn).
 *
 * DDO-map role writes (setComponentsData): pure routing/lang/copy-plan logic
 * runs credless; the WRITE drives run scratch-twin against the REAL DB
 * (create → import-role write → read back → delete; never a real record),
 * gated at collection time via test.if(hasDb) so an offline run reports
 * SKIP, never a silent fake-pass (S2-40 posture).
 */
// Migrated to the generic `test` TLD 2026-08-19: the scratch twins were already on the
// `test3` playground; the remaining install tipos were the CALLER section (a tipo that
// only has to DIFFER from the target) and the ddo_map's target section/component, which
// now name generic `test` nodes (`test2`, `test3`, `test99` = component_image).

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { readComponentItems } from '../../src/core/resolve/component_data.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	basenamesMatch,
	fileBasename,
	getFileProcessor,
	registerFileProcessor,
} from '../../src/core/tools/import_files_match.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import {
	buildMultiMatchCopyPlan,
	destinationSectionIdFor,
	filenameValueFor,
	setComponentsData,
} from '../../tools/tool_import_files/server/index.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

// ── scratch twins (collection-time probe → visible SKIP when DB absent) ──
// The twins live in the test3 PLAYGROUND, which every suite DB carries. They
// used to target the `ich` TLD, which exists ONLY in the live application DB —
// so the whole file aborted at collection time ("no matrix table for section
// 'ich135'") in BOTH test databases and asserted nothing. Same models, same
// assertions; only the ontology addresses moved:
//   test3/test52  — TRANSLATABLE input_text (the target_filename drive).
//   test3/test162 — NON-translatable input_text (the input_component drive).
//   test3/test145 — component_date (the target_date capture-date drive).
const FILENAME_SECTION = 'test3';
const FILENAME_COMPONENT = 'test52'; // translatable
const INPUT_SECTION = 'test3';
const INPUT_COMPONENT = 'test162'; // non-translatable
const DATE_SECTION = 'test3';
const DATE_COMPONENT = 'test145'; // component_date (non-translatable → lg-nolan)
const USER = -1;
/** The superuser: unscoped, so these drives test the ROUTING, not the scope (that is action_scope_binding_native's job). */
const ROOT = await resolvePrincipal(USER);
const DATA_LANG = 'lg-eng'; // the request data lang threaded into the role writes

// DB reachability is probed INDEPENDENTLY of the scratch-twin creates: only a
// genuinely-unreachable DB may downgrade the write drives to a visible SKIP. If
// the DB IS reachable but createSectionRecord throws, that is a real regression
// and MUST redden the file — never masquerade as a benign skip (silent-green
// trap). Every twin that IS created is tracked so afterAll tears it down even
// when a later create throws mid-sequence (no scratch-row leak).
const createdTwins: [string, number][] = [];
let filenameScratchId: number | null = null;
let basenameScratchId: number | null = null;
let inputScratchId: number | null = null;
let hasDb = false;
try {
	await sql`SELECT 1`;
	hasDb = true;
} catch {
	console.warn('[tool_import_files] DB unavailable — ddo_map write drives SKIPPED on this run');
}
/** Create a scratch twin and track it for the afterAll teardown. */
const createTwin = async (sectionTipo: string): Promise<number> => {
	const id = await createSectionRecord(sectionTipo, USER);
	createdTwins.push([sectionTipo, id]);
	return id;
};
if (hasDb) {
	// DB reachable: a create failure here propagates (collection-time RED).
	filenameScratchId = await createTwin(FILENAME_SECTION);
	basenameScratchId = await createTwin(FILENAME_SECTION);
	inputScratchId = await createTwin(INPUT_SECTION);
}
const testIfDb = test.if(hasDb);

// target_date capture-date drive: the reader shells out to pdfinfo (config-
// resolved path) — absent binary = visible SKIP, never a silent fake-pass.
const hasPdfinfo = existsSync(config.media.binaries.pdfinfo);
const FIXTURE_DIR = scratchDir('import_files');
mkdirSync(FIXTURE_DIR, { recursive: true });

/** A minimal one-page PDF whose Info dict carries the given /CreationDate. */
function pdfWithCreationDate(rawDate: string): string {
	return `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>
endobj
4 0 obj
<< /CreationDate (${rawDate}) >>
endobj
trailer
<< /Root 1 0 R /Info 4 0 R /Size 5 >>
%%EOF
`;
}

afterAll(async () => {
	rmSync(FIXTURE_DIR, { recursive: true, force: true });
	for (const [sectionTipo, sectionId] of createdTwins) {
		try {
			await deleteSectionRecord(sectionTipo, sectionId, USER);
		} catch {
			// best-effort cleanup
		}
	}
});

async function readItems(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
	model: string,
): Promise<unknown[]> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	const record = await readMatrixRecord(table as string, sectionTipo, sectionId);
	return readComponentItems(record as NonNullable<typeof record>, componentTipo, model) ?? [];
}

describe('basename matcher', () => {
	test('fileBasename strips directory and final extension (PHP pathinfo filename)', () => {
		expect(fileBasename('73-my image-A.tiff')).toBe('73-my image-A');
		expect(fileBasename('/a/b/photo.jpg')).toBe('photo');
		expect(fileBasename('noext')).toBe('noext');
		expect(fileBasename('.hidden')).toBe('.hidden');
	});
	test('basenamesMatch compares extension-stripped names', () => {
		expect(basenamesMatch('photo.jpg', 'photo.png')).toBe(true);
		expect(basenamesMatch('photo.jpg', 'photo2.jpg')).toBe(false);
	});
});

describe('named-processor allowlist (SEC-053 collapse)', () => {
	test('unregistered / invalid names are refused', () => {
		expect(getFileProcessor('not_a_registered_processor_xyz')).toBeNull();
		expect(getFileProcessor('../evil')).toBeNull();
		expect(getFileProcessor('a b')).toBeNull();
	});
	test('a registered processor is retrievable; bad names throw on register', () => {
		registerFileProcessor('test_noop', async () => ({ ok: true, message: 'ok' }));
		expect(getFileProcessor('test_noop')).not.toBeNull();
		expect(() =>
			registerFileProcessor('bad name', async () => ({ ok: true, message: '' })),
		).toThrow();
	});
	test('crop_50 is registered once the tool module has loaded', async () => {
		// Load-order independent: force the registration side effect (module-load
		// time `registerFileProcessor('crop_50', ...)` in
		// tools/tool_import_files/server/index.ts) regardless of which other test
		// in this file/process happened to trigger it first.
		await getLoadedTool('tool_import_files');
		expect(getFileProcessor('crop_50')).not.toBeNull();
	});
});

describe('ddo_map pure logic (no DB)', () => {
	test('destination routing: caller-section ddo → caller record, else the target record', () => {
		// PHP set_components_data :1635.
		expect(destinationSectionIdFor('test2', 'test2', 5, 99)).toBe(5);
		expect(destinationSectionIdFor('test3', 'test2', 5, 99)).toBe(99);
	});

	test('only_basename strips section_id prefix, field letter and extension', () => {
		expect(filenameValueFor('73-portrait-A.jpg', true)).toBe('portrait');
		expect(filenameValueFor('73-portrait-A.jpg', false)).toBe('73-portrait-A.jpg');
		expect(filenameValueFor('IMG_3007.jpg', false)).toBe('IMG_3007.jpg');
		// No base_name segment (purely numeric filename) → empty string.
		expect(filenameValueFor('42.jpg', true)).toBe('');
	});

	test('multi-match copy plan: every target but the LAST gets a suffixed copy', () => {
		// PHP :974-1041 — the last target consumes the original staged file.
		const plan = buildMultiMatchCopyPlan([11, 12, 13], 'portrait.tiff', 'portrait.tiff');
		expect(plan).toEqual([
			{
				targetSectionId: 11,
				tmpName: 'portrait_11.tiff',
				fileName: 'portrait_11.tiff',
				isLast: false,
			},
			{
				targetSectionId: 12,
				tmpName: 'portrait_12.tiff',
				fileName: 'portrait_12.tiff',
				isLast: false,
			},
			{ targetSectionId: 13, tmpName: 'portrait.tiff', fileName: 'portrait.tiff', isLast: true },
		]);
	});

	test('multi-match copy plan: single match = original only; no matches = empty plan', () => {
		expect(buildMultiMatchCopyPlan([7], 'a.jpg', 'a.jpg')).toEqual([
			{ targetSectionId: 7, tmpName: 'a.jpg', fileName: 'a.jpg', isLast: true },
		]);
		expect(buildMultiMatchCopyPlan([], 'a.jpg', 'a.jpg')).toEqual([]);
	});
});

describe('tool_import_files module', () => {
	test('loads with the 4 actions + import_files backgroundRunnable', async () => {
		const loaded = await getLoadedTool('tool_import_files');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions).sort()).toEqual([
			'file_processor',
			'get_media_section_match',
			'get_media_section_match_from_souce',
			'import_files',
		]);
		expect(loaded!.module.backgroundRunnable).toEqual(['import_files']);
		// `..._from_souce` keeps PHP's typo: it is the literal API_ACTIONS entry of
		// the oracle (class.tool_import_files.php :74), so it is a WIRE fact and
		// must never be "corrected" without a WIRE_CONTRACT entry.
	});

	/**
	 * THE WIRE. `custom_target_quality` — the Quality selector
	 * (render_tool_import_files.js :989) — reached the handler and was DROPPED, so
	 * every imported file landed in `original` whatever the operator chose. The
	 * engine honouring a `quality` it is HANDED proves nothing about that; only
	 * reading it off the payload does.
	 *
	 * An out-of-ladder tier must surface as the quality error for that file; with
	 * the option not read, the same request dies at the staging lookup instead.
	 */
	testIfDb('custom_target_quality reaches the ingest (the inert-selector bug)', async () => {
		const loaded = await getLoadedTool('tool_import_files');
		const action = mustGet(loaded!.module.apiActions.import_files, 'import_files');
		const call = async (customTargetQuality?: string): Promise<string[]> => {
			const response = await action.handler({
				principal: await resolvePrincipal(USER),
				userId: USER,
				background: false,
				options: {
					tipo: 'test99', // component_image in the test3 playground
					section_tipo: FILENAME_SECTION,
					section_id: mustGet(filenameScratchId, 'filename scratch id'),
					tool_config: {},
					key_dir: 'kd_wire',
					files_data: [{ name: 'wire.jpg', tmp_name: 'wire.jpg', extension: 'jpg' }],
					...(customTargetQuality === undefined
						? {}
						: { custom_target_quality: customTargetQuality }),
				},
			});
			return (response.data as { errors?: string[] }).errors ?? [];
		};

		expect((await call('not_a_tier')).join(' ')).toContain("Unknown media quality 'not_a_tier'");
		// Same request without it must fail elsewhere — asserted POSITIVELY, so the
		// control arm cannot pass by returning no errors at all.
		const control = (await call()).join(' ');
		expect(control).toContain('Staged upload not found');
		expect(control).not.toContain('media quality');
	});

	test('the matcher gates read the TARGET section out of the payload', async () => {
		const loaded = await getLoadedTool('tool_import_files');
		const actions = loaded!.module.apiActions;

		// get_media_section_match: the handler only ever receives the target inside
		// `target_filename`. A gate on options.section_tipo saw nothing and denied
		// every call ("invalid section target") — the action was dead over the wire.
		// The gate names the PAIR the handler reads: the target section × the
		// filename component whose stored values the match scans ('targets', 1).
		const free = mustGet(actions.get_media_section_match, 'get_media_section_match');
		expect(free.permission).toBe('targets');
		expect(free.minLevel).toBe(1);
		expect(
			free.targets?.({
				full_name: 'x.jpg',
				target_filename: { tipo: FILENAME_COMPONENT, section_tipo: FILENAME_SECTION },
			}),
		).toEqual([{ section_tipo: FILENAME_SECTION, tipo: FILENAME_COMPONENT }]);
		expect(free.targets?.({ full_name: 'x.jpg' })).toEqual([]); // fail-closed

		// ..._from_souce reads filename values out of the TARGET section too, so
		// gating only the SOURCE left the section whose data it reads unchecked.
		// The source RECORD is scope-checked (section_id), the target as the pair.
		const fromSource = mustGet(
			actions.get_media_section_match_from_souce,
			'get_media_section_match_from_souce',
		);
		expect(fromSource.permission).toBe('targets');
		expect(
			fromSource.targets?.({
				section_tipo: 'test2',
				section_id: 1,
				target_section_tipo: FILENAME_SECTION,
				target_filename: { tipo: FILENAME_COMPONENT },
				full_name: 'x.jpg',
			}),
		).toEqual([
			{ section_tipo: 'test2', section_id: 1 },
			{ section_tipo: FILENAME_SECTION, tipo: FILENAME_COMPONENT },
		]);
	});

	test('file_processor fails closed for an unregistered name', async () => {
		const loaded = await getLoadedTool('tool_import_files');
		const principal = await resolvePrincipal(-1);
		const refusal = await refusalOf(
			mustGet(loaded!.module.apiActions.file_processor, 'file_processor').handler({
				principal,
				userId: -1,
				background: false,
				options: { file_processor: 'not_a_registered_processor_xyz' },
			}),
		);
		expect(refusal.code).toBe('tool.unsupported_target');
		expect(refusal.publicMessage).toContain('not a registered processor');
	});

	test('crop_50 is registered and itself fails closed on insufficient options', async () => {
		// crop_50 is the first ported file_processor (src/core/media/tools/crop_coin_pair.ts) — it
		// is now REGISTERED, so this exercises its own guard clause rather than
		// the allowlist refusal: no file_path/file_name/user_id/key_dir means it
		// cannot even attempt the ImageMagick pipeline, and says so.
		const loaded = await getLoadedTool('tool_import_files');
		const principal = await resolvePrincipal(-1);
		const refusal = await refusalOf(
			mustGet(loaded!.module.apiActions.file_processor, 'file_processor').handler({
				principal,
				userId: -1,
				background: false,
				options: { file_processor: 'crop_50' },
			}),
		);
		expect(refusal.code).toBe('tool.action_failed');
		expect(refusal.message).toContain('missing file_path/file_name/user_id/key_dir');
	});

	test('file_processor action refuses a processor that REPORTS outputs (import_files only)', async () => {
		// A splitter (crop_50) produces staged output files that only the
		// import_files per-file loop ingests. The standalone action cannot consume
		// them, so reporting ok:true here would silently leave records-less files
		// behind. Refused, and the produced files are removed.
		registerFileProcessor('test_splitter', async () => ({
			ok: true,
			message: 'split',
			outputs: [{ tmpName: 'x_crop-0.jpg', fileName: 'x_crop-0.jpg' }],
		}));
		const loaded = await getLoadedTool('tool_import_files');
		const principal = await resolvePrincipal(-1);
		const refusal = await refusalOf(
			mustGet(loaded!.module.apiActions.file_processor, 'file_processor').handler({
				principal,
				userId: -1,
				background: false,
				options: {
					file_processor: 'test_splitter',
					user_id: -1,
					key_dir: 'kd_splitter_refusal',
				},
			}),
		);
		expect(refusal.code).toBe('tool.unsupported_target');
		expect(refusal.publicMessage).toContain('import_files per-file processor flow');
	});

	test('import_files rejects missing required params (no run without a media component)', async () => {
		const loaded = await getLoadedTool('tool_import_files');
		const principal = await resolvePrincipal(-1);
		// Missing section_tipo/tipo/files_data → clean validation failure (all modes).
		const refusal = await refusalOf(
			mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
				principal,
				userId: -1,
				background: true,
				options: {
					tool_config: { import_file_name_mode: 'match' },
					section_tipo: '',
					tipo: '',
					files_data: [],
				},
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toContain('Missing');
	});

	testIfDb(
		'a MISSING section_id in default import mode never coerces to 0 — fails per file',
		async () => {
			// Regression: `Number(o.section_id ?? 0)` used to silently address "record
			// 0" for a request that never carried a caller section_id at all — 0 is a
			// structurally valid SectionId elsewhere in the engine (concepts/
			// section_id.ts allows negatives too), so nothing downstream caught it,
			// and a portal write against that bogus address left an undeletable
			// orphan record.
			//
			// The contract (index.ts resolveHostSectionId): import_mode 'default' +
			// a ddo_map targets the CALLING record's own portal (PHP :1132-1141) and
			// has NO fresh-record fallback, so a missing caller is a real PER-FILE
			// error — reported in `errors[]` like every other per-file failure (the
			// batch never aborts on one file), never coerced to 0 and never creating
			// a record. The record-less list-button flow rides import_mode 'section'
			// instead, which creates a fresh host per file.
			const loaded = await getLoadedTool('tool_import_files');
			const principal = await resolvePrincipal(-1);
			const res = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
				principal,
				userId: -1,
				background: true,
				options: {
					tool_config: { ddo_map: [{ role: 'target_component', tipo: 'test99' }] },
					section_tipo: 'test2',
					tipo: 'test99',
					// section_id deliberately omitted.
					key_dir: 'kd_missing_section_id',
					files_data: [{ name: 'a.jpg' }],
				},
			});
			expect(res.ok).toBe(true);
			const report = res.data as { summary: string; errors: string[]; imported: number };
			expect(report.imported).toBe(0);
			expect(report.errors.join(' ')).toContain('no caller section_id was provided');
			expect(report.summary).toContain('Imported 0 of 1');
		},
	);

	testIfDb('import_files with a ddo_map requires the target_component role', async () => {
		const loaded = await getLoadedTool('tool_import_files');
		const principal = await resolvePrincipal(-1);
		const refusal = await refusalOf(
			mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
				principal,
				userId: -1,
				background: true,
				options: {
					tool_config: { ddo_map: [{ role: 'target_filename', tipo: 'test52' }] },
					section_tipo: 'test2',
					tipo: 'test99',
					files_data: [{ name: 'a.jpg' }],
				},
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toContain('target_component');
	});

	testIfDb('a translatable input_component no longer refuses the batch (WC-078)', async () => {
		// WAS: the batch was refused outright, before touching a single file,
		// because the PHP temp-session component (is_temp at fake section_id 1)
		// has no TS twin. That made the tool unusable with the SHIPPED import
		// form, which carries translatable text fields — the user-visible
		// "images upload fails". Translatable values are now written per-lang
		// from the entries the client ships (each carries its own `lang`).
		//
		// This asserts only that the pre-flight REFUSAL is gone: the run still
		// fails here for the unrelated reason that 'a.jpg' was never staged, so
		// pin the absence of the old message rather than a success.
		const loaded = await getLoadedTool('tool_import_files');
		const principal = await resolvePrincipal(-1);
		const res = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal,
			userId: -1,
			background: true,
			options: {
				tool_config: {
					import_mode: 'section_resource',
					ddo_map: [
						{ role: 'target_component', tipo: 'test99', section_tipo: 'test3' },
						{
							role: 'input_component',
							tipo: FILENAME_COMPONENT,
							section_tipo: FILENAME_SECTION,
						},
					],
				},
				section_tipo: 'test3',
				tipo: 'test99',
				files_data: [{ name: 'a.jpg' }],
			},
		});
		// It got PAST the pre-flight and into the per-file loop, where the
		// unstaged file is reported per-file instead of aborting the batch (the old
		// refusal would have THROWN before any file was touched).
		expect(res.ok).toBe(true);
		const report = res.data as { summary: string; errors: string[] };
		expect(report.summary).not.toContain('translatable input_component');
		expect(report.errors.join(' ')).toContain('a.jpg');
	});
});

describe.if(hasDb)('setComponentsData drive (scratch-twin, real DB)', () => {
	test('target_filename fills an EMPTY component with [{value, lang}]', async () => {
		await setComponentsData({
			ddoMap: [
				{ role: 'target_filename', tipo: FILENAME_COMPONENT, section_tipo: FILENAME_SECTION },
			],
			sectionTipo: 'test2', // caller differs → destination = targetSectionId
			sectionId: 0,
			targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
			targetSectionId: filenameScratchId as number,
			currentFileName: 'photo.jpg',
			mediaFilePath: null,
			targetComponentModel: '',
			componentsTempData: [],
			userId: USER,
			principal: ROOT,
			dataLang: DATA_LANG,
		});
		const stored = await readItems(
			FILENAME_SECTION,
			filenameScratchId as number,
			FILENAME_COMPONENT,
			'component_input_text',
		);
		expect(stored).toContainEqual(expect.objectContaining({ value: 'photo.jpg' }));
		// translatable component → the request/default DATA lang, never lg-nolan
		expect((stored[0] as { lang?: string }).lang).toMatch(/^lg-/);
		expect((stored[0] as { lang?: string }).lang).not.toBe('lg-nolan');
	});

	test('target_filename NEVER overwrites existing data (PHP empty-guard)', async () => {
		await setComponentsData({
			ddoMap: [
				{ role: 'target_filename', tipo: FILENAME_COMPONENT, section_tipo: FILENAME_SECTION },
			],
			sectionTipo: 'test2',
			sectionId: 0,
			targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
			targetSectionId: filenameScratchId as number,
			currentFileName: 'OTHER.jpg',
			mediaFilePath: null,
			targetComponentModel: '',
			componentsTempData: [],
			userId: USER,
			principal: ROOT,
			dataLang: DATA_LANG,
		});
		const stored = await readItems(
			FILENAME_SECTION,
			filenameScratchId as number,
			FILENAME_COMPONENT,
			'component_input_text',
		);
		expect(stored).toContainEqual(expect.objectContaining({ value: 'photo.jpg' }));
		expect(stored).not.toContainEqual(expect.objectContaining({ value: 'OTHER.jpg' }));
	});

	test('target_filename only_basename stores the parsed base_name segment', async () => {
		await setComponentsData({
			ddoMap: [
				{
					role: 'target_filename',
					tipo: FILENAME_COMPONENT,
					section_tipo: FILENAME_SECTION,
					only_basename: true,
				},
			],
			sectionTipo: 'test2',
			sectionId: 0,
			targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
			targetSectionId: basenameScratchId as number,
			currentFileName: '73-portrait-A.jpg',
			mediaFilePath: null,
			targetComponentModel: '',
			componentsTempData: [],
			userId: USER,
			principal: ROOT,
			dataLang: DATA_LANG,
		});
		const stored = await readItems(
			FILENAME_SECTION,
			basenameScratchId as number,
			FILENAME_COMPONENT,
			'component_input_text',
		);
		expect(stored).toContainEqual(expect.objectContaining({ value: 'portrait' }));
	});

	test('input_component (non-translatable) writes the temp-data value at lg-nolan', async () => {
		// ddo.section_tipo === caller section_tipo → destination is the CALLER record.
		await setComponentsData({
			ddoMap: [{ role: 'input_component', tipo: INPUT_COMPONENT, section_tipo: INPUT_SECTION }],
			sectionTipo: INPUT_SECTION,
			sectionId: inputScratchId as number,
			targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
			targetSectionId: 999999, // must NOT be used by the routing
			currentFileName: 'a.jpg',
			mediaFilePath: null,
			targetComponentModel: '',
			componentsTempData: [
				{
					tipo: INPUT_COMPONENT,
					section_tipo: INPUT_SECTION,
					value: [{ value: 'from the import form' }],
				},
			],
			userId: USER,
			principal: ROOT,
			dataLang: DATA_LANG,
		});
		const stored = await readItems(
			INPUT_SECTION,
			inputScratchId as number,
			INPUT_COMPONENT,
			'component_input_text',
		);
		expect(stored).toContainEqual(
			expect.objectContaining({ value: 'from the import form', lang: 'lg-nolan' }),
		);
	});

	test('input_component with an EMPTY temp value writes nothing (PHP !empty guard)', async () => {
		const before = await readItems(
			INPUT_SECTION,
			inputScratchId as number,
			INPUT_COMPONENT,
			'component_input_text',
		);
		await setComponentsData({
			ddoMap: [{ role: 'input_component', tipo: INPUT_COMPONENT, section_tipo: INPUT_SECTION }],
			sectionTipo: INPUT_SECTION,
			sectionId: inputScratchId as number,
			targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
			targetSectionId: 999999,
			currentFileName: 'a.jpg',
			mediaFilePath: null,
			targetComponentModel: '',
			componentsTempData: [
				{ tipo: INPUT_COMPONENT, section_tipo: INPUT_SECTION, value: [] },
				// null holes are never persisted either (PHP fallback_value [null])
				{ tipo: 'unrelated', section_tipo: INPUT_SECTION, value: [null] },
			],
			userId: USER,
			principal: ROOT,
			dataLang: DATA_LANG,
		});
		const after = await readItems(
			INPUT_SECTION,
			inputScratchId as number,
			INPUT_COMPONENT,
			'component_input_text',
		);
		expect(after).toEqual(before);
	});

	// WC-078: a translatable input_component used to THROW here (PHP reached all
	// languages through a temp-session component that has no TS twin). It now
	// writes per-lang from the entries the client ships — a save call stores
	// exactly ONE lang slice, so the entries are grouped by their own `lang`.
	test('translatable input_component with NO temp payload writes nothing (no throw)', async () => {
		const before = await readItems(
			FILENAME_SECTION,
			filenameScratchId as number,
			FILENAME_COMPONENT,
			'component_input_text',
		);
		await setComponentsData({
			ddoMap: [
				{ role: 'input_component', tipo: FILENAME_COMPONENT, section_tipo: FILENAME_SECTION },
			],
			sectionTipo: 'test2',
			sectionId: 0,
			targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
			targetSectionId: filenameScratchId as number,
			currentFileName: 'a.jpg',
			mediaFilePath: null,
			targetComponentModel: '',
			componentsTempData: [],
			userId: USER,
			principal: ROOT,
			dataLang: DATA_LANG,
		});
		const after = await readItems(
			FILENAME_SECTION,
			filenameScratchId as number,
			FILENAME_COMPONENT,
			'component_input_text',
		);
		expect(after).toEqual(before);
	});

	test('translatable input_component writes the entry under its OWN lang', async () => {
		await setComponentsData({
			ddoMap: [
				{ role: 'input_component', tipo: FILENAME_COMPONENT, section_tipo: FILENAME_SECTION },
			],
			sectionTipo: 'test2',
			sectionId: 0,
			targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
			targetSectionId: filenameScratchId as number,
			currentFileName: 'a.jpg',
			mediaFilePath: null,
			targetComponentModel: '',
			// `entries` is the live wire key (WC-001); the entry carries its lang.
			componentsTempData: [
				{
					tipo: FILENAME_COMPONENT,
					section_tipo: FILENAME_SECTION,
					entries: [{ value: 'caption from the import form', lang: DATA_LANG }],
				},
			],
			userId: USER,
			principal: ROOT,
			dataLang: DATA_LANG,
		});
		const stored = await readItems(
			FILENAME_SECTION,
			filenameScratchId as number,
			FILENAME_COMPONENT,
			'component_input_text',
		);
		expect(stored).toContainEqual(
			expect.objectContaining({ value: 'caption from the import form', lang: DATA_LANG }),
		);
	});

	// Gated separately (visible SKIP): the reader shells out to pdfinfo.
	test.if(hasPdfinfo)(
		'target_date fills an EMPTY date component from the staged file capture date',
		async () => {
			const dateScratchId = await createTwin(DATE_SECTION);
			const pdfPath = join(FIXTURE_DIR, 'dated.pdf');
			writeFileSync(pdfPath, pdfWithCreationDate("D:20110816234339-04'00'"));
			const write = async (mediaFilePath: string): Promise<void> =>
				setComponentsData({
					ddoMap: [{ role: 'target_date', tipo: DATE_COMPONENT, section_tipo: DATE_SECTION }],
					sectionTipo: 'test2', // caller differs → destination = targetSectionId
					sectionId: 0,
					targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
					targetSectionId: dateScratchId,
					currentFileName: 'dated.pdf',
					mediaFilePath,
					targetComponentModel: 'component_pdf',
					componentsTempData: [],
					userId: USER,
					principal: ROOT,
					dataLang: DATA_LANG,
				});
			await write(pdfPath);
			// PHP persisted shape: [{id, start: dd_date}] — set_data mints the item
			// id (set_data_item_counter; a fresh record starts at 1) and the start
			// carries the server-computed 'time' (component_date::save add_time;
			// 372-day years / 31-day months).
			const expected = [
				{
					id: 1,
					start: {
						year: 2011,
						month: 8,
						day: 16,
						time: 2011 * 372 * 86400 + 7 * 31 * 86400 + 15 * 86400,
					},
				},
			];
			expect(
				await readItems(DATE_SECTION, dateScratchId, DATE_COMPONENT, 'component_date'),
			).toEqual(expected);
			// Fill-only-when-empty (PHP :1678): a re-import with ANOTHER date never overwrites.
			const otherPdf = join(FIXTURE_DIR, 'other.pdf');
			writeFileSync(otherPdf, pdfWithCreationDate('D:19990101'));
			await write(otherPdf);
			expect(
				await readItems(DATE_SECTION, dateScratchId, DATE_COMPONENT, 'component_date'),
			).toEqual(expected);
		},
	);

	test('target_date with no readable date writes NOTHING (PHP skip-when-empty)', async () => {
		const dateScratchId = await createTwin(DATE_SECTION);
		const write = async (mediaFilePath: string | null, model: string): Promise<void> =>
			setComponentsData({
				ddoMap: [{ role: 'target_date', tipo: DATE_COMPONENT, section_tipo: DATE_SECTION }],
				sectionTipo: 'test2',
				sectionId: 0,
				targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
				targetSectionId: dateScratchId,
				currentFileName: 'a.bin',
				mediaFilePath,
				targetComponentModel: model,
				componentsTempData: [],
				userId: USER,
				principal: ROOT,
				dataLang: DATA_LANG,
			});
		await write(null, 'component_pdf'); // no staged file
		await write(join(FIXTURE_DIR, 'missing.pdf'), 'component_pdf'); // consumed/moved file
		const undatedPdf = join(FIXTURE_DIR, 'undated_role.pdf');
		writeFileSync(undatedPdf, pdfWithCreationDate('').replace('/CreationDate ()', '/Producer (x)'));
		await write(undatedPdf, 'component_pdf'); // parseable file, no CreationDate
		await write(undatedPdf, 'component_3d'); // model outside the PHP switch
		expect(await readItems(DATE_SECTION, dateScratchId, DATE_COMPONENT, 'component_date')).toEqual(
			[],
		);
	});

	test('component_option / target_component roles never produce a data write', async () => {
		const before = await readItems(
			FILENAME_SECTION,
			basenameScratchId as number,
			FILENAME_COMPONENT,
			'component_input_text',
		);
		await setComponentsData({
			ddoMap: [
				{ role: 'component_option', tipo: FILENAME_COMPONENT, section_tipo: FILENAME_SECTION },
				{ role: 'target_component', tipo: FILENAME_COMPONENT, section_tipo: FILENAME_SECTION },
			],
			sectionTipo: 'test2',
			sectionId: 0,
			targetSectionTipo: 'test3', // the one section a role write may land in beside the caller's
			targetSectionId: basenameScratchId as number,
			currentFileName: 'never-written.jpg',
			mediaFilePath: null,
			targetComponentModel: '',
			componentsTempData: [],
			userId: USER,
			principal: ROOT,
			dataLang: DATA_LANG,
		});
		const after = await readItems(
			FILENAME_SECTION,
			basenameScratchId as number,
			FILENAME_COMPONENT,
			'component_input_text',
		);
		expect(after).toEqual(before);
		expect(after).not.toContainEqual(expect.objectContaining({ value: 'never-written.jpg' }));
	});
});

describe.if(hasDb)('get_media_section_match (SQO component-value filter, scratch-twin)', () => {
	/** Store a filename value on a fresh scratch twin; returns its section_id. */
	async function twinWithFilename(value: string): Promise<number> {
		const id = await createTwin(FILENAME_SECTION);
		const save = await saveComponentData({
			componentTipo: FILENAME_COMPONENT,
			sectionTipo: FILENAME_SECTION,
			sectionId: id,
			lang: DATA_LANG,
			changedData: [{ action: 'set_data', id: null, value: [{ value, lang: DATA_LANG }] }],
			userId: USER,
		});
		expect(save.ok).toBe(true);
		return id;
	}

	async function runMatch(fullName: string): Promise<unknown> {
		const loaded = await getLoadedTool('tool_import_files');
		const principal = await resolvePrincipal(-1);
		const res = await mustGet(
			loaded!.module.apiActions.get_media_section_match,
			'get_media_section_match',
		).handler({
			principal,
			userId: -1,
			background: false,
			options: {
				full_name: fullName,
				target_filename: { tipo: FILENAME_COMPONENT, section_tipo: FILENAME_SECTION },
			},
		});
		expect(res.ok).toBe(true);
		return res.data;
	}

	test('finds the exact-basename record across an extension change; near-names excluded', async () => {
		// Unique stamp so the search never collides with real section records.
		const stamp = `mfp${Date.now()}`;
		const matchId = await twinWithFilename(`${stamp}_one.jpg`);
		await twinWithFilename(`${stamp}_one2.jpg`); // 'my_image2' near-name must NOT match
		// Extension change tolerated (PHP: jpg on record, tiff uploaded).
		expect(await runMatch(`${stamp}_one.tiff`)).toEqual([matchId]);
	});

	test('basenames with search-operator characters ride the fallback prefilter', async () => {
		// '(' would change meaning inside the string builder's regex → the SQO
		// uses the not-empty filter and the exact comparison decides in memory.
		const stamp = `mfq${Date.now()}`;
		const matchId = await twinWithFilename(`${stamp} (1).jpg`);
		expect(await runMatch(`${stamp} (1).png`)).toEqual([matchId]);
		// No stored basename equals '<stamp> (2)' → empty result, no error.
		expect(await runMatch(`${stamp} (2).png`)).toEqual([]);
	});
});
