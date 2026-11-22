// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0


/**
* TOOL_ERROR_REPORT
*
* Barrel entry-point for the tool_error_report module.
*
* Re-exports the `tool_error_report` constructor (and every public symbol of
* `tool_error_report.js`) so callers import from the stable path
* `tools/tool_error_report/js/index.js` without depending on the internal
* module layout.
*
* The named export `tool_error_report` MUST match the model string that the
* instance loader (`instances.js`) uses to resolve and instantiate the tool;
* renaming or aliasing it here would silently break tool instantiation.
*
* Administrators-only: report a problem (page context + captured JS errors +
* description) to this installation, which stores it and emails it when configured. Server half:
* server/index.ts (action 'send_report').
*/



export * from './tool_error_report.js'



// @license-end
