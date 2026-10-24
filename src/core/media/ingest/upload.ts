/**
 * UPLOAD RECEIVER — multipart/chunked upload staging (PHP dd_utils_api::upload
 * :925 + join_chunked_files_uploaded :1379).
 *
 * Parses the vendored client's multipart form (Content-Range / X-File-Name /
 * fields key_dir,file_name,chunked,start,end,chunk_index,total_chunks,upload_id,
 * file_to_upload), sniffs the MAGIC BYTES (never the client Content-Type),
 * cross-validates the extension, stages under the per-user upload tmp dir, and
 * on the final chunk joins + RE-VERIFIES the assembled file (SEC-066 +
 * verify_content.ts). Returns the staged tmp name once the upload is complete;
 * the caller then runs processUploadedFile to add_file + regenerate.
 *
 * Bun's native request.formData() parses the body — no third-party library.
 * Chunks are client-capped (~MB) so buffering one in memory is acceptable;
 * streaming multipart is ledgered as a later optimization.
 *
 * ── STAGED IDENTITY (WC-2026-08-03-chunked-upload-identity) ──────────────────
 * One logical upload has ONE identity, decided ONCE, and the FINAL staged name
 * is allocated ONCE at completion:
 *
 *   • every part of a transfer is written under `.up_<uploadId>/` inside the
 *     user's key_dir, so two transfers can never interleave their parts;
 *   • `uploadId` is the client's `upload_id` field when present (validated, NOT
 *     sanitized — a malformed one is refused), else a value DERIVED from the raw
 *     client file name + chunk count, which is stable across the chunks of one
 *     transfer without any client coordination;
 *   • the final name is claimed at completion with an atomic `link` and a
 *     `-1`, `-2`, … ladder, so two files whose names sanitize to the same thing
 *     (`María.jpg` and `Mar#a.jpg` → `Mar_a.jpg`) get two distinct staged files
 *     instead of one overwriting the other.
 *
 * Why not allocate per chunk: chunks arrive concurrently with no defined first
 * arrival, so an allocator that ran per chunk would scatter one transfer's parts
 * across several identities. Uniqueness has to be decided once, up front (the
 * id) or once, at the end (the name) — never in between.
 *
 * ── A REFUSED TRANSFER IS QUARANTINED, NEVER DELETED ─────────────────────────
 * Nothing on this path may destroy a completed transfer. A failed content
 * verification parks the assembled bytes in the transfer's own artifact dir with
 * a `rejected.json` marker (quarantineAssembled / listQuarantinedUploads); an
 * interrupted assembly keeps every part until the join reaches a durable outcome
 * (ASSEMBLY_STALE_MS recovery). Both release through the mechanisms that already
 * existed — the 24 h age sweep and the explicit cancel — so nothing new leaks,
 * and a curator's forty-hour upload is never destroyed by a heuristic verdict.
 */

import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from '../../../config/config.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { sniffAndValidate } from '../engine/mime.ts';
import { verifyFileContent } from '../engine/verify_content.ts';
import { sanitizeSegment, stagingDir } from './add_file.ts';
import { recordStagedDisplayName } from './staged_name_record.ts';
import { sweepStagedOrphans, UPLOAD_DIR_PREFIX, uploadArtifactDir } from './staging_gc.ts';

/** The parsed upload request fields. */
export interface ParsedUpload {
	keyDir: string;
	fileName: string;
	chunked: boolean;
	chunkIndex: number;
	totalChunks: number;
	blob: Uint8Array;
	/**
	 * Client-supplied per-transfer identity (`upload_id` form field). UNTRUSTED:
	 * validated against UPLOAD_ID_PATTERN and refused when it does not match —
	 * never sanitized into something else, because silently rewriting an identity
	 * is exactly how two transfers end up sharing one. null = not sent (the
	 * receiver then derives one; see resolveUploadId).
	 */
	uploadId: string | null;
	/**
	 * SEC-008 form-field CSRF twin. Both upload clients send the token in the
	 * `X-Dedalo-Csrf-Token` header AND as a `csrf_token` field; the field is the
	 * documented fallback for when an intermediary strips the custom header.
	 * The caller (handleMediaUpload) decides — parsing never authorises.
	 */
	csrfToken: string | null;
}

/** The result of receiving one chunk / a single-shot upload. */
export interface UploadReceiveResult {
	/** True when the whole file is staged and ready for add_file. */
	complete: boolean;
	/**
	 * The staged temp file name. On a COMPLETED upload this is the final,
	 * collision-free name on disk; on an in-flight chunk it is the PROPOSAL the
	 * final name is derived from (the client only counts these).
	 */
	tmpName?: string;
	/**
	 * The HUMAN file name of this transfer ('María Piñón.jpg') — PHP's
	 * `file_data->name`, which the TS receiver dropped entirely.
	 *
	 * A DIFFERENT VALUE FROM `tmpName`, and deliberately so: `tmpName` is a
	 * filesystem segment and is sanitized to be safe as one, which is lossy and
	 * not injective. Persisting it as the record's `original_file_name` is how
	 * 'María Piñón.jpg' entered the archive as 'Mar_a_Pi_n.jpg'. Protecting the
	 * filesystem and recording provenance are two concerns and must not share one
	 * string.
	 */
	name?: string;
	/** The validated/declared extension. */
	extension?: string;
	/** Echoed back so the client can count chunk completion (chunked flow). */
	chunkIndex?: number;
	totalChunks?: number;
	/**
	 * The transfer identity. Echoed in `file_data` so it round-trips back on the
	 * join RQO (the client forwards the last chunk's `file_data` verbatim).
	 */
	uploadId?: string;
}

/**
 * The accepted shape of a client-supplied `upload_id`. Deliberately narrow: it
 * becomes a path segment, so it is an allowlist of URL-safe base64 characters
 * with a hard length bound (a `crypto.randomUUID()` is 36 chars and fits). A
 * traversal payload, a NUL, or a 4 KB id fails it and the upload is REFUSED.
 */
