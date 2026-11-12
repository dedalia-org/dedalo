/**
 * Tool configuration resolution (PHP tool_common::get_config / get_config_value
 * + tools_register::get_all_config / get_all_default_config / filter_client_config).
 *
 * A tool's effective configuration is resolved PER KEY with this precedence:
 *   1. the per-install config    (dd996 records, component dd999)
 *   2. the register default       (dd1324 records, component dd1633)
 *   3. the caller-supplied default
 * Both config blobs are stored as a json component: misc.<tipo>[0].value is the
 * config OBJECT keyed by option name. An option's value may be a bare scalar or
 * an object `{ value, client, ... }` — in the object form the effective value is
 * `.value` and `client === true` marks it as safe to expose to the browser.
 *
 * SECURITY: only keys flagged `"client": true` are returned by the *ClientConfig
 * helpers. Everything else (API keys, engine URIs, secrets) stays server-side.
 * The client filter is what a tool's context carries to the browser (per-tool),
 * NOT the environment payload — PHP does not put tool config in plain_vars.
 */

import { sql } from '../db/postgres.ts';
import { TIPO, TOOLS_CONFIG_SECTION_TIPO, TOOLS_REGISTER_SECTION_TIPO } from './ontology_map.ts';

/** A per-tool config object (option name → scalar or {value, client, …}). */
type ConfigObject = Record<string, unknown>;
/** name → config object (or null when the record has no config). */
type ConfigMap = Map<string, ConfigObject | null>;

let defaultConfigCache: ConfigMap | null = null;
let installConfigCache: ConfigMap | null = null;
/** The per-(tool, tipo, section_tipo) ddo_map overrides, derived from the two maps above. */
let overrideIndexCache: OverrideIndexes | null = null;
/**
 * Invalidation counter, not request state: every cache above is build-then-set
 * across awaits, so a build stores its result only when no resetConfigCache()
 * landed while it was reading — else a read from BEFORE a dd996/dd1324 edit
 * would outlive the edit's invalidation (T1-43 review).
 */
let configGeneration = 0;

/** Reset the config caches (called by invalidateAllToolCaches). */
export function resetConfigCache(): void {
	configGeneration++;
	defaultConfigCache = null;
	installConfigCache = null;
	overrideIndexCache = null;
}

/**
 * Read a config map from a matrix_tools section: {tool name → config object}.
 * `configTipo` is the json component holding the config (dd1633 for defaults on
 * dd1324, dd999 for install config on dd996).
 */
async function readConfigMap(sectionTipo: string, configTipo: string): Promise<ConfigMap> {
	const rows = (await sql`
		SELECT string->${TIPO.NAME} AS name_items, misc->${configTipo} AS config_items
		FROM matrix_tools
		WHERE section_tipo = ${sectionTipo}
	`) as {
		name_items: { value?: string }[] | null;
		config_items: { value?: unknown }[] | null;
	}[];
	const map: ConfigMap = new Map();
	for (const row of rows) {
		const name = row.name_items?.[0]?.value;
		if (name === undefined || name === '') continue;
		const value = row.config_items?.[0]?.value;
		map.set(name, value !== undefined && value !== null ? (value as ConfigObject) : null);
	}
	return map;
}

/** All tools' register default config (dd1324 / dd1633), cached. */
async function getAllDefaultConfig(): Promise<ConfigMap> {
	if (defaultConfigCache !== null) return defaultConfigCache;
	const generation = configGeneration;
	const map = await readConfigMap(TOOLS_REGISTER_SECTION_TIPO, TIPO.DEFAULT_CONFIG);
	if (generation === configGeneration) defaultConfigCache = map;
	return map;
}

/** All tools' per-install config (dd996 / dd999), cached. */
async function getAllInstallConfig(): Promise<ConfigMap> {
	if (installConfigCache !== null) return installConfigCache;
	const generation = configGeneration;
	const map = await readConfigMap(TOOLS_CONFIG_SECTION_TIPO, TIPO.CONFIG);
	if (generation === configGeneration) installConfigCache = map;
	return map;
}

/** The effective value of one config option (PHP: object → `.value ?? prop`). */
function resolveOption(config: ConfigObject | null, key: string): unknown {
	if (config === null || !Object.hasOwn(config, key)) return undefined;
	const prop = config[key];
	if (prop !== null && typeof prop === 'object' && 'value' in prop) {
		return (prop as { value: unknown }).value;
	}
	return prop;
}

/**
 * Resolve one tool config value (PHP get_config_value): install → register
 * default → caller default. Returns `fallback` when neither layer defines it.
 */
