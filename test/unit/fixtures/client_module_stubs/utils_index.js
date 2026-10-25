// Stub of client/dedalo/core/common/js/utils/index.js
export const clone = (value) =>
	value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
export const dd_console = () => {};
export const is_equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const load_style = () => {};
export const load_script = () => {};
export const strip_tags = (value) => String(value ?? '').replace(/<[^<>]*>/g, '');
