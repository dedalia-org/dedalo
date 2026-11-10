/**
 * CSV import EXECUTOR — apply a plan (import_csv.ts) to the database.
 *
 * PHP does this row by row, component by component, each save its own
 * transaction, and asks the DB "does this record exist?" once per row. This
 * executor keeps the semantics and changes the shape:
 *
 *   - ONE existence query per FILE (`readExistingSectionIds`), not one per row;
 *   - ONE transaction per ROW (withTransaction JOINS an ambient transaction, so
 *     every saveComponentData inside a row shares it). A row is therefore
 *     ALL-OR-NOTHING: a crash mid-row cannot leave half a record written. For a
 *     30-column file that is 1 transaction per row instead of 30.
 *
 * Metadata columns (dd199/dd200/dd197/dd201) get PHP's dual write: the audit
 * component AND the record's own `data`-column metadata, with the modified stamp
 * suppressed so the imported values survive the save that carries them.
 *
 * APPEND MODE (per column, `PlannedColumn.mode`, plan §5). An append column's
 * cell is ADDED to the stored items through the engine's server-only
 * `SaveRequest.appendImport` (the merge runs inside saveComponentData, under
 * its FOR UPDATE lock). An empty cell / empty lang group is a NO-OP, never a
 * clear. Each row runs in TWO PASSES: the main columns first, then the
 * dataframe slot columns + legacy envelope frames — so a frame's `id_key`
 * (a FILE item id) can be re-paired through the main save's `appendedIdMap`
 * whatever the column order. A frame whose main item this row did not import
 * FAILS the row. Rows that repeat a section_id accumulate values. Duplicates
 * are skipped and reported per cell ("N already present, not added").
 */

import { getImportAppendPolicy, isDerivedModel } from '../components/registry.ts';
import { AUDIT_TIPOS } from '../concepts/section.ts';
import { DATAFRAME_RELATION_TYPE } from '../concepts/subdatum.ts';
import { type MatrixJsonbColumn, readExistingSectionIds } from '../db/matrix.ts';
import {
	absorbComponentItemIds,
	allocateComponentItemId,
	readMatrixKeyForUpdate,
} from '../db/matrix_write.ts';
import { withTransaction } from '../db/postgres.ts';
import { DedaloError, isDedaloError } from '../errors/index.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	savesInRequestLang,
} from '../ontology/resolver.ts';
import {
	isEmptyLiteralItem,
	type LiteralEqualityFamily,
	literalDuplicateIds,
	literalEqualityFamilyOf,
} from '../section/record/append_merge.ts';
import { bornInCurrentTransaction, createSectionRecord } from '../section/record/create_record.ts';
import {
	metadataPatchFromAuditValue,
	type RecordMetadataPatch,
	setRecordMetadata,
} from '../section/record/record_metadata.ts';
import {
	isLangSlicedModel,
	type SaveResult,
	saveComponentData,
} from '../section/record/save_component.ts';
import type { Principal } from '../security/permissions.ts';
import {
	authorizeRecordAccess,
	authorizeSectionTarget,
	type FrameOf,
} from '../security/write_door.ts';
import type { PlannedColumn, PlannedRecord } from './import_csv.ts';
import { groupItemsByLang } from './import_data.ts';
import type { ImportFileReport, ImportProgressFrame, ImportRowIssue } from './import_wire.ts';

/**
 * saveComponentData, with its REFUSAL honoured.
 *
 * The write engine answers `{ok:false, message}` for a refusal it wants the
 * caller to surface — ONT-TLD (`ontology7` is derived, not typed),
 * consultation-only sections, an incomplete dataframe pairing. Every call site
 * here used to `await` and discard that, so a file whose column the engine
 * refused was reported as "N updated, 0 failed" while nothing was written.
 *
 * Throwing is right at THIS door specifically: each row already runs inside one
 * transaction with a catch that rolls it back and records an ImportRowIssue
 * (see the row loop below), so a refusal lands in the operator's report with its
 * message intact and the record is left exactly as it was — instead of a row
 * half-written from the columns that happened to precede the refused one.
 */
async function saveOrRefuse(request: Parameters<typeof saveComponentData>[0]): Promise<SaveResult> {
	const outcome = await saveComponentData(request);
	if (outcome.ok === false) {
		throw new DedaloError('record.save_failed', {
			message: `save refused for '${request.componentTipo}': ${outcome.message}`,
			coordinates: { tipo: request.componentTipo },
		});
	}
	return outcome;
}

export interface CsvExecuteRequest {
	plan: PlannedRecord[];
	sectionTipo: string;
	/**
	 * The importing PRINCIPAL (closure Step 3 req 10): every row's create and
	 * every column's component is asked of the write door as it — the file
	 * door's `section_list` gate named the section only. Its `userId` is the
	 * actor of every save.
	 */
	principal: Principal;
	/**
	 * The dd800 run every save is attributed to — the revert handle. Every save
	 * under it records its BEFORE/AFTER undo pair and a visible after-row
	 * (decision D1, WC bulk-revert-undo-log): an import has no TM opt-out.
	 */
	bulkProcessId: number;
	/** File-level errors accumulated before the plan (unmapped columns, …). */
	errors: string[];
	/** Read-time notices (an encoding conversion) — carried through, never merged
	 * into `errors`: the panel paints an error red, and a conversion is not one. */
	notices: string[];
	/** Progress context: what the panel shows while this runs. */
	progress: {
		file: string;
		fileIndex: number;
		filesTotal: number;
		/** Component label by tipo (pre-resolved: a progress tick must not hit the ontology). */
		labels: ReadonlyMap<string, string>;
		publish: (frame: ImportProgressFrame) => void;
	};
}

/** How often a progress frame may be published. Each one rewrites the job's pfile. */
const PROGRESS_THROTTLE_MS = 200;

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The `data`-column metadata this row's audit columns imply (PHP's
 * set_created_date / set_created_by_userID side of the metadata branches) —
 * derived by record_metadata.ts, which the bulk revert shares to put the twin
 * back in agreement with the audit component it restores.
 */
function metadataPatchFor(column: PlannedColumn): RecordMetadataPatch {
	return metadataPatchFromAuditValue(column.tipo, column.conform.result);
}

/** The model of a dataframe SLOT column (its cell holds frames, not main data). */
const DATAFRAME_MODEL = 'component_dataframe';