export async function getToolConfigValue<T = unknown>(
	toolName: string,
	key: string,
	fallback: T,
): Promise<T> {
	const install = resolveOption((await getAllInstallConfig()).get(toolName) ?? null, key);
	if (install !== undefined) return install as T;
	const registerDefault = resolveOption((await getAllDefaultConfig()).get(toolName) ?? null, key);
	if (registerDefault !== undefined) return registerDefault as T;
	return fallback;
}

/**
 * The whole effective config for a tool (PHP get_config): every key defined by
 * the register default or the install config, install winning per key, resolved
 * to effective values.
 */
export async function getToolConfig(toolName: string): Promise<Record<string, unknown>> {
	const defaults = (await getAllDefaultConfig()).get(toolName) ?? null;
	const install = (await getAllInstallConfig()).get(toolName) ?? null;
	const keys = new Set<string>([
		...(defaults !== null ? Object.keys(defaults) : []),
		...(install !== null ? Object.keys(install) : []),
	]);
	const merged: Record<string, unknown> = {};
	for (const key of keys) {
		const installValue = resolveOption(install, key);
		merged[key] = installValue !== undefined ? installValue : resolveOption(defaults, key);
	}
	return merged;
}

/**
 * The client-visible config as RAW prop objects (PHP filter_client_config, used
 * by the tool element context): each client:true key maps to its FULL
 * definition object `{ type, value, client, default, … }`, install winning per
 * key — NOT resolved to `.value`. Empty when the tool has no client config.
 */
export async function getToolClientConfigRaw(toolName: string): Promise<Record<string, unknown>> {
	const defaults = (await getAllDefaultConfig()).get(toolName) ?? null;
	const install = (await getAllInstallConfig()).get(toolName) ?? null;
	const keys = new Set<string>([
		...(defaults !== null ? Object.keys(defaults) : []),
		...(install !== null ? Object.keys(install) : []),
	]);
	const raw: Record<string, unknown> = {};
	for (const key of keys) {
		if (!isClientProp(install, key) && !isClientProp(defaults, key)) continue;
		raw[key] =
			install !== null && Object.hasOwn(install, key) ? install[key] : (defaults?.[key] ?? null);
	}
	return raw;
}

/** True when a config option is flagged client-visible (`client === true`). */
function isClientProp(config: ConfigObject | null, key: string): boolean {
	if (config === null) return false;
	const prop = config[key];
	return (
		prop !== null && typeof prop === 'object' && (prop as { client?: unknown }).client === true
	);
}

/**
 * The CLIENT-VISIBLE subset of a tool's config (PHP filter_client_config): only
 * options flagged `"client": true` in either layer, resolved (install winning).
 * This is what a tool's context may carry to the browser — never secrets.
 */
export async function getToolClientConfig(toolName: string): Promise<Record<string, unknown>> {
	const defaults = (await getAllDefaultConfig()).get(toolName) ?? null;
	const install = (await getAllInstallConfig()).get(toolName) ?? null;
	const keys = new Set<string>([
		...(defaults !== null ? Object.keys(defaults) : []),
		...(install !== null ? Object.keys(install) : []),
	]);
	const clientConfig: Record<string, unknown> = {};
	for (const key of keys) {
		// A key is client-visible if EITHER layer flags it client:true.
		if (!isClientProp(install, key) && !isClientProp(defaults, key)) continue;
		const installValue = resolveOption(install, key);
		clientConfig[key] = installValue !== undefined ? installValue : resolveOption(defaults, key);
	}
	return clientConfig;
}

/**
 * TOOL CONFIGURATION OVERRIDE (PHP tool_common::get_tool_configuration,
 * class.tool_common.php:1519-1547; consumed by common::build_structure_context
 * :1874-1916 and common::get_buttons_context :4241-4295).
 *
 * A tool's config may carry `properties.tool_config` — an ARRAY of
 * `{ tipo, section_tipo, ddo_map }` entries. For an element (component, area,
 * section, section button) whose (tipo, section_tipo) matches an entry, that
 * entry's `ddo_map` REPLACES the ontology's `properties.tool_config.<tool>.ddo_map`
 * (only the ddo_map: every other ontology key of the tool's config stays).
 *
 * Precedence (owner ruling 2026-11-11, T1-43): Tools configuration (dd996/dd999)
 * → register default (dd1324/dd1633) → ontology. Resolved PER ENTRY: the first
 * matching entry of the install layer wins, else the first matching entry of
 * the register layer, else null (the caller keeps the ontology). PHP's
 * get_config picks the layer WHOLESALE (a dd996 record for the tool masks the
 * register default even when it carries no matching entry) — the per-entry
 * fallthrough follows this module's per-key law instead
 * (WC-2026-11-12-tool-configuration-override).
 *
 * The override never makes a tool APPLY to an element (PHP get_tools reads only
 * the ontology) — the callers stamp it onto tools that already apply.
 */

