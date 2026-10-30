/**
 * tool_ontology_parser handler — PHP
 * tools/tool_ontology_parser/class.tool_ontology_parser.php.
 *
 * Developer-only. The dd_ontology write is OWNED by core/ontology/ontology_state.ts
 * (inspect/rebuild — the single rebuild authority); this tool is a gated door onto it,
 * matching the tool_hierarchy → hierarchy_state pattern. Registered actions:
 *  - get_ontologies: the census — every matrix_ontology_main record's UI metadata
 *    ({target_section_tipo, tld, name, typology_id, typology_name}); skips records missing
 *    target/tld (non-fatal). Shared with update_ontology_info (data_io.ts getActiveOntologies).
 *  - inspect_ontologies (READ): the drift of each selected TLD (which dd_ontology nodes are
 *    missing, stale or orphaned vs the matrix source). The client's status panel.
 *  - repair_tlds (WRITE, SOURCE data): rewrite a misfiled `ontology7` back to its section's
 *    tld. The read-only edit field left no other way to clear the drift inspect reports.
 *  - regenerate_ontologies (WRITE, the ONE projection write): TRANSACTIONAL
 *    wipe-and-rebuild (rebuildOntology). The incremental `reconcile_ontologies`
 *    companion was removed 2026-08-11 — a transactional rebuild publishes atomically
 *    (MVCC: no reader ever sees the wipe), so the weaker writer bought nothing but a
 *    choice the operator had no criterion to make. See the ontology_state.ts header.
 *    It does NOT rebuild the LLM map — that post-step moved to export_ontologies alone
 *    (WC-2026-08-11-regenerate-drops-llm-map-post-step): the map is a DISTRIBUTION file
 *    served next to ontology.json and the per-TLD dumps, none of which a regenerate
 *    refreshes, and rebuilding it cost 21s of the tool's 22s on a 752-section install.
 *  - export_ontologies: the ordered export pipeline (PHP :301-409):
 *    update_ontology_info → export_ontology_info (both hard-abort) → per-TLD
 *    export_to_file (fail-and-continue, run BOUNDED-PARALLEL — see
 *    EXPORT_CONCURRENCY) → export_private_lists_to_file → export_llm_map;
 *    result=true only when zero errors accumulated. Only the per-TLD step
 *    parallelizes; the four surrounding steps stay strictly sequential.
 */

import { DedaloError, isDedaloError, ok } from '../../../src/core/errors/index.ts';
import type { OntologyIoResponse } from '../../../src/core/ontology/data_io.ts';
import {
	exportLlmMap,
	exportOntologyInfo,
	exportPrivateListsToFile,
	exportToFile,
	getActiveOntologies,
	updateOntologyInfo,
} from '../../../src/core/ontology/data_io.ts';
import { normalizeOntologyTld } from '../../../src/core/ontology/data_io_import.ts';
import {
	inspectOntology,
	type OntologyWriteResult,
	rebuildOntologies,
} from '../../../src/core/ontology/ontology_state.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/** Every action here is developer-only (PHP parity); the gate is imperative. */
function assertDeveloper(context: ToolActionContext): void {
	if (!context.principal.isDeveloper) {
		throw new DedaloError('perm.developer_required', {
			coordinates: { tool: 'tool_ontology_parser' },
		});
	}
}

/**
 * A batch that ran but did not come out clean. The per-TLD lines are what the
 * client's panel renders, so they ride as NAMED failure extension keys
 * (ERRORS_SPEC §3.0 — the `start`/`environment` precedent): without them the
 * operator is told "it failed" and nothing about which ontology.
 */
function batchFailed(summary: string, errors: string[], arMsg: string[]): DedaloError {
	return new DedaloError('tool.action_failed', {
		coordinates: { tool: 'tool_ontology_parser' },
		message: `${summary} — ${errors.join('; ')}`,
		extend: { errors, ar_msg: arMsg },
	});
}

/** The selected TLDs from options, coerced to a clean string list. */
function selectedTlds(context: ToolActionContext): string[] {
	const selected = context.options.selected_ontologies;
	return Array.isArray(selected) ? selected.map((tld) => String(tld)) : [];
}

