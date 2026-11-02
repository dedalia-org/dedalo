/**
 * THE JUNIT REPORTS IN A DIRECTORY — one lister for the two readers of a sharded
 * run's output: `scripts/lib/tier_run.ts` (runTierSharded merges `bin<N>.xml`) and
 * `scripts/test_baseline_compare.ts <dir>` (a candidate run vs the campaign).
 *
 * NOT a corpus: the directory is a run's own output (mkdtemp, or the caller's
 * `--junit-dir`), never a repo directory. Kept OUT of both readers so the gates
 * that import them (test_baseline_tripwire, the unit/parity ratchets) do not
 * become walkers by reach — census_derivation_tripwire classifies a gate by the
 * modules it imports.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every `*.xml` directly under `dir` matching `pattern`, as absolute paths, sorted by name. */
export function junitReportsIn(dir: string, pattern: RegExp = /\.xml$/): string[] {
	return readdirSync(dir)
		.filter((name) => pattern.test(name))
		.sort()
		.map((name) => join(dir, name));
}
