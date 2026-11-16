/**
 * Hand-built rdf record graphs for the FILE-WRITER gates (T1-4): the rdf
 * writer writes graphs (WriterSession.writeGraphs), never projected rows, so
 * its layout / durability / merge / resume gates need a graph per record. The
 * IRIs are test IRIs (example.test) — no installation's data is named; the
 * vocabulary is the nomisma + dc one the real published files use.
 */

import type { RdfElementPlan } from '../../src/diffusion/plan/types.ts';
import {
	plainLiteral,
	RdfGraph,
	type RdfRecordDocument,
} from '../../src/diffusion/resolve/rdf_graph_ir.ts';

export const TEST_NMO = 'http://nomisma.org/ontology#';
export const TEST_DC = 'http://purl.org/dc/terms/';

/** The compiled element an rdf plan carries (plan.rdf): nmo declared, dc from the initial table. */
export const TEST_RDF_ELEMENT: RdfElementPlan = {
	namespaces: [['nmo', TEST_NMO]],
	serviceType: 'test',
};

/** The subject IRI a test record gets. */
export function testRecordIri(sectionId: number | string): string {
	return `https://example.test/record/${sectionId}`;
}

/**
 * One record's document: an nmo:NumismaticObject subject with one dc:title
 * literal per `[value, lang]` pair (lang null = a plain literal), plus any
 * extra predicate → literal pairs (full IRIs).
 */
export function testRdfDocument(
	sectionId: number | string,
	titles: readonly (readonly [string, string | null])[],
	extra: readonly (readonly [string, string])[] = [],
): RdfRecordDocument {
	const graph = new RdfGraph();
	const subject = testRecordIri(sectionId);
	graph.resource(subject, `${TEST_NMO}NumismaticObject`);
	for (const [value, lang] of titles)
		graph.add(subject, `${TEST_DC}title`, plainLiteral(value, lang));
	for (const [predicate, value] of extra) graph.add(subject, predicate, plainLiteral(value, null));
	return { sectionId, graph };
}
