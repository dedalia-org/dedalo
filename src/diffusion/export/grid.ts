/**
 * Export GRID — the NDJSON flat-table protocol over the shared diffusion
 * engine (DIFFUSION_PLAN D8/P6 "export unification"), placement math rebuilt
 * 2026-07-08 as a faithful port of the PHP oracle's export_tabulator
 * (tools/tool_export/class.export_tabulator.php) after the deep-breakdown
 * divergence (multi-author bibliography exports came out incoherent: rows
 * misaligned, '|n' suffix collisions merging unrelated authors into one
 * cell, no fill_the_gaps, single-field relation leaves).
 *
 * The WIRE (meta/col/row/end line shapes, interleaving, streaming duality,
 * the three data formats, breakdown placement, separators, column identity/
 * ordering) is pinned by the live-PHP differentials
 * (test/parity/tool_export_differential.test.ts +
 * tool_export_breakdown_differential.test.ts). The RESOLUTION (records,
 * relation hops, locator order, index provenance) rides the shared plan
 * compiler (compile_columns.ts) + resolver atom entry point
 * (resolveRecordAtoms) through atoms.ts.
 *
 * Tabulator semantics (PHP export_tabulator, ported member for member):
 * - build_item_tree/compute_node_layout — the per-record relation item TREE:
 *   axes keyed by the identity chain BEFORE the indexed segment; item heights
 *   stack within an axis, parent height = MAX across axes (max-alignment,
 *   NOT cartesian product); offsets stack sequentially.
 * - place_atom — per breakdown, each indexed segment goes to the row
 *   dimension or the column dimension: 'columns' → all suffixes; 'rows' →
 *   all rows; 'default' → FIRST indexed level rows, deeper suffixes. Column
 *   key = per-SEGMENT identity keys, each with its own '|n' (n>0) — the
 *   collision-free rule ('...rsc368|1.rsc205_rsc140').
 * - resolve_item_rows — offset walk down the tree; fill_the_gaps repeats a
 *   spanning value over its whole row span.
 * - register_column — dedupe by key; deterministic ordered insert
 *   (sort_key lexicographic → shorter first → arrival seq); 'after' insert
 *   hints; labels = per-segment ontology terms joined ' | ' with ' N+1'
 *   suffixes on suffixed segments; ar_labels keeps the section/component
 *   alternation. 'end' carries the AUTHORITATIVE display order.
 * - value/dedalo_raw — static column modes: ONE column per top-component
 *   key, minted on the first record that carries the ddo (even atom-less);
 *   cells overwrite on key collision (PHP parity). dedalo_raw additionally
 *   mints ONE column per dataframe slot of an exported component
 *   (WC-2026-08-09-export-raw-dataframe-own-column — a divergence from the
 *   oracle, which folded the frames into the main component's cell).
 *
 * Record SELECTION deliberately stays on sanitizeClientSqo + buildSearchSql
 * (the same §8.4 chokepoint the whole read side uses): the export contract
 * preserves the client SQO's order and the caller-principal projects filter.
 * The selection is NEVER loaded whole (PERF-1): it is materialized once, in
 * one snapshot, as a server-side hold cursor (selection_cursor.ts) and paged
 * into the walk — the protocol's meta `total` is that snapshot's exact count,
 * known before the first line without moving a row to the process.
 */

import { CLIENT_MAX_LIMIT, getSectionTipos, sanitizeClientSqo } from '../../core/concepts/sqo.ts';
import { DedaloError, ok } from '../../core/errors/index.ts';
import { isDiffusionLangCode } from '../../config/lang_code.ts';
import { termByTipo } from '../../core/ontology/labels.ts';
import { getColumnNameByModel, getModelByTipo } from '../../core/ontology/resolver.ts';
import { EmissionContext } from '../../core/resolve/component_data.ts';
import type { MediaReadAddress } from '../../core/resolve/relation_list.ts';
import {
	currentApplicationLang,
	currentDataLang,
	runWithRequestLangs,
} from '../../core/resolve/request_lang.ts';
import { buildSearchSql } from '../../core/search/sql_assembler.ts';
import { getDataframeChildTipos } from '../../core/section/list_definitions/section_list.ts';
import {
	type FrontierRefusal,
	type FrontierScope,
	noteFrontierRefusal,
	resolveDeclaredTipo,
} from '../../core/security/frontier_scope.ts';
import { getPermissions, type Principal } from '../../core/security/permissions.ts';
import {
	currentRequestContext,
	type RequestContext,
	runWithRequestContext,
} from '../../core/security/request_context.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../core/tools/module.ts';
import { loadExportRecord, prefetchExportRecords } from '../resolve/resolver.ts';
import type { ExportRun, ExportSegment, GridAtom } from './atoms.ts';
import {
	cellTypeOfModel,
	collectGridAtoms,
	collectRawMediaAddresses,
	createExportRun,
	fieldHasValueParents,
	PARENTS_SUB_ID,
	resolveValueCell,
	resolveValueCellWithMedia,
	segmentIdentityKey,
} from './atoms.ts';
import type { ExportDdoInput } from './compile_columns.ts';
import { compileExportPlan } from './compile_columns.ts';
import {
	createExternalDegradationLog,
	type ExportExternalDegradation,
	type ExternalPrefetchPlan,
	planExternalPrefetch,
	prefetchExternalRowsForBatch,
} from './external_prefetch.ts';
import { ndjsonStream } from './ndjson_stream.ts';
import { EXPORT_ROW_MEDIA, type ExportRowMediaAddress } from './row_media.ts';
import {
	openSelectionCursor,
	SELECTION_PAGE_ROWS_MAX,
	type SelectionAdmission,
	type SelectionCursor,
} from './selection_cursor.ts';

/** Records bulk-hydrated per chunk (matches the diffusion selection default). */
const HYDRATE_BATCH = 500;

/** Selection rows per cursor FETCH (PERF-1) — the cursor's page bound, at least one hydrate batch. */
const SELECTION_PAGE = SELECTION_PAGE_ROWS_MAX;

/** One raw declared path step (verbatim client shape). */
type RawPathStep = {
	section_tipo?: string | string[];
	component_tipo?: string;
	model?: string;
	name?: string;
	[extra: string]: unknown;
};

/*
 * The declared-shape normalizer that used to live here (`declaredSegmentTipo`)
 * is DELETED: it was an ad-hoc twin of the reading `ddoIsAuthorized` and the
 * buildEntries record guard already take, and the class review found the class
 * open precisely because each site had its own. The one reading is
 * `core/security/frontier_scope.ts resolveDeclaredTipo`, imported above — see
 * its docblock for the shapes it refuses and the census that says refusing them
 * refuses no lawful export.
 */

/** A registered tabulator column (PHP export_tabulator::$columns entry). */
interface TabColumn {
	i: number;
	key: string;
	group: string;
	path: unknown;
	label: string;
	ar_labels: string[];
	cell_type: string;
	model: string | null;
	sortKey: number[];
	seq: number;
}

/** An item-tree node (PHP build_item_tree node shape). */
interface ItemNode {
	height: number;
	offset: number;
	axes: Map<string, Map<number, ItemNode>>;
}

/** Per-record entry, one per export ddo (PHP get_record_atoms ar_entries). */
type RecordEntry =
	| {
			kind: 'grid';
			ddoIndex: number;
			atoms: GridAtom[];
			/** Media of values the walk dropped for being empty (capturing runs
			 * only): read, but shown in no cell — noted without a column. */
			droppedMedia?: MediaReadAddress[];
	  }
	| {
			kind: 'value';
			ddoIndex: number;
			topKey: string;
			declaredPath: RawPathStep[];
			/** PHP atoms[0]->path: the fan-out-extended label chain (relation
			 * leaves with data only) — the header resolves through it. */
			labelSegments?: ExportSegment[];
			flat: string | null;
			leafModel: string;
			topModel: string;
			/** Media read for the cell (capturing runs only — row_media.ts). */
			media?: MediaReadAddress[];
			/** WC-049 (addendum 2026-09-25): the sibling parents cell — present
			 * ONLY when the ddo's flag is set on a relation leaf
			 * (atoms.ts fieldHasValueParents); `flat` null = no chain on any
			 * target (the column still mints). Absent → byte-identical output. */
			parents?: { flat: string | null };
	  }
	| {
			kind: 'raw';
			ddoIndex: number;
			topKey: string;
			ownSegment: ExportSegment;
			raw: string | number | null;
			cellType: string;
			topModel: string;
			/** Media the raw cell addresses (capturing runs only — row_media.ts). */
			media?: MediaReadAddress[];
	  };

