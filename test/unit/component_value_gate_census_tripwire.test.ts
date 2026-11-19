/**
 * TRIPWIRE — EVERY WRITER OF THE RECORD CHOKEPOINT IS CLASSIFIED BY THE VALUE
 * GATE (T1-14 / OX7, WC-2026-11-12-translation-write-value-gates).
 *
 * THE DEFECT CLASS. The write engine's value gates (`applyWriteValueGates`,
 * src/core/section/record/write_value_gates.ts: password hash, rich-text
 * sanitize + WC-042 media-src relativize) were documented as the place "EVERY
 * door funnels through". Automatic translation did not: it stored the
 * provider's markup through `persistRecordKeys`, the model-agnostic chokepoint,
 * and an `html` value the client renders unescaped reached the matrix raw.
 * The chokepoint itself cannot gate (it writes keys whose model it does not
 * know — relations, counters, ontology rows, TM replays), so the claim lives at
 * the writers, and this census makes it mechanical.
 *
 * TOTAL BY DERIVATION — OF THE ENTRIES TOO. The chokepoint's VALUE-CARRYING
 * entries are not a hand list: they are every runtime export of
 * `section_record/record_write.ts` named `persist*` (derived from the module on
 * every run, matrix_writer_closure.ts moduleRuntimeExports), so an entry added
 * tomorrow is walked the day it lands. The callers are DERIVED from the
 * import-resolved call graph of the write-path corpus
 * (test/helpers/matrix_writer_closure.ts: `src/`, `tools/`, `scripts/`): every
 * top-level declaration with a PRECISE (resolved, never a namespace escape) edge
 * to one of them, re-exports followed. A caller with no row is RED; a row whose
 * caller vanished is RED.
 *
 * EVERY ENTRY IS WALKED since 2026-11-18 (C58, owner ruling "every save the
 * same way, no exceptions"). Before, five entries were "named, not derived" —
 * `persistAppendedKeyItems`, `persistRelationRemovalKeys`,
 * `persistObserverMirrorKeys`, `persistObserverResaveKeys`,
 * `persistModifiedStamp` — so a new door on one of them was never asked for a
 * row. Who may TAKE each entry is still write_obligations_tripwire leg B4; what
 * VALUE its callers carry is this census.
 *
 * VERDICTS:
 *   gated                — the caller writes component VALUES it did not read
 *                          from storage. CHECKED: it reaches
 *                          `write_value_gates.ts#applyWriteValueGates` LOCALLY —
 *                          through precise edges that stay inside its own file
 *                          or the gate module (a same-file helper is fine; a
 *                          path through some unrelated engine is not proof that
 *                          THIS write is gated — nor is a path through ANOTHER
 *                          chokepoint writer: its gate is its own write's). The
 *                          outcome half is
 *                          translation_write_gates_native + the split-origin
 *                          child (text_area_media_src_split_origin).
 *   non_literal          — the keys written carry no user-authored literal
 *                          value; the row's `reason` names the MECHANISM, in
 *                          the code's own terms (locators only; the stored
 *                          value minus what is removed; a permutation of the
 *                          stored value; an empty value; engine-computed
 *                          numbers; an engine-authored label).
 *
 * NO `exact_revert` VERDICT ANY MORE (C58, owner ruling 2026-11-18,
 * WC-2026-11-17-tm-restore-value-gates addendum). The bulk revert's four
 * writers — `writeRevertedKey`, `writeComposedUnit`, `writeWipedKey` and the
 * undelete `restoreAbsentSectionRow` — replayed their undo-log images
 * verbatim, on the argument that a revert is exact by contract. Ruled: every
 * save is done the same way. All four are `gated` (each gates what it writes,
 * in its own file), and "exact" now means the pre-run value AS A SAVE STORES
 * IT. Outcome half: translation_write_gates_native B1–B6.
 *
 * NO `replays_stored_image` VERDICT EITHER (C58, 2026-11-17). The Time Machine
 * restore doors replayed a stored image raw (N1 of T1-14): a history row
 * written before a gate existed came back ungated. All THREE are `gated` — the
 * component restore (`toolTimeMachineApplyValue` → `persistRestoredKeys`), the
 * whole-record restore and the dataframe replay — a replay is a write of a
 * component value like any other. Outcome half: translation_write_gates_native
 * (R1–R5).
 *
 * So the verdict vocabulary is SHRINK-ONLY at two: a third verdict would be a
 * new class of ungated write, and the test below pins the set.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	buildWriterClosure,
	moduleRuntimeExports,
	type WriterClosure,
} from '../helpers/matrix_writer_closure.ts';

const RECORD_WRITE = 'src/core/section_record/record_write.ts';
const GATE_FILE = 'src/core/section/record/write_value_gates.ts';
const GATE = `${GATE_FILE}#applyWriteValueGates`;

/**
 * THE CHOKEPOINT'S VALUE-CARRYING ENTRIES, derived: every runtime export of
 * record_write.ts named `persist*`. Never a hand list — an entry added to the
 * module is walked on the next run.
 */
