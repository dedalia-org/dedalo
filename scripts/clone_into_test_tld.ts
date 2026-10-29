/**
 * CLONE install ontology subtrees INTO THE GENERIC `test` TLD — the grower of
 * `src/core/test_data/test_tld_ontology.json` (generic-`test`-TLD migration
 * phase 2, 2026-08-19).
 *
 *   bun run scripts/clone_into_test_tld.ts            # rewrite the JSON + the map
 *   bun run scripts/clone_into_test_tld.ts --dry-run  # print the report, write nothing
 *   bun run scripts/clone_into_test_tld.ts --survey   # list every unresolvable
 *                                                     # reference instead of
 *                                                     # refusing at the first —
 *                                                     # how the manifest's
 *                                                     # `exclude` list is kept
 *                                                     # honest after a root is
 *                                                     # added
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * The law (plan decision 1): a test binds ONLY the generic `test` TLD, the
 * `test*` TLDs the test ontology itself declares, and the six install-invariant
 * TLDs `dd`, `rsc`, `hierarchy`, `ontology`, `ontologytype`, `lg`. Everything
 * else — `numisdata`, `oh`, `tch`, `tchi`, `dmm`, `mdcat`, `zenon`, the country
 * hierarchies… — belongs to SOME install and is red on every other machine. So
 * the structure a gate needs is CLONED into `test` rather than borrowed.
 *
 * ── WHAT IT READS (repo-vendored only; HERMETIC, no database) ────────────────
 *  1. `test/fixtures/ontology/numisdata_ontology.copy.gz` — the numisdata
 *     dd_ontology COPY dump (+ its `.columns.txt`);
 *  2. `install/db/dedalo_install.pgsql.gz` — the seed's `dd_ontology` COPY
 *     block (dd, rsc, oh, hierarchy, ontology…);
 *  3. `install/import/ontology/7.0/<tld>.copy.gz` — the per-TLD ontology dumps
 *     in RECORD form (tch, tchi, dmm, mdcat, actv, ich, mht, render, zenon,
 *     isad, ww, navarra…), parsed by the offline mirror of
 *     `src/core/ontology/parser.ts` below;
 *  4. `src/core/test_data/test_tld_clone_manifest.json` — roots + policy;
 *  5. `src/core/test_data/test_tld_tipo_map.json` — the append-only allocator;
 *  6. `src/core/test_data/test_tld_ontology.json` — the 217 hand-authored
 *     legacy nodes, which are kept verbatim except for their REFERENCES.
 *
 * ── WHAT IT WRITES ───────────────────────────────────────────────────────────
 *  - `src/core/test_data/test_tld_ontology.json` — legacy nodes (references
 *    repaired) + one node per clone + the SYNTHETIC thesaurus twins + one
 *    `<tld>0` main per `test*` TLD;
 *  - `src/core/test_data/test_tld_tipo_map.json` — source tipo → target tipo,
 *    APPEND-ONLY and bijective, with the reason each entry exists;
 *  - a report on stdout (nodes per source TLD, sections, thesaurus TLDs,
 *    references rewritten, everything dropped and why).
 *
 * ── THE RULES IT ENFORCES ────────────────────────────────────────────────────
 *  - REFUSE, never drop: an unresolvable reference that the manifest's
 *    `exclude` does not name aborts the run with the node and path that carries
 *    it. Every drop that DOES happen is a manifest entry with a reason and is
 *    listed in the report.
 *  - Every cloned SECTION carries `{tipo:"test24"}` → `matrix_test`, and loses
 *    any source matrix_table relation. A relation naming another section (a
 *    virtual section) is mapped, not dropped: `getMatrixTableFromTipo` reads
 *    the matrix_table relation FIRST, so a section can be virtual AND stored in
 *    `matrix_test`.
 *  - Every non-main node has a parent, and every node's `tipo` starts with its
 *    own `tld` (the two shape rules `materializeTestTldOntology` checks).
 *  - THE SYNTHETIC PASS (phase 2b, manifest `synthetic_thesauri`): a section a
 *    gate addresses but that NO local ontology source defines (`cult1`,
 *    `terr1`, `tema1`, `sccmk1`, the `sc*1` script thesauri…) is, on the
 *    install, a clone of the seed's own `hierarchy20` Thesaurus section. So its
 *    twin is built from that subtree — a `test*` TLD of its own, `<tld>1` terms
 *    section with `relations:[{tipo:"test24"}]`, one clone per hierarchy20 node
 *    (the `hierarchy25` term, the `hierarchy36`/`hierarchy49` parent/children
 *    pair, `hierarchy40` indexations, the list definitions and the section_map).
 *    It is NOT behind a flag: the emitted JSON must be reproducible from the
 *    plain command, so a run either has the twins or the manifest does not.
 *  - `model` stays the derived twin of `model_tipo`
 *    (`dd_ontology[model_tipo].term['lg-spa']`), because that is what the
 *    engine's own parser will produce when the JSON is materialized.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { DdOntologyNode } from '../src/core/db/dd_ontology.ts';
import { phpPrettyJsonEncode } from '../src/core/ontology/parser.ts';

const REPO = join(import.meta.dir, '..');

const MANIFEST_PATH = 'src/core/test_data/test_tld_clone_manifest.json';
const TIPO_MAP_PATH = 'src/core/test_data/test_tld_tipo_map.json';
const ONTOLOGY_PATH = 'src/core/test_data/test_tld_ontology.json';
const NUMISDATA_COPY = 'test/fixtures/ontology/numisdata_ontology.copy.gz';
const NUMISDATA_COLUMNS = 'test/fixtures/ontology/numisdata_ontology.columns.txt';
const SEED_PATH = 'install/db/dedalo_install.pgsql.gz';
const RECORD_DUMP_DIR = 'install/import/ontology/7.0';

/** The primary test TLD, and the area every cloned section hangs off. */
const TEST_TLD = 'test';
const TEST_AREA = 'test1';
/** The `matrix_table` node whose term is `matrix_test` (plan decision 1). */
const MATRIX_TEST_RELATION = 'test24';
/** The first tipo the allocator may hand out — below it everything is hand-authored. */
const CLONE_BAND_START = 1000;

/**
 * The TLDs a test node may reference WITHOUT cloning (plan decision 1). Every
 * installation ships them, so a reference to one is install-invariant.
 */
const ALLOWED_TLDS = new Set(['dd', 'rsc', 'hierarchy', 'ontology', 'ontologytype', 'lg']);

/** A tipo-shaped token, isolated from surrounding identifier characters. */
const TOKEN_RE = /(?<![A-Za-z0-9_])([a-z]{2,})([0-9]+)(?![A-Za-z0-9_])/g;

const tldOf = (tipo: string): string => tipo.replace(/[0-9]+$/, '');
const idOf = (tipo: string): number => Number(tipo.replace(/^[a-z]+/, ''));
/** A `<tld>0` node: the TLD's ontology main, minted by `rebuildOntology`. */
const isTldMain = (tipo: string): boolean => /^[a-z]{2,}0$/.test(tipo);

function refuse(message: string): never {
	throw new Error(`clone_into_test_tld: ${message}`);
}

/* ------------------------------------------------------------- the manifest */

/**
 * A thesaurus with NO local ontology source (phase 2b). On the install it is a
 * CLONE OF `hierarchy20` — the seed's own Thesaurus section — so its twin is
 * SYNTHESISED from that subtree instead of invented: see the manifest's
 * `synthetic_thesauri._doc`.
 */
