/**
 * Gate: the tool_import_rdf MAPPING PLAN (tools/tool_import_rdf/server/rdf_import_plan.ts).
 * An RDF graph read through an external ontology becomes an exact, ordered op list.
 *
 * The ontology is the live "Nomisma import" subtree's SHAPE (owl:Class children with
 * a target section and a `match` component; owl:ObjectProperty children, nested for a
 * sub-resource, with process date/split/data_map/geo or a ddo_map intermediate),
 * rebuilt on the scratch `zzrdf` TLD. The pure tests read it through an in-memory
 * reader. The last describe materializes the SAME nodes as a situation on the suite
 * database and proves the production reader loads an identical snapshot (then tears
 * it down to zero residue). The coin type is test/fixtures/rdf/ocre_type.rdf. The
 * linked mint and person are inline documents.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { parseRdfGraph } from '../../src/core/tools/rdf_graph.ts';
import {
	dataMapValue,
	emittedKeys,
	engineRdfOntologyReader,
	engineRdfPlanLangs,
	loadRdfImportOntology,
	parseRdfDate,
	planRdfImport,
	planRdfResource,
	RDF_PLAN_MAX_DEPTH,
	type RdfImportOntology,
	type RdfImportOp,
	type RdfOntologyReader,
	type RdfPlanLangs,
	type RdfReaderNode,
	type RdfSkipReason,
	type RecordRef,
} from '../../tools/tool_import_rdf/server/rdf_import_plan.ts';

// ---------------------------------------------------------------------------
// The ontology fixture (shape of the live Nomisma import subtree)
// ---------------------------------------------------------------------------

const ROOT = 'zzrdf1';

// sections
const S_TYPE = 'zzrdf200';
const S_SERIES = 'zzrdf210';
const S_OBJTYPE = 'zzrdf220';
const S_TECHNIQUE = 'zzrdf230';
const S_MATERIAL = 'zzrdf240';
const S_DENOM = 'zzrdf250';
const S_PERSON = 'zzrdf260';
const S_ROLE = 'zzrdf270';
const S_MEMB = 'zzrdf280';
const S_MINT = 'zzrdf290';
const S_LEGEND = 'zzrdf300';
const S_DESIGN = 'zzrdf310';
const S_PEOPLE_REF = 'zzrdf320';

// components
const C_TYPE_URI = 'zzrdf201';
const C_TITLE = 'zzrdf202';
const C_DEFINITION = 'zzrdf203';
const C_OBJTYPE = 'zzrdf204';
const C_NUMBER = 'zzrdf205';
const C_SERIES = 'zzrdf206';
const C_MANUF = 'zzrdf207';
const C_DENOM = 'zzrdf208';
const C_MATERIAL = 'zzrdf209';
const C_SERIES_NAME = 'zzrdf211';
const C_CREATORS = 'zzrdf212';
const C_MINT = 'zzrdf213';
const C_DATE = 'zzrdf214';
const C_OBV_LEGEND = 'zzrdf215';
const C_OBV_DESIGN = 'zzrdf216';
const C_REV_LEGEND = 'zzrdf217';
const C_REV_DESIGN = 'zzrdf218';
const C_TS_URI = 'zzrdf221';
const C_TS_TERM = 'zzrdf222';
const C_TS_DEF = 'zzrdf223';
const C_DENOM_URI = 'zzrdf251';
const C_DENOM_NAME = 'zzrdf252';
const C_DENOM_DEF = 'zzrdf253';
const C_PERSON_URI = 'zzrdf261';
const C_PERSON_NAME = 'zzrdf262';
const C_BIRTH = 'zzrdf263';
const C_MEMBERSHIPS = 'zzrdf264';
const C_DEATH = 'zzrdf265';
const C_MEMB_KEY = 'zzrdf281';
const C_MEMB_ROLE = 'zzrdf282';
const C_MEMB_DATE = 'zzrdf283';
const C_MINT_URI = 'zzrdf291';
const C_MINT_NAME = 'zzrdf292';
const C_MINT_GEOTAG = 'zzrdf293';
const C_MINT_MAP = 'zzrdf294';
const C_LEGEND = 'zzrdf301';
const C_DESIGN = 'zzrdf311';
const C_PERSON_REF = 'zzrdf321';

// classes
const K_TYPE = 'zzrdf101';
const K_SERIES = 'zzrdf102';
const K_OBJTYPE = 'zzrdf103';
const K_MANUF = 'zzrdf104';
const K_DENOM = 'zzrdf105';
const K_MATERIAL = 'zzrdf106';
const K_PERSON = 'zzrdf107';
const K_ROLE = 'zzrdf108';
const K_MEMB = 'zzrdf109';
const K_MINT = 'zzrdf110';
const K_LEGEND = 'zzrdf111';
const K_DESIGN = 'zzrdf112';

/** The live map's prefixes, its mistyped `foaf` namespace and its missing `org` included. */
const XMLNS = {
	nm: 'http://nomisma.org/id/',
	nmo: 'http://nomisma.org/ontology#',
	bio: 'http://purl.org/vocab/bio/0.1/',
	geo: 'http://www.w3.org/2003/01/geo/wgs84_pos#',
	rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
	xsd: 'http://www.w3.org/2001/XMLSchema#',
	foaf: 'http://com/foaf/0.1/',
	rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
	skos: 'http://www.w3.org/2004/02/skos/core#',
	void: 'http://rdfs.org/ns/void#',
	dcterms: 'http://purl.org/dc/terms/',
};

const SERIES_MAP = {
	'rrc-': 'RRC',
	'ric.1.': 'RIC I',
	'ric.10.': 'RIC X',
	'ric.1(2).': 'RIC I (second edition)',
	'ric.2(2).': 'RIC II (second edition)',
};

const DATE_FORMAT = {
	'xsd:date': 'YYYY-MM-DD',
	'xsd:gDay': 'day',
	'xsd:gYear': 'year',
	'xsd:gMonth': 'month',
};

const CREATORS_PATH = [
	{
		name: 'creators',
		model: 'component_portal',
		parent: S_TYPE,
		section_tipo: S_TYPE,
		component_tipo: C_CREATORS,
	},
	{
		name: 'person',
		model: 'component_portal',
		parent: C_CREATORS,
		section_tipo: S_PEOPLE_REF,
		component_tipo: C_PERSON_REF,
	},
	{
		name: 'URI',
		model: 'component_iri',
		parent: C_PERSON_REF,
		section_tipo: S_PERSON,
		component_tipo: C_PERSON_URI,
	},
];

interface FixtureNode {
	tipo: string;
	parent: string | null;
	model: string;
	term: string;
	translatable?: boolean;
	properties?: Record<string, unknown>;
	related?: string[];
}

const section = (tipo: string): FixtureNode => ({
	tipo,
	parent: null,
	model: 'section',
	term: tipo,
});
const comp = (tipo: string, parent: string, model: string, translatable = false): FixtureNode => ({
	tipo,
	parent,
	model: `component_${model}`,
	term: tipo,
	translatable,
});
const cls = (
	tipo: string,
	term: string,
	sectionTipo: string,
	match: string,
	extra: Record<string, unknown> = {},
): FixtureNode => ({
	tipo,
	parent: ROOT,
	model: 'owl:Class',
	term,
	translatable: true,
	properties: { match, ...extra },
	related: [sectionTipo],
});
const prop = (
	tipo: string,
	parent: string,
	term: string,
	related: string[] = [],
	properties?: Record<string, unknown>,
): FixtureNode => ({
	tipo,
	parent,
	model: 'owl:ObjectProperty',
	term,
	translatable: true,
	related,
	...(properties === undefined ? {} : { properties }),
});

