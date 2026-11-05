/**
 * Ontology parser — PHP ontology::parse_section_record_to_ontology_node
 * (class.ontology.php:1811). Turns ONE matrix_ontology (or matrix_ontology_main)
 * section record into the DdOntologyNode the write layer upserts into dd_ontology.
 *
 * The record is the source of truth (edited in the ontology area); dd_ontology is
 * the derived runtime table. Each field is read off a specific component of the
 * record (ontology5 term, ontology7 tld, …) with these hard-won subtleties, all
 * pinned against live PHP:
 *
 *  - OVERWRITE-AWARENESS (WC-2026-10-01-ontology-overwrite-scoped): a
 *    localontology0 record linked to this node by ONTOLOGY_OVERWRITE (ontology42)
 *    can supply replacement data. `resolved(tipo)` = overwrite items ?? canonical
 *    items — BUT only for the overwrite-aware fields. CANONICAL-ONLY (structure
 *    and stored-data shape, never changed by a local override): tld, is_model,
 *    is_translatable, order. term: merged PER LANG. properties: per TOP-LEVEL
 *    KEY (css/source included) — a stated key replaces whole, `null` in the
 *    override's ontology18 removes it. model/model_tipo, parent, relations,
 *    propiedades: override replaces when present.
 *    A localontology0 record is never a node itself — parsing one is refused.
 *  - parent: null iff the parent locator points at the ontology main section
 *    (ontology35) — the dd1/dd2 roots; otherwise the parent's term-id.
 *  - model: dd_ontology(model_tipo).machine_name — the model node's language-free
 *    name (ontology/machine_name.ts modelNameOf; bridge rung: a model row not
 *    yet derived falls back to its term['lg-spa'], STRICT — no lang fallback).
 *  - machine_name / use_machine_name (ontology43 / ontology44): derived by the
 *    kernel in ontology/machine_name.ts (projectMachineName) — the component
 *    first, then the counted legacy rungs; an override's machine name REPLACES
 *    the canonical one, its flag is never applied (canonical-only; a differing
 *    one is the `override_flag_flip` defect). Defects are RETURNED
 *    (`machineNameDefects`), never thrown.
 *  - is_translatable: defaults TRUE when the component is missing.
 *  - order_number / properties: `(int)` cast / empty→SQL NULL (never {}).
 *  - propiedades (v5 legacy): the value re-encoded via phpPrettyJsonEncode so the
 *    stored TEXT is byte-identical to PHP json_encode(..., JSON_PRETTY_PRINT).
 *
 * Only db/dd_ontology.ts, db/matrix*.ts, resolver.ts, resolve/component_data,
 * the pure machine_name.ts kernel and the api/counters rung counters are called here — plus one direct read-only jsonb probe for the overwrite scan
 * (a related-search that no matrix helper expresses), parameterized + tipo-gated.
 *
 * LEDGER: the request_config validate-on-save warning (PHP :1973, non-blocking)
 * is not reproduced — it only logs; it never changes the parsed node.
 */

