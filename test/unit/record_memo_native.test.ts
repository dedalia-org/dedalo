/**
 * READ-SCOPED MATRIX ROW MEMO — the gate behind src/core/db/record_memo.ts.
 *
 * The defect it exists to prevent (measured on the test6813 list page, 2026-08-03):
 * component_info widgets ask readWidgetComponentData for ONE component at a
 * time, and each call fetched a WHOLE matrix row. A component_state declaring 8
 * paths over the same related record re-read that row 8 times — 145 row reads
 * for 27 distinct rows on a 10-row page, 328ms of the 371ms spent in SQL.
 *
 * Three things must stay true or the fix silently rots back to N+1:
 *   1. the memo primitive itself collapses repeats (behavioural, mocked DB);
 *   2. batch SEEDING serves the lazy readers, so the page-level prefetch the
 *      loaders already do reaches the widgets instead of stopping at their own
 *      cache (that gap was worth 24 of the 27 remaining round-trips);
 *   3. the four WIRING points survive refactors (structural) — the widget
 *      helper must go through the memo, readSection must open the scope, and
 *      both page batch loaders must seed it. Any one reverting restores a
 *      serialized N+1 with every behavioural test still green, which is exactly
 *      the failure mode a source-level gate catches.
 *
 * No DB: readMatrixRecord is mocked, so this asserts the memo's own contract.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). Every
// tipo here is a PURE MEMO KEY — the DB reader is mocked, nothing is resolved
// against the ontology — so the install tipos were renamed to their `test`
// clones (rsc167 → test6099, oh1 → test6813) and the carrier table to
// `matrix_test`, the table a `test` section actually stores in. Nothing about
// the memo contract changes: the keys only have to be distinct.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realMatrixModule from '../../src/core/db/matrix.ts';

// Capture the REAL module ONCE; mock.restore() does NOT revert mock.module, so
// afterAll re-installs it (the password_reset_native.test.ts pattern — without
// this the mocked matrix reader leaks into every later suite).
const REAL_MATRIX = { ...realMatrixModule };

let reads: string[] = [];
let resolveGate: (() => void) | null = null;

mock.module('../../src/core/db/matrix.ts', () => ({
	...REAL_MATRIX,
	readMatrixRecord: async (tableName: string, sectionTipo: string, sectionId: number) => {
		reads.push(`${tableName}|${sectionTipo}|${sectionId}`);
		// When a gate is armed the read parks until released, so the concurrent
		// case can prove collapse happens BEFORE the first query resolves.
		if (resolveGate !== null) {
			await new Promise<void>((resolve) => {
				const previous = resolveGate as () => void;
				resolveGate = () => {
					previous();
					resolve();
				};
			});
		}
		return {
			id: sectionId,
			section_id: sectionId,
			section_tipo: sectionTipo,
			columns: {},
			rawText: {},
		} as realMatrixModule.MatrixRecord;
	},
}));

const { memoizedReadMatrixRecord, runWithRecordMemo, hasActiveRecordMemo, seedRecordMemo } =
	await import('../../src/core/db/record_memo.ts');

afterAll(() => {
	mock.module('../../src/core/db/matrix.ts', () => REAL_MATRIX);
});

beforeEach(() => {
	reads = [];
	resolveGate = null;
});

describe('read-scoped matrix row memo', () => {
	test('inside a scope, the same row is read from the DB exactly once', async () => {
		await runWithRecordMemo(async () => {
			for (let i = 0; i < 8; i++) {
				await memoizedReadMatrixRecord('matrix_test', 'test6099', 1);
			}
		});
		expect(reads).toEqual(['matrix_test|test6099|1']);
	});

	test('distinct rows are still read independently — the memo is not a filter', async () => {
		await runWithRecordMemo(async () => {
			await memoizedReadMatrixRecord('matrix_test', 'test6099', 1);
			await memoizedReadMatrixRecord('matrix_test', 'test6099', 2);
			await memoizedReadMatrixRecord('matrix_test', 'test6813', 1);
			await memoizedReadMatrixRecord('matrix_users', 'test6099', 1);
			await memoizedReadMatrixRecord('matrix_test', 'test6099', 1); // repeat
		});
		expect(reads).toEqual([
			'matrix_test|test6099|1',
			'matrix_test|test6099|2',
			'matrix_test|test6813|1',
			'matrix_users|test6099|1',
		]);
	});

	test('the memoized row is the same value the DB returned', async () => {
		await runWithRecordMemo(async () => {
			const first = await memoizedReadMatrixRecord('matrix_test', 'test6099', 7);
			const second = await memoizedReadMatrixRecord('matrix_test', 'test6099', 7);
			expect(second).toBe(first);
			expect(first?.section_id).toBe(7);
			expect(first?.section_tipo).toBe('test6099');
		});
	});

	test('CONCURRENT asks for one row collapse onto a single query', async () => {
		resolveGate = () => {};
		const done = runWithRecordMemo(async () => {
			// All five start before any resolves — a resolved-value cache would
			// issue five queries here; storing the in-flight promise issues one.
			const all = Promise.all([
				memoizedReadMatrixRecord('matrix_test', 'test6099', 3),
				memoizedReadMatrixRecord('matrix_test', 'test6099', 3),
				memoizedReadMatrixRecord('matrix_test', 'test6099', 3),
				memoizedReadMatrixRecord('matrix_test', 'test6099', 3),
				memoizedReadMatrixRecord('matrix_test', 'test6099', 3),
			]);
			await Promise.resolve();
			(resolveGate as () => void)();
			return all;
		});
		const rows = await done;
		expect(reads).toEqual(['matrix_test|test6099|3']);
		expect(new Set(rows).size).toBe(1);
	});

	test('a nested scope JOINS the outer one instead of shadowing it', async () => {
		await runWithRecordMemo(async () => {
			await memoizedReadMatrixRecord('matrix_test', 'test6099', 1);
			await runWithRecordMemo(async () => {
				// A portal expanding inside a list row: same point-in-time view,
				// so it must reuse the outer read's rows, not re-fetch them.
				await memoizedReadMatrixRecord('matrix_test', 'test6099', 1);
			});
		});
		expect(reads).toEqual(['matrix_test|test6099|1']);
	});

	test('with NO scope active it is a pass-through — the write path never memoizes', async () => {
		expect(hasActiveRecordMemo()).toBe(false);
		await memoizedReadMatrixRecord('matrix_test', 'test6099', 1);
		await memoizedReadMatrixRecord('matrix_test', 'test6099', 1);
		// Save/delete legitimately re-read a row they just modified; a memo hit
		// there would hand back the pre-write row.
		expect(reads).toEqual(['matrix_test|test6099|1', 'matrix_test|test6099|1']);
	});

	test('the scope does not outlive the read that opened it', async () => {
		await runWithRecordMemo(async () => {
			await memoizedReadMatrixRecord('matrix_test', 'test6099', 1);
			expect(hasActiveRecordMemo()).toBe(true);
		});
		expect(hasActiveRecordMemo()).toBe(false);
		await runWithRecordMemo(async () => {
			await memoizedReadMatrixRecord('matrix_test', 'test6099', 1);
		});
		// Second read = second scope = the row is fetched fresh. This is what
		// makes the memo immune to stale-after-edit without any invalidation.
		expect(reads).toEqual(['matrix_test|test6099|1', 'matrix_test|test6099|1']);
	});
});

describe('batch seeding — the page prefetch feeds the lazy per-component readers', () => {
	test('a seeded row is served without touching the DB', async () => {
		await runWithRecordMemo(async () => {
			seedRecordMemo('matrix_test', 'test6099', 5, {
				id: 5,
				section_id: 5,
				section_tipo: 'test6099',
				columns: {},
				rawText: {},
			} as realMatrixModule.MatrixRecord);
			const row = await memoizedReadMatrixRecord('matrix_test', 'test6099', 5);
			expect(row?.section_id).toBe(5);
		});
		expect(reads).toEqual([]);
	});

	test('a seeded MISS is honoured — a definitive absence is not re-queried', async () => {
		await runWithRecordMemo(async () => {
			seedRecordMemo('matrix_test', 'test6099', 99, null);
			expect(await memoizedReadMatrixRecord('matrix_test', 'test6099', 99)).toBeNull();
			expect(await memoizedReadMatrixRecord('matrix_test', 'test6099', 99)).toBeNull();
		});
		expect(reads).toEqual([]);
	});

	test('seeding never displaces an in-flight read of the same row', async () => {
		await runWithRecordMemo(async () => {
			const inFlight = memoizedReadMatrixRecord('matrix_test', 'test6099', 5);
			// A batch landing mid-read must not hand a SECOND object for one row
			// to a later caller — one read, one snapshot.
			seedRecordMemo('matrix_test', 'test6099', 5, {
				id: 5,
				section_id: 5,
				section_tipo: 'test6099',
				columns: { data: 'seeded-loser' },
				rawText: {},
			} as unknown as realMatrixModule.MatrixRecord);
			const later = await memoizedReadMatrixRecord('matrix_test', 'test6099', 5);
			expect(later).toBe(await inFlight);
			expect(later?.columns.data).toBeUndefined();
		});
		expect(reads).toEqual(['matrix_test|test6099|5']);
	});

	test('the memo is BOUNDED — a runaway read cannot pin rows without limit', async () => {
		// The sibling per-read cache (section/record_loader.ts) clears at 8000;
		// this one must not be the odd cache out that grows forever. Overflow may
		// only cost re-reads, never correctness, so the check is "it stops
		// growing", not "it kept entry N".
		await runWithRecordMemo(async () => {
			for (let id = 0; id < 8200; id++) {
				seedRecordMemo('matrix_test', 'test6099', id, null);
			}
			// Past the bound the memo has been cleared and refilled, so an early
			// row is gone and re-reads from the DB rather than being pinned.
			await memoizedReadMatrixRecord('matrix_test', 'test6099', 0);
		});
		expect(reads).toEqual(['matrix_test|test6099|0']);
	});

	test('seeding outside a scope is a no-op, not a leak', () => {
		expect(hasActiveRecordMemo()).toBe(false);
		expect(() => seedRecordMemo('matrix_test', 'test6099', 5, null)).not.toThrow();
	});
});

describe('memo wiring (structural — behavioural tests stay green if these revert)', () => {
	test('the component_info widget helper reads rows THROUGH the memo', async () => {
		const source = await Bun.file(
			new URL('../../src/core/components/component_info/widgets/widget_common.ts', import.meta.url),
		).text();
		expect(source).toContain('memoizedReadMatrixRecord');
		expect(source).not.toMatch(/\breadMatrixRecord\s*\(/);
	});

	test('both page-level batch loaders seed the memo', async () => {
		// Either one reverting silently restores a serialized round-trip per row
		// (the widgets re-fetching rows the page already had in hand), with every
		// behavioural test still green.
		for (const path of [
			'../../src/core/section/record_loader.ts',
			'../../src/core/section/read_source.ts',
		]) {
			const source = await Bun.file(new URL(path, import.meta.url)).text();
			expect(source).toMatch(/\bseedRecordMemo\(/);
		}
	});

	test('readSection opens the memo scope', async () => {
		const source = await Bun.file(
			new URL('../../src/core/section/read.ts', import.meta.url),
		).text();
		// The CALL, not the import — deleting the wrapper while leaving the
		// import behind is exactly how this reverts, and a bare `toContain`
		// would still match the surviving `import { runWithRecordMemo }` line.
		expect(source).toMatch(/\brunWithRecordMemo\(/);
		// …and it must WRAP the read, not merely be mentioned somewhere (it sits
		// inside the TM scope opener, so the wrap is pinned on its argument: a
		// call of the read, whatever its name — the memo is pinned here, not the
		// read's authorization, which authz_substring_gate_tripwire keeps behavioural).
		expect(source).toMatch(/runWithRecordMemo\(\(\) => \w+\(rqo, principal(?:, \w+)?\)\)/);
	});
});
