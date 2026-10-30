/**
 * EXTERNAL-VALUE LAW REGISTRY TRIPWIRE — every external mirror an ontology
 * ships maps to exactly ONE law, and every server observe shape it ships maps
 * to ONE target resolver; anything else is a NAMED exemption with a reason.
 *
 * THE DEFECT THIS GATE EXISTS FOR (2026-10-30). The catalog-term coin portals
 * (a `source_overwrite` copy of the coin type's coins, numisdata679/965 on the
 * shipped release) stayed empty: the kernel refused every sub-law node, so a
 * law the ontology declared was silently never run — and nothing said which
 * declared mirrors had no runnable law. Since the registry
 * (src/core/section/record/external_laws/) the classifier is CLOSED: a node is
 * law (c) `inverse_search`, `source_overwrite`, `observed_data`, or a named
 * refusal; the dispatch's resolver table is closed the same way
 * (`classifyObserverServerShape`). This gate runs BOTH over every node the
 * engine can be handed, so "is there a declared mirror no law runs?" is a
 * measured fact, not an audit finding.
 *
 * THE CORPORA (OUTCOME over data, not a spelling of the code):
 *   1. src/core/test_data/test_tld_ontology.json — the suite's own ontology;
 *   2. install/import/ontology/<release>/*.copy.gz — the shipped ontology
 *      packages a museum installs. A row's `properties` is what the parser
 *      folds them into (src/core/ontology/parser.ts resolveProperties):
 *      ontology18's keys + `.css` (ontology16) + `.source` (ontology17). The
 *      packages carry no local overrides (localontology0 is the install's), so
 *      the canonical composition IS the node.
 *
 * WHAT IS PINNED:
 *   A. ANTI-VACUITY: floors on both corpora, on the server shapes and on each
 *      law kind; the release directory exists and is the one the seed
 *      compiles (install/import/ontology/<major.minor>).
 *   B. SHAPES: every `observe[].server` entry that names a `perform` maps to a
 *      resolver (self_and_observable / observable / inverse / self) — the
 *      relay family (no perform) is the dispatch's own branch and out of
 *      scope. A refused shape is red unless it is a named exemption of the
 *      engine (SERVER_SHAPE_EXEMPTIONS) AND named here, node by node, with its
 *      reason (rsc1214 `refresh_data`). The two lists move in lockstep.
 *   C. LAWS: every node carrying a set_dato_external server entry classifies
 *      as a STORED law, and is then COVERED (isCoveredExternalObserverNode —
 *      the predicate the wipe, the duplicate and the restore read). A
 *      law-less node (no component_to_search — the kernel's counted skip) is
 *      red unless named here with its reason; an AMBIGUOUS or MALFORMED node
 *      (both sub-laws, a malformed sub-law, an unknown function) is red,
 *      always: no exemption exists for a node whose author meant a law the
 *      engine cannot tell.
 *   D. REFERENCES: every tipo a stored law reads (law (c)'s component_to_search,
 *      a copy law's pointer and data_from_field, an observed_data ddo) is a
 *      node of the corpora — a dangling one is a degraded seed forever.
 *   E. PINS: the bug's nodes classify as the law the fix is about, on the
 *      shipped release and on their suite twins (fixture `pinned_laws`).
 *   F. SHRINK-ONLY: an exemption whose node no longer matches it (now a law,
 *      no longer carrying the edge, gone) is red until removed.
 *
 * The exemption lists and pins live in
 * test/unit/fixtures/external_law_registry/registry.json (they name the
 * install-TLD tipos the shipped packages carry). HERMETIC: tracked files only,
 * no database, no network.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodeCopyField } from '../../src/core/db/copy_text.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import {
	ONTOLOGY_CSS,
	ONTOLOGY_PROPERTIES,
	ONTOLOGY_SOURCE,
} from '../../src/core/ontology/ontology_tipos.ts';
import { resolveExternalLaw } from '../../src/core/section/record/external_laws/classify.ts';
import {
	classifyObserverServerShape,
	isCoveredExternalObserverNode,
	SERVER_SHAPE_EXEMPTIONS,
} from '../../src/core/section/record/external_laws/resolvers.ts';
import type { ExternalLaw } from '../../src/core/section/record/external_laws/types.ts';
import {
	entryServerBlock,
	type ObserveEntry,
} from '../../src/core/section/record/observer_subscriptions.ts';
import {
	type VendoredOntologyPackage,
	vendoredOntologyPackages,
} from '../helpers/vendored_ontology_corpus.ts';
import registryJson from './fixtures/external_law_registry/registry.json';

const REPO_ROOT = join(import.meta.dir, '..', '..');

interface RegistryFixture {
	server_shape_exemptions: Record<string, { observed: string; perform: string; reason: string }>;
	lawless_set_dato_external: Record<string, string>;
	pinned_laws: Record<string, Record<string, unknown>>;
}
const FIXTURE = registryJson as unknown as RegistryFixture;

/** A judged node: its tipo, its folded properties and where it came from. */
interface CorpusNode {
	tipo: string;
	properties: unknown;
	corpus: string;
}

