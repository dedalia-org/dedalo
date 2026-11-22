/**
 * RAG embed-source resolution — turns a section's embed GROUPS (section_map
 * `rag.embed`, see config.ts) into the composite DOCUMENTS the indexer chunks
 * and embeds. This is the 2026-07-22 replacement of the literal-only
 * readComponentText extraction: each group's ddo_map is resolved through the
 * SAME request_config machinery the human section read uses (emitDdoData —
 * src/core/section/read.ts), so DEEP relation resolution (a mint relation →
 * its target's term components, to arbitrary depth) is inherited, never
 * re-implemented.
 *
 * RECORD-COHERENT, GROUP-SCOPED MODEL (user decision): a vector is a property
 * of the RECORD FACET (group), never of a user's view or a single component.
 * Per (group, dataLang) ONE document is built from the group's FULL definition
 * under a SYSTEM scope — whoever's save triggered the re-index, the document is
 * byte-identical, including components the saving user cannot read. Retrieval
 * enforces the human ACL per hit (record-level for `rag:` chunks); egress for
 * deep-resolved cross-section text is guarded via each doc's contributors
 * (stored in chunk_meta by the indexer).
 *
 * INDEX-TIME CONTEXT (request isolation): the read-path resolvers consume the
 * request ALS stores (currentDataLang / currentPrincipal). The drain and the
 * save-hook queue establish NEITHER, and the ambient scope of a save belongs to
 * the SAVER — which must never shape the vector. So every resolution here runs
 * inside its own runWithRequestContext(RAG_SYSTEM_PRINCIPAL) +
 * runWithRequestLangs({…, dataLang}) scope, looping the DATA langs explicitly
 * (never ALS-derived). Guarded by rag_index_scope_tripwire.
 */

import { config } from '../../config/config.ts';
import { type Ddo, SELF_SENTINEL } from '../../core/concepts/ddo.ts';
import type { MatrixRecord } from '../../core/db/matrix.ts';
import { readMatrixRecord } from '../../core/db/matrix.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getTermByTipo,
	getTranslatableByTipo,
} from '../../core/ontology/resolver.ts';
import {
	type DataItem,
	EmissionContext,
	type SectionsEnvelope,
} from '../../core/resolve/component_data.ts';
import { runWithRequestLangs } from '../../core/resolve/request_lang.ts';
import { emitDdoData } from '../../core/section/read.ts';
import type { Principal } from '../../core/security/permissions.ts';
import { runWithRequestContext } from '../../core/security/request_context.ts';
import { htmlToPlainText } from './component_text.ts';
import type { RagEmbedGroup } from './config.ts';

/**
 * The index-time identity: an explicit superuser, NOT `undefined`. `undefined`
 * is inconsistent across the two project-filter paths (skip-filter in
 * sql_assembler.ts:651 vs fail-closed 'none' in filter_projects.ts:74); an
 * explicit isGlobalAdmin principal resolves to deterministic FULL scope
 * everywhere. Frozen and request-independent (boot-stable) — module-level by
 * design, never a captured ambient identity.
 */
export const RAG_SYSTEM_PRINCIPAL: Principal = Object.freeze({
	userId: -1,
	isGlobalAdmin: true,
	isDeveloper: true,
});

/** One composite document to chunk+embed: a group's resolved text in one lang. */
export interface EmbedDoc {
	/** The group id (storage key = `rag:<group>`). */
	group: string;
	lang: string;
	text: string;
	/** Which components contributed, and which sections their text came from. */
	contributors: { componentTipo: string; sectionTipos: string[] }[];
}

/** The emit seam — production is emitDdoData; unit tests inject a fake. */
export type EmitDdoFn = typeof emitDdoData;

export interface EmbedSourceDeps {
	emitDdo: EmitDdoFn;
	readRecord: (
		table: string,
		sectionTipo: string,
		sectionId: number,
	) => Promise<MatrixRecord | null>;
	resolveMatrixTable: (sectionTipo: string) => Promise<string | null>;
	/** True when the tipo is a relation-family component (column 'relation'). */
	isRelation: (tipo: string) => Promise<boolean>;
	/** True when the entry's resolved text varies by data lang (translatable OR relation). */
	entryUsesLangs: (tipo: string) => Promise<boolean>;
	/** The component label used as the doc's structural header (null → tipo). */
	labelOf: (tipo: string, lang: string) => Promise<string | null>;
}