/** What every write of one row shares (the row runs in ONE transaction). */
interface RowWriteContext {
	table: string;
	sectionTipo: string;
	sectionId: number;
	userId: number;
	/** The importer, for the write door (req 10). */
	principal: Principal;
	/**
	 * The row CREATED its record: a column is asked as a section target, not a
	 * record. Seeded from the existence snapshot, then settled by the insert's
	 * real outcome (bornInCurrentTransaction) before any column is written.
	 */
	isNew: boolean;
	bulkProcessId: number;
	skipModifiedStamp: boolean;
	row: number;
	/** The file's warnings channel (IGNORED frames are reported as they arise). */
	warnings: ImportRowIssue[];
	/**
	 * This row's APPEND main saves: column tipo → file item id (String()) →
	 * final stored id. Pass 2 re-pairs frame `id_key`s through it.
	 */
	appendedIds: Map<string, Map<string, unknown>>;
	/**
	 * Main tipos that have an APPEND column in this row, whatever became of it
	 * (written, empty, or skipped on a conform error). A frame naming one of
	 * them pairs with a FILE item id and must re-pair through `appendedIds`.
	 */
	appendMains: ReadonlySet<string>;
	/** Duplicates skipped per CSV column tipo — reported only once the row COMMITTED. */
	skipped: Map<string, number>;
}

function addSkipped(ctx: RowWriteContext, reportTipo: string, count: number): void {
	if (count > 0) ctx.skipped.set(reportTipo, (ctx.skipped.get(reportTipo) ?? 0) + count);
}

/** A row-level refusal: thrown inside the row transaction, so the row rolls back. */
function rowRefusal(message: string, tipo: string): DedaloError {
	return new DedaloError('request.invalid_data', { message, coordinates: { tipo } });
}

/** One frame ready to write: its slot, its pairing (as read from the file), the entry. */
interface PendingFrame {
	slot: string;
	mainComponentTipo: string;
	/** The FILE's id_key (remapped through `appendedIds` on an append write). */
	idKey: unknown;
	frame: Record<string, unknown>;
}

/**
 * A LEGACY {data, dataframe} envelope's frames, parsed (PHP trait.dataframe_common::
 * import_dataframe_data). A frame without a slot (from_component_tipo) or a
 * pairing key, or whose slot is not a component_dataframe, is IGNORED and
 * reported — the same law for both write modes.
 */
async function parseLegacyFrames(
	frames: readonly unknown[],
	mainComponentTipo: string,
	ctx: RowWriteContext,
): Promise<PendingFrame[]> {
	const parsed: PendingFrame[] = [];
	for (const raw of frames) {
		if (!isObject(raw)) continue;
		const slot = raw.from_component_tipo;
		// `section_id_key` is the pre-v7 pairing key — still accepted on import.
		const idKey = raw.id_key ?? raw.section_id_key;
		if (typeof slot !== 'string' || slot === '' || idKey === undefined || idKey === null) {
			ctx.warnings.push({
				section_id: ctx.sectionId,
				component_tipo: mainComponentTipo,
				msg: 'IGNORED: dataframe frame without a slot (from_component_tipo) or a pairing key (id_key)',
				data: raw,
				row: ctx.row,
			});
			continue;
		}
		// The legacy pairing keys are dropped: v7 pairs on id_key alone.
		const { section_id_key: _legacyId, section_tipo_key: _legacyTipo, ...rest } = raw;
		const main = typeof raw.main_component_tipo === 'string' ? raw.main_component_tipo : null;
		parsed.push({
			slot,
			mainComponentTipo: main ?? mainComponentTipo,
			idKey,
			frame: rest,
		});
	}

	const slotModels = new Map<string, string | null>();
	const accepted: PendingFrame[] = [];
	// ONE warning per rejected SLOT (not per frame), its data the slot's frames
	// in their normalised shape — the report shape replace mode always had.
	const rejected = new Map<string, Record<string, unknown>[]>();
	for (const pending of parsed) {
		if (!slotModels.has(pending.slot)) {
			slotModels.set(pending.slot, await getModelByTipo(pending.slot));
		}
		if (slotModels.get(pending.slot) === DATAFRAME_MODEL) {
			accepted.push(pending);
			continue;
		}
		const group = rejected.get(pending.slot);
		if (group === undefined) rejected.set(pending.slot, [normalisedFrame(pending)]);
		else group.push(normalisedFrame(pending));
	}
	for (const [slot, group] of rejected) {
		ctx.warnings.push({
			section_id: ctx.sectionId,
			component_tipo: slot,
			msg: `IGNORED: dataframe frames target '${slot}', which is not a component_dataframe`,
			data: group,
			row: ctx.row,
		});
	}
	return accepted;
}

/**
 * A parsed frame as stored: type dd490, numeric id_key (the file's), its main.
 *
 * D19, FIXED 2026-08-09: the import wrote the literal 'dataframe', which no
 * reader recognises (isDataframeEntry/dataframeEntriesEqual test dd490), so an
 * imported frame was invisible in the widget AND was read as a real portal
 * edge by the `type !== 'dd490'` filters in save_component's observer diff and
 * delete_record's cascade. KNOWN-OPEN, stated rather than narrowed: frames
 * ALREADY written by a previous import still carry the literal 'dataframe' on
 * disk. They need a one-shot repair (rewrite type 'dataframe' → dd490 on
 * frames whose slot resolves component_dataframe); no migration ships here.
 */
function normalisedFrame(pending: PendingFrame): Record<string, unknown> {
	return {
		...pending.frame,
		type: DATAFRAME_RELATION_TYPE,
		id_key: Number(pending.idKey),
		main_component_tipo: pending.mainComponentTipo,
	};
}

/**
 * REPLACE write of a legacy envelope's frames: within each slot, the frames
 * of OTHER main components are preserved and only this component's are
 * replaced.
 *
 * The preserved frames are read UNDER THE ROW LOCK (`readMatrixKeyForUpdate`,
 * inside the row transaction; the save below re-locks the same row in the
 * same transaction) — an unlocked pre-read here let a concurrent save on the
 * slot land between the read and the write and be silently reverted.
 */
