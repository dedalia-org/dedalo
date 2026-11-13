/**
 * rdf GRAPH BUILDER — the runtime half of the PHP class.diffusion_rdf.php
 * build_rdf_node port (frozen :537-995; v6 core/diffusion/class.diffusion_rdf.php
 * where frozen v7 lost behaviour). T1-4 / O09.
 *
 * One published record → one RdfGraph: its class subject, the triples of
 * every property, portal sub-resources, typed resources and — through `rdf`
 * link nodes — the class subjects of linked records, all in ONE document
 * (PHP diffuse_rdf publishes the selection only; linked records are inlined,
 * never queued). Values come from the resolver's ONE chain walker
 * (env.resolveField — spec §6, no third walker); this module only turns the
 * walked atoms into triples, rule for rule:
 *
 * - default → literals PER PUBLISHED LANG. v6 iterated every lang of the data
 *   (`get_dato_full`); frozen v7 read DEDALO_DATA_LANG only, a regression the
 *   real v5/v6 documents (~10 xml:lang literals per predicate) contradict. The
 *   langs are the plan's main lang plus every other plan lang the values
 *   carry, in plan order; an end ddo missing in a lang takes its main-lang
 *   value, else '' (:785-818). Then text_format (`${id}` → value, first value
 *   per id), php_formula {type:'empty'} (PHP empty() on the condition), or a
 *   ', ' join; strip_tags; an empty result publishes nothing.
 * - get_data_uri → the first stored IRI containing the base IRI
 *   (case-insensitive) as a resource;
 * - get_data_date → `value[get_date]` keys mapped through `format` → typed
 *   literals; get_data_number → the stored number's PHP type
 *   (integer/double) mapped through `format`;
 * - get_section_id → plain literal; get_resource_link → `<base><value>`;
 * - get_portal → a sub-resource linked only when one of its children
 *   produced a triple; entity_publication_uri → a standalone typed resource;
 * - `rdf` link → the first DEDALO_DIFFUSION_RESOLVE_LEVELS publishable
 *   locators (non-locators, other sections, missing and unpublishable records
 *   are skipped and EXTEND the cap — :612-650) built with their class; a
 *   record the run's principal may not read (DIFF-C frontier, env.linkAllowed)
 *   is skipped the same way — it would otherwise reach the PUBLIC document.
 *
 * Subject IRIs: the dd1010 publication-services record of
 * (DEDALO_ENTITY_ID, element service_type) — PHP resolve_entity_locator —
 * holds the base IRIs in a component_iri keyed by title. A base that does not
 * resolve REFUSES the subject (PHP built the relative junk IRI '' . id): the
 * record is not written (the resolver withdraws it — 'unpublish') and the run
 * report names element, class and title.
 */

import { config } from '../../config/config.ts';
import type { Sqo } from '../../core/concepts/sqo.ts';
import type { MatrixRecord } from '../../core/db/matrix.ts';
import { DedaloError } from '../../core/errors/index.ts';
import { readComponentItems } from '../../core/resolve/component_data.ts';
import { stripTags } from '../../core/resolve/html_text.ts';
import { getAlpha2FromCode } from '../../core/resolve/lang_names.ts';
import { runSearch } from '../../core/search/search_statement.ts';
import { buildSearchSql } from '../../core/search/sql_assembler.ts';
import type { MetaValueIR } from '../parsers/types.ts';
import type {
	PublicationPlan,
	RdfBaseRef,
	RdfClassPlan,
	RdfPropertyPlan,
	RdfUriSpec,
	SectionPlan,
} from '../plan/types.ts';
import { defaultPublicationValue } from './default_value.ts';
import { plainLiteral, RdfGraph, RdfLiteralError, typedLiteral } from './rdf_graph_ir.ts';

