/**
 * tool_import_rdf EXECUTOR — TS-native write-path gate
 * (tools/tool_import_rdf/server/rdf_import_execute.ts).
 *
 * The executor applies the mapping plan's operation list (rdf_import_plan.ts:
 * find_or_create / intermediate / set / link / skip) to a caller record. What
 * this gate pins, on the SUITE database:
 *
 *  - it FILLS empty fields: a translatable literal per language, an IRI, a date,
 *    and a locator to a linked term it found-or-created;
 *  - it NEVER OVERWRITES: a pre-filled language slice is skipped (and reported),
 *    its sibling empty slice is still filled; a single-choice model is set only
 *    when empty;
 *  - IRIs and locators are APPENDED without duplicates (an IRI already stored is
 *    skipped, a locator already linked is skipped by the insert law);
 *  - FIND BEFORE CREATE: a linked term that already exists (matched by its IRI,
 *    including an IRI with a query string — the iri family's exact leaf) is
 *    linked, not duplicated; an identifier two records share is refused; an
 *    INTERMEDIATE record is found again through its ddo_map path; a SECOND RUN
 *    changes nothing and creates nothing (no new data TM row, no new record);
 *  - the WRITE DOOR: an importer whose grant on the section is read-only writes
 *    nothing and creates nothing — every write is reported refused; one that may
 *    create but not write the match component creates nothing either; the served
 *    twin (a writer on the same record) writes;
 *  - the run is ONE dd800 bulk process, and every TM row the run wrote carries it
 *    (revertable as one operation); a run with nothing to apply mints none;
 *  - ONE TRANSACTION PER IRI: an IRI whose save the engine refuses — a thrown
 *    refusal or an `ok:false` answer — rolls back ENTIRELY (the record it created
 *    is gone) while the next IRI commits;
 *  - only WEB IRIs (http/https) are written or matched: a `javascript:` IRI from
 *    a remote document is never stored, and no record is born for one;
 *  - a NUMBER is stored as the number the plan cast (a Nomisma weight); the
 *    string the plan never sends any more is refused by the save door's
 *    value-shape law, as a per-op skip — the contrast the cast exists for;
 *  - an HTML match component (text_area) is FOUND AGAIN on a rerun; a geo tag
 *    text (which the append merge refuses) is written into an empty slice;
 *  - an intermediate is created only through ITS section's create door, and a
 *    FOUND one is an existing record (the record scope applies to writes into it);
 *  - ZERO RESIDUE: every record, TM row, activity row and dd800 the file caused
 *    is swept and the sweep is asserted.
 *
 * Situation: test3 records created at runtime (the generic `test` TLD bench —
 * test52 input_text translatable, test162 input_text, test140 component_iri,
 * test145 component_date, test80 portal → test3, test91 select → dd64), plus
 * the shared authz_door_fixture identities for the refused/served pairs.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql, withSavepoint, withTransaction } from '../../src/core/db/postgres.ts';
import { DedaloError, isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { getPermissions, type Principal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	isBulkRunLive,
	withLazyLiveBulkRun,
	withLiveBulkRun,
} from '../../src/core/tools/bulk_run_registry.ts';
import { findSectionIdByCode, textAsParagraph } from '../../src/core/tools/import_code_lookup.ts';
import {
	executeRdfImport,
	findTermRecord,
	type RdfImportReport,
} from '../../tools/tool_import_rdf/server/rdf_import_execute.ts';
import type {
	RdfDdoStep,
	RdfFindOrCreateOp,
	RdfImportOp,
	RdfImportPlan,
	RdfIntermediateOp,
	RdfLinkOp,
	RdfPlanItem,
	RdfSetOp,
	RecordRef,
} from '../../tools/tool_import_rdf/server/rdf_import_plan.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import {
	AUTHZ_CONTROL_USER_ID,
	AUTHZ_PROJECT_P,
	AUTHZ_PROJECT_Q,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	authzProfileId,
	clearAuthzDoorCaches,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const TITLE = 'test52'; // component_input_text, translatable
const CODE = 'test162'; // component_input_text, NOT translatable
const IRI = 'test140'; // component_iri, not translatable
const DATE = 'test145'; // component_date
const PORTAL = 'test80'; // component_portal → test3
const SELECT = 'test91'; // component_select → dd64 (single choice: refuses append)
const TEXT_AREA = 'test17'; // component_text_area (html), translatable
const FILTER = 'test101'; // component_filter → dd153 (the control writes it)
const NUMBER = 'test211'; // component_number (the `number` column)
const ROOT: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** Scratch TLD of the capped portal node (orphan parent: no section walk reaches it). */
const CAP_TLD = 'zzrdfcap';
const CAPPED = `${CAP_TLD}1`; // component_portal, data_limit 1, targets test3
/** A TREE-PICKER portal (properties.view 'tree') on test3 targeting zzrdfhost1 — the insert door asks the read grant there. */
const TREE_PICKER = `${CAP_TLD}2`;
const TREE_PICKER_2 = `${CAP_TLD}3`;
/**
 * A SECOND term section (the target check's HOST must vary): zzrdfhost1 in
 * matrix_test, its IRI identifier, and a portal whose request_config targets
 * {source:'self'} — its OWN host section, whatever record holds it.
 */
const HOST_SECTION = 'zzrdfhost1';
const HOST_IRI = 'zzrdfhost2';
const SELF_PORTAL = 'zzrdfhost3';
const HOST_SITUATION = situation({
	tld: 'zzrdfhost',
	name: 'rdf_import_execute_host',
	nodes: [
		{
			tipo: HOST_SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Términos RDF', 'lg-eng': 'RDF terms' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: HOST_IRI,
			parent: HOST_SECTION,
			model: 'component_iri',
			term: { 'lg-spa': 'IRI', 'lg-eng': 'IRI' },
		},
		{
			tipo: SELF_PORTAL,
			parent: HOST_SECTION,
			model: 'component_portal',
			term: { 'lg-spa': 'Relacionados', 'lg-eng': 'Related' },
			properties: {
				source: { request_config: [{ sqo: { section_tipo: [{ source: 'self' }] } }] },
			},
		},
	],
});

/** The refusal of a born record that cannot hold the identifier that finds it again. */
const UNIDENTIFIABLE = 'tool.rdf_identifier_unwritable';

/** Unique per process, so a crashed earlier run's leftovers can never be matched. */
const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const iriOf = (name: string): string => `http://zz.test/rdf/${RUN}/${name}`;

/** test3 records this file created (callers, pre-existing terms) + those the executor created. */
const records = new Set<number>();
const bulkIds = new Set<number>();
/** test3 records created through the authz fixture (it sweeps them; their activity rows are ours). */
const doorRecords = new Set<number>();

let ids: AuthzIdentities;

// ---------------------------------------------------------------- op builders

const CALLER: RecordRef = { kind: 'caller' };
const ref = (key: string): RecordRef => ({ kind: 'found_or_created', key });
const BASE = { ontology_tipo: 'zzrdfexec1', rdf_predicate: 'zz:predicate' } as const;

function set(
	target: RecordRef,
	componentTipo: string,
	lang: string,
	value: RdfPlanItem[],
): RdfSetOp {
	return {
		...BASE,
		op: 'set',
		target,
		section_tipo: SECTION,
		component_tipo: componentTipo,
		model: null,
		lang,
		value,
	};
}

function term(key: string, identifier: string): RdfFindOrCreateOp {
	return {
		...BASE,
		op: 'find_or_create',
		key,
		class_tipo: 'zzrdfexec2',
		section_tipo: SECTION,
		match_component_tipo: IRI,
		match_model: 'component_iri',
		match_lang: 'lg-nolan',
		match_value: identifier,
		match_item: { iri: identifier },
		needs_fetch_iri: null,
	};
}

function link(target: RecordRef, componentTipo: string, to: RecordRef): RdfLinkOp {
	return {
		...BASE,
		op: 'link',
		target,
		section_tipo: SECTION,
		component_tipo: componentTipo,
		model: null,
		to,
		to_section_tipo: SECTION,
	};
}

function plan(subject: string, ops: RdfImportOp[]): RdfImportPlan {
	return { subject, class_tipo: 'zzrdfexec2', section_tipo: SECTION, ops };
}

/** caller.test80 → intermediate (test3) .test80 → person (test3) .test140 = the resource IRI. */
const CREATOR_PATH: RdfDdoStep[] = [
	{ section_tipo: SECTION, component_tipo: PORTAL, parent: SECTION },
	{ section_tipo: SECTION, component_tipo: PORTAL, parent: PORTAL },
	{ section_tipo: SECTION, component_tipo: IRI, parent: PORTAL },
];

function creator(key: string, person: string): RdfIntermediateOp {
	return {
		...BASE,
		op: 'intermediate',
		key,
		target: CALLER,
		section_tipo: SECTION,
		component_tipo: PORTAL,
		model: null,
		intermediate_section_tipo: SECTION,
		match_value: person,
		path: CREATOR_PATH,
	};
}

const locatorOf = (sectionId: number, from: string = PORTAL) => ({
	type: 'dd151',
	section_tipo: SECTION,
	section_id: sectionId,
	from_component_tipo: from,
});

// ---------------------------------------------------------------- helpers

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, -1);
	records.add(id);
	return id;
}

async function doorRecord(projectId: number): Promise<number> {
	const id = await createDoorRecord(SECTION, projectId);
	doorRecords.add(id);
	return id;
}

async function seed(
	sectionId: number,
	tipo: string,
	lang: string,
	value: unknown[],
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo: tipo,
		sectionTipo: SECTION,
		sectionId,
		lang,
		changedData: [{ action: 'set_data', id: null, value }],
		userId: -1,
	});
	expect(saved.ok).toBe(true);
}

async function items(
	sectionId: number,
	column: string,
	tipo: string,
): Promise<Record<string, unknown>[]> {
	const record = await readMatrixRecord(TABLE, SECTION, sectionId);
	const bag = (record?.columns as Record<string, Record<string, unknown> | null> | undefined)?.[
		column
	];
	return ((bag?.[tipo] as Record<string, unknown>[] | undefined) ?? []).filter(
		(item) => item !== null,
	);
}

async function run(
	callerId: number,
	plans: RdfImportPlan[],
	principal: Principal = ROOT,
): Promise<RdfImportReport> {
	const report = await executeRdfImport({
		caller: { section_tipo: SECTION, section_id: callerId },
		plans,
		principal,
		bulkLabel: 'rdf_import_execute_native',
	});
	if (report.bulk_process_id !== null) bulkIds.add(report.bulk_process_id);
	// Only test3 ids: the sweep deletes them from test3 (a record another section
	// got — only ever by a defect — must not name a test3 record of that id).
	for (const created of report.created) {
		if (created.section_tipo === SECTION) records.add(created.section_id);
	}
	return report;
}

