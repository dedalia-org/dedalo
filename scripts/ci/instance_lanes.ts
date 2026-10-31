#!/usr/bin/env bun
/**
 * INSTANCE-TIER LANES — the suite-database clones the instance tier's concurrent lanes
 * run on (scripts/ci/instance_tier.sh, `DEDALO_CI_INSTANCE_LANES=3`).
 *
 *   bun run scripts/ci/instance_lanes.ts provision   # sweep leftovers, clone ×3, seal; prints the names
 *   bun run scripts/ci/instance_lanes.ts sweep       # unseal the template, drop every clone + twin
 *
 * WHY CLONES. The crawl, the phone check, the client suite, the update drills and the
 * publication-host engine drill each install fixtures, set the suite login, reseed
 * test3 or hold a per-database lock (measured map, 2026-10-31): two of them on ONE
 * database refuse each other or move each other's fixture. Each lane gets its OWN
 * physical copy of the freshly built suite database — the unit tier's shard machinery
 * (scripts/lib/test_shard_db.ts: FILE_COPY clone, marker rewritten to name the clone,
 * media twin) — and the lane points every process at it with `DEDALO_TEST_DATABASE`,
 * from which the media root, the vector twin, the MariaDB lane and the suite run lock
 * are all derived. Never `DEDALO_TEST_MEDIA_ROOT` by hand (the header of test_shard_db.ts).
 *
 * THE TEMPLATE IS SEALED for the lanes' run (ALLOW_CONNECTIONS false): every lane runs
 * on a clone, so a process that escapes its lane and re-derives the template fails
 * LOUDLY on connect instead of writing a fixture its peers read. `sweep` unseals it —
 * run from the tier's EXIT trap, and on entry by `provision`, so a killed run cannot
 * leave the next one facing a sealed template or a stale clone.
 */
import { testDatabaseName } from '../../test/helpers/test_database.ts';
import {
	cloneShardMedia,
	provisionShardDatabase,
	sealTemplate,
	sweepShardClones,
	unsealTemplate,
} from '../lib/test_shard_db.ts';

/** The instance tier's lane count when it runs concurrently (instance_tier.sh plans three). */
export const INSTANCE_LANES = 3;

async function sweep(template: string): Promise<void> {
	if (await unsealTemplate(template)) console.error(`[lanes] template ${template} unsealed`);
	const report = await sweepShardClones(template);
	for (const name of report.dropped) console.error(`[lanes] dropped ${name}`);
	for (const { name, state } of report.refused)
		console.error(`[lanes] REFUSED to drop ${name} (${state})`);
	if (report.refused.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
	const command = process.argv[2];
	const template = testDatabaseName();
	if (command === 'sweep') return sweep(template);
	if (command !== 'provision') {
		console.error('usage: bun run scripts/ci/instance_lanes.ts provision|sweep');
		process.exit(2);
	}
	await sweep(template);
	const names: string[] = [];
	for (let lane = 1; lane <= INSTANCE_LANES; lane++) {
		names.push(await provisionShardDatabase(template, lane));
		await cloneShardMedia(template, lane);
	}
	for (const line of await sealTemplate(template)) console.error(`[lanes] ${line}`);
	console.error(`[lanes] template ${template} sealed; lanes: ${names.join(', ')}`);
	// stdout carries ONLY the names, one per line: the tier reads them.
	for (const name of names) console.log(name);
}

if (import.meta.main) await main();
