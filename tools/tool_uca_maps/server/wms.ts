/**
 * get_wms_layers — hito "WMS" (fila #6, `docs/Funcionalidades de
 * tool_leaflet_special_tools.md`): server-side proxy for a WMS server's own
 * GetCapabilities document.
 *
 * WHY THIS NEEDS THE SERVER (v6 oracle: `class.tool_leaflet_special_tools.php
 * get_wms_layers`, `file_get_contents($url . '?request=GetCapabilities&…')`):
 * the browser cannot fetch an arbitrary third-party WMS endpoint directly —
 * most carry no CORS headers — and a raw server-side `file_get_contents` on a
 * user-typed URL is exactly the SSRF surface `src/core/security/ssrf_guard.ts`
 * exists to close (a form field pointed at `http://169.254.169.254/` or an
 * internal service). The capabilities document is a file on a site the user
 * named, so it goes through the harvesting door (`harvestFetch`,
 * `engineering/OUTBOUND_SPEC.md` §2-3): every address public, redirects
 * followed one vetted hop at a time (http → https, a moved service), the
 * site's robots.txt obeyed, one request at a time per origin.
 *
 * The response XML is handed back RAW: `js/wms_services.js` parses it with
 * `DOMParser`, the same client-only approach v6 used (no server-side XML
 * parser to maintain here, and a browser's `DOMParser` on `text/xml` runs no
 * external-entity resolution).
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { type HarvestDeps, harvestFetch } from '../../../src/core/harvest/harvest.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/** A caller fault — missing/malformed WMS server URL. */
function invalidWmsRequest(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message, publicMessage: message });
}

/**
 * Parses+vets `raw` as an absolute http(s) WMS server URL, query/fragment
 * dropped — v6 strips whatever the user typed after '?' before appending its
 * own GetCapabilities query (`class.tool_leaflet_special_tools.php:1402-1416`);
 * a `URL` rebuild does the same thing without v6's ad hoc string splitting.
 * EXPORTED for direct unit coverage (no network needed for this half).
 *
 * @param raw - the form's raw URL string
 * @returns the base WMS server URL, query/fragment cleared
 */
export function normalizeWmsBaseUrl(raw: string): URL {
	const trimmed = String(raw ?? '').trim();
	if (!trimmed) {
		throw invalidWmsRequest('The WMS server URL is required.');
	}
	// absolute only — a bare path has no remote host to proxy to
	if (!/^https?:\/\//i.test(trimmed)) {
		throw invalidWmsRequest('Please enter a valid URL.');
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw invalidWmsRequest('Please enter a valid URL.');
	}
	url.search = '';
	url.hash = '';
	return url;
}

/** `base` + the two GetCapabilities query params WMS requires. */
export function wmsCapabilitiesUrl(base: URL): URL {
	const url = new URL(base.toString());
	url.searchParams.set('service', 'WMS');
	url.searchParams.set('request', 'GetCapabilities');
	return url;
}

/**
 * Fetch `base`'s GetCapabilities. A non-2xx answer is the server's own
 * refusal, not a transport failure: a plain failure, not a retryable one.
 * `deps` scripts the site in tests.
 *
 * @returns the base the document was served from (a redirect moved it: the
 *   layers live where it landed) and the raw XML
 */
export async function fetchWmsCapabilities(
	base: URL,
	deps: HarvestDeps = {},
): Promise<{ url: string; xml: string }> {
	const response = await harvestFetch(
		{
			url: wmsCapabilitiesUrl(base).toString(),
			hosts: 'public',
			maxBytes: 10 * 1024 * 1024,
			timeoutMs: 15_000,
		},
		deps,
	);
	if (!response.ok) {
		throw new DedaloError('tool.action_failed', {
			coordinates: { tool: 'tool_uca_maps' },
			message: `WMS GetCapabilities answered HTTP ${String(response.status)}`,
		});
	}
	const landed = new URL(response.url);
	landed.search = '';
	landed.hash = '';
	return { url: landed.toString(), xml: response.text() };
}

/** `deps` scripts the site in tests; the action binds the real door. */
export async function getWmsLayers(
	ctx: ToolActionContext,
	deps: HarvestDeps = {},
): Promise<ToolResponse> {
	const base = normalizeWmsBaseUrl(String(ctx.options.url ?? ''));
	const capabilities = await fetchWmsCapabilities(base, deps);
	return ok(capabilities, { requestId: toolRequestId(ctx) });
}
