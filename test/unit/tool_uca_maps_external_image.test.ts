/**
 * tool_uca_maps — `stage_external_image` against a scripted site (`HarvestDeps.hop`,
 * our clock): the switch, the host policy and ceiling handed to the door, what a
 * refusal becomes, and the staged file the ingest reads back. The door itself is
 * harvest_door_native.test.ts's.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HarvestDeps } from '../../src/core/harvest/harvest.ts';
import { clearPacingForTests } from '../../src/core/harvest/pacing.ts';
import { clearRobotsCache } from '../../src/core/harvest/robots.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { STAGED_NAME_DIR } from '../../src/core/media/ingest/staged_name_record.ts';
import type { PinnedHopRequest, PinnedHopResponse } from '../../src/core/security/ssrf_guard.ts';
import {
	EXTERNAL_IMAGE_MAX_BYTES,
	EXTERNAL_IMAGES_CONFIG_KEY,
	externalImagesOn,
	stagedFileName,
	stageExternalImage,
} from '../../tools/tool_uca_maps/server/external_image.ts';
import { contextOf, dataOf, failureOf } from './fixtures/tool_uca_maps/helpers.ts';

/** A 1×1 PNG: real bytes, so the receiver's sniff and structural check pass. */
const ONE_PIXEL_PNG = new Uint8Array(
	Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64',
	),
);

const USER_ID = -1;
const IMAGE = 'https://images.example/collection/Muro%20norte.png';

interface Scripted {
	status: number;
	type?: string;
	body?: string | Uint8Array;
}

interface ScriptedSite {
	deps: HarvestDeps;
	sent: string[];
	ceilings: Map<string, number>;
	/** URLs whose body the door told the site not to send (`acceptBody`). */
	skipped: string[];
}

/** A site answering by URL the way the pinned primitive would. */
function scriptedSite(routes: Record<string, Scripted>): ScriptedSite {
	const sent: string[] = [];
	const ceilings = new Map<string, number>();
	const skipped: string[] = [];
	let now = 1_000_000;
	const hop = async (request: PinnedHopRequest): Promise<PinnedHopResponse> => {
		const url = request.url.toString();
		sent.push(url);
		ceilings.set(url, request.maxBytes);
		const answer = routes[url] ?? { status: 404 };
		const headers = new Headers();
		if (answer.type !== undefined) headers.set('content-type', answer.type);
		const base = { status: answer.status, headers, location: null, truncated: false };
		if (request.acceptBody?.(answer.status, headers) === false) {
			skipped.push(url);
			return { ...base, bytes: new Uint8Array(0), bodySkipped: true };
		}
		const body =
			typeof answer.body === 'string'
				? new TextEncoder().encode(answer.body)
				: (answer.body ?? new Uint8Array(0));
		return { ...base, bytes: body, bodySkipped: false };
	};
	const deps: HarvestDeps = {
		hop,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		setTimer: () => {},
	};
	return { deps, sent, ceilings, skipped };
}

const on = async () => true;
const off = async () => false;

const staged: string[] = [];

/** The staged file's path, registered (with its name record) for the sweep
 * before any assertion can fail and strand it in the suite media root. */
function stagedPath(fileData: Record<string, unknown>): string {
	const dir = stagingDir(USER_ID, 'image');
	const tmpName = String(fileData.tmp_name);
	staged.push(join(dir, tmpName), join(dir, STAGED_NAME_DIR, tmpName));
	return join(dir, tmpName);
}

beforeEach(() => {
	clearRobotsCache();
	clearPacingForTests();
});

afterEach(() => {
	clearRobotsCache();
	clearPacingForTests();
	for (const path of staged.splice(0)) rmSync(path, { force: true });
});

describe('tool_uca_maps stage_external_image — the switch', () => {
	test('off, it is refused before anything is requested', async () => {
		const site = scriptedSite({ [IMAGE]: { status: 200, type: 'image/png', body: ONE_PIXEL_PNG } });
		const error = await failureOf(
			stageExternalImage(contextOf({ url: IMAGE }, USER_ID), { harvest: site.deps, enabled: off }),
		);
		expect(error.code).toBe('tool.method_not_allowed');
		expect(site.sent).toEqual([]);
	});

	test('on by default: register.json declares it, and the real switch lets it through', async () => {
		const register = JSON.parse(
			readFileSync(new URL('../../tools/tool_uca_maps/register.json', import.meta.url), 'utf8'),
		) as { default_config: Record<string, unknown> };
		expect(register.default_config[EXTERNAL_IMAGES_CONFIG_KEY]).toBe(true);

		const site = scriptedSite({ [IMAGE]: { status: 200, type: 'image/png', body: ONE_PIXEL_PNG } });
		const response = await stageExternalImage(contextOf({ url: IMAGE }, USER_ID), {
			harvest: site.deps,
		});
		stagedPath(dataOf<{ file_data: Record<string, unknown> }>(response).file_data);
		expect(site.sent).toContain(IMAGE);
	});

	test.each([
		['true', true, true],
		['a JSON false', false, false],
		['absent', true, undefined],
	])('the stored option %s reads as on=%p', (_label, on, value) => {
		expect(externalImagesOn(value)).toBe(on);
	});
});

