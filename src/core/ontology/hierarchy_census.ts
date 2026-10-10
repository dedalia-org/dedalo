/**
 * THE THESAURUS CENSUS — read the hierarchy1 registry (matrix_hierarchy_main)
 * and build the `hierarchy.json` manifest from it
 * (WC-2026-10-10-hierarchy-json-manifest; format + reader:
 * hierarchy_manifest_format.ts).
 *
 * The thesaurus twin of the ontology census (data_io.ts getActiveOntologies →
 * ontology.json), and it SHARES that census's pieces instead of copying them:
 * the installation envelope (manifestEnvelope), the app-lang pick
 * (pickLangValue), the dd64 yes test (isYesLocator) and the declared
 * dependencies through THE shared normalizer (declaredDependencies →
 * ontology_dependencies.ts).
 *
 * WHAT IS READ, PER ACTIVE ROW (hierarchy4 = dd64/1 — inactive rows are not
 * offered, exactly like ontology.json's active_ontologies):
 *   hierarchy6 tld · hierarchy5 name · hierarchy9 typology (→ hierarchy13) ·
 *   hierarchy8 lang (→ lg1/<section_id>, its hierarchy25 term in matrix_langs
 *   as the human label) · hierarchy109 real section · hierarchy125 active in
 *   thesaurus · hierarchy61 scope note · misc.hierarchy60 dependencies.
 * `data_files` is the OTHER half: the `<tld>1|2.copy.gz` dumps present in the
 * export directory AT THAT MOMENT, each with the sha256 of its bytes. A CORE
 * hierarchy (`lg` — its terms live in matrix_langs and ship in the seed) is
 * listed as metadata with `data_files: []` always.
 *
 * WHAT IS REFUSED: a row missing what an installer needs to recreate it — a
 * valid tld, a typology that is a hierarchy13 record, an int lg1 section_id,
 * a real section (hierarchy109) that, when set, names a `section` of this
 * installation (provisioning refuses any other — measured 2026-10-09: 110
 * master rows held 'hiearachy20') — and a second row claiming an already-seen
 * tld are SKIPPED into `errors` (one line naming the row each; the caller
 * surfaces them), never exported with an invented value. So is a row whose
 * STORED values break a format rule (a hierarchy109 'Hierarchy20', a name item
 * with lang 'lg-ES'…): every entry is checked ALONE against the reader's own
 * rules (validateHierarchyEntry) before it is kept — one malformed operator
 * row is that row's error line, never a failed export of every thesaurus. A
 * typology record that breaks the format is skipped the same way (and with it
 * every row filed under it). A real section the row does not name exports as
 * `null` (provisioning applies its default); an lg1 record that does not exist
 * exports with `label: null` plus an error line — the installer refuses that
 * entry before it writes anything, loudly.
 *
 * The result still goes through parseHierarchyManifest before it is returned —
 * now a CENSUS-BUG backstop only (stored data cannot trip it): what the census
 * writes is, by construction, what the installer reads.
 *
 * Async IO only (Bun.file): the census runs on the maintenance request path.
 */

import { join } from 'node:path';
import { config } from '../../config/config.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { isCoreHierarchyTld } from '../install/hierarchy_meta.ts';
import {
	declaredDependencies,
	isYesLocator,
	manifestEnvelope,
	pickLangValue,
	withDependencies,
} from './data_io.ts';
import {
	type HierarchyDataFile,
	type HierarchyLangItem,
	type HierarchyManifest,
	type HierarchyManifestEntry,
	type HierarchyTypology,
	hierarchyDataFileNames,
	parseHierarchyManifest,
	sha256Hex,
	validateHierarchyEntry,
	validateHierarchyTypology,
} from './hierarchy_manifest_format.ts';
import {
	HIERARCHY_ACTIVE,
	HIERARCHY_ACTIVE_IN_THESAURUS,
	HIERARCHY_LANG,
	HIERARCHY_MAIN_SECTION,
	HIERARCHY_SCOPE_NOTE,
	HIERARCHY_SOURCE_REAL_SECTION,
	HIERARCHY_TERM,
	HIERARCHY_TLD,
	HIERARCHY_TYPES_NAME,
	HIERARCHY_TYPES_SECTION,
	HIERARCHY_TYPOLOGY,
} from './ontology_tipos.ts';
import { getMatrixTableFromTipo, getModelByTipo } from './resolver.ts';
import { safeTld } from './tld.ts';

/** The langs section the hierarchy8 locator points into, and its term component. */
const LANGS_SECTION = 'lg1';
const LANGS_TERM = 'hierarchy25';

type Items = Record<string, unknown[]>;

/** One hierarchy1 registry row as the census reads it. */
interface RegistryRow {
	section_id: number;
	string: Items | null;
	relation: Items | null;
	misc: Record<string, unknown> | null;
}

/** The census result: the validated manifest + one line per skipped/degraded row. */
export interface HierarchyCensus {
	manifest: HierarchyManifest;
	errors: string[];
}

