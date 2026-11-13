/**
 * RDF GRAPH IR — what an rdf publication resolves to (T1-4 / O09).
 *
 * RDF is a GRAPH, not a table: a record publishes one or more SUBJECTS
 * (its class resource, portal sub-resources, typed resources, the classes of
 * linked records), each carrying predicate → object triples whose objects are
 * resources (`rdf:resource` / nested) or literals (`xml:lang` / `rdf:datatype`).
 * The resolver builds it (resolve/rdf_graph.ts), the rdf writer serialises it
 * (writers/rdf_xml_serialiser.ts). Engine-owned data, no I/O, no module state.
 *
 * It is a port of the parts of EasyRdf 1.19 (sweetrdf/easyrdf — what PHP
 * class.diffusion_rdf.php built its documents with) whose semantics reach the
 * published bytes:
 *
 * - Graph::add (lib/Graph.php:957) — a triple already present is NOT added
 *   again (exact value equality), the reverse index records who points at a
 *   resource (the serialiser's nesting rule reads it);
 * - Graph::resource / addType (:145, :1564) — creating a subject (optionally
 *   typed) fixes its place in the document: resources() is the CREATION order,
 *   then subjects/objects only ever seen in the indexes (:395-410);
 * - RdfNamespace (lib/RdfNamespace.php) — the initial prefix table in its exact
 *   order, `set` (lowercased prefix, an existing prefix keeps its slot, a new
 *   one is appended), `expand` (QName `^[\w-]+?:[\w-]+$` only) and
 *   `splitUri`/`shorten` (FIRST namespace whose URI prefixes the IRI with no
 *   '/' or '#' in the local part — why `dcterms:title` publishes as `dc:title`);
 * - Literal::create + Literal\Decimal / Literal\Integer (lib/Literal*.php) —
 *   the lexical form a typed value is written with.
 *
 * DELIBERATELY NOT PORTED: EasyRdf's namespace table is a PROCESS-STATIC that
 * `RdfNamespace::set` mutates, so in PHP one element's xmlns leaked into every
 * later element of the same process. Here the table is per-plan DATA
 * (rdfNamespaceTable), built fresh from the element's declaration — no module
 * state (module_state_tripwire), no bleed between elements or requests.
 */

/** rdf:type, the only predicate the IR treats specially. */
export const RDF_TYPE_URI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** The XSD namespace — Literal\Decimal / Literal\Integer are keyed on it. */
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * EasyRdf RdfNamespace::$initial_namespaces — VERBATIM and IN ORDER. The
 * order is load-bearing: `shorten` returns the FIRST matching namespace, so
 * `http://purl.org/dc/terms/title` is `dc:title`, never `dcterms:title`.
 */
