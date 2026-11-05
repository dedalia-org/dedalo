/**
 * ONTOLOGY MACHINE NAMES — the one home of the name-class rule and of the
 * derivation kernel behind dd_ontology.machine_name / use_machine_name
 * (WC-2026-11-04-ontology-machine-names).
 *
 * A node is identified EITHER by a language-free machine name (a model name, a
 * table/column/database name, an rdf/owl QName, a diffusion domain token) OR
 * by its translatable label (ontology5 `term`). The per-node flag ontology44
 * says which; the name itself is ontology43 (not translatable, lg-nolan).
 *
 *   dd_ontology.term              human labels per lang (ontology5, unchanged)
 *   dd_ontology.machine_name      the name; NULL unless use_machine_name
 *   dd_ontology.use_machine_name  true → machine_name is the node's name;
 *                                 NULL on a row no parser has derived yet
 *                                 (added by migration 0015, the seed scaffold)
 *   dd_ontology.model             = (model node).machine_name
 *
 * DERIVED ONLY: the parser (parser.ts) fills both columns through
 * `projectMachineName` below; no door writes them directly. The same kernel
 * serves the rows-only paths that have no source record to parse (a test
 * situation, an archive row from before the columns existed), so every path
 * reaches the same values.
 *
 * TRANSITION RUNGS (the P1 → P4 bridge, owner decision D15; retired at P6,
 * each counted so a ratchet can watch them reach zero):
 *  - `legacy_lang`   no ontology43 value → ontology5's LEGACY_NAME_LANG item
 *                    (where every pre-ontology43 name lives); also an
 *                    unconverted override's own lg-spa rename, which wins over
 *                    the canonical ontology43 (overrideLegacyName);
 *  - `single_value`  no lg-spa either → ontology5's single distinct non-empty
 *                    value (a local non-Spanish node, e.g. {lg-eng:'web_x'});
 *  - `derived_flag`  ontology44 unset → the flag is the CLASSIFICATION below.
 * `single_value` fires ONLY on a node in the legacy shape — ontology44 unset: on
 * a node stating its flag a lone non-Spanish value is a D3 stray label, never
 * the name (an emptied ontology43 there is `missing`; the save rules refuse the
 * emptying itself, machine_name_rules.ts canonicalTransitionViolation).
 * Several distinct candidates on any rung are a COLLISION: NULL plus a defect,
 * never a guess. `''` counts as absent everywhere.
 *
 * THE CLASSIFICATION (plan §5, the closed list) — a node is name-class when:
 *  - it is a MODEL DEFINITION: a strict descendant of dd2 ("Model names").
 *    The row predicate `is_model ∧ tld = dd ∧ no model_tipo ∧ tipo ≠ dd2`
 *    states it without a parent walk (measured equal on the dev install,
 *    2026-11-04: 152 descendants, all is_model, all tld dd, none with a model).
 *    The tld matters: crm's is_model nodes carry real translations and stay
 *    labels; so does dd2 itself ({lg-spa:'Modelos', lg-eng:'Model names'});
 *  - or its model is in NAME_MODELS.
 * Everything else is a label (sections, components, groupers, areas, the mixed
 * diffusion element/group/section/component models, value_type and
 * relation_type, crm/external nodes).
 *
 * The PHP v6 → v7 upgrade step (class.v6_to_v7.php migrate_ontology_machine_names)
 * DUPLICATES this list, citing this file as the source of truth; the post-upgrade
 * inspect defects (`flag_mismatch`, `missing`, `model_unresolved`) are what makes
 * a drifted copy loud.
 */

/** The lang every pre-ontology43 machine name was stored in (ontology5's lg-spa item). */
export const LEGACY_NAME_LANG = 'lg-spa';

/** dd2 — "Model names": every model definition is a strict descendant of it. */
export const MODEL_DEFINITION_ROOT = 'dd2';

