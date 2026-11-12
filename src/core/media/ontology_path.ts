/**
 * Resolve the ontology-driven path options for a media component in a section:
 * `max_items_folder` (the component's own property), `initial_media_path`
 * (the SECTION's property keyed by the component tipo) and `additional_path`
 * (the component's property naming a SIBLING component whose value on THIS
 * record is the bucket folder). PHP get_additional_path (:753-819) /
 * get_initial_media_path (:715).
 *
 * ── TWO SCOPES, AND WHY THE SIGNATURE HAS AN OPTIONAL THIRD ARGUMENT ─────────
 * `initial_media_path` and `max_items_folder` are properties of the ONTOLOGY —
 * the same for every record of the section. `additional_path` is not: it names
 * another component (e.g. rsc29 → rsc33 'Directorio'), and the folder is that
 * component's VALUE ON ONE RECORD. So a media path is only fully determined once
 * the record is known.
 *
 * Until 2026-08-09 nothing resolved it at all: `MediaPathOptions.additionalPathOverride`
 * was declared and every producer left it undefined, so an install that uses the
 * property wrote and read at the numeric bucket instead of the named folder —
 * i.e. every PHP-era file of such a component was UNREACHABLE from the TS engine
 * (the `rsc165` Certificate of Cession / Questionnaire case in the 2026-08 audit).
 * Measured on this install: `rsc33` and `rsc324` hold no value on any record in
 * either database, so the property is latent here and the bucket fallback is what
 * both engines compute — which is exactly why the gap survived unnoticed.
 *
 * `image_id` (component_image only, PHP component_image::get_id) is the same
 * shape: a sibling's value on ONE record names the FILES (`photo_2.jpg`). The
 * record-scoped form resolves BOTH from one row read (T1-10).
 *
 * Call `resolveMediaPathOptions(componentTipo, sectionTipo, sectionId)` — the
 * RECORD-scoped form — from anywhere a record is in hand. The two-argument form
 * is the section-scoped one; it leaves `additionalPathOverride` UNDEFINED (never
 * a fabricated null), and the call sites still on it are named, with their reason,
 * in {@link SECTION_SCOPED_PATH_OPTION_CALLERS} — a list that may only SHRINK
 * (gated by test/unit/media_ingest_properties_native.test.ts).
 */

import type { MatrixRecord } from '../db/matrix.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { DedaloError } from '../errors/index.ts';
import { getMatrixTableFromTipo, getModelByTipo, getNode } from '../ontology/resolver.ts';
import { readComponentItems } from '../resolve/component_data.ts';
import { assertMediaFileStem, type MediaIdentity, type MediaPathOptions } from './path.ts';

/**
 * The call sites that still resolve media path options WITHOUT a section_id, and
 * why. Each entry is migration debt, not a design: a media path is a property of
 * a RECORD, and every one of these has the record's id in hand at the call site.
 *
 * THE LIST MAY ONLY SHRINK. `media_ingest_properties_native.test.ts` scans the
 * repository for two-argument `resolveMediaPathOptions(` calls and asserts the
 * set equals these paths exactly — so a NEW section-scoped call site fails the
 * gate, and a migrated one must be struck from here in the same change.
 *
 * (Owned by other workstreams as of 2026-08-09; handed off, not silently left.
 * `src/core/media/file_ops.ts` was on this list for a few hours on that day and
 * came off it the same day, which is the intended lifecycle of an entry.
 * `section/record/duplicate_record.ts` and `media/repair.ts` came off it with
 * CLOSURE_PLAN Step 2 (CORE-5 / TOOLS-5): the duplicate copies through the
 * record-scoped walk, the repair resolves per record.
 * `component_text_area/tag_endpoint.ts` came off it with T0-10: it resolves
 * through the record-scoped `media/tag_locator.ts`.)
 */
