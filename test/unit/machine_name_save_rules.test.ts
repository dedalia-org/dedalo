/**
 * G7 — the machine-name SAVE RULES and the RESTORE CONVERSION KERNEL
 * (src/core/ontology/machine_name_rules.ts, plan §4/§6,
 * WC-2026-11-04-ontology-machine-names). Pure, no database.
 *
 * The record-write chokepoint (src/core/section_record/machine_name_save.ts)
 * builds these states from the record under its row lock and acts on the
 * verdicts: the save entries throw the introduced violation as a typed
 * `ontology.machine_name_*` error, the restore entries write the conversion.
 * Pinned here rule by rule: the scope (which writes the rules read), the generic
 * name grammar, every violation kind, the "introduced, not inherited" refusal
 * policy with its write-scoped exceptions, and every outcome of the restore
 * kernel (as_is on a legacy-shape node, dedupe, move with and without rename,
 * kept_current, ambiguous, the flag given back).
 */

import { describe, expect, test } from 'bun:test';
import {
	type CanonicalNameState,
	canonicalNameViolations,
	canonicalTransitionViolation,
	convertRestoredMachineName,
	flagFromItems,
	introducedViolation,
	legacyNameMove,
	machineNameFlagItems,
	machineNameFormatViolation,
	machineNameItems,
	machineNameScope,
	overrideNameViolations,
	type RestoreConversionInput,
} from '../../src/core/ontology/machine_name_rules.ts';

const canonical = (fields: Partial<CanonicalNameState>): CanonicalNameState => ({
	nameValues: [],
	flag: null,
	termItems: [],
	nameClass: false,
	...fields,
});

const kinds = (state: CanonicalNameState) => canonicalNameViolations(state).map((v) => v.kind);

describe('scope (no database)', () => {
	test('a canonical node section touching a rule key is in scope', () => {
		const triggers = ['ontology43', 'ontology44', 'ontology5', 'ontology6', 'ontology30'];
		// The loop below must assert something: every trigger key the rules read.
		expect(triggers.length).toBe(5);
		for (const key of triggers) {
			expect(machineNameScope('test0', [key])).toBe('canonical');
		}
	});
	test('other keys, other sections and the registry are out of scope', () => {
		expect(machineNameScope('test0', ['ontology16', 'ontology18'])).toBeNull();
		expect(machineNameScope('test3', ['ontology43'])).toBeNull();
		expect(machineNameScope('ontology35', ['ontology43'])).toBeNull();
		expect(machineNameScope('test0x', ['ontology43'])).toBeNull();
	});
	test('an override is in scope only for its name, flag and overwrite link', () => {
		expect(machineNameScope('localontology0', ['ontology43'])).toBe('override');
		expect(machineNameScope('localontology0', ['ontology44'])).toBe('override');
		expect(machineNameScope('localontology0', ['ontology42'])).toBe('override');
		expect(machineNameScope('localontology0', ['ontology5'])).toBeNull();
	});
});

describe('the generic name grammar (plan §4)', () => {
	test('a plain identifier, a QName and a non-ASCII name are valid', () => {
		for (const value of ['matrix_test', 'nmo:TestClass', 'número', 'a b']) {
			expect(machineNameFormatViolation(value)).toBeNull();
		}
	});
	test("'' is no name, never a format fault", () => {
		expect(machineNameFormatViolation('')).toBeNull();
	});
	test('surrounding whitespace and control characters are refused', () => {
		expect(machineNameFormatViolation(' table')).toBe('surrounding_whitespace');
		expect(machineNameFormatViolation('table ')).toBe('surrounding_whitespace');
		expect(machineNameFormatViolation('ta\tble')).toBe('control_character');
		expect(machineNameFormatViolation('table\n')).toBe('control_character');
		expect(machineNameFormatViolation('x\u007f')).toBe('control_character');
		expect(machineNameFormatViolation('x\u0085')).toBe('control_character');
	});
});

