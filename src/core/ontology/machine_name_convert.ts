/**
 * THE MACHINE-NAME CONVERSION KERNEL (plan §6, WC-2026-11-04-ontology-machine-names,
 * P3). PURE: no database, no ontology reads. Given what ONE ontology source record
 * holds — its ontology5 label items, its ontology43 machine name, its ontology44 flag
 * and the node's classification (machine_name.ts isNameClassNode) — it says which
 * conversion CLASS the record is in and exactly what the record must store after it.
 * The doors (machine_name_reconcile.ts: the two reconcile definitions and the package
 * import rewrite) read the record, call this, and write the result.
 *
 * THE SHAPE A CONVERSION REACHES (the same one the PHP v6 → v7 upgrade step writes,
 * class.v6_to_v7.php migrate_ontology_machine_names — owner decisions D3/D16):
 *  - a NAME node (effective flag Yes): ontology43 = its name (one lg-nolan item),
 *    ontology44 = dd64/1, and its lg-spa item LEAVES ontology5 (D16: a model or table
 *    name is not a Spanish label; the label chain ends in the machine name, so the UI
 *    loses nothing). Other langs stay as labels (D3: kept, reported, never purged);
 *  - a LABEL node (effective flag No): ontology44 = dd64/2 stated explicitly, so every
 *    node carries a flag and the `derived_flag` rung (machine_name.ts) can retire (P6).
 *
 * THE CLASSES (plan §6):
 *  - `L` LOSSLESS — what the parser derives is unchanged (machine_name, use_machine_name,
 *    model; the labels every UI lang resolves to): `move` (one lg-spa value, every other
 *    lang empty or equal to it), `move_single` (no lg-spa, one distinct value in any
 *    lang — a local non-Spanish node), `deduplicate` (ontology43 already holds the name
 *    and lg-spa repeats it), `flag_yes` / `flag_no` (only the flag is missing), and for
 *    a localontology0 OVERRIDE `override_move` / `override_deduplicate` (its lg-spa
 *    override value is the node's name; it becomes the override's ontology43, which
 *    REPLACES the canonical one exactly as the legacy merge did).
 *  - `S` STRAYS — the same move, but other langs hold DIFFERENT values (dd853
 *    `{lg-eus:'Berria', lg-spa:'body_references'}`): the name is unchanged, but those
 *    values become the node's only labels (a Spanish UI then shows the stray). Applied
 *    only by root, reported value by value (D3: kept as labels, never purged).
 *  - `C` REFUSED — never picked, reported with the values the operator adjudicates
 *    (today's published value is the default: the parser's current derivation):
 *    `name_differs` (ontology43 ≠ lg-spa), `ambiguous_legacy` (several distinct lg-spa
 *    values — ontology5 is multi_value), `ambiguous_values` (no lg-spa, several
 *    distinct values), `ambiguous_name` (several ontology43 values), `no_name` (a name
 *    node with no candidate anywhere), `name_without_flag` (a name on a flag-No node),
 *    `flag_no_on_name_model` (an explicit No on a node the classification names — D12:
 *    the explicit value is respected, never flipped), `invalid_name` (the one candidate
 *    breaks the generic name grammar the save rules enforce — surrounding whitespace, a
 *    control character: the write would be refused, so it is never auto-applied), and
 *    `model_unresolved` (the record names a model whose name does not resolve yet — its
 *    classification is UNKNOWN, so neither a name nor a stated No may be written; the
 *    doors decide this before the kernel, machine_name_reconcile.ts judgeRecord).
 *  - `none` — already in the converted shape (a second run finds nothing: idempotent).
 * FINDINGS ride beside the class and are never drift: `flag_mismatch` (an explicit
 * flag that disagrees with the classification — the post-upgrade verification of a
 * drifted PHP list), `override_flag` (an override states ontology44; canonical-only, it
 * is never touched here), `override_label_kept` (a non-spa override value on a name
 * node: moving it would RENAME a published table — it stays a label, plan §6 S).
 *
 * WHY EXPLICIT VALUES WIN (§6b rule 2): a flag or a name an operator or master already
 * set is input. The kernel only fills GAPS; a disagreement is reported, never fixed.
 */

