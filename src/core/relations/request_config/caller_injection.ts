/**
 * CALLER-CHILDREN INJECTION — the two pure primitives of PHP get_subdatum's
 * "inheritance request from parent" (frozen class.common.php :2295-2310 the
 * `$get_children_recursive` closure, :2603-2681 the per-engine injection).
 *
 * THE RULE. When a caller (a portal, a section_list, a client show map)
 * declares children UNDER one of its elements, those children REPLACE the
 * element's own ddo_map for that slot. tch197's show map declares rsc1400's
 * children as [rsc86 surname, rsc85 name]; rsc1400's own ontology map says
 * [rsc85, rsc86]. Under tch197 the element resolves surname | name.
 *
 * Two steps, two functions, both PURE (no DB, no ALS, no module state):
 *
 *  1. collectCallerChildren(callerConfig, elementTipo, origin) — per api_engine, the
 *     caller's FIRST item of that engine supplies the children; each of the
 *     four slots (show / search / choose / hide) is walked on its own:
 *       - parent-only match (`ddo.parent === <tipo>`; section_tipo is never
 *         consulted — PHP compares parent alone);
 *       - depth-first, caller order: a child is followed immediately by its
 *         own descendants, then the next sibling;
 *       - duplicates KEPT: the same tipo reached through two parents (the
 *         tch197 diamond — rsc85/rsc86 under both rsc1400 and rsc1402) or
 *         declared twice with two section_tipos appears twice, exactly as PHP;
 *       - the ONLY cut is a real cycle on the ANCESTOR PATH (a → b → a): PHP
 *         recurses until memory runs out, TS stops at the repeat. A global
 *         "seen" set would be wrong — it is what dropped rsc1402's children in
 *         the retired collectCallerDescendants (section/read.ts).
 *
 *  2. injectCallerChildren(baseConfig, children) — onto the element's own
 *     config (the base): for each engine the caller supplied, the element's
 *     FIRST item of that engine gets each NON-EMPTY slot replaced; an empty
 *     slot leaves the element's own map standing; a missing search / choose /
 *     hide block is created as `{ddo_map}`; an engine the element lacks is
 *     skipped silently (an external-only element under a dedalo caller is
 *     unchanged, never a throw). The injected ddos are the caller's ALREADY
 *     PROCESSED ddos, verbatim (PHP: the caller's build ran process_single_ddo
 *     on them — model, label, mode, fixed_mode, self). Nothing is re-processed.
 *     Every other key of the element's item (sqo, api_config, sqo_config of a
 *     slot, …) is the element's own.
 *
 * FIRST CALLER ITEM PER ENGINE — this MATCHES PHP's effective behaviour, it
 * is not a divergence. PHP loops over every caller item, but it caches the
 * collected children under `$cache_key = $dd_object->tipo . '_' . $api_engine`
 * ($children_cache, initialised once at class.common.php:2362, filled only
 * `if (!isset(...))` at :2615-2617, read back at :2632-2635). A second caller
 * item of the same engine hits that cache and re-applies the FIRST item's
 * children — nulls included — to the same first-per-engine element item
 * (`$rc_by_api_engine[...] ??=`). Example: caller [{dedalo, show:[B<N]},
 * {dedalo, show:[LATE<N]}] gives N the show [B] in PHP and here; LATE is never
 * read by either.
 *
 * BOUNDED WALK. The descendant walk keeps duplicates, so its output can grow
 * faster than its input: a map that declares each tipo twice under the
 * previous one ([T1<N, T1<N, T2<T1, T2<T1, …]) has 2^k paths. PHP paid for
 * that inside an FPM worker's memory_limit; here one Bun process serves every
 * request and the map may be CLIENT-sent, so the walk is iterative (no call
 * stack to overflow) and stops with a typed refusal once it has emitted more
 * than MAX_COLLECTED_DESCENDANTS entries — refused, never silently truncated.
 * WHOSE fault it is depends on whose map it is, so every caller states the
 * map's ORIGIN and the refusal carries the one correct code (ERRORS_SPEC §1):
 *   'client'   — a map the request carried (rqo show.ddo_map literal, stage 1)
 *                → `request.invalid_rqo` (caller, 400): the request is wrong;
 *   'ontology' — a map the server derived (section_list, request_config
 *                properties, get_ddo_map, a caller's ontology config)
 *                → `ontology.invalid_node` (unavailable, 503) naming the
 *                element: the REQUEST was fine, the definition is not.
 *
 * IMMUTABILITY. Neither input is mutated. The result is a fresh array of fresh
 * items whose untouched blocks are SHARED by reference with the base (the
 * caller's config is typically a structural-cache object; mutating it would
 * bleed one caller's columns into every later reader). A consumer that wants
 * to mutate the result must clone it first — the same contract as every
 * resolver-cache read.
 */

