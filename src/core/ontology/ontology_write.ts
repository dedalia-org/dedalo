/**
 * Ontology write drivers — PHP ontology:: {insert_dd_ontology_record :2355,
 * set_records_in_dd_ontology :2502, regenerate_records_in_dd_ontology :2655,
 * sync_order_to_dd_ontology :2411, create_dd_ontology_ontology_section_node
 * :1042 (createDdOntologyRootNode), create_parent_grouper :1154,
 * add_main_section :809, get_main_* :2846}.
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
 * not wrap it). regenerate uses the BACKUP-TABLE protocol as its rollback (NOT a
 * transaction — matches PHP + two-server coexistence) and LEAVES dd_ontology_bk
 * on success (PHP-pinned).
 *
 * LEDGER / divergences (per no-silent-narrowing):
 *  - setRecords LIST mode = full-section scan; PHP filters by the session SQO,
 *    which TS keeps no twin of. Documented divergence.
 */

import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import {
	type DdOntologyNode,
	deleteTldNodes,
	getActiveTlds,
	readDdOntologyRow,
	updateDdOntologyColumns,
	upsertDdOntologyNode,
} from '../db/dd_ontology.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { updateMatrixKeyData } from '../db/matrix_write.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import {
	DATA_NOLAN,
	HIERARCHY_ACTIVE,
	HIERARCHY_ACTIVE_IN_THESAURUS,
	HIERARCHY_FILTER,
	HIERARCHY_GENERAL_TERM,
	HIERARCHY_LANG,
	HIERARCHY_TARGET_SECTION,
	HIERARCHY_TERM,
	HIERARCHY_TLD,
	HIERARCHY_TYPES_NAME,
	HIERARCHY_TYPES_SECTION,
	HIERARCHY_TYPOLOGY,
	ONTOLOGY_DEPENDENCIES,
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
	RELATION_TYPE_CHILDREN,
	RELATION_TYPE_LINK,
	RELATION_TYPE_PARENT,
	SECTION_MODEL_TIPO,
	SI_NO_NO,
	SI_NO_YES,
	STRUCTURE_LANG,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import { getTermIdFromLocator, parseSectionRecordToOntologyNode } from './parser.ts';
import { getMatrixTableFromTipo } from './resolver.ts';
import {
	getSectionIdFromTipo,
	getTldFromTipo,
	LOCAL_ONTOLOGY_SECTION,
	mapTldToTargetSectionTipo,
	safeTld,
} from './tld.ts';

const RELATION_TYPE_FILTER = 'dd675'; // DEDALO_RELATION_TYPE_FILTER
const LANG_SECTION = 'lg1';
const LANG_SPA_ID = '17344'; // lg-spa id in lg1

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
 * insert_dd_ontology_record). Returns the node tipo, or null when the record is
 * invalid (missing TLD).
 */
export async function insertDdOntologyRecord(
	sectionTipo: string,
	sectionId: number | string,
): Promise<string | null> {
	const node = await parseSectionRecordToOntologyNode(sectionTipo, sectionId);
	if (node === null) {
		return null;
	}
	await upsertDdOntologyNode(node);
	return node.tipo;
}

// --- root node (PHP create_dd_ontology_ontology_section_node) -----------------

export interface FileItem {
	tld: string;
	section_tipo?: string;
	typology_id?: number | null;
	name_data?: { id?: number; lang?: string; value?: unknown }[] | null;
	parent_grouper_tipo?: string | null;
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
	const nameData = fileItem.name_data ??
		(await getMainNameData(tld)) ?? [{ lang: STRUCTURE_LANG, value: tld }];
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
	};
	await upsertDdOntologyNode(node);
	return tipo;
}

// --- add main section (PHP add_main_section) ---------------------------------

/**
 * THE one per-key writer of the ontology REGISTRY rows (matrix_ontology_main,
 * ontology35): addMainSection's registry components and writeDeclaredDependencies'
 * ddengine11 locators. Unstamped, no TM — registry definition rows, as in PHP
 * add_main_section (a sanctioned derived writer, write_obligations RAW_CALLER_EXEMPT).
 */