interface SyntheticSpec {
	/** The `test*` TLD the twin owns (`<tld>1` = its terms section). */
	tld: string;
	/** A readable name (the tree/registry label). The identity is `source_tipo`. */
	term: string;
	/** The seed section the twin is cloned from — `hierarchy20` for every entry. */
	source_tipo: string;
	source_reason: string;
	/** The gates that address the source section (from the derive's ledger). */
	gates: string[];
	/** The ontology sites that reference it (the drops phase 2 had to make). */
	ontology_sites: string[];
	reason: string;
}

interface Manifest {
	policy: {
		properties_expand_paths: string;
		properties_block_paths: string;
		properties_strip_paths: string;
		no_expand_models: string;
	};
	thesaurus_tlds: Record<string, { tld: string; term: string; reason: string } | string>;
	synthetic_thesauri: Record<string, SyntheticSpec | string>;
	exclude: Record<string, { action: string; reason: string } | string>;
	roots: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(REPO, MANIFEST_PATH), 'utf8')) as Manifest;
const EXPAND_PATH_RE = new RegExp(manifest.policy.properties_expand_paths);
const BLOCK_PATH_RE = new RegExp(manifest.policy.properties_block_paths);
const NO_EXPAND_MODEL_RE = new RegExp(manifest.policy.no_expand_models);
const STRIP_PATH_RE = new RegExp(manifest.policy.properties_strip_paths);

/** source section tipo → the `test*` TLD its thesaurus becomes. */
const THESAURUS_TLD = new Map<string, string>();
for (const [source, value] of Object.entries(manifest.thesaurus_tlds)) {
	if (typeof value === 'string') continue; // the `_doc` key
	THESAURUS_TLD.set(source, value.tld);
}
const EXCLUDE = new Map<string, { action: string; reason: string }>();
for (const [token, value] of Object.entries(manifest.exclude)) {
	if (typeof value === 'string') continue; // the `_doc` key
	EXCLUDE.set(token, value);
}
const excludeAction = (token: string): string | null => EXCLUDE.get(token)?.action ?? null;

/**
 * The TLDs the shipped test ontology itself owns: the primary `test` plus one
 * per cloned thesaurus. A token in one of them is already a test tipo (the
 * legacy nodes are full of them) and is left exactly as it is.
 */
const TEST_TLDS = new Set(['test', ...THESAURUS_TLD.values()]);

/** source section tipo → the SYNTHETIC twin the `--synthetic` pass builds. */
const SYNTHETIC = new Map<string, SyntheticSpec>();
for (const [source, value] of Object.entries(manifest.synthetic_thesauri ?? {})) {
	if (typeof value === 'string') continue; // the `_doc` key
	SYNTHETIC.set(source, value);
	TEST_TLDS.add(value.tld);
}

/* ---------------------------------------------------------- source ontology */

interface SourceNode extends DdOntologyNode {
	/** Where the node was read from — for the report and for refusal messages. */
	source: string;
}

const sources = new Map<string, SourceNode>();
const childrenOf = new Map<string, string[]>();
const modelOf = (tipo: string): string | null => sources.get(tipo)?.model ?? null;

/** Undo psql COPY text escaping for one field. */
function unescapeCopy(field: string): string | null {
	if (field === '\\N') return null;
	return field.replace(/\\(.)/g, (_all, char: string) =>
		char === 'n'
			? '\n'
			: char === 't'
				? '\t'
				: char === 'r'
					? '\r'
					: char === '\\'
						? '\\'
						: char === 'b'
							? '\b'
							: char === 'f'
								? '\f'
								: char === 'v'
									? '\v'
									: char,
	);
}

function parseJson(raw: string | null): unknown {
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/** One `dd_ontology` COPY row → a node (the numisdata fixture and the seed). */
function addDdOntologyRow(columns: string[], fields: string[], source: string): void {
	const row: Record<string, string | null> = {};
	columns.forEach((column, index) => {
		row[column] = unescapeCopy(fields[index] ?? '\\N');
	});
	// A column the dump does not carry reads as SQL NULL, exactly as it would.
	const field = (name: string): string | null => row[name] ?? null;
	const tipo = field('tipo');
	if (tipo === null || tipo === '') return;
	if (sources.has(tipo)) return; // first source wins (the fixture before the seed)
	const order = field('order_number');
	sources.set(tipo, {
		tipo,
		parent: field('parent'),
		term: parseJson(field('term')) as Record<string, string> | null,
		model: field('model'),
		order_number: order === null ? null : Math.trunc(Number(order)),
		relations: parseJson(field('relations')) as { tipo: string }[] | null,
		tld: field('tld') ?? tldOf(tipo),
		properties: parseJson(field('properties')) as Record<string, unknown> | null,
		model_tipo: field('model_tipo'),
		is_model: field('is_model') === 't',
		is_translatable: field('is_translatable') !== 'f',
		is_main: field('is_main') === 't',
		propiedades: field('propiedades'),
		source,
	});
}

function loadNumisdataFixture(): void {
	const columns = readFileSync(join(REPO, NUMISDATA_COLUMNS), 'utf8').trim().split(',');
	const text = gunzipSync(readFileSync(join(REPO, NUMISDATA_COPY))).toString('utf8');
	for (const line of text.split('\n')) {
		if (line === '' || line === '\\.') continue;
		addDdOntologyRow(columns, line.split('\t'), 'numisdata_fixture');
	}
}

function loadSeed(): void {
	const text = gunzipSync(readFileSync(join(REPO, SEED_PATH))).toString('utf8');
	const block = /COPY public\.dd_ontology \(([^)]*)\) FROM stdin;\n([\s\S]*?)\n\\\.\n/.exec(text);
	if (block === null) refuse(`${SEED_PATH}: dd_ontology COPY block not found`);
	const columns = (block[1] as string).split(',').map((column) => column.trim());
	for (const line of (block[2] as string).split('\n')) {
		if (line === '' || line === '\\.') continue;
		addDdOntologyRow(columns, line.split('\t'), 'install_seed');
	}
}

/**
 * The per-TLD ontology dumps are in RECORD form (`matrix_ontology` rows), so
 * this is the offline mirror of `parseSectionRecordToOntologyNode`: same
 * components, same defaults (a missing `ontology8` is translatable, `model` is
 * `dd_ontology[model_tipo].term['lg-spa']` strict, `propiedades` is the value
 * re-encoded the PHP way). Run AFTER the two dd_ontology sources so the model
 * lookup can resolve `dd*` nodes.
 */
const RECORD_COLUMNS = [
	'section_id',
	'section_tipo',
	'data',
	'relation',
	'string',
	'date',
	'iri',
	'geo',
	'number',
	'media',
	'misc',
	'relation_search',
	'meta',
];

