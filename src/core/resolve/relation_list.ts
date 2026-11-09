/**
 * get_relation_list — the "Referencias" panel (PHP relation_list class +
 * relation_list_json): lists every record that points AT the host record,
 * as a heterogeneous grid whose columns differ per referencing section.
 *
 * Pipeline:
 *  1. findInverseReferences (search_related) — the owning records;
 *  2. per referencing section, the grid COLUMNS: the section_map
 *     'relation_list' scope's term tipos (strict, no chain) when authored,
 *     else the section's legacy relation_list ontology node `relations`;
 *  3. per record, one id cell + one VALUE cell per column. Cell values are
 *     the component's flat display string (PHP get_value → export atoms →
 *     to_flat_string): lang-sliced literal values joined ' | ' for the
 *     string family, resolved datalist labels for relation models.
 *
 * VALUE SCOPE (every model that appears as a real relation_list column in the
 * ontology): the string family (input_text/text_area/email/number),
 * component_date, component_iri, the datalist-resolvable relation models
 * (select/radio/check_box/autocomplete/autocomplete_hi/relation_model/portal
 * with export-atoms child recursion), the media models (image/svg/pdf/av), and
 * component_section_id (the record's own id). LEDGERED: any other model (the
 * cell carries value null + the response notes the unresolved model, never a
 * guessed string) — the only live instance is one node mis-modelled as `section`
 * used as a relation_list column (ich126 under rsc197's ich96).
 */

import { config } from '../../config/config.ts';
import {
	dateItemToValue,
	dateModeOf,
	resolvePeriodLabels,
} from '../components/component_date/date_value.ts';
import type { ExternalSourceStatus } from '../components/component_external/value.ts';
import { resolveIriTitles } from '../components/component_iri/resolve_title.ts';
import { getFlatValueFamily } from '../components/registry.ts';
import { mediaTypeOf } from '../concepts/media.ts';
import { canonicalizeStoredSectionId, isSectionId } from '../concepts/section_id.ts';
import { dataframeEntryMatches } from '../concepts/subdatum.ts';
import { type MatrixRecord, readMatrixRecordBatch } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { termByTipo } from '../ontology/labels.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getNode,
} from '../ontology/resolver.ts';
import { getSectionMap } from '../ontology/section_map.ts';
import { resolveLocatorLabels } from '../relations/datalist.ts';
import { findInverseReferences } from '../search/search_related.ts';
import { resolveOwnConfigMap } from '../section/list_definitions/section_list.ts';
import type { Principal } from '../security/permissions.ts';
import { type EmissionContext, resolveComponentValue } from './component_data.ts';
import { currentDataLang } from './request_lang.ts';

/** PHP export_value records_separator (join_atoms depth-0 default). */
const RECORDS_SEPARATOR = ' | ';

export interface RelationListResult {
	context: Record<string, unknown>[];
	data: Record<string, unknown>[];
	/** Models the value resolver does not cover (ledger, never guessed). */
	unresolved: string[];
}

/** The grid column tipos of one referencing section (see module doc step 2). */
export async function getRelationListColumns(sectionTipo: string): Promise<string[]> {
	// section_map 'relation_list' scope (strict — the scope key is read
	// directly, no SCOPE_FALLBACK walk), resolved through the canonical
	// virtual-aware cached accessor (S2-27).
	const sectionMap = (await getSectionMap(sectionTipo)) as {
		relation_list?: { term?: string | string[] };
	} | null;
	const scopeTerm = sectionMap?.relation_list?.term;
	if (scopeTerm !== undefined && scopeTerm !== null) {
		return Array.isArray(scopeTerm) ? scopeTerm : [scopeTerm];
	}

	// Legacy: the section's relation_list ontology node — its `relations`
	// links name the column tipos.
	const legacyRows = (await sql.unsafe(
		`SELECT relations FROM dd_ontology WHERE parent = $1 AND model = 'relation_list' LIMIT 1`,
		[sectionTipo],
	)) as { relations: { tipo?: string }[] | null }[];
	return (legacyRows[0]?.relations ?? [])
		.map((link) => link.tipo)
		.filter((tipo): tipo is string => typeof tipo === 'string');
}

/**
 * Optional per-run seams for the cell-value resolvers. `loadRecord` replaces
 * the DEFAULT reader, which is `memoizedReadMatrixRecord` (db/record_memo.ts):
 * inside a section read every cell of every show-column that lands on the same
 * row is answered from the read-scoped memo instead of re-fetching the whole
 * row per column (K columns × R references = R×K identical reads — the
 * labelOfReference path in relations/related.ts passes no loader at all).
 * Outside a read scope it degrades to a bare read, which is what the export run
 * replaces with a loader backed by its own per-run record cache, collapsing the
 * per-row/per-target single-record SELECTs (the classic N+1) to one read per
 * distinct record.
 * A loader function (not a bare Map) keeps eviction policy on the caller's
 * side and this module free of any diffusion import.
 */
