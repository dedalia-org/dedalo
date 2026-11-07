/**
 * READ_DOOR_PROBED — the bridge between READ_DOOR_POSTURE's `component` rows
 * (src/core/security/read_door.ts) and the behavioural legs that exercise them
 * (test/unit/read_door_acl_native.test.ts), closure Step 3.
 *
 * A posture row's `gate: READ_DOOR_GATE` is a LABEL; on its own it proves
 * nothing (relabelling a row is a one-word edit no gate noticed). So:
 *
 *   - the authorization-door matrix (authz_door_matrix_native) counts a
 *     `component` row as DELEGATED only when its key is in READ_DOOR_PROBED;
 *   - read_door_acl_native registers each door here as its leg COMPLETES (after
 *     every assertion of the pair passed — `markReadDoorProbed`), and its last
 *     test asserts the set of completed doors EQUALS READ_DOOR_PROBED.
 *
 * So a row relabelled `component` without a leg is red in the matrix, and a key
 * added here without a leg that runs to completion is red in the native gate.
 *
 * Lives in a helper, not in either test file: a test file imported by another
 * registers its tests twice.
 */

/** The `component` doors read_door_acl_native exercises with a behavioural pair. */
export const READ_DOOR_PROBED: ReadonlySet<string> = new Set([
	'dd_core_api:read_raw',
	'dd_core_api:get_element_context',
	'dd_component_av_api:get_media_streams',
	'dd_component_av_api:download_fragment',
	'dd_identify_api:find_matches',
	'dd_identify_api:identify_by_image',
	'mcp:dedalo_search_section',
	'mcp:dedalo_search_records',
	'mcp:dedalo_count_records',
	'mcp:dedalo_find_or_create',
	'mcp:dedalo_read_record',
	'mcp:dedalo_get_media_info',
	'http:GET /dedalo/core/api/v1/raw',
	'http:GET /dedalo/core/api/v1/map_tile',
]);

const completed = new Set<string>();

/** Record that one door's behavioural leg ran to completion (call it LAST in the leg). */
export function markReadDoorProbed(door: string): void {
	completed.add(door);
}

/** The doors whose legs completed in this process. */
export function readDoorLegsCompleted(): ReadonlySet<string> {
	return completed;
}
