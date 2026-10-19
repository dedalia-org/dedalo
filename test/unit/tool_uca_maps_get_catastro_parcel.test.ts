/**
 * tool_uca_maps — `get_catastro_parcel`: the GetFeatureInfo query built and
 * the two Catastro replies parsed, no network. The handler's wiring:
 * tool_uca_maps_service_handlers.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import {
	extractParcelPosList,
	featureInfoUrl,
	parseCatastroRefcat,
	parseParcelGeometry,
} from '../../tools/tool_uca_maps/server/catastro.ts';

/** A reply that is not an answer: the source unavailable, never "no parcel". */
const SOURCE_UNAVAILABLE = expect.objectContaining({ code: 'security.outbound_failed' });

describe('featureInfoUrl', () => {
	test('builds the fixed Catastro GetFeatureInfo query from a click payload', () => {
		const url = featureInfoUrl({
			bbox: [-1, 38, -0.9, 38.1],
			width: 512,
			height: 400,
			x: 128.4,
			y: 63.6,
		});
		expect(url.origin + url.pathname).toBe(
			'https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx',
		);
		// a non-square map: a height read from the width queries another pixel
		expect(Object.fromEntries(url.searchParams)).toEqual({
			request: 'getFeatureInfo',
			layers: 'Catastro',
			query_layers: 'Catastro',
			srs: 'EPSG:4326',
			bbox: '-1,38,-0.9,38.1',
			height: '400',
			width: '512',
			x: '128',
			y: '64',
		});
	});
});

describe('parseCatastroRefcat', () => {
	// captured live against ovc.catastro.meh.es
	const REAL_HTML =
		'<?xml version="1.0" encoding="ISO-8859-1"?>\n<!DOCTYPE html \nPUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"\n"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="sp"  lang="sp" >\n<head><title>Informaci&oacute;n parcelas</title></head><body><p>Referencia catastral de la parcela:</p><p><a href="https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?del=46&muni=225&rc1=6075421&rc2=YJ2667S">6075421YJ2667S</a></p></body></html>';

	test('extracts refcat + record url from a real reply', () => {
		expect(parseCatastroRefcat(REAL_HTML)).toEqual({
			refcat: '6075421YJ2667S',
			url: 'https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?del=46&muni=225&rc1=6075421&rc2=YJ2667S',
		});
	});

	// captured live: a click in the sea and one in France
	const NO_PARCEL_HTML =
		'<?xml version="1.0" encoding="ISO-8859-1"?>\n<!DOCTYPE html \nPUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"\n"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="sp"  lang="sp" >\n<head><title>Informaci&oacute;n parcelas</title></head><body><p>Referencia catastral de la parcela:</p></body></html>';

	// a scheduled stop answers a 200 with this notice and no result page (its
	// wording, not its bytes, which were not captured)
	const MAINTENANCE_HTML =
		'<html><head><title>Sede Electr&oacute;nica del Catastro</title></head><body>' +
		'<h1>INTERRUPCI&Oacute;N DEL SERVICIO POR MOTIVOS DE MANTENIMIENTO</h1></body></html>';

	test('the result page with no parcel at that point yields null', () => {
		expect(parseCatastroRefcat(NO_PARCEL_HTML)).toBeNull();
	});

	test('a reply that is not the result page (maintenance, empty) is the source unavailable, never "no parcel"', () => {
		for (const html of [MAINTENANCE_HTML, '', '<html><body></body></html>']) {
			expect(() => parseCatastroRefcat(html)).toThrow(SOURCE_UNAVAILABLE);
		}
	});

	test('a refcat not matching the 14-alphanumeric shape is refused', () => {
		expect(
			parseCatastroRefcat('Referencia catastral: <a href="https://example.com/">not a refcat</a>'),
		).toBeNull();
	});

	test('an anchor BEFORE the "Referencia catastral" label is ignored, not mistaken for the answer', () => {
		const html =
			'<a href="https://example.com/skip-link">Skip to content</a>' +
			'<p>Referencia catastral de la parcela:</p><p><a href="https://example.com/real">6075421YJ2667S</a></p>';
		expect(parseCatastroRefcat(html)).toEqual({
			refcat: '6075421YJ2667S',
			url: 'https://example.com/real',
		});
	});
});

