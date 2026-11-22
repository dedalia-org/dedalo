/**
 * dd_identify_api — the identification engine over the normal API
 * (src/core/api/handlers/dd_identify_api.ts).
 *
 * Two things are being gated here, and only one of them is "does it work".
 *
 * 1. IT DECLINES WITH A CODE, IT DOES NOT EXPLODE. A section with no profile, a
 *    malformed profile, and a record the caller may not read are all ORDINARY
 *    situations. Each must come back as a REGISTERED code
 *    (`identify.no_profile`, `identify.invalid_profile`, `perm.denied`) that the
 *    dispatch chokepoint converts into `{ok:false, error:{code}}` — never as an
 *    `internal.unexpected` 500, which tells a curator nothing. A malformed
 *    profile still travels LOUDLY: `identify.invalid_profile` is a
 *    PUBLIC-disclosure code, so the parser's exact message reaches the wire.
 *
 * 2. THE PRINCIPAL IS THE GATE. `findMatches` requires a principal because an
 *    absent one means "internal search, skip the projects filter" to the SQL
 *    assembler. The handler must pass the request's own, and a denied caller
 *    must get NOTHING — not a score, not a detail string, not a count of what
 *    was hidden.
 *
 * The happy path runs the REAL engine over two scratch `test3` records that
 * share a value, so the wire shape is proved against a real result rather than
 * a hand-built one. Scratch rows use section_ids far outside the canonical
 * range and are removed in afterAll (canonicalTest3Drift counts stray rows).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import {
	buildFindMatches,
	DEFAULT_LIMIT,
	defaultIdentifyApiDeps,
	identifyApiActions,
	MAX_LIMIT,
} from '../../src/core/api/handlers/dd_identify_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { IdentifyAccessError, type MatchInput } from '../../src/core/identify/match.ts';
import { ProfileError, parseProfile } from '../../src/core/identify/profile.ts';
import type { IdentificationProfile } from '../../src/core/identify/types.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { inSplitLane, laneLabel, SPLIT_LANES } from '../helpers/split_request_langs.ts';

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

const SEED_ID = 9990301;
const TWIN_ID = 9990302;
const SHARED_TEXT = 'identify api shared legend fixture';
/** The lane pair (review M2): equal in lg-eng, different in lg-spa. */
const LANE_SEED_ID = 9990303;
const LANE_TWIN_ID = 9990304;
const LANE_VALUES: Readonly<Record<number, Readonly<Record<string, string>>>> = {
	[LANE_SEED_ID]: { 'lg-eng': 'identify api lane legend', 'lg-spa': 'leyenda de la semilla' },
	[LANE_TWIN_ID]: { 'lg-eng': 'identify api lane legend', 'lg-spa': 'leyenda del gemelo' },
};

const rqo = (options: Record<string, unknown>): Rqo => ({ options }) as unknown as Rqo;

/** The handler context slice dispatch seeds; requirePrincipal reads `principal`. */
const ctx = (principal: Principal): ApiRequestContext =>
	({
		requestId: 'test',
		clientIp: '127.0.0.1',
		session: null,
		csrfCandidate: null,
		principal,
	}) as ApiRequestContext;

/** A profile over test3's `test52` text component. */
function textProfile(): IdentificationProfile {
	return parseProfile({
		id: 'test_objects',
		label: 'Test objects',
		sectionTipos: ['test3'],
		criteria: [
			{
				id: 'legend',
				label: 'Legend',
				path: [{ section_tipo: 'test3', component_tipo: 'test52' }],
				role: 'identifying',
				mode: 'normalized_text',
				weight: 1,
			},
		],
	});
}

/**
 * The DB-backed cases are gated at COLLECTION time (test/helpers/db_ready.ts).
 * They used to carry `if (!dbReady) return;` in the body — a PASS with no
 * assertions on a machine without Postgres, which is exactly the shape of a gate
 * that has stopped gating.
 */
