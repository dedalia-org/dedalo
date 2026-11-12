/**
 * Export ATOMS — the export-specific projection over the shared engine's
 * atom events (DIFFUSION_PLAN D8/P6), rebuilt 2026-07-08 to the PHP oracle's
 * export-atom shape (core/dd_grid/class.export_atom.php +
 * component_relation_common::get_export_value).
 *
 * The RESOLUTION (which records, which locators, in which order, with which
 * index provenance) is the shared resolver's resolveRecordAtoms; this module
 * turns those events into PHP-shaped export atoms.
 *
 * ONE WALKER, THREE FOLDS (T0-9, owner decision D1 — PHP export_value::join
 * over get_export_value atoms): every format reads a column through the SAME
 * walk (`walkFieldAtoms` → `fanOutRelation`), so the same ddo reads the same
 * records, the same components and the same media in every format:
 *
 * - grid_value: the atoms themselves — one per placed value, carrying the FULL
 *   SEGMENT PATH (PHP export_path_segment[]): every segment names its runtime
 *   owner (`{section_tipo}_{component_tipo}`), the RAW stored-locator position
 *   that reached it (`item_index`) and the separators PHP resolves for it
 *   (caller ddo → own request_config show → properties → null). The tabulator
 *   (grid.ts) derives the column key, the '|n' suffixes and the row explosion
 *   FROM the segments, per breakdown;
 * - value: the flat cell = join_atoms.ts `joinExportAtoms` of the column's
 *   atoms (record/field dimensions, the records-level separator switch, PHP
 *   empty() incl. '0', empty records keep their slot — D3);
 * - WC-008 compact portal cells: one atom per reference whose value is the
 *   SAME join over that reference's own atom subset.
 *
 * Relation-LEAF fan-out (PHP get_export_value recursion): a declared path
 * that ENDS on a relation component does not stop there — its children (the
 * CALLER's map entries when the caller's map declares them, else the
 * component's own config, relations/config_children.ts) resolve per locator
 * target, and relation-model children recurse further, each hop appending a
 * segment with the locator position. component_dataframe children pair their
 * frames on the record HOLDING the relation.
 *
 * Parents chains (WC-049, per-ddo value_with_parents checkbox): each relation
 * locator additionally emits its target's ancestor chain (getParentsRecursive
 * nearest-first × thesaurus term resolver, ' > ' joined, self excluded) as ONE
 * atom under a sibling `sub_id:'parents'` segment — the tabulator derives the
 * '#parents' column from the segment identity; the flag inherits down every
 * fan-out level (PHP export_context::descend). The VALUE format folds the
 * leaf level's chains into a MIRROR of the term cell (join_atoms.ts
 * joinExportAtomsMirrored); dedalo_raw never grows one.
 *
 * Calculated relations (T0-9 D4, per-ddo value_with_references checkbox): a
 * declared leaf component_relation_related whose directionality derives
 * relations (dd467 / dd621) additionally fans out — through the SAME
 * fanOutRelation, the same config children, the same frontier crossing — over
 * its CALCULATED locators (core relations/locator_source.ts calculatedLocators:
 * PHP get_data_with_references() minus the stored), under a sibling
 * `sub_id:'references'` segment appended to the declared chain. grid_value
 * derives the '#references' column from that segment identity; the VALUE format
 * folds those atoms (segment stripped) with the main cell's own join into a
 * sibling `<column>#references` cell. Never inside the main cell; the declared
 * leaf only (nested related children are not expanded); dedalo_raw never.
 *
 * Media (row_media.ts): the media a cell READ is captured by the same walk —
 * per atom (grid_value), per cell (value: every read of the walk, in read
 * order), and for dedalo_raw by the SAME walk in its media-only, STRICT-
 * frontier mode (`collectRawMediaAddresses`): no second mirror of the reads.
 *
 * Byte-parity notes (pinned by test/parity/tool_export_breakdown_differential):
 * - empty/null leaf values are SKIPPED (no atom) — the PHP empty() rule;
 * - segments use the RUNTIME owner section (PHP instantiates every component
 *   at the locator target — multi-section autocompletes key per target);
 * - all caches live in the per-request ExportRun or in ontology-scoped caches
 *   (request isolation, no module state).
 */

import {
	computeInfoOutputs,
	infoOutputValueString,
} from '../../core/components/component_info/widgets/registry.ts';
import { resolveInverseEntries } from '../../core/components/component_inverse/emit.ts';
import { getFlatValueFamily } from '../../core/components/registry.ts';
import { isMediaModel } from '../../core/concepts/media.ts';
import { canonicalizeStoredSectionId, isSectionId } from '../../core/concepts/section_id.ts';
import { dataframeEntryMatches } from '../../core/concepts/subdatum.ts';
import { getColumnNameByModel, getModelByTipo, getNode } from '../../core/ontology/resolver.ts';
import {
	configChildrenArePerLocator,
	configChildrenArePerTarget,
	exportConfigChildren,
	isDirectConfigChild,
	isImplicitConfigChild,
	pointerIsExistenceOnly,
} from '../../core/relations/config_children.ts';
import {
	calculatedLocators,
	componentHasCalculatedLocators,
	componentLocators,
} from '../../core/relations/locator_source.ts';
import { getParentsRecursive } from '../../core/relations/parent.ts';
import type {
	CellValueResolveOptions,
	MediaReadAddress,
} from '../../core/resolve/relation_list.ts';
import {
	addMediaReadAddress,
	componentSeparators,
	resolveCellItems,
	resolveCellValue,
} from '../../core/resolve/relation_list.ts';
import { runWithRequestLangs } from '../../core/resolve/request_lang.ts';
import type { RawConfigDdo } from '../../core/section/list_definitions/section_list.ts';
import { currentPrincipal } from '../../core/security/request_context.ts';
import { getTermByLocator } from '../../core/ts_object/term_resolver.ts';
import type { FieldPlan } from '../plan/types.ts';
import type { ExportAtomRun, ExportCrossingReach } from '../resolve/resolver.ts';
import {
	createExportAtomRun,
	exportCrossRecord,
	exportImplicitChildren,
	getBoundedRunMemo,
	loadExportRecord,
	loadExportRecordFromTable,
	resolveRecordAtoms,
	setBoundedRunMemo,
} from '../resolve/resolver.ts';
import { joinExportAtoms, joinExportAtomsMirrored } from './join_atoms.ts';

/** PHP export_value records_separator — the depth-0 records glue, and the
 * input_text/date/iri leaf item glue default (emitLiteralItemAtoms). */
const RECORDS_SEPARATOR = ' | ';

/** PHP parents_segment fields_separator — the ancestor-chain glue (WC-049:
 * TS pre-joins the chain into ONE atom; PHP emitted one atom per ancestor and
 * joined at tabulate time — same cell bytes). */
const PARENTS_SEPARATOR = ' > ';

/**
 * Per-request export run state: the shared atom run + projection caches.
 *
 * EVERY growing map here is RUN-SCOPED (one ExportRun per export — grid.ts
 * builds it per call, never at module scope) AND BOUNDED by
 * `atoms.cacheLimit` (resolver.ts EXPORT_RUN_CACHE_LIMIT by default): each is
 * a pure memo, so an overflow clears it whole and the next lookup recomputes
 * the same value — memory stays flat over a 300k-record export, output does
 * not move. Gate: test/unit/export_run_bounds_identity_native.test.ts.
 */
export interface ExportRun {
	atoms: ExportAtomRun;
	/** relation component tipo → its OWN request_config child ddos (bounded). */
	ownChildren: Map<string, RawConfigDdo[]>;
	/** `${section_tipo}:${section_id}:${lang}` → resolved ' > ' ancestor chain
	 * (null = target has no hierarchy). Shared targets resolve ONCE per run
	 * while the bounded memo holds them. */
	parentsChains: Map<string, string | null>;
	/** leaf component tipo → can its walk reach a media component? (bounded) */
	mediaReach: Map<string, boolean>;
	/** Threads the run's record cache into the shared flat-value resolvers —
	 * without it every relation-target label re-reads its record per row (N+1). */
	cellOpts: CellValueResolveOptions;
	/**
	 * THE RUN'S INTERFACE LANGUAGE, for a DIRECT caller of `resolveValueCell` /
	 * `collectGridAtoms` (Rule 6 — outside a request the ALS backstop answers
	 * the INSTALLATION default, silently). Set → every cell resolves inside
	 * `runWithRequestLangs({applicationLang: this, dataLang: <the cell's lang>})`
	 * — covering the two LANG backstops the walk reads (a component_date 'period'
	 * cell's unit labels via `currentApplicationLang()`, a component_external
	 * cell's remote row via `currentDataLang()`). Unset → the ambient scope.
	 *
	 * It covers the langs ONLY. The walk reads the PRINCIPAL ambiently in ONE
	 * corner — a leaf with an implicit config that names NO component resolves
	 * its label through datalist.ts resolveLocatorLabels → implicit.ts
	 * filterAuthorizedRelated → `currentPrincipal()`. Every relation reads its
	 * children through the principal-free core seam `exportConfigChildren`
	 * (relations/config_children.ts); THOSE are filtered by the export run's own
	 * frontier (resolver.ts exportImplicitChildren, T0-1 / S03), not by the
	 * ambient principal. The COMPLETE scope — both langs, the principal, the
	 * refusal collector — is grid.ts `openExportGrid`'s export scope, which is
	 * what every export goes through; grid.ts therefore leaves this unset.
	 */
	applicationLang?: string;
	/**
	 * CAPTURE MEDIA ADDRESSES (row_media.ts): when true, every grid atom carries
	 * the media components its value was read from (`GridAtom.media`), and
	 * `resolveValueCellWithMedia` / `collectRawMediaAddresses` answer them for
	 * the value and dedalo_raw formats. Set by grid.ts only for a capturing
	 * walk (ExportGridRunOptions.captureMedia); off, nothing changes.
	 */
	captureMedia?: boolean;
	/**
	 * A capturing grid_value walk's sink for the media of values it DROPS
	 * (empty display value — e.g. only the 'original' quality exists yet, or
	 * the export base is unset — so no atom, and no cell, carries them). The
	 * value format still reads that media, so grid_value must too, or the same
	 * ddo archives different files per format. Set per collectGridAtoms call,
	 * never on the run itself.
	 */
	droppedMedia?: MediaReadAddress[];
	/**
	 * EVERY media read of one walk, in read order (value cells and the dedalo_raw
	 * media walk): kept or dropped, the walk's reads land here. Set on a scoped
	 * copy per call, never on the run itself.
	 */
	mediaSink?: MediaReadAddress[];
	/**
	 * T0-9 D4 value format: the sink the `#references` walk reads into INSTEAD
	 * of `mediaSink`, so each media address is credited to the column whose
	 * cell read it (the sibling `#references` column, never the main one) —
	 * as grid_value credits each atom's media to its own placed column. Set on
	 * a scoped copy per value cell, never on the run itself.
	 */
	referencesMediaSink?: MediaReadAddress[];
}

