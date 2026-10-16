/**
 * A minimal PDF 1.4 writer: wrapped text in the standard-14 Helvetica faces (no
 * font embedded; the price is WinAnsi) and JPEGs embedded untouched as `/DCTDecode`.
 * v6 loads `html2pdf` from a CDN (`special_tools.js` `create_pdf`), which this
 * app's `script-src 'self'` blocks.
 */

/** Standard-14 Helvetica advance widths, in 1/1000 em, for the ASCII range —
 * enough to wrap a line honestly. Anything outside it is assumed 556, the
 * width of the letters that dominate Western-European accented text. */
const HELVETICA_WIDTHS: Readonly<Record<number, number>> = Object.freeze({
	32: 278,
	33: 278,
	34: 355,
	35: 556,
	36: 556,
	37: 889,
	38: 667,
	39: 191,
	40: 333,
	41: 333,
	42: 389,
	43: 584,
	44: 278,
	45: 333,
	46: 278,
	47: 278,
	48: 556,
	49: 556,
	50: 556,
	51: 556,
	52: 556,
	53: 556,
	54: 556,
	55: 556,
	56: 556,
	57: 556,
	58: 278,
	59: 278,
	60: 584,
	61: 584,
	62: 584,
	63: 556,
	64: 1015,
	65: 667,
	66: 667,
	67: 722,
	68: 722,
	69: 667,
	70: 611,
	71: 778,
	72: 722,
	73: 278,
	74: 500,
	75: 667,
	76: 556,
	77: 833,
	78: 722,
	79: 778,
	80: 667,
	81: 778,
	82: 722,
	83: 667,
	84: 611,
	85: 722,
	86: 667,
	87: 944,
	88: 667,
	89: 667,
	90: 611,
	91: 278,
	92: 278,
	93: 278,
	94: 469,
	95: 556,
	96: 333,
	97: 556,
	98: 556,
	99: 500,
	100: 556,
	101: 556,
	102: 278,
	103: 556,
	104: 556,
	105: 222,
	106: 222,
	107: 500,
	108: 222,
	109: 833,
	110: 556,
	111: 556,
	112: 556,
	113: 556,
	114: 333,
	115: 500,
	116: 278,
	117: 556,
	118: 500,
	119: 722,
	120: 500,
	121: 500,
	122: 500,
	123: 334,
	124: 260,
	125: 334,
	126: 584,
});

const DEFAULT_WIDTH = 556;

/** Bold is wider; one flat factor rather than a second 95-entry table — this
 * is used to decide where a line wraps, not to typeset a book. */
const BOLD_FACTOR = 1.08;

/**
 * The cp1252-only codepoints that are NOT their own byte in Latin-1 (every other
 * codepoint up to 0xFF already is its byte). Also read by `roman_empire.ts` to
 * undo DARE's cp1252 mojibake.
 */
export const WIN_ANSI_HIGH: ReadonlyMap<number, number> = new Map([
	[0x20ac, 0x80],
	[0x201a, 0x82],
	[0x0192, 0x83],
	[0x201e, 0x84],
	[0x2026, 0x85],
	[0x2020, 0x86],
	[0x2021, 0x87],
	[0x02c6, 0x88],
	[0x2030, 0x89],
	[0x0160, 0x8a],
	[0x2039, 0x8b],
	[0x0152, 0x8c],
	[0x017d, 0x8e],
	[0x2018, 0x91],
	[0x2019, 0x92],
	[0x201c, 0x93],
	[0x201d, 0x94],
	[0x2022, 0x95],
	[0x2013, 0x96],
	[0x2014, 0x97],
	[0x02dc, 0x98],
	[0x2122, 0x99],
	[0x0161, 0x9a],
	[0x203a, 0x9b],
	[0x0153, 0x9c],
	[0x017e, 0x9e],
	[0x0178, 0x9f],
]);

/**
 * Text → WinAnsi bytes. A codepoint the encoding cannot express becomes '?':
 * a record may hold Greek, Arabic or Chinese, and the reader must see that the
 * report could not show it rather than lose it silently.
 */
