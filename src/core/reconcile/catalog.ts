/**
 * RECONCILE CATALOG — the static assembly of every registered reconcile
 * (registry.ts, S-10). One import line per owner: the definition lives NEXT TO
 * the logic it wraps, this file only lists them. Peers (src/ai, src/diffusion)
 * enter through their facades (boundary_seam_tripwire: facade-only).
 *
 * `registerAllReconciles()` is idempotent and is what every door calls before
 * listing or running: the server boot (server.ts), the maintenance widget
 * (area_maintenance/widgets/reconcile_status.ts), the CLI (scripts/reconcile.ts)
 * and the gates. Its result MUST cover REGISTERED_NAMES exactly — the census
 * tripwire asserts it.
 *
 * It is ASYNC because the diffusion definition enters through a DYNAMIC import
 * of the diffusion facade: the dependency direction is diffusion → core, never
 * the reverse (diffusion_boundaries rule (c)), so core may not import
 * src/diffusion statically — this file is a sanctioned lazy seam, listed in
 * DIFFUSION_IMPORT_SEAMS there.
 */

import { RAG_INDEX_RECONCILE } from '../../ai/rag/reconcile.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { COUNTERS_MEDIA_RECONCILE } from '../media/counter_reconcile.ts';
import { FILES_INFO_RECONCILE } from '../media/files_info_reconcile.ts';
import { RICH_TEXT_IMAGES_RECONCILE } from '../media/rich_text_image_reconcile.ts';
import { HIERARCHY_RECONCILE } from '../ontology/hierarchy_state.ts';
import { ONTOLOGY_IDENTIFIERS_RECONCILE } from '../ontology/identifier_grammar.ts';
import {
	ONTOLOGY_MACHINE_NAMES_RECONCILE,
	ONTOLOGY_MACHINE_NAMES_STRAYS_RECONCILE,
} from '../ontology/machine_name_reconcile.ts';
import { ONTOLOGY_RECONCILE } from '../ontology/ontology_state.ts';
import { PUBLICATION_APIS_RECONCILE } from '../publication_host/api_reconcile.ts';
import { PUBLICATION_PROBE_RECONCILE } from '../publication_host/probe.ts';
import { PORTAL_DECLARED_ORDER_RECONCILE } from '../relations/declared_order_reconcile.ts';
import { DDO_SELF_DEPTH_RECONCILE } from '../relations/request_config/self_depth_check.ts';
import { OBSERVER_MIRRORS_RECONCILE } from '../section/record/observer_reconcile.ts';
import {
	listReconciles,
	REGISTERED_NAMES,
	type ReconcileDefinition,
	registerReconcile,
} from './registry.ts';

/** Every definition the engine ships, in registry order (the diffusion one lazily). */
export async function loadAllReconciles(): Promise<readonly ReconcileDefinition[]> {
	const {
		MEDIA_COPY_RECONCILE,
		MEDIA_INDEX_RECONCILE,
		PUBLIC_TIER_RECONCILE,
		WEB_IMAGE_EXPOSURE_RECONCILE,
	} = await import('../../diffusion/api/reconcile.ts');
	return [
		COUNTERS_MEDIA_RECONCILE,
		FILES_INFO_RECONCILE,
		OBSERVER_MIRRORS_RECONCILE,
		MEDIA_INDEX_RECONCILE,
		RAG_INDEX_RECONCILE,
		ONTOLOGY_RECONCILE,
		ONTOLOGY_IDENTIFIERS_RECONCILE,
		ONTOLOGY_MACHINE_NAMES_RECONCILE,
		ONTOLOGY_MACHINE_NAMES_STRAYS_RECONCILE,
		HIERARCHY_RECONCILE,
		PUBLIC_TIER_RECONCILE,
		PUBLICATION_APIS_RECONCILE,
		MEDIA_COPY_RECONCILE,
		PUBLICATION_PROBE_RECONCILE,
		RICH_TEXT_IMAGES_RECONCILE,
		WEB_IMAGE_EXPOSURE_RECONCILE,
		PORTAL_DECLARED_ORDER_RECONCILE,
		DDO_SELF_DEPTH_RECONCILE,
	];
}

/** Register the catalog (idempotent) and return the live listing. */
export async function registerAllReconciles(): Promise<ReconcileDefinition[]> {
	for (const definition of await loadAllReconciles()) registerReconcile(definition);
	const registered = listReconciles();
	if (registered.length !== REGISTERED_NAMES.length) {
		throw new DedaloError('internal.invariant', {
			message: `reconcile catalog is incomplete: registered ${registered.map((d) => d.name).join(',')} vs REGISTERED_NAMES ${REGISTERED_NAMES.join(',')}`,
		});
	}
	return registered;
}
