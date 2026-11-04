/**
 * REQUEST_CONFIG NARROWING CENSUS — a TRANSITIONAL RATCHET.
 *
 * A relation component may declare SEVERAL request_config items: a `main` plus
 * a `secondary` scope, or a `dedalo` item plus a non-dedalo one. Fourteen nodes
 * in this installation declare more than one; five of those declare a second
 * ENGINE (rsc368, numisdata162, rsc1285, tchi29, test204 — plus test61, whose
 * ONLY item is `zenon`, the external-only shape. test204 is NOT external-only:
 * its first item declares no api_engine, i.e. implicit dedalo.)
 *
 * Sites that need ONE item therefore have to CHOOSE, and every hand-rolled
 * choice in the engine was wrong for an external-only component: the
 * `find(dedalo)` spellings produced `undefined` and then silently nothing, and
 * the `find(dedalo) ?? rcs[0]` spellings produced the EXTERNAL item and then
 * asked the dedalo engine to order, page or SQL-search it.
 *
 * This file is the complete census of those sites and what each of them does
 * today. It exists because the fix is staged: five sites negotiate with the
 * adapter (relations/request_config/engine_select.ts), ONE injects the
 * caller's children per engine and slot (the element node every context and
 * data item is built from), three ddo-map sites stopped narrowing altogether
 * (they consume EVERY item — relations/config_ddo_map.ts), TWO narrow with no gate at all because their
 * concern is local paging that no adapter can answer (`local`), and the rest
 * are listed with the reason they are still indexed, so none of them is a
 * silent narrowing.
 *
 * ═══ END CONDITION ═══
 * DELETE THIS FILE when the DEFERRED list below is empty — i.e. when every
 * site that narrows a COMPONENT-owned request_config either negotiates a
 * capability or has been converted to consume every item. Nothing else about
 * it is permanent: it is scaffolding for a migration, not an invariant.
 * Until then it must never grow: a NEW `[0]` narrowing or a new `api_engine`
 * comparison in a file not listed here fails the scan below.
 *
 * Registered in engineering/TRIPWIRES.md + scripts/verify.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineOf } from '../../src/core/relations/request_config/engine_select.ts';
import census from '../fixtures/external/ontology_census.json';

const ROOT = join(import.meta.dir, '..', '..');

type Status =
	| 'negotiated' // consults the adapter through selectConfigItemForConcern
	| 'engine_matched' // injects per ENGINE (caller_injection.injectCallerChildren): no single item chosen
	| 'flattened' // no longer narrows: consumes EVERY item's ddo map
	| 'local' // narrows, but the concern is answered LOCALLY — no capability gate
	| 'section_owned' // the config belongs to a SECTION (or an AREA), which is never multi-engine
	| 'deferred'; // still indexed; the reason says why that is safe TODAY

interface CensusEntry {
	readonly file: string;
	/** The function the narrowing lives in. */
	readonly symbol: string;
	readonly status: Status;
	/** The `site` string passed to selectConfigItemForConcern (negotiated only). */
	readonly site?: string;
	/** The capability consulted (negotiated only). */
	readonly concern?: 'ordering' | 'pagination' | 'listColumns' | 'search';
	readonly reason: string;
}

/**
 * THE CENSUS. Every site in `src/**` that reads a single request_config item,
 * or that used to. Ordered by file.
 */
