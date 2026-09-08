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
 * internal service). This handler is `fetchGuardedText`'s intended shape: the
 * caller supplies no address policy of its own — the guard's "must be public"
 * policy IS the policy here, on purpose (a WMS server is by definition a
 * public map service).
 *
 * The response XML is handed back RAW: `js/wms_services.js` parses it with
 * `DOMParser`, the same client-only approach v6 used (no server-side XML
 * parser to maintain here, and a browser's `DOMParser` on `text/xml` runs no
 * external-entity resolution).
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { fetchGuardedText } from '../../../src/core/security/ssrf_guard.ts';
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

export async function getWmsLayers(ctx: ToolActionContext): Promise<ToolResponse> {
	const base = normalizeWmsBaseUrl(String(ctx.options.url ?? ''));
	// SSRF-01: assertPublicUrl (inside fetchGuardedText) resolves+vets the
	// host; no redirects, a timeout and a body cap close DOS-05/06.
	const xml = await fetchGuardedText(wmsCapabilitiesUrl(base).toString(), {
		maxBytes: 10 * 1024 * 1024,
	});
	return ok({ url: base.toString(), xml }, { requestId: toolRequestId(ctx) });
}
