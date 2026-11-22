/**
 * THE SPLIT LANES of a request-language gate (T2 B10 review M1).
 *
 * A request carries TWO languages — the interface (application) lang and the
 * component-data lang (`src/core/resolve/request_lang.ts`). A gate that sets
 * both to the same value cannot tell which one a site reads: a site that reads
 * the WRONG kind answers the right value and stays green. So every
 * request-language gate runs its call under BOTH lanes below, where the two
 * kinds always differ and swap places, and asserts the kind the site is RULED
 * to follow. A site reading the other kind is red in both lanes; a site reading
 * the install default (or a literal) is red in at least one.
 */

import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';

/** One lane: the two request langs, never equal. */
export interface SplitLane {
	readonly dataLang: string;
	readonly applicationLang: string;
}

/** Both lanes: data ≠ application, and the second lane swaps them. */
export const SPLIT_LANES: readonly SplitLane[] = [
	{ dataLang: 'lg-eng', applicationLang: 'lg-spa' },
	{ dataLang: 'lg-spa', applicationLang: 'lg-eng' },
];

/** Run `fn` inside `lane`'s request scope. */
export function inSplitLane<T>(lane: SplitLane, fn: () => T): T {
	return runWithRequestLangs(lane, fn);
}

/** The lane as an assertion label: `data=lg-eng app=lg-spa`. */
export function laneLabel(lane: SplitLane): string {
	return `data=${lane.dataLang} app=${lane.applicationLang}`;
}
