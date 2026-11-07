/**
 * IS IT THE IMAGE IT SAYS IT IS — the check the tile proxy makes on the bytes before it
 * relays them or keeps them.
 *
 * The harvesting door has already refused any 2xx whose `Content-Type` is not one of the
 * four image types, before reading the body. That header is the PROVIDER's claim. The
 * bytes are what a browser (and the cache) will actually hold, and a server that labels
 * an HTML error page `image/png` — or an SVG, which is a document with script — would
 * otherwise be relayed under our own origin. So the route also checks the first bytes
 * against the type's signature:
 *
 *   image/png   89 50 4E 47 0D 0A 1A 0A
 *   image/jpeg  FF D8 FF
 *   image/gif   "GIF87a" or "GIF89a"
 *   image/webp  "RIFF" + 4 size bytes + "WEBP"
 *
 * A signature is not a full decode — it cannot prove the file is well-formed — but it
 * separates every image from every markup document, which is the confusion that matters,
 * and the response is served `nosniff` under `default-src 'none'; sandbox` besides.
 *
 * THE SIZE THE IMAGE DECLARES is the second check, and the one the byte ceiling cannot make.
 * Two megabytes of PNG, JPEG or WebP can legitimately decode to gigapixels, and the page draws
 * a tile as a 256 px square but the browser decodes the file in FULL: a source an editor stored,
 * one whose domain lapsed and was registered again, or a provider that is compromised could hang
 * or crash the tab of everyone who opens the record, and `nosniff` and the sandbox do nothing
 * about that. So the header of each type is read for its width and height (PNG IHDR, GIF logical
 * screen, JPEG start-of-frame, WebP VP8 / VP8L / VP8X) and an image over `RELAYED_IMAGE_LIMITS` —
 * or one whose header does not state a size — is not relayed. The ceiling is generous for what a
 * map asks for (a tile is 256 px, a retina tile 512, a free WMS image at most 1024 per side) and
 * far under what a decoder chokes on.
 *
 * PURE.
 */

/** The signatures, as byte prefixes (and, for WebP, the four bytes after the size). */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF_87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF_89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/** The bytes of `bytes` from `offset` start with `signature`. */
function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
	return (
		bytes.length >= offset + signature.length &&
		signature.every((byte, index) => bytes[offset + index] === byte)
	);
}

/** One check per media type: the bytes begin like a file of it. */
const MATCHERS: ReadonlyMap<string, (bytes: Uint8Array) => boolean> = new Map([
	['image/png', (bytes: Uint8Array) => startsWith(bytes, PNG)],
	['image/jpeg', (bytes: Uint8Array) => startsWith(bytes, JPEG)],
	['image/gif', (bytes: Uint8Array) => startsWith(bytes, GIF_87) || startsWith(bytes, GIF_89)],
	['image/webp', (bytes: Uint8Array) => startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)],
]);

/** True when `bytes` begin like a file of the exact media type `contentType` (parameters aside). */
export function bytesMatchMediaType(bytes: Uint8Array, contentType: string): boolean {
	return MATCHERS.get(bareMediaType(contentType))?.(bytes) === true;
}

/** The exact media type of a `Content-Type` value: lower case, parameters dropped. */
export function bareMediaType(contentType: string): string {
	return (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
}

/** What an image relayed by the proxy may measure: per side, and in all. */
export const RELAYED_IMAGE_LIMITS = Object.freeze({
	/** Pixels on one side. */
	maxSide: 2048,
	/** Pixels in all (4 Mpx: a 2048 x 2048 image). */
	maxPixels: 4 * 1024 * 1024,
});

/** The width and height an image header declares, in pixels. */
export interface ImageSize {
	readonly width: number;
	readonly height: number;
}

/** A big-endian 16-bit number at `at`. */
function u16be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}

