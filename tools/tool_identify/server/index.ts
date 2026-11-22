/**
 * tool_identify server module — ONE action, and a reason for existing.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 *
 * tool_identify deliberately had NO server module: `find_matches`,
 * `identify_by_image` and `get_proposals` are single-request reads, and they
 * are already reachable as ordinary API actions on `dd_identify_api`. Adding a
 * tool module to re-expose them would have been a second door onto the same
 * engine with a second set of gates to keep in sync — exactly the coupling the
 * dispatch/handler split exists to avoid.
 *
 * CLUSTERING is the one thing that cannot be served that way. It compares a
 * whole pool of records with each other, two retrieval legs per record, so a run
 * over an import batch is minutes of work, not milliseconds — a request-scoped
 * action would hold a connection open, give the curator no progress and no way
 * to stop it, and die silently on a client navigation. Long-running work belongs
 * on the background-job tier (`core/tools/background.ts`), and the ONLY way onto
 * that tier is a tool action listed in a module's `backgroundRunnable`. So the
 * module exists for the runner, not for the API surface — and it holds exactly
 * the one action that needs it.
 *
 * ── WHAT IT DOES NOT DO: CONFIRM A CLUSTER ───────────────────────────────────
 *
 * Accepting a cluster ("these thirty are all Type X") links every member to a
 * Type record. That link is an ORDINARY `component_portal` value, and there is
 * no server work in writing thirty of them that the normal component save does
 * not already do — TM audit, transaction, counters, diffusion, relation index.
 * `tools/tool_cataloging/js/tool_cataloging.js` is the standing precedent: it
 * performs all of its writes through the standard `change_value` save from the
 * client, and gains a bespoke write path nowhere.
 *
 * So the write half is deliberately NOT here. This module is the READ/cluster
 * half only; confirming a cluster is a client action that issues the same
 * component save the record edit form issues, per member. A bespoke
 * "confirm_cluster" write endpoint would be a second write path into portals —
 * one more place for the save contract to drift, with no capability the existing
 * one lacks.
 */

import {
	type CandidateRecord,
	type ClusterProgress,
	type ClusterReport,
	clusterRecords,
} from '../../../src/ai/identify/cluster.ts';
import { isValidLang } from '../../../src/core/concepts/ontology.ts';
import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { DEFAULT_CLUSTER_POOL_CAP } from '../../../src/core/identify/record_pool.ts';
import { currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import { assertInstalledDataLang } from '../../../src/core/section/record/save_component.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/** Hard ceiling on the pool, whatever a caller asks for: the run is quadratic. */
const MAX_CAP = 2000;

/** The section targets of a cluster request — what the 'section_list' gate reads. */
function clusterSectionTipos(options: Record<string, unknown>): unknown[] {
	const raw = options.section_tipo;
	if (Array.isArray(raw)) return raw;
	return raw != null && raw !== '' ? [raw] : [];
}

/** A caller-supplied `records` list, in the engine's own shape. Ill-typed rows are dropped. */
function parseRecords(raw: unknown): CandidateRecord[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: CandidateRecord[] = [];
	for (const entry of raw) {
		const row = entry as { section_tipo?: unknown; section_id?: unknown };
		const sectionTipo = typeof row?.section_tipo === 'string' ? row.section_tipo : '';
		const sectionId = Number(row?.section_id);
		if (sectionTipo === '' || !Number.isFinite(sectionId)) continue;
		out.push({ sectionTipo, sectionId: Math.trunc(sectionId) });
	}
	return out;
}

/** A [0,1] threshold override, or undefined when the caller stated none. */
function parseThreshold(raw: unknown): number | undefined {
	if (raw === undefined || raw === null || raw === '') return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 1) return undefined;
	return value;
}

/** One record identity on the wire (the client's own snake_case shape). */
function wireRecord(record: CandidateRecord): { section_tipo: string; section_id: number } {
	return { section_tipo: record.sectionTipo, section_id: record.sectionId };
}

