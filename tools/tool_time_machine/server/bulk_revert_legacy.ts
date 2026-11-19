/**
 * BULK REVERT — THE LEGACY PATH: a key the run wrote WITHOUT a BEFORE row
 * (every run made before the undo log, 2026-09-27, WC-…-bulk-revert-undo-log
 * §2.6). Its pre-run value is INFERRED from the visible history, as the
 * revert always did, with four fixes:
 *
 *   1. PER-LANGUAGE HISTORY for a lang-sliced key (`legacyLangHistory`): only
 *      rows that speak for the key's language are eligible — tagged with it,
 *      carrying items of it, or a record WIPE (closes WC-2026-08-27's
 *      Residual). A slice row of another language is never this language's
 *      pre-run state, and an all-language row (tool_lang, propagate, the
 *      duplicate backfill) is read as ITS slice of this language only.
 *   2. THE PRE-RUN ROW is the newest eligible row OLDER THAN THE RUN'S EARLIEST
 *      ROW of this key — never a row written between two of the run's rows.
 *   3. CONFLICT: the live main, cut to what the key's last run row speaks
 *      for, must equal that row, and EVERY slot the frame plan writes must
 *      hold the frames the MAIN's last run row (any tag) recorded there (none
 *      recorded = none expected) — else the main changed after the run and the
 *      revert refuses (`changed_since_run`) instead of destroying the change.
 *   4. NO PRE-RUN ROW: blank the key only when the RECORD was born in the run
 *      (its `created_date` at or after the run's dd800 `created_date` —
 *      `legacy_born_in_run`); otherwise refuse (`no_pre_batch_state`). A
 *      record older than the run whose key has no history was written with the
 *      time machine off, migrated, or imported: blanking it would destroy data
 *      no row recorded.
 *
 * WHAT IT CANNOT SEE — and why every legacy write is reported `inexact`: a
 * write that left no row (a save with the time machine off BETWEEN the newest
 * pre-run row and the run) makes that row STALE, and nothing in a legacy log
 * tells it apart from a current one. Runs made under the undo log carry the
 * exact BEFORE image and never take this path.
 *
 * THE FRAME HALF IS ONE PER MAIN. Frames are language-blind state: a legacy
 * main's keys (one per tag, a v6 lg-nolan slot save included) form ONE unit
 * (bulk_revert_plan.ts), each restores its own main region, and its LAST key
 * carries the frames (`LegacyContext.frameUnit`): restored once from the
 * newest row of the main in ANY tag older than the run's earliest row of the
 * main, checked once against the main's last run row in any tag. Split per
 * tag, one tag's unit rewound frames a sibling tag's unit then read as a
 * post-run edit.
 *
 * ONE READING RULE (decision 2026-09-28): every row of a main is the FULL
 * state of the main and ALL its dataframes, so a slot a row is silent about
 * was empty then and the revert EMPTIES the main's own frames there
 * (rowSlotTipos) — no frameless refusal, no per-row provenance. The scope gate
 * checked the caller's grant on the unit's `slotTipos`; a frame half that
 * would change any other slot (a live or pre-run slot no run row names) needs
 * the caller's level 2 on it, else the unit is refused `out_of_scope`.
 *
 * A run's row on a dataframe SLOT tipo (TS-era beta shape,
 * PHP never wrote one) never reaches this path: the plan refuses it `failed`.
 */

import { canonicalJson } from '../../../src/core/concepts/canonical_json.ts';
import { sql } from '../../../src/core/db/postgres.ts';
import {
	ensureTmHistoryReady,
	tmEpochPredicate,
	tmVisiblePredicate,
	withTmHistory,
} from '../../../src/core/db/record_generation.ts';
import { readOtherLangItemIds } from '../../../src/core/db/time_machine.ts';
import { getTranslatableByTipo } from '../../../src/core/ontology/resolver.ts';
import {
	isFrameEntry,
	isFramesOnlyImage,
	isOwnFrame,
	readMainSlots,
	rowSlotTipos,
	splitComposed,
} from '../../../src/core/relations/dataframe_slots.ts';
import { getPermissions, type Principal } from '../../../src/core/security/permissions.ts';
import { mergeRestoredLangSlice } from '../../../src/core/tm_record/lane_state.ts';
import { normalizeRestoredSectionIds } from '../../../src/core/update/transform/section_id_restore.ts';
import type { BulkRevertInexactBasis } from './bulk_revert.ts';
import {
	describeKey,
	type KeyPlan,
	type KeyTarget,
	type RevertKey,
	RevertRefusal,
	type RevertUnit,
	type RunRow,
} from './bulk_revert_plan.ts';
import {
	DataframeRestoreError,
	type DataframeSlotRestore,
	type FrameSlice,
	framePlanIsNoop,
	frameSliceOf,
	framesOnlySlice,
	keepsLiveFrame,
	planDataframeRestore,
} from './dataframe_restore.ts';

