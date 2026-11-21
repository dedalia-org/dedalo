/**
 * THE EXPORT ARTIFACT DOWNLOAD ROUTE — behavioural gate for
 * `GET /dedalo/export/artifact/<jobId>/<basename>` (tools/tool_export/server/download.ts
 * + its registration as tool_export's `httpRoutes` entry, which the router
 * dispatches through loader.ts toolHttpRouteFor).
 *
 * Every request goes through the REAL server entry point (`handleRequest`), so the
 * route's placement before the generic /dedalo/ static handler is exercised too.
 *
 * THE SITUATION IS BUILT HERE:
 *   - identities: the synthetic ACL fixture (test/helpers/acl_identity_fixture.ts) —
 *     a reader (test3 read grant) and a global admin (a DIFFERENT user), plus real
 *     sessions in the per-run scratch session store;
 *   - artifacts: jobs created in the suite's OWN export root (the test seam's marked
 *     `<test media root>.export_artifacts`, the same default root the route opens),
 *     their spool written, ended, and an ndjson file BUILT through buildArtifactFile —
 *     the one door a downloadable file comes into existence by. All swept in afterAll.
 *
 * What is asserted is OUTCOMES: status codes, the exact bytes served, the headers.
 * Every 404 leg has its 200 twin (the owner, the ended job, the granted section), so
 * no refusal can be green because the route never served anything at all.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEnv } from '../../src/config/env.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	resolvePrincipal,
	SUPERUSER_ID,
} from '../../src/core/security/permissions.ts';
import { sessionPrincipalFromCookie } from '../../src/core/security/session_gate.ts';
import { createSession, SESSION_COOKIE } from '../../src/core/security/session_store.ts';
import { resetRegistryCache } from '../../src/core/tools/registry.ts';
import { handleRequest } from '../../src/server.ts';
import { exportRecordScope } from '../../tools/tool_export/server/access.ts';
import {
	type ArtifactJobRef,
	type ArtifactStore,
	openArtifactStore,
	SPOOL_FILES,
} from '../../tools/tool_export/server/artifact_store.ts';
import {
	attachmentDisposition,
	downloadFileName,
	EXPORT_ARTIFACT_URL_PREFIX,
	exportArtifactUrl,
	formatOfArtifactName,
	parseExportArtifactPath,
	serveExportArtifact,
} from '../../tools/tool_export/server/download.ts';
import { summarizeJob } from '../../tools/tool_export/server/export_job.ts';
import { buildArtifactFile } from '../../tools/tool_export/server/writers/index.ts';
import {
	ACL_ADMIN_USER_ID,
	ACL_DENIED_COMPONENT,
	ACL_GRANTED_COMPONENT,
	ACL_GRANTED_SECTION,
	ACL_NON_ADMIN_PROFILE_ID,
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
	resolveAclGrantedToolRegistryId,
} from '../helpers/acl_identity_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const BUILT = 'export.ndjson';

let store: ArtifactStore;
let readerCookie = '';
let adminCookie = '';
/** The reader's ended job with a built ndjson file (the positive control). */
let ended: ArtifactJobRef;
/** The reader's job whose file was built, then put back to 'running'. */
let running: ArtifactJobRef;
const jobs: ArtifactJobRef[] = [];

/** A small protocol stream (meta, col*, row*, end) with a non-ASCII value. */
function protocolLines(): Record<string, unknown>[] {
	return [
		{ t: 'meta', v: 1, section_tipo: ACL_GRANTED_SECTION, total: 2 },
		{ t: 'col', i: 0, key: 'id', label: 'Id', cell_type: 'section_id', after: null },
		{ t: 'col', i: 1, key: 'test52', label: 'Title', cell_type: 'text', after: 0 },
		{ t: 'row', rec: 1, sub: 0, c: { '0': '1', '1': 'título "q" <b>' } },
		{ t: 'row', rec: 2, sub: 0, c: { '0': '2', '1': 'dos' } },
		{ t: 'end', columns: [0, 1], rows: 2, records: 2 },
	];
}

