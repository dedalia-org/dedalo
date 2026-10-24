/**
 * THE MEASURED PROCESS of tool_export_media_zip_native leg M (refused
 * candidates never stay in memory).
 *
 * A live-heap peak can only be read honestly in a process that does ONE thing:
 * measured in the gate's own process (2026-10, full CI unit tier) the
 * forced-GC `heapUsed` delta passed the 8 MB bound for a writer whose failure
 * list lives in an unlinked temp file — whatever else that process had
 * allocated (earlier legs, the 60 000-row spool build, the bun:test runtime)
 * moved the number, not the writer. Same defect, same cure as leg E of
 * tool_export_delimited_html_writers_native (export_writer_heap_child.ts): the
 * gate spawns this file once per spool size and reads the JSON it prints as
 * the last stdout line.
 *
 * WHAT IS SAMPLED. At every sink write AFTER THE FIRST a full GC runs and the
 * LIVE heap (`heapUsed`) above the post-GC baseline is sampled. The last writes
 * are info.txt's, when a failure list held in memory would be whole. The FIRST
 * write (info.txt's local header, right after the rows walk) is not sampled:
 * the walk's last spool chunk can still be conservatively reachable at that
 * instant (measured in-process: one 12 MB sample, gone at the next write).
 * Every write while info.txt streams IS sampled. The sink counts bytes and
 * drops each chunk (nothing here keeps the archive).
 *
 * WRITES NOTHING of its own: the spool is the PARENT gate's (a marked
 * export-artifacts scratch root it builds and sweeps). The writer's failure log
 * is an UNLINKED temp in that job directory — no name survives it.
 *
 *   bun run media_zip_heap_child.ts <jobDir>
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportManifest } from '../../tools/tool_export/server/artifact_store.ts';
import { openSpoolReader } from '../../tools/tool_export/server/spool_reader.ts';
import { mediaZipWriter } from '../../tools/tool_export/server/writers/media_zip.ts';
import type { FileSink } from '../../tools/tool_export/server/writers/types.ts';

/** What the parent parses (the last stdout line). */
export interface MediaZipHeapReport {
	/** Files archived (the writer's `rows`). */
	rows: number;
	bytes: number;
	writes: number;
	samples: number;
	/** Largest live-heap growth (bytes) over the post-GC baseline at any sample. */
	peakGrowth: number;
}

const [jobDir = ''] = process.argv.slice(2);
if (jobDir === '') {
	console.error(`media_zip_heap_child: bad arguments ${JSON.stringify(process.argv.slice(2))}`);
	process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(jobDir, 'manifest.json'), 'utf8')) as ExportManifest;

let baseline = 0;
let peakGrowth = 0;
let samples = 0;
let bytes = 0;
let writes = 0;
const sink: FileSink = {
	// scratch metering is leg N's subject; here the heap is
	async admitScratch() {},
	async write(chunk) {
		bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
		if (writes++ === 0) return;
		// LIVE heap only: collect first, so parse garbage is not counted
		Bun.gc(true);
		peakGrowth = Math.max(peakGrowth, process.memoryUsage().heapUsed - baseline);
		samples++;
	},
	get bytes() {
		return bytes;
	},
};

const spool = openSpoolReader(jobDir, { indexEvery: manifest.index_every });
Bun.gc(true);
baseline = process.memoryUsage().heapUsed;
const result = await mediaZipWriter(
	{ spool, manifest, options: { origin: '', showTipoInLabel: false } },
	sink,
	new AbortController().signal,
);
if (result.bytes !== bytes) {
	console.error(`media_zip_heap_child: writer reported ${result.bytes} bytes, sink saw ${bytes}`);
	process.exit(3);
}
const report: MediaZipHeapReport = { rows: result.rows, bytes, writes, samples, peakGrowth };
console.log(JSON.stringify(report));
process.exit(0);
