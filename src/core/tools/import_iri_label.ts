/**
 * component_iri IMPORT LABELS — the in-row-transaction resolver (T0-12, OX2).
 *
 * An imported iri item may carry a LABEL: `'<label id>, https://…'`,
 * `'<label text>, https://…'`, or a JSON item's `label_id`. The label is never
 * a key of the stored item — it is the item's dd560 FRAME (`type dd490 →
 * dd1706/<label record>`, paired to the item by `id_key`), exactly the shape
 * the editor writes. Conform (import_conform.ts) is PURE — it runs at
 * plan/preview time, outside any transaction — so it only states the label as
 * an INTENT beside the clean item (`ConformResult.derivedFrames`). Both
 * executors (import_csv_execute.ts, import_execute.ts) resolve the intents
 * HERE, inside the row's transaction, before the main save:
 *
 *   1. a NUMERIC target must name an existing dd1706 record — a frame to
 *      nothing is corruption, so an unknown id refuses the field;
 *   2. a TEXT target takes a transaction-scoped advisory lock on its FOLDED
 *      form — the ONE match fold `lower(f_unaccent(<match trim>(…)))`, computed by
 *      Postgres; locks taken in sorted fold order (concurrent imports creating
 *      the same label serialize; 'Nomisma' and 'nomisma' fold alike, so they
 *      serialize together), then is looked up in dd1706/dd1715 with that same
 *      fold on both sides — trimmed, case- and accent-insensitive, WHOLE value,
 *      no substring narrowing and no candidate cap (D4b). Several matches → the LOWEST section_id, deterministically, with
 *      a warning naming the others (D2b). None → a new dd1706 record is
 *      created with dd1715 `[{value, lang:'lg-nolan'}]`, under the run's
 *      bulk process, after the write door said yes to the IMPORTER (a refusal
 *      refuses the field — never a label-less import). Created inside the row
 *      transaction, so a rolled-back row leaves no orphan label.
 *
 * The memo is PER CALL (one row): a per-run memo would outlive a rolled-back
 * row and point at a record that no longer exists. No module state.
 *
 * Pairing to the item's FINAL id and the frame write itself belong to the
 * executors (replace pre-allocates ids in-tx, append re-pairs through the
 * save's `appendedIdMap`); this module supplies the shared halves: the intent
 * → item mapping, the label resolution, the replace-mode id pre-allocation and
 * the frame shape.
 */

