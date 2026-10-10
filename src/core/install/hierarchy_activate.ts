/**
 * activate_hierarchy (PHP installer_hierarchy_manager::activate_hierarchy).
 *
 * Importing a hierarchy's `<tld>1.copy.gz` only lands the TERM DATA in matrix_hierarchy.
 * On its own that data is UNREACHABLE: `<tld>1` is not a section the engine knows about
 * until its ontology exists, and the hierarchy1 registry record is not flagged active —
 * so the thesaurus tree shows nothing, and the portals that resolve their targets from
 * the ACTIVE hierarchies resolve an empty target_sections.
 *
 * This module owns exactly ONE thing PHP's activate_hierarchy also did and the shared
 * writer cannot know: the DESCRIPTOR. The vendored thesaurus manifest (hierarchy.json,
 * read through hierarchy_meta.ts; WC-2026-10-10-hierarchy-json-manifest) says what a tld
 * IS, and since 2026-10-10 the seed ships NO optional registry row (only the core `lg`
 * one) — so a fresh install has no registry record for any optional thesaurus and we
 * CREATE it from the entry: hierarchy6 tld, hierarchy5 name (every item), hierarchy9
 * typology, hierarchy8 lang (lg1/<lang.section_id> — the lg1 record must EXIST, or the
 * activation is refused before anything is written: no fallback language; the hierarchy13
 * typology record must exist too, and a named hierarchy109 must be a section HERE — the
 * whole check is `activationBlocker`, which the importer runs BEFORE it copies a single
 * term), hierarchy109 real section (when the entry names one; ensure defaults an empty one), hierarchy61
 * scope note, misc.hierarchy60 declared dependencies (the component_json shape of THE
 * shared normalizer). The creation is ONE transaction: a refused write leaves no
 * half-described row. Everything after that (flags, ontology, target sections, the
 * general-term roots) is the SAME invariant the tool converges to, so it is delegated to
 * ontology/hierarchy_state.ts `ensureHierarchy` — the single writer. The installer used
 * to re-implement that sequence with hard-coded `<tld>1`/1 and `<tld>2`/2 locators, which
 * dangle on any thesaurus whose root is not at those ids (live: `es2` has no records).
 *
 * An EXISTING registry row is never re-described: re-activating a hierarchy must never
 * clobber operator-edited metadata (PHP comment) — only ensureHierarchy runs on it.
 *
 * CORE HIERARCHIES (A7, 2026-10-08): `activateCoreHierarchies` converges every
 * CORE_HIERARCHIES descriptor (today `lg`) through `activateCoreHierarchy` — with NO import in front of it. Their
 * terms ship in the seed, in their own table (21,705 `lg1` rows in matrix_langs), and the
 * seed's registry record (hierarchy1 for tld `lg`) arrives inactive: hierarchy4 = No,
 * hierarchy125 = No, no hierarchy59 model root. Measured on the suite DB (rolled back):
 * one activation applied 'flagged active', 'active in thesaurus: Yes' and 'hierarchy59:
 * linked the existing root lg2/2', with zero lg rows in matrix_hierarchy, and the
 * hierarchy then inspected usable (root lg1/1 resolved in matrix_langs). The seed
 * restore calls it (db_restore.ts), so every surface that restores the seed gets
 * Languages active. A core hierarchy is NEVER created here: the seed ships its registry
 * row, and a database without it is refused (the seed restore is what to repair).
 */

import { updateMatrixKeyData } from '../db/matrix_write.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import {
	ensureHierarchy,
	HIERARCHY_SECTION,
	provisionBlocker,
	type RegistryRow,
} from '../ontology/hierarchy_state.ts';
import {
	dependenciesMiscItems,
	HIERARCHY_DEPENDENCIES,
} from '../ontology/ontology_dependencies.ts';
import {
	HIERARCHY_LANG,
	HIERARCHY_SCOPE_NOTE,
	HIERARCHY_SOURCE_REAL_SECTION,
	HIERARCHY_TERM,
	HIERARCHY_TLD,
	HIERARCHY_TYPES_SECTION,
	HIERARCHY_TYPOLOGY,
	RELATION_TYPE_LINK,
} from '../ontology/ontology_tipos.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import { CORE_HIERARCHIES, type CoreHierarchy, type HierarchyMeta } from './hierarchy_meta.ts';
import { refuseInstall } from './refuse.ts';

const HIERARCHY_MAIN_TABLE = 'matrix_hierarchy_main';
/** The langs section hierarchy8 points into (its records live in matrix_langs). */
const LANGS_SECTION = 'lg1';

export interface ActivateHierarchyResult {
	/** INTERNAL outcome (never a wire body): did the activation converge? */
	ok: boolean;
	created: boolean;
	sectionId: number | null;
	errors: string[];
	/** What ensureHierarchy had to change (empty when the hierarchy was already sound). */
	applied: string[];
}

