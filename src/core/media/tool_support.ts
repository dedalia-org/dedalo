/**
 * MEDIA TOOL SUPPORT — resolve a media component's spec + identity + path options
 * from a tool request's options, and read its stored media items from the matrix.
 * Shared by the media tool handlers (tool_media_versions / tool_image_rotation /
 * tool_pdf_extractor / tool_posterframe).
 */

import { isMediaModel, type MediaTypeSpec, mediaTypeOf } from '../concepts/media.ts';
import { readMatrixRecord } from '../db/matrix.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	getTranslatableByTipo,
} from '../ontology/resolver.ts';
import { currentDataLang } from '../resolve/request_lang.ts';
import { resolveMediaPathOptions } from './ontology_path.ts';
import type { MediaIdentity, MediaPathOptions } from './path.ts';

/** The resolved context a media tool handler operates on. */
export interface MediaToolContext {
	spec: MediaTypeSpec;
	identity: MediaIdentity;
	pathOpts: MediaPathOptions;
	/** The stored media items for this component (files_info carriers), or []. */
	items: Record<string, unknown>[];
}

/** Options shape common to media tools. */
export interface MediaToolOptions {
	tipo?: unknown;
	component_tipo?: unknown;
	section_tipo?: unknown;
	section_id?: unknown;
	lang?: unknown;
}

/**
 * Read a component's stored media items (the files_info / original_* carriers)
 * for one record, or [] when the section has no matrix table or the key is unset.
 *
 * Split out of resolveMediaToolContext because the async paths need it on its
 * own: an AV transcode finishes long after the request that started it, so its
 * write-back must RE-READ the items at completion time instead of closing over
 * the stale snapshot the request held.
 */
export async function readStoredMediaItems(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
): Promise<Record<string, unknown>[]> {
	return storedMediaItemsOf(await readStoredMediaColumn(sectionTipo, sectionId), componentTipo);
}

/**
 * One record's WHOLE `media` column (every media component's stored items),
 * in one read — for a caller that asks about several components of the same
 * record (tool_export's media ZIP: an image, a pdf and an av column of one row
 * are three candidates of ONE record). Empty when the record or table is absent.
 */
export async function readStoredMediaColumn(
	sectionTipo: string,
	sectionId: number,
): Promise<Record<string, unknown>> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return {};
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	const mediaColumn = record?.columns.media;
	return mediaColumn !== null && typeof mediaColumn === 'object' && !Array.isArray(mediaColumn)
		? (mediaColumn as Record<string, unknown>)
		: {};
}

/** One component's stored items out of a record's media column (readStoredMediaColumn). */
export function storedMediaItemsOf(
	mediaColumn: Record<string, unknown>,
	componentTipo: string,
): Record<string, unknown>[] {
	const raw = mediaColumn[componentTipo];
	return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

/**
 * Resolve the media context for a tool request. Throws on a non-media component
 * or a missing target. `lang` defaults to the data lang for translatable
 * components, null otherwise (matches the identifier suffix rule).
 */
export async function resolveMediaToolContext(
	options: MediaToolOptions,
): Promise<MediaToolContext> {
	const componentTipo = String(options.tipo ?? options.component_tipo ?? '');
	const sectionTipo = String(options.section_tipo ?? '');
	const sectionId = Number(options.section_id);
	if (
		componentTipo === '' ||
		sectionTipo === '' ||
		!Number.isInteger(sectionId) ||
		sectionId <= 0
	) {
		throw new DedaloError('request.invalid_source', {
			message: 'media tool: tipo, section_tipo and a positive section_id are required',
			coordinates: { component_tipo: componentTipo, section_tipo: sectionTipo },
		});
	}
	const model = await getModelByTipo(componentTipo);
	if (model === null || !isMediaModel(model)) {
		throw new DedaloError('request.invalid_model', {
			message: `media tool: '${componentTipo}' is not a media component`,
			coordinates: { component_tipo: componentTipo, model: String(model) },
		});
	}
	const spec = mediaTypeOf(model);
	if (spec === null) {
		// unreachable after the isMediaModel gate above — fail loud, not silently
		throw new Error(`media tool: no media spec registered for model '${model}'`);
	}
	const translatable = await getTranslatableByTipo(componentTipo);
	// currentDataLang(), NOT config.menu.dataLang: the tools operate on the media
	// of the record the OPERATOR is looking at, and the client does not send `lang`
	// with these requests. Reading the install default made every user whose data
	// lang differs from it scan — and, since sync_files may MINT an item, write —
	// the wrong language's media. It falls back to the config default outside a
	// request scope, so nothing regresses for background callers.
	const lang =
		typeof options.lang === 'string' ? options.lang : translatable ? currentDataLang() : null;
	const identity: MediaIdentity = { componentTipo, sectionTipo, sectionId, lang };
	// RECORD-SCOPED: `additional_path`'s bucket and an image's `image_id` file stem
	// are this record's sibling values, so every media tool (and the ingest it
	// feeds) addresses the files PHP wrote (T1-10).
	const pathOpts = await resolveMediaPathOptions(componentTipo, sectionTipo, sectionId);

	// Read the stored media items (for files_info / external_source).
	const items = await readStoredMediaItems(sectionTipo, sectionId, componentTipo);
	return { spec, identity, pathOpts, items };
}
