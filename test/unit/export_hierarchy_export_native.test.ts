/**
 * export_hierarchy — the psql dump (ported natively 2026-08-19) and the
 * `hierarchy.json` manifest action (WC-2026-10-10-hierarchy-json-manifest).
 *
 * The action was `engineDenied` on the premise that it "writes install hierarchy
 * dump files into the PHP tree". Post-cutover that premise is gone: the
 * destination is the ENGINE's own `install/import/hierarchy` — a fixed,
 * repo-root-derived constant (PHP took it from an `EXPORT_HIERARCHY_PATH`
 * operator constant that was never carried into the TS engine).
 *
 * What carries the risk, and is therefore driven here for real:
 *   - the tipo grammar. It is inlined into a psql `\copy` argument, where psql
 *     performs NO variable interpolation, so a bind parameter is impossible.
 *     Loosen `safeExportTipo` and the shell command is caller-shaped.
 *   - the SCOPE (2026-10-10): an explicit list only. `'*'` and `'all'` are
 *     refused lines; a tipo must be the hierarchy53/hierarchy58 section of an
 *     ACTIVE registry row; the CORE `lg` (matrix_langs, seed-shipped) is
 *     refused whatever the registry says.
 *   - the file probe. `\copy … TO PROGRAM` reports psql's exit, not gzip's, so
 *     "the file exists" is the only honest verdict.
 *   - per-entry isolation: one bad tipo must produce an error LINE, never
 *     discard the files the other entries produced.
 *   - hierarchy.json: written atomically, re-read by the FORMAT's own reader,
 *     and its data_files digests are the bytes of the dumps present then.
 *
 * SCRATCH HYGIENE: the gate BUILDS its situation on the suite database — an
 * ACTIVE `zzeh` registry row (hierarchy1 in matrix_hierarchy_main) naming the
 * scratch thesaurus `zzeh1` / model `zzeh2`, an INACTIVE `zzei` row naming
 * `zzei1`, and two `zzeh1` term rows in matrix_hierarchy (never an install's
 * real hierarchy records — the generic-TLD law). Dumps and the manifest land
 * in a mkdtemp directory, NEVER in the repo's vendored install/import/hierarchy
 * — a stray `zzeh1.copy.gz` or `hierarchy.json` there would be offered by the
 * installer as if it were shipped. All swept in afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
	exportableTipos,
	exportCopyCommand,
	exportDirRefusal,
	exportHierarchy,
	exportHierarchyJson,
	exportTipoRefusal,
	HIERARCHY_EXPORT_TABLE,
	HIERARCHY_EXPORT_URL_PREFIX,
	importHint,
	parseExportScope,
	planListEntries,
	safeExportTipo,
	tipoTld,
	widget,
} from '../../src/core/area_maintenance/widgets/export_hierarchy.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { HIERARCHY_IMPORT_DIR } from '../../src/core/install/paths.ts';
import {
	HIERARCHY_MANIFEST_FILE,
	parseHierarchyManifestText,
	sha256Hex,
} from '../../src/core/ontology/hierarchy_manifest_format.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

/** The scratch hierarchy: tld, thesaurus and model tipos of the ACTIVE row. */
const SCRATCH_TLD = 'zzeh';
const SCRATCH_TIPO = 'zzeh1';
const SCRATCH_MODEL_TIPO = 'zzeh2';
/** The INACTIVE row's thesaurus tipo — must be refused. */
const INACTIVE_TIPO = 'zzei1';
/** A second ACTIVE row with no dump anywhere: an EMPTY thesaurus of the manifest. */
const EMPTY_TLD = 'zzej';
const SCRATCH_IDS = [90001, 90002];
/** lg-spa's lg1 record — shipped by the seed's matrix_langs. */
const SPANISH_LG1 = 17344;

const REGISTRY_TABLE = 'matrix_hierarchy_main';
const REGISTRY = 'hierarchy1';

const dd64 = (tipo: string, id: 1 | 2) => [
	{ id: 1, type: 'dd151', section_id: id, section_tipo: 'dd64', from_component_tipo: tipo },
];
const locator = (tipo: string, sectionTipo: string, sectionId: number) => [
	{
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: tipo,
	},
];
const text = (value: string) => [{ id: 1, lang: 'lg-nolan', value }];

