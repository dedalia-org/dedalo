/**
 * DISCOVERY tools — the ontology tier an LLM uses BEFORE touching records:
 * list the sections it may read, map a section's fields (labels, simplified
 * types, portal targets), resolve human names to tipos, and validate a
 * relational path. The golden rule these tools serve: NEVER guess a tipo —
 * resolve it (rewrite/ai/mcp_review.md §2).
 *
 * ACL honesty: dedalo_list_sections filters by the principal's real read
 * level (getPermissions >= 1), so discovery never advertises a section the
 * user could not open through the web client. Field/structure metadata for a
 * readable section is the same structure the client renders — no record data
 * is exposed here.
 */

import { z } from 'zod';
import { isValidTipo } from '../../../core/concepts/ontology.ts';
import { DedaloError } from '../../../core/errors/dedalo_error.ts';
import { labelByTipo, resolveLabel } from '../../../core/ontology/labels.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	getOrderedSubtree,
	getPropertiesByTipo,
	getSectionRealTipo,
	listSectionNodes,
	type OntologySubtreeNode,
} from '../../../core/ontology/resolver.ts';
import { buildRequestConfigForElement } from '../../../core/relations/request_config/build.ts';
import {
	extractSqoSectionTipos,
	type RequestConfigContext,
} from '../../../core/relations/request_config/explicit.ts';
import { currentApplicationLang, currentDataLang } from '../../../core/resolve/request_lang.ts';
import { assertValidTipo } from '../../../core/search/identifier_gate.ts';
import type { Principal } from '../../../core/security/permissions.ts';
import {
	type LabelCandidate,
	pickUnambiguous,
	resolveFieldCandidates,
	resolveSectionCandidates,
} from '../label_resolution.ts';
import { defineTool, type ToolSpec } from '../tool_spec.ts';

/**
 * Simplified field types for the agent view (adopted from the PHP
 * agent_view_builder SIMPLIFIED_TYPE_MAP, re-keyed to the TS model census in
 * src/core/components/). Unlisted component models fall back to 'text'.
 */
export const SIMPLIFIED_TYPE_MAP: Record<string, string> = {
	component_input_text: 'text',
	component_input_text_large: 'text',
	component_email: 'text',
	component_iri: 'text',
	component_text_area: 'html',
	component_html_text: 'html',
	component_number: 'number',
	component_calculation: 'number',
	component_section_id: 'number',
	component_date: 'date',
	component_geolocation: 'geo',
	component_portal: 'link',
	component_autocomplete: 'link',
	component_autocomplete_hi: 'link',
	component_select: 'link',
	component_select_lang: 'link',
	component_radio_button: 'link',
	component_check_box: 'link',
	component_relation_model: 'link',
	component_relation_parent: 'link',
	component_relation_children: 'link',
	component_relation_related: 'link',
	component_relation_index: 'link',
	component_dataframe: 'link',
	component_filter: 'link',
	component_filter_master: 'link',
	component_publication: 'link',
	component_external: 'link',
	component_av: 'media',
	component_image: 'media',
	component_pdf: 'media',
	component_svg: 'media',
	component_3d: 'media',
	component_json: 'misc',
	component_state: 'misc',
};

/** Models whose values are locator lists — they get a `target_sections` hint.
 * Exported for the ontology LLM-map export (llm_map.ts), which reuses the
 * same link/target semantics the live discovery tools apply. */
export const LINK_TARGET_MODELS: ReadonlySet<string> = new Set([
	'component_portal',
	'component_autocomplete',
	'component_autocomplete_hi',
	'component_select',
	'component_radio_button',
	'component_check_box',
	'component_relation_model',
	'component_relation_related',
	'component_relation_index',
	'component_dataframe',
]);

/**
 * Models excluded from the agent field map (PHP EXCLUDED_MODELS, TS census):
 * security surfaces, internal plumbing, and derived/inverse views an agent
 * must not write through.
 */
const EXCLUDED_MODELS: ReadonlySet<string> = new Set([
	'component_password',
	'component_security_access',
	'component_security_tools',
	'component_info',
	'component_inverse',
	'component_filter_records',
]);

/** One field of a section map. */
export interface SectionMapField {
	tipo: string;
	label: string | null;
	model: string;
	/** Simplified type: text | html | number | date | geo | link | media | misc. */
	type: string;
	/** For link fields: the section tipos this field's locators point at. */
	target_sections?: string[];
}

