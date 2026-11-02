/**
 * tool_ontology handler — PHP tools/tool_ontology/class.tool_ontology.php.
 *
 * The single developer-only action set_records_in_dd_ontology: parse ontology
 * section records and (up)sert their dd_ontology rows.
 *
 * ADMISSION (ONT-2, before any search or write) — the server rule, deliberately
 * NARROWER than the tool's declared dd1350 (gate: ontology_projection_guard_native
 * G2e):
 *   - `ontology35` (a registry record) → ACTIVATION
 *     (ontology_state.syncOntologyActivation): a tld that still holds rows and
 *     DRIFTED is re-derived in full, a converged one has only its root
 *     re-planted, a tld with no rows is left empty. Nothing is retracted here
 *     (owner question Q1); only ontology_delete retracts a tld;
 *   - a governed `<tld>0` section → PROJECTION (setRecordsInDdOntology, the
 *     guarded primitive: a record parsing into another tld's namespace is an
 *     error line, nothing written);
 *   - anything else (`ontology1..N`, `localontology0`, `test3`, …) →
 *     request.invalid_options.
 *
 * Edit mode (section_id present) processes one record; LIST mode processes the
 * caller's live list SQO — which is REQUIRED, because the scope of a batch write
 * comes from the request or the request is refused (WC-043). PHP took that scope
 * from the session SQO and wrote nothing when it was missing; the TS port had no
 * session twin and silently substituted "every record of the section" instead.
 * The SQO's section axis must be EXACTLY `[section_tipo]` (or the bare string), so
 * every matched row IS a record of that section (the assembler scopes the whole query
 * to the axis) and the ids are read under it. A `children_recursive` sqo is REFUSED:
 * the search layer merges the ids of descendants of ANY section into one section_id
 * list that the axis then scopes (src/core/search/sql_assembler.ts
 * childrenRecursiveFilter), so it would select same-id records of this section the
 * caller never chose and miss the real descendants — a write acts on what it
 * addresses or not at all (gate: ontology_projection_guard_native G2d). On
 * `ontology35` list mode reaches every matched registry record's tld, so its cost is
 * bounded by syncOntologyActivation: only a DRIFTED tld is re-derived; a converged
 * one costs one parse plus its root re-plant.
 *
 * Developer gating is enforced by tool_request.ts (permission:'developer'); the
 * internal isDeveloper assert here is defense-in-depth (PHP assert_developer()).
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { syncOntologyActivation } from '../../../src/core/ontology/ontology_state.ts';
import { ONTOLOGY_MAIN_SECTION } from '../../../src/core/ontology/ontology_tipos.ts';
import { setRecordsInDdOntology } from '../../../src/core/ontology/ontology_write.ts';
import { requiredOntologyTld } from '../../../src/core/ontology/tld.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/**
 * The ontology write's own outcome object → the envelope. A refusal becomes the
 * registered throw (its per-check detail joins the LOG-only message, which the
 * operator reads in the console and the wire never sees); a success carries the
 * summary + the non-fatal per-record notes as PAYLOAD.
 */
function ontologyWriteResponse(
	outcome: { ok: boolean; msg: string; errors: string[] },
	context: ToolActionContext,
	sectionTipo: string,
): ToolResponse {
	if (!outcome.ok) {
		const detail = outcome.errors.length === 0 ? '' : ` — ${outcome.errors.join('; ')}`;
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_ontology', section_tipo: sectionTipo },
			message: `${outcome.msg}${detail}`,
		});
	}
	return ok(
		{ summary: outcome.msg, errors: outcome.errors },
		{ requestId: toolRequestId(context) },
	);
}

/** The request's section, admitted or refused (see the header). */
function admittedRoute(sectionTipo: string): 'activation' | 'projection' {
	if (sectionTipo === ONTOLOGY_MAIN_SECTION) return 'activation';
	if (requiredOntologyTld(sectionTipo) !== null) return 'projection';
	throw new DedaloError('request.invalid_options', {
		publicMessage: `section_tipo '${sectionTipo}' is not an ontology node section`,
	});
}