/** The tld model definitions live in (crm's is_model nodes are labels). */
export const MODEL_DEFINITION_TLD = 'dd';

/**
 * The CLOSED list of models whose instances are named by a machine name: storage
 * identifiers (database, table, field_* columns, matrix_table), the diffusion
 * domain token (matched against DEDALO_DIFFUSION_DOMAIN) and rdf/owl QNames.
 * Adding a model here reclassifies every instance of it: it is an ontology
 * contract change (WC entry + the PHP copy), never a convenience.
 */
export const NAME_MODELS: ReadonlySet<string> = new Set([
	'database',
	'database_alias',
	'table',
	'table_alias',
	'matrix_table',
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
	'diffusion_domain',
	'rdf:predicate',
	'rdf:subject',
	'rdf:object',
	'owl:ObjectProperty',
	'owl:Class',
]);

/** What the classification reads off a node (parsed or stored — same fields). */
export interface MachineNameClassFields {
	tipo: string;
	tld: string | null;
	is_model: boolean;
	model_tipo: string | null;
	model: string | null;
}

/** A model definition (see the module header for why this predicate equals "strict dd2 descendant"). */
export function isModelDefinition(node: MachineNameClassFields): boolean {
	return (
		node.is_model === true &&
		node.tld === MODEL_DEFINITION_TLD &&
		(node.model_tipo ?? null) === null &&
		node.tipo !== MODEL_DEFINITION_ROOT
	);
}

/** True when the node is identified by a machine name (plan §5). */
export function isNameClassNode(node: MachineNameClassFields): boolean {
	if (isModelDefinition(node)) return true;
	return node.model !== null && NAME_MODELS.has(node.model);
}

/** One ontology5 item as the kernel reads it (several per lang are possible: multi_value). */
export interface TermItem {
	lang: string;
	value: string;
}

/** The legacy rungs a derivation may use (counted, retired at P6). */
export type MachineNameLegacyRung = 'legacy_lang' | 'single_value' | 'derived_flag';

/**
 * A machine-name finding on one node — reported, never thrown (one bad node
 * must not block its tld's rebuild):
 *  - `missing`            flag yes, no candidate anywhere;
 *  - `collision`          flag yes, several distinct candidates on the first
 *                         rung that has any (component, lg-spa, or any lang);
 *  - `name_without_flag`  flag no, yet ontology43 holds a value (dropped);
 *  - `flag_mismatch`      an explicit ontology44 disagrees with the
 *                         classification (the post-upgrade verification: a
 *                         drifted PHP list shows up here; also a model changed
 *                         to/from a name model while the flag stayed);
 *  - `override_flag_flip` a localontology0 override states another ontology44
 *                         value — refused: the flag is canonical-only, a flip
 *                         would silently rename or translate a published name;
 *  - `model_unresolved`   model_tipo is set but model resolves to nothing
 *                         (the model node has no machine name).
 */
export type MachineNameDefectKind =
	| 'missing'
	| 'collision'
	| 'name_without_flag'
	| 'flag_mismatch'
	| 'override_flag_flip'
	| 'model_unresolved';

export interface MachineNameDefect {
	kind: MachineNameDefectKind;
	/** The competing / offending values, when any (collision, name_without_flag, flags). */
	values?: unknown[];
}

/** Everything the kernel needs from one node's source record(s). */
export interface MachineNameInput {
	/** ontology43 values, override-resolved (an override's name REPLACES); null = empty. */
	componentValues: readonly string[] | null;
	/** Canonical ontology44: true (dd64/1), false (any other locator), null (unset). */
	canonicalFlag: boolean | null;
	/** The override's ontology44 (null = not stated / no override). Never applied. */
	overrideFlag: boolean | null;
	/** Effective ontology5 items (override-filled langs replace canonical ones). */
	termItems: readonly TermItem[] | null;
	/** The classification of the node (isNameClassNode). */
	nameClass: boolean;
	/**
	 * A localontology0 override's LEGACY rename: its own non-empty lg-spa ontology5
	 * values, passed only when that override states no ontology43 (null/absent
	 * otherwise). Before machine names an override renamed a name node exactly so,
	 * and an unconverted override must keep renaming it after its canonical record
	 * gained ontology43 — until the reconcile's `override_move` converts it.
	 */
	overrideLegacyName?: readonly string[] | null;
}

