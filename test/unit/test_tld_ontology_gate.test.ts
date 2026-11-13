/**
 * The generic `test` TLD ontology has ONE source of record:
 * `src/core/test_data/test_tld_ontology.json` (2026-08-19, generic-`test`-TLD
 * migration phase 1). The database is DERIVED from it — `scripts/test_db_setup.ts`
 * (the SUITE database; an installation receives no test TLD since the install
 * seed is core-only) calls `materializeTestTldOntology()`, which writes
 * `matrix_ontology` `<tld>0` records through `ontologyRecordFromNode` (the
 * inverse of the parser) and then lets `rebuildOntology(tld)` — the ONE
 * dd_ontology writer — produce the runtime rows.
 *
 * This gate is what makes that claim checkable, in four tiers:
 *
 *  (a) HERMETIC — the JSON is a valid ontology: node shape, tipo grammar, and
 *      every tipo a node REFERENCES resolves inside the JSON or to an allowed
 *      TLD. The refs that do NOT are frozen below with a reason each: the law
 *      (plan decision 1) allows only `test`/`test*` + dd, rsc, hierarchy,
 *      ontology, ontologytype, lg, and phase 2's clone script clears the rest.
 *      The list is SHRINK-ONLY — a new install-TLD reference fails here.
 *  (b) HERMETIC — the inverse parser puts each field in the component/column
 *      the parser reads it from.
 *  (c) DATABASE — the round trip is REAL: every materialized record parses back
 *      into exactly its JSON node, dd_ontology equals the JSON node for node
 *      (by the engine's own equality law, `nodeDiffColumns`), and
 *      `inspectOntology(tld).drift` is empty.
 *  (d) DATABASE — every `test` SECTION stores in `matrix_test` (plan decision 1:
 *      no test record ever lands in an install's table).
 *
 * The old (a) — "the JSON equals the `test` TLD inside the install seed" — is
 * GONE on purpose: the seed is no longer a source, and the core-only seed
 * (compiled by src/core/install/seed_build.ts) carries no `test` row at all. The old
 * install/suite SPLIT (an install received the hand-authored half) is gone with
 * it: the suite materializes the whole file, nothing else materializes any.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import type { DdOntologyNode, DdOntologyRow } from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { isNameClassNode } from '../../src/core/ontology/machine_name.ts';
import {
	convertCanonicalRecord,
	type MachineNameConversion,
} from '../../src/core/ontology/machine_name_convert.ts';
import { censusMachineNames } from '../../src/core/ontology/machine_name_reconcile.ts';
import {
	flagFromItems,
	literalStrings,
	type StoredLiteralItem,
} from '../../src/core/ontology/machine_name_rules.ts';
import type { OntologyState } from '../../src/core/ontology/ontology_state.ts';
import { inspectOntology, nodeDiffColumns } from '../../src/core/ontology/ontology_state.ts';
import {
	ONTOLOGY_CONNECTED_TO,
	ONTOLOGY_CSS,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_MODEL,
	ONTOLOGY_ORDER,
	ONTOLOGY_PARENT,
	ONTOLOGY_PROPERTIES,
	ONTOLOGY_PROPIEDADES_V5,
	ONTOLOGY_SOURCE,
	ONTOLOGY_TERM,
	ONTOLOGY_TLD,
	ONTOLOGY_TRANSLATABLE,
	ONTOLOGY_USE_MACHINE_NAME,
} from '../../src/core/ontology/ontology_tipos.ts';
import { parseSectionRecordToOntologyNode } from '../../src/core/ontology/parser.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
} from '../../src/core/ontology/resolver.ts';
import { getSectionIdFromTipo } from '../../src/core/ontology/tld.ts';
import {
	loadTestTldOntologyDoc,
	materializeTestTldOntology,
	ontologyRecordFromNode,
} from '../../src/core/test_data/test_tld_materialize.ts';
import { sweepMachineNameScratch } from '../helpers/machine_name_scratch.ts';

const DOC = await loadTestTldOntologyDoc();
const NODES = DOC.nodes;
const TIPOS = new Set(NODES.map((node) => node.tipo));
/** Every TLD the document declares (phase 2 adds one `test*` per thesaurus). */
const TLDS = [...new Set(NODES.map((node) => node.tld ?? ''))].sort();