// ---------------------------------------------------------------------------
// The corpora
// ---------------------------------------------------------------------------

/**
 * The release the seed compiles from: install/import/ontology/<major.minor> —
 * exactly ONE release directory is shipped (the shared lister walks them all).
 */
function shippedReleasePackages(): VendoredOntologyPackage[] {
	const packages = vendoredOntologyPackages();
	const releases = [...new Set(packages.map((entry) => entry.release))];
	expect(releases.length, 'exactly one shipped ontology release directory').toBe(1);
	return packages;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The first item's value of one misc component (parser readPropertySet's `firstValue`). */
function firstValue(misc: Record<string, unknown>, tipo: string): unknown {
	const items = misc[tipo];
	return Array.isArray(items) ? (items[0] as { value?: unknown } | undefined)?.value : undefined;
}

function loadTestTldCorpus(): CorpusNode[] {
	const doc = JSON.parse(
		readFileSync(join(REPO_ROOT, 'src/core/test_data/test_tld_ontology.json'), 'utf8'),
	) as { nodes: { tipo: string; properties: unknown }[] };
	return doc.nodes.map((node) => ({
		tipo: node.tipo,
		properties: node.properties,
		corpus: 'test_tld_ontology.json',
	}));
}

function loadPackageCorpus(): { nodes: CorpusNode[]; files: number } {
	const idColumn = MATRIX_COPY_COLUMNS.indexOf('section_id');
	const miscColumn = MATRIX_COPY_COLUMNS.indexOf('misc');
	expect(idColumn).toBe(0);
	expect(miscColumn).toBeGreaterThan(0);
	const files = shippedReleasePackages();
	const nodes: CorpusNode[] = [];
	for (const { tld, path } of files) {
		const name = `${tld}.copy.gz`;
		for (const line of gunzipSync(readFileSync(path)).toString('utf8').split('\n')) {
			if (line === '') continue;
			const fields = line.split('\t');
			const sectionId = decodeCopyField(fields[idColumn] ?? '\\N');
			const raw = decodeCopyField(fields[miscColumn] ?? '\\N');
			if (sectionId === null || raw === null) continue;
			const misc = JSON.parse(raw) as unknown;
			if (!isPlainObject(misc)) continue;
			// parser.ts resolveProperties, canonical half (see the header).
			const keys = firstValue(misc, ONTOLOGY_PROPERTIES);
			const properties: Record<string, unknown> = isPlainObject(keys) ? { ...keys } : {};
			const css = firstValue(misc, ONTOLOGY_CSS);
			const source = firstValue(misc, ONTOLOGY_SOURCE);
			if (css !== undefined) properties.css = css;
			if (source !== undefined) properties.source = source;
			nodes.push({ tipo: `${tld}${sectionId}`, properties, corpus: name });
		}
	}
	return { nodes, files: files.length };
}

const TEST_TLD = loadTestTldCorpus();
const PACKAGES = loadPackageCorpus();
const CORPUS: readonly CorpusNode[] = [...TEST_TLD, ...PACKAGES.nodes];
const NODE_TIPOS: ReadonlySet<string> = new Set(CORPUS.map((node) => node.tipo));

/** One observe entry with a server block, flattened. */
interface ServerEdge {
	node: CorpusNode;
	observed: string;
	server: NonNullable<ReturnType<typeof entryServerBlock>>;
}

function serverEdgesOf(node: CorpusNode): ServerEdge[] {
	const observe = (node.properties as { observe?: unknown } | null)?.observe;
	if (!Array.isArray(observe)) return [];
	const edges: ServerEdge[] = [];
	for (const entry of observe as ObserveEntry[]) {
		const server = entryServerBlock(entry);
		if (server === undefined) continue;
		edges.push({ node, observed: String(entry?.component_tipo ?? ''), server });
	}
	return edges;
}

const SERVER_EDGES: readonly ServerEdge[] = CORPUS.flatMap(serverEdgesOf);
const PERFORM_EDGES = SERVER_EDGES.filter((edge) => edge.server.perform?.function !== undefined);
const EXTERNAL_NODES: readonly CorpusNode[] = CORPUS.filter((node) =>
	serverEdgesOf(node).some((edge) => edge.server.perform?.function === 'set_dato_external'),
);
const lawOf = (node: CorpusNode): ExternalLaw =>
	resolveExternalLaw({ tipo: node.tipo, properties: node.properties });