export interface CellValueResolveOptions {
	loadRecord?: (
		tableName: string,
		sectionTipo: string,
		sectionId: number,
	) => Promise<MatrixRecord | null>;
	/**
	 * The emission scratch a component_external cell reads its PREFETCHED remote
	 * row from (component_external/value.ts PREFETCHED_ROW_VIEWS). The export
	 * walk parks each hydrate batch's remote rows there
	 * (diffusion/export/external_prefetch.ts), so a cell derives from the batch
	 * instead of fetching live per record. Absent = every external cell fetches
	 * its own row (coalesced + cached) — the per-record fallback every other
	 * reader keeps.
	 */
	externalEmission?: EmissionContext;
	/**
	 * Told of every component_external cell whose value is DEGRADED (a
	 * `source_status` came back: the source could not answer, answered from a
	 * stale copy, is disabled/misconfigured, or values were cut). The export
	 * walk records these (grid.ts OpenedExportGrid.externalDegradation) so an
	 * export is never silently incomplete. A foreign target (the column does not
	 * apply) and a clean success never call it.
	 */
	onExternalDegraded?: (event: ExternalCellDegradation) => void;
	/**
	 * Told of every MEDIA component this resolution READ on a record whose
	 * stored items name at least one file (mediaItemsHoldAFile) — at any depth:
	 * a portal's own-config media child, a frame's, a nested relation's. The
	 * tool_export build records these ADDRESSES (tools/tool_export media ZIP):
	 * the archive is resolved from where the walk read media, never from the
	 * URL text a cell happens to hold. Called whether or not the export base is
	 * configured (the address is data; the URL is presentation). Absent = no
	 * capture — every other reader of this module.
	 */
	onMediaRead?: (address: MediaReadAddress) => void;
	/**
	 * THE FRONTIER OF THE RESOLUTION (T0-1 / S02 + S03, 2026-11-09). A flat
	 * value crosses into OTHER records — a relation's targets at every depth,
	 * dataframe frame targets, iri label frames — and reads an IMPLICIT config's
	 * child components there. Armed, every such crossing is asked HERE before
	 * a single byte of the target is read; absent, nothing is asked (the
	 * interactive callers — relation_list panel, Referencias, related labels —
	 * are byte-unchanged, and their own doors scope their output).
	 *
	 * A seam of FUNCTIONS, not a scope object: the caller owns the law (the
	 * export binds the frontier's THROW, diffusion/export/atoms.ts), and this
	 * module stays free of any diffusion import. The host record itself is NOT
	 * asked — the caller authorized it before asking for its value.
	 */
	frontier?: CellFrontier;
}

/**
 * The crossings a cell resolution asks about (CellValueResolveOptions.frontier).
 */
export interface CellFrontier {
	/**
	 * May the resolution read this TARGET record? `false` = skip the target
	 * (the surface already made the refusal loud); a THROW = the surface's law.
	 * The id travels VERBATIM (an external remote id is never Number()-ed).
	 */
	crossRecord(sectionTipo: string, sectionId: number | string): Promise<boolean>;
	/**
	 * Which of an IMPLICIT config's child components may be read at the target
	 * section `sectionTipo` (frontier_scope.ts frontierAllowedComponents —
	 * the predicate the edit form's implicit map uses). A child of an EXPLICIT
	 * (curator-configured) map is never asked: it is read at the subdatum
	 * floor, as the edit form shows it (owner decision D3).
	 */
	implicitChildren(
		sectionTipo: string,
		componentTipos: readonly string[],
	): Promise<ReadonlySet<string>>;
}

/** One config child of a relation / frame, with the map it came from. */
export interface ConfigChild {
	tipo: string;
	/** True when it came from the IMPLICIT legacy map (ontology `relations`). */
	implicit: boolean;
}

/**
 * The children the caller may read at `targetSection`: every explicit child,
 * and the implicit ones the armed frontier allows. Order-preserving. Unarmed
 * = every child (the interactive callers).
 */
async function readableChildren<T extends ConfigChild>(
	children: readonly T[],
	targetSection: string,
	opts: CellValueResolveOptions | undefined,
): Promise<T[]> {
	const frontier = opts?.frontier;
	if (frontier === undefined) return [...children];
	const implicitTipos = children.filter((child) => child.implicit).map((child) => child.tipo);
	if (implicitTipos.length === 0) return [...children];
	const allowed = await frontier.implicitChildren(targetSection, implicitTipos);
	return children.filter((child) => !child.implicit || allowed.has(child.tipo));
}

/** One media component read on one record (CellValueResolveOptions.onMediaRead). */
export interface MediaReadAddress {
	readonly sectionTipo: string;
	/** A matrix record address (positive integer) — never an external remote id. */
	readonly sectionId: number;
	readonly componentTipo: string;
}

/**
 * Do these stored media items name at least one file? (any files_info entry
 * with a non-empty file_path, any quality) — the data-exact test for "this
 * component holds media on this record".
 */
export function mediaItemsHoldAFile(items: unknown): boolean {
	if (!Array.isArray(items)) return false;
	return items.some((item) => {
		const filesInfo = (item as { files_info?: unknown } | null)?.files_info;
		return (
			Array.isArray(filesInfo) &&
			filesInfo.some(
				(info) =>
					typeof (info as { file_path?: unknown } | null)?.file_path === 'string' &&
					(info as { file_path: string }).file_path !== '',
			)
		);
	});
}

