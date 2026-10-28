/**
 * SECTION_SPEC §6 gate: the section-only context extras — section_map,
 * matrix_table, config.relation_list_tipo — byte-parity vs live PHP.
 *
 * The base context_differential compares only the 9-field structural subset;
 * this gate pins the section stamp fields PHP emits on the SECTION entry
 * (class.common.php :2056-2100) that the earlier ledger reported as UNCOVERED.
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-test-tld-replay).
// Every section is named in `test`-TLD terms (the cloned mint/type/coin
// sections and the cloned thesaurus-config section) or is SEED-SHIPPED
// ontology every installation carries (rsc167, rsc197, hierarchy20);
// `unmapRqo` finds the frozen install-term interaction and `adoptTipoIdMap`
// reads its body back in test terms. This gate compares STRUCTURE CONTEXT
// only, so it needs no records and builds no corpus.

import { describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readSection } from '../../src/core/section/read.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { adoptTipoIdMap } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/** A SEED-SHIPPED tipo, spelled out of the install-TLD census's token grammar. */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** The full SECTION_SPEC §12 corpus: object sections, an audiovisual + a people
 * section, a thesaurus-config section (testcult1) and the Thesaurus section
 * (hierarchy20) — covering section_map present/absent, virtual sections
 * (rsc167 → rsc2), and relation_list present/absent. */
const SECTIONS = [
	'testmint1',
	'test6099',
	'test6100',
	seed('rsc', 167),
	seed('rsc', 197),
	'testcult1',
	seed('hierarchy', 20),
];

/** The cloned thesaurus-config section that carries the relation_model datapoint. */
const THESAURUS_CONFIG = 'testcult1';
/** Its component_relation_model — a SECTION-SCOPED clone (`cult1@hierarchy27`). */
const RELATION_MODEL = 'testcult1007';

/**
 * The sections whose ontology is a CLONE. Every generic `test`-TLD section
 * stores in `matrix_test` — the whole point: no test record can collide with
 * an installation's rows — where the install section it was twinned from
 * stored in `matrix`. That is a statement about where the clone lives, not
 * about the section-context builder, so it is ASSERTED on both sides instead
 * of compared. The seed-shipped sections in SECTIONS still compare verbatim.
 */
const CLONED_SECTIONS = new Set(['testmint1', 'test6099', 'test6100', THESAURUS_CONFIG]);
const CLONE_TABLE = 'matrix_test';

/**
 * ── MEASURED 2026-08-19: the THESAURUS_CONFIG case is RED, and it is a CLONE-SET
 * GAP, not an engine defect. READ BEFORE CHANGING ANYTHING BELOW ──
 *
 * The install's thesaurus-config section was twinned, but the THESAURUS SECTION
 * IT MODELS was not: the phase-2 closure cut at `cult1` and never cloned
 * `cult2`, so `src/core/test_data/test_tld_tipo_map.json` has no entry for it
 * and `test_tld_ontology.json` has no `testcult2` node.
 *
 * Both sides then say the same thing about a section that does not exist:
 *   - the frozen body still carries `target_sections: [{tipo:'cult2', …}]`, an
 *     install token with no twin ⇒ `adoptTipoIdMap` REFUSES (leftover `cult2`);
 *   - TS logs `[ontology/model_section] no model section for 'testcult1' —
 *     rejected: 'testcult2' (tld fallback: model 'null')` and emits `[]`.
 *
 * Closing this needs the clone map + the generic ontology to carry a `cult2`
 * twin — a change to SHARED, committed fixture artifacts, not to this gate.
 * Do NOT drop the section from SECTIONS and do NOT relax the refusal: this is
 * the ONE frozen component_relation_model datapoint in the whole store, and
 * losing it is how the 2026-08-14 hierarchy27 regression stayed invisible.
 */

function readRqo(sectionTipo: string): Rqo {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			model: 'section',
			tipo: sectionTipo,
			section_tipo: sectionTipo,
			mode: 'list',
			lang: 'lg-spa',
			action: 'search',
		},
		sqo: { section_tipo: [sectionTipo], limit: 1, offset: 0 },
	} as unknown as Rqo;
}

function sectionEntry(context: Record<string, unknown>[], tipo: string): Record<string, unknown> {
	const entry = context.find((item) => item.tipo === tipo && item.model === 'section');
	if (entry === undefined) throw new Error(`no section entry for ${tipo}`);
	return entry;
}

