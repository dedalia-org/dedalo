/**
 * Generic has_dataframe LITERAL read — TS-NATIVE half (DEC-14b P1), the
 * survival twin of test/parity/has_dataframe_literal_differential.test.ts
 * (which needs the live PHP oracle and dies without it).
 *
 * SELF-SUFFICIENT FIXTURE (2026-07-13). This gate now BUILDS EVERY ROW IT READS
 * and reverts all of it: the frame node (FRAME_TIPO under test52), test52's
 * has_dataframe properties, the scratch test3 record, AND the dataframe's TARGET
 * record. It depends on the installation for ONTOLOGY DEFINITIONS ONLY (dd1706 /
 * dd1715 / dd490, which ship in the seed) — never on any record the install
 * happens to hold.
 *
 * It used to depend on both, and both bit:
 *   - it provisioned tipo `test218`, which the shipped seed LATER defined as a real
 *     component_date — and its revert DELETED that node from the database;
 *   - it read `dd1706/121 'Zenon'`, a record of the old shared dev DB. A fresh
 *     install carries the dd1706 ontology but no dd1706 records, so the gate could
 *     never pass on one.
 * Both are gone: the frame node is a free scratch tipo, and the target record is a
 * scratch coordinate this gate creates itself. Preconditions refuse to run if either
 * coordinate is already taken, so a future ontology/seed can never be eaten again.
 *
 * The list-read projection (the differential's exact `comparable` field set) is
 * DEEP-EQUAL against a GOLDEN captured from the LIVE PHP ORACLE (2026-07-10 UTC,
 * scratchpad capture_dec14b_p1.ts — the capture run verified TS === PHP on the
 * comparable projection, WC-001 entries:[] adopted on the PHP side only).
 * Goldens live in fixtures/has_dataframe_native/; NEVER regenerate them from
 * TS output — recapture from the PHP oracle with the same seeds. The 2026-07-13
 * edit renamed IDENTIFIERS ONLY (frame tipo, target section_id) consistently in the
 * seeds and the golden; every oracle-verified value and the projection shape are
 * byte-identical to the capture (see the golden's `_provenance`).
 *
 * Oracle-pinned semantics frozen here: the frame item precedes the literal
 * (frame mode 'list' — the generic default, unlike dd560's node-declared
 * 'edit'), the frame carries its own sqo_config limit (5), and the literal
 * item carries counter (data.counters[tipo] ?? 0).
 *
 * Scratch id: test3/900311 in matrix_test — the reserved-high (900000+)
 * range, clear of the canonical ids (1/2/27), of createSectionRecord scratch
 * (counter ≤ double digits) and of the sibling gates' 9003xx twins (900312
 * iri / 900313 info_widget). Direct INSERT (no counter bump) so the golden
 * pins section_id byte-stable.
 *
 * @twin-of      test/parity/has_dataframe_literal_differential.test.ts
 * @twin-status  retired
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { assertMatrixTable } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	resolveDataframeSlotTipos,
	resolveSectionSlotTipos,
} from '../../src/core/relations/dataframe_slots.ts';
import { readSection } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertExportDeclarationReadable } from '../../src/diffusion/export/grid.ts';
import { exportGridUnified } from '../../src/diffusion/export/index.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { exportFrontierIdentity } from '../helpers/export_frontier_identity.ts';
import golden from './fixtures/has_dataframe_native/list_items.golden.json';

/**
 * The scratch frame node this gate provisions and reverts.
 *
 * It used to be `test218` — chosen when that was simply the next free number. The shipped
 * install seed has SINCE grown a real `test218` (component_date, date_mode:period, under
 * test45) and a `test219` (date_range). The gate then:
 *   - INSERTed ... ON CONFLICT DO NOTHING → silently no-op'd against the real node,
 *   - compared a date component against a dataframe golden, and
 *   - in afterAll ran `DELETE FROM dd_ontology WHERE tipo='test218' AND tld='test'`,
 *     DELETING the seeded period-date component from the database.
 * A full `bun test` on a fresh install destroyed shipped ontology. (The tipo is a pure
 * identifier — see the golden's provenance — so it was renamed here and in the frozen
 * golden together; nothing captured from the oracle changed shape.)
 *
 * 900+ is far above the seeded test TLD (highest: 219). The precondition in
 * provisionFixture() is what actually keeps this honest: if the ontology ever grows into
 * this number, the gate FAILS LOUDLY instead of eating the node.
 */
const FRAME_TIPO = 'test900';
const MAIN_TIPO = 'test52';
const RECORD_ID = 900311;

