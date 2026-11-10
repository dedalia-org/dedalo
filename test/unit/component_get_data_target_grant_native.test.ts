/**
 * THE HOST-COMPONENT READ — a component's OWN get_data of one host record is
 * gated as a read of the HOST and SERVED as the host read embeds it
 * (WC-2026-11-09-component-get-data-host-gate; security/host_component_read.ts,
 * called from api/handlers/dd_core_api.ts gateReadTargets at the read AND the
 * count door).
 *
 * THE BUG (reproduced live). A user who reads + edits a host record and its
 * portal (2), holding NO grant on one of the portal's target sections, loaded
 * the record fine — the section read embeds the portal's rows (the subdatum
 * raise) — but the portal's own refresh read (`source.action: 'get_data'`,
 * `sqo.section_tipo` = the portal's targets) was refused perm.denied by Gate B.
 *
 * THE INVARIANT ASSERTED: the admitted answer EQUALS the slice the section read
 * of the host record embeds for that component (its locators + total, every
 * row a column of it emits, nested ones included, and the column levels) —
 * because the read is served from the component's COLUMN NODE in the host
 * section's map, never from the client's `show` / `callers`:
 *   - plain portal P on HOST/1 (edit) and through a VIRTUAL host;
 *   - SECTION-INJECTED portal PI on HOSTI/1, whose section map injects a
 *     NARROWER child set (TG_TEXT only) than PI's own config (TD_TEXT,
 *     TD_SECRET, TG_TEXT): the client shape (show + section-root callers) is
 *     served, and the bare shape (no show) does not over-serve PI's own config;
 *     in edit AND in list mode;
 *   - a BORROWED chain: callers naming another readable component C_A whose
 *     config declares P and injects a deeper portal X → V under it — never
 *     served (no X, no V column);
 *   - the COUNT door: a self-including portal PS (targets HOST + TD) counts 1
 *     for the persona exactly as for root.
 * TAMPERED requests still perm.denied, read AND count: an extra / only
 * non-target section, another record / a target / a second / no locator pin,
 * an out-of-scope host record, an sqo filter, an sqo mode, a properties /
 * matrix_id / data_source / tm_surface override, a temporal source, a tipo not
 * of the source section (even named by its map), a component at 0, a readable
 * component the host map has no column for, a non-get_data action, a section
 * source, a mode no column renders in, an EMPTY mode, an EMPTY lang.
 *
 * Situation: scratch TLD `zzcgd`, one restricted user + profile minted as
 * ordinary dd128 / dd234 records. Teardown: identity swept, dropSituation
 * residue 0, activity rows 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithExplicitId,
} from '../../src/core/db/matrix_write.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { isRecordInScope } from '../../src/core/security/record_scope.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

/** The host section, its portals, its projects filter. */
const HOST = 'zzcgd1';
/** portal on HOST → [TD, TG], show [TD_TEXT @ TD, TG_TEXT @ TG]. Granted 2. */
const P = 'zzcgd2';
const FILTER = 'zzcgd3';
/** portal on HOST → TD. NOT granted (0). */
const P0 = 'zzcgd4';
/** A VIRTUAL section over HOST (borrows P). */
const VHOST = 'zzcgd5';
/** portal on HOST → [HOST, TD] (self-including: its count reaches the host). Granted 2. */
const PS = 'zzcgd6';
/** Target section the user holds NOTHING on. */
const TD = 'zzcgd10';
const TD_TEXT = 'zzcgd11';
/** A TD column only PI's OWN config declares (its section injects narrower). */
const TD_SECRET = 'zzcgd12';
/** portal in TD → V (the borrowed chain's deeper column). */
const X = 'zzcgd13';
/** Target section granted read (1). */
const TG = 'zzcgd20';
const TG_TEXT = 'zzcgd21';
/** A section the user holds nothing on and P does NOT target. */
const OTHER = 'zzcgd30';
const OTHER_TEXT = 'zzcgd31';
/** A second granted section P is NOT a component of (a (HOST2, P) grant is planted). */
const HOST2 = 'zzcgd40';
const HOST2_TEXT = 'zzcgd41';
/** A section whose OWN map injects a narrower child set into its portal PI. */
const HOSTI = 'zzcgd50';
/** portal on HOSTI → [TD, TG], own show [TD_TEXT, TD_SECRET, TG_TEXT]; HOSTI injects [TG_TEXT]. */
const PI = 'zzcgd51';
/** portal on HOSTI → TD, granted 2, but NOT a column of HOSTI's map: no column node. */
const PJ = 'zzcgd52';
/** A granted section whose portal C_A declares P (+ X → V under it): the borrowed chain. */
const S_A = 'zzcgd60';
const C_A = 'zzcgd61';
/** The deeper section only the borrowed chain reaches. */
const V = 'zzcgd70';
const V_TEXT = 'zzcgd71';