const CENSUS: readonly CensusEntry[] = [
	// ---- negotiated (5) -----------------------------------------------------
	{
		file: 'src/core/components/component_info/widgets/grid.ts',
		symbol: 'resolveGridColumns',
		status: 'negotiated',
		site: 'component_info/grid.resolveGridColumns',
		concern: 'listColumns',
		reason: 'the info grid renders one column per resolved get_ddo_map ddo',
	},
	{
		file: 'src/core/resolve/relation_list.ts',
		symbol: 'componentFieldsSeparator',
		status: 'negotiated',
		site: 'resolve/relation_list.componentFieldsSeparator',
		concern: 'listColumns',
		reason:
			'the separator joins a component values INSIDE a list/export cell; was find(dedalo) ?? rcs[0]',
	},
	{
		file: 'src/core/search/order_path.ts',
		symbol: 'buildOrderPath',
		status: 'negotiated',
		site: 'search/order_path.pathFor',
		concern: 'ordering',
		reason: 'an ORDER path over an external component needs a service that can order',
	},
	{
		file: 'src/core/section/indexation_grid.ts',
		symbol: 'defaultDdoMap',
		status: 'negotiated',
		site: 'section/indexation_grid.defaultDdoMap',
		concern: 'listColumns',
		reason: 'the leaf relation grid cell renders one column per show ddo',
	},
	{
		file: 'src/core/ts_object/ts_object.ts',
		symbol: 'readComponentShowMap',
		status: 'negotiated',
		site: 'ts_object.readComponentShowMap',
		concern: 'listColumns',
		reason: "the tree 'M' badge renders a value per target record",
	},

	// ---- engine-matched: caller children land per engine, per slot (1) -------
	{
		// nested-ddo_map W3 (2026-11-03): the context's request_config IS the
		// element NODE's effective config (configFrom emission), and the node
		// injects the caller's children through injectCallerChildren — every
		// engine of the caller onto the element's FIRST item of that engine, each
		// slot separately (PHP class.common.php:2629-2678). The retired
		// structure_context rqo-children narrowing picked ONE item for the
		// listColumns concern; nothing is picked any more.
		file: 'src/core/relations/element_node.ts',
		symbol: 'resolveElement injectedConfig (the context request_config source)',
		status: 'engine_matched',
		reason:
			"the caller's children replace the element's map per engine and slot — the same node the data was emitted from",
	},

	// ---- flattened: these no longer narrow at all (2) ------------------------
	{
		// Moved from models/portal.ts (nested-ddo_map W2, 2026-11-03): the portal
		// takes its children off the element NODE, whose data children are the
		// flatten of EVERY effective-config item. The same file's callerOnlyConfig
		// picks the caller's `dedalo` children on purpose — PHP's v5 fallback
		// config (the one a config-less element has) is a single dedalo item, so
		// a non-dedalo caller engine has nothing to land on, exactly as PHP.
		file: 'src/core/relations/element_node.ts',
		symbol: 'directDataChildren (element node data children) + callerOnlyConfig',
		status: 'flattened',
		reason: 'consumes every item through flattenConfigDdoMaps (PHP full_ddo_map)',
	},
	{
		file: 'src/core/section/list_definitions/section_list.ts',
		symbol: 'pickConfig (the ddo map)',
		status: 'flattened',
		reason: 'every item show + hide, deduped structurally',
	},

	// ---- local: narrows, but no adapter can answer the question (2) ----------
	// Both slice a locator array THIS install stores. `capabilities.pagination`
	// is about the SERVICE paging its own result set — a different question, and
	// asking it made zenon's `false` throw out of the section-list read path.
	{
		file: 'src/core/section/list_definitions/section_list.ts',
		symbol: 'pickConfig (the page limit)',
		status: 'local',
		reason:
			'cellLimit slices the caller LOCALLY STORED locator array; the remote paging capability is irrelevant to it, and gating on it 500s every list of the hosting section',
	},
	{
		file: 'src/core/section/read.ts',
		symbol: 'getDataContext pagination sync',
		status: 'local',
		reason:
			"stamps the limit the engine ALREADY paged the emitted data with onto the item's sqo — a mirror of local runtime state, not a request to the service",
	},

	// ---- section-owned: not multi-engine by construction (4) -----------------
	{
		// Censused under its narrowing until W3; the narrowing is gone (the
		// engine-matched element node replaced it) and what the scan still sees
		// is this PRODUCER: an area's synthesized request_config.
		file: 'src/core/resolve/structure_context.ts',
		symbol: 'the area request_config (api_engine literal)',
		status: 'section_owned',
		reason:
			'PRODUCES the one dedalo item an AREA context carries (area.js reads request_config.find(main)); an area is never multi-engine and nothing is narrowed',
	},
	{
		file: 'src/core/resolve/read_tm.ts',
		symbol: 'usernameComponentTipo',
		status: 'section_owned',
		reason: 'reads dd128 (the USERS section) own config; a section never declares api_engine',
	},
	{
		file: 'src/core/section/read.ts',
		symbol: 'sectionChildDdos',
		status: 'section_owned',
		reason: 'built with ownerIsSection: true — the config belongs to the section node',
	},
	{
		file: 'src/core/section/read.ts',
		symbol: 'sectionListSqo',
		status: 'section_owned',
		reason: 'built with ownerIsSection: true — the sqo limit/order of the section itself',
	},

	// ---- deferred: still indexed, each with its reason (6) -------------------
	{
		file: 'src/ai/mcp/tools/discovery.ts',
		symbol: 'targetSectionsOf',
		status: 'deferred',
		reason:
			'MCP map discovery reports the DEDALO target sections; an external source has no SQO surface to discover, and the catch already returns [] on a malformed config',
	},
	{
		file: 'src/core/relations/datalist.ts',
		symbol: 'buildDatalistOptions',
		status: 'deferred',
		reason:
			"the datalist QUERIES the target section for options — an external item's ddos would need per-option remote fetches, which is the unported server-side external search (capabilities.search + a missing buildSearchRequest)",
	},
	{
		file: 'src/core/relations/datalist.ts',
		symbol: 'resolveStoredLocatorLabels',
		status: 'deferred',
		reason: 'same surface as buildDatalistOptions; converts with it',
	},
	{
		file: 'src/core/relations/models/relation_related.ts',
		symbol: 'relationRelatedResolver',
		status: 'deferred',
		reason:
			'component_relation_related computes INVERSE references over matrix rows; no node in the census declares it with a second engine',
	},
	{
		file: 'src/core/relations/order_locators.ts',
		symbol: 'orderLocatorsByDeclaredColumns',
		status: 'deferred',
		reason:
			'read-time column ordering ranks locators with SQL; ordering an external locator set is exactly what capabilities.ordering = false forbids, and the feature is opt-in (no live config declares it)',
	},
	{
		file: 'src/core/relations/save.ts',
		symbol: 'columnSortDdo',
		status: 'deferred',
		reason: 'WRITE path — an external section is read-only, so no external item can reach it',
	},
];