/** What the resolver lends the builder (no import back into resolver.ts). */
export interface RdfGraphEnv {
	plan: PublicationPlan;
	/** The SectionPlan whose rdfClass is `classTipo`. */
	sectionPlanOfClass(classTipo: string): SectionPlan | undefined;
	/** The ONE chain walker: a field's atoms for one record (no frontier). */
	resolveField(section: SectionPlan, fieldId: string, record: MatrixRecord): Promise<MetaValueIR[]>;
	loadRecord(sectionTipo: string, sectionId: number | string): Promise<MatrixRecord | null>;
	isPublishable(record: MatrixRecord): Promise<boolean>;
	/**
	 * THE DIFF-C FRONTIER for a record an `rdf` link INLINES: may the run's
	 * principal read it? A linked record reaches the PUBLIC document exactly
	 * like a frontier row does, so it answers the same question the row path's
	 * frontier answers (processBatch, door 'diffusion.frontier'): refused ⇒
	 * DROPPED with a ledger line (never loaded, never unpublished), the run goes on.
	 */
	linkAllowed(sectionTipo: string, sectionId: number | string): Promise<boolean>;
	/** component_iri item id → resolved (label-frame) title. */
	iriTitles(record: MatrixRecord, iriTipo: string): Promise<Map<string, string>>;
	/** Run-scoped memo of resolved base IRIs ('' key parts → null = unresolvable). */
	baseMemo: Map<string, string | null>;
	/** DEDALO_DIFFUSION_RESOLVE_LEVELS — the `rdf` link item cap. */
	maxLinkItems: number;
}

/** A property-level failure: the triple is missing, the document still lands. */
export interface RdfPropertyError {
	fieldId: string;
	message: string;
}

export interface RdfRecordGraph {
	graph: RdfGraph;
	errors: RdfPropertyError[];
}

/** dd1010 components the entity lookup keys on (PHP resolve_entity_locator). */
const SERVICES_SECTION = 'dd1010';
const SERVICES_ENTITY_COMPONENT = 'dd1016';
const ENTITIES_SECTION = 'dd1000';
const SERVICES_TYPE_COMPONENT = 'dd1037';
const SERVICE_TYPES_SECTION = 'dd1020';

/**
 * A subject IRI that cannot be built — refuses the subject, loudly. The
 * definition behind the publication (element, class, dd1010 services) is
 * what must be corrected, hence `ontology.invalid_node`.
 */
class RdfSubjectError extends DedaloError {
	readonly reportSentence: string;
	constructor(message: string, coordinates: Record<string, string>) {
		super('ontology.invalid_node', { message, coordinates });
		this.name = 'RdfSubjectError';
		this.reportSentence = message;
	}
}

/**
 * A definition the graph cannot be built from (`ontology.invalid_node`), whose
 * sentence this module AUTHORS for the run report — tipos and the rule broken,
 * never a caught exception's text.
 */
class RdfBuildError extends DedaloError {
	readonly reportSentence: string;
	constructor(message: string) {
		super('ontology.invalid_node', { message });
		this.name = 'RdfBuildError';
		this.reportSentence = message;
	}
}

/**
 * The sentence a caught build failure puts in the run report (SEC-18 / A6):
 * an authored sentence (RdfSubjectError, RdfBuildError, RdfLiteralError) as
 * written; anything else — a database or file failure, an engine fault — is
 * LOGGED with its coordinates and named in the report by its code only.
 */
export function rdfReportSentence(error: unknown, where: string): string {
	if (
		error instanceof RdfSubjectError ||
		error instanceof RdfBuildError ||
		error instanceof RdfLiteralError
	) {
		return error.reportSentence;
	}
	console.error(`[diffusion] rdf build failed at ${where}:`, error);
	const code = error instanceof DedaloError ? error.code : 'internal.unexpected';
	return `${where}: build failed (${code}) — details in the server log`;
}

