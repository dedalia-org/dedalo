/**
 * CRAP item 2.23b — `get_tags_info`
 * (api/handlers/dd_component_text_area_api.ts:25), the resolved-tag feed of a
 * transcription (tool_tr_print's only source).
 *
 * Branch inventory of the ACTION (buildTagsInfo itself is gated elsewhere;
 * what is pinned here is the door: argument refusals, the AUTHZ-01 read
 * door, the lang choice and the unknown-type report), in execution order:
 *  1. requirePrincipal — no anonymous read;
 *  2. coordinate refusal: missing tipo / section_tipo / section_id ⇒
 *     `request.invalid_source`. `section_id: 0` is NOT a coordinate refusal —
 *     it survives to the read door (and is refused there, by the record-scope
 *     step's `sectionId < 1`, as `perm.out_of_scope`);
 *  3. AUTHZ-01 (WC-077 as amended by WC-2026-11-10-tags-info-read-door): the
 *     write door's READ mode — section >= 1, the text_area's pair grant, the
 *     record scope — decided BEFORE the options (an unauthorized caller learns
 *     nothing about the action's grammar); NO tags shape leaks. The grant
 *     PAIRS (reader vs control) and the hops live in tags_info_read_door_native;
 *  4. options refusal: absent `ar_type`, a non-array, or an array with no
 *     string ⇒ `request.invalid_options`;
 *  5. lang: `source.lang` when a non-empty string, else currentDataLang();
 *     the transcription text is per-lang, so the wrong lang resolves nothing;
 *  6. unknown requested types are NAMED in `msg` (never silently narrowed),
 *     known-only ⇒ `msg === []`.
 *
 * Scratch surface (namespace: zztags1 ids 934100-934199): one zztags1/934100 row —
 * a zztags2 transcription (lg-spa ONLY) carrying a note mark, plus a zztags3
 * index locator. Direct INSERT (no counter bump); swept in afterAll with its
 * matrix_time_machine tail, fail-loud on residue. The note mark points at
 * zztags4/934101, a record that deliberately does NOT exist (the missing-note
 * ddo defaults are the deterministic, in-namespace shape); no zztags4 row is
 * ever written. The dd_ontology writes are the situation's own (reserved `zztags`
 * TLD), torn down with it.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule: a test uses
// the generic `test` TLD and BUILDS the situation it tests). A plain rename was NOT
// possible here: this gate's subject is the `tags_index` / `tags_notes` PROPERTIES a
// text_area declares, and no shipped `test` component declares them. So the whole
// shape is built as a reserved `zztags` scratch ontology — the text_area, the
// autocomplete_hi its tags_index points at, the note section and the three note
// components (title/body/publishable) — copied field for field from the shipped
// zztags2 pair this gate used to read. `dropSituation` sweeps it and the residue is
// ASSERTED, so the scratch surface stays a scratch surface.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { componentTextAreaApiActions } from '../../src/core/api/handlers/dd_component_text_area_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import type { Session } from '../../src/core/security/session_store.ts';
import { dropSituation, ensureSituation } from '../../src/core/test_data/situations/situation.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	ZZTAGS_NOTE_SECTION,
	ZZTAGS_SECTION,
	ZZTAGS_SITUATION,
	ZZTAGS_TAGS_INDEX,
	ZZTAGS_TEXT_AREA,
} from '../helpers/zztags_situation.ts';

const SECTION = ZZTAGS_SECTION; // the host section (its own matrix_table → matrix_test)
const SECTION_ID = 934100; // scratch band 934100-934199
const TEXT_AREA = ZZTAGS_TEXT_AREA; // component_text_area, translatable; declares tags_index/tags_notes
const TAGS_INDEX = ZZTAGS_TAGS_INDEX; // component_autocomplete_hi — the tags_index target
const NOTE_SECTION = ZZTAGS_NOTE_SECTION; // properties.tags_notes key — never written by this file
const MISSING_NOTE_ID = '934101'; // deliberately absent record

/**
 * The shape this gate is ABOUT, built rather than borrowed — ONE definition
 * shared with tags_info_read_door_native (test/helpers/zztags_situation.ts). The
 * host is PROJECT-GATED by its component_filter (zztags8): without it the
 * record-scope gate would have nothing to enforce and the AUTHZ case below would
 * pass for every principal.
 */