/** PHP's tipo grammar (api/handlers/dd_core_api.ts:52 and friends). */
const TIPO_RE = /^[a-z]{2,}[0-9]+$/;
/** Any tipo-shaped token inside a properties/propiedades blob. */
const TOKEN_RE = /\b[a-z]{2,}[0-9]+\b/g;

/**
 * The ONLY foreign TLDs a test node may reference (plan decision 1, user
 * 2026-08-19). Everything else — including `oh`, the country hierarchies and
 * every project TLD — is cloned into `test` instead.
 */
const ALLOWED_TLDS = new Set(['dd', 'rsc', 'hierarchy', 'ontology', 'ontologytype', 'lg']);

/** The database this suite is actually connected to. */
const currentDatabaseName = async (): Promise<string> =>
	((await sql`SELECT current_database() AS db`) as { db: string }[])[0]?.db ?? '';

const tldOf = (tipo: string): string => /^[a-z]{2,}/.exec(tipo)?.[0] ?? '';

/**
 * THE MATERIALIZED SHAPE (T1-P05). The door runs the package import rewrite (class L,
 * machine_name_reconcile.ts convertImportedMachineNames) between the record write and
 * the rebuild, like every import door — so the database holds each JSON node AFTER the
 * kernel's verdict on its record, not the node itself. Computed here HERMETICALLY, from
 * the pure kernel over the inverse's record (the door reads the same keys back from the
 * database): an independent expectation, not the door's own output.
 */
type RecordColumns = Record<string, Record<string, unknown[] | undefined> | undefined>;

/** The kernel's verdict on one JSON node's source record (the door's judgeRecord, pure). */
function kernelVerdict(node: DdOntologyNode): MachineNameConversion {
	const columns = ontologyRecordFromNode(node) as RecordColumns;
	return convertCanonicalRecord({
		termItems: (columns.string?.[ONTOLOGY_TERM] ?? []) as StoredLiteralItem[],
		nameValues: literalStrings(columns.string?.[ONTOLOGY_MACHINE_NAME] ?? null),
		flag: flagFromItems(columns.relation?.[ONTOLOGY_USE_MACHINE_NAME] ?? null),
		nameClass: isNameClassNode(node),
	});
}

/** A JSON node as the database must hold it: after the class-L rewrite (S / C / none: unchanged). */
function materializedNode(node: DdOntologyNode): DdOntologyNode {
	if (node.is_main === true) return node; // no source record: minted by the rebuild
	const verdict = kernelVerdict(node);
	if (verdict.class !== 'L') return node;
	const items = verdict.termItems;
	const term =
		items === undefined
			? node.term
			: items.length === 0
				? null
				: Object.fromEntries(items.map((item) => [String(item.lang), String(item.value ?? '')]));
	return {
		...node,
		term,
		machine_name: verdict.machineName ?? node.machine_name,
		use_machine_name: verdict.flag ?? node.use_machine_name,
	};
}

/**
 * The still-foreign references the shipped ontology carries — FROZEN, with a
 * reason each, in `src/core/test_data/test_tld_foreign_refs.json`.
 *
 * The list is DATA, not code in this file, for one mechanical reason: the
 * install-TLD census (`scripts/lib/tld_census.ts`) scans `test/**` and would
 * read those tipos as THIS GATE binding eight installs. Comments are stripped
 * by the census, code strings are not.
 *
 * Phase 2's clone script retargets each entry at a `test` clone and deletes it
 * from the file; the set may only SHRINK (measured 2026-08-19: 28 tipos / 41
 * sites).
 */
const FOREIGN_REFS_PATH = 'src/core/test_data/test_tld_foreign_refs.json';
const FROZEN = (await import('../../src/core/test_data/test_tld_foreign_refs.json')).default as {
	probe_tipo: string;
	tokens: Record<string, { sites: string[]; reason: string }>;
};
const FROZEN_FOREIGN_REFS = FROZEN.tokens;
/** Every foreign reference in a set of nodes, as `tipo → sites`. */
function foreignRefs(nodes: readonly DdOntologyNode[]): Map<string, string[]> {
	const found = new Map<string, Set<string>>();
	for (const node of nodes) {
		const add = (token: string, field: string): void => {
			if (TIPOS.has(token) || ALLOWED_TLDS.has(tldOf(token))) return;
			const sites = found.get(token) ?? new Set<string>();
			sites.add(`${node.tipo}.${field}`);
			found.set(token, sites);
		};
		if (node.parent !== null && node.parent !== '') add(node.parent, 'parent');
		for (const relation of node.relations ?? [])
			add((relation as { tipo: string }).tipo, 'relations');
		if (node.properties !== null) {
			for (const token of JSON.stringify(node.properties).match(TOKEN_RE) ?? []) {
				add(token, 'properties');
			}
		}
		if (node.propiedades !== null) {
			for (const token of node.propiedades.match(TOKEN_RE) ?? []) add(token, 'propiedades');
		}
	}
	return new Map([...found].map(([token, sites]) => [token, [...sites].sort()]));
}

