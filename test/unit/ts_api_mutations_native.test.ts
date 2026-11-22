/**
 * dd_ts_api MUTATIONS — TS-native gate for `save_order`, `add_child` and
 * `update_parent_data` (src/core/ts_object/ts_api.ts :407 / :183 / :302).
 *
 * These three actions are the tree's whole write surface and were uncovered:
 * they create records, move locators between parents and renumber sibling
 * orders, so a regression here is silent DATA CORRUPTION (a node under the
 * wrong parent, a lost order, a half-applied move).
 *
 * THE FLAGSHIP CASE IS MULTI-PARENT ON PURPOSE. Sibling order is a per-parent
 * dataframe on the CHILD, paired by id_key to the parent-link locator's item id
 * (dedalo-tree-ts, WC-015). With a single parent the dataframe holds ONE item,
 * so a correct `updateInlineValueByIdKey` and a naive `items[0]` write are
 * byte-identical and the gate proves nothing. So the fixture links the child to
 * its SECOND parent FIRST — the reordered parent's entry is therefore items[1],
 * and the untouched entry is items[0] (id:1). (The plan wrote "assert the id:2
 * entry is untouched"; pairing ids are allocation-ordered, and allocating the
 * reordered parent's link second is what makes the assertion discriminating.
 * Same fixture, ids swapped.)
 *
 * SCRATCH SURFACES (this file owns them exclusively):
 *  - matrix_test, section_tipo 'test3', section_id 912000..912999 — seeded by
 *    DIRECT INSERT (no matrix_counter bump, so concurrent suites keep their id
 *    space) and swept before every test + fail-loud in afterAll.
 *  - the records `add_child` itself creates: their ids come from matrix_counter
 *    and cannot be chosen, so they are tracked in `autoCreatedIds` and swept
 *    with the rest.
 *  - matrix_time_machine tails for both of the above.
 *  - the `zztad` situation (addChild's flags, THES-04 — 2026-11-22): two
 *    thesaurus sections whose section_map names an is_descriptor (and one an
 *    is_indexable) component, each flag's `dato_default` declared or not; the
 *    records add_child creates there are swept with the TLD (records, TM,
 *    counter, generation and activity rows), residue asserted 0.
 * dd_ontology is NOT a scratch surface: saveOrder's post-commit
 * syncOrderToDdOntology would write `order_number` outside every scratch
 * surface if getTermIdFromLocator resolved a scratch locator — the flagship
 * case pins that it does not, with a digest taken immediately around the call.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/index.ts';
import type { ParentLocator } from '../../src/core/relations/parent.ts';
import * as parentModule from '../../src/core/relations/parent.ts';
import { addParent } from '../../src/core/relations/parent.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { addChild, saveOrder, updateParentData } from '../../src/core/ts_object/ts_api.ts';
import { buildNodeData } from '../../src/core/ts_object/ts_object.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const PARENT_TIPO = 'test71'; // component_relation_parent of test3
const ORDER_TIPO = 'test22'; // component_number carrying the per-parent order
const DESCRIPTOR_TIPO = 'test88'; // is_descriptor (dd64 si/no)

// Scratch ids — this file's exclusive range.
const SCRATCH_MIN = 912000;
const SCRATCH_MAX = 912999;
const P1 = 912001;
const P2 = 912002;
const A = 912010;
const B = 912011;
const C = 912012;

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const NOBODY: Principal = { userId: 987654, isGlobalAdmin: false, isDeveloper: false };

/** Ids `add_child` allocated from matrix_counter (unchooseable) — swept too. */
const autoCreatedIds: number[] = [];

/** The real parent.ts exports, snapshotted BEFORE any mock.module install. */
const REAL_PARENT_MODULE = { ...parentModule };

type Locator = Record<string, unknown>;
type OrderItem = { id?: number | string; value?: unknown };

function siNoYes(componentTipo: string): Locator {
	return {
		id: 1,
		type: 'dd151',
		section_id: '1',
		section_tipo: 'dd64',
		from_component_tipo: componentTipo,
	};
}

function parentLocator(parentId: number): ParentLocator {
	return {
		section_tipo: SECTION,
		section_id: parentId,
		from_component_tipo: PARENT_TIPO,
		type: 'dd47',
	};
}

/** Direct INSERT of a scratch node (descriptor = yes). No counter bump. */
async function seedNode(sectionId: number): Promise<void> {
	if (sectionId < SCRATCH_MIN || sectionId > SCRATCH_MAX) {
		throw new Error(`seedNode: ${sectionId} is outside this file's scratch range`);
	}
	await sql.unsafe(
		`INSERT INTO "${TABLE}" (section_tipo, section_id, relation) VALUES ($1, $2, $3::text::jsonb)`,
		[SECTION, sectionId, encodeForJsonb({ [DESCRIPTOR_TIPO]: [siNoYes(DESCRIPTOR_TIPO)] })],
	);
}

/**
 * Link `childId` under `parentId` through the real machinery (id allocation +
 * order), in its own transaction (every parent.ts mutation requires one).
 */