function writeOntologyMainKey(
	mainSectionId: number,
	column: 'relation' | 'string',
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
 * Idempotently create/update the matrix_ontology_main record for a TLD (PHP
 * add_main_section). Reuses the existing row (matched by hierarchy6) or creates a
 * new ontology35 record, then writes the registry components. Returns section_id.
 */
export async function addMainSection(fileItem: FileItem, userId = -1): Promise<number | null> {
	const tld = fileItem.tld;
	const targetSectionTipo = fileItem.section_tipo ?? mapTldToTargetSectionTipo(tld);
	const typologyId = fileItem.typology_id ?? null;
	const nameData = fileItem.name_data ?? [literalItem(1, STRUCTURE_LANG, tld)];

	const existing = await getOntologyMainFromTld(tld);
	const mainSectionId =
		existing !== null
			? existing.section_id
			: await createSectionRecord(ONTOLOGY_MAIN_SECTION, userId);
	const write = (column: 'relation' | 'string', tipo: string, value: unknown): Promise<void> =>
		writeOntologyMainKey(mainSectionId, column, tipo, value);

	// Project filter (dd153/1)
	await write('relation', HIERARCHY_FILTER, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_FILTER,
			section_tipo: PROJECTS_SECTION,
			section_id: '1',
			from_component_tipo: HIERARCHY_FILTER,
		}),
	]);
	// Active in thesaurus (only 'dd' → yes by default)
	await write('relation', HIERARCHY_ACTIVE_IN_THESAURUS, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_tipo: SI_NO_SECTION,
			section_id: tld === 'dd' ? SI_NO_YES : SI_NO_NO,
			from_component_tipo: HIERARCHY_ACTIVE_IN_THESAURUS,
		}),
	]);
	// Language (lg-spa)
	await write('relation', HIERARCHY_LANG, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: LANG_SECTION,
			section_id: LANG_SPA_ID,
			from_component_tipo: HIERARCHY_LANG,
		}),
	]);
	// Active (yes)
	await write('relation', HIERARCHY_ACTIVE, [
		relationLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: SI_NO_SECTION,
			section_id: SI_NO_YES,
			from_component_tipo: HIERARCHY_ACTIVE,
		}),
	]);
	// Name (multilingual) — normalize to {id:1, lang, value} items.
	const nameItems = (nameData as { id?: number; lang?: string; value?: unknown }[])
		.filter(
			(item): item is { id?: number; lang: string; value: unknown } =>
				typeof item.lang === 'string',
		)
		.map((item) => literalItem(item.id ?? 1, item.lang, String(item.value ?? '')));
	if (nameItems.length > 0) {
		await write('string', HIERARCHY_TERM, nameItems);
	}
	// TLD
	await write('string', HIERARCHY_TLD, [literalItem(1, DATA_NOLAN, tld)]);
	// Target section tipo
	await write('string', HIERARCHY_TARGET_SECTION, [literalItem(1, DATA_NOLAN, targetSectionTipo)]);
	// Typology (optional; PHP omits the item id here)
	if (typologyId !== null && typologyId !== undefined && Number(typologyId) > 0) {
		await write('relation', HIERARCHY_TYPOLOGY, [
			relationLocator({
				type: RELATION_TYPE_LINK,
				section_tipo: HIERARCHY_TYPES_SECTION,
				section_id: typologyId,
				from_component_tipo: HIERARCHY_TYPOLOGY,
			}),
		]);
	}
	// Root children (only 'dd': nodes 1 and 2)
	if (tld === 'dd') {
		await write('relation', HIERARCHY_GENERAL_TERM, [
			relationLocator({
				id: 1,
				type: RELATION_TYPE_CHILDREN,
				section_tipo: targetSectionTipo,
				section_id: '1',
				from_component_tipo: HIERARCHY_GENERAL_TERM,
			}),
			relationLocator({
				id: 2,
				type: RELATION_TYPE_CHILDREN,
				section_tipo: targetSectionTipo,
				section_id: '2',
				from_component_tipo: HIERARCHY_GENERAL_TERM,
			}),
		]);
	}

	return mainSectionId;
}

// --- declared dependencies (ddengine11, installer unification A5) ------------

/**
 * Write an imported ontology's DECLARED dependencies onto its registry record
 * (component ddengine11 ONTOLOGY_DEPENDENCIES): one link locator per dependency
 * TLD that has a registry record HERE, in declared order — REPLACING what the
 * record held (the source's declaration is the ontology's, like the rows the
 * import just replaced). The census (data_io.ts getActiveOntologies) reads it
 * back, so an ontology server that obtained its ontologies by import re-serves
 * the declaration instead of dropping it after one hop.
 *
 * Same write shape as addMainSection (per-key matrix write, no TM — the import's
 * registry writes are not audited records edits). Answers the dependency TLDs
 * with no local registry record (not written — the caller reports them), or
 * null when `tld` itself has no registry record (nothing written).
 */
