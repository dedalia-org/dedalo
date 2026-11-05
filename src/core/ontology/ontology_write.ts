/**
 * Ontology write drivers — PHP ontology:: {insert_dd_ontology_record :2355,
 * set_records_in_dd_ontology :2502, regenerate_records_in_dd_ontology :2655,
 * sync_order_to_dd_ontology :2411, create_dd_ontology_ontology_section_node
 * :1042 (createDdOntologyRootNode), create_parent_grouper :1154,
 * add_main_section :809 — split into createMainSection /
 * syncMainSectionFromDefinition / ensureMainSection by the registry-row law,
 * get_main_* :2846}.
 *
 * These orchestrate the definition→runtime pipeline: they read matrix_ontology /
 * matrix_ontology_main records, (re)build the derived dd_ontology rows via the
 * parser + db/dd_ontology.ts write layer, and (for provisioning) write the
 * source matrix records that back a TLD's `<tld>0` main section, its groupers
 * and typology nodes. All jsonb/matrix I/O goes through db/matrix*.ts +
 * db/dd_ontology.ts + create_record.ts — no raw SQL here except a handful of
 * read-only existence/probe queries (parameterized, fixed-identifier) that no
 * helper expresses.
 *
 * TRANSACTIONS: setRecords is partial-success (each record independent — PHP does
 * not wrap it). The whole-tld writers (rebuild, retract, registry activation)
 * live in ontology_state.ts, each ONE transaction; the PHP regenerate and its
 * backup-table protocol are retired.
 *
 * THE PROJECTION GUARD (ONT-2): every per-record dd_ontology write here goes
 * through section_record/ontology_projection.ts — a governed record `<tld>0/<id>`
 * projects the node `<tld><id>` or nothing (a record whose ontology7 names another
 * tld is refused, `ontology.invalid_node`), and a section no tld governs is not an
 * ontology node section at all.
 *
 * LEDGER / divergences (per no-silent-narrowing):
 *  - setRecords LIST mode takes an EXPLICIT id list (the tool resolves the
 *    request's SQO; WC-043) — PHP read the session SQO, which TS keeps no twin of.
 */

import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import {
	type DdOntologyNode,
	lockOntologyRegistryMint,
	readDdOntologyRow,
	updateDdOntologyColumns,
	upsertDdOntologyNode,
} from '../db/dd_ontology.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { updateMatrixKeyData } from '../db/matrix_write.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getLangSectionIdByCode } from '../relations/select_lang.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import {
	ForeignOntologyNodeRefused,
	ontologyNodeAddress,
	projectOntologyNode,
} from '../section_record/ontology_projection.ts';
import { isCoreOntologyTld } from './core_tlds.ts';
import { ONTOLOGY_LABEL_FALLBACK_LANG } from './labels.ts';
import {
	dependenciesMiscItems,
	normalizeOntologyDependencies,
	type OntologyDependency,
} from './ontology_dependencies.ts';
import {
	DATA_NOLAN,
	HIERARCHY_ACTIVE,
	HIERARCHY_ACTIVE_IN_THESAURUS,
	HIERARCHY_DEPENDENCIES,
	HIERARCHY_FILTER,
	HIERARCHY_GENERAL_TERM,
	HIERARCHY_LANG,
	HIERARCHY_MODEL_TYPE_GROUP,
	HIERARCHY_MODEL_TYPE_TLD,
	HIERARCHY_TARGET_SECTION,
	HIERARCHY_TERM,
	HIERARCHY_TLD,
	HIERARCHY_TYPE_GROUP,
	HIERARCHY_TYPE_TLD,
	HIERARCHY_TYPES_NAME,
	HIERARCHY_TYPES_SECTION,
	HIERARCHY_TYPOLOGY,
	ONTOLOGY_IS_DESCRIPTOR,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MAIN_SECTION,
	ONTOLOGY_MODEL,
	ONTOLOGY_PARENT,
	ONTOLOGY_PUBLICATION,
	ONTOLOGY_TERM,
	ONTOLOGY_TLD,
	ONTOLOGY_TRANSLATABLE,
	ONTOLOGY_TYPE_GROUP,
	ONTOLOGY_TYPE_TLD,
	PROJECTS_SECTION,
	REGISTRY_LANG,
	RELATION_TYPE_CHILDREN,
	RELATION_TYPE_LINK,
	RELATION_TYPE_PARENT,
	SECTION_MODEL_TIPO,
	SI_NO_NO,
	SI_NO_YES,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import { getTermIdFromLocator } from './parser.ts';
import { type ReleaseTldDefinition, releaseTldDefinition } from './release_definition.ts';
import { getMatrixTableFromTipo } from './resolver.ts';
import {
	getSectionIdFromTipo,
	getTldFromTipo,
	LOCAL_ONTOLOGY_SECTION,
	mapTldToTargetSectionTipo,
	requiredOntologyTld,
	safeTld,
} from './tld.ts';

const RELATION_TYPE_FILTER = 'dd675'; // DEDALO_RELATION_TYPE_FILTER
const LANG_SECTION = 'lg1';

/** Standard write outcome (INTERNAL — `ok` is the discriminator, never a wire body). */
export interface OntologyWriteResponse {
	ok: boolean;
	msg: string;
	errors: string[];
	total?: number;
	processed_count?: number;
	total_insert?: number;
}

// --- small item builders (byte-shape helpers) --------------------------------

/**
 * A stored relation locator. WC-2026-08-10-section-id-int-canonical repeals the
 * former "section_id is always a STRING in the matrix" law: this writer mints
 * the CANONICAL INT form. Canonicalization rather than Number(): whatever is
 * not a record address (an external remote id, the `''` of an unresolved
 * parent) is stored verbatim instead of being cast into a wrong address.
 *
 * The dd_ontology relations this builder feeds carried ZERO stored section_ids
 * at the census, so no stored bytes flip here — the rule is stated for what
 * this writer produces from now on.
 */
function relationLocator(fields: {
	id?: number;
	type: string;
	section_tipo: string;
	// KEPT UNION: same door as hierarchy_provision.relLocator — tipo-derived
	// numeric strings (getSectionIdFromTipo) and the `''` of an unresolved
	// parent both arrive here and are separated by canonicalizeStoredSectionId.
	section_id: string | number;
	from_component_tipo: string;
}): Record<string, unknown> {
	const locator: Record<string, unknown> = {};
	if (fields.id !== undefined) locator.id = fields.id;
	locator.type = fields.type;
	locator.section_id = canonicalizeStoredSectionId(fields.section_id);
	locator.section_tipo = fields.section_tipo;
	locator.from_component_tipo = fields.from_component_tipo;
	return locator;
}

/** A stored literal item ({id, lang, value}). */
function literalItem(id: number, lang: string, value: string): Record<string, unknown> {
	return { id, lang, value };
}

/** term map ({lang: value}) from a list of {lang, value} name items. */
function termFromNameData(
	nameData: readonly { lang?: string; value?: unknown }[],
): Record<string, string> {
	const term: Record<string, string> = {};
	for (const item of nameData) {
		if (typeof item.lang === 'string') {
			term[item.lang] = String(item.value ?? '');
		}
	}
	return term;
}

/** True when a matrix record exists (existence probe; fixed-identifier table). */
async function matrixRecordExists(
	table: string,
	sectionTipo: string,
	sectionId: number,
): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT 1 FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 LIMIT 1`,
		[sectionTipo, sectionId],
	)) as unknown[];
	return rows.length > 0;
}

/** Ensure a matrix record with an explicit id exists (create with audit metadata if missing). */
async function ensureMatrixRecord(
	sectionTipo: string,
	sectionId: number,
	userId: number,
): Promise<void> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `ensureMatrixRecord: no matrix table for '${sectionTipo}'`,
			coordinates: { section_tipo: sectionTipo },
		});
	}
	if (!(await matrixRecordExists(table, sectionTipo, sectionId))) {
		await createSectionRecord(sectionTipo, userId, new Date(), sectionId);
	}
}

// --- main-record readers (PHP get_main_*) ------------------------------------

/**
 * The `matrix_ontology_main` row for a TLD (PHP get_ontology_main_from_tld):
 * a case-insensitive jsonpath probe on hierarchy6. Null when absent/unsafe TLD.
 */
export async function getOntologyMainFromTld(tld: string): Promise<{ section_id: number } | null> {
	const safe = safeTld(tld.trim().toLowerCase());
	if (safe === null) return null;
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "matrix_ontology_main"
		 WHERE section_tipo = $1 AND string @> $2::text::jsonb LIMIT 1`,
		[ONTOLOGY_MAIN_SECTION, JSON.stringify({ [HIERARCHY_TLD]: [{ value: safe }] })],
	)) as { section_id: number }[];
	return rows[0] ? { section_id: Number(rows[0].section_id) } : null;
}