/**
 * The report, in the client's dialect. Every explanatory field the engine
 * computes travels: a curator asked to accept thirty records at once must be
 * able to read WHY they are together (`links`), how much single linkage had to
 * chain to get them there (`direct_edge_ratio` / `max_chain_hops`), and what the
 * members actually agree on (`consensus`). Shipping only the score would be the
 * unexplained number the whole subsystem refuses to produce.
 */
function toWire(report: ClusterReport): Record<string, unknown> {
	return {
		section_tipo: report.sectionTipos,
		records_considered: report.recordsConsidered,
		truncated: report.truncated,
		cap: report.cap,
		thresholds: report.thresholds,
		signals_used: report.signalsUsed,
		notes: report.notes,
		stopped: report.stopped,
		singletons: report.singletons.map(wireRecord),
		clusters: report.clusters.map((cluster) => ({
			id: cluster.id,
			members: cluster.members.map(wireRecord),
			representative: wireRecord(cluster.representative),
			representative_reason: cluster.representativeReason,
			signals: cluster.signals,
			confidence: cluster.confidence,
			weakest_link: cluster.weakestLink,
			direct_edge_ratio: cluster.directEdgeRatio,
			max_chain_hops: cluster.maxChainHops,
			agreed_on: cluster.agreedOn,
			consensus: cluster.consensus,
			links: cluster.links.map((link) => ({
				a: wireRecord(link.a),
				b: wireRecord(link.b),
				similarity: link.similarity,
				signal: link.signal,
				detail: link.detail,
			})),
		})),
	};
}

/**
 * cluster (backgroundRunnable): group a set of records into the things they are.
 *
 * The principal is the REQUEST'S, never a system one: clustering reads other
 * records and quotes their values, so the run must see exactly what the curator
 * who started it may see. `publishProgress` and `signal` are present only under
 * the background executor, and both are simply threaded through — the engine
 * checks the signal at every record boundary and nothing here writes, so a stop
 * can never leave anything half-done.
 */
async function cluster(ctx: ToolActionContext): Promise<ToolResponse> {
	const sectionTipos = clusterSectionTipos(ctx.options).map((tipo) => String(tipo));
	if (sectionTipos.length === 0) {
		// `publicMessage` as well as `message`: this action is backgroundRunnable,
		// and the executor records the converter's wire sentence on the job record
		// (background.ts `wireMessage`: the publicMessage of a public code) — the
		// one place a curator reads why a detached run stopped. `message` is the log.
		throw new DedaloError('request.invalid_options', {
			message: 'section_tipo is required (the sections to cluster within)',
			publicMessage: 'section_tipo is required (the sections to cluster within)',
		});
	}

	// Validated BEFORE anything runs (R2): a refused lang reaches no reader.
	const lang = clusterLang(ctx.options.lang);
	const rawCap = Number(ctx.options.cap);
	const cap =
		Number.isFinite(rawCap) && rawCap > 0
			? Math.min(Math.trunc(rawCap), MAX_CAP)
			: DEFAULT_CLUSTER_POOL_CAP;
	const rawTopK = Number(ctx.options.neighbour_top_k);
	const rawMinSize = Number(ctx.options.min_cluster_size);
	const sqoRaw = ctx.options.sqo;
	const publish = ctx.publishProgress;

	const report = await clusterRecords({
		sectionTipos,
		principal: ctx.principal,
		records: parseRecords(ctx.options.records),
		sqo:
			sqoRaw !== null && typeof sqoRaw === 'object' && !Array.isArray(sqoRaw)
				? (sqoRaw as Record<string, unknown>)
				: null,
		cap,
		imageThreshold: parseThreshold(ctx.options.image_threshold),
		criteriaThreshold: parseThreshold(ctx.options.criteria_threshold),
		...(Number.isFinite(rawTopK) && rawTopK > 0 ? { neighbourTopK: Math.trunc(rawTopK) } : {}),
		...(Number.isFinite(rawMinSize) && rawMinSize > 1
			? { minClusterSize: Math.trunc(rawMinSize) }
			: {}),
		lang,
		...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
		...(publish !== undefined
			? {
					onProgress: (progress: ClusterProgress) =>
						publish({
							msg: progress.msg,
							is_running: true,
							phase: progress.phase,
							counter: progress.counter,
							total: progress.total,
						}),
				}
			: {}),
	});

	const summary = report.stopped
		? `Stopped. ${report.clusters.length} cluster(s) found across ${report.recordsConsidered} record(s) before the stop.`
		: `OK. ${report.clusters.length} cluster(s) found across ${report.recordsConsidered} record(s); ${report.singletons.length} record(s) grouped with nothing.`;
	// The cap is reported in the SENTENCE too, not only as a flag: a curator
	// reading "12 clusters" must not take it for a statement about the whole
	// collection when it is a statement about the first `cap` records.
	const msg = report.truncated
		? `${summary} The pool cap (${report.cap}) stopped the run — more records match than were compared.`
		: summary;

	publish?.({
		msg,
		is_running: false,
		phase: 'done',
		counter: report.recordsConsidered,
		total: report.recordsConsidered,
	});
	// The human summary is PART OF THE PAYLOAD (the curator reads it beside the
	// clusters) — the legacy body carried it only as the response `msg`.
	return ok({ ...toWire(report), summary: msg }, { requestId: toolRequestId(ctx) });
}

