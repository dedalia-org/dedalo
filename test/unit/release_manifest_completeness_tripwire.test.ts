/**
 * RELEASE MANIFEST COMPLETENESS (update audit 2026-10-29, U-38 + U-30) — what a
 * release ships must make every install REGENERATE what it derived, and the
 * update run must RECONCILE every derived surface. Outcome-measured, never a
 * spelling:
 *
 *  (i)  U-38 media rules. The .htaccess / nginx conf / nginx map are RENDERED
 *       for fixed inputs (a fixed scratch root, every mode, fixed qualities and
 *       addons — scripts/derivation_versions.ts renderMediaRules) and hashed;
 *       engineering/derivation_versions.json banks {TEMPLATE_VERSION, hash}.
 *       TEMPLATE_VERSION is folded into the rule files' config hash, so it alone
 *       makes installs rewrite their files: a template edit with no bump ships
 *       rules no install regenerates. Red when the hash moved under the same
 *       version, and when the version moved but the bank was not re-recorded.
 *  (ii) U-30 search-store derivation: the same law for the declared derivation
 *       (sync function bodies + backfill templates, db_assets.ts
 *       searchStoreDerivationHash) vs SEARCH_STORE_DERIVATION_VERSION — the
 *       version folded into the stamp the ancillary phase compares.
 *       Re-record both with `bun run scripts/derivation_versions.ts --update`
 *       (it refuses a moved hash under an unmoved version).
 *  (iii) completeness: ANCILLARY_RECONCILERS' ids equal the CENSUS below, in
 *       order, and the phase really fails (with a summary sentence, no raw
 *       exception text) when a reconciler throws — a planted one proves it.
 *
 * THE CENSUS — what an update can leave stale on an install, and why each is in:
 *   tools             dd1324 rows are DERIVED from tools/<tool>/register.json,
 *                     which the code phase replaces.
 *   observer_mirrors  set_dato_external mirrors are derived from observed
 *                     records under observer definitions; the ontology phase
 *                     moves definitions, the data phase writes records past the
 *                     save chokepoint.
 *   search_stores     matrix_string_search / matrix_relation_index are derived
 *                     from matrix rows by declared sync functions the schema /
 *                     code phases can change (a CREATE OR REPLACE never re-derives
 *                     rows already there).
 *   media_rules       the generated web-server rule files are derived from the
 *                     templates the code phase replaces.
 * And why the rest is OUT: in-process caches (ontology, context, labels, tool
 * caches) die with the restart the code phase ends in, or are invalidated by
 * the phase that moved them (ontology_phase, importTools); client assets and
 * the label catalogs are served from the tree itself; published targets are a
 * curator's act with their own retry ledger (dd1758), not a derivation of the
 * install; the install seed is a build artifact, never an install surface.
 * Adding a derived surface = a census line here AND a reconciler — either alone
 * is red.
 */

import { describe, expect, test } from 'bun:test';
import {
	currentDerivations,
	type Derivations,
	judgeBank,
	readBank,
	renderMediaRules,
	updateRefusals,
} from '../../scripts/derivation_versions.ts';
import {
	type AssetEntry,
	declaredSearchStoreDerivations,
	declaredSyncFunctions,
	SEARCH_STORE_BACKFILLS,
} from '../../src/core/db/db_assets.ts';
import definitions from '../../src/core/db/db_pg_definitions.json';
import {
	ANCILLARY_RECONCILERS,
	type AncillaryDeps,
	type AncillaryReconciler,
	runAncillaryPhase,
} from '../../src/core/update/run/ancillary.ts';
import { createRunJournal } from '../../src/core/update/run/journal.ts';

const CENSUS = ['tools', 'observer_mirrors', 'search_stores', 'media_rules'];

const current = currentDerivations();
const banked = readBank();