export interface MachineNameProjection {
	machine_name: string | null;
	use_machine_name: boolean;
	/** The legacy rungs this derivation used (empty = fully explicit data). */
	rungs: MachineNameLegacyRung[];
	defects: MachineNameDefect[];
}

/** Distinct non-empty strings, first-seen order. */
function distinctValues(values: readonly string[]): string[] {
	return [...new Set(values.filter((value) => value !== ''))];
}

type NamePick =
	| { kind: 'name'; value: string; rung: MachineNameLegacyRung | null }
	| { kind: 'collision'; values: string[] }
	| { kind: 'none' };

/** One rung's verdict over its candidates: none, the one value, or a collision. */
function pickFrom(candidates: readonly string[], rung: MachineNameLegacyRung | null): NamePick {
	const distinct = distinctValues(candidates);
	if (distinct.length === 0) return { kind: 'none' };
	if (distinct.length === 1) return { kind: 'name', value: distinct[0] as string, rung };
	return { kind: 'collision', values: distinct };
}

/**
 * The name of a flag-yes node: an unconverted override's lg-spa rename, then the
 * component, then lg-spa, then — ONLY on a node still in the legacy shape
 * (ontology44 unset) — the single value. A node that STATES its flag is past the
 * legacy shape: lg-spa is still where a half-converted package keeps its name,
 * but a lone value in another lang there is a D3 stray LABEL (D16 moved lg-spa
 * out) and never becomes a table / column / matrix-table name — an empty
 * ontology43 is `missing`.
 */
function pickMachineName(input: MachineNameInput): NamePick {
	const items = input.termItems ?? [];
	// The rungs in order, each a deferred pick: the first with any candidate wins.
	const rungs: (() => NamePick)[] = [
		() => pickFrom(input.overrideLegacyName ?? [], 'legacy_lang'),
		() => pickFrom(input.componentValues ?? [], null),
		() => pickFrom(legacyLangValues(items), 'legacy_lang'),
		() =>
			input.canonicalFlag === null
				? pickFrom(
						items.map((item) => item.value),
						'single_value',
					)
				: { kind: 'none' },
	];
	for (const rung of rungs) {
		const pick = rung();
		if (pick.kind !== 'none') return pick;
	}
	return { kind: 'none' };
}

/** The ontology5 values in LEGACY_NAME_LANG (where every pre-ontology43 name lives). */
function legacyLangValues(items: readonly TermItem[]): string[] {
	return items.filter((item) => item.lang === LEGACY_NAME_LANG).map((item) => item.value);
}

/** The flag and where it came from, plus the flag defects. */
function resolveFlag(input: MachineNameInput): {
	flag: boolean;
	derived: boolean;
	defects: MachineNameDefect[];
} {
	const defects: MachineNameDefect[] = [];
	const derived = input.canonicalFlag === null;
	const flag = derived ? input.nameClass : (input.canonicalFlag as boolean);
	if (!derived && flag !== input.nameClass) {
		defects.push({ kind: 'flag_mismatch', values: [flag, input.nameClass] });
	}
	if (input.overrideFlag !== null && input.overrideFlag !== flag) {
		defects.push({ kind: 'override_flag_flip', values: [input.overrideFlag] });
	}
	return { flag, derived, defects };
}

/**
 * THE KERNEL: one node's machine_name / use_machine_name from its source data.
 * Pure. See the module header for the rungs and the defect kinds.
 */
