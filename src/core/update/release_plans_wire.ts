/**
 * THE WALK'S RELEASE PLANS ON THE WIRE (update audit 2026-10-29, design §3.1;
 * D-1, D-7).
 *
 * A running tree's catalog never knows the release it is about to install (a
 * catalog may not run ahead of its engine — catalog.ts), yet the run must plan
 * that release's steps BEFORE the swap: the ontology preconditions run first,
 * and the journal must say up front whether the walk crosses a data model
 * (D-2). The master knows: its catalog holds every release it publishes. So
 * its code manifest (`get_code_update_info`, top-level `plans`) carries the
 * plan of every catalog release above the asker — version, compat, data
 * version, and each step's `kind` (+ an ontology step's `min`) — and the
 * consumer reads them from the manifest IT fetched (code_manifest_pin.ts:
 * the browser never relays them).
 *
 * Only what the plan needs travels: a data step's SQL files and scripts run
 * from the TARGET tree's own catalog, in the target tree, after the swap.
 * An older master answers no `plans`: the run then knows only this tree's
 * catalog and refuses an uncatalogued target (plan.ts `release_unknown`).
 */

import { dataVersionOf, RELEASE_PLANS, UPDATE_CATALOG } from './catalog.ts';
import type { ReleaseCompat, ReleasePlan, ReleaseStep, ReleaseStepKind } from './catalog_file.ts';
import { parseReleaseVersion } from './release_identity.ts';
import { compareVersionArrays, formatVersion, parseVersionString } from './version.ts';

/** One release's plan as the manifest carries it. */
export interface WireReleasePlan {
	version: string;
	compat: ReleaseCompat | null;
	/** The release's data version (`X.Y.Z`). */
	data: string;
	steps: { kind: ReleaseStepKind; min?: string }[];
	/**
	 * Did the master's catalog DECLARE these steps (false: the D-1 default order,
	 * expanded)? It travels because it changes what a step MEANS on the consumer:
	 * a DEFAULT ontology step is skipped, journaled, on an install with no
	 * ontology source (run/production.ts isDefaultOntologyStep — an air-gapped
	 * install still takes code updates); a declared one fails without a source.
	 * Dropped on the wire (the reader once stamped every plan `declared: true`),
	 * every release that declared nothing failed on such an install AFTER the
	 * swap, past the data-model flip: NEEDS_DB_RESTORE for a code-only patch.
	 */
	declared: boolean;
}

const STEP_KINDS: ReadonlySet<string> = new Set([
	'code',
	'ontology',
	'schema',
	'data',
	'ancillary',
]);
const TRIPLE = /^\d+\.\d+\.\d+$/;

function wireStep(step: ReleaseStep): WireReleasePlan['steps'][number] {
	return step.min === undefined ? { kind: step.kind } : { kind: step.kind, min: step.min };
}

/** Master side: the plan of every catalog release strictly above `asker`'s triple, ascending. */
export function wirePlansAbove(
	asker: readonly number[],
	plans: Readonly<Record<string, ReleasePlan>> = RELEASE_PLANS,
	catalog: typeof UPDATE_CATALOG = UPDATE_CATALOG,
): WireReleasePlan[] {
	return Object.values(plans)
		.map((plan) => ({ plan, triple: parseVersionString(plan.version) }))
		.filter(({ triple }) => compareVersionArrays(triple, asker) > 0)
		.sort((a, b) => compareVersionArrays(a.triple, b.triple))
		.map(({ plan, triple }) => ({
			version: plan.version,
			compat: plan.compat,
			data: formatVersion(dataVersionOf(catalog, triple, true)),
			steps: plan.steps.map(wireStep),
			declared: plan.declared,
		}));
}

function isWireStep(value: unknown): value is WireReleasePlan['steps'][number] {
	if (typeof value !== 'object' || value === null) return false;
	const step = value as { kind?: unknown; min?: unknown };
	const minOk = step.min === undefined || isTripleText(step.min);
	return typeof step.kind === 'string' && STEP_KINDS.has(step.kind) && minOk;
}

const COMPATS: readonly unknown[] = [null, 'compatible', 'incompatible'];

function isTripleText(value: unknown): boolean {
	return typeof value === 'string' && TRIPLE.test(value);
}

function isReleaseText(value: unknown): boolean {
	return typeof value === 'string' && parseReleaseVersion(value) !== null;
}

function isStepList(value: unknown): boolean {
	return Array.isArray(value) && value.every(isWireStep);
}

/** The plan's identity fields: release, data version, compat. */
function hasWireIdentity(plan: Record<string, unknown>): boolean {
	return isReleaseText(plan.version) && isTripleText(plan.data) && COMPATS.includes(plan.compat);
}

function isWirePlan(value: unknown): value is WireReleasePlan {
	if (typeof value !== 'object' || value === null) return false;
	const plan = value as Record<string, unknown>;
	// `declared` is REQUIRED, never defaulted: guessing either way changes whether
	// a missing ontology source fails the run (see WireReleasePlan.declared).
	return hasWireIdentity(plan) && isStepList(plan.steps) && typeof plan.declared === 'boolean';
}

/** What the consumer reads from a manifest's `plans`. */
export interface ReadWirePlans {
	plans: Record<string, ReleasePlan>;
	/** Each release's data version. */
	data: Record<string, number[]>;
}

/**
 * Consumer side: the manifest's `plans`, shape-checked. Absent (an older
 * master) → empty. A malformed entry fails the whole read — a plan the run
 * cannot trust is never partly used.
 */
export function readWirePlans(raw: unknown): ReadWirePlans | null {
	if (raw === undefined) return { plans: {}, data: {} };
	if (!Array.isArray(raw) || !raw.every(isWirePlan)) return null;
	const entries = raw as WireReleasePlan[];
	return {
		plans: Object.fromEntries(
			entries.map((entry) => [
				entry.version,
				{
					version: entry.version,
					compat: entry.compat,
					steps: entry.steps,
					declared: entry.declared,
				},
			]),
		),
		data: Object.fromEntries(
			entries.map((entry) => [entry.version, parseVersionString(entry.data)]),
		),
	};
}