let outDir: string;
const registryIds: number[] = [];

/** One scratch hierarchy1 registry row (active or not) naming its target sections. */
async function insertRegistryRow(tld: string, active: boolean): Promise<void> {
	const id = await insertMatrixRecordWithCounter(REGISTRY_TABLE, REGISTRY, {
		string: {
			hierarchy5: [{ id: 1, lang: 'lg-eng', value: `Scratch ${tld}` }],
			hierarchy6: text(tld.toUpperCase()),
			hierarchy53: text(`${tld}1`),
			hierarchy58: text(`${tld}2`),
			hierarchy109: text('hierarchy20'),
		},
		relation: {
			hierarchy4: dd64('hierarchy4', active ? 1 : 2),
			hierarchy125: dd64('hierarchy125', 1),
			hierarchy8: locator('hierarchy8', 'lg1', SPANISH_LG1),
			hierarchy9: locator('hierarchy9', 'hierarchy13', 2),
		},
	});
	registryIds.push(id);
}

async function sweep(): Promise<void> {
	await sql`DELETE FROM matrix_hierarchy WHERE section_tipo IN (${SCRATCH_TIPO}, ${SCRATCH_MODEL_TIPO}, ${INACTIVE_TIPO})`;
	await sql.unsafe(
		`DELETE FROM "${REGISTRY_TABLE}" WHERE section_tipo = $1
		   AND lower(string->'hierarchy6'->0->>'value') IN ('zzeh', 'zzei', 'zzej')`,
		[REGISTRY],
	);
	for (const id of registryIds.splice(0)) await deleteMatrixRecord(REGISTRY_TABLE, REGISTRY, id);
}

beforeAll(async () => {
	await assertTestDatabase('export_hierarchy_export_native');
	await sweep();
	outDir = mkdtempSync(join(tmpdir(), 'dedalo_export_hierarchy_'));
	await insertRegistryRow(SCRATCH_TLD, true);
	await insertRegistryRow('zzei', false);
	await insertRegistryRow(EMPTY_TLD, true);
	for (const id of SCRATCH_IDS) {
		await sql`INSERT INTO matrix_hierarchy (section_id, section_tipo, data)
			VALUES (${id}, ${SCRATCH_TIPO}, ${JSON.stringify({ zzeh2: [{ value: `row ${id}` }] })}::text::jsonb)
			ON CONFLICT DO NOTHING`;
	}
});

afterAll(async () => {
	await sweep();
	rmSync(outDir, { recursive: true, force: true });
});

describe('safeExportTipo — the shell/filename grammar', () => {
	test('accepts a real section tipo', () => {
		expect(safeExportTipo('testgeoa1')).toBe(true);
		expect(safeExportTipo('hierarchy125')).toBe(true);
	});

	test('rejects a bare tld, an uppercase or underscored name, and anything shell-shaped', () => {
		// Each of these would otherwise be inlined verbatim into the `\copy`
		// argument and into the produced file's basename.
		for (const bad of [
			'es',
			'1',
			'ES1',
			'zz_1',
			"testgeoa1'; DROP",
			'testgeoa1 --help',
			'../testgeoa1',
			'testgeoa1;ls',
		]) {
			expect(safeExportTipo(bad), bad).toBe(false);
		}
	});
});

describe('parseExportScope — an explicit list only', () => {
	test('a list is split and trimmed, empties dropped, INVALIDS KEPT', () => {
		// Invalid entries must survive parsing: they earn an error line in the
		// run. Filtering them here would make a typo vanish silently.
		expect(parseExportScope(' testgeoa1 , , ES1 ,ts1')).toEqual(['testgeoa1', 'ES1', 'ts1']);
	});

	test("the retired '*' and 'all' are plain entries — the plan refuses them", () => {
		expect(parseExportScope('*')).toEqual(['*']);
		expect(parseExportScope('all')).toEqual(['all']);
	});

	test('a non-string (or empty) input is an empty list, not a crash', () => {
		expect(parseExportScope(undefined)).toEqual([]);
		expect(parseExportScope('   ')).toEqual([]);
	});
});