function chokepointEntries(recordWriteSource: string): string[] {
	return moduleRuntimeExports(recordWriteSource)
		.filter((name) => /^persist[A-Z]/.test(name))
		.sort()
		.map((name) => `${RECORD_WRITE}#${name}`);
}

/** The verdict vocabulary — SHRINK-ONLY (see the header). */
const VERDICTS = ['gated', 'non_literal'] as const;
type Verdict = (typeof VERDICTS)[number];
type Census = Readonly<Record<string, { verdict: Verdict; reason: string }>>;

const CENSUS: Census = {
	'src/core/section/record/save_component.ts#applySaveComponentData': {
		verdict: 'gated',
		reason: 'the save door: every changed_data value passes the gates before the merge',
	},
	'src/core/tools/translation.ts#translateAndWrite': {
		verdict: 'gated',
		reason:
			'automatic translation (tool_lang / tool_lang_multi): the provider result is gated (gateTranslatedItems) before the merge — T1-14',
	},
	'src/core/relations/parent.ts#persistTreeKeys': {
		verdict: 'non_literal',
		reason: 'tree parent/order relation keys (locators), no literal value',
	},
	'src/core/relations/children_orphan_sweep.ts#removeKey': {
		verdict: 'non_literal',
		reason: 'removes a dangling relation key; writes no value',
	},
	'src/core/security/ai_spend.ts#lockDay': {
		verdict: 'non_literal',
		reason: 'AI spend ledger day row: engine-computed numbers',
	},
	'src/core/security/ai_spend.ts#writeCounters': {
		verdict: 'non_literal',
		reason: 'AI spend ledger counters: engine-computed numbers',
	},
	'src/core/ontology/machine_name_reconcile.ts#persistImportedUnit': {
		verdict: 'non_literal',
		reason:
			'ontology package import rewrite: relocates machine names (ontology43/44) between keys of an imported package record — no html value, the package is the history',
	},
	'tools/tool_time_machine/server/bulk_revert.ts#createRevertBulkProcess': {
		verdict: 'non_literal',
		reason: 'the dd800 revert run record: an engine-authored label',
	},
	'tools/tool_time_machine/server/dataframe_restore.ts#applyDataframeRestore': {
		verdict: 'gated',
		reason:
			'restores a TM image of dataframe frames: each slot value passes gateComponentItems before the write — C58',
	},
	'tools/tool_time_machine/server/tool_time_machine.ts#restoreSectionRow': {
		verdict: 'gated',
		reason:
			'restores a whole TM section row image (persistRecordColumns): every component key passes gateReplayedColumns before the write — C58',
	},
	'tools/tool_time_machine/server/tool_time_machine.ts#toolTimeMachineApplyValue': {
		verdict: 'gated',
		reason:
			"apply_value's component restore (persistRestoredKeys): the row's OWN lane value passes gateReplayedValue (gatedLaneState) before the merge and the write — C58",
	},
	'src/core/section/record/wiped_filter_reconcile.ts#restoreWipedFilterKey': {
		verdict: 'non_literal',
		reason: 'puts a wiped project filter back: component_filter locators, no literal value',
	},
	'tools/tool_time_machine/server/tool_time_machine.ts#restoreAbsentSectionRow': {
		verdict: 'gated',
		reason:
			"the bulk revert's undelete (persistRecordBirth): every component key of the snapshot passes gateReplayedColumns before the insert — C58, owner ruling 2026-11-18",
	},
	'tools/tool_time_machine/server/bulk_revert_records.ts#writeWipedKey': {
		verdict: 'gated',
		reason:
			"a wiped key's pre-wipe items pass gatedSnapshotKey (gateReplayedColumns) before the write — C58, owner ruling 2026-11-18",
	},
	'tools/tool_time_machine/server/bulk_revert_undo.ts#writeRevertedKey': {
		verdict: 'gated',
		reason:
			'one reverted key: the lane it restores passes gatedKeyValue (gateReplayedValue) before the write — C58, owner ruling 2026-11-18',
	},
	'tools/tool_time_machine/server/bulk_revert_undo.ts#writeComposedUnit': {
		verdict: 'gated',
		reason:
			"a composed unit's keys: the main's restored lanes and every slot pass gatedComposedWrites before the write — C58, owner ruling 2026-11-18",
	},
	// --- the entries walked since 2026-11-18 (removal law, cascade-owned, stamp) ---
	'src/core/relations/save.ts#removePortalLocatorUnderGrant': {
		verdict: 'non_literal',
		reason:
			'portal locator delete (persistRelationRemovalKeys): writes the STORED key minus the removed locator — a subset of stored items, nothing authored',
	},
	'src/core/section/record/delete_record.ts#removeAllInverseReferences': {
		verdict: 'non_literal',
		reason:
			"the record delete's inverse-reference strip: column 'relation', each owner's STORED locators minus the ones naming the deleted record (null when none remain); persistModifiedStamp carries no value",
	},
	'src/core/section/record/delete_record.ts#deleteSectionData': {
		verdict: 'non_literal',
		reason:
			"the data wipe: every key is REMOVED (null), except component_filter, which takes the wiper's default project LOCATORS (wipedComponentValue); persistModifiedStamp carries no value",
	},
	'src/core/section/record/observers.ts#recomputeExternalRelation': {
		verdict: 'non_literal',
		reason:
			"the observer mirror recompute (persistObserverMirrorKeys): column 'relation' only — locators derived from stored truth",
	},
	'src/core/section/record/observers.ts#resaveObserverThroughSaveRules': {
		verdict: 'non_literal',
		reason:
			"the observer re-save (persistObserverResaveKeys): the key's STORED value as its own save rules leave it — today a PERMUTATION (applyKeySaveRules sorts a declared-order portal, never edits an item), behind the declared-`order` pre-gate",
	},
	'src/core/section/record/observers.ts#applyRefreshDataClear': {
		verdict: 'non_literal',
		reason: 'the refresh_data clear (persistObserverResaveKeys): writes the EMPTY value `[]`',
	},
};