/** A little-endian 16-bit number at `at`. */
function u16le(bytes: Uint8Array, at: number): number {
	return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

/** A little-endian 24-bit number at `at`. */
function u24le(bytes: Uint8Array, at: number): number {
	return u16le(bytes, at) | ((bytes[at + 2] ?? 0) << 16);
}

/** A little-endian 32-bit unsigned number at `at`. */
function u32le(bytes: Uint8Array, at: number): number {
	return (u24le(bytes, at) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
}

/** A big-endian 32-bit unsigned number at `at`. */
function u32be(bytes: Uint8Array, at: number): number {
	return (((bytes[at] ?? 0) << 24) | u24be(bytes, at + 1)) >>> 0;
}

/** A big-endian 24-bit number at `at`. */
function u24be(bytes: Uint8Array, at: number): number {
	return ((bytes[at] ?? 0) << 16) | u16be(bytes, at + 1);
}

/** The four ASCII characters at `at`. */
function fourcc(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(
		bytes[at] ?? 0,
		bytes[at + 1] ?? 0,
		bytes[at + 2] ?? 0,
		bytes[at + 3] ?? 0,
	);
}

/** PNG: the IHDR chunk must come first (8-byte signature, 4-byte length, "IHDR"), then width and height. */
function pngSize(bytes: Uint8Array): ImageSize | null {
	if (bytes.length < 24 || fourcc(bytes, 12) !== 'IHDR') return null;
	return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** GIF: the logical screen descriptor follows the 6-byte signature. */
function gifSize(bytes: Uint8Array): ImageSize | null {
	if (bytes.length < 10) return null;
	return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/** WebP VP8 (lossy): 3-byte frame tag, start code 9d 01 2a, then 14-bit width and height (the top two bits are scale). */
function webpLossySize(bytes: Uint8Array): ImageSize | null {
	if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
		return null;
	}
	return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
}

/** WebP VP8L (lossless): signature byte 0x2f, then width-1 and height-1 as two 14-bit fields of one 32-bit word. */
function webpLosslessSize(bytes: Uint8Array): ImageSize | null {
	if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
	const word = u32le(bytes, 21);
	return { width: (word & 0x3fff) + 1, height: ((word >>> 14) & 0x3fff) + 1 };
}

/** WebP VP8X (extended): flags and 3 reserved bytes, then canvas width-1 and height-1 as 24-bit numbers. */
function webpExtendedSize(bytes: Uint8Array): ImageSize | null {
	if (bytes.length < 30) return null;
	return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
}

/** The reader of each WebP first chunk; any other chunk is "no size". */
const WEBP_CHUNK_READERS: ReadonlyMap<string, (bytes: Uint8Array) => ImageSize | null> = new Map([
	['VP8 ', webpLossySize],
	['VP8L', webpLosslessSize],
	['VP8X', webpExtendedSize],
]);

/** WebP: the first chunk after "RIFF....WEBP" is VP8 (lossy), VP8L (lossless) or VP8X (extended, the canvas). */
function webpSize(bytes: Uint8Array): ImageSize | null {
	return WEBP_CHUNK_READERS.get(fourcc(bytes, 12))?.(bytes) ?? null;
}

/** A JPEG start-of-frame marker (baseline, extended, progressive, lossless… but not DHT, JPG or DAC). */
function isStartOfFrame(marker: number): boolean {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** A marker with no length field: TEM, SOI and RST0-7. */
function isStandaloneMarker(marker: number): boolean {
	return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
}

/**
 * JPEG: walk the segments (each `FF marker length ...`, the length counting itself) to the
 * start-of-frame, which carries the precision, then height and width. A segment's bytes are
 * skipped by its length, so an embedded thumbnail inside an APP segment is never mistaken for
 * the frame. Reaching the scan, the end of the image or the end of the data without a frame is
 * "no size".
 */
function jpegSize(bytes: Uint8Array): ImageSize | null {
	let at = 2; // past SOI
	while (at + 4 <= bytes.length) {
		if (bytes[at] !== 0xff) return null;
		at = skipFillBytes(bytes, at);
		const step = jpegSegmentStep(bytes, bytes[at + 1] ?? 0, at + 2);
		if ('size' in step) return step.size;
		at = step.next;
	}
	return null;
}

/** EOI or SOS: the end of the image, or its scan, reached before any frame. */
function isEndBeforeFrame(marker: number): boolean {
	return marker === 0xd9 || marker === 0xda;
}

/** The position of the last `FF` of a run at `from`: fill bytes may pad before a marker. */
function skipFillBytes(bytes: Uint8Array, from: number): number {
	let at = from;
	while (bytes[at + 1] === 0xff && at + 2 < bytes.length) at++;
	return at;
}

/** What one JPEG segment tells the walk: the answer (`size`, null for "no size"), or where the next one starts. */
type JpegSegmentStep = { readonly size: ImageSize | null } | { readonly next: number };

/** The step for the segment of `marker`, `at` just past the marker (on its length field, if any). */
function jpegSegmentStep(bytes: Uint8Array, marker: number, at: number): JpegSegmentStep {
	if (isStandaloneMarker(marker)) return { next: at };
	if (isEndBeforeFrame(marker)) return { size: null };
	const length = u16be(bytes, at);
	if (length < 2) return { size: null };
	if (isStartOfFrame(marker)) return { size: jpegFrameSize(bytes, at, length) };
	return { next: at + length };
}

/** A start-of-frame segment's size (precision, then height and width), or null when it is cut short. */
function jpegFrameSize(bytes: Uint8Array, at: number, length: number): ImageSize | null {
	if (length < 8 || at + 7 > bytes.length) return null;
	return { width: u16be(bytes, at + 5), height: u16be(bytes, at + 3) };
}

const SIZE_READERS: ReadonlyMap<string, (bytes: Uint8Array) => ImageSize | null> = new Map([
	['image/png', pngSize],
	['image/jpeg', jpegSize],
	['image/gif', gifSize],
	['image/webp', webpSize],
]);

/**
 * The size the header of `bytes` declares, as the exact media type `contentType` reads it; null
 * when the type is none of the four, the header is cut short or malformed, or it declares an
 * empty image. Call it on bytes `bytesMatchMediaType` has accepted.
 */
export function declaredImageSize(bytes: Uint8Array, contentType: string): ImageSize | null {
	const size = SIZE_READERS.get(bareMediaType(contentType))?.(bytes) ?? null;
	return size !== null && size.width > 0 && size.height > 0 ? size : null;
}

/** True when `size` is within `RELAYED_IMAGE_LIMITS` on each side and in all. */
export function withinRelayedLimits(size: ImageSize): boolean {
	return (
		size.width <= RELAYED_IMAGE_LIMITS.maxSide &&
		size.height <= RELAYED_IMAGE_LIMITS.maxSide &&
		size.width * size.height <= RELAYED_IMAGE_LIMITS.maxPixels
	);
}