describe('the scope plan — active hierarchy53/58 only, never the core lg', () => {
	const exportable = exportableTipos([
		{ target: 'zzehq1', model: 'zzehq2', tld: 'ZZEHQ' },
		{ target: 'lg1', model: null, tld: 'LG' },
		{ target: null, model: null, tld: 'zzehr' },
		// A row whose thesaurus section is NOT its own `<tld>1` (live: the People row's
		// target is a resources section).
		{ target: 'zzother7', model: 'zzehp2', tld: 'zzehp' },
	]);

	test('tipoTld is the letter prefix', () => {
		expect(tipoTld('zzehq1')).toBe('zzehq');
		expect(tipoTld('lg2')).toBe('lg');
		expect(tipoTld('hierarchy125')).toBe('hierarchy');
	});

	test('exportable = the thesaurus AND model tipos of the given rows, keyed to the lowercased tld', () => {
		expect([...exportable.entries()]).toEqual([
			['zzehq1', 'zzehq'],
			['zzehq2', 'zzehq'],
			['lg1', 'lg'],
			['zzother7', 'zzehp'],
			['zzehp2', 'zzehp'],
		]);
	});

	test("a section that is not the row's own <tld>1/<tld>2 is refused: hierarchy.json could never list its dump", () => {
		expect(exportTipoRefusal('zzother7', exportable)).toBe(
			"Refused zzother7: only a hierarchy's own zzehp1 / zzehp2 sections can be vendored (hierarchy.json lists no other data file)",
		);
		// The same row's own model section is still admitted.
		expect(exportTipoRefusal('zzehp2', exportable)).toBeNull();
	});

	test('an active thesaurus or model tipo is admitted', () => {
		expect(exportTipoRefusal('zzehq1', exportable)).toBeNull();
		expect(exportTipoRefusal('zzehq2', exportable)).toBeNull();
	});

	test("'*' and 'all' are refused with the reason, not as a typo", () => {
		expect(exportTipoRefusal('*', exportable)).toContain('explicit list of section tipos');
		expect(exportTipoRefusal('all', exportable)).toContain('explicit list of section tipos');
	});

	test('lg is refused EVEN WHEN an active row names lg1 — and lg2 that no row names', () => {
		expect(exportTipoRefusal('lg1', exportable)).toContain('CORE hierarchy (lg)');
		expect(exportTipoRefusal('lg2', exportable)).toContain('CORE hierarchy (lg)');
	});

	test('a tipo no active row names is refused', () => {
		expect(exportTipoRefusal('zzehs1', exportable)).toContain(
			'not the thesaurus (hierarchy53) or model',
		);
	});

	test('the plan: one line per refusal, one entry per admitted tipo, a repeat dumped once', () => {
		const plan = planListEntries(['zzehq1', 'lg1', 'zzehq1', 'nope', 'zzehs1'], exportable);
		expect(plan.entries.map((entry) => entry.fileName)).toEqual(['zzehq1.copy.gz']);
		expect(plan.entries[0]?.table).toBe(HIERARCHY_EXPORT_TABLE);
		expect(plan.errors).toHaveLength(3);
	});

	test('an empty request is one line naming the list form', () => {
		// (the message's own example tipos are not repeated here: a geo tipo named in
		// the test tree pulls that thesaurus into the suite fixture — hierarchy_allowlist.ts)
		const errors = planListEntries([], exportable).errors;
		expect(errors).toHaveLength(1);
		expect(errors[0]).toStartWith('No section tipo requested. List section tipos, e.g. ');
	});
});