describe('canonical violations', () => {
	test('a flag-yes node with its name is valid', () => {
		expect(kinds(canonical({ flag: true, nameValues: ['matrix_x'], nameClass: true }))).toEqual([]);
	});
	test('a label node with no name is valid', () => {
		expect(kinds(canonical({ flag: false, termItems: [{ lang: 'lg-eng', value: 'L' }] }))).toEqual(
			[],
		);
	});
	test('several distinct names are `invalid` (single_value); equal copies are one name', () => {
		const several = canonicalNameViolations(canonical({ flag: true, nameValues: ['a', 'b'] }));
		expect(several).toEqual([{ kind: 'invalid', rule: 'single_value' }]);
		expect(kinds(canonical({ flag: true, nameValues: ['a', 'a', ''] }))).toEqual([]);
	});
	test('flag No + a name is `without_flag`', () => {
		expect(kinds(canonical({ flag: false, nameValues: ['x'] }))).toEqual(['without_flag']);
	});
	test('an unset flag reads as the classification (bridge rung)', () => {
		expect(kinds(canonical({ flag: null, nameValues: ['x'], nameClass: false }))).toEqual([
			'without_flag',
		]);
		expect(kinds(canonical({ flag: null, nameValues: ['x'], nameClass: true }))).toEqual([]);
	});
	test('flag Yes with no derivable name is `required`', () => {
		expect(kinds(canonical({ flag: true }))).toEqual(['required']);
		// several distinct label candidates are a collision, never a guess
		expect(
			kinds(
				canonical({
					flag: true,
					termItems: [
						{ lang: 'lg-eng', value: 'a' },
						{ lang: 'lg-fra', value: 'b' },
					],
				}),
			),
		).toEqual(['required']);
	});
	test('the bridge: a name still in ontology5 lg-spa (or, flag unset, a single value) satisfies `required`', () => {
		expect(kinds(canonical({ flag: true, termItems: [{ lang: 'lg-spa', value: 't' }] }))).toEqual(
			[],
		);
		expect(
			kinds(
				canonical({ flag: null, nameClass: true, termItems: [{ lang: 'lg-eng', value: 't' }] }),
			),
		).toEqual([]);
		// a node STATING its flag is past the legacy shape: a lone non-spa value is a stray label
		expect(kinds(canonical({ flag: true, termItems: [{ lang: 'lg-eng', value: 't' }] }))).toEqual([
			'required',
		]);
	});
	test('D12: flag No on a name-class node is `flag_mismatch`', () => {
		expect(kinds(canonical({ flag: false, nameClass: true }))).toEqual(['flag_mismatch']);
		// …and it may STAGE its name (the way out): no `without_flag` on a name-class node
		expect(kinds(canonical({ flag: false, nameClass: true, nameValues: ['t'] }))).toEqual([
			'flag_mismatch',
		]);
		// an unset flag follows the classification: no mismatch
		expect(kinds(canonical({ flag: null, nameClass: true, nameValues: ['t'] }))).toEqual([]);
	});
});

describe('override violations', () => {
	test('an override may not state another flag than its node', () => {
		expect(
			overrideNameViolations({ nameValues: [], overrideFlag: false, nodeFlag: true }).map(
				(v) => v.kind,
			),
		).toEqual(['override_flag']);
		expect(overrideNameViolations({ nameValues: [], overrideFlag: true, nodeFlag: true })).toEqual(
			[],
		);
	});
	test('an override name on a label node is `without_flag`; on a name node it replaces', () => {
		expect(
			overrideNameViolations({ nameValues: ['x'], overrideFlag: null, nodeFlag: false }).map(
				(v) => v.kind,
			),
		).toEqual(['without_flag']);
		expect(
			overrideNameViolations({ nameValues: ['x'], overrideFlag: null, nodeFlag: true }),
		).toEqual([]);
	});
	test('an override naming no node is checked for the grammar only', () => {
		expect(
			overrideNameViolations({ nameValues: [' x'], overrideFlag: false, nodeFlag: null }).map(
				(v) => v.kind,
			),
		).toEqual(['invalid']);
	});
});

