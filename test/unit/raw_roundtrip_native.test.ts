/**
 * THE ARCHIVE ROUND TRIP — `src/core/archive/` extract → restore is LOSSLESS
 * for every component model of the registry (audit 2026-08-26 P1-10; DATA-10,
 * DATA-13).
 *
 * THE RECONSTRUCTION TEST the audit asked for: a section set is BUILT (the
 * zzarc situation — every registry model holding a stored value, two raw-planted
 * twins the JS value path cannot express, real media files in a marked scratch
 * root), extracted, then DROPPED — rows, ontology nodes, counters, media — so
 * the database and the media tree no longer hold it; then restored from the
 * artifact alone, and the eleven jsonb columns of every record are asserted
 * BYTE-EQUAL to the pre-drop snapshot, the ontology rows structurally equal,
 * the media files digest-identical. The suite database is the destination
 * (the engine pool binds one database); "a database that no longer holds it"
 * is what the drop establishes.
 *
 * CENSUS: TOTAL over `allComponentModels()` — every registry model with a
 * storage column must hold a value in the situation (floor asserted), the
 * models storing nothing are the ENUMERATED shrink-only exemption list with a
 * reason each (`ZZARC_STORAGE_EXEMPT`). The audit found the CSV loss by exactly
 * this sweep; the gate makes the sweep permanent.
 *
 * POSITIVE CONTROLS: the raw `1.10` numeric (a parse/stringify hop makes it
 * `1.1`), the `<br>`/newline text_area value (the CSV door rewrites it), the
 * geolocation item `id` (the CSV door drops it), a sparse record whose NULL
 * columns must come back NULL, and a tampered records file that the restore
 * refuses by digest.
 *
 * VIRTUAL SECTIONS (the commonest section family of a heritage install — every
 * thesaurus hierarchy, every alias): their records store under the REAL
 * section's component tipos, so an archive of the virtual section ALONE must
 * carry the real section's subtree or its column keys are defined nowhere in
 * the artifact. The situation holds one (zzarc30 over zzarc10); the
 * self-description invariant — every column key of every archived record is a
 * row of ontology.json subtree — is asserted over the whole set AND over the
 * virtual-alone extraction, and the virtual section rides the round trip.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractArchive } from '../../src/core/archive/extract.ts';
import {
	type ArchiveManifest,
	MANIFEST_FILE,
	NOT_ARCHIVED,
	ontologyDigest,
	ontologyRowsEqual,
	readArchiveOntology,
	readArchiveRecords,
	readManifest,
	sha256File,
	sha256Hex,
} from '../../src/core/archive/manifest.ts';
import { restoreArchive, verifyArchive } from '../../src/core/archive/restore.ts';
import { getComponentModel } from '../../src/core/components/registry.ts';
import { readDdOntologyRow } from '../../src/core/db/dd_ontology.ts';
import {
	MATRIX_JSONB_COLUMNS,
	type MatrixRecord,
	readMatrixRecordBatch,
} from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	type RagRecordEvent,
	registerRagRecordHook,
} from '../../src/core/section_record/save_event.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';
import {
	dropSituation,
	ensureZzarc,
	plantZzarcMedia,
	storageModelsOfRegistry,
	VALUE_BY_MODEL,
	ZZARC_ARCHIVED_IDS,
	ZZARC_ARCHIVED_SECTIONS,
	ZZARC_EXTERNAL_DANGLING,
	ZZARC_EXTERNAL_EXISTING,
	ZZARC_MAIN,
	ZZARC_MAIN_IDS,
	ZZARC_RAW_NUMBER,
	ZZARC_STORAGE_EXEMPT,
	ZZARC_TARGET,
	ZZARC_TARGET_CHILD,
	ZZARC_TARGET_IDS,
	ZZARC_VIRTUAL,
	ZZARC_VIRTUAL_IDS,
	zzarcSituation,
} from '../helpers/zzarc_archive_situation.ts';
import { zzarcMediaDigests } from '../helpers/zzarc_media_digests.ts';

const SCRATCH = scratchDir('archive_roundtrip');
const MEDIA_ROOT = join(SCRATCH, 'media_root');
const ARCHIVE = join(SCRATCH, 'archive');
const VIRTUAL_ALONE = join(SCRATCH, 'archive_virtual_alone');
const s = zzarcSituation();
const RECORD_COUNT = ZZARC_ARCHIVED_IDS.reduce((n, [, ids]) => n + ids.length, 0);

/** rawText of every record of the archived sections, keyed `tipo/id`. */
async function snapshotRows(): Promise<Map<string, MatrixRecord['rawText']>> {
	const out = new Map<string, MatrixRecord['rawText']>();
	for (const [tipo, ids] of ZZARC_ARCHIVED_IDS) {
		const table = await getMatrixTableFromTipo(tipo);
		if (table === null) continue;
		const rows = await readMatrixRecordBatch(table, tipo, [...ids]);
		for (const [id, row] of rows) out.set(`${tipo}/${id}`, row.rawText);
	}
	return out;
}

