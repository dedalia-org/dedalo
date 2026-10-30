/**
 * A `localontology0` OVERRIDE survives an ontology IMPORT of the TLD it overrides.
 *
 * The update replaces a shared TLD's rows (scoped DELETE + COPY of `<tld>0`) and
 * re-derives dd_ontology from them; the installation's own overrides live in a
 * DIFFERENT section (`localontology0`, never updated — admissibleUpdateTlds) and
 * are applied by the parser at derive time (WC-2026-10-01-ontology-overwrite-scoped,
 * gated in ontology_overwrite_native). This gate proves the two meet: after an
 * import of the overridden TLD the re-derived node still carries the override,
 * and the override records themselves are byte-identical.
 *
 * The package is produced the way a master produces it — data_io.exportToFile
 * (the tool_ontology_parser export door) — and imported through the SHARED LOWER
 * LAYER every importer drives (ontology_update.importStagedOntologyFiles), under
 * the single-flight latch, on the configured (suite) connection.
 *
 * Proof the import really replaced the rows (not a no-op): the canonical lg-eng
 * term is DRIFTED in the database after the export; the import must put the
 * package's value back, while the overridden lg-spa stays the override's.
 *
 * Scratch: tld `zzov` (section zzov0) seeded directly (the ontology_overwrite_native
 * precedent) + localontology0 override records minted by the engine's id allocator
 * (insertMatrixRecordWithCounter) — no fixed section_id is claimed in a section the
 * installation owns; only the ids this run minted are swept. Every row the import door
 * provisions (registry record, root node, counter, TM) swept beforeEach + afterAll,
 * zero residue asserted.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertMatrixRecordWithCounter } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { connFromConfig } from '../../src/core/install/pg_exec.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { exportToFile } from '../../src/core/ontology/data_io.ts';
import { gunzipWithCaps } from '../../src/core/ontology/data_io_import.ts';
import {
	claimOntologyImportLatch,
	importStagedOntologyFiles,
	releaseOntologyImportLatch,
} from '../../src/core/ontology/ontology_update.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzov';
const SECTION = 'zzov0';
const LIKE = 'zzov%';
const LOCAL = 'localontology0';
/** The localontology0 section_ids THIS run minted (allocator-issued) — the only ones swept. */
const LOCAL_IDS: number[] = [];
/** LOCAL_IDS as a Postgres int[] literal (an empty run sweeps nothing of localontology0). */
const idsLiteral = (): string => `{${LOCAL_IDS.join(',')}}`;
// The sweep also takes any localontology0 record overriding a zzov0 node: zzov is
// this file's scratch TLD, so such a record is a crashed earlier run's leftover.

const tempRoots: string[] = [];

const loc = (sectionTipo: string, sectionId: number, from: string, type = 'dd151') => ({
	id: 1,
	type,
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

async function seed(
	sectionTipo: string,
	sectionId: number,
	relation: Record<string, unknown>,
	string: Record<string, unknown>,
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO matrix_ontology (section_id, section_tipo, data, relation, string)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)`,
		[
			sectionId,
			sectionTipo,
			JSON.stringify({ section_id: sectionId, section_tipo: sectionTipo }),
			JSON.stringify(relation),
			JSON.stringify(string),
		],
	);
}

/** A canonical zzov node (model dd9 component_input_text, parent zzov0), two-lang term. */
async function seedCanonical(sectionId: number, term: string): Promise<void> {
	await seed(
		SECTION,
		sectionId,
		{
			ontology6: [loc('dd0', 9, 'ontology6')],
			ontology15: [loc(SECTION, 0, 'ontology15', 'dd47')],
		},
		{
			ontology7: [{ id: 1, lang: 'lg-nolan', value: TLD }],
			ontology5: [
				{ id: 1, lang: 'lg-spa', value: term },
				{ id: 1, lang: 'lg-eng', value: `${term}-eng` },
			],
		},
	);
}

/**
 * An override of zzov0/<target> (ontology42) renaming its lg-spa term, created at
 * an ALLOCATOR-minted section_id (recorded in LOCAL_IDS for the sweep). Returns it.
 */
async function seedOverride(target: number, term: string): Promise<number> {
	const localId = await insertMatrixRecordWithCounter('matrix_ontology', LOCAL, {
		data: { section_tipo: LOCAL },
		relation: {
			ontology42: [loc(SECTION, target, 'ontology42')],
			ontology8: [loc('dd64', 1, 'ontology8')],
			ontology30: [loc('dd64', 2, 'ontology30')],
		},
		string: {
			ontology7: [{ id: 1, lang: 'lg-nolan', value: 'localontology' }],
			ontology5: [{ id: 1, lang: 'lg-spa', value: term }],
		},
	});
	LOCAL_IDS.push(localId);
	// the record's own data carries its address, as every seeded record here does
	await sql.unsafe(
		`UPDATE matrix_ontology SET data = $1::text::jsonb WHERE section_tipo = $2 AND section_id = $3`,
		[JSON.stringify({ section_id: localId, section_tipo: LOCAL }), LOCAL, localId],
	);
	return localId;
}

async function localRows(): Promise<unknown[]> {
	return (await sql.unsafe(
		`SELECT id, section_id, section_tipo, data::text AS d, relation::text AS r, string::text AS s
		   FROM matrix_ontology WHERE section_tipo = $1 AND section_id = ANY($2::int[]) ORDER BY section_id`,
		[LOCAL, idsLiteral()],
	)) as unknown[];
}

async function nodeTerm(tipo: string): Promise<Record<string, string> | null> {
	const rows = (await sql`SELECT term FROM dd_ontology WHERE tipo = ${tipo}`) as unknown as {
		term: Record<string, string> | string;
	}[];
	const term = rows[0]?.term;
	if (term === undefined) return null;
	return typeof term === 'string' ? JSON.parse(term) : term;
}

async function sweep(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM matrix_ontology WHERE section_tipo LIKE $1 OR (section_tipo = $2 AND (section_id = ANY($3::int[]) OR relation->'ontology42' @> '[{"section_tipo":"zzov0"}]'::jsonb))`,
		[LIKE, LOCAL, idsLiteral()],
	);
	await sql`DELETE FROM dd_ontology WHERE tipo LIKE ${LIKE}`;
	await sql`DELETE FROM matrix_counter WHERE tipo LIKE ${LIKE}`;
	await sql`DELETE FROM matrix_ontology_main WHERE string->'hierarchy6' @> '[{"value":"zzov"}]'::jsonb`;
	await sql`DELETE FROM matrix_time_machine WHERE section_tipo LIKE ${LIKE}`;
	await clearOntologyDerivedCaches();
}