export function encodeWinAnsi(text: string): Uint8Array {
	const bytes: number[] = [];
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0x3f;
		if (code >= 0x20 && code <= 0x7e) {
			bytes.push(code);
		} else if (WIN_ANSI_HIGH.has(code)) {
			bytes.push(WIN_ANSI_HIGH.get(code) as number);
		} else if (code >= 0xa0 && code <= 0xff) {
			bytes.push(code);
		} else {
			bytes.push(0x3f);
		}
	}
	return Uint8Array.from(bytes);
}

/**
 * A string of byte values (0-255) → those bytes. Never a TextEncoder: UTF-8
 * would write every WinAnsi byte above 0x7F as two, corrupting accents and
 * desynchronising every stream `/Length`.
 */
function latin1Bytes(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length);
	for (let index = 0; index < text.length; index++) {
		bytes[index] = text.charCodeAt(index) & 0xff;
	}
	return bytes;
}

/** A PDF literal string: the three characters that would otherwise end it or
 * start an escape. Applied to the ENCODED bytes, never to the source text. */
function escapeLiteral(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) {
		if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
			out += `\\${String.fromCharCode(byte)}`;
		} else {
			out += String.fromCharCode(byte);
		}
	}
	return out;
}

/** How wide `text` is at `size`, in points. */
export function textWidth(text: string, size: number, bold: boolean): number {
	let thousandths = 0;
	for (const byte of encodeWinAnsi(text)) {
		thousandths += HELVETICA_WIDTHS[byte] ?? DEFAULT_WIDTH;
	}
	const width = (thousandths / 1000) * size;
	return bold ? width * BOLD_FACTOR : width;
}

/**
 * A word wider than the line, cut in one pass (a geometry's coordinates are one
 * word of megabytes, and re-measuring the rest per cut is cubic). It cuts after
 * the last "]," that fits, between coordinate pairs as v6's PDF does, and
 * mid-word only when a piece has none.
 */
function splitOverlongWord(word: string, size: number, bold: boolean, maxWidth: number): string[] {
	const chars = Array.from(word);
	const bytes = encodeWinAnsi(word); // one byte per code point
	const scale = (size / 1000) * (bold ? BOLD_FACTOR : 1);
	const widthAt = (index: number) =>
		(HELVETICA_WIDTHS[bytes[index] ?? 0x3f] ?? DEFAULT_WIDTH) * scale;
	const pieces: string[] = [];
	let start = 0;
	let width = 0;
	let lastBreak = -1;
	for (let index = 0; index < chars.length; index++) {
		const charWidth = widthAt(index);
		if (width + charWidth > maxWidth && index > start) {
			const cut = lastBreak > start ? lastBreak : index;
			pieces.push(chars.slice(start, cut).join(''));
			start = cut;
			lastBreak = -1;
			width = 0;
			for (let carried = start; carried < index; carried++) width += widthAt(carried);
		}
		width += charWidth;
		if (chars[index] === ',' && chars[index - 1] === ']') lastBreak = index + 1;
	}
	pieces.push(chars.slice(start).join(''));
	return pieces;
}

/**
 * Greedy word wrap. A single word longer than the line (a coordinate array, a
 * URL) is broken rather than allowed to run off the page — losing the tail of
 * a coordinate silently is worse than an ugly break.
 */
export function wrapText(text: string, size: number, bold: boolean, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split('\n')) {
		let line = '';
		for (const word of paragraph.split(/\s+/).filter((part) => part !== '')) {
			const candidate = line === '' ? word : `${line} ${word}`;
			if (textWidth(candidate, size, bold) <= maxWidth) {
				line = candidate;
				continue;
			}
			if (line !== '') {
				lines.push(line);
			}
			const pieces = splitOverlongWord(word, size, bold, maxWidth);
			lines.push(...pieces.slice(0, -1));
			line = pieces[pieces.length - 1] ?? '';
		}
		lines.push(line);
	}
	return lines;
}