/** The dd1010 record of (entity, service type), memoized per run. */
async function servicesRecord(env: RdfGraphEnv): Promise<MatrixRecord | null> {
	const serviceType = env.plan.rdf?.serviceType ?? '';
	const memoKey = `\u0000entity|${serviceType}`;
	if (env.baseMemo.has(memoKey)) {
		const id = env.baseMemo.get(memoKey);
		return id === null || id === undefined ? null : env.loadRecord(SERVICES_SECTION, id);
	}
	const locatorCondition = (component: string, section: string, id: string) => ({
		q: [{ section_id: id, section_tipo: section, from_component_tipo: component, type: 'dd151' }],
		q_operator: null,
		path: [
			{ section_tipo: SERVICES_SECTION, component_tipo: component, model: 'component_select' },
		],
	});
	const sqo: Sqo = {
		id: 'rdf_base_uri',
		mode: 'list',
		section_tipo: [SERVICES_SECTION],
		limit: 1,
		filter: {
			$and: [
				locatorCondition(
					SERVICES_ENTITY_COMPONENT,
					ENTITIES_SECTION,
					String(config.identity.entityId),
				),
				locatorCondition(SERVICES_TYPE_COMPONENT, SERVICE_TYPES_SECTION, serviceType),
			],
		},
	};
	const statement = await buildSearchSql(sqo);
	const rows = await runSearch<{ section_id: number }>(statement);
	const sectionId = rows[0]?.section_id ?? null;
	env.baseMemo.set(memoKey, sectionId === null ? null : String(sectionId));
	return sectionId === null ? null : env.loadRecord(SERVICES_SECTION, sectionId);
}

/**
 * The base IRI titled `baseTitle` in the services record (PHP
 * resolve_base_uri dd1010 branch). The title is the item's LABEL frame when
 * it has one (the v7 iri contract), else its legacy inline `title`.
 */
async function resolveBase(env: RdfGraphEnv, base: RdfBaseRef): Promise<string | null> {
	const memoKey = `${base.baseComponentTipo}|${base.baseTitle}`;
	if (env.baseMemo.has(memoKey)) return env.baseMemo.get(memoKey) ?? null;
	const record = await servicesRecord(env);
	let iri: string | null = null;
	if (record !== null) {
		const items = (readComponentItems(record, base.baseComponentTipo, 'component_iri') ?? []) as {
			id?: unknown;
			iri?: unknown;
			title?: unknown;
		}[];
		const frameTitles = await env.iriTitles(record, base.baseComponentTipo);
		for (const item of items) {
			const title = frameTitles.get(String(item.id)) ?? item.title;
			if (title === base.baseTitle && typeof item.iri === 'string' && item.iri !== '') {
				iri = item.iri;
				break;
			}
		}
	}
	env.baseMemo.set(memoKey, iri);
	return iri;
}

async function requireBase(env: RdfGraphEnv, base: RdfBaseRef, where: string): Promise<string> {
	const iri = await resolveBase(env, base);
	if (iri === null) {
		throw new RdfSubjectError(
			`${where}: no base IRI titled '${base.baseTitle}' in the publication services (dd1010) of entity ${config.identity.entityId} / service type '${env.plan.rdf?.serviceType ?? ''}'`,
			{ element: env.plan.elementTipo, title: base.baseTitle },
		);
	}
	return iri;
}

/** PHP resolve_var_uri: the record part of a subject IRI. */
async function subjectIri(
	env: RdfGraphEnv,
	spec: RdfUriSpec,
	record: MatrixRecord,
	where: string,
): Promise<string> {
	const base = await requireBase(env, spec, where);
	let part = '';
	if (spec.varUri === undefined) {
		part = String(record.section_id);
	} else {
		for (const { componentTipo, model } of spec.varUri) {
			const atoms = defaultPublicationValue(record, componentTipo, model, { tipo: componentTipo });
			const mainLang = env.plan.langPolicy.mainLang;
			const atom =
				atoms.find((candidate) => candidate.lang === null) ??
				atoms.find((candidate) => candidate.lang === mainLang);
			const value = atom?.kind === 'scalar' ? atom.value : null;
			if (value === null || value === '') {
				throw new RdfSubjectError(
					`${where}: var_uri component '${componentTipo}' is empty on ${record.section_tipo}:${record.section_id} — no subject IRI`,
					{ element: env.plan.elementTipo, component: componentTipo },
				);
			}
			part += String(value);
		}
	}
	return `${base}${part}${spec.fragment ?? ''}`;
}

/** Text entry of a literal property (PHP ddo_value {tipo,id,lang,value}). */
interface TextEntry {
	tipo: string | null;
	id: string | null;
	lang: string | null;
	value: string;
}

function textEntriesOf(atoms: MetaValueIR[], where: string): TextEntry[] {
	const entries: TextEntry[] = [];
	for (const atom of atoms) {
		if (atom.kind !== 'scalar') {
			throw new RdfBuildError(
				`${where}: a literal property resolved a '${atom.kind}' value — end its ddo chain on a text component`,
			);
		}
		if (atom.value === null) continue;
		const id = atom.meta?.sourceId;
		entries.push({
			tipo: atom.meta?.tipo ?? null,
			id: id === undefined || id === null ? null : String(id),
			lang: atom.lang,
			value: String(atom.value),
		});
	}
	return entries;
}