export const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Ceiling on the chunk count/index a client may declare — a SANITY BOUND on an
 * integer field, and deliberately NOT the size policy.
 *
 * The size policy is `config.media.upload.maxSizeBytes` counted over the
 * ASSEMBLED BYTES (see assembledCap / the join's pre-check and running total).
 * Reading this constant as the ceiling on how much a chunked transfer may
 * deliver is exactly the mistake MEDIA-03 records: 100 000 parts each under the
 * per-request cap summed to an arbitrarily large file that nothing refused.
 */
const MAX_CHUNKS = 100_000;

/**
 * The ceiling on ONE TRANSFER'S ASSEMBLED SIZE.
 *
 * `override` exists for gates that must exercise the refusal without writing
 * gigabytes. It is a FUNCTION ARGUMENT and never a wire field: no API action may
 * pass a client-supplied value here, or the ceiling becomes caller-chosen.
 */
function assembledCap(override?: number): number {
	return typeof override === 'number' && Number.isFinite(override) && override > 0
		? override
		: config.media.upload.maxSizeBytes;
}

/** The ONE cumulative-size refusal, so its code and sentence cannot drift. */
function tooLarge(where: string, total: number, max: number, remedy: string): DedaloError {
	const sentence = `${where}: the upload exceeds the maximum allowed size — ${remedy}`;
	return new DedaloError('media.too_large', {
		message: sentence,
		publicMessage: sentence,
		coordinates: { size: total, max },
	});
}

/**
 * The two refusals the join raises from more than one place, each as ONE typed
 * throw so the code and the sentence cannot drift between their call sites.
 *
 * NOTE ON THE WIRE: the upload endpoint (upload_endpoint.ts `rejectedUpload`)
 * deliberately re-wraps everything this module throws as `media.upload_rejected`
 * — that shape is pinned by test/unit/media_upload_endpoint.test.ts and is not
 * changed here. The codes below are what the MCP media tool and the logs see.
 */
function noStagedParts(): DedaloError {
	return new DedaloError('media.file_not_found', {
		message: 'join: no staged parts for this upload',
		publicMessage: 'join: no staged parts for this upload',
	});
}

function alreadyAssembling(): DedaloError {
	return new DedaloError('media.upload_conflict', {
		message: 'join: this upload is already being assembled',
		publicMessage: 'join: this upload is already being assembled',
	});
}

/** Parse the multipart form into the upload fields. Throws on a malformed body. */
export async function parseUploadRequest(request: Request): Promise<ParsedUpload> {
	const form = await request.formData();
	// The blob part. `file_to_upload` is the name both Dédalo upload clients send;
	// `file` is Dropzone's stock default and is accepted as a fallback so a plain
	// Dropzone/blueimp configuration is not silently rejected (PHP read $_FILES
	// positionally and so accepted either).
	const file = form.get('file_to_upload') ?? form.get('file');
	if (!(file instanceof Blob)) {
		throw new DedaloError('media.upload_rejected', {
			message: 'upload: missing file_to_upload',
			publicMessage: 'upload: missing file_to_upload',
		});
	}

	// File name resolution, most explicit source first:
	//   1. X-File-Name header  (service_upload, service_dropzone — URI-encoded)
	//   2. `file_name` field   (the same clients' header-stripped fallback)
	//   3. the multipart part's OWN filename (PHP's $_FILES['name'])
	// (3) matters because the extension is cross-checked against the sniffed
	// magic bytes: with no name at all the extension resolved to '' and every
	// upload died with "File signature (jpeg) does not match declared extension '.'".
	const fileNameHeader = request.headers.get('X-File-Name');
	const fileNameField = form.get('file_name');
	const partName = file instanceof File ? file.name : '';
	const rawFileName =
		typeof fileNameHeader === 'string' && fileNameHeader !== ''
			? fileNameHeader
			: typeof fileNameField === 'string' && fileNameField !== ''
				? fileNameField
				: partName;
	// Only the header is URI-encoded by contract, but the clients have historically
	// encoded the field too; decode defensively and fall back to the raw value when
	// the name contains a literal '%' that is not a valid escape.
	let fileName: string;
	try {
		fileName = decodeURIComponent(rawFileName);
	} catch {
		fileName = rawFileName;
	}
	// Server-side size enforcement (M6): reject a received part larger than the
	// configured cap (the value get_system_info advertises), rather than trusting
	// the client. The transport-layer maxRequestBodySize is the outer bound; this
	// enforces the ADVERTISED limit explicitly with a clean error.
	//
	// THIS BOUNDS ONE REQUEST, NOT ONE TRANSFER (MEDIA-03). A chunked upload is
	// N requests, so the whole-file ceiling the catalog advertises is counted
	// where the bytes accumulate: receiveUpload's running total per chunk and
	// joinChunkedUpload's pre-check + assembly total.
	if (file.size > config.media.upload.maxSizeBytes) {
		throw new DedaloError('media.too_large', {
			message: 'upload: file exceeds the maximum allowed size',
			publicMessage: 'upload: file exceeds the maximum allowed size',
			coordinates: { size: file.size, max: config.media.upload.maxSizeBytes },
		});
	}
	const blob = new Uint8Array(await file.arrayBuffer());
	const chunked = String(form.get('chunked') ?? 'false') === 'true';
	const csrfField = form.get('csrf_token');
	const uploadIdField = form.get('upload_id');
	return {
		keyDir: String(form.get('key_dir') ?? ''),
		fileName,
		chunked,
		chunkIndex: readCount(form.get('chunk_index'), 0, 'chunk_index'),
		totalChunks: readCount(form.get('total_chunks'), 1, 'total_chunks'),
		blob,
		uploadId: typeof uploadIdField === 'string' && uploadIdField !== '' ? uploadIdField : null,
		csrfToken: typeof csrfField === 'string' && csrfField !== '' ? csrfField : null,
	};
}

/**
 * A chunk counter from the form. `Number(…)` alone let a missing/garbage field
 * become NaN, which then became part of a file NAME (`NaN.part`) — a malformed
 * count must be refused, not coerced.
 */
function readCount(raw: FormDataEntryValue | null, fallback: number, label: string): number {
	if (raw === null || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > MAX_CHUNKS) {
		// `label` is one of this module's own field names, never client text.
		throw new DedaloError('media.upload_rejected', {
			message: `upload: invalid ${label}`,
			publicMessage: `upload: invalid ${label}`,
		});
	}
	return value;
}

/** Extension from a file name (lowercased, no dot); '' when none. */
function extensionOf(fileName: string): string {
	const dot = fileName.lastIndexOf('.');
	return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/**
 * The sanitized staged base name PROPOSED for a client file name.
 *
 * NOT AN IDENTITY. This transform is not injective — `María.jpg` and `Mar#a.jpg`
 * both land on `Mar_a.jpg` — which is why the final staged name is ALLOCATED
 * from this proposal (claimStagedName) instead of being it. Callers that need
 * the name on disk must use the server's `tmp_name`, never re-derive it.
 *
 * Still EXPORTED because the batch importers keep a legacy fallback for entries
 * with no forwarded `tmp_name` (see staged_files.ts resolveStagedName, which
 * refuses to guess when collision-suffixed candidates exist).
 */
export function stagedTmpName(fileName: string): string {
	const base = fileName.split('/').pop() ?? fileName;
	const cleaned = base.replace(/[^A-Za-z0-9_.-]/g, '_');
	if (cleaned === '') return 'upload.bin';
	// A leading dot would make the staged file invisible to listStagedFiles (it
	// skips dotfiles) and could collide with the `.up_<id>` artifact dirs.
	return cleaned.startsWith('.') ? `_${cleaned}` : cleaned;
}

/**
 * The DISPLAY name of an upload: the client's own file name, defanged but NOT
 * transliterated. This is what the archive records as provenance, so it keeps
 * every character a curator actually typed — accents, spaces, CJK.
 *
 * What it removes is what makes a string dangerous as a VALUE, not as a path
 * segment: any directory prefix (both separator conventions — a Windows client
 * sends `C:\Users\…\María.jpg`), C0/C1 control characters and NUL (a stored
 * value that can rewrite a log line or truncate a C string), surrounding
 * whitespace, and anything past 255 characters. It never rewrites a character
 * into another one; if nothing survives, the transfer gets the neutral
 * 'upload.bin' rather than an empty provenance field.
 *
 * NOT `stagedTmpName`, which answers the different question "what may this be
 * called on disk" — see UploadReceiveResult.name.
 */
export function displayFileName(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? raw;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
	const cleaned = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
	if (cleaned === '') return 'upload.bin';
	return cleaned.length > 255 ? cleaned.slice(0, 255) : cleaned;
}

/** Validate a client-supplied upload id. Refuses — never rewrites — a bad one. */
function assertUploadId(raw: string): string {
	if (!UPLOAD_ID_PATTERN.test(raw)) {
		throw new DedaloError('media.upload_rejected', {
			message: 'upload: invalid upload_id',
			publicMessage: 'upload: invalid upload_id',
		});
	}
	return raw;
}

/**
 * The identity of this transfer.
 *
 * With `upload_id` (the contract the clients are moving to) it is that value:
 * one transfer, one id, decided by the only party that knows which parts belong
 * together.
 *
 * WITHOUT it — every currently deployed client — it is DERIVED from the RAW
 * client file name plus the declared chunk count. That derivation is stable
 * across the chunks of one transfer (every chunk carries the same name and
 * count) and, unlike the staged-name transform, it distinguishes `María.jpg`
 * from `Mar#a.jpg`, because it hashes the raw name before any sanitizing. The
 * residue it cannot resolve is two transfers of the SAME raw name into the SAME
 * key_dir at the same time (two tabs, the same file): those still share an
 * identity, and the client-supplied `upload_id` is what closes it.
 */
function resolveUploadId(parsed: ParsedUpload): string {
	if (parsed.uploadId !== null) return assertUploadId(parsed.uploadId);
	const digest = new Bun.CryptoHasher('sha256')
		.update(`${parsed.keyDir}\0${parsed.fileName}\0${parsed.totalChunks}`)
		.digest('hex');
	return `d${digest.slice(0, 32)}`;
}

/** Split a staged base name into stem + extension suffix (`.jpg`, or ''). */
function splitStagedName(name: string): { stem: string; suffix: string } {
	const dot = name.lastIndexOf('.');
	return dot > 0
		? { stem: name.slice(0, dot), suffix: name.slice(dot) }
		: { stem: name, suffix: '' };
}

/**
 * errno values a filesystem WITHOUT hardlink support reports for `link(2)`.
 *
 * SMB/CIFS-backed media stores (common where the repository's images live on a
 * NAS), several FUSE mounts and some object-storage gateways answer `EPERM` or
 * `EOPNOTSUPP` for every link attempt. Since `claimStagedName` is the SINGLE
 * allocation chokepoint for every upload, an unhandled errno here means the
 * install cannot receive a file at all.
 *
 * `EXDEV` is deliberately NOT in this list: source and destination are in the
 * same staging dir by construction (`.up_<id>/assembled` → `<staging>/<name>`
 * under one `key_dir`), so a cross-device link is unreachable and pretending to
 * handle it would be an untested branch.
 */
const NO_HARDLINK_ERRNOS: ReadonlySet<string> = new Set([
	'EPERM',
	'EOPNOTSUPP',
	'ENOTSUP',
	'ENOSYS',
]);

/**
 * Move a completed upload to its FINAL staged name, allocating a collision-free
 * one from `proposal`.
 *
 * `linkSync` is the allocator: it fails with EEXIST rather than overwriting, so
 * the claim is atomic against a concurrent upload racing for the same name, and
 * the name never exists as an empty placeholder that `list_uploaded_files` could
 * show as a restorable row. The source is unlinked once the claim holds.
 *
 * FALLBACK (2026-08-03): on a staging area with no hardlink support the claim is
 * made with an EXCLUSIVE CREATE instead — `open(…, 'wx')` reserves the name with
 * the same atomicity, and the assembled file is then `rename`d over our own
 * reservation. The only property lost is that the name exists as a zero-byte
 * placeholder for the microseconds between the two calls; a concurrent
 * `list_uploaded_files` in that window can see a 0-size row, which is strictly
 * better than the install being unable to accept uploads.
 *
 * The old receiver simply wrote over whatever was there — silent data loss for a
 * single-shot upload, and (once chunking is on for every file) silent CORRUPTION
 * for a chunked one, since the parts of two transfers interleaved under one name.
 */
function claimStagedName(dir: string, proposal: string, sourcePath: string): string {
	const { stem, suffix } = splitStagedName(proposal);
	const candidates: string[] = [proposal];
	for (let n = 1; n <= 999; n++) candidates.push(`${stem}-${n}${suffix}`);
	// Last resort when a user really has a thousand same-named staged files: a
	// random discriminator, still inside the safe segment charset.
	for (let n = 0; n < 8; n++) {
		candidates.push(`${stem}-${Math.random().toString(16).slice(2, 10)}${suffix}`);
	}
	// Sticky: once link(2) is known unsupported here, every later candidate takes
	// the reservation path directly instead of paying a failing syscall each time.
	let hardlinks = true;
	for (const candidate of candidates) {
		const target = confine(dir, candidate);
		if (hardlinks) {
			try {
				linkSync(sourcePath, target);
				unlinkSync(sourcePath);
				return candidate;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? '';
				if (code === 'EEXIST') continue;
				if (!NO_HARDLINK_ERRNOS.has(code)) throw error;
				hardlinks = false;
			}
		}
		try {
			closeSync(openSync(target, 'wx', 0o640));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
			throw error;
		}
		renameSync(sourcePath, target);
		return candidate;
	}
	throw new Error('upload: could not allocate a free staged file name');
}

/** Per-upload metadata written beside the parts, so the join needs no client state. */
interface UploadMeta {
	/** The staged base name PROPOSED by the chunk that created the upload dir. */
	proposal: string;
	/** The extension the parts were declared under. */
	extension: string;
	/**
	 * The HUMAN file name the chunks were sent under. Recorded HERE, by the server,
	 * rather than read off the join request: the client relays `file_data` from the
	 * last chunk and a name taken from that request could differ from the one the
	 * parts were actually uploaded as. Same reasoning as `proposal`.
	 */
	name: string;
	/**
	 * The RUNNING TOTAL of bytes staged for this transfer, so the per-chunk
	 * cumulative check is O(1) instead of re-stat'ing 100 000 parts per request.
	 *
	 * null = a transfer whose parts were written by an OLDER server (no total in
	 * its meta). That must not invalidate the meta — it would strand every
	 * in-flight upload across a deploy — so it degrades to "recount from stat
	 * once" (stagedBytes), never to "unknown, allow".
	 */
	received: number | null;
}

function writeUploadMeta(upDir: string, meta: UploadMeta): void {
	// Write-then-rename: two concurrent chunks of the same transfer write the
	// same bytes, and the reader (the join) can never see a half-written file.
	const temporary = resolve(upDir, `meta.${Math.random().toString(16).slice(2, 10)}.tmp`);
	writeFileSync(temporary, JSON.stringify(meta), { mode: 0o640 });
	renameSync(temporary, resolve(upDir, 'meta.json'));
}

function readUploadMeta(upDir: string): UploadMeta | null {
	const path = resolve(upDir, 'meta.json');
	if (!existsSync(path)) return null;
	try {
		return normalizeUploadMeta(JSON.parse(readFileSync(path, 'utf8')) as Partial<UploadMeta>);
	} catch {
		return null;
	}
}

/**
 * The stored meta as this server understands it, or null when the record is not
 * one. Split out of readUploadMeta so each half is one idea: that one reads and
 * fails closed, this one decides what the bytes mean.
 */
function normalizeUploadMeta(parsed: Partial<UploadMeta>): UploadMeta | null {
	if (typeof parsed?.proposal !== 'string' || typeof parsed?.extension !== 'string') return null;
	return {
		proposal: sanitizeSegment(parsed.proposal),
		extension: parsed.extension,
		// A transfer whose parts were written by an OLDER server has no `name` in
		// its meta. That must not invalidate the meta (it would strand every
		// in-flight upload across a deploy), so it degrades to the proposal — the
		// same lossy value the engine used to record everywhere.
		name: typeof parsed.name === 'string' ? displayFileName(parsed.name) : parsed.proposal,
		received:
			typeof parsed.received === 'number' && Number.isFinite(parsed.received)
				? parsed.received
				: null,
	};
}

/**
 * The bytes this transfer has already staged. Trusts the meta's running total
 * when it has one; otherwise recounts the parts on disk ONCE (the degrade path
 * for a transfer that predates the total).
 */
function stagedBytes(upDir: string, meta: UploadMeta | null): number {
	if (meta !== null && meta.received !== null) return meta.received;
	return sumPartBytes(upDir);
}

/** The bytes of every `*.part` currently in `upDir` — the recount degrade path. */
function sumPartBytes(upDir: string): number {
	let entries: string[];
	try {
		entries = readdirSync(upDir);
	} catch {
		return 0;
	}
	let sum = 0;
	for (const entry of entries) {
		if (!entry.endsWith('.part')) continue;
		try {
			sum += statSync(resolve(upDir, entry)).size;
		} catch {
			// A part that vanished under us contributes nothing; the join's own
			// pre-check is the authority, this is the cheap early door.
		}
	}
	return sum;
}

/**
 * Receive one chunk (or a single-shot upload) for a user. Stages under the
 * per-user upload dir. `mediaRoot` overrides the configured root (scratch tests).
 *
 * IMPORTANT (client contract): the vendored client ALWAYS chunks when the
 * DEDALO_UPLOAD_SERVICE_CHUNK_FILES global is > 0 (even a small 1-chunk file),
 * counts responses by `file_data.chunk_index` / `file_data.total_chunks`, and
 * only AFTER all chunks arrive fires a separate `join_chunked_files_uploaded`
 * RQO. So a chunk POST here just STORES the part and echoes its index/total —
 * the join (assemble + SEC-066 re-verify) happens in joinChunkedUpload, not here.
 *
 * SIZE (MEDIA-03): the parse layer bounds ONE REQUEST; this bounds THE TRANSFER,
 * at receipt — which is where disk exhaustion actually happens, since the join
 * only runs after every byte is already on the disk. `maxSizeBytes` overrides
 * the configured ceiling for gates; it is a function argument, never a wire
 * field.
 */
export function receiveUpload(
	parsed: ParsedUpload,
	userId: number,
	mediaRoot?: string,
	maxSizeBytes?: number,
): UploadReceiveResult {
	// Identity BEFORE any filesystem effect: a refused upload_id must leave no
	// trace at all, not even an empty staging dir.
	const uploadId = resolveUploadId(parsed);
	const dir = stagingDir(userId, parsed.keyDir, mediaRoot);
	const upDir = uploadArtifactDir(userId, parsed.keyDir, uploadId, mediaRoot);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o750 });
	const proposal = stagedTmpName(parsed.fileName);
	// TWO NAMES, TWO PURPOSES: `proposal` is the filesystem segment, `name` is the
	// provenance the record will carry (see UploadReceiveResult.name).
	const name = displayFileName(parsed.fileName);
	const extension = extensionOf(parsed.fileName);

	if (!parsed.chunked) {
		// Single-shot: sniff the bytes first (the cheapest rejection), then stage
		// through the SAME completion path a chunked upload takes, so both flows
		// verify identically and both allocate a collision-free name.
		sniffAndValidate(parsed.blob, extension);
		mkdirSync(upDir, { recursive: true, mode: 0o700 });
		// PER-REQUEST scratch name, not a fixed 'whole': without a client-supplied
		// upload_id two concurrent single-shot POSTs of the SAME file name DERIVE the
		// same id, so they share this directory — and a fixed name would have let one
		// request's bytes be claimed under the other's staged name. A single-shot has
		// no cross-request rendezvous to preserve, so its payload is simply unique.
		const whole = resolve(upDir, `w${Math.random().toString(16).slice(2, 12)}`);
		try {
			writeFileSync(whole, parsed.blob);
			verifyFileContent(whole, extension);
			const tmpName = claimStagedName(dir, proposal, whole);
			// DOOR 1 (single-shot). Persist the display name BESIDE the staged file:
			// the ingest runs in a LATER request and is handed only `tmp_name`, so a
			// name that lives only in this response is a name the archive never sees
			// (staged_name_record.ts). Keyed on the FINAL claimed name, not the
			// proposal — a collision-suffixed twin is a different file.
			recordStagedDisplayName(dir, tmpName, name);
			return {
				complete: true,
				tmpName,
				name,
				extension,
				chunkIndex: 0,
				totalChunks: 1,
				uploadId,
			};
		} finally {
			// Drop OUR scratch file (a rejection leaves nothing staged), then the
			// directory itself only if it is empty.
			//
			// WHY NOT QUARANTINE HERE, unlike the chunked join: a single-shot upload
			// is ONE request, and the browser still holds the file it just posted, so
			// a 400 is fully recoverable by repeating it. The chunked case is not —
			// there the server holds the only assembled copy of a transfer that may
			// have taken hours — which is exactly why quarantine lives there and not
			// here. Retaining every rejected single-shot body would instead turn a
			// stream of refused uploads into a disk-exhaustion vector.
			//
			// The rmdir below is conditional: a concurrent single-shot sharing
			// the derived id may still be writing into it, and a recursive remove here
			// would delete its payload mid-flight.
			rmSync(whole, { force: true });
			try {
				rmdirSync(upDir);
			} catch {
				// ENOTEMPTY: another request is still using it; the age sweep is the
				// backstop if that request dies (staging_gc.ts).
			}
		}
	}

	return stageChunkPart(parsed, upDir, { proposal, name, extension, uploadId }, maxSizeBytes);
}

