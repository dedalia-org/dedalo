/**
 * get_administrative_unit: the IGN administrative unit (Municipio, Provincia,
 * CCAA) at a map click. v6 (`special_tools_UA_es.js`) fetched it from the
 * browser; a proxy does not rely on IGN never sending CORS headers. The level
 * is filtered here, first match wins, as v6's `break` did. The host is fixed.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import { fetchGuardedText } from '../../../src/core/security/ssrf_guard.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { parseClickParams } from './click_params.ts';

const IGN_AU_URL = 'https://www.ign.es/wms-inspire/unidades-administrativas';

// v6's own three levels (`special_tools_UA_es.js` create_select), mapped to
// the INSPIRE codelist value the IGN response's own `nationallevel` carries.
const LEVEL_TO_NATIONAL_LEVEL: Record<string, string> = {
	Municipio: 'https://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/4thOrder',
	Provincia: 'https://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/3rdOrder',
	CCAA: 'https://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/2ndOrder',
};

function invalidLevelRequest(): DedaloError {
	return new DedaloError('request.invalid_options', {
		message: 'A valid administrative level is required.',
		publicMessage: 'A valid administrative level is required.',
	});
}

interface IgnFeature {
	geometry: unknown;
	properties?: Record<string, unknown>;
}
interface IgnFeatureCollection {
	features?: IgnFeature[];
}

export async function getAdministrativeUnit(ctx: ToolActionContext): Promise<ToolResponse> {
	const params = parseClickParams(ctx.options);
	const nationalLevel = LEVEL_TO_NATIONAL_LEVEL[String(ctx.options.level ?? '')];
	if (!nationalLevel) {
		throw invalidLevelRequest();
	}

	const url = new URL(IGN_AU_URL);
	url.searchParams.set('service', 'WMS');
	url.searchParams.set('version', '1.3.0');
	url.searchParams.set('request', 'GetFeatureInfo');
	url.searchParams.set('layers', 'AU.AdministrativeUnit');
	url.searchParams.set('feature_count', '3');
	url.searchParams.set('info_format', 'application/json');
	url.searchParams.set('query_layers', 'AU.AdministrativeUnit');
	url.searchParams.set('bbox', params.bbox.join(','));
	url.searchParams.set('height', String(Math.round(params.height)));
	url.searchParams.set('width', String(Math.round(params.width)));
	url.searchParams.set('i', String(Math.round(params.x)));
	url.searchParams.set('j', String(Math.round(params.y)));

	const text = await fetchGuardedText(url.toString(), { maxBytes: 2 * 1024 * 1024 });

	let data: IgnFeatureCollection;
	try {
		data = JSON.parse(text);
	} catch {
		throw new DedaloError('security.outbound_failed', {
			message: 'The administrative-units service returned an unreadable response.',
		});
	}

	const feature = (data.features ?? []).find((f) => f.properties?.nationallevel === nationalLevel);

	return ok(
		{
			found: Boolean(feature),
			feature: feature
				? { type: 'Feature', geometry: feature.geometry, properties: feature.properties ?? {} }
				: null,
		},
		{ requestId: toolRequestId(ctx) },
	);
}
