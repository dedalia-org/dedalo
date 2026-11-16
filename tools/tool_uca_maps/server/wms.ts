/**
 * get_wms_layers: a server-side proxy for the GetCapabilities of a WMS server
 * the user names (v6 `class.tool_leaflet_special_tools.php` `get_wms_layers`).
 * Most WMS servers send no CORS headers, and a user-typed URL goes through the
 * harvesting door. The XML goes back raw: `js/wms_services.js` parses it.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { type HarvestDeps, harvestFetch } from '../../../src/core/harvest/harvest.ts';
import { isAddressRefusal } from '../../../src/core/security/ssrf_guard.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import type { ReasonKey } from './reasons.ts';

/** A caller fault — missing/malformed WMS server URL. */
function invalidWmsRequest(message: string, reason: ReasonKey, cause?: unknown): DedaloError {
	return new DedaloError('request.invalid_options', {
		message,
		details: { reason_key: reason },
		cause,
	});
}

/**
 * `raw` as an absolute http(s) WMS server URL, query and fragment dropped: v6
 * discards whatever the user typed after '?' before appending its own
 * GetCapabilities query. Exported for unit coverage.
 */
export function normalizeWmsBaseUrl(raw: string): URL {
	const trimmed = String(raw ?? '').trim();
	if (!trimmed) {
		throw invalidWmsRequest('The WMS server URL is required.', 'wms_url_required');
	}
	// absolute only — a bare path has no remote host to proxy to
	if (!/^https?:\/\//i.test(trimmed)) {
		throw invalidWmsRequest('Please enter a valid URL.', 'wms_url_invalid');
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw invalidWmsRequest('Please enter a valid URL.', 'wms_url_invalid');
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
 * `base`'s GetCapabilities XML and the base it landed on: after a redirect the
 * layers live there. A non-2xx is the server's own refusal, a plain failure
 * rather than a retryable one.
 */
async function fetchWmsCapabilities(
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
	).catch((error: unknown) => {
		// a host the user typed that does not resolve, or resolves somewhere non-public,
		// gets ONE answer: telling them apart would map the internal DNS. The guard's
		// own reason stays in the cause, for the operator's log.
		if (isAddressRefusal(error)) {
			throw invalidWmsRequest(
				'The server could not be reached: check the URL.',
				'wms_server_unreachable',
				error,
			);
		}
		throw error;
	});
	if (!response.ok) {
		// the remote is down or refuses, not this server: retryable, and readOnly
		// lets the resend show it
		throw new DedaloError('tool.source_unavailable', {
			coordinates: { tool: 'tool_uca_maps' },
			message: `WMS GetCapabilities answered HTTP ${String(response.status)}`,
			details: { reason_key: 'wms_server_unavailable' },
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
