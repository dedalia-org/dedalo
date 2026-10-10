/**
 * THE ENGINE-OWNED ONTOLOGY — the sections the engine itself writes, defined
 * in the repository and materialized into every installation.
 *
 * WHY A TLD OF ITS OWN (2026-10-01, closure Step 3 / TOOLS-4). The AI spend
 * ledger (security/ai_spend.ts) is standard-schema state: a section with
 * components, one record per (user, UTC day) — never a bespoke table. A section
 * needs ontology nodes, and the engine needs them on EVERY installation the
 * moment its code ships. The master `dd` ontology cannot carry them: it is
 * authored on the ontology master, not in this repository, and an ontology
 * update replaces the `dd` TLD wholesale — a node the engine planted there
 * would be wiped by the next update. The ontology update imports PER TLD (the
 * manifest's files, ontology_update.ts), so a TLD the master never serves is
 * never touched by it. Hence `ddengine`: owned by this repository, its source
 * of record `./engine_ontology.json`, reserved for the engine.
 *
 * THE DOOR IS THE ENGINE'S OWN, in the engine's order (the same law as the
 * test-TLD door, test_data/test_tld_materialize.ts):
 *
 *   JSON node --ontologyRecordFromNode--> matrix_ontology `ddengine0` record
 *             (persistRecordColumns — the whole-record chokepoint, unstamped)
 *   the main node --provisionOntologyMainRegistry--> the ontology35 registry row
 *   matrix_ontology records --rebuildOntology('ddengine')--> dd_ontology rows
 *
 * dd_ontology is NEVER written here: rebuildOntology is its one writer.
 *
 * IDEMPOTENT AND CHEAP WHEN CURRENT. `engineOntologyDrift` compares every JSON
 * node with its dd_ontology row by the engine's own equality law
 * (`nodeDiffColumns`); nothing differs → nothing is written. Any difference — a
 * fresh install, a release that changed a node, an operator's edit of an
 * engine node — rewrites EVERY source record from the JSON and rebuilds the
 * TLD: the repository is the source of record, and an edit made in the
 * database is drift by definition. Records of `ddengine0` the JSON does not
 * declare are REPORTED as strays, never deleted (not this door's to remove) —
 * unless the JSON names them `retired` (below).
 *
 * RETIRED NODES ARE PRUNED BY THIS DOOR (2026-10-10). A node the engine once
 * shipped and no longer does is listed in the JSON's `retired` array (tipo +
 * date + reason) — never silently dropped from `nodes`, because a node merely
 * absent from the file is a stray this door only reports, and the rebuild
 * would resurrect it from its surviving `ddengine0` source record. For each
 * retired tipo still present anywhere, the run is NOT a no-op: its source
 * record is deleted through the per-record delete pipeline
 * (section/record/delete_record.ts — TM snapshot, inverse references), its
 * stored values are stripped from every ontology registry row
 * (ontology_write.ts stripRetiredRegistryKey), and the rebuild drops its
 * dd_ontology row. First retiree: `ddengine11` "Required ontologies", the
 * 2026-10-09 dependency portal, superseded by the master ontology's own
 * component_json `hierarchy60` (WC-2026-10-10-ontology-dependencies-hierarchy60).
 *
 * WHO CALLS IT: boot (server.ts, after the schema migrations — a code update
 * reaches an installation through a restart, so boot IS the update lane), the
 * installer (install/db_restore.ts), the suite setup (scripts/test_db_setup.ts)
 * and the suite preload (test/preload/engine_state.ts — the boot twin for a
 * `bun test` process). A failure is LOUD and never fatal to boot: every
 * consumer of an engine section fails CLOSED without it (ai_spend refuses with
 * `ai.budget_unavailable`).
 *
 * ONE PROCESS AT A TIME, by deployment: boot is single-flight per install, and
 * the doors below are idempotent (whole-record overwrite, wholesale rebuild),
 * so a rare concurrent second run converges on the same rows.
 *
 * Gates: test/unit/ai_spend_budget_native.test.ts (the engine-ontology legs:
 * dd_ontology ≡ the JSON node for node, `inspectOntology` drift-free, a second
 * run writes nothing, a damaged node is healed, every node is under the
 * engine TLD); test/unit/engine_ontology_retired_native.test.ts (a retired
 * node planted with its source record, dd_ontology row and registry value is
 * pruned from all three, and the next run is a no-op).
 */

