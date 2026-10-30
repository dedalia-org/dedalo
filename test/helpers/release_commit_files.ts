/**
 * The files a RELEASE commit carries beside version.ts for the release-tag check
 * (scripts/lib/release_tag.ts rules 3–4): the update catalog holding the
 * release's triple, and the install-seed manifest compiled for the commit's own
 * data version. Fixture repos write these so a gate isolates the rule it tests.
 */

import { RELEASE_CATALOG_PATH, SEED_MANIFEST_PATH } from '../../scripts/lib/release_tag.ts';

export function releaseCommitFiles(
	dataTriple: string,
	releaseTriples: readonly string[],
): Record<string, string> {
	return {
		[RELEASE_CATALOG_PATH]: `${JSON.stringify({
			format: 1,
			releases: Object.fromEntries(releaseTriples.map((triple) => [triple, {}])),
		})}\n`,
		[SEED_MANIFEST_PATH]: `${JSON.stringify({ format: 1, engine_version: dataTriple })}\n`,
	};
}
