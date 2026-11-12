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
 *     `config.map`, so extractMarcValues matched nothing and every import wrote
 *     zero components.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { readMarcMap, resolveStagedFile } from '../../tools/tool_import_marc21/server/index.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';

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

	// The REAL authoring shape (tools/tool_import_marc21/sample_config.json):
	// bindings under `map` keyed by `tipo`; `field_to_section_id` under `main`;
	// and the `id` entry, which is BOTH the code-component declaration (ddo_map,
	// how PHP's get_section_id_from_code found the record) and an ordinary
	// binding — its own field/tipo write the control number INTO that component,
	// which is what makes the NEXT import of the same file find the record.
	const toolConfig = {
		config: {
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
		},
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
	 * them", docs/using/tools/using_import_marc21.md): the SAME file, imported twice,
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

	test('the config-map guard names config.map (an empty map refuses the batch)', async () => {
		const refusal = await refusalOf(
			runImportRaw({
				section_tipo: 'test3',
				// The pre-fix shape: bindings under `main`. They are NOT bindings.
				tool_config: { config: { main: [{ name: 'code', tipo: 'test52' }] } },
				files_data: [{ name: MRC }],
				key_dir: KEY_DIR,
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('tool_config.config.map');
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
		const refusal = await refusalOf(
			runImportRaw({
				section_tipo: 'test3',
				tool_config: {
					config: {
						main: [{ name: 'field_to_section_id', value: { field: '907', subfield: 'a' } }],
						map: [{ info: 'Title mention', field: '245', subfield: 'a', tipo: 'test52' }],
					},
				},
				files_data: [{ name: MRC }],
				key_dir: KEY_DIR,
			}),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.message).toContain('907$a');
		expect(refusal.message).toContain('ddo_map');
	});

	test('an id ddo_map pointing at another section REFUSES the run', async () => {
		// Resolving the identifier in one section to address a record in another
		// names an unrelated record — the DATA-08 defect with an extra step.
		const refusal = await refusalOf(
			runImportRaw({
				section_tipo: 'test3',
				tool_config: {
					config: {
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
				},
				files_data: [{ name: MRC }],
				key_dir: KEY_DIR,
			}),
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
 * REGRESSION GATE (2026-07-28): readMarcMap must read the shape getToolConfig
 * ACTUALLY emits.
 *
 * `{config:{main,map}}` is the AUTHORING shape in register.json /
 * sample_config.json. getToolConfig RESOLVES options flat, so a caller receives
 * `{map, info, main}` with NO `.config` wrapper (measured: getToolConfig(
 * 'tool_import_marc21') -> keys ["map","info","main"]). readMarcMap read only
 * `toolConfig.config.map`, so every real import found zero bindings and returned
 * "Missing marc21_map" — while the suite passed, because its fixture hand-built
 * the nested shape. Same class of bug as resolveTranscriberConfig /
 * resolveTranslatorConfig; same fix (flat first, nested tolerated as legacy).
 */
describe('readMarcMap reads the real getToolConfig shape', () => {
	const map = [{ info: 'Title', field: '245', subfield: 'a', tipo: 'test52' }];
	const main = [{ name: 'field_to_section_id', value: { field: '907', subfield: 'a' } }];

	test('the FLAT shape getToolConfig emits yields the bindings', () => {
		const { entries } = readMarcMap({ map, main });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.component_tipo).toBe('test52');
		expect(entries[0]?.field).toBe('245');
	});

	test('the flat shape also yields the id spec from main', () => {
		const { idSpec } = readMarcMap({ map, main });
		expect(idSpec).toEqual({ field: '907', subfield: 'a' });
	});

	test('the legacy nested shape still yields the bindings (tolerated)', () => {
		expect(readMarcMap({ config: { map, main } }).entries).toHaveLength(1);
	});

	test('a config with no map at all yields no entries (fail-closed)', () => {
		expect(readMarcMap({ info: 'nothing here' }).entries).toHaveLength(0);
	});
});