/** Declarations with a precise edge to a chokepoint entry, sorted. */
function deriveCallers(closure: WriterClosure, entries: readonly string[]): string[] {
	const out: string[] = [];
	for (const key of closure.bodies.keys()) {
		if (key.startsWith(`${RECORD_WRITE}#`)) continue;
		const edges = closure.preciseEdgesOf(key);
		if (entries.some((entry) => edges.has(entry))) out.push(key);
	}
	return out.sort();
}

/**
 * Does `from` reach `target` through precise edges confined to its own file and
 * the gate module? (BFS; the whole-corpus `reachesPrecisely` is too loose here —
 * nearly everything reaches the save door somewhere.) The walk never passes
 * THROUGH another chokepoint writer (`doors`): a gate that writer reaches gates
 * ITS write, not this one's — `toolTimeMachineApplyValue` also calls the
 * whole-record restore in its own file, whose gate says nothing about the
 * component restore's.
 */
function gatesLocally(
	closure: WriterClosure,
	from: string,
	doors: readonly string[],
	target: string = GATE,
): boolean {
	const ownFile = from.split('#')[0] as string;
	const allowed = (key: string): boolean => {
		const file = key.split('#')[0];
		return (file === ownFile || file === GATE_FILE) && !doors.includes(key);
	};
	const seen = new Set<string>([from]);
	const queue = [from];
	while (queue.length > 0) {
		const key = queue.shift() as string;
		for (const next of closure.preciseEdgesOf(key)) {
			if (next === target) return true;
			if (seen.has(next) || !allowed(next)) continue;
			seen.add(next);
			queue.push(next);
		}
	}
	return false;
}