async function residue(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*) FROM matrix_ontology
		          WHERE section_tipo LIKE $1 OR (section_tipo = $2 AND (section_id = ANY($3::int[]) OR relation->'ontology42' @> '[{"section_tipo":"zzov0"}]'::jsonb)))
		      + (SELECT count(*) FROM dd_ontology WHERE tipo LIKE $1)
		      + (SELECT count(*) FROM matrix_ontology_main
		          WHERE string->'hierarchy6' @> '[{"value":"zzov"}]'::jsonb) AS n`,
		[LIKE, LOCAL, idsLiteral()],
	)) as { n: number }[];
	return Number(rows[0]?.n);
}

beforeEach(async () => {
	await assertTestDatabase('ontology_override_survives_native');
	await sweep();
});

afterAll(async () => {
	await sweep();
	expect(await residue()).toBe(0);
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('a localontology0 override survives an import of its TLD', () => {
	test('the re-derived node carries the override; the override rows are untouched', async () => {
		await seedCanonical(1, 'canon');
		await seedCanonical(2, 'plain');
		const localId = await seedOverride(1, 'local');
		expect(localId).toBeGreaterThan(0);
		await clearOntologyDerivedCaches();
		const overridesBefore = await localRows();
		expect(overridesBefore).toHaveLength(1);

		// -- the master's export door produces the package
		const root = mkdtempSync(join(tmpdir(), 'zzov_override_'));
		tempRoots.push(root);
		const exported = await exportToFile(TLD, { ioBaseDir: join(root, 'io') });
		expect(exported.errors).toEqual([]);
		expect(exported.ok).toBe(true);
		const stagedPath = join(root, 'zzov.copy');
		await gunzipWithCaps(String(exported.path), stagedPath);

		// -- drift the canonical rows AFTER the export: the import must replace them
		await sql`UPDATE matrix_ontology
		             SET string = jsonb_set(string, '{ontology5,1,value}', '"drifted-eng"'::jsonb)
		           WHERE section_tipo = ${SECTION} AND section_id = 1`;
		const drifted = (await sql`SELECT string->'ontology5'->1->>'value' AS v FROM matrix_ontology
		                           WHERE section_tipo = ${SECTION} AND section_id = 1`) as unknown as {
			v: string;
		}[];
		expect(drifted[0]?.v).toBe('drifted-eng');

		// -- import through the shared lower layer, under the one latch
		expect(claimOntologyImportLatch()).toBe(true);
		let result: Awaited<ReturnType<typeof importStagedOntologyFiles>>;
		try {
			result = await importStagedOntologyFiles(
				[
					{
						tld: TLD,
						sectionTipo: SECTION,
						stagedPath,
						typologyId: null,
						nameData: null,
						dependencies: null,
					},
				],
				{ conn: connFromConfig(), userId: -1, recoveryDir: join(root, 'recovery') },
			);
		} finally {
			releaseOntologyImportLatch();
		}
		expect(result.errors).toEqual([]);
		expect(result.completed).toBe(true);

		// the import really replaced the rows: the drift is gone…
		// …and the override still wins on the lang it states
		expect(await nodeTerm('zzov1')).toEqual({ 'lg-spa': 'local', 'lg-eng': 'canon-eng' });
		// control: the node without an override is the package's own
		expect(await nodeTerm('zzov2')).toEqual({ 'lg-spa': 'plain', 'lg-eng': 'plain-eng' });
		// the override records are byte-identical (same row ids — never re-written)
		expect(await localRows()).toEqual(overridesBefore);
		// and no override record was projected as a node
		const projected = (await sql`SELECT tipo FROM dd_ontology
		                             WHERE tipo = ${`localontology${localId}`}`) as unknown[];
		expect(projected).toHaveLength(0);
	}, 120_000);
});
