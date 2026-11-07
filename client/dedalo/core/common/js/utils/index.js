// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
// export * from 'shared/util'

/**
* UTILS — barrel entry-point for core/common/js/utils/
*
* Re-exports all public symbols from the two utility sub-modules so that
* consumers need a single import path:
*
*   import { clone, pause, load_script, create_cookie } from '…/utils/index.js'
*
* Sub-modules:
*   ./cookie.js  — localStorage wrappers (create_cookie, read_cookie, erase_cookie).
*                  Despite the "cookie" name, all persistence goes through localStorage,
*                  not HTTP cookies.
*   ./util.js    — General-purpose browser utilities: deep equality (is_equal,
*                  array_equals, object_equals), DOM helpers (append_text_lines, find_up_node,
*                  find_up_tag, load_style, load_script, observe_changes),
*                  URL helpers (object_to_url_vars, url_vars_to_object),
*                  window management (open_window, open_window_with_post,
*                  open_filtered_window, open_records_in_window,
*                  prevent_open_new_window,
*                  download_file), formatting (bytes_format, printf,
*                  time_unit_auto, get_font_fit_size), ontology helpers
*                  (get_tld_from_tipo, get_section_id_from_tipo,
*                  get_caller_by_model, tool_base_url, tool_css_url), and misc
*                  helpers (clone, dd_console, JSON_parse_safely, pause,
*                  wait_for_global, strip_tags, generate_hash, get_json_langs,
*                  group_objects_by).
*
* Adding a new utility: place the implementation in the appropriate sub-module
* (or create a new one and add its `export *` line here). Do not add
* implementation directly to this file.
*/

export * from './cookie.js'
export * from './util.js'


// @license-end