function loadRecordDumps(): void {
	const alreadyLoaded = new Set([...sources.values()].map((node) => node.tld));
	const dir = join(REPO, RECORD_DUMP_DIR);
	for (const file of readdirSync(dir)
		.filter((name) => name.endsWith('.copy.gz'))
		.sort()) {
		const fileTld = file.replace('.copy.gz', '');
		if (alreadyLoaded.has(fileTld)) continue; // a dd_ontology source already has it
		const text = gunzipSync(readFileSync(join(dir, file))).toString('utf8');
		for (const line of text.split('\n')) {
			if (line === '' || line === '\\.') continue;
			const fields = line.split('\t');
			const record: Record<string, unknown> = {};
			RECORD_COLUMNS.forEach((column, index) => {
				record[column] = parseJson(unescapeCopy(fields[index] ?? '\\N'));
			});
			const sectionId = Number(record.section_id);
			const relation = (record.relation ?? {}) as Record<string, { [k: string]: unknown }[]>;
			const string = (record.string ?? {}) as Record<string, { [k: string]: unknown }[]>;
			const misc = (record.misc ?? {}) as Record<string, { [k: string]: unknown }[]>;
			const number = (record.number ?? {}) as Record<string, { [k: string]: unknown }[]>;

			// The tld is MANDATORY: without `ontology7` the record parses to nothing.
			const tld = string.ontology7?.[0]?.value;
			if (tld === undefined || tld === null || tld === '') continue;
			const tipo = `${String(tld)}${sectionId}`;
			if (sources.has(tipo)) continue;

			const locatorTipo = (locator: unknown): string | null => {
				const item = locator as { section_tipo?: string; section_id?: unknown } | undefined;
				if (item === undefined || item === null || item.section_tipo === undefined) return null;
				return `${tldOf(String(item.section_tipo))}${item.section_id}`;
			};
			const isYes = (items: { section_id?: unknown }[] | undefined): boolean | null =>
				items === undefined || items[0] === undefined ? null : Number(items[0].section_id) === 1;

			const parentLocator = relation.ontology15?.[0] as { section_tipo?: string } | undefined;
			const parent =
				parentLocator !== undefined && parentLocator.section_tipo !== 'ontology35'
					? locatorTipo(parentLocator)
					: null;
			const modelTipo = locatorTipo(relation.ontology6?.[0]);
			const model =
				modelTipo === null
					? null
					: ((sources.get(modelTipo)?.term as Record<string, string> | null)?.['lg-spa'] ?? null);
			const relations = Array.isArray(relation.ontology10)
				? relation.ontology10
						.map((locator) => ({ tipo: locatorTipo(locator) }))
						.filter((item): item is { tipo: string } => item.tipo !== null)
				: null;

			const properties: Record<string, unknown> = {};
			const propertiesValue = misc.ontology18?.[0]?.value;
			if (
				propertiesValue !== undefined &&
				propertiesValue !== null &&
				typeof propertiesValue === 'object' &&
				!Array.isArray(propertiesValue)
			) {
				Object.assign(properties, propertiesValue as Record<string, unknown>);
			}
			const cssValue = misc.ontology16?.[0]?.value;
			if (cssValue !== undefined) properties.css = cssValue;
			const sourceValue = misc.ontology17?.[0]?.value;
			if (sourceValue !== undefined) properties.source = sourceValue;

			const legacyValue = misc.ontology19?.[0]?.value;
			const propiedades =
				legacyValue === undefined || legacyValue === null || legacyValue === ''
					? null
					: phpPrettyJsonEncode(legacyValue);

			const term: Record<string, string> = {};
			for (const item of (string.ontology5 ?? []) as { lang?: string; value?: unknown }[]) {
				if (typeof item.lang === 'string') term[item.lang] = String(item.value ?? '');
			}
			const orderValue = number.ontology41?.[0]?.value;

			sources.set(tipo, {
				tipo,
				parent,
				term: Object.keys(term).length > 0 ? term : null,
				model,
				order_number:
					orderValue === undefined || orderValue === null || orderValue === ''
						? null
						: Math.trunc(Number(orderValue)),
				relations: relations !== null && relations.length > 0 ? relations : null,
				tld: String(tld),
				properties: Object.keys(properties).length > 0 ? properties : null,
				model_tipo: modelTipo,
				is_model: isYes(relation.ontology30 as { section_id?: unknown }[] | undefined) ?? false,
				is_translatable:
					isYes(relation.ontology8 as { section_id?: unknown }[] | undefined) ?? true,
				is_main: tipo === `${String(tld)}0`,
				propiedades,
				source: `record_dump:${fileTld}`,
			});
		}
	}
}

function indexChildren(): void {
	for (const node of sources.values()) {
		if (node.parent === null || node.parent === '') continue;
		const list = childrenOf.get(node.parent);
		if (list === undefined) childrenOf.set(node.parent, [node.tipo]);
		else list.push(node.tipo);
	}
	for (const list of childrenOf.values()) list.sort((a, b) => idOf(a) - idOf(b));
}

/* --------------------------------------------------------- reference walker */

interface Ref {
	token: string;
	/** A stable, index-free description of where it sits (`relations[].tipo`, …). */
	path: string;
}

/**
 * A cloned SECTION's term, made unambiguous — `<source term> | <target tld>`,
 * the same form the `<tld>0` main nodes already take.
 *
 * WHY. A section label is an ADDRESS: `resolveSectionReference` (the MCP
 * discovery door), a tool picker and the area lists all resolve a human name to
 * a tipo, and two sections sharing a name make that resolution ambiguous —
 * `mcp.label_ambiguous`, with no way for the caller to pick. A verbatim clone
 * of `numisdata6` gave the suite database two sections called "Cecas". Only
 * SECTIONS are disambiguated: a component's label is only ever read inside its
 * own section, and rewriting 8,000 of them would bury the clone's fidelity for
 * no addressing gain.
 */
function disambiguatedSectionTerm(
	term: Record<string, string> | null,
	tld: string,
): Record<string, string> | null {
	if (term === null) return null;
	const out: Record<string, string> = {};
	for (const [lang, value] of Object.entries(term)) out[lang] = `${value} | ${tld}`;
	return out;
}

/**
 * A cloned DIFFUSION DOMAIN's term, made install-free — `<target tipo> domain`.
 *
 * WHY. For `diffusion_domain` the term is not display text, it is the
 * IDENTIFIER the engine resolves on: `resolveDomainTipo` picks dd1190's first
 * child whose term equals `DEDALO_DIFFUSION_DOMAIN`
 * (src/core/diffusion_bridge/diffusion_graph.ts). A verbatim clone therefore
 * mints an INSTALLATION's name (`mht`, `mdcat`, `numisdata_*`) into the generic
 * `test` TLD, where it silently WINS that match on the suite database and hands
 * back a truncated 3-node domain — a FOUND domain with an EMPTY section map,
 * indistinguishable from an undiffused install. Tipo-derived names cannot
 * collide with any install's.
 */
function genericDomainTerm(
	term: Record<string, string> | null,
	target: string,
): Record<string, string> | null {
	if (term === null) return null;
	const out: Record<string, string> = {};
	for (const lang of Object.keys(term)) out[lang] = `${target} domain`;
	return out;
}

/** Term of a cloned node: sections disambiguated, diffusion domains de-installed. */
function cloneTerm(
	node: SourceNode,
	target: string,
	targetTld: string,
): Record<string, string> | null {
	if (node.model === 'section') return disambiguatedSectionTerm(node.term, targetTld);
	if (node.model === 'diffusion_domain') return genericDomainTerm(node.term, target);
	return node.term;
}

/**
 * Remove every `properties` path the manifest's `policy.properties_strip_paths`
 * names — applied to CLONES only, never to the 217 hand-authored legacy `test`
 * nodes (they own their own fixtures; the clone only repairs their references).
 *
 * This is not `properties_block_paths`, which merely stops the closure from
 * PULLING a reference in. A stripped path is CAPABILITY the test ontology must
 * not own at all: `api_config` is the external subsystem's one outbound door,
 * and cloning it verbatim handed the suite database a live third-party endpoint.
 */
function stripPolicyPaths(value: unknown, path = ''): unknown {
	if (Array.isArray(value)) return value.map((item) => stripPolicyPaths(item, `${path}[]`));
	if (value === null || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const next = path === '' ? key : `${path}.${key}`;
		if (STRIP_PATH_RE.test(next)) continue;
		out[key] = stripPolicyPaths(item, next);
	}
	return out;
}