/**
 * List the sections the principal may READ (level >= 1), with their labels.
 * The census is ontology-cached; the per-section level check runs against the
 * user's in-memory permissions table, so this stays one DB roundtrip per
 * process, not per call.
 */
export async function listSections(
	principal: Principal,
	input: { lang?: string },
): Promise<{ sections: { tipo: string; label: string | null }[] }> {
	const { getPermissions } = await import('../../../core/security/permissions.ts');
	const sections: { tipo: string; label: string | null }[] = [];
	for (const node of await listSectionNodes()) {
		// Only real record-bearing sections (a matrix table resolves) …
		if ((await getMatrixTableFromTipo(node.tipo)) === null) continue;
		// … the principal may read.
		if ((await getPermissions(principal, node.tipo, node.tipo)) < 1) continue;
		sections.push({
			tipo: node.tipo,
			label:
				input.lang !== undefined ? resolveLabel(node.term, input.lang) : resolveLabel(node.term),
		});
	}
	return { sections };
}

/**
 * Resolve a section reference (tipo or human name) to exactly one section
 * tipo, or throw the coded ambiguity/not-found errors with candidates.
 */
export async function resolveSectionReference(reference: string): Promise<string> {
	const candidates = await resolveSectionCandidates(reference);
	const picked = pickUnambiguous(candidates);
	if (picked !== null) return assertValidTipo(picked.tipo, 'mcp.resolve.section');
	if (candidates.length === 0) {
		throw new DedaloError('resource.not_found', {
			publicMessage: `No section matches '${reference}'.`,
		});
	}
	throw new DedaloError('mcp.label_ambiguous', {
		publicMessage: `Several sections match '${reference}'.`,
		extend: {
			candidates: candidates.slice(0, 10),
		},
	});
}

/**
 * The component subtree of a section, filtered to agent-visible fields.
 * VIRTUAL sections carry no children of their own — their 'section'-model
 * relation names the REAL section whose components they render (the same fallback
 * findFirstDescendantTipoByModel / getMatrixTableFromTipo apply).
 */
export async function sectionFieldNodes(sectionTipo: string): Promise<OntologySubtreeNode[]> {
	const visible = (nodes: OntologySubtreeNode[]): OntologySubtreeNode[] =>
		nodes.filter(
			(node) =>
				typeof node.model === 'string' &&
				node.model.startsWith('component_') &&
				!EXCLUDED_MODELS.has(node.model),
		);
	const own = visible(await getOrderedSubtree(sectionTipo));
	if (own.length > 0) return own;
	const realTipo = await getSectionRealTipo(sectionTipo);
	if (realTipo !== sectionTipo) {
		return visible(await getOrderedSubtree(realTipo));
	}
	return own;
}

/**
 * Resolve a field reference (tipo or label) to exactly one component tipo of
 * a section — the write-tool twin of resolveSectionReference (coded
 * not_found / label_ambiguous with candidates).
 */
export async function resolveFieldReference(
	sectionTipo: string,
	reference: string,
): Promise<string> {
	// A well-formed tipo passes through the identifier gate directly — the SAME
	// format-only philosophy the human write path applies (membership is NOT
	// enforced anywhere in Dédalo; the projects-scope + level>=2 gates are the
	// authorization boundary, and over-restricting here would diverge from the
	// human API's parity contract — security pass F5, considered and declined).
	if (isValidTipo(reference)) {
		return assertValidTipo(reference, 'mcp.resolve.field');
	}
	const nodes = await sectionFieldNodes(sectionTipo);
	const candidates = resolveFieldCandidates(reference, nodes);
	const picked = pickUnambiguous(candidates);
	if (picked !== null) return assertValidTipo(picked.tipo, 'mcp.resolve.field');
	if (candidates.length === 0) {
		throw new DedaloError('resource.not_found', {
			publicMessage: `Field '${reference}' does not exist in section '${sectionTipo}'.`,
		});
	}
	throw new DedaloError('mcp.label_ambiguous', {
		publicMessage: `Several fields match '${reference}'.`,
		extend: {
			candidates: candidates.slice(0, 10),
		},
	});
}