/** The lowercase TLD of a main record (PHP get_main_tld — reads hierarchy6). */
export async function getMainTld(
	sectionId: number | string,
	sectionTipo: string,
): Promise<string | null> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return null;
	const record = await readMatrixRecord(table, sectionTipo, Number(sectionId));
	const items = (record?.columns.string as Record<string, unknown[]> | null)?.[HIERARCHY_TLD] as
		| { value?: unknown }[]
		| undefined;
	const value = items?.[0]?.value;
	return value ? String(value).toLowerCase() : null;
}

/** The typology id of a TLD's main record (PHP get_main_typology_id; default 15). */
export async function getMainTypologyId(tld: string): Promise<number | null> {
	const main = await getOntologyMainFromTld(tld);
	if (main === null) return null;
	const table = 'matrix_ontology_main';
	const record = await readMatrixRecord(table, ONTOLOGY_MAIN_SECTION, main.section_id);
	const items = (record?.columns.relation as Record<string, unknown[]> | null)?.[
		HIERARCHY_TYPOLOGY
	] as { section_id?: unknown }[] | undefined;
	const sectionId = items?.[0]?.section_id;
	return sectionId !== undefined && sectionId !== null ? Math.trunc(Number(sectionId)) : 15;
}

/** The full multilingual name data of a TLD's main record (PHP get_main_name_data). */
export async function getMainNameData(
	tld: string,
): Promise<{ id?: number; lang: string; value: string }[] | null> {
	const main = await getOntologyMainFromTld(tld);
	if (main === null) return null;
	const record = await readMatrixRecord(
		'matrix_ontology_main',
		ONTOLOGY_MAIN_SECTION,
		main.section_id,
	);
	const items = (record?.columns.string as Record<string, unknown[]> | null)?.[HIERARCHY_TERM] as
		| { id?: number; lang?: string; value?: unknown }[]
		| undefined;
	if (items === undefined) return null;
	return items
		.filter(
			(item): item is { id?: number; lang: string; value: unknown } =>
				typeof item.lang === 'string',
		)
		.map((item) => ({ id: item.id, lang: item.lang, value: String(item.value ?? '') }));
}

// --- single-record upsert (PHP insert_dd_ontology_record) --------------------

/**
 * Parse one matrix record and upsert its dd_ontology row (PHP
 * insert_dd_ontology_record) — a thin delegate of the guarded primitive
 * (section_record/ontology_projection.ts projectOntologyNode). Returns the node
 * tipo, or null when the record declares no tld (or is absent).
 *
 * THROWS `ontology.invalid_node` — never a silent null — when `sectionTipo` is
 * not an ontology node section (`localontology0`, `ontology35`, `test3`, …) or the
 * record parses into another tld's namespace: createParentGrouper discards the
 * return value and hierarchy provisioning must roll back loudly.
 */
