/**
 * RETIRED ENGINE NODES ARE PRUNED (src/core/ontology/engine_ontology.ts,
 * 2026-10-10, WC-2026-10-10-ontology-dependencies-hierarchy60) — measured by
 * planting what an install carried before the retirement and running the door.
 *
 * The first retiree is `ddengine11` "Required ontologies" (the 2026-10-09
 * dependency portal, superseded by the master's component_json hierarchy60).
 * An install that booted the 2026-10-09 code holds it in THREE places: its
 * `ddengine0/11` source record (matrix_ontology), its dd_ontology row, and the
 * values its editors stored on ontology registry rows (`relation.ddengine11`).
 * Merely deleting the node from engine_ontology.json would prune none of them:
 * the drift check reads only the declared nodes, and a rebuild re-derives the
 * row from the surviving source record. The gate proves, by outcome:
 *
 *  1. the SHIPPED file retires ddengine11 and no longer declares it;
 *  2. with all three planted, ensureEngineOntology is NOT a no-op: it reports
 *     them as drift, prunes all three (the registry key from every column that
 *     carried it), leaves the declared nodes drift-free, and says what it pruned;
 *  3. the next run is a no-op (nothing written, nothing pruned);
 *  4. a definitions file that retires a non-engine tipo, the main node, or a
 *     tipo it still declares is REFUSED before any write.
 *
 * SCRATCH: the registry row of `zzeret` (minted by createMainSection, with its
 * NEW activity row), the planted `ddengine0/11` record and the TM snapshot its
 * delete writes — swept, residue asserted zero. Suite database only (asserted first).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type DdOntologyNode, readDdOntologyRow } from '../../src/core/db/dd_ontology.ts';
import { insertMatrixRecordWithExplicitId } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	ENGINE_TLD,
	type EngineOntologyDoc,
	engineOntologyDrift,
	ensureEngineOntology,
	loadEngineOntologyDoc,
} from '../../src/core/ontology/engine_ontology.ts';
import { ontologyRecordFromNode } from '../../src/core/ontology/ontology_record_inverse.ts';
import { rebuildOntology } from '../../src/core/ontology/ontology_state.ts';
import { createMainSection } from '../../src/core/ontology/ontology_write.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const DOOR = 'engine_ontology_retired_native';
const SCRATCH_TLD = 'zzeret';
const RETIRED = 'ddengine11';
const RETIRED_ID = 11;

/** The node as the 2026-10-09 release shipped it (engine_ontology.json at that commit). */
const RETIRED_NODE = {
	tipo: RETIRED,
	parent: 'hierarchy60',
	term: {
		'lg-eng': 'Required ontologies',
		'lg-spa': 'Ontologías requeridas',
		'lg-cat': 'Ontologies requerides',
	},
	model: 'component_portal',
	order_number: 5,
	relations: [{ tipo: 'ontology35' }, { tipo: 'hierarchy6' }, { tipo: 'hierarchy5' }],
	tld: ENGINE_TLD,
	properties: null,
	model_tipo: 'dd592',
	is_model: false,
	is_translatable: false,
	is_main: false,
	propiedades: null,
} as unknown as DdOntologyNode;

/** A stored value of the retired portal, as its editors wrote it (a link to an ontology35 row). */
function retiredValue(targetId: number): Record<string, unknown>[] {
	return [
		{
			id: 1,
			type: 'dd151',
			section_id: targetId,
			section_tipo: 'ontology35',
			from_component_tipo: RETIRED,
		},
	];
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return 'admitted';
	} catch (error) {
		return error instanceof DedaloError ? error.code : `untyped: ${String(error)}`;
	}
}

/** Where the retired node survives, measured in the three places it lived. */
async function survival(): Promise<{ node: boolean; records: number; registryRows: number }> {
	const counts = (await sql.unsafe(
		`SELECT
			(SELECT count(*)::int FROM matrix_ontology WHERE section_tipo = 'ddengine0' AND section_id = $1) AS records,
			(SELECT count(*)::int FROM matrix_ontology_main
			  WHERE relation ? $2 OR string ? $2 OR misc ? $2) AS registry_rows`,
		[RETIRED_ID, RETIRED],
	)) as { records: number; registry_rows: number }[];
	return {
		node: (await readDdOntologyRow(RETIRED)) !== null,
		records: Number(counts[0]?.records ?? 0),
		registryRows: Number(counts[0]?.registry_rows ?? 0),
	};
}

