/**
 * Phase F gate: the upload receiver (multipart parse, MIME sniff, chunked join
 * + SEC-066 re-sniff) + the full ingest chain (upload → add_file → regenerate),
 * with a REAL image, against a scratch root. Also pins the fail-closed security
 * behaviors: wrong extension, polyglot chunk assembly.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';
import {
	joinChunkedUpload,
	type ParsedUpload,
	parseUploadRequest,
	receiveUpload,
} from '../../src/core/media/ingest/upload.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import { magickTestEnv } from '../helpers/magick_test_env.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_upload');
const image = mediaTypeOf('component_image')!;
const HAVE_MAGICK = existsSync(resolveMagick());
const USER = 3;
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };

/** Produce real jpeg bytes via ImageMagick. */
async function jpegBytes(size = '200x200'): Promise<Uint8Array> {
	const tmp = `${ROOT}/_scratch_${Math.abs(size.length)}.jpg`;
	const { mkdirSync } = await import('node:fs');
	mkdirSync(ROOT, { recursive: true });
	await runBinary([resolveMagick(), '-size', size, 'xc:purple', tmp], {
		nice: false,
		env: magickTestEnv(),
	});
	const bytes = new Uint8Array(readFileSync(tmp));
	rmSync(tmp, { force: true });
	return bytes;
}

function parsed(fields: Partial<ParsedUpload>, blob: Uint8Array): ParsedUpload {
	return {
		keyDir: 'kd',
		fileName: 'photo.jpg',
		chunked: false,
		chunkIndex: 0,
		totalChunks: 1,
		blob,
		uploadId: null,
		csrfToken: null,
		...fields,
	};
}

// DECLARE the scratch root — the media doors refuse an unmarked one under the
// test-media seam (src/core/media/test_media_root.ts).
beforeAll(() => resetMediaRoot(ROOT));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('upload receiver — single-shot', () => {
	test.if(HAVE_MAGICK)('sniffs + stages a valid jpg; complete=true', async () => {
		const bytes = await jpegBytes();
		const result = receiveUpload(parsed({}, bytes), USER, ROOT);
		expect(result.complete).toBe(true);
		expect(result.extension).toBe('jpg');
		expect(result.tmpName).toBe('photo.jpg');
	});

	test.if(HAVE_MAGICK)(
		'rejects a jpg declared as .png (signature mismatch, fail closed)',
		async () => {
			const bytes = await jpegBytes();
			expect(() => receiveUpload(parsed({ fileName: 'evil.png' }, bytes), USER, ROOT)).toThrow();
		},
	);

	test('rejects unknown bytes declared as an image (fail closed)', () => {
		const junk = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(() => receiveUpload(parsed({ fileName: 'x.jpg' }, junk), USER, ROOT)).toThrow();
	});

	test('rejects a ZERO-BYTE upload (no signature → fail closed, nothing staged)', () => {
		// Pinned contract: empty bytes carry no recognizable signature, so the
		// sniffer rejects them before anything is written.
		expect(() =>
			receiveUpload(
				parsed({ keyDir: 'kd0', fileName: 'empty.jpg' }, new Uint8Array(0)),
				USER,
				ROOT,
			),
		).toThrow(/Unrecognized file signature/);
		expect(existsSync(join(stagingDir(USER, 'kd0', ROOT), 'empty.jpg'))).toBe(false);
	});

	test('rejects a part larger than the configured maxSizeBytes cap (M6)', async () => {
		// The configured cap (default 2 GiB) is too large to allocate in a test, so
		// the cap CHECK is exercised through its seam: parseUploadRequest consults
		// only `file.size` BEFORE buffering, so a Blob subclass reporting an
		// oversized length drives the M6 throw without allocating the bytes.
		class OversizedBlob extends Blob {
			override get size(): number {
				return config.media.upload.maxSizeBytes + 1;
			}
		}
		const oversized = new OversizedBlob([new Uint8Array([0xff, 0xd8, 0xff]) as BlobPart]);
		const form = {
			get: (key: string) =>
				key === 'file_to_upload' ? oversized : key === 'file_name' ? 'huge.jpg' : null,
		} as unknown as FormData;
		const request = {
			headers: new Headers(),
			formData: async () => form,
		} as unknown as Request;
		await expect(parseUploadRequest(request)).rejects.toThrow(/exceeds the maximum allowed size/);
		// …and it is the REGISTERED refusal, not an untyped throw the endpoint has
		// to guess at (ERRORS_SPEC §1).
		expect((await refusalOf(parseUploadRequest(request))).code).toBe('media.too_large');
	});
});

