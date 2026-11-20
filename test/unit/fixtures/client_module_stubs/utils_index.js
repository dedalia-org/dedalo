// Stub of client/dedalo/core/common/js/utils/index.js
import { readFileSync } from 'node:fs';
export const clone = (value) =>
	value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
export const dd_console = () => {};
export const is_equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const load_style = () => {};
export const load_script = () => {};
export const strip_tags = (value) => String(value ?? '').replace(/<[^<>]*>/g, '');
// common.js reads it to decide which face a position shows (value or fallback).
// The REAL rule, sliced from util.js (as render_escape_tripwire's loader does):
// a copy here drifted once — it lacked the rich-text ghosts, so a gate driving
// common.js saw `<p></p>` as a value where the client shows the fallback.
const UTIL = new URL('../../../../client/dedalo/core/common/js/utils/util.js', import.meta.url);
const util_source = readFileSync(UTIL, 'utf8');
const empty_start = util_source.indexOf('const RICH_TEXT_GHOSTS');
const empty_end = util_source.indexOf('}//end is_empty_entry');
if (empty_start === -1 || empty_end < empty_start)
	throw new Error(`${UTIL.pathname}: is_empty_entry (with RICH_TEXT_GHOSTS) not found`);
export const is_empty_entry = new Function(
	`${util_source.slice(empty_start, empty_end + 1).replace(/^export const /gm, 'const ')}\nreturn is_empty_entry`,
)();
// records each cross-window save notice, so a gate can assert run_save's order
export const broadcast_calls = [];
export const broadcast_record_save = (type) => {
	broadcast_calls.push(type);
};