/** Tell the caller's onMediaRead of `address` when the stored items name a file. */
function reportMediaRead(
	opts: CellValueResolveOptions | undefined,
	items: unknown,
	address: MediaReadAddress,
): void {
	if (opts?.onMediaRead !== undefined && mediaItemsHoldAFile(items)) opts.onMediaRead(address);
}

/** Append `address` to `list` unless an equal address is already there. */
export function addMediaReadAddress(list: MediaReadAddress[], address: MediaReadAddress): void {
	for (const known of list) {
		if (
			known.sectionTipo === address.sectionTipo &&
			known.sectionId === address.sectionId &&
			known.componentTipo === address.componentTipo
		) {
			return;
		}
	}
	list.push(address);
}

/** One degraded component_external cell (CellValueResolveOptions.onExternalDegraded). */
export interface ExternalCellDegradation {
	/** The component_external tipo. */
	readonly componentTipo: string;
	/** The EXTERNAL section the remote record belongs to (zenon1). */
	readonly sectionTipo: string;
	/** The remote id, verbatim ('000065686'). */
	readonly remoteId: string;
	/** The wire provenance the derivation produced. */
	readonly status: ExternalSourceStatus;
	/** Whether the cell ended up with no value at all. */
	readonly empty: boolean;
}

/**
 * The MATRIX record address a flat-value resolver may read, or null when the
 * id addresses no matrix record.
 *
 * The resolvers below take `number | string` because their input is RAW stored
 * jsonb: a locator's `section_id` is an int (canonical), an unswept convertible
 * string ('7'), or an EXTERNAL remote id ('000065686', 'Q42') that is the value
 * itself (WC-2026-08-10-section-id-int-canonical). Only the first two are record
 * addresses; the conversion rule is the shared one (`canonicalizeStoredSectionId`).
 * A zero-padded id is NEVER Number()-ed into an address: '000065686' → 65686 is
 * a different record (locally) and a different remote record (at the service).
 */
function matrixRecordAddress(sectionId: number | string): number | null {
	const canonical = canonicalizeStoredSectionId(sectionId);
	return isSectionId(canonical) ? canonical : null;
}

/** One resolved relation target: its RAW stored position + flat value parts. */
export interface RelationTargetValue {
	/** RAW stored-locator array position (holes/invalid entries consume one). */
	index: number;
	sectionTipo: string | null;
	sectionId: number | string | null;
	/** The target's flat display parts (config children joined per field, or
	 * the datalist label) — empty when the target resolves to nothing. */
	parts: string[];
	/**
	 * The media components read while resolving THIS target (at any depth
	 * below it) — present only when the caller captures
	 * (CellValueResolveOptions.onMediaRead); every address is ALSO forwarded
	 * to the caller's own onMediaRead.
	 */
	media?: MediaReadAddress[];
}

/**
 * The children a relation's flat value resolves per locator target, in map
 * order (PHP field-dimension order = ddo order): the own config's ddo_map
 * direct children, then the implicit legacy map (section_list node relations,
 * components only). Dataframe children are FLAGGED — they resolve as frame
 * fields folded into the flat cell. ONE derivation for resolveRelationTargetValues
 * and the export's dedalo_raw media walk (src/diffusion/export/atoms.ts), so
 * both read the same components.
 */
export async function relationTargetChildren(
	componentTipo: string,
): Promise<(ConfigChild & { isDataframe: boolean })[]> {
	const children: (ConfigChild & { isDataframe: boolean })[] = [];
	for (const child of await ownConfigChildren(componentTipo)) {
		children.push({
			...child,
			isDataframe: (await getModelByTipo(child.tipo)) === 'component_dataframe',
		});
	}
	return children;
}

/**
 * The components a dataframe's frames resolve at each FRAME TARGET record
 * (the frame's own config ddo_map direct children, then its implicit map) —
 * ONE derivation for resolveDataframeFlatValue and the export's dedalo_raw
 * media walk.
 */
export function dataframeFrameChildren(frameTipo: string): Promise<ConfigChild[]> {
	return ownConfigChildren(frameTipo);
}

/** {@link dataframeFrameChildren}'s tipos (an ontology-only reach test needs no origin). */
export async function dataframeFrameChildTipos(frameTipo: string): Promise<string[]> {
	return (await ownConfigChildren(frameTipo)).map((child) => child.tipo);
}

/**
 * A component's own-config children, in map order: the ddo_map entries whose
 * parent is the component ('self', its tipo, or unset), then the implicit
 * legacy map's COMPONENTS — each tagged with the map it came from, because
 * the two answer to different keys (CellFrontier.implicitChildren).
 */
async function ownConfigChildren(ownerTipo: string): Promise<ConfigChild[]> {
	const cell = await resolveOwnConfigMap(ownerTipo);
	const children: ConfigChild[] = (cell.rawDdos ?? [])
		.filter((child) => typeof child?.tipo === 'string' && isOwnMapChild(child.parent, ownerTipo))
		.map((child) => ({ tipo: child.tipo as string, implicit: false }));
	for (const relTipo of cell.implicitRelations ?? []) {
		if ((await getModelByTipo(relTipo))?.startsWith('component_') === true) {
			children.push({ tipo: relTipo, implicit: true });
		}
	}
	return children;
}

