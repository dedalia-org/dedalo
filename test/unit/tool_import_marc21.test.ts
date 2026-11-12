/**
 * R2 gate: tool_import_marc21. The ISO 2709 parser itself is covered by
 * marc21.test.ts / marc21_map.test.ts; this file gates the TOOL — its action
 * surface, the STAGED-FILE wire (PHP prepare_import_context :218 +
 * process_marc21_file :294) and the config-map read — plus one end-to-end write
 * drive against a scratch record in the test3 playground.
 *
 * Three defects this pins (all found by the 2026-07 tools audit):
 *  1. the module read the staged path from `files_data[].tmp_name` /
 *     `files_data[].key_dir`, which the service_dropzone descriptor NEVER
 *     carries — the real client posts `key_dir` ONCE at the top level and only
 *     `{name, size, …}` per file, so every import read a directory and failed;
 *  2. key_dir was interpolated UNSANITIZED into the staging path, so
 *     `key_dir:'../<other uid>'` stayed inside the shared staging root and let
 *     one user's import consume another user's staged upload;
 *  3. the field→component bindings were read from `config.main` instead of
 *     `config.map`, so the mapper matched nothing and every import wrote
 *     zero components.
 *
 * T1-6 (2026-11-12): the map is the SERVER's (Tools configuration dd996 over
 * the register default dd1633) — every drive here installs its own scratch
 * dd996 config (test/helpers/tool_config_fixture.ts) and posts the REAL client
 * shape, `tool_config: {ddo_map}` — and the PHP value semantics are ported
 * (first occurrence, field_multiple, conditional fallback, transforms,
 * dd_action, the Values form). WC-2026-11-12-marc21-config-map-and-transforms.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { readComponentItems } from '../../src/core/resolve/component_data.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	readTemporalScratch,
	writeTemporalScratch,
} from '../../src/core/section/record/temporal_store.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import {
	importMarc21Targets,
	parseMarcConfig,
	resolveStagedFile,
} from '../../tools/tool_import_marc21/server/index.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf, refusalOfSync } from '../helpers/refusal.ts';
import { installScratchToolConfig } from '../helpers/tool_config_fixture.ts';

const FT = '\x1e'; // field terminator
const SD = '\x1f'; // subfield delimiter
const RT = '\x1d'; // record terminator

interface FieldSpec {
	tag: string;
	value?: string;
	ind1?: string;
	ind2?: string;
	subfields?: [string, string][];
}

/** Assemble a valid ISO 2709 record from field specs (twin of marc21.test.ts). */
function buildMarc(fields: FieldSpec[]): Uint8Array {
	const bodies = fields.map((f) => {
		if (f.value !== undefined) return `${f.value}${FT}`;
		const subs = (f.subfields ?? []).map(([code, val]) => `${SD}${code}${val}`).join('');
		return `${f.ind1 ?? ' '}${f.ind2 ?? ' '}${subs}${FT}`;
	});
	let directory = '';
	let start = 0;
	for (let i = 0; i < fields.length; i++) {
		const len = new TextEncoder().encode(bodies[i] as string).length;
		directory +=
			(fields[i] as FieldSpec).tag + String(len).padStart(4, '0') + String(start).padStart(5, '0');
		start += len;
	}
	directory += FT;
	const baseAddress = 24 + directory.length;
	const data = bodies.join('') + RT;
	const recordLength = baseAddress + new TextEncoder().encode(data).length;
	const leader = `${String(recordLength).padStart(5, '0')}nam a22${String(baseAddress).padStart(5, '0')}n a4500`;
	return new TextEncoder().encode(leader + directory + data);
}

describe('tool_import_marc21 module', () => {
	test('loads with import_files only, gated WRITE and backgroundRunnable', async () => {
		const loaded = await getLoadedTool('tool_import_marc21');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions)).toEqual(['import_files']);
		const spec = mustGet(actions.import_files, 'import_files');
		expect(spec.minLevel).toBe(2);
		expect(loaded!.module.backgroundRunnable).toEqual(['import_files']);
	});
});