describe('test TLD ontology — the JSON source (hermetic)', () => {
	test('the document is a well-formed ontology: tld, tipo grammar, model, parent', () => {
		expect(NODES.length).toBeGreaterThan(200); // anti-vacuity: 217 today
		expect(TLDS.length).toBeGreaterThan(0);
		const broken: string[] = [];
		for (const node of NODES) {
			if (typeof node.tld !== 'string' || node.tld === '') broken.push(`${node.tipo}: no tld`);
			if (!TIPO_RE.test(node.tipo)) broken.push(`${node.tipo}: tipo grammar`);
			if (!node.tipo.startsWith(String(node.tld))) broken.push(`${node.tipo}: tipo ≠ tld prefix`);
			if (typeof node.model !== 'string' || node.model === '') {
				broken.push(`${node.tipo}: no model`);
			}
			if (!Object.hasOwn(node, 'parent')) broken.push(`${node.tipo}: no parent key`);
			// Only the `<tld>0` main node may be parentless (it is minted by the
			// rebuild from the ontology35 registry row, not from a source record).
			if (node.parent === null && node.is_main !== true) broken.push(`${node.tipo}: null parent`);
			if (node.is_main === true && node.tipo !== `${node.tld}0`) {
				broken.push(`${node.tipo}: is_main but not <tld>0`);
			}
		}
		expect(broken).toEqual([]);
	});

	test('every tipo a node references resolves — foreign refs are the frozen, shrink-only list', () => {
		const found = foreignRefs(NODES);
		const unknown = [...found.keys()].filter((tipo) => FROZEN_FOREIGN_REFS[tipo] === undefined);
		expect(
			unknown.sort(),
			`NEW install-TLD reference(s) in the test ontology (frozen list: ${FOREIGN_REFS_PATH}). The law (plan decision 1) allows only test/test* + ${[...ALLOWED_TLDS].join(', ')}: clone the target into the test TLD instead of pointing at an install's node.`,
		).toEqual([]);
		// SHRINK-ONLY: a frozen ref may disappear (phase 2 clears them), never grow
		// a new site.
		const grown: string[] = [];
		for (const [tipo, sites] of found) {
			const frozen = FROZEN_FOREIGN_REFS[tipo]?.sites ?? [];
			for (const site of sites) if (!frozen.includes(site)) grown.push(`${tipo} @ ${site}`);
		}
		expect(grown.sort()).toEqual([]);
		// Measured 2026-08-19: 28 tipos / 41 sites. Only ≤ is asserted.
		expect(found.size).toBeLessThanOrEqual(Object.keys(FROZEN_FOREIGN_REFS).length);
	});

	test('anti-vacuity: the scanner sees the whole document and DOES flag a foreign ref', () => {
		// It really walks the blobs: the document is token-rich.
		const tokens = NODES.flatMap(
			(node) => JSON.stringify(node.properties ?? {}).match(TOKEN_RE) ?? [],
		);
		expect(tokens.length).toBeGreaterThan(200); // 298 today
		// And a planted install reference is caught (not silently allowed).
		const planted = foreignRefs([
			{ ...(NODES[0] as DdOntologyNode), tipo: 'test999999', parent: FROZEN.probe_tipo },
		]);
		expect([...planted.keys()]).toContain(FROZEN.probe_tipo);
	});

	// A diffusion_domain's TERM is an IDENTIFIER, not display text:
	// resolveDomainTipo (src/core/diffusion_bridge/diffusion_graph.ts) picks
	// dd1190's first child whose term equals DEDALO_DIFFUSION_DOMAIN. A clone
	// that copies an install's domain name into the `test` TLD therefore WINS
	// that match on the suite database and serves a truncated domain: FOUND, but
	// with an empty section map — vacuity that reads as "this install does not
	// diffuse". Generic-TLD law, applied to the one namespace matched by value.
	test('every diffusion_domain term is generic (test*) and unique', () => {
		const domains = NODES.filter((node) => node.model === 'diffusion_domain');
		expect(domains.length).toBeGreaterThan(5); // anti-vacuity: 11 today
		const foreign: string[] = [];
		const seen = new Map<string, string>();
		const collided: string[] = [];
		for (const node of domains) {
			for (const value of Object.values(node.term ?? {})) {
				if (!value.startsWith('test')) foreign.push(`${node.tipo}: '${value}'`);
				const other = seen.get(value);
				if (other !== undefined) collided.push(`'${value}': ${other} + ${node.tipo}`);
				seen.set(value, node.tipo);
			}
		}
		expect(
			foreign.sort(),
			"a test-TLD diffusion_domain named after an INSTALLATION: the term is what DEDALO_DIFFUSION_DOMAIN matches, so it must be tipo-derived ('<tipo> domain', scripts/clone_into_test_tld.ts genericDomainTerm)",
		).toEqual([]);
		expect(collided.sort()).toEqual([]);
	});
});

