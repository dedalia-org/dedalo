/**
 * Phase 6 gate: dd_core_api::get_element_context differential.
 *
 * get_element_context returns ONE element's structure context (no data) — the
 * element's own get_json(get_context=true). We drive it for a section and a
 * component and assert the TS dispatch handler reproduces the same single-entry
 * context, comparing the structural subset TS emits plus the tools list.
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-test-tld-replay).
// The RQO names the CLONED section (testmint1) and its cloned input_text
// (testmint1002); `unmapRqo` finds the frozen install-term interaction and
// `adoptTipoIdMap` reads its body back in test terms. get_element_context
// returns STRUCTURE ONLY (no data), so this gate needs no records and builds
// no corpus — it runs on any installation, holding no install data at all.

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { adoptTipoIdMap } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** The cloned object section and its cloned input_text component. */
const SECTION = 'testmint1';
const INPUT_TEXT = 'testmint1002';

/**
 * THE CLONE-ROOT FACTS (context_differential's precedent), asserted instead of
 * compared. The clone was cut at the section root: the twin is parented by its
 * own TLD root where the install's section was parented by the install AREA
 * node, and the clone stamps a ` | <tld>` suffix on the section label so the
 * 33 twins stay distinguishable. Neither is a statement about the
 * element-context builder, which is what this gate is about.
 */
const CLONE_ROOT_PARENT = 'testmint0';
const CLONE_ROOT_LABEL_SUFFIX = ' | testmint';
/**
 * The section label as the frozen body recorded it, and as the definition reads
 * TODAY: master singularized it after the harvest (WC-2026-10-28-parity-definition-drift).
 */
const FROZEN_SECTION_LABEL = 'Cecas';
const CURRENT_SECTION_LABEL = 'Ceca';

const CASES = [
	{
		model: 'section',
		tipo: SECTION,
		section_tipo: SECTION,
		mode: 'list',
		lang: 'lg-spa',
	},
	{
		model: 'component_input_text',
		tipo: INPUT_TEXT,
		section_tipo: SECTION,
		mode: 'edit',
		lang: 'lg-spa',
	},
];

/**
 * TOOLS WHOSE PRESENCE IS NOT A STATEMENT ABOUT THE ELEMENT-CONTEXT WIRING —
 * one entry per tool, per side, every one justified AND exercised: the block
 * below REFUSES a declaration the side does not actually carry, so a stale
 * exemption cannot quietly shrink what this gate compares.
 *
 * Everything else in the tools list is compared verbatim.
 */
const PHP_ONLY_TOOLS: Record<string, string> = {
	tool_diffusion:
		// The install section this twin was cut from is mapped in the monedaiberica
		// deployment's diffusion section-map; the twin is not.
		"is_available walks the DIFFUSION SECTION-MAP, and a diffusion mapping is install DATA the generic ontology deliberately does not hold. Availability is tool_diffusion's own contract (src/core/tools/registry.ts), not the element-context builder's.",
};
// tool_identify is NOT declared here: it was WITHDRAWN from the TS tool lists on
// 2026-10-29 (WC-2026-10-29-ai-capabilities-page-globals, addendum). It is asserted
// absent on the TS side in every case below instead of being a one-sided declaration.
const TS_ONLY_TOOLS: Record<string, string> = {};

/**
 * Availability-ledgered tools the TS resolver omits on purpose (their
 * is_available needs a not-yet-ported subsystem). Excluded from BOTH sides so
 * the comparison targets what the element-context wiring actually covers.
 */
const LEDGERED_TOOLS = new Set<string>([]); // tool_diffusion now resolves via the diffusion section-map

/** Structural fields both sides must agree on (the subset TS emits). */
function subset(entry: Record<string, unknown>): Record<string, unknown> {
	const sectionTipo = Array.isArray(entry.section_tipo)
		? (entry.section_tipo as string[])[0]
		: entry.section_tipo;
	return {
		tipo: entry.tipo,
		section_tipo: sectionTipo,
		model: entry.model,
		mode: entry.mode,
		lang: entry.lang,
		label: entry.label,
		translatable: entry.translatable ?? false,
		view: entry.view ?? null,
		tools: ((entry.tools ?? []) as { name: string }[])
			.map((tool) => tool.name)
			.filter((name) => !LEDGERED_TOOLS.has(name))
			.sort(),
		buttons: ((entry.buttons ?? []) as { tipo?: string }[]).map((button) => button.tipo).sort(),
	};
}

