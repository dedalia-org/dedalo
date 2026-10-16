/**
 * tool_uca_maps — `get_image_file`, where an image associated with a drawn
 * object is served from. It refuses a component that is not an image, and it
 * tells a vanished upload from one the browser cannot draw.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../src/config/config.ts';
import { toErrorBody } from '../../src/core/errors/convert.ts';
import { scanContextFromItem, scanFilesInfo } from '../../src/core/media/files_info.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { requireTestMediaRoot } from '../../src/core/media/test_media_root.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import { getImageFile } from '../../tools/tool_uca_maps/server/image_media.ts';
import { contextOf, failureOf } from './fixtures/tool_uca_maps/helpers.ts';

describe('get_image_file — refusals', () => {
	test('a component that is not an image is refused, not scanned', async () => {
		// test85 is a component_pdf of the generic test TLD: a media component,
		// so core's media context accepts it and the tool's own check is what
		// refuses. A public code: the reason is the user's to read
		await expect(
			getImageFile(contextOf({ section_tipo: 'test3', tipo: 'test85', section_id: 905101 })),
		).rejects.toMatchObject({
			code: 'tool.unsupported_target',
			publicMessage: 'Only an image component can be used here.',
		});
	});
});

describe('get_image_file — a vanished image is not an undisplayable one', () => {
	// test99 is the generic TLD's component_image; the files are planted in the
	// suite's MARKED media root at this id and removed after each case
	const OPTIONS = { section_tipo: 'test3', tipo: 'test99', section_id: 905103 };
	const ctx = contextOf(OPTIONS);

	/** The slot's files and stored items: a leftover would be blamed on the engine. */
	async function slotResidue(): Promise<string[]> {
		const { spec, identity, pathOpts, items } = await resolveMediaToolContext(OPTIONS);
		const files = scanFilesInfo(spec, identity, pathOpts, scanContextFromItem(items[0]))
			.filter((entry) => entry.file_exist)
			.map((entry) => String(entry.file_path));
		return items.length === 0 ? files : [...files, `${items.length} stored media item(s)`];
	}

	/** `larger` is the tier listed just above the default, so it is scanned first. */
	type Tier = 'original' | 'larger' | 'default';

	async function withFiles<T>(
		files: ReadonlyArray<{ quality: Tier; extension: string }>,
		body: (planted: string[]) => Promise<T>,
	): Promise<T> {
		requireTestMediaRoot(config.media.rootPath ?? '', 'tool_uca_maps_get_image_file.test');
		expect(await slotResidue(), 'residue in test3/test99/905103 before planting').toHaveLength(0);
		const { spec, identity, pathOpts } = await resolveMediaToolContext(OPTIONS);
		const tiers: Record<Tier, string | undefined> = {
			original: spec.originalQuality,
			larger: spec.qualities[spec.qualities.indexOf(spec.defaultQuality) - 1],
			default: spec.defaultQuality,
		};
		const planted = files.map(({ quality, extension }) =>
			buildMediaLocation(spec, identity, tiers[quality] ?? '', extension, pathOpts),
		);
		// the first directory each plant created, if any: removed in reverse order
		const created: Array<{ leaf: string; top: string | undefined }> = [];
		try {
			for (const location of planted) {
				const leaf = dirname(location.absolutePath);
				created.push({ leaf, top: mkdirSync(leaf, { recursive: true }) });
				writeFileSync(location.absolutePath, 'planted by a gate');
			}
			return await body(planted.map((location) => location.relativePath));
		} finally {
			for (const location of planted) rmSync(location.absolutePath, { force: true });
			for (const { leaf, top } of created.reverse()) {
				for (let dir = leaf; top !== undefined; dir = dirname(dir)) {
					rmdirSync(dir);
					if (dir === top) break;
				}
			}
			expect(await slotResidue(), 'residue in test3/test99/905103 after the test').toHaveLength(0);
		}
	}

	async function refusalOf(): Promise<unknown> {
		return failureOf(getImageFile(ctx));
	}

	test('no file at all is media.file_not_found, its reason on the wire', async () => {
		const refusal = await withFiles([], refusalOf);
		expect(refusal).toMatchObject({ code: 'media.file_not_found' });
		expect(toErrorBody(refusal as Parameters<typeof toErrorBody>[0]).message).toBe(
			'The image is no longer on the server.',
		);
	});

	test('a master the browser cannot draw, and nothing else, is tool.unsupported_target', async () => {
		const refusal = await withFiles([{ quality: 'original', extension: 'tif' }], refusalOf);
		expect(refusal).toMatchObject({ code: 'tool.unsupported_target' });
		expect(toErrorBody(refusal as Parameters<typeof toErrorBody>[0]).message).toBe(
			'The uploaded image has no version this browser can display.',
		);
	});

	test('control: beside that master, the default tier is served before any other drawable one', async () => {
		const response = await withFiles(
			[
				{ quality: 'original', extension: 'tif' },
				{ quality: 'larger', extension: 'jpg' },
				{ quality: 'default', extension: 'jpg' },
			],
			async (planted) => ({ planted, response: await getImageFile(ctx) }),
		);
		expect(response.response).toMatchObject({
			ok: true,
			data: { file_path: response.planted[2], quality: config.media.image.defaultQuality },
		});
	});
});
