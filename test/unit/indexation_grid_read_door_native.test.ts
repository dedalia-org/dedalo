/**
 * get_indexation_grid — THE READ DOOR, per ROW
 * (WC-2026-11-10-indexation-grid-read-door; owner decision S12 2026-11-10).
 *
 * The thesaurus "show indexations" grid quotes a FRAGMENT of every INDEXING
 * record's text_area — records of OTHER sections than the term's. PHP (and TS
 * until this gate) asked only the section grant on the TERM's section, and TS
 * added the AUTHZ-05 scope of each section_top group. A row is now served only
 * when the caller holds, on the indexing record's own section:
 *
 *   section grant >= 1  +  the grant on the text_area the fragment is quoted from
 *
 * A refused row is OMITTED, an emptied group / section leaves no husk, and the
 * number withheld is NAMED in the owned `withheld_rows` envelope key (plus the
 * request's one `perm.out_of_scope` notice). The past-the-page probe
 * (indexationRowsPast) asks about the SAME rows.
 *
 * Pairs (test/helpers/terms_grid_door_fixture.ts — identical personas except
 * the grant under test; two groups, one row each):
 *   (a) indexing section denied → no row, withheld_rows 2 / control: both rows, 0
 *   (b) text_area denied        → same
 *   (c) paging: a past tail of withheld rows owes no notice for the reader,
 *       does for the control
 *   (d) LOCATOR SWAP: the build reads `sqo.filter_by_locators`, so EVERY entry
 *       passes the source's own gate (section grant >= 1 + record scope) or
 *       the call is REFUSED (perm.denied), and the source term must be among
 *       them (search.invalid_sqo) / control: the matching locators are served
 *   (e) ROW RECORD SCOPE: an indexing record outside the caller's projects
 *       (its group in scope) is withheld + counted, page and past probe alike
 *       / control: the WIDE persona (same profile, both projects) is served
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { buildIndexationGrid, indexationRowsPast } from '../../src/core/section/indexation_grid.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import {
	GRID_TERM,
	GRID_TERM_B,
	installTermsGridDoorFixture,
	removeTermsGridDoorFixture,
	TG_CONTROL_USER_ID,
	TG_IN_SCOPE_RECORD,
	TG_OUT_OF_SCOPE_RECORD,
	TG_SECTION,
	TG_SECTION_DENIED_USER_ID,
	TG_TEXT_AREA,
	TG_TEXT_DENIED_USER_ID,
	TG_TOP_SECTION,
	TG_WIDE_USER_ID,
	termsGridDoorResidue,
} from '../helpers/terms_grid_door_fixture.ts';

let control: Principal;
let sectionDenied: Principal;
let textDenied: Principal;
let superuser: Principal;
let wide: Principal;

const FRAGMENTS = ['zz9376r1', 'zz9376r2'] as const;
const CODES = ['ZZ9376-1', 'ZZ9376-2'] as const;

function contextFor(principal: Principal): ApiRequestContext {
	return {
		requestId: 'indexation-grid-read-door',
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

function gridSqo(limit: number) {
	return {
		mode: 'related',
		section_tipo: ['all'],
		total: null,
		limit,
		offset: 0,
		filter_by_locators: [
			{
				section_tipo: GRID_TERM.section_tipo,
				section_id: String(GRID_TERM.section_id),
				tipo: 'hierarchy40',
			},
		],
	};
}

interface GridBody {
	ok: boolean;
	data: unknown[];
	withheld_rows?: number;
	notices?: { code: string }[];
}

/** The exact rqo the client builds (ts_object.js show_indexations). */
async function grid(principal: Principal): Promise<GridBody> {
	const outcome = await runWithRequestLangs({ applicationLang: 'lg-spa', dataLang: 'lg-spa' }, () =>
		dispatchRqo(
			{
				action: 'get_indexation_grid',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					section_tipo: GRID_TERM.section_tipo,
					section_id: String(GRID_TERM.section_id),
					tipo: 'hierarchy40',
					value: null,
				},
				sqo: gridSqo(200),
			} as unknown as Rqo,
			contextFor(principal),
		),
	);
	expect(outcome.status).toBe(200);
	const body = outcome.body as unknown as GridBody;
	expect(body.ok).toBe(true);
	return body;
}