describe('upload receiver — chunked store + join (client contract)', () => {
	test.if(HAVE_MAGICK)('each chunk stores + echoes index/total; join assembles', async () => {
		const bytes = await jpegBytes('300x200');
		const mid = Math.floor(bytes.length / 2);
		const base = { keyDir: 'kdc', fileName: 'big.jpg', chunked: true, totalChunks: 2 };
		// Chunk POSTs store the part and echo the counter fields (client counts these).
		const r0 = receiveUpload(parsed({ ...base, chunkIndex: 0 }, bytes.slice(0, mid)), USER, ROOT);
		expect(r0.complete).toBe(false);
		expect(r0.chunkIndex).toBe(0);
		expect(r0.totalChunks).toBe(2);
		expect(r0.tmpName).toBe('big.jpg'); // present on EVERY chunk (was the bug)
		const r1 = receiveUpload(parsed({ ...base, chunkIndex: 1 }, bytes.slice(mid)), USER, ROOT);
		expect(r1.complete).toBe(false);
		// The client, having counted all chunks, fires the join.
		const joined = await joinChunkedUpload({
			keyDir: 'kdc',
			tmpName: 'big.jpg',
			totalChunks: 2,
			userId: USER,
			uploadId: r0.uploadId,
			mediaRoot: ROOT,
		});
		expect(joined.complete).toBe(true);
		expect(joined.extension).toBe('jpg');
	});

	test.if(HAVE_MAGICK)(
		'POLYGLOT: chunks that assemble to a NON-jpg fail closed at join (SEC-066)',
		async () => {
			// Each chunk is innocuous; assembled they are a PDF, not the declared jpg →
			// the join's re-sniff must reject.
			const pdfBytes = new TextEncoder().encode('%PDF-1.4\n...body...');
			const base = { keyDir: 'kdp', fileName: 'sneaky.jpg', chunked: true, totalChunks: 2 };
			receiveUpload(parsed({ ...base, chunkIndex: 0 }, pdfBytes.slice(0, 5)), USER, ROOT);
			receiveUpload(parsed({ ...base, chunkIndex: 1 }, pdfBytes.slice(5)), USER, ROOT);
			expect(
				joinChunkedUpload({
					keyDir: 'kdp',
					tmpName: 'sneaky.jpg',
					totalChunks: 2,
					userId: USER,
					mediaRoot: ROOT,
				}),
			).rejects.toThrow();
		},
	);

	test('join with a missing chunk fails closed', () => {
		expect(
			joinChunkedUpload({
				keyDir: 'kd_missing',
				tmpName: 'x.jpg',
				totalChunks: 3,
				userId: USER,
				mediaRoot: ROOT,
			}),
		).rejects.toThrow();
	});

	test('join with EXTRA delivered chunks consumes exactly the declared total', async () => {
		// Pinned contract (surplus side of the count mismatch): the join assembles
		// exactly parts 0..declaredTotal-1 — a surplus part is NEVER concatenated
		// into the staged file.
		//
		// AMENDED 2026-08-03 (WC-2026-08-03-chunked-upload-identity): the surplus
		// part used to be LEFT BEHIND in the staging dir, where nothing ever
		// collected it. It is now dropped with the rest of the transfer's artifact
		// dir once the join succeeds — the client declared the part count, so
		// anything past it is garbage by definition, and 'leaks forever' was never
		// a contract worth keeping.
		//
		// The body carries a real EOI (FFD9) because the join now verifies the
		// whole assembled file, not only its first 8192 bytes; only the byte
		// accounting is under test here.
		const body = Array.from({ length: 195 }, (_, i) => i % 251);
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, ...body, 0xff, 0xd9]);
		const base = { keyDir: 'kde', fileName: 'extra.jpg', chunked: true, totalChunks: 3 };
		const first = receiveUpload(
			parsed({ ...base, chunkIndex: 0 }, bytes.slice(0, 100)),
			USER,
			ROOT,
		);
		receiveUpload(parsed({ ...base, chunkIndex: 1 }, bytes.slice(100, 200)), USER, ROOT);
		receiveUpload(parsed({ ...base, chunkIndex: 2 }, bytes.slice(200)), USER, ROOT);
		// The client declares 2 chunks at join time, but 3 parts were delivered.
		const joined = await joinChunkedUpload({
			keyDir: 'kde',
			tmpName: 'extra.jpg',
			totalChunks: 2,
			userId: USER,
			uploadId: first.uploadId,
			mediaRoot: ROOT,
		});
		expect(joined.complete).toBe(true);
		const dir = stagingDir(USER, 'kde', ROOT);
		// The staged file holds parts 0+1 only — the surplus part contributed nothing.
		expect(readFileSync(join(dir, 'extra.jpg'))).toEqual(Buffer.from(bytes.slice(0, 200)));
		// And nothing of the transfer is left behind (defect 3: orphan parts).
		expect(readdirSync(dir).filter((e) => e.startsWith('.up_'))).toEqual([]);
	});
});

