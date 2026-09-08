/**
 * tool_uca_maps — `get_catastro_parcel` (fila #8, "Catastro").
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), same criterion as
 *    every other read-only action this tool ships;
 *  - `featureInfoUrl`/`parseCatastroRefcat`/`extractParcelPosList` (pure, no
 *    network) — the exact query built and the two third-party response
 *    shapes parsed (a real GetFeatureInfo HTML reply and a real WFS GML
 *    reply, both captured live against `ovc.catastro.meh.es` during hito 11);
 *  - the handler's caller-fault validation (parseClickParams, shared with
 *    `get_administrative_unit`).
 *
 * The live "reaches the real Catastro servers" path is NOT exercised here —
 * same reasoning as `tool_uca_maps_get_wms_layers.test.ts`: this repo's tests
 * never depend on a third-party service being up.
 */

import { describe, expect, test } from 'bun:test';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import {
	extractParcelPosList,
	featureInfoUrl,
	parseCatastroRefcat,
} from '../../tools/tool_uca_maps/server/catastro.ts';
import { mustGet } from '../helpers/assert.ts';

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(loaded?.module.apiActions.get_catastro_parcel, 'get_catastro_parcel');
	return action as GatedToolActionSpec;
}

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

describe('tool_uca_maps get_catastro_parcel — declared gate', () => {
	test('is record_tipo at read level (1)', async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

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
		expect(url.searchParams.get('request')).toBe('getFeatureInfo');
		expect(url.searchParams.get('layers')).toBe('Catastro');
		expect(url.searchParams.get('srs')).toBe('EPSG:4326');
		expect(url.searchParams.get('bbox')).toBe('-1,38,-0.9,38.1');
		expect(url.searchParams.get('width')).toBe('512');
		expect(url.searchParams.get('x')).toBe('128'); // rounded
		expect(url.searchParams.get('y')).toBe('64'); // rounded
	});
});

describe('parseCatastroRefcat', () => {
	// captured live, 2026-09-08, against ovc.catastro.meh.es
	const REAL_HTML =
		'<?xml version="1.0" encoding="ISO-8859-1"?>\n<!DOCTYPE html \nPUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"\n"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="sp"  lang="sp" >\n<head><title>Informaci&oacute;n parcelas</title></head><body><p>Referencia catastral de la parcela:</p><p><a href="https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?del=46&muni=225&rc1=6075421&rc2=YJ2667S">6075421YJ2667S</a></p></body></html>';

	test('extracts refcat + record url from a real reply', () => {
		expect(parseCatastroRefcat(REAL_HTML)).toEqual({
			refcat: '6075421YJ2667S',
			url: 'https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?del=46&muni=225&rc1=6075421&rc2=YJ2667S',
		});
	});

	test('an empty reply (no parcel at that point) yields null', () => {
		expect(parseCatastroRefcat('<html><body></body></html>')).toBeNull();
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
});

describe('tool_uca_maps get_catastro_parcel — handler validation', () => {
	test('a missing bbox is refused as request.invalid_options', async () => {
		const action = await loadAction();
		await expect(action.handler(contextOf({}))).rejects.toThrow(/bounding box/);
	});
});