async function tmCount(sectionIds: readonly number[]): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[SECTION, sectionIds.join(',')],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function sectionRowCount(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1`,
		[SECTION],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** dd800 rows + their TM rows: a run that mints no bulk record leaves both unchanged. */
async function bulkFootprint(): Promise<number> {
	const bulkTable = (await getMatrixTableFromTipo('dd800')) ?? 'matrix_notes';
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*)::int FROM ${bulkTable} WHERE section_tipo = 'dd800')
		      + (SELECT count(*)::int FROM matrix_time_machine WHERE section_tipo = 'dd800') AS n`,
		[],
	)) as { n: number }[];
	return rows[0]?.n ?? -1;
}

const reasons = (report: RdfImportReport) => report.skipped.map((entry) => entry.reason);

/** The OCRE-like coin plan: title per lang, IRI, date, and a linked mint found-or-created by IRI. */
function coinPlan(name: string, mintName: string): RdfImportPlan {
	const mint = ref('mint');
	return plan(iriOf(name), [
		set(CALLER, TITLE, 'lg-eng', [{ value: 'Quinarius' }]),
		set(CALLER, TITLE, 'lg-spa', [{ value: 'Quinario' }]),
		set(CALLER, IRI, 'lg-nolan', [{ iri: iriOf(name) }]),
		set(CALLER, DATE, 'lg-nolan', [{ start: { year: -25 }, end: { year: -23 } }]),
		term('mint', iriOf(mintName)),
		set(mint, TITLE, 'lg-eng', [{ value: 'Emerita' }]),
		link(CALLER, PORTAL, mint),
	]);
}

