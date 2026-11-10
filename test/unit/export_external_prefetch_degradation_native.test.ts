/**
 * THE EXPORT AND ITS EXTERNAL SOURCES — batched remote rows (FIX 5) and an
 * export that is never SILENTLY incomplete (FIX 4), 2026-09-24
 * (src/diffusion/export/external_prefetch.ts; engineering/EXTERNAL_SPEC.md §3
 * addendum "the export walk"; WC-2026-09-24-tool-export-server-built-artifacts
 * addendum "external sources").
 *
 *  P. PREFETCH. Every remote record a hydrate batch reaches is asked for ONCE,
 *     with the UNION of the fields its predicted columns read (a compact portal
 *     cell's child + a hop leaf of the same section → one request carrying
 *     both), in PARALLEL but never past DEDALO_EXTERNAL_MAX_CONCURRENCY; the
 *     local target of the mixed portal is never asked for; the values are the
 *     same as the per-cell path's. A row parked for fewer fields than a
 *     component reads is NOT served to it (value.ts coverage guard) — it
 *     fetches its own, so a wrong prediction can never blank a value.
 *  D. DEGRADATION. A dead source (503 → unavailable / circuit_open) or a
 *     disabled service leaves the 'end' line carrying `external_degraded`
 *     (exact counts per (service, state), records affected, a capped sample
 *     naming the exported record + component + verbatim remote id, incomplete
 *     + retryable); a clean export and a not_found answer carry NO key (the
 *     bytes of a clean export are unchanged). The log itself: stale is
 *     recorded but not incomplete, 'ok'-with-drops is 'truncated', not_found is
 *     not recorded, the sample is capped, a cell repeated in one record counts
 *     once.
 *  J. THE JOB. tool_export records the summary in the manifest and serves it
 *     (terminal summary, list_export_jobs, get_export_preview); the spool's
 *     'end' line (= the NDJSON download) carries it. `rerun_of` runs the
 *     RECORDED options of an owned export again.
 *
 * THE SITUATION IS BUILT (`zzxq`, dropped in afterAll with residue asserted 0):
 *   zzxq1 section (host) — 12 records; §i holds zzxq2 = [zzxq5 R(i), zzxq3 7001, zzxq5 R(i+1)]
 *     zzxq2 component_portal: dedalo → zzxq3 [zzxq4]; zenon → zzxq5 [zzxq6 title]
 *   zzxq3 section (local, with an api_config RESIDUE — the rsc205 twin) —
 *         §7001 zzxq4 = 'local publication'
 *   zzxq5 section (external: api_config, no rows)
 *     zzxq6 component_external — fields_map remote 'title'
 *     zzxq7 component_external — fields_map remote 'author'
 * R(k) are 9-char zero-padded ids over 8 distinct values (records overlap).
 *
 * THE SOCKET NEVER OPENS: `api_url` is a public IP literal (no DNS), and
 * `fetch` is replaced for the whole file by a stub that records every asked
 * id + field set, holds each answer DELAY_MS, and counts requests in flight.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import {
	deriveExternalValue,
	setPrefetchedExternalRows,
} from '../../src/core/components/component_external/value.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { EmissionContext } from '../../src/core/resolve/component_data.ts';
import { resolveCellValue } from '../../src/core/resolve/relation_list.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import {
	createExternalDegradationLog,
	EXTERNAL_DEGRADATION_SAMPLE_LIMIT,
	type ExportExternalDegradation,
	type ExternalPrefetchPlan,
	prefetchExternalRowsForBatch,
} from '../../src/diffusion/export/external_prefetch.ts';
import { openExportGrid } from '../../src/diffusion/export/index.ts';
import { createExportAtomRun } from '../../src/diffusion/resolve/resolver.ts';
import { drainInFlightExternalFetches, fetchExternalRows } from '../../src/external/api/index.ts';
import { resetBreakerForOrigin } from '../../src/external/breaker.ts';
import { resetRecordAnswersForTests } from '../../src/external/record_answers.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';
import {
	type ArtifactStore,
	openArtifactStore,
	SPOOL_FILES,
} from '../../tools/tool_export/server/artifact_store.ts';
import {
	listOwnedExportJobs,
	runExportArtifact,
	toolExportBuildArtifact,
} from '../../tools/tool_export/server/export_job.ts';
import { readExportPreview } from '../../tools/tool_export/server/preview.ts';
import { markExportArtifactsRoot } from '../helpers/media_scratch_root.ts';

/** A PUBLIC IP literal: allowlistable, vetted without a DNS lookup. */
const HOST = '141.100.1.2';
const ORIGIN = `https://${HOST}`;

