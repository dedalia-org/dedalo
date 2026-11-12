/**
 * rdf GRAPH plan compiler (T1-4 / O09) — the compile half of the PHP
 * class.diffusion_rdf.php build_rdf_node port (frozen :537-995, v6
 * core/diffusion/class.diffusion_rdf.php for what frozen v7 lost).
 *
 * An rdf element does not publish columns: each owl:Class child publishes a
 * GRAPH. The class node and its descendants are compiled once into
 * SectionPlan.rdfClass (the graph shape) plus `fields` — one FieldPlan per
 * data-reading property, compiled by the SAME chain compiler every sql column
 * uses (injected as `compileChain`, so the resolver's ONE walker reads them —
 * spec §6: no third resolution walker).
 *
 * ONTOLOGY CONTRACT, read where the v7 data actually lives:
 * - element `properties.diffusion.{type:'rdf', service_name, service_type, xmlns}`
 *   — the v6→v7 migration moved `xmlns` under `diffusion` (frozen PHP still
 *   read the top level, so it never saw its own migrated namespaces);
 * - class/portal/typed-resource IRI: `process.base_uri_entity` (dd1010 entry
 *   titled `title`, 'self' = the node name) + `process.var_uri` (frozen PHP
 *   read a TOP-LEVEL `var_uri` for classes, a spelling no ontology carries);
 * - properties by `process.type`: get_data_uri, get_data_date,
 *   get_data_number, get_section_id, get_resource_link, get_portal,
 *   entity_publication_uri, default (literals: text_format / php_formula
 *   `{type:'empty'}` / ', ' join); model `rdf` = link to another class.
 *
 * EVERY ambiguity is a loud compile error (PlanCompileError lists them all),
 * never a guessed document: an unknown process type, a QName whose prefix is
 * in neither table, a class without entity_publication_uri, a base IRI not in
 * dd1010 (the PHP non-dd1010 branch is dead — it is called without the
 * section_id it needs), a var_uri with more than one component (jsonb keeps
 * no key order, so the concatenation order is unrecoverable), a malformed
 * get_data_date/number format, the v6 string php_formula, an `rdf` link
 * without component or class, and the relation_list `config` ddo
 * (resolve_configuration → filter_locators), which is not ported.
 */

import { getComponentModel } from '../../core/components/registry.ts';
import { nameOrLabelOf } from '../../core/ontology/labels.ts';
import { RDF_PREFIX_PATTERN, type RdfNamespaceTable } from '../resolve/rdf_graph_ir.ts';
import type {
	FieldPlan,
	RdfBaseRef,
	RdfClassPlan,
	RdfElementPlan,
	RdfPropertyPlan,
	RdfUriSpec,
	ResolveStep,
	SectionPlan,
} from './types.ts';
import type { OntologyIndex, VirtualTreeNode } from './virtual_tree.ts';

/** dd1010 — the publication-services section every base IRI lives in. */
export const PUBLICATION_SERVICES_SECTION = 'dd1010';

/** Depth guard for nested get_portal nodes (an ontology cycle must not hang). */
const MAX_PORTAL_DEPTH = 10;

/** What the compiler hands this module (no import back into compile.ts). */
export interface RdfCompileContext {
	index: OntologyIndex;
	namespaces: RdfNamespaceTable;
	resolveModel: (tipo: string) => Promise<string | null>;
	/** compile.ts buildDdoMap + compileSourceChain — the one chain compiler. */
	compileChain: (
		nodeTipo: string,
		properties: Record<string, unknown> | null,
		sectionTipo: string,
		label: string,
	) => Promise<ResolveStep[]>;
	errors: string[];
	warnings: string[];
}

type Process = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Element-level contract: namespaces + service_type. `element` is null when
 * the element is unusable (errors pushed); `namespaces` is returned either
 * way, so the classes still compile against them and EVERY refusal of the
 * element is reported in one pass.
 */
