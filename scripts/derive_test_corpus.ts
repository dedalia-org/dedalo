/**
 * DERIVE THE TEST CORPUS from the frozen oracle-harvest store (generic `test`
 * TLD migration, phase 3). HERMETIC: reads only committed files, touches no
 * database, and writes `src/core/test_data/test_corpus/`.
 *
 *   bun run scripts/derive_test_corpus.ts [--check]
 *
 * WHAT IT DOES. Every interaction body in
 * `test/parity/fixtures/oracle_harvest/*.json` was captured at ONE instant
 * (2026-07-11) against ONE install, so the records the store REVEALS are
 * mergeable into a single corpus. For each `(section_tipo, section_id)` the
 * walk collects the component values the store shows, keeps the richest
 * source per component, rewrites every tipo AND every section_id through the
 * phase-2 clone map, and emits the result as `matrix_test` record columns.
 *
 * SOURCE PRIORITY (a component seen twice keeps the better source):
 *   3 raw   — `read_raw` (raw jsonb columns; the ONLY complete-record source)
 *   2 edit  — `get_data`/`read` in `mode:'edit'`, `resolve_data`, ts node reads
 *   1 list  — list-mode projections (lang-sliced, quality-reduced, truncated)
 * Anything below `raw` is a PROJECTION of the stored value, never the stored
 * value itself, so every record that is not sourced from `read_raw` carries
 * `reconstructed: true` and every gate reading it must treat missing
 * components as unknown, not as empty.
 *
 * WHERE A RECORD MAY LIVE (amended 2026-08-19). The suite runs on a separate,
 * disposable database, so safety comes from the database, not from cloning: a
 * record may live in a SEED-SHIPPED section (`rsc170`, `rsc205`, `dd128`,
 * `dd542`…) kept in place, because those exist on every installation. Cloning
 * into `test` stays mandatory for install-only TLDs. What is still refused
 * there is what would REWRITE an installation rather than add to it.
 *
 * REFUSALS (`refused.json` — listed, never silently dropped):
 *   never_revealed              the pair is addressed but no body shows its data
 *   engine_owned_table          the section's records ARE the engine's own
 *                               definition/audit store (`matrix_ontology`,
 *                               `matrix_ontology_main`, `matrix_hierarchy_main`,
 *                               `matrix_time_machine`, `matrix_langs`): a
 *                               derived row there would register a TLD, a
 *                               hierarchy or a language that is not installed.
 *   seed_shipped_record         the pair's id is one the INSTALL SEED ships
 *                               (`dd64/1`, a language, the admin user). The
 *                               record is already on every install and every
 *                               locator naming it resolves — writing an
 *                               install's copy over it would replace shipped
 *                               configuration with data.
 *   install_tld_ontology_main   a `<tld>0` section of an install TLD: its
 *                               records are that install's ontology definitions.
 *   no_ontology_clone           the section has no ontology source at all —
 *                               phase 2b twinned every one a gate addresses
 *                               (manifest `synthetic_thesauri`), so this class
 *                               must stay EMPTY; an entry is a punch-list item.
 *   test_fixture_owned          an already-`test` record: the canonical test3
 *                               fixture owns it (src/core/test_data/seed.ts).
 *   non_numeric_section_id      `search_1`, `0`, `-1`: an addressing artefact.
 *   component_tipo_unmapped / dangling_locator / no_storage_column /
 *   media_path_not_engine_shaped: per-item.
 *
 * THE ID MAP (`test_corpus/id_map.json`) is emitted for phase 4: ids are FREE
 * inside `matrix_test` (every test section stores there and no install record
 * can collide), so a source id is KEPT whenever the target section is not
 * already using it, and only a genuine collision allocates. It covers every
 * pair the store addresses — including pairs with no record — because a
 * locator must be rewritable even when its target record is not in the corpus.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { getComponentModel } from '../src/core/components/registry.ts';
import { compareLocators, type Locator } from '../src/core/concepts/locator.ts';
import { MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn } from '../src/core/db/matrix.ts';

const REPO = dirname(import.meta.dir);
const STORE = join(REPO, 'test/parity/fixtures/oracle_harvest');
const TEST_DATA = join(REPO, 'src/core/test_data');
const COMMITTED_DIR = join(TEST_DATA, 'test_corpus');

/**
 * `--check` VERIFIES instead of regenerating: the whole derivation runs into a
 * temporary tree, is formatted exactly as a real run formats it, and is then
 * diffed against the committed corpus. Nothing under `test_corpus/` is touched,
 * and drift exits non-zero.
 *
 * The flag was advertised in this header from the start and was never wired
 * (review 2026-08-20): `--check` silently REGENERATED, deleting and rewriting
 * the very files a caller asked it only to inspect. Harmless while the
 * derivation is deterministic — which is exactly the property a checker exists
 * to stop trusting.
 */
const CHECK = process.argv.includes('--check');
const OUT_DIR = CHECK ? mkdtempSync(join(tmpdir(), 'dedalo_corpus_check_')) : COMMITTED_DIR;

/**
 * The install-invariant TLDs. Phase 2 clones nothing from them (a test node
 * references them in place) — and since 2026-08-19 (the AMENDED record-surface
 * decision) a RECORD may live in one of their sections too: the suite runs on a
 * separate, disposable database, and those sections ship on every installation,
 * so a corpus record in `rsc170` is as portable as one in `testmint1`.
 */
const ALLOWED_TLDS = new Set(['dd', 'rsc', 'hierarchy', 'ontology', 'ontologytype', 'lg']);

/* ------------------------------------------------- the seed (hermetic) */

/**
 * The install seed is READ, never written: it is the same vendored file the
 * clone script parses, and it answers the two questions the amended law asks of
 * an allowed-TLD section —
 *
 *  1. WHICH TABLE does it store in (`matrix`, `matrix_dd`, `matrix_users`…)?
 *     A corpus record must be inserted where the engine will look for it.
 *  2. WHICH IDS does the seed itself already occupy? An installation ships
 *     `dd64/1` (Yes), `lg1/1…21710` (the languages), `dd128/1` (the admin) —
 *     writing "our" record over one of those would replace shipped
 *     configuration with an install's copy of it, so those pairs are REFUSED
 *     (`seed_shipped_record`): the record is already there on every install,
 *     and every locator that names it resolves without us.
 */
const SEED_PATH = join(REPO, 'install/db/dedalo_install.pgsql.gz');

interface SeedNode {
	model: string | null;
	relations: { tipo: string }[] | null;
	/**
	 * The node's NAME: its `machine_name` column (migration 0015) when the seed
	 * carries it, else `term['lg-spa']` (the legacy rung,
	 * src/core/ontology/machine_name.ts) — a `matrix_table` node's name IS the table name.
	 */
	term: string | null;
}
const seedNodes = new Map<string, SeedNode>();
/** `<table>|<section_tipo>` → the record ids the seed ships. */
const seedIds = new Map<string, Set<number>>();

