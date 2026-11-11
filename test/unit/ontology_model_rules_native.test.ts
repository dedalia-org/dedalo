/**
 * MODEL RULES ON THE ONTOLOGY HEALTH CHECK — a node that breaks a rule its MODEL fixes is
 * NAMED by `inspectOntology`, on every install, by its SOURCE record (2026-11-11).
 *
 * THE RULE THIS GATE STARTS WITH: `component_iri` is NEVER translatable. An IRI has no
 * language; per-language IRIs are language VERSIONS (the always-on `with_lang_versions`,
 * base value lg-nolan). A component_iri node whose `is_translatable` is true is an ONTOLOGY
 * bug: the CSV import then saves plain cells in the importer's language. It is fixed in the
 * MASTER ontology (ontology8 = no), never worked around by the engine — so the engine does
 * not override the flag, it REPORTS it.
 *
 * WHERE THE RULE LIVES: a descriptor facet (`ontologyTranslatable: false` on
 * component_iri/descriptor.ts), read by ontology/model_rules.ts through the resolver's
 * registered component-model lookup (the S2-20 inversion seam) — not an
 * `if model === 'component_iri'` in the health check.
 *
 * THE CHANNEL: `OntologyState.modelRuleViolationNodes` + `modelRuleViolations[]`
 * (`{source, tipo, model, rule, translatableStated, message}`) — a WARNING channel like
 * `tldlessRecords` / `machineNameDefects`, never a drift kind: the projection DOES match its
 * source; the source is what is wrong. A rebuild names the finding in its message (the same
 * message the ontology update reports per tld).
 *
 * THE SITUATION IS BUILT: scratch tld `zzmrn`, four raw source records of `zzmrn0`
 * (test/helpers/machine_name_scratch.ts, suite DB only):
 *   zzmrn1  component_iri, ontology8 = no   → healthy (the control)
 *   zzmrn2  component_iri, ontology8 = yes  → violation, stated
 *   zzmrn3  component_iri, NO ontology8     → violation: the parser defaults an unset
 *                                            ontology8 to TRUE, so this IS translatable
 *   zzmrn4  component_input_text, no ontology8 → healthy: the rule is the MODEL's, not a
 *                                            blanket "every node non-translatable"
 * Everything `zzmrn` is swept before and after (records, projection, registry row).
 *
 * MUTATIONS (each turns this gate red): drop the facet from component_iri's descriptor
 * (no finding); read the facet without following `ontologyTranslatable` (no finding); treat
 * an unset ontology8 as non-translatable (zzmrn3 missed); file the finding as drift (inSync
 * false); drop the rebuild-message note.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import {
	inspectOntology,
	type OntologyState,
	type OntologyWriteResult,
	rebuildOntology,
} from '../../src/core/ontology/ontology_state.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	modelTipoNamed,
	seedMachineNameScratch,
	sweepMachineNameScratch,
} from '../helpers/machine_name_scratch.ts';

const TLD = 'zzmrn';
const SECTION = `${TLD}0`;

/** zzmrn's records, its projection and the registry row a rebuild ensures. */
async function sweep(): Promise<void> {
	await assertTestDatabase('ontology_model_rules_native sweep');
	await sql.unsafe(
		`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy6: [{ value: TLD }] })],
	);
	await sweepMachineNameScratch(TLD);
}

const term = (value: string) => [{ id: 1, lang: 'lg-eng', value }];

let outcome: OntologyWriteResult;
let state: OntologyState;

beforeAll(async () => {
	await sweep();
	const iri = await modelTipoNamed('component_iri');
	const inputText = await modelTipoNamed('component_input_text');
	await seedMachineNameScratch(TLD, [
		{ sectionId: 1, term: term('iri, not translatable'), modelTipo: iri, translatable: false },
		{ sectionId: 2, term: term('iri, translatable'), modelTipo: iri, translatable: true },
		{ sectionId: 3, term: term('iri, ontology8 unset'), modelTipo: iri },
		{ sectionId: 4, term: term('input text, ontology8 unset'), modelTipo: inputText },
	]);
	outcome = await rebuildOntology(TLD, -1);
	state = await inspectOntology(TLD);
}, 60000);

afterAll(async () => {
	await sweep();
	const residue = (await sql.unsafe(
		`SELECT (SELECT count(*)::int FROM matrix_ontology WHERE section_tipo = $1)
		      + (SELECT count(*)::int FROM dd_ontology WHERE tld = $2) AS n`,
		[SECTION, TLD],
	)) as { n: number }[];
	expect(residue[0]?.n).toBe(0);
});

describe('ontology model rules — component_iri is never translatable', () => {
	test('the situation parsed: four own nodes, the rebuild converged', () => {
		expect(state.matrixNodes).toBe(4);
		// The floor the empty-drift verdict below stands on: four nodes + the <tld>0 main.
		expect(state.storedNodes).toBeGreaterThanOrEqual(5);
		expect(outcome.ok).toBe(true);
	});

	test('the translatable iri AND the ontology8-less iri are named — and only they', () => {
		const findings = (state.modelRuleViolations ?? []).map((item) => ({
			source: item.source,
			tipo: item.tipo,
			model: item.model,
			rule: item.rule,
			translatableStated: item.translatableStated,
		}));
		expect(findings).toEqual([
			{
				source: `${SECTION}/2`,
				tipo: 'zzmrn2',
				model: 'component_iri',
				rule: 'translatable_forbidden',
				translatableStated: true,
			},
			{
				source: `${SECTION}/3`,
				tipo: 'zzmrn3',
				model: 'component_iri',
				rule: 'translatable_forbidden',
				translatableStated: false,
			},
		]);
		expect(state.modelRuleViolationNodes).toBe(2);
	});

	test('each finding tells the operator to fix it in the MASTER ontology (ontology8)', () => {
		for (const item of state.modelRuleViolations ?? []) {
			expect(item.message).toContain('master ontology');
			expect(item.message).toContain('ontology8');
			expect(item.message).toContain(item.source);
		}
		const unset = (state.modelRuleViolations ?? []).find((item) => item.tipo === 'zzmrn3');
		expect(unset?.message).toContain('unset');
	});

	test('a warning, never drift: the projection matches its source, inSync stays true', () => {
		expect(state.drift).toEqual([]);
		expect(state.inSync).toBe(true);
	});

	test('the engine REPORTS, it does not override: the stored flag is what the source says', async () => {
		const rows = (await sql.unsafe(
			`SELECT tipo, is_translatable FROM dd_ontology WHERE tld = $1 AND tipo <> $2 ORDER BY tipo`,
			[TLD, SECTION],
		)) as { tipo: string; is_translatable: boolean }[];
		expect(rows).toEqual([
			{ tipo: 'zzmrn1', is_translatable: false },
			{ tipo: 'zzmrn2', is_translatable: true },
			{ tipo: 'zzmrn3', is_translatable: true },
			{ tipo: 'zzmrn4', is_translatable: true },
		]);
	});

	test('the rebuild message (what the ontology update reports per tld) names the findings', () => {
		expect(outcome.msg).toContain('model rule');
		expect(outcome.msg).toContain(`${SECTION}/2`);
		expect(outcome.msg).toContain(`${SECTION}/3`);
		expect(outcome.msg).toContain('master ontology');
	});
});
