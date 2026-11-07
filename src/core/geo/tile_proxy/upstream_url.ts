/**
 * THE UPSTREAM ADDRESS — the one place a stored map source and a tile request become
 * the URL the server asks for. Nothing a client sent reaches the address except
 * numbers this module formats itself.
 *
 *   xyz   the stored template with `{z}`, `{x}`, `{y}` replaced by the integers of the
 *         tile. No other substitution exists: the template language is those three
 *         words (geo/map_source_url.ts refuses any other placeholder, and refuses one in
 *         the host or the port).
 *   wms   the stored endpoint with the GetMap query the SERVER fixes appended through
 *         `URLSearchParams`: `service=WMS&request=GetMap`, the six stored values
 *         (version, layers, styles, format, transparent, CRS — under `srs` for 1.1.1,
 *         `crs` for 1.3.0), and a bbox/width/height that are NUMBERS. A tile's bbox is
 *         computed here (tile_geometry.ts); a free image's is validated there. A TILE of a
 *         geographic-CRS source (EPSG:4326, 4258) is built only from zoom
 *         `GEOGRAPHIC_TILE_MIN_ZOOM` up: the plate carrée crop the service returns is
 *         misregistered by more than a pixel against a mercator tile below it, so those
 *         zooms are refused, not relayed wrong. The
 *         endpoint's own query (a `map=` of a MapServer, a provider key) is kept; the
 *         keys the server owns cannot be in it (map_source_url.ts).
 *
 * THE FETCH-TIME VALIDATION. A stored source can predate a rule that has since
 * tightened, and an address built from a template nobody re-judged is the address the
 * guard would have to catch. So the WHOLE source is run through the SAME validator the
 * save gate used (`validateMapSource`: the template, the six WMS values, the zoom bounds)
 * before anything is built, and the finished address is checked
 * once more for what no template can promise: an http(s) URL, no credentials, no
 * fragment, the SAME host as the template (a substitution cannot move it), and — for a
 * wms — the endpoint's own origin and path.
 *
 * THE MEDIA TYPE. A tile source answers an image: the four types a browser draws from an
 * `<img>` without active content (png, jpeg, gif, webp). A wms source is held to the
 * format it declared. `image/svg+xml` and `text/html` are in neither list — an SVG is a
 * document, and a WMS ServiceException is XML with a 200.
 *
 * PURE. A reason never quotes the address (a template may carry a provider token).
 */

import { type Checked, fail, pass } from '../checked.ts';
import {
	MAP_SOURCE_LIMITS,
	type MapSourceBody,
	validateMapSource,
	WMS_FORMATS,
	type WmsParams,
	type XyzParams,
} from '../map_source.ts';
import {
	bboxParameter,
	checkBbox,
	GEOGRAPHIC_TILE_MIN_ZOOM,
	isGeographicCrs,
	tileBbox,
} from './tile_geometry.ts';
import { TILE_PX, type TileView } from './tile_request.ts';

/** What the fetch needs: the address, the one host it may visit, the media types it may answer with. */
export interface UpstreamRequest {
	/** The full upstream address. May carry a provider token: never logged, never put in a reason. */
	readonly url: string;
	/** The host of the address, for the redirect allowlist. */
	readonly host: string;
	readonly mediaTypes: readonly string[];
}

/** The image types a tile proxy relays. */
export const TILE_MEDIA_TYPES: readonly string[] = Object.freeze([...WMS_FORMATS]);

const PLACEHOLDER = /\{(?:z|x|y)\}/g;

/** The hostname of `text` read as a URL, or null. */
function hostOf(text: string): string | null {
	return URL.parse(text)?.hostname ?? null;
}

/** What no template can promise about a finished address: scheme, credentials, fragment. */
function shapeRefusal(url: URL): string | null {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the scheme moved';
	if (url.username !== '' || url.password !== '') return 'the built address has credentials';
	return url.hash === '' ? null : 'the built address has a fragment';
}

