/**
 * CATALOG-BACKED READERS — one argument, never a fallback.
 *
 * Every default the engine uses comes from `catalog/`, so a default cannot be restated at
 * a call site. That is the whole point: before this, ~160 call sites carried inline
 * literals, `DEDALO_HOST` had two different ones depending on the file, and the generated
 * census would have documented whichever the author of the catalog happened to copy.
 *
 * A reader takes a KEY and nothing else:
 *
 *     readString('DEDALO_TIMEZONE')      // not readEnv('DEDALO_TIMEZONE', 'Europe/Madrid')
 *     readNumber('DB_POOL_MAX')          // not readNumber('DB_POOL_MAX', 10)
 *
 * Once every call site is converted, `readEnv`'s `fallback` parameter is DELETED, and a
 * re-introduced inline default stops being a lint opinion and becomes a compile error.
 *
 * EMPTY-VALUE FIDELITY. `readEnv(k, 'x')` returns '' for a key explicitly set to empty,
 * while readNumber/readListEnv treat '' as unset. That difference is load-bearing —
 * `DB_PASSWORD=''` means trust/peer auth, NOT "use the default" — so it is declared per
 * entry (`emptyIsUnset`) rather than left to whichever reader happened to be called.
 */

import { catalogEntry } from './catalog/index.ts';
import type { CatalogEntry, ComputedDefault } from './catalog_types.ts';
import { readEnv, requireEnv } from './env.ts';
import { UNCONFIGURED } from './install_state.ts';

/**
 * Does an empty value mean "unset"?
 *
 * The default reproduces the pre-catalog behavior EXACTLY, which differed by reader family:
 *   - `readEnv(k, 'x')` returned '' for a key set to empty. Every string AND every boolean
 *     came through it (`readEnv(k,'true') === 'true'`), so for those, empty is a VALUE:
 *     `DB_PASSWORD=` means trust/peer auth, and `SOME_FLAG=` means false, not "use default".
 *   - readNumber/readListEnv/readJsonMap treated '' as unset and fell back.
 *
 * Get this wrong and a boot changes behavior silently, so it is declared, not inferred.
 */
function emptyIsUnset(entry: CatalogEntry): boolean {
	const emptyIsAValue = entry.type === 'string' || entry.type === 'boolean';
	return entry.emptyIsUnset ?? !emptyIsAValue;
}

/** The raw configured value, or undefined when the key is unset (per the entry's rule). */
function raw(key: string): string | undefined {
	const value = readEnv(key);
	if (value === undefined) return undefined;
	if (emptyIsUnset(catalogEntry(key)) && value.trim() === '') return undefined;
	return value;
}

/** Resolve the catalog default, running the thunk when it is a computed one. */
function defaultOf(key: string): unknown {
	const { default: value } = catalogEntry(key);
	return typeof value === 'function' ? (value as ComputedDefault)(readString) : value;
}

function resolve(key: string): unknown {
	const configured = raw(key);
	if (configured !== undefined) return configured;
	return defaultOf(key);
}

/**
 * On an unconfigured box the sentinel wins OUTRIGHT — it is not a fallback consulted after
 * the env. (Such a box never serves: server.ts refuses to start on it. The sentinels exist
 * so `config` can still be IMPORTED there — by the install probe child, by `config:gen` in
 * CI, and by the server on its way to that refusal.)
 *
 * This is subtle and it bit once. UNCONFIGURED is decided by treating an EMPTY required key
 * as unset, but a string reader treats empty as a VALUE (`DB_PASSWORD=` means trust auth).
 * So on a box with `ENTITY=`, "consult the env first, then fall back to the sentinel"
 * yields '' where the pre-catalog `requireOrInstallSentinel` returned 'install'. Check
 * UNCONFIGURED FIRST, exactly as it did.
 */
