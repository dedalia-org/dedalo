/**
 * THE RUN'S ANCILLARY PHASE (update audit 2026-10-29, U-30) —
 * src/core/update/run/ancillary.ts, with every effect injected:
 *
 *  - the reconcilers run in the declared order, each one's evidence on the record;
 *  - tools: ONE write, `{dryRun:false, keepStoredActive:true}` (the stored
 *    ACTIVE value surviving under the row lock is measured in
 *    tools_register_write.test.ts, "keepStoredActive"); a `writeFailed` item
 *    fails the phase, an invalid declaration alone is reported;
 *  - observer_mirrors runs only after an ontology or data phase finished ok;
 *  - search_stores: ensure first, the stamp reconcile gets ensure's fresh pairs,
 *    errors on either half fail the phase; the cache is cleared after a change;
 *  - media_rules: `rewritten` names the artifacts stale before the write;
 *  - a throwing reconciler fails the phase with `summary`, stops the table and
 *    keeps raw exception text out of the evidence.
 *
 * Plus the derivation STAMP (db_assets.ts): the pure decision over planted
 * observations, and — on the suite DB, restored after — the stamp read/write on
 * a real store table.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	decideSearchStoreStamps,
	declaredSearchStoreDerivations,
	readSearchStoreStamp,
	type SearchStoreStampObservation,
	writeSearchStoreStamp,
} from '../../src/core/db/db_assets.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ImportReportItem } from '../../src/core/tools/register.ts';
import {
	ANCILLARY_RECONCILERS,
	type AncillaryDeps,
	runAncillaryPhase,
	runMovedMirrors,
} from '../../src/core/update/run/ancillary.ts';
import { createRunJournal, type RunJournal } from '../../src/core/update/run/journal.ts';

function item(over: Partial<ImportReportItem>): ImportReportItem {
	return {
		name: 'tool_x',
		dir: '/x',
		valid: true,
		dryRun: true,
		errors: [],
		warnings: [],
		inRegistry: true,
		diff: [],
		hasServerModule: true,
		active: true,
		version: '1.0.0',
		...over,
	};
}

/** A recording stub set: every call appended to `calls`. */
function recordingDeps(over: Partial<AncillaryDeps> = {}): {
	deps: AncillaryDeps;
	calls: string[];
} {
	const calls: string[] = [];
	const deps: AncillaryDeps = {
		importTools: async (options) => {
			calls.push(`importTools:${options.dryRun === false ? 'write' : 'dry'}`);
			return [item({ dryRun: options.dryRun !== false })];
		},
		reconcileObserverMirrors: async (options) => {
			calls.push(`mirrors:apply=${options.apply}`);
			return {
				tuples: 3,
				candidates: 9,
				drifted: 1,
				repaired: 1,
				shrinksSkipped: 0,
				sublawRefused: 0,
				bigResultRefused: 0,
				droppedRecords: 0,
				droppedLocators: 0,
				degradedSeedRecords: 0,
				reindexed: 0,
			};
		},
		ensureSearchStores: async () => {
			calls.push('ensure');
			return { healthy: true, ddlApplied: false, backfilled: {}, backfilledTables: [], errors: [] };
		},
		reconcileSearchStoreDerivation: async () => {
			calls.push('stamp');
			return { decisions: [], rederived: [], stamped: [], errors: 0 };
		},
		clearSearchStoreCache: () => calls.push('clearCache'),
		writeRuleFiles: () => {
			calls.push('writeRules');
			return true;
		},
		getRulesStatus: () => {
			calls.push('rulesStatus');
			return { htaccess: { up_to_date: true }, nginx: { up_to_date: true } };
		},
		...over,
	};
	return { deps, calls };
}

function journalWith(phases: { kind: 'ontology' | 'data' | 'code'; outcome: 'ok' | 'failed' }[]) {
	const base = createRunJournal({
		from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
		to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
		plan: [{ release: '7.0.2', step: { kind: 'ancillary' } }],
	});
	const records: RunJournal['phases'] = phases.map(({ kind, outcome }) => ({
		release: '7.0.2',
		step: { kind },
		started: '',
		finished: '',
		outcome,
		evidence: {},
	}));
	return { ...base, phases: records };
}

