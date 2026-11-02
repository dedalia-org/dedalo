/**
 * Phase 7 gate: the client environment payload (page_globals + plain_vars +
 * get_label) matches live PHP — this is the exact object the copied client
 * injects via set_environment() at boot, so parity here is what makes the
 * copied client boot against the TS server (rewrite/client_seam.md seam item 1).
 *
 * Compared:
 * - get_label: CONTAINMENT since WC-033 (labels are repo catalogs — the served
 *   dictionary is a SUPERSET of the frozen oracle one: every oracle key must
 *   be present with the oracle's value, except the two ledgered dup-name
 *   collision fixes; TS-only keys are the catalog additions);
 * - plain_vars: exact equality (urls/flags/DD_TIPOS mirror the install);
 * - page_globals: exact KEY SET + exact values except the engine-specific
 *   debug facts (pg/php version, memory, root path — PHP engine values by
 *   definition), dedalo_build/data_version (deploy stamps) and dedalo_db_name
 *   (the INSTALLATION's own database name);
 * - dedalo_projects_default_langs: the ENTRIES exactly, the ORDER deliberately
 *   not (WC-2026-08-23-projects-default-langs-derived — the oracle's order is a
 *   heap-scan artefact, the TS order is the configured one).
 *
 * NOT A TLD-BOUND GATE: it names no ontology at all. `dedalo_db_name` joined
 * the presence-only set 2026-08-19 for the same reason the TLD law exists —
 * the frozen value is one installation's database, and every other machine
 * (this suite included) serves a different one. It is asserted to be a
 * non-empty string on both sides, so the key can never silently vanish.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { readEnv } from '../../src/config/env.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { parseReleaseVersion } from '../../src/core/update/release_identity.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/**
 * The frozen PHP fixture stores its dev identity in the PHP-era dotted form (`7.0.0.dev`).
 * The engine names dev builds `X.Y.Z-dev` (build_stamp / release_identity). The fixture
 * is frozen and cannot be re-harvested, so only this one legacy spelling is mapped onto
 * the current one here — the data triple is what is compared, never the spelling.
 */
function legacyPhpDevToIdentity(version: string): string {
	return version.replace(/^(\d+\.\d+\.\d+)\.dev$/, '$1-dev');
}

/**
 * Engine/deploy/INSTALLATION-specific page_globals keys compared for PRESENCE
 * only — their values are facts about the machine serving them, never about
 * the payload builder. `dedalo_db_name` is the strongest case: the frozen
 * oracle's value is the name of ONE install's database.
 */
const ENGINE_SPECIFIC_KEYS = new Set([
	// The installation's own NAME. Same class as `dedalo_db_name` and missed for
	// the same reason it was caught: the frozen oracle recorded `monedaiberica`,
	// the install the 2026-07-11 harvest ran against, so comparing it exactly
	// asserted "this runner IS that installation". It passed on the developer's
	// box (../private/.env sets that ENTITY) and could never pass anywhere else —
	// scripts/ci/db_tier.sh exports ENTITY=ci_db_tier, so the hosted DB tier was
	// red on this from its first run. Presence-only, and still non-empty below.
	'dedalo_entity',
	'pg_version',
	'php_version',
	'php_memory',
	'dedalo_root_path',
	'dedalo_build',
	'data_version',
	'dedalo_last_error',
	'dedalo_db_name',
]);

/**
 * Presence-only keys that must still be a NON-EMPTY STRING on both sides.
 * (`dedalo_root_path` is deliberately NOT here: the TS side serves an object
 * there, a pre-existing shape divergence this gate has always ledgered as
 * engine-specific and which is not this migration's subject.)
 */
const NON_EMPTY_STRING_KEYS = ['dedalo_db_name', 'dedalo_entity'] as const;

/**
 * The one page_globals key whose ORDER is a deliberate divergence
 * (engineering/wire_contract/WC-2026-08-23-projects-default-langs-derived.md).
 * Its entries are still compared exactly — see the compare in the page_globals test.
 */
const PROJECT_LANGS_KEY = 'dedalo_projects_default_langs';