/** The DECLARED chain of a ddo as unindexed segments (the value/raw column
 * header source when no fan-out atom extends it). */
function declaredSegmentsOf(declaredPath: RawPathStep[]): ExportSegment[] {
	return declaredPath.map((step) => ({
		section_tipo: String(
			Array.isArray(step.section_tipo) ? (step.section_tipo[0] ?? '') : (step.section_tipo ?? ''),
		),
		component_tipo: String(step.component_tipo ?? ''),
		model: String(step.model ?? ''),
		item_index: null,
		section_id: null,
	}));
}

/**
 * The stateful tabulator of one export run (PHP export_tabulator instance):
 * columns registry + deterministic display order + row/record counters.
 * Created per request — no module state (request isolation).
 */
function createTabulator(options: {
	dataFormat: string;
	breakdown: string;
	fillTheGaps: boolean;
	lang: string;
}) {
	const { dataFormat, breakdown, fillTheGaps, lang } = options;
	const columns = new Map<string, TabColumn>();
	const order: string[] = [];
	const byOrdinal = new Map<number, TabColumn>();
	let nextOrdinal = 0;
	let nextSeq = 0;
	let rowsEmitted = 0;
	let recordsCount = 0;

	/** PHP resolve_labels: per-segment section+component terms; dedalo_raw
	 * emits raw tipos (import header grammar) with the section_id alias. */
	const resolveLabels = async (
		segments: ExportSegment[] | null,
		suffixMap: Map<number, number>,
		fallbackKey: string,
	): Promise<{ label: string; ar_labels: string[] }> => {
		if (segments === null || segments.length === 0) {
			return { label: fallbackKey, ar_labels: [fallbackKey] };
		}
		const arLabels: string[] = [];
		const compact: string[] = [];
		for (let position = 0; position < segments.length; position++) {
			const segment = segments[position] as ExportSegment;
			let sectionLabel: string;
			let componentLabel: string;
			if (dataFormat === 'dedalo_raw') {
				sectionLabel = segment.section_tipo;
				componentLabel =
					segment.model === 'component_section_id' ? 'section_id' : segment.component_tipo;
			} else {
				sectionLabel = await termByTipo(segment.section_tipo, lang);
				componentLabel =
					segment.sub_id !== undefined
						? segment.sub_id
						: await termByTipo(segment.component_tipo, lang);
			}
			const suffix = suffixMap.get(position);
			if (suffix !== undefined && suffix > 0) {
				componentLabel += ` ${suffix + 1}`;
			}
			arLabels.push(sectionLabel, componentLabel);
			compact.push(componentLabel);
		}
		return { label: compact.join(' | '), ar_labels: arLabels };
	};

	/** PHP compare_columns: sort_key lexicographic → shorter first → seq. */
	const compareColumns = (a: TabColumn, b: TabColumn): number => {
		const len = Math.min(a.sortKey.length, b.sortKey.length);
		for (let i = 0; i < len; i++) {
			const ka = a.sortKey[i] as number;
			const kb = b.sortKey[i] as number;
			if (ka !== kb) return ka - kb;
		}
		if (a.sortKey.length !== b.sortKey.length) return a.sortKey.length - b.sortKey.length;
		return a.seq - b.seq;
	};

	/** PHP register_column: the single point of column creation. */
	const registerColumn = async (
		key: string,
		group: string,
		segments: ExportSegment[] | null,
		pathPayload: unknown,
		suffixMap: Map<number, number>,
		ddoIndex: number,
		sortTail: number[],
		cellType: string,
		model: string | null,
		newColLines: Record<string, unknown>[],
	): Promise<TabColumn> => {
		const existing = columns.get(key);
		if (existing !== undefined) return existing;

		const labels = await resolveLabels(segments, suffixMap, key);
		let effectiveModel = model;
		if (effectiveModel === null && segments !== null && segments.length > 0) {
			effectiveModel = segments[segments.length - 1]?.model ?? null;
		}

		const column: TabColumn = {
			i: nextOrdinal++,
			key,
			group,
			path: pathPayload,
			label: labels.label,
			ar_labels: labels.ar_labels,
			cell_type: cellType,
			model: effectiveModel,
			sortKey: [ddoIndex, ...sortTail],
			seq: nextSeq++,
		};
		columns.set(key, column);
		byOrdinal.set(column.i, column);

		// ordered insert (deterministic display order)
		let insertPos = order.length;
		for (let i = 0; i < order.length; i++) {
			const other = columns.get(order[i] as string) as TabColumn;
			if (compareColumns(column, other) < 0) {
				insertPos = i;
				break;
			}
		}
		order.splice(insertPos, 0, key);
		const after =
			insertPos > 0 ? (columns.get(order[insertPos - 1] as string) as TabColumn).i : null;

		newColLines.push({
			t: 'col',
			i: column.i,
			key: column.key,
			group: column.group,
			path: column.path,
			label: column.label,
			ar_labels: column.ar_labels,
			cell_type: column.cell_type,
			model: column.model,
			after,
		});
		return column;
	};

	/** PHP build_item_tree: register every indexed item chain of the record. */
	const buildItemTree = (entries: RecordEntry[], firstOnly: boolean): ItemNode => {
		const root: ItemNode = { height: 1, offset: 0, axes: new Map() };
		for (const entry of entries) {
			if (entry.kind !== 'grid') continue;
			for (const atom of entry.atoms) {
				let node = root;
				const identityChain: string[] = [];
				for (const segment of atom.segments) {
					if (segment.item_index !== null) {
						const axisKey = identityChain.join('.');
						let axis = node.axes.get(axisKey);
						if (axis === undefined) {
							axis = new Map();
							node.axes.set(axisKey, axis);
						}
						let item = axis.get(segment.item_index);
						if (item === undefined) {
							item = { height: 1, offset: 0, axes: new Map() };
							axis.set(segment.item_index, item);
						}
						node = item;
						if (firstOnly) break;
					}
					identityChain.push(segmentIdentityKey(segment));
				}
			}
		}
		computeNodeLayout(root);
		return root;
	};

	/** PHP compute_node_layout: heights bottom-up, offsets stack, MAX axes. */
	const computeNodeLayout = (node: ItemNode): void => {
		let maxAxisHeight = 1;
		for (const [axisKey, items] of node.axes) {
			const sorted = new Map([...items.entries()].sort((a, b) => a[0] - b[0]));
			node.axes.set(axisKey, sorted);
			let offset = 0;
			for (const item of sorted.values()) {
				computeNodeLayout(item);
				item.offset = offset;
				offset += item.height;
			}
			if (offset > maxAxisHeight) maxAxisHeight = offset;
		}
		node.height = maxAxisHeight;
	};

	/** PHP resolve_item_rows: offset walk + fill span. */
	const resolveItemRows = (
		rowChain: { axisKey: string; index: number }[],
		itemTree: ItemNode | null,
	): number[] => {
		if (itemTree === null) return [0];
		let rowOffset = 0;
		let node = itemTree;
		for (const ix of rowChain) {
			const item = node.axes.get(ix.axisKey)?.get(ix.index);
			if (item === undefined) return [rowOffset]; // unknown item (defensive)
			rowOffset += item.offset;
			node = item;
		}
		const span = Math.max(1, node.height);
		if (!fillTheGaps) return [rowOffset];
		return Array.from({ length: span }, (_, i) => rowOffset + i);
	};

	/** PHP place_atom: resolve the column + output rows of one atom. */
	const placeAtom = async (
		atom: GridAtom,
		ddoIndex: number,
		itemTree: ItemNode | null,
		newColLines: Record<string, unknown>[],
	): Promise<{ column: TabColumn; rows: number[] }> => {
		// indexed segments: [{pos, axisKey (identity chain BEFORE), index}]
		const indexed: { pos: number; axisKey: string; index: number }[] = [];
		const identityChain: string[] = [];
		for (let pos = 0; pos < atom.segments.length; pos++) {
			const segment = atom.segments[pos] as ExportSegment;
			if (segment.item_index !== null) {
				indexed.push({ pos, axisKey: identityChain.join('.'), index: segment.item_index });
			}
			identityChain.push(segmentIdentityKey(segment));
		}

		// column suffixes vs row dimension per breakdown mode
		const suffixMap = new Map<number, number>();
		const rowChain: { axisKey: string; index: number }[] = [];
		if (breakdown === 'columns') {
			for (const ix of indexed) suffixMap.set(ix.pos, ix.index);
		} else if (breakdown === 'rows') {
			for (const ix of indexed) rowChain.push(ix);
		} else {
			for (let i = 0; i < indexed.length; i++) {
				const ix = indexed[i] as { pos: number; axisKey: string; index: number };
				if (i === 0) rowChain.push(ix);
				else suffixMap.set(ix.pos, ix.index);
			}
		}

		// column key: per-segment identities, '|n' on column-dimension segments
		const keyParts: string[] = [];
		for (let pos = 0; pos < atom.segments.length; pos++) {
			let part = segmentIdentityKey(atom.segments[pos] as ExportSegment);
			const suffix = suffixMap.get(pos);
			if (suffix !== undefined && suffix > 0) part += `|${suffix}`;
			keyParts.push(part);
		}
		const columnKey = keyParts.join('.');
		const group = segmentIdentityKey(atom.segments[0] as ExportSegment);

		const sortTail: number[] = [];
		for (const ix of indexed) {
			const suffix = suffixMap.get(ix.pos);
			if (suffix !== undefined) sortTail.push(suffix);
		}

		const column = await registerColumn(
			columnKey,
			group,
			atom.segments,
			atom.segments,
			suffixMap,
			ddoIndex,
			sortTail,
			atom.cellType,
			null, // model: taken from the leaf segment
			newColLines,
		);

		let rows: number[];
		if (rowChain.length === 0) {
			// record-level value: first row, or the whole record span when filling
			rows =
				fillTheGaps && itemTree !== null && itemTree.height > 1 && breakdown !== 'columns'
					? Array.from({ length: itemTree.height }, (_, i) => i)
					: [0];
		} else {
			rows = resolveItemRows(rowChain, itemTree);
		}
		return { column, rows };
	};

	/** PHP record_lines: tabulate one record → col* then row* lines. */
	const recordLines = async (
		entries: RecordEntry[],
		recId: string,
	): Promise<Record<string, unknown>[]> => {
		recordsCount++;
		const newColLines: Record<string, unknown>[] = [];
		const cellGroups = new Map<number, Map<number, string[]>>();
		const rawCells: Record<string, string | number> = {};
		let recordHeight = 1;
		// The record's captured media addresses, per placed column (row_media.ts).
		const media: ExportRowMediaAddress[] = [];
		const mediaSeen = new Set<string>();
		// `ordinal` null: media READ for a cell that shows nothing (an empty
		// value — only the 'original' quality exists yet, or the export base is
		// unset); the same media in every format, placed in no column.
		const noteMedia = (
			ordinal: number | null,
			reads: readonly MediaReadAddress[] | undefined,
		): void => {
			for (const read of reads ?? []) {
				const key = `${ordinal ?? ''}\u0000${read.sectionTipo}\u0000${read.sectionId}\u0000${read.componentTipo}`;
				if (mediaSeen.has(key)) continue;
				mediaSeen.add(key);
				media.push([ordinal, read.sectionTipo, read.sectionId, read.componentTipo]);
			}
		};

		const itemTree =
			dataFormat === 'grid_value' && breakdown !== 'columns'
				? buildItemTree(entries, breakdown === 'default')
				: null;
		if (itemTree !== null) recordHeight = itemTree.height;

		for (const entry of entries) {
			if (entry.kind === 'value' || entry.kind === 'raw') {
				// static column modes mint the top ddo column even with no atoms
				const isRaw = entry.kind === 'raw';
				const segments: ExportSegment[] = isRaw
					? [entry.ownSegment]
					: // PHP :295-302 — with atoms the header chain is atoms[0]->path
						// (fan-out-extended); the declared chain only covers the
						// no-atoms case.
						(entry.labelSegments ?? declaredSegmentsOf(entry.declaredPath));
				const cellType = isRaw
					? entry.raw !== null
						? entry.cellType
						: 'text'
					: entry.flat !== null
						? cellTypeOfModel(entry.leafModel)
						: 'text';
				const column = await registerColumn(
					entry.topKey,
					entry.topKey, // group
					segments,
					isRaw ? segments : entry.declaredPath,
					new Map(),
					entry.ddoIndex,
					[],
					cellType,
					entry.topModel,
					newColLines,
				);
				let shown = false;
				if (isRaw) {
					if (entry.raw !== null) {
						rawCells[String(column.i)] = entry.raw;
						shown = true;
					}
				} else if (entry.flat !== null && entry.flat !== '') {
					rawCells[String(column.i)] = entry.flat;
					shown = true;
				}
				noteMedia(shown ? column.i : null, entry.media);
				if (!isRaw && entry.parents !== undefined) {
					// WC-049 value format: the sibling parents column, minted right
					// after its term column (sortKey [ddo, 0] sorts after [ddo] and
					// before the next ddo) on EVERY record once the flag is set. Its
					// identity/label reuse the grid_value parents segment: the
					// declared chain + a `sub_id:'parents'` segment on the leaf →
					// key `<top>#parents`, header '<column> | parents'. ONE column
					// for all target sections (the cell is positional, per item).
					const declared = declaredSegmentsOf(entry.declaredPath);
					const leaf = declared[declared.length - 1] as ExportSegment;
					const parentsSegments: ExportSegment[] = [
						...declared,
						{
							section_tipo: leaf.section_tipo,
							component_tipo: leaf.component_tipo,
							model: null,
							item_index: null,
							section_id: null,
							sub_id: PARENTS_SUB_ID,
						},
					];
					const parentsColumn = await registerColumn(
						`${entry.topKey}#${PARENTS_SUB_ID}`,
						entry.topKey, // group: the term column's
						parentsSegments,
						parentsSegments,
						new Map(),
						entry.ddoIndex,
						[0],
						'text',
						null, // model: the parents segment's (null), as in grid_value
						newColLines,
					);
					if (entry.parents.flat !== null) {
						rawCells[String(parentsColumn.i)] = entry.parents.flat;
					}
				}
				continue;
			}

			// grid_value: place every atom
			noteMedia(null, entry.droppedMedia);
			for (const atom of entry.atoms) {
				const placement = await placeAtom(atom, entry.ddoIndex, itemTree, newColLines);
				noteMedia(placement.column.i, atom.media);
				for (const rowIndex of placement.rows) {
					let rowCells = cellGroups.get(rowIndex);
					if (rowCells === undefined) {
						rowCells = new Map();
						cellGroups.set(rowIndex, rowCells);
					}
					const bucket = rowCells.get(placement.column.i) ?? [];
					bucket.push(atom.value);
					rowCells.set(placement.column.i, bucket);
				}
			}
		}

		const lines = newColLines;
		const firstRow = lines.length;
		if (dataFormat === 'value' || dataFormat === 'dedalo_raw') {
			lines.push({ t: 'row', rec: recId, sub: 0, c: rawCells });
			rowsEmitted++;
		} else {
			for (let rowIndex = 0; rowIndex < recordHeight; rowIndex++) {
				const cells: Record<string, string> = {};
				for (const [ordinal, values] of cellGroups.get(rowIndex) ?? []) {
					const joined = values.length === 1 ? (values[0] as string) : values.join(' | ');
					if (joined !== '') cells[String(ordinal)] = joined;
				}
				lines.push({ t: 'row', rec: recId, sub: rowIndex, c: cells });
				rowsEmitted++;
			}
		}
		// Out of band, on the record's FIRST row: a symbol key, which no
		// serialization of the line carries (row_media.ts).
		if (media.length > 0) {
			(lines[firstRow] as Record<PropertyKey, unknown>)[EXPORT_ROW_MEDIA] = media;
		}
		return lines;
	};

	/** PHP end_line: the AUTHORITATIVE display order. */
	const endLine = (): Record<string, unknown> => ({
		t: 'end',
		columns: order.map((key) => (columns.get(key) as TabColumn).i),
		rows: rowsEmitted,
		records: recordsCount,
	});

	return { recordLines, endLine };
}

