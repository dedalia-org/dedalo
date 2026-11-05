/**
 * ONTOLOGY MACHINE-NAME SAVE RULES + THE RESTORE CONVERSION KERNEL (plan §4/§6,
 * WC-2026-11-04-ontology-machine-names). PURE: no database, no ontology reads —
 * the record-write chokepoint (section_record/machine_name_save.ts) reads the
 * record under its row lock, builds the states below and acts on the verdicts.
 *
 * WHAT A SAVE MAY NOT DO to an ontology node record (`<tld>0/<id>`):
 *  - `invalid`        write an ontology43 value with leading/trailing whitespace
 *                     or a control character, or several distinct values (the
 *                     generic rule until the model typology brings per-model
 *                     grammars, plan §4/§7);
 *  - `without_flag`   leave a machine name on a LABEL-class node whose
 *                     effective flag is No (flag No → the name must be empty);
 *                     a name-class node at flag No may stage its name (below);
 *  - `required`       leave a flag-Yes node without a DERIVABLE machine name —
 *                     the question is "will the parser derive a non-NULL
 *                     `machine_name`?", so it is answered by the parser's own
 *                     kernel (machine_name.ts projectMachineName), bridge rungs
 *                     included: an empty ontology43 with the name in ontology5
 *                     lg-spa is NOT missing it (single_value counts only while
 *                     ontology44 is unset). AND, write-scoped, EMPTY a stated
 *                     ontology43 on a flag-Yes node, whatever else would derive:
 *                     a leftover label must never silently become the name
 *                     (canonicalTransitionViolation). A NULL machine_name on a
 *                     matrix_table / table node sends data to the wrong table
 *                     (plan §11.1) — this is the S0 guard;
 *  - `flag_mismatch`  (owner decision D12) state flag No on a node the
 *                     classification names (a model definition, or a node whose
 *                     model is in NAME_MODELS) — refused with guidance, never
 *                     auto-converted: set ontology44 Yes first.
 * And on a localontology0 OVERRIDE record:
 *  - `override_flag`  state an ontology44 different from the node's flag — the
 *                     flag is canonical-only (a flip would silently rename or
 *                     translate a published name);
 *  - `invalid` / `without_flag` as above, against the NODE's flag.
 *
 * THE REFUSAL POLICY ("a write may not INTRODUCE a violation"): a verdict is
 * computed on the record before and after the write; a violation is refused when
 * the write introduced it — so an unrelated label edit on a node that already
 * carries a defect is never blocked (the defect stays an inspect finding,
 * ontology_state machineNameDefects). Write-scoped exceptions: an ontology43
 * write is always checked against `invalid` and `without_flag` (a write that
 * restates a bad name is still a bad write).
 *
 * THE EDITOR ORDER: the edit form saves ONE component per request, so a
 * two-field invariant needs one direction to be allowed. A name-class node:
 * machine name (ontology43) first — allowed at flag unset (the effective flag is
 * the classification's Yes) and at flag No (STAGED: the parser drops it,
 * name_without_flag, until the flag says Yes — the way out of a flag_mismatch) —
 * then flag Yes. Flag No on a name-class node stays refused (D12), and so does
 * emptying a stated name. Un-naming a node stated Yes against its label class
 * (a deliberate explicit value, §6b rule 2) needs both keys in ONE write: a door
 * that writes several keys at once (MCP records_write, an import row).
 *
 * THE RESTORE CONVERSION (`convertRestoredMachineName`) — the Time Machine
 * doors (component restore, whole-record restore, undelete, bulk revert) are
 * NEVER refused: a restore puts back bytes the record once held. When the node
 * is already in the machine-name shape (it states ontology44 or holds an
 * ontology43 value) and the restored state carries a legacy name — ontology5
 * lg-spa on a flag-Yes node, the shape before the conversion — the kernel MOVES
 * it into ontology43, exactly as the v6 upgrade step and the converter do
 * (D16: lg-spa leaves ontology5; other langs stay as labels, D3). A node still
 * in the legacy shape is restored as is: a restore lands in the shape the node
 * has now, so no single node is converted ahead of its tld (P4). The kernel
 * never picks between several lg-spa values (class C): it leaves them and
 * reports. P3's converter reuses `legacyNameMove` for its L class.
 */

