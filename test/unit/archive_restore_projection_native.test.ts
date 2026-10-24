/**
 * THE ARCHIVE RESTORE NEVER PLANTS A ROW INTO ANOTHER WRITER'S PROJECTION — TS-native
 * write-path contract (ONT follow-up 2026-10-21, residual b of ONT-1/2/3, audit 2026-09-26).
 *
 * `dd_ontology(tld)` is the projection of `matrix_ontology(<tld>0)` wherever that tld has source
 * records (ontology_state.ts); every door that derives a tld's nodes takes the tld's projection
 * lock (dd_ontology.ts lockOntologyProjection). The archive restore wrote its ontology subtree
 * with `upsertDdOntologyNode`:
 *   (1) WITHOUT that lock — unordered against a concurrent rebuild / teardown / per-record
 *       projection of the same tld;
 *   (2) INTO a tld this installation derives from source records — rows with no source record
 *       there: `orphaned` drift the tld's next rebuild (an ontology update, the parser tool, the
 *       reconcile) deletes, taking the restored records' definitions — their matrix table, their
 *       components — with it.
 *
 * Pinned (outcomes):
 *   P1 a SOURCED destination tld: the restore is refused (`archive.refused`, naming the tld and
 *      the nodes), nothing written — no node, no record; the source's own projection untouched;
 *   P2 control: the same archive into a destination where the tld has NO source records restores
 *      (nodes + records) — the archive's purpose, unchanged;
 *   P3 the restore's ontology write waits on the tld's projection lock held by another
 *      transaction (pre-fix it ran straight through), then completes.
 *   P4 a node ANOTHER writer creates between the restore's plan and its write (inside the
 *      lock the restore then waits on) is re-judged under the lock: a DIFFERENT definition is
 *      refused as a conflict — never overwritten without consent (review-diff 2026-10-21);
 *   P5 control: an EQUAL definition created in that window is left as it is, and the outcome
 *      counts it unchanged, not inserted.
 *
 * Scratch: tld `zzarp` (section `zzarp1` + its component `zzarp2`, records in matrix_test; the
 * source record `zzarp0/50` for P1). Swept before and after, zero residue asserted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { extractArchive } from '../../src/core/archive/extract.ts';
import { restoreArchive } from '../../src/core/archive/restore.ts';
import {
	lockOntologyProjection,
	readDdOntologyRow,
	upsertDdOntologyNode,
} from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { inspectOntology, rebuildOntology } from '../../src/core/ontology/ontology_state.ts';
import {
	ensureSituation,
	modelTipoFor,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { interleave } from '../helpers/lock_interleave.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const TLD = 'zzarp';
const SECTION = `${TLD}1`;
const COMPONENT = `${TLD}2`;
const SOURCE_SECTION = `${TLD}0`;
const SOURCE_ID = 50;
const SOURCE_NODE = `${TLD}${SOURCE_ID}`;
const SCRATCH = scratchDir('archive_projection');
const ARCHIVE = join(SCRATCH, 'archive');
let mediaRoot = '';

const s = situation({
	tld: TLD,
	name: 'archive restore projection',
	nodes: [
		{ tipo: SECTION, model: 'section' },
		{ tipo: COMPONENT, parent: SECTION, model: 'component_input_text' },
	],
	records: [
		{
			section_tipo: SECTION,
			section_id: 1,
			columns: { string: { [COMPONENT]: [{ id: 1, lang: 'lg-nolan', value: 'archived' }] } },
		},
	],
});

/** Everything the scratch tld can leave: nodes, records, the source record, TM, counters. */
async function sweep(): Promise<void> {
	await assertTestDatabase('archive_restore_projection_native');
	await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [TLD]);
	await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1', [SOURCE_SECTION]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo IN ($1, $2)', [
		SECTION,
		SOURCE_SECTION,
	]);
	await sql.unsafe('DELETE FROM matrix_counter WHERE tipo IN ($1, $2)', [SECTION, SOURCE_SECTION]);
	await clearOntologyDerivedCaches();
}

async function residue(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*) FROM dd_ontology WHERE tld = $1)
		      + (SELECT count(*) FROM matrix_test WHERE section_tipo = $2)
		      + (SELECT count(*) FROM matrix_ontology WHERE section_tipo = $3)
		      + (SELECT count(*) FROM matrix_time_machine WHERE section_tipo IN ($2, $3))
		      + (SELECT count(*) FROM matrix_counter WHERE tipo IN ($2, $3)) AS n`,
		[TLD, SECTION, SOURCE_SECTION],
	)) as { n: number | string }[];
	return Number(rows[0]?.n ?? -1);
}

async function recordCount(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_test WHERE section_tipo = $1',
		[SECTION],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

/**
 * Make the tld SOURCED here: its `<tld>0` root and one source record (`zzarp0/50`, a node the
 * archive does not carry), projected by the one writer — this installation derives `zzarp`.
 */
async function sourcedTld(): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, tld, model, model_tipo, is_main, relations, term)
		 VALUES ($1, $2, 'section', 'dd6', true, $3::text::jsonb, $4::text::jsonb)`,
		[
			SOURCE_SECTION,
			TLD,
			JSON.stringify([{ tipo: 'ontology1' }, { tipo: 'dd1201' }]),
			JSON.stringify({ 'lg-spa': TLD }),
		],
	);
	await sql.unsafe(
		`INSERT INTO matrix_ontology (section_id, section_tipo, data, relation, string)
		 VALUES ($1, $2, $3::text::jsonb, '{}'::jsonb, $4::text::jsonb)`,
		[
			SOURCE_ID,
			SOURCE_SECTION,
			JSON.stringify({ section_id: SOURCE_ID, section_tipo: SOURCE_SECTION }),
			JSON.stringify({
				ontology7: [{ id: 1, lang: 'lg-nolan', value: TLD }],
				ontology5: [{ id: 1, lang: 'lg-spa', value: 'source node' }],
			}),
		],
	);
	await clearOntologyDerivedCaches();
	const rebuilt = await rebuildOntology(TLD, -1, { mainNode: 'existing' });
	expect(rebuilt.errors).toEqual([]);
	expect((await inspectOntology(TLD)).inSync).toBe(true);
}

