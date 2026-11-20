// Stub of client/dedalo/core/common/js/utils/index.js
export const clone = (value) =>
	value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
export const dd_console = () => {};
export const is_equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const load_style = () => {};
export const load_script = () => {};
export const strip_tags = (value) => String(value ?? '').replace(/<[^<>]*>/g, '');
// common.js reads it to decide which face a position shows (value or fallback)
export const is_empty_entry = (entry) => {
	if (!entry || typeof entry !== 'object') return true;
	const value = typeof entry.value === 'string' ? entry.value.trim() : entry.value;
	return value === undefined || value === null || value === '' || value === false
		? true
		: Array.isArray(value) && value.length === 0;
};
// records each cross-window save notice, so a gate can assert run_save's order
export const broadcast_calls = [];
export const broadcast_record_save = (type) => {
	broadcast_calls.push(type);
};