/** Roll a per-TLD rebuild batch into one tool response. */
function summarize(
	outcomes: OntologyWriteResult[],
	tlds: string[],
	verb: string,
	context: ToolActionContext,
): ToolResponse {
	const errors: string[] = [];
	const ar_msg: string[] = [];
	let applied = 0;
	outcomes.forEach((outcome, index) => {
		const tld = tlds[index] ?? outcome.state.tld ?? '?';
		if (!outcome.ok) errors.push(`${tld}: ${outcome.msg}`);
		errors.push(...outcome.errors.map((error) => `${tld}: ${error}`));
		applied += outcome.applied.length;
		ar_msg.push(
			`${tld}: ${outcome.msg}${outcome.applied.length ? ` (${outcome.applied.join('; ')})` : ''}`,
		);
	});
	if (errors.length > 0) throw batchFailed(`${verb} completed with errors`, errors, ar_msg);
	return ok(
		{
			summary: `${verb} ${outcomes.length} ontolog${outcomes.length === 1 ? 'y' : 'ies'} — ${applied} change(s)`,
			ar_msg,
		},
		{ requestId: toolRequestId(context) },
	);
}

export async function toolOntologyParserGetOntologies(
	context: ToolActionContext,
): Promise<ToolResponse> {
	assertDeveloper(context);
	const census = await getActiveOntologies();

	// PHP get_ontologies wire shape: exactly the five UI metadata fields
	// (name_data stays internal to the census / update_ontology_info).
	const ontologies = census.ontologies.map((entry) => ({
		target_section_tipo: entry.target_section_tipo,
		tld: entry.tld,
		name: entry.name,
		typology_id: entry.typology_id,
		typology_name: entry.typology_name,
	}));

	// Wire shape (ledgered, WC-2026-08-15-tool-response-envelope-v2): `data` IS the
	// flat census array — the client does `self.ontologies = response_data(...)` and
	// `.find`s on it. `census.errors` are per-ontology notes on an otherwise
	// successful read: a handler-owned EXTENSION key on success (ERRORS_SPEC §3.0),
	// read through `response_extension(api_response, 'errors')`, never the
	// envelope's failure channel and never nested inside `data`.
	return ok(ontologies, {
		requestId: toolRequestId(context),
		extend: { errors: census.errors },
	});
}

/**
 * READ: the drift of each selected TLD (core/ontology/ontology_state.ts inspectOntology).
 * The client renders this as a per-TLD status panel — which nodes are missing, stale or
 * orphaned — so an operator SEES why an ontology is out of sync before touching anything.
 */
export async function toolOntologyParserInspect(context: ToolActionContext): Promise<ToolResponse> {
	assertDeveloper(context);
	const tlds = selectedTlds(context);
	const states = [];
	for (const tld of tlds) states.push(await inspectOntology(tld));
	return ok({ states }, { requestId: toolRequestId(context) });
}

/**
 * WRITE (source data): REPAIR the misfiled `ontology7` of each selected TLD's records.
 *
 * THE DOOR THIS RESTORES. `ontology7` is derived from the section (ONT-TLD), so the edit form
 * renders it read-only — which removed the one place an operator could correct a record whose
 * tld is wrong. Inspect still reports those records ("…declares tld 'act', not 'actv' — fix the
 * record's ontology7"), so without this the tool named a defect and offered no way to clear it,
 * and the node stayed misfiled or invisible forever.
 *
 * It is DELIBERATELY NOT folded into rebuild. Rebuild writes the PROJECTION
 * (`dd_ontology`) from the source; this writes the SOURCE. Those are different blast radii and
 * an operator is entitled to choose the second explicitly. It also cannot ride inside
 * rebuild's transaction — normalizeOntologyTld runs through `psql` on its own connection, so
 * it would block on the rows the transaction holds.
 *
 * SCOPE, from normalizeOntologyTld: only rows that ARE nodes (they carry a component besides
 * their own ontology7) and whose declared tld differs from the section's. Contentless shells —
 * the legacy `tldless` population — are untouched by design: stamping a tld on one would
 * materialize a nameless node in the tree. Those stay reported, for a human to fill or delete.
 */
export async function toolOntologyParserRepairTlds(
	context: ToolActionContext,
): Promise<ToolResponse> {
	assertDeveloper(context);
	const tlds = selectedTlds(context);
	const errors: string[] = [];
	const ar_msg: string[] = [];
	let repaired = 0;
	for (const tld of tlds) {
		const sectionTipo = `${tld}0`;
		const rewritten = await normalizeOntologyTld(sectionTipo);
		if (rewritten === null) {
			errors.push(`${tld}: ontology7 repair failed`);
			ar_msg.push(`${tld}: repair FAILED`);
			continue;
		}
		repaired += rewritten;
		ar_msg.push(
			rewritten === 0
				? `${tld}: nothing to repair`
				: `${tld}: rewrote ontology7 on ${rewritten} record(s)`,
		);
	}
	if (errors.length > 0) throw batchFailed('Repair finished with errors', errors, ar_msg);
	return ok(
		{
			summary: `OK. Repaired ${repaired} record(s). Run Rebuild to re-derive dd_ontology.`,
			ar_msg,
		},
		{ requestId: toolRequestId(context) },
	);
}