import { trimMatchText } from '../concepts/match_text.ts';
import { DATAFRAME_RELATION_TYPE } from '../concepts/subdatum.ts';
import { foldMatchTexts, readExistingSectionIds } from '../db/matrix.ts';
import {
	absorbComponentItemIds,
	allocateComponentItemId,
	readMatrixKeyForUpdate,
} from '../db/matrix_write.ts';
import { acquireNodeLock, isInTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/index.ts';
import { literalDuplicateIds } from '../section/record/append_merge.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import type { Principal } from '../security/permissions.ts';
import { authorizeSectionTarget } from '../security/write_door.ts';
import { findSectionIdsByFoldedText } from './import_code_lookup.ts';
import type { IriLabelIntent } from './import_data.ts';
import { isFieldWriteRefusal } from './import_field_refusal.ts';

/** The fixed label slot of component_iri (a component_dataframe, data_limit 1). */
/** The one model whose import conform emits label intents (`derivedFrames`). */
export const IRI_LABEL_MODEL = 'component_iri';

export const IRI_LABEL_SLOT = 'dd560';
/** The label vocabulary section. */
const LABEL_SECTION = 'dd1706';
/** Its label value (component_input_text, not translatable). */
const LABEL_VALUE = 'dd1715';
/** The matrix table dd1706 records live in. */
const LABEL_TABLE = 'matrix_list';
/** The matrix column component_iri items live in. */
const IRI_COLUMN = 'iri';

/** A label target: an existing dd1706 record, or a text to find-or-create. */
export type IriLabelTarget = IriLabelIntent['target'];

/** One labelled item: the item OBJECT (a reference into the conform result) and its target. */
export interface LabelledIriItem {
	item: Record<string, unknown>;
	target: IriLabelTarget;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The conform result's labelled items, by object reference. The executors group
 * the result by lang (groupItemsByLang keeps the item objects), so a reference
 * finds its item in whatever group it lands. An intent that does not point at
 * an object item is an internal breach (conform produced both), never skipped.
 */
export function labelledItemsOf(
	result: unknown,
	intents: readonly IriLabelIntent[] | undefined,
): LabelledIriItem[] {
	return (intents ?? []).map((intent) => ({
		item: intentItem(result, intent),
		target: intent.target,
	}));
}

/** The item an intent points at (the flat array, or its lang's array). */
function intentItem(result: unknown, intent: IriLabelIntent): Record<string, unknown> {
	const list = intent.lang === null ? result : intentLangList(result, intent.lang);
	const item = Array.isArray(list) ? list[intent.item] : undefined;
	if (isObject(item)) return item;
	throw new DedaloError('internal.invariant', {
		message: `iri label intent names item ${intent.item} (${intent.lang ?? 'flat'}), which the conform result does not hold`,
	});
}

function intentLangList(result: unknown, lang: string): unknown {
	return isObject(result) ? result[lang] : undefined;
}

/** Who resolves the labels: the importer, the run, and the iri component (for messages). */
export interface LabelResolveScope {
	principal: Principal;
	userId: number;
	bulkProcessId: number;
	/** The iri component whose items carry the labels (messages only). */
	componentTipo: string;
	/**
	 * The ROW's label locks ({@link lockLabelTexts}), taken before any write of
	 * the row: every text label resolved here must be in it, or the call throws.
	 */
	locks: LabelLocks;
}

/** Text label → its match fold, for every text label of a row — each one LOCKED. */
export type LabelLocks = ReadonlyMap<string, string>;

/**
 * Take the label locks of a whole ROW (record): every text label of every
 * labelled field, folded in ONE query (db/matrix.ts `foldMatchTexts`), the
 * distinct folds locked ONCE each in SORTED order — and this must run BEFORE
 * any other lock or write of the row.
 *
 * Why the whole row, first: a lock is held to COMMIT, so locking per column
 * (or per field) in each column's own order lets two rows naming the same two
 * labels in crossed column order each hold one and wait on the other —
 * `deadlock detected` (probe 2026-11-11). And a row that saved a component
 * first holds that record's lock while it waits on a label lock, the reverse of
 * a row that locked the label first. One global order — labels sorted, then the
 * record — leaves no cycle. The lock key is the SQL fold in the label section's
 * node-lock key space (`dd1706_label:<fold>`; no record id has that shape).
 */
export async function lockLabelTexts(labelled: readonly LabelledIriItem[]): Promise<LabelLocks> {
	const texts = labelled.flatMap(({ target }) => ('label' in target ? [target.label] : []));
	const foldOf = await foldMatchTexts(texts);
	for (const folded of [...new Set(foldOf.values())].sort()) {
		await acquireNodeLock(LABEL_SECTION, `label:${folded}`);
	}
	return foldOf;
}

/** The resolution: each labelled item's dd1706 record, plus warnings — or the field's refusal. */
export type LabelResolution =
	| { ok: true; labelOf: Map<object, number>; warnings: string[] }
	| { ok: false; refusal: string };

/**
 * Resolve every labelled item's dd1706 record, INSIDE the row transaction.
 * Order matters: every check and lookup runs first, then ONE door question for
 * the creates, then the creates — so a refusal (unknown id, door) leaves
 * nothing written. A failure that is not a refusal propagates (the row rolls
 * back).
 */
export async function resolveIriLabels(
	labelled: readonly LabelledIriItem[],
	scope: LabelResolveScope,
): Promise<LabelResolution> {
	if (!isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message:
				'resolveIriLabels: called outside the row transaction — a created label would outlive a rolled-back row',
			coordinates: { tipo: scope.componentTipo },
		});
	}
	const missing = await missingLabelIds(labelled);
	if (missing.length > 0) {
		return {
			ok: false,
			refusal: `IGNORED: label record ${missing.join(', ')} does not exist in ${LABEL_SECTION} — the field was NOT written`,
		};
	}
	const warnings: string[] = [];
	const foldOf = lockedFolds(labelled, scope);
	const byFold = await lookupTextLabels(foldOf, warnings);
	const refusal = await createMissingLabels(byFold, scope);
	if (refusal !== null) return { ok: false, refusal };
	const labelOf = new Map<object, number>();
	for (const { item, target } of labelled) {
		labelOf.set(item, targetSectionId(target, byFold, foldOf));
	}
	return { ok: true, labelOf, warnings };
}

