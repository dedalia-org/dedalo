/**
 * AUTOCOMPLETE picker search vs live PHP (BUG-0 gate, 2026-07-09).
 *
 * The service_autocomplete target-record picker sends a component-source
 * `action:'read'` RQO (`source.action:'search'`, `source.model:'component_*'`,
 * NO section_id) whose SQO carries the typed q. The TS facade used to swallow
 * that shape into the component get_data no-id empty shell — the picker
 * rendered empty for EVERY user while a green suite proved nothing (no gate
 * drove this exact RQO shape). This differential sends the byte-shape the
 * client builds (service_autocomplete.js dedalo_engine + common.js
 * build_rqo_search) to BOTH engines:
 *
 *  - membership+values: a q with 0 < total < limit (order-free: neither
 *    engine emits ORDER BY without sqo.order, so compare entries as a SET and
 *    per-ddo values keyed by (tipo, section_id));
 *  - scale: a q matching far more than limit — both engines return exactly
 *    `limit` entries and their `count` totals agree.
 *
 * Fixtures: host test6099 / portal test6157 → target test6100; q fields
 * test6224/test6265 (component_text_area). The stored values are svg-marker
 * markup, so the q fixtures are substrings of that markup ('379' → 6 records
 * on both engines, probed 2026-07-09 against the install those clones were
 * taken from).
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-test-tld-replay-search-group).
// Every section/component is addressed in `test`-TLD terms (the frozen PHP
// interaction is reached through `unmapRqo`), except `rsc92`/`rsc197`, which
// are SEED-SHIPPED ontology every installation carries and are spelled through
// `seed()`. The records are the committed test corpus, owned by this gate.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { adoptTipoIdMap } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

registerSessionCleanup();

/** A SEED-SHIPPED tipo, spelled out of the install-TLD census's token grammar. */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** Every section the four pickers search — this gate owns these records. */
const CORPUS_SECTIONS = [
	'test6099',
	'test6100',
	'testmint1',
	'test2830',
	seed('rsc', 197),
] as const;

const HOST_SECTION = 'test6099';
const PORTAL = 'test6157';
const TARGET_SECTION = 'test6100';
const Q_FIELD_A = 'test6224';
const Q_FIELD_B = 'test6265';
const LIMIT = 30;
const SMALL_Q = '379'; // 6 matches on both engines (must stay < LIMIT)
const LARGE_Q = 'a'; // >1000 matches on both engines

/** The exact RQO the client's service_autocomplete dedalo_engine sends. */
function autocompleteRqo(q: string): Record<string, unknown> {
	return {
		id: 'ac_diff',
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			type: 'component',
			action: 'search',
			model: 'component_portal',
			tipo: PORTAL,
			section_tipo: HOST_SECTION,
			mode: 'list',
			lang: 'lg-spa',
			config: { read_only: true },
		},
		show: {
			ddo_map: [
				{
					tipo: Q_FIELD_A,
					section_tipo: TARGET_SECTION,
					model: 'component_text_area',
					parent: PORTAL,
					mode: 'list',
					label: 'Contramarca anverso',
				},
				{
					tipo: Q_FIELD_B,
					section_tipo: TARGET_SECTION,
					model: 'component_text_area',
					parent: PORTAL,
					mode: 'list',
					label: 'Contramarca reverso',
				},
			],
			fields_separator: ' | ',
			columns: [],
		},
		sqo: {
			id: 'tmp',
			mode: 'search',
			section_tipo: [TARGET_SECTION],
			filter: {
				$and: [
					{
						$or: [
							{
								q,
								path: [{ section_tipo: TARGET_SECTION, component_tipo: Q_FIELD_A }],
								q_split: true,
							},
							{
								q,
								path: [{ section_tipo: TARGET_SECTION, component_tipo: Q_FIELD_B }],
								q_split: true,
							},
						],
					},
				],
			},
			limit: LIMIT,
			offset: 0,
			full_count: false,
			allow_sub_select_by_id: true,
			skip_projects_filter: true,
		},
	};
}

function countRqo(q: string): Record<string, unknown> {
	const rqo = autocompleteRqo(q);
	rqo.action = 'count';
	rqo.source = {
		typo: 'source',
		model: 'section',
		tipo: TARGET_SECTION,
		section_tipo: TARGET_SECTION,
		action: 'count',
		mode: 'list',
		lang: 'lg-spa',
	};
	return rqo;
}

type DataItem = {
	typo?: string;
	tipo?: string;
	section_id?: number | string;
	entries?: { section_tipo: string; section_id: number | string }[];
	value?: unknown;
	fallback_value?: unknown;
};
type ReadResult = { context: unknown[]; data: DataItem[] };

async function tsCall(rqo: Record<string, unknown>): Promise<ReadResult> {
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);
	const dispatched = await dispatchRqo(
		structuredClone(rqo) as never,
		{
			requestId: 'ac-diff',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal,
		} as never,
	);
	return (dispatched.body as { data: ReadResult }).data;
}

