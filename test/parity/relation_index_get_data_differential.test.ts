/**
 * Phase 6 gate: relation_index get_data differential — offset-aware inverse
 * paging + the pool-accumulation child quirk (locator pass i re-emits every
 * pool record so far; offset 0 seeds the pool with the pointing section's
 * representative record, later pages don't).
 */
// GENERIC-TLD MIGRATED 2026-08-19 (phase 4 pilot, WC-2026-08-19-test-tld-replay).
// The RQO names the CLONED thesaurus term (testcult1/1) and its cloned
// relation_index component (testcult1020 — a SECTION-SCOPED clone: the twenty-two
// synthetic thesauri were twinned from the same hierarchy20 subtree, so the map
// key is `cult1@hierarchy40`, never a flat `hierarchy40`). The pointing records
// live in a seed-shipped section and come from the committed corpus.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import {
	adoptEntriesArrayContract,
	adoptTipoIdMap,
	normalizeSectionIdTypes,
	stripCorpusScaleFields,
} from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** The cloned term section and its cloned relation_index component. */
const SECTION = 'testcult1';
const INDEX_COMPONENT = 'testcult1020';
/**
 * The corpus this gate OWNS: the term itself, and the seed-shipped
 * bibliography section whose records point at it (the index pool).
 */
const CORPUS_SCOPE = [SECTION, `${'rsc'}205`];

const CASES = [
	{ name: 'offset 0', limit: 2, offset: 0 },
	{ name: 'offset 2', limit: 3, offset: 2 },
];

function rqoOf(limit: number, offset: number): Record<string, unknown> {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'component_relation_index',
			tipo: INDEX_COMPONENT,
			section_tipo: SECTION,
			section_id: '1',
			mode: 'list',
			lang: 'lg-spa',
			action: 'get_data',
		},
		sqo: { section_tipo: [SECTION], limit, offset },
	};
}

function comparable(item: Record<string, unknown>): Record<string, unknown> {
	return {
		tipo: item.tipo,
		section_tipo: item.section_tipo,
		section_id: item.section_id,
		mode: item.mode,
		lang: item.lang,
		entries: item.entries ?? null,
		pagination: item.pagination ?? null,
		row_section_id: item.row_section_id ?? null,
		parent_tipo: item.parent_tipo ?? null,
		from_component_tipo: item.from_component_tipo ?? null,
	};
}

/**
 * The CONTEXT comparable (T0-8): what the client reads to build the index's
 * columns (common.js get_columns_map — own dedalo `show.ddo_map` items whose
 * parent is the index) and to bind each cell (the related_list cell contexts'
 * tipo / section_tipo / parent). Deliberate divergences applied to the PHP
 * side, ledgered in WC-2026-11-11-relation-index-related-list-context:
 *  - D2: the index's OWN section is dropped from `sqo.section_tipo` (PHP
 *    prepended it — a v5 fallback artefact; TS lists the pointing sections);
 *  - D3: pointing-section contexts (model section) are not compared — TS emits
 *    none;
 *  - PHP repeated each cell context once per locator pass; TS dedupes by
 *    context key — compared as a deduplicated set in first-seen order.
 */
interface ContextComparable {
	sqoSections: string[];
	ddoMap: { tipo: unknown; section_tipo: unknown; parent: unknown; mode: unknown }[];
	cells: { tipo: unknown; section_tipo: unknown; parent: unknown }[];
}

type ContextEntry = Record<string, unknown> & {
	request_config?: {
		api_engine?: string;
		sqo?: { section_tipo?: unknown[] };
		show?: { ddo_map?: Record<string, unknown>[] };
	}[];
};

/** The PHP index's install-term tipo: its own context entry's, before the clone map. */
function installIndexTipoOf(body: unknown): string | null {
	const context = ((body as { result?: { context?: ContextEntry[] } }).result?.context ??
		[]) as ContextEntry[];
	const own = context.find((entry) => entry.model === 'component_relation_index');
	return typeof own?.tipo === 'string' ? own.tipo : null;
}

/** A `parent` naming the index (by its test-TLD tipo or its install-term one) → the test tipo. */
function indexParentOf(parent: unknown, indexAliases: ReadonlySet<string>): unknown {
	return typeof parent === 'string' && indexAliases.has(parent) ? INDEX_COMPONENT : parent;
}

function contextComparable(
	context: ContextEntry[],
	indexAliases: ReadonlySet<string> = new Set([INDEX_COMPONENT]),
): ContextComparable {
	const own = context.find(
		(entry) => entry.tipo === INDEX_COMPONENT && entry.section_tipo === SECTION,
	);
	const dedalo = (own?.request_config ?? []).find(
		(item) => (item.api_engine ?? 'dedalo') === 'dedalo',
	);
	const sqoSections = (dedalo?.sqo?.section_tipo ?? [])
		.map((entry) => (typeof entry === 'string' ? entry : (entry as { tipo?: string })?.tipo))
		.filter((tipo): tipo is string => typeof tipo === 'string' && tipo !== SECTION); // D2
	const ddoMap = (dedalo?.show?.ddo_map ?? []).map((ddo) => ({
		tipo: ddo.tipo,
		section_tipo: ddo.section_tipo,
		parent: indexParentOf(ddo.parent, indexAliases),
		mode: ddo.mode,
	}));
	const seen = new Set<string>();
	const cells: ContextComparable['cells'] = [];
	for (const entry of context) {
		if (entry.mode !== 'related_list' || entry.model === 'section') continue; // D3
		const key = `${String(entry.tipo)}_${String(entry.section_tipo)}`;
		if (seen.has(key)) continue; // PHP per-locator-pass repeats
		seen.add(key);
		cells.push({
			tipo: entry.tipo,
			section_tipo: entry.section_tipo,
			parent: indexParentOf(entry.parent, indexAliases),
		});
	}
	return { sqoSections, ddoMap, cells };
}