export async function insertDdOntologyRecord(
	sectionTipo: string,
	sectionId: number | string,
): Promise<string | null> {
	const address = ontologyNodeAddress(sectionTipo, sectionId);
	if (address === null) {
		throw new DedaloError('ontology.invalid_node', {
			message:
				requiredOntologyTld(sectionTipo) === null
					? `'${sectionTipo}' is not an ontology node section — nothing written`
					: `'${sectionTipo}/${sectionId}': section_id is not a positive integer — nothing written`,
			// Log-only coordinates carry the id AS RECEIVED (int canon; a refused non-int
			// input stays visible verbatim) — never a String() mint (section_id_int_tripwire).
			coordinates: { section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	const projected = await projectOntologyNode(address);
	return projected.kind === 'projected' ? projected.tipo : null;
}

// --- root node (PHP create_dd_ontology_ontology_section_node) -----------------

export interface FileItem {
	tld: string;
	section_tipo?: string;
	typology_id?: number | null;
	name_data?: { id?: number; lang?: string; value?: unknown }[] | null;
	parent_grouper_tipo?: string | null;
	/**
	 * Declared dependencies (hierarchy60), already normalized by
	 * normalizeOntologyDependencies. Absent/null = NOT declared (an existing
	 * row keeps its value); `[]` = declared, needs nothing.
	 */
	dependencies?: OntologyDependency[] | null;
}

/**
 * Typology + name of a root node. Absent → the TLD's registry record (PHP
 * get_typology_locator_from_tld), never a blind 'others' (15): a caller that
 * omits them would re-hang a Core TLD under Others with a bare-tld term.
 */
async function resolveRootIdentity(
	fileItem: FileItem,
): Promise<{ typologyId: number; nameData: NonNullable<FileItem['name_data']> }> {
	const tld = fileItem.tld;
	const typologyId = fileItem.typology_id ?? (await getMainTypologyId(tld)) ?? 15; // 15 = 'others'
	// The bare-tld placeholder is a LABEL of the root node (its term), so it
	// goes in the label-fallback lang (labels.ts), not lg-nolan.
	const nameData = fileItem.name_data ??
		(await getMainNameData(tld)) ?? [{ lang: ONTOLOGY_LABEL_FALLBACK_LANG, value: tld }];
	return { typologyId, nameData };
}

/**
 * Create/upsert the `<tld>0` root dd_ontology node (PHP
 * create_dd_ontology_ontology_section_node). Model 'section'/dd6, is_main,
 * relations [ontology1, dd1201], properties {main_tld, color:'#2d8894'}, parent =
 * the typology grouper (built on demand via createParentGrouper). Returns the tipo.
 */
export async function createDdOntologyRootNode(fileItem: FileItem, userId = -1): Promise<string> {
	const tld = fileItem.tld;
	const { typologyId, nameData } = await resolveRootIdentity(fileItem);

	let parentGrouperTipo = fileItem.parent_grouper_tipo ?? null;
	if (parentGrouperTipo === null || parentGrouperTipo === '') {
		parentGrouperTipo = await createParentGrouper(
			ONTOLOGY_TYPE_GROUP,
			ONTOLOGY_TYPE_TLD,
			typologyId,
			userId,
		);
	}

	const tipo = `${tld}0`;
	const node: DdOntologyNode = {
		tipo,
		parent: parentGrouperTipo,
		term: termFromNameData(nameData as { lang?: string; value?: unknown }[]),
		model: 'section',
		order_number: null,
		relations: [{ tipo: 'ontology1' }, { tipo: 'dd1201' }],
		tld,
		properties: { main_tld: tld, color: '#2d8894' },
		model_tipo: SECTION_MODEL_TIPO,
		is_model: false,
		is_translatable: false,
		is_main: true,
		propiedades: null,
		// A `<tld>0` main node is a section: label class, never a machine name.
		machine_name: null,
		use_machine_name: false,
	};
	await upsertDdOntologyNode(node);
	return tipo;
}

// --- the registry row (PHP add_main_section, split by the registry-row law) ---
//
// THE REGISTRY-ROW LAW (owner-approved 2026-10-10;
// WC-2026-10-10-ontology-dependencies-hierarchy60). ONE behaviour on every
// Dédalo server — any server may be the master of others, so there is no
// master/client split in how a row is written:
//
//  - createMainSection — the ONLY door that mints a row, and only when no row
//    names the TLD. It writes the whole registry contract: hierarchy4 active =
//    YES (an admin switches a development TLD off by hand; the export filters
//    on it), hierarchy125 = yes only for 'dd', hierarchy8 = the lg1 record of
//    REGISTRY_LANG, hierarchy54 = dd153/1, name, tld, target section,
//    typology, declared dependencies (hierarchy60) and, for 'dd', the general
//    term children.
//  - syncMainSectionFromDefinition — the IMPORT door (package install, ontology
//    update, the seed compiler, a JSON-node provision): creates when missing;
//    on an EXISTING row it replaces ONLY what the definition owns (hierarchy5,
//    hierarchy9, hierarchy60 — each only when the definition states it),
//    switches hierarchy4 on for a CORE TLD only (a switched-off domain TLD
//    stays off), and re-applies the hierarchy125 / hierarchy8 rules. It never
//    touches hierarchy54 nor any other key: those are the installation's.
//  - ensureMainSection — create-if-missing, otherwise NO write: the rebuild and
//    provisioning doors (ensureMainNode, provisionVirtualSections,
//    createParentGrouper) build `<tld>0` from what the row holds.
//
// The PHP original (add_main_section) rewrote every key with constants on every
// call, so a rebuild silently re-activated a TLD an operator had switched off,
// reset its project filter and pinned its language to a hard-coded lg-spa id.

/**
 * THE one per-key writer of the ontology REGISTRY rows (matrix_ontology_main,
 * ontology35): createMainSection / syncMainSectionFromDefinition's registry
 * components (hierarchy60 dependencies included). Unstamped, no TM — registry
 * definition rows, as in PHP add_main_section (a sanctioned derived writer,
 * write_obligations RAW_CALLER_EXEMPT). hierarchy60 is a component_json and
 * lands in `misc`.
 */
function writeOntologyMainKey(
	mainSectionId: number,
	column: 'relation' | 'string' | 'misc',
	tipo: string,
	value: unknown,
): Promise<void> {
	return updateMatrixKeyData(
		'matrix_ontology_main',
		ONTOLOGY_MAIN_SECTION,
		mainSectionId,
		column,
		tipo,
		value,
	);
}

/**
 * The lg1 record id of a language code — by default REGISTRY_LANG
 * (ontology_tipos.ts), the language every registry row is filed under
 * (hierarchy8; its own constant since 2026-11-04, owner decision D7). Resolved from the
 * installation's own langs section, never a hard-coded id; an unresolvable code
 * is an install defect and is refused loudly (no fallback: a guessed id would
 * file the row under whatever language happens to own it).
 */
export async function resolveRegistryLangId(code: string = REGISTRY_LANG): Promise<number> {
	const sectionId = await getLangSectionIdByCode(code);
	if (sectionId === null) {
		throw new DedaloError('ontology.invalid_node', {
			message: `ontology registry: the registry language '${code}' has no ${LANG_SECTION} record — the installation's langs section is incomplete`,
			coordinates: { section_tipo: LANG_SECTION, lang: code },
		});
	}
	return sectionId;
}

/** A dd64 yes/no link locator for a registry flag component. */
function siNoValue(tipo: string, yes: boolean): Record<string, unknown>[] {
	return [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: yes ? SI_NO_YES : SI_NO_NO,
			from_component_tipo: tipo,
		}),
	];
}

/** The definition's name items, normalized to {id, lang, value}; [] when it states none. */
function definitionNameItems(fileItem: FileItem): Record<string, unknown>[] {
	return (fileItem.name_data ?? [])
		.filter(
			(item): item is { id?: number; lang: string; value: unknown } =>
				typeof item.lang === 'string',
		)
		.map((item) => literalItem(item.id ?? 1, item.lang, String(item.value ?? '')));
}

/** The definition's typology id, or null when it states none (PHP: only > 0). */
function definitionTypologyId(fileItem: FileItem): number | null {
	const typologyId = Number(fileItem.typology_id ?? 0);
	return Number.isFinite(typologyId) && typologyId > 0 ? typologyId : null;
}

/**
 * The definition's declared dependencies, re-checked against THE normalizer
 * (ontology_dependencies.ts). null = not declared. A caller handing in a list
 * the normalizer would change has skipped normalization — refused, never
 * silently "fixed" into a declaration the definition did not make.
 */
function definitionDependencies(fileItem: FileItem): OntologyDependency[] | null {
	const warnings: string[] = [];
	const dependencies = normalizeOntologyDependencies(fileItem.tld, fileItem.dependencies, warnings);
	if (warnings.length > 0) {
		throw new DedaloError('internal.invariant', {
			message: `ontology registry '${fileItem.tld}': dependencies were not normalized before the write — ${warnings.join('; ')}`,
			coordinates: { tld: fileItem.tld },
		});
	}
	return dependencies;
}

/** hierarchy8: the registry row's language (REGISTRY_LANG's lg1 record). */
function writeRegistryLang(mainSectionId: number, langId: number): Promise<void> {
	return writeOntologyMainKey(mainSectionId, 'relation', HIERARCHY_LANG, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: LANG_SECTION,
			section_id: langId,
			from_component_tipo: HIERARCHY_LANG,
		}),
	]);
}

