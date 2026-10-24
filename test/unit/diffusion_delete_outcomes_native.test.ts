/**
 * deleteDiffusionRecord outcome branches + resolvePublishedFilePath, against a
 * SCRATCH diffusion ontology (tld `zzd`, see test/helpers/zzd_diffusion_fixture.ts).
 *
 * WHY A SCRATCH ONTOLOGY. The pre-existing gates (diffusion_delete.test.ts,
 * diffusion_native_delete.test.ts) bind to the LIVE numisdata_mib elements;
 * this database's dd_ontology predates `properties.diffusion.type`, so those
 * elements resolve `type:'unknown'`, `sqlTargets` is empty, and the case named
 * "no executor registered → pending" in fact passes through the FILE-UNLINK
 * branch. With our own elements every branch below is reachable and exact.
 *
 * ISOLATION. DIFFUSION_ACTIVITY_TABLE is pinned to a table private to these
 * two files, so dd1758 row counts are exact and can never be satisfied — or
 * corrupted — by another test file's rows. The engine resolves the table name
 * per call (activityTable()), so the pin holds regardless of which file
 * imported diffusion_delete.ts first — in one shared process, a module-load
 * const made this seam impossible. The executor is a module singleton
 * shared across the whole run: afterEach drops it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { sql } from '../../src/core/db/postgres.ts';
import {
	activityTable,
	deleteDiffusionRecord,
	registerNativeDiffusionSqlDelete,
	resetNativeDiffusionSqlDeleteForTests,
	resolvePublishedFile,
	resolvePublishedFilePath,
	unlinkPublishedFiles,
} from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import { getSectionDiffusionTargets } from '../../src/core/diffusion_bridge/diffusion_map.ts';
import { diffusionFilesRoot } from '../../src/core/diffusion_bridge/published_files.ts';
import { ensureDiffusionScratchTables } from '../helpers/diffusion_scratch_tables.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';
import {
	countZzdOntology,
	dropZzdOntology,
	FILE_SECTION,
	SQL_KEY_ONE,
	SQL_KEY_TWO,
	SQL_SECTION,
	seedZzdOntology,
} from '../helpers/zzd_diffusion_fixture.ts';

// The prefix guard in resolveActivityTable() accepts this name; the pin is
// restored in afterAll so it cannot bleed into later files.
const SCRATCH_ACTIVITY_TABLE = 'dedalo_ts_test_zzd_activity';
const DIFFUSION_ACTIVITY_TABLE = SCRATCH_ACTIVITY_TABLE;
const PRELOAD_ACTIVITY_TABLE = process.env.DIFFUSION_ACTIVITY_TABLE;
process.env.DIFFUSION_ACTIVITY_TABLE = SCRATCH_ACTIVITY_TABLE;

// A MARKED scratch root (test/helpers/media_scratch_root.ts): the producer both
// sides use (published_files.ts) asks the test-media guard for any root it
// resolves, the explicit one a gate passes included.
const FILE_ROOT = scratchDir('ts_zzd_diffusion');

/** dd1758 rows of one processed record (dd1763), ordered by element. */
async function activityRowsFor(
	sectionTipo: string,
	sectionId: number,
): Promise<{ element: string | null; elementId: string | null; action: string | null }[]> {
	// D16 + int-canonical (WC-2026-08-10-section-id-int-canonical): the action
	// rides its own `diffusion_action` key and dd1763 stores the INT address —
	// `->>` still projects text, so `action`/`elementId` stay strings here.
	return (await sql.unsafe(
		`SELECT relation->'dd1766'->0->>'section_tipo' AS element,
		        relation->'dd1766'->0->>'section_id'   AS "elementId",
		        relation->'dd1767'->0->>'diffusion_action' AS action
		 FROM "${DIFFUSION_ACTIVITY_TABLE}"
		 WHERE section_tipo = 'dd1758'
		   AND relation->'dd1763' @> $1::text::jsonb
		 ORDER BY relation->'dd1766'->0->>'section_id'`,
		[JSON.stringify([{ section_id: sectionId, section_tipo: sectionTipo }])],
	)) as { element: string | null; elementId: string | null; action: string | null }[];
}

