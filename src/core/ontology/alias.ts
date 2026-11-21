/**
 * component_alias — first-class tipo-level aliasing (v7 TS-native; WC-020).
 *
 * An alias node (`model:'component_alias'`, REQUIRED `properties.alias_of`)
 * renders as ITS OWN tipo on the wire but behaves as the TARGET component:
 * the target's model/behavior/JS class, the target's stored data column key,
 * and a config that is the alias's local overrides MERGED over the target's
 * properties. History: the v5 engine had this; v6/v7-PHP dropped it (the
 * nodes survived as dead data) — the v7 TS engine revives it as THE config
 * carrier for tool components (single source of truth instead of inline
 * ddo_map property copies; user decision 2026-07-10).
 *
 * CONTRACT (engineering/wire_contract/ WC-020):
 * - `alias_of` required; SINGLE hop (alias→alias throws); missing target
 *   throws; retired v5 keys (`max_records`/`look_inside`/`edit_view`) present
 *   on an alias node throw — a half-migrated node must be loud.
 * - Merge = TOP-LEVEL-KEY WHOLESALE replacement:
 *   `{...target.properties, ...alias.properties minus alias_of}` — an alias
 *   `source` replaces the target's WHOLE `source` (same replacement-family
 *   semantics as the rqo `source.properties` override / PHP set_properties).
 *   Precedence: rqo override → alias merge → target properties.
 * - Wire identity: context/data emit the ALIAS tipo; `model`/`legacy_model`
 *   emit the TARGET's models; `label` is the alias's own term. STORED data
 *   never contains the alias tipo (reads/writes key the target's column slot
 *   via resolveDataTipo; locator from_component_tipo = target).
 *
 * Model/translatable hops live in resolver.ts (getModelByTipo — resolver must
 * not import this module; this module imports resolver, one direction only).
 */

import { isInTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { createOntologyCache } from './cache_factory.ts';
import { registerOntologyCacheClearer } from './cache_invalidation.ts';
import { aliasTargetTipoOf, getColumnNameByModel, getNode } from './resolver.ts';

/** v5 vocabulary retired by the v7 contract — presence on an alias throws. */
const RETIRED_ALIAS_KEYS = ['max_records', 'look_inside', 'edit_view'] as const;

/** tipo → target tipo (null = not an alias). */
const aliasTargetCache = createOntologyCache<string, string | null>();
/** tipo → merged effective properties (aliases only; see getEffectivePropertiesByTipo). */
const effectivePropertiesCache = createOntologyCache<string, unknown>();

export function clearAliasCaches(): void {
	aliasTargetCache.clear();
	effectivePropertiesCache.clear();
}
registerOntologyCacheClearer(clearAliasCaches);

/** S1-14 in-tx-read guard (resolver.ts cacheWrite): never SEED a shared cache
 * from inside an open transaction — a mid-provisioning read could memoize
 * uncommitted (or rolled-back) ontology state process-wide. */
function cacheWrite<K, V>(cache: Map<K, V>, key: K, value: V): void {
	if (isInTransaction()) return;
	cache.set(key, value);
}

/** Refuse a component_alias node that still carries a retired v5 key (WC-020). */
function assertNoRetiredAliasKeys(tipo: string, properties: Record<string, unknown>): void {
	const retired = RETIRED_ALIAS_KEYS.find((key) => key in properties);
	if (retired === undefined) return;
	throw new DedaloError('ontology.invalid_node', {
		message: `component_alias '${tipo}': retired v5 key '${retired}' present — migrate the node to the v7 shape (WC-020)`,
		coordinates: { tipo, retired_key: retired },
	});
}

/**
 * The alias target tipo of `tipo`, or null when the node is not a
 * component_alias. Enforces the full contract (fail loud, never fall back):
 * retired v5 keys here, then THE reader (resolver.ts `aliasTargetTipoOf`):
 * missing/empty alias_of, a non-grammar target (SURF-1), missing target
 * node, alias-of-alias — all throw `ontology.invalid_node` with a `reason`.
 */
export async function resolveAliasTargetTipo(tipo: string): Promise<string | null> {
	const cached = aliasTargetCache.get(tipo);
	if (cached !== undefined) return cached;

	const node = await getNode(tipo);
	if (node === null || node.model !== 'component_alias') {
		cacheWrite(aliasTargetCache, tipo, null);
		return null;
	}
	assertNoRetiredAliasKeys(tipo, (node.properties ?? {}) as Record<string, unknown>);
	// THE alias reader (resolver.ts, SURF-1): missing → grammar → absent →
	// chained. No second copy here — a reader that drifted from the resolver's
	// hops would let the data-tipo re-key (search SQL, matrix slots) accept what
	// the model hop refuses.
	const target = await aliasTargetTipoOf(tipo);
	cacheWrite(aliasTargetCache, tipo, target);
	return target;
}

/**
 * The tipo whose JSONB column slot holds this element's DATA: the alias
 * target for aliases, the tipo itself otherwise. EVERY matrix read/write/
 * search site keys by this — stored data never contains an alias tipo.
 */
export async function resolveDataTipo(tipo: string): Promise<string> {
	return (await resolveAliasTargetTipo(tipo)) ?? tipo;
}

/**
 * The element's EFFECTIVE properties: for an alias, the local overrides
 * merged over the target's properties (top-level-key wholesale, alias_of
 * stripped); for everything else, the node's own properties unchanged.
 * Callers must treat the result as READ-ONLY (it is cached/shared, same
 * discipline as getNode().properties).
 */
export async function getEffectivePropertiesByTipo(tipo: string): Promise<unknown> {
	const cached = effectivePropertiesCache.get(tipo);
	if (cached !== undefined) return cached;

	const targetTipo = await resolveAliasTargetTipo(tipo);
	if (targetTipo === null) {
		// Not an alias — do NOT cache (getNode already caches; duplicating every
		// node's properties here would double the footprint for nothing).
		return (await getNode(tipo))?.properties ?? null;
	}
	const aliasProperties = ((await getNode(tipo))?.properties ?? {}) as Record<string, unknown>;
	const targetProperties = ((await getNode(targetTipo))?.properties ?? {}) as Record<
		string,
		unknown
	>;
	const { alias_of: _aliasOf, ...overrides } = structuredClone(aliasProperties);
	const merged = { ...structuredClone(targetProperties), ...overrides };
	cacheWrite(effectivePropertiesCache, tipo, merged);
	return merged;
}

/**
 * The STORED ontology model behind this element — the target's for aliases
 * (context `legacy_model` emission, the autocomplete_hi stored-model gates),
 * the node's own otherwise.
 */
export async function getTargetStoredModel(tipo: string): Promise<string | null> {
	const targetTipo = await resolveAliasTargetTipo(tipo);
	return (await getNode(targetTipo ?? tipo))?.model ?? null;
}

/**
 * THE ALIAS-WIRING LAW (WC-020 v1, T2-U04) — may a component_alias point at a
 * target of this RUNTIME model? ONE predicate, three askers: the read guard
 * (section/read.ts emitDdoData — it refuses an unwired face loudly), the
 * ontology health report (ontology_state.ts `aliasTargetDefects`) and the
 * release gate over the vendored ontology (alias_target_grammar_native).
 *
 * Wired = the emission keys its data by the DATA tipo (resolveDataTipo):
 *   - relation column: the PORTAL engine only (expandPortal). Every other
 *     relation face — children / parent / related / index, the select-family
 *     datalists — reads by the ddo's own tipo and would serve the alias's
 *     EMPTY slot;
 *   - any other column: the generic literal path (resolveComponentValue hops
 *     internally) — so every model EXCEPT one whose emit hook OWNS the whole
 *     emission (`emitItem`: media, section_id).
 *
 * The emit-hook table is read lazily (CONVENTIONS §2 rationale 1,
 * cycle-breaking): components/emit_hooks.ts statically imports every hook
 * module, several of which reach this module — a static edge here would close
 * an import cycle through the ontology layer.
 */
export async function isAliasWiredTargetModel(model: string): Promise<boolean> {
	if (getColumnNameByModel(model) === 'relation') return model === 'component_portal';
	const { getEmitHook } = await import('../components/emit_hooks.ts');
	return getEmitHook(model)?.emitItem === undefined;
}
