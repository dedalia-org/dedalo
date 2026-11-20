/**
 * tool_uca_maps — `get_image_file`, where an image associated with a drawn
 * object is served from. It refuses a component that is not an image, and it
 * tells a vanished upload from one the browser cannot draw.
 */

import { describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { toErrorBody } from '../../src/core/errors/convert.ts';
import { getImageFile } from '../../tools/tool_uca_maps/server/image_media.ts';
import { contextOf, failureOf } from './fixtures/tool_uca_maps/helpers.ts';
import { withImageFiles } from './fixtures/tool_uca_maps/image_slot.ts';

describe('get_image_file — refusals', () => {
	test('a component that is not an image is refused, not scanned', async () => {
		// test85 is a component_pdf of the generic test TLD: a media component,
		// so core's media context accepts it and the tool's own check is what
		// refuses. The tool's own client always names the image component, so no
		// user reason: the code goes bare
		const refusal = await failureOf(
			getImageFile(contextOf({ section_tipo: 'test3', tipo: 'test85', section_id: 905101 })),
		);
		expect(refusal).toMatchObject({ code: 'tool.unsupported_target' });
		expect((refusal as { details?: unknown }).details).toBeUndefined();
	});
});

describe('get_image_file — a vanished image is not an undisplayable one', () => {
	// the files are planted at this id and removed after each case
	const OPTIONS = { section_tipo: 'test3', tipo: 'test99', section_id: 905103 };
	const ctx = contextOf(OPTIONS);

	const withFiles = <T>(
		files: Parameters<typeof withImageFiles>[1],
		body: (planted: string[]) => Promise<T>,
	) => withImageFiles(OPTIONS, files, body);

	async function refusalOf(): Promise<unknown> {
		return failureOf(getImageFile(ctx));
	}

	test('no file at all is resource.not_found, keyed for the browser', async () => {
		const refusal = await withFiles([], refusalOf);
		expect(refusal).toMatchObject({
			code: 'resource.not_found',
			details: { reason_key: 'image_not_on_server' },
		});
		expect(toErrorBody(refusal as Parameters<typeof toErrorBody>[0]).details).toEqual({
			reason_key: 'image_not_on_server',
		});
	});

	test('a master the browser cannot draw, and nothing else, is tool.unsupported_target', async () => {
		const refusal = await withFiles([{ quality: 'original', extension: 'tif' }], refusalOf);
		expect(refusal).toMatchObject({
			code: 'tool.unsupported_target',
			details: { reason_key: 'image_not_displayable' },
		});
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
