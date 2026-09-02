// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0



/**
* TOOL_UCA_MAPS
*
* Barrel entry-point for the tool_uca_maps module (native v7 port of v6
* `tool_leaflet_special_tools`, Museu de Prehistòria de València /
* hispanicode-UCA — `plan_implementacion.md` in the repo root).
*
* Re-exports the `tool_uca_maps` constructor and every other public symbol
* defined in `tool_uca_maps.js`, so callers import from the stable path
* `tools/tool_uca_maps/js/index.js` without depending on the internal module
* layout.
*
* The named export `tool_uca_maps` MUST match the model string the instance
* loader (`instances.js`) uses to resolve and instantiate the tool.
*/



export * from './tool_uca_maps.js'



// @license-end