import { incrementCounter } from '../api/counters.ts';
import { isValidTipo } from '../concepts/ontology.ts';
import {
	type DdOntologyNode,
	ddOntologyIdentifierViolations,
	readDdOntologyRow,
} from '../db/dd_ontology.ts';
import { type MatrixRecord, readMatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { readComponentItems } from '../resolve/component_data.ts';
import {
	isNameClassNode,
	LEGACY_NAME_LANG,
	type MachineNameDefect,
	type MachineNameInput,
	type MachineNameProjection,
	modelNameOf,
	projectMachineName,
	type TermItem,
} from './machine_name.ts';
import {
	ONTOLOGY_CONNECTED_TO,
	ONTOLOGY_CSS,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_MAIN_SECTION,
	ONTOLOGY_MODEL,
	ONTOLOGY_ORDER,
	ONTOLOGY_OVERWRITE,
	ONTOLOGY_PARENT,
	ONTOLOGY_PROPERTIES,
	ONTOLOGY_PROPIEDADES_V5,
	ONTOLOGY_SOURCE,
	ONTOLOGY_TERM,
	ONTOLOGY_TLD,
	ONTOLOGY_TRANSLATABLE,
	ONTOLOGY_USE_MACHINE_NAME,
	SI_NO_YES,
} from './ontology_tipos.ts';
import { getMatrixTableFromTipo, getModelByTipo } from './resolver.ts';
import { getTldFromTipo, LOCAL_ONTOLOGY_SECTION } from './tld.ts';

/**
 * A stored relation locator (parent, model, connected-to).
 *
 * KEPT UNION (WC-2026-08-10-section-id-int-canonical): these come off the
 * ontology records' RAW jsonb relation column — pre-sweep installs still hold
 * the string form, and the id is only ever consumed as text (`<tld><id>` term
 * ids) or through a tolerant Number(), never re-persisted as an address.
 */
interface Locator {
	section_tipo?: string;
	section_id?: string | number;
	[extra: string]: unknown;
}

/**
 * The models the machine-name contract fixes for ontology43/44 — the READ fallback
 * while their own dd_ontology rows do not resolve yet. Without it the derive is
 * circular on the update that FIRST brings them: dd (staged before the ontology tld)
 * is parsed while getModelByTipo('ontology43') is null, so a converted model
 * definition (lg-spa moved out of ontology5, D16) derives no machine_name, every
 * instance's `model` goes NULL — and ontology43's own row then takes its model
 * from that NULL name, keeping the read dead for good. A fallback ONLY: a defined
 * row wins, and arming (machine_name_save / machine_name_reconcile) still asks
 * getModelByTipo, so this never arms the save rules or the converter. On a release
 * without the components the records carry no such keys and the read stays empty.
 * Gate: machine_name_native (first-arrival leg).
 */
const MACHINE_NAME_CONTRACT_MODELS: Readonly<Record<string, string>> = {
	[ONTOLOGY_MACHINE_NAME]: 'component_input_text',
	[ONTOLOGY_USE_MACHINE_NAME]: 'component_radio_button',
};

/**
 * Read the raw items of one component off a matrix record (PHP
 * get_node_component_data). Resolves the component's model from the ontology,
 * then reads its slice of the typed jsonb column. Returns null when absent/empty
 * (PHP `empty()`), so the `?? ` fallbacks below behave like PHP's.
 */
async function getComponentItems(
	record: MatrixRecord | null,
	componentTipo: string,
): Promise<unknown[] | null> {
	if (record === null) return null;
	const model =
		(await getModelByTipo(componentTipo)) ?? MACHINE_NAME_CONTRACT_MODELS[componentTipo] ?? null;
	if (model === null) return null;
	const items = readComponentItems(record, componentTipo, model);
	return items !== null && items.length > 0 ? items : null;
}

/**
 * PHP get_overwrite (:3268): find the localontology0 record that OVERRIDES this
 * node, or null. Returns null for: localontology0 itself; a node whose CANONICAL
 * record says is_model (models are never overridden); no matching override.
 *
 * The link is ONE component, ONTOLOGY_OVERWRITE (ontology42). PHP matched a
 * locator in ANY relation of the local record, so an override's own parent
 * (ontology15) or relations (ontology10) made it the override of THAT node too —
 * measured: the parent node took the override's term and became its own parent
 * (WC-2026-10-01-ontology-overwrite-scoped). Model protection reads the canonical
 * record's ontology30, not dd_ontology: a model node not yet projected would
 * otherwise be overridable on its first parse. Several overrides of one node →
 * the lowest section_id wins (deterministic; PHP's LIMIT 1 had no order).
 */
export async function getOverwriteLocator(
	sectionTipo: string,
	sectionId: number | string,
	canonicalRecord?: MatrixRecord | null,
): Promise<Locator | null> {
	if (sectionTipo === LOCAL_ONTOLOGY_SECTION) {
		return null;
	}
	// Model protection: an existing model node is never overwritten.
	let record = canonicalRecord;
	if (record === undefined) {
		const table = await getMatrixTableFromTipo(sectionTipo);
		record = table === null ? null : await readMatrixRecord(table, sectionTipo, Number(sectionId));
	}
	if (isYesLocator(await getComponentItems(record, ONTOLOGY_IS_MODEL))) {
		return null;
	}
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "matrix_ontology"
		 WHERE section_tipo = $1
		   AND EXISTS (
		       SELECT 1
		       FROM jsonb_array_elements(
		            CASE WHEN jsonb_typeof(relation->$4) = 'array' THEN relation->$4 ELSE '[]'::jsonb END
		       ) AS loc
		       WHERE loc->>'section_tipo' = $2 AND loc->>'section_id' = $3
		   )
		 ORDER BY section_id ASC
		 LIMIT 1`,
		[LOCAL_ONTOLOGY_SECTION, sectionTipo, String(sectionId), ONTOLOGY_OVERWRITE],
	)) as { section_id: number }[];
	const row = rows[0];
	if (row === undefined) {
		return null;
	}
	return { section_tipo: LOCAL_ONTOLOGY_SECTION, section_id: Number(row.section_id) };
}

/** True for a plain JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The properties one record STATES; `undefined` = the component is empty. */
interface PropertySet {
	/** ontology18's keys (a non-object value states nothing). */
	keys: Record<string, unknown>;
	css: unknown;
	source: unknown;
}

async function readPropertySet(record: MatrixRecord | null): Promise<PropertySet> {
	const firstValue = async (tipo: string): Promise<unknown> =>
		((await getComponentItems(record, tipo))?.[0] as { value?: unknown } | undefined)?.value;
	const keys = await firstValue(ONTOLOGY_PROPERTIES);
	return {
		keys: isPlainObject(keys) ? { ...keys } : {},
		css: await firstValue(ONTOLOGY_CSS),
		source: await firstValue(ONTOLOGY_SOURCE),
	};
}

/**
 * PHP get_term_id_from_locator (:2207): the locator's canonical term-id
 * (`<tld><section_id>`). Fast path: TLD from the section_tipo string. Slow
 * fallback (rare — section_tipo not in `<tld>0` form): read ontology7 off the
 * pointed record. Null when the TLD cannot be resolved — AND (SURF-1) when the
 * composed reference is not a tipo (`isValidTipo`): the same "unresolvable
 * reference → null" rule, extended to a section_id like `'5a'` or `'1 OR'`,
 * which used to compose into `zzm5a` / `zzgs1 OR` and be projected into
 * dd_ontology as an identifier.
 */
export async function getTermIdFromLocator(locator: Locator): Promise<string | null> {
	const composed = await composeTermIdFromLocator(locator);
	return composed !== null && isValidTipo(composed) ? composed : null;
}

/**
 * The raw `<tld><section_id>` a locator composes to, BEFORE the grammar check —
 * the parser needs the raw value to REPORT a defective reference (SURF-1);
 * every other caller wants getTermIdFromLocator's checked answer.
 */
async function composeTermIdFromLocator(locator: Locator): Promise<string | null> {
	const sectionTipo = String(locator.section_tipo ?? '');
	const sectionId = locator.section_id;
	if (sectionId === undefined || sectionId === null) return null;

	let tld = getTldFromTipo(sectionTipo);
	if (tld === null || tld === '') {
		// Slow fallback: read the tld component off the pointed record.
		const table = await getMatrixTableFromTipo(sectionTipo);
		if (table === null) return null;
		const record = await readMatrixRecord(table, sectionTipo, Number(sectionId));
		const items = await getComponentItems(record, ONTOLOGY_TLD);
		const value = (items?.[0] as { value?: unknown } | undefined)?.value;
		if (value === undefined || value === null || value === '') return null;
		tld = String(value);
	}
	return `${tld}${sectionId}`;
}

/** True when a stored radio-button locator points at the si/no "yes" record (dd64/1). */
function isYesLocator(items: unknown[] | null): boolean {
	const first = items?.[0] as Locator | undefined;
	if (first === undefined) return false;
	return Number(first.section_id) === SI_NO_YES;
}

/**
 * The node's properties: canonical ontology18 keys + .css (ontology16) +
 * .source (ontology17). Override: the TOP-LEVEL KEY is the unit. Each key the
 * override states replaces the canonical key WHOLE (no deep merge — css
 * included); unstated keys are kept; a key stated as `null` in the override's
 * ontology18 REMOVES it. Removing css/source in ontology18 while filling
 * ontology16/17 is a contradiction: refused, never resolved by picking a winner.
 */
async function resolveProperties(
	canonicalRecord: MatrixRecord | null,
	overwriteRecord: MatrixRecord | null,
	at: { sectionTipo: string; sectionId: number | string; overrideLabel: string },
): Promise<Record<string, unknown>> {
	const canonicalSet = await readPropertySet(canonicalRecord);
	const properties: Record<string, unknown> = { ...canonicalSet.keys };
	if (canonicalSet.css !== undefined) properties.css = canonicalSet.css;
	if (canonicalSet.source !== undefined) properties.source = canonicalSet.source;
	if (overwriteRecord === null) return properties;
	const stated = statedOverrideKeys(await readPropertySet(overwriteRecord), at);
	for (const [key, value] of Object.entries(stated)) {
		if (value === null) delete properties[key];
		else properties[key] = value;
	}
	return properties;
}

/** The top-level keys an override states (ontology18 + its css/source), `null` = remove. */
function statedOverrideKeys(
	overwriteSet: PropertySet,
	at: { sectionTipo: string; sectionId: number | string; overrideLabel: string },
): Record<string, unknown> {
	const stated: Record<string, unknown> = { ...overwriteSet.keys };
	for (const [key, value] of [
		['css', overwriteSet.css],
		['source', overwriteSet.source],
	] as const) {
		if (value === undefined) continue;
		if (stated[key] === null) {
			throw new DedaloError('ontology.invalid_node', {
				message: `parseSectionRecordToOntologyNode: override ${at.overrideLabel} of ${at.sectionTipo}/${at.sectionId} both removes '${key}' (null in ${ONTOLOGY_PROPERTIES}) and fills it (${key === 'css' ? ONTOLOGY_CSS : ONTOLOGY_SOURCE})`,
				coordinates: { section_tipo: at.sectionTipo, section_id: at.sectionId },
			});
		}
		stated[key] = value;
	}
	return stated;
}

/** A record's ontology term, keyed by lang (null = no term component). */
async function readTerm(record: MatrixRecord | null): Promise<Record<string, string> | null> {
	const items = await getComponentItems(record, ONTOLOGY_TERM);
	if (items === null) return null;
	const term: Record<string, string> = {};
	for (const item of items) {
		const literal = item as { lang?: string; value?: unknown };
		if (typeof literal.lang === 'string') {
			term[literal.lang] = String(literal.value ?? '');
		}
	}
	return term;
}

/**
 * The node's term, MERGED per lang with an override: a lang the override fills
 * wins, every other lang keeps the canonical value (an override naming only
 * lg-spa must not erase the node's other translations). Empty values in the
 * override do not count as filled.
 */
async function resolveMergedTerm(
	canonicalRecord: MatrixRecord | null,
	overwriteRecord: MatrixRecord | null,
): Promise<Record<string, string> | null> {
	const term = await readTerm(canonicalRecord);
	const overwriteTerm = overwriteRecord === null ? null : await readTerm(overwriteRecord);
	if (overwriteTerm === null) return term;
	const filled = Object.fromEntries(
		Object.entries(overwriteTerm).filter(([, value]) => value !== ''),
	);
	return Object.keys(filled).length > 0 ? { ...(term ?? {}), ...filled } : term;
}

/** A record's raw ontology5 items (several per lang are kept — ontology5 is multi_value). */
async function readTermItems(record: MatrixRecord | null): Promise<TermItem[]> {
	const items = await getComponentItems(record, ONTOLOGY_TERM);
	const out: TermItem[] = [];
	for (const item of items ?? []) {
		const literal = item as { lang?: string; value?: unknown };
		if (typeof literal.lang === 'string') {
			out.push({ lang: literal.lang, value: String(literal.value ?? '') });
		}
	}
	return out;
}

/**
 * The EFFECTIVE ontology5 items the machine-name rungs read: the per-lang merge
 * resolveMergedTerm applies to `term` (a lang the override fills with a
 * non-empty value replaces the canonical items of that lang; every other lang
 * keeps its canonical items), but keeping every item, so several lg-spa items
 * read as the collision they are instead of the last one winning.
 */
async function resolveEffectiveTermItems(
	canonicalRecord: MatrixRecord | null,
	overwriteRecord: MatrixRecord | null,
): Promise<TermItem[]> {
	const canonical = await readTermItems(canonicalRecord);
	if (overwriteRecord === null) return canonical;
	const filled = (await readTermItems(overwriteRecord)).filter((item) => item.value !== '');
	const filledLangs = new Set(filled.map((item) => item.lang));
	return [...canonical.filter((item) => !filledLangs.has(item.lang)), ...filled];
}

/** The string values of a literal component (ontology43), or null when it is empty. */
function literalValues(items: unknown[] | null): string[] | null {
	if (items === null) return null;
	const values = items
		.map((item) => (item as { value?: unknown } | null)?.value)
		.filter(
			(value): value is string | number => typeof value === 'string' || typeof value === 'number',
		)
		.map(String);
	return values.length > 0 ? values : null;
}

/** A stored si/no flag: true (dd64/1), false (any other locator), null (component empty). */
function flagOf(items: unknown[] | null): boolean | null {
	return items === null ? null : isYesLocator(items);
}

/**
 * An unconverted override's legacy rename (kernel `overrideLegacyName`): its own
 * non-empty lg-spa ontology5 values when it states no ontology43, else null. An
 * override stating ontology43 renames through `resolved` (it REPLACES) instead.
 */
async function readOverrideLegacyName(
	overwriteRecord: MatrixRecord | null,
): Promise<string[] | null> {
	if (overwriteRecord === null) return null;
	if (literalValues(await getComponentItems(overwriteRecord, ONTOLOGY_MACHINE_NAME)) !== null) {
		return null;
	}
	const spa = (await readTermItems(overwriteRecord))
		.filter((item) => item.lang === LEGACY_NAME_LANG && item.value !== '')
		.map((item) => item.value);
	return spa.length > 0 ? spa : null;
}

/**
 * The machine-name kernel's input for one node, read off its source record(s):
 * ontology43 override-resolved (an override's name REPLACES the canonical one,
 * no per-lang merge), ontology44 canonical-only (the override's own value is
 * passed only to be reported if it differs), the effective ontology5 items.
 * On an ontology release without ontology43/44 (getModelByTipo null) they are
 * still read, under the contract models (MACHINE_NAME_CONTRACT_MODELS): a record
 * that carries no such key reads as empty, so only the legacy rungs fire — the
 * transition is a data-free deploy — and converted records arriving with the
 * definitions are read before those definitions' own rows are derived.
 */
async function readMachineNameInput(
	canonicalRecord: MatrixRecord | null,
	overwriteRecord: MatrixRecord | null,
	resolved: ResolvedItems,
	classFields: Parameters<typeof isNameClassNode>[0],
): Promise<MachineNameInput> {
	return {
		componentValues: literalValues(await resolved(ONTOLOGY_MACHINE_NAME)),
		overrideLegacyName: await readOverrideLegacyName(overwriteRecord),
		canonicalFlag: flagOf(await getComponentItems(canonicalRecord, ONTOLOGY_USE_MACHINE_NAME)),
		overrideFlag:
			overwriteRecord === null
				? null
				: flagOf(await getComponentItems(overwriteRecord, ONTOLOGY_USE_MACHINE_NAME)),
		termItems: await resolveEffectiveTermItems(canonicalRecord, overwriteRecord),
		nameClass: isNameClassNode(classFields),
	};
}

/**
 * `model_unresolved` when the node names a model (model_tipo) whose name
 * resolves to nothing — the model node has no machine name (or no row). The
 * post-upgrade verification (plan §6b): a model NULL there sends the node's
 * data to the wrong matrix table, so it is reported, never silent.
 */
export function modelResolutionDefects(
	modelTipo: string | null,
	model: string | null,
): MachineNameDefect[] {
	return modelTipo !== null && model === null
		? [{ kind: 'model_unresolved', values: [modelTipo] }]
		: [];
}

/** Count the legacy rungs one derivation used (G6 watches them reach zero). */
export function countMachineNameRungs(projection: MachineNameProjection): void {
	for (const rung of projection.rungs) incrementCounter(`ontology_machine_name_rung_${rung}`);
}

/**
 * A reference the parser composed from a source record but could NOT project:
 * it breaks the dd_ontology identifier grammar (db/dd_ontology.ts
 * ddOntologyIdentifierViolations — a non-tipo, or longer than its column). The
 * node is still parsed; the defective value is dropped from it (`parent` /
 * `model_tipo` → null, a `relations` entry skipped, `properties.alias_of`
 * deleted — the alias reader then refuses the node as `missing`), and the
 * defect is REPORTED by the caller, never swallowed.
 */
export interface OntologyNodeDefect {
	column: 'parent' | 'model_tipo' | 'relations' | 'alias_of';
	/** The raw value as the record composed it. */
	value: unknown;
}

/** A parsed node plus the references it could not carry (see OntologyNodeDefect). */
export interface ParsedOntologyNode {
	node: DdOntologyNode | null;
	defects: OntologyNodeDefect[];
	/** Machine-name findings of the node (ontology/machine_name.ts MachineNameDefectKind). */
	machineNameDefects: MachineNameDefect[];
	/**
	 * The kernel input the node's machine-name columns were derived from — kept so
	 * a whole-tld rebuild can RE-derive them once the model fixpoint
	 * (ontology_state.ts resolveModelsAgainstParse) changes the node's model, and
	 * with it its classification. Null when there is no node.
	 */
	machineNameInput: MachineNameInput | null;
	/** The legacy rungs the derivation used (counted; empty = explicit data). */
	machineNameRungs: MachineNameProjection['rungs'];
}

/**
 * Parse one section record into a DdOntologyNode (or null when the record is not
 * a valid node — PHP returns null when the mandatory TLD is missing). Every
 * defect is logged, one warning each; a caller that REPORTS them (the rebuild,
 * ontology_state.ts) uses parseSectionRecordToOntologyNodeWithDefects instead.
 */
export async function parseSectionRecordToOntologyNode(
	sectionTipo: string,
	sectionId: number | string,
): Promise<DdOntologyNode | null> {
	const { node, defects, machineNameDefects } = await parseSectionRecordToOntologyNodeWithDefects(
		sectionTipo,
		sectionId,
	);
	for (const defect of defects) {
		console.warn(
			`[ontology_parser] ${sectionTipo}/${sectionId}: ${defect.column} ${(JSON.stringify(defect.value) ?? '').slice(0, 64)} is not a valid identifier — dropped from node ${JSON.stringify(node?.tipo ?? null)} (SURF-1; fix the source record)`,
		);
	}
	warnMachineNameDefects(`${sectionTipo}/${sectionId}`, node?.tipo ?? null, machineNameDefects);
	return node;
}

/** One warning per machine-name finding of a single-record parse (the rebuild REPORTS them instead). */
function warnMachineNameDefects(
	source: string,
	tipo: string | null,
	defects: readonly MachineNameDefect[],
): void {
	for (const defect of defects) {
		const values =
			defect.values === undefined ? '' : ` ${(JSON.stringify(defect.values) ?? '').slice(0, 96)}`;
		console.warn(
			`[ontology_parser] ${source}: machine name ${defect.kind}${values} on node ${JSON.stringify(tipo)} (fix the source record's ${ONTOLOGY_MACHINE_NAME} / ${ONTOLOGY_USE_MACHINE_NAME})`,
		);
	}
}

