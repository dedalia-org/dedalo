/**
 * Request-scoped effective languages (PHP DEDALO_APPLICATION_LANG /
 * DEDALO_DATA_LANG, which PHP defines as per-request constants seeded from the
 * user's session at bootstrap).
 *
 * WHY THIS EXISTS (spec §4, plan risk A5.1): Bun is a long-lived process, so
 * the "current language" can NOT be a module-level value the way PHP's
 * per-request constants effectively were — that would bleed one user's language
 * choice into every concurrent request. Instead the effective languages live in
 * an AsyncLocalStorage scope opened once per RQO at the dispatch chokepoint
 * (dispatchRqo) from the caller's session. Leaf resolvers (label lookup, data
 * reads, page_globals) read them through the accessors below; outside any scope
 * (unit tests calling resolvers directly, timer/scheduler work, a job submitted
 * with no scope) they fall back to the installation defaults, so behavior is
 * identical to before whenever no user override is in effect. A job-manager job
 * runs under its SUBMITTER's langs, pinned at submit (media/jobs.ts JobRunScope).
 *
 * This is the same AsyncLocalStorage pattern already used for the transaction
 * handle in core/db/postgres.ts — the boring, consistent choice (§2b).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config/config.ts';

/** The two languages every request resolves against. */
export interface RequestLangs {
	/** Interface/label language (PHP DEDALO_APPLICATION_LANG). */
	readonly applicationLang: string;
	/** Component-data language (PHP DEDALO_DATA_LANG). */
	readonly dataLang: string;
}

const requestLangStore = new AsyncLocalStorage<RequestLangs>();

/** Run `fn` with the given effective languages in scope for its whole async tree. */
export function runWithRequestLangs<T>(langs: RequestLangs, fn: () => T): T {
	return requestLangStore.run(langs, fn);
}

/**
 * The PRE-AUTH language cookie's value, or null unless it names one of THIS
 * install's application languages (DEDALO_APPLICATION_LANGS).
 *
 * THE ONE DOOR the anonymous `dedalo_lang` cookie enters by (dispatch seeds the
 * scope with it; the login handler adopts it onto the fresh session). A cookie
 * is caller-controlled input and the value goes on to key JSONB paths and label
 * lookups, so it is checked against the install's own map — not merely against
 * the lang GRAMMAR, which `all` also satisfies. Two copies of this check would
 * be two doors, and the one that drifts is the hole.
 */
export function allowlistedPreauthLang(raw: string | null | undefined): string | null {
	if (typeof raw !== 'string' || raw === '') return null;
	return Object.hasOwn(config.lang.applicationLangs, raw) ? raw : null;
}

/** A session's stored language overrides (core/security/session_store.ts `Session`); null = none chosen. */
export interface StoredSessionLangs {
	readonly applicationLang: string | null;
	readonly dataLang: string | null;
}

/**
 * THE REQUEST-LANG SEED — the ONE derivation of a caller's effective languages,
 * shared by every door that opens a scope on a user's behalf: dispatch (per RQO,
 * from the web session) and the stdio MCP server (per tool call, for its service
 * account — `src/ai/mcp/server.ts`). Two copies would be two answers to "which
 * language does this user get".
 *
 * Rungs: the session's stored choice (change_lang, or the pre-auth cookie a
 * login adopted), then the ANONYMOUS pre-auth cookie (login panel; through
 * `allowlistedPreauthLang`, its one door), then the install's MENU langs
 * (`APPLICATION_LANG` / `DATA_LANG` — a session's starting point, resolved
 * against the declared data langs in src/config/). A fresh web login carries
 * no per-account preference (session_store.ts `createSession` starts both
 * columns NULL), so `{ session: null }` is exactly what a web login of the
 * same account would be served before any menu choice.
 */
export function seedRequestLangs(input: {
	session: StoredSessionLangs | null;
	preauthLang?: string | null;
}): RequestLangs {
	return {
		applicationLang:
			input.session?.applicationLang ??
			allowlistedPreauthLang(input.preauthLang) ??
			config.menu.applicationLang,
		dataLang: input.session?.dataLang ?? config.menu.dataLang,
	};
}

/**
 * The effective interface/label language for the current request, or the
 * installation default when called outside a request scope.
 */
export function currentApplicationLang(): string {
	return requestLangStore.getStore()?.applicationLang ?? config.menu.applicationLang;
}

/**
 * The effective component-data language for the current request, or
 * `DEDALO_DATA_LANG_DEFAULT` when called outside a request scope.
 *
 * WHY THE DEFAULT IS `lang.dataLangDefault` AND NOT `menu.dataLang` (DATA-01,
 * 2026-08-27). Outside a request there is no operator and no session — a
 * scope-less job, a boot task, a CLI script — so this value is not "the language
 * someone chose", it is the language the ENGINE writes and reads in on its own
 * behalf. `DEDALO_DATA_LANG` is the MENU's current selection, a per-user thing
 * whose configured value is only a starting point, and it is NOT in the data
 * fallback chain (`resolve/component_data.ts`): a write stamped with it can land
 * in a slice no read resolves. `DEDALO_DATA_LANG_DEFAULT` IS that chain's first
 * candidate and is always a declared data language
 * (`src/config/data_langs.ts`), so a job's write is reachable by construction.
 */
export function currentDataLang(): string {
	return requestLangStore.getStore()?.dataLang ?? config.lang.dataLangDefault;
}
