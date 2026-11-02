#!/usr/bin/env bun
/**
 * INSTANCE-TIER LANES — the suite-database clones the instance tier's concurrent lanes
 * run on (scripts/ci/instance_tier.sh, `DEDALO_CI_INSTANCE_LANES=3`).
 *
 *   bun run scripts/ci/instance_lanes.ts provision <names-file>   # sweep leftovers, clone ×3,
 *                                                    # seal; the clone names → <names-file>, one a line
 *   bun run scripts/ci/instance_lanes.ts sweep       # unseal the template, drop every clone + twin
 *   bun run scripts/ci/instance_lanes.ts print <log> # a lane's log to stdout, whole
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
 *
 * `print` EXISTS BECAUSE `cat` CANNOT DO IT. A Bun process leaves the tier's shared stdout
 * pipe NON-BLOCKING (O_NONBLOCK lives on the open file description every child inherits);
 * a lane's whole log written at once then fills the pipe and `cat` dies mid-file on
 * EAGAIN ("write error: Resource temporarily unavailable" — measured 2026-10-31: two lane
 * logs cut short, and under `set -e` the tier's shell gone with the rest). `print` writes
 * the file and waits out EAGAIN.
 */
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
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

/** Write all of `bytes` to fd 1, waiting out EAGAIN on a non-blocking pipe. */
export function writeAllToStdout(bytes: Uint8Array, write = writeSync): void {
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += write(1, bytes, offset, bytes.length - offset);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
			Bun.sleepSync(5);
		}
	}
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command === 'print') {
		const path = process.argv[3];
		if (path === undefined) {
			console.error('usage: bun run scripts/ci/instance_lanes.ts print <log>');
			process.exit(2);
		}
		return writeAllToStdout(readFileSync(path));
	}
	const template = testDatabaseName();
	if (command === 'sweep') return sweep(template);
	const namesFile = process.argv[3];
	if (command !== 'provision' || namesFile === undefined) {
		console.error(
			'usage: bun run scripts/ci/instance_lanes.ts provision <names-file> | sweep | print <log>',
		);
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
	// The names go to a FILE, never stdout: the shard helpers log there (a terminated
	// template backend — measured 2026-10-31, that line became lane 1's "database").
	for (const name of names)
		if (!/^[a-z0-9_]+__shard\d+$/.test(name))
			throw new Error(
				`[lanes] provisioned an unexpected name '${name}' — refusing to hand it to a lane`,
			);
	writeFileSync(namesFile, `${names.join('\n')}\n`);
}

if (import.meta.main) await main();