/** Which of the fixture's fragments / group codes the grid quotes. */
function quoted(body: GridBody): { fragments: string[]; codes: string[] } {
	const json = JSON.stringify(body.data);
	return {
		fragments: FRAGMENTS.filter((fragment) => json.includes(`fragmento ${fragment} indexado`)),
		codes: CODES.filter((code) => json.includes(code)),
	};
}

const noticeCodes = (body: GridBody) => (body.notices ?? []).map((notice) => notice.code);

beforeAll(async () => {
	await installTermsGridDoorFixture();
	control = await resolvePrincipal(TG_CONTROL_USER_ID);
	sectionDenied = await resolvePrincipal(TG_SECTION_DENIED_USER_ID);
	textDenied = await resolvePrincipal(TG_TEXT_DENIED_USER_ID);
	superuser = await resolvePrincipal(-1);
	wide = await resolvePrincipal(TG_WIDE_USER_ID);
}, 60000);

afterAll(async () => {
	await removeTermsGridDoorFixture();
	expect(await termsGridDoorResidue()).toEqual([]);
});

describe('get_indexation_grid — the situation', () => {
	test('the superuser sees exactly the fixture: two groups, two quoted rows, nothing withheld', async () => {
		const body = await grid(superuser);
		// Floor: the grid rendered something (the emptiness verdicts below are not vacuous).
		expect(body.data.length).toBeGreaterThan(0);
		expect(quoted(body)).toEqual({ fragments: [...FRAGMENTS], codes: [...CODES] });
		// Floor: the term carries ONLY the fixture's indexations (no ambient row
		// can satisfy or mask a pair below).
		expect(JSON.stringify(body.data).split('"text_fragment"').length - 1).toBe(2);
		expect(body.withheld_rows).toBe(0);
	});

	test('personas differ only on the grant under test', async () => {
		for (const persona of [control, sectionDenied, textDenied]) {
			expect(persona.isGlobalAdmin).toBe(false);
			expect(await getPermissions(persona, TG_TOP_SECTION, TG_TOP_SECTION)).toBe(1);
			expect(await getPermissions(persona, GRID_TERM.section_tipo, GRID_TERM.section_tipo)).toBe(1);
		}
		expect(await getPermissions(control, TG_SECTION, TG_SECTION)).toBe(1);
		expect(await getPermissions(control, TG_SECTION, TG_TEXT_AREA)).toBe(1);
		expect(await getPermissions(sectionDenied, TG_SECTION, TG_SECTION)).toBe(0);
		expect(await getPermissions(sectionDenied, TG_SECTION, TG_TEXT_AREA)).toBe(1);
		expect(await getPermissions(textDenied, TG_SECTION, TG_SECTION)).toBe(1);
		expect(await getPermissions(textDenied, TG_SECTION, TG_TEXT_AREA)).toBe(0);
	});
});

describe('get_indexation_grid — per-row refusals, each a pair', () => {
	test('control: both rows served, withheld_rows 0, no notice', async () => {
		const body = await grid(control);
		expect(quoted(body)).toEqual({ fragments: [...FRAGMENTS], codes: [...CODES] });
		expect(body.withheld_rows).toBe(0);
		expect(body.notices).toBeUndefined();
	});

	test('(a) indexing section denied: no row, no husk group, withheld_rows 2 + the notice', async () => {
		const body = await grid(sectionDenied);
		expect(quoted(body)).toEqual({ fragments: [], codes: [] });
		expect(body.data).toEqual([]);
		expect(body.withheld_rows).toBe(2);
		expect(noticeCodes(body)).toEqual(['perm.out_of_scope']);
	});

	test('(b) text_area denied: no row, no husk group, withheld_rows 2 + the notice', async () => {
		const body = await grid(textDenied);
		expect(quoted(body)).toEqual({ fragments: [], codes: [] });
		expect(body.data).toEqual([]);
		expect(body.withheld_rows).toBe(2);
		expect(noticeCodes(body)).toEqual(['perm.out_of_scope']);
	});
});

