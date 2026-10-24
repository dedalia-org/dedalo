/**
 * MEDIA-03 — A CHUNKED UPLOAD IS CAPPED BY ITS ASSEMBLED SIZE, NOT ITS CHUNK COUNT.
 *
 * `parseUploadRequest` bounds ONE REQUEST (`file.size > maxSizeBytes`). A chunked
 * transfer is N requests, and `joinChunkedUpload` validated only
 * `total_chunks <= MAX_CHUNKS` and never summed a byte — so 100 000 parts each
 * under the per-request cap assembled, unrefused, into a file arbitrarily past
 * the ceiling the catalog advertises and `get_system_info` publishes. The limit
 * the engine stated was not the limit the engine enforced.
 *
 * This gate pins the three counting doors and the retention law:
 *
 *   • AT RECEIPT — the running total per transfer refuses the chunk that would
 *     cross the ceiling, BEFORE that part is written (receipt is where disk
 *     exhaustion actually happens; the join only runs once every byte is
 *     already on the disk).
 *   • AT THE JOIN, BEFORE ANY OUTPUT EXISTS — the pre-check sums the parts on
 *     disk and refuses without opening `assembled`.
 *   • DURING ASSEMBLY — the authoritative running total refuses a part that grew
 *     under a concurrent chunk POST after the pre-check read it.
 *   • AND A SIZE REFUSAL IS A QUARANTINE, NEVER A DELETE: the parts stay, the
 *     `rejected.json` marker names the reason, `listQuarantinedUploads` reports
 *     it, and a retry reads 'already rejected' instead of 'missing chunks'.
 *
 * Plus the prose leg: the catalog's own DEDALO_UPLOAD_MAX_SIZE_BYTES doc may not
 * promise a whole-file ceiling without naming the summation that makes it true —
 * the stated/enforced mismatch is the defect from either side. A planted
 * offender (the pre-fix paragraph) proves the checker bites.
 *
 * Situation-built, no DB, no install fixture: real parts written through the real
 * receiver into a MARKED scratch media root (test/helpers/media_scratch_root.ts).
 * The ceiling is driven through the `maxSizeBytes` FUNCTION ARGUMENT — never a
 * wire field — so the refusal is exercised without writing gigabytes; the last
 * test proves the DEFAULT is still the configured value and not a test-sized one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { uploadArtifactDir } from '../../src/core/media/ingest/staging_gc.ts';
import {
	joinChunkedUpload,
	listQuarantinedUploads,
	type ParsedUpload,
	REJECTION_MARKER,
	receiveUpload,
} from '../../src/core/media/ingest/upload.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { refusalOf, refusalOfSync } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('upload_cap');
const USER = 7;

/** A REAL 1x1 PNG (base64), so the under-cap leg passes content verification. */
const PNG = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	),
	(c) => c.charCodeAt(0),
);

function chunk(fields: Partial<ParsedUpload>, blob: Uint8Array): ParsedUpload {
	return {
		keyDir: 'kd',
		fileName: 'big.png',
		chunked: true,
		chunkIndex: 0,
		totalChunks: 2,
		blob,
		uploadId: null,
		csrfToken: null,
		...fields,
	};
}

/** Filler bytes — the size legs refuse before any content verification runs. */
const filler = (n: number): Uint8Array => new Uint8Array(n).fill(0x41);

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	markMediaRoot(ROOT);
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('MEDIA-03 — the ceiling is counted at receipt', () => {
	test('the chunk that would cross the cap is refused and NOT written; the transfer is quarantined', () => {
		const keyDir = 'cap_receipt';
		const uploadId = 'receiptcap0001';
		const base = { keyDir, uploadId, totalChunks: 3, fileName: 'x.png' };
		receiveUpload(chunk({ ...base, chunkIndex: 0 }, filler(60)), USER, ROOT, 100);
		const upDir = uploadArtifactDir(USER, keyDir, uploadId, ROOT);
		expect(existsSync(join(upDir, '0.part'))).toBe(true);

		const refusal = refusalOfSync(() =>
			receiveUpload(chunk({ ...base, chunkIndex: 1 }, filler(60)), USER, ROOT, 100),
		);
		expect(refusal.code).toBe('media.too_large');
		// Refused BEFORE the write: the crossing part never reached the disk…
		expect(existsSync(join(upDir, '1.part'))).toBe(false);
		// …and the parts already received were NOT destroyed.
		expect(existsSync(join(upDir, '0.part'))).toBe(true);
		expect(readFileSync(join(upDir, '0.part')).length).toBe(60);
		// The transfer is legible as quarantined, with the reason on disk.
		const marker = JSON.parse(readFileSync(join(upDir, REJECTION_MARKER), 'utf8')) as {
			reason: string;
			parts_kept?: boolean;
		};
		expect(marker.reason).toMatch(/exceeds the maximum allowed size/);
		expect(marker.parts_kept).toBe(true);
	});

	test('a RESEND of a part already on disk replaces it instead of adding to the total', () => {
		// The running total must be a total of the transfer, not of the requests:
		// the client transport retries a chunk, and a retry that double-counted
		// would refuse a transfer that is comfortably under the ceiling.
		const keyDir = 'cap_resend';
		const uploadId = 'resendcap00001';
		const base = { keyDir, uploadId, totalChunks: 2, fileName: 'x.png' };
		receiveUpload(chunk({ ...base, chunkIndex: 0 }, filler(60)), USER, ROOT, 150);
		receiveUpload(chunk({ ...base, chunkIndex: 0 }, filler(60)), USER, ROOT, 150);
		receiveUpload(chunk({ ...base, chunkIndex: 0 }, filler(60)), USER, ROOT, 150);
		// Three POSTs of the same part = 60 bytes staged, not 180.
		const second = receiveUpload(chunk({ ...base, chunkIndex: 1 }, filler(60)), USER, ROOT, 150);
		expect(second.complete).toBe(false);
		const upDir = uploadArtifactDir(USER, keyDir, uploadId, ROOT);
		expect(existsSync(join(upDir, REJECTION_MARKER))).toBe(false);
		expect(existsSync(join(upDir, '1.part'))).toBe(true);
	});
});

