/**
 * The machine-name KERNEL (src/core/ontology/machine_name.ts,
 * WC-2026-11-04-ontology-machine-names) — pure, no database.
 *
 * Pins every rung and every defect kind of `projectMachineName`, the
 * classification (model definitions + the closed NAME_MODELS list), the model
 * reader `modelNameOf` (bridge rung on an underived model row) and the rows-only
 * `deriveLegacyMachineName`. The parser, the upsert door, the situation helper,
 * the test-TLD loader and the archive equality all run THIS kernel, so a rung
 * moved here moves for every path at once.
 */

import { describe, expect, test } from 'bun:test';
import {
	deriveLegacyMachineName,
	isModelDefinition,
	isNameClassNode,
	type MachineNameInput,
	modelNameOf,
	NAME_MODELS,
	projectMachineName,
} from '../../src/core/ontology/machine_name.ts';

/** A legacy record: no ontology43/44, only ontology5 items. */
const legacy = (
	termItems: MachineNameInput['termItems'],
	nameClass = true,
	extra: Partial<MachineNameInput> = {},
): MachineNameInput => ({
	componentValues: null,
	canonicalFlag: null,
	overrideFlag: null,
	termItems,
	nameClass,
	...extra,
});

describe('classification (plan §5)', () => {
	const node = (fields: Partial<Parameters<typeof isNameClassNode>[0]>) => ({
		tipo: 'dd1229',
		tld: 'dd',
		is_model: true,
		model_tipo: null,
		model: null,
		...fields,
	});

	test('a model definition is is_model ∧ tld dd ∧ no model ∧ not dd2 itself', () => {
		expect(isModelDefinition(node({}))).toBe(true);
		expect(isModelDefinition(node({ tipo: 'dd2' }))).toBe(false); // "Model names" root: a label
		expect(isModelDefinition(node({ tld: 'crm', tipo: 'crm5' }))).toBe(false); // crm: labels
		expect(isModelDefinition(node({ model_tipo: 'dd6' }))).toBe(false);
		expect(isModelDefinition(node({ is_model: false }))).toBe(false);
	});

	test('an instance is name-class exactly when its model is in the closed list', () => {
		for (const model of NAME_MODELS) {
			expect(
				isNameClassNode(node({ tipo: 'test1', tld: 'test', is_model: false, model })),
				model,
			).toBe(true);
		}
		for (const model of ['section', 'component_input_text', 'diffusion_element', 'value_type']) {
			expect(
				isNameClassNode(node({ tipo: 'test1', tld: 'test', is_model: false, model })),
				model,
			).toBe(false);
		}
		expect([...NAME_MODELS].length).toBe(22); // 5 storage + 11 field_* + domain + 5 rdf/owl
	});

	test('the closed list, pinned literally (a change is a deliberate edit here + the WC entry + the PHP copy)', () => {
		expect([...NAME_MODELS].sort()).toEqual([
			'database',
			'database_alias',
			'diffusion_domain',
			'field_boolean',
			'field_date',
			'field_datetime',
			'field_decimal',
			'field_enum',
			'field_int',
			'field_mediumtext',
			'field_point',
			'field_text',
			'field_varchar',
			'field_year',
			'matrix_table',
			'owl:Class',
			'owl:ObjectProperty',
			'rdf:object',
			'rdf:predicate',
			'rdf:subject',
			'table',
			'table_alias',
		]);
	});
});