/**
 * The dataframe's TARGET — the record the frame resolves to. This gate CREATES it.
 *
 * dd1706 (section) / dd1715 (component_input_text, non-translatable → `string` column at
 * lg-nolan) / dd490 (relation_type) are ONTOLOGY, and ontology ships in the install seed.
 * The RECORD does not: the golden's original dd1706/121 was a row of the old shared dev DB,
 * so the gate could not pass on a fresh install. We therefore mint our own row at a
 * reserved-high id, in the same 900000+ scratch range as RECORD_ID, and delete it after.
 * 'Zenon' is the value the oracle capture resolved, kept verbatim so the golden's
 * oracle-verified entries stay byte-identical.
 */
const TARGET_SECTION_TIPO = 'dd1706';
const TARGET_ID = 900121; // was 121, a record of the shared dev DB — see the header
const TARGET_LABEL_TIPO = 'dd1715';
const TARGET_LABEL_VALUE = 'Zenon';

let tsItems: Record<string, unknown>[] = [];
/** MAIN_TIPO's properties BEFORE we touched them — restored verbatim on revert. */
let mainPropertiesBefore: string | null = null;
/** The matrix table dd1706 resolves to (matrix_list) — resolved, never hardcoded. */
let targetTable = '';
/**
 * Did WE create these? Revert must undo only what this run made.
 *
 * Not paranoia — the first draft of this very fix set `targetTable` before the
 * occupied-coordinate check threw, so the revert would have DELETED a pre-existing
 * record it refused to touch. "I know what was there" is the assumption that ate
 * test218; the only safe revert is one that undoes what it can PROVE it did.
 */
let frameCreated = false;
let targetCreated = false;
let mainModified = false;

/** The differential's exact comparable projection — the live-verified contract. */
function comparable(item: Record<string, unknown>): Record<string, unknown> {
	return {
		tipo: item.tipo,
		section_tipo: item.section_tipo,
		section_id: item.section_id,
		mode: item.mode,
		lang: item.lang,
		from_component_tipo: item.from_component_tipo ?? null,
		entries: item.entries ?? null,
		pagination: item.pagination ?? null,
		counter: item.counter ?? null,
		row_section_id: item.row_section_id ?? null,
		parent_tipo: item.parent_tipo ?? null,
	};
}