/** Is a ddo_map entry with this `parent` a direct child of `ownerTipo`? */
function isOwnMapChild(parent: unknown, ownerTipo: string): boolean {
	return parent === undefined || parent === 'self' || parent === ownerTipo;
}

/**
 * Per-TARGET flat values of one relation component on one record — the
 * per-locator half of the datalist branch of resolveCellValue (PHP
 * get_export_value recursion): with config children, each locator target
 * flattens as its children's values joined by the COMPONENT's
 * fields_separator (rsc368's ' | ', rsc139's ', '); without config children,
 * the target label resolves via the datalist — in STORED locator order.
 * resolveCellValue joins the flattened parts with its itemSeparator; the
 * export compact-portal cells (WC-008) consume the targets individually.
 */
export async function resolveRelationTargetValues(
	sectionTipo: string,
	/** The HOST record's id, raw (see matrixRecordAddress) — only an address reads. */
	sectionId: number | string,
	componentTipo: string,
	lang: string,
	unresolved: string[],
	opts?: CellValueResolveOptions,
): Promise<RelationTargetValue[]> {
	const model = await getModelByTipo(componentTipo);
	if (model === null) return [];
	const address = matrixRecordAddress(sectionId);
	if (address === null) return [];
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return [];
	// The loader seam consults AFTER the null-table early-return (parity
	// keystone: a cached loader must never resolve what the default can't).
	const record = await (opts?.loadRecord ?? memoizedReadMatrixRecord)(table, sectionTipo, address);
	if (record === null) return [];

	const column = getColumnNameByModel(model) ?? 'relation';
	const columnData = record.columns[column as keyof typeof record.columns] as Record<
		string,
		unknown[]
	> | null;
	const locators = (columnData?.[componentTipo] ?? []) as {
		section_tipo?: unknown;
		section_id?: unknown;
		id?: number | string;
		main_component_tipo?: string;
	}[];
	if (locators.length === 0) return [];

	const children = await relationTargetChildren(componentTipo);

	const targets: RelationTargetValue[] = [];
	if (children.length > 0) {
		// (single-child configs degrade to exactly the label value, so the
		// pinned label gates — numisdata30 'Emporion', numisdata585 — hold)
		const fieldsSeparator = await componentFieldsSeparator(componentTipo);
		for (let index = 0; index < locators.length; index++) {
			const locator = locators[index];
			const targetSection = locator?.section_tipo;
			const targetId = locator?.section_id;
			if (typeof targetSection !== 'string' || targetId === undefined) continue;
			// THE FRONTIER (T0-1): this target is another record — asked before a
			// byte of it is read, at EVERY depth (this function re-enters through
			// resolveCellValue's datalist branch for a nested relation child).
			if (opts?.frontier !== undefined) {
				if (!(await opts.frontier.crossRecord(targetSection, targetId as number | string))) {
					continue;
				}
			}
			// The children THIS caller may read at THIS target: explicit ones at the
			// subdatum floor, implicit ones per the frontier's component key (D1).
			const targetChildren = await readableChildren(children, targetSection, opts);
			// Media capture per TARGET (onMediaRead): the addresses read below this
			// target land on target.media AND reach the caller's own sink.
			const outerOnMedia = opts?.onMediaRead;
			const targetMedia: MediaReadAddress[] | undefined =
				outerOnMedia === undefined ? undefined : [];
			const childOpts: CellValueResolveOptions | undefined =
				outerOnMedia === undefined || targetMedia === undefined
					? opts
					: {
							...opts,
							onMediaRead: (read) => {
								addMediaReadAddress(targetMedia, read);
								outerOnMedia(read);
							},
						};
			const fieldParts: string[] = [];
			for (const child of targetChildren) {
				if (child.isDataframe) {
					// Frames live on THIS record's relation column, paired to the
					// MAIN locator by (dd490, main, id_key = locator.id) — PHP
					// relation_common :871-897; empty/no-frames contributes nothing.
					const frameFlat = await resolveDataframeFlatValue(
						record,
						child.tipo,
						locator?.main_component_tipo ?? componentTipo,
						locator?.id,
						lang,
						unresolved,
						childOpts,
					);
					if (frameFlat !== null && frameFlat !== '') fieldParts.push(frameFlat);
					continue;
				}
				// The target id VERBATIM: a mixed portal (rsc368) holds local ints
				// AND zero-padded external remote ids ('000065686'), and Number()
				// here asked the external service for record 65686 — a 400, or a
				// DIFFERENT record. resolveCellValue decides per family: the external
				// family keeps the string, every matrix family reads the address.
				// A child ddo that does not belong to this target (a zenon1 column on
				// a local rsc205 target) resolves to nothing — by data absence for
				// the stored families, by ontology ownership for the external one
				// (component_external/value.ts externalComponentAppliesTo).
				const childValue = await resolveCellValue(
					targetSection,
					targetId as number | string,
					child.tipo,
					lang,
					unresolved,
					await componentFieldsSeparator(child.tipo),
					childOpts,
				);
				if (childValue !== null && childValue !== '') fieldParts.push(childValue);
			}
			targets.push({
				index,
				sectionTipo: targetSection,
				sectionId: targetId as number | string,
				parts: fieldParts.length > 0 ? [fieldParts.join(fieldsSeparator)] : [],
				...(targetMedia === undefined ? {} : { media: targetMedia }),
			});
		}
	} else {
		const properties = (await getNode(componentTipo))?.properties ?? null;
		for (let index = 0; index < locators.length; index++) {
			const locator = locators[index] as { section_tipo?: unknown; section_id?: unknown };
			// THE FRONTIER (T0-1): the label is read from the TARGET record. Its
			// child set comes from implicit.ts, which already filters it through
			// the same predicate (frontierAllowedComponents) for the ambient
			// principal — the export runs inside its own principal scope.
			if (
				opts?.frontier !== undefined &&
				typeof locator?.section_tipo === 'string' &&
				locator.section_id !== undefined &&
				!(await opts.frontier.crossRecord(
					locator.section_tipo,
					locator.section_id as number | string,
				))
			) {
				continue;
			}
			const labels = await resolveLocatorLabels(componentTipo, properties, sectionTipo, lang, [
				locator,
			]);
			targets.push({
				index,
				sectionTipo: typeof locator?.section_tipo === 'string' ? locator.section_tipo : null,
				sectionId: (locator?.section_id as number | string | undefined) ?? null,
				parts: labels.filter((label) => label !== ''),
			});
		}
	}
	return targets;
}