/**
 * Create every text label the lookup did not find — after ONE door question
 * for all of them, so a refusal creates none. Answers the refusal, or null.
 */
async function createMissingLabels(
	byFold: ReadonlyMap<string, TextLabel>,
	scope: LabelResolveScope,
): Promise<string | null> {
	const toCreate = [...byFold.values()].filter((found) => found.sectionId === null);
	if (toCreate.length === 0) return null;
	const refusal = await labelCreateRefusal(scope.principal);
	if (refusal !== null) return refusal;
	for (const found of toCreate) found.sectionId = await createLabel(found.text, scope);
	return null;
}

/** A target's resolved dd1706 record: its own id, or its text's (found or created). */
function targetSectionId(
	target: IriLabelTarget,
	byFold: ReadonlyMap<string, TextLabel>,
	foldOf: ReadonlyMap<string, string>,
): number {
	if ('section_id' in target) return target.section_id;
	return byFold.get(foldOf.get(target.label) as string)?.sectionId as number;
}

/**
 * The match fold of each text label of this call, from the ROW's locks. A text
 * the row did not lock is an executor bug (its lock would be taken now, after
 * the row's writes — the deadlock order): refused loudly, nothing written.
 */
function lockedFolds(
	labelled: readonly LabelledIriItem[],
	scope: LabelResolveScope,
): Map<string, string> {
	const foldOf = new Map<string, string>();
	for (const { target } of labelled) {
		if (!('label' in target)) continue;
		const folded = scope.locks.get(target.label);
		if (folded === undefined) {
			throw new DedaloError('internal.invariant', {
				message: `resolveIriLabels: label '${target.label}' was not locked with the row (lockLabelTexts before any write)`,
				coordinates: { tipo: scope.componentTipo },
			});
		}
		foldOf.set(target.label, folded);
	}
	return foldOf;
}

/** The numeric targets that name no dd1706 record (ONE existence query). */
async function missingLabelIds(labelled: readonly LabelledIriItem[]): Promise<number[]> {
	const ids = [
		...new Set(
			labelled
				.map(({ target }) => ('section_id' in target ? target.section_id : null))
				.filter((id): id is number => id !== null),
		),
	];
	if (ids.length === 0) return [];
	const existing = await readExistingSectionIds(LABEL_TABLE, LABEL_SECTION, ids);
	return ids.filter((id) => !existing.has(id));
}

/** One distinct text label of the row: its first spelling and its record (null = to create). */
interface TextLabel {
	text: string;
	sectionId: number | null;
}

/**
 * Every distinct (folded) text label of the call, looked up — under the lock
 * the row already holds for it ({@link lockLabelTexts}), so the create that may
 * follow is serialized with every other import of the same label.
 */
async function lookupTextLabels(
	foldOf: ReadonlyMap<string, string>,
	warnings: string[],
): Promise<Map<string, TextLabel>> {
	// First spelling per fold (cell order), trimmed by THE match trim.
	const textOf = new Map<string, string>();
	for (const [label, folded] of foldOf) {
		if (!textOf.has(folded)) textOf.set(folded, trimMatchText(label));
	}
	const byFold = new Map<string, TextLabel>();
	for (const folded of [...textOf.keys()].sort()) {
		const text = textOf.get(folded) as string;
		byFold.set(folded, { text, sectionId: await findLabelRecord(text, warnings) });
	}
	return byFold;
}

