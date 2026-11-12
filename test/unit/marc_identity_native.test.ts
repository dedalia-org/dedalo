/**
 * AN IMPORTED EXTERNAL IDENTIFIER IS NOT A RECORD ADDRESS — the gate for audit
 * finding DATA-08 (P0-9, closed 2026-08-30).
 *
 * THE DEFECT. `tools/tool_import_marc21` handed the `field_to_section_id` value
 * to the shared import executor AS the `section_id`. A MARC control number of
 * '42' therefore wrote onto record 42 of the target section — whatever curated
 * record already lived there — and when no such row existed,
 * `saveComponentData`'s missing-row branch (save_component.ts :1064, PHP
 * `set_dato` parity) UPSERTED one at that meaningless id. Both outcomes were
 * reported to the operator as a successful import. There was no existence check
 * and no code lookup anywhere in the run. The frozen engine never confused the
 * two: `resolve_target_section` (class.tool_import_marc21.php :393) SEARCHED the
 * value against the section's own CODE component (`get_section_id_from_code`
 * :1202) and created a record when it found none.
 *
 * WHY A SEPARATE FILE FROM `tool_import_marc21.test.ts`. That file gates the
 * TOOL — its action surface, the staged-file wire, the config-map read — and
 * carries the door-level DATA-08 cases the fix was written against. This file
 * gates the LAW, across the whole mapped-import surface and against the
 * situations an identifier can actually take: an identifier that is not a run of
 * digits, two identifiers that the old `Number.parseInt` collapsed onto ONE
 * record, an identifier that equals a real record's id, and an identifier that
 * merely LOOKS like a stored code. Overlap with the neighbour is deliberate for
 * the purely-numeric case: it is the case the pre-fix suite asserted BACKWARDS
 * (`expect(res.updated).toBe(1)` on a record the control number merely
 * numbered), and a law that is only ever pinned in the file that also owns the
 * door's other behaviour is one careless edit from disappearing.
 *
 * THE CENSUS IS DERIVED, NOT TRUSTED. `mappedImportDoors()` below scans the
 * tool tree for the doors that feed the shared executor, so a THIRD mapped door
 * added tomorrow reddens this file rather than quietly inheriting nothing.
 *
 * WHAT THIS FILE BUILDS: its own records in the generic `test` TLD's test3
 * playground, its own codes, its own staged .mrc bytes. It reads no record it
 * did not create, and sweeps every row (records, TM, dd800 runs) it caused.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { findSectionIdByCode } from '../../src/core/tools/import_code_lookup.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { applyMarcMap, type MarcRecord } from '../../src/core/tools/marc21.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { mapCslItem, readZoteroConfig } from '../../src/core/tools/zotero_map.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { installScratchToolConfig } from '../helpers/tool_config_fixture.ts';

// ---------------------------------------------------------------------------
// The situation this file builds.
// ---------------------------------------------------------------------------

const SECTION = 'test3';
/** component_input_text, NON-translatable (test_data/manifest.ts :111) — the code carrier. */
const CODE_COMPONENT = 'test162';
/** component_input_text, translatable — where 245$a lands, so a wrong write is visible. */
const TITLE_COMPONENT = 'test52';

/**
 * Distinct from `tool_import_marc21.test.ts`'s 987657: the staging root is
 * `<media>/<tmp>/<user>/…` and the two files are swept with `rm -rf`, so sharing
 * a user id would let one file's teardown delete the other's staged bytes when
 * the suite runs them in the same shard.
 */
/**
 * Three codes that are ONE candidate set under the search's `f_unaccent` fold
 * (and quote stripping) but three distinct identifiers by bytes. The exact one
 * is seeded LAST so it sits behind the other two in id order — the position a
 * candidate cap evicts.
 */
const ACCENT_TWIN_A = 'Évict-1';
const ACCENT_TWIN_B = "E'vict-1";
const EVICTED_EXACT_CODE = 'Evict-1';

const SCRATCH_USER = 987658;
const KEY_DIR = 'marc_identity_scratch';