/**
 * The run's data lang: the client's when it names one, else the REQUEST data
 * lang (read at this boundary; the clusterer never reads request identity
 * itself — review M2: omitted, the criteria resolved in the install default).
 *
 * A CLIENT lang is caller input that keys the path reader's JSONB slices, so it
 * is VALIDATED before anything runs (owner ruling 2026-11-22, R2): the lang
 * grammar first (`isValidLang`, the identifier gate's own check), then
 * membership in the data languages this installation declares
 * (`assertInstalledDataLang` — the read-reachable set, src/config/data_langs.ts,
 * the same one the write chokepoint admits). Either failure refuses as
 * `request.invalid_options` and the clusterer is never called.
 *
 * ONE RULE (review MED-3): the membership check also holds an OMITTED lang —
 * the request's data lang is held to the same set (change_lang now refuses to
 * store an undeclared one, so a session's own lang passes; a stale or seeded
 * one does not run silently against empty slices). Exported for its gate:
 * test/unit/tool_identify_cluster_lang.test.ts.
 */
export function clusterLang(raw: unknown): string {
	if (raw === undefined || raw === null) return assertInstalledDataLang(currentDataLang(), 'lang');
	if (typeof raw !== 'string' || !isValidLang(raw)) {
		throw new DedaloError('request.invalid_options', {
			message: `cluster: malformed lang ${JSON.stringify(raw)}`,
			publicMessage: 'lang is not a language code',
			coordinates: { lang: String(raw) },
		});
	}
	return assertInstalledDataLang(raw, 'lang');
}

export const tool: ToolServerModule = {
	name: 'tool_identify',
	apiActions: {
		// READ-level gate on every target section: clustering only reads records
		// (and the write half is a normal component save from the client — see the
		// module header), so demanding write level here would deny the curators the
		// feature is for.
		cluster: {
			permission: 'section_list',
			minLevel: 1,
			sectionTipos: clusterSectionTipos,
			// SUBMIT-TIME PREFLIGHT (review LOW-4): the lang rule runs in the admission
			// hook, which the framework calls before the handler AND, for a background
			// request, before scheduleBackground registers a job — so a refused lang
			// leaves no failed job behind. Synchronous by contract (clusterLang is).
			// The handler re-runs it: a queued job's turn reads the pinned langs.
			admit: ({ options }) => {
				clusterLang(options.lang);
			},
			handler: cluster,
		},
	},
	backgroundRunnable: ['cluster'],
	// Clustering drives the RAG image index (PERF-11 lane declaration).
	backgroundLanes: { cluster: 'rag' },
};