/** Create a reader job, spool it, end it, and build its ndjson file. */
async function builtReaderJob(): Promise<ArtifactJobRef> {
	const { job } = await store.createJob({
		userId: ACL_NON_ADMIN_USER_ID,
		sectionTipo: ACL_GRANTED_SECTION,
		sections: [ACL_GRANTED_SECTION],
		options: { data_format: 'standard' },
		recordScope: await exportRecordScope(await resolvePrincipal(ACL_NON_ADMIN_USER_ID)),
		frameColumns: [],
		applicationLang: 'lg-eng',
	});
	jobs.push(job);
	const writer = await store.openSpoolWriter(job, {});
	for (const line of protocolLines()) await writer.write(line);
	const stats = await writer.close();
	await store.updateManifest(job, {
		status: 'ended',
		ended_at: new Date().toISOString(),
		columns: stats.columns,
		records: stats.records,
		rows: stats.rows,
	});
	await buildArtifactFile({
		store,
		job,
		format: 'ndjson',
		options: { origin: 'http://localhost', showTipoInLabel: false },
		signal: new AbortController().signal,
	});
	return job;
}

/** GET through the real server entry point. */
async function get(path: string, cookie?: string): Promise<Response> {
	return handleRequest(
		new Request(`http://localhost${path}`, cookie === undefined ? {} : { headers: { cookie } }),
		{ requestId: 'export_artifact_download', startedAt: 0 },
	);
}

/** Status + drained body (a served file must never be held open across tests). */
async function statusOf(path: string, cookie?: string): Promise<number> {
	const response = await get(path, cookie);
	await response.arrayBuffer();
	return response.status;
}

/**
 * Grant (or revoke) tool_export on the reader PROFILE's dd1067 — the only thing
 * that authorizes a restricted tool for a non-superuser (registry.ts
 * getUserTools). The fixture's scratch profile is ours; the fixture teardown
 * deletes it. The cache drop is what a profile save performs.
 */
async function setReaderToolGrant(granted: boolean): Promise<void> {
	const registryId = await resolveAclGrantedToolRegistryId();
	const grants = granted
		? [
				{
					id: 1,
					type: 'dd151',
					section_id: registryId,
					section_tipo: 'dd1324',
					from_component_tipo: 'dd1067',
				},
			]
		: [];
	await sql`UPDATE matrix_profiles
		SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), '{dd1067}', ${JSON.stringify(grants)}::text::jsonb)
		WHERE section_tipo = 'dd234' AND section_id = ${ACL_NON_ADMIN_PROFILE_ID}`;
	resetRegistryCache();
}

/** The profile's dd774 grant rows (restored after the revocation leg). */
let readerGrants: unknown = null;

beforeAll(async () => {
	await installAclIdentityFixture();
	store = openArtifactStore();
	readerCookie = `${SESSION_COOKIE}=${createSession(ACL_NON_ADMIN_USER_ID, 'zzacl_reader', false)}`;
	adminCookie = `${SESSION_COOKIE}=${createSession(ACL_ADMIN_USER_ID, 'zzacl_admin', true)}`;
	// The reader holds tool_export too (the fixture grants it only to the admin
	// profile): the route asks the dispatcher's tool gate (active + authorized),
	// so without it no leg below could ever answer 200.
	await setReaderToolGrant(true);
	ended = await builtReaderJob();
	running = await builtReaderJob();
	await store.updateManifest(running, { status: 'running', ended_at: null });
	const rows = await sql`SELECT misc->'dd774' AS grants FROM matrix_profiles
		WHERE section_tipo = 'dd234' AND section_id = ${ACL_NON_ADMIN_PROFILE_ID}`;
	readerGrants = rows[0]?.grants ?? null;
});

afterAll(async () => {
	for (const job of jobs) await store.deleteJob(job);
	for (const userId of [ACL_NON_ADMIN_USER_ID, ACL_ADMIN_USER_ID]) {
		rmSync(join(store.root, String(userId)), { recursive: true, force: true });
	}
	await removeAclIdentityFixture();
});