describe('(i)+(ii) the derivation bank equals what the tree measures', () => {
	test('media rules and search-store derivation: bank == tree', () => {
		expect(judgeBank(current, banked)).toEqual([]);
	});

	test('the media render covers all three artifacts and every mode, machine-free', () => {
		const text = renderMediaRules();
		expect(text.split('\n<ARTIFACT>\n')).toHaveLength(7);
		for (const needle of [
			'RewriteEngine On', // htaccess gated modes
			'# 2. Rule B', // publication rule B (fixed qualities)
			'RewriteRule ^fixed-addon$ - [L]', // the fixed addon placed
			'$dedalo_auth_key', // nginx conf
			'map $uri $dedalo_svg_csp', // nginx map
			'<ROOT>/.publication/auth/',
		]) {
			expect(text).toContain(needle);
		}
		expect(text).not.toMatch(/# config-hash: [0-9a-f]{64}/);
		expect(text).not.toContain('dedalo_derivation_render_');
	});

	test('the search-store derivation hashes real declared bodies, version-free', () => {
		for (const contract of SEARCH_STORE_BACKFILLS) {
			const entry = (definitions.ar_trigger as AssetEntry[]).filter(
				(candidate) => candidate.name === contract.triggerEntry,
			);
			const fns = declaredSyncFunctions(entry);
			expect(fns).toHaveLength(1);
			expect(fns[0]?.body.length ?? 0).toBeGreaterThan(50);
		}
		const v1 = declaredSearchStoreDerivations(1);
		const v2 = declaredSearchStoreDerivations(2);
		expect(v1.map((d) => d.hash)).toEqual(v2.map((d) => d.hash));
		expect(v1.map((d) => d.stamp)).not.toEqual(v2.map((d) => d.stamp));
	});

	test('the judge reds a forgotten bump and an unrecorded bump (planted)', () => {
		const moved: Derivations = {
			...current,
			media_rules: { ...current.media_rules, hash: 'f'.repeat(64) },
		};
		expect(judgeBank(moved, current)).toEqual([expect.stringContaining('but its version did not')]);
		expect(updateRefusals(moved, current)).toHaveLength(1);
		const bumped: Derivations = {
			...current,
			search_stores: { version: current.search_stores.version + 1, hash: 'e'.repeat(64) },
		};
		expect(judgeBank(bumped, current)).toEqual([
			expect.stringContaining('the bank was not re-recorded'),
		]);
		expect(updateRefusals(bumped, current)).toEqual([]);
		const backwards: Derivations = {
			...current,
			media_rules: { ...current.media_rules, version: current.media_rules.version - 1 },
		};
		expect(updateRefusals(backwards, current)).toHaveLength(1);
	});
});

/** Every effect stubbed: nothing imported, nothing written, every reconciler runs. */
const STUB_DEPS: AncillaryDeps = {
	importTools: async () => [],
	reconcileObserverMirrors: async () => {
		throw new Error('not reached: the journal has no ontology/data phase');
	},
	ensureSearchStores: async () => ({
		healthy: true,
		ddlApplied: false,
		backfilled: {},
		backfilledTables: [],
		errors: [],
	}),
	reconcileSearchStoreDerivation: async () => ({
		decisions: [],
		rederived: [],
		stamped: [],
		errors: 0,
	}),
	clearSearchStoreCache: () => {},
	writeRuleFiles: () => true,
	getRulesStatus: () => ({}),
};

const journal = createRunJournal({
	from: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
	to: { release: '7.0.2', data: '7.0.0', model: '7.0.0' },
	plan: [{ release: '7.0.2', step: { kind: 'ancillary' } }],
});

describe('(iii) every derived surface has a reconciler, and a failing one fails the phase', () => {
	test('ANCILLARY_RECONCILERS ids == the census, in order', () => {
		expect(ANCILLARY_RECONCILERS.map((reconciler) => reconciler.id)).toEqual(CENSUS);
	});

	test('the real table runs every reconciler (outcome, not presence)', async () => {
		const result = await runAncillaryPhase(journal, STUB_DEPS);
		expect(result.outcome).toBe('ok');
		expect(Object.keys(result.evidence.reconcilers as object)).toEqual(CENSUS);
	});

	test('anti-vacuity: a planted throwing reconciler fails the phase with a sentence', async () => {
		const RAW = 'RAW-EXCEPTION-TEXT-planted /secret/path';
		const planted: AncillaryReconciler = {
			id: 'planted',
			run: async () => {
				throw new Error(RAW);
			},
		};
		const errorLog = console.error;
		console.error = () => {};
		let result: Awaited<ReturnType<typeof runAncillaryPhase>>;
		try {
			result = await runAncillaryPhase(journal, STUB_DEPS, [...ANCILLARY_RECONCILERS, planted]);
		} finally {
			console.error = errorLog;
		}
		expect(result.outcome).toBe('failed');
		expect(result.evidence.failed).toBe('planted');
		expect(result.evidence.summary).toEqual(expect.stringContaining('planted'));
		expect(JSON.stringify(result.evidence)).not.toContain(RAW);
		// the reconcilers before it ran and are on the record
		expect(Object.keys(result.evidence.reconcilers as object)).toEqual(CENSUS);
	});
});
