/**
 * get_catastro_parcel: the cadastral parcel at a map click, as v6
 * (`class.tool_leaflet_special_tools.php` `get_catastro_refcat`): its reference
 * from the INSPIRE view service, then its ring from the download service, both
 * asked through core's geo services (`catastro_wms_featureinfo`,
 * `catastro_wfs_parcel`). The ring arrives in the click's UTM zone and is
 * converted here (`utm.ts`).
 */

import { DedaloError, isErrorInDomain, ok } from '../../../src/core/errors/index.ts';
import { htmlTags } from '../../../src/core/resolve/html_text.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { clickedPoint, featureInfoQuery, parseClickParams } from './click_params.ts';
import { askGeoService } from './geo_call.ts';
import { sourceUnavailable } from './reasons.ts';
import { utmToLatLon, utmZoneOf } from './utm.ts';

// 14 alphanumerics — the Spanish cadastral reference's fixed shape. Sanity-
// checked before the value (scraped out of a third party's own HTML/GML
// replies) rides into a SECOND request as a parameter.
const REFCAT_PATTERN = /^[0-9A-Z]{14}$/i;

/** The peninsula and the Balearics, with core's CRS for each zone. Exported for the gate. */
export const CATASTRO_ZONES: Readonly<Record<number, string>> = Object.freeze({
	29: 'EPSG:25829',
	30: 'EPSG:25830',
	31: 'EPSG:25831',
});

/** The Canary Islands' zones: Catastro serves them in EPSG:25828, which core's
 * service does not offer. Exported for the gate. */
export const CANARY_ZONES: readonly number[] = Object.freeze([27, 28]);

/** The text of the first `<td>` after the one that reads `label`, or null. */
function cellAfter(html: string, label: string): string | null {
	const at = html.search(new RegExp(`<td[^>]*>\\s*${label}\\s*</td>`, 'i'));
	if (at === -1) return null;
	return firstLeafText(html.slice(at + 1), /<td/iy, /^([^<]*)<\/td>/i)?.trim() ?? null;
}

/**
 * {refcat, url} from the INSPIRE feature-info page, or null when it names no
 * parcel. `url` is the Sede Electrónica's own record of it (its
 * `otherReference` link), kept only over https. A page that is not the
 * feature-info answer (a maintenance page) is the source unavailable, never
 * "no parcel".
 */
export function parseCatastroRefcat(html: string): { refcat: string; url: string | null } | null {
	if (!/Get Feature Info Response/i.test(html)) {
		throw sourceUnavailable(
			'Catastro feature info answered without its result page',
			'catastro_unavailable',
		);
	}
	const refcat = cellAfter(html, 'nationalCadastralReference');
	if (refcat === null || !REFCAT_PATTERN.test(refcat)) {
		return null;
	}
	const other = html.search(/otherReference/i);
	let url: string | null = null;
	if (other !== -1) {
		for (const { tag } of htmlTags(html.slice(other), /<a/iy)) {
			const href = tag.match(/href="([^"]+)"/i)?.[1]?.replace(/&amp;/g, '&');
			if (href?.startsWith('https://')) {
				url = href;
				break;
			}
		}
	}
	return { refcat, url };
}

/**
 * `refcat`'s own `<member>`, matched by id, and its first `posList`: easting
 * northing pairs in UTM `zone`, returned as [lat, lon]. A `posList` is a
 * text-only GML leaf: a scoped regex is enough.
 */
export function extractParcelPosList(
	xml: string,
	refcat: string,
	zone: number,
): [number, number][] | null {
	const target = xmlElements(xml, '<member>', '</member>').find(
		(m) => m.includes(`.${refcat}"`) || m.includes(`>${refcat}<`),
	);
	if (!target) {
		return null;
	}
	const posList = firstLeafText(target, /<gml:posList/y, /^([^<]*)<\/gml:posList>/);
	if (!posList) {
		return null;
	}
	const nums = posList
		.trim()
		.split(/\s+/)
		.map((n) => Number(n));
	const points: [number, number][] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) {
		const easting = nums[i];
		const northing = nums[i + 1];
		if (
			easting === undefined ||
			northing === undefined ||
			!Number.isFinite(easting) ||
			!Number.isFinite(northing)
		) {
			return null;
		}
		points.push(utmToLatLon(easting, northing, zone));
	}
	return points.length >= 3 ? points : null; // a ring needs at least a triangle
}