export function projectMachineName(input: MachineNameInput): MachineNameProjection {
	const { flag, derived, defects } = resolveFlag(input);
	const rungs: MachineNameLegacyRung[] = derived ? ['derived_flag'] : [];
	return flag ? projectNamed(input, rungs, defects) : projectLabel(input, rungs, defects);
}

/** A flag-no node: no name; a stated ontology43 value is dropped and reported. */
function projectLabel(
	input: MachineNameInput,
	rungs: MachineNameLegacyRung[],
	defects: MachineNameDefect[],
): MachineNameProjection {
	const stray = distinctValues(input.componentValues ?? []);
	if (stray.length > 0) defects.push({ kind: 'name_without_flag', values: stray });
	return { machine_name: null, use_machine_name: false, rungs, defects };
}

/** A flag-yes node: the picked name, or NULL plus `collision` / `missing`. */
function projectNamed(
	input: MachineNameInput,
	rungs: MachineNameLegacyRung[],
	defects: MachineNameDefect[],
): MachineNameProjection {
	const pick = pickMachineName(input);
	if (pick.kind === 'name') {
		if (pick.rung !== null) rungs.push(pick.rung);
		return { machine_name: pick.value, use_machine_name: true, rungs, defects };
	}
	defects.push(
		pick.kind === 'collision' ? { kind: 'collision', values: pick.values } : { kind: 'missing' },
	);
	return { machine_name: null, use_machine_name: true, rungs, defects };
}

/** ontology5 `{lang: value}` as kernel items (a stored row keeps one value per lang). */
export function termItemsOf(term: Record<string, string> | null | undefined): TermItem[] {
	return Object.entries(term ?? {}).map(([lang, value]) => ({ lang, value: String(value ?? '') }));
}

/**
 * The kernel over a node that has NO source record to parse — a rows-only path
 * (a test situation writing dd_ontology directly, an archive row from before
 * the columns existed, a JSON definition that does not state them). There is no
 * ontology43/44 to read, so this is exactly what the parser derives from a
 * legacy record: flag = classification, name = the legacy rungs over `term`.
 */
export function deriveLegacyMachineName(
	node: MachineNameClassFields & { term: Record<string, string> | null },
): MachineNameProjection {
	return projectMachineName({
		componentValues: null,
		canonicalFlag: null,
		overrideFlag: null,
		termItems: termItemsOf(node.term),
		nameClass: isNameClassNode(node),
	});
}

/** What a reader of a MODEL node's name needs off it. */
export interface ModelNameFields {
	machine_name?: string | null;
	use_machine_name?: boolean | null;
	term?: Record<string, string> | null;
}

/**
 * The model name a node takes from its model node: that node's machine_name.
 * BRIDGE RUNG (counted by the caller as `legacy_model_term`): a model row whose
 * name is not derived — `use_machine_name` NULL (a row from before migration
 * 0015, the seed scaffold's \copy) or false (a row written without the columns,
 * or a flag defect the model node reports itself) — falls back to its
 * LEGACY_NAME_LANG term, STRICT, which is exactly the pre-machine-name rule.
 * A derived model row (flag true) never falls back: a NULL there is the model
 * node's own `missing`/`collision` defect, and its instances report
 * `model_unresolved`.
 */
export function modelNameOf(modelNode: ModelNameFields | null | undefined): {
	model: string | null;
	legacy: boolean;
} {
	if (!modelNode) return NO_MODEL;
	const name = nonEmpty(modelNode.machine_name);
	if (name !== null) return { model: name, legacy: false };
	if (modelNode.use_machine_name === true) return NO_MODEL;
	const term = nonEmpty(modelNode.term?.[LEGACY_NAME_LANG]);
	return { model: term, legacy: term !== null };
}

const NO_MODEL = { model: null, legacy: false } as const;

/** A stored string, with `''` read as absent. */
function nonEmpty(value: string | null | undefined): string | null {
	return value === undefined || value === null || value === '' ? null : value;
}
