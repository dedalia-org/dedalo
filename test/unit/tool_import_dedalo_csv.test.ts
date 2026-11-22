/**
 * R2 gate: tool_import_dedalo_csv. Module loads with its 6 actions (import_files
 * backgroundRunnable). get_section_components_list is DB-verified (reuses the
 * verified get_section_elements_context). The conform/plan core is tested in
 * import_data / import_csv; the CSV→DB execute drive is exercised here against a
 * SCRATCH record in the test3 playground (created and removed by the test).
 */
// Migrated to the generic `test` TLD 2026-08-19: the components list is resolved from
// the `test3` playground section and the batch-target extractor takes generic `test`
// section tipos — no install's ontology or records are read.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ddDateToSeconds } from '../../src/core/media/file_date.ts';
import { termByTipo } from '../../src/core/ontology/labels.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ImportFileReport, ImportProgressFrame } from '../../src/core/tools/import_wire.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';

const SECTION = 'test3';

describe('tool_import_dedalo_csv module', () => {
	test('loads with the 6 actions + import_files backgroundRunnable', async () => {
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions).sort()).toEqual([
			'delete_csv_file',
			'get_csv_files',
			'get_section_components_list',
			'import_files',
			'process_uploaded_file',
			'validate_import',
		]);
		expect(loaded!.module.backgroundRunnable).toEqual(['import_files']);
		// The batch's targets ride inside options.files[] (one section per file), so
		// import_files gates on the LIST, not on a top-level section_tipo the client
		// never sends. process_uploaded_file has no section target at all.
		const importFiles = mustGet(actions.import_files, 'import_files');
		expect(importFiles.permission).toBe('section_list');
		expect(mustGet(actions.process_uploaded_file, 'process_uploaded_file').permission).toBeNull();
	});

	test('get_section_components_list resolves a VIRTUAL section through its real one', async () => {
		// test0 is virtual: it has NO components of its own (relations[0].tipo →
		// ontology1 owns them). A plain subtree walk returns an EMPTY list, and the
		// client then renders an empty <select> and auto-detects NOTHING — the column
		// mapper silently stays blank, which is exactly the reported bug.
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(
			loaded!.module.apiActions.get_section_components_list,
			'get_section_components_list',
		).handler({
			principal: await resolvePrincipal(-1),
			userId: -1,
			background: false,
			options: { section_tipo: 'test0' },
		});
		const list = (res.data as { components: { value: string; model: string }[] }).components;
		expect(list.length).toBeGreaterThan(0);
		// The real section's components are what an exported test0 CSV is keyed on.
		expect(list.some((el) => el.value === 'ontology3')).toBe(true);
		// The section_id column of the CSV maps through this model (client rule).
		expect(list.some((el) => el.model === 'component_section_id')).toBe(true);
	});

	test('import_files gate reads every file section_tipo from the client payload', async () => {
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const spec = mustGet(loaded!.module.apiActions.import_files, 'import_files');
		// The exact wire the client posts (render_tool_import_dedalo_csv fn_import).
		const options = {
			background_running: true,
			files: [
				{ file: 'a.csv', section_tipo: 'test2', ar_columns_map: [] },
				{ file: 'b.csv', section_tipo: SECTION, ar_columns_map: [] },
			],
		};
		expect(spec.sectionTipos?.(options)).toEqual(['test2', SECTION]);
		// A batch with no files yields no targets → the gate denies (fail-closed).
		expect(spec.sectionTipos?.({ files: [] })).toEqual([]);
	});

	test('get_section_components_list returns {label,value,model}[] + top-level section label (client contract)', async () => {
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const principal = await resolvePrincipal(-1);
		const res = await mustGet(
			loaded!.module.apiActions.get_section_components_list,
			'get_section_components_list',
		).handler({
			principal,
			userId: -1,
			background: false,
			options: { section_tipo: SECTION },
		});
		expect(res.ok).toBe(true);
		// The payload carries the list and the section label together.
		const payload = res.data as { components: Record<string, unknown>[]; label: unknown };
		expect(typeof payload.label).toBe('string');
		const list = payload.components;
		expect(Array.isArray(list)).toBe(true);
		expect(list.length).toBeGreaterThan(0);
		for (const el of list) {
			expect(typeof el.value).toBe('string'); // the tipo
			expect(typeof el.model).toBe('string');
			expect('label' in el).toBe(true);
		}
	});

	test('get_section_components_list carries each component append policy (null = refused)', async () => {
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(
			loaded!.module.apiActions.get_section_components_list,
			'get_section_components_list',
		).handler({
			principal: await resolvePrincipal(-1),
			userId: -1,
			background: false,
			options: { section_tipo: SECTION },
		});
		const list = (res.data as { components: Record<string, unknown>[] }).components;
		const policyOf = (tipo: string): unknown => {
			const entry = list.find((el) => el.value === tipo);
			expect(entry, `${tipo} is listed`).toBeDefined();
			expect('import_append' in (entry ?? {})).toBe(true);
			return entry?.import_append;
		};
		expect(policyOf('test52')).toBe('items'); // input_text
		expect(policyOf('test80')).toBe('items'); // portal
		expect(policyOf('test100')).toBe('geo_layer'); // geolocation
		expect(policyOf('test17')).toBe('text_paragraphs'); // text_area
		expect(policyOf('test99')).toBeNull(); // image (media)
		expect(policyOf('test91')).toBeNull(); // select
		expect(policyOf('test87')).toBeNull(); // radio_button
		// the key column and the audit tipos, when listed, never offer append
		for (const el of list) {
			if (
				el.model === 'component_section_id' ||
				['dd199', 'dd200', 'dd201', 'dd197'].includes(String(el.value))
			) {
				expect(el.import_append, String(el.value)).toBeNull();
			}
		}
		// every non-null value is a policy name, never a refusal object
		for (const el of list) {
			expect([null, 'items', 'geo_layer', 'text_paragraphs']).toContain(
				el.import_append as string | null,
			);
		}
	});
});