/** The finished address, vetted: http(s), no credentials, no fragment, `host` unmoved. */
function finish(
	text: string,
	host: string,
	mediaTypes: readonly string[],
): Checked<UpstreamRequest> {
	const url = URL.parse(text);
	if (url === null) return fail('the built address is not a URL');
	const refusal = shapeRefusal(url);
	if (refusal !== null) return fail(refusal);
	if (url.hostname !== host) return fail('the host moved');
	return pass({ url: url.href, host, mediaTypes });
}

/** A tile's zoom is inside the source's own bounds (absent: the engine's ceiling). */
function zoomInside(params: XyzParams, z: number): boolean {
	const low = params.min_zoom ?? 0;
	const high = params.max_zoom ?? MAP_SOURCE_LIMITS.maxZoom;
	return z >= low && z <= high;
}

function buildXyz(
	source: MapSourceBody & { type: 'xyz' },
	view: TileView,
): Checked<UpstreamRequest> {
	if (view.kind !== 'tile') return fail('an xyz source takes a tile, not a free image');
	if (!zoomInside(source.params, view.z)) return fail('the zoom is outside the source');
	const host = hostOf(source.url.replace(PLACEHOLDER, '0'));
	if (host === null) return fail('the template is not a URL');
	const filled = source.url
		.replaceAll('{z}', String(view.z))
		.replaceAll('{x}', String(view.x))
		.replaceAll('{y}', String(view.y));
	return finish(filled, host, TILE_MEDIA_TYPES);
}

/** The picture a WMS request asks for: its bbox, in the CRS's x/y order, and its size. */
function wmsPicture(
	params: WmsParams,
	view: TileView,
): Checked<{ bbox: string; width: number; height: number }> {
	if (view.kind === 'tile') {
		if (isGeographicCrs(params.crs) && view.z < GEOGRAPHIC_TILE_MIN_ZOOM) {
			return fail('a geographic-CRS source is relayed as tiles from its minimum zoom up');
		}
		const box = tileBbox(params.crs, view.z, view.x, view.y);
		return pass({
			bbox: bboxParameter(params.version, params.crs, box),
			width: TILE_PX,
			height: TILE_PX,
		});
	}
	const box = checkBbox(params.crs, view.bbox);
	if (!box.ok) return box;
	return pass({
		bbox: bboxParameter(params.version, params.crs, box.value),
		width: view.width,
		height: view.height,
	});
}

/** The query the server fixes on a GetMap request, in a stable order. */
function wmsQuery(params: WmsParams, picture: { bbox: string; width: number; height: number }) {
	const crsKey = params.version === '1.3.0' ? 'crs' : 'srs';
	return [
		['service', 'WMS'],
		['request', 'GetMap'],
		['version', params.version],
		['layers', params.layers],
		['styles', params.styles],
		['format', params.format],
		['transparent', params.transparent ? 'TRUE' : 'FALSE'],
		[crsKey, params.crs],
		['bbox', picture.bbox],
		['width', String(picture.width)],
		['height', String(picture.height)],
	] as const;
}

function buildWms(
	source: MapSourceBody & { type: 'wms' },
	view: TileView,
): Checked<UpstreamRequest> {
	const picture = wmsPicture(source.params, view);
	if (!picture.ok) return picture;
	const address = URL.parse(source.url);
	if (address === null) return fail('the endpoint is not a URL');
	for (const [key, value] of wmsQuery(source.params, picture.value)) {
		address.searchParams.append(key, value);
	}
	return finish(address.href, address.hostname, [source.params.format]);
}

/**
 * The upstream request for `view` of `source`, or the reason it cannot be built: a source that
 * no longer passes today's validator (the SAME one the save gate runs — a stored value can
 * predate a rule that has tightened, and `layers: "a&service=WFS"` written past the gate is
 * refused here, not relayed), a view the source's type does not take, a zoom outside it, a bbox
 * outside its CRS.
 */
export function buildUpstream(source: MapSourceBody, view: TileView): Checked<UpstreamRequest> {
	const checked = validateMapSource(source, 'source');
	if (!checked.ok) return checked;
	const valid = checked.value;
	return valid.type === 'xyz' ? buildXyz(valid, view) : buildWms(valid, view);
}
