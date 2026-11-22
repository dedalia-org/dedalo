/**
 * THE RECORD FIELD SET — what ONE record request asks the service for
 * (2026-09-24, WC-2026-09-24-external-record-field-set).
 *
 * A remote record is fetched ONCE per (service, section, remote id, lang), with
 * the UNION of the remote fields mapped by EVERY component_external of the
 * owning section, PLUS the field that carries the row's own id (the model's
 * `remoteIdPath`, default `id`). Every component then projects its own fields
 * from that one row (fields_map.ts mapRowToEntries).
 *
 * WHY, measured live against Zenon on 2026-09-24. Each component used to ask for
 * ITS OWN fields only (`field[]=title`). A service that answers only the fields
 * it is asked for (Zenon does) then returned a row WITHOUT `id`, so the identity
 * check (fields_map.ts defaultPickRow — the row's id must equal the requested
 * one) refused it, and every non-id column read `not_found`. And the per-component
 * field sets split one record into one request (and one cache entry) PER
 * COMPONENT — four GETs per Zenon record. v6 asked once per record with all of
 * the section's mapped fields; this restores that, keeping the identity check.
 *
 * THE UNION IS SECTION-WIDE, NOT CALLER-WIDE. It is computed here, from the
 * ontology, and applied inside the one row layer (cache.ts fetchExternalRows)
 * — so the cache key's field signature is the same for every caller (a cell's
 * own fallback fetch, the portal prepass, the export batch prefetch) and they
 * share one cache entry per record by construction, whatever each predicted.
 *
 * WHICH COMPONENTS. The component_external nodes of the section's own subtree
 * and of its REAL section's (a virtual section borrows its real section's
 * children — the ownership rule of component_external/value.ts), under THE
 * SECTION CONTAINMENT LAW (ontology/resolver.ts; getOrderedSubtree's section
 * walk). A component whose fields_map is malformed contributes nothing here: its
 * OWN derivation reports it `misconfigured`, and one cataloguing error must not
 * take the whole section's record fetch down with it. NOR does a field the
 * ADAPTER refuses (`acceptsRemoteField` — Zenon splices names into the URL and
 * takes bare identifiers only: `dc:title`, `publication-dates`). A parseable map
 * naming one used to enter the union, so `buildRecordRequest` refused EVERY
 * record request of the section (bad_config → each column of each record
 * `unavailable`, retryable, the wrong cause); now the name is left out, here
 * and from a caller's own fields, and only the component that maps it is
 * `misconfigured` (component_external/value.ts checks the same predicate).
 *
 * ORDER (it is part of the URL): the id field first, then the other fields in
 * ontology sibling order, deduped. Deterministic for a given ontology, so the
 * request bytes are stable.
 *
 * LIFECYCLE: `createOntologyCache` — the set is ontology-derived (fields_map
 * edits, added/removed components), so an ontology write drops it, exactly like
 * the row cache whose key it feeds, and like config.ts's binding cache (the
 * same lifecycle, same exposure: src/external may not import the db layer —
 * external_write_refusal_tripwire — so it cannot ask isInTransaction(); no
 * record read runs inside an ontology-write transaction, and the hub's
 * post-COMMIT clear drops whatever an in-flight read memoized).
 */

import { createOntologyCache } from '../core/ontology/cache_factory.ts';
import { getOrderedSubtree, getSectionRealTipo } from '../core/ontology/resolver.ts';
import { getExternalServiceForSection } from './config.ts';
import type { ExternalServiceModel, FieldsMapEntry } from './descriptor_types.ts';
import { ExternalServiceError, logExternalError } from './errors.ts';
import {
	parseFieldsMap,
	refusedRemoteFields,
	remoteFieldHead,
	remoteFieldsOf,
} from './fields_map.ts';

/**
 * `${service}|${sectionTipo}` → the remote fields its component_external nodes
 * map that the service accepts (id field excluded). Keyed by service too: the
 * adapter's acceptance is part of the answer.
 */
const mappedFieldsBySection = createOntologyCache<string, readonly string[]>();

/**
 * The remote fields mapped by every component_external of `sectionTipo`
 * (virtual-aware), minus any name `model` refuses (`acceptsRemoteField`).
 */
export async function sectionMappedRemoteFields(
	sectionTipo: string,
	model: ExternalServiceModel,
): Promise<readonly string[]> {
	const cacheKey = `${model.service}|${sectionTipo}`;
	const cached = mappedFieldsBySection.get(cacheKey);
	if (cached !== undefined) return cached;
	const roots = [sectionTipo];
	const realTipo = await getSectionRealTipo(sectionTipo);
	if (realTipo !== sectionTipo) roots.push(realTipo);
	const fields: string[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		for (const node of await getOrderedSubtree(root)) {
			if (node.model !== 'component_external') continue;
			let mapped: string[];
			try {
				mapped = remoteFieldsOf(
					parseFieldsMap((node.properties as { fields_map?: unknown } | null)?.fields_map, {
						tipo: node.tipo,
					}),
				);
			} catch {
				continue; // reported by that component's own derivation (misconfigured)
			}
			const refused = new Set(refusedRemoteFields(model, mapped));
			for (const field of mapped) {
				// A refused name is that component's own misconfiguration (value.ts
				// reports it), never the section's.
				if (seen.has(field) || refused.has(field)) continue;
				seen.add(field);
				fields.push(field);
			}
		}
	}
	mappedFieldsBySection.set(cacheKey, fields);
	return fields;
}