async function provisionFixture(): Promise<void> {
	// PRECONDITION 1 (checked FIRST — it is the destructive one): never squat on a node the
	// ontology actually owns. `ON CONFLICT DO NOTHING` used to hide exactly that: the insert
	// quietly did nothing and the revert then deleted someone else's component. A scratch
	// tipo that is no longer free is a fixture bug, and it must STOP the run rather than
	// mutate real ontology.
	const squatted = await sql.unsafe('SELECT model FROM dd_ontology WHERE tipo = $1', [FRAME_TIPO]);
	if (squatted.length > 0) {
		throw new Error(
			`has_dataframe gate: '${FRAME_TIPO}' is a REAL ontology node (model '${(squatted[0] as { model: string }).model}') — this gate provisions and then DELETES that tipo, so running it would destroy shipped ontology. Move FRAME_TIPO to a free scratch tipo (and rename it in fixtures/has_dataframe_native/list_items.golden.json, where it appears only as an identifier). This is exactly how test218 was eaten.`,
		);
	}

	// PRECONDITION 2: the TARGET coordinate must be free — we are about to CREATE it. The
	// gate used to READ dd1706/121, a record of the old shared dev DB, so it could never
	// pass on a fresh install (the seed ships the dd1706 ontology, not its records). Now we
	// mint the row ourselves. Same rule as the tipo: if the coordinate is taken, stop —
	// never write over, and never delete, a record this gate did not create.
	const table = await getMatrixTableFromTipo(TARGET_SECTION_TIPO);
	if (table === null) {
		throw new Error(`has_dataframe gate: no matrix table for '${TARGET_SECTION_TIPO}'`);
	}
	assertMatrixTable(table); // identifier allowlist (spec §7.6) — it throws, it does not map
	targetTable = table;
	const occupied = await sql.unsafe(
		`SELECT section_id FROM ${targetTable} WHERE section_tipo = $1 AND section_id = $2`,
		[TARGET_SECTION_TIPO, TARGET_ID],
	);
	if (occupied.length > 0) {
		throw new Error(
			`has_dataframe gate: ${TARGET_SECTION_TIPO}/${TARGET_ID} already exists — this gate creates and then DELETES that record, so it will not touch one it did not make. Move TARGET_ID to a free reserved-high id (and rename it in the golden, where it appears only as an identifier).`,
		);
	}
	// The target row: dd1715 is a non-translatable component_input_text, so its value lives
	// in the `string` column at lg-nolan — exactly the entries the golden pins.
	await sql.unsafe(
		`INSERT INTO ${targetTable} (section_id, section_tipo, string)
		 VALUES ($1, $2, jsonb_build_object($3::text, $4::text::jsonb))`,
		[
			TARGET_ID,
			TARGET_SECTION_TIPO,
			TARGET_LABEL_TIPO,
			JSON.stringify([{ id: 1, lang: 'lg-nolan', value: TARGET_LABEL_VALUE }]),
		],
	);
	targetCreated = true;

	// Snapshot MAIN_TIPO's properties so revert RESTORES them. The old revert hard-coded
	// `properties = NULL`, which is only correct while the seed happens to leave test52
	// empty: the moment it ships properties, this gate would silently wipe them.
	const priorMain = (await sql.unsafe('SELECT properties FROM dd_ontology WHERE tipo = $1', [
		MAIN_TIPO,
	])) as { properties: unknown }[];
	const priorValue = priorMain[0]?.properties ?? null;
	mainPropertiesBefore =
		priorValue === null || priorValue === undefined
			? null
			: typeof priorValue === 'string'
				? priorValue
				: JSON.stringify(priorValue);

	const frameProperties = {
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ value: ['dd1706'], source: 'section' }] },
					show: {
						ddo_map: [{ tipo: 'dd1715', parent: 'self', section_tipo: 'self' }],
						sqo_config: { limit: 5 },
					},
				},
			],
		},
	};
	// No ON CONFLICT clause: the precondition above proved the tipo is free, so a conflict
	// here is a real error and must surface, not be swallowed.
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, parent, model, term, tld, is_model, is_translatable, is_main, order_number, properties)
		 VALUES ($1, $2, 'component_dataframe', '{"lg-spa":"Test frame"}'::jsonb, 'test', false, false, false, 99, $3::text::jsonb)`,
		[FRAME_TIPO, MAIN_TIPO, JSON.stringify(frameProperties)],
	);
	frameCreated = true;
	const mainProperties = {
		has_dataframe: true,
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ value: ['dd1706'], source: 'section' }] },
					show: { ddo_map: [{ tipo: FRAME_TIPO, parent: 'self', section_tipo: 'test3' }] },
				},
			],
		},
	};
	await sql.unsafe('UPDATE dd_ontology SET properties = $2::text::jsonb WHERE tipo = $1', [
		MAIN_TIPO,
		JSON.stringify(mainProperties),
	]);
	mainModified = true;
}

/**
 * Revert by RESTORING what was there, never by asserting what we think was there.
 *
 * The old version deleted FRAME_TIPO unconditionally and hard-set MAIN_TIPO's properties to
 * NULL. Both are "reverts by assumption": true only while the ontology happens to match the
 * gate's memory of it. When the seed grew a real test218, the first line deleted it.
 *
 * The DELETE is safe now only because provisionFixture() PROVED the tipo was free before
 * creating it — the guarantee comes from the precondition, not from the DELETE.
 */
async function revertFixture(): Promise<void> {
	// The target record we minted (only ours: provisionFixture proved the coordinate was
	// free before creating it, and refuses to run otherwise).
	if (targetCreated && targetTable !== '') {
		await sql.unsafe(`DELETE FROM ${targetTable} WHERE section_tipo = $1 AND section_id = $2`, [
			TARGET_SECTION_TIPO,
			TARGET_ID,
		]);
		targetCreated = false;
	}
	if (frameCreated) {
		await sql.unsafe(
			`DELETE FROM dd_ontology WHERE tipo = $1 AND tld = 'test' AND model = 'component_dataframe'`,
			[FRAME_TIPO],
		);
		frameCreated = false;
	}
	if (mainModified) {
		await sql.unsafe('UPDATE dd_ontology SET properties = $2::text::jsonb WHERE tipo = $1', [
			MAIN_TIPO,
			mainPropertiesBefore,
		]);
		mainModified = false;
	}
}

/** TS ontology caches must not serve pre-fixture (or post-revert: fixture) state. */
async function clearOntologyLayerCaches(): Promise<void> {
	const { clearOntologyCaches } = await import('../../src/core/ontology/resolver.ts');
	clearOntologyCaches();
	const { clearListCellConfigCache } = await import(
		'../../src/core/section/list_definitions/section_list.ts'
	);
	clearListCellConfigCache();
}

async function sweepRecord(): Promise<number> {
	const deleted = (await sql.unsafe(
		`DELETE FROM matrix_test WHERE section_tipo = 'test3' AND section_id = $1 RETURNING id`,
		[RECORD_ID],
	)) as unknown[];
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo = 'test3' AND section_id = $1`,
		[RECORD_ID],
	);
	return deleted.length;
}