beforeAll(async () => {
	if (!DB_READY) return;
	// Two records holding the same legend — the minimal "these are the same
	// type" corpus. The data lang is the install's main one: outside a request
	// scope the handler threads currentDataLang(), which answers it.
	for (const id of [SEED_ID, TWIN_ID]) {
		await sql.unsafe(
			`INSERT INTO matrix_test (section_id, section_tipo, string)
			 VALUES ($1, 'test3', $2::text::jsonb)`,
			[
				id,
				JSON.stringify({
					test52: [{ id: 1, lang: config.lang.dataLangDefault, value: SHARED_TEXT }],
				}),
			],
		);
	}
	for (const [id, values] of Object.entries(LANE_VALUES)) {
		await sql.unsafe(
			`INSERT INTO matrix_test (section_id, section_tipo, string)
			 VALUES ($1, 'test3', $2::text::jsonb)`,
			[
				Number(id),
				JSON.stringify({
					test52: Object.entries(values).map(([lang, value], index) => ({
						id: index + 1,
						lang,
						value,
					})),
				}),
			],
		);
	}
});

afterAll(async () => {
	if (!DB_READY) return;
	for (const id of [SEED_ID, TWIN_ID, LANE_SEED_ID, LANE_TWIN_ID]) {
		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
			'test3',
			id,
		]);
	}
});

/** Deps with everything permitted and nothing real behind it. */
function fakeDeps(overrides: Partial<Parameters<typeof buildFindMatches>[0]> = {}) {
	return {
		loadProfile: async () => textProfile(),
		runMatches: async () => ({
			results: [],
			moreAvailable: false,
			blindCriteria: [],
			restrictedCriteria: [],
		}),
		canReadSection: async () => true,
		...overrides,
	};
}

/**
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md §4): a decline is a THROWN registry
 * code — the handler builds no failure body, and the dispatch chokepoint
 * converts it (registry status, `{ok:false, error:{code}}`). This unwraps the
 * throw so each case can assert the CODE, which is the contract now.
 */
async function declineOf(call: Promise<unknown>): Promise<DedaloError> {
	const outcome = await call.then(
		(value) => ({ threw: false as const, value }),
		(error: unknown) => ({ threw: true as const, error }),
	);
	if (!outcome.threw) {
		throw new Error(`expected a decline, got ${JSON.stringify(outcome.value)}`);
	}
	if (!(outcome.error instanceof DedaloError)) throw outcome.error;
	return outcome.error;
}

describe('find_matches — bad requests', () => {
	test('a missing or unusable seed is declined, never thrown', async () => {
		const handler = buildFindMatches(fakeDeps());
		for (const options of [
			{},
			{ section_tipo: 'test3' },
			{ section_tipo: '', section_id: 1 },
			{ section_tipo: 'test3', section_id: 0 },
			{ section_tipo: 'test3', section_id: 'not a number' },
			{ section_tipo: 'not a tipo!', section_id: 1 },
		]) {
			const decline = await declineOf(handler(rqo(options), ctx(SUPERUSER)));
			expect(decline.code).toBe('identify.missing_seed');
			expect(decline.spec.status).toBe(400);
		}
	});
});

describe('find_matches — the three clean declines', () => {
	test('a section with no profile', async () => {
		const decline = await declineOf(
			buildFindMatches(fakeDeps({ loadProfile: async () => null }))(
				rqo({ section_tipo: 'test3', section_id: 1 }),
				ctx(SUPERUSER),
			),
		);
		expect(decline.code).toBe('identify.no_profile');
		expect(decline.spec.status).toBe(400);
	});

	test('a malformed profile — declined, but the parser message travels', async () => {
		const decline = await declineOf(
			buildFindMatches(
				fakeDeps({
					loadProfile: async () => {
						throw new ProfileError("criterion 'legend' hop 0 names component 'x'");
					},
				}),
			)(rqo({ section_tipo: 'test3', section_id: 1 }), ctx(SUPERUSER)),
		);
		expect(decline.code).toBe('identify.invalid_profile');
		// The whole point of refusing loudly is that the curator learns WHAT — and
		// this code's disclosure is PUBLIC, so the parser sentence reaches the wire.
		expect(decline.spec.disclosure).toBe('public');
		expect(decline.publicMessage).toContain("criterion 'legend' hop 0");
	});

	test('a record the principal may not read (the engine raised IdentifyAccessError)', async () => {
		const decline = await declineOf(
			buildFindMatches(
				fakeDeps({
					runMatches: async () => {
						throw new IdentifyAccessError({ sectionTipo: 'test3', sectionId: 1 });
					},
				}),
			)(rqo({ section_tipo: 'test3', section_id: 1 }), ctx(SUPERUSER)),
		);
		expect(decline.code).toBe('perm.denied');
		expect(decline.spec.status).toBe(403);
	});

	test('a section the principal may not read — checked BEFORE the profile', async () => {
		// Otherwise the decline codes become an oracle for which sections have an
		// identification descriptor.
		let profileLoaded = false;
		const decline = await declineOf(
			buildFindMatches(
				fakeDeps({
					canReadSection: async () => false,
					loadProfile: async () => {
						profileLoaded = true;
						return textProfile();
					},
				}),
			)(rqo({ section_tipo: 'test3', section_id: 1 }), ctx(NO_ACCESS)),
		);
		expect(decline.code).toBe('perm.denied');
		expect(profileLoaded).toBe(false);
	});
});