/** Replace every `${id}` of a template by the FIRST entry value per id (str_replace chain). */
function fillTemplate(template: string, entries: TextEntry[], nullAs: string): string {
	let text = template;
	for (const entry of entries) {
		if (entry.id === null) continue;
		text = text.split(`\${${entry.id}}`).join(entry.value ?? nullAs);
	}
	return text;
}

/** The default branch: one literal per published lang. */
function literalTriples(
	env: RdfGraphEnv,
	property: Extract<RdfPropertyPlan, { kind: 'literal' }>,
	atoms: MetaValueIR[],
	subject: string,
	graph: RdfGraph,
): boolean {
	const where = `rdf property '${property.nodeTipo}'`;
	const entries = textEntriesOf(atoms, where);
	const { langs, mainLang } = env.plan.langPolicy;
	const used = langs.filter(
		(lang) => lang === mainLang || entries.some((entry) => entry.lang === lang),
	);
	let produced = false;
	for (const lang of used) {
		const alpha2 = getAlpha2FromCode(lang);
		if (alpha2 === null) {
			throw new RdfBuildError(
				`${where}: publication lang '${lang}' has no ISO 639-1 code (xml:lang)`,
			);
		}
		const join = entries.filter((entry) => entry.lang === lang || entry.lang === null);
		for (const end of property.endDdos) {
			if (join.some((entry) => entry.tipo === end.tipo)) continue;
			const fallback = entries.find(
				(entry) => entry.lang === mainLang && entry.tipo === end.tipo && entry.id === end.id,
			);
			join.push({ tipo: end.tipo, id: end.id, lang, value: fallback?.value ?? '' });
		}
		let value: string;
		if (property.textFormat !== undefined) {
			value = fillTemplate(property.textFormat, join, '');
		} else if (property.emptyFormula !== undefined) {
			const condition = fillTemplate(property.emptyFormula.condition, join, ' ');
			value =
				condition === '' || condition === '0'
					? fillTemplate(property.emptyFormula.whenEmpty, join, ' ')
					: fillTemplate(property.emptyFormula.otherwise, join, ' ');
		} else {
			value = join.map((entry) => entry.value).join(', ');
		}
		const text = stripTags(value);
		if (text === '') continue;
		graph.add(subject, property.predicate, plainLiteral(text, alpha2));
		produced = true;
	}
	return produced;
}

/** Atoms of a non-literal kind must be what the property reads. */
function unexpected(where: string, atom: MetaValueIR, wanted: string): DedaloError {
	return new RdfBuildError(`${where}: resolved a '${atom.kind}' value where ${wanted} is read`);
}

/** get_data_uri: the first stored IRI containing the base (strripos). */
async function dataUriTriple(
	env: RdfGraphEnv,
	property: Extract<RdfPropertyPlan, { kind: 'data_uri' }>,
	atoms: MetaValueIR[],
	subject: string,
	graph: RdfGraph,
): Promise<boolean> {
	const where = `rdf property '${property.nodeTipo}'`;
	const base = (await requireBase(env, property.base, where)).toLowerCase();
	for (const atom of atoms) {
		if (atom.kind !== 'json' || !Array.isArray(atom.value)) {
			throw unexpected(where, atom, 'a component_iri value');
		}
		for (const item of atom.value as { iri?: unknown }[]) {
			const iri = typeof item?.iri === 'string' ? item.iri : '';
			if (iri !== '' && iri.toLowerCase().includes(base)) {
				graph.add(subject, property.predicate, { kind: 'resource', uri: iri });
				return true;
			}
		}
	}
	return false;
}