/** The ids of the request section's records its LIVE list sqo matches (see the header). */
async function matchedIds(
	sqoRaw: Record<string, unknown>,
	sectionTipo: string,
	context: ToolActionContext,
): Promise<number[]> {
	const { getSectionTipos, sanitizeClientSqo } = await import('../../../src/core/concepts/sqo.ts');
	const { buildSearchSql } = await import('../../../src/core/search/sql_assembler.ts');
	const { runSearch } = await import('../../../src/core/search/search_statement.ts');

	const sqo = sanitizeClientSqo(structuredClone(sqoRaw) as Record<string, unknown>);
	// The sqo's section axis IS the request's section: an sqo over another section
	// would hand that section's ids to this one's write (ONT-2). Both spellings the
	// engine reads are accepted ('x' and ['x'], getSectionTipos); gate G2c.
	const axis = getSectionTipos(sqo as Parameters<typeof getSectionTipos>[0]);
	if (axis.length !== 1 || axis[0] !== sectionTipo) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: `sqo section_tipo must be exactly ['${sectionTipo}']`,
		});
	}
	// Descendants are not addressable here yet (header; gate G2d).
	if ((sqo as { children_recursive?: unknown }).children_recursive === true) {
		throw new DedaloError('request.invalid_options', {
			publicMessage:
				'a children_recursive sqo cannot scope this action: descendants in other sections would be read as ids of this one',
		});
	}
	// Pagination is stripped: the action processes the whole MATCHED set, not the
	// visible page (PHP set_order([]) / set_limit(0) / set_offset(0)).
	(sqo as { limit?: unknown; offset?: unknown }).limit = null;
	(sqo as { limit?: unknown; offset?: unknown }).offset = 0;
	(sqo as { full_count?: unknown }).full_count = false;
	const built = await buildSearchSql(sqo, { principal: context.principal, idsOnly: true });
	const rows = (await runSearch(built)) as {
		section_id: number;
	}[];
	return rows.map((row) => Number(row.section_id));
}

export async function toolOntologySetRecords(context: ToolActionContext): Promise<ToolResponse> {
	if (!context.principal.isDeveloper) {
		throw new DedaloError('perm.developer_required', {
			coordinates: { tool: 'tool_ontology', action: 'set_records' },
		});
	}
	const sectionTipo =
		typeof context.options.section_tipo === 'string' ? context.options.section_tipo : '';
	if (sectionTipo === '') {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'section_tipo is required',
		});
	}
	const route = admittedRoute(sectionTipo);
	const rawSectionId = context.options.section_id;
	const sectionId =
		rawSectionId === undefined || rawSectionId === null || rawSectionId === ''
			? null
			: Number(rawSectionId);

	// EDIT mode: one record, scope is the id itself.
	if (sectionId !== null) {
		const edited =
			route === 'activation'
				? await syncOntologyActivation([sectionId], context.userId)
				: await setRecordsInDdOntology({ sectionTipo, sectionId, userId: context.userId });
		return ontologyWriteResponse(edited, context, sectionTipo);
	}

	// LIST mode: the scope is the caller's LIVE list sqo, and it is REQUIRED.
	// PHP rebuilt it from the session and failed closed when absent; TS has no
	// session-SQO twin, so the client sends it. There is deliberately NO
	// whole-section fallback — an absent sqo once meant "rewrite every record of
	// the section" (up to 4,654 on one button, 12,172 across the install), which
	// is exactly the runaway WC-043 closed for tool_update_cache. An unfiltered
	// list still matches the whole section, but EXPLICITLY.
	const sqoRaw = context.options.sqo;
	if (sqoRaw === null || typeof sqoRaw !== 'object' || Array.isArray(sqoRaw)) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'sqo is required (the scope to act on — no whole-section default; WC-043)',
		});
	}
	const sectionIds = await matchedIds(sqoRaw as Record<string, unknown>, sectionTipo, context);
	const listed =
		route === 'activation'
			? await syncOntologyActivation(sectionIds, context.userId)
			: await setRecordsInDdOntology({ sectionTipo, sectionIds, userId: context.userId });
	return ontologyWriteResponse(listed, context, sectionTipo);
}
