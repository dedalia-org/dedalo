/**
 * THE MACHINE-NAME CONVERSION KERNEL (P3, plan §6, WC-2026-11-04-ontology-machine-names)
 * — hermetic, no database. src/core/ontology/machine_name_convert.ts says which class
 * (L lossless / S strays / C refused / none) one ontology source record is in and what
 * it must store after the conversion. This gate proves, per class:
 *  - the verdict and the exact stored result (name, flag, ontology5 items kept with
 *    their ids, the removed lang slices);
 *  - LOSSLESS IS MEASURED, not claimed: for every L verdict the parser's own kernel
 *    (machine_name.ts projectMachineName) derives the SAME machine_name and
 *    use_machine_name from the converted record as from the legacy one, and every UI
 *    lang resolves to the same label through the shared chain's rule (lang → any →
 *    machine_name);
 *  - S keeps the strays as labels (D3) and changes only which label a lang resolves to;
 *  - C writes nothing and names the competing values;
 *  - IDEMPOTENT: the kernel over its own output is `none`;
 *  - explicit values win (§6b rule 2): a stated flag is never flipped, only reported;
 *  - overrides: an lg-spa override becomes the override's name, a stated override
 *    flag is a finding and never written, a non-spa override value stays a label.
 */

import { describe, expect, test } from 'bun:test';
import { projectMachineName, type TermItem } from '../../src/core/ontology/machine_name.ts';
import {
	type CanonicalConversionInput,
	convertCanonicalRecord,
	convertOverrideRecord,
	type MachineNameConversion,
} from '../../src/core/ontology/machine_name_convert.ts';
import type { StoredLiteralItem } from '../../src/core/ontology/machine_name_rules.ts';

const item = (id: number, lang: string, value: string): StoredLiteralItem => ({ id, lang, value });

/** What the parser derives from a record state (no override). */
function derived(state: CanonicalConversionInput) {
	return projectMachineName({
		componentValues: state.nameValues,
		canonicalFlag: state.flag,
		overrideFlag: null,
		termItems: state.termItems.map((t) => ({
			lang: String(t.lang),
			value: String(t.value),
		})) as TermItem[],
		nameClass: state.nameClass,
	});
}

/** The record state after applying a conversion. */
function applied(
	state: CanonicalConversionInput,
	c: MachineNameConversion,
): CanonicalConversionInput {
	return {
		termItems: c.termItems ?? state.termItems,
		nameValues: c.machineName === undefined ? state.nameValues : [c.machineName],
		flag: c.flag ?? state.flag,
		nameClass: state.nameClass,
	};
}

/** The label a lang resolves to (the chain's shape: lang → first non-empty → machine name). */
function labelIn(state: CanonicalConversionInput, lang: string): string | null {
	const own = state.termItems.find((t) => t.lang === lang && t.value !== '');
	if (own !== undefined) return String(own.value);
	const any = state.termItems.find((t) => t.value !== '');
	if (any !== undefined) return String(any.value);
	return derived(state).machine_name;
}

const LANGS = ['lg-spa', 'lg-eng', 'lg-cat', 'lg-eus', 'lg-fra'];

/** Assert a verdict is LOSSLESS: same derivation, same label in every lang, idempotent. */
function expectLossless(state: CanonicalConversionInput, c: MachineNameConversion): void {
	expect(c.class).toBe('L');
	const after = applied(state, c);
	const before = derived(state);
	const now = derived(after);
	expect(now.machine_name).toBe(before.machine_name);
	expect(now.use_machine_name).toBe(before.use_machine_name);
	for (const lang of LANGS) expect(labelIn(after, lang)).toBe(labelIn(state, lang));
	// The converted record needs no legacy rung for its name or its flag any more.
	expect(now.rungs).toEqual([]);
	expect(convertCanonicalRecord(after).class).toBe('none');
}

const legacy = (termItems: StoredLiteralItem[], nameClass = true): CanonicalConversionInput => ({
	termItems,
	nameValues: [],
	flag: null,
	nameClass,
});

