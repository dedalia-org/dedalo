/**
 * Phase 4d gate: request_config explicit differential — the TS-parsed config on the
 * portal's context entry vs the live PHP context request_config for the same
 * RQO (the cloned mint portal).
 *
 * Compared per item: api_engine, type, sqo.section_tipo (PHP enriches these
 * into dd_objects — compare the tipo identity), and the show ddo_map's
 * resolved (tipo, parent, section_tipo, mode) per ddo, in order. Enriched-ddo
 * extras (buttons/color/permissions on section ddos, fixed_filter expansion)
 * are ledgered as uncovered.
 */
// GENERIC-TLD MIGRATED 2026-08-20 (WC-2026-08-19-test-tld-replay).
// The RQO is written in `test`-TLD terms (the cloned mint thesaurus, its
// cloned portal, and the cloned external-service section) and the frozen PHP
// interactions are reached through `unmapRqo` (fixture lookup) +
// `adoptTipoIdMap` (the frozen bodies, read in test-TLD terms). The one record
// the read addresses comes from the committed corpus. The portal's TARGET
// section and its column are SEED-SHIPPED ontology, spelled through `seed()`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { readSection } from '../../src/core/section/read.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import { adoptTipoIdMap, installTokensIn } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/**
 * Seed-shipped ontology, spelled so the install-TLD census does not read it as
 * an install binding (the pilot's `seed()` convention).
 */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** The cloned mint thesaurus and the portal whose request_config is the subject. */
const SECTION = 'testmint1';
const PORTAL = 'testmint1014';
/** The portal's TARGET section and the column the rqo narrows to — seed-shipped. */
const TARGET_SECTION = seed('rsc', 332);
const TARGET_COLUMN = seed('rsc', 473);
/** The seed-shipped autocomplete that carries the external-engine request_config. */
const EXTERNAL_HOST = seed('rsc', 368);

/**
 * The external-engine case needs the external SERVICE ontology the host
 * component points at. WHICH section that is, is a fact of the installation's
 * ontology, so it is READ from the host's own properties instead of being
 * spelled here — spelling it would bind this file to an install TLD, and
 * hardcoding a cloned twin would silently change the case's precondition (the
 * host still points at the service the ontology says it does). Where that
 * section is absent the case is reported as an explicit SKIP (S2-40: never a
 * silent green). The DB-independent twin of the same contract is
 * test/unit/external_request_config_native.test.ts, which builds its own
 * scratch external section and always runs.
 */
const EXTERNAL_ONTOLOGY_PRESENT = await (async (): Promise<boolean> => {
	try {
		return await externalOntologyPresent();
	} catch (error) {
		// A COLLECTION-TIME PROBE MAY NOT KILL THE FILE (2026-08-31).
		//
		// This read decides a `test.if`, so it has to resolve BEFORE the cases are
		// collected — it cannot move into a `beforeAll` without changing what the gate
		// asserts. What it must not do is throw: an unhandled rejection at module scope
		// makes bun report the whole file as ONE error with ZERO cases, and in a
		// single-process run it can be attributed to whichever test is running.
		//
		// That is exactly how the db tier's real defect read: the census was addressing a
		// database that did not exist, and this file's 4 cases vanished into a bare
		// `1 error` while 40 other files degraded into `(unnamed)` placeholders. The
		// database being wrong is a REAL failure — it is reported, loudly, by every other
		// gate in this tier — but it must be reported as itself, not as this file
		// disappearing.
		console.warn(
			`[request_config_differential] external-ontology probe failed; the external-engine case will SKIP (not silently pass). Cause: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
})();

async function externalOntologyPresent(): Promise<boolean> {
	const rows = (await sql`
		SELECT properties FROM dd_ontology WHERE tipo = ${EXTERNAL_HOST} LIMIT 1
	`) as { properties?: { source?: { request_config?: Record<string, unknown>[] } } }[];
	const items = rows[0]?.properties?.source?.request_config ?? [];
	const external = items.find((item) => (item.api_engine ?? 'dedalo') !== 'dedalo');
	const target = ((external?.sqo as { section_tipo?: { value?: string[] }[] } | undefined)
		?.section_tipo?.[0]?.value ?? [])[0];
	if (typeof target !== 'string') return false;
	const hit = (await sql`
		SELECT tipo FROM dd_ontology WHERE tipo = ${target} LIMIT 1
	`) as unknown[];
	return hit.length > 0;
}

const READ_RQO = {
	action: 'read',
	dd_api: 'dd_core_api',
	prevent_lock: true,
	source: {
		model: 'section',
		tipo: SECTION,
		section_tipo: SECTION,
		mode: 'list',
		lang: 'lg-spa',
		action: 'search',
	},
	sqo: {
		section_tipo: [SECTION],
		filter_by_locators: [{ section_tipo: SECTION, section_id: '2' }],
		limit: 1,
		offset: 0,
	},
	show: {
		// Case B (client narrowing): the rqo carries the portal's child, so both
		// engines narrow show.ddo_map to it. Case A (no children → ontology
		// list-default narrowing via with_value) is LEDGERED uncovered scope.
		ddo_map: [
			{ tipo: PORTAL, section_tipo: 'self', parent: 'self', mode: 'list' },
			{
				tipo: TARGET_COLUMN,
				section_tipo: TARGET_SECTION,
				parent: PORTAL,
				mode: 'list',
				lang: 'lg-spa',
			},
		],
	},
};

interface RawDdo {
	tipo: string;
	parent?: string;
	section_tipo?: string | string[];
	mode?: string;
}

/** Normalized ddo identity both sides must agree on. */
function ddoIdentity(ddo: RawDdo): Record<string, unknown> {
	return {
		tipo: ddo.tipo,
		parent: ddo.parent,
		section_tipo: ddo.section_tipo,
		mode: ddo.mode,
	};
}

/** The first non-dedalo request_config item on ANY context entry (the external-service one). */
function externalItemOf(context: Record<string, unknown>[]): Record<string, unknown> | undefined {
	for (const entry of context ?? []) {
		const items = (entry.request_config as Record<string, unknown>[] | undefined) ?? [];
		const external = items.find((item) => (item.api_engine ?? 'dedalo') !== 'dedalo');
		if (external !== undefined) return external;
	}
	return undefined;
}

/** The step-9 hydrated surface of an external item's show ddos. */
function externalDdoSurface(
	item: Record<string, unknown> | undefined,
): { tipo: unknown; fields_map: unknown; lang: unknown; permissions: unknown; model: unknown }[] {
	const map =
		((item?.show as { ddo_map?: Record<string, unknown>[] } | null)?.ddo_map as
			| Record<string, unknown>[]
			| undefined) ?? [];
	return map.map((ddo) => ({
		tipo: ddo.tipo,
		fields_map: ddo.fields_map,
		lang: ddo.lang,
		permissions: ddo.permissions,
		model: ddo.model,
	}));
}

/**
 * The frozen install-term body, READ IN TEST-TLD TERMS
 * (WC-2026-08-19-test-tld-replay). Non-zero rewrite counts are the
 * anti-vacuity floor — a body that needed no rewrite would not be the migrated
 * one.
 *
 * THE ONE TOKEN THE CLONE HAS NO TWIN FOR: the install AREA node ABOVE the
 * cloned section — the closure that built the `test` TLD stops at the SECTION
 * root, so the section entry's `parent_grouper` cannot be mapped. It is
 * asserted EXACTLY (kind + a single leftover) and asserted to BE that field;
 * the token is never SPELLED here, because a test file that names an install
 * tipo binds it. What this gate compares (the portal's request_config) is
 * asserted to carry no install token at all.
 */
function adoptFrozen(body: Record<string, unknown>): Record<string, unknown> {
	const adopted = adoptTipoIdMap(body, 'request_config_differential');
	expect(adopted.kind).toBe('install_tipo_left');
	expect(adopted.leftovers).toHaveLength(1);
	expect(adopted.rewrites.tipos).toBeGreaterThan(0);
	expect(adopted.rewrites.ids).toBeGreaterThan(0);
	const sectionEntry = (adopted.body.result as { context: Record<string, unknown>[] }).context[0];
	expect(sectionEntry?.parent_grouper).toBe(adopted.leftovers[0] as string);
	return adopted.body;
}

/** Extract section tipos from a request_config sqo (PHP enriches to dd_objects). */
function sqoSectionTipos(sqo: { section_tipo?: unknown }): string[] {
	const entries = Array.isArray(sqo.section_tipo) ? sqo.section_tipo : [];
	return entries.map((entry) =>
		typeof entry === 'string' ? entry : ((entry as { tipo?: string }).tipo ?? ''),
	);
}

describe.if(hasPhpCredentials())('request_config explicit differential (Phase 4d gate)', () => {
	let phpConfig: Record<string, unknown>[];
	let tsConfig: Record<string, unknown>[];

	beforeAll(async () => {
		await ensureTestCorpus([SECTION]);
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call(structuredClone(READ_RQO));
		const phpContext = (adoptFrozen(body).result as { context: Record<string, unknown>[] }).context;
		const phpPortal = phpContext.find((entry) => entry.tipo === PORTAL);
		phpConfig = (phpPortal?.request_config as Record<string, unknown>[]) ?? [];
		expect(installTokensIn(phpConfig)).toEqual([]);

		const tsResult = await readSection(READ_RQO as unknown as Rqo);
		const tsPortal = tsResult.context.find((entry) => entry.tipo === PORTAL);
		tsConfig = (tsPortal?.request_config as Record<string, unknown>[]) ?? [];
	});

	afterAll(async () => {
		expect(await dropTestCorpus([SECTION])).toBe(0);
	});

	test('item count, api_engine, type and sqo target sections match', () => {
		expect(tsConfig.length).toBe(phpConfig.length);
		expect(tsConfig.length).toBeGreaterThan(0);
		for (let index = 0; index < phpConfig.length; index++) {
			const phpItem = phpConfig[index] as Record<string, unknown>;
			const tsItem = tsConfig[index] as Record<string, unknown>;
			expect(tsItem.api_engine).toBe(phpItem.api_engine ?? 'dedalo');
			expect(tsItem.type).toBe(phpItem.type ?? 'main');
			expect(sqoSectionTipos(tsItem.sqo as { section_tipo?: unknown })).toEqual(
				sqoSectionTipos(phpItem.sqo as { section_tipo?: unknown }),
			);
		}
	});

	test('case A (no rqo children): list-mode implicit fallback narrows to the section_list columns', async () => {
		const caseARqo = structuredClone(READ_RQO) as typeof READ_RQO;
		caseARqo.show.ddo_map = [{ tipo: PORTAL, section_tipo: 'self', parent: 'self', mode: 'list' }];

		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call(structuredClone(caseARqo));
		const phpPortal = (
			adoptFrozen(body).result as { context: Record<string, unknown>[] }
		).context.find((entry) => entry.tipo === PORTAL);
		const phpMap = (
			(phpPortal?.request_config as Record<string, unknown>[])?.[0] as {
				show?: { ddo_map?: RawDdo[] };
			}
		)?.show?.ddo_map;

		const tsResult = await readSection(caseARqo as unknown as Rqo);
		const tsPortal = tsResult.context.find((entry) => entry.tipo === PORTAL);
		const tsMap = (
			(tsPortal?.request_config as Record<string, unknown>[])?.[0] as {
				show?: { ddo_map?: RawDdo[] };
			}
		)?.show?.ddo_map;

		expect(tsMap?.length).toBe(phpMap?.length);
		expect(tsMap?.length).toBe(1); // the section_list child's single column
		expect(ddoIdentity(tsMap?.[0] as RawDdo)).toEqual(ddoIdentity(phpMap?.[0] as RawDdo));
	}, 30000);

	/**
	 * THE EXTERNAL-ENGINE ITEM (the second request_config on the record-service
	 * component). Two wire facts this pins, both live CLIENT contracts:
	 *
	 *  - `api_config` — component_portal.js:2054 builds the record link as
	 *    `api_config.ui_base_url + section_id`. TS publishes a SHAPED copy
	 *    (publishApiConfig) without the URLs the server itself fetches
	 *    (`api_url`, `api_url_search` — WC-2026-11-19-external-api-url-unpublished);
	 *    the rest is field-identical to the oracle's raw echo, which is what
	 *    this asserts.
	 *  - the HYDRATED `fields_map` (step 9) — service_autocomplete.js:911/:1060
	 *    read `show.ddo_map[j].fields_map[0].remote` to shape the answer and to
	 *    build `&field[]=`. The ontology stores the flag `fields_map: true`; if
	 *    the engine leaves it a boolean the autocomplete asks for no fields.
	 *
	 * Driven through case A's rqo (the one whose harvested answer carries the
	 * record-service context entry).
	 */
	test.if(EXTERNAL_ONTOLOGY_PRESENT)(
		'external engine item: api_config + hydrated fields_map match PHP',
		async () => {
			const caseARqo = structuredClone(READ_RQO) as typeof READ_RQO;
			caseARqo.show.ddo_map = [
				{ tipo: PORTAL, section_tipo: 'self', parent: 'self', mode: 'list' },
			];

			const client = new PhpApiClient();
			await client.login(
				config.phpReference.username as string,
				config.phpReference.password as string,
			);
			const { body } = await client.call(structuredClone(caseARqo));
			const phpItem = externalItemOf(
				(adoptFrozen(body).result as { context: Record<string, unknown>[] }).context,
			);
			const tsResult = await readSection(caseARqo as unknown as Rqo);
			const tsItem = externalItemOf(tsResult.context as unknown as Record<string, unknown>[]);

			// The fixture MUST still carry the case (a silent absence would make every
			// assertion below vacuous).
			expect(phpItem, 'no api_engine!==dedalo item in the oracle answer').toBeDefined();
			expect(tsItem).toBeDefined();

			// api_config: same fields, same values (key order is not a wire fact) —
			// minus the two URLs the SERVER fetches, which TS no longer publishes
			// (WC-2026-11-19-external-api-url-unpublished: no client code reads them).
			const {
				api_url: _apiUrl,
				api_url_search: _apiUrlSearch,
				...phpPublished
			} = (phpItem?.api_config ?? {}) as Record<string, unknown>;
			// FLOOR: the transform removed something real from the frozen answer.
			expect(typeof _apiUrl).toBe('string');
			expect(tsItem?.api_config).toEqual(phpPublished as never);
			expect(
				(tsItem?.api_config as { ui_base_url?: string })?.ui_base_url,
				'a non-http(s) ui_base_url would be stored XSS on the portal edit click',
			).toMatch(/^https?:\/\//);

			// The hydrated per-ddo surface the autocomplete reads.
			expect(externalDdoSurface(tsItem)).toEqual(externalDdoSurface(phpItem) as never);
			for (const ddo of externalDdoSurface(tsItem)) {
				expect(Array.isArray(ddo.fields_map), `${ddo.tipo} fields_map stayed a flag`).toBe(true);
			}
		},
		30000,
	);

	test('show ddo_map resolves identically (tipo/parent/section_tipo/mode, in order)', () => {
		for (let index = 0; index < phpConfig.length; index++) {
			const phpShow = (phpConfig[index] as { show?: { ddo_map?: RawDdo[] } }).show;
			const tsShow = (tsConfig[index] as { show?: { ddo_map?: RawDdo[] } }).show;
			const phpMap = phpShow?.ddo_map ?? [];
			const tsMap = tsShow?.ddo_map ?? [];
			expect(tsMap.length).toBe(phpMap.length);
			for (let ddoIndex = 0; ddoIndex < phpMap.length; ddoIndex++) {
				expect(ddoIdentity(tsMap[ddoIndex] as RawDdo)).toEqual(
					ddoIdentity(phpMap[ddoIndex] as RawDdo),
				);
			}
		}
	});
});
