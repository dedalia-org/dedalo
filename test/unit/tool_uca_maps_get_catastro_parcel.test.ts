/**
 * tool_uca_maps — `get_catastro_parcel`: the clicked point, the feature-info
 * question, the two Catastro replies parsed and the UTM ring converted, no
 * network. The handler's wiring: tool_uca_maps_service_handlers.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import {
	clickedPoint,
	extractParcelPosList,
	featureInfoQuery,
	parseCatastroRefcat,
	parseParcelGeometry,
} from '../../tools/tool_uca_maps/server/catastro.ts';
import { geoParamAccepts } from '../../tools/tool_uca_maps/server/geo_call.ts';
import { utmToLatLon, utmZoneOf } from '../../tools/tool_uca_maps/server/utm.ts';

/** A reply that is not an answer: the source unavailable, never "no parcel". */
const SOURCE_UNAVAILABLE = expect.objectContaining({
	code: 'tool.source_unavailable',
	details: { reason_key: 'catastro_unavailable' },
});

describe("utmToLatLon — Catastro's ring, converted in the tool", () => {
	// references from GDAL (gdaltransform, EPSG:258zz → EPSG:4258)
	test.each([
		[725684.13, 4372525.27, 30, 39.4727395719826, -0.376327842685717],
		[500000, 4000000, 29, 36.1447180997896, -9],
		[300000, 4650000, 31, 41.9766275448149, 0.586014723094762],
		[820000, 4800000, 29, 43.2848025161097, -5.05594607583354],
	])("E %d N %d zone %d is GDAL's lat/lon within a millimetre", (e, n, zone, lat, lon) => {
		const [gotLat, gotLon] = utmToLatLon(e, n, zone);
		expect(Math.abs(gotLat - lat)).toBeLessThan(1e-8);
		expect(Math.abs(gotLon - lon)).toBeLessThan(1e-8);
	});

	test('the zone is the one whose central meridian is nearest', () => {
		expect(utmZoneOf(-9.1)).toBe(29);
		expect(utmZoneOf(-0.37)).toBe(30);
		expect(utmZoneOf(2.17)).toBe(31);
		expect(utmZoneOf(-15.4)).toBe(28);
		expect(utmZoneOf(-18.1)).toBe(27);
	});
});

describe('clickedPoint and featureInfoQuery', () => {
	test('a pixel is linear in longitude and Mercator in latitude', () => {
		const [lat, lon] = clickedPoint({
			bbox: [-1, 38, -0.9, 38.1],
			width: 512,
			height: 400,
			x: 256,
			y: 200,
		});
		expect(lon).toBeCloseTo(-0.95, 12);
		// the Mercator midpoint, not the arithmetic one (38.05)
		expect(lat).not.toBeCloseTo(38.05, 6);
		expect(lat).toBeCloseTo(38.05003, 4);
		expect(
			clickedPoint({ bbox: [-1, 38, -0.9, 38.1], width: 512, height: 400, x: 0, y: 0 }),
		).toEqual([expect.closeTo(38.1, 10), -1]);
	});

	test('asks for the clicked point alone, centred in a small box core accepts', () => {
		const query = featureInfoQuery([39.4727, -0.3763]);
		expect(query).toMatchObject({ crs: 'EPSG:3857', width: 101, height: 101, i: 50, j: 50 });
		const [minX, minY, maxX, maxY] = query.bbox as number[];
		expect((maxX as number) - (minX as number)).toBeCloseTo(100, 6);
		expect((maxY as number) - (minY as number)).toBeCloseTo(100, 6);
		for (const [name, value] of Object.entries(query)) {
			expect(geoParamAccepts('catastro_wms_featureinfo', name, value)).toBe(true);
		}
	});
});