/**
 * The self-description invariant of an artifact: every column key of every
 * archived record (a component tipo) is a row of ontology.json `subtree`.
 * Returns the undefined keys, `tipo/id.column:key`, so a failure names them.
 */
function undefinedColumnKeys(archiveDir: string, m: ArchiveManifest): string[] {
	const defined = new Set(readArchiveOntology(archiveDir, m).subtree.map((row) => row.tipo));
	const undefinedKeys: string[] = [];
	for (const section of m.sections) {
		for (const line of readArchiveRecords(archiveDir, section)) {
			for (const [column, text] of Object.entries(line.columns)) {
				if (text === null || column === 'data' || column === 'meta') continue;
				for (const key of Object.keys(JSON.parse(text) as Record<string, unknown>)) {
					if (!defined.has(key)) {
						undefinedKeys.push(`${section.section_tipo}/${line.section_id}.${column}:${key}`);
					}
				}
			}
		}
	}
	return undefinedKeys;
}

let before: Map<string, MatrixRecord['rawText']>;
let beforeOntology: Map<string, Awaited<ReturnType<typeof readDdOntologyRow>>>;
let beforeMedia: Map<string, string>;
let manifest: ArchiveManifest;

beforeAll(async () => {
	if (!DB_READY) return;
	rmSync(SCRATCH, { recursive: true, force: true });
	resetMediaRoot(MEDIA_ROOT);
	await dropSituation(s);
	await ensureZzarc(s);
	plantZzarcMedia(MEDIA_ROOT);
	before = await snapshotRows();
	beforeOntology = new Map();
	for (const node of s.nodes) beforeOntology.set(node.tipo, await readDdOntologyRow(node.tipo));
	beforeMedia = zzarcMediaDigests(MEDIA_ROOT);
	manifest = (
		await extractArchive({
			sectionTipos: [...ZZARC_ARCHIVED_SECTIONS],
			outDir: ARCHIVE,
			mediaRoot: MEDIA_ROOT,
		})
	).manifest;
});

afterAll(async () => {
	if (DB_READY) expect(await dropSituation(s)).toBe(0);
	rmSync(SCRATCH, { recursive: true, force: true });
});

