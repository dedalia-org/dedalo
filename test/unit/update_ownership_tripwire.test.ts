/**
 * TRIPWIRE — standalone-ownership classification of the maintenance-widget
 * EXECUTE surface + the engine-version single-source rule (UPDATE_PROCESS
 * Phase 0; rewrite/COEXISTENCE.md "Standalone-ownership gate" row).
 *
 * Invariants:
 *  1. EVERY widget apiActions entry is ownership-classified: marked `gated`
 *     (consults core/update/ownership.ts via support.ts gated()/gatedStub()),
 *     marked `denied` (engineDenied — closed-by-design), or listed in the
 *     named ENGINE_NATIVE exemption registry below with a reason. A new
 *     EXECUTE cannot bypass the gate by simply not mentioning it.
 *  2. The gated set is FROZEN (EXPECTED_GATED): silently un-gating an
 *     update/move EXECUTE is a red test, and so is gating a new action
 *     without ledgering it here.
 *  3. Denied handlers are PURE refusals: invoked, they return the
 *     engine_denied envelope (no DB, no writes) — the coexisting-mode
 *     contract engine_denied_boundary.test.ts pins byte-level.
 *  4. Engine/data version literals live ONLY in src/core/update/version.ts —
 *     the eight pre-Phase-0 hardcode sites must not regrow.
 *
 * Enumeration is marker-based over the LIVE registry (support.ts
 * OWNERSHIP_MARK function property) — no grep fragility. Hermetic-safe: no
 * DB, no state writes; only pure denied closures are invoked.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { ALL_WIDGET_MODULES } from '../../src/core/area_maintenance/widgets/registry.ts';
import {
	ownershipMark,
	type WidgetHandler,
} from '../../src/core/area_maintenance/widgets/support.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { DEDALO_ENGINE_VERSION } from '../../src/core/update/build_stamp.ts';
import { DEDALO_VERSION, DEDALO_VERSION_TRIPLE } from '../../src/core/update/version.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * ENGINE-NATIVE exemptions: apiActions that mutate TS-owned surfaces (or are
 * read-only) and deliberately do NOT consult the ownership gate — they never
 * touch anything the coexisting PHP install owns. Every entry needs a reason;
 * entries whose action disappears from the registry fail the staleness check.
 */