/** Keep the media of a dropped (empty-valued) atom on the walk's sink. */
function noteDroppedMedia(run: ExportRun, media: readonly MediaReadAddress[] | undefined): void {
	if (run.droppedMedia === undefined || media === undefined) return;
	for (const read of media) addMediaReadAddress(run.droppedMedia, read);
}

/**
 * A capturing twin of `base` — or null when the walk does not capture. Each
 * call gets its OWN list, so a capture is scoped to exactly the resolution it
 * wraps (one atom); the walk's sink (if any) sees every read too.
 */
function mediaCapture(
	run: ExportRun,
	base: CellValueResolveOptions,
): { opts: CellValueResolveOptions; media: MediaReadAddress[] } | null {
	if (run.captureMedia !== true && run.mediaSink === undefined) return null;
	const media: MediaReadAddress[] = [];
	const sink = run.mediaSink;
	return {
		media,
		opts: {
			...base,
			onMediaRead: (read) => {
				addMediaReadAddress(media, read);
				if (sink !== undefined) addMediaReadAddress(sink, read);
			},
		},
	};
}

/** The `media` field of an atom: present only when something was read. */
function mediaField(media: MediaReadAddress[] | undefined): { media?: MediaReadAddress[] } {
	return media !== undefined && media.length > 0 ? { media } : {};
}

/** Fresh per-request run (never module-scoped — request isolation). */
export function createExportRun(
	options: { cacheLimit?: number; applicationLang?: string } = {},
): ExportRun {
	const atoms = createExportAtomRun({ cacheLimit: options.cacheLimit });
	return {
		...(options.applicationLang === undefined ? {} : { applicationLang: options.applicationLang }),
		atoms,
		ownChildren: new Map(),
		parentsChains: new Map(),
		mediaReach: new Map(),
		cellOpts: {
			loadRecord: (tableName, sectionTipo, sectionId) =>
				loadExportRecordFromTable(atoms, tableName, sectionTipo, sectionId),
			// THE FRONTIER OF EVERY NESTED CELL READ (T0-1). Inert until the door
			// sets `atoms.frontier` (grid.ts, non-admins): both functions read the
			// run's scope at CALL time, and with none they cross everything —
			// every internal user of this walk is byte-unchanged.
			frontier: {
				// `reads` null = the cell cannot name what it reads there → the
				// full law; a list = the display carve-out may apply (D4).
				crossRecord: (sectionTipo, sectionId, reads, frames) =>
					exportCrossRecord(
						atoms,
						sectionTipo,
						sectionId,
						reads === null ? 'strict' : { reads, ...(frames === undefined ? {} : { frames }) },
					),
				implicitChildren: (sectionTipo, componentTipos) =>
					exportImplicitChildren(atoms, sectionTipo, componentTipos),
			},
		},
	};
}

/**
 * A config map's children the walk may read at `targetSection` — explicit
 * children at the subdatum floor (owner decision D3), implicit ones per the
 * run's frontier (D1: an ungranted one is dropped and noted).
 */
async function readableMapChildren(
	run: ExportRun,
	children: RawConfigDdo[],
	targetSection: string,
): Promise<RawConfigDdo[]> {
	const implicitTipos = children.filter(isImplicitConfigChild).map((child) => child.tipo);
	if (implicitTipos.length === 0) return children;
	const allowed = await exportImplicitChildren(run.atoms, targetSection, implicitTipos);
	return children.filter((child) => !isImplicitConfigChild(child) || allowed.has(child.tipo));
}

/** The tipos of `tipos` that are not dataframes (a dataframe reads the OWNER record). */
async function nonDataframeTipos(tipos: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	for (const tipo of tipos) {
		if ((await getModelByTipo(tipo)) !== 'component_dataframe') out.push(tipo);
	}
	return out;
}

/**
 * The ' > '-joined ancestor chain of one relation target (PHP
 * component_relation_common::get_locator_value show_parents=true,
 * include_self=false — the term itself is already the sibling value column):
 * getParentsRecursive walk order (nearest parent first, root last), each
 * ancestor resolved through the thesaurus term resolver, empties dropped.
 * Null when the target has no hierarchy (no component_relation_parent / no
 * parents) — the caller emits NOTHING, not an empty column (PHP rule).
 */
async function resolveParentsChain(
	run: ExportRun,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
): Promise<string | null> {
	const cacheKey = `${sectionTipo}:${sectionId}:${lang}`;
	const cached = getBoundedRunMemo(run.parentsChains, cacheKey);
	if (cached !== undefined) return cached;

	const { ancestors, errors } = await getParentsRecursive(sectionId, sectionTipo);
	for (const error of errors) {
		// Data-level loop in the hierarchy: PHP logs-and-continues (best-effort
		// by oracle contract) — the reachable ancestors still export.
		console.warn(
			`[diffusion/export] parents walk ${error.msg} at ${error.info.section_tipo}:${error.info.section_id} (target ${cacheKey})`,
		);
	}
	const parts: string[] = [];
	for (const ancestor of ancestors) {
		// THE FRONTIER (T0-1): an ancestor is another record. Thesaurus tables
		// are globally visible (the record key exempts them); a tree on a
		// project-gated table is not.
		// STRICT (D4): the parents chain is beyond any column's display.
		await exportCrossRecord(run.atoms, ancestor.section_tipo, ancestor.section_id, 'strict');
		const term = await getTermByLocator(ancestor, lang, true);
		if (term !== null && term !== '') parts.push(term);
	}
	const chain = parts.length > 0 ? parts.join(PARENTS_SEPARATOR) : null;
	setBoundedRunMemo(run.parentsChains, cacheKey, chain, run.atoms.cacheLimit);
	return chain;
}

/** The sub_id of the WC-049 parents column (grid_value atoms + the value-format
 * sibling column): column key ends `#parents`, label leaf is the verbatim word. */
export const PARENTS_SUB_ID = 'parents';

/** The sub_id of the T0-9 D4 calculated-relations column (grid_value segment +
 * the value-format sibling column): column key ends `#references`, label leaf
 * is the verbatim word. */
export const REFERENCES_SUB_ID = 'references';

/**
 * Does this export field grow a `#references` column (any non-raw format)?
 * The per-ddo flag is set, no declared dataframe step, AND the declared leaf
 * component derives calculated relations (component_relation_related with
 * dd467 / dd621 — locator_source.ts componentHasCalculatedLocators; pure
 * ontology, so the column set is the same for every record of a run).
 */
export async function fieldHasValueReferences(field: FieldPlan): Promise<boolean> {
	if (field.exportColumn?.valueWithReferences !== true || hasDeclaredDataframeStep(field)) {
		return false;
	}
	const leaf = field.sourceChain[field.sourceChain.length - 1] as
		| { tipo?: string; model?: string }
		| undefined;
	if (leaf?.tipo === undefined || leaf.tipo === '' || typeof leaf.model !== 'string') return false;
	return componentHasCalculatedLocators(leaf.tipo, leaf.model);
}

/**
 * Does this export field grow a WC-049 parents column in the VALUE format?
 * The per-ddo flag is set AND the declared leaf is a stored relation (the only
 * leaves whose targets carry an ancestor chain — the same `isStoredRelationModel`
 * test the grid_value walk applies before it emits a '#parents' atom). A
 * declared dataframe step yields no cell at all (resolveValueCell refuses it).
 */
export function fieldHasValueParents(field: FieldPlan, leafModel: string): boolean {
	return (
		field.exportColumn?.valueWithParents === true &&
		isStoredRelationModel(leafModel) &&
		!hasDeclaredDataframeStep(field)
	);
}

/** One PHP-shaped export path segment (wire shape of the col line's path). */
export interface ExportSegment {
	section_tipo: string;
	component_tipo: string;
	model: string | null;
	/** RAW stored-locator position that reached this segment's owner record;
	 * null when the owner is the exported row itself (no hop). */
	item_index: number | null;
	/** The owner address carried by that RAW stored locator — union kept
	 * because it is stored-jsonb passthrough: an unswept install still holds the
	 * PHP string form, and an external-service hop carries a remote id verbatim
	 * ('001338683'). WC-2026-08-10-section-id-int-canonical. */
	section_id: number | string | null;
	/** Virtual sub-column discriminator (PHP component_info/inverse, parents). */
	sub_id?: string;
	/**
	 * The JOIN separators PHP resolves for this segment (export_path_segment
	 * fields_separator / records_separator): caller ddo → own request_config
	 * show (relations) → properties; ABSENT when none is declared (the join's
	 * defaults apply). Read by join_atoms.ts only: they are NOT part of the
	 * segment identity, and grid.ts strips them from the protocol `path`
	 * (wireSegment) — the col line bytes never carry them.
	 */
	fields_separator?: string | null;
	records_separator?: string | null;
}

