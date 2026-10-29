/**
 * component_av client media URLs are versioned by the FILE, not the render
 * (WC-2026-10-29-posterframe-url-version): `get_media_url` (component_av/js/media_url.js)
 * yields `?v=<file_time.time>-<file_size>` — stable across renders (HTTP cache reused),
 * new when either changes (a re-transcode, a same-second rewrite of another size) —
 * and falls back to the render time when the scan has no file_time (never cached).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

const globals = globalThis as unknown as Record<string, unknown>;
const saved = globals.DEDALO_MEDIA_URL;
let get_media_url: (file_info: Record<string, unknown>) => string;

beforeAll(async () => {
	globals.DEDALO_MEDIA_URL = '/dedalo/media';
	({ get_media_url } = await import(
		join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core', 'component_av', 'js', 'media_url.js')
	));
});
afterAll(() => {
	globals.DEDALO_MEDIA_URL = saved;
});

const file = (time: number | null, size: number) => ({
	file_path: '/av/404/0/test94_test3_1.mp4',
	file_size: size,
	file_time: time === null ? null : { time },
});

test('versioned by file_time + file_size, stable across renders', () => {
	const url = get_media_url(file(65116987113, 722370));
	expect(url).toBe('/dedalo/media/av/404/0/test94_test3_1.mp4?v=65116987113-722370');
	expect(get_media_url(file(65116987113, 722370))).toBe(url);
});

test('a new mtime OR a same-second rewrite of another size gives a new URL', () => {
	const url = get_media_url(file(65116987113, 722370));
	expect(get_media_url(file(65116987114, 722370))).not.toBe(url);
	expect(get_media_url(file(65116987113, 722371))).not.toBe(url);
});

test('no file_time → render-time token (never served stale)', () => {
	const before = Date.now();
	const v = Number(get_media_url(file(null, 1)).split('?v=')[1]);
	expect(v).toBeGreaterThanOrEqual(before);
});
