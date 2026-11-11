/**
 * MEDIA ZIP WRITER — the server twin of render_tool_export.js `download_media`:
 * every media file the export READ, at the quality the user chose per model,
 * in ONE store-only ZIP64 archive with an `info.txt` that lists what was
 * archived and what was not (and why).
 *
 * TWO INPUTS, ONE SET OF CHECKS (2026-09-24 — related media):
 *
 *  - DIRECT media columns (a top-level column whose own model is a media
 *    model — `col.path` one step long) are read from their CELLS, exactly as
 *    before (below): their archive is byte-identical to what it was — except
 *    that media the walk read for a cell that SHOWS NOTHING (a sidecar
 *    address with a null column: e.g. a record holding only the master) is
 *    archived from the sidecar, since no cell names it.
 *  - EVERYTHING ELSE the walk read media from — a portal's image child in a
 *    value cell (model component_portal, text mixing URLs and names), a
 *    grid_value portal→image column, a dedalo_raw portal's locators, at any
 *    depth — comes from the spool's MEDIA-ADDRESS SIDECAR (`media.ndjson`,
 *    src/diffusion/export/row_media.ts): the (section_tipo, section_id,
 *    component_tipo) of every media component the walk read with a stored
 *    file. No URL is parsed for them — separators are per component and
 *    `properties.image_id` names are arbitrary — and no cell text is trusted:
 *    a URL typed into a text field is never a candidate. Each address runs
 *    checks 1-2 below as the owner (the walk crossed into those records
 *    asserting only the record key, never the image component's grant, so
 *    this is the ONE gate on those bytes), then EVERY item the record holds
 *    NOW for that component goes through step 4 (target quality, own folder,
 *    denied names, realpath, regular file, dedupe). The address granularity
 *    (record, component) is exactly what the cell showed.
 *  - A spool without capture (manifest `media_models` absent: built before
 *    2026-09-24, or outside runExportArtifact) keeps the old reading — every
 *    column whose own model is a media model, from its cells — and every
 *    other column that may hold related media is listed in info.txt as
 *    'rerun_required' (loud, never guessed from URL text).
 *
 * WHAT A CELL IS TRUSTED FOR — only to NAME a record, never to name a file.
 * A candidate (a URL of a standard/value/grid cell, or a files_info file_path
 * of a dedalo_raw cell) is turned into a record address — by the media
 * file-name grammar (protection.ts MEDIA_FILENAME_GRAMMAR, the same one the
 * web-server rules use), and, for a top-level column of an export whose
 * SELECTION is one section (singleSelectionSection), by the row's own record too (a renamed file may FIT the grammar and parse
 * wrong: 'MIB_2023_45.jpg'); each address runs checks 1-3 and the first
 * whose record holds the candidate wins — and then EVERYTHING comes from the
 * database:
 *
 *   1. the component's model must be the column's media model;
 *   2. AUTHORIZATION, per file, as the job OWNER (re-resolved from the
 *      manifest, never an ambient scope): getRecordComponentPermission >= 1 on
 *      (section_tipo, component_tipo, section_id) AND principalCanAccessRecord
 *      (the projects filter). There is no media read predicate in the engine
 *      (the web server enforces media access by markers, and a logged-in user
 *      holding the media cookie reads every quality); this is STRICTER: a
 *      file is archived only when the owner could read the component on that
 *      very record. MASTERS (`original`/`modified`, protection.ts
 *      masterQualities) follow the SAME grant — no extra level — which is what
 *      the old client offered (`original` in the modal) minus every record the
 *      owner cannot read;
 *   3. the record's stored items must contain the candidate (an item whose
 *      files_info file_path the candidate ends with) — a crafted name that is
 *      not the record's own file is refused;
 *   4. the TARGET quality's file_path is READ from that item's files_info but
 *      TRUSTED only as a name inside the record's OWN folder: files_info is
 *      user-writable (the save path stores a media item as sent), so a stored
 *      path could otherwise name any file under the root — another user's
 *      import CSV, the .publication marker store — that the web server denies
 *      to everyone. The path must sit in the quality folder the media path
 *      grammar derives for the AUTHORIZED (component, section, id) at the
 *      target quality (buildMediaLocation's relativeDir — model folder,
 *      ontology media path, quality, bucket), its real path in that folder's
 *      real path (no symlink out of it); its name must not be a web-server
 *      working file (protection.ts MEDIA_WORKING_FILE_EXTENSIONS) or an
 *      active document, nor ANOTHER media record's canonical file (a name the
 *      grammar parses to a different address whose component is a media
 *      model — the bucket is shared by many records). A name the grammar does
 *      not parse to a media component stays allowed: legacy files renamed
 *      through `properties.image_id` live in that folder under any name. Then
 *      absoluteFromRelative + realpath (media-root confinement), and a
 *      regular file.
 *
 * Every refusal is listed in info.txt with a closed reason; nothing a user
 * may not read ever reaches the archive. Entries are STORED (media is already
 * compressed), streamed from disk in bounded chunks (archiveDiskFileCancellable: Stop is
 * checked per chunk), ZIP64 when a
 * size demands it (sizeHint = stat size). Names are the file's basename (the
 * client's naming: client-zip named an entry after the fetched URL's last
 * segment), duplicates renamed deterministically ('name (2).ext'); the same
 * physical file is archived once.
 *
 * `rows` in the result = media files archived (info.txt excluded).
 *
 * MEMORY: bounded by the files ARCHIVED, never by the candidates seen. The ZIP
 * central directory, the archived-file dedupe set and the "Downloaded files"
 * list are O(files archived) — inherent to the ZIP format (the central
 * directory is written last). The REFUSED candidates — which grow with the
 * selection (a quality most records lack, an owner outside most records'
 * projects) — never stay in memory: each is appended to an UNLINKED temp file
 * in the job directory (no name, so no leftover after a crash, freed when
 * closed) and streamed back into info.txt, which is itself a streamed entry.
 * The candidate memo (one DB check per distinct candidate) is a bounded window
 * of MEDIA_ZIP_MEMO_MAX candidates: a refused candidate repeated further apart
 * than that is checked, and listed, again. Nothing is O(bytes).
 *
 * DISK: the failure log is invisible to the store's quota measure (it has no
 * name) and no sink write runs while only refusals accrue, so every flush of it
 * is admitted first through the SINK's own meter (`sink.admitScratch`): the
 * user's quota counts it and the volume floor is re-checked before its bytes
 * land — `export.artifact_quota` / `export.storage_low` stop the build, never
 * a log that ran the volume down.
 */

