/**
 * get_catastro_parcel — hito "Catastro" (fila #8, `docs/Funcionalidades de
 * tool_leaflet_special_tools.md`): given a map click, looks up the official
 * cadastral parcel at that point and returns its boundary.
 *
 * WHY THIS NEEDS THE SERVER: the browser cannot read `ovc.catastro.meh.es`'s
 * replies directly (no CORS), and the server chains THREE outbound calls per
 * click (v6 oracle: `class.tool_leaflet_special_tools.php get_catastro_refcat`
 * + `get_catastro_feature` x2) — a WMS GetFeatureInfo scrape for the parcel's
 * reference, then a WFS GML query for its geometry. Both hosts are FIXED
 * literals this file builds itself; the client never supplies a URL (unlike
 * `wms.ts`'s row #6, where the whole point is a user-chosen server) — so
 * there is no SSRF surface to guard here beyond the fixed-host fetch itself.
 *
 * CORRECTNESS IMPROVEMENT over the v6 oracle: v6 picks the target parcel's
 * `gml:posList` by a hardcoded POSITIONAL index (1 for the "neighbour" query,
 * 0 for the fallback) — an assumption about response ordering, not a check.
 * This port instead matches the `<member>` block whose own id/reference
 * equals the refcat just looked up (`extractParcelPosList` below), which is
 * correct regardless of how many neighbours the stored query returns.
 */

import { ok } from '../../../src/core/errors/index.ts';
import { fetchGuardedText } from '../../../src/core/security/ssrf_guard.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { type ClickParams, parseClickParams } from './click_params.ts';

const WMS_BASE = 'https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx';
const WFS_BASE = 'https://ovc.catastro.meh.es/INSPIRE/wfsCP.aspx';

// 14 alphanumerics — the Spanish cadastral reference's fixed shape. Sanity-
// checked before the value (scraped out of a third party's own HTML/GML
// replies) rides into a SECOND outbound URL as a query param.
const REFCAT_PATTERN = /^[0-9A-Z]{14}$/i;

/** EXPORTED for direct unit coverage (no network needed for this half). */
export function featureInfoUrl({ bbox, width, height, x, y }: ClickParams): URL {
	const url = new URL(WMS_BASE);
	url.searchParams.set('request', 'getFeatureInfo');
	url.searchParams.set('layers', 'Catastro');
	url.searchParams.set('query_layers', 'Catastro');
	url.searchParams.set('srs', 'EPSG:4326');
	url.searchParams.set('bbox', bbox.join(','));
	url.searchParams.set('height', String(Math.round(height)));
	url.searchParams.set('width', String(Math.round(width)));
	url.searchParams.set('x', String(Math.round(x)));
	url.searchParams.set('y', String(Math.round(y)));
	return url;
}

/**
 * Extracts {refcat, url} from the GetFeatureInfo HTML, or null if empty.
 * Scoped to the text AFTER the fixed "Referencia catastral" label (v6's own
 * literal string anchor for the same page) rather than the FIRST `<a>` tag
 * anywhere in the document — a page-wide match would silently pick up an
 * unrelated link (a skip-link, a cookie notice) if the third party's markup
 * ever grows one ahead of the real answer (review-diff finding, hito 11).
 */
export function parseCatastroRefcat(html: string): { refcat: string; url: string } | null {
	const labelIndex = html.search(/Referencia catastral/i);
	if (labelIndex === -1) {
		return null;
	}
	const match = html.slice(labelIndex).match(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
	if (!match) {
		return null;
	}
	const refcat = match[2]?.trim() ?? '';
	if (!REFCAT_PATTERN.test(refcat)) {
		return null;
	}
	return { refcat, url: match[1] ?? '' };
}

/**
 * Finds `refcat`'s own `<member>` block and returns its first `posList` as
 * [lat, lon] pairs (GML returns them in that order here, verified live
 * against both stored queries — no axis-order swap needed for Leaflet's own
 * `L.polygon(latlngs)`). A `posList` is a GML leaf element (text-only, no
 * nested markup by schema) — a scoped regex is the correct amount of parsing
 * for it, not a full XML DOM the rest of this codebase has no dependency for.
 */
export function extractParcelPosList(xml: string, refcat: string): [number, number][] | null {
	const members = xml.match(/<member>[\s\S]*?<\/member>/g) ?? [];
	const target = members.find((m) => m.includes(`.${refcat}"`) || m.includes(`>${refcat}<`));
	if (!target) {
		return null;
	}
	const posList = target.match(/<gml:posList[^>]*>([^<]*)<\/gml:posList>/);
	if (!posList?.[1]) {
		return null;
	}
	const nums = posList[1]
		.trim()
		.split(/\s+/)
		.map((n) => Number(n));
	const points: [number, number][] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) {
		const lat = nums[i];
		const lon = nums[i + 1];
		if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
			return null;
		}
		points.push([lat, lon]);
	}
	return points.length >= 3 ? points : null; // a ring needs at least a triangle
}

async function fetchParcelGeometry(
	refcat: string,
	storedQueryId: 'getneighbourparcel' | 'getparcel',
): Promise<[number, number][] | null> {
	const url = new URL(WFS_BASE);
	url.searchParams.set('service', 'WFS');
	url.searchParams.set('version', '2.0');
	url.searchParams.set('srs', 'EPSG:3857');
	url.searchParams.set('request', 'getfeature');
	url.searchParams.set('STOREDQUERIE_ID', storedQueryId);
	url.searchParams.set('refcat', refcat);
	const xml = await fetchGuardedText(url.toString(), { maxBytes: 5 * 1024 * 1024 });
	return extractParcelPosList(xml, refcat);
}

export async function getCatastroParcel(ctx: ToolActionContext): Promise<ToolResponse> {
	const params = parseClickParams(ctx.options);

	const html = await fetchGuardedText(featureInfoUrl(params).toString(), { maxBytes: 256 * 1024 });
	const parsed = parseCatastroRefcat(html);
	if (!parsed) {
		return ok({ found: false }, { requestId: toolRequestId(ctx) });
	}

	// v6's own fallback order: try the "neighbour" stored query first (the
	// richer one, when it carries the target's own geometry), fall back to
	// the parcel-only query.
	const points =
		(await fetchParcelGeometry(parsed.refcat, 'getneighbourparcel')) ??
		(await fetchParcelGeometry(parsed.refcat, 'getparcel'));

	if (!points) {
		return ok(
			{ found: false, refcat: parsed.refcat, url: parsed.url },
			{ requestId: toolRequestId(ctx) },
		);
	}

	return ok(
		{ found: true, refcat: parsed.refcat, url: parsed.url, points },
		{ requestId: toolRequestId(ctx) },
	);
}