/** What every row's census shares. */
interface CensusContext {
	appLang: string;
	dataDir: string;
	typologies: ReadonlyMap<number, HierarchyTypology>;
	/** The ids of `typologies` (the per-entry validator's typology rule). */
	typologyIds: ReadonlySet<number>;
	errors: string[];
}

/** The matrix table of a section tipo, or a loud invariant (the install has no such section). */
async function tableOf(sectionTipo: string): Promise<string> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('internal.invariant', {
			message: `hierarchy census: section '${sectionTipo}' resolves no matrix table`,
			coordinates: { section_tipo: sectionTipo },
		});
	}
	return table;
}

/** A string component's raw items (`[]` when the row holds none). */
function langItems(column: Items | null, tipo: string): HierarchyLangItem[] {
	const items = column?.[tipo];
	return Array.isArray(items) ? (items as HierarchyLangItem[]) : [];
}

/** A string component's app-lang value, or null when empty. */
function stringValue(column: Items | null, tipo: string, lang: string): string | null {
	const value = pickLangValue(langItems(column, tipo), lang);
	return value === '' ? null : value;
}

/** The first locator's section_id as a positive int, or null (absent / not an int). */
function locatorSectionId(column: Items | null, tipo: string): number | null {
	const locator = column?.[tipo]?.[0] as { section_id?: unknown } | undefined;
	const id = Number(locator?.section_id ?? Number.NaN);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Every hierarchy13 typology record, by id (`name` = hierarchy16 in the app
 * lang, `name_data` = every item).
 */
export async function getHierarchyTypologies(appLang: string): Promise<HierarchyTypology[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id, string FROM "${await tableOf(HIERARCHY_TYPES_SECTION)}"
		 WHERE section_tipo = $1 ORDER BY section_id ASC`,
		[HIERARCHY_TYPES_SECTION],
	)) as { section_id: number; string: Items | null }[];
	return rows.map((row) => ({
		typology_id: Number(row.section_id),
		name: stringValue(row.string, HIERARCHY_TYPES_NAME, appLang),
		name_data: langItems(row.string, HIERARCHY_TYPES_NAME),
	}));
}

/** The lg1 record's human name, or undefined when the record does not exist. */
async function langLabel(sectionId: number, appLang: string): Promise<string | null | undefined> {
	const record = await readMatrixRecord(await tableOf(LANGS_SECTION), LANGS_SECTION, sectionId);
	if (record === null) return undefined;
	return stringValue(record.columns.string as Items | null, LANGS_TERM, appLang);
}

/**
 * The `<tld>1|2.copy.gz` dumps present in `dataDir` now, each with its digest.
 * A CORE hierarchy never has one (its terms are matrix_langs, seed-shipped).
 */
export async function hierarchyDataFiles(
	tld: string,
	dataDir: string,
): Promise<HierarchyDataFile[]> {
	if (isCoreHierarchyTld(tld)) return [];
	const files: HierarchyDataFile[] = [];
	for (const file of hierarchyDataFileNames(tld)) {
		const handle = Bun.file(join(dataDir, file));
		if (await handle.exists()) files.push({ file, sha256: sha256Hex(await handle.arrayBuffer()) });
	}
	return files;
}

/** The row's tld, typology and lang id — or the reason the row cannot be exported. */
function rowKeys(
	row: RegistryRow,
	ctx: CensusContext,
): { tld: string; typologyId: number; langId: number } | string {
	const tld = safeTld((stringValue(row.string, HIERARCHY_TLD, ctx.appLang) ?? '').toLowerCase());
	if (tld === null) return 'no valid tld (hierarchy6)';
	const typologyId = locatorSectionId(row.relation, HIERARCHY_TYPOLOGY);
	if (typologyId === null || !ctx.typologies.has(typologyId)) {
		return `'${tld}': typology (hierarchy9) is not a ${HIERARCHY_TYPES_SECTION} record`;
	}
	const langId = locatorSectionId(row.relation, HIERARCHY_LANG);
	if (langId === null) return `'${tld}': no int ${LANGS_SECTION} section_id in lang (hierarchy8)`;
	return { tld, typologyId, langId };
}

/** One active row → its manifest entry, or null (the reason pushed into ctx.errors). */
async function censusEntry(
	row: RegistryRow,
	ctx: CensusContext,
): Promise<HierarchyManifestEntry | null> {
	const keys = rowKeys(row, ctx);
	const where = `${HIERARCHY_MAIN_SECTION}/${row.section_id}`;
	if (typeof keys === 'string') {
		ctx.errors.push(`Skipped ${where}: ${keys}`);
		return null;
	}
	const label = await langLabel(keys.langId, ctx.appLang);
	if (label === undefined) {
		ctx.errors.push(`${where} '${keys.tld}': ${LANGS_SECTION}/${keys.langId} does not exist`);
	}
	const entry: HierarchyManifestEntry = {
		tld: keys.tld,
		name: stringValue(row.string, HIERARCHY_TERM, ctx.appLang),
		name_data: langItems(row.string, HIERARCHY_TERM),
		typology_id: keys.typologyId,
		typology_name: ctx.typologies.get(keys.typologyId)?.name ?? null,
		lang: { section_id: keys.langId, label: label ?? null },
		real_section_tipo: stringValue(row.string, HIERARCHY_SOURCE_REAL_SECTION, ctx.appLang),
		active_in_thesaurus: isYesLocator(row.relation?.[HIERARCHY_ACTIVE_IN_THESAURUS]),
		scope_note_data: langItems(row.string, HIERARCHY_SCOPE_NOTE),
		data_files: await hierarchyDataFiles(keys.tld, ctx.dataDir),
	};
	const dependencies = declaredDependencies(row, keys.tld, ctx.errors, HIERARCHY_MAIN_SECTION);
	const problem = await entryProblem(withDependencies(entry, dependencies), ctx);
	if (problem === null) return withDependencies(entry, dependencies);
	ctx.errors.push(`Skipped ${where} '${keys.tld}': ${problem}`);
	return null;
}

/**
 * Why ONE built entry cannot be exported, or null: the reader's own rules on
 * it alone (validateHierarchyEntry — see the header), then what only THIS
 * installation can answer (realSectionRefusal).
 */
async function entryProblem(
	entry: HierarchyManifestEntry,
	ctx: CensusContext,
): Promise<string | null> {
	const checked = validateHierarchyEntry(entry, ctx.typologyIds);
	if ('problem' in checked) return checked.problem;
	return realSectionRefusal(checked.entry.real_section_tipo);
}

/**
 * Why a SET hierarchy109 cannot be exported, or null: it must name a
 * `section` of this installation — provisioning (hierarchy_state.ts
 * provisionBlocker) refuses anything else, so an exported entry naming one
 * would import its terms nowhere usable. Unset (null) is fine: provisioning
 * defaults it.
 */
async function realSectionRefusal(realSection: string | null): Promise<string | null> {
	if (realSection === null) return null;
	const model = await getModelByTipo(realSection);
	return model === 'section'
		? null
		: `real section '${realSection}' (${HIERARCHY_SOURCE_REAL_SECTION}) is not a section of this installation`;
}

/** The ACTIVE hierarchy1 rows (hierarchy4 = dd64/1), oldest first. */
async function activeRegistryRows(): Promise<RegistryRow[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id, string, relation, misc FROM "${await tableOf(HIERARCHY_MAIN_SECTION)}"
		 WHERE section_tipo = $1 ORDER BY section_id ASC`,
		[HIERARCHY_MAIN_SECTION],
	)) as RegistryRow[];
	return rows.filter((row) => isYesLocator(row.relation?.[HIERARCHY_ACTIVE]));
}

