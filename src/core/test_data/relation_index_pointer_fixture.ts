/**
 * THE CLIENT SUITE'S INDEX POINTER — the situation `component_relation_index`
 * needs to render anything at all.
 *
 * WHAT THE WIDGET IS. `component_relation_index` (suite twin `test25` in the
 * test3 playground, config-less, `source.mode external`) stores nothing: its
 * data is COMPUTED — every record holding a dd96 (index) locator that targets
 * the current record (src/core/resolve/relation_index.ts). Its COLUMNS come from
 * the POINTING section's related_list (the section's `relation_list` child:
 * test3 → test138 → [test52]), merged into the index's own request_config
 * (T0-8). With no pointer there are no rows and no pointing section, so neither
 * the columns nor a single cell is expressible: the client suite could only
 * assert that an empty widget renders.
 *
 * WHY IT DID NOT EXIST. The suite database holds ZERO dd96 references — the
 * install seed ships none and the canonical test3 playground (test3_canonical.json)
 * carries none. Adding one to the CANONICAL fixture would change what every
 * other gate reading test3/1 sees (its relation_list / References panel, its
 * inverse reads, the canonical drift check), so it stays out of the playground.
 *
 * THE ROW. One scratch test3 record at an EXPLICIT id this fixture owns, whose
 * `relation` column carries a dd96 locator from `test54` to test3/1 (the shape
 * the T0-8 probe verified the engine indexes), plus the canonical project
 * locator (test101 → dd153/1) so the record is as visible as the playground's,
 * and a test52 value (the related_list column) so its cell has something to render.
 * Written through the engine's explicit-id door (`insertMatrixRecordWithExplicitId`,
 * which raises the test3 counter to GREATEST — so no later create can be born at
 * this id) and swept by `deleteMatrixRecord`.
 *
 * ORDERING IN THE CLIENT RUNNER (scripts/client_test_runner.ts) — load-bearing:
 *   - installed AFTER the pre-run test3 reseed (`restoreCanonicalTest3` deletes
 *     EVERY test3 row, so a pointer installed before it would be wiped) and
 *     BEFORE `armRunCreatedSweep` (the run-created sweep deletes every test3 row
 *     ABOVE its mark; installed first, the mark is >= this id, so that sweep
 *     never takes the pointer from under the suite or from under this sweep);
 *   - swept BEFORE the post-run reseed (which would otherwise delete it first
 *     and make this sweep refuse with "deleted 0 rows").
 * Pinned by test/unit/client_situations_native.test.ts.
 *
 * WHY RUNNER-SCOPED, NOT SEEDED (the projects_fixture.ts reasoning): a pointer
 * is the relation_index suite's situation, not the playground's shape.
 *
 * (!) NOT a reserved id band. Test isolation is the dedicated suite DATABASE and
 * its marker; the floor below is a typo guard on the one id this module owns.
 */

import { dbTimestamp } from '../db/db_timestamp.ts';
import { deleteMatrixRecord, insertMatrixRecordWithExplicitId } from '../db/matrix_write.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { fireSaveEvent } from '../section_record/save_event.ts';
import { CANONICAL_SECTION_TIPO, CANONICAL_TABLE } from './manifest.ts';
import { assertTestDatabase } from './test_database_marker.ts';

/** The pointing record this fixture owns (test3, matrix_test). */
export const SUITE_INDEX_POINTER_ID = 952081;
/** The record the pointer targets — the one `test_component_relation_index.js` renders. */
export const SUITE_INDEX_TARGET = { section_tipo: 'test3', section_id: 1 } as const;
/** The config-less relation_index under test (client suite + server gate twin). */
export const SUITE_INDEX_TIPO = 'test25';
/** The component the dd96 locator is stored under (from_component_tipo). */
const POINTER_COMPONENT_TIPO = 'test54';
/** DEDALO_RELATION_TYPE_INDEX_TIPO. */
const INDEX_RELATION_TYPE = 'dd96';
/** The playground's projects component and the install seed's one project. */
const PROJECTS_COMPONENT_TIPO = 'test101';
/**
 * The pointing section's related_list column (test3 → relation_list test138 →
 * [test52]) and the value the pointer carries in it. It MUST be non-empty: the
 * index rows render with children_view `text`, and view_text_section_record
 * drops an empty instance node — an empty cell renders NOTHING, so a pointer
 * without this value cannot show a column cell at all.
 */