describe('resolveStagedFile (the staged-name confinement)', () => {
	const dir = '/tmp/dedalo_staging_probe';

	test('reproduces the upload receivers name transform', () => {
		// receiveUpload wrote the file as stagedTmpName(client name): every
		// character outside [A-Za-z0-9_.-] became '_'. Reading it back with the
		// RAW client name would miss the file the client just uploaded.
		expect(resolveStagedFile(dir, 'records (1).mrc')).toBe(`${dir}/records__1_.mrc`);
		expect(resolveStagedFile(dir, 'plain.mrc')).toBe(`${dir}/plain.mrc`);
	});

	test('a traversal name never escapes the staging dir', () => {
		// AMENDED 2026-08-03 (WC-2026-08-03-chunked-upload-identity): the transform
		// now prefixes a leading dot ('..' → '_..'), because a dot-leading staged
		// file would be invisible to listStagedFiles and could collide with the
		// `.up_<id>` artifact dirs. A traversal payload is therefore neutralized by
		// the transform itself and lands INSIDE the dir rather than being caught by
		// the confinement check — which still runs, and is still what the guarantee
		// rests on.
		expect(resolveStagedFile(dir, '..')).toBe(`${dir}/_..`);
		// A traversal payload is reduced to its last segment (never escapes).
		expect(resolveStagedFile(dir, '../../etc/passwd.mrc')).toBe(`${dir}/passwd.mrc`);
	});

	test('a forwarded tmp_name is preferred over the legacy derivation', () => {
		// The staged name is SERVER-ASSIGNED now: two client names that sanitize
		// alike become 'x.mrc' and 'x-1.mrc', so the display name cannot locate the
		// file and the client's forwarded value is the authoritative answer.
		expect(resolveStagedFile(dir, 'records (1).mrc', 'records__1_-1.mrc')).toBe(
			`${dir}/records__1_-1.mrc`,
		);
		// It is still client input: an unsafe segment is refused outright.
		expect(() => resolveStagedFile(dir, 'x.mrc', '../../etc/passwd')).toThrow();
	});

	/**
	 * RESTORES THE COVERAGE THE AMENDMENT ABOVE LOST (S-5b, 2026-08-03).
	 *
	 * `resolveStagedFile`'s `return null` used to be driven by the `'..'` case.
	 * Since the transform prefixes a leading dot, '..' becomes '_..' and that
	 * branch is now UNREACHABLE — a fact stated in-code at the function itself.
	 * An unreachable branch cannot be gated, so what is gated instead is the
	 * PROPERTY the branch exists to guarantee: no client name, however hostile,
	 * resolves outside the staging dir — either it lands inside, or it throws.
	 *
	 * This is the stronger test of the two: it covers every input shape rather
	 * than the one that happened to reach a particular return statement.
	 */
	test('NO hostile client name resolves outside the staging dir', () => {
		const hostile = [
			'..',
			'../..',
			'../../etc/passwd',
			'....//....//etc/passwd',
			'/etc/passwd',
			'/etc/passwd.mrc',
			'.',
			'.hidden.mrc',
			'..\\..\\windows\\system32',
			'a\u0000b.mrc',
			'—unicode—.mrc',
			'con:.mrc',
			'%2e%2e%2fpasswd.mrc',
			'  .. ',
			'x'.repeat(300),
			'',
		];
		for (const name of hostile) {
			let resolved: string | null;
			try {
				resolved = resolveStagedFile(dir, name);
			} catch {
				continue; // refused outright — also a safe answer
			}
			// Never null in practice (the branch is unreachable), and never outside.
			expect(resolved === null || resolved.startsWith(`${dir}/`), `escaped for '${name}'`).toBe(
				true,
			);
			if (resolved !== null) {
				// One segment deep: nothing traversed, nothing nested.
				expect(resolved.slice(dir.length + 1).includes('/'), `nested for '${name}'`).toBe(false);
			}
		}
	});

	/**
	 * The same forwarded-name path, but exercised where it can actually reach the
	 * filesystem: a forwarded value that survives sanitizeSegment must still be
	 * confined, and a legacy derivation over a dir with collision candidates must
	 * REFUSE rather than resolve to the stale file (BL-2).
	 */
	test('the ambiguous-staging refusal propagates through the tool', async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const probe = mkdtempSync(`${tmpdir()}/dedalo_marc21_amb_`);
		try {
			writeFileSync(`${probe}/records.mrc`, 'the superseded file');
			writeFileSync(`${probe}/records-1.mrc`, 'the corrected file');
			// Both present + no forwarded tmp_name = unknowable. Returning the legacy
			// name here imported the SUPERSEDED scan under the right record.
			expect(() => resolveStagedFile(probe, 'records.mrc')).toThrow(/ambiguous/);
			// With the server's own tmp_name there is nothing to guess.
			expect(resolveStagedFile(probe, 'records.mrc', 'records-1.mrc')).toBe(
				`${probe}/records-1.mrc`,
			);
		} finally {
			rmSync(probe, { recursive: true, force: true });
		}
	});
});