export function compileRdfElement(
	properties: Record<string, unknown> | null,
	errors: string[],
): { element: RdfElementPlan | null; namespaces: [string, string][] } {
	const diffusion = isRecord(properties?.diffusion) ? properties.diffusion : {};
	if (properties?.xmlns !== undefined) {
		errors.push(
			"rdf element: top-level 'xmlns' is the v6 spelling — declare the namespaces in properties.diffusion.xmlns",
		);
	}
	const namespaces: [string, string][] = [];
	const xmlns = diffusion.xmlns;
	if (xmlns !== undefined && !isRecord(xmlns)) {
		errors.push(
			'rdf element: properties.diffusion.xmlns must be an object {prefix: namespace IRI}',
		);
	} else if (isRecord(xmlns)) {
		for (const [prefix, uri] of Object.entries(xmlns)) {
			if (!RDF_PREFIX_PATTERN.test(prefix) || typeof uri !== 'string' || uri === '') {
				errors.push(
					`rdf element: xmlns entry ${JSON.stringify(prefix)}: ${JSON.stringify(uri)} is not a prefix → namespace IRI pair`,
				);
				continue;
			}
			namespaces.push([prefix, uri]);
		}
	}
	const rawServiceType = diffusion.service_type;
	const serviceType =
		typeof rawServiceType === 'number' ||
		(typeof rawServiceType === 'string' && rawServiceType !== '')
			? String(rawServiceType)
			: null;
	if (serviceType === null) {
		errors.push(
			'rdf element: missing properties.diffusion.service_type (the dd1020 publication service the dd1010 base IRIs are looked up by)',
		);
	}
	return { element: serviceType === null ? null : { namespaces, serviceType }, namespaces };
}

/** base_uri_entity → RdfBaseRef ('self' resolved), or null with an error. */
function baseRefOf(
	raw: unknown,
	nodeName: string,
	where: string,
	errors: string[],
): RdfBaseRef | null {
	if (!isRecord(raw)) {
		errors.push(`${where}: process.base_uri_entity is missing or not an object`);
		return null;
	}
	if (raw.section_tipo !== PUBLICATION_SERVICES_SECTION) {
		errors.push(
			`${where}: base_uri_entity.section_tipo ${JSON.stringify(raw.section_tipo)} — only '${PUBLICATION_SERVICES_SECTION}' (publication services) holds base IRIs`,
		);
		return null;
	}
	if (typeof raw.component_tipo !== 'string' || raw.component_tipo === '') {
		errors.push(`${where}: base_uri_entity.component_tipo is missing`);
		return null;
	}
	if (typeof raw.title !== 'string' || raw.title === '') {
		errors.push(`${where}: base_uri_entity.title is missing`);
		return null;
	}
	return {
		baseTitle: raw.title === 'self' ? nodeName : raw.title,
		baseComponentTipo: raw.component_tipo,
	};
}

/** process.base_uri_entity + process.var_uri → RdfUriSpec. */
async function uriSpecOf(
	ctx: RdfCompileContext,
	properties: Record<string, unknown> | null,
	nodeName: string,
	where: string,
): Promise<RdfUriSpec | null> {
	const process = isRecord(properties?.process) ? properties.process : {};
	if (properties?.var_uri !== undefined) {
		ctx.errors.push(`${where}: top-level 'var_uri' — declare it as process.var_uri`);
	}
	const base = baseRefOf(process.base_uri_entity, nodeName, where, ctx.errors);
	if (base === null) return null;
	const spec: RdfUriSpec = { ...base };
	const varUri = process.var_uri;
	if (varUri === undefined) return spec;
	if (!isRecord(varUri)) {
		ctx.errors.push(
			`${where}: process.var_uri must be an object {name: component tipo, '#': fragment}`,
		);
		return null;
	}
	const components = Object.entries(varUri).filter(([key]) => key !== '#');
	if (components.length > 1) {
		ctx.errors.push(
			`${where}: process.var_uri names ${components.length} components — their concatenation order is not recoverable from stored properties; use one`,
		);
		return null;
	}
	const fragment = varUri['#'];
	if (fragment !== undefined) {
		if (typeof fragment !== 'string') {
			ctx.errors.push(`${where}: process.var_uri '#' must be a string`);
			return null;
		}
		spec.fragment = fragment;
	}
	if (components.length === 1) {
		const componentTipo = (components[0] as [string, unknown])[1];
		const model = typeof componentTipo === 'string' ? await ctx.resolveModel(componentTipo) : null;
		if (typeof componentTipo !== 'string' || model === null) {
			ctx.errors.push(
				`${where}: process.var_uri component ${JSON.stringify(componentTipo)} is not an ontology node`,
			);
			return null;
		}
		spec.varUri = [{ componentTipo, model }];
	}
	return spec;
}