/** Resolve a link component's target section tipos via its request_config.
 * Exported for the ontology LLM-map export (llm_map.ts). */
export async function linkTargetSections(
	componentTipo: string,
	sectionTipo: string,
	lang: string,
): Promise<string[]> {
	try {
		const properties = await getPropertiesByTipo(componentTipo);
		const context: RequestConfigContext = {
			ownerTipo: componentTipo,
			ownerSectionTipo: sectionTipo,
			mode: 'edit',
			ownerIsSection: false,
			lang,
		};
		const config = await buildRequestConfigForElement(properties, context);
		return extractSqoSectionTipos(config[0]);
	} catch {
		// A malformed request_config must not break discovery of the whole map.
		return [];
	}
}

/**
 * Describe one section: every agent-visible field with label, model,
 * simplified type, and (for link fields) target sections. Accepts a tipo or a
 * human name in any language.
 */
export async function describeSection(
	principal: Principal,
	input: { section: string; lang?: string },
): Promise<{
	section_tipo: string;
	label: string | null;
	fields: SectionMapField[];
}> {
	const sectionTipo = await resolveSectionReference(input.section);
	if ((await getModelByTipo(sectionTipo)) !== 'section') {
		throw new DedaloError('resource.not_found', {
			publicMessage: `'${sectionTipo}' is not a section.`,
		});
	}
	const { getPermissions } = await import('../../../core/security/permissions.ts');
	if ((await getPermissions(principal, sectionTipo, sectionTipo)) < 1) {
		// Same shape as an unknown section — existence is never confirmed.
		throw new DedaloError('resource.not_found', {
			publicMessage: `No section matches '${input.section}'.`,
		});
	}
	// An omitted lang is the REQUEST application lang (the request-language law,
	// T2 B10) — never a literal.
	const lang = input.lang ?? currentApplicationLang();
	const fields: SectionMapField[] = [];
	for (const node of await sectionFieldNodes(sectionTipo)) {
		const model = node.model as string;
		const field: SectionMapField = {
			tipo: node.tipo,
			label: resolveLabel(node.term, lang),
			model,
			type: SIMPLIFIED_TYPE_MAP[model] ?? 'text',
		};
		if (LINK_TARGET_MODELS.has(model)) {
			const targets = await linkTargetSections(node.tipo, sectionTipo, lang);
			if (targets.length > 0) field.target_sections = targets;
		}
		fields.push(field);
	}
	return {
		section_tipo: sectionTipo,
		label: await labelByTipo(sectionTipo, lang),
		fields,
	};
}

/**
 * Resolve a human name to ranked tipo candidates — sections by default, or a
 * field within a given section. Returns ALL candidates (never auto-picks):
 * the model chooses and then uses the tipo.
 */
export async function resolveOntologyName(
	_principal: Principal,
	input: { name: string; section_tipo?: string },
): Promise<{ candidates: (LabelCandidate & { model?: string | null })[] }> {
	if (input.section_tipo !== undefined) {
		const sectionTipo = assertValidTipo(input.section_tipo, 'mcp.resolve.section_tipo');
		const nodes = await sectionFieldNodes(sectionTipo);
		const candidates = resolveFieldCandidates(input.name, nodes);
		const withModels = await Promise.all(
			candidates.slice(0, 10).map(async (candidate) => ({
				...candidate,
				model: await getModelByTipo(candidate.tipo),
			})),
		);
		return { candidates: withModels };
	}
	const candidates = await resolveSectionCandidates(input.name);
	return {
		candidates: candidates.slice(0, 10).map((candidate) => ({ ...candidate, model: 'section' })),
	};
}

/**
 * Validate a relational path (section → link field → section → … → field) and
 * return the SQO path array a cross-section search filter needs. Each hop may
 * be a tipo or a human label; link hops are checked against the field's real
 * target sections, so an invalid traversal fails HERE with a precise message,
 * not deep in the SQL assembler.
 */