/** PHP export_path_segment::get_identity_key (sub_id joined with '#'). */
export function segmentIdentityKey(segment: ExportSegment): string {
	const base = `${segment.section_tipo}_${segment.component_tipo}`;
	return segment.sub_id !== undefined ? `${base}#${segment.sub_id}` : base;
}

/** A segment as the protocol carries it: the join separators stripped. */
export function wireSegment(segment: ExportSegment): ExportSegment {
	if (!('fields_separator' in segment) && !('records_separator' in segment)) return segment;
	const { fields_separator: _fields, records_separator: _records, ...wire } = segment;
	return wire;
}

/** One grid_value export atom: a placed value with its full segment path. */
export interface GridAtom {
	value: string;
	cellType: string;
	/** The leaf component's model (PHP column model = leaf segment model). */
	model: string;
	segments: ExportSegment[];
	/**
	 * The media components this atom's value was READ from (a literal media
	 * leaf: its owner record; a compact portal: the target's media children at
	 * any depth; a fan-out media child: the locator target) — only on a
	 * capturing run (ExportRun.captureMedia), only when non-empty.
	 */
	media?: MediaReadAddress[];
}

/** PHP export atom cell_type by leaf model (export_atom defaults). */
export function cellTypeOfModel(model: string | null): string {
	switch (model) {
		case 'component_image':
			return 'img';
		case 'component_av':
		case 'component_3d':
			return 'av';
		case 'component_iri':
			return 'iri';
		case 'component_section_id':
			return 'section_id';
		default:
			return 'text';
	}
}

/** One raw declared path step (verbatim client shape). */
type RawPathStep = Record<string, unknown>;

/**
 * The segment separators of one component reached through `ddo` (PHP
 * get_export_value / build_export_path_segment precedence): the ddo's own
 * fields_separator / records_separator, then what the component declares
 * (relations: own request_config show, then properties; others: properties).
 * Only declared keys are set.
 */
async function segmentSeparators(
	componentTipo: string,
	model: string | null,
	ddo: Record<string, unknown> | null,
): Promise<Pick<ExportSegment, 'fields_separator' | 'records_separator'>> {
	const declared = await componentSeparators(
		componentTipo,
		typeof model === 'string' && getColumnNameByModel(model) === 'relation',
	);
	const fields = typeof ddo?.fields_separator === 'string' ? ddo.fields_separator : declared.fields;
	const records =
		typeof ddo?.records_separator === 'string' ? ddo.records_separator : declared.records;
	return {
		...(fields === null ? {} : { fields_separator: fields }),
		...(records === null ? {} : { records_separator: records }),
	};
}

/**
 * The relation component's OWN config child ddos (PHP get_export_value
 * `$this->request_config ?? build_request_config()` — the component's own
 * map, NO section_list substitution): THE core seam
 * relations/config_children.ts exportConfigChildren (explicit map verbatim;
 * a config-less relation_index per LOCATOR section; else the edit form's
 * implicit derivation, its children tagged isImplicitConfigChild — an implicit
 * child answers to the caller's grant (D1), an explicit one is read at the
 * subdatum floor (D3)). Run-memoized (bounded) on top of the ontology cache.
 */
async function ownChildrenOf(
	run: ExportRun,
	componentTipo: string,
	locatorSectionTipo?: string,
): Promise<RawConfigDdo[]> {
	const memoKey =
		locatorSectionTipo === undefined ? componentTipo : `${componentTipo}|${locatorSectionTipo}`;
	const cached = getBoundedRunMemo(run.ownChildren, memoKey);
	if (cached !== undefined) return cached;
	const children = [...(await exportConfigChildren(componentTipo, locatorSectionTipo))];
	setBoundedRunMemo(run.ownChildren, memoKey, children, run.atoms.cacheLimit);
	return children;
}

/** Whether a field's DECLARED chain contains a component_dataframe step —
 * a shape the tool UI cannot produce (frames belong to the SOURCE record;
 * the drill-down lists the TARGET's elements) that would mis-walk silently.
 * Consumers push 'component_dataframe:declared-path' and emit nothing. */
function hasDeclaredDataframeStep(field: FieldPlan): boolean {
	return field.sourceChain.some(
		(step) => (step as { model?: string }).model === 'component_dataframe',
	);
}

/**
 * Direct children of `parentTipo` in a ddo_map — THE shared predicate
 * (config_children.ts isDirectConfigChild, T0-9 D11): 'self' aliases the
 * owner, a parent-less entry is no child (PHP `$ddo->parent === $tipo`).
 */
function directChildrenOf(
	map: RawConfigDdo[],
	parentTipo: string,
	mapOwnerTipo: string,
): RawConfigDdo[] {
	return map.filter(
		(ddo) => typeof ddo?.tipo === 'string' && isDirectConfigChild(ddo, parentTipo, mapOwnerTipo),
	);
}

/**
 * How one call walks a field (the SAME walk in every mode — only what it
 * resolves, emits and asks differs):
 *   parents   — WC-049 '#parents' atoms: 'all' inherits down every fan-out
 *               level (grid_value), 'top' only at the declared leaf's own
 *               fan-out (the value mirror), 'none' never;
 *   compact   — WC-008: a single-step stored component_portal yields ONE atom
 *               per reference (grid_value only);
 *   strict    — every crossing takes the full frontier law (the dedalo_raw
 *               media walk: files leave the system — never the display, D4);
 *   mediaOnly — resolve only media leaves (the dedalo_raw media walk: the
 *               SAME records and components, no display text built);
 *   references — T0-9 D4: the declared leaf related's CALCULATED locators fan
 *               out too, under a `sub_id:'references'` segment.
 *   callerIndex — WC-2026-11-11-export-inverse-callers: a component_inverse
 *               caller-pair sub-segment carries the caller's position as
 *               item_index, so breakdown spreads callers (grid_value only). The
 *               value fold keeps it null: an index there would zip UNRELATED
 *               callers of different pairs into one record by position.
 */
interface WalkMode {
	parents: 'all' | 'top' | 'none';
	references: boolean;
	compact: boolean;
	strict: boolean;
	mediaOnly: boolean;
	callerIndex: boolean;
}

/** One walk's shared state (one field on one record). */
interface WalkContext {
	run: ExportRun;
	mode: WalkMode;
	lang: string;
	unresolved: string[];
	atoms: GridAtom[];
	/** The cell options of this walk (the run's, or a strict twin). */
	cellOpts: CellValueResolveOptions;
	/** The relation expansions on the CURRENT recursion path — a data cycle
	 * (A → B → A through the same component) stops instead of spinning. */
	trail: Set<string>;
}

/**
 * The value-format cell of one export field on one record — PHP
 * export_value::join over the field's atoms (join_atoms.ts).
 */
export async function resolveValueCell(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	unresolved: string[],
): Promise<string | null> {
	return (
		await inRunLangs(run, lang, () =>
			resolveValueCellInScope(run, field, sectionTipo, sectionId, lang, unresolved, false, false),
		)
	).flat;
}

/**
 * `resolveValueCell` plus the media components the cell was read from — the
 * value-format capture (row_media.ts): every media read of the cell's walk, in
 * read order. The flat string is the SAME bytes (the capture only observes the
 * reads); `media` is empty when the run does not capture.
 */
export async function resolveValueCellWithMedia(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	unresolved: string[],
	/** Also build the WC-049 parents cell ({@link fieldHasValueParents}). */
	withParents = false,
	/** Also build the D4 `#references` cell ({@link fieldHasValueReferences}). */
	withReferences = false,
): Promise<ValueCells & { media: MediaReadAddress[]; referencesMedia: MediaReadAddress[] }> {
	const sink: MediaReadAddress[] = [];
	const referencesSink: MediaReadAddress[] = [];
	const scoped: ExportRun =
		run.captureMedia === true
			? {
					...run,
					mediaSink: sink,
					...(withReferences ? { referencesMediaSink: referencesSink } : {}),
				}
			: run;
	const cells = await inRunLangs(scoped, lang, () =>
		resolveValueCellInScope(
			scoped,
			field,
			sectionTipo,
			sectionId,
			lang,
			unresolved,
			withParents,
			withReferences,
		),
	);
	return { ...cells, media: sink, referencesMedia: referencesSink };
}

/**
 * One value-format field's cells on one record: the term cell (`flat`), only
 * when asked its WC-049 parents cell, and the column LABEL chain.
 *
 * THE PARENTS CELL MIRRORS THE TERM CELL (review 2026-09-25): it is the SAME
 * fold (join_atoms.ts joinExportAtomsMirrored) — same separators at the same
 * levels, a record the term has no atoms for has no slot in either. At the
 * declared leaf's fan-out level every target contributes its ancestor chain
 * ONCE PER PIECE its term text splits into on that level's record glue, so a
 * target whose text holds that separator still lines up, and a target with no
 * chain contributes '' slots. `parents` is null when no piece has a chain (or
 * the term cell is empty).
 */
export interface ValueCells {
	flat: string | null;
	parents: string | null;
	/** T0-9 D4: the calculated-relations cell — the SAME join as `flat` over
	 * the `#references` atoms (their references segment stripped, so they fold
	 * exactly like main-cell atoms); null when not asked or nothing calculated. */
	references?: string | null;
	/** PHP export_tabulator :295-302 — the column header chain is atoms[0]'s
	 * path when the leaf fans out (the declared chain otherwise): the first term
	 * atom of the cell's own walk (a WC-008 compact column: its one segment). */
	labelSegments?: ExportSegment[];
}

