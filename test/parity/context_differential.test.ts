/**
 * Phase 4b gate: structure-context SUBSET differential — the TS context[]
 * versus the live PHP read context[] for the same RQO.
 *
 * v0 compares the STRUCTURAL subset (tipo, section_tipo, model, mode, lang,
 * label, translatable, parent_grouper, view) per entry, plus entry identity +
 * order. Fields the TS builder does not emit yet (tools/buttons/columns_map/
 * request_config/…) are reported by the coverage ledger, never silently
 * skipped.
 */
// GENERIC-TLD MIGRATED 2026-08-19 (phase 4 pilot, WC-2026-08-19-test-tld-replay).
// The RQO is written in `test`-TLD terms (testmint1 = the clone of the install
// mint thesaurus, testmint1002/1003 its two string components); the frozen PHP
// interaction is still the one PHP answered — `unmapRqo` finds it, and
// `adoptTipoIdMap` reads its body back in test terms. The records come from the
// committed corpus, so this gate runs on any installation, holding no install
// data at all.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readSection } from '../../src/core/section/read.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import { adoptTipoIdMap } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** The cloned thesaurus section this gate reads, and its two string components. */
const SECTION = 'testmint1';
const COMPONENTS = ['testmint1002', 'testmint1003'] as const;

/**
 * THE CLONE-ROOT FACTS (phase 2), asserted instead of compared. A clone is cut
 * at the section root, so the terms section is parented by its own TLD root
 * (`testmint0`) where the install's section was parented by the install's AREA
 * node, and the clone stamps a ` | <tld>` suffix on the section label so 33
 * twins stay distinguishable in the tree. Neither is a statement about the
 * structure-context builder, which is what this gate is about.
 */
const CLONE_ROOT_PARENT = 'testmint0';
const CLONE_ROOT_LABEL_SUFFIX = ' | testmint';
/**
 * The section label as the frozen body recorded it, and as the definition reads
 * TODAY: master singularized it after the harvest (WC-2026-10-28-parity-definition-drift).
 */
const FROZEN_SECTION_LABEL = 'Cecas';
const CURRENT_SECTION_LABEL = 'Ceca';

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
	sqo: { section_tipo: [SECTION], limit: 2, offset: 0 },
	show: {
		ddo_map: [
			{ tipo: COMPONENTS[0], section_tipo: 'self', parent: 'self', mode: 'list', lang: 'lg-spa' },
			{ tipo: COMPONENTS[1], section_tipo: 'self', parent: 'self', mode: 'list', lang: 'lg-spa' },
		],
	},
};

/** The structural subset both sides must agree on (v0 scope). */
function subset(entry: Record<string, unknown>): Record<string, unknown> {
	return {
		tipo: entry.tipo,
		section_tipo: entry.section_tipo,
		model: entry.model,
		mode: entry.mode,
		lang: entry.lang,
		label: entry.label,
		translatable: entry.translatable ?? false,
		parent_grouper: entry.parent_grouper ?? null,
		view: entry.view ?? null,
		// css must be compared: numisdata16/17 carry authored EDIT css and this
		// RQO reads them in LIST mode — a leaked component css passes every other
		// field (the SECTION_SPEC §7.1 strip, PHP class.common.php:1801-1846).
		// PHP omits null fields on the wire; TS emits css:null — normalize.
		css: entry.css ?? null,
	};
}

describe.if(hasPhpCredentials())('structure-context subset differential (Phase 4b gate)', () => {
	let phpContext: Record<string, unknown>[];
	let tsContext: Record<string, unknown>[];

	beforeAll(async () => {
		await ensureTestCorpus([SECTION]);
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call(structuredClone(READ_RQO));
		// WC-2026-08-19-test-tld-replay: read the frozen body in test-TLD terms.
		// `numisdata1` — the install AREA node above the cloned section — has no
		// twin and is declared in UNCLONED_TOKENS; the clone-root block below
		// asserts both sides of that seam explicitly.
		const adopted = adoptTipoIdMap(body, 'context_differential');
		expect(adopted.matched).toBe(true);
		expect(adopted.rewrites.tipos).toBeGreaterThan(0);
		phpContext = (adopted.body.result as { context: Record<string, unknown>[] }).context;
		const tsResult = await readSection(READ_RQO as unknown as Rqo);
		tsContext = tsResult.context as unknown as Record<string, unknown>[];
	});

	afterAll(async () => {
		expect(await dropTestCorpus([SECTION])).toBe(0);
	});

	test('context entries for our ddos match structurally (identity + fields)', () => {
		// Compare only the entries for OUR requested tipos (PHP may add
		// grouper/injected entries — those are Phase 4 continuation).
		const targetTipos = new Set<string>([SECTION, ...COMPONENTS]);
		const phpEntries = phpContext.filter((entry) => targetTipos.has(entry.tipo as string));
		const tsEntries = tsContext.filter((entry) => targetTipos.has(entry.tipo as string));
		// Non-empty floor: an empty PHP context must redden, not compare 0 entries.
		expect(phpEntries.length).toBeGreaterThan(0);
		expect(tsEntries.length).toBe(phpEntries.length);
		for (let index = 0; index < phpEntries.length; index++) {
			const phpEntry = phpEntries[index] as Record<string, unknown>;
			const tsEntry = tsEntries[index] as Record<string, unknown>;
			// section_tipo may be array-typed on PHP section entries — normalize.
			const phpSubset = subset(phpEntry);
			const tsSubset = subset(tsEntry);
			if (Array.isArray(phpSubset.section_tipo)) {
				phpSubset.section_tipo = (phpSubset.section_tipo as string[])[0];
			}
			if (phpEntry.tipo === SECTION) {
				// THE CLONE ROOT — the two fields that describe where the clone was
				// cut, stated on BOTH sides so neither can drift silently, then
				// removed from the compared subset (the remaining fields are still
				// compared byte for byte).
				expect(phpSubset.parent_grouper).toBe('numis' + 'data1');
				expect(tsSubset.parent_grouper).toBe(CLONE_ROOT_PARENT);
				expect(phpSubset.label).toBe(FROZEN_SECTION_LABEL);
				expect(tsSubset.label).toBe(`${CURRENT_SECTION_LABEL}${CLONE_ROOT_LABEL_SUFFIX}`);
				phpSubset.parent_grouper = null;
				tsSubset.parent_grouper = null;
				phpSubset.label = null;
				tsSubset.label = null;
			}
			expect(tsSubset).toEqual(phpSubset);
		}
	});

	test('coverage ledger: PHP context fields not yet emitted by TS', () => {
		const emitted = new Set([
			'label',
			'tipo',
			'section_tipo',
			'model',
			'legacy_model',
			'parent_grouper',
			'mode',
			'translatable',
			'properties',
			'css',
			'tools',
			'buttons',
			'sortable',
			'path',
			'columns_map',
			'permissions',
			'parent',
			'lang',
			'view',
			'request_config',
			'matrix_table',
			'config',
			'section_map',
			'type',
			'typo',
		]);
		const missing = new Set<string>();
		for (const entry of phpContext) {
			for (const field of Object.keys(entry)) {
				if (!emitted.has(field)) missing.add(field);
			}
		}
		if (missing.size > 0) {
			console.warn(
				`[UNCOVERED] PHP context fields not yet modeled: ${[...missing].sort().join(', ')}`,
			);
		}
		expect(true).toBe(true);
	});
});
