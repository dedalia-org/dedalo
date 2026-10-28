/**
 * section_tool direct-URL gate: `start` for a section_tool page REROUTES to
 * the target section and carries the tool activation on config.tool_context
 * (PHP dd_core_api::start section_tool case, class.dd_core_api.php:386-458).
 *
 * The config is byte-pinned: the enriched tool_config.ddo_map is the contract
 * that makes the client build the tool's CONFIGURED components — without it
 * the client's tool_common.js cascade silently falls back to a synthetic
 * single-entry ddo_map and the tool renders component-less (the epigraphy /
 * order section_tools, fixed 2026-07-10). A section_tool with NO
 * config/tool_config) pins PHP's answer: result:false — PHP fatals building a
 * section on the non-section tipo (set_lang on false, :430-434); TS refuses
 * loudly with the same envelope.
 *
 * @twinned-by   test/unit/section_tool_context.test.ts
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-tools-gates-test-tld).
// Every tipo below is a phase-2 clone in the generic `test` TLD
// (src/core/test_data/test_tld_tipo_map.json): the RQO is written in test-TLD
// terms, `unmapRqo` finds the frozen interaction under the install address PHP
// answered, and `adoptTipoIdMap` reads its body back in test terms. `start` is a
// DEFINITION path — it reroutes and builds a context, it reads no record — so
// this gate seeds no corpus.

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { adoptTipoIdMap } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/**
 * The configured section_tool exemplars (AREA_SPEC §6), as their generic
 * clones: test6877 = transcription over the seed-shipped rsc167; test6269 /
 * test6413 = epigraphy / order over test6099 — plus test6402, config-less
 * when the oracle was harvested (PHP refused it) and fixed on master since.
 */
const REROUTED_TIPOS = ['test6269', 'test6413', 'test6877'];
const EMPTY_TIPO = 'test6402';

/** The section_tool whose 'coins' role pointed at a component_alias (WC-020) when the oracle was harvested. */
const ALIAS_TOOL_TIPO = 'test6269';
/**
 * Where that role points TODAY: master moved it back to the portal itself
 * (numisdata201 coins → numisdata77, with an inline properties copy), so the
 * frozen body's alias entry (test6271) is no longer the definition
 * (WC-2026-10-28-parity-definition-drift).
 */
const COINS_COMPONENT_TIPO = 'test6157';

/**
 * WHERE THE CLONE WAS CUT, stated instead of compared (the context_differential
 * pattern). Two facts about the phase-2 clone, neither of them a statement
 * about `start`:
 *
 *  - the frozen context entry is parented by the install's AREA node, which has
 *    no twin (the closure stops at the section root). This gate compares
 *    tipo/model/type/label/config and never parent_grouper, so the field is
 *    asserted to be exactly that install node and removed before the adoption
 *    walk — leaving it in would only make the walk refuse.
 *  - a cloned section's label carries a ` | <tld>` suffix so the 33 twins stay
 *    distinguishable in the tree; a SEED-SHIPPED target (rsc167) has none.
 */
const FROZEN_PARENT_GROUPER = 'numis' + 'data1';
const CLONE_LABEL_SUFFIX = ' | test';
/** The reroute targets whose section is a clone (and therefore label-suffixed). */
const CLONED_TARGET_TIPOS: ReadonlySet<string> = new Set(['test6269', 'test6413']);

