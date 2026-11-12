/**
 * THE VENDORED ONTOLOGY PACKAGES — every `<tld>.copy.gz` matrix-record package
 * under `install/import/ontology/<major.minor>/` (the release the install seed
 * compiles from and the ontology-server role serves). A shared lister so a gate
 * that censuses the shipped packages chooses no walk root in-file
 * (census_derivation_tripwire, SHARED_LISTERS).
 *
 * HERMETIC: tracked repo files only.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Glob } from 'bun';
import { decodeCopyField } from '../../src/core/db/copy_text.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import {
	ONTOLOGY_CSS,
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_MODEL,
	ONTOLOGY_PROPERTIES,
	ONTOLOGY_SOURCE,
} from '../../src/core/ontology/ontology_tipos.ts';
import { REPO_ROOT } from './write_path_corpus.ts';

/** One vendored package file. */
export interface VendoredOntologyPackage {
	/** The release directory (`<major.minor>`). */
	release: string;
	/** The package's TLD (the file name without `.copy.gz`). */
	tld: string;
	/** Absolute path of the package. */
	path: string;
}

/** Every vendored package, sorted by release then TLD. */
export function vendoredOntologyPackages(): VendoredOntologyPackage[] {
	const root = join(REPO_ROOT, 'install/import/ontology');
	const packages: VendoredOntologyPackage[] = [];
	for (const match of new Glob('*/*.copy.gz').scanSync({ cwd: root })) {
		const [release, file] = match.split('/');
		if (release === undefined || file === undefined) continue;
		packages.push({ release, tld: file.replace(/\.copy\.gz$/, ''), path: join(root, match) });
	}
	return packages.sort((a, b) =>
		a.release === b.release ? a.tld.localeCompare(b.tld) : a.release.localeCompare(b.release),
	);
}

/** One ontology node as a vendored package row folds it. */
export interface VendoredOntologyNode {
	tipo: string;
	/**
	 * What the parser folds a row's `properties` into (src/core/ontology/
	 * parser.ts resolveProperties, canonical half): ontology18's keys + `.css`
	 * (ontology16) + `.source` (ontology17). The packages carry no local
	 * overrides (localontology0 is the install's), so this IS the node.
	 */
	properties: Record<string, unknown>;
	/** The tipo of the node's model (its ontology6 locator), null when absent. */
	modelTipo: string | null;
	/** A MODEL node's language-free name (ontology43), null otherwise. */
	machineName: string | null;
	/** The package file the row came from (`<tld>.copy.gz`). */
	corpus: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The first item's value of one component (parser readPropertySet's `firstValue`). */
function firstValue(bag: unknown, tipo: string): unknown {
	const items = isPlainObject(bag) ? bag[tipo] : undefined;
	return Array.isArray(items) ? (items[0] as { value?: unknown } | undefined)?.value : undefined;
}

function parsedColumn(fields: string[], column: string): unknown {
	const raw = decodeCopyField(fields[MATRIX_COPY_COLUMNS.indexOf(column)] ?? '\\N');
	return raw === null ? null : (JSON.parse(raw) as unknown);
}

/** The model tipo a row's ontology6 locator names (`<tld>0` + id → `<tld><id>`). */
function modelTipoOf(relation: unknown): string | null {
	const items = isPlainObject(relation) ? relation[ONTOLOGY_MODEL] : undefined;
	const first = Array.isArray(items)
		? (items[0] as { section_tipo?: unknown; section_id?: unknown } | undefined)
		: undefined;
	if (typeof first?.section_tipo !== 'string' || first.section_id === undefined) return null;
	return `${first.section_tipo.replace(/0$/, '')}${String(first.section_id)}`;
}

/**
 * Every node of the vendored packages (the ONE package-row loader: the gates
 * that census shipped ontology definitions read it — external_law_registry_
 * tripwire, calculation_fn_registry_tripwire).
 */
export function vendoredOntologyNodes(): {
	nodes: VendoredOntologyNode[];
	files: number;
	releases: string[];
} {
	const packages = vendoredOntologyPackages();
	const nodes: VendoredOntologyNode[] = [];
	for (const { tld, path } of packages) {
		const corpus = `${tld}.copy.gz`;
		for (const line of gunzipSync(readFileSync(path)).toString('utf8').split('\n')) {
			if (line === '') continue;
			const fields = line.split('\t');
			const sectionId = decodeCopyField(fields[MATRIX_COPY_COLUMNS.indexOf('section_id')] ?? '\\N');
			if (sectionId === null) continue;
			// A row without misc (a model node, a plain grouper) has no properties.
			const misc = parsedColumn(fields, 'misc') ?? {};
			const keys = firstValue(misc, ONTOLOGY_PROPERTIES);
			const properties: Record<string, unknown> = isPlainObject(keys) ? { ...keys } : {};
			const css = firstValue(misc, ONTOLOGY_CSS);
			const source = firstValue(misc, ONTOLOGY_SOURCE);
			if (css !== undefined) properties.css = css;
			if (source !== undefined) properties.source = source;
			const machineName = firstValue(parsedColumn(fields, 'string'), ONTOLOGY_MACHINE_NAME);
			nodes.push({
				tipo: `${tld}${sectionId}`,
				properties,
				modelTipo: modelTipoOf(parsedColumn(fields, 'relation')),
				machineName: typeof machineName === 'string' ? machineName : null,
				corpus,
			});
		}
	}
	return {
		nodes,
		files: packages.length,
		releases: [...new Set(packages.map((entry) => entry.release))],
	};
}
