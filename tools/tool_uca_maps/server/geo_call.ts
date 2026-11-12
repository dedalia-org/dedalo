/**
 * The tool's one way to a fixed public geo service: core's closed table
 * (`src/core/geo_services/`), asked by id and parameters, never by URL. A
 * transient provider failure becomes the source unavailable with the tool's key,
 * so the browser says which service; anything else stays as core threw it.
 */

import { DedaloError, isErrorInDomain, specOf } from '../../../src/core/errors/index.ts';
import { callGeoService, type GeoServiceResult } from '../../../src/core/geo_services/call.ts';
import { GEO_SERVICES } from '../../../src/core/geo_services/table.ts';
import type { ReasonKey } from './reasons.ts';

/**
 * Only a RETRYABLE `external.*` (as the registry says: a transient status, a
 * timeout, a dropped connection…) is "the source is down, try again". A
 * provider's refusal, a blocked address or "nothing there" is not retryable, and
 * a retryable code over it would have the browser ask a provider that already
 * said no again: those pass through with core's own label, as do `rate.limited`
 * (busy, not down) and a refused parameter (the tool's own bug).
 */
export async function askGeoService(
	id: string,
	params: Record<string, unknown>,
	reason: ReasonKey,
): Promise<GeoServiceResult> {
	try {
		return await callGeoService(id, params);
	} catch (error) {
		if (isErrorInDomain(error, 'external') && specOf(error.code).retryable) {
			throw new DedaloError('tool.source_unavailable', {
				message: `${id} failed: ${error.code}`,
				details: { reason_key: reason },
				retryAfterMs: error.retryAfterMs,
				cause: error,
			});
		}
		throw error;
	}
}

/** The JSON a `kind: 'json'` service answered (every service this tool asks is one). */
export function geoData(result: GeoServiceResult): unknown {
	return result.kind === 'json' ? result.data : null;
}

/**
 * Whether core's own grammar for `param` of service `id` accepts `value`: the
 * tool refuses with a reason before asking, by the same rule core would refuse
 * it with (a generic `request.invalid_data`, no reason). Exported for the gate.
 */
export function geoParamAccepts(
	id: keyof typeof GEO_SERVICES,
	param: string,
	value: unknown,
): boolean {
	const definition = GEO_SERVICES[id].params.find((entry) => entry.name === param);
	return definition !== undefined && definition.check(value) !== null;
}
