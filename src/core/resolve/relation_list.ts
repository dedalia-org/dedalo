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
import {
	computeInfoOutputs,
	infoOutputValueString,
} from '../components/component_info/widgets/registry.ts';
import { resolveInverseEntries } from '../components/component_inverse/emit.ts';
import { type IriLabelFrame, resolveIriTitles } from '../components/component_iri/resolve_title.ts';
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
import {
	configChildrenArePerLocator,
	configChildrenArePerTarget,
	exportConfigChildren,
	isDirectConfigChild,
	isImplicitConfigChild,
	pointerIsExistenceOnly,
} from '../relations/config_children.ts';
import { resolveLocatorLabels } from '../relations/datalist.ts';
import { componentLocators } from '../relations/locator_source.ts';
import { filterAuthorizedRelated } from '../relations/request_config/implicit.ts';
import { findInverseReferences } from '../search/search_related.ts';
import { sectionRelationListTipos } from '../section/related_list.ts';
import type { Principal } from '../security/permissions.ts';
import { currentPrincipal } from '../security/request_context.ts';
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
	// links name the column tipos. Virtual-aware (a virtual without its own node
	// inherits the real section's — PHP get_relation_list_obj's resolve_virtual
	// retry, class.relation_list.php:305-321) and first by order_number: THE
	// section fact, section/related_list.ts sectionRelationListTipos (T0-7, T0-8 —
	// the relation_index columns read the same lookup). Verbatim here — the
	// PRINCIPAL-FREE fact; the readers filter it with
	// authorizedRelationListColumns below.
	return [...(await sectionRelationListTipos(sectionTipo))];
}

/**
 * The grid columns of one referencing section the CURRENT requester may read
 * (STEP 5 on the TOP-LEVEL columns): a column the requester holds no grant on
 * has neither a context column nor a data cell — the edit form's related_list
 * rule (section/related_list.ts sectionRelatedListConfig) through the SAME
 * predicate the children below use (request_config/implicit.ts
 * filterAuthorizedRelated: the ALS principal, per call; no principal = an
 * internal resolution = no filter). Ontology order kept. PHP's grid read every
 * column unfiltered (class.relation_list.php get_ar_data) — deliberate
 * tightening, WC-2026-11-11-relation-list-column-grants. Every reader of the
 * pointing section's relation_list columns (the relation_list panel, the
 * related_search payload) goes through here.
 */
