/**
 * TRIPWIRE — the external-service registry is TOTAL over the installation's
 * ontology, and every adapter is fully declared.
 *
 * The failure this prevents: an ontology node names an `api_engine` or an
 * `api_config.entity` that nothing implements, and the engine answers with an
 * empty component instead of a named error. Empty is indistinguishable from
 * "this record has no data", so a typo made during cataloguing becomes an
 * invisible data loss. Hence the registry THROWS
 * `ExternalServiceNotRegisteredError` and never returns null or `[]` — asserted
 * here in both directions.
 *
 * CENSUS SOURCE. `test/fixtures/external/ontology_census.json` is a FROZEN
 * harvest of the installation's dd_ontology (2026-08-05), not a live query: the
 * gate must be credless and deterministic, and the test database holds a
 * different (smaller) ontology than the application one, so a live census would
 * quietly assert less than it claims. Re-harvest deliberately, as a contract
 * edit, with:
 *
 *   psql -d dedalo_mib_v7 -tAX -c "SELECT jsonb_pretty(jsonb_build_object(
 *     'api_engine_nodes', …, 'api_config_sections', …, 'component_external_nodes', …))"
 *
 * (the full query is in the Stage-2 commit message; the three keys are: nodes
 * whose properties.source.request_config declares a non-'dedalo' api_engine,
 * sections carrying properties.api_config, and every model='component_external'
 * node with its fields_map).
 */
// Migrated to the generic `test` TLD 2026-08-19: the external SECTION coordinate is now
// the generic clone `test7342` (src/core/test_data/test_tld_tipo_map.json); the `zenon`
// connector itself is an engine module, not an install's ontology, and stays.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseApiConfig } from '../../src/external/config.ts';
import { ExternalServiceNotRegisteredError } from '../../src/external/errors.ts';
import {
	decodeRemoteIdWith,
	encodeRemoteIdWith,
	parseFieldsMap,
	remoteFieldsOf,
} from '../../src/external/fields_map.ts';
import { getExternalService, listExternalServices } from '../../src/external/registry.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';
import census from '../fixtures/external/ontology_census.json';

interface CensusEngineNode {
	tipo: string;
	model: string;
	engines: string[];
}
interface CensusApiConfigSection {
	tipo: string;
	model: string;
	api_config: unknown;
}
interface CensusExternalNode {
	tipo: string;
	parent: string;
	fields_map: unknown;
}

const engineNodes = census.api_engine_nodes as CensusEngineNode[];
const apiConfigSections = census.api_config_sections as CensusApiConfigSection[];
const externalNodes = census.component_external_nodes as CensusExternalNode[];

/**
 * The hosts the CENSUS names. Declared here, not in the environment, so the
 * gate is credless: parseApiConfig applies the operator allowlist, and this
 * states which hosts the frozen census legitimately points at.
 */
const CENSUS_HOSTS = [
	...new Set(
		apiConfigSections.flatMap((section) => {
			const config = section.api_config as Record<string, unknown>;
			return ['api_url', 'api_url_search']
				.map((field) => config[field])
				.filter((value): value is string => typeof value === 'string')
				.map((value) => new URL(value).hostname);
		}),
	),
];

beforeAll(() => {
	overrideExternalSettingsForTests({ enabled: true, allowedHosts: CENSUS_HOSTS });
});

afterAll(() => {
	overrideExternalSettingsForTests(null);
});

describe('the census is non-empty (a gate over nothing proves nothing)', () => {
	test('the frozen harvest still describes a real installation', () => {
		expect(engineNodes.length).toBeGreaterThanOrEqual(6);
		expect(apiConfigSections.length).toBeGreaterThanOrEqual(3);
		expect(externalNodes.length).toBeGreaterThanOrEqual(8);
		expect(CENSUS_HOSTS.length).toBeGreaterThan(0);
	});
});

