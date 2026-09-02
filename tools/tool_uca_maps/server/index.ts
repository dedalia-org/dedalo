/**
 * tool_uca_maps server module — port of v6 `tool_leaflet_special_tools`
 * (Museu de Prehistòria de València / hispanicode-UCA), targeting v7 native.
 *
 * Plan: `plan_implementacion.md` (repo root, sibling of `dedalo/`). Diary:
 * `docs/DIARY.md` (this dir — local, never committed).
 *
 * HITO 1 SCOPE (vertical slice): `get_capabilities` only. The remaining ~17
 * actions of the plan §3.2 matrix land in hitos 2-4; this file grows one
 * apiActions entry per hito, never all at once (CLAUDE.local.md protocol).
 *
 * `get_capabilities` has no PHP oracle (plan §3.2: "nueva"). It answers ONE
 * question — is GDAL/ImageMagick present on this install — so the client can
 * grey out format-conversion buttons before hito 3 wires them, instead of a
 * user hitting a mid-conversion 500. Permission `record_tipo`: the caller is
 * a live component_geolocation instance bound to one record (plan §3.2 table),
 * so both halves apply — write is never asserted (minLevel 1: it changes
 * nothing, an install merely being ASKED what it has is a read).
 */

import { ok } from '../../../src/core/errors/index.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import { probeCapabilities } from './capabilities.ts';

async function getCapabilities(context: ToolActionContext): Promise<ToolResponse> {
	const capabilities = await probeCapabilities();
	return ok(capabilities, { requestId: toolRequestId(context) });
}

export const tool: ToolServerModule = {
	name: 'tool_uca_maps',
	apiActions: {
		get_capabilities: { permission: 'record_tipo', minLevel: 1, handler: getCapabilities },
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