const TAGS_SITUATION = ZZTAGS_SITUATION;

/** Resolved after the situation exists — never assumed (a scratch section has its own table). */
let TABLE = 'matrix_test';

const SPA_TEXT =
	'<p>uno [index-n-1-Person-data:x:data]dos[/index-n-1] tres' +
	` [note-a-1-data:{'section_tipo':'${NOTE_SECTION}','section_id':'${MISSING_NOTE_ID}'}:data] fin.</p>`;

/** The SUPERUSER (root, -1): the read door's section + pair steps answer it by rule. */
const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** No user record, hence no projects: every non-admin record scope check fails. */
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

const contextFor = (principal: Principal): ApiRequestContext => ({
	requestId: 'crap-2-23b',
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
	requestId: 'crap-2-23b',
	clientIp: '127.0.0.1',
	session: null,
	csrfCandidate: null,
});

const rqoOf = (source: unknown, options?: unknown): Rqo =>
	({
		action: 'get_tags_info',
		dd_api: 'dd_component_text_area_api',
		source,
		options,
	}) as unknown as Rqo;

const getTagsInfo = mustGet(componentTextAreaApiActions.get_tags_info, 'get_tags_info handler');

/** The full host source, with optional lang override. */
const hostSource = (extra: Record<string, unknown> = {}) => ({
	tipo: TEXT_AREA,
	section_tipo: SECTION,
	section_id: SECTION_ID,
	...extra,
});

async function purgeScratch(): Promise<void> {
	await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
		SECTION,
		SECTION_ID,
	]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		SECTION,
		SECTION_ID,
	]);
}

