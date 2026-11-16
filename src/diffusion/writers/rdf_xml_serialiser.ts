/**
 * RDF/XML serialiser — an exact port of EasyRdf 1.19
 * `EasyRdf\Serialiser\RdfXml` (sweetrdf/easyrdf lib/Serialiser/RdfXml.php),
 * the serialiser PHP class.diffusion_rdf.php published with
 * (`$rdf_graph->serialise('rdfxml')`). T1-4 / O09.
 *
 * What is ported, rule for rule:
 * - URI resources are serialised in Graph::resources() order (the IR keeps
 *   it); a resource already output, or with no triple, yields nothing;
 * - element = the subject's first rdf:type shortened to a QName (that type
 *   triple is then not repeated as an `rdf:type` child), else `rdf:Description`;
 * - an object resource NESTS inside its predicate when it was not output yet,
 *   exactly one triple points at it (reversePropertyCount 1) and it has
 *   triples of its own; otherwise it is an empty `rdf:resource` element;
 * - a literal carries `rdf:datatype` (full IRI) when typed, else `xml:lang`
 *   when it has a language;
 * - every value and attribute is escaped with htmlspecialchars(ENT_COMPAT):
 *   & < > and " (never ');
 * - the envelope: `<?xml version="1.0" encoding="utf-8" ?>`, `<rdf:RDF` with
 *   `rdf` first and then every prefix in FIRST-USE order (types, predicates —
 *   never object IRIs), continuation `\n        ` before each further
 *   ` xmlns:`, two-space indent per depth, blank lines exactly where EasyRdf
 *   puts them.
 *
 * Not ported (cannot occur in an engine-built graph): blank nodes, rdf:Seq
 * containers, rdf:XMLLiteral, and EasyRdf's `nsN` prefix minting — every
 * predicate/type IRI comes from a QName the plan compiler already proved
 * expandable, so a non-shortenable IRI here is an invariant breach and throws.
 */

import { DedaloError } from '../../core/errors/index.ts';
import {
	RDF_TYPE_URI,
	type RdfGraph,
	type RdfNamespaceTable,
	type RdfTerm,
} from '../resolve/rdf_graph_ir.ts';

/** PHP htmlspecialchars($value, ENT_COMPAT): & < > " — never the single quote. */
export function escapeRdfXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** One serialise() call's state (EasyRdf keeps it on the serialiser instance). */
class RdfXmlRun {
	/** prefix → true, insertion-ordered; `rdf` always first. */
	readonly prefixes = new Set<string>(['rdf']);
	private readonly output = new Set<string>();

	constructor(
		private readonly graph: RdfGraph,
		private readonly namespaces: RdfNamespaceTable,
	) {}

	/** IRI → QName, recording its prefix (Serialiser::addPrefix). */
	private qname(iri: string, role: string): string {
		const short = this.namespaces.shorten(iri);
		if (short === null) {
			throw new DedaloError('internal.invariant', {
				message: `rdf serialiser: ${role} <${iri}> has no namespace in the plan's table — the compiler must refuse such a QName`,
			});
		}
		this.prefixes.add(short.prefix);
		return `${short.prefix}:${short.local}`;
	}

	/** RdfXml::rdfxmlResource. */
	resource(uri: string, depth: number): string {
		if (this.output.has(uri)) return '';
		this.output.add(uri);
		const properties = this.graph.properties(uri);
		if (properties.size === 0) return '';

		const typeUri = this.graph.typeOf(uri);
		const typeShort = typeUri === null ? null : this.namespaces.shorten(typeUri);
		let element = 'rdf:Description';
		if (typeShort !== null) {
			this.prefixes.add(typeShort.prefix);
			element = `${typeShort.prefix}:${typeShort.local}`;
		}
		const indent = '  '.repeat(depth);
		let xml = `\n${indent}<${element} rdf:about="${escapeRdfXml(uri)}">\n`;
		for (const [predicate, objects] of properties) {
			const short = this.qname(predicate, 'predicate');
			let values = objects;
			if (predicate === RDF_TYPE_URI && element !== 'rdf:Description') values = objects.slice(1);
			for (const object of values) xml += this.object(short, object, depth + 1);
		}
		return `${xml}${indent}</${element}>\n`;
	}

	/** RdfXml::rdfxmlObject. */
	private object(property: string, object: RdfTerm, depth: number): string {
		const indent = '  '.repeat(depth);
		if (object.kind === 'literal') {
			let attributes = '';
			if (object.datatype !== null) {
				attributes = ` rdf:datatype="${escapeRdfXml(object.datatype)}"`;
			} else if (object.lang !== null && object.lang !== '') {
				attributes = ` xml:lang="${escapeRdfXml(object.lang)}"`;
			}
			return `${indent}<${property}${attributes}>${escapeRdfXml(object.value)}</${property}>\n`;
		}
		const propertyCount = this.graph.properties(object.uri).size;
		const reverseCount = this.graph.reversePropertyCount(object.uri);
		const alreadyOutput = this.output.has(object.uri);
		let tag = `${indent}<${property}`;
		if (alreadyOutput || reverseCount !== 1 || propertyCount === 0) {
			tag += ` rdf:resource="${escapeRdfXml(object.uri)}"`;
		}
		if (!alreadyOutput && reverseCount === 1 && propertyCount > 0) {
			const nested = this.resource(object.uri, depth + 1);
			return nested !== '' ? `${tag}>${nested}${indent}</${property}>\n\n` : '';
		}
		return `${tag}/>\n`;
	}
}

/**
 * Serialise one graph as an RDF/XML document — RdfXml::serialise. Byte-exact
 * EasyRdf output for every graph the engine builds.
 */
export function serialiseRdfXml(graph: RdfGraph, namespaces: RdfNamespaceTable): string {
	const run = new RdfXmlRun(graph, namespaces);
	let xml = '';
	for (const uri of graph.resources()) xml += run.resource(uri, 1);
	let declarations = '';
	for (const prefix of run.prefixes) {
		const uri = namespaces.get(prefix);
		if (uri === null) {
			throw new DedaloError('internal.invariant', {
				message: `rdf serialiser: prefix '${prefix}' used but not in the plan's namespace table`,
			});
		}
		if (declarations.length > 0) declarations += '\n        ';
		declarations += ` xmlns:${prefix}="${escapeRdfXml(uri)}"`;
	}
	return `<?xml version="1.0" encoding="utf-8" ?>\n<rdf:RDF${declarations}>\n${xml}\n</rdf:RDF>\n`;
}