/**
 * WRITE: TRANSACTIONAL rebuild — wipe and re-derive each selected TLD's dd_ontology from
 * scratch (rebuildOntology). The ONE write door onto the projection. The delete + reinsert
 * run in one transaction per TLD, so a failure rolls back with no empty window and no
 * leftover backup table, and no reader ever observes the wipe.
 *
 * IT DOES NOT REBUILD THE LLM MAP (WC-2026-08-11-regenerate-drops-llm-map-post-step). PHP ran
 * export_llm_map here and merged its errors in. `ontology_llm_map.json` is a DISTRIBUTION
 * artifact — served by `serveOntologyIoFile` beside `ontology.json` and the per-TLD dumps,
 * read by nothing in the engine — and a regenerate refreshes none of its companions, so the
 * map alone being fresh made the export set no more coherent. It is rebuilt by
 * `export_ontologies` (step 5), which is what publishes the rest. Measured cost of the removed
 * step on dedalo7_mht: 21.2s of a 22.1s request (752 sections × 9408 link fields, each
 * building its own request_config), against 76ms for the parse+diff of the TLD asked for.
 */
export async function toolOntologyParserRegenerate(
	context: ToolActionContext,
): Promise<ToolResponse> {
	assertDeveloper(context);
	const tlds = selectedTlds(context);
	const outcomes = await rebuildOntologies(tlds, context.userId);
	return summarize(outcomes, tlds, 'Rebuilt', context);
}

/**
 * The five data_io calls export_ontologies makes, injectable for the unit
 * gate on ordering/abort semantics (production uses the data_io module fns).
 */
export interface OntologyExportIo {
	updateOntologyInfo: (userId: number) => Promise<boolean>;
	exportOntologyInfo: () => Promise<OntologyIoResponse>;
	exportToFile: (tld: string) => Promise<OntologyIoResponse>;
	exportPrivateListsToFile: () => Promise<OntologyIoResponse>;
	exportLlmMap: () => Promise<OntologyIoResponse>;
}

const PRODUCTION_IO: OntologyExportIo = {
	updateOntologyInfo,
	exportOntologyInfo,
	exportToFile,
	exportPrivateListsToFile,
	exportLlmMap,
};

/**
 * Max per-TLD exports in flight at once. Each io.exportToFile forks its own
 * psql subprocess (\copy … TO PROGRAM 'gzip …'); with 100+ ontologies a fully
 * unbounded fan-out would spawn 100+ processes — this caps it.
 */
const EXPORT_CONCURRENCY = 6;

/**
 * PHP export_ontologies (:301-409) — the ordered pipeline with PHP's
 * abort/continue semantics, ONE deliberate reorder (U-41):
 *   1. updateOntologyInfo    — HARD ABORT on failure (nothing written);
 *   2. per-TLD exportToFile  — BOUNDED-PARALLEL (≤ EXPORT_CONCURRENCY in
 *      flight): soft-fail per TLD (errors recorded, the others continue);
 *      a THROWN error (file-not-created) aborts everything via the outer
 *      catch — PHP parity. Steps 1,3,4,5 stay strictly sequential; only
 *      this one parallelizes (the per-TLD dumps are independent — each
 *      forks its own psql writing its own <tld>.copy.gz, no shared state);
 *   3. exportPrivateListsToFile — always runs regardless of per-TLD errors;
 *   4. exportOntologyInfo    — HARD ABORT on failure. AFTER the dumps (PHP
 *      wrote it before them): ontology.json carries the sha256 of every
 *      served file, so it must be written once their final bytes are on
 *      disk. Until it lands the previous manifest's digests no longer match
 *      the new files — a consumer fetching mid-export is REFUSED, never fed
 *      an unverified mix;
 *   5. exportLlmMap          — always runs; errors merged.
 * result=true only when the errors array is still empty after the full run.
 */
