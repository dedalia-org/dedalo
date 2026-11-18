/**
 * tool_uca_maps — port of v6 `tool_leaflet_special_tools`. Every action is
 * `record_tipo` at read level: none writes section data. The image actions name
 * the IMAGE record, whose media path they disclose; `stage_external_image` is
 * the one write-level gate, since it exists only to change the map record. Not
 * readOnly: it and the three that delete the payload they were staged
 * (`raster_download`, `vector_download`, `object_pdf_report`). The rest write
 * only scratch.
 */

import type { ToolServerModule } from '../../../src/core/tools/module.ts';
import { getAdministrativeUnit } from './administrative_units.ts';
import { getCapabilities } from './capabilities.ts';
import { getCatastroParcel } from './catastro.ts';
import { getElevation } from './elevation.ts';
import { stageExternalImage } from './external_image.ts';
import { startScratchSweep } from './gdal.ts';
import { imageDownload } from './image_download.ts';
import { getImageFile } from './image_media.ts';
import { getImageOverlay } from './image_overlay.ts';
import { objectPdfReport } from './pdf_report.ts';
import { searchPlaces } from './place_search.ts';
import { rasterDownload } from './raster_download.ts';
import { REASON_KEYS } from './reasons.ts';
import { getPleiadesPlace, searchDare, searchPelagios, searchPleiades } from './roman_empire.ts';
import { vectorDownload } from './vector_download.ts';
import { uploadVectorLayer } from './vector_upload.ts';
import { getWmsLayers } from './wms.ts';

export const tool: ToolServerModule = {
	name: 'tool_uca_maps',
	reasonKeys: REASON_KEYS,
	apiActions: {
		get_capabilities: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: getCapabilities,
		},
		// not readOnly: it deletes the staged GeoJSON it reads (see raster_download)
		vector_download: {
			permission: 'record_tipo',
			minLevel: 1,
			handler: vectorDownload,
		},
		// not readOnly: it deletes the staged capture it reads, so a resend must be
		// replayed from the ledger, never run again on a capture already gone
		raster_download: {
			permission: 'record_tipo',
			minLevel: 1,
			handler: rasterDownload,
		},
		get_wms_layers: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: getWmsLayers,
		},
		get_catastro_parcel: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: getCatastroParcel,
		},
		get_administrative_unit: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: getAdministrativeUnit,
		},
		upload_vector_layer: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: uploadVectorLayer,
		},
		get_image_overlay: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: getImageOverlay,
		},
		// options name the IMAGE record, as get_image_overlay's do
		image_download: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: imageDownload,
		},
		search_places: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: searchPlaces,
		},
		get_elevation: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: getElevation,
		},
		get_image_file: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: getImageFile,
		},
		stage_external_image: { permission: 'record_tipo', minLevel: 2, handler: stageExternalImage },
		// not readOnly: it deletes the staged GeoJSON it reads (see raster_download)
		object_pdf_report: {
			permission: 'record_tipo',
			minLevel: 1,
			handler: objectPdfReport,
		},
		search_pleiades: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: searchPleiades,
		},
		get_pleiades_place: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: getPleiadesPlace,
		},
		search_pelagios: {
			permission: 'record_tipo',
			minLevel: 1,
			readOnly: true,
			handler: searchPelagios,
		},
		search_dare: { permission: 'record_tipo', minLevel: 1, readOnly: true, handler: searchDare },
	},
	// Only meaningful on a component_geolocation caller — matches the tool's
	// affected_models declaration in register.json; belt-and-braces because
	// affected_models governs the STAMP (whether the button ships at all), not
	// what a directly-addressed tool_request would accept.
	isAvailable: (context) => context.callerModel === 'component_geolocation',
	onBoot: () => startScratchSweep(),
};
