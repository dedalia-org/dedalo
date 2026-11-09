/**
 * Export ATOMS — the export-specific projection over the shared engine's
 * atom events (DIFFUSION_PLAN D8/P6), rebuilt 2026-07-08 to the PHP oracle's
 * export-atom shape (core/dd_grid/class.export_atom.php +
 * component_relation_common::get_export_value).
 *
 * The RESOLUTION (which records, which locators, in which order, with which
 * index provenance) is the shared resolver's resolveRecordAtoms; this module
 * turns those events into PHP-shaped export atoms:
 *
 * - value format: the flat cell string — the PHP export_value::join_atoms
 *   record/field dimensions (legacy resolvePathValue): leaf display values
 *   come from the SAME resolveCellValue contract the relation_list panel
 *   uses; the FIRST indexed level joins with ' | ' (records separator), every
 *   deeper level flips to the component's declared fields_separator (?? ', ');
 * - grid_value format: one atom per placed value, carrying the FULL SEGMENT
 *   PATH (PHP export_path_segment[]): every segment names its runtime owner
 *   (`{section_tipo}_{component_tipo}`) and — when its owner record was
 *   reached by traversing a relation locator — the RAW stored-locator
 *   position as `item_index`. The tabulator (grid.ts) derives the column key,
 *   the '|n' suffixes and the row explosion FROM the segments, per breakdown.
 *
 * Relation-LEAF fan-out (PHP get_export_value recursion): a declared path
 * that ENDS on a relation component does not stop there — the component's OWN
 * request_config ddo_map children resolve per locator target (rsc139 →
 * rsc86 Surname AND rsc85 Name, one column each), and relation-model children
 * recurse further (their declared descendants in the same map first, else
 * their own config), each hop appending a segment with the locator position.
 * component_dataframe children are UNCOVERED scope (ledgered): they surface
 * in `unresolved` (loud) instead of silently dropping a declared column.
 *
 * Parents chains (WC-049, per-ddo value_with_parents checkbox): each relation
 * locator additionally emits its target's ancestor chain (getParentsRecursive
 * nearest-first × thesaurus term resolver, ' > ' joined, self excluded) as ONE
 * atom under a sibling `sub_id:'parents'` segment — the tabulator derives the
 * '#parents' column from the segment identity; the flag inherits down every
 * fan-out level (PHP export_context::descend). The VALUE format reads the SAME
 * chains inside the term cell's own fold (`resolveValueCellWithMedia`
 * withParents — the parents cell MIRRORS the term cell's structure; a sibling
 * column minted by grid.ts); dedalo_raw never does.
 *
 * Byte-parity notes (pinned by test/parity/tool_export_breakdown_differential):
 * - empty/null leaf values are SKIPPED (no atom, no join part) — the PHP
 *   empty() bug-for-bug rule;
 * - segments use the RUNTIME owner section (PHP instantiates every component
 *   at the locator target — multi-section autocompletes key per target);
 * - all caches live in the per-request ExportRun (request isolation, no
 *   module state).
 */

import { getFlatValueFamily } from '../../core/components/registry.ts';
import { isMediaModel } from '../../core/concepts/media.ts';
import { dataframeEntryMatches } from '../../core/concepts/subdatum.ts';
import { getColumnNameByModel, getModelByTipo, getNode } from '../../core/ontology/resolver.ts';
import { getParentsRecursive } from '../../core/relations/parent.ts';
import type {
	CellValueResolveOptions,
	MediaReadAddress,
} from '../../core/resolve/relation_list.ts';
import {
	addMediaReadAddress,
	componentFieldsSeparator,
	dataframeFrameChildren,
	dataframeFrameChildTipos,
	mediaItemsHoldAFile,
	relationTargetChildren,
	resolveCellValue,
	resolveRelationTargetValues,
} from '../../core/resolve/relation_list.ts';
import { runWithRequestLangs } from '../../core/resolve/request_lang.ts';
import type { RawConfigDdo } from '../../core/section/list_definitions/section_list.ts';
import { resolveOwnConfigMap } from '../../core/section/list_definitions/section_list.ts';
import { getTermByLocator } from '../../core/ts_object/term_resolver.ts';
import type { FieldPlan } from '../plan/types.ts';
import type { ExportAtomRun, ExportLeafAtom } from '../resolve/resolver.ts';
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

/** PHP export_value records_separator (join_atoms depth-0 default). */
const RECORDS_SEPARATOR = ' | ';

/** PHP parents_segment fields_separator — the ancestor-chain glue (WC-049:
 * TS pre-joins the chain into ONE atom; PHP emitted one atom per ancestor and
 * joined at tabulate time — same cell bytes, the TS cell join is fixed ' | '). */
const PARENTS_SEPARATOR = ' > ';