/**
 * Run one cell resolution under the run's EXPLICIT languages when it carries
 * them ({@link ExportRun.applicationLang}), else in the ambient scope.
 */
function inRunLangs<T>(run: ExportRun, lang: string, work: () => Promise<T>): Promise<T> {
	if (run.applicationLang === undefined) return work();
	return runWithRequestLangs({ applicationLang: run.applicationLang, dataLang: lang }, work);
}

/**
 * Record a non-fatal note ONCE. `unresolved` is a set of DISTINCT notes, never a
 * per-record log: the notes are raised per record × field, and a walk of 300k
 * records would otherwise hold (and persist into the export manifest and the
 * lane job's result) one string per record.
 */
function noteUnresolved(unresolved: string[], note: string): void {
	if (!unresolved.includes(note)) unresolved.push(note);
}

async function resolveValueCellInScope(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	unresolved: string[],
	withParents: boolean,
	withReferences: boolean,
): Promise<ValueCells> {
	const walked = await walkFieldAtoms(run, field, sectionTipo, sectionId, lang, unresolved, {
		parents: withParents ? 'top' : 'none',
		references: withReferences,
		compact: false,
		strict: false,
		mediaOnly: false,
		callerIndex: false,
	});
	const atoms = walked.filter((atom) => !isReferencesAtom(atom));
	const referencesCell = withReferences
		? joinExportAtoms(walked.filter(isReferencesAtom).map(stripReferencesSegment))
		: '';
	const references = withReferences && referencesCell !== '' ? referencesCell : null;
	const termAtoms = atoms.filter((atom) => !isParentsAtom(atom));
	if (termAtoms.length === 0) return { flat: null, parents: null, references };
	const path = field.exportColumn?.path ?? [];
	// The declared leaf relation's fan-out level sits right after the declared
	// chain: its parents segment is at index path.length.
	const folded = withParents
		? joinExportAtomsMirrored(termAtoms, atoms.filter(isParentsAtom), path.length)
		: { text: joinExportAtoms(termAtoms), mirror: '', hasChain: false };
	const flat = folded.text === '' ? null : folded.text;
	return {
		flat,
		parents: withParents && flat !== null && folded.hasChain ? folded.mirror : null,
		references,
		labelSegments: (await compactApplies(field))
			? [compactLabelSegment(termAtoms[0] as GridAtom, path.length)]
			: (termAtoms[0] as GridAtom).segments,
	};
}

/** Is this atom a D4 calculated-relations atom (under a '#references' segment)? */
function isReferencesAtom(atom: GridAtom): boolean {
	return atom.segments.some(
		(segment, index) => segment.sub_id === REFERENCES_SUB_ID && !isInfoOutputSegment(atom, index),
	);
}

/** A '#references' atom shaped as the main cell's (its references segment
 * dropped): the value fold then joins it with the main cell's own separators.
 * A component_info OUTPUT whose id is 'references' is NOT that segment — it
 * stays, or a multi-valued output would fold as the info segment's leaf and the
 * `#references` text would differ from the same record's main cell. Exported
 * for its outcome gate (tool_export_info_native: references fold == main fold). */
export function stripReferencesSegment(atom: GridAtom): GridAtom {
	return {
		...atom,
		segments: atom.segments.filter(
			(segment, index) => segment.sub_id !== REFERENCES_SUB_ID || isInfoOutputSegment(atom, index),
		),
	};
}

/** Is this atom a WC-049 parents atom (its last segment the '#parents' sub-column)? */
function isParentsAtom(atom: GridAtom): boolean {
	const last = atom.segments.length - 1;
	return atom.segments[last]?.sub_id === PARENTS_SUB_ID && !isInfoOutputSegment(atom, last);
}

/** The ONE segment a WC-008 compact column's atoms carry (its label chain). */
function compactLabelSegment(atom: GridAtom, declaredLength: number): ExportSegment {
	const root = atom.segments[declaredLength - 1] as ExportSegment;
	const reference = atom.segments[declaredLength];
	return {
		...root,
		item_index: reference?.item_index ?? null,
		section_id: reference?.section_id ?? null,
	};
}

/**
 * COMPACT portal cells (WC-008, user-approved 2026-07-08): a SINGLE-step ddo
 * whose leaf is a REAL portal (stored ontology model component_portal — the
 * runtime alias also covers autocompletes, which keep PHP parity) does NOT fan
 * out into columns: each referenced record lands in ONE cell.
 */
async function compactApplies(field: FieldPlan): Promise<boolean> {
	const path = field.exportColumn?.path ?? [];
	if (path.length !== 1) return false;
	const tipo = String((path[0] as RawPathStep | undefined)?.component_tipo ?? '');
	return tipo !== '' && (await getNode(tipo))?.model === 'component_portal';
}

/**
 * grid_value atoms of one export field on one record (PHP get_record_atoms →
 * get_export_value recursion): literal leaves yield one atom whose segments
 * mirror the declared chain (item_index = the hop position that reached each
 * owner); relation leaves FAN OUT into their children per stored locator,
 * appending one segment per fan-out hop; a single-step real portal yields one
 * COMPACT atom per reference (WC-008).
 */
export function collectGridAtoms(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	unresolved: string[],
	/** Override the field's value_with_parents flag. */
	withParentsOverride?: boolean,
	/** Receives the media of values the walk DROPS for being empty (capturing
	 * runs only — see ExportRun.droppedMedia). */
	droppedMedia?: MediaReadAddress[],
): Promise<GridAtom[]> {
	const scoped: ExportRun = droppedMedia === undefined ? run : { ...run, droppedMedia };
	const withParents = withParentsOverride ?? field.exportColumn?.valueWithParents === true;
	return inRunLangs(run, lang, () =>
		walkFieldAtoms(scoped, field, sectionTipo, sectionId, lang, unresolved, {
			parents: withParents ? 'all' : 'none',
			references: field.exportColumn?.valueWithReferences === true,
			compact: true,
			strict: false,
			mediaOnly: false,
			callerIndex: true,
		}),
	);
}

/**
 * The atoms the VALUE fold reads for one field on one record: the same walk as
 * {@link collectGridAtoms} WITHOUT the WC-008 compaction (a single-step real
 * portal fans out into its children — PHP's own grid atoms) and without the
 * parents sub-column. The value cell is exactly joinExportAtoms of these; a
 * gate's join oracle reads them (a compact cell's one pre-joined atom per
 * reference is a deliberate grid_value divergence, not the PHP atom shape).
 */
export function collectValueAtoms(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	unresolved: string[],
): Promise<GridAtom[]> {
	return inRunLangs(run, lang, () =>
		walkFieldAtoms(run, field, sectionTipo, sectionId, lang, unresolved, {
			parents: 'none',
			references: false,
			compact: false,
			strict: false,
			mediaOnly: false,
			callerIndex: false,
		}),
	);
}

/** THE walk of one export field on one record (see {@link WalkMode}). */
async function walkFieldAtoms(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	unresolved: string[],
	mode: WalkMode,
): Promise<GridAtom[]> {
	if (hasDeclaredDataframeStep(field)) {
		// A DECLARED path step of model component_dataframe is not producible
		// from the tool UI (frames belong to the SOURCE record, the drill-down
		// lists the target's elements) and would mis-walk silently — loud instead.
		noteUnresolved(unresolved, 'component_dataframe:declared-path');
		return [];
	}
	const path = field.exportColumn?.path ?? [];
	if (path.length === 0) return [];
	const ctx: WalkContext = {
		run,
		mode,
		lang,
		unresolved,
		atoms: [],
		cellOpts: mode.strict ? strictCellOpts(run) : run.cellOpts,
		trail: new Set(),
	};
	const events = await resolveRecordAtoms(run.atoms, field, sectionTipo, sectionId);
	const compact = mode.compact && (await compactApplies(field));

	// The declared chain's segment separators are ontology + the declared step
	// (PHP: the path[0] ddo is the root's context ddo; later hops are rebuilt
	// ddos without separators) — resolved once per call, not per event.
	const declaredSeparators: Pick<ExportSegment, 'fields_separator' | 'records_separator'>[] = [];
	const declaredModels: (string | null)[] = [];
	for (let position = 0; position < path.length; position++) {
		const rawStep = path[position] as RawPathStep | undefined;
		const componentTipo = String(rawStep?.component_tipo ?? '');
		const model = (await getModelByTipo(componentTipo)) ?? String(rawStep?.model ?? '');
		declaredModels.push(model);
		declaredSeparators.push(
			await segmentSeparators(componentTipo, model, position === 0 ? (rawStep ?? null) : null),
		);
	}

	for (const event of events) {
		// Segments of the DECLARED chain: runtime owner per position, the raw
		// locator position that reached it as item_index (null at the root).
		const segments: ExportSegment[] = [];
		for (let position = 0; position < path.length; position++) {
			const rawStep = path[position] as RawPathStep | undefined;
			const owner = event.hopOwners[position];
			segments.push({
				section_tipo: owner?.sectionTipo ?? String(rawStep?.section_tipo ?? sectionTipo),
				component_tipo: String(rawStep?.component_tipo ?? ''),
				model: declaredModels[position] ?? null,
				item_index: position === 0 ? null : (event.indexVector[position - 1] ?? null),
				section_id: position === 0 ? null : (owner?.sectionId ?? null),
				...declaredSeparators[position],
			});
		}

		if (event.locators !== undefined && isStoredRelationModel(event.step.model)) {
			const locators: FanOutLocator[] = event.locators;
			if (compact) {
				await emitCompactCells(
					ctx,
					event.step,
					event.ownerSectionTipo,
					event.ownerSectionId,
					locators,
					segments,
				);
				continue;
			}
			// Relation leaf: fan out into its children per locator target (PHP
			// get_export_value foreach data → ddo children). The OWNER is the
			// record holding the leaf's data (dataframe slots live there).
			ctx.trail.add(trailKey(event.ownerSectionTipo, event.ownerSectionId, event.step.tipo));
			await fanOutRelation(
				ctx,
				event.step.tipo,
				event.ownerSectionTipo,
				event.ownerSectionId,
				locators,
				segments,
				0,
			);
			ctx.trail.clear();
			if (
				ctx.mode.references &&
				(await componentHasCalculatedLocators(event.step.tipo, event.step.model))
			) {
				await emitReferencesAtoms(ctx, event, segments);
			}
			continue;
		}

		// Literal leaf: the component's flat value at the owner record.
		await emitPlainAtom(
			ctx,
			event.ownerSectionTipo,
			event.ownerSectionId,
			event.step.tipo,
			event.step.model,
			segments,
		);
	}

	return ctx.atoms;
}