describe('test TLD ontology — the inverse parser (hermetic)', () => {
	test('every node maps into the components/columns the parser reads back', () => {
		const wrong: string[] = [];
		for (const node of NODES) {
			const columns = ontologyRecordFromNode(node) as Record<
				string,
				Record<string, { value?: unknown; lang?: string }[]>
			>;
			const tld = String(columns.data?.section_tipo ?? '').replace(/0$/, '');
			if (tld !== node.tld) wrong.push(`${node.tipo}: record section_tipo`);
			if (columns.string?.[ONTOLOGY_TLD]?.[0]?.value !== node.tld) {
				wrong.push(`${node.tipo}: ${ONTOLOGY_TLD} (tld) not in the string column`);
			}
			if (node.term !== null) {
				const langs = (columns.string?.[ONTOLOGY_TERM] ?? []).map((item) => item.lang).sort();
				if (JSON.stringify(langs) !== JSON.stringify(Object.keys(node.term).sort())) {
					wrong.push(`${node.tipo}: ${ONTOLOGY_TERM} (term) langs`);
				}
			}
			const hasParent = columns.relation?.[ONTOLOGY_PARENT] !== undefined;
			if (hasParent !== (node.parent !== null)) wrong.push(`${node.tipo}: ${ONTOLOGY_PARENT}`);
			const hasModel = columns.relation?.[ONTOLOGY_MODEL] !== undefined;
			if (hasModel !== (node.model_tipo !== null)) wrong.push(`${node.tipo}: ${ONTOLOGY_MODEL}`);
			const hasRelations = columns.relation?.[ONTOLOGY_CONNECTED_TO] !== undefined;
			if (hasRelations !== (node.relations?.length ?? 0) > 0) {
				wrong.push(`${node.tipo}: ${ONTOLOGY_CONNECTED_TO}`);
			}
			// The flags are ALWAYS written (a missing ontology8 parses as `true`).
			if (columns.relation?.[ONTOLOGY_TRANSLATABLE] === undefined) {
				wrong.push(`${node.tipo}: ${ONTOLOGY_TRANSLATABLE} missing`);
			}
			if (columns.relation?.[ONTOLOGY_IS_MODEL] === undefined) {
				wrong.push(`${node.tipo}: ${ONTOLOGY_IS_MODEL} missing`);
			}
			const hasOrder = columns.number?.[ONTOLOGY_ORDER] !== undefined;
			if (hasOrder !== (node.order_number !== null)) wrong.push(`${node.tipo}: ${ONTOLOGY_ORDER}`);
			const hasCss = columns.misc?.[ONTOLOGY_CSS] !== undefined;
			if (hasCss !== (node.properties !== null && 'css' in node.properties)) {
				wrong.push(`${node.tipo}: ${ONTOLOGY_CSS} (properties.css)`);
			}
			const hasSource = columns.misc?.[ONTOLOGY_SOURCE] !== undefined;
			if (hasSource !== (node.properties !== null && 'source' in node.properties)) {
				wrong.push(`${node.tipo}: ${ONTOLOGY_SOURCE} (properties.source)`);
			}
			const hasPropiedades = columns.misc?.[ONTOLOGY_PROPIEDADES_V5] !== undefined;
			if (hasPropiedades !== (node.propiedades !== null)) {
				wrong.push(`${node.tipo}: ${ONTOLOGY_PROPIEDADES_V5} (propiedades)`);
			}
		}
		expect(wrong).toEqual([]);
	});

	test('the import rewrite converges the fixture in ONE pass: L everywhere it applies, never C (T1-P05)', () => {
		// KERNEL precondition only — pure, no door, no DB: green whether or not the materializer
		// runs the rewrite. The door is guarded by the round-trip / dd_ontology compares, the
		// `zzmnd` scratch leg and G6's census leg (WC-2026-11-04 addendum 2026-11-13).
		const classes: Record<string, number> = { none: 0, L: 0, S: 0, C: 0 };
		const notFixed: string[] = [];
		for (const node of SOURCE_NODES) {
			const verdict = kernelVerdict(node);
			classes[verdict.class] = (classes[verdict.class] ?? 0) + 1;
			if (verdict.class !== 'L') continue;
			// The kernel over what the door stores answers `none`: a boot reconcile finds nothing.
			const columns = ontologyRecordFromNode(node) as RecordColumns;
			const again = convertCanonicalRecord({
				termItems:
					verdict.termItems ?? ((columns.string?.[ONTOLOGY_TERM] ?? []) as StoredLiteralItem[]),
				nameValues:
					verdict.machineName !== undefined
						? [verdict.machineName]
						: literalStrings(columns.string?.[ONTOLOGY_MACHINE_NAME] ?? null),
				flag: verdict.flag ?? flagFromItems(columns.relation?.[ONTOLOGY_USE_MACHINE_NAME] ?? null),
				nameClass: isNameClassNode(node),
			});
			if (again.class !== 'none') notFixed.push(`${node.tipo}: ${again.class}/${again.kind}`);
		}
		expect(notFixed).toEqual([]);
		// Measured 2026-11-13: L 8406 (8155 flag_no + 251 move), S 9, C 0. Floor, not pin.
		expect(classes.L).toBeGreaterThan(8000);
		expect(classes.C).toBe(0);
	});

	test('anti-vacuity: a node WITHOUT properties writes no properties component', () => {
		const bare = NODES.find((node) => node.properties === null) as DdOntologyNode;
		const columns = ontologyRecordFromNode(bare) as Record<string, Record<string, unknown>>;
		expect(columns.misc?.[ONTOLOGY_PROPERTIES]).toBeUndefined();
		expect(columns.string?.[ONTOLOGY_TLD]).toBeDefined();
	});
});

