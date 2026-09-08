/**
 * tool_uca_maps — `get_wms_layers` (fila #6, "WMS services").
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), same criterion as
 *    `get_capabilities`/`vector_download`/`raster_download` — the action
 *    writes nothing, it proxies a THIRD PARTY server's own GetCapabilities
 *    document for the caller's already-scoped map component;
 *  - `normalizeWmsBaseUrl`/`wmsCapabilitiesUrl` (pure, no network) — caller-
 *    fault validation and the exact GetCapabilities query built;
 *  - the handler actually applies the SSRF guard: a private/loopback target
 *    is refused via `isSsrfRefusal`, with NO real network reached (DNS
 *    resolution of a literal IP is instant) — the live "reaches a real WMS
 *    server" path is NOT exercised here (this repo's tests never depend on
 *    network/a third-party service being up), matching how
 *    `tool_uca_maps_vector_download.test.ts` gates its own binary-dependent
 *    half behind `describe.if(HAVE_GDAL)` rather than assuming the tool it
 *    needs.
 */

import { describe, expect, test } from 'bun:test';
import { isSsrfRefusal } from '../../src/core/security/ssrf_guard.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import { normalizeWmsBaseUrl, wmsCapabilitiesUrl } from '../../tools/tool_uca_maps/server/wms.ts';
import { mustGet } from '../helpers/assert.ts';

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(loaded?.module.apiActions.get_wms_layers, 'get_wms_layers');
	return action as GatedToolActionSpec;
}

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

describe('tool_uca_maps get_wms_layers — declared gate', () => {
	test("is record_tipo at read level (1), same criterion as the tool's other read actions", async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

describe('normalizeWmsBaseUrl — caller-fault validation (no network)', () => {
	test('an empty/missing url is refused', () => {
		expect(() => normalizeWmsBaseUrl('')).toThrow(/URL is required/);
		expect(() => normalizeWmsBaseUrl('   ')).toThrow(/URL is required/);
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
	test('a missing url is refused as request.invalid_options', async () => {
		const action = await loadAction();
		await expect(action.handler(contextOf({}))).rejects.toThrow(/URL is required/);
	});

	test('a private/loopback target is refused by the SSRF guard, no network reached', async () => {
		const action = await loadAction();
		const error = await action
			.handler(contextOf({ url: 'http://127.0.0.1:9999/wms' }))
			.catch((e: unknown) => e);
		expect(isSsrfRefusal(error)).toBe(true);
	});
});