import { SCALAR_BOUNDS } from '../../concepts/scalar_bounds.ts';
import { DedaloError } from '../../errors/index.ts';
import { engineOf } from './engine_select.ts';

/**
 * The most entries ONE descendant walk may emit — the same ceiling a client
 * ddo_map may carry (SCALAR_BOUNDS.ddoMapEntries): a walk that emits more
 * than its map could ever hold is fan-out, not configuration.
 */
export const MAX_COLLECTED_DESCENDANTS = SCALAR_BOUNDS.ddoMapEntries;

/** Whose map a walk reads — decides the refusal's code (module header, BOUNDED WALK). */
export type DdoMapOrigin = 'client' | 'ontology';

/** The four ddo_map slots of a request_config item, in PHP order. */
export const CONFIG_SLOTS = ['show', 'search', 'choose', 'hide'] as const;
export type ConfigSlot = (typeof CONFIG_SLOTS)[number];

/** The least a ddo must carry to take part in the parent-chain walk. */
export interface ChainDdo {
	readonly tipo: string;
	readonly parent?: unknown;
}

/** A slot block as far as injection cares: an optional ddo_map + its own keys. */
export interface SlotBlock {
	readonly ddo_map?: unknown;
	readonly [extra: string]: unknown;
}

/** A request_config item as far as injection cares. */
export interface InjectableConfigItem {
	readonly api_engine?: string;
	readonly show?: SlotBlock | null;
	readonly search?: SlotBlock | null;
	readonly choose?: SlotBlock | null;
	readonly hide?: SlotBlock | null;
	readonly [extra: string]: unknown;
}

/** The children ONE caller engine supplies for an element, per slot. */
export interface CallerEngineChildren<D extends ChainDdo = ChainDdo> {
	/** The engine (implicit 'dedalo' applied — engine_select.engineOf). */
	readonly api_engine: string;
	/** Each slot's collected children; `[]` when the caller's slot is absent or names none. */
	readonly slots: Readonly<Record<ConfigSlot, readonly D[]>>;
}

/** A slot's ddo_map as a list of walkable ddos; anything else is "no map". */
function slotDdoMap<D extends ChainDdo>(block: SlotBlock | null | undefined): readonly D[] {
	const map = block?.ddo_map;
	if (!Array.isArray(map)) return [];
	return map.filter(
		(ddo): ddo is D =>
			ddo !== null && typeof ddo === 'object' && typeof (ddo as ChainDdo).tipo === 'string',
	);
}

/** The typed fan-out refusal, coded by the map's origin (module header, BOUNDED WALK). */
function fanOutRefusal(elementTipo: string, origin: DdoMapOrigin, maxEntries: number): DedaloError {
	const message = `collectDdoMapDescendants: the ${origin} ddo_map below '${elementTipo}' fans out past ${maxEntries} entries (duplicated parents multiply every path) — refused`;
	if (origin === 'client') {
		return new DedaloError('request.invalid_rqo', {
			message,
			details: { issue_paths: 'ddo_map' },
			coordinates: { tipo: elementTipo },
		});
	}
	return new DedaloError('ontology.invalid_node', { message, coordinates: { tipo: elementTipo } });
}