/** key `${toolName}\u0000${tipo}\u0000${sectionTipo}` → the entry's ddo_map. */
type OverrideIndex = Map<string, unknown[]>;
interface OverrideIndexes {
	install: OverrideIndex;
	register: OverrideIndex;
}

function overrideKey(toolName: string, tipo: string, sectionTipo: string): string {
	return `${toolName}\u0000${tipo}\u0000${sectionTipo}`;
}

/** The `properties.tool_config` array of one config object (undefined when absent). */
function overrideEntriesOf(config: ConfigObject | null): unknown {
	const properties = config?.properties;
	if (properties === null || typeof properties !== 'object') return undefined;
	return (properties as { tool_config?: unknown }).tool_config;
}

/** True when a ddo_map item is a ddo OBJECT (enrichToolConfig reads its keys). */
function isDdoItem(item: unknown): boolean {
	return item !== null && typeof item === 'object' && !Array.isArray(item);
}

/**
 * True when an override entry has the shape the stamp needs — down to every
 * ddo_map item: a null/scalar item would crash the element's context build
 * downstream (T1-43 review), so the whole entry is refused here instead.
 */
function isOverrideEntry(
	entry: unknown,
): entry is { tipo: string; section_tipo: string; ddo_map: Record<string, unknown>[] } {
	if (entry === null || typeof entry !== 'object') return false;
	const candidate = entry as { tipo?: unknown; section_tipo?: unknown; ddo_map?: unknown };
	return (
		typeof candidate.tipo === 'string' &&
		typeof candidate.section_tipo === 'string' &&
		Array.isArray(candidate.ddo_map) &&
		candidate.ddo_map.every(isDdoItem)
	);
}

/**
 * Index one tool's override entries into `index` (first match wins — PHP
 * array_find). A malformed bag or entry is skipped LOUDLY (named by tool,
 * layer and position) — never a dead screen, never a silent drop.
 */
function indexToolOverrides(
	index: OverrideIndex,
	toolName: string,
	entries: unknown,
	layer: string,
): void {
	if (entries === undefined || entries === null) return;
	if (!Array.isArray(entries)) {
		console.error(
			`[tools/config] ignore ${layer} properties.tool_config of '${toolName}': not an array of {tipo, section_tipo, ddo_map}`,
		);
		return;
	}
	entries.forEach((entry, position) => {
		if (!isOverrideEntry(entry)) {
			console.error(
				`[tools/config] ignore ${layer} properties.tool_config[${position}] of '${toolName}': needs string tipo, string section_tipo and a ddo_map array of ddo objects`,
			);
			return;
		}
		const key = overrideKey(toolName, entry.tipo, entry.section_tipo);
		if (!index.has(key)) index.set(key, entry.ddo_map);
	});
}

/** Build the override index of one config layer. */
function buildOverrideIndex(configs: ConfigMap, layer: string): OverrideIndex {
	const index: OverrideIndex = new Map();
	for (const [toolName, config] of configs) {
		indexToolOverrides(index, toolName, overrideEntriesOf(config), layer);
	}
	return index;
}

/** Both layers' override indexes, built once per tool-cache generation. */
async function getOverrideIndexes(): Promise<OverrideIndexes> {
	if (overrideIndexCache !== null) return overrideIndexCache;
	const generation = configGeneration;
	const install = buildOverrideIndex(await getAllInstallConfig(), 'Tools configuration (dd996)');
	const register = buildOverrideIndex(await getAllDefaultConfig(), 'register default (dd1324)');
	const indexes = { install, register };
	if (generation === configGeneration) overrideIndexCache = indexes;
	return indexes;
}

/**
 * The override `ddo_map` for `toolName` on the element (tipo, sectionTipo):
 * Tools configuration match → register default match → null (keep the
 * ontology). A deep clone — the cached index is never handed out.
 */
export async function getToolConfigurationOverride(
	toolName: string,
	tipo: string,
	sectionTipo: string,
): Promise<unknown[] | null> {
	const { install, register } = await getOverrideIndexes();
	const key = overrideKey(toolName, tipo, sectionTipo);
	const ddoMap = install.get(key) ?? register.get(key);
	return ddoMap !== undefined ? structuredClone(ddoMap) : null;
}