/** Silence the failure log a failing reconciler writes (failureSentence logs raw text). */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
	const errorLog = console.error;
	console.error = () => {};
	try {
		return await work();
	} finally {
		console.error = errorLog;
	}
}

describe('order and evidence', () => {
	test('the table runs in its declared order, every evidence recorded', async () => {
		const { deps, calls } = recordingDeps();
		const result = await runAncillaryPhase(journalWith([{ kind: 'data', outcome: 'ok' }]), deps);
		expect(result.outcome).toBe('ok');
		expect(calls).toEqual([
			'importTools:write',
			'mirrors:apply=true',
			'ensure',
			'stamp',
			'rulesStatus',
			'writeRules',
		]);
		expect(calls).toHaveLength(6); // corpus floor: every effect was reached
		expect(result.evidence.order).toEqual(ANCILLARY_RECONCILERS.map((r) => r.id));
		expect(result.evidence.reconcilers).toEqual({
			tools: { written: true, tools: 1, invalid: [] },
			observer_mirrors: {
				tuples: 3,
				drifted: 1,
				repaired: 1,
				shrinks_held: 0,
				sublaw_refused: 0,
				big_result_refused: 0,
			},
			search_stores: { ddl_applied: false, backfilled_tables: 0, rederived: [], stamped: [] },
			media_rules: { written: true, rewritten: [] },
		});
	});
});

describe('tools: the admin ACTIVE choice survives', () => {
	test('ONE write that keeps the stored ACTIVE value (locked in the write itself — no two-pass window)', async () => {
		const seen: unknown[] = [];
		const { deps } = recordingDeps({
			importTools: async (options) => {
				seen.push(options);
				return [item({ name: 'tool_off', dryRun: false })];
			},
		});
		const result = await runAncillaryPhase(journalWith([]), deps);
		expect(seen).toEqual([{ dryRun: false, keepStoredActive: true }]);
		expect(
			(result.evidence.reconcilers as Record<string, { written: boolean }>).tools?.written,
		).toBe(true);
	});
});

describe('tools: a registry write that did not land fails the phase (#11)', () => {
	test('writeFailed → failed, an invalid declaration alone → ok (reported)', async () => {
		const failing = recordingDeps({
			importTools: async () => [
				item({ name: 'tool_x', valid: false, writeFailed: true, dryRun: false }),
			],
		});
		const failed = await runAncillaryPhase(journalWith([]), failing.deps);
		expect(failed.outcome).toBe('failed');
		expect(String(failed.evidence.summary ?? JSON.stringify(failed.evidence))).toContain('tool_x');
		const invalid = recordingDeps({
			importTools: async () => [item({ name: 'tool_bad', valid: false, dryRun: false })],
		});
		const reported = await runAncillaryPhase(journalWith([]), invalid.deps);
		expect(reported.outcome).toBe('ok');
		expect(
			(reported.evidence.reconcilers as Record<string, { invalid: string[] }>).tools?.invalid,
		).toEqual(['tool_bad']);
	});
});

describe('tools: the REAL importTools report of a failed write fails the phase ((4) #10)', () => {
	test('one tool’s write throws: writeFailed + invalid on it, the others written; the phase fails', async () => {
		const { importTools } = await import('../../src/core/tools/register.ts');
		const written: string[] = [];
		let failing: string | null = null;
		// Reads the suite DB's registry only; every WRITE goes to this stub.
		const report = await importTools({
			dryRun: false,
			keepStoredActive: true,
			writeRecord: async (name) => {
				failing ??= name;
				if (name === failing) throw new Error('planted: write refused');
				written.push(name);
			},
		});
		expect(failing).not.toBeNull();
		const failed = report.find((entry) => entry.name === failing);
		expect(failed).toMatchObject({ writeFailed: true, valid: false });
		expect(failed?.errors.join(' ')).toContain('registry write failed');
		expect(written.length).toBeGreaterThan(0); // per-tool isolation (S1-07)
		const phase = await runAncillaryPhase(
			journalWith([]),
			recordingDeps({ importTools: async () => report }).deps,
		);
		expect(phase.outcome).toBe('failed');
	});
});