const ENGINE_NATIVE: Record<string, string> = {
	'make_backup.make_psql_backup': "pg_dump into the TS tree's own backup dir",
	'make_backup.get_dedalo_backup_files': 'read-only backup listing',
	'check_config.set_maintenance_mode':
		'TS-native runtime state (ts_state.json), not the PHP config_core.php',
	'check_config.set_recovery_mode': 'TS-native runtime state (ts_state.json)',
	'check_config.set_notification': 'TS-native runtime state (ts_state.json)',
	'config_areas.save_config_areas': 'TS-native runtime state (ts_state.json areas deny/allow)',
	'menu_skip_tipos.save_menu_skip_tipos': 'TS-native runtime state (ts_state.json menu skip list)',
	'export_hierarchy.sync_hierarchy_active_status':
		'hierarchy active-status sync through the TS write path',
	'export_hierarchy.export_hierarchy':
		'psql dump of hierarchy sections into the ENGINE-owned install/import/hierarchy dir (the same directory add_hierarchy imports from) — no PHP-tree surface is written',
	'export_hierarchy.export_hierarchy_json':
		'writes the hierarchy.json manifest (registry census + data-file digests) into the ENGINE-owned install/import/hierarchy dir — no PHP-tree surface is written',
	'add_hierarchy.install_hierarchies':
		'imports + activates vendored hierarchy files into the engine-owned (configured) database — the wizard EXECUTE path, reachable post-seal only through this widget',
	'add_hierarchy.reset_hierarchies':
		'DESTRUCTIVE delete-then-reimport of a hierarchy into the engine-owned (configured) database — explicit confirmed "Reset to seed" (PHP replace parity)',
	'diffusion_server_control.get_value': 'read-only diffusion engine status',
	'diffusion_server_control.cancel_process': 'TS-owned diffusion engine control (Bun owns MariaDB)',
	'diffusion_server_control.requeue_job': 'TS-owned diffusion engine control',
	'diffusion_server_control.purge_jobs': 'TS-owned diffusion engine control',
	'diffusion_server_control.set_scheduler': 'TS-owned diffusion engine control',
	'diffusion_server_control.retry_pending_deletions': 'TS-owned diffusion engine control',
	'runtime_info.clear_cache_files': 'TS in-process caches only',
	'runtime_info.clear_session_files': 'TS-owned session store pruning',
	'database_info.analyze_db':
		'shared-DB maintenance through the TS db_assets path (PHP-parity action, no PHP-tree surface)',
	'database_info.analyze_statistics':
		'TS-native statistics repair (plain ANALYZE, scoped to the tables the WC-073 verdict names) — no PHP-install surface exists to own it',
	'database_info.consolidate_tables': 'shared-DB maintenance through the TS db_assets path',
	'database_info.rebuild_user_stats': 'shared-DB maintenance through the TS db_assets path',
	'database_info.optimize_tables': 'shared-DB maintenance through the TS db_assets path',
	'database_info.rebuild_db_functions': 'shared-DB maintenance through the TS db_assets path',
	'database_info.relation_integrity_report':
		'read-only matrix_relation_index audit (dangling locators / non-integer ids); admin-gated at the maintenance dispatch',
	'database_info.rebuild_db_constraints': 'shared-DB maintenance through the TS db_assets path',
	'database_info.rebuild_db_indexes': 'shared-DB maintenance through the TS db_assets path',
	'database_info.recreate_db_assets': 'shared-DB maintenance through the TS db_assets path',
	'database_info.backfill_search_stores':
		'shared-DB maintenance through the TS db_assets path (derived-store TRUNCATE + refill; the previous-beta upgrade path)',
	'unit_test.create_test_record': 'scratch test-record surface (matrix_test)',
	'unit_test.long_process_stream': 'SSE stress-test job (mediaJobs ticks only; touches no data)',
	'media_control.get_value': 'read-only media index status',
	'media_control.rebuild_media_index': 'TS-owned media index rebuild',
	'media_control.set_media_access_mode':
		'TS-native runtime state (ts_state.json media_access_mode) + the TS-owned media rule files (.htaccess / nginx include) — no PHP-install surface exists to own',
	'counters_status.get_value': 'read-only counters panel',
	'counters_status.modify_counter':
		'matrix_counter repair through the TS write path (PHP-parity action)',
	'counters_status.reconcile_media_counters':
		'matrix_counter repair through the TS write path — the restore-day reconcile against the MEDIA tree (P0-14/LIFE-01); raise-only and dry by default',
	'reconcile_status.run_reconcile':
		'the reconcile REGISTRY door (core/reconcile, S-10): runs one registered cross-store reconcile through the TS write paths it wraps — dry by default, apply only on the explicit flag',
	'counters_status.repair_all_counters':
		'matrix_counter repair through the TS write path — the bulk form of modify_counter fix (P0-14); raise-only',
	'dataframe_control.get_value': 'read-only dataframe panel',
	'dataframe_control.run_check': 'read-only dataframe consistency check',
	'dataframe_control.run_fix': 'dataframe repair through the TS write path',
	'error_reports.get_reports': 'read-only listing of the TS-owned error-report intake table',
	'publication_hosts.apply_rules':
		'root-only; renders the phase-1 publication_host profile and sends rules.apply to a PAIRED agent through the one channel door (core/publication_host) — a publication-host surface no PHP install ever owned',
	'publication_hosts.probe': 'root-only; read-only media.probe on a paired agent',
	'publication_hosts.rollback_api':
		'root-only; release.rollback on a paired agent (swaps the API current link back on the PUBLICATION host) — no PHP-install surface',
	'publication_hosts.set_host_fields':
		'root-only; edits public_url/qualities/probe in the TS-owned <private>/publication_hosts.json registry (atomic, locked)',
	'publication_hosts.remove_host':
		'root-only; deletes a host from the TS-owned registry and its secret dir under <private>/publication_hosts/, and forgets its in-process pairing proof — the agent itself is untouched',
	'publication_hosts.push_apis':
		"root-only push of the installed tree's verified Publication API releases to paired publication hosts through the TS-owned registry + agent channel (phase 4) — no PHP-tree surface",
	'publication_hosts.reconcile_media_copy':
		'root-only door onto the registered media_copy reconcile (core/reconcile): copies/unmarks/deletes published public-quality media on ONE copy-mode publication host through the copy worker lane and the paired agent channel (phase 5) — no PHP-tree surface',
	'publication_hosts.probe_public':
		'TS-native publication-host public-URL probe (phase 6): two bounded GETs through the public door (fetchGuardedText) + the runtime observation file — root-only, writes no gate, media or registry',
	'publication_hosts.propose_draft':
		'TS-native "New publication host" form proposal: reads the publication-host registry + drafts file — root-only, writes nothing, no PHP-tree surface',
	'publication_hosts.save_draft':
		"TS-native publication-host draft store (<private>/publication_host_drafts.json, judged by the agent package's own rules) — root-only, no PHP-tree surface",
	'publication_hosts.remove_draft':
		'TS-native publication-host draft store + its cached kit — root-only, no PHP-tree surface',
	'publication_hosts.build_kit':
		'TS-native publication-host kit from the verified installed tree (publication manifest kit census) into the code-backup build cache — root-only, no PHP-tree surface',
	'publication_hosts.download_kit':
		'TS-native: serves the cached publication-host kit, re-hashed — root-only, no PHP-tree surface',
	'publication_hosts.pair_package':
		"TS-native pairing (core/publication_host/pair_flow.ts, the CLI's own path) from a sealed package that must complete a saved draft — root-only, no PHP-tree surface",
};