/**
 * What `openExportGrid` needs from its caller, ALL of it explicit: WHO exports
 * (the principal every gate and the frontier answer to), WHAT (the tool_export
 * options — `options.lang` is the export's DATA lang) and IN WHICH INTERFACE
 * LANGUAGE (labels the walk mints, e.g. a component_date 'period' cell's unit
 * words). A subset of `ToolActionContext` plus the interface lang — a
 * background job builds it without a request (the lang comes from the job's
 * submit-time snapshot, never from "whatever scope the worker happens to be
 * in"), and nothing below reads the request id or the socket.
 *
 * WHY ALL THREE MUST BE HERE (Rule 6, engineering/REQUEST_ISOLATION.md). Leaf
 * code on the walk still reads identity from the ALS backstops, and those
 * reads reach the OUTPUT:
 *   - interface lang: component_date/date_value.ts resolvePeriodLabels →
 *     `currentApplicationLang()`;
 *   - data lang: the component_external cell (relation_list.ts resolveCellValue
 *     → deriveExternalValue → external/cache.ts fetchExternalRows) takes
 *     `currentDataLang()` — the remote row is fetched per language;
 *   - principal: the implicit request_config a relation cell's LABEL is picked
 *     from (datalist.ts resolveLocatorLabels → implicit.ts
 *     filterAuthorizedRelated) filters by `currentPrincipal()` — no principal,
 *     NO filter.
 * `openExportGrid` therefore runs every step of the walk inside ITS OWN scope
 * built from these values (see `createExportScope`), so the bytes are the same
 * in a request, in a detached job, and on a stream pulled after the request's
 * scope is gone.
 */