async function writeLegacyFramesReplace(
	pending: readonly PendingFrame[],
	mainComponentTipo: string,
	ctx: RowWriteContext,
): Promise<void> {
	const bySlot = new Map<string, Record<string, unknown>[]>();
	for (const frame of pending) {
		const entry = normalisedFrame(frame);
		const slot = frame.slot;
		const group = bySlot.get(slot);
		if (group === undefined) bySlot.set(slot, [entry]);
		else group.push(entry);
	}

	const column = getColumnNameByModel(DATAFRAME_MODEL) as MatrixJsonbColumn | null;
	for (const [slot, group] of bySlot) {
		// Keep the frames owned by OTHER main components; replace ours wholesale.
		let kept: unknown[] = [];
		if (column !== null) {
			const existing = await readMatrixKeyForUpdate(
				ctx.table,
				ctx.sectionTipo,
				ctx.sectionId,
				column,
				slot,
			);
			kept = (existing ?? []).filter(
				(item) => !isObject(item) || item.main_component_tipo !== mainComponentTipo,
			);
		}
		await saveOrRefuse({
			componentTipo: slot,
			sectionTipo: ctx.sectionTipo,
			sectionId: ctx.sectionId,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', id: null, value: [...kept, ...group] }],
			userId: ctx.userId,
			// A SLOT save with no caller pairing: it writes no history under the
			// slot — the engine records the COMPOSED row / undo pair of the main
			// the frames name (each carries main_component_tipo, normalisedFrame),
			// the main's data + every slot's frames after this write (D1).
			bulkProcessId: ctx.bulkProcessId,
			skipModifiedStamp: ctx.skipModifiedStamp,
		});
	}
}

/**
 * The final `id_key` of a frame on an APPEND write. When this row APPENDED
 * the frame's main component, the file's id_key names a FILE item id, which
 * the main save re-keyed: it is re-paired through that save's
 * `appendedIdMap` (a skipped duplicate maps to the EXISTING item's id). No
 * match FAILS the row — a frame paired to the wrong item, or to nothing, is
 * worse than a refused row — and that holds whether the main column wrote,
 * was empty, or failed conform (no map at all then: the frame's file id must
 * never fall through to a STORED item that happens to carry it). Only a main
 * with NO append column in the row keeps the id_key: it names a stored item.
 */
function pairedIdKey(pending: PendingFrame, ctx: RowWriteContext): number {
	let finalId: unknown = pending.idKey;
	if (ctx.appendMains.has(pending.mainComponentTipo)) {
		finalId = ctx.appendedIds.get(pending.mainComponentTipo)?.get(String(pending.idKey));
		if (finalId === undefined) {
			throw rowRefusal(
				`a dataframe frame in '${pending.slot}' pairs with item ${String(pending.idKey)} of '${pending.mainComponentTipo}', which this row's cell does not carry — the frame has no item to pair with`,
				pending.slot,
			);
		}
	}
	const idKey = Number(finalId);
	if (!Number.isInteger(idKey) || idKey < 1) {
		throw rowRefusal(
			`a dataframe frame in '${pending.slot}' carries id_key '${String(finalId)}', which is not an item id`,
			pending.slot,
		);
	}
	return idKey;
}

/**
 * APPEND write of frames — through the ENGINE, one save per (slot, main item),
 * with the caller pairing as context: the merge runs under saveComponentData's
 * FOR UPDATE lock, the insert law normalizes each frame (dd490, server-stamped
 * pairing), drops one already stored (`dataframeEntriesEqual`) and enforces
 * the slot's `data_limit` per main item (a refusal throws → the row rolls back).
 */
async function writeFramesAppend(
	pending: readonly PendingFrame[],
	ctx: RowWriteContext,
	reportTipo: string,
): Promise<void> {
	const groups = new Map<
		string,
		{ slot: string; main: string; idKey: number; frames: Record<string, unknown>[] }
	>();
	for (const entry of pending) {
		const idKey = pairedIdKey(entry, ctx);
		const key = `${entry.slot}|${entry.mainComponentTipo}|${idKey}`;
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, {
				slot: entry.slot,
				main: entry.mainComponentTipo,
				idKey,
				frames: [entry.frame],
			});
		} else group.frames.push(entry.frame);
	}
	for (const { slot, main, idKey, frames } of groups.values()) {
		const outcome = await saveOrRefuse({
			componentTipo: slot,
			sectionTipo: ctx.sectionTipo,
			sectionId: ctx.sectionId,
			lang: 'lg-nolan',
			changedData: [{ action: 'set_data', id: null, value: frames }],
			callerDataframe: { main_component_tipo: main, id_key: idKey },
			userId: ctx.userId,
			bulkProcessId: ctx.bulkProcessId,
			skipModifiedStamp: ctx.skipModifiedStamp,
			appendImport: true,
		});
		addSkipped(ctx, reportTipo, outcome.appendSkipped ?? 0);
	}
}

/** A dataframe SLOT column's frames as PendingFrames (append mode — every one must be paired). */
function slotColumnFrames(column: PlannedColumn): PendingFrame[] {
	return conformFrames(column).map((raw) => pairableFrame(raw, column.tipo));
}

/** One slot-column frame as a PendingFrame; a frame that cannot be paired refuses the row. */
function pairableFrame(raw: unknown, slot: string): PendingFrame {
	const unpairable = (): DedaloError =>
		rowRefusal(
			`append refused for dataframe '${slot}': a frame carries no main_component_tipo + id_key, so it cannot be paired`,
			slot,
		);
	if (!isObject(raw)) throw unpairable();
	const idKey = raw.id_key ?? raw.section_id_key;
	const main = raw.main_component_tipo;
	if (typeof main !== 'string' || main === '' || idKey == null) throw unpairable();
	const { section_id_key: _legacyId, section_tipo_key: _legacyTipo, ...frame } = raw;
	return { slot, mainComponentTipo: main, idKey, frame };
}

/**
 * Item ids SHARED across a lang-sliced cell's languages (plan §5): the
 * translations of one item carry one id. An item's key is its file id when it
 * has one, else its position (text_area: one key — each lang holds ONE text;
 * its own rule, `resolveSharedTextIds`, never refuses). For every key named by
 * two or more languages the id is RESOLVED AGAINST THE STORED DATA first,
 * under the row lock, before any lang save runs:
 *
 *   - a language whose entry DUPLICATES a stored item of its slice (the
 *     merge's own equality, `literalDuplicateIds`) names that stored id — the others'
 *     new entries take it (they are the item's missing translations), so a
 *     duplicate in one lang never leaves the new translation on another id;
 *   - no language matches: ONE fresh id, allocated only now; a key whose
 *     every language is a duplicate allocates nothing, so re-importing the
 *     same file writes nothing (not even the meta counter);
 *   - the languages DISAGREE (a stored id that another language already
 *     holds under a different value): the row is refused — writing the new
 *     translation under a second id would split the item.
 *
 * The stored ids are ABSORBED into the counter before the first allocation
 * (as saveComponentData does), so a lagging counter can never hand out an id
 * a stored item already carries. Null when there is nothing to share.
 */
