/**
 * TEST SITUATIONS — the ONE way a test obtains the structure and the data it
 * asserts against (AGENTS.md hard rules, 2026-08-19).
 *
 * The law: a test never reads whatever records the ambient database happens
 * to hold, and never names a specific install's TLD (`numisdata`, `oh`, `tch`,
 * `rsc`, `ich`, `mdcat`…) — such a gate is green on one machine and red on
 * every other. Instead it DECLARES the situation it needs and BUILDS it:
 *
 *   const s = situation({ tld: 'zzp', nodes: [...], records: [...] });
 *   beforeAll(() => ensureSituation(s));
 *   afterAll(() => dropSituation(s));
 *
 * Structure (ontology nodes) is materialized into `dd_ontology` — NOT overlaid
 * in memory. That is a measured constraint, not a preference: `getNode()` is
 * not a choke point (nine sibling reads in resolver.ts issue their own SQL),
 * `resolver.ts` self-joins `dd_ontology` to resolve virtual sections, and 23
 * files read the table directly under the frozen
 * `DD_ONTOLOGY_DIRECT_READ_RATCHET`. A cache-only node would be invisible to
 * all of them. So the rows are real, written through the engine's own door
 * (`upsertDdOntologyNode` — dd_ontology.ts's "ONLY dd_ontology SQL" rule) and
 * both write paths fan out their own cache invalidation, so no restart is
 * needed. This generalizes `../map_of_grapes_fixture.ts`, which proved the
 * pattern for one fixture by hand.
 *
 * Reserved namespace: a situation's `tld` MUST start with `zz` (checked). The
 * only ontology teardown is `deleteTldNodes(tld)`, which is TLD-scoped — a
 * situation that borrowed a real TLD could never be removed without a
 * hand-written DELETE, and could shadow real nodes. Records go to the matrix
 * table the ontology resolves for their section (`getMatrixTableFromTipo`),
 * exactly as the engine would place them; teardown sweeps the section's rows,
 * its `matrix_time_machine` audit rows and its `matrix_counter` row.
 *
 * Nodes are `DdOntologyNode` (src/core/db/dd_ontology.ts) — the interface IS
 * the JSON schema (`term`, `relations`, `properties` are jsonb), so a situation
 * can equally be authored inline or loaded from a committed `*.json` file
 * (`loadSituationJson`). Two fields are load-bearing and silently wrong when
 * omitted: `model` (the string the engine dispatches on) AND `model_tipo` (the
 * dd node of that model — e.g. `component_input_text` → `dd11`). Use
 * `modelTipoFor()` to derive the second from the first.
 */

import { readFileSync } from 'node:fs';
import {
	type DdOntologyNode,
	deleteTldNodes,
	readDdOntologyRow,
	searchDdOntology,
	upsertDdOntologyNode,
} from '../../db/dd_ontology.ts';
import { insertMatrixRecordWithExplicitId } from '../../db/matrix_write.ts';
import { sql, withTransaction } from '../../db/postgres.ts';
import { DedaloError } from '../../errors/index.ts';
import { createOntologyCache } from '../../ontology/cache_factory.ts';
import { clearOntologyDerivedCaches } from '../../ontology/cache_invalidation.ts';
import { deriveLegacyMachineName, modelNameOf } from '../../ontology/machine_name.ts';
import { getMatrixTableFromTipo } from '../../ontology/resolver.ts';
import { assertTestDatabase } from '../test_database_marker.ts';

/** A record the situation creates: section + id + the jsonb columns to write. */
export interface SituationRecord {
	section_tipo: string;
	section_id: number;
	/** jsonb columns (`data`, `relations`, …) → parsed values. `data` gets section_id/section_tipo stamped if absent. */
	columns?: Record<string, unknown>;
}

export interface SituationDescriptor {
	/** Reserved scratch TLD — MUST start with `zz`. Every node's `tld` is forced to it. */
	tld: string;
	/** Ontology nodes; `tld` may be omitted (forced), `is_*` default false, `propiedades` null. */
	nodes: (Partial<DdOntologyNode> & { tipo: string; model: string })[];
	/** Records to create after the nodes exist. */
	records?: SituationRecord[];
	/** Human name — appears in refusal messages. */
	name?: string;
}