let scratchRowId = 0;
let tmBaseline = 0;

/** The highest TM id of the retired record before the run: newer rows are this gate's. */
async function retiredTmMaxId(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT COALESCE(max(id), 0)::bigint AS id FROM matrix_time_machine
		  WHERE section_tipo = 'ddengine0' AND section_id = $1`,
		[RETIRED_ID],
	)) as { id: number | string }[];
	return Number(rows[0]?.id ?? 0);
}

async function sweep(): Promise<number> {
	let removed = 0;
	const del = async (query: string, params: unknown[]): Promise<void> => {
		const result = (await sql.unsafe(query, params as never[])) as unknown as { count?: number };
		removed += Number(result.count ?? 0);
	};
	await del(
		`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string->'hierarchy6' @> $1::text::jsonb`,
		[JSON.stringify([{ value: SCRATCH_TLD }])],
	);
	if (scratchRowId > 0) {
		await del(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'ontology35' AND section_id = $1`,
			[scratchRowId],
		);
		// createMainSection logs a NEW activity row; activity addresses its record
		// in misc->'dd551' (never data->>'section_tipo').
		await del(
			`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
			    AND misc->'dd551'->0->'value'->>'section_tipo' = 'ontology35'
			    AND misc->'dd551'->0->'value'->>'section_id' = $1`,
			[String(scratchRowId)],
		);
	}
	await del('DELETE FROM dd_ontology WHERE tld = $1', [SCRATCH_TLD]);
	await del(
		`DELETE FROM matrix_time_machine WHERE section_tipo = 'ddengine0' AND section_id = $1 AND id > $2`,
		[RETIRED_ID, tmBaseline],
	);
	return removed;
}

describe('engine ontology — the shipped file retires ddengine11 (hermetic)', () => {
	test('ddengine11 is retired with a date and a reason, and no longer declared', async () => {
		const doc = await loadEngineOntologyDoc();
		expect(doc.nodes.map((node) => node.tipo)).not.toContain(RETIRED);
		const retired = (doc.retired ?? []).find((entry) => entry.tipo === RETIRED);
		expect(retired?.retired).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(retired?.reason).toContain('hierarchy60');
	});
});