function requiredValue(key: string): unknown {
	const entry = catalogEntry(key);
	if (UNCONFIGURED && entry.installSentinel !== undefined) return entry.installSentinel;
	return requireEnv(key);
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export function readString(key: string): string {
	const value = resolve(key);
	return value === undefined ? '' : String(value);
}

/** For a key whose ABSENCE is meaningful (the consumer derives its own behavior). */
export function readOptionalString(key: string): string | undefined {
	const configured = raw(key);
	if (configured !== undefined) return configured;
	const value = defaultOf(key);
	return value === undefined ? undefined : String(value);
}

export function readNumber(key: string): number {
	const entry = catalogEntry(key);
	const configured = raw(key);
	let value: number;
	if (configured === undefined) {
		value = Number(defaultOf(key));
	} else {
		const parsed = Number(configured);
		value = Number.isFinite(parsed) ? parsed : Number(defaultOf(key));
	}
	const { clamp } = entry;
	if (clamp !== undefined) {
		if (clamp.min !== undefined) value = Math.max(clamp.min, value);
		if (clamp.max !== undefined) value = Math.min(clamp.max, value);
	}
	return value;
}

export function readBool(key: string): boolean {
	const configured = raw(key);
	if (configured === undefined) return defaultOf(key) === true;
	return configured === 'true';
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** JSON array OR comma list — the shape most Dédalo list settings accept. */
export function readList(key: string): readonly string[] {
	const configured = raw(key);
	if (configured === undefined) {
		return Object.freeze([...((defaultOf(key) as readonly string[] | undefined) ?? [])]);
	}
	const trimmed = configured.trim();
	if (trimmed.startsWith('[')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return Object.freeze(parsed.map(String));
		} catch {
			/* fall through to the comma parse */
		}
	}
	return Object.freeze(
		trimmed
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry !== ''),
	);
}

/**
 * A list of NAMES compared case-insensitively — host names and service identifiers.
 *
 * It exists so no caller ever splits one of these strings itself. The external-services
 * host allowlist is the reason it is its own reader rather than `readList`: that list is a
 * SECURITY decision (empty = every outbound request refused), and a decision enforced by
 * comparing strings must not turn on whether the operator typed `Zenon.DAINST.org`. Lower,
 * trim and de-duplicate once, here, so every comparison downstream is a plain equality on
 * an already-normalized value.
 */
export function readNameList(key: string): readonly string[] {
	const seen = new Set<string>();
	for (const entry of readList(key)) {
		const name = entry.trim().toLowerCase();
		if (name !== '') seen.add(name);
	}
	return Object.freeze([...seen]);
}

/**
 * Like readList, but UNSET (null) is distinguishable from an explicitly EMPTY list ([]).
 * The media public-quality list needs it: unset derives the install's delivery qualities,
 * while [] means no folder is public at all.
 */
export function readOptionalList(key: string): readonly string[] | null {
	if (raw(key) === undefined) return null;
	return readList(key);
}

/**
 * STRICTLY JSON — never a comma list. MEDIA_HTACCESS_ADDONS carries raw web-server
 * directives, and a directive legitimately contains commas (`RewriteRule ^ - [R=404,L]`);
 * a comma fallback would shred one directive into two broken rules and emit them into a
 * live web-server config. A malformed value logs and falls back — never junk rules.
 */
export function readJsonArray(key: string): readonly string[] {
	const configured = raw(key);
	const fallback = (): readonly string[] =>
		Object.freeze([...((defaultOf(key) as readonly string[] | undefined) ?? [])]);
	if (configured === undefined) return fallback();
	try {
		const parsed: unknown = JSON.parse(configured.trim());
		if (Array.isArray(parsed)) return Object.freeze(parsed.map(String));
	} catch {
		/* fall through to the loud refusal */
	}
	console.error(`[config] ${key} must be a JSON array of strings — ignoring the value.`);
	return fallback();
}

export function readMap(key: string): Readonly<Record<string, string>> {
	const configured = raw(key);
	const fallback = (): Readonly<Record<string, string>> =>
		Object.freeze({ ...((defaultOf(key) as Record<string, string> | undefined) ?? {}) });
	if (configured === undefined) return fallback();
	try {
		const parsed: unknown = JSON.parse(configured);
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const entries: Record<string, string> = {};
			for (const [mapKey, mapValue] of Object.entries(parsed)) entries[mapKey] = String(mapValue);
			return Object.freeze(entries);
		}
	} catch {
		/* fall through to the default */
	}
	return fallback();
}

// ---------------------------------------------------------------------------
// Bespoke shapes
// ---------------------------------------------------------------------------

