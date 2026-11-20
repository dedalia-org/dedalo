/**
 * EXTERNAL request_config PARSE SIDE — TS-native gate (DEC-14b).
 *
 * Why native and not differential: the suite database is the test3 playground,
 * which carries NO `zenon*` ontology, so the live corpus case (rsc368 → zenon1)
 * cannot be driven here at all. Instead this builds a SCRATCH external
 * installation inside the playground's own `test` TLD — an external section,
 * a component_external child with a fields_map, and an autocomplete whose
 * request_config declares the non-dedalo engine — and drives the real parser
 * over it. Nothing here depends on drifted production data.
 *
 * What it pins (both are live CLIENT contracts, cited at each assertion):
 *  1. STEP 9 fields_map hydration — the ontology stores the flag
 *     `fields_map: true`; the wire must carry the node's real mapping, plus
 *     model/lang/permissions.
 *  2. `api_config` publication — shaped by publishApiConfig on the way out:
 *     credential-shaped keys stripped, unknown keys dropped, `javascript:`
 *     refused, and the TARGET section's copy is the one that binds (a caller's
 *     stale duplicate — rsc205 in production — is inert).
 *
 * Scratch surfaces: dd_ontology tipos test99{2,3,4,5}, swept in afterAll and
 * pre-cleaned in beforeAll for crashed runs. No matrix rows are written.
 */
// Migrated 2026-08-19 (generic-`test`-TLD sweep): the situation was already BUILT in the
// generic `test` TLD (the scratch test99x nodes below); the last install reference was a
// production node named in a test TITLE, now described instead of named.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyCaches, getNode } from '../../src/core/ontology/resolver.ts';
import {
	buildExplicitRequestConfig,
	type RequestConfigContext,
} from '../../src/core/relations/request_config/explicit.ts';

/** The scratch external SECTION (the zenon1 twin) — carries properties.api_config. */
const EXTERNAL_SECTION = 'test992';
/** Its component_external child (the zenon5 twin) — carries properties.fields_map. */
const EXTERNAL_COMPONENT = 'test993';
/** The autocomplete whose request_config names the external engine (the rsc368 twin). */
const CALLER = 'test994';
/** A second caller carrying its OWN stale api_config copy (the rsc205 case). */
const CALLER_WITH_STALE_COPY = 'test995';
/**
 * A component_external whose OWN node carries an api_config — the shape that
 * turns step-9 hydration into a resolver-cache WRITE if the properties are not
 * cloned first (sanitizeEmittedProperties assigns the published object in
 * place). No live node is like this today; rsc205 proves cataloguers paste
 * api_config onto nodes that do not need it.
 */
const COMPONENT_WITH_API_CONFIG = 'test996';
/** The caller that hydrates it. */
const CALLER_HYDRATING_API_CONFIG = 'test997';

const SCRATCH_TIPOS = [
	EXTERNAL_SECTION,
	EXTERNAL_COMPONENT,
	CALLER,
	CALLER_WITH_STALE_COPY,
	COMPONENT_WITH_API_CONFIG,
	CALLER_HYDRATING_API_CONFIG,
];

/**
 * The hostile api_config the positive control rides on: a credential pasted
 * into the ontology, an unknown key, and a note key — every one of which a
 * cataloguer can write today.
 */
const SECTION_API_CONFIG = {
	entity: 'zenon',
	api_url: 'https://zenon.dainst.org/api/v1/record',
	api_url_search: 'https://zenon.dainst.org/api/v1/search',
	ui_base_url: 'https://zenon.dainst.org/Record/',
	response_map: [{ local: 'ar_records', remote: 'records' }],
	api_key: 'SUPER-SECRET-VALUE',
	authorization: 'Bearer another-secret',
	info: 'a cataloguer note',
};

/** The caller's own copy names a DIFFERENT service — it must never bind. */
const STALE_CALLER_API_CONFIG = {
	entity: 'stale',
	api_url: 'https://stale.example.org/api',
	ui_base_url: 'https://stale.example.org/Record/',
};

function callerProperties(childTipo: string = EXTERNAL_COMPONENT): string {
	return JSON.stringify({
		source: {
			request_config: [
				{
					api_engine: 'zenon',
					sqo: { section_tipo: [{ value: [EXTERNAL_SECTION], source: 'section' }] },
					show: {
						ddo_map: [
							{
								tipo: childTipo,
								parent: 'self',
								fields_map: true,
								section_tipo: EXTERNAL_SECTION,
							},
						],
						fields_separator: ' | ',
					},
				},
			],
		},
	});
}

async function sweepScratch(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM dd_ontology WHERE tipo IN ($1, $2, $3, $4, $5, $6)`,
		SCRATCH_TIPOS as unknown as unknown[],
	);
	clearOntologyCaches();
}

async function insertNode(
	tipo: string,
	parent: string,
	model: string,
	properties: string,
	translatable: boolean,
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (id, tipo, parent, model, tld, properties, is_translatable, term)
		 VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM dd_ontology), $1, $2, $3, 'test', $4::text::jsonb, $5, $6::text::jsonb)`,
		[tipo, parent, model, properties, translatable, JSON.stringify({ 'lg-spa': tipo })],
	);
}