describe('the refusal policy: introduced, not inherited', () => {
	const required = [{ kind: 'required' as const }];
	test('a violation the write introduced is refused', () => {
		expect(introducedViolation([], required, false)).toEqual(required[0] as never);
	});
	test('a violation the record already had is not refused for an unrelated write', () => {
		expect(introducedViolation(required, required, false)).toBeNull();
		expect(
			introducedViolation([{ kind: 'without_flag' }], [{ kind: 'without_flag' }], false),
		).toBeNull();
	});
	test('a write that restates a bad name is refused even when the record had one', () => {
		expect(
			introducedViolation([{ kind: 'without_flag' }], [{ kind: 'without_flag' }], true),
		).toEqual({ kind: 'without_flag' });
		const invalid = [{ kind: 'invalid' as const, rule: 'surrounding_whitespace' as const }];
		expect(introducedViolation(invalid, invalid, true)).toEqual(invalid[0] as never);
	});
	test('a write that fixes the record passes', () => {
		expect(introducedViolation(required, [], false)).toBeNull();
	});
	test('the editor order works one field at a time: label → flag Yes → name', () => {
		const label = canonical({ flag: false, termItems: [{ lang: 'lg-spa', value: 'matrix_x' }] });
		const flagged = { ...label, flag: true };
		const named = { ...flagged, nameValues: ['matrix_x'] };
		expect(
			introducedViolation(canonicalNameViolations(label), canonicalNameViolations(flagged), false),
		).toBeNull();
		expect(
			introducedViolation(canonicalNameViolations(flagged), canonicalNameViolations(named), true),
		).toBeNull();
	});
	test('a name-class node at flag No: the name is staged first, then flag Yes', () => {
		const mismatch = canonical({ flag: false, nameClass: true });
		const staged = { ...mismatch, nameValues: ['body_references'] };
		const fixed = { ...staged, flag: true };
		expect(canonicalTransitionViolation(mismatch, staged, true)).toBeNull();
		expect(canonicalTransitionViolation(staged, fixed, false)).toBeNull();
		// the reverse order is refused: flag Yes with no name (no lg-spa left, D16)
		expect(canonicalTransitionViolation(mismatch, { ...mismatch, flag: true }, false)?.kind).toBe(
			'required',
		);
	});
	test('emptying a stated name on a flag-Yes node is refused — a stray label never takes over', () => {
		// a converted dd853: the name in ontology43, the Basque stray kept as a label (D3)
		const converted = canonical({
			flag: true,
			nameClass: true,
			nameValues: ['body_references'],
			termItems: [{ lang: 'lg-eus', value: 'Berria' }],
		});
		const cleared = { ...converted, nameValues: [] };
		expect(canonicalTransitionViolation(converted, cleared, false)?.kind).toBe('required');
		// …even where lg-spa would still derive a name: emptying is write-scoped
		const withSpa = {
			...converted,
			termItems: [...converted.termItems, { lang: 'lg-spa', value: 'body_references' }],
		};
		expect(canonicalTransitionViolation(withSpa, { ...withSpa, nameValues: [] }, false)?.kind).toBe(
			'required',
		);
		// a rename in one write is not emptying
		expect(
			canonicalTransitionViolation(converted, { ...converted, nameValues: ['body_refs'] }, true),
		).toBeNull();
	});
	test('the wrong order is refused with the guidance kind: name first on a flag-No node', () => {
		const label = canonical({ flag: false });
		const named = { ...label, nameValues: ['x'] };
		expect(
			introducedViolation(canonicalNameViolations(label), canonicalNameViolations(named), true)
				?.kind,
		).toBe('without_flag');
	});
	test('D12: a model change to a name model under flag No is refused', () => {
		const before = canonical({ flag: false, nameClass: false });
		const after = { ...before, nameClass: true };
		expect(
			introducedViolation(canonicalNameViolations(before), canonicalNameViolations(after), false)
				?.kind,
		).toBe('flag_mismatch');
	});
	test('clearing the name of a flag-Yes node is refused once nothing else derives it', () => {
		const before = canonical({ flag: true, nameValues: ['x'] });
		const after = { ...before, nameValues: [] };
		expect(
			introducedViolation(canonicalNameViolations(before), canonicalNameViolations(after), false)
				?.kind,
		).toBe('required');
	});
});

