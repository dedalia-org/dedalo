// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0


/**
* TOOL_IMPORT_ZOTERO — index.js
* Entry-point barrel for the tool_import_zotero ES module.
*
* Re-exports every named export from tool_import_zotero.js so that the
* instances.js loader can resolve the tool by its canonical model string
* ('tool_import_zotero') using a single, stable import path:
*
*   import {tool_import_zotero} from '.../tool_import_zotero/js/index.js'
*
* This tool imports bibliographic records from a Zotero JSON export (CSL-JSON
* format) into a Dédalo section (default: rsc205, Publications).  It works
* as follows:
*
*   1. The operator exports records from Zotero as JSON (CSL-JSON format).
*   2. Files (JSON + optional companion PDFs) are staged via service_upload
*      (multi-file queue mode).
*   3. Default metadata values for the batch are collected through
*      service_tmp_section (DDO entries with role 'input_component').
*   4. On import the server PHP class maps each Zotero field to the configured
*      Dédalo component tipos using the tool_config 'map' array (stored in dd1633).
*   5. The server action 'import_files' is dispatched through dd_tools_api and
*      may run as a long-running background task; the client waits up to one hour.
*
* Section-id control:
*   By default the tool reads Zotero's 'call-number' field as the target
*   section_id: a whole number there addresses that record (updated, or
*   created at that id); anything else refuses the item. Without it a
*   reference is matched by its Zotero key, stored in the component the map's
*   'id' entry names. The field is configurable via the tool_config property
*   'field_to_section_id' (see sample_config.json and register.json → dd1633).
*
* PDF attachment:
*   Set the Zotero 'archive' field to the PDF filename and upload the PDF
*   alongside the JSON file.  The server locates the staged PDF by its name
*   and attaches it to the imported record.
*
* Typology mapping:
*   The tool_config 'typology' array maps CSL-JSON item types (e.g. 'book',
*   'article-journal') to Dédalo section_id / section_tipo pairs in the
*   typology section (dd810).
*
* Main exports (from tool_import_zotero.js):
*   - tool_import_zotero  — constructor + prototype chain for the Zotero import tool instance
*
* Related modules in this directory:
*   - tool_import_zotero.js         — tool constructor, prototype assignments (init, build)
*   - render_tool_import_zotero.js  — DOM/view rendering (upload queue, input components,
*                                     import button, post-import message)
*/


export * from './tool_import_zotero.js'


// @license-end
