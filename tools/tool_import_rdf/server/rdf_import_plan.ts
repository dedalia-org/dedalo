/**
 * tool_import_rdf — the MAPPING PLAN: an RDF graph, read through an external
 * ontology, becomes an ordered list of write operations. It writes nothing:
 * the executor (rdf_import_execute.ts) carries the operations out.
 *
 * PURE. Two parts:
 *   - `loadRdfImportOntology` reads the external-ontology subtree ONCE through an
 *     injected `RdfOntologyReader` into a plain snapshot. Production gets that
 *     reader from `engineRdfOntologyReader()` (ontology/resolver.ts, imported
 *     dynamically, so this module loads without the database). A node's RDF
 *     name is read by the engine's ONE name reader (ontology/labels.ts
 *     nameOrLabelOf, a pure function): the machine name of a name node, the
 *     label of any other.
 *   - `planRdfImport` / `planRdfResource` walk the snapshot against a parsed graph
 *     (core/tools/rdf_graph.ts). No I/O, no ambient state: the languages come in
 *     as input (`engineRdfPlanLangs()` builds them for production).
 *
 * THE MAPPING. These are the rules of the v6 tool (tools/tool_import_rdf/
 * class.tool_import_rdf.php: get_class_map_to_dd → get_resource_to_dd_object):
 *   - The root (e.g. "Nomisma import") holds `properties.xmlns`, a map from prefix
 *     to namespace, and `owl:Class` children. A class's term is an RDF type
 *     (`nmo:TypeSeriesItem`). Its `relations` name the target section. Its
 *     `properties.match` names the component that identifies an existing record.
 *   - An `owl:ObjectProperty` child's term is a predicate. Its `relations` name the
 *     target component, plus an optional `owl:Class` for the object. An
 *     ObjectProperty with ObjectProperty children is a PATH into a sub-resource
 *     (`nmo:hasObverse` → `#obverse` → `nmo:hasLegend`). With `properties.ddo_map`
 *     it goes through an INTERMEDIATE record (creators → person → URI). Otherwise
 *     it is a leaf. A leaf's `properties.process` may be `date`, `geo_tag` /
 *     `geo_map`, `split`, or a `data_map` keyed on a `source`.
 *   - A resource object whose ObjectProperty relates a class with `match` becomes
 *     a find-or-create of that record, keyed by its identity, plus a link to it.
 *     When the class maps further properties and the graph does not describe the
 *     resource, the op carries `needs_fetch_iri`. The caller dereferences that IRI
 *     only when the record is new (the 2026-10-01 decision: match first, fetch
 *     only new terms), then plans it with `planRdfResource`.
 *
 * v6 DEFECTS FIXED HERE, NOT PORTED:
 *   - a ddo_map branch REPLACED the results gathered so far (`=` instead of a
 *     merge). Every branch appends to one list here.
 *   - `$field` leaked from one loop iteration into the next, so an absent
 *     predicate re-reported the previous one. No per-iteration state is shared.
 *   - a relation was written as a bare locator. A `link` op names one target; the
 *     executor writes it as a list item.
 *   - `create_new_resource` answered null when the intermediate record already
 *     existed, which skipped its children. An `intermediate` op is find-or-create
 *     and its children are always planned.
 *   - a translatable literal matched one class record PER LANGUAGE (two Design
 *     records for one obverse, one in English and one in Spanish). Here one
 *     record is matched on the current language's text (or the first language
 *     present), and the other languages become `set` ops of its match component.
 *   - a value with no `data_map` entry wrote `false` (literal) or the bare IRI
 *     into a catalogue name (resource). It is a `skip` here. The longest matching
 *     key wins, so the result does not depend on the order of keys in the jsonb
 *     column.
 *   - an untranslatable component received one value per language. The last
 *     write won. Here one value is chosen: the current language, else an
 *     untagged literal, else the first language present.
 *   - the per-resource IRI loop wrote the full IRI list once per resource. Here it
 *     is one `set` op.
 *   - v6 wrote a literal text into an HTML component as raw markup. Remote text
 *     is escaped and wrapped in a paragraph here.
 *   - geo values: v6 embedded GeoJSON in a text tag (`[geo-n-1--data:{…}:data]`).
 *     The v7 tag only names a layer of the geolocation component, as the client
 *     writes it (component_text_area.js create_geo_tag): `[geo-n-1-1-data::data]`.
 *     The point itself is that component's layer 1.
 *   - ontology prefixes that do not resolve a predicate fall back to the
 *     document's own prefixes. The live `foaf` namespace is mistyped, and this
 *     fallback keeps the import working.
 */

import type { DdDate } from '../../../src/core/concepts/dd_date_time.ts';
import { nameOrLabelOf } from '../../../src/core/ontology/labels.ts';
import { PHP_NUMERIC } from '../../../src/core/section/record/value_shape.ts';
import { textAsParagraph } from '../../../src/core/tools/import_code_lookup.ts';
import type { RdfGraph, RdfLiteral, XmlnsMap } from '../../../src/core/tools/rdf_graph.ts';

// ---------------------------------------------------------------------------
// Ontology snapshot
// ---------------------------------------------------------------------------

/** One node of the external-ontology subtree. */
export interface RdfOntologyNode {
	readonly tipo: string;
	/** 'owl:Class' | 'owl:ObjectProperty' | … */
	readonly model: string | null;
	/** The term in the structure language: an RDF name (`skos:prefLabel`) or a label (`Date`). */
	readonly name: string;
	readonly properties: Readonly<Record<string, unknown>>;
	/** The tipos named in `relations`, in order. */
	readonly related: readonly string[];
}

/** What the plan needs to know about a related tipo (component, section or class). */
export interface RdfTipoInfo {
	readonly model: string | null;
	readonly translatable: boolean;
	/** The model stores markup (render class 'html'): remote text is escaped and wrapped. */
	readonly html: boolean;
	/**
	 * The model stores in the `number` column: remote text is cast to a number
	 * (the save door refuses a string there — value_shape.ts), never sent as text.
	 */
	readonly number: boolean;
}

/** The external ontology, read once. */
export interface RdfImportOntology {
	readonly root: string;
	readonly xmlns: XmlnsMap;
	readonly nodes: ReadonlyMap<string, RdfOntologyNode>;
	/** parent tipo → child tipos, in canonical sibling order (the root included). */
	readonly children: ReadonlyMap<string, readonly string[]>;
	/** Every related tipo and every `match` tipo → its model facts. */
	readonly tipos: ReadonlyMap<string, RdfTipoInfo>;
}