/**
 * Store ONE chunk of a transfer inside its artifact dir, enforcing the
 * cumulative ceiling at receipt. Split out of receiveUpload so the single-shot
 * door and the chunk door are each one idea.
 */
function stageChunkPart(
	parsed: ParsedUpload,
	upDir: string,
	names: { proposal: string; name: string; extension: string; uploadId: string },
	maxSizeBytes?: number,
): UploadReceiveResult {
	const { proposal, name, extension, uploadId } = names;
	// Chunked: store the part inside THIS transfer's artifact dir. The client
	// drives the join once it has counted all chunks. Echo index/total so its
	// counter works, and the upload id so the join can find these parts.
	if (parsed.chunkIndex >= parsed.totalChunks && parsed.totalChunks > 0) {
		throw new DedaloError('media.upload_rejected', {
			message: 'upload: chunk_index is outside the declared total_chunks',
			publicMessage: 'upload: chunk_index is outside the declared total_chunks',
		});
	}
	mkdirSync(upDir, { recursive: true, mode: 0o700 });
	// CUMULATIVE CEILING AT RECEIPT (MEDIA-03). The per-request cap in
	// parseUploadRequest bounds one part; the documented ceiling is on the file,
	// so the transfer carries a running total and a part that would push it past
	// the cap is refused BEFORE it is written. A RESEND of a part already on disk
	// replaces it rather than adding to the total.
	//
	// Best effort by construction — two chunks of one transfer can race on
	// meta.json and lose an update — so it is the cheap early door, not the
	// authority. The join's pre-check and assembly total (which stat the parts
	// that actually exist) are what the ceiling is finally enforced by.
	const cap = assembledCap(maxSizeBytes);
	const partPath = resolve(upDir, `${parsed.chunkIndex}.part`);
	let replacing = 0;
	try {
		replacing = statSync(partPath).size;
	} catch {
		// Not a resend: this part is new.
	}
	const total = stagedBytes(upDir, readUploadMeta(upDir)) - replacing + parsed.blob.length;
	if (total > cap) {
		// QUARANTINE, never destruction: the parts already staged are the only copy
		// of what the curator sent, so they stay and the transfer is marked refused
		// (the join then says 'already rejected', not 'missing chunks'). The 24 h
		// sweep and the explicit cancel release it, as for any other refusal here.
		writeRejectionMarker(upDir, {
			reason: `upload: the transfer exceeds the maximum allowed size (${total} > ${cap} bytes)`,
			rejected_at: new Date().toISOString(),
			proposal,
			extension,
			size: total - parsed.blob.length,
			parts_kept: true,
		});
		throw tooLarge(
			'upload',
			total,
			cap,
			'the parts already received are NOT deleted: this transfer is quarantined and can be released by cancelling it (delete_uploaded_file with upload_id), or is collected by the 24 h sweep',
		);
	}
	writeUploadMeta(upDir, { proposal, extension, name, received: total });
	writeFileSync(partPath, parsed.blob);
	return {
		complete: false,
		// The PROPOSAL, not the final name: the client uses it only to fill
		// files_chunked[] and to carry file_data into the join.
		tmpName: proposal,
		name,
		extension,
		chunkIndex: parsed.chunkIndex,
		totalChunks: parsed.totalChunks,
		uploadId,
	};
}