const NODES: FixtureNode[] = [
	{
		tipo: ROOT,
		parent: null,
		model: 'external_ontology',
		term: 'Nomisma import',
		properties: { xmlns: XMLNS },
	},
	...[
		S_TYPE,
		S_SERIES,
		S_OBJTYPE,
		S_TECHNIQUE,
		S_MATERIAL,
		S_DENOM,
		S_PERSON,
		S_ROLE,
		S_MEMB,
		S_MINT,
		S_LEGEND,
		S_DESIGN,
		S_PEOPLE_REF,
	].map(section),
	comp(C_TYPE_URI, S_TYPE, 'iri'),
	comp(C_TITLE, S_TYPE, 'input_text', true),
	comp(C_DEFINITION, S_TYPE, 'text_area', true),
	comp(C_OBJTYPE, S_TYPE, 'autocomplete_hi'),
	comp(C_NUMBER, S_TYPE, 'input_text'),
	comp(C_SERIES, S_TYPE, 'select'),
	comp(C_MANUF, S_TYPE, 'autocomplete_hi'),
	comp(C_DENOM, S_TYPE, 'autocomplete'),
	comp(C_MATERIAL, S_TYPE, 'autocomplete'),
	comp(C_CREATORS, S_TYPE, 'portal'),
	comp(C_MINT, S_TYPE, 'autocomplete'),
	comp(C_DATE, S_TYPE, 'date'),
	comp(C_OBV_LEGEND, S_TYPE, 'autocomplete'),
	comp(C_OBV_DESIGN, S_TYPE, 'autocomplete'),
	comp(C_REV_LEGEND, S_TYPE, 'autocomplete'),
	comp(C_REV_DESIGN, S_TYPE, 'autocomplete'),
	comp(C_SERIES_NAME, S_SERIES, 'input_text', true),
	comp(C_TS_URI, S_OBJTYPE, 'iri'),
	comp(C_TS_TERM, S_OBJTYPE, 'input_text', true),
	comp(C_TS_DEF, S_OBJTYPE, 'text_area', true),
	comp(C_DENOM_URI, S_DENOM, 'iri'),
	comp(C_DENOM_NAME, S_DENOM, 'input_text', true),
	comp(C_DENOM_DEF, S_DENOM, 'input_text', true),
	comp(C_PERSON_URI, S_PERSON, 'iri'),
	comp(C_PERSON_NAME, S_PERSON, 'input_text'),
	comp(C_BIRTH, S_PERSON, 'date'),
	comp(C_MEMBERSHIPS, S_PERSON, 'portal'),
	comp(C_DEATH, S_PERSON, 'date'),
	comp(C_MEMB_KEY, S_MEMB, 'iri'),
	comp(C_MEMB_ROLE, S_MEMB, 'autocomplete_hi'),
	comp(C_MEMB_DATE, S_MEMB, 'date'),
	comp(C_MINT_URI, S_MINT, 'iri'),
	comp(C_MINT_NAME, S_MINT, 'input_text', true),
	comp(C_MINT_GEOTAG, S_MINT, 'text_area', true),
	comp(C_MINT_MAP, S_MINT, 'geolocation'),
	comp(C_LEGEND, S_LEGEND, 'text_area'),
	comp(C_DESIGN, S_DESIGN, 'text_area', true),
	comp(C_PERSON_REF, S_PEOPLE_REF, 'autocomplete'),
	cls(K_TYPE, 'nmo:TypeSeriesItem', S_TYPE, C_TYPE_URI),
	cls(K_SERIES, 'nmo:TypeSeries', S_SERIES, C_SERIES_NAME, {
		process: { source: '$base_uri', data_map: SERIES_MAP },
	}),
	cls(K_OBJTYPE, 'nmo:ObjectType', S_OBJTYPE, C_TS_URI),
	cls(K_MANUF, 'nmo:Manufacture', S_TECHNIQUE, C_TS_URI),
	cls(K_DENOM, 'nmo:Denomination', S_DENOM, C_DENOM_URI),
	cls(K_MATERIAL, 'nmo:Material', S_MATERIAL, C_TS_URI),
	cls(K_PERSON, 'foaf:Person', S_PERSON, C_PERSON_URI),
	cls(K_ROLE, 'org:Role', S_ROLE, C_TS_URI),
	cls(K_MEMB, 'org:Membership', S_MEMB, C_MEMB_KEY),
	cls(K_MINT, 'nmo:Mint', S_MINT, C_MINT_URI),
	cls(K_LEGEND, 'Legend', S_LEGEND, C_LEGEND),
	cls(K_DESIGN, 'Design', S_DESIGN, C_DESIGN),
	// nmo:TypeSeriesItem
	prop('zzrdf401', K_TYPE, 'skos:prefLabel', [C_TITLE]),
	prop('zzrdf402', K_TYPE, 'skos:definition', [C_DEFINITION]),
	prop('zzrdf403', K_TYPE, 'nmo:representsObjectType', [C_OBJTYPE, K_OBJTYPE]),
	prop('zzrdf404', K_TYPE, 'Number', [C_NUMBER], {
		process: {
			split: { get: 'end', source: '$base_uri', split_by: '.', property_name: 'skos:prefLabel' },
		},
	}),
	prop('zzrdf405', K_TYPE, 'dcterms:source', [C_SERIES, K_SERIES], {
		process: { source: '$base_uri', data_map: SERIES_MAP },
	}),
	prop('zzrdf406', K_TYPE, 'nmo:hasManufacture', [C_MANUF, K_MANUF]),
	prop('zzrdf407', K_TYPE, 'nmo:hasDenomination', [C_DENOM, K_DENOM]),
	prop('zzrdf408', K_TYPE, 'nmo:hasMaterial', [C_MATERIAL, K_MATERIAL]),
	prop('zzrdf409', K_TYPE, 'nmo:hasAuthority', [C_CREATORS], { ddo_map: CREATORS_PATH }),
	prop('zzrdf440', 'zzrdf409', 'nmo:hasAuthority', [C_PERSON_REF, K_PERSON]),
	prop('zzrdf410', K_TYPE, 'nmo:hasIssuer', [C_CREATORS], { ddo_map: CREATORS_PATH }),
	prop('zzrdf441', 'zzrdf410', 'nmo:hasIssuer', [C_PERSON_REF, K_PERSON]),
	prop('zzrdf411', K_TYPE, 'nmo:hasMint', [C_MINT, K_MINT]),
	prop('zzrdf412', K_TYPE, 'Date', [C_DATE], {
		process: { date: { end: 'nmo:hasEndDate', start: 'nmo:hasStartDate', format: DATE_FORMAT } },
	}),
	prop('zzrdf413', K_TYPE, 'nmo:hasObverse'),
	prop('zzrdf442', 'zzrdf413', 'nmo:hasLegend', [C_OBV_LEGEND, K_LEGEND]),
	prop('zzrdf443', 'zzrdf413', 'dcterms:description', [C_OBV_DESIGN, K_DESIGN]),
	prop('zzrdf414', K_TYPE, 'nmo:hasReverse'),
	prop('zzrdf444', 'zzrdf414', 'nmo:hasLegend', [C_REV_LEGEND, K_LEGEND]),
	prop('zzrdf445', 'zzrdf414', 'dcterms:description', [C_REV_DESIGN, K_DESIGN]),
	// thesaurus classes
	prop('zzrdf420', K_OBJTYPE, 'skos:prefLabel', [C_TS_TERM]),
	prop('zzrdf421', K_OBJTYPE, 'skos:definition', [C_TS_DEF]),
	prop('zzrdf422', K_OBJTYPE, 'skos:exactMatch', [C_TS_URI]),
	prop('zzrdf423', K_MANUF, 'skos:prefLabel', [C_TS_TERM]),
	prop('zzrdf426', K_MATERIAL, 'skos:prefLabel', [C_TS_TERM]),
	prop('zzrdf429', K_DENOM, 'skos:prefLabel', [C_DENOM_NAME]),
	prop('zzrdf430', K_DENOM, 'skos:definition', [C_DENOM_DEF]),
	prop('zzrdf431', K_DENOM, 'skos:exactMatch', [C_DENOM_URI]),
	// foaf:Person
	prop('zzrdf432', K_PERSON, 'skos:prefLabel', [C_PERSON_NAME]),
	prop('zzrdf433', K_PERSON, 'skos:exactMatch', [C_PERSON_URI]),
	prop('zzrdf434', K_PERSON, 'bio:Birth'),
	prop('zzrdf446', 'zzrdf434', 'Date', [C_BIRTH], {
		process: { date: { start: 'dcterms:date', format: DATE_FORMAT } },
	}),
	prop('zzrdf435', K_PERSON, 'bio:Death'),
	prop('zzrdf447', 'zzrdf435', 'Date', [C_DEATH], {
		process: { date: { start: 'dcterms:date', format: DATE_FORMAT } },
	}),
	prop('zzrdf436', K_PERSON, 'org:hasMembership', [C_MEMBERSHIPS, K_MEMB]),
	// org:Membership, org:Role
	prop('zzrdf437', K_MEMB, 'org:role', [C_MEMB_ROLE, K_ROLE]),
	prop('zzrdf438', K_MEMB, 'Date', [C_MEMB_DATE], {
		process: { date: { end: 'nmo:hasEndDate', start: 'nmo:hasStartDate', format: DATE_FORMAT } },
	}),
	prop('zzrdf439', K_ROLE, 'skos:prefLabel', [C_TS_TERM]),
	// nmo:Mint
	prop('zzrdf450', K_MINT, 'skos:prefLabel', [C_MINT_NAME]),
	prop('zzrdf451', K_MINT, 'geo:location'),
	prop('zzrdf452', 'zzrdf451', 'Geo tag', [C_MINT_GEOTAG], {
		process: { geo_tag: { lat: 'geo:lat', long: 'geo:long', format: {} } },
	}),
	prop('zzrdf453', 'zzrdf451', 'Geo map', [C_MINT_MAP], {
		process: { geo_map: { lat: 'geo:lat', long: 'geo:long', format: {} } },
	}),
	prop('zzrdf454', K_MINT, 'skos:closeMatch', [C_MINT_URI]),
];

const HTML_MODELS = new Set(['component_text_area']);
/** The models whose matrix column is `number` (as `getColumnNameByModel` answers). */
const NUMBER_MODELS = new Set(['component_number']);
/** The legacy models the engine reports as their runtime model (as `getModelByTipo` does). */
const RUNTIME_MODEL: Record<string, string> = {
	component_autocomplete: 'component_portal',
	component_autocomplete_hi: 'component_portal',
};

/** The fixture read the way `engineRdfOntologyReader` reads dd_ontology. */
function memoryReader(nodes: readonly FixtureNode[]): RdfOntologyReader {
	const byTipo = new Map(nodes.map((node) => [node.tipo, node]));
	return {
		properties: async (tipo) => byTipo.get(tipo)?.properties ?? null,
		children: async (tipo) =>
			nodes
				.filter((node) => node.parent === tipo)
				.map((node) => ({
					tipo: node.tipo,
					model: node.model,
					term: { 'lg-spa': node.term },
					properties: node.properties ?? null,
					relations: (node.related ?? []).map((related) => ({ tipo: related })),
				})),
		tipoInfo: async (tipo) => {
			const node = byTipo.get(tipo);
			const model = node?.model ?? null;
			return {
				model: model === null ? null : (RUNTIME_MODEL[model] ?? model),
				translatable: node?.translatable ?? false,
				html: HTML_MODELS.has(node?.model ?? ''),
				number: NUMBER_MODELS.has(node?.model ?? ''),
			};
		},
	};
}

const LANGS: RdfPlanLangs = {
	data: [
		{ code: 'lg-spa', alpha2: 'es' },
		{ code: 'lg-eng', alpha2: 'en' },
		{ code: 'lg-deu', alpha2: 'de' },
	],
	current: 'lg-spa',
};

const ONT: RdfImportOntology = await loadRdfImportOntology(ROOT, memoryReader(NODES));

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const TYPE_IRI = 'http://numismatics.org/ocre/id/ric.1(2).aug.1A';
const OCRE = await Bun.file(new URL('../fixtures/rdf/ocre_type.rdf', import.meta.url)).text();
const NM = 'http://nomisma.org/id/';

const RDF_OPEN =
	'<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" ' +
	'xmlns:skos="http://www.w3.org/2004/02/skos/core#" xmlns:nmo="http://nomisma.org/ontology#" ' +
	'xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:dcterms="http://purl.org/dc/terms/" ' +
	'xmlns:foaf="http://xmlns.com/foaf/0.1/" xmlns:bio="http://purl.org/vocab/bio/0.1/" ' +
	'xmlns:org="http://www.w3.org/ns/org#">';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

function rdf(body: string): string {
	return `${RDF_OPEN}${body}</rdf:RDF>`;
}

/** nomisma.org/id/emerita, as the mint document answers: labels, a located spatial thing. */
const MINT_RDF = rdf(`
	<nmo:Mint rdf:about="${NM}emerita">
		<skos:prefLabel xml:lang="en">Emerita Augusta</skos:prefLabel>
		<skos:prefLabel xml:lang="es">Emérita Augusta</skos:prefLabel>
		<skos:closeMatch rdf:resource="http://www.wikidata.org/entity/Q5734"/>
		<geo:location rdf:resource="${NM}emerita#this"/>
	</nmo:Mint>
	<geo:SpatialThing rdf:about="${NM}emerita#this">
		<geo:lat rdf:datatype="${XSD}decimal">38.916</geo:lat>
		<geo:long rdf:datatype="${XSD}decimal">-6.343</geo:long>
	</geo:SpatialThing>`);

/** nomisma.org/id/augustus: a person with a birth date and two memberships (one anonymous). */
const PERSON_RDF = rdf(`
	<foaf:Person rdf:about="${NM}augustus">
		<skos:prefLabel xml:lang="en">Augustus</skos:prefLabel>
		<skos:prefLabel xml:lang="de">Augustus</skos:prefLabel>
		<skos:prefLabel xml:lang="es">Augusto</skos:prefLabel>
		<skos:exactMatch rdf:resource="http://viaf.org/viaf/1"/>
		<bio:Birth rdf:resource="${NM}augustus#birth"/>
		<org:hasMembership rdf:resource="${NM}augustus#emperor"/>
		<org:hasMembership><org:Membership><org:role rdf:resource="${NM}pontifex"/></org:Membership></org:hasMembership>
	</foaf:Person>
	<bio:Birth rdf:about="${NM}augustus#birth">
		<dcterms:date rdf:datatype="${XSD}gYear">-0062</dcterms:date>
	</bio:Birth>
	<org:Membership rdf:about="${NM}augustus#emperor">
		<org:role rdf:resource="${NM}emperor"/>
		<nmo:hasStartDate rdf:datatype="${XSD}gYear">-0027</nmo:hasStartDate>
		<nmo:hasEndDate rdf:datatype="${XSD}gYear">0014</nmo:hasEndDate>
	</org:Membership>`);

// ---------------------------------------------------------------------------
// Expected-op builders
// ---------------------------------------------------------------------------

const CALLER: RecordRef = { kind: 'caller' };
const ref = (key: string): RecordRef => ({ kind: 'found_or_created', key });

function setOp(
	from: [ontology: string, predicate: string],
	target: RecordRef,
	at: [section: string, component: string, model: string],
	lang: string,
	value: Record<string, unknown>[],
): RdfImportOp {
	return {
		op: 'set',
		ontology_tipo: from[0],
		rdf_predicate: from[1],
		target,
		section_tipo: at[0],
		component_tipo: at[1],
		model: at[2],
		lang,
		value,
	};
}

function linkOp(
	from: [ontology: string, predicate: string],
	target: RecordRef,
	at: [section: string, component: string, model: string],
	key: string,
	toSection: string,
): RdfImportOp {
	return {
		op: 'link',
		ontology_tipo: from[0],
		rdf_predicate: from[1],
		target,
		section_tipo: at[0],
		component_tipo: at[1],
		model: at[2],
		to: ref(key),
		to_section_tipo: toSection,
	};
}