let php: PhpApiClient | null = null;
beforeAll(async () => {
	await ensureTestCorpus([...CORPUS_SECTIONS]);
	if (!hasPhpCredentials()) return;
	php = new PhpApiClient();
	await php.login(config.phpReference.username as string, config.phpReference.password as string);
}, 60000);

afterAll(async () => {
	expect(await dropTestCorpus([...CORPUS_SECTIONS])).toBe(0);
});

/**
 * The frozen (install-term) reply, read in the `test` terms every RQO above is
 * written in. ADOPTED SLICE = `data[]`, which is all this gate compares (the
 * entry set, the per-ddo values, the ddinfo breadcrumbs): the reply's `context`
 * carries the install AREA node above the clone root, for which the clone has
 * no twin by construction (context_differential owns that seam). `matched` is
 * the totality assertion over the compared slice; the floors are the
 * anti-vacuity check — a picker reply naming a cloned section and its
 * components on every row cannot map with zero rewrites.
 *
 * A COUNT reply carries no `data[]` (just `total`), so there is nothing to
 * adopt and nothing to compare in test terms — the number travels as is.
 */
async function phpCall(rqo: Record<string, unknown>): Promise<ReadResult> {
	const body = (await (php as PhpApiClient).call(structuredClone(rqo))).body as {
		result: ReadResult;
	};
	const frozen = body.result;
	if (!Array.isArray(frozen?.data)) return frozen;
	const adopted = adoptTipoIdMap(frozen.data, 'autocomplete_search_differential');
	expect(adopted.matched, adopted.detail ?? '').toBe(true);
	expect(adopted.rewrites.tipos).toBeGreaterThan(0);
	return { ...frozen, data: adopted.body };
}

/** entries → order-free comparable set of `${section_tipo}/${section_id}`. */
function entryKeySet(result: ReadResult): Set<string> {
	const sections = result.data.find((item) => item.typo === 'sections');
	return new Set(
		(sections?.entries ?? []).map((entry) => `${entry.section_tipo}/${entry.section_id}`),
	);
}

/** Per-ddo values keyed `(tipo, section_id)` for the q fields. */
function ddoValueMap(result: ReadResult): Map<string, string> {
	const map = new Map<string, string>();
	for (const item of result.data) {
		if (item.tipo !== Q_FIELD_A && item.tipo !== Q_FIELD_B) continue;
		map.set(`${item.tipo}@${item.section_id}`, JSON.stringify(item.value ?? null));
	}
	return map;
}

