/**
 * READ-DOOR ACL — the behavioural gate: every door classified `component` in
 * `READ_DOOR_POSTURE` (src/core/security/read_door.ts) is PROBED here with the
 * real permission resolver, on the suite database, and each probe is a PAIR
 * (P1-3 — SEC-04, SEC-06, SEC-10, SEC-11, SEC-12, SEC-13).
 *
 * THE SITUATION. `test/helpers/read_door_identity_fixture.ts` mints two
 * NON-ADMIN readers, identical except on the grants under test: the READER
 * holds level 0 on test3's `test91` (select), `test99` (image), `test80`
 * (portal) and `test96` (button_delete) and no grant on `test2`; the CONTROL
 * holds them. `test/helpers/acl_identity_fixture.ts` adds a GLOBAL ADMIN whose
 * profile grants `test3.test92` but NOT `test3.test52` — the raw GET view's
 * identity, which proves an admin resolves through their profile like the
 * human read. The superuser (-1) is the record-scope positive control.
 *
 * EVERY ASSERTION IS A PAIR: the reader is refused (a registry code) or
 * narrowed (an EXACT shape with the key absent / null), and the control on the
 * IDENTICAL call is served (an EXACT shape with the key present). A door that
 * refuses everything, or serves everything, reddens on one of the two. The
 * fixture's contrast is asserted through the real doors first, so a degraded
 * fixture cannot turn the pairs into zero-versus-zero.
 *
 * THE DOORS PROBED — TOTAL over `posture: 'component'` entries naming this
 * file (read_door_acl_tripwire block B asserts each is named here):
 *   dd_core_api:read_raw               (three arms, through dispatchRqo)
 *   dd_core_api:get_element_context    (section buttons per grant)
 *   dd_identify_api:find_matches       (the preview thumb)
 *   dd_identify_api:identify_by_image  (the section grant with an OMITTED scope)
 *   mcp:dedalo_get_media_info          (the component gate before the column read;
 *                                       the section granted to neither → refused)
 *   mcp:dedalo_search_section          (SEC-1: the section grant BEFORE the
 *   mcp:dedalo_search_records           assembler — a readerless section is
 *   mcp:dedalo_count_records            perm.denied, never a projects-filtered
 *                                       page; find_or_create inherits it)
 *   mcp:dedalo_read_record             (the section grant the human read's Gate B
 *                                       applies, at the tool door)
 *   GET /dedalo/core/api/v1/raw        (the admin's profile projects the row)
 *   GET /dedalo/core/api/v1/map_tile   (the component key on the geolocation, with the tile
 *                                       already in the memory: the denied reader is refused)
 *
 *   ai/rag/retrieval.ts aclGate     (the chokepoint under identify_by_image /
 *                                    similar_objects / search_by_text_image:
 *                                    the section grant on an IMAGE chunk)
 *
 * SCRATCH: one `test3` row (938001) and one `test2` row (938002) in
 * matrix_test, swept with a throw-if-nothing-deleted; the identity fixtures
 * sweep themselves.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findOrCreate } from '../../src/ai/mcp/tools/fields_write.ts';
import { getMediaInfo } from '../../src/ai/mcp/tools/media.ts';
import { readSectionRecord, searchSectionRecords } from '../../src/ai/mcp/tools/records_read.ts';
import { countRecords, searchRecords } from '../../src/ai/mcp/tools/search.ts';
import { aclFilterCandidates } from '../../src/ai/rag/retrieval.ts';
import type { Candidate } from '../../src/ai/rag/types.ts';
import { config } from '../../src/config/config.ts';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import {
	buildFindMatches,
	buildIdentifyByImage,
	type IdentifyByImageDeps,
} from '../../src/core/api/handlers/dd_identify_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { clearTileCacheForTests, rememberTile } from '../../src/core/geo/tile_proxy/tile_cache.ts';
import { parseProfile } from '../../src/core/identify/profile.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { handleRequest } from '../../src/server.ts';
import {
	ACL_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import {
	DOOR_BUTTON_DELETE,
	DOOR_BUTTON_NEW,
	DOOR_CONTROL_USER_ID,
	DOOR_FILTER,
	DOOR_GEO,
	DOOR_IMAGE,
	DOOR_MEDIA_ONLY_USER_ID,
	DOOR_PUBLICATION,
	DOOR_READER_USER_ID,
	DOOR_SECTION,
	DOOR_SELECT,
	DOOR_SIBLING_SECTION,
	DOOR_TEXT,
	doorProjectLocator,
	installReadDoorIdentityFixture,
	removeReadDoorIdentityFixture,
} from '../helpers/read_door_identity_fixture.ts';
import {
	markReadDoorProbed,
	READ_DOOR_PROBED,
	readDoorLegsCompleted,
} from '../helpers/read_door_probes.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const TABLE = 'matrix_test';
const RECORD_ID = 938001;
/** A SIBLING-section (test2) row, in the readers' project — the RAG chunk's record. */
const SIBLING_RECORD_ID = 938002;
const BAND_LOW = 938000;
const BAND_HIGH = 938999;
const TEXT_VALUE = 'zzdoor the text both readers may read';
const SELECT_VALUE = {
	id: 1,
	type: 'dd151',
	section_id: 2,
	section_tipo: 'dd64',
	from_component_tipo: DOOR_SELECT,
};
const PUBLICATION_VALUE = {
	id: 1,
	type: 'dd151',
	section_id: 1,
	section_tipo: 'dd64',
	from_component_tipo: DOOR_PUBLICATION,
};
/** A geolocation entry holding one stored xyz source (id 1) — the tile proxy's door. */
const GEO_VALUE = {
	id: 1,
	lat: 39.47,
	lon: -0.37,
	zoom: 5,
	sources: [
		{
			id: 1,
			type: 'xyz',
			url: 'https://tiles.example.org/{z}/{x}/{y}.png',
			params: {},
			attribution: '',
		},
	],
};
const IMAGE_FILE_PATH = `/image/original/0/${DOOR_IMAGE}_${DOOR_SECTION}_${RECORD_ID}.jpg`;
const SIBLING_IMAGE_FILE_PATH = `/image/original/0/${DOOR_IMAGE}_${DOOR_SIBLING_SECTION}_${SIBLING_RECORD_ID}.jpg`;

