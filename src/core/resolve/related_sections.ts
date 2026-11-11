/**
 * Related-sections payload — the "which records point at me" read the tools
 * issue as `source.action:'related_search'` + `sqo.mode:'related'` (PHP
 * dd_core_api `case 'related_search'` → sections::get_instance 'related_list').
 * Consumers (all in the TS-owned client, shapes pinned by WC-065):
 *  - tool_transcription's parent-record <select> (render_tool_transcription.js
 *    render_related_list) and tool_indexation's twin;
 *  - component_text_area's persons modal grouping (view_default_edit_text_area
 *    render_persons_list) — also embedded in edit data as
 *    `related_sections` by the text_area emit hook;
 *  - tool_tr_print's header block.
 *
 * Wire law (WC-065 — the v6-CLIENT shape, which is what the shipped client
 * reads; late-PHP sections_json emitted `entries`, unreadable by this client):
 *  - data[0] is ALWAYS the sections item `{typo:'sections', tipo, section_tipo,
 *    value:[locators]}` — even with zero hits (`value: []`), so the persons
 *    modal still renders the host record's own persons;
 *  - every section_id in the payload is CANONICAL — an int for a matrix record
 *    address (WC-2026-08-10-section-id-int-canonical, repealing the STRING half
 *    of WC-065); the clients group these ids with the hardened comparison, and
 *    the ids they group AGAINST come from this same payload, so both sides move
 *    together;
 *  - per-column data entries carry `value: string[]` (flat resolveCellValue
 *    strings, 0..1 elements) — the clients `join(' | ')` them raw;
 *  - context lists, per referencing section, the SECTION entry FIRST (the
 *    clients `find` by section_tipo and expect the section label), then one
 *    `{model, tipo, section_tipo, label}` entry per relation-list column.
 */

import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import { termByTipo } from '../ontology/labels.ts';
import { getModelByTipo } from '../ontology/resolver.ts';
import { findInverseReferences } from '../search/search_related.ts';
import type { Principal } from '../security/permissions.ts';
import { authorizedRelationListColumns, resolveCellValue } from './relation_list.ts';
import { currentDataLang } from './request_lang.ts';

export interface RelatedSectionsResult {
	context: Record<string, unknown>[];
	data: Record<string, unknown>[];
}

export interface RelatedSectionsOptions {
	/** Stamped on the sections item as `tipo` (the caller's source.tipo). */
	callerTipo: string;
	lang?: string;
	/** sqo.section_tipo axis — narrows the OWNING sections; 'all' = every. */
	sectionTipos?: string[] | 'all';
	/** sqo.limit — caps referencing records; false/undefined = all. */
	limit?: number | false;
	offset?: number;
	/**
	 * The caller (AUTHZ-05). When present, referencing records outside the
	 * caller's scope are excluded by the related search's SQL scope (D1) before
	 * the window is cut — no label or value of one is ever emitted.
	 * Undefined (internal callers) applies NO filter — the dispatch route
	 * ALWAYS passes it (the emit-hook path is ledgered, see rewrite/LEDGER.md).
	 */
	principal?: Principal;
}

export async function buildRelatedSections(
	// KEPT UNION: this is the CANONICALIZING ENTRANCE the read_facade
	// related_search door defers to — the host list arrives raw from the
	// transcription/indexation tools (legacy string ids) and may name an
	// external-service host whose remote id is a string by nature. The probe
	// below canonicalizes each locator; nothing upstream does.
	locators: { section_tipo: string; section_id: number | string }[],
	options: RelatedSectionsOptions,
): Promise<RelatedSectionsResult> {
	// Request-scoped data lang backstop (S2-28), never a hardcoded lang.
	const lang = options.lang ?? currentDataLang();

	// AUTHZ-05 / D1 — scoped IN the related search's SQL (record_scope
	// rowScopeFor): the window is cut from the caller's SCOPED owner sequence.
	const scope =
		options.principal === undefined
			? undefined
			: (await import('../security/record_scope.ts')).rowScopeFor(options.principal);
	const hits = await findInverseReferences(
		// Canonical address in — the index probe binds ::int, so String() minting
		// only leaked the legacy form outward (WC-2026-08-10-section-id-int-canonical).
		locators.map((l) => ({
			section_tipo: l.section_tipo,
			section_id: canonicalizeStoredSectionId(l.section_id) as string | number,
		})),
		{
			sectionTipos: options.sectionTipos ?? 'all',
			limit: options.limit ?? false,
			offset: options.offset,
			scope,
		},
	);

	// Distinct referencing records (the index has one row per relation edge;
	// a record referencing the host twice must list once).
	const seenRecords = new Set<string>();
	// `hit.section_id` is already an int off the relation index — emit it as-is.
	const records: { section_tipo: string; section_id: number }[] = [];
	for (const hit of hits) {
		const key = `${hit.section_tipo}_${hit.section_id}`;
		if (seenRecords.has(key)) continue;
		seenRecords.add(key);
		records.push({ section_tipo: hit.section_tipo, section_id: hit.section_id });
	}

	const context: Record<string, unknown>[] = [];
	const data: Record<string, unknown>[] = [
		// The sections item — ALWAYS present, first (see module doc wire law).
		{
			typo: 'sections',
			tipo: options.callerTipo,
			section_tipo: [] as string[],
			value: records,
		},
	];

	const unresolved: string[] = [];
	const columnsBySection = new Map<string, string[]>();
	for (const record of records) {
		// First sight of a section: SECTION context entry, then its columns.
		let columns = columnsBySection.get(record.section_tipo);
		if (columns === undefined) {
			// Only the columns the requester may read (STEP 5, the panel's rule).
			columns = await authorizedRelationListColumns(record.section_tipo);
			columnsBySection.set(record.section_tipo, columns);
			context.push({
				model: 'section',
				tipo: record.section_tipo,
				section_tipo: record.section_tipo,
				label: await termByTipo(record.section_tipo, lang),
			});
			for (const columnTipo of columns) {
				context.push({
					model: (await getModelByTipo(columnTipo)) ?? '',
					tipo: columnTipo,
					section_tipo: record.section_tipo,
					label: await termByTipo(columnTipo, lang),
				});
			}
		}
		for (const columnTipo of columns) {
			const value = await resolveCellValue(
				record.section_tipo,
				record.section_id,
				columnTipo,
				lang,
				unresolved,
			);
			data.push({
				model: (await getModelByTipo(columnTipo)) ?? '',
				tipo: columnTipo,
				section_tipo: record.section_tipo,
				section_id: record.section_id,
				value: value === null || value === '' ? [] : [value],
			});
		}
	}

	return { context, data };
}