const USER_ID = 957301;
const PROFILE_ID = 957311;
const PROJECT_IN = 957321;
const PROJECT_OUT = 957322;
const LANG = 'lg-nolan';

const textValue = (value: string) => [{ id: 1, lang: LANG, value }];

const locator = (from: string, sectionTipo: string, sectionId: number, id = 1) => ({
	id,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

/** A request_config targeting `sections`, showing `ddoMap`. */
const configOf = (sections: string[], ddoMap: Record<string, unknown>[]) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: sections, source: 'section' }] },
				show: { ddo_map: ddoMap },
			},
		],
	},
});

const S = situation({
	name: 'component get_data host gate',
	tld: 'zzcgd',
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: P,
			parent: HOST,
			model: 'component_portal',
			order_number: 1,
			properties: configOf(
				[TD, TG],
				[
					{ tipo: TD_TEXT, parent: 'self', section_tipo: TD },
					{ tipo: TG_TEXT, parent: 'self', section_tipo: TG },
				],
			),
		},
		{ tipo: FILTER, parent: HOST, model: 'component_filter', order_number: 2 },
		{
			tipo: P0,
			parent: HOST,
			model: 'component_portal',
			order_number: 3,
			properties: configOf([TD], [{ tipo: TD_TEXT, parent: 'self', section_tipo: TD }]),
		},
		{
			tipo: PS,
			parent: HOST,
			model: 'component_portal',
			order_number: 4,
			properties: configOf([HOST, TD], [{ tipo: TD_TEXT, parent: 'self', section_tipo: TD }]),
		},
		{ tipo: VHOST, parent: 'test1', model: 'section', relations: [{ tipo: HOST }] },
		{ tipo: TD, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TD_TEXT, parent: TD, model: 'component_input_text', order_number: 1 },
		{ tipo: TD_SECRET, parent: TD, model: 'component_input_text', order_number: 2 },
		{
			tipo: X,
			parent: TD,
			model: 'component_portal',
			order_number: 3,
			properties: configOf([V], [{ tipo: V_TEXT, parent: 'self', section_tipo: V }]),
		},
		{ tipo: TG, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TG_TEXT, parent: TG, model: 'component_input_text', order_number: 1 },
		{ tipo: OTHER, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: OTHER_TEXT, parent: OTHER, model: 'component_input_text', order_number: 1 },
		{
			tipo: HOST2,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: 'test24' }],
			// HOST2's map NAMES P (a column line) although P is not HOST2's
			// component: only the membership law refuses it.
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: {
								ddo_map: [
									{ tipo: HOST2_TEXT, parent: 'self', section_tipo: 'self' },
									{ tipo: P, parent: 'self', section_tipo: 'self' },
								],
							},
						},
					],
				},
			},
		},
		{ tipo: HOST2_TEXT, parent: HOST2, model: 'component_input_text', order_number: 1 },
		{
			tipo: HOSTI,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: 'test24' }],
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: {
								ddo_map: [
									{ tipo: PI, parent: 'self', section_tipo: 'self' },
									{ tipo: TG_TEXT, parent: PI, section_tipo: TG },
								],
							},
						},
					],
				},
			},
		},
		{
			tipo: PI,
			parent: HOSTI,
			model: 'component_portal',
			order_number: 1,
			properties: configOf(
				[TD, TG],
				[
					{ tipo: TD_TEXT, parent: 'self', section_tipo: TD },
					{ tipo: TD_SECRET, parent: 'self', section_tipo: TD },
					{ tipo: TG_TEXT, parent: 'self', section_tipo: TG },
				],
			),
		},
		{
			tipo: PJ,
			parent: HOSTI,
			model: 'component_portal',
			order_number: 2,
			properties: configOf([TD], [{ tipo: TD_TEXT, parent: 'self', section_tipo: TD }]),
		},
		{ tipo: S_A, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: C_A,
			parent: S_A,
			model: 'component_portal',
			order_number: 1,
			properties: configOf(
				[HOST],
				[
					{ tipo: P, parent: 'self', section_tipo: HOST },
					{ tipo: X, parent: P, section_tipo: TD },
					{ tipo: V_TEXT, parent: X, section_tipo: V },
				],
			),
		},
		{ tipo: V, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: V_TEXT, parent: V, model: 'component_input_text', order_number: 1 },
	],
	records: [
		{
			section_tipo: HOST,
			section_id: 1,
			columns: {
				relation: {
					[P]: [locator(P, TD, 1, 1), locator(P, TG, 1, 2)],
					[P0]: [locator(P0, TD, 1)],
					[PS]: [locator(PS, TD, 1)],
					[FILTER]: [locator(FILTER, 'dd153', PROJECT_IN)],
				},
			},
		},
		{
			section_tipo: HOST,
			section_id: 2,
			columns: {
				relation: {
					[P]: [locator(P, TD, 2)],
					[FILTER]: [locator(FILTER, 'dd153', PROJECT_OUT)],
				},
			},
		},
		{
			section_tipo: VHOST,
			section_id: 1,
			columns: {
				relation: {
					[P]: [locator(P, TD, 1)],
					[FILTER]: [locator(FILTER, 'dd153', PROJECT_IN)],
				},
			},
		},
		{
			section_tipo: HOSTI,
			section_id: 1,
			// TG first: a LIST cell pages 1 locator, and that one carries the injected column.
			columns: {
				relation: {
					[PI]: [locator(PI, TG, 1, 1), locator(PI, TD, 1, 2)],
					[PJ]: [locator(PJ, TD, 1)],
				},
			},
		},
		{
			section_tipo: TD,
			section_id: 1,
			columns: {
				string: {
					[TD_TEXT]: textValue('denied one'),
					[TD_SECRET]: textValue('zzcgd secret one'),
				},
				relation: { [X]: [locator(X, V, 1)] },
			},
		},
		{
			section_tipo: TD,
			section_id: 2,
			columns: {
				string: {
					[TD_TEXT]: textValue('denied two'),
					[TD_SECRET]: textValue('zzcgd secret two'),
				},
			},
		},
		{
			section_tipo: TG,
			section_id: 1,
			columns: { string: { [TG_TEXT]: textValue('granted one') } },
		},
		{ section_tipo: V, section_id: 1, columns: { string: { [V_TEXT]: textValue('zzcgd v one') } } },
		{
			section_tipo: OTHER,
			section_id: 1,
			columns: { string: { [OTHER_TEXT]: textValue('zzcgd other one') } },
		},
		{
			section_tipo: HOST2,
			section_id: 1,
			columns: { string: { [HOST2_TEXT]: textValue('host two one') } },
		},
	],
});