describe('MEDIA-03 — the ceiling is counted at the join', () => {
	test('the pre-check refuses BEFORE the assembled output is opened', async () => {
		const keyDir = 'cap_precheck';
		const uploadId = 'precheckcap001';
		const base = { keyDir, uploadId, totalChunks: 3, fileName: 'x.png' };
		// Staged under the DEFAULT ceiling (no override) — nothing refuses here.
		for (let i = 0; i < 3; i++) {
			receiveUpload(chunk({ ...base, chunkIndex: i }, filler(60)), USER, ROOT);
		}
		const upDir = uploadArtifactDir(USER, keyDir, uploadId, ROOT);
		// A DISCRIMINATOR, not decoration: an `assembled` file with a fresh mtime is
		// planted, so any code path that reaches the exclusive create answers
		// `media.upload_conflict` instead. Getting `media.too_large` therefore
		// proves the refusal happened BEFORE the output was ever opened.
		const assembled = join(upDir, 'assembled');
		writeFileSync(assembled, 'a live assembly by another join');

		const refusal = await refusalOf(
			joinChunkedUpload({
				keyDir,
				tmpName: 'x.png',
				totalChunks: 3,
				userId: USER,
				uploadId,
				mediaRoot: ROOT,
				maxSizeBytes: 100,
			}),
		);
		expect(refusal.code).toBe('media.too_large');
		// Nothing of the planted output was touched, and every part is still there.
		expect(readFileSync(assembled, 'utf8')).toBe('a live assembly by another join');
		for (let i = 0; i < 3; i++) expect(existsSync(join(upDir, `${i}.part`))).toBe(true);
		// Quarantined with the exact summed size, released by cancel or the sweep.
		const marker = JSON.parse(readFileSync(join(upDir, REJECTION_MARKER), 'utf8')) as {
			size: number;
			parts_kept?: boolean;
		};
		expect(marker.size).toBe(180);
		expect(marker.parts_kept).toBe(true);
	});

	test('a part that GROWS after the pre-check is caught by the assembly total, and quarantined not deleted', async () => {
		const keyDir = 'cap_assembly';
		const uploadId = 'assemblycap001';
		const base = { keyDir, uploadId, totalChunks: 2, fileName: 'x.png' };
		receiveUpload(chunk({ ...base, chunkIndex: 0 }, filler(60)), USER, ROOT);
		receiveUpload(chunk({ ...base, chunkIndex: 1 }, filler(60)), USER, ROOT);
		const upDir = uploadArtifactDir(USER, keyDir, uploadId, ROOT);

		// 120 bytes staged, ceiling 150 → the pre-check passes. The join then runs
		// synchronously until its first yield (mid-copy of part 0), which is where
		// control comes back here: a concurrent chunk POST grows part 1 under it.
		const running = joinChunkedUpload({
			keyDir,
			tmpName: 'x.png',
			totalChunks: 2,
			userId: USER,
			uploadId,
			mediaRoot: ROOT,
			maxSizeBytes: 150,
		});
		appendFileSync(join(upDir, '1.part'), Buffer.from(filler(400)));

		const refusal = await refusalOf(running);
		expect(refusal.code).toBe('media.too_large');
		// The PARTS — the only copy of the transfer — survive; the partial output,
		// a derived duplicate of them, does not linger.
		expect(existsSync(join(upDir, '0.part'))).toBe(true);
		expect(existsSync(join(upDir, '1.part'))).toBe(true);
		expect(existsSync(join(upDir, 'assembled'))).toBe(false);
		// And the quarantine is READABLE through the operator door.
		const quarantined = listQuarantinedUploads(USER, keyDir, ROOT);
		expect(quarantined.length).toBe(1);
		expect(quarantined[0]?.uploadId).toBe(uploadId);
		expect(quarantined[0]?.record?.reason).toMatch(/exceeds the maximum allowed size/);
		expect(quarantined[0]?.record?.parts_kept).toBe(true);
		// A retry says what actually happened, not 'missing chunks'.
		const retry = await refusalOf(
			joinChunkedUpload({
				keyDir,
				tmpName: 'x.png',
				totalChunks: 2,
				userId: USER,
				uploadId,
				mediaRoot: ROOT,
				maxSizeBytes: 150,
			}),
		);
		expect(retry.message).toMatch(/already rejected/);
	});

	test('POSITIVE CONTROL: a transfer under the ceiling still joins and verifies', async () => {
		const keyDir = 'cap_ok';
		const uploadId = 'undercap000001';
		const mid = Math.floor(PNG.length / 2);
		const base = { keyDir, uploadId, totalChunks: 2, fileName: 'small.png' };
		receiveUpload(chunk({ ...base, chunkIndex: 0 }, PNG.slice(0, mid)), USER, ROOT);
		receiveUpload(chunk({ ...base, chunkIndex: 1 }, PNG.slice(mid)), USER, ROOT);
		const joined = await joinChunkedUpload({
			keyDir,
			tmpName: 'small.png',
			totalChunks: 2,
			userId: USER,
			uploadId,
			mediaRoot: ROOT,
		});
		expect(joined.complete).toBe(true);
		expect(joined.extension).toBe('png');
		// Byte-identical: the counting doors do not truncate a legitimate transfer.
		const staged = join(stagingDir(USER, keyDir, ROOT), joined.tmpName as string);
		expect(readFileSync(staged)).toEqual(Buffer.from(PNG));
		// Nothing quarantined, nothing left behind.
		expect(listQuarantinedUploads(USER, keyDir, ROOT)).toEqual([]);
		expect(readdirSync(stagingDir(USER, keyDir, ROOT)).filter((e) => e.startsWith('.up_'))).toEqual(
			[],
		);
	});

	test('the DEFAULT ceiling is the CONFIGURED one, not a test-sized constant', () => {
		// The override is a function argument for gates; with none passed the
		// ceiling must be what the catalog advertises and get_system_info
		// publishes. The transfers above staged and joined with no override, which
		// is only possible because that value is the 2 GiB-class configured cap.
		expect(config.media.upload.maxSizeBytes).toBeGreaterThan(1024 * 1024);
	});
});

