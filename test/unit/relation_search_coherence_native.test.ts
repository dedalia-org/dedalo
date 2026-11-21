/**
 * THE ANCESTOR INDEX MOVES WITH THE LOCATORS (P1-7 / DATA-12).
 *
 * `relation_search` holds, per component, the ANCESTOR chain of every locator
 * the component points at. Since 2026-08-09 it is READ, not write-only:
 * `conform.ts` emits `direct OR ancestor` for positive operators and
 * `NOT direct AND NOT ancestor` for the negating set. So a door that rewrites
 * `relation` and leaves `relation_search` standing makes the two stores
 * disagree PERMANENTLY, and search answers wrongly in BOTH directions — the
 * removed term still matches a broader-term search, and the negating operators
 * still exclude the record.
 *
 * `maintainRelationSearchIndex` had exactly ONE production caller (the component
 * save). The two doors that also REMOVE relation locators — `deletePortalLocator`
 * (portal delete-locator, text_area tag-delete, MCP `dedalo_portal_unlink`) and
 * `removeAllInverseReferences` (every holder of a record being deleted) — wrote
 * `relation` and never touched the index. PHP called `$component->Save()` on
 * both, so this was an unledgered divergence, not parity, and the only self-heal
 * was an unrelated later save.
 *
 * THE INVARIANT, after each door: `relation_search[tipo]` may hold no ancestor
 * of a locator absent from `relation[tipo]`.
 *
 * (!) FIXTURE DISCIPLINE. This gate creates its OWN hierarchy term under an
 * existing branch and removes only that. An earlier draft deleted a term of the
 * SHARED synthetic hierarchy to trigger the inverse sweep and left the fixture
 * two rows short (1298 of 1300) for every later gate — the exact
 * consume-a-shared-fixture failure the suite's own law forbids.
 *
 * (!) OWN SECTION. The holder section is this file's scratch `zzrscoh1`
 * (records in matrix_test), its one component an autocomplete_hi carrying
 * test205's definition. It used to be test3/test205 — but test205 is parked
 * under the `box elements` container test115, OUTSIDE test3 by the section
 * containment law (T2-SL-3a, owner ruling (b): the v6 law, everywhere): the
 * record WIPE no longer empties it (delete_data leaves data of box-parked
 * components, as v6), so the wipe door had nothing to test there, and test3
 * holds no autocomplete_hi inside the section.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { deletePortalLocator } from '../../src/core/relations/save.ts';
import {
	deleteSectionData,
	deleteSectionRecord,
} from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { SYNTHETIC_HIERARCHY_A_TLD } from '../../src/core/test_data/synthetic_hierarchy_constants.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'zzrscoh1';
const TABLE = 'matrix_test';
/** `getNode(...).model` is component_autocomplete_hi — the model the save's index branch tests. */
const HI_TIPO = 'zzrscoh2';

/** The holder section + its autocomplete_hi, a direct child (inside the section by the law). */
const S = situation({
	name: 'relation_search coherence holder',
	tld: 'zzrscoh',
	nodes: [
		// test24 = the matrix_test table.
		{ tipo: SECTION, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: HI_TIPO,
			parent: SECTION,
			model: 'component_autocomplete_hi',
			order_number: 1,
			// test205's request_config: the targets are the active hierarchies.
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [2], source: 'hierarchy_types' }] },
							show: {
								ddo_map: [{ tipo: 'hierarchy25', parent: HI_TIPO, section_tipo: 'self' }],
								sqo_config: { limit: 5 },
								fields_separator: ', ',
								value_with_parents: true,
							},
						},
					],
				},
			},
		},
	],
});
const THESAURUS = `${SYNTHETIC_HIERARCHY_A_TLD}1`;
const HIERARCHY_TABLE = 'matrix_hierarchy';
/** The parent component of this hierarchy (read from the fixture's own rows). */
const PARENT_TIPO = 'hierarchy36';
const USER_ID = -1;

const HOLDER_ID = 998811;
/** OUR OWN term, a child of the shared branch — created and removed by this file. */
const OWN_TERM_ID = 998900;
const OWN_TERM_PARENT = 3; // its chain is therefore [3, 1]

const OWN_TERM = {
	section_tipo: THESAURUS,
	section_id: OWN_TERM_ID,
	from_component_tipo: HI_TIPO,
};