import { LEGACY_NAME_LANG } from './machine_name.ts';
import {
	legacyNameMove,
	machineNameFormatViolation,
	type StoredLiteralItem,
	withoutLegacyNameItems,
} from './machine_name_rules.ts';

/** The conversion class of one record (module header). */
export type MachineNameConversionClass = 'none' | 'L' | 'S' | 'C';

/** What one record's conversion is (module header lists each). */
export type MachineNameConversionKind =
	| 'converted'
	| 'move'
	| 'move_single'
	| 'deduplicate'
	| 'flag_yes'
	| 'flag_no'
	| 'strays'
	| 'override_move'
	| 'override_deduplicate'
	| 'name_differs'
	| 'ambiguous_legacy'
	| 'ambiguous_values'
	| 'ambiguous_name'
	| 'no_name'
	| 'name_without_flag'
	| 'flag_no_on_name_model'
	| 'model_unresolved'
	| 'invalid_name';

/** A report-only observation on a record (never drift, never written). */
export type MachineNameConversionFinding =
	| 'flag_mismatch'
	| 'override_flag'
	| 'override_label_kept';

/** What a canonical `<tld>0` record holds for the kernel. */
export interface CanonicalConversionInput {
	/** ontology5 items exactly as stored (ids and any other keys are kept). */
	termItems: readonly StoredLiteralItem[];
	/** ontology43 values (`''` kept, read as absent). */
	nameValues: readonly string[];
	/** ontology44: true (dd64/1), false (another locator), null (unset). */
	flag: boolean | null;
	/** The node's classification (machine_name.ts isNameClassNode). */
	nameClass: boolean;
}

/** What a localontology0 override record holds for the kernel. */
export interface OverrideConversionInput {
	termItems: readonly StoredLiteralItem[];
	nameValues: readonly string[];
	/** The override's own ontology44 (null = not stated). Never written. */
	overrideFlag: boolean | null;
	/** The overridden node's effective flag; null when the override names no resolvable node. */
	nodeFlag: boolean | null;
}

/**
 * One record's verdict. The three write fields are what the record must STORE after the
 * conversion (undefined = that key is unchanged); they are set only for `L` and `S`.
 */
export interface MachineNameConversion {
	class: MachineNameConversionClass;
	kind: MachineNameConversionKind;
	/** The new ontology43 machine name. */
	machineName?: string;
	/** The new ontology44 flag. */
	flag?: boolean;
	/** The new ontology5 items (empty array = the key goes). */
	termItems?: StoredLiteralItem[];
	/** The langs whose items the conversion removes from ontology5 (the save door writes per lang). */
	removedLangs?: string[];
	/** The values a C verdict or an S move is about (the stray labels, the competing names). */
	values?: string[];
	findings: MachineNameConversionFinding[];
}

/** Distinct non-empty strings, first-seen order. */
function distinct(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value !== ''))];
}

/** A stored item's value as the string the parser reads (`''` for none). */
function itemValue(item: StoredLiteralItem): string {
	return typeof item.value === 'string' ? item.value : String(item.value ?? '');
}

/** The distinct non-empty values of the items NOT in the legacy lang. */
function nonLegacyValues(items: readonly StoredLiteralItem[]): string[] {
	return distinct(items.filter((item) => item.lang !== LEGACY_NAME_LANG).map(itemValue));
}

/** The distinct non-empty lg-spa values. */
function legacyValues(items: readonly StoredLiteralItem[]): string[] {
	return distinct(items.filter((item) => item.lang === LEGACY_NAME_LANG).map(itemValue));
}