/** One dd774 grant row. */
const grant = (id: number, sectionTipo: string, tipo: string, value: number) => ({
	id,
	tipo,
	section_tipo: sectionTipo,
	value,
});

/** NOTHING on TD / OTHER / V; P0 and FILTER ungranted; TG read; (HOST2, P) planted. */
const GRANTS = [
	grant(1, HOST, HOST, 2),
	grant(2, HOST, P, 2),
	grant(3, TG, TG, 1),
	grant(4, TG, TG_TEXT, 1),
	grant(5, VHOST, VHOST, 2),
	grant(6, VHOST, P, 2),
	grant(7, HOST2, HOST2, 2),
	grant(8, HOST2, HOST2_TEXT, 2),
	grant(9, HOST2, P, 2),
	grant(10, HOST, PS, 2),
	grant(11, HOSTI, HOSTI, 2),
	grant(12, HOSTI, PI, 2),
	grant(13, S_A, S_A, 2),
	grant(14, S_A, C_A, 2),
	grant(15, HOSTI, PJ, 2),
];

const yesNo = (from: string, id: number) => locator(from, 'dd64', id);

function clearSecurityCaches() {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

async function sweepIdentity() {
	await assertTestDatabase('component_get_data_target_grant_native sweep');
	await deleteMatrixRecord('matrix_users', 'dd128', USER_ID);
	await deleteMatrixRecord('matrix_profiles', 'dd234', PROFILE_ID);
	clearSecurityCaches();
}

let restricted: Principal;
let root: Principal;

beforeAll(async () => {
	await assertTestDatabase('component_get_data_target_grant_native');
	await sweepIdentity();
	await ensureSituation(S);
	await insertMatrixRecordWithExplicitId('matrix_profiles', 'dd234', PROFILE_ID, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzcgd profile' }] },
		misc: { dd774: GRANTS },
	});
	await insertMatrixRecordWithExplicitId('matrix_users', 'dd128', USER_ID, {
		string: { dd132: [{ id: 1, lang: LANG, value: `zzcgd_${USER_ID}` }] },
		relation: {
			dd131: [yesNo('dd131', 1)],
			dd244: [yesNo('dd244', 2)],
			dd515: [yesNo('dd515', 2)],
			dd1725: [locator('dd1725', 'dd234', PROFILE_ID)],
			dd170: [locator('dd170', 'dd153', PROJECT_IN)],
		},
	});
	clearSecurityCaches();
	restricted = await resolvePrincipal(USER_ID);
	root = await resolvePrincipal(-1);
}, 60000);

