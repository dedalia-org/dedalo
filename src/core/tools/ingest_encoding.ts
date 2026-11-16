/**
 * INGEST DECODING — how an uploaded TEXT file becomes a string.
 *
 * The CSV doors read through here and the MARC21 parser makes the same decision
 * from its leader. `tools/tool_import_zotero` does NOT yet (an XML door has its
 * own declaration to honour) — it is the one entry in the shrink-only exemption
 * map of `test/unit/ingest_encoding_tripwire.test.ts`, which is the census that
 * keeps this list honest.
 *
 * DATA-09 (2026-08-26 audit): both CSV doors read their upload with
 * `await Bun.file(path).text()`, i.e. a UTF-8 decode with `fatal:false` (the
 * MARC21 door read BYTES and then decoded them just as leniently, never reading
 * the leader position that declares the record's encoding). Any
 * byte sequence that is not valid UTF-8 becomes U+FFFD — irreversibly, with no
 * error, no warning and no notice — and the replacement characters are written
 * into the records with a green file report. A CP1252 CSV (what Excel saves when
 * it opens a BOM-less export, which is what our own download half produced)
 * stored `Ripoll<FFFD>s` for `Ripollès`. Nothing downstream can undo that: the
 * original byte is gone.
 *
 * The frozen PHP did the opposite DELIBERATELY, and said so in a comment
 * (tool_common::read_csv_file_as_array): `mb_check_encoding($line,'UTF-8')` and,
 * on failure, `mb_convert_encoding($cell, 'UTF-8', mb_list_encodings())` for
 * every cell, latched for the rest of the file.
 *
 * THE RULE HERE: convert, or refuse — never substitute.
 *
 *  1. a UTF-8/UTF-16 BOM decides the encoding outright;
 *  2. otherwise a STRICT (`fatal:true`) UTF-8 decode is tried: valid → UTF-8;
 *  3. invalid → windows-1252, which is TOTAL (all 256 bytes map, verified) and is
 *     what a European spreadsheet actually writes. It is a CONVERSION, reported
 *     to the operator through `converted`, never a silent guess;
 *  4. a decode that yields NUL (a binary file, or UTF-16 with no BOM) is
 *     REFUSED, and so is one that yields U+FFFD — which, since the fallback is
 *     total, can only mean the FILE already carried the replacement character,
 *     i.e. it was damaged before it reached us. Each refusal says which it is.
 *
 * Why not PHP's `mb_list_encodings()` detection: it ranks ~80 candidate encodings
 * by heuristic and picks one; on a short cell it picks a different one than on a
 * long one, so the same byte could convert two ways in one file. A named,
 * measured fallback is the honest version of the same intent.
 */

import { open } from 'node:fs/promises';
import { DedaloError } from '../errors/index.ts';

/** The encodings this door can answer with. */
export type IngestEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedIngestText {
	text: string;
	encoding: IngestEncoding;
	/** True when the bytes were NOT UTF-8 and had to be converted (say so to the operator). */
	converted: boolean;
	/** The operator-facing sentence for `converted`, else null. */
	notice: string | null;
}