beforeAll(async () => {
	await sweepRecord(); // pre-clean a crashed prior run
	await provisionFixture();
	await clearOntologyLayerCaches();

	const value = [{ id: 1, lang: 'lg-nolan', value: 'FRAME_LITERAL_NATIVE' }];
	const frameBag = [
		{
			id: 1,
			type: 'dd490',
			id_key: 1,
			section_id: String(TARGET_ID),
			section_tipo: TARGET_SECTION_TIPO,
			from_component_tipo: FRAME_TIPO,
			main_component_tipo: MAIN_TIPO,
		},
	];
	await sql.unsafe(
		`INSERT INTO matrix_test (section_id, section_tipo, string, relation)
		 VALUES ($1, 'test3', jsonb_build_object($2::text, $3::text::jsonb), jsonb_build_object($4::text, $5::text::jsonb))`,
		[RECORD_ID, MAIN_TIPO, JSON.stringify(value), FRAME_TIPO, JSON.stringify(frameBag)],
	);

	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: 'test3',
			section_tipo: 'test3',
			action: 'search',
			mode: 'list',
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: ['test3'],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: 'test3', section_id: String(RECORD_ID) }],
		},
		show: {
			ddo_map: [{ tipo: MAIN_TIPO, section_tipo: 'test3', parent: 'test3', mode: 'list' }],
		},
	};

	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);
	tsItems = (
		(
			(
				await dispatchRqo(
					structuredClone(rqo) as never,
					{
						requestId: 't',
						clientIp: '127.0.0.1',
						session,
						csrfCandidate: session?.csrfToken ?? null,
						principal,
					} as never,
				)
			).body as { data?: { data?: unknown[] } }
		).data?.data ?? []
	).slice(1) as Record<string, unknown>[];
}, 60000);

afterAll(async () => {
	await revertFixture();
	await clearOntologyLayerCaches();
	// A seeded scratch row that deletes NOTHING means the fixed id collided or
	// something swept it mid-run — fail loudly rather than mask it.
	if ((await sweepRecord()) === 0) {
		throw new Error(
			`Scratch cleanup deleted 0 rows for test3/${RECORD_ID} (matrix_test) — the seed vanished mid-run.`,
		);
	}
});

describe('generic has_dataframe literal read (TS-native, oracle-captured golden)', () => {
	test('frame + label child + literal (with counter) DEEP-EQUAL the golden, in order', () => {
		// Fixture integrity floors — the semantics the differential pinned must
		// be IN the golden (guards a truncated/regenerated fixture; the engine
		// assertion is the deep-equal below).
		const items = golden.items as Record<string, unknown>[];
		expect(items.map((item) => item.tipo)).toEqual([FRAME_TIPO, 'dd1715', MAIN_TIPO]);
		expect(items[0]?.mode).toBe('list'); // generic frame default (not dd560's 'edit')
		expect((items[0]?.pagination as { limit?: unknown })?.limit).toBe(5); // frame sqo_config limit
		expect(items[2]?.counter).toBe(0); // literal carries counter (counters[tipo] ?? 0)
		expect(JSON.stringify(items[0]?.entries)).toContain('"type":"dd490"');

		expect(tsItems.map(comparable)).toEqual(items as never);
	});
});