/** One raw ontology row, as `getChildrenNodes` answers it. */
export interface RdfReaderNode {
	readonly tipo: string;
	readonly model: string | null;
	readonly term: Readonly<Record<string, string>> | null;
	/**
	 * The language-free name and its flag (an owl:Class / rdf:* node is named by
	 * its machine name, a mixed crm child by its label — labels.ts
	 * nameOrLabelOf). Optional: a reader that omits them reads as a row not
	 * derived yet (the legacy label reading).
	 */
	readonly machine_name?: string | null;
	readonly use_machine_name?: boolean | null;
	readonly properties: unknown;
	readonly relations: unknown;
}

/** The injected ontology access. Production: `engineRdfOntologyReader()`. */
export interface RdfOntologyReader {
	properties(tipo: string): Promise<unknown>;
	children(tipo: string): Promise<readonly RdfReaderNode[]>;
	tipoInfo(tipo: string): Promise<RdfTipoInfo>;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * The record an op writes to. `found_or_created` names the key of an earlier
 * `find_or_create` OR `intermediate` op in the same list (or in the list
 * `planRdfResource` was asked to extend).
 */
export type RecordRef =
	| { readonly kind: 'caller' }
	| { readonly kind: 'found_or_created'; readonly key: string };

/** One v7 data item without its `id` (the save door allocates ids). */
export type RdfPlanItem = Readonly<Record<string, unknown>>;

interface RdfOpBase {
	/** The ObjectProperty node the op comes from. */
	readonly ontology_tipo: string;
	/** The predicate that produced the value (the process's driver for date/geo/split). */
	readonly rdf_predicate: string;
}

/**
 * Find the record of `section_tipo` whose `match_component_tipo` holds
 * `match_value`, or create it with `match_item` in `match_lang`. Emitted once
 * per key, before any op that names the key.
 */
export interface RdfFindOrCreateOp extends RdfOpBase {
	readonly op: 'find_or_create';
	readonly key: string;
	readonly class_tipo: string;
	readonly section_tipo: string;
	readonly match_component_tipo: string;
	readonly match_model: string | null;
	readonly match_lang: string;
	readonly match_value: string;
	readonly match_item: RdfPlanItem;
	/**
	 * The resource the class's other properties must be read from, when this
	 * graph does not describe it. Dereference it only for a NEW record, then plan
	 * it with `planRdfResource`. Null when there is nothing more to read.
	 */
	readonly needs_fetch_iri: string | null;
	/**
	 * The term's OTHER identifiers: what its fetched document's own plan writes
	 * into the match component (on the live Nomisma ontology, its
	 * `skos:exactMatch` IRIs). Never emitted by the planner — the run attaches
	 * them after the fetch (rdf_import_run.ts), and the lookup
	 * (`findTermRecord`, rdf_import_execute.ts) searches them when no record
	 * holds `match_value` itself: exactly one record holding one of them is the
	 * term (linked, `match_item` appended to it), more than one is a conflict.
	 */
	readonly match_equivalents?: readonly string[];
}

/** Add `value` (items in `lang`) to a component of `target`. Never an overwrite. */
export interface RdfSetOp extends RdfOpBase {
	readonly op: 'set';
	readonly target: RecordRef;
	readonly section_tipo: string;
	readonly component_tipo: string;
	readonly model: string | null;
	readonly lang: string;
	readonly value: readonly RdfPlanItem[];
}

/** Add a locator to `to` in a relation component of `target`. */
export interface RdfLinkOp extends RdfOpBase {
	readonly op: 'link';
	readonly target: RecordRef;
	readonly section_tipo: string;
	readonly component_tipo: string;
	readonly model: string | null;
	readonly to: RecordRef;
	readonly to_section_tipo: string;
}

/** One step of a `ddo_map` path, as authored. */
export interface RdfDdoStep {
	readonly section_tipo: string;
	readonly component_tipo: string;
	readonly parent: string;
	readonly model?: string;
	readonly name?: string;
}

/**
 * The record BETWEEN `target` and a resource (creators → person → URI). Find,
 * among the records `component_tipo` of `target` links to in
 * `intermediate_section_tipo`, the one whose `path` leads to `match_value`.
 * Otherwise create one and link it. Its children follow as ops on `key`.
 */
export interface RdfIntermediateOp extends RdfOpBase {
	readonly op: 'intermediate';
	readonly key: string;
	readonly target: RecordRef;
	readonly section_tipo: string;
	readonly component_tipo: string;
	readonly model: string | null;
	readonly intermediate_section_tipo: string;
	readonly match_value: string;
	readonly path: readonly RdfDdoStep[];
}

/** Why a mapped predicate wrote nothing. */
export type RdfSkipReason =
	| 'no_component'
	| 'no_class_for_resource'
	| 'class_without_match'
	| 'data_map_no_match'
	| 'blank_node'
	| 'date_unparsed'
	| 'number_unparsed'
	| 'geo_unparsed'
	| 'unsupported_process'
	| 'ddo_map_unresolved'
	| 'resource_not_described'
	| 'unsupported_iri_scheme'
	| 'language_not_installed'
	| 'depth_limit';

/** A mapped predicate that is present but cannot be written: reported, never silent. */
export interface RdfSkipOp extends RdfOpBase {
	readonly op: 'skip';
	readonly target: RecordRef;
	readonly section_tipo: string;
	readonly component_tipo: string | null;
	readonly reason: RdfSkipReason;
}

export type RdfImportOp = RdfFindOrCreateOp | RdfSetOp | RdfLinkOp | RdfIntermediateOp | RdfSkipOp;

/** The data languages: each with its ISO 639-1 code; `current` is the request's data lang. */
export interface RdfPlanLangs {
	readonly data: readonly { readonly code: string; readonly alpha2: string }[];
	readonly current: string;
}

/** The plan for one IRI. `class_tipo` null: no `owl:Class` maps any of the subject's types. */
export interface RdfImportPlan {
	readonly subject: string;
	readonly class_tipo: string | null;
	readonly section_tipo: string | null;
	readonly ops: readonly RdfImportOp[];
}

/** How deep a path / linked-resource walk may go before it is reported as `depth_limit`. */
export const RDF_PLAN_MAX_DEPTH = 8;

/** The language of untranslatable data. */
const NOLAN = 'lg-nolan';
const OWL_CLASS = 'owl:Class';
const OWL_OBJECT_PROPERTY = 'owl:ObjectProperty';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CALLER: RecordRef = Object.freeze({ kind: 'caller' });
/**
 * The geo tag a geo_tag process writes into a text: v7's tag names layer 1 of the
 * geolocation component. The ONLY Dédalo tag the import writes — the executor
 * refuses any other tag syntax in a text (it would be a remote document's).
 */
export const RDF_GEO_TAG = '[geo-n-1-1-data::data]';
/** The v6 zoom for an imported point (geo_map). */
const GEO_ZOOM = 20;

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/** The tipos of a `relations` column (`[{tipo}]`), in order. */
function relatedTipos(relations: unknown): string[] {
	if (!Array.isArray(relations)) return [];
	return relations.map((entry) => asString(asRecord(entry).tipo)).filter((t) => t !== null);
}

/**
 * A node's RDF name: its machine name when it is a name node (owl:Class,
 * rdf:predicate …), else its label — the ONE reader (labels.ts nameOrLabelOf),
 * never a structure-lang guess. A name node whose name the parser could not
 * derive reads '' (no stray translation is picked).
 */
function rdfNodeName(row: RdfReaderNode): string {
	return (
		nameOrLabelOf({
			term: row.term === null ? null : { ...row.term },
			machine_name: row.machine_name ?? null,
			use_machine_name: row.use_machine_name ?? null,
		}) ?? ''
	);
}

function toOntologyNode(row: RdfReaderNode): RdfOntologyNode {
	return {
		tipo: row.tipo,
		model: row.model,
		name: rdfNodeName(row).trim(),
		properties: asRecord(row.properties),
		related: relatedTipos(row.relations),
	};
}

/** The tipos whose model facts the plan reads: every related tipo and every class `match`. */
function referencedTipos(nodes: Iterable<RdfOntologyNode>): Set<string> {
	const tipos = new Set<string>();
	for (const node of nodes) {
		for (const tipo of node.related) tipos.add(tipo);
		const match = asString(node.properties.match);
		if (match !== null) tipos.add(match);
	}
	return tipos;
}

/** The xmlns map: string values only (a prefix is never a prototype key). */
function xmlnsOf(properties: unknown): XmlnsMap {
	const map: Record<string, string> = Object.create(null);
	for (const [prefix, ns] of Object.entries(asRecord(asRecord(properties).xmlns))) {
		if (typeof ns === 'string') map[prefix] = ns;
	}
	return Object.freeze(map);
}

/**
 * Read the subtree under `rootTipo` once (breadth first; a tipo is read once, so
 * a malformed parent loop terminates) plus the model facts of every tipo it names.
 */
export async function loadRdfImportOntology(
	rootTipo: string,
	reader: RdfOntologyReader,
): Promise<RdfImportOntology> {
	const nodes = new Map<string, RdfOntologyNode>();
	const children = new Map<string, string[]>();
	const queue = [rootTipo];
	for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
		const rows = (await reader.children(parent)).filter((row) => !nodes.has(row.tipo));
		children.set(
			parent,
			rows.map((row) => row.tipo),
		);
		for (const row of rows) nodes.set(row.tipo, toOntologyNode(row));
		queue.push(...rows.map((row) => row.tipo));
	}
	const tipos = new Map<string, RdfTipoInfo>();
	for (const tipo of referencedTipos(nodes.values())) tipos.set(tipo, await reader.tipoInfo(tipo));
	return {
		root: rootTipo,
		xmlns: xmlnsOf(await reader.properties(rootTipo)),
		nodes,
		children,
		tipos,
	};
}