describe('import_files (scratch record in the test3 playground, cleaned up)', () => {
	const SCRATCH_USER = 987657;
	const SCRATCH_ID = 900301; // far outside the canonical test3 ids (1, 2, 27)
	const KEY_DIR = 'marc21_scratch';
	const MRC = 'scratch.mrc';
	const DUP_MRC = 'duplicate_code.mrc';
	/** One control number carried by two records of the same batch. */
	const DUP_CODE = 'marc21-dup-900301';
	const stagingRoot = resolve(
		config.media.rootPath ?? '',
		config.media.upload.tmpSubdir,
		String(SCRATCH_USER),
	);
	const stagedDir = resolve(stagingRoot, KEY_DIR);

	/** The component this section stores an imported record's CODE in. */
	const CODE_COMPONENT = 'test162';

	// The REAL config shape (getToolConfig resolves dd996 over dd1633 per key,
	// flat): bindings under `map` keyed by `tipo`; `field_to_section_id` under
	// `main`; and the `id` entry, which is BOTH the code-component declaration
	// (ddo_map, how PHP's get_section_id_from_code found the record) and an
	// ordinary binding — its own field/tipo write the control number INTO that
	// component, which is what makes the NEXT import of the same file find the
	// record. Installed as the SERVER's config (T1-6); the client posts only its
	// ddo_map, `toolConfig` below.
	const serverConfig = {
		main: [{ name: 'field_to_section_id', value: { field: '907', subfield: 'a' } }],
		map: [
			{ info: 'Title mention', field: '245', subfield: 'a', tipo: 'test52' },
			{
				info: 'Control number',
				name: 'id',
				field: '907',
				subfield: 'a',
				tipo: CODE_COMPONENT,
				ddo_map: [{ tipo: CODE_COMPONENT, section_tipo: 'test3' }],
			},
		],
	};
	/** What render_tool_import_marc21 posts: the ontology tool_config (ddo_map only). */
	const toolConfig = { ddo_map: [] };
	let teardownConfig: () => Promise<void> = async () => {};
	/** Run `fn` under another server config, restoring `serverConfig` after. */
	const withConfig = async <T>(cfg: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
		await installScratchToolConfig('tool_import_marc21', cfg);
		try {
			return await fn();
		} finally {
			teardownConfig = await installScratchToolConfig('tool_import_marc21', serverConfig);
		}
	};

	/** Every test3 record whose code component holds `code` — the run's own output. */
	const recordsWithCode = async (code: string): Promise<number[]> => {
		const rows = (await sql.unsafe(
			`SELECT section_id, string -> $1::text AS items
			   FROM matrix_test
			  WHERE section_tipo = 'test3' AND string ? $1::text`,
			[CODE_COMPONENT],
		)) as { section_id: number; items: { value?: unknown }[] | null }[];
		return rows
			.filter((row) => (row.items ?? []).some((item) => item?.value === code))
			.map((row) => Number(row.section_id));
	};

	/** The import report the ok envelope carries as `data` (P1 error sweep). */
	interface ImportReport {
		summary: string;
		errors: string[];
		created: number;
		updated: number;
		failed: unknown[];
	}
	const runImportRaw = async (options: Record<string, unknown>): Promise<ToolResponse> => {
		const loaded = await getLoadedTool('tool_import_marc21');
		return mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: SCRATCH_USER,
			background: false,
			options,
		});
	};
	/** A batch that RUNS answers ok:true; the report is its data. */
	const runImport = async (options: Record<string, unknown>): Promise<ImportReport> => {
		const res = (await runImportRaw(options)) as { ok: boolean; data: ImportReport };
		expect(res.ok).toBe(true);
		return res.data;
	};

	beforeAll(async () => {
		teardownConfig = await installScratchToolConfig('tool_import_marc21', serverConfig);
		mkdirSync(stagedDir, { recursive: true });
		writeFileSync(
			resolve(stagedDir, MRC),
			buildMarc([
				{ tag: '907', subfields: [['a', String(SCRATCH_ID)]] },
				{ tag: '245', ind1: '1', ind2: '0', subfields: [['a', 'A MARC21 title']] },
			]),
		);
		// TWO records, ONE control number: the file names one record twice.
		const twin = (title: string): Uint8Array =>
			buildMarc([
				{ tag: '907', subfields: [['a', DUP_CODE]] },
				{ tag: '245', ind1: '1', ind2: '0', subfields: [['a', title]] },
			]);
		const first = twin('The first claim');
		const second = twin('The second claim');
		const both = new Uint8Array(first.length + second.length);
		both.set(first);
		both.set(second, first.length);
		writeFileSync(resolve(stagedDir, DUP_MRC), both);
		await createSectionRecord('test3', SCRATCH_USER, new Date(), SCRATCH_ID, {
			conflictTolerant: true,
		});
	});

	afterAll(async () => {
		await teardownConfig();
		rmSync(stagingRoot, { recursive: true, force: true });
		// The records the RUNS created (the door creates when the code matches
		// nothing), found by the code they carry — the ids are the engine's, not
		// ours, so they cannot be hard-coded here.
		for (const code of [String(SCRATCH_ID), DUP_CODE]) {
			for (const id of await recordsWithCode(code)) {
				if (id === SCRATCH_ID) continue;
				await sql.unsafe(
					`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`,
					[id],
				);
				await sql.unsafe(
					`DELETE FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = $1`,
					[id],
				);
			}
		}
		await sql.unsafe(`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`, [
			SCRATCH_ID,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = $1`,
			[SCRATCH_ID],
		);
	});

	/**
	 * THE DATA-08 GATE (2026-08-30): AN IMPORTED CONTROL NUMBER IS NOT AN ADDRESS.
	 *
	 * The staged file's 907$a is the string '900301', and record 900301 of test3
	 * EXISTS (beforeAll creates it) — but nothing has ever written '900301' into
	 * its code component. Until this fix the value was cast to a section_id, so
	 * this import UPDATED record 900301: an ILS control number silently overwrote
	 * a curated record that had nothing to do with it, and this test asserted that
	 * as the rule (`expect(res.updated).toBe(1)`). It now resolves through the code
	 * component, finds nothing, and CREATES — which is what PHP's
	 * resolve_target_section did.
	 */
	test('a control number that matches no code CREATES, and never addresses the record with that id', async () => {
		// The exact wire render_tool_import_marc21 posts.
		const res = await runImport({
			tipo: 'test52',
			section_tipo: 'test3',
			section_id: 1,
			tool_config: toolConfig,
			files_data: [{ name: MRC, size: 1 }],
			components_temp_data: [],
			key_dir: KEY_DIR,
		});
		expect(res.errors).toEqual([]);
		expect(res.created).toBe(1);
		expect(res.updated).toBe(0);
		expect(res.failed).toEqual([]);

		// THE RECORD THE OLD CAST WOULD HAVE WRITTEN: untouched.
		const victim = (await sql.unsafe(
			`SELECT string -> 'test52' AS items
			   FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`,
			[SCRATCH_ID],
		)) as { items: { value?: string }[] | null }[];
		expect((victim[0]?.items ?? []).map((item) => item.value)).not.toContain('A MARC21 title');

		// The record the run DID create carries both the mapped title and the
		// control number — the second is what makes the next import find it.
		const created = await recordsWithCode(String(SCRATCH_ID));
		expect(created).toHaveLength(1);
		const rows = (await sql.unsafe(
			`SELECT string -> 'test52' AS items
			   FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1`,
			[created[0] as number],
		)) as { items: { value?: string }[] }[];
		// 245$a landed on the component the `map` entry names — the proof the
		// bindings are read from config.map, not config.main.
		expect((rows[0]?.items ?? []).map((item) => item.value)).toContain('A MARC21 title');
	});

	/**
	 * The other half of the promise the manual makes ("the identifier field is
	 * what lets a re-import update the same records instead of duplicating
	 * them", docs/tools/using_import_marc21.md): the SAME file, imported twice,
	 * updates the record the first run created — because the first run wrote the
	 * control number into the code component the `id` entry names.
	 */
	test('re-importing the same file UPDATES the record it created, never a second one', async () => {
		const res = await runImport({
			section_tipo: 'test3',
			tool_config: toolConfig,
			files_data: [{ name: MRC, size: 1 }],
			key_dir: KEY_DIR,
		});
		expect(res.errors).toEqual([]);
		expect(res.updated).toBe(1);
		expect(res.created).toBe(0);
		expect(await recordsWithCode(String(SCRATCH_ID))).toHaveLength(1);
	});

	test('a batch with no .mrc entry imports nothing (PHP filter_marc21_files)', async () => {
		const res = await runImport({
			section_tipo: 'test3',
			tool_config: toolConfig,
			files_data: [{ name: 'notes.txt' }, { name: 'scan.pdf' }],
			key_dir: KEY_DIR,
		});
		expect(res.errors).toEqual([]);
		expect(res.created).toBe(0);
		expect(res.updated).toBe(0);
	});

	test('a missing staged file is a per-file error, not a thrown batch', async () => {
		const res = await runImport({
			section_tipo: 'test3',
			tool_config: toolConfig,
			files_data: [{ name: 'absent.mrc' }],
			key_dir: KEY_DIR,
		});
		expect(res.errors).toEqual(['absent.mrc: staged file not found']);
	});

	test('a traversing key_dir is REFUSED (never reaches another users staging dir)', async () => {
		// Before the fix this resolved to <staging root>/<other uid>/<file> and
		// still passed the root-prefix check, so the import consumed a file the
		// caller never uploaded.
		// A traversing key_dir THROWS out of the staging-dir grammar
		// (media/ingest/add_file.ts sanitizeSegment) before any file is read —
		// never a body, never a run that consumed the other user's file.
		await expect(
			runImportRaw({
				section_tipo: 'test3',
				tool_config: toolConfig,
				files_data: [{ name: MRC }],
				key_dir: `../${SCRATCH_USER}/${KEY_DIR}`,
			}),
		).rejects.toThrow('Unsafe path segment');
	});

	test('an empty SERVER map refuses the batch, naming where the map lives', async () => {
		const refusal = await withConfig({ main: [], map: [] }, () =>
			refusalOf(
				runImportRaw({
					section_tipo: 'test3',
					tool_config: toolConfig,
					files_data: [{ name: MRC }],
					key_dir: KEY_DIR,
				}),
			),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('Missing marc21_map');
		expect(refusal.message).toContain('dd996');
	});

	/**
	 * THE CONFIG DECIDES HOW AN IDENTIFIER RESOLVES — never the value's shape
	 * (DATA-08). A config that says "match records by 907$a" but never says WHERE
	 * that code is stored leaves only two possible behaviours, and both are
	 * defects: create a duplicate for every record, or read the control number as
	 * a section_id. So the run refuses before a file is read, naming what to
	 * author. This is the guard whose ABSENCE was the defect; it fires on a
	 * config that is incomplete, never on a legitimate one.
	 */
	test('field_to_section_id with no code component REFUSES the run', async () => {
		const refusal = await withConfig(
			{
				main: [{ name: 'field_to_section_id', value: { field: '907', subfield: 'a' } }],
				map: [{ info: 'Title mention', field: '245', subfield: 'a', tipo: 'test52' }],
			},
			() =>
				refusalOf(
					runImportRaw({
						section_tipo: 'test3',
						tool_config: toolConfig,
						files_data: [{ name: MRC }],
						key_dir: KEY_DIR,
					}),
				),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('907$a');
		expect(refusal.message).toContain('ddo_map');
	});

	test('an id ddo_map pointing at another section REFUSES the run', async () => {
		// Resolving the identifier in one section to address a record in another
		// names an unrelated record — the DATA-08 defect with an extra step.
		const refusal = await withConfig(
			{
				main: [{ name: 'field_to_section_id', value: { field: '907', subfield: 'a' } }],
				map: [
					{
						name: 'id',
						field: '907',
						subfield: 'a',
						tipo: CODE_COMPONENT,
						ddo_map: [{ tipo: CODE_COMPONENT, section_tipo: 'test118' }],
					},
				],
			},
			() =>
				refusalOf(
					runImportRaw({
						section_tipo: 'test3',
						tool_config: toolConfig,
						files_data: [{ name: MRC }],
						key_dir: KEY_DIR,
					}),
				),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('test118');
	});

	/**
	 * ONE IDENTIFIER, TWO RECORDS, IN ONE BATCH. Resolution happens for the whole
	 * batch before the first write, so the second record would resolve to null
	 * exactly like the first and mint a DUPLICATE (PHP, which resolved inside the
	 * write loop, would instead have overwritten what the first record just
	 * wrote). Neither is an import: the run stops with nothing written.
	 */
	test('two records sharing one identifier REFUSE the run, writing nothing', async () => {
		const refusal = await refusalOf(
			runImportRaw({
				section_tipo: 'test3',
				tool_config: toolConfig,
				files_data: [{ name: DUP_MRC }],
				key_dir: KEY_DIR,
			}),
		);
		expect(refusal.code).toBe('request.invalid_data');
		expect(refusal.message).toContain(DUP_CODE);
		// NOTHING WRITTEN: not the first record either.
		expect(await recordsWithCode(DUP_CODE)).toEqual([]);
	});
});

/**
 * T1-6: THE SERVER CONFIG AND THE PHP VALUE SEMANTICS, end to end on test3.
 *
 * Every case installs its own scratch Tools configuration (dd996) and posts the
 * real client shape — `tool_config: {ddo_map}` — so a pass proves the run read
 * the SERVER's map. Records are created by the runs themselves, each carrying a
 * `T16-…` control number in the code component; the sweep finds them by it.
 */
describe('import_files: server config + ported value semantics (T1-6)', () => {
	const USER = 987659; // distinct from 987657/987658: each file rm -rf's its own staging root
	const DIR = 'marc21_t16';
	const SECTION = 'test3';
	const CODE = 'test162'; // component_input_text, non-translatable
	const TITLE = 'test52'; // component_input_text, translatable
	const NOTE = 'test17'; // component_text_area, translatable
	const DATE = 'test145'; // component_date
	const SELECT = 'test91'; // component_select → dd64
	const RADIO = 'test87'; // component_radio_button → dd64
	const PREFIX = 'T16-';
	const stagingRoot = resolve(
		config.media.rootPath ?? '',
		config.media.upload.tmpSubdir,
		String(USER),
	);
	let bulkHighWater = 0;
	let teardown: () => Promise<void> = async () => {};

	/** The id entry + main every config shares: 907$a → the code component. */
	const idEntry = {
		info: 'Control number',
		name: 'id',
		field: '907',
		subfield: 'a',
		tipo: CODE,
		ddo_map: [{ tipo: CODE, section_tipo: SECTION }],
	};
	const main = [{ name: 'field_to_section_id', value: { field: '907', subfield: 'a' } }];
	const configWith = (...entries: Record<string, unknown>[]) => ({
		main,
		map: [idEntry, ...entries],
	});

	/** A record: its control number + fields. */
	const rec = (code: string, ...fields: FieldSpec[]): FieldSpec[] => [
		{ tag: '907', subfields: [['a', `${PREFIX}${code}`]] },
		...fields,
	];

	const stage = (name: string, records: FieldSpec[][]): void => {
		const parts = records.map(buildMarc);
		const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const part of parts) {
			bytes.set(part, at);
			at += part.length;
		}
		mkdirSync(resolve(stagingRoot, DIR), { recursive: true });
		writeFileSync(resolve(stagingRoot, DIR, name), bytes);
	};

	interface Report {
		created: number;
		updated: number;
		errors: string[];
		failed: { component_tipo?: string; msg?: string }[];
	}
	const handler = async () =>
		mustGet(
			(await getLoadedTool('tool_import_marc21'))!.module.apiActions.import_files,
			'import_files',
		).handler;
	const runRaw = async (
		serverConfig: Record<string, unknown>,
		file: string,
		extra: Record<string, unknown> = {},
	): Promise<ToolResponse> => {
		teardown = await installScratchToolConfig('tool_import_marc21', serverConfig);
		try {
			return await (await handler())({
				principal: await resolvePrincipal(-1),
				userId: USER,
				background: false,
				options: {
					section_tipo: SECTION,
					tool_config: { ddo_map: [] },
					files_data: [{ name: file, size: 1 }],
					key_dir: DIR,
					...extra,
				},
			});
		} finally {
			await teardown();
		}
	};
	const run = async (
		serverConfig: Record<string, unknown>,
		file: string,
		extra: Record<string, unknown> = {},
	): Promise<Report> => {
		const res = (await runRaw(serverConfig, file, extra)) as { ok: boolean; data: Report };
		expect(res.ok).toBe(true);
		expect(res.data.errors).toEqual([]);
		return res.data;
	};

	/** The test3 records whose code component holds `PREFIX+code`. */
	const idsWithCode = async (code: string): Promise<number[]> => {
		const rows = (await sql.unsafe(
			`SELECT section_id, string -> $1::text AS items FROM matrix_test
			  WHERE section_tipo = $2 AND string ? $1::text`,
			[CODE, SECTION],
		)) as { section_id: number; items: { value?: unknown }[] | null }[];
		return rows
			.filter((row) => (row.items ?? []).some((item) => item?.value === `${PREFIX}${code}`))
			.map((row) => Number(row.section_id));
	};
	/** The ONE record a code names (asserted unique). */
	const theRecord = async (code: string): Promise<number> => {
		const ids = await idsWithCode(code);
		expect(ids, code).toHaveLength(1);
		return ids[0] as number;
	};
	/** Stored items of one component (all langs), model-aware. */
	const itemsOf = async (code: string, tipo: string): Promise<Record<string, unknown>[]> => {
		const id = await theRecord(code);
		const record = await readMatrixRecord('matrix_test', SECTION, id);
		const model = mustGet(await getModelByTipo(tipo), tipo);
		return (readComponentItems(mustGet(record, String(id)), tipo, model) ?? []) as Record<
			string,
			unknown
		>[];
	};
	const valuesOf = async (code: string, tipo: string): Promise<unknown[]> =>
		(await itemsOf(code, tipo)).map((item) => item.value);

	beforeAll(async () => {
		const rows = (await sql.unsafe(
			`SELECT COALESCE(MAX(section_id), 0) AS max_id FROM matrix_notes WHERE section_tipo = 'dd800'`,
		)) as { max_id: number }[];
		bulkHighWater = Number(rows[0]?.max_id ?? 0);
	});

	afterAll(async () => {
		await teardown();
		rmSync(stagingRoot, { recursive: true, force: true });
		const rows = (await sql.unsafe(
			`SELECT section_id, string -> $1::text AS items FROM matrix_test
			  WHERE section_tipo = $2 AND string ? $1::text`,
			[CODE, SECTION],
		)) as { section_id: number; items: { value?: unknown }[] | null }[];
		const ids = rows
			.filter((row) =>
				(row.items ?? []).some((item) => String(item?.value ?? '').startsWith(PREFIX)),
			)
			.map((row) => Number(row.section_id));
		for (const id of ids) {
			await sql.unsafe(`DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`, [
				SECTION,
				id,
			]);
			await sql.unsafe(
				`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
				[SECTION, id],
			);
		}
		await sql.unsafe(`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id > $1`, [
			bulkHighWater,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id > $1`,
			[bulkHighWater],
		);
	});

	const title = (text: string): FieldSpec => ({
		tag: '245',
		ind1: '1',
		ind2: '0',
		subfields: [['a', text]],
	});
	const titleEntry = { info: 'Title', field: '245', subfield: 'a', tipo: TITLE };

	test('G1+G2: the SERVER map is applied; a client-posted map is ignored', async () => {
		stage('g1.mrc', [rec('g1', title('Server mapped title'))]);
		const report = await run(configWith(titleEntry), 'g1.mrc', {
			// The pre-T1-6 wire: a client-chosen map binding the title to test17.
			tool_config: { map: [{ field: '245', subfield: 'a', tipo: NOTE }], ddo_map: [] },
		});
		expect(report.created).toBe(1);
		expect(await valuesOf('g1', TITLE)).toEqual(['Server mapped title']);
		expect(await valuesOf('g1', NOTE)).toEqual([]);
	});

	test('G3+G5+G9: first occurrence only, trailing punctuation stripped, brackets stay text', async () => {
		stage('g3.mrc', [
			rec('g3', title('First title :'), title('Second title')),
			rec('g9', title('[1987]')),
		]);
		const report = await run(configWith(titleEntry), 'g3.mrc');
		expect(report.created).toBe(2);
		expect(report.failed).toEqual([]);
		expect(await valuesOf('g3', TITLE)).toEqual(['First title']);
		// '[1987]' is a bracketed inferred date, NOT a JSON cell (was stored as the number 1987).
		expect(await valuesOf('g9', TITLE)).toEqual(['[1987]']);
	});

	test('G4: field_multiple joins every occurrence of every listed tag', async () => {
		stage('g4.mrc', [
			rec(
				'g4',
				{
					tag: '650',
					subfields: [
						['a', 'Coins'],
						['x', 'Iberia'],
					],
				},
				{ tag: '650', subfields: [['a', 'Mints']] },
				{ tag: '651', subfields: [['a', 'Hispania']] },
			),
		]);
		await run(
			configWith({
				info: 'Indexations',
				field: ['650', '651'],
				field_multiple: true,
				row_separator: ' | ',
				subfield_separator: ' - ',
				tipo: TITLE,
			}),
			'g4.mrc',
		);
		expect(await valuesOf('g4', TITLE)).toEqual(['Coins - Iberia | Mints | Hispania']);
	});

	test('G6: partial_left_content + date_format year → a date; no year is refused, not an empty date', async () => {
		stage('g6.mrc', [
			rec('g6', { tag: '260', subfields: [['c', 'c1987.']] }),
			rec('g6n', { tag: '260', subfields: [['c', 's.d.']] }),
		]);
		const report = await run(
			configWith({
				field: '260',
				subfield: 'c',
				tipo: DATE,
				date_format: 'year',
				partial_left_content: 4,
			}),
			'g6.mrc',
		);
		const items = await itemsOf('g6', DATE);
		expect(items).toHaveLength(1);
		expect((items[0]?.start as { year?: number } | undefined)?.year).toBe(1987);
		expect(await itemsOf('g6n', DATE)).toEqual([]);
		expect(
			report.failed.some((f) => f.component_tipo === DATE && /no year/.test(f.msg ?? '')),
		).toBe(true);
	});

	test('G7: dd_data_map turns a code into its locator; a miss is reported by name', async () => {
		stage('g7.mrc', [
			rec('g7', { tag: '998', subfields: [['f', 'spa']] }),
			rec('g7m', { tag: '998', subfields: [['f', 'zzz']] }),
		]);
		const report = await run(
			configWith({
				field: '998',
				subfield: 'f',
				tipo: SELECT,
				dd_data_map: { spa: [{ section_tipo: 'dd64', section_id: '1' }] },
			}),
			'g7.mrc',
		);
		const items = await itemsOf('g7', SELECT);
		expect(items.map((i) => [i.section_tipo, Number(i.section_id)])).toEqual([['dd64', 1]]);
		expect(await itemsOf('g7m', SELECT)).toEqual([]);
		expect(
			report.failed.some(
				(f) =>
					f.component_tipo === SELECT && (f.msg ?? '').includes("no dd_data_map entry for 'zzz'"),
			),
		).toBe(true);
	});

	test('G8: dd_action writes its companion only when the entry yields a value', async () => {
		stage('g8.mrc', [
			rec('g8', { tag: '020', subfields: [['a', '978-84-0000-000-0']] }),
			rec('g8n', title('No ISBN here')),
		]);
		await run(
			configWith({
				info: 'ISBN',
				field: '020',
				subfield: 'a',
				tipo: TITLE,
				dd_action: { [RADIO]: [{ section_tipo: 'dd64', section_id: '2' }] },
			}),
			'g8.mrc',
		);
		const items = await itemsOf('g8', RADIO);
		expect(items.map((i) => [i.section_tipo, Number(i.section_id)])).toEqual([['dd64', 2]]);
		expect(await itemsOf('g8n', RADIO)).toEqual([]);
	});

	test('G10: conditional — the guarded occurrence, else the unconditional first (PHP fallback)', async () => {
		const copy = (shelf: string, library: string): FieldSpec => ({
			tag: '945',
			subfields: [
				['a', shelf],
				['j', library],
			],
		});
		stage('g10.mrc', [
			rec('g10', copy('Shelf A', '100'), copy('Shelf B', '193')),
			rec('g10f', copy('Shelf C', '100')),
		]);
		await run(
			configWith({
				info: 'Topographic',
				field: '945',
				subfield: 'a',
				tipo: TITLE,
				marc21_conditional: { subfield: 'j', value: '193' },
			}),
			'g10.mrc',
		);
		expect(await valuesOf('g10', TITLE)).toEqual(['Shelf B']);
		expect(await valuesOf('g10f', TITLE)).toEqual(['Shelf C']);
	});

	test('G11: the Values form is applied to every imported record, per language, then consumed', async () => {
		const scratch = {
			scope: 'tool_import_marc21',
			sectionTipo: SECTION,
			componentTipo: NOTE,
			lang: 'lg-eng',
		};
		await writeTemporalScratch(USER, scratch, [{ value: '<p>Form note</p>', lang: 'lg-eng' }]);
		stage('g11.mrc', [rec('g11a', title('One')), rec('g11b', title('Two'))]);
		const report = await run(configWith(titleEntry), 'g11.mrc', {
			tool_config: { ddo_map: [{ role: 'input_component', tipo: NOTE, section_tipo: SECTION }] },
			components_temp_data: [
				{
					tipo: NOTE,
					section_tipo: SECTION,
					entries: [
						{ id: 1, value: '<p>Form note</p>', lang: 'lg-eng' },
						{ id: 2, value: '<p>Nota del formulario</p>', lang: 'lg-spa' },
					],
				},
			],
		});
		expect(report.created).toBe(2);
		for (const code of ['g11a', 'g11b']) {
			const byLang = Object.fromEntries((await itemsOf(code, NOTE)).map((i) => [i.lang, i.value]));
			expect(byLang, code).toEqual({
				'lg-eng': '<p>Form note</p>',
				'lg-spa': '<p>Nota del formulario</p>',
			});
		}
		expect(await readTemporalScratch(USER, scratch)).toBeNull();
	});

	test('G12: a Values field of another section refuses the run before anything is written', async () => {
		stage('g12.mrc', [rec('g12', title('Never written'))]);
		const before = (await sql.unsafe(
			`SELECT COALESCE(MAX(section_id), 0) AS max_id FROM matrix_notes WHERE section_tipo = 'dd800'`,
		)) as { max_id: number }[];
		const refusal = await refusalOf(
			runRaw(configWith(titleEntry), 'g12.mrc', {
				tool_config: {
					ddo_map: [{ role: 'input_component', tipo: NOTE, section_tipo: 'test118' }],
				},
				components_temp_data: [{ tipo: NOTE, section_tipo: 'test118', entries: [{ value: 'x' }] }],
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('test118');
		expect(await idsWithCode('g12')).toEqual([]);
		const after = (await sql.unsafe(
			`SELECT COALESCE(MAX(section_id), 0) AS max_id FROM matrix_notes WHERE section_tipo = 'dd800'`,
		)) as { max_id: number }[];
		expect(Number(after[0]?.max_id)).toBe(Number(before[0]?.max_id));
	});

	test('G14: an id ending in punctuation is stored verbatim, so a re-import UPDATES', async () => {
		stage('g14.mrc', [rec('B123.', title('Punctuated id'))]);
		const first = await run(configWith(titleEntry), 'g14.mrc');
		expect(first.created).toBe(1);
		const second = await run(configWith(titleEntry), 'g14.mrc');
		expect(second.created).toBe(0);
		expect(second.updated).toBe(1);
		expect(await idsWithCode('B123.')).toHaveLength(1);
	});
});

/**
 * G13: the config is VALIDATED, refusing by name (pure — no DB). PHP ignored an
 * unknown key or a malformed transform and imported the raw text.
 */
describe('parseMarcConfig refuses a malformed server config (T1-6)', () => {
	const base = { field: '245', subfield: 'a', tipo: 'test52' };
	const refused = (entry: Record<string, unknown>) =>
		refusalOfSync(() => parseMarcConfig({ map: [{ info: 'Probe', ...entry }] }));

	test('a missing or empty map', () => {
		expect(refusalOfSync(() => parseMarcConfig({})).message).toContain('Missing marc21_map');
		expect(refusalOfSync(() => parseMarcConfig({ map: [] })).code).toBe('request.invalid_options');
	});

	test('an unknown key is named', () => {
		const refusal = refused({ ...base, date_fromat: 'year' });
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain("'date_fromat'");
		expect(refusal.message).toContain("'Probe'");
	});

	test('an unsupported date_format, an array field without field_multiple, a non-object dd_action', () => {
		expect(refused({ ...base, date_format: 'decade' }).message).toContain('date_format');
		expect(refused({ ...base, field: ['650', '651'] }).message).toContain('field_multiple');
		expect(refused({ ...base, dd_action: 'test87' }).message).toContain('dd_action');
		expect(refused({ field: '245' }).message).toContain("'tipo'");
		expect(refused({ ...base, partial_left_content: '4' }).message).toContain(
			'partial_left_content',
		);
		expect(refused({ ...base, date_format: 'year', dd_data_map: { a: [] } }).message).toContain(
			'cannot both',
		);
	});

	test('the shipped register map (dd1633 shape) parses', () => {
		const parsed = parseMarcConfig({
			main,
			map: [
				{
					info: 'ISBN',
					tipo: 'test52',
					field: '020',
					dd_action: { test87: [] },
					skip_on_empty: true,
				},
				{
					info: 'Indexations',
					tipo: 'test17',
					field: ['600', '650'],
					row_separator: '</p><p>',
					field_multiple: true,
					subfield_separator: ' - ',
				},
				{
					info: 'Barcode',
					tipo: 'test52',
					field: '945',
					subfield: 'i',
					marc21_conditional: { value: '193', subfield: 'j' },
				},
				{
					info: 'Date',
					tipo: 'test145',
					field: '260',
					subfield: 'c',
					date_format: 'year',
					partial_left_content: 4,
				},
			],
		});
		expect(parsed.entries).toHaveLength(4);
		expect(parsed.idSpec).toEqual({ field: '907', subfield: 'a' });
	});

	test('the targets extractor names the caller pair and the Values fields, never a client map', () => {
		const targets = importMarc21Targets({
			section_tipo: 'test3',
			tipo: 'test52',
			tool_config: {
				map: [{ field: '245', tipo: 'test18' }],
				ddo_map: [
					{ role: 'input_component', tipo: 'test17', section_tipo: 'test3' },
					{ role: 'target_component', tipo: 'test99', section_tipo: 'test3' },
				],
			},
		});
		expect(targets).toEqual([
			{ section_tipo: 'test3', tipo: 'test52' },
			{ section_tipo: 'test3', tipo: 'test17' },
		]);
	});
});

const main = [{ name: 'field_to_section_id', value: { field: '907', subfield: 'a' } }];