/**
 * The drive the client actually performs: a CSV staged in the user's import dir +
 * the column map the mapper UI produces → records written. Scratch surfaces only:
 * a disposable user's import dir and ONE test3 record id well outside the
 * canonical playground (removed in afterAll, together with its TM + dd800 rows).
 */
describe('import_files writes the mapped columns (scratch record, cleaned up)', () => {
	const SCRATCH_USER = 987656;
	const SCRATCH_ID = 900101; // far outside the canonical test3 ids (1, 2, 27)
	const root = config.media.rootPath ?? '';
	const userDir = resolve(root, 'import/files', String(SCRATCH_USER));
	const CSV = 'scratch_import.csv';
	const bulkProcessIds: number[] = [];

	beforeAll(() => {
		mkdirSync(userDir, { recursive: true });
		// ';' is the Dédalo CSV delimiter. test52 is component_input_text on test3.
		writeFileSync(
			resolve(userDir, CSV),
			`section_id;test52\n${SCRATCH_ID};imported by the csv tool\n`,
		);
	});
	afterAll(async () => {
		rmSync(userDir, { recursive: true, force: true });
		await sql.unsafe(`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`, [
			SCRATCH_ID,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = $1`,
			[SCRATCH_ID],
		);
		for (const id of bulkProcessIds) {
			await sql.unsafe(
				`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = $1`,
				[id],
			);
			await sql.unsafe(
				`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
				[id],
			);
		}
	});

	test('creates the record at the CSV section_id and saves the mapped component', async () => {
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: SCRATCH_USER,
			background: false,
			// The exact payload render_tool_import_dedalo_csv posts.
			options: {
				files: [
					{
						file: CSV,
						section_tipo: 'test3',
						bulk_process_label: 'scratch import',
						ar_columns_map: [
							{ tipo: 'section_id', label: 'Section ID', model: 'section_id' },
							{
								tipo: 'test52',
								label: 'Text',
								model: 'component_input_text',
								checked: true,
								map_to: 'test52',
							},
						],
					},
				],
			},
		});

		const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
		expect(report.ok).toBe(true);
		// THE CONTRACT: created/updated are the section_ids, not counts. The client
		// lists them and offers "copy as column"; a number has no .length and the
		// whole panel silently renders nothing (the bug this replaced).
		expect(report.created).toEqual([SCRATCH_ID]);
		expect(report.updated).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.warnings).toEqual([]);
		expect(report.rows_total).toBe(1);
		bulkProcessIds.push(report.bulk_process_id as number);

		// The record exists at the id the CSV asked for — not at a counter-issued one —
		// and the mapped component landed in its matrix column (string, for input_text).
		const rows = (await sql.unsafe(
			`SELECT string -> 'test52' AS items
			   FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`,
			[SCRATCH_ID],
		)) as { items: unknown }[];
		expect(rows.length).toBe(1);
		expect(JSON.stringify(rows[0]?.items)).toContain('imported by the csv tool');

		// The record's time-machine rows are attributed to the dd800 run — this is
		// what makes the whole import revertable as ONE operation — and they are
		// the run's UNDO LOG (WC-2026-09-27-bulk-revert-undo-log), id ASC: the
		// BIRTH marker (role 3, tipo = the section: the import created the
		// record; its data is the birth image, never absent), then the
		// component's hidden BEFORE (role 1, the key was absent → SQL NULL) and
		// its visible after-row (role NULL, what was stored).
		const tm = (await sql.unsafe(
			`SELECT tipo, bulk_process_id, tm_role, data IS NULL AS absent FROM matrix_time_machine
			  WHERE section_tipo = 'test3' AND section_id = $1 ORDER BY id ASC`,
			[SCRATCH_ID],
		)) as {
			tipo: string;
			bulk_process_id: number | null;
			tm_role: number | null;
			absent: boolean;
		}[];
		expect(tm.map((row) => [row.tipo, row.tm_role, row.absent])).toEqual([
			['test3', 3, false],
			['test52', 1, true],
			['test52', null, false],
		]);
		for (const row of tm) expect(row.bulk_process_id).toBe(report.bulk_process_id as number);
	});

	test('a flat human-authored DMY date IMPORTS (the capability the port was missing)', async () => {
		// test145 is component_date. '26/10/2023' in a column named test145_dmy is
		// exactly what a curator's spreadsheet contains — and until the importConform
		// facets landed, every such cell was refused and the column stayed empty.
		writeFileSync(resolve(userDir, CSV), `section_id;test145_dmy\n${SCRATCH_ID};26/10/2023\n`);
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: SCRATCH_USER,
			background: false,
			options: {
				files: [
					{
						file: CSV,
						section_tipo: 'test3',
						ar_columns_map: [
							{ tipo: 'section_id', model: 'section_id' },
							{
								tipo: 'test145_dmy',
								model: 'component_date',
								checked: true,
								map_to: 'test145',
							},
						],
					},
				],
			},
		});
		const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
		bulkProcessIds.push(report.bulk_process_id as number);
		expect(report.failed).toEqual([]);

		// The suffix chose the field order: 26 is the DAY, not the month.
		const rows = (await sql.unsafe(
			`SELECT date -> 'test145' AS items
			   FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`,
			[SCRATCH_ID],
		)) as { items: { start?: Record<string, number> }[] }[];
		const stored = rows[0]?.items ?? [];
		// The PERSISTED shape carries the virtual-calendar sort key: PHP
		// component_date::save() calls add_time() on every non-empty item, and the TS
		// twin does the same in save_component.ts (addTimeToDateItem). Every
		// PHP-written date row in a live install has it, so a stored date WITHOUT
		// `time` is the bug — it cannot be range-searched or ordered.
		expect(stored[0]?.start).toEqual({
			day: 26,
			month: 10,
			year: 2023,
			time: ddDateToSeconds({ day: 26, month: 10, year: 2023 }),
		});
		// Pinned literal: 2023*372*86400 + 9*31*86400 + 25*86400 (0-based month/day).
		expect(stored[0]?.start?.time).toBe(65047104000);
	});

	test('a v6 multi-language export cell imports EVERY language (set_data_lang parity)', async () => {
		// The v6 raw-export shape for a translatable input_text: a lang-keyed object
		// of BARE strings, no dedalo_data wrapper (export_Ontologies_main_*.csv).
		// Each language must be persisted as its own lang-stamped slice — the bug
		// this pins: per-lang set_data was a full-array replace, so only the LAST
		// language survived, without a lang stamp.
		const cell =
			'{""lg-cat"":[""Dédalo cat | dd""],""lg-eng"":[""Dedalo eng | dd""],""lg-spa"":[""Dédalo spa | dd""]}';
		writeFileSync(resolve(userDir, CSV), `section_id;test52\n${SCRATCH_ID};"${cell}"\n`);
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: SCRATCH_USER,
			background: false,
			options: {
				files: [
					{
						file: CSV,
						section_tipo: 'test3',
						ar_columns_map: [
							{ tipo: 'section_id', model: 'section_id' },
							{ tipo: 'test52', model: 'component_input_text', checked: true, map_to: 'test52' },
						],
					},
				],
			},
		});
		const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
		bulkProcessIds.push(report.bulk_process_id as number);
		expect(report.failed).toEqual([]);

		const rows = (await sql.unsafe(
			`SELECT string -> 'test52' AS items
			   FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`,
			[SCRATCH_ID],
		)) as { items: { value?: string; lang?: string; id?: number }[] }[];
		const stored = rows[0]?.items ?? [];
		const byLang = new Map(stored.map((item) => [item.lang, item]));
		// All three languages present, each stamped and id-carrying.
		expect([...byLang.keys()].sort()).toEqual(['lg-cat', 'lg-eng', 'lg-spa']);
		expect(byLang.get('lg-cat')?.value).toBe('Dédalo cat | dd');
		expect(byLang.get('lg-eng')?.value).toBe('Dedalo eng | dd');
		expect(byLang.get('lg-spa')?.value).toBe('Dédalo spa | dd');
		for (const item of stored) expect(typeof item.id).toBe('number');

		// A follow-up FLAT import replaces ONLY the import lang's slice (PHP
		// set_data_lang), never the sibling translations.
		writeFileSync(resolve(userDir, CSV), `section_id;test52\n${SCRATCH_ID};replaced flat\n`);
		const res2 = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: SCRATCH_USER,
			background: false,
			options: {
				files: [
					{
						file: CSV,
						section_tipo: 'test3',
						ar_columns_map: [
							{ tipo: 'section_id', model: 'section_id' },
							{ tipo: 'test52', model: 'component_input_text', checked: true, map_to: 'test52' },
						],
					},
				],
			},
		});
		const report2 = (res2.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
		bulkProcessIds.push(report2.bulk_process_id as number);
		expect(report2.failed).toEqual([]);

		const rows2 = (await sql.unsafe(
			`SELECT string -> 'test52' AS items
			   FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`,
			[SCRATCH_ID],
		)) as { items: { value?: string; lang?: string }[] }[];
		const stored2 = rows2[0]?.items ?? [];
		const importLang = config.menu.dataLang;
		const replaced = stored2.filter((item) => item.lang === importLang);
		expect(replaced).toHaveLength(1);
		expect(replaced[0]?.value).toBe('replaced flat');
		// The OTHER languages survived the flat save.
		const others = stored2.filter((item) => item.lang !== importLang).map((item) => item.lang);
		expect(others.sort()).toEqual(
			['lg-cat', 'lg-eng', 'lg-spa'].filter((code) => code !== importLang),
		);
	});

	test('an unchecked column is not imported, and a row without section_id is skipped', async () => {
		writeFileSync(resolve(userDir, CSV), 'section_id;test52\n;skipped row\n');
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: SCRATCH_USER,
			background: false,
			options: {
				files: [
					{
						file: CSV,
						section_tipo: 'test3',
						ar_columns_map: [
							{ tipo: 'section_id', model: 'section_id' },
							{ tipo: 'test52', model: 'component_input_text', checked: true, map_to: 'test52' },
						],
					},
				],
			},
		});
		const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
		bulkProcessIds.push(report.bulk_process_id as number);
		expect(report.created).toEqual([]);
		expect(report.updated).toEqual([]);
		expect(String(report.errors[0])).toContain('section_id');
	});

	test('publishes live progress frames while it runs (the panel is fed, not static)', async () => {
		writeFileSync(resolve(userDir, CSV), `section_id;test52\n${SCRATCH_ID};progress row\n`);
		const frames: ImportProgressFrame[] = [];
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: SCRATCH_USER,
			background: true,
			publishProgress: (data: object) => frames.push(data as ImportProgressFrame),
			options: {
				files: [
					{
						file: CSV,
						section_tipo: 'test3',
						ar_columns_map: [
							{ tipo: 'section_id', model: 'section_id' },
							{ tipo: 'test52', model: 'component_input_text', checked: true, map_to: 'test52' },
						],
					},
				],
			},
		});
		bulkProcessIds.push(
			(res.data as { files: ImportFileReport[] }).files[0]?.bulk_process_id as number,
		);
		// At minimum the 'reading' phase frame — and it carries the file identity and
		// the batch position the progress bar needs.
		expect(frames.length).toBeGreaterThan(0);
		const first = frames[0] as ImportProgressFrame;
		expect(first.phase).toBe('reading');
		expect(first.file).toBe(CSV);
		expect(first.file_index).toBe(1);
		expect(first.files_total).toBe(1);
	});
});

