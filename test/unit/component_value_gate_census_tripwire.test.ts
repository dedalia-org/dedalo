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
 * to `persistRecordKeys` or `persistRecordColumns` (re-exports followed). A
 * caller with no row is RED; a row whose caller vanished is RED.
 *
 * VERDICTS:
 *   gated                — the caller writes component VALUES it did not read
 *                          from storage. CHECKED: it reaches
 *                          `write_value_gates.ts#applyWriteValueGates` LOCALLY —
 *                          through precise edges that stay inside its own file
 *                          or the gate module (a same-file helper is fine; a
 *                          path through some unrelated engine is not proof that
 *                          THIS write is gated). The outcome half is
 *                          translation_write_gates_native + the split-origin
 *                          child (text_area_media_src_split_origin).
 *   non_literal          — the keys written carry no user-authored literal
 *                          value (relations, counters, ontology rows, an
 *                          engine-authored label); the reason says which.
 *   replays_stored_image — a Time Machine replay of a stored image; the
 *                          reason says which. NAMED EXEMPTIONS, deliberately
 *                          visible: a TM row written before a gate existed is
 *                          replayed raw (neighbour N1 of T1-14, ledgered).
 */

import { describe, expect, test } from 'bun:test';
import { buildWriterClosure, type WriterClosure } from '../helpers/matrix_writer_closure.ts';

const RECORD_WRITE = 'src/core/section_record/record_write.ts';
const CHOKEPOINTS = [`${RECORD_WRITE}#persistRecordKeys`, `${RECORD_WRITE}#persistRecordColumns`];
const GATE_FILE = 'src/core/section/record/write_value_gates.ts';
const GATE = `${GATE_FILE}#applyWriteValueGates`;

type Verdict = 'gated' | 'non_literal' | 'replays_stored_image';

const CENSUS: Readonly<Record<string, { verdict: Verdict; reason: string }>> = {
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
		verdict: 'replays_stored_image',
		reason:
			'restores a TM image of dataframe frames (relations) — a replay of stored bytes; N1 of T1-14',
	},
	'tools/tool_time_machine/server/tool_time_machine.ts#restoreSectionRow': {
		verdict: 'replays_stored_image',
		reason:
			'restores a whole TM section row image (persistRecordColumns) — a replay of stored bytes; N1 of T1-14',
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
 * nearly everything reaches the save door somewhere.)
 */
function gatesLocally(closure: WriterClosure, from: string, target: string = GATE): boolean {
	const ownFile = from.split('#')[0] as string;
	const allowed = (key: string): boolean => {
		const file = key.split('#')[0];
		return file === ownFile || file === GATE_FILE;
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
function violations(
	closure: WriterClosure,
	census: Readonly<Record<string, { verdict: Verdict; reason: string }>>,
): string[] {
	const derived = deriveCallers(closure);
	const out: string[] = [];
	for (const caller of derived) {
		const row = census[caller];
		if (row === undefined) {
			out.push(`unclassified chokepoint writer: ${caller}`);
			continue;
		}
		if (row.reason.trim() === '') out.push(`row without a reason: ${caller}`);
		if (row.verdict === 'gated' && !gatesLocally(closure, caller)) {
			out.push(`'gated' but does not reach ${GATE} locally: ${caller}`);
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

	test('anti-vacuity: the two value writers are derived and both are gated', () => {
		const derived = deriveCallers(closure);
		// the walk's floor: the census measured 10 chokepoint writers (2026-11-12)
		expect(derived.length).toBeGreaterThan(8);
		const gated = Object.entries(CENSUS)
			.filter(([, row]) => row.verdict === 'gated')
			.map(([key]) => key);
		expect(gated.length).toBeGreaterThanOrEqual(2);
		for (const key of gated) expect(derived).toContain(key);
	});
});

describe('the census catches what it claims to (synthetic corpus)', () => {
	const FILES: Record<string, string> = {
		[RECORD_WRITE]:
			'export async function persistRecordKeys() {}\nexport async function persistRecordColumns() {}\n',
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
	};
	const synthetic = buildWriterClosure({
		files: Object.keys(FILES),
		read: (rel) => FILES[rel] as string,
	});

	test('callers derive through static, re-exported and dynamic imports; a string is no edge', () => {
		expect(deriveCallers(synthetic)).toEqual([
			'src/zz/gated.ts#zzGated',
			'src/zz/ungated.ts#zzUngated',
		]);
	});

	test('a helper-mediated gate counts; an ungated writer marked gated is red; a new writer is red', () => {
		const census = {
			'src/zz/gated.ts#zzGated': { verdict: 'gated' as const, reason: 'r' },
			'src/zz/ungated.ts#zzUngated': { verdict: 'gated' as const, reason: 'r' },
			'src/zz/gone.ts#zzGone': { verdict: 'non_literal' as const, reason: 'r' },
		};
		expect(violations(synthetic, census)).toEqual(
			[
				`'gated' but does not reach ${GATE} locally: src/zz/ungated.ts#zzUngated`,
				'stale row (no longer a chokepoint writer): src/zz/gone.ts#zzGone',
			].sort(),
		);
		expect(
			violations(synthetic, { 'src/zz/gated.ts#zzGated': census['src/zz/gated.ts#zzGated'] }),
		).toEqual(['unclassified chokepoint writer: src/zz/ungated.ts#zzUngated']);
	});
});