describe.if(hasPhpCredentials())('environment payload differential (Phase 7 gate)', () => {
	let phpEnv: Record<string, Record<string, unknown>>;
	let tsEnv: Record<string, Record<string, unknown>>;

	beforeAll(async () => {
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call({
			action: 'start',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {},
		} as unknown as Record<string, unknown>);
		phpEnv = (body as { environment: { result: Record<string, Record<string, unknown>> } })
			.environment.result;

		const token = createSession(-1, 'root', true);
		const session = getSession(token);
		// get_label and dedalo_application_lang are LANGUAGE-SCOPED: compare the
		// TS payload under the SAME application lang the frozen oracle session was
		// captured with — this install's DEDALO_APPLICATION_LANGS_DEFAULT may
		// differ, and since WC-033 the served dictionary honors the request lang
		// (no unconditional structure-lang overlay to mask a lang mismatch here).
		const oracleAppLang = (phpEnv.page_globals as Record<string, unknown>)
			.dedalo_application_lang as string;
		if (session !== null && typeof oracleAppLang === 'string') {
			session.applicationLang = oracleAppLang;
		}
		const principal = await resolvePrincipal(-1);
		const tsResult = await dispatchRqo(
			{ action: 'start', dd_api: 'dd_core_api', prevent_lock: true, source: {} } as unknown as Rqo,
			{
				requestId: 't',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal,
			},
		);
		tsEnv = (
			tsResult.body as unknown as {
				environment: { result: Record<string, Record<string, unknown>> };
			}
		).environment.result;
	});

	test('get_label: every oracle key is served, renamed, or ledger-removed (WC-033/WC-034)', () => {
		const phpLabels = phpEnv.get_label as Record<string, string>;
		const tsLabels = tsEnv.get_label as Record<string, string>;
		expect(Object.keys(tsLabels).length).toBeGreaterThan(400);
		// WC-034 label cleanup: the repo catalogs renamed non-conforming keys,
		// migrated tool-specific keys into their tools' register.json labels,
		// and removed unused keys — all ledgered in the machine-readable map.
		// The two WC-033 dup-name value fixes ride the same map:
		// no_hay_etiqueta_seleccionada → no_tag_selected (value deliberately
		// differs) and tool_watermark (removed — unreferenced).
		const wc034 = JSON.parse(
			readFileSync(resolve(import.meta.dir, 'wc034_label_cleanup.json'), 'utf8'),
		) as {
			renames: Record<string, string>;
			tool_migrations: Record<string, unknown>;
			removals: string[];
		};
		const removed = new Set([...wc034.removals, ...Object.keys(wc034.tool_migrations)]);
		const unaccounted: string[] = [];
		for (const [key, value] of Object.entries(phpLabels)) {
			const renamed = wc034.renames[key];
			if (renamed !== undefined) {
				// Renamed: the new key must serve (value may legitimately differ —
				// e.g. the WC-033 dup-name fix, or a merge into an existing key).
				if (tsLabels[renamed] === undefined) unaccounted.push(`${key} → ${renamed} (missing)`);
			} else if (removed.has(key)) {
				if (tsLabels[key] !== undefined) unaccounted.push(`${key} (ledger-removed but served)`);
			} else if (tsLabels[key] !== value) {
				unaccounted.push(`${key} (value mismatch or missing)`);
			}
		}
		expect(unaccounted).toEqual([]);
	});

	test('plain_vars: urls, flags and DD_TIPOS match exactly', () => {
		const phpVars = { ...(phpEnv.plain_vars as Record<string, unknown>) };
		const tsVars = { ...(tsEnv.plain_vars as Record<string, unknown>) };
		// engineering/wire_contract/ WC-003 (self-contained cutover posture): under
		// DEDALO_DIFFUSION_NATIVE=true the TS engine deliberately OMITS
		// DEDALO_DIFFUSION_API_URL (the client must not call the legacy Bun
		// diffusion route — the TS server does not serve it). The PHP oracle
		// install still publishes it. Assert the divergence explicitly, then
		// compare the rest exactly.
		if (readEnv('DEDALO_DIFFUSION_NATIVE') === 'true') {
			expect('DEDALO_DIFFUSION_API_URL' in tsVars).toBe(false);
			expect('DEDALO_DIFFUSION_API_URL' in phpVars).toBe(true);
			// DELETE, not `= undefined`: toEqual distinguishes a key present with
			// value undefined from an absent key, so assigning undefined here left
			// the very divergence this branch exists to neutralise in the diff.
			// biome-ignore lint/performance/noDelete: see above — key ABSENCE is the assertion
			delete phpVars.DEDALO_DIFFUSION_API_URL;
		}
		expect(tsVars).toEqual(phpVars);
	});

	test('page_globals: same key set; same values outside engine-specific facts', () => {
		const phpGlobals = { ...(phpEnv.page_globals ?? {}) };
		const tsGlobals = { ...(tsEnv.page_globals ?? {}) };
		// engineering/wire_contract/ WC-031: `is_ontology_server` is a TS-ONLY page_globals key
		// (PHP get_page_globals has no twin) driving the ontology-master client skin.
		// Assert the divergence explicitly, then compare the rest of the key set exactly.
		expect('is_ontology_server' in tsGlobals).toBe(true);
		expect('is_ontology_server' in phpGlobals).toBe(false);
		// The key must LEAVE the object: the exact key-set compare below reads Object.keys(),
		// which still lists a key assigned undefined. Local literal, so perf is moot.
		// biome-ignore lint/performance/noDelete: an undefined assignment would fail the key-set compare
		delete tsGlobals.is_ontology_server;
		// engineering/wire_contract/ WC-2026-10-21-error-report-granted: TS-ONLY key (the
		// error-report launcher's grant). Same explicit-then-strip handling as WC-031.
		expect('tool_error_report_granted' in tsGlobals).toBe(true);
		expect('tool_error_report_granted' in phpGlobals).toBe(false);
		// biome-ignore lint/performance/noDelete: same as the WC-031 strip above
		delete tsGlobals.tool_error_report_granted;
		// engineering/wire_contract/ WC-2026-11-02-ui-preferences: TS-ONLY key (the
		// user's dd1206 UI preferences). Same explicit-then-strip handling as WC-031.
		expect('ui_preferences' in tsGlobals).toBe(true);
		expect('ui_preferences' in phpGlobals).toBe(false);
		// biome-ignore lint/performance/noDelete: same as the WC-031 strip above
		delete tsGlobals.ui_preferences;
		// engineering/wire_contract/ WC-038: `ip_api` REMOVED from page_globals — IP→country
		// resolution moved server-side/offline (src/core/geoip). The frozen PHP
		// oracle still carries it; strip it PHP-side (the mirror of the WC-031
		// TS-only handling above) before the exact key-set compare.
		expect('ip_api' in phpGlobals).toBe(true);
		expect('ip_api' in tsGlobals).toBe(false);
		// biome-ignore lint/performance/noDelete: same as the WC-031 strip above — undefined would keep 'ip_api' in Object.keys()
		delete phpGlobals.ip_api;
		// engineering/wire_contract/ WC-051: three TS-ONLY page_globals keys carrying the
		// session-expiry warning contract. PHP has no twin because it had nothing to
		// warn about — its client learned the session was gone only by being refused.
		// Same explicit-then-strip handling as WC-031.
		for (const key of [
			'dedalo_session_ttl_seconds',
			'dedalo_session_absolute_expires_in',
			'dedalo_session_warning_seconds',
		]) {
			expect(key in tsGlobals).toBe(true);
			expect(key in phpGlobals).toBe(false);
			delete tsGlobals[key];
		}
		// engineering/wire_contract/WC-2026-09-04-client-limit-bound.md: the SERVER's
		// client ceiling is a TS-ONLY page_globals key — the client bounds every
		// limit it sends to it instead of sending 0. PHP had no twin: its client
		// sent 0 and its server clamped in silence. Same explicit-then-strip
		// handling as WC-031.
		expect(typeof tsGlobals.dedalo_search_client_max_limit).toBe('number');
		expect(tsGlobals.dedalo_search_client_max_limit as number).toBeGreaterThan(0);
		expect('dedalo_search_client_max_limit' in phpGlobals).toBe(false);
		// biome-ignore lint/performance/noDelete: same as the WC-031 strip above — undefined would keep the key in Object.keys()
		delete tsGlobals.dedalo_search_client_max_limit;
		// engineering/wire_contract/WC-2026-10-15-release-identity-from-tag.md:
		// `dedalo_data_version` is a TS-ONLY page_globals key — the bare data triple
		// beside `dedalo_version`, which became the RELEASE IDENTITY (`7.0.0-beta.6`).
		// PHP had no twin: its version string WAS the data version. Gated on the
		// session like `dedalo_version` (API-03), so the oracle's anonymous or
		// logged capture decides the value; only its presence is a contract here.
		expect('dedalo_data_version' in tsGlobals).toBe(true);
		expect('dedalo_data_version' in phpGlobals).toBe(false);
		// biome-ignore lint/performance/noDelete: same as the WC-031 strip above — undefined would keep the key in Object.keys()
		delete tsGlobals.dedalo_data_version;
		// Same entry, addendum 2026-10-18 (owner Q11): `release_kind` — TS-ONLY, the
		// identity's kind (`stable` | `prerelease` | `dev`) the menu's version badge
		// reads instead of sniffing the identity. PHP had no identity to classify.
		// Gated like `dedalo_version`, so only presence is a contract here.
		expect('release_kind' in tsGlobals).toBe(true);
		expect('release_kind' in phpGlobals).toBe(false);
		// biome-ignore lint/performance/noDelete: same as the WC-031 strip above — undefined would keep the key in Object.keys()
		delete tsGlobals.release_kind;
		// engineering/wire_contract/WC-2026-10-29-ai-capabilities-page-globals: TS-ONLY key
		// (which AI entry points the deployment can offer). Same explicit-then-strip handling.
		expect('ai_capabilities' in tsGlobals).toBe(true);
		expect('ai_capabilities' in phpGlobals).toBe(false);
		// biome-ignore lint/performance/noDelete: same as the WC-031 strip above — undefined would keep the key in Object.keys()
		delete tsGlobals.ai_capabilities;
		expect(Object.keys(tsGlobals).sort()).toEqual(Object.keys(phpGlobals).sort());
		// engineering/wire_contract/WC-2026-08-23-projects-default-langs-derived.md:
		// `dedalo_projects_default_langs` is DERIVED per installation now, and its ORDER
		// is the configured order. The frozen oracle's order is not a contract to match:
		// PHP's lang::resolve_multiple issued ONE set-membership SELECT over
		// matrix_langs with NO ORDER BY, so the array carried whatever order the heap
		// scan produced — MEASURED 2026-08-23, the same twelve languages come back in
		// three different orders from three databases (fixture:
		// nep,eng,deu,fra,vlca,ara,cat,ell,eus,ita,por,spa; this installation:
		// ara,ell,vlca,eng,eus,fra,ita,por,spa,cat,deu,nep; its own suite clone:
		// ell,por,cat,eng,ara,deu,eus,fra,ita,nep,spa,vlca). Matching it would assert a
		// database's page layout, and PHP additionally froze the value in a file cache,
		// so the fixture is one heap at one instant.
		//
		// So the ORDER — and ONLY the order — diverges: the twelve ENTRIES are compared
		// exactly, order-insensitively, so a wrong label, a wrong tld2, a dropped or an
		// extra language still fails here.
		const projectLangs = (globals: Record<string, unknown>) =>
			[...(globals[PROJECT_LANGS_KEY] as { value: string }[])].sort((a, b) =>
				a.value.localeCompare(b.value),
			);
		expect(projectLangs(tsGlobals)).toEqual(projectLangs(phpGlobals));
		// …and the TS order is not arbitrary either: it is DEDALO_PROJECTS_DEFAULT_LANGS
		// verbatim, which is what makes two installations with the same configuration
		// answer the same thing (the fossil order never did).
		expect((tsGlobals[PROJECT_LANGS_KEY] as { value: string }[]).map((e) => e.value)).toEqual([
			...config.menu.projectsDefaultLangs,
		]);
		// engineering/wire_contract/WC-2026-10-15-release-identity-from-tag.md:
		// `dedalo_version` is the RELEASE IDENTITY now, read from the git tag of the
		// tree serving it (`7.0.0` / `7.0.0-beta.6` / `7.0.0.dev`) — a fact about
		// the checkout, like `dedalo_build`. The frozen value (`7.0.0.dev`, an
		// untagged PHP-era checkout) is compared for what still binds: it is an
		// identity of the SAME data triple. A tag-less byte compare would pass on
		// an untagged checkout only and red on every tagged one.
		const tsIdentity = parseReleaseVersion(String(tsGlobals.dedalo_version));
		const phpIdentity = parseReleaseVersion(
			legacyPhpDevToIdentity(String(phpGlobals.dedalo_version)),
		);
		expect(tsIdentity).not.toBeNull();
		expect(phpIdentity).not.toBeNull();
		expect([...(tsIdentity?.triple ?? [])]).toEqual([...(phpIdentity?.triple ?? [])]);
		for (const key of Object.keys(phpGlobals)) {
			if (ENGINE_SPECIFIC_KEYS.has(key)) continue;
			if (key === PROJECT_LANGS_KEY) continue; // asserted order-insensitively above
			if (key === 'dedalo_version') continue; // asserted by data triple above (WC-2026-10-15)
			expect({ [key]: tsGlobals[key] }).toEqual({ [key]: phpGlobals[key] });
		}
		// Presence-only is not value-free: the installation facts must still be
		// real non-empty strings on BOTH sides, or "compared for presence only"
		// would quietly cover a key that stopped being served at all.
		for (const key of NON_EMPTY_STRING_KEYS) {
			for (const [side, globals] of [
				['php', phpGlobals],
				['ts', tsGlobals],
			] as const) {
				const value = globals[key];
				expect({ side, key, type: typeof value }).toEqual({ side, key, type: 'string' });
				expect({ side, key, empty: String(value).length === 0 }).toEqual({
					side,
					key,
					empty: false,
				});
			}
		}
	});
});