export type ExportGridContext = Pick<ToolActionContext, 'principal' | 'options'> & {
	/** The interface language the export's labels resolve in (required: a
	 * missing value would silently mean the installation default). */
	applicationLang: string;
};

/** Run controls for `openExportGrid`. */
export interface ExportGridRunOptions {
	/**
	 * Cooperative cancellation. Checked at every hydrate-batch boundary (before a
	 * chunk is hydrated) AND before every record inside a chunk; once aborted the
	 * generator RETURNS — no further row and NO 'end' line. A missing 'end' is the protocol's one abort signal (the same
	 * truncated-body reading ndjsonStream documents), so a consumer tells a
	 * cancelled run from a finished one by whether it saw 'end'.
	 */
	signal?: AbortSignal;
	/**
	 * What an open does when every selection slot is held (selection_cursor.ts
	 * ADMISSION): `'refuse'` (default — the request path answers `export.busy`
	 * at once) or `'queue'` (the background export lane: an admitted job waits
	 * for the next slot, ended by `signal`).
	 */
	selectionAdmission?: SelectionAdmission;
	/**
	 * Records hydrated per chunk (default HYDRATE_BATCH). Only a gate needs to
	 * move it — to put a batch boundary between two records of a small built
	 * situation. Output bytes never depend on it; a non-positive-integer value
	 * falls back to the default.
	 */
	hydrateBatch?: number;
	/**
	 * Selection rows per cursor FETCH (default SELECTION_PAGE; never below
	 * `hydrateBatch`). A named TEST SEAM like `hydrateBatch`: only a gate moves
	 * it, to make a small built selection span several pages. Output bytes
	 * never depend on it (chunks are cut at `hydrateBatch` across pages).
	 */
	selectionPage?: number;
	/**
	 * The selection cursor's consumer-idle window in ms (default
	 * EXPORT_CURSOR_IDLE_MS). A named TEST SEAM like `selectionPage`: only a
	 * gate moves it, to prove a stalled consumer is closed out while a slow
	 * export that keeps pulling is not.
	 */
	selectionIdleMs?: number;
	/**
	 * The REQUEST this export answers, passed EXPLICITLY by a caller that serves
	 * one (`exportGridUnified`: its envelope's `perm.out_of_scope` notice reads
	 * that request's frontier log). Two things are taken from it and from
	 * nothing else: every frontier refusal of the walk is also copied onto it,
	 * and its session / request id / client ip are carried into the export's
	 * scope (leaf logging keeps the correlation id). Never read from the ambient
	 * store: a detached job (runExportArtifact) inherits the SUBMITTING
	 * request's context through the job manager, and a walk that forwarded into
	 * it would write — for hours — into a request that ended long ago (and keep
	 * that object alive). Absent = no request: the refusals stay on the opened
	 * grid's own `frontierRefusals`.
	 */
	enclosingRequest?: RequestContext;
	/**
	 * CAPTURE MEDIA ADDRESSES (row_media.ts): each record's first row line
	 * carries, under the `EXPORT_ROW_MEDIA` symbol, every (section, id,
	 * component) its cells READ media from — at any path depth, in every data
	 * format. Serialized output is byte-identical either way (a symbol key is
	 * never serialized). The tool_export background build sets it (its spool
	 * writes the addresses to `media.ndjson` for the media ZIP); a stream or a
	 * buffered envelope has no reader for them and leaves it off.
	 */
	captureMedia?: boolean;
}

/** An opened export: the meta line, the line producer, and its notes. */
export interface OpenedExportGrid {
	/** The 'meta' line — also the FIRST line `lines` yields (same object). */
	meta: Record<string, unknown>;
	/**
	 * THE protocol-line producer: meta, interleaved col/row lines, then 'end'.
	 * Lazy and single-use; it retains no emitted line, so a consumer that writes
	 * each line away holds at most one record's lines whatever the selection
	 * size. It OWNS the selection cursor (a pooled connection and an admission
	 * slot): exhausting it, or calling `return()` / `throw()` on it — even
	 * before the first `next()` — releases them. A consumer that stops early
	 * must call `return()`.
	 */
	lines: AsyncGenerator<Record<string, unknown>>;
	/**
	 * Non-fatal "no atom for this cell model" notes, DISTINCT (each note once,
	 * however many records raise it — bounded by the plan, not the selection).
	 * LIVE: it fills while `lines` runs, and is complete only once the generator
	 * is exhausted.
	 */
	unresolved: readonly string[];
	/**
	 * Every ACL NARROWING this export suffered (the frontier's `[frontier]
	 * REFUSED …` events) — e.g. an SQO filter hop through a component the
	 * principal cannot read answers `1=0` and an order hop is dropped, never a
	 * throw, so the SELECTION shrinks or reorders and this list is what every
	 * disclosure is built from (the request envelope's `perm.out_of_scope`
	 * notice; tool_export's `narrowed` flag on the job summary and the list —
	 * a flag, never these coordinates). Collected on the export's own scope, so it survives outside a
	 * request (a detached job must carry it into its manifest; the ambient
	 * request-context notice alone would be dropped there). When the caller
	 * names the request it serves (`ExportGridRunOptions.enclosingRequest`) the
	 * same entries are ALSO forwarded to that request's context, so the
	 * envelope's `perm.out_of_scope` notice is unchanged. LIVE, like `unresolved`: the
	 * eager refusals (selection) are in it when the promise resolves; walk-time
	 * ones land while `lines` runs.
	 */
	frontierRefusals: readonly FrontierRefusal[];
	/**
	 * Every RUNTIME (section, component) pair the export frontier ALLOWED — the
	 * grants the emitted values were read under beyond the DECLARED path (a
	 * stored locator may land in a section the ddo path never names). Empty for
	 * a global admin (the walk carries no frontier). A finished export records
	 * them (tool_export manifest `frontier_grants`) so every later read re-asks
	 * each one (access.ts exportStillReadable). LIVE, like `unresolved`:
	 * complete only once `lines` is exhausted.
	 */
	frontierGrants: ReadonlyMap<string, { section_tipo: string; component_tipo: string }>;
	/**
	 * THE EXTERNAL-SOURCE SUMMARY (FIX 4, 2026-09-24 — external_prefetch.ts):
	 * every component_external cell the walk resolved DEGRADED (the source could
	 * not answer, the circuit was open, a stale copy was served, the service is
	 * disabled or misconfigured, values were cut) — counts per (service, state),
	 * the exported records affected and a capped sample; null while nothing
	 * degraded. An export must never be SILENTLY incomplete: tool_export copies
	 * this into its manifest and serves it, and the 'end' line carries it
	 * (`external_degraded`, only when non-null — a clean export's bytes are
	 * unchanged). LIVE, like `unresolved`: complete once `lines` is exhausted;
	 * each call returns a detached, bounded copy.
	 */
	externalDegradation: () => ExportExternalDegradation | null;
}

/**
 * The export data lang: `options.lang`, the language the user picked in the tool
 * (tool_export always sends it; the build handler fills in the submitter's
 * data lang when it is absent). The request-scoped data lang is the backstop —
 * never a hardcoded install language.
 */
function exportLangOf(options: Record<string, unknown>): string {
	const lang = options.lang ?? currentDataLang();
	if (typeof lang !== 'string' || !isDiffusionLangCode(lang)) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'options.lang must be a data language code (e.g. lg-eng)',
		});
	}
	return lang;
}