async function columns(sectionId: number): Promise<{
	relation: Record<string, unknown[]>;
	relation_search: Record<string, unknown[]>;
}> {
	const rows = (await sql.unsafe(
		`SELECT COALESCE(relation,'{}'::jsonb) AS relation,
		        COALESCE(relation_search,'{}'::jsonb) AS relation_search
		   FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId],
	)) as { relation: Record<string, unknown[]>; relation_search: Record<string, unknown[]> }[];
	return rows[0] ?? { relation: {}, relation_search: {} };
}

/** The invariant: no indexed ancestor without a locator to justify it. */
async function assertCoherent(): Promise<void> {
	const { relation, relation_search } = await columns(HOLDER_ID);
	const indexed = (relation_search[HI_TIPO] ?? []) as unknown[];
	const held = (relation[HI_TIPO] ?? []) as unknown[];
	if (held.length === 0) {
		expect(
			indexed.length,
			`relation_search[${HI_TIPO}] still holds ${indexed.length} ancestor(s) for a component that ` +
				'points at NOTHING — search keeps matching this record on a broader term, and the ' +
				'negating operators keep excluding it.',
		).toBe(0);
	}
}

async function removeOwnTerm(): Promise<void> {
	await sql.unsafe(`DELETE FROM "${HIERARCHY_TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
		THESAURUS,
		OWN_TERM_ID,
	]);
	await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${THESAURUS} AND section_id = ${OWN_TERM_ID}`;
}

describe('relation_search coherence across every removal door', () => {
	beforeAll(async () => {
		await dropSituation(S);
		await ensureSituation(S);
	});

	beforeEach(async () => {
		await cleanScratchRecord(SECTION, HOLDER_ID, TABLE);
		await removeOwnTerm();

		// OUR term, hung under an existing branch so it HAS an ancestor chain.
		await sql.unsafe(
			`INSERT INTO "${HIERARCHY_TABLE}" (section_id, section_tipo, relation)
			 VALUES ($2, $1, $3::text::jsonb)`,
			[
				THESAURUS,
				OWN_TERM_ID,
				JSON.stringify({
					[PARENT_TIPO]: [
						{
							id: 1,
							type: 'dd47',
							section_id: OWN_TERM_PARENT,
							section_tipo: THESAURUS,
							from_component_tipo: PARENT_TIPO,
						},
					],
				}),
			],
		);

		await sql.unsafe(
			`INSERT INTO "${TABLE}" (section_id, section_tipo) VALUES ($2, $1)
			 ON CONFLICT (section_id, section_tipo) DO NOTHING`,
			[SECTION, HOLDER_ID],
		);
		// The SAVE door populates the index — the one caller that always did.
		await saveComponentData({
			componentTipo: HI_TIPO,
			sectionTipo: SECTION,
			sectionId: HOLDER_ID,
			lang: 'lg-nolan',
			userId: USER_ID,
			changedData: [{ action: 'set_data', id: null, value: [OWN_TERM] }],
		});
		// ANTI-VACUITY: with no ancestors indexed, every assertion below passes
		// trivially and this gate proves nothing.
		expect(
			((await columns(HOLDER_ID)).relation_search[HI_TIPO] ?? []).length,
			'the seed indexed no ancestors — the save door did not populate relation_search',
		).toBeGreaterThan(0);
	});

	afterAll(async () => {
		await cleanScratchRecord(SECTION, HOLDER_ID, TABLE);
		await removeOwnTerm();
		expect(await dropSituation(S)).toBe(0);
	});

	test('deletePortalLocator leaves no orphaned ancestors', async () => {
		// The STORED locator, verbatim: the door's compare is a strict property
		// UNION, so a stripped-down locator matches nothing and deletes nothing.
		const stored = ((await columns(HOLDER_ID)).relation[HI_TIPO] ?? [])[0] as Record<
			string,
			unknown
		>;
		await deletePortalLocator(
			await resolvePrincipal(USER_ID),
			{ tipo: HI_TIPO, section_tipo: SECTION, section_id: HOLDER_ID },
			{ locator: stored },
		);
		expect((await columns(HOLDER_ID)).relation[HI_TIPO] ?? []).toEqual([]);
		await assertCoherent();
	}, 60000);

	test('deleteSectionData (the record WIPE door) leaves no orphaned ancestors', async () => {
		// THE FOURTH DOOR. Emptying a record's data drops every locator its
		// relation components held, so the ancestor index must go with them.
		// This door imported maintainRelationSearchIndex and never called it:
		// the wipe left relation_search standing, and `conform.ts`'s
		// `direct OR ancestor` kept answering for a component pointing at
		// nothing — the same permanent disagreement the three doors above were
		// fixed for. Found 2026-09-05 by an unused-import lint on the very
		// symbol that was meant to be called.
		await deleteSectionData(SECTION, HOLDER_ID, USER_ID, new Date());
		expect(
			((await columns(HOLDER_ID)).relation[HI_TIPO] ?? []).length,
			'the wipe did not empty the relation component — re-read this gate',
		).toBe(0);
		await assertCoherent();
	}, 60000);

	test('deleting the TARGET leaves no orphaned ancestors in its holders', async () => {
		// removeAllInverseReferences rewrites every holder's `relation`; the index
		// must move with it. The target is OUR term, never a shared one.
		await deleteSectionRecord(THESAURUS, OWN_TERM_ID, USER_ID, new Date());
		expect(
			((await columns(HOLDER_ID)).relation[HI_TIPO] ?? []).length,
			'the inverse sweep did not remove the locator — re-read this gate',
		).toBe(0);
		await assertCoherent();
	}, 60000);
});
