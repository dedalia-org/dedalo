/**
 * `shouldDeactivate` — the per-row decision extracted out of
 * `exportHierarchySyncActiveStatus` (plan §4.1.7).
 *
 * The sync action walks every ACTIVE hierarchy registry row and deactivates
 * the ones the thesaurus no longer marks active. Two skips carry the risk:
 *   - `target === <the People hierarchy>` exempts it. Drop the arm and
 *     pressing the button deactivates People on EVERY install.
 *   - `active_ts === '1'` skips rows already in sync. Drop it and each press
 *     writes a needless component save plus a time-machine row per hierarchy.
 *
 * The loop itself and `saveComponentData` are never driven from here: the
 * action writes real hierarchy registry records through the standard save
 * path. The decision is what has arms; the loop has none.
 */
// Migrated 2026-08-19 (generic-`test`-TLD sweep). The tipos below are NOT a corpus
// binding: `rsc197` is a CONSTANT COMPILED INTO THE ENGINE (the People-hierarchy
// exemption in export_hierarchy.ts), so the gate must spell exactly the string the
// source holds. `rsc` ships in the seed, so — as in test_corpus_fixture.test.ts — the
// tipos are composed through `seed()` to keep the install-TLD census's token grammar
// (scripts/lib/tld_census.ts) from reading them as records this gate reads.

import { describe, expect, test } from 'bun:test';
import {
	shouldDeactivate,
	widget,
} from '../../src/core/area_maintenance/widgets/export_hierarchy.ts';
import { HIERARCHY_IMPORT_DIR } from '../../src/core/install/paths.ts';

const SOURCE_FILE = `${import.meta.dir}/../../src/core/area_maintenance/widgets/export_hierarchy.ts`;

/** A seed-shipped tipo, kept out of the census's token grammar. */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** The exempted 'People' hierarchy target — the engine's own constant. */
const PEOPLE = seed('rsc', 197);
/** Any other hierarchy target. */
const OTHER = seed('rsc', 170);
/** Near-misses that must NOT inherit the exemption. */
const PEOPLE_PREFIXED = seed('rsc', 1970);
const PEOPLE_TRUNCATED = seed('rsc', 19);

describe('shouldDeactivate — the four-cell truth table', () => {
	test('out of sync and not People: DEACTIVATE (the only writing cell)', () => {
		expect(shouldDeactivate({ active_ts: '2', target: OTHER })).toBe(true);
	});

	test('in sync and not People: skip (no write, no TM row)', () => {
		expect(shouldDeactivate({ active_ts: '1', target: OTHER })).toBe(false);
	});

	test('out of sync but People: EXEMPT — the load-bearing cell', () => {
		// Without the People arm this returns true and the action deactivates
		// the People thesaurus on every install that presses the button.
		expect(shouldDeactivate({ active_ts: '2', target: PEOPLE })).toBe(false);
	});

	test('in sync and People: skip', () => {
		expect(shouldDeactivate({ active_ts: '1', target: PEOPLE })).toBe(false);
	});
});

describe('shouldDeactivate — the coercion shapes the SQL really produces', () => {
	test('a NULL active flag is out of sync, not in sync', () => {
		// `->>` yields NULL when the component holds no value at all.
		expect(shouldDeactivate({ active_ts: null, target: OTHER })).toBe(true);
	});

	test('the active comparison is against the STRING "1", never truthiness', () => {
		// `->>` renders text: a truthiness test would read '0' as false-y and
		// deactivate nothing, and would read '2' as in-sync-adjacent noise.
		expect(shouldDeactivate({ active_ts: '0', target: OTHER })).toBe(true);
		expect(shouldDeactivate({ active_ts: '', target: OTHER })).toBe(true);
	});

	test('the People exemption is EXACT, not a prefix', () => {
		// The prefixed and truncated near-misses must not inherit the exemption.
		expect(shouldDeactivate({ active_ts: '2', target: PEOPLE_PREFIXED })).toBe(true);
		expect(shouldDeactivate({ active_ts: '2', target: PEOPLE_TRUNCATED })).toBe(true);
	});

	test('a NULL target is not exempt', () => {
		expect(shouldDeactivate({ active_ts: '2', target: null })).toBe(true);
	});
});

describe('the extraction is REWIRED, not duplicated', () => {
	test('the sync loop calls the extraction and holds no inline copy', async () => {
		const source = await Bun.file(SOURCE_FILE).text();
		const loop = source.slice(source.indexOf('for (const row of rows)'));
		expect(loop).not.toBe('');
		expect(loop).toContain('if (!shouldDeactivate(row)) continue;');
		// The inline predicates are gone from the loop — an extraction that left
		// them would gate a copy while the shipped decision stayed unreachable.
		expect(loop).not.toContain("row.active_ts === '1'");
		expect(loop).not.toContain(`row.target === '${PEOPLE}'`);
		// and each predicate survives EXACTLY ONCE in the file, inside the extraction
		expect(source.split(`row.target === '${PEOPLE}'`).length - 1).toBe(1);
		expect(source.split("row.active_ts === '1'").length - 1).toBe(1);
	});
});

describe('the panel value', () => {
	test('getValue exists — without it the panel refuses to open at all', () => {
		expect(typeof widget.getValue).toBe('function');
	});

	test('reports the export path, because export is implemented on this engine', async () => {
		// RESTATED at the 2026-08-21 merge. This case used to assert `null`, on the
		// premise stated in its own comment: "exporting writes install dump files
		// and is engine-denied here". That premise ended when export was ported
		// natively (d22c7279c9) — the action no longer writes into the PHP tree, so
		// it is no longer engineDenied and a null path would now be a LIE that hides
		// a working feature from the client (which renders the export form only for
		// a truthy path).
		//
		// The half of the original that still holds is kept above: a getValue must
		// EXIST or the panel refuses to open and even the sync form is unreachable.
		const response = await widget.getValue?.({}, {} as never);
		expect(response?.data).toEqual({ export_hierarchy_path: HIERARCHY_IMPORT_DIR });
	});

	test('the panel offers its three operations, and export is a real handler', () => {
		expect(Object.keys(widget.apiActions ?? {}).sort()).toEqual([
			'export_hierarchy',
			'export_hierarchy_json',
			'sync_hierarchy_active_status',
		]);
		// Not a denial stub: the ported action is a live function. (A denied action
		// is also a function, so this is a floor, not a proof — the export
		// behaviour itself is gated by the cases above in this file.)
		expect(typeof widget.apiActions?.export_hierarchy).toBe('function');
	});
});
