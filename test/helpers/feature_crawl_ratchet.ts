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

/**
 * COVERAGE FLOORS — engineering/crawl_inventory.json. A full gate run must visit at
 * least `page_floor` pages and run at least `check_floor` checks: without it a crawl
 * that quietly stopped reaching a menu branch (or a persona) would still be green.
 * Banked by `bun run test:crawl --update` after a GREEN full run; a floor only rises —
 * a legitimate drop is a hand edit whose commit says what went and why.
 */
export const CRAWL_INVENTORY_PATH = 'engineering/crawl_inventory.json';

export const CRAWL_INVENTORY_RULE =
	'SHRINK-ONLY coverage floor for the feature crawl (bun run test:crawl). A FULL gate run (no --only/--persona/--max/--journey/--no-journeys, not --audit) must visit at least page_floor pages and run at least check_floor checks, or it is red. Banked by `bun run test:crawl --update` after a green full run at the observed counts less a run-to-run slack (2% pages, 3% checks), never lowering a floor; a legitimate drop is a hand edit whose commit says what went and why. Read by scripts/feature_crawl.ts and test/unit/feature_crawl_tripwire.test.ts.';

export interface CrawlInventory {
	rule: string;
	page_floor: number;
	check_floor: number;
}

/** The shortfalls of one full run against the record (empty = covered). */
export function crawlCoverageShortfalls(
	floor: CrawlInventory,
	observed: { pages: number; checks: number },
): string[] {
	const short: string[] = [];
	if (observed.pages < floor.page_floor)
		short.push(`visited ${observed.pages} pages, the floor is ${floor.page_floor}`);
	if (observed.checks < floor.check_floor)
		short.push(`ran ${observed.checks} checks, the floor is ${floor.check_floor}`);
	return short;
}

/**
 * Run-to-run noise the floors allow: lazily rendered components and tool offers make
 * the CHECK count drift ~1-2% between identical green runs (7358 / 7263 measured
 * 2026-10-28, pages 790 / 791). A floor at the exact count would flap; a lost menu
 * branch or persona drops far more than this.
 */
export const CRAWL_FLOOR_SLACK = { pages: 0.02, checks: 0.03 } as const;

/** The record a green full run banks: each floor rises (to the observed count less the slack), never falls. */
export function bankCrawlInventory(
	floor: CrawlInventory,
	observed: { pages: number; checks: number },
): CrawlInventory {
	return {
		rule: CRAWL_INVENTORY_RULE,
		page_floor: Math.max(
			floor.page_floor,
			Math.floor(observed.pages * (1 - CRAWL_FLOOR_SLACK.pages)),
		),
		check_floor: Math.max(
			floor.check_floor,
			Math.floor(observed.checks * (1 - CRAWL_FLOOR_SLACK.checks)),
		),
	};
}