beforeAll(async () => {
	await ensureSituation(TAGS_SITUATION);
	TABLE = (await getMatrixTableFromTipo(SECTION)) ?? 'matrix_test';
	await purgeScratch(); // belt and braces: a crashed earlier run
	await sql.unsafe(
		`INSERT INTO ${TABLE} (section_id, section_tipo, string, relation) VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
		[
			SECTION_ID,
			SECTION,
			JSON.stringify({ [TEXT_AREA]: [{ id: 1, lang: 'lg-spa', value: SPA_TEXT }] }),
			JSON.stringify({
				[TAGS_INDEX]: [
					{
						id: 1,
						type: 'dd151',
						section_id: 1, // NUMERIC on purpose: the wire law stringifies it
						section_tipo: 'test3',
						from_component_tipo: TAGS_INDEX,
					},
				],
			}),
		],
	);
});

afterAll(async () => {
	await purgeScratch();
	const residue = (await sql.unsafe(
		`SELECT id FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, SECTION_ID],
	)) as unknown[];
	const tmResidue = (await sql.unsafe(
		'SELECT id FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
		[SECTION, SECTION_ID],
	)) as unknown[];
	// The note target must never have been created by this file.
	const noteResidue = (await sql.unsafe(
		`SELECT id FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[NOTE_SECTION, Number(MISSING_NOTE_ID)],
	)) as unknown[];
	if (residue.length > 0 || tmResidue.length > 0 || noteResidue.length > 0) {
		throw new Error(
			`scratch residue: ${residue.length} matrix + ${tmResidue.length} TM row(s) for ${SECTION}/${SECTION_ID}, ${noteResidue.length} ${NOTE_SECTION} row(s)`,
		);
	}
	// The scratch ONTOLOGY goes too. This call was missing while the header
	// claimed it ran (review 2026-08-20): the eight `zztags*` dd_ontology nodes
	// survived every green run and stayed visible to every process-wide registry
	// build. Residue asserted, not trusted.
	expect(await dropSituation(TAGS_SITUATION)).toBe(0);
});

/**
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md §4): each refusal is a THROWN
 * registry code (the old `bad_source` / `bad_options` / `forbidden` tokens,
 * mapped through LEGACY_TOKEN_MAP). The CODE is the contract now — the PHP
 * prose bytes are gone from the wire by design.
 */
const BAD_SOURCE_CODE = 'request.invalid_source';
const BAD_OPTIONS_CODE = 'request.invalid_options';
const FORBIDDEN_CODE = 'perm.denied';

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

describe('get_tags_info — argument refusals', () => {
	test('no seeded principal ⇒ requirePrincipal throws (never an anonymous feed)', async () => {
		await expect(
			getTagsInfo(rqoOf(hostSource(), { ar_type: ['index'] }), contextWithoutPrincipal()),
		).rejects.toThrow(/no authenticated principal/);
	});

	test('each missing coordinate ⇒ bad_source, byte-exact', async () => {
		const cases: unknown[] = [
			{},
			{ section_tipo: SECTION, section_id: SECTION_ID }, // no tipo
			{ tipo: TEXT_AREA, section_id: SECTION_ID }, // no section_tipo
			{ tipo: TEXT_AREA, section_tipo: SECTION }, // no section_id
			{ tipo: TEXT_AREA, section_tipo: SECTION, section_id: null },
			{ tipo: '', section_tipo: SECTION, section_id: SECTION_ID },
		];
		for (const source of cases) {
			const refusal = await refusalOf(
				getTagsInfo(rqoOf(source, { ar_type: ['index'] }), contextFor(ADMIN)),
			);
			expect(refusal.code).toBe(BAD_SOURCE_CODE);
			expect(refusal.spec.status).toBe(400);
		}
	});

	test('section_id 0 is NOT a coordinate refusal — it reaches the read door', async () => {
		const refusal = await refusalOf(
			getTagsInfo(
				rqoOf({ tipo: TEXT_AREA, section_tipo: SECTION, section_id: 0 }, { ar_type: ['index'] }),
				contextFor(ADMIN),
			),
		);
		// Admin, so the ONLY thing that can refuse here is the scope step's
		// `sectionId < 1` (perm.out_of_scope) — proving the coordinate check let
		// 0 through.
		expect(refusal.code).toBe('perm.out_of_scope');
	});

	test('a missing / non-array / string-less ar_type ⇒ bad_options, byte-exact', async () => {
		const cases: unknown[] = [
			undefined,
			{},
			{ ar_type: 'index' },
			{ ar_type: [] },
			{ ar_type: [42] },
		];
		for (const options of cases) {
			const refusal = await refusalOf(getTagsInfo(rqoOf(hostSource(), options), contextFor(ADMIN)));
			expect(refusal.code).toBe(BAD_OPTIONS_CODE);
			// PUBLIC disclosure: the vetted sentence names the field, not the value.
			expect(refusal.publicMessage).toBe('options.ar_type must be a non-empty array of tag types');
		}
	});

	test('the read door is decided BEFORE the options refusal', async () => {
		// An unauthorized caller on a bad-options request gets perm.denied, never
		// request.invalid_options: the order in the handler is coordinates →
		// authz → options (delete_tag's order; WC-2026-11-10-tags-info-read-door
		// flips the earlier arguments-first pin).
		const refusal = await refusalOf(
			getTagsInfo(rqoOf(hostSource(), { ar_type: [] }), contextFor(NO_ACCESS)),
		);
		expect(refusal.code).toBe(FORBIDDEN_CODE);
	});
});

describe('get_tags_info — AUTHZ-01 read door', () => {
	test('an EXISTING record, a caller with no grant and no scope ⇒ forbidden envelope, no tags shape', async () => {
		const refusal = await refusalOf(
			getTagsInfo(rqoOf(hostSource(), { ar_type: ['index', 'note'] }), contextFor(NO_ACCESS)),
		);
		expect(refusal.code).toBe(FORBIDDEN_CODE);
		expect(refusal.spec.status).toBe(403);
	});

	test('the SAME record + an admin principal passes the gate (the refusal is scope, not fixture)', async () => {
		const result = await getTagsInfo(
			rqoOf(hostSource(), { ar_type: ['index'] }),
			contextFor(ADMIN),
		);
		const body = result.body as { ok: boolean; data: { tags_index?: unknown[] } };
		expect(body.ok).toBe(true);
		expect(body.data.tags_index).toHaveLength(1);
	});
});

describe('get_tags_info — resolved payload', () => {
	test('index tags come back with INT ids (WC-077/WC-065) and their term label', async () => {
		const result = await getTagsInfo(
			rqoOf(hostSource(), { ar_type: ['index'] }),
			contextFor(ADMIN),
		);
		expect(result.status).toBe(200);
		const body = result.body as unknown as {
			data: { tags_index: unknown[] };
			unknown_types: string[];
		};
		expect(body.unknown_types).toEqual([]);
		expect(body.data.tags_index).toEqual([
			{
				data: {
					id: 1,
					type: 'dd151',
					// WC-2026-08-10-section-id-int-canonical: emitted as the INT the
					// stored locator already held (repeals the stringify).
					section_id: 1,
					section_tipo: 'test3',
					from_component_tipo: TAGS_INDEX,
				},
				label: 'input text content of one', // canonical test3/1
			},
		]);
	});

	test('an unknown type is NAMED in msg and never silently narrows the payload', async () => {
		const result = await getTagsInfo(
			rqoOf(hostSource(), { ar_type: ['index', 'not_a_type'] }),
			contextFor(ADMIN),
		);
		// Never silently narrow: the unresolvable type is NAMED — as the owned
		// top-level `unknown_types` key now that the prose channel is gone.
		const body = result.body as unknown as {
			data: { tags_index?: unknown[] };
			unknown_types: string[];
		};
		expect(body.unknown_types).toEqual(['not_a_type']);
		expect(body.data.tags_index).toHaveLength(1); // the known type still resolved
	});

	test('several unknown types are joined in one message', async () => {
		const result = await getTagsInfo(
			rqoOf(hostSource(), { ar_type: ['zzz_one', 'index', 'zzz_two'] }),
			contextFor(ADMIN),
		);
		expect((result.body as unknown as { unknown_types: string[] }).unknown_types).toEqual([
			'zzz_one',
			'zzz_two',
		]);
	});
});

describe('get_tags_info — the lang of the transcription', () => {
	/** buildTagsInfo can OMIT a key entirely, so never compare `undefined` to []. */
	const notesOf = (result: { body: unknown }): unknown[] =>
		((result.body as { data: { tags_notes?: unknown[] } }).data.tags_notes ?? []) as unknown[];

	test("source.lang 'lg-spa' resolves the note marks of the lg-spa text", async () => {
		const result = await getTagsInfo(
			rqoOf(hostSource({ lang: 'lg-spa' }), { ar_type: ['note'] }),
			contextFor(ADMIN),
		);
		expect(notesOf(result)).toEqual([
			{
				// WC-2026-08-10-section-id-int-canonical: the address parsed out of the
				// note MARK (which keeps its quoted grammar) is emitted canonical int.
				data: { section_tipo: NOTE_SECTION, section_id: Number(MISSING_NOTE_ID) },
				// the note RECORD does not exist: text ddos default to [], bool to false
				title: [],
				body: [],
				publishable: false,
			},
		]);
	});

	test("source.lang 'lg-eng' resolves NOTHING — the text is stored only in lg-spa", async () => {
		const result = await getTagsInfo(
			rqoOf(hostSource({ lang: 'lg-eng' }), { ar_type: ['note'] }),
			contextFor(ADMIN),
		);
		expect(notesOf(result)).toEqual([]);
	});

	test('an empty / absent source.lang falls back to currentDataLang (lg-spa here)', async () => {
		for (const source of [hostSource({ lang: '' }), hostSource()]) {
			const result = await getTagsInfo(rqoOf(source, { ar_type: ['note'] }), contextFor(ADMIN));
			expect(notesOf(result)).toHaveLength(1);
		}
	});

	test('a non-string source.lang is ignored (same fallback)', async () => {
		const result = await getTagsInfo(
			rqoOf(hostSource({ lang: 42 }), { ar_type: ['note'] }),
			contextFor(ADMIN),
		);
		expect(notesOf(result)).toHaveLength(1);
	});
});