/** Production deps over the live resolver / matrix / read path. */
export function defaultEmbedSourceDeps(): EmbedSourceDeps {
	const isRelation = async (tipo: string): Promise<boolean> => {
		const model = await getModelByTipo(tipo);
		return model !== null && getColumnNameByModel(model) === 'relation';
	};
	return {
		emitDdo: emitDdoData,
		readRecord: readMatrixRecord,
		resolveMatrixTable: getMatrixTableFromTipo,
		isRelation,
		async entryUsesLangs(tipo) {
			if (await getTranslatableByTipo(tipo)) return true;
			// Relation values resolve to the TARGET's term text, which is
			// lang-dependent even though the relation component itself is not.
			return isRelation(tipo);
		},
		labelOf: getTermByTipo,
	};
}

/**
 * INDEX-TIME MODE RULE (2026-07-22, found live: a 2.1 MB transcription embedded
 * as 154 chars): `mode` selects each model's RENDER transform, and `'list'`
 * triggers the literal list-preview — component_text_area's emit hook
 * HTML-truncates to 130 chars (PHP get_list_value parity), which is silent
 * data loss in a vector. The rule (user decision — the map means what it says):
 *   - an EXPLICIT authored `mode` is honored verbatim (write `'edit'` for full
 *     text; `'list'` knowingly embeds the preview);
 *   - an ABSENT `mode` gets the embedding-sensible default: literals → `'edit'`
 *     (full value, top-level and deep children alike), relations → `'list'`
 *     (compact target-term own-config resolution — an edit-mode portal would
 *     expand the target's whole edit form).
 */
async function effectiveEmbedMap(ddoMap: Ddo[], deps: EmbedSourceDeps): Promise<Ddo[]> {
	const out: Ddo[] = [];
	for (const ddo of ddoMap) {
		if (ddo.mode !== undefined) {
			out.push(ddo); // explicit author intent wins
			continue;
		}
		const relation = await deps.isRelation(ddo.tipo).catch(() => false);
		out.push({ ...ddo, mode: relation ? 'list' : 'edit' });
	}
	return out;
}

export interface ResolveEmbedDocsInput {
	/** The tipo the RECORD is stored under — the VIRTUAL tipo for virtual sections. */
	sectionTipo: string;
	sectionId: number;
	groups: RagEmbedGroup[];
	/** The install's DATA langs (config.menu.projectsDefaultLangs). */
	langs: readonly string[];
	/** The no-lang code (DATA_NOLAN) for lang-independent groups. */
	nolan: string;
}

/**
 * Resolve every group of a record into its per-lang composite documents.
 * One matrix read serves ALL groups. Soft failures (missing record) → []; a
 * single misauthored ddo is dropped LOUDLY but deterministically (the doc stays
 * stable across re-index, so the hash-diff still converges).
 */
export async function resolveEmbedDocs(
	input: ResolveEmbedDocsInput,
	deps: EmbedSourceDeps = defaultEmbedSourceDeps(),
): Promise<EmbedDoc[]> {
	const { sectionTipo, sectionId, groups } = input;
	if (groups.length === 0) return [];

	const table = (await deps.resolveMatrixTable(sectionTipo)) ?? 'matrix';
	const record = await deps.readRecord(table, sectionTipo, sectionId);
	if (record === null) return [];

	const out: EmbedDoc[] = [];
	for (const group of groups) {
		// Full-value mode rewrite (see effectiveEmbedMap): literals → 'edit',
		// relations keep their authored mode.
		const embedMap = await effectiveEmbedMap(group.ddoMap, deps);
		const topLevel = embedMap.filter((d) => d.parent === undefined || d.parent === SELF_SENTINEL);
		if (topLevel.length === 0) continue;

		// A group resolves per data lang when ANY of its entries is lang-sensitive;
		// a fully lang-independent group resolves once under nolan (mirrors the
		// old extract() rule, lifted from component to group granularity).
		let usesLangs = false;
		for (const entry of topLevel) {
			if (await deps.entryUsesLangs(entry.tipo).catch(() => false)) {
				usesLangs = true;
				break;
			}
		}
		const docLangs = usesLangs && input.langs.length > 0 ? input.langs : [input.nolan];

		for (const lang of docLangs) {
			const doc = await resolveGroupDoc(group, embedMap, topLevel, record, input, lang, deps);
			if (doc !== null) out.push(doc);
		}
	}
	return out;
}