describe('find_matches — what reaches the engine', () => {
	test('the request principal is the one the engine is gated with', async () => {
		let seen: MatchInput | null = null;
		await buildFindMatches(
			fakeDeps({
				runMatches: async (input: MatchInput) => {
					seen = input;
					return { results: [], moreAvailable: false, blindCriteria: [], restrictedCriteria: [] };
				},
			}),
		)(rqo({ section_tipo: 'test3', section_id: 7 }), ctx(NO_ACCESS));
		expect(seen).not.toBeNull();
		expect((seen as unknown as MatchInput).principal).toBe(NO_ACCESS);
		expect((seen as unknown as MatchInput).seed).toEqual({ sectionTipo: 'test3', sectionId: 7 });
	});

	test('the REQUEST data lang reaches the engine, never the interface one (review M2)', async () => {
		for (const lane of SPLIT_LANES) {
			let seen: MatchInput | null = null;
			await inSplitLane(lane, () =>
				buildFindMatches(
					fakeDeps({
						runMatches: async (input: MatchInput) => {
							seen = input;
							return {
								results: [],
								moreAvailable: false,
								blindCriteria: [],
								restrictedCriteria: [],
							};
						},
					}),
				)(rqo({ section_tipo: 'test3', section_id: 7 }), ctx(SUPERUSER)),
			);
			expect((seen as MatchInput | null)?.lang, laneLabel(lane)).toBe(lane.dataLang);
		}
	});

	test('limit is clamped, and defaulted when absent or unusable', async () => {
		const limits: number[] = [];
		const handler = buildFindMatches(
			fakeDeps({
				runMatches: async (input: MatchInput) => {
					limits.push(input.limit as number);
					return { results: [], moreAvailable: false, blindCriteria: [], restrictedCriteria: [] };
				},
			}),
		);
		for (const limit of [9999, 0, -3, 5, 'lots', undefined]) {
			await handler(rqo({ section_tipo: 'test3', section_id: 1, limit }), ctx(SUPERUSER));
		}
		expect(limits).toEqual([MAX_LIMIT, 1, 1, 5, DEFAULT_LIMIT, DEFAULT_LIMIT]);
	});
});

