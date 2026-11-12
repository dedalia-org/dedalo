/**
 * get_elevation: the selected object's centre elevation, through core's
 * `open_elevation_lookup` (v6 `class.tool_leaflet_special_tools.php`
 * `get_elevation`; the page CSP blocks a browser call). An outage answers
 * `unavailable`, never a failure: a decorative line must not stop selecting an
 * object. A bad coordinate throws.
 */

import { DedaloError, isErrorInDomain, ok } from '../../../src/core/errors/index.ts';
import { callGeoService } from '../../../src/core/geo_services/call.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

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
 * Anything else — an empty array, a non-numeric elevation — reads as "no
 * answer", never as zero metres: sea level is a real value and must not be how
 * a parse failure looks.
 */
export function parseElevation(payload: unknown): number | null {
	const results = (payload as { results?: unknown } | null)?.results;
	if (!Array.isArray(results) || results.length === 0) {
		return null;
	}
	return finiteNumber((results[0] as { elevation?: unknown })?.elevation);
}

export async function getElevation(ctx: ToolActionContext): Promise<ToolResponse> {
	const lat = readCoordinate(ctx.options.lat, 'latitude', 90);
	const lon = readCoordinate(ctx.options.lon, 'longitude', 180);

	let payload: unknown;
	let attribution: string;
	try {
		const answer = await callGeoService('open_elevation_lookup', { locations: [[lat, lon]] });
		payload = answer.kind === 'json' ? answer.data : null;
		attribution = answer.attribution;
	} catch (error) {
		// the service is optional, the console is not; a refused parameter is
		// the tool's own bug and stays loud
		if (!isErrorInDomain(error, 'external') && !isErrorInDomain(error, 'rate')) throw error;
		return ok({ elevation: null, unavailable: true }, { requestId: toolRequestId(ctx) });
	}

	const elevation = parseElevation(payload);
	return ok(
		{ elevation, unavailable: elevation === null, attribution },
		{ requestId: toolRequestId(ctx) },
	);
}
