/**
 * CLIENT LABELS LOAD — the UI-label dictionary is its own versioned resource
 * (WC-2026-11-07-labels-separate-resource): client/dedalo/core/common/js/labels.js
 * `load_labels(lang, version)` fetches `<api base sibling>/labels?lang=&v=` and
 * assigns the bare global `get_label`; any failure is an ApiError
 * (client.bad_response) and leaves `get_label` untouched. Plus the wiring:
 * page.js loads it on BOTH start paths, and set_environment no longer assigns it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core');
const globals = globalThis as Record<string, unknown>;

type LabelsModule = {
	labels_url: (lang: string, version?: string) => string;
	load_labels: (lang: string, version?: string) => Promise<Record<string, string>>;
};

describe('labels.js load_labels', () => {
	let mod: LabelsModule;
	const saved: Record<string, unknown> = {};
	let calls: string[] = [];

	beforeAll(async () => {
		for (const key of ['DEDALO_API_URL', 'get_label', 'fetch']) saved[key] = globals[key];
		globals.DEDALO_API_URL = '/dedalo/core/api/v1/json/';
		mod = (await import(join(CLIENT, 'common', 'js', 'labels.js'))) as LabelsModule;
	});

	afterAll(() => {
		for (const key of Object.keys(saved)) globals[key] = saved[key];
	});

	const stub_fetch = (response: () => Response | Promise<Response>) => {
		calls = [];
		globals.fetch = async (url: string) => {
			calls.push(url);
			return response();
		};
	};

	test('builds the labels URL beside the API base, with lang + v', () => {
		expect(mod.labels_url('lg-spa', 'abcdef0123456789')).toBe(
			'/dedalo/core/api/v1/labels?lang=lg-spa&v=abcdef0123456789',
		);
		expect(mod.labels_url('lg-eng')).toBe('/dedalo/core/api/v1/labels?lang=lg-eng');
	});

	test('assigns the global get_label and returns the dictionary', async () => {
		globals.get_label = {};
		stub_fetch(() => Response.json({ cancel: 'Cancelar' }));
		const dict = await mod.load_labels('lg-spa', '0123456789abcdef');
		expect(calls).toEqual(['/dedalo/core/api/v1/labels?lang=lg-spa&v=0123456789abcdef']);
		expect(dict).toEqual({ cancel: 'Cancelar' });
		expect(globals.get_label).toBe(dict);
	});

	test('non-OK answer → ApiError client.bad_response, get_label untouched', async () => {
		const before = { keep: 'me' };
		globals.get_label = before;
		stub_fetch(() => new Response('not found', { status: 404 }));
		const error = await mod.load_labels('lg-xxx', 'v').catch((e) => e);
		expect(error?.is_api_error).toBe(true);
		expect(error?.code).toBe('client.bad_response');
		expect(globals.get_label).toBe(before);
	});

	test('network failure and a non-dictionary body are ApiErrors too', async () => {
		stub_fetch(() => Promise.reject(new TypeError('Failed to fetch')));
		expect((await mod.load_labels('lg-eng').catch((e) => e))?.code).toBe('client.bad_response');
		stub_fetch(() => Response.json(['a']));
		expect((await mod.load_labels('lg-eng').catch((e) => e))?.code).toBe('client.bad_response');
	});
});

describe('wiring', () => {
	test('page.js build loads labels on the success AND the perm.denied path', () => {
		const src = readFileSync(join(CLIENT, 'page', 'js', 'page.js'), 'utf8');
		const calls = src.match(
			/load_labels\(page_globals\.dedalo_application_lang, page_globals\.labels_version\)/g,
		);
		expect(calls?.length).toBe(2);
	});

	test('set_environment no longer assigns get_label (nor lets the default branch do it)', () => {
		const src = readFileSync(join(CLIENT, 'common', 'js', 'common.js'), 'utf8');
		const body = src.slice(src.indexOf('export const set_environment'));
		const fn = body.slice(0, body.indexOf('}//end set_environment'));
		expect(fn).toContain("case 'get_label':");
		expect(fn).not.toMatch(/get_label\s*=/);
	});
});
