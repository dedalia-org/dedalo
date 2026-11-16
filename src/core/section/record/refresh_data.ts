/**
 * THE `refresh_data` OBSERVER PERFORM — the pure half: its CLOSED parameter
 * grammar and the change trigger (owner ruling 2026-11-13 A4, T1-U05 option A,
 * WC-2026-11-13-observer-refresh-data).
 *
 * The one shipped edge is rsc1214 (`component_select`, a biographical
 * milestone the curator PICKS from the milestones of the person chosen in
 * rsc1156) observing rsc1156 (`component_autocomplete`, the person):
 *
 *   server: { config: { use_self_section: true, use_observable_dato: true },
 *             perform: { function: 'refresh_data',
 *                        params: { actions: [{ condition: 'on_empty', action: 'empty_data' }] } } }
 *
 * WHAT PHP DID (frozen class.component_common.php:2565-2606, v6 identical):
 * per target it built a FRESH observer instance and ran `refresh_data`:
 * `on_empty` ⇒ `if (empty($this->get_observable_data())) { empty_data(); save(); }`.
 * That `observable_data` property was only ever set on the OBSERVABLE (or on
 * the observer in the no-perform branch), never on the fresh instance, so the
 * `on_empty` test was ALWAYS TRUE: every save of the person cleared the
 * milestone and saved it — on the host record AND, through the
 * `self_and_observable` targets, an empty rsc1214 written onto the person's
 * own record (a foreign section). The documented intent ("clear when the
 * observed becomes empty") was never the behaviour; the behaviour, for 20
 * years of production data, was "clear the milestone whenever the person
 * changes" — which for a `data_limit: 1` autocomplete is exactly right: a
 * milestone belongs to a person, and a milestone of the previous person is
 * a value the field's own `fixed_filter` no longer admits.
 *
 * WHAT TS DOES (option A — the effective behaviour, named honestly):
 *   - `on_empty` → `empty_data` CLEARS the observer slot on the HOST record
 *     whenever the observed value CHANGED (a locator added or removed; for a
 *     non-locator value, any difference). The condition's NAME is kept — it
 *     is the ontology's — and its real meaning is documented here, in the WC
 *     entry and in docs/core/system/observers.md. An unchanged re-save does
 *     not clear (gate case g).
 *   - THE DOOR IT FIRES FROM (2026-11-13, review finding): a COMPONENT SAVE
 *     (the ledger's `keys` declaration — PHP's component_common::Save(), the
 *     only place PHP ever ran it) and the cascade hop that re-enters from a
 *     written observer. A WHOLE-RECORD write never triggers it: a birth (a
 *     create with values, a duplicate, an undelete), a `replace` (the Time
 *     Machine's whole-record restore) and a death declare every key of the
 *     record to the ledger, and a destructive clear riding those declarations
 *     wiped the very milestone the same write had just copied or restored —
 *     PHP's section_record never called propagate_to_observers from them.
 *     Counted `observers_refresh_data_skipped` (refreshDataTrigger).
 *   - A SLOT THE SAME OPERATION WROTE is never cleared (observers.ts
 *     applyRefreshDataClear, the guard's `written` set the ledger fills at
 *     enqueue): a CSV import row saving the person AND the milestone in one
 *     transaction drains the person's entry after both writes landed, and the
 *     clear would undo the row's own milestone. PHP propagated synchronously
 *     inside each component save, so there the outcome depended on the column
 *     ORDER (person first: milestone kept; milestone first: cleared); TS keeps
 *     the row's milestone whatever the order. Counted the same way.
 *   - The grammar is CLOSED: `on_empty` / `empty_data` and nothing else.
 *     PHP accepted any `condition` (an unknown one was a SILENT no-op) and any
 *     `action` (`Class::method` — a static call of whatever the ontology
 *     named). TS refuses the unknown LOUDLY, counted
 *     (`observers_refresh_data_refused`), and never calls a function because
 *     the ontology names it (the dispatch-security rule of every closed
 *     table in this engine).
 *   - PHP's write onto the observable's FOREIGN section is NOT ported: the
 *     host precondition (WC-2026-10-30-observer-target-not-host) refuses a
 *     write of the observer where its section does not declare it. A
 *     slot already empty is left alone (PHP saved anyway — elided: no TM
 *     row for a write that changes nothing).
 *
 * The APPLY half (the locked read, the write through the cascade-owned door,
 * the TM pair, the hop) lives in observers.ts `applyRefreshDataClear`, next
 * to the re-save it shares its write tail with.
 */

import { canonicalEquals } from '../../concepts/canonical_json.ts';
import { DATAFRAME_RELATION_TYPE } from '../../concepts/subdatum.ts';
// type-only (erased): the ledger's declaration kinds ARE the origins but 'hop'.
import type { ObservedDeclaration } from '../../section_record/obligation_ledger.ts';

/** The one action the closed grammar admits. */
export interface RefreshDataAction {
	readonly condition: 'on_empty';
	readonly action: 'empty_data';
}

/** The accepted params, normalized. */
export interface RefreshDataParams {
	readonly actions: readonly RefreshDataAction[];
}