/**
 * The keys the DEFINITION owns, each written only when the definition states
 * it: hierarchy5 (name), hierarchy9 (typology — PHP omits the item id here),
 * hierarchy60 (declared dependencies; `[]` is a declaration and is written).
 */
async function writeDefinitionKeys(
	mainSectionId: number,
	nameItems: readonly Record<string, unknown>[],
	typologyId: number | null,
	dependencies: readonly OntologyDependency[] | null,
): Promise<void> {
	if (nameItems.length > 0) {
		await writeOntologyMainKey(mainSectionId, 'string', HIERARCHY_TERM, nameItems);
	}
	if (typologyId !== null) {
		await writeOntologyMainKey(mainSectionId, 'relation', HIERARCHY_TYPOLOGY, [
			relationLocator({
				type: RELATION_TYPE_LINK,
				section_tipo: HIERARCHY_TYPES_SECTION,
				section_id: typologyId,
				from_component_tipo: HIERARCHY_TYPOLOGY,
			}),
		]);
	}
	if (dependencies !== null) {
		await writeOntologyMainKey(
			mainSectionId,
			'misc',
			HIERARCHY_DEPENDENCIES,
			dependenciesMiscItems(dependencies),
		);
	}
}

/** The 'dd' registry row's general-term children (nodes 1 and 2) — creation only. */
function ddGeneralTermValue(targetSectionTipo: string): Record<string, unknown>[] {
	return [1, 2].map((nodeId) =>
		relationLocator({
			id: nodeId,
			type: RELATION_TYPE_CHILDREN,
			section_tipo: targetSectionTipo,
			section_id: nodeId,
			from_component_tipo: HIERARCHY_GENERAL_TERM,
		}),
	);
}

/**
 * MINT the matrix_ontology_main row of a TLD that has none (the registry-row
 * law above). Refuses a TLD that already has a row — use
 * syncMainSectionFromDefinition (an import) or ensureMainSection (a rebuild).
 * Every input is resolved BEFORE the record is minted, so a refusal (an
 * unresolvable REGISTRY_LANG, unnormalized dependencies) writes nothing.
 * Returns the new section_id.
 */
export async function createMainSection(fileItem: FileItem, userId = -1): Promise<number> {
	const minted = await mintMainSection(fileItem, userId, 'refuse');
	return minted.sectionId;
}

/**
 * The mint, ONE TRANSACTION (cross-write:r2): the per-tld mint lock, the "no
 * row names this tld" check behind it, the row and every registry key — a
 * failure after the mint rolls the row back (never an orphan registry row no
 * tld resolves), and two minters of one tld never both mint. An existing row
 * is refused (`refuse` — createMainSection's contract) or answered as it is
 * (`keep` — ensureMainSection's, the race's loser included).
 *
 * ONE TLD, NORMALIZED ONCE (cross-write:r3): the lock key, the check and the
 * row's hierarchy6 are the same `safeTld(trim + lowercase)` — the spelling
 * getOntologyMainFromTld looks up. A raw spelling used to lock one key, check
 * another and write a row its own tld never found (a second mint then doubled
 * it). A tld that is not one is refused before anything is minted.
 */
async function mintMainSection(
	fileItem: FileItem,
	userId: number,
	onExisting: 'refuse' | 'keep',
): Promise<{ sectionId: number; created: boolean }> {
	const tld = safeTld(
		String(fileItem.tld ?? '')
			.trim()
			.toLowerCase(),
	);
	if (tld === null) {
		throw new DedaloError('request.invalid', {
			message: `createMainSection: ${JSON.stringify(fileItem.tld ?? null)} is not a tld`,
			coordinates: { key: 'tld' },
		});
	}
	return withTransaction(async () => {
		await lockOntologyRegistryMint(tld);
		const existing = await getOntologyMainFromTld(tld);
		if (existing !== null) {
			if (onExisting === 'keep') return { sectionId: existing.section_id, created: false };
			throw new DedaloError('internal.invariant', {
				message: `createMainSection: '${tld}' already has an ontology registry row`,
				coordinates: { tld },
			});
		}
		return { sectionId: await mintRegistryRow({ ...fileItem, tld }, userId), created: true };
	});
}

/** The row and its registry keys (mintMainSection's body — inside its transaction). */
async function mintRegistryRow(fileItem: FileItem, userId: number): Promise<number> {
	const tld = fileItem.tld;
	const targetSectionTipo = fileItem.section_tipo ?? mapTldToTargetSectionTipo(tld);
	const langId = await resolveRegistryLangId();
	const dependencies = definitionDependencies(fileItem);
	const nameItems = definitionNameItems(fileItem);

	const mainSectionId = await createSectionRecord(ONTOLOGY_MAIN_SECTION, userId);
	const write = (column: 'relation' | 'string', tipo: string, value: unknown): Promise<void> =>
		writeOntologyMainKey(mainSectionId, column, tipo, value);

	// Project filter (dd153/1) — creation only: from here on it is the installation's.
	await write('relation', HIERARCHY_FILTER, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_FILTER,
			section_tipo: PROJECTS_SECTION,
			section_id: '1',
			from_component_tipo: HIERARCHY_FILTER,
		}),
	]);
	await write(
		'relation',
		HIERARCHY_ACTIVE_IN_THESAURUS,
		siNoValue(HIERARCHY_ACTIVE_IN_THESAURUS, tld === 'dd'),
	);
	await writeRegistryLang(mainSectionId, langId);
	await write('relation', HIERARCHY_ACTIVE, siNoValue(HIERARCHY_ACTIVE, true));
	await write('string', HIERARCHY_TLD, [literalItem(1, DATA_NOLAN, tld)]);
	await write('string', HIERARCHY_TARGET_SECTION, [literalItem(1, DATA_NOLAN, targetSectionTipo)]);
	await writeDefinitionKeys(
		mainSectionId,
		// hierarchy5 is translatable: the bare-tld placeholder name is a label in
		// the label-fallback lang (labels.ts), not lg-nolan.
		nameItems.length > 0 ? nameItems : [literalItem(1, ONTOLOGY_LABEL_FALLBACK_LANG, tld)],
		definitionTypologyId(fileItem),
		dependencies,
	);
	if (tld === 'dd') {
		await write('relation', HIERARCHY_GENERAL_TERM, ddGeneralTermValue(targetSectionTipo));
	}
	return mainSectionId;
}

