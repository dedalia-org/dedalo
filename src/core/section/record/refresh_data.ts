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
	const actions = body.actions;
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
	if (
		entry.arguments !== undefined &&
		!(Array.isArray(entry.arguments) && entry.arguments.length === 0)
	) {
		return refusal(
			'arguments_not_empty',
			`${at}.arguments must be absent or []; empty_data takes no arguments`,
		);
	}
	return { condition: 'on_empty', action: 'empty_data' };
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return `an array of ${value.length}`;
	return typeof value;
}

/**
 * THE TRIGGER — did the observed value CHANGE? Decided from the change the
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
	if (beforeKeys.size > 0 || savedKeys.size > 0) {
		for (const key of savedKeys) if (!beforeKeys.has(key)) return true;
		for (const key of beforeKeys) if (!savedKeys.has(key)) return true;
		return false;
	}
	return !canonicalEquals([...change.before], [...change.saved]);
}

/** `section_tipo|section_id` of every edge locator in a value (a dd490 frame is not an edge). */
function edgeTargetKeys(value: readonly unknown[]): Set<string> {
	const keys = new Set<string>();
	for (const entry of value) {
		if (entry === null || typeof entry !== 'object') continue;
		const locator = entry as { section_tipo?: unknown; section_id?: unknown; type?: unknown };
		if (typeof locator.section_tipo !== 'string' || locator.section_id === undefined) continue;
		if (locator.type === DATAFRAME_RELATION_TYPE) continue;
		keys.add(`${locator.section_tipo}|${String(locator.section_id)}`);
	}
	return keys;
}