import { compareLocators, type Locator } from '../concepts/locator.ts';
import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import { LEGACY_NAME_LANG, projectMachineName, type TermItem } from './machine_name.ts';
import {
	DATA_NOLAN,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_MODEL,
	ONTOLOGY_OVERWRITE,
	ONTOLOGY_TERM,
	ONTOLOGY_USE_MACHINE_NAME,
	RELATION_TYPE_LINK,
	SI_NO_NO,
	SI_NO_YES,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import { LOCAL_ONTOLOGY_SECTION, requiredOntologyTld } from './tld.ts';

// --- Scope: which writes the rules read ------------------------------------

/** The keys a canonical record's verdict depends on (name, flag, label, model, is_model). */
const TRIGGER_KEYS: ReadonlySet<string> = new Set([
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_USE_MACHINE_NAME,
	ONTOLOGY_TERM,
	ONTOLOGY_MODEL,
	ONTOLOGY_IS_MODEL,
]);

/** The keys an override's verdict depends on (its name, its flag, the node it overrides). */
const OVERRIDE_TRIGGER_KEYS: ReadonlySet<string> = new Set([
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_USE_MACHINE_NAME,
	ONTOLOGY_OVERWRITE,
]);

export type MachineNameScope = 'canonical' | 'override' | null;

/** Which rules a write onto `sectionTipo` touching `keys` is under (pure; no database). */
export function machineNameScope(sectionTipo: string, keys: Iterable<string>): MachineNameScope {
	const scope = sectionScope(sectionTipo);
	if (scope === null) return null;
	const triggers = scope === 'override' ? OVERRIDE_TRIGGER_KEYS : TRIGGER_KEYS;
	return [...keys].some((key) => triggers.has(key)) ? scope : null;
}

/** The rule family of a section: a canonical node section, the override section, or none. */
function sectionScope(sectionTipo: string): MachineNameScope {
	if (sectionTipo === LOCAL_ONTOLOGY_SECTION) return 'override';
	return requiredOntologyTld(sectionTipo) === null ? null : 'canonical';
}

// --- The generic name grammar -------------------------------------------------

/** Why one machine-name value is not a valid name (null = valid). */
export type MachineNameFormatRule = 'surrounding_whitespace' | 'control_character';

/** True when `value` holds a C0, DEL or C1 control character (a name is one printable line). */
function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/**
 * The ONE generic machine-name grammar until the model typology (C3) brings a
 * per-model one (SQL identifier, QName, domain token): no leading/trailing
 * whitespace, no control character. `''` is "no name", never a format fault.
 */
export function machineNameFormatViolation(value: string): MachineNameFormatRule | null {
	if (value === '') return null;
	if (hasControlCharacter(value)) return 'control_character';
	if (value.trim() !== value) return 'surrounding_whitespace';
	return null;
}

// --- The states the chokepoint builds ----------------------------------------

/** A canonical node record's machine-name state (after or before a write). */
export interface CanonicalNameState {
	/** ontology43 values (strings; `''` kept, read as absent). */
	nameValues: readonly string[];
	/** ontology44: true (dd64/1), false (any other locator), null (unset). */
	flag: boolean | null;
	/** ontology5 items (several per lang possible). */
	termItems: readonly TermItem[];
	/** The classification (machine_name.ts isNameClassNode) of the node in this state. */
	nameClass: boolean;
}

/** A localontology0 override record's machine-name state. */
export interface OverrideNameState {
	nameValues: readonly string[];
	/** The override's own ontology44 (null = not stated). */
	overrideFlag: boolean | null;
	/** The overridden node's effective flag; null when the override names no node. */
	nodeFlag: boolean | null;
}

export type MachineNameViolationKind =
	| 'invalid'
	| 'without_flag'
	| 'required'
	| 'flag_mismatch'
	| 'override_flag';

export interface MachineNameViolation {
	kind: MachineNameViolationKind;
	/** For `invalid`: which rule (a format rule, or `single_value`). */
	rule?: MachineNameFormatRule | 'single_value';
}

/** Distinct non-empty values, first-seen order. */
function distinctNames(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value !== ''))];
}