describe.if(DB_READY)('census — every registry model stores a value in the situation', () => {
	test('TOTAL over allComponentModels(): every storage model has a stored value; exemptions enumerated with reasons', () => {
		const models = storageModelsOfRegistry();
		expect(models.length).toBeGreaterThan(35);
		const missing = models.filter((m) => !(m in VALUE_BY_MODEL));
		expect(missing).toEqual([]);
		// The exemption list is PINNED (set equality), not merely reasoned: an
		// exempt model with a substantive-looking reason would otherwise narrow the
		// TOTAL sweep silently for any model that shares a jsonb column. And the
		// stated reason is asserted MECHANICALLY: the one exempt model is the one
		// whose descriptor column is the structural `section_id`, never a jsonb one.
		expect(Object.keys(ZZARC_STORAGE_EXEMPT)).toEqual(['component_section_id']);
		for (const [model, reason] of Object.entries(ZZARC_STORAGE_EXEMPT)) {
			expect(reason.length).toBeGreaterThan(20);
			expect(model in VALUE_BY_MODEL).toBe(false);
			expect(getComponentModel(model)?.column).toBe('section_id');
			expect(MATRIX_JSONB_COLUMNS as readonly string[]).not.toContain('section_id');
		}
		// Positive control of the pin: a model that SHARES a jsonb column with
		// others (component_info stores in `misc`, as its alias component_state
		// does) is NOT exempt — added to the list, it would fail the set equality
		// above even though no column of zzarc1/1 would go NULL.
		expect(getComponentModel('component_info')?.column).toBe('misc');
		expect('component_info' in VALUE_BY_MODEL).toBe(true);
		expect('component_state' in VALUE_BY_MODEL).toBe(true);
		// Every planted value really landed in its column of zzarc1/1.
		const row = before.get(`${ZZARC_MAIN}/1`) as MatrixRecord['rawText'];
		for (const { tipo, column } of Object.values(VALUE_BY_MODEL)) {
			expect(row[column as keyof typeof row], `${tipo} in ${column}`).toContain(`"${tipo}"`);
		}
		// All eleven columns are non-null on the full record (the byte check covers them all).
		for (const column of MATRIX_JSONB_COLUMNS) expect(row[column], column).not.toBeNull();
	});
});