/** The identifier-grammar verdict of one reference value for its dd_ontology column. */
function referenceIsValid(column: 'parent' | 'model_tipo', value: string): boolean {
	return ddOntologyIdentifierViolations({ tipo: 'dd1', [column]: value }).length === 0;
}

/** Overwrite-aware component items of the record being parsed. */
type ResolvedItems = (componentTipo: string) => Promise<unknown[] | null>;

/** A composed reference, or null + a defect when it breaks its column's grammar. */
async function projectReference(
	column: 'parent' | 'model_tipo',
	locator: Locator,
	defects: OntologyNodeDefect[],
): Promise<string | null> {
	const composed = await composeTermIdFromLocator(locator);
	if (composed === null || referenceIsValid(column, composed)) return composed;
	defects.push({ column, value: composed });
	return null;
}

/** One related-term entry: null when it composes to nothing, or (a defect) when it breaks the tipo grammar. */
async function projectRelation(
	locator: Locator,
	defects: OntologyNodeDefect[],
): Promise<{ tipo: string } | null> {
	const relTermId = await composeTermIdFromLocator(locator);
	if (relTermId === null || relTermId === '') return null;
	if (isValidTipo(relTermId)) return { tipo: relTermId };
	defects.push({ column: 'relations', value: relTermId });
	return null;
}