async function resolveSharedIds(
	column: PlannedColumn,
	groups: readonly (readonly [string, unknown[]])[],
	ctx: RowWriteContext,
): Promise<Map<string, (number | undefined)[]> | null> {
	if (groups.length < 2 || !isLangSlicedModel(column.model)) return null;
	const isText = getImportAppendPolicy(column.model) === 'text_paragraphs';
	const family = literalEqualityFamilyOf(column.model);
	const keyOf = (item: unknown, index: number): string | null =>
		sharedItemKey(item, index, isText, family);
	const entriesByKey = entriesBySharedKey(groups, keyOf);
	const sharedKeys = [...entriesByKey].filter(([, entries]) => entries.size > 1);
	if (sharedKeys.length === 0) return null;

	const columnName = getColumnNameByModel(column.model) as MatrixJsonbColumn | null;
	if (columnName === null) {
		throw new DedaloError('internal.invariant', {
			message: `append: no matrix column for model '${column.model}' (${column.tipo})`,
			coordinates: { tipo: column.tipo },
		});
	}
	// The DATA tipo keys the stored slot and its meta counter — an alias key
	// holds nothing and counts from 1 (the save hops to the target itself).
	const dataTipo = dataTipoOf(column);
	const stored =
		(await readMatrixKeyForUpdate(
			ctx.table,
			ctx.sectionTipo,
			ctx.sectionId,
			columnName,
			dataTipo,
		)) ?? [];
	await absorbComponentItemIds(ctx.table, ctx.sectionTipo, ctx.sectionId, dataTipo, stored);

	const sliceOf = (lang: string): Record<string, unknown>[] =>
		stored.filter((item): item is Record<string, unknown> => isObject(item) && item.lang === lang);
	if (isText) {
		return resolveSharedTextIds(groups, sharedKeys, stored, sliceOf, () =>
			allocateComponentItemId(ctx.table, ctx.sectionTipo, ctx.sectionId, dataTipo),
		);
	}
	const matchesOf = (lang: string, entry: unknown): string[] =>
		literalDuplicateIds(stored, entry, family, lang).map(String);

	const shared = new Map<string, number>();
	for (const [key, entries] of sharedKeys) {
		const matches = new Map([...entries].map(([lang, entry]) => [lang, matchesOf(lang, entry)]));
		const candidates = [...new Set([...matches.values()].flat())];
		if (candidates.length === 0) {
			shared.set(
				key,
				await allocateComponentItemId(ctx.table, ctx.sectionTipo, ctx.sectionId, dataTipo),
			);
			continue;
		}
		// Every language a duplicate: nothing is written under this key.
		if ([...matches.values()].every((ids) => ids.length > 0)) continue;
		// The one id every language agrees on: a matching language matches IT, a
		// new one has it free in its slice.
		const agreed = candidates.find((candidate) =>
			[...matches].every(([lang, ids]) =>
				ids.length > 0
					? ids.includes(candidate)
					: !sliceOf(lang).some((item) => String(item.id) === candidate),
			),
		);
		if (agreed === undefined || !Number.isFinite(Number(agreed))) {
			throw rowRefusal(
				`append refused for '${column.tipo}': the translations of one imported item (${[...entries.keys()].join(', ')}) match stored item(s) ${candidates.join(', ')} in some languages but differ from what that item already holds in others — adding them would split the item across two ids`,
				column.tipo,
			);
		}
		shared.set(key, Number(agreed));
	}
	return new Map(
		groups.map(([lang, items]) => [
			lang,
			items.map((item, index) => shared.get(keyOf(item, index) ?? '')),
		]),
	);
}

/**
 * The text_area half of `resolveSharedIds`. An append adds a PARAGRAPH to each
 * language's own stored text — it never renames or splits a stored text id —
 * so there is nothing to agree on and this NEVER refuses: stored texts may
 * legitimately carry different ids per language (a replace import saves one
 * language at a time, each taking its own counter id).
 *
 *   - a language that already has a text needs no id (the merge extends it);
 *   - the languages WITHOUT one share ONE id: a stored text id (any
 *     language's — the new translation joins its siblings, as the save
 *     path's sibling-id rule does for a one-language cell) free in every one
 *     of their slices, else one fresh id — allocated only when some language
 *     really gets a new text.
 *
 * Blank texts never reach here (`sharedItemKey` keys them null).
 */
async function resolveSharedTextIds(
	groups: readonly (readonly [string, unknown[]])[],
	sharedKeys: readonly (readonly [string, Map<string, unknown>])[],
	stored: readonly unknown[],
	sliceOf: (lang: string) => Record<string, unknown>[],
	allocate: () => Promise<number>,
): Promise<Map<string, (number | undefined)[]> | null> {
	const langs = [...(sharedKeys.find(([key]) => key === TEXT_KEY)?.[1].keys() ?? [])];
	const newLangs = new Set(langs.filter((lang) => sliceOf(lang).length === 0));
	if (newLangs.size === 0) return null;
	const isFreeForNewLangs = (id: number): boolean =>
		[...newLangs].every((lang) => !sliceOf(lang).some((item) => Number(item.id) === id));
	const reusable = stored
		.map((item) => (isObject(item) ? item.id : undefined))
		.filter((id) => id != null && Number.isFinite(Number(id)))
		.map(Number)
		.find(isFreeForNewLangs);
	const id = reusable ?? (await allocate());
	return new Map(
		groups.map(([lang, items]) => [
			lang,
			items.map((item) => (newLangs.has(lang) && !isBlankText(item) ? id : undefined)),
		]),
	);
}

/** A text_area entry with no text — the merge skips it (`appendParagraph`). */
function isBlankText(item: unknown): boolean {
	const value = isObject(item) ? item.value : item;
	return value == null || (typeof value === 'string' && value.trim() === '');
}

/** The ONE shared key of a text_area cell (each language holds one text). */
const TEXT_KEY = '#text';

/** key → lang → the lang's (first) entry under that key (null-keyed entries left out). */
function entriesBySharedKey(
	groups: readonly (readonly [string, unknown[]])[],
	keyOf: (item: unknown, index: number) => string | null,
): Map<string, Map<string, unknown>> {
	const entriesByKey = new Map<string, Map<string, unknown>>();
	for (const [lang, items] of groups) {
		for (const [index, item] of items.entries()) {
			const key = keyOf(item, index);
			if (key === null) continue;
			const entries = entriesByKey.get(key) ?? new Map<string, unknown>();
			if (!entries.has(lang)) entries.set(lang, item);
			entriesByKey.set(key, entries);
		}
	}
	return entriesByKey;
}

/**
 * An incoming item's key across a cell's languages (resolveSharedIds): its
 * file id when it has one, else its position; text_area has ONE key. Null for
 * an EMPTY literal entry — no item at all (the merge skips it): it joins no
 * key, so no id is allocated for it and it never makes a key look shared.
 */