/** A refusal of the grammar — reported and counted by the dispatch, nothing written. */
export interface RefreshDataRefusal {
	readonly refused: true;
	readonly reason:
		| 'params_malformed'
		| 'actions_malformed'
		| 'actions_empty'
		| 'condition_unknown'
		| 'action_unknown'
		| 'arguments_not_empty'
		| 'action_key_unknown';
	readonly detail: string;
}

export type ParsedRefreshData = RefreshDataParams | RefreshDataRefusal;

/**
 * WHERE a propagated change comes from — the ledger's declaration kind
 * (section_record/obligation_ledger.ts ObservedDeclaration) or the cascade hop.
 * Read by ONE consumer, the `refresh_data` trigger: a mirror recompute reads
 * truth and is indifferent to the door.
 */
export type ObservedChangeOrigin =
	| Exclude<ObservedDeclaration['kind'], 'none' | 'cascade-owned'>
	| 'hop';

/** The origins the destructive clear fires from — a component save and the hop (see the header). */
const FIRING_ORIGINS: ReadonlySet<ObservedChangeOrigin> = new Set(['keys', 'hop']);

const ACTION_KEYS: ReadonlySet<string> = new Set(['condition', 'action', 'arguments']);

function refusal(reason: RefreshDataRefusal['reason'], detail: string): RefreshDataRefusal {
	return { refused: true, reason, detail };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse `perform.params` against the CLOSED grammar (pure). PHP accepted the
 * params as the object or as a one-item array holding it
 * (class.component_common.php:2481-2484 — `is_array($params) && count === 1`
 * unwrapped); both spellings are accepted here, nothing else is.
 */
export function parseRefreshDataParams(params: unknown): ParsedRefreshData {
	const body = paramsBody(params);
	if ('refused' in body) return body;
	return parseActions(body.actions);
}

/** The params object (PHP's one-item array unwrapped), its keys checked against the grammar. */
function paramsBody(params: unknown): { actions: unknown } | RefreshDataRefusal {
	let body = params;
	if (Array.isArray(body) && body.length === 1) body = body[0];
	if (!isPlainObject(body)) {
		return refusal(
			'params_malformed',
			`perform.params must be an object {actions:[…]} (or a one-item array holding it); got ${describe(params)}`,
		);
	}
	const unknownKeys = Object.keys(body).filter((key) => key !== 'actions');
	if (unknownKeys.length > 0) {
		return refusal(
			'params_malformed',
			`perform.params carries keys outside the closed grammar: ${unknownKeys.join(', ')}`,
		);
	}
	return { actions: body.actions };
}

/** The `actions` list: a non-empty array of well-formed actions, or the first refusal. */
function parseActions(actions: unknown): ParsedRefreshData {
	if (!Array.isArray(actions)) {
		return refusal(
			'actions_malformed',
			`perform.params.actions must be an array; got ${describe(actions)}`,
		);
	}
	if (actions.length === 0) {
		return refusal(
			'actions_empty',
			'perform.params.actions is empty — a refresh_data edge with nothing to do is dead config',
		);
	}
	const parsed: RefreshDataAction[] = [];
	for (const [index, entry] of actions.entries()) {
		const outcome = parseAction(entry, index);
		if ('refused' in outcome) return outcome;
		parsed.push(outcome);
	}
	return { actions: parsed };
}

function parseAction(entry: unknown, index: number): RefreshDataAction | RefreshDataRefusal {
	const at = `actions[${index}]`;
	if (!isPlainObject(entry)) {
		return refusal(
			'actions_malformed',
			`${at} must be an object {condition, action}; got ${describe(entry)}`,
		);
	}
	const unknownKeys = Object.keys(entry).filter((key) => !ACTION_KEYS.has(key));
	if (unknownKeys.length > 0) {
		return refusal(
			'action_key_unknown',
			`${at} carries keys outside the closed grammar: ${unknownKeys.join(', ')}`,
		);
	}
	if (entry.condition !== 'on_empty') {
		return refusal(
			'condition_unknown',
			`${at}.condition '${String(entry.condition)}' is not in the closed grammar (on_empty) — PHP ran an unknown condition as a silent no-op; TS refuses it`,
		);
	}
	if (entry.action !== 'empty_data') {
		return refusal(
			'action_unknown',
			`${at}.action '${String(entry.action)}' is not in the closed grammar (empty_data) — the engine never calls a function because the ontology names it`,
		);
	}
	if (!hasNoArguments(entry.arguments)) {
		return refusal(
			'arguments_not_empty',
			`${at}.arguments must be absent or []; empty_data takes no arguments`,
		);
	}
	return { condition: 'on_empty', action: 'empty_data' };
}

/** `arguments` absent or `[]` — empty_data takes none. */
function hasNoArguments(args: unknown): boolean {
	return args === undefined || (Array.isArray(args) && args.length === 0);
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return `an array of ${value.length}`;
	return typeof value;
}

/** What the trigger decided — the dispatch counts the two declines by name. */
export type RefreshDataTrigger =
	/** A component save (or a hop) whose observed value changed: clear. */
	| 'changed'
	/** An unchanged re-save of the observed: nothing to clear (`observers_refresh_data_unchanged`). */
	| 'unchanged'
	/** A whole-record write (birth / replace / death / recompute): not a door this perform fires from (`observers_refresh_data_skipped`). */
	| 'skipped_origin';

/**
 * THE TRIGGER, whole: the door first (see the header — a whole-record write
 * never fires the clear), then the change. Pure; the dispatch counts the
 * declines.
 */
export function refreshDataTrigger(change: {
	saved: readonly unknown[];
	removed: readonly unknown[];
	before?: readonly unknown[];
	origin: ObservedChangeOrigin;
}): RefreshDataTrigger {
	if (!refreshDataFiresOn(change.origin)) return 'skipped_origin';
	return observedValueChanged(change) ? 'changed' : 'unchanged';
}

/**
 * Every origin, as a Record over the union — EXHAUSTIVE by construction
 * (`satisfies`: a ledger kind added to ObservedDeclaration and not listed here,
 * or a key the union does not carry, does not compile). The runtime set below
 * is DERIVED from it, never hand-maintained beside the type: a member left out
 * of a `new Set([...])` is no type error, and the kernel would refuse every
 * drain of that kind — caught by the ledger drain's post-COMMIT catch, counted
 * `observers_propagation_failed`, every observer of it stale until the
 * reconciler. Twin of obligation_ledger.ts DECLARATION_KINDS; the gate
 * (observer_refresh_data_native) compares the two.
 */
const ORIGIN_KINDS = {
	keys: true,
	replace: true,
	birth: true,
	death: true,
	recompute: true,
	hop: true,
} as const satisfies Record<ObservedChangeOrigin, true>;

/** The closed set of origins (observers.ts ObservedChange.origin) — what the kernel refuses a dispatch outside of. */
export const OBSERVED_CHANGE_ORIGINS: ReadonlySet<ObservedChangeOrigin> = new Set(
	Object.keys(ORIGIN_KINDS) as ObservedChangeOrigin[],
);

/** Is `value` one of the closed origins? (The kernel's runtime half of the REQUIRED `origin`.) */
export function isObservedChangeOrigin(value: unknown): value is ObservedChangeOrigin {
	return typeof value === 'string' && OBSERVED_CHANGE_ORIGINS.has(value as ObservedChangeOrigin);
}

/**
 * Does the perform fire for a change of this origin? A component save (`keys`)
 * and the cascade hop do; a whole-record declaration never. The origin is
 * REQUIRED (owner ruling A4 Q3, 2026-11-13): there is no absent case to read as
 * a component save — a dispatch that names none is refused by the kernel before
 * any edge is looked up (observers.ts propagateToObservers), so a hand-built
 * dispatch (a gate, a script) must say what door it stands for.
 */
export function refreshDataFiresOn(origin: ObservedChangeOrigin): boolean {
	return FIRING_ORIGINS.has(origin);
}

/**
 * THE CHANGE — did the observed value CHANGE? Decided from the change the
 * ledger declared: `removed` (the before-image's locators the save dropped,
 * the ONE removed-set rule) and, when the ledger carries the before-image,
 * the locators the save ADDED (the same rule, the other way round). A value
 * without edge locators (a literal) is compared canonically. Without a
 * before-image (a cascade hop: the observed is itself an observer that just
 * WROTE) the hop IS the change — PHP re-entered propagation from that save
 * unconditionally.
 */
export function observedValueChanged(change: {
	saved: readonly unknown[];
	removed: readonly unknown[];
	before?: readonly unknown[];
}): boolean {
	if (change.removed.length > 0) return true;
	if (change.before === undefined) return true;
	const beforeKeys = edgeTargetKeys(change.before);
	const savedKeys = edgeTargetKeys(change.saved);
	if (beforeKeys.size > 0 || savedKeys.size > 0) return edgeSetsDiffer(beforeKeys, savedKeys);
	return !canonicalEquals([...change.before], [...change.saved]);
}

/** Two edge-target sets differ when one holds a key the other lacks. */
function edgeSetsDiffer(before: ReadonlySet<string>, saved: ReadonlySet<string>): boolean {
	return before.size !== saved.size || [...saved].some((key) => !before.has(key));
}

/** `section_tipo|section_id` of every edge locator in a value (a dd490 frame is not an edge). */
function edgeTargetKeys(value: readonly unknown[]): Set<string> {
	const keys = new Set<string>();
	for (const entry of value) {
		const key = edgeTargetKey(entry);
		if (key !== null) keys.add(key);
	}
	return keys;
}

/** The record an edge locator points at; null for a non-locator or a dd490 frame. */
function edgeTargetKey(entry: unknown): string | null {
	if (entry === null || typeof entry !== 'object') return null;
	const locator = entry as { section_tipo?: unknown; section_id?: unknown; type?: unknown };
	if (typeof locator.section_tipo !== 'string' || locator.section_id === undefined) return null;
	if (locator.type === DATAFRAME_RELATION_TYPE) return null;
	return `${locator.section_tipo}|${String(locator.section_id)}`;
}