import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, open, realpath, stat, unlink } from 'node:fs/promises';
import { basename, join, posix, sep } from 'node:path';
import {
	assertValidQuality,
	isMediaModel,
	type MediaTypeSpec,
	mediaTypeOf,
} from '../../../../src/core/concepts/media.ts';
import { DedaloError, isDedaloError } from '../../../../src/core/errors/index.ts';
import {
	normalizeZipEntryName,
	openZipStream,
	type ZipEntryInfo,
	type ZipEntryOptions,
	type ZipStreamWriter,
} from '../../../../src/core/files/zip.ts';
import { resolveMediaPathOptions } from '../../../../src/core/media/ontology_path.ts';
import {
	absoluteFromRelative,
	buildMediaLocation,
	type MediaPathOptions,
	requireMediaRoot,
} from '../../../../src/core/media/path.ts';
import {
	MEDIA_FILENAME_GRAMMAR,
	MEDIA_WORKING_FILE_EXTENSIONS,
} from '../../../../src/core/media/protection.ts';
import { MEDIA_ACTIVE_DOCUMENT_EXTENSIONS } from '../../../../src/core/media/svg_safety.ts';
import {
	readStoredMediaColumn,
	storedMediaItemsOf,
} from '../../../../src/core/media/tool_support.ts';
import { getModelByTipo } from '../../../../src/core/ontology/resolver.ts';
import {
	getRecordComponentPermission,
	type Principal,
	resolvePrincipal,
} from '../../../../src/core/security/permissions.ts';
import { principalCanAccessRecord } from '../../../../src/core/security/record_scope.ts';
import { exportPathMayReachMedia } from '../../../../src/diffusion/api/export.ts';
import { type ExportManifest, writeFully } from '../artifact_store.ts';
import type { SpoolColLine } from '../spool_reader.ts';
import { exportSqoSectionTargets } from '../tool_export.ts';
import { spreadsheetZipOptions } from './spreadsheet.ts';
import type { ExportWriter } from './types.ts';
import { throwIfCancelled } from './types.ts';

/** The listing entry every media archive carries (added last). */
export const MEDIA_ZIP_INFO_NAME = 'info.txt';

/** Why a candidate file is not in the archive (closed set, written into info.txt). */
export type MediaZipFailureReason =
	/** The cell could not be read (dedalo_raw JSON that does not parse). */
	| 'unreadable_cell'
	/** No record address: the name is outside the grammar and no row fallback applies. */
	| 'unidentified'
	/** The named component is not the column's media model. */
	| 'not_media'
	/** The owner has no read grant on the component of that record, or the record is outside their projects. */
	| 'not_authorized'
	/** The record's stored media does not contain the candidate. */
	| 'not_in_record'
	/** The record has no file at the requested quality. */
	| 'quality_unavailable'
	/** The requested quality is an external source (a URL, not a file on disk). */
	| 'external'
	/**
	 * The stored path is not the record's own file at that quality: outside the
	 * record's quality folder (traversal, symlink, another tree under the root),
	 * a web-server-denied name, another media record's canonical file — or a
	 * name no ZIP entry can carry as is (isArchivableEntryName).
	 */
	| 'invalid_path'
	/** The stored path names no regular file on disk. */
	| 'missing_file'
	/**
	 * A column of an export built WITHOUT media capture (manifest
	 * `media_models` absent) that may hold related media (a portal whose own
	 * children include a media component, a path through a media component,
	 * an img/av cell): its files cannot be addressed without guessing from
	 * URL text, so they are not archived — run the export again.
	 */
	| 'rerun_required';

export interface MediaZipFailure {
	file: string;
	reason: MediaZipFailureReason;
}

/** How long a candidate text may be when written into info.txt. */
const INFO_TEXT_MAX = 512;
/** The candidate memo's window (distinct candidates remembered at once). */
export const MEDIA_ZIP_MEMO_MAX = 4096;
/**
 * The per-RECORD memos' window (records remembered at once): a row's media
 * columns are candidates of ONE record, and a record is read and scoped once
 * while it is in the window — never once per candidate (the walk's own batch
 * read is prefetchExportRecords; this is the ZIP's per-row reuse).
 */
