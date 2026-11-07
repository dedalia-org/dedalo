/**
 * WHAT A GEO SERVICE'S ANSWER MEANS — the second half of "a closed table".
 *
 * The door that fetches (`fetchGuardedText`) returns the body as TEXT; it does not
 * hand back the response headers. So the content type the table promises is held by
 * what the engine controls — the `Accept` header it sends and the fixed
 * `format`/`INFO_FORMAT` parameter it sets — and then VERIFIED on the body itself:
 *
 *   - a JSON service's body must parse, and be the shape the table says (an array,
 *     an object, a GeoJSON FeatureCollection, an object with a `results` array). An
 *     HTML error page served with a 200, a proxy's splash page, a truncated body: all
 *     `external.protocol`.
 *   - a markup service's body (the WMS and WFS of Catastro answer HTML or GML/XML)
 *     must open with `<`. A provider's exception report is a 200 whose BODY says the
 *     request failed: when its text matches the service's "nothing there" pattern it
 *     is `external.not_found`, otherwise `external.protocol`.
 *
 * "NOTHING THERE" IS A TYPED ANSWER, NOT AN EMPTY RESULT, for a service that asks a
 * question with one answer (what is at this point, what is parcel X, what is place
 * 123): the caller must be able to tell "the provider has nothing" from "the provider
 * is down". A SEARCH that finds nothing is an ordinary empty list and stays one.
 *
 * The parsed answer is the provider's data, untrusted: it is returned to the caller
 * as it came and carries the provider's attribution beside it, for the caller to
 * show. Nothing here executes, renders or follows anything in it.
 *
 * CHARSET, stated rather than discovered: the text door decodes UTF-8 whatever charset a
 * provider declares, so a provider that really sent another charset would show replacement
 * characters. Measured (2026-11-06): Catastro declares ISO-8859-1 in its headers and its XML
 * prolog but sends UTF-8 bytes; the other providers send UTF-8.
 */

import { type GeoErrorCode, geoError } from './errors.ts';
import {
	GEO_ORIGINS,
	type GeoService,
	type GeoServiceId,
	type JsonNotFound,
	type JsonShape,
} from './table.ts';

/** A geo service's answer: the provider's data and the attribution it asks to be shown. */
export type GeoServiceResult =
	| {
			readonly service: GeoServiceId;
			readonly kind: 'json';
			readonly data: unknown;
			readonly attribution: string;
	  }
	| {
			readonly service: GeoServiceId;
			readonly kind: 'markup';
			readonly text: string;
			readonly attribution: string;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The shape tests, one per `JsonShape`. */
const SHAPE_CHECKS: Readonly<Record<JsonShape, (data: unknown) => boolean>> = Object.freeze({
	array: (data) => Array.isArray(data),
	object: (data) => isRecord(data),
	features: (data) =>
		isRecord(data) && data.type === 'FeatureCollection' && Array.isArray(data.features),
	results: (data) => isRecord(data) && Array.isArray(data.results),
});

/** The "nothing there" tests, one per `JsonNotFound`. */
const NOT_FOUND_CHECKS: Readonly<Record<JsonNotFound, (data: unknown) => boolean>> = Object.freeze({
	empty_features: (data) =>
		isRecord(data) && Array.isArray(data.features) && data.features.length === 0,
	error_key: (data) => isRecord(data) && Object.hasOwn(data, 'error'),
});

/** An exception report, WMS or OWS, whatever its namespace prefix. */
const EXCEPTION_REPORT = /<(?:[\w-]+:)?(?:Service)?ExceptionReport\b/i;

/** A body that opens a markup document (a byte-order mark and white space allowed first). */
const OPENS_MARKUP = /^﻿?\s*</;

/** The failure for a service, by code. */
function failure(code: GeoErrorCode, serviceId: string, service: GeoService): Error {
	return geoError(code, serviceId, service.origin);
}

/** The body as JSON (boxed, since `null` and `false` are JSON too), or null when it is not JSON. */
function parseJson(body: string): { readonly data: unknown } | null {
	try {
		return { data: JSON.parse(body) as unknown };
	} catch {
		return null;
	}
}

function jsonResult(
	serviceId: GeoServiceId,
	service: GeoService,
	body: string,
	spec: Extract<GeoService['answer'], { kind: 'json' }>,
): GeoServiceResult {
	const parsed = parseJson(body);
	if (parsed === null || !SHAPE_CHECKS[spec.shape](parsed.data)) {
		throw failure('external.protocol', serviceId, service);
	}
	if (spec.notFound !== undefined && NOT_FOUND_CHECKS[spec.notFound](parsed.data)) {
		throw failure('external.not_found', serviceId, service);
	}
	const { attribution } = GEO_ORIGINS[service.origin];
	return { service: serviceId, kind: 'json', data: parsed.data, attribution };
}

function markupResult(
	serviceId: GeoServiceId,
	service: GeoService,
	body: string,
	spec: Extract<GeoService['answer'], { kind: 'markup' }>,
): GeoServiceResult {
	if (!OPENS_MARKUP.test(body)) throw failure('external.protocol', serviceId, service);
	if (EXCEPTION_REPORT.test(body)) {
		const nothing = spec.notFound(body);
		throw failure(nothing ? 'external.not_found' : 'external.protocol', serviceId, service);
	}
	const { attribution } = GEO_ORIGINS[service.origin];
	return { service: serviceId, kind: 'markup', text: body, attribution };
}

/**
 * The typed result of a 2xx body, or the typed failure it stands for. `external.protocol`
 * when it is not the shape the service returns; `external.not_found` when it is the
 * provider saying there is nothing.
 */
export function interpretAnswer(
	serviceId: GeoServiceId,
	service: GeoService,
	body: string,
): GeoServiceResult {
	const spec = service.answer;
	return spec.kind === 'json'
		? jsonResult(serviceId, service, body, spec)
		: markupResult(serviceId, service, body, spec);
}