/** QName → IRI through the plan's table, or an error naming the node. */
function expandOrError(
	ctx: RdfCompileContext,
	qname: string,
	where: string,
	role: string,
): string | null {
	const iri = ctx.namespaces.expand(qname);
	if (iri === null) {
		ctx.errors.push(
			`${where}: ${role} '${qname}' is not an expandable QName (prefix declared neither in properties.diffusion.xmlns nor in the standard table)`,
		);
	}
	return iri;
}

/** A {key: datatype QName} format map, every datatype expanded. */
function formatMapOf(
	ctx: RdfCompileContext,
	raw: unknown,
	where: string,
): Record<string, string> | null {
	if (!isRecord(raw) || Object.keys(raw).length === 0) {
		ctx.errors.push(`${where}: process.format must be a non-empty object {key: datatype QName}`);
		return null;
	}
	const format: Record<string, string> = {};
	for (const [key, qname] of Object.entries(raw)) {
		const iri = typeof qname === 'string' ? expandOrError(ctx, qname, where, 'datatype') : null;
		if (typeof qname !== 'string')
			ctx.errors.push(`${where}: format.${key} must be a datatype QName`);
		if (iri === null) return null;
		format[key] = iri;
	}
	return format;
}

/**
 * The END ddos of a property's ddo_map (no other entry names them as parent)
 * — PHP build_rdf_node :697-704, the per-lang fallback slots. Auto maps (no
 * explicit ddo_map) are all ends.
 */
function endDdosOf(
	process: Process,
	relationTipos: string[],
): { tipo: string; id: string | null }[] {
	const map: Record<string, unknown>[] = Array.isArray(process.ddo_map)
		? process.ddo_map.filter(isRecord)
		: relationTipos.map((tipo) => ({ tipo }));
	const parents = new Set(map.map((ddo) => ddo.parent).filter((p) => typeof p === 'string'));
	return map
		.filter((ddo) => typeof ddo.tipo === 'string' && !parents.has(ddo.tipo))
		.map((ddo) => ({ tipo: ddo.tipo as string, id: typeof ddo.id === 'string' ? ddo.id : null }));
}

/** php_formula {type:'empty', sentence:'C ? T : E'} → its three templates. */
function emptyFormulaOf(
	raw: unknown,
	where: string,
	errors: string[],
): { condition: string; whenEmpty: string; otherwise: string } | null {
	if (typeof raw === 'string') {
		errors.push(
			`${where}: php_formula is a bare string (v6 spelling) — declare {"type":"empty","sentence":"\${a} ? \${b} : \${c}"}`,
		);
		return null;
	}
	if (!isRecord(raw) || raw.type !== 'empty' || typeof raw.sentence !== 'string') {
		errors.push(
			`${where}: php_formula must be {"type":"empty","sentence":"<cond> ? <then> : <else>"}`,
		);
		return null;
	}
	const [condition, rest] = raw.sentence.split(' ? ', 2);
	const [whenEmpty, otherwise] = (rest ?? '').split(' : ', 2);
	if (rest === undefined || otherwise === undefined) {
		errors.push(
			`${where}: php_formula sentence ${JSON.stringify(raw.sentence)} is not '<cond> ? <then> : <else>'`,
		);
		return null;
	}
	return { condition: condition as string, whenEmpty: whenEmpty as string, otherwise };
}

/** Accumulates one class's chain fields while its property tree compiles. */
interface ClassBuild {
	sectionTipo: string;
	fields: FieldPlan[];
}