/**
 * THE REFUSED-NAME REPORT — the remote field names of ONE component's
 * `fieldsMap` the adapter refuses (`acceptsRemoteField`), in declaration order,
 * each such component logged as ONE `external.bad_config` line naming the tipo
 * and the names (the door dedups by content, so the record path —
 * component_external/value.ts — and the search path — dd_external_api.ts —
 * reporting the same component share one line per window). Empty = every name
 * accepted, nothing logged. Every door that leaves a refused name out of a
 * shared request asks THIS, so the name is never dropped silently.
 */
export function reportRefusedRemoteFields(
	model: ExternalServiceModel,
	componentTipo: string,
	sectionTipo: string,
	fieldsMap: readonly FieldsMapEntry[],
): string[] {
	const refused = refusedRemoteFields(model, remoteFieldsOf(fieldsMap));
	if (refused.length > 0) {
		logExternalError(
			new ExternalServiceError({
				service: model.service,
				kind: 'bad_config',
				sectionTipo,
				detail: `fields_map of ${componentTipo} names remote field(s) ${refused.map((f) => `'${f}'`).join(', ')} that ${model.service} refuses`,
			}),
		);
	}
	return refused;
}

/** Section tipo → whether its subtree (virtual-aware) holds a component_external. */
const ownsExternalBySection = createOntologyCache<string, boolean>();

/**
 * THE EXTERNAL-REFERENCE SECTION TEST — may a NON-ADDRESS id on `sectionTipo`
 * be a remote record's id? True when the section binds an external service
 * (`api_config`) AND owns a component_external (its own subtree or its real
 * section's — the same walk as the field set). That is the read path's own
 * law (relations/relation_core.ts: RECORD ABSENCE + a DERIVED model — a
 * non-address id has no matrix row by construction, so the derived model is
 * the half left to ask), never `api_config` alone: `rsc205` carries a stale
 * api_config, owns no component_external and holds only local rows, so a
 * non-address id there is junk, not a reference (2026-09-24 — the frontier
 * record key had passed `'abc'` on such a section as "external").
 *
 * THE ONE externality predicate: every "is this section external?" decision
 * asks it (the wire classifier, the section_id restore set, the frontier, the
 * export prefetch). There is no api_config-only boolean left to drift back to.
 *
 * THROWS on a binding that does not parse (getExternalServiceForSection): a
 * configuration error must not classify as anything; the caller decides.
 */
export async function isExternalReferenceSection(sectionTipo: string): Promise<boolean> {
	if ((await getExternalServiceForSection(sectionTipo)) === null) return false;
	const cached = ownsExternalBySection.get(sectionTipo);
	if (cached !== undefined) return cached;
	const roots = [sectionTipo];
	const realTipo = await getSectionRealTipo(sectionTipo);
	if (realTipo !== sectionTipo) roots.push(realTipo);
	let owns = false;
	for (const root of roots) {
		for (const node of await getOrderedSubtree(root)) {
			if (node.model === 'component_external') {
				owns = true;
				break;
			}
		}
		if (owns) break;
	}
	ownsExternalBySection.set(sectionTipo, owns);
	return owns;
}

/**
 * THE field set one record request carries: the id field, the section's mapped
 * fields, and any field a caller named that the section does not map (never
 * dropped — a caller's field is never silently lost; with the ownership rule no
 * legitimate caller names one, so the set, and the cache key, stay one per
 * section). The one exception: a name the adapter REFUSES is left out, from a
 * caller's fields too — carried, it would fail the request every component of
 * the record shares; its own component reports it `misconfigured` (value.ts).
 */
export async function recordRequestFields(
	model: ExternalServiceModel,
	sectionTipo: string,
	callerFields: Iterable<string>,
): Promise<string[]> {
	const out: string[] = [];
	const seen = new Set<string>();
	const accepts = model.acceptsRemoteField;
	const push = (field: string): void => {
		if (field.length === 0 || seen.has(field)) return;
		if (accepts !== undefined && !accepts(field)) return;
		seen.add(field);
		out.push(field);
	};
	push(remoteFieldHead(model.remoteIdPath ?? 'id'));
	for (const field of await sectionMappedRemoteFields(sectionTipo, model)) push(field);
	for (const field of callerFields) push(field);
	return out;
}