/**
 * The flat value of ONE main locator's paired dataframe frames (PHP
 * relation_common::get_export_value :871-897 + component_dataframe::get_data
 * :103-129): frames pair on the OWNER record's relation[frameTipo] slot by
 * (dd490, main_component_tipo, INT id_key = the main locator's stored id);
 * each frame's own config children resolve at the FRAME TARGET record and
 * join with the frame's fields_separator; multiple frames join the same way.
 * Null pairId (PHP null id_key) or zero pairs → null (contributes nothing).
 */
export async function resolveDataframeFlatValue(
	record: { columns: { relation?: unknown } },
	frameTipo: string,
	mainComponentTipo: string,
	pairId: number | string | undefined,
	lang: string,
	unresolved: string[],
	opts?: CellValueResolveOptions,
): Promise<string | null> {
	if (pairId === undefined || pairId === null) return null;
	const slot = ((record.columns.relation as Record<string, unknown[]> | null)?.[frameTipo] ??
		[]) as Record<string, unknown>[];
	const paired = slot.filter((entry) =>
		dataframeEntryMatches(entry as never, mainComponentTipo, pairId, frameTipo),
	);
	if (paired.length === 0) return null;

	const frameChildren = await dataframeFrameChildren(frameTipo);
	if (frameChildren.length === 0) return null;

	const frameSeparator = await componentFieldsSeparator(frameTipo);
	const frameParts: string[] = [];
	for (const frame of paired) {
		const frameTarget = frame as { section_tipo?: unknown; section_id?: unknown };
		if (typeof frameTarget.section_tipo !== 'string' || frameTarget.section_id === undefined) {
			continue;
		}
		// THE FRONTIER (T0-1): a frame TARGET is another record (a rating, an
		// uncertainty term …) — asked before it is read.
		if (
			opts?.frontier !== undefined &&
			!(await opts.frontier.crossRecord(
				frameTarget.section_tipo,
				frameTarget.section_id as number | string,
			))
		) {
			continue;
		}
		const fields: string[] = [];
		for (const child of await readableChildren(frameChildren, frameTarget.section_tipo, opts)) {
			const value = await resolveCellValue(
				frameTarget.section_tipo,
				frameTarget.section_id as number | string,
				child.tipo,
				lang,
				unresolved,
				frameSeparator,
				opts,
			);
			if (value !== null && value !== '') fields.push(value);
		}
		if (fields.length > 0) frameParts.push(fields.join(frameSeparator));
	}
	return frameParts.length > 0 ? frameParts.join(frameSeparator) : null;
}

/**
 * The EXTERNAL family's flat value (resolveCellValue's derived branch): the
 * component_external's entries for the remote record, joined. The id travels
 * VERBATIM (String, never Number: the remote id is zero-padded). A target
 * section the component does not belong to (a local record in a mixed portal)
 * derives nothing, with no remote call and no status.
 */
async function resolveExternalCellValue(
	model: string,
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
	unresolved: string[],
	itemSeparator: string,
	opts: CellValueResolveOptions | undefined,
): Promise<string | null> {
	const { deriveExternalValue } = await import('../components/component_external/value.ts');
	const remoteId = String(sectionId);
	const derived = await deriveExternalValue(
		componentTipo,
		sectionTipo,
		remoteId,
		opts?.externalEmission === undefined ? {} : { emission: opts.externalEmission },
	);
	const status = derived.source_status;
	if (status === undefined) {
		return derived.entries.length > 0 ? derived.entries.join(itemSeparator) : null;
	}
	opts?.onExternalDegraded?.({
		componentTipo,
		sectionTipo,
		remoteId,
		status,
		empty: derived.entries.length === 0,
	});
	if (derived.entries.length === 0) {
		// An EMPTY degraded cell is reported unresolved: an export that silently
		// ships blank bibliography columns is worse than one that says the
		// source was unreachable. A degraded cell that still HAS values (stale,
		// truncated) is a value, not a gap.
		if (!unresolved.includes(model)) unresolved.push(model);
		return null;
	}
	return derived.entries.join(itemSeparator);
}

