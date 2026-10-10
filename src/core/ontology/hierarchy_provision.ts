/**
 * Hierarchy provisioning — PHP hierarchy::generate_virtual_section (:228) +
 * provision_virtual_sections (:459) + create_thesaurus_general_term (:1899).
 *
 * A "hierarchy" (a controlled vocabulary, master record in matrix_hierarchy_main
 * / hierarchy1) is turned into two runtime VIRTUAL sections:
 *   <tld>1 — descriptors (the actual terms)
 *   <tld>2 — models/typologies
 * plus their dd_ontology nodes, a user permission grant, and the hierarchy53/58
 * target-section pointers written back on the hierarchy1 record.
 *
 * generate_virtual_section runs pre-tx VALIDATIONS in PHP's exact order, then the
 * entire write phase inside ONE withTransaction — a mid-sequence throw rolls the
 * whole thing back so a half-built hierarchy is never committed (parity with PHP
 * DBi::transaction). createSectionRecord acquires the per-tipo counter lock inside
 * that tx, so the wrapper is also required for concurrency.
 *
 * BYTE PINS (verified against PHP):
 *  - descriptor ontology7 tld item uses lang lg-spa (DEDALO_DATA_LANG); the
 *    matrix_ontology_main tld item (createMainSection) uses lg-nolan — different.
 *  - the ontology15 parent locator written here is BARE {section_tipo, section_id}
 *    (no type/from_component_tipo) — pinned.
 *  - hierarchy53/58 items are {id:1, lang:lg-nolan, value:<tld>1|<tld>2}.
 *
 * LEDGER:
 *  - set_section_permissions is PORTED (security/section_permissions.ts): the
 *    creating user's PROFILE is granted level 2 over <tld>1 / <tld>2 and every
 *    element inside them, so the new hierarchy is visible to them immediately.
 *    Still NON-FATAL by PHP contract — a failed grant collects an error and
 *    provisioning continues rather than rolling back.
 *  - createThesaurusGeneralTerm seeds the portal element (target record + link
 *    locator); it does NOT rename the new term after the hierarchy (PHP
 *    set_term_value) — deferred/ledgered; the seed itself is what the tree needs.
 */