export const SECTION_SCOPED_PATH_OPTION_CALLERS: ReadonlyArray<{
	readonly file: string;
	readonly reason: string;
}> = [
	{
		file: 'src/core/section/indexation_grid.ts',
		reason:
			"NOT migration debt: the grid resolves properties.additional_path ITSELF (mediaCellUrl), because its export grammar deliberately omits initial_media_path and is oracle-pinned — it reads this resolver only for the parts it shares (initial_media_path). Its own bucket resolution must stay in step with normalizeAdditionalPath; its image_id stem goes through resolveFileIdOverride, the writer's own resolver",
	},
	{
		file: 'src/core/api/handlers/media_action_context.ts',
		reason:
			'holds the request section_id; av/3d only today (no image_id), but a record-scoped additional_path is still owed',
	},
	{
		file: 'tools/tool_export/server/writers/media_zip.ts',
		reason:
			'caches options per (section, component) and reads only relativeDir, so the image_id stem never matters to it — but a record-scoped additional_path bucket does: a record with a named bucket is exported from the numeric one (neighbour of T1-10, not fixed by it)',
	},
];

/**
 * Read a component + section node and derive the path-shaping options.
 *
 * With `sectionId` the result is COMPLETE: `additionalPathOverride` is resolved
 * (a string when the ontology declares `additional_path`, `null` when it does
 * not). Without it the field is left UNDEFINED — "not resolved here", which is a
 * different statement from "there is none" and is what lets a later
 * {@link completeMediaPathOptions} fill it in rather than trust a fabricated null.
 */
export async function resolveMediaPathOptions(
	componentTipo: string,
	sectionTipo: string,
	sectionId?: number,
	scope: RecordScope = {},
): Promise<MediaPathOptions> {
	const componentNode = await getNode(componentTipo);
	const sectionNode = await getNode(sectionTipo);

	const componentProps = (componentNode?.properties ?? {}) as Record<string, unknown>;
	const rawMax = componentProps.max_items_folder;
	const maxItemsFolder =
		typeof rawMax === 'number'
			? rawMax
			: typeof rawMax === 'string'
				? Number(rawMax) || null
				: null;

	// initial_media_path lives on the SECTION, keyed by component tipo (leading slash forced).
	let initialMediaPath = '';
	const sectionProps = (sectionNode?.properties ?? {}) as Record<string, unknown>;
	const initialMap = sectionProps.initial_media_path as Record<string, string> | undefined;
	if (initialMap && typeof initialMap === 'object') {
		const value = initialMap[componentTipo];
		if (typeof value === 'string' && value !== '') {
			initialMediaPath = value.startsWith('/') ? value : `/${value}`;
		}
	}

	const options: MediaPathOptions = { initialMediaPath, maxItemsFolder };
	if (sectionId === undefined) return options;
	// ONE row read for both record-scoped answers (rsc29 declares both).
	const record = recordLoader(sectionTipo, sectionId, scope.record);
	options.additionalPathOverride = await resolveAdditionalPathOverride(
		componentTipo,
		sectionTipo,
		sectionId,
		record,
	);
	options.fileIdOverride = await resolveFileIdOverride(
		componentTipo,
		sectionTipo,
		sectionId,
		record,
	);
	return options;
}

/**
 * Where the record-scoped resolution reads the record from. `record` = the
 * caller already holds the row (the read emit, a pre-delete snapshot): no read
 * at all. Absent = read it, at most once, and only if a property asks.
 */
export interface RecordScope {
	/**
	 * The record in hand — a matrix row, or a snapshot's columns wrapped as one
	 * (`recordFromColumns`). `null` = "the record does not exist": every sibling
	 * reads empty.
	 */
	record?: MatrixRecord | null;
}

/** A lazy, memoized row source: the read happens on first ask, once. */
type RecordSource = () => Promise<MatrixRecord | null>;

function recordLoader(
	sectionTipo: string,
	sectionId: number,
	record: MatrixRecord | null | undefined | RecordSource,
): RecordSource {
	if (typeof record === 'function') return record;
	if (record !== undefined) return async () => record;
	let pending: Promise<MatrixRecord | null> | null = null;
	return () => {
		pending ??= (async () => {
			const table = await getMatrixTableFromTipo(sectionTipo);
			if (table === null) return null;
			// The read-scoped memo when a section read is running (the row is
			// usually already fetched); a direct read otherwise.
			return memoizedReadMatrixRecord(table, sectionTipo, sectionId);
		})();
		return pending;
	};
}

