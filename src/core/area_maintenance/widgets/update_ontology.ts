/**
 * update_ontology widget (UPDATE_PROCESS Phase 2) — panel + the ontology
 * import EXECUTE. Panel (PHP widgets/update_ontology::get_value): probe the
 * configured ONTOLOGY_SERVERS (+ the 'Local files' pseudo-server when this
 * instance is an ontology master), the installed-snapshot metadata from the
 * dd1 root node, the instance TLD list, and the destructive-action confirm
 * bytes. EXECUTE: ownership-gated — closed (coexisting) keeps the frozen
 * engine_denied envelope; open runs the staged/validated/recoverable import
 * pipeline (core/ontology/ontology_update.ts, WC-023).
 * export_to_translate / rebuild_lang_files stay closed-by-design: the TS
 * engine has no generated JS lang files (labels are repo catalogs, WC-033 —
 * they ride code deploys) and the translation-export CSV workflow is
 * superseded by the per-lang catalog diff (scripts/labels_fill.ts).
 *
 * The SERVING side (can others pull from here?) is its own widget since
 * 2026-09-28: serve_ontology.ts.
 */

import { config } from '../../../config/config.ts';
import { publicOrigin } from '../../resolve/public_origin.ts';
import type { Principal } from '../../security/permissions.ts';
import {
	engineDenied,
	fromOutcome,
	gated,
	type WidgetModule,
	type WidgetResponse,
} from './support.ts';

/**
 * PHP parity: the 'Local files' pseudo-server is THIS install, so it is forced
 * reachable — the probe travels the network stack to ourselves and a slow or
 * proxied loopback would otherwise disable the panel's own local source. Only
 * the localhost entry is touched, and only when the remote answered an object.
 */
function forceLocalhostReachable(server: Record<string, unknown>): void {
	if (server.code !== 'localhost') return;
	if (typeof server.result !== 'object' || server.result === null) return;
	(server.result as { result?: unknown }).result = true;
}

/**
 * The panel's SERVER LIST, probed: the configured ONTOLOGY_SERVERS plus the
 * 'Local files' pseudo-server this instance offers when it is itself an
 * ontology master, each annotated with the outcome of a live check.
 *
 * Extracted from updateOntologyGetValue (extract-AND-rewire, the CRAP program's
 * law) so the panel fold stays under the ratchet's frozen max: it is the one
 * part of that function with real control flow, and the parent is an
 * I/O-shaped fold that only assembles the answer.
 *
 * PHP parity: sequential 5 s checks, localhost forced reachable.
 */
async function probeOntologyServers(): Promise<Record<string, unknown>[]> {
	const { checkRemoteServer } = await import('../../ontology/data_io_import.ts');

	const servers: Record<string, unknown>[] = config.ontologyIo.servers.map((server) => ({
		...server,
	}));
	if (config.ontologyIo.isOntologyServer === true) {
		servers.push({
			name: 'Local files',
			url: `${publicOrigin()}/dedalo/core/api/v1/json/`,
			code: 'localhost',
		});
	}
	for (const server of servers) {
		const probe = await checkRemoteServer(server as { name: string; url: string; code: string });
		server.msg = probe.msg;
		server.errors = probe.errors;
		server.response_code = probe.code;
		// `server.result` is the REMOTE's own decoded body, and the key name is the
		// panel contract the client reads (render_update_ontology.js) — the probe's
		// own outcome field is `data` since the P1 sweep.
		server.result = probe.data;
		forceLocalhostReachable(server);
	}
	return servers;
}

/**
 * update_ontology panel (PHP get_value — response bytes preserved; the
 * legacy STRUCTURE_SERVER_URL/CODE fallback is not carried: TS installs are
 * v7-configured).
 */
/*
 * COVERAGE-EXEMPT (coverage plan §5.1; reason registered in
 * engineering/crap_coverage_exempt.json): this panel is ALREADY exercised end to
 * end through `dispatchGetWidgetValue` by test/unit/active_ontology_tlds.test.ts,
 * so a second direct gate would assert the same fold twice.
 */