/** Runs one step of the export walk inside the export's own identity scope. */
type ExportScoped = <T>(work: () => Promise<T>) => Promise<T>;

/**
 * THE EXPORT'S OWN IDENTITY SCOPE — built ONCE per export from the explicit
 * `ExportGridContext`, entered around EVERY async step of the walk (the eager
 * gates + selection, each hydrate chunk, each record, the end line).
 *
 * Per step, not once: `lines` is an async generator, and a generator body runs
 * in the async context of whoever calls `next()` — for the NDJSON stream that
 * is the response pump, after dispatch's scope may be gone. Entering the scope
 * per step makes the answer independent of the puller.
 *
 * The scope carries the three ambient backstops the walk reads (see
 * `ExportGridContext`): both langs (`runWithRequestLangs`) and a request
 * context whose principal is the EXPORT's. When the caller names the request
 * it serves (`enclosingRequest`) that request's session/request id/client ip
 * are copied over (nothing on the walk reads them for output, and leaf logging
 * keeps its correlation id); otherwise they are empty, exactly what the
 * backstops answer outside a request.
 *
 * Frontier refusals noted inside the scope land on the export's own context
 * object; after each step the new ones are copied to `enclosingRequest` (when
 * given), so the request envelope's notice is unchanged. The AMBIENT request
 * context is never read here (see `ExportGridRunOptions.enclosingRequest`).
 */
function createExportScope(
	context: ExportGridContext,
	dataLang: string,
	outer: RequestContext | undefined,
): { scoped: ExportScoped; frontierRefusals: readonly FrontierRefusal[] } {
	const refusals: FrontierRefusal[] = [];
	const own: RequestContext = {
		principal: context.principal,
		session: outer?.session ?? null,
		requestId: outer?.requestId ?? '',
		clientIp: outer?.clientIp ?? '',
		frontierRefusals: refusals,
	};
	const langs = { applicationLang: context.applicationLang, dataLang };
	let forwarded = 0;
	const forward = (): void => {
		if (outer === undefined || forwarded >= refusals.length) {
			forwarded = refusals.length;
			return;
		}
		if (outer.frontierRefusals === undefined) outer.frontierRefusals = [];
		outer.frontierRefusals.push(...refusals.slice(forwarded));
		forwarded = refusals.length;
	};
	const scoped: ExportScoped = async (work) => {
		try {
			return await runWithRequestContext(own, () => runWithRequestLangs(langs, work));
		} finally {
			forward();
		}
	};
	return { scoped, frontierRefusals: refusals };
}

/** How the declaration gate reports a refused column. */
export interface ExportDeclarationGateOptions {
	/**
	 * Record each refusal in the export's frontier log (the BUILD does, so the
	 * refusal travels with the run). A later RE-CHECK of a finished export
	 * passes false: its refusal is an answer, not a narrowed walk.
	 */
	noteRefusals?: boolean;
}

/**
 * THE EXPORT DECLARATION GATE — what an export ASKS FOR, authorized before a
 * single record is read: Gate A (every SQO target section) + Gate B (every
 * declared ddo path segment, on its (section, component) grant) + the
 * `dedalo_raw` dataframe columns. Global admins are exempt. Throws
 * `perm.denied`, fail closed.
 *
 * ONE function, called by `openExportGrid` (the build) AND by every later
 * re-check of a finished export (tool_export's export_job.ts
 * exportStillReadable — preview, file build, listing, download), so the
 * re-check can never be stricter or looser than the gate that let the build
 * through.
 */
export async function assertExportDeclarationReadable(
	principal: Principal,
	options: Record<string, unknown>,
	gate: ExportDeclarationGateOptions = {},
): Promise<void> {
	if (principal.isGlobalAdmin) return;
	const sectionTipo = String(options.section_tipo ?? options.tipo ?? '');
	const rawFormat = String(options.data_format ?? 'value');
	const dataFormat = ['value', 'grid_value', 'dedalo_raw'].includes(rawFormat)
		? rawFormat
		: 'value';
	const exportDdos = Array.isArray(options.ar_ddo_to_export)
		? (options.ar_ddo_to_export as ExportDdoInput[])
		: [];
	const sqoInput = (options.sqo ?? { section_tipo: [sectionTipo] }) as Record<string, unknown>;
	const sqo = sanitizeClientSqo(structuredClone(sqoInput));
	// TOOLS-02 (2026-07-28 audit): the tool gate checked read (>=1) on the
	// DECLARED options.section_tipo only, but the export READS whatever
	// options.sqo targets and emits whatever ddo PATHS are requested — sections
	// and components the caller may not read (dd128 users → dd133 password
	// hashes; dd996 API keys; neither is projects-gated, so buildSearchSql does
	// not narrow them). Re-apply the read path's authorization (dd_core_api Gate
	// A + Gate B): every SQO target section AND every exported ddo-path component
	// must be readable by the principal. Fail CLOSED. Global admins are exempt.
	//
	// SEC-01 (2026-08-26 audit, which RE-OPENED TOOLS-02): the per-segment half
	// below now NORMALIZES the declared shape through resolveDeclaredTipo and
	// REFUSES a segment it cannot resolve. It used to run only inside
	// `typeof seg.section_tipo === 'string' && typeof seg.component_tipo === 'string'`,
	// so every other shape — absent, null, ARRAY — was silently SKIPPED past a
	// gate the resolver then ignored.
	const note = (refusal: FrontierRefusal): void => {
		if (gate.noteRefusals !== false) noteFrontierRefusal(exportScope, refusal);
	};
	const exportScope: FrontierScope = {
		principal,
		surface: 'export',
		door: 'tool_export',
	};
	for (const targetSectionTipo of getSectionTipos(
		sqo as unknown as Parameters<typeof getSectionTipos>[0],
	)) {
		if ((await getPermissions(principal, targetSectionTipo, targetSectionTipo)) < 1) {
			throw new DedaloError('perm.denied', {
				coordinates: { tool: 'tool_export', section_tipo: targetSectionTipo },
			});
		}
	}
	for (const ddo of exportDdos) {
		// A non-array `path` carries no segment — the same reading
		// compileExportPlan takes, so the gate and the compiler agree on what
		// a ddo declares (a path-less ddo compiles to an empty chain and the
		// buildEntries record guard emits nothing for it).
		const declaredPath = Array.isArray(ddo?.path) ? ddo.path : [];
		for (const rawSegment of declaredPath) {
			// The gate authorizes the segment's NORMALIZED twin — the pair the
			// consumers below will resolve — never the raw declared fields.
			const seg = {
				section_tipo: resolveDeclaredTipo(rawSegment?.section_tipo),
				component_tipo: resolveDeclaredTipo(rawSegment?.component_tipo),
			};
			// SEC-01. An UNRESOLVABLE segment is REFUSED, never skipped: the
			// resolver below walks the declared path whatever the gate could
			// read off it, so "I cannot tell which (section, component) this
			// segment names" is the one answer that must not mean "emit it".
			if (seg.section_tipo === null || seg.component_tipo === null) {
				throw new DedaloError('perm.denied', {
					message: `tool_export: a ddo path segment names no resolvable (section_tipo, component_tipo) pair — section_tipo=${JSON.stringify(rawSegment?.section_tipo ?? null)}, component_tipo=${JSON.stringify(rawSegment?.component_tipo ?? null)}`,
					coordinates: {
						tool: 'tool_export',
						section_tipo: seg.section_tipo ?? '',
						tipo: seg.component_tipo ?? '',
					},
				});
			}
			// GATE B IS THE DECLARATION GATE, and it is DELIBERATELY STRICTER
			// than the frontier predicate (frontier_scope.ts): it answers "may
			// this caller ASK for this column", not "may this walk cross into
			// that record". The frontier's globally-visible exemptions exist for
			// the hops the ENGINE mints (a component_filter's sort path into the
			// projects section, which no profile grants and which the caller
			// never typed); a COLUMN the user declared is refused on the bare
			// grant, exactly as before. The distinction is stated in
			// frontier_scope.ts and pinned by human_write_scope_tripwire's
			// TOOLS-02 assertion, which names this call.
			if ((await getPermissions(principal, seg.section_tipo, seg.component_tipo)) < 1) {
				note({
					surface: 'export',
					door: 'tool_export',
					sectionTipo: seg.section_tipo,
					componentTipo: seg.component_tipo,
					key: 'component',
				});
				throw new DedaloError('perm.denied', {
					coordinates: {
						tool: 'tool_export',
						section_tipo: seg.section_tipo,
						tipo: seg.component_tipo,
					},
				});
			}
		}
		// THE dedalo_raw DATAFRAME COLUMNS (2026-08-28). In that format
		// buildEntries mints and FILLS one raw cell per
		// `getDataframeChildTipos(topComponent)` frame — real components, with
		// their own stored data, that appear in NO ddo path and therefore never
		// reached Gate B. They are authorized HERE, once per run, on the same
		// key: a caller who may not read the frame component may not receive a
		// column of its data because the main component happened to be
		// exportable.
		if (dataFormat === 'dedalo_raw') {
			const firstSegment = declaredPath[0];
			const topSection = resolveDeclaredTipo(firstSegment?.section_tipo);
			const topComponent = resolveDeclaredTipo(firstSegment?.component_tipo);
			if (topSection !== null && topComponent !== null) {
				for (const frameTipo of await getDataframeChildTipos(topComponent)) {
					// The SAME declaration gate as the segments above — a frame is
					// a declared column of this export, just one the tool UI cannot
					// spell, so it is authorized on the bare grant too.
					if ((await getPermissions(principal, topSection, frameTipo)) >= 1) {
						continue;
					}
					note({
						surface: 'export',
						door: 'tool_export',
						sectionTipo: topSection,
						componentTipo: frameTipo,
						key: 'component',
					});
					throw new DedaloError('perm.denied', {
						message: `tool_export: dedalo_raw would emit the dataframe column ${topSection}.${frameTipo} of ${topSection}.${topComponent}, which this caller holds no read grant on`,
						coordinates: {
							tool: 'tool_export',
							section_tipo: topSection,
							tipo: frameTipo,
						},
					});
				}
			}
		}
	}
}