describe('extractParcelPosList', () => {
	const REFCAT = 'REFCAT00000001';

	function memberXml(id: string, posList: string): string {
		return `<member><cp:CadastralParcel gml:id="ES.SDGC.CP.${id}"><cp:geometry><gml:Surface><gml:patches><gml:PolygonPatch><gml:exterior><gml:LinearRing><gml:posList srsDimension="2" count="4">${posList}</gml:posList></gml:LinearRing></gml:exterior></gml:PolygonPatch></gml:patches></gml:Surface></cp:geometry></cp:CadastralParcel></member>`;
	}

	test('finds the member matching refcat and extracts [lat, lon] pairs', () => {
		const xml = `<FeatureCollection>${memberXml('OTHER00000000', '1 1 2 2 3 3')}${memberXml(REFCAT, '39.1 -0.1 39.2 -0.2 39.3 -0.3')}</FeatureCollection>`;
		expect(extractParcelPosList(xml, REFCAT)).toEqual([
			[39.1, -0.1],
			[39.2, -0.2],
			[39.3, -0.3],
		]);
	});

	test('no member matches refcat — null, not the wrong parcel', () => {
		const xml = `<FeatureCollection>${memberXml('OTHER00000000', '1 1 2 2 3 3')}</FeatureCollection>`;
		expect(extractParcelPosList(xml, REFCAT)).toBeNull();
	});

	test('fewer than 3 points (not a ring) — null', () => {
		const xml = `<FeatureCollection>${memberXml(REFCAT, '39.1 -0.1 39.2 -0.2')}</FeatureCollection>`;
		expect(extractParcelPosList(xml, REFCAT)).toBeNull();
	});

	// captured live: a stored query for a reference with no parcel
	const NOT_FOUND_XML =
		'<?xml version=\'1.0\' encoding="ISO-8859-1" standalone="no"?>\n<ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0">\n<Exception exceptionCode="OperationProcessingFailed">\n<ExceptionText><![CDATA[No se han encontrado registros de la referencia 0000000AA0000A]]></ExceptionText>\n</Exception>\n</ExceptionReport>\n';

	test('the WFS reply: a FeatureCollection is read, a "not found" report is null (the fallback runs)', () => {
		const xml = `<FeatureCollection xmlns="http://www.opengis.net/wfs/2.0">${memberXml(REFCAT, '39.1 -0.1 39.2 -0.2 39.3 -0.3 39.1 -0.1')}</FeatureCollection>`;
		expect(parseParcelGeometry(xml, REFCAT)).toEqual([
			[39.1, -0.1],
			[39.2, -0.2],
			[39.3, -0.3],
			[39.1, -0.1],
		]);
		expect(parseParcelGeometry(NOT_FOUND_XML, REFCAT)).toBeNull();
	});

	test('"not found" is read in both its numbers; any other exception report is the source unavailable', () => {
		const report = (code: string, text: string) =>
			`<ExceptionReport xmlns="http://www.opengis.net/ows/1.1" version="2.0.0"><Exception exceptionCode="${code}"><ExceptionText><![CDATA[${text}]]></ExceptionText></Exception></ExceptionReport>`;
		expect(
			parseParcelGeometry(
				report('OperationProcessingFailed', 'No se ha encontrado la referencia'),
				REFCAT,
			),
		).toBeNull();
		expect(
			parseParcelGeometry(
				'<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"><ows:Exception exceptionCode="OperationProcessingFailed"><ows:ExceptionText>No se han encontrado registros</ows:ExceptionText></ows:Exception></ows:ExceptionReport>',
				REFCAT,
			),
		).toBeNull();
		for (const xml of [
			report('InvalidParameterValue', 'El parámetro refcat no es válido'),
			report('NoApplicableCode', 'Error interno del servidor'),
			'<ExceptionReport xmlns="http://www.opengis.net/ows/1.1"><Exception exceptionCode="OperationProcessingFailed"/></ExceptionReport>',
		]) {
			expect(() => parseParcelGeometry(xml, REFCAT)).toThrow(SOURCE_UNAVAILABLE);
		}
	});

	test('a WFS reply that is neither (maintenance, empty) is the source unavailable, never "no parcel"', () => {
		const maintenance =
			'<html><body><h1>INTERRUPCI&Oacute;N DEL SERVICIO POR MOTIVOS DE MANTENIMIENTO</h1></body></html>';
		for (const xml of [maintenance, '']) {
			expect(() => parseParcelGeometry(xml, REFCAT)).toThrow(SOURCE_UNAVAILABLE);
		}
	});
});