describe.if(DB_READY)(
	'tool_import_rdf executor — fill, never overwrite, find before create',
	() => {
		beforeAll(async () => {
			await assertTestDatabase('rdf_import_execute_native');
			await installAuthzDoorFixture();
			ids = await resolveAuthzIdentities();
			await dropSituation(HOST_SITUATION);
			await ensureSituation(HOST_SITUATION);
			await deleteTldNodes(CAP_TLD);
			await upsertDdOntologyNode({
				tipo: CAPPED,
				parent: `${CAP_TLD}999999`, // orphan: a valid tipo no node carries
				model: 'component_portal',
				tld: CAP_TLD,
				term: { 'lg-spa': 'scratch rdf capped portal' },
				is_model: false,
				is_translatable: false,
				is_main: false,
				properties: {
					data_limit: 1,
					source: {
						request_config: [{ sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] } }],
					},
				},
			});
		});

		beforeAll(async () => {
			for (const tipo of [TREE_PICKER, TREE_PICKER_2]) {
				await upsertDdOntologyNode({
					tipo,
					parent: `${CAP_TLD}999999`,
					model: 'component_portal',
					tld: CAP_TLD,
					term: { 'lg-spa': 'scratch rdf tree picker' },
					is_model: false,
					is_translatable: false,
					is_main: false,
					properties: {
						view: 'tree',
						source: {
							request_config: [
								{ sqo: { section_tipo: [{ value: [HOST_SECTION], source: 'section' }] } },
							],
						},
					},
				});
			}
			await clearOntologyDerivedCaches();
		});

		afterAll(async () => {
			await assertTestDatabase('rdf_import_execute_native');
			for (const id of records) await cleanScratchRecord(SECTION, id, TABLE);
			const bulkTable = (await getMatrixTableFromTipo('dd800')) ?? 'matrix_notes';
			for (const id of bulkIds) await cleanScratchRecord('dd800', id, bulkTable);
			await removeAuthzDoorFixture();
			await sweepActivityRows(HOST_SECTION);
			expect(await countActivityRows(HOST_SECTION)).toBe(0);
			expect(await dropSituation(HOST_SITUATION)).toBe(0);
			await deleteTldNodes(CAP_TLD);
			await clearOntologyDerivedCaches();
			const nodesLeft = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM dd_ontology WHERE tld = $1`,
				[CAP_TLD],
			)) as { n: number }[];
			expect(nodesLeft[0]?.n ?? -1).toBe(0);
			const ours = [...records, ...doorRecords];
			await sweepActivityRows(SECTION, ours);
			await sweepActivityRows('dd800', [...bulkIds]);
			expect(await countActivityRows(SECTION, ours)).toBe(0);
			expect(await countActivityRows('dd800', [...bulkIds])).toBe(0);
			// ZERO RESIDUE, asserted on the rows (never on the report).
			const left = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
				[SECTION, [...records].join(',')],
			)) as { n: number }[];
			expect(left[0]?.n ?? -1).toBe(0);
			expect(await tmCount([...records])).toBe(0);
			const bulkLeft = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = ANY(string_to_array($1, ',')::int[])`,
				[[...bulkIds].join(',')],
			)) as { n: number }[];
			expect(bulkLeft[0]?.n ?? -1).toBe(0);
		});

		test('the identities are live (LEVEL_1 reads test3, CONTROL writes it)', async () => {
			await assertAuthzDoorContrast(ids);
			expect(await getPermissions(ids.level1, SECTION, SECTION)).toBe(1);
			expect(await getPermissions(ids.control, SECTION, TITLE)).toBe(2);
		});

		test('findSectionIdByCode matches an IRI item EXACTLY (query string included), never a look-alike', async () => {
			const exact = `${iriOf('lookup')}?a=b&c=d`;
			const holder = await newRecord();
			await seed(holder, IRI, 'lg-nolan', [{ iri: exact }]);
			const other = await newRecord();
			await seed(other, IRI, 'lg-nolan', [{ iri: `${exact}x` }]);
			const target = { sectionTipo: SECTION, componentTipo: IRI };
			expect(await findSectionIdByCode(target, exact, ROOT)).toBe(holder);
			expect(await findSectionIdByCode(target, `${exact}x`, ROOT)).toBe(other);
			expect(await findSectionIdByCode(target, `${iriOf('lookup')}?a=b`, ROOT)).toBeNull();
			// The action's pre-fetch lookup answers the same.
			expect(await findTermRecord(term('t', exact), ROOT)).toBe(holder);
			expect(await findTermRecord(term('t', iriOf('nobody')), ROOT)).toBeNull();
		});

		let callerId = 0;
		let mintId = 0;

		test('fills the empty fields, creates the linked term, links it — one dd800, TM rows carry it', async () => {
			callerId = await newRecord();
			const report = await run(callerId, [coinPlan('coin1', 'mint1')]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.iris[0]?.iri).toBe(iriOf('coin1'));
			expect(report.skipped).toEqual([]);
			expect(report.bulk_process_id).toBeGreaterThan(0);
			expect(report.created).toHaveLength(1);
			mintId = report.created[0]?.section_id as number;
			expect(report.created[0]).toEqual({
				section_tipo: SECTION,
				section_id: mintId,
				label: iriOf('mint1'),
			});
			expect(
				report.written.map((entry) => [entry.section_id, entry.component_tipo, entry.lang]),
			).toEqual([
				[callerId, TITLE, 'lg-eng'],
				[callerId, TITLE, 'lg-spa'],
				[callerId, IRI, 'lg-nolan'],
				[callerId, DATE, 'lg-nolan'],
				[mintId, IRI, 'lg-nolan'],
				[mintId, TITLE, 'lg-eng'],
				[callerId, PORTAL, 'lg-nolan'],
			]);
			expect(report.written[0]?.value_summary).toBe('Quinarius');
			expect(report.written[6]?.value_summary).toBe(`${SECTION}/${mintId}`);

			const titles = await items(callerId, 'string', TITLE);
			expect(titles.map((item) => [item.lang, item.value])).toEqual([
				['lg-eng', 'Quinarius'],
				['lg-spa', 'Quinario'],
			]);
			expect((await items(callerId, 'iri', IRI)).map((item) => item.iri)).toEqual([iriOf('coin1')]);
			expect((await items(callerId, 'date', DATE))[0]).toMatchObject({
				start: { year: -25 },
				end: { year: -23 },
			});
			expect((await items(mintId, 'iri', IRI)).map((item) => item.iri)).toEqual([iriOf('mint1')]);
			const links = await items(callerId, 'relation', PORTAL);
			expect(links.map((item) => [item.section_tipo, Number(item.section_id)])).toEqual([
				[SECTION, mintId],
			]);

			// Every TM row of the two records is attributed to THE run.
			const tm = (await sql.unsafe(
				`SELECT DISTINCT bulk_process_id FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
				[SECTION, `${callerId},${mintId}`],
			)) as { bulk_process_id: number | null }[];
			expect(tm.map((row) => Number(row.bulk_process_id))).toEqual([
				report.bulk_process_id as number,
			]);
			// The created term carries the run's BIRTH marker (role 3): the revert may remove it.
			const birth = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tm_role = 3 AND bulk_process_id = $3`,
				[SECTION, mintId, report.bulk_process_id as number],
			)) as { n: number }[];
			expect(birth[0]?.n).toBe(1);
			// The dd800 record exists.
			const bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
			expect(
				await readMatrixRecord(bulkTable, 'dd800', report.bulk_process_id as number),
			).not.toBeNull();
		});

		test('a SECOND RUN changes nothing: no new record, no data TM row, NO dd800, every op reported skipped', async () => {
			const rowsBefore = await sectionRowCount();
			const tmBefore = await tmCount([callerId, mintId]);
			const bulkBefore = await bulkFootprint();
			const report = await run(callerId, [coinPlan('coin1', 'mint1')]);
			expect(report.iris[0]?.error).toBeNull();
			// The dd800 is minted by the first write: a run that writes nothing mints none.
			expect(report.bulk_process_id).toBeNull();
			expect(await bulkFootprint()).toBe(bulkBefore);
			expect(report.created).toEqual([]);
			expect(report.written).toEqual([]);
			expect(report.skipped.map((entry) => [entry.component_tipo, entry.reason])).toEqual([
				[TITLE, 'not empty in lg-eng — never overwritten'],
				[TITLE, 'not empty in lg-spa — never overwritten'],
				[IRI, 'already present'],
				[DATE, 'not empty in lg-nolan — never overwritten'],
				[TITLE, 'not empty in lg-eng — never overwritten'],
				[PORTAL, 'already present'],
			]);
			expect(await sectionRowCount()).toBe(rowsBefore);
			expect(await tmCount([callerId, mintId])).toBe(tmBefore);
		});

		test('never overwrites a pre-filled literal; still fills its empty sibling slice', async () => {
			const id = await newRecord();
			await seed(id, TITLE, 'lg-eng', [{ value: 'Curated title' }]);
			await seed(id, CODE, 'lg-nolan', [{ value: 'CUR-1' }]);
			const report = await run(id, [
				plan(iriOf('coin2'), [
					set(CALLER, TITLE, 'lg-eng', [{ value: 'Remote' }]),
					set(CALLER, TITLE, 'lg-spa', [{ value: 'Remoto' }]),
					set(CALLER, CODE, 'lg-nolan', [{ value: 'REM-1' }]),
				]),
			]);
			expect(report.written.map((entry) => [entry.component_tipo, entry.lang])).toEqual([
				[TITLE, 'lg-spa'],
			]);
			expect(report.skipped.map((entry) => [entry.component_tipo, entry.section_id])).toEqual([
				[TITLE, id],
				[CODE, id],
			]);
			expect((await items(id, 'string', TITLE)).map((item) => [item.lang, item.value])).toEqual([
				['lg-eng', 'Curated title'],
				['lg-spa', 'Remoto'],
			]);
			expect((await items(id, 'string', CODE)).map((item) => item.value)).toEqual(['CUR-1']);
		});

		test('appends IRIs and locators without duplicates; an existing term is linked, not re-created', async () => {
			const known = await newRecord();
			await seed(known, IRI, 'lg-nolan', [{ iri: iriOf('known') }]);
			const id = await newRecord();
			await seed(id, IRI, 'lg-nolan', [{ iri: iriOf('a') }]);
			await seed(id, PORTAL, 'lg-nolan', [
				{ type: 'dd151', section_tipo: SECTION, section_id: known, from_component_tipo: PORTAL },
			]);
			const report = await run(id, [
				plan(iriOf('coin3'), [
					set(CALLER, TITLE, 'lg-eng', [{ value: 'x'.repeat(200) }]),
					set(CALLER, IRI, 'lg-nolan', [{ iri: iriOf('a') }, { iri: iriOf('b') }]),
					term('known', iriOf('known')),
					term('fresh', iriOf('fresh')),
					term('fresh', iriOf('fresh')), // the same resource reached twice: bound once
					link(CALLER, PORTAL, ref('known')),
					link(CALLER, PORTAL, ref('fresh')),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toHaveLength(1);
			const fresh = report.created[0]?.section_id as number;
			expect(report.created[0]?.label).toBe(iriOf('fresh'));
			expect(report.written[0]?.value_summary).toBe(`${'x'.repeat(157)}...`);
			expect((await items(id, 'iri', IRI)).map((item) => item.iri)).toEqual([
				iriOf('a'),
				iriOf('b'),
			]);
			expect(
				report.written.find((entry) => entry.component_tipo === IRI && entry.section_id === id)
					?.value_summary,
			).toBe(iriOf('b'));
			const links = await items(id, 'relation', PORTAL);
			expect(links.map((item) => Number(item.section_id))).toEqual([known, fresh]);
			expect(report.skipped.map((entry) => [entry.component_tipo, entry.reason])).toEqual([
				[PORTAL, 'already present'],
			]);
		});

		test('an INTERMEDIATE record is created and linked once, then FOUND again through its ddo_map path', async () => {
			const person = iriOf('person1');
			const intermediate = creator('creator', person);
			const creatorPlan = plan(iriOf('coin9'), [
				intermediate,
				intermediate, // a key reached twice: bound once, silently
				term('person', person),
				link(ref('creator'), PORTAL, ref('person')),
				set(ref('creator'), TITLE, 'lg-eng', [{ value: 'Issuer' }]),
			]);
			const id = await newRecord();
			const first = await run(id, [creatorPlan]);
			expect(first.iris[0]?.error).toBeNull();
			expect(first.skipped).toEqual([]);
			expect(first.created.map((entry) => entry.label)).toEqual([person, person]);
			// The person first: the creator is created when its path to the person is complete.
			const personId = first.created[0]?.section_id as number;
			const creatorId = first.created[1]?.section_id as number;
			expect((await items(id, 'relation', PORTAL)).map((item) => Number(item.section_id))).toEqual([
				creatorId,
			]);
			expect(
				(await items(creatorId, 'relation', PORTAL)).map((item) => Number(item.section_id)),
			).toEqual([personId]);

			const rowsBefore = await sectionRowCount();
			const second = await run(id, [creatorPlan]);
			expect(second.created).toEqual([]);
			expect(second.written).toEqual([]);
			expect(reasons(second)).toEqual([
				'already present',
				'not empty in lg-eng — never overwritten',
			]);
			expect(await sectionRowCount()).toBe(rowsBefore);

			// A DIFFERENT resource through the same component is NOT the first intermediate:
			// the path's leaf must hold its identifier, so a new pair is created beside it.
			const other = iriOf('person2');
			const third = await run(id, [
				plan(iriOf('coin11'), [
					{ ...intermediate, key: 'creator2', match_value: other },
					term('person2', other),
					link(ref('creator2'), PORTAL, ref('person2')),
				]),
			]);
			expect(third.created.map((entry) => entry.label)).toEqual([other, other]);
			expect((await items(id, 'relation', PORTAL)).map((item) => Number(item.section_id))).toEqual([
				creatorId,
				third.created[1]?.section_id as number,
			]);

			// The same intermediate op on a caller whose link is NOT writable creates nothing.
			const door = await doorRecord(AUTHZ_PROJECT_P);
			const refused = await run(door, [plan(iriOf('coin10'), [intermediate])], ids.level1);
			expect(refused.created).toEqual([]);
			expect(reasons(refused)).toEqual([
				expect.stringMatching(/^not writable by the importer \(perm\.[a-z_]+\)$/),
			]);
		});

		test('ops on an unbound record, a blank identifier, an uninstalled lang and a plan skip are reported', async () => {
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			const report = await run(id, [
				plan(iriOf('coin4'), [
					term('blank', '  '),
					set(ref('blank'), TITLE, 'lg-eng', [{ value: 'x' }]),
					link(CALLER, PORTAL, ref('blank')),
					link(ref('nowhere'), PORTAL, CALLER),
					set(CALLER, TITLE, 'lg-xxx', [{ value: 'x' }]),
					set(CALLER, 'zzrdfexec9', 'lg-nolan', [{ value: 'x' }]),
					{
						...BASE,
						op: 'skip',
						target: CALLER,
						section_tipo: SECTION,
						component_tipo: null,
						reason: 'data_map_no_match',
					},
				]),
			]);
			expect(report.created).toEqual([]);
			expect(report.written).toEqual([]);
			expect(reasons(report)).toEqual([
				'no identifier — not matched, not created',
				"record 'blank' not resolved",
				"record 'blank' not resolved",
				"record 'nowhere' not resolved",
				'language lg-xxx is not installed',
				'unknown component',
				'data_map_no_match (zz:predicate)',
			]);
			expect(report.skipped[6]?.component_tipo).toBe('');
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('REFUSED: a read-only importer writes nothing and creates nothing; the served twin writes', async () => {
			const id = await doorRecord(AUTHZ_PROJECT_P);
			const rowsBefore = await sectionRowCount();
			const write = set(CALLER, TITLE, 'lg-eng', [{ value: 'Refused' }]);
			const refused = await run(
				id,
				[plan(iriOf('coin5'), [write, term('term', iriOf('refused-term'))])],
				ids.level1,
			);
			expect(refused.iris[0]?.error).toBeNull();
			expect(refused.written).toEqual([]);
			expect(refused.created).toEqual([]);
			expect(reasons(refused)).toEqual([
				expect.stringMatching(/^not writable by the importer \(perm\.[a-z_]+\)$/),
				expect.stringMatching(/^not created: refused \(perm\.[a-z_]+\)$/),
			]);
			expect(await items(id, 'string', TITLE)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);

			const served = await run(id, [plan(iriOf('coin5'), [write])], ids.control);
			expect(served.written.map((entry) => entry.component_tipo)).toEqual([TITLE]);
			expect((await items(id, 'string', TITLE)).map((item) => item.value)).toEqual(['Refused']);
		});

		test('a CREATE needs the match component writable too: a record born without its identifier is never made', async () => {
			expect(await getPermissions(ids.readComponent, SECTION, SECTION)).toBe(2);
			expect(await getPermissions(ids.readComponent, SECTION, IRI)).toBeLessThan(2);
			const id = await doorRecord(AUTHZ_PROJECT_P);
			const rowsBefore = await sectionRowCount();
			const report = await run(
				id,
				[plan(iriOf('coin7'), [term('term', iriOf('pairless-term'))])],
				ids.readComponent,
			);
			expect(report.created).toEqual([]);
			expect(reasons(report)).toEqual([
				expect.stringMatching(/^not created: refused \(perm\.[a-z_]+\)$/),
			]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('an identifier two records share names neither: reported, nothing created, nothing linked', async () => {
			const twinA = await newRecord();
			const twinB = await newRecord();
			await seed(twinA, IRI, 'lg-nolan', [{ iri: iriOf('twin') }]);
			await seed(twinB, IRI, 'lg-nolan', [{ iri: iriOf('twin') }]);
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			const report = await run(id, [
				plan(iriOf('coin6'), [term('twin', iriOf('twin')), link(CALLER, PORTAL, ref('twin'))]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(reasons(report)).toEqual([
				expect.stringContaining('more than one record'),
				"record 'twin' not resolved",
			]);
			expect(await items(id, 'relation', PORTAL)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('a SINGLE-CHOICE model is set only when empty (replace), never re-set', async () => {
			const id = await newRecord();
			const choice = (sectionId: number): RdfImportPlan =>
				plan(iriOf(`coin8-${sectionId}`), [
					set(CALLER, SELECT, 'lg-nolan', [
						{
							type: 'dd151',
							section_tipo: 'dd64',
							section_id: sectionId,
							from_component_tipo: SELECT,
						},
					]),
				]);
			const first = await run(id, [choice(1)]);
			expect(first.iris[0]?.error).toBeNull();
			expect(first.written.map((entry) => entry.component_tipo)).toEqual([SELECT]);
			const second = await run(id, [choice(2)]);
			expect(second.written).toEqual([]);
			expect(reasons(second)).toEqual(['already set (single choice) — never overwritten']);
			const stored = await items(id, 'relation', SELECT);
			expect(stored.map((item) => [item.section_tipo, Number(item.section_id)])).toEqual([
				['dd64', 1],
			]);
		});

		test('a PARTIAL failure is partial: a refused op is skipped with its code, the rest of the IRI commits', async () => {
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			const report = await run(id, [
				plan(iriOf('partial'), [
					term('kept', iriOf('kept')),
					set(CALLER, TITLE, 'lg-eng', [{ value: 'Written' }]),
					// A locator to a section the portal does not target: the insert law refuses
					// THIS save — its savepoint rolls back, nothing else does.
					set(CALLER, PORTAL, 'lg-nolan', [
						{
							type: 'dd151',
							section_tipo: 'zzrdfexecnosuch',
							section_id: 1,
							from_component_tipo: PORTAL,
						},
					]),
					link(CALLER, PORTAL, ref('kept')),
				]),
				plan(iriOf('fine'), [set(CALLER, CODE, 'lg-nolan', [{ value: 'OK-1' }])]),
			]);
			const [partial, fine] = report.iris;
			expect(partial?.error).toBeNull();
			expect(partial?.failure).toBeUndefined();
			expect(partial?.created.map((entry) => entry.label)).toEqual([iriOf('kept')]);
			const kept = partial?.created[0]?.section_id as number;
			expect(partial?.written.map((entry) => [entry.section_id, entry.component_tipo])).toEqual([
				[kept, IRI],
				[id, TITLE],
				[id, PORTAL],
			]);
			expect(partial?.skipped).toEqual([
				{
					component_tipo: PORTAL,
					reason:
						'refused: The linked record was refused by the relation constraint (off_target, zzrdfexecnosuch)',
					code: 'relation.insert_refused',
				},
			]);
			expect(fine?.error).toBeNull();
			expect(report.bulk_process_id).toBeGreaterThan(0);
			expect((await items(id, 'string', TITLE)).map((item) => item.value)).toEqual(['Written']);
			expect((await items(id, 'relation', PORTAL)).map((item) => Number(item.section_id))).toEqual([
				kept,
			]);
			expect((await items(id, 'string', CODE)).map((item) => item.value)).toEqual(['OK-1']);
			expect(await sectionRowCount()).toBe(rowsBefore + 1);
		});

		test('a link the ontology maps OFF TARGET is skipped before anything is found or created; what depends on it too', async () => {
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			const off = ref('offterm');
			const report = await run(id, [
				plan(iriOf('offplan'), [
					set(CALLER, TITLE, 'lg-eng', [{ value: 'Still written' }]),
					term('offterm', iriOf('offterm')),
					set(off, TITLE, 'lg-eng', [{ value: 'never written' }]),
					// test91 (a select) targets dd64: a test3 term can never be linked from it.
					link(CALLER, SELECT, off),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(report.written.map((entry) => [entry.section_id, entry.component_tipo])).toEqual([
				[id, TITLE],
			]);
			expect(report.skipped).toEqual([
				{
					component_tipo: SELECT,
					reason: `ontology zzrdfexec2 maps ${SECTION}, but ${SELECT} targets dd64 — fix the ontology node`,
					code: 'relation.insert_refused',
				},
				{
					component_tipo: TITLE,
					reason: 'depends on offterm, which failed',
					code: 'relation.insert_refused',
				},
			]);
			expect(
				await findSectionIdByCode(
					{ sectionTipo: SECTION, componentTipo: IRI },
					iriOf('offterm'),
					ROOT,
				),
			).toBeNull();
			expect(await items(id, 'relation', SELECT)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('an INTERMEDIATE the ontology maps OFF TARGET dies with its edge: the ops on it (and under it) depend on it, nothing is made', async () => {
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			// test91 (a select over dd64) can never link a test3 intermediate.
			const offCreator: RdfIntermediateOp = {
				...creator('offc', iriOf('offc-person')),
				component_tipo: SELECT,
				path: [
					{ section_tipo: SECTION, component_tipo: SELECT, parent: SECTION },
					{ section_tipo: SECTION, component_tipo: IRI, parent: SELECT },
				],
			};
			const report = await run(id, [
				plan(iriOf('offc-plan'), [
					set(CALLER, TITLE, 'lg-eng', [{ value: 'Still written H' }]),
					offCreator,
					set(ref('offc'), TITLE, 'lg-eng', [{ value: 'never' }]),
					// A record UNDER the dead one dies with it.
					{ ...creator('offc-sub', iriOf('offc-sub')), target: ref('offc') },
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(report.written.map((entry) => [entry.section_id, entry.component_tipo])).toEqual([
				[id, TITLE],
			]);
			expect(
				report.skipped.map((entry) => [entry.component_tipo, entry.reason, entry.code]),
			).toEqual([
				[
					SELECT,
					`ontology zzrdfexec1 maps ${SECTION}, but ${SELECT} targets dd64 — fix the ontology node`,
					'relation.insert_refused',
				],
				[TITLE, 'depends on offc, which failed', 'relation.insert_refused'],
				[PORTAL, 'depends on offc, which failed', 'relation.insert_refused'],
			]);
			expect(await items(id, 'relation', SELECT)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('the target check judges a component on its HOST record: a self-targeting portal links two terms of another section', async () => {
			const id = await newRecord();
			const hostTerm = (key: string): RdfFindOrCreateOp => ({
				...term(key, iriOf(`host-${key}`)),
				section_tipo: HOST_SECTION,
				match_component_tipo: HOST_IRI,
			});
			const hostLink = (target: RecordRef, to: RecordRef): RdfLinkOp => ({
				...link(target, SELF_PORTAL, to),
				section_tipo: target.kind === 'caller' ? SECTION : HOST_SECTION,
				to_section_tipo: HOST_SECTION,
			});
			const report = await run(id, [
				plan(iriOf('host-plan'), [
					hostTerm('ha'),
					hostTerm('hb'),
					// FIRST through the same component on the CALLER (test3): 'self' is test3
					// there, so a zzrdfhost1 term is off target — and a memo keyed by the
					// component alone would carry that verdict to the next link.
					hostLink(CALLER, ref('hb')),
					// On ha (a zzrdfhost1 record): 'self' is zzrdfhost1 — on target.
					hostLink(ref('ha'), ref('hb')),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(
				report.skipped.map((entry) => [entry.component_tipo, entry.reason, entry.code]),
			).toEqual([
				[
					SELF_PORTAL,
					`ontology zzrdfexec2 maps ${HOST_SECTION}, but ${SELF_PORTAL} targets ${SECTION} — fix the ontology node`,
					'relation.insert_refused',
				],
			]);
			expect(report.created.map((entry) => [entry.section_tipo, entry.label])).toEqual([
				[HOST_SECTION, iriOf('host-ha')],
				[HOST_SECTION, iriOf('host-hb')],
			]);
			const [ha, hb] = report.created.map((entry) => entry.section_id) as [number, number];
			const linked = (await readMatrixRecord(TABLE, HOST_SECTION, ha))?.columns as
				| Record<string, Record<string, { section_tipo: string; section_id: unknown }[]>>
				| undefined;
			expect(
				(linked?.relation?.[SELF_PORTAL] ?? []).map((item) => [
					item.section_tipo,
					Number(item.section_id),
				]),
			).toEqual([[HOST_SECTION, hb]]);
		});

		test('a tree picker link into a section the actor cannot read is WRITTEN (owner decision (i)); the IRI commits it all', async () => {
			// The control writes test3 and (for this test) both tree pickers at the pair,
			// but holds NO grant on zzrdfhost1. A creator record there, already linked from
			// the caller, is FOUND through its path (stored locators — no search, so no
			// read grant needed); linking it through the second tree picker reaches the
			// insert door, which — since the tree picker's read-grant gate was retired
			// (owner decision (i), 2026-11-03; it used to refuse this as
			// target_not_readable → perm.denied, a skip) — accepts it: the caller grant
			// (2 on the picker) is the authorization, exactly as PHP.
			const profile = authzProfileId(AUTHZ_CONTROL_USER_ID);
			const before = (await sql.unsafe(
				`SELECT misc->'dd774' AS grants FROM matrix_profiles WHERE section_tipo = 'dd234' AND section_id = $1`,
				[profile],
			)) as { grants: unknown }[];
			const grants = before[0]?.grants as unknown[];
			expect(Array.isArray(grants)).toBe(true);
			const setGrants = async (value: unknown[]) => {
				await sql.unsafe(
					`UPDATE matrix_profiles SET misc = jsonb_set(misc, '{dd774}', $2::text::jsonb)
					  WHERE section_tipo = 'dd234' AND section_id = $1`,
					[profile, JSON.stringify(value)],
				);
				clearAuthzDoorCaches();
			};
			await setGrants([
				...grants,
				...[TREE_PICKER, TREE_PICKER_2].map((tipo, index) => ({
					id: grants.length + 1 + index,
					tipo,
					section_tipo: SECTION,
					value: 2,
				})),
			]);
			try {
				await treePickerLinkWritten();
			} finally {
				await setGrants(grants);
			}
		});

		async function treePickerLinkWritten(): Promise<void> {
			expect(await getPermissions(ids.control, SECTION, TREE_PICKER_2)).toBe(2);
			expect(await getPermissions(ids.control, HOST_SECTION, HOST_SECTION)).toBe(0);
			const creatorIri = iriOf('tree-creator');
			const holder = await createSectionRecord(HOST_SECTION, -1);
			const seedAs = async (
				sectionTipo: string,
				sectionId: number,
				tipo: string,
				value: unknown[],
			) => {
				const saved = await saveComponentData({
					componentTipo: tipo,
					sectionTipo,
					sectionId,
					lang: 'lg-nolan',
					changedData: [{ action: 'set_data', id: null, value }],
					userId: -1,
					principal: ROOT,
				});
				expect(saved.ok).toBe(true);
			};
			await seedAs(HOST_SECTION, holder, HOST_IRI, [{ iri: creatorIri }]);
			const id = await doorRecord(AUTHZ_PROJECT_P);
			await seedAs(SECTION, id, TREE_PICKER, [
				{
					type: 'dd151',
					section_tipo: HOST_SECTION,
					section_id: holder,
					from_component_tipo: TREE_PICKER,
				},
			]);
			const treeCreator: RdfIntermediateOp = {
				...creator('tc', creatorIri),
				component_tipo: TREE_PICKER,
				intermediate_section_tipo: HOST_SECTION,
				path: [
					{ section_tipo: SECTION, component_tipo: TREE_PICKER, parent: SECTION },
					{ section_tipo: HOST_SECTION, component_tipo: HOST_IRI, parent: TREE_PICKER },
				],
			};
			const report = await run(
				id,
				[
					plan(iriOf('tree-plan'), [
						treeCreator,
						{ ...link(CALLER, TREE_PICKER_2, ref('tc')), to_section_tipo: HOST_SECTION },
						set(CALLER, TITLE, 'lg-eng', [{ value: 'Written beside the tree link' }]),
					]),
				],
				ids.control,
			);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(report.skipped).toEqual([]);
			expect(
				report.written.map((entry) => `${entry.section_id}:${entry.component_tipo}`).sort(),
			).toEqual([`${id}:${TITLE}`, `${id}:${TREE_PICKER_2}`].sort());
			expect((await items(id, 'string', TITLE)).map((item) => item.value)).toEqual([
				'Written beside the tree link',
			]);
			expect(
				(await items(id, 'relation', TREE_PICKER_2)).map((item) => [
					(item as { section_tipo?: unknown }).section_tipo,
					Number((item as { section_id?: unknown }).section_id),
				]),
			).toEqual([[HOST_SECTION, holder]]);
		}

		test('a term whose find is REFUSED is not created; every op naming it is skipped as depending on it', async () => {
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			// A term "identified" by a PORTAL: the code lookup refuses to match a text in
			// a relation component (request.invalid, a caller refusal) — the op rolls back
			// to its savepoint, the term stays unbound, and what names it is skipped.
			const doomed: RdfFindOrCreateOp = {
				...term('doomed', 'zz-doomed-identifier'),
				match_component_tipo: PORTAL,
				match_model: 'component_portal',
				match_item: {
					type: 'dd151',
					section_tipo: 'zzrdfexecnosuch',
					section_id: 1,
					from_component_tipo: PORTAL,
				},
			};
			const report = await run(id, [
				plan(iriOf('doomedplan'), [
					doomed,
					set(ref('doomed'), TITLE, 'lg-eng', [{ value: 'never written' }]),
					link(CALLER, PORTAL, ref('doomed')),
					// A record UNDER the failed one fails with it, and so does what names IT.
					{ ...creator('sub', iriOf('doomed-sub')), target: ref('doomed') },
					set(ref('sub'), TITLE, 'lg-eng', [{ value: 'never written either' }]),
					set(CALLER, CODE, 'lg-nolan', [{ value: 'KEPT-1' }]),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(report.written.map((entry) => [entry.section_id, entry.component_tipo])).toEqual([
				[id, CODE],
			]);
			const code = 'request.invalid';
			expect(report.skipped).toEqual([
				{ component_tipo: PORTAL, reason: 'refused: Invalid request', code },
				{ component_tipo: TITLE, reason: 'depends on doomed, which failed', code },
				{ component_tipo: PORTAL, reason: 'depends on doomed, which failed', code },
				{ component_tipo: PORTAL, reason: 'depends on doomed, which failed', code },
				{ component_tipo: TITLE, reason: 'depends on sub, which failed', code },
			]);
			expect(await items(id, 'relation', PORTAL)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('an op WAITING for an intermediate that the engine refuses is skipped; the intermediate is still made', async () => {
			const id = await newRecord();
			const person = iriOf('waitperson');
			const report = await run(id, [
				plan(iriOf('waitcoin'), [
					creator('creator', person),
					// Waits for the creator (it does not complete its path), then is refused.
					set(ref('creator'), PORTAL, 'lg-nolan', [
						{
							type: 'dd151',
							section_tipo: 'zzrdfexecnosuch',
							section_id: 1,
							from_component_tipo: PORTAL,
						},
					]),
					term('person', person),
					link(ref('creator'), PORTAL, ref('person')),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created.map((entry) => entry.label)).toEqual([person, person]);
			const [personId, creatorId] = report.created.map((entry) => entry.section_id) as [
				number,
				number,
			];
			expect(report.skipped).toEqual([
				{
					component_tipo: PORTAL,
					reason: expect.stringMatching(/^refused: /),
					code: 'relation.insert_refused',
				},
			]);
			expect((await items(id, 'relation', PORTAL)).map((item) => Number(item.section_id))).toEqual([
				creatorId,
			]);
			expect(
				(await items(creatorId, 'relation', PORTAL)).map((item) => Number(item.section_id)),
			).toEqual([personId]);
		});

		/** A locator off the portal's targets that CARRIES the resource's identifier: it completes a path, then the insert law refuses it. */
		const offTargetHolding = (identifier: string): RdfPlanItem => ({
			type: 'dd151',
			section_tipo: 'zzrdfexecnosuch',
			section_id: 1,
			from_component_tipo: PORTAL,
			value: identifier,
		});
		/** A creator whose path LEAF is the portal itself (caller.test80 → creator.test80). */
		const portalLeafCreator = (key: string, identifier: string): RdfIntermediateOp => ({
			...creator(key, identifier),
			path: [
				{ section_tipo: SECTION, component_tipo: PORTAL, parent: SECTION },
				{ section_tipo: SECTION, component_tipo: PORTAL, parent: PORTAL },
			],
		});
		const OFF_TARGET_REFUSAL =
			'refused: The linked record was refused by the relation constraint (off_target, zzrdfexecnosuch)';

		test('the op COMPLETING an intermediate refused: its waiting ops and the ops after it depend on it, nothing is made', async () => {
			const person = iriOf('complete-refused');
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			const report = await run(id, [
				plan(iriOf('coin-complete-refused'), [
					portalLeafCreator('creator', person),
					set(ref('creator'), TITLE, 'lg-eng', [{ value: 'Waiting' }]),
					set(ref('creator'), PORTAL, 'lg-nolan', [offTargetHolding(person)]),
					set(ref('creator'), CODE, 'lg-nolan', [{ value: 'Later' }]),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(report.written).toEqual([]);
			const code = 'relation.insert_refused';
			expect(report.skipped).toEqual([
				{ component_tipo: TITLE, reason: 'depends on creator, which failed', code },
				{ component_tipo: PORTAL, reason: OFF_TARGET_REFUSAL, code },
				{ component_tipo: CODE, reason: 'depends on creator, which failed', code },
			]);
			expect(report.bulk_process_id).toBeNull();
			expect(await items(id, 'relation', PORTAL)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('a NESTED completing op refused: the outer intermediate it realized is unbound again, nothing links it', async () => {
			const person = iriOf('nested-refused');
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			const report = await run(id, [
				plan(iriOf('coin-nested-refused'), [
					creator('outer', person),
					{ ...portalLeafCreator('inner', person), target: ref('outer') },
					set(ref('inner'), PORTAL, 'lg-nolan', [offTargetHolding(person)]),
					link(CALLER, PORTAL, ref('outer')),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(report.written).toEqual([]);
			expect(report.skipped).toEqual([
				{ component_tipo: PORTAL, reason: OFF_TARGET_REFUSAL, code: 'relation.insert_refused' },
				{ component_tipo: PORTAL, reason: "record 'outer' not resolved" },
				{
					component_tipo: PORTAL,
					reason: `intermediate not created — no record of ${person} was linked`,
					section_tipo: SECTION,
					section_id: id,
				},
			]);
			expect(await items(id, 'relation', PORTAL)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('a NESTED intermediate whose create is refused AT REALIZE: the outer one realized for it is undone — reruns add none', async () => {
			const person = iriOf('nested-create-refused');
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			// outer: caller.test80 → outer(test3).test52 → inner.test140 = person. inner's
			// own section is a tipo the create door refuses (request.invalid): applyIntermediate
			// never asks for it (its target is still PENDING), so the refusal surfaces only
			// when the completing set realizes outer, then inner.
			const outer: RdfIntermediateOp = {
				...creator('outer', person),
				path: [
					{ section_tipo: SECTION, component_tipo: PORTAL, parent: SECTION },
					{ section_tipo: SECTION, component_tipo: TITLE, parent: PORTAL },
					{ section_tipo: SECTION, component_tipo: IRI, parent: TITLE },
				],
			};
			const inner: RdfIntermediateOp = {
				...creator('inner', person),
				target: ref('outer'),
				component_tipo: TITLE,
				intermediate_section_tipo: 'BAD TIPO',
				path: [
					{ section_tipo: SECTION, component_tipo: TITLE, parent: SECTION },
					{ section_tipo: SECTION, component_tipo: IRI, parent: TITLE },
				],
			};
			const nestedPlan = () =>
				plan(iriOf('coin-nested-create-refused'), [
					outer,
					inner,
					set(ref('inner'), IRI, 'lg-nolan', [{ iri: person }]),
				]);
			for (const _round of [0, 1]) {
				const report = await run(id, [nestedPlan()]);
				expect(report.iris[0]?.error).toBeNull();
				expect(report.created).toEqual([]);
				expect(report.written).toEqual([]);
				expect(report.bulk_process_id).toBeNull();
				expect(report.skipped).toEqual([
					{
						component_tipo: IRI,
						reason: `refused: Not created: the record could not hold the identifier that finds it again (not created: refused (request.invalid))`,
						code: UNIDENTIFIABLE,
					},
					{
						component_tipo: PORTAL,
						reason: `intermediate not created — no record of ${person} was linked`,
						section_tipo: SECTION,
						section_id: id,
					},
				]);
				expect(await items(id, 'relation', PORTAL)).toEqual([]);
				expect(await sectionRowCount()).toBe(rowsBefore);
			}
		});

		test('a caller record that is MISSING is materialized under the op savepoint WITH its birth marker and NEW activity row (revertable)', async () => {
			// A record deleted while the tool was open: its address is empty again.
			const id = await newRecord();
			await cleanScratchRecord(SECTION, id, TABLE);
			await sweepActivityRows(SECTION, [id]);
			const report = await run(id, [
				plan(iriOf('missing-caller'), [set(CALLER, TITLE, 'lg-eng', [{ value: 'Resurrected' }])]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.written.map((entry) => [entry.section_id, entry.component_tipo])).toEqual([
				[id, TITLE],
			]);
			const bulkId = report.bulk_process_id as number;
			expect(bulkId).toBeGreaterThan(0);
			// The save's create-on-first-save ran inside the op's SAVEPOINT: the row's xmin
			// is the subtransaction's, so a birth decided by xmin would answer "not mine".
			const births = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine
				  WHERE section_tipo = $1 AND section_id = $2 AND tm_role = 3 AND bulk_process_id = $3`,
				[SECTION, id, bulkId],
			)) as { n: number }[];
			expect(births[0]?.n).toBe(1);
			expect(await countActivityRows(SECTION, [id])).toBe(1);
		});

		test('a BORN record that cannot hold the identifier that finds it is never made (term or intermediate): reruns add none', async () => {
			const resource = iriOf('unidentifiable');
			const leafCreator: RdfIntermediateOp = {
				...creator('creator', resource),
				path: [
					{ section_tipo: SECTION, component_tipo: PORTAL, parent: SECTION },
					{ section_tipo: SECTION, component_tipo: IRI, parent: PORTAL },
				],
			};
			// A remote identifier carrying tag syntax: the identifier write is refused.
			const tagText = `Tagged [index-n-7-fake-data:{'section_tipo':'dd128','section_id':'1'}:data] ${RUN}`;
			const tagged: RdfFindOrCreateOp = {
				...term('tagged', tagText),
				match_component_tipo: TEXT_AREA,
				match_model: 'component_text_area',
				match_lang: 'lg-spa',
				match_item: { lang: 'lg-spa', value: textAsParagraph(tagText) },
			};
			const unidentifiable = plan(iriOf('coin-unidentifiable'), [
				leafCreator,
				set(ref('creator'), TITLE, 'lg-eng', [{ value: 'Waiting' }]),
				// Completes the path — in a language the install does not declare: never written.
				set(ref('creator'), IRI, 'lg-xxx', [{ iri: resource }]),
				tagged,
				link(CALLER, PORTAL, ref('tagged')),
				set(CALLER, CODE, 'lg-nolan', [{ value: 'KEPT-UNID' }]),
			]);
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			for (const pass of [1, 2]) {
				const report = await run(id, [unidentifiable]);
				expect(report.iris[0]?.error).toBeNull();
				expect(report.created).toEqual([]);
				expect(report.written.map((entry) => [entry.section_id, entry.component_tipo])).toEqual(
					pass === 1 ? [[id, CODE]] : [],
				);
				const code = UNIDENTIFIABLE;
				// The rerun also meets its own committed code: 'not empty …'.
				expect(report.skipped).toHaveLength(pass === 1 ? 4 : 5);
				expect(report.skipped.slice(0, 4)).toEqual([
					{ component_tipo: TITLE, reason: 'depends on creator, which failed', code },
					{
						component_tipo: IRI,
						reason: expect.stringMatching(/\(language lg-xxx is not installed\)$/),
						code,
					},
					{
						component_tipo: TEXT_AREA,
						reason: expect.stringMatching(
							/\(remote text carries Dédalo tag syntax — not written\)$/,
						),
						code,
					},
					{ component_tipo: PORTAL, reason: 'depends on tagged, which failed', code },
				]);
				expect(await items(id, 'relation', PORTAL)).toEqual([]);
				expect(await sectionRowCount()).toBe(rowsBefore);
			}
		});

		test('a linked term whose link the insert law refuses (not off target) STAYS: a complete authority record, found again, never duplicated', async () => {
			// The documented posture: a term is written immediately, as its own op. A
			// refused link (here the component's selection cap) rolls back only the
			// link — the term keeps its identifier and fields, carries the run's birth
			// marker (revertable with the run), and the next run FINDS it.
			const occupant = await newRecord();
			const id = await newRecord();
			await saveComponentData({
				componentTipo: CAPPED,
				sectionTipo: SECTION,
				sectionId: id,
				lang: 'lg-nolan',
				changedData: [{ action: 'set_data', id: null, value: [locatorOf(occupant, CAPPED)] }],
				userId: -1,
			});
			const capped = plan(iriOf('coin-capped'), [
				term('capped', iriOf('capped-term')),
				set(ref('capped'), TITLE, 'lg-eng', [{ value: 'Capped term' }]),
				link(CALLER, CAPPED, ref('capped')),
			]);
			const refusal = {
				component_tipo: CAPPED,
				reason: expect.stringMatching(/^refused: .*selection_limit/),
				code: 'relation.insert_refused',
			};
			const first = await run(id, [capped]);
			expect(first.iris[0]?.error).toBeNull();
			expect(first.created.map((entry) => entry.label)).toEqual([iriOf('capped-term')]);
			const termId = first.created[0]?.section_id as number;
			expect(first.skipped).toEqual([refusal]);
			expect((await items(termId, 'string', TITLE)).map((item) => item.value)).toEqual([
				'Capped term',
			]);
			const birth = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_time_machine
				  WHERE section_tipo = $1 AND section_id = $2 AND tm_role = 3 AND bulk_process_id = $3`,
				[SECTION, termId, first.bulk_process_id as number],
			)) as { n: number }[];
			expect(birth[0]?.n).toBe(1);
			const rowsBefore = await sectionRowCount();
			const bulkBefore = await bulkFootprint();
			const second = await run(id, [capped]);
			expect(second.created).toEqual([]);
			expect(second.skipped.map((entry) => entry.reason)).toEqual([
				'not empty in lg-eng — never overwritten',
				expect.stringMatching(/selection_limit/),
			]);
			// The refused link's dd800 rolled back with it: a rerun leaves none.
			expect(second.bulk_process_id).toBeNull();
			expect(await bulkFootprint()).toBe(bulkBefore);
			expect(await sectionRowCount()).toBe(rowsBefore);
			expect(await findTermRecord(term('capped', iriOf('capped-term')), ROOT)).toBe(termId);
		});

		test('the FIRST writing op refused: the dd800 it minted is forgotten, the next write mints the run’s real one', async () => {
			const id = await newRecord();
			const report = await run(id, [
				plan(iriOf('mint-refused'), [
					set(CALLER, PORTAL, 'lg-nolan', [
						{
							type: 'dd151',
							section_tipo: 'zzrdfexecnosuch',
							section_id: 1,
							from_component_tipo: PORTAL,
						},
					]),
					set(CALLER, TITLE, 'lg-eng', [{ value: 'After refusal' }]),
				]),
			]);
			expect(report.written.map((entry) => entry.component_tipo)).toEqual([TITLE]);
			const bulkId = report.bulk_process_id as number;
			expect(bulkId).toBeGreaterThan(0);
			const bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
			expect(await readMatrixRecord(bulkTable, 'dd800', bulkId)).not.toBeNull();
			const tm = (await sql.unsafe(
				`SELECT DISTINCT bulk_process_id FROM matrix_time_machine
				  WHERE section_tipo = $1 AND section_id = $2 AND bulk_process_id IS NOT NULL`,
				[SECTION, id],
			)) as { bulk_process_id: number }[];
			expect(tm.map((row) => Number(row.bulk_process_id))).toEqual([bulkId]);
			// The run is over: its dd800 is no longer live (a revert of it is admitted).
			expect(isBulkRunLive(bulkId)).toBe(false);
		});

		test('the executor registers its minted dd800 LIVE while it writes, and releases it after', async () => {
			const id = await newRecord();
			const bulkTable = (await getMatrixTableFromTipo('dd800')) ?? 'matrix_notes';
			const counter = (await sql.unsafe(
				`SELECT COALESCE((SELECT value FROM ${bulkTable.endsWith('_dd') ? 'matrix_counter_dd' : 'matrix_counter'} WHERE tipo = 'dd800'), 0)::int AS v`,
				[],
			)) as { v: number }[];
			const from = (counter[0]?.v ?? 0) + 1;
			// Poll between event-loop turns while the run awaits its database work: the
			// run's id is the next the dd800 counter hands out (a window absorbs a
			// concurrent mint).
			const seen = new Set<number>();
			let running = true;
			const poller = (async () => {
				while (running) {
					for (let candidate = from; candidate < from + 50; candidate++) {
						if (isBulkRunLive(candidate)) seen.add(candidate);
					}
					await new Promise((resolve) => setImmediate(resolve));
				}
			})();
			const report = await run(id, [
				plan(iriOf('live-run'), [
					set(CALLER, TITLE, 'lg-eng', [{ value: 'Live one' }]),
					set(CALLER, CODE, 'lg-nolan', [{ value: 'LIVE-1' }]),
					set(CALLER, TITLE, 'lg-spa', [{ value: 'En curso' }]),
				]),
			]);
			running = false;
			await poller;
			const bulkId = report.bulk_process_id as number;
			expect(bulkId).toBeGreaterThan(0);
			expect([...seen]).toEqual([bulkId]);
			expect(isBulkRunLive(bulkId)).toBe(false);
		});

		test('withLazyLiveBulkRun: enter registers, leave and the finally release; an outer owner keeps its id', async () => {
			const lazy = -97_531; // never a minted dd800 id
			await withLazyLiveBulkRun(async ({ enter, leave }) => {
				enter(lazy);
				expect(isBulkRunLive(lazy)).toBe(true);
				leave(lazy);
				expect(isBulkRunLive(lazy)).toBe(false);
				enter(lazy);
			});
			expect(isBulkRunLive(lazy)).toBe(false);
			const thrown = withLazyLiveBulkRun(async ({ enter }) => {
				enter(lazy);
				throw new DedaloError('perm.denied', { message: 'registry probe' });
			});
			await expect(thrown).rejects.toThrow('registry probe');
			expect(isBulkRunLive(lazy)).toBe(false);
			const owned = -97_532;
			await withLiveBulkRun(owned, async () => {
				await withLazyLiveBulkRun(async ({ enter, leave }) => {
					enter(owned);
					leave(owned);
					expect(isBulkRunLive(owned)).toBe(true);
				});
				expect(isBulkRunLive(owned)).toBe(true);
			});
			expect(isBulkRunLive(owned)).toBe(false);
		});

		test('only WEB IRIs are written: a javascript:/data: IRI is never stored, and no record is born for one', async () => {
			const id = await newRecord();
			const rowsBefore = await sectionRowCount();
			const report = await run(id, [
				plan(iriOf('xss'), [
					set(CALLER, IRI, 'lg-nolan', [
						{ iri: 'javascript:alert(document.cookie)' },
						{ iri: iriOf('ok') },
						{ iri: ' data:text/html,x' },
					]),
					term('evil', 'javascript:alert(2)'),
					link(CALLER, PORTAL, ref('evil')),
					set(CALLER, TITLE, 'lg-eng', [{ value: 'kept' }]),
				]),
				plan(iriOf('xss2'), [set(CALLER, IRI, 'lg-nolan', [{ iri: 'JavaScript:alert(3)' }])]),
			]);
			expect(report.iris.map((iri) => iri.error)).toEqual([null, null]);
			expect(report.created).toEqual([]);
			expect((await items(id, 'iri', IRI)).map((item) => item.iri)).toEqual([iriOf('ok')]);
			expect(reasons(report)).toEqual([
				'unsupported IRI scheme (http/https only) — not written',
				"record 'evil' not resolved",
				'unsupported IRI scheme (http/https only) — not written',
			]);
			expect(report.skipped.map((entry) => entry.component_tipo)).toEqual([IRI, PORTAL, IRI]);
			expect(await items(id, 'relation', PORTAL)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('a NUMBER the plan cast is stored as a number; the string it no longer sends is refused per op', async () => {
			const id = await newRecord();
			const report = await run(id, [
				plan(iriOf('weight'), [
					set(CALLER, NUMBER, 'lg-nolan', [{ lang: 'lg-nolan', value: 7.85 }]),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.written.map((entry) => entry.component_tipo)).toEqual([NUMBER]);
			expect((await items(id, 'number', NUMBER)).map((item) => item.value)).toEqual([7.85]);
			// the pre-cast shape (rdf_import_plan itemFor before number_unparsed): refused, nothing stored
			const other = await newRecord();
			const refused = await run(other, [
				plan(iriOf('weight_text'), [
					set(CALLER, NUMBER, 'lg-nolan', [{ lang: 'lg-nolan', value: '7.85' }]),
				]),
			]);
			expect(refused.written).toEqual([]);
			expect(refused.skipped.map((entry) => entry.code)).toEqual(['request.invalid_data']);
			expect(await items(other, 'number', NUMBER)).toEqual([]);
		});

		test('an HTML match component (text_area) is FOUND AGAIN: a rerun creates no second record', async () => {
			// What the plan emits for a Legend / Design class: the raw text as the
			// identifier, the escaped paragraph as the stored item.
			const text = `LEGEND & "Q" <x> O'Brien ${RUN}`;
			const legend: RdfFindOrCreateOp = {
				...term('legend', text),
				match_component_tipo: TEXT_AREA,
				match_model: 'component_text_area',
				match_lang: 'lg-spa',
				match_item: { lang: 'lg-spa', value: textAsParagraph(text) },
			};
			const legendPlan = plan(iriOf('coin-legend'), [legend, link(CALLER, PORTAL, ref('legend'))]);
			const id = await newRecord();
			const first = await run(id, [legendPlan]);
			expect(first.iris[0]?.error).toBeNull();
			expect(first.created).toHaveLength(1);
			const legendId = first.created[0]?.section_id as number;
			// The identifier is stored in the op's match LANGUAGE (the current data
			// language for a translatable class), never another slice.
			expect(
				(await items(legendId, 'string', TEXT_AREA)).map((item) => [item.lang, item.value]),
			).toEqual([['lg-spa', textAsParagraph(text)]]);
			expect(
				await findSectionIdByCode({ sectionTipo: SECTION, componentTipo: TEXT_AREA }, text, ROOT),
			).toBe(legendId);
			const rowsBefore = await sectionRowCount();
			const second = await run(id, [legendPlan]);
			expect(second.created).toEqual([]);
			expect(reasons(second)).toEqual(['already present']);
			expect(await sectionRowCount()).toBe(rowsBefore);
			expect((await items(id, 'relation', PORTAL)).map((item) => Number(item.section_id))).toEqual([
				legendId,
			]);
		});

		test('a GEO TAG text (refused by the append merge) is written into an empty slice; the IRI commits', async () => {
			const id = await newRecord();
			await seed(id, TEXT_AREA, 'lg-eng', [{ lang: 'lg-eng', value: '<p>curated</p>' }]);
			const tag = '<p>[geo-n-1-1-data::data]</p>';
			const report = await run(id, [
				plan(iriOf('mint-geo'), [
					set(CALLER, TITLE, 'lg-eng', [{ value: 'Emerita' }]),
					set(CALLER, TEXT_AREA, 'lg-spa', [{ lang: 'lg-spa', value: tag }]),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.written.map((entry) => [entry.component_tipo, entry.lang])).toEqual([
				[TITLE, 'lg-eng'],
				[TEXT_AREA, 'lg-spa'],
			]);
			expect((await items(id, 'string', TEXT_AREA)).map((item) => [item.lang, item.value])).toEqual(
				[
					['lg-eng', '<p>curated</p>'],
					['lg-spa', tag],
				],
			);
			// Never overwritten: the slice is not empty any more.
			const again = await run(id, [
				plan(iriOf('mint-geo'), [
					set(CALLER, TEXT_AREA, 'lg-spa', [{ lang: 'lg-spa', value: tag }]),
				]),
			]);
			expect(reasons(again)).toEqual(['not empty in lg-spa — never overwritten']);
		});

		test('a REMOTE text carrying Dédalo tag syntax is never stored as a tag: skipped, the IRI commits', async () => {
			const id = await newRecord();
			const fake = `See [index-n-7-fake-data:{'section_tipo':'dd128','section_id':'1'}:data] end`;
			const report = await run(id, [
				plan(iriOf('coin-tag'), [
					set(CALLER, TEXT_AREA, 'lg-eng', [{ lang: 'lg-eng', value: textAsParagraph(fake) }]),
					// Not the plan's own geo tag: another layer is remote text too.
					set(CALLER, TEXT_AREA, 'lg-spa', [
						{ lang: 'lg-spa', value: '<p>[geo-n-2-2-data::data]</p>' },
					]),
					set(CALLER, TITLE, 'lg-eng', [{ value: 'kept' }]),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.written.map((entry) => entry.component_tipo)).toEqual([TITLE]);
			expect(report.skipped.map((entry) => [entry.component_tipo, entry.reason])).toEqual([
				[TEXT_AREA, 'remote text carries Dédalo tag syntax — not written'],
				[TEXT_AREA, 'remote text carries Dédalo tag syntax — not written'],
			]);
			expect(await items(id, 'string', TEXT_AREA)).toEqual([]);
		});

		test('an intermediate whose resource is NOT resolved is never created: reruns leave no empty one', async () => {
			// The person's IRI is held by two records: the find names neither, so the
			// creator's path could never lead to it — no run may leave a creator behind.
			const person = iriOf('person-amb');
			for (const twin of [await newRecord(), await newRecord()]) {
				await seed(twin, IRI, 'lg-nolan', [{ iri: person }]);
			}
			const id = await newRecord();
			const orphanPlan = plan(iriOf('coin-orphan'), [
				creator('creator', person),
				set(ref('creator'), TITLE, 'lg-eng', [{ value: 'Issuer' }]),
				term('person', person),
				link(ref('creator'), PORTAL, ref('person')),
			]);
			const rowsBefore = await sectionRowCount();
			for (const _ of [1, 2]) {
				const report = await run(id, [orphanPlan]);
				expect(report.iris[0]?.error).toBeNull();
				expect(report.created).toEqual([]);
				expect(report.written).toEqual([]);
				expect(reasons(report)).toEqual([
					expect.stringContaining('more than one record'),
					`intermediate not created — no record of ${person} was linked`,
					"record 'creator' not created",
					"record 'creator' not created",
				]);
			}
			expect(await items(id, 'relation', PORTAL)).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
		});

		test('an intermediate is created when its path is COMPLETED, its earlier ops applied after it', async () => {
			const person = iriOf('person-late');
			const id = await newRecord();
			const report = await run(id, [
				plan(iriOf('coin-late'), [
					creator('creator', person),
					set(ref('creator'), TITLE, 'lg-eng', [{ value: 'Issuer' }]),
					term('person', person),
					link(ref('creator'), PORTAL, ref('person')),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.skipped).toEqual([]);
			const [personId, creatorId] = report.created.map((entry) => entry.section_id) as [
				number,
				number,
			];
			// The creator is created by the op that completes its path; what waited
			// for it (the title) is applied right after it exists, before that op.
			expect(report.written.map((entry) => [entry.section_id, entry.component_tipo])).toEqual([
				[personId, IRI],
				[id, PORTAL],
				[creatorId, TITLE],
				[creatorId, PORTAL],
			]);
			expect((await items(id, 'relation', PORTAL)).map((item) => Number(item.section_id))).toEqual([
				creatorId,
			]);
			expect((await items(creatorId, 'string', TITLE)).map((i) => i.value)).toEqual(['Issuer']);
		});

		test('an intermediate whose LEAF is its own component: only the identifier itself completes it', async () => {
			const resource = iriOf('leaf-resource');
			const leafCreator: RdfIntermediateOp = {
				...creator('creator', resource),
				path: [
					{ section_tipo: SECTION, component_tipo: PORTAL, parent: SECTION },
					{ section_tipo: SECTION, component_tipo: IRI, parent: PORTAL },
				],
			};
			const id = await newRecord();
			const other = await run(id, [
				plan(iriOf('coin-leaf'), [
					leafCreator,
					set(ref('creator'), IRI, 'lg-nolan', [{ iri: iriOf('not-the-resource') }]),
				]),
			]);
			expect(other.created).toEqual([]);
			expect(await items(id, 'relation', PORTAL)).toEqual([]);
			const own = plan(iriOf('coin-leaf'), [
				leafCreator,
				set(ref('creator'), IRI, 'lg-nolan', [{ iri: resource }]),
			]);
			const first = await run(id, [own]);
			const creatorId = first.created[0]?.section_id as number;
			expect(first.created).toHaveLength(1);
			expect((await items(creatorId, 'iri', IRI)).map((item) => item.iri)).toEqual([resource]);
			expect((await run(id, [own])).created).toEqual([]);
			expect((await items(id, 'relation', PORTAL)).map((item) => Number(item.section_id))).toEqual([
				creatorId,
			]);
		});

		test('a NESTED intermediate completed by its link: the pending one above it is created first', async () => {
			const person = iriOf('person-nested');
			const id = await newRecord();
			const report = await run(id, [
				plan(iriOf('coin-nested'), [
					creator('outer', person),
					{ ...creator('inner', person), target: ref('outer') },
					term('person', person),
					link(ref('inner'), PORTAL, ref('person')),
				]),
			]);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.skipped).toEqual([]);
			const [personId, outerId, innerId] = report.created.map((entry) => entry.section_id) as [
				number,
				number,
				number,
			];
			const linked = async (from: number) =>
				(await items(from, 'relation', PORTAL)).map((item) => Number(item.section_id));
			expect(await linked(id)).toEqual([outerId]);
			expect(await linked(outerId)).toEqual([innerId]);
			expect(await linked(innerId)).toEqual([personId]);
		});

		test('an intermediate whose path leaf is an HTML text_area is FOUND AGAIN on a rerun', async () => {
			const name = `PERSON & O'Brien ${RUN}`;
			const htmlPath: RdfDdoStep[] = [
				{ section_tipo: SECTION, component_tipo: PORTAL, parent: SECTION },
				{ section_tipo: SECTION, component_tipo: PORTAL, parent: PORTAL },
				{ section_tipo: SECTION, component_tipo: TEXT_AREA, parent: PORTAL },
			];
			const personOp: RdfFindOrCreateOp = {
				...term('person', name),
				match_component_tipo: TEXT_AREA,
				match_model: 'component_text_area',
				match_lang: 'lg-spa',
				match_item: { lang: 'lg-spa', value: textAsParagraph(name) },
			};
			const htmlPlan = plan(iriOf('coin-html-path'), [
				{ ...creator('creator', name), path: htmlPath },
				personOp,
				link(ref('creator'), PORTAL, ref('person')),
			]);
			const id = await newRecord();
			const first = await run(id, [htmlPlan]);
			expect(first.iris[0]?.error).toBeNull();
			expect(first.created).toHaveLength(2);
			const second = await run(id, [htmlPlan]);
			expect(second.created).toEqual([]);
			expect(await items(id, 'relation', PORTAL)).toHaveLength(1);
		});

		test('a term in ANOTHER project is found and linked, never duplicated (v6 skip_projects_filter)', async () => {
			// The importer (CONTROL, project P) cannot list the term (project Q). The
			// match component is one CONTROL may read (test52): only the project differs.
			const name = `Term other project ${RUN}`;
			const byTitle: RdfFindOrCreateOp = {
				...term('term', name),
				match_component_tipo: TITLE,
				match_model: 'component_input_text',
				match_lang: 'lg-eng',
				match_item: { lang: 'lg-eng', value: name },
			};
			const termId = await doorRecord(AUTHZ_PROJECT_Q);
			await seed(termId, TITLE, 'lg-eng', [{ value: name }]);
			const target = { sectionTipo: SECTION, componentTipo: TITLE };
			expect(await findSectionIdByCode(target, name, ids.control)).toBeNull();
			expect(await findSectionIdByCode(target, name, ROOT)).toBe(termId);
			expect(await findTermRecord(byTitle, ids.control)).toBe(termId);
			const id = await doorRecord(AUTHZ_PROJECT_P);
			const rowsBefore = await sectionRowCount();
			const report = await run(
				id,
				[
					plan(iriOf('coin-other-project'), [
						byTitle,
						set(ref('term'), TITLE, 'lg-spa', [{ value: 'out of scope' }]),
					]),
				],
				ids.control,
			);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(await sectionRowCount()).toBe(rowsBefore);
			// The op was bound to THE record (it is what a link would name); its own
			// fields stay behind the record scope.
			expect(report.skipped).toEqual([
				{
					component_tipo: TITLE,
					reason: 'not writable by the importer (perm.out_of_scope)',
					section_tipo: SECTION,
					section_id: termId,
				},
			]);
			expect((await items(termId, 'string', TITLE)).map((item) => item.value)).toEqual([name]);
		});

		test('a term found by an EQUIVALENT is linked across projects; the append into it passes the record scope', async () => {
			// The match component is a literal one (test52): the equivalent is held in
			// lg-eng, the term's own identifier is appended in lg-spa (an empty slice).
			const own = `Term eq own ${RUN}`;
			const equivalent = `Term eq held ${RUN}`;
			const byTitle = (key: string): RdfFindOrCreateOp => ({
				...term(key, own),
				match_component_tipo: TITLE,
				match_model: 'component_input_text',
				match_lang: 'lg-spa',
				match_item: { lang: 'lg-spa', value: own },
				match_equivalents: [equivalent],
			});
			const termId = await doorRecord(AUTHZ_PROJECT_Q);
			await seed(termId, TITLE, 'lg-eng', [{ value: equivalent }]);
			const titles = async () =>
				(await items(termId, 'string', TITLE)).map((item) => [item.lang, item.value]);

			// CONTROL (project P) finds it — the lookup is across projects: the skip
			// names THE record the op was bound to — but may not write into a record
			// outside its projects: a skip, no write. (CONTROL holds no portal grant,
			// so the link half is gated by ROOT below.)
			const id = await doorRecord(AUTHZ_PROJECT_P);
			const refused = await run(id, [plan(iriOf('coin-eq-scope'), [byTitle('term')])], ids.control);
			expect(refused.iris[0]?.error).toBeNull();
			expect(refused.created).toEqual([]);
			expect(refused.skipped).toEqual([
				{
					component_tipo: TITLE,
					reason: 'not writable by the importer (perm.out_of_scope)',
					section_tipo: SECTION,
					section_id: termId,
				},
			]);
			expect(await titles()).toEqual([['lg-eng', equivalent]]);

			// ROOT (in scope) gets the append — the contrast that makes the skip a scope refusal.
			const caller = await newRecord();
			const report = await run(caller, [
				plan(iriOf('coin-eq-root'), [byTitle('term'), link(CALLER, PORTAL, ref('term'))]),
			]);
			expect(report.created).toEqual([]);
			expect(report.skipped).toEqual([]);
			expect(await titles()).toEqual([
				['lg-eng', equivalent],
				['lg-spa', own],
			]);
			expect((await items(caller, 'relation', PORTAL)).map((item) => item.section_id)).toEqual([
				termId,
			]);
		});

		test('the term lookup is the IMPORTER’S: a match component they may not read matches nothing, by its own IRI or an equivalent', async () => {
			// Same project (P), so the projects filter is not what decides: only the
			// importer's read grant on the match component (CONTROL holds none on test140).
			expect(await getPermissions(ids.control, SECTION, SECTION)).toBe(2);
			expect(await getPermissions(ids.control, SECTION, IRI)).toBe(0);
			const ownHolder = await doorRecord(AUTHZ_PROJECT_P);
			await seed(ownHolder, IRI, 'lg-nolan', [{ iri: iriOf('acl-own') }]);
			const eqHolder = await doorRecord(AUTHZ_PROJECT_P);
			await seed(eqHolder, IRI, 'lg-nolan', [{ iri: iriOf('acl-eq') }]);
			const byOwn = term('t', iriOf('acl-own'));
			const byEquivalent = { ...term('t', iriOf('acl-new')), match_equivalents: [iriOf('acl-eq')] };
			// The contrast: an importer who may read it finds both.
			expect(await findTermRecord(byOwn, ROOT)).toBe(ownHolder);
			expect(await findTermRecord(byEquivalent, ROOT)).toBe(eqHolder);
			expect(await findTermRecord(byOwn, ids.control)).toBeNull();
			expect(await findTermRecord(byEquivalent, ids.control)).toBeNull();
		});

		test('a LITERAL match component already holding the language slice: linked, the append refused and reported', async () => {
			const own = `Term eq literal ${RUN}`;
			const equivalent = `Term eq literal held ${RUN}`;
			const termId = await newRecord();
			await seed(termId, TITLE, 'lg-eng', [{ value: equivalent }]);
			const caller = await newRecord();
			const report = await run(caller, [
				plan(iriOf('coin-eq-literal'), [
					{
						...term('term', own),
						match_component_tipo: TITLE,
						match_model: 'component_input_text',
						match_lang: 'lg-eng',
						match_item: { lang: 'lg-eng', value: own },
						match_equivalents: [equivalent],
					},
					link(CALLER, PORTAL, ref('term')),
				]),
			]);
			expect(report.created).toEqual([]);
			expect(report.skipped).toEqual([
				{
					component_tipo: TITLE,
					reason: 'not empty in lg-eng — never overwritten',
					section_tipo: SECTION,
					section_id: termId,
				},
			]);
			expect((await items(caller, 'relation', PORTAL)).map((item) => item.section_id)).toEqual([
				termId,
			]);
			expect((await items(termId, 'string', TITLE)).map((item) => item.value)).toEqual([
				equivalent,
			]);
		});

		test('an INTERMEDIATE is created only through ITS section’s create door, not only the caller’s link', async () => {
			expect(await getPermissions(ids.control, SECTION, FILTER)).toBe(2);
			expect(await getPermissions(ids.control, 'dd153', 'dd153')).toBeLessThan(2);
			const id = await doorRecord(AUTHZ_PROJECT_P);
			const filterBefore = await items(id, 'relation', FILTER);
			const projectsBefore = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_projects WHERE section_tipo = 'dd153'`,
			)) as { n: number }[];
			const intermediate: RdfIntermediateOp = {
				...creator('project', iriOf('project-person')),
				component_tipo: FILTER,
				intermediate_section_tipo: 'dd153',
				path: [{ section_tipo: 'dd153', component_tipo: 'dd156', parent: FILTER }],
			};
			const report = await run(id, [plan(iriOf('coin-inter'), [intermediate])], ids.control);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(reasons(report)).toEqual([
				expect.stringMatching(/^not created: refused \(perm\.[a-z_]+\)$/),
			]);
			expect(await items(id, 'relation', FILTER)).toEqual(filterBefore);
			const projectsAfter = (await sql.unsafe(
				`SELECT count(*)::int AS n FROM matrix_projects WHERE section_tipo = 'dd153'`,
			)) as { n: number }[];
			expect(projectsAfter[0]?.n).toBe(projectsBefore[0]?.n as number);
		});

		test('a FOUND intermediate is an EXISTING record: a write into it passes the record scope', async () => {
			// The caller is in the importer's project; the intermediate it already links is NOT.
			const person = iriOf('person-scope');
			const personId = await newRecord();
			await seed(personId, IRI, 'lg-nolan', [{ iri: person }]);
			const outside = await doorRecord(AUTHZ_PROJECT_Q);
			await seed(outside, PORTAL, 'lg-nolan', [locatorOf(personId)]);
			const id = await doorRecord(AUTHZ_PROJECT_P);
			await seed(id, PORTAL, 'lg-nolan', [locatorOf(outside)]);
			const report = await run(
				id,
				[
					plan(iriOf('coin-scope'), [
						creator('creator', person),
						set(ref('creator'), TITLE, 'lg-eng', [{ value: 'Out of scope' }]),
					]),
				],
				ids.control,
			);
			expect(report.iris[0]?.error).toBeNull();
			expect(report.created).toEqual([]);
			expect(report.written).toEqual([]);
			expect(report.skipped).toEqual([
				{
					component_tipo: TITLE,
					reason: 'not writable by the importer (perm.out_of_scope)',
					section_tipo: SECTION,
					section_id: outside,
				},
			]);
			expect(await items(outside, 'string', TITLE)).toEqual([]);
		});

		test('a save the engine answers ok:false rolls its IRI back as record.save_failed — never reported written', async () => {
			// A consultation-only section (Activity): the write door admits root, the
			// save door refuses every save with ok:false. The record is this file's own
			// activity row (the one its newRecord() birth logged).
			const id = await newRecord();
			const activity = (await sql.unsafe(
				`SELECT section_id FROM matrix_activity WHERE section_tipo = 'dd542'
				   AND string->'dd546'->0->>'value' = $1 AND misc->'dd551'->0->'value'->>'section_id' = $2`,
				[SECTION, String(id)],
			)) as { section_id: number }[];
			const activityId = Number(activity[0]?.section_id);
			expect(activityId).toBeGreaterThan(0);
			const before = await readMatrixRecord('matrix_activity', 'dd542', activityId);
			const rowsBefore = await sectionRowCount();
			const bulkBefore = await bulkFootprint();
			const report = await executeRdfImport({
				caller: { section_tipo: 'dd542', section_id: activityId },
				plans: [
					plan(iriOf('consult'), [
						// Created (and the run's dd800 minted) BEFORE the fault: both roll back.
						term('faulted', iriOf('faulted')),
						set(CALLER, 'dd550', 'lg-nolan', [
							{
								type: 'dd151',
								section_tipo: 'dd153',
								section_id: AUTHZ_PROJECT_P,
								from_component_tipo: 'dd550',
							},
						]),
					]),
				],
				principal: ROOT,
				bulkLabel: 'rdf_import_execute_native',
			});
			if (report.bulk_process_id !== null) bulkIds.add(report.bulk_process_id);
			const failure = report.iris[0]?.failure;
			expect(isDedaloError(failure) && failure.code).toBe('record.save_failed');
			expect(report.iris[0]?.error).toContain('refused');
			expect([report.written, report.created, report.skipped]).toEqual([[], [], []]);
			expect(await readMatrixRecord('matrix_activity', 'dd542', activityId)).toEqual(before);
			// An internal fault is NOT a per-op refusal: the term created before it is gone,
			// and so is the dd800 its creation minted.
			expect(await sectionRowCount()).toBe(rowsBefore);
			expect(
				await findSectionIdByCode(
					{ sectionTipo: SECTION, componentTipo: IRI },
					iriOf('faulted'),
					ROOT,
				),
			).toBeNull();
			expect(report.bulk_process_id).toBeNull();
			expect(await bulkFootprint()).toBe(bulkBefore);
		});

		test('withSavepoint: a throw undoes what its work wrote, the transaction goes on and commits the rest', async () => {
			const rowsBefore = await sectionRowCount();
			let kept = 0;
			let undone = 0;
			await withTransaction(async () => {
				kept = await createSectionRecord(SECTION, -1);
				const refused = withSavepoint(async () => {
					undone = await createSectionRecord(SECTION, -1);
					throw new DedaloError('perm.denied', { message: 'savepoint probe' });
				});
				await expect(refused).rejects.toThrow('savepoint probe');
				// The transaction is usable after the rollback to the savepoint.
				expect(await withSavepoint(async () => 7)).toBe(7);
			});
			records.add(kept);
			records.add(undone);
			expect(undone).toBeGreaterThan(0);
			expect(await readMatrixRecord(TABLE, SECTION, undone)).toBeNull();
			expect(await readMatrixRecord(TABLE, SECTION, kept)).not.toBeNull();
			expect(await sectionRowCount()).toBe(rowsBefore + 1);
			await expect(withSavepoint(async () => 1)).rejects.toThrow('outside a transaction');
		});

		test('a run with nothing to apply mints no dd800', async () => {
			const id = await newRecord();
			const report = await run(id, [plan(iriOf('empty'), [])]);
			expect(report.bulk_process_id).toBeNull();
			expect(report.iris).toEqual([
				{ iri: iriOf('empty'), written: [], created: [], skipped: [], error: null },
			]);
		});
	},
);