/** The label record a text resolves to: the LOWEST of its matches (D2b), a warning naming the others. */
async function findLabelRecord(text: string, warnings: string[]): Promise<number | null> {
	const matches = await findSectionIdsByFoldedText(
		{ sectionTipo: LABEL_SECTION, componentTipo: LABEL_VALUE },
		text,
		// D6b (owner decision 2026-11-11): dd1706 is the SHARED label vocabulary of
		// every component_iri. An importer-scoped lookup would miss a label filed in
		// another project and create a second copy — forking the vocabulary per
		// project. The import LINKS to the label (the frame points at it) and never
		// writes into it; only ids come back, never another project's text.
		'D6b: dd1706 is the shared iri label vocabulary — linked, never written',
	);
	if (matches.length > 1) {
		warnings.push(
			`label '${text}' matches several label records (${matches.join(', ')}) — the lowest, ${matches[0]}, was used`,
		);
	}
	return matches[0] ?? null;
}

/**
 * The write door for a label CREATE, asked as the importer: the dd1706 section
 * and its value component (pair level 2). A refusal is the field's refusal
 * sentence; anything else propagates.
 */
async function labelCreateRefusal(principal: Principal): Promise<string | null> {
	try {
		await authorizeSectionTarget(
			principal,
			{ section_tipo: LABEL_SECTION, tipo: LABEL_VALUE },
			{ level: 2, door: 'import_iri_label.create' },
		);
		return null;
	} catch (error) {
		if (isFieldWriteRefusal(error)) {
			return `IGNORED: a new iri label needs a record in ${LABEL_SECTION}, which the importer may not create (${error.code}) — the field was NOT written`;
		}
		throw error;
	}
}

/** Create one dd1706 label (birth default project of the importer), attributed to the run. */
async function createLabel(text: string, scope: LabelResolveScope): Promise<number> {
	const sectionId = await createSectionRecord(LABEL_SECTION, scope.userId, new Date(), undefined, {
		bulkProcessId: scope.bulkProcessId,
	});
	const outcome = await saveComponentData({
		componentTipo: LABEL_VALUE,
		sectionTipo: LABEL_SECTION,
		sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value: [{ value: text }] }],
		userId: scope.userId,
		principal: scope.principal,
		bulkProcessId: scope.bulkProcessId,
	});
	if (outcome.ok === false) {
		throw new DedaloError('record.save_failed', {
			message: `iri label '${text}' could not be saved in ${LABEL_SECTION}/${sectionId}: ${outcome.message}`,
			coordinates: { section_tipo: LABEL_SECTION, tipo: LABEL_VALUE },
		});
	}
	return sectionId;
}

/**
 * The frame the editor writes for a label (relations/save.ts normalizes it:
 * the server stamps `main_component_tipo` + `id_key` from the save's caller
 * pairing, and the frame's own `id`).
 */
export function labelFrame(labelSectionId: number): Record<string, unknown> {
	return {
		type: DATAFRAME_RELATION_TYPE,
		section_tipo: LABEL_SECTION,
		section_id: labelSectionId,
		from_component_tipo: IRI_LABEL_SLOT,
	};
}

/** The record an iri column writes into, for the replace-mode id pre-allocation. */
export interface IriItemAddress {
	table: string;
	sectionTipo: string;
	sectionId: number;
	/** The tipo whose slot holds the data (an alias's target). */
	dataTipo: string;
}

/**
 * REPLACE mode: every LABELLED item gets its FINAL id before the save, so its
 * frame can pair with it (`id_key`):
 *
 *   - an item carrying a file id keeps it (set_data honours a present id);
 *   - an id-less item that DUPLICATES a stored item of its lang slice (the
 *     append merge's own iri equality) takes that stored item's id — so a
 *     re-import replaces the item AND its frame in place instead of leaving the
 *     old frame paired to a vanished id;
 *   - otherwise a counter id is allocated now, in the row transaction — after
 *     the stored AND incoming ids are absorbed, so the counter can never hand
 *     out an id another item of the save carries.
 *
 * The groups come back with the labelled items CLONED (the conform result is
 * never mutated) and `idOf` maps each ORIGINAL item reference to its id. A file
 * id that is not an integer >= 1 cannot be a frame's `id_key`: refused.
 */