/** Every census violation for `closure` against `census` (empty = green). */
function violations(closure: WriterClosure, census: Census, entries: readonly string[]): string[] {
	const derived = deriveCallers(closure, entries);
	const out: string[] = [];
	for (const caller of derived) {
		const row = census[caller];
		if (row === undefined) {
			out.push(`unclassified chokepoint writer: ${caller}`);
			continue;
		}
		if (row.reason.trim() === '') out.push(`row without a reason: ${caller}`);
		if (!VERDICTS.includes(row.verdict)) out.push(`unknown verdict '${row.verdict}': ${caller}`);
		if (row.verdict === 'gated' && !gatesLocally(closure, caller, derived)) {
			out.push(`'gated' but does not reach ${GATE} locally: ${caller}`);
		}
	}
	for (const caller of Object.keys(census)) {
		if (!derived.includes(caller)) out.push(`stale row (no longer a chokepoint writer): ${caller}`);
	}
	return out.sort();
}

const TM_SERVER = 'tools/tool_time_machine/server';
/** Every door that REPLAYS a stored image (Time Machine restores, the bulk revert's writers). */
const REPLAY_DOORS = [
	`${TM_SERVER}/tool_time_machine.ts#toolTimeMachineApplyValue`,
	`${TM_SERVER}/tool_time_machine.ts#restoreSectionRow`,
	`${TM_SERVER}/tool_time_machine.ts#restoreAbsentSectionRow`,
	`${TM_SERVER}/dataframe_restore.ts#applyDataframeRestore`,
	`${TM_SERVER}/bulk_revert_undo.ts#writeRevertedKey`,
	`${TM_SERVER}/bulk_revert_undo.ts#writeComposedUnit`,
	`${TM_SERVER}/bulk_revert_records.ts#writeWipedKey`,
];