/** One component's flat display string on one record (PHP get_value). */
export async function resolveCellValue(
	sectionTipo: string,
	/**
	 * The record's id, RAW: a matrix address (int, or its unswept convertible
	 * string form) or an EXTERNAL remote id kept VERBATIM ('000065686'). The
	 * external family consumes it as the remote id; every other family reads
	 * the matrix address and resolves null for a non-address.
	 */
	sectionId: number | string,
	componentTipo: string,
	lang: string,
	unresolved: string[],
	/** Multi-item join for DEFAULT-separator levels — the export-atoms rule
	 * flips ' | ' (first indexed level) to ', ' (deeper levels). */
	itemSeparator: string = RECORDS_SEPARATOR,
	opts?: CellValueResolveOptions,
): Promise<string | null> {
	const model = await getModelByTipo(componentTipo);
	if (model === null) return null;

	// DERIVED families resolve BEFORE the record load, because their sections
	// have no record to load: an external section (zenon1) owns no matrix table
	// and no rows — its "record" is the remote one. Falling through to the table
	// lookup would return null for every cell of a live section_list (zenon8
	// lists zenon3..zenon6), which is a silent blank, not an absence.
	if (getFlatValueFamily(model) === 'external') {
		return resolveExternalCellValue(
			model,
			sectionTipo,
			sectionId,
			componentTipo,
			unresolved,
			itemSeparator,
			opts,
		);
	}

	// Every other family reads the MATRIX record: a non-address (an external
	// remote id reaching a stored-family column) addresses no row.
	const address = matrixRecordAddress(sectionId);
	if (address === null) return null;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return null;
	// The loader seam consults AFTER the null-table early-return (parity
	// keystone: a cached loader must never resolve what the default can't).
	const record = await (opts?.loadRecord ?? memoizedReadMatrixRecord)(table, sectionTipo, address);
	if (record === null) return null;

	// Per-model dispatch by the DESCRIPTOR's flatValue family (WS-B facet
	// rewire, 2026-07-10): add a model = declare the facet, never edit this
	// file's branch tables. Undeclared families stay ledgered-unresolved.
	const family = getFlatValueFamily(model);

	if (family === 'section_id') {
		// The record's own section_id (PHP component_section_id::get_value): the
		// numeric id as a flat string. Used as an rsc424 relation_list column (rsc559).
		return String(address);
	}

	if (family === 'string') {
		const { value, fallbackValue } = await resolveComponentValue(
			record,
			componentTipo,
			model,
			lang,
		);
		const items = (value && value.length > 0 ? value : (fallbackValue ?? [])) as {
			value?: unknown;
		}[];
		const parts = items
			.map((item) => (item?.value === undefined || item.value === null ? '' : String(item.value)))
			.filter((part) => part !== '');
		return parts.length > 0 ? parts.join(itemSeparator) : null;
	}

	if (family === 'date') {
		// Flat date (PHP component_date::get_export_value → data_item_to_value,
		// then export_value::to_flat_string, which drops empty() atoms).
		//
		// This branch used to carry its OWN formatter — 'd-m-Y' joined with '-',
		// no date_mode dispatch, and the MONTH dropped whenever the day was
		// absent — while the oracle-correct one already existed elsewhere. It
		// was losing the month on live rsc170/rsc26 "Dating" records in every
		// Referencias cell and every tool_export cell (2026-08 oh1 beta §5.6).
		// There is now exactly ONE formatter, in the component's own home;
		// date_flat_value_single_source_tripwire.test.ts keeps it that way.
		const dateMode = dateModeOf((await getNode(componentTipo))?.properties);
		const periodLabels = dateMode === 'period' ? await resolvePeriodLabels() : undefined;
		const { value } = await resolveComponentValue(record, componentTipo, model, lang);
		const parts = ((value ?? []) as unknown[])
			.map((item) =>
				item === null || item === undefined || typeof item !== 'object'
					? ''
					: dateItemToValue(item as Record<string, unknown>, dateMode, { periodLabels }),
			)
			.filter((part) => part !== '');
		return parts.length > 0 ? parts.join(itemSeparator) : null;
	}

	if (family === 'iri') {
		// Flat iri: the iri value + its label-dataframe field joined ', ' per item
		// ('Les dracmes empuritanes, Zenon'). v6 get_grid_value :466-483 — iri
		// FIRST, then the title, the opposite order from get_diffusion_value.
		//
		// The title itself is the dd560 label and NEVER the stored `title` key:
		// that rule (which frames pair with which item, which components carry
		// the label, and "no frame ⇒ no title") lives in ONE place,
		// components/component_iri/resolve_title.ts. Only the order and this
		// path's own record seam are local.
		const iriItems = ((record.columns.iri as Record<string, unknown[]> | null)?.[componentTipo] ??
			[]) as { iri?: unknown; id?: number | string }[];
		const titles = await resolveIriTitles(record, componentTipo, async (frame) => {
			// THE FRONTIER (T0-1): the label lives on the FRAME's target record.
			if (
				opts?.frontier !== undefined &&
				!(await opts.frontier.crossRecord(frame.sectionTipo, frame.sectionId))
			) {
				return null;
			}
			const labels: string[] = [];
			for (const labelTipo of frame.labelTipos) {
				const label = await resolveCellValue(
					frame.sectionTipo,
					frame.sectionId,
					labelTipo,
					lang,
					unresolved,
					RECORDS_SEPARATOR,
					opts,
				);
				if (label !== null && label !== '') labels.push(label);
			}
			return labels.length > 0 ? labels.join(', ') : null;
		});
		const parts: string[] = [];
		for (const item of iriItems) {
			const fields: string[] = [];
			if (typeof item?.iri === 'string' && item.iri !== '') fields.push(item.iri);
			const title = titles.get(String(item?.id));
			if (title !== undefined) fields.push(title);
			if (fields.length > 0) parts.push(fields.join(', '));
		}
		return parts.length > 0 ? parts.join(itemSeparator) : null;
	}

	if (family === 'datalist') {
		const targets = await resolveRelationTargetValues(
			sectionTipo,
			address,
			componentTipo,
			lang,
			unresolved,
			opts,
		);
		const parts = targets.flatMap((target) => target.parts);
		return parts.length > 0 ? parts.join(itemSeparator) : null;
	}

	// MEDIA components: the export cell is the ABSOLUTE URL of the model's
	// default quality (stored files_info file_path under the configured public
	// media base — PHP: http://host/dedalo/media/image/1.5MB/32000/….jpg). The
	// quality comes from the media CONTRACT (mediaTypeOf → DEDALO_*_QUALITY_
	// DEFAULT), never a hardcoded table.
	if (family === 'media') {
		// config.media.exportBase (DEDALO_MEDIA_EXPORT_BASE) — the EXPORT base,
		// distinct from webBase: unset means the cell is reported unresolved, never
		// guessed. Already trailing-slash-normalized by the config builder.
		const column = getColumnNameByModel(model) ?? 'media';
		const items = ((
			record.columns[column as keyof typeof record.columns] as Record<string, unknown[]> | null
		)?.[componentTipo] ?? []) as { files_info?: { quality?: string; file_path?: string }[] }[];
		// The ADDRESS is reported before the URL is formatted (onMediaRead): a
		// capture must not depend on the export base being configured.
		reportMediaRead(opts, items, { sectionTipo, sectionId: address, componentTipo });
		const mediaBase = config.media.exportBase;
		const defaultQuality = mediaTypeOf(model)?.defaultQuality;
		if (mediaBase === undefined || mediaBase === '' || defaultQuality === undefined) {
			if (!unresolved.includes(model)) unresolved.push(model);
			return null;
		}
		const parts: string[] = [];
		for (const item of items) {
			const entry = (item?.files_info ?? []).find((info) => info?.quality === defaultQuality);
			if (entry?.file_path !== undefined && entry.file_path !== '') {
				parts.push(`${mediaBase}${entry.file_path}`);
			}
		}
		return parts.length > 0 ? parts.join(itemSeparator) : null;
	}

	if (!unresolved.includes(model)) unresolved.push(model);
	return null;
}