import type { DdOntologyNode } from '../db/dd_ontology.ts';
import { readDdOntologyRow } from '../db/dd_ontology.ts';
import type { MatrixWriteValues } from '../db/matrix_write.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { deleteSectionRecord } from '../section/record/delete_record.ts';
import { persistRecordColumns } from '../section_record/record_write.ts';
import { clearOntologyDerivedCaches } from './cache_invalidation.ts';
import {
	ontologyRecordFromNode,
	provisionOntologyMainRegistry,
} from './ontology_record_inverse.ts';
import { nodeDiffColumns, rebuildOntology } from './ontology_state.ts';
import { ONTOLOGY_MAIN_SECTION } from './ontology_tipos.ts';
import { stripRetiredRegistryKey } from './ontology_write.ts';
import { getSectionIdFromTipo, getTldFromTipo } from './tld.ts';

/** The engine-owned TLD. Reserved: an installation must not author a thesaurus under it. */
export const ENGINE_TLD = 'ddengine';

/** Its source of record (repo-relative, for messages). */
export const ENGINE_ONTOLOGY_JSON_PATH = 'src/core/ontology/engine_ontology.json';

/** A node the engine once shipped and now prunes (module header, RETIRED NODES). */
export interface RetiredEngineNode {
	tipo: string;
	/** ISO date of the release that retired it. */
	retired: string;
	/** Why, and what replaced it. */
	reason: string;
}

/** The document shape of that file. */
export interface EngineOntologyDoc {
	tld: string;
	nodes: DdOntologyNode[];
	/** Nodes to prune wherever they survive; absent = none. */
	retired?: RetiredEngineNode[];
}

/** What one `ensureEngineOntology` run did. */
export interface EnsureEngineOntologyResult {
	/** False when every node already matched (nothing was written). */
	changed: boolean;
	/** The drift found BEFORE the run, one line per node (`<tipo>: <columns>`). */
	drift: string[];
	/** Source records written (main node excluded — it has none). */
	written: number;
	/** `ddengine0` records the JSON does not declare, as `ddengine0/<id>` — reported, never deleted. */
	strays: string[];
	/** The retired-node residue this run PRUNED, one line per item (empty when none survived). */
	pruned: string[];
}

/** `<tld>0` ALWAYS lives in matrix_ontology (resolver.getMatrixTableFromTipo's '0' rule). */
const ONTOLOGY_TABLE = 'matrix_ontology';
const MAIN_SECTION_TIPO = `${ENGINE_TLD}0`;

/** The engine actor: the door writes as the system (-1), unstamped, like every provisioner. */
const ENGINE_ACTOR = -1;

function refuse(message: string, coordinates: Record<string, string | number> = {}): never {
	throw new DedaloError('internal.invariant', {
		message: `engine ontology: ${message}`,
		coordinates,
	});
}

/** Load the committed JSON source. */
export async function loadEngineOntologyDoc(): Promise<EngineOntologyDoc> {
	const module = await import('./engine_ontology.json');
	return module.default as unknown as EngineOntologyDoc;
}

/**
 * Every node must sit under the engine TLD and carry its own tipo grammar —
 * a definitions file that names another TLD would let this door rewrite
 * records it does not own.
 */
function assertOwnNodes(doc: EngineOntologyDoc): DdOntologyNode {
	if (doc.tld !== ENGINE_TLD) refuse(`the document declares tld '${doc.tld}'`, { tld: doc.tld });
	const seen = new Set<string>();
	for (const node of doc.nodes) assertOwnNode(node, seen);
	for (const retired of doc.retired ?? []) assertRetiredNode(retired, seen);
	const main = doc.nodes.find((node) => node.tipo === MAIN_SECTION_TIPO);
	if (main?.is_main !== true) refuse(`the document has no main node '${MAIN_SECTION_TIPO}'`);
	return main;
}

/**
 * One retired entry: an engine tipo (the door prunes only what it owns), never
 * the main node, and not ALSO a live node or listed twice (`seen` holds the
 * live tipos) — a tipo both shipped and pruned would flip on every boot.
 */
function assertRetiredNode(retired: RetiredEngineNode, seen: Set<string>): void {
	if (getTldFromTipo(retired.tipo) !== ENGINE_TLD || retired.tipo === MAIN_SECTION_TIPO) {
		refuse(`retired node '${retired.tipo}' is not a prunable engine node`, { tipo: retired.tipo });
	}
	if (seen.has(retired.tipo)) {
		refuse(`node '${retired.tipo}' is both declared and retired`, { tipo: retired.tipo });
	}
	seen.add(retired.tipo);
}