describe('tool_uca_maps stage_external_image — through harvestFetch', () => {
	test('a PNG is staged in the caller staging dir, answered as an upload is', async () => {
		const site = scriptedSite({ [IMAGE]: { status: 200, type: 'image/png', body: ONE_PIXEL_PNG } });
		const response = await stageExternalImage(contextOf({ url: IMAGE }, USER_ID), {
			harvest: site.deps,
			enabled: on,
		});
		const fileData = dataOf<{ file_data: Record<string, unknown> }>(response).file_data;
		const path = stagedPath(fileData);
		expect(fileData.key_dir).toBe('image');
		expect(fileData.extension).toBe('png');
		expect(fileData.name).toBe('Muro norte.png');
		expect(fileData.complete).toBe(true);

		expect(existsSync(path)).toBe(true);
		expect(new Uint8Array(readFileSync(path))).toEqual(ONE_PIXEL_PNG);

		// any public site, at the associate picker's own ceiling
		expect(site.ceilings.get(IMAGE)).toBe(EXTERNAL_IMAGE_MAX_BYTES);
		expect(site.sent).toContain('https://images.example/robots.txt');
	});

	test('a non-2xx answer is a plain failure naming the status', async () => {
		const site = scriptedSite({ [IMAGE]: { status: 404 } });
		const error = await failureOf(
			stageExternalImage(contextOf({ url: IMAGE }, USER_ID), { harvest: site.deps, enabled: on }),
		);
		expect(error.code).toBe('tool.action_failed');
		expect(error.message).toContain('HTTP 404');
	});

	test.each([
		['a page instead of an image', 'text/html', '<html></html>'],
		['an image type the picker does not take (GIF)', 'image/gif', 'GIF89a'],
	])('%s is refused by its declared type, unread', async (_label, type, body) => {
		const site = scriptedSite({ [IMAGE]: { status: 200, type, body } });
		const error = await failureOf(
			stageExternalImage(contextOf({ url: IMAGE }, USER_ID), { harvest: site.deps, enabled: on }),
		);
		expect(error.code).toBe('harvest.unexpected_type');
		// refused by the door on the declared type, its body never sent
		expect(site.skipped).toEqual([IMAGE]);
	});

	test('bytes that are not the declared type are refused by the receiver, nothing staged', async () => {
		const site = scriptedSite({
			[IMAGE]: { status: 200, type: 'image/png', body: '<html>not a png</html>' },
		});
		const dir = stagingDir(USER_ID, 'image');
		const before = existsSync(dir) ? readdirSync(dir).sort() : [];
		const error = await failureOf(
			stageExternalImage(contextOf({ url: IMAGE }, USER_ID), { harvest: site.deps, enabled: on }),
		);
		expect(error.code).toBe('media.upload_rejected');
		expect(existsSync(dir) ? readdirSync(dir).sort() : []).toEqual(before);
	});

	test("the site's robots.txt is obeyed: a disallowed image is never requested", async () => {
		const site = scriptedSite({
			'https://images.example/robots.txt': {
				status: 200,
				type: 'text/plain',
				body: 'User-agent: *\nDisallow: /collection\n',
			},
			[IMAGE]: { status: 200, type: 'image/png', body: ONE_PIXEL_PNG },
		});
		const error = await failureOf(
			stageExternalImage(contextOf({ url: IMAGE }, USER_ID), { harvest: site.deps, enabled: on }),
		);
		expect(error.code).toBe('harvest.robots_disallowed');
		// the recorder's floor: the robots probe went out, so the empty `sent` lists above are measured
		expect(site.sent.length).toBeGreaterThan(0);
		expect(site.sent).not.toContain(IMAGE);
	});

	test('a url that is not absolute http(s) is refused before the door', async () => {
		for (const url of ['file:///etc/passwd', 'images/a.png', '', 42]) {
			const site = scriptedSite({});
			const error = await failureOf(
				stageExternalImage(contextOf({ url }, USER_ID), { harvest: site.deps, enabled: on }),
			);
			expect(error.code).toBe('request.invalid_options');
			expect(site.sent).toEqual([]);
		}
	});
});

describe('tool_uca_maps stage_external_image — the ceiling', () => {
	test("is the associate picker's own (image_upload.js IMAGE_UPLOAD_MAX_BYTES)", () => {
		const source = readFileSync(
			new URL('../../tools/tool_uca_maps/js/image_upload.js', import.meta.url),
			'utf8',
		);
		const picker = /\bconst IMAGE_UPLOAD_MAX_BYTES\s*=\s*([\d_]+)/.exec(source);
		expect(picker).not.toBeNull();
		expect(EXTERNAL_IMAGE_MAX_BYTES).toBe(Number((picker?.[1] ?? '').replace(/_/g, '')));
	});
});

describe('tool_uca_maps stagedFileName', () => {
	test('keeps the link name with the extension of what was sent', () => {
		expect(stagedFileName(new URL('https://a.example/x/foto.jpeg'), 'jpg')).toBe('foto.jpg');
		expect(stagedFileName(new URL('https://a.example/x/foto.jpg'), 'png')).toBe('foto.png');
		expect(stagedFileName(new URL('https://a.example/x/Muro%20norte'), 'png')).toBe(
			'Muro norte.png',
		);
	});

	test('a link with no name of its own gets a neutral one', () => {
		expect(stagedFileName(new URL('https://a.example/'), 'jpg')).toBe('external_image.jpg');
		expect(stagedFileName(new URL('https://a.example/x/.png'), 'png')).toBe('external_image.png');
	});

	test('a malformed escape keeps the raw segment', () => {
		expect(stagedFileName(new URL('https://a.example/a%E0%A4%A.png'), 'png')).toBe('a%E0%A4%A.png');
	});
});
