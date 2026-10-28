/**
 * Engine version — the ONE source of truth (UPDATE_PROCESS Phase 0).
 * PHP twin: core/base/version.inc (DEDALO_VERSION/DEDALO_MAJOR_VERSION) +
 * shared/core_functions.php get_dedalo_version(). Every engine/data version
 * literal derives from the triple below; the update_ownership_tripwire literal
 * scan keeps new hardcodes out of src/. Leaf module — imports only the pure
 * release-identity grammar (release_identity.ts, itself a leaf).
 */

import { parseReleaseVersion } from './release_identity.ts';

/** The engine version triple (PHP get_dedalo_version() shape). */
export const DEDALO_DATA_VERSION: readonly [number, number, number] = Object.freeze([7, 0, 0]) as [
	number,
	number,
	number,
];

/**
 * The string spelling of a triple (`[7, 0, 0]` → `'7.0.0'`) — the one helper that
 * turns a version constant into text (VERSIONING_SPEC §5: no string copy of the
 * triple exists, so none can drift). Compare triples, not strings.
 */
export function formatVersion(triple: readonly number[]): string {
	return triple.join('.');
}

/**
 * The next release the code is building toward (VERSIONING_SPEC §5, D6 name:
 * DEDALO_NEXT_RELEASE): the triple an UNTAGGED tree names its nightly with
 * (`7.0.0-dev`). It is the release that has NOT been tagged yet, so it stays at
 * the data triple until that release is tagged (7.0.0 is next until v7.0.0 exists);
 * it moves forward to the next patch triple in the post-release commit (spec §6).
 * It is NOT a data version: DEDALO_DATA_VERSION above stays the last
 * data-changing release, and nothing that migrates, names a code directory or
 * crosses to a peer reads this constant. Never below the data triple.
 */
export const DEDALO_NEXT_RELEASE: readonly [number, number, number] = Object.freeze([7, 0, 0]) as [
	number,
	number,
	number,
];

// The code's RELEASE IDENTITY (`7.0.0`, `7.0.0-beta.6`, `7.0.0-dev`) lives in
// build_stamp.ts / release_identity.ts: it is derived from the git tag, and
// reading that needs fs/git — this module stays a leaf.

/** '7.0' — the ontology IO directory segment (patch releases share one dir, PHP parity). */
export const DEDALO_VERSION_MAJOR_MINOR: string = `${DEDALO_DATA_VERSION[0]}.${DEDALO_DATA_VERSION[1]}`;

/**
 * Semantic int[] version compare: -1 / 0 / 1. Missing segments count as 0
 * ([7,0] equals [7,0,0]) — the matrix_updates ordering contract (PHP
 * string_to_array(...)::int[] DESC) and PHP version_compare padding.
 */
export function compareVersionArrays(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const da = a[i] ?? 0;
		const db = b[i] ?? 0;
		if (da > db) return 1;
		if (da < db) return -1;
	}
	return 0;
}

/**
 * A version string → its numeric parts. A tag-named RELEASE IDENTITY (`7.0.0`,
 * `7.0.0-beta.6`, `7.0.0-rc.1`) → its triple [7,0,0]: a prerelease is the same
 * data version as its release, and a peer that sends one (an engine calling
 * itself by its tag) must be read, never refused as NaN. A dev identity
 * (`7.0.0-dev`, the nightly of the unreleased 7.0.0) names the NEXT triple, not
 * a data version, so data consumers must never be handed one; the data side
 * sends DEDALO_DATA_VERSION. Anything
 * else keeps the historical split (a legacy trailing `.dev` stripped,
 * extra parts preserved, garbage → NaN parts for the caller to refuse).
 */
export function parseVersionString(version: string): number[] {
	const identity = parseReleaseVersion(version);
	// A dev identity is not a data triple (owner decision 2026-10-26): it falls
	// through to the split below, where `7.0.0-dev` yields a NaN part for the
	// caller to refuse.
	if (identity !== null && !identity.dev) return [...identity.triple];
	return version
		.replace(/\.dev$/, '')
		.split('.')
		.map(Number);
}