/** One node: under the engine TLD (its declared tld AND its tipo's), and not a duplicate. */
function assertOwnNode(node: DdOntologyNode, seen: Set<string>): void {
	if (node.tld !== ENGINE_TLD || getTldFromTipo(node.tipo) !== ENGINE_TLD) {
		refuse(`node '${node.tipo}' is not under the engine tld`, { tipo: node.tipo });
	}
	if (seen.has(node.tipo)) refuse(`duplicate node '${node.tipo}'`, { tipo: node.tipo });
	seen.add(node.tipo);
}

/**
 * The drift between the JSON and dd_ontology, by the engine's own equality law
 * (`nodeDiffColumns`). Empty = current. One line per differing node.
 */
export async function engineOntologyDrift(doc?: EngineOntologyDoc): Promise<string[]> {
	const source = doc ?? (await loadEngineOntologyDoc());
	const drift: string[] = [];
	for (const node of source.nodes) {
		const row = await readDdOntologyRow(node.tipo);
		if (row === null) {
			drift.push(`${node.tipo}: missing`);
			continue;
		}
		const columns = nodeDiffColumns(node, row);
		if (columns.length > 0) drift.push(`${node.tipo}: ${columns.join(',')}`);
	}
	return drift;
}

/**
 * The FULL record a node is stored as: the inverse parser's columns, plus an
 * EMPTY bag for every column the node leaves unset — persistRecordColumns
 * replaces the columns it is given and keeps the others, so an omitted `misc`
 * would let a removed property survive the rewrite.
 */
function fullRecordColumns(node: DdOntologyNode): MatrixWriteValues {
	const columns = ontologyRecordFromNode(node) as MatrixWriteValues;
	return { misc: {}, number: {}, ...columns } as MatrixWriteValues;
}

/** `ddengine0` records present in the table that the JSON does not declare. */
async function strayRecords(declared: ReadonlySet<number>): Promise<string[]> {
	const present = (await sql.unsafe(
		`SELECT section_id FROM "${ONTOLOGY_TABLE}" WHERE section_tipo = $1 ORDER BY section_id`,
		[MAIN_SECTION_TIPO],
	)) as { section_id: number }[];
	return present
		.filter((row) => !declared.has(Number(row.section_id)))
		.map((row) => `${MAIN_SECTION_TIPO}/${row.section_id}`);
}

/** Where one retired node still survives. */
interface RetiredResidue {
	tipo: string;
	sectionId: number;
	/** Its dd_ontology row exists. */
	node: boolean;
	/** Its `ddengine0` source record exists. */
	record: boolean;
	/** Registry rows (ontology35) carrying a value under its tipo. */
	registryRows: number;
}

/** Every retired node that still survives somewhere (empty = fully pruned). */
async function retiredResidue(doc: EngineOntologyDoc): Promise<RetiredResidue[]> {
	const residue: RetiredResidue[] = [];
	for (const retired of doc.retired ?? []) {
		const item = await measureRetired(retired.tipo);
		if (item.node || item.record || item.registryRows > 0) residue.push(item);
	}
	return residue;
}

/** The three places one retired tipo can survive, measured (the registry scan = stripRetiredRegistryKey's). */
async function measureRetired(tipo: string): Promise<RetiredResidue> {
	const sectionId = Number(getSectionIdFromTipo(tipo));
	const counts = (await sql.unsafe(
		`SELECT
			(SELECT count(*)::int FROM "${ONTOLOGY_TABLE}" WHERE section_tipo = $1 AND section_id = $2) AS records,
			(SELECT count(*)::int FROM "matrix_ontology_main"
			 WHERE section_tipo = $4 AND (relation ? $3 OR string ? $3 OR misc ? $3)) AS registry_rows`,
		[MAIN_SECTION_TIPO, sectionId, tipo, ONTOLOGY_MAIN_SECTION],
	)) as { records: number; registry_rows: number }[];
	return {
		tipo,
		sectionId,
		node: (await readDdOntologyRow(tipo)) !== null,
		record: Number(counts[0]?.records ?? 0) > 0,
		registryRows: Number(counts[0]?.registry_rows ?? 0),
	};
}

/** One line per surviving piece of a retired node (the drift-style report). */
function residueLines(residue: readonly RetiredResidue[]): string[] {
	return residue.flatMap(residueItemLines);
}