/** Compile a property's source chain into a FieldPlan; false when it has none. */
async function addChainField(
	ctx: RdfCompileContext,
	build: ClassBuild,
	nodeTipo: string,
	model: string,
	name: string,
	properties: Record<string, unknown> | null,
	extra: Partial<FieldPlan> = {},
): Promise<boolean> {
	const process = isRecord(properties?.process) ? properties.process : {};
	if (Array.isArray(process.ddo_map)) {
		for (const ddo of process.ddo_map.filter(isRecord)) {
			if (ddo.config !== undefined) {
				ctx.errors.push(
					`rdf property '${nodeTipo}' (${name}): ddo '${String(ddo.tipo)}' declares a relation_list 'config' (resolve_configuration → filter_locators) — not ported; remove it or publish the target through its own ddo chain`,
				);
				return false;
			}
			if (typeof ddo.value_fn === 'string') {
				ctx.warnings.push(`rdf-value-fn:${ddo.value_fn}@${nodeTipo}`);
			}
		}
	}
	const sourceChain = await ctx.compileChain(nodeTipo, properties, build.sectionTipo, name);
	if (sourceChain.length === 0) {
		ctx.warnings.push(`rdf-property-without-source:${nodeTipo}`);
		return false;
	}
	build.fields.push({
		id: nodeTipo,
		columnName: name,
		sourceChain,
		transform: [],
		column: { fieldModel: model },
		policy: {},
		...extra,
	});
	return true;
}

/** Compile ONE property node (recursive through get_portal children). */
async function compileProperty(
	ctx: RdfCompileContext,
	build: ClassBuild,
	nodeTipo: string,
	depth: number,
): Promise<RdfPropertyPlan | null> {
	const node = await ctx.index.nodeOf(nodeTipo);
	if (node === null) {
		ctx.errors.push(`rdf property '${nodeTipo}': node not found in the ontology`);
		return null;
	}
	const name = nameOrLabelOf(node) ?? '';
	const where = `rdf property '${nodeTipo}' (${name})`;
	const properties = node.properties;
	const process = isRecord(properties?.process) ? properties.process : {};

	if (node.model === 'rdf') {
		const related = await ctx.index.relationTipos(nodeTipo);
		let component: { tipo: string; model: string } | null = null;
		for (const tipo of related) {
			const model = await ctx.resolveModel(tipo);
			if (model?.startsWith('component_')) {
				component = { tipo, model };
				break;
			}
		}
		const classTipo = (await ctx.index.relatedByModel(nodeTipo, 'owl:Class'))[0];
		if (component === null || classTipo === undefined) {
			ctx.errors.push(
				`${where}: an 'rdf' link node needs a related component AND a related owl:Class`,
			);
			return null;
		}
		if (getComponentModel(component.model)?.column !== 'relation') {
			ctx.errors.push(
				`${where}: link component '${component.tipo}' (${component.model}) stores no locators`,
			);
			return null;
		}
		return {
			kind: 'link',
			nodeTipo,
			componentTipo: component.tipo,
			componentModel: component.model,
			classTipo,
		};
	}

	const predicate = expandOrError(ctx, name, where, 'predicate');
	if (predicate === null) return null;
	const type = process.type ?? 'default';
	const common = { nodeTipo, predicate };
	const chain = { ...common, fieldId: nodeTipo };
	switch (type) {
		case 'default': {
			const relationTipos = await ctx.index.relationTipos(nodeTipo);
			const emptyFormula =
				process.php_formula === undefined
					? undefined
					: emptyFormulaOf(process.php_formula, where, ctx.errors);
			if (emptyFormula === null) return null;
			if (process.text_format !== undefined && typeof process.text_format !== 'string') {
				ctx.errors.push(`${where}: process.text_format must be a string`);
				return null;
			}
			if (!(await addChainField(ctx, build, nodeTipo, node.model, name, properties))) return null;
			const plan: Extract<RdfPropertyPlan, { kind: 'literal' }> = {
				...chain,
				kind: 'literal',
				endDdos: endDdosOf(process, relationTipos),
			};
			if (typeof process.text_format === 'string') plan.textFormat = process.text_format;
			if (emptyFormula !== undefined) plan.emptyFormula = emptyFormula;
			return plan;
		}
		case 'get_data_uri': {
			const base = baseRefOf(process.base_uri_entity, name, where, ctx.errors);
			if (base === null) return null;
			if (!(await addChainField(ctx, build, nodeTipo, node.model, name, properties))) return null;
			return { ...chain, kind: 'data_uri', base };
		}
		case 'get_data_date': {
			if (typeof process.get_date !== 'string' || process.get_date === '') {
				ctx.errors.push(`${where}: get_data_date needs process.get_date ('start' | 'end')`);
				return null;
			}
			const format = formatMapOf(ctx, process.format, where);
			if (format === null) return null;
			if (!(await addChainField(ctx, build, nodeTipo, node.model, name, properties))) return null;
			return { ...chain, kind: 'data_date', getDate: process.get_date, format };
		}
		case 'get_data_number': {
			const format = formatMapOf(ctx, process.format, where);
			if (format === null) return null;
			const added = await addChainField(ctx, build, nodeTipo, node.model, name, properties, {
				leafNumberTypes: true,
			});
			return added ? { ...chain, kind: 'data_number', format } : null;
		}
		case 'get_section_id': {
			if (!(await addChainField(ctx, build, nodeTipo, node.model, name, properties))) return null;
			return { ...chain, kind: 'section_id' };
		}
		case 'get_resource_link': {
			let base: RdfBaseRef | null = null;
			if (process.base_uri_entity !== undefined) {
				base = baseRefOf(process.base_uri_entity, name, where, ctx.errors);
				if (base === null) return null;
			}
			if (!(await addChainField(ctx, build, nodeTipo, node.model, name, properties))) return null;
			return { ...chain, kind: 'resource_link', base };
		}
		case 'get_portal': {
			if (depth >= MAX_PORTAL_DEPTH) {
				ctx.errors.push(
					`${where}: get_portal nesting deeper than ${MAX_PORTAL_DEPTH} (ontology cycle?)`,
				);
				return null;
			}
			const subject = await uriSpecOf(ctx, properties, name, where);
			if (subject === null) return null;
			const children: RdfPropertyPlan[] = [];
			for (const childTipo of await ctx.index.childTipos(nodeTipo)) {
				const child = await compileProperty(ctx, build, childTipo, depth + 1);
				if (child !== null) children.push(child);
			}
			return { ...common, kind: 'portal', subject, children };
		}
		case 'entity_publication_uri': {
			const subject = await uriSpecOf(ctx, properties, name, where);
			return subject === null ? null : { ...common, kind: 'typed_resource', subject };
		}
		default:
			ctx.errors.push(`${where}: unknown process.type ${JSON.stringify(type)}`);
			return null;
	}
}

