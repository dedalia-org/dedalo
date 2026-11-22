/**
 * TM HISTORY VISIBILITY TRIPWIRE (WC-2026-09-27-bulk-revert-undo-log §2.4) —
 * the census sibling of tm_epoch_tripwire, for the OTHER narrowing every
 * history reader owes since migration 0010: `tm_role IS NULL`.
 *
 * THE INVARIANT. A bulk run's undo log lives in `matrix_time_machine` beside
 * ordinary history: hidden BEFORE images (tm_role 1), birth markers (3), cascade
 * snapshots (4). Only the bulk revert may read them. Every other statement that
 * reads the table must be narrowed with `withTmHistory(…)` (epoch AND visible)
 * or `tmVisiblePredicate(…)`, or be EXEMPT here with the reason it must see
 * every row. tm_history_visibility_native MEASURES the outcome on the real
 * doors (list, count, filters, deep page, preview, apply_value, a probe); this
 * census is what makes a NEW reader — which nothing about writing one makes its
 * author think of — red the day it lands.
 *
 * WHY A CENSUS AND NOT A SPELLING PIN. The per-file pins count STATEMENTS, as a
 * pair (reads, narrowings) — a new statement moves `reads` without moving the
 * narrowing count. And the helpers themselves are measured by their OUTPUT
 * (the SQL fragment they return), not by their name: a `withTmHistory` that
 * stopped emitting `tm_role IS NULL` is red here, whatever it is called.
 *
 * SHRINK-ONLY: the exemption set may only shrink (its size is frozen below);
 * each exemption covers a COUNTED set of reads, so a second read added to an
 * exempt file does not inherit the first one's reason. Corpus: the write-path
 * corpus (test/helpers/write_path_corpus.ts — src/, tools/, scripts/), the
 * shared lister census_derivation_tripwire registers; scripts included
 * because an operator script (detect_csv_import_damage) reports history to a
 * human.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	tmEpochPredicate,
	tmVisiblePredicate,
	withTmEpoch,
	withTmHistory,
} from '../../src/core/db/record_generation.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

/**
 * A statement that READS the table: `FROM`/`JOIN matrix_time_machine`, except
 * the `FROM` of a `DELETE FROM` (a write — sweeps are not history readers).
 * An `UPDATE … FROM matrix_time_machine` would still count as a read.
 */
const TM_READ = /(?<!DELETE\s+)\b(?:FROM|JOIN)\s+matrix_time_machine\b/gi;