/** The langs of the items a filter removes (sorted, distinct). */
function langsRemoved(
	before: readonly StoredLiteralItem[],
	after: readonly StoredLiteralItem[],
): string[] {
	const kept = new Set(after);
	const langs = before
		.filter((item) => !kept.has(item) && typeof item.lang === 'string')
		.map((item) => item.lang as string);
	return [...new Set(langs)].sort();
}

/** A verdict that writes nothing. */
function verdict(
	cls: MachineNameConversionClass,
	kind: MachineNameConversionKind,
	findings: MachineNameConversionFinding[],
	values?: string[],
): MachineNameConversion {
	return values === undefined
		? { class: cls, kind, findings }
		: { class: cls, kind, findings, values };
}

/** A verdict that rewrites ontology5 (and optionally the name / flag). */
function rewrite(
	cls: 'L' | 'S',
	kind: MachineNameConversionKind,
	before: readonly StoredLiteralItem[],
	after: StoredLiteralItem[],
	writes: { machineName?: string; flag?: boolean; values?: string[] },
	findings: MachineNameConversionFinding[],
): MachineNameConversion {
	return {
		class: cls,
		kind,
		...writes,
		termItems: after,
		removedLangs: langsRemoved(before, after),
		findings,
	};
}

/**
 * THE KERNEL over a canonical record (module header). Pure and idempotent: its own
 * output, fed back, is `none`.
 */
export function convertCanonicalRecord(input: CanonicalConversionInput): MachineNameConversion {
	const findings: MachineNameConversionFinding[] = [];
	if (input.flag !== null && input.flag !== input.nameClass) findings.push('flag_mismatch');
	const effective = input.flag ?? input.nameClass;
	return effective ? convertNamed(input, findings) : convertLabel(input, findings);
}

/** A flag-No node: no name may stand; an unset flag is stated No. */
function convertLabel(
	input: CanonicalConversionInput,
	findings: MachineNameConversionFinding[],
): MachineNameConversion {
	const names = distinct(input.nameValues);
	if (names.length > 0) return verdict('C', 'name_without_flag', findings, names);
	// An explicit No on a node the classification names (D12): respected, reported.
	if (input.flag === false && input.nameClass)
		return verdict('C', 'flag_no_on_name_model', findings);
	if (input.flag === null) return { class: 'L', kind: 'flag_no', flag: false, findings };
	return verdict('none', 'converted', findings);
}

/** A flag-Yes node: the name settles in ontology43 and lg-spa leaves ontology5. */
function convertNamed(
	input: CanonicalConversionInput,
	findings: MachineNameConversionFinding[],
): MachineNameConversion {
	const names = distinct(input.nameValues);
	if (names.length > 1) return verdict('C', 'ambiguous_name', findings, names);
	// The node states its flag after any conversion; a missing one is part of the gap.
	const flagFix = input.flag === null ? { flag: true } : {};
	if (names.length === 1) return convertStatedName(input, names[0] as string, flagFix, findings);
	return convertLegacyName(input, flagFix, findings);
}

/** ontology43 already holds the name: only a duplicate lg-spa or the flag may be owed. */
function convertStatedName(
	input: CanonicalConversionInput,
	name: string,
	flagFix: { flag?: boolean },
	findings: MachineNameConversionFinding[],
): MachineNameConversion {
	const legacy = legacyValues(input.termItems);
	if (legacy.length === 0) {
		return flagFix.flag === undefined
			? verdict('none', 'converted', findings)
			: { class: 'L', kind: 'flag_yes', flag: true, findings };
	}
	if (legacy.length === 1 && legacy[0] === name) {
		const after = withoutLegacyNameItems(input.termItems);
		return rewrite('L', 'deduplicate', input.termItems, after, flagFix, findings);
	}
	// lg-spa says something else than the stated name: never a pick.
	return verdict('C', 'name_differs', findings, [name, ...legacy]);
}

