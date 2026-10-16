/**
 * tool_uca_maps — `get_wms_layers`: the user's URL vetted and the
 * GetCapabilities query built, no network, and the handler going through the
 * harvesting door: a private target is refused by its address policy.
 */

import { describe, expect, test } from 'bun:test';
import type { HarvestDeps } from '../../src/core/harvest/harvest.ts';
import { isSsrfRefusal } from '../../src/core/security/ssrf_guard.ts';
import {
	getWmsLayers,
	normalizeWmsBaseUrl,
	wmsCapabilitiesUrl,
} from '../../tools/tool_uca_maps/server/wms.ts';
import { contextOf, expectCode, failureOf, loadAction } from './fixtures/tool_uca_maps/helpers.ts';

describe('normalizeWmsBaseUrl — caller-fault validation (no network)', () => {
	test('an empty/missing url is refused as request.invalid_options, before the door', async () => {
		expect(() => normalizeWmsBaseUrl('')).toThrow(/URL is required/);
		expect(() => normalizeWmsBaseUrl('   ')).toThrow(/URL is required/);

		// a scripted site, so a lost guard cannot reach a real one
		const sent: string[] = [];
		const site: HarvestDeps = {
			hop: async (request) => {
				sent.push(request.url.toString());
				throw new Error('no site here');
			},
		};
		const error = await failureOf(getWmsLayers(contextOf({}), site));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(/URL is required/);
		expect(sent).toEqual([]);

		// the positive control: a valid url does reach the scripted site
		await getWmsLayers(contextOf({ url: 'https://wms.example/wms' }), site).catch(() => null);
		expect(sent.length).toBeGreaterThan(0);
	});

	test('a non-absolute or non-http(s) url is refused', () => {
		expect(() => normalizeWmsBaseUrl('geoserver/wms')).toThrow(/valid URL/);
		expect(() => normalizeWmsBaseUrl('ftp://example.com/wms')).toThrow(/valid URL/);
		expect(() => normalizeWmsBaseUrl('javascript:alert(1)')).toThrow(/valid URL/);
	});

	test('query and fragment are stripped — v6 parity (it discards whatever the user typed after "?")', () => {
		const url = normalizeWmsBaseUrl(
			'https://example.com/geoserver/wms?service=WMS&request=GetMap#frag',
		);
		expect(url.toString()).toBe('https://example.com/geoserver/wms');
	});

	test('a clean url round-trips unchanged', () => {
		const url = normalizeWmsBaseUrl('  https://example.com/geoserver/wms  ');
		expect(url.toString()).toBe('https://example.com/geoserver/wms');
	});
});

describe('wmsCapabilitiesUrl', () => {
	test('appends service=WMS&request=GetCapabilities to the base url', () => {
		const base = normalizeWmsBaseUrl('https://example.com/geoserver/wms');
		const capabilities = wmsCapabilitiesUrl(base);
		expect(capabilities.searchParams.get('service')).toBe('WMS');
		expect(capabilities.searchParams.get('request')).toBe('GetCapabilities');
		expect(capabilities.origin + capabilities.pathname).toBe('https://example.com/geoserver/wms');
	});
});

describe('tool_uca_maps get_wms_layers — handler', () => {
	test('a private/loopback target is refused by the SSRF guard, no network reached', async () => {
		const action = await loadAction('get_wms_layers');
		const error = await action
			.handler(contextOf({ url: 'http://127.0.0.1:9999/wms' }))
			.catch((e: unknown) => e);
		expect(isSsrfRefusal(error)).toBe(true);
	});
});