/** Arguments for a chunked join. An object because five of the six are load-bearing. */
export interface JoinChunkedUploadInput {
	keyDir: string;
	/** The client's staged-name proposal (`file_data.tmp_name`) — a LOCATOR HINT only. */
	tmpName: string;
	totalChunks: number;
	userId: number;
	/** `file_data.upload_id`, round-tripped from the chunk responses. */
	uploadId?: string | null;
	mediaRoot?: string;
	/**
	 * Override of the assembled-size ceiling, for gates that must exercise the
	 * refusal without writing gigabytes. NEVER wired to client input: the
	 * `join_chunked_files_uploaded` action does not read a cap off the RQO, or
	 * the ceiling would be whatever the caller says it is.
	 */
	maxSizeBytes?: number;
}

/**
 * Locate the artifact dir of the transfer being joined.
 *
 * With an `upload_id` this is exact. Without one (a client that does not yet
 * echo `file_data.upload_id` back), fall back to matching artifact dirs on the
 * recorded proposal AND the delivered part count — and REFUSE when more than one
 * matches. Picking one of several would be precisely the silent mis-join this
 * whole change exists to make impossible.
 */
function locateUploadDir(
	userId: number,
	keyDir: string,
	proposal: string,
	totalChunks: number,
	uploadId: string | null | undefined,
	mediaRoot?: string,
): string {
	if (typeof uploadId === 'string' && uploadId !== '') {
		const dir = uploadArtifactDir(userId, keyDir, assertUploadId(uploadId), mediaRoot);
		if (!existsSync(dir)) throw noStagedParts();
		return dir;
	}
	const stagingRoot = stagingDir(userId, keyDir, mediaRoot);
	if (!existsSync(stagingRoot)) throw noStagedParts();
	const matches: string[] = [];
	for (const entry of readdirSync(stagingRoot)) {
		if (!entry.startsWith(UPLOAD_DIR_PREFIX)) continue;
		const candidate = resolve(stagingRoot, entry);
		const meta = readUploadMeta(candidate);
		if (meta === null || meta.proposal !== proposal) continue;
		let complete = true;
		for (let i = 0; i < totalChunks; i++) {
			if (!existsSync(resolve(candidate, `${i}.part`))) {
				complete = false;
				break;
			}
		}
		if (complete) matches.push(candidate);
	}
	if (matches.length === 0) throw noStagedParts();
	if (matches.length > 1) {
		throw new DedaloError('media.upload_conflict', {
			message: 'join: several staged uploads match this file name — the client must send upload_id',
			publicMessage:
				'join: several staged uploads match this file name — the client must send upload_id',
		});
	}
	return matches[0] as string;
}