describe('the psql command and its neighbours', () => {
	test('the copy streams through gzip to the final name in one pass', () => {
		const command = exportCopyCommand(
			'matrix_hierarchy',
			"section_tipo = 'testgeoa1'",
			'section_id ASC',
			'/tmp/testgeoa1.copy.gz',
		);
		expect(command.startsWith('\\copy (SELECT section_id,section_tipo,')).toBe(true);
		expect(command).toContain("TO PROGRAM 'gzip -c > /tmp/testgeoa1.copy.gz && sync'");
	});

	test('the import hint names the one table dumps go back into', () => {
		expect(importHint()).toContain('\\copy matrix_hierarchy(section_id,section_tipo,');
	});

	test('a destination that would break out of the shell quoting is REFUSED', () => {
		expect(exportDirRefusal("/home/o'brien/dedalo/install/import/hierarchy")).toContain(
			'cannot be used in a shell command',
		);
	});

	test('a missing destination is refused, the real one is accepted', () => {
		expect(exportDirRefusal(join(tmpdir(), 'no_such_dedalo_export_dir'))).toContain(
			'does not exist',
		);
		expect(exportDirRefusal(HIERARCHY_IMPORT_DIR)).toBeNull();
	});
});

describe('the widget surface', () => {
	test('getValue serves the FIXED path — without it the panel renders its dead-end', async () => {
		const value = await widget.getValue?.({}, { userId: -1, isGlobalAdmin: true } as never);
		expect((value?.data as { export_hierarchy_path: string }).export_hierarchy_path).toBe(
			HIERARCHY_IMPORT_DIR,
		);
	});

	test('both export actions are registered and no longer engine-denied', () => {
		expect(typeof widget.apiActions?.export_hierarchy).toBe('function');
		expect(typeof widget.apiActions?.export_hierarchy_json).toBe('function');
	});
});

type FilesExtend = {
	files: { file_name: string; url: string; bytes: number | null; table: string }[];
};

describe('a real dump of a scratch active hierarchy', () => {
	test('produces a gzip file whose rows are the ones asked for', async () => {
		const response = await exportHierarchy({ section_tipo: SCRATCH_TIPO }, { outDir });
		expect(response.errors ?? []).toEqual([]);
		expect(response.data).toBe(true);

		const files = (response.extend as FilesExtend).files;
		expect(files).toHaveLength(1);
		expect(files[0]?.file_name).toBe(`${SCRATCH_TIPO}.copy.gz`);
		expect(files[0]?.table).toBe('matrix_hierarchy');
		expect(files[0]?.url).toBe(`${HIERARCHY_EXPORT_URL_PREFIX}${SCRATCH_TIPO}.copy.gz`);
		expect(files[0]?.bytes).toBeGreaterThan(0);

		const text = gunzipSync(readFileSync(join(outDir, `${SCRATCH_TIPO}.copy.gz`))).toString('utf8');
		for (const id of SCRATCH_IDS) expect(text).toContain(String(id));
		// Scoped, not the whole table: no other section_tipo rode along.
		for (const line of text.split('\n').filter((l) => l !== '')) {
			expect(line.split('\t')[1]).toBe(SCRATCH_TIPO);
		}
		// 30 s, not the 5 s default: this case SPAWNS psql and gzips its output.
		// The default budget fitted an idle machine and nothing else — it timed out
		// under load, alone as well as after a neighbour (measured 2026-08-21), which
		// is a flake reporting "export is broken" when export is fine. The budget is
		// still bounded: a dump that really hangs still reddens this gate.
	}, 30000);

	test('refused tipos are error LINES that write nothing — the valid one still lands', async () => {
		const response = await exportHierarchy(
			{ section_tipo: `bad tipo,*,lg1,${INACTIVE_TIPO},${SCRATCH_TIPO}` },
			{ outDir },
		);
		expect(response.data).toBe(true); // the good one produced a file
		const errors = response.errors ?? [];
		expect(errors).toHaveLength(4);
		expect(errors[0]).toContain('Ignored invalid section tipo: bad tipo');
		expect(errors[1]).toContain("Ignored '*'");
		expect(errors[2]).toContain('Refused lg1: a CORE hierarchy (lg)');
		expect(errors[3]).toContain(`Refused ${INACTIVE_TIPO}: not the thesaurus`);
		expect((response.extend as FilesExtend).files.map((file) => file.file_name)).toEqual([
			`${SCRATCH_TIPO}.copy.gz`,
		]);
		// Outcome, not wording: nothing else was written for the refused tipos.
		for (const name of ['bad tipo.copy.gz', 'lg1.copy.gz', `${INACTIVE_TIPO}.copy.gz`]) {
			expect(existsSync(join(outDir, name)), name).toBe(false);
		}
	}, 30000);

	test('an unusable destination refuses the whole run without throwing', async () => {
		const response = await exportHierarchy(
			{ section_tipo: SCRATCH_TIPO },
			{ outDir: join(tmpdir(), 'no_such_dedalo_export_dir') },
		);
		expect(response.data).toBe(false);
		expect(response.errors?.[0]).toContain('does not exist');
		expect((response.extend as FilesExtend).files).toHaveLength(0);
	});
});

