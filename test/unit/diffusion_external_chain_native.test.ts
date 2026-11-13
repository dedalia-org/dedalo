/**
 * PUBLICATION CHAIN → component_external (T1-42 / O09,
 * WC-2026-11-12-diffusion-external-chain).
 *
 * THE DEFECT. A publication field whose ddo_map reaches a component_external
 * (rsc368 → zenon4/5/6/9: the bibliography columns) published EMPTY:
 *   (a) compile routed the model as a `relation-hop` (its descriptor sits on
 *       the relation column for column-map parity only), so the resolver read
 *       a stored locator bag no record holds;
 *   (b) a locator to an EXTERNAL record (no matrix row by construction) hit
 *       `target === null ? []` and its children never ran.
 * PHP routes the model as a TERMINAL (it is not in
 * component_relation_common::get_components_with_relations) and instantiates
 * the component without checking that the record exists, so the remote
 * values are published (v6 and frozen v7 alike).
 *
 * THE SITUATION IS BUILT. `zzdxt` (scratch TLD, torn down with zero residue):
 * primary section zzdxt1 with a portal zzdxt2, a local section zzdxt20, and a
 * sql diffusion domain publishing zzdxt1 with two fields modelled on rsc1194 /
 * rsc1195. The external side is the suite fixture `test3` (Zenon api_config)
 * with `test215` (component_external, authors) and `test52` (input_text). One
 * scratch test3 ROW is inserted (an address) and swept. Remote rows are PRIMED
 * through the facade with an injected socket in the run's data lang; then the
 * allowlist is replaced by a METER that refuses every host and records each
 * consultation, so any fetch the run itself attempts is BLOCKED and COUNTED —
 * no network, and an unprimed id degrades instead of being fetched. The
 * allowlist is the transport's one per-attempt check (external/transport.ts
 * step 3, before DNS and socket), so the meter sees every attempt the run
 * makes, whichever door issued it.
 *
 * THE RUN IS TRIGGERED FROM ANOTHER LANG. Each run executes inside a request
 * scope whose data lang is NOT the run's: the fetch lang is the run's, never
 * the trigger's (WC-2026-11-12 DIVERGENCE). A run that fetched in the ambient
 * lang would miss every primed row (the row cache keys on the lang) and the
 * meter would count it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { EmissionContext } from '../../src/core/resolve/component_data.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { MetaValueIR } from '../../src/diffusion/parsers/types.ts';
import { compileElementPlan } from '../../src/diffusion/plan/compile.ts';
import type { PublicationPlan } from '../../src/diffusion/plan/types.ts';
import {
	buildVirtualDiffusionTree,
	type VirtualDiffusionTree,
} from '../../src/diffusion/plan/virtual_tree.ts';
import {
	type ExternalPublicationDegradation,
	externalPublicationAtoms,
} from '../../src/diffusion/resolve/external_value.ts';
import {
	type FieldResolutionError,
	resolvePublication,
} from '../../src/diffusion/resolve/resolver.ts';
import { drainInFlightExternalFetches, fetchExternalRows } from '../../src/external/api/index.ts';
import { resetBreakerForOrigin } from '../../src/external/breaker.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const HOST = 'zenon.dainst.org';
const ORIGIN = `https://${HOST}`;
const EXTERNAL_SECTION = 'test3';
const EXTERNAL_TABLE = 'matrix_test';
const EXTERNAL = 'test215'; // component_external, fields_map authors → zenon_authors
const STORED = 'test52'; // component_input_text of test3

/** A remote-only Zenon record (no matrix row), primed. */
const REMOTE_ID = '000948950';
/** A remote-only Zenon record, NEVER primed — the run cannot fetch it. */
const UNPRIMED_ID = '000948999';
/** The scratch test3 ROW (an address): its section_id IS its remote id. */
const LOCAL_ROW_ID = 948_951;
const LOCAL_TITLE = 'zzdxt local stored title';
const AUTHOR_REMOTE = 'Author, Remote';
const AUTHOR_LOCAL = 'Author, Local';