/** Every `open…close` span, non-overlapping, each closed at its first `close`. */
function xmlElements(xml: string, open: string, close: string): string[] {
	const spans: string[] = [];
	let start = xml.indexOf(open);
	while (start !== -1) {
		const end = xml.indexOf(close, start + open.length);
		if (end === -1) {
			break;
		}
		spans.push(xml.slice(start, end + close.length));
		start = xml.indexOf(open, end + close.length);
	}
	return spans;
}

/** Group 1 of `after`, matched right after the first `opener…>` tag where it matches. */
function firstLeafText(xml: string, opener: RegExp, after: RegExp): string | null {
	for (const { index, tag } of htmlTags(xml, opener)) {
		const text = xml.slice(index + tag.length).match(after)?.[1];
		if (text !== undefined) {
			return text;
		}
	}
	return null;
}

/**
 * The WFS reply read as the parcel's ring. Core already turned Catastro's "not
 * found" report into `external.not_found`; a reply that is no
 * `FeatureCollection` (its maintenance page) is the source failing, never
 * "no parcel".
 */
export function parseParcelGeometry(
	xml: string,
	refcat: string,
	zone: number,
): [number, number][] | null {
	if (!/<(?:\w+:)?FeatureCollection[\s>]/.test(xml)) {
		throw sourceUnavailable(
			'Catastro WFS answered with no FeatureCollection',
			'catastro_unavailable',
		);
	}
	return extractParcelPosList(xml, refcat, zone);
}

/** Core's answer as text, with the provider's credit; its "nothing there" as null. */
async function askCatastro(
	id: string,
	params: Record<string, unknown>,
): Promise<{ text: string; attribution: string } | null> {
	try {
		const answer = await askGeoService(id, params, 'catastro_unavailable');
		return answer.kind === 'markup' ? { text: answer.text, attribution: answer.attribution } : null;
	} catch (error) {
		if (isErrorInDomain(error, 'external') && error.code === 'external.not_found') return null;
		throw error;
	}
}

export async function getCatastroParcel(ctx: ToolActionContext): Promise<ToolResponse> {
	const point = clickedPoint(parseClickParams(ctx.options));
	const zone = utmZoneOf(point[1]);
	if (CANARY_ZONES.includes(zone)) {
		throw new DedaloError('tool.unsupported_target', {
			message: `Catastro lookup in UTM zone ${zone} (the Canary Islands): no EPSG:25828 in core`,
			details: { reason_key: 'catastro_canary_islands' },
		});
	}
	const crs = CATASTRO_ZONES[zone];
	// outside Spain's zones Catastro has nothing: no third party is asked
	if (crs === undefined) {
		return ok({ found: false }, { requestId: toolRequestId(ctx) });
	}

	const html = await askCatastro('catastro_wms_featureinfo', featureInfoQuery(point));
	const parsed = html === null ? null : parseCatastroRefcat(html.text);
	if (!parsed) {
		return ok({ found: false }, { requestId: toolRequestId(ctx) });
	}

	const xml = await askCatastro('catastro_wfs_parcel', { refcat: parsed.refcat, crs });
	const points = xml === null ? null : parseParcelGeometry(xml.text, parsed.refcat, zone);
	if (!points) {
		return ok(
			{ found: false, refcat: parsed.refcat, url: parsed.url },
			{ requestId: toolRequestId(ctx) },
		);
	}

	return ok(
		{ found: true, refcat: parsed.refcat, url: parsed.url, points, attribution: xml?.attribution },
		{ requestId: toolRequestId(ctx) },
	);
}