async function refusalOf(work: () => Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		await work();
	} catch (error) {
		if (!isDedaloError(error)) throw error;
		const coordinates = (error.coordinates ?? {}) as Record<string, unknown>;
		return { code: error.code, tld: coordinates.tld, message: error.message };
	}
	return { restored: true };
}

beforeAll(async () => {
	rmSync(SCRATCH, { recursive: true, force: true });
	mediaRoot = resetMediaRoot(join(SCRATCH, 'media_root'));
	await sweep();
	await ensureSituation(s);
	await extractArchive({ sectionTipos: [SECTION], outDir: ARCHIVE, mediaRoot });
});

beforeEach(sweep);

afterAll(async () => {
	await sweep();
	expect(await residue()).toBe(0);
	rmSync(SCRATCH, { recursive: true, force: true });
});

describe('the archive restore and the projection invariant', () => {
	test('P1 a SOURCED destination tld refuses the restore; nothing written, the projection untouched', async () => {
		await sourcedTld();
		const refused = await refusalOf(() =>
			restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot }),
		);
		expect(refused.code).toBe('archive.refused');
		expect(refused.tld).toBe(TLD);
		expect(String(refused.message)).toContain(`'${SECTION}'`);
		expect(String(refused.message)).toContain(`'${COMPONENT}'`);
		// Nothing of the archive landed: no node, no record.
		expect(await readDdOntologyRow(SECTION)).toBeNull();
		expect(await readDdOntologyRow(COMPONENT)).toBeNull();
		expect(await recordCount()).toBe(0);
		// The tld's own projection is exactly what its source derives.
		expect(await readDdOntologyRow(SOURCE_NODE)).not.toBeNull();
		const state = await inspectOntology(TLD);
		// Floor: the inspect really parsed the source record (an empty parse would agree with anything).
		expect(state.matrixNodes).toBeGreaterThan(0);
		expect(state.drift).toEqual([]);
		expect(state.inSync).toBe(true);
	});

	test('P2 control: with no source records of the tld here, the archive restores nodes and records', async () => {
		const outcome = await restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot });
		expect(outcome.ontology.inserted).toBe(2);
		expect(outcome.records).toEqual({ inserted: 1, overwritten: 0 });
		expect(await readDdOntologyRow(SECTION)).not.toBeNull();
		expect(await readDdOntologyRow(COMPONENT)).not.toBeNull();
		expect(await recordCount()).toBe(1);
	});

	/** The situation's COMPONENT node as the archive carries it (model_tipo resolved), `term` overridable. */
	async function componentNode(term?: Record<string, string>) {
		const node = s.nodes.find((n) => n.tipo === COMPONENT);
		if (node === undefined) throw new Error('no component node in the situation');
		const modelTipo = node.model_tipo ?? (await modelTipoFor(node.model ?? ''));
		return { ...node, model_tipo: modelTipo, ...(term === undefined ? {} : { term }) };
	}

	test('P4 a node created between plan and write with a DIFFERENT definition is refused, not overwritten', async () => {
		const theirs = await componentNode({ 'lg-eng': 'another writer’s definition' });
		const { blocked, result } = await interleave(
			async () => {
				await lockOntologyProjection([TLD]);
				await upsertDdOntologyNode(theirs);
			},
			() => refusalOf(() => restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot })),
		);
		expect(blocked).toBe(true); // planned before the node existed, then waited on the lock
		expect(result.code).toBe('archive.refused');
		expect(String(result.message)).toContain(`'${COMPONENT}'`);
		// The other writer's definition survives; nothing of the archive landed.
		expect((await readDdOntologyRow(COMPONENT))?.term).toEqual(theirs.term);
		expect(await readDdOntologyRow(SECTION)).toBeNull();
		expect(await recordCount()).toBe(0);
	}, 30_000);

	test('P5 control: an EQUAL node created in that window is left alone and counted unchanged', async () => {
		const { blocked, result } = await interleave(
			async () => {
				await lockOntologyProjection([TLD]);
				await upsertDdOntologyNode(await componentNode());
			},
			() => restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot }),
		);
		expect(blocked).toBe(true);
		expect(result.ontology).toEqual({ inserted: 1, unchanged: 1, overwritten: 0 });
		expect(await recordCount()).toBe(1);
	}, 30_000);

	test('P3 the ontology write waits on the tld projection lock, then completes', async () => {
		const { blocked, result } = await interleave(
			() => lockOntologyProjection([TLD]),
			() => restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot }),
		);
		expect(blocked).toBe(true);
		expect(result.ontology.inserted).toBe(2);
		expect(await recordCount()).toBe(1);
	}, 30_000);
});