/**
 * How long an `assembled` output may sit untouched before a later join treats it
 * as the wreckage of an interrupted one and starts over.
 *
 * A LIVE assembly writes continuously — a 1 MiB window per iteration — so its
 * mtime advances constantly however large the file is; an output whose mtime has
 * not moved for ten minutes has no writer. The client's transport retries the
 * join after 10 s, so without this recovery ONE interrupted join (a restart, a
 * killed worker, a full disk) blocked every subsequent attempt on that transfer
 * until the 24 h sweep — permanently, from the user's point of view.
 */
export const ASSEMBLY_STALE_MS = 10 * 60 * 1000;

/** Marker file naming a QUARANTINED transfer inside its artifact dir. */
export const REJECTION_MARKER = 'rejected.json';

/** What the rejection marker records. Read by listQuarantinedUploads. */
export interface RejectionRecord {
	reason: string;
	rejected_at: string;
	proposal: string;
	extension: string;
	size: number;
	/**
	 * True when the transfer's PARTS are what is retained (a size refusal, where
	 * no verified assembly exists), rather than a parked `rejected.<proposal>`
	 * file. Either way nothing was destroyed — this says WHERE the bytes are.
	 */
	parts_kept?: boolean;
}

/**
 * Write the marker that makes a transfer QUARANTINED. Extracted so every refusal
 * on this path parks through one function: a refusal is never a delete, and the
 * marker is what a later join and listQuarantinedUploads both read.
 */