/** PHP get_export_value recursion depth backstop (fail LOUD, never spin). */
const MAX_FANOUT_DEPTH = 12;

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
	/** component tipo → can a read of it reach a media component? (raw media walk, bounded) */
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
	 * It covers the langs ONLY. The walk also reads the PRINCIPAL ambiently in
	 * ONE corner — a relation with an implicit config that names NO component
	 * resolves its label through datalist.ts resolveLocatorLabels →
	 * implicit.ts filterAuthorizedRelated → `currentPrincipal()`. Every other
	 * relation reads its children through the principal-free
	 * `resolveOwnConfigMap`; THOSE are filtered by the export run's own frontier
	 * (cellOpts.frontier → resolver.ts exportImplicitChildren, T0-1 / S03), not
	 * by the ambient principal. Frontier refusals are noted on the ambient
	 * request context. The COMPLETE scope — both langs,
	 * the principal, the refusal collector — is grid.ts `openExportGrid`'s
	 * export scope, which is what every export goes through; grid.ts therefore
	 * leaves this unset (the scope already carries it).
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
	 * value format still reads that media (its capture fires before the URL is
	 * formatted), so grid_value must too, or the same ddo archives different
	 * files per format. Set per collectGridAtoms call, never on the run itself.
	 */
	droppedMedia?: MediaReadAddress[];
}

/** Keep the media of a dropped (empty-valued) atom on the walk's sink. */
function noteDroppedMedia(run: ExportRun, media: readonly MediaReadAddress[] | undefined): void {
	if (run.droppedMedia === undefined || media === undefined) return;
	for (const read of media) addMediaReadAddress(run.droppedMedia, read);
}

/**
 * A capturing twin of the run's cell options — or null when the run does not
 * capture. Each call gets its OWN list, so a capture is scoped to exactly the
 * resolution it wraps (one atom, one value cell).
 */
