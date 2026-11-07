/**
 * The DIMENSIONS of a raster legend icon, read from its own header bytes
 * (png / jpeg / webp) — the half of the icon contract the byte caps cannot hold.
 *
 * A legend icon is capped in BYTES (map_legend.ts), but bytes are not what an
 * image costs the browser that decodes it: a 1-bit PNG that declares 16000 x
 * 16000 pixels is 31 KB on the wire and about a gigabyte once decoded to RGBA.
 * The legend rides to every viewer who opens the record, so the cap that matters
 * to them is the PIXEL one. Reading width and height needs no decoder: each
 * format states them in a fixed header.
 *
 *   png    IHDR, the first chunk: big-endian u32 width, height at byte 16;
 *   webp   RIFF container; the first chunk is one of
 *            VP8   lossy: a 14-bit width and height after the frame start code,
 *            VP8L  lossless: 14 bits each, minus one, after the 0x2f signature,
 *            VP8X  extended: 24-bit canvas width and height, minus one;
 *   jpeg   the first SOFn segment (after any APPn / DQT / DHT ones): big-endian
 *          u16 height, then width. A JPEG states its size AFTER its metadata, so
 *          it is the one format read from the whole payload, not a prefix — the
 *          payload is bounded by the per-icon byte cap already.
 *
 * Every reader answers null for bytes that are not the format they claim (wrong
 * signature, truncated, an unknown first chunk): "not a valid image of this type"
 * and "unreadable size" are the same refusal to the caller. Pure and total: a
 * short or hostile buffer returns null, never throws, never reads past the end.
 *
 * The LIMIT on the numbers is not here (map_legend.ts judges them); this module
 * only reads them. Gate: test/unit/geo_map_source_native.test.ts.
 */

export type RasterFormat = 'png' | 'jpeg' | 'webp';

export interface IconSize {
	width: number;
	height: number;
}

/** Base64 characters of the prefix png and webp are read from (30 bytes: the most any header needs). */
const HEADER_BASE64_CHARS = 40;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const IHDR = [0x49, 0x48, 0x44, 0x52] as const;
const RIFF = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP = [0x57, 0x45, 0x42, 0x50] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;

/** The start-of-frame markers: SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc). */
const JPEG_FRAME_MARKERS: ReadonlySet<number> = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
/** Markers after which no frame header can follow: start of scan, end of image. */
const JPEG_NO_FRAME_AFTER: ReadonlySet<number> = new Set([0xda, 0xd9]);

function startsWith(bytes: Uint8Array, at: number, expected: readonly number[]): boolean {
	return expected.every((byte, offset) => bytes[at + offset] === byte);
}

function readU16BE(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

function readU16LE(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function readU24LE(bytes: Uint8Array, at: number): number {
	return readU16LE(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
}

function readU32BE(bytes: Uint8Array, at: number): number {
	return ((readU16BE(bytes, at) << 16) | readU16BE(bytes, at + 2)) >>> 0;
}

function readU32LE(bytes: Uint8Array, at: number): number {
	return ((readU16LE(bytes, at + 2) << 16) | readU16LE(bytes, at)) >>> 0;
}

// ---------------------------------------------------------------------------
// png
// ---------------------------------------------------------------------------

function pngSize(bytes: Uint8Array): IconSize | null {
	if (bytes.length < 24 || !startsWith(bytes, 0, PNG_SIGNATURE) || !startsWith(bytes, 12, IHDR)) {
		return null;
	}
	return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

// ---------------------------------------------------------------------------
// webp
// ---------------------------------------------------------------------------

/** VP8 (lossy): the 3-byte frame tag, the start code 9d 01 2a, then two 14-bit sizes. */
function lossySize(bytes: Uint8Array): IconSize | null {
	if (bytes.length < 30 || !startsWith(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
	return { width: readU16LE(bytes, 26) & 0x3fff, height: readU16LE(bytes, 28) & 0x3fff };
}

/** VP8L (lossless): the 0x2f signature, then 14-bit width and height, each stored minus one. */
function losslessSize(bytes: Uint8Array): IconSize | null {
	if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
	const bits = readU32LE(bytes, 21);
	return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/** VP8X (extended): the canvas, 24 bits each, stored minus one. */
function extendedSize(bytes: Uint8Array): IconSize | null {
	if (bytes.length < 30) return null;
	return { width: readU24LE(bytes, 24) + 1, height: readU24LE(bytes, 27) + 1 };
}

const WEBP_CHUNKS: ReadonlyMap<string, (bytes: Uint8Array) => IconSize | null> = new Map([
	['VP8 ', lossySize],
	['VP8L', losslessSize],
	['VP8X', extendedSize],
]);

/** The four-character code at `at`, as text. */
function fourCC(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(...bytes.subarray(at, at + 4));
}

function webpSize(bytes: Uint8Array): IconSize | null {
	if (bytes.length < 16 || !startsWith(bytes, 0, RIFF) || !startsWith(bytes, 8, WEBP)) return null;
	return WEBP_CHUNKS.get(fourCC(bytes, 12))?.(bytes) ?? null;
}

// ---------------------------------------------------------------------------
// jpeg
// ---------------------------------------------------------------------------

/** What the segment at `at` says: the frame size, how far to the next segment, or null when malformed. */
type JpegStep = { size: IconSize } | { skip: number } | null;

function jpegStep(bytes: Uint8Array, at: number): JpegStep {
	const marker = bytes[at + 1];
	if (bytes[at] !== 0xff || marker === undefined) return null;
	if (JPEG_FRAME_MARKERS.has(marker)) {
		return { size: { height: readU16BE(bytes, at + 5), width: readU16BE(bytes, at + 7) } };
	}
	const length = readU16BE(bytes, at + 2);
	return length < 2 || JPEG_NO_FRAME_AFTER.has(marker) ? null : { skip: 2 + length };
}

function jpegSize(bytes: Uint8Array): IconSize | null {
	if (!startsWith(bytes, 0, JPEG_SIGNATURE)) return null;
	let at = 2;
	// A frame header needs nine bytes from its marker on (marker, length, precision, height, width).
	while (at + 9 <= bytes.length) {
		const step = jpegStep(bytes, at);
		if (step === null) return null;
		if ('size' in step) return step.size;
		at += step.skip;
	}
	return null;
}

// ---------------------------------------------------------------------------
// the door
// ---------------------------------------------------------------------------

const READERS: Readonly<Record<RasterFormat, (bytes: Uint8Array) => IconSize | null>> = {
	png: pngSize,
	jpeg: jpegSize,
	webp: webpSize,
};

/**
 * The pixel size `base64` (the payload of a data URI) declares for `format`, or
 * null when the bytes are not that format. Only the prefix a header needs is
 * decoded for png and webp; jpeg is decoded whole (see the header). Not the
 * place for the size LIMIT — the caller judges the numbers.
 */
export function rasterSize(format: RasterFormat, base64: string): IconSize | null {
	const text = format === 'jpeg' ? base64 : base64.slice(0, HEADER_BASE64_CHARS);
	return READERS[format](Buffer.from(text, 'base64'));
}