describe.if(DB_READY)('the artifact is complete and self-describing', () => {
	test('manifest: engine version, sections with table + counts, ontology digest, per-file digests, media, not_archived', () => {
		expect(manifest.engine_version).toMatch(/^\d+\.\d+\.\d+/);
		expect(
			manifest.sections.map((x) => [
				x.section_tipo,
				x.real_section_tipo,
				x.matrix_table,
				x.record_count,
			]),
		).toEqual([
			[ZZARC_MAIN, null, 'matrix_test', ZZARC_MAIN_IDS.length],
			[ZZARC_TARGET, null, 'matrix_test', ZZARC_TARGET_IDS.length],
			[ZZARC_VIRTUAL, ZZARC_TARGET, 'matrix_test', ZZARC_VIRTUAL_IDS.length],
		]);
		expect(manifest.ontology.digest).toMatch(/^[0-9a-f]{64}$/);
		// MAIN + its model children, TARGET + its child, VIRTUAL + its own decoration.
		expect(manifest.ontology.subtree_count).toBe(1 + Object.keys(VALUE_BY_MODEL).length + 2 + 2);
		expect(manifest.ontology.referenced_count).toBeGreaterThan(3); // model nodes, test24, zzarc20
		expect(manifest.media.file_count).toBe(3);
		expect(manifest.not_archived).toEqual([...NOT_ARCHIVED]);
		// readManifest re-verifies every digest; verifyArchive parses everything.
		expect(readManifest(ARCHIVE).ontology.sha256).toBe(manifest.ontology.sha256);
		expect(verifyArchive(ARCHIVE).sections.length).toBe(ZZARC_ARCHIVED_SECTIONS.length);
		// SELF-DESCRIPTION over the whole set: no record column key without a definition.
		expect(undefinedColumnKeys(ARCHIVE, manifest)).toEqual([]);
	});

	test('a VIRTUAL section archived ALONE carries its real section: every column key defined, real_section_tipo named, verify refuses an artifact that is not self-describing', async () => {
		// The virtual record's only key is the REAL section's child — the
		// self-description invariant is vacuous unless the walk really sees it.
		const alone = (
			await extractArchive({
				sectionTipos: [ZZARC_VIRTUAL],
				outDir: VIRTUAL_ALONE,
				mediaRoot: MEDIA_ROOT,
			})
		).manifest;
		expect(alone.sections.map((x) => [x.section_tipo, x.real_section_tipo])).toEqual([
			[ZZARC_VIRTUAL, ZZARC_TARGET],
		]);
		const subtree = readArchiveOntology(VIRTUAL_ALONE, alone).subtree.map((row) => row.tipo);
		expect(subtree).toContain(ZZARC_VIRTUAL);
		expect(subtree).toContain('zzarc3001'); // the virtual section's OWN decoration child
		expect(subtree).toContain(ZZARC_TARGET); // the REAL section …
		expect(subtree).toContain(ZZARC_TARGET_CHILD); // … and the child that defines the record's key
		expect(subtree).not.toContain(ZZARC_MAIN); // the walk is the real section's subtree, not the TLD
		const lines = readArchiveRecords(
			VIRTUAL_ALONE,
			alone.sections[0] as ArchiveManifest['sections'][0],
		);
		expect(lines.map((l) => l.section_id)).toEqual([...ZZARC_VIRTUAL_IDS]);
		expect(lines[0]?.columns.string).toContain(`"${ZZARC_TARGET_CHILD}"`);
		expect(undefinedColumnKeys(VIRTUAL_ALONE, alone)).toEqual([]);
		// Positive control of the walk: the same artifact with the real section's
		// subtree cut out of ontology.json is the reviewer's refuted shape — the
		// invariant names every orphaned key, and verify refuses the artifact
		// (digest first; with the digest re-stamped, the self-description check).
		const ontologyPath = join(VIRTUAL_ALONE, alone.ontology.file);
		const manifestPath = join(VIRTUAL_ALONE, MANIFEST_FILE);
		const originalOntology = readFileSync(ontologyPath, 'utf8');
		const originalManifest = readFileSync(manifestPath, 'utf8');
		try {
			const cut = JSON.parse(originalOntology) as ReturnType<typeof readArchiveOntology>;
			cut.subtree = cut.subtree.filter(
				(row) => row.tipo !== ZZARC_TARGET && row.tipo !== ZZARC_TARGET_CHILD,
			);
			const cutText = JSON.stringify(cut);
			writeFileSync(ontologyPath, cutText);
			expect(() => verifyArchive(VIRTUAL_ALONE)).toThrow(/sha256 mismatch/);
			const restamped = JSON.parse(originalManifest) as ArchiveManifest;
			restamped.ontology.sha256 = sha256Hex(cutText);
			restamped.ontology.digest = ontologyDigest(cut.subtree);
			writeFileSync(manifestPath, JSON.stringify(restamped));
			expect(undefinedColumnKeys(VIRTUAL_ALONE, restamped)).toEqual([
				`${ZZARC_VIRTUAL}/1.string:${ZZARC_TARGET_CHILD}`,
			]);
			expect(() => verifyArchive(VIRTUAL_ALONE)).toThrow(/not self-describing.*zzarc10/);
		} finally {
			writeFileSync(ontologyPath, originalOntology);
			writeFileSync(manifestPath, originalManifest);
		}
		expect(verifyArchive(VIRTUAL_ALONE).sections.length).toBe(1);
	});

	test('records carry the RAW jsonb text: the 1.10 numeric survives, the <br> markup survives, the geo item id survives', () => {
		const lines = readFileSync(join(ARCHIVE, 'records', `${ZZARC_MAIN}.ndjson`), 'utf8')
			.split('\n')
			.filter((l) => l !== '')
			.map((l) => JSON.parse(l) as { section_id: number; columns: Record<string, string | null> });
		expect(lines.map((l) => l.section_id)).toEqual([...ZZARC_MAIN_IDS]);
		const full = lines[0] as { columns: Record<string, string | null> };
		expect(full.columns.number).toContain('1.10');
		expect(full.columns.string).toContain('<br>second\\nthird');
		expect(full.columns.geo).toContain('"id": 7');
		expect(Object.keys(full.columns).sort()).toEqual([...MATRIX_JSONB_COLUMNS].sort());
		const sparse = lines[1] as { columns: Record<string, string | null> };
		expect(sparse.columns.number).toBeNull();
		expect(sparse.columns.media).toBeNull();
	});

	test('a tampered records file is refused by digest before anything is written', async () => {
		const file = join(ARCHIVE, 'records', `${ZZARC_MAIN}.ndjson`);
		const original = readFileSync(file, 'utf8');
		writeFileSync(file, original.replace('1.10', '1.1'));
		try {
			await expect(restoreArchive({ archiveDir: ARCHIVE, userId: 1 })).rejects.toThrow(
				/sha256 mismatch/,
			);
		} finally {
			writeFileSync(file, original);
		}
		expect(sha256File(file)).toBe((manifest.sections[0] as { sha256: string }).sha256);
	});

	test('a manifest naming a file OUTSIDE the archive is refused before it is read (read-side traversal gate)', () => {
		// A planted host file with a known digest: a reader without the gate would
		// hash it and report a clean verify over a path it had no business opening.
		const outside = join(SCRATCH, 'outside.ndjson');
		writeFileSync(outside, '');
		const manifestPath = join(ARCHIVE, MANIFEST_FILE);
		const original = readFileSync(manifestPath, 'utf8');
		const edited = JSON.parse(original) as ArchiveManifest;
		const section = edited.sections[0] as { file: string; sha256: string };
		section.file = '../outside.ndjson';
		section.sha256 = sha256File(outside);
		writeFileSync(manifestPath, JSON.stringify(edited));
		try {
			expect(() => verifyArchive(ARCHIVE)).toThrow(/escapes the archive/);
			const media = JSON.parse(original) as ArchiveManifest;
			(media.media.files[0] as { path: string }).path = '/../../outside.ndjson';
			writeFileSync(manifestPath, JSON.stringify(media));
			expect(() => readManifest(ARCHIVE)).toThrow(/escapes the archive/);
		} finally {
			writeFileSync(manifestPath, original);
		}
		expect(verifyArchive(ARCHIVE).sections.length).toBe(ZZARC_ARCHIVED_SECTIONS.length);
	});
});

