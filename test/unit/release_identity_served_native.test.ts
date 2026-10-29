/**
 * THE RELEASE IDENTITY WHERE IT IS SERVED — /health and page_globals / info
 * read from the real doors, not from hand-built payloads
 * (WC-2026-10-15-release-identity-from-tag; release identity design gates 3/4,
 * server half; page_globals `release_kind`, owner Q11).
 *
 * health_payload_native pins the pure builder with a kind it is handed, and
 * client_release_identity_wire executes the client against page_globals it
 * writes itself. Neither sees what the server ACTUALLY emits, so two wiring
 * regressions stayed green there:
 *
 *   - /health losing `release_kind` (or carrying a hardcoded kind) — the route
 *     in server.ts is what an updater, a supervisor and the drill poll;
 *   - page_globals / info_data publishing the IDENTITY (or null) as
 *     `dedalo_data_version`. On a prerelease or dev build every logged-in page
 *     would then compare '7.0.0-beta.6' with the stored '7.0.0' and render the
 *     update-data widget instead of the app (gate 3), and the code / ontology
 *     asks would carry the identity as `options.version` (gate 4).
 *
 * WHAT MAKES THE VALUE ASSERTION BITE ON EVERY CHECKOUT: `dedalo_data_version`
 * must be a BARE stable triple (no prerelease, no `.dev`) equal to the data
 * triple of `dedalo_version`. The identity itself is bare only on an exact
 * stable tag (`v7.0.0` → `7.0.0`), where it IS the data version and publishing
 * either is the same bytes; everywhere else (an untagged commit → `7.0.0.dev`,
 * a prerelease tag → `7.0.0-beta.6`) the identity fails the bare-grammar
 * check, so emitting it reds here.
 *
 * Needs the suite database (buildPageGlobals resolves the project langs,
 * buildInfoData asks Postgres its version) — the unit tier always has one.
 */

import { describe, expect, test } from 'bun:test';
import { data_version_of } from '../../client/dedalo/core/common/js/release_identity.js';
import { buildInfoData, buildPageGlobals } from '../../src/core/resolve/environment.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { RELEASE_IDENTITY } from '../../src/core/update/build_stamp.ts';
import { parseReleaseVersion } from '../../src/core/update/release_identity.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../src/core/update/version.ts';
import { createRequestContext, handleRequest } from '../../src/server.ts';

/** The data triple of an identity, by the engine's one parser (throws on garbage). */
function dataTripleOf(identity: string): string {
	const parsed = parseReleaseVersion(identity);
	if (parsed === null) throw new Error(`'${identity}' is no release identity`);
	// a developer identity names the NEXT triple: its data version is the tree's
	// own, which the server publishes beside it (dedalo_data_version)
	return parsed.dev ? formatVersion(DEDALO_DATA_VERSION) : parsed.triple.join('.');
}

/** The kind a release identity string IS, by the engine's one parser (throws on garbage). */
function kindOf(identity: string): 'stable' | 'prerelease' | 'dev' {
	const parsed = parseReleaseVersion(identity);
	if (parsed === null) throw new Error(`'${identity}' is no release identity`);
	return parsed.dev ? 'dev' : parsed.prerelease ? 'prerelease' : 'stable';
}

/** A bare stable data version: `X.Y.Z`, nothing after it. */
function isBareTriple(version: unknown): boolean {
	if (typeof version !== 'string') return false;
	const parsed = parseReleaseVersion(version);
	return parsed !== null && parsed.prerelease === null && !parsed.dev;
}

/** Assert the split every served surface must hold: identity for display, bare triple to compare. */
function expectIdentityAndDataSplit(payload: Record<string, unknown>): void {
	expect(payload.dedalo_version).toBe(RELEASE_IDENTITY.version);
	expect(payload.dedalo_data_version).toBe(formatVersion(DEDALO_DATA_VERSION));
	expect(isBareTriple(payload.dedalo_data_version)).toBe(true);
	expect(payload.dedalo_data_version).toBe(dataTripleOf(String(payload.dedalo_version)));
	// the client's own fallback derivation agrees with what the server publishes
	// (a developer identity has none: the served data key is the only source)
	const dev = parseReleaseVersion(String(payload.dedalo_version))?.dev === true;
	expect(data_version_of(String(payload.dedalo_version))).toBe(
		dev ? '' : formatVersion(DEDALO_DATA_VERSION),
	);
}

async function loggedInGlobals(): Promise<Record<string, unknown>> {
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	expect(session).not.toBeNull();
	return buildPageGlobals(session, await resolvePrincipal(-1));
}

describe('/health — the served route names the identity AND its kind', () => {
	test('version = RELEASE_IDENTITY.version, release_kind = RELEASE_IDENTITY.kind', async () => {
		const response = await handleRequest(
			new Request('http://localhost/health'),
			createRequestContext(),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.version).toBe(RELEASE_IDENTITY.version);
		expect(body.release_kind).toBe(RELEASE_IDENTITY.kind);
	});

	test('the kind the route serves is the kind its version string IS (never a hardcoded one)', async () => {
		const response = await handleRequest(
			new Request('http://localhost/health'),
			createRequestContext(),
		);
		const body = (await response.json()) as { version: string; release_kind: unknown };
		expect(body.release_kind).toBe(kindOf(body.version));
	});
});

describe('page_globals — dedalo_data_version is the bare data triple, never the identity', () => {
	test('logged in: identity for display, bare data triple beside it', async () => {
		expectIdentityAndDataSplit(await loggedInGlobals());
	});

	test("the page's own comparison over the SERVED globals finds no mismatch (gate 3 end to end)", async () => {
		const globals = await loggedInGlobals();
		// render_page.js: published data version vs the stored data_version
		// (array or string). The suite DB is built by this code's installer, so
		// its stored version IS this code's data version — a difference here is
		// exactly the update-data widget replacing the app on every page.
		const stored = Array.isArray(globals.data_version)
			? globals.data_version.join('.')
			: String(globals.data_version ?? '');
		expect(stored).toBe(formatVersion(DEDALO_DATA_VERSION));
		expect(globals.dedalo_data_version).toBe(stored);
	});

	test('logged in: release_kind = RELEASE_IDENTITY.kind, the kind the served identity IS (owner Q11)', async () => {
		const globals = await loggedInGlobals();
		expect(globals.release_kind).toBe(RELEASE_IDENTITY.kind);
		// derived from the SERVED string, so a hardcoded kind reds on any checkout
		// whose identity is of another kind
		expect(globals.release_kind).toBe(kindOf(String(globals.dedalo_version)));
	});

	test('anonymous: neither version nor its kind is published (API-03)', async () => {
		const globals = await buildPageGlobals(null, null);
		expect(globals.dedalo_version).toBeNull();
		expect(globals.dedalo_data_version).toBeNull();
		expect('release_kind' in globals).toBe(true);
		expect(globals.release_kind).toBeNull();
	});
});

describe('info_data (menu About) — the same split', () => {
	test('identity for display, bare data triple beside it', async () => {
		expectIdentityAndDataSplit(await buildInfoData());
	});
});