function sharedItemKey(
	item: unknown,
	index: number,
	isText: boolean,
	family: LiteralEqualityFamily,
): string | null {
	if (isText) return isBlankText(item) ? null : TEXT_KEY;
	if (isEmptyLiteralItem(item, family)) return null;
	const id = isObject(item) ? item.id : undefined;
	return isFileItemId(id) ? `id:${String(id)}` : `#${index}`;
}

/** A usable file item id: a finite number or a non-empty string. */
function isFileItemId(id: unknown): boolean {
	if (typeof id === 'number') return Number.isFinite(id);
	return typeof id === 'string' && id !== '';
}

/** REPLACE write of a column's data (the pre-append behaviour, unchanged). */
async function writeReplaceData(column: PlannedColumn, ctx: RowWriteContext): Promise<void> {
	const base = {
		componentTipo: column.tipo,
		sectionTipo: ctx.sectionTipo,
		sectionId: ctx.sectionId,
		userId: ctx.userId,
		bulkProcessId: ctx.bulkProcessId,
		skipModifiedStamp: ctx.skipModifiedStamp,
	};
	const groups = groupItemsByLang(column.conform.result, column.lang);
	if (groups.size === 0) {
		// An explicit CLEAR (empty cell).
		await saveOrRefuse({
			...base,
			lang: column.lang,
			changedData: [{ action: 'set_data', id: null, value: [] }],
		});
	}
	for (const [lang, items] of groups) {
		await saveOrRefuse({
			...base,
			lang,
			changedData: [{ action: 'set_data', id: null, value: items }],
		});
	}
}

/**
 * APPEND write of a main column's data: one `appendImport` save per lang
 * group. An empty cell or empty lang group (`{"lg-spa":[]}`) is a NO-OP —
 * append never clears. The file-id → final-id maps of every lang save are
 * merged under the column tipo for pass 2.
 */
async function writeAppendData(column: PlannedColumn, ctx: RowWriteContext): Promise<void> {
	const groups = await appendLangGroups(column);
	if (groups.length === 0) return;
	const shared = await resolveSharedIds(column, groups, ctx);
	// Keyed by the DATA tipo: a frame's main_component_tipo names it (stored
	// data never holds an alias tipo), and pass 2 looks the map up by that.
	const idMap = appendedIdMapOf(ctx, dataTipoOf(column));
	for (const [lang, items] of groups) {
		const preallocatedIds = shared?.get(lang);
		const outcome = await saveOrRefuse({
			componentTipo: column.tipo,
			sectionTipo: ctx.sectionTipo,
			sectionId: ctx.sectionId,
			lang,
			changedData: [{ action: 'set_data', id: null, value: items }],
			userId: ctx.userId,
			bulkProcessId: ctx.bulkProcessId,
			skipModifiedStamp: ctx.skipModifiedStamp,
			appendImport: preallocatedIds === undefined ? true : { preallocatedIds },
		});
		mergeFirstIds(idMap, outcome.appendedIdMap);
		addSkipped(ctx, column.tipo, outcome.appendSkipped ?? 0);
	}
}

/**
 * A main column's non-empty lang groups for the append saves. A column whose
 * saves are ALL 'lg-nolan' whatever the request lang (resolver.ts
 * savesInRequestLang false: not translatable, not transliterable, not
 * component_iri) stores every item in ONE slice, so a multi-lang cell
 * collapses into ONE save of all its items: the values are appended to that
 * slice, where per-lang saves would each claim the same shared id there and
 * refuse the row. A transliterable column (with_lang_versions) keeps its
 * groups: its base and each transliteration are slices of their own.
 */
async function appendLangGroups(column: PlannedColumn): Promise<[string, unknown[]][]> {
	const groups = [...groupItemsByLang(column.conform.result, column.lang)].filter(
		([, items]) => items.length > 0,
	);
	if (groups.length < 2 || (await savesInRequestLang(column.tipo, column.model))) return groups;
	return [[column.lang, groups.flatMap(([, items]) => items)]];
}

/** The column's file-id → final-id map for pass 2, created on first use. */
function appendedIdMapOf(ctx: RowWriteContext, tipo: string): Map<string, unknown> {
	let idMap = ctx.appendedIds.get(tipo);
	if (idMap === undefined) {
		idMap = new Map();
		ctx.appendedIds.set(tipo, idMap);
	}
	return idMap;
}

/** Merge one lang save's id map: the FIRST lang to map a file id wins. */
function mergeFirstIds(
	target: Map<string, unknown>,
	source: Map<string, unknown> | undefined,
): void {
	for (const [fileId, finalId] of source ?? []) {
		if (!target.has(fileId)) target.set(fileId, finalId);
	}
}

/** A column's data write, by mode and by kind (main data vs dataframe slot). */
async function writeColumnData(column: PlannedColumn, ctx: RowWriteContext): Promise<void> {
	if (column.mode !== 'append') {
		await assertReplaceSlotSparesAppendMains(column, ctx);
		await writeReplaceData(column, ctx);
		return;
	}
	if (column.model === DATAFRAME_MODEL) {
		await writeFramesAppend(slotColumnFrames(column), ctx, column.tipo);
		return;
	}
	await writeAppendData(column, ctx);
}

/** A legacy envelope's frames, by the carrying column's mode. */
async function writeLegacyFrames(column: PlannedColumn, ctx: RowWriteContext): Promise<void> {
	// A frame with no main_component_tipo pairs with THIS column's data tipo.
	const pending = await parseLegacyFrames(column.dataframe ?? [], dataTipoOf(column), ctx);
	if (pending.length === 0) return;
	if (column.mode === 'append') {
		// A slot save through the engine, recorded as the main's COMPOSED pair
		// (the caller pairing names the main): even when the main save was a
		// no-op (every item a duplicate, no TM row), the frames are recorded.
		await writeFramesAppend(pending, ctx, column.tipo);
		return;
	}
	await writeLegacyFramesReplace(pending, dataTipoOf(column), ctx);
}

/**
 * MIXED MODES refuse the row (plan §5) — the STATIC half, read off the file
 * before the row's transaction opens (the stored half is
 * `assertReplaceSlotSparesAppendMains`, under the row lock):
 *
 *  - a REPLACE dataframe slot column whose frames name an APPEND main would
 *    pair new frames to the file's ids instead of the appended items';
 *  - a REPLACE column carrying a legacy `{data, dataframe}` envelope whose
 *    frames name an APPEND main of the row (the frame's `main_component_tipo`)
 *    goes through the replace frame writer, which never re-pairs through the
 *    append save's id map: the frame would land on whatever STORED item
 *    carries the file id.
 *
 * `appendMains` is every append main of the row, conform-failed ones included
 * (as `RowWriteContext.appendMains`): a failed main has no id map at all.
 */