describe('hierarchy.json — the manifest action', () => {
	test('writes a file the FORMAT reader accepts, whose scratch entry matches its row and dumps', async () => {
		// The data file first (the order the panel prescribes): the manifest then
		// digests the dump present in the directory at that moment.
		await exportHierarchy({ section_tipo: SCRATCH_TIPO }, { outDir });
		const now = new Date('2026-10-10T12:00:00Z');
		const response = await exportHierarchyJson({ outDir, now });
		expect(response.data).toBe(true);

		const path = join(outDir, HIERARCHY_MANIFEST_FILE);
		const manifest = parseHierarchyManifestText(readFileSync(path, 'utf8'));
		const extend = response.extend as FilesExtend & {
			active_hierarchies: number;
			empty_hierarchies: string[];
		};
		expect(extend.files[0]?.file_name).toBe(HIERARCHY_MANIFEST_FILE);
		expect(extend.files[0]?.url).toBe(`${HIERARCHY_EXPORT_URL_PREFIX}${HIERARCHY_MANIFEST_FILE}`);
		expect(extend.files[0]?.bytes).toBe(readFileSync(path).byteLength);
		expect(extend.active_hierarchies).toBe(manifest.active_hierarchies.length);

		const entry = manifest.active_hierarchies.find((item) => item.tld === SCRATCH_TLD);
		expect(entry?.lang.section_id).toBe(SPANISH_LG1);
		expect(entry?.typology_id).toBe(2);
		expect(entry?.real_section_tipo).toBe('hierarchy20');
		expect(entry?.active_in_thesaurus).toBe(true);
		expect(entry?.name).toBe(`Scratch ${SCRATCH_TLD}`);
		// Checksums are the bytes on disk; the model dump was never produced.
		expect(entry?.data_files).toEqual([
			{
				file: `${SCRATCH_TIPO}.copy.gz`,
				sha256: sha256Hex(readFileSync(join(outDir, `${SCRATCH_TIPO}.copy.gz`))),
			},
		]);
		// The INACTIVE row is not offered; the core lg never lists a data file.
		expect(manifest.active_hierarchies.some((item) => item.tld === 'zzei')).toBe(false);
		for (const item of manifest.active_hierarchies.filter((i) => i.tld === 'lg')) {
			expect(item.data_files).toEqual([]);
		}
		// An active hierarchy with no dump here is named as an empty thesaurus — exactly
		// the non-core entries whose data_files is [] (the scratch EMPTY row among them),
		// never the one with a dump, never the core lg.
		const expected = manifest.active_hierarchies
			.filter((item) => item.data_files.length === 0 && item.tld !== 'lg')
			.map((item) => item.tld);
		expect(expected).toContain(EMPTY_TLD);
		expect(extend.empty_hierarchies).toEqual(expected);
		expect(extend.empty_hierarchies).not.toContain(SCRATCH_TLD);
		expect(extend.empty_hierarchies).not.toContain('lg');
		expect(manifest.date).toBeString();
		// Atomic write: no temp sibling is left behind.
		expect(readdirSync(outDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
	}, 30000);

	test('an unusable destination writes nothing and says so', async () => {
		const response = await exportHierarchyJson({
			outDir: join(tmpdir(), 'no_such_dedalo_export_dir'),
		});
		expect(response.data).toBe(false);
		expect(response.errors?.[0]).toContain('does not exist');
	});
});
