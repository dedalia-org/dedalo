/**
 * A planted MASTER MANIFEST for gates that drive `updateOntology` /
 * `resolveOntologySource` (src/core/ontology/ontology_update_source.ts).
 *
 * Since U-08 / U-41 the engine reads the master's manifest ITSELF and stages
 * the manifest's entries (URL, typology, names, dependencies) — the client's
 * file list only names TLDs. A gate therefore states the master it talks to:
 * `manifestSourceDeps(files)` answers a manifest listing exactly `files` (a
 * `matrix_dd` entry becomes `matrixDdUrl`) at THIS code's data version, and an
 * installed data version on the same model. No network, no database read.
 */

import type { OntologyDependency } from '../../src/core/ontology/ontology_dependencies.ts';
import type { ManifestResult } from '../../src/core/ontology/ontology_manifest.ts';
import type { OntologySourceDeps } from '../../src/core/ontology/ontology_update_source.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';

/** One file the planted master lists. */
export interface PlantedManifestFile {
	tld: string;
	url: string;
	typology_id?: number | string | null;
	name_data?: unknown;
	/** Declared dependencies; absent = NOT declared. */
	dependencies?: OntologyDependency[];
}

/** An ok manifest listing `files` (matrix_dd → matrixDdUrl) at `version`. */
export function plantedManifest(
	files: readonly PlantedManifestFile[],
	version: string = formatVersion(DEDALO_DATA_VERSION),
): Extract<ManifestResult, { ok: true }> {
	const matrixDd = files.find((file) => file.tld === 'matrix_dd');
	return {
		ok: true,
		version,
		ontologies: files
			.filter((file) => file.tld !== 'matrix_dd')
			.map((file) => ({
				tld: file.tld,
				name: file.tld,
				name_data: file.name_data ?? null,
				typology_id: file.typology_id ?? null,
				typology_name: null,
				dependencies: file.dependencies ?? null,
				url: file.url,
			})),
		matrixDdUrl: matrixDd?.url ?? null,
		warnings: [],
	};
}

/** The source seams: a master listing `files`, an install on this code's data model. */
export function manifestSourceDeps(
	files: readonly PlantedManifestFile[],
): Required<Pick<OntologySourceDeps, 'readManifest' | 'installedDataVersion'>> {
	const manifest = plantedManifest(files);
	return {
		readManifest: async () => manifest,
		installedDataVersion: async () => [...DEDALO_DATA_VERSION],
	};
}