/** The classifier's law-less reasons (no node / no source / no pointer): the counted skip. */
const LAWLESS_REASONS: ReadonlySet<string> = new Set([
	'node_missing',
	'source_not_object',
	'component_to_search_missing',
]);

// ---------------------------------------------------------------------------
// A. anti-vacuity
// ---------------------------------------------------------------------------

describe('A — the corpora and the census are non-vacuous', () => {
	test('both corpora are populous, and the release is the one directory the seed compiles', () => {
		expect(TEST_TLD.length, 'test_tld_ontology.json nodes').toBeGreaterThan(5000);
		expect(PACKAGES.files, 'shipped ontology packages').toBeGreaterThan(100);
		expect(PACKAGES.nodes.length, 'shipped ontology nodes').toBeGreaterThan(10000);
	});

	test('the census sees every resolver and every law kind, in both corpora', () => {
		const resolvers = new Set<string>(
			PERFORM_EDGES.map((edge) => {
				const shape = classifyObserverServerShape(edge.server);
				return 'refused' in shape ? 'refused' : shape.resolver;
			}),
		);
		for (const resolver of ['self_and_observable', 'observable', 'inverse', 'self']) {
			expect(resolvers.has(resolver), `no ${resolver} edge in the corpora`).toBe(true);
		}
		expect(PERFORM_EDGES.length).toBeGreaterThan(60);
		const kinds = (corpus: readonly CorpusNode[]): string[] =>
			corpus.filter((node) => EXTERNAL_NODES.includes(node)).map((node) => lawOf(node).kind);
		for (const [label, corpus] of [
			['test_tld_ontology.json', TEST_TLD],
			['packages', PACKAGES.nodes],
		] as const) {
			const seen = kinds(corpus);
			for (const kind of ['inverse_search', 'source_overwrite', 'observed_data']) {
				expect(seen, `${label}: no ${kind} law`).toContain(kind);
			}
		}
		expect(EXTERNAL_NODES.length).toBeGreaterThan(50);
	});
});

// ---------------------------------------------------------------------------
// B. every server shape maps to a resolver (or a named exemption)
// ---------------------------------------------------------------------------