describe('path traversal is REFUSED (fail-closed, canary-verified)', () => {
	// importDir() has no root-override seam, so these use a disposable user id
	// under the real media root (filesystem-only scratch; removed in afterAll).
	const SCRATCH_USER = 987654;
	const root = config.media.rootPath ?? '';
	const userDir = resolve(root, 'import/files', String(SCRATCH_USER));
	// Canary ONE level above the per-user dir: exactly the file a '../' escape
	// from delete_csv_file would move. It must survive every attempt below.
	const canary = resolve(root, 'import/files', `canary_${process.pid}.csv`);

	async function callAction(name: string, options: Record<string, unknown>) {
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const handler = mustGet(loaded!.module.apiActions[name], name).handler;
		return handler({
			principal: await resolvePrincipal(-1),
			userId: SCRATCH_USER,
			background: false,
			options,
		});
	}

	beforeAll(() => {
		mkdirSync(userDir, { recursive: true });
		writeFileSync(canary, 'canary — must never be deleted/moved by a traversal');
	});
	afterAll(() => {
		rmSync(userDir, { recursive: true, force: true });
		rmSync(canary, { force: true });
		rmSync(resolve(root, config.media.upload.tmpSubdir, String(SCRATCH_USER)), {
			recursive: true,
			force: true,
		});
	});

	test('delete_csv_file refuses ../, absolute and %2f-encoded file_name (canary untouched)', async () => {
		for (const file_name of [
			`../canary_${process.pid}.csv`, // relative escape to the canary
			'../../../etc/passwd', // deep relative escape
			canary, // absolute path
			'/etc/passwd', // absolute system path
			`..%2fcanary_${process.pid}.csv`, // encoded '../' — must NOT be decoded into a traversal
			'..%2f..%2fetc%2fpasswd',
		]) {
			// Refused by a THROW (the path guards are still untyped engine throws;
			// the tool's own refusals are registered codes). Either way nothing runs.
			expect(callAction('delete_csv_file', { file_name })).rejects.toThrow();
		}
		expect(existsSync(canary)).toBe(true); // nothing outside the user dir was touched
		expect(existsSync('/etc/passwd')).toBe(true);
	});

	// get_csv_files takes NO client path (it lists the confined per-user dir), so
	// it has no traversal surface to deny-test.

	test('process_uploaded_file refuses a staged source path escaping the upload root', async () => {
		for (const file_data of [
			{ key_dir: '', tmp_name: '../../../../../etc/passwd' },
			{ key_dir: '', tmp_name: '/etc/passwd' },
			{ key_dir: '../../../../../etc', tmp_name: 'passwd' },
		]) {
			expect(callAction('process_uploaded_file', { file_data })).rejects.toThrow();
		}
		expect(existsSync('/etc/passwd')).toBe(true); // never moved into the import dir
		expect(existsSync(resolve(userDir, 'passwd'))).toBe(false);
	});

	test('process_uploaded_file refuses key_dir="../<other_uid>" claiming another user\'s staged upload (SEC parity w/ sanitize_key_dir)', async () => {
		// A victim stages an upload under their own tmp dir.
		const VICTIM = 987655;
		const victimStaging = resolve(root, config.media.upload.tmpSubdir, String(VICTIM));
		mkdirSync(victimStaging, { recursive: true });
		const victimFile = resolve(victimStaging, 'victim.csv');
		writeFileSync(victimFile, 'a;b\n1;2\n');
		try {
			// SCRATCH_USER tries to reach it via key_dir='../<VICTIM>'. That path stays
			// INSIDE the shared staging root (so the old root-only check passed), but
			// sanitizeSegment rejects the '..' segment fail-closed.
			await expect(
				callAction('process_uploaded_file', {
					file_data: { key_dir: `../${VICTIM}`, tmp_name: 'victim.csv' },
				}),
			).rejects.toThrow();
			expect(existsSync(victimFile)).toBe(true); // the victim's file was NOT moved/claimed
			expect(existsSync(resolve(userDir, 'victim.csv'))).toBe(false);
		} finally {
			rmSync(victimStaging, { recursive: true, force: true });
		}
	});

	test('process_uploaded_file refuses a destination file_name escaping the import dir (staged file stays)', async () => {
		const stagingDir = resolve(root, config.media.upload.tmpSubdir, String(SCRATCH_USER), 'kd');
		mkdirSync(stagingDir, { recursive: true });
		const staged = resolve(stagingDir, 'real.csv');
		writeFileSync(staged, 'a;b\n1;2\n');
		const escaped = resolve(root, 'import', `escape_${process.pid}.csv`);
		await expect(
			callAction('process_uploaded_file', {
				file_data: {
					key_dir: 'kd',
					tmp_name: 'real.csv',
					file_name: `../../escape_${process.pid}.csv`,
				},
			}),
		).rejects.toThrow();
		expect(existsSync(staged)).toBe(true); // the source was NOT moved
		expect(existsSync(escaped)).toBe(false); // nothing landed outside the import dir
	});
});

