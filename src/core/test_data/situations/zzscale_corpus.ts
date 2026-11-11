/**
 * THE MUSEUM-SCALE SCRATCH CORPUS — a `situation` big and odd enough to ask
 * the budget questions the suite database cannot.
 *
 * Read `zzscale_constants.ts` first: it holds the WHY, the id layout and every
 * volume number as stated arithmetic. This module holds only the DECLARATION
 * (the ontology nodes) and the RECORD GENERATOR, and both are pure reuse:
 *
 *   - `situation()` validates the reserved `zz*` TLD, forces every node under
 *     it, defaults each `section` onto the `matrix_test` scratch table and
 *     derives the section list that teardown sweeps;
 *   - `ensureSituation()` calls `assertTestDatabase()` before its first write,
 *     writes the nodes through `upsertDdOntologyNode`, resolves the table with
 *     `getMatrixTableFromTipo` and writes every record through
 *     `insertMatrixRecordWithExplicitId` — the counter-raising, advisory-locked
 *     explicit-id door, whose AFTER INSERT triggers derive the
 *     matrix_relation_index / matrix_string_search rows the search engines read;
 *   - `dropSituation()` sweeps the rows, the `matrix_time_machine` tail, the
 *     `matrix_counter` row and the TLD's nodes, and RETURNS the residue.
 *
 * Nothing here re-implements any of that. What is local is the SHAPE, and the
 * shape is deterministic: every record is a pure function of its id
 * (`zzScaleParentIdOf`, `zzScaleOrderValue`, `zzScaleTermOf` — no `Math.random`;
 * a non-deterministic corpus is not a corpus).
 *
 * `ensureZzScaleCorpus` / `dropZzScaleCorpus` are thin wrappers so a consuming
 * gate's `afterAll` can assert `expect(await dropZzScaleCorpus()).toBe(0)` —
 * residue asserted, never trusted.
 */

import { currentDataLang } from '../../resolve/request_lang.ts';
import {
	dropSituation,
	ensureSituation,
	residueOf,
	type Situation,
	type SituationDescriptor,
	type SituationRecord,
	situation,
} from './situation.ts';
import {
	ZZSCALE_CHILDREN_COMPONENT,
	ZZSCALE_INDEX_OWNER_COMPONENT,
	ZZSCALE_INDEX_OWNER_ID,
	ZZSCALE_INDEX_RELATION_TYPE,
	ZZSCALE_INDEX_TARGET_IDS,
	ZZSCALE_ORDER_COMPONENT,
	ZZSCALE_PARENT_COMPONENT,
	ZZSCALE_PARENT_RELATION_TYPE,
	ZZSCALE_POLY_CHILD_ID,
	ZZSCALE_POLY_ID_KEY_A,
	ZZSCALE_POLY_ID_KEY_B,
	ZZSCALE_POLY_ORDER_A,
	ZZSCALE_POLY_ORDER_B,
	ZZSCALE_POLY_PARENT_A_ID,
	ZZSCALE_POLY_PARENT_B_ID,
	ZZSCALE_SECTION,
	ZZSCALE_SECTION_LIST,
	ZZSCALE_SECTION_MAP,
	ZZSCALE_STRING_FIRST_ID,
	ZZSCALE_STRING_LAST_ID,
	ZZSCALE_STRING_VALUES,
	ZZSCALE_TERM_COMPONENT,
	ZZSCALE_TLD,
	ZZSCALE_TOTAL_RECORDS,
	ZZSCALE_TREE_LAST_ID,
	zzScaleOrderValue,
	zzScaleParentIdOf,
	zzScaleTermOf,
} from './zzscale_constants.ts';

/** One stored parent link — the upward dd47 locator the children engine inverts. */
function parentLocator(itemId: number, parentSectionId: number): Record<string, unknown> {
	return {
		id: itemId,
		type: ZZSCALE_PARENT_RELATION_TYPE,
		// int-canonical (WC-2026-08-10-section-id-int-canonical)
		section_id: parentSectionId,
		section_tipo: ZZSCALE_SECTION,
		from_component_tipo: ZZSCALE_PARENT_COMPONENT,
	};
}

