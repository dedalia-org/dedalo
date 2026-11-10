/**
 * get_section_terms — THE READ DOOR (WC-2026-11-10-section-terms-read-door;
 * owner decision S12 2026-11-10, plan T0-3 F5).
 *
 * The batch term resolver quotes the section_map TERM COMPONENT's value of
 * every record the caller names. PHP (and TS until this gate) asked only the
 * SECTION grant, so any user with a section grant learned the label of records
 * outside their projects, and of a term component their profile denies. The
 * door now admits a locator only with (handlers/section_terms_access.ts):
 *
 *   section grant >= 1  +  the grant on every term component  +  record scope
 *
 * and OMITS the rest (batch semantics — the map is keyed by the caller's own
 * locators) with ONE `perm.out_of_scope` notice.
 *
 * Every disclosure assertion is a PAIR on the same call: the reader is refused,
 * the CONTROL (identical profile, project and records except the one grant
 * under test — test/helpers/terms_grid_door_fixture.ts) is served.
 *
 *   (a) out-of-scope record → absent for the reader / present for the superuser
 *       (and the in-scope neighbour present for the reader: the scope, not a
 *       broken persona, removed it)
 *   (b) term component denied → absent / control present
 *   (c) section denied → absent / control present (the pre-existing omission)
 *   + non-address ids still flow (no record to scope), non-positive ids never
 *   + a 1000-locator batch, timed (the scope probe is batched, not per locator)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { isRecordInScope } from '../../src/core/security/record_scope.ts';
import { getTermTipos } from '../../src/core/ts_object/term_resolver.ts';
import {
	clearTermsGridDoorCaches,
	installTermsGridDoorFixture,
	removeTermsGridDoorFixture,
	TG_CONTROL_USER_ID,
	TG_IN_SCOPE_RECORD,
	TG_IN_SCOPE_TERM,
	TG_OUT_OF_SCOPE_RECORD,
	TG_OUT_OF_SCOPE_TERM,
	TG_SECTION,
	TG_SECTION_DENIED_USER_ID,
	TG_TERM_COMPONENT,
	TG_TERM_DENIED_USER_ID,
	termsGridDoorResidue,
} from '../helpers/terms_grid_door_fixture.ts';

let control: Principal;
let termDenied: Principal;
let sectionDenied: Principal;
let superuser: Principal;

const IN_KEY = `${TG_SECTION}_${TG_IN_SCOPE_RECORD}`;
const OUT_KEY = `${TG_SECTION}_${TG_OUT_OF_SCOPE_RECORD}`;

function contextFor(principal: Principal): ApiRequestContext {
	return {
		requestId: 'section-terms-read-door',
		clientIp: '127.0.0.1',
		session: {
			userId: principal.userId,
			username: `user_${principal.userId}`,
			isGlobalAdmin: principal.isGlobalAdmin,
			csrfToken: 'tok',
			applicationLang: null,
			dataLang: null,
		},
		csrfCandidate: 'tok',
		principal,
	} as unknown as ApiRequestContext;
}

interface TermsBody {
	ok: boolean;
	data: Record<string, string | null>;
	notices?: { code: string }[];
}

/** The exact rqo the client builds (build_graph_data.js fetch_section_terms). */
async function terms(
	principal: Principal,
	locators: { section_tipo: string; section_id: string | number }[],
): Promise<TermsBody> {
	const outcome = await runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: 'lg-eng' }, () =>
		dispatchRqo(
			{
				action: 'get_section_terms',
				dd_api: 'dd_core_api',
				locators,
				lang: 'lg-eng',
			} as unknown as Rqo,
			contextFor(principal),
		),
	);
	expect(outcome.status).toBe(200);
	const body = outcome.body as unknown as TermsBody;
	expect(body.ok).toBe(true);
	return body;
}

const noticeCodes = (body: TermsBody) => (body.notices ?? []).map((notice) => notice.code);