/**
 * THE SECTION-INFO COLUMNS (dd196's component children). PHP
 * get_section_components_list appended them to every section's list; the port
 * walked only the section's own subtree, so an exported CSV's dd199/dd200/…
 * columns came up UNMAPPED in the mapper and "not a component of section" in
 * the preflight — while the write door (import_csv_execute's dual write)
 * already handled them. Offered to GLOBAL ADMINS only: the write door IGNORES
 * them for everyone else (componentRefusal), and the mapper must never offer a
 * column the door then drops. For the same reason a DERIVED model (dd1596
 * component_inverse, component_relation_children, …) is never offered: the door
 * refuses it in every mode. It stays a validate_import MEMBER, so a hand-made
 * map onto one gets the precise derived refusal. Read-only gate: validate_import writes nothing;
 * the scratch import dir is removed in afterAll.
 */
describe('section-info columns (dd196 children) are offered and validate', () => {
	/** dd196's OFFERED component children, in ontology order (the PHP list
	 * minus the derived dd1596 component_inverse — never offered). */
	const SECTION_INFO = ['dd200', 'dd199', 'dd197', 'dd201', 'dd271', 'dd1223', 'dd1224', 'dd1225'];
	/** dd196's derived child: a member, never offered. */
	const DERIVED_INFO = 'dd1596';
	const SCRATCH_USER = 987678;
	const root = config.media.rootPath ?? '';
	const userDir = resolve(root, 'import/files', String(SCRATCH_USER));
	const CSV = 'section_info_validate.csv';
	/** A principal the resolver would build for a non-admin account. */
	const NON_ADMIN = Object.freeze({
		userId: SCRATCH_USER,
		isGlobalAdmin: false,
		isDeveloper: false,
	});

	beforeAll(() => mkdirSync(userDir, { recursive: true }));
	afterAll(() => rmSync(userDir, { recursive: true, force: true }));

	/** A section with no component children (only a grouper) … */
	const EMPTY = 'zzcsvi1';
	/** … and a sibling with one, the control. */
	const WITH_OWN = 'zzcsvi3';
	const WITH_OWN_COMPONENT = 'zzcsvi4';
	const EMPTY_SITUATION = situation({
		name: 'import csv section-info own-components rule',
		tld: 'zzcsvi',
		nodes: [
			{
				tipo: EMPTY,
				parent: 'test1',
				model: 'section',
				order_number: 91,
				term: { 'lg-eng': 'Empty' },
			},
			{
				tipo: 'zzcsvi2',
				parent: EMPTY,
				model: 'section_group',
				order_number: 1,
				term: { 'lg-eng': 'Group' },
			},
			{
				tipo: WITH_OWN,
				parent: 'test1',
				model: 'section',
				order_number: 92,
				term: { 'lg-eng': 'With own' },
			},
			{
				tipo: WITH_OWN_COMPONENT,
				parent: WITH_OWN,
				model: 'component_input_text',
				order_number: 1,
				term: { 'lg-eng': 'Text' },
			},
		],
	});

	async function listFor(
		sectionTipo: string,
		principal: { userId: number; isGlobalAdmin: boolean; isDeveloper: boolean },
	): Promise<{ value: string; model: string; import_append: unknown }[]> {
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(
			loaded!.module.apiActions.get_section_components_list,
			'get_section_components_list',
		).handler({
			principal,
			userId: principal.userId,
			background: false,
			options: { section_tipo: sectionTipo },
		});
		return (res.data as { components: { value: string; model: string; import_append: unknown }[] })
			.components;
	}

	async function validate(
		csv: string,
		columnsMap: Record<string, unknown>[],
		principal: { userId: number; isGlobalAdmin: boolean; isDeveloper: boolean },
	): Promise<{ ok: boolean; errors: string[]; failed: unknown[] }> {
		writeFileSync(resolve(userDir, CSV), csv);
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(loaded!.module.apiActions.validate_import, 'validate_import').handler(
			{
				principal,
				userId: SCRATCH_USER,
				background: false,
				options: { files: [{ file: CSV, section_tipo: SECTION, ar_columns_map: columnsMap }] },
			},
		);
		return (res.data as { files: { ok: boolean; errors: string[]; failed: unknown[] }[] })
			.files[0] as { ok: boolean; errors: string[]; failed: unknown[] };
	}

	test('a REAL section lists every dd196 child for an admin, after its own components, in ontology order', async () => {
		const list = await listFor(SECTION, await resolvePrincipal(-1));
		const values = list.map((el) => el.value);
		const infoValues = values.filter((value) => SECTION_INFO.includes(value));
		expect(infoValues).toEqual(SECTION_INFO);
		// Appended AFTER the section's own components (PHP order), each once.
		const firstInfo = values.indexOf('dd200');
		expect(values.indexOf('test52')).toBeGreaterThanOrEqual(0);
		expect(values.indexOf('test52')).toBeLessThan(firstInfo);
		expect(new Set(values).size).toBe(values.length);
		// The append offer: the audit stamps never offer it.
		for (const tipo of ['dd199', 'dd200', 'dd197', 'dd201']) {
			expect(list.find((el) => el.value === tipo)?.import_append, tipo).toBeNull();
		}
	});

	test('a VIRTUAL section (test0 → ontology1) lists them too', async () => {
		const values = (await listFor('test0', await resolvePrincipal(-1))).map((el) => el.value);
		expect(values).toContain('ontology3'); // its real section's own components
		expect(values.filter((value) => SECTION_INFO.includes(value))).toEqual(SECTION_INFO);
	});

	test('a NON-ADMIN is offered none of them (the door would ignore the column)', async () => {
		const values = (await listFor(SECTION, NON_ADMIN)).map((el) => el.value);
		expect(values).toContain('test52'); // the own components are still there
		expect(values.filter((value) => SECTION_INFO.includes(value))).toEqual([]);
	});

	test('a section with NO components of its own lists no section-info (built zz situation)', async () => {
		const admin = await resolvePrincipal(-1);
		await dropSituation(EMPTY_SITUATION);
		try {
			await ensureSituation(EMPTY_SITUATION);
			// Control: the sibling WITH an own component gets the section-info
			// columns, so the empty one's [] is the own-components rule, not a
			// scratch section the walk cannot see.
			const withOwn = (await listFor(WITH_OWN, admin)).map((el) => el.value);
			expect(withOwn).toContain(WITH_OWN_COMPONENT);
			expect(withOwn.filter((value) => SECTION_INFO.includes(value))).toEqual(SECTION_INFO);
			expect(await listFor(EMPTY, admin)).toEqual([]);
		} finally {
			expect(await dropSituation(EMPTY_SITUATION)).toBe(0);
		}
	});

	test('the log sections that suppress section-info (dd542, dd15) list none of them', async () => {
		const admin = await resolvePrincipal(-1);
		for (const sectionTipo of ['dd542', 'dd15']) {
			const values = (await listFor(sectionTipo, admin)).map((el) => el.value);
			expect(values.length, `${sectionTipo} has own components`).toBeGreaterThan(0);
			expect(
				values.filter((value) => SECTION_INFO.includes(value)),
				sectionTipo,
			).toEqual([]);
		}
	});

	test('no listed item has a DERIVED model (the door refuses them in every mode)', async () => {
		const { isDerivedModel } = await import('../../src/core/components/registry.ts');
		const { getModelByTipo } = await import('../../src/core/ontology/resolver.ts');
		for (const sectionTipo of [SECTION, 'test0']) {
			const list = await listFor(sectionTipo, await resolvePrincipal(-1));
			expect(list.length, sectionTipo).toBeGreaterThan(0);
			for (const item of list) {
				const doorModel = (await getModelByTipo(item.value)) ?? item.model;
				expect(isDerivedModel(doorModel), `${sectionTipo}/${item.value} (${doorModel})`).toBe(
					false,
				);
			}
			expect(
				list.map((el) => el.value),
				sectionTipo,
			).not.toContain(DERIVED_INFO);
		}
	});

	/** A section owning a component_relation_children, an alias of it, and a text control. */
	const DERIVED_SECTION = 'zzcsvd1';
	const DERIVED_CHILDREN = 'zzcsvd2';
	const DERIVED_ALIAS = 'zzcsvd3';
	const DERIVED_CONTROL = 'zzcsvd4';
	const DERIVED_SITUATION = situation({
		name: 'import csv derived models not offered',
		tld: 'zzcsvd',
		nodes: [
			{
				tipo: DERIVED_SECTION,
				parent: 'test1',
				model: 'section',
				order_number: 93,
				term: { 'lg-eng': 'Derived owner' },
			},
			{
				tipo: DERIVED_CHILDREN,
				parent: DERIVED_SECTION,
				model: 'component_relation_children',
				order_number: 1,
				term: { 'lg-eng': 'Children' },
			},
			{
				tipo: DERIVED_ALIAS,
				parent: DERIVED_SECTION,
				model: 'component_alias',
				order_number: 2,
				term: { 'lg-eng': 'Children alias' },
				properties: { alias_of: DERIVED_CHILDREN },
			},
			{
				tipo: DERIVED_CONTROL,
				parent: DERIVED_SECTION,
				model: 'component_input_text',
				order_number: 3,
				term: { 'lg-eng': 'Text' },
			},
		],
	});

	test('a component_relation_children (and an alias of it) is NOT listed (built zz situation)', async () => {
		const admin = await resolvePrincipal(-1);
		await dropSituation(DERIVED_SITUATION);
		try {
			await ensureSituation(DERIVED_SITUATION);
			const values = (await listFor(DERIVED_SECTION, admin)).map((el) => el.value);
			// Control: the walk sees the scratch section (own text + section-info).
			expect(values).toContain(DERIVED_CONTROL);
			expect(values.filter((value) => SECTION_INFO.includes(value))).toEqual(SECTION_INFO);
			expect(values).not.toContain(DERIVED_CHILDREN);
			expect(values).not.toContain(DERIVED_ALIAS);
		} finally {
			expect(await dropSituation(DERIVED_SITUATION)).toBe(0);
		}
	});

	const KEY = { tipo: 'section_id', model: 'section_id' };
	const CREATED_DATE_COLUMN = {
		tipo: 'dd199_dmy',
		model: 'component_date',
		checked: true,
		map_to: 'dd199',
	};
	const CREATED_BY_COLUMN = {
		tipo: 'dd200',
		model: 'component_select',
		checked: true,
		map_to: 'dd200',
	};
	const INFO_CSV = 'section_id;dd199_dmy;dd200\n900800;21-05-1998;-1\n';

	test('validate_import ACCEPTS dd199/dd200 columns for an admin', async () => {
		const report = await validate(
			INFO_CSV,
			[KEY, CREATED_DATE_COLUMN, CREATED_BY_COLUMN],
			await resolvePrincipal(-1),
		);
		expect(report.errors).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.ok).toBe(true);
	});

	test('validate_import REFUSES them for a non-admin (never "validated clean, then ignored")', async () => {
		const report = await validate(
			INFO_CSV,
			[KEY, CREATED_DATE_COLUMN, CREATED_BY_COLUMN],
			NON_ADMIN,
		);
		expect(report.ok).toBe(false);
		const joined = report.errors.join(' ');
		expect(joined).toContain("maps to 'dd199', which is not a component of section");
		expect(joined).toContain("maps to 'dd200', which is not a component of section");
	});

	test('an APPEND on dd200 is refused (a record has one creator)', async () => {
		const report = await validate(
			INFO_CSV,
			[KEY, CREATED_DATE_COLUMN, { ...CREATED_BY_COLUMN, import_mode: 'append' }],
			await resolvePrincipal(-1),
		);
		expect(report.ok).toBe(false);
		const joined = report.errors.join(' ');
		expect(joined).toContain("'dd200' is a record audit field");
		// Refused as an AUDIT field — not because dd200 is missing from the list
		// (that would make ok=false for the wrong reason).
		expect(joined).not.toContain('not a component of section');
	});

	test('dd1596 (component_inverse) is not listed, refused as derived if hand-mapped', async () => {
		const report = await validate(
			'section_id;dd1596\n900800;x\n',
			[KEY, { tipo: 'dd1596', model: 'component_inverse', checked: true, map_to: 'dd1596' }],
			await resolvePrincipal(-1),
		);
		expect(report.ok).toBe(false);
		const joined = report.errors.join(' ');
		expect(joined).toContain('dd1596, component_inverse): refused — derived');
		// Refused as DERIVED — not as "not a component of section" (it is still a
		// validate_import MEMBER; only the offer drops it).
		expect(joined).not.toContain('not a component of section');
	});
});

