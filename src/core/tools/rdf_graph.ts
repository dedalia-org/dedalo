/**
 * RDF/XML GRAPH READER — the triple-level reading tool_import_rdf needs to map a
 * remote linked-data answer through an external ontology (the owl:Class /
 * owl:ObjectProperty map under the import node). Additive next to rdf_xml.ts:
 * it reuses that module's XML reader (`parseXml`) and leaves `parseRdfXml` /
 * `applyRdfMap` (tool_import_rdf's subject list) untouched.
 *
 * What it reads (the RDF 1.1 XML syntax, minus reification):
 *  - namespaces SCOPED per element (`xmlns:p`, the default `xmlns`), `xml:base`
 *    (so `rdf:about="#obverse"` resolves against the document IRI the caller
 *    passes as `baseIri`) and `xml:lang` (inherited by every literal below it);
 *  - subjects from `rdf:about`, `rdf:ID`, `rdf:nodeID`, or a fresh blank node;
 *  - typed node elements (`<nmo:TypeSeriesItem>`) emit `rdf:type` exactly like an
 *    `rdf:type` property; property ATTRIBUTES are literals (`rdf:type` an IRI);
 *  - property elements: `rdf:resource`, `rdf:nodeID`, a nested node element (its
 *    subject becomes the object — recursion), `rdf:parseType` Resource / Literal /
 *    Collection, `rdf:li` numbering, typed (`rdf:datatype`) and tagged literals.
 *
 * Blank nodes are named `_:<nodeID>` when the document names them and `_:#<n>`
 * when it does not (`#` cannot occur in an NCName, so the two never collide).
 *
 * The answer is untrusted input: element nesting is bounded by `maxDepth` (the
 * reader recurses) and the statement count by `maxTriples`; past either it
 * throws `tool.rdf_graph_too_large`. Prefixed names in queries are expanded
 * through the CALLER's xmlns map first (the import ontology's own prefixes), then
 * the document's, then the rdf/rdfs/xsd/owl defaults — so a document that binds
 * `nm:` and an ontology that says `nmo:` for the same namespace still meet.
 *
 * No module state: the index (subject → predicate → objects) lives inside the
 * graph object `parseRdfGraph` returns.
 */

import { DedaloError } from '../errors/index.ts';
import { parseXml, type XmlNode } from './rdf_xml.ts';

/** A prefix → namespace map (`{ nmo: 'http://nomisma.org/ontology#' }`). */
export type XmlnsMap = Readonly<Record<string, string>>;

/** An RDF object: an IRI, a blank node (`_:…`), or a literal. */
export type RdfTerm =
	| { readonly kind: 'iri'; readonly value: string }
	| { readonly kind: 'bnode'; readonly value: string }
	| {
			readonly kind: 'literal';
			readonly value: string;
			readonly lang?: string;
			readonly datatype?: string;
	  };

/** One statement. Subject/predicate are full IRIs (a blank-node subject is `_:…`). */
export interface RdfTriple {
	readonly subject: string;
	readonly predicate: string;
	readonly object: RdfTerm;
}

/** A literal as a query answers it: `datatype` shortened (`xsd:gYear`). */
export interface RdfLiteral {
	value: string;
	lang?: string;
	datatype?: string;
}

export interface RdfGraphOptions {
	/** The document's IRI (the address dereferenced) — the base for `#obverse`. */
	baseIri?: string;
	/** Deepest element nesting read (default RDF_GRAPH_MAX_DEPTH). */
	maxDepth?: number;
	/** Most statements read (default RDF_GRAPH_MAX_TRIPLES). */
	maxTriples?: number;
}

export interface RdfLiteralQuery {
	/**
	 * Absent: any literal. `null`: untagged literals only. A tag (`es`, `en-GB`):
	 * that tag (case-insensitive), or — for a bare primary tag — any of its
	 * regional variants; `literal()` prefers an exact match.
	 */
	lang?: string | null;
	xmlns?: XmlnsMap;
}