export const MEDIA_ZIP_RECORD_MEMO_MAX = 256;

/**
 * Insert into a bounded memo, evicting the OLDEST entry (Map insertion order)
 * when full — a hot key re-set moves to the end, so the window keeps what is
 * being used instead of dropping everything at once.
 */
function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
	if (map.has(key)) map.delete(key);
	else if (map.size >= limit) {
		const oldest = map.keys().next();
		if (oldest.done !== true) map.delete(oldest.value);
	}
	map.set(key, value);
}

/**
 * Can `name` be a ZIP entry AS IS? The zip writer refuses an unsafe name
 * (normalizeZipEntryName: an empty segment, a drive prefix, '..'), and a '\'
 * would be read as a folder separator: such a legacy on-disk name (a
 * `properties.image_id` rename may hold anything) is REFUSED as 'invalid_path'
 * in info.txt — one odd name never aborts the whole archive.
 */
export function isArchivableEntryName(name: string): boolean {
	if (name === '' || name.includes('\\') || name.includes('/')) return false;
	try {
		return normalizeZipEntryName(name) === name;
	} catch {
		return false;
	}
}
/** Buffered bytes of the failure log before a write to its temp file. */
const FAILURE_LOG_FLUSH_BYTES = 64 * 1024;

/**
 * THE REFUSED CANDIDATES, ON DISK. An unlinked temp file in the job directory
 * (opened, then its name removed at once: nothing to sweep after a crash, the
 * space freed when it is closed): one JSON line per failure, buffered, read
 * back once at the end as the pretty-printed "Failed files" array —
 * byte-identical to JSON.stringify(failures, null, 2) — without the list ever
 * being in memory.
 */
interface FailureLog {
	add(failure: MediaZipFailure): Promise<void>;
	/** The JSON.stringify(failures, null, 2) text, in chunks. */
	prettyChunks(): AsyncGenerator<string>;
	close(): Promise<void>;
}

async function openFailureLog(
	dir: string,
	/** Admits bytes against the build's quota + floor BEFORE they are written (sink.admitScratch). */
	admit: (bytes: number) => Promise<void>,
): Promise<FailureLog> {
	const path = join(dir, `.media_zip_failures.${randomUUID()}`);
	const handle: FileHandle = await open(path, 'wx+');
	try {
		await unlink(path);
	} catch (error) {
		await handle.close();
		throw error;
	}
	let buffer = '';
	let count = 0;
	let written = 0;
	const flush = async (): Promise<void> => {
		if (buffer === '') return;
		const bytes = Buffer.from(buffer, 'utf8');
		buffer = '';
		await admit(bytes.byteLength);
		written += await writeFully(handle, bytes, written);
	};
	return {
		async add(failure) {
			buffer += `${JSON.stringify({ file: failure.file, reason: failure.reason })}\n`;
			count++;
			if (buffer.length >= FAILURE_LOG_FLUSH_BYTES) await flush();
		},
		async *prettyChunks() {
			await flush();
			if (count === 0) {
				yield '[]';
				return;
			}
			yield '[\n';
			const decoder = new TextDecoder();
			const chunk = Buffer.alloc(FAILURE_LOG_FLUSH_BYTES);
			let position = 0;
			let carry = '';
			let first = true;
			let out = '';
			const emit = (line: string): void => {
				const pretty = JSON.stringify(JSON.parse(line), null, 2)
					.split('\n')
					.map((part) => `  ${part}`)
					.join('\n');
				out += first ? pretty : `,\n${pretty}`;
				first = false;
			};
			while (position < written) {
				const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
				if (bytesRead === 0) break;
				position += bytesRead;
				carry += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
				let newline = carry.indexOf('\n');
				while (newline !== -1) {
					emit(carry.slice(0, newline));
					carry = carry.slice(newline + 1);
					newline = carry.indexOf('\n');
				}
				if (out.length >= FAILURE_LOG_FLUSH_BYTES) {
					yield out;
					out = '';
				}
			}
			yield `${out}\n]`;
		},
		async close() {
			await handle.close();
		},
	};
}
/** The client's records separator for multi-valued cells (flat_table ' | '). */
const CELL_SEPARATOR = ' | ';

/**
 * The grammar with the COMPONENT tipo captured too. Derived from the ONE
 * constant (protection.ts) so it cannot drift from the web-server rules: its
 * greedy prefix `[^/]*` becomes the capture `([^/]*)`, the rest is verbatim
 * (captures: component_tipo, section_tipo, section_id).
 */
const GRAMMAR_PREFIX = '[^/]*';
if (!MEDIA_FILENAME_GRAMMAR.startsWith(GRAMMAR_PREFIX)) {
	throw new DedaloError('internal.invariant', {
		message: 'media_zip: MEDIA_FILENAME_GRAMMAR no longer starts with its greedy prefix',
	});
}
const FILE_NAME_WITH_COMPONENT = new RegExp(
	`^([^/]*)${MEDIA_FILENAME_GRAMMAR.slice(GRAMMAR_PREFIX.length)}`,
);

export interface MediaRecordAddress {
	componentTipo: string;
	sectionTipo: string;
	sectionId: number;
}