describe('observer_mirrors: only after an ontology or data phase finished ok', () => {
	const cases: [string, Parameters<typeof journalWith>[0], boolean][] = [
		['no phases', [], false],
		['code ok only', [{ kind: 'code', outcome: 'ok' }], false],
		['ontology failed', [{ kind: 'ontology', outcome: 'failed' }], false],
		['ontology ok', [{ kind: 'ontology', outcome: 'ok' }], true],
		['data ok', [{ kind: 'data', outcome: 'ok' }], true],
	];
	for (const [label, phases, runs] of cases) {
		test(label, async () => {
			const journal = journalWith(phases);
			expect(runMovedMirrors(journal)).toBe(runs);
			const { deps, calls } = recordingDeps();
			const result = await runAncillaryPhase(journal, deps);
			expect(calls.includes('mirrors:apply=true')).toBe(runs);
			const evidence = (result.evidence.reconcilers as Record<string, Record<string, unknown>>)
				.observer_mirrors;
			if (!runs) expect(evidence).toEqual({ skipped: expect.any(String) });
		});
	}
});

describe('search_stores', () => {
	test("ensure's fresh pairs reach the stamp reconcile; a change clears the cache", async () => {
		const fresh = [{ store: 'matrix_string_search', table: 'matrix_test' }];
		let handed: unknown = null;
		const { deps, calls } = recordingDeps({
			ensureSearchStores: async () => ({
				healthy: false,
				ddlApplied: true,
				backfilled: { matrix_string_search: 5 },
				backfilledTables: fresh,
				errors: [],
			}),
			reconcileSearchStoreDerivation: async (pairs) => {
				handed = pairs;
				return { decisions: [], rederived: ['matrix_relation_index'], stamped: [], errors: 0 };
			},
		});
		const result = await runAncillaryPhase(journalWith([]), deps);
		expect(handed).toEqual(fresh);
		expect(calls).toContain('clearCache');
		expect(result.outcome).toBe('ok');
	});

	test('ensure errors fail the phase with a sentence — no raw text', async () => {
		const { deps, calls } = recordingDeps({
			ensureSearchStores: async () => ({
				healthy: false,
				ddlApplied: true,
				backfilled: {},
				backfilledTables: [],
				errors: ['RAW pg error text'],
			}),
		});
		const result = await quietly(() => runAncillaryPhase(journalWith([]), deps));
		expect(result.outcome).toBe('failed');
		expect(result.evidence.failed).toBe('search_stores');
		expect(result.evidence.summary).toEqual(expect.stringContaining('could not be ensured'));
		expect(JSON.stringify(result.evidence)).not.toContain('RAW pg error text');
		expect(calls).not.toContain('writeRules'); // the table stopped
	});

	test('re-derive errors fail the phase', async () => {
		const { deps } = recordingDeps({
			reconcileSearchStoreDerivation: async () => ({
				decisions: [],
				rederived: [],
				stamped: [],
				errors: 2,
			}),
		});
		const result = await quietly(() => runAncillaryPhase(journalWith([]), deps));
		expect(result.outcome).toBe('failed');
		expect(result.evidence.summary).toEqual(expect.stringContaining('could not be re-derived'));
	});
});

describe('media_rules', () => {
	test('rewritten = the artifacts stale before the write', async () => {
		const { deps } = recordingDeps({
			getRulesStatus: () => ({
				htaccess: { up_to_date: false },
				nginx: { up_to_date: true },
				nginx_map: { up_to_date: false },
			}),
		});
		const result = await runAncillaryPhase(journalWith([]), deps);
		expect((result.evidence.reconcilers as Record<string, unknown>).media_rules).toEqual({
			written: true,
			rewritten: ['htaccess', 'nginx_map'],
		});
	});

	test('an unreachable tree is reported, not failed', async () => {
		const { deps } = recordingDeps({
			getRulesStatus: () => ({ htaccess: { up_to_date: false } }),
			writeRuleFiles: () => false,
		});
		const result = await runAncillaryPhase(journalWith([]), deps);
		expect(result.outcome).toBe('ok');
		expect((result.evidence.reconcilers as Record<string, unknown>).media_rules).toEqual({
			written: false,
			rewritten: [],
		});
	});
});