/** The node's parent: null at the ontology main section, or when invalid (a defect). */
async function projectParent(
	resolved: ResolvedItems,
	defects: OntologyNodeDefect[],
): Promise<string | null> {
	const parentLocator = (await resolved(ONTOLOGY_PARENT))?.[0] as Locator | undefined;
	if (parentLocator === undefined || parentLocator.section_tipo === ONTOLOGY_MAIN_SECTION) {
		return null;
	}
	return projectReference('parent', parentLocator, defects);
}

/**
 * model_tipo + model (= the STORED model row's machine_name; bridge rung for a
 * row not yet derived: its term['lg-spa'], STRICT — machine_name.ts modelNameOf,
 * counted as `legacy_model_term`).
 */
async function projectModel(
	resolved: ResolvedItems,
	defects: OntologyNodeDefect[],
): Promise<{ modelTipo: string | null; model: string | null }> {
	const modelLocator = (await resolved(ONTOLOGY_MODEL))?.[0] as Locator | undefined;
	if (modelLocator === undefined) return { modelTipo: null, model: null };
	const modelTipo = await projectReference('model_tipo', modelLocator, defects);
	if (modelTipo === null) return { modelTipo, model: null };
	const { model, legacy } = modelNameOf(await readDdOntologyRow(modelTipo));
	if (legacy) incrementCounter('ontology_machine_name_rung_legacy_model_term');
	return { modelTipo, model };
}

