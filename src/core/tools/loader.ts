/**
 * Tool server-module loader (PHP tool_paths::get_tool_class_file +
 * tools_register class-contract checks, re-expressed for the TS plugin model).
 *
 * Discovery is a deterministic, allowlisted directory scan over the tool roots
 * (paths.ts): for each root in priority order, every directory matching
 * ^tool_[a-z0-9_]+$ that contains a server/index.ts is dynamically imported and
 * its exported `tool` validated against the ToolServerModule contract. First
 * root wins name collisions (reported). The registry is a Map filled ONCE at
 * boot (or lazily on first use) — a tool method is reachable only if its module
 * loaded here, so there is no request-time reflection.
 *
 * The import specifier is NEVER request-influenced: it is built only from an
 * allowlisted root path + a name that already matched the strict pattern, and
 * the canonical path is confined under the root before import (TOCTOU-safe).
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from '../../config/config.ts';
import { DedaloError } from '../errors/index.ts';
import {
	LIFECYCLE_KEYS,
	TOOL_ROUTE_RESERVED_SEGMENTS,
	type ToolActionSpec,
	type ToolHttpRoute,
	type ToolServerModule,
} from './module.ts';
import { getRoots } from './paths.ts';
import { guardReasonKeys, reasonKeysDeclarationProblem } from './reason_keys.ts';

/** A successfully loaded tool: its module plus provenance for confinement/reporting. */
export interface LoadedTool {
	module: ToolServerModule;
	/** Canonical directory the tool was loaded from. */
	dir: string;
	/** Index of the root it lives in (0 = primary). */
	rootIndex: number;
}

const TOOL_NAME_PATTERN = /^tool_[a-z0-9_]+$/;

/** The loaded-tools registry, populated once. Null until the first load. */
let loadedTools: Map<string, LoadedTool> | null = null;
/** Names that collided across roots (first-root-wins); reported, not fatal. */
let collisions: string[] = [];
/** Names whose server/index.ts exists but failed to import/validate (fail-closed availability). */
let failedLoads: readonly string[] = [];
/** In-flight load promise so concurrent callers share one scan. */
let loadingPromise: Promise<Map<string, LoadedTool>> | null = null;

/** A tool module that does not honour the contract is OUR bug, not a caller's:
 * the precise sentence stays server-side as `internal.invariant`'s log message. */
function invalidToolModule(message: string): DedaloError {
	return new DedaloError('internal.invariant', { message });
}

/**
 * Validate a dynamically imported module object against the contract. Returns
 * the typed module or throws with a precise reason (caught per-tool by the
 * scanner so one bad tool never aborts the whole load).
 */
export function validateToolModule(imported: unknown, expectedName: string): ToolServerModule {
	const tool = (imported as { tool?: unknown }).tool;
	if (tool === undefined || tool === null || typeof tool !== 'object') {
		throw invalidToolModule('server/index.ts must export a `tool` object');
	}
	const module = tool as ToolServerModule;
	validateModuleName(module, expectedName);
	validateApiActions(module);
	validateReasonKeys(module);
	validateBootAndRoutes(module);
	return module;
}

/**
 * The module the registry SERVES for an imported tool: contract-validated, then
 * with every wire-producing entry guarded so a malformed `details.reason_key`
 * refusal is `internal.invariant` (reason_keys.ts). THE per-tool admission of the
 * scan — a tool reaches `registry.set` only through it, so no handler runs
 * unguarded. Each guard keeps the raw function reachable (`unguarded`,
 * reason_keys.ts). Pinned by OUTCOME: test/unit/tool_reason_keys_tripwire.test.ts
 * compares the registry `loadToolModules()` fills against the raw imports.
 */
export function admitToolModule(imported: unknown, expectedName: string): ToolServerModule {
	return guardReasonKeys(validateToolModule(imported, expectedName));
}

/** The optional `reasonKeys` declaration: keys in the label-name grammar, each with a vetted fallback sentence. */
function validateReasonKeys(module: ToolServerModule): void {
	const problem = reasonKeysDeclarationProblem(module);
	if (problem !== null) throw invalidToolModule(problem);
}

/** `tool.name` equals the directory and matches the tool-name grammar. */
function validateModuleName(module: ToolServerModule, expectedName: string): void {
	if (module.name !== expectedName) {
		throw invalidToolModule(
			`tool.name '${module.name}' must equal directory name '${expectedName}'`,
		);
	}
	if (!TOOL_NAME_PATTERN.test(module.name)) {
		throw invalidToolModule(`tool.name '${module.name}' must match ^tool_[a-z0-9_]+$`);
	}
}