function assertRowModesCompatible(record: PlannedRecord): void {
	const appendMains = appendMainsOf(record);
	if (appendMains.size === 0) return;
	for (const column of record.columns) {
		if (column.conform.errors.length > 0) continue;
		const slotMain = replaceSlotAppendMains(column, appendMains)[0];
		if (slotMain !== undefined) {
			throw rowRefusal(
				`the dataframe column '${column.tipo}' is in REPLACE mode while its main column '${slotMain}' is in APPEND mode — set both columns to the same mode`,
				column.tipo,
			);
		}
		const envelopeMain = replaceEnvelopeAppendMains(column, appendMains)[0];
		if (envelopeMain !== undefined) {
			throw rowRefusal(
				`the column '${column.tipo}' is in REPLACE mode while its dataframe frames pair with '${envelopeMain}', which is in APPEND mode — set both columns to the same mode`,
				column.tipo,
			);
		}
	}
}

/**
 * The tipo whose slot holds a column's DATA — the alias TARGET for a
 * component_alias column (CsvColumn.dataTipo), else the column tipo. Every
 * stored-data read, item-id allocation and frame pairing keys by it.
 */
function dataTipoOf(column: PlannedColumn): string {
	return column.dataTipo ?? column.tipo;
}

/** The row's APPEND main DATA tipos (every column, whatever its conform outcome). */
function appendMainsOf(record: PlannedRecord): Set<string> {
	return new Set(
		record.columns
			.filter((column) => column.mode === 'append' && column.model !== DATAFRAME_MODEL)
			.map(dataTipoOf),
	);
}

/**
 * The APPEND main columns a REPLACE dataframe slot column's own frames name.
 * An empty cell names none: whether its clear touches an append main's frames
 * is a question about the STORED slot, answered under the lock
 * (`assertReplaceSlotSparesAppendMains`), never presumed from the file.
 */
function replaceSlotAppendMains(column: PlannedColumn, appendMains: ReadonlySet<string>): string[] {
	if (column.model !== DATAFRAME_MODEL || column.mode !== 'replace' || !column.hasData) return [];
	const result = column.conform.result;
	const frames = Array.isArray(result) ? result.filter(isObject) : [];
	return frames
		.map((frame) => frame.main_component_tipo)
		.filter((main): main is string => typeof main === 'string' && appendMains.has(main));
}

/** The APPEND mains a REPLACE column's legacy envelope frames name. */
function replaceEnvelopeAppendMains(
	column: PlannedColumn,
	appendMains: ReadonlySet<string>,
): string[] {
	if (column.mode === 'append' || !hasLegacyFrames(column)) return [];
	return (column.dataframe ?? [])
		.filter(isObject)
		.map((frame) => frame.main_component_tipo)
		.filter((main): main is string => typeof main === 'string' && appendMains.has(main));
}

/**
 * MIXED MODES, the STORED half: a REPLACE write of a dataframe slot replaces
 * the WHOLE slot (an empty cell clears it), so it clashes with an append main
 * exactly when the slot already STORES frames of that main — the append keeps
 * its stored items byte-for-byte, and their frames would be wiped under them.
 * Read under the row lock (the save below re-locks the same row in the same
 * transaction). A slot holding no frame of an append main writes as always.
 */
async function assertReplaceSlotSparesAppendMains(
	column: PlannedColumn,
	ctx: RowWriteContext,
): Promise<void> {
	if (column.model !== DATAFRAME_MODEL || ctx.appendMains.size === 0) return;
	const jsonbColumn = getColumnNameByModel(DATAFRAME_MODEL) as MatrixJsonbColumn | null;
	if (jsonbColumn === null) return;
	const stored = await readMatrixKeyForUpdate(
		ctx.table,
		ctx.sectionTipo,
		ctx.sectionId,
		jsonbColumn,
		dataTipoOf(column),
	);
	const clash = (stored ?? [])
		.filter(isObject)
		.map((frame) => frame.main_component_tipo)
		.find((main): main is string => typeof main === 'string' && ctx.appendMains.has(main));
	if (clash !== undefined) {
		throw rowRefusal(
			`the dataframe column '${column.tipo}' is in REPLACE mode and would overwrite the stored frames of '${clash}', which is in APPEND mode — set both columns to the same mode`,
			column.tipo,
		);
	}
}

/** The `data`-column metadata a row's audit columns imply (metadataPatchFor). */
type RowMetadata = { createdDate?: string; createdByUserId?: number };

/**
 * THE WRITE DOOR for one column (closure Step 3 req 10), as the importer: the
 * column's component of an EXISTING record through authorizeRecordAccess
 * (grammar, section floor 1, the dd128-aware pair — a CSV row naming a
 * user-manager's own dd128 record must not set their dd1725 — and the write
 * scope); of a record this row CREATES through authorizeSectionTarget (the
 * pair level). A refused column is reported and SKIPPED — never written, and
 * its metadata never applied — exactly like a column whose values were refused.
 * Anything that is not the door's refusal propagates (the row rolls back).
 */
async function columnAuthorized(
	column: PlannedColumn,
	row: number,
	ctx: RowWriteContext & { failed: ImportRowIssue[] },
): Promise<boolean> {
	for (const { tipo, frameOf } of columnDoorTargets(column)) {
		const refusal = await componentRefusal(ctx, tipo, frameOf);
		if (refusal === null) continue;
		ctx.failed.push({
			section_id: ctx.sectionId,
			component_tipo: tipo,
			msg: refusal,
			data: null,
			row,
		});
		return false;
	}
	return true;
}

/**
 * Every (component, main) pair a column writes, as the write door must be asked
 * it: the column's own component, then each slot its legacy {data, dataframe}
 * envelope's frames name — PAIRED WITH THE FRAMES' MAIN (T0-4: a FIXED slot,
 * dd560, is judged against its main and the door refuses one asked without it).
 * A legacy frame's main is its own `main_component_tipo`, else this column's
 * data tipo (parseLegacyFrames' rule); a slot COLUMN's frames each name theirs
 * (pairableFrame refuses one that does not). `frameOf` is ignored by the door
 * for a slot that is not fixed.
 */