/** The production reader: ontology/resolver.ts + the component registry. */
export function engineRdfOntologyReader(): RdfOntologyReader {
	return {
		async properties(tipo) {
			const { getPropertiesByTipo } = await import('../../../src/core/ontology/resolver.ts');
			return getPropertiesByTipo(tipo);
		},
		async children(tipo) {
			const { getChildrenNodes } = await import('../../../src/core/ontology/resolver.ts');
			return getChildrenNodes(tipo);
		},
		tipoInfo: engineTipoInfo,
	};
}

async function engineTipoInfo(tipo: string): Promise<RdfTipoInfo> {
	const { getModelByTipo, getTranslatableByTipo } = await import(
		'../../../src/core/ontology/resolver.ts'
	);
	const model = await getModelByTipo(tipo);
	return {
		model,
		translatable: await getTranslatableByTipo(tipo),
		html: model !== null && (await rendersHtml(model)),
		number: model !== null && (await storesNumber(model)),
	};
}

/** Whether a model's matrix column is `number` — the save door's own column lookup. */
async function storesNumber(model: string): Promise<boolean> {
	const { getColumnNameByModel } = await import('../../../src/core/ontology/resolver.ts');
	return getColumnNameByModel(model) === 'number';
}

/**
 * Whether a model stores markup. `model` is already the runtime model
 * (`getModelByTipo` follows aliases); a non-component model has no descriptor.
 */
async function rendersHtml(model: string): Promise<boolean> {
	const { getComponentModel } = await import('../../../src/core/components/registry.ts');
	return getComponentModel(model)?.render === 'html';
}

