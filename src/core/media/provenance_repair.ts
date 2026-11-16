/**
 * THE PROVENANCE REPAIR — one kernel behind both regenerate doors
 * (tool_update_cache `update_cache`, tool_media_versions `sync_files`), T1-P04.
 *
 * PHP had ONE function for both doors, `component_media_common::
 * regenerate_component` (v6 :2668-2705, frozen v7 :3232-3278, step 1): when the
 * stored item of the request's data lang has no `original_file_name` and the
 * component declares `properties.target_filename`, the name is recovered from
 * that sibling component (read in lg-nolan, `$filename_data[0]`), and
 * `original_normalized_name` = `get_id() . '.' . lowercase(extension)` is set
 * when it is absent too; `Save()` then re-scanned files_info with the repaired
 * cue. The TS doors had drifted into two behaviours (sync_files: none;
 * update_cache: a private copy writing the wrong item, the wrong stem, the
 * extension's case, after the rescan) — so the stored provenance of a record
 * depended on which button the operator pressed.
 *
 * Two halves, so the lock stays short and the decision is taken on the LOCKED
 * value:
 *  - {@link resolveProvenanceRepair} — async (ontology + the record's sibling
 *    value), run BEFORE the row lock;
 *  - {@link applyProvenanceRepair} — PURE, run on the items read UNDER the row
 *    lock, BEFORE the rescan (PHP's Save re-scan reads the repaired cue). It
 *    fills only what is ABSENT, so a curator's upload committed meanwhile wins.
 *
 * NOT ported (owner decisions, T1-P04 OD-1/OD-2): PHP steps 2-3 (normalized
 * names guessed from the files on disk) and the `*_upload_date` keys (PHP used
 * the file's ctime). Wire: WC-2026-11-12-media-provenance-repair-one-kernel.
 */

import { type MatrixRecord, readMatrixRecord } from '../db/matrix.ts';
import {
	getMatrixTableFromTipo,
	getModelByTipo,
	getPropertiesByTipo,
} from '../ontology/resolver.ts';
import { readComponentItems } from '../resolve/component_data.ts';
import { siblingStringValues } from './ontology_path.ts';
import { type MediaIdentity, type MediaPathOptions, mediaFileId } from './path.ts';

/** A name recovered from the record's `target_filename` sibling. */
export interface ProvenanceRepair {
	readonly originalFileName: string;
}

export interface ProvenanceRepairInput {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
	/**
	 * The record in hand (update_cache's per-row read). Absent = read it here;
	 * `null` = the record does not exist (nothing to recover).
	 */
	record?: MatrixRecord | null;
}

/**
 * The RESOLUTION half: the name the component's `properties.target_filename`
 * sibling holds on this record, or null (no such property, no model, no
 * record, no non-empty value). The sibling is read the way PHP reads it in
 * lg-nolan: the lg-nolan items, else every item; the FIRST non-empty value.
 */
export async function resolveProvenanceRepair(
	input: ProvenanceRepairInput,
): Promise<ProvenanceRepair | null> {
	const targetTipo = await targetFilenameTipo(input.componentTipo);
	if (targetTipo === null) return null;
	const targetModel = await getModelByTipo(targetTipo);
	if (targetModel === null) return null;
	const record = input.record ?? (await readRecordUnlessGone(input));
	if (record === null) return null;
	const name = siblingStringValues(readComponentItems(record, targetTipo, targetModel))[0];
	return name === undefined ? null : { originalFileName: name };
}

/** The component's `properties.target_filename` tipo, or null. */
async function targetFilenameTipo(componentTipo: string): Promise<string | null> {
	const properties = (await getPropertiesByTipo(componentTipo)) as {
		target_filename?: unknown;
	} | null;
	const targetTipo = properties?.target_filename;
	return typeof targetTipo === 'string' && targetTipo !== '' ? targetTipo : null;
}

/** `record: null` from the caller = the record is gone; absent = read it here. */
async function readRecordUnlessGone(input: ProvenanceRepairInput): Promise<MatrixRecord | null> {
	if (input.record === null) return null;
	return await readRecord(input.sectionTipo, input.sectionId);
}

async function readRecord(sectionTipo: string, sectionId: number): Promise<MatrixRecord | null> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return null;
	return await readMatrixRecord(table, sectionTipo, sectionId);
}

/**
 * THE item a per-lang media write targets: the item of `lang` for a
 * translatable component, the first item otherwise; -1 = none. One rule for the
 * upload writer (files_info_persist buildUploadedMediaItems) and this repair.
 */
export function mediaItemTargetIndex(items: readonly unknown[], lang: string | null): number {
	if (lang === null) return items.length > 0 ? 0 : -1;
	return items.findIndex(
		(item) =>
			item !== null &&
			typeof item === 'object' &&
			((item as { lang?: unknown }).lang ?? null) === lang,
	);
}

/** Where the repair lands and how the normalized name's stem is built. */
export interface ProvenanceTarget {
	/** The request data lang for a translatable component, null otherwise. */
	lang: string | null;
	identityBase: Omit<MediaIdentity, 'lang'>;
	/** The record-scoped path options (an image's `image_id` stem names its files — PHP get_id). */
	pathOpts: MediaPathOptions;
}

/**
 * The extension of a recovered name, lowercased (PHP get_file_extension), or
 * null when it has none — or one that is no plain file extension: the value is
 * a curator's free text and the result becomes part of a file NAME.
 */
function normalizedExtension(fileName: string): string | null {
	const dot = fileName.lastIndexOf('.');
	if (dot < 0) return null;
	const extension = fileName.slice(dot + 1).toLowerCase();
	return /^[a-z0-9]+$/.test(extension) ? extension : null;
}

const isFilled = (value: unknown): boolean => typeof value === 'string' && value !== '';

/**
 * The APPLICATION half — PURE, on the items read under the row lock. The target
 * item gets `original_file_name` only when it has none ('' counts as none), and
 * `original_normalized_name` (`<file id>.<lowercase ext>`) only when that is
 * absent too. Never mutates the items it is handed.
 */
export function applyProvenanceRepair<T>(
	items: readonly T[],
	repair: ProvenanceRepair | null,
	target: ProvenanceTarget,
): { items: T[]; changed: boolean } {
	const result = [...items];
	if (repair === null) return { items: result, changed: false };
	const index = mediaItemTargetIndex(result, target.lang);
	const repaired = repairedItem(result[index], repair, target);
	if (repaired === null) return { items: result, changed: false };
	result[index] = repaired as T;
	return { items: result, changed: true };
}

/** The target item with its absent provenance filled, or null when nothing is to fill. */
function repairedItem(
	raw: unknown,
	repair: ProvenanceRepair,
	target: ProvenanceTarget,
): Record<string, unknown> | null {
	if (raw === null || typeof raw !== 'object') return null;
	const item = raw as Record<string, unknown>;
	if (isFilled(item.original_file_name)) return null;
	const repaired: Record<string, unknown> = {
		...item,
		original_file_name: repair.originalFileName,
	};
	const normalizedName = isFilled(item.original_normalized_name)
		? null
		: normalizedNameFor(repair, target);
	if (normalizedName !== null) repaired.original_normalized_name = normalizedName;
	return repaired;
}

/** `<file id>.<lowercase ext>` (PHP get_id + get_file_extension), or null with no extension. */
function normalizedNameFor(repair: ProvenanceRepair, target: ProvenanceTarget): string | null {
	const extension = normalizedExtension(repair.originalFileName);
	if (extension === null) return null;
	const stem = mediaFileId({ ...target.identityBase, lang: target.lang }, target.pathOpts);
	return `${stem}.${extension}`;
}
