/**
 * Gate: media capture-date reader (src/core/media/file_date.ts — PHP
 * tool_import_files::get_media_file_date + ImageMagick/Ffmpeg
 * get_date_time_original + the pdfinfo CreationDate branch).
 *
 * Two tiers, mirroring the media-engine posture:
 *  - PURE parser tests on CAPTURED tool outputs (no binary spawned) — these
 *    pin the PHP regex/constrain semantics, including the deliberate parity
 *    quirks (ISO 'T' blocks the ffprobe time-of-day; PDF stores y/m/d only);
 *  - LIVE end-to-end cases gated on the binary existing on this machine
 *    (test.if — a machine without identify/ffprobe/pdfinfo reports SKIP).
 *    Fixtures are GENERATED here (a hand-built EXIF APP1 spliced into an
 *    embedded 2x2 JPEG, a hand-written PDF with /CreationDate, an ffmpeg
 *    lavfi clip) — deterministic, no network, cleaned up in afterAll.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { resolveIdentify } from '../../src/core/media/engine/imagemagick.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import {
	addTimeToDateItem,
	ddDateToSeconds,
	getMediaFileDate,
	parseIdentifyDateModify,
	parseIdentifyDateTimeOriginal,
	parsePdfCreationDate,
	parseTimestampDdDate,
	withDedaloTime,
} from '../../src/core/media/file_date.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const FIXTURE_DIR = scratchDir('file_date');
mkdirSync(FIXTURE_DIR, { recursive: true });
afterAll(() => {
	rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// Binary availability (config-resolved paths, PHP MAGICK_PATH/FFPROBE twins).
const hasIdentify = existsSync(resolveIdentify()[0] as string);
const hasPdfinfo = existsSync(config.media.binaries.pdfinfo);
const hasFfmpegPair =
	existsSync(config.media.binaries.ffmpeg) && existsSync(config.media.binaries.ffprobe);

// ---------------------------------------------------------------------------
// Fixture builders (no binaries needed)
// ---------------------------------------------------------------------------

/** A valid 2x2 red JPEG (ImageMagick-generated once, embedded verbatim). */
const BASE_JPEG = Uint8Array.from(
	atob(
		'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI' +
			'CQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQ' +
			'EBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDAREA' +
			'AhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEB' +
			'AAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==',
	),
	(char) => char.charCodeAt(0),
);

/**
 * Splice a minimal EXIF APP1 segment (TIFF-LE, IFD0 → ExifIFD →
 * DateTimeOriginal 0x9003) after the JPEG SOI — a REAL EXIF date identify
 * reads back, with no EXIF-writing binary required.
 */
function jpegWithExifDate(dateString: string): Uint8Array {
	const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
	const value = `${dateString}\0`; // EXIF ASCII values are NUL-terminated
	const tiff: number[] = [
		0x49,
		0x49,
		0x2a,
		0x00, // 'II' little-endian TIFF
		0x08,
		0x00,
		0x00,
		0x00, // IFD0 at offset 8
		0x01,
		0x00, // IFD0: 1 entry
		0x69,
		0x87,
		0x04,
		0x00,
		0x01,
		0x00,
		0x00,
		0x00, // ExifIFDPointer (LONG x1)
		26,
		0x00,
		0x00,
		0x00, // → Exif IFD at offset 26
		0x00,
		0x00,
		0x00,
		0x00, // no next IFD
		0x01,
		0x00, // Exif IFD: 1 entry
		0x03,
		0x90,
		0x02,
		0x00,
		value.length,
		0x00,
		0x00,
		0x00, // DateTimeOriginal (ASCII)
		44,
		0x00,
		0x00,
		0x00, // value at offset 44
		0x00,
		0x00,
		0x00,
		0x00, // no next IFD
		...ascii(value),
	];
	const payload = [...ascii('Exif\0\0'), ...tiff];
	const app1 = [0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff];
	const out = new Uint8Array(2 + app1.length + payload.length + (BASE_JPEG.length - 2));
	out.set(BASE_JPEG.subarray(0, 2), 0); // SOI
	out.set(app1, 2);
	out.set(payload, 2 + app1.length);
	out.set(BASE_JPEG.subarray(2), 2 + app1.length + payload.length);
	return out;
}

/** A minimal one-page PDF whose Info dict carries the given /CreationDate. */
function pdfWithCreationDate(rawDate: string): string {
	return `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>
endobj
4 0 obj
<< /CreationDate (${rawDate}) >>
endobj
trailer
<< /Root 1 0 R /Info 4 0 R /Size 5 >>
%%EOF
`;
}

// ---------------------------------------------------------------------------
// Pure parsers on captured tool outputs (PHP regex parity)
// ---------------------------------------------------------------------------