/** The production languages: the installed data languages that have an ISO 639-1 code. */
export async function engineRdfPlanLangs(): Promise<RdfPlanLangs> {
	const { installedDataLangs } = await import('../../../src/core/section/record/save_component.ts');
	const { getAlpha2FromCode } = await import('../../../src/core/resolve/lang_names.ts');
	const { currentDataLang } = await import('../../../src/core/resolve/request_lang.ts');
	const data = installedDataLangs()
		.map((code) => ({ code, alpha2: getAlpha2FromCode(code) }))
		.filter((lang): lang is { code: string; alpha2: string } => lang.alpha2 !== null);
	return { data, current: currentDataLang() };
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** One planning run: its inputs and its growing output. Local to the call. */
interface Walk {
	readonly ont: RdfImportOntology;
	readonly graph: RdfGraph;
	readonly langs: RdfPlanLangs;
	readonly ops: RdfImportOp[];
	/** Keys already emitted (a record is found or created, and walked, once). */
	readonly keys: Set<string>;
	/** The subjects the graph describes. */
	readonly described: ReadonlySet<string>;
}

/** Where the walk stands: the subject read, the record written. */
interface Frame {
	readonly subject: string;
	readonly target: RecordRef;
	readonly section_tipo: string;
	readonly depth: number;
	/** Under an intermediate: only this resource is read for the predicate. */
	readonly pin: string | null;
}

/** The component an op writes. */
interface Slot {
	readonly target: RecordRef;
	readonly section_tipo: string;
	readonly component_tipo: string;
	readonly info: RdfTipoInfo;
}

/** A leaf ObjectProperty being planned. */
interface Leaf {
	readonly node: RdfOntologyNode;
	readonly frame: Frame;
	readonly slot: Slot;
	readonly classTipo: string | null;
	readonly process: Readonly<Record<string, unknown>>;
}

/** A class with a target section and a match component. */
interface MatchClass {
	readonly node: RdfOntologyNode;
	readonly section_tipo: string;
	readonly match: string;
	readonly info: RdfTipoInfo;
}

interface LangGroup {
	readonly lang: string;
	readonly literals: readonly RdfLiteral[];
}

const UNKNOWN_TIPO: RdfTipoInfo = Object.freeze({
	model: null,
	translatable: false,
	html: false,
	number: false,
});

function newWalk(ont: RdfImportOntology, graph: RdfGraph, langs: RdfPlanLangs): Walk {
	return { ont, graph, langs, ops: [], keys: new Set(), described: new Set(graph.subjects()) };
}

function infoOf(ont: RdfImportOntology, tipo: string): RdfTipoInfo {
	return ont.tipos.get(tipo) ?? UNKNOWN_TIPO;
}

function childNodes(ont: RdfImportOntology, tipo: string, model: string): RdfOntologyNode[] {
	return (ont.children.get(tipo) ?? [])
		.map((child) => ont.nodes.get(child))
		.filter((node): node is RdfOntologyNode => node?.model === model);
}

/** The first related tipo whose model passes `test`. */
function relatedBy(
	ont: RdfImportOntology,
	node: RdfOntologyNode,
	test: (model: string) => boolean,
): string | null {
	return node.related.find((tipo) => test(infoOf(ont, tipo).model ?? '')) ?? null;
}

function sectionOf(ont: RdfImportOntology, node: RdfOntologyNode): string | null {
	return relatedBy(ont, node, (model) => model === 'section');
}

function refOf(key: string): RecordRef {
	return { kind: 'found_or_created', key };
}

function refKey(ref: RecordRef): string {
	return ref.kind === 'caller' ? 'caller' : ref.key;
}

function isBlank(resource: string): boolean {
	return resource.startsWith('_:');
}

/**
 * Whether a resource is a web IRI (http/https). The ONLY scheme the import
 * stores or links: a remote document chooses its IRIs, and a `javascript:` or
 * `data:` one written into a component_iri would be served as a live link
 * (the CSV door's iri conform admits the same two schemes). Exported for the
 * executor, which re-checks every IRI it writes.
 */
export function isWebIri(resource: string): boolean {
	return /^https?:\/\//i.test(resource);
}

/** A name expanded through the ontology's prefixes, then through the document's own. */
function expansions(walk: Walk, name: string): string[] {
	return [...new Set([walk.graph.expand(name, walk.ont.xmlns), walk.graph.expand(name)])];
}

/** The full IRI of `name` on `subject`: the first expansion the graph uses there. */
function predicateIri(walk: Walk, subject: string, name: string): string {
	const candidates = expansions(walk, name);
	return (
		candidates.find((iri) => walk.graph.objects(subject, iri).length > 0) ?? candidates[0] ?? name
	);
}

function sameName(walk: Walk, a: string, b: string): boolean {
	const left = expansions(walk, a);
	return expansions(walk, b).some((iri) => left.includes(iri));
}

function push(walk: Walk, op: RdfImportOp): void {
	walk.ops.push(op);
}

function skip(
	walk: Walk,
	node: RdfOntologyNode,
	frame: Frame,
	component: string | null,
	reason: RdfSkipReason,
): void {
	push(walk, {
		op: 'skip',
		ontology_tipo: node.tipo,
		rdf_predicate: node.name,
		target: frame.target,
		section_tipo: frame.section_tipo,
		component_tipo: component,
		reason,
	});
}

function pushSet(
	walk: Walk,
	slot: Slot,
	node: RdfOntologyNode,
	predicate: string,
	lang: string,
	value: readonly RdfPlanItem[],
): void {
	if (value.length === 0) return;
	push(walk, {
		op: 'set',
		ontology_tipo: node.tipo,
		rdf_predicate: predicate,
		target: slot.target,
		section_tipo: slot.section_tipo,
		component_tipo: slot.component_tipo,
		model: slot.info.model,
		lang,
		value,
	});
}

function pushLink(walk: Walk, leaf: Leaf, key: string, toSection: string): void {
	push(walk, {
		op: 'link',
		ontology_tipo: leaf.node.tipo,
		rdf_predicate: leaf.node.name,
		target: leaf.slot.target,
		section_tipo: leaf.slot.section_tipo,
		component_tipo: leaf.slot.component_tipo,
		model: leaf.slot.info.model,
		to: refOf(key),
		to_section_tipo: toSection,
	});
}

/** Plan every ObjectProperty child of `node` on `frame`. */
function walkChildren(walk: Walk, node: RdfOntologyNode, frame: Frame): void {
	if (frame.depth > RDF_PLAN_MAX_DEPTH) {
		skip(walk, node, frame, null, 'depth_limit');
		return;
	}
	for (const child of childNodes(walk.ont, node.tipo, OWL_OBJECT_PROPERTY)) {
		walkProperty(walk, child, frame);
	}
}

function walkProperty(walk: Walk, node: RdfOntologyNode, frame: Frame): void {
	if (node.properties.ddo_map !== undefined) {
		intermediateOps(walk, node, frame);
		return;
	}
	if (childNodes(walk.ont, node.tipo, OWL_OBJECT_PROPERTY).length > 0) {
		nestedOps(walk, node, frame);
		return;
	}
	leafOps(walk, node, frame);
}

/**
 * The distinct resources of `name` on the frame's subject (only the pinned one
 * under an intermediate), in document order.
 */
function resourcesOf(walk: Walk, frame: Frame, name: string): string[] {
	const iri = predicateIri(walk, frame.subject, name);
	const resources = walk.graph
		.resources(frame.subject, iri)
		.filter((resource) => frame.pin === null || resource === frame.pin);
	return [...new Set(resources)];
}

function deeper(frame: Frame, change: Partial<Frame>): Frame {
	return { ...frame, pin: null, ...change, depth: frame.depth + 1 };
}

/** A path into a sub-resource: its children read the resource, write the same record. */
function nestedOps(walk: Walk, node: RdfOntologyNode, frame: Frame): void {
	for (const resource of resourcesOf(walk, frame, node.name)) {
		if (!walk.described.has(resource)) {
			skip(walk, node, frame, null, 'resource_not_described');
			continue;
		}
		walkChildren(walk, node, deeper(frame, { subject: resource }));
	}
}

function ddoSteps(raw: unknown): RdfDdoStep[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(step): step is RdfDdoStep =>
			isRecord(step) &&
			asString(step.section_tipo) !== null &&
			asString(step.component_tipo) !== null &&
			asString(step.parent) !== null,
	);
}

/**
 * A ddo_map predicate: per resource, one intermediate record linked from the
 * component, and the node's children planned on it, pinned to that resource.
 */
function intermediateOps(walk: Walk, node: RdfOntologyNode, frame: Frame): void {
	const component = relatedBy(walk.ont, node, (model) => model.startsWith('component_'));
	const path = ddoSteps(node.properties.ddo_map);
	const next = path.find((step) => step.parent === component);
	if (component === null || next === undefined) {
		skip(walk, node, frame, component, 'ddo_map_unresolved');
		return;
	}
	for (const resource of resourcesOf(walk, frame, node.name)) {
		intermediateFor(walk, node, frame, { component, next, path, resource });
	}
}

