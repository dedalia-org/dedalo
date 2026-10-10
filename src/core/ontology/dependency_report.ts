/**
 * MISSING DECLARED DEPENDENCIES — the REPORT-ONLY half of the ontology update
 * (WC-2026-10-10-ontology-dependencies-hierarchy60).
 *
 * After an update imports a set of ontologies, each updated TLD's registry row
 * (ontology35, matrix_ontology_main) holds its DECLARED dependencies —
 * `misc.hierarchy60[0].value`, written by the import door
 * (ontology_write.ts syncMainSectionFromDefinition) or kept from the local
 * value when the source declared nothing. This module checks each declared
 * dependency against THIS server and reports the ones that are not present:
 *
 *  - `main: 'ontology35'` — PRESENT when the TLD has a registry row AND is in
 *    the effective active ontology set (`ACTIVE_ONTOLOGY_TLDS`, the core set
 *    always counting): a TLD outside that set is not updated with the others,
 *    so its nodes drift from the dependant's expectations;
 *  - `main: 'hierarchy1'` — PRESENT when an ACTIVE hierarchy registry row
 *    (hierarchy1 in matrix_hierarchy_main, hierarchy4 → yes) exists for the TLD.
 *
 * NEVER installs anything: the update only TELLS the operator what is missing
 * and how to provide it (a mandatory dependency is a warning line in the
 * update's `errors`; an optional one an informational note in its log). Any
 * server can be a master of others, so the same check runs everywhere.
 *
 * Read-only: SELECTs and record reads, no write door.
 */

import { config } from '../../config/config.ts';
import { compareLocators, type Locator } from '../concepts/locator.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { isCoreOntologyTld } from './core_tlds.ts';
import {
	normalizeOntologyDependencies,
	type OntologyDependency,
	type OntologyDependencyMain,
	storedDependenciesValue,
} from './ontology_dependencies.ts';
import {
	HIERARCHY_ACTIVE,
	HIERARCHY_MAIN_SECTION,
	HIERARCHY_TLD,
	ONTOLOGY_MAIN_SECTION,
	SI_NO_YES,
	YES_NO_SECTION,
} from './ontology_tipos.ts';
import { getOntologyMainFromTld } from './ontology_write.ts';

/** The hierarchy registry table (hierarchy1 rows). */
const HIERARCHY_MAIN_TABLE = 'matrix_hierarchy_main';

/** Why a declared dependency is not present on this server. */
export type MissingDependencyReason =
	/** main ontology35: the TLD has no registry row here. */
	| 'not_installed'
	/** main ontology35: a registry row exists, but the TLD is not in ACTIVE_ONTOLOGY_TLDS. */
	| 'not_active'
	/** main hierarchy1: no ACTIVE hierarchy registry row for the TLD. */
	| 'no_active_hierarchy';

/** One declared dependency this server does not provide. */
export interface MissingDependency {
	/** The TLD that declares the dependency. */
	dependant: string;
	tld: string;
	main: OntologyDependencyMain;
	mandatory: boolean;
	reason: MissingDependencyReason;
}

/** The report of one update: the missing items + their operator lines. */
export interface DependencyReport {
	missing: MissingDependency[];
	/** One line per MANDATORY missing dependency (the update's warnings). */
	warnings: string[];
	/** One line per OPTIONAL missing dependency (informational). */
	notes: string[];
	/** Normalizer warnings about a malformed stored declaration (the update's warnings). */
	invalid: string[];
}

/**
 * The declared dependencies stored on `tld`'s registry row (normalized; warnings
 * into `invalid`), or null when it has no row or declares nothing.
 */
export async function storedDeclaredDependencies(
	tld: string,
	invalid: string[],
): Promise<OntologyDependency[] | null> {
	const main = await getOntologyMainFromTld(tld);
	if (main === null) return null;
	const record = await readMatrixRecord(
		'matrix_ontology_main',
		ONTOLOGY_MAIN_SECTION,
		main.section_id,
	);
	return normalizeOntologyDependencies(tld, storedDependenciesValue(record?.columns.misc), invalid);
}

/** Is `tld` in the effective active ontology set (core always counts)? */
function inActiveOntologySet(tld: string): boolean {
	return (
		isCoreOntologyTld(tld) ||
		config.ontologyIo.activeOntologyTlds.some((item) => item.trim().toLowerCase() === tld)
	);
}

/** Does an ACTIVE hierarchy1 registry row (hierarchy4 → yes) exist for `tld`? */
export async function hasActiveHierarchy(tld: string): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT relation FROM "${HIERARCHY_MAIN_TABLE}"
		 WHERE section_tipo = $1
		   AND lower(string->'${HIERARCHY_TLD}'->0->>'value') = $2`,
		[HIERARCHY_MAIN_SECTION, tld],
	)) as { relation: Record<string, unknown[]> | null }[];
	return rows.some((row) => {
		const active = row.relation?.[HIERARCHY_ACTIVE]?.[0] as Locator | undefined;
		return (
			active !== undefined &&
			compareLocators(active, { section_tipo: YES_NO_SECTION, section_id: SI_NO_YES } as Locator, [
				'section_tipo',
				'section_id',
			])
		);
	});
}

/** Why `dependency` is missing here, or null when this server provides it. */
async function missingReason(
	dependency: OntologyDependency,
): Promise<MissingDependencyReason | null> {
	if (dependency.main === 'hierarchy1') {
		return (await hasActiveHierarchy(dependency.tld)) ? null : 'no_active_hierarchy';
	}
	if ((await getOntologyMainFromTld(dependency.tld)) === null) return 'not_installed';
	return inActiveOntologySet(dependency.tld) ? null : 'not_active';
}

/** The operator line of one missing dependency: names both TLDs and how to provide it. */
export function missingDependencyLine(item: MissingDependency): string {
	const need = item.mandatory ? 'requires' : 'can use (optional)';
	switch (item.reason) {
		case 'not_installed':
			return `'${item.dependant}' ${need} the '${item.tld}' ontology, which is not installed on this server — add '${item.tld}' to the ontologies to update (ACTIVE_ONTOLOGY_TLDS) and run the update again to install it`;
		case 'not_active':
			return `'${item.dependant}' ${need} the '${item.tld}' ontology, which is installed but not in ACTIVE_ONTOLOGY_TLDS (it is not updated with the others) — add '${item.tld}' to ACTIVE_ONTOLOGY_TLDS and run the update again`;
		case 'no_active_hierarchy':
			return `'${item.dependant}' ${need} the '${item.tld}' thesaurus, which is not installed and active on this server — install it with Maintenance → Install hierarchies (or activate its hierarchy)`;
	}
}

/**
 * Check the declared dependencies of every TLD in `tlds` (the TLDs an update
 * just imported) against this server. Report only — writes nothing.
 */
export async function reportMissingDependencies(
	tlds: readonly string[],
): Promise<DependencyReport> {
	const report: DependencyReport = { missing: [], warnings: [], notes: [], invalid: [] };
	for (const raw of tlds) {
		const dependant = raw.trim().toLowerCase();
		const declared = await storedDeclaredDependencies(dependant, report.invalid);
		for (const dependency of declared ?? []) {
			const reason = await missingReason(dependency);
			if (reason === null) continue;
			const item: MissingDependency = { dependant, ...dependency, reason };
			report.missing.push(item);
			(item.mandatory ? report.warnings : report.notes).push(missingDependencyLine(item));
		}
	}
	return report;
}
