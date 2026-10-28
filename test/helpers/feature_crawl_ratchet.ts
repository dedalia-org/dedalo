/**
 * FEATURE CRAWL BASELINE — scripts/feature_crawl.ts.
 *
 * KNOWN_FAILING: finding ids the gate tolerates today, each with its reason.
 * SHRINK-ONLY: a listed id that no longer fails is red too (remove it), so the
 * list can only record debt that still exists. Ids are
 * `<persona>:<section_tipo>:<mode>:<check>` exactly as the crawl report prints
 * them; `--strict` ignores this list.
 */
export const KNOWN_FAILING: ReadonlyMap<string, string> = new Map<string, string>([
	[
		'root:test6402:area:api:resource.conflict',
		'section_tool test6402 has no config.target_section_tipo — suite ontology data defect (test TLD), refused loudly by start',
	],
	[
		'root:rsc370:list:api:ontology.invalid_node',
		'rsc370 names the v6 table matrix_structurations (dd489) in the VENDORED ontology release; fixed on the master ontology 2026-10-28 (relation removed, node marked [DEPRECATED]) — remove this entry when the vendored release is refreshed',
	],
	[
		'root:test5977:list:api:ontology.invalid_node',
		'test5977 node is unusable (ontology.invalid_node) — suite ontology data defect, follow-up',
	],
	[
		'root:dd15:edit:components',
		'Time Machine (dd15) has no edit view by design (consultation-only); the crawl still visits it — crawler should skip, follow-up',
	],
	['root:dd15:edit:inspector', 'same as root:dd15:edit:components'],
	[
		'root:tools@section:tool:tool_identify:api:identify.no_profile',
		'the suite DB holds no identify profile / image index; tool_identify answers identify.no_profile',
	],
	[
		'root:tools@component_json:tool:tool_error:tool_upload',
		'tool_upload offered on a component_json crashes (allowed_extensions undefined) — client bug, follow-up',
	],
	[
		'root:tools@component_image:tool:tool_error:tool_transcription',
		'tool_transcription crashes on open (null.model) from media callers — client bug, follow-up',
	],
	[
		'root:tools@component_av:tool:tool_error:tool_transcription',
		'same as root:tools@component_image:tool:tool_error:tool_transcription',
	],
	[
		'root:tools@component_pdf:tool:tool_error:tool_transcription',
		'same as root:tools@component_image:tool:tool_error:tool_transcription',
	],
	[
		'admin:test1:menu:orphan',
		'test1 sits under the developer-only dd770 in the suite ontology; non-developers see the child without its parent',
	],
	['editor:test1:menu:orphan', 'same as admin:test1:menu:orphan'],
	[
		'editor:ontology40:menu:orphan',
		'ontology40 sits under dd5, not offered to a non-admin; the child is visible without its parent — follow-up',
	],
]);

/**
 * INTERMITTENT: real bugs that do not reproduce on every run (a race in the
 * client or the server). Tolerated when they fail, NOT called stale when they
 * pass — KNOWN_FAILING's shrink-only check would flap on them. Leaves this list
 * only when the bug is fixed; `--strict` ignores it too.
 */
export const INTERMITTENT: ReadonlyMap<string, string> = new Map<string, string>([
	[
		'root:tools@component_inverse:tool:tool_time_machine:js_error',
		'tool_time_machine opened from a component_inverse throws self.update_datum is not a function — client bug, follow-up',
	],
	[
		'root:tools@menu:tool:tool_error:tool_user_admin',
		'tool_user_admin opened from the menu answers client.bad_response (unreadable body) — engine/client bug, follow-up',
	],
	[
		'root:tools@menu:tool:tool_user_admin:error_panel',
		'same as root:tools@menu:tool:tool_error:tool_user_admin',
	],
]);
