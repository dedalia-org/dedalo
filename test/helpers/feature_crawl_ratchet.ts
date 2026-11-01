/**
 * FEATURE CRAWL BASELINE — scripts/feature_crawl.ts.
 *
 * KNOWN_FAILING: finding ids the gate tolerates today, each with its reason.
 * SHRINK-ONLY: a listed id that no longer fails is red too (remove it), so the
 * list can only record debt that still exists. Ids are
 * `<persona>:<section_tipo>:<mode>:<check>` exactly as the crawl report prints
 * them; `--strict` ignores this list.
 */
export const KNOWN_FAILING: ReadonlyMap<string, string> = new Map<string, string>([]);

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

/**
 * PAGE POSTURE BUDGET — engineering/crawl_posture_budget.json. Every page the crawl
 * visits is checked for accessibility (axe, critical impact), keyboard reach and
 * phone-width overflow; the existing debt is counted PER RULE (pages breaking it),
 * not listed per page. A rule not in the budget, or more pages than budgeted, is red.
 * `--update` after a green full run LOWERS a budget to what was observed; a budget
 * never rises except by a hand edit whose commit says why. Bootstrapped once.
 */
export const CRAWL_POSTURE_PATH = 'engineering/crawl_posture_budget.json';

export const CRAWL_POSTURE_RULE =
	'SHRINK-ONLY per-rule budget of pages failing a posture check in the feature crawl (bun run test:crawl): a11y:<axe rule> (critical impact), keyboard (Tab never leaves the body), phone_overflow (sideways scroll at 360px). A rule missing here, or more pages than its budget, is red; `bun run test:crawl --update` after a green FULL run lowers each budget to the observed count and drops a rule no page breaks any more. A budget rises only by a hand edit whose commit says why. Read by scripts/feature_crawl.ts and test/unit/feature_crawl_tripwire.test.ts.';

export interface CrawlPostureBudget {
	rule: string;
	budgets: Record<string, number>;
}

/** Over-budget and unbudgeted rules (red), given pages-per-rule observed. */
export function postureOverruns(
	budget: CrawlPostureBudget,
	observed: Record<string, number>,
): string[] {
	return Object.entries(observed)
		.filter(([key, pages]) => pages > (budget.budgets[key] ?? 0))
		.map(([key, pages]) =>
			key in budget.budgets
				? `${key}: ${pages} pages, the budget is ${budget.budgets[key]}`
				: `${key}: ${pages} pages, a rule with no budget`,
		)
		.sort();
}

/** The budget a green full run banks: each count falls to what was observed, never rises. */
export function bankPostureBudget(
	budget: CrawlPostureBudget,
	observed: Record<string, number>,
): CrawlPostureBudget {
	const budgets: Record<string, number> = {};
	for (const key of Object.keys(budget.budgets).sort()) {
		const pages = Math.min(budget.budgets[key] ?? 0, observed[key] ?? 0);
		if (pages > 0) budgets[key] = pages;
	}
	return { rule: CRAWL_POSTURE_RULE, budgets };
}