describe('the restore conversion kernel (TM doors are never refused)', () => {
	const input = (fields: {
		termItems?: RestoreConversionInput['restored']['termItems'];
		nameValues?: string[];
		flag?: boolean | null;
		currentName?: string[];
		currentFlag?: boolean | null;
		nameClass?: boolean;
	}): RestoreConversionInput => ({
		restored: {
			termItems: fields.termItems ?? [],
			nameValues: fields.nameValues ?? [],
			flag: fields.flag ?? null,
		},
		current: { nameValues: fields.currentName ?? [], flag: fields.currentFlag ?? null },
		nameClass: fields.nameClass ?? true,
	});
	const spa = (value: string, id = 1) => ({ id, lang: 'lg-spa', value });
	const eng = (value: string, id = 2) => ({ id, lang: 'lg-eng', value });

	test('a node still in the legacy shape is restored as is (no single node converts ahead of P4)', () => {
		expect(convertRestoredMachineName(input({ termItems: [spa('t')] }))).toEqual({
			outcome: 'as_is',
			renamed: false,
		});
	});
	test('a legacy lg-spa equal to the name leaves ontology5 (lossless)', () => {
		const out = convertRestoredMachineName(
			input({
				termItems: [spa('t'), eng('Label')],
				nameValues: ['t'],
				flag: true,
				currentName: ['t'],
				currentFlag: true,
			}),
		);
		expect(out).toEqual({ outcome: 'deduplicated', termItems: [eng('Label')], renamed: false });
	});
	test('a restored legacy name moves into ontology43 — a rename from history is flagged', () => {
		const out = convertRestoredMachineName(
			input({ termItems: [spa('old'), eng('L')], currentName: ['new'], currentFlag: true }),
		);
		expect(out).toEqual({
			outcome: 'moved',
			termItems: [eng('L')],
			machineName: 'old',
			renamed: true,
			flag: true,
		});
	});
	test('a restored state without any name keeps the current one (never leaves flag Yes nameless)', () => {
		const out = convertRestoredMachineName(
			input({ termItems: [eng('L')], currentName: ['t'], currentFlag: true }),
		);
		expect(out).toEqual({ outcome: 'kept_current', machineName: 't', renamed: false, flag: true });
	});
	test('several lg-spa values, or lg-spa differing from a restored name, are left and reported', () => {
		expect(
			convertRestoredMachineName(
				input({ termItems: [spa('a'), spa('b', 3)], currentName: ['t'], currentFlag: true }),
			).outcome,
		).toBe('ambiguous');
		expect(
			convertRestoredMachineName(
				input({
					termItems: [spa('a')],
					nameValues: ['b'],
					flag: true,
					currentName: ['b'],
					currentFlag: true,
				}),
			),
		).toEqual({ outcome: 'ambiguous', renamed: false });
	});
	test('a restored state missing the flag gets the node flag back; a label node keeps its lg-spa', () => {
		expect(
			convertRestoredMachineName(
				input({ termItems: [spa('Etiqueta')], currentFlag: false, nameClass: false }),
			),
		).toEqual({ outcome: 'as_is', renamed: false, flag: false });
	});
	test('legacyNameMove is the L class: one lg-spa value moves, several do not', () => {
		expect(legacyNameMove([spa('t'), eng('L')])).toEqual({ name: 't', termItems: [eng('L')] });
		expect(legacyNameMove([spa('a'), spa('b', 3)])).toBeNull();
		expect(legacyNameMove([eng('L')])).toBeNull();
	});
});

describe('stored shapes', () => {
	test('a name is one lg-nolan literal; a flag is the dd64 locator; flags read back', () => {
		expect(machineNameItems('t')).toEqual([{ id: 1, lang: 'lg-nolan', value: 't' }]);
		expect(flagFromItems(machineNameFlagItems(true))).toBe(true);
		expect(flagFromItems(machineNameFlagItems(false))).toBe(false);
		expect(flagFromItems(null)).toBeNull();
		expect(machineNameFlagItems(true)[0]).toMatchObject({
			section_tipo: 'dd64',
			type: 'dd151',
			from_component_tipo: 'ontology44',
		});
	});
});