function intermediateFor(
	walk: Walk,
	node: RdfOntologyNode,
	frame: Frame,
	via: { component: string; next: RdfDdoStep; path: RdfDdoStep[]; resource: string },
): void {
	if (isBlank(via.resource)) {
		skip(walk, node, frame, via.component, 'blank_node');
		return;
	}
	// An intermediate is found again only through its path to the resource's
	// record, and a non-web resource is never linked nor created (linkResource):
	// its intermediate would be created for nothing.
	if (!isWebIri(via.resource)) {
		skip(walk, node, frame, via.component, 'unsupported_iri_scheme');
		return;
	}
	const key = `intermediate|${refKey(frame.target)}|${via.component}|${via.resource}`;
	if (walk.keys.has(key)) return;
	walk.keys.add(key);
	push(walk, {
		op: 'intermediate',
		ontology_tipo: node.tipo,
		rdf_predicate: node.name,
		key,
		target: frame.target,
		section_tipo: frame.section_tipo,
		component_tipo: via.component,
		model: infoOf(walk.ont, via.component).model,
		intermediate_section_tipo: via.next.section_tipo,
		match_value: via.resource,
		path: via.path.map((step) => ({ ...step })),
	});
	const target = refOf(key);
	walkChildren(walk, node, {
		...deeper(frame, { target, section_tipo: via.next.section_tipo }),
		pin: via.resource,
	});
}

function leafOps(walk: Walk, node: RdfOntologyNode, frame: Frame): void {
	const component = relatedBy(walk.ont, node, (model) => model.startsWith('component_'));
	if (component === null) {
		skip(walk, node, frame, null, 'no_component');
		return;
	}
	const leaf: Leaf = {
		node,
		frame,
		slot: { ...frame, component_tipo: component, info: infoOf(walk.ont, component) },
		classTipo: relatedBy(walk.ont, node, (model) => model === OWL_CLASS),
		process: asRecord(node.properties.process),
	};
	processOps(walk, leaf);
}

function processOps(walk: Walk, leaf: Leaf): void {
	const { process } = leaf;
	if (isRecord(process.date)) {
		dateOps(walk, leaf, process.date);
		return;
	}
	const geo = process.geo_tag ?? process.geo_map;
	if (isRecord(geo)) {
		geoOps(walk, leaf, geo);
		return;
	}
	if (isRecord(process.split)) {
		splitOps(walk, leaf, process.split);
		return;
	}
	objectOps(walk, leaf);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * One item of `text` for a component, in its own shape. A markup component gets
 * the text escaped and wrapped in one paragraph — `textAsParagraph`, the form
 * the code lookup searches for, so a record created here is found again. A
 * number component gets the number the text spells (PHP `is_numeric`'s
 * grammar, as Dédalo 6's set_data cast it); text that spells none is null —
 * the caller reports it as a `number_unparsed` skip, never sends the string
 * (the save door would refuse it, rolling the operation back).
 */
function itemFor(info: RdfTipoInfo, lang: string, text: string): RdfPlanItem | null {
	if (info.model === 'component_iri') return { iri: text, lang };
	if (info.number) {
		const value = numberOf(text);
		return value === null ? null : { lang, value };
	}
	return { lang, value: info.html ? textAsParagraph(text) : text };
}

/** The finite number `text` spells (surrounding blanks ignored), else null. */
function numberOf(text: string): number | null {
	const trimmed = text.trim();
	if (!PHP_NUMERIC.test(trimmed)) return null;
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : null;
}

/** The language of a value that has none of its own. */
function langFor(walk: Walk, info: RdfTipoInfo): string {
	return info.translatable ? walk.langs.current : NOLAN;
}

/**
 * The value a `data_map` gives `source`: the entry with the LONGEST key that
 * `source` contains (so `ric.1(2).` wins over `ric.1` whatever the key order),
 * or null when none does.
 */
export function dataMapValue(
	map: Readonly<Record<string, unknown>>,
	source: string,
): string | null {
	const hits = Object.entries(map).filter(
		([key, value]) => key !== '' && typeof value === 'string' && source.includes(key),
	);
	// Stable: of two keys of one length, the first authored wins.
	hits.sort((a, b) => b[0].length - a[0].length);
	const top = hits[0]?.[1];
	return typeof top === 'string' ? top : null;
}

/** `raw` through the leaf's data_map (source `$base_uri` = the subject), or `raw` unchanged. */
function mappedValue(leaf: Leaf, raw: string): string | null {
	const map = leaf.process.data_map;
	if (!isRecord(map)) return raw;
	const source = leaf.process.source === '$base_uri' ? leaf.frame.subject : raw;
	return dataMapValue(map, source);
}

/** Literals of `iri` on `subject` in one language (`alpha2`), untagged ones (null), or all (undefined). */
function literalsIn(walk: Walk, subject: string, iri: string, lang?: string | null): RdfLiteral[] {
	return walk.graph.literals(subject, iri, { lang });
}

function alpha2Of(walk: Walk, code: string): string | null {
	return walk.langs.data.find((lang) => lang.code === code)?.alpha2 ?? null;
}

/**
 * The literals an UNTRANSLATABLE component takes: the current language's, else
 * the untagged ones, else the first language present — one group, lg-nolan.
 */
function nolanGroup(walk: Walk, subject: string, iri: string): LangGroup[] {
	const current = alpha2Of(walk, walk.langs.current);
	const own = current === null ? [] : literalsIn(walk, subject, iri, current);
	const untagged = literalsIn(walk, subject, iri, null);
	const all = literalsIn(walk, subject, iri);
	const first = all.filter((literal) => literal.lang === all[0]?.lang);
	const chosen = [own, untagged, first].find((group) => group.length > 0) ?? [];
	return chosen.length === 0 ? [] : [{ lang: NOLAN, literals: chosen }];
}

/**
 * The literals per data language. A translatable component takes every language
 * the install has; untagged literals go to the current language when it has
 * none of its own.
 */
function langGroups(walk: Walk, subject: string, iri: string, translatable: boolean): LangGroup[] {
	if (!translatable) return nolanGroup(walk, subject, iri);
	const groups = walk.langs.data
		.map(({ code, alpha2 }) => ({ lang: code, literals: literalsIn(walk, subject, iri, alpha2) }))
		.filter((group) => group.literals.length > 0);
	const untagged = literalsIn(walk, subject, iri, null);
	const hasCurrent = groups.some((group) => group.lang === walk.langs.current);
	if (untagged.length > 0 && !hasCurrent) {
		groups.push({ lang: walk.langs.current, literals: untagged });
	}
	return groups;
}

/**
 * The literal groups of `iri` on the leaf's subject (see langGroups). None when
 * every literal is in a language the install lacks — then REPORTED as
 * `language_not_installed`: a mapped predicate that is present is never dropped
 * silently. (Some installed among them: only those are written, no skip.)
 */
function installedGroups(walk: Walk, leaf: Leaf, iri: string, translatable: boolean): LangGroup[] {
	const groups = langGroups(walk, leaf.frame.subject, iri, translatable);
	if (groups.length === 0 && literalsIn(walk, leaf.frame.subject, iri).length > 0) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'language_not_installed');
	}
	return groups;
}