function findOp(
	from: [ontology: string, predicate: string],
	key: string,
	cls: [classTipo: string, section: string, match: string, model: string],
	lang: string,
	value: string,
	item: Record<string, unknown>,
	fetch: string | null,
): RdfImportOp {
	return {
		op: 'find_or_create',
		ontology_tipo: from[0],
		rdf_predicate: from[1],
		key,
		class_tipo: cls[0],
		section_tipo: cls[1],
		match_component_tipo: cls[2],
		match_model: cls[3],
		match_lang: lang,
		match_value: value,
		match_item: item,
		needs_fetch_iri: fetch,
	};
}

/** A thesaurus term matched by its IRI, its labels still to be fetched. */
function termByIri(
	from: [string, string],
	cls: [classTipo: string, section: string, match: string],
	iri: string,
): RdfImportOp {
	const key = `${cls[1]}|${cls[2]}|${iri}`;
	return findOp(
		from,
		key,
		[...cls, 'component_iri'],
		'lg-nolan',
		iri,
		{ iri, lang: 'lg-nolan' },
		iri,
	);
}

const keyOf = (section: string, match: string, value: string): string =>
	`${section}|${match}|${value}`;

function ocrePlan() {
	const graph = parseRdfGraph(OCRE, { baseIri: TYPE_IRI });
	return planRdfImport(ONT, graph, { subject: TYPE_IRI, langs: LANGS });
}

// ---------------------------------------------------------------------------
// The OCRE coin type
// ---------------------------------------------------------------------------