describe.if(hasPhpCredentials())('section_tool start differential', () => {
	const phpBodies: Record<string, Record<string, unknown>> = {};
	const tsBodies: Record<string, Record<string, unknown>> = {};
	/**
	 * PHP oracle body — the frozen dd_manager envelope: payload under `result`.
	 * The entries are ADOPTED into test-TLD terms here
	 * (WC-2026-08-19-tools-gates-test-tld): the clone-root parent_grouper is
	 * asserted and removed first (see above), then every remaining tipo is
	 * rewritten through the committed clone map. The floor is the anti-vacuity
	 * check — the entry names the target section, its columns_map and its whole
	 * tool_config ddo_map, so a transform that stopped rewriting could not stay
	 * above it. `ids` is 0 by construction: `start` addresses no record.
	 */
	const phpContextsOf = (body: Record<string, unknown>): Record<string, unknown>[] => {
		const result = body.result as { context?: Record<string, unknown>[] } | false | null;
		const entries = result && typeof result === 'object' ? (result.context ?? []) : [];
		return entries.map((entry) => {
			const { parent_grouper: frozenParent, ...rest } = structuredClone(entry);
			// A clone-target entry is parented by the install AREA node (asserted and
			// left out of the walk); a SEED-SHIPPED target keeps its own parent.
			const isCloneRoot = typeof frozenParent === 'string' && frozenParent.startsWith('numis');
			if (isCloneRoot) expect(frozenParent).toBe(FROZEN_PARENT_GROUPER);
			const frozen: Record<string, unknown> = isCloneRoot
				? rest
				: { ...rest, parent_grouper: frozenParent };
			const adopted = adoptTipoIdMap(frozen, 'section_tool_start_differential');
			expect(adopted.matched).toBe(true);
			expect(adopted.rewrites.tipos).toBeGreaterThan(0);
			expect(adopted.rewrites.ids).toBe(0);
			return adopted.body as Record<string, unknown>;
		});
	};
	/** TS body — envelope v2: payload under `data` (absent on a failure). */
	const tsContextsOf = (body: Record<string, unknown>): Record<string, unknown>[] => {
		const data = body.data as { context?: Record<string, unknown>[] } | null | undefined;
		return data && typeof data === 'object' ? (data.context ?? []) : [];
	};

	beforeAll(async () => {
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const adminContext: ApiRequestContext = {
			requestId: 'test',
			clientIp: '127.0.0.1',
			session: {
				userId: -1,
				username: 'root',
				isGlobalAdmin: true,
				csrfToken: 'x',
				applicationLang: null,
				dataLang: null,
			},
			csrfCandidate: 'x',
			principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		};
		for (const tipo of [...REROUTED_TIPOS, EMPTY_TIPO]) {
			const options = { search_obj: { t: tipo, m: 'list' }, menu: false };
			const { body } = await client.call({ action: 'start', prevent_lock: true, options });
			phpBodies[tipo] = body;
			const outcome = await dispatchRqo(
				{ action: 'start', dd_api: 'dd_core_api', options } as Rqo,
				adminContext,
			);
			tsBodies[tipo] = outcome.body;
		}
	});

	for (const tipo of REROUTED_TIPOS) {
		test(`${tipo}: reroutes to the target section (tipo/model/type/label match PHP)`, () => {
			const php = phpContextsOf(phpBodies[tipo]!)[0]!;
			const ts = tsContextsOf(tsBodies[tipo]!)[0]!;
			expect(php).toBeDefined();
			expect(ts).toBeDefined();
			expect(ts.tipo).toBe(php.tipo); // the TARGET section, not the section_tool
			expect(ts.model).toBe(php.model); // 'section'
			expect(ts.type).toBe(php.type);
			// The clone's label carries the ` | <tld>` twin suffix; a seed-shipped
			// target (rsc167) does not. Both halves asserted, never normalized away.
			const expectedLabel = CLONED_TARGET_TIPOS.has(tipo)
				? `${String(php.label)}${CLONE_LABEL_SUFFIX}`
				: php.label;
			expect(ts.label).toBe(expectedLabel);
		});

		test(`${tipo}: config is byte-equal (tool_context + enriched ddo_map)`, () => {
			const php = phpContextsOf(phpBodies[tipo]!)[0]!;
			const ts = tsContextsOf(tsBodies[tipo]!)[0]!;
			// WC-020 normalizer (the alias section_tool only, post-alias-migration):
			// the coins role points at a component_alias, which PHP cannot
			// resolve (it enriches model:'component_alias' verbatim; TS resolves the
			// TARGET model per the alias contract). Byte-pin everything EXCEPT that
			// entry, and pin the TS entry's alias shape explicitly. NO-OP while the
			// configs are byte-equal (pre-migration).
			// MEASURED RED 2026-08-19, and NOT a TLD binding — it reddened identically
			// before the migration, on the install tipo: the ambient dd_ontology (the
			// suite database's, and the clone derived from it) still carries the
			// PRE-alias tool_config — coins → the portal itself, with an inline
			// properties copy — while the frozen body records the POST-alias one
			// (coins → the component_alias). The gate states the contract correctly;
			// the ontology under it is the older state.
			if (tipo === ALIAS_TOOL_TIPO && JSON.stringify(ts.config) !== JSON.stringify(php.config)) {
				type ToolConfig = {
					tool_context?: { tool_config?: { ddo_map?: Record<string, unknown>[] } };
				};
				const stripCoins = (cfg: unknown): unknown => {
					const clone = structuredClone(cfg) as ToolConfig;
					const map = clone.tool_context?.tool_config?.ddo_map;
					if (Array.isArray(map) && clone.tool_context?.tool_config) {
						clone.tool_context.tool_config.ddo_map = map.filter((entry) => entry.role !== 'coins');
					}
					return clone;
				};
				expect(JSON.stringify(stripCoins(ts.config))).toBe(JSON.stringify(stripCoins(php.config)));
				const tsCoins = (ts.config as ToolConfig).tool_context?.tool_config?.ddo_map?.find(
					(entry) => entry.role === 'coins',
				);
				expect(tsCoins?.tipo).toBe(COINS_COMPONENT_TIPO);
				expect(tsCoins?.model).toBe('component_portal');
				expect(tsCoins?.properties).toBeDefined(); // the definition's inline copy is carried
				return;
			}
			expect(JSON.stringify(ts.config)).toBe(JSON.stringify(php.config));
			// Vacuous-green guard: the pinned config must actually CARRY the
			// configured components with the create_tool_simple_context stamps.
			const ddoMap = (
				ts.config as { tool_context: { tool_config: { ddo_map: Record<string, unknown>[] } } }
			).tool_context.tool_config.ddo_map;
			expect(Array.isArray(ddoMap)).toBe(true);
			expect(ddoMap.length).toBeGreaterThan(0);
			for (const entry of ddoMap) {
				expect(typeof entry.model).toBe('string');
				expect(typeof entry.translatable).toBe('boolean');
				expect(typeof entry.label).toBe('string');
			}
		});

		test(`${tipo}: start context WITHOUT top-level request_config (PHP parity)`, () => {
			expect(phpContextsOf(phpBodies[tipo]!)[0]!.request_config).toBeUndefined();
			expect(tsContextsOf(tsBodies[tipo]!)[0]!.request_config).toBeUndefined();
		});
	}

	test(`${EMPTY_TIPO}: PHP refused the then config-less node; TS now reroutes it (master fixed it)`, () => {
		// WC-2026-10-28-section-tool-test6402-config: the frozen PHP body is the pre-fix answer
		// (numisdata625 carried the v6 `properties.context`, PHP fatals building a section on the
		// non-section tipo → result:false). The master ontology renamed it `config` on 2026-10-28,
		// so the twin reroutes to its target. The refusal contract itself moved to a scratch
		// section_tool in test/unit/section_tool_context.test.ts.
		expect(phpBodies[EMPTY_TIPO]!.result).toBe(false);
		expect(tsBodies[EMPTY_TIPO]!.ok).toBe(true);
		expect(tsContextsOf(tsBodies[EMPTY_TIPO]!)[0]).toMatchObject({
			tipo: 'test6099',
			model: 'section',
		});
	});
});