/** No ontology43 yet: the legacy rungs' candidate moves, or the record is refused. */
function convertLegacyName(
	input: CanonicalConversionInput,
	flagFix: { flag?: boolean },
	findings: MachineNameConversionFinding[],
): MachineNameConversion {
	const legacy = legacyValues(input.termItems);
	if (legacy.length > 1) return verdict('C', 'ambiguous_legacy', findings, legacy);
	const moved = legacyNameMove(input.termItems);
	if (moved !== null) {
		if (machineNameFormatViolation(moved.name) !== null) {
			return verdict('C', 'invalid_name', findings, [moved.name]);
		}
		const strays = nonLegacyValues(input.termItems).filter((value) => value !== moved.name);
		const writes = { machineName: moved.name, ...flagFix };
		if (strays.length === 0) {
			return rewrite('L', 'move', input.termItems, moved.termItems, writes, findings);
		}
		return rewrite(
			'S',
			'strays',
			input.termItems,
			moved.termItems,
			{ ...writes, values: strays },
			findings,
		);
	}
	return convertSingleValue(input, flagFix, findings);
}

/** No lg-spa at all: one distinct value in any lang moves (§6b rule 4); several refuse. */
function convertSingleValue(
	input: CanonicalConversionInput,
	flagFix: { flag?: boolean },
	findings: MachineNameConversionFinding[],
): MachineNameConversion {
	const values = nonLegacyValues(input.termItems);
	if (values.length === 0) return verdict('C', 'no_name', findings);
	if (values.length > 1) return verdict('C', 'ambiguous_values', findings, values);
	const name = values[0] as string;
	if (machineNameFormatViolation(name) !== null)
		return verdict('C', 'invalid_name', findings, [name]);
	const after = input.termItems.filter((item) => itemValue(item) !== name);
	return rewrite(
		'L',
		'move_single',
		input.termItems,
		after,
		{ machineName: name, ...flagFix },
		findings,
	);
}

/**
 * THE KERNEL over a localontology0 override record (module header). The flag is
 * canonical-only: a stated override flag is a finding and is never written.
 */
export function convertOverrideRecord(input: OverrideConversionInput): MachineNameConversion {
	const findings: MachineNameConversionFinding[] = [];
	if (input.overrideFlag !== null) findings.push('override_flag');
	const names = distinct(input.nameValues);
	if (input.nodeFlag === null) return verdict('none', 'converted', findings);
	if (!input.nodeFlag) {
		return names.length > 0
			? verdict('C', 'name_without_flag', findings, names)
			: verdict('none', 'converted', findings);
	}
	return convertNamedOverride(input, names, findings);
}

/** An override of a flag-Yes node: its lg-spa value becomes (or duplicates) its name. */
function convertNamedOverride(
	input: OverrideConversionInput,
	names: readonly string[],
	findings: MachineNameConversionFinding[],
): MachineNameConversion {
	if (names.length > 1) return verdict('C', 'ambiguous_name', findings, [...names]);
	const legacy = legacyValues(input.termItems);
	if (legacy.length > 1) return verdict('C', 'ambiguous_legacy', findings, legacy);
	// A non-spa override value on a name node renames nothing today and stays a label.
	if (nonLegacyValues(input.termItems).length > 0) findings.push('override_label_kept');
	if (legacy.length === 0) return verdict('none', 'converted', findings);
	return overrideLegacyName(input, names[0] ?? null, legacy[0] as string, findings);
}

/** One lg-spa override value: moved (no name yet), deduplicated (equal), or refused (differs). */
function overrideLegacyName(
	input: OverrideConversionInput,
	name: string | null,
	spa: string,
	findings: MachineNameConversionFinding[],
): MachineNameConversion {
	const after = withoutLegacyNameItems(input.termItems);
	if (name === null) {
		if (machineNameFormatViolation(spa) !== null)
			return verdict('C', 'invalid_name', findings, [spa]);
		return rewrite('L', 'override_move', input.termItems, after, { machineName: spa }, findings);
	}
	return name === spa
		? rewrite('L', 'override_deduplicate', input.termItems, after, {}, findings)
		: verdict('C', 'name_differs', findings, [name, spa]);
}