const HOST_SECTION = 'zzxq1';
const PORTAL = 'zzxq2';
const LOCAL_SECTION = 'zzxq3';
const LOCAL_LABEL = 'zzxq4';
const EXTERNAL_SECTION = 'zzxq5';
const EXT_TITLE = 'zzxq6';
const EXT_AUTHOR = 'zzxq7';

const RECORDS = 12;
const DISTINCT_REMOTE = 8;
const LOCAL_ID = 7001;
const LOCAL_VALUE = 'local publication';
const DELAY_MS = 25;
const MAX_CONCURRENCY = 3;

/** The k-th remote id: 9 chars, zero-padded (Zenon's storage form). */
const remote = (k: number): string => String(60_000 + (k % DISTINCT_REMOTE)).padStart(9, '0');
const titleOf = (id: string): string => `title ${id}`;
const authorOf = (id: string): string => `author ${id}`;

const API_CONFIG = {
	entity: 'zenon',
	api_url: `${ORIGIN}/api/v1/record`,
	ui_base_url: `${ORIGIN}/Record/`,
	response_map: [{ local: 'ar_records', remote: 'records' }],
};

const HOST_IDS = Array.from({ length: RECORDS }, (_, index) => index + 1);

const S = situation({
	name: 'export external prefetch + degradation',
	tld: 'zzxq',
	nodes: [
		{ tipo: HOST_SECTION, parent: 'test1', model: 'section', term: { 'lg-spa': 'zz host' } },
		{
			tipo: PORTAL,
			parent: HOST_SECTION,
			model: 'component_portal',
			term: { 'lg-spa': 'zz mixed portal' },
			properties: {
				source: {
					request_config: [
						{
							api_engine: 'dedalo',
							type: 'main',
							sqo: { section_tipo: [{ value: [LOCAL_SECTION], source: 'section' }] },
							show: {
								ddo_map: [{ tipo: LOCAL_LABEL, parent: 'self', section_tipo: LOCAL_SECTION }],
							},
						},
						{
							api_engine: 'zenon',
							type: 'main',
							sqo: { section_tipo: [{ value: [EXTERNAL_SECTION], source: 'section' }] },
							show: {
								ddo_map: [
									{
										tipo: EXT_TITLE,
										parent: 'self',
										fields_map: true,
										section_tipo: EXTERNAL_SECTION,
									},
								],
							},
						},
					],
				},
			},
		},
		{
			tipo: LOCAL_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'zz local' },
			// The rsc205 twin: a LOCAL section carrying a stale api_config residue.
			// Its records are never external targets (ontology ownership decides).
			properties: { api_config: API_CONFIG },
		},
		{
			tipo: LOCAL_LABEL,
			parent: LOCAL_SECTION,
			model: 'component_input_text',
			term: { 'lg-spa': 'zz local title' },
		},
		{
			tipo: EXTERNAL_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'zz remote' },
			properties: { api_config: API_CONFIG },
		},
		{
			tipo: EXT_TITLE,
			parent: EXTERNAL_SECTION,
			model: 'component_external',
			term: { 'lg-spa': 'zz remote title' },
			properties: { fields_map: [{ local: 'dato', remote: 'title' }] },
		},
		{
			tipo: EXT_AUTHOR,
			parent: EXTERNAL_SECTION,
			model: 'component_external',
			term: { 'lg-spa': 'zz remote author' },
			properties: { fields_map: [{ local: 'dato', remote: 'author' }] },
		},
	],
	records: [
		...HOST_IDS.map((id) => ({
			section_tipo: HOST_SECTION,
			section_id: id,
			columns: {
				relation: {
					[PORTAL]: [
						{
							type: 'dd151',
							section_tipo: EXTERNAL_SECTION,
							section_id: remote(id),
							from_component_tipo: PORTAL,
						},
						{
							type: 'dd151',
							section_tipo: LOCAL_SECTION,
							section_id: LOCAL_ID,
							from_component_tipo: PORTAL,
						},
						{
							type: 'dd151',
							section_tipo: EXTERNAL_SECTION,
							section_id: remote(id + 1),
							from_component_tipo: PORTAL,
						},
					],
				},
			},
		})),
		{
			section_tipo: LOCAL_SECTION,
			section_id: LOCAL_ID,
			columns: { string: { [LOCAL_LABEL]: [{ id: 1, lang: 'lg-nolan', value: LOCAL_VALUE }] } },
		},
	],
});