describe('find_matches — the answer', () => {
	test.if(DB_READY)('a real run returns the twin, with its per-criterion explanation', async () => {
		// Real engine, real ACL, real pool query — only the profile is injected
		// (a test must not write an ontology descriptor).
		const handler = buildFindMatches({
			...defaultIdentifyApiDeps(),
			loadProfile: async () => textProfile(),
		});
		const res = await handler(rqo({ section_tipo: 'test3', section_id: SEED_ID }), ctx(SUPERUSER));
		expect(res.body.ok).toBe(true);
		const body = res.body.data as {
			seed: { section_tipo: string; section_id: number; thumb_url: string | null };
			profile: { id: string; label: string };
			results: Array<{
				section_tipo: string;
				section_id: number;
				score: number;
				verdict: string;
				outcomes: Array<{ criterion_id: string; agreed: boolean | null; detail: string }>;
			}>;
			more_available: boolean;
			blind_criteria: string[];
		};
		// thumb_url is part of the seed's shape; this profile declares no preview
		// component, so it is null — never absent, and never a URL to nothing.
		expect(body.seed).toEqual({
			section_tipo: 'test3',
			section_id: SEED_ID,
			thumb_url: null,
		});
		expect(body.profile).toEqual({ id: 'test_objects', label: 'Test objects' });
		expect(body.more_available).toBe(false);
		expect(body.blind_criteria).toEqual([]); // the seed records its one criterion

		const twin = body.results.find((result) => result.section_id === TWIN_ID);
		expect(twin).toBeDefined();
		expect(twin?.section_tipo).toBe('test3');
		expect(twin?.score).toBe(1);
		expect(twin?.verdict).toBe('same_type');
		// An unexplained score is noise: the breakdown is never omitted.
		expect(twin?.outcomes).toHaveLength(1);
		expect(twin?.outcomes[0]?.criterion_id).toBe('legend');
		expect(twin?.outcomes[0]?.agreed).toBe(true);
		expect(twin?.outcomes[0]?.detail).toContain(SHARED_TEXT);
		// The seed never matches itself.
		expect(body.results.some((result) => result.section_id === SEED_ID)).toBe(false);
	});

	test.if(DB_READY)(
		'the real reader resolves criteria in the REQUEST data lang (review M2)',
		async () => {
			// The pair agrees in lg-eng and differs in lg-spa: the twin is a full
			// match only when the criterion values are read in lg-eng. Before, the
			// production reader got no lang and read the install default.
			const handler = buildFindMatches({
				...defaultIdentifyApiDeps(),
				loadProfile: async () => textProfile(),
			});
			for (const lane of SPLIT_LANES) {
				const res = await inSplitLane(lane, () =>
					handler(rqo({ section_tipo: 'test3', section_id: LANE_SEED_ID }), ctx(SUPERUSER)),
				);
				expect(res.body.ok, laneLabel(lane)).toBe(true);
				const results = (res.body.data as { results: { section_id: number; score: number }[] })
					.results;
				const twin = results.find((result) => result.section_id === LANE_TWIN_ID);
				if (lane.dataLang === 'lg-eng') expect(twin?.score, laneLabel(lane)).toBe(1);
				else expect(twin?.score ?? 0, laneLabel(lane)).toBeLessThan(1);
			}
		},
	);

	test.if(DB_READY)('a denied principal gets NOTHING from the real stack (DoD)', async () => {
		const handler = buildFindMatches({
			...defaultIdentifyApiDeps(),
			loadProfile: async () => textProfile(),
		});
		const decline = await declineOf(
			handler(rqo({ section_tipo: 'test3', section_id: SEED_ID }), ctx(NO_ACCESS)),
		);
		expect(decline.code).toBe('perm.denied');
		expect(decline.spec.status).toBe(403);
	});
});