/** Every tipo-shaped token inside a `properties` blob, with its path. */
function propertyRefs(value: unknown, path: string, out: Ref[]): void {
	if (value === null || value === undefined) return;
	if (typeof value === 'string') {
		for (const match of value.matchAll(TOKEN_RE)) out.push({ token: match[0], path });
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) propertyRefs(item, `${path}[]`, out);
		return;
	}
	if (typeof value === 'object') {
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			for (const match of key.matchAll(TOKEN_RE)) {
				out.push({ token: match[0], path: `${path}.{key:${key}}` });
			}
			propertyRefs(item, path === '' ? key : `${path}.${key}`, out);
		}
	}
}

const refCache = new Map<string, { relations: Ref[]; properties: Ref[] }>();
function refsOf(tipo: string): { relations: Ref[]; properties: Ref[] } {
	const cached = refCache.get(tipo);
	if (cached !== undefined) return cached;
	const node = sources.get(tipo);
	const relations: Ref[] = [];
	for (const item of node?.relations ?? []) {
		if (typeof item?.tipo === 'string')
			relations.push({ token: item.tipo, path: 'relations[].tipo' });
	}
	const properties: Ref[] = [];
	propertyRefs(node?.properties ?? null, '', properties);
	const value = { relations, properties };
	refCache.set(tipo, value);
	return value;
}

/* ------------------------------------------------------------- the closure */

interface ClosureResult {
	cloned: Set<string>;
	/** tipo → why it entered (the report's audit trail). */
	reason: Map<string, string>;
	/** Tokens that resolve to nothing, with every site that names them. */
	unresolved: Map<string, Set<string>>;
}

function computeClosure(roots: Iterable<string>): ClosureResult {
	const cloned = new Set<string>();
	const reason = new Map<string, string>();
	const unresolved = new Map<string, Set<string>>();
	const queue: string[] = [];

	const discover = (token: string, why: string): void => {
		if (TEST_TLDS.has(tldOf(token))) return; // already a test tipo
		if (ALLOWED_TLDS.has(tldOf(token))) return; // referenced in place, never cloned
		if (isTldMain(token)) return; // minted by rebuildOntology
		if (!sources.has(token)) {
			const sites = unresolved.get(token) ?? new Set<string>();
			sites.add(why);
			unresolved.set(token, sites);
			return;
		}
		if (cloned.has(token)) return;
		cloned.add(token);
		reason.set(token, why);
		queue.push(token);
	};

	for (const root of roots) discover(root, 'manifest root');

	while (queue.length > 0) {
		const tipo = queue.shift() as string;
		const node = sources.get(tipo) as SourceNode;

		// (a) The parent chain, up to and including the node's SECTION. A cloned
		// section is re-parented (`test1` / its own `<tld>0`), so the install
		// `area` and grouper nodes above it are never cloned.
		let current = tipo;
		let parent = node.parent;
		while (parent !== null && parent !== '' && modelOf(current) !== 'section') {
			discover(parent, `${current} @parent`);
			if (!sources.has(parent) || ALLOWED_TLDS.has(tldOf(parent))) break;
			current = parent;
			parent = sources.get(parent)?.parent ?? null;
		}

		// (b) Relations — ALWAYS followed: a relation is structure, and a node
		// whose relation dangles is a broken node.
		for (const ref of refsOf(tipo).relations) discover(ref.token, `${tipo} @${ref.path}`);

		// The diffusion/RDF projection models are cloned whole but not expanded.
		if (node.model !== null && NO_EXPAND_MODEL_RE.test(node.model)) continue;

		// (c) The whole subtree.
		const stack = [tipo];
		while (stack.length > 0) {
			const cursor = stack.pop() as string;
			for (const child of childrenOf.get(cursor) ?? []) {
				discover(child, `${cursor} @child`);
				if (sources.has(child) && !ALLOWED_TLDS.has(tldOf(child))) stack.push(child);
			}
		}

		// (d) Structural `properties` references (the manifest's path policy).
		for (const ref of refsOf(tipo).properties) {
			if (!EXPAND_PATH_RE.test(ref.path) || BLOCK_PATH_RE.test(ref.path)) continue;
			discover(ref.token, `${tipo} @properties.${ref.path}`);
		}
	}
	return { cloned, reason, unresolved };
}

/* --------------------------------------------------------- target TLD + map */

/** The section a node belongs to (itself when it IS a section). */
function sectionOf(tipo: string): string | null {
	let cursor: string | null = tipo;
	const seen = new Set<string>();
	while (cursor !== null && !seen.has(cursor)) {
		seen.add(cursor);
		if (modelOf(cursor) === 'section') return cursor;
		cursor = sources.get(cursor)?.parent ?? null;
	}
	return null;
}

/**
 * The target TLD of a clone: its own `test*` TLD when it belongs to a thesaurus
 * the manifest names, else the primary `test` TLD.
 */
function targetTldOf(tipo: string): string {
	const section = sectionOf(tipo);
	if (section !== null) {
		const thesaurus = THESAURUS_TLD.get(section);
		if (thesaurus !== undefined) return thesaurus;
	}
	return TEST_TLD;
}

interface TipoMapDocument {
	_doc?: string;
	_band_doc?: string;
	map: Record<string, { target: string; reason: string }>;
}

function loadTipoMap(): TipoMapDocument {
	try {
		return JSON.parse(readFileSync(join(REPO, TIPO_MAP_PATH), 'utf8')) as TipoMapDocument;
	} catch {
		return { map: {} };
	}
}

/* ---------------------------------------------------------------- rewriting */

interface DropRecord {
	node: string;
	path: string;
	token: string;
	reason: string;
}

/**
 * `--survey`: collect every unresolvable reference instead of refusing at the
 * first one, so a maintainer can classify them in ONE pass. It writes nothing
 * and always exits non-zero when it found any — it is a diagnosis mode, never a
 * way to ship an unresolved reference.
 */
const SURVEY = process.argv.includes('--survey');
const surveyed = new Map<string, Set<string>>();

/**
 * Source nodes the closure reached but that CANNOT become an ontology node:
 * their `model` does not resolve. `model` is `dd_ontology[model_tipo].term
 * ['lg-spa']`, so a node whose `ontology6` points outside the `dd` model
 * ontology (the `tch`→`crm` CIDOC corner) has no model at all — the engine
 * cannot dispatch it, `materializeTestTldOntology` would write a node the gate
 * rejects, and its descendants inherit the problem. They are pruned WITH their
 * subtree, and every reference to one is dropped with this reason.
 */
const PRUNED = new Map<string, string>();

const drops: DropRecord[] = [];
const keptTokens = new Map<string, Set<string>>();
let rewrittenRefs = 0;

/**
 * The target of ONE token, or a marker of what to do with it.
 *  - a string: rewrite to it;
 *  - `'keep'`: leave verbatim (a manifest `keep_token` — it is not a tipo);
 *  - `'drop'`: the caller must remove the element that carries it.
 */