/**
 * THE FETCH PHASE — why this tier reads the database ONCE, up front.
 *
 * Until 2026-08-24 each database test below walked all 8477 nodes making
 * SEQUENTIAL round trips inside bun's DEFAULT 5000 ms per-test budget (a record
 * parse per node, a dd_ontology read per node, a table lookup per section:
 * ~17k awaited queries, ~0.6 ms allowed each). It did not report drift — it
 * TIMED OUT, which reports NOTHING and is indistinguishable in the totals from
 * a gate that found no problem.
 *
 * So the reads are batched here and every test below is a pure in-memory diff:
 *  - dd_ontology is ONE query for every declared TLD (was 8477 readDdOntologyRow
 *    + 33 searchDdOntology calls), normalized exactly as the single-row reader
 *    normalizes it;
 *  - the per-record parse has no batched form (the parser reads one record at a
 *    time, by design), so it keeps its per-record round trip but runs with
 *    bounded concurrency instead of one-at-a-time.
 *
 * NOTHING is checked less: every node is still parsed back from its own record
 * and still compared column by column with the engine's own `nodeDiffColumns`,
 * and `inspectOntology` still runs per TLD.
 *
 * Measured on this machine (2026-08-24, idle tier): fetch phase 1848 ms for 8477
 * nodes; each test below then runs in ~40 ms (whole file 3.41 s -> 2.19 s). The
 * budget below is DATA VOLUME, not a race — it is sized for a loaded tier, and
 * the phase does a fixed amount of work that never waits on another process.
 */
const FETCH_BUDGET_MS = 120_000;