describe('full ingest: upload → add_file → regenerate', () => {
	test.if(HAVE_MAGICK)('staged upload ingests into derivatives', async () => {
		const bytes = await jpegBytes('2400x1600');
		const staged = receiveUpload(parsed({ keyDir: 'kdi', fileName: 'in.jpg' }, bytes), USER, ROOT);
		expect(staged.complete).toBe(true);
		const identity: MediaIdentity = {
			componentTipo: 'test99',
			sectionTipo: 'test3',
			sectionId: 77,
			lang: null,
		};
		const result = await processUploadedFile({
			spec: image,
			identity,
			pathOpts,
			userId: USER,
			keyDir: 'kdi',
			tmpName: staged.tmpName!,
			extension: staged.extension!,
		});
		const qualities = new Set(result.filesInfo.map((e) => e.quality));
		expect(qualities.has('original')).toBe(true);
		expect(qualities.has('1.5MB')).toBe(true);
		expect(qualities.has('thumb')).toBe(true);
		// original tier holds the raw upload
		expect(existsSync(`${ROOT}/image/original/test99_test3_77.jpg`)).toBe(true);
	});

	test.if(HAVE_MAGICK)('parseUploadRequest reads a real multipart Request', async () => {
		const bytes = await jpegBytes();
		const form = new FormData();
		form.set('key_dir', 'kdr');
		form.set('file_name', 'req.jpg');
		form.set('chunked', 'false');
		form.set('file_to_upload', new Blob([bytes as BlobPart], { type: 'image/jpeg' }), 'req.jpg');
		const request = new Request('http://x/upload', { method: 'POST', body: form });
		const p = await parseUploadRequest(request);
		expect(p.keyDir).toBe('kdr');
		expect(p.fileName).toBe('req.jpg');
		expect(p.blob.length).toBe(bytes.length);
	});
});

/**
 * WC-078 — the staged-upload READ surface. `list_uploaded_files` was a hardcoded
 * `[]` and `delete_uploaded_file` did not exist, which is what made a queued
 * import vanish on reload and leak its bytes forever. These pin the listing's
 * exclusions and the confinement chokepoint that lets a user reach ONLY their
 * own staging dir.
 */