/**
 * The doc block of ONE catalog key, read out of the catalog source. Not a
 * hand-copied string: the assertion has to read what the catalog actually says.
 */
function catalogDoc(key: string): string {
	const source = readFileSync(join(import.meta.dir, '../../src/config/catalog/media.ts'), 'utf8');
	const start = source.indexOf(`\t${key}: {`);
	if (start < 0) throw new Error(`catalog key not found: ${key}`);
	const docStart = source.indexOf('doc: `', start);
	const docEnd = source.indexOf('`,', docStart + 6);
	if (docStart < 0 || docEnd < 0) throw new Error(`catalog doc not found: ${key}`);
	return source.slice(docStart + 6, docEnd);
}

/**
 * The prose defect: a paragraph that promises a ceiling ON THE FILE while naming
 * only the per-request check. Either half may be fixed — the code counts the
 * whole file now — but the two must agree, so the checker flags prose that
 * claims the whole-file ceiling without naming what sums the chunks.
 */
function promisesAnUncountedWholeFileCeiling(doc: string): boolean {
	const claimsWholeFile = /file as a whole|whole file|on the FILE|largest file/i.test(doc);
	const namesTheSummation =
		/(chunk|part|transfer)[^.]{0,200}(sums?|summing|running total|added together|assembl)/i.test(
			doc,
		);
	return claimsWholeFile && !namesTheSummation;
}

describe('MEDIA-03 — the catalog prose states the ceiling the code counts', () => {
	test('DEDALO_UPLOAD_MAX_SIZE_BYTES does not promise an uncounted whole-file ceiling', () => {
		const doc = catalogDoc('DEDALO_UPLOAD_MAX_SIZE_BYTES');
		// Corpus floor: a doc that had shrunk to nothing would pass vacuously.
		expect(doc.length).toBeGreaterThan(600);
		expect(promisesAnUncountedWholeFileCeiling(doc)).toBe(false);
	});

	test('POSITIVE CONTROL: the pre-fix paragraph is flagged by the same checker', () => {
		const offender =
			'This parameter defines the largest file, in BYTES, that Dédalo will accept in an upload.\n\n' +
			'The limit is enforced twice. The server publishes it to the client, and the server checks the size of every part it receives, so the limit holds even against a client that ignores it.\n\n' +
			'Splitting the file into chunks (DEDALO_UPLOAD_SERVICE_CHUNK_FILES) is what keeps a single request small; this ceiling applies to the file as a whole.';
		expect(promisesAnUncountedWholeFileCeiling(offender)).toBe(true);
	});
});