/**
 * The properties column (empty → null). properties.alias_of is an identifier too
 * (the alias reader, the search re-key): a defective one is dropped, never projected.
 */
function projectProperties(
	properties: Record<string, unknown>,
	defects: OntologyNodeDefect[],
): Record<string, unknown> | null {
	let projected = properties;
	if (
		Object.hasOwn(properties, 'alias_of') &&
		ddOntologyIdentifierViolations({ tipo: 'dd1', properties }).length > 0
	) {
		defects.push({ column: 'alias_of', value: properties.alias_of });
		const { alias_of: _defective, ...rest } = properties;
		projected = rest;
	}
	return Object.keys(projected).length === 0 ? null : projected;
}

/**
 * parseSectionRecordToOntologyNode, returning the defects instead of logging
 * them (SURF-1 W5). The node never carries a reference that breaks the
 * identifier grammar — see OntologyNodeDefect.
 */
export async function parseSectionRecordToOntologyNodeWithDefects(
	sectionTipo: string,
	sectionId: number | string,
): Promise<ParsedOntologyNode> {
	// An override record is not a node: its tipo would be `<its tld><its own id>`,
	// a canonical-looking node that does not exist (measured: localontology0/1 →
	// `localontology1`). Its data reaches dd_ontology only through the node it
	// overrides. Callers skip the section (ontology_state, setRecordsInDdOntology);
	// this is the backstop.
	if (sectionTipo === LOCAL_ONTOLOGY_SECTION) {
		throw new DedaloError('ontology.invalid_node', {
			message: `parseSectionRecordToOntologyNode: '${LOCAL_ONTOLOGY_SECTION}/${sectionId}' is an override record, not a node — parse the node it overrides (${ONTOLOGY_OVERWRITE}) instead`,
			coordinates: { section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	const defects: OntologyNodeDefect[] = [];
	const noNode = (): ParsedOntologyNode => ({
		node: null,
		defects,
		machineNameDefects: [],
		machineNameInput: null,
		machineNameRungs: [],
	});
	// canonical record
	const canonicalTable = await getMatrixTableFromTipo(sectionTipo);
	const canonicalRecord =
		canonicalTable === null
			? null
			: await readMatrixRecord(canonicalTable, sectionTipo, Number(sectionId));

	// overwrite record (localontology0 override, when present)
	const overwriteLocator = await getOverwriteLocator(sectionTipo, sectionId, canonicalRecord);
	let overwriteRecord: MatrixRecord | null = null;
	if (overwriteLocator !== null) {
		const overwriteTable = await getMatrixTableFromTipo(String(overwriteLocator.section_tipo));
		overwriteRecord =
			overwriteTable === null
				? null
				: await readMatrixRecord(
						overwriteTable,
						String(overwriteLocator.section_tipo),
						Number(overwriteLocator.section_id),
					);
	}

	/** overwrite items ?? canonical items (PHP $get_resolved_data). */
	const resolved = async (componentTipo: string): Promise<unknown[] | null> => {
		if (overwriteRecord !== null) {
			const fromOverwrite = await getComponentItems(overwriteRecord, componentTipo);
			if (fromOverwrite !== null) return fromOverwrite;
		}
		return getComponentItems(canonicalRecord, componentTipo);
	};

	// TLD (mandatory) — CANONICAL ONLY. The tld IS the node's identity
	// (`<tld><section_id>`); an override's own ontology7 (`localontology` by the
	// create-door default) would re-home the node into another namespace.
	const tldItems = await getComponentItems(canonicalRecord, ONTOLOGY_TLD);
	if (tldItems === null) {
		return noNode(); // PHP: ignore record — TLD is mandatory.
	}
	const tld = String((tldItems[0] as { value?: unknown }).value ?? '');
	if (tld === '') {
		return noNode();
	}
	const tipo = `${tld}${sectionId}`;

	// Parent — null iff the parent locator points at the ontology main section.
	const parent = await projectParent(resolved, defects);

	// is_model — CANONICAL ONLY (never overwrite-aware).
	const isModelItems = await getComponentItems(canonicalRecord, ONTOLOGY_IS_MODEL);
	const isModel = isYesLocator(isModelItems);

	// Model — overwrite-aware; model = dd_ontology(model_tipo).machine_name (projectModel).
	const { modelTipo, model } = await projectModel(resolved, defects);

	// Order — canonical only, (int) cast, empty → null.
	let orderNumber: number | null = null;
	const orderItems = await getComponentItems(canonicalRecord, ONTOLOGY_ORDER);
	const orderValue = (orderItems?.[0] as { value?: unknown } | undefined)?.value;
	if (orderValue !== undefined && orderValue !== null && orderValue !== '') {
		orderNumber = Math.trunc(Number(orderValue));
	}

	// Translatable — default TRUE when missing. CANONICAL ONLY: it fixes how the
	// component's data is STORED (per lang vs lg-nolan), so a local flip would
	// orphan existing values. (PHP read the override, whose create-door default
	// is YES — every override silently made its node translatable.)
	const translatableItems = await getComponentItems(canonicalRecord, ONTOLOGY_TRANSLATABLE);
	const isTranslatable = translatableItems === null ? true : isYesLocator(translatableItems);

	// is_main
	const isMain = tipo === `${tld}0`;

	// Relations — overwrite-aware, but overwrite only overrides when it HAS them.
	const resolveRelations = async (
		record: MatrixRecord | null,
	): Promise<{ tipo: string }[] | null> => {
		const items = await getComponentItems(record, ONTOLOGY_CONNECTED_TO);
		if (items === null) return null;
		const relations: { tipo: string }[] = [];
		for (const item of items) {
			const relation = await projectRelation(item as Locator, defects);
			if (relation !== null) relations.push(relation);
		}
		return relations.length > 0 ? relations : null;
	};
	let relations = overwriteRecord !== null ? await resolveRelations(overwriteRecord) : null;
	relations = relations ?? (await resolveRelations(canonicalRecord));

	// Propiedades (v5 legacy) — pretty-printed TEXT, empty → null.
	let propiedades: string | null = null;
	const propV5Items = await resolved(ONTOLOGY_PROPIEDADES_V5);
	const propV5Value = (propV5Items?.[0] as { value?: unknown } | undefined)?.value;
	if (propV5Value !== undefined && propV5Value !== null && propV5Value !== '') {
		propiedades = phpPrettyJsonEncode(propV5Value);
	}

	// Properties (ontology18) + .css (ontology16) + .source (ontology17), empty→null.
	const properties = await resolveProperties(canonicalRecord, overwriteRecord, {
		sectionTipo,
		sectionId,
		overrideLabel: `${String(overwriteLocator?.section_tipo)}/${String(overwriteLocator?.section_id)}`,
	});
	const propertiesOrNull = projectProperties(properties, defects);

	// Term — all langs, merged per lang with an override (resolveMergedTerm).
	const term = await resolveMergedTerm(canonicalRecord, overwriteRecord);

	// Machine name + flag (ontology43/44) — the kernel in machine_name.ts. The
	// classification reads the CANONICAL is_model/tld and the MERGED model (an
	// override record is classified by the model it resolves to, plan §5).
	const machineNameInput = await readMachineNameInput(canonicalRecord, overwriteRecord, resolved, {
		tipo,
		tld,
		is_model: isModel,
		model_tipo: modelTipo,
		model,
	});
	const machineName = projectMachineName(machineNameInput);
	countMachineNameRungs(machineName);
	const machineNameDefects = [...machineName.defects, ...modelResolutionDefects(modelTipo, model)];

	const node: DdOntologyNode = {
		tipo,
		parent,
		term,
		model,
		order_number: orderNumber,
		relations,
		tld,
		properties: propertiesOrNull,
		model_tipo: modelTipo,
		is_model: isModel,
		is_translatable: isTranslatable,
		is_main: isMain,
		propiedades,
		machine_name: machineName.machine_name,
		use_machine_name: machineName.use_machine_name,
	};
	return {
		node,
		defects,
		machineNameDefects,
		machineNameInput,
		machineNameRungs: machineName.rungs,
	};
}

/**
 * Encode a value byte-identically to PHP `json_encode($v, JSON_PRETTY_PRINT)`
 * (used for the dd_ontology.propiedades TEXT column). PHP's default flags — with
 * ONLY JSON_PRETTY_PRINT set — escape forward slashes (`\/`) and all non-ASCII
 * as `\uXXXX`, indent 4 spaces, and put `": "` after object keys. Empty
 * object/array render as `{}` / `[]`.
 *
 * LEDGER: float formatting uses JS default (`String(n)`); a PHP `x.0` float would
 * differ, but v5 propiedades are legacy string/object blobs — no floats observed.
 */
export function phpPrettyJsonEncode(value: unknown): string {
	return encodePretty(value, 0);
}

function encodePretty(value: unknown, depth: number): string {
	if (value === null || value === undefined) return 'null';
	switch (typeof value) {
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			return Number.isFinite(value) ? String(value) : 'null';
		case 'string':
			return encodePhpJsonString(value);
		case 'object': {
			const indent = '    '.repeat(depth + 1);
			const closeIndent = '    '.repeat(depth);
			if (Array.isArray(value)) {
				if (value.length === 0) return '[]';
				const parts = value.map((item) => indent + encodePretty(item, depth + 1));
				return `[\n${parts.join(',\n')}\n${closeIndent}]`;
			}
			const entries = Object.entries(value as Record<string, unknown>).filter(
				([, entry]) => entry !== undefined,
			);
			if (entries.length === 0) return '{}';
			const parts = entries.map(
				([key, entry]) => `${indent}${encodePhpJsonString(key)}: ${encodePretty(entry, depth + 1)}`,
			);
			return `{\n${parts.join(',\n')}\n${closeIndent}}`;
		}
		default:
			return 'null';
	}
}

/** PHP json_encode string escaping (default flags): escapes ", \, /, controls, non-ASCII. */
function encodePhpJsonString(text: string): string {
	let out = '"';
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		const char = text[index] as string;
		switch (char) {
			case '"':
				out += '\\"';
				break;
			case '\\':
				out += '\\\\';
				break;
			case '/':
				out += '\\/';
				break;
			case '\b':
				out += '\\b';
				break;
			case '\f':
				out += '\\f';
				break;
			case '\n':
				out += '\\n';
				break;
			case '\r':
				out += '\\r';
				break;
			case '\t':
				out += '\\t';
				break;
			default:
				if (code < 0x20 || code >= 0x80) {
					out += `\\u${code.toString(16).padStart(4, '0')}`;
				} else {
					out += char;
				}
		}
	}
	return `${out}"`;
}