describe.if(hasPhpCredentials())('get_element_context differential (Phase 6 gate)', () => {
	const results: { model: string; php: Record<string, unknown>; ts: Record<string, unknown> }[] =
		[];
	/** Anti-vacuity accumulator for the clone-map walk (asserted below). */
	let rewrittenTipos = 0;

	beforeAll(async () => {
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const token = createSession(-1, 'root', true);
		const session = getSession(token);
		const principal = await resolvePrincipal(-1);

		for (const source of CASES) {
			const rqo = { action: 'get_element_context', dd_api: 'dd_core_api', source };
			const { body } = await client.call(structuredClone(rqo));
			const tsResult = await dispatchRqo(rqo as unknown as Rqo, {
				requestId: 't',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal,
			});
			const tsEntry = (tsResult.body.data as Record<string, unknown>[])[0] ?? {};

			const rawPhpEntry = ((body.result as Record<string, unknown>[])[0] ?? {}) as Record<
				string,
				unknown
			>;
			if (source.model === 'section') {
				// THE CLONE ROOT — stated on BOTH sides so neither can drift
				// silently, then removed from the frozen entry: the install AREA
				// node above the section has no twin (the closure stops at the
				// section root), and leaving it in would make the leftover scan
				// refuse a body whose every OTHER address maps cleanly.
				// `parent_grouper` is outside the subset this gate compares.
				expect(rawPhpEntry.parent_grouper).toBe(`numis${'data1'}`);
				expect(tsEntry.parent_grouper).toBe(CLONE_ROOT_PARENT);
				// biome-ignore lint/performance/noDelete: the key must be GONE, not undefined — the leftover scan below walks own keys.
				delete rawPhpEntry.parent_grouper;
			}
			// WC-2026-08-19-test-tld-replay: the frozen install-term entry, read in
			// test-TLD terms. The floors keep the transform from going vacuous — a
			// walk that rewrote nothing would compare install terms against test
			// terms and red with a confusing diff instead of here.
			const adopted = adoptTipoIdMap(rawPhpEntry, 'get_element_context_differential');
			expect(adopted.matched).toBe(true);
			expect(adopted.rewrites.tipos).toBeGreaterThan(0);
			rewrittenTipos += adopted.rewrites.tipos;
			results.push({ model: source.model, php: adopted.body, ts: tsEntry });
		}
	});

	test('section + component element contexts match PHP (subset + tools + buttons)', () => {
		expect(results.length).toBe(CASES.length);
		expect(rewrittenTipos).toBeGreaterThan(CASES.length);
		/** Declarations that actually fired — a stale one must not shrink the diff. */
		const exercised = new Set<string>();
		for (const { model, php, ts } of results) {
			const phpSubset = subset(php);
			const tsSubset = subset(ts);
			// Non-vacuity: an empty tools list on both sides would compare nothing.
			expect(phpSubset.tipo).toBeTruthy();
			// The declared one-sided tools: PRESENT on their own side (refused
			// otherwise), then removed. The rest of the list is compared verbatim.
			const phpTools = phpSubset.tools as string[];
			const tsTools = tsSubset.tools as string[];
			// WC-2026-10-29-ai-capabilities-page-globals: the TS side withdraws
			// tool_identify in every context; PHP never had it.
			expect(tsTools).not.toContain('tool_identify');
			expect(phpTools).not.toContain('tool_identify');
			for (const name of Object.keys(PHP_ONLY_TOOLS)) {
				if (!phpTools.includes(name)) continue;
				exercised.add(name);
				expect(tsTools).not.toContain(name);
				phpSubset.tools = phpTools.filter((tool) => tool !== name);
			}
			for (const name of Object.keys(TS_ONLY_TOOLS)) {
				if (!tsTools.includes(name)) continue;
				exercised.add(name);
				expect(phpTools).not.toContain(name);
				tsSubset.tools = tsTools.filter((tool) => tool !== name);
			}
			expect((phpSubset.tools as string[]).length).toBeGreaterThan(0);
			if (model === 'section') {
				// The clone's ` | <tld>` label suffix (see CLONE_ROOT_LABEL_SUFFIX):
				// asserted exactly, then removed — every other field stays byte-compared.
				expect(phpSubset.label).toBe(FROZEN_SECTION_LABEL);
				expect(tsSubset.label).toBe(`${CURRENT_SECTION_LABEL}${CLONE_ROOT_LABEL_SUFFIX}`);
				phpSubset.label = null;
				tsSubset.label = null;
			}
			expect(tsSubset).toEqual(phpSubset);
		}
		// EXERCISED-OR-REFUSED (the UNCLONED_TOKENS / stripCorpusScaleFields
		// pattern): every declared one-sided tool must have been found on its own
		// side in at least one case. A declaration that matches nothing is a stale
		// exemption, and would mean this gate silently stopped comparing it.
		expect([...exercised].sort()).toEqual(
			[...Object.keys(PHP_ONLY_TOOLS), ...Object.keys(TS_ONLY_TOOLS)].sort(),
		);
	});
});