export interface LegacyContext {
	target: KeyTarget;
	/** The live record's `created_date`, or null when it carries none. */
	recordCreatedDate: string | null;
	/** The run's dd800 `created_date`, or null when unknown. */
	runCreatedDate: string | null;
	/** The run being reverted. */
	bulkId: number;
	/**
	 * The main's unit when this key carries the frame half (its keys, and the
	 * slots the scope gate checked — `slotTipos`); null = its main region only.
	 */
	frameUnit: RevertUnit | null;
	/** The caller: a slot outside `frameUnit.slotTipos` is written only on its level-2 grant. */
	principal: Principal;
	/**
	 * The planned key value AS THE WRITE STORES IT — the key's lane through the
	 * save's value gates (bulk_revert_undo.ts judgedKeyValue; the write door
	 * gates it for real). Injected, as the unit's other doors are: this module
	 * is imported by the one that owns the write.
	 */
	asWritten: (value: unknown) => Promise<unknown>;
}

/** A plan that writes. */
type WritePlan = Extract<KeyPlan, { kind: 'write' }>;

interface HistoryRow {
	id: number;
	lang: string | null;
	data: unknown;
}

/**
 * THE PER-LANGUAGE HISTORY of a lang-sliced component (SQL predicate over an
 * UNALIASED `matrix_time_machine`, `param` the bound language). A row belongs
 * to language L when it is TAGGED L, when its data CARRIES items of L whatever
 * its tag (untagged pre-migration rows; the writers that tag one language but
 * store all), or when it has a record WIPE's shape: a null row that is
 * untagged, or that has a null SIBLING row (another component of the same
 * record, same timestamp — `delete_data` empties several keys at once). A LONE
 * null row tagged with another language is that language's per-language CLEAR
 * (PHP wrote null when a curator emptied one language) and says nothing
 * about L.
 */
function legacyLangHistory(param: string): string {
	const isNull = (alias: string) =>
		`(${alias}.data IS NULL OR jsonb_typeof(${alias}.data) = 'null')`;
	const wipeSibling = `EXISTS (
		SELECT 1 FROM matrix_time_machine wipe_sibling
		WHERE wipe_sibling.section_tipo = matrix_time_machine.section_tipo
		  AND wipe_sibling.section_id = matrix_time_machine.section_id
		  AND wipe_sibling.timestamp = matrix_time_machine.timestamp
		  AND wipe_sibling.tipo <> matrix_time_machine.tipo
		  AND ${isNull('wipe_sibling')}
		  AND ${tmEpochPredicate('wipe_sibling')} AND ${tmVisiblePredicate('wipe_sibling')})`;
	const legacyWipe = `(${isNull('matrix_time_machine')} AND (matrix_time_machine.lang IS NULL OR matrix_time_machine.lang = '' OR ${wipeSibling}))`;
	const carries = `(jsonb_typeof(matrix_time_machine.data) = 'array' AND matrix_time_machine.data @> jsonb_build_array(jsonb_build_object('lang', ${param}::text)))`;
	return `(matrix_time_machine.lang = ${param}::text OR ${legacyWipe} OR ${carries})`;
}

/**
 * The newest eligible history row OLDER than the run's earliest row of this
 * key. `anyLangBefore`: the FRAME half's pre-run row instead — eligible in ANY
 * language (every row is the full state of the main's frames, whatever its
 * tag: a v6 slot save of a translatable main is tagged lg-nolan and would
 * never be its language's own row, yet it is the newest state of the frames)
 * and older than `anyLangBefore`, the run's earliest row of the MAIN in any
 * tag (another language's run row already carries the run's frames).
 */