describe('parseIdentifyDateTimeOriginal (EXIF %[EXIF:DateTimeOriginal])', () => {
	test('full EXIF timestamp', () => {
		expect(parseIdentifyDateTimeOriginal('2011:05:12 10:30:00')).toEqual({
			year: 2011,
			month: 5,
			day: 12,
			hour: 10,
			minute: 30,
			second: 0,
		});
	});
	test('date-only EXIF value keeps only the present fields (sparse dd_date)', () => {
		expect(parseIdentifyDateTimeOriginal('2011:05:12')).toEqual({ year: 2011, month: 5, day: 12 });
	});
	test('unparseable output → null (never a {time:0} junk date)', () => {
		expect(parseIdentifyDateTimeOriginal('n/a')).toBeNull();
		expect(parseIdentifyDateTimeOriginal('')).toBeNull();
	});
});

describe('parseIdentifyDateModify (%[date:modify] fallback)', () => {
	test('ISO output with UTC offset', () => {
		expect(parseIdentifyDateModify('2026-07-10T08:29:05+00:00')).toEqual({
			year: 2026,
			month: 7,
			day: 10,
			hour: 8,
			minute: 29,
			second: 5,
		});
	});
	test('fractional seconds land in ms (PHP set_ms of group 7)', () => {
		expect(parseIdentifyDateModify('2024-06-01T14:30:00.123+00:00')).toEqual({
			year: 2024,
			month: 6,
			day: 1,
			hour: 14,
			minute: 30,
			second: 0,
			ms: 123,
		});
	});
	test('non-ISO garbage → null', () => {
		expect(parseIdentifyDateModify('unknown')).toBeNull();
	});
});

describe('parseTimestampDdDate (ffprobe creation_time — dd_date::get_dd_date_from_timestamp)', () => {
	test("ISO 'T' separator yields DATE ONLY — PHP regex crosses to time over a SPACE (parity pin)", () => {
		expect(parseTimestampDdDate('2020-03-04T05:06:07.000000Z')).toEqual({
			year: 2020,
			month: 3,
			day: 4,
		});
	});
	test('space-separated timestamp yields the full six fields', () => {
		expect(parseTimestampDdDate('2024-06-01 14:30:00')).toEqual({
			year: 2024,
			month: 6,
			day: 1,
			hour: 14,
			minute: 30,
			second: 0,
		});
	});
	test('constrain=true drops out-of-range fields (PHP setter rejection)', () => {
		expect(parseTimestampDdDate('2024-13-45')).toEqual({ year: 2024 });
	});
	test('BCE years parse negative (dd_date supports them)', () => {
		expect(parseTimestampDdDate('-44-03-15')).toEqual({ year: -44, month: 3, day: 15 });
	});
});

describe('parsePdfCreationDate (pdfinfo -rawdates CreationDate line)', () => {
	test("PDF raw date D:YYYYMMDDHHmmss-hh'mm' → year/month/day ONLY (PHP groups 2-4)", () => {
		expect(parsePdfCreationDate("CreationDate:    D:20110816234339-04'00'")).toEqual({
			year: 2011,
			month: 8,
			day: 16,
		});
	});
	test('short forms: D:YYYYMMDD and bare D:YYYY', () => {
		expect(parsePdfCreationDate('CreationDate: D:20230101')).toEqual({
			year: 2023,
			month: 1,
			day: 1,
		});
		expect(parsePdfCreationDate('CreationDate: D:2023')).toEqual({ year: 2023 });
	});
	test('no date on the line → null', () => {
		expect(parsePdfCreationDate('CreationDate:')).toBeNull();
	});
});

describe('ddDateToSeconds / withDedaloTime (component_date::save add_time twin)', () => {
	test('matches the persisted sample values (virtual 372-day years, 31-day months)', () => {
		// component_date/samples/data.json: the stored start/end carry these times.
		expect(ddDateToSeconds({ year: 1999, month: 1, day: 1 })).toBe(64249459200);
		expect(ddDateToSeconds({ year: 2008, month: 9, day: 30 })).toBe(64562659200);
	});
	test('partial dates: absent fields contribute 0 (PHP null → 0, 1-based m/d)', () => {
		expect(ddDateToSeconds({ year: 2011 })).toBe(2011 * 372 * 86400);
		expect(ddDateToSeconds({ year: 2011, month: 8, day: 16 })).toBe(
			2011 * 372 * 86400 + 7 * 31 * 86400 + 15 * 86400,
		);
	});
	test('withDedaloTime stamps the computed time and preserves the fields', () => {
		expect(withDedaloTime({ year: 2011, month: 8, day: 16 })).toEqual({
			year: 2011,
			month: 8,
			day: 16,
			time: 2011 * 372 * 86400 + 7 * 31 * 86400 + 15 * 86400,
		});
	});
});

