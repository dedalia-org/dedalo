/**
 * RDF/XML SERIALISER — the EasyRdf 1.19 port (writers/rdf_xml_serialiser.ts)
 * and the graph IR it reads (resolve/rdf_graph_ir.ts). T1-4 / O09.
 *
 * HERMETIC: no DB, no files. Every expected document is PINNED from a real
 * EasyRdf-published file, retargeted to test IRIs so no installation's data is
 * named here:
 *
 * - the frozen v7 PHP file `rdf/nomisma/nmonumismaticobject-…-1-….rdf`
 *   (a typed subject with plain/lang/datatype literals and an `rdf:resource`
 *   link, followed by an empty-bodied TYPED resource — EasyRdf's
 *   `void:inDataset` shape);
 * - the v5 `Coins_*.rdf` documents (a predicate whose object NESTS as
 *   `rdf:Description` with a blank line after it, `dcterms:` published as
 *   `dc:`, a second top-level subject that only points back with
 *   `rdf:resource`).
 *
 * RED on the pre-T1-4 tree: neither module existed (the old writer printed
 * `urn:dedalo:record:` subjects with one plain literal per column).
 */

import { describe, expect, test } from 'bun:test';
import {
	EASYRDF_INITIAL_NAMESPACES,
	plainLiteral,
	RdfGraph,
	RdfNamespaceTable,
	typedLiteral,
} from '../../src/diffusion/resolve/rdf_graph_ir.ts';
import { serialiseRdfXml } from '../../src/diffusion/writers/rdf_xml_serialiser.ts';

const NMO = 'http://nomisma.org/ontology#';
const DC = 'http://purl.org/dc/terms/';
const VOID = 'http://rdfs.org/ns/void#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RES = (uri: string) => ({ kind: 'resource' as const, uri });

describe('namespace table (RdfNamespace port)', () => {
	test('initial table is EasyRdf 1.19 verbatim: 54 prefixes, dc before dcterms', () => {
		expect(EASYRDF_INITIAL_NAMESPACES.length).toBe(54);
		const prefixes = EASYRDF_INITIAL_NAMESPACES.map(([prefix]) => prefix);
		expect(prefixes.indexOf('dc')).toBeLessThan(prefixes.indexOf('dcterms'));
	});

	test('expand: known prefix only, QName grammar only', () => {
		const table = new RdfNamespaceTable([['NMO', NMO]]);
		expect(table.expand('nmo:hasWeight')).toBe(`${NMO}hasWeight`);
		expect(table.expand('dcterms:title')).toBe(`${DC}title`);
		expect(table.expand('unknown:x')).toBeNull();
		expect(table.expand('nmo:has.weight')).toBeNull();
		expect(table.expand('plain')).toBeNull();
	});

	test('set: a declared prefix REPLACES in its slot; a new one is appended', () => {
		const table = new RdfNamespaceTable([
			['foaf', 'http://example.test/foaf/'],
			['ex', 'http://example.test/ex#'],
		]);
		expect(table.get('foaf')).toBe('http://example.test/foaf/');
		expect(table.shorten('http://example.test/ex#thing')).toEqual({ prefix: 'ex', local: 'thing' });
	});

	test('shorten: FIRST namespace with a slash/hash-free local part (dcterms → dc)', () => {
		const table = new RdfNamespaceTable();
		expect(table.shorten(`${DC}title`)).toEqual({ prefix: 'dc', local: 'title' });
		expect(table.shorten('http://example.test/nothing')).toBeNull();
	});
});