const DOMAIN_NAME = 'zzdxt external chain domain';
const ELEMENT = 'zzdxt42';
const PRIMARY = 'zzdxt1';
const PORTAL = 'zzdxt2';
const LOCAL_SECTION = 'zzdxt20';
const LOCAL_SECTION_ID = 948_971;
/** Plain field: portal → test215. */
const AUTHORS_FIELD = 'zzdxt45';
/** Merge field: portal → test52 + test215 (rsc1195 shape). */
const MERGE_FIELD = 'zzdxt46';
/**
 * A field whose FIRST ddo is the component_external, no explicit output_format:
 * the output-format fallback (component_common `string`, not the relation
 * family's `json`). test215 is foreign to zzdxt1, so it publishes nothing here.
 */
const DIRECT_FIELD = 'zzdxt47';

const ID_REMOTE = 948_961; // → test3 '000948950'
const ID_LOCAL_ROW = 948_962; // → test3 948951 (address)
const ID_FOREIGN = 948_963; // → zzdxt20 948971 (component_external foreign there)
const ID_MERGE = 948_964; // → [test3 948951, test3 '000948950']
const ID_DEGRADED = 948_965; // → [test3 '000948950', test3 '000948999' unprimed]

const portalTo = (...targets: [string, number | string][]) =>
	targets.map(([section_tipo, section_id]) => ({ section_tipo, section_id }));

const SITUATION = situation({
	name: 'zzdxt diffusion external chain',
	tld: 'zzdxt',
	nodes: [
		{ tipo: PRIMARY, parent: 'test1', model: 'section', term: { 'lg-spa': 'zzdxt primary' } },
		{
			tipo: PORTAL,
			parent: PRIMARY,
			model: 'component_portal',
			term: { 'lg-spa': 'zzdxt bibliography' },
			order_number: 1,
		},
		{
			tipo: LOCAL_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'zzdxt local' },
		},
		{
			tipo: 'zzdxt21',
			parent: LOCAL_SECTION,
			model: 'component_input_text',
			term: { 'lg-spa': 'zzdxt local title' },
			order_number: 1,
		},
		{
			tipo: 'zzdxt40',
			parent: 'dd1190',
			model: 'diffusion_domain',
			term: { 'lg-spa': DOMAIN_NAME },
		},
		{
			tipo: 'zzdxt41',
			parent: 'zzdxt40',
			model: 'diffusion_group',
			term: { 'lg-spa': 'zzdxt group' },
		},
		{
			tipo: ELEMENT,
			parent: 'zzdxt41',
			model: 'diffusion_element',
			term: { 'lg-spa': 'zzdxt sql element' },
			properties: { diffusion: { type: 'sql' } },
		},
		{ tipo: 'zzdxt43', parent: ELEMENT, model: 'database', term: { 'lg-spa': 'zzdxt_db' } },
		{
			tipo: 'zzdxt44',
			parent: 'zzdxt43',
			model: 'table',
			term: { 'lg-spa': 'zzdxt_primary' },
			relations: [{ tipo: PRIMARY }],
		},
		{
			tipo: AUTHORS_FIELD,
			parent: 'zzdxt44',
			model: 'field_text',
			term: { 'lg-spa': 'authors' },
			relations: [{ tipo: PORTAL }],
			properties: {
				process: {
					ddo_map: [
						{ tipo: PORTAL, section_tipo: 'self', parent: 'self' },
						{ tipo: EXTERNAL, parent: PORTAL },
					],
				},
			},
			order_number: 1,
		},
		{
			tipo: MERGE_FIELD,
			parent: 'zzdxt44',
			model: 'field_text',
			term: { 'lg-spa': 'bibliography' },
			relations: [{ tipo: PORTAL }],
			properties: {
				process: {
					parser: [{ fn: 'parser_helper::merge', options: { records_separator: ' # ' } }],
					ddo_map: [
						{ tipo: PORTAL, section_tipo: 'self', parent: 'self' },
						{ tipo: STORED, parent: PORTAL },
						{ tipo: EXTERNAL, parent: PORTAL },
					],
					output_format: 'string',
				},
			},
			order_number: 2,
		},
		{
			tipo: DIRECT_FIELD,
			parent: 'zzdxt44',
			model: 'field_text',
			term: { 'lg-spa': 'direct_authors' },
			relations: [{ tipo: EXTERNAL }],
			properties: {
				process: { ddo_map: [{ tipo: EXTERNAL, section_tipo: 'self', parent: 'self' }] },
			},
			order_number: 3,
		},
	],
	records: [
		{
			section_tipo: LOCAL_SECTION,
			section_id: LOCAL_SECTION_ID,
			columns: { string: { zzdxt21: [{ value: 'zzdxt local record' }] } },
		},
		{
			section_tipo: PRIMARY,
			section_id: ID_REMOTE,
			columns: { relation: { [PORTAL]: portalTo([EXTERNAL_SECTION, REMOTE_ID]) } },
		},
		{
			section_tipo: PRIMARY,
			section_id: ID_LOCAL_ROW,
			columns: { relation: { [PORTAL]: portalTo([EXTERNAL_SECTION, LOCAL_ROW_ID]) } },
		},
		{
			section_tipo: PRIMARY,
			section_id: ID_FOREIGN,
			columns: { relation: { [PORTAL]: portalTo([LOCAL_SECTION, LOCAL_SECTION_ID]) } },
		},
		{
			section_tipo: PRIMARY,
			section_id: ID_MERGE,
			columns: {
				relation: {
					[PORTAL]: portalTo([EXTERNAL_SECTION, LOCAL_ROW_ID], [EXTERNAL_SECTION, REMOTE_ID]),
				},
			},
		},
		{
			section_tipo: PRIMARY,
			section_id: ID_DEGRADED,
			columns: {
				relation: {
					[PORTAL]: portalTo([EXTERNAL_SECTION, REMOTE_ID], [EXTERNAL_SECTION, UNPRIMED_ID]),
				},
			},
		},
	],
});