describe('component value gate census (T1-14)', () => {
	const closure = buildWriterClosure();
	const entries = chokepointEntries(
		readFileSync(join(import.meta.dir, '../..', RECORD_WRITE), 'utf8'),
	);

	test('every chokepoint writer is classified; every gated row reaches the gate locally', () => {
		expect(violations(closure, CENSUS, entries)).toEqual([]);
	});

	test('the entries are DERIVED from the chokepoint module — all nine, none hand-listed', () => {
		// A new `persist*` export is walked the day it lands; this pin only makes
		// its author read the header (what value do its callers carry?).
		expect(entries.map((entry) => entry.split('#')[1])).toEqual([
			'persistAppendedKeyItems',
			'persistModifiedStamp',
			'persistObserverMirrorKeys',
			'persistObserverResaveKeys',
			'persistRecordBirth',
			'persistRecordColumns',
			'persistRecordKeys',
			'persistRelationRemovalKeys',
			'persistRestoredKeys',
		]);
		// each entry has a caller in the corpus (the walk reads real edges, not names)
		for (const entry of entries) {
			expect(deriveCallers(closure, [entry]), entry).not.toEqual([]);
		}
	});

	test('anti-vacuity: the value writers (save, translation, every replay door) are derived and gated', () => {
		const derived = deriveCallers(closure, entries);
		// the walk's floor: the census measured 22 chokepoint writers (2026-11-18:
		// 16 on the key/column/replay entries + 6 on the entries walked since)
		expect(derived.length).toBeGreaterThan(20);
		const gated = Object.entries(CENSUS)
			.filter(([, row]) => row.verdict === 'gated')
			.map(([key]) => key);
		expect(gated.length).toBeGreaterThanOrEqual(9);
		for (const key of gated) expect(derived).toContain(key);
	});

	test('no replay door is exempt: every Time Machine restore and bulk revert writer is gated', () => {
		const derived = deriveCallers(closure, entries);
		for (const door of REPLAY_DOORS) {
			expect(derived, door).toContain(door);
			expect(CENSUS[door]?.verdict, door).toBe('gated');
		}
		// …and nothing under the Time Machine's server takes a replay entry ungated:
		// a new restore door there is `gated` or it is red here.
		const replayEntries = entries.filter((entry) =>
			/#persist(RestoredKeys|RecordBirth|RecordColumns)$/.test(entry),
		);
		const tmReplays = deriveCallers(closure, replayEntries).filter((key) =>
			key.startsWith(`${TM_SERVER}/`),
		);
		expect(tmReplays.length).toBeGreaterThanOrEqual(6);
		for (const key of tmReplays) expect(CENSUS[key]?.verdict, key).toBe('gated');
	});

	test('the verdict vocabulary is shrink-only: gated, non_literal — no third class of write', () => {
		expect([...VERDICTS]).toEqual(['gated', 'non_literal']);
		const used = new Set(Object.values(CENSUS).map((row) => row.verdict));
		expect([...used].sort()).toEqual(['gated', 'non_literal']);
	});
});