afterAll(async () => {
	await sweepIdentity();
	expect(await dropSituation(S)).toBe(0);
	const tipos = S.nodes.map((node) => node.tipo);
	for (const tipo of tipos) await sweepActivityRows(tipo);
	let activityResidue = 0;
	for (const tipo of tipos) activityResidue += await countActivityRows(tipo);
	expect(activityResidue).toBe(0);
});

interface Item {
	typo?: unknown;
	tipo?: unknown;
	section_tipo?: unknown;
	section_id?: unknown;
	entries?: unknown;
	pagination?: { total?: unknown };
}

interface ContextEntry {
	tipo?: unknown;
	section_tipo?: unknown;
	permissions?: unknown;
}

interface Answer {
	status: number;
	items: Item[];
	context: ContextEntry[];
	errorCode: string | null;
	total: unknown;
}

function contextFor(principal: Principal) {
	const token = createSession(
		principal.userId,
		`zzcgd_${principal.userId}`,
		principal.userId === -1,
	);
	const session = getSession(token);
	return {
		requestId: 'component-get-data-host-gate',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	};
}

async function send(rqo: Record<string, unknown>, principal: Principal): Promise<Answer> {
	clearSecurityCaches();
	const result = await dispatchRqo(structuredClone(rqo) as never, contextFor(principal) as never);
	const body = result.body as {
		data?: { data?: Item[]; context?: ContextEntry[]; total?: unknown };
		error?: { code?: string };
	};
	return {
		status: result.status,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
		errorCode: body.error?.code ?? null,
		total: body.data?.total ?? null,
	};
}

interface GetDataShape {
	tipo?: string;
	sectionTipo?: string;
	sectionId?: number;
	mode?: string;
	sections?: string[];
	pins?: unknown;
	sqoExtra?: Record<string, unknown>;
	sourceExtra?: Record<string, unknown>;
	rqoExtra?: Record<string, unknown>;
}

/** The portal refresh exactly as the client sends it (the live bug's shape). */
function getDataRqo(shape: GetDataShape = {}): Record<string, unknown> {
	const sectionTipo = shape.sectionTipo ?? HOST;
	const sectionId = shape.sectionId ?? 1;
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: 'component_portal',
			tipo: shape.tipo ?? P,
			section_tipo: sectionTipo,
			section_id: sectionId,
			mode: shape.mode ?? 'edit',
			view: 'line',
			lang: LANG,
			...shape.sourceExtra,
		},
		sqo: {
			section_tipo: shape.sections ?? [TD, TG],
			limit: 10,
			offset: 0,
			filter_by_locators: shape.pins ?? [{ section_tipo: sectionTipo, section_id: sectionId }],
			total: 2,
			...shape.sqoExtra,
		},
		...shape.rqoExtra,
	};
}

const countRqo = (rqo: Record<string, unknown>) => ({ ...rqo, action: 'count' });