describe('find_matches — a partial answer says it is partial', () => {
	/**
	 * THE WIRE IS A WHITELIST, which is exactly how these two markers went
	 * missing: the engine had computed both, `shapeResult` listed the outcome
	 * fields it copied, and the envelope listed the report fields it emitted —
	 * so a restricted caller received a score computed over FEWER criteria than
	 * a privileged one with nothing in the payload saying so, and the profile's
	 * gate arrived carrying a weight it never contributed. Each assertion below
	 * fails on the whitelist as it was.
	 *
	 * The report is injected rather than produced by a dd774 fixture: what is
	 * being gated here is the BOUNDARY (does the marker survive the shaping),
	 * and match.ts's own tests own the rule that sets it.
	 */
	const markedReport = () => ({
		results: [
			{
				sectionTipo: 'test3',
				sectionId: 42,
				score: 1,
				verdict: 'same_type' as const,
				outcomes: [
					{
						criterionId: 'legend',
						label: 'Legend',
						agreed: true,
						weight: 6,
						detail: "both 'ATHENA'",
						required: true as const,
					},
					{
						criterionId: 'findspot',
						label: 'Findspot',
						agreed: null,
						weight: 2,
						detail: 'not readable by this caller',
						restricted: true as const,
					},
					{
						criterionId: 'symbol',
						label: 'Symbol',
						agreed: false,
						weight: 1,
						detail: 'differs',
					},
				],
			},
		],
		moreAvailable: false,
		blindCriteria: ['mint'],
		restrictedCriteria: ['findspot'],
	});

	/** The shaped body, over an injected report. */
	async function answer() {
		const res = await buildFindMatches(fakeDeps({ runMatches: async () => markedReport() }))(
			rqo({ section_tipo: 'test3', section_id: 7 }),
			ctx(SUPERUSER),
		);
		expect(res.body.ok).toBe(true);
		return res.body.data as {
			results: Array<{
				outcomes: Array<{
					criterion_id: string;
					weight: number;
					restricted?: boolean;
					required?: boolean;
				}>;
			}>;
			blind_criteria: string[];
			restricted_criteria: string[];
		};
	}

	test('restricted_criteria reaches the wire, apart from blind_criteria', async () => {
		const body = await answer();
		// Two different statements, carried separately: "nobody recorded this"
		// (about the data) and "you may not read this" (about the caller). One
		// list holding both would let a curator conclude their catalogue is empty
		// where it is only closed to them.
		expect(body.restricted_criteria).toEqual(['findspot']);
		expect(body.blind_criteria).toEqual(['mint']);
	});

	test("a restricted OUTCOME says so, and does not pass as 'not recorded'", async () => {
		const body = await answer();
		const outcome = body.results[0]?.outcomes.find((o) => o.criterion_id === 'findspot') as
			| { restricted?: boolean; agreed: boolean | null; detail: string }
			| undefined;
		expect(outcome?.restricted).toBe(true);
		// It arrives with agreed=null, which is the whole problem the marker
		// solves: without it the row is indistinguishable from "neither record
		// states this", and the security property (the CONSTANT detail, never a
		// value) is what makes the row otherwise silent.
		expect(outcome?.agreed).toBeNull();
		expect(outcome?.detail).toBe('not readable by this caller');
	});

	test('the GATE marks itself, so its declared weight is not read as a contribution', async () => {
		const body = await answer();
		const gate = body.results[0]?.outcomes.find((o) => o.criterion_id === 'legend');
		expect(gate?.required).toBe(true);
		// The declared weight still travels — that is what the curator authored —
		// which is precisely why the marker has to travel with it.
		expect(gate?.weight).toBe(6);
	});

	test('an ordinary outcome carries neither marker', async () => {
		// Both are emitted only when true, so the common row keeps its shape and
		// a client can test one thing (`=== true`).
		const body = await answer();
		const ordinary = body.results[0]?.outcomes.find((o) => o.criterion_id === 'symbol');
		expect(ordinary).toBeDefined();
		expect('restricted' in (ordinary as object)).toBe(false);
		expect('required' in (ordinary as object)).toBe(false);
	});
});

describe('registration', () => {
	test('the class exposes exactly its four actions', () => {
		// identify_by_image is gated in identify_by_image.test.ts, get_proposals in
		// identify_proposals_api.test.ts and resolve_type_link in
		// identify_type_link.test.ts; asserted here so the class's surface stays a
		// closed, reviewed list — and so a WRITE action appearing on it would fail a
		// test rather than pass review (promotion writes through the ordinary
		// component save, from the client, and adds no write door here).
		expect(Object.keys(identifyApiActions)).toEqual([
			'find_matches',
			'identify_by_image',
			'get_proposals',
			'resolve_type_link',
		]);
	});

	test('dd_identify_api:find_matches is registered, and requires a session', async () => {
		// A REGISTERED action with no session is 401 not_logged; an unregistered
		// (class, action) pair is 400. The pair of assertions is what proves the
		// registration rather than assuming it.
		const anonymous: ApiRequestContext = {
			requestId: 'test',
			clientIp: '127.0.0.1',
			session: null,
			csrfCandidate: null,
		};
		const registered = await dispatchRqo(
			{ action: 'find_matches', dd_api: 'dd_identify_api', options: {} } as Rqo,
			anonymous,
		);
		expect(registered.status).toBe(401);
		expect((registered.body.error as { code: string }).code).toBe('auth.not_logged');

		const unregistered = await dispatchRqo(
			{ action: 'identify_everything', dd_api: 'dd_identify_api', options: {} } as Rqo,
			anonymous,
		);
		expect(unregistered.status).toBe(400);
	});
});