// ---------------------------------------------------------------------------
// The socket stub
// ---------------------------------------------------------------------------

type Mode = 'ok' | '503' | '404';
let mode: Mode = 'ok';
let asked: { id: string; fields: string[] }[] = [];
let inFlight = 0;
let maxInFlight = 0;
/** Called on every request (a case may press Stop from inside the socket). */
let onAsk: (() => void) | null = null;
const realFetch = globalThis.fetch;

async function stubFetch(input: unknown): Promise<Response> {
	const url = new URL(String(input instanceof Request ? input.url : input));
	const id = url.searchParams.get('id') ?? '';
	asked.push({ id, fields: url.searchParams.getAll('field[]').sort() });
	onAsk?.();
	inFlight++;
	maxInFlight = Math.max(maxInFlight, inFlight);
	try {
		await Bun.sleep(DELAY_MS);
	} finally {
		inFlight--;
	}
	if (mode === '503') return new Response('down', { status: 503 });
	if (mode === '404') return new Response('gone', { status: 404 });
	return new Response(
		JSON.stringify({ records: [{ id, title: titleOf(id), author: authorOf(id) }], status: 'OK' }),
		{ status: 200 },
	);
}

let root!: Principal;
const scratchDirs: string[] = [];

beforeAll(async () => {
	globalThis.fetch = stubFetch as unknown as typeof fetch;
	root = await resolvePrincipal(-1);
	await ensureSituation(S);
});

afterAll(async () => {
	overrideExternalSettingsForTests(null);
	await drainInFlightExternalFetches();
	resetBreakerForOrigin('zenon', ORIGIN);
	globalThis.fetch = realFetch;
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	expect(await dropSituation(S)).toBe(0);
});

function settings(extra: Record<string, unknown> = {}): void {
	overrideExternalSettingsForTests({
		enabled: true,
		disabledServices: [],
		allowedHosts: [HOST],
		softTtlMs: 300_000,
		retryAttempts: 0,
		maxConcurrency: MAX_CONCURRENCY,
		...extra,
	});
}

beforeEach(async () => {
	mode = 'ok';
	asked = [];
	inFlight = 0;
	maxInFlight = 0;
	onAsk = null;
	settings();
	resetBreakerForOrigin('zenon', ORIGIN);
	resetRecordAnswersForTests();
	// The row cache is ontology-lifecycled: every case asks the socket again.
	await clearOntologyDerivedCaches();
});

afterEach(async () => {
	await drainInFlightExternalFetches();
	overrideExternalSettingsForTests(null);
});

// ---------------------------------------------------------------------------

const portalStep = {
	section_tipo: HOST_SECTION,
	component_tipo: PORTAL,
	model: 'component_portal',
	name: PORTAL,
};
const authorStep = {
	section_tipo: EXTERNAL_SECTION,
	component_tipo: EXT_AUTHOR,
	model: 'component_external',
	name: EXT_AUTHOR,
};

function exportOptions(
	paths: Record<string, unknown>[][],
	format = 'value',
): Record<string, unknown> {
	return {
		section_tipo: HOST_SECTION,
		data_format: format,
		breakdown: 'rows',
		lang: 'lg-spa',
		ar_ddo_to_export: paths.map((path) => ({ path })),
		sqo: {
			section_tipo: [HOST_SECTION],
			filter_by_locators: HOST_IDS.map((id) => ({ section_tipo: HOST_SECTION, section_id: id })),
		},
	};
}

interface Walked {
	rows: Record<string, unknown>[];
	end: Record<string, unknown>;
	degradation: ExportExternalDegradation | null;
	ms: number;
}