/**
 * Create-if-missing, otherwise NO write — the rebuild/provisioning door
 * (ensureMainNode, provisionVirtualSections, createParentGrouper): a rebuild
 * re-derives `<tld>0` from what the row holds and never resets the row.
 */
export async function ensureMainSection(
	fileItem: FileItem,
	userId = -1,
): Promise<{ sectionId: number; created: boolean }> {
	const existing = await getOntologyMainFromTld(fileItem.tld);
	if (existing !== null) return { sectionId: existing.section_id, created: false };
	// Re-checked behind the mint lock: a concurrent minter's row is answered, not doubled.
	return mintMainSection(fileItem, userId, 'keep');
}

/**
 * THE IMPORT door of a registry row: apply an ontology DEFINITION (an
 * ontology.json entry, a package, an engine/test JSON main node) to the TLD's
 * row — see the registry-row law above. Missing row → createMainSection. An
 * existing row gets ONLY: hierarchy5 / hierarchy9 / hierarchy60 from the
 * definition (each only when stated — an absent `dependencies` is "not
 * declared" and leaves the local value), hierarchy4 = yes for a CORE TLD
 * (isCoreOntologyTld) and unchanged otherwise, hierarchy125 by the dd-only
 * rule, hierarchy8 by the REGISTRY_LANG rule. Returns the row's section_id.
 */
export async function syncMainSectionFromDefinition(
	fileItem: FileItem,
	userId = -1,
): Promise<number> {
	const tld = fileItem.tld;
	const existing = await getOntologyMainFromTld(tld);
	// Missing → mint behind the mint lock; a concurrent minter's row (the race's
	// loser) is SYNCED like any existing row, never doubled nor refused.
	const minted = existing === null ? await mintMainSection(fileItem, userId, 'keep') : null;
	if (minted?.created === true) return minted.sectionId;
	const mainSectionId = minted?.sectionId ?? (existing as { section_id: number }).section_id;
	const langId = await resolveRegistryLangId();
	const dependencies = definitionDependencies(fileItem);

	await writeDefinitionKeys(
		mainSectionId,
		definitionNameItems(fileItem),
		definitionTypologyId(fileItem),
		dependencies,
	);
	if (isCoreOntologyTld(tld)) {
		await writeOntologyMainKey(
			mainSectionId,
			'relation',
			HIERARCHY_ACTIVE,
			siNoValue(HIERARCHY_ACTIVE, true),
		);
	}
	await writeOntologyMainKey(
		mainSectionId,
		'relation',
		HIERARCHY_ACTIVE_IN_THESAURUS,
		siNoValue(HIERARCHY_ACTIVE_IN_THESAURUS, tld === 'dd'),
	);
	await writeRegistryLang(mainSectionId, langId);
	return mainSectionId;
}

// --- parent grouper (PHP create_parent_grouper) ------------------------------

/** The 7-lang grouper labels for a typology TLD namespace (PHP :1170-1213). */
function grouperNameData(tld: string): { lang: string; value: string }[] {
	const suffix = tld === 'hierarchymtype' ? ` [m] | ${tld}` : ` | ${tld}`;
	const isOntology = tld === ONTOLOGY_TYPE_TLD;
	const pick = (ontologyLabel: string, hierarchyLabel: string): string =>
		(isOntology ? ontologyLabel : hierarchyLabel) + suffix;
	return [
		{ lang: 'lg-spa', value: pick('Tipologías de ontología', 'Tipologías de jerarquía') },
		{ lang: 'lg-eng', value: pick('Ontology typologies', 'Hierarchy typologies') },
		{ lang: 'lg-deu', value: pick('Ontologie-Typen', 'Typologien der Hierarchie') },
		{ lang: 'lg-fra', value: pick("Types d'ontologie", 'Typologies hiérarchiques') },
		{ lang: 'lg-ita', value: pick('Tipi di ontologia', 'Tipologie di gerarchia') },
		{ lang: 'lg-cat', value: pick("Tipus d'ontologia", 'Tipus de jerarquies') },
		{ lang: 'lg-ell', value: pick('Τύποι οντολογίας', 'Τυπολογίες ιεραρχίας') },
	];
}

/**
 * The node + matrix record a typology grouper hangs under (`<parentTld>0` and
 * `<parentTld>0/<id>` of the parent group, e.g. ontology0 + ontology0/40) — ensured,
 * never rewritten (createParentGrouper).
 */
async function ensureGrouperParent(
	parentGroup: string,
	userId: number,
): Promise<{ parentNodeTipo: string; parentSectionId: string | null }> {
	// Parent node (e.g. ontology0 for parent group ontology40).
	const parentTld = getTldFromTipo(parentGroup);
	const parentSectionId = getSectionIdFromTipo(parentGroup);
	const parentNodeTipo = `${parentTld}0`;

	if ((await readDdOntologyRow(parentNodeTipo)) === null) {
		await upsertDdOntologyNode({
			tipo: parentNodeTipo,
			parent: parentGroup,
			term: null,
			model: 'section',
			order_number: null,
			relations: [{ tipo: 'ontology1' }, { tipo: 'dd1201' }],
			tld: parentTld,
			properties: { main_tld: parentTld, color: '#276f67' },
			model_tipo: SECTION_MODEL_TIPO,
			is_model: false,
			is_translatable: false,
			is_main: true,
			propiedades: null,
		});
	}

	// Parent matrix record (<parentNodeTipo>/<parentSectionId>).
	//
	// ONT-TLD note: this row is created and NOTHING else is written to it, so since
	// the birth stamp (record_defaults seed 3) it carries an `ontology7` and
	// therefore PARSES — appearing in the tree as a node with no term. That is a
	// deliberate trade, not an oversight: the alternative is what it did before,
	// which was to parse to nothing, leaving the child's parent locator pointing at
	// a record the ontology cannot resolve (the child silently becomes a root).
	// A visible unnamed node is diagnosable; a dangling parent is not. This branch
	// only fires as a repair backstop on an already-incomplete ontology.
	if (parentSectionId !== null) {
		await ensureMatrixRecord(parentNodeTipo, Number(parentSectionId), userId);
	}
	return { parentNodeTipo, parentSectionId };
}

