/**
 * CRAP item 2.23a — `get_widget_data` (api/handlers/dd_component_info.ts:32),
 * the single-widget ASYNC compute channel of component_info.
 *
 * DEC-14b ORPHAN: the only gate this action had was
 * test/parity/info_widget_differential.test.ts's `describe.if(hasLivePhpOracle())`,
 * permanently FALSE post-cutover (the frozen fixture store never satisfies it),
 * and no `*_native` twin was ever written — so the action shipped with ZERO
 * executed coverage. It is also absent from engineering/ORACLE_HARVEST.md's
 * retired-differential twin map (reported, NOT edited here).
 *
 * Branch inventory of the handler, in execution order — one case each:
 *  1. requirePrincipal   — throws without a seeded principal;
 *  2. the READ DOOR (write_door.authorizeRecordAccess read mode, STRICTER than
 *     PHP which had no gate — WC-2026-11-10-widget-data-read-door): a profile-
 *     less non-admin ⇒ perm.denied (the section floor, its first refusal);
 *     the same record + the superuser proceeds; a non-positive section_id
 *     reaches the record-scope step for the superuser too ⇒ perm.out_of_scope.
 *     The PAIRED reader/control proof of each half (section, info component,
 *     scope, non-address id) is test/unit/widget_data_read_door_native.test.ts;
 *  3. no `properties.widgets` (or no ontology node at all) ⇒ the PHP
 *     ' Empty defined widgets …' message — byte-exact, LEADING and TRAILING
 *     space included;
 *  4. widget_name not among the declared widgets (and the empty-string default
 *     when `options` is absent) ⇒ ' Empty widget_obj for widget <name>';
 *  5. thread-through: the ontology `ipo` block and the WidgetContext handed to
 *     the descriptor's computeData, proven by a SCRATCH descriptor whose
 *     compute ECHOES `(ipo, context)` (registry mock.module'd, real exports
 *     restored in afterEach per the mock-leak law). Asserting against
 *     `widgetComputeData(getInfoWidget(...))` instead would be a self-oracle:
 *     the function checked against its own dependency.
 *  6. success envelope — `{result:<items>, msg:'OK. Request done successfully',
 *     errors:[]}` with the REAL test_info widget, whose placeholder value
 *     re-proves sectionTipo/sectionId threading without any mock.
 *  7. MODE ROUTING — `source.mode` rides verbatim into the WidgetContext and
 *     the test6883 `descriptors` widget is its live consumer: 'edit' emits the
 *     `indexation` count + the `terms` grid, 'list' (and an ABSENT mode, the
 *     handler's :44 default) short-circuits to []
 *     (components/component_info/widgets/oh/descriptors.ts:23). That is the
 *     DEFERRED-LOAD contract the client's on-demand "Terms" button depends on:
 *     the list read stays deliberately cheap (no portal read + grid build per
 *     row) and the cell fetches its own terms through THIS channel, with
 *     mode:'edit'. A request that forgets the mode gets [] — pinned.
 *
 * This channel serves RAW widget items: no WC-026 `normalizeWidgetEntryKeys`
 * (that is the read-path emit hook), so items carry `widget_id` and NO `id` —
 * asserted, so a future dualisation cannot land unnoticed. The terms grid's
 * COLUMN set resolves against live reference data (dd_ontology section_map +
 * the test1026 target records, absent here), so it is pinned STRUCTURALLY; the byte
 * pin is the read-path golden's job (fixtures/info_widget_native/
 * entries.golden.json, cases.test6883 — untouched).
 *
 * Scratch surface (namespace: test3 ids 934000-934099): matrix_test test3/934000,
 * a component-less record, plus — in the SAME band but the DEFAULT `matrix`
 * table — the test6883 descriptors chain test6813/934010 (relation test6837 → the tape) and
 * rsc167/934011 (relation rsc860 → two descriptor locators), the same shape
 * test/unit/info_widget_native.test.ts seeds at 900311. All direct INSERTs (no
 * counter bump). Every row is swept in afterAll together with its
 * matrix_time_machine tail, fail-loud on residue AND on a sweep that deletes
 * nothing (a wrong-table DELETE leaks). No dd_ontology write anywhere.
 *
 * @twin-of      test/parity/info_widget_differential.test.ts
 * @twin-status  retired
 */