describe('staged files — listing, deletion, confinement (WC-078)', () => {
	const KEY = 'staged_kd';

	test.if(HAVE_MAGICK)('lists completed files and hides in-flight artifacts', async () => {
		const bytes = await jpegBytes();
		receiveUpload(parsed({ keyDir: KEY, fileName: 'listed.jpg' }, bytes), USER, ROOT);
		// An in-flight chunk and a half-assembled join must NOT be listed: showing
		// them would offer the user a "restorable" row for a partial upload.
		const { writeFileSync } = await import('node:fs');
		writeFileSync(join(stagingDir(USER, KEY, ROOT), '0-pending.jpg.blob'), 'x');
		writeFileSync(join(stagingDir(USER, KEY, ROOT), 'pending.jpg.assembling'), 'x');

		const { listStagedFiles } = await import('../../src/core/media/ingest/staged_files.ts');
		const listed = listStagedFiles(USER, KEY, ROOT);
		expect(listed.map((f) => f.name)).toEqual(['listed.jpg']);
		expect(listed[0]?.url).toBe('/dedalo/upload_tmp/staged_kd/listed.jpg');
		expect(listed[0]?.size).toBeGreaterThan(0);
	});

	test('a staging dir that does not exist lists as empty, not as an error', async () => {
		const { listStagedFiles } = await import('../../src/core/media/ingest/staged_files.ts');
		expect(listStagedFiles(USER, 'never_created', ROOT)).toEqual([]);
	});

	test.if(HAVE_MAGICK)('deleting removes the file; a second delete is a no-op', async () => {
		const bytes = await jpegBytes();
		receiveUpload(parsed({ keyDir: KEY, fileName: 'doomed.jpg' }, bytes), USER, ROOT);
		const target = join(stagingDir(USER, KEY, ROOT), 'doomed.jpg');
		expect(existsSync(target)).toBe(true);

		const { deleteStagedFile } = await import('../../src/core/media/ingest/staged_files.ts');
		expect(deleteStagedFile(USER, KEY, 'doomed.jpg', ROOT)).toBe(true);
		expect(existsSync(target)).toBe(false);
		// Idempotent: the client may fire removedfile twice, and an already-gone
		// file must not surface an error the user cannot act on.
		expect(deleteStagedFile(USER, KEY, 'doomed.jpg', ROOT)).toBe(false);
	});

	test('resolveStagedPath confines to the caller’s own staging dir', async () => {
		const { resolveStagedPath } = await import('../../src/core/media/ingest/staged_files.ts');
		// Valid shapes resolve inside this user's key_dir.
		const ok = resolveStagedPath(USER, `${KEY}/listed.jpg`, ROOT);
		expect(ok).not.toBeNull();
		expect(ok?.startsWith(stagingDir(USER, KEY, ROOT))).toBe(true);
		expect(resolveStagedPath(USER, `${KEY}/thumbnail/listed.jpg.jpg`, ROOT)).not.toBeNull();

		// Everything else fails CLOSED — traversal, another user's tree, a bare
		// key_dir with no file, an over-deep path, and partial artifacts.
		for (const bad of [
			'../../../../etc/passwd',
			`${KEY}/../../4/${KEY}/listed.jpg`,
			`${KEY}/..`,
			KEY,
			`${KEY}/deeper/than/allowed.jpg`,
			`${KEY}/notthumbnail/listed.jpg`,
			`${KEY}/0-pending.jpg.blob`,
			`${KEY}/pending.jpg.assembling`,
		]) {
			expect(resolveStagedPath(USER, bad, ROOT)).toBeNull();
		}

		// A DIFFERENT user asking for the same relative path lands in their own
		// (non-existent) tree, never in USER's.
		const other = resolveStagedPath(USER + 1, `${KEY}/listed.jpg`, ROOT);
		expect(other).not.toBeNull();
		expect(other?.startsWith(stagingDir(USER, KEY, ROOT))).toBe(false);
	});
});

/**
 * INGEST→PERSIST PAIRING GATE.
 *
 * `processUploadedFile` only touches the DISK: add_file, derivatives, and a
 * files_info SCAN which it RETURNS. Writing that scan onto the record is a
 * separate call (`persistUploadedMedia`). Nothing enforced the pairing, and two
 * tools shipped without it INDEPENDENTLY — tool_import_files and
 * tool_posterframe both wrote media to disk and left the record's `media` key
 * NULL, which surfaces as tool_media_versions' "Files info data is unsync"
 * (`files_info_db: []` against a full `files_info_disk`). An image has no
 * read-time rescan to repair itself, so the loss is permanent.
 *
 * This is a source scan rather than a behavioural test on purpose: the failure
 * is a MISSING call, and the cheapest honest way to catch a missing call is to
 * look for it. A behavioural test would have to exist once per ingest path;
 * this covers every path that exists now and every one added later.
 */