/** A JPEG, described well enough to become a PDF image XObject. */
export interface JpegInfo {
	width: number;
	height: number;
	/** 1 = grayscale, 3 = RGB. CMYK (4) is refused — see `readJpegInfo`. */
	components: number;
}

/**
 * A JPEG's frame header, found by walking the marker segments (EXIF, ICC and
 * comment segments of varying size precede it). Null for anything this writer
 * cannot embed, CMYK included: readers invert its colours without an Adobe
 * APP14 transform this writer does not interpret.
 */
export function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		return null;
	}
	let offset = 2;
	while (offset + 3 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1] as number;
		// standalone markers carry no length
		if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
		// SOF0/1/2/3 and the arithmetic-coded variants; SOF4 (0xc4) is the
		// Huffman table, 0xc8/0xcc are not frames either
		const isFrame =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isFrame) {
			if (offset + 9 >= bytes.length) return null;
			const height = ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number);
			const width = ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number);
			const components = bytes[offset + 9] as number;
			if (width <= 0 || height <= 0) return null;
			if (components !== 1 && components !== 3) return null;
			return { width, height, components };
		}
		if (length < 2) return null;
		offset += 2 + length;
	}
	return null;
}

/** One image placed on a page, in PDF user space (origin bottom-left). */
interface PlacedImage {
	name: string;
	/** position in the document's image list, which fixes its object number */
	index: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PageContent {
	/** already-built content-stream operators */
	operators: string[];
	images: PlacedImage[];
}

/** An image the document embeds once and may place on any page. */
interface EmbeddedImage {
	bytes: Uint8Array;
	info: JpegInfo;
}

const PAGE_WIDTH = 595; // A4, points
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/** One stream object; `entries` are the dictionary keys before its `/Length`. */
function streamObject(id: number, entries: string, bytes: Uint8Array): Uint8Array {
	const dictionary =
		entries === '' ? `/Length ${bytes.length}` : `${entries} /Length ${bytes.length}`;
	const header = latin1Bytes(`${id} 0 obj\n<< ${dictionary} >>\nstream\n`);
	const footer = latin1Bytes('\nendstream\nendobj\n');
	const body = new Uint8Array(header.length + bytes.length + footer.length);
	body.set(header, 0);
	body.set(bytes, header.length);
	body.set(footer, header.length + bytes.length);
	return body;
}

/**
 * A flowing, paginated document. Callers add text and images in order; the
 * builder breaks pages when the cursor runs out of room.
 */
export class PdfDocument {
	private pages: PageContent[] = [];
	private current!: PageContent;
	private cursorY!: number;
	private images: EmbeddedImage[] = [];

	constructor() {
		this.newPage();
	}

	private newPage(): void {
		this.current = { operators: [], images: [] };
		this.pages.push(this.current);
		this.cursorY = PAGE_HEIGHT - MARGIN;
	}

	/** Reserve `height` points, starting a page when they do not fit. */
	private reserve(height: number): number {
		if (this.cursorY - height < MARGIN) {
			this.newPage();
		}
		this.cursorY -= height;
		return this.cursorY;
	}

	/** One block of text, wrapped, at the given size/weight. */
	text(value: string, options: { size?: number; bold?: boolean; gap?: number } = {}): void {
		const size = options.size ?? 10;
		const bold = options.bold === true;
		const leading = size * 1.35;
		for (const line of wrapText(value, size, bold, CONTENT_WIDTH)) {
			const y = this.reserve(leading);
			if (line === '') continue;
			const font = bold ? '/F2' : '/F1';
			this.current.operators.push(
				`BT ${font} ${size} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escapeLiteral(
					encodeWinAnsi(line),
				)}) Tj ET`,
			);
		}
		if (options.gap) {
			this.reserve(options.gap);
		}
	}