describe('typed literal lexical forms (Literal::create port)', () => {
	test('xsd:decimal canonicalises: 1 → 1.0, 0.830 → 0.83, -0.5 → -0.5', () => {
		expect(typedLiteral(1, 'double', `${XSD}decimal`)).toMatchObject({ value: '1.0' });
		expect(typedLiteral('0.830', 'string', `${XSD}decimal`)).toMatchObject({ value: '0.83' });
		expect(typedLiteral(-0.5, 'double', `${XSD}decimal`)).toMatchObject({ value: '-0.5' });
	});
	test('xsd:decimal refuses an unparseable value (Literal\\Decimal::validate)', () => {
		expect(() => typedLiteral('abc', 'string', `${XSD}decimal`)).toThrow(/valid decimal/);
	});
	test('integer → its string; a PHP double through the base Literal sprintf rule', () => {
		expect(typedLiteral(5, 'integer', `${XSD}integer`)).toMatchObject({ value: '5' });
		expect(typedLiteral(-25, 'integer', `${XSD}gYear`)).toMatchObject({ value: '-25' });
		expect(typedLiteral(5, 'double', `${XSD}double`)).toMatchObject({ value: '5.' });
		expect(typedLiteral(0.83, 'double', `${XSD}double`)).toMatchObject({ value: '0.83' });
	});
});

describe('graph IR (Graph port)', () => {
	test('an identical triple is added once (Graph::add dedup)', () => {
		const graph = new RdfGraph();
		expect(graph.add('s', 'p', plainLiteral('a', 'en'))).toBe(true);
		expect(graph.add('s', 'p', plainLiteral('a', 'en'))).toBe(false);
		expect(graph.add('s', 'p', plainLiteral('a', 'es'))).toBe(true);
		expect(graph.add('s', 'q', RES('o'))).toBe(true);
		expect(graph.add('s', 'q', RES('o'))).toBe(false);
		expect(graph.properties('s').get('p')?.length).toBe(2);
		expect(graph.reversePropertyCount('o')).toBe(1);
	});
	test('resources(): creation order, then index subjects, then objects', () => {
		const graph = new RdfGraph();
		graph.resource('b');
		graph.add('a', 'p', RES('c'));
		graph.resource('a');
		expect(graph.resources()).toEqual(['b', 'a', 'c']);
	});
});