/** Parse a media file name (`{component}_{section}_{id}[_lg-x].{ext}`) into its record address. */
export function parseMediaFileName(name: string): MediaRecordAddress | null {
	const match = FILE_NAME_WITH_COMPONENT.exec(name);
	if (match === null) return null;
	const [, componentTipo, sectionTipo, sectionIdText] = match;
	const sectionId = Number(sectionIdText);
	if (!componentTipo || !sectionTipo || !Number.isSafeInteger(sectionId) || sectionId < 1) {
		return null;
	}
	return { componentTipo, sectionTipo, sectionId };
}

/**
 * The target quality per media model: `options.mediaQualities[model]`, else
 * `options.mediaQuality` (one quality for every model), else the model's
 * default quality. Every quality is validated against its model's ladder
 * (`media.invalid_quality`) BEFORE anything is written; a key of
 * `mediaQualities` that is not a media model is `request.invalid_options`.
 */
export function resolveMediaZipQualities(
	models: Iterable<string>,
	options: { mediaQuality?: string; mediaQualities?: unknown },
): Map<string, { spec: MediaTypeSpec; quality: string }> {
	const perModel = options.mediaQualities;
	if (perModel !== undefined && perModel !== null) {
		if (typeof perModel !== 'object' || Array.isArray(perModel)) {
			throw new DedaloError('request.invalid_options', {
				message: 'media_zip: mediaQualities must be an object {model: quality}',
			});
		}
		for (const key of Object.keys(perModel)) {
			if (!isMediaModel(key)) {
				throw new DedaloError('request.invalid_options', {
					message: `media_zip: mediaQualities key '${key.slice(0, 64)}' is not a media model`,
				});
			}
		}
	}
	const resolved = new Map<string, { spec: MediaTypeSpec; quality: string }>();
	for (const model of models) {
		if (resolved.has(model)) continue;
		const spec = mediaTypeOf(model);
		if (spec === null) continue;
		const requested =
			(perModel as Record<string, unknown> | null | undefined)?.[model] ??
			options.mediaQuality ??
			spec.defaultQuality;
		resolved.set(model, { spec, quality: assertValidQuality(spec, requested) });
	}
	return resolved;
}

/**
 * The artifact file-name variant (`media_<variant>.zip`, /^[a-z0-9]{1,32}$/)
 * for a quality choice: a readable slug of the qualities plus a hash of the
 * canonical choice, so two different choices never share a file name
 * ('1.5MB' and '<1MB' slug alike; their hashes do not).
 */
export function mediaZipVariant(options: {
	mediaQuality?: string;
	mediaQualities?: unknown;
}): string {
	const perModel =
		options.mediaQualities !== null && typeof options.mediaQualities === 'object'
			? (options.mediaQualities as Record<string, unknown>)
			: {};
	const canonical = JSON.stringify({
		all: options.mediaQuality ?? null,
		per: Object.keys(perModel)
			.sort()
			.map((key) => [key, perModel[key]]),
	});
	const words = [
		options.mediaQuality,
		...Object.keys(perModel)
			.sort()
			.map((key) => perModel[key]),
	]
		.filter((value) => typeof value === 'string')
		.join('')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
		.slice(0, 22);
	const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 10);
	return `${words}${hash}`;
}

function truncate(text: string): string {
	return text.length > INFO_TEXT_MAX ? `${text.slice(0, INFO_TEXT_MAX)}…` : text;
}

/**
 * The candidate texts of one cell (URLs, or raw files_info paths); `unreadable`
 * is the cell's text when it could not be read at all.
 */
function cellCandidates(
	value: unknown,
	isRaw: boolean,
): { candidates: string[]; unreadable: string | null } {
	if (value === null || value === undefined || value === '') {
		return { candidates: [], unreadable: null };
	}
	const text = String(value);
	if (!isRaw) {
		const candidates = text
			.split(CELL_SEPARATOR)
			.map((part) => part.trim())
			.filter((part) => part !== '');
		return { candidates, unreadable: null };
	}
	// dedalo_raw: the pre-encoded {"dedalo_data": <data>} (or {dato, dataframe})
	let parsed: unknown;
	try {
		parsed = typeof value === 'string' ? JSON.parse(value) : value;
	} catch {
		return { candidates: [], unreadable: text };
	}
	let data = (parsed as { dedalo_data?: unknown } | null)?.dedalo_data ?? null;
	if (data !== null && !Array.isArray(data) && typeof data === 'object') {
		data = (data as { dato?: unknown }).dato ?? null;
	}
	if (!Array.isArray(data)) return { candidates: [], unreadable: null };
	const out: string[] = [];
	for (const item of data) {
		const filesInfo = (item as { files_info?: unknown } | null)?.files_info;
		if (!Array.isArray(filesInfo)) continue;
		// any stored file of the item names it; the target is re-read from the DB
		const named = filesInfo.find(
			(entry) =>
				typeof entry?.file_path === 'string' &&
				entry.file_path.startsWith('/') &&
				entry.external !== true,
		) as { file_path: string } | undefined;
		if (named !== undefined) out.push(named.file_path);
	}
	return { candidates: out, unreadable: null };
}

