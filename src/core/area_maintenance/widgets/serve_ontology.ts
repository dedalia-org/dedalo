/**
 * serve_ontology widget — the PROVIDER side of the ontology exchange: can OTHER
 * installations pull their ontology from THIS one?
 *
 * Split out of update_ontology (2026-09-28): that panel is the CONSUMER side (pull
 * a snapshot, overwrite the local ontology) and carried this readout as a collapsed
 * aside, so a master installation found its primary concern buried under a
 * destructive action it never runs. The answer is spread over three unrelated .env
 * keys (IS_AN_ONTOLOGY_SERVER, ONTOLOGY_SERVERS codes, DEDALO_CORS_ALLOWED_ORIGINS);
 * the panel reports each one plus the endpoint clients register.
 *
 * DISPLAY-ONLY: no apiActions — nothing new is reachable from the wire, and
 * update_ownership_tripwire has nothing to classify. Nothing here is a secret: the
 * access code is reported as configured/not, never echoed.
 *
 * TS-only (no PHP twin): WC-2026-09-28-maintenance-serve-ontology-widget.
 * Gate: test/unit/serve_ontology_widget.test.ts.
 */

import { config } from '../../../config/config.ts';
import { publicOrigin } from '../../resolve/public_origin.ts';
import type { WidgetModule, WidgetResponse } from './support.ts';

async function serveOntologyGetValue(): Promise<WidgetResponse> {
	// dynamic-import rationale 3, engineering/CONVENTIONS.md §2.
	const { CORS_ENABLED } = await import('../../security/cors.ts');
	return {
		data: {
			enabled: config.ontologyIo.isOntologyServer === true,
			// At least one accepted access code: the codes live in ONTOLOGY_SERVERS
			// (ONTOLOGY_SERVER_CODE is retired). Wire key kept for the client contract.
			has_server_code: config.ontologyIo.servers.some((entry) => entry.code.length > 0),
			cors_enabled: CORS_ENABLED,
			url: `${publicOrigin()}/dedalo/core/api/v1/json/`,
		},
	};
}

export const widget: WidgetModule = {
	spec: {
		id: 'serve_ontology',
		category: 'config',
		label: { kind: 'label', key: 'serve_ontology' },
	},
	getValue: serveOntologyGetValue,
};