/**
 * Media access mode: DEDALO_MEDIA_ACCESS_MODE when it names a real mode, an explicit
 * opt-out on EITHER key when the operator asked for none, else the FAIL-CLOSED default
 * 'publication'. Two keys, one answer — which is why it cannot be a generic reader.
 *
 * THE DEFAULT IS CLOSED (2026-08-24). It used to be `false`, and
 * `resolveModeSource()` reported that state, verbatim, as "default — no media protection
 * configured (media is world-readable)": an install that never made a decision published
 * its entire media tree — including unpublished records, master-quality originals and
 * rights-restricted material — to anyone who could guess a URL. A heritage system's
 * default must be the safe one; "the operator will configure it" is not a mechanism.
 *
 * 'publication' rather than 'private', deliberately. On an install with no publications
 * the two behave identically (the `pub/` marker dir is empty, so every anonymous request
 * fails rule B and 404s). They diverge only later — and there, `private` would silently
 * 404 the archive's OWN published site the day diffusion writes its first marker. A
 * default that becomes wrong once the system is used as intended is a trap; this one
 * is closed now and still correct then.
 *
 * An explicit `false` on either key stays a real opt-out: an operator who deliberately
 * serves an open media tree (a fully public collection behind its own web server rules)
 * said so, and this must not silently overrule them. What is refused is SILENCE.
 */
export function readMediaAccessMode(): 'private' | 'publication' | false {
	const mode = readString('DEDALO_MEDIA_ACCESS_MODE');
	if (mode === 'private' || mode === 'publication') return mode;
	// The EXPLICIT opt-out, on either key. `readBool` is not used for the mode key
	// because it must distinguish "the operator wrote false" from "unset".
	if (mode === 'false' || mode === 'off' || mode === '0') return false;
	// The legacy key, whose EMPTY value is absence and not an opt-out — an append-only
	// .env accumulates empty keys, and reading one as "the operator chose an open tree"
	// would hand the old world-readable behaviour back to exactly the installs this
	// default exists for.
	const legacy = readString('DEDALO_PROTECT_MEDIA_FILES');
	if (legacy !== undefined && legacy !== '') {
		return readBool('DEDALO_PROTECT_MEDIA_FILES') ? 'private' : false;
	}
	// A non-empty value that is neither a known mode nor an opt-out is almost
	// certainly a typo ('privat', 'public'). It used to coerce to OFF — a typo that
	// opened the whole media tree. It now falls through to the fail-closed default,
	// which is the direction a typo must fail in, and is still logged loudly.
	if (mode !== undefined && mode !== '') {
		console.error(
			`[config] DEDALO_MEDIA_ACCESS_MODE='${mode}' is not a valid mode ('private' | 'publication' | 'false') — falling back to the fail-closed default 'publication'. Fix the value or unset it.`,
		);
	}
	return 'publication';
}

/**
 * A JSON array of {name,url,code} server descriptors; invalid entries are dropped.
 *
 * A MALFORMED value used to degrade to `[]` in total silence, and the two keys
 * this reads (CODE_SERVERS, ONTOLOGY_SERVERS) are hand-edited in an append-only
 * `.env`, so the typo that produces one is ordinary. Measured on the museum
 * install 2026-08-24: a third object appended OUTSIDE the array
 * (`…}],{"name":"Local code server"…`) silently dropped ALL THREE servers,
 * including the two official ones, and the update panel rendered an empty
 * server list with nothing anywhere saying why. Same posture as
 * readMediaAccessMode: the resolved state is unchanged, but it is LOUD.
 */
export function readServerList(
	key: string,
): readonly { name: string; url: string; code: string }[] {
	const configured = raw(key);
	if (configured === undefined || configured.trim() === '') return Object.freeze([]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(configured);
	} catch (error) {
		console.error(
			`[config] ${key} is not valid JSON (${error instanceof Error ? error.message : 'parse error'}) — NO servers are configured from it. Fix the value; it must be a JSON array of {name,url,code}.`,
		);
		return Object.freeze([]);
	}
	if (!Array.isArray(parsed)) {
		console.error(
			`[config] ${key} is valid JSON but not an ARRAY — NO servers are configured from it. It must be a JSON array of {name,url,code}.`,
		);
		return Object.freeze([]);
	}
	const kept = parsed.filter(
		(entry): entry is { name: string; url: string; code: string } =>
			entry !== null &&
			typeof entry === 'object' &&
			typeof (entry as { name: unknown }).name === 'string' &&
			typeof (entry as { url: unknown }).url === 'string' &&
			typeof (entry as { code: unknown }).code === 'string',
	);
	if (kept.length !== parsed.length) {
		console.error(
			`[config] ${key}: ${parsed.length - kept.length} of ${parsed.length} entries were DROPPED (each needs string name, url and code).`,
		);
	}
	return Object.freeze(kept);
}