function columnDoorTargets(column: PlannedColumn): { tipo: string; frameOf?: FrameOf }[] {
	const targets = new Map<string, { tipo: string; frameOf?: FrameOf }>();
	const add = (tipo: string, mainTipo: string | null): void => {
		const key = `${tipo}|${mainTipo ?? ''}`;
		if (targets.has(key)) return;
		targets.set(key, mainTipo === null ? { tipo } : { tipo, frameOf: { mainTipo } });
	};
	const slotColumnMains =
		column.model === DATAFRAME_MODEL ? frameMains(conformFrames(column), null) : [];
	if (slotColumnMains.length === 0) add(column.tipo, null);
	for (const main of slotColumnMains) add(column.tipo, main);
	for (const frame of column.dataframe ?? []) {
		const slot = isObject(frame) ? frame.from_component_tipo : undefined;
		if (typeof slot !== 'string' || slot === '') continue;
		add(slot, frameMains([frame], dataTipoOf(column))[0] ?? null);
	}
	return [...targets.values()];
}

/** A slot column's conformed frames as a list (the shape slotColumnFrames reads). */
function conformFrames(column: PlannedColumn): unknown[] {
	const result = column.conform.result;
	if (Array.isArray(result)) return result;
	return result === null || result === undefined ? [] : [result];
}

/** The distinct mains a list of frames names (`fallback` for a frame naming none). */
function frameMains(frames: readonly unknown[], fallback: string | null): string[] {
	const mains = new Set<string>();
	for (const frame of frames) {
		const main = isObject(frame) ? frame.main_component_tipo : undefined;
		if (typeof main === 'string' && main !== '') mains.add(main);
		else if (fallback !== null) mains.add(fallback);
	}
	return [...mains];
}

/** The door's refusal sentence for one component of the row's record, or null. */
async function componentRefusal(
	ctx: RowWriteContext,
	componentTipo: string,
	frameOf?: FrameOf,
): Promise<string | null> {
	try {
		if (ctx.isNew) {
			await authorizeSectionTarget(
				ctx.principal,
				{ section_tipo: ctx.sectionTipo, tipo: componentTipo },
				{ level: 2, door: 'import_csv.column', frameOf },
			);
		} else {
			await authorizeRecordAccess(
				ctx.principal,
				{ section_tipo: ctx.sectionTipo, component_tipo: componentTipo, section_id: ctx.sectionId },
				{ mode: 'write', level: 2, sectionFloor: 1, door: 'import_csv.column', frameOf },
			);
		}
		return null;
	} catch (error) {
		if (
			isDedaloError(error) &&
			(error.code.startsWith('perm.') ||
				error.code === 'request.invalid' ||
				// A FIXED dataframe slot (dd560) asked without a valid main (T0-4): the
				// door's refusal of THIS column — reported and skipped like any other, never
				// a rolled-back row.
				error.code === 'request.invalid_source')
		) {
			return `IGNORED: not writable by the importer (${error.code}) — the column was NOT written`;
		}
		throw error;
	}
}

/**
 * PASS 1 — the main columns. Conform errors go to `failed` (the column is
 * skipped), conform warnings to `warnings`. Dataframe slot columns and legacy
 * envelope frames wait for pass 2 (returned): an append frame's id_key is
 * re-paired through its main column's save, wherever that column sits in the
 * file.
 */
async function writeRowPassOne(
	record: PlannedRecord,
	ctx: RowWriteContext & { failed: ImportRowIssue[] },
	metadata: RowMetadata,
	publishColumn: (tipo: string) => void,
): Promise<PlannedColumn[]> {
	const secondPass: PlannedColumn[] = [];
	for (const column of record.columns) {
		if (!(await columnWritable(column, record.row, ctx))) continue;
		Object.assign(metadata, metadataPatchFor(column));

		const isSlot = column.model === DATAFRAME_MODEL;
		if (needsPassTwo(column)) secondPass.push(column);
		// A dataframe-ONLY envelope: the component's data is not touched, only
		// its frames (pass 2). Distinct from an empty value, which CLEARS
		// (replace mode; append never clears).
		if (column.hasData && !isSlot) await writeColumnData(column, ctx);
		publishColumn(column.tipo);
	}
	return secondPass;
}

/** Authorized for this caller, THEN conform-clean (an unauthorized column reports no conform issue). */
async function columnWritable(
	column: PlannedColumn,
	row: number,
	ctx: RowWriteContext & { failed: ImportRowIssue[] },
): Promise<boolean> {
	return (await columnAuthorized(column, row, ctx)) && collectConformIssues(column, row, ctx);
}

/**
 * A column's conform issues into the row report: errors to `failed` (false —
 * the column is skipped), warnings to `warnings` (true — it is written).
 */
function collectConformIssues(
	column: PlannedColumn,
	row: number,
	ctx: RowWriteContext & { failed: ImportRowIssue[] },
): boolean {
	if (column.conform.errors.length > 0) {
		for (const error of column.conform.errors) ctx.failed.push({ ...error, row });
		return false;
	}
	for (const warning of column.conform.warnings) ctx.warnings.push({ ...warning, row });
	return true;
}

/** PASS 2 — dataframe slot columns, then legacy envelope frames. */
async function writeRowPassTwo(
	columns: readonly PlannedColumn[],
	ctx: RowWriteContext,
	publishColumn: (tipo: string) => void,
): Promise<void> {
	for (const column of columns) {
		if (column.model === DATAFRAME_MODEL && column.hasData) await writeColumnData(column, ctx);
		if (hasLegacyFrames(column)) await writeLegacyFrames(column, ctx);
		publishColumn(column.tipo);
	}
}

/** A dataframe slot column, or one carrying legacy envelope frames: written in pass 2. */
function needsPassTwo(column: PlannedColumn): boolean {
	return column.model === DATAFRAME_MODEL || hasLegacyFrames(column);
}

function hasLegacyFrames(column: PlannedColumn): boolean {
	return column.dataframe !== null && column.dataframe.length > 0;
}

/**
 * Execute one file's plan. Record identity is the CSV's own section_id column: a
 * row without one is SKIPPED (never created under a fresh counter id), and an id
 * not yet in the DB is INSERTED with that id — preserving the source system's ids
 * and the relations that point at them.
 */