describe('media ingest — every disk-writing path records files_info', () => {
	const INGEST = 'processUploadedFile';
	const PERSIST = 'persistUploadedMedia';

	/** Files that IMPORT the shared ingest engine (not same-named local helpers). */
	const ingestCallers = (): string[] => {
		const {
			readFileSync: read,
			readdirSync,
			statSync: stat,
		} = require('node:fs') as typeof import('node:fs');
		const { join: j } = require('node:path') as typeof import('node:path');
		const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
		const out: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				if (entry === 'node_modules' || entry.startsWith('.')) continue;
				const full = j(dir, entry);
				if (stat(full).isDirectory()) walk(full);
				else if (full.endsWith('.ts')) {
					const text = read(full, 'utf8');
					// Only files that pull the ENGINE in — tool_import_dedalo_csv has a
					// local action of the same name that is unrelated.
					if (text.includes('ingest/process_uploaded_file.ts') && text.includes(`${INGEST}(`)) {
						out.push(full.slice(root.length + 1));
					}
				}
			}
		};
		for (const base of ['src', 'tools']) walk(j(root, base));
		return out.sort();
	};

	test('every caller of the ingest engine also persists files_info', () => {
		const { readFileSync: read } = require('node:fs') as typeof import('node:fs');
		const root = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
		const callers = ingestCallers();
		// The scan must find the known callers, or it is passing vacuously.
		expect(callers.length, 'the scan found no ingest callers — it is broken').toBeGreaterThan(1);

		const missing = callers.filter((file) => !read(`${root}/${file}`, 'utf8').includes(PERSIST));
		expect(
			missing,
			`these write media to disk but never record files_info on the record — the "unsync" bug: ${missing.join(', ')}`,
		).toEqual([]);
	});
});

/**
 * DEFECT 3 (2026-08-03) — ORPHANED CHUNK PARTS. Parts were unlinked only inside
 * a SUCCESSFUL join, so a cancelled or failed transfer parked everything it had
 * already delivered in the staging dir forever: a failed 4 GB upload leaked
 * ~4 GB, repeatably, with no sweeper anywhere in media/ingest/.
 *
 * The retention rule under test (src/core/media/ingest/staging_gc.ts): an
 * upload is collectable when NOTHING has touched it for STAGING_ORPHAN_TTL_MS,
 * measured as the NEWEST mtime in its artifact dir — never per part, because
 * part 0 of a live multi-hour transfer is legitimately old.
 */
