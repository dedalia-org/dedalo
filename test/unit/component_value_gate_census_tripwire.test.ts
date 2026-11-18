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
 * TOTAL BY DERIVATION. The callers are DERIVED on every run from the
 * import-resolved call graph of the write-path corpus
 * (test/helpers/matrix_writer_closure.ts: `src/`, `tools/`, `scripts/`): every
 * top-level declaration with a PRECISE (resolved, never a namespace escape) edge
 * to `persistRecordKeys` or `persistRecordColumns`, or to one of the chokepoint's
 * two REPLAY entries — `persistRestoredKeys` (a key's past value) and
 * `persistRecordBirth` (an undelete) — re-exports followed. A caller with no row
 * is RED; a row whose caller vanished is RED.
 *
 * NOT DERIVED (named, so the title claims no more than the walk reads): the
 * chokepoint's other entries — `persistAppendedKeyItems` (the save door's own
 * append; its one caller is censused through `persistRecordKeys`),
 * `persistRelationRemovalKeys` (removes locators), `persistObserverMirrorKeys` /
 * `persistObserverResaveKeys` (cascade-owned: a mirror derived from stored
 * truth, a stored value re-ordered or cleared) and `persistModifiedStamp`. Who
 * may take each is write_obligations_tripwire leg B4.
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
 *                          value (relations, counters, ontology rows, an
 *                          engine-authored label); the reason says which.
 *   exact_revert         — the BULK REVERT's own writers: they replay their
 *                          undo-log images VERBATIM, ungated — a revert is
 *                          exact by contract (`changed_since_run` compares the
 *                          bytes the run wrote). Named "Not covered" by
 *                          WC-2026-11-17-tm-restore-value-gates; an OPEN OWNER
 *                          QUESTION, not a settled exemption. CHECKED: the row
 *                          is confined to the bulk revert — declared in a
 *                          `tool_time_machine/server/bulk_revert*.ts` file, or
 *                          called (precisely) only from those files — so no
 *                          other replay door can take the verdict.
 *
 * NO `replays_stored_image` VERDICT ANY MORE (C58, 2026-11-17,
 * WC-2026-11-17-tm-restore-value-gates). The Time Machine restore doors
 * replayed a stored image raw (N1 of T1-14): a history row written before a
 * gate existed came back ungated. All THREE are `gated` now — the component
 * restore (`toolTimeMachineApplyValue` → `persistRestoredKeys`), the
 * whole-record restore and the dataframe replay — a replay is a write of a
 * component value like any other. The replay entries are DERIVED since the
 * 2026-11-17 review: before, the component restore was gated in code but
 * outside this walk, so removing its gate left the census green, and a new
 * door on `persistRestoredKeys` / `persistRecordBirth` was never asked for a
 * row. Outcome half: translation_write_gates_native (R1–R4).
 */

import { describe, expect, test } from 'bun:test';
import { buildWriterClosure, type WriterClosure } from '../helpers/matrix_writer_closure.ts';

const RECORD_WRITE = 'src/core/section_record/record_write.ts';
const CHOKEPOINTS = [
	`${RECORD_WRITE}#persistRecordKeys`,
	`${RECORD_WRITE}#persistRecordColumns`,
	// the REPLAY entries: a key's past value, an undelete
	`${RECORD_WRITE}#persistRestoredKeys`,
	`${RECORD_WRITE}#persistRecordBirth`,
];
const GATE_FILE = 'src/core/section/record/write_value_gates.ts';
const GATE = `${GATE_FILE}#applyWriteValueGates`;
/** The bulk revert's own server files — the only home of an `exact_revert` row. */
const BULK_REVERT_FILE = /^tools\/tool_time_machine\/server\/bulk_revert(_\w+)?\.ts$/;
const EXACT_REVERT_REASON =
	'replays its undo-log image verbatim: a revert is EXACT by contract (changed_since_run compares the bytes the run wrote) — WC-2026-11-17-tm-restore-value-gates "Not covered", open owner question';

type Verdict = 'gated' | 'non_literal' | 'exact_revert';
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
		verdict: 'exact_revert',
		reason: `the bulk revert's cascade undelete (persistRecordBirth): ${EXACT_REVERT_REASON}`,
	},
	'tools/tool_time_machine/server/bulk_revert_records.ts#writeWipedKey': {
		verdict: 'exact_revert',
		reason: `a wiped key's pre-wipe items: ${EXACT_REVERT_REASON}`,
	},
	'tools/tool_time_machine/server/bulk_revert_undo.ts#writeRevertedKey': {
		verdict: 'exact_revert',
		reason: `one reverted key: ${EXACT_REVERT_REASON}`,
	},
	'tools/tool_time_machine/server/bulk_revert_undo.ts#writeComposedUnit': {
		verdict: 'exact_revert',
		reason: `a composed unit's keys (main + slots): ${EXACT_REVERT_REASON}`,
	},
};