/** The section read of `sectionTipo`/`sectionId` (the section's own map, in `mode`). */
function sectionReadRqo(sectionTipo: string, sectionId: number, mode = 'edit') {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: sectionTipo,
			section_tipo: sectionTipo,
			action: 'search',
			mode,
			lang: LANG,
			session_save: false,
		},
		sqo: {
			section_tipo: [sectionTipo],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: sectionTipo, section_id: String(sectionId) }],
		},
	};
}

/** Every target-side tipo a slice may carry (direct columns and the borrowed chain's deeper ones). */
const COLUMN_TIPOS = new Set([TD_TEXT, TD_SECRET, TG_TEXT, X, V_TEXT]);

/**
 * The component's slice of an answer, comparable across the two doors: its own
 * item (locators + total) and every row its columns emit (tipo, record, value),
 * sorted, plus the column levels. The per-door anchoring stamps (row_section_id
 * / parent_section_id — get_data anchors subdatum rows on the locator target,
 * the section read re-stamps outward) are not part of the content.
 */
function sliceOf(answer: Answer, tipo: string, hostSection: string) {
	const own = answer.items
		.filter((item) => item.tipo === tipo && item.section_tipo === hostSection)
		.map((item) => ({
			section_id: Number(item.section_id),
			entries: (item.entries as { section_tipo: string; section_id: unknown }[]).map((entry) => [
				entry.section_tipo,
				Number(entry.section_id),
			]),
			total: item.pagination?.total,
		}));
	const rows = answer.items
		.filter((item) => COLUMN_TIPOS.has(String(item.tipo)))
		.map((item) =>
			JSON.stringify([item.tipo, item.section_tipo, Number(item.section_id), item.entries]),
		)
		.sort();
	const levels = answer.context
		.filter((entry) => COLUMN_TIPOS.has(String(entry.tipo)))
		.map((entry) => `${String(entry.tipo)}=${String(entry.permissions)}`)
		.sort();
	return { own, rows: [...new Set(rows)], levels: [...new Set(levels)] };
}

const row = (tipo: string, section: string, id: number, value: string) =>
	JSON.stringify([tipo, section, id, textValue(value)]);

/** The admitted get_data must equal the host read's embedded slice — and be non-empty. */
async function expectEmbeddedSlice(
	request: Record<string, unknown>,
	tipo: string,
	host: string,
	principal: Principal,
	mode = 'edit',
) {
	const got = await send(request, principal);
	expect(got.errorCode).toBeNull();
	expect(got.status).toBe(200);
	const embedded = sliceOf(await send(sectionReadRqo(host, 1, mode), principal), tipo, host);
	const served = sliceOf(got, tipo, host);
	expect(served.own).toHaveLength(1);
	expect(served.rows.length).toBeGreaterThan(0);
	expect(served).toEqual(embedded);
	return served;
}

/** The section-injected client shape: show = what HOSTI injects, callers = the section root. */
const sectionInjectedClientShape = (mode: string): GetDataShape => ({
	tipo: PI,
	sectionTipo: HOSTI,
	mode,
	rqoExtra: { show: { ddo_map: [{ tipo: TG_TEXT, parent: PI, section_tipo: TG }] } },
	sourceExtra: { callers: [{ tipo: HOSTI, section_tipo: HOSTI, mode }] },
});