/**
 * The FROZEN gated set (UPDATE_PROCESS phases): `stub: true` means the open
 * branch is still the denied closure (its phase has not landed). Adding a
 * gated action, or landing a phase (stub → false), updates this map in the
 * same change; removing the gate on any of these is a regression.
 */
const EXPECTED_GATED: Readonly<Record<string, { stub: boolean }>> = {
	'update_ontology.update_ontology': { stub: false }, // phase 2 — LANDED
	'update_data_version.update_data_version': { stub: false }, // phase 3 — LANDED
	'update_code.update_code': { stub: false }, // phase 4 — LANDED
	'serve_code.build_version_from_git_master': { stub: false }, // phase 4 — LANDED (moved from update_code 2026-09-28)
	'update_code.restore_code': { stub: false }, // phase 4 — the swap in reverse
	'update_code.delete_restore_point': { stub: false }, // phase 4 — retention's guarded manual delete
	'update_code.request_image_update': { stub: false }, // D3/D4 2026-10-09 — records a request the opt-in HOST updater claims; the engine never touches docker
	'update_code.cancel_image_update_request': { stub: false }, // D3/D4 2026-10-09 — withdraws an UNCLAIMED request
	'move_tld.move_tld': { stub: false }, // phase 5 — LANDED
	'move_locator.move_locator': { stub: false }, // phase 5 — LANDED
	'move_to_portal.move_to_portal': { stub: false }, // phase 5 — LANDED
	'move_to_table.move_to_table': { stub: false }, // phase 5 — LANDED
	'move_lang.move_lang': { stub: false }, // phase 5 — LANDED
	'register_tools.register_tools': { stub: false }, // phase 1 — LANDED
	'build_database_version.build_recovery_version_file': { stub: false }, // phase 2 — LANDED
	'build_database_version.restore_dd_ontology_recovery_from_file': { stub: false }, // phase 2 — LANDED
	'build_database_version.build_install_version': { stub: false }, // 2026-10-09 — native seed builder (install/seed_build.ts)
};

interface ActionEntry {
	key: string;
	handler: WidgetHandler;
}

function allActions(): ActionEntry[] {
	const entries: ActionEntry[] = [];
	for (const module of ALL_WIDGET_MODULES) {
		for (const [action, handler] of Object.entries(module.apiActions ?? {})) {
			entries.push({ key: `${module.spec.id}.${action}`, handler });
		}
	}
	return entries;
}

