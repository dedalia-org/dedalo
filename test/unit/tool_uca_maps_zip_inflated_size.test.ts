/**
 * tool_uca_maps — `assertZipInflatesWithin`: what an uploaded shapefile zip
 * really inflates to, measured on the deflate streams themselves (pure, no
 * GDAL). Archives are built with the engine's own ZIP encoder; the hostile
 * ones are that output with header fields patched.
 */

import { describe, expect, test } from 'bun:test';
import { openZipStream, type ZipMethod } from '../../src/core/files/zip.ts';
import { assertZipInflatesWithin } from '../../tools/tool_uca_maps/server/zip_inflated_size.ts';
import { expectCode, failureOf } from './fixtures/tool_uca_maps/helpers.ts';

async function zipOf(
	entries: { name: string; bytes: Uint8Array; method?: ZipMethod }[],
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const writer = openZipStream({ write: async (chunk) => void chunks.push(chunk.slice()) });
	for (const entry of entries) {
		await writer.addEntry(entry.name, entry.bytes, { method: entry.method ?? 'deflate' });
	}
	await writer.finish();
	return new Uint8Array(Buffer.concat(chunks));
}

const zeros = (length: number) => new Uint8Array(length);

/** Offset of the first central-directory header (PK\x01\x02). */
function centralOffset(bytes: Uint8Array): number {
	for (let at = 0; at < bytes.length - 3; at++) {
		if (
			bytes[at] === 0x50 &&
			bytes[at + 1] === 0x4b &&
			bytes[at + 2] === 1 &&
			bytes[at + 3] === 2
		) {
			return at;
		}
	}
	throw new Error('no central directory header');
}

describe('tool_uca_maps assertZipInflatesWithin (pure)', () => {
	test('the inflated total of stored and deflated entries is measured, at and under the budget', async () => {
		const zip = await zipOf([
			{ name: 'a.shp', bytes: zeros(5000) },
			{ name: 'a.dbf', bytes: zeros(3000), method: 'store' },
		]);
		expect(await assertZipInflatesWithin(zip, 8000)).toBe(8000);
	});

	test('one byte over the budget, across entries, is refused', async () => {
		const zip = await zipOf([
			{ name: 'a.shp', bytes: zeros(5000) },
			{ name: 'a.dbf', bytes: zeros(3001) },
		]);
		const error = await failureOf(assertZipInflatesWithin(zip, 8000));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(/inflates to more than 8000 bytes/);
	});

	test('a central directory that understates the size does not hide the real inflation', async () => {
		const zip = await zipOf([{ name: 'bomb.dbf', bytes: zeros(1_000_000) }]);
		const view = new DataView(zip.buffer);
		view.setUint32(centralOffset(zip) + 24, 10, true);
		expectCode(await failureOf(assertZipInflatesWithin(zip, 100_000)), 'request.invalid_options');
	});

	test('entries sharing one compressed stream each count against the budget', async () => {
		const zip = await zipOf([
			{ name: 'a.shp', bytes: zeros(60_000) },
			{ name: 'b.shp', bytes: zeros(60_000) },
		]);
		const view = new DataView(zip.buffer);
		const first = centralOffset(zip);
		const second = first + 46 + view.getUint16(first + 28, true);
		view.setUint32(second + 42, view.getUint32(first + 42, true), true);
		view.setUint32(second + 20, view.getUint32(first + 20, true), true);
		await expect(assertZipInflatesWithin(zip, 100_000)).rejects.toThrow(/inflates to more than/);
	});

	test('what it cannot measure honestly is refused: not a zip, ZIP64, encrypted, other methods, corrupt data', async () => {
		expectCode(
			await failureOf(assertZipInflatesWithin(new TextEncoder().encode('not a zip'), 1000)),
			'request.invalid_options',
		);

		const patched = async (patch: (view: DataView, central: number) => void) => {
			const zip = await zipOf([{ name: 'a.shp', bytes: zeros(100) }]);
			patch(new DataView(zip.buffer), centralOffset(zip));
			return failureOf(assertZipInflatesWithin(zip, 1000));
		};
		expect((await patched((v, c) => v.setUint32(c + 20, 0xffffffff, true))).message).toMatch(
			/ZIP64/,
		);
		expect((await patched((v, c) => v.setUint16(c + 8, 1, true))).message).toMatch(/encrypted/);
		expect((await patched((v, c) => v.setUint16(c + 10, 12, true))).message).toMatch(/method 12/);
		expect((await patched((v, c) => v.setUint32(c + 42, 5, true))).message).toMatch(/corrupt/);

		const zip = await zipOf([{ name: 'a.shp', bytes: zeros(100) }]);
		const view = new DataView(zip.buffer);
		const data = view.getUint32(centralOffset(zip) + 42, true) + 30 + 'a.shp'.length;
		zip[data] = 0xff;
		zip[data + 1] = 0xff;
		expect((await failureOf(assertZipInflatesWithin(zip, 1000))).message).toMatch(/corrupt/);
	});
});
