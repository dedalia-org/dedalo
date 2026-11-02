/**
 * RECONCILE REGISTRY — the behavioural gate (audit 2026-08-26 S-10).
 *
 * The census tripwire (reconcile_registry_tripwire.test.ts) proves every
 * two-store reconcile is REGISTERED. This gate proves each registered
 * definition actually MEASURES its pair through the registry door: on a
 * situation this file builds and owns, a dry run reports drift 0; after this
 * file PLANTS one disagreement between the two stores, a dry run reports
 * drift > 0, a second dry run reports the same (a dry run writes nothing), and
 * the `reconcile` ops gauge carries that verdict. One planter per registered
 * name — PLANTERS' keys must equal the live registry, so a definition cannot
 * be registered without its behavioural proof.
 *
 * Nothing here changes what a reconcile computes: every leg goes through
 * `runReconcile(name, {apply:false, scope})` — the same call the widget, the
 * CLI and the scheduler make.
 *
 * THE SITUATIONS (suite database + suite media root only; torn down):
 *   - `zzrc` TLD: zzrc1 section (matrix_test) + zzrc2 component_image — the
 *     files_info and counters↔media pairs; zzrc3 section + zzrc4 section_map
 *     with a `rag.embed` group + zzrc5 text — the RAG presence pair.
 *   - `zzro` TLD: two ontology source records projected by rebuildOntology.
 *   - `zzrh` TLD: one hierarchy1 registry row provisioned by ensureHierarchy.
 *   - the shared `zzot` observer situation (test/helpers/observer_term_seed.ts).
 *   - the suite media root's `.publication/pub` marker store, and its
 *     `.publication/dbs` ground truth (the public_tier pair, scoped to zzrc1).
 *   - `zzrg` TLD (its OWN — `zzri` belongs to relation_index_store, and the
 *     sweep below is TLD-wide): one dd_ontology row whose parent is not a tipo, planted the
 *     way a legacy install carries it (the parent CHECK re-added NOT VALID);
 *     the ontology_identifiers pair (SURF-1). Swept, the CHECK re-VALIDATEd.
 *   - zzrc8 section (matrix_test) hosting zzrc7, a component_portal over zzrc8
 *     itself that DECLARES `order: asc` on zzrc9 (its component_input_text) —
 *     the portal_declared_order pair (stored array vs declared order).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	deleteRecord as deleteRagRecord,
	ragSql,
	upsertEmbeddingRows,
} from '../../src/ai/rag/vector_store.ts';
import { config } from '../../src/config/config.ts';
import { privateDir } from '../../src/config/env.ts';
import { widget as reconcileStatusWidget } from '../../src/core/area_maintenance/widgets/reconcile_status.ts';
import {
	ddOntologyConstraintStates,
	deleteTldNodes,
	upsertDdOntologyNode,
	validateDdOntologyIdentifierConstraints,
} from '../../src/core/db/dd_ontology.ts';
import { insertMatrixRecordWithCounter } from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { getPublicQualities } from '../../src/core/media/protection.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { ensureHierarchy } from '../../src/core/ontology/hierarchy_state.ts';
import { deleteOntologyByTld } from '../../src/core/ontology/ontology_delete.ts';
import { rebuildOntology } from '../../src/core/ontology/ontology_state.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { registryPath, updateRegistry } from '../../src/core/publication_host/registry.ts';
import { registerAllReconciles } from '../../src/core/reconcile/catalog.ts';
import {
	lastReconcileRun,
	listReconciles,
	REGISTERED_NAMES,
	type ReconcileReport,
	reconcileGauge,
	runReconcile,
} from '../../src/core/reconcile/registry.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { type Principal, SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	type CopyMockAgent,
	startCopyMockAgent,
	unregisterCopyMockHost,
	useScratchMediaCopyStores,
} from '../helpers/media_copy_mock_agent.ts';
import {
	dropObserverTerm,
	ensureObserverTerm,
	INDEXER,
	REF_SECTION,
	SEED_TERM,
	TERM_SECTION,
} from '../helpers/observer_term_seed.ts';
import { cleanScratchTipo } from '../helpers/test_data.ts';

/* ------------------------------------------------------------ situations */

const TLD = 'zzrc';
const MEDIA_SECTION = `${TLD}1`;
const IMAGE = `${TLD}2`;
/** zzrc1's component_text_area — the rich_text_images pair (zzrc5 feeds the RAG pair). */
const TEXT = `${TLD}6`;
/** A zzrc1 record id the rich-text planters own (raw-planted, deleted by id). */
const TEXT_RECORD_ID = 990061;
const RAG_SECTION = `${TLD}3`;
const RAG_MAP = `${TLD}4`;
const RAG_TEXT = `${TLD}5`;
const TABLE = 'matrix_test';
/** portal_declared_order: host section, its declared-order portal, the ordered column. */
const ORDER_HOST = `${TLD}8`;
const ORDER_PORTAL = `${TLD}7`;
const ORDER_COLUMN = `${TLD}9`;
/** dd_ontology node of model 'matrix_table' whose term is `matrix_test`. */
const MATRIX_TEST_RELATION = 'test24';