/** The component's declared show.fields_separator (?? ', ', PHP default). */
const cellFieldsSeparatorCache = createOntologyCache<string, string>();

/** Drop the ontology-derived fields_separator cache. */
export function clearFieldsSeparatorCache(): void {
	cellFieldsSeparatorCache.clear();
}
registerOntologyCacheClearer(clearFieldsSeparatorCache);
/** Exported for the export projection (P6): same separator, ONE cache. */
export async function componentFieldsSeparator(componentTipo: string): Promise<string> {
	const cached = cellFieldsSeparatorCache.get(componentTipo);
	if (cached !== undefined) return cached;
	const rows = (await sql.unsafe(
		`SELECT properties->'source'->'request_config' AS rc FROM dd_ontology WHERE tipo = $1`,
		[componentTipo],
	)) as { rc: { api_engine?: string; show?: { fields_separator?: string } }[] | null }[];
	const rcs = rows[0]?.rc ?? [];
	// The separator joins a component's values INSIDE a list/export cell, so the
	// concern is listColumns: an external-only component whose adapter cannot
	// back a column has no business rendering one, and the old `?? rcs[0]` read
	// the separator off that very item as if it could.
	const { selectConfigItemForConcern } = await import(
		'../relations/request_config/engine_select.ts'
	);
	const main = await selectConfigItemForConcern(
		rcs,
		'listColumns',
		'resolve/relation_list.componentFieldsSeparator',
	);
	const separator =
		typeof main?.show?.fields_separator === 'string' ? main.show.fields_separator : ', ';
	cellFieldsSeparatorCache.set(componentTipo, separator);
	return separator;
}

/**
 * Build the full relation-list grid for one host record (PHP
 * get_relation_list_obj). `limit` caps the referencing RECORDS;
 * `sectionTipos` narrows the OWNING sections (the client sqo's section_tipo
 * axis — PHP feeds the sqo straight to sections::get_instance; 'all' = every
 * section, the panel's default).
 */