/** One record's jsonb columns. `data` is stamped by ensureSituation. */
function recordColumns(sectionId: number, lang: string): Record<string, unknown> {
	const columns: Record<string, unknown> = {
		string: {
			[ZZSCALE_TERM_COMPONENT]: [{ id: 1, lang, value: zzScaleTermOf(sectionId) }],
		},
	};

	// THE STRING DISTRIBUTION band overrides only its own term text; the band is
	// parentless, so it joins no tree census.
	if (sectionId >= ZZSCALE_STRING_FIRST_ID && sectionId <= ZZSCALE_STRING_LAST_ID) {
		const value = ZZSCALE_STRING_VALUES[sectionId - ZZSCALE_STRING_FIRST_ID] as string;
		columns.string = { [ZZSCALE_TERM_COMPONENT]: [{ id: 1, lang, value }] };
		return columns;
	}

	// THE TWO-LOCATOR RECORD: both dd96 indexation locators, stored in
	// DESCENDING target order (see ZZSCALE_INDEX_TARGET_IDS).
	if (sectionId === ZZSCALE_INDEX_OWNER_ID) {
		columns.relation = {
			[ZZSCALE_INDEX_OWNER_COMPONENT]: ZZSCALE_INDEX_TARGET_IDS.map((target, index) => ({
				id: index + 1,
				type: ZZSCALE_INDEX_RELATION_TYPE,
				section_id: target,
				section_tipo: ZZSCALE_SECTION,
				from_component_tipo: ZZSCALE_INDEX_OWNER_COMPONENT,
			})),
		};
		return columns;
	}

	// THE POLY-HIERARCHY CHILD: two parent locators with DISTINCT item ids, and
	// an order value paired to each by id_key — the per-parent position that a
	// single-parent record cannot express.
	if (sectionId === ZZSCALE_POLY_CHILD_ID) {
		columns.relation = {
			[ZZSCALE_PARENT_COMPONENT]: [
				parentLocator(ZZSCALE_POLY_ID_KEY_A, ZZSCALE_POLY_PARENT_A_ID),
				parentLocator(ZZSCALE_POLY_ID_KEY_B, ZZSCALE_POLY_PARENT_B_ID),
			],
		};
		columns.number = {
			[ZZSCALE_ORDER_COMPONENT]: [
				{ id: ZZSCALE_POLY_ID_KEY_A, value: ZZSCALE_POLY_ORDER_A },
				{ id: ZZSCALE_POLY_ID_KEY_B, value: ZZSCALE_POLY_ORDER_B },
			],
		};
		return columns;
	}

	// THE TREE: one parent link (item id 1) and one order value paired to it.
	const parentId = zzScaleParentIdOf(sectionId);
	if (parentId !== null) {
		columns.relation = { [ZZSCALE_PARENT_COMPONENT]: [parentLocator(1, parentId)] };
		columns.number = {
			[ZZSCALE_ORDER_COMPONENT]: [{ id: 1, value: zzScaleOrderValue(sectionId) }],
		};
	}
	return columns;
}

/** Every record, ids 1..ZZSCALE_TOTAL_RECORDS contiguous. */
function zzScaleRecords(lang: string): SituationRecord[] {
	const records: SituationRecord[] = [];
	for (let sectionId = 1; sectionId <= ZZSCALE_TOTAL_RECORDS; sectionId++) {
		records.push({
			section_tipo: ZZSCALE_SECTION,
			section_id: sectionId,
			columns: recordColumns(sectionId, lang),
		});
	}
	return records;
}

/**
 * THE ONTOLOGY. Declarative and static — no config, no clock, no DB: the
 * nodes are the same on every machine and in every language.
 */