describe('the owner is served the exact bytes', () => {
	test('200, the built file byte for byte, as an attachment that is never cached', async () => {
		const response = await get(exportArtifactUrl(ended.jobId, BUILT), readerCookie);
		expect(response.status).toBe(200);
		const served = new Uint8Array(await response.arrayBuffer());
		const onDisk = readFileSync(join(ended.dir, BUILT));
		expect(served.length).toBeGreaterThan(0);
		expect(Buffer.from(served).equals(onDisk)).toBe(true);
		// ndjson IS the spool: the served bytes are the protocol stream itself.
		expect(Buffer.from(served).equals(readFileSync(join(ended.dir, SPOOL_FILES.grid)))).toBe(true);
		expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
		expect(response.headers.get('content-disposition')).toMatch(
			/^attachment; filename="dedalo_export_test3_\d{4}-\d{2}-\d{2}\.ndjson"$/,
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
	});
	test('the link the job API EMITS is the link this route serves (no prefix drift)', async () => {
		// The URL a client actually receives is the one the job API emits (list/build
		// responses, built by download.ts exportArtifactUrl — the ONE builder); the
		// route is matched by the tool's registered prefix and parsed by download.ts.
		// Measured end to end, so any of them drifting reds here.
		const summary = summarizeJob(await store.readManifest(ended), store);
		const emitted = summary.files.find((file) => file.basename === BUILT)?.url;
		expect(emitted).toBe(exportArtifactUrl(ended.jobId, BUILT));
		if (emitted === undefined) throw new Error('the job API emitted no link for the built file');
		const response = await get(emitted, readerCookie);
		expect(response.status).toBe(200);
		expect(
			Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(ended.dir, BUILT))),
		).toBe(true);
	});
});

describe('an UNEXPECTED re-check failure is a 404 — but never a silent one', () => {
	test('a fault inside the re-check is journaled with the job id; the healthy twin serves', async () => {
		const url = exportArtifactUrl(ended.jobId, BUILT);
		// The fault: the store's TTL (read by the re-check's lifetime ceiling)
		// throws a plain TypeError — the shape of a bug or a dropped dependency.
		const faulty = new Proxy(store, {
			get(target, prop, receiver) {
				if (prop === 'ttlHours') throw new TypeError('seam: the re-check broke');
				return Reflect.get(target, prop, receiver);
			},
		});
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args.map((arg) => String(arg)).join(' '));
		};
		let refused: Response | null;
		try {
			refused = await serveExportArtifact(url, readerCookie, { store: faulty });
		} finally {
			console.error = original;
		}
		expect(refused).toBeNull();
		expect(
			logged.some((line) => line.includes('[tool_export]') && line.includes(ended.jobId)),
			'the unexpected failure must reach the log',
		).toBe(true);
		// twin: the same request with the healthy store is served, and logs nothing
		const quiet: string[] = [];
		console.error = (...args: unknown[]) => {
			quiet.push(args.map((arg) => String(arg)).join(' '));
		};
		let served: Response | null;
		try {
			served = await serveExportArtifact(url, readerCookie, { store });
		} finally {
			console.error = original;
		}
		expect(served?.status).toBe(200);
		await served?.arrayBuffer();
		expect(quiet).toEqual([]);
	});
});