describe('addTimeToDateItem (component_date::save add_time — the interactive-save hook)', () => {
	const t = (d: {
		year?: number;
		month?: number;
		day?: number;
		hour?: number;
		minute?: number;
		second?: number;
	}) => ddDateToSeconds(d);

	test('start-only item: stamps start.time in place (the sort/search key)', () => {
		const item = { id: 1, start: { day: 1, year: 2025, month: 10 } };
		addTimeToDateItem(item);
		expect((item.start as { time?: number }).time).toBe(t({ year: 2025, month: 10, day: 1 }));
	});

	test('range item: stamps both start.time and end.time', () => {
		const item = { id: 1, start: { year: 2000 }, end: { year: 2010 } };
		addTimeToDateItem(item);
		expect((item.start as { time?: number }).time).toBe(t({ year: 2000 }));
		expect((item.end as { time?: number }).time).toBe(t({ year: 2010 }));
	});

	test('period item: stamps period.time', () => {
		const item = { id: 1, period: { year: 5 } };
		addTimeToDateItem(item);
		expect((item.period as { time?: number }).time).toBe(t({ year: 5 }));
	});

	test('bare time item (hour at root): stamps the item itself', () => {
		const item = { id: 1, hour: 10, minute: 30, second: 0 };
		addTimeToDateItem(item);
		expect((item as { time?: number }).time).toBe(t({ hour: 10, minute: 30 }));
	});

	test('always OVERRIDES a client-supplied time (never trusted)', () => {
		const item = { id: 1, start: { year: 2025, month: 10, day: 1, time: 999999 } };
		addTimeToDateItem(item);
		expect(item.start.time).toBe(t({ year: 2025, month: 10, day: 1 }));
	});

	test('unknown/empty shapes are left untouched', () => {
		const empty = { id: 1 };
		addTimeToDateItem(empty);
		expect(empty).toEqual({ id: 1 });
		addTimeToDateItem(null);
		addTimeToDateItem('x');
	});
});

// ---------------------------------------------------------------------------
// Live end-to-end (binary-gated; SKIP is visible when a tool is absent)
// ---------------------------------------------------------------------------

describe('getMediaFileDate live', () => {
	test('missing file and unknown model return null (skip-when-empty)', async () => {
		expect(await getMediaFileDate(join(FIXTURE_DIR, 'nope.jpg'), 'component_image')).toBeNull();
		const anyFile = join(FIXTURE_DIR, 'any.bin');
		writeFileSync(anyFile, 'x');
		expect(await getMediaFileDate(anyFile, 'component_3d')).toBeNull();
		expect(await getMediaFileDate('', 'component_image')).toBeNull();
	});

	test.if(hasIdentify)('component_image reads EXIF DateTimeOriginal', async () => {
		const file = join(FIXTURE_DIR, 'exif.jpg');
		writeFileSync(file, jpegWithExifDate('2011:05:12 10:30:00'));
		expect(await getMediaFileDate(file, 'component_image')).toEqual({
			year: 2011,
			month: 5,
			day: 12,
			hour: 10,
			minute: 30,
			second: 0,
		});
	});

	test.if(hasIdentify)('component_image falls back to %[date:modify] (file mtime)', async () => {
		const file = join(FIXTURE_DIR, 'noexif.jpg');
		writeFileSync(file, BASE_JPEG);
		// Midday UTC on the 15th: y/m/d are offset-proof however identify renders.
		const mtime = new Date(Date.UTC(2019, 5, 15, 12, 0, 0));
		utimesSync(file, mtime, mtime);
		const date = await getMediaFileDate(file, 'component_image');
		expect(date).toMatchObject({ year: 2019, month: 6, day: 15 });
	});

	test.if(hasPdfinfo)('component_pdf reads the Info /CreationDate (y/m/d only)', async () => {
		const file = join(FIXTURE_DIR, 'dated.pdf');
		writeFileSync(file, pdfWithCreationDate("D:20110816234339-04'00'"));
		expect(await getMediaFileDate(file, 'component_pdf')).toEqual({
			year: 2011,
			month: 8,
			day: 16,
		});
	});

	test.if(hasPdfinfo)('component_pdf with NO CreationDate → null', async () => {
		const file = join(FIXTURE_DIR, 'undated.pdf');
		writeFileSync(file, pdfWithCreationDate('').replace('/CreationDate ()', '/Producer (x)'));
		expect(await getMediaFileDate(file, 'component_pdf')).toBeNull();
	});

	test.if(hasFfmpegPair)(
		'component_av reads the container creation_time (date only — ISO T parity)',
		async () => {
			const file = join(FIXTURE_DIR, 'dated.mp4');
			const result = await runBinary(
				[
					config.media.binaries.ffmpeg,
					'-y',
					'-v',
					'error',
					'-f',
					'lavfi',
					'-i',
					'color=c=red:s=16x16:d=0.2',
					'-metadata',
					'creation_time=2020-03-04T05:06:07Z',
					'-pix_fmt',
					'yuv420p',
					file,
				],
				{ nice: false },
			);
			expect(result.exitCode).toBe(0);
			expect(await getMediaFileDate(file, 'component_av')).toEqual({
				year: 2020,
				month: 3,
				day: 4,
			});
		},
	);
});
