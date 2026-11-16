/**
 * THE PUBLICATION-SERVICES RECORD an rdf element's subject IRIs need (T1-4).
 *
 * The rdf graph builder resolves every base IRI from the dd1010 record of
 * (DEDALO_ENTITY_ID, the element's service_type): dd1016 → the dd1000 entity,
 * dd1037 → the dd1020 service type, dd1014 (component_iri) the base IRIs keyed
 * by title (src/diffusion/resolve/rdf_graph.ts servicesRecord / resolveBase).
 * dd1010 is a core section, not a situation section, so the zzdif rdf gates
 * create this ONE record here — at one explicit id this helper owns — and sweep
 * it after, under its own service type (the install seed's dd1010 record keys
 * another one, so the two never answer the same lookup).
 *
 * Writes only to a database that SAYS it is the suite's (assertTestDatabase);
 * the id is a typo guard, NOT a reserved band (isolation is the database).
 */

import { config } from '../../src/config/config.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithExplicitId,
} from '../../src/core/db/matrix_write.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

/** dd1010's matrix table, resolved like the engine resolves it (never hard-coded). */
async function servicesTable(): Promise<string> {
	const table = await getMatrixTableFromTipo(SERVICES_SECTION);
	if (table === null) {
		throw new DedaloError('internal.invariant', {
			message: 'rdf_services_fixture: dd1010 resolves no matrix table',
		});
	}
	return table;
}

const SERVICES_SECTION = 'dd1010';
/** The one record this helper owns. */
export const RDF_SERVICES_RECORD_ID = 931010;
const SCRATCH_ID_FLOOR = 900000;

function assertScratchId(): void {
	if (RDF_SERVICES_RECORD_ID < SCRATCH_ID_FLOOR) {
		throw new DedaloError('internal.invariant', {
			message: `rdf_services_fixture: id ${RDF_SERVICES_RECORD_ID} is below the scratch floor ${SCRATCH_ID_FLOOR} — refusing to touch an installed record`,
			coordinates: { section: SERVICES_SECTION },
		});
	}
}

function locator(sectionTipo: string, sectionId: number, fromComponent: string) {
	return {
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: fromComponent,
	};
}

/**
 * Create the services record for `serviceType` with `bases` ([title, iri]).
 * Idempotent: a crashed run's record is swept first.
 */
export async function ensureRdfServicesRecord(
	serviceType: number,
	bases: readonly (readonly [string, string])[],
): Promise<void> {
	await assertTestDatabase('ensureRdfServicesRecord');
	assertScratchId();
	const table = await servicesTable();
	await deleteMatrixRecord(table, SERVICES_SECTION, RDF_SERVICES_RECORD_ID);
	await insertMatrixRecordWithExplicitId(table, SERVICES_SECTION, RDF_SERVICES_RECORD_ID, {
		relation: {
			dd1016: [locator('dd1000', config.identity.entityId, 'dd1016')],
			dd1037: [locator('dd1020', serviceType, 'dd1037')],
		},
		iri: {
			dd1014: bases.map(([title, iri], index) => ({ id: index + 1, iri, title })),
		},
	});
}

/** Sweep it; returns how many rows went (0 when it was already gone). */
export async function removeRdfServicesRecord(): Promise<number> {
	await assertTestDatabase('removeRdfServicesRecord');
	assertScratchId();
	return deleteMatrixRecord(await servicesTable(), SERVICES_SECTION, RDF_SERVICES_RECORD_ID);
}