export async function preallocateLabelledIds(
	groups: ReadonlyMap<string, unknown[]>,
	labelled: readonly LabelledIriItem[],
	address: IriItemAddress,
): Promise<{ groups: Map<string, unknown[]>; idOf: Map<object, number> }> {
	const run: PreallocationRun = {
		labelledItems: new Set<object>(labelled.map(({ item }) => item)),
		idOf: new Map<object, number>(),
		stored: [],
		address,
	};
	if (run.labelledItems.size === 0) return { groups: new Map(groups), idOf: run.idOf };
	const { table, sectionTipo, sectionId, dataTipo } = address;
	run.stored =
		(await readMatrixKeyForUpdate(table, sectionTipo, sectionId, IRI_COLUMN, dataTipo)) ?? [];
	const incoming = [...groups.values()].flat();
	await absorbComponentItemIds(table, sectionTipo, sectionId, dataTipo, [
		...run.stored,
		...incoming,
	]);
	const out = new Map<string, unknown[]>();
	for (const [lang, items] of groups) out.set(lang, await prepareLangGroup(run, lang, items));
	return { groups: out, idOf: run.idOf };
}

/** One pre-allocation pass: the labelled item set, the ids handed out, the stored slot. */
interface PreallocationRun {
	labelledItems: ReadonlySet<object>;
	idOf: Map<object, number>;
	stored: readonly unknown[];
	address: IriItemAddress;
}

/** One lang group with each labelled item cloned under its final id. */
async function prepareLangGroup(
	run: PreallocationRun,
	lang: string,
	items: readonly unknown[],
): Promise<unknown[]> {
	const used = new Set(items.filter(isObject).map((item) => String(item.id ?? '')));
	const prepared: unknown[] = [];
	for (const item of items) {
		if (!isObject(item) || !run.labelledItems.has(item)) {
			prepared.push(item);
			continue;
		}
		const id = await labelledItemId(run, item, lang, used);
		used.add(String(id));
		run.idOf.set(item, id);
		prepared.push({ ...item, id });
	}
	return prepared;
}

/** A labelled item's final id: its file id, else a stored duplicate's, else a fresh counter id. */
async function labelledItemId(
	run: PreallocationRun,
	item: Record<string, unknown>,
	lang: string,
	used: ReadonlySet<string>,
): Promise<number> {
	const { table, sectionTipo, sectionId, dataTipo } = run.address;
	if (hasFileId(item)) return fileItemId(item.id, dataTipo);
	return (
		storedDuplicateId(run.stored, item, lang, used) ??
		(await allocateComponentItemId(table, sectionTipo, sectionId, dataTipo))
	);
}

function hasFileId(item: Record<string, unknown>): boolean {
	return item.id !== undefined && item.id !== null && item.id !== '';
}

/** The id of a stored item of `lang` the incoming item duplicates (iri equality), not yet claimed. */
function storedDuplicateId(
	stored: readonly unknown[],
	item: Record<string, unknown>,
	lang: string,
	used: ReadonlySet<string>,
): number | null {
	for (const id of literalDuplicateIds(stored, item, 'iri', lang)) {
		const numeric = Number(id);
		if (Number.isSafeInteger(numeric) && numeric >= 1 && !used.has(String(numeric))) {
			return numeric;
		}
	}
	return null;
}

/** A labelled item's file id as a frame pairing (an integer >= 1), else a loud refusal. */
function fileItemId(id: unknown, dataTipo: string): number {
	const numeric = Number(id);
	if (Number.isSafeInteger(numeric) && numeric >= 1) return numeric;
	throw new DedaloError('request.invalid_data', {
		message: `a labelled iri item of '${dataTipo}' carries id '${String(id)}', which cannot pair its label frame (an integer >= 1 is required)`,
		coordinates: { tipo: dataTipo },
	});
}

/**
 * APPEND mode: the import-local key a labelled item WITHOUT a file id carries
 * into the append save, so the save's `appendedIdMap` (file id → final id;
 * a skipped duplicate maps to the EXISTING item) can name its final id. The
 * merge strips every incoming file id from the stored item (append_merge.ts
 * newLiteralItem), so the key is never stored. The '#' prefix and the lang +
 * position make it collide with no real file id and with no other item of
 * the cell, in any language.
 */
export function appendLabelKey(lang: string, index: number): string {
	return `#t012-label:${lang}:${index}`;
}