describe('projectMachineName — the rungs', () => {
	test('component value wins, with no legacy rung, even over a differing lg-spa', () => {
		const out = projectMachineName({
			...legacy([{ lang: 'lg-spa', value: 'old_name' }]),
			componentValues: ['new_name'],
			canonicalFlag: true,
		});
		expect(out).toEqual({
			machine_name: 'new_name',
			use_machine_name: true,
			rungs: [],
			defects: [],
		});
	});

	test('legacy_lang: lg-spa is read when ontology43 is empty, decoys in other langs ignored', () => {
		const out = projectMachineName(
			legacy([
				{ lang: 'lg-eus', value: 'Berria' }, // a stray that sorts FIRST
				{ lang: 'lg-spa', value: 'body_references' },
			]),
		);
		expect(out.machine_name).toBe('body_references');
		expect(out.rungs).toEqual(['derived_flag', 'legacy_lang']);
		expect(out.defects).toEqual([]);
	});

	test('a node STATING its flag: lg-spa still names it, a lone stray label never does', () => {
		const stray = [{ lang: 'lg-eus', value: 'Berria' }];
		// legacy shape (flag unset): the single value is the bridge
		expect(projectMachineName(legacy(stray)).machine_name).toBe('Berria');
		// converted (flag Yes, ontology43 emptied): missing, never the D3 stray
		const out = projectMachineName(legacy(stray, true, { canonicalFlag: true }));
		expect(out).toEqual({
			machine_name: null,
			use_machine_name: true,
			rungs: [],
			defects: [{ kind: 'missing' }],
		});
		// a half-converted package (flag Yes, name still in lg-spa) keeps its name
		expect(
			projectMachineName(
				legacy([...stray, { lang: 'lg-spa', value: 'body_references' }], true, {
					canonicalFlag: true,
				}),
			).machine_name,
		).toBe('body_references');
	});

	test("an unconverted override's lg-spa rename wins over the canonical ontology43", () => {
		const out = projectMachineName(
			legacy([], true, {
				componentValues: ['canonical_name'],
				canonicalFlag: true,
				overrideLegacyName: ['override_name'],
			}),
		);
		expect(out.machine_name).toBe('override_name');
		expect(out.rungs).toEqual(['legacy_lang']);
		// two distinct legacy override values: a collision, never a guess
		expect(
			projectMachineName(
				legacy([], true, {
					componentValues: ['c'],
					canonicalFlag: true,
					overrideLegacyName: ['a', 'b'],
				}),
			).defects,
		).toEqual([{ kind: 'collision', values: ['a', 'b'] }]);
		// on a label node it is no name at all
		expect(
			projectMachineName(legacy([], false, { overrideLegacyName: ['x'] })).machine_name,
		).toBeNull();
	});

	test("'' counts as absent on every rung", () => {
		const out = projectMachineName({
			...legacy([
				{ lang: 'lg-spa', value: '' },
				{ lang: 'lg-eng', value: 'web_boomerang' },
			]),
			componentValues: [''],
		});
		expect(out.machine_name).toBe('web_boomerang');
		expect(out.rungs).toEqual(['derived_flag', 'single_value']);
	});

	test('single_value: one distinct value across langs (equal copies are one value)', () => {
		const out = projectMachineName(
			legacy([
				{ lang: 'lg-eng', value: 'x_table' },
				{ lang: 'lg-fra', value: 'x_table' },
			]),
		);
		expect(out.machine_name).toBe('x_table');
	});

	test('collision: several distinct candidates on the first rung that has any — never a guess', () => {
		const twoSpa = projectMachineName(
			legacy([
				{ lang: 'lg-spa', value: 'a' },
				{ lang: 'lg-spa', value: 'b' },
			]),
		);
		expect(twoSpa.machine_name).toBeNull();
		expect(twoSpa.use_machine_name).toBe(true);
		expect(twoSpa.defects).toEqual([{ kind: 'collision', values: ['a', 'b'] }]);
		const noSpa = projectMachineName(
			legacy([
				{ lang: 'lg-eng', value: 'a' },
				{ lang: 'lg-fra', value: 'b' },
			]),
		);
		expect(noSpa.defects).toEqual([{ kind: 'collision', values: ['a', 'b'] }]);
		const twoComponent = projectMachineName({ ...legacy(null), componentValues: ['a', 'b'] });
		expect(twoComponent.defects).toEqual([{ kind: 'collision', values: ['a', 'b'] }]);
	});

	test('missing: flag yes and no candidate at all', () => {
		const out = projectMachineName(legacy(null));
		expect(out).toEqual({
			machine_name: null,
			use_machine_name: true,
			rungs: ['derived_flag'],
			defects: [{ kind: 'missing' }],
		});
	});

	test('D16: a node with ontology43 and NO ontology5 at all is valid', () => {
		const out = projectMachineName({
			...legacy(null),
			componentValues: ['dd_table'],
			canonicalFlag: true,
		});
		expect(out).toEqual({
			machine_name: 'dd_table',
			use_machine_name: true,
			rungs: [],
			defects: [],
		});
	});
});