async function link(childId: number, parentId: number): Promise<void> {
	const added = await withTransaction(() =>
		addParent(SECTION, childId, PARENT_TIPO, parentLocator(parentId), SUPERUSER.userId),
	);
	if (!added) throw new Error(`fixture link ${childId}→${parentId} failed`);
}

async function relationOf(sectionId: number, tipo: string): Promise<Locator[] | null> {
	const record = await readMatrixRecord(TABLE, SECTION, sectionId);
	const relation = (record?.columns.relation ?? null) as Record<string, Locator[]> | null;
	return relation?.[tipo] ?? null;
}

async function orderItemsOf(sectionId: number): Promise<OrderItem[] | null> {
	const record = await readMatrixRecord(TABLE, SECTION, sectionId);
	const numbers = (record?.columns.number ?? null) as Record<string, OrderItem[]> | null;
	return numbers?.[ORDER_TIPO] ?? null;
}

/** The Time Machine rows of one record (optionally one key) above `since` — the history a door left. */
async function historyOf(
	sectionId: number,
	since = 0,
	tipo: string | null = null,
): Promise<{ data: unknown; user_id: string }[]> {
	return (await sql.unsafe(
		`SELECT data, user_id FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND id > $3 AND ($4::text IS NULL OR tipo = $4)
		  ORDER BY id`,
		[SECTION, sectionId, since, tipo],
	)) as { data: unknown; user_id: string }[];
}

/** The newest Time Machine id (a door's rows are counted above it). */
async function tmWatermark(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT COALESCE(MAX(id), 0)::int AS id FROM matrix_time_machine',
	)) as { id: number }[];
	return Number(rows[0]?.id ?? 0);
}

/**
 * Every addChild call goes through here: the ids it allocates come from
 * matrix_counter and cannot be chosen, so they are tracked for the sweep. A
 * REFUSED call must not create anything — tracking it anyway is what keeps a
 * regression from leaking a stray child into the next test's fixture instead of
 * failing its own assertion.
 */
async function callAddChild(
	source: Record<string, unknown>,
	principal: Principal,
): Promise<Awaited<ReturnType<typeof addChild>>> {
	const outcome = await addChild({ source } as never, principal);
	const created = Number(outcome.data);
	if (Number.isInteger(created) && created > 0) autoCreatedIds.push(created);
	return outcome;
}

/**
 * A refusal is a THROW now (ERRORS_SPEC §4), asserted by CODE — the one
 * machine-readable identity — instead of by the old `{result:false,msg,errors}`
 * prose. `coordinates` are LOG-ONLY, so they are checked here, never on a wire
 * assertion. A refused addChild must still create nothing, which every caller
 * below asserts against the row count.
 */
async function refusal(run: Promise<unknown>): Promise<DedaloError> {
	try {
		await run;
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error('expected a refusal, but the call resolved');
}

/** Live count of test3 rows — only ever used as a DELTA inside one test body. */
async function test3RowCount(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${TABLE}" WHERE section_tipo = $1`,
		[SECTION],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

/**
 * Digest of every dd_ontology row of the `test` tld (the blast radius a scratch
 * test3 locator could reach through getTermIdFromLocator → order_number).
 */
async function testTldOntologyDigest(): Promise<string> {
	const rows = (await sql.unsafe(
		`SELECT coalesce(md5(string_agg(tipo || '#' || coalesce(order_number::text,'-') || '#' || coalesce(parent,'-'), ',' ORDER BY tipo)), 'EMPTY') AS digest
		   FROM dd_ontology WHERE tld = 'test'`,
		[],
	)) as { digest: string }[];
	return String(rows[0]?.digest);
}

/** Delete every scratch row (both ends). Returns how many matrix rows went. */
async function sweepScratch(): Promise<number> {
	// Only integers ever reach the id list (validated below), and the range bind is
	// parameterized — an empty array bind is what Bun.sql cannot encode, hence the split.
	const ids = [...new Set(autoCreatedIds.map((id) => Math.trunc(Number(id))))].filter((id) =>
		Number.isSafeInteger(id),
	);
	const idClause = ids.length > 0 ? ` OR section_id IN (${ids.join(',')})` : '';
	const deleted = (await sql.unsafe(
		`DELETE FROM "${TABLE}"
		  WHERE section_tipo = $1
		    AND (section_id BETWEEN $2 AND $3${idClause})
		 RETURNING id`,
		[SECTION, SCRATCH_MIN, SCRATCH_MAX],
	)) as unknown[];
	await sql.unsafe(
		`DELETE FROM matrix_time_machine
		  WHERE section_tipo = $1
		    AND (section_id BETWEEN $2 AND $3${idClause})`,
		[SECTION, SCRATCH_MIN, SCRATCH_MAX],
	);
	return deleted.length;
}

beforeEach(async () => {
	await sweepScratch();
	autoCreatedIds.length = 0;
});

afterEach(() => {
	// mock.module is process-GLOBAL and mock.restore() does NOT revert it — put
	// the real parent.ts back or every file that runs after this one gets the stub.
	mock.module('../../src/core/relations/parent.ts', () => REAL_PARENT_MODULE);
});

afterAll(async () => {
	await sweepScratch();
	const leftovers = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${TABLE}"
		  WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3`,
		[SECTION, SCRATCH_MIN, SCRATCH_MAX],
	)) as { n: number }[];
	const tm = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3`,
		[SECTION, SCRATCH_MIN, SCRATCH_MAX],
	)) as { n: number }[];
	if (Number(leftovers[0]?.n) !== 0 || Number(tm[0]?.n) !== 0) {
		throw new Error(
			`ts_api_mutations_native: scratch cleanup did NOT reach zero (matrix=${leftovers[0]?.n}, time_machine=${tm[0]?.n})`,
		);
	}
});