/**
 * A record SNAPSHOT (the jsonb columns keyed by column name — the Time Machine /
 * pre-delete shape) as a {@link MatrixRecord}, so the record-scoped resolution
 * reads a deleted row's siblings through the very rule it reads a live one.
 */
export function recordFromColumns(
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): MatrixRecord {
	return {
		id: 0,
		section_id: sectionId,
		section_tipo: sectionTipo,
		columns: columns as MatrixRecord['columns'],
		rawText: {},
	};
}

/**
 * Fill in a record-scoped `additionalPathOverride` on options that were resolved
 * without one — the seam for a caller that RECEIVES `MediaPathOptions` (the
 * ingest orchestrator) rather than resolving them itself.
 *
 * Idempotent and non-overriding: options that already carry the field (including
 * an explicit `null`) are returned untouched, so a caller that resolved the
 * record-scoped form stays authoritative.
 */
export async function completeMediaPathOptions(
	identity: MediaIdentity,
	options: MediaPathOptions,
): Promise<MediaPathOptions> {
	const needsBucket = options.additionalPathOverride === undefined;
	const needsStem = options.fileIdOverride === undefined;
	if (!needsBucket && !needsStem) return options;
	const { componentTipo, sectionTipo, sectionId } = identity;
	const record = recordLoader(sectionTipo, sectionId, undefined);
	const completed: MediaPathOptions = { ...options };
	if (needsBucket) {
		completed.additionalPathOverride = await resolveAdditionalPathOverride(
			componentTipo,
			sectionTipo,
			sectionId,
			record,
		);
	}
	if (needsStem) {
		completed.fileIdOverride = await resolveFileIdOverride(
			componentTipo,
			sectionTipo,
			sectionId,
			record,
		);
	}
	return completed;
}

/**
 * The `properties.image_id` FILE STEM for ONE record (PHP component_image::get_id,
 * class.component_image.php:158-219, case 2), or null:
 *
 * - null when the component is not a `component_image` — PHP declares the
 *   override on component_image alone; any other model's `image_id` is inert;
 * - null when it declares no `image_id`, or this record's sibling is empty
 *   (PHP falls back to get_identifier — and, unlike media_common::get_id, adds
 *   NO lang suffix to the stem);
 * - else the sibling's TRIMMED value, through {@link assertMediaFileStem}, which
 *   refuses a value that is no file name or names another record's files.
 *
 * PHP's case 1 (an `external_source` IRI's filename wins over image_id) is NOT
 * ported here: an external image has no local files to name, and porting it
 * makes every IIIF `…/default.jpg` record share the stem `default` — an owner
 * decision (T1-10 OD-2), not something this resolver decides.
 */
export async function resolveFileIdOverride(
	componentTipo: string,
	sectionTipo: string,
	sectionId: number,
	record?: MatrixRecord | null | RecordSource,
): Promise<string | null> {
	if ((await getModelByTipo(componentTipo)) !== 'component_image') return null;
	const properties = ((await getNode(componentTipo))?.properties ?? {}) as { image_id?: unknown };
	const siblingTipo = properties.image_id;
	if (typeof siblingTipo !== 'string' || siblingTipo === '') return null;
	// PHP: an instance without a section_id has no id at all — the identifier is the answer.
	if (!Number.isInteger(sectionId) || sectionId <= 0) return null;
	const value = (
		await siblingFlatValue(siblingTipo, recordLoader(sectionTipo, sectionId, record))
	).trim();
	if (value === '') return null;
	return assertMediaFileStem(value, { componentTipo, sectionTipo, sectionId, lang: null });
}

/**
 * The `properties.additional_path` bucket folder for ONE record, or null when the
 * component does not declare the property (PHP get_additional_path :778-799).
 *
 * Returns `''` — not null — when the property IS declared but the sibling holds no
 * value: PHP's `empty($additional_path)` then falls through to the
 * `max_items_folder` bucket, and `buildMediaLocation` treats `''` the same way.
 * The distinction matters: null says "this component has no named bucket", `''`
 * says "it has one and this record has not filled it in".
 */