async function preRunRow(
	key: RevertKey,
	anyLangBefore: number | null = null,
): Promise<HistoryRow | null> {
	await ensureTmHistoryReady();
	const before = anyLangBefore ?? key.rows[0]?.id ?? 0;
	const params: unknown[] = [key.tipo, key.sectionTipo, key.sectionId, before];
	let langClause = '';
	if (anyLangBefore === null && key.sliced) {
		params.push(key.lang);
		langClause = `AND ${legacyLangHistory('$5')}`;
	}
	// P0-14 + visibility: a dead generation's row, or a hidden undo-log image,
	// is never eligible to become the pre-run state.
	const rows = (await sql.unsafe(
		`SELECT id, lang, data FROM matrix_time_machine
		 WHERE ${withTmHistory(
				`matrix_time_machine.tipo = $1 AND matrix_time_machine.section_tipo = $2
				 AND matrix_time_machine.section_id = $3 AND matrix_time_machine.id < $4 ${langClause}`,
			)}
		 ORDER BY matrix_time_machine.id DESC LIMIT 1`,
		params,
	)) as HistoryRow[];
	const row = rows[0];
	return row === undefined ? null : { ...row, id: Number(row.id) };
}

/** An item with no language of its own (no `lang`, '' or null — PHP-era data). */
function isLanglessItem(item: unknown): item is Record<string, unknown> {
	if (item === null || typeof item !== 'object') return false;
	const itemLang = (item as { lang?: unknown }).lang;
	return itemLang === undefined || itemLang === null || itemLang === '';
}

/**
 * A history snapshot as its slice of ONE language. An item of `lang` is kept
 * verbatim; a LANG-LESS item belongs to the language its ROW is tagged with,
 * so it joins only when `rowTag === lang` — stamped with that language, as a
 * save of the slice stamps it. A row tagged another language (or none) adopts
 * nothing; another language's items never join; a non-array snapshot (SQL
 * NULL, a scalar, a wipe) is the EMPTY slice. `adoptsLangless`: the live
 * value's own lang-less items are then this language's too, and are replaced.
 */
export function preBatchLangSlice(
	snapshot: unknown,
	lang: string,
	rowTag: string | null | undefined,
): { items: unknown[]; adoptsLangless: boolean } {
	if (!Array.isArray(snapshot)) return { items: [], adoptsLangless: false };
	const items: unknown[] = [];
	let adoptsLangless = false;
	for (const item of snapshot) {
		if (item === null || typeof item !== 'object') continue;
		if ((item as { lang?: unknown }).lang === lang) {
			items.push(item);
		} else if (rowTag === lang && isLanglessItem(item)) {
			items.push({ ...item, lang });
			adoptsLangless = true;
		}
	}
	return { items, adoptsLangless };
}

/** A snapshot with its section ids int-canonical (WC-2026-08-10 D6.2). */
async function canonicalSnapshot(data: unknown): Promise<unknown> {
	const container = { value: data };
	await normalizeRestoredSectionIds(container);
	return container.value;
}

/**
 * The comparable text of a key value as the run's last row speaks for it:
 * frames stripped from a main, cut to the key's language for a sliced key,
 * and absent/null read as empty (a legacy row cannot tell them apart).
 */
function legacyComparable(key: RevertKey, value: unknown): string {
	const present = value === undefined || value === null ? [] : value;
	if (!Array.isArray(present)) return canonicalJson(present);
	const items = splitComposed(present).main as unknown[];
	return canonicalJson(
		key.sliced
			? items.filter((item) => (item as { lang?: unknown } | null)?.lang === key.lang)
			: items,
	);
}

/** Refuse, as changed after the run (fix 3). */
function changedSinceRun(key: RevertKey, what: string): RevertRefusal {
	return new RevertRefusal(
		'changed_since_run',
		key,
		`${describeKey(key)} changed after the run (legacy ${what})`,
	);
}

/** Whether the live main region differs from the key's last run row (fix 3). */
async function mainChangedSinceRun(key: RevertKey, live: unknown): Promise<boolean> {
	const lastValue = await canonicalSnapshot(key.rows.at(-1)?.data ?? null);
	const liveValue = await canonicalSnapshot(live);
	return legacyComparable(key, liveValue) !== legacyComparable(key, lastValue);
}

/**
 * Whether any slot the plan WRITES holds live OWN frames other than the run
 * left there. Per slot: the reference is the MAIN's last run row in any tag
 * (the full state after the run — a slot it is silent about was left empty),
 * its own frames of that slot compared with the live ones as a canonical
 * multiset, section ids int-canonical, minus the frames the write keeps live
 * (keepsLiveFrame over the half's FrameSlice — the check's scope IS the
 * write's scope).
 */