/** `invalid` for the first value breaking the grammar, or several distinct names. */
function formatViolation(values: readonly string[]): MachineNameViolation | null {
	const names = distinctNames(values);
	for (const name of names) {
		const rule = machineNameFormatViolation(name);
		if (rule !== null) return { kind: 'invalid', rule };
	}
	return names.length > 1 ? { kind: 'invalid', rule: 'single_value' } : null;
}

/** The effective flag of a canonical state: stated, else the classification (bridge rung). */
export function effectiveFlag(state: CanonicalNameState): boolean {
	return state.flag ?? state.nameClass;
}

/** Every rule a canonical node record breaks in this state (empty = valid). */
export function canonicalNameViolations(state: CanonicalNameState): MachineNameViolation[] {
	const invalid = formatViolation(state.nameValues);
	const flag = effectiveFlag(state);
	const rules: [boolean, MachineNameViolationKind][] = [
		// A name-class node standing at flag No (its own flag_mismatch) may STAGE its
		// name first: with no lg-spa left (D16) flag Yes before a name is `required`,
		// so refusing the name too would leave no way out.
		[!flag && !state.nameClass && hasName(state.nameValues), 'without_flag'],
		[requiresName(state, flag, invalid), 'required'],
		[state.flag === false && state.nameClass, 'flag_mismatch'],
	];
	return [...(invalid === null ? [] : [invalid]), ...firedRules(rules)];
}

/** `required`: flag Yes and nothing derives a name. A malformed name is `invalid` alone. */
function requiresName(
	state: CanonicalNameState,
	flag: boolean,
	invalid: MachineNameViolation | null,
): boolean {
	return flag && invalid === null && derivedName(state) === null;
}

/** True when the values hold at least one non-empty name. */
function hasName(values: readonly string[]): boolean {
	return distinctNames(values).length > 0;
}

/** The kinds of the rules whose condition holds, as violations. */
function firedRules(rules: readonly [boolean, MachineNameViolationKind][]): MachineNameViolation[] {
	return rules.filter(([fired]) => fired).map(([, kind]) => ({ kind }));
}

/** The machine_name the parser would derive from this state (the parser's own kernel). */
function derivedName(state: CanonicalNameState): string | null {
	return projectMachineName({
		componentValues: state.nameValues,
		canonicalFlag: state.flag,
		overrideFlag: null,
		termItems: state.termItems,
		nameClass: state.nameClass,
	}).machine_name;
}

/** Every rule an override record breaks in this state. */
export function overrideNameViolations(state: OverrideNameState): MachineNameViolation[] {
	const invalid = formatViolation(state.nameValues);
	const grammar = invalid === null ? [] : [invalid];
	const nodeFlag = state.nodeFlag;
	if (nodeFlag === null) return grammar; // names no node: only the grammar applies
	return [
		...grammar,
		...firedRules([
			[!nodeFlag && hasName(state.nameValues), 'without_flag'],
			[state.overrideFlag !== null && state.overrideFlag !== nodeFlag, 'override_flag'],
		]),
	];
}

/**
 * THE REFUSAL POLICY (module header): the first violation of `after` the write
 * introduced, or null when the write may proceed. `nameWritten` = the write
 * touched ontology43 with at least one non-empty value (write-scoped checks).
 */
export function introducedViolation(
	before: readonly MachineNameViolation[],
	after: readonly MachineNameViolation[],
	nameWritten: boolean,
): MachineNameViolation | null {
	const had = new Set(before.map((violation) => violation.kind));
	for (const violation of after) {
		const writeScoped =
			nameWritten && (violation.kind === 'invalid' || violation.kind === 'without_flag');
		if (writeScoped || !had.has(violation.kind)) return violation;
	}
	return null;
}