async function walk(options: Record<string, unknown>, hydrateBatch = 4): Promise<Walked> {
	const started = performance.now();
	const grid = await openExportGrid(
		{ principal: root, options, applicationLang: config.menu.applicationLang },
		{ hydrateBatch },
	);
	const rows: Record<string, unknown>[] = [];
	let end: Record<string, unknown> | null = null;
	for await (const line of grid.lines) {
		if (line.t === 'row') rows.push(line);
		if (line.t === 'end') end = line;
	}
	expect(end).not.toBeNull();
	return {
		rows,
		end: end as Record<string, unknown>,
		degradation: grid.externalDegradation(),
		ms: performance.now() - started,
	};
}

const ALL_REMOTE = [...new Set(HOST_IDS.flatMap((id) => [remote(id), remote(id + 1)]))].sort();

// ---------------------------------------------------------------------------

describe('P. the export prefetches each batch in one bounded fan-out', () => {
	test('each remote record asked ONCE, with the union of its columns, in parallel, never past the ceiling', async () => {
		const walked = await walk(
			exportOptions([[portalStep], [portalStep, authorStep]], 'grid_value'),
		);
		const text = JSON.stringify(walked.rows);
		for (const id of ALL_REMOTE) {
			expect(text).toContain(titleOf(id));
			expect(text).toContain(authorOf(id));
		}
		expect(text).toContain(LOCAL_VALUE);
		// ONCE per remote record, both fields in the one request; the local id
		// (7001, and its padded twin) never leaves.
		expect(asked.map((entry) => entry.id).sort()).toEqual(ALL_REMOTE);
		// (…plus the id field: the section's record field set,
		// WC-2026-09-24-external-record-field-set.)
		for (const entry of asked) expect(entry.fields).toEqual(['author', 'id', 'title']);
		// Batched: parallel, and bounded by the transport ceiling.
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENCY);
		expect(walked.degradation).toBeNull();
		console.log(
			`[measure] export walk: ${RECORDS} records, ${asked.length} remote requests, max ${maxInFlight} in flight, ${walked.ms.toFixed(0)} ms (per request ${DELAY_MS} ms)`,
		);
	});

	test('value format: the compact portal cell is served from the batch too', async () => {
		const walked = await walk(exportOptions([[portalStep]], 'value'));
		const text = JSON.stringify(walked.rows);
		for (const id of ALL_REMOTE) expect(text).toContain(titleOf(id));
		expect(asked.map((entry) => entry.id).sort()).toEqual(ALL_REMOTE);
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThanOrEqual(MAX_CONCURRENCY);
	});

	test('the per-cell reader (no prefetch) still fetches its own rows, one at a time — the measured baseline', async () => {
		const started = performance.now();
		const cells: (string | null)[] = [];
		for (const id of HOST_IDS) {
			cells.push(await resolveCellValue(HOST_SECTION, id, PORTAL, 'lg-spa', []));
		}
		const ms = performance.now() - started;
		expect(cells.join('\n')).toContain(titleOf(remote(1)));
		// sequential: never more than one request in flight
		expect(maxInFlight).toBe(1);
		expect(asked.map((entry) => entry.id).sort()).toEqual(ALL_REMOTE);
		console.log(
			`[measure] per-cell fallback: ${RECORDS} records, ${asked.length} remote requests, max ${maxInFlight} in flight, ${ms.toFixed(0)} ms`,
		);
	});

	test('a parked row that does not cover a component fields is NOT served to it (no silent blank)', async () => {
		const id = remote(3);
		// A caller asking for {title} only still gets the SECTION's record field
		// set (record_fields.ts): the view says so itself, and covers both columns.
		const views = await fetchExternalRows(
			[{ sectionTipo: EXTERNAL_SECTION, remoteId: id, remoteFields: ['title'] }],
			{ dataLang: 'lg-spa' },
		);
		const view = views.get(`${EXTERNAL_SECTION}|${id}`);
		expect(view?.remoteFields).toEqual(['id', 'title', 'author']);
		expect(asked).toEqual([{ id, fields: ['author', 'id', 'title'] }]);
		const emission = new EmissionContext();
		// A self-describing view beats a narrower declared coverage.
		setPrefetchedExternalRows(emission, views, new Map([[EXTERNAL_SECTION, new Set(['title'])]]));
		asked = [];
		expect(
			(await deriveExternalValue(EXT_TITLE, EXTERNAL_SECTION, id, { emission })).entries,
		).toEqual([titleOf(id)]);
		expect(
			(await deriveExternalValue(EXT_AUTHOR, EXTERNAL_SECTION, id, { emission })).entries,
		).toEqual([authorOf(id)]);
		expect(asked).toEqual([]); // both served from the parked row
		// A view that does NOT cover a component (hand-built: fetched for {title},
		// its row lacking the author) is never served to it — the author falls
		// back to its own fetch, which is the SHARED cache entry (no request),
		// never a blank from the narrow row.
		if (view === undefined || view.row === null) throw new Error('fixture: no row');
		const { author: _dropped, ...narrowRow } = view.row as Record<string, unknown>;
		const narrow = new Map([
			[`${EXTERNAL_SECTION}|${id}`, { ...view, row: narrowRow, remoteFields: ['id', 'title'] }],
		]);
		setPrefetchedExternalRows(emission, narrow);
		expect(
			(await deriveExternalValue(EXT_AUTHOR, EXTERNAL_SECTION, id, { emission })).entries,
		).toEqual([authorOf(id)]);
		// The declared-coverage fallback for a view that names no fields.
		const { remoteFields: _unnamed, ...anonymous } = { ...view, row: narrowRow };
		setPrefetchedExternalRows(
			emission,
			new Map([[`${EXTERNAL_SECTION}|${id}`, anonymous]]),
			new Map([[EXTERNAL_SECTION, new Set(['title'])]]),
		);
		expect(
			(await deriveExternalValue(EXT_AUTHOR, EXTERNAL_SECTION, id, { emission })).entries,
		).toEqual([authorOf(id)]);
		expect(asked).toEqual([]);
		// No declared coverage and no named fields (the old portal prepass shape):
		// served as parked.
		setPrefetchedExternalRows(emission, new Map([[`${EXTERNAL_SECTION}|${id}`, anonymous]]));
		expect(
			(await deriveExternalValue(EXT_TITLE, EXTERNAL_SECTION, id, { emission })).entries,
		).toEqual([titleOf(id)]);
		expect(asked).toEqual([]);
	});
});