/** `apiActions` is an object of handler specs, with no lifecycle hook inside it. */
function validateApiActions(module: ToolServerModule): void {
	if (typeof module.apiActions !== 'object' || module.apiActions === null) {
		throw invalidToolModule('tool.apiActions must be an object');
	}
	const hook = LIFECYCLE_KEYS.find((key) => Object.hasOwn(module.apiActions, key));
	if (hook !== undefined) {
		throw invalidToolModule(`lifecycle hook '${hook}' must not appear inside apiActions`);
	}
	for (const [method, spec] of Object.entries(module.apiActions)) {
		if (typeof spec?.handler !== 'function') {
			throw invalidToolModule(`apiActions.${method}.handler must be a function`);
		}
		validateReadOnlyDeclaration(module, method, spec);
	}
}

/**
 * The permission kinds that do NOT consult `minLevel`: 'developer' asserts a flag
 * and `null` is the in-handler exemption. Every other kind — and any kind added
 * later — reads the level, so the closed list is the one that cannot go stale in
 * the unsafe direction.
 */
const LEVEL_FREE_KINDS: readonly string[] = ['developer', 'null'];

/**
 * `readOnly` (module.ts GatedToolActionSpec.readOnly) is a claim the dispatcher
 * acts on, so its declaration is checked at load: only the literal `true` (an
 * absent flag is the mutating default; `false` would be a second spelling of it);
 * never on a background action (a job is a write); and a level-gated action must
 * ask for read level EXPLICITLY — the default is 2 (write), which would make a
 * read-only action demand a right it never uses. EXACTLY 1, not "at most 1": the
 * gates ask `level < required` (tools/security.ts, security/write_door.ts), which
 * is never true for 0, a negative or NaN — such a spelling would leave the action
 * with NO level gate at all, while still reading as a declared read level.
 */
function validateReadOnlyDeclaration(
	module: ToolServerModule,
	method: string,
	spec: ToolActionSpec,
): void {
	if (spec.readOnly === undefined) return;
	if (spec.readOnly !== true) {
		throw invalidToolModule(`apiActions.${method}.readOnly must be the literal true or absent`);
	}
	if (module.backgroundRunnable?.includes(method) === true) {
		throw invalidToolModule(
			`apiActions.${method}.readOnly cannot also be in backgroundRunnable (a background job is a write)`,
		);
	}
	if (!LEVEL_FREE_KINDS.includes(String(spec.permission)) && spec.minLevel !== 1) {
		throw invalidToolModule(
			`apiActions.${method}.readOnly needs an explicit minLevel: 1 — exactly 1 (the gated default is 2, write; 0, a negative or NaN would disable the level gate)`,
		);
	}
}

/** The optional `onBoot` hook and `httpRoutes` facet. */
function validateBootAndRoutes(module: ToolServerModule): void {
	if (module.onBoot !== undefined && typeof module.onBoot !== 'function') {
		throw invalidToolModule('tool.onBoot must be a function');
	}
	if (module.httpRoutes === undefined) return;
	if (!Array.isArray(module.httpRoutes)) {
		throw invalidToolModule('tool.httpRoutes must be an array');
	}
	for (const route of module.httpRoutes) {
		validateHttpRoute(route);
		assertRoutePosture(route);
	}
}

/** A route must classify its read posture (see readPostureRefusal). */
function assertRoutePosture(route: ToolHttpRoute): void {
	const posture = readPostureRefusal(route.readPosture);
	if (posture !== null) {
		throw invalidToolModule(`httpRoutes: '${route.pathPrefix}'.readPosture ${posture}`);
	}
}

/** `/dedalo/<seg>[/<seg>…]/`, lowercase [a-z0-9_] segments. */
const TOOL_ROUTE_PATTERN = /^\/dedalo\/([a-z0-9_]+)\/(?:[a-z0-9_]+\/)*$/;

/** A route's prefix grammar + reserved-namespace check (see ToolServerModule.httpRoutes). */
function validateHttpRoute(route: ToolHttpRoute): void {
	const prefix = String(route?.pathPrefix ?? '');
	const match = TOOL_ROUTE_PATTERN.exec(prefix);
	if (match === null) {
		throw invalidToolModule(
			`httpRoutes: '${prefix}' must match /dedalo/<segment>[/<segment>…]/ (lowercase, trailing slash)`,
		);
	}
	const first = match[1] as string;
	if (TOOL_ROUTE_RESERVED_SEGMENTS.includes(first) || first === config.mediaDir) {
		throw invalidToolModule(
			`httpRoutes: '${prefix}' claims the reserved /dedalo/${first}/ namespace`,
		);
	}
	if (typeof route.handle !== 'function') {
		throw invalidToolModule(`httpRoutes: '${prefix}'.handle must be a function`);
	}
}