export async function authorizedRelationListColumns(sectionTipo: string): Promise<string[]> {
	const declared = await getRelationListColumns(sectionTipo);
	if (declared.length === 0) return declared;
	const allowed = await filterAuthorizedRelated(declared, sectionTipo);
	return declared.filter((tipo) => allowed.has(tipo));
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
	 * a single byte of the target is read; absent (the interactive callers —
	 * relation_list panel, Referencias, related labels), no RECORD crossing is
	 * asked (their own doors scope their output), but the IMPLICIT children
	 * still answer to the edit form's STEP 5 filter for the ALS principal
	 * (readableChildren — the same predicate the frontier key binds).
	 *
	 * A seam of FUNCTIONS, not a scope object: the caller owns the law (the
	 * export binds the frontier's THROW, diffusion/export/atoms.ts), and this
	 * module stays free of any diffusion import. The host record itself is NOT
	 * asked — the caller authorized it before asking for its value.
	 */
	frontier?: CellFrontier;
	/**
	 * The CALLER ddo's fields_separator for a component_iri cell's value+title
	 * glue (PHP component_iri::get_export_value :354-358: ddo.fields_separator
	 * ?? properties.fields_separator ?? ', '). Set by the export walk for the
	 * iri leaf it reads; absent (every interactive reader, which has no ddo) the
	 * component's own `properties.fields_separator` ?? ', ' applies (T0-9 D7).
	 */
	iriFieldsSeparator?: string;
	/**
	 * T0-9 D3 — the EXPORT LEAF's empty-item rule (PHP get_export_value: one
	 * atom per stored data item, an empty value included — component_input_text
	 * :96-107, component_date :296-303; a media component ALWAYS one atom,
	 * '' when it has no URL — component_media_common :340-372). Set by the
	 * export walk ONLY on the literal / media leaf it reads (atoms.ts
	 * emitLiteralItemAtoms / emitPlainAtom), so the records join keeps the
	 * item's slot ('a |  | c'). Honoured by the string, date and media
	 * families; a component with NO stored item still resolves null (PHP: no
	 * atom). Absent (every interactive reader) = empties dropped.
	 */
	keepEmptyItems?: boolean;
	/**
	 * INTERNAL — the cycle guard's PATH (see {@link withCycleGuard}): the
	 * (record × component) expansions open above this call. Minted by the first
	 * guarded expansion and threaded down through the same options object;
	 * a caller never sets it.
	 */
	cycleTrail?: Set<string>;
}

/**
 * THE CYCLE GUARD of the flat reader. A value crosses into other records
 * (relation targets, iri label frames) and re-enters resolveCellValue there;
 * the per-locator children of a config-less relation_index are its pointing
 * section's relation_list columns, which may list that very index — so records
 * that point at each other (or at themselves) recursed without end. Same law
 * as the export walk's relation_cycle trail (diffusion/export/atoms.ts
 * fanOutRelation): no depth ceiling (a long chain of DISTINCT records is
 * walked); the SAME component expanded again on the SAME record along the
 * current path resolves to nothing and is NOTED `relation_cycle:<tipo>` in
 * `unresolved` — never a silent cut. Path-scoped (added on entry, removed on
 * exit), so a record reached twice on sibling paths resolves both times.
 */
async function withCycleGuard<T>(
	sectionTipo: string,
	address: number,
	componentTipo: string,
	unresolved: string[],
	opts: CellValueResolveOptions | undefined,
	empty: T,
	expand: (guardedOpts: CellValueResolveOptions) => Promise<T>,
): Promise<T> {
	const trail = opts?.cycleTrail ?? new Set<string>();
	const key = `${sectionTipo}\u0000${address}\u0000${componentTipo}`;
	if (trail.has(key)) {
		const note = `relation_cycle:${componentTipo}`;
		if (!unresolved.includes(note)) unresolved.push(note);
		return empty;
	}
	trail.add(key);
	try {
		return await expand(opts?.cycleTrail === trail ? opts : { ...opts, cycleTrail: trail });
	} finally {
		trail.delete(key);
	}
}

/**
 * The crossings a cell resolution asks about (CellValueResolveOptions.frontier).
 */
export interface CellFrontier {
	/**
	 * May the resolution read this TARGET record? `false` = skip the target
	 * (the surface already made the refusal loud); a THROW = the surface's law.
	 * The id travels VERBATIM (an external remote id is never Number()-ed).
	 * `reads` = the component tipos the resolution reads AT this record (a
	 * dataframe child excluded: it reads the owner), or null when the branch
	 * cannot name them (a label resolved through another module) — the
	 * surface may weigh a crossing by what it reads (the export's display
	 * carve-out, frontier_scope.ts D4) and must take null as "unknown".
	 * `frames` = the dataframe entries read AT this record when it is their
	 * OWNER (asked per entry, never per slot).
	 */
	crossRecord(
		sectionTipo: string,
		sectionId: number | string,
		reads: readonly string[] | null,
		frames?: readonly FrameRead[],
	): Promise<boolean>;
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

/** One dataframe entry read at its owner record (CellFrontier.crossRecord `frames`). */
export interface FrameRead {
	readonly frameTipo: string;
	readonly mainTipo: string;
	readonly pairId: number | string;
	readonly sectionTipo: string;
	readonly sectionId: number | string;
}

/** One config child of a relation / frame, with the map it came from. */
export interface ConfigChild {
	tipo: string;
	/** True when it came from the IMPLICIT legacy map (ontology `relations`). */
	implicit: boolean;
}

/**
 * The children the caller may read at `targetSection`: every explicit child
 * (read at the subdatum floor, as the edit form shows it), and the IMPLICIT
 * ones the requester may read there. Order-preserving.
 *
 * ONE PREDICATE for the implicit set: armed, the frontier's key (the export
 * binds frontier_scope.ts frontierAllowedComponents); unarmed (the interactive
 * callers — relation_list panel, Referencias, related labels), the edit form's
 * OWN STEP 5 filter, request_config/implicit.ts filterAuthorizedRelated —
 * the same frontierAllowedComponents for the ALS principal, asked per call
 * (no principal = an internal resolution = no filter, as the edit form).
 */
async function readableChildren<T extends ConfigChild>(
	children: readonly T[],
	targetSection: string,
	opts: CellValueResolveOptions | undefined,
): Promise<T[]> {
	const implicitTipos = children.filter((child) => child.implicit).map((child) => child.tipo);
	if (implicitTipos.length === 0) return [...children];
	const frontier = opts?.frontier;
	const allowed =
		frontier === undefined
			? await filterAuthorizedRelated(implicitTipos, targetSection)
			: await frontier.implicitChildren(targetSection, implicitTipos);
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
function mediaItemsHoldAFile(items: unknown): boolean {
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
 * order (PHP field-dimension order = ddo order): the direct children of THE
 * export children seam (relations/config_children.ts exportConfigChildren —
 * explicit map, per-locator relation_index map, or the edit form's implicit
 * derivation). Dataframe children are FLAGGED — they resolve as frame fields
 * folded into the flat cell. The export walk (src/diffusion/export/atoms.ts
 * fanOutRelation) reads the SAME seam, under the caller's map when one is
 * declared. `locatorSectionTipo` = the target section, required for a
 * per-locator component (configChildrenArePerLocator).
 */
async function relationTargetChildren(
	componentTipo: string,
	locatorSectionTipo?: string,
): Promise<(ConfigChild & { isDataframe: boolean })[]> {
	const children: (ConfigChild & { isDataframe: boolean })[] = [];
	for (const child of await ownConfigChildren(componentTipo, locatorSectionTipo)) {
		children.push({
			...child,
			isDataframe: (await getModelByTipo(child.tipo)) === 'component_dataframe',
		});
	}
	return children;
}

/**
 * The components a dataframe's frames resolve at each FRAME TARGET record
 * (the frame's own config ddo_map direct children, then its implicit map).
 */
function dataframeFrameChildren(frameTipo: string): Promise<ConfigChild[]> {
	return ownConfigChildren(frameTipo);
}

/**
 * A component's config children, in map order: the direct children of
 * exportConfigChildren (config_children.ts isDirectConfigChild — parent
 * 'self' or the owner's tipo; no parent = no child, D11) — each tagged with
 * the map it came from, because the two answer to different keys
 * (readableChildren).
 */
async function ownConfigChildren(
	ownerTipo: string,
	locatorSectionTipo?: string,
): Promise<ConfigChild[]> {
	return (await exportConfigChildren(ownerTipo, locatorSectionTipo))
		.filter((child) => typeof child?.tipo === 'string' && isDirectConfigChild(child, ownerTipo))
		.map((child) => ({ tipo: child.tipo as string, implicit: isImplicitConfigChild(child) }));
}

/**
 * Per-TARGET flat values of one relation component on one record — the
 * per-locator half of the datalist branch of resolveCellValue (PHP
 * get_export_value recursion): with config children, each locator target
 * flattens as its children's values joined by the COMPONENT's
 * fields_separator (rsc368's ' | ', rsc139's ', '); without config children,
 * the target label resolves via the datalist — in STORED locator order.
 * resolveCellValue joins the flattened parts with its itemSeparator.
 *
 * THE INTERACTIVE FLAT READER (relation_list panel, Referencias, related
 * labels — no caller map by definition). The EXPORT does not read through
 * here for a relation leaf: its value cells and WC-008 compact cells are folds
 * over the export walk's own atoms (src/diffusion/export/join_atoms.ts, T0-9
 * owner decision D1) — the caller map, the PHP separator precedence and the
 * PHP join rules live there.
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
	const address = matrixRecordAddress(sectionId);
	if (address === null) return [];
	return withCycleGuard(sectionTipo, address, componentTipo, unresolved, opts, [], (guarded) =>
		expandRelationTargets(
			sectionTipo,
			sectionId,
			address,
			componentTipo,
			lang,
			unresolved,
			guarded,
		),
	);
}

/** resolveRelationTargetValues inside its cycle guard (`opts` carries the trail). */
async function expandRelationTargets(
	sectionTipo: string,
	sectionId: number | string,
	address: number,
	componentTipo: string,
	lang: string,
	unresolved: string[],
	opts: CellValueResolveOptions,
): Promise<RelationTargetValue[]> {
	const model = await getModelByTipo(componentTipo);
	if (model === null) return [];
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return [];
	// The loader seam consults AFTER the null-table early-return (parity
	// keystone: a cached loader must never resolve what the default can't).
	const record = await (opts?.loadRecord ?? memoizedReadMatrixRecord)(table, sectionTipo, address);
	if (record === null) return [];

	// THE locator source (relations/locator_source.ts): the stored slice, or the
	// computed set of a model that stores nothing (relation_children /
	// relation_index) — keyed on the descriptor's resolveData contract.
	const locators = await componentLocators(
		{ sectionTipo, sectionId: address, columns: record.columns as Record<string, unknown> },
		componentTipo,
		model,
	);
	if (locators.length === 0) return [];

	// A per-locator component (config-less relation_index) has no static
	// children: they are derived per target section below. ANY relation_index
	// (D9) asks per pointer whether it is existence only (config_children.ts
	// pointerIsExistenceOnly, the edit form's predicate).
	const perLocator = await configChildrenArePerLocator(componentTipo);
	const perTarget = await configChildrenArePerTarget(componentTipo);
	const children = perLocator ? null : await relationTargetChildren(componentTipo);

	const targets: RelationTargetValue[] = [];
	if (children === null || children.length > 0) {
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
			// The children THIS caller may read at THIS target: explicit ones at the
			// subdatum floor, implicit ones per the frontier's component key (D1) —
			// decided first, so the crossing can name what it reads there.
			const existenceOnly =
				perTarget && (await pointerIsExistenceOnly(componentTipo, targetSection));
			const targetChildren = await readableChildren(
				children === null || existenceOnly
					? await relationTargetChildren(componentTipo, targetSection)
					: children,
				targetSection,
				opts,
			);
			if (opts?.frontier !== undefined) {
				const reads = targetChildren
					.filter((child) => !child.isDataframe)
					.map((child) => child.tipo);
				if (!(await opts.frontier.crossRecord(targetSection, targetId as number | string, reads))) {
					continue;
				}
			}
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
			// EXISTENCE ONLY (T0-9 D6 — the edit form's rule, one predicate): a
			// pointer in a section the requester may not read shows its section
			// NAME + section_id and nothing of its content — never dropped.
			if (existenceOnly) {
				targets.push({
					index,
					sectionTipo: targetSection,
					sectionId: targetId as number | string,
					parts: [`${await termByTipo(targetSection, lang)} ${String(targetId)}`],
				});
				continue;
			}
			const fieldParts: string[] = [];
			for (const child of targetChildren) {
				if (child.isDataframe) {
					// Frames live on THIS record's relation column, paired to the
					// MAIN locator by (dd490, main, id_key = locator.id) — PHP
					// relation_common :871-897; empty/no-frames contributes nothing.
					const frameFlat = await resolveDataframeFlatValue(
						{ ...record, sectionTipo, sectionId },
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
			// SECOND LAYER: in the export every target reaching this branch was
			// already crossed (the leaf's own targets by resolver.ts, deeper ones
			// per locator by atoms.ts fanOutRelation), so removing this check is
			// not observable today — it keeps the branch safe for any new caller
			// that passes `frontier` without walking through those doors.
			if (
				opts?.frontier !== undefined &&
				typeof locator?.section_tipo === 'string' &&
				locator.section_id !== undefined &&
				!(await opts.frontier.crossRecord(
					locator.section_tipo,
					locator.section_id as number | string,
					null, // the label's components are implicit.ts's to pick — unknown here
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
	/** The OWNER record + its address (the frames are its data). */
	record: { columns: { relation?: unknown }; sectionTipo: string; sectionId: number | string },
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
	// THE FRONTIER: the frames are the OWNER's data — crossed on the owner, per
	// entry (free for an owner in record scope; D4 asks the display per entry).
	if (opts?.frontier !== undefined) {
		const frames: FrameRead[] = [];
		for (const entry of paired) {
			const frame = entry as { section_tipo?: unknown; section_id?: unknown };
			if (typeof frame.section_tipo !== 'string' || frame.section_id === undefined) continue;
			frames.push({
				frameTipo,
				mainTipo: mainComponentTipo,
				pairId,
				sectionTipo: frame.section_tipo,
				sectionId: frame.section_id as number | string,
			});
		}
		if (!(await opts.frontier.crossRecord(record.sectionTipo, record.sectionId, [], frames))) {
			return null;
		}
	}

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
		const readableFrameChildren = await readableChildren(
			frameChildren,
			frameTarget.section_tipo,
			opts,
		);
		if (
			opts?.frontier !== undefined &&
			!(await opts.frontier.crossRecord(
				frameTarget.section_tipo,
				frameTarget.section_id as number | string,
				readableFrameChildren.map((child) => child.tipo),
			))
		) {
			continue;
		}
		const fields: string[] = [];
		for (const child of readableFrameChildren) {
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

/**
 * The iri TITLE read off ONE label frame (the IriLabelReader of the flat-iri
 * branch of resolveDataframeFlatValue): every non-empty label component on the
 * frame's target record, joined ', '; null when none resolves.
 *
 * THE FRONTIER (T0-1): the label lives on the FRAME's target record — STRICT
 * (null): an iri title is beyond any relation column's display, so a frame
 * whose record the frontier refuses yields no title at all.
 */
async function resolveIriFrameTitle(
	frame: IriLabelFrame,
	lang: string,
	unresolved: string[],
	opts: CellValueResolveOptions | undefined,
): Promise<string | null> {
	if (
		opts?.frontier !== undefined &&
		!(await opts.frontier.crossRecord(frame.sectionTipo, frame.sectionId, null))
	) {
		return null;
	}
	const labels = await resolveIriFrameLabels(frame, lang, unresolved, opts);
	return labels.length > 0 ? labels.join(', ') : null;
}

/** Each of the frame's label components resolved on its target record; empties dropped. */
async function resolveIriFrameLabels(
	frame: IriLabelFrame,
	lang: string,
	unresolved: string[],
	opts: CellValueResolveOptions | undefined,
): Promise<string[]> {
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
	return labels;
}

/** One component's flat display string on one record (PHP get_value). */
export async function resolveCellValue(
	sectionTipo: string,
	/**
	 * The record's id, RAW: a matrix address (int, or its unswept convertible
	 * string form) or an EXTERNAL remote id kept VERBATIM ('000065686').
	 */
	sectionId: number | string,
	componentTipo: string,
	lang: string,
	unresolved: string[],
	/** Multi-item join (default ' | ', the relation_list panel glue). */
	itemSeparator: string = RECORDS_SEPARATOR,
	opts?: CellValueResolveOptions,
): Promise<string | null> {
	const items = await resolveCellItems(
		sectionTipo,
		sectionId,
		componentTipo,
		lang,
		unresolved,
		itemSeparator,
		opts,
	);
	return items === null ? null : items.join(itemSeparator);
}

/**
 * {@link resolveCellValue} BEFORE the multi-item join: one string per data
 * item (empties dropped), null when nothing resolves. The export walk emits a
 * literal's items as ONE ATOM EACH (PHP component_common::get_export_value —
 * one atom per data item), so the value fold joins them with the leaf
 * segment's separator, never a pre-join. `itemSeparator` only reaches the
 * external family, whose remote value arrives already joined (one item).
 */
export async function resolveCellItems(
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
	/** The external family's remote multi-value join (one item comes back). */
	itemSeparator: string = RECORDS_SEPARATOR,
	opts?: CellValueResolveOptions,
): Promise<string[] | null> {
	const model = await getModelByTipo(componentTipo);
	if (model === null) return null;

	// DERIVED families resolve BEFORE the record load, because their sections
	// have no record to load: an external section (zenon1) owns no matrix table
	// and no rows — its "record" is the remote one. Falling through to the table
	// lookup would return null for every cell of a live section_list (zenon8
	// lists zenon3..zenon6), which is a silent blank, not an absence.
	if (getFlatValueFamily(model) === 'external') {
		const external = await resolveExternalCellValue(
			model,
			sectionTipo,
			sectionId,
			componentTipo,
			unresolved,
			itemSeparator,
			opts,
		);
		return external === null ? null : [external];
	}

	// Every other family reads the MATRIX record: a non-address (an external
	// remote id reaching a stored-family column) addresses no row.
	const address = matrixRecordAddress(sectionId);
	if (address === null) return null;

	// INVERSE (component_inverse): DERIVED — the host record's backlinks, never
	// its empty `misc` slot, so no record load. One item per backlink locator
	// (the caller record's id), in the edit view's order (section_id ASC) and
	// under the edit view's scope: the ALS principal (this is the request-path
	// flat reader), unreadable owners dropped (scopeInverseReferenceHits). A
	// malformed backlink (no owner section / component) is skipped, as PHP
	// component_inverse::get_export_value does.
	if (getFlatValueFamily(model) === 'inverse') {
		const parts = (await resolveInverseEntries(sectionTipo, address))
			.filter(
				(entry) =>
					typeof entry.from_section_tipo === 'string' &&
					entry.from_section_tipo !== '' &&
					typeof entry.from_component_tipo === 'string' &&
					entry.from_component_tipo !== '',
			)
			.map((entry) => String(entry.from_section_id));
		return parts.length > 0 ? parts : null;
	}

	// INFO (component_info + aliases): DERIVED — the LIVE widget outputs, never
	// the `misc` slot (WC-2026-09-03), so no record load. One item per output
	// value, in declaration order (PHP get_export_value), under the ALS
	// principal (this is the request-path flat reader; media_icons is
	// user-scoped) in 'list' mode (PHP relation_list instances its columns so).
	if (getFlatValueFamily(model) === 'info') {
		return resolveInfoCellItems(sectionTipo, address, componentTipo, lang, opts);
	}

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
		return [String(address)];
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
		const parts = items.map((item) =>
			item?.value === undefined || item.value === null ? '' : String(item.value),
		);
		return keptItems(parts, opts);
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
		const parts = ((value ?? []) as unknown[]).map((item) =>
			item === null || item === undefined || typeof item !== 'object'
				? ''
				: dateItemToValue(item as Record<string, unknown>, dateMode, { periodLabels }),
		);
		return keptItems(parts, opts);
	}

	if (family === 'iri') {
		// An iri title is read on its label FRAME's record — a crossing, so the
		// cycle guard applies (an iri whose label component is itself an iri).
		return withCycleGuard(sectionTipo, address, componentTipo, unresolved, opts, null, (guarded) =>
			resolveIriCellItems(record, componentTipo, lang, unresolved, guarded),
		);
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
		return parts.length > 0 ? parts : null;
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
		// D3: the export leaf's media atom exists even without a URL (PHP
		// from_scalar($path, '')) — the reached component keeps its slot.
		if (parts.length === 0 && opts?.keepEmptyItems === true) return [''];
		return parts.length > 0 ? parts : null;
	}

	if (!unresolved.includes(model)) unresolved.push(model);
	return null;
}

/** {@link resolveCellItems}' info branch: every declared output's live values. */
async function resolveInfoCellItems(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
	lang: string,
	opts?: CellValueResolveOptions,
): Promise<string[] | null> {
	const principal = currentPrincipal();
	const outputs = await computeInfoOutputs(componentTipo, {
		sectionTipo,
		sectionId,
		mode: 'list',
		lang,
		userId: principal?.userId,
		isAdmin: principal?.isGlobalAdmin,
	});
	if (outputs === null) return null;
	const parts = outputs.flatMap((output) => output.values.map(infoOutputValueString));
	return keptItems(parts, opts);
}

/**
 * A literal family's items (one per stored data item): empties dropped for
 * every interactive reader; KEPT for the export leaf (opts.keepEmptyItems, T0-9
 * D3). No stored item ⇒ null either way (PHP: no atom).
 */
function keptItems(parts: string[], opts: CellValueResolveOptions | undefined): string[] | null {
	const kept = opts?.keepEmptyItems === true ? parts : parts.filter((part) => part !== '');
	return kept.length > 0 ? kept : null;
}

/**
 * Flat iri: the iri value + its label-dataframe field joined per item
 * (resolveCellItems' iri branch, inside its cycle guard).
 */
async function resolveIriCellItems(
	record: MatrixRecord,
	componentTipo: string,
	lang: string,
	unresolved: string[],
	opts: CellValueResolveOptions,
): Promise<string[] | null> {
	// (default ', ')
	// ('Les dracmes empuritanes, Zenon'). v6 get_grid_value :466-483 — iri
	// FIRST, then the title, the opposite order from get_diffusion_value.
	//
	// The title itself is the dd560 label and NEVER the stored `title` key:
	// that rule (which frames pair with which item, which components carry
	// the label, and "no frame ⇒ no title") lives in ONE place,
	// components/component_iri/resolve_title.ts. Only the order and this
	// path's own record seam are local.
	const titles = await resolveIriTitles(record, componentTipo, (frame) =>
		resolveIriFrameTitle(frame, lang, unresolved, opts),
	);
	const glue = await iriFieldsGlue(componentTipo, opts);
	const parts: string[] = [];
	for (const item of storedIriItems(record, componentTipo)) {
		const part = joinIriItemFields(item, titles.get(String(item?.id)), glue);
		if (part !== null) parts.push(part);
	}
	return parts.length > 0 ? parts : null;
}

/** One stored component_iri item (raw: either key may be missing). */
type StoredIriItem = { iri?: unknown; id?: number | string };

/** The stored iri items of `componentTipo` on the record ([] when none). */
function storedIriItems(record: MatrixRecord, componentTipo: string): StoredIriItem[] {
	return ((record.columns.iri as Record<string, unknown[]> | null)?.[componentTipo] ??
		[]) as StoredIriItem[];
}

/** The glue: caller ddo → properties → ', ' (PHP component_iri :354-358). */
async function iriFieldsGlue(
	componentTipo: string,
	opts: CellValueResolveOptions,
): Promise<string> {
	return (
		opts?.iriFieldsSeparator ??
		(await componentSeparators(componentTipo, false)).fields ??
		IRI_FIELDS_SEPARATOR
	);
}

/**
 * One item's cell text: the non-empty iri FIRST, then its title, glued; null
 * when the item has neither (the item contributes nothing).
 */
function joinIriItemFields(
	item: StoredIriItem,
	title: string | undefined,
	glue: string,
): string | null {
	const fields: string[] = [];
	if (typeof item?.iri === 'string' && item.iri !== '') fields.push(item.iri);
	if (title !== undefined) fields.push(title);
	return fields.length > 0 ? fields.join(glue) : null;
}

/** PHP component_iri::get_export_value value+title glue default (:358). */
const IRI_FIELDS_SEPARATOR = ', ';

/** The component's declared show.fields_separator (?? ', ', PHP default). */
const cellFieldsSeparatorCache = createOntologyCache<string, string>();

/** A component's OWN declared separators (null = none declared). */
export interface ComponentSeparators {
	readonly fields: string | null;
	readonly records: string | null;
}

/** `${tipo}|${withShow}` → its declared separators (ontology-derived). */
const componentSeparatorsCache = createOntologyCache<string, ComponentSeparators>();

/** Drop the ontology-derived separator caches. */
export function clearFieldsSeparatorCache(): void {
	cellFieldsSeparatorCache.clear();
	componentSeparatorsCache.clear();
}

/**
 * The separators a component DECLARES for the export join (PHP
 * get_export_value precedence below the caller ddo): a relation reads its own
 * request_config `show` first (`withShow` — component_relation_common :763),
 * then its `properties` (every model — component_common
 * build_export_path_segment); null where nothing is declared (the join's
 * defaults then apply). The caller-ddo rung is the caller's (the export walk
 * holds the map entry). Ontology-derived, principal-free.
 */
export async function componentSeparators(
	componentTipo: string,
	withShow: boolean,
): Promise<ComponentSeparators> {
	const cacheKey = `${componentTipo}|${withShow ? 1 : 0}`;
	const cached = componentSeparatorsCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const properties = ((await getNode(componentTipo))?.properties ?? null) as {
		source?: { request_config?: unknown };
		fields_separator?: unknown;
		records_separator?: unknown;
	} | null;
	let show: { fields_separator?: unknown; records_separator?: unknown } | undefined;
	const rcs = properties?.source?.request_config;
	if (withShow && Array.isArray(rcs)) {
		const { selectConfigItemForConcern } = await import(
			'../relations/request_config/engine_select.ts'
		);
		const main = await selectConfigItemForConcern(
			rcs as never,
			'listColumns',
			'resolve/relation_list.componentSeparators',
		);
		show = (main as { show?: typeof show } | null | undefined)?.show;
	}
	const pick = (...candidates: unknown[]): string | null => {
		for (const candidate of candidates) if (typeof candidate === 'string') return candidate;
		return null;
	};
	const separators: ComponentSeparators = {
		fields: pick(show?.fields_separator, properties?.fields_separator),
		records: pick(show?.records_separator, properties?.records_separator),
	};
	componentSeparatorsCache.set(cacheKey, separators);
	return separators;
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
			columns = await authorizedRelationListColumns(hit.section_tipo);
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