const SETTINGS = {
	enabled: true,
	disabledServices: [] as string[],
	softTtlMs: 3_600_000,
	retryAttempts: 0,
	maxConcurrency: 4,
};

let tree: VirtualDiffusionTree;
let plan: PublicationPlan;
let runLang: string;
/** A data lang that is NOT the run's: the triggering request's scope. */
let triggerLang: string;

/**
 * The allowlist METER: refuses every host (an empty allowlist's verdict) and
 * records each consultation — one per transport attempt, whichever door (hop
 * prefetch, per-cell fallback, relation_core) issued it.
 */
let allowlistConsultations: string[] = [];
function meteredEmptyAllowlist(): string[] {
	return Object.assign([] as string[], {
		includes(host: string): boolean {
			allowlistConsultations.push(host);
			return false;
		},
	});
}

/** Prime one remote row in the run's data lang through the facade (injected socket). */
async function prime(remoteId: string, author: string): Promise<void> {
	const views = await fetchExternalRows(
		[{ sectionTipo: EXTERNAL_SECTION, remoteId, remoteFields: [] }],
		{
			dataLang: runLang,
			deps: {
				fetchImpl: async () => {
					return new Response(
						JSON.stringify({
							records: [{ id: remoteId, authors: { primary: { [author]: {} } } }],
							status: 'OK',
						}),
						{ status: 200 },
					);
				},
				assertPublicUrlImpl: async (uri: string) => ({
					url: new URL(uri),
					addresses: ['141.100.1.1'],
				}),
			},
		},
	);
	expect([...views.values()][0]?.status).toBe('ok');
}

async function sweepLocalRow(): Promise<void> {
	await deleteMatrixRecord(EXTERNAL_TABLE, EXTERNAL_SECTION, LOCAL_ROW_ID);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		EXTERNAL_SECTION,
		LOCAL_ROW_ID,
	]);
}

interface RunOutcome {
	/** section_id → column → value (the first projected row: values are lang-neutral). */
	columns: Map<number, Record<string, string | null>>;
	errors: FieldResolutionError[];
}

/** One run, triggered from a request scope whose data lang is NOT the run's. */
async function run(): Promise<RunOutcome> {
	const columns = new Map<number, Record<string, string | null>>();
	const errors: FieldResolutionError[] = [];
	await runWithRequestLangs({ applicationLang: triggerLang, dataLang: triggerLang }, async () => {
		for await (const batch of resolvePublication(plan, {
			sectionTipo: PRIMARY,
			runStartedAt: 1_751_700_000,
			tree,
			maxLevels: 0,
		})) {
			errors.push(...batch.errors);
			for (const row of batch.rows) {
				if (!columns.has(Number(row.sectionId))) columns.set(Number(row.sectionId), row.columns);
			}
		}
	});
	return { columns, errors };
}

function columnOf(outcome: RunOutcome, sectionId: number, column: string): string | null {
	const row = outcome.columns.get(sectionId);
	if (row === undefined) throw new Error(`record ${sectionId} produced no row`);
	return row[column] ?? null;
}

