/**
 * tool_export.get_export_grid — the flat export table (PHP tool_export +
 * export_tabulator NDJSON protocol: meta/col/row/end lines, three data
 * formats, breakdown explosion, streaming/buffered duality).
 *
 * The build lives ENTIRELY in the unified diffusion export engine
 * (src/diffusion/export/ — DIFFUSION_PLAN D8/P6): shared plan compiler +
 * resolver atom entry point + the export_tabulator placement port. This
 * handler is the tools-registry facade only.
 *
 * History: an in-file legacy walker (behind an env kill-switch) coexisted
 * here through the P6 migration; it was DELETED 2026-07-08 when the
 * deep-breakdown rebuild made the unified engine the single implementation
 * (the legacy math mis-placed multi-hop grid_value atoms — see
 * test/parity/tool_export_breakdown_differential.test.ts, the oracle gate
 * that pinned the rebuild).
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { getModelByTipo, getNode } from '../../../src/core/ontology/resolver.ts';
import { getParentTipo } from '../../../src/core/relations/children.ts';
import { componentHasCalculatedLocators } from '../../../src/core/relations/locator_source.ts';
import { buildRequestConfigForElement } from '../../../src/core/relations/request_config/build.ts';
import { extractSqoSectionTipos } from '../../../src/core/relations/request_config/explicit.ts';
import { getPermissions, type Principal } from '../../../src/core/security/permissions.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { exportGridUnified } from '../../../src/diffusion/api/export.ts';

/**
 * Build the export grid through the unified engine (see module doc).
 *
 * GATE (SEC-024 §9.2, PHP tool_export::get_export_grid): the declarative module
 * gate asserts read on `options.section_tipo` only. PHP ALSO runs
 * `assert_section_array_permission($sqo->section_tipo, 1)` — the SQO carries its
 * own section list and it does not have to be the one that passed the first
 * gate, so exporting a section the caller cannot read was one options key away.
 * The assembler's principal scoping is the per-record projects filter (dd170),
 * a different boundary from the dd774 section grant, so it does not cover this.
 */
export async function toolExportGetExportGrid(context: ToolActionContext): Promise<ToolResponse> {
	await assertExportSqoSections(context.principal, context.options);
	return exportGridUnified(context);
}

/**
 * THE SQO SECTION GATE, shared by every door that runs the export walk (the
 * stream above and the background artifact job, export_job.ts): level >= 1 on
 * EVERY `options.sqo.section_tipo` entry, a non-string entry refused (fail
 * closed). An absent sqo asserts nothing here — the engine then defaults to
 * `options.section_tipo`, which the declarative module gate already covered.
 */
export async function assertExportSqoSections(
	principal: Principal,
	options: Record<string, unknown>,
): Promise<void> {
	for (const target of exportSqoSectionTargets(options)) {
		const sectionTipo = typeof target === 'string' ? target : '';
		if (sectionTipo === '' || (await getPermissions(principal, sectionTipo, sectionTipo)) < 1) {
			throw new DedaloError('perm.denied', {
				coordinates: { tool: 'tool_export', sqo_section_tipo: sectionTipo },
			});
		}
	}
}

/** The raw `options.sqo.section_tipo` entries (scalar → one entry; absent → none). */
export function exportSqoSectionTargets(options: Record<string, unknown>): unknown[] {
	const sqoSections = (options.sqo as { section_tipo?: unknown } | undefined)?.section_tipo;
	return Array.isArray(sqoSections)
		? sqoSections
		: sqoSections === undefined || sqoSections === null
			? []
			: [sqoSections];
}

/** The `options.components` list of the two checkbox-gate actions ([] when invalid). */
function checkboxGateComponents(
	context: ToolActionContext,
): { tipo: string; section_tipo: string }[] {
	const raw = context.options.components;
	const components = Array.isArray(raw)
		? raw.filter(
				(entry): entry is { tipo: string; section_tipo: string } =>
					entry !== null &&
					typeof entry === 'object' &&
					typeof (entry as { tipo?: unknown }).tipo === 'string' &&
					typeof (entry as { section_tipo?: unknown }).section_tipo === 'string',
			)
		: [];
	if (components.length === 0) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'options.components must be a non-empty list of {tipo, section_tipo}',
		});
	}
	return components;
}

/**
 * tool_export.components_with_references — which of the given components
 * derive CALCULATED relations (T0-9 D4): the per-column "references" checkbox
 * renders only for these. THE predicate is the one compileExportPlan refuses a
 * forged flag with (locator_source.ts componentHasCalculatedLocators: a
 * component_relation_related with dd467 / dd621 directionality; dd620 and every
 * other model answer false). Pure ontology lookup — no record data leaves the
 * server.
 *
 * options.components: [{ tipo, section_tipo }]. Result: { [tipo]: boolean }.
 */
export async function toolExportComponentsWithReferences(
	context: ToolActionContext,
): Promise<ToolResponse> {
	const result: Record<string, boolean> = {};
	for (const component of checkboxGateComponents(context)) {
		if (result[component.tipo] !== undefined) continue;
		const model = (await getModelByTipo(component.tipo)) ?? '';
		result[component.tipo] = await componentHasCalculatedLocators(component.tipo, model);
	}
	return ok(result, { requestId: toolRequestId(context) });
}

/**
 * tool_export.components_with_parent — which of the given relation components
 * point at a section that has a component_relation_parent (i.e. whose targets
 * can carry an ancestor chain). Powers the client's per-column "parents"
 * checkbox visibility (WC-049: the checkbox only renders when the column's
 * target section is hierarchical). Target sections resolve through the SAME
 * request-config builder the datalist uses (explicit configs, hierarchy_types,
 * 'self', implicit ontology relations); a component with ANY hierarchical
 * target answers true. Pure ontology lookup — no record data leaves the server.
 *
 * options.components: [{ tipo, section_tipo }] — the component and its OWNER
 * section ('self' targets resolve against it). Result: { [tipo]: boolean }.
 */
export async function toolExportComponentsWithParent(
	context: ToolActionContext,
): Promise<ToolResponse> {
	const result: Record<string, boolean> = {};
	for (const component of checkboxGateComponents(context)) {
		if (result[component.tipo] !== undefined) continue;
		const node = await getNode(component.tipo);
		const config = await buildRequestConfigForElement(node?.properties ?? null, {
			ownerTipo: component.tipo,
			ownerSectionTipo: component.section_tipo,
			mode: 'list',
			ownerIsSection: false,
		});
		const targetSections = extractSqoSectionTipos(config[0]);
		let hasParent = false;
		for (const target of targetSections) {
			if ((await getParentTipo(target)) !== null) {
				hasParent = true;
				break;
			}
		}
		result[component.tipo] = hasParent;
	}
	return ok(result, { requestId: toolRequestId(context) });
}