/**
 * The typology a grouper tld registered on demand is filed under when the release this engine
 * ships does not define the tld: Core. FALLBACK ONLY — the master's own definition wins
 * (grouperTldDefinition).
 */
const GROUPER_TLD_TYPOLOGY_ID = 14;

/**
 * The definition a grouper tld is REGISTERED with on demand: the master's (typology + name, from
 * the release this engine ships — release_definition.ts), each half falling back to Core 14 / the
 * generic grouper labels only when the release does not state it. Before, the registration
 * always invented Core 14 + generic labels: `hierarchytype` / `hierarchymtype` (typology 12 on
 * the master) were filed under Core on every installation, and no import ever corrected it —
 * neither is core nor declared by any ontology, so a default ACTIVE_ONTOLOGY_TLDS never
 * imports them. Gate: ontology_root_registry_native D1–D4.
 */
export async function grouperTldDefinition(tld: string): Promise<FileItem> {
	return grouperTldDefinitionFrom(tld, await releaseTldDefinition(tld));
}

/**
 * PURE: grouperTldDefinition for a given release definition (null = the release does not
 * define the tld). Separate so a gate can state a release whose name differs from the generic
 * labels — the vendored release's grouper names EQUAL them, so through the file alone the name
 * half could not tell the release's from the fallback (ontology_root_registry_native D4).
 */
export function grouperTldDefinitionFrom(
	tld: string,
	release: ReleaseTldDefinition | null,
): FileItem {
	return {
		tld,
		typology_id: release?.typologyId ?? GROUPER_TLD_TYPOLOGY_ID,
		name_data: release?.nameData ?? grouperNameData(tld),
	};
}

/**
 * The grouper tld's OWN registration (registry row + `<tld>0` root), create-if-missing, BOTH
 * halves — an existing grouper row is the installation's, and an existing root is the
 * projection of that row (rebuildOntology / syncOntologyActivation derive it, parent = the row's
 * typology grouper). A missing row is minted from the master's definition (grouperTldDefinition);
 * a missing root is planted from the row that now exists — its typology, its name — so the root
 * parent IS the registry typology whichever half existed before: re-planting with a fixed parent
 * re-hung `hierarchytype0` under `ontologytype14` while the next rebuild hung it back under its
 * registry typology (two writers, a flip-flop). The parent is always named, never built through
 * createParentGrouper: that is what keeps a grouper's registration from recursing. Gates:
 * ontology_derive_packages_native G1h, ontology_root_registry_native D1–D3.
 */
async function registerGrouperTld(tld: string, userId: number): Promise<void> {
	if ((await getOntologyMainFromTld(tld)) === null) {
		await ensureMainSection(await grouperTldDefinition(tld), userId);
	}
	if ((await readDdOntologyRow(`${tld}0`)) === null) {
		const typologyId = (await getMainTypologyId(tld)) ?? GROUPER_TLD_TYPOLOGY_ID;
		await createDdOntologyRootNode(
			{ tld, parent_grouper_tipo: `${ONTOLOGY_TYPE_TLD}${typologyId}` },
			userId,
		);
	}
}

/**
 * Ensure a typology grouper node exists in dd_ontology + the matrix and return
 * its tipo (PHP create_parent_grouper). Resilient to partial-bootstrap: creates
 * the grouper's own TLD registration, the `<parentTld>0` parent node/record, and
 * the typology matrix node `<tld><typologyId>` on demand.
 *
 * Groupers: ontology → ('ontology40','ontologytype'); hierarchy →
 * ('hierarchy56','hierarchytype'); hierarchy-model → ('hierarchy57','hierarchymtype').
 *
 * `typologyId` is the typology record this call builds UNDER the grouper, never the grouper
 * tld's own typology (registerGrouperTld): minting the registry row with it filed
 * `hierarchytype` under the first thesaurus' typology (Toponymy, 2).
 *
 * `register: false` skips the grouper tld's own registration (registry row + `<tld>0`
 * root): ensureReferencedGrouperRecords, where the package import just provisioned that
 * tld from its definition and a rewrite with the generic grouper labels would undo it.
 */
export async function createParentGrouper(
	parentGroup: string,
	tld: string,
	typologyId: number,
	userId = -1,
	options: { register?: boolean } = {},
): Promise<string> {
	if (options.register !== false) await registerGrouperTld(tld, userId);

	const { parentNodeTipo, parentSectionId } = await ensureGrouperParent(parentGroup, userId);

	// Typology matrix node record: <tld>0 / <typologyId> (e.g. ontologytype/14).
	const typologySectionTipo = `${tld}0`;
	await ensureMatrixRecord(typologySectionTipo, typologyId, userId);
	const typologyTable = (await getMatrixTableFromTipo(typologySectionTipo)) ?? 'matrix_ontology';
	const write = (column: 'relation' | 'string', tipo: string, value: unknown): Promise<void> =>
		updateMatrixKeyData(typologyTable, typologySectionTipo, typologyId, column, tipo, value);

	// Publication (yes)
	await write('relation', ONTOLOGY_PUBLICATION, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: SI_NO_YES,
			from_component_tipo: ONTOLOGY_PUBLICATION,
		}),
	]);
	// Is descriptor (yes)
	await write('relation', ONTOLOGY_IS_DESCRIPTOR, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: SI_NO_YES,
			from_component_tipo: ONTOLOGY_IS_DESCRIPTOR,
		}),
	]);
	// Model (area model root dd0/4)
	await write('relation', ONTOLOGY_MODEL, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: 'dd0',
			section_id: '4',
			from_component_tipo: ONTOLOGY_MODEL,
		}),
	]);
	// Translatable (no)
	await write('relation', ONTOLOGY_TRANSLATABLE, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: SI_NO_NO,
			from_component_tipo: ONTOLOGY_TRANSLATABLE,
		}),
	]);
	// Is model (no)
	await write('relation', ONTOLOGY_IS_MODEL, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: SI_NO_NO,
			from_component_tipo: ONTOLOGY_IS_MODEL,
		}),
	]);
	// TLD
	await write('string', ONTOLOGY_TLD, [literalItem(1, DATA_NOLAN, tld)]);
	// Name = the typology term (hierarchy16 off hierarchy13/typologyId, all langs)
	const typologyTermItems = await readTypologyTermItems(typologyId);
	if (typologyTermItems.length > 0) {
		await write('string', ONTOLOGY_TERM, typologyTermItems);
	}
	// Parent locator (dd47 → <parentNodeTipo>/<parentSectionId>)
	await write('relation', ONTOLOGY_PARENT, [
		relationLocator({
			type: RELATION_TYPE_PARENT,
			section_tipo: parentNodeTipo,
			section_id: parentSectionId ?? '',
			from_component_tipo: ONTOLOGY_PARENT,
		}),
	]);

	// Re-derive the dd_ontology node for the typology matrix record.
	await insertDdOntologyRecord(typologySectionTipo, typologyId);

	return `${tld}${typologyId}`;
}