/**
 * The records this gate creates. All far outside the canonical test3 ids
 * (1, 2, 27) and outside the neighbour file's 900301.
 */
const CURATED_ID = 900321; // carries CURATED_CODE — the record a match must land on
const TRUNCATION_VICTIM_ID = 900323; // the record BOTH truncating identifiers used to address
const NUMERIC_VICTIM_ID = 900324; // the record the purely-numeric identifier used to address
const LOOKALIGN_ID = 900325; // carries the accented code a look-alike must NOT match
const DUP_A_ID = 900326;
const DUP_B_ID = 900327; // …and its twin: one code, two records

const SCRATCH_IDS = [
	CURATED_ID,
	TRUNCATION_VICTIM_ID,
	NUMERIC_VICTIM_ID,
	LOOKALIGN_ID,
	DUP_A_ID,
	DUP_B_ID,
];

/**
 * A real Innovative/Millennium control number shape: it is not a run of digits,
 * so no cast could ever have turned it into an address — it is here to prove the
 * POSITIVE half of the law (a matching identifier reaches the RIGHT record)
 * without the numeric coincidence doing any of the work.
 */
const CURATED_CODE = '.b12345678';

/**
 * TWO identifiers, ONE integer. `Number.parseInt('900323-1')` and
 * `Number.parseInt('900323abc')` are both 900323, so the original reader wrote
 * both records onto record 900323 — the second silently overwriting the first,
 * and both overwriting whatever lived there. They share no code, so they are
 * two ordinary records of one import.
 */
const TRUNCATING_A = '900323-1';
const TRUNCATING_B = '900323abc';

/** Purely numeric, and equal to a REAL record's section_id. The central case. */
const NUMERIC_CODE = String(NUMERIC_VICTIM_ID);

/**
 * The look-alike pair. `=` compares `f_unaccent(value) = f_unaccent(q)` and
 * strips quotes from q (builder_string.ts :225-233), so these two are ONE
 * candidate set for the narrowing search; only the byte comparison in
 * `findSectionIdByCode` separates them. Resolving 'Nunez-1' to the record that
 * holds 'Núñez-1' would be the DATA-08 write with better manners.
 */
const STORED_ACCENTED_CODE = 'Núñez-1';
const LOOKALIKE_CODE = 'Nunez-1';

/** One code carried by TWO existing records: an identifier that names neither. */
const DUPLICATED_CODE = 'marc-identity-dup-1';

/** An identifier no record carries — the create half of the frozen upsert. */
const UNMATCHED_CODE = 'ocm-marc-identity-unmatched';

const TITLE_OF: Record<string, string> = {
	[CURATED_CODE]: 'The catalogued monograph',
	[TRUNCATING_A]: 'The first truncating claim',
	[TRUNCATING_B]: 'The second truncating claim',
	[NUMERIC_CODE]: 'The numerically-named import',
	[LOOKALIKE_CODE]: 'The unaccented claim',
	[DUPLICATED_CODE]: 'The ambiguous claim',
	[UNMATCHED_CODE]: 'The unmatched claim',
};

/** The title each VICTIM record holds before any import — the byte a wrong write destroys. */
const CURATED_TITLE = 'The curated title nobody imported';

// ---------------------------------------------------------------------------
// ISO 2709 assembly.
// ---------------------------------------------------------------------------

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

/**
 * Assemble a valid ISO 2709 record from field specs (the twin in
 * marc21.test.ts / tool_import_marc21.test.ts). Copied rather than shared: it is
 * a fixture builder, and a test that assembles its own bytes cannot be made to
 * pass by a change to somebody else's helper.
 */
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

/** One bibliographic record: 907$a carries the control number, 245$a the title. */
function marcBytes(code: string): Uint8Array {
	return buildMarc([
		{ tag: '907', subfields: [['a', code]] },
		{ tag: '245', ind1: '1', ind2: '0', subfields: [['a', mustGet(TITLE_OF[code], code)]] },
	]);
}