export async function runExportOntologies(
	context: ToolActionContext,
	io: OntologyExportIo = PRODUCTION_IO,
): Promise<ToolResponse> {
	assertDeveloper(context);

	// The RUNNING report — deliberately NOT envelope-shaped: it is this
	// function's working state, and only the two exits below reach the wire.
	const report: { summary: string; errors: string[]; ar_msg: string[] } = {
		summary: '',
		errors: [],
		ar_msg: [],
	};

	// Guard against a client sending null or a non-array value. An empty array
	// would write only the metadata file — not useful (PHP parity).
	const selected = context.options.selected_ontologies;
	if (!Array.isArray(selected) || selected.length === 0) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'selected_ontologies must be a non-empty array',
		});
	}
	const tlds = selected.map((tld) => String(tld));

	try {
		// 1. Stamp current time/version/active TLDs into dd0/1 ontology18.
		// (!) Must run before exportOntologyInfo, which reads the value just written.
		const updated = await io.updateOntologyInfo(context.userId);
		if (!updated) {
			throw batchFailed(
				'Unable to update ontology information in dd1 (ontology40_1)',
				['unable to update_ontology_info'],
				report.ar_msg,
			);
		}

		// 2. Per-TLD exports — BOUNDED-PARALLEL. Each exportToFile forks an
		// independent psql writing its own <tld>.copy.gz with no shared state,
		// so the exports are safe to overlap; we run at most EXPORT_CONCURRENCY
		// at a time (chunked allSettled) instead of the old strict sequence.
		// Steps 1,3,4,5 above/below stay sequential — only this step parallelizes.
		let done = 0;
		const arMsg: string[] = [];
		const settled: PromiseSettledResult<OntologyIoResponse>[] = [];
		for (let i = 0; i < tlds.length; i += EXPORT_CONCURRENCY) {
			const chunk = tlds.slice(i, i + EXPORT_CONCURRENCY);
			// allSettled preserves input order within a chunk; chunks are pushed
			// in order — so `settled` stays in the original tld order regardless
			// of which subprocess finished first.
			settled.push(...(await Promise.allSettled(chunk.map((tld) => io.exportToFile(tld)))));
		}

		// A THROWN export (COPY output file not created) aborts everything —
		// re-throw the first (input-order) rejection so the outer catch reports
		// it exactly as the old sequential loop did (PHP parity). Other in-flight
		// exports may already have run; that is acceptable — the overall result
		// still becomes a failure.
		const firstRejected = settled.find((result) => result.status === 'rejected');
		if (firstRejected?.status === 'rejected') {
			throw firstRejected.reason;
		}

		// Soft-fail per TLD: record errors, count only successes, keep going.
		// arMsg is emitted in input tld order (settled is order-preserving).
		for (const result of settled) {
			if (result.status !== 'fulfilled') continue; // unreachable: rejects thrown above
			const ontologyResponse = result.value;
			arMsg.push(ontologyResponse.msg);
			if (ontologyResponse.ok === false) {
				report.errors.push(...(ontologyResponse.errors ?? []));
				continue;
			}
			done++;
		}

		// 3. Private lists — always runs regardless of per-TLD errors.
		const privateListResponse = await io.exportPrivateListsToFile();
		arMsg.push(privateListResponse.msg);
		if (privateListResponse.ok === false) {
			report.errors.push(...(privateListResponse.errors ?? []));
		}

		// 4. Shared metadata file — AFTER every dump: it carries their sha256
		// (U-41), so it is written once their final bytes are on disk.
		const infoResponse = await io.exportOntologyInfo();
		if (!infoResponse.ok) {
			throw batchFailed(
				'Unable to export the ontology information JSON file',
				['unable to export ontology info JSON file'],
				arMsg,
			);
		}

		// 5. LLM map — regenerated so it stays in sync with the new files.
		const llmMapResponse = await io.exportLlmMap();
		arMsg.push(llmMapResponse.msg);
		if (!llmMapResponse.ok) {
			report.errors.push(...(llmMapResponse.errors ?? []));
		}

		// The per-file ar_msg lines carry each file's path (relative to the I/O dir) + size;
		// name the target directory once here so the operator knows where to find them.
		const { config } = await import('../../../src/config/config.ts');
		report.ar_msg = arMsg;
		report.summary = `OK. Exported ${done} ontolog${done === 1 ? 'y' : 'ies'} to ${config.ops.ontologyDataIoDir}`;
	} catch (error) {
		// PHP outer catch: a thrown sub-step (e.g. COPY output file not created)
		// aborts the remaining steps and reports the message. A refusal this
		// function already typed passes through untouched.
		if (isDedaloError(error)) throw error;
		console.error('[tool_ontology_parser] export_ontologies exception:', error);
		throw batchFailed(
			'Export Ontologies request failed',
			[(error as Error).message],
			report.ar_msg,
		);
	}

	if (report.errors.length > 0) {
		throw batchFailed(
			'Errors found. Export Ontologies request failed.',
			report.errors,
			report.ar_msg,
		);
	}
	return ok(
		{ summary: report.summary, ar_msg: report.ar_msg },
		{ requestId: toolRequestId(context) },
	);
}

export async function toolOntologyParserExport(context: ToolActionContext): Promise<ToolResponse> {
	return runExportOntologies(context);
}