/**
 * THE UPDATE-SOURCE TRANSPORT RULE (update audit 2026-10-29, U-24): a code or
 * ontology master is `https://`, or plain http on THIS machine (loopback — the
 * two-server dev flow, as tool_error_report allows), or plain http anywhere
 * when the development seam DEDALO_UPDATE_HTTP_SOURCES_DEV is on. The shared
 * `code` and the archives must never cross a network in clear. Pure; the
 * downloaders re-check every URL with it (src/core/update/code_download.ts,
 * src/core/ontology/data_io_import.ts).
 */
export function isSecureUpdateSource(url: string, allowHttp: boolean): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol === 'https:') return true;
	if (parsed.protocol !== 'http:') return false;
	return allowHttp || ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

/** The retired official host (replaced by master7/beta7, no alias). */
export const RETIRED_UPDATE_HOST = 'v7.master.dedalo.dev';

/** Docs anchors a stale-host line points at, by list key. */
const STALE_HOST_DOCS: Readonly<Record<string, string>> = Object.freeze({
	CODE_SERVERS: 'docs/config/config.md#defining-server-code-provider',
	ONTOLOGY_SERVERS: 'docs/config/config.md#ontology-servers',
});

/**
 * ONE actionable line per list when any entry still names the retired host. The
 * entry is NOT rewritten or dropped: the operator edits `../private/.env`.
 */
export function warnRetiredUpdateHost(
	key: string,
	servers: readonly { readonly url: string }[],
): void {
	const stale = servers.some((entry) => {
		try {
			return new URL(entry.url).hostname === RETIRED_UPDATE_HOST;
		} catch {
			return false;
		}
	});
	if (!stale) return;
	console.error(
		`[config] ${key}: an entry still points at ${RETIRED_UPDATE_HOST}, which is retired — edit ${key} in ../private/.env to https://master7.dedalo.dev/dedalo/core/api/v1/json/ (release) or https://beta7.dedalo.dev/dedalo/core/api/v1/json/ (opt-in beta, own access code) and restart. See ${STALE_HOST_DOCS[key] ?? 'docs/config/config.md'}.`,
	);
}

/**
 * ONE boot line naming the CODE-ONLY entries of ONTOLOGY_SERVERS on an ontology
 * server (entries without `tlds`): they supply an accepted access code and are
 * not pull providers. Returns the list unchanged.
 */
export function warnCodeOnlyOntologyServers<
	T extends { readonly url: string; readonly tlds?: readonly string[] },
>(isOntologyServer: boolean, servers: readonly T[]): readonly T[] {
	if (!isOntologyServer) return servers;
	const codeOnly = servers.filter((entry) => entry.tlds === undefined || entry.tlds.length === 0);
	if (codeOnly.length === 0) return servers;
	console.error(
		`[config] ONTOLOGY_SERVERS: ${codeOnly.length} code-only entr${codeOnly.length === 1 ? 'y' : 'ies'} (no tlds) on this ontology server — accepted access code(s) only, nothing is pulled from: ${codeOnly.map((entry) => entry.url).join(', ')}`,
	);
	return servers;
}

/**
 * ONE boot line when the RETIRED `ONTOLOGY_SERVER_CODE` is still set on an ontology
 * server. The key authorises nothing: clients presenting that code get 'Invalid
 * code' until it moves into an ONTOLOGY_SERVERS entry. The value is never logged.
 */
export function warnRetiredOntologyServerCode(
	isOntologyServer: boolean,
	retiredCode: string | undefined,
): void {
	if (!isOntologyServer || retiredCode === undefined || retiredCode.trim() === '') return;
	console.error(
		'[config] ONTOLOGY_SERVER_CODE is retired and NOT honoured — clients presenting that code get "Invalid code". Move its value into an ONTOLOGY_SERVERS entry (code-only entry: {"name","url","code"}, https url) in ../private/.env, remove the ONTOLOGY_SERVER_CODE line and restart. See docs/config/config.md#ontology-servers.',
	);
}