describe('ownership classification is TOTAL over the widget registry', () => {
	test('the registry census is populated (a classification over nothing classifies nothing)', () => {
		// 33 modules / 60+ actions on 2026-09-02. ALL_WIDGET_MODULES is the live
		// registry, not a hand list, but an emptied registry — a refactor that
		// left CORE_WIDGET_MODULES behind — would make every TOTAL assertion below
		// pass vacuously (census_derivation_tripwire, P2-20).
		expect(ALL_WIDGET_MODULES.length).toBeGreaterThanOrEqual(30);
		expect(allActions().length).toBeGreaterThan(30);
	});

	test('every apiActions entry is gated, denied, or a named ENGINE_NATIVE exemption', () => {
		const unclassified: string[] = [];
		const doubleClassified: string[] = [];
		const misnamed: string[] = [];
		for (const { key, handler } of allActions()) {
			const mark = ownershipMark(handler);
			if (mark === undefined) {
				if (!(key in ENGINE_NATIVE)) unclassified.push(key);
				continue;
			}
			if (key in ENGINE_NATIVE) doubleClassified.push(key);
			if (mark.what !== key) misnamed.push(`${key} (marked as '${mark.what}')`);
		}
		expect(
			unclassified,
			'UNCLASSIFIED widget EXECUTEs — classify each: wrap with gated()/gatedStub() (consults the ownership gate) or engineDenied() (closed-by-design), or add a named ENGINE_NATIVE exemption WITH A REASON in this file:',
		).toEqual([]);
		expect(
			doubleClassified,
			'marked handlers must not ALSO be listed in ENGINE_NATIVE (pick one classification):',
		).toEqual([]);
		expect(misnamed, "mark.what must be '<widget_id>.<action>' (the registry key):").toEqual([]);
	});

	test('ENGINE_NATIVE staleness: every exemption resolves to a live action, with a reason', () => {
		const live = new Set(allActions().map((entry) => entry.key));
		const rotted = Object.keys(ENGINE_NATIVE).filter((key) => !live.has(key));
		expect(
			rotted,
			'ENGINE_NATIVE entries whose widget.action no longer exists (drop them):',
		).toEqual([]);
		const reasonless = Object.entries(ENGINE_NATIVE)
			.filter(([, reason]) => reason.trim() === '')
			.map(([key]) => key);
		expect(reasonless, 'ENGINE_NATIVE entries need a non-empty reason:').toEqual([]);
	});

	test('the gated set is exactly EXPECTED_GATED (frozen — un-gating is a regression)', () => {
		const gatedKeys = allActions()
			.filter(({ handler }) => ownershipMark(handler)?.kind === 'gated')
			.map(({ key }) => key)
			.sort();
		expect(gatedKeys).toEqual(Object.keys(EXPECTED_GATED).sort());
	});

	test('phase state: openIsStub matches the ledgered phase state per action', () => {
		for (const { key, handler } of allActions()) {
			const mark = ownershipMark(handler);
			if (mark?.kind !== 'gated') continue;
			expect(mark.openIsStub, `${key} openIsStub`).toBe(EXPECTED_GATED[key]?.stub ?? true);
		}
	});
});

describe('denied handlers are pure engine_denied refusals', () => {
	const DUMMY: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as Principal;

	test('every denied-marked handler (incl. gated whenClosed stubs) refuses without side effects', async () => {
		for (const { key, handler } of allActions()) {
			const mark = ownershipMark(handler);
			// direct denials, plus the denied closures behind gated stubs
			const targets: WidgetHandler[] = [];
			if (mark?.kind === 'denied') targets.push(handler);
			if (mark?.kind === 'gated' && mark.whenClosed !== undefined) {
				const closedMark = ownershipMark(mark.whenClosed);
				if (closedMark?.kind === 'denied') targets.push(mark.whenClosed);
			}
			for (const target of targets) {
				// Since the P1 error sweep a denial is a THROW of the registered
				// `maintenance.widget_unavailable`, whose PUBLIC sentence still names
				// the method and points at the PHP dashboard (same bytes as before).
				let thrown: unknown;
				try {
					await target({}, DUMMY);
				} catch (error) {
					thrown = error;
				}
				expect(thrown, `${key} denied throws`).toBeInstanceOf(DedaloError);
				const error = thrown as DedaloError;
				expect(error.code, `${key} denied code`).toBe('maintenance.widget_unavailable');
				expect(error.publicMessage, `${key} denied message`).toMatch(
					/^Error\. '.+' is not runnable on this engine: .+\. Run it from the PHP maintenance dashboard\.$/,
				);
			}
		}
	});
});