/** A staged file holding one or more records, in order. */
function stageFile(name: string, codes: string[]): void {
	const parts = codes.map(marcBytes);
	const total = parts.reduce((n, p) => n + p.length, 0);
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	writeFileSync(resolve(stagedDir, name), bytes);
}

const stagingRoot = resolve(
	config.media.rootPath ?? '',
	config.media.upload.tmpSubdir,
	String(SCRATCH_USER),
);
const stagedDir = resolve(stagingRoot, KEY_DIR);

/**
 * The REAL config shape (getToolConfig, flat — tools/tool_import_marc21/register.json dd1633): the
 * `id` entry is both the code-component DECLARATION (its ddo_map is what PHP's
 * get_section_id_from_code read) and an ordinary binding — its own field/tipo
 * write the control number INTO that component, which is what makes the next
 * import of the same file find the record instead of duplicating it.
 */
const SERVER_CONFIG = {
	main: [{ name: 'field_to_section_id', value: { field: '907', subfield: 'a' } }],
	map: [
		{ info: 'Title mention', field: '245', subfield: 'a', tipo: TITLE_COMPONENT },
		{
			info: 'Control number',
			name: 'id',
			field: '907',
			subfield: 'a',
			tipo: CODE_COMPONENT,
			ddo_map: [{ tipo: CODE_COMPONENT, section_tipo: SECTION }],
		},
	],
};
/**
 * T1-6: the map is the SERVER's (Tools configuration dd996 over dd1633), so
 * SERVER_CONFIG is installed as a scratch dd996 record for this file's runs; the
 * client posts its ontology tool_config, which carries only the ddo_map.
 */
const TOOL_CONFIG = { ddo_map: [] };
let teardownConfig: () => Promise<void> = async () => {};

// ---------------------------------------------------------------------------
// Reading the situation back.
// ---------------------------------------------------------------------------

interface ImportReport {
	summary: string;
	errors: string[];
	created: number;
	updated: number;
	failed: unknown[];
}

async function runImportRaw(fileName: string): Promise<ToolResponse> {
	const loaded = await getLoadedTool('tool_import_marc21');
	const action = mustGet(
		mustGet(loaded, 'tool_import_marc21').module.apiActions.import_files,
		'import_files',
	);
	return action.handler({
		principal: await resolvePrincipal(-1),
		userId: SCRATCH_USER,
		background: false,
		options: {
			section_tipo: SECTION,
			tool_config: TOOL_CONFIG,
			files_data: [{ name: fileName, size: 1 }],
			key_dir: KEY_DIR,
		},
	});
}

async function runImport(fileName: string): Promise<ImportReport> {
	const res = (await runImportRaw(fileName)) as { ok: boolean; data: ImportReport };
	expect(res.ok).toBe(true);
	return res.data;
}

/** The stored values of one component on one record (no lang filter). */
async function valuesOf(sectionId: number, componentTipo: string): Promise<string[]> {
	const rows = (await sql.unsafe(
		`SELECT string -> $2::text AS items
		   FROM matrix_test WHERE section_tipo = $1 AND section_id = $3`,
		[SECTION, componentTipo, sectionId],
	)) as { items: { value?: unknown }[] | null }[];
	return (rows[0]?.items ?? [])
		.map((item) => item?.value)
		.filter((v): v is string => typeof v === 'string');
}