// Migrated to the generic `test` TLD 2026-08-19 (AGENTS.md hard rules): every
// install tipo was rewritten through src/core/test_data/test_tld_tipo_map.json;
// seed-shipped ontology (dd/rsc/hierarchy/lg) stays and is spelled through `seed()`,
// which keeps it out of the install-TLD census's `<tld><digits>` token grammar.

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { componentInfoApiActions } from '../../src/core/api/handlers/dd_component_info.ts';
import * as widget_registry from '../../src/core/components/component_info/widgets/registry.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { type Principal, SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import type { Session } from '../../src/core/security/session_store.ts';
import { mustGet } from '../helpers/assert.ts';

/** Snapshot of the REAL registry exports, taken BEFORE any mock.module —
 * mock.module is process-global and mock.restore() does not revert it. */
const REAL_REGISTRY = { ...widget_registry };
const REGISTRY_PATH = '../../src/core/components/component_info/widgets/registry.ts';

/** Seed-shipped ontology, spelled out of the install-TLD census's token grammar. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

const SECTION = 'test3'; // matrix_test
const SECTION_ID = 934000; // scratch band 934000-934099
const INFO_WITH_WIDGETS = 'test212'; // component_info, properties.widgets = [test_info]
const WIDGET_NAME = 'test_info';
const NO_WIDGETS_TIPO = 'test52'; // component_input_text — no properties.widgets
// getNode() → null. Tipo-SHAPED on purpose: since the read door the write
// door's grammar step refuses a malformed tipo (request.invalid) before any
// ontology lookup — pinned separately below — so the "no node" branch is only
// reachable with a well-formed tipo that names nothing.
const UNKNOWN_TIPO = 'zzt934000';
const MALFORMED_TIPO = 'zzt_no_such_tipo_934000';

// The test6883 descriptors chain: test6813 --test6837--> rsc167 --rsc860--> terms.
// The two ends sit in DIFFERENT matrix tables and that is the point of the hop:
// the `test` section carries the matrix_table relation test24 (matrix_test, the
// generic-TLD law), while the tape is the SEED-SHIPPED rsc167 the cloned
// ontology itself points test6837 at, which has no matrix_table relation and so
// resolves to the default `matrix`.
const OH_SECTION = 'test6813';
const OH_TABLE = 'matrix_test';
const OH_ID = 934010;
const TAPE_SECTION = seed('rsc', 167);
const TAPE_TABLE = 'matrix';
const TAPE_ID = 934011;
const INFO_OH = 'test6883'; // component_info, properties.widgets = [media_icons, descriptors]
const DESCRIPTORS_WIDGET = 'descriptors';
const MEDIA_ICONS_WIDGET = 'media_icons';

/** dd151 relation locator, the stored shape (info_widget_native.test.ts:110). */
const locatorOf = (sectionTipo: string, sectionId: number | string, from: string, id = 1) => ({
	id,
	type: 'dd151',
	section_id: String(sectionId),
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

// The SUPERUSER (-1), not a userId-1 global admin: since the read door
// (WC-2026-11-10-widget-data-read-door) a global admin is judged on its PROFILE's
// section + info-component grants like anyone else, and a fabricated userId 1
// has no profile in the suite DB. The superuser is the one identity the
// resolver grants everything, which is what these compute-branch cases need.
const ADMIN: Principal = { userId: SUPERUSER_ID, isGlobalAdmin: true, isDeveloper: true };
/** No user record, hence no projects: every non-admin record scope check fails. */
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

const contextFor = (principal: Principal): ApiRequestContext => ({
	requestId: 'crap-2-23a',
	clientIp: '127.0.0.1',
	session: {
		userId: principal.userId,
		username: `scratch_${principal.userId}`,
		isGlobalAdmin: principal.isGlobalAdmin,
		csrfToken: 'x',
		applicationLang: null,
		dataLang: null,
	} as Session,
	csrfCandidate: null,
	principal,
});

const contextWithoutPrincipal = (): ApiRequestContext => ({
	requestId: 'crap-2-23a',
	clientIp: '127.0.0.1',
	session: null,
	csrfCandidate: null,
});

const rqoOf = (source: unknown, options?: unknown): Rqo =>
	({ action: 'get_widget_data', dd_api: 'dd_component_info', source, options }) as unknown as Rqo;

const getWidgetData = mustGet(componentInfoApiActions.get_widget_data, 'get_widget_data handler');

/** Every seeded scratch row — exact (table, section_tipo, section_id). */
const SCRATCH_ROWS: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_test', sectionTipo: SECTION, sectionId: SECTION_ID },
	{ table: TAPE_TABLE, sectionTipo: TAPE_SECTION, sectionId: TAPE_ID },
	{ table: OH_TABLE, sectionTipo: OH_SECTION, sectionId: OH_ID },
];

const scratchKey = (row: { table: string; sectionTipo: string; sectionId: number }) =>
	`${row.sectionTipo}/${row.sectionId} (table ${row.table})`;

async function insertRow(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown> = {},
): Promise<void> {
	const names = Object.keys(columns);
	const columnSql = names.length > 0 ? `, ${names.join(', ')}` : '';
	// jsonb columns bind as $N::text::jsonb (the Bun.sql jsonb bind rule).
	const valueSql = names.map((_, index) => `, $${index + 3}::text::jsonb`).join('');
	await sql.unsafe(
		`INSERT INTO ${table} (section_id, section_tipo${columnSql}) VALUES ($1, $2${valueSql})`,
		[sectionId, sectionTipo, ...names.map((name) => JSON.stringify(columns[name]))],
	);
}

/** Remove every scratch row + its TM tail; returns the per-row deleted counts. */
async function purgeScratch(): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const row of SCRATCH_ROWS) {
		const deleted = (await sql.unsafe(
			`DELETE FROM ${row.table} WHERE section_tipo = $1 AND section_id = $2 RETURNING id`,
			[row.sectionTipo, row.sectionId],
		)) as unknown[];
		counts.set(scratchKey(row), deleted.length);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[row.sectionTipo, row.sectionId],
		);
	}
	return counts;
}