/** Resolve ONE (group, lang) document under the system index-time context. */
async function resolveGroupDoc(
	group: RagEmbedGroup,
	embedMap: Ddo[],
	topLevel: Ddo[],
	record: MatrixRecord,
	input: ResolveEmbedDocsInput,
	lang: string,
	deps: EmbedSourceDeps,
): Promise<EmbedDoc | null> {
	// The two ALS scopes: system principal (full resolution — the vector must
	// never encode the saver's privileges) + the EXPLICIT data lang of this doc.
	return runWithRequestContext(
		{
			principal: RAG_SYSTEM_PRINCIPAL,
			session: null,
			requestId: `rag-index-${input.sectionTipo}-${input.sectionId}`,
			clientIp: '',
		},
		() =>
			// lang-law-exempt(rag.embed.scope): the RAG indexer OPENS a system-principal scope; the index is install-wide, the data lang is passed per document
			runWithRequestLangs({ applicationLang: config.menu.applicationLang, dataLang: lang }, () =>
				resolveGroupDocInner(group, embedMap, topLevel, record, input, lang, deps),
			),
	);
}

async function resolveGroupDocInner(
	group: RagEmbedGroup,
	embedMap: Ddo[],
	topLevel: Ddo[],
	record: MatrixRecord,
	input: ResolveEmbedDocsInput,
	lang: string,
	deps: EmbedSourceDeps,
): Promise<EmbedDoc | null> {
	const row = { section_tipo: input.sectionTipo, section_id: input.sectionId };
	const parts: string[] = [];
	const contributors: EmbedDoc['contributors'] = [];

	for (const entry of topLevel) {
		const emission = new EmissionContext();
		try {
			// mode 'list' unless the ddo pins one — the read path's cell semantics
			// (the effective list config drives a relation's own-config children).
			await deps.emitDdo(
				entry,
				embedMap,
				record,
				row,
				entry.mode ?? 'list',
				lang,
				input.sectionTipo,
				emission,
				/* allowOwnConfigChildren */ true,
			);
		} catch (error) {
			// Loud but deterministic: a misauthored entry (unknown tipo) is dropped
			// the same way on every re-index, so the doc/hash stays stable. Never
			// silently — the operator must see the map is wrong.
			console.error(
				`rag: embed group '${group.id}' entry '${entry.tipo}' failed to resolve for ${input.sectionTipo}-${input.sectionId}: ${String(error)}`,
			);
			continue;
		}
		const harvest = harvestLeafText(emission.items);
		if (harvest.text === '') continue;

		const label = (await deps.labelOf(entry.tipo, lang).catch(() => null)) ?? entry.tipo;
		parts.push(`## ${label}\n${harvest.text}`);
		contributors.push({ componentTipo: entry.tipo, sectionTipos: harvest.sectionTipos });
	}

	if (parts.length === 0) return null;
	return { group: group.id, lang, text: parts.join('\n\n'), contributors };
}

/**
 * Flatten an emission into leaf TEXT + the section tipos that contributed.
 * Literal leaves carry string `entries[].value`; relation MAIN items carry
 * locator entries (no string value) and are skipped naturally — their resolved
 * term CHILD items (pushed by the relation resolver's recursion) carry the
 * strings and ARE harvested.
 */
function harvestLeafText(items: (SectionsEnvelope | DataItem)[]): {
	text: string;
	sectionTipos: string[];
} {
	const parts: string[] = [];
	const sections = new Set<string>();
	for (const item of items) {
		if ((item as SectionsEnvelope).typo === 'sections') continue;
		const dataItem = item as DataItem;
		if (!Array.isArray(dataItem.entries)) continue;
		let contributed = false;
		for (const entry of dataItem.entries) {
			const value = (entry as { value?: unknown } | null)?.value;
			if (typeof value === 'string' && value !== '') {
				const text = htmlToPlainText(value);
				if (text !== '') {
					parts.push(text);
					contributed = true;
				}
			}
		}
		if (contributed && typeof dataItem.section_tipo === 'string' && dataItem.section_tipo !== '') {
			sections.add(dataItem.section_tipo);
		}
	}
	return { text: parts.join('\n'), sectionTipos: [...sections] };
}