/**
 * Every descendant of `elementTipo` in ONE flat ddo_map — the PHP
 * `$get_children_recursive` closure (class.common.php:2297-2310), with an
 * ancestor-path cycle guard and an output budget added.
 *
 *   map  [X<N, A<X, Y<N, A<Y]   collect(N) → [X, A, Y, A]   (diamond: both A kept)
 *   map  [a<p, b<a, a<b]        collect(p) → [a, b]         (cycle cut at the repeat)
 *
 * ONE mutable ancestor set holds the tipos on the CURRENT path (element
 * included): a tipo joins it when its frame is pushed and leaves it when that
 * frame is popped, so a candidate whose tipo is on it is the cycle's repeat and
 * is neither emitted nor followed. Siblings never see each other's paths (the
 * sibling's frame is popped before the next one is pushed), which is what keeps
 * duplicates reached through two different parents. A tipo is on the path at
 * most once (the guard), so the delete on pop is exact.
 *
 * COST: O(1) per step — one walk is linear in what it emits (bounded by
 * `maxEntries`) plus the map size (groupByParent). A per-frame COPY of the path
 * would make a deep chain quadratic (2048 levels → ~2M set inserts per walk).
 *
 * Iterative depth-first (explicit stack, caller order preserved): no recursion
 * and no `push(...spread)` of a large array. More than `maxEntries` emitted
 * entries throws — `request.invalid_rqo` for a 'client' map,
 * `ontology.invalid_node` for an 'ontology' one (module header, BOUNDED WALK).
 */
export function collectDdoMapDescendants<D extends ChainDdo>(
	ddoMap: readonly D[],
	elementTipo: string,
	origin: DdoMapOrigin,
	maxEntries: number = MAX_COLLECTED_DESCENDANTS,
): D[] {
	const childrenOf = groupByParent(ddoMap);
	const descendants: D[] = [];
	const onPath = new Set<string>([elementTipo]);
	const stack: WalkFrame<D>[] = [frameOf(childrenOf, elementTipo)];
	while (stack.length > 0) {
		const frame = stack[stack.length - 1] as WalkFrame<D>;
		const candidate = frame.children[frame.next];
		if (candidate === undefined) {
			stack.pop();
			onPath.delete(frame.tipo);
			continue;
		}
		frame.next += 1;
		if (onPath.has(candidate.tipo)) continue; // a → b → a: stop at the repeat
		descendants.push(candidate);
		if (descendants.length > maxEntries) throw fanOutRefusal(elementTipo, origin, maxEntries);
		onPath.add(candidate.tipo);
		stack.push(frameOf(childrenOf, candidate.tipo));
	}
	return descendants;
}

/** One level of the depth-first walk: whose children, the children, the next one to visit. */
interface WalkFrame<D extends ChainDdo> {
	readonly tipo: string;
	readonly children: readonly D[];
	next: number;
}

/**
 * parent → its children, in map order (one pass; the walk is then linear in
 * what it emits, not in map size × emitted).
 */
function groupByParent<D extends ChainDdo>(ddoMap: readonly D[]): Map<unknown, D[]> {
	const childrenOf = new Map<unknown, D[]>();
	for (const candidate of ddoMap) {
		const siblings = childrenOf.get(candidate.parent);
		if (siblings === undefined) childrenOf.set(candidate.parent, [candidate]);
		else siblings.push(candidate);
	}
	return childrenOf;
}

/** The frame that visits `tipo`'s children (the caller puts `tipo` on the path). */
function frameOf<D extends ChainDdo>(
	childrenOf: ReadonlyMap<unknown, D[]>,
	tipo: string,
): WalkFrame<D> {
	return { tipo, children: childrenOf.get(tipo) ?? [], next: 0 };
}

