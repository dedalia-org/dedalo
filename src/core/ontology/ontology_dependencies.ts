/**
 * DECLARED ONTOLOGY DEPENDENCIES — the one type and the one normalizer of what
 * an ontology says it needs (WC-2026-10-10-ontology-dependencies-hierarchy60).
 *
 * WHERE THE DECLARATION LIVES. The master ontology defines `hierarchy60`
 * ("Dependencies", component_json, group hierarchy103 of hierarchy1 — and so of
 * its virtual ontology35). component_json stores in the matrix `misc` column:
 *
 *   misc.hierarchy60 = [{ "id": 1, "value": [ <OntologyDependency>, … ] }]
 *
 * on the TLD's ontology35 registry row (matrix_ontology_main). The engine reads
 * and writes that RAW key only — never the dd_ontology definition of
 * hierarchy60 (an install still on an older vendored release defines it as a
 * section_group, and the raw key is the same either way).
 *
 * ONE ITEM: `{tld, main, mandatory}`.
 *  - `main: 'ontology35'` — the TLD's ONTOLOGY must be installed;
 *  - `main: 'hierarchy1'` — the TLD's THESAURUS (hierarchy registry + terms)
 *    must be installed and activated;
 *  - `mandatory` — true: always installed, cannot be declined; false: offered
 *    pre-ticked, the operator may decline it.
 * A TLD may appear TWICE (once per `main`): the dedupe key is `(tld, main)`. A
 * self-reference is valid with `main: 'hierarchy1'` (a TLD's ontology declaring
 * its own thesaurus) and meaningless with `main: 'ontology35'` (dropped).
 *
 * DECLARED vs NOT DECLARED. `null` = the definition says nothing (an absent
 * key, or a value that is not a list) — a reader leaves whatever it holds;
 * `[]` = declared, needs nothing.
 *
 * A LEAF module on purpose: the export (data_io.ts), the manifest reader
 * (ontology_manifest.ts), the update stager (ontology_update_target.ts), the
 * registry writer (ontology_write.ts) and the config-free installer closure
 * (install/ontology_choice.ts) all import it, so it imports nothing but the
 * pure TLD grammar — never config, never the tipo constants module.
 */

import { safeTld } from './tld.ts';

/**
 * hierarchy60 — the "Dependencies" component of the registry rows (raw `misc`
 * key). Re-exported by ontology_tipos.ts with the other registry tipos.
 */
export const HIERARCHY_DEPENDENCIES = 'hierarchy60';

/** The two things a dependency can require of a TLD. */
export const ONTOLOGY_DEPENDENCY_MAINS = ['ontology35', 'hierarchy1'] as const;
export type OntologyDependencyMain = (typeof ONTOLOGY_DEPENDENCY_MAINS)[number];

/** One declared dependency (see the module header). */
export interface OntologyDependency {
	tld: string;
	main: OntologyDependencyMain;
	mandatory: boolean;
}

const MAIN_SET: ReadonlySet<string> = new Set(ONTOLOGY_DEPENDENCY_MAINS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The item's tld, trimmed + lowercased, or null when it is not a TLD. */
function itemTld(item: Record<string, unknown>): string | null {
	return typeof item.tld === 'string' ? safeTld(item.tld.trim().toLowerCase()) : null;
}

/** The item's main, or null when it is not one of ONTOLOGY_DEPENDENCY_MAINS. */
function itemMain(item: Record<string, unknown>): OntologyDependencyMain | null {
	return typeof item.main === 'string' && MAIN_SET.has(item.main)
		? (item.main as OntologyDependencyMain)
		: null;
}

/** One raw item → a dependency, or null (with a warning naming why). */
function dependencyItem(
	owner: string,
	item: unknown,
	warnings: string[],
): OntologyDependency | null {
	const drop = (why: string): null => {
		warnings.push(`'${owner}' declares a dependency ${why} (${JSON.stringify(item)}) — ignored`);
		return null;
	};
	if (!isPlainObject(item)) return drop('that is not an object');
	const tld = itemTld(item);
	if (tld === null) return drop('whose tld is not a TLD');
	const main = itemMain(item);
	if (main === null) return drop(`whose main is not one of ${ONTOLOGY_DEPENDENCY_MAINS.join('/')}`);
	if (typeof item.mandatory !== 'boolean') return drop('whose mandatory is not a boolean');
	return { tld, main, mandatory: item.mandatory };
}

/**
 * THE normalizer of a declared dependency list — pure, shared by every reader
 * and writer of the declaration:
 *  - `undefined`/`null` → null (not declared, silently);
 *  - not a list → null + warning (treated as not declared);
 *  - each item: tld trimmed + lowercased + a valid TLD, `main` one of
 *    ontology35/hierarchy1, `mandatory` a boolean — anything else is dropped
 *    with a warning;
 *  - `(tld, main)` deduplicated, FIRST wins (a later duplicate warns);
 *  - a self-reference with `main: 'ontology35'` is dropped (warns).
 * `ownerTld` is the declaring TLD (compared lowercased).
 */
export function normalizeOntologyDependencies(
	ownerTld: string,
	raw: unknown,
	warnings: string[],
): OntologyDependency[] | null {
	if (raw === undefined || raw === null) return null;
	const owner = ownerTld.trim().toLowerCase();
	if (!Array.isArray(raw)) {
		warnings.push(`'${owner}' declares dependencies that are not a list — treated as not declared`);
		return null;
	}
	return collectDependencies(owner, raw, warnings);
}

/** The valid, admitted items of a declared list, in declared order. */
function collectDependencies(
	owner: string,
	raw: readonly unknown[],
	warnings: string[],
): OntologyDependency[] {
	const seen = new Set<string>();
	const out: OntologyDependency[] = [];
	for (const item of raw) {
		const dependency = dependencyItem(owner, item, warnings);
		if (dependency !== null && admitDependency(owner, dependency, seen, warnings)) {
			out.push(dependency);
		}
	}
	return out;
}

/** Self-reference + `(tld, main)` dedupe rules of one valid item (records it in `seen`). */
function admitDependency(
	owner: string,
	dependency: OntologyDependency,
	seen: Set<string>,
	warnings: string[],
): boolean {
	if (dependency.tld === owner && dependency.main === 'ontology35') {
		warnings.push(`'${owner}' declares its own ontology as a dependency — ignored`);
		return false;
	}
	const key = `${dependency.tld}\u0000${dependency.main}`;
	if (seen.has(key)) {
		warnings.push(
			`'${owner}' declares '${dependency.tld}' (${dependency.main}) more than once — the first declaration wins`,
		);
		return false;
	}
	seen.add(key);
	return true;
}

/**
 * The RAW declared value stored on a registry row's `misc` column
 * (`misc.hierarchy60[0].value`), or undefined when the row declares nothing.
 * Feed it to {@link normalizeOntologyDependencies}.
 */
export function storedDependenciesValue(misc: unknown): unknown {
	if (!isPlainObject(misc)) return undefined;
	const items = misc[HIERARCHY_DEPENDENCIES];
	if (!Array.isArray(items) || items.length === 0) return undefined;
	const first: unknown = items[0];
	return isPlainObject(first) ? first.value : undefined;
}

/** The stored component_json shape of a declaration (`misc.hierarchy60`). */
export function dependenciesMiscItems(
	dependencies: readonly OntologyDependency[],
): { id: number; value: OntologyDependency[] }[] {
	return [
		{
			id: 1,
			value: dependencies.map((item) => ({
				tld: item.tld,
				main: item.main,
				mandatory: item.mandatory,
			})),
		},
	];
}