export interface RdfGraph {
	/** Every statement, in document order. */
	readonly triples: readonly RdfTriple[];
	/** The document's prefix declarations (first declaration of a prefix wins). */
	readonly namespaces: XmlnsMap;
	/** Every subject with at least one statement. */
	subjects(): string[];
	/** `nmo:hasMint` → full IRI (caller map, document, defaults); anything else unchanged. */
	expand(name: string, xmlns?: XmlnsMap): string;
	/** Full IRI → `prefix:local` (caller map, document, defaults); unchanged when no prefix covers it. */
	shorten(iri: string, xmlns?: XmlnsMap): string;
	/** All objects of (subject, predicate). */
	objects(subject: string, predicate: string, xmlns?: XmlnsMap): RdfTerm[];
	/** The subject's rdf:type values, shortened, in document order. */
	types(subject: string, xmlns?: XmlnsMap): string[];
	/** The first type (or the first among `among`, compared as full IRIs), shortened; null when none. */
	typeOf(subject: string, xmlns?: XmlnsMap, among?: readonly string[]): string | null;
	/** The first IRI/blank-node object of (subject, predicate), or null. */
	resource(subject: string, predicate: string, xmlns?: XmlnsMap): string | null;
	/** Every IRI/blank-node object of (subject, predicate). */
	resources(subject: string, predicate: string, xmlns?: XmlnsMap): string[];
	/** The first literal of (subject, predicate) matching `query.lang`, or null. */
	literal(subject: string, predicate: string, query?: RdfLiteralQuery): RdfLiteral | null;
	/** Every literal of (subject, predicate) matching `query.lang`. */
	literals(subject: string, predicate: string, query?: RdfLiteralQuery): RdfLiteral[];
}

export const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const RDF_TYPE = `${RDF_NS}type`;

/** The prefixes every query knows, after the caller's map and the document's. */
export const RDF_DEFAULT_XMLNS: XmlnsMap = Object.freeze({
	rdf: RDF_NS,
	rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
	xsd: 'http://www.w3.org/2001/XMLSchema#',
	owl: 'http://www.w3.org/2002/07/owl#',
});

/** Default nesting bound — linked-data answers nest a handful of levels. */
export const RDF_GRAPH_MAX_DEPTH = 64;
/** Default statement bound — one IRI's description is tens to hundreds. */
export const RDF_GRAPH_MAX_TRIPLES = 50_000;

/** rdf: attribute names that are syntax, not property attributes. */
const SYNTAX_NAMES = [
	'about',
	'ID',
	'nodeID',
	'resource',
	'datatype',
	'parseType',
	'bagID',
] as const;
type SyntaxName = (typeof SYNTAX_NAMES)[number];
type SyntaxAttrs = Partial<Record<SyntaxName, string>>;
/** Unprefixed attributes old RDF/XML writers emit, read as their rdf: names. */
const LEGACY_UNPREFIXED: readonly string[] = [
	'about',
	'resource',
	'ID',
	'nodeID',
	'parseType',
	'datatype',
];
/** An IRI with a scheme — never resolved against a base. */
const ABSOLUTE_IRI = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

interface Scope {
	readonly ns: Readonly<Record<string, string>>;
	readonly base: string | null;
	readonly lang: string | null;
}

interface PropertyAttr {
	readonly iri: string;
	readonly value: string;
}

interface ParseState {
	readonly triples: RdfTriple[];
	readonly namespaces: Record<string, string>;
	readonly maxDepth: number;
	readonly maxTriples: number;
	bnodes: number;
}

// --- bounds -----------------------------------------------------------------

function tooLarge(bound: 'depth' | 'triples', limit: number): DedaloError {
	return new DedaloError('tool.rdf_graph_too_large', {
		details: { limit },
		coordinates: { bound },
	});
}

function checkDepth(state: ParseState, depth: number): void {
	if (depth > state.maxDepth) throw tooLarge('depth', state.maxDepth);
}

function pushTriple(state: ParseState, subject: string, predicate: string, object: RdfTerm): void {
	if (state.triples.length >= state.maxTriples) throw tooLarge('triples', state.maxTriples);
	state.triples.push({ subject, predicate, object });
}

// --- names, IRIs, terms -----------------------------------------------------

function hasOwn(map: Readonly<Record<string, string>>, key: string): boolean {
	return Object.hasOwn(map, key);
}

function stripFragment(iri: string): string {
	const hash = iri.indexOf('#');
	return hash === -1 ? iri : iri.slice(0, hash);
}

/** Resolve an IRI reference against the in-scope base (absolute ones verbatim, never normalised). */
function resolveIri(ref: string, base: string | null): string {
	if (base === null || ABSOLUTE_IRI.test(ref)) return ref;
	if (ref === '' || ref.startsWith('#')) return stripFragment(base) + ref;
	try {
		return new URL(ref, base).href;
	} catch {
		return ref;
	}
}