const context: RequestConfigContext = {
	ownerTipo: CALLER,
	ownerSectionTipo: 'test3',
	mode: 'list',
	ownerIsSection: false,
};

beforeAll(async () => {
	await sweepScratch(); // crashed-run belt and braces
	await insertNode(
		EXTERNAL_SECTION,
		'test1',
		'section',
		JSON.stringify({
			api_config: SECTION_API_CONFIG,
		}),
		false,
	);
	await insertNode(
		EXTERNAL_COMPONENT,
		EXTERNAL_SECTION,
		'component_external',
		JSON.stringify({ fields_map: [{ local: 'dato', remote: 'authors', format: 'zenon_authors' }] }),
		false,
	);
	await insertNode(CALLER, 'test1', 'component_autocomplete', callerProperties(), false);
	await insertNode(
		CALLER_WITH_STALE_COPY,
		'test1',
		'component_autocomplete',
		JSON.stringify({
			...(JSON.parse(callerProperties()) as Record<string, unknown>),
			api_config: STALE_CALLER_API_CONFIG,
		}),
		false,
	);
	await insertNode(
		COMPONENT_WITH_API_CONFIG,
		EXTERNAL_SECTION,
		'component_external',
		JSON.stringify({
			fields_map: [{ local: 'dato', remote: 'authors', format: 'zenon_authors' }],
			api_config: SECTION_API_CONFIG,
		}),
		false,
	);
	await insertNode(
		CALLER_HYDRATING_API_CONFIG,
		'test1',
		'component_autocomplete',
		callerProperties(COMPONENT_WITH_API_CONFIG),
		false,
	);
	clearOntologyCaches();
});

afterAll(async () => {
	await sweepScratch();
});

describe('step 9 — fields_map hydration', () => {
	test("the flag is REPLACED by the node's own properties.fields_map", async () => {
		const parsed = await buildExplicitRequestConfig(
			(await sql.unsafe('SELECT properties FROM dd_ontology WHERE tipo = $1', [CALLER]))[0]
				.properties,
			context,
		);
		const ddo = parsed[0]?.show?.ddo_map[0];
		// service_autocomplete.js:911 reads fields[j].fields_map[0].remote to shape
		// the remote answer, and :1060 builds '&field[]=' from the same path. A
		// boolean here asks the service for no fields at all.
		expect(ddo?.fields_map).toEqual([
			{ local: 'dato', remote: 'authors', format: 'zenon_authors' },
		]);
	});

	test('model, lang and permissions are stamped (PHP resolve_ddo_fields_map)', async () => {
		const parsed = await buildExplicitRequestConfig(
			(await sql.unsafe('SELECT properties FROM dd_ontology WHERE tipo = $1', [CALLER]))[0]
				.properties,
			context,
		);
		const ddo = parsed[0]?.show?.ddo_map[0] as Record<string, unknown>;
		expect(ddo.model).toBe('component_external');
		// Non-translatable node → the nolan axis, never the request data lang.
		expect(ddo.lang).toBe('lg-nolan');
		// No principal in this internal resolution → the parser's v0 admin posture.
		expect(ddo.permissions).toBe(3);
		// The node's properties ride along (PHP attaches the whole object).
		expect((ddo.properties as { fields_map?: unknown }).fields_map).toEqual(ddo.fields_map);
	});

	test('a ddo WITHOUT the flag is untouched', async () => {
		const properties = {
			source: {
				request_config: [
					{
						api_engine: 'dedalo',
						sqo: { section_tipo: [{ value: ['test3'], source: 'section' }] },
						show: { ddo_map: [{ tipo: 'test52', parent: 'self', section_tipo: 'test3' }] },
					},
				],
			},
		};
		const ddo = (await buildExplicitRequestConfig(properties, context))[0]?.show
			?.ddo_map[0] as Record<string, unknown>;
		expect(ddo.fields_map).toBeUndefined();
		expect(ddo.lang).toBeUndefined();
		expect(ddo.properties).toBeUndefined();
	});
});

/**
 * The hydrated `properties` are a WIRE ECHO built from the RESOLVER CACHE's own
 * object. Handing that object out — or shaping it in place — makes the cache
 * and the response the same memory: a stamp-time caller edits the ontology for
 * every later request, and the publication strip becomes permanent for readers
 * (tools, admin) that must see the RAW node.
 */