/**
 * Open the export grid through the unified engine (see module doc) — the ONE
 * producer every export form consumes: the tool's NDJSON stream and buffered
 * envelope (`exportGridUnified`) and, outside any request, a background job.
 *
 * Everything that can REFUSE runs here, eagerly, before the first line: option
 * validation, the TOOLS-02/SEC-01 read gates (Gate A + Gate B + the dedalo_raw
 * dataframe columns) and the record selection. A caller therefore sees a
 * refusal as a rejected promise, never as a half-written stream.
 *
 * Identity comes ONLY from `context` — every step runs inside the export's
 * own scope (`createExportScope`), never the caller's ambient one.
 */
export async function openExportGrid(
	context: ExportGridContext,
	runOptions: ExportGridRunOptions = {},
): Promise<OpenedExportGrid> {
	const { scoped, frontierRefusals } = createExportScope(
		context,
		exportLangOf(context.options),
		runOptions.enclosingRequest,
	);
	const opened = await scoped(() => openExportGridInScope(context, runOptions, scoped));
	return { ...opened, frontierRefusals };
}

/** `openExportGrid`'s body — runs inside the export scope (`scoped`). */
async function openExportGridInScope(
	context: ExportGridContext,
	runOptions: ExportGridRunOptions,
	scoped: ExportScoped,
): Promise<Omit<OpenedExportGrid, 'frontierRefusals'>> {
	const { options } = context;
	const signal = runOptions.signal;
	const hydrateBatch =
		Number.isInteger(runOptions.hydrateBatch) && (runOptions.hydrateBatch as number) > 0
			? (runOptions.hydrateBatch as number)
			: HYDRATE_BATCH;
	const sectionTipo = String(options.section_tipo ?? options.tipo ?? '');
	if (sectionTipo === '') {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'options.section_tipo is required',
		});
	}
	// PHP validates both against fixed sets and FALLS BACK (never errors).
	const rawFormat = String(options.data_format ?? 'value');
	const dataFormat = ['value', 'grid_value', 'dedalo_raw'].includes(rawFormat)
		? rawFormat
		: 'value';
	const rawBreakdown = String(options.breakdown ?? 'default');
	const breakdown = ['default', 'rows', 'columns'].includes(rawBreakdown)
		? rawBreakdown
		: 'default';
	const fillTheGaps = options.fill_the_gaps !== false; // PHP default true
	const exportDdos = Array.isArray(options.ar_ddo_to_export)
		? (options.ar_ddo_to_export as ExportDdoInput[])
		: [];
	const lang = exportLangOf(options);

	// Stage B: the export column set compiles through the SHARED plan compiler
	// front-end (one FieldPlan per ddo, ordinals = user DOM order). WC-049: the
	// parents flag is PER-DDO (ar_ddo_to_export[].value_with_parents) — the PHP
	// request-global options.value_with_parents is deliberately ignored.
	const plan = await compileExportPlan(exportDdos, sectionTipo);
	const fields = plan.sections[0]?.fields ?? [];
	const run = createExportRun();
	if (runOptions.captureMedia === true) run.captureMedia = true;
	// THE EXPORT FRONTIER (SEC-01's larger half). Gate B below authorizes the
	// DECLARED ddo path segments; this scope authorizes the RUNTIME records the
	// walk actually reaches through stored locators — a locator may name another
	// section entirely, and resolveRecordAtoms followed it with no principal at
	// all until 2026-08-28. Global admins carry no scope (unscoped, as
	// everywhere else in this tool); every internal user of the same walk passes
	// no scope and is byte-unchanged.
	if (!context.principal.isGlobalAdmin) {
		run.atoms.frontier = {
			principal: context.principal,
			surface: 'export',
			door: 'tool_export',
		};
	}

	// Stage C: the export serializes the FULL filtered selection (PHP forces
	// limit ALL). The standard assembler applies the identifier chokepoint +
	// (for non-admins) the projects filter through the caller's principal.
	const sqoInput = (options.sqo ?? { section_tipo: [sectionTipo] }) as Record<string, unknown>;
	const sqo = sanitizeClientSqo(structuredClone(sqoInput));
	sqo.limit = null as unknown as number; // ALL
	sqo.offset = 0;

	// The declaration gate (TOOLS-02 Gate A + Gate B + the dedalo_raw frames) —
	// ONE function, shared with every re-check of a finished export.
	await assertExportDeclarationReadable(context.principal, options);

	const builtSelection = await buildSearchSql(sqo, {
		principal: context.principal.isGlobalAdmin ? undefined : context.principal,
		// The export reads only the selection identity here (per-record data
		// loads ride the run cache) — skip the ten wide jsonb columns.
		idsOnly: true,
	});

	const unresolved: string[] = [];

	// External sources (external_prefetch.ts): the degradation log every
	// component_external cell reports to, and the per-batch prefetch that parks
	// the batch's remote rows on the run's own emission scratch. The prediction
	// is plan-static (compiled once); dedalo_raw reads no external value.
	const degradation = createExternalDegradationLog();
	const externalEmission = new EmissionContext();
	run.cellOpts.externalEmission = externalEmission;
	run.cellOpts.onExternalDegraded = (event) => degradation.note(event);
	const externalPlan: ExternalPrefetchPlan =
		dataFormat === 'dedalo_raw'
			? { demands: [], fieldsOf: new Map() }
			: await planExternalPrefetch(fields);

	// THE SELECTION (PERF-1): the LAST eager step — every refusal that does not
	// need it has run — so a cursor is only opened for an export that will run.
	// From here on the cursor is owned by `lines` (closingLines below).
	const selectionPage =
		Number.isInteger(runOptions.selectionPage) && (runOptions.selectionPage as number) > 0
			? (runOptions.selectionPage as number)
			: SELECTION_PAGE;
	const cursor = await openSelectionCursor<SelectedRecord>(
		{ sql: builtSelection.sql, params: builtSelection.params },
		{
			pageRows: Math.max(selectionPage, hydrateBatch),
			signal,
			admission: runOptions.selectionAdmission ?? 'refuse',
			...(runOptions.selectionIdleMs === undefined ? {} : { idleMs: runOptions.selectionIdleMs }),
		},
	);

	const meta: Record<string, unknown> = {
		t: 'meta',
		v: 1,
		data_format: dataFormat,
		breakdown,
		fill_the_gaps: options.fill_the_gaps ?? true,
		section_tipo: sectionTipo,
		total: cursor.total,
	};

	const tabulator = createTabulator({ dataFormat, breakdown, fillTheGaps, lang });

	/** One record's entries (PHP get_record_atoms), per data format. */
	const buildEntries = async (record: {
		section_id: number;
		section_tipo: string;
	}): Promise<RecordEntry[]> => {
		const entries: RecordEntry[] = [];
		degradation.beginRecord(record.section_tipo, record.section_id);
		for (const field of fields) {
			const ddoIndex = field.exportColumn?.ordinal ?? 0;
			const path = (field.exportColumn?.path ?? []) as RawPathStep[];
			const firstStep = path[0] ?? {};
			const firstSection = String(
				Array.isArray(firstStep.section_tipo)
					? (firstStep.section_tipo[0] ?? '')
					: (firstStep.section_tipo ?? ''),
			);
			const topComponent = String(firstStep.component_tipo ?? '');
			// PHP get_record_atoms guard: skip ddos that are not direct children
			// of this row's section (multi-section sqo rows).
			if (topComponent === '' || firstSection !== record.section_tipo) continue;
			const topKey = `${firstSection}_${topComponent}`;

			if (dataFormat === 'grid_value') {
				const droppedMedia: MediaReadAddress[] | undefined =
					run.captureMedia === true ? [] : undefined;
				const atoms = await collectGridAtoms(
					run,
					field,
					record.section_tipo,
					Number(record.section_id),
					lang,
					unresolved,
					undefined,
					droppedMedia,
				);
				entries.push({
					kind: 'grid',
					ddoIndex,
					atoms,
					...(droppedMedia !== undefined && droppedMedia.length > 0 ? { droppedMedia } : {}),
				});
				continue;
			}

			const topModel = (await getModelByTipo(topComponent)) ?? String(firstStep.model ?? '');
			if (dataFormat === 'dedalo_raw') {
				entries.push({
					kind: 'raw',
					ddoIndex,
					topKey,
					ownSegment: {
						section_tipo: firstSection,
						component_tipo: topComponent,
						model: topModel,
						item_index: null,
						section_id: null,
					},
					...(await buildRawCell(run, record, topComponent, topModel)),
					topModel,
					...(run.captureMedia === true
						? {
								// the DECLARED ddo's reads, as the value format makes them
								media: await collectRawMediaAddresses(
									run,
									field,
									record.section_tipo,
									record.section_id,
								),
							}
						: {}),
				});
				// The component's dataframe slots ride along as their OWN columns
				// (WC-2026-08-09-export-raw-dataframe-own-column): separate
				// components, separate stored data, one column each — headed by the
				// frame tipo, so the import maps them like any other component and
				// the `id_key` locator re-pairs them with the main's items.
				// Ontology-driven (children of model component_dataframe), so the
				// column set is the same for every record of the run, framed or not
				// — and dedalo_raw stays a LOSSLESS dump: the tool UI cannot declare
				// a dataframe step itself (atoms.ts hasDeclaredDataframeStep), so
				// without this the frames would leave no column at all.
				for (const frameTipo of await getDataframeChildTipos(topComponent)) {
					entries.push({
						kind: 'raw',
						ddoIndex,
						topKey: `${firstSection}_${frameTipo}`,
						ownSegment: {
							section_tipo: firstSection,
							component_tipo: frameTipo,
							model: 'component_dataframe',
							item_index: null,
							section_id: null,
						},
						...(await buildRawCell(run, record, frameTipo, 'component_dataframe')),
						topModel: 'component_dataframe',
						// No media capture here: the value format has no frame column,
						// and the frames the top relation's config shows are already
						// read through it (collectRawMediaAddresses) — capturing the
						// slot too would archive what the same ddo in value never reads.
					});
				}
				continue;
			}

			const lastStep = path[path.length - 1] ?? {};
			const leafTipo = String(lastStep.component_tipo ?? '');
			const leafModel = (await getModelByTipo(leafTipo)) ?? String(lastStep.model ?? '');
			// WC-049 value format (addendum 2026-09-25): the per-ddo parents flag
			// grows a sibling chain cell, built IN the term cell's own fold so it
			// mirrors the term cell's structure (atoms.ts ValueCells).
			const withParents = fieldHasValueParents(field, leafModel);
			let flat: string | null;
			let media: MediaReadAddress[] | undefined;
			let parentsFlat: string | null = null;
			if (run.captureMedia === true || withParents) {
				// (a non-capturing run reads no media: `media` comes back empty)
				({
					flat,
					media,
					parents: parentsFlat,
				} = await resolveValueCellWithMedia(
					run,
					field,
					record.section_tipo,
					Number(record.section_id),
					lang,
					unresolved,
					withParents,
				));
			} else {
				flat = await resolveValueCell(
					run,
					field,
					record.section_tipo,
					Number(record.section_id),
					lang,
					unresolved,
				);
			}
			// Column LABEL segments (PHP export_tabulator :295-302: with atoms the
			// value column's path is atoms[0]->path — the declared chain EXTENDED by
			// the fan-out segments, e.g. 'Denominación | Término'). TS's value cells
			// join through resolveValueCell instead of atoms, so derive the label
			// chain from the first grid atom only when the leaf fans out.
			let labelSegments: ExportSegment[] | undefined;
			if (flat !== null && getColumnNameByModel(leafModel) === 'relation') {
				const labelAtoms = await collectGridAtoms(
					run,
					field,
					record.section_tipo,
					Number(record.section_id),
					lang,
					[], // label derivation never adds unresolved notes
					false, // parents OFF — a '#parents' atom must never head the label chain
				);
				labelSegments = labelAtoms[0]?.segments;
			}
			const parents = withParents ? { flat: parentsFlat } : undefined;
			entries.push({
				kind: 'value',
				ddoIndex,
				topKey,
				declaredPath: path,
				labelSegments,
				flat,
				leafModel,
				topModel,
				...(media !== undefined && media.length > 0 ? { media } : {}),
				...(parents !== undefined ? { parents } : {}),
			});
		}
		return entries;
	};

	/**
	 * The single protocol-line producer EVERY form consumes: meta, interleaved
	 * col/row lines (col lines precede the first row that uses them — new
	 * columns can mint on ANY record), then the 'end' line (authoritative
	 * display order). It retains nothing it yields: buffering, if any, is the
	 * consumer's choice (exportGridUnified's buffered form), so a streaming or
	 * spooling consumer holds at most one record's lines however large the
	 * selection. Every async step runs in the export scope (`scoped`).
	 *
	 * RELEASE needs no `finally` here — it is structural, ONE path per way out
	 * (export_selection_cursor_native legs 5, 5b, 5c, 13):
	 *   - exhaustion: the empty FETCH closes the cursor (selection_cursor.ts);
	 *   - a consumer's `return()` / `throw()`: closingLines closes first;
	 *   - a PRODUCER failure (a hydration statement, external prefetch,
	 *     tabulation): the `for await` over hydrateChunks — and hydrateChunks'
	 *     own `for await` over `cursor.pages` — call `return()` on the way out,
	 *     and `pages.return()` closes; a failing FETCH closes inside `pages`.
	 * A second, redundant close here masked a regression of either path (both
	 * mutations stayed green); without it, each is the gated one.
	 */
	async function* protocolLines(): AsyncGenerator<Record<string, unknown>> {
		yield meta;
		for await (const chunk of hydrateChunks(cursor, hydrateBatch)) {
			// Cooperative cancellation at the batch boundary: stop BEFORE hydrating
			// the next chunk, and emit no 'end' — its absence is the abort signal.
			if (signal?.aborted === true) return;
			// Bulk-hydrate the chunk's OWN records (one ANY(int[]) query per
			// section per chunk) so the per-record walk below hits the run cache
			// instead of lazy-loading each exported row one SELECT at a time.
			// Emission order is untouched — this is hydration, not selection.
			const idsBySection = new Map<string, (number | string)[]>();
			for (const record of chunk) {
				const ids = idsBySection.get(record.section_tipo);
				if (ids === undefined) idsBySection.set(record.section_tipo, [record.section_id]);
				else ids.push(record.section_id);
			}
			await scoped(async () => {
				for (const [chunkSectionTipo, ids] of idsBySection) {
					await prefetchExportRecords(run.atoms, chunkSectionTipo, ids);
				}
				// ... and the chunk's REMOTE rows, in one bounded fan-out, so no
				// external cell of the chunk fetches live per record.
				await prefetchExternalRowsForBatch(
					run.atoms,
					externalPlan,
					chunk,
					lang,
					externalEmission,
					signal,
				);
			});
			for (const record of chunk) {
				// ... and at EVERY record boundary: a chunk of heavy records (deep
				// relation columns) can take minutes, and a Stop / a shutdown must
				// not wait for it — the export lane (budget 1) is held meanwhile.
				// Same protocol: no 'end' line, so the consumer sees the abort; a
				// record's lines are yielded whole or not at all. (Read through a
				// call: the signal flips between yields, which TS's narrowing of
				// the batch check above cannot know.)
				if (abortedNow(signal)) return;
				// One record = one scoped step (its lines are the tabulator's
				// per-record array, so scoping here buffers nothing new).
				const recordLines = await scoped(async () =>
					tabulator.recordLines(await buildEntries(record), String(record.section_id)),
				);
				for (const line of recordLines) {
					yield line;
				}
			}
		}
		// An abort also CLOSES the cursor (selection_cursor.ts), which ends the
		// pages early — a truncated selection must not read as a finished one.
		if (abortedNow(signal)) return;
		yield await scoped(async () => {
			const end = tabulator.endLine();
			// The marker travels ONLY when something degraded: a clean export's
			// 'end' line (and so the stream, the spool and the NDJSON file) is
			// byte-identical to before.
			const degraded = degradation.snapshot();
			if (degraded !== null) end.external_degraded = degraded;
			return end;
		});
	}

	return {
		meta,
		lines: closingLines(protocolLines(), cursor),
		unresolved,
		frontierGrants: run.atoms.frontierGrants,
		externalDegradation: () => degradation.snapshot(),
	};
}