function writeRejectionMarker(upDir: string, record: RejectionRecord): void {
	try {
		writeFileSync(resolve(upDir, REJECTION_MARKER), JSON.stringify(record), { mode: 0o640 });
	} catch (error) {
		console.warn('[upload] could not write the rejection marker:', (error as Error).message);
	}
}

/**
 * QUARANTINE a transfer whose assembled bytes failed verification.
 *
 * The previous behaviour was `rmSync(upDir, {recursive:true})` — a heuristic
 * verdict DESTROYING a completed transfer. For a heritage ingest path the
 * ranking is: silently accepting corrupt bytes < refusing loudly and KEEPING the
 * data <<< destroying a curator's upload. A curator who spent forty hours
 * pushing a 30 GB master over a rural link must not lose it to a rule that this
 * very pass proved capable of false positives.
 *
 * So the artifact dir STAYS, holding the complete assembled bytes under a
 * `rejected.` name plus a marker naming the reason. It is released by the
 * ordinary 24 h age sweep (staging_gc.ts) or immediately by the explicit cancel
 * (`delete_uploaded_file` with `upload_id`) — the same two mechanisms that
 * already governed every other in-flight artifact, so nothing new leaks.
 */
function quarantineAssembled(
	upDir: string,
	assembled: string,
	proposal: string,
	extension: string,
	reason: string,
): string {
	const quarantined = resolve(upDir, `rejected.${sanitizeSegment(proposal)}`);
	let size = 0;
	try {
		size = statSync(assembled).size;
		renameSync(assembled, quarantined);
	} catch (error) {
		// Even a failed rename must not escalate into a delete: whatever is on disk
		// stays there and the age sweep is the backstop.
		console.warn('[upload] could not park a rejected assembly:', (error as Error).message);
	}
	writeRejectionMarker(upDir, {
		reason,
		rejected_at: new Date().toISOString(),
		proposal,
		extension,
		size,
	});
	return quarantined;
}

/**
 * The quarantined transfers under one user's `key_dir` — the read side of the
 * behaviour above, so a refused upload is RECOVERABLE rather than merely
 * retained. Returns the artifact dir, the parked file and the recorded reason.
 *
 * Not yet projected onto the wire: `list_uploaded_files` keeps its WC-078 shape
 * this pass (the upload clients are owned elsewhere and a row whose URL does not
 * resolve would render as a broken restorable file). The operator path is this
 * function plus the reason echoed in the rejection response.
 */