/** Every test3 record whose code component holds `code` — the run's own output. */
async function recordsWithCode(code: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id, string -> $1::text AS items
		   FROM matrix_test
		  WHERE section_tipo = 'test3' AND string ? $1::text`,
		[CODE_COMPONENT],
	)) as { section_id: number; items: { value?: unknown }[] | null }[];
	return rows
		.filter((row) => (row.items ?? []).some((item) => item?.value === code))
		.map((row) => Number(row.section_id))
		.sort((a, b) => a - b);
}

/** Write one value onto a record through the ENGINE's own save path. */
async function seedValue(sectionId: number, componentTipo: string, value: string): Promise<void> {
	const outcome = await saveComponentData({
		componentTipo,
		sectionTipo: SECTION,
		sectionId,
		// The install's declared data language: the save path refuses an
		// undeclared one, and normalizes the slice itself for a NON-translatable
		// component (test162 stores lg-nolan). Passing the request lang is what a
		// real caller does.
		lang: config.menu.dataLang,
		changedData: [{ action: 'set_data', id: null, value: [{ value }] }],
		userId: -1,
	});
	if (!outcome.ok)
		throw new Error(`seed failed on ${sectionId}/${componentTipo}: ${outcome.message}`);
}

/** dd800 runs live in matrix_notes; the door does not report the id, so bound it. */
let bulkProcessHighWater = 0;

beforeAll(async () => {
	teardownConfig = await installScratchToolConfig('tool_import_marc21', SERVER_CONFIG);
	mkdirSync(stagedDir, { recursive: true });
	stageFile('curated.mrc', [CURATED_CODE]);
	stageFile('truncating_pair.mrc', [TRUNCATING_A, TRUNCATING_B]);
	stageFile('numeric.mrc', [NUMERIC_CODE]);
	stageFile('lookalike.mrc', [LOOKALIKE_CODE]);
	stageFile('duplicated.mrc', [DUPLICATED_CODE]);
	stageFile('unmatched.mrc', [UNMATCHED_CODE]);

	const highWater = (await sql.unsafe(
		`SELECT COALESCE(MAX(section_id), 0) AS max_id FROM matrix_notes WHERE section_tipo = 'dd800'`,
	)) as { max_id: number }[];
	bulkProcessHighWater = Number(highWater[0]?.max_id ?? 0);

	for (const id of SCRATCH_IDS) {
		await createSectionRecord(SECTION, SCRATCH_USER, new Date(), id, { conflictTolerant: true });
		// EVERY victim carries a title, so "the import did not touch this record"
		// is asserted against a byte that exists rather than against absence.
		await seedValue(id, TITLE_COMPONENT, CURATED_TITLE);
	}
	await seedValue(CURATED_ID, CODE_COMPONENT, CURATED_CODE);
	await seedValue(LOOKALIGN_ID, CODE_COMPONENT, STORED_ACCENTED_CODE);
	await seedValue(DUP_A_ID, CODE_COMPONENT, DUPLICATED_CODE);
	await seedValue(DUP_B_ID, CODE_COMPONENT, DUPLICATED_CODE);
	// The two records the truncating pair used to address hold NO code: the whole
	// point is that nothing links them to those control numbers.
	expect(await valuesOf(TRUNCATION_VICTIM_ID, CODE_COMPONENT)).toEqual([]);
	expect(await valuesOf(NUMERIC_VICTIM_ID, CODE_COMPONENT)).toEqual([]);
});

afterAll(async () => {
	await teardownConfig();
	rmSync(stagingRoot, { recursive: true, force: true });
	// The records the RUNS created are found by the code they carry — their ids
	// are the engine's, not ours, so they cannot be hard-coded.
	const created = new Set<number>();
	for (const code of [TRUNCATING_A, TRUNCATING_B, NUMERIC_CODE, LOOKALIKE_CODE, UNMATCHED_CODE]) {
		for (const id of await recordsWithCode(code)) if (!SCRATCH_IDS.includes(id)) created.add(id);
	}
	for (const id of [...SCRATCH_IDS, ...created]) {
		await sql.unsafe(`DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`, [
			SECTION,
			id,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id],
		);
	}
	// The dd800 bulk-process rows this file's runs minted (import_execute.ts
	// creates one per run and the tool response does not carry the id).
	await sql.unsafe(`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id > $1`, [
		bulkProcessHighWater,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id > $1`,
		[bulkProcessHighWater],
	);
});

// ---------------------------------------------------------------------------
// 1. The census: which doors can turn a foreign identifier into an address.
// ---------------------------------------------------------------------------