const ZZSCALE_NODES: SituationDescriptor['nodes'] = [
	// The ordinary section. No `relations` of its own, so situation.ts binds
	// it to matrix_test (never the installation's `matrix`).
	{
		tipo: ZZSCALE_SECTION,
		parent: 'test1',
		model: 'section',
		term: { 'lg-eng': 'zzscale scale corpus' },
	},
	{
		tipo: ZZSCALE_TERM_COMPONENT,
		parent: ZZSCALE_SECTION,
		model: 'component_input_text',
		is_translatable: true,
		order_number: 1,
	},
	{
		tipo: ZZSCALE_PARENT_COMPONENT,
		parent: ZZSCALE_SECTION,
		model: 'component_relation_parent',
		order_number: 2,
		// A relation_parent MUST carry an explicit config (PHP :88, implicit.ts
		// EXPLICIT_CONFIG_REQUIRED_MODELS): since T0-9 its flat value resolves
		// (flatValue 'datalist'), and a config-less node throws there exactly as
		// the edit form's builder does — the shape test71 has on the test TLD.
		properties: {
			source: {
				request_config: [
					{
						sqo: { section_tipo: [{ source: 'self' }] },
						show: {
							ddo_map: [{ tipo: ZZSCALE_TERM_COMPONENT, parent: 'self', section_tipo: 'self' }],
						},
					},
				],
			},
		},
	},
	{
		// getRelatedParentTipo reads THIS node's relations to find the parent
		// component it inverts — naming it here is what makes getChildren
		// resolve without falling back to the section walk.
		tipo: ZZSCALE_CHILDREN_COMPONENT,
		parent: ZZSCALE_SECTION,
		model: 'component_relation_children',
		relations: [{ tipo: ZZSCALE_PARENT_COMPONENT }],
		order_number: 3,
	},
	{
		tipo: ZZSCALE_ORDER_COMPONENT,
		parent: ZZSCALE_SECTION,
		model: 'component_number',
		order_number: 4,
	},
	{
		tipo: ZZSCALE_INDEX_OWNER_COMPONENT,
		parent: ZZSCALE_SECTION,
		model: 'component_portal',
		order_number: 5,
	},
	{
		// LIST COLUMNS. A render budget needs something to render; a bare
		// section answers with the built-in Id column alone. `relations` here
		// is the implicit-ddo form resolveListCellMap consumes.
		tipo: ZZSCALE_SECTION_LIST,
		parent: ZZSCALE_SECTION,
		model: 'section_list',
		relations: [{ tipo: ZZSCALE_TERM_COMPONENT }, { tipo: ZZSCALE_ORDER_COMPONENT }],
		order_number: 6,
	},
	{
		// `thesaurus.order` is the ONLY thing that opens getChildren's ordering
		// branch — and that branch is where the whole per-child cost lives.
		// Without this node the corpus would be wide and deep and still never
		// enter the code the budget is about.
		tipo: ZZSCALE_SECTION_MAP,
		parent: ZZSCALE_SECTION,
		model: 'section_map',
		properties: {
			thesaurus: {
				term: ZZSCALE_TERM_COMPONENT,
				parent: ZZSCALE_PARENT_COMPONENT,
				children: ZZSCALE_CHILDREN_COMPONENT,
				order: ZZSCALE_ORDER_COMPONENT,
			},
		},
		order_number: 7,
	},
];

/**
 * The corpus as a validated `Situation` — a FUNCTION, not a module-level
 * constant, for two reasons that are the same reason: nothing about this corpus
 * may be captured at import time. The data LANGUAGE comes from the
 * request-language ALS (`currentDataLang()`, the DATA-01 door — the install
 * default is not the request's language and a module-scope capture freezes
 * whichever it was at import), and a `Situation` built once at module scope
 * would freeze it with them. `situation()` is pure and cheap, so each call
 * rebuilds; the generator is deterministic, so two builds are identical.
 */
export function zzScaleCorpus(): Situation {
	return situation({
		name: 'zzscale museum-scale corpus',
		tld: ZZSCALE_TLD,
		nodes: ZZSCALE_NODES,
		records: zzScaleRecords(currentDataLang()),
	});
}

/** Build (or converge) the corpus. Idempotent — records are rewritten at the same ids. */
export async function ensureZzScaleCorpus(): Promise<void> {
	await ensureSituation(zzScaleCorpus());
}

/** Tear it down; the return value is the RESIDUE (0 = clean), asserted by the gate. */
export async function dropZzScaleCorpus(): Promise<number> {
	return dropSituation(zzScaleCorpus());
}

/** Rows still present for the corpus without tearing it down. */
export async function zzScaleResidue(): Promise<number> {
	return residueOf(zzScaleCorpus());
}

/** The tree's last id — re-exported so a consumer need not import two modules. */
export { ZZSCALE_TREE_LAST_ID };