beforeAll(async () => {
	await purgeScratch(); // belt and braces: a crashed earlier run
	await insertRow('matrix_test', SECTION, SECTION_ID);
	// The descriptors chain: the tape holds TWO rsc860 descriptor locators
	// (indexation count 2, two grid rows) and the interview points at the tape
	// through test6837 — the hop whose result is the item `locator`.
	await insertRow(TAPE_TABLE, TAPE_SECTION, TAPE_ID, {
		relation: {
			[seed('rsc', 860)]: [
				locatorOf('test1026', 187, seed('rsc', 860)),
				locatorOf('test1026', 3, seed('rsc', 860), 2),
			],
		},
	});
	await insertRow(OH_TABLE, OH_SECTION, OH_ID, {
		relation: { test6837: [locatorOf(TAPE_SECTION, TAPE_ID, 'test6837')] },
	});
});

afterAll(async () => {
	// A seeded row that deletes NOTHING means the fixed id collided or the
	// DELETE hit the wrong matrix table — clean what we can, then fail loudly.
	const counts = await purgeScratch();
	const missing = [...counts.entries()].filter(([, count]) => count === 0).map(([key]) => key);
	const residue: string[] = [];
	for (const row of SCRATCH_ROWS) {
		const rows = (await sql.unsafe(
			`SELECT id FROM ${row.table} WHERE section_tipo = $1 AND section_id = $2`,
			[row.sectionTipo, row.sectionId],
		)) as unknown[];
		const tmRows = (await sql.unsafe(
			'SELECT id FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[row.sectionTipo, row.sectionId],
		)) as unknown[];
		if (rows.length > 0 || tmRows.length > 0) {
			residue.push(`${scratchKey(row)}: ${rows.length} row(s) + ${tmRows.length} TM row(s)`);
		}
	}
	if (missing.length > 0 || residue.length > 0) {
		throw new Error(
			`scratch sweep: deleted 0 rows for [${missing.join(', ')}]; residue [${residue.join('; ')}]`,
		);
	}
});

