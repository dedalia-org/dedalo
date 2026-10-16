/**
 * tool_uca_maps — every action's declared gate, in one table. A downgrade to a
 * plain 'section'/'tipo' kind silently drops half of the record_tipo check, and
 * a handler that is not the module function may skip it; an action added or
 * dropped without its row is red here too.
 */

import { describe, expect, test } from 'bun:test';
import type { GatedToolActionSpec, ToolActionSpec } from '../../src/core/tools/module.ts';
import { getAdministrativeUnit } from '../../tools/tool_uca_maps/server/administrative_units.ts';
import { getCapabilities } from '../../tools/tool_uca_maps/server/capabilities.ts';
import { getCatastroParcel } from '../../tools/tool_uca_maps/server/catastro.ts';
import { getElevation } from '../../tools/tool_uca_maps/server/elevation.ts';
import { stageExternalImage } from '../../tools/tool_uca_maps/server/external_image.ts';
import { imageDownload } from '../../tools/tool_uca_maps/server/image_download.ts';
import { getImageFile } from '../../tools/tool_uca_maps/server/image_media.ts';
import { getImageOverlay } from '../../tools/tool_uca_maps/server/image_overlay.ts';
import { objectPdfReport } from '../../tools/tool_uca_maps/server/pdf_report.ts';
import { searchPlaces } from '../../tools/tool_uca_maps/server/place_search.ts';
import { rasterDownload } from '../../tools/tool_uca_maps/server/raster_download.ts';
import {
	getPleiadesPlace,
	searchDare,
	searchPelagios,
	searchPleiades,
} from '../../tools/tool_uca_maps/server/roman_empire.ts';
import { vectorDownload } from '../../tools/tool_uca_maps/server/vector_download.ts';
import { uploadVectorLayer } from '../../tools/tool_uca_maps/server/vector_upload.ts';
import { getWmsLayers } from '../../tools/tool_uca_maps/server/wms.ts';
import { loadTool } from './fixtures/tool_uca_maps/helpers.ts';

interface Gate {
	permission: GatedToolActionSpec['permission'] | null;
	minLevel?: number;
	/** The module function the action must dispatch to. */
	handler: ToolActionSpec['handler'];
}

const READ = { permission: 'record_tipo', minLevel: 1 } as const;

const GATES: Readonly<Record<string, Gate>> = {
	get_capabilities: { ...READ, handler: getCapabilities },
	vector_download: { ...READ, handler: vectorDownload },
	raster_download: { ...READ, handler: rasterDownload },
	get_wms_layers: { ...READ, handler: getWmsLayers },
	get_catastro_parcel: { ...READ, handler: getCatastroParcel },
	get_administrative_unit: { ...READ, handler: getAdministrativeUnit },
	upload_vector_layer: { ...READ, handler: uploadVectorLayer },
	// these three name the IMAGE record, whose media path the answer discloses
	get_image_overlay: { ...READ, handler: getImageOverlay },
	image_download: { ...READ, handler: imageDownload },
	get_image_file: { ...READ, handler: getImageFile },
	search_places: { ...READ, handler: searchPlaces },
	get_elevation: { ...READ, handler: getElevation },
	// the one write: it exists only to change the map record
	stage_external_image: { permission: 'record_tipo', minLevel: 2, handler: stageExternalImage },
	object_pdf_report: { ...READ, handler: objectPdfReport },
	search_pleiades: { ...READ, handler: searchPleiades },
	get_pleiades_place: { ...READ, handler: getPleiadesPlace },
	search_pelagios: { ...READ, handler: searchPelagios },
	search_dare: { ...READ, handler: searchDare },
};

describe('tool_uca_maps — the declared gate of every action', () => {
	test('the table names exactly the registered actions, none more, none less', async () => {
		const { apiActions } = await loadTool();
		expect(Object.keys(apiActions).sort()).toEqual(Object.keys(GATES).sort());
	});

	test.each(Object.entries(GATES))('%s', async (name, gate) => {
		const action = (await loadTool()).apiActions[name];
		expect(action).toBeDefined();
		const spec = action as ToolActionSpec;
		expect(spec.permission).toBe(gate.permission);
		expect(spec.minLevel).toBe(gate.minLevel);
		if (gate.permission === null) {
			expect((spec as { gatedInHandler?: string }).gatedInHandler?.trim()).toBeTruthy();
		} else {
			expect('gatedInHandler' in spec).toBe(false);
		}
		expect(spec.handler).toBe(gate.handler);
	});
});
