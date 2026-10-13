/**
 * tool_uca_maps — `get_image_file` (fila #3: where an image associated with a
 * drawn object is served from).
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1) — and note WHICH
 *    record it names: the IMAGE component's (rsc29/rsc170), not the map's, so
 *    the check asks whether the caller may read the thing whose media path
 *    the answer discloses;
 *  - that the action REFUSES a component that is not an image, rather than
 *    scanning whatever files happen to sit under some other model's record;
 *  - that `image_overlay.ts` and this action resolve the SAME tier, because
 *    they are now literally the same function — the regression this replaces
 *    is the two drifting apart and a map overlay and a gallery thumbnail
 *    showing different versions of one upload.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../src/config/config.ts';
import { toErrorBody } from '../../src/core/errors/convert.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { requireTestMediaRoot } from '../../src/core/media/test_media_root.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import { getImageFile, OVERLAY_EXTENSIONS } from '../../tools/tool_uca_maps/server/image_media.ts';
import { mustGet } from '../helpers/assert.ts';

async function loadAction(name: string): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	return mustGet(loaded?.module.apiActions[name], name) as GatedToolActionSpec;
}

describe('tool_uca_maps get_image_file — declared gate', () => {
	test('is record_tipo at read level (1)', async () => {
		const action = await loadAction('get_image_file');
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});

	test('carries the same gate as get_image_overlay — both disclose a media path', async () => {
		const file = await loadAction('get_image_file');
		const overlay = await loadAction('get_image_overlay');
		expect(file.permission).toBe(overlay.permission);
		expect(file.minLevel).toBe(overlay.minLevel);
	});

	test('the registered handler is the module function, not a wrapper that could skip it', async () => {
		const action = await loadAction('get_image_file');
		expect(action.handler).toBe(getImageFile);
	});
});

describe('the served-tier contract', () => {
	test('only browser-renderable extensions are candidates — a master .tif never is', () => {
		expect(OVERLAY_EXTENSIONS).toContain('jpg');
		expect(OVERLAY_EXTENSIONS).toContain('png');
		expect(OVERLAY_EXTENSIONS).not.toContain('tif');
		expect(OVERLAY_EXTENSIONS).not.toContain('tiff');
		expect(OVERLAY_EXTENSIONS).not.toContain('psd');
	});
});

describe('get_image_file — refusals', () => {
	test('a component that is not an image is refused, not scanned', async () => {
		// test85 is a component_pdf of the generic test TLD: a media component,
		// so core's media context accepts it and the tool's own check is what
		// refuses. A public code: the reason is the user's to read
		await expect(
			getImageFile({
				principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
				userId: -1,
				options: { section_tipo: 'test3', tipo: 'test85', section_id: 905101 },
				background: false,
			}),
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
	const ctx: ToolActionContext = {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: OPTIONS,
		background: false,
	};

	async function withFiles<T>(
		files: ReadonlyArray<{ quality: 'original' | 'default'; extension: string }>,
		body: (planted: string[]) => Promise<T>,
	): Promise<T> {
		requireTestMediaRoot(config.media.rootPath ?? '', 'tool_uca_maps_get_image_file.test');
		const { spec, identity, pathOpts } = await resolveMediaToolContext(OPTIONS);
		const planted = files.map(({ quality, extension }) => {
			const tier = quality === 'original' ? spec.originalQuality : spec.defaultQuality;
			return buildMediaLocation(spec, identity, tier, extension, pathOpts);
		});
		try {
			for (const location of planted) {
				mkdirSync(dirname(location.absolutePath), { recursive: true });
				writeFileSync(location.absolutePath, 'planted by a gate');
			}
			return await body(planted.map((location) => location.relativePath));
		} finally {
			for (const location of planted) rmSync(location.absolutePath, { force: true });
		}
	}

	async function refusalOf(): Promise<unknown> {
		return getImageFile(ctx).then(
			() => null,
			(error: unknown) => error,
		);
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

	test('control: with a drawable tier beside that master, the drawable one is served', async () => {
		const response = await withFiles(
			[
				{ quality: 'original', extension: 'tif' },
				{ quality: 'default', extension: 'jpg' },
			],
			async (planted) => ({ planted, response: await getImageFile(ctx) }),
		);
		expect(response.response).toMatchObject({
			ok: true,
			data: { file_path: response.planted[1], quality: config.media.image.defaultQuality },
		});
	});
});