// --- grouper records follow what hangs under them -----------------------------

/** The typology grouper namespaces → the parent group (`<parentTld>0/<id>`) each hangs under. */
const TYPOLOGY_GROUPER_PARENT: ReadonlyMap<string, string> = new Map([
	[ONTOLOGY_TYPE_TLD, ONTOLOGY_TYPE_GROUP],
	[HIERARCHY_TYPE_TLD, HIERARCHY_TYPE_GROUP],
	[HIERARCHY_MODEL_TYPE_TLD, HIERARCHY_MODEL_TYPE_GROUP],
]);

/** Whether `tld` is one of the three typology grouper namespaces. */
export function isTypologyGrouperTld(tld: string): boolean {
	return TYPOLOGY_GROUPER_PARENT.has(tld);
}

/**
 * GROUPER RECORDS FOLLOW WHAT HANGS UNDER THEM (WC-2026-10-21-ontology-update-rebuild).
 *
 * A grouper record `<grouper>0/<N>` is made ON DEMAND by createParentGrouper, by the
 * installation (a thesaurus of typology N, a tld registered under typology N), while the
 * release's grouper package carries only the master's typologies. Its import is a scoped
 * DELETE + COPY of the whole `<grouper>0` section, so it wipes every installation-made one —
 * and the update's re-derive (rebuildOntology, which sweeps orphans) would then delete the
 * node, leaving every `<tld>0` root / `<tld>1`, `<tld>2` thesaurus node under it dangling.
 *
 * So, after the import and BEFORE the derive, every typology still REFERENCED and no longer
 * backed by a record is re-made (createParentGrouper `register: false`, one transaction each):
 *   - a matrix_ontology record of another section whose parent locator (ontology15) points
 *     into `<grouper>0` — the thesaurus descriptor / model records;
 *   - a `<tld>0` root node (is_main) whose parent is `<grouper><N>` — roots are built from the
 *     registry's typology (createDdOntologyRootNode), never parsed from a record.
 * Returns the typology ids re-made, ascending ([] for a tld that is not a grouper).
 * Gate: ontology_derive_packages_native G1h.
 */
export async function ensureReferencedGrouperRecords(tld: string, userId = -1): Promise<number[]> {
	const parentGroup = TYPOLOGY_GROUPER_PARENT.get(tld);
	if (parentGroup === undefined) return [];
	const missing = await unbackedGrouperTypologies(tld);
	for (const typologyId of missing) {
		await withTransaction(() =>
			createParentGrouper(parentGroup, tld, typologyId, userId, { register: false }),
		);
	}
	return missing;
}

/** Typology ids referenced under `<grouper>` (see ensureReferencedGrouperRecords) with no record. */
async function unbackedGrouperTypologies(tld: string): Promise<number[]> {
	const sectionTipo = `${tld}0`;
	const rows = (await sql.unsafe(
		`SELECT DISTINCT ref.id::bigint AS id FROM (
		   SELECT locator->>'section_id' AS id
		     FROM matrix_ontology record,
		          jsonb_array_elements(record.relation->$2::text) AS locator
		    WHERE record.section_tipo <> $1
		      AND record.relation @> jsonb_build_object($2::text, jsonb_build_array(jsonb_build_object('section_tipo', $1::text)))
		      AND locator->>'section_tipo' = $1
		   UNION
		   SELECT substr(parent, length($3::text) + 1) AS id
		     FROM dd_ontology
		    WHERE is_main AND left(parent, length($3::text)) = $3::text
		 ) AS ref
		 WHERE ref.id ~ '^[1-9][0-9]{0,17}$'
		   AND NOT EXISTS (
		     SELECT 1 FROM matrix_ontology grouper
		      WHERE grouper.section_tipo = $1 AND grouper.section_id = ref.id::bigint)
		 ORDER BY 1`,
		[sectionTipo, ONTOLOGY_PARENT, tld],
	)) as { id: number | string }[];
	return rows.map((row) => Number(row.id));
}

/** Read the typology's name (hierarchy16 off hierarchy13/typologyId), all langs. */
async function readTypologyTermItems(typologyId: number): Promise<Record<string, unknown>[]> {
	const table = await getMatrixTableFromTipo(HIERARCHY_TYPES_SECTION);
	if (table === null) return [];
	const record = await readMatrixRecord(table, HIERARCHY_TYPES_SECTION, typologyId);
	const items = (record?.columns.string as Record<string, unknown[]> | null)?.[
		HIERARCHY_TYPES_NAME
	] as Record<string, unknown>[] | undefined;
	return items ?? [];
}

// --- set_records (PHP set_records_in_dd_ontology) ----------------------------

export interface SetRecordsTarget {
	sectionTipo: string;
	/** Edit mode: the ONE record to process. */
	sectionId?: number | null;
	/**
	 * List mode: the EXPLICIT record ids to process — the caller's resolved scope
	 * (e.g. a request SQO's matched set). An empty array is a refusal, never
	 * "everything".
	 */
	sectionIds?: readonly number[];
	userId?: number;
}

/**
 * The record ids a target states (one id, or an explicit list); null = no scope stated.
 *
 * There is NO whole-section scope (retired 2026-10-21, ONT follow-up): a whole tld's
 * projection is ontology_state.rebuildOntology's — the id-stable, transactional,
 * orphan-sweeping re-derive under the tld's projection lock. Its last caller, the
 * installer's upsert-only re-derive pass, is gone (ontology_install.ts header).
 */
function scopedRecordIds(target: SetRecordsTarget): number[] | null {
	if (target.sectionId !== undefined && target.sectionId !== null) {
		return [Number(target.sectionId)];
	}
	if (target.sectionIds !== undefined) return target.sectionIds.map((id) => Number(id));
	return null;
}

