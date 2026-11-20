/**
 * EVERY ROUTE OUTSIDE THE RQO DISPATCHER APPLIES THE DISPATCHER'S SESSION GATE (S09-a).
 *
 * `dispatchRqo` refuses a non-root session while `maintenance_mode` is on (Gate
 * 2b, `auth.maintenance`): root is who lifts it. The raw HTTP routes never pass
 * the dispatcher, and until 2026-11-19 most of them asked the session store
 * directly (`getSession`), each behind its own hand-copied cookie parser — so
 * under maintenance a logged-in editor was refused by the API and still served
 * media, staged uploads, model weights, tag redirects, the environment dump,
 * and (a global admin) the raw record view, the counters and the hierarchy
 * dumps; an upload was still accepted.
 *
 * THE OUTCOME PINNED, per route, through the real entry point (`handleRequest`):
 *   - FLOOR: with maintenance OFF a non-root session gets an answer that DIFFERS
 *     from the anonymous one (else nothing below can fail);
 *   - maintenance ON: the SAME non-root request is answered exactly like the
 *     anonymous one;
 *   - maintenance ON: root is still answered as before — it is who lifts it;
 *   - maintenance lifted: the non-root answer is back.
 *
 * The non-root identity is the ACL identity fixture's global admin (the routes
 * that also ask admin-ness need it; the others only ask "is there a session").
 * Maintenance is flipped in the scratch `ts_state.json` the preload points at,
 * never the live one (S1-18). Files are created under the SUITE media root and
 * a scratch model store, and removed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vendoredHierarchyTlds } from '../../scripts/lib/hierarchy_allowlist.ts';
import { config } from '../../src/config/config.ts';
import { readEnv } from '../../src/config/env.ts';
import { AI_MODEL_URL_PREFIX } from '../../src/core/ai/model_store.ts';
import { HIERARCHY_EXPORT_URL_PREFIX } from '../../src/core/area_maintenance/widgets/export_hierarchy.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { STAGED_URL_PREFIX } from '../../src/core/media/ingest/staged_files.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import { SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import { createSession, SESSION_COOKIE } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { createRequestContext, handleRequest } from '../../src/server.ts';
import {
	ACL_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const mediaRoot = config.media.rootPath as string;
const MEDIA_REL = 'image/thumb/0/zz_session_gate_1.jpg';
const STAGED_KEY = 'zz_session_gate';
const STAGED_NAME = 'staged.txt';
const MODEL = 'fixture-org/zz-session-gate-model';

let adminCookie = '';
let rootCookie = '';
let modelScratch = '';
let priorModelStore: string | undefined;
let priorMediaRoute: string | undefined;
let priorMediaMode: ReturnType<typeof getServerState>['media_access_mode'];
const created: string[] = [];

/** What a caller can tell one answer from another by. */
interface Answer {
	status: number;
	location: string | null;
	code: string | null;
}

async function answerOf(response: Response): Promise<Answer> {
	const text = await response.text();
	let code: string | null = null;
	try {
		const body = JSON.parse(text) as { error?: { code?: unknown } };
		if (typeof body.error?.code === 'string') code = body.error.code;
	} catch {
		// not JSON (a served file): the status is the answer
	}
	return { status: response.status, location: response.headers.get('location'), code };
}

function get(path: string, cookie: string | null, devListener = false): Promise<Answer> {
	const headers: Record<string, string> = cookie === null ? {} : { cookie };
	return handleRequest(
		new Request(`http://localhost${path}`, { headers }),
		createRequestContext({ devListener }),
	).then(answerOf);
}

/** userId → the cookie's owner, for the one route whose URL is per-user. */
type Route = (cookie: string | null) => Promise<Answer>;

const ROUTES: Record<string, Route> = {
	'media fallback (dev listener)': (cookie) =>
		get(`/dedalo/${config.mediaDir}/${MEDIA_REL}`, cookie, true),
	'AI model weights': (cookie) => get(`${AI_MODEL_URL_PREFIX}${MODEL}/config.json`, cookie),
	'staged upload file': (cookie) => get(`${STAGED_URL_PREFIX}${STAGED_KEY}/${STAGED_NAME}`, cookie),
	'media upload (multipart POST)': (cookie) => {
		const form = new FormData();
		form.append('file', new Blob(['x']), 'x.txt');
		const headers: Record<string, string> = cookie === null ? {} : { cookie };
		return handleRequest(
			new Request('http://localhost/api/v1/json', { method: 'POST', headers, body: form }),
			createRequestContext({}),
		).then(answerOf);
	},
	'text_area tag locator': (cookie) =>
		get(
			`/dedalo/core/component_text_area/tag/?id=${encodeURIComponent(
				JSON.stringify({ section_tipo: 'test3', section_id: '935001', component_tipo: 'test177' }),
			)}`,
			cookie,
		),
	// A sensitive section: an authenticated admin is DENIED (not 404) before any read.
	'raw record view': (cookie) =>
		get(`/api/v1/raw?section_tipo=${config.usersSectionTipo}&section_id=1`, cookie),
	'environment view': (cookie) => get('/api/v1/environment', cookie),
	counters: (cookie) => get('/api/v1/counters', cookie),
	'hierarchy dump download': (cookie) =>
		get(`${HIERARCHY_EXPORT_URL_PREFIX}${vendoredHierarchyTlds()[0]}1.copy.gz`, cookie),
};