// ---------------------------------------------------------------------------
// Objects: resources and literals
// ---------------------------------------------------------------------------

function objectOps(walk: Walk, leaf: Leaf): void {
	const resources = resourcesOf(walk, leaf.frame, leaf.node.name);
	if (resources.length > 0) resourceOps(walk, leaf, resources);
	literalOps(walk, leaf);
}

function resourceOps(walk: Walk, leaf: Leaf, resources: readonly string[]): void {
	if (leaf.slot.info.model === 'component_iri') {
		iriOps(walk, leaf, resources);
		return;
	}
	if (leaf.classTipo === null) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'no_class_for_resource');
		return;
	}
	for (const resource of resources) linkResource(walk, leaf, resource);
}

/**
 * An IRI component stores the resources' web IRIs as they are: nothing is
 * fetched. Any other non-blank resource (`javascript:`, `data:`, `urn:` …) is
 * reported, never stored.
 */
function iriOps(walk: Walk, leaf: Leaf, resources: readonly string[]): void {
	const lang = langFor(walk, leaf.slot.info);
	const items = resources.filter(isWebIri).map((iri) => ({ iri, lang }));
	if (resources.some((r) => !isBlank(r) && !isWebIri(r))) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'unsupported_iri_scheme');
	}
	pushSet(walk, leaf.slot, leaf.node, leaf.node.name, lang, items);
}

function linkResource(walk: Walk, leaf: Leaf, resource: string): void {
	const value = mappedValue(leaf, resource);
	const component = leaf.slot.component_tipo;
	if (value === null) {
		skip(walk, leaf.node, leaf.frame, component, 'data_map_no_match');
		return;
	}
	if (value === resource && !isWebIri(resource)) {
		// A blank node has no identity; any other non-web IRI is never linked by.
		const reason = isBlank(resource) ? 'blank_node' : 'unsupported_iri_scheme';
		skip(walk, leaf.node, leaf.frame, component, reason);
		return;
	}
	const found = findOrCreate(walk, leaf, value, null, resource);
	if (found !== null) pushLink(walk, leaf, found.key, found.cls.section_tipo);
}

function matchClassOf(ont: RdfImportOntology, classTipo: string | null): MatchClass | null {
	const node = classTipo === null ? undefined : ont.nodes.get(classTipo);
	const match = asString(node?.properties.match);
	const section = node === undefined ? null : sectionOf(ont, node);
	if (node === undefined || match === null || section === null) return null;
	return { node, section_tipo: section, match, info: infoOf(ont, match) };
}

/**
 * The key of the class record matching `value`, emitting its `find_or_create`
 * the first time. Null (and a skip) when the class has no section or no match.
 */
function findOrCreate(
	walk: Walk,
	leaf: Leaf,
	value: string,
	lang: string | null,
	resource: string | null,
): { key: string; cls: MatchClass } | null {
	const cls = matchClassOf(walk.ont, leaf.classTipo);
	if (cls === null) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'class_without_match');
		return null;
	}
	const key = `${cls.section_tipo}|${cls.match}|${value}`;
	if (!walk.keys.has(key)) {
		const matchLang = lang ?? langFor(walk, cls.info);
		const item = itemFor(cls.info, matchLang, value);
		if (item === null) {
			skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'number_unparsed');
			return null;
		}
		walk.keys.add(key);
		emitFindOrCreate(walk, leaf, { cls, key, value, lang: matchLang, resource, item });
	}
	return { key, cls };
}

/**
 * How a linked record's own properties are read: from this graph (`inGraph`, the
 * resource is described here), by dereferencing it (`fetch`), or not at all
 * (the class maps nothing more, or the resource is no web IRI).
 */
function linkedRead(
	walk: Walk,
	cls: MatchClass,
	resource: string | null,
): { inGraph: string | null; fetch: string | null } {
	const none = { inGraph: null, fetch: null };
	if (resource === null || childNodes(walk.ont, cls.node.tipo, OWL_OBJECT_PROPERTY).length === 0) {
		return none;
	}
	if (walk.described.has(resource)) return { inGraph: resource, fetch: null };
	return isWebIri(resource) ? { inGraph: null, fetch: resource } : none;
}

function emitFindOrCreate(
	walk: Walk,
	leaf: Leaf,
	found: {
		cls: MatchClass;
		key: string;
		value: string;
		lang: string;
		resource: string | null;
		item: RdfPlanItem;
	},
): void {
	const { cls, key, resource } = found;
	const read = linkedRead(walk, cls, resource);
	push(walk, {
		op: 'find_or_create',
		ontology_tipo: leaf.node.tipo,
		rdf_predicate: leaf.node.name,
		key,
		class_tipo: cls.node.tipo,
		section_tipo: cls.section_tipo,
		match_component_tipo: cls.match,
		match_model: cls.info.model,
		match_lang: found.lang,
		match_value: found.value,
		match_item: found.item,
		needs_fetch_iri: read.fetch,
	});
	if (read.inGraph !== null) {
		const frame = deeper(leaf.frame, {
			subject: read.inGraph,
			target: refOf(key),
			section_tipo: cls.section_tipo,
		});
		walkChildren(walk, cls.node, frame);
	}
}

function literalOps(walk: Walk, leaf: Leaf): void {
	const iri = predicateIri(walk, leaf.frame.subject, leaf.node.name);
	if (literalsIn(walk, leaf.frame.subject, iri).length === 0) return;
	if (leaf.classTipo !== null) {
		literalLinkOps(walk, leaf, iri);
		return;
	}
	for (const group of installedGroups(walk, leaf, iri, leaf.slot.info.translatable)) {
		const texts = group.literals.map((literal) => mappedValue(leaf, literal.value));
		if (texts.includes(null)) {
			skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'data_map_no_match');
			return;
		}
		const items = [...new Set(texts as string[])].map((text) =>
			itemFor(leaf.slot.info, group.lang, text),
		);
		if (items.includes(null)) {
			skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'number_unparsed');
			return;
		}
		pushSet(walk, leaf.slot, leaf.node, leaf.node.name, group.lang, items as RdfPlanItem[]);
	}
}

/**
 * Literals that identify a class record (a legend's text, a design's
 * description): one record per literal of the preferred language, linked. Its
 * other languages are added to the record's match component when there is one
 * literal to pair them with.
 */