// ---------------------------------------------------------------------------

describe('D. an export is never silently incomplete', () => {
	test('a clean export: no marker, the end line has exactly its protocol keys', async () => {
		const walked = await walk(exportOptions([[portalStep]]));
		expect(Object.keys(walked.end).sort()).toEqual(['columns', 'records', 'rows', 't']);
		expect(walked.degradation).toBeNull();
	});

	test('not_found is an answer, not a gap: no marker', async () => {
		mode = '404';
		const walked = await walk(exportOptions([[portalStep]]));
		expect(walked.end.external_degraded).toBeUndefined();
		expect(walked.degradation).toBeNull();
	});

	test('a dead source: the end line counts every missing cell, bounded, retryable', async () => {
		mode = '503';
		const walked = await walk(exportOptions([[portalStep]]));
		const summary = walked.end.external_degraded as ExportExternalDegradation;
		expect(summary).toBeDefined();
		expect(walked.degradation).toEqual(summary);
		expect(summary.incomplete).toBe(true);
		expect(summary.retryable).toBe(true);
		// two distinct remote targets per record, every record affected
		expect(summary.cells).toBe(RECORDS * 2);
		expect(summary.records).toBe(RECORDS);
		// …and every one of them is MISSING from the file (none stale, none cut)
		expect(summary.missing_cells).toBe(RECORDS * 2);
		expect(summary.missing_records).toBe(RECORDS);
		expect(summary.counts.reduce((sum, entry) => sum + entry.cells, 0)).toBe(summary.cells);
		for (const entry of summary.counts) {
			expect(entry.service).toBe('zenon');
			expect(['unavailable', 'circuit_open']).toContain(entry.state);
		}
		expect(summary.sample.length).toBe(EXTERNAL_DEGRADATION_SAMPLE_LIMIT);
		expect(summary.sample_limit).toBe(EXTERNAL_DEGRADATION_SAMPLE_LIMIT);
		expect(summary.sample[0]).toMatchObject({
			section_tipo: HOST_SECTION,
			section_id: 1,
			component_tipo: EXT_TITLE,
			remote_section_tipo: EXTERNAL_SECTION,
			remote_id: remote(1),
			service: 'zenon',
		});
		// the local target still resolves; the remote ids stay verbatim
		expect(JSON.stringify(walked.rows)).toContain(LOCAL_VALUE);
		for (const entry of summary.sample) expect(entry.remote_id).toMatch(/^0000\d{5}$/);
	});

	test('a disabled service: incomplete, NOT retryable, nothing asked', async () => {
		settings({ disabledServices: ['zenon'] });
		const walked = await walk(exportOptions([[portalStep]]));
		const summary = walked.end.external_degraded as ExportExternalDegradation;
		expect(summary.incomplete).toBe(true);
		expect(summary.retryable).toBe(false);
		expect(summary.counts).toEqual([{ service: 'zenon', state: 'disabled', cells: RECORDS * 2 }]);
		expect(asked).toEqual([]);
	});

	test('the log: stale is recorded but not incomplete; drops are truncated; not_found and repeats are not counted', () => {
		const log = createExternalDegradationLog();
		const status = (state: string, extra: Record<string, unknown> = {}) =>
			({ service: 'zenon', state, label_key: 'x', retryable: true, ...extra }) as never;
		const event = (remoteId: string, state: string, extra: Record<string, unknown> = {}) => ({
			componentTipo: EXT_TITLE,
			sectionTipo: EXTERNAL_SECTION,
			remoteId,
			status: status(state, extra),
			empty: false,
		});
		expect(log.snapshot()).toBeNull();
		log.beginRecord(HOST_SECTION, 1);
		log.note(event('000000001', 'stale'));
		log.note(event('000000001', 'stale')); // the same cell again (label re-walk)
		log.note(event('000000002', 'not_found'));
		const stale = log.snapshot() as ExportExternalDegradation;
		expect(stale).toMatchObject({
			incomplete: false,
			retryable: false,
			cells: 1,
			records: 1,
			missing_cells: 0,
			missing_records: 0,
		});
		log.beginRecord(HOST_SECTION, 2);
		log.note(event('000000001', 'ok', { dropped_over_count: 3 }));
		const truncated = log.snapshot() as ExportExternalDegradation;
		expect(truncated.incomplete).toBe(true);
		expect(truncated.retryable).toBe(false);
		// a cut value is IN the file (partly): incomplete, but nothing is missing
		expect(truncated.missing_cells).toBe(0);
		expect(truncated.missing_records).toBe(0);
		expect(truncated.counts.map((entry) => entry.state)).toEqual(['stale', 'truncated']);
		for (let index = 0; index < 50; index++) {
			log.beginRecord(HOST_SECTION, 100 + index);
			log.note(event(String(index).padStart(9, '0'), 'timeout'));
		}
		const big = log.snapshot() as ExportExternalDegradation;
		expect(big.cells).toBe(52);
		expect(big.records).toBe(52);
		expect(big.missing_cells).toBe(50);
		expect(big.missing_records).toBe(50);
		expect(big.retryable).toBe(true);
		expect(big.sample.length).toBe(EXTERNAL_DEGRADATION_SAMPLE_LIMIT);
		// a detached copy: mutating it does not move the log
		big.sample.length = 0;
		expect((log.snapshot() as ExportExternalDegradation).sample.length).toBe(
			EXTERNAL_DEGRADATION_SAMPLE_LIMIT,
		);
	});
});