let reader: Principal;
let control: Principal;
let mediaOnly: Principal;
let admin: Principal;
let superuser: Principal;

function contextFor(principal: Principal, username: string): ApiRequestContext {
	const token = createSession(principal.userId, username, principal.isGlobalAdmin);
	const session = getSession(token);
	return {
		requestId: 'read-door-gate',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal,
	} as ApiRequestContext;
}

/** The handler-direct context (no session needed; requirePrincipal reads `principal`). */
const handlerContext = (principal: Principal): ApiRequestContext =>
	({
		requestId: 'read-door-gate',
		clientIp: '127.0.0.1',
		session: null,
		csrfCandidate: null,
		principal,
	}) as ApiRequestContext;

const rqo = (options: Record<string, unknown>): Rqo => ({ options }) as unknown as Rqo;

async function refusalOf(call: Promise<unknown>): Promise<DedaloError> {
	const outcome = await call.then(
		(value) => ({ threw: false as const, value }),
		(error: unknown) => ({ threw: true as const, error }),
	);
	if (!outcome.threw) throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`);
	if (!(outcome.error instanceof DedaloError)) throw outcome.error;
	return outcome.error;
}

async function insertScratch(
	sectionId: number,
	columns: Record<string, unknown>,
	sectionTipo: string = DOOR_SECTION,
) {
	if (sectionId < BAND_LOW || sectionId > BAND_HIGH) throw new Error('outside the scratch band');
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [sectionTipo, sectionId];
	let index = 3;
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		placeholders.push(`$${index}::text::jsonb`);
		params.push(encodeForJsonb(value));
		index++;
	}
	await sql.unsafe(
		`INSERT INTO "${TABLE}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

async function sweep(strict: boolean) {
	const removed = (await sql.unsafe(
		`DELETE FROM "${TABLE}" WHERE section_tipo IN ($1, $2) AND section_id BETWEEN $3 AND $4 RETURNING section_id`,
		[DOOR_SECTION, DOOR_SIBLING_SECTION, BAND_LOW, BAND_HIGH],
	)) as unknown[];
	await sql.unsafe(
		'DELETE FROM matrix_time_machine WHERE section_tipo IN ($1, $2) AND section_id BETWEEN $3 AND $4',
		[DOOR_SECTION, DOOR_SIBLING_SECTION, BAND_LOW, BAND_HIGH],
	);
	if (strict && removed.length !== 2) {
		throw new Error(`read_door gate sweep removed ${removed.length} rows, expected 2`);
	}
}

/**
 * A behavioural leg of ONE posture door: the body's assertions run, THEN the
 * door is registered as probed (test/helpers/read_door_probes.ts). A leg that
 * throws never registers — the census test at the end of this file is red.
 */
function leg(door: string, title: string, body: () => Promise<void>): void {
	test(title, async () => {
		await body();
		markReadDoorProbed(door);
	});
}

describe.if(DB_READY)('read door ACL — every component door, paired', () => {
	beforeAll(async () => {
		await installReadDoorIdentityFixture();
		await installAclIdentityFixture();
		await sweep(false);
		await insertScratch(RECORD_ID, {
			string: { [DOOR_TEXT]: [{ id: 1, lang: 'lg-eng', value: TEXT_VALUE }] },
			relation: {
				[DOOR_FILTER]: [doorProjectLocator()],
				[DOOR_SELECT]: [SELECT_VALUE],
				[DOOR_PUBLICATION]: [PUBLICATION_VALUE],
			},
			media: {
				[DOOR_IMAGE]: [
					{
						id: 1,
						files_info: [
							{
								quality: 'original',
								file_exist: true,
								file_path: IMAGE_FILE_PATH,
								extension: 'jpg',
							},
						],
					},
				],
			},
			geo: { [DOOR_GEO]: [GEO_VALUE] },
		});
		await insertScratch(
			SIBLING_RECORD_ID,
			{
				string: { [DOOR_TEXT]: [{ id: 1, lang: 'lg-eng', value: 'zzdoor sibling text' }] },
				relation: { test41: [{ ...doorProjectLocator(), from_component_tipo: 'test41' }] },
				media: {
					[DOOR_IMAGE]: [
						{
							id: 1,
							files_info: [
								{
									quality: 'original',
									file_exist: true,
									file_path: SIBLING_IMAGE_FILE_PATH,
									extension: 'jpg',
								},
							],
						},
					],
				},
			},
			DOOR_SIBLING_SECTION,
		);
		reader = await resolvePrincipal(DOOR_READER_USER_ID);
		control = await resolvePrincipal(DOOR_CONTROL_USER_ID);
		mediaOnly = await resolvePrincipal(DOOR_MEDIA_ONLY_USER_ID);
		admin = await resolvePrincipal(ACL_ADMIN_USER_ID);
		superuser = await resolvePrincipal(-1);
	});

	afterAll(async () => {
		await sweep(true);
		await removeAclIdentityFixture();
		await removeReadDoorIdentityFixture();
	});

	test('the contrast is live, through the real doors (guards every pair below)', async () => {
		expect(reader.isGlobalAdmin).toBe(false);
		expect(control.isGlobalAdmin).toBe(false);
		expect(admin.isGlobalAdmin).toBe(true);
		for (const identity of [reader, control]) {
			expect(await getPermissions(identity, DOOR_SECTION, DOOR_SECTION)).toBe(2);
			expect(await getPermissions(identity, DOOR_SECTION, DOOR_TEXT)).toBe(1);
		}
		expect(await getPermissions(reader, DOOR_SECTION, DOOR_SELECT)).toBe(0);
		expect(await getPermissions(control, DOOR_SECTION, DOOR_SELECT)).toBe(1);
		expect(await getPermissions(reader, DOOR_SECTION, DOOR_IMAGE)).toBe(0);
		expect(await getPermissions(control, DOOR_SECTION, DOOR_IMAGE)).toBe(1);
		expect(await getPermissions(reader, DOOR_SIBLING_SECTION, DOOR_SIBLING_SECTION)).toBe(0);
		expect(await getPermissions(control, DOOR_SIBLING_SECTION, DOOR_SIBLING_SECTION)).toBe(1);
		// The media-only reader: the sibling's component WITHOUT the sibling section.
		expect(mediaOnly.isGlobalAdmin).toBe(false);
		expect(await getPermissions(mediaOnly, DOOR_SIBLING_SECTION, DOOR_TEXT)).toBe(1);
		expect(await getPermissions(mediaOnly, DOOR_SIBLING_SECTION, DOOR_IMAGE)).toBe(1);
		expect(await getPermissions(mediaOnly, DOOR_SIBLING_SECTION, DOOR_SIBLING_SECTION)).toBe(0);
		expect(await getPermissions(control, DOOR_SIBLING_SECTION, DOOR_IMAGE)).toBe(1);
		expect(await getPermissions(control, DOOR_SIBLING_SECTION, DOOR_SIBLING_SECTION)).toBe(1);
		// The admin's profile: test92 yes, test52 NO — no admin bypass on the key.
		expect(await getPermissions(admin, DOOR_SECTION, DOOR_PUBLICATION)).toBeGreaterThanOrEqual(1);
		expect(await getPermissions(admin, DOOR_SECTION, DOOR_TEXT)).toBe(0);
		expect(await getPermissions(superuser, DOOR_SECTION, DOOR_TEXT)).toBe(3);
	});

	/* ───────────────────────── dd_core_api:read_raw ───────────────────────── */

	describe('dd_core_api:read_raw', () => {
		const sqo = () => ({
			section_tipo: [DOOR_SECTION],
			filter_by_locators: [{ section_tipo: DOOR_SECTION, section_id: RECORD_ID }],
			limit: 5,
		});
		const call = (principal: Principal, options: Record<string, unknown>) =>
			dispatchRqo(
				{ action: 'read_raw', dd_api: 'dd_core_api', options, sqo: sqo() } as never,
				contextFor(principal, `zzdoor_${principal.userId}`) as never,
			);

		leg(
			'dd_core_api:read_raw',
			"'component' arm: the denied tipo is perm.denied for the reader, served to the control",
			async () => {
				const refused = await call(reader, {
					section_tipo: DOOR_SECTION,
					tipo: DOOR_SELECT,
					type: 'component',
				});
				expect(refused.status).toBe(403);
				expect((refused.body as { error?: { code?: string } }).error?.code).toBe('perm.denied');
				expect(JSON.stringify(refused.body)).not.toContain('dd64');

				const served = await call(control, {
					section_tipo: DOOR_SECTION,
					tipo: DOOR_SELECT,
					type: 'component',
				});
				expect(served.status).toBe(200);
				expect((served.body as unknown as { data: unknown[] }).data).toEqual([[SELECT_VALUE]]);
			},
		);

		leg(
			'dd_core_api:read_raw',
			"'section' arm: the row is projected to the reader's keys, with ONE notice; whole for the control, no notice",
			async () => {
				const narrowed = await call(reader, {
					section_tipo: DOOR_SECTION,
					tipo: DOOR_SECTION,
					type: 'section',
				});
				expect(narrowed.status).toBe(200);
				const narrowedBody = narrowed.body as unknown as {
					data: {
						relation: Record<string, unknown>;
						string: Record<string, unknown>;
						media: Record<string, unknown>;
					}[];
					notices?: { code: string }[];
				};
				expect(Object.keys(narrowedBody.data[0]?.relation ?? {}).sort()).toEqual(
					[DOOR_FILTER, DOOR_PUBLICATION].sort(),
				);
				expect(narrowedBody.data[0]?.string).toEqual({
					[DOOR_TEXT]: [{ id: 1, lang: 'lg-eng', value: TEXT_VALUE }],
				});
				expect(narrowedBody.data[0]?.media).toEqual({});
				expect(narrowedBody.notices?.map((notice) => notice.code)).toEqual(['perm.out_of_scope']);

				const served = await call(control, {
					section_tipo: DOOR_SECTION,
					tipo: DOOR_SECTION,
					type: 'section',
				});
				const servedBody = served.body as unknown as {
					data: { relation: Record<string, unknown>; media: Record<string, unknown> }[];
					notices?: unknown;
				};
				expect(Object.keys(servedBody.data[0]?.relation ?? {}).sort()).toEqual(
					[DOOR_FILTER, DOOR_SELECT, DOOR_PUBLICATION].sort(),
				);
				expect(Object.keys(servedBody.data[0]?.media ?? {})).toEqual([DOOR_IMAGE]);
				expect(servedBody.notices).toBeUndefined();
			},
		);

		leg(
			'dd_core_api:read_raw',
			"'target_section' arm: the locators under the denied select key are not harvested for the reader",
			async () => {
				// The select key holds a dd64 locator: harvest dd64.
				const narrowed = await call(reader, {
					section_tipo: DOOR_SECTION,
					tipo: 'dd64',
					type: 'target_section',
				});
				expect((narrowed.body as unknown as { data: unknown[] }).data).toEqual([PUBLICATION_VALUE]);
				const served = await call(control, {
					section_tipo: DOOR_SECTION,
					tipo: 'dd64',
					type: 'target_section',
				});
				expect((served.body as unknown as { data: unknown[] }).data).toEqual([
					SELECT_VALUE,
					PUBLICATION_VALUE,
				]);
			},
		);
	});

	/* ─────────────────────── dd_core_api:get_element_context ──────────────── */

	describe('dd_core_api:get_element_context', () => {
		async function buttonsFor(principal: Principal): Promise<string[]> {
			const response = await dispatchRqo(
				{
					action: 'get_element_context',
					dd_api: 'dd_core_api',
					source: { tipo: DOOR_SECTION, model: 'section', mode: 'list' },
				} as never,
				contextFor(principal, `zzdoor_${principal.userId}`) as never,
			);
			expect(response.status).toBe(200);
			const [entry] = (response.body as unknown as { data: { buttons?: { tipo: string }[] }[] })
				.data;
			return (entry?.buttons ?? []).map((button) => button.tipo).sort();
		}

		leg(
			'dd_core_api:get_element_context',
			'section buttons are the per-button grant, not the caller cap: reader [new], control [new, delete]',
			async () => {
				expect(await buttonsFor(reader)).toEqual([DOOR_BUTTON_NEW]);
				expect(await buttonsFor(control)).toEqual([DOOR_BUTTON_DELETE, DOOR_BUTTON_NEW].sort());
			},
		);
	});

	/* ─────────────────────── dd_identify_api:find_matches ─────────────────── */

	describe('dd_identify_api:find_matches', () => {
		const profile = () =>
			parseProfile({
				id: 'zzdoor',
				label: 'Door',
				sectionTipos: [DOOR_SECTION],
				previewComponent: DOOR_IMAGE,
				criteria: [
					{
						id: 'text',
						label: 'Text',
						path: [{ section_tipo: DOOR_SECTION, component_tipo: DOOR_TEXT }],
						role: 'identifying',
						mode: 'normalized_text',
						weight: 1,
					},
				],
			});
		/** Real grant (deps.componentGrant omitted → getPermissions); the rest faked. */
		function depsWithSpy(asked: { records: unknown[] }[]) {
			return {
				loadProfile: async () => profile(),
				runMatches: async () => ({
					results: [
						{
							sectionTipo: DOOR_SECTION,
							sectionId: RECORD_ID,
							score: 1,
							verdict: 'same_type' as const,
							outcomes: [],
						},
					],
					moreAvailable: false,
					blindCriteria: [],
					restrictedCriteria: [],
				}),
				canReadSection: async () => true,
				resolveThumbs: async (_component: string | null, records: readonly unknown[]) => {
					asked.push({ records: [...records] });
					return new Map([[`${DOOR_SECTION}_${RECORD_ID}`, '/media/thumb/zzdoor.jpg']]);
				},
			};
		}

		leg(
			'dd_identify_api:find_matches',
			'the preview thumb: null and the resolver never asked for the reader; resolved for the control',
			async () => {
				const readerAsked: { records: unknown[] }[] = [];
				const refused = await buildFindMatches(depsWithSpy(readerAsked))(
					rqo({ section_tipo: DOOR_SECTION, section_id: RECORD_ID }),
					handlerContext(reader),
				);
				const refusedBody = refused.body.data as {
					seed: { thumb_url: unknown };
					results: { thumb_url: unknown }[];
				};
				expect(refused.body.ok).toBe(true);
				expect(refusedBody.seed.thumb_url).toBeNull();
				expect(refusedBody.results.map((result) => result.thumb_url)).toEqual([null]);
				expect(readerAsked).toEqual([]);

				const controlAsked: { records: unknown[] }[] = [];
				const served = await buildFindMatches(depsWithSpy(controlAsked))(
					rqo({ section_tipo: DOOR_SECTION, section_id: RECORD_ID }),
					handlerContext(control),
				);
				const servedBody = served.body.data as { results: { thumb_url: unknown }[] };
				expect(servedBody.results.map((result) => result.thumb_url)).toEqual([
					'/media/thumb/zzdoor.jpg',
				]);
				expect(controlAsked).toHaveLength(1);
			},
		);
	});

	/* ─────────────────── dd_identify_api:identify_by_image ────────────────── */

	describe('dd_identify_api:identify_by_image', () => {
		// A 1×1 PNG — the smallest thing the sniffer accepts as an image.
		const PNG = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
			'base64',
		).toString('base64');
		function deps(): IdentifyByImageDeps {
			return {
				requireToolGrant: async () => {
					throw new Error('a LOCAL encoder spends nothing: the vision grant must never be asked');
				},
				chargeVision: async () => {
					throw new Error('a LOCAL encoder spends nothing: no vision call may be charged');
				},
				ragEnabled: () => true,
				mediaEnabled: () => true,
				config: () => ({ provider: 'local', imageEgressPolicy: 'local_only' }) as never,
				buildProvider: () =>
					({
						embedImage: async () => [[0.1, 0.2]],
						embedTextForImageSearch: async () => [],
						dimension: () => 2,
						model: () => 'fake',
						provider: () => 'local',
						isExternal: () => false,
					}) as never,
				// ONE hit from the SIBLING section — the reader holds no grant there.
				queryImagePartition: async () => [
					{
						sectionTipo: DOOR_SIBLING_SECTION,
						sectionId: 1,
						componentTipo: DOOR_IMAGE,
						lang: 'lg-nolan',
						chunkIndex: 0,
						sourceText: null,
						sourceKind: 'image_visual',
						modality: 'image',
						egressClass: 'public',
						parentKey: null,
						chunkMeta: { thumb_url: '/media/thumb/sibling.jpg' },
						distance: 0.1,
					},
				],
				// The RAG chokepoint faked open: the HANDLER's section grant is what
				// is under test here (rag/retrieval.ts has its own gate).
				filterAccessible: async (_principal, candidates) => candidates,
				componentGrant: getPermissions,
				scopeRecords: async (records) => records,
				labelComponent: async () => null,
				readValues: async () => null,
				loadProfile: async () => null,
			};
		}

		leg(
			'dd_identify_api:identify_by_image',
			'an OMITTED scope: the sibling-section hit is dropped for the reader, served to the control',
			async () => {
				const refused = await buildIdentifyByImage(deps())(
					rqo({ image: PNG }),
					handlerContext(reader),
				);
				expect(refused.status).toBe(200);
				const refusedBody = refused.body.data as { scope: string[]; results: unknown[] };
				expect(refusedBody.scope).toEqual([]);
				expect(refusedBody.results).toEqual([]);
				expect(JSON.stringify(refused.body)).not.toContain('sibling.jpg');

				const served = await buildIdentifyByImage(deps())(
					rqo({ image: PNG }),
					handlerContext(control),
				);
				const servedBody = served.body.data as {
					results: { section_tipo: string; thumb_url: string }[];
				};
				expect(servedBody.results.map((hit) => [hit.section_tipo, hit.thumb_url])).toEqual([
					[DOOR_SIBLING_SECTION, '/media/thumb/sibling.jpg'],
				]);
			},
		);
	});

	/* ──────────── the RAG chokepoint behind identify_by_image (SEC-11) ─────── */

	describe('ai/rag/retrieval.ts aclGate — EVERY chunk needs the section grant, image chunks included', () => {
		/** A per-component (image-path) chunk on the sibling record. */
		const imageChunk = (): Candidate => ({
			sectionTipo: DOOR_SIBLING_SECTION,
			sectionId: SIBLING_RECORD_ID,
			componentTipo: DOOR_TEXT,
			lang: 'lg-eng',
			chunkIndex: 0,
			sourceText: 'zzdoor sibling text',
			sourceKind: 'image_visual',
			modality: 'image',
			egressClass: 'public',
			parentKey: null,
			chunkMeta: { thumb_url: '/media/thumb/sibling.jpg' },
		});

		test('the component granted WITHOUT its section is dropped; the control (section + component) is served', async () => {
			expect(await aclFilterCandidates(mediaOnly, [imageChunk()])).toEqual([]);
			// POSITIVE CONTROL: same chunk, same record scope, section granted.
			const served = await aclFilterCandidates(control, [imageChunk()]);
			expect(served.map((chunk) => [chunk.sectionTipo, chunk.sectionId])).toEqual([
				[DOOR_SIBLING_SECTION, SIBLING_RECORD_ID],
			]);
		});
	});

	/* ────────────────────────── mcp:dedalo_get_media_info ─────────────────── */

	describe('mcp:dedalo_get_media_info', () => {
		const input = { section_tipo: DOOR_SECTION, section_id: RECORD_ID, field: DOOR_IMAGE };

		leg(
			'mcp:dedalo_get_media_info',
			'the image component denied → perm.denied BEFORE the column read; served to the control with its URL',
			async () => {
				const refusal = await refusalOf(getMediaInfo(reader, input));
				expect(refusal.code).toBe('perm.denied');
				expect(JSON.stringify(refusal)).not.toContain(IMAGE_FILE_PATH);

				const served = await getMediaInfo(control, input);
				expect(served.items).toEqual([
					{
						quality: 'original',
						file_path: IMAGE_FILE_PATH,
						extension: 'jpg',
						url: `${config.media.webBase}${IMAGE_FILE_PATH}`,
					},
				]);
			},
		);

		leg(
			'mcp:dedalo_get_media_info',
			'the image component granted WITHOUT its section (SEC-11 shape) → perm.denied, as the human read refuses; the control (section + component) is served',
			async () => {
				const sibling = {
					section_tipo: DOOR_SIBLING_SECTION,
					section_id: SIBLING_RECORD_ID,
					field: DOOR_IMAGE,
				};
				const refusal = await refusalOf(getMediaInfo(mediaOnly, sibling));
				expect(refusal.code).toBe('perm.denied');
				expect(JSON.stringify(refusal)).not.toContain(SIBLING_IMAGE_FILE_PATH);
				// The human read of the same record, same principal: refused too — the
				// door and the record page agree.
				const humanRead = await dispatchRqo(
					{
						action: 'read',
						dd_api: 'dd_core_api',
						prevent_lock: true,
						source: {
							model: 'section',
							tipo: DOOR_SIBLING_SECTION,
							section_tipo: DOOR_SIBLING_SECTION,
							mode: 'list',
							lang: 'lg-eng',
							action: 'list',
						},
						sqo: {
							section_tipo: [DOOR_SIBLING_SECTION],
							filter_by_locators: [
								{ section_tipo: DOOR_SIBLING_SECTION, section_id: SIBLING_RECORD_ID },
							],
							limit: 1,
						},
					} as never,
					contextFor(mediaOnly, `zzdoor_${mediaOnly.userId}`) as never,
				);
				expect(humanRead.status).toBe(403);
				expect((humanRead.body as { error?: { code?: string } }).error?.code).toBe('perm.denied');

				const served = await getMediaInfo(control, sibling);
				expect(served.items.map((item) => item.file_path)).toEqual([SIBLING_IMAGE_FILE_PATH]);
			},
		);
	});

	/* ────────────────────────── mcp:dedalo_read_record ────────────────────── */

	describe('mcp:dedalo_read_record', () => {
		leg(
			'mcp:dedalo_read_record',
			'the section granted to NEITHER (media-only holds only its components) → perm.denied; the control (section held) is served the record',
			async () => {
				const input = { section_tipo: DOOR_SIBLING_SECTION, section_id: SIBLING_RECORD_ID };
				const refusal = await refusalOf(readSectionRecord(mediaOnly, input));
				expect(refusal.code).toBe('perm.denied');
				expect(JSON.stringify(refusal)).not.toContain('zzdoor sibling text');

				const served = await readSectionRecord(control, input);
				const rows = served.data as { section_id?: number | string; tipo?: string }[];
				const ids = rows
					.filter((row) => row.section_id !== undefined)
					.map((row) => Number(row.section_id));
				expect(ids.length).toBeGreaterThan(0);
				expect(new Set(ids)).toEqual(new Set([SIBLING_RECORD_ID]));
				expect(JSON.stringify(served.data)).toContain('zzdoor sibling text');
			},
		);
	});

	/* ─────── mcp:dedalo_search_section / _search_records / _count_records ─── */
	/* ─────── + mcp:dedalo_find_or_create (SEC-1, closure Step 3) ──────────── */
	//
	// WHAT WAS WRONG (45b8c45162): the three MCP search/count tools built the SQO
	// and ran the assembler with the principal attached — which applies the
	// PROJECTS filter and nothing else. The SECTION read grant lives in the human
	// read's Gate B (dd_core_api), which these tools bypass: a principal holding no
	// grant on test2 (the READER) or only test2's components (MEDIA-ONLY) listed,
	// counted and value-probed test2's records. find_or_create inherits the search.

	describe('mcp search / count / find_or_create — the SECTION grant at the tool door', () => {
		const SEARCH_DOORS = {
			'mcp:dedalo_search_section': (principal: Principal) =>
				searchSectionRecords(principal, { section_tipo: DOOR_SIBLING_SECTION }),
			'mcp:dedalo_search_records': (principal: Principal) =>
				searchRecords(principal, { section_tipo: DOOR_SIBLING_SECTION }),
			'mcp:dedalo_count_records': (principal: Principal) =>
				countRecords(principal, { section_tipo: DOOR_SIBLING_SECTION }),
			'mcp:dedalo_find_or_create': (principal: Principal) =>
				findOrCreate(principal, {
					section_tipo: DOOR_SIBLING_SECTION,
					match: [{ field: DOOR_TEXT, value: 'zzdoor sibling text' }],
				}),
		} as const;

		for (const [door, run] of Object.entries(SEARCH_DOORS)) {
			leg(
				door,
				`${door}: the READER (no test2 grant) and MEDIA-ONLY (components only) are perm.denied; the CONTROL is served`,
				async () => {
					for (const principal of [reader, mediaOnly]) {
						const refusal = await refusalOf(run(principal));
						expect({ door, user: principal.userId, code: refusal.code }).toEqual({
							door,
							user: principal.userId,
							code: 'perm.denied',
						});
						expect(JSON.stringify(refusal)).not.toContain(String(SIBLING_RECORD_ID));
					}
					// The control holds test2 at 1: served, and the scratch sibling row is
					// really there — the refusal above is the grant, not an empty section.
					const served = JSON.stringify(await run(control));
					expect(served).toContain(
						door === 'mcp:dedalo_count_records' ? '"total":' : String(SIBLING_RECORD_ID),
					);
					if (door === 'mcp:dedalo_count_records') {
						expect(((await run(control)) as { total: number }).total).toBeGreaterThan(0);
					}
				},
			);
		}
	});

	/* ──────────────────────── GET /dedalo/core/api/v1/raw ─────────────────── */

	describe('GET /dedalo/core/api/v1/raw (api/raw_view.ts)', () => {
		const RAW_URL = '/dedalo/core/api/v1/raw';
		function rawRequest(token: string): Request {
			return new Request(
				`http://localhost${RAW_URL}?section_tipo=${DOOR_SECTION}&section_id=${RECORD_ID}`,
				{
					headers: { Cookie: `dedalo_ts_session=${token}` },
				},
			);
		}
		const serverContext = { requestId: 'read-door-raw', startedAt: 0 };

		leg(
			'http:GET /dedalo/core/api/v1/raw',
			"a global admin's row is projected through THEIR profile (test52 absent, test92 present); the superuser sees it whole",
			async () => {
				const adminToken = createSession(ACL_ADMIN_USER_ID, 'zzacl_admin', true);
				const projected = await handleRequest(rawRequest(adminToken), serverContext);
				expect(projected.status).toBe(200);
				const projectedBody = (await projected.json()) as {
					data: { string: Record<string, unknown>; relation: Record<string, unknown> }[];
				};
				expect(projectedBody.data[0]?.string).toEqual({});
				expect(Object.keys(projectedBody.data[0]?.relation ?? {})).toEqual([DOOR_PUBLICATION]);
				expect(JSON.stringify(projectedBody)).not.toContain(TEXT_VALUE);

				const rootToken = createSession(-1, 'root', true);
				const whole = await handleRequest(rawRequest(rootToken), serverContext);
				const wholeBody = (await whole.json()) as { data: { string: Record<string, unknown> }[] };
				expect(wholeBody.data[0]?.string).toEqual({
					[DOOR_TEXT]: [{ id: 1, lang: 'lg-eng', value: TEXT_VALUE }],
				});
			},
		);
	});

	/* ──────────────────────── GET /dedalo/core/api/v1/map_tile ────────────── */

	describe('GET /dedalo/core/api/v1/map_tile (api/map_tile.ts)', () => {
		const TILE_URL = '/dedalo/core/api/v1/map_tile';
		/** The address the server builds for tile 3/4/2 of the stored source — the memory's key. */
		const UPSTREAM = 'https://tiles.example.org/3/4/2.png';
		const PNG = Uint8Array.from(
			Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
				'base64',
			),
		);
		function tileRequest(token: string): Request {
			return new Request(
				`http://localhost${TILE_URL}?section_tipo=${DOOR_SECTION}&section_id=${RECORD_ID}&component_tipo=${DOOR_GEO}&source_id=1&z=3&x=4&y=2`,
				{ headers: { Cookie: `dedalo_ts_session=${token}` } },
			);
		}
		const serverContext = { requestId: 'read-door-tile', startedAt: 0 };

		leg(
			'http:GET /dedalo/core/api/v1/map_tile',
			'the component key: the reader (test100 = 0) is refused with the tile SITTING IN THE MEMORY, the control (test100 = 1) on the identical call is served it; no network is touched',
			async () => {
				expect(await getPermissions(reader, DOOR_SECTION, DOOR_GEO)).toBe(0);
				expect(await getPermissions(control, DOOR_SECTION, DOOR_GEO)).toBe(1);
				const now = Date.now();
				clearTileCacheForTests();
				try {
					expect(
						rememberTile(UPSTREAM, { bytes: PNG, contentType: 'image/png' }, 60_000, now),
					).toBe(true);
					const readerToken = createSession(DOOR_READER_USER_ID, 'zzdoor_reader', false);
					const denied = await handleRequest(tileRequest(readerToken), serverContext);
					expect(denied.status).toBe(404);
					expect(((await denied.json()) as { error: { code: string } }).error.code).toBe(
						'resource.not_found',
					);

					const controlToken = createSession(DOOR_CONTROL_USER_ID, 'zzdoor_control', false);
					const served = await handleRequest(tileRequest(controlToken), serverContext);
					expect(served.status).toBe(200);
					expect(served.headers.get('content-type')).toBe('image/png');
					expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
				} finally {
					clearTileCacheForTests();
				}
			},
		);
	});
});