const DEFERRED_CEILING = 6;

// ---------------------------------------------------------------------------
// The scan: nothing may narrow outside the census
// ---------------------------------------------------------------------------

/** Files the scan deliberately ignores — they DEFINE the rule. */
const SCAN_EXEMPT = new Set([
	'src/core/relations/config_ddo_map.ts',
	'src/core/relations/request_config/engine_select.ts',
]);

/** `config[0]` / `rcs[0]` in any of its spellings. */
const INDEX_NARROWING = /[A-Za-z_]*[Cc]onfigs?\??\.?\[0\]|\brcs\??\.?\[0\]/;
/** A hand-rolled engine comparison — the three drifting forms. */
const ENGINE_COMPARISON = /api_engine\s*(===|!==|\?\?)|api_engine:\s*'/;

/** Source lines with comment-only lines removed (a doc mentioning the pattern is not a use). */
function codeLines(relativePath: string): string[] {
	const source = readFileSync(join(ROOT, relativePath), 'utf8').split('\n');
	return source.filter((line) => {
		const trimmed = line.trim();
		return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
	});
}

async function scanFiles(): Promise<string[]> {
	const glob = new Bun.Glob('src/**/*.ts');
	const files: string[] = [];
	for await (const file of glob.scan({ cwd: ROOT })) files.push(file);
	return files.sort();
}