describe('staging GC — abandoned transfers are collected, live ones are not', () => {
	const KEY = 'kd_gc';

	test('an abandoned transfer is removed; a fresh one and completed files are not', async () => {
		const { sweepStagedOrphans, STAGING_ORPHAN_TTL_MS } = await import(
			'../../src/core/media/ingest/staging_gc.ts'
		);
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x41, 0x42, 0xff, 0xd9]);
		// One transfer that will be abandoned after its first part…
		const abandoned = receiveUpload(
			parsed({ keyDir: KEY, fileName: 'gone.jpg', chunked: true, totalChunks: 4 }, bytes),
			USER,
			ROOT,
		);
		// …one that is still arriving…
		const live = receiveUpload(
			parsed({ keyDir: KEY, fileName: 'live.jpg', chunked: true, totalChunks: 4 }, bytes),
			USER,
			ROOT,
		);
		// …and one COMPLETED staged file, which the sweeper must never touch.
		const done = receiveUpload(parsed({ keyDir: KEY, fileName: 'kept.jpg' }, bytes), USER, ROOT);
		const dir = stagingDir(USER, KEY, ROOT);
		const upDir = (id: string | undefined): string => join(dir, `.up_${id}`);
		expect(existsSync(upDir(abandoned.uploadId))).toBe(true);

		// Nothing is old enough yet: a sweep NOW must remove nothing at all.
		expect(sweepStagedOrphans(USER, KEY, ROOT)).toBe(0);

		// Wind the clock past the retention window. Both in-flight transfers are
		// then abandoned by the rule — which is the honest answer: a transfer
		// untouched for 24 h cannot be live (the client fails a stalled part in
		// under a minute).
		const later = Date.now() + STAGING_ORPHAN_TTL_MS + 1000;
		expect(sweepStagedOrphans(USER, KEY, ROOT, later)).toBe(2);
		expect(existsSync(upDir(abandoned.uploadId))).toBe(false);
		expect(existsSync(upDir(live.uploadId))).toBe(false);
		// The completed file survives every sweep — it is the user's data.
		expect(existsSync(join(dir, done.tmpName as string))).toBe(true);
	});

	test('legacy flat artifacts (<i>-<name>.blob / <name>.assembling) are collected too', async () => {
		const { sweepStagedOrphans, STAGING_ORPHAN_TTL_MS } = await import(
			'../../src/core/media/ingest/staging_gc.ts'
		);
		const { writeFileSync, mkdirSync } = await import('node:fs');
		const dir = stagingDir(USER, 'kd_gc_legacy', ROOT);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '0-old.jpg.blob'), 'x');
		writeFileSync(join(dir, 'old.jpg.assembling'), 'x');
		writeFileSync(join(dir, 'real.jpg'), 'x');
		const later = Date.now() + STAGING_ORPHAN_TTL_MS + 1000;
		expect(sweepStagedOrphans(USER, 'kd_gc_legacy', ROOT, later)).toBe(2);
		expect(existsSync(join(dir, 'real.jpg'))).toBe(true);
	});

	test('an explicit cancel drops one transfer immediately, and only that one', async () => {
		const { cancelStagedUpload } = await import('../../src/core/media/ingest/staging_gc.ts');
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x41, 0xff, 0xd9]);
		const KEY_C = 'kd_cancel';
		const a = receiveUpload(
			parsed({ keyDir: KEY_C, fileName: 'a.jpg', chunked: true, totalChunks: 2 }, bytes),
			USER,
			ROOT,
		);
		const b = receiveUpload(
			parsed({ keyDir: KEY_C, fileName: 'b.jpg', chunked: true, totalChunks: 2 }, bytes),
			USER,
			ROOT,
		);
		const dir = stagingDir(USER, KEY_C, ROOT);
		expect(cancelStagedUpload(USER, KEY_C, a.uploadId as string, ROOT)).toBe(true);
		expect(existsSync(join(dir, `.up_${a.uploadId}`))).toBe(false);
		expect(existsSync(join(dir, `.up_${b.uploadId}`))).toBe(true);
		// Idempotent: cancelling twice is a no-op, not an error.
		expect(cancelStagedUpload(USER, KEY_C, a.uploadId as string, ROOT)).toBe(false);
	});
});

/**
 * The BATCH-IMPORTER consequence of a server-assigned staged name: the importers
 * can no longer re-derive it from the display name, so they must forward
 * `tmp_name` — and the fallback for an entry without one must refuse to guess
 * rather than import the wrong file.
 */