describe('a LITERAL main honours its declared ddo mode, exactly like a RELATION main', () => {
	/**
	 * ONE component, ONE ontology contract. `component_dataframe` must behave
	 * identically whichever kind of main it hangs off — an author should not
	 * have to know that a relation main reads the frame's `mode` from the ddo
	 * while a literal main reads it from the slot NODE.
	 *
	 * It used to: this path passed a SYNTHETIC ddo `{tipo, section_tipo}` and
	 * took the mode from `resolveFrameConfig(...).nodeMode ?? 'list'`, so a ddo
	 * declaring `"mode":"edit"` was silently dropped on a literal. Found live
	 * on `oh16`/`oh130` (2026-07-31): the author copied a slot config from a
	 * RELATION main (`numisdata1447`, which legitimately carries no node mode),
	 * the frame resolved to `list`, and `list` + `view:"line"` resolves to
	 * `dataframe_line` — a view that does not exist — so nothing rendered at
	 * all while the server looked correct.
	 *
	 * The golden above pins the FALLBACK (its ddo declares no mode → node mode
	 * → 'list'), which is what keeps this change purely additive. This pins the
	 * other half: a DECLARED ddo mode wins.
	 */
	const readFrameMode = async (): Promise<unknown> => {
		const { readSection } = await import('../../src/core/section/read.ts');
		const result = await readSection({
			dd_api: 'dd_core_api',
			action: 'read',
			source: {
				tipo: 'test3',
				section_tipo: 'test3',
				model: 'section',
				mode: 'list',
				lang: 'lg-spa',
			},
			sqo: {
				section_tipo: ['test3'],
				limit: 1,
				offset: 0,
				filter_by_locators: [{ section_tipo: 'test3', section_id: String(RECORD_ID) }],
			},
			show: {
				ddo_map: [{ tipo: MAIN_TIPO, section_tipo: 'test3', parent: 'test3', mode: 'list' }],
			},
		} as never);
		const frame = ((result.data ?? []) as Record<string, unknown>[]).find(
			(item) => item.tipo === FRAME_TIPO,
		);
		return frame?.mode;
	};

	/** Rewrite MAIN_TIPO's slot ddo, keeping everything else the fixture set. */
	const setDeclaredMode = async (mode: string | undefined): Promise<void> => {
		await sql.unsafe('UPDATE dd_ontology SET properties = $2::text::jsonb WHERE tipo = $1', [
			MAIN_TIPO,
			JSON.stringify({
				has_dataframe: true,
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: ['dd1706'], source: 'section' }] },
							show: {
								ddo_map: [
									mode === undefined
										? { tipo: FRAME_TIPO, parent: 'self', section_tipo: 'test3' }
										: { tipo: FRAME_TIPO, parent: 'self', section_tipo: 'test3', mode },
								],
							},
						},
					],
				},
			}),
		]);
		await clearOntologyLayerCaches();
	};

	afterAll(async () => {
		// Restore the fixture's own ddo (no declared mode) so the golden test
		// above keeps describing what the file provisions, whatever order the
		// runner picks. revertFixture() in the file-level afterAll then puts the
		// node's ORIGINAL properties back.
		await setDeclaredMode(undefined);
	});

	test('a declared "edit" on the ddo reaches the frame item (was silently dropped)', async () => {
		await setDeclaredMode('edit');
		expect(await readFrameMode()).toBe('edit');
	});

	test('an undeclared mode still falls back to the node/list default', async () => {
		await setDeclaredMode(undefined);
		// test900 carries no node-level `mode`, so this is the 'list' default —
		// the exact behaviour the frozen golden above pins.
		expect(await readFrameMode()).toBe('list');
	});
});

// ---------------------------------------------------------------------------
// T2-SL-6 — ONE SLOT SET, EVERY DOOR.
//
// A main's dataframe slots are DECLARED in three places (dataframe_slots.ts
// resolveDataframeSlotTipos): its ontology children of model
// component_dataframe, the ddos of its OWN request_config (show and hide), and
// its model's fixed frames. The save cascade and the Time Machine already
// answered that set; the READ of a literal walked ontology children only, and
// the raw export likewise — so a slot a literal declares in its config (the
// node sits beside it, not under it) was stripped by a remove and restored by
// the Time Machine, yet never shown and never exported.
//
// SITUATION `zzdfs` (scratch section on test1 → matrix_test), built and dropped:
//   LIT    input_text, has_dataframe, own config naming SIBLING
//   CHILD  component_dataframe under LIT            (declared: ontology child)
//   SIBLING component_dataframe under the SECTION   (declared: LIT's own config)
//   INJECTED component_dataframe under the SECTION  (declared NOWHERE: a caller
//            names it as LIT's child in its own ddo_map)
//   PLAIN  input_text WITHOUT has_dataframe (the flag law's control)
// ---------------------------------------------------------------------------

const ZTLD = 'zzdfs';
const ZSECTION = `${ZTLD}1`;
const LIT = `${ZTLD}2`;
const CHILD = `${ZTLD}3`;
const SIBLING = `${ZTLD}4`;
const INJECTED = `${ZTLD}5`;
const PLAIN = `${ZTLD}6`;
const ZTABLE = 'matrix_test';

const SLOT_SITUATION = situation({
	tld: ZTLD,
	name: 'dataframe_slot_set',
	nodes: [
		{ tipo: ZSECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Slot set' } },
		{
			tipo: LIT,
			parent: ZSECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Literal' },
			properties: {
				has_dataframe: true,
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [ZSECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: SIBLING, parent: 'self', section_tipo: ZSECTION }] },
						},
					],
				},
			},
		},
		{ tipo: CHILD, parent: LIT, model: 'component_dataframe', term: { 'lg-eng': 'Child' } },
		{ tipo: SIBLING, parent: ZSECTION, model: 'component_dataframe', term: { 'lg-eng': 'Sib' } },
		{ tipo: INJECTED, parent: ZSECTION, model: 'component_dataframe', term: { 'lg-eng': 'Inj' } },
		{ tipo: PLAIN, parent: ZSECTION, model: 'component_input_text', term: { 'lg-eng': 'Plain' } },
	],
});

type ZItem = Record<string, unknown>;