describe.if(hasPhpCredentials())('section context extras differential (SECTION_SPEC §6)', () => {
	for (const sectionTipo of SECTIONS) {
		test(`${sectionTipo}: section_map + matrix_table + relation_list_tipo match PHP`, async () => {
			const client = new PhpApiClient();
			await client.login(
				config.phpReference.username as string,
				config.phpReference.password as string,
			);
			const rqo = readRqo(sectionTipo);
			const { body } = await client.call(
				structuredClone(rqo) as unknown as Record<string, unknown>,
			);
			// WC-2026-08-19-test-tld-replay: the frozen install-term CONTEXT, read
			// back in test terms. Applied to `result.context` — the only thing this
			// gate reads — because the envelope's section entry also carries the
			// install AREA node in `parent_grouper`, a clone-root seam that is
			// context_differential's subject.
			const rawContext = (body.result as { context: Record<string, unknown>[] }).context;
			// The strip must actually strip something: an exemption nothing matches
			// has gone stale and silently widens what the leftover scan accepts
			// (review 2026-08-20).
			expect(rawContext.some((entry) => typeof entry.parent_grouper === 'string')).toBe(true);
			// biome-ignore lint/performance/noDelete: the key must be GONE, not undefined — the leftover scan below walks own keys.
			for (const entry of rawContext) delete entry.parent_grouper;
			const adopted = adoptTipoIdMap(rawContext, 'section_context_extras_differential');
			// Assert the leftovers too: a refusal must name the install token it
			// could not map, not just say `false`.
			expect({ matched: adopted.matched, leftovers: adopted.leftovers }).toEqual({
				matched: true,
				leftovers: [],
			});
			const phpContext = adopted.body;
			// The fixtures are the superuser's view: config.relation_list_tipo is stamped
			// per principal (WC-2026-10-27-relation-list-grant-stamp), fail-closed without one.
			const tsContext = (
				await runWithRequestContext(
					{
						principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
						session: null,
						requestId: 'section_context_extras_differential',
						clientIp: '127.0.0.1',
					},
					() => readSection(rqo),
				)
			).context as unknown as Record<string, unknown>[];

			const php = sectionEntry(phpContext, sectionTipo);
			const ts = sectionEntry(tsContext, sectionTipo);

			// section_map: the section_map node properties (null when the section
			// declares none). PHP may omit the key entirely vs TS null — treat
			// undefined and null as equivalent absence.
			expect(ts.section_map ?? null).toEqual(php.section_map ?? null);
			if (CLONED_SECTIONS.has(sectionTipo)) {
				expect(php.matrix_table ?? null).toBe('matrix');
				expect(ts.matrix_table ?? null).toBe(CLONE_TABLE);
			} else {
				expect(ts.matrix_table ?? null).toEqual(php.matrix_table ?? null);
			}
			const phpRelListTipo =
				(php.config as { relation_list_tipo?: unknown } | undefined)?.relation_list_tipo ?? null;
			const tsRelListTipo =
				(ts.config as { relation_list_tipo?: unknown } | undefined)?.relation_list_tipo ?? null;
			expect(tsRelListTipo).toEqual(phpRelListTipo);

			// component_relation_model TARGET parity (the hierarchy27 regression,
			// 2026-08-14). PHP resolves this model's targets registry-first —
			// hierarchy53 == caller → hierarchy58, falling back to tld+'2' (v6
			// class.component_relation_model.php:115-177) — and the frozen store
			// already holds its answer for hierarchy27 in cult1: target_sections
			// [{tipo:'cult2', label:'Cultura [m]'}]. TS resolved [] (the node's sqo
			// declares section_tipo: [], and the calculation was never ported) while
			// this gate compared ONLY the section entry — which is exactly how the
			// regression stayed invisible. Greens via the model's `section_model`
			// default target (request_config/target_sources.ts →
			// ontology/model_section.ts).
			//
			// FIELD-SCOPED on target_sections, never the whole context entry: TS
			// emits `request_config` on relation entries where PHP's
			// component_relation_model_json passes add_request_config=false — an
			// unrelated, PRE-EXISTING divergence a whole-entry compare would red on.
			const phpRelationModels = phpContext.filter(
				(entry) => entry.model === 'component_relation_model',
			);
			if (sectionTipo === THESAURUS_CONFIG) {
				// Non-vacuity pin: the ONE frozen relation_model datapoint lives in
				// the thesaurus-config section's context. If a fixture edit ever drained it,
				// this sweep would go silently green — fail loudly instead.
				expect(phpRelationModels.map((entry) => entry.tipo)).toContain(RELATION_MODEL);
			}
			for (const phpEntry of phpRelationModels) {
				const tsEntry = tsContext.find(
					(entry) =>
						entry.tipo === phpEntry.tipo &&
						entry.model === 'component_relation_model' &&
						entry.section_tipo === phpEntry.section_tipo,
				);
				if (tsEntry === undefined)
					throw new Error(
						`no TS context entry for component_relation_model ${String(phpEntry.tipo)} in ${sectionTipo}`,
					);
				expect(tsEntry.target_sections ?? null).toEqual(phpEntry.target_sections ?? null);
			}
		});
	}
});
