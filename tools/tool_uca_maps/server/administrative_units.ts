/**
 * get_administrative_unit: the IGN administrative unit at a map click, asked of
 * core's `ign_admin_units_featureinfo`. That service answers ONE unit, of no
 * chosen level, and without its geometry: the unit is named, never drawn. v6's
 * level select and polygon (`special_tools_UA_es.js`) need a richer service.
 */

import { isErrorInDomain, ok } from '../../../src/core/errors/index.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { clickedPoint, featureInfoQuery, parseClickParams } from './click_params.ts';
import { askGeoService, geoData } from './geo_call.ts';

// The INSPIRE codelist value of the IGN unit, as the level v6's panel named it.
const NATIONAL_LEVEL_TO_LEVEL: Readonly<Record<string, string>> = Object.freeze({
	'https://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/4thOrder': 'Municipio',
	'https://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/3rdOrder': 'Provincia',
	'https://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/2ndOrder': 'CCAA',
});

export interface AdministrativeUnit {
	name: string;
	/** 'Municipio' | 'Provincia' | 'CCAA', or null for a level v6 never named. */
	level: string | null;
	code: string | null;
}

/** The first feature IGN listed, as a named unit; null when it names none. */
export function unitOf(data: unknown): AdministrativeUnit | null {
	const features = (data as { features?: unknown } | null)?.features;
	const first = Array.isArray(features) ? features[0] : undefined;
	const properties = (first as { properties?: Record<string, unknown> } | undefined)?.properties;
	const name = properties?.nameunit;
	if (typeof name !== 'string' || name.trim() === '') return null;
	const code = properties?.nationalcode;
	return {
		name: name.trim(),
		level: NATIONAL_LEVEL_TO_LEVEL[String(properties?.nationallevel ?? '')] ?? null,
		code: typeof code === 'string' ? code : null,
	};
}

export async function getAdministrativeUnit(ctx: ToolActionContext): Promise<ToolResponse> {
	const query = featureInfoQuery(clickedPoint(parseClickParams(ctx.options)));
	let unit: AdministrativeUnit | null = null;
	try {
		const answer = await askGeoService(
			'ign_admin_units_featureinfo',
			query,
			'admin_units_unavailable',
		);
		unit = unitOf(geoData(answer));
	} catch (error) {
		// core's "nothing there" (outside Spain, at sea) is no unit, not a failure
		if (!(isErrorInDomain(error, 'external') && error.code === 'external.not_found')) throw error;
	}
	return ok(unit ? { found: true, unit } : { found: false }, { requestId: toolRequestId(ctx) });
}