export function listQuarantinedUploads(
	userId: number,
	keyDir: string,
	mediaRoot?: string,
): { uploadId: string; dir: string; file: string | null; record: RejectionRecord | null }[] {
	const dir = stagingDir(userId, keyDir, mediaRoot);
	if (!existsSync(dir)) return [];
	const out: {
		uploadId: string;
		dir: string;
		file: string | null;
		record: RejectionRecord | null;
	}[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.startsWith(UPLOAD_DIR_PREFIX)) continue;
		const upDir = resolve(dir, entry);
		const markerPath = resolve(upDir, REJECTION_MARKER);
		if (!existsSync(markerPath)) continue;
		let record: RejectionRecord | null = null;
		try {
			record = JSON.parse(readFileSync(markerPath, 'utf8')) as RejectionRecord;
		} catch {
			// A corrupt marker still means "quarantined" — report it without a reason
			// rather than hiding the directory.
		}
		const parked = record === null ? null : resolve(upDir, `rejected.${record.proposal}`);
		out.push({
			uploadId: entry.slice(UPLOAD_DIR_PREFIX.length),
			dir: upDir,
			file: parked !== null && existsSync(parked) ? parked : null,
			record,
		});
	}
	return out;
}

/** Yield to the event loop so a long assembly does not freeze the single-threaded engine. */
const yieldToLoop = (): Promise<void> =>
	new Promise<void>((done) => {
		setImmediate(done);
	});

/**
 * Fail-closed pre-flight for a join: every declared part is on disk, and the
 * bytes they hold do not already exceed the ceiling.
 *
 * SIZE PRE-CHECK (MEDIA-03), BEFORE a byte of output exists. `total_chunks`
 * bounds the COUNT of parts and nothing else, so a transfer of 100 000 parts
 * each under the per-request cap used to assemble unrefused into a file
 * arbitrarily past the ceiling the catalog advertises and get_system_info
 * publishes. Summing the parts that are actually on disk is what the ceiling
 * means, and doing it here refuses without ever allocating the output.
 */
function assertPartsCompleteAndUnderCap(
	upDir: string,
	totalChunks: number,
	cap: number,
	proposal: string,
	extension: string,
): void {
	let declaredBytes = 0;
	for (let i = 0; i < totalChunks; i++) {
		const partPath = resolve(upDir, `${i}.part`);
		if (!existsSync(partPath)) {
			throw new DedaloError('media.upload_rejected', {
				message: `join: missing chunk ${i} of ${totalChunks}`,
				publicMessage: `join: missing chunk ${i} of ${totalChunks}`,
			});
		}
		declaredBytes += statSync(partPath).size;
	}
	if (declaredBytes <= cap) return;
	// The parts STAY — they are the only copy of the transfer — and the marker
	// makes the state legible (a retry reads 'already rejected', not 'missing
	// chunks'). Release is the ordinary cancel or the 24 h sweep.
	writeRejectionMarker(upDir, {
		reason: `join: the assembled upload exceeds the maximum allowed size (${declaredBytes} > ${cap} bytes)`,
		rejected_at: new Date().toISOString(),
		proposal,
		extension,
		size: declaredBytes,
		parts_kept: true,
	});
	throw tooLarge(
		'join',
		declaredBytes,
		cap,
		'the uploaded bytes are NOT deleted: this transfer is quarantined and can be released by cancelling it (delete_uploaded_file with upload_id), or is collected by the 24 h sweep',
	);
}

/**
 * Open the assembly output EXCLUSIVELY, recovering an abandoned one.
 *
 * The client's transport retries the join after 10 s and up to 5 times, so on a
 * slow (multi-GB) assembly a second join can arrive while the first is still
 * writing. Two writers on one output produce a silently corrupt file; refusing
 * the second produces a loud, retryable error, and between those two the loud
 * one is the only acceptable answer.
 *
 * RECOVERY (2026-08-03): an INTERRUPTED join used to leave this file behind
 * forever, and every retry then failed on it — a permanently stuck transfer,
 * reachable in ordinary operation because the transport retries at 10 s. An
 * output nobody has written to for ASSEMBLY_STALE_MS has no writer, and the
 * parts are all still on disk (they are removed only once the join is
 * finished), so the honest recovery is to discard the partial output and
 * assemble again.
 */