describe('class L — lossless', () => {
	test('move: one lg-spa name, nothing else — name to ontology43, flag Yes, lg-spa out (D16)', () => {
		const state = legacy([item(1, 'lg-spa', 'matrix_test')]);
		const c = convertCanonicalRecord(state);
		expect(c).toMatchObject({ kind: 'move', machineName: 'matrix_test', flag: true });
		expect(c.termItems).toEqual([]);
		expect(c.removedLangs).toEqual(['lg-spa']);
		expectLossless(state, c);
	});

	test('move with equal copies in other langs: the copies stay as labels, ids kept', () => {
		const state = legacy([
			item(1, 'lg-spa', 'tbl'),
			item(2, 'lg-eng', 'tbl'),
			item(3, 'lg-cat', ''),
		]);
		const c = convertCanonicalRecord(state);
		expect(c.kind).toBe('move');
		expect(c.termItems).toEqual([item(2, 'lg-eng', 'tbl'), item(3, 'lg-cat', '')]);
		expectLossless(state, c);
	});

	test('move_single: no lg-spa, one distinct value (navarra474) — moved out of its lang', () => {
		const state = legacy([item(1, 'lg-eng', 'web_boomerang')]);
		const c = convertCanonicalRecord(state);
		expect(c).toMatchObject({ kind: 'move_single', machineName: 'web_boomerang', flag: true });
		expect(c.removedLangs).toEqual(['lg-eng']);
		expectLossless(state, c);
	});

	test('deduplicate: ontology43 already holds the name, lg-spa repeats it', () => {
		const state: CanonicalConversionInput = {
			termItems: [item(1, 'lg-spa', 'field_text')],
			nameValues: ['field_text'],
			flag: true,
			nameClass: true,
		};
		const c = convertCanonicalRecord(state);
		expect(c.kind).toBe('deduplicate');
		expect(c.machineName).toBeUndefined();
		expect(c.flag).toBeUndefined();
		expectLossless(state, c);
	});

	test('flag_yes / flag_no: only the flag is owed', () => {
		const named: CanonicalConversionInput = {
			termItems: [],
			nameValues: ['db'],
			flag: null,
			nameClass: true,
		};
		const yes = convertCanonicalRecord(named);
		expect(yes).toMatchObject({ kind: 'flag_yes', flag: true });
		expect(yes.termItems).toBeUndefined();
		expectLossless(named, yes);
		const label = legacy([item(1, 'lg-spa', 'Fecha'), item(2, 'lg-eng', 'Date')], false);
		const no = convertCanonicalRecord(label);
		expect(no).toMatchObject({ kind: 'flag_no', flag: false });
		expect(no.termItems).toBeUndefined();
		expectLossless(label, no);
	});
});

describe('class S — strays (D3: kept as labels, never purged)', () => {
	test('dd853 shape: the name moves, the differing translation stays and is named', () => {
		const state = legacy([item(1, 'lg-eus', 'Berria'), item(2, 'lg-spa', 'body_references')]);
		const c = convertCanonicalRecord(state);
		expect(c).toMatchObject({
			class: 'S',
			kind: 'strays',
			machineName: 'body_references',
			values: ['Berria'],
		});
		expect(c.termItems).toEqual([item(1, 'lg-eus', 'Berria')]);
		const after = applied(state, c);
		// The NAME is unchanged …
		expect(derived(after).machine_name).toBe(derived(state).machine_name);
		// … what changes is the label a Spanish screen resolves to: the stray. That is why S is root's.
		expect(labelIn(state, 'lg-spa')).toBe('body_references');
		expect(labelIn(after, 'lg-spa')).toBe('Berria');
		expect(convertCanonicalRecord(after).class).toBe('none');
	});
});

describe('class C — refused, never picked', () => {
	const cases: [string, CanonicalConversionInput, string, string[] | undefined][] = [
		[
			'ontology43 ≠ lg-spa',
			{ termItems: [item(1, 'lg-spa', 'a')], nameValues: ['b'], flag: true, nameClass: true },
			'name_differs',
			['b', 'a'],
		],
		[
			'several lg-spa values',
			legacy([item(1, 'lg-spa', 'a'), item(2, 'lg-spa', 'b')]),
			'ambiguous_legacy',
			['a', 'b'],
		],
		[
			'no lg-spa, several values',
			legacy([item(1, 'lg-eng', 'a'), item(2, 'lg-fra', 'b')]),
			'ambiguous_values',
			['a', 'b'],
		],
		[
			'several ontology43 values',
			{ termItems: [], nameValues: ['a', 'b'], flag: true, nameClass: true },
			'ambiguous_name',
			['a', 'b'],
		],
		['a name node with nothing', legacy([item(1, 'lg-spa', '')]), 'no_name', undefined],
		[
			'a name on a flag-No node',
			{ termItems: [], nameValues: ['x'], flag: false, nameClass: false },
			'name_without_flag',
			['x'],
		],
		[
			'explicit No on a name model (D12)',
			{ termItems: [item(1, 'lg-spa', 't')], nameValues: [], flag: false, nameClass: true },
			'flag_no_on_name_model',
			undefined,
		],
	];
	test('the refusal table covers every C kind (the loop below asserts something)', () => {
		expect(new Set(cases.map(([, , kind]) => kind)).size).toBe(7);
		expect(cases.length).toBe(7);
	});
	for (const [label, state, kind, values] of cases) {
		test(`${label} → ${kind}, nothing written`, () => {
			const c = convertCanonicalRecord(state);
			expect(c.class).toBe('C');
			expect(c.kind as string).toBe(kind);
			expect(c.values).toEqual(values);
			expect(c.machineName).toBeUndefined();
			expect(c.flag).toBeUndefined();
			expect(c.termItems).toBeUndefined();
		});
	}
});