function residueItemLines(item: RetiredResidue): string[] {
	const lines: string[] = [];
	if (item.node) lines.push(`${item.tipo}: retired, dd_ontology row present`);
	if (item.record) {
		lines.push(
			`${item.tipo}: retired, source record ${MAIN_SECTION_TIPO}/${item.sectionId} present`,
		);
	}
	if (item.registryRows > 0) {
		lines.push(`${item.tipo}: retired, value on ${item.registryRows} registry row(s)`);
	}
	return lines;
}

/**
 * Prune what survives of the retired nodes, BEFORE the rebuild: the source
 * record through the per-record delete pipeline (TM snapshot + inverse
 * references — the same door deleteOntologyByTld uses for `<tld>0` records),
 * then the registry values. The rebuild that follows wipes the TLD's
 * dd_ontology rows and re-derives only the records that remain, so the retired
 * row is not re-created. Answers one line per pruned item.
 */
async function pruneRetired(residue: readonly RetiredResidue[]): Promise<string[]> {
	const pruned: string[] = [];
	for (const item of residue) {
		if (item.record) {
			await deleteSectionRecord(MAIN_SECTION_TIPO, item.sectionId, ENGINE_ACTOR);
			pruned.push(`${MAIN_SECTION_TIPO}/${item.sectionId} (${item.tipo}): source record deleted`);
		}
		for (const line of await stripRetiredRegistryKey(item.tipo)) {
			pruned.push(`${line} removed`);
		}
		if (item.node) pruned.push(`${item.tipo}: dd_ontology row dropped by the rebuild`);
	}
	return pruned;
}

/**
 * Materialize the engine ontology when it differs from the JSON, or when a
 * retired node survives (pruned first); a no-op when neither. THROWS (`internal.invariant`) when the definitions are not the
 * engine's own, when the rebuild fails, or when the round trip leaves drift.
 */
export async function ensureEngineOntology(
	options: { doc?: EngineOntologyDoc } = {},
): Promise<EnsureEngineOntologyResult> {
	const doc = options.doc ?? (await loadEngineOntologyDoc());
	const main = assertOwnNodes(doc);
	const residue = await retiredResidue(doc);
	const drift = [...(await engineOntologyDrift(doc)), ...residueLines(residue)];
	const declared = new Set(doc.nodes.map((node) => Number(getSectionIdFromTipo(node.tipo))));
	if (drift.length === 0) {
		return { changed: false, drift, written: 0, strays: await strayRecords(declared), pruned: [] };
	}
	const pruned = await pruneRetired(residue);
	const written = await writeSourceRecords(doc);
	await deriveEngineOntology(main);
	const residual = [
		...(await engineOntologyDrift(doc)),
		...residueLines(await retiredResidue(doc)),
	];
	if (residual.length > 0) {
		refuse(`the round trip left drift: ${residual.join('; ')}`, { tld: ENGINE_TLD });
	}
	return { changed: true, drift, written, strays: await strayRecords(declared), pruned };
}

/**
 * Every non-main node's `ddengine0` source record, rewritten WHOLE from the JSON
 * (persistRecordColumns — the whole-record chokepoint, unstamped). The main node
 * has no source record: the rebuild mints it from the registry row.
 */
async function writeSourceRecords(doc: EngineOntologyDoc): Promise<number> {
	const nodes = doc.nodes.filter((node) => node.tipo !== MAIN_SECTION_TIPO);
	for (const node of nodes) {
		await persistRecordColumns(
			{
				table: ONTOLOGY_TABLE,
				sectionTipo: MAIN_SECTION_TIPO,
				sectionId: Number(getSectionIdFromTipo(node.tipo)),
			},
			fullRecordColumns(node),
			false,
			{ actor: ENGINE_ACTOR },
		);
	}
	return nodes.length;
}

/** The registry row FIRST (the rebuild mints `ddengine0` from it), then dd_ontology by its one writer. */
async function deriveEngineOntology(main: DdOntologyNode): Promise<void> {
	await provisionOntologyMainRegistry(main);
	const rebuild = await rebuildOntology(ENGINE_TLD, ENGINE_ACTOR);
	if (!rebuild.ok) {
		refuse(`rebuildOntology('${ENGINE_TLD}') failed: ${rebuild.errors.join(' | ')}`);
	}
	await clearOntologyDerivedCaches();
}