const ONTO_TLD = 'zzro';
const ONTO_SECTION = `${ONTO_TLD}0`;

/** A grammar violator: a valid tipo whose PARENT is not a tipo (SURF-1 legacy shape). */
const GRAMMAR_VIOLATOR = { tipo: 'zzrg1', tld: 'zzrg', parent: "zzrg0'" };
const PARENT_GRAMMAR = 'dd_ontology_parent_grammar';

const HIER_TLD = 'zzrh';
const HIER_SECTION = 'hierarchy1';
const HIER_TABLE = 'matrix_hierarchy_main';
const HIER_ID = 900031;
const USER_ID = -1;

const RAG_MODEL = `zzrcmodel${process.pid}`;
/** The scratch publication host the publication_apis planter pairs (never dialled). */
const PUBHOST = 'zzrc_pubhost';
/**
 * The publication-host stores this file reads and writes: ONE declared scratch base for
 * the WHOLE file (armed in beforeAll) — registry, secrets, runtime, plus the media-copy
 * sha cache — so the clean publication_apis / media_copy dry runs never read — nor dial —
 * the installation's paired hosts in `<private>/publication_hosts.json`.
 */
let pubhostBase: { base: string; dispose: () => void } | null = null;
/** The scratch copy host the media_copy planter starts (a stateful loopback mock agent). */
const COPY_HOST = 'zzrc_copy';
/** publication_probe's planted host (phase 6): a configured, unprovable gate. */
const PROBE_HOST = 'zzrc_probe';
let copyAgent: CopyMockAgent | null = null;

/** Scratch files planted in the SUITE media root, removed by path. */
const planted: string[] = [];
let OBSERVER_REF_TABLE = TABLE;
/** The observer scratch referencer this file inserts (its own id, swept). */
const OBSERVER_REFERENCER_ID = 91091;

function mediaRoot(): string {
	const root = config.media.rootPath;
	if (root === null) throw new Error('suite media root not configured');
	return root;
}

async function seedOntologyRecord(sectionId: number, term: string): Promise<void> {
	await sql.unsafe(
		`INSERT INTO matrix_ontology (section_id, section_tipo, string)
		 VALUES ($1, $2, $3::text::jsonb)`,
		[
			sectionId,
			ONTO_SECTION,
			JSON.stringify({
				ontology7: [{ id: 1, lang: 'lg-spa', value: ONTO_TLD }],
				ontology5: [{ id: 1, lang: 'lg-eng', value: term }],
			}),
		],
	);
}

async function sweepOntologySituation(): Promise<void> {
	await deleteTldNodes(ONTO_TLD);
	await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1', [ONTO_SECTION]);
	await sql.unsafe(
		`DELETE FROM matrix_ontology_main WHERE section_tipo = 'ontology35' AND string @> $1::text::jsonb`,
		[JSON.stringify({ hierarchy6: [{ value: ONTO_TLD }] })],
	);
	await clearOntologyDerivedCaches();
}