async function framesChangedSinceRun(
	key: RevertKey,
	context: LegacyContext,
	half: FrameHalf,
): Promise<boolean> {
	const target = {
		table: context.target.table,
		sectionTipo: key.sectionTipo,
		sectionId: key.sectionId,
	};
	const slots = await readMainSlots(target, key.tipo);
	const lastSnapshot = await canonicalSnapshot(half.lastRow.data);
	const lastPlan = await legacyFramePlan(
		key,
		lastSnapshot,
		half.plan.map((entry) => entry.slotTipo),
	);
	for (const entry of half.plan) {
		const recorded = lastPlan.find((last) => last.slotTipo === entry.slotTipo)?.frames ?? [];
		const image = slots.images[entry.slotTipo];
		const liveFrames = (Array.isArray(image) ? image : []).filter(
			(frame): frame is Record<string, unknown> =>
				isFrameEntry(frame) && isOwnFrame(frame, key.tipo),
		);
		const liveCanonical = (await canonicalSnapshot(liveFrames)) as Record<string, unknown>[];
		const inScope = (frame: Record<string, unknown>) => !keepsLiveFrame(frame, half.slice);
		if (frameMultiset(recorded, inScope) !== frameMultiset(liveCanonical, inScope)) {
			return true;
		}
	}
	return false;
}

/** A canonical, order-blind text of the frames `inScope` admits. */
function frameMultiset(
	frames: readonly Record<string, unknown>[],
	inScope: (frame: Record<string, unknown>) => boolean,
): string {
	return JSON.stringify(frames.filter(inScope).map(canonicalJson).sort());
}

/**
 * The frame plan of a legacy main's (composed) snapshot, refused `failed` where
 * applying it would corrupt. The snapshot's silence empties every slot in
 * `slots` (rowSlotTipos — the row is the full state of the main and all its
 * dataframes).
 */
async function legacyFramePlan(
	key: RevertKey,
	snapshot: unknown,
	slots: readonly string[],
): Promise<DataframeSlotRestore[]> {
	try {
		return await planDataframeRestore(key.tipo, snapshot, slots);
	} catch (error) {
		if (!(error instanceof DataframeRestoreError)) throw error;
		throw new RevertRefusal('failed', key, error.message);
	}
}

/**
 * The MAIN half of a key: the value its pre-run row restores over the live
 * value. A lang-sliced key merges its language's slice into the live value
 * (the other languages stay as they are); an unsliced key is the row's main.
 */
async function legacyMainValue(key: RevertKey, row: HistoryRow, live: unknown): Promise<unknown> {
	const mainData = splitComposed(await canonicalSnapshot(row.data)).main;
	if (!key.sliced) return mainData;
	const { items, adoptsLangless } = preBatchLangSlice(mainData, key.lang, row.lang);
	const liveItems = Array.isArray(live) ? live : [];
	const mergeBase = adoptsLangless ? liveItems.filter((item) => !isLanglessItem(item)) : liveItems;
	return mergeRestoredLangSlice(mergeBase, items, new Set([key.lang]));
}

/**
 * Whether the RECORD has visible history of its own (any component, any
 * language) older than `earliest` (the run's earliest row of the key, or of
 * the main for the frame half) and not written by
 * the run: then it existed before the run, whatever its `created_date` says.
 * The date alone has one-second resolution — a record created in the same
 * second as the run's dd800 would otherwise read as born in the run.
 */
async function recordHasPreRunHistory(
	key: RevertKey,
	earliest: number,
	bulkId: number,
): Promise<boolean> {
	await ensureTmHistoryReady();
	const rows = (await sql.unsafe(
		`SELECT 1 FROM matrix_time_machine
		 WHERE ${withTmHistory(
				`matrix_time_machine.section_tipo = $1 AND matrix_time_machine.section_id = $2
				 AND matrix_time_machine.id < $3
				 AND matrix_time_machine.bulk_process_id IS DISTINCT FROM $4`,
			)}
		 LIMIT 1`,
		[key.sectionTipo, key.sectionId, earliest, bulkId],
	)) as unknown[];
	return rows.length > 0;
}

/** No pre-run row: allowed only for a record born in the run (fix 4), else refuse. */
async function assertBornInRun(
	key: RevertKey,
	context: LegacyContext,
	earliest: number,
): Promise<void> {
	const { recordCreatedDate, runCreatedDate } = context;
	if (
		recordCreatedDate === null ||
		runCreatedDate === null ||
		recordCreatedDate < runCreatedDate ||
		(await recordHasPreRunHistory(key, earliest, context.bulkId))
	) {
		throw new RevertRefusal('no_pre_batch_state', key, `${describeKey(key)}: no pre-run history`);
	}
}

