/**
 * THE VENDORED ONTOLOGY PACKAGES — every `<tld>.copy.gz` matrix-record package
 * under `install/import/ontology/<major.minor>/` (the release the install seed
 * compiles from and the ontology-server role serves). A shared lister so a gate
 * that censuses the shipped packages chooses no walk root in-file
 * (census_derivation_tripwire, SHARED_LISTERS).
 *
 * HERMETIC: tracked repo files only.
 */

import { join } from 'node:path';
import { Glob } from 'bun';
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
