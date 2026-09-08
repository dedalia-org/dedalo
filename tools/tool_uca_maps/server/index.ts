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
 */

import { ok } from '../../../src/core/errors/index.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { probeCapabilities } from './capabilities.ts';
import { rasterDownload } from './raster_download.ts';
import { vectorDownload } from './vector_download.ts';
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