/**
 * Compile one owl:Class node into the section's graph plan + chain fields.
 * Null on errors (pushed).
 */
export async function compileRdfSection(
	ctx: RdfCompileContext,
	classNode: VirtualTreeNode,
	sectionTipo: string,
): Promise<SectionPlan | null> {
	const name = classNode.label ?? '';
	const where = `rdf class '${classNode.tipo}' (${name}) → section '${sectionTipo}'`;
	if (classNode.model !== 'owl:Class') {
		ctx.errors.push(`${where}: an rdf element publishes owl:Class nodes, not '${classNode.model}'`);
		return null;
	}
	const typeUri = expandOrError(ctx, name, where, 'class name');
	const process = isRecord(classNode.properties?.process) ? classNode.properties.process : {};
	if (process.type !== 'entity_publication_uri') {
		ctx.errors.push(
			`${where}: process.type must be 'entity_publication_uri' (the class subject IRI)`,
		);
		return null;
	}
	const subject = await uriSpecOf(ctx, classNode.properties, name, where);
	if (typeUri === null || subject === null) return null;
	const build: ClassBuild = { sectionTipo, fields: [] };
	const properties: RdfPropertyPlan[] = [];
	for (const childTipo of classNode.directChildrenTipos) {
		const property = await compileProperty(ctx, build, childTipo, 0);
		if (property !== null) properties.push(property);
	}
	const rdfClass: RdfClassPlan = { classTipo: classNode.tipo, typeUri, subject, properties };
	return {
		sectionTipo,
		tableName: name,
		tableTipo: classNode.tipo,
		fields: build.fields,
		rdfClass,
	};
}

/** Every `link` must target a class the element publishes (its SectionPlan builds it). */
export function rdfLinkErrors(sections: SectionPlan[]): string[] {
	const classes = new Set(sections.map((section) => section.rdfClass?.classTipo));
	const errors: string[] = [];
	const visit = (properties: RdfPropertyPlan[]): void => {
		for (const property of properties) {
			if (property.kind === 'portal') visit(property.children);
			if (property.kind === 'link' && !classes.has(property.classTipo)) {
				errors.push(
					`rdf link '${property.nodeTipo}': owl:Class '${property.classTipo}' is not a class of this element (no section publishes it)`,
				);
			}
		}
	};
	for (const section of sections) visit(section.rdfClass?.properties ?? []);
	return errors;
}