export const SUITE_INDEX_RELATED_LIST_TIPO = 'test52';
export const SUITE_INDEX_POINTER_LABEL = 'zz suite relation_index pointer';

/** Typo guard on the owned id (see header) — NOT a band. */
const SCRATCH_ID_FLOOR = 900000;

function assertScratchId(): void {
	if (!Number.isInteger(SUITE_INDEX_POINTER_ID) || SUITE_INDEX_POINTER_ID < SCRATCH_ID_FLOOR) {
		throw new DedaloError('internal.invariant', {
			message: `relation_index_pointer_fixture: id ${SUITE_INDEX_POINTER_ID} is below the scratch floor ${SCRATCH_ID_FLOOR} — refusing to touch a playground record`,
			coordinates: { table: CANONICAL_TABLE, section: CANONICAL_SECTION_TIPO },
		});
	}
}

/** The `relation` column of the pointer record. */
export function pointerRelationColumn(): Record<string, unknown[]> {
	return {
		[POINTER_COMPONENT_TIPO]: [
			{
				id: 1,
				type: INDEX_RELATION_TYPE,
				section_id: String(SUITE_INDEX_TARGET.section_id),
				section_tipo: SUITE_INDEX_TARGET.section_tipo,
				from_component_tipo: POINTER_COMPONENT_TIPO,
			},
		],
		[PROJECTS_COMPONENT_TIPO]: [
			{
				id: 1,
				type: 'dd675',
				section_id: '1',
				section_tipo: 'dd153',
				from_component_tipo: PROJECTS_COMPONENT_TIPO,
			},
		],
	};
}

/**
 * Install the pointer. Idempotent: a crashed previous run's row is swept first,
 * so a re-run never collides on the explicit id. Fires the test3 save event so
 * this process's data-derived caches drop; the run's server spawns AFTER this
 * call and reads the row cold.
 */
export async function ensureSuiteIndexPointerFixture(): Promise<void> {
	await assertTestDatabase('ensureSuiteIndexPointerFixture');
	assertScratchId();
	await removeRow();
	await insertMatrixRecordWithExplicitId(
		CANONICAL_TABLE,
		CANONICAL_SECTION_TIPO,
		SUITE_INDEX_POINTER_ID,
		{
			data: {
				label: SUITE_INDEX_POINTER_LABEL,
				section_id: null, // the canonical playground rows' metadata shape
				section_tipo: CANONICAL_SECTION_TIPO,
				created_date: dbTimestamp(),
				created_by_user_id: -1,
			},
			relation: pointerRelationColumn(),
			string: {
				[SUITE_INDEX_RELATED_LIST_TIPO]: [
					{ id: 1, lang: 'lg-eng', value: SUITE_INDEX_POINTER_LABEL },
				],
			},
		},
	);
	await fireSaveEvent(CANONICAL_SECTION_TIPO);
}

/**
 * Sweep it. THROWS when nothing was deleted: a sweep that removes no row means
 * something else (the test3 reseed, the run-created sweep) took it first — an
 * ordering defect the runner must not hide.
 */
export async function removeSuiteIndexPointerFixture(): Promise<void> {
	await assertTestDatabase('removeSuiteIndexPointerFixture');
	assertScratchId();
	const removed = await removeRow();
	if (removed === 0) {
		throw new DedaloError('internal.invariant', {
			message:
				'relation_index_pointer_fixture: the sweep deleted 0 rows — the pointer row is unaccounted for',
			coordinates: {
				table: CANONICAL_TABLE,
				section: CANONICAL_SECTION_TIPO,
				section_id: SUITE_INDEX_POINTER_ID,
			},
		});
	}
	await fireSaveEvent(CANONICAL_SECTION_TIPO);
}

async function removeRow(): Promise<number> {
	assertScratchId();
	return await deleteMatrixRecord(CANONICAL_TABLE, CANONICAL_SECTION_TIPO, SUITE_INDEX_POINTER_ID);
}