/**
 * DERIVED, never enumerated: the tool doors that feed the shared import executor
 * (`importMappedRecords`), which is the only place a `MappedRecord.sectionId`
 * becomes a write target. Scanned from the tool tree so a third mapped door
 * added tomorrow reddens this file instead of inheriting no gate at all.
 *
 * NOT in scope, and deliberately: the CSV door has its own executor and a
 * genuine `section_id` COLUMN — there the value really is a Dédalo address, and
 * its digits grammar (import_csv.ts `parseRecordIdCell`) is correct.
 */
function mappedImportDoors(): string[] {
	const doors: string[] = [];
	for (const entry of readdirSync('tools', { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const index = resolve('tools', entry.name, 'server/index.ts');
		let source: string;
		try {
			source = readFileSync(index, 'utf8');
		} catch {
			continue;
		}
		if (source.includes('importMappedRecords')) doors.push(entry.name);
	}
	return doors.sort();
}

describe('the mapped-import doors (census, derived from the tool tree)', () => {
	/**
	 * The audit's census for DATA-08 is the set of doors that map a foreign file
	 * onto records. If this list grows, the new door needs its own answer to "what
	 * is an identifier here" BEFORE it ships — that is what this assertion buys.
	 */
	test('exactly two doors feed the shared executor', () => {
		expect(mappedImportDoors()).toEqual(['tool_import_marc21', 'tool_import_zotero']);
	});

	/**
	 * The Zotero door (T1-7) carries its identifier the same way: the item's
	 * Zotero KEY is a CODE, resolved through the code component by the shared
	 * `resolveMappedCodes` — and the mapper yields no address at all. PHP's
	 * second address, `field_to_section_id` (default `call-number`, cast to a
	 * section_id), is pending an owner decision (D1): it is neither an address
	 * nor a value. This pins the half that matters to DATA-08: no
	 * identifier-shaped value, however numeric, comes back from that mapper as an
	 * address.
	 */
	test('the Zotero mapper yields no address for any identifier-shaped value', () => {
		const idish = ['42', String(NUMERIC_VICTIM_ID), '007', '.b12345678', '900323abc', '0'];
		const cfg = readZoteroConfig({
			map: [
				{ name: 'id', ddo_map: [{ tipo: CODE_COMPONENT, section_tipo: 'test3' }] },
				{ name: 'call-number', ddo_map: [{ tipo: CODE_COMPONENT, section_tipo: 'test3' }] },
			],
			main: [{ name: 'field_to_section_id', value: 'call-number' }],
		});
		const kindOf = new Map([[CODE_COMPONENT, 'text' as const]]);
		const mapped = idish.map((value) =>
			mapCslItem({ id: `http://zotero.org/users/1/items/${value}`, 'call-number': value }, cfg, {
				kindOf,
			}),
		);
		expect(mapped.map((record) => record.code)).toEqual(idish);
		for (const record of mapped) {
			expect('sectionId' in record).toBe(false);
			// The call-number wrote nothing: only the code itself is a field.
			expect(record.fields.map((field) => field.values)).toEqual([
				[JSON.stringify([{ value: record.code }])],
			]);
		}
	});
});

// ---------------------------------------------------------------------------
// 2. The mapper: the identifier is carried, never cast.
// ---------------------------------------------------------------------------

describe('applyMarcMap carries the identifier verbatim', () => {
	function record(code: string): MarcRecord {
		return {
			leader: '00000nam a2200000n a4500',
			fields: [
				{ tag: '907', indicator1: ' ', indicator2: ' ', subfields: [{ code: 'a', value: code }] },
			],
		};
	}
	const ID_SPEC = { field: '907', subfield: 'a' };

	/**
	 * The three shapes the audit named, at the mapper: a non-numeric identifier,
	 * the truncating pair (ONE integer, two identifiers), and the purely-numeric
	 * one. `sectionId` is gone as a KEY, not merely unset — a caller cannot read
	 * an address back out of this function by habit.
	 */
	test('every shape comes back as a code, and no shape as an address', () => {
		for (const code of [CURATED_CODE, TRUNCATING_A, TRUNCATING_B, NUMERIC_CODE, '42', '007']) {
			const mapped = applyMarcMap(record(code), [], ID_SPEC);
			expect(mapped.code, code).toBe(code);
			expect('sectionId' in mapped, `sectionId leaked for ${code}`).toBe(false);
		}
	});

	test('the truncating pair stays two distinct identifiers', () => {
		// The old reader collapsed them: parseInt of both is one record number.
		expect(Number.parseInt(TRUNCATING_A, 10)).toBe(Number.parseInt(TRUNCATING_B, 10));
		const a = applyMarcMap(record(TRUNCATING_A), [], ID_SPEC).code;
		const b = applyMarcMap(record(TRUNCATING_B), [], ID_SPEC).code;
		expect(a).not.toBe(b);
	});

	test('a record with no identifier field names none (the executor reads null as create)', () => {
		expect(applyMarcMap(record('  '), [], ID_SPEC).code).toBeNull();
		expect(applyMarcMap(record('x'), [], undefined).code).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 3. The resolver, against records this file created.
// ---------------------------------------------------------------------------

describe('findSectionIdByCode (the code lookup that replaced the cast)', () => {
	const target = { sectionTipo: SECTION, componentTipo: CODE_COMPONENT };
	const principal = async () => await resolvePrincipal(-1);

	test('a stored code resolves to the record that carries it', async () => {
		expect(await findSectionIdByCode(target, CURATED_CODE, await principal())).toBe(CURATED_ID);
	});

	test('whitespace is transmission padding, not part of the identifier', async () => {
		// MARC pads its fixed fields; the frozen tool trimmed too.
		expect(await findSectionIdByCode(target, `  ${CURATED_CODE} `, await principal())).toBe(
			CURATED_ID,
		);
	});

	test('an unmatched identifier resolves to null (the caller CREATES)', async () => {
		expect(await findSectionIdByCode(target, UNMATCHED_CODE, await principal())).toBeNull();
	});

	/**
	 * THE NUMBER IS NOT AN ADDRESS, at the resolver itself: record 900324 exists
	 * and holds a curated title, and the identifier '900324' still resolves to
	 * null because no record carries it as a CODE.
	 */
	test('an identifier equal to a real record id resolves to null, not to that record', async () => {
		expect(await valuesOf(NUMERIC_VICTIM_ID, TITLE_COMPONENT)).toContain(CURATED_TITLE);
		expect(await findSectionIdByCode(target, NUMERIC_CODE, await principal())).toBeNull();
	});

	/**
	 * The narrowing search and the decision are DIFFERENT comparisons. `=` runs
	 * `f_unaccent(value) = f_unaccent(q)`, so the accented record IS a candidate
	 * for 'Nunez-1'; only the byte comparison keeps the import off it. Without
	 * that second read this returns LOOKALIGN_ID and the import overwrites a
	 * record that merely resembles the identifier.
	 */
	test('a look-alike is not the code (accent folding narrows, bytes decide)', async () => {
		expect(await valuesOf(LOOKALIGN_ID, CODE_COMPONENT)).toEqual([STORED_ACCENTED_CODE]);
		expect(await findSectionIdByCode(target, LOOKALIKE_CODE, await principal())).toBeNull();
		// …and the exact bytes still resolve, so the guard narrows nothing real.
		expect(await findSectionIdByCode(target, STORED_ACCENTED_CODE, await principal())).toBe(
			LOOKALIGN_ID,
		);
	});

	/**
	 * THE NARROWING CAP IS NOT THE ANSWER (2026-08-31). The search asks for at
	 * most CANDIDATE_CAP rows and the BYTE comparison decides afterwards — so the
	 * cap bounds CANDIDATES, not matches. The old cap of 2 was justified as ">1 is
	 * already a refusal, so a third row cannot change the answer", which is true of
	 * matches and false of candidates: `=` folds accents and strips quotes, so
	 * look-alikes share one candidate set. With three of them the byte-exact record
	 * could be evicted from the window, the lookup answered "no such code", and the
	 * importer CREATED A DUPLICATE of a record that already existed.
	 */
	test('a byte-exact code still resolves from BEHIND two look-alikes', async () => {
		// Three records whose codes are one candidate set under f_unaccent, with
		// the exact one deliberately last by id — the position the old cap evicted.
		// Explicit ids in this file's own scratch run, ascending so the exact one
		// is LAST — the position a candidate cap evicts.
		const ids = [900341, 900342, 900343];
		try {
			const values = [ACCENT_TWIN_A, ACCENT_TWIN_B, EVICTED_EXACT_CODE];
			for (let index = 0; index < ids.length; index++) {
				await createSectionRecord(SECTION, SCRATCH_USER, new Date(), ids[index] as number, {
					conflictTolerant: true,
				});
				await seedValue(ids[index] as number, CODE_COMPONENT, values[index] as string);
			}
			const evictedId = ids[2] as number;
			expect(await valuesOf(evictedId, CODE_COMPONENT)).toEqual([EVICTED_EXACT_CODE]);

			// It must resolve to the record that carries the BYTES, not to null and
			// not to either look-alike.
			expect(await findSectionIdByCode(target, EVICTED_EXACT_CODE, await principal())).toBe(
				evictedId,
			);
		} finally {
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
		}
	}, 60000);

	/**
	 * PHP took `limit 1` and wrote into whichever row the planner returned first.
	 * An identifier held by two records names neither: the honest answer is a
	 * refusal, and the caller writes nothing.
	 */
	test('an identifier carried by two records REFUSES rather than picking one', async () => {
		expect(await recordsWithCode(DUPLICATED_CODE)).toEqual([DUP_A_ID, DUP_B_ID]);
		const refusal = await refusalOf(
			findSectionIdByCode(target, DUPLICATED_CODE, await principal()),
		);
		expect(refusal.code).toBe('resource.conflict');
		expect(refusal.message).toContain(DUPLICATED_CODE);
	});
});

// ---------------------------------------------------------------------------
// 4. The door, end to end: what an import actually writes.
// ---------------------------------------------------------------------------

describe('import_files: an identifier reaches the right record or none', () => {
	/** THE POSITIVE HALF: a matching identifier lands on the record that carries it. */
	test('a NON-numeric identifier matching a stored code UPDATES that record', async () => {
		const before = await recordsWithCode(CURATED_CODE);
		expect(before).toEqual([CURATED_ID]);

		const report = await runImport('curated.mrc');
		expect(report.errors).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.updated).toBe(1);
		expect(report.created).toBe(0);

		// It landed HERE, and nowhere else.
		expect(await valuesOf(CURATED_ID, TITLE_COMPONENT)).toContain(
			mustGet(TITLE_OF[CURATED_CODE], 'curated title'),
		);
		expect(await recordsWithCode(CURATED_CODE)).toEqual([CURATED_ID]);
	});

	/**
	 * THE DESTRUCTIVE CONTROL, and the case the pre-fix suite asserted backwards.
	 * 907$a is the string '900324'; record 900324 of test3 EXISTS and holds a
	 * curated title; nothing has ever written '900324' into its code component.
	 * The old door cast the value and UPDATED that record — a library control
	 * number silently overwriting an unrelated curated record.
	 */
	test('a purely numeric identifier NEVER writes to the record with that id', async () => {
		const report = await runImport('numeric.mrc');
		expect(report.errors).toEqual([]);
		expect(report.created).toBe(1);
		expect(report.updated).toBe(0);

		// The victim: untouched, both ways round.
		const victimTitles = await valuesOf(NUMERIC_VICTIM_ID, TITLE_COMPONENT);
		expect(victimTitles).toEqual([CURATED_TITLE]);
		expect(victimTitles).not.toContain(mustGet(TITLE_OF[NUMERIC_CODE], 'numeric title'));
		expect(await valuesOf(NUMERIC_VICTIM_ID, CODE_COMPONENT)).toEqual([]);

		// The run created its own record somewhere else entirely.
		const created = await recordsWithCode(NUMERIC_CODE);
		expect(created).toHaveLength(1);
		expect(created[0]).not.toBe(NUMERIC_VICTIM_ID);
		expect(await valuesOf(created[0] as number, TITLE_COMPONENT)).toContain(
			mustGet(TITLE_OF[NUMERIC_CODE], 'numeric title'),
		);
	});

	/**
	 * TWO IDENTIFIERS, ONE INTEGER. Under `Number.parseInt` both records addressed
	 * 900323: the first overwrote whatever lived there, the second overwrote the
	 * first, and the operator was told two records imported. They are two records
	 * of one import and must stay two.
	 */
	test('two identifiers that truncate onto one id write two records, and not that one', async () => {
		const report = await runImport('truncating_pair.mrc');
		expect(report.errors).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.created).toBe(2);
		expect(report.updated).toBe(0);

		// The integer they both truncated to: untouched.
		expect(await valuesOf(TRUNCATION_VICTIM_ID, TITLE_COMPONENT)).toEqual([CURATED_TITLE]);
		expect(await valuesOf(TRUNCATION_VICTIM_ID, CODE_COMPONENT)).toEqual([]);

		// Two distinct records, each carrying its own identifier and its own title.
		const a = await recordsWithCode(TRUNCATING_A);
		const b = await recordsWithCode(TRUNCATING_B);
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(1);
		expect(a[0]).not.toBe(b[0]);
		expect(a[0]).not.toBe(TRUNCATION_VICTIM_ID);
		expect(b[0]).not.toBe(TRUNCATION_VICTIM_ID);
		expect(await valuesOf(a[0] as number, TITLE_COMPONENT)).toContain(
			mustGet(TITLE_OF[TRUNCATING_A], 'a'),
		);
		expect(await valuesOf(b[0] as number, TITLE_COMPONENT)).toContain(
			mustGet(TITLE_OF[TRUNCATING_B], 'b'),
		);
	});

	/** The look-alike, through the door: it creates, it does not adopt the accented record. */
	test('a look-alike identifier creates rather than overwriting the record it resembles', async () => {
		const report = await runImport('lookalike.mrc');
		expect(report.created).toBe(1);
		expect(report.updated).toBe(0);
		expect(await valuesOf(LOOKALIGN_ID, TITLE_COMPONENT)).toEqual([CURATED_TITLE]);
		expect(await valuesOf(LOOKALIGN_ID, CODE_COMPONENT)).toEqual([STORED_ACCENTED_CODE]);
	});

	/**
	 * The ambiguity refusal reaches the operator as a refusal, and NOTHING is
	 * written — not even to the first of the two candidates.
	 */
	test('an identifier held by two records refuses the run, writing to neither', async () => {
		const refusal = await refusalOf(runImportRaw('duplicated.mrc'));
		expect(refusal.code).toBe('resource.conflict');
		for (const id of [DUP_A_ID, DUP_B_ID]) {
			expect(await valuesOf(id, TITLE_COMPONENT)).toEqual([CURATED_TITLE]);
		}
		expect(await recordsWithCode(DUPLICATED_CODE)).toEqual([DUP_A_ID, DUP_B_ID]);
	});

	/**
	 * The round trip the manual promises ("the identifier field is what lets a
	 * re-import update the same records instead of duplicating them",
	 * docs/tools/using_import_marc21.md): the created record carries the control
	 * number, so the SECOND run finds it. Without this the fix would be honest and
	 * useless — every import a fresh duplicate.
	 */
	test('an unmatched identifier creates once, and the re-import updates that record', async () => {
		const first = await runImport('unmatched.mrc');
		expect(first.created).toBe(1);
		expect(first.updated).toBe(0);
		const created = await recordsWithCode(UNMATCHED_CODE);
		expect(created).toHaveLength(1);

		const second = await runImport('unmatched.mrc');
		expect(second.updated).toBe(1);
		expect(second.created).toBe(0);
		expect(await recordsWithCode(UNMATCHED_CODE)).toEqual(created);
	});
});