describe('resolveStagedName — forwarded tmp_name wins, the fallback refuses to guess', () => {
	const KEY = 'kd_resolve';

	test('forwarded tmp_name is authoritative; the legacy transform is the fallback', async () => {
		const { resolveStagedName } = await import('../../src/core/media/ingest/staged_files.ts');
		const { writeFileSync, mkdirSync } = await import('node:fs');
		const dir = stagingDir(USER, KEY, ROOT);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'records__1_.mrc'), 'x');
		// No forwarded name → the legacy derivation, which is what is on disk.
		expect(resolveStagedName(dir, 'records (1).mrc')).toBe('records__1_.mrc');
		// Forwarded → taken verbatim (after segment validation), even when the
		// legacy derivation would have said something else.
		expect(resolveStagedName(dir, 'records (1).mrc', 'records__1_-1.mrc')).toBe(
			'records__1_-1.mrc',
		);
		// A forwarded value is still client input: an unsafe segment is refused.
		expect(() => resolveStagedName(dir, 'x.mrc', '../../etc/passwd')).toThrow();
	});

	test('a collision-suffixed staging dir with no forwarded tmp_name REFUSES rather than guess', async () => {
		const { resolveStagedName } = await import('../../src/core/media/ingest/staged_files.ts');
		const { writeFileSync, mkdirSync } = await import('node:fs');
		const dir = stagingDir(USER, 'kd_resolve_amb', ROOT);
		mkdirSync(dir, { recursive: true });
		// Only the SUFFIXED forms exist (the un-suffixed one was deleted): which
		// of them the entry meant is unknowable, so this must not pick one.
		writeFileSync(join(dir, 'notes-1.mrc'), 'x');
		writeFileSync(join(dir, 'notes-2.mrc'), 'x');
		expect(() => resolveStagedName(dir, 'notes.mrc')).toThrow(/ambiguous/);
		// With the forwarded name there is nothing to guess.
		expect(resolveStagedName(dir, 'notes.mrc', 'notes-2.mrc')).toBe('notes-2.mrc');
	});

	test('the LEGACY name existing does not suppress the refusal (the stale-file bug)', async () => {
		// THE BUG (2026-08-03): the collision scan ran only after `existsSync(legacy)`
		// said no, so the "refuse to guess" contract fired exactly when it did not
		// matter. With BOTH names present — the shape a curator produces by
		// re-uploading a corrected scan, since a re-upload no longer overwrites —
		// this returned the SUPERSEDED file: wrong bytes under the right catalogue
		// record, silently.
		const { resolveStagedName } = await import('../../src/core/media/ingest/staged_files.ts');
		const { writeFileSync, mkdirSync } = await import('node:fs');
		const dir = stagingDir(USER, 'kd_resolve_stale', ROOT);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'DSC001.jpg'), 'the superseded scan');
		writeFileSync(join(dir, 'DSC001-1.jpg'), 'the corrected scan');
		expect(() => resolveStagedName(dir, 'DSC001.jpg')).toThrow(/ambiguous/);
		// The same shape the reviewer reproduced with .mrc entries.
		writeFileSync(join(dir, 'records.mrc'), 'old');
		writeFileSync(join(dir, 'records-1.mrc'), 'new');
		expect(() => resolveStagedName(dir, 'records.mrc')).toThrow(/ambiguous/);
		// Forwarding the server's tmp_name is, as ever, the answer.
		expect(resolveStagedName(dir, 'records.mrc', 'records-1.mrc')).toBe('records-1.mrc');
		// And with no suffixed candidate at all the legacy derivation still stands.
		writeFileSync(join(dir, 'lonely.mrc'), 'x');
		expect(resolveStagedName(dir, 'lonely.mrc')).toBe('lonely.mrc');
	});
});

/**
 * A REFUSED TRANSFER IS QUARANTINED, NEVER DELETED (2026-08-03).
 *
 * The join used to `rmSync(upDir, {recursive:true})` when verification threw —
 * a heuristic verdict DESTROYING a completed transfer, with no recovery. For a
 * heritage ingest path the ranking is: silently accepting corrupt bytes <
 * refusing loudly and KEEPING the data <<< destroying a curator's upload, and
 * this pass proved the verifier itself capable of false positives.
 */
describe('join rejection quarantines the transfer instead of deleting it', () => {
	const KEY = 'kd_quarantine';

	test('rejected bytes stay on disk, marked, and are released by the ordinary cancel', async () => {
		const { listQuarantinedUploads, REJECTION_MARKER } = await import(
			'../../src/core/media/ingest/upload.ts'
		);
		const { cancelStagedUpload } = await import('../../src/core/media/ingest/staging_gc.ts');
		// Chunks that assemble to a PDF while declared .jpg: refused by the head
		// sniff, i.e. the cheapest possible rejection — and previously fatal.
		const pdf = new TextEncoder().encode('%PDF-1.4\n a curator’s forty-hour master \n');
		const base = { keyDir: KEY, fileName: 'master.jpg', chunked: true, totalChunks: 2 };
		const first = receiveUpload(parsed({ ...base, chunkIndex: 0 }, pdf.slice(0, 9)), USER, ROOT);
		receiveUpload(parsed({ ...base, chunkIndex: 1 }, pdf.slice(9)), USER, ROOT);

		await expect(
			joinChunkedUpload({
				keyDir: KEY,
				tmpName: 'master.jpg',
				totalChunks: 2,
				userId: USER,
				uploadId: first.uploadId,
				mediaRoot: ROOT,
			}),
			// The error must SAY the bytes survived — a curator acts on this message.
		).rejects.toThrow(/NOT deleted/);

		const dir = stagingDir(USER, KEY, ROOT);
		const upDir = join(dir, `.up_${first.uploadId}`);
		// The artifact dir is still there, with the marker and the complete bytes.
		expect(existsSync(upDir)).toBe(true);
		expect(existsSync(join(upDir, REJECTION_MARKER))).toBe(true);
		expect(readFileSync(join(upDir, 'rejected.master.jpg'))).toEqual(Buffer.from(pdf));
		// Nothing was staged as an importable file, though: a refused upload must not
		// become a row anything can ingest.
		const { listStagedFiles } = await import('../../src/core/media/ingest/staged_files.ts');
		expect(listStagedFiles(USER, KEY, ROOT)).toEqual([]);

		// The read side: a quarantined transfer is discoverable with its reason.
		const quarantined = listQuarantinedUploads(USER, KEY, ROOT);
		expect(quarantined.length).toBe(1);
		expect(quarantined[0]?.uploadId).toBe(first.uploadId as string);
		expect(quarantined[0]?.file).not.toBeNull();
		expect(String(quarantined[0]?.record?.reason)).toContain('does not match declared extension');

		// Re-joining says what happened rather than "missing chunk 0".
		await expect(
			joinChunkedUpload({
				keyDir: KEY,
				tmpName: 'master.jpg',
				totalChunks: 2,
				userId: USER,
				uploadId: first.uploadId,
				mediaRoot: ROOT,
			}),
		).rejects.toThrow(/already rejected/);

		// Release is the mechanism that already existed — no new leak, no new surface.
		expect(cancelStagedUpload(USER, KEY, first.uploadId as string, ROOT)).toBe(true);
		expect(existsSync(upDir)).toBe(false);
		expect(listQuarantinedUploads(USER, KEY, ROOT)).toEqual([]);
	});
});