/** The MAIN half of a key (fix 4 when it has no pre-run row: blank its region). */
async function legacyMainHalf(
	key: RevertKey,
	live: unknown,
	context: LegacyContext,
): Promise<{ value: unknown; inexact: BulkRevertInexactBasis }> {
	const row = await preRunRow(key);
	if (row !== null) {
		return { value: await legacyMainValue(key, row, live), inexact: 'legacy_inference' };
	}
	await assertBornInRun(key, context, key.rows[0]?.id ?? 0);
	const liveItems = Array.isArray(live) ? live : [];
	const value = key.sliced
		? liveItems.filter((item) => {
				const itemLang = (item as { lang?: unknown } | null)?.lang;
				return typeof itemLang === 'string' && itemLang !== '' && itemLang !== key.lang;
			})
		: undefined;
	const blank = Array.isArray(value) && value.length === 0 ? undefined : value;
	return { value: blank, inexact: 'legacy_born_in_run' };
}

/** The frame half of a main (see the header), planned by the unit's carrier key. */
interface FrameHalf {
	plan: DataframeSlotRestore[];
	/** The half's item scope: its survivors' frames are neither written nor checked. */
	slice: FrameSlice | null;
	/** The main's last run row in any tag: the conflict reference. */
	lastRow: RunRow;
	inexact: BulkRevertInexactBasis;
}

/**
 * THE FRAME HALF of a main, once per unit: the frames of the newest row of the
 * main in ANY tag older than the run's earliest row of the main (none: a
 * record born in the run had no frames), over every slot the rows name.
 *
 * Its item scope (FrameSlice), `value` being the main as the unit leaves it:
 *   - an unsliced main: the whole main;
 *   - a unit holding a frames-only key (a v6 slot save, isAllLangImage): every
 *     own frame, minus a frame of an item deleted since (framesOnlySlice);
 *   - else the unit's languages: the frames of LIVE items no restored item
 *     holds stay live, and are outside the conflict check. An item id shared
 *     across languages (translations of one row share it) is a restored item:
 *     its frame is written, so it is checked.
 */
async function legacyFrameHalf(
	key: RevertKey,
	value: unknown,
	context: LegacyContext,
	unit: readonly RevertKey[],
): Promise<FrameHalf> {
	const rows = unit.flatMap((member) => member.rows).sort((a, b) => a.id - b.id);
	const earliest = rows[0]?.id ?? 0;
	const lastRow = rows.at(-1) as RunRow;
	const row = await preRunRow(key, earliest);
	if (row === null) await assertBornInRun(key, context, earliest);
	const snapshot = row === null ? [] : await canonicalSnapshot(row.data);
	const target = {
		table: context.target.table,
		sectionTipo: key.sectionTipo,
		sectionId: key.sectionId,
	};
	// Under the unit's row lock: the live record's slots of the main count too.
	const plan = await legacyFramePlan(
		key,
		snapshot,
		await rowSlotTipos(key.tipo, [snapshot, ...rows.map((run) => run.data)], target),
	);
	const inexact = row === null ? 'legacy_born_in_run' : 'legacy_inference';
	const whole = { plan, lastRow, inexact } as const;
	if (!unit.some((member) => member.sliced)) return { ...whole, slice: null };
	const coords = {
		sectionTipo: key.sectionTipo,
		sectionId: key.sectionId,
		componentTipo: key.tipo,
	};
	if (await someAsync(unit, isAllLangImage)) {
		const slice =
			row === null ? frameSliceOf([], value) : await framesOnlySlice(coords, row.id, value);
		return { ...whole, slice };
	}
	const langs = unit.map((member) => member.lang);
	const langOf = (item: unknown) => (item as { lang?: unknown } | null)?.lang;
	const items = Array.isArray(value) ? value : [];
	const restored = items.filter((item) => langs.includes(langOf(item) as string));
	const otherLangIds =
		row === null ? new Set<string>() : await readOtherLangItemIds(coords, langs, row.id);
	return { ...whole, slice: frameSliceOf(restored, value, otherLangIds) };
}

/** Whether `test` holds for some member (awaited in order). */
async function someAsync<T>(
	list: readonly T[],
	test: (item: T) => Promise<boolean>,
): Promise<boolean> {
	for (const item of list) if (await test(item)) return true;
	return false;
}

/** The non-frame items of a row's image. */
function mainItemsOf(data: unknown): unknown[] {
	const { main } = splitComposed(data);
	return Array.isArray(main) ? main : [];
}