describe('the fixture is non-degenerate', () => {
	test('the restricted profile holds exactly the levels and scope the cases rely on', async () => {
		clearSecurityCaches();
		expect(await getPermissions(restricted, HOST, P)).toBe(2);
		expect(await getPermissions(restricted, HOST, P0)).toBe(0);
		expect(await getPermissions(restricted, TD, TD)).toBe(0);
		expect(await getPermissions(restricted, TD, TD_TEXT)).toBe(0);
		expect(await getPermissions(restricted, TG, TG)).toBe(1);
		expect(await getPermissions(restricted, V, V)).toBe(0);
		expect(await getPermissions(restricted, OTHER, OTHER)).toBe(0);
		expect(await getPermissions(restricted, HOST2, P)).toBe(2);
		expect(await getPermissions(restricted, VHOST, P)).toBe(2);
		expect(await getPermissions(restricted, S_A, C_A)).toBe(2);
		expect(await getPermissions(restricted, HOSTI, PJ)).toBe(2);
		expect(await isRecordInScope(HOST, 1, restricted)).toBe(true);
		expect(await isRecordInScope(HOST, 2, restricted)).toBe(false);
		expect(await isRecordInScope(VHOST, 1, restricted)).toBe(true);
	});

	test('the section reads embed the denied-target rows (the raise) — the bug precondition', async () => {
		const host = sliceOf(await send(sectionReadRqo(HOST, 1), restricted), P, HOST);
		expect(host.rows).toContain(row(TD_TEXT, TD, 1, 'denied one'));
		expect(host.rows).toContain(row(TG_TEXT, TG, 1, 'granted one'));
		// HOSTI injects TG_TEXT only: PI's own TD columns are NOT embedded.
		const injected = sliceOf(await send(sectionReadRqo(HOSTI, 1), restricted), PI, HOSTI);
		expect(injected.rows).toEqual([row(TG_TEXT, TG, 1, 'granted one')]);
	});

	test('without its gate the get_data is refused (Gate B on the denied target)', async () => {
		const answer = await send(getDataRqo({ sections: [TD], tipo: P0 }), restricted);
		expect(answer.errorCode).toBe('perm.denied');
	});
});

describe('the component get_data of a readable host is the host read’s embedded slice', () => {
	test('plain portal (edit): 200, equal to the section read’s slice', async () => {
		const served = await expectEmbeddedSlice(getDataRqo(), P, HOST, restricted);
		expect(served.rows).toContain(row(TD_TEXT, TD, 1, 'denied one'));
		expect(served.levels).toEqual([`${TD_TEXT}=1`, `${TG_TEXT}=1`]);
	});

	test('root control: equal to root’s embedded slice', async () => {
		await expectEmbeddedSlice(getDataRqo(), P, HOST, root);
	});

	test('a VIRTUAL host (VHOST over HOST): equal to its embedded slice', async () => {
		const served = await expectEmbeddedSlice(
			getDataRqo({ sectionTipo: VHOST }),
			P,
			VHOST,
			restricted,
		);
		expect(served.rows).toEqual([row(TD_TEXT, TD, 1, 'denied one')]);
	});

	test('section-injected portal, client shape (show + section-root callers), EDIT: served, equal', async () => {
		await expectEmbeddedSlice(
			getDataRqo(sectionInjectedClientShape('edit')),
			PI,
			HOSTI,
			restricted,
		);
	});

	// A LIST cell pages ONE locator (relation_core.ts cellLimit): the get_data
	// asks the same page so the two doors are compared on the same window.
	test('section-injected portal, client shape, LIST mode: served, equal to the list read', async () => {
		await expectEmbeddedSlice(
			getDataRqo({ ...sectionInjectedClientShape('list'), sqoExtra: { limit: 1 } }),
			PI,
			HOSTI,
			restricted,
			'list',
		);
	});

	test('section-injected portal WITHOUT show: never over-serves its own (wider) config', async () => {
		const served = await expectEmbeddedSlice(
			getDataRqo({ tipo: PI, sectionTipo: HOSTI }),
			PI,
			HOSTI,
			restricted,
		);
		expect(served.rows).toEqual([row(TG_TEXT, TG, 1, 'granted one')]);
	});

	test('a client show that differs from the host map (TG_TEXT only): ignored, served = embedded', async () => {
		const served = await expectEmbeddedSlice(
			getDataRqo({
				rqoExtra: { show: { ddo_map: [{ tipo: TG_TEXT, parent: P, section_tipo: TG }] } },
			}),
			P,
			HOST,
			restricted,
		);
		expect(served.rows).toContain(row(TD_TEXT, TD, 1, 'denied one'));
	});

	test('a BORROWED chain (callers naming C_A, which injects X → V under P): no extra column', async () => {
		const served = await expectEmbeddedSlice(
			getDataRqo({ sourceExtra: { callers: [{ tipo: C_A, section_tipo: S_A, mode: 'edit' }] } }),
			P,
			HOST,
			restricted,
		);
		expect(served.rows.some((entry) => entry.includes(X) || entry.includes(V_TEXT))).toBe(false);
		expect(served.rows).not.toContain(row(V_TEXT, V, 1, 'zzcgd v one'));
	});

	test('the COUNT door admits the same request and counts what root counts (nonzero)', async () => {
		const request = getDataRqo({ tipo: PS, sections: [HOST, TD] });
		const counted = await send(countRqo(request), restricted);
		expect(counted.errorCode).toBeNull();
		expect(counted.total).toBe(1);
		expect(counted.total).toBe((await send(countRqo(request), root)).total);
		expect((await send(request, restricted)).errorCode).toBeNull();
	});
});