	/** A full-width horizontal rule. */
	rule(): void {
		const y = this.reserve(8);
		this.current.operators.push(
			`0.6 w 0.5 G ${MARGIN} ${y.toFixed(2)} m ${PAGE_WIDTH - MARGIN} ${y.toFixed(2)} l S`,
		);
	}

	/**
	 * Embeds a JPEG and places it at the content width (never upscaled past
	 * it), preserving its aspect ratio. Returns false when the bytes are not
	 * an embeddable JPEG, so the caller can say so in the document instead of
	 * producing a silently shorter one.
	 */
	image(bytes: Uint8Array, maxHeight = 320): boolean {
		const info = readJpegInfo(bytes);
		if (info === null) {
			return false;
		}
		const index = this.images.length;
		const name = `Im${index + 1}`;
		this.images.push({ bytes, info });

		let width = Math.min(CONTENT_WIDTH, info.width);
		let height = (width / info.width) * info.height;
		if (height > maxHeight) {
			height = maxHeight;
			width = (height / info.height) * info.width;
		}
		const y = this.reserve(height + 6);
		this.current.images.push({ name, index, x: MARGIN, y, width, height });
		return true;
	}

	/** The finished file. */
	build(): Uint8Array {
		// object numbers: 1 catalog, 2 pages, 3 F1, 4 F2, then per-image
		// XObjects, then per-page (page + content stream)
		const imageBase = 5;
		const pageBase = imageBase + this.images.length;
		const pageIds = this.pages.map((_page, index) => pageBase + index * 2);
		const objects: Uint8Array[] = [];
		const pushText = (body: string): void => {
			objects.push(latin1Bytes(body));
		};

		pushText(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
		pushText(
			`2 0 obj\n<< /Type /Pages /Count ${this.pages.length} /Kids [${pageIds
				.map((id) => `${id} 0 R`)
				.join(' ')}] >>\nendobj\n`,
		);
		pushText(
			`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
		);
		pushText(
			`4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n`,
		);

		this.images.forEach((image, index) => {
			const colorSpace = image.info.components === 1 ? '/DeviceGray' : '/DeviceRGB';
			objects.push(
				streamObject(
					imageBase + index,
					`/Type /XObject /Subtype /Image /Width ${image.info.width} /Height ${image.info.height} ` +
						`/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode`,
					image.bytes,
				),
			);
		});

		this.pages.forEach((page, index) => {
			const pageId = pageBase + index * 2;
			const contentId = pageId + 1;
			// the leading slash is load-bearing: a dictionary key is a NAME object,
			// and without it readers silently drop every image on the page
			const xobjects = page.images
				.map((placed) => `/${placed.name} ${imageBase + placed.index} 0 R`)
				.join(' ');
			pushText(
				`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
					`/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${
						xobjects === '' ? '' : ` /XObject << ${xobjects} >>`
					} >> /Contents ${contentId} 0 R >>\nendobj\n`,
			);

			const drawn = page.images.map(
				(placed) =>
					`q ${placed.width.toFixed(2)} 0 0 ${placed.height.toFixed(2)} ${placed.x.toFixed(
						2,
					)} ${placed.y.toFixed(2)} cm /${placed.name} Do Q`,
			);
			objects.push(
				streamObject(contentId, '', latin1Bytes([...page.operators, ...drawn].join('\n'))),
			);
		});

		// the cross-reference table holds every object's byte offset: without it
		// the file does not open. The binary comment on line 2 marks the file as
		// non-text to anything that transfers it (PDF 32000-1 §7.5.2)
		const head = latin1Bytes('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
		const chunks: Uint8Array[] = [head];
		const offsets: number[] = [];
		let position = head.length;
		for (const body of objects) {
			offsets.push(position);
			chunks.push(body);
			position += body.length;
		}

		const count = objects.length + 1;
		let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
		for (const offset of offsets) {
			xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
		}
		xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`;
		chunks.push(latin1Bytes(xref));

		const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const out = new Uint8Array(total);
		let at = 0;
		for (const chunk of chunks) {
			out.set(chunk, at);
			at += chunk.length;
		}
		return out;
	}
}