describe('get_indexation_grid — paging stays consistent with the row filter', () => {
	const page = { limit: 1, offset: 0, bounded: 'defaulted' as const };
	const sqo = { ...gridSqo(1) };

	test('page of 1: the control gets row 1 and a visible tail; the reader gets nothing and NO tail', async () => {
		const run = <T>(fn: () => Promise<T>) =>
			runWithRequestLangs({ applicationLang: 'lg-spa', dataLang: 'lg-spa' }, fn);
		const args = {
			sectionTipo: GRID_TERM.section_tipo,
			sectionId: GRID_TERM.section_id,
			tipo: 'hierarchy40',
			sqo,
		};

		const controlReport = { withheldRows: -1 };
		const controlPage = await run(() => buildIndexationGrid(args, control, controlReport));
		expect(quoted({ ok: true, data: controlPage }).fragments).toEqual([FRAGMENTS[0]]);
		expect(controlReport.withheldRows).toBe(0);
		expect(await indexationRowsPast(sqo, page, control)).toBe(true);

		for (const reader of [textDenied, sectionDenied]) {
			const readerReport = { withheldRows: -1 };
			const readerPage = await run(() => buildIndexationGrid(args, reader, readerReport));
			expect(readerPage).toEqual([]);
			expect(readerReport.withheldRows).toBe(1);
			// The tail holds only rows this reader would have withheld: a notice
			// would invite paging to nothing.
			expect(await indexationRowsPast(sqo, page, reader)).toBe(false);
		}
	});
});

// ── (d) LOCATOR SWAP ──────────────────────────────────────────────────────────

type Locator = { section_tipo: string; section_id: string | number; tipo?: string };

const TERM_LOCATOR: Locator = {
	section_tipo: GRID_TERM.section_tipo,
	section_id: String(GRID_TERM.section_id),
	tipo: 'hierarchy40',
};

/** The client's rqo with a caller-chosen filter_by_locators; status + code + body. */
async function gridWith(
	principal: Principal,
	filterByLocators: Locator[],
	term: { section_tipo: string; section_id: number } = GRID_TERM,
): Promise<{ status: number; code: string | null; body: GridBody }> {
	const outcome = await runWithRequestLangs({ applicationLang: 'lg-spa', dataLang: 'lg-spa' }, () =>
		dispatchRqo(
			{
				action: 'get_indexation_grid',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					section_tipo: term.section_tipo,
					section_id: String(term.section_id),
					tipo: 'hierarchy40',
					value: null,
				},
				sqo: { ...gridSqo(200), filter_by_locators: filterByLocators },
			} as unknown as Rqo,
			contextFor(principal),
		),
	);
	const body = outcome.body as unknown as GridBody & { error?: { code?: string } };
	return { status: outcome.status, code: body.error?.code ?? null, body };
}