import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { updateMatrixKeyData, updateMatrixRecord } from '../db/matrix_write.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import { setSectionPermissions } from '../security/section_permissions.ts';
import { clearOntologyDerivedCaches } from './cache_invalidation.ts';
import {
	DATA_NOLAN,
	HIERARCHY_ACTIVE,
	HIERARCHY_MODEL_TYPE_GROUP,
	HIERARCHY_MODEL_TYPE_TLD,
	HIERARCHY_SOURCE_REAL_SECTION,
	HIERARCHY_TARGET_SECTION,
	HIERARCHY_TARGET_SECTION_MODEL,
	HIERARCHY_TERM,
	HIERARCHY_TLD,
	HIERARCHY_TYPE_GROUP,
	HIERARCHY_TYPE_TLD,
	HIERARCHY_TYPOLOGY,
	ONTOLOGY_CONNECTED_TO,
	ONTOLOGY_IS_DESCRIPTOR,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MODEL,
	ONTOLOGY_PARENT,
	ONTOLOGY_PUBLICATION,
	ONTOLOGY_TERM,
	ONTOLOGY_TLD,
	ONTOLOGY_TRANSLATABLE,
	RELATION_TYPE_LINK,
	SI_NO_NO,
	SI_NO_YES,
	STRUCTURE_LANG,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import {
	createDdOntologyRootNode,
	createParentGrouper,
	ensureMainSection,
	insertDdOntologyRecord,
} from './ontology_write.ts';
import { getMatrixTableFromTipo, getModelByTipo } from './resolver.ts';
import { getSectionIdFromTipo, getTldFromTipo, mapTldToTargetSectionTipo } from './tld.ts';

const MATRIX_ONTOLOGY = 'matrix_ontology';

export interface GenerateVirtualSectionOptions {
	section_id: number;
	section_tipo: string;
	userId?: number;
}

export interface GenerateVirtualSectionResponse {
	/** INTERNAL outcome discriminator (never a wire body). */
	ok: boolean;
	msg: string;
	errors: string[];
}

/**
 * A stored relation locator (matrix byte shape). The section_id is minted in
 * CANONICAL INT form — WC-2026-08-10-section-id-int-canonical repeals the
 * former "always a STRING in the matrix" law of this builder. Canonicalization,
 * never String()/Number(): a numeric literal or numeric string becomes an int,
 * while anything that is not a record address (an external remote id, or the
 * `''` an unresolved tipo yields) is preserved verbatim rather than corrupted.
 */
function relLocator(fields: {
	id?: number;
	type: string;
	section_tipo: string;
	// KEPT UNION: callers feed tipo-derived ids (getSectionIdFromTipo returns the
	// digits of 'dd47' as a STRING) and the `''` an unresolved tipo yields — the
	// canonicalization below is exactly what turns the first into an int and
	// preserves the second, so the door must accept both.
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

/**
 * Provision the two virtual sections + dd_ontology nodes for a hierarchy1 record
 * (PHP hierarchy::generate_virtual_section). Validations first, then ONE tx.
 */
export async function generateVirtualSection(
	options: GenerateVirtualSectionOptions,
): Promise<GenerateVirtualSectionResponse> {
	const userId = options.userId ?? -1;
	const sectionTipo = options.section_tipo;
	const sectionId = Number(options.section_id);
	const response: GenerateVirtualSectionResponse = {
		ok: false,
		msg: 'Error. Request failed ',
		errors: [],
	};

	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		response.errors.push(`no matrix table for '${sectionTipo}'`);
		return response;
	}
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	if (record === null) {
		response.errors.push(`hierarchy record not found: ${sectionTipo}/${sectionId}`);
		return response;
	}
	const relation = (record.columns.relation as Record<string, unknown[]> | null) ?? {};
	const stringCol = (record.columns.string as Record<string, unknown[]> | null) ?? {};

	// 1. active (hierarchy4 → dd64/1, loose ==)
	const activeLocator = (
		relation[HIERARCHY_ACTIVE] as { section_tipo?: string; section_id?: unknown }[] | undefined
	)?.[0];
	if (
		activeLocator === undefined ||
		activeLocator.section_tipo !== YES_NO_SECTION ||
		Number(activeLocator.section_id) !== SI_NO_YES
	) {
		response.msg += 'Current hierarchy is not active';
		response.errors.push(`Empty hierarchy active value: ${HIERARCHY_ACTIVE}`);
		return response;
	}

	// 2. tld (hierarchy6, lowercased)
	const tldValue = (stringCol[HIERARCHY_TLD] as { value?: unknown }[] | undefined)?.[0]?.value;
	const tld2 = tldValue ? String(tldValue).toLowerCase() : '';
	if (tld2 === '') {
		response.msg += 'Error on get tld2. Empty value (tld is mandatory)';
		response.errors.push(`Empty hierarchy tld value: ${HIERARCHY_TLD}`);
		return response;
	}

	// 3. source real section (hierarchy109) — non-empty AND model === 'section'
	const realSectionTipoValue = (
		stringCol[HIERARCHY_SOURCE_REAL_SECTION] as { value?: unknown }[] | undefined
	)?.[0]?.value;
	const realSectionTipo = realSectionTipoValue ? String(realSectionTipoValue) : '';
	if (realSectionTipo === '') {
		response.msg +=
			'Error on get source_real_section_tipo. Empty value (source_real_section_tipo is mandatory)';
		response.errors.push(`Empty source section_tipo value: ${HIERARCHY_SOURCE_REAL_SECTION}`);
		return response;
	}
	const realSectionModel = await getModelByTipo(realSectionTipo);
	if (realSectionModel !== 'section') {
		response.msg +=
			'Error on get source_real_section_tipo. Invalid model (only sections tipo are valid)';
		response.errors.push(`Invalid source section_tipo model: ${realSectionModel}`);
		return response;
	}

	// 4. typology (hierarchy9 → int section_id >= 1)
	const typologyLocator = (
		relation[HIERARCHY_TYPOLOGY] as { section_id?: unknown }[] | undefined
	)?.[0];
	const typologyId =
		typologyLocator?.section_id !== undefined ? Math.trunc(Number(typologyLocator.section_id)) : 0;
	if (typologyId < 1) {
		response.msg += 'Error on get typology. Empty value (typology is mandatory)';
		response.errors.push('Invalid typology');
		return response;
	}

	// 4b. NOT ALREADY PROVISIONED. The virtual sections are created with FIXED
	// record ids (<tld>0/1 descriptor, <tld>0/2 model), so a second Generate on
	// the same tld collides on matrix_ontology's (section_id, section_tipo) unique
	// key — the raw PostgresError used to reach the operator's screen. Refuse
	// before the write phase and name the way forward: the teardown is what
	// `force_to_create` runs (tool_hierarchy → deleteOntologyByTld), so once it
	// has swept the tld this check passes and the rebuild proceeds.
	const nodesSection = mapTldToTargetSectionTipo(tld2);
	const existingNodes = (await sql.unsafe(
		`SELECT section_id FROM "${MATRIX_ONTOLOGY}" WHERE section_tipo = $1 LIMIT 1`,
		[nodesSection],
	)) as { section_id: number }[];
	if (existingNodes.length > 0) {
		response.msg = `Error. Hierarchy '${tld2}' is already generated`;
		response.errors.push(
			`virtual section '${nodesSection}' already exists — use 'Force to create' to rebuild it`,
		);
		return response;
	}

	// 5. name (hierarchy5 all langs; fallback 'Hierarchy <tld>')
	const nameItems =
		(stringCol[HIERARCHY_TERM] as { id?: number; lang?: string; value?: unknown }[] | undefined) ??
		[];
	const nameData = nameItems
		.filter(
			(item): item is { id?: number; lang: string; value: unknown } =>
				typeof item.lang === 'string',
		)
		.map((item) => ({ id: item.id ?? 1, lang: item.lang, value: String(item.value ?? '') }));

	// --- write phase, ONE transaction (rollback on any throw) ---
	try {
		await withTransaction(async () => {
			await provisionVirtualSections({
				tld2,
				typologyId,
				realSectionTipo,
				nameData,
				hierarchySectionId: sectionId,
				hierarchySectionTipo: sectionTipo,
				hierarchyTable: table,
				userId,
				response,
			});
		});
	} catch (error) {
		// The rolled-back writes are gone from the DB, but the reads they fed
		// (model/children/real-tipo lookups over the half-built <tld> nodes, now
		// especially the grant's element walk) have already populated the
		// ontology-derived caches with rows that no longer exist. Drop them, or
		// the next request resolves a phantom hierarchy.
		await clearOntologyDerivedCaches();
		response.ok = false;
		response.msg = 'Error. Hierarchy provisioning failed and was rolled back';
		response.errors.push(String(error));
		return response;
	}

	response.ok = true;
	response.msg =
		response.errors.length === 0 ? 'Request done successfully' : 'Request done with errors';
	return response;
}

interface ProvisionArgs {
	tld2: string;
	typologyId: number;
	realSectionTipo: string;
	nameData: { id?: number; lang: string; value: string }[];
	hierarchySectionId: number;
	hierarchySectionTipo: string;
	/** The registry record's OWN matrix table (hierarchy1 → matrix_hierarchy_main,
	 * ontology35 → matrix_ontology_main) — PHP resolves it from the section tipo. */
	hierarchyTable: string;
	userId: number;
	response: GenerateVirtualSectionResponse;
}

/** Write phase of generate_virtual_section (PHP provision_virtual_sections). */
async function provisionVirtualSections(args: ProvisionArgs): Promise<void> {
	const {
		tld2,
		typologyId,
		realSectionTipo,
		nameData,
		hierarchySectionId,
		hierarchySectionTipo,
		hierarchyTable,
		userId,
		response,
	} = args;
	const nodeSectionTipo = `${tld2}0`;

	// ontology main + root node. The registry-row law (ontology_write.ts): the
	// row is CREATED from this hierarchy's typology + name when the TLD has
	// none; an existing row is the installation's and is not rewritten — the
	// root node is then built from what the row holds (createDdOntologyRootNode
	// reads typology + name off it when the item omits them).
	await ensureMainSection({ tld: tld2, typology_id: typologyId, name_data: nameData }, userId);
	await createDdOntologyRootNode({ tld: tld2 }, userId);

	// --- descriptor section <tld>0 / 1 ---
	await createSectionRecord(nodeSectionTipo, userId, new Date(), 1);
	const writeDescriptor = (
		column: 'relation' | 'string',
		tipo: string,
		value: unknown,
	): Promise<void> => updateMatrixKeyData(MATRIX_ONTOLOGY, nodeSectionTipo, 1, column, tipo, value);

	await writeDescriptor('relation', ONTOLOGY_PUBLICATION, [
		relLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: SI_NO_YES,
			from_component_tipo: ONTOLOGY_PUBLICATION,
		}),
	]);
	await writeDescriptor('relation', ONTOLOGY_IS_DESCRIPTOR, [
		relLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: SI_NO_YES,
			from_component_tipo: ONTOLOGY_IS_DESCRIPTOR,
		}),
	]);
	// is_model (ontology30) intentionally NOT written for the descriptor (defaults NO).
	await writeDescriptor('relation', ONTOLOGY_MODEL, [
		relLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: 'dd0',
			section_id: 6, // dd0/6 = model 'section' (int-canonical)
			from_component_tipo: ONTOLOGY_MODEL,
		}),
	]);
	await writeDescriptor('relation', ONTOLOGY_TRANSLATABLE, [
		relLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: SI_NO_NO,
			from_component_tipo: ONTOLOGY_TRANSLATABLE,
		}),
	]);
	// connected-to → the real source section node <realTld>0/<realId>
	const relationSectionTipo = `${getTldFromTipo(realSectionTipo)}0`;
	const relationSectionId = getSectionIdFromTipo(realSectionTipo);
	await writeDescriptor('relation', ONTOLOGY_CONNECTED_TO, [
		relLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: relationSectionTipo,
			section_id: relationSectionId ?? '',
			from_component_tipo: ONTOLOGY_CONNECTED_TO,
		}),
	]);
	// tld — lang lg-spa (DEDALO_DATA_LANG) — DIFFERS from createMainSection's lg-nolan
	await writeDescriptor('string', ONTOLOGY_TLD, [{ id: 1, lang: STRUCTURE_LANG, value: tld2 }]);
	// name
	if (nameData.length > 0) {
		await writeDescriptor(
			'string',
			ONTOLOGY_TERM,
			nameData.map((item) => ({ id: item.id ?? 1, lang: item.lang, value: item.value })),
		);
	}

	// parent grouper (hierarchytype) → BARE parent locator on <tld>0/1
	const descriptorGrouperTipo = await createParentGrouper(
		HIERARCHY_TYPE_GROUP,
		HIERARCHY_TYPE_TLD,
		typologyId,
		userId,
	);
	const descriptorParentNodeTipo = `${getTldFromTipo(descriptorGrouperTipo)}0`;
	const descriptorParentSectionId = getSectionIdFromTipo(descriptorGrouperTipo);
	await writeDescriptor('relation', ONTOLOGY_PARENT, [
		// BARE parent locator, section_id in canonical INT form (WC-2026-08-10).
		{
			section_tipo: descriptorParentNodeTipo,
			section_id: canonicalizeStoredSectionId(descriptorParentSectionId ?? ''),
		},
	]);
	if ((await insertDdOntologyRecord(nodeSectionTipo, 1)) === null) {
		throw new Error(`insert_dd_ontology_record failed for descriptor: ${nodeSectionTipo}/1`);
	}

	// --- model section <tld>0 / 2 (copy of record 1, is_model flipped) ---
	await createSectionRecord(nodeSectionTipo, userId, new Date(), 2);
	const record1 = await readMatrixRecord(MATRIX_ONTOLOGY, nodeSectionTipo, 1);
	if (record1 !== null) {
		// copy the ontology component columns from record 1 to record 2
		const copyValues: Record<string, unknown> = {};
		for (const column of ['relation', 'string', 'number', 'misc'] as const) {
			const value = record1.columns[column];
			if (value !== null && value !== undefined) copyValues[column] = value;
		}
		if (Object.keys(copyValues).length > 0) {
			await updateMatrixRecord(MATRIX_ONTOLOGY, nodeSectionTipo, 2, copyValues as never);
		}
	}
	const writeModel = (column: 'relation' | 'string', tipo: string, value: unknown): Promise<void> =>
		updateMatrixKeyData(MATRIX_ONTOLOGY, nodeSectionTipo, 2, column, tipo, value);
	// flip is_model → YES
	await writeModel('relation', ONTOLOGY_IS_MODEL, [
		relLocator({
			id: 1,
			type: RELATION_TYPE_LINK,
			section_tipo: YES_NO_SECTION,
			section_id: SI_NO_YES,
			from_component_tipo: ONTOLOGY_IS_MODEL,
		}),
	]);
	// parent grouper (hierarchymtype) → BARE parent locator on <tld>0/2
	const modelGrouperTipo = await createParentGrouper(
		HIERARCHY_MODEL_TYPE_GROUP,
		HIERARCHY_MODEL_TYPE_TLD,
		typologyId,
		userId,
	);
	const modelParentNodeTipo = `${getTldFromTipo(modelGrouperTipo)}0`;
	const modelParentSectionId = getSectionIdFromTipo(modelGrouperTipo);
	await writeModel('relation', ONTOLOGY_PARENT, [
		// BARE parent locator, section_id in canonical INT form (WC-2026-08-10).
		{
			section_tipo: modelParentNodeTipo,
			section_id: canonicalizeStoredSectionId(modelParentSectionId ?? ''),
		},
	]);
	if ((await insertDdOntologyRecord(nodeSectionTipo, 2)) === null) {
		throw new Error(`insert_dd_ontology_record failed for model: ${nodeSectionTipo}/2`);
	}

	// --- user permission grant (PHP class.hierarchy.php:745-761) ---
	// Allow the user who just created the hierarchy to actually SEE it: grant
	// their profile level 2 over the two new virtual sections and everything in
	// them. NON-FATAL by PHP contract — a failed grant does not roll the
	// provisioning back (the sections are valid; an admin can re-grant), so the
	// error is collected and we continue. A THROW would roll back the whole
	// transaction, hence the catch.
	try {
		const granted = await setSectionPermissions({
			sectionTipos: [`${tld2}1`, `${tld2}2`],
			userId,
			permissions: 2,
		});
		if (granted.ok !== true) {
			response.errors.push(`Error setting permissions for current user: ${granted.error}`);
		}
	} catch (error) {
		response.errors.push(`Error setting permissions for current user: ${String(error)}`);
	}

	// --- target-section pointers written back on the registry record ---
	// PHP saves the hierarchy53/58 components ON $section_tipo (class.hierarchy.php
	// :766-800), so the table is the registry record's own (hierarchy1 →
	// matrix_hierarchy_main). Hardcoding matrix_ontology_main here made the
	// write-back a silent no-op for hierarchy1-driven provisioning (caught by
	// test/unit/hierarchy_provision_native.test.ts).
	//
	// FILL-ONLY (2026-08-22). This used to write the `<tld>1`/`<tld>2` convention
	// UNCONDITIONALLY, which made provisioning the one place that destroyed
	// operator data: hierarchy53/58 are the sections the operator declares, a
	// hierarchy may legitimately pair foreign ones (live: 'WW' → `mht72`), and
	// the model-section resolver (ontology/model_section.ts) READS that pairing.
	// So provisioning a hierarchy silently repointed it at `<tld>1` and every
	// component_relation_model derived from it followed. Same law as
	// `ensureTargetSectionDefaults` in hierarchy_state.ts: DEFAULT when unset,
	// never overwrite.
	const declared = (await sql.unsafe(
		`SELECT string FROM "${hierarchyTable}" WHERE section_tipo = $1 AND section_id = $2`,
		[hierarchySectionTipo, hierarchySectionId],
	)) as { string: Record<string, { value?: unknown }[]> | null }[];
	const declaredValue = (tipo: string): string =>
		String(declared[0]?.string?.[tipo]?.[0]?.value ?? '');
	for (const [tipo, fallback] of [
		[HIERARCHY_TARGET_SECTION, `${tld2}1`],
		[HIERARCHY_TARGET_SECTION_MODEL, `${tld2}2`],
	] as [string, string][]) {
		if (declaredValue(tipo) !== '') continue;
		await updateMatrixKeyData(
			hierarchyTable,
			hierarchySectionTipo,
			hierarchySectionId,
			'string',
			tipo,
			[{ id: 1, lang: DATA_NOLAN, value: fallback }],
		);
	}
}