describe('serialiseRdfXml == EasyRdf bytes (pinned real documents, test IRIs)', () => {
	test('frozen v7 coin document: typed subject + empty-bodied typed resource', () => {
		const table = new RdfNamespaceTable([
			['nmo', NMO],
			['void', VOID],
		]);
		const graph = new RdfGraph();
		const coin = 'https://example.test/coin/1';
		graph.resource(coin, `${NMO}NumismaticObject`);
		graph.add(coin, `${DC}title`, plainLiteral(', , /', 'es'));
		graph.add(coin, `${DC}identifier`, plainLiteral('1', null));
		graph.add(coin, `${NMO}hasTypeSeriesItem`, RES('https://example.test/type/2'));
		graph.add(coin, `${NMO}hasWeight`, typedLiteral(1, 'double', `${XSD}decimal`));
		graph.resource('http://example.test/id/dataset', `${VOID}inDataset`);
		expect(serialiseRdfXml(graph, table)).toBe(
			'<?xml version="1.0" encoding="utf-8" ?>\n' +
				'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n' +
				'         xmlns:nmo="http://nomisma.org/ontology#"\n' +
				'         xmlns:dc="http://purl.org/dc/terms/"\n' +
				'         xmlns:void="http://rdfs.org/ns/void#">\n' +
				'\n' +
				'  <nmo:NumismaticObject rdf:about="https://example.test/coin/1">\n' +
				'    <dc:title xml:lang="es">, , /</dc:title>\n' +
				'    <dc:identifier>1</dc:identifier>\n' +
				'    <nmo:hasTypeSeriesItem rdf:resource="https://example.test/type/2"/>\n' +
				'    <nmo:hasWeight rdf:datatype="http://www.w3.org/2001/XMLSchema#decimal">1.0</nmo:hasWeight>\n' +
				'  </nmo:NumismaticObject>\n' +
				'\n' +
				'  <void:inDataset rdf:about="http://example.test/id/dataset">\n' +
				'  </void:inDataset>\n' +
				'\n' +
				'</rdf:RDF>\n',
		);
	});

	test('v5 type document: nested portal Description, resource links, back-link subject', () => {
		const table = new RdfNamespaceTable([['nmo', NMO]]);
		const graph = new RdfGraph();
		const type = 'https://example.test/type/1';
		const obverse = `${type}#obverse`;
		graph.resource(type, `${NMO}TypeSeriesItem`);
		graph.add(type, 'http://www.w3.org/2004/02/skos/core#prefLabel', plainLiteral('T & <1>', 'en'));
		graph.add(type, 'http://www.w3.org/2004/02/skos/core#prefLabel', plainLiteral('T "1"', 'es'));
		graph.add(type, `${NMO}representsObjectType`, RES('http://example.test/id/coin'));
		graph.add(type, `${NMO}hasStartDate`, typedLiteral(-25, 'integer', `${XSD}gYear`));
		graph.resource(obverse);
		graph.add(obverse, `${DC}description`, plainLiteral('Head, left', 'en'));
		graph.add(type, `${NMO}hasObverse`, RES(obverse));
		const reverse = `${type}#reverse`;
		graph.resource(reverse); // never gains a triple → never published, never linked
		const coin = 'https://example.test/coin/1';
		graph.resource(coin, `${NMO}NumismaticObject`);
		graph.add(coin, `${NMO}hasTypeSeriesItem`, RES(type));
		expect(serialiseRdfXml(graph, table)).toBe(
			'<?xml version="1.0" encoding="utf-8" ?>\n' +
				'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n' +
				'         xmlns:nmo="http://nomisma.org/ontology#"\n' +
				'         xmlns:skos="http://www.w3.org/2004/02/skos/core#"\n' +
				'         xmlns:dc="http://purl.org/dc/terms/">\n' +
				'\n' +
				'  <nmo:TypeSeriesItem rdf:about="https://example.test/type/1">\n' +
				'    <skos:prefLabel xml:lang="en">T &amp; &lt;1&gt;</skos:prefLabel>\n' +
				'    <skos:prefLabel xml:lang="es">T &quot;1&quot;</skos:prefLabel>\n' +
				'    <nmo:representsObjectType rdf:resource="http://example.test/id/coin"/>\n' +
				'    <nmo:hasStartDate rdf:datatype="http://www.w3.org/2001/XMLSchema#gYear">-25</nmo:hasStartDate>\n' +
				'    <nmo:hasObverse>\n' +
				'      <rdf:Description rdf:about="https://example.test/type/1#obverse">\n' +
				'        <dc:description xml:lang="en">Head, left</dc:description>\n' +
				'      </rdf:Description>\n' +
				'    </nmo:hasObverse>\n' +
				'\n' +
				'  </nmo:TypeSeriesItem>\n' +
				'\n' +
				'  <nmo:NumismaticObject rdf:about="https://example.test/coin/1">\n' +
				'    <nmo:hasTypeSeriesItem rdf:resource="https://example.test/type/1"/>\n' +
				'  </nmo:NumismaticObject>\n' +
				'\n' +
				'</rdf:RDF>\n',
		);
	});

	test('a resource pointed at twice is never nested (rdf:resource both times)', () => {
		const table = new RdfNamespaceTable([['nmo', NMO]]);
		const graph = new RdfGraph();
		graph.resource('https://example.test/a', `${NMO}TypeSeriesItem`);
		graph.add('https://example.test/a', `${NMO}hasObverse`, RES('https://example.test/s'));
		graph.add('https://example.test/a', `${NMO}hasReverse`, RES('https://example.test/s'));
		graph.add('https://example.test/s', `${DC}description`, plainLiteral('shared', null));
		const xml = serialiseRdfXml(graph, table);
		expect(xml).toContain('<nmo:hasObverse rdf:resource="https://example.test/s"/>');
		expect(xml).toContain('<nmo:hasReverse rdf:resource="https://example.test/s"/>');
		expect(xml).toContain('  <rdf:Description rdf:about="https://example.test/s">');
	});
});