/**
 * THE CANONICAL VERDICT the chokepoint applies (module header): the refusal
 * policy over the two states, then the write-scoped `required` — a write that
 * EMPTIES a stated ontology43 on a node that stays flag Yes is refused even when
 * a bridge rung would still derive a name (lg-spa). Renaming (a new value in the
 * same write) is not emptying.
 */
export function canonicalTransitionViolation(
	before: CanonicalNameState,
	after: CanonicalNameState,
	nameWritten: boolean,
): MachineNameViolation | null {
	const introduced = introducedViolation(
		canonicalNameViolations(before),
		canonicalNameViolations(after),
		nameWritten,
	);
	if (introduced !== null) return introduced;
	const empties = hasName(before.nameValues) && !hasName(after.nameValues);
	return empties && effectiveFlag(after) ? { kind: 'required' } : null;
}

// --- The restore conversion kernel -------------------------------------------

/** One stored ontology5 item, as the kernel moves it (id and any other keys kept). */
export interface StoredLiteralItem {
	lang?: unknown;
	value?: unknown;
	[key: string]: unknown;
}

/** What a restored canonical record holds for the three keys, and what the node holds now. */
export interface RestoreConversionInput {
	/** The restored state (the record as the restore would store it). */
	restored: {
		termItems: readonly StoredLiteralItem[];
		nameValues: readonly string[];
		flag: boolean | null;
	};
	/** The node as it stands before the restore. */
	current: { nameValues: readonly string[]; flag: boolean | null };
	/** The classification in the restored state. */
	nameClass: boolean;
}

/** How a restore was converted (reported; never a refusal). */
export type RestoreConversionOutcome =
	/** The node is in the legacy shape, or nothing legacy was restored: stored as is. */
	| 'as_is'
	/** The restored lg-spa equals the name: the duplicate leaves ontology5 (lossless). */
	| 'deduplicated'
	/** The restored lg-spa became the machine name (it is what the restore meant then). */
	| 'moved'
	/** The restored state had no name at all: the node keeps its current one. */
	| 'kept_current'
	/** Several lg-spa values, or lg-spa differing from a restored ontology43: left, reported. */
	| 'ambiguous';

export interface RestoreConversion {
	outcome: RestoreConversionOutcome;
	/** Replacement ontology5 items (undefined = unchanged). */
	termItems?: StoredLiteralItem[];
	/** Replacement ontology43 name (undefined = unchanged). */
	machineName?: string;
	/** Replacement ontology44 flag (undefined = unchanged). */
	flag?: boolean;
	/** True when the move changed the node's current name (a rename from history). */
	renamed: boolean;
}

/** True when the node already lives in the machine-name shape. */
export function isConvertedShape(current: RestoreConversionInput['current']): boolean {
	return current.flag !== null || distinctNames(current.nameValues).length > 0;
}

/** The distinct non-empty lg-spa values of ontology5 items. */
function legacyNames(items: readonly StoredLiteralItem[]): string[] {
	return distinctNames(
		items
			.filter((item) => item.lang === LEGACY_NAME_LANG)
			.map((item) => (typeof item.value === 'string' ? item.value : String(item.value ?? ''))),
	);
}

/** ontology5 items without their lg-spa items (the D16 move). */
export function withoutLegacyNameItems(items: readonly StoredLiteralItem[]): StoredLiteralItem[] {
	return items.filter((item) => item.lang !== LEGACY_NAME_LANG);
}

/**
 * The L-class move over one node's ontology5 items (shared with P3's converter):
 * the single lg-spa value becomes the name and leaves ontology5; null when there
 * is no single lg-spa value (none → nothing to move; several → class C).
 */
export function legacyNameMove(
	items: readonly StoredLiteralItem[],
): { name: string; termItems: StoredLiteralItem[] } | null {
	const names = legacyNames(items);
	if (names.length !== 1) return null;
	return { name: names[0] as string, termItems: withoutLegacyNameItems(items) };
}

/**
 * THE RESTORE KERNEL (module header). Pure: says what the restore must store
 * for ontology5 / ontology43 / ontology44; the chokepoint writes it.
 */