describe('TLS peer verification stays ON (WC-023 D1)', () => {
	test("no 'rejectUnauthorized: false' in src/ or tools/ runtime code", () => {
		const banned = /rejectUnauthorized['"]?\s*:\s*false/;
		const offenders: string[] = [];
		let scanned = 0;
		const glob = new Glob('{src,tools}/**/*.ts');
		for (const rel of glob.scanSync({ cwd: REPO_ROOT })) {
			if (rel.endsWith('.test.ts')) continue;
			scanned += 1;
			const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
			const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
			if (banned.test(stripped)) offenders.push(rel);
		}
		expect(
			offenders,
			'TLS peer verification must never be disabled (PHP ssl_verifypeer=false is the weakness this port rejects; pin private CAs via NODE_EXTRA_CA_CERTS):',
		).toEqual([]);
		expect(scanned).toBeGreaterThan(600); // anti-vacuity: the walk saw the engine
	});
});

describe('engine-version single source (core/update/version.ts)', () => {
	// DERIVED from the live triple — the ratchet keeps guarding after a version
	// bump instead of silently scanning for a version nobody ships any more.
	// Quote-anchored: '<v>' / "<v>.dev" / `<v>` — never bare (would
	// false-positive on '127.0.0.1'); plus the [M, m, p] array form.
	const escaped = DEDALO_VERSION.replace(/\./g, '\\.');
	const stringLiteral = new RegExp(`['"\`]${escaped}(\\.dev)?['"\`]`);
	const arrayLiteral = new RegExp(`\\[\\s*${DEDALO_VERSION_TRIPLE.join('\\s*,\\s*')}\\s*\\]`);

	test('self-check: the derived regexes match the current version (a dead regex is a dead gate)', () => {
		expect(stringLiteral.test(`'${DEDALO_VERSION}'`)).toBe(true);
		expect(stringLiteral.test(`"${DEDALO_VERSION}.dev"`)).toBe(true);
		expect(stringLiteral.test(`\`${DEDALO_ENGINE_VERSION}\``)).toBe(true);
		expect(arrayLiteral.test(`[${DEDALO_VERSION_TRIPLE.join(', ')}]`)).toBe(true);
		expect(arrayLiteral.test(`[${DEDALO_VERSION_TRIPLE.join(',')}]`)).toBe(true);
		// quote-anchoring: an IP-shaped bare occurrence must NOT trip
		expect(stringLiteral.test(`'12${DEDALO_VERSION}.1'`)).toBe(false);
	});

	test('no version literals outside version.ts in src/, tools/ and scripts/', () => {
		const offenders: string[] = [];
		// scripts/ IS scanned (2026-08-24): the release drill hardcoded the pair
		// `7.0.0 → 7.0.1`, so the one gate that rehearses cutting a release would
		// have gone red the moment a release was cut — and nothing said so,
		// because the scan stopped at src/ and tools/. A version literal is the
		// same defect wherever it lives; the derived rung belongs to the catalog.
		let scanned = 0;
		const glob = new Glob('{src,tools,scripts}/**/*.ts');
		for (const rel of glob.scanSync({ cwd: REPO_ROOT })) {
			if (rel === join('src', 'core', 'update', 'version.ts')) continue;
			if (rel.endsWith('.test.ts')) continue;
			scanned += 1;
			const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
			// strip block comments, then line-comment tails
			const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
			if (stringLiteral.test(stripped) || arrayLiteral.test(stripped)) {
				offenders.push(rel);
			}
		}
		expect(
			offenders,
			'engine/data version literals belong in src/core/update/version.ts ONLY (import the exported shapes):',
		).toEqual([]);
		expect(scanned).toBeGreaterThan(700); // anti-vacuity: src/ + tools/ + scripts/ were walked
	});
});