describe('rdf_import_plan — the OCRE coin type into the caller record', () => {
	const plan = ocrePlan();
	const obverse = `${TYPE_IRI}#obverse`;
	const at = (component: string, model: string): [string, string, string] => [
		S_TYPE,
		component,
		model,
	];
	const intAug = `intermediate|caller|${C_CREATORS}|${NM}augustus`;
	const intCar = `intermediate|caller|${C_CREATORS}|${NM}p_carisius`;
	const personAt = (key: string) => [
		termByIri(['zzrdf440', 'nmo:hasAuthority'], [K_PERSON, S_PERSON, C_PERSON_URI], `${NM}${key}`),
	];

	test('the rdf:type selects the class and its section', () => {
		expect(plan.subject).toBe(TYPE_IRI);
		expect(plan.class_tipo).toBe(K_TYPE);
		expect(plan.section_tipo).toBe(S_TYPE);
		expect(obverse).toBe('http://numismatics.org/ocre/id/ric.1(2).aug.1A#obverse');
	});

	test('the exact op list', () => {
		const descKey = keyOf(S_DESIGN, C_DESIGN, 'Cabeza desnuda de Augusto a derecha');
		const reverseDescKey = keyOf(S_DESIGN, C_DESIGN, 'Victory standing right, crowning trophy');
		const expected: RdfImportOp[] = [
			// skos:prefLabel: one op per installed language, in the install's order
			setOp(['zzrdf401', 'skos:prefLabel'], CALLER, at(C_TITLE, 'component_input_text'), 'lg-spa', [
				{ lang: 'lg-spa', value: 'RIC I (segunda edición) Augusto 1A' },
			]),
			setOp(['zzrdf401', 'skos:prefLabel'], CALLER, at(C_TITLE, 'component_input_text'), 'lg-eng', [
				{ lang: 'lg-eng', value: 'RIC I (second edition) Augustus 1A' },
			]),
			setOp(['zzrdf401', 'skos:prefLabel'], CALLER, at(C_TITLE, 'component_input_text'), 'lg-deu', [
				{ lang: 'lg-deu', value: 'RIC I (zweite Auflage) Augustus 1A' },
			]),
			// skos:definition (English only) into a markup component: escaped + wrapped
			setOp(
				['zzrdf402', 'skos:definition'],
				CALLER,
				at(C_DEFINITION, 'component_text_area'),
				'lg-eng',
				[{ lang: 'lg-eng', value: '<p>RIC I (second edition) Augustus 1A</p>' }],
			),
			// object type: matched by IRI, labels to fetch, then linked
			termByIri(
				['zzrdf403', 'nmo:representsObjectType'],
				[K_OBJTYPE, S_OBJTYPE, C_TS_URI],
				`${NM}coin`,
			),
			linkOp(
				['zzrdf403', 'nmo:representsObjectType'],
				CALLER,
				at(C_OBJTYPE, 'component_portal'),
				keyOf(S_OBJTYPE, C_TS_URI, `${NM}coin`),
				S_OBJTYPE,
			),
			// Number: the last '.' part of the subject IRI, driven by skos:prefLabel
			setOp(
				['zzrdf404', 'skos:prefLabel'],
				CALLER,
				at(C_NUMBER, 'component_input_text'),
				'lg-nolan',
				[{ lang: 'lg-nolan', value: '1A' }],
			),
			// dcterms:source: the catalogue named by the data_map, nothing to fetch
			findOp(
				['zzrdf405', 'dcterms:source'],
				keyOf(S_SERIES, C_SERIES_NAME, 'RIC I (second edition)'),
				[K_SERIES, S_SERIES, C_SERIES_NAME, 'component_input_text'],
				'lg-spa',
				'RIC I (second edition)',
				{ lang: 'lg-spa', value: 'RIC I (second edition)' },
				null,
			),
			linkOp(
				['zzrdf405', 'dcterms:source'],
				CALLER,
				at(C_SERIES, 'component_select'),
				keyOf(S_SERIES, C_SERIES_NAME, 'RIC I (second edition)'),
				S_SERIES,
			),
			termByIri(
				['zzrdf406', 'nmo:hasManufacture'],
				[K_MANUF, S_TECHNIQUE, C_TS_URI],
				`${NM}struck`,
			),
			linkOp(
				['zzrdf406', 'nmo:hasManufacture'],
				CALLER,
				at(C_MANUF, 'component_portal'),
				keyOf(S_TECHNIQUE, C_TS_URI, `${NM}struck`),
				S_TECHNIQUE,
			),
			termByIri(
				['zzrdf407', 'nmo:hasDenomination'],
				[K_DENOM, S_DENOM, C_DENOM_URI],
				`${NM}quinarius`,
			),
			linkOp(
				['zzrdf407', 'nmo:hasDenomination'],
				CALLER,
				at(C_DENOM, 'component_portal'),
				keyOf(S_DENOM, C_DENOM_URI, `${NM}quinarius`),
				S_DENOM,
			),
			termByIri(['zzrdf408', 'nmo:hasMaterial'], [K_MATERIAL, S_MATERIAL, C_TS_URI], `${NM}ar`),
			linkOp(
				['zzrdf408', 'nmo:hasMaterial'],
				CALLER,
				at(C_MATERIAL, 'component_portal'),
				keyOf(S_MATERIAL, C_TS_URI, `${NM}ar`),
				S_MATERIAL,
			),
			// creators → person → URI: the intermediate, then the person linked FROM it
			{
				op: 'intermediate',
				ontology_tipo: 'zzrdf409',
				rdf_predicate: 'nmo:hasAuthority',
				key: intAug,
				target: CALLER,
				section_tipo: S_TYPE,
				component_tipo: C_CREATORS,
				model: 'component_portal',
				intermediate_section_tipo: S_PEOPLE_REF,
				match_value: `${NM}augustus`,
				path: CREATORS_PATH,
			},
			...personAt('augustus'),
			linkOp(
				['zzrdf440', 'nmo:hasAuthority'],
				ref(intAug),
				[S_PEOPLE_REF, C_PERSON_REF, 'component_portal'],
				keyOf(S_PERSON, C_PERSON_URI, `${NM}augustus`),
				S_PERSON,
			),
			{
				op: 'intermediate',
				ontology_tipo: 'zzrdf410',
				rdf_predicate: 'nmo:hasIssuer',
				key: intCar,
				target: CALLER,
				section_tipo: S_TYPE,
				component_tipo: C_CREATORS,
				model: 'component_portal',
				intermediate_section_tipo: S_PEOPLE_REF,
				match_value: `${NM}p_carisius`,
				path: CREATORS_PATH,
			},
			termByIri(
				['zzrdf441', 'nmo:hasIssuer'],
				[K_PERSON, S_PERSON, C_PERSON_URI],
				`${NM}p_carisius`,
			),
			linkOp(
				['zzrdf441', 'nmo:hasIssuer'],
				ref(intCar),
				[S_PEOPLE_REF, C_PERSON_REF, 'component_portal'],
				keyOf(S_PERSON, C_PERSON_URI, `${NM}p_carisius`),
				S_PERSON,
			),
			termByIri(['zzrdf411', 'nmo:hasMint'], [K_MINT, S_MINT, C_MINT_URI], `${NM}emerita`),
			linkOp(
				['zzrdf411', 'nmo:hasMint'],
				CALLER,
				at(C_MINT, 'component_portal'),
				keyOf(S_MINT, C_MINT_URI, `${NM}emerita`),
				S_MINT,
			),
			// Date: xsd:gYear '-0025' / '-0023' → years -25 / -23, untranslatable
			setOp(['zzrdf412', 'nmo:hasStartDate'], CALLER, at(C_DATE, 'component_date'), 'lg-nolan', [
				{ start: { year: -25 }, end: { year: -23 } },
			]),
			// obverse (a NESTED node): legend (untagged) and description (en + es)
			findOp(
				['zzrdf442', 'nmo:hasLegend'],
				keyOf(S_LEGEND, C_LEGEND, 'AVGVST'),
				[K_LEGEND, S_LEGEND, C_LEGEND, 'component_text_area'],
				'lg-nolan',
				'AVGVST',
				{ lang: 'lg-nolan', value: '<p>AVGVST</p>' },
				null,
			),
			linkOp(
				['zzrdf442', 'nmo:hasLegend'],
				CALLER,
				at(C_OBV_LEGEND, 'component_portal'),
				keyOf(S_LEGEND, C_LEGEND, 'AVGVST'),
				S_LEGEND,
			),
			findOp(
				['zzrdf443', 'dcterms:description'],
				descKey,
				[K_DESIGN, S_DESIGN, C_DESIGN, 'component_text_area'],
				'lg-spa',
				'Cabeza desnuda de Augusto a derecha',
				{ lang: 'lg-spa', value: '<p>Cabeza desnuda de Augusto a derecha</p>' },
				null,
			),
			linkOp(
				['zzrdf443', 'dcterms:description'],
				CALLER,
				at(C_OBV_DESIGN, 'component_portal'),
				descKey,
				S_DESIGN,
			),
			setOp(
				['zzrdf443', 'dcterms:description'],
				ref(descKey),
				[S_DESIGN, C_DESIGN, 'component_text_area'],
				'lg-eng',
				[{ lang: 'lg-eng', value: '<p>Bare head of Augustus, right</p>' }],
			),
			// reverse (a separately described node): its description only exists in English
			findOp(
				['zzrdf444', 'nmo:hasLegend'],
				keyOf(S_LEGEND, C_LEGEND, 'P CARISI LEG'),
				[K_LEGEND, S_LEGEND, C_LEGEND, 'component_text_area'],
				'lg-nolan',
				'P CARISI LEG',
				{ lang: 'lg-nolan', value: '<p>P CARISI LEG</p>' },
				null,
			),
			linkOp(
				['zzrdf444', 'nmo:hasLegend'],
				CALLER,
				at(C_REV_LEGEND, 'component_portal'),
				keyOf(S_LEGEND, C_LEGEND, 'P CARISI LEG'),
				S_LEGEND,
			),
			findOp(
				['zzrdf445', 'dcterms:description'],
				reverseDescKey,
				[K_DESIGN, S_DESIGN, C_DESIGN, 'component_text_area'],
				'lg-eng',
				'Victory standing right, crowning trophy',
				{ lang: 'lg-eng', value: '<p>Victory standing right, crowning trophy</p>' },
				null,
			),
			linkOp(
				['zzrdf445', 'dcterms:description'],
				CALLER,
				at(C_REV_DESIGN, 'component_portal'),
				reverseDescKey,
				S_DESIGN,
			),
		];
		expect(plan.ops).toEqual(expected);
	});

	test('every key is emitted before an op names it', () => {
		const seen = new Set<string>();
		for (const op of plan.ops) {
			const named = ['target' in op ? op.target : CALLER, op.op === 'link' ? op.to : CALLER].filter(
				(r) => r.kind === 'found_or_created',
			);
			for (const r of named) expect(seen.has((r as { key: string }).key)).toBe(true);
			if (op.op === 'find_or_create' || op.op === 'intermediate') seen.add(op.key);
		}
		expect(emittedKeys(plan.ops)).toEqual([...seen]);
	});

	test('a type no class maps gives no class and no ops', () => {
		const graph = parseRdfGraph(
			rdf(`<nmo:Hoard rdf:about="${NM}x"><skos:prefLabel>x</skos:prefLabel></nmo:Hoard>`),
		);
		expect(planRdfImport(ONT, graph, { subject: `${NM}x`, langs: LANGS })).toEqual({
			subject: `${NM}x`,
			class_tipo: null,
			section_tipo: null,
			ops: [],
		});
	});

	test('a subject the graph does not describe gives no class', () => {
		const graph = parseRdfGraph(OCRE, { baseIri: TYPE_IRI });
		const plan2 = planRdfImport(ONT, graph, { subject: 'http://example.org/other', langs: LANGS });
		expect(plan2.class_tipo).toBeNull();
		expect(plan2.ops).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Linked resources, planned after they were fetched
// ---------------------------------------------------------------------------

describe('rdf_import_plan — linked resources (planRdfResource)', () => {
	test('a mint: labels per language, the geo tag + map from the nested spatial thing, the IRI', () => {
		const key = keyOf(S_MINT, C_MINT_URI, `${NM}emerita`);
		const graph = parseRdfGraph(MINT_RDF);
		const ops = planRdfResource(ONT, graph, {
			subject: `${NM}emerita`,
			class_tipo: K_MINT,
			key,
			langs: LANGS,
		});
		const at = (component: string, model: string): [string, string, string] => [
			S_MINT,
			component,
			model,
		];
		expect(ops).toEqual([
			setOp(
				['zzrdf450', 'skos:prefLabel'],
				ref(key),
				at(C_MINT_NAME, 'component_input_text'),
				'lg-spa',
				[{ lang: 'lg-spa', value: 'Emérita Augusta' }],
			),
			setOp(
				['zzrdf450', 'skos:prefLabel'],
				ref(key),
				at(C_MINT_NAME, 'component_input_text'),
				'lg-eng',
				[{ lang: 'lg-eng', value: 'Emerita Augusta' }],
			),
			setOp(['zzrdf452', 'geo:lat'], ref(key), at(C_MINT_GEOTAG, 'component_text_area'), 'lg-spa', [
				{ lang: 'lg-spa', value: '<p>[geo-n-1-1-data::data]</p>' },
			]),
			setOp(
				['zzrdf453', 'geo:lat'],
				ref(key),
				at(C_MINT_MAP, 'component_geolocation'),
				'lg-nolan',
				[
					{
						lat: 38.916,
						lon: -6.343,
						zoom: 20,
						lib_data: [
							{
								layer_id: 1,
								layer_data: {
									type: 'FeatureCollection',
									features: [
										{
											type: 'Feature',
											properties: { layer_id: 1 },
											geometry: { type: 'Point', coordinates: [-6.343, 38.916] },
										},
									],
								},
							},
						],
					},
				],
			),
			setOp(
				['zzrdf454', 'skos:closeMatch'],
				ref(key),
				at(C_MINT_URI, 'component_iri'),
				'lg-nolan',
				[{ iri: 'http://www.wikidata.org/entity/Q5734', lang: 'lg-nolan' }],
			),
		]);
	});

	test('a person: one untranslatable name, birth year, a described membership walked, a blank one skipped', () => {
		const key = keyOf(S_PERSON, C_PERSON_URI, `${NM}augustus`);
		const membKey = keyOf(S_MEMB, C_MEMB_KEY, `${NM}augustus#emperor`);
		const roleKey = keyOf(S_ROLE, C_TS_URI, `${NM}emperor`);
		const ops = planRdfResource(ONT, parseRdfGraph(PERSON_RDF), {
			subject: `${NM}augustus`,
			class_tipo: K_PERSON,
			key,
			langs: LANGS,
		});
		expect(ops).toEqual([
			setOp(
				['zzrdf432', 'skos:prefLabel'],
				ref(key),
				[S_PERSON, C_PERSON_NAME, 'component_input_text'],
				'lg-nolan',
				[{ lang: 'lg-nolan', value: 'Augusto' }],
			),
			setOp(
				['zzrdf433', 'skos:exactMatch'],
				ref(key),
				[S_PERSON, C_PERSON_URI, 'component_iri'],
				'lg-nolan',
				[{ iri: 'http://viaf.org/viaf/1', lang: 'lg-nolan' }],
			),
			setOp(
				['zzrdf446', 'dcterms:date'],
				ref(key),
				[S_PERSON, C_BIRTH, 'component_date'],
				'lg-nolan',
				[{ start: { year: -62 } }],
			),
			// the described membership: matched by its IRI, its own properties read HERE
			findOp(
				['zzrdf436', 'org:hasMembership'],
				membKey,
				[K_MEMB, S_MEMB, C_MEMB_KEY, 'component_iri'],
				'lg-nolan',
				`${NM}augustus#emperor`,
				{ iri: `${NM}augustus#emperor`, lang: 'lg-nolan' },
				null,
			),
			termByIri(['zzrdf437', 'org:role'], [K_ROLE, S_ROLE, C_TS_URI], `${NM}emperor`),
			linkOp(
				['zzrdf437', 'org:role'],
				ref(membKey),
				[S_MEMB, C_MEMB_ROLE, 'component_portal'],
				roleKey,
				S_ROLE,
			),
			setOp(
				['zzrdf438', 'nmo:hasStartDate'],
				ref(membKey),
				[S_MEMB, C_MEMB_DATE, 'component_date'],
				'lg-nolan',
				[{ start: { year: -27 }, end: { year: 14 } }],
			),
			linkOp(
				['zzrdf436', 'org:hasMembership'],
				ref(key),
				[S_PERSON, C_MEMBERSHIPS, 'component_portal'],
				membKey,
				S_MEMB,
			),
			{
				op: 'skip',
				ontology_tipo: 'zzrdf436',
				rdf_predicate: 'org:hasMembership',
				target: ref(key),
				section_tipo: S_PERSON,
				component_tipo: C_MEMBERSHIPS,
				reason: 'blank_node',
			},
		]);
	});

	test('a known key is linked, not emitted again', () => {
		const key = keyOf(S_PERSON, C_PERSON_URI, `${NM}augustus`);
		const membKey = keyOf(S_MEMB, C_MEMB_KEY, `${NM}augustus#emperor`);
		const ops = planRdfResource(ONT, parseRdfGraph(PERSON_RDF), {
			subject: `${NM}augustus`,
			class_tipo: K_PERSON,
			key,
			langs: LANGS,
			known_keys: [membKey],
		});
		expect(ops.filter((op) => op.op === 'find_or_create')).toEqual([]);
		expect(ops.filter((op) => op.op === 'link').map((op) => (op as { to: RecordRef }).to)).toEqual([
			ref(membKey),
		]);
	});

	test('an unknown class, or a class without a section, plans nothing', () => {
		const graph = parseRdfGraph(MINT_RDF);
		const input = { subject: `${NM}emerita`, key: 'k', langs: LANGS };
		expect(planRdfResource(ONT, graph, { ...input, class_tipo: 'zzrdf999' })).toEqual([]);
		expect(planRdfResource(ONT, graph, { ...input, class_tipo: 'zzrdf401' })).toEqual([]);
	});

	test('the ontology prefix that does not resolve falls back to the document (mistyped foaf)', () => {
		const plan = planRdfImport(ONT, parseRdfGraph(PERSON_RDF), {
			subject: `${NM}augustus`,
			langs: LANGS,
		});
		expect(plan.class_tipo).toBe(K_PERSON);
		expect(plan.section_tipo).toBe(S_PERSON);
		expect(plan.ops[0]).toMatchObject({ op: 'set', target: CALLER, component_tipo: C_PERSON_NAME });
	});
});

// ---------------------------------------------------------------------------
// Rules, one at a time, on a small ontology
// ---------------------------------------------------------------------------

/** A one-class ontology `ex:Thing` → zzrdf900, its properties given. */
async function smallOntology(props: FixtureNode[], extra: FixtureNode[] = []) {
	const nodes: FixtureNode[] = [
		{
			tipo: 'zzrdf800',
			parent: null,
			model: 'external_ontology',
			term: 'x',
			properties: { xmlns: { ex: 'http://example.org/ns#' } },
		},
		section('zzrdf900'),
		section('zzrdf910'),
		comp('zzrdf901', 'zzrdf900', 'input_text', true),
		comp('zzrdf902', 'zzrdf900', 'input_text'),
		comp('zzrdf903', 'zzrdf900', 'portal'),
		comp('zzrdf904', 'zzrdf900', 'text_area'),
		comp('zzrdf905', 'zzrdf900', 'date'),
		comp('zzrdf906', 'zzrdf900', 'iri'),
		comp('zzrdf907', 'zzrdf900', 'number'),
		comp('zzrdf911', 'zzrdf910', 'iri'),
		{ ...cls('zzrdf801', 'ex:Thing', 'zzrdf900', 'zzrdf906'), parent: 'zzrdf800' },
		{ ...cls('zzrdf802', 'ex:Other', 'zzrdf910', 'zzrdf911'), parent: 'zzrdf800' },
		{
			tipo: 'zzrdf803',
			parent: 'zzrdf800',
			model: 'owl:Class',
			term: 'ex:NoMatch',
			related: ['zzrdf910'],
		},
		...props,
		...extra,
	];
	return loadRdfImportOntology('zzrdf800', memoryReader(nodes));
}

const EX = 'http://example.org/ns#';
const exDoc = (body: string): string =>
	`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="${EX}">${body}</rdf:RDF>`;

async function planSmall(props: FixtureNode[], body: string, langs: RdfPlanLangs = LANGS) {
	const ont = await smallOntology(props);
	const graph = parseRdfGraph(exDoc(`<ex:Thing rdf:about="${EX}a">${body}</ex:Thing>`));
	return planRdfImport(ont, graph, { subject: `${EX}a`, langs }).ops;
}

const skipOf = (
	ontology: string,
	predicate: string,
	component: string | null,
	reason: RdfSkipReason,
): RdfImportOp => ({
	op: 'skip',
	ontology_tipo: ontology,
	rdf_predicate: predicate,
	target: CALLER,
	section_tipo: 'zzrdf900',
	component_tipo: component,
	reason,
});

describe('rdf_import_plan — rules', () => {
	test('an untagged literal goes to the current language of a translatable component', async () => {
		const ops = await planSmall(
			[prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf901'])],
			'<ex:label>plain</ex:label>',
		);
		expect(ops).toEqual([
			setOp(
				['zzrdf820', 'ex:label'],
				CALLER,
				['zzrdf900', 'zzrdf901', 'component_input_text'],
				'lg-spa',
				[{ lang: 'lg-spa', value: 'plain' }],
			),
		]);
	});

	test('an untagged literal does not displace the current language’s own', async () => {
		const ops = await planSmall(
			[prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf901'])],
			'<ex:label>plain</ex:label><ex:label xml:lang="es">propio</ex:label>',
		);
		expect(ops.map((op) => (op as { lang: string }).lang)).toEqual(['lg-spa']);
		expect(ops[0]).toMatchObject({ value: [{ lang: 'lg-spa', value: 'propio' }] });
	});

	test('a language the install lacks is dropped; regional tags match their language', async () => {
		const ops = await planSmall(
			[prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf901'])],
			'<ex:label xml:lang="fr">non</ex:label><ex:label xml:lang="en-GB">colour</ex:label>',
		);
		expect(ops).toEqual([
			setOp(
				['zzrdf820', 'ex:label'],
				CALLER,
				['zzrdf900', 'zzrdf901', 'component_input_text'],
				'lg-eng',
				[{ lang: 'lg-eng', value: 'colour' }],
			),
		]);
	});

	test('an untranslatable component takes ONE language: current, else untagged, else the first', async () => {
		const p = [prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf902'])];
		const valuesFor = async (body: string) =>
			(await planSmall(p, body)).map((op) => (op as { value: unknown }).value);
		expect(
			await valuesFor(
				'<ex:label xml:lang="en">en</ex:label><ex:label xml:lang="es">es</ex:label><ex:label>u</ex:label>',
			),
		).toEqual([[{ lang: 'lg-nolan', value: 'es' }]]);
		expect(await valuesFor('<ex:label xml:lang="en">en</ex:label><ex:label>u</ex:label>')).toEqual([
			[{ lang: 'lg-nolan', value: 'u' }],
		]);
		expect(
			await valuesFor(
				'<ex:label xml:lang="de">de1</ex:label><ex:label xml:lang="en">en</ex:label><ex:label xml:lang="de">de2</ex:label>',
			),
		).toEqual([
			[
				{ lang: 'lg-nolan', value: 'de1' },
				{ lang: 'lg-nolan', value: 'de2' },
			],
		]);
		expect(await valuesFor('')).toEqual([]);
	});

	test('a current language with no ISO code falls back to untagged literals', async () => {
		const langs = { data: LANGS.data, current: 'lg-xxx' };
		const ops = await planSmall(
			[prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf902'])],
			'<ex:label xml:lang="en">en</ex:label><ex:label>u</ex:label>',
			langs,
		);
		expect(ops[0]).toMatchObject({ value: [{ lang: 'lg-nolan', value: 'u' }] });
	});

	test('remote text into a markup component is escaped', async () => {
		const ops = await planSmall(
			[prop('zzrdf820', 'zzrdf801', 'ex:note', ['zzrdf904'])],
			'<ex:note>a &lt;b&gt; &amp; "c"</ex:note>',
		);
		expect(ops[0]).toMatchObject({
			value: [{ lang: 'lg-nolan', value: '<p>a &lt;b&gt; &amp; &quot;c&quot;</p>' }],
		});
	});

	test('repeated identical values in one language are written once', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf901'], {
					process: { source: '$base_uri', data_map: { 'ns#a': 'A' } },
				}),
			],
			'<ex:label xml:lang="es">x</ex:label><ex:label xml:lang="es">y</ex:label>',
		);
		expect(ops[0]).toMatchObject({ value: [{ lang: 'lg-spa', value: 'A' }] });
	});

	test('a resource with no class is a skip; a class without match is a skip', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903']),
				prop('zzrdf821', 'zzrdf801', 'ex:rel2', ['zzrdf903', 'zzrdf803']),
				prop('zzrdf822', 'zzrdf801', 'ex:lit', ['zzrdf903', 'zzrdf803']),
			],
			`<ex:rel rdf:resource="${EX}b"/><ex:rel2 rdf:resource="${EX}b"/><ex:lit>t</ex:lit>`,
		);
		expect(ops).toEqual([
			skipOf('zzrdf820', 'ex:rel', 'zzrdf903', 'no_class_for_resource'),
			skipOf('zzrdf821', 'ex:rel2', 'zzrdf903', 'class_without_match'),
			skipOf('zzrdf822', 'ex:lit', 'zzrdf903', 'class_without_match'),
		]);
	});

	test('absent predicates write nothing and report nothing', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf803']),
				prop('zzrdf821', 'zzrdf801', 'ex:label', ['zzrdf901']),
				prop('zzrdf822', 'zzrdf801', 'ex:path'),
				prop('zzrdf823', 'zzrdf822', 'ex:label', ['zzrdf901']),
				prop('zzrdf824', 'zzrdf801', 'ex:auth', ['zzrdf903'], {
					ddo_map: [{ parent: 'zzrdf903', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' }],
				}),
				prop('zzrdf826', 'zzrdf824', 'ex:auth', ['zzrdf911']),
				prop('zzrdf825', 'zzrdf801', 'Date', ['zzrdf905'], {
					process: { date: { start: 'ex:start' } },
				}),
			],
			'',
		);
		expect(ops).toEqual([]);
	});

	test('a property with no component is a skip (a nested path is not)', async () => {
		const ops = await planSmall(
			[prop('zzrdf820', 'zzrdf801', 'ex:label', [])],
			'<ex:label>x</ex:label>',
		);
		expect(ops).toEqual([skipOf('zzrdf820', 'ex:label', null, 'no_component')]);
	});

	test('a blank resource with a class is a skip; a data_map gives it an identity', async () => {
		const blank = '<ex:rel><ex:Other/></ex:rel>';
		const linked = [prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf802'])];
		expect(await planSmall(linked, blank)).toEqual([
			skipOf('zzrdf820', 'ex:rel', 'zzrdf903', 'blank_node'),
		]);
		const mapped = [
			prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf802'], {
				process: { source: '$base_uri', data_map: { 'ns#a': 'urn:a' } },
			}),
		];
		const ops = await planSmall(mapped, blank);
		expect(ops.map((op) => op.op)).toEqual(['find_or_create', 'link']);
		expect(ops[0]).toMatchObject({ match_value: 'urn:a', needs_fetch_iri: null });
	});

	test('a data_map with no matching key is a skip, for resources and literals', async () => {
		const map = { process: { source: '$base_uri', data_map: { 'zz.': 'Z' } } };
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf802'], map),
				prop('zzrdf821', 'zzrdf801', 'ex:label', ['zzrdf901'], map),
				prop('zzrdf822', 'zzrdf801', 'ex:named', ['zzrdf903', 'zzrdf802'], map),
			],
			`<ex:rel rdf:resource="${EX}b"/><ex:label>t</ex:label><ex:named>n</ex:named>`,
		);
		expect(ops).toEqual([
			skipOf('zzrdf820', 'ex:rel', 'zzrdf903', 'data_map_no_match'),
			skipOf('zzrdf821', 'ex:label', 'zzrdf901', 'data_map_no_match'),
			skipOf('zzrdf822', 'ex:named', 'zzrdf903', 'data_map_no_match'),
		]);
	});

	test('a data_map on the value itself (no $base_uri source)', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf902'], {
					process: { data_map: { AV: 'Augustus' } },
				}),
			],
			'<ex:label>AVG</ex:label>',
		);
		expect(ops[0]).toMatchObject({ value: [{ lang: 'lg-nolan', value: 'Augustus' }] });
	});

	test('a resource with a class that maps no further property needs no fetch', async () => {
		const ops = await planSmall(
			[prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf802'])],
			`<ex:rel rdf:resource="${EX}b"/><ex:rel rdf:resource="urn:isbn:1"/>`,
		);
		expect(
			ops
				.filter((op) => op.op === 'find_or_create')
				.map((op) => (op as { needs_fetch_iri: unknown }).needs_fetch_iri),
		).toEqual([null]);
		// The non-web IRI is neither linked nor created (see the next test).
		expect(ops.at(-1)).toMatchObject({ op: 'skip', reason: 'unsupported_iri_scheme' });
	});

	test('a non-web IRI is never fetched, linked nor created: reported per predicate', async () => {
		const extra = [prop('zzrdf830', 'zzrdf802', 'ex:label', ['zzrdf911'])];
		const ont = await smallOntology(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf802']),
				prop('zzrdf821', 'zzrdf801', 'ex:again', ['zzrdf903', 'zzrdf802']),
			],
			extra,
		);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:rel rdf:resource="urn:isbn:1"/><ex:again rdf:resource="urn:isbn:1"/></ex:Thing>`,
			),
		);
		const ops = planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS }).ops;
		expect(ops).toEqual([
			skipOf('zzrdf820', 'ex:rel', 'zzrdf903', 'unsupported_iri_scheme'),
			skipOf('zzrdf821', 'ex:again', 'zzrdf903', 'unsupported_iri_scheme'),
		]);
	});

	test('a repeated resource is found once, linked twice', async () => {
		const ont = await smallOntology([
			prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf802']),
			prop('zzrdf821', 'zzrdf801', 'ex:again', ['zzrdf903', 'zzrdf802']),
		]);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:rel rdf:resource="${EX}b"/><ex:again rdf:resource="${EX}b"/></ex:Thing>`,
			),
		);
		const ops = planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS }).ops;
		expect(ops.map((op) => op.op)).toEqual(['find_or_create', 'link', 'link']);
	});

	test('a javascript:/data: resource is never stored in an IRI component nor linked by (stored XSS)', async () => {
		const ont = await smallOntology([
			prop('zzrdf820', 'zzrdf801', 'ex:see', ['zzrdf906']),
			prop('zzrdf821', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf802']),
		]);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:see rdf:resource="javascript:alert(document.cookie)"/><ex:see rdf:resource="${EX}ok"/><ex:see rdf:resource="data:text/html,x"/><ex:rel rdf:resource="javascript:alert(2)"/></ex:Thing>`,
			),
		);
		const ops = planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS }).ops;
		expect(ops).toEqual([
			skipOf('zzrdf820', 'ex:see', 'zzrdf906', 'unsupported_iri_scheme'),
			setOp(['zzrdf820', 'ex:see'], CALLER, ['zzrdf900', 'zzrdf906', 'component_iri'], 'lg-nolan', [
				{ iri: `${EX}ok`, lang: 'lg-nolan' },
			]),
			skipOf('zzrdf821', 'ex:rel', 'zzrdf903', 'unsupported_iri_scheme'),
		]);
		expect(JSON.stringify(ops)).not.toContain('javascript:');
	});

	test('a nested path to an undescribed resource is reported', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:path'),
				prop('zzrdf821', 'zzrdf820', 'ex:label', ['zzrdf901']),
			],
			`<ex:path rdf:resource="${EX}elsewhere"/>`,
		);
		expect(ops).toEqual([skipOf('zzrdf820', 'ex:path', null, 'resource_not_described')]);
	});

	test('a ddo_map whose path does not continue from the component is a skip', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:auth', ['zzrdf903'], {
					ddo_map: [{ parent: 'zzrdf999', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' }],
				}),
				prop('zzrdf821', 'zzrdf801', 'ex:auth2', [], {
					ddo_map: [{ parent: 'zzrdf903', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' }],
				}),
			],
			`<ex:auth rdf:resource="${EX}p"/>`,
		);
		expect(ops).toEqual([
			skipOf('zzrdf820', 'ex:auth', 'zzrdf903', 'ddo_map_unresolved'),
			skipOf('zzrdf821', 'ex:auth2', null, 'ddo_map_unresolved'),
		]);
	});

	test('two resources under one ddo_map: two intermediates, each child pinned to its own resource', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:auth', ['zzrdf903'], {
					ddo_map: [
						{ parent: 'zzrdf900', section_tipo: 'zzrdf900', component_tipo: 'zzrdf903' },
						{ parent: 'zzrdf903', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' },
					],
				}),
				prop('zzrdf821', 'zzrdf820', 'ex:auth', ['zzrdf911']),
			],
			`<ex:auth rdf:resource="${EX}p"/><ex:auth rdf:resource="${EX}q"/><ex:auth rdf:resource="${EX}p"/><ex:auth><ex:Other/></ex:auth>`,
		);
		const kp = `intermediate|caller|zzrdf903|${EX}p`;
		const kq = `intermediate|caller|zzrdf903|${EX}q`;
		expect(
			ops.map((op) => [op.op, 'key' in op ? op.key : (op as { target: RecordRef }).target]),
		).toEqual([
			['intermediate', kp],
			['set', ref(kp)],
			['intermediate', kq],
			['set', ref(kq)],
			['skip', CALLER],
		]);
		expect(ops[1]).toMatchObject({ value: [{ iri: `${EX}p`, lang: 'lg-nolan' }] });
		expect(ops[3]).toMatchObject({ value: [{ iri: `${EX}q`, lang: 'lg-nolan' }] });
		expect(ops[4]).toMatchObject({ reason: 'blank_node', component_tipo: 'zzrdf903' });
		expect(ops[0]).toMatchObject({
			intermediate_section_tipo: 'zzrdf910',
			section_tipo: 'zzrdf900',
		});
	});

	test('dates: unparsed is a skip; an end alone is driven by its own predicate', async () => {
		const date = (start: string | undefined, end: string | undefined) =>
			prop('zzrdf820', 'zzrdf801', 'Date', ['zzrdf905'], {
				process: { date: { start, end, format: { 'xsd:gYear': 'year' } } },
			});
		expect(await planSmall([date('ex:s', 'ex:e')], '<ex:s>soon</ex:s>')).toEqual([
			skipOf('zzrdf820', 'Date', 'zzrdf905', 'date_unparsed'),
		]);
		expect(await planSmall([date('ex:s', 'ex:e')], '<ex:e>1999-02-03</ex:e>')).toEqual([
			setOp(['zzrdf820', 'ex:e'], CALLER, ['zzrdf900', 'zzrdf905', 'component_date'], 'lg-nolan', [
				{ end: { year: 1999, month: 2, day: 3 } },
			]),
		]);
		expect(
			await planSmall(
				[date('ex:s', undefined)],
				`<ex:s rdf:datatype="http://www.w3.org/2001/XMLSchema#gYear">0014</ex:s>`,
			),
		).toEqual([
			setOp(['zzrdf820', 'ex:s'], CALLER, ['zzrdf900', 'zzrdf905', 'component_date'], 'lg-nolan', [
				{ start: { year: 14 } },
			]),
		]);
	});

	test('numbers: a numeral is cast to a number (PHP is_numeric grammar); anything else is a skip', async () => {
		const weight = prop('zzrdf820', 'zzrdf801', 'ex:weight', ['zzrdf907']);
		const at: [string, string, string] = ['zzrdf900', 'zzrdf907', 'component_number'];
		expect(await planSmall([weight], '<ex:weight> 7.85 </ex:weight>')).toEqual([
			setOp(['zzrdf820', 'ex:weight'], CALLER, at, 'lg-nolan', [{ lang: 'lg-nolan', value: 7.85 }]),
		]);
		expect(await planSmall([weight], '<ex:weight>-1.5e2</ex:weight>')).toEqual([
			setOp(['zzrdf820', 'ex:weight'], CALLER, at, 'lg-nolan', [{ lang: 'lg-nolan', value: -150 }]),
		]);
		// surrounding blanks are no part of the numeral (a data_map value keeps them verbatim)
		const mapped = prop('zzrdf820', 'zzrdf801', 'ex:weight', ['zzrdf907'], {
			process: { data_map: { heavy: ' 12 ' } },
		});
		expect(await planSmall([mapped], '<ex:weight>heavy</ex:weight>')).toEqual([
			setOp(['zzrdf820', 'ex:weight'], CALLER, at, 'lg-nolan', [{ lang: 'lg-nolan', value: 12 }]),
		]);
		for (const bad of ['7,85', '0x1A', 'heavy', '', '1e999']) {
			expect(await planSmall([weight], `<ex:weight>${bad}</ex:weight>`)).toEqual([
				skipOf('zzrdf820', 'ex:weight', 'zzrdf907', 'number_unparsed'),
			]);
		}
		// a split of the subject IRI into a number component: `a` spells no number
		const split = prop('zzrdf820', 'zzrdf801', 'Number', ['zzrdf907'], {
			process: { split: { get: 'end', source: '$base_uri', split_by: '#' } },
		});
		expect(await planSmall([split], '')).toEqual([
			skipOf('zzrdf820', 'Number', 'zzrdf907', 'number_unparsed'),
		]);
	});

	test('a number match component: a numeral finds-or-creates by its number, text is a skip', async () => {
		const extra: FixtureNode[] = [
			section('zzrdf920'),
			comp('zzrdf921', 'zzrdf920', 'number'),
			{ ...cls('zzrdf804', 'ex:Count', 'zzrdf920', 'zzrdf921'), parent: 'zzrdf800' },
		];
		const ont = await smallOntology(
			[prop('zzrdf820', 'zzrdf801', 'ex:count', ['zzrdf903', 'zzrdf804'])],
			extra,
		);
		const plan = (value: string) =>
			planRdfImport(
				ont,
				parseRdfGraph(
					exDoc(`<ex:Thing rdf:about="${EX}a"><ex:count>${value}</ex:count></ex:Thing>`),
				),
				{ subject: `${EX}a`, langs: LANGS },
			).ops;
		expect(plan('12')[0]).toMatchObject({
			op: 'find_or_create',
			match_value: '12',
			match_item: { lang: 'lg-nolan', value: 12 },
		});
		expect(plan('twelve')).toEqual([skipOf('zzrdf820', 'ex:count', 'zzrdf903', 'number_unparsed')]);
	});

	test('a date format resolves the datatype through either prefix map', async () => {
		const p = prop('zzrdf820', 'zzrdf801', 'Date', ['zzrdf905'], {
			process: { date: { start: 'ex:s', format: { 'ex:myYear': 'year' } } },
		});
		// typed with the ontology-only prefix's namespace: the format names the parser (year),
		// so the lexical full date is NOT accepted
		expect(await planSmall([p], `<ex:s rdf:datatype="${EX}myYear">2001-02-03</ex:s>`)).toEqual([
			skipOf('zzrdf820', 'Date', 'zzrdf905', 'date_unparsed'),
		]);
	});

	test('geo: unparsable or out-of-range coordinates are a skip', async () => {
		const p = prop('zzrdf820', 'zzrdf801', 'Geo', ['zzrdf901'], {
			process: { geo_tag: { lat: 'ex:lat', long: 'ex:long' } },
		});
		expect(await planSmall([p], '<ex:lat>91</ex:lat><ex:long>0</ex:long>')).toEqual([
			skipOf('zzrdf820', 'Geo', 'zzrdf901', 'geo_unparsed'),
		]);
		expect(await planSmall([p], '<ex:lat>10</ex:lat><ex:long>-181</ex:long>')).toEqual([
			skipOf('zzrdf820', 'Geo', 'zzrdf901', 'geo_unparsed'),
		]);
		expect(await planSmall([p], '<ex:lat>10</ex:lat>')).toEqual([
			skipOf('zzrdf820', 'Geo', 'zzrdf901', 'geo_unparsed'),
		]);
		expect(await planSmall([p], '<ex:long>10</ex:long>')).toEqual([
			skipOf('zzrdf820', 'Geo', 'zzrdf901', 'geo_unparsed'),
		]);
		expect(await planSmall([p], '<ex:lat>-90</ex:lat><ex:long>180</ex:long>')).toEqual([
			setOp(
				['zzrdf820', 'ex:lat'],
				CALLER,
				['zzrdf900', 'zzrdf901', 'component_input_text'],
				'lg-spa',
				[{ lang: 'lg-spa', value: '[geo-n-1-1-data::data]' }],
			),
		]);
	});

	test('split: start part, no driver, unsupported source/get', async () => {
		const split = (spec: Record<string, unknown>) =>
			prop('zzrdf820', 'zzrdf801', 'Num', ['zzrdf901'], { process: { split: spec } });
		expect(
			await planSmall([split({ source: '$base_uri', split_by: '#', get: 'start' })], ''),
		).toEqual([
			setOp(
				['zzrdf820', 'Num'],
				CALLER,
				['zzrdf900', 'zzrdf901', 'component_input_text'],
				'lg-spa',
				[{ lang: 'lg-spa', value: 'http://example.org/ns' }],
			),
		]);
		for (const spec of [
			{ source: '$value', split_by: '#', get: 'end' },
			{ source: '$base_uri', get: 'end' },
			{ source: '$base_uri', split_by: '#', get: 'middle' },
			{ source: '$base_uri', split_by: '#a', get: 'end' },
		]) {
			expect(await planSmall([split(spec)], '')).toEqual([
				skipOf('zzrdf820', 'Num', 'zzrdf901', 'unsupported_process'),
			]);
		}
	});

	test('literals ONLY in languages the install lacks are reported, never silently dropped', async () => {
		const label = prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf901']);
		expect(await planSmall([label], '<ex:label xml:lang="la">Emerita Augusta</ex:label>')).toEqual([
			skipOf('zzrdf820', 'ex:label', 'zzrdf901', 'language_not_installed'),
		]);
		// One installed language among them: it is written, the rest is not a skip.
		expect(
			(
				await planSmall(
					[label],
					'<ex:label xml:lang="la">Emerita Augusta</ex:label><ex:label xml:lang="en">Merida</ex:label>',
				)
			).map((op) => [op.op, (op as { lang?: string }).lang]),
		).toEqual([['set', 'lg-eng']]);
		// A literal that identifies a class record (a legend): no record, no link — reported.
		const ont = await smallOntology(
			[prop('zzrdf821', 'zzrdf801', 'ex:legend', ['zzrdf903', 'zzrdf804'])],
			[{ ...cls('zzrdf804', 'ex:Legend', 'zzrdf900', 'zzrdf901'), parent: 'zzrdf800' }],
		);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:legend xml:lang="la">AVGVSTVS</ex:legend></ex:Thing>`,
			),
		);
		expect(planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS }).ops).toEqual([
			skipOf('zzrdf821', 'ex:legend', 'zzrdf903', 'language_not_installed'),
		]);
		// A split driven by a predicate whose literals are all in such languages.
		const split = prop('zzrdf822', 'zzrdf801', 'Num', ['zzrdf901'], {
			process: {
				split: { source: '$base_uri', split_by: '#', get: 'end', property_name: 'ex:label' },
			},
		});
		expect(await planSmall([split], '<ex:label xml:lang="la">x</ex:label>')).toEqual([
			skipOf('zzrdf822', 'Num', 'zzrdf901', 'language_not_installed'),
		]);
	});

	test('a ddo_map resource that is no web IRI is never an intermediate: reported', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:auth', ['zzrdf903'], {
					ddo_map: [{ parent: 'zzrdf903', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' }],
				}),
				prop('zzrdf821', 'zzrdf820', 'ex:auth', ['zzrdf911']),
			],
			`<ex:auth rdf:resource="urn:x:augustus"/><ex:auth rdf:resource="${EX}p"/>`,
		);
		expect(ops.map((op) => [op.op, (op as { reason?: string }).reason])).toEqual([
			['skip', 'unsupported_iri_scheme'],
			['intermediate', undefined],
			['set', undefined],
		]);
		expect(ops[0]).toEqual(skipOf('zzrdf820', 'ex:auth', 'zzrdf903', 'unsupported_iri_scheme'));
	});

	test('a chain of described linked resources stops at the depth limit', async () => {
		const ont = await smallOntology([
			prop('zzrdf820', 'zzrdf801', 'ex:next', ['zzrdf903', 'zzrdf801']),
		]);
		const links = Array.from(
			{ length: RDF_PLAN_MAX_DEPTH + 4 },
			(_, i) =>
				`<ex:Thing rdf:about="${EX}n${i}"><ex:next rdf:resource="${EX}n${i + 1}"/></ex:Thing>`,
		).join('');
		const graph = parseRdfGraph(exDoc(links));
		const ops = planRdfImport(ont, graph, { subject: `${EX}n0`, langs: LANGS }).ops;
		const finds = ops.filter((op) => op.op === 'find_or_create');
		expect(finds).toHaveLength(RDF_PLAN_MAX_DEPTH + 1);
		const last = ops.lastIndexOf(finds.at(-1) as RdfImportOp);
		expect(ops[last + 1]).toMatchObject({
			op: 'skip',
			reason: 'depth_limit',
			ontology_tipo: 'zzrdf801',
			target: ref(`zzrdf900|zzrdf906|${EX}n${RDF_PLAN_MAX_DEPTH + 1}`),
		});
		expect(ops.filter((op) => op.op === 'skip')).toHaveLength(1);
	});

	test('a cycle of linked resources is walked once', async () => {
		const ont = await smallOntology([
			prop('zzrdf820', 'zzrdf801', 'ex:next', ['zzrdf903', 'zzrdf801']),
		]);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:next rdf:resource="${EX}b"/></ex:Thing><ex:Thing rdf:about="${EX}b"><ex:next rdf:resource="${EX}a"/></ex:Thing>`,
			),
		);
		const ops = planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS }).ops;
		// b is found, then a (as b's target); a's link back to b names the known key
		expect(ops.map((op) => op.op)).toEqual([
			'find_or_create',
			'find_or_create',
			'link',
			'link',
			'link',
		]);
		expect(
			ops
				.filter((op) => op.op === 'find_or_create')
				.map((op) => (op as { match_value: string }).match_value),
		).toEqual([`${EX}b`, `${EX}a`]);
	});
});

describe('rdf_import_plan — identity, pinning and languages', () => {
	test('a predicate the ontology prefix mistypes is read through the document prefix', async () => {
		const nodes: FixtureNode[] = [
			{
				tipo: 'zzrdf800',
				parent: null,
				model: 'external_ontology',
				term: 'x',
				properties: { xmlns: { ex: 'http://wrong.example/' } },
			},
			section('zzrdf900'),
			comp('zzrdf902', 'zzrdf900', 'input_text'),
			comp('zzrdf906', 'zzrdf900', 'iri'),
			{ ...cls('zzrdf801', 'ex:Thing', 'zzrdf900', 'zzrdf906'), parent: 'zzrdf800' },
			prop('zzrdf820', 'zzrdf801', 'ex:label', ['zzrdf902']),
		];
		const ont = await loadRdfImportOntology('zzrdf800', memoryReader(nodes));
		const graph = parseRdfGraph(
			exDoc(`<ex:Thing rdf:about="${EX}a"><ex:label>found</ex:label></ex:Thing>`),
		);
		const plan = planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS });
		expect(plan.class_tipo).toBe('zzrdf801');
		expect(plan.ops).toEqual([
			setOp(
				['zzrdf820', 'ex:label'],
				CALLER,
				['zzrdf900', 'zzrdf902', 'component_input_text'],
				'lg-nolan',
				[{ lang: 'lg-nolan', value: 'found' }],
			),
		]);
	});

	test('one resource under two ddo_map predicates of one component: one intermediate', async () => {
		const ddo = {
			ddo_map: [{ parent: 'zzrdf903', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' }],
		};
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:auth', ['zzrdf903'], ddo),
				prop('zzrdf821', 'zzrdf820', 'ex:auth', ['zzrdf911']),
				prop('zzrdf822', 'zzrdf801', 'ex:issuer', ['zzrdf903'], ddo),
				prop('zzrdf823', 'zzrdf822', 'ex:issuer', ['zzrdf911']),
			],
			`<ex:auth rdf:resource="${EX}p"/><ex:issuer rdf:resource="${EX}p"/>`,
		);
		expect(ops.map((op) => op.op)).toEqual(['intermediate', 'set']);
	});

	test('a ddo_map step without a parent is dropped from the path', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:auth', ['zzrdf903'], {
					ddo_map: [
						{ section_tipo: 'zzrdf900', component_tipo: 'zzrdf903' },
						{ parent: 'zzrdf903', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' },
					],
				}),
			],
			`<ex:auth rdf:resource="${EX}p"/>`,
		);
		expect(ops[0]).toMatchObject({
			op: 'intermediate',
			path: [{ parent: 'zzrdf903', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' }],
		});
	});

	test('the pin of an intermediate does not reach into the linked record it finds', async () => {
		const extra = [
			comp('zzrdf913', 'zzrdf910', 'portal'),
			prop('zzrdf830', 'zzrdf802', 'ex:same', ['zzrdf911']),
		];
		const ont = await smallOntology(
			[
				prop('zzrdf820', 'zzrdf801', 'ex:auth', ['zzrdf903'], {
					ddo_map: [{ parent: 'zzrdf903', section_tipo: 'zzrdf910', component_tipo: 'zzrdf911' }],
				}),
				prop('zzrdf821', 'zzrdf820', 'ex:auth', ['zzrdf913', 'zzrdf802']),
			],
			extra,
		);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:auth rdf:resource="${EX}p"/></ex:Thing><ex:Other rdf:about="${EX}p"><ex:same rdf:resource="${EX}x"/></ex:Other>`,
			),
		);
		const ops = planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS }).ops;
		const pKey = keyOf('zzrdf910', 'zzrdf911', `${EX}p`);
		expect(ops.map((op) => op.op)).toEqual(['intermediate', 'find_or_create', 'set', 'link']);
		expect(ops[2]).toMatchObject({
			target: ref(pKey),
			value: [{ iri: `${EX}x`, lang: 'lg-nolan' }],
		});
	});

	test('an IRI component keeps only named resources; only blank ones write nothing', async () => {
		const p = [prop('zzrdf820', 'zzrdf801', 'ex:see', ['zzrdf906'])];
		expect(
			await planSmall(p, `<ex:see rdf:resource="${EX}x"/><ex:see><ex:Other/></ex:see>`),
		).toEqual([
			setOp(['zzrdf820', 'ex:see'], CALLER, ['zzrdf900', 'zzrdf906', 'component_iri'], 'lg-nolan', [
				{ iri: `${EX}x`, lang: 'lg-nolan' },
			]),
		]);
		expect(await planSmall(p, '<ex:see><ex:Other/></ex:see>')).toEqual([]);
	});

	test('a literal record is matched on the CURRENT language even when it is not the first', async () => {
		const langs: RdfPlanLangs = {
			data: [LANGS.data[1], LANGS.data[0]] as RdfPlanLangs['data'],
			current: 'lg-spa',
		};
		const nodes = [prop('zzrdf820', 'zzrdf801', 'ex:design', ['zzrdf903', 'zzrdf802'])];
		const ont = await smallOntology(nodes, [
			comp('zzrdf912', 'zzrdf910', 'input_text', true),
			{ ...cls('zzrdf804', 'ex:Design', 'zzrdf910', 'zzrdf912'), parent: 'zzrdf800' },
			prop('zzrdf821', 'zzrdf801', 'ex:design2', ['zzrdf903', 'zzrdf804']),
		]);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:design2 xml:lang="en">head</ex:design2><ex:design2 xml:lang="es">cabeza</ex:design2></ex:Thing>`,
			),
		);
		const ops = planRdfImport(ont, graph, { subject: `${EX}a`, langs }).ops;
		const key = keyOf('zzrdf910', 'zzrdf912', 'cabeza');
		expect(ops).toEqual([
			findOp(
				['zzrdf821', 'ex:design2'],
				key,
				['zzrdf804', 'zzrdf910', 'zzrdf912', 'component_input_text'],
				'lg-spa',
				'cabeza',
				{ lang: 'lg-spa', value: 'cabeza' },
				null,
			),
			linkOp(
				['zzrdf821', 'ex:design2'],
				CALLER,
				['zzrdf900', 'zzrdf903', 'component_portal'],
				key,
				'zzrdf910',
			),
			setOp(
				['zzrdf821', 'ex:design2'],
				ref(key),
				['zzrdf910', 'zzrdf912', 'component_input_text'],
				'lg-eng',
				[{ lang: 'lg-eng', value: 'head' }],
			),
		]);
	});

	test('two literals in the preferred language: two records, no translations paired', async () => {
		const ont = await smallOntology(
			[],
			[
				comp('zzrdf912', 'zzrdf910', 'input_text', true),
				{ ...cls('zzrdf804', 'ex:Design', 'zzrdf910', 'zzrdf912'), parent: 'zzrdf800' },
				prop('zzrdf821', 'zzrdf801', 'ex:design', ['zzrdf903', 'zzrdf804']),
			],
		);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:design xml:lang="es">uno</ex:design><ex:design xml:lang="es">dos</ex:design><ex:design xml:lang="en">one</ex:design></ex:Thing>`,
			),
		);
		const ops = planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS }).ops;
		expect(ops.map((op) => op.op)).toEqual(['find_or_create', 'link', 'find_or_create', 'link']);
	});

	test('a class without a section plans nothing; its section is found among other relations', async () => {
		const ont = await smallOntology(
			[],
			[
				{
					tipo: 'zzrdf805',
					parent: 'zzrdf800',
					model: 'owl:Class',
					term: 'ex:Loose',
					related: ['zzrdf901'],
				},
				prop('zzrdf831', 'zzrdf805', 'ex:label', ['zzrdf901']),
				{
					...cls('zzrdf806', 'ex:Late', 'zzrdf910', 'zzrdf911'),
					parent: 'zzrdf800',
					related: ['zzrdf901', 'zzrdf910'],
				},
				prop('zzrdf832', 'zzrdf806', 'ex:label', ['zzrdf901']),
			],
		);
		const loose = parseRdfGraph(
			exDoc(`<ex:Loose rdf:about="${EX}a"><ex:label>x</ex:label></ex:Loose>`),
		);
		expect(planRdfImport(ont, loose, { subject: `${EX}a`, langs: LANGS })).toEqual({
			subject: `${EX}a`,
			class_tipo: 'zzrdf805',
			section_tipo: null,
			ops: [],
		});
		const input = { subject: `${EX}a`, key: 'k', langs: LANGS };
		expect(planRdfResource(ont, loose, { ...input, class_tipo: 'zzrdf805' })).toEqual([]);
		const late = parseRdfGraph(
			exDoc(`<ex:Late rdf:about="${EX}a"><ex:label>x</ex:label></ex:Late>`),
		);
		const plan = planRdfImport(ont, late, { subject: `${EX}a`, langs: LANGS });
		expect(plan.section_tipo).toBe('zzrdf910');
		expect(plan.ops[0]).toMatchObject({ section_tipo: 'zzrdf910' });
	});

	test('a fetched resource that links to itself is not found again', async () => {
		const ont = await smallOntology(
			[],
			[
				comp('zzrdf913', 'zzrdf910', 'portal'),
				prop('zzrdf830', 'zzrdf802', 'ex:self', ['zzrdf913', 'zzrdf802']),
			],
		);
		const key = keyOf('zzrdf910', 'zzrdf911', `${EX}b`);
		const graph = parseRdfGraph(
			exDoc(`<ex:Other rdf:about="${EX}b"><ex:self rdf:resource="${EX}b"/></ex:Other>`),
		);
		const ops = planRdfResource(ont, graph, {
			subject: `${EX}b`,
			class_tipo: 'zzrdf802',
			key,
			langs: LANGS,
		});
		expect(ops).toEqual([
			linkOp(
				['zzrdf830', 'ex:self'],
				ref(key),
				['zzrdf910', 'zzrdf913', 'component_portal'],
				key,
				'zzrdf910',
			),
		]);
	});

	test('one resource under the same ddo_map in two different records: two intermediates', async () => {
		const ont = await smallOntology(
			[prop('zzrdf820', 'zzrdf801', 'ex:rel', ['zzrdf903', 'zzrdf802'])],
			[
				comp('zzrdf913', 'zzrdf910', 'portal'),
				prop('zzrdf830', 'zzrdf802', 'ex:auth', ['zzrdf913'], {
					ddo_map: [{ parent: 'zzrdf913', section_tipo: 'zzrdf900', component_tipo: 'zzrdf906' }],
				}),
			],
		);
		const graph = parseRdfGraph(
			exDoc(
				`<ex:Thing rdf:about="${EX}a"><ex:rel rdf:resource="${EX}b"/><ex:rel rdf:resource="${EX}c"/></ex:Thing>` +
					`<ex:Other rdf:about="${EX}b"><ex:auth rdf:resource="${EX}p"/></ex:Other>` +
					`<ex:Other rdf:about="${EX}c"><ex:auth rdf:resource="${EX}p"/></ex:Other>`,
			),
		);
		const ops = planRdfImport(ont, graph, { subject: `${EX}a`, langs: LANGS }).ops;
		expect(
			ops.filter((op) => op.op === 'intermediate').map((op) => (op as { key: string }).key),
		).toEqual([
			`intermediate|zzrdf910|zzrdf911|${EX}b|zzrdf913|${EX}p`,
			`intermediate|zzrdf910|zzrdf911|${EX}c|zzrdf913|${EX}p`,
		]);
	});

	test('a split driven by an absent predicate writes nothing', async () => {
		const ops = await planSmall(
			[
				prop('zzrdf820', 'zzrdf801', 'Num', ['zzrdf902'], {
					process: {
						split: { source: '$base_uri', split_by: '#', get: 'end', property_name: 'ex:label' },
					},
				}),
			],
			'',
		);
		expect(ops).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('rdf_import_plan — dataMapValue / parseRdfDate', () => {
	test('the longest contained key wins, whatever the key order', () => {
		expect(dataMapValue(SERIES_MAP, 'ric.1(2).aug.1A')).toBe('RIC I (second edition)');
		expect(dataMapValue(SERIES_MAP, 'ric.10.aug.1')).toBe('RIC X');
		expect(dataMapValue({ a: 'short', ab: 'long' }, 'xab')).toBe('long');
		expect(dataMapValue({ ab: 'long', a: 'short' }, 'xab')).toBe('long');
		expect(dataMapValue({ a: 'first', b: 'second' }, 'ab')).toBe('first');
		expect(dataMapValue(SERIES_MAP, 'oscar.1')).toBeNull();
		expect(dataMapValue({ '': 'empty', x: 1 }, 'x')).toBeNull();
	});

	test('dates by format and by lexical form', () => {
		expect(parseRdfDate('-0025', 'year')).toEqual({ year: -25 });
		expect(parseRdfDate(' 0014 ', 'year')).toEqual({ year: 14 });
		expect(parseRdfDate('2001Z', 'year')).toEqual({ year: 2001 });
		expect(parseRdfDate('2001-05', 'year')).toBeNull();
		expect(parseRdfDate('--05', 'month')).toEqual({ month: 5 });
		expect(parseRdfDate('--13', 'month')).toBeNull();
		expect(parseRdfDate('--00', 'month')).toBeNull();
		expect(parseRdfDate('---31', 'day')).toEqual({ day: 31 });
		expect(parseRdfDate('---32', 'day')).toBeNull();
		expect(parseRdfDate('-0044-03-15', 'YYYY-MM-DD')).toEqual({ year: -44, month: 3, day: 15 });
		expect(parseRdfDate('1999-02-03T10:00:00Z', 'from_timestamp')).toEqual({
			year: 1999,
			month: 2,
			day: 3,
		});
		expect(parseRdfDate('1999-13-03', 'YYYY-MM-DD')).toBeNull();
		expect(parseRdfDate('1999-12-32', 'YYYY-MM-DD')).toBeNull();
		expect(parseRdfDate('1999-12-00', 'YYYY-MM-DD')).toBeNull();
		expect(parseRdfDate('1999-1-3', 'YYYY-MM-DD')).toBeNull();
		expect(parseRdfDate('---07', null)).toEqual({ day: 7 });
		expect(parseRdfDate('--07', null)).toEqual({ month: 7 });
		expect(parseRdfDate('1999-07', null)).toEqual({ year: 1999, month: 7 });
		expect(parseRdfDate('-0025', null)).toEqual({ year: -25 });
		expect(parseRdfDate('-0025', 'toString')).toEqual({ year: -25 });
		expect(parseRdfDate('soon', null)).toBeNull();
		expect(parseRdfDate('2001', 'day')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

describe('rdf_import_plan — loadRdfImportOntology', () => {
	test('the snapshot: names, related tipos, children order, model facts, xmlns', () => {
		expect(ONT.root).toBe(ROOT);
		expect(ONT.xmlns).toEqual(XMLNS);
		expect(ONT.children.get(ROOT)?.slice(0, 3)).toEqual([K_TYPE, K_SERIES, K_OBJTYPE]);
		expect(ONT.children.get('zzrdf413')).toEqual(['zzrdf442', 'zzrdf443']);
		expect(ONT.nodes.get('zzrdf405')).toEqual({
			tipo: 'zzrdf405',
			model: 'owl:ObjectProperty',
			name: 'dcterms:source',
			properties: { process: { source: '$base_uri', data_map: SERIES_MAP } },
			related: [C_SERIES, K_SERIES],
		});
		expect(ONT.tipos.get(C_DESIGN)).toEqual({
			model: 'component_text_area',
			translatable: true,
			html: true,
			number: false,
		});
		expect(ONT.tipos.get(C_SERIES_NAME)).toEqual({
			model: 'component_input_text',
			translatable: true,
			html: false,
			number: false,
		});
		expect(ONT.tipos.get(S_TYPE)).toEqual({
			model: 'section',
			translatable: false,
			html: false,
			number: false,
		});
		// sections are not walked as children; only referenced tipos get model facts
		expect(ONT.nodes.has(S_TYPE)).toBe(false);
		expect(ONT.tipos.has(ROOT)).toBe(false);
	});

	// RE-PINNED 2026-11-04 (WC-2026-11-04-ontology-machine-names): the reader no
	// longer takes a structure language — a node's RDF name is its MACHINE NAME
	// when it is a name node (labels.ts nameOrLabelOf), its label otherwise; a
	// row that states no flag reads as before (lg-spa, else the first authored).
	test('names: the machine name of a name node, else the label; malformed rows are tolerated', async () => {
		const rootRows = [
			{
				tipo: 'a',
				model: 'owl:Class',
				term: { 'lg-eng': ' ex:A ' },
				properties: null,
				relations: 'x',
			},
			{
				tipo: 'b',
				model: 'owl:Class',
				term: null,
				properties: [],
				relations: [{ tipo: 5 }, null, { tipo: 'a' }],
			},
			{
				tipo: 'c',
				model: 'owl:Class',
				term: { 'lg-spa': '', 'lg-eng': 'ex:C' },
				properties: { match: 7 },
				relations: [],
			},
			{
				tipo: 'd',
				model: 'owl:Class',
				term: { 'lg-eng': 'ex:Eng', 'lg-spa': 'ex:Spa' },
				properties: null,
				relations: [],
			},
			// a NAME node: the machine name wins over every decoy translation
			{
				tipo: 'e',
				model: 'owl:Class',
				term: { 'lg-ara': 'ex:Decoy', 'lg-spa': 'ex:Spa' },
				machine_name: ' ex:Machine ',
				use_machine_name: true,
				properties: null,
				relations: [],
			},
			// a name node the parser could not name (collision): no guess
			{
				tipo: 'f',
				model: 'owl:Class',
				term: { 'lg-eng': 'ex:One', 'lg-spa': 'ex:Two' },
				machine_name: null,
				use_machine_name: true,
				properties: null,
				relations: [],
			},
			// a LABEL node (a mixed crm child): the label chain
			{
				tipo: 'g',
				model: 'component_input_text',
				term: { 'lg-eng': 'English label', 'lg-spa': 'Etiqueta' },
				machine_name: null,
				use_machine_name: false,
				properties: null,
				relations: [],
			},
		] as RdfReaderNode[];
		const reader: RdfOntologyReader = {
			properties: async () => ({ xmlns: { ok: 'urn:ok#', bad: 3, toString: 'urn:t#' } }),
			children: async (tipo) =>
				tipo === 'r'
					? rootRows
					: tipo === 'a'
						? ([
								{ tipo: 'b', model: 'owl:Class', term: null, properties: null, relations: null },
							] as RdfReaderNode[])
						: [],
			tipoInfo: async (tipo) => ({
				model: `m_${tipo}`,
				translatable: false,
				html: false,
				number: false,
			}),
		};
		const ont = await loadRdfImportOntology('r', reader);
		expect(ont.nodes.get('a')).toMatchObject({ name: 'ex:A', related: [], properties: {} });
		expect(ont.nodes.get('b')).toMatchObject({ name: '', related: ['a'], properties: {} });
		expect(ont.nodes.get('c')).toMatchObject({ name: 'ex:C' });
		expect(ont.nodes.get('d')).toMatchObject({ name: 'ex:Spa' });
		expect(ont.nodes.get('e')).toMatchObject({ name: 'ex:Machine' });
		expect(ont.nodes.get('f')).toMatchObject({ name: '' });
		expect(ont.nodes.get('g')).toMatchObject({ name: 'Etiqueta' });
		expect(ont.children.get('a')).toEqual([]);
		expect([...ont.tipos.keys()]).toEqual(['a']);
		expect({ ...ont.xmlns }).toEqual({ ok: 'urn:ok#', toString: 'urn:t#' });
		expect(Object.isFrozen(ont.xmlns)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Production adapters, on the suite database
// ---------------------------------------------------------------------------

describe('rdf_import_plan — production reader on the suite database', () => {
	const SITUATION = situation({
		tld: 'zzrdf',
		name: 'rdf_import_plan',
		nodes: NODES.map((node, index) => ({
			tipo: node.tipo,
			parent: node.parent,
			model: node.model,
			term: { 'lg-spa': node.term },
			order_number: index + 1,
			is_translatable: node.translatable ?? false,
			properties: node.properties ?? null,
			...(node.related === undefined ? {} : { relations: node.related.map((tipo) => ({ tipo })) }),
		})),
	});

	beforeAll(() => ensureSituation(SITUATION));
	afterAll(async () => {
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	test('the engine reader loads the same snapshot as the fixture reader', async () => {
		const engine = await loadRdfImportOntology(ROOT, engineRdfOntologyReader());
		expect(engine.xmlns).toEqual(ONT.xmlns);
		expect([...engine.children]).toEqual([...ONT.children]);
		expect([...engine.nodes]).toEqual([...ONT.nodes]);
		expect([...engine.tipos].sort()).toEqual([...ONT.tipos].sort());
		const graph = parseRdfGraph(OCRE, { baseIri: TYPE_IRI });
		expect(planRdfImport(engine, graph, { subject: TYPE_IRI, langs: LANGS })).toEqual(ocrePlan());
	});

	test('the engine reader on a tipo that does not exist', async () => {
		const reader = engineRdfOntologyReader();
		expect(await reader.properties('zzrdf999')).toBeNull();
		expect(await reader.children('zzrdf999')).toEqual([]);
		expect(await reader.tipoInfo('zzrdf999')).toEqual({
			model: null,
			translatable: false,
			html: false,
			number: false,
		});
	});

	test('the engine reader flags the number column and the markup render, from the engine', async () => {
		// test22: component_number, test17: component_text_area (repo-owned test TLD ontology)
		const reader = engineRdfOntologyReader();
		expect(await reader.tipoInfo('test22')).toMatchObject({
			model: 'component_number',
			html: false,
			number: true,
		});
		expect(await reader.tipoInfo('test17')).toMatchObject({
			model: 'component_text_area',
			html: true,
			number: false,
		});
	});

	test('the production languages: installed data langs with an ISO code, the current data lang', async () => {
		const langs = await engineRdfPlanLangs();
		expect(langs.data.length).toBeGreaterThan(0);
		for (const lang of langs.data) {
			expect(lang.code).toMatch(/^lg-/);
			expect(lang.alpha2).toMatch(/^[a-z]{2,3}$/);
		}
		expect(langs.data.some((lang) => lang.code === 'lg-nolan')).toBe(false);
		expect(langs.current).toMatch(/^lg-/);
	});
});
