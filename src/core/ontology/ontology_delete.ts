/**
 * Ontology TLD teardown (PHP ontology::delete_main → delete_ontology).
 *
 * TWO callers want TWO different blast radii, and conflating them deleted the
 * wrong record:
 *
 *  - `deleteOntologyByTld` — uninstall a TLD's ONTOLOGY and nothing else:
 *      1. every dd_ontology node with that tld (ontology_state retractOntology);
 *      2. the ontology_main registry row resolved FROM THE TLD (PHP
 *         get_ontology_main_from_tld) — NOT the caller's record;
 *      3. every node record of the '{tld}0' section (per-record delete pipeline
 *         — TM snapshots included). Unresolvable '{tld}0' sections no-op.
 *    This is what tool_hierarchy's `force_to_create` needs: rebuild the virtual
 *    sections while the hierarchy1 record that DESCRIBES them stays put.
 *
 *  - `deleteOntologyMain` — the above, PLUS the caller's own registry record.
 *    This is the "user deletes a hierarchy1/ontology35 record" cascade
 *    (dd_core_api delete), where removing the record IS the point.
 *
 *  - `deleteOwnedHierarchyOntology` — the same teardown for tool_hierarchy's
 *    force rebuild, taking ONLY the classification verdict hierarchy_state.ts
 *    produced for an owned case 1 hierarchy, inside the rebuild's transaction.
 *    rebuildHierarchy never calls the unchecked `deleteOntologyByTld`.
 *
 * SAFETY: the tld is validated via safeTld (PHP safe_tld, /^[a-z]{2,}$/) and
 * the dd_ontology purge is strictly parameterized on it — nothing outside the
 * tld can match. Empty or unsafe tld → refuse (never guess).
 *
 * OWNERSHIP (HIER-REBUILD, WC-2026-11-10-hierarchy-rebuild-ownership): the TLD
 * comes from a registry row's EDITABLE hierarchy6. So every door refuses a
 * protected TLD (core + `test`) at the primitive itself — defence in depth —
 * and the record-delete cascade also refuses while another record of the same
 * registry declares the TLD (owner decision D3 a: no cascade, no record
 * delete). Refusals are `ontology.teardown_refused` + `reason`, before any
 * write. `deleteOntologyByTld` importers are allowlisted
 * (ontology_single_writer_tripwire): this module and the suite's test_data.
 */

