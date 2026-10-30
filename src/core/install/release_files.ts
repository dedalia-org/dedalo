/**
 * The ontology release AS SHIPPED on disk — kept out of seed_sources.ts, whose
 * bytes are a seed source (install_seed_manifest_tripwire): listing the release
 * changes nothing the seed compiles.
 */

import { readdirSync } from 'node:fs';
import { ONTOLOGY_RELEASE_DIR } from './seed_sources.ts';

/**
 * The data packages ON DISK in the ontology release (`<tld>.copy.gz`), sorted —
 * what a release archive ships, whether or not ontology.json lists it (the
 * suite-fixture gate reads it: install_seed_drift_tripwire).
 */
export function releaseDataFiles(dir: string = ONTOLOGY_RELEASE_DIR): string[] {
	return readdirSync(dir)
		.filter((name) => name.endsWith('.copy.gz'))
		.sort();
}