const TAMPERED: [string, () => Record<string, unknown>][] = [
	[
		'an extra ungranted NON-target sqo section (OTHER)',
		() => getDataRqo({ sections: [TD, TG, OTHER] }),
	],
	['only a non-target ungranted section', () => getDataRqo({ sections: [OTHER] })],
	[
		'filter_by_locators naming ANOTHER record',
		() => getDataRqo({ pins: [{ section_tipo: HOST, section_id: 2 }] }),
	],
	[
		'filter_by_locators naming a target record',
		() => getDataRqo({ pins: [{ section_tipo: TD, section_id: 1 }] }),
	],
	[
		'a second locator pin beside the host',
		() =>
			getDataRqo({
				pins: [
					{ section_tipo: HOST, section_id: 1 },
					{ section_tipo: TD, section_id: 2 },
				],
			}),
	],
	['no locator pin at all', () => getDataRqo({ pins: [] })],
	['an out-of-scope host record (HOST/2, other project)', () => getDataRqo({ sectionId: 2 })],
	[
		'an sqo filter',
		() =>
			getDataRqo({
				sqoExtra: {
					filter: {
						$and: [
							{
								q: ['denied'],
								path: [
									{ section_tipo: TD, component_tipo: TD_TEXT, model: 'component_input_text' },
								],
							},
						],
					},
				},
			}),
	],
	// Any sqo mode is outside the host page. ('related' is not used here: the
	// count door answers a related sqo on its own branch, before Gate B.)
	['an sqo mode (list)', () => getDataRqo({ sqoExtra: { mode: 'list' } })],
	[
		'a source.properties override',
		() =>
			getDataRqo({
				sourceExtra: {
					properties: configOf(
						[OTHER],
						[{ tipo: OTHER_TEXT, parent: 'self', section_tipo: OTHER }],
					),
				},
			}),
	],
	['a matrix_id (TM preview row)', () => getDataRqo({ sourceExtra: { matrix_id: 1 } })],
	['a data_source (TM)', () => getDataRqo({ sourceExtra: { data_source: 'tm' } })],
	['a tm_surface', () => getDataRqo({ sourceExtra: { tm_surface: 'zzcgd' } })],
	['a TEMPORAL source', () => getDataRqo({ sourceExtra: { is_temporal: true } })],
	[
		'a tipo that is NOT a component of the source section (P on HOST2: grant planted, named by its map)',
		() => getDataRqo({ sectionTipo: HOST2 }),
	],
	// The column's read grant is the host map's STEP 11 gate: P0 (0) has no column node.
	['a component the user holds 0 on (P0)', () => getDataRqo({ tipo: P0, sections: [TD] })],
	[
		'a readable component that is NOT a column of the host map (PJ on HOSTI)',
		() => getDataRqo({ tipo: PJ, sectionTipo: HOSTI, sections: [TD] }),
	],
	[
		'a non-get_data action (search, no chain)',
		() => getDataRqo({ sourceExtra: { action: 'search' } }),
	],
	['a section-typed source', () => getDataRqo({ sourceExtra: { type: 'section' } })],
	['a mode no column renders in (search)', () => getDataRqo({ mode: 'search' })],
	['an EMPTY mode', () => getDataRqo({ mode: '' })],
	['an EMPTY lang', () => getDataRqo({ sourceExtra: { lang: '' } })],
];

describe('tampered requests are still refused (read door AND count door)', () => {
	for (const [label, build] of TAMPERED) {
		test(`${label}: perm.denied`, async () => {
			const read = await send(build(), restricted);
			expect(read.errorCode).toBe('perm.denied');
			const counted = await send(countRqo(build()), restricted);
			expect(counted.errorCode).toBe('perm.denied');
		});
	}
});
