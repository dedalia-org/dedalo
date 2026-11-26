/**
 * build_database_version widget — install/recovery dump machinery. The
 * INSTALL SEED compiler (build_install_version) builds this tree's vendored
 * seed from the repository's own sources in a marked scratch database and
 * proves it by a fresh install before writing it (core/install/seed_build.ts);
 * it reads no installation's database. The panel's choices — the ontology
 * release SOURCE (shipped / this master's export / a configured master), the
 * OUTPUT (private dir / this checkout) and the preflight — are
 * core/install/seed_panel.ts; the build runs as a maintenance-lane job. The dd_ontology RECOVERY pair is
 * ownership-gated (UPDATE_PROCESS Phase 2): the recovery file is the safety
 * net the ontology update leans on (core/ontology/recovery_file.ts).
 * build_matrix_hierarchy_main_sql was RETIRED 2026-11-26 (was engineDenied: its PHP
 * output, install/import/matrix_hierarchy_main.sql, has no consumer — the seed
 * builder filters the hierarchy registry itself; hierarchy.json describes the rest).
 */

import type { Principal } from '../../security/permissions.ts';
import type { WidgetModule, WidgetResponse } from './support.ts';
import { engineDenied, fromOutcome, gated } from './support.ts';

/*
 * COVERAGE-EXEMPT, all four functions in this file — buildRecoveryOwned,
 * restoreRecoveryOwned, buildInstallOwned, buildDatabaseVersionGetValue
 * (coverage plan §5.2; reason registered in engineering/crap_coverage_exempt.json):
 * single-expression delegations to core/ontology/recovery_file.ts and
 * core/install/seed_build.ts, gated THERE (including the truncated-recovery-file
 * case; the seed build through its source/outFile seam). `buildInstallOwned`
 * OVERWRITES this checkout's vendored install seed and its manifest (compiled from
 * the repository's sources — no database is read). `restoreDdOntologyRecoveryFromFile` REPLACES the
 * shared `dd_ontology` wholesale — the single most destructive action in the
 * maintenance area — and has no scratch equivalent.
 */
async function buildRecoveryOwned(): Promise<WidgetResponse> {
	const { buildRecoveryVersionFile } = await import('../../ontology/recovery_file.ts');
	return fromOutcome(await buildRecoveryVersionFile());
}

async function restoreRecoveryOwned(): Promise<WidgetResponse> {
	const { restoreDdOntologyRecoveryFromFile } = await import('../../ontology/recovery_file.ts');
	return fromOutcome(await restoreDdOntologyRecoveryFromFile());
}

/**
 * A BACKGROUND mediaJobs job (maintenance lane), like update_ontology: the answer is the
 * {pid, pfile} poll handle; each finished step rides the job's `data` as `{steps}` while it
 * runs; the job's RESULT is the build readout. A refused / failed build is the job's error
 * (maintenance.action_failed, its readout in `extend`). Options: `source` (`shipped` |
 * `local_export` | `master:<name>`), `target` (`private` | `checkout`).
 */
async function buildInstallOwned(
	options: Record<string, unknown>,
	principal: Principal,
): Promise<WidgetResponse> {
	const { parseSeedSource, parseSeedTarget, runPanelSeedBuild } = await import(
		'../../install/seed_panel.ts'
	);
	const source = parseSeedSource(options.source);
	const target = parseSeedTarget(options.target);
	const { mediaJobs } = await import('../../media/jobs.ts');
	const record = mediaJobs.submit(
		'build_install_version',
		async ({ onData, signal }) => {
			const steps: string[] = [];
			const result = await runPanelSeedBuild({
				source,
				target,
				userId: principal.userId,
				signal,
				onStep: (line) => {
					steps.push(line);
					onData({ steps: [...steps] });
				},
			});
			return {
				msg: result.msg,
				...(result.findings.length === 0 ? {} : { errors: result.findings }),
				steps: result.steps,
				file_size: result.file_size,
				target: result.target,
				output: result.output,
				source: result.source,
				release: result.release,
				pulled: result.pulled,
				checks: result.manifest.verified.checks,
			};
		},
		{ lane: 'maintenance', userId: principal.userId },
	);
	return {
		data: true,
		msg: `OK. Seed build running in process ${process.pid}`,
		extend: { pid: process.pid, pfile: `${record.id}.json` },
	};
}