/**
 * AN INTERRUPTED JOIN MUST BE RETRYABLE (2026-08-03).
 *
 * The output was opened `wx` and each part was unlinked AS IT WAS CONSUMED, so a
 * join killed halfway had already destroyed the front of the transfer AND left
 * an `assembled` file that made every later attempt throw "already being
 * assembled" — until the 24 h sweep. The client's transport retries the join
 * after 10 s, so this was reachable in ordinary operation, not only on a crash.
 */
describe('interrupted join — parts survive, and a stale assembly is recovered', () => {
	const KEY = 'kd_stale';

	test('a leftover assembled file blocks a CONCURRENT join but not a later one', async () => {
		const { ASSEMBLY_STALE_MS } = await import('../../src/core/media/ingest/upload.ts');
		const { writeFileSync, utimesSync } = await import('node:fs');
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x41, 0x42, 0x43, 0xff, 0xd9]);
		const base = { keyDir: KEY, fileName: 'retry.jpg', chunked: true, totalChunks: 2 };
		const first = receiveUpload(parsed({ ...base, chunkIndex: 0 }, bytes.slice(0, 4)), USER, ROOT);
		receiveUpload(parsed({ ...base, chunkIndex: 1 }, bytes.slice(4)), USER, ROOT);
		const upDir = join(stagingDir(USER, KEY, ROOT), `.up_${first.uploadId}`);
		const call = (): Promise<unknown> =>
			joinChunkedUpload({
				keyDir: KEY,
				tmpName: 'retry.jpg',
				totalChunks: 2,
				userId: USER,
				uploadId: first.uploadId,
				mediaRoot: ROOT,
			});

		// A FRESH output means a join really is in flight: refuse, loudly.
		writeFileSync(join(upDir, 'assembled'), 'partial');
		await expect(call()).rejects.toThrow(/already being assembled/);
		// A CONFLICT (409, retryable) — the competing join finishes and the retry works.
		expect((await refusalOf(call())).code).toBe('media.upload_conflict');
		// Both parts are still there — the interrupted attempt destroyed nothing.
		expect(existsSync(join(upDir, '0.part'))).toBe(true);
		expect(existsSync(join(upDir, '1.part'))).toBe(true);

		// Age the output past the staleness window: nobody is writing to it, so the
		// transfer is recoverable from the parts that were deliberately kept.
		const stale = (Date.now() - ASSEMBLY_STALE_MS - 60_000) / 1000;
		utimesSync(join(upDir, 'assembled'), stale, stale);
		const joined = (await call()) as { complete: boolean; tmpName?: string };
		expect(joined.complete).toBe(true);
		// And the recovered file is the WHOLE transfer, not the partial wreckage.
		expect(readFileSync(join(stagingDir(USER, KEY, ROOT), joined.tmpName as string))).toEqual(
			Buffer.from(bytes),
		);
	});
});