describe('explicit values win (§6b rule 2)', () => {
	test('an explicit Yes on a label-class node is respected (gap filled) and reported', () => {
		const state: CanonicalConversionInput = {
			termItems: [item(1, 'lg-spa', 'nmo:Coin')],
			nameValues: [],
			flag: true,
			nameClass: false,
		};
		const c = convertCanonicalRecord(state);
		expect(c.kind).toBe('move');
		expect(c.flag).toBeUndefined(); // never re-stated, never flipped
		expect(c.findings).toEqual(['flag_mismatch']);
		expectLossless(state, c);
	});

	test('a candidate breaking the name grammar is refused (C invalid_name), never auto-applied', () => {
		for (const termItems of [[item(1, 'lg-spa', 'table_x ')], [item(1, 'lg-eng', 'table\tx')]]) {
			const c = convertCanonicalRecord({ termItems, nameValues: [], flag: null, nameClass: true });
			expect(c.class).toBe('C');
			expect(c.kind).toBe('invalid_name');
			expect(c.machineName).toBeUndefined();
			expect(c.termItems).toBeUndefined();
		}
		const o = convertOverrideRecord({
			termItems: [item(1, 'lg-spa', ' spaced')],
			nameValues: [],
			overrideFlag: null,
			nodeFlag: true,
		});
		expect([o.class, o.kind]).toEqual(['C', 'invalid_name']);
	});

	test('already converted: none, and stays none', () => {
		const state: CanonicalConversionInput = {
			termItems: [item(2, 'lg-eng', 'Table')],
			nameValues: ['tbl'],
			flag: true,
			nameClass: true,
		};
		expect(convertCanonicalRecord(state)).toEqual({
			class: 'none',
			kind: 'converted',
			findings: [],
		});
		const label: CanonicalConversionInput = {
			termItems: [item(1, 'lg-eng', 'Date')],
			nameValues: [],
			flag: false,
			nameClass: false,
		};
		expect(convertCanonicalRecord(label).class).toBe('none');
	});
});

describe('overrides (localontology0) — the flag is canonical-only', () => {
	test('an lg-spa override value on a name node becomes the override name (it REPLACES, as the legacy merge did)', () => {
		const c = convertOverrideRecord({
			termItems: [item(1, 'lg-spa', 'local_table'), item(2, 'lg-eng', 'Local table')],
			nameValues: [],
			overrideFlag: null,
			nodeFlag: true,
		});
		expect(c).toMatchObject({ class: 'L', kind: 'override_move', machineName: 'local_table' });
		expect(c.flag).toBeUndefined();
		expect(c.termItems).toEqual([item(2, 'lg-eng', 'Local table')]);
		expect(c.findings).toEqual(['override_label_kept']);
	});

	test('a non-spa override on a name node renames nothing: no write, reported', () => {
		const c = convertOverrideRecord({
			termItems: [item(1, 'lg-eng', 'Other')],
			nameValues: [],
			overrideFlag: null,
			nodeFlag: true,
		});
		expect(c.class).toBe('none');
		expect(c.findings).toEqual(['override_label_kept']);
	});

	test('a stated override flag is a finding, never written; a name on a No node is refused', () => {
		const flagged = convertOverrideRecord({
			termItems: [],
			nameValues: [],
			overrideFlag: true,
			nodeFlag: false,
		});
		expect(flagged).toEqual({ class: 'none', kind: 'converted', findings: ['override_flag'] });
		const named = convertOverrideRecord({
			termItems: [],
			nameValues: ['x'],
			overrideFlag: null,
			nodeFlag: false,
		});
		expect(named).toMatchObject({ class: 'C', kind: 'name_without_flag', values: ['x'] });
	});

	test('dedup and conflict on an override that already states its name; idempotent', () => {
		const dup = convertOverrideRecord({
			termItems: [item(1, 'lg-spa', 'n')],
			nameValues: ['n'],
			overrideFlag: null,
			nodeFlag: true,
		});
		expect(dup).toMatchObject({ class: 'L', kind: 'override_deduplicate' });
		expect(dup.termItems).toEqual([]);
		const differs = convertOverrideRecord({
			termItems: [item(1, 'lg-spa', 'a')],
			nameValues: ['b'],
			overrideFlag: null,
			nodeFlag: true,
		});
		expect(differs).toMatchObject({ class: 'C', kind: 'name_differs' });
		const converted = convertOverrideRecord({
			termItems: [],
			nameValues: ['n'],
			overrideFlag: null,
			nodeFlag: true,
		});
		expect(converted.class).toBe('none');
		// An override naming no resolvable node is out of the kernel's reach.
		expect(
			convertOverrideRecord({
				termItems: [item(1, 'lg-spa', 'a')],
				nameValues: [],
				overrideFlag: null,
				nodeFlag: null,
			}).class,
		).toBe('none');
	});
});
