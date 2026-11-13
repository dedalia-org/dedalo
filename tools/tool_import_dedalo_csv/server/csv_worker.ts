/**
 * CSV parse worker (audit S3-42): parseCsv/analyzeCsv are CPU-bound and were
 * running ON the serving event loop — opening the import tool re-parsed AND
 * re-scanned EVERY csv synchronously, stalling all users' requests/SSE for
 * seconds on large files. This worker runs the identical pure code off-loop.
 *
 * Two modes:
 *  - analyze: return only the get_csv_files summary (header + counts + bounded
 *    preview + malformed-JSON rows). The full row set never crosses the thread
 *    boundary, so the structured clone stays tiny.
 *  - default (parse): return the full parsed rows — import_files needs them.
 *
 * The text is bounded before it gets here: the read door refuses a file over
 * CSV_INGEST_MAX_BYTES (bytes on disk) before buffering it (T1-S18).
 */

import { analyzeCsv, parseCsvDetailed } from '../../../src/core/tools/import_csv.ts';

declare let self: Worker;

self.onmessage = (event: MessageEvent) => {
	const { text, delimiter, analyze } = event.data as {
		text: string;
		delimiter?: string;
		analyze?: boolean;
	};
	try {
		if (analyze === true) {
			postMessage({ analysis: analyzeCsv(text, delimiter) });
		} else {
			// The full parse RESULT, not just the rows: the ingest door refuses a file
			// whose enclosure never closes (DATA-04), and that diagnostic exists only
			// inside the parse — recomputing it on the main thread would put the whole
			// CPU-bound parse back on the serving loop, which is what this worker exists
			// to prevent (audit S3-42).
			postMessage({ result: parseCsvDetailed(text, delimiter) });
		}
	} catch (error) {
		postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};
