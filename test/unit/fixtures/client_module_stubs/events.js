// Stub of client/dedalo/core/common/js/events.js
export const set_before_unload = () => {};
export const dd_request_idle_callback = (fn) => fn();
export const register_unsaved_instance = () => {};
export const deregister_unsaved_instance = () => {};
export const reset_unsaved_data = () => {};
export const get_unsaved_instances = () => [];
export const orphaned_unsaved = new Set();
// the real one hands its capability out ONCE; the stub never refuses
export const claim_orphaned_unsaved_writers = () =>
	Object.freeze({ add: () => true, delete: () => false });
