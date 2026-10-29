/**
 * The resident-growth measurement of test/unit/hierarchy_import_stream_memory_native.test.ts,
 * run in a FRESH process. Inside the unit tier's one long-lived `bun test` process the
 * allocator reuses pages earlier files freed but never returned, so a touched allocation
 * of twice the ceiling grew RSS by ~50 MB there and the probe was blind (the control
 * leg went red; the import leg's green proved nothing). A fresh process has no such pool.
 *
 * `bun test/helpers/hierarchy_import_memory_probe.ts control <ceiling bytes>`
 * `bun test/helpers/hierarchy_import_memory_probe.ts import <tld> <importDir> <file> <sha256>`
 * Prints ONE JSON line: { grew, value }. Spawned by the gate with the suite env
 * (NODE_ENV=test + DEDALO_TEST_DATABASE), so it reaches the marked suite DB only.
 */

import { importHierarchyRows } from '../../src/core/install/hierarchy_import.ts';
import { connFromConfig } from '../../src/core/install/pg_exec.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

/** The server's condition: ~1M small live objects + 100 MiB of live strings (see the gate's header). */
const BALLAST_OBJECTS = 1_000_000;
const BALLAST_STRINGS = 100;

function liveHeapBallast(): { objects: unknown[]; strings: string[] } {
	const objects: unknown[] = [];
	for (let at = 0; at < BALLAST_OBJECTS; at++) objects.push({ at, label: `b${at}`, pair: [at] });
	const strings: string[] = [];
	for (let at = 0; at < BALLAST_STRINGS; at++) strings.push(`${'b'.repeat(1 << 20)}${at}`);
	return { objects, strings };
}

/** Peak resident growth while `work` runs (sampled every 10 ms, from a collected baseline). */
async function residentGrowth<T>(work: () => Promise<T>): Promise<{ grew: number; value: T }> {
	Bun.gc(true);
	const baseline = process.memoryUsage().rss;
	let peak = baseline;
	const sampler = setInterval(() => {
		peak = Math.max(peak, process.memoryUsage().rss);
	}, 10);
	let value: T;
	try {
		value = await work();
	} finally {
		clearInterval(sampler);
	}
	peak = Math.max(peak, process.memoryUsage().rss);
	return { grew: peak - baseline, value };
}

const [mode, ...rest] = Bun.argv.slice(2);
if (mode === 'control') {
	const bytes = Number(rest[0]);
	const out = await residentGrowth(async () => {
		const held = Buffer.alloc(bytes, 1);
		await Bun.sleep(50);
		return held.length;
	});
	console.log(JSON.stringify(out));
} else if (mode === 'import') {
	const [tld, importDir, file, sha256] = rest as [string, string, string, string];
	await assertTestDatabase('hierarchy_import_memory_probe');
	let ballast: ReturnType<typeof liveHeapBallast> | null = liveHeapBallast();
	const out = await residentGrowth(() =>
		importHierarchyRows(connFromConfig(), tld, { importDir, dataFiles: [{ file, sha256 }] }),
	);
	// Held through the measurement (non-vacuity), released after it.
	const held = ballast.objects.length + ballast.strings.length;
	ballast = null;
	console.log(
		JSON.stringify({ ...out, ballast: held, expectedBallast: BALLAST_OBJECTS + BALLAST_STRINGS }),
	);
	process.exit(0); // the pool keeps the loop alive
} else {
	throw new Error(`hierarchy_import_memory_probe: unknown mode '${mode}'`);
}
