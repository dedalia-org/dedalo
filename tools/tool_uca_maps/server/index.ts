/**
 * tool_uca_maps server module — port of v6 `tool_leaflet_special_tools`
 * (Museu de Prehistòria de València / hispanicode-UCA), targeting v7 native.
 *
 * Plan: `plan_implementacion.md` (repo root, sibling of `dedalo/`). Per-hito
 * dossiers: `docs/HITOS.md` index + `docs/hitos/hito_<N>.md` (this dir — local,
 * never committed).
 *
 * HITO 1 SCOPE (vertical slice): `get_capabilities` only.
 * HITO 3 SCOPE: `vector_download` (checkpoint 3a — SHP/KML, GeoJSON stays
 * client-only) + `raster_download` (checkpoint 3b — "download map as image",
 * JPG/GIF/WebP/GeoTIFF; PNG also stays client-only). This file grows one
 * apiActions entry per hito, never all at once (CLAUDE.local.md protocol).
 *
 * `get_capabilities` has no PHP oracle (plan §3.2: "nueva"). It answers ONE
 * question — is GDAL/ImageMagick present on this install — so the client can
 * grey out format-conversion buttons before hito 3 wires them, instead of a
 * user hitting a mid-conversion 500. Permission `record_tipo`: the caller is
 * a live component_geolocation instance bound to one record (plan §3.2 table),
 * so both halves apply — write is never asserted (minLevel 1: it changes
 * nothing, an install merely being ASKED what it has is a read).
 *
 * `vector_download`/`raster_download` get the SAME `record_tipo`/minLevel-1
 * gate: neither writes section data — both transform geometry/pixels the
 * caller's own live component_geolocation instance already holds, into a
 * format a browser cannot produce on its own (see each action's own file for
 * the full design).
 *
 * `get_wms_layers` (fila #6, "WMS services") gets the SAME gate too: it reads
 * a THIRD PARTY WMS server's own GetCapabilities document (via the SSRF-
 * guarded `fetchGuardedText`, see `wms.ts`) — nothing this install owns is
 * written or even read beyond the caller being a scoped, authenticated map
 * viewer.
 *
 * `get_catastro_parcel`/`get_administrative_unit` (filas #8/#9, "Catastro"/
 * "UA") get the SAME gate too, one notch simpler: both hosts are FIXED
 * literals this tool's own server files build (`catastro.ts`/
 * `administrative_units.ts`), never a client-supplied URL, so there is no
 * SSRF surface beyond the guarded fetch itself.
 *
 * `upload_vector_layer` (fila #11, "Upload file to map" — vector half, hito
 * 12) gets the SAME gate too: it converts an already-staged upload (owned by
 * the authenticated caller, confined to their own staging dir — see
 * `vector_upload.ts`) to GeoJSON and hands it back; nothing is written to
 * section data here either — the resulting objects only persist through the
 * geolocation component's own normal save, same as every other pm:create-
 * based action in this tool.
 *
 * `get_image_overlay` (fila #11, IMAGE half — hito 13) is the one action whose
 * gate names a DIFFERENT record than the map's: its options carry the identity
 * of the image component the client just created (rsc29/rsc170), so the
 * `record_tipo`/minLevel-1 check asserts the caller may read THAT section —
 * which is the right question, since the answer names a media path they will
 * then load. It writes nothing: the file was already ingested through the
 * engine's own door (`tool_upload::process_uploaded_file`), and this only
 * reports where on the map it belongs (see `image_overlay.ts`).
 */

import { ok } from '../../../src/core/errors/index.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { getAdministrativeUnit } from './administrative_units.ts';
import { probeCapabilities } from './capabilities.ts';
import { getCatastroParcel } from './catastro.ts';
import { getElevation } from './elevation.ts';
import { getImageFile } from './image_media.ts';
import { getImageOverlay } from './image_overlay.ts';
import { objectPdfReport } from './pdf_report.ts';
import { searchPlaces } from './place_search.ts';
import { rasterDownload } from './raster_download.ts';
import { vectorDownload } from './vector_download.ts';
import { uploadVectorLayer } from './vector_upload.ts';
import { getWmsLayers } from './wms.ts';

async function getCapabilities(context: ToolActionContext): Promise<ToolResponse> {
	const capabilities = await probeCapabilities();
	return ok(capabilities, { requestId: toolRequestId(context) });
}

export const tool: ToolServerModule = {
	name: 'tool_uca_maps',
	apiActions: {
		get_capabilities: { permission: 'record_tipo', minLevel: 1, handler: getCapabilities },
		vector_download: { permission: 'record_tipo', minLevel: 1, handler: vectorDownload },
		raster_download: { permission: 'record_tipo', minLevel: 1, handler: rasterDownload },
		get_wms_layers: { permission: 'record_tipo', minLevel: 1, handler: getWmsLayers },
		get_catastro_parcel: { permission: 'record_tipo', minLevel: 1, handler: getCatastroParcel },
		get_administrative_unit: {
			permission: 'record_tipo',
			minLevel: 1,
			handler: getAdministrativeUnit,
		},
		upload_vector_layer: { permission: 'record_tipo', minLevel: 1, handler: uploadVectorLayer },
		get_image_overlay: { permission: 'record_tipo', minLevel: 1, handler: getImageOverlay },
		search_places: { permission: 'record_tipo', minLevel: 1, handler: searchPlaces },
		get_elevation: { permission: 'record_tipo', minLevel: 1, handler: getElevation },
		get_image_file: { permission: 'record_tipo', minLevel: 1, handler: getImageFile },
		object_pdf_report: { permission: 'record_tipo', minLevel: 1, handler: objectPdfReport },
	},
	// Only meaningful on a component_geolocation caller — matches the tool's
	// affected_models declaration in register.json; belt-and-braces because
	// affected_models governs the STAMP (whether the button ships at all), not
	// what a directly-addressed tool_request would accept.
	isAvailable: (context) => context.callerModel === 'component_geolocation',
	onRegister: async () => {
		console.log('[tool_uca_maps] registered');
	},
	onRemove: async () => {
		console.log('[tool_uca_maps] removed');
	},
};