function mediaCapture(
	run: ExportRun,
): { opts: CellValueResolveOptions; media: MediaReadAddress[] } | null {
	if (run.captureMedia !== true) return null;
	const media: MediaReadAddress[] = [];
	return {
		media,
		opts: { ...run.cellOpts, onMediaRead: (read) => addMediaReadAddress(media, read) },
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
				crossRecord: (sectionTipo, sectionId) => exportCrossRecord(atoms, sectionTipo, sectionId),
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
	const implicitTipos = children.filter(isImplicitChild).map((child) => child.tipo);
	if (implicitTipos.length === 0) return children;
	const allowed = await exportImplicitChildren(run.atoms, targetSection, implicitTipos);
	return children.filter((child) => !isImplicitChild(child) || allowed.has(child.tipo));
}

/** The origin tag ownChildrenOf stamps on an implicit map's children. */
const IMPLICIT_CHILD = Symbol('implicit_config_child');

function isImplicitChild(ddo: RawConfigDdo): boolean {
	return (ddo as { [IMPLICIT_CHILD]?: boolean })[IMPLICIT_CHILD] === true;
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
		await exportCrossRecord(run.atoms, ancestor.section_tipo, ancestor.section_id);
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
}

/** PHP export_path_segment::get_identity_key (sub_id joined with '#'). */
export function segmentIdentityKey(segment: ExportSegment): string {
	const base = `${segment.section_tipo}_${segment.component_tipo}`;
	return segment.sub_id !== undefined ? `${base}#${segment.sub_id}` : base;
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
 * The relation component's OWN request_config child ddos (PHP
 * get_export_value `$this->request_config ?? build_request_config()` — the
 * component's own map, NO section_list substitution). Implicit configs (relations
 * list, no ddo_map) normalize to flat self-parented component children.
 */
async function ownChildrenOf(run: ExportRun, componentTipo: string): Promise<RawConfigDdo[]> {
	const cached = getBoundedRunMemo(run.ownChildren, componentTipo);
	if (cached !== undefined) return cached;
	const map = await resolveOwnConfigMap(componentTipo);
	let children: RawConfigDdo[];
	if (map.rawDdos !== null) {
		children = map.rawDdos;
	} else {
		children = [];
		for (const candidate of map.implicitRelations ?? []) {
			const model = await getModelByTipo(candidate);
			if (model?.startsWith('component_')) {
				// Tagged: an implicit child answers to the caller's grant (D1),
				// an explicit one is read at the subdatum floor (D3).
				children.push({ tipo: candidate, parent: 'self', model, [IMPLICIT_CHILD]: true });
			}
		}
	}
	setBoundedRunMemo(run.ownChildren, componentTipo, children, run.atoms.cacheLimit);
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

/** Direct children of `parentTipo` in a ddo_map ('self' aliases the owner). */
function directChildrenOf(
	map: RawConfigDdo[],
	parentTipo: string,
	mapOwnerTipo: string,
): RawConfigDdo[] {
	return map.filter(
		(ddo) =>
			typeof ddo?.tipo === 'string' &&
			(ddo.parent === parentTipo || (ddo.parent === 'self' && parentTipo === mapOwnerTipo)),
	);
}

/**
 * The value-format cell of one export field on one record — the PHP
 * export_value::join byte twin over the shared walk's events: leaves resolve
 * through resolveCellValue, per-level joins fold bottom-up over the index
 * vectors (level 0 = ' | ', deeper levels = the level component's declared
 * fields_separator), empty parts dropped at every level.
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
			resolveValueCellInScope(run, field, sectionTipo, sectionId, lang, unresolved, false),
		)
	).flat;
}

/**
 * `resolveValueCell` plus the media components the cell was read from — the
 * value-format capture (row_media.ts). The flat string is the SAME bytes
 * (the capture only observes the reads); `media` is empty when the run does
 * not capture.
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
): Promise<ValueCells & { media: MediaReadAddress[] }> {
	const capture = mediaCapture(run);
	const scoped: ExportRun = capture === null ? run : { ...run, cellOpts: capture.opts };
	const cells = await inRunLangs(scoped, lang, () =>
		resolveValueCellInScope(scoped, field, sectionTipo, sectionId, lang, unresolved, withParents),
	);
	return { ...cells, media: capture?.media ?? [] };
}

/**
 * One value-format field's cells on one record: the term cell (`flat`) and,
 * only when asked, its WC-049 parents cell.
 *
 * THE PARENTS CELL MIRRORS THE TERM CELL (review 2026-09-25). It is built in
 * the SAME fold, with the SAME separators at the SAME levels, and a bucket the
 * term drops (empty) drops from both. At the leaf every target contributes
 * its ancestor chain ONCE PER PIECE its term text splits into on the leaf's
 * item separator, so a target whose text holds that separator (fields joined
 * by a ' | ' fields_separator, or the separator inside a value) still lines
 * up, and a target with no term contributes nothing. Split both cells the
 * same way and parents piece n is the chain of the record term piece n was
 * read from ('' when that record has no hierarchy). What text cannot carry: a
 * separator INSIDE a chain term, exactly as for the term cell itself.
 * `parents` is null when no piece has a chain (or the term cell is empty).
 */
export interface ValueCells {
	flat: string | null;
	parents: string | null;
}

/** One fold level of `resolveValueCellInScope`: the term text + its mirror. */
interface FoldedValue {
	term: string | null;
	/** The parents mirror (same separators, one chain per term piece). */
	parents: string;
	/** Does any piece below carry a non-empty chain? */
	hasChain: boolean;
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
): Promise<ValueCells> {
	const none: ValueCells = { flat: null, parents: null };
	const path = field.exportColumn?.path ?? [];
	if (path.length === 0) return none;
	if (hasDeclaredDataframeStep(field)) {
		// A DECLARED path step of model component_dataframe is not producible
		// from the tool UI (frames belong to the SOURCE record, the drill-down
		// lists the target's elements) and would mis-walk silently — loud instead.
		noteUnresolved(unresolved, 'component_dataframe:declared-path');
		return none;
	}
	const events = await resolveRecordAtoms(run.atoms, field, sectionTipo, sectionId);
	if (events.length === 0) return none;

	const hops = path.length - 1;
	const leafTipo = String((path[hops] as RawPathStep | undefined)?.component_tipo ?? '');
	if (leafTipo === '') return none;

	// Per-level separators (legacy levelSeparator): level 0 always ' | ';
	// deeper levels use the level component's declared fields_separator (the
	// SAME cached core accessor the relation_list panel uses). The LEAF's
	// separator is passed INTO resolveCellValue as its multi-item join.
	const separators: string[] = [];
	for (let level = 0; level <= hops; level++) {
		const levelTipo = String((path[level] as RawPathStep | undefined)?.component_tipo ?? '');
		separators.push(level === 0 ? RECORDS_SEPARATOR : await componentFieldsSeparator(levelTipo));
	}

	const joinLevel = async (group: ExportLeafAtom[], depth: number): Promise<FoldedValue> => {
		if (depth === hops) {
			// All hops consumed: exactly one leaf event per locator path.
			const event = group[0] as ExportLeafAtom;
			const itemSeparator = separators[hops] as string;
			if (withParents) {
				return resolveLeafWithParents(run, event, leafTipo, lang, unresolved, itemSeparator);
			}
			const term = await resolveCellValue(
				event.ownerSectionTipo,
				event.ownerSectionId,
				leafTipo,
				lang,
				unresolved,
				itemSeparator,
				run.cellOpts,
			);
			return { term, parents: '', hasChain: false };
		}
		// Group by this hop's locator position (first-seen order = DFS order).
		const buckets = new Map<number, ExportLeafAtom[]>();
		for (const event of group) {
			const position = event.indexVector[depth] as number;
			const bucket = buckets.get(position);
			if (bucket === undefined) buckets.set(position, [event]);
			else bucket.push(event);
		}
		const terms: string[] = [];
		const parents: string[] = [];
		let hasChain = false;
		for (const [, bucket] of buckets) {
			const folded = await joinLevel(bucket, depth + 1);
			// A bucket the term drops drops from the mirror too (alignment).
			if (folded.term === null || folded.term === '') continue;
			terms.push(folded.term);
			parents.push(folded.parents);
			hasChain ||= folded.hasChain;
		}
		const separator = separators[depth] as string;
		return {
			term: terms.length > 0 ? terms.join(separator) : null,
			parents: parents.join(separator),
			hasChain,
		};
	};

	const folded = await joinLevel(events, 0);
	return {
		flat: folded.term,
		parents: withParents && folded.term !== null && folded.hasChain ? folded.parents : null,
	};
}

/**
 * The leaf of a parents-carrying value cell: the term text AND its mirror from
 * ONE per-target read. The term is byte-identical to resolveCellValue's
 * datalist branch (the targets' parts, flattened, joined with the item
 * separator; both reads share their early null-returns). A leaf of another
 * family has no targets to pair, so it keeps resolveCellValue's term and ONE
 * empty slot. The chain is the SAME resolveParentsChain the grid_value atoms
 * use; the leaf's stored targets already crossed the export frontier in
 * resolveRecordAtoms.
 */
async function resolveLeafWithParents(
	run: ExportRun,
	event: ExportLeafAtom,
	leafTipo: string,
	lang: string,
	unresolved: string[],
	itemSeparator: string,
): Promise<FoldedValue> {
	const model = await getModelByTipo(leafTipo);
	if (model === null || getFlatValueFamily(model) !== 'datalist') {
		const term = await resolveCellValue(
			event.ownerSectionTipo,
			event.ownerSectionId,
			leafTipo,
			lang,
			unresolved,
			itemSeparator,
			run.cellOpts,
		);
		return { term, parents: '', hasChain: false };
	}
	const targets = await resolveRelationTargetValues(
		event.ownerSectionTipo,
		event.ownerSectionId,
		leafTipo,
		lang,
		unresolved,
		run.cellOpts,
	);
	const terms: string[] = [];
	const slots: string[] = [];
	let hasChain = false;
	for (const target of targets) {
		if (target.parts.length === 0) continue; // no term → no slot
		const chain =
			target.sectionTipo !== null && target.sectionId !== null
				? ((await resolveParentsChain(run, target.sectionTipo, target.sectionId, lang)) ?? '')
				: '';
		if (chain !== '') hasChain = true;
		for (const part of target.parts) {
			terms.push(part);
			// one chain per piece a consumer splits out of this part
			for (const _piece of part.split(itemSeparator)) slots.push(chain);
		}
	}
	return {
		term: terms.length > 0 ? terms.join(itemSeparator) : null,
		parents: slots.join(itemSeparator),
		hasChain,
	};
}

/**
 * grid_value atoms of one export field on one record (PHP get_record_atoms →
 * get_export_value recursion): literal leaves yield one atom whose segments
 * mirror the declared chain (item_index = the hop position that reached each
 * owner); relation leaves FAN OUT into their own request_config children per
 * stored locator, appending one segment per fan-out hop.
 */
export function collectGridAtoms(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	unresolved: string[],
	/** Override the field's value_with_parents flag (the value-format label
	 * derivation passes false so a parents atom can never become atoms[0]). */
	withParentsOverride?: boolean,
	/** Receives the media of values the walk DROPS for being empty (capturing
	 * runs only — see ExportRun.droppedMedia). */
	droppedMedia?: MediaReadAddress[],
): Promise<GridAtom[]> {
	const scoped: ExportRun = droppedMedia === undefined ? run : { ...run, droppedMedia };
	return inRunLangs(run, lang, () =>
		collectGridAtomsInScope(
			scoped,
			field,
			sectionTipo,
			sectionId,
			lang,
			unresolved,
			withParentsOverride,
		),
	);
}

async function collectGridAtomsInScope(
	run: ExportRun,
	field: FieldPlan,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	unresolved: string[],
	withParentsOverride: boolean | undefined,
): Promise<GridAtom[]> {
	// WC-049: per-locator ancestor-chain sibling '#parents' column (the export
	// tool's per-column parents checkbox — per-ddo flag only, grid_value only).
	const withParents = withParentsOverride ?? field.exportColumn?.valueWithParents === true;
	const path = field.exportColumn?.path ?? [];
	if (hasDeclaredDataframeStep(field)) {
		// See resolveValueCell — declared dataframe steps stay loud, never a
		// silent empty walk (frames live on the SOURCE record, not the target).
		noteUnresolved(unresolved, 'component_dataframe:declared-path');
		return [];
	}
	const events = await resolveRecordAtoms(run.atoms, field, sectionTipo, sectionId);
	const atoms: GridAtom[] = [];

	for (const event of events) {
		// Segments of the DECLARED chain: runtime owner per position, the raw
		// locator position that reached it as item_index (null at the root).
		const segments: ExportSegment[] = [];
		for (let position = 0; position < path.length; position++) {
			const rawStep = path[position] as RawPathStep | undefined;
			const componentTipo = String(rawStep?.component_tipo ?? '');
			const owner = event.hopOwners[position];
			segments.push({
				section_tipo: owner?.sectionTipo ?? String(rawStep?.section_tipo ?? sectionTipo),
				component_tipo: componentTipo,
				model: (await getModelByTipo(componentTipo)) ?? String(rawStep?.model ?? ''),
				item_index: position === 0 ? null : (event.indexVector[position - 1] ?? null),
				section_id: position === 0 ? null : (owner?.sectionId ?? null),
			});
		}

		if (event.locators !== undefined && isStoredRelationModel(event.step.model)) {
			// COMPACT portal cells (WC-008, user-approved 2026-07-08): a
			// SINGLE-step ddo whose leaf is a REAL portal (stored ontology model
			// component_portal — the runtime alias also covers autocompletes,
			// which keep PHP parity) does NOT fan out: each referenced record's
			// FULL flat info lands in ONE cell, one atom per stored locator, and
			// the breakdown explodes them by row or by '|n' column. Deep field
			// columns stay available by dragging the expanded child components
			// (multi-step declared paths, PHP-parity fan-out below).
			if (path.length === 1) {
				const storedModel = (await getNode(event.step.tipo))?.model ?? null;
				if (storedModel === 'component_portal') {
					// capture per TARGET: target.media (the outer list is unused)
					const targets = await resolveRelationTargetValues(
						event.ownerSectionTipo,
						event.ownerSectionId,
						event.step.tipo,
						lang,
						unresolved,
						mediaCapture(run)?.opts ?? run.cellOpts,
					);
					const leafSegment = segments[0] as ExportSegment;
					for (const target of targets) {
						const value = target.parts.join(RECORDS_SEPARATOR);
						if (value === '') noteDroppedMedia(run, target.media);
						if (value !== '') {
							atoms.push({
								value,
								cellType: 'text',
								model: event.step.model,
								segments: [
									{
										...leafSegment,
										item_index: target.index,
										section_id: target.sectionId,
									},
								],
								...mediaField(target.media),
							});
						}
						// WC-049 parents: sibling '#parents' atom per target. The
						// indexed FIRST segment keeps the chain row-aligned with the
						// compact value atom; the parents segment itself is unindexed.
						if (withParents && target.sectionTipo !== null && target.sectionId !== null) {
							const chain = await resolveParentsChain(
								run,
								target.sectionTipo,
								target.sectionId,
								lang,
							);
							if (chain !== null) {
								atoms.push({
									value: chain,
									cellType: 'text',
									model: event.step.model,
									segments: [
										{
											...leafSegment,
											item_index: target.index,
											section_id: target.sectionId,
										},
										{
											section_tipo: target.sectionTipo,
											component_tipo: event.step.tipo,
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
					continue;
				}
			}
			// Relation leaf: fan out into the component's own children per
			// locator target (PHP get_export_value foreach data → ddo children).
			// The OWNER is the record holding the leaf's data (dataframe slots
			// live there).
			await fanOutRelation(
				run,
				event.step.tipo,
				event.ownerSectionTipo,
				event.ownerSectionId,
				event.locators,
				segments,
				lang,
				unresolved,
				atoms,
				0,
				withParents,
			);
			continue;
		}

		// Literal leaf: the component's flat value at the owner record.
		const leafCapture = mediaCapture(run);
		const value = await resolveCellValue(
			event.ownerSectionTipo,
			event.ownerSectionId,
			event.step.tipo,
			lang,
			unresolved,
			RECORDS_SEPARATOR,
			leafCapture?.opts ?? run.cellOpts,
		);
		if (value === null || value === '') {
			noteDroppedMedia(run, leafCapture?.media);
			continue;
		}
		atoms.push({
			value,
			cellType: cellTypeOfModel(event.step.model),
			model: event.step.model,
			segments,
			...mediaField(leafCapture?.media),
		});
	}

	return atoms;
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
 * PHP component_relation_common::get_export_value recursion: per stored
 * locator × own-map child — plain children emit one atom (segment item_index
 * = the locator's RAW position), relation children recurse into THEIR stored
 * locators (declared descendants of the current map first, else the child's
 * own config map). `ownerSectionTipo/ownerSectionId` = the record HOLDING the
 * relation's data (where dataframe slots live — PHP $this->section_*).
 */
async function fanOutRelation(
	run: ExportRun,
	relationTipo: string,
	ownerSectionTipo: string,
	ownerSectionId: number | string,
	locators: FanOutLocator[],
	baseSegments: ExportSegment[],
	lang: string,
	unresolved: string[],
	atoms: GridAtom[],
	depth: number,
	/** WC-049 parents flag — inherits down EVERY relation level, exactly like
	 * PHP export_context::descend copies value_with_parents to the child. */
	withParents: boolean,
	declaredMap?: RawConfigDdo[],
	/** The tipo whose request_config `declaredMap` came from — 'self' entries
	 * alias THIS tipo, never the current relation (a nested rsc368 must not
	 * adopt the portal map's self children as its own). */
	declaredMapOwner?: string,
): Promise<void> {
	if (depth > MAX_FANOUT_DEPTH) {
		throw new Error(
			`tool_export fan-out exceeded depth ${MAX_FANOUT_DEPTH} at '${relationTipo}' — cyclic request_config?`,
		);
	}
	// Children: the declared descendants when the caller's map declares them,
	// else the component's OWN request_config (PHP context->ddo_map ?? own).
	let map: RawConfigDdo[];
	let mapOwner: string;
	if (
		declaredMap !== undefined &&
		declaredMapOwner !== undefined &&
		directChildrenOf(declaredMap, relationTipo, declaredMapOwner).length > 0
	) {
		map = declaredMap;
		mapOwner = declaredMapOwner;
	} else {
		map = await ownChildrenOf(run, relationTipo);
		mapOwner = relationTipo;
	}
	const children = directChildrenOf(map, relationTipo, mapOwner);
	if (children.length === 0) return; // PHP: empty ddo_direct_children → no atoms

	for (const locator of locators) {
		// THE FRONTIER (T0-1 / S02): every locator this loop reads through is a
		// crossing — at depth 0 (already asserted by resolveRecordAtoms: a memo
		// hit), at every nested depth (the recursion re-enters here) and for a
		// dataframe's FRAME targets (the recursion's locators are the frames).
		await exportCrossRecord(run.atoms, locator.sectionTipo, locator.sectionId);
		for (const child of await readableMapChildren(run, children, locator.sectionTipo)) {
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
				const dataframeSegment: ExportSegment = {
					section_tipo: ownerSectionTipo,
					component_tipo: child.tipo,
					model: 'component_dataframe',
					item_index: locator.index,
					section_id: locator.sectionId,
				};
				// Frames-of-frames live on the SAME record (PHP $this->section_*).
				await fanOutRelation(
					run,
					child.tipo,
					ownerSectionTipo,
					ownerSectionId,
					frameLocators,
					[...baseSegments, dataframeSegment],
					lang,
					unresolved,
					atoms,
					depth + 1,
					withParents,
					map,
					mapOwner,
				);
				continue;
			}

			const childSegment: ExportSegment = {
				section_tipo: locator.sectionTipo,
				component_tipo: child.tipo,
				model: childModel,
				item_index: locator.index,
				section_id: locator.sectionId,
			};
			const segments = [...baseSegments, childSegment];

			// Relation-model child: recurse into ITS stored locators. The bag is
			// RAW jsonb, so section_id stays union-typed (unswept string form /
			// external remote id) — WC-2026-08-10-section-id-int-canonical.
			if (isStoredRelationModel(childModel)) {
				const target = await loadExportRecord(run.atoms, locator.sectionTipo, locator.sectionId);
				const bag =
					((target?.columns.relation as Record<string, unknown[]> | null)?.[child.tipo] as
						| {
								section_tipo?: string;
								section_id?: number | string;
								id?: number | string;
								main_component_tipo?: string;
						  }[]
						| undefined) ?? [];
				const childLocators: FanOutLocator[] = [];
				for (let index = 0; index < bag.length; index++) {
					const stored = bag[index];
					if (typeof stored?.section_tipo !== 'string' || stored.section_id === undefined) {
						continue;
					}
					childLocators.push({
						sectionTipo: stored.section_tipo,
						sectionId: stored.section_id,
						index,
						id: stored.id,
						mainComponentTipo: stored.main_component_tipo,
					});
				}
				await fanOutRelation(
					run,
					child.tipo,
					locator.sectionTipo,
					locator.sectionId,
					childLocators,
					segments,
					lang,
					unresolved,
					atoms,
					depth + 1,
					withParents,
					map,
					mapOwner,
				);
				continue;
			}

			// Plain child: one atom, the child's flat value at the target record.
			// The target id VERBATIM — an external target's remote id is zero-padded
			// ('000065686'), and Number() asked the service for a different record.
			// resolveCellValue reads a matrix address only for the stored families.
			const childCapture = mediaCapture(run);
			const value = await resolveCellValue(
				locator.sectionTipo,
				locator.sectionId,
				child.tipo,
				lang,
				unresolved,
				RECORDS_SEPARATOR,
				childCapture?.opts ?? run.cellOpts,
			);
			if (value === null || value === '') {
				noteDroppedMedia(run, childCapture?.media);
				continue;
			}
			atoms.push({
				value,
				cellType: cellTypeOfModel(childModel),
				model: childModel,
				segments,
				...mediaField(childCapture?.media),
			});
		}

		// WC-049 parents: the locator target's ancestor chain as a sibling
		// '#parents' column (PHP get_export_value :916-948 — per locator, AFTER
		// its children; targets without hierarchy emit nothing). The segment
		// carries the locator's raw position, so the chain row-aligns with the
		// locator's child atoms in every breakdown.
		if (withParents) {
			const chain = await resolveParentsChain(run, locator.sectionTipo, locator.sectionId, lang);
			if (chain !== null) {
				atoms.push({
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
 * THE dedalo_raw MEDIA ADDRESSES of one export field on one record
 * (row_media.ts). A raw cell carries the top component's OWN stored slice —
 * for a relation, the locators — and never recurses, so the addresses the
 * SAME ddo reads in the value format are derived here, structurally, the way
 * the value format reads them (invariant: the same ddo gives the same archive
 * in value, grid_value and dedalo_raw):
 *
 *  - the DECLARED path is followed first (resolveRecordAtoms — the value
 *    format's own walk), so a portal → title ddo reads no media even when the
 *    portal's config shows an image, and a portal → image ddo reads the image
 *    even when the portal's config does not show it;
 *  - at each leaf owner, resolveCellValue's reads are mirrored: a media leaf is
 *    an address when its stored items name a file (mediaItemsHoldAFile — any
 *    quality, whatever the export base); a datalist-family relation reads, per
 *    stored locator, relationTargetChildren (the SAME derivation
 *    resolveRelationTargetValues uses), a dataframe child through its frames
 *    paired on the record HOLDING the relation (dd490, main, id_key) and
 *    dataframeFrameChildTipos; nested relations recurse.
 *
 * TERMINATION WITHOUT A DEPTH CEILING. The walk is an explicit worklist and
 * each (section, id, component) is expanded once per call, so it ends on any
 * finite record graph — cycles included — and a long chain of DISTINCT
 * records (a self-referencing persons portal) is walked, not refused: this
 * runs on EVERY artifact build (CSV included), and a media side channel must
 * never fail an export that streams fine. A field that can reach no media
 * component (pure ontology, memoized) costs no record read at all.
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
	const path = field.exportColumn?.path ?? [];
	const leafTipo = String((path[path.length - 1] as RawPathStep | undefined)?.component_tipo ?? '');
	if (leafTipo === '' || !(await componentReachesMedia(run, leafTipo))) return out;
	const events = await resolveRecordAtoms(run.atoms, field, sectionTipo, sectionId);
	const visited = new Set<string>();
	for (const event of events) {
		await walkMediaReads(
			run,
			event.ownerSectionTipo,
			event.ownerSectionId,
			event.step.tipo,
			out,
			visited,
		);
	}
	return out;
}

/**
 * Can a read of this component reach a media component — it IS one, or it is
 * a datalist-family relation whose target children (or their frames' children,
 * or nested relations) can? Pure ontology, memoized per run (top-level answers
 * only: an answer computed inside a cycle is partial, so inner results are
 * never cached).
 */
async function componentReachesMedia(run: ExportRun, componentTipo: string): Promise<boolean> {
	const cached = getBoundedRunMemo(run.mediaReach, componentTipo);
	if (cached !== undefined) return cached;
	const reaches = await reachesMediaFrom(componentTipo, new Set());
	setBoundedRunMemo(run.mediaReach, componentTipo, reaches, run.atoms.cacheLimit);
	return reaches;
}

async function reachesMediaFrom(componentTipo: string, seen: Set<string>): Promise<boolean> {
	if (seen.has(componentTipo)) return false;
	seen.add(componentTipo);
	const model = await getModelByTipo(componentTipo);
	if (model === null) return false;
	if (isMediaModel(model)) return true;
	if (getFlatValueFamily(model) !== 'datalist') return false;
	for (const child of await relationTargetChildren(componentTipo)) {
		const tipos = child.isDataframe ? await dataframeFrameChildTipos(child.tipo) : [child.tipo];
		for (const tipo of tipos) {
			if (await reachesMediaFrom(tipo, seen)) return true;
		}
	}
	return false;
}

type RawLocator = {
	section_tipo?: unknown;
	section_id?: unknown;
	id?: number | string;
	main_component_tipo?: string;
};

/**
 * resolveCellValue's MEDIA reads for one (record, component), without
 * resolving a single display value (no external call, no URL formatting):
 * see collectRawMediaAddresses. Iterative, each (section, id, component)
 * expanded once.
 */
/** {@link readableMapChildren} for the relation_list child shape ({tipo, implicit}). */
async function readableTargetChildren<T extends { tipo: string; implicit: boolean }>(
	run: ExportRun,
	children: readonly T[],
	targetSection: string,
): Promise<T[]> {
	const implicitTipos = children.filter((child) => child.implicit).map((child) => child.tipo);
	if (implicitTipos.length === 0) return [...children];
	const allowed = await exportImplicitChildren(run.atoms, targetSection, implicitTipos);
	return children.filter((child) => !child.implicit || allowed.has(child.tipo));
}

async function walkMediaReads(
	run: ExportRun,
	startSection: string,
	startId: number | string,
	startComponent: string,
	out: MediaReadAddress[],
	visited: Set<string>,
): Promise<void> {
	// LIFO worklist, children pushed in reverse: the reads come out in the
	// value format's depth-first order (the archive's entry order).
	const stack: { sectionTipo: string; sectionId: number | string; componentTipo: string }[] = [
		{ sectionTipo: startSection, sectionId: startId, componentTipo: startComponent },
	];
	while (stack.length > 0) {
		const { sectionTipo, sectionId, componentTipo } = stack.pop() as (typeof stack)[number];
		const visitKey = `${sectionTipo}\u0000${sectionId}\u0000${componentTipo}`;
		if (visited.has(visitKey)) continue;
		visited.add(visitKey);
		if (!(await componentReachesMedia(run, componentTipo))) continue;
		const model = (await getModelByTipo(componentTipo)) as string;
		const record = await loadExportRecord(run.atoms, sectionTipo, sectionId);
		if (record === null) continue;
		const column = getColumnNameByModel(model) ?? (isMediaModel(model) ? 'media' : 'relation');
		const slot = ((record.columns[column as never] as unknown as Record<
			string,
			unknown[]
		> | null) ?? null)?.[componentTipo];
		if (isMediaModel(model)) {
			if (mediaItemsHoldAFile(slot)) {
				addMediaReadAddress(out, {
					sectionTipo,
					sectionId: Number(record.section_id),
					componentTipo,
				});
			}
			continue;
		}
		const locators = (Array.isArray(slot) ? slot : []) as RawLocator[];
		if (locators.length === 0) continue;
		const children = await relationTargetChildren(componentTipo);
		const next: typeof stack = [];
		for (const locator of locators) {
			if (typeof locator?.section_tipo !== 'string' || locator.section_id === undefined) continue;
			// THE FRONTIER (T0-1): the media walk mirrors the value format's reads,
			// so it crosses the SAME records — and what it reads leaves the system
			// as FILES in the archive. Asked before the target is queued.
			await exportCrossRecord(
				run.atoms,
				locator.section_tipo,
				locator.section_id as number | string,
			);
			const targetChildren = await readableTargetChildren(run, children, locator.section_tipo);
			for (const child of targetChildren) {
				if (!child.isDataframe) {
					next.push({
						sectionTipo: locator.section_tipo,
						sectionId: locator.section_id as number | string,
						componentTipo: child.tipo,
					});
					continue;
				}
				// Frames live on the record HOLDING the relation, paired to this
				// locator (resolveDataframeFlatValue); null id → no frames.
				if (locator.id === undefined || locator.id === null) continue;
				const frames = (
					((record.columns.relation as Record<string, unknown[]> | null)?.[child.tipo] ??
						[]) as Record<string, unknown>[]
				).filter((entry) =>
					dataframeEntryMatches(
						entry as never,
						locator.main_component_tipo ?? componentTipo,
						locator.id as number | string,
						child.tipo,
					),
				);
				if (frames.length === 0) continue;
				const frameChildren = await dataframeFrameChildren(child.tipo);
				for (const frame of frames) {
					const frameSection = (frame as RawLocator).section_tipo;
					const frameId = (frame as RawLocator).section_id;
					if (typeof frameSection !== 'string' || frameId === undefined) continue;
					// a frame TARGET is a crossing too (T0-1)
					await exportCrossRecord(run.atoms, frameSection, frameId as number | string);
					for (const frameChild of await readableTargetChildren(run, frameChildren, frameSection)) {
						next.push({
							sectionTipo: frameSection,
							sectionId: frameId as number | string,
							componentTipo: frameChild.tipo,
						});
					}
				}
			}
		}
		for (let k = next.length - 1; k >= 0; k--) stack.push(next[k] as (typeof stack)[number]);
	}
}