describe.if(hasPhpCredentials())('autocomplete picker search differential (BUG-0)', () => {
	test('membership+values: small q returns the SAME record set and ddo values', async () => {
		const tsResult = await tsCall(autocompleteRqo(SMALL_Q));
		const phpResult = await phpCall(autocompleteRqo(SMALL_Q));

		const tsKeys = entryKeySet(tsResult);
		const phpKeys = entryKeySet(phpResult);
		// Fixture guard: drift to 0 or >= LIMIT must redden loudly, not pass vacuously.
		expect(phpKeys.size).toBeGreaterThan(0);
		expect(phpKeys.size).toBeLessThan(LIMIT);
		expect([...tsKeys].sort()).toEqual([...phpKeys].sort());

		// Per-row component values (what the picker rows render from).
		const tsValues = ddoValueMap(tsResult);
		const phpValues = ddoValueMap(phpResult);
		for (const [key, phpValue] of phpValues) {
			expect(tsValues.get(key) ?? '(missing)').toBe(phpValue);
		}
	}, 60000);

	test('scale: large q fills the page on both engines and count totals agree', async () => {
		const tsResult = await tsCall(autocompleteRqo(LARGE_Q));
		const phpResult = await phpCall(autocompleteRqo(LARGE_Q));
		expect(entryKeySet(tsResult).size).toBe(LIMIT);
		expect(entryKeySet(phpResult).size).toBe(LIMIT);

		const tsCount = await tsCall(countRqo(LARGE_Q));
		const phpCount = await phpCall(countRqo(LARGE_Q));
		const tsTotal = Number((tsCount as unknown as { total?: unknown }).total);
		const phpTotal = Number((phpCount as unknown as { total?: unknown }).total);
		expect(phpTotal).toBeGreaterThan(LIMIT);
		expect(tsTotal).toBe(phpTotal);
	}, 60000);

	test('real portal shape: $and over [text, date] lang-less fields (Ceca test6113)', async () => {
		// Browser-captured shape (2026-07-09): the Ceca picker sends the typed q
		// to EVERY search field under $and — a translatable input_text
		// (testmint1002, NO clause lang) AND a component_date (testmint1033).
		// Two hard-won parity rules pinned here:
		//  - the unparseable free-text date clause is DROPPED (PHP
		//    extract_normalized_date_q; without the drop the $and zeroes out and
		//    the picker renders empty);
		//  - a lang-less clause searches ALL langs (PHP component_common
		//    get_search_query lang='all'; one match has 'roma' only in lg-eng).
		const rqo = {
			id: 'ac_diff_ceca',
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				type: 'component',
				action: 'search',
				model: 'component_portal',
				tipo: 'test6113',
				section_tipo: HOST_SECTION,
				mode: 'list',
				view: 'line',
				lang: 'lg-nolan',
				config: { read_only: true },
			},
			show: {
				ddo_map: [
					{
						tipo: 'testmint1002',
						section_tipo: ['testmint1'],
						model: 'component_input_text',
						parent: 'test6113',
						mode: 'list',
						label: 'Ceca',
					},
					{
						tipo: 'testmint1033',
						section_tipo: ['testmint1'],
						model: 'component_date',
						parent: 'test6113',
						mode: 'list',
						label: 'Marco temporal',
					},
				],
				fields_separator: ' | ',
				columns: [],
			},
			sqo: {
				mode: 'edit',
				section_tipo: ['testmint1'],
				filter: {
					$and: [
						{
							$and: [
								{
									q: 'roma',
									path: [{ section_tipo: 'testmint1', component_tipo: 'testmint1002' }],
									q_split: true,
								},
								{
									q: 'roma',
									path: [{ section_tipo: 'testmint1', component_tipo: 'testmint1033' }],
									q_split: true,
								},
							],
						},
					],
				},
				offset: 0,
				limit: 30,
				full_count: false,
				allow_sub_select_by_id: true,
				skip_projects_filter: true,
			},
		};
		const tsResult = await tsCall(rqo);
		const phpResult = await phpCall(rqo);
		const tsKeys = entryKeySet(tsResult);
		const phpKeys = entryKeySet(phpResult);
		expect(phpKeys.size).toBeGreaterThan(0); // fixture guard (5 on 2026-07-09)
		expect(phpKeys.size).toBeLessThan(LIMIT);
		expect([...tsKeys].sort()).toEqual([...phpKeys].sort());
	}, 60000);

	test('multilingual thesaurus picker: fallback_value + ddinfo breadcrumb byte-equal (seed portal → test2830)', async () => {
		// The rsc92 "Municipio de residencia" shape (2026-07-09): translatable
		// terms stored only in lg-fra must arrive as fallback_value (the fallback
		// chain iterates DEDALO_PROJECTS_DEFAULT_LANGS — config, never hardcoded), and
		// each row carries its {tipo:'ddinfo'} ancestor breadcrumb ending at the
		// ROOT TERM (no trailing hierarchy label — that shape belongs to the
		// portal-cell ddinfo only).
		const rqo = {
			// Spelled through `seed()` so the census reads no install binding; the
			// STRING is unchanged, and it is part of the frozen request hash.
			id: `ac_diff_${seed('rsc', 92)}`,
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				type: 'component',
				action: 'search',
				model: 'component_portal',
				tipo: seed('rsc', 92),
				section_tipo: seed('rsc', 197),
				section_id: 2,
				mode: 'list',
				lang: 'lg-spa',
				config: { read_only: true },
			},
			show: {
				ddo_map: [
					{
						tipo: 'hierarchy25',
						parent: seed('rsc', 92),
						section_tipo: ['test2830'],
						model: 'component_input_text',
						mode: 'list',
						label: 'Término',
						fixed_mode: true,
						value_with_parents: true,
					},
				],
				fields_separator: ', ',
				columns: [],
			},
			sqo: {
				id: 'tmp',
				mode: 'search',
				section_tipo: ['test2830'],
				filter: {
					$and: [
						{
							$or: [
								{
									q: 'par',
									path: [{ section_tipo: 'test2830', component_tipo: 'hierarchy25' }],
									q_split: true,
								},
							],
						},
					],
				},
				limit: 10,
				offset: 0,
				full_count: false,
				allow_sub_select_by_id: true,
				skip_projects_filter: true,
			},
		};
		const tsResult = await tsCall(rqo);
		const phpResult = await phpCall(rqo);
		const collect = (result: ReadResult) => ({
			ddinfo: result.data
				.filter((item) => item.tipo === 'ddinfo')
				.map((item) => `${item.section_id}:${((item.value as string[]) ?? []).join('>')}`),
			fallback: result.data
				.filter((item) => item.tipo === 'hierarchy25')
				.map((item) => `${item.section_id}:${JSON.stringify(item.fallback_value ?? null)}`),
		});
		const ts = collect(tsResult);
		const php = collect(phpResult);
		expect(php.ddinfo.length).toBeGreaterThan(0); // fixture guard
		expect(php.fallback.some((entry) => entry.includes('lg-'))).toBe(true); // at least one fallback resolved
		expect(ts.ddinfo).toEqual(php.ddinfo);
		expect(ts.fallback).toEqual(php.fallback);
	}, 60000);
});
