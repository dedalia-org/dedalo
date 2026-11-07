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
import { pullServers } from '../../ontology/ontology_update_target.ts';
import { publicOrigin } from '../../resolve/public_origin.ts';
import type { Principal } from '../../security/permissions.ts';
import { engineDenied, gated, type WidgetModule, type WidgetResponse } from './support.ts';

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

	// On an ontology server a tlds-less entry is CODE-ONLY (an accepted code, not
	// a pull source): the panel does not offer it.
	const servers: Record<string, unknown>[] = pullServers(config.ontologyIo).map((server) => ({
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
 * Installed-snapshot metadata from the dd1 root node properties. Its five
 * null-coalescing reads are the branchiness the panel fold once carried;
 * extracted from updateOntologyGetValue (extract-AND-rewire, the CRAP program's
 * law) so that fold stays under the ratchet's frozen max.
 */
async function readInstalledOntologyMetadata(): Promise<Record<string, unknown>> {
	const { readDdOntologyRow } = await import('../../db/dd_ontology.ts');
	const rootRow = (await readDdOntologyRow('dd1')) as {
		properties?: Record<string, unknown>;
	} | null;
	const properties = rootRow?.properties ?? {};
	return {
		date: properties.date ?? null,
		host: properties.host ?? null,
		entity: properties.entity ?? null,
		entity_label: properties.entity_label ?? null,
		version: properties.version ?? null,
	};
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
async function updateOntologyGetValue(
	_options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { getLabels } = await import('../../labels/catalog.ts');
	const { currentApplicationLang } = await import('../../resolve/request_lang.ts');
	const { backupFreshnessCheck } = await import('../../update/status.ts');

	const servers = await probeOntologyServers();
	const currentOntology = await readInstalledOntologyMetadata();
	// What is installed here, so the panel can say "new" / "installed" per offered TLD.
	const { getActiveTlds } = await import('../../db/dd_ontology.ts');
	const installedTlds = [...(await getActiveTlds())].sort();

	// TLD list: the configured active TLDs, always unioned with the core pair.
	// `..._configured` tells the panel whether ACTIVE_ONTOLOGY_TLDS was set at all
	// or the list below is the engine's fallback — an administrator needs to know
	// which of the two they are looking at before editing anything.
	// The core pair is the update door's own constant. This list is the panel's
	// DEFAULT selection and what the unattended run takes (U-52, ontology_update.ts
	// assertUpdateTldScope); an operator's pick may take any TLD the picked master
	// offers (never localontology).
	const { CORE_UPDATE_TLDS } = await import('../../ontology/ontology_update.ts');
	const activeOntologyTlds = [
		...new Set([...config.ontologyIo.activeOntologyTlds, ...CORE_UPDATE_TLDS]),
	];

	const labels = await getLabels(currentApplicationLang());

	return {
		data: {
			servers,
			current_ontology: currentOntology,
			active_ontology_tlds: activeOntologyTlds,
			active_ontology_tlds_configured: config.ontologyIo.activeOntologyTldsConfigured,
			installed_tlds: installedTlds,
			// The run's backup gate, as the code panel reads it (`backup_fresh`):
			// the update is REFUSED unless this is `ok` or the operator waives it,
			// so the confirm modal states it (and offers the waiver) before the
			// update is sent, instead of after the refusal.
			backup: await backupFreshnessCheck(principal),
			body: `${labels.update_ontology ?? 'Update ontology'} is disabled for ${config.entity}`,
			// Localized irreversibility warning (the body of the confirm modal's
			// last `ui.confirm`), served in the request's application language;
			// the English literal is a fallback only.
			confirm_text:
				labels.update_ontology_confirm_text ??
				'The ontology of every selected TLD will be replaced by the selected server\u2019s version and re-processed. This cannot be undone.\n' +
					'localontology overrides are never part of an update and are kept; any other selected TLD replaces the installed one of the same name.\n' +
					'Are you sure you want to continue?',
		},
	};
}

/**
 * The request as the run's source + scope. A named server is the operator's
 * PICK: its url (or `localhost` for this master's own export) and EXACTLY the
 * files' TLDs — matrix_dd only when sent; an empty list stays an empty scope
 * (nothing to update), it never falls through to the unattended set. No
 * server: the unattended set, narrowed by the files' TLDs when there are any.
 */
function requestedPick(server: unknown, files: unknown): { source?: string; scope?: string[] } {
	const picked = server as { url?: unknown; code?: unknown } | null | undefined;
	const source =
		picked?.code === 'localhost'
			? 'localhost'
			: typeof picked?.url === 'string'
				? picked.url
				: null;
	const tlds = [
		...new Set(
			(Array.isArray(files) ? files : [])
				.map((file) => (file as { tld?: unknown } | null)?.tld)
				.filter((tld): tld is string => typeof tld === 'string'),
		),
	];
	if (source !== null) return { source, scope: tlds };
	return tlds.length === 0 ? {} : { scope: tlds };
}

/**
 * The OPEN (owned) branch: an ONTOLOGY-ONLY UPDATE RUN (update audit
 * 2026-10-29, Phase 2.4; core/update/run/start.ts startOntologyUpdateRun) —
 * journaled, under maintenance, behind the run's backup and lock, and resumed
 * by the next boot if the process dies mid-import. A request naming a
 * `server` is an operator's PICK: that one master, exactly the TLDs of the
 * request's files (an empty list updates nothing); without one the set is the
 * unattended one (D-6/D-8), only narrowed by the files' TLDs. `waive_backup:
 * true` waives the run's database backup, journaled. The staged/recoverable import itself (WC-023) is
 * core/ontology/ontology_update.ts, gated by ontology_update_shell_native.
 *
 * A BACKGROUND mediaJobs job, like the code update: the immediate answer is the
 * {pid, pfile} poll handle (dd_utils_api:get_process_status), the import's
 * progress frames (core/ontology/update_progress.ts) ride the job's `data`
 * while it runs, and the job's RESULT is the answer the panel renders
 * (`ontologyAnswer`). A refusal / failure is the job's coded error.
 *
 * COVERAGE-EXEMPT (coverage plan §5.2; reason registered in
 * engineering/crap_coverage_exempt.json): a thin shell over the run, whose
 * planner/executor/phase are gated (update_run_*_native). Executing it through
 * this shell REPLACES THE SHARED ONTOLOGY.
 */
async function updateOntologyOwned(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { startOntologyUpdateRun } = await import('../../update/run/start.ts');
	const { withOntologyProgress } = await import('../../ontology/update_progress.ts');
	const { mediaJobs } = await import('../../media/jobs.ts');
	const record = mediaJobs.submit(
		'update_ontology',
		async ({ onData }) => {
			const outcome = await withOntologyProgress(onData, () =>
				startOntologyUpdateRun(principal, {
					waiveBackup: options.waive_backup === true,
					...requestedPick(options.server, options.files),
				}),
			);
			return ontologyAnswer(outcome.journal);
		},
		// an operator's update never queues behind a transcode backlog (PERF-11)
		{ lane: 'maintenance', userId: principal.userId },
	);
	return {
		data: true,
		msg: `OK. Ontology job running in process ${process.pid}`,
		extend: { pid: process.pid, pfile: `${record.id}.json` },
	};
}

/**
 * The finished run as the panel reads it (render_update_ontology.js
 * render_update_result): msg + errors + root_info (+ census), and the run id.
 */
async function ontologyAnswer(
	journal: Parameters<typeof import('../../update/run/ontology_phase.ts').ontologyRunAnswer>[0],
): Promise<Record<string, unknown>> {
	const { ontologyRunAnswer } = await import('../../update/run/ontology_phase.ts');
	const answer = ontologyRunAnswer(journal);
	return {
		msg: answer.msg,
		...(answer.errors.length === 0 ? {} : { errors: answer.errors }),
		run_id: journal.run_id,
		root_info: answer.rootInfo,
		...(answer.census === null ? {} : { census: answer.census }),
	};
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