/** `p:local` (or a bare name in the default namespace) → full IRI; null for an undeclared prefix. */
function expandQName(qname: string, ns: Readonly<Record<string, string>>): string | null {
	const idx = qname.indexOf(':');
	const prefix = idx === -1 ? '' : qname.slice(0, idx);
	return hasOwn(ns, prefix) ? `${ns[prefix]}${qname.slice(idx + 1)}` : null;
}

/** An element's full IRI; an unresolvable name stays as written. */
function elementIri(el: XmlNode, scope: Scope): string {
	return expandQName(el.tag, scope.ns) ?? el.tag;
}

/** An attribute's full IRI; null for namespace/xml: attributes and unknown unprefixed ones. */
function attributeIri(name: string, ns: Readonly<Record<string, string>>): string | null {
	if (name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('xml:')) return null;
	if (!name.includes(':')) return LEGACY_UNPREFIXED.includes(name) ? RDF_NS + name : null;
	return expandQName(name, ns);
}

function syntaxName(iri: string): SyntaxName | null {
	const local = iri.slice(RDF_NS.length) as SyntaxName;
	return iri.startsWith(RDF_NS) && SYNTAX_NAMES.includes(local) ? local : null;
}

function termOf(node: string): RdfTerm {
	return node.startsWith('_:') ? { kind: 'bnode', value: node } : { kind: 'iri', value: node };
}

function literalTerm(value: string, lang: string | null, datatype?: string): RdfTerm {
	if (datatype !== undefined) return { kind: 'literal', value, datatype };
	return lang === null ? { kind: 'literal', value } : { kind: 'literal', value, lang };
}

function newBnode(state: ParseState): string {
	state.bnodes += 1;
	return `_:#${state.bnodes}`;
}

// --- scope ------------------------------------------------------------------

/** The element's own `xmlns` / `xmlns:p` declarations, or null when it has none. */
function namespaceDeclarations(attrs: Record<string, string>): Record<string, string> | null {
	let decls: Record<string, string> | null = null;
	for (const [name, value] of Object.entries(attrs)) {
		const prefix = name === 'xmlns' ? '' : name.startsWith('xmlns:') ? name.slice(6) : null;
		if (prefix === null) continue;
		decls ??= {};
		decls[prefix] = value;
	}
	return decls;
}

function recordNamespaces(state: ParseState, decls: Record<string, string> | null): void {
	if (decls === null) return;
	for (const [prefix, ns] of Object.entries(decls)) {
		if (prefix !== '' && !hasOwn(state.namespaces, prefix)) state.namespaces[prefix] = ns;
	}
}

function inheritedLang(value: string | undefined, outer: string | null): string | null {
	if (value === undefined) return outer;
	return value === '' ? null : value;
}

/** The scope an element opens: its namespaces, base and language over the outer ones. */
function scopeOf(el: XmlNode, outer: Scope, state: ParseState): Scope {
	const decls = namespaceDeclarations(el.attrs);
	recordNamespaces(state, decls);
	const base = el.attrs['xml:base'];
	return {
		ns: decls === null ? outer.ns : { ...outer.ns, ...decls },
		base: base === undefined ? outer.base : resolveIri(base, outer.base),
		lang: inheritedLang(el.attrs['xml:lang'], outer.lang),
	};
}

/** Split an element's attributes into rdf: syntax and property attributes. */
function rdfAttrs(el: XmlNode, scope: Scope): { syntax: SyntaxAttrs; props: PropertyAttr[] } {
	const syntax: SyntaxAttrs = {};
	const props: PropertyAttr[] = [];
	for (const [name, value] of Object.entries(el.attrs)) {
		const iri = attributeIri(name, scope.ns);
		if (iri === null) continue;
		const local = syntaxName(iri);
		if (local === null) props.push({ iri, value });
		else syntax[local] = value;
	}
	return { syntax, props };
}

// --- XML helpers ------------------------------------------------------------

function elementChildren(el: XmlNode): XmlNode[] {
	return el.children.filter((c): c is XmlNode => typeof c !== 'string');
}

function textOf(el: XmlNode): string {
	return el.children.filter((c): c is string => typeof c === 'string').join('');
}