/** The posture-specific field each read posture must name (security/read_door.ts ReadDoorPosture). */
const ROUTE_POSTURE_FIELDS: Readonly<Record<string, string | null>> = {
	component: 'gate',
	chokepoint: 'via',
	delegates: 'to',
	record_identity: null,
	structure_only: null,
	mutating: null,
};

/**
 * Why a tool route's read posture is not acceptable, or null. Required; one of
 * the closed postures with its named field and a reason of substance — and
 * never `open`: the read-door census may not grow an ungated door through a
 * tool (read_door_acl_tripwire's OPEN ceiling is shrink-only).
 */
export function readPostureRefusal(posture: unknown): string | null {
	if (posture === null || typeof posture !== 'object') return 'is required (a ReadDoorPosture)';
	const fields = posture as Record<string, unknown>;
	const kind = String(fields.posture);
	return postureKindRefusal(kind) ?? postureFieldsRefusal(kind, fields);
}

/** `open` refused; an unknown kind refused. */
function postureKindRefusal(kind: string): string | null {
	if (kind === 'open') return "may not be 'open' (a tool may not add an ungated read door)";
	return Object.hasOwn(ROUTE_POSTURE_FIELDS, kind) ? null : `has an unknown posture '${kind}'`;
}

/** The reason, and the kind's named field (gate / via / to). */
function postureFieldsRefusal(kind: string, fields: Record<string, unknown>): string | null {
	if (!substantial(fields.reason, 6)) return 'needs a reason of substance';
	const field = ROUTE_POSTURE_FIELDS[kind] ?? null;
	if (field === null) return null;
	return substantial(fields[field], 0) ? null : `needs '${field}' for '${kind}'`;
}

/** A string whose trimmed length exceeds `floor`. */
function substantial(value: unknown, floor: number): boolean {
	return typeof value === 'string' && value.trim().length > floor;
}

/**
 * Refuse a module whose route overlaps one an already-loaded tool serves
 * (either prefix containing the other could answer the same path): the
 * earlier tool keeps it, this one fails to load, loudly.
 */
export function assertNoRouteOverlap(
	module: ToolServerModule,
	registry: ReadonlyMap<string, LoadedTool>,
): void {
	for (const route of module.httpRoutes ?? []) {
		for (const [claimant, loaded] of registry) assertRouteFree(route, claimant, loaded);
	}
}

/** Refuse `route` when it overlaps any route `claimant` already serves. */
function assertRouteFree(route: ToolHttpRoute, claimant: string, loaded: LoadedTool): void {
	for (const claimed of loaded.module.httpRoutes ?? []) {
		if (prefixesOverlap(route.pathPrefix, claimed.pathPrefix)) {
			throw invalidToolModule(
				`httpRoutes: '${route.pathPrefix}' overlaps '${claimed.pathPrefix}' already served by ${claimant}`,
			);
		}
	}
}

/** True when one prefix contains the other (either could answer the same path). */
function prefixesOverlap(a: string, b: string): boolean {
	return a.startsWith(b) || b.startsWith(a);
}

/** Run the scan across all roots and build the registry (idempotent per call). */
async function scanRoots(): Promise<Map<string, LoadedTool>> {
	const registry = new Map<string, LoadedTool>();
	const collided: string[] = [];
	const failed: string[] = [];
	const roots = getRoots();

	for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
		const root = roots[rootIndex];
		if (root === undefined) continue;
		let entries: string[];
		try {
			entries = readdirSync(root.path);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (!TOOL_NAME_PATTERN.test(name)) continue;
			const serverEntry = resolve(root.path, name, 'server', 'index.ts');
			if (!existsSync(serverEntry)) continue;

			// First-root-wins: a later root's same-named tool is a reported collision.
			if (registry.has(name)) {
				collided.push(name);
				continue;
			}
			// Canonical confinement: the entry must resolve inside the root.
			let canonical: string;
			try {
				canonical = realpathSync(serverEntry);
			} catch {
				continue;
			}
			if (canonical !== root.path && !canonical.startsWith(root.path + sep)) {
				console.warn(`[tools] refused (outside root): ${serverEntry}`);
				continue;
			}
			try {
				const imported = await import(canonical);
				const module = admitToolModule(imported, name);
				assertNoRouteOverlap(module, registry);
				registry.set(name, {
					module,
					dir: resolve(root.path, name),
					rootIndex,
				});
			} catch (error) {
				// A broken tool fails ONLY itself (missing dep, bad contract, syntax).
				console.warn(`[tools] failed to load '${name}': ${(error as Error).message}`);
				failed.push(name);
			}
		}
	}
	collisions = collided;
	failedLoads = failed;
	return registry;
}