describe('census integrity', () => {
	test('every negotiated site really calls the selector, with its declared site id', () => {
		for (const entry of CENSUS) {
			if (entry.status !== 'negotiated') continue;
			expect(entry.site, `${entry.file} ${entry.symbol} needs a site id`).toBeDefined();
			expect(entry.concern, `${entry.file} ${entry.symbol} needs a concern`).toBeDefined();
			const source = readFileSync(join(ROOT, entry.file), 'utf8');
			expect(source, `${entry.file}: selector not called`).toContain('selectConfigItemForConcern');
			expect(source, `${entry.file}: site id '${entry.site}' absent`).toContain(`'${entry.site}'`);
			expect(source, `${entry.file}: concern '${entry.concern}' absent`).toContain(
				`'${entry.concern}'`,
			);
		}
	});

	test('every local site really uses the un-gated selector, and negotiates nothing', () => {
		for (const entry of CENSUS) {
			if (entry.status !== 'local') continue;
			const source = readFileSync(join(ROOT, entry.file), 'utf8');
			expect(source, `${entry.file}: selectLocalConfigItem not called`).toContain(
				'selectLocalConfigItem',
			);
			// A local concern must never reach an adapter: 'pagination' as a
			// CONCERN string is exactly the miscast this status exists to forbid.
			expect(source, `${entry.file}: still negotiates 'pagination'`).not.toContain("'pagination'");
		}
	});

	test('every engine-matched site really injects per engine', () => {
		for (const entry of CENSUS) {
			if (entry.status !== 'engine_matched') continue;
			const source = readFileSync(join(ROOT, entry.file), 'utf8');
			expect(source, `${entry.file}: injectCallerChildren not called`).toContain(
				'injectCallerChildren(',
			);
		}
	});

	test('the retired context narrowing stays retired (structure_context picks no item)', () => {
		// Code lines only: the module documents what it retired.
		const source = codeLines('src/core/resolve/structure_context.ts').join('\n');
		expect(source).not.toContain('rqoChildrenNarrowing');
		expect(source).not.toContain('selectConfigItemForConcern');
		expect(source).not.toContain('rqoChildrenDdos');
	});

	test('every flattened site really calls the flattener', () => {
		for (const entry of CENSUS) {
			if (entry.status !== 'flattened') continue;
			const source = readFileSync(join(ROOT, entry.file), 'utf8');
			expect(source, `${entry.file}: flattener not called`).toContain('flattenConfigDdoMaps');
		}
	});

	test('the DEFERRED list does not grow', () => {
		const deferred = CENSUS.filter((entry) => entry.status === 'deferred');
		// Shrinking is the point; growing means a new silent narrowing landed.
		expect(deferred.length).toBeLessThanOrEqual(DEFERRED_CEILING);
	});

	test('every censused file exists', () => {
		for (const entry of CENSUS) {
			expect(() => readFileSync(join(ROOT, entry.file), 'utf8')).not.toThrow();
		}
	});

	test('every entry states a reason', () => {
		for (const entry of CENSUS) {
			expect(entry.reason.length, `${entry.file} ${entry.symbol}`).toBeGreaterThan(20);
		}
	});
});

describe('nothing narrows outside the census', () => {
	test('no un-censused file indexes a request_config, or compares an api_engine', async () => {
		const censusedFiles = new Set(CENSUS.map((entry) => entry.file));
		const offenders: string[] = [];
		for (const file of await scanFiles()) {
			if (SCAN_EXEMPT.has(file) || censusedFiles.has(file)) continue;
			// The subsystem, the parser and the schemas legitimately name the field:
			// they PRODUCE or VALIDATE it rather than narrowing on it.
			if (
				file.startsWith('src/external/') ||
				file.startsWith('src/config/') ||
				file.startsWith('src/core/concepts/') ||
				file.startsWith('src/core/relations/request_config/')
			) {
				continue;
			}
			for (const line of codeLines(file)) {
				if (INDEX_NARROWING.test(line) || ENGINE_COMPARISON.test(line)) {
					offenders.push(`${file}: ${line.trim()}`);
					break;
				}
			}
		}
		expect(
			offenders,
			'a new request_config narrowing landed outside the census — add it (with its concern, or its reason) to CENSUS',
		).toEqual([]);
	});
});

describe('the section_owned justification is a measured fact, not a belief', () => {
	test('no node of model `section` declares an api_engine', () => {
		const nodes = census.api_engine_nodes as { tipo: string; model: string }[];
		// The census is harvested from the live installation
		// (test/fixtures/external/ontology_census.json).
		expect(nodes.length).toBeGreaterThan(0);
		for (const node of nodes) {
			expect(node.model, `${node.tipo} is a section AND declares an api_engine`).not.toBe(
				'section',
			);
		}
	});

	test('the census really contains EXTERNAL-ONLY nodes (the case the old code broke on)', () => {
		const nodes = census.api_engine_nodes as { tipo: string; engines: string[] }[];
		const externalOnly = nodes.filter((node) => !node.engines.includes('dedalo'));
		// If this is ever empty the whole selector is untested against reality.
		expect(externalOnly.length).toBeGreaterThan(0);
	});
});

describe('engineOf — the implicit-dedalo rule every site shares', () => {
	test("a declared engine wins; absent, empty and undefined all mean 'dedalo'", () => {
		expect(engineOf({ api_engine: 'zenon' })).toBe('zenon');
		expect(engineOf({ api_engine: 'dedalo' })).toBe('dedalo');
		expect(engineOf({})).toBe('dedalo');
		expect(engineOf({ api_engine: '' })).toBe('dedalo');
		expect(engineOf(undefined)).toBe('dedalo');
	});
});