describe.if(DB_READY)('engine ontology — a retired node is pruned wherever it survives', () => {
	beforeAll(async () => {
		await assertTestDatabase(DOOR);
		await sweep();
		// Start from the current state (the preload's run already pruned the suite).
		await ensureEngineOntology();
		tmBaseline = await retiredTmMaxId();
	});

	afterAll(async () => {
		// Whatever a failing leg left: the door itself prunes the planted node.
		await ensureEngineOntology();
		await sweep();
		await clearOntologyDerivedCaches();
		expect(await survival()).toEqual({ node: false, records: 0, registryRows: 0 });
		const residue = (await sql.unsafe(
			`SELECT
				(SELECT count(*)::int FROM matrix_ontology_main
				  WHERE section_tipo = 'ontology35' AND string->'hierarchy6' @> $1::text::jsonb) AS rows,
				(SELECT count(*)::int FROM matrix_time_machine
				  WHERE section_tipo = 'ddengine0' AND section_id = $2 AND id > $3) AS tm,
				(SELECT count(*)::int FROM matrix_activity
				  WHERE section_tipo = 'dd542'
				    AND misc->'dd551'->0->'value'->>'section_tipo' = 'ontology35'
				    AND misc->'dd551'->0->'value'->>'section_id' = $4) AS activity`,
			[JSON.stringify([{ value: SCRATCH_TLD }]), RETIRED_ID, tmBaseline, String(scratchRowId)],
		)) as { rows: number; tm: number; activity: number }[];
		expect(scratchRowId).toBeGreaterThan(0); // the activity count measured a real id
		expect(residue[0]).toEqual({ rows: 0, tm: 0, activity: 0 });
	});

	test('planted in all three places → reported as drift, pruned from all three, the next run is a no-op', async () => {
		// --- plant what a 2026-10-09 install carried ---
		scratchRowId = await createMainSection({ tld: SCRATCH_TLD }, -1);
		await sql.unsafe(
			`UPDATE matrix_ontology_main
			    SET relation = COALESCE(relation, '{}'::jsonb) || $2::text::jsonb,
			        misc = COALESCE(misc, '{}'::jsonb) || $2::text::jsonb
			  WHERE section_tipo = 'ontology35' AND section_id = $1`,
			[scratchRowId, JSON.stringify({ [RETIRED]: retiredValue(scratchRowId) })],
		);
		await insertMatrixRecordWithExplicitId(
			'matrix_ontology',
			'ddengine0',
			RETIRED_ID,
			ontologyRecordFromNode(RETIRED_NODE),
		);
		// The rebuild derives the dd_ontology row from the surviving source record —
		// exactly the resurrection a bare removal from the JSON would suffer.
		const rebuilt = await rebuildOntology(ENGINE_TLD, -1);
		expect(rebuilt.errors.filter((line) => !line.includes(RETIRED))).toEqual([]);
		await clearOntologyDerivedCaches();
		expect(await survival()).toEqual({ node: true, records: 1, registryRows: 1 });

		// --- the door ---
		const run = await ensureEngineOntology();
		expect(run.changed).toBe(true);
		expect(run.drift).toEqual([
			`${RETIRED}: retired, dd_ontology row present`,
			`${RETIRED}: retired, source record ddengine0/${RETIRED_ID} present`,
			`${RETIRED}: retired, value on 1 registry row(s)`,
		]);
		expect(run.pruned).toEqual([
			`ddengine0/${RETIRED_ID} (${RETIRED}): source record deleted`,
			`ontology35/${scratchRowId}: relation.${RETIRED} removed`,
			`ontology35/${scratchRowId}: misc.${RETIRED} removed`,
			`${RETIRED}: dd_ontology row dropped by the rebuild`,
		]);
		await clearOntologyDerivedCaches();
		expect(await survival()).toEqual({ node: false, records: 0, registryRows: 0 });
		expect(await engineOntologyDrift()).toEqual([]);
		expect(run.strays).not.toContain(`ddengine0/${RETIRED_ID}`);

		// The registry row keeps everything else (only the retired key went).
		const kept = (await sql.unsafe(
			`SELECT relation ? 'hierarchy4' AS active, relation ? 'hierarchy54' AS filter
			   FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND section_id = $1`,
			[scratchRowId],
		)) as { active: boolean; filter: boolean }[];
		expect(kept[0]).toEqual({ active: true, filter: true });

		// The delete went through the record pipeline: its TM snapshot exists.
		expect(await retiredTmMaxId()).toBeGreaterThan(tmBaseline);

		// --- converged ---
		const again = await ensureEngineOntology();
		expect({ changed: again.changed, written: again.written, pruned: again.pruned }).toEqual({
			changed: false,
			written: 0,
			pruned: [],
		});
	});

	test('a definitions file that retires what it does not own, its main node, or a node it still ships is refused', async () => {
		const doc = await loadEngineOntologyDoc();
		const withRetired = (tipo: string): EngineOntologyDoc => ({
			...doc,
			retired: [{ tipo, retired: '2026-10-10', reason: DOOR }],
		});
		const live = doc.nodes.find((node) => node.tipo !== `${ENGINE_TLD}0`)?.tipo ?? '';
		expect(live).not.toBe('');
		expect(await refusalOf(ensureEngineOntology({ doc: withRetired('dd1') }))).toBe(
			'internal.invariant',
		);
		expect(await refusalOf(ensureEngineOntology({ doc: withRetired(`${ENGINE_TLD}0`) }))).toBe(
			'internal.invariant',
		);
		expect(await refusalOf(ensureEngineOntology({ doc: withRetired(live) }))).toBe(
			'internal.invariant',
		);
		// Refused before any write: the declared node is intact.
		expect(await readDdOntologyRow(live)).not.toBeNull();
		expect(await engineOntologyDrift()).toEqual([]);
	});
});
