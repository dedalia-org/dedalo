/**
 * zip_inflated_size — how many bytes an uploaded `.shp.zip` really inflates
 * to, measured before GDAL opens it. The 10 MB upload cap bounds the zip, not
 * what `/vsizip/` decompresses: a zip bomb would otherwise be stopped only by
 * the binary timeout. Each entry is inflated (and discarded) up to a shared
 * budget, so a size the headers lie about, or entries overlapping one
 * compressed stream, cannot get past it.
 */

import { createInflateRaw } from 'node:zlib';
import { DedaloError } from '../../../src/core/errors/index.ts';

// A shapefile is a handful of sidecar files; a zip of several layers is a few
// dozen. Far above that is not a shapefile upload.
const MAX_ENTRIES = 1000;

const EOCD_LENGTH = 22;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;

function invalidZip(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

// signatures compared as byte runs (PK + two bytes), the way the engine's
// readers sniff: a 32-bit literal is how the ZIP encoder census spots emission
function hasSignature(bytes: Uint8Array, at: number, third: number, fourth: number): boolean {
	return (
		bytes[at] === 0x50 &&
		bytes[at + 1] === 0x4b &&
		bytes[at + 2] === third &&
		bytes[at + 3] === fourth
	);
}

/** The end-of-central-directory record: the last one, within its comment's reach. */
function findEndOfCentralDirectory(bytes: Uint8Array): number {
	const lowest = Math.max(0, bytes.length - EOCD_LENGTH - 0xffff);
	for (let at = bytes.length - EOCD_LENGTH; at >= lowest; at--) {
		if (hasSignature(bytes, at, 0x05, 0x06)) return at;
	}
	throw invalidZip('The uploaded file is not a readable zip archive');
}

/** Inflate `data` without keeping it, counting into the remaining budget. */
function inflatedLength(data: Uint8Array, budget: number): Promise<number> {
	return new Promise((resolve, reject) => {
		let total = 0;
		const inflate = createInflateRaw();
		inflate.on('data', (chunk: Buffer) => {
			total += chunk.length;
			if (total > budget) {
				inflate.destroy();
				resolve(total);
			}
		});
		inflate.on('error', () => reject(invalidZip('The uploaded zip archive is corrupt')));
		inflate.on('end', () => resolve(total));
		inflate.end(data);
	});
}

/**
 * Refuse a zip whose entries inflate past `maxBytes` in total, or that this
 * measure cannot read honestly (ZIP64, split, encrypted, a method other than
 * store/deflate, offsets outside the file). Returns the inflated total.
 */
export async function assertZipInflatesWithin(
	bytes: Uint8Array,
	maxBytes: number,
): Promise<number> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const eocd = findEndOfCentralDirectory(bytes);
	const entries = view.getUint16(eocd + 10, true);
	const directorySize = view.getUint32(eocd + 12, true);
	const directoryOffset = view.getUint32(eocd + 16, true);
	if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
		throw invalidZip('A zip archive split into several files is not supported');
	}
	// a ZIP64 marker: a 10 MB upload never needs one, and its sizes would need their own reader
	if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
		throw invalidZip('A ZIP64 archive is not supported: zip the shapefile without ZIP64');
	}
	if (entries > MAX_ENTRIES) {
		throw invalidZip(`The zip archive holds ${entries} files (at most ${MAX_ENTRIES})`);
	}
	if (directoryOffset + directorySize > eocd) {
		throw invalidZip('The uploaded zip archive is corrupt');
	}

	let total = 0;
	let at = directoryOffset;
	for (let index = 0; index < entries; index++) {
		if (at + CENTRAL_HEADER_LENGTH > eocd || !hasSignature(bytes, at, 0x01, 0x02)) {
			throw invalidZip('The uploaded zip archive is corrupt');
		}
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const compressedSize = view.getUint32(at + 20, true);
		const localOffset = view.getUint32(at + 42, true);
		const nameLength = view.getUint16(at + 28, true);
		at +=
			CENTRAL_HEADER_LENGTH +
			nameLength +
			view.getUint16(at + 30, true) +
			view.getUint16(at + 32, true);

		if ((flags & 0x1) !== 0) throw invalidZip('An encrypted zip archive is not supported');
		if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
			throw invalidZip('A ZIP64 archive is not supported: zip the shapefile without ZIP64');
		}
		if (
			localOffset + LOCAL_HEADER_LENGTH > bytes.length ||
			!hasSignature(bytes, localOffset, 0x03, 0x04)
		) {
			throw invalidZip('The uploaded zip archive is corrupt');
		}
		const dataStart =
			localOffset +
			LOCAL_HEADER_LENGTH +
			view.getUint16(localOffset + 26, true) +
			view.getUint16(localOffset + 28, true);
		if (dataStart + compressedSize > bytes.length) {
			throw invalidZip('The uploaded zip archive is corrupt');
		}
		const data = bytes.subarray(dataStart, dataStart + compressedSize);

		if (method === 0) total += compressedSize;
		else if (method === 8) total += await inflatedLength(data, maxBytes - total);
		else throw invalidZip(`Zip compression method ${method} is not supported (store or deflate)`);

		if (total > maxBytes) {
			throw invalidZip(
				`The zip archive inflates to more than ${maxBytes} bytes: upload a smaller shapefile`,
			);
		}
	}
	return total;
}