function openAssemblyOutput(assembled: string): number {
	const openAssembly = (): number => openSync(assembled, 'wx', 0o640);
	try {
		return openAssembly();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	let idleFor = 0;
	try {
		idleFor = Date.now() - statSync(assembled).mtimeMs;
	} catch {
		idleFor = 0; // it vanished under us: let the retry below decide
	}
	if (idleFor < ASSEMBLY_STALE_MS) throw alreadyAssembling();
	rmSync(assembled, { force: true });
	try {
		return openAssembly();
	} catch {
		// Another join won the race to recover it — that one is live, so this is
		// the ordinary concurrent case again.
		throw alreadyAssembling();
	}
}

/**
 * Assemble a chunked upload's parts into the final staged file and RE-VERIFY the
 * whole (SEC-066 + verify_content.ts), then return the staged descriptor. Called
 * by the dd_utils_api.join_chunked_files_uploaded action after the client has
 * posted every chunk. `totalChunks` is derived from the client's files_chunked
 * array.
 *
 * Memory: the assembly copies part→output through ONE fixed buffer, and the
 * verification reads the result in bounded windows. Neither the parts nor the
 * assembled file are ever held whole in RAM (the old code read each part with
 * readFileSync — a client-chosen part size, not a bounded one).
 *
 * ASYNC since 2026-08-03: the copy is O(file size) and was fully synchronous, so
 * joining a 30 GB master stalled every other request on this single-threaded
 * engine for the whole copy. It now yields to the event loop between windows.
 * (The verification pass is bounded and stays synchronous — see
 * engine/verify_content.ts, which no longer has any whole-file rule.)
 */
export async function joinChunkedUpload(
	input: JoinChunkedUploadInput,
): Promise<UploadReceiveResult> {
	const { keyDir, tmpName, totalChunks, userId, uploadId, mediaRoot } = input;
	const cap = assembledCap(input.maxSizeBytes);
	const dir = stagingDir(userId, keyDir, mediaRoot);
	if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) {
		throw new DedaloError('media.upload_rejected', {
			message: 'join: invalid total_chunks',
			publicMessage: 'join: invalid total_chunks',
		});
	}
	const hint = sanitizeSegment(tmpName);
	const upDir = locateUploadDir(userId, keyDir, hint, totalChunks, uploadId, mediaRoot);
	const meta = readUploadMeta(upDir);
	// The SERVER's own record of the name wins over the client-relayed hint: the
	// hint is only a locator, and the name on disk must not be re-decidable by a
	// later request.
	const proposal = meta?.proposal ?? hint;
	const extension = meta?.extension ?? extensionOf(hint);
	// The SERVER's recorded human name, for the same reason as the proposal above:
	// the join request relays the client's copy of file_data, and the name the
	// archive records must be the one the parts were uploaded under.
	const name = meta?.name ?? displayFileName(hint);

	// A transfer already quarantined must not read as "missing chunks": say what
	// actually happened, and that the bytes are still there.
	if (existsSync(resolve(upDir, REJECTION_MARKER))) {
		const reason =
			'join: this upload was already rejected by content verification; its bytes are quarantined and released by cancelling it (delete_uploaded_file with upload_id) or by the 24 h sweep';
		throw new DedaloError('media.upload_rejected', { message: reason, publicMessage: reason });
	}

	assertPartsCompleteAndUnderCap(upDir, totalChunks, cap, proposal, extension);
	const assembled = resolve(upDir, 'assembled');
	// EXCLUSIVE create, with recovery of an abandoned output — see
	// openAssemblyOutput above for both halves of the reasoning.
	const out = openAssemblyOutput(assembled);
	// The AUTHORITATIVE total: the pre-check reads the parts as they were a moment
	// ago, this counts the bytes actually copied, so a part still growing under a
	// concurrent chunk POST cannot slip past the ceiling.
	let writtenBytes = 0;
	let overflowed = false;
	try {
		const buffer = new Uint8Array(1 << 20);
		assembly: for (let i = 0; i < totalChunks; i++) {
			const partPath = resolve(upDir, `${i}.part`);
			const part = openSync(partPath, 'r');
			try {
				let position = 0;
				for (;;) {
					const read = readSync(part, buffer, 0, buffer.length, position);
					if (read <= 0) break;
					if (writtenBytes + read > cap) {
						// Checked BEFORE the write: not one byte past the ceiling is ever
						// put on disk.
						writtenBytes += read;
						overflowed = true;
						break assembly;
					}
					writeSync(out, buffer, 0, read);
					writtenBytes += read;
					position += read;
					// Hand the loop back between windows: a 30 GB join is ~30 000 of these,
					// and holding the thread for all of them froze every other user.
					await yieldToLoop();
				}
			} finally {
				closeSync(part);
			}
			// NOTE: the part is deliberately NOT unlinked here. It used to be consumed
			// as it was read, so an interruption mid-assembly had already destroyed
			// the front of the transfer and no retry could ever succeed. Parts are the
			// only complete copy of the bytes until the join finishes, so they are
			// removed at the very end — after assembly AND verification have both
			// reached a durable outcome.
		}
	} finally {
		closeSync(out);
	}
	if (overflowed) {
		// The PARTIAL output is a derived duplicate of parts that are all still on
		// disk, so discarding it destroys nothing (the same reasoning the stale
		// -assembly recovery above already rests on); the PARTS are what is kept,
		// and the marker is what makes the transfer legible as quarantined.
		rmSync(assembled, { force: true });
		writeRejectionMarker(upDir, {
			reason: `join: the assembled upload exceeds the maximum allowed size (>= ${writtenBytes} > ${cap} bytes)`,
			rejected_at: new Date().toISOString(),
			proposal,
			extension,
			size: writtenBytes,
			parts_kept: true,
		});
		throw tooLarge(
			'join',
			writtenBytes,
			cap,
			'the uploaded bytes are NOT deleted: this transfer is quarantined and can be released by cancelling it (delete_uploaded_file with upload_id), or is collected by the 24 h sweep',
		);
	}
	try {
		// SEC-066, now over the whole CONTAINER within a bounded budget: the head
		// signature must still match the declared extension, and the container must
		// satisfy whatever bounded invariant its content class has (see
		// engine/verify_content.ts for exactly what that is per format, and for the
		// named exemptions where it is still header-only).
		verifyFileContent(assembled, extension);
	} catch (error) {
		const reason = (error as Error).message;
		const parked = quarantineAssembled(upDir, assembled, proposal, extension, reason);
		// The parts are now redundant: assembly completed, and the parked file holds
		// the same bytes contiguously. Keeping both would double the disk cost of
		// every rejected multi-GB transfer.
		for (let i = 0; i < totalChunks; i++) {
			rmSync(resolve(upDir, `${i}.part`), { force: true });
		}
		console.warn(
			`[upload] transfer quarantined (not deleted): ${parked} — ${reason}. Release it with delete_uploaded_file + upload_id, or let the 24 h sweep collect it.`,
		);
		// The verifier's own sentence + the quarantine remedy. `uploadId` is client
		// input, so it rides the LOG message only; the public half names no id.
		throw new DedaloError('media.upload_rejected', {
			message: `${reason} — the uploaded bytes are NOT deleted: this transfer is quarantined${
				uploadId ? ` as upload_id '${uploadId}'` : ''
			} and can be released by cancelling it, or is collected by the 24 h sweep`,
			publicMessage: `${reason} — the uploaded bytes are NOT deleted: this transfer is quarantined and can be released by cancelling it (delete_uploaded_file with upload_id), or is collected by the 24 h sweep`,
		});
	}
	const staged = claimStagedName(dir, proposal, assembled);
	// DOOR 2 (the chunked join). Same reason as the single-shot door above, and
	// the LAST moment this value exists: `meta.json` carried the server-recorded
	// name across the chunk requests, and the artifact dir holding it is removed
	// three lines below. Without this the name would die with it.
	recordStagedDisplayName(dir, staged, name);
	// Everything left in the artifact dir is garbage by definition: the client
	// declared how many parts the file had, and it has been assembled and
	// verified. Leaving a surplus part behind is the leak this change exists to
	// end — and this is also where the consumed parts finally go.
	rmSync(upDir, { recursive: true, force: true });
	// Opportunistic GC of OTHER abandoned transfers in the same key_dir.
	try {
		sweepStagedOrphans(userId, keyDir, mediaRoot);
	} catch (error) {
		console.warn('[upload] staging sweep failed:', (error as Error).message);
	}
	return {
		complete: true,
		tmpName: staged,
		name,
		extension,
		chunkIndex: 0,
		totalChunks,
		uploadId: uploadId ?? undefined,
	};
}

/** Confine a name inside the staging dir (defense in depth over sanitizeSegment). */
function confine(dir: string, name: string): string {
	const safe = name.includes('/') ? sanitizeSegment(name) : name;
	const full = resolve(dir, safe);
	if (!full.startsWith(dir + sep)) {
		throw new DedaloError('media.invalid_path', {
			message: 'upload path escapes staging dir',
			coordinates: { path: full },
		});
	}
	return full;
}