/** Each slot's descendants of `elementTipo` in ONE caller item. */
function collectItemSlots<D extends ChainDdo>(
	item: InjectableConfigItem,
	elementTipo: string,
	origin: DdoMapOrigin,
): Record<ConfigSlot, readonly D[]> {
	const slots = {} as Record<ConfigSlot, readonly D[]>;
	for (const slot of CONFIG_SLOTS) {
		slots[slot] = collectDdoMapDescendants(slotDdoMap<D>(item[slot]), elementTipo, origin);
	}
	return slots;
}

/** A config item as far as the walk cares: a non-null object. */
function isConfigItem(item: unknown): item is InjectableConfigItem {
	return item !== null && typeof item === 'object';
}

/**
 * The children a CALLER's config declares for `elementTipo`, per engine and
 * slot. One entry per distinct engine, in the caller's item order; for each
 * engine only its FIRST caller item is read (PHP's $children_cache gives the
 * same answer — see the module header). An engine whose four slots all came back empty is
 * still listed — the injection skips empty slots itself, and a caller is free
 * to ask "did this engine name anything" through the slots.
 */
export function collectCallerChildren<D extends ChainDdo = ChainDdo>(
	callerConfig: readonly InjectableConfigItem[] | null | undefined,
	elementTipo: string,
	origin: DdoMapOrigin,
): CallerEngineChildren<D>[] {
	if (!Array.isArray(callerConfig)) return [];
	const collected: CallerEngineChildren<D>[] = [];
	const seenEngines = new Set<string>();
	for (const item of callerConfig) {
		if (!isConfigItem(item)) continue;
		const engine = engineOf(item);
		if (seenEngines.has(engine)) continue; // first caller item per engine
		seenEngines.add(engine);
		collected.push({ api_engine: engine, slots: collectItemSlots<D>(item, elementTipo, origin) });
	}
	return collected;
}

/**
 * The element's config with the caller's children injected (PHP
 * class.common.php:2629-2678). Returns a FRESH array; `baseConfig` and
 * `children` are never mutated. See the module header for the rules.
 *
 *   base   [{dedalo, show:{ddo_map:[rsc85, rsc86]}, sqo:{→rsc197}}]
 *   caller dedalo show children of rsc1400 = [rsc86, rsc85]
 *   result [{dedalo, show:{ddo_map:[rsc86, rsc85]}, sqo:{→rsc197}}]
 */
export function injectCallerChildren<T extends InjectableConfigItem, D extends ChainDdo>(
	baseConfig: readonly T[] | null | undefined,
	children: readonly CallerEngineChildren<D>[],
): T[] {
	if (!Array.isArray(baseConfig)) return [];
	const result: T[] = [...baseConfig];
	for (const engineChildren of children) {
		if (!CONFIG_SLOTS.some((slot) => engineChildren.slots[slot].length > 0)) continue;
		// The element's FIRST item of this engine (PHP $rc_by_api_engine ??=).
		const index = result.findIndex(
			(item) => isConfigItem(item) && engineOf(item) === engineChildren.api_engine,
		);
		if (index === -1) continue; // the element lacks this engine: skipped, never a throw
		result[index] = withInjectedSlots(result[index] as T, engineChildren.slots);
	}
	return result;
}

/**
 * ONE element item with each NON-EMPTY caller slot injected (a fresh object;
 * the item is never mutated). An empty slot leaves the element's own map
 * standing; a missing block is created as {ddo_map} (PHP :2654-2676); an
 * existing one keeps its own keys (sqo_config, …) and only trades its ddo_map.
 */
function withInjectedSlots<T extends InjectableConfigItem, D extends ChainDdo>(
	target: T,
	slots: Readonly<Record<ConfigSlot, readonly D[]>>,
): T {
	const injected: Record<string, unknown> = { ...target };
	for (const slot of CONFIG_SLOTS) {
		const slotChildren = slots[slot];
		if (slotChildren.length === 0) continue; // empty: the element's own map stands
		const ownBlock = target[slot];
		injected[slot] = { ...(isConfigItem(ownBlock) ? ownBlock : {}), ddo_map: [...slotChildren] };
	}
	return injected as T;
}
