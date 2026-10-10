/**
 * CORE HIERARCHY ACTIVATION — `lg` is ACTIVATED against the terms the seed ships
 * in matrix_langs, never imported (installer unification A7, 2026-10-08).
 *
 * THE DEFECT RETIRED. The wizard pre-ticked `lg` and imported the vendored
 * `lg1.copy.gz` FORCED into matrix_hierarchy — but `lg1` is a core section whose
 * table is matrix_langs, where the seed already holds all 21,705 terms. The
 * import wrote unread duplicates; the CLI and install.sh did not even do that,
 * so their installs had Languages inactive. Measured 2026-10-08: the seed's lg
 * registry record arrives with hierarchy4 = No, hierarchy125 = No and no
 * hierarchy59, and ONE activation — with zero lg rows in matrix_hierarchy —
 * makes the hierarchy usable.
 *
 * WHAT THIS PINS, on the suite database's own lg registry record (found by
 * tld, never by id), forced back to that SEED SHAPE inside ONE transaction that
 * a thrown sentinel rolls back:
 *   - activateCoreHierarchies converges it: usable, the General Term root
 *     (hierarchy45) resolves to a record that EXISTS in matrix_langs;
 *   - nothing is imported: the matrix_hierarchy lg row count is unchanged;
 *   - installHierarchies(['lg']) is activation-only and says so; a reset
 *     (replace) is refused;
 *   - a second activation applies nothing (idempotent);
 *   - a failed activation is a REFUSAL — `install.step_failed` (public), the
 *     sentence naming the tld and its finding — never an `{ok:false}` outcome
 *     (engineering/ERRORS_SPEC.md §4);
 *   - after the rollback the record is byte-identical to its pre-test state.
 *
 * Suite database only: assertTestDatabase before the first write.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { toErrorBody } from '../../src/core/errors/convert.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import {
	activateCoreHierarchies,
	activateCoreHierarchy,
} from '../../src/core/install/hierarchy_activate.ts';
import { installHierarchies } from '../../src/core/install/hierarchy_import.ts';
import { CORE_HIERARCHIES } from '../../src/core/install/hierarchy_meta.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { HIERARCHY_SECTION, inspectHierarchy } from '../../src/core/ontology/hierarchy_state.ts';
import {
	HIERARCHY_ACTIVE,
	HIERARCHY_GENERAL_TERM,
	HIERARCHY_GENERAL_TERM_MODEL,
	HIERARCHY_SOURCE_REAL_SECTION,
	HIERARCHY_TLD,
} from '../../src/core/ontology/ontology_tipos.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const REGISTRY_TABLE = 'matrix_hierarchy_main';
/** hierarchy125 — the active-in-thesaurus flag. */
const ACTIVE_IN_THESAURUS = 'hierarchy125';
const LG = CORE_HIERARCHIES.find((meta) => meta.tld === 'lg');

/** Thrown to roll the whole test transaction back. */
class RollbackSentinel extends Error {}

interface Locator {
	section_tipo: string;
	section_id: number | string;
	[key: string]: unknown;
}

async function lgRegistryId(): Promise<number | null> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${REGISTRY_TABLE}"
		  WHERE section_tipo = $1 AND lower(string->'${HIERARCHY_TLD}'->0->>'value') = 'lg'
		  ORDER BY section_id LIMIT 1`,
		[HIERARCHY_SECTION],
	)) as { section_id: number }[];
	return rows[0] ? Number(rows[0].section_id) : null;
}

/** The whole registry row as text — the byte-identity witness for the rollback. */
async function registryBytes(sectionId: number): Promise<string> {
	const rows = (await sql.unsafe(
		`SELECT to_jsonb(t)::text AS bytes FROM "${REGISTRY_TABLE}" t
		  WHERE section_tipo = $1 AND section_id = $2`,
		[HIERARCHY_SECTION, sectionId],
	)) as { bytes: string }[];
	return rows[0]?.bytes ?? '';
}

async function relationOf(sectionId: number, tipo: string): Promise<Locator[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->'${tipo}' AS value FROM "${REGISTRY_TABLE}"
		  WHERE section_tipo = $1 AND section_id = $2`,
		[HIERARCHY_SECTION, sectionId],
	)) as { value: Locator[] | null }[];
	return rows[0]?.value ?? [];
}