function loadSeed(): void {
	const text = gunzipSync(readFileSync(SEED_PATH)).toString('utf8');
	let table: string | null = null;
	let columns: string[] = [];
	for (const line of text.split('\n')) {
		if (table === null) {
			const header = /^COPY public\.([a-z_0-9]+) \(([^)]*)\) FROM stdin;/.exec(line);
			if (header === null) continue;
			table = header[1] as string;
			columns = (header[2] as string).split(',').map((column) => column.trim().replace(/"/g, ''));
			continue;
		}
		if (line.startsWith('\\.')) {
			table = null;
			continue;
		}
		const fields = line.split('\t');
		if (table === 'dd_ontology') {
			const tipo = fields[columns.indexOf('tipo')];
			if (tipo === undefined || tipo === '') continue;
			const relations = fields[columns.indexOf('relations')] ?? '\\N';
			let parsed: { tipo: string }[] | null = null;
			if (relations !== '\\N' && relations !== 'null') {
				try {
					parsed = JSON.parse(relations) as { tipo: string }[];
				} catch {
					parsed = null;
				}
			}
			const model = fields[columns.indexOf('model')] ?? '\\N';
			const rawTerm = fields[columns.indexOf('term')] ?? '\\N';
			const machineNameAt = columns.indexOf('machine_name');
			const rawMachineName = machineNameAt === -1 ? '\\N' : (fields[machineNameAt] ?? '\\N');
			let term: string | null = rawMachineName === '\\N' ? null : rawMachineName;
			if (term === null && rawTerm !== '\\N') {
				try {
					term = (JSON.parse(rawTerm) as Record<string, string>)['lg-spa'] ?? null;
				} catch {
					term = null;
				}
			}
			seedNodes.set(tipo, { model: model === '\\N' ? null : model, relations: parsed, term });
			continue;
		}
		if (!table.startsWith('matrix_') && table !== 'matrix') continue;
		const tipoIndex = columns.indexOf('section_tipo');
		const idIndex = columns.indexOf('section_id');
		if (tipoIndex < 0 || idIndex < 0) continue;
		const sectionTipo = fields[tipoIndex];
		const id = Number(fields[idIndex]);
		if (sectionTipo === undefined || !Number.isInteger(id)) continue;
		const key = `${table}|${sectionTipo}`;
		let bucket = seedIds.get(key);
		if (bucket === undefined) {
			bucket = new Set();
			seedIds.set(key, bucket);
		}
		bucket.add(id);
	}
}
loadSeed();

/** A seed node's term, the way the ontology parser reads a model name. */
const seedModel = (tipo: string): string | null => seedNodes.get(tipo)?.model ?? null;

/**
 * The matrix table an ALLOWED-TLD section stores in — the offline mirror of
 * `getMatrixTableFromTipo` (resolver.ts:636): the `<tld>0` rule, the two PHP
 * fixed cases, the matrix_table relation, then the virtual-section fallback,
 * then the default `matrix`.
 */
const seedTableCache = new Map<string, string | null>();
function seedTableOf(sectionTipo: string, depth = 0): string | null {
	const cached = seedTableCache.get(sectionTipo);
	if (cached !== undefined) return cached;
	let table: string | null;
	if (/^[a-z_]+0$/.test(sectionTipo)) {
		// The `<tld>0` rule: the section_id PART is 0 (`rsc170` is not one).
		table = 'matrix_ontology';
	} else if (sectionTipo === 'dd153') {
		table = 'matrix_projects';
	} else if (sectionTipo === 'dd128') {
		table = 'matrix_users';
	} else {
		const node = seedNodes.get(sectionTipo);
		if (node === null || node === undefined || node.model !== 'section') {
			table = null;
		} else {
			table = null;
			for (const relation of node.relations ?? []) {
				const related = seedNodes.get(relation.tipo);
				if (related?.model !== 'matrix_table') continue;
				const term = seedNodes.get(relation.tipo)?.term ?? null;
				if (term !== null) table = term;
				break;
			}
			if (table === null && depth < 4) {
				for (const relation of node.relations ?? []) {
					if (seedNodes.get(relation.tipo)?.model !== 'section') continue;
					table = seedTableOf(relation.tipo, depth + 1);
					break;
				}
			}
			if (table === null) table = 'matrix';
		}
	}
	seedTableCache.set(sectionTipo, table);
	return table;
}

/**
 * ENGINE-OWNED TABLES: a section whose records ARE the engine's own definition
 * or audit store. A derived record there does not add data, it rewrites the
 * installation — so those pairs are refused with the reason, never written.
 */
const ENGINE_OWNED_TABLES: Readonly<Record<string, string>> = {
	matrix_ontology: 'the ontology definition records — written by rebuildOntology, never derived',
	matrix_ontology_main:
		'the TLD registry — a fabricated row would register a TLD that is not there',
	matrix_hierarchy_main:
		'the hierarchy registry — authored by test_corpus/ensure.ts (testHierarchyRegistry), the single writer',
	matrix_time_machine: 'the audit store — the corpus carries its rows in tm.json, not as records',
	matrix_langs: 'the language table — 21 705 seed rows; a language is shipped, never derived',
};

/**
 * Models whose value is COMPUTED at read: the body shows a value that was
 * never stored, so writing it back would fabricate data.
 */
const COMPUTED_MODELS = new Set([
	'component_info',
	'component_inverse',
	'component_section_id',
	'component_calculation',
	'component_state',
	'component_alias',
	'component_time_machine',
	'component_tools',
]);

/**
 * THE MATRIX COLUMN a model stores in — following the ONE alias hop the
 * component registry guarantees is total (`component_autocomplete` →
 * `component_portal`, `component_html_text` → `component_text_area`,
 * `component_input_text_large` → `component_text_area`,
 * `component_security_tools` → `component_check_box`). Reading
 * `descriptor.column` directly made every ALIAS-NAMED component look like it
 * stored nothing (`no_storage_column`), so its stored items were dropped and a
 * record whose only storable value was one of them was lost entirely
 * (`rsc332/40507`, whose `rsc368` portal locators the frozen page shows in full).
 * The registry's own integrity check refuses an alias that points at a model
 * with no column, so one hop is the whole chain.
 */
function storageColumnOf(model: string): string | undefined {
	const descriptor = getComponentModel(model);
	if (descriptor === undefined) return undefined;
	if (descriptor.column !== undefined) return descriptor.column;
	if (descriptor.alias === undefined) return undefined;
	return getComponentModel(descriptor.alias)?.column;
}

/**
 * Media URLs embedded in rich text (kept verbatim, listed as a hole).
 *
 * NOT `/g`. A `/g` regex carries `lastIndex` between calls, so `.test()` on a
 * sequence of strings starts each probe wherever the previous one stopped and
 * answers false for URLs that ARE there — the punch list then under-reports the
 * holes it exists to count (review 2026-08-20). Matching still uses a `/g`
 * clone, built per call, where a global scan is genuinely wanted.
 */
const MEDIA_URL_RE =
	/(?:\/dedalo)?\/media\/[^"'\s<>)]+?\.(?:jpg|jpeg|png|avif|webp|gif|svg|mp4|mp3|webm|mov|pdf|wav|ogg)/i;

/** A fresh global matcher — never shared, so no `lastIndex` survives a call. */
function mediaUrlsIn(text: string): string[] {
	return text.match(new RegExp(MEDIA_URL_RE.source, 'gi')) ?? [];
}

/** Every key whose VALUE is a tipo and must move with the clone map. */
const TIPO_KEYS = new Set([
	'tipo',
	'type',
	'from_component_tipo',
	'main_component_tipo',
	'component_tipo',
	'from_component_top_tipo',
	'parent_tipo',
	'model_tipo',
]);

/** Keys a read adds to a stored item — stripped on the way back to storage. */
const DERIVED_ITEM_KEYS = new Set(['paginated_key', 'parent', 'is_model']);

// This script walks FROZEN oracle bodies — arbitrary, externally-shaped JSON
// whose type is exactly "unknown JSON". Typing it `unknown` would put a cast on
// every one of the ~80 reads below and buy no safety: the shape checks
// (isObject / isLocator) are the real gate, and they are explicit.
// biome-ignore lint/suspicious/noExplicitAny: see above
type Json = any;
interface Interaction {
	kind: string;
	rqo: Json;
	status: number;
	body?: Json;
	text?: string;
}

const isObject = (v: unknown): v is Record<string, Json> =>
	v !== null && typeof v === 'object' && !Array.isArray(v);
const tldOf = (tipo: string): string => tipo.replace(/\d+$/, '');
const pairKey = (sectionTipo: string, sectionId: string | number) => `${sectionTipo}_${sectionId}`;

const isLocator = (o: Json): boolean =>
	isObject(o) &&
	typeof o.section_tipo === 'string' &&
	/^[a-z_]+\d+$/.test(o.section_tipo) &&
	(typeof o.section_id === 'string' || typeof o.section_id === 'number');

/* ------------------------------------------------------------- the maps */

const tipoMapDoc = JSON.parse(readFileSync(join(TEST_DATA, 'test_tld_tipo_map.json'), 'utf8')) as {
	map: Record<string, { target: string; reason: string }>;
};
const TIPO_MAP = new Map<string, string>();
/**
 * The SYNTHETIC twins (phase 2b) are `hierarchy20` clones: ONE seed component
 * (`hierarchy25`, the term) becomes a DIFFERENT component in every twin, so the
 * map keys those entries `<source section>@<seed tipo>`. A record of that
 * source section therefore maps its component tipos through this table FIRST —
 * a plain `mapTipo` would keep `hierarchy25` (an allowed TLD) in place and the
 * item would land on a component the twin does not have.
 */
const SECTION_COMPONENT_MAP = new Map<string, Map<string, string>>();
for (const [source, entry] of Object.entries(tipoMapDoc.map)) {
	const at = source.indexOf('@');
	if (at < 0) {
		TIPO_MAP.set(source, entry.target);
		continue;
	}
	const section = source.slice(0, at);
	const tipo = source.slice(at + 1);
	let bucket = SECTION_COMPONENT_MAP.get(section);
	if (bucket === undefined) {
		bucket = new Map();
		SECTION_COMPONENT_MAP.set(section, bucket);
	}
	bucket.set(tipo, entry.target);
}

const ontologyDoc = JSON.parse(readFileSync(join(TEST_DATA, 'test_tld_ontology.json'), 'utf8')) as {
	nodes: { tipo: string; model: string; is_main?: boolean }[];
};
const MODEL_OF = new Map<string, string>(ontologyDoc.nodes.map((n) => [n.tipo, n.model]));
const TEST_SECTIONS = new Set(
	ontologyDoc.nodes.filter((n) => n.model === 'section' && n.is_main !== true).map((n) => n.tipo),
);

/**
 * A tipo's clone, or the tipo itself when it is structure kept in place.
 * `inSection` is the SOURCE section the tipo was read from: inside a synthetic
 * twin's record its components are that twin's, not the seed's.
 */
function mapTipo(tipo: string, inSection?: string): string | null {
	if (inSection !== undefined) {
		const scoped = SECTION_COMPONENT_MAP.get(inSection)?.get(tipo);
		if (scoped !== undefined) return scoped;
	}
	const mapped = TIPO_MAP.get(tipo);
	if (mapped !== undefined) return mapped;
	if (ALLOWED_TLDS.has(tldOf(tipo))) return tipo;
	if (MODEL_OF.has(tipo)) return tipo; // already a test tipo
	return null;
}

type SectionVerdict =
	| {
			ok: true;
			target: string;
			/**
			 * `test`  — a phase-2 clone: stores in `matrix_test`, ids are free.
			 * `seed`  — an install-invariant section kept in place (the amended
			 *           record-surface law): stores in ITS OWN table, and the ids
			 *           the seed ships are not ours to take.
			 */
			kind: 'test' | 'seed';
			table: string;
	  }
	| {
			ok: false;
			reason:
				| 'engine_owned_table'
				| 'install_tld_ontology_main'
				| 'no_ontology_clone'
				| 'test_fixture_owned'
				| 'mapped_target_is_not_a_section';
			detail?: string;
	  };

const sectionVerdictCache = new Map<string, SectionVerdict>();
function classifySection(sectionTipo: string): SectionVerdict {
	const cached = sectionVerdictCache.get(sectionTipo);
	if (cached !== undefined) return cached;
	let verdict: SectionVerdict;
	const mapped = TIPO_MAP.get(sectionTipo);
	if (mapped !== undefined) {
		verdict = TEST_SECTIONS.has(mapped)
			? { ok: true, target: mapped, kind: 'test', table: 'matrix_test' }
			: { ok: false, reason: 'mapped_target_is_not_a_section' };
	} else if (TEST_SECTIONS.has(sectionTipo)) {
		// An already-`test` section: the hand-authored fixture owns its records.
		verdict = { ok: false, reason: 'test_fixture_owned' };
	} else if (ALLOWED_TLDS.has(tldOf(sectionTipo))) {
		// THE AMENDED LAW (2026-08-19): a seed-shipped section IS a record
		// surface — unless its records are the engine's own definitions.
		const table = seedTableOf(sectionTipo);
		if (table === null) {
			verdict = {
				ok: false,
				reason: 'no_ontology_clone',
				detail: `'${sectionTipo}' is not a section in the seed ontology`,
			};
		} else if (ENGINE_OWNED_TABLES[table] !== undefined) {
			verdict = {
				ok: false,
				reason: 'engine_owned_table',
				detail: `${table}: ${ENGINE_OWNED_TABLES[table]}`,
			};
		} else {
			verdict = { ok: true, target: sectionTipo, kind: 'seed', table };
		}
	} else if (/^[a-z_]+0$/.test(sectionTipo)) {
		// A `<tld>0` ontology main of an install TLD: its records are that
		// install's ontology definitions, and the test TLDs have their own.
		verdict = { ok: false, reason: 'install_tld_ontology_main' };
	} else {
		verdict = { ok: false, reason: 'no_ontology_clone' };
	}
	sectionVerdictCache.set(sectionTipo, verdict);
	return verdict;
}

/* ---------------------------------------------------------- the id map */

interface IdMapEntry {
	section_tipo: string;
	section_id: number;
	kept: boolean;
}
const ID_MAP = new Map<string, IdMapEntry>();
const usedIds = new Map<string, Set<number>>();
const nextFree = new Map<string, number>();

/** Source pair → test pair. Keeps the source id when the slot is free. */
function idFor(sectionTipo: string, sectionId: string | number): IdMapEntry | null {
	const key = pairKey(sectionTipo, sectionId);
	const cached = ID_MAP.get(key);
	if (cached !== undefined) return cached;
	const verdict = classifySection(sectionTipo);
	if (!verdict.ok) return null;
	const numeric = Number(sectionId);
	if (!Number.isInteger(numeric) || numeric <= 0) return null;
	if (verdict.kind === 'seed') {
		// A seed section is kept IN PLACE: the section tipo and the id are the
		// install's own, and no other source maps onto it, so the identity is
		// the mapping. (Whether the RECORD may be written there is a separate
		// question — see `seed_shipped_record`.)
		const identity: IdMapEntry = { section_tipo: sectionTipo, section_id: numeric, kept: true };
		ID_MAP.set(key, identity);
		return identity;
	}
	let used = usedIds.get(verdict.target);
	if (used === undefined) {
		used = new Set();
		usedIds.set(verdict.target, used);
	}
	let id = numeric;
	let kept = true;
	if (used.has(numeric)) {
		kept = false;
		id = Math.max(nextFree.get(verdict.target) ?? 1, numeric + 1);
		while (used.has(id)) id++;
		nextFree.set(verdict.target, id + 1);
	}
	used.add(id);
	const entry: IdMapEntry = { section_tipo: verdict.target, section_id: id, kept };
	ID_MAP.set(key, entry);
	return entry;
}

/* -------------------------------------------------------- accumulators */

type SourceRank = 1 | 2 | 3;
interface CollectedItem {
	tipo: string;
	entries: Json;
	rank: SourceRank;
	model: string | null;
	lang: string | null;
	gate: string;
}
interface CollectedRecord {
	sectionTipo: string;
	sectionId: string;
	/** component tipo → best item per (tipo, lang) */
	items: Map<string, CollectedItem>;
	gates: Set<string>;
	rawColumns: Record<string, Json> | null;
	bestRank: SourceRank;
}
const collected = new Map<string, CollectedRecord>();
function record(sectionTipo: string, sectionId: string | number): CollectedRecord {
	const key = pairKey(sectionTipo, sectionId);
	let found = collected.get(key);
	if (found === undefined) {
		found = {
			sectionTipo,
			sectionId: String(sectionId),
			items: new Map(),
			gates: new Set(),
			rawColumns: null,
			bestRank: 1,
		};
		collected.set(key, found);
	}
	return found;
}

interface Refusal {
	kind: string;
	source: string;
	detail: string;
	gates: string[];
}
const refusals: Refusal[] = [];
const refusalIndex = new Map<string, Refusal>();
function refuse(kind: string, source: string, detail: string, gate: string): void {
	const key = `${kind}|${source}|${detail}`;
	const existing = refusalIndex.get(key);
	if (existing !== undefined) {
		if (!existing.gates.includes(gate)) existing.gates.push(gate);
		return;
	}
	const entry: Refusal = { kind, source, detail, gates: [gate] };
	refusalIndex.set(key, entry);
	refusals.push(entry);
}

/**
 * FIDELITY CENSUS (gap 3): how many written (record, component) pairs carry the
 * STORED bytes versus a read projection, and how often a richer source actually
 * displaced a poorer one (the preference winning, measured rather than assumed).
 */
const sourceCensus = { raw: 0, edit: 0, list: 0 };
let sourceUpgrades = 0;
let sourcePreferenceHeld = 0;

/** Pairs whose ONLY reveal is a resolved term LABEL (get_section_terms). */
const termLabelOnly = new Set<string>();

/* ------------------------------------------------------- inverse edges */

/**
 * THE INVERSE EDGE (2026-08-19, phase-4 corpus gap 1).
 *
 * A record is otherwise rebuilt from ITS OWN read projections — so a locator
 * that lives on record A and points at record B is invisible while walking B,
 * and every index / inverse / children gate resolves 0 items on the corpus.
 * But the store DOES reveal it, from the other end: a computed inverse item
 * (`component_relation_index`, PHP `parse_data`) emits one entry per POINTING
 * locator —
 *
 *   {type, section_tipo, section_id, from_component_top_tipo}
 *      ↑ dd96   ↑ the POINTING record's address   ↑ the component holding it
 *
 * read on the item of the record being POINTED AT. That is a complete locator
 * statement about ANOTHER record, so the derive materializes it there: the
 * pointing record's `relation` column gains
 * `{id, type, section_tipo:<target>, section_id:<target>, from_component_tipo}`
 * and the `matrix_*_relation_index_sync` trigger indexes it exactly as a real
 * save would.
 *
 * `from_component_top_tipo` is the ONLY key `parseInverseEntry` ever writes
 * (src/core/resolve/relation_index.ts) and a STORED item always carries its own
 * `id`, so "every element has `from_component_top_tipo` and none has `id`" is
 * an exact discriminator for the inverse shape — never a stored value.
 *
 * AUDIT TRAIL: every edge is listed on the pointing record as
 * `inverse_edges[]` with `origin:'inverse_edge'` and the (gate, revealing
 * record, revealing component) that stated it, so a sweeper can tell a derived
 * pointer from a value the store showed directly. Nothing is guessed: an edge
 * whose pointing record has no ontology clone, whose component does not map or
 * does not store in a jsonb column, or whose target is unmappable is REFUSED
 * (`inverse_edge_*` in refused.json), never approximated.
 */
interface InverseEdge {
	/** The record that HOLDS the locator (already in this install's terms). */
	pointing: { section_tipo: string; section_id: string };
	/** The record it points AT — the one whose item revealed the edge. */
	target: { section_tipo: string; section_id: string };
	/**
	 * `from_component_top_tipo`: the component the locator is stored under.
	 *
	 * VERIFIED 2026-08-21 against the engine, after a review suspected this of
	 * conflating two different keys: `parseInverseEntry`
	 * (src/core/resolve/relation_index.ts) sets
	 * `entry.from_component_top_tipo = raw.from_component_tipo` — the inverse
	 * entry's key IS the stored locator's storing component, passed through
	 * verbatim. Reading it as the storing component is exact, not an assumption,
	 * and it holds for a portal-hosted storer too, because the engine copies the
	 * same field whatever hosts it.
	 */
	componentTipo: string;
	/** The relation type (`dd96` for an indexation, `dd151` for a plain link). */
	type: string | null;
	/** Optional tag pairing (`tag_component_tipo` / `tag_id`) and top address. */
	extra: Record<string, Json>;
	/** Where the statement was read (provenance, for the audit trail). */
	revealedBy: { section_tipo: string; section_id: string; tipo: string; gate: string };
}
/** pointing pairKey → its edges (deduped by the full locator identity). */
const inverseEdges = new Map<string, InverseEdge[]>();
const inverseEdgeSeen = new Set<string>();
/** Pairs whose ONLY reveal is an inverse edge (no body ever showed their data). */
const edgeOnlyRecords = new Set<string>();

/** True when `entries` is a page of computed INVERSE locators, not stored items. */
function isInverseEntryPage(entries: Json): boolean {
	if (!Array.isArray(entries) || entries.length === 0) return false;
	return entries.every(
		(one: Json) =>
			isObject(one) &&
			typeof one.from_component_top_tipo === 'string' &&
			one.id === undefined &&
			isLocator(one),
	);
}

/**
 * Read one revealed inverse page into `inverseEdges`. `owner` is the record the
 * item belongs to (the record being pointed AT).
 */
function collectInverseEdges(
	owner: { section_tipo: string; section_id: string },
	tipo: string,
	entries: Json,
	gate: string,
): void {
	if (!isInverseEntryPage(entries)) return;
	for (const entry of entries as Record<string, Json>[]) {
		const pointingTipo = String(entry.section_tipo);
		const pointingId = String(entry.section_id);
		address(pointingTipo, pointingId, gate);
		const extra: Record<string, Json> = {};
		// parse_data's inverse of the three optional passthroughs.
		if (entry.component_tipo !== undefined) extra.tag_component_tipo = entry.component_tipo;
		if (entry.tag_id !== undefined) extra.tag_id = entry.tag_id;
		if (entry.section_top_tipo !== undefined) extra.section_top_tipo = entry.section_top_tipo;
		if (entry.section_top_id !== undefined) extra.section_top_id = entry.section_top_id;
		const edge: InverseEdge = {
			pointing: { section_tipo: pointingTipo, section_id: pointingId },
			target: { section_tipo: owner.section_tipo, section_id: owner.section_id },
			componentTipo: String(entry.from_component_top_tipo),
			type: typeof entry.type === 'string' ? entry.type : null,
			extra,
			revealedBy: { ...owner, tipo, gate },
		};
		const identity = [
			`${pointingTipo}/${pointingId}`,
			edge.componentTipo,
			edge.type ?? '',
			`${owner.section_tipo}/${owner.section_id}`,
			JSON.stringify(extra),
		].join('|');
		if (inverseEdgeSeen.has(identity)) continue;
		inverseEdgeSeen.add(identity);
		const key = pairKey(pointingTipo, pointingId);
		let bucket = inverseEdges.get(key);
		if (bucket === undefined) {
			bucket = [];
			inverseEdges.set(key, bucket);
		}
		bucket.push(edge);
	}
}

/* --------------------------------------------- media identity statements */

/**
 * THE MEDIA IDENTITY (2026-08-19, phase-4 corpus gap 3).
 *
 * A media component stores almost nothing in the row: its value IS the file on
 * disk, and the read pipeline SCANS the media tree and emits one `files_info`
 * entry per quality that exists. So the derive can never rebuild a media
 * component by writing a column — it has to plant the FILES, which is what
 * `test_corpus/files_info.json` + `ensureMediaKit()` are for. Until now the
 * only paths that got there were the ones inside a component the derive also
 * managed to STORE (an `edit`-mode component_av item's nested `files_info`);
 * every path revealed by a LIST projection — the overwhelming majority, and
 * every `component_image` page there is — died with the projection under
 * `list_projection_not_storable`, so a portal that expands into an image
 * component emitted nothing and the gate reading it saw a short answer.
 *
 * A media identity is a fact of its own, independent of whether the item
 * holding it was storable, and the store states it in exactly two shapes:
 *
 *  1. a `files_info` entry — `{file_path, file_size, file_time, file_exist}`.
 *     `file_exist: true` is the oracle SAYING the file was on disk, and
 *     `file_size`/`file_time` are that file's `stat`, so the kit can
 *     reproduce them rather than approximate them.
 *  2. `posterframe_url` / `base_svg_url` — the two derived-media URLs the read
 *     emits. Both are EXISTENCE-CHECKED (src/core/media/component_emit.ts:
 *     `existsSync(location.absolutePath) ? url : null`), so a non-null value
 *     is the same statement in URL form. `subtitles_url` is NOT checked (pure
 *     grammar) and is therefore never harvested.
 *
 * Nothing else counts: a media URL inside rich TEXT stays a
 * `media_reference_in_text` hole, because the text is payload and says nothing
 * about the disk.
 */
interface MediaStatement {
	/** `file_size` from the oracle's stat, when the shape carried one. */
	size: number | null;
	/** `file_time.timestamp` — the file's mtime, same source. */
	timestamp: string | null;
	/** The whole `file_time` object, as the read emits it. */
	time: Json;
	/** Which of the two shapes stated it (provenance, for the audit trail). */
	origin: 'files_info' | 'derived_url';
	gate: string;
}
/** RAW (install-terms) media path → what the store said about the file. */
const mediaStatements = new Map<string, MediaStatement>();

/** `/dedalo/media/av/…` or `/media/av/…` → `/av/…`; null when not a media URL. */
function mediaPathFromUrl(url: string): string | null {
	const match = /^(?:\/[a-z_0-9-]+)?\/media(\/.+)$/.exec(url);
	return match === null ? null : (match[1] as string);
}

/** Read one body object for the two media-identity shapes. */
function collectMediaStatement(o: Record<string, Json>, gate: string): void {
	if (typeof o.file_path === 'string' && o.file_path.startsWith('/') && o.file_exist === true) {
		const stated: MediaStatement = {
			size: typeof o.file_size === 'number' ? o.file_size : null,
			timestamp:
				isObject(o.file_time) && typeof o.file_time.timestamp === 'string'
					? o.file_time.timestamp
					: null,
			time: o.file_time ?? null,
			origin: 'files_info',
			gate,
		};
		const held = mediaStatements.get(o.file_path);
		if (held === undefined) {
			mediaStatements.set(o.file_path, stated);
		} else if (held.timestamp !== stated.timestamp || held.size !== stated.size) {
			/**
			 * TWO FIXTURES DISAGREE ABOUT ONE FILE. The store is pinned to one
			 * instant only nominally: an earlier-harvested gate can carry an
			 * earlier state of the same file (the install re-uploaded it between
			 * captures). A file has ONE size and ONE mtime, so the corpus must
			 * choose — and it chooses the LATEST mtime, the state closest to the
			 * pinned final harvest, keeping the loser listed by name. Whichever
			 * gate asserted the older stat is red BY THE STORE'S OWN
			 * CONTRADICTION, not by a corpus gap.
			 */
			const newer = (stated.timestamp ?? '') > (held.timestamp ?? '');
			const loser = newer ? held : stated;
			const winner = newer ? stated : held;
			refuse(
				'media_stat_conflict',
				o.file_path,
				`${String(loser.size)} bytes @ ${String(loser.timestamp)} (${loser.gate}) vs ${String(winner.size)} @ ${String(winner.timestamp)} (${winner.gate}) — the latest mtime wins`,
				gate,
			);
			if (newer) mediaStatements.set(o.file_path, stated);
		}
	}
	for (const key of ['posterframe_url', 'base_svg_url']) {
		const value = o[key];
		if (typeof value !== 'string') continue;
		const path = mediaPathFromUrl(value);
		if (path === null || mediaStatements.has(path)) continue;
		mediaStatements.set(path, {
			size: null,
			timestamp: null,
			time: null,
			origin: 'derived_url',
			gate,
		});
	}
}

/** Pairs the store ADDRESSES (request, or response data) — the id-map universe. */
const addressed = new Map<string, Set<string>>();
function address(sectionTipo: string, sectionId: string | number, gate: string): void {
	const key = pairKey(sectionTipo, sectionId);
	let gates = addressed.get(key);
	if (gates === undefined) {
		gates = new Set();
		addressed.set(key, gates);
	}
	gates.add(gate);
}

/** TM rows the store reveals (dd15 list entries carry matrix_id + caller). */
const tmRows = new Map<string, Json>();
const tmGate = new Map<string, string>();
/** (caller pair, component tipo) → the historical value a tm-mode read showed. */
const tmValues = new Map<string, Json>();
/**
 * matrix_id → the component tipo the row audits. The dd15 LIST never shows it
 * (its columns are date/who/where/process — `where` names the SECTION), so it
 * is only knowable for the rows a tm-mode read addressed by `source.matrix_id`.
 */
const tmComponentByMatrixId = new Map<string, string>();

function walk(
	value: Json,
	visit: (o: Record<string, Json>, path: string[]) => void,
	path: string[] = [],
): void {
	if (Array.isArray(value)) {
		for (const [index, child] of value.entries()) walk(child, visit, [...path, String(index)]);
		return;
	}
	if (isObject(value)) {
		visit(value, path);
		for (const key of Object.keys(value)) walk(value[key], visit, [...path, key]);
	}
}

/* ------------------------------------------------------------ the walk */

const files = readdirSync(STORE)
	.filter((name) => name.endsWith('.json'))
	.sort();

for (const file of files) {
	const parsed = JSON.parse(readFileSync(join(STORE, file), 'utf8')) as {
		meta: Record<string, Json>;
		interactions: Record<string, Interaction>;
	};
	const gate = String(parsed.meta.gate ?? file.replace(/\.json$/, ''));
	for (const interaction of Object.values(parsed.interactions)) {
		const action = String(interaction.rqo?.action ?? '?');
		walk(interaction.rqo, (o) => {
			if (isLocator(o)) address(String(o.section_tipo), o.section_id as string, gate);
		});
		const source = interaction.rqo?.source;
		if (isObject(source) && source.matrix_id !== undefined && typeof source.tipo === 'string') {
			tmComponentByMatrixId.set(String(source.matrix_id), source.tipo);
		}
		if (interaction.kind !== 'json' || !isObject(interaction.body)) continue;
		const body = interaction.body;
		const result = body.result;

		// Address every locator the body shows (skip the debug rqo echo).
		for (const key of Object.keys(body)) {
			if (key === 'debug') continue;
			walk(body[key], (o) => {
				if (isLocator(o)) address(String(o.section_tipo), o.section_id as string, gate);
				// A media identity is a fact of its own — harvested from the WHOLE
				// body, not only from items the derive manages to store.
				collectMediaStatement(o, gate);
			});
		}

		// ---- raw rows: the ONLY complete-record source -------------------
		if (action === 'read_raw' && Array.isArray(result)) {
			const options = interaction.rqo?.options ?? {};
			const locators: Json[] = interaction.rqo?.sqo?.filter_by_locators ?? [];
			/**
			 * `type: 'target_section'` — the raw read of ONE relation component
			 * across SEVERAL caller records. PHP concatenates every caller's stored
			 * items into a single flat array with no per-caller envelope, so the
			 * body says nothing about which locator each item belongs to… except
			 * mechanically: a stored item's `id` is allocated per record and
			 * ascends, so the array is exactly `locators.length` ASCENDING RUNS and
			 * every drop in `id` is a record boundary. That is an attribution, not a
			 * guess — and it is only accepted when it CHECKS OUT: the run count must
			 * equal the locator count and each run must belong to one component
			 * (otherwise its ids interleave two components and the boundary is not a
			 * boundary). Anything else is refused by name rather than split on a
			 * hunch, because a wrong split would move another record's locators onto
			 * this one.
			 */
			if (String(options.type) === 'target_section' && Array.isArray(result)) {
				const runs: Json[][] = [];
				let previous = Number.POSITIVE_INFINITY;
				for (const one of result) {
					const id = Number((one as Json)?.id ?? Number.NaN);
					if (!Number.isInteger(id) || id <= previous) runs.push([]);
					(runs[runs.length - 1] as Json[]).push(one);
					previous = Number.isInteger(id) ? id : Number.POSITIVE_INFINITY;
				}
				const where = `${String(options.section_tipo)} → ${String(options.tipo)}`;
				const components = runs.map(
					(run) => new Set(run.map((one: Json) => String(one?.from_component_tipo ?? ''))),
				);
				// TWO independent conditions, which is what makes a reordered record
				// refusable rather than misattributed (a review suspected the
				// ascending-id assumption could silently mis-split): items stored out
				// of order produce an EXTRA run, so the count stops matching; and a
				// run that mixes components fails the second test. Verified
				// 2026-08-21 — the narrow case where a reordering happens to preserve
				// both properties is the only residual, and it is named in the
				// refusal below rather than assumed away.
				if (runs.length !== locators.length || components.some((set) => set.size !== 1)) {
					refuse(
						'read_raw_target_section_unattributable',
						where,
						`${result.length} items in ${runs.length} ascending run(s) for ${locators.length} caller locator(s)` +
							`${components.some((set) => set.size !== 1) ? ' — a run mixes components' : ''}`,
						gate,
					);
				} else {
					locators.forEach((locator: Json, index: number) => {
						if (!isLocator(locator)) return;
						const run = runs[index] as Json[];
						const componentTipo = [...(components[index] as Set<string>)][0] as string;
						if (componentTipo === '') return;
						const target = record(String(locator.section_tipo), locator.section_id as string);
						target.gates.add(gate);
						putItem(target, {
							tipo: componentTipo,
							entries: run,
							rank: 3,
							model: null,
							lang: null,
							gate,
						});
					});
				}
			}
			locators.forEach((locator: Json, index: number) => {
				if (!isLocator(locator)) return;
				const row = result[index];
				if (String(options.model) === 'section' && isObject(row)) {
					const target = record(String(locator.section_tipo), locator.section_id as string);
					target.rawColumns = row;
					target.bestRank = 3;
					target.gates.add(gate);
					return;
				}
				if (String(options.type) === 'component' && Array.isArray(row)) {
					const target = record(String(locator.section_tipo), locator.section_id as string);
					target.gates.add(gate);
					putItem(target, {
						tipo: String(options.tipo),
						entries: row,
						rank: 3,
						model: String(options.model ?? '') || null,
						lang: null,
						gate,
					});
				}
			});
		}

		// ---- data items --------------------------------------------------
		const dataItems: Json[] = isObject(result) && Array.isArray(result.data) ? result.data : [];
		for (const item of dataItems) {
			if (!isObject(item)) continue;
			if (item.typo === 'sections' && Array.isArray(item.entries)) {
				for (const entry of item.entries) {
					if (!isLocator(entry)) continue;
					if (entry.matrix_id !== undefined && entry.timestamp !== undefined) {
						tmRows.set(String(entry.matrix_id), entry);
						tmGate.set(String(entry.matrix_id), gate);
					}
				}
				continue;
			}
			if (typeof item.tipo !== 'string' || !isLocator(item)) continue;
			if (!('entries' in item)) continue;
			if (item.entries === null || item.entries === undefined) continue;
			if (Array.isArray(item.entries) && item.entries.length === 0) continue;
			const target = record(String(item.section_tipo), item.section_id as string);
			target.gates.add(gate);
			// A computed inverse page states locators that live on OTHER records.
			collectInverseEdges(
				{ section_tipo: String(item.section_tipo), section_id: String(item.section_id) },
				item.tipo,
				item.entries,
				gate,
			);
			const mode = String(item.mode ?? '');
			if (mode === 'tm') {
				tmValues.set(`${item.section_tipo}|${item.section_id}|${item.tipo}`, item.entries);
				continue;
			}
			putItem(target, {
				tipo: item.tipo,
				entries: item.entries,
				rank: mode === 'edit' || action === 'resolve_data' ? 2 : 1,
				model: typeof item.debug_model === 'string' ? item.debug_model : null,
				lang: typeof item.lang === 'string' ? item.lang : null,
				gate,
			});
		}

		// ---- get_section_terms: a RESOLVED label, never a component value ---
		if (action === 'get_section_terms' && isObject(result)) {
			for (const key of Object.keys(result)) {
				const match = /^([a-z_]+\d+)_(\d+)$/.exec(key);
				if (match === null || match[1] === undefined || match[2] === undefined) continue;
				address(match[1], match[2], gate);
				termLabelOnly.add(pairKey(match[1], match[2]));
			}
		}

		// ---- ts node reads (ar_elements) ---------------------------------
		/**
		 * TS NODE READS. `get_node_data` answers ONE node; `get_children_data`
		 * answers a PAGE of them under `ar_children_data`, in exactly the same
		 * shape — and each entry is a complete statement about a DIFFERENT record
		 * (its term, its model, its ts identity). Reading only the singular form
		 * left every thesaurus child the store showed out of the corpus, so the
		 * children call the fixture harvested answered `[]` on the replay.
		 */
		if (action === 'get_node_data' && isObject(result)) collectNodeData(result, gate);
		if (action === 'get_children_data' && isObject(result)) {
			const children: Json[] = Array.isArray(result.ar_children_data)
				? result.ar_children_data
				: [];
			for (const child of children) collectNodeData(child, gate);
		}
	}
}

/**
 * One ts node's `ar_elements` — the components a tree read shows of the record
 * it describes. Shared by `get_node_data` (one node) and `get_children_data`
 * (a page of them).
 */
function collectNodeData(node: Json, gate: string): void {
	if (!isLocator(node)) return;
	const elements: Json[] = Array.isArray(node.ar_elements) ? node.ar_elements : [];
	const target = record(String(node.section_tipo), node.section_id as string);
	target.gates.add(gate);
	for (const element of elements) {
		if (!isObject(element) || typeof element.tipo !== 'string') continue;
		if (element.value === null || element.value === undefined) continue;
		// AN AFFORDANCE IS NOT A VALUE. `ar_elements` mixes the node's stored
		// components with the tree's own UI: `type:'link_children'` carries the
		// literal string 'button show children' (the expand button), `type:'icon'`
		// a badge. Writing those back put `[{id:1,value:"button show children"}]`
		// into the record's `relation` column under a component_relation_children
		// — a model whose value is COMPUTED from the children's parent links and
		// which therefore has nothing to store. Only `type:'term'` is a stored
		// value here (ts_object.js builds the other two).
		if (element.type !== 'term') {
			refuse(
				'ts_node_element_is_an_affordance',
				String(element.tipo),
				`${String(node.section_tipo)}/${String(node.section_id)} — ar_elements type '${String(element.type)}' (${String(element.model)}) is the tree's UI, not a stored value`,
				gate,
			);
			continue;
		}
		collectInverseEdges(
			{ section_tipo: String(node.section_tipo), section_id: String(node.section_id) },
			element.tipo,
			element.value,
			gate,
		);
		putItem(target, {
			tipo: element.tipo,
			entries: Array.isArray(element.value) ? element.value : [{ id: 1, value: element.value }],
			rank: 2,
			model: typeof element.model === 'string' ? element.model : null,
			lang: null,
			gate,
		});
	}
}

/** Keep the richest source per (component tipo, lang). */
function putItem(target: CollectedRecord, item: CollectedItem): void {
	const key = `${item.tipo}|${item.lang ?? ''}`;
	const previous = target.items.get(key);
	if (previous !== undefined && previous.rank >= item.rank) {
		// The preference firing the OTHER way: a poorer source arrived after a
		// richer one and was rejected. Counted so the report can show that the
		// rule is exercised in both directions, not merely written down.
		if (previous.rank > item.rank) sourcePreferenceHeld++;
		return;
	}
	if (previous !== undefined) sourceUpgrades++;
	target.items.set(key, item);
	if (item.rank > target.bestRank && target.rawColumns === null) {
		// A component-level raw read does not make the RECORD complete.
		target.bestRank = item.rank === 3 ? 2 : item.rank;
	}
}

/**
 * An edge may name a POINTING record no body ever showed the data of (the
 * store only ever saw it from the far end). It is still a record the corpus
 * must hold, or the index it feeds resolves nothing — so give it an entry now
 * and let the ordinary build loop classify, map and write it.
 */
for (const [key, edges] of inverseEdges) {
	const first = edges[0] as InverseEdge;
	const entry = record(first.pointing.section_tipo, first.pointing.section_id);
	for (const edge of edges) entry.gates.add(edge.revealedBy.gate);
	if (entry.items.size === 0 && entry.rawColumns === null) edgeOnlyRecords.add(key);
}

/* ------------------------------------------------- id map for every pair */

for (const key of [...addressed.keys()].sort()) {
	const match = /^([a-z_]+\d+)_(.+)$/.exec(key);
	if (match === null || match[1] === undefined || match[2] === undefined) continue;
	idFor(match[1], match[2]);
}

/* -------------------------------------------------------- the rewriters */

const filesInfo: {
	file_path: string;
	folder: string;
	quality: string;
	bucket: number | null;
	section_tipo: string;
	section_id: number;
	component_tipo: string;
	lang: string | null;
	extension: string;
	/**
	 * The file's own `stat`, as the oracle read it — `file_size` bytes and the
	 * `file_time.timestamp` mtime. `ensureMediaKit()` reproduces BOTH on the
	 * planted asset, because a media component emits them verbatim: a kit copy
	 * of the wrong length at today's mtime makes every media differential
	 * diverge on two fields that describe the FILE and nothing else. null when
	 * the statement was a derived-media URL (`posterframe_url` / `base_svg_url`
	 * are existence-checked but carry no stat).
	 */
	file_size: number | null;
	/** `YYYY-MM-DD HH:MM:SS`, the oracle's `file_time.timestamp`. */
	file_time: string | null;
	/** The record whose walk revealed the path (provenance, not ownership). */
	seen_in: string;
}[] = [];
const filesInfoSeen = new Set<string>();

/** Rewrite a media file name/path: `<component>_<section>_<id>[.ext]`. */
function rewriteMediaString(value: string, gate: string): string {
	return value.replace(
		/([a-z_]+\d+)_([a-z_]+\d+)_(\d+)/g,
		(whole, componentTipo, sectionTipo, id) => {
			const component = mapTipo(componentTipo, sectionTipo);
			const section = idFor(sectionTipo, id);
			if (component === null || section === null) {
				refuse('media_identity_unmapped', whole, `${componentTipo}_${sectionTipo}_${id}`, gate);
				return whole;
			}
			return `${component}_${section.section_tipo}_${section.section_id}`;
		},
	);
}

/**
 * THE PATH GRAMMAR (src/core/media/path.ts): a media file's location is
 * `/<folder>/<quality>[/<bucket>]/<component>_<section>_<id>[_<lang>].<ext>` —
 * the identifier is `buildMediaIdentifier`, the quality is the second segment,
 * the optional numeric segment is the `max_items_folder` bucket. The IDENTITY
 * is read back OUT of the rewritten path rather than taken from the record
 * being walked, because a portal's item can carry the files_info of another
 * record's media component; and a path that does not parse is REFUSED, so a
 * kit asset is never planted at a name the engine will not look for.
 */
const MEDIA_PATH_RE =
	/^\/([a-z_0-9]+)\/([A-Za-z0-9._-]+)(?:\/(\d+))?\/([a-z_]+\d+)_([a-z_]+\d+)_(\d+)((?:_lg-[a-z0-9_]+)?)\.([a-z0-9]+)$/;

function collectMediaIdentity(path: string, context: RewriteContext): void {
	if (filesInfoSeen.has(path)) return;
	filesInfoSeen.add(path);
	const fact = mediaFacts.get(path);
	const match = MEDIA_PATH_RE.exec(path);
	if (match === null) {
		refuse(
			'media_path_not_engine_shaped',
			path,
			`${context.sectionTipo}/${context.sectionId}.${context.componentTipo} — not /<folder>/<quality>[/<bucket>]/<component>_<section>_<id>[_<lang>].<ext>`,
			context.gate,
		);
		return;
	}
	filesInfo.push({
		file_path: path,
		folder: match[1] as string,
		quality: match[2] as string,
		bucket: match[3] === undefined ? null : Number(match[3]),
		section_tipo: match[5] as string,
		section_id: Number(match[6]),
		component_tipo: match[4] as string,
		lang: match[7] === '' ? null : (match[7] as string).slice(1),
		extension: (match[8] as string).toLowerCase(),
		file_size: fact?.size ?? null,
		file_time: fact?.timestamp ?? null,
		seen_in: `${context.sectionTipo}/${context.sectionId}.${context.componentTipo}`,
	});
}

/**
 * EVERY MEDIA STATEMENT, restated in the corpus's own terms. Built once the id
 * map is complete (a media path carries a record address, so it cannot be
 * rewritten before that) and BEFORE the record loop, so a path a STORED
 * component reveals and a path only a LIST projection reveals end up carrying
 * the same facts. The identity is re-derived from the path grammar rather than
 * from `rewriteMediaString`, because this pass must be able to tell a path it
 * could not map from one it could — and refuse it by name instead of planting
 * a file at an install's address.
 */
const mediaFacts = new Map<string, MediaStatement>();
for (const [rawPath, statement] of [...mediaStatements.entries()].sort(([a], [b]) =>
	a.localeCompare(b),
)) {
	const where = `media statement (${statement.origin})`;
	const match = MEDIA_PATH_RE.exec(rawPath);
	if (match === null) {
		refuse('media_path_not_engine_shaped', rawPath, where, statement.gate);
		continue;
	}
	const sourceSection = match[5] as string;
	const component = mapTipo(match[4] as string, sourceSection);
	const section = idFor(sourceSection, match[6] as string);
	if (component === null || section === null) {
		refuse('media_identity_unmapped', rawPath, where, statement.gate);
		continue;
	}
	if (!section.kept) {
		// The BUCKET segment (`max_items_folder`) is a function of the record id,
		// and the store never states the ontology property that sizes it — so a
		// reallocated id would put the file in a directory the engine does not
		// look in. Refused by name rather than planted at a guessed bucket.
		refuse('media_identity_id_reallocated', rawPath, where, statement.gate);
		continue;
	}
	const bucket = match[3] === undefined ? '' : `/${match[3]}`;
	const rewritten = `/${match[1]}/${match[2]}${bucket}/${component}_${section.section_tipo}_${section.section_id}${match[7]}.${match[8]}`;
	if (!mediaFacts.has(rewritten)) mediaFacts.set(rewritten, statement);
}

interface RewriteContext {
	gate: string;
	sectionTipo: string;
	sectionId: number;
	componentTipo: string;
	/** The SOURCE section the value was read from (scopes the component map). */
	sourceSectionTipo: string;
	dropped: number;
}

/** Deep-rewrite one component's stored entries. Returns null when nothing survives. */
function rewriteEntries(value: Json, context: RewriteContext): Json {
	if (Array.isArray(value)) {
		const out: Json[] = [];
		for (const child of value) {
			const rewritten = rewriteEntries(child, context);
			if (rewritten === undefined) {
				context.dropped++;
				continue;
			}
			out.push(rewritten);
		}
		return out;
	}
	if (!isObject(value)) return value;
	// A locator: both halves move together.
	if (isLocator(value)) {
		const sourceSection = String(value.section_tipo);
		const verdict = classifySection(sourceSection);
		if (verdict.ok || ALLOWED_TLDS.has(tldOf(sourceSection))) {
			const mapped = verdict.ok ? idFor(sourceSection, value.section_id as string) : null;
			if (verdict.ok && mapped === null) {
				refuse(
					'dangling_locator',
					`${sourceSection}/${String(value.section_id)}`,
					`unmappable id inside ${context.sectionTipo}/${context.sectionId}.${context.componentTipo}`,
					context.gate,
				);
				return undefined as unknown as Json;
			}
			const out: Record<string, Json> = {};
			for (const [key, child] of Object.entries(value)) {
				if (DERIVED_ITEM_KEYS.has(key)) continue;
				if (key === 'section_tipo') {
					out.section_tipo = mapped === null ? sourceSection : mapped.section_tipo;
					continue;
				}
				if (key === 'section_id') {
					out.section_id = mapped === null ? String(value.section_id) : String(mapped.section_id);
					continue;
				}
				if (key === 'section_top_tipo') {
					const topId = value.section_top_id;
					const topMapped = topId === undefined ? null : idFor(String(child), String(topId));
					if (topMapped !== null) {
						out.section_top_tipo = topMapped.section_tipo;
						out.section_top_id = String(topMapped.section_id);
						continue;
					}
					const topTipo =
						typeof child === 'string' ? mapTipo(child, context.sourceSectionTipo) : null;
					if (topTipo === null) {
						refuse(
							'component_tipo_unmapped',
							String(child),
							`section_top_tipo inside ${context.componentTipo}`,
							context.gate,
						);
						return undefined as unknown as Json;
					}
					out.section_top_tipo = topTipo;
					continue;
				}
				if (key === 'section_top_id') continue; // written beside section_top_tipo
				if (TIPO_KEYS.has(key)) {
					const mappedTipo =
						typeof child === 'string' ? mapTipo(child, context.sourceSectionTipo) : null;
					if (typeof child === 'string' && mappedTipo === null) {
						refuse(
							'component_tipo_unmapped',
							child,
							`${key} inside ${context.componentTipo}`,
							context.gate,
						);
						return undefined as unknown as Json;
					}
					out[key] = mappedTipo ?? child;
					continue;
				}
				out[key] = rewriteEntries(child, context);
			}
			return out;
		}
		refuse(
			'dangling_locator',
			sourceSection,
			`no test section for the locator target inside ${context.sectionTipo}/${context.sectionId}.${context.componentTipo}`,
			context.gate,
		);
		return undefined as unknown as Json;
	}
	// A plain item (value/lang/files_info/…).
	const out: Record<string, Json> = {};
	for (const [key, child] of Object.entries(value)) {
		if (DERIVED_ITEM_KEYS.has(key)) continue;
		if (
			typeof child === 'string' &&
			(key === 'file_name' || key === 'file_path' || key === 'original_file_name')
		) {
			const rewritten = rewriteMediaString(child, context.gate);
			out[key] = rewritten;
			if (key === 'file_path' && rewritten.startsWith('/')) {
				collectMediaIdentity(rewritten, context);
			}
			continue;
		}
		if (typeof child === 'string' && MEDIA_URL_RE.test(child)) {
			// A media URL embedded in TEXT (a text_area's inline <img>/<svg>).
			// The text is payload, not a locator, so it is kept verbatim — and
			// listed, because the file it names has no test identity yet.
			for (const url of mediaUrlsIn(child)) {
				refuse(
					'media_reference_in_text',
					url,
					`${context.sectionTipo}/${context.sectionId}.${context.componentTipo}`,
					context.gate,
				);
			}
			out[key] = child;
			continue;
		}
		if (TIPO_KEYS.has(key) && typeof child === 'string' && /^[a-z_]+\d+$/.test(child)) {
			const mapped = mapTipo(child, context.sourceSectionTipo);
			out[key] = mapped ?? child;
			if (mapped === null)
				refuse(
					'component_tipo_unmapped',
					child,
					`nested ${key} in ${context.componentTipo}`,
					context.gate,
				);
			continue;
		}
		out[key] = rewriteEntries(child, context);
	}
	/**
	 * ONE STAT PER PATH. A `files_info` entry the corpus stores must agree with
	 * the file `ensureMediaKit()` plants — and with every OTHER copy of the same
	 * entry, which two fixtures can disagree about (see `media_stat_conflict`).
	 * `mediaFacts` already holds the deconflicted statement, so the stat is
	 * taken from there rather than from whichever body this copy came out of.
	 */
	if (typeof out.file_path === 'string' && out.file_exist === true) {
		const fact = mediaFacts.get(out.file_path);
		if (fact !== undefined && fact.size !== null) {
			out.file_size = fact.size;
			out.file_time = fact.time;
		}
	}
	return out;
}

/* ------------------------------------------------------ build the corpus */

interface CorpusRecord {
	section_id: number;
	source: { section_tipo: string; section_id: string };
	/** false only when the whole row came from a `read_raw` section read. */
	reconstructed: boolean;
	/**
	 * true when NO body ever showed this record's own data: it exists in the
	 * corpus only because another record's computed inverse page named it.
	 */
	edge_only?: boolean;
	/**
	 * true when NOTHING the store revealed about this record was storable: the
	 * row carries its identity (`data`) and no component at all. The record
	 * EXISTS — a frozen body read a component off it — but the corpus knows no
	 * value of it. A gate must read such a row as "present, contents unknown".
	 */
	existence_only?: boolean;
	gates: string[];
	columns: Partial<Record<MatrixJsonbColumn, Json>>;
	/**
	 * PER-COMPONENT PROVENANCE: `raw` = the stored bytes (a `read_raw` row);
	 * `edit` = an edit-mode / resolve_data read; `list` = a LIST projection.
	 * Only `raw` is the stored value — `edit` and above all `list` are what the
	 * read pipeline MADE of it (lang-sliced, label-resolved, truncated), so a
	 * gate must not re-read such a component through the same pipeline and
	 * compare values. The deriver always keeps the richest source it saw for a
	 * (record, component); a `list` here means the store never showed better.
	 */
	component_sources?: Record<string, 'raw' | 'edit' | 'list'>;
	/**
	 * THE AUDIT TRAIL for every locator in `columns` that no read of THIS record
	 * revealed — see the InverseEdge header. Present only when non-empty; the
	 * ensurer ignores it (only `columns` is written), so an edge is auditable
	 * without polluting the stored jsonb with a fabricated key.
	 */
	inverse_edges?: {
		origin: 'inverse_edge';
		column: string;
		component_tipo: string;
		item_id: number;
		type: string | null;
		target: { section_tipo: string; section_id: number };
		revealed_by: { section_tipo: string; section_id: string; tipo: string; gate: string };
	}[];
}
const sections = new Map<
	string,
	{
		section_tipo: string;
		source_section_tipo: string;
		table: string;
		kind: 'test' | 'seed';
		records: CorpusRecord[];
	}
>();
const JSONB = new Set<string>(MATRIX_JSONB_COLUMNS);

/**
 * PENDING bucket: sections with no ontology clone at all. Phase 2b (2026-08-19)
 * twinned every one of them from `hierarchy20`, so this bucket is now EMPTY and
 * must stay empty — a file appearing under `pending/` means some gate addresses
 * a section neither cloned nor twinned, and the manifest must answer for it.
 */
interface PendingRecord {
	source: { section_tipo: string; section_id: string };
	proposed_section_id: number;
	gates: string[];
	items: { tipo: string; model: string | null; column: string | null; entries: Json }[];
}
const pending = new Map<string, { source_section_tipo: string; records: PendingRecord[] }>();

let itemsKept = 0;
let itemsDropped = 0;
/** Inverse edges materialized / records that exist only because of one. */
let edgesWritten = 0;
let edgeOnlyWritten = 0;
let pendingItems = 0;

/** Park a record whose section is waiting on phase 2b (source tipos intact). */
function parkPending(entry: CollectedRecord): void {
	let bucket = pending.get(entry.sectionTipo);
	if (bucket === undefined) {
		bucket = { source_section_tipo: entry.sectionTipo, records: [] };
		pending.set(entry.sectionTipo, bucket);
	}
	const items = [...entry.items.values()].map((item) => {
		const model = item.model ?? MODEL_OF.get(item.tipo) ?? seedModel(item.tipo) ?? null;
		const column = model === null ? null : (storageColumnOf(model) ?? null);
		pendingItems++;
		return { tipo: item.tipo, model, column, entries: item.entries };
	});
	if (entry.rawColumns !== null) {
		for (const [column, value] of Object.entries(entry.rawColumns)) {
			if (!JSONB.has(column) || !isObject(value)) continue;
			for (const [componentTipo, entries] of Object.entries(value as Record<string, Json>)) {
				items.push({
					tipo: componentTipo,
					model: MODEL_OF.get(componentTipo) ?? seedModel(componentTipo) ?? null,
					column,
					entries,
				});
				pendingItems++;
			}
		}
	}
	bucket.records.push({
		source: { section_tipo: entry.sectionTipo, section_id: entry.sectionId },
		proposed_section_id: Number(entry.sectionId),
		gates: [...entry.gates].sort(),
		items,
	});
}

for (const entry of [...collected.values()].sort((a, b) =>
	a.sectionTipo === b.sectionTipo
		? Number(a.sectionId) - Number(b.sectionId)
		: a.sectionTipo.localeCompare(b.sectionTipo),
)) {
	const gate = [...entry.gates][0] ?? '?';
	const verdict = classifySection(entry.sectionTipo);
	/**
	 * An edge is only ever materialized on a record the corpus actually writes:
	 * a pointing record with no ontology clone (or one the corpus must not
	 * overwrite) loses its edges, and each one is REPORTED rather than dropped —
	 * the index it feeds will resolve short, and the sweeper has to know which.
	 */
	const refuseEdges = (reason: string): void => {
		for (const edge of inverseEdges.get(pairKey(entry.sectionTipo, entry.sectionId)) ?? []) {
			refuse(
				'inverse_edge_pointing_record_unusable',
				`${entry.sectionTipo}/${entry.sectionId}`,
				`${reason}: ${entry.sectionTipo}/${entry.sectionId}.${edge.componentTipo} → ${edge.target.section_tipo}/${edge.target.section_id}`,
				edge.revealedBy.gate,
			);
		}
	};
	if (!verdict.ok) {
		refuseEdges(verdict.reason);
		if (verdict.reason === 'no_ontology_clone') {
			parkPending(entry);
			continue;
		}
		refuse(
			verdict.reason,
			entry.sectionTipo,
			`${entry.sectionTipo}/${entry.sectionId}${verdict.detail === undefined ? '' : ` — ${verdict.detail}`}`,
			gate,
		);
		continue;
	}
	const identity = idFor(entry.sectionTipo, entry.sectionId);
	if (identity === null) {
		refuseEdges('non_numeric_section_id');
		refuse(
			'non_numeric_section_id',
			entry.sectionTipo,
			`${entry.sectionTipo}/${entry.sectionId}`,
			gate,
		);
		continue;
	}
	if (
		verdict.kind === 'seed' &&
		seedIds.get(`${verdict.table}|${entry.sectionTipo}`)?.has(Number(entry.sectionId)) === true
	) {
		// The INSTALLATION already ships this record (a `dd64` yes/no, a
		// language, the admin user): every locator that names it resolves on
		// every install, and overwriting it with one install's copy would
		// replace shipped configuration with data. Not a hole — the opposite.
		refuseEdges('seed_shipped_record');
		refuse(
			'seed_shipped_record',
			entry.sectionTipo,
			`${entry.sectionTipo}/${entry.sectionId} — the install seed ships this record in ${verdict.table}`,
			gate,
		);
		continue;
	}
	const columns: Partial<Record<MatrixJsonbColumn, Json>> = {};
	/**
	 * Per-component provenance for THIS record (see CorpusRecord.component_sources).
	 * Recorded as the BEST rank seen, because one component can be written from
	 * more than one item: `putItem` keys by (tipo, LANG), so an edit read with no
	 * lang and a list projection of the same component in `lg-spa` are two
	 * entries that merge into one stored array. The census counts each written
	 * component ONCE, at its richest source.
	 */
	const componentSources: Record<string, 'raw' | 'edit' | 'list'> = {};
	const componentRank: Record<string, SourceRank> = {};
	const noteSource = (tipo: string, rank: SourceRank): void => {
		const previous = componentRank[tipo];
		if (previous !== undefined && previous >= rank) return;
		const label = rank === 3 ? 'raw' : rank === 2 ? 'edit' : 'list';
		if (previous !== undefined) sourceCensus[componentSources[tipo] as 'raw' | 'edit' | 'list']--;
		componentRank[tipo] = rank;
		componentSources[tipo] = label;
		sourceCensus[label]++;
	};
	const context: RewriteContext = {
		gate,
		sectionTipo: identity.section_tipo,
		sectionId: identity.section_id,
		componentTipo: '',
		sourceSectionTipo: entry.sectionTipo,
		dropped: 0,
	};

	/**
	 * The component tipos the RAW ROW itself wrote. The guard below protects
	 * those from being overwritten by a projection — it must NOT protect a slot
	 * another PROJECTION filled earlier in the same loop, which is what reading
	 * `existing[targetTipo]` did: on a record that has a raw row, the first
	 * projection to arrive claimed the slot and a richer `read_raw` item that
	 * came later was skipped as if the raw row had written it.
	 */
	const fromRawRow = new Set<string>();

	// The raw row (when present) seeds every column verbatim, rewritten.
	if (entry.rawColumns !== null) {
		for (const [column, value] of Object.entries(entry.rawColumns)) {
			if (!JSONB.has(column) || column === 'relation_search' || column === 'meta') continue;
			if (value === null || value === undefined) continue;
			if (column === 'data') continue; // rebuilt below
			const rewrittenColumn: Record<string, Json> = {};
			for (const [componentTipo, items] of Object.entries(value as Record<string, Json>)) {
				const mapped = mapTipo(componentTipo, entry.sectionTipo);
				if (mapped === null) {
					refuse(
						'component_tipo_unmapped',
						componentTipo,
						`raw ${column} of ${entry.sectionTipo}/${entry.sectionId}`,
						gate,
					);
					itemsDropped++;
					continue;
				}
				context.componentTipo = mapped;
				rewrittenColumn[mapped] = rewriteEntries(items, context);
				fromRawRow.add(mapped);
				noteSource(mapped, 3);
				itemsKept++;
			}
			if (Object.keys(rewrittenColumn).length > 0)
				columns[column as MatrixJsonbColumn] = rewrittenColumn;
		}
	}

	// The per-component items (a projection unless the component came raw), the
	// RICHEST FIRST. `entry.items` is keyed by (tipo, LANG), so one stored
	// component can arrive as several items — and the slot a component lands in
	// is claimed by whichever is written first. Sorting by rank makes the
	// preference rule the header states ('raw over edit over list') decide that,
	// instead of the alphabetical order of the fixture files. Stable, so items of
	// equal rank keep their walk order and the derive stays byte-deterministic.
	for (const item of [...entry.items.values()].sort((a, b) => b.rank - a.rank)) {
		const targetTipo = mapTipo(item.tipo, entry.sectionTipo);
		if (targetTipo === null) {
			refuse(
				'component_tipo_unmapped',
				item.tipo,
				`${entry.sectionTipo}/${entry.sectionId}`,
				item.gate,
			);
			itemsDropped++;
			continue;
		}
		// The test ontology knows the test tipos; the SEED knows the allowed-TLD
		// ones (`rsc29`, `hierarchy25`); the body's `debug_model` is the last
		// resort (a component the store showed but neither source defines).
		const model = MODEL_OF.get(targetTipo) ?? seedModel(targetTipo) ?? item.model;
		if (model === null || model === undefined) {
			refuse(
				'unknown_model',
				targetTipo,
				`${entry.sectionTipo}/${entry.sectionId}.${item.tipo}`,
				item.gate,
			);
			itemsDropped++;
			continue;
		}
		if (COMPUTED_MODELS.has(model)) {
			refuse(
				'computed_at_read',
				targetTipo,
				`${model} on ${entry.sectionTipo}/${entry.sectionId}`,
				item.gate,
			);
			itemsDropped++;
			continue;
		}
		const column = storageColumnOf(model);
		if (column === undefined || !JSONB.has(column)) {
			refuse(
				'no_storage_column',
				targetTipo,
				`${model} stores nothing (column ${String(column)})`,
				item.gate,
			);
			itemsDropped++;
			continue;
		}
		const existing = (columns[column as MatrixJsonbColumn] ?? {}) as Record<string, Json>;
		// A raw column already holds the stored truth — never overwrite it.
		if (fromRawRow.has(targetTipo)) continue;
		/**
		 * A MEDIA COMPONENT'S PRESENCE (2026-08-19, phase-4 corpus gap 3b). The
		 * value of a media model is the FILE; the row holds only an item envelope
		 * (`{id, lib_data, original_file_name…}`) and the read pipeline scans the
		 * disk for the rest. A list projection therefore shows a `files_info` PAGE
		 * and none of the envelope, so the envelope cannot be reconstructed — and
		 * the derive was refusing the whole thing.
		 *
		 * But the page itself is a statement about the ROW: measured on this
		 * engine, a record with the files on disk and an EMPTY media column emits
		 * `[]` — the scan runs only for a non-empty stored value. So a non-empty
		 * files_info page PROVES the component holds one item, and a media
		 * identity has no item index (`buildMediaIdentifier` is
		 * `<component>_<section>_<id>`), so that item is `id: 1`. And the page is
		 * the stored `files_info` — `getMediaListValue` projects the STORED array,
		 * it never touches the disk, so the entries the oracle showed ARE the
		 * stored entries, filtered to the model's list qualities. The corpus
		 * stores exactly that much (`{id:1, files_info:[…]}`) and refuses the rest
		 * by name: the envelope fields and the non-list qualities, which a list
		 * page cannot show. Without it every image/pdf/av a list read revealed
		 * stayed invisible even with its file planted.
		 */
		if (
			column === 'media' &&
			Array.isArray(item.entries) &&
			item.entries.length > 0 &&
			item.entries.every(
				(one: Json) => isObject(one) && typeof one.file_path === 'string' && one.id === undefined,
			)
		) {
			refuse(
				'media_item_envelope_not_revealed',
				targetTipo,
				`${entry.sectionTipo}/${entry.sectionId} (${model}) — stored as {id:1, files_info:[…]} from the projection; the envelope (lib_data / original_file_name / original_upload_date) and the NON-LIST qualities are not in a list page`,
				item.gate,
			);
			if (existing[targetTipo] === undefined) {
				context.componentTipo = targetTipo;
				context.gate = item.gate;
				existing[targetTipo] = [{ id: 1, files_info: rewriteEntries(item.entries, context) }];
				columns[column as MatrixJsonbColumn] = existing;
				noteSource(targetTipo, item.rank);
				itemsKept++;
			}
			continue;
		}
		// A LIST projection is not a stored value: list mode renders a select as
		// `["Sí"]` and a portal as resolved labels. A stored item is ALWAYS an
		// object with its own `id`, so anything else is refused rather than
		// written back as if it were the record's data.
		if (
			Array.isArray(item.entries) &&
			!item.entries.every((one: Json) => isObject(one) && one.id !== undefined)
		) {
			refuse(
				'list_projection_not_storable',
				targetTipo,
				`${entry.sectionTipo}/${entry.sectionId} (${model}) — read projection, not a stored item shape`,
				item.gate,
			);
			itemsDropped++;
			continue;
		}
		context.componentTipo = targetTipo;
		context.gate = item.gate;
		const rewritten = rewriteEntries(item.entries, context);
		if (Array.isArray(rewritten) && rewritten.length === 0) {
			itemsDropped++;
			continue;
		}
		const previous = existing[targetTipo];
		if (Array.isArray(previous) && Array.isArray(rewritten)) {
			// Same component seen in another lang slice: merge by item id+lang.
			const seen = new Set(previous.map((p: Json) => `${p?.id ?? ''}|${p?.lang ?? ''}`));
			for (const one of rewritten) {
				const key = `${one?.id ?? ''}|${one?.lang ?? ''}`;
				if (seen.has(key)) continue;
				seen.add(key);
				previous.push(one);
			}
		} else {
			existing[targetTipo] = rewritten;
		}
		columns[column as MatrixJsonbColumn] = existing;
		// A component-level `read_raw` is stored bytes too (rank 3); anything
		// below it is what the READ made of the value, not the value.
		noteSource(targetTipo, item.rank);
		itemsKept++;
	}

	// The INVERSE EDGES this record holds (see the InverseEdge header): locators
	// no read of THIS record ever showed, stated by the record they point at.
	const edgeAudit: CorpusRecord['inverse_edges'] = [];
	for (const edge of inverseEdges.get(pairKey(entry.sectionTipo, entry.sectionId)) ?? []) {
		const where = `${entry.sectionTipo}/${entry.sectionId}.${edge.componentTipo} → ${edge.target.section_tipo}/${edge.target.section_id}`;
		const targetVerdict = classifySection(edge.target.section_tipo);
		const target = targetVerdict.ok
			? idFor(edge.target.section_tipo, edge.target.section_id)
			: null;
		if (target === null) {
			refuse('inverse_edge_target_unmapped', edge.target.section_tipo, where, edge.revealedBy.gate);
			continue;
		}
		const componentTipo = mapTipo(edge.componentTipo, entry.sectionTipo);
		if (componentTipo === null) {
			refuse('inverse_edge_component_unmapped', edge.componentTipo, where, edge.revealedBy.gate);
			continue;
		}
		const model = MODEL_OF.get(componentTipo) ?? seedModel(componentTipo) ?? null;
		const column = model === null ? undefined : storageColumnOf(model);
		if (column === undefined || !JSONB.has(column)) {
			refuse(
				'inverse_edge_no_storage_column',
				componentTipo,
				`${where} — model ${String(model)} stores nothing (column ${String(column)})`,
				edge.revealedBy.gate,
			);
			continue;
		}
		const type = edge.type === null ? null : mapTipo(edge.type, entry.sectionTipo);
		if (edge.type !== null && type === null) {
			refuse('inverse_edge_type_unmapped', edge.type, where, edge.revealedBy.gate);
			continue;
		}
		const extra: Record<string, Json> = {};
		let extraRefused = false;
		for (const [key, value] of Object.entries(edge.extra)) {
			if (key === 'section_top_id') continue; // written beside section_top_tipo
			if (key === 'section_top_tipo') {
				const topId = edge.extra.section_top_id;
				const top = topId === undefined ? null : idFor(String(value), String(topId));
				if (top === null) {
					refuse(
						'inverse_edge_target_unmapped',
						String(value),
						`${where} — section_top`,
						edge.revealedBy.gate,
					);
					extraRefused = true;
					break;
				}
				extra.section_top_tipo = top.section_tipo;
				extra.section_top_id = String(top.section_id);
				continue;
			}
			if (key === 'tag_component_tipo') {
				const tagged = mapTipo(String(value), entry.sectionTipo);
				if (tagged === null) {
					refuse(
						'inverse_edge_component_unmapped',
						String(value),
						`${where} — tag_component_tipo`,
						edge.revealedBy.gate,
					);
					extraRefused = true;
					break;
				}
				extra.tag_component_tipo = tagged;
				continue;
			}
			extra[key] = value;
		}
		if (extraRefused) continue;

		const slot = (columns[column as MatrixJsonbColumn] ?? {}) as Record<string, Json>;
		const held = Array.isArray(slot[componentTipo]) ? (slot[componentTipo] as Json[]) : [];
		// The locator law (concepts/locator.ts, DEC-21): section_id compares
		// loose-numerically, the other properties strictly. The held item's
		// absent `type` / `from_component_tipo` are normalized to the defaults
		// the engine would write BEFORE the comparison, so the law sees two
		// complete quads. Migrated off an inline String()=== match 2026-09-02
		// when scripts/ entered the write-path census (P2-20/S-3).
		const wanted = {
			section_tipo: target.section_tipo,
			section_id: target.section_id,
			type,
			from_component_tipo: componentTipo,
		} as Locator;
		const already = held.some(
			(one: Json) =>
				isObject(one) &&
				compareLocators(
					{
						section_tipo: String(one.section_tipo),
						section_id: one.section_id,
						type: one.type ?? null,
						from_component_tipo: one.from_component_tipo ?? componentTipo,
					} as Locator,
					wanted,
					['section_tipo', 'section_id', 'type', 'from_component_tipo'],
				),
		);
		if (already) continue;
		// THE ENGINE'S OWN RULE, not an invented number: `nextObserverItemId`
		// (src/core/section/record/observers.ts) is `max(finite ids) + 1`, and this
		// is the same computation. A stored locator must carry an item id, so the
		// question a review raised — "is this fabricating data?" — resolves to: the
		// EXISTENCE is what the frozen store proved, and the id is what the engine
		// would have allocated for it. The row is tagged `origin:'inverse_edge'`
		// with a `revealed_by` trail either way, so nothing here is silent.
		const nextId =
			held.reduce((max: number, one: Json) => Math.max(max, Number(one?.id ?? 0) || 0), 0) + 1;
		held.push({
			id: nextId,
			...(type === null ? {} : { type }),
			section_id: String(target.section_id),
			section_tipo: target.section_tipo,
			from_component_tipo: componentTipo,
			...extra,
		});
		slot[componentTipo] = held;
		columns[column as MatrixJsonbColumn] = slot;
		itemsKept++;
		edgeAudit.push({
			origin: 'inverse_edge',
			column,
			component_tipo: componentTipo,
			item_id: nextId,
			type,
			target: { section_tipo: target.section_tipo, section_id: target.section_id },
			revealed_by: {
				section_tipo: edge.revealedBy.section_tipo,
				section_id: edge.revealedBy.section_id,
				tipo: edge.revealedBy.tipo,
				gate: edge.revealedBy.gate,
			},
		});
	}

	/**
	 * EXISTENCE-ONLY (2026-08-19, phase-4 corpus gap 2). Every component the
	 * store showed for this record was unstorable — a media component's
	 * `files_info` page (the value lives on DISK, not in the row), a computed
	 * model, a list projection. But the record's EXISTENCE is not in doubt: a
	 * frozen body resolved a locator to it and read a component off it, which
	 * only happens for a row that is there. So the row is written with its
	 * identity and NOTHING else, and the refusal is restated as what it really
	 * is — every VALUE refused, the record kept — because the alternative
	 * (dropping the row) makes every portal that pages through it resolve short
	 * and silently understate the engine's answer.
	 *
	 * The per-component refusals are already listed individually (
	 * `list_projection_not_storable`, `computed_at_read`, `no_storage_column`),
	 * so nothing is lost by this line: it is the RECORD-level index of them.
	 */
	const existenceOnly = Object.keys(columns).length === 0;
	if (existenceOnly) {
		refuse(
			'record_values_all_unstorable',
			entry.sectionTipo,
			`${entry.sectionTipo}/${entry.sectionId} — written as an EXISTENCE-ONLY row (identity only); every revealed component is a projection, a computed model or a media page`,
			gate,
		);
	}

	// `data`: the record's own identity, plus the raw row's metadata when known.
	const rawData = isObject(entry.rawColumns?.data)
		? (entry.rawColumns?.data as Record<string, Json>)
		: {};
	const data: Record<string, Json> = {};
	for (const [key, value] of Object.entries(rawData)) {
		if (key === 'section_id' || key === 'section_tipo' || key === 'diffusion_info') continue;
		data[key] = value;
	}
	columns.data = {
		...data,
		section_id: identity.section_id,
		section_tipo: identity.section_tipo,
	};

	// `meta`: the per-component item-id high-water mark the save path allocates from.
	const meta: Record<string, Json> = {};
	for (const column of MATRIX_JSONB_COLUMNS) {
		const value = columns[column];
		if (column === 'data' || column === 'meta' || !isObject(value)) continue;
		for (const [componentTipo, items] of Object.entries(value as Record<string, Json>)) {
			if (!Array.isArray(items)) continue;
			const highest = items.reduce(
				(max: number, one: Json) => Math.max(max, Number(one?.id ?? 0) || 0),
				0,
			);
			if (highest > 0) meta[componentTipo] = [{ count: highest }];
		}
	}
	if (Object.keys(meta).length > 0) columns.meta = meta;

	let bucket = sections.get(identity.section_tipo);
	if (bucket === undefined) {
		bucket = {
			section_tipo: identity.section_tipo,
			source_section_tipo: entry.sectionTipo,
			// WHERE the ensurer must insert: a phase-2 clone stores in
			// `matrix_test`; a seed-shipped section stores in its OWN table, and
			// the ensurer must therefore delete by ID there, never by section.
			table: verdict.table,
			kind: verdict.kind,
			records: [],
		};
		sections.set(identity.section_tipo, bucket);
	}
	const isEdgeOnly = edgeOnlyRecords.has(pairKey(entry.sectionTipo, entry.sectionId));
	if (edgeAudit.length > 0) edgesWritten += edgeAudit.length;
	if (isEdgeOnly) edgeOnlyWritten++;
	bucket.records.push({
		section_id: identity.section_id,
		source: { section_tipo: entry.sectionTipo, section_id: entry.sectionId },
		reconstructed: entry.rawColumns === null,
		...(existenceOnly ? { existence_only: true } : {}),
		...(isEdgeOnly ? { edge_only: true } : {}),
		gates: [...entry.gates].sort(),
		columns,
		...(Object.keys(componentSources).length > 0 ? { component_sources: componentSources } : {}),
		...(edgeAudit.length > 0 ? { inverse_edges: edgeAudit } : {}),
	});
}

/* ------------------------------------------------- media identities left */

/**
 * Plant every media identity the record loop did not already reach. The loop
 * only sees the paths inside components it STORED; the store reveals many more
 * (an image list projection is nothing BUT a files_info page, and the two
 * derived-media URLs are attached to the item, not to any stored value). Those
 * files are the media component's whole value, so leaving them out is the
 * difference between a portal that expands into images and one that expands
 * into nothing.
 */
for (const [path, statement] of [...mediaFacts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
	if (filesInfoSeen.has(path)) continue;
	const match = MEDIA_PATH_RE.exec(path);
	if (match === null) continue; // re-derived from the grammar above; cannot happen
	collectMediaIdentity(path, {
		gate: statement.gate,
		sectionTipo: match[5] as string,
		sectionId: Number(match[6]),
		componentTipo: match[4] as string,
		sourceSectionTipo: match[5] as string,
		dropped: 0,
	});
}

/* ------------------------------------------------------- never revealed */

for (const [key, gates] of addressed) {
	if (collected.has(key)) continue;
	const match = /^([a-z_]+\d+)_(.+)$/.exec(key);
	if (match === null) continue;
	const sectionTipo = match[1] ?? '';
	const sectionId = match[2] ?? '';
	if (sectionTipo === '') continue;
	const verdict = classifySection(sectionTipo);
	const kind = verdict.ok
		? termLabelOnly.has(key)
			? 'term_label_only'
			: 'never_revealed'
		: verdict.reason === 'no_ontology_clone'
			? 'never_revealed_pending_section'
			: verdict.reason;
	for (const gate of gates) refuse(kind, sectionTipo, `${sectionTipo}/${sectionId}`, gate);
}

/* ------------------------------------------------------------ TM rows */

const tm: {
	id: number;
	section_tipo: string;
	section_id: number;
	tipo: string | null;
	tipo_known: boolean;
	lang: string | null;
	timestamp: string | null;
	user_id: number | null;
	data: Json;
	source: { section_tipo: string; section_id: string; matrix_id: string };
	gate: string;
}[] = [];
for (const [matrixId, row] of tmRows) {
	const gate = tmGate.get(matrixId) ?? '?';
	const callerTipo = String(row.caller_section_tipo ?? row.section_tipo ?? '');
	const callerId = String(row.caller_section_id ?? row.section_id ?? '');
	const identity = callerTipo === '' ? null : idFor(callerTipo, callerId);
	if (identity === null) {
		refuse('tm_caller_unmapped', callerTipo || '(none)', `tm row ${matrixId}`, gate);
		continue;
	}
	const sourceComponent =
		tmComponentByMatrixId.get(matrixId) ??
		(typeof row.caller_tipo === 'string' ? row.caller_tipo : null);
	const componentTipo = sourceComponent === null ? null : mapTipo(sourceComponent, callerTipo);
	if (sourceComponent === null) {
		// KNOWN HOLE, not a drop: the dd15 bare list carries no component tipo,
		// and the column is nullable. The row still audits the right record at
		// the right instant, which is what the list gates read.
		refuse(
			'tm_component_unknown',
			`${callerTipo}/${callerId}`,
			`tm row ${matrixId} (dd15 list shows no component tipo)`,
			gate,
		);
	} else if (componentTipo === null) {
		refuse('tm_component_unmapped', sourceComponent, `tm row ${matrixId}`, gate);
		continue;
	}
	const historical = tmValues.get(`${callerTipo}|${callerId}|${sourceComponent ?? ''}`);
	const context: RewriteContext = {
		gate,
		sectionTipo: identity.section_tipo,
		sectionId: identity.section_id,
		componentTipo: componentTipo ?? '',
		sourceSectionTipo: callerTipo,
		dropped: 0,
	};
	tm.push({
		id: Number(matrixId),
		section_tipo: identity.section_tipo,
		section_id: identity.section_id,
		tipo: componentTipo ?? null,
		tipo_known: componentTipo !== null,
		lang: typeof row.lang === 'string' ? row.lang : null,
		timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
		user_id: row.user_id === undefined || row.user_id === null ? null : Number(row.user_id),
		data: historical === undefined ? null : rewriteEntries(historical, context),
		source: { section_tipo: callerTipo, section_id: callerId, matrix_id: matrixId },
		gate,
	});
}
tm.sort((a, b) => a.id - b.id);

/* -------------------------------------------------------------- output */

const PENDING_DIR = join(OUT_DIR, 'pending');
for (const directory of [OUT_DIR, PENDING_DIR]) {
	if (!existsSync(directory)) continue;
	for (const name of readdirSync(directory)) {
		if (name.endsWith('.json')) rmSync(join(directory, name));
	}
}
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(PENDING_DIR, { recursive: true });

const HEADER =
	'DERIVED — do not hand-edit. Regenerate with `bun run scripts/derive_test_corpus.ts`. ' +
	'Source: the frozen oracle-harvest store (test/parity/fixtures/oracle_harvest), remapped ' +
	'through src/core/test_data/test_tld_tipo_map.json + test_corpus/id_map.json. ' +
	'`reconstructed: true` = the row was rebuilt from read PROJECTIONS (list/edit reads), not ' +
	'from a raw row: a component absent here is UNKNOWN, not empty, and a component PRESENT here ' +
	'may be a projection of the stored value (list mode slices by lang, resolves labels and ' +
	'truncates), so a gate must not re-read it through the same pipeline and compare values. ' +
	'Only `reconstructed: false` rows carry stored bytes. ' +
	'`component_sources: {<component tipo>: "raw"|"edit"|"list"}` states, PER COMPONENT, which ' +
	'source the value came from. THE PREFERENCE RULE: when the store shows one component more ' +
	'than once the deriver keeps the RICHEST source it saw — raw (`read_raw`, the stored jsonb) ' +
	'over edit (`mode:"edit"`/`resolve_data`/ts node reads) over list (a lang-sliced, ' +
	'label-resolved, truncated projection) — and it is measured, not assumed: the run report ' +
	'prints how many components were UPGRADED to a richer source and how many poorer sources ' +
	'were REJECTED in favour of one already held. A `list` here therefore means the store never ' +
	'showed that component better anywhere; assert identity/order/presence on it, never values. ' +
	"`inverse_edges[]` = locators materialized from ANOTHER record's computed inverse page " +
	'(origin `inverse_edge`): the statement is exact, but it was read from the far end. ' +
	'`edge_only: true` = the record exists ONLY because such an edge named it. ' +
	'`existence_only: true` = the row carries its IDENTITY and nothing else: the store proved the ' +
	'record exists but every value it revealed was unstorable (a media page, a computed model, a ' +
	'list projection) — present, contents unknown. ' +
	"files_info.json `file_size`/`file_time` are the FILE's own stat as the oracle read it, " +
	'reproduced by ensureMediaKit() on the planted asset, because a media component emits both ' +
	'verbatim; null when the identity came from a derived-media URL, which is existence-checked ' +
	'but carries no stat.';

const write = (name: string, value: Json): number => {
	const text = `${JSON.stringify(value, null, '\t')}\n`;
	writeFileSync(join(OUT_DIR, name), text);
	return Buffer.byteLength(text, 'utf8');
};

let bytes = 0;
const sectionNames = [...sections.keys()].sort();
for (const name of sectionNames) {
	const bucket = sections.get(name) as NonNullable<ReturnType<typeof sections.get>>;
	bucket.records.sort((a, b) => a.section_id - b.section_id);
	bytes += write(`${name}.json`, { _doc: HEADER, ...bucket });
}
const PENDING_DOC =
	'PARKED. This section has no `test*` ontology clone — on the install it is a ' +
	'`hierarchy20` clone (a thesaurus terms section), and phase 2b synthesises its test twin from ' +
	"`hierarchy20`'s own component set. The records are kept with their SOURCE tipos intact plus " +
	'the section_id this deriver would give them; re-running scripts/derive_test_corpus.ts once ' +
	'the clone exists resolves them into an ordinary test_corpus/<section>.json. Nothing here is ' +
	'loaded by ensureTestCorpus().';
const pendingNames = [...pending.keys()].sort();
for (const name of pendingNames) {
	const bucket = pending.get(name) as NonNullable<ReturnType<typeof pending.get>>;
	bucket.records.sort((a, b) => a.proposed_section_id - b.proposed_section_id);
	const componentTipos = [
		...new Set(bucket.records.flatMap((r) => r.items.map((i) => i.tipo))),
	].sort();
	bytes += write(join('pending', `${name}.json`), {
		_doc: PENDING_DOC,
		...bucket,
		component_tipos_needed: componentTipos,
		models_needed: [
			...new Set(bucket.records.flatMap((r) => r.items.map((i) => i.model ?? 'unknown'))),
		].sort(),
	});
}

bytes += write('tm.json', { _doc: HEADER, rows: tm });
bytes += write('files_info.json', {
	_doc: `${HEADER} Every path is media-root relative; ensureMediaKit() materializes one real asset per path.`,
	files: filesInfo.sort((a, b) => a.file_path.localeCompare(b.file_path)),
});
bytes += write('id_map.json', {
	_doc:
		`${HEADER} Source (section_tipo, section_id) → the test pair. Covers every pair the store ` +
		'ADDRESSES, including pairs with no record, so phase 4 can rewrite an RQO or a locator ' +
		'whose target the corpus does not hold. `kept: false` = the source id collided and a new ' +
		'one was allocated.',
	pairs: Object.fromEntries([...ID_MAP.entries()].sort(([a], [b]) => a.localeCompare(b))),
});
bytes += write('refused.json', {
	_doc:
		`${HEADER} What the derive REFUSED to materialize, grouped by kind. This list is the phase-4 ` +
		'punch list: a gate whose records are here does NOT have a complete corpus.',
	by_kind: Object.fromEntries(
		[...new Set(refusals.map((r) => r.kind))].sort().map((kind) => [
			kind,
			refusals
				.filter((r) => r.kind === kind)
				.sort((a, b) => a.detail.localeCompare(b.detail))
				.map((r) => ({ source: r.source, detail: r.detail, gates: r.gates.sort() })),
		]),
	),
});

/* -------------------------------------------------------------- report */

const recordCount = [...sections.values()].reduce((sum, bucket) => sum + bucket.records.length, 0);
const complete = [...sections.values()].reduce(
	(sum, bucket) => sum + bucket.records.filter((r) => !r.reconstructed).length,
	0,
);
console.log(`[corpus] fixtures scanned      : ${files.length}`);
console.log(`[corpus] pairs addressed       : ${addressed.size}`);
console.log(`[corpus] id map entries        : ${ID_MAP.size}`);
console.log(`[corpus] sections written      : ${sectionNames.length}`);
console.log(
	`[corpus] records written       : ${recordCount} (${complete} from raw rows, ${recordCount - complete} reconstructed)`,
);
console.log(`[corpus] component items kept  : ${itemsKept} (dropped ${itemsDropped})`);
console.log(
	`[corpus] inverse edges written : ${edgesWritten} on ${[...sections.values()].reduce((sum, b) => sum + b.records.filter((r) => r.inverse_edges !== undefined).length, 0)} records (${edgeOnlyWritten} exist only because of an edge)`,
);
console.log(
	`[corpus] pending (phase 2b)    : ${pendingNames.length} sections, ${[...pending.values()].reduce((sum, b) => sum + b.records.length, 0)} records, ${pendingItems} items — ${pendingNames.join(', ')}`,
);
console.log(
	`[corpus] component provenance  : ${sourceCensus.raw} raw (stored bytes), ${sourceCensus.edit} edit-mode, ${sourceCensus.list} LIST PROJECTIONS — ${sourceUpgrades} components upgraded to a richer source, ${sourcePreferenceHeld} poorer sources rejected in favour of one already held`,
);
console.log(`[corpus] tm rows               : ${tm.length}`);
console.log(`[corpus] media files           : ${filesInfo.length}`);
console.log(`[corpus] refusals              : ${refusals.length}`);
console.log(`[corpus] bytes on disk         : ${(bytes / 1e6).toFixed(2)} MB`);
const byKind = new Map<string, number>();
for (const refusal of refusals) byKind.set(refusal.kind, (byKind.get(refusal.kind) ?? 0) + 1);
for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`           refused ${kind.padEnd(30)} ${count}`);
}
for (const name of sectionNames) {
	console.log(
		`           section ${name.padEnd(26)} ${sections.get(name)?.records.length} records`,
	);
}

// Keep the emitted JSON in the repo's own format (`bun run lint` checks these
// files: they are small enough to fall under biome's size cap, unlike the 5 MB
// phase-2 ontology). In --check this formats the TEMP tree, so the comparison
// below is like for like.
Bun.spawnSync(['bunx', 'biome', 'format', '--write', OUT_DIR], {
	stdout: 'ignore',
	stderr: 'ignore',
});

if (CHECK) {
	const listJson = (dir: string): string[] =>
		existsSync(dir)
			? readdirSync(dir)
					.filter((n) => n.endsWith('.json'))
					.sort()
			: [];
	const drift: string[] = [];
	for (const sub of ['', 'pending']) {
		const fresh = join(OUT_DIR, sub);
		const committed = join(COMMITTED_DIR, sub);
		const names = [...new Set([...listJson(fresh), ...listJson(committed)])].sort();
		for (const name of names) {
			const a = existsSync(join(fresh, name)) ? readFileSync(join(fresh, name), 'utf8') : null;
			const b = existsSync(join(committed, name))
				? readFileSync(join(committed, name), 'utf8')
				: null;
			if (a === b) continue;
			const where = join(sub, name);
			if (a === null) drift.push(`${where}: committed but NOT derived`);
			else if (b === null) drift.push(`${where}: derived but NOT committed`);
			else drift.push(`${where}: content differs`);
		}
	}
	rmSync(OUT_DIR, { recursive: true, force: true });
	if (drift.length > 0) {
		console.error(
			`[corpus] --check FAILED: the committed corpus is not what the frozen store derives.\n         ${drift.join('\n         ')}\n         Regenerate with 'bun run scripts/derive_test_corpus.ts'.`,
		);
		process.exit(1);
	}
	console.log('[corpus] --check OK: the committed corpus matches the derivation exactly.');
}