describe.if(DB_READY)('diffusion chain → component_external (T1-42)', () => {
	let outcome: RunOutcome;
	/** Meter reading of the first run (one unprimed id among primed ones). */
	let firstRunAttempts: string[] = [];
	/** Meter reading of the second run (every id primed). */
	let primedRunAttempts: string[] = [];
	/** The terminal's PER-CELL fallback (nothing prefetched), from triggerLang. */
	let fallbackAtoms: MetaValueIR[] = [];
	const fallbackDegradations: ExternalPublicationDegradation[] = [];
	let fallbackAttempts: string[] = [];

	beforeAll(async () => {
		await assertTestDatabase('diffusion_external_chain_native');
		await dropSituation(SITUATION);
		await ensureSituation(SITUATION);
		await sweepLocalRow();
		await sql.unsafe(
			`INSERT INTO "${EXTERNAL_TABLE}" ("section_tipo", "section_id", "string") VALUES ($1, $2, $3::text::jsonb)`,
			[
				EXTERNAL_SECTION,
				LOCAL_ROW_ID,
				encodeForJsonb({ [STORED]: [{ id: 1, value: LOCAL_TITLE, lang: 'lg-nolan' }] }),
			],
		);
		await clearOntologyDerivedCaches();
		const built = await buildVirtualDiffusionTree(DOMAIN_NAME);
		if (built === null) throw new Error(`no dd1190 domain node is named '${DOMAIN_NAME}'`);
		tree = built;
		plan = await compileElementPlan(ELEMENT, { tree });
		runLang = plan.langPolicy.mainLang ?? config.lang.dataLangDefault;
		triggerLang = runLang === 'lg-eng' ? 'lg-spa' : 'lg-eng';

		overrideExternalSettingsForTests({ ...SETTINGS, allowedHosts: [HOST] });
		resetBreakerForOrigin('zenon', ORIGIN);
		await prime(REMOTE_ID, AUTHOR_REMOTE);
		await prime(String(LOCAL_ROW_ID), AUTHOR_LOCAL);
		// From here on nothing may reach the network: an unprimed id is BLOCKED,
		// and every attempt is counted by the meter.
		allowlistConsultations = [];
		overrideExternalSettingsForTests({ ...SETTINGS, allowedHosts: meteredEmptyAllowlist() });
		outcome = await run();
		firstRunAttempts = allowlistConsultations;

		// Second run, every id primed: the run must ask the transport NOTHING.
		overrideExternalSettingsForTests({ ...SETTINGS, allowedHosts: [HOST] });
		resetBreakerForOrigin('zenon', ORIGIN);
		await prime(UNPRIMED_ID, AUTHOR_REMOTE);
		allowlistConsultations = [];
		overrideExternalSettingsForTests({ ...SETTINGS, allowedHosts: meteredEmptyAllowlist() });
		await run();
		primedRunAttempts = allowlistConsultations;

		// The per-cell fallback door (no hop prefetch parked — the path a failed
		// prefetch takes): the terminal's own fetch must use the RUN lang too.
		allowlistConsultations = [];
		fallbackAtoms = await runWithRequestLangs(
			{ applicationLang: triggerLang, dataLang: triggerLang },
			() =>
				externalPublicationAtoms(
					{
						lang: runLang,
						emission: new EmissionContext(),
						report: (degradation) => fallbackDegradations.push(degradation),
					},
					// The placeholder host row carries the padded remote id verbatim
					// (a string at runtime; MatrixRecord types it numeric).
					{ section_tipo: EXTERNAL_SECTION, section_id: REMOTE_ID as unknown as number },
					EXTERNAL,
					{ tipo: EXTERNAL },
				),
		);
		fallbackAttempts = allowlistConsultations;
	}, 180_000);

	afterAll(async () => {
		overrideExternalSettingsForTests(null);
		await drainInFlightExternalFetches();
		resetBreakerForOrigin('zenon', ORIGIN);
		await assertTestDatabase('diffusion_external_chain_native');
		await sweepLocalRow();
		expect(await dropSituation(SITUATION)).toBe(0);
		await clearOntologyDerivedCaches();
	}, 120_000);

	test('compile: a FIRST-ddo component_external falls back to the string format, not json', () => {
		const fields = plan.sections.flatMap((section) => section.fields);
		const direct = fields.find((candidate) => candidate.id === DIRECT_FIELD);
		expect(direct).toBeDefined();
		// PHP component_external extends component_common: `string` (the
		// resolver's default — never materialized), not the relation family's json.
		expect(direct?.outputFormat).toBeUndefined();
		// Control: a first-ddo PORTAL still falls back to json.
		expect(fields.find((candidate) => candidate.id === AUTHORS_FIELD)?.outputFormat).toBe('json');
	});

	test('compile: a component_external ddo is a TERMINAL component step (PHP terminal branch)', () => {
		const field = plan.sections
			.flatMap((section) => section.fields)
			.find((candidate) => candidate.id === AUTHORS_FIELD);
		const step = field?.sourceChain.find(
			(candidate) => candidate.kind !== 'system' && candidate.tipo === EXTERNAL,
		);
		expect(step?.kind).toBe('component');
	});

	test('a locator to a REMOTE-only record (no matrix row) publishes the remote value', () => {
		expect(columnOf(outcome, ID_REMOTE, 'authors')).toContain(AUTHOR_REMOTE);
	});

	test('a locator to a local ROW of the external section publishes stored AND remote values', () => {
		const merged = columnOf(outcome, ID_LOCAL_ROW, 'bibliography') ?? '';
		expect(merged).toContain(LOCAL_TITLE);
		expect(merged).toContain(AUTHOR_LOCAL);
		expect(columnOf(outcome, ID_LOCAL_ROW, 'authors')).toContain(AUTHOR_LOCAL);
	});

	test('a FOREIGN target contributes nothing and asks the service nothing', () => {
		expect(columnOf(outcome, ID_FOREIGN, 'authors') ?? '').not.toContain('Author');
		expect(outcome.errors.filter((error) => Number(error.sectionId) === ID_FOREIGN)).toEqual([]);
	});

	test('merge field: every locator contributes its values, in locator order', () => {
		const merged = columnOf(outcome, ID_MERGE, 'bibliography') ?? '';
		const local = merged.indexOf(LOCAL_TITLE);
		const localAuthor = merged.indexOf(AUTHOR_LOCAL);
		const remoteAuthor = merged.indexOf(AUTHOR_REMOTE);
		expect(local).toBeGreaterThanOrEqual(0);
		expect(localAuthor).toBeGreaterThan(local);
		expect(remoteAuthor).toBeGreaterThan(localAuthor);
		// Exact bytes: the default merge (flat, records_separator) over the three
		// leaf values, the Zenon adapter's `primary:` role prefix included.
		expect(merged).toBe(`${LOCAL_TITLE} # primary: ${AUTHOR_LOCAL} # primary: ${AUTHOR_REMOTE}`);
	});

	test('a degraded remote keeps the other values and is reported LOUDLY in the run errors', () => {
		expect(columnOf(outcome, ID_DEGRADED, 'authors')).toContain(AUTHOR_REMOTE);
		const lines = outcome.errors.filter((error) => Number(error.sectionId) === ID_DEGRADED);
		expect(lines.length).toBeGreaterThan(0);
		expect(
			lines.every((line) =>
				/^external_source:[a-z_]+ test215 test3\/000948999$/.test(line.message),
			),
		).toBe(true);
		// The healthy records report nothing.
		expect(outcome.errors.filter((error) => Number(error.sectionId) !== ID_DEGRADED)).toEqual([]);
	});

	test('the meter is live: the unprimed id is attempted (and refused) in the first run', () => {
		expect(firstRunAttempts.length).toBeGreaterThan(0);
		expect(firstRunAttempts.every((host) => host === HOST)).toBe(true);
	});

	test('every row primed: the run asks the transport NOTHING (foreign targets included)', () => {
		expect(primedRunAttempts).toEqual([]);
	});

	test("the fetch lang is the run's, not the triggering request's (WC-2026-11-12 DIVERGENCE)", () => {
		expect(triggerLang).not.toBe(runLang);
		// Rows primed in the run lang served a run triggered from triggerLang,
		// with no transport attempt.
		expect(columnOf(outcome, ID_REMOTE, 'authors')).toContain(AUTHOR_REMOTE);
		expect(primedRunAttempts).toEqual([]);
	});

	test("the per-cell fallback fetches in the run's lang too (no prefetch parked)", () => {
		expect(fallbackAttempts).toEqual([]);
		expect(fallbackDegradations).toEqual([]);
		expect(fallbackAtoms.map((atom) => (atom.kind === 'scalar' ? atom.value : atom.kind))).toEqual([
			`primary: ${AUTHOR_REMOTE}`,
		]);
	});
});