beforeAll(async () => {
	await installTermsGridDoorFixture();
	control = await resolvePrincipal(TG_CONTROL_USER_ID);
	termDenied = await resolvePrincipal(TG_TERM_DENIED_USER_ID);
	sectionDenied = await resolvePrincipal(TG_SECTION_DENIED_USER_ID);
	superuser = await resolvePrincipal(-1);
}, 60000);

afterAll(async () => {
	await removeTermsGridDoorFixture();
	// Fail loud on residue: a sweep that left a row behind is a red, not a warning.
	expect(await termsGridDoorResidue()).toEqual([]);
});

describe('get_section_terms — the fixture confers exactly what it claims', () => {
	test('test3 draws its term from test52 alone; personas differ only on the grant under test', async () => {
		expect(await getTermTipos(TG_SECTION, null)).toEqual([TG_TERM_COMPONENT]);
		for (const persona of [control, termDenied, sectionDenied]) {
			expect(persona.isGlobalAdmin).toBe(false);
		}
		expect(await getPermissions(control, TG_SECTION, TG_SECTION)).toBe(1);
		expect(await getPermissions(control, TG_SECTION, TG_TERM_COMPONENT)).toBe(1);
		expect(await getPermissions(termDenied, TG_SECTION, TG_SECTION)).toBe(1);
		expect(await getPermissions(termDenied, TG_SECTION, TG_TERM_COMPONENT)).toBe(0);
		expect(await getPermissions(sectionDenied, TG_SECTION, TG_SECTION)).toBe(0);
		expect(await getPermissions(sectionDenied, TG_SECTION, TG_TERM_COMPONENT)).toBe(1);
		// The record scope the pairs rely on, through the list's own predicate.
		expect(await isRecordInScope(TG_SECTION, TG_IN_SCOPE_RECORD, control)).toBe(true);
		expect(await isRecordInScope(TG_SECTION, TG_OUT_OF_SCOPE_RECORD, control)).toBe(false);
	});
});

describe('get_section_terms — the three refusals, each a pair', () => {
	test('(a) out-of-scope record: ABSENT for the reader (in-scope neighbour present) / PRESENT for the superuser', async () => {
		const locators = [
			{ section_tipo: TG_SECTION, section_id: String(TG_IN_SCOPE_RECORD) },
			{ section_tipo: TG_SECTION, section_id: String(TG_OUT_OF_SCOPE_RECORD) },
		];
		clearTermsGridDoorCaches();
		const narrowed = await terms(control, locators);
		expect(narrowed.data).toEqual({ [IN_KEY]: TG_IN_SCOPE_TERM });
		expect(noticeCodes(narrowed)).toEqual(['perm.out_of_scope']);

		const served = await terms(superuser, locators);
		expect(served.data).toEqual({
			[IN_KEY]: TG_IN_SCOPE_TERM,
			[OUT_KEY]: TG_OUT_OF_SCOPE_TERM,
		});
		expect(served.notices).toBeUndefined();
	});

	test('(a) the scoped address is the one the term read HITS: a leading-zero id is scoped as its Number()', async () => {
		// '0937632' reads record 937632 (term_resolver Number()); a stricter
		// parser at the door would let it read unscoped.
		const narrowed = await terms(control, [
			{ section_tipo: TG_SECTION, section_id: `0${TG_OUT_OF_SCOPE_RECORD}` },
		]);
		expect(narrowed.data).toEqual({});
		const served = await terms(superuser, [
			{ section_tipo: TG_SECTION, section_id: `0${TG_OUT_OF_SCOPE_RECORD}` },
		]);
		expect(served.data).toEqual({
			[`${TG_SECTION}_0${TG_OUT_OF_SCOPE_RECORD}`]: TG_OUT_OF_SCOPE_TERM,
		});
	});

	test('(b) term component denied: ABSENT for the reader / PRESENT for the control', async () => {
		const locators = [{ section_tipo: TG_SECTION, section_id: TG_IN_SCOPE_RECORD }];
		const narrowed = await terms(termDenied, locators);
		expect(narrowed.data).toEqual({});
		expect(noticeCodes(narrowed)).toEqual(['perm.out_of_scope']);

		const served = await terms(control, locators);
		expect(served.data).toEqual({ [IN_KEY]: TG_IN_SCOPE_TERM });
		expect(served.notices).toBeUndefined();
	});

	test('(c) section denied: ABSENT for the reader / PRESENT for the control', async () => {
		const locators = [{ section_tipo: TG_SECTION, section_id: TG_IN_SCOPE_RECORD }];
		const narrowed = await terms(sectionDenied, locators);
		expect(narrowed.data).toEqual({});
		expect(noticeCodes(narrowed)).toEqual(['perm.out_of_scope']);

		const served = await terms(control, locators);
		expect(served.data).toEqual({ [IN_KEY]: TG_IN_SCOPE_TERM });
	});
});