describe('everyone else gets the one 404 (resource.not_found, never 403)', () => {
	test('another user — even a global admin — cannot fetch the reader’s job', async () => {
		const response = await get(exportArtifactUrl(ended.jobId, BUILT), adminCookie);
		expect(response.status).toBe(404);
		const body = (await response.json()) as { ok: boolean; error: { code: string } };
		expect(body.ok).toBe(false);
		expect(body.error.code).toBe('resource.not_found');
	});

	test('anonymous, a forged cookie, an empty cookie', async () => {
		const path = exportArtifactUrl(ended.jobId, BUILT);
		expect(await statusOf(path)).toBe(404);
		expect(await statusOf(path, `${SESSION_COOKIE}=${'f'.repeat(64)}`)).toBe(404);
		expect(await statusOf(path, `${SESSION_COOKIE}=`)).toBe(404);
		// A cookie whose NAME merely begins with the session cookie's name.
		expect(await statusOf(path, `${SESSION_COOKIE}x=${readerCookie.split('=')[1]}`)).toBe(404);
	});

	test('an unknown job id, and a format that was never built', async () => {
		expect(await statusOf(exportArtifactUrl('exp_nothing_here', BUILT), readerCookie)).toBe(404);
		expect(await statusOf(exportArtifactUrl(ended.jobId, 'export.csv'), readerCookie)).toBe(404);
	});

	test('traversal — plain, percent-encoded, absolute — through the server', async () => {
		const job = ended.jobId;
		// (`<job>/../<job>/<file>` is NOT here: the URL parser folds it to the owner's own
		// `<job>/<file>` before any handler runs — that is the same file, not an escape.)
		for (const path of [
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/../../../../etc/passwd`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/%2e%2e/%2e%2e/${ACL_ADMIN_USER_ID}/${job}/${BUILT}`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/%2e%2e`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/..%2f${job}%2f${BUILT}`,
			`${EXPORT_ARTIFACT_URL_PREFIX}..%2f${ACL_NON_ADMIN_USER_ID}%2f${job}/${BUILT}`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}//etc/passwd`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/%2Fetc%2Fpasswd`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/${BUILT}/`,
		]) {
			expect(await statusOf(path, readerCookie), path).toBe(404);
		}
	});

	test('traversal handed RAW to the handler (no URL normalization in between)', async () => {
		const job = ended.jobId;
		for (const raw of [
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/../${job}/${BUILT}`,
			`${EXPORT_ARTIFACT_URL_PREFIX}../${ACL_NON_ADMIN_USER_ID}/${job}/${BUILT}`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/%2e%2e%2f${BUILT}`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}//etc/passwd`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${job}/${join(ended.dir, BUILT)}`,
			`${EXPORT_ARTIFACT_URL_PREFIX}${join(ended.dir, BUILT)}`,
		]) {
			expect(parseExportArtifactPath(raw), raw).toBeNull();
			expect(await serveExportArtifact(raw, readerCookie), raw).toBeNull();
		}
		// Positive twin through the same handler.
		const served = await serveExportArtifact(exportArtifactUrl(job, BUILT), readerCookie);
		expect(served?.status).toBe(200);
		await served?.arrayBuffer();
	});

	test('names outside the allowlist — the spool, the manifest, a temp — even though they exist', async () => {
		const job = ended.jobId;
		writeFileSync(join(ended.dir, 'export.ndjson.tmp'), 'partial');
		for (const name of [
			SPOOL_FILES.grid,
			SPOOL_FILES.cols,
			SPOOL_FILES.index,
			SPOOL_FILES.manifest,
			'export.ndjson.tmp',
			'export.exe',
		]) {
			expect(await statusOf(exportArtifactUrl(job, name), readerCookie), name).toBe(404);
		}
		rmSync(join(ended.dir, 'export.ndjson.tmp'), { force: true });
	});

	test('an allowlisted file on disk the builder never COMMITTED (absent from the manifest)', async () => {
		writeFileSync(join(ended.dir, 'export.csv'), 'a;b\n');
		expect(await statusOf(exportArtifactUrl(ended.jobId, 'export.csv'), readerCookie)).toBe(404);
		rmSync(join(ended.dir, 'export.csv'), { force: true });
	});

	test('a job that has not ended (its file exists and is recorded)', async () => {
		expect(await statusOf(exportArtifactUrl(running.jobId, BUILT), readerCookie)).toBe(404);
		// The same job, ended: served — so the status is what closed it.
		await store.updateManifest(running, { status: 'ended' });
		expect(await statusOf(exportArtifactUrl(running.jobId, BUILT), readerCookie)).toBe(200);
		await store.updateManifest(running, { status: 'cancelled' });
		expect(await statusOf(exportArtifactUrl(running.jobId, BUILT), readerCookie)).toBe(404);
		await store.updateManifest(running, { status: 'running' });
	});

	test('a committed file replaced by a symlink is not followed', async () => {
		const path = join(running.dir, BUILT);
		await store.updateManifest(running, { status: 'ended' });
		expect(await statusOf(exportArtifactUrl(running.jobId, BUILT), readerCookie)).toBe(200);
		rmSync(path);
		symlinkSync(join(running.dir, SPOOL_FILES.manifest), path);
		expect(await statusOf(exportArtifactUrl(running.jobId, BUILT), readerCookie)).toBe(404);
		await store.updateManifest(running, { status: 'running' });
	});

	test('the reader’s section grant revoked AFTER the build closes the file on the next request', async () => {
		const path = exportArtifactUrl(ended.jobId, BUILT);
		expect(await statusOf(path, readerCookie)).toBe(200);
		try {
			// Revoke: drop every test3 row from the reader profile's dd774 matrix. The
			// cache drop is the invalidation a profile save performs
			// (invalidatePermissionsForWrite); the route itself caches nothing.
			await sql`UPDATE matrix_profiles
				SET misc = jsonb_set(misc, '{dd774}', COALESCE((
					SELECT jsonb_agg(entry) FROM jsonb_array_elements(misc->'dd774') AS entry
					WHERE entry->>'section_tipo' <> ${ACL_GRANTED_SECTION}), '[]'::jsonb))
				WHERE section_tipo = 'dd234' AND section_id = ${ACL_NON_ADMIN_PROFILE_ID}`;
			clearPermissionsCache();
			expect(await statusOf(path, readerCookie)).toBe(404);
		} finally {
			await sql`UPDATE matrix_profiles
				SET misc = jsonb_set(misc, '{dd774}', ${JSON.stringify(readerGrants)}::text::jsonb)
				WHERE section_tipo = 'dd234' AND section_id = ${ACL_NON_ADMIN_PROFILE_ID}`;
			clearPermissionsCache();
		}
		// Restored grant: served again — so it was the grant that closed it.
		expect(await statusOf(path, readerCookie)).toBe(200);
	});

	test('the reader REMOVED FROM THEIR PROJECT after the build closes the file; put back, it is served again', async () => {
		// The spool holds the records the reader's projects reached when the walk
		// ran; the grants alone (all still held) would keep serving them. The
		// manifest's record scope is what closes it (access.ts exportRecordScope).
		const path = exportArtifactUrl(ended.jobId, BUILT);
		expect(await statusOf(path, readerCookie)).toBe(200);
		const [row] = (await sql`SELECT relation->'dd170' AS projects FROM matrix_users
			WHERE section_tipo = 'dd128' AND section_id = ${ACL_NON_ADMIN_USER_ID}`) as {
			projects: unknown;
		}[];
		const projects = JSON.stringify(row?.projects ?? []);
		const setProjects = async (value: string): Promise<void> => {
			await sql`UPDATE matrix_users
				SET relation = jsonb_set(relation, '{dd170}', ${value}::text::jsonb)
				WHERE section_tipo = 'dd128' AND section_id = ${ACL_NON_ADMIN_USER_ID}`;
			clearUserProjectsCache();
			clearPrincipalCache();
			clearPermissionsCache();
		};
		try {
			await setProjects('[]');
			expect(await statusOf(path, readerCookie)).toBe(404);
		} finally {
			await setProjects(projects);
		}
		expect(await statusOf(path, readerCookie)).toBe(200);
	});

	test('an export past its end + TTL is not served, even before the sweep removes it', async () => {
		const path = exportArtifactUrl(ended.jobId, BUILT);
		const before = await store.readManifest(ended);
		const ttlMs = store.ttlHours * 3600_000;
		try {
			await store.updateManifest(ended, {
				ended_at: new Date(Date.now() - ttlMs - 60_000).toISOString(),
			});
			expect(await statusOf(path, readerCookie)).toBe(404);
		} finally {
			await store.updateManifest(ended, { ended_at: before.ended_at });
		}
		expect(await statusOf(path, readerCookie)).toBe(200);
	});

	test('MAINTENANCE closes the route to every non-root session (the dispatcher Gate 2b), and lifting it reopens it', async () => {
		const path = exportArtifactUrl(ended.jobId, BUILT);
		expect(await statusOf(path, readerCookie)).toBe(200);
		// S1-18: never flip maintenance in the LIVE ts_state.json (the preload
		// points the process at a scratch state file).
		expect(readEnv('DEDALO_TS_STATE_PATH')).toBeDefined();
		const previous = getServerState().maintenance_mode;
		try {
			setServerState({ maintenance_mode: true });
			// the owner, with every grant intact: refused like the API refuses them
			expect(await statusOf(path, readerCookie)).toBe(404);
			// root is still authenticated here — it is who lifts maintenance
			const rootCookie = `${SESSION_COOKIE}=${createSession(SUPERUSER_ID, 'root', true)}`;
			expect(await sessionPrincipalFromCookie(rootCookie)).not.toBeNull();
			expect(await sessionPrincipalFromCookie(readerCookie)).toBeNull();
		} finally {
			setServerState({ maintenance_mode: previous });
		}
		// Lifted: served again — so it was maintenance that closed it.
		expect(await statusOf(path, readerCookie)).toBe(200);
	});

	test('tool_export REVOKED from the reader AFTER the build closes the file (the dispatcher’s tool gate, asked by the route too)', async () => {
		const path = exportArtifactUrl(ended.jobId, BUILT);
		expect(await statusOf(path, readerCookie)).toBe(200);
		try {
			await setReaderToolGrant(false);
			// the section grant still holds: only the tool authorization changed
			expect(await statusOf(path, readerCookie)).toBe(404);
		} finally {
			await setReaderToolGrant(true);
		}
		// Restored grant: served again — so it was the tool grant that closed it.
		expect(await statusOf(path, readerCookie)).toBe(200);
	});

	test("the build's own gates are re-asked over the RECORDED options (sqo, column, section)", async () => {
		// The route re-runs the same gates the build ran (access.ts
		// exportStillReadable): an sqo section, a declared column, the export's
		// own section or a runtime frontier grant the reader cannot read closes the file; each leg's twin is the
		// 200 after the options are put back.
		const path = exportArtifactUrl(ended.jobId, BUILT);
		const before = await store.readManifest(ended);
		// The recorded options are IMMUTABLE to every production writer (they live
		// in request.json, written once) — the fixture door rewrites the whole
		// manifest to stage each leg.
		const setOptions = async (options: Record<string, unknown>) =>
			store.writeManifest(ended, { ...(await store.readManifest(ended)), options });
		const restore = async () => {
			await setOptions(before.options);
			await store.updateManifest(ended, { section_tipo: before.section_tipo });
		};
		try {
			// Gate A: an sqo section the reader holds no grant on.
			await setOptions({
				...before.options,
				sqo: { section_tipo: [ACL_GRANTED_SECTION, 'test1'] },
			});
			expect(await statusOf(path, readerCookie)).toBe(404);
			await restore();
			expect(await statusOf(path, readerCookie)).toBe(200);
			// Gate B: a declared column on a component the reader holds no grant on.
			const column = (component: string) => ({
				...before.options,
				ar_ddo_to_export: [
					{ path: [{ section_tipo: ACL_GRANTED_SECTION, component_tipo: component }] },
				],
			});
			await setOptions(column(ACL_DENIED_COMPONENT));
			expect(await statusOf(path, readerCookie)).toBe(404);
			await setOptions(column(ACL_GRANTED_COMPONENT));
			expect(await statusOf(path, readerCookie)).toBe(200);
			// The export's own section: fail closed when there is none to check.
			await store.updateManifest(ended, { section_tipo: '' });
			expect(await statusOf(path, readerCookie)).toBe(404);
			await restore();
			// The RUNTIME frontier grants the walk read under (manifest
			// frontier_grants — pairs no declared segment names): one the reader
			// no longer holds closes the file; one it holds serves it.
			const runtime = (component: string) => [
				{ section_tipo: ACL_GRANTED_SECTION, component_tipo: component },
			];
			await store.updateManifest(ended, { frontier_grants: runtime(ACL_DENIED_COMPONENT) });
			expect(await statusOf(path, readerCookie)).toBe(404);
			await store.updateManifest(ended, { frontier_grants: runtime(ACL_GRANTED_COMPONENT) });
			expect(await statusOf(path, readerCookie)).toBe(200);
		} finally {
			await restore();
			await store.updateManifest(ended, { frontier_grants: before.frontier_grants });
		}
		expect(await statusOf(path, readerCookie)).toBe(200);
	});
});