describe('every ontology-declared service resolves to an adapter', () => {
	test('every non-dedalo api_engine is registered', () => {
		const unregistered: string[] = [];
		for (const node of engineNodes) {
			for (const engine of node.engines) {
				if (engine === 'dedalo') continue; // the engine's own resolver, not an adapter
				try {
					getExternalService(engine, { sectionTipo: node.tipo });
				} catch {
					unregistered.push(`${node.tipo} (${node.model}) → ${engine}`);
				}
			}
		}
		expect(
			unregistered,
			'ontology nodes name an api_engine no src/external/services/ adapter implements',
		).toEqual([]);
	});

	test('every api_config.entity is registered', () => {
		const unregistered: string[] = [];
		for (const section of apiConfigSections) {
			const entity = (section.api_config as Record<string, unknown>).entity;
			try {
				getExternalService(String(entity), { sectionTipo: section.tipo });
			} catch {
				unregistered.push(`${section.tipo} → ${String(entity)}`);
			}
		}
		expect(unregistered).toEqual([]);
	});

	test('an UNKNOWN name throws — it never returns null or an empty list', () => {
		let thrown: unknown;
		try {
			getExternalService('no_such_service', { sectionTipo: 'test7342' });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ExternalServiceNotRegisteredError);
		expect((thrown as ExternalServiceNotRegisteredError).kind).toBe('not_registered');
		// The message names the section AND what is registered — an operator can act on it.
		expect((thrown as Error).message).toContain('test7342');
		expect((thrown as Error).message).toContain('zenon');
	});
});

describe('every api_config in the installation validates', () => {
	for (const section of apiConfigSections) {
		test(`${section.tipo} parses through parseApiConfig`, () => {
			const parsed = parseApiConfig(section.api_config, { sectionTipo: section.tipo });
			expect(parsed.entity).toBe(String((section.api_config as Record<string, unknown>).entity));
			expect(parsed.apiUrl.startsWith('https://')).toBe(true);
			// The parsed shape carries NO key that could be a credential.
			for (const key of Object.keys(parsed)) {
				expect(key).not.toMatch(/key|token|secret|password|auth/i);
			}
		});
	}
});

describe('every component_external node has a well-formed fields_map', () => {
	for (const node of externalNodes) {
		test(`${node.tipo} (parent ${node.parent})`, () => {
			const entries = parseFieldsMap(node.fields_map, { tipo: node.tipo });
			expect(entries.length).toBeGreaterThan(0);
			// A component_external with no 'dato' row can never show a value.
			expect(entries.some((entry) => entry.local === 'dato')).toBe(true);
			expect(remoteFieldsOf(entries).length).toBeGreaterThan(0);
			// Every declared format must exist on the adapter that will run it.
			for (const entry of entries) {
				if (entry.format === undefined) continue;
				const model = getExternalService('zenon');
				expect(
					model.formats?.[entry.format],
					`${node.tipo} declares format '${entry.format}'`,
				).toBeDefined();
			}
		});
	}
});

describe('every adapter is fully declared', () => {
	for (const model of listExternalServices()) {
		test(`${model.service} declares egress, capabilities and remoteIdShape`, () => {
			expect(['record_identifiers', 'query_terms', 'record_content']).toContain(model.egress);
			expect(['numeric_string', 'opaque_token']).toContain(model.remoteIdShape);
			for (const capability of ['ordering', 'pagination', 'listColumns', 'search'] as const) {
				expect(typeof model.capabilities[capability]).toBe('boolean');
			}
			expect(typeof model.buildRecordRequest).toBe('function');
			// A declared search capability with no builder is legal (the engine side
			// is unported) — but unwrapSearch without buildSearchRequest is not.
			if (model.unwrapSearch !== undefined) expect(model.buildSearchRequest).toBeDefined();
			// A search-only rendering (searchFormats, owner C55) names a declared
			// format on BOTH sides, or a search cell would throw bad_config at run time.
			for (const [recordFormat, searchFormat] of Object.entries(model.searchFormats ?? {})) {
				expect(model.formats?.[recordFormat], `${model.service} searchFormats key`).toBeDefined();
				expect(model.formats?.[searchFormat], `${model.service} searchFormats value`).toBeDefined();
			}
		});

		test(`${model.service} id codec round-trips and yields locator-safe tokens`, () => {
			const samples =
				model.remoteIdShape === 'numeric_string'
					? ['0', '42', '000848571', '001338683']
					: ['Q42', 'sh85-001', 'a.b:c'];
			for (const id of samples) {
				const encoded = encodeRemoteIdWith(model, id);
				expect(decodeRemoteIdWith(model, encoded)).toBe(id);
				// Locator-safe: none of the separators the cache key / locator use.
				expect(encoded).not.toMatch(/[|/?#&=\s]/);
			}
		});

		test(`${model.service} credential is a KEY NAME, never a value`, () => {
			if (model.credentialCatalogKey === undefined) return;
			expect(model.credentialCatalogKey).toMatch(/^DEDALO_[A-Z0-9_]+$/);
		});
	}
});