/** One selected record — the identity the walk hydrates. */
interface SelectedRecord {
	section_id: number;
	section_tipo: string;
}

/**
 * The selection's pages re-cut into hydrate chunks of exactly `hydrateBatch`
 * records (the last one shorter), ACROSS page boundaries — so the chunks are
 * the ones the whole-array slicing produced, whatever the page size.
 */
async function* hydrateChunks(
	cursor: SelectionCursor<SelectedRecord>,
	hydrateBatch: number,
): AsyncGenerator<SelectedRecord[]> {
	let pending: SelectedRecord[] = [];
	for await (const page of cursor.pages) {
		pending = pending.length === 0 ? page : pending.concat(page);
		while (pending.length >= hydrateBatch) {
			yield pending.slice(0, hydrateBatch);
			pending = pending.slice(hydrateBatch);
		}
	}
	if (pending.length > 0) yield pending;
}

/**
 * `lines` as handed out: the producer, plus the cursor's release on `return()`
 * / `throw()`. A generator that never started runs no `finally` when it is
 * returned, so the producer's own try/finally cannot release a cursor whose
 * consumer gave up before the first pull (export_job's createJob failure, a
 * stream cancelled before its first chunk) — this wrapper does, then delegates.
 *
 * It also drives the cursor's CONSUMER-IDLE window (selection_cursor.ts): the
 * window stops when the consumer pulls a line and restarts when the line is
 * handed back, so only the time control sits with the consumer counts — never
 * the producer's hydration of a page, however long.
 */
