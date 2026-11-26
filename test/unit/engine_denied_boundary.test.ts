/**
 * The CLOSED-BY-DESIGN boundary, made explicit: every PHP maintenance method
 * that mutates the PHP INSTALL (code tree, install/ files, config files) or
 * replaces shared assets from PHP-tree sources is registered as an EXPLICIT
 * engine_denied refusal — a named reason, not a generic unauthorized_method.
 * This test enumerates the boundary; a new denial belongs here, and a denial
 * that becomes portable leaves here with its port.
 *
 * @twin-of      test/parity/tools_register_differential.test.ts
 * @twin-status  supplement
 *
 * STATUS CHANGED 2026-08-29, frozen-record -> supplement, and the reason is a WIN:
 * the parity gate this twins is no longer red. It was frozen as a corpus-bound failure
 * against a suite database that had drifted from the repo; rebuilding the fixture
 * through `bun run test:db:setup` put the tools register back in sync and the
 * differential now PASSES. So this file no longer carries the portable half of a
 * contract the oracle could only half-prove — it adds coverage alongside a green gate.
 * The status is DERIVED from the tree by scripts/twin_map.ts; this header follows it,
 * never the other way round.
 */

import { describe, expect, test } from 'bun:test';
import { dispatchWidgetRequest } from '../../src/core/area_maintenance/widgets/registry.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';

/** The DedaloError an async call rejected with (fails when nothing typed was thrown). */
async function rejectedBy(run: () => Promise<unknown>): Promise<DedaloError> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(DedaloError);
		return error as DedaloError;
	}
	throw new Error('expected a DedaloError, nothing was thrown');
}

const ROOT = { userId: -1, isGlobalAdmin: true };

// NOTE: register_tools.register_tools LEFT this boundary — the tools/ tree is
// now TS-owned, so the import runs here (dry-run by default). See
// test/parity/tools_register_differential.test.ts + test/unit/tools_register*.
//
// 2026-07-11 cutover: the ownership-GATED actions (update_code.update_code /
// serve_code.build_version_from_git_master (update_code's until 2026-09-28), update_ontology.update_ontology, the move_*
// family, build_database_version.build_recovery_version_file /
// restore_dd_ontology_recovery_from_file) left this LIVE-dispatch boundary —
// engineOwnsInstall() is collapsed to true, so their OPEN branches answer
// here. Their frozen whenClosed refusal closures stay pinned byte-level by
// update_ownership_tripwire.test.ts ("denied handlers are pure refusals").
// What remains below is the PURE engineDenied set: closed-by-design methods
// whose surfaces this engine never took over.
//
// 2026-07-12: media_control.set_media_access_mode LEFT this boundary with its port. The
// media access mode is now TS-native runtime state (ts_state.json) and the engine owns
// BOTH generated web-server rule files — there is no PHP install config to write. See
// src/core/media/protection.ts + engineering/MEDIA_PROTECTION.md (closes MEDIA-01).
//
// 2026-08-19: export_hierarchy.export_hierarchy LEFT this boundary with its port.
// The denial's premise ("it writes install hierarchy dump files into the PHP
// tree") stopped being true at the cutover: the destination is now the ENGINE's
// own install/import/hierarchy directory — a fixed, repo-root-derived constant
// (HIERARCHY_IMPORT_DIR), the very directory add_hierarchy already imports from.
// PHP took it from an EXPORT_HIERARCHY_PATH constant that was never carried over;
// see config/migration_map.ts for the retired-constant record.
//
// 2026-10-09: build_database_version.build_install_version LEFT this boundary with
// its port. "It writes install/ SQL dumps into the PHP tree" stopped being true at
// the cutover: the dump it writes is THIS engine's vendored seed
// (install/paths.ts SEED_DUMP_PATH, restored by installDbFromSeed). Native builder:
// core/install/seed_build.ts, gated by seed_build_native.test.ts.
//
// 2026-11-26: build_database_version.build_matrix_hierarchy_main_sql was RETIRED (the
// action and its panel deleted): its PHP output had no consumer on this engine
// (WC-2026-11-26-build-database-version-panel).
const DENIED: [string, string][] = [
	['update_ontology', 'export_to_translate'],
	['update_ontology', 'rebuild_lang_files'],
];

describe('closed-by-design boundary (explicit engine_denied refusals)', () => {
	test('every boundary method refuses with the NAMED maintenance.widget_unavailable code', async () => {
		for (const [widget, method] of DENIED) {
			const error = await rejectedBy(() =>
				dispatchWidgetRequest(ROOT as never, { model: widget, action: method }, {}),
			);
			expect(error.code).toBe('maintenance.widget_unavailable');
			// The sentence NAMES the refused method and points at the PHP dashboard
			// (public disclosure — it reaches the admin who fired it).
			expect(error.publicMessage).toContain(`'${widget}.${method}'`);
			expect(error.publicMessage).toContain('is not runnable on this engine');
			expect(error.publicMessage).toContain('PHP maintenance dashboard');
		}
	});

	test('unknown methods still get the generic registry denial', async () => {
		const error = await rejectedBy(() =>
			dispatchWidgetRequest(ROOT as never, { model: 'update_code', action: 'not_a_method' }, {}),
		);
		expect(error.code).toBe('tool.method_not_allowed');
		expect(error.details?.method).toBe('not_a_method');
	});
});