/** lg term rows in matrix_hierarchy — the table the old import wrongly wrote. */
async function lgRowsInMatrixHierarchy(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_hierarchy WHERE section_tipo ~ '^lg[0-9]+$'`,
		[],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

/**
 * Force the SEED SHAPE (measured 2026-10-08): hierarchy4 + hierarchy125 point at
 * dd64/2 (No), hierarchy59 absent. Raw UPDATE on purpose: this is the seed's
 * shape, not an engine write, and the transaction rolls it back.
 */
async function forceSeedShape(sectionId: number): Promise<void> {
	const no = (from: string) => [
		{ id: 1, type: 'dd151', section_id: 2, section_tipo: 'dd64', from_component_tipo: from },
	];
	await sql.unsafe(
		`UPDATE "${REGISTRY_TABLE}"
		    SET relation = (coalesce(relation, '{}'::jsonb) - '${HIERARCHY_GENERAL_TERM_MODEL}')
		                   || jsonb_build_object('${HIERARCHY_ACTIVE}', $3::text::jsonb,
		                                         '${ACTIVE_IN_THESAURUS}', $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[
			HIERARCHY_SECTION,
			sectionId,
			JSON.stringify(no(HIERARCHY_ACTIVE)),
			JSON.stringify(no(ACTIVE_IN_THESAURUS)),
		],
	);
}

/** Does the locator's record exist in matrix_langs (the table the engine reads lg from)? */
async function existsInMatrixLangs(locator: Locator): Promise<boolean> {
	const rows = (await sql.unsafe(
		'SELECT 1 FROM matrix_langs WHERE section_tipo = $1 AND section_id = $2 LIMIT 1',
		[locator.section_tipo, Number(locator.section_id)],
	)) as unknown[];
	return rows.length > 0;
}

afterAll(async () => {
	// The rolled-back writes may have warmed derived caches with post-activation
	// state; nothing of it survived in the database.
	await clearOntologyDerivedCaches();
});