describe('a throwing reconciler', () => {
	test('fails the phase, stops the table, keeps raw text out', async () => {
		const { deps, calls } = recordingDeps({
			importTools: async () => {
				throw new Error('RAW /etc/secret failure');
			},
		});
		const result = await quietly(() => runAncillaryPhase(journalWith([]), deps));
		expect(result.outcome).toBe('failed');
		expect(result.evidence).toEqual({
			reconcilers: {},
			failed: 'tools',
			summary: expect.stringMatching(/^ancillary reconciler tools failed: /),
		});
		expect(JSON.stringify(result.evidence)).not.toContain('RAW');
		expect(calls).toEqual([]);
	});
});

// ── the derivation stamp ────────────────────────────────────────────────────

const DECLARED = declaredSearchStoreDerivations();
const STRING_STAMP = DECLARED.find((d) => d.store === 'matrix_string_search')?.stamp as string;

function observation(over: Partial<SearchStoreStampObservation>): SearchStoreStampObservation {
	return {
		store: 'matrix_string_search',
		exists: true,
		stamp: null,
		populated: true,
		tables: ['matrix', 'matrix_test'],
		...over,
	};
}

describe('decideSearchStoreStamps (pure)', () => {
	test('absent / current / empty → stamp / populated mismatch → rederive', () => {
		const one = (over: Partial<SearchStoreStampObservation>) =>
			decideSearchStoreStamps([observation(over)], DECLARED)[0];
		expect(one({ exists: false })?.action).toBe('absent');
		expect(one({ stamp: STRING_STAMP })?.action).toBe('current');
		expect(one({ populated: false })?.action).toBe('stamp');
		expect(one({})).toEqual({
			store: 'matrix_string_search',
			action: 'rederive',
			declared: STRING_STAMP,
			refill: [
				{ store: 'matrix_string_search', table: 'matrix' },
				{ store: 'matrix_string_search', table: 'matrix_test' },
			],
		});
		const older = `dedalo-derivation v0 sha256:${'0'.repeat(64)}`;
		expect(one({ stamp: older })?.action).toBe('rederive');
	});

	test("ensure's fresh pairs are never refilled twice", () => {
		const [decision] = decideSearchStoreStamps([observation({})], DECLARED, [
			{ store: 'matrix_string_search', table: 'matrix_test' },
			{ store: 'matrix_relation_index', table: 'matrix' }, // other store: irrelevant
		]);
		expect(decision?.refill).toEqual([{ store: 'matrix_string_search', table: 'matrix' }]);
	});

	test('an undeclared store is refused loudly', () => {
		expect(() => decideSearchStoreStamps([observation({ store: 'nope' })], DECLARED)).toThrow(
			/no declared derivation/,
		);
	});

	test('every declared stamp is in the stamp grammar, one per store', () => {
		expect(DECLARED.map((d) => d.store)).toEqual(['matrix_string_search', 'matrix_relation_index']);
		for (const { stamp } of DECLARED) {
			expect(stamp).toMatch(/^dedalo-derivation v\d+ sha256:[0-9a-f]{64}$/);
		}
	});
});

describe('stamp read/write on the suite DB (restored after)', () => {
	const STORE = 'matrix_relation_index';
	let original: string | null | undefined;

	afterAll(async () => {
		if (original !== undefined) await writeSearchStoreStamp(STORE, original);
	});

	test('a written stamp reads back; a non-grammar stamp is refused unwritten', async () => {
		await assertTestDatabase('update_run_ancillary_native.stamp');
		original = await readSearchStoreStamp(STORE);
		const stamp = DECLARED.find((d) => d.store === STORE)?.stamp as string;
		await writeSearchStoreStamp(STORE, stamp);
		expect(await readSearchStoreStamp(STORE)).toBe(stamp);
		await expect(writeSearchStoreStamp(STORE, "x'; DROP TABLE matrix; --")).rejects.toThrow(
			/stamp grammar/,
		);
		expect(await readSearchStoreStamp(STORE)).toBe(stamp);
		await expect(writeSearchStoreStamp('matrix', stamp)).rejects.toThrow(/not a declared/);
		await writeSearchStoreStamp(STORE, null);
		expect(await readSearchStoreStamp(STORE)).toBeNull();
	});
});