/**
 * T2-OX7-1b — the mapper's labels speak the REQUEST application lang (PHP
 * DEDALO_APPLICATION_LANG is per-request), not the install default: two
 * request langs → two labels. test3 and test22 (its component_number "Order"
 * / "Orden") are named differently per language — the floor below proves it,
 * or the two readings would coincide and the case prove nothing. The progress
 * case imports ONE row (empty test22 cell) at an explicit scratch id, removed
 * in afterAll with its TM + dd800 rows.
 */
describe('T2-OX7-1b: labels follow the request application lang', () => {
	const SCRATCH_USER = 987679;
	const root = config.media.rootPath ?? '';
	const userDir = resolve(root, 'import/files', String(SCRATCH_USER));
	const NAMED = 'test22';
	const LANES = ['lg-eng', 'lg-spa'] as const;
	const SCRATCH_ID = 900102;
	const bulkProcessIds: number[] = [];

	beforeAll(() => {
		mkdirSync(userDir, { recursive: true });
		writeFileSync(resolve(userDir, 'labels.csv'), `section_id;${NAMED}\n${SCRATCH_ID};\n`);
	});
	afterAll(async () => {
		rmSync(userDir, { recursive: true, force: true });
		await sql.unsafe(`DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`, [
			SECTION,
			SCRATCH_ID,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, SCRATCH_ID],
		);
		for (const id of bulkProcessIds) {
			await sql.unsafe(
				`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = $1`,
				[id],
			);
			await sql.unsafe(
				`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
				[id],
			);
		}
		const residue = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, SCRATCH_ID],
		)) as { n: number }[];
		expect(residue[0]?.n).toBe(0);
	});

	async function call(lang: string, name: string, options: Record<string, unknown>) {
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const handler = mustGet(loaded!.module.apiActions[name], name).handler;
		const principal = await resolvePrincipal(-1);
		return runWithRequestLangs({ applicationLang: lang, dataLang: lang }, () =>
			handler({ principal, userId: SCRATCH_USER, background: false, options }),
		);
	}

	test('floor: the section and the column are named differently per lang', async () => {
		expect(await termByTipo(SECTION, 'lg-eng')).not.toBe(await termByTipo(SECTION, 'lg-spa'));
		expect(await termByTipo(NAMED, 'lg-eng')).not.toBe(await termByTipo(NAMED, 'lg-spa'));
	});

	test('get_section_components_list: section + component labels in the request lang', async () => {
		const differing = new Set<string>();
		for (const lang of LANES) {
			const res = await call(lang, 'get_section_components_list', { section_tipo: SECTION });
			const payload = res.data as { components: { value: string; label: string }[]; label: string };
			expect(payload.label, lang).toBe(await termByTipo(SECTION, lang));
			for (const item of payload.components) {
				expect(item.label, `${lang} ${item.value}`).toBe(await termByTipo(item.value, lang));
				if ((await termByTipo(item.value, 'lg-eng')) !== (await termByTipo(item.value, 'lg-spa'))) {
					differing.add(item.value);
				}
			}
		}
		// FLOOR: at least one listed component is named differently per lang.
		expect(differing.size).toBeGreaterThan(0);
	});

	test('get_csv_files: the column map labels in the request lang', async () => {
		for (const lang of LANES) {
			const res = await call(lang, 'get_csv_files', {});
			const { files } = res.data as {
				files: { name: string; ar_columns_map: ({ tipo: string; label: string } | null)[] }[];
			};
			const file = files.find((item) => item.name === 'labels.csv');
			const column = file?.ar_columns_map.find((item) => item?.tipo === NAMED);
			expect(column?.label, lang).toBe(await termByTipo(NAMED, lang));
		}
	});
	test('import_files: the progress frame names the column in the request lang', async () => {
		for (const lang of LANES) {
			const frames: ImportProgressFrame[] = [];
			const loaded = await getLoadedTool('tool_import_dedalo_csv');
			const handler = mustGet(loaded!.module.apiActions.import_files, 'import_files').handler;
			const principal = await resolvePrincipal(-1);
			const res = await runWithRequestLangs({ applicationLang: lang, dataLang: lang }, () =>
				handler({
					principal,
					userId: SCRATCH_USER,
					background: true,
					publishProgress: (data: object) => frames.push(data as ImportProgressFrame),
					options: {
						files: [
							{
								file: 'labels.csv',
								section_tipo: SECTION,
								ar_columns_map: [
									{ tipo: 'section_id', model: 'section_id' },
									{ tipo: NAMED, model: 'component_number', checked: true, map_to: NAMED },
								],
							},
						],
					},
				}),
			);
			const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
			if (typeof report.bulk_process_id === 'number') bulkProcessIds.push(report.bulk_process_id);
			expect(report.ok, lang).toBe(true);
			const labelled = frames.filter((frame) => frame.component_label != null);
			// FLOOR: the first importing tick names the column (it is never throttled).
			expect(labelled.length, lang).toBeGreaterThan(0);
			for (const frame of labelled) {
				expect(frame.component_label, lang).toBe(await termByTipo(NAMED, lang));
			}
		}
	});
});