export async function executeCsvImport(request: CsvExecuteRequest): Promise<ImportFileReport> {
	const { plan, sectionTipo, principal, bulkProcessId, progress } = request;
	const userId = principal.userId;
	const startedAt = performance.now();

	const created: number[] = [];
	const updated: number[] = [];
	const failed: ImportRowIssue[] = [];
	const warnings: ImportRowIssue[] = [];
	const errors: string[] = [...request.errors];

	// BACKSTOP for the column resolver (tool_import_dedalo_csv refuses first): a
	// DERIVED component owns no stored value, so no imported column may write it
	// — for component_relation_children a replace would re-parent records.
	const derivedColumn = plan
		.flatMap((record) => record.columns)
		.find((column) => isDerivedModel(column.model));
	if (derivedColumn !== undefined) {
		throw new DedaloError('request.invalid_data', {
			message: `CSV import refused: column '${derivedColumn.tipo}' (${derivedColumn.model}) is derived — computed, nothing stored to import`,
			coordinates: { section_tipo: sectionTipo, tipo: derivedColumn.tipo },
		});
	}

	// ONE existence query for the whole file (see the header).
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `no matrix table for section '${sectionTipo}'`,
			coordinates: { section_tipo: sectionTipo },
		});
	}
	const candidateIds = plan
		.map((record) => record.sectionId)
		.filter((id): id is number => id !== null && id > 0);
	const existing = await readExistingSectionIds(table, sectionTipo, candidateIds);

	let lastPublish = 0;
	const publish = (record: PlannedRecord, componentTipo: string | null, force: boolean): void => {
		const now = performance.now();
		if (!force && now - lastPublish < PROGRESS_THROTTLE_MS) return;
		lastPublish = now;
		progress.publish({
			phase: 'importing',
			file: progress.file,
			file_index: progress.fileIndex,
			files_total: progress.filesTotal,
			row: record.row - 1, // the header is row 1; row N of the data is N-1
			rows_total: plan.length,
			section_id: record.sectionId,
			component_label:
				componentTipo === null ? null : (progress.labels.get(componentTipo) ?? componentTipo),
			created: created.length,
			updated: updated.length,
			failed: failed.length,
			warnings: warnings.length,
		});
	};

	for (const record of plan) {
		const sectionId = record.sectionId;
		// DATA-22: a key that was PRESENT and unreadable is named exactly, so the
		// operator sees which cell to fix instead of "missing or not a number" for a
		// cell that plainly holds something.
		if (record.keyError !== null) {
			errors.push(`Row ${record.row}: SKIPPED — ${record.keyError}`);
			continue;
		}
		if (sectionId === null || sectionId <= 0) {
			errors.push(
				`Row ${record.row}: SKIPPED — the mandatory section_id is missing or not a number`,
			);
			continue;
		}

		// The modified stamp must be suppressed for the WHOLE row when the CSV
		// carries the modified metadata: dd197/dd201 may be written before the
		// row's other columns, and each of those saves would re-stamp the record
		// with "now, by the importer" — overwriting what we just imported.
		const carriesModifiedMetadata = record.columns.some(
			(column) =>
				(column.tipo === AUDIT_TIPOS.modifiedDate || column.tipo === AUDIT_TIPOS.modifiedByUser) &&
				column.conform.errors.length === 0,
		);

		const isNew = !existing.has(sectionId);
		const ctx: RowWriteContext & { failed: ImportRowIssue[] } = {
			failed,
			table,
			sectionTipo,
			sectionId,
			userId,
			principal,
			isNew,
			bulkProcessId,
			skipModifiedStamp: carriesModifiedMetadata,
			row: record.row,
			warnings,
			appendedIds: new Map(),
			appendMains: appendMainsOf(record),
			skipped: new Map(),
		};
		try {
			assertRowModesCompatible(record);
			const metadata: RowMetadata = {};
			const publishColumn = (tipo: string): void => publish(record, tipo, false);
			// ONE transaction for the row: create + every component + its frames.
			await withTransaction(async () => {
				if (isNew) {
					// THE WRITE DOOR (req 10): a create at the section level — refused,
					// the row rolls back and is reported like any row failure.
					await authorizeSectionTarget(
						principal,
						{ section_tipo: sectionTipo },
						{ level: 2, door: 'import_csv.create' },
					);
					// conflictTolerant: a concurrent writer may have taken the id since the
					// existence snapshot; the insert is then a no-op. bulkProcessId: a REAL
					// insert writes the run's birth marker (tm_role 3), so a revert knows
					// this run created the record (decision D2); the no-op writes none.
					await createSectionRecord(sectionTipo, userId, new Date(), sectionId, {
						conflictTolerant: true,
						bulkProcessId,
					});
					// THE ROW IS NEW ONLY IF IT CREATED ITS RECORD (refuter-surviving S2,
					// 2026-10-01). The snapshot said the id was free; a concurrent create
					// that took it made the insert a no-op, and the record is SOMEONE
					// ELSE'S — outside the importer's scope, perhaps a dd128 account. A
					// section-target grant authorizes a create only; from here every
					// column is asked as a write to THAT record (scope + the dd128-aware
					// pair), and the row is reported updated, never created.
					ctx.isNew = await bornInCurrentTransaction(table, sectionTipo, sectionId);
				}

				const secondPass = await writeRowPassOne(record, ctx, metadata, publishColumn);
				await writeRowPassTwo(secondPass, ctx, publishColumn);

				// The `data`-column twin of dd199/dd200 (see record_metadata.ts): without
				// it the edit view says 1998 and every list says "created today".
				if (metadata.createdDate !== undefined || metadata.createdByUserId !== undefined) {
					await setRecordMetadata(sectionTipo, sectionId, metadata);
				}
			});

			// Duplicates an append skipped — reported only now the row COMMITTED
			// (a rolled-back row reports its failure, not what it would have skipped).
			for (const [componentTipo, count] of ctx.skipped) {
				warnings.push({
					section_id: sectionId,
					component_tipo: componentTipo,
					msg: `${count} already present, not added`,
					data: null,
					row: record.row,
				});
			}

			if (ctx.isNew) {
				created.push(sectionId);
				// DATA-21: the existence set was read ONCE before the loop and never
				// added to, so a file carrying the same section_id twice reported TWO
				// records created where one exists — the second row's values silently
				// REPLACED the first row's. The record exists from here on; a later row
				// with this id is an update, and the report says so. (An APPEND column
				// ACCUMULATES instead: each repeat adds its values.)
				existing.add(sectionId);
			} else updated.push(sectionId);
		} catch (error) {
			// The row's transaction rolled back: the record is exactly as it was.
			failed.push({
				section_id: sectionId,
				component_tipo: '',
				msg: `IGNORED: the row was rolled back — ${(error as Error).message}`,
				data: null,
				row: record.row,
			});
		}
		publish(record, null, false);
	}

	return {
		ok: true,
		file: progress.file,
		section_tipo: sectionTipo,
		bulk_process_id: bulkProcessId,
		created,
		updated,
		failed,
		warnings,
		errors,
		notices: [...request.notices],
		rows_total: plan.length,
		ms: Math.round(performance.now() - startedAt),
	};
}