describe('get_indexation_grid — (d) every filter_by_locators entry passes the source gate', () => {
	const inScope: Locator = { section_tipo: TG_SECTION, section_id: TG_IN_SCOPE_RECORD };
	const outOfScope: Locator = { section_tipo: TG_SECTION, section_id: TG_OUT_OF_SCOPE_RECORD };
	const ungrantedSection: Locator = { section_tipo: 'dd128', section_id: TG_CONTROL_USER_ID };

	test('control: the source + a granted in-scope locator → served, both rows', async () => {
		expect(await getPermissions(control, 'dd128', 'dd128')).toBe(0);
		const served = await gridWith(control, [TERM_LOCATOR, inScope]);
		expect(served.status).toBe(200);
		expect(quoted(served.body)).toEqual({ fragments: [...FRAGMENTS], codes: [...CODES] });
	});

	test('a locator in a section the caller holds no grant on → 403 perm.denied, no row', async () => {
		const refused = await gridWith(control, [TERM_LOCATOR, ungrantedSection]);
		expect([refused.status, refused.code]).toEqual([403, 'perm.denied']);
		expect(JSON.stringify(refused.body)).not.toContain('zz9376r');
		// the pair: the same locator on a section-denied persona's own section
		const sectionRefused = await gridWith(sectionDenied, [TERM_LOCATOR, inScope]);
		expect([sectionRefused.status, sectionRefused.code]).toEqual([403, 'perm.denied']);
		// non-vacuity: the superuser may read dd128 — served
		expect((await gridWith(superuser, [TERM_LOCATOR, ungrantedSection])).status).toBe(200);
	});

	test('a locator naming an out-of-scope record → 403 perm.denied; the superuser is served', async () => {
		const refused = await gridWith(control, [TERM_LOCATOR, outOfScope]);
		expect([refused.status, refused.code]).toEqual([403, 'perm.denied']);
		expect(JSON.stringify(refused.body)).not.toContain('zz9376r');
		expect((await gridWith(superuser, [TERM_LOCATOR, outOfScope])).status).toBe(200);
	});

	test('the swap itself: filter_by_locators without the source term → refused (search.invalid_sqo)', async () => {
		// Source = GRID_TERM_B (granted, in scope); the filter names GRID_TERM.
		const swapped = await gridWith(control, [TERM_LOCATOR], GRID_TERM_B);
		expect([swapped.status, swapped.code]).toEqual([400, 'search.invalid_sqo']);
		expect(JSON.stringify(swapped.body)).not.toContain('zz9376r');
		// a section-wide sweep (no id) names no record: refused too
		const sweep = await gridWith(control, [
			TERM_LOCATOR,
			{ section_tipo: GRID_TERM.section_tipo } as Locator,
		]);
		expect([sweep.status, sweep.code]).toEqual([400, 'search.invalid_sqo']);
	});
});

// ── (e) ROW RECORD SCOPE ─────────────────────────────────────────────────────

const TERM_B_LOCATOR: Locator = {
	section_tipo: GRID_TERM_B.section_tipo,
	section_id: String(GRID_TERM_B.section_id),
	tipo: 'hierarchy40',
};
const ROW_FRAGMENTS = ['zz9376r3', 'zz9376r4'] as const;
const ROW_CODES = ['ZZ9376-3', 'ZZ9376-4'] as const;

function quotedB(body: { data: unknown[] }): { fragments: string[]; codes: string[] } {
	const json = JSON.stringify(body.data);
	return {
		fragments: ROW_FRAGMENTS.filter((fragment) => json.includes(`fragmento ${fragment} indexado`)),
		codes: ROW_CODES.filter((code) => json.includes(code)),
	};
}

describe('get_indexation_grid — (e) the indexing record OWN record scope', () => {
	test('superuser + WIDE (both projects): both rows, nothing withheld', async () => {
		for (const reader of [superuser, wide]) {
			const served = await gridWith(reader, [TERM_B_LOCATOR], GRID_TERM_B);
			expect(served.status).toBe(200);
			expect(quotedB(served.body)).toEqual({
				fragments: [...ROW_FRAGMENTS],
				codes: [...ROW_CODES],
			});
			expect(served.body.withheld_rows).toBe(0);
		}
		// the personas differ only on the project
		expect(await getPermissions(wide, TG_SECTION, TG_TEXT_AREA)).toBe(1);
		expect(wide.isGlobalAdmin).toBe(false);
	});

	test('control (one project): the out-of-project row is withheld + counted, its group in scope', async () => {
		const narrowed = await gridWith(control, [TERM_B_LOCATOR], GRID_TERM_B);
		expect(narrowed.status).toBe(200);
		expect(quotedB(narrowed.body)).toEqual({ fragments: ['zz9376r3'], codes: ['ZZ9376-3'] });
		expect(narrowed.body.withheld_rows).toBe(1);
		expect(noticeCodes(narrowed.body)).toEqual(['perm.out_of_scope']);
	});

	test('paging: a past tail of out-of-scope rows owes no notice for control, does for WIDE', async () => {
		const page = { limit: 1, offset: 0, bounded: 'defaulted' as const };
		const sqo = { ...gridSqo(1), filter_by_locators: [TERM_B_LOCATOR] };
		expect(await indexationRowsPast(sqo, page, wide)).toBe(true);
		expect(await indexationRowsPast(sqo, page, control)).toBe(false);
	});
});