async function seedHierarchyRegistry(): Promise<void> {
	await sql.unsafe(
		`INSERT INTO "${HIER_TABLE}" (section_id, section_tipo, string, relation)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
		[
			HIER_ID,
			HIER_SECTION,
			JSON.stringify({
				hierarchy5: [{ id: 1, lang: 'lg-eng', value: 'ZZRH reconcile scratch' }],
				hierarchy6: [{ id: 1, lang: 'lg-nolan', value: HIER_TLD.toUpperCase() }],
			}),
			JSON.stringify({
				hierarchy9: [
					{
						id: 1,
						type: 'dd151',
						section_id: '2',
						section_tipo: 'hierarchy13',
						from_component_tipo: 'hierarchy9',
					},
				],
			}),
		],
	);
	await clearOntologyDerivedCaches();
}

async function sweepHierarchySituation(): Promise<void> {
	await deleteOntologyByTld(HIER_TLD, (st, sid) => deleteSectionRecord(st, sid, USER_ID));
	await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [HIER_TLD]);
	await sql.unsafe(`DELETE FROM "${HIER_TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
		HIER_SECTION,
		HIER_ID,
	]);
	await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo IN ($1, $2)', [
		`${HIER_TLD}1`,
		`${HIER_TLD}2`,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_time_machine WHERE section_tipo IN ($1, $2, $3)
		   OR (section_tipo = $4 AND section_id = $5)`,
		[`${HIER_TLD}0`, `${HIER_TLD}1`, `${HIER_TLD}2`, HIER_SECTION, HIER_ID],
	);
	await clearOntologyDerivedCaches();
}

async function sweepMediaSituation(): Promise<void> {
	await cleanScratchTipo(MEDIA_SECTION, TABLE);
	await cleanScratchTipo(RAG_SECTION, TABLE);
	await cleanScratchTipo(ORDER_HOST, TABLE);
	await deleteTldNodes(TLD);
	await clearOntologyDerivedCaches();
	for (const path of planted.splice(0)) rmSync(path, { force: true });
}

async function sweepObserverScratch(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM "${OBSERVER_REF_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[REF_SECTION, OBSERVER_REFERENCER_ID],
	);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		REF_SECTION,
		OBSERVER_REFERENCER_ID,
	]);
}

beforeAll(async () => {
	pubhostBase = useScratchMediaCopyStores();
	await registerAllReconciles();
	// The situation is BUILT, not inherited: a freshly rebuilt suite media root
	// (`bun run test:db:setup`) holds only its marker, and files_info's sweep
	// refuses a root without the `image/original` tier as "the wrong tree".
	mkdirSync(join(mediaRoot(), 'image', 'original'), { recursive: true });
	await sweepMediaSituation();
	await sweepOntologySituation();
	await sweepHierarchySituation();

	// zzrc: the media pair + the RAG pair.
	await upsertDdOntologyNode({
		tipo: MEDIA_SECTION,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'Reconcile media scratch section' },
		properties: {},
		relations: [{ tipo: MATRIX_TEST_RELATION }],
	});
	await upsertDdOntologyNode({
		tipo: IMAGE,
		parent: MEDIA_SECTION,
		model: 'component_image',
		tld: TLD,
		term: { 'lg-eng': 'Image' },
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: TEXT,
		parent: MEDIA_SECTION,
		model: 'component_text_area',
		tld: TLD,
		term: { 'lg-eng': 'Text' },
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: RAG_SECTION,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'Reconcile RAG scratch section' },
		properties: {},
		relations: [{ tipo: MATRIX_TEST_RELATION }],
	});
	await upsertDdOntologyNode({
		tipo: RAG_TEXT,
		parent: RAG_SECTION,
		model: 'component_text_area',
		tld: TLD,
		term: { 'lg-eng': 'Body' },
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: RAG_MAP,
		parent: RAG_SECTION,
		model: 'section_map',
		tld: TLD,
		term: { 'lg-eng': 'Section map' },
		properties: {
			rag: {
				embed: [{ id: 'body', ddo_map: [{ tipo: RAG_TEXT, section_tipo: 'self', mode: 'list' }] }],
			},
		},
	});
	// zzrc8/zzrc7: the declared-order portal pair (no holder yet → in sync).
	await upsertDdOntologyNode({
		tipo: ORDER_HOST,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'Reconcile declared-order host section' },
		properties: {},
		relations: [{ tipo: MATRIX_TEST_RELATION }],
	});
	await upsertDdOntologyNode({
		tipo: ORDER_COLUMN,
		parent: ORDER_HOST,
		model: 'component_input_text',
		tld: TLD,
		term: { 'lg-eng': 'Name' },
		is_translatable: true,
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: ORDER_PORTAL,
		parent: ORDER_HOST,
		model: 'component_portal',
		tld: TLD,
		term: { 'lg-eng': 'Ordered portal' },
		properties: {
			source: {
				request_config: [
					{
						sqo: { section_tipo: [{ value: [ORDER_HOST], source: 'section' }] },
						show: {
							ddo_map: [{ tipo: ORDER_COLUMN, parent: 'self', section_tipo: 'self', order: 'asc' }],
						},
					},
				],
			},
		},
	});
	await clearOntologyDerivedCaches();

	// zzro: two source records, projected once → in sync.
	await seedOntologyRecord(1, 'First');
	await seedOntologyRecord(2, 'Second');
	await clearOntologyDerivedCaches();
	const projected = await rebuildOntology(ONTO_TLD, USER_ID);
	expect(projected.state.inSync).toBe(true);

	// zzrh: a registry row, provisioned once → usable.
	await seedHierarchyRegistry();
	const ensured = await ensureHierarchy(HIER_ID, USER_ID);
	expect(ensured.state.usable).toBe(true);

	// zzot: the shared observer situation, converged by ONE apply through the
	// registry so the clean baseline is this file's own, not another gate's residue.
	await ensureObserverTerm();
	OBSERVER_REF_TABLE = (await getMatrixTableFromTipo(REF_SECTION)) ?? TABLE;
	await sweepObserverScratch();
	await runReconcile('observer_mirrors', { apply: true, scope: [TERM_SECTION] });
}, 120000);

afterAll(async () => {
	pubhostBase?.dispose();
	pubhostBase = null;
	await sweepObserverScratch();
	await dropObserverTerm();
	await deleteRagRecord({ sectionTipo: RAG_SECTION, sectionId: 7 }).catch(() => {});
	await ragSql.unsafe(`DROP TABLE IF EXISTS "rag_embeddings_${RAG_MODEL}"`).catch(() => {});
	await sweepMediaSituation();
	await sweepOntologySituation();
	await sweepHierarchySituation();
	rmSync(join(mediaRoot(), '.publication', 'pub', `${MEDIA_SECTION}_999999`), { force: true });
	rmSync(join(mediaRoot(), '.publication', 'dbs', 'zzrc_ghost_db'), {
		recursive: true,
		force: true,
	});
}, 120000);

/* --------------------------------------------------------------- planters */

interface Planter {
	scope?: string[];
	/** Put the two stores in disagreement; return the expected drift (> 0). */
	plant(): Promise<number>;
	/** Undo the plant (the dry runs must not have). */
	unplant(): Promise<void>;
}

/** One planter PER REGISTERED NAME — the keys are asserted against the registry. */
const PLANTERS: Record<string, Planter> = {
	counters_media: {
		async plant() {
			// A file naming an id the allocator has never minted: counter + 5.
			const rows = (await sql`SELECT value FROM matrix_counter WHERE tipo = ${MEDIA_SECTION}`) as {
				value: number;
			}[];
			const orphanId = Number(rows[0]?.value ?? 0) + 5;
			const dir = join(mediaRoot(), 'zz_reconcile_scratch');
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${IMAGE}_${MEDIA_SECTION}_${orphanId}.jpg`);
			writeFileSync(file, 'not really an image');
			planted.push(file);
			return 1;
		},
		async unplant() {
			for (const path of planted.splice(0)) rmSync(path, { force: true });
			rmSync(join(mediaRoot(), 'zz_reconcile_scratch'), { recursive: true, force: true });
		},
	},
	files_info: {
		scope: [MEDIA_SECTION],
		async plant() {
			// A record whose stored index says "no files" while the original is on disk.
			const sectionId = await insertMatrixRecordWithCounter(TABLE, MEDIA_SECTION, {
				media: { [IMAGE]: [{ id: 1, files_info: [] }] },
			});
			const { spec, identity, pathOpts } = await resolveMediaToolContext({
				tipo: IMAGE,
				section_tipo: MEDIA_SECTION,
				section_id: sectionId,
			});
			const location = buildMediaLocation(
				spec,
				identity,
				spec.originalQuality,
				spec.defaultExtension,
				pathOpts,
			);
			mkdirSync(dirname(location.absolutePath), { recursive: true });
			if (existsSync(location.absolutePath)) {
				throw new Error(`refusing to overwrite an existing media file: ${location.absolutePath}`);
			}
			writeFileSync(location.absolutePath, 'scratch');
			planted.push(location.absolutePath);
			return 1;
		},
		async unplant() {
			for (const path of planted.splice(0)) rmSync(path, { force: true });
			await cleanScratchTipo(MEDIA_SECTION, TABLE);
		},
	},
	observer_mirrors: {
		scope: [TERM_SECTION],
		async plant() {
			// The bypass write the sweep heals: a raw referencer INSERT the cascade never saw.
			await sql.unsafe(
				`INSERT INTO "${OBSERVER_REF_TABLE}" (section_id, section_tipo, relation) VALUES ($1, $3, $2::text::jsonb)`,
				[
					OBSERVER_REFERENCER_ID,
					JSON.stringify({
						[INDEXER]: [
							{
								id: 1,
								type: 'dd96',
								section_id: String(SEED_TERM.section_id),
								section_tipo: SEED_TERM.section_tipo,
								from_component_tipo: INDEXER,
							},
						],
					}),
					REF_SECTION,
				],
			);
			return 1;
		},
		async unplant() {
			await sweepObserverScratch();
		},
	},
	rich_text_images: {
		scope: [MEDIA_SECTION],
		async plant() {
			// A pre-TODO-066 text: its image keeps the original name, so rule B can never serve it.
			const webDir = join(mediaRoot(), 'image', 'web');
			mkdirSync(webDir, { recursive: true });
			const file = join(webDir, 'zzrc_legacy.jpg');
			writeFileSync(file, 'jpg');
			planted.push(file);
			await sql.unsafe(
				`INSERT INTO "${TABLE}" (section_id, section_tipo, string) VALUES ($1, $2, $3::text::jsonb)`,
				[
					TEXT_RECORD_ID,
					MEDIA_SECTION,
					JSON.stringify({
						[TEXT]: [
							{
								id: 1,
								lang: 'lg-eng',
								value: '<p><img src="/dedalo/media/image/web/zzrc_legacy.jpg"></p>',
							},
						],
					}),
				],
			);
			return 1;
		},
		async unplant() {
			await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
				MEDIA_SECTION,
				TEXT_RECORD_ID,
			]);
			for (const path of planted.splice(0)) rmSync(path, { force: true });
		},
	},
	web_image_exposure: {
		async plant() {
			// An old web-folder file whose name parses to a PUBLISHED record that does not embed it.
			const webDir = join(mediaRoot(), 'image', 'web');
			const pubDir = join(mediaRoot(), '.publication', 'pub');
			mkdirSync(webDir, { recursive: true });
			mkdirSync(pubDir, { recursive: true });
			const file = join(webDir, `zzrc_exposed_${MEDIA_SECTION}_${TEXT_RECORD_ID}.jpg`);
			const marker = join(pubDir, `${MEDIA_SECTION}_${TEXT_RECORD_ID}`);
			writeFileSync(file, 'jpg');
			writeFileSync(marker, '');
			const old = new Date(Date.now() - 3 * 24 * 3_600_000); // past the 24 h grace
			utimesSync(file, old, old);
			planted.push(file, marker);
			return 1;
		},
		async unplant() {
			for (const path of planted.splice(0)) rmSync(path, { force: true });
		},
	},
	media_index: {
		async plant() {
			// A pub/ marker no dbs/ truth owns — a crash between unpublish and marker unlink.
			const pubDir = join(mediaRoot(), '.publication', 'pub');
			mkdirSync(pubDir, { recursive: true });
			const stray = join(pubDir, `${MEDIA_SECTION}_999999`);
			writeFileSync(stray, '');
			planted.push(stray);
			return 1;
		},
		async unplant() {
			for (const path of planted.splice(0)) rmSync(path, { force: true });
		},
	},
	rag_index: {
		scope: [RAG_SECTION],
		async plant() {
			// An orphan vector: a record the matrix does not hold (a delete that never reached the store).
			await upsertEmbeddingRows([
				{
					sectionTipo: RAG_SECTION,
					sectionId: 7,
					componentTipo: RAG_TEXT,
					lang: 'lg-eng',
					chunkIndex: 0,
					provider: 'deterministic-test',
					model: RAG_MODEL,
					dimension: 4,
					embedding: [1, 0, 0, 0],
					sourceHash: 'orphan',
					sourceText: 'orphan vector',
					tokenCount: 2,
					parentKey: null,
					chunkMeta: null,
				},
			]);
			return 1;
		},
		async unplant() {
			await deleteRagRecord({ sectionTipo: RAG_SECTION, sectionId: 7 });
		},
	},
	ontology: {
		scope: [ONTO_TLD],
		async plant() {
			// A projected node no source record produces (the record was deleted).
			await upsertDdOntologyNode({
				tipo: `${ONTO_TLD}9`,
				parent: null,
				term: { 'lg-eng': 'ghost' },
				model: 'section',
				tld: ONTO_TLD,
				properties: null,
			});
			await clearOntologyDerivedCaches();
			return 1;
		},
		async unplant() {
			await sql.unsafe('DELETE FROM dd_ontology WHERE tipo = $1', [`${ONTO_TLD}9`]);
			await clearOntologyDerivedCaches();
		},
	},
	ontology_identifiers: {
		async plant() {
			// The shape a legacy install carries after migration 0013: a row that
			// breaks the parent rule, under a NOT VALID parent CHECK. One
			// transaction (drop → insert → re-add NOT VALID), so the table is never
			// without the CHECK; the definition is the live one, re-added verbatim.
			await assertTestDatabase('reconcile_registry_native ontology_identifiers');
			await withTransaction(async () => {
				const [row] = (await sql.unsafe(
					`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
					  WHERE conrelid = 'dd_ontology'::regclass AND conname = $1`,
					[PARENT_GRAMMAR],
				)) as { def: string }[];
				if (row === undefined) throw new Error(`${PARENT_GRAMMAR} is absent`);
				const definition = row.def.replace(/\s+NOT VALID$/, '');
				await sql.unsafe(`ALTER TABLE dd_ontology DROP CONSTRAINT "${PARENT_GRAMMAR}"`);
				await sql.unsafe(
					`INSERT INTO dd_ontology (tipo, parent, term, model, order_number, tld, is_model, is_translatable, is_main)
					 VALUES ($1, $2, $3::text::jsonb, 'component_input_text', 1, $4, false, true, false)`,
					[
						GRAMMAR_VIOLATOR.tipo,
						GRAMMAR_VIOLATOR.parent,
						JSON.stringify({ 'lg-eng': 'zzrg violator' }),
						GRAMMAR_VIOLATOR.tld,
					],
				);
				await sql.unsafe(
					`ALTER TABLE dd_ontology ADD CONSTRAINT "${PARENT_GRAMMAR}" ${definition} NOT VALID`,
				);
			});
			expect((await ddOntologyConstraintStates())[PARENT_GRAMMAR]).toBe('not_valid');
			await clearOntologyDerivedCaches();
			return 1;
		},
		async unplant() {
			await sql.unsafe('DELETE FROM dd_ontology WHERE tld = $1', [GRAMMAR_VIOLATOR.tld]);
			await clearOntologyDerivedCaches();
			// Leave the table as the clean suite database has it: every CHECK VALID.
			const outcome = await validateDdOntologyIdentifierConstraints();
			expect(outcome.blocked).toEqual([]);
			expect(outcome.states[PARENT_GRAMMAR]).toBe('valid');
		},
	},
	public_tier: {
		scope: [MEDIA_SECTION],
		async plant() {
			// A dbs/ publication marker for a record the matrix never held — the
			// public tier granting anonymous media access to a ghost (LIFE-02 shape:
			// a restore, or an unpublish that never settled). The scan reads the
			// store's ground-truth dirs directly, whatever the ontology's targets are
			// today, so the marker's db/table need not exist anywhere else.
			const tableDir = join(
				mediaRoot(),
				'.publication',
				'dbs',
				'zzrc_ghost_db',
				'zzrc_ghost_table',
			);
			mkdirSync(tableDir, { recursive: true });
			const ghost = join(tableDir, `${MEDIA_SECTION}_999997`);
			writeFileSync(ghost, '');
			planted.push(ghost);
			return 1;
		},
		async unplant() {
			for (const path of planted.splice(0)) rmSync(path, { force: true });
			rmSync(join(mediaRoot(), '.publication', 'dbs', 'zzrc_ghost_db'), {
				recursive: true,
				force: true,
			});
		},
	},
	publication_apis: {
		async plant() {
			// A paired host whose lockstep the running tree cannot prove. The suite runs a
			// dev checkout (no install stamp → no verified release, refused before any hash),
			// so both APIs count as drift WITHOUT dialling the socket; an installed tree
			// would instead fail both on the unreachable socket — 2 either way. The
			// registry must be the test-isolated one, never the installation's.
			expect(registryPath()).not.toBe(join(privateDir, 'publication_hosts.json'));
			expect(registryPath().startsWith(pubhostBase?.base ?? '<unarmed>')).toBe(true);
			updateRegistry((current) => ({
				...current,
				hosts: [
					...current.hosts,
					{
						name: PUBHOST,
						instance: 'test',
						fingerprint: '0'.repeat(64),
						address: { kind: 'unix', socket: `/nonexistent/${PUBHOST}.sock` },
						public_url: null,
						qualities: null,
						probe: { published: null, unpublished: null },
						paired_at: '2026-10-03T00:00:00.000Z',
					},
				],
			}));
			return 2;
		},
		async unplant() {
			updateRegistry((current) => ({
				...current,
				hosts: current.hosts.filter((host) => host.name !== PUBHOST),
			}));
		},
	},
	media_copy: {
		async plant() {
			// A copy-mode host still holding a file (and its mirrored marker) the work host
			// does not publish — an unpublish whose deletion never reached the agent: one
			// deletion + one marker withdrawal (any file the suite media root publishes is a
			// planned put on top).
			const quality = getPublicQualities()[0] as string;
			copyAgent = await startCopyMockAgent(COPY_HOST, 'copy', {
				entries: {
					[`${quality}/0/${IMAGE}_${MEDIA_SECTION}_999995.jpg`]: {
						size: 1,
						sha256: '0'.repeat(64),
					},
				},
				markers: [`${MEDIA_SECTION}_999995`],
			});
			return 2;
		},
		async unplant() {
			await copyAgent?.stop();
			await unregisterCopyMockHost(COPY_HOST);
			copyAgent = null;
		},
	},
	publication_probe: {
		scope: [PROBE_HOST],
		async plant() {
			// A configured host whose gate cannot be proven: its probe paths name a quality
			// that is not public, and its public URL is a private literal — the probe is
			// `unknown` before any request leaves (validation, then the public door's
			// address check), so drift 1. The per-name test runs DRY: nothing is written
			// to the runtime file. Other planters' hosts are preserved.
			expect(registryPath().startsWith(pubhostBase?.base ?? '<unarmed>')).toBe(true);
			updateRegistry((current) => ({
				...current,
				hosts: [
					...current.hosts.filter((host) => host.name !== PROBE_HOST),
					{
						name: PROBE_HOST,
						instance: 'test',
						fingerprint: 'b'.repeat(64),
						address: { kind: 'unix', socket: `/nonexistent/${PROBE_HOST}.sock` },
						public_url: 'https://127.0.0.1',
						qualities: null,
						probe: { published: 'image/zz/a_test3_1.jpg', unpublished: 'image/zz/a_test3_2.jpg' },
						paired_at: '2026-10-03T00:00:00.000Z',
					},
				],
			}));
			return 1;
		},
		async unplant() {
			updateRegistry((current) => ({
				...current,
				hosts: current.hosts.filter((host) => host.name !== PROBE_HOST),
			}));
		},
	},
	portal_declared_order: {
		scope: [ORDER_PORTAL],
		async plant() {
			// An array stored BEFORE its declared order (or written raw): Bravo before Alpha.
			const name = (value: string) => ({
				string: {
					[ORDER_COLUMN]: [{ id: 1, lang: config.menu.dataLang, value }],
				},
			});
			const bravo = await insertMatrixRecordWithCounter(TABLE, ORDER_HOST, name('Bravo'));
			const alpha = await insertMatrixRecordWithCounter(TABLE, ORDER_HOST, name('Alpha'));
			const holder = await insertMatrixRecordWithCounter(TABLE, ORDER_HOST, {});
			const locator = (sectionId: number, id: number) => ({
				id,
				type: 'dd151',
				section_id: sectionId,
				section_tipo: ORDER_HOST,
				from_component_tipo: ORDER_PORTAL,
			});
			// Raw, below the record-write chokepoint (which would sort it at write time).
			await sql.unsafe(
				`UPDATE "${TABLE}" SET relation = $3::text::jsonb WHERE section_tipo = $1 AND section_id = $2`,
				[
					ORDER_HOST,
					holder,
					JSON.stringify({ [ORDER_PORTAL]: [locator(bravo, 1), locator(alpha, 2)] }),
				],
			);
			return 1;
		},
		async unplant() {
			await cleanScratchTipo(ORDER_HOST, TABLE);
		},
	},
	hierarchy: {
		scope: [String(HIER_ID)],
		async plant() {
			// The provisioned root term vanishes: the ACTIVE registry row now dangles.
			await sql.unsafe('DELETE FROM matrix_hierarchy WHERE section_tipo = $1', [`${HIER_TLD}1`]);
			await clearOntologyDerivedCaches();
			return 1;
		},
		async unplant() {
			// Re-provision through the single writer; the registry row is the same.
			const ensured = await ensureHierarchy(HIER_ID, USER_ID);
			expect(ensured.state.usable).toBe(true);
		},
	},
};