describe('B — every server shape with a perform maps to ONE target resolver', () => {
	test('a refused shape is red unless the engine exempts it by name AND this gate names its node', () => {
		const faults: string[] = [];
		for (const edge of PERFORM_EDGES) {
			const shape = classifyObserverServerShape(edge.server);
			if (!('refused' in shape)) continue;
			const named = FIXTURE.server_shape_exemptions[edge.node.tipo];
			const exempt =
				shape.reason === 'named_exemption' &&
				named !== undefined &&
				named.observed === edge.observed &&
				named.perform === shape.exemption;
			if (!exempt) {
				faults.push(
					`${edge.node.corpus}: ${edge.node.tipo} ← ${edge.observed}: ${shape.reason} — ${shape.detail}`,
				);
			}
		}
		expect(
			faults,
			'A shipped observe.server shape no resolver runs. Fix the ontology, or (a server function that is not an external-value law) add it to SERVER_SHAPE_EXEMPTIONS (external_laws/resolvers.ts) AND name the node in fixtures/external_law_registry/registry.json with its reason.',
		).toEqual([]);
	});

	test('the engine’s exemptions and this gate’s move in LOCKSTEP; each reason is of substance', () => {
		const named = new Set(
			Object.values(FIXTURE.server_shape_exemptions).map((entry) => entry.perform),
		);
		expect([...named].sort()).toEqual(Object.keys(SERVER_SHAPE_EXEMPTIONS).sort());
		for (const [tipo, entry] of Object.entries(FIXTURE.server_shape_exemptions)) {
			expect(entry.reason.length, tipo).toBeGreaterThan(60);
			expect((SERVER_SHAPE_EXEMPTIONS[entry.perform] ?? '').length).toBeGreaterThan(40);
		}
	});

	test('POSITIVE CONTROL: an unknown perform and an SQO filter beside `self` are refused', () => {
		expect(
			'refused' in classifyObserverServerShape({ perform: { function: 'no_such_perform' } }),
		).toBe(true);
		expect(
			'refused' in
				classifyObserverServerShape({
					perform: { function: 'set_dato_external' },
					filter: { $and: [] },
				}),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// C. every external node maps to exactly one law
// ---------------------------------------------------------------------------

describe('C — every node with a set_dato_external edge maps to ONE stored law', () => {
	test('a stored law, and covered; law-less only by name; ambiguous/malformed never', () => {
		const faults: string[] = [];
		for (const node of EXTERNAL_NODES) {
			const law = lawOf(node);
			const at = `${node.corpus}: ${node.tipo}`;
			if (law.kind === 'refused') {
				if (!LAWLESS_REASONS.has(law.reason)) {
					faults.push(`${at}: REFUSED ${law.reason} — ${law.detail}`);
				} else if (FIXTURE.lawless_set_dato_external[node.tipo] === undefined) {
					faults.push(`${at}: law-less (${law.reason}) and not named — ${law.detail}`);
				}
				continue;
			}
			if (!isCoveredExternalObserverNode({ tipo: node.tipo, properties: node.properties })) {
				faults.push(
					`${at}: stored ${law.kind} law but NOT covered (no runnable set_dato_external edge)`,
				);
			}
		}
		expect(
			faults,
			'A declared external mirror maps to no runnable law. Fix the node (one law: law (c) with component_to_search, source.source_overwrite {data_from_field} + component_to_search, or source.set_observed_data [{tipo, perform?}]) — or, for a law-less node that never computes, name it with its reason in fixtures/external_law_registry/registry.json.',
		).toEqual([]);
	});

	test('POSITIVE CONTROL: an ambiguous node is refused and a law-less one is a counted skip', () => {
		const both = resolveExternalLaw({
			tipo: 'test99981',
			properties: { source: { source_overwrite: { data_from_field: 'a' }, set_observed_data: [] } },
		});
		expect(both.kind === 'refused' && both.reason).toBe('both_sublaws');
		const lawless = resolveExternalLaw({ tipo: 'test99982', properties: { source: {} } });
		expect(lawless.kind === 'refused' && LAWLESS_REASONS.has(lawless.reason)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// D. the tipos a law reads exist
// ---------------------------------------------------------------------------

describe('D — every tipo a stored law reads is a node of the corpora', () => {
	test('no dangling component_to_search / pointer / data_from_field / ddo', () => {
		const faults: string[] = [];
		const need = (node: CorpusNode, role: string, tipo: unknown) => {
			if (typeof tipo !== 'string' || !NODE_TIPOS.has(tipo)) {
				faults.push(`${node.corpus}: ${node.tipo} ${role} '${String(tipo)}' is not a node`);
			}
		};
		for (const node of EXTERNAL_NODES) {
			const law = lawOf(node);
			switch (law.kind) {
				case 'inverse_search':
					need(node, 'component_to_search', law.componentToSearch);
					break;
				case 'source_overwrite':
					need(node, 'pointer', law.pointerTipo);
					need(node, 'data_from_field', law.dataFromField);
					break;
				case 'observed_data':
					need(node, 'ddo', law.ddoTipo);
					break;
				case 'refused':
					break;
			}
		}
		expect(faults).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// E. the bug's nodes classify as the fix's law
// ---------------------------------------------------------------------------

describe('E — the pinned nodes classify as the law the fix is about', () => {
	for (const [tipo, expected] of Object.entries(FIXTURE.pinned_laws)) {
		test(`${tipo} → ${String(expected.kind)}`, () => {
			const node = CORPUS.find((candidate) => candidate.tipo === tipo);
			expect(node, `${tipo} is not in the corpora`).toBeDefined();
			if (node === undefined) return;
			expect(lawOf(node)).toMatchObject(expected);
			expect(isCoveredExternalObserverNode({ tipo, properties: node.properties })).toBe(true);
		});
	}
});

// ---------------------------------------------------------------------------
// F. shrink-only: no stale exemption
// ---------------------------------------------------------------------------

describe('F — every named exemption still matches its node (shrink-only)', () => {
	test('a law-less exemption whose node now classifies as a law, or lost its edge, is red', () => {
		const stale: string[] = [];
		for (const [tipo, reason] of Object.entries(FIXTURE.lawless_set_dato_external)) {
			expect(reason.length, tipo).toBeGreaterThan(60);
			const node = EXTERNAL_NODES.find((candidate) => candidate.tipo === tipo);
			if (node === undefined) {
				stale.push(`${tipo}: no longer carries a set_dato_external edge (or is gone)`);
				continue;
			}
			const law = lawOf(node);
			if (law.kind !== 'refused' || !LAWLESS_REASONS.has(law.reason)) {
				stale.push(`${tipo}: now classifies as ${law.kind === 'refused' ? law.reason : law.kind}`);
			}
		}
		expect(stale, 'remove the stale entries from the fixture').toEqual([]);
	});

	test('a server-shape exemption whose node no longer carries that shape is red', () => {
		const stale: string[] = [];
		for (const [tipo, named] of Object.entries(FIXTURE.server_shape_exemptions)) {
			const carries = PERFORM_EDGES.some(
				(edge) =>
					edge.node.tipo === tipo &&
					edge.observed === named.observed &&
					edge.server.perform?.function === named.perform,
			);
			if (!carries) stale.push(`${tipo} ← ${named.observed} (${named.perform})`);
		}
		expect(stale, 'remove the stale entries from the fixture').toEqual([]);
	});
});