describe('step 9 — the hydrated echo never aliases or edits the resolver cache', () => {
	async function hydrate(callerTipo: string) {
		const rows = (await sql.unsafe('SELECT properties FROM dd_ontology WHERE tipo = $1', [
			callerTipo,
		])) as { properties: unknown }[];
		const parsed = await buildExplicitRequestConfig(rows[0]?.properties, {
			...context,
			ownerTipo: callerTipo,
		});
		return parsed[0]?.show?.ddo_map[0] as Record<string, unknown>;
	}

	test('the emitted properties and fields_map are COPIES, not the cached objects', async () => {
		const ddo = await hydrate(CALLER);
		const cached = (await getNode(EXTERNAL_COMPONENT))?.properties as Record<string, unknown>;
		expect(cached).toBeDefined();
		// Same content …
		expect(ddo.properties).toEqual(cached);
		// … different memory. Identity, not equality, is the invariant.
		expect(ddo.properties).not.toBe(cached);
		expect(ddo.fields_map).not.toBe(cached.fields_map);
	});

	test('publishing an api_config does not strip the CACHED node', async () => {
		const ddo = await hydrate(CALLER_HYDRATING_API_CONFIG);
		// The echo is published: the pasted credentials are gone.
		const emitted = (ddo.properties as { api_config?: Record<string, unknown> }).api_config;
		expect(emitted).toBeDefined();
		expect(emitted?.api_key).toBeUndefined();
		expect(emitted?.authorization).toBeUndefined();
		// The ONTOLOGY is untouched — a later reader still sees what the
		// cataloguer actually wrote.
		const cached = (await getNode(COMPONENT_WITH_API_CONFIG))?.properties as {
			api_config?: Record<string, unknown>;
		};
		expect(cached.api_config?.api_key).toBe('SUPER-SECRET-VALUE');
		expect(cached.api_config?.authorization).toBe('Bearer another-secret');
		expect(cached.api_config).not.toBe(emitted);
	});
});

describe('api_config publication', () => {
	async function parsedCaller(tipo: string) {
		const rows = (await sql.unsafe('SELECT properties FROM dd_ontology WHERE tipo = $1', [
			tipo,
		])) as { properties: unknown }[];
		return buildExplicitRequestConfig(rows[0]?.properties, { ...context, ownerTipo: tipo });
	}

	test('the TARGET section binds; the item carries the published config', async () => {
		const item = (await parsedCaller(CALLER))[0];
		expect(item?.api_config?.entity).toBe('zenon');
		// The URLs the SERVER fetches are not published (T2 S09-c,
		// WC-2026-11-19-external-api-url-unpublished): no client code reads them.
		expect(item?.api_config).not.toHaveProperty('api_url');
		expect(item?.api_config).not.toHaveProperty('api_url_search');
		// component_portal.js:2054 builds the record link as ui_base_url + section_id.
		expect(item?.api_config?.ui_base_url).toBe('https://zenon.dainst.org/Record/');
	});

	test('credential-shaped and unknown keys never reach the wire', async () => {
		const item = (await parsedCaller(CALLER))[0];
		const serialized = JSON.stringify(item?.api_config);
		expect(serialized).not.toContain('SUPER-SECRET-VALUE');
		expect(serialized).not.toContain('another-secret');
		expect(Object.keys(item?.api_config ?? {}).sort()).toEqual([
			'entity',
			'response_map',
			'ui_base_url',
		]);
	});

	test("a 'javascript:' ui_base_url refuses the WHOLE binding, never half of it", async () => {
		await sql.unsafe('UPDATE dd_ontology SET properties = $2::text::jsonb WHERE tipo = $1', [
			EXTERNAL_SECTION,
			JSON.stringify({
				api_config: { ...SECTION_API_CONFIG, ui_base_url: 'javascript:alert(1)' },
			}),
		]);
		clearOntologyCaches();
		try {
			// A partly-published binding is the trap: the client would build a link
			// from a config the engine already knows is hostile.
			expect((await parsedCaller(CALLER))[0]?.api_config).toBeNull();
		} finally {
			await sql.unsafe('UPDATE dd_ontology SET properties = $2::text::jsonb WHERE tipo = $1', [
				EXTERNAL_SECTION,
				JSON.stringify({ api_config: SECTION_API_CONFIG }),
			]);
			clearOntologyCaches();
		}
	});

	test("a CALLER's own stale api_config copy is inert (the stale-duplicate case)", async () => {
		const item = (await parsedCaller(CALLER_WITH_STALE_COPY))[0];
		// The ddo names the external section; that section's copy is the truth.
		expect(item?.api_config?.entity).toBe('zenon');
		expect(JSON.stringify(item?.api_config)).not.toContain('stale.example.org');
	});

	test('every dedalo item ships api_config: null (PHP emits the key always)', async () => {
		const properties = {
			source: {
				request_config: [
					{
						api_engine: 'dedalo',
						sqo: { section_tipo: [{ value: ['test3'], source: 'section' }] },
						show: { ddo_map: [] },
					},
				],
			},
		};
		const item = (await buildExplicitRequestConfig(properties, context))[0];
		// The client's portal edit handler reads request_config[i].api_config
		// unconditionally once api_engine !== 'dedalo'; an ABSENT key on the
		// dedalo items would be a wire divergence from the frozen harvest.
		expect(item).toHaveProperty('api_config');
		expect(item?.api_config).toBeNull();
	});
});
