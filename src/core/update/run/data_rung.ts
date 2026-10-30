/**
 * THE DATA PHASE'S RUNG (review 2026-10-30 #2). A `data` phase belongs to ONE
 * catalog rung: the release's own data descriptor, from its `updateFrom*`
 * version to its own triple. engine.ts updateVersion runs whatever rung the
 * database stands on — so a phase resumed after its rung COMMITTED (the process
 * died in the post-commit reconcile) would run the NEXT release's rung, or fail
 * on "nothing to update" and report a restore for a database that is sound.
 * Before it runs anything the phase asks where the database stands:
 *
 *   at the rung's target  → already applied (ok, nothing runs);
 *   at the rung's source  → run it;
 *   anywhere else         → refuse, run nothing (the walk is not where the plan says).
 *
 * Pure: the caller reads the live data version.
 */

import type { UpdateDescriptor } from '../catalog.ts';
import { compareVersionArrays, formatVersion } from '../version.ts';

export type RungVerdict =
	| { kind: 'run' }
	| { kind: 'applied'; dataVersion: string }
	| { kind: 'refuse'; summary: string };

/** Where `current` stands against the rung `release` declares in `catalog`. */
export function rungVerdict(
	release: string,
	current: readonly number[],
	catalog: Readonly<Record<string, UpdateDescriptor>>,
): RungVerdict {
	const rung = catalog[release];
	if (rung === undefined || !rung.updateData) {
		return { kind: 'refuse', summary: `no data rung is declared for ${release}` };
	}
	const to = [rung.versionMajor, rung.versionMedium, rung.versionMinor];
	const from = [rung.updateFromMajor, rung.updateFromMedium, rung.updateFromMinor];
	if (compareVersionArrays(current, to) === 0) {
		return { kind: 'applied', dataVersion: formatVersion(to) };
	}
	if (compareVersionArrays(current, from) === 0) return { kind: 'run' };
	return {
		kind: 'refuse',
		summary: `the database stands at data ${formatVersion(current)}; the ${release} rung moves ${formatVersion(from)} → ${formatVersion(to)} — nothing was run`,
	};
}