/** A validated, ready-to-ensure situation. */
export interface Situation {
	readonly tld: string;
	readonly name: string;
	readonly nodes: readonly DdOntologyNode[];
	readonly records: readonly SituationRecord[];
	readonly sectionTipos: readonly string[];
}

/**
 * The reserved scratch TLD grammar every situation must use. EXPORTED so a gate
 * that censuses the ontology can tell a leaked scratch situation from shipped
 * definitions (diffusion_seed_compiles_native) instead of blaming the latter.
 */
export const RESERVED_TLD = /^zz[a-z]*$/;

/** Every refusal in this module is a typed engine invariant, never a bare Error. */
function refuse(message: string, coordinates: Record<string, string | number> = {}): never {
	throw new DedaloError('internal.invariant', { message: `situation: ${message}`, coordinates });
}

/**
 * Model → the dd node that defines it (`model_tipo`). Derived from the live
 * `dd` ontology so a situation never hard-codes a wrong `model_tipo` — the
 * failure the dmm fixture had to guard by hand. Built ONCE per process through
 * the sanctioned dd_ontology accessors (no direct SQL here — sql_confinement
 * ratchet); the cache is hub-registered, so any ontology write drops it.
 */
const modelTipoCache = createOntologyCache<string, string>();

/**
 * Fill the model → model_tipo map from the `dd` model nodes (first name wins). A
 * model's name is its machine name (machine_name.ts modelNameOf — the same rule
 * the parser projects `model` by, legacy lg-spa rung included).
 */
async function fillModelTipoCache(): Promise<void> {
	const modelTipos = await searchDdOntology({ tld: 'dd', is_model: true });
	for (const tipo of modelTipos) {
		const name = modelNameOf(await readDdOntologyRow(tipo)).model;
		if (typeof name === 'string' && name !== '' && !modelTipoCache.has(name)) {
			modelTipoCache.set(name, tipo);
		}
	}
}

export async function modelTipoFor(model: string): Promise<string> {
	if (modelTipoCache.size === 0) await fillModelTipoCache();
	const tipo = modelTipoCache.get(model);
	if (tipo === undefined) {
		refuse(`no dd model node for model '${model}' (is_model=true, machine name)`, { model });
	}
	return tipo;
}

/** Defaults for every optional node column — ONE object, so a node is `{...defaults, ...given}`. */
const NODE_DEFAULTS: Omit<
	DdOntologyNode,
	'tipo' | 'model' | 'tld' | 'term' | 'machine_name' | 'use_machine_name'
> = {
	parent: null,
	order_number: 1,
	relations: [],
	properties: null,
	model_tipo: null, // resolved at ensure time via modelTipoFor
	is_model: false,
	is_translatable: false,
	is_main: false,
	propiedades: null,
};

/**
 * The `matrix_table` node naming `matrix_test` — the disposable records table.
 *
 * WHY EVERY SCRATCH SECTION MUST NAME IT. `getMatrixTableFromTipo` follows the
 * PHP contract: a section carrying no explicit `matrix_table` relation falls
 * back to **`matrix`** (resolver.ts :652-654). `matrix` is where an
 * installation's own records live, so a scratch section that forgets the
 * relation silently writes into the install-shaped table — and a gate's
 * residue check, looking in `matrix_test`, reads 0 and calls it clean.
 *
 * That is exactly the accident this module exists to prevent, and "remember to
 * add the relation" is not a guarantee, so a section node GETS it here unless
 * its author names relations deliberately. Measured 2026-08-20: before this
 * default, every `zz*` situation section in the suite resolved to `matrix`.
 */
const MATRIX_TEST_TABLE_TIPO = 'test24';

