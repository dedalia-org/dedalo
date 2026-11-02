/**
 * THE SHIPPED FIRST-PARTY TEXT TREES — the roots a gate scans when the question
 * is "does anything we ship SAY this", in ONE place.
 *
 * Six trees carry text that reaches a user or an operator: the two browser
 * trees (client/, tools/), the engine (src/), its scripts (scripts/), the
 * read-only publication subsystem (publication/) and the deploy templates
 * (deploy/). docs/ is deliberately NOT among them — the manual may quote a URL
 * as example data, so a gate that forbids a spelling elsewhere must not read it
 * there.
 *
 * `census_derivation_tripwire` refuses a gate that writes such a root set
 * in-file (the subset-root defect class: a gate green over the wrong
 * directory), which is why the list lives here and is registered in that gate's
 * SHARED_LISTERS.
 *
 * Consumers: test/unit/docs_versioning_tripwire.test.ts,
 * test/unit/zip_encoder_census_tripwire.test.ts,
 * test/unit/export_download_safety_tripwire.test.ts,
 * test/unit/publication_host_pairing_tripwire.test.ts,
 * test/unit/publication_host_door_tripwire.test.ts,
 * test/unit/publication_host_bundle_twin_tripwire.test.ts.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The shipped first-party text trees, repo-relative. */
export const SHIPPED_TEXT_ROOTS: readonly string[] = [
	'client',
	'tools',
	'src',
	'scripts',
	'publication',
	'deploy',
];

/** Extensions that can carry a link or a message a reader ever sees. */
const TEXT_GLOB = '**/*.{ts,tsx,mts,cts,js,mjs,json,md}';

/**
 * Every shipped text file under those roots, as sorted repo-relative paths.
 * Installed dependencies are not ours and are left out.
 */
export function shippedTextFiles(): string[] {
	const out: string[] = [];
	for (const root of SHIPPED_TEXT_ROOTS) {
		const dir = join(REPO_ROOT, root);
		if (!existsSync(dir)) continue;
		for (const file of new Glob(TEXT_GLOB).scanSync({ cwd: dir })) {
			if (file.includes('node_modules/')) continue;
			out.push(`${root}/${file}`);
		}
	}
	return out.sort();
}