/** Ensure the registry is loaded (once). Concurrent callers share one scan. */
export async function loadToolModules(): Promise<Map<string, LoadedTool>> {
	if (loadedTools !== null) return loadedTools;
	if (loadingPromise === null) {
		loadingPromise = scanRoots().then((registry) => {
			loadedTools = registry;
			loadingPromise = null;
			return registry;
		});
	}
	return loadingPromise;
}

/** The loaded tool for `name`, or undefined. Triggers the load if needed. */
export async function getLoadedTool(name: string): Promise<LoadedTool | undefined> {
	const registry = await loadToolModules();
	return registry.get(name);
}

/**
 * The tool route answering `pathname`, or undefined — THE router seam
 * (server.ts calls it just before the client static tree; see
 * ToolServerModule.httpRoutes). Loads the registry on first use.
 */
export async function toolHttpRouteFor(pathname: string): Promise<ToolHttpRoute | undefined> {
	const registry = await loadToolModules();
	for (const loaded of registry.values()) {
		for (const route of loaded.module.httpRoutes ?? []) {
			if (pathname.startsWith(route.pathPrefix)) return route;
		}
	}
	return undefined;
}

/**
 * Run every loaded tool's `onBoot` (once per serving boot — server.ts). Returns
 * the stops the shutdown drain calls. One tool's throw is logged and skipped:
 * a tool never stops the archive from serving. The contract is SYNCHRONOUS
 * (arm and return, module.ts onBoot): a hook that returns a thenable (an async
 * onBoot — a JS tool module has no types to stop it) is a contract breach,
 * logged and skipped — its rejection is caught and logged, never unhandled, and
 * the promise is never taken for a handle (its `stop` does not exist). A return
 * that is neither undefined nor `{ stop(): void }` is refused the same way.
 */
export async function startToolBootHooks(): Promise<(() => void)[]> {
	const stops: (() => void)[] = [];
	for (const [name, loaded] of await loadToolModules()) {
		if (loaded.module.onBoot === undefined) continue;
		try {
			const stop = bootHandleStop(name, loaded.module.onBoot());
			if (stop !== null) stops.push(stop);
		} catch (error) {
			console.error(`[tools] ${name}.onBoot failed (the tool's boot work will not run):`, error);
		}
	}
	return stops;
}

/** True for a thenable (an async onBoot's promise). */
function isThenable(value: unknown): value is Promise<unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}

/**
 * The stop to register for what `onBoot` returned, or null: undefined (nothing
 * armed); a thenable (contract breach — its rejection logged, never unhandled);
 * anything without a `stop` function (refused).
 */
function bootHandleStop(name: string, handle: unknown): (() => void) | null {
	if (handle === undefined) return null;
	if (isThenable(handle)) {
		handle.then(
			() => undefined,
			(error: unknown) =>
				console.error(`[tools] ${name}.onBoot rejected (async onBoot, contract breach):`, error),
		);
		console.error(
			`[tools] ${name}.onBoot returned a promise — onBoot is synchronous by contract (arm and return); its handle is NOT registered, nothing will stop it on shutdown`,
		);
		return null;
	}
	const stop = (handle as { stop?: unknown } | null)?.stop;
	if (typeof stop !== 'function') {
		console.error(
			`[tools] ${name}.onBoot returned something that is neither undefined nor { stop(): void } — refused, nothing will stop it on shutdown`,
		);
		return null;
	}
	return () => (stop as () => void).call(handle);
}

/** Names that collided across roots on the last load (reporting). */
export function getToolLoadCollisions(): string[] {
	return [...collisions];
}

/**
 * True when `name` has a server/index.ts that failed to load. Its isAvailable
 * hook cannot run, so callers must treat the tool as UNavailable (fail closed),
 * never fall through to "always available". Triggers the load if needed.
 */
export async function toolModuleFailedToLoad(name: string): Promise<boolean> {
	await loadToolModules();
	return failedLoads.includes(name);
}

/** Drop the registry so the next call rescans (tests / after registration). */
export function resetLoadedTools(): void {
	loadedTools = null;
	loadingPromise = null;
	collisions = [];
	failedLoads = [];
}
