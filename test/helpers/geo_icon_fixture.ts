/**
 * Raster icon fixtures for the geolocation legend gates: byte strings whose
 * HEADERS are real (the signature, and the width and height the format states
 * where src/core/geo/icon_image.ts reads them) and whose bodies are zero padding.
 * They are not decodable images — nothing here is decoded — but they are what a
 * size check sees, which is exactly the thing under test: a header can declare a
 * gigabyte of bitmap in a few dozen bytes.
 *
 * `total` pads the payload to that many bytes (never below the header), so a test
 * can build an icon of a chosen size in characters.
 */

import type { RasterFormat } from '../../src/core/geo/icon_image.ts';

function padded(head: number[], total: number): Uint8Array {
	const bytes = new Uint8Array(Math.max(total, head.length));
	bytes.set(head);
	return bytes;
}

const u32be = (value: number): number[] => [
	(value >>> 24) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 8) & 0xff,
	value & 0xff,
];
const u16be = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff];
const u16le = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const u24le = (value: number): number[] => [
	value & 0xff,
	(value >>> 8) & 0xff,
	(value >>> 16) & 0xff,
];
const u32le = (value: number): number[] => [
	value & 0xff,
	(value >>> 8) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 24) & 0xff,
];
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** A PNG: signature, then an IHDR chunk declaring `width` x `height` (33 bytes of header). */
export function pngBytes(width: number, height: number, total = 0): Uint8Array {
	return padded(
		[
			...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			...u32be(13),
			...ascii('IHDR'),
			...u32be(width),
			...u32be(height),
			...[8, 0, 0, 0, 0], // depth, colour type, compression, filter, interlace
			...[0, 0, 0, 0], // crc (not checked)
		],
		total,
	);
}

/**
 * A JPEG: SOI, a JFIF APP0, then `appBytes` of APP1 metadata (an EXIF block, a
 * profile — a JPEG states its size AFTER these), then a SOF0 declaring `width` x
 * `height`.
 */
export function jpegBytes(width: number, height: number, total = 0, appBytes = 0): Uint8Array {
	const app0 = [0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
	const app1 =
		appBytes > 0 ? [0xff, 0xe1, ...u16be(appBytes + 2), ...new Array(appBytes).fill(0)] : [];
	const sof0 = [0xff, 0xc0, ...u16be(11), 8, ...u16be(height), ...u16be(width), 1, 1, 0x11, 0];
	return padded([0xff, 0xd8, ...app0, ...app1, ...sof0], total);
}

export type WebpKind = 'lossy' | 'lossless' | 'extended';

/** A WebP of the given chunk kind, declaring `width` x `height`. */
export function webpBytes(kind: WebpKind, width: number, height: number, total = 0): Uint8Array {
	const riff = [...ascii('RIFF'), ...u32le(0), ...ascii('WEBP')];
	if (kind === 'lossy') {
		const frame = [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
		return padded([...riff, ...ascii('VP8 '), ...u32le(frame.length), ...frame], total);
	}
	if (kind === 'lossless') {
		const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
		return padded([...riff, ...ascii('VP8L'), ...u32le(5), 0x2f, ...u32le(bits >>> 0)], total);
	}
	const flags = [0, 0, 0, 0];
	return padded(
		[...riff, ...ascii('VP8X'), ...u32le(10), ...flags, ...u24le(width - 1), ...u24le(height - 1)],
		total,
	);
}

/** `bytes` as the data URI a legend carries, declared as `format`. */
export function dataUri(format: RasterFormat, bytes: Uint8Array): string {
	return `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** A png data URI declaring `width` x `height`, `bytes` long. */
export function pngUri(width: number, height: number, bytes = 0): string {
	return dataUri('png', pngBytes(width, height, bytes));
}

/** A jpeg data URI declaring `width` x `height`, `bytes` long. */
export function jpegUri(width: number, height: number, bytes = 0, appBytes = 0): string {
	return dataUri('jpeg', jpegBytes(width, height, bytes, appBytes));
}

/** A webp data URI of `kind` declaring `width` x `height`, `bytes` long. */
export function webpUri(kind: WebpKind, width: number, height: number, bytes = 0): string {
	return dataUri('webp', webpBytes(kind, width, height, bytes));
}