function literalLinkOps(walk: Walk, leaf: Leaf, iri: string): void {
	const cls = matchClassOf(walk.ont, leaf.classTipo);
	if (cls === null) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'class_without_match');
		return;
	}
	const groups = installedGroups(walk, leaf, iri, cls.info.translatable);
	const preferred = groups.find((g) => g.lang === walk.langs.current) ?? groups[0];
	if (preferred === undefined) return;
	for (const literal of preferred.literals) {
		linkLiteral(walk, leaf, { cls, groups, preferred }, literal);
	}
}

function linkLiteral(
	walk: Walk,
	leaf: Leaf,
	set: { cls: MatchClass; groups: readonly LangGroup[]; preferred: LangGroup },
	literal: RdfLiteral,
): void {
	const value = mappedValue(leaf, literal.value);
	if (value === null) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'data_map_no_match');
		return;
	}
	const found = findOrCreate(walk, leaf, value, set.preferred.lang, null);
	if (found === null) return;
	pushLink(walk, leaf, found.key, set.cls.section_tipo);
	if (set.preferred.literals.length === 1) {
		translationOps(walk, leaf, found.key, set.cls, set.groups, set.preferred);
	}
}

function translationOps(
	walk: Walk,
	leaf: Leaf,
	key: string,
	cls: MatchClass,
	groups: readonly LangGroup[],
	preferred: LangGroup,
): void {
	const slot: Slot = {
		target: refOf(key),
		section_tipo: cls.section_tipo,
		component_tipo: cls.match,
		info: cls.info,
	};
	for (const group of groups) {
		const text = group === preferred ? null : mappedValue(leaf, group.literals[0]?.value ?? '');
		if (text === null) continue;
		const item = itemFor(cls.info, group.lang, text);
		if (item === null) {
			skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'number_unparsed');
			continue;
		}
		pushSet(walk, slot, leaf.node, leaf.node.name, group.lang, [item]);
	}
}

// ---------------------------------------------------------------------------
// process.date
// ---------------------------------------------------------------------------

const DATE_YEAR = /^(-?\d+)(?:Z|[+-]\d{2}:\d{2})?$/;
const DATE_FULL = /^(-?\d+)-(\d{2})(?:-(\d{2}))?(?:$|[TZ+-])/;
const DATE_MONTH = /^--(\d{2})(?:$|[Z+-])/;
const DATE_DAY = /^---(\d{2})(?:$|[Z+-])/;

function inRange(value: number, max: number): boolean {
	return value >= 1 && value <= max;
}

function parseYear(text: string): DdDate | null {
	const m = DATE_YEAR.exec(text);
	return m === null ? null : { year: Number(m[1]) };
}

function parseMonth(text: string): DdDate | null {
	const month = Number(DATE_MONTH.exec(text)?.[1] ?? Number.NaN);
	return inRange(month, 12) ? { month } : null;
}

function parseDay(text: string): DdDate | null {
	const day = Number(DATE_DAY.exec(text)?.[1] ?? Number.NaN);
	return inRange(day, 31) ? { day } : null;
}

/** `YYYY-MM-DD` (a time part ignored) or `YYYY-MM`; a negative year is BCE. */
function parseFullDate(text: string): DdDate | null {
	const m = DATE_FULL.exec(text);
	if (m === null || !inRange(Number(m[2]), 12)) return null;
	const date: DdDate = { year: Number(m[1]), month: Number(m[2]) };
	if (m[3] === undefined) return date;
	return inRange(Number(m[3]), 31) ? { ...date, day: Number(m[3]) } : null;
}

/** No declared format: the lexical form decides (day, month, full date, year). */
function inferDate(text: string): DdDate | null {
	return parseDay(text) ?? parseMonth(text) ?? parseFullDate(text) ?? parseYear(text);
}

/** The ontology's format names (`process.date.format` values) → their parser. */
const DATE_PARSERS: Readonly<Record<string, (text: string) => DdDate | null>> = Object.freeze({
	year: parseYear,
	month: parseMonth,
	day: parseDay,
	'YYYY-MM-DD': parseFullDate,
	from_timestamp: parseFullDate,
});

/**
 * An RDF date literal as a v7 dd_date. `format` is the ontology's name for the
 * literal's datatype (`year` for xsd:gYear …); unknown or absent, the lexical
 * form decides. `-0025` is year -25.
 */
export function parseRdfDate(text: string, format: string | null): DdDate | null {
	const parser =
		format !== null && Object.hasOwn(DATE_PARSERS, format) ? DATE_PARSERS[format] : undefined;
	return (parser ?? inferDate)(text.trim());
}

/** The format the ontology names for a literal's datatype. */
function formatOf(
	walk: Walk,
	literal: RdfLiteral,
	format: Readonly<Record<string, unknown>>,
): string | null {
	const datatype = literal.datatype;
	if (datatype === undefined) return null;
	const entry = Object.entries(format).find(([name]) => sameName(walk, name, datatype));
	return asString(entry?.[1]);
}

/** The first literal of the predicate `name` on `subject`, or null. */
function literalAt(walk: Walk, subject: string, name: string | null): RdfLiteral | null {
	if (name === null) return null;
	return walk.graph.literal(subject, predicateIri(walk, subject, name)) ?? null;
}

function dateItem(start: DdDate | null, end: DdDate | null): RdfPlanItem {
	const item: Record<string, DdDate> = {};
	if (start !== null) item.start = start;
	if (end !== null) item.end = end;
	return item;
}

/** One end of a date: the predicate named, its literal, the date it parses to. */
interface DatePart {
	readonly name: string | null;
	readonly literal: RdfLiteral | null;
	readonly date: DdDate | null;
}

function datePart(walk: Walk, leaf: Leaf, name: unknown, format: unknown): DatePart {
	const predicate = asString(name);
	const literal = literalAt(walk, leaf.frame.subject, predicate);
	const date =
		literal === null
			? null
			: parseRdfDate(literal.value, formatOf(walk, literal, asRecord(format)));
	return { name: predicate, literal, date };
}

/**
 * A date from the `start` / `end` predicates the process names (v6
 * process.date), each parsed by the format the ontology gives its datatype.
 */
function dateOps(walk: Walk, leaf: Leaf, spec: Readonly<Record<string, unknown>>): void {
	const start = datePart(walk, leaf, spec.start, spec.format);
	const end = datePart(walk, leaf, spec.end, spec.format);
	const driver = start.literal !== null ? start : end;
	if (driver.literal === null) return;
	if (start.date === null && end.date === null) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'date_unparsed');
		return;
	}
	const lang = langFor(walk, leaf.slot.info);
	const predicate = driver.name ?? leaf.node.name;
	pushSet(walk, leaf.slot, leaf.node, predicate, lang, [dateItem(start.date, end.date)]);
}

// ---------------------------------------------------------------------------
// process.geo_tag / process.geo_map
// ---------------------------------------------------------------------------