/** get_data_date: `value[get_date]` key → typed literal through `format`. */
function dataDateTriples(
	property: Extract<RdfPropertyPlan, { kind: 'data_date' }>,
	atoms: MetaValueIR[],
	subject: string,
	graph: RdfGraph,
): boolean {
	const where = `rdf property '${property.nodeTipo}'`;
	let produced = false;
	for (const atom of atoms) {
		if (atom.kind !== 'date') throw unexpected(where, atom, 'a component_date value');
		const point = (atom.value as Record<string, unknown> | null)?.[property.getDate];
		if (point === null || typeof point !== 'object') continue;
		for (const [key, raw] of Object.entries(point as Record<string, unknown>)) {
			const datatype = property.format[key];
			if (datatype === undefined) continue;
			if (typeof raw !== 'number' && typeof raw !== 'string') continue;
			const phpType =
				typeof raw === 'string' ? 'string' : Number.isInteger(raw) ? 'integer' : 'double';
			graph.add(subject, property.predicate, typedLiteral(raw, phpType, datatype));
			produced = true;
		}
	}
	return produced;
}

/** get_data_number: the stored value's PHP type selects the datatype. */
function dataNumberTriples(
	property: Extract<RdfPropertyPlan, { kind: 'data_number' }>,
	atoms: MetaValueIR[],
	subject: string,
	graph: RdfGraph,
): boolean {
	const where = `rdf property '${property.nodeTipo}'`;
	let produced = false;
	for (const atom of atoms) {
		if (atom.kind !== 'scalar') throw unexpected(where, atom, 'a number');
		const value = atom.value;
		if (value === null || typeof value === 'boolean') continue;
		const phpType = typeof value === 'string' ? 'string' : (atom.meta?.phpNumberType ?? 'integer');
		const datatype = property.format[phpType];
		if (datatype === undefined) continue;
		graph.add(subject, property.predicate, typedLiteral(value, phpType, datatype));
		produced = true;
	}
	return produced;
}

/** Scalar / locator values as IRI parts (section_id, resource_link). */
function valueParts(atoms: MetaValueIR[], where: string): string[] {
	const parts: string[] = [];
	for (const atom of atoms) {
		if (atom.kind === 'scalar') {
			if (atom.value !== null && atom.value !== '') parts.push(String(atom.value));
		} else if (atom.kind === 'chain') {
			for (const link of atom.links) parts.push(String(link.sectionId));
		} else {
			throw unexpected(where, atom, 'an id');
		}
	}
	return parts;
}

/** Mutable state of one record's graph build. */
interface BuildState {
	graph: RdfGraph;
	errors: RdfPropertyError[];
	/** `${classTipo}|${section_tipo}|${section_id}` already built (link cycles). */
	built: Set<string>;
}

async function chainProperty(
	env: RdfGraphEnv,
	section: SectionPlan,
	property: Exclude<RdfPropertyPlan, { kind: 'portal' | 'typed_resource' | 'link' }>,
	record: MatrixRecord,
	subject: string,
	graph: RdfGraph,
): Promise<boolean> {
	const atoms = await env.resolveField(section, property.fieldId, record);
	const where = `rdf property '${property.nodeTipo}'`;
	switch (property.kind) {
		case 'literal':
			return literalTriples(env, property, atoms, subject, graph);
		case 'data_uri':
			return dataUriTriple(env, property, atoms, subject, graph);
		case 'data_date':
			return dataDateTriples(property, atoms, subject, graph);
		case 'data_number':
			return dataNumberTriples(property, atoms, subject, graph);
		case 'section_id': {
			let produced = false;
			for (const part of valueParts(atoms, where)) {
				const text = stripTags(part);
				if (text === '') continue;
				graph.add(subject, property.predicate, plainLiteral(text, null));
				produced = true;
			}
			return produced;
		}
		case 'resource_link': {
			const base = property.base === null ? '' : await requireBase(env, property.base, where);
			const parts = valueParts(atoms, where);
			for (const part of parts) {
				graph.add(subject, property.predicate, { kind: 'resource', uri: `${base}${part}` });
			}
			return parts.length > 0;
		}
	}
}

