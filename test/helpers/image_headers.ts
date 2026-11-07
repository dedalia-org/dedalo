/**
 * Minimal image files that carry a real HEADER — the signature and the size field of each of
 * the four types the map tile proxy relays — for the gates of `geo/tile_proxy/image_bytes.ts`
 * and the route (`map_tile_proxy_native`, `map_tile_geometry_native`).
 *
 * They are not decodable pictures (the body is zeros) and need not be: the proxy reads the
 * signature and the declared size, never the pixels. Each builder pads with zeros up to
 * `total` bytes when it is larger than the header, so a gate can ask for a body of a given
 * weight (the byte ceiling, the memory's per-entry ceiling).
 */

function padded(header: number[], total: number): Uint8Array {
	const bytes = new Uint8Array(Math.max(total, header.length));
	bytes.set(header);
	return bytes;
}

const be32 = (value: number): number[] => [
	(value >>> 24) & 0xff,
	(value >>> 16) & 0xff,
	(value >>> 8) & 0xff,
	value & 0xff,
];
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le24 = (value: number): number[] => [
	value & 0xff,
	(value >>> 8) & 0xff,
	(value >>> 16) & 0xff,
];
const le32 = (value: number): number[] => [...le24(value), (value >>> 24) & 0xff];
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** PNG: signature, IHDR (width, height, 8-bit RGBA), a zero CRC. */
export function pngHeader(width: number, height: number, total = 0): Uint8Array {
	return padded(
		[
			0x89,
			0x50,
			0x4e,
			0x47,
			0x0d,
			0x0a,
			0x1a,
			0x0a,
			...be32(13),
			...ascii('IHDR'),
			...be32(width),
			...be32(height),
			8,
			6,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
		],
		total,
	);
}

/** JPEG: SOI, a JFIF APP0 segment, a baseline SOF0 frame header (height, then width). */
export function jpegHeader(width: number, height: number, total = 0): Uint8Array {
	const app0 = [0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
	const sof0 = [
		0xff,
		0xc0,
		0x00,
		0x11,
		8,
		(height >>> 8) & 0xff,
		height & 0xff,
		(width >>> 8) & 0xff,
		width & 0xff,
		3,
		1,
		0x22,
		0,
		2,
		0x11,
		1,
		3,
		0x11,
		1,
	];
	return padded([0xff, 0xd8, ...app0, ...sof0], total);
}

/** GIF89a: the logical screen descriptor (width, height, no colour table). */
export function gifHeader(width: number, height: number, total = 0): Uint8Array {
	return padded([...ascii('GIF89a'), ...le16(width), ...le16(height), 0, 0, 0], total);
}

export type WebpKind = 'VP8 ' | 'VP8L' | 'VP8X';

/** WebP: RIFF container whose first chunk is lossy (`VP8 `), lossless (`VP8L`) or extended (`VP8X`). */
export function webpHeader(kind: WebpKind, width: number, height: number, total = 0): Uint8Array {
	let chunk: number[];
	if (kind === 'VP8 ') {
		chunk = [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)];
	} else if (kind === 'VP8L') {
		chunk = [0x2f, ...le32(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14))];
	} else {
		chunk = [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
	}
	return padded(
		[
			...ascii('RIFF'),
			...le32(4 + 8 + chunk.length),
			...ascii('WEBP'),
			...ascii(kind),
			...le32(chunk.length),
			...chunk,
		],
		total,
	);
}