function closingLines(
	inner: AsyncGenerator<Record<string, unknown>>,
	cursor: SelectionCursor<SelectedRecord>,
): AsyncGenerator<Record<string, unknown>> {
	const wrapper = {
		async next(...args: [] | [unknown]) {
			cursor.consumerWaiting(false);
			try {
				return await inner.next(...args);
			} finally {
				cursor.consumerWaiting(true);
			}
		},
		async return(value?: unknown) {
			await cursor.close();
			return inner.return(value as never);
		},
		async throw(error?: unknown) {
			await cursor.close();
			return inner.throw(error);
		},
		[Symbol.asyncIterator]() {
			return wrapper;
		},
	};
	return wrapper as unknown as AsyncGenerator<Record<string, unknown>>;
}

/** Whether `signal` has fired — read fresh at each call (see protocolLines). */
function abortedNow(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/**
 * tool_export's get_export_grid through the unified engine — a THIN user of
 * `openExportGrid`: the NDJSON stream serializes its lines as they come; the
 * buffered envelope drains the same generator into meta/columns/rows/end.
 */
export async function exportGridUnified(context: ToolActionContext): Promise<ToolResponse> {
	const wantStream = context.options.ndjson_stream === true;
	// The interface lang is SNAPSHOTTED here, at the request chokepoint (the
	// tool handler runs inside dispatchRqo's lang scope), and handed over
	// explicitly — the stream may be pulled after that scope is gone.
	const grid = await openExportGrid(
		{
			principal: context.principal,
			options: context.options,
			applicationLang: currentApplicationLang(),
		},
		// THIS request's envelope carries the narrowing notice: named explicitly
		// (the producer never forwards into an ambient context).
		{ enclosingRequest: currentRequestContext() },
	);

	if (wantStream) {
		// NDJSON protocol (PHP stream_export_grid) through the outcome.stream
		// seam (S2-34): bytes leave as each line is produced.
		// `stream` / `streamContentType` are EXTENSION KEYS (ERRORS_SPEC §3): the
		// dd_tools_api handler reads them off the top level to hand the bytes to
		// the outcome.stream seam, so they must not live inside `data`.
		return ok(null, {
			requestId: toolRequestId(context),
			extend: {
				stream: ndjsonStream(grid.lines, 'diffusion/export'),
				streamContentType: 'application/x-ndjson; charset=utf-8',
			},
		});
	}

	// Buffered form: ONE CEILING LAW (DEC-07). The envelope holds the whole grid
	// in memory, so a selection above the client ceiling is refused BEFORE any
	// hydration — `export.format_limit` (the same selection fits the NDJSON
	// stream and the background artifact, which never buffer it). The total is
	// the cursor snapshot's exact count, known at open.
	if (Number(grid.meta.total) > CLIENT_MAX_LIMIT) {
		await grid.lines.return(undefined);
		throw new DedaloError('export.format_limit', {
			message: `get_export_grid: the buffered envelope holds at most CLIENT_MAX_LIMIT=${CLIENT_MAX_LIMIT} records (selection: ${String(grid.meta.total)}); use the NDJSON stream or a background export`,
			details: { format: 'json_envelope', limit: CLIENT_MAX_LIMIT },
		});
	}
	// Drain the SAME generator, sorting its lines into the envelope's buckets
	// (meta is `grid.meta`; the producer yields col/row lines between it and
	// 'end').
	const columns: Record<string, unknown>[] = [];
	const rows: Record<string, unknown>[] = [];
	let endLineOut: Record<string, unknown> | null = null;
	for await (const line of grid.lines) {
		if (line === grid.meta) continue;
		if (line.t === 'end') endLineOut = line;
		else if (line.t === 'col') columns.push(line);
		else rows.push(line);
	}
	// `unresolved` (cell models the resolver had no atom for) is a NON-FATAL fact
	// about the payload, so it travels INSIDE `data` — the legacy body smuggled it
	// through `errors[]` on an otherwise successful response.
	const unresolved = grid.unresolved;
	return ok(
		{
			meta: grid.meta,
			columns,
			rows,
			end: endLineOut,
			...(unresolved.length === 0 ? {} : { unresolved }),
		},
		{ requestId: toolRequestId(context) },
	);
}

/**
 * dedalo_raw cell of ONE component (PHP get_raw_export_value: raw export does
 * NOT recurse — the component's own stored slice, `{"dedalo_data": <slice>}`
 * wrapped; component_section_id stays a plain int, the re-import record key).
 *
 * ONE component, ONE cell (WC-2026-08-09-export-raw-dataframe-own-column):
 * a component_dataframe slot is a component with its OWN stored data, so it
 * gets its OWN column through this same function — it is never folded into
 * the main component's cell. The frame locator's `id_key` is what pairs it
 * back to the main's item on import; nothing about that pairing needs the two
 * to share a cell.
 */
async function buildRawCell(
	run: ExportRun,
	record: { section_id: number; section_tipo: string },
	componentTipo: string,
	model: string,
): Promise<{ raw: string | number | null; cellType: string }> {
	if (model === 'component_section_id') {
		return { raw: Number(record.section_id), cellType: 'section_id' };
	}
	const stored = await loadExportRecord(run.atoms, record.section_tipo, Number(record.section_id));
	const column = getColumnNameByModel(model);
	if (column === null) return { raw: null, cellType: 'json' };
	const raw = (stored?.columns[column as never] as unknown as Record<string, unknown> | null)?.[
		componentTipo
	];
	if (raw === undefined || raw === null) return { raw: null, cellType: 'json' };
	return { raw: JSON.stringify({ dedalo_data: raw }), cellType: 'json' };
}