describe.if(DB_READY)(
	'core hierarchy (lg) — activated against matrix_langs, never imported',
	() => {
		test('seed-shape lg registry → activation converges, nothing imported, reset refused, idempotent, rolled back byte-identical', async () => {
			await assertTestDatabase('install_core_hierarchy_native');
			expect(LG, 'lg must be a CORE hierarchy (hierarchy_meta.ts CORE_HIERARCHIES)').toBeDefined();
			const sectionId = await lgRegistryId();
			expect(
				sectionId,
				'the suite DB carries the seed lg registry record (hierarchy1, tld lg)',
			).not.toBeNull();
			const id = sectionId as number;
			const before = await registryBytes(id);
			expect(before.length).toBeGreaterThan(0);

			let reachedEnd = false;
			await withTransaction(async () => {
				await forceSeedShape(id);
				const shaped = await relationOf(id, HIERARCHY_ACTIVE);
				expect(Number(shaped[0]?.section_id)).toBe(2);
				expect(await relationOf(id, HIERARCHY_GENERAL_TERM_MODEL)).toEqual([]);
				const lgRowsBefore = await lgRowsInMatrixHierarchy();
				expect(lgRowsBefore).toBeGreaterThanOrEqual(0);

				// The door the seed restore runs.
				// Success is the return value; a failure THROWS (see the refusal test).
				const core = await activateCoreHierarchies(-1);
				expect(core).toEqual({ activated: ['lg'], msg: 'Core hierarchies active: lg' });

				const state = await inspectHierarchy(id);
				expect(
					state.checks.filter((check) => !check.ok),
					'every hierarchy check passes after activation',
				).toEqual([]);
				expect(state.usable).toBe(true);
				expect(Number((await relationOf(id, HIERARCHY_ACTIVE))[0]?.section_id)).toBe(1);
				const root = (await relationOf(id, HIERARCHY_GENERAL_TERM))[0];
				expect(root, 'hierarchy45 names the General Term root').toBeDefined();
				expect(await existsInMatrixLangs(root as Locator)).toBe(true);
				// NO IMPORT: not one lg row was written into matrix_hierarchy.
				expect(await lgRowsInMatrixHierarchy()).toBe(lgRowsBefore);

				// The wizard / CLI step asked for lg by name: activation only.
				const step = await installHierarchies(['lg'], undefined, -1);
				expect(step.ok).toBe(true);
				expect(step.errors).toEqual([]);
				expect(step.responses).toHaveLength(1);
				expect(step.responses[0]?.msg).toContain('never imported');
				expect(await lgRowsInMatrixHierarchy()).toBe(lgRowsBefore);

				// A reset would re-copy terms that ship in the seed: refused.
				const reset = await installHierarchies(['lg'], undefined, -1, { replace: true });
				expect(reset.ok).toBe(false);
				expect(reset.responses[0]?.msg).toContain('cannot be reset');
				// The batch errors[] tags each finding with its tld in ONE place.
				expect(reset.errors).toEqual([
					'lg: core hierarchy — cannot be reset (its terms ship in the seed)',
				]);
				expect(await lgRowsInMatrixHierarchy()).toBe(lgRowsBefore);

				// Idempotent: a converged hierarchy needs nothing applied.
				const again = await activateCoreHierarchy(LG as (typeof CORE_HIERARCHIES)[number], -1);
				expect(again.ok).toBe(true);
				expect(again.applied).toEqual([]);

				reachedEnd = true;
				throw new RollbackSentinel('roll back the core-hierarchy probe');
			}).catch((error: unknown) => {
				if (!(error instanceof RollbackSentinel)) throw error;
			});

			expect(reachedEnd, 'the transaction body ran to its end').toBe(true);
			expect(await registryBytes(id)).toBe(before);
		});

		test('a failed core activation REFUSES install.step_failed (public sentence naming the tld), rolled back byte-identical', async () => {
			await assertTestDatabase('install_core_hierarchy_native');
			const id = (await lgRegistryId()) as number;
			expect(id).not.toBeNull();
			const before = await registryBytes(id);

			let refusal: unknown = null;
			await withTransaction(async () => {
				// An operator error ensureHierarchy refuses to paper over: the source
				// section (hierarchy109) names a COMPONENT, not a section. Raw UPDATE —
				// the transaction rolls it back.
				await sql.unsafe(
					`UPDATE "${REGISTRY_TABLE}"
					    SET string = coalesce(string, '{}'::jsonb)
					                 || jsonb_build_object('${HIERARCHY_SOURCE_REAL_SECTION}', $3::text::jsonb)
					  WHERE section_tipo = $1 AND section_id = $2`,
					[
						HIERARCHY_SECTION,
						id,
						JSON.stringify([{ id: 1, lang: 'lg-nolan', value: HIERARCHY_TLD }]),
					],
				);
				refusal = await activateCoreHierarchies(-1).then(
					() => null,
					(error: unknown) => error,
				);
				throw new RollbackSentinel('roll back the refusal probe');
			}).catch((error: unknown) => {
				if (!(error instanceof RollbackSentinel)) throw error;
			});

			expect(refusal, 'a failed activation throws').toBeInstanceOf(DedaloError);
			const body = toErrorBody(refusal as DedaloError);
			expect(body.code).toBe('install.step_failed');
			expect(body.message).toBe(
				`Core hierarchy activation failed: lg: the source section '${HIERARCHY_TLD}' (hierarchy109) is not a section — fix "Real section tipo" first`,
			);
			expect(await registryBytes(id)).toBe(before);
		});
	},
);