/** A server list with every entry breaking the transport rule DROPPED, loudly. */
export function secureServerList<T extends { readonly url: string }>(
	key: string,
	servers: readonly T[],
	allowHttp: boolean,
): readonly T[] {
	warnRetiredUpdateHost(key, servers);
	const kept = servers.filter((entry) => isSecureUpdateSource(entry.url, allowHttp));
	// The development seam is a test_seam key, but nothing stops it on a production
	// install: every boot that ADMITS a plain-http master says so, by key and url.
	for (const entry of kept.filter((candidate) => !isSecureUpdateSource(candidate.url, false))) {
		console.error(
			`[config] ${key}: plain-http update master ${entry.url} ADMITTED by DEDALO_UPDATE_HTTP_SOURCES_DEV — the shared access code and the update bytes cross the network in clear. A development seam: never set it on a production install.`,
		);
	}
	for (const entry of servers.filter((candidate) => !kept.includes(candidate))) {
		console.error(
			`[config] ${key}: the entry for ${entry.url} was DROPPED — an update master must be https:// (plain http is allowed only on localhost).`,
		);
	}
	return kept.length === servers.length ? servers : Object.freeze(kept);
}

/**
 * ONTOLOGY_SERVERS: the server list, each entry keeping an optional `tlds`
 * (the shared TLDs this install takes from that master — update design D-8:
 * every shared TLD comes from exactly ONE source). A `tlds` that is not an
 * array of strings drops the entry, loudly, like any other malformed field.
 */
export function readOntologyServerList(
	key: string,
): readonly { name: string; url: string; code: string; tlds?: readonly string[] }[] {
	const base = readServerList(key);
	const configured = raw(key);
	if (base.length === 0 || configured === undefined) return base;
	const parsed = JSON.parse(configured) as { url?: unknown; tlds?: unknown }[];
	const kept: { name: string; url: string; code: string; tlds?: readonly string[] }[] = [];
	for (const entry of base) {
		const tlds = parsed.find((candidate) => candidate?.url === entry.url)?.tlds;
		if (tlds === undefined) {
			kept.push(entry);
		} else if (Array.isArray(tlds) && tlds.every((tld) => typeof tld === 'string')) {
			kept.push({ ...entry, tlds: Object.freeze([...tlds]) });
		} else {
			console.error(
				`[config] ${key}: the entry for ${entry.url} was DROPPED (tlds must be an array of strings).`,
			);
		}
	}
	return Object.freeze(kept);
}

/**
 * Additional tool roots (JSON `[{"path":...,"url":...}]`). Entries missing a path/url, or
 * with a non-root-relative (cross-origin) url, are DROPPED — the browser import()s tool JS
 * from these urls, so they MUST be same-origin.
 */
export function readToolRoots(key: string): readonly { path: string; url: string }[] {
	const configured = raw(key);
	if (configured === undefined || configured.trim() === '') return Object.freeze([]);
	try {
		const parsed: unknown = JSON.parse(configured);
		if (!Array.isArray(parsed)) return Object.freeze([]);
		const roots: { path: string; url: string }[] = [];
		for (const entry of parsed) {
			const path = (entry as { path?: unknown })?.path;
			const url = (entry as { url?: unknown })?.url;
			if (typeof path !== 'string' || typeof url !== 'string') continue;
			if (!url.startsWith('/') || url.startsWith('//')) continue; // same-origin only
			roots.push({ path, url: url.replace(/\/$/, '') });
		}
		return Object.freeze(roots);
	} catch {
		return Object.freeze([]);
	}
}

/** An address the browser may open: http(s) or root-relative — never `//host`, `javascript:`, `data:`. */
function isBrowserAddress(value: string): boolean {
	return /^https?:\/\//i.test(value) || (value.startsWith('/') && !value.startsWith('//'));
}

/**
 * Publication server API v2 base URL (BASE_PATH included, no trailing slash). The browser
 * opens `<url>/docs`, so only an http(s) or root-relative address survives — anything else
 * is ignored, loudly, and the panel shows no v2 button.
 */
export function readPublicationApiV2Url(key: string): string | null {
	const value = raw(key)?.trim();
	if (value === undefined || value === '') return null;
	const url = value.replace(/\/+$/, '');
	// '/' alone strips to '' — the origin root is Dédalo's own, never the v2 API.
	if (!isBrowserAddress(value) || url === '') {
		console.error(
			`[config] ${key} is not an http(s) or root-relative address — ignoring the value.`,
		);
		return null;
	}
	return url;
}