// ===========================================================================
// SAVE_ORDER
// ===========================================================================
describe('saveOrder', () => {
	test("reorders ONLY the reordered parent's id_key entry on a multi-parent child, and leaves dd_ontology alone", async () => {
		await seedNode(P1);
		await seedNode(P2);
		await seedNode(A);
		await seedNode(B);
		// P2 FIRST: A's order dataframe becomes [P2-link (id 1), P1-link (id 2)],
		// so the reordered parent is NOT items[0].
		await link(A, P2);
		await link(A, P1);
		await link(B, P1);

		const before = await orderItemsOf(A);
		expect(before).toEqual([
			{ value: 1, id: 1 }, // under P2
			{ value: 1, id: 2 }, // under P1
		]);
		expect(await orderItemsOf(B)).toEqual([{ value: 2, id: 1 }]);

		const ontologyBefore = await testTldOntologyDigest();
		const response = await saveOrder(
			{
				source: {
					section_tipo: SECTION,
					ar_locators: [
						{ section_tipo: SECTION, section_id: B },
						{ section_tipo: SECTION, section_id: A },
					],
					parent_section_tipo: SECTION,
					parent_section_id: P1,
				},
			} as never,
			SUPERUSER,
		);
		const ontologyAfter = await testTldOntologyDigest();

		expect(response.data).toEqual([
			{ value: 1, locator: { section_tipo: SECTION, section_id: B } },
			{ value: 2, locator: { section_tipo: SECTION, section_id: A } },
		]);

		// THE gate: the P1 entry moved to 2; the P2 entry is byte-identical.
		expect(await orderItemsOf(A)).toEqual([
			{ value: 1, id: 1 }, // P2 — UNTOUCHED
			{ value: 2, id: 2 }, // P1 — reordered
		]);
		expect(await orderItemsOf(B)).toEqual([{ value: 1, id: 1 }]);

		// syncOrderToDdOntology ran (result !== false) but a scratch test3 locator
		// resolves to no ontology term, so nothing outside the scratch surface moved.
		expect(ontologyAfter).toBe(ontologyBefore);
	});

	test('a second identical saveOrder is a no-op: it changes nothing', async () => {
		await seedNode(P1);
		await seedNode(A);
		await seedNode(B);
		await link(A, P1);
		await link(B, P1);

		const request = {
			source: {
				section_tipo: SECTION,
				ar_locators: [
					{ section_tipo: SECTION, section_id: B },
					{ section_tipo: SECTION, section_id: A },
				],
				parent_section_tipo: SECTION,
				parent_section_id: P1,
			},
		} as never;

		const first = await saveOrder(request, SUPERUSER);
		expect((first.data as unknown[]).length).toBe(2);
		const settled = await orderItemsOf(A);
		const settledB = await orderItemsOf(B);

		const second = await saveOrder(request, SUPERUSER);
		expect(second.data).toEqual([]);
		expect(await orderItemsOf(A)).toEqual(settled as OrderItem[]);
		expect(await orderItemsOf(B)).toEqual(settledB as OrderItem[]);
	});

	// WC-2026-11-07-save-order-complete-list: sortChildren rewrites 1..n from the
	// CLIENT list, so a list that is not exactly the parent's children is refused
	// before any write — a missing sibling would keep a colliding number.
	test.each([
		['a missing sibling', [A, B]],
		['a foreign entry', [A, B, C, P2]],
		['a duplicated entry', [A, B, C, A]],
	])('a sibling list with %s is refused as a conflict, nothing written', async (_label, ids) => {
		await seedNode(P1);
		await seedNode(P2);
		await seedNode(A);
		await seedNode(B);
		await seedNode(C);
		await link(A, P1);
		await link(B, P1);
		await link(C, P1);
		const before = [await orderItemsOf(A), await orderItemsOf(B), await orderItemsOf(C)];

		const error = await refusal(
			saveOrder(
				{
					source: {
						section_tipo: SECTION,
						ar_locators: ids.map((id) => ({ section_tipo: SECTION, section_id: id })),
						parent_section_tipo: SECTION,
						parent_section_id: P1,
					},
				} as never,
				SUPERUSER,
			),
		);
		expect(error.code).toBe('resource.conflict');
		expect(error.publicMessage).toBe(
			'The order was not saved: the list of terms is out of date. Reload the tree and try again',
		);
		expect([await orderItemsOf(A), await orderItemsOf(B), await orderItemsOf(C)]).toEqual(before);
	});

	test('the complete sibling list in a new order is accepted', async () => {
		await seedNode(P1);
		await seedNode(A);
		await seedNode(B);
		await seedNode(C);
		await link(A, P1);
		await link(B, P1);
		await link(C, P1);

		const response = await saveOrder(
			{
				source: {
					section_tipo: SECTION,
					ar_locators: [C, A, B].map((id) => ({ section_tipo: SECTION, section_id: id })),
					parent_section_tipo: SECTION,
					parent_section_id: P1,
				},
			} as never,
			SUPERUSER,
		);
		expect((response.data as unknown[]).length).toBeGreaterThan(0);
		expect(await orderItemsOf(C)).toEqual([{ value: 1, id: 1 }]);
		expect(await orderItemsOf(A)).toEqual([{ value: 2, id: 1 }]);
		expect(await orderItemsOf(B)).toEqual([{ value: 3, id: 1 }]);
	});

	test('missing parent context is refused before any write', async () => {
		await seedNode(P1);
		await seedNode(A);
		await link(A, P1);
		const before = await orderItemsOf(A);

		const error = await refusal(
			saveOrder(
				{
					source: {
						section_tipo: SECTION,
						ar_locators: [{ section_tipo: SECTION, section_id: A }],
						parent_section_tipo: '',
						parent_section_id: P1,
					},
				} as never,
				SUPERUSER,
			),
		);
		expect(error.code).toBe('request.invalid_options');
		expect(error.spec.status).toBe(400);
		// request.invalid_options discloses its sentence, so the caller still
		// learns WHICH fields are missing.
		expect(error.publicMessage).toBe(
			'Error. parent_section_tipo and parent_section_id are required',
		);
		expect(await orderItemsOf(A)).toEqual(before as OrderItem[]);

		// …and the same refusal when only the id is absent.
		const noId = await refusal(
			saveOrder(
				{
					source: {
						section_tipo: SECTION,
						ar_locators: [{ section_tipo: SECTION, section_id: A }],
						parent_section_tipo: SECTION,
					},
				} as never,
				SUPERUSER,
			),
		);
		expect(noId.code).toBe('request.invalid_options');
	});

	test('a section with no order component refuses as a state conflict, verbatim', async () => {
		// dd623 (presets) has no `thesaurus` section_map at all → sortChildren false.
		const error = await refusal(
			saveOrder(
				{
					source: {
						section_tipo: 'dd623',
						ar_locators: [{ section_tipo: 'dd623', section_id: 1 }],
						parent_section_tipo: 'dd623',
						parent_section_id: 1,
					},
				} as never,
				SUPERUSER,
			),
		);
		expect(error.code).toBe('resource.conflict');
		expect(error.spec.status).toBe(409);
		// resource.conflict is public-disclosure precisely so the operator
		// sentence — which names the fix — still reaches the caller verbatim.
		expect(error.publicMessage).toBe(
			'Error. The order cannot be established. Invalid section map. Please, define a valid section list map such as {"order":"hierarchy49"}',
		);
	});

	test('a caller without write permission is refused and nothing moves', async () => {
		await seedNode(P1);
		await seedNode(A);
		await seedNode(B);
		await link(A, P1);
		await link(B, P1);
		const beforeA = await orderItemsOf(A);
		const beforeB = await orderItemsOf(B);

		const error = await refusal(
			saveOrder(
				{
					source: {
						section_tipo: SECTION,
						ar_locators: [
							{ section_tipo: SECTION, section_id: B },
							{ section_tipo: SECTION, section_id: A },
						],
						parent_section_tipo: SECTION,
						parent_section_id: P1,
					},
				} as never,
				NOBODY,
			),
		);
		expect(error.code).toBe('perm.denied');
		expect(error.spec.status).toBe(403);
		expect(error.coordinates).toEqual({ section_tipo: SECTION, required_level: 2 });
		expect(await orderItemsOf(A)).toEqual(beforeA as OrderItem[]);
		expect(await orderItemsOf(B)).toEqual(beforeB as OrderItem[]);
	});
});