/** The hierarchy1 record for this tld, or null (PHP hierarchy::get_hierarchy_by_tld). */
async function findHierarchyByTld(tld: string): Promise<number | null> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${HIERARCHY_MAIN_TABLE}"
		 WHERE section_tipo = $1
		   AND lower(string->'${HIERARCHY_TLD}'->0->>'value') = $2
		 ORDER BY section_id
		 LIMIT 1`,
		[HIERARCHY_SECTION, tld],
	)) as { section_id: number }[];
	return rows[0] ? Number(rows[0].section_id) : null;
}

/** A fresh activation outcome (nothing converged yet). */
function newOutcome(): ActivateHierarchyResult {
	return { ok: false, created: false, sectionId: null, errors: [], applied: [] };
}

/**
 * Does the record `sectionTipo`/`sectionId` exist, in whatever table the
 * section resolves to? A section that resolves NO table (not in this
 * installation's ontology) has no records.
 */
async function recordExists(sectionTipo: string, sectionId: number): Promise<boolean> {
	if (!Number.isInteger(sectionId) || sectionId < 1) return false;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return false;
	const rows = (await sql.unsafe(
		`SELECT 1 FROM "${table}" WHERE section_tipo = $1 AND section_id = $2 LIMIT 1`,
		[sectionTipo, sectionId],
	)) as unknown[];
	return rows.length > 0;
}

/**
 * The registry row the entry WOULD create, as provisionBlocker reads one — so
 * the one statement of the provisioning rule (hierarchy_state.ts) judges the
 * entry before anything is written.
 */
function prospectiveRow(meta: HierarchyMeta): RegistryRow {
	return {
		string: {
			[HIERARCHY_TLD]: [{ value: meta.tld }],
			...(meta.real_section_tipo === null
				? {}
				: { [HIERARCHY_SOURCE_REAL_SECTION]: [{ value: meta.real_section_tipo }] }),
		},
		relation: {
			[HIERARCHY_TYPOLOGY]: registryLink(
				HIERARCHY_TYPOLOGY,
				HIERARCHY_TYPES_SECTION,
				meta.typology_id,
			),
		},
	};
}

/**
 * Why the entry cannot describe a NEW registry row of THIS installation, or
 * null. Every reference the entry carries must resolve HERE — the manifest
 * was exported by another installation, and its reader can only check the
 * file against itself:
 *   - hierarchy8: the lg1 record `lang.section_id` exists (no fallback
 *     language — a guessed one files the thesaurus under the wrong language);
 *   - hierarchy9: the hierarchy13 record `typology_id` exists (a dangling
 *     typology activates, then drops out of this installation's own census);
 *   - the provisioning rule (provisionBlocker): a valid tld, a typology, and a
 *     hierarchy109 that — when set — names a `section` here.
 * Checked BEFORE anything of the tld is written, import included
 * (activationBlocker): a refused entry writes nothing.
 */
async function creationBlocker(meta: HierarchyMeta): Promise<string | null> {
	const langId = meta.lang.section_id;
	if (!(await recordExists(LANGS_SECTION, langId))) {
		return `its language ${LANGS_SECTION}/${String(langId)} (hierarchy.json lang.section_id) is not a record of this installation — activation refused`;
	}
	if (!(await recordExists(HIERARCHY_TYPES_SECTION, meta.typology_id))) {
		return `its typology ${HIERARCHY_TYPES_SECTION}/${String(meta.typology_id)} (hierarchy.json typology_id) is not a record of this installation — activation refused`;
	}
	const source = meta.real_section_tipo;
	const blocker = provisionBlocker(
		prospectiveRow(meta),
		source === null ? null : await getModelByTipo(source),
	);
	return blocker === null ? null : `${blocker} — activation refused`;
}

/**
 * THE PREFLIGHT of an optional tld (hierarchy_import.ts runs it BEFORE the
 * import): why activating `meta` would be refused, or null. A tld that already
 * has a registry row is never re-described (see the header), so only a NEW
 * row's preconditions ({@link creationBlocker}) can refuse here — an existing
 * row converges through ensureHierarchy. Without this the terms were copied
 * first and the refusal came after: committed rows nothing could reach, and
 * every later run reported the tld "already installed".
 */
export async function activationBlocker(meta: HierarchyMeta): Promise<string | null> {
	if ((await findHierarchyByTld(meta.tld.trim().toLowerCase())) !== null) return null;
	return creationBlocker(meta);
}

/** A relation locator of the registry row (int section_id — WC-2026-08-10-section-id-int-canonical). */
function registryLink(fromComponent: string, sectionTipo: string, sectionId: number) {
	return [
		{
			id: 1,
			type: RELATION_TYPE_LINK,
			section_id: sectionId,
			section_tipo: sectionTipo,
			from_component_tipo: fromComponent,
		},
	];
}

/**
 * CREATE the registry row of `meta` and write every identity field the entry
 * carries — ONE transaction (a failed write leaves no half-described row).
 */
async function createRegistryRow(meta: HierarchyMeta, userId: number): Promise<number> {
	const tld = meta.tld.trim().toLowerCase();
	return withTransaction(async () => {
		const sectionId = await createSectionRecord(HIERARCHY_SECTION, userId);
		const write = (column: 'relation' | 'string' | 'misc', tipo: string, value: unknown) =>
			updateMatrixKeyData(HIERARCHY_MAIN_TABLE, HIERARCHY_SECTION, sectionId, column, tipo, value);
		await write('string', HIERARCHY_TLD, [{ id: 1, lang: 'lg-nolan', value: tld }]);
		if (meta.name_data.length > 0) await write('string', HIERARCHY_TERM, meta.name_data);
		await write(
			'relation',
			HIERARCHY_TYPOLOGY,
			registryLink(HIERARCHY_TYPOLOGY, HIERARCHY_TYPES_SECTION, meta.typology_id),
		);
		await write(
			'relation',
			HIERARCHY_LANG,
			registryLink(HIERARCHY_LANG, LANGS_SECTION, meta.lang.section_id),
		);
		if (meta.real_section_tipo !== null) {
			await write('string', HIERARCHY_SOURCE_REAL_SECTION, [
				{ id: 1, lang: 'lg-nolan', value: meta.real_section_tipo },
			]);
		}
		if (meta.scope_note_data.length > 0) {
			await write('string', HIERARCHY_SCOPE_NOTE, meta.scope_note_data);
		}
		// Absent = not declared (nothing written); `[]` IS a declaration.
		if (meta.dependencies !== undefined) {
			await write('misc', HIERARCHY_DEPENDENCIES, dependenciesMiscItems(meta.dependencies));
		}
		return sectionId;
	});
}

/** Converge an existing registry row through THE single writer. */
async function converge(
	outcome: ActivateHierarchyResult,
	sectionId: number,
	userId: number,
	activeInThesaurus: boolean,
): Promise<ActivateHierarchyResult> {
	outcome.sectionId = sectionId;
	// Everything else IS the shared invariant — flags, ontology, target sections and the
	// general-term roots (resolved-or-created, never hard-coded).
	const ensured = await ensureHierarchy(sectionId, userId, {
		activate: true,
		activeInThesaurus,
	});
	outcome.applied = ensured.applied;
	outcome.errors.push(...ensured.errors);
	outcome.ok = ensured.ok;
	if (!ensured.ok && ensured.errors.length === 0) {
		outcome.errors.push(ensured.msg);
	}
	return outcome;
}

/**
 * Activate ONE optional hierarchy from its manifest entry: find its registry
 * row, or CREATE it from the entry (see the header), then converge it.
 */
export async function activateHierarchy(
	meta: HierarchyMeta,
	userId: number,
): Promise<ActivateHierarchyResult> {
	const outcome = newOutcome();
	let sectionId = await findHierarchyByTld(meta.tld.trim().toLowerCase());
	if (sectionId === null) {
		const blocker = await creationBlocker(meta);
		if (blocker !== null) {
			outcome.errors.push(blocker);
			return outcome;
		}
		sectionId = await createRegistryRow(meta, userId);
		outcome.created = true;
	}
	return converge(outcome, sectionId, userId, meta.active_in_thesaurus);
}

/**
 * Activate ONE CORE hierarchy: its registry row is the SEED's — never created
 * here. A database without it is reported (the seed restore is what to repair).
 */
export async function activateCoreHierarchy(
	core: CoreHierarchy,
	userId: number,
): Promise<ActivateHierarchyResult> {
	const outcome = newOutcome();
	const sectionId = await findHierarchyByTld(core.tld);
	if (sectionId === null) {
		outcome.errors.push(
			`core hierarchy '${core.tld}' has no registry row — the seed ships it; restore the seed`,
		);
		return outcome;
	}
	return converge(outcome, sectionId, userId, core.active_in_thesaurus);
}

/** What activating every core hierarchy did (the seed restore and the suite setup read it). */
export interface CoreHierarchiesActivation {
	/** The core tlds that converged — every one of them: a failure THROWS. */
	activated: string[];
	/** The one-line report a CLI prints. */
	msg: string;
}

/**
 * Activate every CORE hierarchy (see the header): activation only, never an import.
 * Idempotent — a second run converges with nothing applied.
 *
 * A failure is a REFUSAL, not an outcome: `install.step_failed` (public — the wizard
 * and the CLI show the sentence), naming each failed tld with its activation findings.
 * Every caller treats it as fatal (an install without its languages thesaurus is not an
 * install that worked), so there is no `{ok:false}` shape to forward by hand — the
 * converter builds the body (engineering/ERRORS_SPEC.md §4).
 */
export async function activateCoreHierarchies(userId = -1): Promise<CoreHierarchiesActivation> {
	const activated: string[] = [];
	const failed: string[] = [];
	for (const meta of CORE_HIERARCHIES) {
		const activation = await activateCoreHierarchy(meta, userId);
		if (activation.ok) activated.push(meta.tld);
		else failed.push(`${meta.tld}: ${activation.errors.join('; ')}`);
	}
	if (failed.length > 0) {
		refuseInstall('install.step_failed', `Core hierarchy activation failed: ${failed.join('; ')}`);
	}
	return { activated, msg: `Core hierarchies active: ${activated.join(', ')}` };
}