/**
 * T0-9 D4 — the declared leaf related's CALCULATED relations as a sibling
 * column: the owner record's calculated locators (locator_source.ts — closure
 * minus stored, positions = the calculated list's), fanned out by THE SAME
 * fanOutRelation (config children, separators, the T0-1 crossing of every
 * target) under the declared chain + a `sub_id:'references'` segment on the
 * leaf (unindexed: its rows ride the children's own item axis). No parents and
 * no nested references below it — the flag names its own column.
 */
async function emitReferencesAtoms(
	ctx: WalkContext,
	event: {
		step: { tipo: string; model: string };
		ownerSectionTipo: string;
		ownerSectionId: number | string;
	},
	segments: ExportSegment[],
): Promise<void> {
	const owner = await loadExportRecord(ctx.run.atoms, event.ownerSectionTipo, event.ownerSectionId);
	if (owner === null) return;
	const calculated = await calculatedLocators(
		{
			sectionTipo: event.ownerSectionTipo,
			sectionId: event.ownerSectionId,
			columns: owner.columns as Record<string, unknown>,
		},
		event.step.tipo,
		event.step.model,
	);
	const locators: FanOutLocator[] = [];
	for (let index = 0; index < calculated.length; index++) {
		const reference = calculated[index];
		if (typeof reference?.section_tipo !== 'string' || reference.section_id === undefined) continue;
		locators.push({
			sectionTipo: reference.section_tipo,
			sectionId: reference.section_id as number | string,
			index,
		});
	}
	if (locators.length === 0) return;
	const leaf = segments[segments.length - 1] as ExportSegment;
	const referencesSegment: ExportSegment = {
		section_tipo: leaf.section_tipo,
		component_tipo: leaf.component_tipo,
		model: null,
		item_index: null,
		section_id: null,
		sub_id: REFERENCES_SUB_ID,
		// the leaf's own separators: the fold below the segment joins as the
		// main cell's fan-out does
		...(leaf.fields_separator !== undefined ? { fields_separator: leaf.fields_separator } : {}),
		...(leaf.records_separator !== undefined ? { records_separator: leaf.records_separator } : {}),
	};
	// The value format credits this walk's media to the `#references` column:
	// its reads land on the run's references sink, not the main cell's.
	const referencesRun: ExportRun =
		ctx.run.referencesMediaSink === undefined
			? ctx.run
			: { ...ctx.run, mediaSink: ctx.run.referencesMediaSink };
	const referencesCtx: WalkContext = {
		...ctx,
		run: referencesRun,
		mode: { ...ctx.mode, parents: 'none', references: false },
		trail: new Set([trailKey(event.ownerSectionTipo, event.ownerSectionId, event.step.tipo)]),
	};
	await fanOutRelation(
		referencesCtx,
		event.step.tipo,
		event.ownerSectionTipo,
		event.ownerSectionId,
		locators,
		[...segments, referencesSegment],
		0,
	);
}

/**
 * The cell options of a STRICT walk: every nested crossing a cell asks takes
 * the full frontier law (never the display carve-out, D4).
 */
function strictCellOpts(run: ExportRun): CellValueResolveOptions {
	const frontier = run.cellOpts.frontier;
	if (frontier === undefined) return run.cellOpts;
	return {
		...run.cellOpts,
		frontier: {
			...frontier,
			crossRecord: (sectionTipo, sectionId) =>
				exportCrossRecord(run.atoms, sectionTipo, sectionId, 'strict'),
		},
	};
}

/** The crossing reach of one walk crossing: strict, or the display carve-out. */
function crossingReach(
	ctx: WalkContext,
	reach: Exclude<ExportCrossingReach, 'strict'>,
): ExportCrossingReach {
	return ctx.mode.strict ? 'strict' : reach;
}

/** The trail key of one relation expansion (data holder × component). */
function trailKey(
	sectionTipo: string,
	sectionId: number | string,
	tipo: string,
	pair = '',
): string {
	return `${sectionTipo}\u0000${sectionId}\u0000${tipo}\u0000${pair}`;
}

/**
 * One plain (non-fan-out) atom: the component's flat value at the record.
 * A media-only walk resolves media leaves only (no display text is built for
 * anything else — it reads no media).
 */
async function emitPlainAtom(
	ctx: WalkContext,
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
	model: string,
	segments: ExportSegment[],
): Promise<void> {
	if (ctx.mode.mediaOnly && !isMediaModel(model) && getFlatValueFamily(model) !== 'datalist') {
		return;
	}
	const family = getFlatValueFamily(model);
	if (family === 'inverse') {
		await emitInverseAtoms(ctx, sectionTipo, sectionId, componentTipo, model, segments);
		return;
	}
	if (family === 'info') {
		await emitInfoAtoms(ctx, sectionTipo, sectionId, componentTipo, model, segments);
		return;
	}
	if (family !== undefined && LITERAL_ITEM_FAMILIES.has(family)) {
		await emitLiteralItemAtoms(ctx, sectionTipo, sectionId, componentTipo, model, segments);
		return;
	}
	const media = isMediaModel(model);
	// D3: a media leaf is ALWAYS one atom (PHP component_media_common :340-372
	// from_scalar($path, $url ?? '')) — the reached component keeps its slot.
	const leafOpts = media ? { ...ctx.cellOpts, keepEmptyItems: true } : ctx.cellOpts;
	const capture = mediaCapture(ctx.run, leafOpts);
	// The target id VERBATIM — an external target's remote id is zero-padded
	// ('000065686'), and Number() asked the service for a different record.
	// resolveCellValue reads a matrix address only for the stored families.
	const value = await resolveCellValue(
		sectionTipo,
		sectionId,
		componentTipo,
		ctx.lang,
		ctx.unresolved,
		RECORDS_SEPARATOR,
		capture?.opts ?? leafOpts,
	);
	if (value === null || value === '') {
		noteDroppedMedia(ctx.run, capture?.media);
		// the empty media atom: a slot, no media credited (the cell shows nothing)
		if (value === '' && media) {
			ctx.atoms.push({ value: '', cellType: cellTypeOfModel(model), model, segments });
		}
		return;
	}
	ctx.atoms.push({
		value,
		cellType: cellTypeOfModel(model),
		model,
		segments,
		...mediaField(capture?.media),
	});
}

/**
 * component_inverse (DERIVED backlinks — "who is calling me"): one atom per
 * backlink locator, its value the CALLER record's id (PHP component_inverse::
 * get_export_value :288 — `(int)from_section_id`, a malformed backlink with no
 * from_section_tipo / from_component_tipo skipped).
 *
 * Segments: the leaf's own + ONE plain caller-pair segment (from_section_tipo,
 * from_component_tipo; no sub_id), so every caller pair is its own column.
 * DELIBERATE DIVERGENCE (WC-2026-11-11-export-inverse-callers, owner decision
 * 2026-11-11): the pair segment carries the caller's running position WITHIN
 * its pair (0-based, in the backlink order = section_id ASC) as item_index —
 * PHP set none, so its breakdown never spread callers. Here 'default'/'rows'
 * put one caller per row, 'columns' one per '|n' column, and the value fold
 * joins the ids per the indexed-level rule (join_atoms.ts).
 *
 * The walk reads NO target record: the caller ids come from the host's own
 * backlink list, scoped for the run's principal (the frontier's — explicit,
 * because an export job may run detached from the request ALS; a run with no
 * frontier is a global admin or internal walk → unscoped). Unreadable owners
 * are dropped (scopeInverseReferenceHits — the edit view's policy), so no
 * crossing is asked. What the atoms DISCLOSE (a caller section's ids, and in
 * grid_value its name) is recorded as that section's read grant
 * ({@link recordInverseCallerGrants}), so a later read of the finished export
 * re-asks it.
 */
async function emitInverseAtoms(
	ctx: WalkContext,
	sectionTipo: string,
	sectionId: number | string,
	_componentTipo: string,
	model: string,
	segments: ExportSegment[],
): Promise<void> {
	const address = canonicalizeStoredSectionId(sectionId);
	if (!isSectionId(address)) return;
	const entries = await resolveInverseEntries(sectionTipo, address, {
		principal: ctx.run.atoms.frontier?.principal,
	});
	const pairIndex = new Map<string, number>();
	const disclosed: string[] = [];
	for (const entry of entries) {
		const fromSectionTipo = entry.from_section_tipo;
		const fromComponentTipo = entry.from_component_tipo;
		if (typeof fromSectionTipo !== 'string' || fromSectionTipo === '') continue;
		if (typeof fromComponentTipo !== 'string' || fromComponentTipo === '') continue;
		const pairKey = `${fromSectionTipo}_${fromComponentTipo}`;
		const index = pairIndex.get(pairKey) ?? 0;
		pairIndex.set(pairKey, index + 1);
		disclosed.push(fromSectionTipo);
		ctx.atoms.push({
			value: String(entry.from_section_id),
			cellType: cellTypeOfModel(model),
			model,
			segments: [
				...segments,
				{
					section_tipo: fromSectionTipo,
					component_tipo: fromComponentTipo,
					model: null,
					item_index: ctx.mode.callerIndex ? index : null,
					section_id: null,
				},
			],
		});
	}
	recordInverseCallerGrants(ctx.run.atoms, disclosed);
}