async function dry(name: string): Promise<ReconcileReport> {
	const planter = PLANTERS[name] as Planter;
	const { report } = await runReconcile(name, {
		apply: false,
		...(planter.scope === undefined ? {} : { scope: planter.scope }),
	});
	return report;
}

/* ------------------------------------------------------------------ gates */

describe('reconcile registry — every definition measures its pair (S-10)', () => {
	test('PLANTERS cover the live registry exactly (a definition without its proof is red)', () => {
		expect(Object.keys(PLANTERS).sort()).toEqual([...REGISTERED_NAMES].sort());
		expect(REGISTERED_NAMES.length).toBeGreaterThanOrEqual(6);
	});

	for (const name of REGISTERED_NAMES) {
		test(`${name}: dry 0 on the clean situation, > 0 once drift is planted, byte-equal twice, gauge agrees`, async () => {
			const planter = PLANTERS[name] as Planter;
			const clean = await dry(name);
			expect(
				clean.drift,
				`${name}: the clean situation drifts: ${JSON.stringify(clean.detail).slice(0, 800)}`,
			).toBe(0);
			expect(clean.applied).toBe(0);

			const expected = await planter.plant();
			try {
				const first = await dry(name);
				expect(first.drift).toBeGreaterThanOrEqual(expected);
				expect(first.applied).toBe(0);
				// A dry run writes nothing: the same disagreement is measured again.
				const second = await dry(name);
				expect(JSON.stringify(second)).toBe(JSON.stringify(first));
				// The ops gauge carries the last verdict.
				const gauge = reconcileGauge() as Record<
					string,
					{ last_drift: number; last_apply: boolean; last_error: string | null }
				>;
				expect(gauge[name]?.last_drift).toBe(first.drift);
				expect(gauge[name]?.last_apply).toBe(false);
				expect(gauge[name]?.last_error).toBeNull();
			} finally {
				await planter.unplant();
			}
			const restored = await dry(name);
			expect(restored.drift).toBe(0);
		}, 120000);
	}

	test('media_index APPLY through the registry heals the planted stray marker, and the gauge records the apply', async () => {
		const planter = PLANTERS.media_index as Planter;
		await planter.plant();
		const { report } = await runReconcile('media_index', { apply: true });
		expect(report.drift).toBe(1);
		expect(report.applied).toBe(1);
		expect(existsSync(join(mediaRoot(), '.publication', 'pub', `${MEDIA_SECTION}_999999`))).toBe(
			false,
		);
		planted.splice(0);
		expect((await dry('media_index')).drift).toBe(0);
		const gauge = reconcileGauge() as Record<string, { last_apply: boolean }>;
		expect(gauge.media_index?.last_apply).toBe(false); // the dry above ran last
	});

	test('the widget door lists every registered reconcile and refuses an unknown name without running anything', async () => {
		const listing = (await reconcileStatusWidget.getValue?.({}, {
			isGlobalAdmin: true,
		} as unknown as Principal)) as {
			data: { reconciles: { name: string; stores: [string, string]; last_run: unknown }[] };
		};
		expect(listing.data.reconciles.map((row) => row.name)).toEqual([...REGISTERED_NAMES]);
		for (const row of listing.data.reconciles) expect(row.stores[0]).not.toBe(row.stores[1]);
		const unknown = await reconcileStatusWidget.apiActions?.run_reconcile?.(
			{ name: 'no_such_reconcile' },
			{ isGlobalAdmin: true } as unknown as Principal,
		);
		expect(unknown?.data).toBe(false);
	});

	test('applyRootOnly (media_copy, E10): the widget door refuses a non-root APPLY before running; dry stays admin-level', async () => {
		const admin = { isGlobalAdmin: true, userId: 7 } as unknown as Principal;
		const before = lastReconcileRun('media_copy');
		await expect(
			reconcileStatusWidget.apiActions?.run_reconcile?.(
				{ name: 'media_copy', apply: true, scope: ['zz_root_only_nohost'] },
				admin,
			) as Promise<unknown>,
		).rejects.toMatchObject({ code: 'perm.denied' });
		expect(lastReconcileRun('media_copy')).toBe(before); // never reached the registry
		// a DRY run by the same admin passes the gate (it reaches the registry)
		await reconcileStatusWidget.apiActions?.run_reconcile?.(
			{ name: 'media_copy', scope: ['zz_root_only_nohost'] },
			admin,
		);
		expect(lastReconcileRun('media_copy')).toMatchObject({ apply: false });
		// root passes the gate: the run reaches the registry (the unknown scoped host is then
		// the definition's own refusal, recorded as the run's error)
		await reconcileStatusWidget.apiActions?.run_reconcile?.(
			{ name: 'media_copy', apply: true, scope: ['zz_root_only_nohost'] },
			{ isGlobalAdmin: true, userId: SUPERUSER_ID } as unknown as Principal,
		);
		expect(lastReconcileRun('media_copy')).toMatchObject({
			apply: true,
			error: 'resource.not_found',
		});
		// the facet is declared exactly where an apply changes what the public can read
		const rootOnly = listReconciles()
			.filter((definition) => definition.applyRootOnly !== undefined)
			.map((definition) => definition.name);
		expect(rootOnly).toEqual(['media_copy', 'rich_text_images', 'web_image_exposure']);
	});

	test('the widget door is DRY unless apply is the boolean true: a planted drift is reported, not repaired', async () => {
		const planter = PLANTERS.media_index as Planter;
		const stray = join(mediaRoot(), '.publication', 'pub', `${MEDIA_SECTION}_999999`);
		await planter.plant();
		try {
			type Outcome = { data: boolean; msg: string; extend?: { report: ReconcileReport } };
			const run = (options: Record<string, unknown>) =>
				reconcileStatusWidget.apiActions?.run_reconcile?.(options, {
					isGlobalAdmin: true,
				} as unknown as Principal) as Promise<Outcome>;
			// No apply, a string "true", a number: every non-boolean spelling is a dry run.
			for (const options of [
				{ name: 'media_index' },
				{ name: 'media_index', apply: 'true' },
				{ name: 'media_index', apply: 1 },
			]) {
				const dryRun = await run(options);
				expect(dryRun.data).toBe(true);
				expect(dryRun.extend?.report.drift).toBe(1);
				expect(dryRun.extend?.report.applied).toBe(0);
				expect(dryRun.msg).toContain('dry run');
				expect(existsSync(stray)).toBe(true); // the store is untouched
			}
			// The boolean true repairs through the same door.
			const applied = await run({ name: 'media_index', apply: true });
			expect(applied.extend?.report.applied).toBe(1);
			expect(existsSync(stray)).toBe(false);
		} finally {
			await planter.unplant();
		}
		expect((await dry('media_index')).drift).toBe(0);
	});
});