function resolveToken(
	token: string,
	map: Map<string, string>,
	nodeTipo: string,
	path: string,
	targetTld: string,
	overrides?: Map<string, string>,
): string | 'keep' | 'drop' {
	// The SYNTHETIC pass rewrites a `hierarchy20` subtree into one test TLD: the
	// subtree's own tipos are in an ALLOWED TLD, so they would otherwise be kept
	// verbatim — the overrides say "inside THIS twin, this node is that clone".
	const override = overrides?.get(token);
	if (override !== undefined) {
		if (override === SYNTHETIC_DROP) {
			drops.push({
				node: nodeTipo,
				path,
				token,
				reason:
					'an install extension of the seed section the synthetic twin is cloned from — not part of the shipped shape',
			});
			return 'drop';
		}
		rewrittenRefs++;
		return override;
	}
	if (TEST_TLDS.has(tldOf(token))) return 'keep'; // already a test tipo
	if (ALLOWED_TLDS.has(tldOf(token))) return 'keep';
	if (isTldMain(token)) {
		// A reference to some install's ontology main becomes a reference to the
		// main of the TLD the referring node now lives in.
		rewrittenRefs++;
		return `${targetTld}0`;
	}
	const mapped = map.get(token);
	if (mapped !== undefined) {
		rewrittenRefs++;
		return mapped;
	}
	const action = excludeAction(token);
	if (action === 'keep_token' || action === 'not_a_root') {
		const sites = keptTokens.get(token) ?? new Set<string>();
		sites.add(`${nodeTipo}.${path}`);
		keptTokens.set(token, sites);
		return 'keep';
	}
	if (action === 'drop_ref') {
		drops.push({
			node: nodeTipo,
			path,
			token,
			reason: EXCLUDE.get(token)?.reason ?? '',
		});
		return 'drop';
	}
	const pruneReason = PRUNED.get(token);
	if (pruneReason !== undefined) {
		drops.push({ node: nodeTipo, path, token, reason: pruneReason });
		return 'drop';
	}
	if (SURVEY) {
		const sites = surveyed.get(token) ?? new Set<string>();
		sites.add(`${nodeTipo}.${path}`);
		surveyed.set(token, sites);
		return 'keep';
	}
	refuse(
		`UNRESOLVABLE reference '${token}' at ${nodeTipo}.${path}. It is neither in the clone set nor in an allowed TLD (${[...ALLOWED_TLDS].join(', ')}), and '${MANIFEST_PATH}' does not name it under \`exclude\`. Add it to the manifest roots (to clone it) or to \`exclude\` (with the reason it is not a reference) — this script never drops a reference silently.`,
	);
}

/**
 * Rewrite every tipo token inside a properties/propiedades value. Returns the
 * new value, or the `DROP` sentinel when the value itself carries a token the
 * manifest says to drop — the caller then removes it from its container.
 */
const DROP = Symbol('drop');

/**
 * The overrides map's "remove this reference" value (see the synthetic pass).
 * Not a tipo — the grammar is `[a-z]{2,}[0-9]+`, so it can never collide.
 */
const SYNTHETIC_DROP = '\u0000drop';

function rewriteValue(
	value: unknown,
	path: string,
	map: Map<string, string>,
	nodeTipo: string,
	targetTld: string,
	overrides?: Map<string, string>,
): unknown | typeof DROP {
	if (value === null || value === undefined) return value;
	if (typeof value === 'string') {
		let dropped = false;
		const next = value.replace(TOKEN_RE, (token) => {
			const resolved = resolveToken(token, map, nodeTipo, path, targetTld, overrides);
			if (resolved === 'drop') {
				dropped = true;
				return token;
			}
			return resolved === 'keep' ? token : resolved;
		});
		return dropped ? DROP : next;
	}
	if (Array.isArray(value)) {
		const out: unknown[] = [];
		for (const item of value) {
			const next = rewriteValue(item, `${path}[]`, map, nodeTipo, targetTld, overrides);
			if (next !== DROP) out.push(next); // the element carrying a dropped ref goes
		}
		return out;
	}
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		let dropped = false;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			let keyDropped = false;
			const nextKey = key.replace(TOKEN_RE, (token) => {
				const resolved = resolveToken(
					token,
					map,
					nodeTipo,
					`${path}.{key:${key}}`,
					targetTld,
					overrides,
				);
				if (resolved === 'drop') {
					keyDropped = true;
					return token;
				}
				return resolved === 'keep' ? token : resolved;
			});
			if (keyDropped) {
				// the keyed entry goes (as the comment below states) — its value is not visited
				dropped = true;
				continue;
			}
			const next = rewriteValue(
				item,
				path === '' ? key : `${path}.${key}`,
				map,
				nodeTipo,
				targetTld,
				overrides,
			);
			if (next === DROP) {
				dropped = true;
				continue;
			}
			out[nextKey] = next;
		}
		// An OBJECT never disappears wholesale for a dropped key: only an array
		// element does (a ddo_map entry, an sqo value). A dropped key inside an
		// object is simply absent — recorded in `drops` either way.
		return dropped && Object.keys(out).length === 0 ? DROP : out;
	}
	return value;
}

/** Rewrite a node's `relations`, honouring the section law. */
function rewriteRelations(
	node: SourceNode,
	map: Map<string, string>,
	targetTld: string,
): { tipo: string }[] | null {
	const out: { tipo: string }[] = [];
	for (const item of node.relations ?? []) {
		const token = item?.tipo;
		if (typeof token !== 'string') continue;
		// A cloned section loses its source matrix_table relation: `test24` below
		// is the only one it may carry.
		if (node.model === 'section' && modelOf(token) === 'matrix_table') {
			continue;
		}
		const resolved = resolveToken(token, map, node.tipo, 'relations[].tipo', targetTld);
		if (resolved === 'drop') continue;
		out.push({ tipo: resolved === 'keep' ? token : resolved });
	}
	if (node.model === 'section') {
		// Plan decision 1: every test section stores in `matrix_test`.
		out.push({ tipo: MATRIX_TEST_RELATION });
	}
	return out.length > 0 ? out : null;
}

/** The parent a cloned node gets (module header, `section_parent` policy). */
function rewriteParent(
	node: SourceNode,
	map: Map<string, string>,
	targetTld: string,
	thesaurusAnchor: boolean,
): string {
	if (thesaurusAnchor) {
		// A thesaurus anchor is the terms section of its own TLD: it hangs off
		// that TLD's main, where every hierarchy hardcode expects `<tld>1`.
		return `${targetTld}0`;
	}
	const parent = node.parent;
	if (parent !== null && parent !== '') {
		const mapped = map.get(parent);
		if (mapped !== undefined) return mapped;
		if (ALLOWED_TLDS.has(tldOf(parent))) return parent;
	}
	if (node.model === 'section') return TEST_AREA;
	refuse(
		`node '${node.tipo}' (model ${node.model}) has parent '${parent}', which is neither cloned nor in an allowed TLD, and the node is not a section that could be re-parented.`,
	);
}

/* ---------------------------------------------------------------- the main */

function naturalCompare(a: string, b: string): number {
	const tldA = tldOf(a);
	const tldB = tldOf(b);
	if (tldA !== tldB) return tldA < tldB ? -1 : 1;
	return idOf(a) - idOf(b);
}