function plant(path: string, bytes: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
	created.push(path);
}

beforeAll(async () => {
	await assertTestDatabase('non_dispatch_session_gate_native');
	// S1-18: maintenance is flipped in a scratch state file only.
	expect(readEnv('DEDALO_TS_STATE_PATH')).toBeDefined();
	expect(mediaRoot).not.toBeNull();
	await installAclIdentityFixture();
	adminCookie = `${SESSION_COOKIE}=${createSession(ACL_ADMIN_USER_ID, 'zzacl_admin', true)}`;
	rootCookie = `${SESSION_COOKIE}=${createSession(SUPERUSER_ID, 'root', true)}`;

	plant(join(mediaRoot, MEDIA_REL), 'fake-media-bytes');
	for (const userId of [ACL_ADMIN_USER_ID, SUPERUSER_ID]) {
		plant(join(stagingDir(userId, STAGED_KEY), STAGED_NAME), 'staged-bytes');
	}
	modelScratch = mkdtempSync(join(tmpdir(), 'dd_session_gate_'));
	priorModelStore = process.env.DEDALO_AI_MODEL_STORE;
	process.env.DEDALO_AI_MODEL_STORE = modelScratch;
	plant(join(modelScratch, MODEL, 'config.json'), '{"model_type":"mine"}');

	// The media fallback's own premises (media_fallback_listener.test.ts): protection
	// explicitly off, the flag unset — so the SESSION is the only variable.
	priorMediaMode = getServerState().media_access_mode;
	priorMediaRoute = process.env.MEDIA_DEV_ROUTE_ENABLED;
	setServerState({ media_access_mode: false });
	process.env.MEDIA_DEV_ROUTE_ENABLED = '';
}, 60_000);

afterAll(async () => {
	setServerState({ maintenance_mode: false, media_access_mode: priorMediaMode ?? null });
	if (priorMediaRoute === undefined) delete process.env.MEDIA_DEV_ROUTE_ENABLED;
	else process.env.MEDIA_DEV_ROUTE_ENABLED = priorMediaRoute;
	if (priorModelStore === undefined) delete process.env.DEDALO_AI_MODEL_STORE;
	else process.env.DEDALO_AI_MODEL_STORE = priorModelStore;
	for (const path of created) rmSync(path, { force: true });
	for (const userId of [ACL_ADMIN_USER_ID, SUPERUSER_ID]) {
		rmSync(stagingDir(userId, STAGED_KEY), { recursive: true, force: true });
	}
	if (modelScratch !== '') rmSync(modelScratch, { recursive: true, force: true });
	await removeAclIdentityFixture();
});

describe('maintenance closes every non-dispatch route to a non-root session, exactly as it closes the API', () => {
	test('FLOOR: the route table is the nine non-dispatch session routes', () => {
		expect(Object.keys(ROUTES)).toHaveLength(9);
		expect(vendoredHierarchyTlds().length).toBeGreaterThan(0);
	});

	for (const [name, call] of Object.entries(ROUTES)) {
		test(`${name}: a non-root session is answered like an anonymous caller while maintenance is on; root is not`, async () => {
			expect(getServerState().maintenance_mode === true).toBe(false);
			const anonymous = await call(null);
			const open = await call(adminCookie);
			const rootOpen = await call(rootCookie);
			// FLOOR: the session is what opens the route (else the rest is vacuous).
			expect(open).not.toEqual(anonymous);
			expect(rootOpen).not.toEqual(anonymous);
			try {
				setServerState({ maintenance_mode: true });
				expect(await call(adminCookie)).toEqual(anonymous);
				// Root is still authenticated: it is who lifts maintenance.
				expect(await call(rootCookie)).toEqual(rootOpen);
			} finally {
				setServerState({ maintenance_mode: false });
			}
			// Lifted: served again — so it was maintenance that closed it.
			expect(await call(adminCookie)).toEqual(open);
		}, 60_000);
	}
});