/** Every check a build needs, for the chosen source + output (options as build_install_version). */
async function seedPreflightOwned(options: Record<string, unknown>): Promise<WidgetResponse> {
	const { parseSeedSource, parseSeedTarget, seedPreflight } = await import(
		'../../install/seed_panel.ts'
	);
	const report = await seedPreflight(
		parseSeedSource(options.source),
		parseSeedTarget(options.target),
	);
	return { data: report };
}

/**
 * get_widget_value panel load: what a seed is compiled FROM (repo sources + an
 * ontology release — never a database) and every release source this server can
 * offer, the outputs it can write, the vendored seed's state against this
 * checkout, and the last private build. The compiler's own constants, never a
 * parallel spelling. `source_db` / `target_db` / `target_file` are the
 * pre-redesign panel's three fields (kept until the client reads the rest).
 */
async function buildDatabaseVersionGetValue(): Promise<WidgetResponse> {
	const { readdirSync } = await import('node:fs');
	const { relative } = await import('node:path');
	const { projectRoot } = await import('../../../config/env.ts');
	const { SEED_DUMP_PATH, SEED_SOURCES_DIR } = await import('../../install/paths.ts');
	const { ONTOLOGY_RELEASE_DIR, SEED_MIGRATIONS_DIR, SEED_ONTOLOGY_TLDS } = await import(
		'../../install/seed_sources.ts'
	);
	const panel = await import('../../install/seed_panel.ts');
	const sources = await panel.seedSourceOptions();
	return {
		data: {
			source_db: `${relative(projectRoot, SEED_SOURCES_DIR)} + ${relative(projectRoot, ONTOLOGY_RELEASE_DIR)}`,
			target_db: 'dedalo_seed_build_<pid>',
			target_file: relative(projectRoot, SEED_DUMP_PATH),
			parts: {
				schema: relative(projectRoot, SEED_SOURCES_DIR),
				migrations: readdirSync(SEED_MIGRATIONS_DIR).filter((name) =>
					/^\d{4}_[a-z0-9_]+\.sql$/.test(name),
				).length,
				core_tlds: [...SEED_ONTOLOGY_TLDS],
			},
			sources,
			default_source: sources[0]?.id ?? 'shipped',
			targets: [
				{ id: 'private', available: true, location: panel.SEED_BUILDS_DIR },
				{
					id: 'checkout',
					available: panel.checkoutWritable(),
					location: relative(projectRoot, SEED_DUMP_PATH),
				},
			],
			checkout_seed: await panel.checkoutSeedState(),
			last_build: await panel.latestPrivateBuild(),
		},
	};
}

export const widget: WidgetModule = {
	spec: {
		id: 'build_database_version',
		category: 'data',
		label: { kind: 'label', key: 'build_database_version' },
	},
	// A whole-dd_ontology dump / restore: maintenance (PERF-11).
	unboundedActions: ['build_recovery_version_file', 'restore_dd_ontology_recovery_from_file'],
	getValue: buildDatabaseVersionGetValue,
	apiActions: {
		// Ownership-gated like the recovery pair: closed keeps the frozen denial.
		build_install_version: gated(
			'build_database_version.build_install_version',
			engineDenied(
				'build_database_version.build_install_version',
				'it writes install/ SQL dumps into the PHP tree',
			),
			buildInstallOwned,
		),
		seed_preflight: gated(
			'build_database_version.seed_preflight',
			engineDenied(
				'build_database_version.seed_preflight',
				'it checks a build this engine does not own',
			),
			seedPreflightOwned,
		),
		// Ownership-gated (UPDATE_PROCESS Phase 2): closed keeps the frozen denial.
		build_recovery_version_file: gated(
			'build_database_version.build_recovery_version_file',
			engineDenied(
				'build_database_version.build_recovery_version_file',
				'it writes recovery files into the PHP tree',
			),
			buildRecoveryOwned,
		),
		restore_dd_ontology_recovery_from_file: gated(
			'build_database_version.restore_dd_ontology_recovery_from_file',
			engineDenied(
				'build_database_version.restore_dd_ontology_recovery_from_file',
				'it replaces the shared dd_ontology from a PHP-tree recovery file',
			),
			restoreRecoveryOwned,
		),
	},
};