describe('projectMachineName — the flag', () => {
	test('derived_flag: unset flag = the classification (a label node gets no name)', () => {
		const out = projectMachineName(legacy([{ lang: 'lg-spa', value: 'Ficha' }], false));
		expect(out).toEqual({
			machine_name: null,
			use_machine_name: false,
			rungs: ['derived_flag'],
			defects: [],
		});
	});

	test('an explicit flag is obeyed; disagreeing with the classification is flag_mismatch', () => {
		const out = projectMachineName({
			...legacy([{ lang: 'lg-spa', value: 'my_table' }], true),
			canonicalFlag: false,
		});
		expect(out.use_machine_name).toBe(false);
		expect(out.machine_name).toBeNull();
		expect(out.defects).toEqual([{ kind: 'flag_mismatch', values: [false, true] }]);
		expect(out.rungs).toEqual([]);
	});

	test('flag no with a stated name: the name is dropped and reported', () => {
		const out = projectMachineName({
			...legacy(null, false),
			canonicalFlag: false,
			componentValues: ['stray'],
		});
		expect(out.machine_name).toBeNull();
		expect(out.defects).toEqual([{ kind: 'name_without_flag', values: ['stray'] }]);
	});

	test('an override flag flip is never applied, and reported', () => {
		const out = projectMachineName({
			...legacy([{ lang: 'lg-spa', value: 't1' }], true),
			canonicalFlag: true,
			overrideFlag: false,
		});
		expect(out.use_machine_name).toBe(true);
		expect(out.machine_name).toBe('t1');
		expect(out.defects).toEqual([{ kind: 'override_flag_flip', values: [false] }]);
		// The same value restated by the override is no finding.
		expect(
			projectMachineName({ ...legacy(null, true), canonicalFlag: true, overrideFlag: true })
				.defects,
		).toEqual([{ kind: 'missing' }]);
	});
});

describe('modelNameOf — the model column', () => {
	test('a derived model row answers its machine name', () => {
		expect(
			modelNameOf({ machine_name: 'table', use_machine_name: true, term: { 'lg-spa': 'x' } }),
		).toEqual({ model: 'table', legacy: false });
	});

	test('an UNDERIVED row (NULL flag: pre-0015, seed scaffold) falls back to lg-spa, strict', () => {
		expect(
			modelNameOf({ machine_name: null, use_machine_name: null, term: { 'lg-spa': 'table' } }),
		).toEqual({ model: 'table', legacy: true });
		// strict: no other lang is ever read
		expect(
			modelNameOf({ machine_name: null, use_machine_name: null, term: { 'lg-eng': 'table' } }),
		).toEqual({ model: null, legacy: false });
	});

	test('a derived flag-yes row with no name never falls back (its own defect)', () => {
		expect(
			modelNameOf({ machine_name: null, use_machine_name: true, term: { 'lg-spa': 'table' } }),
		).toEqual({ model: null, legacy: false });
	});

	test('no row → no model', () => {
		expect(modelNameOf(null)).toEqual({ model: null, legacy: false });
	});
});

describe('deriveLegacyMachineName — the rows-only paths', () => {
	test('a table instance named by its lg-spa term reads as the parser would project it', () => {
		const out = deriveLegacyMachineName({
			tipo: 'test5',
			tld: 'test',
			is_model: false,
			model_tipo: 'dd1229',
			model: 'table',
			term: { 'lg-spa': 'coins', 'lg-eng': 'Coins' },
		});
		expect(out.machine_name).toBe('coins');
		expect(out.use_machine_name).toBe(true);
	});

	test('a label-class node gets no name', () => {
		const out = deriveLegacyMachineName({
			tipo: 'test6',
			tld: 'test',
			is_model: false,
			model_tipo: 'dd6',
			model: 'section',
			term: { 'lg-spa': 'Monedas' },
		});
		expect(out).toMatchObject({ machine_name: null, use_machine_name: false });
	});
});