const zFrame = (slot: string, main: string, target: number): ZItem => ({
	id: 1,
	type: 'dd490',
	id_key: 1,
	section_tipo: ZSECTION,
	section_id: target,
	from_component_tipo: slot,
	main_component_tipo: main,
});

/** A record holding `main` = one item (id 1) and one frame of it in every given slot. */
async function zRecord(main: string, slots: readonly string[]): Promise<number> {
	const id = await createSectionRecord(ZSECTION, -1);
	const target = await createSectionRecord(ZSECTION, -1);
	await sql.unsafe(
		`UPDATE "${ZTABLE}" SET string = COALESCE(string, '{}'::jsonb) || $3::text::jsonb,
		        relation = COALESCE(relation, '{}'::jsonb) || $4::text::jsonb
		  WHERE section_tipo = $1 AND section_id = $2`,
		[
			ZSECTION,
			id,
			JSON.stringify({ [main]: [{ id: 1, lang: 'lg-nolan', value: 'held' }] }),
			JSON.stringify(Object.fromEntries(slots.map((slot) => [slot, [zFrame(slot, main, target)]]))),
		],
	);
	return id;
}

/** The items of an EDIT read of one record (its own config, or the caller's map). */
async function readItems(id: number, ddoMap?: ZItem[]): Promise<ZItem[]> {
	const { data } = await readSection({
		action: 'read',
		source: { tipo: ZSECTION, section_tipo: ZSECTION, mode: 'edit', lang: 'lg-eng' },
		sqo: {
			section_tipo: [ZSECTION],
			filter_by_locators: [{ section_tipo: ZSECTION, section_id: String(id) }],
			limit: 1,
			offset: 0,
		},
		...(ddoMap === undefined ? {} : { show: { ddo_map: ddoMap } }),
	} as never);
	return data as ZItem[];
}

/** The slot tipos whose frame item an EDIT read of the record emits WITH the stored frame. */
async function readSlots(id: number, ddoMap?: ZItem[]): Promise<string[]> {
	return (await readItems(id, ddoMap))
		.filter(
			(item) =>
				Number(item.section_id) === id &&
				Number(item.id_key) === 1 &&
				Array.isArray(item.entries) &&
				item.entries.length === 1,
		)
		.map((item) => String(item.tipo))
		.sort();
}