export async function writeDeclaredDependencies(
	tld: string,
	dependencies: readonly string[],
): Promise<string[] | null> {
	const own = await getOntologyMainFromTld(tld);
	if (own === null) return null;
	const locators: Record<string, unknown>[] = [];
	const missing: string[] = [];
	for (const dependency of dependencies) {
		const target = await getOntologyMainFromTld(dependency);
		if (target === null) missing.push(dependency);
		else locators.push(dependencyLocator(locators.length + 1, target.section_id));
	}
	await writeOntologyMainKey(own.section_id, 'relation', ONTOLOGY_DEPENDENCIES, locators);
	return missing;
}

/** One ddengine11 locator: a link to an ontology35 registry record. */
function dependencyLocator(id: number, sectionId: number): Record<string, unknown> {
	return relationLocator({
		id,
		type: RELATION_TYPE_LINK,
		section_tipo: ONTOLOGY_MAIN_SECTION,
		section_id: sectionId,
		from_component_tipo: ONTOLOGY_DEPENDENCIES,
	});
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
 * Ensure a typology grouper node exists in dd_ontology + the matrix and return
 * its tipo (PHP create_parent_grouper). Resilient to partial-bootstrap: creates
 * the grouper's own TLD registration, the `<parentTld>0` parent node/record, and
 * the typology matrix node `<tld><typologyId>` on demand.
 *
 * Groupers: ontology → ('ontology40','ontologytype'); hierarchy →
 * ('hierarchy56','hierarchytype'); hierarchy-model → ('hierarchy57','hierarchymtype').
 */
export async function createParentGrouper(
	parentGroup: string,
	tld: string,
	typologyId: number,
	userId = -1,
): Promise<string> {
	const nameData = grouperNameData(tld);
	const fileData: FileItem = {
		tld,
		typology_id: typologyId,
		name_data: nameData,
		parent_grouper_tipo: 'ontologytype14', // fixed — prevents grouper recursion
	};

	// Register the grouper's own TLD (matrix_ontology_main + <groupTld>0 node).
	await addMainSection(fileData, userId);
	await createDdOntologyRootNode(fileData, userId);

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
	/**
	 * Deliberate WHOLE-SECTION rebuild. Opt-in and greppable ON PURPOSE: this is
	 * the only way to reach the unbounded scan, so no request that merely OMITS a
	 * parameter can trigger it. Internal rebuild callers only (an ontology-file
	 * import re-deriving a whole TLD's flat index) — never a user-facing action.
	 */
	wholeSection?: boolean;
	userId?: number;
}

/** The record ids a target states (one id, a list, or the whole section); null = no scope stated. */
async function scopedRecordIds(target: SetRecordsTarget, table: string): Promise<number[] | null> {
	if (target.sectionId !== undefined && target.sectionId !== null) {
		return [Number(target.sectionId)];
	}
	if (target.sectionIds !== undefined) return target.sectionIds.map((id) => Number(id));
	if (target.wholeSection !== true) return null;
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${table}" WHERE section_tipo = $1 ORDER BY section_id ASC`,
		[target.sectionTipo],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
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
 * writing). A caller now states its scope: one id, an explicit id list, or
 * `wholeSection: true`.
 */
export async function setRecordsInDdOntology(
	target: SetRecordsTarget,
): Promise<OntologyWriteResponse> {
	const userId = target.userId ?? -1;
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

	const table = await getMatrixTableFromTipo(target.sectionTipo);
	if (table === null) {
		response.errors.push(`no matrix table for '${target.sectionTipo}'`);
		return response;
	}

	// Resolve the record ids to process — see the scope contract in the doc above.
	const ids = await scopedRecordIds(target, table);
	if (ids === null) {
		// No scope stated: refuse LOUDLY rather than guess "all" (WC-043).
		response.errors.push(
			'no scope: pass sectionId, an explicit sectionIds list, or wholeSection:true',
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
		if (target.sectionTipo === ONTOLOGY_MAIN_SECTION) {
			const tld = await getMainTld(sectionId, target.sectionTipo);
			const activeTlds = await getActiveTlds();
			if (tld === null || !activeTlds.includes(tld)) {
				const safe = tld === null ? null : safeTld(tld);
				if (safe === null) {
					response.errors.push(`Invalid TLD for deletion: ${tld}`);
					continue;
				}
				const deleted = await deleteTldNodes(safe);
				if (!deleted) {
					response.errors.push(`Unable to delete TLD nodes for: ${tld}`);
					continue;
				}
				termId = `${safe}0`;
			} else {
				const typologyId = await getMainTypologyId(tld);
				const nameData = await getMainNameData(tld);
				termId = await createDdOntologyRootNode(
					{
						tld,
						typology_id: typologyId,
						name_data: nameData,
						parent_grouper_tipo: `${ONTOLOGY_TYPE_TLD}${typologyId}`,
					},
					userId,
				);
			}
		} else {
			termId = await insertDdOntologyRecord(target.sectionTipo, sectionId);
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