import { isInTransaction, sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { clearOntologyDerivedCaches } from './cache_invalidation.ts';
import { retractOntology } from './ontology_state.ts';
import { ONTOLOGY_MAIN_SECTION } from './ontology_tipos.ts';
import { getOntologyMainFromTld } from './ontology_write.ts';
import { getMatrixTableFromTipo } from './resolver.ts';
import {
	anotherRegistryRowDeclaresTld,
	isProtectedTld,
	teardownRefused,
} from './teardown_scope.ts';
import { mapTldToTargetSectionTipo, safeTld } from './tld.ts';

/** Registry sections whose record deletion cascades (PHP sections::delete). */
export const ONTOLOGY_MAIN_SECTIONS: ReadonlySet<string> = new Set(['hierarchy1', 'ontology35']);

export interface OntologyDeleteOutcome {
	/** INTERNAL outcome discriminator (never a wire body). */
	ok: boolean;
	deletedNodes: number;
	deletedRecords: number;
	errors: string[];
}

/** A teardown that has not run yet (filled in by tearDownTld). */
function emptyOutcome(): OntologyDeleteOutcome {
	return { ok: false, deletedNodes: 0, deletedRecords: 0, errors: [] };
}

/** The caller's per-record delete (injected to avoid a module cycle with delete_record.ts). */
export type DeleteRecordFn = (sectionTipo: string, sectionId: number) => Promise<unknown>;

/** A registry record excluded from the by-tld sweep (its caller deletes it itself). */
interface RegistryRef {
	sectionTipo: string;
	sectionId: number;
}

/**
 * The TLD a registry record (hierarchy1 / ontology35) declares in hierarchy6.
 * Null when the record or its tld is missing/unsafe — the caller must refuse.
 */
export async function tldFromRegistryRecord(
	sectionTipo: string,
	sectionId: number,
): Promise<string | null> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return null;
	const rows = (await sql.unsafe(
		`SELECT string->'hierarchy6'->0->>'value' AS tld FROM "${table}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId],
	)) as { tld: string | null }[];
	return safeTld((rows[0]?.tld ?? '').trim().toLowerCase());
}

/**
 * Uninstall a TLD's ontology WITHOUT touching the registry record that describes
 * it. `skip` names a registry record the caller deletes itself (so the
 * ontology_main sweep does not delete it twice when the caller IS the
 * ontology_main record).
 */
export async function deleteOntologyByTld(
	tld: string,
	deleteRecord: DeleteRecordFn,
	skip?: RegistryRef,
): Promise<OntologyDeleteOutcome> {
	const outcome = emptyOutcome();

	const safe = safeTld(tld.trim().toLowerCase());
	if (safe === null) {
		outcome.errors.push(`empty or unsafe tld '${tld}' — cascade refused`);
		return outcome;
	}
	// The primitive never accepts a protected TLD, whoever calls it.
	if (isProtectedTld(safe)) {
		throw teardownRefused(safe, 'core', {
			detail: 'a core (or the suite test) TLD is never torn down by a registry door',
		});
	}
	return tearDownTld(safe, deleteRecord, outcome, skip);
}

/**
 * The force-rebuild teardown (hierarchy_state.ts rebuildHierarchy): the whole
 * TLD, from scratch (owner decision D10), for a hierarchy the classification
 * found OWNED. Runs inside the rebuild's transaction (its re-provisioning
 * shares it, so a failed provision rolls this back) — refused outside one.
 */
export async function deleteOwnedHierarchyOntology(
	owned: { readonly owned: true; readonly tld: string },
	deleteRecord: DeleteRecordFn,
): Promise<OntologyDeleteOutcome> {
	if (!isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message:
				'deleteOwnedHierarchyOntology: called outside a transaction (the rebuild must roll its teardown back on a failed provision)',
			coordinates: { tld: owned.tld },
		});
	}
	const safe = safeTld(owned.tld);
	if (owned.owned !== true || safe === null || isProtectedTld(safe)) {
		throw teardownRefused(owned.tld, 'core', {
			detail: 'the owned-teardown door was handed a protected or unsafe TLD',
		});
	}
	return tearDownTld(safe, deleteRecord, emptyOutcome());
}

/** The teardown body shared by both doors (the tld is safe and not protected). */
async function tearDownTld(
	safe: string,
	deleteRecord: DeleteRecordFn,
	outcome: OntologyDeleteOutcome,
	skip?: RegistryRef,
): Promise<OntologyDeleteOutcome> {
	// 1. dd_ontology nodes of the tld — through the whole-tld authority
	// (ontology_state.ts retractOntology; ontology_single_writer_tripwire): this
	// module issues no DML. Step 3's record deletes would unproject each node
	// themselves (the record lifecycle), but a node with no source record (an
	// orphan) is only reached here.
	outcome.deletedNodes = (await retractOntology(safe)).length;

	// 2. the ontology_main registry row FOR THIS TLD (PHP delete_ontology step 2).
	// Resolved from the tld, never from the caller — the caller may be a
	// hierarchy1 record, which must survive a force_to_create rebuild.
	const main = await getOntologyMainFromTld(safe);
	const mainIsSkipped =
		main !== null &&
		skip !== undefined &&
		skip.sectionTipo === ONTOLOGY_MAIN_SECTION &&
		skip.sectionId === main.section_id;
	if (main !== null && !mainIsSkipped) {
		await deleteRecord(ONTOLOGY_MAIN_SECTION, main.section_id);
		outcome.deletedRecords++;
	}

	// 3. every node record of the '{tld}0' section (when its table resolves).
	const nodesSection = mapTldToTargetSectionTipo(safe);
	// The tld's section node was just purged — drop every ontology-derived cache
	// so the table lookup below sees the current state. ('{tld}0' still resolves:
	// getMatrixTableFromTipo short-circuits any section_id-'0' tipo to
	// matrix_ontology BEFORE the node lookup, precisely for this moment.)
	await clearOntologyDerivedCaches();
	const nodesTable = await getMatrixTableFromTipo(nodesSection);
	if (nodesTable !== null) {
		const nodeRecords = (await sql.unsafe(
			`SELECT section_id FROM "${nodesTable}" WHERE section_tipo = $1`,
			[nodesSection],
		)) as { section_id: number }[];
		for (const record of nodeRecords) {
			await deleteRecord(nodesSection, Number(record.section_id));
			outcome.deletedRecords++;
		}
	}

	outcome.ok = true;
	return outcome;
}

/**
 * May deleting this registry record cascade into `tld`? Throws the refusal when
 * not: a protected TLD (`core`), or another record of the same registry still
 * declares it (`not_sole_declarer`, D3 a — the cascade would uninstall a TLD
 * the other record uses). The dd_core_api delete runs it for EVERY target
 * before the first cascade, so a multi-delete refuses whole.
 */
export async function assertRegistryCascadeAllowed(
	sectionTipo: string,
	sectionId: number,
	tld?: string | null,
): Promise<void> {
	const declared = tld ?? (await tldFromRegistryRecord(sectionTipo, sectionId));
	if (declared === null) return; // deleteOntologyMain refuses an unsafe tld itself
	const coordinates = { section_tipo: sectionTipo, section_id: sectionId };
	if (isProtectedTld(declared)) {
		throw teardownRefused(declared, 'core', {
			detail: 'a registry record declaring a core (or the suite test) TLD never cascades',
			coordinates,
		});
	}
	if (await anotherRegistryRowDeclaresTld(sectionTipo, sectionId, declared)) {
		throw teardownRefused(declared, 'not_sole_declarer', {
			detail: `another ${sectionTipo} record declares the same TLD — resolve the duplicate first`,
			coordinates,
		});
	}
}

/**
 * Uninstall the TLD of one registry record AND delete that record — the
 * dd_core_api delete cascade. `deleteRecord` runs with the cascade suppressed by
 * the caller (no recursion).
 */
export async function deleteOntologyMain(
	sectionTipo: string,
	sectionId: number,
	deleteRecord: DeleteRecordFn,
): Promise<OntologyDeleteOutcome> {
	const tld = await tldFromRegistryRecord(sectionTipo, sectionId);
	if (tld === null) {
		return {
			ok: false,
			deletedNodes: 0,
			deletedRecords: 0,
			errors: [`empty or unsafe tld for '${sectionTipo}/${sectionId}' — cascade refused`],
		};
	}
	await assertRegistryCascadeAllowed(sectionTipo, sectionId, tld);

	const outcome = await deleteOntologyByTld(tld, deleteRecord, { sectionTipo, sectionId });
	if (!outcome.ok) return outcome;

	// The registry record itself — the one thing the by-tld sweep never touches.
	await deleteRecord(sectionTipo, sectionId);
	outcome.deletedRecords++;
	return outcome;
}