/**
 * Publication server API v1 users (JSON `[{"db_name":...,"code":...,"api_ui":...}]`).
 * An entry without string db_name/code is DROPPED, loudly. `api_ui` is optional and is
 * opened by the browser, so only an http(s) or root-relative address survives — any other
 * scheme (`javascript:`, `data:`) is dropped and the entry falls back to the default docu.
 */
export function readPublicationApiUsers(
	key: string,
): readonly { db_name: string; code: string; api_ui: string | null }[] {
	const configured = raw(key);
	if (configured === undefined || configured.trim() === '') return Object.freeze([]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(configured);
	} catch (error) {
		console.error(
			`[config] ${key} is not valid JSON (${error instanceof Error ? error.message : 'parse error'}) — ignoring the value. It must be a JSON array of {db_name,code,api_ui?}.`,
		);
		return Object.freeze([]);
	}
	if (!Array.isArray(parsed)) {
		console.error(
			`[config] ${key} is valid JSON but not an ARRAY — ignoring the value. It must be a JSON array of {db_name,code,api_ui?}.`,
		);
		return Object.freeze([]);
	}
	const users: { db_name: string; code: string; api_ui: string | null }[] = [];
	for (const entry of parsed) {
		const dbName = (entry as { db_name?: unknown })?.db_name;
		const code = (entry as { code?: unknown })?.code;
		if (typeof dbName !== 'string' || dbName === '' || typeof code !== 'string') continue;
		const apiUi = (entry as { api_ui?: unknown })?.api_ui;
		const safeUi = typeof apiUi === 'string' && isBrowserAddress(apiUi) ? apiUi : null;
		if (apiUi !== undefined && apiUi !== null && apiUi !== '' && safeUi === null) {
			console.error(
				`[config] ${key}: api_ui of '${dbName}' is not an http(s) or root-relative address — using the default docu path.`,
			);
		}
		users.push(Object.freeze({ db_name: dbName, code, api_ui: safeUi }));
	}
	if (users.length !== parsed.length) {
		console.error(
			`[config] ${key}: ${parsed.length - users.length} of ${parsed.length} entries were DROPPED (each needs string db_name and code).`,
		);
	}
	return Object.freeze(users);
}

// ---------------------------------------------------------------------------
// Required (install-sentinel aware)
// ---------------------------------------------------------------------------

export function requireString(key: string): string {
	return String(requiredValue(key));
}

/**
 * A required JSON array. Owner rule (2026-07-09): LANGUAGE definitions are install
 * configuration — a missing or malformed value must REFUSE THE BOOT, never fall back to a
 * hardcoded list. An unconfigured box reads the sentinel so `config` stays importable there
 * (the server itself refuses to start on it — src/config/install_state.ts).
 */
export function requireList(key: string): readonly string[] {
	const entry = catalogEntry(key);
	if (UNCONFIGURED && entry.installSentinel !== undefined) {
		return Object.freeze([...(entry.installSentinel as readonly string[])]);
	}
	const value = requireEnv(key);
	try {
		const parsed: unknown = JSON.parse(value);
		if (Array.isArray(parsed) && parsed.length > 0) return Object.freeze(parsed.map(String));
	} catch {
		/* fall through to the loud refusal */
	}
	throw new Error(
		`Config key '${key}' must be a non-empty JSON array (e.g. ["lg-spa","lg-eng"]). See install/sample.env.`,
	);
}

/** Required JSON-map twin of requireList (same owner rule). */
export function requireMap(key: string): Readonly<Record<string, string>> {
	const entry = catalogEntry(key);
	if (UNCONFIGURED && entry.installSentinel !== undefined) {
		return Object.freeze({ ...(entry.installSentinel as Record<string, string>) });
	}
	const value = requireEnv(key);
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			!Array.isArray(parsed) &&
			Object.keys(parsed).length > 0
		) {
			const entries: Record<string, string> = {};
			for (const [mapKey, mapValue] of Object.entries(parsed)) entries[mapKey] = String(mapValue);
			return Object.freeze(entries);
		}
	} catch {
		/* fall through to the loud refusal */
	}
	throw new Error(
		`Config key '${key}' must be a non-empty JSON object map (e.g. {"lg-spa":"Castellano"}). See install/sample.env.`,
	);
}