/** Drop every scratch-range dd1758 row of the private activity table. */
async function purgeScratchActivityRows(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM "${DIFFUSION_ACTIVITY_TABLE}"
		 WHERE section_tipo = 'dd1758'
		   AND (relation->'dd1763'->0->>'section_id') ~ '^932[0-9]{3}$'`,
	);
}

beforeAll(async () => {
	// The seam must be the one this file pinned, or every dd1758 count below is
	// measured against a table other files also write.
	expect(activityTable()).toBe(SCRATCH_ACTIVITY_TABLE);
	// Build the private activity table before the raw purges touch it.
	await ensureDiffusionScratchTables();
	const { preCount } = await seedZzdOntology();
	// Standing hygiene: the scratch tld must be EMPTY before the fixture lands.
	expect(preCount).toBe(0);
	markMediaRoot(FILE_ROOT);
});

beforeEach(async () => {
	await purgeScratchActivityRows();
});

afterEach(() => {
	resetNativeDiffusionSqlDeleteForTests();
});

afterAll(async () => {
	resetNativeDiffusionSqlDeleteForTests();
	await purgeScratchActivityRows();
	const residue = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${DIFFUSION_ACTIVITY_TABLE}"
		 WHERE section_tipo = 'dd1758'
		   AND (relation->'dd1763'->0->>'section_id') ~ '^932[0-9]{3}$'`,
	)) as { n: number }[];
	expect(residue[0]?.n).toBe(0);
	await dropZzdOntology();
	expect(await countZzdOntology()).toBe(0);
	rmSync(FILE_ROOT, { recursive: true, force: true });
	// Call-time resolution means the pin would otherwise bleed into every later
	// file in this process — hand the preload's table back.
	if (PRELOAD_ACTIVITY_TABLE === undefined) delete process.env.DIFFUSION_ACTIVITY_TABLE;
	else process.env.DIFFUSION_ACTIVITY_TABLE = PRELOAD_ACTIVITY_TABLE;
});

describe('scratch diffusion fixture', () => {
	test('the sql section resolves exactly the two scratch targets', async () => {
		const targets = await getSectionDiffusionTargets(SQL_SECTION);
		expect(
			targets
				.map(
					(target) =>
						`${target.type}:${target.element_tipo}:${target.database_name}|${target.table_name}`,
				)
				.sort(),
		).toEqual([
			'sql:zzd1:zzd_probe_db|zzd_probe_table',
			'sql:zzd4:zzd_probe_db_two|zzd_probe_table_two',
		]);
	});

	test('the file section resolves only file-type targets (no sql)', async () => {
		const targets = await getSectionDiffusionTargets(FILE_SECTION);
		expect(targets.map((target) => `${target.type}:${target.element_tipo}`).sort()).toEqual([
			'rdf:zzd7',
			'xml:zzd8',
		]);
		expect(targets.filter((target) => target.type === 'sql')).toEqual([]);
	});
});