/* ─────── dd_component_av_api:get_media_streams / :download_fragment ─────── */
/* ─────── (closure Step 3, SEC-2-media — the posture moved open → component) */
//
// WHAT WAS WRONG (45b8c45162): both AV READS asked `getPermissions(section,
// SECTION) >= 1` only (media_action_context.ts) — a profile explicitly denied
// the AV component probed its streams and cut fragments of it, and the record
// scope was never asked. The door is now the write door's READ mode: the
// section floor, the AV component's own read grant, the record scope. The
// write-side identities come from `authz_door_fixture` (the media contrast the
// read-door fixture does not hold); every refusal has a served twin.

describe.if(DB_READY)('AV reads — the component read grant + the record scope', () => {
	let avIds: import('../helpers/authz_door_fixture.ts').AuthzIdentities;
	let avRecord = 0;
	let fixture: typeof import('../helpers/authz_door_fixture.ts');

	beforeAll(async () => {
		fixture = await import('../helpers/authz_door_fixture.ts');
		await fixture.installAuthzDoorFixture();
		avRecord = await fixture.createDoorRecord(fixture.AUTHZ_SECTION, fixture.AUTHZ_PROJECT_P);
		avIds = await fixture.resolveAuthzIdentities();
	});
	afterAll(async () => {
		await fixture.removeAuthzDoorFixture();
	});

	const AV_READS = ['get_media_streams', 'download_fragment'] as const;

	for (const action of AV_READS) {
		leg(
			`dd_component_av_api:${action}`,
			`dd_component_av_api:${action}: the component denied / the section denied / out of scope are refused; the control passes the door`,
			async () => {
				const { componentAvApiActions } = await import(
					'../../src/core/api/handlers/dd_component_av_api.ts'
				);
				const { resolveMediaActionContext } = await import(
					'../../src/core/api/handlers/media_action_context.ts'
				);
				const handler = componentAvApiActions[action];
				expect(handler).toBeDefined();
				const source = {
					tipo: fixture.AUTHZ_AV,
					section_tipo: fixture.AUTHZ_SECTION,
					section_id: avRecord,
				};
				const rqo = { action, source, options: {} } as unknown as Rqo;
				const ctxFor = (principal: Principal) =>
					({
						requestId: 'read-door-av',
						clientIp: '127.0.0.1',
						session: { userId: principal.userId, csrfToken: 'x' },
						csrfCandidate: null,
						principal,
					}) as unknown as ApiRequestContext;

				for (const [who, principal, code] of [
					['component denied', avIds.sectionOnly, 'perm.denied'],
					['section denied', avIds.componentOnly, 'perm.denied'],
					['out of scope', avIds.outOfScope, 'perm.out_of_scope'],
				] as const) {
					const refusal = await refusalOf(
						(handler as NonNullable<typeof handler>)(rqo, ctxFor(principal)),
					);
					expect({ action, who, code: refusal.code }).toEqual({ action, who, code });
				}
				// The control passes the SAME door (the media effect itself needs a file
				// and ffmpeg — the door is what this gate is about).
				const passed = await resolveMediaActionContext(
					rqo,
					ctxFor(avIds.control),
					1,
					'component_av',
					`dd_component_av_api:${action}`,
				);
				expect(passed.grant.componentTipo).toBe(fixture.AUTHZ_AV);
				expect(passed.ctx.identity.sectionId).toBe(avRecord);
			},
		);
	}
});

// LAST, and on purpose: every door READ_DOOR_PROBED names ran its leg to
// completion in THIS process — the evidence the authorization-door matrix reads
// when it counts a `component` posture row as delegated.
describe.if(DB_READY)('READ_DOOR_PROBED — every delegated door ran its behavioural leg', () => {
	test('the completed legs are exactly READ_DOOR_PROBED', () => {
		expect([...readDoorLegsCompleted()].sort()).toEqual([...READ_DOOR_PROBED].sort());
	});
});