/**
 * component_info (DERIVED widget outputs —
 * WC-2026-11-12-info-live-publication-export): ONE atom per value of every DECLARED widget output, in
 * declaration order, under a sub-segment `{section_tipo: host, component_tipo:
 * info, sub_id: <output id>}` (PHP component_info::get_export_value :778-823),
 * so grid_value gives each output its own column and the value format joins
 * them. The values are the LIVE parsed compute (get_data_parsed), never the
 * stored `misc` slot (WC-2026-09-03). An output with no value keeps ONE ''
 * slot atom (PHP's null atom: the column set does not depend on the record).
 * Every matching item is kept (PHP's array_find kept the first) and an
 * output only matches its own widget's items.
 *
 * Identity: the run's frontier principal (explicit — an export job may run
 * detached from the request ALS), else the ambient one; mode 'edit' (PHP
 * tool_export instances its columns in edit mode).
 */
async function emitInfoAtoms(
	ctx: WalkContext,
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
	model: string,
	segments: ExportSegment[],
): Promise<void> {
	const address = canonicalizeStoredSectionId(sectionId);
	if (!isSectionId(address)) return;
	const principal = ctx.run.atoms.frontier?.principal ?? currentPrincipal();
	const outputs = await computeInfoOutputs(componentTipo, {
		sectionTipo,
		sectionId: address,
		mode: 'edit',
		lang: ctx.lang,
		userId: principal?.userId,
		isAdmin: principal?.isGlobalAdmin,
	});
	for (const output of outputs ?? []) {
		const outputSegments: ExportSegment[] = [
			...segments,
			{
				section_tipo: sectionTipo,
				component_tipo: componentTipo,
				model: null,
				item_index: null,
				section_id: null,
				sub_id: output.outputId,
			},
		];
		const values = output.values.length > 0 ? output.values : [null];
		for (const value of values) {
			ctx.atoms.push({
				value: infoOutputValueString(value),
				cellType: cellTypeOfModel(model),
				model,
				segments: outputSegments,
			});
		}
	}
}

/**
 * Is segment `index` of `atom` a component_info OUTPUT sub-segment? Its
 * `sub_id` is an ontology output id, so it may spell a reserved sub-column
 * ('parents', 'references') without being one.
 */
function isInfoOutputSegment(atom: GridAtom, index: number): boolean {
	return index === atom.segments.length - 1 && getFlatValueFamily(atom.model) === 'info';
}

/**
 * THE RE-CHECK RECORD of an inverse disclosure (component_inverse export —
 * atoms above, dedalo_raw in grid.ts computedRawSlice). The build admitted each
 * caller on LEG 1 of scopeInverseReferenceHits — the SECTION read grant
 * (getPermissions(principal, section, section) >= 1) — plus the projects
 * boundary (LEG 2, already re-asked through the manifest's record-scope
 * fingerprint). LEG 1 is recorded here, once per DISTINCT caller section that
 * reached the file, in the run's runtime grant set (ExportAtomRun.frontierGrants
 * → manifest `frontier_grants`) as the pair (section, section): the re-check
 * (access.ts runtimeFrontierGrantsHeld → frontierComponentAllowed →
 * ddoIsAuthorized(principal, section, section)) asks exactly the build's
 * question. A grant revoked on a caller section after the build closes the
 * export, as a revoked runtime component grant does.
 *
 * Only what the build ASKED is recorded: the caller COMPONENT (whose term a
 * grid_value header names) was never asked — the edit view's policy is the
 * section grant — so recording it would lock an owner out of an export the
 * build lawfully produced. Scoped runs only (a run with no frontier principal
 * is a global admin / internal walk: nothing to re-ask).
 */
export function recordInverseCallerGrants(
	run: ExportAtomRun,
	callerSectionTipos: Iterable<unknown>,
): void {
	if (run.frontier?.principal === undefined) return;
	for (const sectionTipo of callerSectionTipos) {
		if (typeof sectionTipo !== 'string' || sectionTipo === '') continue;
		const key = `${sectionTipo}\u0000${sectionTipo}`;
		if (!run.frontierGrants.has(key)) {
			run.frontierGrants.set(key, { section_tipo: sectionTipo, component_tipo: sectionTipo });
		}
	}
}

/**
 * The literal flat families whose items become ONE ATOM EACH (PHP
 * component_common::get_export_value :1901-1928 and every literal override —
 * input_text :58, text_area :195, date :266, iri :350, section_id :162 — add
 * one atom per data item). Media keeps its single URL atom (PHP
 * component_media_common :340 export_value::from_scalar), relations fan out.
 */
const LITERAL_ITEM_FAMILIES: ReadonlySet<string> = new Set(['string', 'date', 'iri', 'section_id']);

/**
 * Models whose LEAF segment glues its items with the RECORDS separator (PHP
 * component_input_text :58-74, component_date :266-282, component_iri
 * :350-370: `fields_separator => ddo.records_separator ?? properties
 * .records_separator ?? ' | '` — the legacy get_grid_value pre-join). Every
 * other literal keeps build_export_path_segment's fields_separator (ddo ??
 * properties ?? null → join_atoms' ', ').
 */
const RECORDS_GLUED_LEAF_MODELS: ReadonlySet<string> = new Set([
	'component_input_text',
	'component_date',
	'component_iri',
]);

/**
 * A literal leaf as PHP emits it: one atom per resolved item on the SAME
 * segments, so the value fold joins them with the leaf segment's separator
 * (join_atoms.ts) and a grid_value cell receives every item of its column ×
 * row (bucket glue unchanged).
 */
async function emitLiteralItemAtoms(
	ctx: WalkContext,
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
	model: string,
	segments: ExportSegment[],
): Promise<void> {
	const leaf = segments[segments.length - 1] as ExportSegment;
	// component_iri glues each item's value + title with the leaf's
	// fields_separator (caller ddo → properties, segmentSeparators; PHP
	// component_iri :354-358) — the reader falls back to properties → ', '.
	// D3: every stored item is an atom, an EMPTY one included (PHP
	// component_input_text :96-107, component_date :296-303) — so the records
	// join keeps its slot; join_atoms skips '' at the leaf. Not for the iri: its
	// title crosses into a frame record whose own reader must keep the default.
	const cellOpts: CellValueResolveOptions =
		model === 'component_iri'
			? typeof leaf.fields_separator === 'string'
				? { ...ctx.cellOpts, iriFieldsSeparator: leaf.fields_separator }
				: ctx.cellOpts
			: { ...ctx.cellOpts, keepEmptyItems: true };
	const items = await resolveCellItems(
		sectionTipo,
		sectionId,
		componentTipo,
		ctx.lang,
		ctx.unresolved,
		RECORDS_SEPARATOR,
		cellOpts,
	);
	if (items === null) return;
	const leafSegments = RECORDS_GLUED_LEAF_MODELS.has(model)
		? [
				...segments.slice(0, -1),
				{ ...leaf, fields_separator: leaf.records_separator ?? RECORDS_SEPARATOR },
			]
		: segments;
	const cellType = cellTypeOfModel(model);
	for (const value of items) {
		ctx.atoms.push({ value, cellType, model, segments: leafSegments });
	}
}

/**
 * WC-008 compact cells: per stored reference, ONE atom whose value is the join
 * of that reference's OWN fan-out atoms (join_atoms.ts — the caller map, the
 * separators, PHP empty(), all of it the value fold's) and whose single
 * segment is the leaf's, indexed by the reference. A reference with no atoms
 * has no cell; one whose atoms join to '' keeps an EMPTY cell (D3 slot). The
 * media read under a reference rides its atom (dropped media when its cell is
 * empty); the WC-049 parents chain is a sibling '#parents' atom per reference.
 */
async function emitCompactCells(
	ctx: WalkContext,
	step: { tipo: string; model: string },
	ownerSectionTipo: string,
	ownerSectionId: number | string,
	locators: FanOutLocator[],
	segments: ExportSegment[],
): Promise<void> {
	const leafSegment = segments[0] as ExportSegment;
	for (const locator of locators) {
		const referenceAtoms: GridAtom[] = [];
		const referenceMedia: MediaReadAddress[] = [];
		const capturing = ctx.run.captureMedia === true || ctx.run.mediaSink !== undefined;
		const scopedRun: ExportRun = capturing ? { ...ctx.run, droppedMedia: referenceMedia } : ctx.run;
		const referenceCtx: WalkContext = {
			...ctx,
			run: scopedRun,
			mode: { ...ctx.mode, parents: 'none' },
			atoms: referenceAtoms,
			trail: new Set([trailKey(ownerSectionTipo, ownerSectionId, step.tipo)]),
		};
		await fanOutRelation(
			referenceCtx,
			step.tipo,
			ownerSectionTipo,
			ownerSectionId,
			[locator],
			segments,
			0,
		);
		const reference: ExportSegment = {
			...wireSegment(leafSegment),
			item_index: locator.index,
			section_id: locator.sectionId,
		};
		if (referenceAtoms.length > 0) {
			for (const atom of referenceAtoms) {
				for (const read of atom.media ?? []) addMediaReadAddress(referenceMedia, read);
			}
			const value = joinExportAtoms(referenceAtoms);
			if (value === '') noteDroppedMedia(ctx.run, referenceMedia);
			ctx.atoms.push({
				value,
				cellType: 'text',
				model: step.model,
				segments: [reference],
				...(value === '' ? {} : mediaField(capturing ? referenceMedia : undefined)),
			});
		} else {
			noteDroppedMedia(ctx.run, referenceMedia);
		}
		// WC-049 parents: sibling '#parents' atom per reference. The indexed
		// FIRST segment keeps the chain row-aligned with the compact value atom;
		// the parents segment itself is unindexed.
		if (ctx.mode.parents !== 'none') {
			const chain = await resolveParentsChain(
				ctx.run,
				locator.sectionTipo,
				locator.sectionId,
				ctx.lang,
			);
			if (chain !== null) {
				ctx.atoms.push({
					value: chain,
					cellType: 'text',
					model: step.model,
					segments: [
						reference,
						{
							section_tipo: locator.sectionTipo,
							component_tipo: step.tipo,
							model: null,
							item_index: null,
							section_id: null,
							sub_id: PARENTS_SUB_ID,
						},
					],
				});
			}
		}
	}
}