/**
 * A FRAMES-ONLY key (relations/dataframe_slots.ts isFramesOnlyImage — apply_value's
 * predicate): a v6 slot save of a lang-sliced main, tagged with the
 * dataframe's language. It speaks for no language of the main, which is left
 * live (its languages are the run's language keys): only the frame half — one
 * per main — reverts what it changed.
 */
async function isAllLangImage(key: RevertKey): Promise<boolean> {
	return isFramesOnlyImage({
		sliced: key.sliced,
		translatable: key.sliced && (await getTranslatableByTipo(key.tipo)),
		rowLang: key.lang,
		mainItems: key.rows.flatMap((row) => mainItemsOf(row.data)),
	});
}

/**
 * Refuse (`out_of_scope`) a frame half that would change a slot the scope gate
 * did not check (outside the unit's `slotTipos`: a live or pre-run slot no run
 * row names) and the caller holds no level 2 on.
 */
async function assertSlotGrants(
	key: RevertKey,
	record: { table: string; sectionTipo: string; sectionId: number },
	plan: WritePlan,
	context: LegacyContext,
): Promise<void> {
	const gated = context.frameUnit?.slotTipos ?? [];
	for (const slot of plan.framePlan) {
		if (gated.includes(slot.slotTipo)) continue;
		if (await framePlanIsNoop(record, key.tipo, [slot], plan.frameSlice ?? null)) continue;
		if ((await getPermissions(context.principal, key.sectionTipo, slot.slotTipo)) >= 2) continue;
		throw new RevertRefusal(
			'out_of_scope',
			key,
			`${describeKey(key)}: no write grant on slot ${slot.slotTipo}`,
		);
	}
}

/**
 * Whether the live key already holds the inferred pre-run value — as the
 * history row recorded it, or as the write stores it (the value gates: a key an
 * earlier revert put back CLEANED is at its target too, not changed since).
 */
async function mainAtTarget(
	planned: unknown,
	live: unknown,
	context: LegacyContext,
): Promise<boolean> {
	const liveText = canonicalJson(live);
	if (canonicalJson(planned) === liveText) return true;
	return canonicalJson(await context.asWritten(planned)) === liveText;
}

/**
 * Plan one legacy key over its live value (see the header): its main region,
 * and — the unit's carrier only — the main's frame half. A key already at the
 * inferred pre-run value is `unchanged` BEFORE the conflict check, as on the
 * exact path: a second revert of the same run writes nothing and reports
 * nothing alarming.
 */
export async function planLegacyKey(
	key: RevertKey,
	live: unknown,
	context: LegacyContext,
): Promise<KeyPlan> {
	if (key.sliced && key.lang === '') {
		throw new RevertRefusal('no_lang', key, `${describeKey(key)}: no language can be named`);
	}
	// A frames-only key leaves the main live: its languages are their own keys'.
	const framesOnly = await isAllLangImage(key);
	if (framesOnly && context.frameUnit === null) return { kind: 'unchanged' };
	const main = framesOnly
		? { value: live, inexact: null }
		: await legacyMainHalf(key, live, context);
	const half =
		context.frameUnit === null
			? null
			: await legacyFrameHalf(key, main.value, context, context.frameUnit.keys);
	const plan: WritePlan = {
		kind: 'write',
		value: main.value,
		framePlan: half?.plan ?? [],
		frameSlice: half?.slice ?? null,
		inexact: main.inexact ?? half?.inexact ?? 'legacy_inference',
	};
	// A main with a declared slot ALWAYS has a frame plan (every slot is named,
	// frames or not), so "already restored" asks whether applying it would change
	// anything — never its length, or a second revert is refused changed_since_run.
	const record = {
		table: context.target.table,
		sectionTipo: key.sectionTipo,
		sectionId: key.sectionId,
	};
	const framesAtTarget = await framePlanIsNoop(
		record,
		key.tipo,
		plan.framePlan,
		plan.frameSlice ?? null,
	);
	if (context.frameUnit !== null && !framesAtTarget) {
		await assertSlotGrants(key, record, plan, context);
	}
	if (framesAtTarget && (await mainAtTarget(plan.value, live, context))) {
		return { kind: 'unchanged' };
	}
	if (!framesOnly && (await mainChangedSinceRun(key, live))) throw changedSinceRun(key, 'main');
	if (half !== null && !framesAtTarget && (await framesChangedSinceRun(key, context, half))) {
		throw changedSinceRun(key, 'frames');
	}
	return plan;
}