export async function resolveAdditionalPathOverride(
	componentTipo: string,
	sectionTipo: string,
	sectionId: number,
	record?: MatrixRecord | null | RecordSource,
): Promise<string | null> {
	const properties = ((await getNode(componentTipo))?.properties ?? {}) as {
		additional_path?: unknown;
	};
	const siblingTipo = properties.additional_path;
	if (typeof siblingTipo !== 'string' || siblingTipo === '') return null;
	// PHP returns null before reading anything when the instance has no section_id.
	if (!Number.isInteger(sectionId) || sectionId <= 0) return '';
	const raw = await siblingFlatValue(siblingTipo, recordLoader(sectionTipo, sectionId, record));
	return normalizeAdditionalPath(raw);
}

/**
 * PHP get_additional_path's slash normalisation (:788-796): trim, force a leading
 * slash, strip a trailing one. `''` (and a bare `'/'`, which PHP reduces to `''`)
 * means "no named bucket on this record" and the caller falls back to the numeric
 * one.
 *
 * INTERIOR slashes are preserved — PHP allowed a multi-segment value and narrowing
 * that here would remove capability an install may already depend on. What is NOT
 * allowed is a segment that escapes: a `.`/`..` segment or a NUL is REFUSED
 * outright rather than handed to the path builder, so the failure names the
 * ontology value instead of surfacing as a traversal error three layers down.
 * (`assertInsideMediaRoot` is still the chokepoint; this is the readable error.)
 */
export function normalizeAdditionalPath(raw: string): string {
	let value = raw.trim();
	if (value === '') return '';
	if (value.includes('\0')) {
		throw new Error('additional_path value contains a NUL byte');
	}
	// The folder reaches HTML attributes VERBATIM: a glyph URL is an `<img src>`,
	// and the published render html-entity-decodes its whole output (PHP parity),
	// so an escaped quote comes back as a real one and closes the attribute.
	// No legitimate folder name needs these characters (T0-10).
	if (/["<>]/.test(value)) {
		throw new DedaloError('media.invalid_identifier', {
			message: `additional_path value '${raw}' contains a character refused in a media path (" < >)`,
		});
	}
	if (!value.startsWith('/')) value = `/${value}`;
	if (value.endsWith('/')) value = value.slice(0, -1);
	if (value === '') return '';
	for (const segment of value.slice(1).split('/')) {
		if (segment === '.' || segment === '..') {
			throw new Error(`additional_path value '${raw}' escapes the media tree`);
		}
	}
	return value;
}

/**
 * A sibling component's flat scalar value the way PHP reads it for a path
 * (`component_common::get_instance(..., DEDALO_DATA_NOLAN, ...)->get_value()`):
 * the lg-nolan items, else every stored item, values joined with ' | '.
 *
 * Twin of `section/indexation_grid.ts flatSiblingValue`, which reads the same
 * rule for the EXPORT grammar's bucket. The two must agree — the grid builds the
 * URL a client fetches and this builds the path the file is written to. (The
 * image_id STEM the grid takes from {@link resolveFileIdOverride} itself.)
 * A snapshot read (delete/restore/duplicate) comes through here too, as a
 * {@link recordFromColumns} record.
 */
async function siblingFlatValue(componentTipo: string, source: RecordSource): Promise<string> {
	const record = await source();
	if (record === null) return '';
	const model = await getModelByTipo(componentTipo);
	if (model === null) return '';
	return flatItemsValue(readComponentItems(record, componentTipo, model));
}

/**
 * The flat-value RULE itself, on stored items (PHP `get_value()` as a path reads
 * it): the lg-nolan items, else every item, string values joined with ' | '.
 * Pure and exported so the rule is gated directly — a live row and a pre-delete
 * snapshot both reach it through {@link siblingFlatValue}, so there is no second
 * copy to drift (the snapshot twin in file_ops.ts retired with T1-10).
 */
export function flatItemsValue(stored: unknown): string {
	if (!Array.isArray(stored)) return '';
	const items = stored as ({ lang?: unknown; value?: unknown } | null)[];
	const nolan = items.filter((item) => {
		const lang = item?.lang ?? null;
		return lang === null || lang === 'lg-nolan';
	});
	const slice = nolan.length > 0 ? nolan : items;
	return slice
		.map((item) => (typeof item?.value === 'string' ? item.value : ''))
		.filter((value) => value !== '')
		.join(' | ');
}