export const EASYRDF_INITIAL_NAMESPACES: readonly (readonly [string, string])[] = [
	['as', 'https://www.w3.org/ns/activitystreams#'],
	['bibo', 'http://purl.org/ontology/bibo/'],
	['cc', 'http://creativecommons.org/ns#'],
	['cert', 'http://www.w3.org/ns/auth/cert#'],
	['csvw', 'http://www.w3.org/ns/csvw#'],
	['ctag', 'http://commontag.org/ns#'],
	['dc', 'http://purl.org/dc/terms/'],
	['dc11', 'http://purl.org/dc/elements/1.1/'],
	['dcat', 'http://www.w3.org/ns/dcat#'],
	['dcterms', 'http://purl.org/dc/terms/'],
	['doap', 'http://usefulinc.com/ns/doap#'],
	['dqv', 'http://www.w3.org/ns/dqv#'],
	['duv', 'https://www.w3.org/ns/duv#'],
	['exif', 'http://www.w3.org/2003/12/exif/ns#'],
	['foaf', 'http://xmlns.com/foaf/0.1/'],
	['geo', 'http://www.w3.org/2003/01/geo/wgs84_pos#'],
	['gr', 'http://purl.org/goodrelations/v1#'],
	['grddl', 'http://www.w3.org/2003/g/data-view#'],
	['ical', 'http://www.w3.org/2002/12/cal/icaltzd#'],
	['jsonld', 'http://www.w3.org/ns/json-ld#'],
	['ldp', 'http://www.w3.org/ns/ldp#'],
	['ma', 'http://www.w3.org/ns/ma-ont#'],
	['oa', 'http://www.w3.org/ns/oa#'],
	['odrl', 'http://www.w3.org/ns/odrl/2/'],
	['og', 'http://ogp.me/ns#'],
	['org', 'http://www.w3.org/ns/org#'],
	['owl', 'http://www.w3.org/2002/07/owl#'],
	['prov', 'http://www.w3.org/ns/prov#'],
	['qb', 'http://purl.org/linked-data/cube#'],
	['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
	['rdfa', 'http://www.w3.org/ns/rdfa#'],
	['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
	['rev', 'http://purl.org/stuff/rev#'],
	['rif', 'http://www.w3.org/2007/rif#'],
	['rr', 'http://www.w3.org/ns/r2rml#'],
	['rss', 'http://purl.org/rss/1.0/'],
	['schema', 'http://schema.org/'],
	['sd', 'http://www.w3.org/ns/sparql-service-description#'],
	['sioc', 'http://rdfs.org/sioc/ns#'],
	['skos', 'http://www.w3.org/2004/02/skos/core#'],
	['skosxl', 'http://www.w3.org/2008/05/skos-xl#'],
	['sosa', 'http://www.w3.org/ns/sosa/'],
	['ssn', 'http://www.w3.org/ns/ssn/'],
	['synd', 'http://purl.org/rss/1.0/modules/syndication/'],
	['time', 'http://www.w3.org/2006/time#'],
	['v', 'http://rdf.data-vocabulary.org/#'],
	['vcard', 'http://www.w3.org/2006/vcard/ns#'],
	['void', 'http://rdfs.org/ns/void#'],
	['wdr', 'http://www.w3.org/2007/05/powder#'],
	['wdrs', 'http://www.w3.org/2007/05/powder-s#'],
	['wot', 'http://xmlns.com/wot/0.1/'],
	['xhv', 'http://www.w3.org/1999/xhtml/vocab#'],
	['xml', 'http://www.w3.org/XML/1998/namespace'],
	['xsd', 'http://www.w3.org/2001/XMLSchema#'],
];

/**
 * A namespace prefix the table accepts. EasyRdf verifyPrefix admits any XML
 * NCName; this is its ASCII subset — every vocabulary prefix in use, and the
 * only shape `expand`'s `[\w-]+` can ever produce a QName for anyway.
 */
export const RDF_PREFIX_PATTERN = /^[A-Za-z_][\w.-]*$/;

/** EasyRdf RdfNamespace::expand's QName grammar (`^([\w\-]+?):([\w\-]+)$`). */
const QNAME_PATTERN = /^([\w-]+?):([\w-]+)$/;

/**
 * One plan's namespace table: EasyRdf's initial table with the element's
 * declarations applied in order (RdfNamespace::set — prefix lowercased; a
 * known prefix is REPLACED in its slot, a new one appended). Immutable.
 */
export class RdfNamespaceTable {
	private readonly byPrefix: Map<string, string>;

	constructor(declared: readonly (readonly [string, string])[] = []) {
		this.byPrefix = new Map(EASYRDF_INITIAL_NAMESPACES.map(([prefix, uri]) => [prefix, uri]));
		for (const [prefix, uri] of declared) this.byPrefix.set(prefix.toLowerCase(), uri);
	}

	/** The namespace URI of a prefix (case-insensitive like RdfNamespace::get), or null. */
	get(prefix: string): string | null {
		return this.byPrefix.get(prefix.toLowerCase()) ?? null;
	}

	/**
	 * QName → IRI, or NULL when the QName is not expandable (a grammar EasyRdf
	 * would have passed through VERBATIM as a relative junk IRI — the compiler
	 * refuses those instead).
	 */
	expand(qname: string): string | null {
		const match = QNAME_PATTERN.exec(qname);
		if (match === null) return null;
		const namespace = this.get(match[1] as string);
		return namespace === null ? null : `${namespace}${match[2]}`;
	}

	/**
	 * IRI → QName: the FIRST namespace (table order) whose URI is a prefix of
	 * the IRI and leaves a local part without '/' or '#' (RdfNamespace::splitUri).
	 * Null when none applies (EasyRdf would then MINT an `nsN` prefix; the
	 * compiler guarantees every published predicate/type is expandable, so the
	 * serialiser treats null as an invariant breach).
	 */
	shorten(iri: string): { prefix: string; local: string } | null {
		for (const [prefix, namespace] of this.byPrefix) {
			if (!iri.startsWith(namespace)) continue;
			const local = iri.slice(namespace.length);
			if (local.includes('/') || local.includes('#')) continue;
			return { prefix, local };
		}
		return null;
	}
}

/** One RDF term in object position. */
export type RdfTerm =
	| { kind: 'resource'; uri: string }
	| { kind: 'literal'; value: string; lang: string | null; datatype: string | null };

/** EasyRdf Graph::add's `$v == $value` over the normalized rdf-php arrays. */
function sameTerm(a: RdfTerm, b: RdfTerm): boolean {
	if (a.kind === 'resource') return b.kind === 'resource' && a.uri === b.uri;
	if (b.kind === 'resource') return false;
	return a.value === b.value && a.lang === b.lang && a.datatype === b.datatype;
}

/**
 * The graph of ONE published document. Insertion-ordered everywhere: the
 * serialiser's output order IS the order resources and triples were added.
 */
export class RdfGraph {
	/** subject → predicate IRI → objects (EasyRdf $index). */
	private readonly index = new Map<string, Map<string, RdfTerm[]>>();
	/** object IRI → predicate IRI → subjects pointing at it (EasyRdf $revIndex). */
	private readonly reverse = new Map<string, Map<string, string[]>>();
	/** Resources created through resource(), in creation order (EasyRdf $resources). */
	private readonly created: string[] = [];
	private readonly createdSet = new Set<string>();

	/** Graph::resource($uri, $type): create (once) and optionally type a subject. */
	resource(uri: string, typeUri?: string): void {
		if (typeUri !== undefined) this.add(uri, RDF_TYPE_URI, { kind: 'resource', uri: typeUri });
		if (!this.createdSet.has(uri)) {
			this.createdSet.add(uri);
			this.created.push(uri);
		}
	}

	/** Graph::add — false when the identical triple already exists (deduplicated). */
	add(subject: string, predicate: string, object: RdfTerm): boolean {
		let properties = this.index.get(subject);
		if (properties === undefined) {
			properties = new Map();
			this.index.set(subject, properties);
		}
		let objects = properties.get(predicate);
		if (objects === undefined) {
			objects = [];
			properties.set(predicate, objects);
		}
		if (objects.some((existing) => sameTerm(existing, object))) return false;
		objects.push(object);
		if (object.kind === 'resource') {
			let byPredicate = this.reverse.get(object.uri);
			if (byPredicate === undefined) {
				byPredicate = new Map();
				this.reverse.set(object.uri, byPredicate);
			}
			const subjects = byPredicate.get(predicate) ?? [];
			subjects.push(subject);
			byPredicate.set(predicate, subjects);
		}
		return true;
	}

	/** Has this subject at least one triple? */
	hasTriples(subject: string): boolean {
		return (this.index.get(subject)?.size ?? 0) > 0;
	}

	/**
	 * Graph::resources(): created resources first, then index subjects and
	 * reverse-index objects not created explicitly, each in first-seen order.
	 */
	resources(): string[] {
		const ordered = [...this.created];
		const seen = new Set(ordered);
		for (const uri of [...this.index.keys(), ...this.reverse.keys()]) {
			if (seen.has(uri)) continue;
			seen.add(uri);
			ordered.push(uri);
		}
		return ordered;
	}

	/** Predicate IRI → objects of a subject (empty map when it has none). */
	properties(subject: string): ReadonlyMap<string, readonly RdfTerm[]> {
		return this.index.get(subject) ?? new Map();
	}

	/**
	 * Serialiser::reversePropertyCount: the number of DISTINCT predicates
	 * pointing at the resource, except that a single predicate counts its
	 * subjects (one subject via one predicate = 1 = nestable).
	 */
	reversePropertyCount(uri: string): number {
		const byPredicate = this.reverse.get(uri);
		if (byPredicate === undefined) return 0;
		if (byPredicate.size !== 1) return byPredicate.size;
		return ([...byPredicate.values()][0] as string[]).length;
	}

	/** The first rdf:type IRI of a subject (Graph::typeAsResource), or null. */
	typeOf(subject: string): string | null {
		const types = this.index.get(subject)?.get(RDF_TYPE_URI) ?? [];
		const first = types.find((term) => term.kind === 'resource');
		return first?.kind === 'resource' ? first.uri : null;
	}
}

/** One published record's document: what the rdf writer serialises to its file. */
export interface RdfRecordDocument {
	sectionId: number | string;
	graph: RdfGraph;
}

/** The PHP scalar type json_decode gave a stored number (gettype). */
export type PhpNumberType = 'integer' | 'double';

/**
 * PHP `(string)` of a float in the base Literal (lib/Literal.php:228-230):
 * `rtrim(sprintf('%F', $value), '0')` — six decimals, trailing zeros cut,
 * so 5.0 becomes "5." and 0.83 becomes "0.83".
 */
function phpFloatLiteral(value: number): string {
	return value.toFixed(6).replace(/0+$/, '');
}

/** EasyRdf Literal\Decimal::canonicalise (DECIMAL_REGEX, sign/int/fraction). */
function canonicalDecimal(lexical: string): string | null {
	const match = /^([+-]?)(?:(\d+)?\.(\d+)|(\d+)\.?)$/.exec(lexical);
	if (match === null) return null;
	const sign = match[1] === '-' ? '-' : '';
	const integer = (match[2] ?? match[4] ?? '').replace(/^0+/, '') || '0';
	const fraction = (match[3] ?? '').replace(/0+$/, '') || '0';
	return `${sign}${integer}.${fraction}`;
}

/**
 * A literal the value cannot be written as. Its sentence is AUTHORED here for
 * the run report (resolve/rdf_graph.ts rdfReportSentence) — never a caught
 * exception's text.
 */
export class RdfLiteralError extends RangeError {
	readonly reportSentence: string;
	constructor(sentence: string) {
		super(sentence);
		this.name = 'RdfLiteralError';
		this.reportSentence = sentence;
	}
}

/**
 * Literal::create($value, null, $datatype) — the lexical form of a TYPED
 * literal, by EasyRdf's datatype class: xsd:decimal canonicalises (`1` →
 * `1.0`, an unparseable value THROWS like Literal\Decimal::validate),
 * xsd:integer and every other datatype cast the value to its PHP string (a
 * PHP float through the base Literal's sprintf rule).
 *
 * `phpType` is how PHP held the value (json_decode: a number token with '.',
 * 'e' or 'E' is a double, otherwise an integer) — JS cannot tell `1.0` from
 * `1`, the stored text can (resolve/rdf_graph.ts reads it).
 */
export function typedLiteral(
	value: string | number | boolean,
	phpType: PhpNumberType | 'string' | 'boolean',
	datatypeUri: string,
): RdfTerm {
	let lexical: string;
	if (datatypeUri === `${XSD}decimal`) {
		const source = typeof value === 'number' ? String(value) : String(value);
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new RdfLiteralError(`xsd:decimal literal: ${value} is not a finite number`);
		}
		const canonical = canonicalDecimal(source);
		if (canonical === null) {
			throw new RdfLiteralError(
				`xsd:decimal literal: '${source}' doesn't look like a valid decimal`,
			);
		}
		lexical = canonical;
	} else if (typeof value === 'number') {
		lexical = phpType === 'double' ? phpFloatLiteral(value) : String(value);
	} else if (typeof value === 'boolean') {
		lexical = value ? '1' : '';
	} else {
		lexical = value;
	}
	return { kind: 'literal', value: lexical, lang: null, datatype: datatypeUri };
}

/** A plain literal (`xml:lang` when lang is set, untyped otherwise). */
export function plainLiteral(value: string, lang: string | null): RdfTerm {
	return { kind: 'literal', value, lang, datatype: null };
}