/** One node: force the TLD, fill defaults (an explicit `undefined` still takes the default). */
function normalizeNode(
	n: Partial<DdOntologyNode> & { tipo: string; model: string },
	tld: string,
): DdOntologyNode {
	const given = Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined));
	// A section with no relations of its own stores in matrix_test, never in the
	// installation's `matrix` (see MATRIX_TEST_TABLE_TIPO). An author who DOES
	// name relations owns the choice — including the table.
	const relations =
		n.model === 'section' && given.relations === undefined
			? [{ tipo: MATRIX_TEST_TABLE_TIPO }]
			: undefined;
	const node = {
		...NODE_DEFAULTS,
		machine_name: null,
		use_machine_name: false,
		term: { 'lg-eng': n.tipo },
		...given,
		...(relations === undefined ? {} : { relations }),
		tipo: n.tipo,
		model: n.model,
		tld,
	} as DdOntologyNode;
	// A situation writes dd_ontology DIRECTLY (no source record, so no parser): a node
	// that does not state its machine-name columns gets the parser's own legacy
	// derivation (a `table` node named by its lg-spa term reads as the parser would
	// project it). One rung for every direct-row fixture, in one place.
	if (typeof given.use_machine_name !== 'boolean') {
		const derived = deriveLegacyMachineName(node);
		node.machine_name = (given.machine_name as string | null | undefined) ?? derived.machine_name;
		node.use_machine_name = derived.use_machine_name;
	}
	return node;
}

/** Validate a descriptor into a Situation. Pure — no DB. */
/** Every node tipo is under the situation's TLD and unique. */
function assertNodeTipos(name: string, tld: string, nodes: readonly { tipo: string }[]): void {
	const seen = new Set<string>();
	for (const n of nodes) {
		if (!n.tipo.startsWith(tld))
			refuse(`'${name}': node '${n.tipo}' is not under tld '${tld}'`, { tipo: n.tipo, tld });
		if (seen.has(n.tipo)) refuse(`'${name}': duplicate node '${n.tipo}'`, { tipo: n.tipo });
		seen.add(n.tipo);
	}
}

export function situation(descriptor: SituationDescriptor): Situation {
	const { tld } = descriptor;
	const name = descriptor.name ?? tld;
	if (!RESERVED_TLD.test(tld)) {
		refuse(`'${name}': tld '${tld}' is not a reserved scratch TLD (must match ${RESERVED_TLD})`, {
			tld,
		});
	}
	assertNodeTipos(name, tld, descriptor.nodes);
	const nodes = descriptor.nodes.map((n) => normalizeNode(n, tld));
	const records = descriptor.records ?? [];
	// EVERY section the situation defines, not merely the ones with DECLARED
	// records. A gate typically creates its rows at runtime
	// (insertMatrixRecordWithCounter), so deriving this from `records` alone left
	// those rows, their time-machine tail and their `matrix_counter` entries
	// unswept — and `residueOf`, walking the same empty list, answered 0, which
	// made `expect(await dropSituation(s)).toBe(0)` vacuous. Measured 2026-08-20:
	// counters for zztp1/zzti1/zzolang1/zzmip1 survived teardown and GREW on each
	// re-run while every gate reported a clean sweep.
	const sectionTipos = [
		...new Set([
			...nodes.filter((n) => n.model === 'section').map((n) => n.tipo),
			...records.map((r) => r.section_tipo),
		]),
	];
	return { tld, name, nodes, records, sectionTipos };
}

/** Load a committed JSON descriptor (`{tld, nodes, records?, name?}`). */
export function loadSituationJson(path: string): Situation {
	return situation(JSON.parse(readFileSync(path, 'utf8')) as SituationDescriptor);
}

/**
 * Materialize the situation — idempotent (whole-row upsert per node; records
 * are deleted-then-inserted). One transaction: a half-built situation never
 * survives a throw. Nodes go first so `getMatrixTableFromTipo` can place the
 * records where the engine itself would.
 */