export function convertRestoredMachineName(input: RestoreConversionInput): RestoreConversion {
	if (!isConvertedShape(input.current)) return { outcome: 'as_is', renamed: false };
	const restoredFlag = input.restored.flag;
	const flag = restoredFlag ?? input.current.flag ?? input.nameClass;
	// The node states its flag; a restored state that does not is given it back.
	const flagFix = restoredFlag === null ? { flag } : {};
	const name = flag ? convertRestoredName(input) : { outcome: 'as_is' as const, renamed: false };
	return { ...name, ...flagFix };
}

/** The name half of the restore kernel, for a flag-Yes node. */
function convertRestoredName(input: RestoreConversionInput): RestoreConversion {
	const spa = legacyNames(input.restored.termItems);
	const restoredName = distinctNames(input.restored.nameValues);
	// Several candidates on either side: never a pick (class C).
	if (Math.max(spa.length, restoredName.length) > 1)
		return { outcome: 'ambiguous', renamed: false };
	const currentName = distinctNames(input.current.nameValues)[0] ?? null;
	if (spa.length === 1) {
		return convertLegacyName(input, spa[0] as string, restoredName[0] ?? null, currentName);
	}
	return keepCurrentName(restoredName.length > 0, currentName);
}

/** No legacy name restored: a nameless restored state keeps the node's current name. */
function keepCurrentName(restoredHasName: boolean, currentName: string | null): RestoreConversion {
	if (restoredHasName || currentName === null) return { outcome: 'as_is', renamed: false };
	return { outcome: 'kept_current', machineName: currentName, renamed: false };
}

/** A restored state carrying ONE legacy lg-spa name: moved, deduplicated, or left (D3). */
function convertLegacyName(
	input: RestoreConversionInput,
	legacy: string,
	restoredName: string | null,
	currentName: string | null,
): RestoreConversion {
	const termItems = withoutLegacyNameItems(input.restored.termItems);
	if (restoredName === null) {
		const renamed = currentName !== null && currentName !== legacy;
		return { outcome: 'moved', termItems, machineName: legacy, renamed };
	}
	if (restoredName === legacy) return { outcome: 'deduplicated', termItems, renamed: false };
	// Both stated and different: the lg-spa stays a label (D3), reported.
	return { outcome: 'ambiguous', renamed: false };
}

// --- Stored shapes the conversion writes -------------------------------------

/** The ontology43 items a machine name is stored as (one lg-nolan literal). */
export function machineNameItems(name: string, id = 1): Record<string, unknown>[] {
	return [{ id, lang: DATA_NOLAN, value: name }];
}

/** The ontology44 items a flag is stored as (the dd64 yes/no locator). */
export function machineNameFlagItems(flag: boolean): Record<string, unknown>[] {
	return [
		{
			id: 1,
			type: RELATION_TYPE_LINK,
			section_id: canonicalizeStoredSectionId(flag ? SI_NO_YES : SI_NO_NO),
			section_tipo: YES_NO_SECTION,
			from_component_tipo: ONTOLOGY_USE_MACHINE_NAME,
		},
	];
}

/** A stored si/no flag off raw items: true (dd64/1), false (other locator), null (empty). */
export function flagFromItems(items: readonly unknown[] | null): boolean | null {
	const first = items?.[0] as Locator | undefined;
	if (first === undefined || first === null) return null;
	// the locator law (loose-numeric section_id), never an inline ===
	return compareLocators(first, { section_id: SI_NO_YES } as unknown as Locator, ['section_id']);
}

/** The string values of literal items (`''` kept; non-string scalars stringified). */
export function literalStrings(items: readonly unknown[] | null): string[] {
	const out: string[] = [];
	for (const item of items ?? []) {
		const value = (item as { value?: unknown } | null)?.value;
		if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
	}
	return out;
}

/** ontology5 items as kernel TermItems (non-lang items skipped). */
export function termItemsFromStored(items: readonly unknown[] | null): TermItem[] {
	const out: TermItem[] = [];
	for (const item of items ?? []) {
		const literal = item as StoredLiteralItem | null;
		if (literal !== null && typeof literal.lang === 'string') {
			out.push({ lang: literal.lang, value: String(literal.value ?? '') });
		}
	}
	return out;
}