describe('deleteDiffusionRecord — sql outcomes', () => {
	test('the executor receives the engine-wire shape; full confirmation → deleted', async () => {
		const seen: unknown[][] = [];
		registerNativeDiffusionSqlDelete(async (targets) => {
			seen.push(targets);
			return { deleted: targets.map((t) => `${t.database_name}|${t.table_name}`), errors: [] };
		});

		const outcome = await deleteDiffusionRecord(SQL_SECTION, 932001, false);

		expect(seen.length).toBe(1);
		expect(seen[0]).toEqual([
			{
				database_name: 'zzd_probe_db',
				table_name: 'zzd_probe_table',
				section_ids: [932001],
				section_tipo: SQL_SECTION,
			},
			{
				database_name: 'zzd_probe_db_two',
				table_name: 'zzd_probe_table_two',
				section_ids: [932001],
				section_tipo: SQL_SECTION,
			},
		]);
		expect(outcome.deleted.sort()).toEqual([SQL_KEY_ONE, SQL_KEY_TWO].sort());
		expect(outcome.pending).toEqual([]);
		// logActivity=false (the retry caller's posture) writes NO ledger row
		expect(await activityRowsFor(SQL_SECTION, 932001)).toEqual([]);
	});

	test('partial confirmation splits deleted/pending and ledgers one dd1758 row per element', async () => {
		registerNativeDiffusionSqlDelete(async () => ({ deleted: [SQL_KEY_TWO], errors: [] }));

		const outcome = await deleteDiffusionRecord(SQL_SECTION, 932002, true, 77);

		expect(outcome.deleted).toEqual([SQL_KEY_TWO]);
		expect(outcome.pending).toEqual([SQL_KEY_ONE]);
		// one row per ELEMENT: zzd1 unconfirmed → unpublish_pending (3),
		// zzd4 confirmed → unpublished (2). dd1766 is the ontology-node locator.
		expect(await activityRowsFor(SQL_SECTION, 932002)).toEqual([
			{ element: 'zzd0', elementId: '1', action: '3' },
			{ element: 'zzd0', elementId: '4', action: '2' },
		]);
	});

	test('an executor that throws resolves to all-pending and still ledgers (never rejects)', async () => {
		registerNativeDiffusionSqlDelete(async () => {
			throw new Error('zzd executor outage');
		});

		const outcome = await deleteDiffusionRecord(SQL_SECTION, 932003, true, 77);

		expect(outcome.deleted).toEqual([]);
		// the throw aborts the per-target split BEFORE any pending push
		expect(outcome.pending).toEqual([]);
		expect(await activityRowsFor(SQL_SECTION, 932003)).toEqual([
			{ element: 'zzd0', elementId: '1', action: '3' },
			{ element: 'zzd0', elementId: '4', action: '3' },
		]);
	});

	test('DEC-19: no registered executor → pending keys, ZERO ledger rows, loud console.error', async () => {
		resetNativeDiffusionSqlDeleteForTests();
		const errors: string[] = [];
		const realError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(' '));
		};
		let outcome: Awaited<ReturnType<typeof deleteDiffusionRecord>>;
		try {
			outcome = await deleteDiffusionRecord(SQL_SECTION, 932004, true, 77);
		} finally {
			console.error = realError;
		}

		expect(outcome.deleted).toEqual([]);
		expect(outcome.pending.sort()).toEqual([SQL_KEY_ONE, SQL_KEY_TWO].sort());
		// the DEC-19 branch returns BEFORE logUnpublishOutcome — the deliberate
		// fresh-install no-op posture (no ledger rows to retry).
		expect(await activityRowsFor(SQL_SECTION, 932004)).toEqual([]);
		expect(errors.filter((line) => line.includes('DEC-19')).length).toBe(1);
		expect(errors[0]).toContain('2 sql publication target(s)');
	});

	test('a section with no diffusion targets is a silent no-op (no executor call, no ledger)', async () => {
		// baseline: test38 participates in no diffusion output in this database
		expect(await getSectionDiffusionTargets('test38')).toEqual([]);
		let calls = 0;
		registerNativeDiffusionSqlDelete(async () => {
			calls++;
			return { deleted: [], errors: [] };
		});

		const outcome = await deleteDiffusionRecord('test38', 932005, true, 77);

		expect(outcome).toEqual({ deleted: [], pending: [], terminal: [] });
		expect(calls).toBe(0);
		expect(await activityRowsFor('test38', 932005)).toEqual([]);
	});
});

describe('deleteDiffusionRecord — file-type elements', () => {
	test('D10 (fixed 2026-08-09): a file-only section DOES reach the dd1758 ledger', async () => {
		let calls = 0;
		registerNativeDiffusionSqlDelete(async () => {
			calls++;
			return { deleted: [], errors: [] };
		});

		const outcome = await deleteDiffusionRecord(FILE_SECTION, 932010, true, 77);

		// zzd8 declares a service_name and nothing is published → idempotent
		// success; zzd7 declares none → it never published → TERMINAL (PUB-02:
		// ledgered with its reason, never re-queued), not a retryable pending.
		expect(outcome.deleted).toEqual(['xml:zzd8']);
		expect(outcome.pending).toEqual([]);
		expect(outcome.terminal.map((entry) => entry.key)).toEqual(['rdf:zzd7']);
		expect(calls).toBe(0); // no sql target → the executor is never consulted

		// D10, FIXED 2026-08-09: the old `if (sqlTargets.length === 0) return
		// outcome;` returned before logUnpublishOutcome, so a file-only section's
		// FAILED unlink produced a pending outcome with NO dd1758 row —
		// retryPendingDiffusion could never see it and the published file stayed
		// live forever (an access-control failure, not just a retry bug). The
		// ledger is now reached on every path that produced an outcome, and this
		// pins the CORRECT behaviour: one row per element, action 3 for the
		// unresolvable rdf element, action 2 for the idempotent xml one.
		expect(await activityRowsFor(FILE_SECTION, 932010)).toEqual([
			{ element: 'zzd0', elementId: '7', action: '3' },
			{ element: 'zzd0', elementId: '8', action: '2' },
		]);
	});
});