function main(): void {
	const dryRun = process.argv.includes('--dry-run');

	loadNumisdataFixture();
	loadSeed();
	loadRecordDumps();
	indexChildren();

	// --- roots ------------------------------------------------------------
	const roots: string[] = [];
	const missingRoots: string[] = [];
	for (const tipo of Object.keys(manifest.roots)) {
		if (!sources.has(tipo)) {
			missingRoots.push(tipo);
			continue;
		}
		roots.push(tipo);
	}
	if (missingRoots.length > 0) {
		refuse(
			`manifest root(s) absent from every local ontology source: ${missingRoots.join(', ')}. Either vendor the source dump or move the tipo to \`exclude\` with a reason.`,
		);
	}

	// --- closure ----------------------------------------------------------
	const closure = computeClosure(roots);

	// --- prune the undispatchable ----------------------------------------
	// A node with no resolvable `model` cannot be an ontology node (see PRUNED),
	// and neither can anything hanging off it.
	for (const tipo of closure.cloned) {
		if (modelOf(tipo) === null) {
			PRUNED.set(
				tipo,
				`source node '${tipo}' has no resolvable model (model_tipo '${sources.get(tipo)?.model_tipo}' is not a dd model node) — pruned with its subtree`,
			);
		}
	}
	for (let grew = true; grew; ) {
		grew = false;
		for (const tipo of closure.cloned) {
			const parent = sources.get(tipo)?.parent ?? null;
			if (parent !== null && PRUNED.has(parent) && !PRUNED.has(tipo)) {
				PRUNED.set(tipo, `descendant of the pruned node '${parent}'`);
				grew = true;
			}
		}
	}
	for (const tipo of PRUNED.keys()) closure.cloned.delete(tipo);

	// Unresolvable tokens are only tolerated when the manifest names them; the
	// rewrite pass refuses the rest with the exact site, so nothing is silent.
	const clonedList = [...closure.cloned].sort(naturalCompare);

	// --- allocation (append-only, bijective) ------------------------------
	const mapDocument = loadTipoMap();
	const map = new Map<string, string>();
	const used = new Map<string, Set<number>>();
	const reasons = new Map<string, string>();
	for (const [source, entry] of Object.entries(mapDocument.map)) {
		map.set(source, entry.target);
		reasons.set(source, entry.reason);
		const bucket = used.get(tldOf(entry.target)) ?? new Set<number>();
		bucket.add(idOf(entry.target));
		used.set(tldOf(entry.target), bucket);
	}

	// The thesaurus anchors are PINNED to `<tld>1` — the terms section of their
	// own TLD, the place every hierarchy hardcode expects it (phase 0 §1.2).
	const anchors = new Set<string>();
	for (const [section, tld] of THESAURUS_TLD) {
		if (!closure.cloned.has(section)) continue;
		anchors.add(section);
		if (!map.has(section)) {
			map.set(section, `${tld}1`);
			reasons.set(
				section,
				`thesaurus anchor: the terms section of the '${tld}' TLD (manifest thesaurus_tlds)`,
			);
			const bucket = used.get(tld) ?? new Set<number>();
			bucket.add(1);
			used.set(tld, bucket);
		}
	}

	const nextId = (tld: string): number => {
		const bucket = used.get(tld) ?? new Set<number>();
		let id = CLONE_BAND_START;
		while (bucket.has(id)) id++;
		bucket.add(id);
		used.set(tld, bucket);
		return id;
	};

	// Deterministic order: by target TLD, then by source tipo (tld, numeric id).
	const byTargetTld = new Map<string, string[]>();
	for (const tipo of clonedList) {
		const tld = targetTldOf(tipo);
		const list = byTargetTld.get(tld) ?? [];
		list.push(tipo);
		byTargetTld.set(tld, list);
	}
	for (const tld of [...byTargetTld.keys()].sort()) {
		for (const tipo of (byTargetTld.get(tld) as string[]).sort(naturalCompare)) {
			if (map.has(tipo)) continue;
			map.set(tipo, `${tld}${nextId(tld)}`);
			reasons.set(tipo, closure.reason.get(tipo) ?? 'clone');
		}
	}
	// --- the SYNTHETIC thesauri (phase 2b) --------------------------------
	// A section with no local ontology source, but which some gate addresses.
	// On the install it is a clone of `hierarchy20`; here it becomes a `test*`
	// TLD of its own whose nodes are clones of hierarchy20's subtree. The map
	// keys them `<source section>@<hierarchy tipo>`, because ONE hierarchy20
	// node becomes a DIFFERENT component in every twin.
	// SEED-OWNED ONLY: an install may hang its OWN components off the seed's
	// `hierarchy20` (mdcat1235/1236, tch60, tchi59 do exactly that). Those are
	// that install's extension, not the shipped thesaurus shape, so they are not
	// part of a twin — and a reference to one is DROPPED (`syntheticDrops`)
	// rather than retargeted at their unrelated clone in another section.
	const syntheticSubtree = (root: string): { own: string[]; foreign: string[] } => {
		const own: string[] = [];
		const foreign: string[] = [];
		const rootTld = tldOf(root);
		const stack = [root];
		while (stack.length > 0) {
			const cursor = stack.pop() as string;
			if (tldOf(cursor) !== rootTld) {
				foreign.push(cursor);
				continue; // its subtree is that install's too
			}
			own.push(cursor);
			for (const child of childrenOf.get(cursor) ?? []) stack.push(child);
		}
		return { own: own.sort(naturalCompare), foreign: foreign.sort(naturalCompare) };
	};
	const syntheticKey = (section: string, tipo: string): string => `${section}@${tipo}`;
	const syntheticSources = [...SYNTHETIC.keys()].sort(naturalCompare);
	for (const section of syntheticSources) {
		const spec = SYNTHETIC.get(section) as SyntheticSpec;
		if (!sources.has(spec.source_tipo)) {
			refuse(
				`synthetic thesaurus '${section}': its source '${spec.source_tipo}' is absent from every local ontology source.`,
			);
		}
		if (sources.has(section)) {
			refuse(
				`synthetic thesaurus '${section}' HAS a local ontology source — clone it (manifest \`roots\`) instead of synthesising it.`,
			);
		}
		if (!map.has(section)) {
			map.set(section, `${spec.tld}1`);
			reasons.set(
				section,
				`synthetic thesaurus anchor: the terms section of the '${spec.tld}' TLD, synthesised from '${spec.source_tipo}' (manifest synthetic_thesauri)`,
			);
			const bucket = used.get(spec.tld) ?? new Set<number>();
			bucket.add(1);
			used.set(spec.tld, bucket);
		}
		for (const tipo of syntheticSubtree(spec.source_tipo).own) {
			if (tipo === spec.source_tipo) continue; // the anchor, pinned to <tld>1
			const key = syntheticKey(section, tipo);
			if (map.has(key)) continue;
			map.set(key, `${spec.tld}${nextId(spec.tld)}`);
			reasons.set(
				key,
				`synthetic thesaurus '${section}': the twin of '${tipo}' (${modelOf(tipo) ?? '?'}) from the '${spec.source_tipo}' subtree`,
			);
		}
	}

	// Bijection: two sources may never share a target.
	const inverse = new Map<string, string>();
	for (const [source, target] of map) {
		const other = inverse.get(target);
		if (other !== undefined)
			refuse(`tipo map is not bijective: ${source} and ${other} → ${target}`);
		inverse.set(target, source);
	}

	// --- clone ------------------------------------------------------------
	const clonedNodes: DdOntologyNode[] = [];
	for (const tipo of clonedList) {
		const node = sources.get(tipo) as SourceNode;
		const target = map.get(tipo) as string;
		const targetTld = tldOf(target);
		const rewritten = rewriteValue(node.properties, '', map, tipo, targetTld);
		const properties = rewritten === DROP ? DROP : stripPolicyPaths(rewritten);
		clonedNodes.push({
			tipo: target,
			parent: rewriteParent(node, map, targetTld, anchors.has(tipo)),
			term: cloneTerm(node, target, targetTld),
			model: node.model,
			order_number: node.order_number,
			relations: rewriteRelations(node, map, targetTld),
			tld: targetTld,
			properties:
				properties === DROP || properties === null || Object.keys(properties as object).length === 0
					? null
					: (properties as Record<string, unknown>),
			model_tipo: node.model_tipo,
			is_model: node.is_model,
			is_translatable: node.is_translatable,
			is_main: false,
			// v5 legacy blob — never cloned (manifest policy.propiedades).
			propiedades: null,
		});
	}

	// --- the SYNTHETIC thesaurus nodes ------------------------------------
	const syntheticNodes: DdOntologyNode[] = [];
	for (const section of syntheticSources) {
		const spec = SYNTHETIC.get(section) as SyntheticSpec;
		const { own: subtree, foreign } = syntheticSubtree(spec.source_tipo);
		// Inside this twin, every subtree tipo resolves to ITS clone — including
		// the anchor, so a `hierarchy20` self-reference lands on `<tld>1`.
		const overrides = new Map<string, string>([[spec.source_tipo, `${spec.tld}1`]]);
		for (const tipo of subtree) {
			if (tipo === spec.source_tipo) continue;
			overrides.set(tipo, map.get(syntheticKey(section, tipo)) as string);
		}
		// An install's own extension of the seed section is not in the twin.
		for (const tipo of foreign) overrides.set(tipo, SYNTHETIC_DROP);
		for (const tipo of subtree) {
			const node = sources.get(tipo) as SourceNode;
			const target = overrides.get(tipo) as string;
			const isAnchor = tipo === spec.source_tipo;
			const rewritten = rewriteValue(node.properties, '', map, target, spec.tld, overrides);
			const properties = rewritten === DROP ? DROP : stripPolicyPaths(rewritten);
			const relations: { tipo: string }[] = [];
			for (const item of node.relations ?? []) {
				if (typeof item?.tipo !== 'string') continue;
				// The anchor keeps NO source matrix_table relation: `test24` only.
				if (isAnchor && modelOf(item.tipo) === 'matrix_table') continue;
				const resolved = resolveToken(
					item.tipo,
					map,
					target,
					'relations[].tipo',
					spec.tld,
					overrides,
				);
				if (resolved === 'drop') continue;
				relations.push({ tipo: resolved === 'keep' ? item.tipo : resolved });
			}
			if (isAnchor) relations.push({ tipo: MATRIX_TEST_RELATION });
			syntheticNodes.push({
				tipo: target,
				parent: isAnchor
					? `${spec.tld}0`
					: (overrides.get(String(node.parent)) ??
						refuse(
							`synthetic thesaurus '${section}': node '${tipo}' has parent '${String(node.parent)}' outside the '${spec.source_tipo}' subtree.`,
						)),
				// The anchor is NAMED by the manifest (the tree/registry label);
				// every component keeps the seed's own term, in every language.
				term: isAnchor ? { 'lg-eng': spec.term, 'lg-spa': spec.term } : node.term,
				model: node.model,
				order_number: isAnchor ? 1 : node.order_number,
				relations: relations.length > 0 ? relations : null,
				tld: spec.tld,
				properties:
					properties === DROP ||
					properties === null ||
					Object.keys(properties as object).length === 0
						? null
						: (properties as Record<string, unknown>),
				model_tipo: node.model_tipo,
				is_model: node.is_model,
				is_translatable: node.is_translatable,
				is_main: false,
				propiedades: null,
			});
		}
	}

	// --- the `test*` main nodes -------------------------------------------
	// A new TLD needs its `<tld>0` node in the JSON: `rebuildOntology` mints it
	// from the `matrix_ontology_main` registry row, which
	// `materializeTestTldOntology` provisions from exactly this node.
	const testMain = JSON.parse(readFileSync(join(REPO, ONTOLOGY_PATH), 'utf8')) as {
		nodes: DdOntologyNode[];
	};
	// The BAND is what tells a hand-authored node from a clone on a re-run:
	// everything below 1000 in the primary `test` TLD is hand-authored and is
	// carried over verbatim (references apart); everything the allocator ever
	// produced is regenerated from the sources.
	const legacyNodes = testMain.nodes.filter(
		(node) => node.tld === TEST_TLD && idOf(node.tipo) < CLONE_BAND_START,
	);
	const primaryMain = legacyNodes.find((node) => node.is_main === true) as DdOntologyNode;
	const mainNodes: DdOntologyNode[] = [];
	const mainSpecs: { tld: string; label: string }[] = [];
	for (const [section, tld] of THESAURUS_TLD) {
		if (!closure.cloned.has(section)) continue;
		const term = (sources.get(section)?.term ?? null) as Record<string, string> | null;
		mainSpecs.push({ tld, label: term?.['lg-eng'] ?? term?.['lg-spa'] ?? tld });
	}
	for (const section of syntheticSources) {
		const spec = SYNTHETIC.get(section) as SyntheticSpec;
		mainSpecs.push({ tld: spec.tld, label: spec.term });
	}
	for (const { tld, label } of mainSpecs) {
		mainNodes.push({
			tipo: `${tld}0`,
			parent: primaryMain.parent, // the same ontology typology grouper as `test0`
			term: { 'lg-eng': `${label} | ${tld}`, 'lg-spa': `${label} | ${tld}` },
			model: primaryMain.model,
			order_number: null,
			relations: primaryMain.relations,
			tld,
			properties: { color: '#2d8894', main_tld: tld },
			model_tipo: primaryMain.model_tipo,
			is_model: false,
			is_translatable: false,
			is_main: true,
			propiedades: null,
		});
	}

	// --- repair the legacy nodes' references ------------------------------
	const repairedLegacy: DdOntologyNode[] = legacyNodes.map((node) => {
		if (node.is_main === true) return node;
		const properties = rewriteValue(node.properties, '', map, node.tipo, TEST_TLD);
		const legacy =
			node.propiedades === null
				? null
				: (rewriteValue(node.propiedades, 'propiedades', map, node.tipo, TEST_TLD) as string);
		const relations: { tipo: string }[] = [];
		for (const item of node.relations ?? []) {
			const resolved = resolveToken(item.tipo, map, node.tipo, 'relations[].tipo', TEST_TLD);
			if (resolved === 'drop') continue;
			relations.push({ tipo: resolved === 'keep' ? item.tipo : resolved });
		}
		let parent = node.parent;
		if (parent !== null && parent !== '') {
			const resolved = resolveToken(parent, map, node.tipo, 'parent', TEST_TLD);
			if (resolved === 'drop') refuse(`legacy node '${node.tipo}': its parent may not be dropped`);
			parent = resolved === 'keep' ? parent : resolved;
		}
		return {
			...node,
			parent,
			relations: relations.length > 0 ? relations : null,
			properties:
				properties === DROP || properties === null ? null : (properties as Record<string, unknown>),
			propiedades: legacy === null || (legacy as unknown) === DROP ? null : legacy,
		};
	});

	// --- assemble ----------------------------------------------------------
	const allNodes = [...repairedLegacy, ...mainNodes, ...clonedNodes, ...syntheticNodes];
	const tldOrder = [TEST_TLD, ...[...new Set(allNodes.map((node) => node.tld))].sort()].filter(
		(tld, index, list) => list.indexOf(tld) === index,
	);
	allNodes.sort((a, b) => {
		const orderA = tldOrder.indexOf(String(a.tld));
		const orderB = tldOrder.indexOf(String(b.tld));
		return orderA !== orderB ? orderA - orderB : idOf(a.tipo) - idOf(b.tipo);
	});

	// STALE-MAP GUARD. The legacy nodes are read back from the file this script
	// wrote last time, so their references are ALREADY in test terms — which is
	// only sound while `test_tld_tipo_map.json` stays append-only. Deleting or
	// re-numbering the map silently leaves a legacy node pointing at an id that
	// no longer exists, and nothing downstream would notice (a `test*` token is
	// never rewritten). So: every test token a node names must be a node.
	const allTipos = new Set(allNodes.map((node) => node.tipo));
	const stale = new Set<string>();
	for (const node of allNodes) {
		const tokens = [
			...(node.parent === null ? [] : [node.parent]),
			...(node.relations ?? []).map((item) => item.tipo),
			...(JSON.stringify(node.properties ?? null).match(TOKEN_RE) ?? []),
		];
		for (const token of tokens) {
			if (!TEST_TLDS.has(tldOf(token)) || allTipos.has(token)) continue;
			stale.add(`${node.tipo} → ${token}`);
		}
	}
	if (stale.size > 0) {
		refuse(
			`${stale.size} reference(s) to a test tipo that does not exist — the tipo map and the ontology JSON are out of step (was the map deleted or renumbered? it is APPEND-ONLY). Restore both from git and re-run. First: ${[...stale].sort().slice(0, 5).join(', ')}`,
		);
	}

	const document = {
		_doc: `Generic \`${TEST_TLD}\` TLD ontology — THE SOURCE OF RECORD (generic-\`test\`-TLD migration, 2026-08-19). The database is derived from this file through src/core/test_data/test_tld_materialize.ts (matrix_ontology records → rebuildOntology), never the other way round. It holds the ${repairedLegacy.length} hand-authored legacy nodes plus the install subtrees CLONED into the test TLDs by scripts/clone_into_test_tld.ts (manifest: ${MANIFEST_PATH}, allocator: ${TIPO_MAP_PATH}). Re-run that script rather than hand-editing a cloned node; the legacy nodes below id 1000 are hand-authored and safe to edit. Gate: test/unit/test_tld_ontology_gate.test.ts.`,
		tld: TEST_TLD,
		tlds: tldOrder,
		node_count: allNodes.length,
		nodes: allNodes,
	};

	const mapOut: TipoMapDocument = {
		_doc: `Source install tipo → its clone in a test TLD (generic-\`test\`-TLD migration phase 2). APPEND-ONLY and BIJECTIVE: an entry never changes target, because a fixture transform and every rewritten gate address the clone by this name. Generated by scripts/clone_into_test_tld.ts from ${MANIFEST_PATH}; a new manifest root only ADDS rows.`,
		_band_doc: `Allocated ids start at ${CLONE_BAND_START} in every target TLD. Below that band everything is hand-authored: the ${repairedLegacy.length} legacy \`test\` nodes, and the \`<tld>0\`/\`<tld>1\` anchors of each thesaurus TLD.`,
		map: Object.fromEntries(
			[...map.keys()]
				.sort(naturalCompare)
				.map((source) => [
					source,
					{ target: map.get(source) as string, reason: reasons.get(source) ?? 'clone' },
				]),
		),
	};

	// --- report ------------------------------------------------------------
	const perSourceTld: Record<string, number> = {};
	for (const tipo of clonedList) perSourceTld[tldOf(tipo)] = (perSourceTld[tldOf(tipo)] ?? 0) + 1;
	const perTargetTld: Record<string, number> = {};
	for (const node of allNodes) {
		perTargetTld[String(node.tld)] = (perTargetTld[String(node.tld)] ?? 0) + 1;
	}
	const sections = allNodes.filter((node) => node.model === 'section' && node.is_main !== true);

	const lines: string[] = [];
	lines.push('clone_into_test_tld report');
	lines.push(`  manifest roots      : ${roots.length}`);
	lines.push(`  cloned nodes        : ${clonedList.length}`);
	lines.push(`  legacy nodes kept   : ${repairedLegacy.length}`);
	lines.push(`  new <tld>0 mains    : ${mainNodes.length}`);
	lines.push(
		`  synthetic thesauri  : ${syntheticSources.length} TLDs / ${syntheticNodes.length} nodes (hierarchy20 twins, manifest synthetic_thesauri)`,
	);
	lines.push(`  TOTAL nodes         : ${allNodes.length}`);
	lines.push(
		`  sections            : ${sections.length} (all → matrix_test via ${MATRIX_TEST_RELATION})`,
	);
	lines.push(`  test TLDs           : ${tldOrder.length} — ${tldOrder.join(', ')}`);
	lines.push(`  references rewritten: ${rewrittenRefs}`);
	lines.push('  clones per SOURCE tld:');
	for (const [tld, count] of Object.entries(perSourceTld).sort((a, b) => b[1] - a[1])) {
		lines.push(`    ${tld.padEnd(18)} ${count}`);
	}
	lines.push('  nodes per TARGET tld:');
	for (const [tld, count] of Object.entries(perTargetTld).sort((a, b) => b[1] - a[1])) {
		lines.push(`    ${tld.padEnd(18)} ${count}`);
	}
	if (PRUNED.size > 0) {
		lines.push(`  PRUNED (no dispatchable model, with their subtrees): ${PRUNED.size}`);
		for (const [tipo, reason] of [...PRUNED].sort()) lines.push(`    ${tipo} — ${reason}`);
	}
	if (drops.length > 0) {
		lines.push(`  DROPPED references (manifest \`exclude\` action drop_ref): ${drops.length}`);
		const byToken = new Map<string, DropRecord[]>();
		for (const drop of drops) {
			const list = byToken.get(drop.token) ?? [];
			list.push(drop);
			byToken.set(drop.token, list);
		}
		for (const [token, list] of [...byToken].sort()) {
			lines.push(
				`    ${token} ×${list.length} — ${list[0]?.reason ?? ''} [${list
					.slice(0, 3)
					.map((drop) => `${drop.node}.${drop.path}`)
					.join(', ')}]`,
			);
		}
	}
	if (keptTokens.size > 0) {
		lines.push(`  KEPT verbatim (manifest \`exclude\` action keep_token): ${keptTokens.size}`);
		for (const [token, sites] of [...keptTokens].sort()) {
			lines.push(`    ${token} — ${[...sites].sort().join(', ')}`);
		}
	}
	const stillUnresolved = [...closure.unresolved].filter(([token]) => !SYNTHETIC.has(token));
	if (SYNTHETIC.size > 0) {
		lines.push('  SYNTHESISED (no local ontology source, twinned from hierarchy20):');
		for (const section of syntheticSources) {
			const spec = SYNTHETIC.get(section) as SyntheticSpec;
			lines.push(
				`    ${section.padEnd(14)} → ${spec.tld}1  ${[...(closure.unresolved.get(section) ?? [])].length} ontology site(s), ${spec.gates.length} gate(s)`,
			);
		}
	}
	if (stillUnresolved.length > 0) {
		lines.push(`  tokens with no local ontology source (not cloned): ${stillUnresolved.length}`);
		for (const [token, sites] of stillUnresolved.sort()) {
			lines.push(`    ${token} ← ${[...sites].slice(0, 3).join('; ')}`);
		}
	}
	console.log(lines.join('\n'));

	if (SURVEY) {
		console.log(`\n--survey: ${surveyed.size} unresolvable token(s)`);
		for (const [token, sites] of [...surveyed].sort()) {
			console.log(`  ${token} ×${sites.size} — ${[...sites].slice(0, 3).join(' ; ')}`);
		}
		if (surveyed.size > 0) process.exitCode = 1;
		return;
	}
	if (dryRun) {
		console.log('\n--dry-run: nothing written.');
		return;
	}
	writeFileSync(join(REPO, ONTOLOGY_PATH), `${JSON.stringify(document, null, '\t')}\n`);
	writeFileSync(join(REPO, TIPO_MAP_PATH), `${JSON.stringify(mapOut, null, '\t')}\n`);
	console.log(
		`\nwrote ${ONTOLOGY_PATH} (${allNodes.length} nodes) and ${TIPO_MAP_PATH} (${map.size} entries)`,
	);
}

main();