/** The two ways a statement declares itself visibility-narrowed. */
const TM_VISIBLE = /\bwithTmHistory\(|\btmVisiblePredicate\(/g;

interface TmReader {
	file: string;
	reads: number;
	/** Visibility narrowings in the file (definitions excluded: `function withTmHistory(` is not a call). */
	visible: number;
}

function measure(file: string, source: string): TmReader {
	// Comments stripped by the shared SCANNER (literal content kept): prose that
	// names the table is not a statement, and a `//` inside a literal hides nothing.
	const body = stripComments(source).replace(
		/function\s+(withTmHistory|tmVisiblePredicate)\(/g,
		'',
	);
	return {
		file,
		reads: (body.match(TM_READ) ?? []).length,
		visible: (body.match(TM_VISIBLE) ?? []).length,
	};
}

function tmReaders(): TmReader[] {
	return writePathSourceFiles()
		.map((file) => measure(file, readFileSync(join(REPO_ROOT, file), 'utf8')))
		.filter((reader) => reader.reads > 0);
}

/**
 * Readers that must see EVERY row, hidden ones included — each with WHY.
 * SHRINK-ONLY (size frozen by EXEMPT_CEILING).
 */
const EXEMPT_READERS: Readonly<Record<string, { reads: number; reason: string }>> = {
	'src/core/db/matrix_write.ts': {
		reads: 2,
		reason:
			'The COUNTER FLOOR and the EPOCH MINT (tm_epoch_tripwire): the floor witnesses every section_id the table has ever named so the allocator cannot re-mint one — a birth marker names a record the run created, which is exactly such an id; the mint places the generation boundary over ALL of an address’s rows. Neither serves history.',
	},
	'src/core/db/record_generation.ts': {
		reads: 1,
		reason:
			'The epoch mint itself (it places the boundary over every row of the address), in the module that DEFINES the visibility predicates. Not a history reader.',
	},
	'src/core/install/hierarchy_import.ts': {
		reads: 1,
		reason: 'The same counter floor, as psql text for a post-COPY seed: must see every id.',
	},
	'src/core/ontology/data_io_import.ts': {
		reads: 1,
		reason: 'The same counter floor, as psql text for a post-COPY seed: must see every id.',
	},
	'src/core/update/transform/locators.ts': {
		reads: 1,
		reason:
			'v6→v7 UPDATE_PROCESS address rebase: it REWRITES every row of the table — a hidden BEFORE carries the same addresses and locators, and skipping it would leave the undo log pointing at the old addresses.',
	},
	'src/core/update/transform/lang.ts': {
		reads: 1,
		reason:
			'v6→v7 UPDATE_PROCESS lang rewrite over every row: the undo log’s lang tags must be rewritten with the history they pair with, or a revert would group a key under a language that no longer exists.',
	},
	'tools/tool_time_machine/server/bulk_revert.ts': {
		reads: 1,
		reason:
			'THE ONE READER OF THE UNDO LOG: the bulk revert loads every row of the run, every role (BEFOREs, after-rows, birth markers, cascade snapshots) — that is its input. Epoch-narrowed (tm_epoch_tripwire), deliberately NOT visibility-narrowed.',
	},
	'scripts/repair_tm_timestamps.ts': {
		reads: 4,
		reason:
			'One-off operator repair of UTC-skewed timestamps over an explicit id range, dry-run by default: it corrects every row in the range, hidden ones included — a BEFORE and its after-row share one timestamp by construction and must stay equal.',
	},
	'scripts/repair_tm_test_tail.ts': {
		reads: 2,
		reason:
			'Suite-only (marker-guarded) tail repair of the test database’s time machine: a whole-row sweep, not a history view.',
	},
};

/** The exemption set's size, FROZEN: a new exemption is a deliberate edit here. */
const EXEMPT_CEILING = 9;

/**
 * Narrowed readers, pinned as (reads, visible narrowings). narrowSites < reads
 * is correct in read_tm.ts: the deep-page and barrier shapes name the table
 * twice (an outer `FROM matrix_time_machine tm` joined to the inner scoped
 * subquery) and the narrowing belongs on the inner one that selects the ids;
 * three narrowings cover the three row-serving WHERE clauses (barrier inner,
 * late-lookup inner, plain page). The COUNT (tmHistoryCountSql) names the table
 * twice and carries NO visibility narrowing, deliberately: it counts TOTAL −
 * HIDDEN (`tm_role IS NOT NULL`, tmHiddenPredicate) so both halves stay
 * index-only — a `tm_role IS NULL` count reads the heap (15.0 s vs 3.1 s on
 * 29.45M rows). Its visibility is measured by OUTCOME in
 * tm_history_visibility_native ('the BARE dd15 count ignores rows that are
 * hidden') and its plan by tm_count_index_only_plan_native.
 */
const NARROWED_READERS: Readonly<Record<string, { reads: number; visible: number }>> = {
	// +1 read / +1 visible (T2 O16-02): the deleted-records list's per-record
	// latest-id subquery (deletedListPredicate) — the latest VISIBLE whole row.
	'src/core/resolve/read_tm.ts': { reads: 8, visible: 4 },
	// readTimeMachineRow, readTimeMachineHistory, readOtherLangItemIds, the
	// two-lane as-of reader (newestRowAt: readFrameStateRowAt / readLaneRowAt),
	// the TM preview bound + lifecycle probes (nextVisibleRow) and the per-lane as-of reader
	// of frame targets (readKeyLanesAt) and THE backfill probe of every door
	// (hasVisibleLaneHistory — the write-gate the delete/observer doors used to
	// spell inline, T1-21) are all visibility-narrowed. The 8th read,
	// addressHasTimeMachineHistory, is an existence probe over EVERY row (hidden and
	// dead generations included) — "did a record ever live here", the save door's
	// absent-row refusal sentence (WC-2026-11-10-save-never-creates); it serves no row.
	'src/core/db/time_machine.ts': { reads: 8, visible: 7 },
	'tools/tool_time_machine/server/bulk_revert_legacy.ts': { reads: 3, visible: 3 },
	'scripts/detect_csv_import_damage.ts': { reads: 1, visible: 1 },
};

describe('TM history visibility tripwire', () => {
	const readers = tmReaders();

	test('the census finds the readers it is meant to see (anti-vacuity)', () => {
		expect(writePathSourceFiles().length).toBeGreaterThanOrEqual(WRITE_PATH_CORPUS_FLOOR);
		expect(readers.length).toBeGreaterThanOrEqual(12);
		const files = new Set(readers.map((r) => r.file));
		for (const door of [
			'src/core/resolve/read_tm.ts',
			'src/core/db/time_machine.ts',
			'tools/tool_time_machine/server/bulk_revert.ts',
			'src/core/db/matrix_write.ts',
		]) {
			expect(files.has(door), door).toBe(true);
		}
	});

	test('the classifier is honest: a planted bare reader leaks, a narrowed one and a sweep do not', () => {
		const leak = measure('x.ts', 'await sql`SELECT data FROM matrix_time_machine WHERE id = 1`;');
		expect([leak.reads, leak.visible]).toEqual([1, 0]);
		const narrowed = measure(
			'x.ts',
			'await sql.unsafe(`SELECT 1 FROM matrix_time_machine WHERE ${withTmHistory("id = 1")}`);',
		);
		expect([narrowed.reads, narrowed.visible]).toEqual([1, 1]);
		const sweep = measure(
			'x.ts',
			"await sql.unsafe('DELETE FROM matrix_time_machine WHERE id = 1');",
		);
		expect(sweep.reads).toBe(0);
		const prose = measure('x.ts', '// reads FROM matrix_time_machine in prose\nconst a = 1;');
		expect(prose.reads).toBe(0);
		const joined = measure('x.ts', 'q(`SELECT 1 FROM x JOIN matrix_time_machine tm ON true`);');
		expect(joined.reads).toBe(1);
		// A comment STRIPPER that does not know string literals hides a real
		// reader: a non-URL `//` inside a literal ate the rest of the line, and a
		// '/*' … '*/' pair of literals ate everything between them.
		const slashes = measure(
			'x.ts',
			"sql.unsafe(`SELECT data->>'uri' LIKE 'https://x//y' AS u FROM matrix_time_machine WHERE id = $1`);",
		);
		expect([slashes.reads, slashes.visible]).toEqual([1, 0]);
		const blockPair = measure(
			'x.ts',
			"const p='/*'; await sql`SELECT data FROM matrix_time_machine`; const q='*/';",
		);
		expect([blockPair.reads, blockPair.visible]).toEqual([1, 0]);
	});

	test('every TM reader is visibility-narrowed, or exempt with a reason', () => {
		// A reader that serves history without `tm_role IS NULL` shows a bulk
		// run's hidden rows as history: a BEFORE listed as a version, a birth
		// marker as a deleted record, a run's writes counted twice. Narrow it
		// with withTmHistory()/tmVisiblePredicate(), or exempt it with WHY it
		// must see every row.
		const leaking = readers
			.filter((r) => r.visible === 0 && EXEMPT_READERS[r.file] === undefined)
			.map((r) => r.file);
		expect(leaking).toEqual([]);
	});

	test('each narrowed file narrows EVERY statement it holds, not merely one', () => {
		const drifted = Object.entries(NARROWED_READERS)
			.map(([file, pin]) => {
				const actual = readers.find((r) => r.file === file);
				return {
					file,
					want: `${pin.reads} reads / ${pin.visible} narrowings`,
					got: `${actual?.reads ?? 0} reads / ${actual?.visible ?? 0} narrowings`,
				};
			})
			.filter((row) => row.want !== row.got)
			.map((row) => `${row.file}: pinned ${row.want}, found ${row.got}`);
		expect(drifted).toEqual([]);
	});

	test('every reader is classified exactly once (narrowed XOR exempt)', () => {
		const unclassified = readers
			.filter((r) => NARROWED_READERS[r.file] === undefined && EXEMPT_READERS[r.file] === undefined)
			.map((r) => r.file);
		expect(unclassified).toEqual([]);
		const both = Object.keys(NARROWED_READERS).filter((f) => EXEMPT_READERS[f] !== undefined);
		expect(both).toEqual([]);
	});

	test('no exemption is stale, and each covers a COUNTED set of reads', () => {
		const drifted = Object.entries(EXEMPT_READERS)
			.map(([file, entry]) => ({
				file,
				allowed: entry.reads,
				actual: readers.find((r) => r.file === file)?.reads ?? 0,
			}))
			.filter((row) => row.actual !== row.allowed)
			.map((row) => `${row.file}: exempts ${row.allowed}, found ${row.actual}`);
		expect(drifted).toEqual([]);
	});

	test('the exemption set is shrink-only', () => {
		expect(Object.keys(EXEMPT_READERS).length).toBeLessThanOrEqual(EXEMPT_CEILING);
		for (const [file, entry] of Object.entries(EXEMPT_READERS)) {
			expect(entry.reason.length, `${file} carries no real reason`).toBeGreaterThan(60);
		}
	});

	test('the helpers are measured by what they EMIT, not by their names', () => {
		// The narrowing a call site declares is only worth what the helper returns.
		expect(tmVisiblePredicate()).toBe('matrix_time_machine.tm_role IS NULL');
		expect(tmVisiblePredicate('tm')).toBe('tm.tm_role IS NULL');
		const history = withTmHistory('tm.id = $1', 'tm');
		expect(history).toContain('tm.tm_role IS NULL');
		expect(history).toContain('tm.id = $1');
		// …and it is the epoch narrowing PLUS visibility, never instead of it.
		expect(history).toContain(tmEpochPredicate('tm'));
		expect(withTmEpoch('tm.id = $1', 'tm')).not.toContain('tm_role');
		// A caller's top-level OR (read_tm's multi-locator scope, a dd15 $or
		// filter) stays parenthesized: `a OR b AND tm_role IS NULL` would narrow b only.
		expect(withTmHistory('a = 1 OR b = 2', 'tm').startsWith('(a = 1 OR b = 2) AND ')).toBe(true);
	});
});