/** A byte-order mark and what it declares. Ordered: the longest signature first. */
const BYTE_ORDER_MARKS: readonly {
	readonly bytes: readonly number[];
	readonly encoding: IngestEncoding;
}[] = [
	{ bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
	{ bytes: [0xff, 0xfe], encoding: 'utf-16le' },
	{ bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

/** The BOM these bytes open with, or null. */
function matchByteOrderMark(bytes: Uint8Array): (typeof BYTE_ORDER_MARKS)[number] | null {
	for (const mark of BYTE_ORDER_MARKS) {
		if (mark.bytes.every((byte, index) => bytes[index] === byte)) return mark;
	}
	return null;
}

/** Whether the bytes are valid UTF-8 — the STRICT decode, so nothing is substituted. */
function isStrictUtf8(bytes: Uint8Array): boolean {
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}

/**
 * The encoding to read these bytes with, and the body after any BOM.
 * A BOM decides outright; otherwise valid UTF-8 is UTF-8 and anything else is
 * windows-1252 — TOTAL (all 256 bytes map, verified), and what a European
 * spreadsheet actually writes.
 */
function detectIngestEncoding(bytes: Uint8Array): { encoding: IngestEncoding; body: Uint8Array } {
	const mark = matchByteOrderMark(bytes);
	if (mark !== null) {
		return { encoding: mark.encoding, body: bytes.subarray(mark.bytes.length) };
	}
	return { encoding: isStrictUtf8(bytes) ? 'utf-8' : 'windows-1252', body: bytes };
}

/**
 * The U+FFFD refusal, with the sentence that is TRUE for how it got there.
 *
 * windows-1252 is total and the UTF-8 probe is strict, so a U+FFFD in the
 * decoded text is never something this module invented. It is either (a) a
 * character the FILE itself carries — the upload was already damaged, upstream
 * of Dédalo — or (b) an unpaired surrogate in a UTF-16 upload. The two need
 * different sentences, because telling an operator "we could not convert it"
 * about a perfectly valid UTF-8 file sends them to fix the wrong thing.
 */
function replacementCharacterSentence(label: string, encoding: IngestEncoding): string {
	return encoding === 'utf-8'
		? `${label}: the file itself already contains replacement characters (U+FFFD) — its original encoding was lost before it reached Dédalo, and importing it would store that damage in the records. Re-export it from the source system in UTF-8 and upload it again.`
		: `${label}: the file is not UTF-8 and could not be converted without losing characters (it was read as ${encoding}). Save it as UTF-8 and upload it again.`;
}

/**
 * The two shapes we cannot honestly import. Both REFUSE — the whole point of
 * this module is that a file is converted or rejected, never quietly damaged.
 */
function assertDecodable(text: string, label: string, encoding: IngestEncoding): void {
	const refuse = (sentence: string): never => {
		// Public: the operator's own upload and what is wrong with it.
		throw new DedaloError('request.invalid_data', {
			message: sentence,
			publicMessage: sentence,
		});
	};
	// NUL: a binary upload, or UTF-16 without a BOM (whose ASCII decodes as valid
	// UTF-8 with a NUL between every character). Both would import as garbage.
	if (text.includes('\0')) {
		refuse(
			`${label}: this is not a text file we can read (it contains NUL bytes). If it is a UTF-16 file, save it as UTF-8 and upload it again.`,
		);
	}
	if (text.includes('\uFFFD')) refuse(replacementCharacterSentence(label, encoding));
}

/**
 * Decode uploaded bytes to text, converting or refusing — never substituting.
 * `label` names the file in the message the operator reads.
 */
export function decodeIngestBytes(bytes: Uint8Array, label: string): DecodedIngestText {
	const { encoding, body } = detectIngestEncoding(bytes);
	const text = new TextDecoder(encoding).decode(body);
	assertDecodable(text, label, encoding);
	const converted = encoding !== 'utf-8';
	return {
		text,
		encoding,
		converted,
		notice: converted
			? `${label}: the file is not UTF-8 — it was read as ${encoding} and converted. Check the imported values; saving the file as UTF-8 before importing removes the guess.`
			: null,
	};
}

/**
 * The operator sentence for a file over its door's byte ceiling — exported so a
 * door that refuses BEFORE reading (the CSV tool's process_uploaded_file) says
 * exactly what the read door says.
 */
export function oversizedIngestSentence(label: string, size: number, maxBytes: number): string {
	const limit =
		maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${maxBytes} bytes`;
	return `${label}: the file is too large to import (${size} bytes; the limit is ${limit}). Split it into smaller files and upload the parts.`;
}

function oversized(label: string, size: number, maxBytes: number): DedaloError {
	const sentence = oversizedIngestSentence(label, size, maxBytes);
	// Public: the operator's own file, its size and the limit — no path.
	return new DedaloError('media.too_large', { message: sentence, publicMessage: sentence });
}

/**
 * Read at most `maxBytes` BYTES of `path`, refusing a larger file BEFORE a byte
 * of it is buffered (T1-S18). The bound counts bytes on disk, never decoded code
 * units (a UTF-16 file decodes to half as many units as it has bytes), and is a
 * REQUIRED argument: a door cannot read unbounded by omission.
 *
 * One file descriptor: the size is taken from the OPEN file (fstat) and the read
 * asks for one byte more than that size, so a file that grows between the stat
 * and the read is seen growing — and refused if it crossed the bound, or when it
 * changed under us at all (a copy still being written is not the file to import).
 */
async function readBoundedBytes(
	path: string,
	label: string,
	maxBytes: number,
): Promise<Uint8Array> {
	const handle = await open(path, 'r');
	try {
		const { size } = await handle.stat();
		if (size > maxBytes) throw oversized(label, size, maxBytes);
		const buffer = new Uint8Array(size + 1);
		let read = 0;
		while (read < buffer.length) {
			const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
			if (bytesRead === 0) break;
			read += bytesRead;
		}
		if (read > size) {
			const now = (await handle.stat()).size;
			if (now > maxBytes) throw oversized(label, now, maxBytes);
			const sentence = `${label}: the file changed while it was being read. Wait until it is completely copied and try again.`;
			throw new DedaloError('request.invalid_data', { message: sentence, publicMessage: sentence });
		}
		return buffer.subarray(0, read);
	} finally {
		await handle.close();
	}
}

/** decodeIngestBytes over a staged upload on disk, bounded to `maxBytes` bytes. */
export async function readIngestTextFile(
	path: string,
	label: string,
	maxBytes: number,
): Promise<DecodedIngestText> {
	return decodeIngestBytes(await readBoundedBytes(path, label, maxBytes), label);
}