describe('find_matches — the pictures', () => {
	/** A match report with one candidate, so the wire shape has something to carry. */
	const oneResult = () => ({
		results: [
			{
				sectionTipo: 'test3',
				sectionId: 42,
				score: 1,
				verdict: 'same_type' as const,
				outcomes: [],
			},
		],
		moreAvailable: false,
		blindCriteria: [],
		restrictedCriteria: [],
	});

	test('the seed and every candidate carry a thumb_url when one was resolved', async () => {
		let asked: { previewComponent: string | null; records: unknown } | null = null;
		const res = await buildFindMatches(
			fakeDeps({
				loadProfile: async () => parseProfile({ ...textProfile(), previewComponent: 'test99' }),
				runMatches: async () => oneResult(),
				resolveThumbs: async (previewComponent, records) => {
					asked = { previewComponent, records };
					return new Map([['test3_42', '/media/image/thumb/0/test99_test3_42.jpg']]);
				},
			}),
		)(rqo({ section_tipo: 'test3', section_id: 7 }), ctx(SUPERUSER));

		const body = res.body.data as {
			seed: { thumb_url: string | null };
			results: Array<{ thumb_url: string | null }>;
		};
		expect(body.results[0]?.thumb_url).toBe('/media/image/thumb/0/test99_test3_42.jpg');
		// The seed has no generated thumb here: null, never a URL to nothing.
		expect(body.seed.thumb_url).toBeNull();
		// Only the records the answer already names are asked about — the resolver
		// is a renderer's convenience, never a second read path.
		expect(asked).not.toBeNull();
		expect((asked as unknown as { previewComponent: string }).previewComponent).toBe('test99');
		expect((asked as unknown as { records: unknown[] }).records).toEqual([
			{ sectionTipo: 'test3', sectionId: 7 },
			{ sectionTipo: 'test3', sectionId: 42 },
		]);
	});

	/**
	 * P1-3 / SEC-10. The previewComponent is a media component of the record's
	 * section, and its thumb URL is a read of it — `vision.ts` gates that exact
	 * field. A caller with level 0 on it gets null, and the resolver is NEVER
	 * handed the record (the resolver is a renderer's convenience, not a gate).
	 */
	test('a previewComponent the caller may not read: thumb_url null, and the resolver is never asked', async () => {
		let asked = false;
		const grantsAsked: string[] = [];
		const res = await buildFindMatches(
			fakeDeps({
				loadProfile: async () => parseProfile({ ...textProfile(), previewComponent: 'test99' }),
				runMatches: async () => oneResult(),
				componentGrant: async (_principal, sectionTipo, componentTipo) => {
					grantsAsked.push(`${sectionTipo}|${componentTipo}`);
					return componentTipo === 'test99' ? 0 : 1;
				},
				resolveThumbs: async () => {
					asked = true;
					return new Map([['test3_42', '/media/image/thumb/0/test99_test3_42.jpg']]);
				},
			}),
		)(rqo({ section_tipo: 'test3', section_id: 7 }), ctx(NO_ACCESS));
		expect(res.body.ok).toBe(true);
		const body = res.body.data as {
			seed: { thumb_url: string | null };
			results: Array<{ thumb_url: string | null }>;
		};
		expect(body.seed.thumb_url).toBeNull();
		expect(body.results).toHaveLength(1);
		expect(body.results[0]?.thumb_url).toBeNull();
		expect(asked).toBe(false);
		// The grant was asked ONCE per section (seed + candidate share test3):
		// the door's pair — the section, then the preview component.
		expect(grantsAsked).toEqual(['test3|test3', 'test3|test99']);
	});

	test('a profile with no previewComponent still answers, with null thumbs', async () => {
		// The common case: most sections will never declare a picture component.
		const res = await buildFindMatches({
			...fakeDeps({ runMatches: async () => oneResult() }),
			resolveThumbs: undefined,
		})(rqo({ section_tipo: 'test3', section_id: 7 }), ctx(SUPERUSER));

		const body = res.body.data as {
			seed: { thumb_url: string | null };
			results: Array<{ thumb_url: string | null }>;
		};
		expect(res.body.ok).toBe(true);
		expect(body.seed.thumb_url).toBeNull();
		expect(body.results[0]?.thumb_url).toBeNull();
	});
});