/** The situation's dataframe slots that hold at least one frame on the record. */
async function zRelationKeys(id: number): Promise<string[]> {
	const rows = (await sql.unsafe(
		`SELECT relation FROM "${ZTABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[ZSECTION, id],
	)) as { relation: Record<string, unknown[]> | null }[];
	return Object.entries(rows[0]?.relation ?? {})
		.filter(
			([key, value]) =>
				[CHILD, SIBLING, INJECTED].includes(key) && Array.isArray(value) && value.length > 0,
		)
		.map(([key]) => key)
		.sort();
}

describe('T2-SL-6: a literal reads the ONE declared slot set (+ a caller-injected frame)', () => {
	beforeAll(async () => {
		await ensureSituation(SLOT_SITUATION);
		expect(await getMatrixTableFromTipo(ZSECTION)).toBe(ZTABLE);
	}, 60_000);

	afterAll(async () => {
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [ZSECTION]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [ZSECTION]);
		await sql.unsafe(`DELETE FROM "${ZTABLE}" WHERE section_tipo = $1`, [ZSECTION]);
		await sql.unsafe(`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1`, [ZSECTION]);
		expect(await dropSituation(SLOT_SITUATION)).toBe(0);
	}, 60_000);

	test('the declared set is the ontology child AND the sibling the own config names', async () => {
		expect((await resolveDataframeSlotTipos(LIT)).sort()).toEqual([CHILD, SIBLING]);
	});

	test('a SIBLING-declared slot is emitted with its frame, like the child slot', async () => {
		const id = await zRecord(LIT, [CHILD, SIBLING]);
		expect(await readSlots(id)).toEqual([CHILD, SIBLING]);
	}, 30_000);

	test('a CALLER-INJECTED frame child is emitted too — beside the declared slots', async () => {
		const id = await zRecord(LIT, [CHILD, SIBLING, INJECTED]);
		const callerMap = [
			{ tipo: LIT, section_tipo: ZSECTION, parent: ZSECTION, mode: 'edit' },
			{ tipo: INJECTED, section_tipo: ZSECTION, parent: LIT },
		];
		expect(await readSlots(id, callerMap)).toEqual([CHILD, SIBLING, INJECTED]);
		// Only a component_dataframe child is a frame: a caller line naming any
		// other component under the literal pairs nothing with its items.
		const withPlainChild = await readItems(id, [
			...callerMap,
			{ tipo: PLAIN, section_tipo: ZSECTION, parent: LIT },
		]);
		expect(withPlainChild.filter((item) => item.main_component_tipo === LIT)).toHaveLength(3);
		expect(
			withPlainChild.filter((item) => item.tipo === PLAIN && item.id_key !== undefined),
		).toEqual([]);
		// not declared, not injected: the read does not go looking for it
		expect(await readSlots(id)).toEqual([CHILD, SIBLING]);
	}, 30_000);

	test('the flag law holds: a literal WITHOUT has_dataframe emits no frame, injected or not', async () => {
		const id = await zRecord(PLAIN, [INJECTED]);
		const callerMap = [
			{ tipo: PLAIN, section_tipo: ZSECTION, parent: ZSECTION, mode: 'edit' },
			{ tipo: INJECTED, section_tipo: ZSECTION, parent: PLAIN },
		];
		expect(await readSlots(id, callerMap)).toEqual([]);
	}, 30_000);

	test('CROSS-DOOR: read, save cascade, Time Machine restore and raw export answer the SAME slot set', async () => {
		const declared = (await resolveDataframeSlotTipos(LIT)).sort();
		expect(declared).toHaveLength(2); // floor: an empty set would agree with anything

		// READ
		const id = await zRecord(LIT, declared);
		expect(await readSlots(id)).toEqual(declared);

		// EXPORT (dedalo_raw): one column per slot, beside the main's.
		const exported = await exportGridUnified({
			principal: await resolvePrincipal(-1),
			userId: -1,
			background: false,
			options: {
				section_tipo: ZSECTION,
				model: 'section',
				data_format: 'dedalo_raw',
				breakdown: 'default',
				fill_the_gaps: false,
				lang: 'lg-eng',
				ar_ddo_to_export: [{ path: [{ section_tipo: ZSECTION, component_tipo: LIT, name: LIT }] }],
				sqo: {
					section_tipo: [ZSECTION],
					offset: 0,
					filter_by_locators: [{ section_tipo: ZSECTION, section_id: String(id) }],
				},
			},
		} as never);
		const exportedSlots = [CHILD, SIBLING, INJECTED]
			.filter((slot) => JSON.stringify(exported).includes(`${ZSECTION}_${slot}`))
			.sort();
		// The export's column set is ONE per run: the declared slots ∪ every slot
		// a record of the section holds LIT's frames in (B3 review M3 — the
		// caller-injected test above left frames in INJECTED, so it is a column,
		// empty for this record).
		const sectionSlots = (await resolveSectionSlotTipos(ZSECTION, LIT)).sort();
		expect(sectionSlots).toEqual(expect.arrayContaining(declared));
		expect(exportedSlots).toEqual(sectionSlots);

		// SAVE: removing the item strips its frame from every slot of the set.
		const mark = (
			(await sql.unsafe('SELECT COALESCE(MAX(id), 0) AS m FROM matrix_time_machine')) as {
				m: number;
			}[]
		)[0]?.m;
		const removed = await saveComponentData({
			componentTipo: LIT,
			sectionTipo: ZSECTION,
			sectionId: id,
			lang: 'lg-nolan',
			changedData: [{ action: 'remove', id: 1, value: null }],
			userId: -1,
		});
		expect(removed.ok).toBe(true);
		expect(await zRelationKeys(id)).toEqual([]);
		// (control of the cascade's reach: an identical record keeps its frames)
		expect(await zRelationKeys(await zRecord(LIT, declared))).toEqual(declared);

		// TIME MACHINE: restoring the state before the remove puts a frame back
		// in every slot of the set (the baseline row the remove recorded first).
		const rows = (await sql.unsafe(
			`SELECT id, data FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id > $4 AND tm_role IS NULL
			  ORDER BY id ASC`,
			[ZSECTION, id, LIT, Number(mark)],
		)) as { id: number; data: unknown }[];
		const before = rows.find(
			(row) => Array.isArray(row.data) && (row.data as ZItem[]).some((e) => e.type === 'dd490'),
		);
		expect(before).toBeDefined();
		const restored = await toolTimeMachineApplyValue({
			principal: await resolvePrincipal(-1),
			userId: -1,
			background: false,
			options: {
				section_tipo: ZSECTION,
				section_id: id,
				tipo: LIT,
				lang: 'lg-nolan',
				matrix_id: before?.id,
			},
		} as never);
		expect(restored.ok).toBe(true);
		expect(await zRelationKeys(id)).toEqual(declared);
	}, 60_000);

	test('CROSS-DOOR, INJECTED (B3 review M3, owner ruling 2026-11-21): a caller-injected slot is in the SAME set for read, remove cascade, Time Machine and raw export', async () => {
		// INJECTED is declared NOWHERE: a caller names it as LIT's child, the
		// client then saves frames into it paired with LIT's items. Ruled: those
		// frames are LIT's like a declared slot's — no door may orphan them.
		const all = [CHILD, SIBLING, INJECTED].sort();
		const id = await zRecord(LIT, all);
		const callerMap = [
			{ tipo: LIT, section_tipo: ZSECTION, parent: ZSECTION, mode: 'edit' },
			{ tipo: INJECTED, section_tipo: ZSECTION, parent: LIT },
		];

		// READ (the caller's map names the slot)
		expect(await readSlots(id, callerMap)).toEqual(all);

		// EXPORT (dedalo_raw): a column for the injected slot too, holding its frame.
		const exported = JSON.stringify(
			await exportGridUnified({
				principal: await resolvePrincipal(-1),
				userId: -1,
				background: false,
				options: {
					section_tipo: ZSECTION,
					model: 'section',
					data_format: 'dedalo_raw',
					breakdown: 'default',
					fill_the_gaps: false,
					lang: 'lg-eng',
					ar_ddo_to_export: [
						{ path: [{ section_tipo: ZSECTION, component_tipo: LIT, name: LIT }] },
					],
					sqo: {
						section_tipo: [ZSECTION],
						offset: 0,
						filter_by_locators: [{ section_tipo: ZSECTION, section_id: String(id) }],
					},
				},
			} as never),
		);
		expect(all.filter((slot) => exported.includes(`${ZSECTION}_${slot}`))).toEqual(all);
		expect(exported).toContain(`\\"from_component_tipo\\":\\"${INJECTED}\\"`);

		// SAVE: removing the item strips its frame from the injected slot too.
		const mark = (
			(await sql.unsafe('SELECT COALESCE(MAX(id), 0) AS m FROM matrix_time_machine')) as {
				m: number;
			}[]
		)[0]?.m;
		const removed = await saveComponentData({
			componentTipo: LIT,
			sectionTipo: ZSECTION,
			sectionId: id,
			lang: 'lg-nolan',
			changedData: [{ action: 'remove', id: 1, value: null }],
			userId: -1,
		});
		expect(removed.ok).toBe(true);
		expect(await zRelationKeys(id)).toEqual([]);

		// TIME MACHINE: the baseline row carries the injected slot's frame, and
		// restoring it puts every slot back.
		const rows = (await sql.unsafe(
			`SELECT id, data FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id > $4 AND tm_role IS NULL
			  ORDER BY id ASC`,
			[ZSECTION, id, LIT, Number(mark)],
		)) as { id: number; data: unknown }[];
		const before = rows.find(
			(row) => Array.isArray(row.data) && (row.data as ZItem[]).some((e) => e.type === 'dd490'),
		);
		expect(
			((before?.data ?? []) as ZItem[])
				.filter((entry) => entry.type === 'dd490')
				.map((entry) => String(entry.from_component_tipo))
				.sort(),
		).toEqual(all);
		const restored = await toolTimeMachineApplyValue({
			principal: await resolvePrincipal(-1),
			userId: -1,
			background: false,
			options: {
				section_tipo: ZSECTION,
				section_id: id,
				tipo: LIT,
				lang: 'lg-nolan',
				matrix_id: before?.id,
			},
		} as never);
		expect(restored.ok).toBe(true);
		expect(await zRelationKeys(id)).toEqual(all);

		// THE DECLARATION GATE asks the SAME set: a non-admin who may read the main
		// and its declared slots but not the injected one is refused the run (the
		// frames would ride along as a column), and served once granted.
		const identity = exportFrontierIdentity('has_dataframe_injected_export', 935700);
		const granted = [ZSECTION, LIT, CHILD, SIBLING].map((tipo) => ({
			sectionTipo: ZSECTION,
			tipo,
			level: 1,
		}));
		const rawOptions = {
			section_tipo: ZSECTION,
			data_format: 'dedalo_raw',
			ar_ddo_to_export: [{ path: [{ section_tipo: ZSECTION, component_tipo: LIT, name: LIT }] }],
			sqo: { section_tipo: [ZSECTION] },
		};
		try {
			await identity.install(granted, []);
			let refusal: unknown = null;
			try {
				await assertExportDeclarationReadable(identity.scoped, rawOptions, { noteRefusals: false });
			} catch (error) {
				refusal = error;
			}
			expect((refusal as { code?: unknown } | null)?.code).toBe('perm.denied');
			expect(String(refusal)).toContain(INJECTED);
			await identity.setScopedGrants([
				...granted,
				{ sectionTipo: ZSECTION, tipo: INJECTED, level: 1 },
			]);
			await assertExportDeclarationReadable(identity.scoped, rawOptions, { noteRefusals: false });
		} finally {
			await identity.remove(false);
		}
	}, 60_000);
});