/**
 * Sync matrix ontology records into dd_ontology (PHP set_records_in_dd_ontology).
 * Partial success: ok=true when at least one record processed.
 *
 * SCOPE IS EXPLICIT OR IT IS REFUSED (WC-043). PHP list mode rebuilt the SQO from
 * the session and FAILED CLOSED when it was missing ('Not sqo_session found from
 * id: …', writing nothing). TS has no session-SQO twin, and the port filled the
 * gap with an unbounded `WHERE section_tipo = $1` scan — fail-OPEN where PHP was
 * fail-CLOSED, and the same shape as the 2026-07-19 runaway WC-043 closed for
 * tool_update_cache (measured reach here: 12,172 records across four sections,
 * foreground, behind a client that gives up at 60s while the server keeps
 * writing). A caller now states its scope: one id or an explicit id list. A whole
 * tld is never this door's: that is ontology_state.rebuildOntology.
 *
 * ONT-2: only a governed `<tld>0` section is accepted (refused otherwise, before
 * any scope work), and each record goes through the guarded primitive — one that
 * parses into another tld's namespace is an error line, nothing written for it.
 * The registry section (ontology35) is NOT a projection: its door is
 * ontology_state.syncOntologyActivation — a drifted tld that still holds rows is
 * re-derived, a converged one has only its root re-planted, a tld with no rows is
 * left empty. Nothing is retracted there; only ontology_delete retracts a tld
 * (retractOntology).
 */
export async function setRecordsInDdOntology(
	target: SetRecordsTarget,
): Promise<OntologyWriteResponse> {
	const response: OntologyWriteResponse = {
		ok: false,
		msg: '',
		errors: [],
		total: 0,
		processed_count: 0,
	};

	// An override record is not a node (parser.ts): re-parse the node it
	// overrides instead. Refused loudly, never skipped as "0 processed".
	if (target.sectionTipo === LOCAL_ONTOLOGY_SECTION) {
		response.errors.push(
			`'${LOCAL_ONTOLOGY_SECTION}' records are overrides, not nodes — re-parse the overridden node (ontology42) instead`,
		);
		response.msg = `Error. Refusing to parse override records of '${LOCAL_ONTOLOGY_SECTION}' as nodes`;
		return response;
	}
	// ONT-2: only a `<tld>0` section holds ontology NODES. A registry record
	// (ontology35) is an ACTIVATION, not a projection — ontology_state's
	// syncOntologyActivation; any other section (`ontology1..N`, `test3`) never
	// projects, whatever an `ontology7` in its data says.
	if (requiredOntologyTld(target.sectionTipo) === null) {
		response.errors.push(
			target.sectionTipo === ONTOLOGY_MAIN_SECTION
				? `${target.sectionTipo} is not governed by an ontology tld — registry records are activated through ontology_state.syncOntologyActivation`
				: `${target.sectionTipo} is not governed by an ontology tld (an ontology node section is '<tld>0')`,
		);
		response.msg = `Error. '${target.sectionTipo}' is not an ontology node section`;
		return response;
	}

	// Resolve the record ids to process — see the scope contract in the doc above.
	const ids = scopedRecordIds(target);
	if (ids === null) {
		// No scope stated: refuse LOUDLY rather than guess "all" (WC-043).
		response.errors.push(
			'no scope: pass sectionId or an explicit sectionIds list (a whole tld is rebuildOntology)',
		);
		response.msg = `Error. Refusing an unscoped write over '${target.sectionTipo}' (WC-043)`;
		return response;
	}
	response.total = ids.length;

	if (ids.length === 0) {
		response.ok = true;
		response.msg = `OK. No records found to process for ${target.sectionTipo}`;
		return response;
	}

	let processed = 0;
	for (const sectionId of ids) {
		let termId: string | null = null;
		try {
			termId = await insertDdOntologyRecord(target.sectionTipo, sectionId);
		} catch (error) {
			// A record parsing outside its own namespace (ONT-2): named, nothing
			// written, the rest of the batch still runs (partial success). ONLY that
			// refusal: a grammar / DB-constraint `ontology.invalid_node` stays fatal.
			if (error instanceof ForeignOntologyNodeRefused) {
				response.errors.push(error.line);
				continue;
			}
			throw error;
		}

		if (termId === null || termId === '') {
			response.errors.push(
				`Failed to process dd_ontology record for section_tipo: ${target.sectionTipo}, section_id: ${sectionId}`,
			);
		} else {
			processed++;
		}
	}

	response.processed_count = processed;
	if (response.errors.length === 0) {
		response.ok = true;
		response.msg = `OK. Request completed successfully for ${target.sectionTipo}`;
	} else if (processed > 0) {
		response.ok = true;
		response.msg = `Partial success. Some records processed for ${target.sectionTipo}`;
	} else {
		response.msg = `Request failed for ${target.sectionTipo}`;
	}
	return response;
}

// --- regenerate — RETIRED 2026-07-15 -----------------------------------------
// The destructive dd_ontology rebuild moved to core/ontology/ontology_state.ts
// `rebuildOntology` (transactional; no leftover backup table), the ONE writer.
// `regenerateRecordsInDdOntology` — the backup-table-based version — is gone; nothing
// may wipe-and-rebuild a tld outside ontology_state.ts (ontology_single_writer_tripwire).

// --- order sync (PHP sync_order_to_dd_ontology) — CONSUMED BY THE TREE (A5) ---

/**
 * Push new per-parent order_number values into dd_ontology after a tree reorder
 * (PHP sync_order_to_dd_ontology). Only rows whose dd_ontology parent matches the
 * reordered parent are touched; missing/mismatched/unchanged rows are skipped.
 * Returns the number of rows actually updated.
 *
 * EXPORTED WITH THIS EXACT SIGNATURE — the tree's save_order (Workstream A5)
 * imports it; do not change the shape.
 */
export async function syncOrderToDdOntology(
	changed: { value: number; locator: { section_tipo: string; section_id: number } }[],
	parentSectionTipo: string,
	parentSectionId: number,
): Promise<number> {
	if (changed.length === 0) {
		return 0;
	}
	const parentTermId = await getTermIdFromLocator({
		section_tipo: parentSectionTipo,
		section_id: parentSectionId,
	});
	if (parentTermId === null || parentTermId === '') {
		return 0;
	}
	let updated = 0;
	for (const item of changed) {
		const childTermId = await getTermIdFromLocator(item.locator);
		if (childTermId === null || childTermId === '') continue;
		const row = await readDdOntologyRow(childTermId);
		if (row === null) continue; // not an ontology node
		if ((row.parent ?? null) !== parentTermId) continue;
		if (Number(row.order_number ?? 0) === Number(item.value)) continue;
		if (
			await updateDdOntologyColumns(childTermId, { order_number: Math.trunc(Number(item.value)) })
		) {
			updated++;
		}
	}
	return updated;
}