// ---------------------------------------------------------------------------

describe('F. the prefetch looks ahead UNDER the export frontier, and stops on Stop', () => {
	/** A non-admin caller; the component key is injected (frontier_scope.ts componentGrant). */
	const caller: Principal = { userId: 987_654, isGlobalAdmin: false, isDeveloper: false };
	/** host → PORTAL (hop) → zzxq5 record, leaf EXT_AUTHOR: the crossing is (zzxq5, id, zzxq7). */
	const plan: ExternalPrefetchPlan = {
		demands: [
			{
				rootSection: HOST_SECTION,
				hops: [PORTAL],
				leafExternal: EXT_AUTHOR,
				relationLeaf: null,
				externalChildren: [],
				implicitChildren: new Set(),
			},
		],
		fieldsOf: new Map([[EXT_AUTHOR, ['author']]]),
	};
	const batch = HOST_IDS.slice(0, 4).map((id) => ({ section_tipo: HOST_SECTION, section_id: id }));
	const batchRemote = [...new Set([1, 2, 3, 4, 5].map((k) => remote(k)))].sort();
	const runWith = (authorLevel: number) => {
		const run = createExportAtomRun();
		run.frontier = {
			principal: caller,
			surface: 'export',
			door: 'tool_export',
			componentGrant: async (_principal, sectionTipo, componentTipo) =>
				sectionTipo === EXTERNAL_SECTION && componentTipo === EXT_AUTHOR ? authorLevel : 1,
		};
		return run;
	};

	test('a crossing the frontier refuses: no remote id behind it reaches the service', async () => {
		const outcome = await prefetchExternalRowsForBatch(
			runWith(0),
			plan,
			batch,
			'lg-spa',
			new EmissionContext(),
		);
		expect(outcome.targets).toBe(0);
		expect(asked).toEqual([]);
	});

	test('control: the same crossing ALLOWED is prefetched', async () => {
		const outcome = await prefetchExternalRowsForBatch(
			runWith(1),
			plan,
			batch,
			'lg-spa',
			new EmissionContext(),
		);
		expect(outcome.targets).toBe(batchRemote.length);
		expect(asked.map((entry) => entry.id).sort()).toEqual(batchRemote);
	});

	/**
	 * T0-1 / D1: a RELATION leaf (the portal itself) whose external child is
	 * IMPLICIT — the walk drops it for a caller without the grant, so the
	 * prefetch must not ask the remote source for it. An EXPLICIT child is
	 * read at the subdatum floor (D3), so the same ungranted child IS fetched.
	 */
	const leafPlan = (implicit: boolean): ExternalPrefetchPlan => ({
		demands: [
			{
				rootSection: HOST_SECTION,
				hops: [],
				leafExternal: null,
				relationLeaf: PORTAL,
				externalChildren: [EXT_AUTHOR],
				implicitChildren: new Set(implicit ? [EXT_AUTHOR] : []),
			},
		],
		fieldsOf: new Map([[EXT_AUTHOR, ['author']]]),
	});

	test('T0-1: an ungranted IMPLICIT child of a relation leaf is never asked of the source', async () => {
		await prefetchExternalRowsForBatch(
			runWith(0),
			leafPlan(true),
			batch,
			'lg-spa',
			new EmissionContext(),
		);
		expect(asked).toEqual([]);
	});

	test('T0-1 control: the same implicit child GRANTED is prefetched', async () => {
		await prefetchExternalRowsForBatch(
			runWith(1),
			leafPlan(true),
			batch,
			'lg-spa',
			new EmissionContext(),
		);
		expect(asked.map((entry) => entry.id).sort()).toEqual(batchRemote);
	});

	test('T0-1 control (D3): the same ungranted child, EXPLICIT, is prefetched at the floor', async () => {
		await prefetchExternalRowsForBatch(
			runWith(0),
			leafPlan(false),
			batch,
			'lg-spa',
			new EmissionContext(),
		);
		expect(asked.map((entry) => entry.id).sort()).toEqual(batchRemote);
	});

	test('a Stop during the prefetch starts no further remote record', async () => {
		const controller = new AbortController();
		onAsk = () => controller.abort();
		await prefetchExternalRowsForBatch(
			runWith(1),
			plan,
			batch,
			'lg-spa',
			new EmissionContext(),
			controller.signal,
		);
		// the records already started finish; nothing after the Stop is asked
		expect(asked.length).toBeLessThanOrEqual(MAX_CONCURRENCY);
		expect(asked.length).toBeLessThan(batchRemote.length);
	});
});