describe('parseCatastroRefcat', () => {
	// captured live from the INSPIRE view service (Valencia), whitespace removed
	const REAL_HTML =
		'<?xml version="1.0" encoding="ISO-8859-1"?><html><head><title>Parcel Information</title></head><body  id="body" class="tdBg06print"><table class="infoTablegrid1"><tbody><tr><td class="title">Get Feature Info Response</td></tr><tr><td><table class="infoTablegrid1"><tr><td colspan="2" class="requestedLayer">Requested Layer: CadastralParcel</td></tr><tr><td>inspireId</td><td><table><tr><td>localId</td><td>5726401YJ2752F</td></tr><tr><td>Namespace</td><td>ES.SDGC.CP</td></tr></table></td></tr><tr><td>AreaValue</td><td>193 m2</td></tr>                            <tr><td>beginLifespanVersion</td><td>2020-12-18T00:00:00</td></tr><tr><td>nationalCadastralReference</td><td>5726401YJ2752F</td></tr><tr><td>otherReference</td><td><ul class="otherReference"><li><a href="https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?del=46&amp;muni=900&amp;rc1=5726401&amp;rc2=YJ2752F" target="_blank">Public remote access</a></li></ul></td></tr></table></td></tr></tbody></table></body></html>';

	test("extracts the reference and the Sede's record from a real reply", () => {
		expect(parseCatastroRefcat(REAL_HTML)).toEqual({
			refcat: '5726401YJ2752F',
			url: 'https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?del=46&muni=900&rc1=5726401&rc2=YJ2752F',
		});
	});

	test('a link that is not https is not kept; the reference still is', () => {
		const html = REAL_HTML.replace('https://www1.sedecatastro', 'http://www1.sedecatastro');
		expect(parseCatastroRefcat(html)).toEqual({ refcat: '5726401YJ2752F', url: null });
	});

	test('a result page with no reference, or one off the 14-character shape, is null', () => {
		expect(parseCatastroRefcat(REAL_HTML.replaceAll('nationalCadastralReference', 'x'))).toBeNull();
		expect(parseCatastroRefcat(REAL_HTML.replaceAll('5726401YJ2752F', 'not a refcat'))).toBeNull();
	});

	test('a reply that is not the result page (maintenance, empty) is the source unavailable, never "no parcel"', () => {
		const maintenance =
			'<html><head><title>Sede Electr&oacute;nica del Catastro</title></head><body>' +
			'<h1>INTERRUPCI&Oacute;N DEL SERVICIO POR MOTIVOS DE MANTENIMIENTO</h1></body></html>';
		for (const html of [maintenance, '', '<html><body></body></html>']) {
			expect(() => parseCatastroRefcat(html)).toThrow(SOURCE_UNAVAILABLE);
		}
	});
});

describe('extractParcelPosList and parseParcelGeometry', () => {
	const REFCAT = '5726401YJ2752F';

	function memberXml(id: string, posList: string): string {
		return `<member><cp:CadastralParcel gml:id="ES.SDGC.CP.${id}"><cp:geometry><gml:Surface><gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing><gml:posList srsDimension="2" count="4">${posList}</gml:posList></gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches></gml:Surface></cp:geometry></cp:CadastralParcel></member>`;
	}

	// the first three vertices of the live GetParcel reply, EPSG:25830
	const RING = '725684.13 4372525.27 725685.12 4372525.09 725686.96 4372524.76';

	test('reads the member matching refcat and converts its easting/northing to [lat, lon]', () => {
		const xml = `<FeatureCollection>${memberXml('OTHER00000000', '1 1 2 2 3 3')}${memberXml(REFCAT, RING)}</FeatureCollection>`;
		const points = extractParcelPosList(xml, REFCAT, 30) as [number, number][];
		expect(points).toHaveLength(3);
		expect(points[0]?.[0]).toBeCloseTo(39.4727395719826, 8);
		expect(points[0]?.[1]).toBeCloseTo(-0.376327842685717, 8);
	});

	test('no member matches refcat, or fewer than 3 points — null, not the wrong parcel', () => {
		expect(
			extractParcelPosList(
				`<FeatureCollection>${memberXml('OTHER00000000', RING)}</FeatureCollection>`,
				REFCAT,
				30,
			),
		).toBeNull();
		expect(
			extractParcelPosList(
				`<FeatureCollection>${memberXml(REFCAT, '725684.13 4372525.27 725685.12 4372525.09')}</FeatureCollection>`,
				REFCAT,
				30,
			),
		).toBeNull();
	});

	test('a WFS reply that is no FeatureCollection (maintenance, empty) is the source unavailable', () => {
		const maintenance =
			'<html><body><h1>INTERRUPCI&Oacute;N DEL SERVICIO POR MOTIVOS DE MANTENIMIENTO</h1></body></html>';
		for (const xml of [maintenance, '']) {
			expect(() => parseParcelGeometry(xml, REFCAT, 30)).toThrow(SOURCE_UNAVAILABLE);
		}
		expect(
			parseParcelGeometry(
				`<FeatureCollection xmlns="http://www.opengis.net/wfs/2.0">${memberXml(REFCAT, RING)}</FeatureCollection>`,
				REFCAT,
				30,
			),
		).toHaveLength(3);
	});
});