/** One property of one record; failures land in state.errors, never abort the document. */
async function buildProperty(
	env: RdfGraphEnv,
	state: BuildState,
	section: SectionPlan,
	property: RdfPropertyPlan,
	record: MatrixRecord,
	subject: string,
): Promise<boolean> {
	try {
		switch (property.kind) {
			case 'portal': {
				const where = `rdf portal '${property.nodeTipo}'`;
				const uri = await subjectIri(env, property.subject, record, where);
				state.graph.resource(uri);
				let linked = false;
				for (const child of property.children) {
					if (await buildProperty(env, state, section, child, record, uri)) {
						state.graph.add(subject, property.predicate, { kind: 'resource', uri });
						linked = true;
					}
				}
				return linked;
			}
			case 'typed_resource': {
				const where = `rdf typed resource '${property.nodeTipo}'`;
				const uri = await subjectIri(env, property.subject, record, where);
				state.graph.resource(uri, property.predicate);
				return false;
			}
			case 'link':
				await buildLinks(env, state, property, record);
				return false;
			default:
				return await chainProperty(env, section, property, record, subject, state.graph);
		}
	} catch (error) {
		state.errors.push({
			fieldId: property.nodeTipo,
			message: rdfReportSentence(error, `rdf property '${property.nodeTipo}'`),
		});
		return false;
	}
}

/** `rdf` link: the linked records' class subjects, frontier-scoped, capped (skip ⇒ cap extends). */
async function buildLinks(
	env: RdfGraphEnv,
	state: BuildState,
	property: Extract<RdfPropertyPlan, { kind: 'link' }>,
	record: MatrixRecord,
): Promise<void> {
	const target = env.sectionPlanOfClass(property.classTipo);
	if (target?.rdfClass === undefined) return; // compile-time guaranteed (rdfLinkErrors)
	const locators =
		readComponentItems(record, property.componentTipo, property.componentModel) ?? [];
	let cap = env.maxLinkItems;
	for (let position = 0; position < locators.length && position < cap; position++) {
		const locator = locators[position] as { section_tipo?: unknown; section_id?: unknown } | null;
		const sectionId = locator?.section_id;
		if (
			locator === null ||
			typeof locator !== 'object' ||
			locator.section_tipo !== target.sectionTipo ||
			(typeof sectionId !== 'number' && typeof sectionId !== 'string')
		) {
			cap++;
			continue;
		}
		// DIFF-C: a linked record the run's principal cannot read is never read,
		// never inlined — a skip like any other (the cap extends).
		if (!(await env.linkAllowed(target.sectionTipo, sectionId))) {
			cap++;
			continue;
		}
		const linked = await env.loadRecord(target.sectionTipo, sectionId);
		if (linked === null || !(await env.isPublishable(linked))) {
			cap++;
			continue;
		}
		try {
			await buildClass(env, state, target, target.rdfClass, linked);
		} catch (error) {
			// One linked record without a subject IRI: named, the others still build.
			state.errors.push({
				fieldId: property.nodeTipo,
				message: rdfReportSentence(error, `rdf link '${property.nodeTipo}'`),
			});
		}
	}
}

/** One class subject + its properties for one record. */
async function buildClass(
	env: RdfGraphEnv,
	state: BuildState,
	section: SectionPlan,
	rdfClass: RdfClassPlan,
	record: MatrixRecord,
): Promise<void> {
	const key = `${rdfClass.classTipo}|${record.section_tipo}|${record.section_id}`;
	if (state.built.has(key)) return;
	state.built.add(key);
	const where = `rdf class '${rdfClass.classTipo}' (${section.tableName})`;
	const subject = await subjectIri(env, rdfClass.subject, record, where);
	state.graph.resource(subject, rdfClass.typeUri);
	for (const property of rdfClass.properties) {
		await buildProperty(env, state, section, property, record, subject);
	}
}

/**
 * The graph of ONE published record. Throws when the record's own subject
 * IRI cannot be built (the record must not be written); property failures
 * are returned as errors beside a graph that still lands.
 */
export async function buildRdfRecordGraph(
	env: RdfGraphEnv,
	section: SectionPlan,
	record: MatrixRecord,
): Promise<RdfRecordGraph> {
	const rdfClass = section.rdfClass;
	if (rdfClass === undefined) {
		throw new DedaloError('internal.invariant', {
			message: `rdf graph: section '${section.sectionTipo}' has no compiled class`,
		});
	}
	const state: BuildState = { graph: new RdfGraph(), errors: [], built: new Set() };
	await buildClass(env, state, section, rdfClass, record);
	return { graph: state.graph, errors: state.errors };
}