// ===========================================================================
// ADD_CHILD — the flags a tree-created term is born with (THES-04/05)
// ===========================================================================
/**
 * The is_descriptor / is_indexable flags are what the ONTOLOGY declares, and
 * nothing else (owner ruling 2026-11-19, M4: no dato_default is added on the
 * master ontology — "the user must handle these properties manually"). The
 * create door's birth seed (record_defaults.ts) writes a declared
 * `dato_default`; add_child adds NO value of its own — it used to stamp dd64/1
 * on both flags, overwriting a declared default and inventing one where none
 * was declared (THES-04), with a string section_id (THES-05).
 *
 *   FLAGS_A  is_descriptor declares dd64/2 → born /2 (the hardcode overwrote it to /1)
 *            is_indexable declares nothing → no value at all (the hardcode wrote /1)
 *   FLAGS_B  is_descriptor declares dd64/1 → born /1, ONE item, int section_id; the
 *            birth state is not a change: no Time Machine row for the key (the
 *            hardcode re-wrote the seeded value and logged it as a save)
 *            section_map names no is_indexable → the warning, verbatim
 *   FLAGS_C  is_descriptor declares NOTHING (the shipped master-ontology case) +
 *            a tree row map with an ND icon and link_children: the STATED
 *            consequence (WC-2026-08-09 addendum 2026-11-22, owner question
 *            open — B6 review M1) — the unflagged child renders as a
 *            descriptor itself, but its parent counts it as neither, so a
 *            parent whose children are all unflagged draws no expand arrow
 *            and no ND button on a fresh read
 */