export async function buildRelationList(
	hostSectionTipo: string,
	hostSectionId: number | string,
	options: {
		limit?: number | false;
		offset?: number;
		lang?: string;
		sectionTipos?: string[] | 'all';
		/**
		 * The caller (AUTHZ-05). When present and NOT a global admin, referencing
		 * records outside the caller's read grant / projects filter are excluded by
		 * the related search's SQL scope (D1) before the window is cut, so no
		 * existence, label or cell value of one is ever emitted. Undefined
		 * (internal / test callers) applies NO filter — production dispatch ALWAYS
		 * passes it.
		 */
		principal?: Principal;
	} = {},
): Promise<RelationListResult> {
	// Request-scoped data lang backstop (S2-28), never a hardcoded lg-spa.
	const lang = options.lang ?? currentDataLang();
	// AUTHZ-05 / D1 — the referencing records are scoped to the caller IN the
	// related search's own SQL (security/record_scope.ts rowScopeFor): the window
	// is cut from the SCOPED owner sequence, so a page is full while more of the
	// caller's records exist, and it is the same set the paginator count counts.
	// Global admins are unscoped inside the predicate; no principal (internal /
	// test callers) = no scope.
	const scope =
		options.principal === undefined
			? undefined
			: (await import('../security/record_scope.ts')).rowScopeFor(options.principal);
	const hits = await findInverseReferences(
		// Canonical address in (WC-2026-08-10-section-id-int-canonical). The
		// index probe binds ::int either way, so the old String() minting bought
		// nothing and only spread the string form outward.
		[
			{
				section_tipo: hostSectionTipo,
				section_id: canonicalizeStoredSectionId(hostSectionId) as string | number,
			},
		],
		{
			sectionTipos: options.sectionTipos ?? 'all',
			limit: options.limit ?? false,
			offset: options.offset,
			scope,
		},
	);

	// PER-CALL record loader (the export-run seam this module already exposes
	// as CellValueResolveOptions.loadRecord, never wired here until 2026-07-20):
	// a heavily-referenced host (an image on 4,682 coins) resolved every cell
	// with uncached single reads — tens of thousands of round-trips (~27 s).
	// The hit records are batch-prefetched per section; relation TARGETS load
	// lazily but dedup massively (thousands of coins share the same mint/author
	// labels). Never module-scoped — request isolation.
	const recordCache = new Map<string, MatrixRecord | null>();
	const loadRecord = async (
		tableName: string,
		sectionTipo: string,
		sectionId: number,
	): Promise<MatrixRecord | null> => {
		const key = `${sectionTipo}/${sectionId}`;
		const hit = recordCache.get(key);
		if (hit !== undefined) return hit;
		const record = await memoizedReadMatrixRecord(tableName, sectionTipo, sectionId);
		if (recordCache.size > 8000) recordCache.clear();
		recordCache.set(key, record); // null too: a miss must not re-query
		return record;
	};
	{
		const idsBySection = new Map<string, number[]>();
		for (const hit of hits) {
			const ids = idsBySection.get(hit.section_tipo);
			if (ids === undefined) idsBySection.set(hit.section_tipo, [hit.section_id]);
			else ids.push(hit.section_id);
		}
		for (const [sectionTipo, ids] of idsBySection) {
			const table = (await getMatrixTableFromTipo(sectionTipo)) ?? 'matrix';
			const records = await readMatrixRecordBatch(table, sectionTipo, ids);
			for (const id of ids) recordCache.set(`${sectionTipo}/${id}`, records.get(id) ?? null);
		}
	}

	const context: Record<string, unknown>[] = [];
	const data: Record<string, unknown>[] = [];
	const unresolved: string[] = [];
	const columnsBySection = new Map<string, string[]>();

	for (const hit of hits) {
		// First sight of a section: emit its context columns (id + grid columns).
		let columns = columnsBySection.get(hit.section_tipo);
		if (columns === undefined) {
			columns = await getRelationListColumns(hit.section_tipo);
			columnsBySection.set(hit.section_tipo, columns);
			const sectionLabel = await termByTipo(hit.section_tipo, lang);
			context.push({
				section_tipo: hit.section_tipo,
				section_label: sectionLabel,
				component_tipo: 'id',
				component_label: 'id',
			});
			for (const columnTipo of columns) {
				context.push({
					section_tipo: hit.section_tipo,
					section_label: sectionLabel,
					component_tipo: columnTipo,
					component_label: await termByTipo(columnTipo, lang),
				});
			}
		}

		// One row: the id cell (no value key) + a value cell per column.
		// `hit.section_id` is already an int off the relation index — emit it
		// as-is (WC-2026-08-10-section-id-int-canonical repeals the String()).
		data.push({
			section_tipo: hit.section_tipo,
			section_id: hit.section_id,
			component_tipo: 'id',
		});
		for (const columnTipo of columns) {
			const cell: Record<string, unknown> = {
				section_tipo: hit.section_tipo,
				section_id: hit.section_id,
				component_tipo: columnTipo,
			};
			const value = await resolveCellValue(
				hit.section_tipo,
				hit.section_id,
				columnTipo,
				lang,
				unresolved,
				undefined,
				{ loadRecord },
			);
			if (value !== null) cell.value = value;
			data.push(cell);
		}
	}

	return { context, data, unresolved };
}