export async function ensureSituation(s: Situation): Promise<void> {
	// The database must carry the `dedalo_test_marker` row before any node or
	// record is written (src/core/test_data/test_database_marker.ts): a
	// situation writes dd_ontology and matrix rows, which on an installation
	// are the ontology and the collection.
	await assertTestDatabase('ensureSituation');
	// Resolve model_tipo OUTSIDE the transaction (resolver caches refuse to
	// memoize inside one — S1-14 — and these are plain reads anyway).
	const resolved: DdOntologyNode[] = [];
	for (const n of s.nodes) {
		resolved.push({ ...n, model_tipo: n.model_tipo ?? (await modelTipoFor(n.model ?? '')) });
	}
	await withTransaction(async () => {
		for (const n of resolved) await upsertDdOntologyNode(n);
	});
	// Table resolution needs the nodes committed and the caches cleared (the
	// upsert already fanned invalidation out).
	const tables = new Map<string, string>();
	for (const tipo of s.sectionTipos) {
		const table = await getMatrixTableFromTipo(tipo);
		if (table === null)
			refuse(`'${s.name}': no matrix table resolves for section '${tipo}'`, { tipo });
		tables.set(tipo, table);
	}
	await withTransaction(async () => {
		for (const r of s.records) {
			const table = tables.get(r.section_tipo) as string;
			await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1 AND section_id = $2`, [
				r.section_tipo,
				r.section_id,
			]);
			const columns: Record<string, unknown> = { ...(r.columns ?? {}) };
			const data = (columns.data ?? {}) as Record<string, unknown>;
			columns.data = { section_id: r.section_id, section_tipo: r.section_tipo, ...data };
			await insertMatrixRecordWithExplicitId(table, r.section_tipo, r.section_id, columns);
		}
	});
}

/**
 * The table every scratch section stores in when the ontology can no longer say
 * (its node is already gone). NEVER `matrix`: that is the installation's own
 * table, and answering it here would make a sweep miss and a residue count lie.
 */
const SCRATCH_TABLE_FALLBACK = 'matrix_test';

/** Resolve each section's table WHILE ITS NODE EXISTS. */
async function tablesOf(sectionTipos: readonly string[]): Promise<Map<string, string>> {
	const tables = new Map<string, string>();
	for (const tipo of sectionTipos) {
		tables.set(tipo, (await getMatrixTableFromTipo(tipo)) ?? SCRATCH_TABLE_FALLBACK);
	}
	return tables;
}

/**
 * Tear the situation down: every record of every section it declared (plus TM
 * + counter rows), then every node under its TLD. Safe to call on a situation
 * that was never ensured. Returns the residue count (0 on success) so a gate
 * can assert hermeticity instead of trusting the sweep.
 */
export async function dropSituation(s: Situation): Promise<number> {
	// Teardown deletes whole sections and a whole TLD's nodes — checked again,
	// not inherited from the ensure (a `finally` runs on paths the ensure never
	// reached).
	await assertTestDatabase('dropSituation');
	// Tables are resolved while the NODES STILL EXIST: once deleteTldNodes has
	// run, `getMatrixTableFromTipo` answers null for every one of them, and a
	// `?? 'matrix'` fallback would then sweep — and count — the installation's
	// table instead of the scratch one. The resolved map is handed to residueOf
	// for the same reason.
	const tables = await tablesOf(s.sectionTipos);
	for (const tipo of s.sectionTipos) {
		const table = tables.get(tipo) as string;
		await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo = $1`, [tipo]);
		await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${tipo}`;
		await sql`DELETE FROM matrix_counter WHERE tipo = ${tipo}`;
	}
	const ok = await deleteTldNodes(s.tld);
	if (!ok) refuse(`'${s.name}': deleteTldNodes refused tld '${s.tld}'`, { tld: s.tld });
	await clearOntologyDerivedCaches();
	return residueOf(s, tables);
}

/** Rows still present for this situation (nodes + records). 0 = clean. */
export async function residueOf(
	s: Situation,
	known?: ReadonlyMap<string, string>,
): Promise<number> {
	let total = (await searchDdOntology({ tld: s.tld })).length;
	// `known` is the map dropSituation resolved BEFORE it deleted the nodes.
	// Without it (a direct call, nodes still present) resolve now; a section that
	// resolves to nothing is counted in the scratch table, never in `matrix`.
	const tables = known ?? (await tablesOf(s.sectionTipos));
	for (const tipo of s.sectionTipos) {
		const table = tables.get(tipo) ?? SCRATCH_TABLE_FALLBACK;
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM "${table}" WHERE section_tipo = $1`,
			[tipo],
		)) as { n: number }[];
		total += rows[0]?.n ?? 0;
		const counters = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_counter WHERE tipo = $1`,
			[tipo],
		)) as { n: number }[];
		total += counters[0]?.n ?? 0;
	}
	return total;
}