export async function resolvePath(
	_principal: Principal,
	input: { path: string[] },
): Promise<{ path: { section_tipo: string; component_tipo: string }[] }> {
	if (input.path.length < 2) {
		throw new DedaloError('request.invalid', {
			publicMessage: 'A path needs at least [section, field].',
		});
	}
	const steps: { section_tipo: string; component_tipo: string }[] = [];
	let sectionTipo = await resolveSectionReference(input.path[0] as string);
	let index = 1;
	while (index < input.path.length) {
		const fieldReference = input.path[index] as string;
		const nodes = await sectionFieldNodes(sectionTipo);
		const candidates = resolveFieldCandidates(fieldReference, nodes);
		const picked = pickUnambiguous(candidates);
		if (picked === null) {
			throw new DedaloError(
				candidates.length === 0 ? 'resource.not_found' : 'mcp.label_ambiguous',
				{
					publicMessage: `Field '${fieldReference}' of section '${sectionTipo}' ${candidates.length === 0 ? 'does not exist' : 'is ambiguous'}.`,
					extend: candidates.length === 0 ? undefined : { candidates: candidates.slice(0, 10) },
				},
			);
		}
		const componentTipo = assertValidTipo(picked.tipo, 'mcp.resolve_path.component');
		steps.push({ section_tipo: sectionTipo, component_tipo: componentTipo });
		index += 1;
		if (index >= input.path.length) break;
		// There are more hops: this field must be a link whose targets contain
		// the next section.
		const nextReference = input.path[index] as string;
		const nextSection = await resolveSectionReference(nextReference);
		const targets = await linkTargetSections(componentTipo, sectionTipo, currentDataLang());
		if (!targets.includes(nextSection)) {
			throw new DedaloError('request.invalid', {
				publicMessage: `Field '${componentTipo}' does not link to section '${nextSection}' (targets: ${targets.join(', ') || 'none'}).`,
			});
		}
		sectionTipo = nextSection;
		index += 1;
	}
	return { path: steps };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const READ_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export const DISCOVERY_SPECS: ToolSpec[] = [
	defineTool({
		name: 'dedalo_list_sections',
		title: 'List sections',
		description:
			'List every Dédalo section the configured user may read, as ' +
			'{tipo, label}. Call this FIRST to learn what exists; then ' +
			'dedalo_describe_section for the fields of one section.',
		tier: 'agent',
		write: false,
		annotations: { ...READ_ANNOTATIONS },
		inputShape: {
			lang: z
				.string()
				.optional()
				.describe('Label language, e.g. "lg-eng" or "lg-spa" (default: the interface language).'),
		},
		handler: listSections,
	}),
	defineTool({
		name: 'dedalo_describe_section',
		title: 'Describe a section',
		description:
			"Full field map of one section: every field's tipo, label, model, " +
			'simplified type (text/html/number/date/geo/link/media/misc) and, for ' +
			'link fields, the target section tipos. Accepts a section tipo or a ' +
			'human name in any language.',
		tier: 'agent',
		write: false,
		annotations: { ...READ_ANNOTATIONS },
		inputShape: {
			section: z
				.string()
				.describe('Section tipo (e.g. "rsc197") or human name (e.g. "People", "Personas").'),
			lang: z.string().optional().describe('Label language (default: the interface language).'),
		},
		handler: describeSection,
	}),
	defineTool({
		name: 'dedalo_resolve',
		title: 'Resolve a name to tipos',
		description:
			'Resolve a human name to ranked ontology tipo candidates — sections ' +
			'by default, or fields of one section when section_tipo is given. ' +
			'Accent- and case-insensitive. NEVER guess a tipo: resolve it here first.',
		tier: 'agent',
		write: false,
		annotations: { ...READ_ANNOTATIONS },
		inputShape: {
			name: z.string().describe('The human name to resolve, e.g. "People" or "Surname".'),
			section_tipo: z
				.string()
				.optional()
				.describe('Resolve field names within this section instead of section names.'),
		},
		handler: resolveOntologyName,
	}),
	defineTool({
		name: 'dedalo_resolve_path',
		title: 'Resolve a relational path',
		description:
			'Validate a relational path (section → link field → section → … → field), ' +
			'by tipo or human label, and return the SQO path array for cross-section ' +
			'search filters. Example: ["Oral History", "Informant", "People", "Surname"].',
		tier: 'agent',
		write: false,
		annotations: { ...READ_ANNOTATIONS },
		inputShape: {
			path: z
				.array(z.string())
				.min(2)
				.describe('Alternating section / link-field / … / leaf-field references.'),
		},
		handler: resolvePath,
	}),
];