function escapeXml(text: string, quote: boolean): string {
	const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	return quote ? escaped.replaceAll('"', '&quot;') : escaped;
}

/** Re-serialise an XML literal's content (rdf:parseType="Literal"). */
function serializeXml(node: XmlNode | string, state: ParseState, depth: number): string {
	if (typeof node === 'string') return escapeXml(node, false);
	checkDepth(state, depth);
	const attrs = Object.entries(node.attrs)
		.map(([name, value]) => ` ${name}="${escapeXml(value, true)}"`)
		.join('');
	const inner = node.children.map((c) => serializeXml(c, state, depth + 1)).join('');
	return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

// --- the RDF/XML grammar ----------------------------------------------------

function subjectOf(syntax: SyntaxAttrs, scope: Scope, state: ParseState): string {
	if (syntax.about !== undefined) return resolveIri(syntax.about, scope.base);
	if (syntax.ID !== undefined) return resolveIri(`#${syntax.ID}`, scope.base);
	if (syntax.nodeID !== undefined) return `_:${syntax.nodeID}`;
	return newBnode(state);
}

function propertyAttributes(
	subject: string,
	props: readonly PropertyAttr[],
	scope: Scope,
	state: ParseState,
): void {
	for (const { iri, value } of props) {
		const object =
			iri === RDF_TYPE ? termOf(resolveIri(value, scope.base)) : literalTerm(value, scope.lang);
		pushTriple(state, subject, iri, object);
	}
}

/** A node element: its subject, its type, its property attributes and elements. Returns the subject. */
function nodeElement(el: XmlNode, outer: Scope, state: ParseState, depth: number): string {
	checkDepth(state, depth);
	const scope = scopeOf(el, outer, state);
	const { syntax, props } = rdfAttrs(el, scope);
	const subject = subjectOf(syntax, scope, state);
	const name = elementIri(el, scope);
	if (name !== `${RDF_NS}Description`) pushTriple(state, subject, RDF_TYPE, termOf(name));
	propertyAttributes(subject, props, scope, state);
	propertyElements(el, subject, scope, state, depth);
	return subject;
}

/** Every child of a node element is a property element (`rdf:li` numbered `rdf:_1`, `rdf:_2`…). */
function propertyElements(
	el: XmlNode,
	subject: string,
	scope: Scope,
	state: ParseState,
	depth: number,
): void {
	let li = 0;
	for (const child of elementChildren(el)) {
		const childScope = scopeOf(child, scope, state);
		let predicate = elementIri(child, childScope);
		if (predicate === `${RDF_NS}li`) {
			li += 1;
			predicate = `${RDF_NS}_${li}`;
		}
		const object = propertyObject(child, childScope, state, depth + 1);
		pushTriple(state, subject, predicate, object);
	}
}

/** A property element's object. */
function propertyObject(el: XmlNode, scope: Scope, state: ParseState, depth: number): RdfTerm {
	checkDepth(state, depth);
	const { syntax, props } = rdfAttrs(el, scope);
	if (syntax.parseType !== undefined)
		return parseTypeObject(el, syntax.parseType, scope, state, depth);
	const node = elementChildren(el)[0];
	if (node !== undefined) return termOf(nodeElement(node, scope, state, depth + 1));
	if (namesObject(syntax, props)) return emptyPropertyObject(syntax, props, scope, state);
	return literalObject(el, syntax, scope);
}

/** An empty property element that names (or describes) a node rather than holding a literal. */
function namesObject(syntax: SyntaxAttrs, props: readonly PropertyAttr[]): boolean {
	return syntax.resource !== undefined || syntax.nodeID !== undefined || props.length > 0;
}

/** A literal property element: its text, `xml:lang` in scope, `rdf:datatype` resolved. */
function literalObject(el: XmlNode, syntax: SyntaxAttrs, scope: Scope): RdfTerm {
	const datatype =
		syntax.datatype === undefined ? undefined : resolveIri(syntax.datatype, scope.base);
	return literalTerm(textOf(el), scope.lang, datatype);
}

/** An empty property element naming its object (`rdf:resource` / `rdf:nodeID` / a fresh node with attributes). */
function emptyPropertyObject(
	syntax: SyntaxAttrs,
	props: readonly PropertyAttr[],
	scope: Scope,
	state: ParseState,
): RdfTerm {
	const object =
		syntax.resource !== undefined
			? resolveIri(syntax.resource, scope.base)
			: syntax.nodeID !== undefined
				? `_:${syntax.nodeID}`
				: newBnode(state);
	propertyAttributes(object, props, scope, state);
	return termOf(object);
}

function parseTypeObject(
	el: XmlNode,
	parseType: string,
	scope: Scope,
	state: ParseState,
	depth: number,
): RdfTerm {
	if (parseType === 'Resource') {
		const object = newBnode(state);
		propertyElements(el, object, scope, state, depth);
		return termOf(object);
	}
	if (parseType === 'Collection') return collectionObject(el, scope, state, depth);
	// 'Literal' — and, per the RDF/XML grammar, any other value.
	const xml = el.children.map((c) => serializeXml(c, state, depth + 1)).join('');
	return literalTerm(xml, null, `${RDF_NS}XMLLiteral`);
}

/** rdf:parseType="Collection" → an rdf:first/rdf:rest list of the child node elements. */
function collectionObject(el: XmlNode, scope: Scope, state: ParseState, depth: number): RdfTerm {
	const items = elementChildren(el).map((n) => termOf(nodeElement(n, scope, state, depth + 1)));
	let rest: RdfTerm = { kind: 'iri', value: `${RDF_NS}nil` };
	for (const item of items.reverse()) {
		const cell = newBnode(state);
		pushTriple(state, cell, `${RDF_NS}first`, item);
		pushTriple(state, cell, `${RDF_NS}rest`, rest);
		rest = termOf(cell);
	}
	return rest;
}

/** The document element: an rdf:RDF wrapper of node elements, or a single node element. */
function readDocument(top: XmlNode, scope: Scope, state: ParseState): void {
	const topScope = scopeOf(top, scope, state);
	if (elementIri(top, topScope) !== `${RDF_NS}RDF`) {
		nodeElement(top, scope, state, 1);
		return;
	}
	for (const child of elementChildren(top)) nodeElement(child, topScope, state, 2);
}

// --- queries ----------------------------------------------------------------

function namespaceFor(prefix: string, maps: readonly XmlnsMap[]): string | undefined {
	return maps.find((map) => hasOwn(map, prefix))?.[prefix];
}

/** `prefix:local` → full IRI through the maps in order; an IRI (`http://…`) or unknown prefix unchanged. */
function expandName(name: string, maps: readonly XmlnsMap[]): string {
	const idx = name.indexOf(':');
	if (idx <= 0 || name.startsWith('//', idx + 1)) return name;
	const ns = namespaceFor(name.slice(0, idx), maps);
	return ns === undefined ? name : ns + name.slice(idx + 1);
}

function covers(iri: string, prefix: string, ns: string): boolean {
	return prefix !== '' && ns !== '' && iri.startsWith(ns);
}

/** The longest namespace of `map` covering `iri`, as `prefix:local`; null when none does. */
function shortenWith(iri: string, map: XmlnsMap): string | null {
	let best: [string, string] | null = null;
	for (const [prefix, ns] of Object.entries(map)) {
		if (covers(iri, prefix, ns) && (best === null || ns.length > best[1].length))
			best = [prefix, ns];
	}
	return best === null ? null : `${best[0]}:${iri.slice(best[1].length)}`;
}

function shortenName(iri: string, maps: readonly XmlnsMap[]): string {
	for (const map of maps) {
		const short = shortenWith(iri, map);
		if (short !== null) return short;
	}
	return iri;
}

/** Primary subtag of a language tag, lower-cased (`en-GB` → `en`). */
function primaryTag(tag: string): string {
	return tag.split('-')[0]?.toLowerCase() ?? '';
}

/** A tagged literal against a wanted tag: the same tag, or a regional variant of a bare primary tag. */
function tagMatches(lang: string, wanted: string): boolean {
	if (lang.toLowerCase() === wanted.toLowerCase()) return true;
	return !wanted.includes('-') && primaryTag(lang) === primaryTag(wanted);
}

function langMatches(lang: string | undefined, wanted: string | null | undefined): boolean {
	if (wanted === undefined) return true;
	if (wanted === null || lang === undefined) return wanted === null && lang === undefined;
	return tagMatches(lang, wanted);
}

function isExactLang(literal: RdfLiteral, wanted: string | null | undefined): boolean {
	return typeof wanted !== 'string' || literal.lang?.toLowerCase() === wanted.toLowerCase();
}

function toLiteral(
	term: RdfTerm & { kind: 'literal' },
	shorten: (iri: string) => string,
): RdfLiteral {
	const literal: RdfLiteral = { value: term.value };
	if (term.lang !== undefined) literal.lang = term.lang;
	if (term.datatype !== undefined) literal.datatype = shorten(term.datatype);
	return literal;
}

function isLiteral(term: RdfTerm): term is RdfTerm & { kind: 'literal' } {
	return term.kind === 'literal';
}

function indexTriples(triples: readonly RdfTriple[]): Map<string, Map<string, RdfTerm[]>> {
	const index = new Map<string, Map<string, RdfTerm[]>>();
	for (const { subject, predicate, object } of triples) {
		const byPredicate = index.get(subject) ?? new Map<string, RdfTerm[]>();
		index.set(subject, byPredicate);
		const list = byPredicate.get(predicate) ?? [];
		byPredicate.set(predicate, list);
		list.push(object);
	}
	return index;
}

function buildGraph(state: ParseState): RdfGraph {
	const index = indexTriples(state.triples);
	const namespaces: XmlnsMap = Object.freeze({ ...state.namespaces });
	const maps = (xmlns?: XmlnsMap): XmlnsMap[] => [xmlns ?? {}, namespaces, RDF_DEFAULT_XMLNS];
	const expand = (name: string, xmlns?: XmlnsMap): string => expandName(name, maps(xmlns));
	const shorten = (iri: string, xmlns?: XmlnsMap): string => shortenName(iri, maps(xmlns));
	const subjectKey = (s: string, xmlns?: XmlnsMap): string => (index.has(s) ? s : expand(s, xmlns));
	const objects = (s: string, p: string, xmlns?: XmlnsMap): RdfTerm[] => [
		...(index.get(subjectKey(s, xmlns))?.get(expand(p, xmlns)) ?? []),
	];
	const resources = (s: string, p: string, xmlns?: XmlnsMap): string[] =>
		objects(s, p, xmlns)
			.filter((o) => !isLiteral(o))
			.map((o) => o.value);
	const typeIris = (s: string, xmlns?: XmlnsMap): string[] =>
		resources(s, RDF_TYPE, xmlns).filter((t) => !t.startsWith('_:'));
	const literals = (s: string, p: string, query: RdfLiteralQuery = {}): RdfLiteral[] =>
		objects(s, p, query.xmlns)
			.filter(isLiteral)
			.filter((o) => langMatches(o.lang, query.lang))
			.map((o) => toLiteral(o, (iri) => shorten(iri, query.xmlns)));
	return {
		triples: state.triples,
		namespaces,
		subjects: () => [...index.keys()],
		expand,
		shorten,
		objects,
		types: (s, xmlns) => typeIris(s, xmlns).map((t) => shorten(t, xmlns)),
		typeOf: (s, xmlns, among) => {
			const wanted = among?.map((name) => expand(name, xmlns));
			const hit = typeIris(s, xmlns).find((t) => wanted === undefined || wanted.includes(t));
			return hit === undefined ? null : shorten(hit, xmlns);
		},
		resource: (s, p, xmlns) => resources(s, p, xmlns)[0] ?? null,
		resources,
		literal: (s, p, query = {}) => {
			const all = literals(s, p, query);
			return all.find((l) => isExactLang(l, query.lang)) ?? all[0] ?? null;
		},
		literals,
	};
}

/**
 * Read an RDF/XML document into a queryable graph. Input that is not RDF/XML
 * yields an empty graph, never a crash; a document past `maxDepth` / `maxTriples`
 * throws `tool.rdf_graph_too_large`.
 */
export function parseRdfGraph(text: string, options: RdfGraphOptions = {}): RdfGraph {
	const state: ParseState = {
		triples: [],
		namespaces: {},
		maxDepth: options.maxDepth ?? RDF_GRAPH_MAX_DEPTH,
		maxTriples: options.maxTriples ?? RDF_GRAPH_MAX_TRIPLES,
		bnodes: 0,
	};
	const top = elementChildren(parseXml(text))[0];
	const scope: Scope = { ns: { xml: XML_NS }, base: options.baseIri ?? null, lang: null };
	if (top !== undefined) readDocument(top, scope, state);
	return buildGraph(state);
}