/** Declarations with a precise edge to a chokepoint writer, sorted. */
function deriveCallers(closure: WriterClosure): string[] {
	const out: string[] = [];
	for (const key of closure.bodies.keys()) {
		if (key.startsWith(`${RECORD_WRITE}#`)) continue;
		const edges = closure.preciseEdgesOf(key);
		if (CHOKEPOINTS.some((chokepoint) => edges.has(chokepoint))) out.push(key);
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

/**
 * Is `caller` the bulk revert's own? Declared in one of its files, or reached
 * (precise edges) ONLY from them — and from at least one: a writer nobody calls
 * is not the bulk revert's.
 */
function isBulkRevertOnly(closure: WriterClosure, caller: string): boolean {
	const fileOf = (key: string): string => key.split('#')[0] as string;
	if (BULK_REVERT_FILE.test(fileOf(caller))) return true;
	const callers = [...closure.bodies.keys()].filter(
		(key) => key !== caller && closure.preciseEdgesOf(key).has(caller),
	);
	return callers.length > 0 && callers.every((key) => BULK_REVERT_FILE.test(fileOf(key)));
}

/** Every census violation for `closure` against `census` (empty = green). */
function violations(closure: WriterClosure, census: Census): string[] {
	const derived = deriveCallers(closure);
	const out: string[] = [];
	for (const caller of derived) {
		const row = census[caller];
		if (row === undefined) {
			out.push(`unclassified chokepoint writer: ${caller}`);
			continue;
		}
		if (row.reason.trim() === '') out.push(`row without a reason: ${caller}`);
		if (row.verdict === 'gated' && !gatesLocally(closure, caller, derived)) {
			out.push(`'gated' but does not reach ${GATE} locally: ${caller}`);
		}
		if (row.verdict === 'exact_revert' && !isBulkRevertOnly(closure, caller)) {
			out.push(`'exact_revert' outside the bulk revert: ${caller}`);
		}
	}
	for (const caller of Object.keys(census)) {
		if (!derived.includes(caller)) out.push(`stale row (no longer a chokepoint writer): ${caller}`);
	}
	return out.sort();
}

describe('component value gate census (T1-14)', () => {
	const closure = buildWriterClosure();

	test('every chokepoint writer is classified; every gated row reaches the gate locally', () => {
		expect(violations(closure, CENSUS)).toEqual([]);
	});

	test('anti-vacuity: the value writers (save, translation, the three TM restores) are derived and gated', () => {
		const derived = deriveCallers(closure);
		// the walk's floor: the census measured 16 chokepoint writers (2026-11-17:
		// 10 on the key/column entries + 6 on the replay entries)
		expect(derived.length).toBeGreaterThan(14);
		const gated = Object.entries(CENSUS)
			.filter(([, row]) => row.verdict === 'gated')
			.map(([key]) => key);
		expect(gated.length).toBeGreaterThanOrEqual(5);
		for (const key of gated) expect(derived).toContain(key);
	});

	test('the replay entries are walked: the component restore is derived, the bulk revert is the only ungated replay', () => {
		const derived = deriveCallers(closure);
		expect(derived).toContain(
			'tools/tool_time_machine/server/tool_time_machine.ts#toolTimeMachineApplyValue',
		);
		const exact = Object.entries(CENSUS)
			.filter(([, row]) => row.verdict === 'exact_revert')
			.map(([key]) => key);
		expect(exact.length).toBeGreaterThanOrEqual(4);
		for (const key of exact) expect(isBulkRevertOnly(closure, key)).toBe(true);
	});
});

describe('the census catches what it claims to (synthetic corpus)', () => {
	const FILES: Record<string, string> = {
		[RECORD_WRITE]:
			'export async function persistRecordKeys() {}\nexport async function persistRecordColumns() {}\n' +
			'export async function persistRestoredKeys() {}\nexport async function persistRecordBirth() {}\n',
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
		// a replay door outside the bulk revert, and its undelete twin
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
		// the bulk revert: its own writer, and its call of a shared undelete
		'tools/tool_time_machine/server/bulk_revert_zz.ts': [
			"import { persistRestoredKeys } from '../../../src/core/section_record/record_write.ts';",
			"import { zzUndelete } from '../../../src/zz/replay.ts';",
			'export async function zzRevert() {',
			'\tawait persistRestoredKeys();',
			'\tawait zzUndelete();',
			'}',
			'',
		].join('\n'),
	};
	const synthetic = buildWriterClosure({
		files: Object.keys(FILES),
		read: (rel) => FILES[rel] as string,
	});
	/** Honest rows for the synthetic replay doors (so the other controls read clean). */
	const REPLAY_ROWS: Census = {
		'src/zz/replay.ts#zzReplay': { verdict: 'non_literal', reason: 'r' },
		'src/zz/replay.ts#zzUndelete': { verdict: 'exact_revert', reason: 'r' },
		'tools/tool_time_machine/server/bulk_revert_zz.ts#zzRevert': {
			verdict: 'exact_revert',
			reason: 'r',
		},
		'src/zz/two_doors.ts#zzWholeDoor': { verdict: 'gated', reason: 'r' },
		'src/zz/two_doors.ts#zzKeyDoor': { verdict: 'non_literal', reason: 'r' },
	};

	test('callers derive through static, re-exported and dynamic imports; a string is no edge', () => {
		expect(deriveCallers(synthetic)).toEqual([
			'src/zz/gated.ts#zzGated',
			'src/zz/replay.ts#zzReplay',
			'src/zz/replay.ts#zzUndelete',
			'src/zz/two_doors.ts#zzKeyDoor',
			'src/zz/two_doors.ts#zzWholeDoor',
			'src/zz/ungated.ts#zzUngated',
			'tools/tool_time_machine/server/bulk_revert_zz.ts#zzRevert',
		]);
	});

	test('a helper-mediated gate counts; an ungated writer marked gated is red; a new writer is red', () => {
		const census: Census = {
			'src/zz/gated.ts#zzGated': { verdict: 'gated', reason: 'r' },
			'src/zz/ungated.ts#zzUngated': { verdict: 'gated', reason: 'r' },
			'src/zz/gone.ts#zzGone': { verdict: 'non_literal', reason: 'r' },
			...REPLAY_ROWS,
		};
		expect(violations(synthetic, census)).toEqual(
			[
				`'gated' but does not reach ${GATE} locally: src/zz/ungated.ts#zzUngated`,
				'stale row (no longer a chokepoint writer): src/zz/gone.ts#zzGone',
			].sort(),
		);
		expect(
			violations(synthetic, {
				'src/zz/gated.ts#zzGated': { verdict: 'gated', reason: 'r' },
				...REPLAY_ROWS,
			}),
		).toEqual(['unclassified chokepoint writer: src/zz/ungated.ts#zzUngated']);
	});

	test('a replay entry caller needs a row; exact_revert is the bulk revert only', () => {
		const base: Census = {
			'src/zz/gated.ts#zzGated': { verdict: 'gated', reason: 'r' },
			'src/zz/ungated.ts#zzUngated': { verdict: 'non_literal', reason: 'r' },
		};
		// no rows for the replay doors: each one is asked for
		expect(violations(synthetic, base)).toEqual([
			'unclassified chokepoint writer: src/zz/replay.ts#zzReplay',
			'unclassified chokepoint writer: src/zz/replay.ts#zzUndelete',
			'unclassified chokepoint writer: src/zz/two_doors.ts#zzKeyDoor',
			'unclassified chokepoint writer: src/zz/two_doors.ts#zzWholeDoor',
			'unclassified chokepoint writer: tools/tool_time_machine/server/bulk_revert_zz.ts#zzRevert',
		]);
		// the bulk revert's writer, and an undelete ONLY it calls, may be exact
		expect(violations(synthetic, { ...base, ...REPLAY_ROWS })).toEqual([]);
		// a replay door of its own may not take the verdict — nor claim a gate it lacks
		expect(
			violations(synthetic, {
				...base,
				...REPLAY_ROWS,
				'src/zz/replay.ts#zzReplay': { verdict: 'exact_revert', reason: 'r' },
			}),
		).toEqual(["'exact_revert' outside the bulk revert: src/zz/replay.ts#zzReplay"]);
		expect(
			violations(synthetic, {
				...base,
				...REPLAY_ROWS,
				'src/zz/replay.ts#zzReplay': { verdict: 'gated', reason: 'r' },
			}),
		).toEqual([`'gated' but does not reach ${GATE} locally: src/zz/replay.ts#zzReplay`]);
	});

	test("another door's gate is not this door's: a gate reached only THROUGH a chokepoint writer is red", () => {
		// zzKeyDoor reaches the gate only by calling zzWholeDoor (same file), which
		// gates ITS OWN write — the apply_value shape with its component gate removed.
		expect(
			violations(synthetic, {
				'src/zz/gated.ts#zzGated': { verdict: 'gated', reason: 'r' },
				'src/zz/ungated.ts#zzUngated': { verdict: 'non_literal', reason: 'r' },
				...REPLAY_ROWS,
				'src/zz/two_doors.ts#zzKeyDoor': { verdict: 'gated', reason: 'r' },
			}),
		).toEqual([`'gated' but does not reach ${GATE} locally: src/zz/two_doors.ts#zzKeyDoor`]);
	});
});