/** Census every active row; a second row claiming a seen tld is skipped (error line). */
async function activeEntries(ctx: CensusContext): Promise<HierarchyManifestEntry[]> {
	const byTld = new Map<string, HierarchyManifestEntry>();
	for (const row of await activeRegistryRows()) {
		const entry = await censusEntry(row, ctx);
		if (entry === null) continue;
		if (byTld.has(entry.tld)) {
			ctx.errors.push(
				`Skipped ${HIERARCHY_MAIN_SECTION}/${row.section_id}: tld '${entry.tld}' is already exported by an earlier active row`,
			);
			continue;
		}
		byTld.set(entry.tld, entry);
	}
	return [...byTld.values()].sort((a, b) => a.tld.localeCompare(b.tld));
}

/** The typology records the format admits; a malformed one is skipped into `errors`. */
function validTypologies(
	records: readonly HierarchyTypology[],
	errors: string[],
): HierarchyTypology[] {
	return records.flatMap((record) => {
		const checked = validateHierarchyTypology(record);
		if ('typology' in checked) return [checked.typology];
		errors.push(
			`Skipped typology ${HIERARCHY_TYPES_SECTION}/${record.typology_id}: ${checked.problem}`,
		);
		return [];
	});
}

/**
 * Build the `hierarchy.json` manifest of this installation: the shared
 * envelope, every hierarchy13 typology, and one entry per ACTIVE hierarchy1
 * row whose data files are looked up (and digested) in `dataDir`. Validated
 * by the format's own reader before it is returned (a census bug throws
 * `install.manifest_invalid` here, never ships; stored data cannot — each
 * entry was already checked alone).
 */
export async function buildHierarchyManifest(options: {
	dataDir: string;
	now?: Date;
}): Promise<HierarchyCensus> {
	const appLang = config.menu.applicationLang;
	const errors: string[] = [];
	const typologies = validTypologies(await getHierarchyTypologies(appLang), errors);
	const ctx: CensusContext = {
		appLang,
		dataDir: options.dataDir,
		typologies: new Map(typologies.map((item) => [item.typology_id, item])),
		typologyIds: new Set(typologies.map((item) => item.typology_id)),
		errors,
	};
	const activeHierarchies = await activeEntries(ctx);
	const manifest = parseHierarchyManifest({
		...manifestEnvelope(options.now),
		typologies,
		active_hierarchies: activeHierarchies,
	});
	return { manifest, errors: ctx.errors };
}