/**
 * Whether a model's value is a STORED locator bag the walk can fan out through.
 * component_external sits on the relation column for column-map parity only
 * (its descriptor calls the column INERT): its value is DERIVED from the remote
 * record, so it is a plain leaf — fanning it out read a bag no record holds and
 * emitted nothing, which blanked every grid_value Zenon column (rsc368 → zenon*).
 */
function isStoredRelationModel(model: string | null | undefined): boolean {
	if (typeof model !== 'string' || model === '') return false;
	return getColumnNameByModel(model) === 'relation' && getFlatValueFamily(model) !== 'external';
}

/** One fan-out locator: target identity + raw slot position + (for dataframe
 * pairing) the STORED locator id and its main_component_tipo. */
interface FanOutLocator {
	sectionTipo: string;
	sectionId: number | string;
	index: number;
	id?: number | string;
	mainComponentTipo?: string;
}

/**
 * PHP component_relation_common::get_export_value recursion: per locator ×
 * child — plain children emit one atom (segment item_index = the locator's RAW
 * position), relation children recurse into THEIR locators (the caller map's
 * declared descendants first, else the child's own config map).
 * `ownerSectionTipo/ownerSectionId` = the record HOLDING the relation's data
 * (where dataframe slots live — PHP $this->section_*). `baseSegments` ends with
 * the relation's OWN segment (its separators already resolved).
 *
 * TERMINATION: no depth ceiling (a long chain of DISTINCT records is walked,
 * PHP-like); a DATA CYCLE — the same component expanded again on the same
 * record along the current path — stops, noted `relation_cycle:<tipo>`.
 */
async function fanOutRelation(
	ctx: WalkContext,
	relationTipo: string,
	ownerSectionTipo: string,
	ownerSectionId: number | string,
	locators: FanOutLocator[],
	baseSegments: ExportSegment[],
	depth: number,
	declaredMap?: RawConfigDdo[],
	/** The tipo whose request_config `declaredMap` came from — 'self' entries
	 * alias THIS tipo, never the current relation (a nested rsc368 must not
	 * adopt the portal map's self children as its own). */
	declaredMapOwner?: string,
): Promise<void> {
	const { run } = ctx;
	// Children: the declared descendants when the caller's map declares them,
	// else the component's OWN config (PHP context->ddo_map ?? own) — for a
	// config-less relation_index, per LOCATOR section (id + the pointing
	// section's relation_list columns — D10, a deliberate divergence from PHP's
	// id-only resolve_export_ddo_children; config_children.ts).
	let staticMap: { map: RawConfigDdo[]; mapOwner: string } | null = null;
	if (
		declaredMap !== undefined &&
		declaredMapOwner !== undefined &&
		directChildrenOf(declaredMap, relationTipo, declaredMapOwner).length > 0
	) {
		staticMap = { map: declaredMap, mapOwner: declaredMapOwner };
	} else if (!(await configChildrenArePerLocator(relationTipo))) {
		staticMap = { map: await ownChildrenOf(run, relationTipo), mapOwner: relationTipo };
	}
	// PHP: empty ddo_direct_children → no atoms
	if (
		staticMap !== null &&
		directChildrenOf(staticMap.map, relationTipo, staticMap.mapOwner).length === 0
	) {
		return;
	}

	// EXISTENCE ONLY (T0-9 D6/D9, the edit form's predicate — config_children.ts
	// pointerIsExistenceOnly): a relation_index pointer in a section the
	// requester may not read exports its ADDRESS (section name + id) and none of
	// its content, whatever map (own or the caller's) would have read it.
	const perTarget = await configChildrenArePerTarget(relationTipo);

	for (const locator of locators) {
		if (perTarget && (await pointerIsExistenceOnly(relationTipo, locator.sectionTipo))) {
			await emitExistenceAtom(ctx, relationTipo, locator, baseSegments);
			continue;
		}
		// per locator: a config-less relation_index (its children are the
		// pointing section's — config_children.ts exportConfigChildren)
		const { map, mapOwner } = staticMap ?? {
			map: await ownChildrenOf(run, relationTipo, locator.sectionTipo),
			mapOwner: relationTipo,
		};
		const children = directChildrenOf(map, relationTipo, mapOwner);
		if (children.length === 0) continue;
		// THE FRONTIER (T0-1 / S02): every locator this loop reads through is a
		// crossing — at depth 0 (already asserted by resolveRecordAtoms: a memo
		// hit), at every nested depth (the recursion re-enters here) and for a
		// dataframe's FRAME targets (the recursion's locators are the frames).
		// The children are decided FIRST, so the crossing can name what it reads
		// there (the display carve-out, D4, admits a record the host read shows
		// only for components the read shows; a dataframe child is read on the
		// OWNER record, so its frames are crossed on the owner below, per entry;
		// its frame targets are crossings of their own). A STRICT walk (the media
		// walk) takes the full law instead.
		const readable = await readableMapChildren(run, children, locator.sectionTipo);
		await exportCrossRecord(
			run.atoms,
			locator.sectionTipo,
			locator.sectionId,
			crossingReach(ctx, { reads: await nonDataframeTipos(readable.map((child) => child.tipo)) }),
		);
		for (const child of readable) {
			const childModel = (await getModelByTipo(child.tipo)) ?? String(child.model ?? '');
			if (childModel === '') continue; // PHP: missing TLD → skip (debug log)

			if (childModel === 'component_dataframe') {
				// PHP relation_common :871-897 + component_dataframe::get_data
				// :103-129: frames live on the OWNER record's relation column under
				// the frame tipo, paired to THIS locator by (dd490, main, id_key =
				// the MAIN locator's stored id). Null id → zero frames (PHP predicate
				// false). Frame positions are the FILTERED re-index (restart at 0 per
				// caller), and the dataframe SEGMENT pins the ORACLE shape: OWNER
				// section + MAIN locator position/target id (verified vs live PHP,
				// numisdata3 §15657).
				if (locator.id === undefined || locator.id === null) continue;
				const frameTrail = trailKey(
					ownerSectionTipo,
					ownerSectionId,
					child.tipo,
					String(locator.id),
				);
				if (ctx.trail.has(frameTrail)) {
					noteUnresolved(ctx.unresolved, `relation_cycle:${child.tipo}`);
					continue;
				}
				const owner = await loadExportRecord(run.atoms, ownerSectionTipo, ownerSectionId);
				const slot = ((owner?.columns.relation as Record<string, unknown[]> | null)?.[child.tipo] ??
					[]) as Record<string, unknown>[];
				const mainTipo = locator.mainComponentTipo ?? relationTipo; // PHP :877
				const paired = slot.filter((entry) =>
					dataframeEntryMatches(
						entry as never,
						mainTipo,
						locator.id as number | string,
						child.tipo,
					),
				);
				const frameLocators: FanOutLocator[] = [];
				for (let index = 0; index < paired.length; index++) {
					const stored = paired[index] as {
						section_tipo?: unknown;
						section_id?: unknown;
						id?: number | string;
					};
					if (typeof stored?.section_tipo !== 'string' || stored.section_id === undefined) {
						continue; // invalid consumes its index (PHP :806-823)
					}
					frameLocators.push({
						sectionTipo: stored.section_tipo,
						sectionId: stored.section_id as number | string,
						index,
						id: stored.id,
					});
				}
				// The frames are the OWNER's data: free for an owner in record scope;
				// a display-admitted owner (a target walked deeper) must have been
				// shown each ENTRY there (D4 — a slot item lists only the frames of
				// the main items the read shows).
				if (frameLocators.length > 0) {
					await exportCrossRecord(
						run.atoms,
						ownerSectionTipo,
						ownerSectionId,
						crossingReach(ctx, {
							reads: [],
							frames: frameLocators.map((frame) => ({
								frameTipo: child.tipo,
								mainTipo,
								pairId: locator.id as number | string,
								sectionTipo: frame.sectionTipo,
								sectionId: frame.sectionId,
							})),
						}),
					);
				}
				const dataframeSegment: ExportSegment = {
					section_tipo: ownerSectionTipo,
					component_tipo: child.tipo,
					model: 'component_dataframe',
					item_index: locator.index,
					section_id: locator.sectionId,
					...(await segmentSeparators(child.tipo, childModel, child as Record<string, unknown>)),
				};
				// Frames-of-frames live on the SAME record (PHP $this->section_*).
				ctx.trail.add(frameTrail);
				await fanOutRelation(
					ctx,
					child.tipo,
					ownerSectionTipo,
					ownerSectionId,
					frameLocators,
					[...baseSegments, dataframeSegment],
					depth + 1,
					map,
					mapOwner,
				);
				ctx.trail.delete(frameTrail);
				continue;
			}

			const childSegment: ExportSegment = {
				section_tipo: locator.sectionTipo,
				component_tipo: child.tipo,
				model: childModel,
				item_index: locator.index,
				section_id: locator.sectionId,
				...(await segmentSeparators(child.tipo, childModel, child as Record<string, unknown>)),
			};
			const segments = [...baseSegments, childSegment];

			// Relation-model child: recurse into ITS locators. The bag is RAW
			// jsonb, so section_id stays union-typed (unswept string form /
			// external remote id) — WC-2026-08-10-section-id-int-canonical.
			if (isStoredRelationModel(childModel)) {
				const childTrail = trailKey(locator.sectionTipo, locator.sectionId, child.tipo);
				if (ctx.trail.has(childTrail)) {
					noteUnresolved(ctx.unresolved, `relation_cycle:${child.tipo}`);
					continue;
				}
				const target = await loadExportRecord(run.atoms, locator.sectionTipo, locator.sectionId);
				// THE locator source (core relations/locator_source.ts): stored slice,
				// or the computed set of a derived model (relation_children/_index).
				const bag =
					target === null
						? []
						: await componentLocators(
								{
									sectionTipo: locator.sectionTipo,
									sectionId: locator.sectionId,
									columns: target.columns as Record<string, unknown>,
								},
								child.tipo,
								childModel,
							);
				const childLocators: FanOutLocator[] = [];
				for (let index = 0; index < bag.length; index++) {
					const stored = bag[index];
					if (typeof stored?.section_tipo !== 'string' || stored.section_id === undefined) {
						continue;
					}
					childLocators.push({
						sectionTipo: stored.section_tipo,
						sectionId: stored.section_id as number | string,
						index,
						id: stored.id,
						mainComponentTipo: stored.main_component_tipo,
					});
				}
				ctx.trail.add(childTrail);
				await fanOutRelation(
					ctx,
					child.tipo,
					locator.sectionTipo,
					locator.sectionId,
					childLocators,
					segments,
					depth + 1,
					map,
					mapOwner,
				);
				ctx.trail.delete(childTrail);
				continue;
			}

			// Plain child: one atom, the child's flat value at the target record.
			await emitPlainAtom(
				ctx,
				locator.sectionTipo,
				locator.sectionId,
				child.tipo,
				childModel,
				segments,
			);
		}

		// WC-049 parents: the locator target's ancestor chain as a sibling
		// '#parents' column (PHP get_export_value :916-948 — per locator, AFTER
		// its children; targets without hierarchy emit nothing). The segment
		// carries the locator's raw position, so the chain row-aligns with the
		// locator's child atoms in every breakdown.
		if (ctx.mode.parents === 'all' || (ctx.mode.parents === 'top' && depth === 0)) {
			const chain = await resolveParentsChain(
				run,
				locator.sectionTipo,
				locator.sectionId,
				ctx.lang,
			);
			if (chain !== null) {
				ctx.atoms.push({
					value: chain,
					cellType: 'text',
					model: (await getModelByTipo(relationTipo)) ?? '',
					segments: [
						...baseSegments,
						{
							section_tipo: locator.sectionTipo,
							component_tipo: relationTipo,
							model: null,
							item_index: locator.index,
							section_id: locator.sectionId,
							sub_id: PARENTS_SUB_ID,
						},
					],
				});
			}
		}
	}
}