describe('helpers', () => {
	test('formatOfArtifactName maps every downloadable name and nothing else', () => {
		expect(formatOfArtifactName('export.csv')).toBe('csv');
		expect(formatOfArtifactName('export.tsv')).toBe('tsv');
		expect(formatOfArtifactName('export.html')).toBe('html');
		expect(formatOfArtifactName('export.xlsx')).toBe('xlsx');
		expect(formatOfArtifactName('export.ods')).toBe('ods');
		expect(formatOfArtifactName('export.ndjson')).toBe('ndjson');
		expect(formatOfArtifactName('media.zip')).toBe('media_zip');
		expect(formatOfArtifactName('media_web.zip')).toBe('media_zip');
		// the option-hashed names of the labelled formats (writers/index.ts artifactFileVariant)
		expect(formatOfArtifactName('export_0123456789ab.csv')).toBe('csv');
		expect(formatOfArtifactName('export_0123456789ab.xlsx')).toBe('xlsx');
		expect(
			parseExportArtifactPath(`${EXPORT_ARTIFACT_URL_PREFIX}exp_1/export_0123456789ab.csv`),
		).toEqual({
			jobId: 'exp_1',
			basename: 'export_0123456789ab.csv',
		});
		// and the browser saves them without the hash
		const saved = { section_tipo: 'test3', ended_at: '2026-09-24T10:00:00.000Z', created_at: '' };
		expect(downloadFileName(saved as never, 'export_0123456789ab.csv')).toBe(
			'dedalo_export_test3_2026-09-24.csv',
		);
		expect(downloadFileName(saved as never, 'export.ndjson')).toBe(
			'dedalo_export_test3_2026-09-24.ndjson',
		);
		expect(downloadFileName(saved as never, 'media_web.zip')).toBe(
			'dedalo_export_test3_2026-09-24_media_web.zip',
		);
		for (const bad of ['export.zip', 'grid.ndjson', 'manifest.json', 'media.csv', '']) {
			expect(formatOfArtifactName(bad), bad).toBeNull();
		}
	});

	test('attachmentDisposition: plain ASCII stays plain; anything else gets an ASCII fallback + RFC 5987', () => {
		expect(attachmentDisposition('dedalo_export_test3.csv')).toBe(
			'attachment; filename="dedalo_export_test3.csv"',
		);
		expect(attachmentDisposition('título día.csv')).toBe(
			`attachment; filename="t_tulo d_a.csv"; filename*=UTF-8''t%C3%ADtulo%20d%C3%ADa.csv`,
		);
		const hostile = attachmentDisposition('a"b\\c\r\nSet-Cookie: x=1;.csv');
		expect(hostile).not.toMatch(/[\r\n]/);
		expect(
			hostile.startsWith('attachment; filename="a_b_c__Set-Cookie: x=1_.csv"; filename*='),
		).toBe(true);
	});
});