// ---------------------------------------------------------------------------

function scratchStore(): ArtifactStore {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_export_external_'));
	scratchDirs.push(dir);
	return openArtifactStore({
		root: markExportArtifactsRoot(join(dir, 'artifacts')),
		quotaBytes: 0,
		ttlHours: 24,
	});
}

describe('J. tool_export records, serves and re-runs it', () => {
	test('manifest, terminal summary, list, preview and the NDJSON end line carry the summary', async () => {
		mode = '503';
		const store = scratchStore();
		const summary = await runExportArtifact({
			store,
			principal: root,
			userId: -1,
			options: exportOptions([[portalStep]]),
			applicationLang: config.menu.applicationLang,
			hydrateBatch: 4,
		});
		const degraded = summary.external_degraded as ExportExternalDegradation;
		expect(degraded?.incomplete).toBe(true);
		expect(degraded.cells).toBe(RECORDS * 2);
		const job = store.jobRef(-1, summary.job_id);
		expect((await store.readManifest(job)).external_degraded).toEqual(degraded);
		const listed = await listOwnedExportJobs(store, root, -1, HOST_SECTION);
		expect(listed.find((entry) => entry.job_id === summary.job_id)?.external_degraded).toEqual(
			degraded,
		);
		const preview = await readExportPreview({
			store,
			principal: root,
			userId: -1,
			sectionTipo: HOST_SECTION,
			jobId: summary.job_id,
			page: 0,
			pageSize: 5,
			colPage: 0,
		});
		expect(preview.external_degraded).toEqual(degraded);
		const lines = readFileSync(join(job.dir, SPOOL_FILES.grid), 'utf8')
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.at(-1)?.t).toBe('end');
		expect(lines.at(-1)?.external_degraded).toEqual(degraded);
	});

	test('LIVE: a running export already records what degraded at its checkpoints', async () => {
		mode = '503';
		const store = scratchStore();
		const seen: { written: number; degraded: ExportExternalDegradation | null }[] = [];
		await runExportArtifact({
			store,
			principal: root,
			userId: -1,
			options: exportOptions([[portalStep]]),
			applicationLang: config.menu.applicationLang,
			hydrateBatch: 4,
			checkpointRecords: 1,
			checkpointMs: 0,
			onCheckpoint: async ({ job, written }) => {
				const manifest = await store.readManifest(job);
				seen.push({ written, degraded: manifest.external_degraded ?? null });
			},
		});
		const midway = seen.filter((entry) => entry.written > 0 && entry.written < RECORDS);
		expect(midway.length).toBeGreaterThan(0);
		for (const entry of midway) {
			expect(entry.degraded?.incomplete).toBe(true);
			expect(entry.degraded?.records).toBeGreaterThanOrEqual(entry.written);
		}
	});

	test('a clean job serves null everywhere', async () => {
		const store = scratchStore();
		const summary = await runExportArtifact({
			store,
			principal: root,
			userId: -1,
			options: exportOptions([[portalStep]]),
			applicationLang: config.menu.applicationLang,
		});
		expect(summary.external_degraded).toBeNull();
		const listed = await listOwnedExportJobs(store, root, -1, HOST_SECTION);
		expect(listed.find((entry) => entry.job_id === summary.job_id)?.external_degraded).toBeNull();
	});

	test('rerun_of runs the RECORDED options of an owned export; an unknown id is not found', async () => {
		const store = openArtifactStore();
		const created: string[] = [];
		const build = async (options: Record<string, unknown>) => {
			const response = (await toolExportBuildArtifact({
				principal: root,
				userId: -1,
				background: true,
				options: { ...options, background_running: true },
				signal: new AbortController().signal,
			} as ToolActionContext)) as unknown as {
				ok: boolean;
				data: { job_id: string; external_degraded: ExportExternalDegradation | null };
			};
			expect(response.ok).toBe(true);
			created.push(response.data.job_id);
			return response.data;
		};
		try {
			mode = '503';
			const first = await build(exportOptions([[portalStep]]));
			expect(first.external_degraded?.incomplete).toBe(true);
			// the source is back
			mode = 'ok';
			resetBreakerForOrigin('zenon', ORIGIN);
			await clearOntologyDerivedCaches();
			// only the gated section + the id travel; the columns come from the record
			const again = await build({ section_tipo: HOST_SECTION, rerun_of: first.job_id });
			expect(again.external_degraded).toBeNull();
			const [a, b] = await Promise.all(
				[first.job_id, again.job_id].map((id) => store.readManifest(store.jobRef(-1, id))),
			);
			expect(b?.options).toEqual(a?.options as Record<string, unknown>);
			expect(b?.records).toBe(RECORDS);
			let refused: unknown = null;
			try {
				await build({ section_tipo: HOST_SECTION, rerun_of: 'exp_nope_000000000000' });
			} catch (error) {
				refused = error;
			}
			expect((refused as { code?: string } | null)?.code).toBe('export.artifact_not_found');
		} finally {
			for (const id of created) await store.deleteJob(store.jobRef(-1, id));
		}
	});
});