/**
 * The EXISTENCE-ONLY atom of one relation_index pointer (T0-9 D6/D8/D9): the
 * pointer's section NAME + section_id — the same `<section name> <id>` the
 * interactive reader (resolve/relation_list.ts) and the edit form's existence
 * cell show — and nothing read from the pointing record. Its crossing is the
 * frontier's narrow existence reach (resolver.ts ExportCrossingReach
 * `existenceOf`, D8): admitted when the host read lists this pointer among
 * the column's own entries, never a licence to read the record. The segment
 * sits in the pointing section's address column (its component_section_id —
 * config_children.ts exportConfigChildren answers the address for exactly this
 * pointer), else on the relation itself. A media-only or strict walk reads
 * nothing here and crosses nothing: an address carries no file.
 */
async function emitExistenceAtom(
	ctx: WalkContext,
	relationTipo: string,
	locator: FanOutLocator,
	baseSegments: ExportSegment[],
): Promise<void> {
	if (ctx.mode.mediaOnly || ctx.mode.strict) return;
	await exportCrossRecord(ctx.run.atoms, locator.sectionTipo, locator.sectionId, {
		reads: [],
		existenceOf: relationTipo,
	});
	const address = (await ownChildrenOf(ctx.run, relationTipo, locator.sectionTipo))[0];
	const { termByTipo } = await import('../../core/ontology/labels.ts');
	ctx.atoms.push({
		value: `${await termByTipo(locator.sectionTipo, ctx.lang)} ${String(locator.sectionId)}`,
		cellType: 'text',
		model:
			address === undefined ? ((await getModelByTipo(relationTipo)) ?? '') : 'component_section_id',
		segments: [
			...baseSegments,
			{
				section_tipo: locator.sectionTipo,
				component_tipo: address?.tipo ?? relationTipo,
				model: address === undefined ? null : 'component_section_id',
				item_index: locator.index,
				section_id: locator.sectionId,
			},
		],
	});
}

/**
 * THE dedalo_raw MEDIA ADDRESSES of one export field on one record
 * (row_media.ts). A raw cell carries the top component's OWN stored slice —
 * for a relation, the locators — and never recurses, so the addresses the
 * SAME ddo reads in the value format come from THE SAME WALK
 * (`walkFieldAtoms`), run media-only (no display text) and STRICT (files leave
 * the system — every crossing takes the full frontier law, never the display
 * carve-out, D4): the declared path, the caller map, the per-model children
 * and locators, the frames — the same reads by construction (invariant: the
 * same ddo gives the same archive in value, grid_value and dedalo_raw). A
 * field that can reach no media component (pure ontology, memoized —
 * {@link exportPathMayReachMedia}) costs no record read at all.
 *
 * Nothing here authorizes: the media ZIP writer re-checks every address as the
 * owner.
 */
export async function collectRawMediaAddresses(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
): Promise<MediaReadAddress[]> {
	const out: MediaReadAddress[] = [];
	// the value format refuses declared dataframe steps (resolveValueCell)
	if (hasDeclaredDataframeStep(field)) return out;
	const path = (field.exportColumn?.path ?? []) as RawPathStep[];
	const leafTipo = String(path[path.length - 1]?.component_tipo ?? '');
	if (leafTipo === '') return out;
	let reaches = getBoundedRunMemo(run.mediaReach, leafTipo);
	if (reaches === undefined) {
		reaches = await exportPathMayReachMedia(path);
		setBoundedRunMemo(run.mediaReach, leafTipo, reaches, run.atoms.cacheLimit);
	}
	if (!reaches) return out;
	const scoped: ExportRun = { ...run, mediaSink: out };
	await walkFieldAtoms(scoped, field, sectionTipo, sectionId, '', [], {
		parents: 'none',
		references: false,
		compact: false,
		strict: true,
		mediaOnly: true,
		callerIndex: false,
	});
	return out;
}

/**
 * Can the export walk of a declared path READ a media component? (pure
 * ontology, conservative): a media step, or a relation leaf whose fan-out —
 * the SAME child selection fanOutRelation makes (caller map first, else own
 * config; dataframe frames; nested relations) — can reach one. A per-locator
 * component (config-less relation_index) is conservatively reachable (its
 * columns are the pointing section's, known only at read time). Shared with the
 * media ZIP's "may this un-captured column hold media" report
 * (tools/tool_export media_zip.ts legacyColumnMayHoldMedia), so both answer
 * from the walk's own child selection.
 */
export async function exportPathMayReachMedia(
	path: readonly { component_tipo?: unknown }[],
): Promise<boolean> {
	for (const step of path) {
		const tipo = step?.component_tipo;
		if (typeof tipo !== 'string' || tipo === '') continue;
		const model = await getModelByTipo(tipo);
		if (typeof model === 'string' && isMediaModel(model)) return true;
	}
	const leaf = path[path.length - 1]?.component_tipo;
	if (typeof leaf !== 'string' || leaf === '') return false;
	const model = await getModelByTipo(leaf);
	if (model === null) return false;
	if (isStoredRelationModel(model))
		return relationReachesMedia(leaf, undefined, undefined, new Set());
	// a non-fan-out datalist leaf resolves its flat value through its config
	return getFlatValueFamily(model) === 'datalist'
		? relationReachesMedia(leaf, undefined, undefined, new Set())
		: false;
}

async function relationReachesMedia(
	relationTipo: string,
	declaredMap: RawConfigDdo[] | undefined,
	declaredMapOwner: string | undefined,
	seen: Set<string>,
): Promise<boolean> {
	const seenKey = `${relationTipo}\u0000${declaredMapOwner ?? ''}`;
	if (seen.has(seenKey)) return false;
	seen.add(seenKey);
	let map: RawConfigDdo[];
	let mapOwner: string;
	if (
		declaredMap !== undefined &&
		declaredMapOwner !== undefined &&
		directChildrenOf(declaredMap, relationTipo, declaredMapOwner).length > 0
	) {
		map = declaredMap;
		mapOwner = declaredMapOwner;
	} else if (await configChildrenArePerLocator(relationTipo)) {
		return true;
	} else {
		map = [...(await exportConfigChildren(relationTipo))];
		mapOwner = relationTipo;
	}
	for (const child of directChildrenOf(map, relationTipo, mapOwner)) {
		const childModel = (await getModelByTipo(child.tipo)) ?? String(child.model ?? '');
		if (childModel === '') continue;
		if (isMediaModel(childModel)) return true;
		if (childModel === 'component_dataframe' || isStoredRelationModel(childModel)) {
			if (await relationReachesMedia(child.tipo, map, mapOwner, seen)) return true;
		}
	}
	return false;
}