describe.if(DB_READY)(
	'reconstruction — restore into a database and media tree that no longer hold it',
	() => {
		test('after drop + restore: eleven columns byte-equal per record, ontology rows equal, media digests identical, TM stamped', async () => {
			expect(before.size).toBe(RECORD_COUNT);
			expect(before.has(`${ZZARC_VIRTUAL}/1`)).toBe(true);
			expect(beforeMedia.size).toBe(3);
			// DROP: rows, TM, counters, every zzarc node, every media file.
			expect(await dropSituation(s)).toBe(0);
			resetMediaRoot(MEDIA_ROOT);
			expect(await getMatrixTableFromTipo(ZZARC_MAIN)).toBeNull();
			expect(await getMatrixTableFromTipo(ZZARC_VIRTUAL)).toBeNull();
			expect(zzarcMediaDigests(MEDIA_ROOT).size).toBe(0);

			// zzarc20 went with the TLD and is NOT in the archive, so its two addresses
			// resolve nowhere here: the restore REFUSES them (the locator gate's law,
			// asserted in conform_locator_existence_native) and, told to, writes them
			// dangling and REPORTS them — the round trip is about bytes.
			await expect(
				restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot: MEDIA_ROOT }),
			).rejects.toThrow(/resolve neither/);
			expect(await getMatrixTableFromTipo(ZZARC_MAIN)).toBeNull(); // nothing was written
			// The write obligations are DECLARED by the restore (write_obligations
			// tripwire pins the static reach; this records the RAG seam firing): one
			// 'index' event per restored record, delivered after the commit.
			const ragEvents: RagRecordEvent[] = [];
			registerRagRecordHook(async (event) => {
				ragEvents.push(event);
			});
			let outcome: Awaited<ReturnType<typeof restoreArchive>>;
			try {
				outcome = await restoreArchive({
					archiveDir: ARCHIVE,
					userId: 1,
					mediaRoot: MEDIA_ROOT,
					allowExternal: true,
				});
			} finally {
				registerRagRecordHook(null); // never leak the recorder into other suites
			}
			expect(outcome.records).toEqual({ inserted: before.size, overwritten: 0 });
			expect(ragEvents.map((e) => `${e.kind}:${e.sectionTipo}/${e.sectionId}`).sort()).toEqual(
				[...before.keys()].map((key) => `index:${key}`).sort(),
			);
			expect(outcome.ontology.inserted).toBe(manifest.ontology.subtree_count);
			expect(outcome.media).toEqual({ copied: 3, unchanged: 0, overwritten: 0 });
			expect(outcome.locators.dangling).toEqual([ZZARC_EXTERNAL_EXISTING, ZZARC_EXTERNAL_DANGLING]);
			expect(outcome.locators.internal).toBeGreaterThan(10);

			const after = await snapshotRows();
			expect(after.size).toBe(before.size);
			for (const [key, rawBefore] of before) {
				const rawAfter = after.get(key);
				expect(rawAfter, key).toBeDefined();
				for (const column of MATRIX_JSONB_COLUMNS) {
					expect(rawAfter?.[column], `${key}.${column}`).toBe(rawBefore[column] ?? null);
				}
			}
			expect(after.get(`${ZZARC_MAIN}/1`)?.number).toContain('1.10');
			expect(after.get(`${ZZARC_MAIN}/2`)?.number).toBeNull();
			// The virtual section resolves its table through the restored REAL section again.
			expect(await getMatrixTableFromTipo(ZZARC_VIRTUAL)).toBe('matrix_test');
			expect(after.get(`${ZZARC_VIRTUAL}/1`)?.string).toContain(`"${ZZARC_TARGET_CHILD}"`);

			for (const [tipo, rowBefore] of beforeOntology) {
				if (tipo.startsWith('zzarc20')) continue; // OUTSIDE — restored by the situation, not the archive
				const rowAfter = await readDdOntologyRow(tipo);
				expect(rowAfter, tipo).not.toBeNull();
				expect(
					ontologyRowsEqual(
						rowBefore as NonNullable<typeof rowBefore>,
						rowAfter as NonNullable<typeof rowAfter>,
					),
					tipo,
				).toBe(true);
			}

			// The fingerprint walk found the planted tree — an empty walk would make
			// "media digests identical" a comparison of nothing with nothing.
			const afterMedia = zzarcMediaDigests(MEDIA_ROOT);
			expect(afterMedia.size).toBeGreaterThanOrEqual(3);
			expect(afterMedia).toEqual(beforeMedia);

			const tm = (await sql`
			SELECT count(*)::int AS n FROM matrix_time_machine
			 WHERE section_tipo IN (${ZZARC_MAIN}, ${ZZARC_TARGET}, ${ZZARC_VIRTUAL}) AND tipo = section_tipo AND lang = 'lg-nolan'
		`) as { n: number }[];
			expect(tm[0]?.n).toBe(before.size);
		});

		test('a second restore over the same records is refused (records exist), and idempotent with overwrite', async () => {
			await expect(
				restoreArchive({
					archiveDir: ARCHIVE,
					userId: 1,
					mediaRoot: MEDIA_ROOT,
					allowExternal: true,
				}),
			).rejects.toThrow(/already exist/);
			const again = await restoreArchive({
				archiveDir: ARCHIVE,
				userId: 1,
				mediaRoot: MEDIA_ROOT,
				allowExternal: true,
				onExistingRecord: 'overwrite',
			});
			expect(again.records).toEqual({ inserted: 0, overwritten: before.size });
			expect(again.ontology).toEqual({
				inserted: 0,
				unchanged: manifest.ontology.subtree_count,
				overwritten: 0,
			});
			expect(again.media).toEqual({ copied: 0, unchanged: 3, overwritten: 0 });
			const after = await snapshotRows();
			expect(after.get(`${ZZARC_MAIN}/1`)?.number).toBe(
				before.get(`${ZZARC_MAIN}/1`)?.number as string,
			);
		});

		test('control: the raw number twin really is the shape a parse/stringify hop would lose', () => {
			expect(JSON.stringify(JSON.parse(ZZARC_RAW_NUMBER))).not.toContain('1.10');
			expect(existsSync(join(ARCHIVE, MANIFEST_FILE))).toBe(true);
		});
	},
);