describe('resolvePublishedFilePath', () => {
	test('xml and markdown: folder is the type, extension is per-type', async () => {
		expect(await resolvePublishedFilePath('zzd8', 'xml', FILE_SECTION, 7, FILE_ROOT)).toBe(
			`${FILE_ROOT}/xml/testsvc/zzd9_7.xml`,
		);
		// folder 'markdown', extension 'md' — the pair a refactor would unify
		expect(await resolvePublishedFilePath('zzd8', 'markdown', FILE_SECTION, 7, FILE_ROOT)).toBe(
			`${FILE_ROOT}/markdown/testsvc/zzd9_7.md`,
		);
	});

	test('rdf: the owl:Class child whose relations name the section provides the file name', async () => {
		expect(await resolvePublishedFilePath('zzd8', 'rdf', FILE_SECTION, 7, FILE_ROOT)).toBe(
			`${FILE_ROOT}/rdf/testsvc/nmotestclass-zzd9-7.rdf`,
		);
		// no owl:Class relates test3 → unresolvable
		expect(await resolvePublishedFilePath('zzd8', 'rdf', 'test3', 7, FILE_ROOT)).toBe(null);
	});

	test('an unknown type is TERMINAL — it no longer falls through to the rdf grammar (PUB-02)', async () => {
		// Before 2026-09-03 every non-xml/markdown type took the rdf branch, so a
		// csv/json/typeless element resolved an rdf path that never existed and
		// sat in the retry queue forever.
		const resolved = await resolvePublishedFile('zzd8', 'unknown', FILE_SECTION, 7, FILE_ROOT);
		expect(resolved.kind).toBe('terminal');
		expect(await resolvePublishedFilePath('zzd8', 'unknown', FILE_SECTION, 7, FILE_ROOT)).toBe(
			null,
		);
	});

	test('no explicit root → the PRODUCER root publish uses (PUB-03); a missing service_name is terminal', async () => {
		// '' is "no root given": the delete side then resolves the same root the
		// writers do (diffusionFilesRoot), never MEDIA_PATH on its own.
		expect(await resolvePublishedFilePath('zzd8', 'xml', FILE_SECTION, 7, '')).toBe(
			`${diffusionFilesRoot()}/xml/testsvc/zzd9_7.xml`,
		);
		// zzd7 declares diffusion.type but no service_name (the live rdf config)
		const noService = await resolvePublishedFile('zzd7', 'rdf', FILE_SECTION, 7, FILE_ROOT);
		expect(noService.kind).toBe('terminal');
		// an element outside the ontology has no properties row at all
		const absent = await resolvePublishedFile('zzd_absent1', 'xml', FILE_SECTION, 7, FILE_ROOT);
		expect(absent.kind).toBe('terminal');
	});

	test('the legacy {base}_*.rdf sweep fires for rdf only, never for another type', async () => {
		const dir = `${FILE_ROOT}/rdf/testsvc`;
		mkdirSync(dir, { recursive: true });
		const canonical = `${dir}/nmotestclass-zzd9-7.rdf`;
		const legacy = `${dir}/nmotestclass-zzd9-7_2024.rdf`;
		const other = `${dir}/nmotestclass-zzd9-8.rdf`;
		for (const path of [canonical, legacy, other]) writeFileSync(path, 'x');

		// the xml grammar unlinks ONLY its own file — no sibling sweep
		const xmlDir = `${FILE_ROOT}/xml/testsvc`;
		mkdirSync(xmlDir, { recursive: true });
		writeFileSync(`${xmlDir}/zzd9_7.xml`, 'x');
		writeFileSync(`${xmlDir}/zzd9_7_2024.xml`, 'x');
		expect(await unlinkPublishedFiles('zzd8', 'xml', FILE_SECTION, 7, FILE_ROOT)).toEqual({
			kind: 'unpublished',
		});
		expect(existsSync(`${xmlDir}/zzd9_7.xml`)).toBe(false);
		expect(existsSync(`${xmlDir}/zzd9_7_2024.xml`)).toBe(true);

		// type 'rdf' sweeps the legacy variants of the SAME base
		expect(await unlinkPublishedFiles('zzd8', 'rdf', FILE_SECTION, 7, FILE_ROOT)).toEqual({
			kind: 'unpublished',
		});
		expect(existsSync(canonical)).toBe(false);
		expect(existsSync(legacy)).toBe(false);
		expect(existsSync(other)).toBe(true); // another record is untouched
		// nothing left to remove → still unpublished (idempotent)
		expect(await unlinkPublishedFiles('zzd8', 'rdf', FILE_SECTION, 7, FILE_ROOT)).toEqual({
			kind: 'unpublished',
		});
		// never publishable → terminal (ledgered with its reason, never retried)
		const terminal = await unlinkPublishedFiles('zzd7', 'rdf', FILE_SECTION, 7, FILE_ROOT);
		expect(terminal.kind).toBe('terminal');
	});
});