const FLAG_TLD = 'zztad';
const FLAGS_A = {
	section: 'zztad1',
	term: 'zztad2',
	parent: 'zztad3',
	children: 'zztad4',
	order: 'zztad5',
	map: 'zztad6',
	button: 'zztad9',
	descriptor: 'zztad7',
	indexable: 'zztad8',
};
const FLAGS_B = {
	section: 'zztad20',
	term: 'zztad21',
	parent: 'zztad22',
	children: 'zztad23',
	order: 'zztad24',
	map: 'zztad25',
	button: 'zztad29',
	descriptor: 'zztad27',
	indexable: null,
};
const FLAGS_C = {
	section: 'zztad40',
	term: 'zztad41',
	parent: 'zztad42',
	children: 'zztad43',
	order: 'zztad44',
	map: 'zztad45',
	button: 'zztad49',
	descriptor: 'zztad47',
	indexable: null,
};
/** FLAGS_C's tree row map: term, the ND icon on the flag, the children arrow. */
const FLAGS_C_ROW_MAP = {
	tipo: 'zztad46',
	parent: FLAGS_C.section,
	model: 'section_list_thesaurus',
	order_number: 9,
	properties: {
		show: {
			ddo_map: [
				{ tipo: FLAGS_C.term, type: 'term' },
				{ tipo: FLAGS_C.descriptor, type: 'icon', icon: 'ND' },
				{ tipo: FLAGS_C.children, type: 'link_children' },
			],
		},
	},
};

function selfRequestConfig(termTipo: string): Record<string, unknown> {
	return {
		source: {
			records_mode: 'list',
			request_config: [
				{
					sqo: { section_tipo: [{ source: 'self' }] },
					show: { ddo_map: [{ tipo: termTipo, parent: 'self', section_tipo: 'self' }] },
				},
			],
		},
	};
}

function siNoRequestConfig(): Record<string, unknown> {
	return {
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ source: 'section', value: ['dd64'] }] },
					show: { ddo_map: [{ tipo: 'dd62', parent: 'self', section_tipo: 'dd64' }] },
				},
			],
		},
	};
}

function flagSectionNodes(
	s: typeof FLAGS_A | typeof FLAGS_B | typeof FLAGS_C,
	descriptorDefault: number | null,
	indexable: boolean,
): (Record<string, unknown> & { tipo: string; model: string })[] {
	const siNo = (tipo: string, order: number, defaultId: number | null) => ({
		tipo,
		parent: s.section,
		model: 'component_radio_button',
		order_number: order,
		properties: {
			...siNoRequestConfig(),
			...(defaultId === null
				? {}
				: { dato_default: [{ section_id: defaultId, section_tipo: 'dd64' }] }),
		},
	});
	return [
		{
			tipo: s.section,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': `${s.section} flags` },
		},
		{
			tipo: s.term,
			parent: s.section,
			model: 'component_input_text',
			is_translatable: true,
			order_number: 1,
		},
		{
			tipo: s.parent,
			parent: s.section,
			model: 'component_relation_parent',
			relations: [{ tipo: s.children }],
			properties: selfRequestConfig(s.term),
			order_number: 2,
		},
		{
			tipo: s.children,
			parent: s.section,
			model: 'component_relation_children',
			relations: [{ tipo: s.parent }],
			properties: selfRequestConfig(s.term),
			order_number: 3,
		},
		{ tipo: s.order, parent: s.section, model: 'component_number', order_number: 4 },
		siNo(s.descriptor, 5, descriptorDefault),
		...(indexable && s.indexable !== null ? [siNo(s.indexable, 6, null)] : []),
		{
			tipo: s.map,
			parent: s.section,
			model: 'section_map',
			order_number: 7,
			properties: {
				thesaurus: {
					term: s.term,
					parent: s.parent,
					children: s.children,
					order: s.order,
					is_descriptor: s.descriptor,
					...(indexable && s.indexable !== null ? { is_indexable: s.indexable } : {}),
				},
			},
		},
		{ tipo: s.button, parent: s.section, model: 'button_new', order_number: 8 },
	];
}

const FLAG_SITUATION = situation({
	tld: FLAG_TLD,
	name: 'add_child flags (THES-04)',
	nodes: [
		...flagSectionNodes(FLAGS_A, 2, true),
		...flagSectionNodes(FLAGS_B, 1, false),
		...flagSectionNodes(FLAGS_C, null, false),
		FLAGS_C_ROW_MAP,
	] as never,
});

async function dropFlagSituation(): Promise<number> {
	let activity = 0;
	for (const s of [FLAGS_A, FLAGS_B, FLAGS_C]) {
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [
			s.section,
		]);
		await sweepActivityRows(s.section);
		activity += await countActivityRows(s.section);
	}
	return activity + (await dropSituation(FLAG_SITUATION));
}

