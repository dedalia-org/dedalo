/**
 * THE INSTALL STAMPS WHAT IT FILLED (T1-25 / D05) — src/core/db/db_assets.ts
 * searchStoreStampProblem, the pure verdict the installer's seed verify
 * (db_restore.ts seedComplete → engineHalfProblem) and the seed compiler's
 * verify apply to the stamps a fresh install must leave on every derived
 * search store. Without them the first update re-derives every store in full
 * (ancillary.ts: a populated, unstamped store is a mismatch).
 *
 * Pure and hermetic: the observed map is planted. The outcome on a real
 * install is gated by install_e2e (stamps read from the scratch install).
 */

import { describe, expect, test } from 'bun:test';
import {
	declaredSearchStoreDerivations,
	SEARCH_STORE_DERIVATION_VERSION,
	searchStoreStampProblem,
} from '../../src/core/db/db_assets.ts';

const declared = declaredSearchStoreDerivations();
const current = (): Map<string, string | null> =>
	new Map(declared.map(({ store, stamp }) => [store, stamp]));

describe('searchStoreStampProblem — every declared store carries its declared stamp', () => {
	test('anti-vacuity: the stores are declared', () => {
		expect(declared.length).toBeGreaterThanOrEqual(2);
	});

	test('every store current: no problem', () => {
		expect(searchStoreStampProblem(current(), declared)).toBeNull();
		expect(searchStoreStampProblem(current())).toBeNull();
	});

	test('one store unstamped: named', () => {
		const first = declared[0]?.store as string;
		const observed = current();
		observed.set(first, null);
		const problem = searchStoreStampProblem(observed, declared);
		expect(problem).toContain(first);
		for (const { store } of declared.slice(1)) expect(problem).not.toContain(store);
	});

	test('one store stamped by another derivation version: named', () => {
		const last = declared.at(-1) as (typeof declared)[number];
		const other = declaredSearchStoreDerivations(SEARCH_STORE_DERIVATION_VERSION + 1);
		const observed = current();
		observed.set(last.store, other.at(-1)?.stamp ?? null);
		expect(searchStoreStampProblem(observed, declared)).toContain(last.store);
	});

	test('a declared store absent from the observation: named', () => {
		const first = declared[0]?.store as string;
		const observed = current();
		observed.delete(first);
		expect(searchStoreStampProblem(observed, declared)).toContain(first);
	});
});