async function updateOntologyGetValue(): Promise<WidgetResponse> {
	const { readDdOntologyRow } = await import('../../db/dd_ontology.ts');
	const { getLabels } = await import('../../labels/catalog.ts');
	const { currentApplicationLang } = await import('../../resolve/request_lang.ts');

	const servers = await probeOntologyServers();

	// TLD list: the configured active TLDs, always unioned with the core pair.
	// `..._configured` tells the panel whether ACTIVE_ONTOLOGY_TLDS was set at all
	// or the list below is the engine's fallback — an administrator needs to know
	// which of the two they are looking at before editing anything.
	const activeOntologyTlds = [
		...new Set([...config.ontologyIo.activeOntologyTlds, 'ontology', 'ontologytype']),
	];

	// Installed-snapshot metadata from the dd1 root node properties.
	const rootRow = (await readDdOntologyRow('dd1')) as {
		properties?: Record<string, unknown>;
	} | null;
	const properties = rootRow?.properties ?? {};
	const currentOntology = {
		date: properties.date ?? null,
		host: properties.host ?? null,
		entity: properties.entity ?? null,
		entity_label: properties.entity_label ?? null,
		version: properties.version ?? null,
	};

	const labels = await getLabels(currentApplicationLang());

	return {
		data: {
			servers,
			current_ontology: currentOntology,
			active_ontology_tlds: activeOntologyTlds,
			active_ontology_tlds_configured: config.ontologyIo.activeOntologyTldsConfigured,
			body: `${labels.update_ontology ?? 'Update ontology'} is disabled for ${config.entity}`,
			// Localized confirmation copy (WARNING label), served in the request's
			// application language; the English literal is a fallback only.
			confirm_text:
				labels.update_ontology_confirm_text ??
				'!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! WARNING !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
					'OVERWRITING THE COMMON ONTOLOGIES\n' +
					'The ontology of every selected TLD (the common/shared ontologies) will be replaced\n' +
					"by the master's server version and re-processed. This cannot be undone.\n" +
					'Your local ontology is NOT overwritten: custom TLDs and localontology overrides\n' +
					"are kept — unless you include 'localontology' in the list to update.\n" +
					'Are you sure you want to continue?',
		},
	};
}

/**
 * The OPEN (owned) branch: the staged/recoverable import (WC-023).
 *
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): a two-field unwrap forwarding to
 * `core/ontology/ontology_update.ts`, whose orchestrator IS gated (over the `zzd`
 * scratch TLD) by test/unit/ontology_update_shell_native.test.ts. Executing it
 * through this shell REPLACES THE SHARED ONTOLOGY.
 */
async function updateOntologyOwned(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { updateOntology } = await import('../../ontology/ontology_update.ts');
	const outcome = await updateOntology(options, principal.userId);
	// The client reads root_info at the TOP LEVEL of the response
	// (render_update_ontology.js), so it rides as an extension key.
	const { ok: _ok, msg: _msg, errors: _errors, ...rest } = outcome;
	return fromOutcome(outcome, { extend: rest });
}

export const widget: WidgetModule = {
	spec: {
		id: 'update_ontology',
		category: 'config',
		label: { kind: 'label', key: 'update_ontology' },
	},
	apiActions: {
		// Ownership-gated (UPDATE_PROCESS Phase 2). Closed: frozen engine_denied.
		update_ontology: gated(
			'update_ontology.update_ontology',
			engineDenied(
				'update_ontology.update_ontology',
				'it replaces the shared dd_ontology from the PHP install ontology files',
			),
			updateOntologyOwned,
		),
		export_to_translate: engineDenied(
			'update_ontology.export_to_translate',
			'it writes translation export files into the PHP install',
		),
		rebuild_lang_files: engineDenied(
			'update_ontology.rebuild_lang_files',
			'it regenerates the PHP tree JS lang files',
		),
	},
	// The ontology import rewrites dd_ontology wholesale: maintenance (PERF-11).
	unboundedActions: ['update_ontology'],
	getValue: updateOntologyGetValue,
};