const results = new Map<
	string,
	{ php: Record<string, unknown>[]; ts: Record<string, unknown>[] }
>();
const contexts = new Map<string, { php: ContextComparable; ts: ContextComparable }>();

beforeAll(async () => {
	await ensureTestCorpus(CORPUS_SCOPE);
	if (!hasPhpCredentials()) return;
	const php = new PhpApiClient();
	await php.login(config.phpReference.username as string, config.phpReference.password as string);
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);

	for (const testCase of CASES) {
		const rqo = rqoOf(testCase.limit, testCase.offset);
		// WC-001 (unified []): rewrite the PHP side only (see engineering/wire_contract/).
		// WC-2026-08-10-section-id-int-canonical: address keys compared by VALUE on BOTH sides (fixtures keep the PHP-era numeric strings).
		// WC-2026-08-19-test-tld-replay: the frozen install-term body, read in
		// test-TLD terms (the section-scoped component clone is the point).
		const rawPhpBody = (await php.call(structuredClone(rqo))).body;
		// The install-term tipo of the index (read before the map is adopted):
		// the section-scoped clone map rewrites the index's own entry but not the
		// `parent` of ddos whose section is the POINTING one (rsc205), so the
		// context projection names the index by role (indexAliasesOf).
		const phpIndexTipo = installIndexTipoOf(structuredClone(rawPhpBody));
		const adopted = adoptTipoIdMap(rawPhpBody, 'relation_index_get_data_differential');
		expect(adopted.matched).toBe(true);
		expect(adopted.rewrites.tipos).toBeGreaterThan(0);
		expect(adopted.rewrites.ids).toBeGreaterThan(0);
		const phpData = normalizeSectionIdTypes(
			adoptEntriesArrayContract(
				(adopted.body as { result?: { data?: unknown[] } }).result?.data ?? [],
			) as Record<string, unknown>[],
		);
		const tsResult = await dispatchRqo(
			structuredClone(rqo) as never,
			{
				requestId: 't',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal,
			} as never,
		);
		// WC-2026-08-10-section-id-int-canonical: address keys compared by VALUE on BOTH sides (fixtures keep the PHP-era numeric strings).
		const tsData = normalizeSectionIdTypes(
			((tsResult.body as { data?: { data?: unknown[] } }).data?.data ?? []) as Record<
				string,
				unknown
			>[],
		);
		results.set(testCase.name, { php: phpData, ts: tsData });
		contexts.set(testCase.name, {
			php: contextComparable(
				((adopted.body as { result?: { context?: unknown[] } }).result?.context ??
					[]) as ContextEntry[],
				new Set([INDEX_COMPONENT, ...(phpIndexTipo === null ? [] : [phpIndexTipo])]),
			),
			ts: contextComparable(
				((tsResult.body as { data?: { context?: unknown[] } }).data?.context ??
					[]) as ContextEntry[],
			),
		});
	}
}, 120000);

afterAll(async () => {
	expect(await dropTestCorpus(CORPUS_SCOPE)).toBe(0);
});

describe.if(hasPhpCredentials())(
	'relation_index get_data differential (paging + pool children)',
	() => {
		for (const testCase of CASES) {
			test(`${testCase.name}: item sequence matches PHP`, () => {
				const pair = results.get(testCase.name);
				expect(pair).toBeDefined();
				// The unfiltered `pagination.total` counts every record in the
				// install that points at this term; the corpus holds the handful the
				// frozen pages revealed. Declared, justified and REFUSED-IF-ABSENT
				// in CORPUS_SCALE_FIELDS — the paged item sequence, which is what
				// this gate is about, stays verbatim on both sides.
				const gate = 'relation_index_get_data_differential';
				// Non-empty floor FIRST, on both sides: an inverse index that
				// resolves nothing must redden HERE, with a legible message,
				// instead of surfacing as a projection refusal three lines down.
				// (The TS side resolves because the corpus carries the INVERSE
				// EDGES — the rsc387 locators on rsc205/37,42,44,69,74 that point
				// at the term — materialized by derive_test_corpus.ts from the
				// far end and audited as `inverse_edges[]` on each pointing
				// record. Without them the index would resolve 0 items here.)
				expect((pair?.php ?? []).length).toBeGreaterThan(1);
				expect((pair?.ts ?? []).length).toBeGreaterThan(1);
				const phpItems = stripCorpusScaleFields((pair?.php ?? []).map(comparable), gate);
				const tsItems = stripCorpusScaleFields((pair?.ts ?? []).map(comparable), gate);
				expect(phpItems.length).toBeGreaterThan(1);
				// ORDER matters here: the pool-accumulation duplicates are positional.
				expect(tsItems).toEqual(phpItems);
			});
			test(`${testCase.name}: related_list column context matches PHP`, () => {
				const pair = contexts.get(testCase.name);
				expect(pair).toBeDefined();
				// Non-vacuity on BOTH sides: the PHP store carries the merged map,
				// and an empty TS map is the T0-8 bug itself.
				expect(pair?.php.ddoMap.length ?? 0).toBeGreaterThan(0);
				expect(pair?.php.cells.length ?? 0).toBeGreaterThan(0);
				expect(pair?.ts.ddoMap.length ?? 0).toBeGreaterThan(0);
				expect(pair?.ts).toEqual(pair?.php as ContextComparable);
			});
		}
	},
);