function coordinate(literal: RdfLiteral | null, limit: number): number | null {
	const value = literal === null ? Number.NaN : Number(literal.value.trim());
	return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/** The v7 geolocation item: the point as centre AND as layer 1 (which a geo tag names). */
function geolocationItem(lat: number, lon: number): RdfPlanItem {
	const point = {
		type: 'Feature',
		properties: { layer_id: 1 },
		geometry: { type: 'Point', coordinates: [lon, lat] },
	};
	return {
		lat,
		lon,
		zoom: GEO_ZOOM,
		lib_data: [{ layer_id: 1, layer_data: { type: 'FeatureCollection', features: [point] } }],
	};
}

/** The text item for a geo tag: v7's tag names layer 1 of the geolocation component. */
function geoTagItem(info: RdfTipoInfo, lang: string): RdfPlanItem {
	return { lang, value: info.html ? `<p>${RDF_GEO_TAG}</p>` : RDF_GEO_TAG };
}

function geoOps(walk: Walk, leaf: Leaf, spec: Readonly<Record<string, unknown>>): void {
	const latName = asString(spec.lat);
	const latLiteral = literalAt(walk, leaf.frame.subject, latName);
	const lonLiteral = literalAt(walk, leaf.frame.subject, asString(spec.long));
	if (latLiteral === null && lonLiteral === null) return;
	const [lat, lon] = [coordinate(latLiteral, 90), coordinate(lonLiteral, 180)];
	if (lat === null || lon === null) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'geo_unparsed');
		return;
	}
	const lang = langFor(walk, leaf.slot.info);
	const item = geoItem(leaf.slot.info, lang, lat, lon);
	pushSet(walk, leaf.slot, leaf.node, latName ?? leaf.node.name, lang, [item]);
}

/** A geolocation component takes the point; any other (a text) takes the tag naming it. */
function geoItem(info: RdfTipoInfo, lang: string, lat: number, lon: number): RdfPlanItem {
	return info.model === 'component_geolocation'
		? geolocationItem(lat, lon)
		: geoTagItem(info, lang);
}

// ---------------------------------------------------------------------------
// process.split
// ---------------------------------------------------------------------------

/** The part of the subject IRI a split names (`get` 'end' = last, 'start' = first). */
function splitValue(spec: Readonly<Record<string, unknown>>, subject: string): string | null {
	const by = asString(spec.split_by);
	if (spec.source !== '$base_uri' || by === null) return null;
	const parts = subject.split(by);
	const picked = spec.get === 'end' ? parts.at(-1) : spec.get === 'start' ? parts[0] : undefined;
	return asString(picked);
}

/**
 * A part of the subject IRI (the type number `1A` of `…aug.1A`), written in each
 * language the driver predicate (`property_name`) has a literal in, or once when
 * no driver is named.
 */
function splitOps(walk: Walk, leaf: Leaf, spec: Readonly<Record<string, unknown>>): void {
	const value = splitValue(spec, leaf.frame.subject);
	if (value === null) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'unsupported_process');
		return;
	}
	const { info } = leaf.slot;
	if (info.number && numberOf(value) === null) {
		skip(walk, leaf.node, leaf.frame, leaf.slot.component_tipo, 'number_unparsed');
		return;
	}
	const item = (lang: string) => itemFor(info, lang, value) as RdfPlanItem;
	const driver = asString(spec.property_name);
	if (driver === null) {
		const lang = langFor(walk, info);
		pushSet(walk, leaf.slot, leaf.node, leaf.node.name, lang, [item(lang)]);
		return;
	}
	const iri = predicateIri(walk, leaf.frame.subject, driver);
	for (const group of installedGroups(walk, leaf, iri, info.translatable)) {
		pushSet(walk, leaf.slot, leaf.node, driver, group.lang, [item(group.lang)]);
	}
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function classNodes(ont: RdfImportOntology): RdfOntologyNode[] {
	return childNodes(ont, ont.root, OWL_CLASS);
}

/** The class mapping the subject: its types in document order, the first one a class names. */
function classOfSubject(walk: Walk, subject: string): RdfOntologyNode | null {
	const types = walk.graph.resources(subject, RDF_TYPE);
	const classes = classNodes(walk.ont);
	for (const type of types) {
		const hit = classes.find((cls) => expansions(walk, cls.name).includes(type));
		if (hit !== undefined) return hit;
	}
	return null;
}

/**
 * Plan the import of `subject` (the IRI the cataloguer picked) into the CALLER
 * record. The subject's `rdf:type` selects the `owl:Class`; its properties
 * become the op list. An unmapped type gives `class_tipo: null` and no ops.
 */
export function planRdfImport(
	ont: RdfImportOntology,
	graph: RdfGraph,
	input: { readonly subject: string; readonly langs: RdfPlanLangs },
): RdfImportPlan {
	const walk = newWalk(ont, graph, input.langs);
	const cls = classOfSubject(walk, input.subject);
	const section = cls === null ? null : sectionOf(ont, cls);
	if (cls !== null && section !== null) {
		const frame: Frame = {
			subject: input.subject,
			target: CALLER,
			section_tipo: section,
			depth: 0,
			pin: null,
		};
		walkChildren(walk, cls, frame);
	}
	return {
		subject: input.subject,
		class_tipo: cls?.tipo ?? null,
		section_tipo: section,
		ops: walk.ops,
	};
}

/**
 * Plan a LINKED resource after it was dereferenced: the `find_or_create` op that
 * asked for it (`needs_fetch_iri`) gives `class_tipo` and `key`, and `graph` is
 * the fetched document. The ops write to that record. `known_keys` are the keys
 * the first plan already emitted, so a record they name is linked and not
 * emitted again.
 */
export function planRdfResource(
	ont: RdfImportOntology,
	graph: RdfGraph,
	input: {
		readonly subject: string;
		readonly class_tipo: string;
		readonly key: string;
		readonly langs: RdfPlanLangs;
		readonly known_keys?: Iterable<string>;
	},
): RdfImportOp[] {
	const walk = newWalk(ont, graph, input.langs);
	for (const key of input.known_keys ?? []) walk.keys.add(key);
	const cls = ont.nodes.get(input.class_tipo);
	const section = cls === undefined ? null : sectionOf(ont, cls);
	if (cls === undefined || section === null) return [];
	walk.keys.add(input.key);
	const target = refOf(input.key);
	walkChildren(walk, cls, {
		subject: input.subject,
		target,
		section_tipo: section,
		depth: 0,
		pin: null,
	});
	return walk.ops;
}

/** The record keys a plan's ops emit (for `planRdfResource`'s `known_keys`). */
export function emittedKeys(ops: readonly RdfImportOp[]): string[] {
	return ops.flatMap((op) =>
		op.op === 'find_or_create' || op.op === 'intermediate' ? [op.key] : [],
	);
}
