/**
 * get_catastro_parcel: the cadastral parcel at a map click, as v6
 * (`class.tool_leaflet_special_tools.php` `get_catastro_refcat`): a WMS
 * GetFeatureInfo for its reference, then a WFS query for its ring. Server-side
 * because Catastro sends no CORS headers; both hosts are fixed literals.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
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

/** Exported for unit coverage. */
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
 * {refcat, url} from the GetFeatureInfo HTML, or null when the result page
 * names no parcel. Read after v6's "Referencia catastral" anchor, so a link
 * ahead of it (a skip-link) is never taken for the answer. A 200 without the
 * label (its maintenance page) is the source unavailable, never "no parcel".
 */
export function parseCatastroRefcat(html: string): { refcat: string; url: string } | null {
	const labelIndex = html.search(/Referencia catastral/i);
	if (labelIndex === -1) {
		throw new DedaloError('security.outbound_failed', {
			message: 'Catastro GetFeatureInfo answered without its parcel result page',
		});
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
 * `refcat`'s own `<member>`, matched by id rather than v6's positional index,
 * and its first `posList` as [lat, lon] pairs (the order both stored queries
 * answer). A `posList` is a text-only GML leaf: a scoped regex is enough.
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

/** The one exception that means "no parcel": "No se ha(n) encontrado…". */
const NOT_FOUND_EXCEPTION =
	/<(?:\w+:)?ExceptionText[^>]*>\s*(?:<!\[CDATA\[)?\s*No se han? encontrado/i;

/**
 * The WFS reply read as the parcel's ring. A stored query that finds nothing
 * answers an OWS `ExceptionReport` saying so (null: the caller falls back, as
 * v6 did). Any other report (a refused parameter, a server fault) and a reply
 * that is no `FeatureCollection` either (its maintenance page) are the source
 * failing: reading them as "no parcel" would be false.
 */
export function parseParcelGeometry(xml: string, refcat: string): [number, number][] | null {
	if (/<(?:\w+:)?ExceptionReport[\s>]/.test(xml)) {
		if (NOT_FOUND_EXCEPTION.test(xml)) {
			return null;
		}
		const code = xml.match(/exceptionCode="([\w.-]{1,64})"/)?.[1] ?? 'none';
		throw new DedaloError('security.outbound_failed', {
			message: `Catastro WFS answered an exception other than "not found" (exceptionCode: ${code})`,
		});
	}
	if (!/<(?:\w+:)?FeatureCollection[\s>]/.test(xml)) {
		throw new DedaloError('security.outbound_failed', {
			message: 'Catastro WFS answered with neither a FeatureCollection nor an ExceptionReport',
		});
	}
	return extractParcelPosList(xml, refcat);
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
	return parseParcelGeometry(xml, refcat);
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
