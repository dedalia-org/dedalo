/**
 * get_elevation: the selected object's centre elevation. Server-side as in v6
 * (`class.tool_leaflet_special_tools.php` `get_elevation`), and the page CSP
 * blocks a browser call. An outage answers `unavailable`, never a failure: a
 * decorative line must not stop selecting an object. A bad coordinate throws.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { fetchGuardedText } from '../../../src/core/security/ssrf_guard.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

const OPEN_ELEVATION_LOOKUP = 'https://api.open-elevation.com/api/v1/lookup';

/** Short on purpose: this runs on every object click, and a slow answer that
 * arrives is worth less than a fast "unavailable" the user can ignore. */
const ELEVATION_TIMEOUT_MS = 8000;

/** One point's elevation is a handful of bytes; anything larger is not it. */
const ELEVATION_MAX_BYTES = 64 * 1024;

/** A caller fault — a coordinate that is not a coordinate. No publicMessage:
 * the console shows only "unavailable" whatever the failure. */
function invalidCoordinate(message: string): DedaloError {
	return new DedaloError('request.invalid_options', { message });
}

/**
 * A number, or nothing. Not `Number(value)`: it reads `null`, `''` and `[]` as
 * 0, so a missing coordinate would become the Gulf of Guinea and a null
 * elevation sea level, plausible values no error would ever flag.
 */
function finiteNumber(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * Reads one finite coordinate out of the options, refusing anything outside
 * its real range. The range check is not decoration: `locations=` goes
 * straight into a URL, and a NaN or an unbounded number would be shipped to a
 * third party as text.
 */
function readCoordinate(value: unknown, name: string, limit: number): number {
	const parsed = finiteNumber(value);
	if (parsed === null) {
		throw invalidCoordinate(`The ${name} of the point is required.`);
	}
	if (parsed < -limit || parsed > limit) {
		throw invalidCoordinate(`The ${name} of the point is out of range.`);
	}
	return parsed;
}

/**
 * Open-Elevation answers `{"results":[{"latitude":…,"longitude":…,"elevation":412}]}`.
 * Anything else — an HTML error page, an empty array, a non-numeric elevation
 * — reads as "no answer", never as zero metres: sea level is a real value and
 * must not be how a parse failure looks.
 */
export function parseElevation(text: string): number | null {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return null;
	}
	const results = (payload as { results?: unknown })?.results;
	if (!Array.isArray(results) || results.length === 0) {
		return null;
	}
	return finiteNumber((results[0] as { elevation?: unknown })?.elevation);
}

export function elevationUrl(lat: number, lon: number): URL {
	const url = new URL(OPEN_ELEVATION_LOOKUP);
	url.searchParams.set('locations', `${lat},${lon}`);
	return url;
}

export async function getElevation(ctx: ToolActionContext): Promise<ToolResponse> {
	const lat = readCoordinate(ctx.options.lat, 'latitude', 90);
	const lon = readCoordinate(ctx.options.lon, 'longitude', 180);

	let text: string;
	try {
		text = await fetchGuardedText(elevationUrl(lat, lon).toString(), {
			maxBytes: ELEVATION_MAX_BYTES,
			timeoutMs: ELEVATION_TIMEOUT_MS,
		});
	} catch {
		// the service is optional, the console is not
		return ok({ elevation: null, unavailable: true }, { requestId: toolRequestId(ctx) });
	}

	const elevation = parseElevation(text);
	return ok({ elevation, unavailable: elevation === null }, { requestId: toolRequestId(ctx) });
}
