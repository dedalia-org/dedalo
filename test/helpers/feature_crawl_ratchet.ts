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
		'root:rsc370:list:api:ontology.invalid_node',
		'rsc370 names the v6 table matrix_structurations (dd489) in the VENDORED ontology release; fixed on the master ontology 2026-10-28 (relation removed, node marked [DEPRECATED]) — remove this entry when the vendored release is refreshed',
	],
	[
		'root:test5977:list:api:ontology.invalid_node',
		'test5977 node is unusable (ontology.invalid_node) — suite ontology data defect, follow-up',
	],
	[
		'root:tools@section:tool:tool_identify:api:identify.no_profile',
		'the suite DB holds no identify profile / image index; tool_identify answers identify.no_profile',
	],
]);

/**
 * INTERMITTENT: real bugs that do not reproduce on every run (a race in the
 * client or the server). Tolerated when they fail, NOT called stale when they
 * pass — KNOWN_FAILING's shrink-only check would flap on them. Leaves this list
 * only when the bug is fixed; `--strict` ignores it too.
 */
export const INTERMITTENT: ReadonlyMap<string, string> = new Map<string, string>([]);