/** One relation key of a zztad record (null when the key is absent). */
async function flagKeyOf(
	sectionTipo: string,
	sectionId: number,
	tipo: string,
): Promise<Locator[] | null> {
	const record = await readMatrixRecord(TABLE, sectionTipo, sectionId);
	const relation = (record?.columns.relation ?? null) as Record<string, Locator[]> | null;
	return relation?.[tipo] ?? null;
}

/** Time Machine rows of one zztad record key above `since`. */
async function flagHistoryOf(
	sectionTipo: string,
	sectionId: number,
	tipo: string,
	since: number,
): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id > $4`,
		[sectionTipo, sectionId, tipo, since],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? -1);
}

describe('addChild — the flags are what the ontology declares (THES-04/05)', () => {
	beforeAll(async () => {
		await dropFlagSituation();
		await ensureSituation(FLAG_SITUATION);
	});
	afterAll(async () => {
		expect(await dropFlagSituation()).toBe(0);
	});

	test('declared /2 stays /2; an undeclared flag gets NO value; the child is linked', async () => {
		const parentId = await createSectionRecord(FLAGS_A.section, SUPERUSER.userId);
		const response = await addChild(
			{ source: { section_tipo: FLAGS_A.section, section_id: parentId } } as never,
			SUPERUSER,
		);
		const newId = Number(response.data);
		expect(Number.isInteger(newId) && newId > parentId).toBe(true);
		expect(response.warnings ?? []).toEqual([]);
		expect(await flagKeyOf(FLAGS_A.section, newId, FLAGS_A.parent)).toEqual([
			{
				section_tipo: FLAGS_A.section,
				section_id: parentId,
				from_component_tipo: FLAGS_A.parent,
				type: 'dd47',
				id: 1,
			},
		]);
		const descriptor = await flagKeyOf(FLAGS_A.section, newId, FLAGS_A.descriptor);
		expect(descriptor?.length).toBe(1);
		expect(descriptor?.[0]).toMatchObject({ section_tipo: 'dd64', section_id: 2 });
		expect(await flagKeyOf(FLAGS_A.section, newId, FLAGS_A.indexable as string)).toBeNull();
	});

	test('declared /1 is born /1 (one item, int id), and the birth state writes no history row', async () => {
		const parentId = await createSectionRecord(FLAGS_B.section, SUPERUSER.userId);
		const since = await tmWatermark();
		const response = await addChild(
			{ source: { section_tipo: FLAGS_B.section, section_id: parentId } } as never,
			SUPERUSER,
		);
		const newId = Number(response.data);
		expect(Number.isInteger(newId) && newId > parentId).toBe(true);
		// the section_map names no is_indexable: the action completes and says so
		expect(response.warnings).toEqual(["Invalid section_map 'is_indexable' property from section"]);
		const descriptor = await flagKeyOf(FLAGS_B.section, newId, FLAGS_B.descriptor);
		expect(descriptor?.length).toBe(1);
		expect(descriptor?.[0]).toMatchObject({ section_tipo: 'dd64', section_id: 1 });
		expect(typeof descriptor?.[0]?.section_id).toBe('number');
		expect(await flagHistoryOf(FLAGS_B.section, newId, FLAGS_B.descriptor, since)).toBe(0);
		// the parent link IS a write of add_child's own, and is historied
		expect(await flagHistoryOf(FLAGS_B.section, newId, FLAGS_B.parent, since)).toBe(1);
	});

	test('undeclared is_descriptor: the child renders as a descriptor, its parent counts it as neither (stated consequence, owner question open)', async () => {
		const parentId = await createSectionRecord(FLAGS_C.section, SUPERUSER.userId);
		const response = await addChild(
			{ source: { section_tipo: FLAGS_C.section, section_id: parentId } } as never,
			SUPERUSER,
		);
		const newId = Number(response.data);
		expect(Number.isInteger(newId) && newId > parentId).toBe(true);
		expect(await flagKeyOf(FLAGS_C.section, newId, FLAGS_C.descriptor)).toBeNull();
		// the child itself: a descriptor (is_descriptor starts true; only an ND /2 flips it)
		const child = await buildNodeData(FLAGS_C.section, newId, {}, null, SUPERUSER);
		expect(child.is_descriptor).toBe(true);
		// its parent, read fresh (the children read finds the child: a null flag
		// read as a descriptor turns this leg red — mutation-checked) …
		const parent = await buildNodeData(FLAGS_C.section, parentId, {}, null, SUPERUSER);
		expect(parent.children_tipo).toBe(FLAGS_C.children);
		// … but counted as neither: no arrow, no ND button
		expect(parent.has_descriptor_children).toBe(false);
		expect(parent.ar_elements.some((element) => element.type === 'link_children_nd')).toBe(false);
		expect(parent.ar_elements.find((element) => element.type === 'link_children')?.value).toBe(
			'button show children unactive',
		);
	});
});

// ===========================================================================
// ADD_CHILD
// ===========================================================================
describe('addChild', () => {
	test('a section without a component_relation_parent is refused before any record is created', async () => {
		const before = await test3RowCount();
		const listCountBefore = (
			(await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_list WHERE section_tipo = 'dd623'`,
				[],
			)) as { n: number }[]
		)[0]?.n;

		const error = await refusal(callAddChild({ section_tipo: 'dd623', section_id: 1 }, SUPERUSER));

		expect(error.code).toBe('tree.parent_unresolved');
		expect(error.spec.status).toBe(409);
		// public disclosure — the operator sentence survives verbatim.
		expect(error.publicMessage).toBe(
			'Error on get component_relation_parent from section. Model does not exists',
		);
		expect(error.coordinates?.section_tipo).toBe('dd623');
		const listCountAfter = (
			(await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_list WHERE section_tipo = 'dd623'`,
				[],
			)) as { n: number }[]
		)[0]?.n;
		expect(listCountAfter).toBe(listCountBefore);
		expect(await test3RowCount()).toBe(before);
	});

	test('a caller without write permission is refused', async () => {
		await seedNode(P1);
		const before = await test3RowCount();
		const error = await refusal(callAddChild({ section_tipo: SECTION, section_id: P1 }, NOBODY));
		expect(error.code).toBe('perm.denied');
		expect(error.spec.status).toBe(403);
		// The refusal is the New-button predicate's section half (T0-2 / D4 —
		// write_door.ts authorizeRecordCreate): it names the door and the section.
		expect(error.coordinates).toEqual({
			door: 'add_child',
			section_tipo: SECTION,
			tipo: SECTION,
			required: 2,
		});
		expect(await test3RowCount()).toBe(before);
	});

	test('a failing addParent rolls the whole creation back — no orphan record survives', async () => {
		await seedNode(P1);
		const before = await test3RowCount();

		mock.module('../../src/core/relations/parent.ts', () => ({
			...REAL_PARENT_MODULE,
			addParent: async () => false,
		}));

		const error = await refusal(callAddChild({ section_tipo: SECTION, section_id: P1 }, SUPERUSER));

		expect(error.code).toBe('tree.node_write_failed');
		expect(error.spec.status).toBe(500);
		expect(error.publicMessage).toBe('Error on add_child. The process was rolled back');
		// The caught reason is the CAUSE — logged, never serialized (a rollback
		// reason is engine internals).
		expect((error.cause as Error).message).toContain('Failed add parent locator to new section');
		expect(error.coordinates).toEqual({
			section_tipo: SECTION,
			section_id: P1,
			action: 'add_child',
		});
		// the record created inside the transaction must be gone.
		expect(await test3RowCount()).toBe(before);
	});
});

// ===========================================================================
// UPDATE_PARENT_DATA
// ===========================================================================
describe('updateParentData', () => {
	test('self-target is refused by the cycle guard even with mixed id types', async () => {
		await seedNode(P1);
		await seedNode(A);
		await link(A, P1);
		const before = await relationOf(A, PARENT_TIPO);

		const error = await refusal(
			updateParentData(
				{
					source: {
						section_tipo: SECTION,
						section_id: String(A), // STRING on the wire…
						old_parent_section_tipo: SECTION,
						old_parent_section_id: P1,
						new_parent_section_tipo: SECTION,
						new_parent_section_id: A, // …NUMBER here: only the door's coercion catches it
					},
				} as never,
				SUPERUSER,
			),
		);

		expect(error.code).toBe('tree.cycle');
		expect(error.spec.status).toBe(409);
		expect(await relationOf(A, PARENT_TIPO)).toEqual(before as Locator[]);
	});

	test('moving a node under its own descendant is refused', async () => {
		await seedNode(P1);
		await seedNode(A);
		await seedNode(B);
		await link(A, P1);
		await link(B, A); // chain P1 → A → B
		const beforeA = await relationOf(A, PARENT_TIPO);
		const beforeB = await relationOf(B, PARENT_TIPO);

		const error = await refusal(
			updateParentData(
				{
					source: {
						section_tipo: SECTION,
						section_id: A,
						old_parent_section_tipo: SECTION,
						old_parent_section_id: P1,
						new_parent_section_tipo: SECTION,
						new_parent_section_id: B,
					},
				} as never,
				SUPERUSER,
			),
		);

		expect(error.code).toBe('tree.cycle');
		expect(await relationOf(A, PARENT_TIPO)).toEqual(beforeA as Locator[]);
		expect(await relationOf(B, PARENT_TIPO)).toEqual(beforeB as Locator[]);
	});

	test('a valid move re-links the node and renumbers the old siblings contiguously', async () => {
		await seedNode(P1);
		await seedNode(P2);
		await seedNode(A);
		await seedNode(B);
		await seedNode(C);
		await link(A, P1); // order 1
		await link(B, P1); // order 2
		await link(C, P1); // order 3
		expect(await orderItemsOf(C)).toEqual([{ value: 3, id: 1 }]);

		const response = await updateParentData(
			{
				source: {
					section_tipo: SECTION,
					section_id: A,
					old_parent_section_tipo: SECTION,
					old_parent_section_id: P1,
					new_parent_section_tipo: SECTION,
					new_parent_section_id: P2,
				},
			} as never,
			SUPERUSER,
		);

		expect(response.data).toBe(true);

		// exactly ONE parent link, and it points at P2.
		const links = (await relationOf(A, PARENT_TIPO)) as Locator[];
		expect(links.length).toBe(1);
		expect(links[0]?.section_id).toBe(P2);
		expect(links[0]?.type).toBe('dd47');

		// A's WHOLE order value: one frame, keyed to the NEW link's item id (first
		// under the empty P2) — the removed link's frame (id 1) is gone, never an
		// orphan left in the record and its history.
		const newLinkId = Number(links[0]?.id);
		expect(newLinkId).not.toBe(1);
		expect(await orderItemsOf(A)).toEqual([{ value: 1, id: newLinkId }]);

		// old siblings renumbered densely from 1.
		expect(await orderItemsOf(B)).toEqual([{ value: 1, id: 1 }]);
		expect(await orderItemsOf(C)).toEqual([{ value: 2, id: 1 }]);
	});

	test('a move to an already-linked parent is rolled back whole: the removed locator comes back', async () => {
		await seedNode(P1);
		await seedNode(P2);
		await seedNode(A);
		await link(A, P1);
		await link(A, P2); // A is a child of BOTH
		const beforeLinks = await relationOf(A, PARENT_TIPO);
		const beforeOrder = await orderItemsOf(A);
		const beforeHistory = (await historyOf(A)).length;
		expect((beforeLinks as Locator[]).length).toBe(2);

		// moveParent removes the P1 order entry (a WRITE, historied), then the P2
		// link hits the dedup guard (`to_refused`) → the throw, and ONLY the
		// transaction restores the order entry and drops its history row.
		const error = await refusal(
			updateParentData(
				{
					source: {
						section_tipo: SECTION,
						section_id: A,
						old_parent_section_tipo: SECTION,
						old_parent_section_id: P1,
						new_parent_section_tipo: SECTION,
						new_parent_section_id: P2,
					},
				} as never,
				SUPERUSER,
			),
		);

		expect(error.code).toBe('tree.node_write_failed');
		expect(error.publicMessage).toBe('Error on update_parent_data. The process was rolled back');
		expect((error.cause as Error).message).toContain(
			`Add new parent locator failed: ${SECTION}_${P2}`,
		);

		expect(await relationOf(A, PARENT_TIPO)).toEqual(beforeLinks as Locator[]);
		expect(await orderItemsOf(A)).toEqual(beforeOrder as OrderItem[]);
		// …and the order removal's history row went with it.
		expect((await historyOf(A)).length).toBe(beforeHistory);
	});

	test('a STALE move (old parent no longer linked) is refused whole: never turned into an add', async () => {
		// The CORE-3 race outcome as one request: a concurrent move already took A
		// out of P2 (here: A was never under P2). The move must not ADD C anyway —
		// A would end up with an extra broader term and the call would answer ok.
		await seedNode(P1);
		await seedNode(P2);
		await seedNode(A);
		await seedNode(C);
		await link(A, P1);
		const beforeLinks = await relationOf(A, PARENT_TIPO);
		const beforeOrder = await orderItemsOf(A);
		const historyRows = async (): Promise<number> => {
			const rows = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine
				  WHERE section_tipo = $1 AND section_id = $2`,
				[SECTION, A],
			)) as { n: number }[];
			return Number(rows[0]?.n ?? -1);
		};
		const beforeHistory = await historyRows();

		const error = await refusal(
			updateParentData(
				{
					source: {
						section_tipo: SECTION,
						section_id: A,
						old_parent_section_tipo: SECTION,
						old_parent_section_id: P2,
						new_parent_section_tipo: SECTION,
						new_parent_section_id: C,
					},
				} as never,
				SUPERUSER,
			),
		);

		expect(error.code).toBe('tree.node_write_failed');
		expect((error.cause as Error).message).toContain(
			`Remove old parent locator failed: ${SECTION}_${P2}`,
		);
		expect(await relationOf(A, PARENT_TIPO)).toEqual(beforeLinks as Locator[]);
		expect(await orderItemsOf(A)).toEqual(beforeOrder as OrderItem[]);
		expect(await historyRows()).toBe(beforeHistory);
	});

	test('a caller without write permission is refused', async () => {
		await seedNode(P1);
		await seedNode(P2);
		await seedNode(A);
		await link(A, P1);
		const before = await relationOf(A, PARENT_TIPO);

		const error = await refusal(
			updateParentData(
				{
					source: {
						section_tipo: SECTION,
						section_id: A,
						old_parent_section_tipo: SECTION,
						old_parent_section_id: P1,
						new_parent_section_tipo: SECTION,
						new_parent_section_id: P2,
					},
				} as never,
				NOBODY,
			),
		);

		expect(error.code).toBe('perm.denied');
		expect(error.coordinates).toEqual({ section_tipo: SECTION, required_level: 2 });
		expect(await relationOf(A, PARENT_TIPO)).toEqual(before as Locator[]);
	});
});