// Re-install the real registry after EVERY case (a leaked module mock reddens
// unrelated files later in the run — the documented bun gotcha).
afterEach(() => {
	mock.module(REGISTRY_PATH, () => REAL_REGISTRY);
});

/**
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md §4): a refusal is a THROWN registry
 * code — the handler builds no failure body, and the dispatch chokepoint
 * converts it (registry status, `{ok:false, error:{code}}`). This unwraps the
 * throw so each case can assert the CODE, which is the contract now.
 */
async function refusalOf(call: Promise<unknown>): Promise<DedaloError> {
	const outcome = await call.then(
		(value) => ({ threw: false as const, value }),
		(error: unknown) => ({ threw: true as const, error }),
	);
	if (!outcome.threw) {
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`);
	}
	if (!(outcome.error instanceof DedaloError)) throw outcome.error;
	return outcome.error;
}

describe('get_widget_data — identity and record gate', () => {
	test('no seeded principal ⇒ requirePrincipal throws (never an anonymous compute)', async () => {
		await expect(
			getWidgetData(
				rqoOf({ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: SECTION_ID }),
				contextWithoutPrincipal(),
			),
		).rejects.toThrow(/no authenticated principal/);
	});

	test('a profile-less non-admin on an EXISTING record ⇒ perm.denied (403, the section floor)', async () => {
		const refusal = await refusalOf(
			getWidgetData(
				rqoOf(
					{ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: SECTION_ID, mode: 'edit' },
					{ widget_name: WIDGET_NAME },
				),
				contextFor(NO_ACCESS),
			),
		);
		expect(refusal.code).toBe('perm.denied');
		expect(refusal.spec.status).toBe(403);
	});

	test('the SAME record + the superuser passes the door (the refusal is the grant, not the fixture)', async () => {
		const result = await getWidgetData(
			rqoOf(
				{ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: SECTION_ID },
				{ widget_name: WIDGET_NAME },
			),
			contextFor(ADMIN),
		);
		const body = result.body as { ok: unknown; data: unknown };
		expect(body.ok).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
	});

	// Since the read door (WC-2026-11-10-widget-data-read-door): 0 / -1 / '0'
	// are well-formed INTEGERS (the id grammar), so they pass the section and
	// pair halves for the superuser and fall to the record-scope step, whose
	// refusal is now its own code — perm.out_of_scope (was the bare perm.denied
	// of the record-only gate).
	test('non-positive section_id is refused for ADMINS too (record_scope sectionId < 1 ⇒ perm.out_of_scope)', async () => {
		for (const sectionId of [0, -1, '0']) {
			const refusal = await refusalOf(
				getWidgetData(
					rqoOf(
						{ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: sectionId },
						{ widget_name: WIDGET_NAME },
					),
					contextFor(ADMIN),
				),
			);
			expect(refusal.code).toBe('perm.out_of_scope');
		}
	});
});

/**
 * ENVELOPE v2: the two PHP prose refusals are now the two REGISTERED widget
 * codes — the same pair the parity reconciler maps the frozen PHP bodies to
 * (test/parity/normalize.ts FROZEN_ERROR_BODIES): `widget.empty` (the component
 * declares no widgets at all) and `widget.not_defined` (the named widget is not
 * one of them). Both are OPERATOR disclosure, so the tipo/label/widget name
 * ride the LOG message and the log-only coordinates, never the wire.
 */
describe('get_widget_data — widget resolution refusals (the two registered codes)', () => {
	test('a tipo with no properties.widgets ⇒ widget.empty, the label in the LOG line', async () => {
		const refusal = await refusalOf(
			getWidgetData(
				rqoOf(
					{ tipo: NO_WIDGETS_TIPO, section_tipo: SECTION, section_id: SECTION_ID },
					{ widget_name: WIDGET_NAME },
				),
				contextFor(ADMIN),
			),
		);
		expect(refusal.code).toBe('widget.empty');
		expect(refusal.spec.status).toBe(400);
		// The label is the app-lang term of the tipo (lg-spa: 'input_text').
		expect(refusal.message).toBe(
			'Empty defined widgets for dd_component_info : input_text [test52]',
		);
		expect(refusal.coordinates).toMatchObject({ tipo: NO_WIDGETS_TIPO });
	});

	test('an unknown tipo (no ontology node) takes the same branch, label = the tipo itself', async () => {
		const refusal = await refusalOf(
			getWidgetData(
				rqoOf(
					{ tipo: UNKNOWN_TIPO, section_tipo: SECTION, section_id: SECTION_ID },
					{ widget_name: WIDGET_NAME },
				),
				contextFor(ADMIN),
			),
		);
		expect(refusal.code).toBe('widget.empty');
		expect(refusal.message).toBe(
			`Empty defined widgets for dd_component_info : ${UNKNOWN_TIPO} [${UNKNOWN_TIPO}]`,
		);
	});

	test('a MALFORMED tipo is refused by the door grammar (request.invalid) before any ontology lookup', async () => {
		const refusal = await refusalOf(
			getWidgetData(
				rqoOf(
					{ tipo: MALFORMED_TIPO, section_tipo: SECTION, section_id: SECTION_ID },
					{ widget_name: WIDGET_NAME },
				),
				contextFor(ADMIN),
			),
		);
		expect(refusal.code).toBe('request.invalid');
	});

	test('a widget_name none of the declared widgets carries ⇒ widget.not_defined', async () => {
		const refusal = await refusalOf(
			getWidgetData(
				rqoOf(
					{ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: SECTION_ID },
					{ widget_name: 'not_declared' },
				),
				contextFor(ADMIN),
			),
		);
		expect(refusal.code).toBe('widget.not_defined');
		expect(refusal.coordinates).toMatchObject({ widget_name: 'not_declared' });
	});

	test('absent options ⇒ widget_name defaults to the empty string and names itself in the LOG', async () => {
		const refusal = await refusalOf(
			getWidgetData(
				rqoOf({ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: SECTION_ID }),
				contextFor(ADMIN),
			),
		);
		expect(refusal.code).toBe('widget.not_defined');
		expect(refusal.message).toBe('Empty widget_obj for widget ');
	});
});

describe('get_widget_data — thread-through into the widget compute', () => {
	/** Install a scratch descriptor whose compute ECHOES its arguments. */
	function installEcho(): { names: string[]; calls: { ipo: unknown[]; context: unknown }[] } {
		const names: string[] = [];
		const calls: { ipo: unknown[]; context: unknown }[] = [];
		mock.module(REGISTRY_PATH, () => ({
			...REAL_REGISTRY,
			getInfoWidget: (name: string) => {
				names.push(name);
				return {
					name,
					path: '/scratch/echo',
					computeData: async (ipo: unknown[], context: unknown) => {
						calls.push({ ipo, context });
						return [{ echo: { ipo, context } }];
					},
				};
			},
			widgetComputeData: (descriptor: {
				computeData: (ipo: unknown[], context: unknown) => Promise<unknown>;
			}) => descriptor.computeData,
		}));
		return { names, calls };
	}

	test('the ontology ipo block and the full WidgetContext reach computeData', async () => {
		const echo = installEcho();
		const result = await getWidgetData(
			rqoOf(
				{ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: SECTION_ID, mode: 'edit' },
				{ widget_name: WIDGET_NAME },
			),
			contextFor(ADMIN),
		);

		// The registry was asked for the REQUESTED widget name.
		expect(echo.names).toEqual([WIDGET_NAME]);
		expect(echo.calls).toHaveLength(1);

		// ipo === the declared widget's own ipo array (test212's single block).
		const ipo = mustGet(echo.calls[0], 'echo call 0').ipo;
		expect(ipo).toHaveLength(1);
		const block = mustGet(ipo[0], 'ipo block 0') as {
			input: { source: Record<string, unknown>[] };
		};
		expect(mustGet(block.input.source[0], 'ipo input source 0')).toEqual({
			section_id: 'current',
			section_tipo: 'current',
			component_tipo: 'test52',
		});

		// The context is the record coordinates + request identity, verbatim:
		// section_id is passed THROUGH (no Number() coercion on this path).
		expect(mustGet(echo.calls[0], 'echo call 0').context).toEqual({
			sectionTipo: SECTION,
			sectionId: SECTION_ID,
			mode: 'edit',
			lang: 'lg-spa', // currentDataLang() — the suite default data lang
			userId: ADMIN.userId,
			isAdmin: true,
		});

		// …and the compute's return value IS the envelope's result.
		expect(result.body).toMatchObject({
			ok: true,
			data: [{ echo: { ipo, context: mustGet(echo.calls[0], 'echo call 0').context } }],
		});
	});

	test('an absent source.mode defaults to list, and a non-admin identity rides through', async () => {
		const echo = installEcho();
		await getWidgetData(
			rqoOf(
				{ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: String(SECTION_ID) },
				{ widget_name: WIDGET_NAME },
			),
			contextFor({ ...ADMIN, isDeveloper: false }),
		);
		expect(mustGet(echo.calls[0], 'echo call 0').context).toEqual({
			sectionTipo: SECTION,
			// The GRANT's id: the string form is coerced (counted) at the door and
			// the compute receives the int (was the raw client string before the
			// read door, WC-2026-11-10-widget-data-read-door).
			sectionId: SECTION_ID,
			mode: 'list',
			lang: 'lg-spa',
			userId: ADMIN.userId,
			isAdmin: true,
		});
	});
});

describe('get_widget_data — success envelope (real registry)', () => {
	test('the real test_info widget computes over the scratch record', async () => {
		const result = await getWidgetData(
			rqoOf(
				{ tipo: INFO_WITH_WIDGETS, section_tipo: SECTION, section_id: SECTION_ID, mode: 'list' },
				{ widget_name: WIDGET_NAME },
			),
			contextFor(ADMIN),
		);
		expect(result.status).toBe(200);
		// test212 declares two outputs; the scratch record holds no test52 data,
		// so every item carries test_info's placeholder — which encodes the
		// threaded section coordinates.
		expect(result.body).toMatchObject({
			ok: true,
			data: [
				{
					widget: 'test_info',
					key: 0,
					widget_id: 'test_value',
					id: 'test_value',
					value: `test_info widget value for section ${SECTION} - ${SECTION_ID}`,
				},
				{
					widget: 'test_info',
					key: 0,
					widget_id: 'test_label',
					id: 'test_label',
					value: `test_info widget value for section ${SECTION} - ${SECTION_ID}`,
				},
			],
		});
	});
});

describe('get_widget_data — test6883 descriptors: the MODE-ROUTED deferred load', () => {
	/** The SAME request every time; only source.mode differs (or is absent). */
	const descriptorsRqo = (mode?: string): Rqo =>
		rqoOf(
			{
				tipo: INFO_OH,
				section_tipo: OH_SECTION,
				section_id: OH_ID,
				...(mode === undefined ? {} : { mode }),
			},
			{ widget_name: DESCRIPTORS_WIDGET },
		);

	type WidgetItem = {
		widget: string;
		key: number;
		widget_id: string;
		value: unknown;
		locator: unknown;
	};

	async function descriptorItems(mode?: string): Promise<WidgetItem[]> {
		const result = await getWidgetData(descriptorsRqo(mode), contextFor(ADMIN));
		expect(result.status).toBe(200);
		const body = result.body as { ok: unknown; data: unknown };
		// The short-circuit is a SUCCESS with no data, never a refusal — so the
		// envelope must be the OK one in BOTH modes.
		expect(body.ok).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
		return body.data as WidgetItem[];
	}

	test("mode 'edit' ⇒ the indexation count and the terms grid, over the test6837 hop", async () => {
		const items = await descriptorItems('edit');

		// One IPO entry (test6883's descriptors block) × its single path × two
		// declared outputs — so `key` is 0 throughout and the ids are exactly
		// the pair the client's render reads by widget_id.
		expect(items.map((item) => item.widget_id)).toEqual(['indexation', 'terms']);
		for (const item of items) {
			expect(item.widget).toBe(DESCRIPTORS_WIDGET);
			expect(item.key).toBe(0);
			// RAW channel: no WC-026 dualisation (that is the read-path emit hook).
			expect(Object.hasOwn(item, 'id')).toBe(false);
			// The test6837 hop actually ran: the item locator IS the tape locator.
			expect(item.locator).toEqual(locatorOf(TAPE_SECTION, TAPE_ID, 'test6837'));
		}

		// indexation = the number of rsc860 descriptor locators on the tape.
		const indexation = mustGet(items[0], 'indexation item');
		expect(indexation.value).toBe(2);

		// terms = the merged portal grid. Its COLUMN set resolves against live
		// reference data (absent in the test DB), so pin the structure only —
		// the bytes are the read-path golden's job.
		const terms = mustGet(items[1], 'terms item');
		const grid = terms.value as { type: unknown; row_count: unknown; value: unknown[] };
		expect(grid.type).toBe('column');
		expect(grid.row_count).toBe(2); // one row per stored rsc860 locator
		expect(grid.value).toHaveLength(2);
		for (const row of grid.value) {
			expect((row as { type: unknown }).type).toBe('row');
		}
	}, 30000);

	test("mode 'list' ⇒ [] — the deliberate short-circuit the deferred load rests on", async () => {
		// widgets/oh/descriptors.ts:23. Same record, same widget, same everything
		// but the mode: a 50-row list must not pay a portal read + grid build per
		// row, so the client fetches the terms for ONE cell on demand instead.
		expect(await descriptorItems('list')).toEqual([]);
	}, 30000);

	test('an ABSENT source.mode takes the list branch ⇒ [] (handler default)', async () => {
		// The exact trap the dead client autoload fell into: a request that does
		// not send the mode gets nothing back, so the on-demand fetch MUST send
		// mode:'edit'.
		expect(await descriptorItems()).toEqual([]);
	}, 30000);

	test("mode 'list' is DESCRIPTORS-specific: media_icons on the same record still emits", async () => {
		// What makes the case above a routing pin rather than 'this record has no
		// data': the other widget declared by test6883 reads the same test6837 hop and
		// returns rows in list mode.
		const result = await getWidgetData(
			rqoOf(
				{ tipo: INFO_OH, section_tipo: OH_SECTION, section_id: OH_ID, mode: 'list' },
				{ widget_name: MEDIA_ICONS_WIDGET },
			),
			contextFor(ADMIN),
		);
		const body = result.body as { ok: unknown; data: unknown[] };
		expect(body.ok).toBe(true);
		expect(body.data.length).toBeGreaterThan(0);
	}, 30000);
});