describe('get_section_terms — ids that address no record', () => {
	test('a non-address id (graph token / external remote id) still flows for the reader — nothing to scope', async () => {
		// Number('zz9376token') is NaN: the term read touches no row and answers
		// '' — the pre-existing behaviour the graph's provisional label relies on.
		const body = await terms(control, [{ section_tipo: TG_SECTION, section_id: 'zz9376token' }]);
		expect(body.data).toEqual({ [`${TG_SECTION}_zz9376token`]: '' });
		expect(body.notices).toBeUndefined();
	});

	test('a non-positive id is never a reachable record — omitted for the reader AND the superuser', async () => {
		for (const persona of [control, superuser]) {
			const body = await terms(persona, [{ section_tipo: TG_SECTION, section_id: 0 }]);
			expect(body.data).toEqual({});
		}
	});
});

describe('get_section_terms — batch cost', () => {
	test('1000 locators (500 in scope, 500 out) answer in one bounded pass — timed and reported', async () => {
		// One real in-scope + one real out-of-scope record, each repeated under
		// 500 distinct leading-zero spellings (distinct batch keys, same rows).
		const locators: { section_tipo: string; section_id: string }[] = [];
		for (let pad = 1; pad <= 500; pad++) {
			locators.push({
				section_tipo: TG_SECTION,
				section_id: `${'0'.repeat(pad)}${TG_IN_SCOPE_RECORD}`,
			});
			locators.push({
				section_tipo: TG_SECTION,
				section_id: `${'0'.repeat(pad)}${TG_OUT_OF_SCOPE_RECORD}`,
			});
		}
		expect(locators.length).toBe(1000);
		const startedReader = performance.now();
		const narrowed = await terms(control, locators);
		const readerMs = performance.now() - startedReader;
		const startedSuper = performance.now();
		const served = await terms(superuser, locators);
		const superMs = performance.now() - startedSuper;
		console.log(
			`[section_terms_read_door] 1000 locators: reader ${readerMs.toFixed(0)} ms (500 admitted), superuser ${superMs.toFixed(0)} ms (1000 admitted)`,
		);
		expect(Object.keys(narrowed.data).length).toBe(500);
		expect(Object.values(narrowed.data).every((term) => term === TG_IN_SCOPE_TERM)).toBe(true);
		expect(Object.keys(served.data).length).toBe(1000);
	}, 60000);

	test('1000 DISTINCT addresses (no fixture row behind them): the scope probe is chunked, not per locator', async () => {
		// Read-only: ids 93760000-93760999 are only READ (none is written by
		// this gate); a record nobody's project covers is out of scope.
		const locators = Array.from({ length: 1000 }, (_, index) => ({
			section_tipo: TG_SECTION,
			section_id: 93760000 + index,
		}));
		const startedReader = performance.now();
		const narrowed = await terms(control, locators);
		const readerMs = performance.now() - startedReader;
		const startedSuper = performance.now();
		const served = await terms(superuser, locators);
		const superMs = performance.now() - startedSuper;
		console.log(
			`[section_terms_read_door] 1000 distinct addresses: reader ${readerMs.toFixed(0)} ms (0 admitted, 5 scope statements), superuser ${superMs.toFixed(0)} ms (unscoped, 1000 term reads)`,
		);
		expect(narrowed.data).toEqual({});
		expect(Object.keys(served.data).length).toBe(1000);
	}, 60000);
});