/** The scratch tld of the import-rewrite leg (suite DB only, swept before and after). */
const SCRATCH_TLD = 'zzmnd';
/** Its name node's machine name. */
const SCRATCH_NAME = 'zzmnd_t';

/** Rows the scratch leg may leave: source records, projection, registry row, counter, TM. */
async function scratchResidue(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT (SELECT count(*) FROM matrix_ontology WHERE section_tipo = $1)
		      + (SELECT count(*) FROM dd_ontology WHERE tld = $2)
		      + (SELECT count(*) FROM matrix_ontology_main
		          WHERE section_tipo = 'ontology35' AND string @> $3::text::jsonb)
		      + (SELECT count(*) FROM matrix_counter WHERE tipo = $1)
		      + (SELECT count(*) FROM matrix_time_machine WHERE section_tipo = $1) AS n`,
		[`${SCRATCH_TLD}0`, SCRATCH_TLD, JSON.stringify({ hierarchy6: [{ value: SCRATCH_TLD }] })],
	)) as { n: number | string }[];
	return Number(rows[0]?.n ?? -1);
}
/** How many record parses may be in flight (pool-friendly; the pool queues the rest). */
const PARSE_CONCURRENCY = 16;

/** Every node that HAS a source record (the `<tld>0` main is minted by the rebuild). */
const SOURCE_NODES = NODES.filter((node) => node.is_main !== true);

/** dd_ontology rows for every declared TLD, by tipo. */
const STORED = new Map<string, DdOntologyRow>();
/** The tipos dd_ontology holds, per TLD (what `searchDdOntology({tld})` answers). */
const DB_TIPOS_BY_TLD = new Map<string, Set<string>>();
/** What each source record parses back into, by node tipo (null = no record / unparseable). */
const PARSED = new Map<string, DdOntologyNode | null>();
/** `inspectOntology(tld)` per declared TLD. */
const STATES = new Map<string, OntologyState>();
/** The matrix table each `section` node stores in. */
const TABLE_BY_TIPO = new Map<string, string | null>();

/** Run `worker` over `items` with at most `width` in flight. Order-independent. */
async function forEachConcurrent<T>(
	items: readonly T[],
	width: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const runner = async (): Promise<void> => {
		while (cursor < items.length) {
			const item = items[cursor++] as T;
			await worker(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(width, items.length) }, runner));
}

describe('test TLD ontology — the database is derived from the JSON', () => {
	beforeAll(async () => {
		// dd_ontology: ONE query for every declared TLD. Same columns and the same
		// order_number normalization `readDdOntologyRow` applies (the driver may
		// hand a numeric column back as a string).
		const rows = (await sql`
			SELECT tipo, parent, term, model, order_number, relations, tld,
			       properties, model_tipo, is_model, is_translatable, is_main, propiedades,
			       machine_name, use_machine_name
			FROM dd_ontology
			WHERE tld = ANY(string_to_array(${TLDS.join(',')}, ','))
		`) as DdOntologyRow[];
		for (const row of rows) {
			row.order_number =
				row.order_number === null || row.order_number === undefined
					? null
					: Math.trunc(Number(row.order_number));
			STORED.set(row.tipo, row);
			const tld = String(row.tld ?? '');
			const bucket = DB_TIPOS_BY_TLD.get(tld) ?? new Set<string>();
			bucket.add(row.tipo);
			DB_TIPOS_BY_TLD.set(tld, bucket);
		}
		// The record round trip: per record (no batched parser exists), concurrent.
		await forEachConcurrent(SOURCE_NODES, PARSE_CONCURRENCY, async (node) => {
			const sectionId = Number(getSectionIdFromTipo(node.tipo));
			PARSED.set(node.tipo, await parseSectionRecordToOntologyNode(`${node.tld}0`, sectionId));
		});
		// The engine's own drift verdict, per TLD.
		await forEachConcurrent(TLDS, 4, async (tld) => {
			STATES.set(tld, await inspectOntology(tld));
		});
		await forEachConcurrent(
			NODES.filter((node) => node.model === 'section' && node.is_main !== true),
			PARSE_CONCURRENCY,
			async (node) => {
				TABLE_BY_TIPO.set(node.tipo, await getMatrixTableFromTipo(node.tipo));
			},
		);
	}, FETCH_BUDGET_MS);

	test('the fixed component→column map still matches the ontology itself', async () => {
		const expected: Record<string, string> = {
			[ONTOLOGY_PARENT]: 'relation',
			[ONTOLOGY_MODEL]: 'relation',
			[ONTOLOGY_CONNECTED_TO]: 'relation',
			[ONTOLOGY_TRANSLATABLE]: 'relation',
			[ONTOLOGY_IS_MODEL]: 'relation',
			[ONTOLOGY_TERM]: 'string',
			[ONTOLOGY_TLD]: 'string',
			[ONTOLOGY_CSS]: 'misc',
			[ONTOLOGY_SOURCE]: 'misc',
			[ONTOLOGY_PROPERTIES]: 'misc',
			[ONTOLOGY_PROPIEDADES_V5]: 'misc',
			[ONTOLOGY_ORDER]: 'number',
		};
		for (const [tipo, column] of Object.entries(expected)) {
			const model = await getModelByTipo(tipo);
			expect(model, tipo).not.toBeNull();
			expect(getColumnNameByModel(String(model)), tipo).toBe(column);
		}
		// The machine-name pair (ontology43/44, master-defined 2026-11-03) reaches an
		// install through an ontology release: on one that does not carry them yet
		// BOTH are absent (the parser's legacy rungs cover it). Once present, they must
		// store where the inverse writes them — never one without the other.
		const machineName: Record<string, string> = {
			[ONTOLOGY_MACHINE_NAME]: 'string',
			[ONTOLOGY_USE_MACHINE_NAME]: 'relation',
		};
		const present: string[] = [];
		for (const [tipo, column] of Object.entries(machineName)) {
			const model = await getModelByTipo(tipo);
			if (model === null) continue;
			present.push(tipo);
			expect(getColumnNameByModel(model), tipo).toBe(column);
		}
		expect([0, 2], `machine-name components present: ${present.join(',')}`).toContain(
			present.length,
		);
	});

	test('every materialized record parses BACK into exactly its JSON node (round trip)', () => {
		let parsed = 0;
		const diffs: string[] = [];
		for (const node of SOURCE_NODES) {
			const back = PARSED.get(node.tipo) ?? null;
			if (back === null) {
				diffs.push(`${node.tipo}: no record / unparseable`);
				continue;
			}
			parsed++;
			if (back.tipo !== node.tipo) diffs.push(`${node.tipo}: parsed as ${back.tipo}`);
			const columns = nodeDiffColumns(back, materializedNode(node));
			if (columns.length > 0) diffs.push(`${node.tipo}: ${columns.join(',')}`);
		}
		expect(diffs).toEqual([]);
		expect(parsed).toBeGreaterThan(200); // anti-vacuity
	});

	test('dd_ontology equals the JSON node for node, and no TLD has drift', () => {
		for (const tld of TLDS) {
			const dbTipos = DB_TIPOS_BY_TLD.get(tld) ?? new Set<string>();
			const jsonTipos = new Set(NODES.filter((node) => node.tld === tld).map((node) => node.tipo));
			expect([...dbTipos].filter((tipo) => !jsonTipos.has(tipo)).sort(), `${tld}: extra`).toEqual(
				[],
			);
			expect([...jsonTipos].filter((tipo) => !dbTipos.has(tipo)).sort(), `${tld}: missing`).toEqual(
				[],
			);
			const state = STATES.get(tld) as OntologyState;
			expect(state.drift, `${tld} drift`).toEqual([]);
			expect(state.inSync, `${tld} inSync`).toBe(true);
		}
		const diffs: string[] = [];
		for (const node of NODES) {
			const row = STORED.get(node.tipo);
			if (row === undefined) {
				diffs.push(`${node.tipo}: absent`);
				continue;
			}
			const columns = nodeDiffColumns(materializedNode(node), row);
			if (columns.length > 0) diffs.push(`${node.tipo}: ${columns.join(',')}`);
		}
		expect(diffs).toEqual([]);
	});

	test('the door runs the import rewrite: a legacy-shaped node lands converted (zz scratch, T1-P05)', async () => {
		const live = await currentDatabaseName();
		const base = {
			order_number: null,
			relations: null,
			tld: SCRATCH_TLD,
			properties: null,
			is_model: false,
			is_translatable: true,
			is_main: false,
			propiedades: null,
		};
		// Legacy shape: the stated columns equal the legacy derivation, so the inverse
		// writes no ontology43/44 — the record a pre-7.0 package carries.
		const doc = {
			tld: SCRATCH_TLD,
			nodes: [
				{
					...base,
					tipo: `${SCRATCH_TLD}2`,
					parent: `${SCRATCH_TLD}0`,
					term: { 'lg-spa': 'Zzmnd etiqueta', 'lg-eng': 'Zzmnd label' },
					model: 'section',
					model_tipo: 'dd6',
					machine_name: null,
					use_machine_name: false,
				},
				{
					...base,
					tipo: `${SCRATCH_TLD}1`,
					parent: `${SCRATCH_TLD}2`,
					term: { 'lg-spa': SCRATCH_NAME },
					model: 'table',
					model_tipo: 'dd1229',
					machine_name: SCRATCH_NAME,
					use_machine_name: true,
				},
			] as DdOntologyNode[],
		};
		await sweepMachineNameScratch(SCRATCH_TLD);
		try {
			const result = await materializeTestTldOntology({ expectDatabase: live, doc });
			expect(result.nodes).toBe(2);
			const census = await censusMachineNames([SCRATCH_TLD]);
			expect(census.scanned).toBe(2); // floor: both records judged
			expect(census.classes).toEqual({ none: 2, L: 0, S: 0, C: 0 });
			const state = await inspectOntology(SCRATCH_TLD);
			expect(state.machineNameLegacyRungs).toEqual({
				derived_flag: 0,
				legacy_lang: 0,
				single_value: 0,
			});
			const rows = (await sql.unsafe(
				`SELECT tipo, term, machine_name, use_machine_name FROM dd_ontology
				  WHERE tld = $1 AND tipo <> $2 ORDER BY tipo`,
				[SCRATCH_TLD, `${SCRATCH_TLD}0`],
			)) as {
				tipo: string;
				term: Record<string, string> | null;
				machine_name: string | null;
				use_machine_name: boolean;
			}[];
			expect(rows).toEqual([
				{ tipo: `${SCRATCH_TLD}1`, term: null, machine_name: SCRATCH_NAME, use_machine_name: true },
				{
					tipo: `${SCRATCH_TLD}2`,
					term: { 'lg-spa': 'Zzmnd etiqueta', 'lg-eng': 'Zzmnd label' },
					machine_name: null,
					use_machine_name: false,
				},
			]);
		} finally {
			await sweepMachineNameScratch(SCRATCH_TLD);
		}
		expect(await scratchResidue()).toBe(0);
	});

	test('the door is FAIL-CLOSED about which database it writes to', async () => {
		// Anti-vacuity for the guard itself: without it this door would delete and
		// rewrite every `<tld>0` record of whatever database it was pointed at.
		// Neither call changes the connection — both refuse before writing.
		await expect(materializeTestTldOntology()).rejects.toThrow(/REFUSING to write to database/);
		await expect(
			materializeTestTldOntology({ expectDatabase: 'dedalo_definitely_not_this_database' }),
		).rejects.toThrow(/REFUSING to write to database/);
		// And it ACCEPTS the database the suite is connected to — asserted through
		// the guard's own criterion, without writing anything.
		const live = await currentDatabaseName();
		expect(live).not.toBe('');
		await expect(
			materializeTestTldOntology({ expectDatabase: live, doc: { tld: 'zzq', nodes: [] } }),
		).resolves.toEqual({ tlds: [], nodes: 0, rebuilt: [], strays: [], machineNames: [] });
	});

	test('every test SECTION stores in matrix_test (no test record in an install table)', () => {
		const wrong: string[] = [];
		let checked = 0;
		for (const node of NODES) {
			if (node.model !== 'section') continue;
			// `<tld>0` is the ONTOLOGY section itself: it lives in matrix_ontology by
			// the section_id='0' rule, and holds the TLD's own node records.
			if (node.is_main === true) continue;
			checked++;
			const table = TABLE_BY_TIPO.get(node.tipo) ?? null;
			if (table !== 'matrix_test') wrong.push(`${node.tipo} → ${table}`);
		}
		expect(
			wrong.sort(),
			'plan decision 1: every `test` section carries relations:[{tipo:"test24"}] so its records land in matrix_test.',
		).toEqual([]);
		expect(checked).toBeGreaterThan(0); // anti-vacuity: 5 sections today
	});
});