describe('the census catches what it claims to (synthetic corpus)', () => {
	const FILES: Record<string, string> = {
		[RECORD_WRITE]:
			'export async function persistRecordKeys() {}\nexport async function persistRecordColumns() {}\n' +
			'export async function persistRestoredKeys() {}\nexport async function persistRecordBirth() {}\n' +
			// an entry the census never listed by hand, and a private helper that is no entry
			'export async function persistZzNewEntry() {}\nasync function persistZzPrivate() {}\n' +
			'export async function afterRecordWrite() {\n\tawait persistZzPrivate();\n}\n',
		'src/core/section_record/index.ts': "export { persistRecordKeys } from './record_write.ts';\n",
		[GATE_FILE]: 'export async function applyWriteValueGates() {}\n',
		'src/zz/gated.ts': [
			"import { applyWriteValueGates } from '../core/section/record/write_value_gates.ts';",
			'async function helper() {',
			'\treturn await applyWriteValueGates();',
			'}',
			'export async function zzGated() {',
			"\tconst { persistRecordKeys } = await import('../core/section_record/index.ts');",
			'\tawait helper();',
			'\tawait persistRecordKeys();',
			'}',
			'',
		].join('\n'),
		'src/zz/ungated.ts': [
			"import { persistRecordKeys } from '../core/section_record/record_write.ts';",
			'export async function zzUngated() {',
			'\tawait persistRecordKeys();',
			'}',
			'',
		].join('\n'),
		'src/zz/mention.ts': "export function zzMention() {\n\treturn 'persistRecordKeys';\n}\n",
		// a replay door, and its undelete twin
		'src/zz/replay.ts': [
			"import { persistRecordBirth, persistRestoredKeys } from '../core/section_record/record_write.ts';",
			'export async function zzReplay() {',
			'\tawait persistRestoredKeys();',
			'}',
			'export async function zzUndelete() {',
			'\tawait persistRecordBirth();',
			'}',
			'',
		].join('\n'),
		// two doors in one file: the first writes ungated and CALLS the gated second
		'src/zz/two_doors.ts': [
			"import { applyWriteValueGates } from '../core/section/record/write_value_gates.ts';",
			"import { persistRecordColumns, persistRestoredKeys } from '../core/section_record/record_write.ts';",
			'export async function zzWholeDoor() {',
			'\tawait applyWriteValueGates();',
			'\tawait persistRecordColumns();',
			'}',
			'export async function zzKeyDoor() {',
			'\tawait zzWholeDoor();',
			'\tawait persistRestoredKeys();',
			'}',
			'',
		].join('\n'),
		// a writer whose gate sits in its CALLER, another file: the old bulk-revert
		// shape (the plan gated, the writer wrote what it was handed)
		'src/zz/plan_gated.ts': [
			"import { applyWriteValueGates } from '../core/section/record/write_value_gates.ts';",
			"import { zzHandedWriter } from './handed_writer.ts';",
			'export async function zzPlan() {',
			'\tawait applyWriteValueGates();',
			'\tawait zzHandedWriter();',
			'}',
			'',
		].join('\n'),
		'src/zz/handed_writer.ts': [
			"import { persistRestoredKeys } from '../core/section_record/record_write.ts';",
			'export async function zzHandedWriter() {',
			'\tawait persistRestoredKeys();',
			'}',
			'',
		].join('\n'),
		// a caller of the entry nobody listed
		'src/zz/new_entry.ts': [
			"import { persistZzNewEntry } from '../core/section_record/record_write.ts';",
			'export async function zzNewDoor() {',
			'\tawait persistZzNewEntry();',
			'}',
			'',
		].join('\n'),
	};
	const synthetic = buildWriterClosure({
		files: Object.keys(FILES),
		read: (rel) => FILES[rel] as string,
	});
	const entries = chokepointEntries(FILES[RECORD_WRITE] as string);
	/** Honest rows for every synthetic door but the two the first control reads. */
	const OTHER_ROWS: Census = {
		'src/zz/replay.ts#zzReplay': { verdict: 'non_literal', reason: 'r' },
		'src/zz/replay.ts#zzUndelete': { verdict: 'non_literal', reason: 'r' },
		'src/zz/two_doors.ts#zzWholeDoor': { verdict: 'gated', reason: 'r' },
		'src/zz/two_doors.ts#zzKeyDoor': { verdict: 'non_literal', reason: 'r' },
		'src/zz/handed_writer.ts#zzHandedWriter': { verdict: 'non_literal', reason: 'r' },
		'src/zz/new_entry.ts#zzNewDoor': { verdict: 'non_literal', reason: 'r' },
	};
	const BASE: Census = {
		'src/zz/gated.ts#zzGated': { verdict: 'gated', reason: 'r' },
		'src/zz/ungated.ts#zzUngated': { verdict: 'non_literal', reason: 'r' },
	};

	test('entries derive from the module: an exported persist* is one, a private helper and another export are not', () => {
		expect(entries.map((entry) => entry.split('#')[1])).toEqual([
			'persistRecordBirth',
			'persistRecordColumns',
			'persistRecordKeys',
			'persistRestoredKeys',
			'persistZzNewEntry',
		]);
	});

	test('callers derive through static, re-exported and dynamic imports; a string is no edge', () => {
		expect(deriveCallers(synthetic, entries)).toEqual([
			'src/zz/gated.ts#zzGated',
			'src/zz/handed_writer.ts#zzHandedWriter',
			'src/zz/new_entry.ts#zzNewDoor',
			'src/zz/replay.ts#zzReplay',
			'src/zz/replay.ts#zzUndelete',
			'src/zz/two_doors.ts#zzKeyDoor',
			'src/zz/two_doors.ts#zzWholeDoor',
			'src/zz/ungated.ts#zzUngated',
		]);
	});

	test('a helper-mediated gate counts; an ungated writer marked gated is red; a new writer is red', () => {
		const census: Census = {
			'src/zz/gated.ts#zzGated': { verdict: 'gated', reason: 'r' },
			'src/zz/ungated.ts#zzUngated': { verdict: 'gated', reason: 'r' },
			'src/zz/gone.ts#zzGone': { verdict: 'non_literal', reason: 'r' },
			...OTHER_ROWS,
		};
		expect(violations(synthetic, census, entries)).toEqual(
			[
				`'gated' but does not reach ${GATE} locally: src/zz/ungated.ts#zzUngated`,
				'stale row (no longer a chokepoint writer): src/zz/gone.ts#zzGone',
			].sort(),
		);
		expect(
			violations(
				synthetic,
				{ 'src/zz/gated.ts#zzGated': { verdict: 'gated', reason: 'r' }, ...OTHER_ROWS },
				entries,
			),
		).toEqual(['unclassified chokepoint writer: src/zz/ungated.ts#zzUngated']);
	});

	test('a caller of ANY entry needs a row — an entry nobody listed by hand included', () => {
		expect(violations(synthetic, BASE, entries)).toEqual([
			'unclassified chokepoint writer: src/zz/handed_writer.ts#zzHandedWriter',
			'unclassified chokepoint writer: src/zz/new_entry.ts#zzNewDoor',
			'unclassified chokepoint writer: src/zz/replay.ts#zzReplay',
			'unclassified chokepoint writer: src/zz/replay.ts#zzUndelete',
			'unclassified chokepoint writer: src/zz/two_doors.ts#zzKeyDoor',
			'unclassified chokepoint writer: src/zz/two_doors.ts#zzWholeDoor',
		]);
		expect(violations(synthetic, { ...BASE, ...OTHER_ROWS }, entries)).toEqual([]);
		// a replay door may not claim a gate it lacks
		expect(
			violations(
				synthetic,
				{
					...BASE,
					...OTHER_ROWS,
					'src/zz/replay.ts#zzReplay': { verdict: 'gated', reason: 'r' },
				},
				entries,
			),
		).toEqual([`'gated' but does not reach ${GATE} locally: src/zz/replay.ts#zzReplay`]);
	});

	test('a retired verdict is refused: `exact_revert` is no row a writer may take', () => {
		expect(
			violations(
				synthetic,
				{
					...BASE,
					...OTHER_ROWS,
					'src/zz/replay.ts#zzReplay': { verdict: 'exact_revert' as Verdict, reason: 'r' },
				},
				entries,
			),
		).toEqual(["unknown verdict 'exact_revert': src/zz/replay.ts#zzReplay"]);
	});

	test("another door's gate is not this door's: a gate reached only THROUGH a chokepoint writer is red", () => {
		// zzKeyDoor reaches the gate only by calling zzWholeDoor (same file), which
		// gates ITS OWN write — the apply_value shape with its component gate removed.
		expect(
			violations(
				synthetic,
				{
					...BASE,
					...OTHER_ROWS,
					'src/zz/two_doors.ts#zzKeyDoor': { verdict: 'gated', reason: 'r' },
				},
				entries,
			),
		).toEqual([`'gated' but does not reach ${GATE} locally: src/zz/two_doors.ts#zzKeyDoor`]);
	});

	test("a gate in the writer's CALLER is not the writer's: the write itself must gate", () => {
		// zzPlan gates and hands the value to zzHandedWriter (another file), which
		// writes whatever it is handed — any other caller of it writes ungated.
		expect(
			violations(
				synthetic,
				{
					...BASE,
					...OTHER_ROWS,
					'src/zz/handed_writer.ts#zzHandedWriter': { verdict: 'gated', reason: 'r' },
				},
				entries,
			),
		).toEqual([
			`'gated' but does not reach ${GATE} locally: src/zz/handed_writer.ts#zzHandedWriter`,
		]);
	});
});