/** The path part of a candidate (query / fragment dropped) and its decoded twin. */
function candidatePaths(candidate: string): string[] {
	const path = candidate.replace(/[?#].*$/, '');
	const paths = [path];
	try {
		const decoded = decodeURI(path);
		if (decoded !== path) paths.push(decoded);
	} catch {
		/* not percent-encoded — keep the raw path only */
	}
	return paths;
}

interface StoredFileInfo {
	quality?: unknown;
	file_path?: unknown;
	file_exist?: unknown;
	external?: unknown;
}

/** Why ONE record address does not hold a candidate, by how far its checks got. */
type AddressRefusal = 'not_media' | 'not_authorized' | 'not_in_record';
const REFUSAL_STAGE: Readonly<Record<AddressRefusal, number>> = {
	not_media: 0,
	not_authorized: 1,
	not_in_record: 2,
};

function addressKey(address: MediaRecordAddress): string {
	return `${address.sectionTipo}/${address.sectionId}/${address.componentTipo}`;
}

/** Is `col` a DIRECT media column — top-level, its own model a media model? */
export function isDirectMediaColumn(col: SpoolColLine): boolean {
	return (
		typeof col.model === 'string' &&
		isMediaModel(col.model) &&
		Array.isArray(col.path) &&
		col.path.length === 1
	);
}

/**
 * May a column of an export built WITHOUT capture hold related media its
 * cells cannot address? (an img/av cell, or a declared path the export walk
 * can follow to a media component.) Read only to report the gap
 * ('rerun_required') — never to archive anything. The reach is the export
 * walk's OWN child selection (src/diffusion export atoms.ts
 * exportPathMayReachMedia — caller map, own config, frames, nested relations),
 * never a second reading of the config. Shared with the preview
 * (`media_rerun_required`), so the client offers the build that reports it.
 */
export async function legacyColumnMayHoldMedia(col: SpoolColLine): Promise<boolean> {
	if (col.cell_type === 'img' || col.cell_type === 'av') return true;
	const path = Array.isArray(col.path) ? (col.path as { component_tipo?: unknown }[]) : [];
	return exportPathMayReachMedia(path);
}

/** The media root, realpath'd (the symlink check compares real paths). */
async function realMediaRoot(): Promise<string> {
	const root = requireMediaRoot();
	try {
		return await realpath(root);
	} catch {
		return root;
	}
}

/** Extensions no archived name may carry: what the web server denies to everyone. */
const DENIED_EXTENSIONS: ReadonlySet<string> = new Set<string>([
	...MEDIA_WORKING_FILE_EXTENSIONS,
	...MEDIA_ACTIVE_DOCUMENT_EXTENSIONS,
]);

/** True when a file name carries a web-server-denied extension (case-insensitive). */
export function isDeniedMediaFileName(name: string): boolean {
	const dot = name.lastIndexOf('.');
	return dot !== -1 && DENIED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The ONE section whose records the export's ROWS are — or undefined when the
 * selection spans several (a row's `rec` is then ambiguous). Derived from the
 * SELECTION only: the exported section plus the SQO's target sections. Never
 * from `manifest.sections`, the export's READ set, which also holds every
 * section a ddo path steps through: a portal column into another section makes
 * that set two long without making any row ambiguous.
 */
export function singleSelectionSection(
	manifest: Pick<ExportManifest, 'section_tipo' | 'options'>,
): string | undefined {
	const selection = new Set<string>([manifest.section_tipo]);
	for (const target of exportSqoSectionTargets(manifest.options ?? {})) {
		if (typeof target === 'string' && target !== '') selection.add(target);
	}
	return selection.size === 1 ? manifest.section_tipo : undefined;
}

/**
 * Stream ONE file from disk into its own entry, checking the job's signal
 * before EVERY chunk. A master file can be tens of GB, and export_file lane
 * jobs have no default deadline: a per-file check (`addDiskFile`) would keep
 * reading and writing the whole file after Stop, holding its lane slot and
 * filling the temp file against the quota. The caller's catch aborts the
 * archive and the build door discards the sink.
 */
export async function archiveDiskFileCancellable(
	zip: ZipStreamWriter,
	name: string,
	path: string,
	options: ZipEntryOptions,
	signal: AbortSignal | undefined,
): Promise<ZipEntryInfo> {
	throwIfCancelled(signal);
	const entry = await zip.openEntry(name, options);
	for await (const chunk of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) {
		throwIfCancelled(signal);
		await entry.write(chunk);
	}
	throwIfCancelled(signal);
	return entry.close();
}

export const mediaZipWriter: ExportWriter = async (input, sink, signal) => {
	const { spool, manifest, options } = input;
	throwIfCancelled(signal);

	const cols = await spool.readCols();
	// Captured spool: the manifest records what the walk READ (row_media.ts).
	const capturedModels = Array.isArray(manifest.media_models)
		? manifest.media_models.filter(
				(model): model is string => typeof model === 'string' && isMediaModel(model),
			)
		: null;
	const allMediaCols = [...cols.values()]
		.filter((col) => typeof col.model === 'string' && isMediaModel(col.model))
		.sort((a, b) => a.i - b.i);
	// The columns read from their CELLS: every media-model column of an
	// uncaptured spool (the old reading); only the DIRECT ones of a captured one
	// — the rest of its media comes from the sidecar.
	const mediaCols: SpoolColLine[] =
		capturedModels === null ? allMediaCols : allMediaCols.filter(isDirectMediaColumn);
	const directOrdinals = new Set(mediaCols.map((col) => col.i));
	const qualities = resolveMediaZipQualities(
		[...mediaCols.map((col) => col.model as string), ...(capturedModels ?? [])],
		options,
	);
	const principal: Principal = await resolvePrincipal(Number(manifest.user_id));
	const dataFormat = String(
		(manifest.meta as { data_format?: unknown } | null)?.data_format ??
			(manifest.options as { data_format?: unknown } | null)?.data_format ??
			'',
	);
	const isRaw = dataFormat === 'dedalo_raw';
	const singleSection = singleSelectionSection(manifest);
	const readsSidecar = capturedModels !== null && capturedModels.length > 0;
	const rootReal = mediaCols.length > 0 || readsSidecar ? await realMediaRoot() : '';

	// the ZIP64 gate seam (options.zip64Limits) is the spreadsheets' one reader,
	// imported rather than copied; production passes nothing
	const zip = openZipStream(sink, { ...spreadsheetZipOptions(options), duplicates: 'rename' });
	const downloaded: string[] = [];
	const failures = await openFailureLog(spool.dir, (bytes) => sink.admitScratch(bytes));
	const archivedFiles = new Set<string>();
	// A bounded WINDOW (see MEMORY in the module doc), never O(candidates).
	const seenCandidates = new Set<string>();
	let files = 0;

	const fail = (file: string, reason: MediaZipFailureReason): Promise<void> =>
		failures.add({ file: truncate(file), reason });

	/** The row-record fallback of a top-level column of a one-section export. */
	const rowAddress = (col: SpoolColLine, rec: number | string): MediaRecordAddress | null => {
		const path = Array.isArray(col.path) ? col.path : [];
		const componentTipo = path.length === 1 ? path[0]?.component_tipo : undefined;
		const sectionId = Number(rec);
		if (
			singleSection === undefined ||
			typeof componentTipo !== 'string' ||
			componentTipo === '' ||
			!Number.isSafeInteger(sectionId) ||
			sectionId < 1
		) {
			return null;
		}
		return { componentTipo, sectionTipo: singleSection, sectionId };
	};

	/** Record scope verdicts (principalCanAccessRecord), per record — bounded window. */
	const recordInScope = new Map<string, boolean>();
	/** Each record's whole media column, read once per record — bounded window. */
	const recordMedia = new Map<string, Record<string, unknown>>();

	/**
	 * One address's verdict: the stored item of that record that contains the
	 * candidate — or why not (checks in order: model, authorization, containment).
	 */
	const recordItem = async (
		address: MediaRecordAddress,
		model: string,
		paths: string[],
	): Promise<{ item: unknown } | { refusal: AddressRefusal }> => {
		if ((await getModelByTipo(address.componentTipo)) !== model) return { refusal: 'not_media' };
		const read = await authorizedItems(address);
		if ('refusal' in read) return read;
		const item = read.items.find((stored) => {
			const filesInfo = (stored as { files_info?: unknown }).files_info;
			return (
				Array.isArray(filesInfo) &&
				filesInfo.some((entry: StoredFileInfo) => {
					const stored = entry?.file_path;
					return (
						typeof stored === 'string' &&
						stored.startsWith('/') &&
						paths.some((path) => path.endsWith(stored))
					);
				})
			);
		});
		return item === undefined ? { refusal: 'not_in_record' } : { item };
	};

	/**
	 * CHECK 2 — AUTHORIZATION, as the owner, BEFORE any read of the record or
	 * the disk — then the record's stored items of that component. The ONE
	 * check both inputs (cells and sidecar addresses) pass through.
	 */
	const authorizedItems = async (
		address: MediaRecordAddress,
	): Promise<{ items: unknown[] } | { refusal: 'not_authorized' }> => {
		const { componentTipo, sectionTipo, sectionId } = address;
		const level = await getRecordComponentPermission(
			principal,
			sectionTipo,
			componentTipo,
			sectionId,
		);
		if (level < 1) return { refusal: 'not_authorized' };
		const recordKey = `${sectionTipo}\u0000${sectionId}`;
		let inScope = recordInScope.get(recordKey);
		if (inScope === undefined) {
			inScope = await principalCanAccessRecord(sectionTipo, sectionId, principal);
			rememberBounded(recordInScope, recordKey, inScope, MEDIA_ZIP_RECORD_MEMO_MAX);
		}
		if (!inScope) return { refusal: 'not_authorized' };
		let mediaColumn = recordMedia.get(recordKey);
		if (mediaColumn === undefined) {
			mediaColumn = await readStoredMediaColumn(sectionTipo, sectionId);
			rememberBounded(recordMedia, recordKey, mediaColumn, MEDIA_ZIP_RECORD_MEMO_MAX);
		}
		return { items: storedMediaItemsOf(mediaColumn, componentTipo) };
	};

	/** Path options per (section, component) — ontology reads, once each. */
	const pathOptions = new Map<string, MediaPathOptions>();
	/**
	 * The REAL path of each quality folder, resolved once per folder (a bucket
	 * repeats across thousands of records) — async, so a media root on a
	 * network mount never blocks the one event loop per candidate.
	 */
	const realDirs = new Map<string, string>();
	/** Media-model verdict per parsed component tipo. */
	const mediaComponents = new Map<string, boolean>();

	/**
	 * The folder the media path grammar derives for an AUTHORIZED address at a
	 * quality: its media-root-relative form and its real path (POSIX). null when
	 * the grammar refuses the address.
	 */
	const recordQualityDir = async (
		address: MediaRecordAddress,
		spec: MediaTypeSpec,
		quality: string,
	): Promise<{ relativeDir: string; realDir: string } | null> => {
		const key = `${address.sectionTipo}\u0000${address.componentTipo}`;
		let opts = pathOptions.get(key);
		if (opts === undefined) {
			opts = await resolveMediaPathOptions(address.componentTipo, address.sectionTipo);
			pathOptions.set(key, opts);
		}
		let location: { relativeDir: string; absolutePath: string };
		try {
			location = buildMediaLocation(
				spec,
				{ ...address, lang: null },
				quality,
				spec.defaultExtension,
				opts,
			);
		} catch (error) {
			if (isDedaloError(error) && error.code.startsWith('media.')) return null;
			throw error;
		}
		const absoluteDir = location.absolutePath.slice(0, location.absolutePath.lastIndexOf(sep));
		let realDir = realDirs.get(absoluteDir);
		if (realDir === undefined) {
			try {
				realDir = await realpath(absoluteDir);
			} catch {
				realDir = absoluteDir;
			}
			rememberBounded(realDirs, absoluteDir, realDir, MEDIA_ZIP_MEMO_MAX);
		}
		return { relativeDir: location.relativeDir, realDir: realDir.split(sep).join('/') };
	};

	/**
	 * A stored path that may name the authorized record's file: directly in its
	 * quality folder, not a web-server-denied name, not another media record's
	 * canonical file (see step 4 of the module doc).
	 */
	const isRecordOwnName = async (
		address: MediaRecordAddress,
		relativeDir: string,
		relative: string,
	): Promise<boolean> => {
		if (posix.dirname(relative) !== relativeDir) return false;
		const name = posix.basename(relative);
		if (name === '' || name.startsWith('.') || isDeniedMediaFileName(name)) return false;
		const parsed = parseMediaFileName(name);
		if (parsed === null || addressKey(parsed) === addressKey(address)) return true;
		let isMedia = mediaComponents.get(parsed.componentTipo);
		if (isMedia === undefined) {
			const parsedModel = await getModelByTipo(parsed.componentTipo);
			isMedia = typeof parsedModel === 'string' && isMediaModel(parsedModel);
			mediaComponents.set(parsed.componentTipo, isMedia);
		}
		return !isMedia;
	};

	const archiveCandidate = async (
		col: SpoolColLine,
		rec: number | string,
		candidate: string,
	): Promise<void> => {
		const model = col.model as string;
		const target = qualities.get(model);
		if (target === undefined) return;
		const paths = candidatePaths(candidate);
		const fileName = basename(paths[paths.length - 1] as string);
		// every address the candidate may belong to: the grammar's (a name that
		// merely FITS the grammar — a renamed 'MIB_2023_45.jpg' — may parse wrong),
		// then the row's; the first one whose record holds the candidate wins
		const addresses: MediaRecordAddress[] = [];
		const byName = parseMediaFileName(fileName);
		if (byName !== null) addresses.push(byName);
		const byRow = rowAddress(col, rec);
		if (byRow !== null && (byName === null || addressKey(byName) !== addressKey(byRow))) {
			addresses.push(byRow);
		}
		const memoKey = `${model}\u0000${addresses.map(addressKey).join('|')}\u0000${candidate}`;
		if (seenCandidates.has(memoKey)) return;
		if (seenCandidates.size >= MEDIA_ZIP_MEMO_MAX) seenCandidates.clear();
		seenCandidates.add(memoKey);
		if (addresses.length === 0) {
			await fail(candidate, 'unidentified');
			return;
		}
		let item: unknown;
		let authorized: MediaRecordAddress | undefined;
		let refusal: AddressRefusal | null = null;
		for (const address of addresses) {
			const verdict = await recordItem(address, model, paths);
			if ('item' in verdict) {
				item = verdict.item;
				authorized = address;
				break;
			}
			// the address that got FURTHEST names the reason (ties: the first)
			if (refusal === null || REFUSAL_STAGE[verdict.refusal] > REFUSAL_STAGE[refusal]) {
				refusal = verdict.refusal;
			}
		}
		if (item === undefined || authorized === undefined) {
			await fail(candidate, refusal ?? 'unidentified');
			return;
		}
		await archiveItem(authorized, target, item, candidate);
	};

	/**
	 * STEP 4 — one AUTHORIZED record item's file at the target quality: the
	 * stored path is read, then trusted only as a name inside the record's OWN
	 * quality folder (see the module doc). `label` names the item in info.txt
	 * for the refusals that precede a path (the candidate, or the address).
	 */
	const archiveItem = async (
		authorized: MediaRecordAddress,
		target: { spec: MediaTypeSpec; quality: string },
		item: unknown,
		label: string,
	): Promise<void> => {
		const entry = ((item as { files_info?: StoredFileInfo[] }).files_info ?? []).find(
			(info) =>
				info?.quality === target.quality &&
				typeof info.file_path === 'string' &&
				info.file_path !== '' &&
				info.file_exist !== false,
		);
		if (entry === undefined) {
			await fail(label, 'quality_unavailable');
			return;
		}
		const relative = entry.file_path as string;
		if (entry.external === true || !relative.startsWith('/')) {
			await fail(label, 'external');
			return;
		}

		// The stored path NAMES a file; only the record's own folder may hold it.
		const ownDir = await recordQualityDir(authorized, target.spec, target.quality);
		if (ownDir === null || !(await isRecordOwnName(authorized, ownDir.relativeDir, relative))) {
			await fail(relative, 'invalid_path');
			return;
		}

		let absolute: string;
		try {
			absolute = absoluteFromRelative(relative);
		} catch (error) {
			if (isDedaloError(error) && error.code === 'media.invalid_path') {
				await fail(relative, 'invalid_path');
				return;
			}
			throw error;
		}
		let real: string;
		try {
			real = await realpath(absolute);
		} catch {
			await fail(relative, 'missing_file');
			return;
		}
		if (
			!real.startsWith(rootReal + sep) ||
			posix.dirname(real.split(sep).join('/')) !== ownDir.realDir
		) {
			await fail(relative, 'invalid_path');
			return;
		}
		let size: number;
		try {
			const info = await stat(real);
			if (!info.isFile()) {
				await fail(relative, 'missing_file');
				return;
			}
			size = info.size;
		} catch {
			await fail(relative, 'missing_file');
			return;
		}
		if (archivedFiles.has(real)) return;
		const entryName = posix.basename(relative);
		if (!isArchivableEntryName(entryName)) {
			await fail(relative, 'invalid_path');
			return;
		}
		archivedFiles.add(real);

		const stored = await archiveDiskFileCancellable(
			zip,
			entryName,
			real,
			{ method: 'store', sizeHint: size },
			signal,
		);
		downloaded.push(stored.name);
		files++;
	};

	/** The distinct sidecar addresses seen — a bounded window (see MEMORY). */
	const seenAddresses = new Set<string>();

	/**
	 * One SIDECAR address (row_media.ts): checks 1-2, then EVERY item the
	 * record holds now for that component through step 4. info.txt names it
	 * `section_tipo/section_id/component_tipo` — what the export itself showed.
	 */
	const archiveAddress = async (address: MediaRecordAddress): Promise<void> => {
		const key = addressKey(address);
		if (seenAddresses.has(key)) return;
		if (seenAddresses.size >= MEDIA_ZIP_MEMO_MAX) seenAddresses.clear();
		seenAddresses.add(key);
		// CHECK 1 — the component is (still) a media model with a chosen quality
		const model = await getModelByTipo(address.componentTipo);
		const target =
			typeof model === 'string' && isMediaModel(model) ? qualities.get(model) : undefined;
		if (target === undefined) {
			await fail(key, 'not_media');
			return;
		}
		const read = await authorizedItems(address);
		if ('refusal' in read) {
			await fail(key, read.refusal);
			return;
		}
		if (read.items.length === 0) {
			await fail(key, 'not_in_record');
			return;
		}
		for (const item of read.items) {
			throwIfCancelled(signal);
			await archiveItem(address, target, item, key);
		}
	};

	try {
		if (capturedModels === null) {
			// The gap of an uncaptured spool, said once per column — never guessed.
			for (const col of [...cols.values()].sort((a, b) => a.i - b.i)) {
				if (directOrdinals.has(col.i)) continue;
				if (await legacyColumnMayHoldMedia(col)) {
					await fail(String(col.label ?? col.key ?? col.i), 'rerun_required');
				}
			}
		}
		if (mediaCols.length > 0) {
			for await (const row of spool.rows({ signal })) {
				throwIfCancelled(signal);
				for (const col of mediaCols) {
					const { candidates, unreadable } = cellCandidates(row.c[String(col.i)], isRaw);
					if (unreadable !== null) await fail(unreadable, 'unreadable_cell');
					for (const candidate of candidates) {
						throwIfCancelled(signal);
						await archiveCandidate(col, row.rec, candidate);
					}
				}
			}
		}
		if (readsSidecar) {
			for await (const line of spool.mediaLines({ signal })) {
				throwIfCancelled(signal);
				for (const [ordinal, sectionTipo, sectionId, componentTipo] of line.a) {
					// a DIRECT column's media was read from its cells above; a null
					// ordinal (a cell that showed nothing) has no cell to read it from
					if (ordinal !== null && directOrdinals.has(ordinal)) continue;
					throwIfCancelled(signal);
					await archiveAddress({ componentTipo, sectionTipo, sectionId });
				}
			}
		}
		throwIfCancelled(signal);
		const qualityLine = [...qualities.entries()]
			.map(([model, { quality }]) => `${model}: ${quality}`)
			.join(', ');
		// info.txt STREAMED: the failure list comes back from disk in chunks.
		const info = await zip.openEntry(MEDIA_ZIP_INFO_NAME);
		await info.write(
			`Qualities: ${qualityLine === '' ? '(no media columns)' : qualityLine}\n` +
				`Downloaded files: ${JSON.stringify(downloaded, null, 2)}\n` +
				'Failed files: ',
		);
		for await (const chunk of failures.prettyChunks()) await info.write(chunk);
		await info.write('\n');
		await info.close();
		const result = await zip.finish();
		return { bytes: result.bytes, rows: files };
	} catch (error) {
		zip.abort();
		throw error;
	} finally {
		await failures.close();
	}
};
