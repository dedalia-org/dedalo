/**
 * TEARDOWN SCOPE — the facts both TLD-teardown doors read before they delete
 * anything (HIER-REBUILD, WC-2026-11-10-hierarchy-rebuild-ownership).
 *
 * Two doors erase a TLD's ontology on the strength of a registry row's EDITABLE
 * `hierarchy6` literal: tool_hierarchy's force rebuild (hierarchy_state.ts
 * rebuildHierarchy) and the dd_core_api delete of a registry record
 * (ontology_delete.ts deleteOntologyMain). Neither may trust that literal on its
 * own. This leaf module holds what they share:
 *
 *  - the ONE refusal: `ontology.teardown_refused` with a `reason` extension key
 *    (owner decision D4) — `core`, `not_sole_declarer`, `root_only`,
 *    `ontology_package`, `invalid_source`;
 *  - the protected-TLD rule (`core`): a core TLD (core_tlds.ts) or the suite's
 *    `test` fixture TLD is never torn down by a registry door;
 *  - the SOLE-DECLARER scan: a registry row owns its TLD only when no OTHER
 *    record of the same registry section declares it (trim + lower-case, the
 *    `findHierarchyByTld` spelling). ONE function — T0-2's root-mint ownership
 *    test (hierarchy_state.ts isOwnProvisionedSection), the rebuild
 *    classification and door B's duplicate refusal all call it.
 *
 * A LEAF: it imports no teardown or provisioning module, so ontology_delete.ts
 * and hierarchy_state.ts both import it without a cycle.
 */

import { sql } from '../db/postgres.ts';
import { DedaloError, isDedaloError } from '../errors/dedalo_error.ts';
import { isCoreOntologyTld, isTestFixtureTld } from './core_tlds.ts';
import { getMatrixTableFromTipo } from './resolver.ts';

/** Why a teardown was refused (the `reason` extension key; closed set, D4). */
export type TeardownRefusalReason =
	| 'core'
	| 'not_sole_declarer'
	| 'root_only'
	| 'ontology_package'
	| 'invalid_source';

/** The registry error code every teardown refusal carries. */
export const TEARDOWN_REFUSED_CODE = 'ontology.teardown_refused';

/**
 * The refusal itself — thrown BEFORE the first write. `extend.reason` rides at
 * the envelope's top level (the client keys its explanation on it); `state` is
 * the hierarchy checklist when the refusing door has one (the panel re-renders).
 */
export function teardownRefused(
	tld: string,
	reason: TeardownRefusalReason,
	context: { detail: string; coordinates?: Record<string, unknown>; state?: unknown },
): DedaloError {
	const extend: Record<string, unknown> = { reason };
	if (context.state !== undefined) extend.state = context.state;
	return new DedaloError(TEARDOWN_REFUSED_CODE, {
		message: `teardown of the ontology of '${tld}' refused (${reason}): ${context.detail}`,
		details: { tld, reason },
		coordinates: { tld, reason, ...context.coordinates },
		extend,
	});
}

/** Is this the teardown refusal (a door's answer, never a failure to roll back into ok:false)? */
export function isTeardownRefusal(error: unknown): boolean {
	return isDedaloError(error) && error.code === TEARDOWN_REFUSED_CODE;
}

/** A TLD no registry door may tear down: a core TLD, or the suite's `test` fixture TLD. */
export function isProtectedTld(tld: string): boolean {
	return isCoreOntologyTld(tld) || isTestFixtureTld(tld);
}

/**
 * Does ANOTHER record of `registrySectionTipo` (hierarchy1 / ontology35) declare
 * `tld` in hierarchy6? The sole-declarer scan — the only ownership fact the
 * engine has (owner decision D1 a: derived, no recorded `provisioned_by`).
 */
export async function anotherRegistryRowDeclaresTld(
	registrySectionTipo: string,
	sectionId: number,
	tld: string,
): Promise<boolean> {
	const table = await getMatrixTableFromTipo(registrySectionTipo);
	if (table === null) return false;
	const rivals = (await sql.unsafe(
		`SELECT 1 FROM "${table}"
		 WHERE section_tipo = $1 AND section_id <> $2
		   AND lower(trim(string->'hierarchy6'->0->>'value')) = $3
		 LIMIT 1`,
		[registrySectionTipo, sectionId, tld.trim().toLowerCase()],
	)) as unknown[];
	return rivals.length > 0;
}
