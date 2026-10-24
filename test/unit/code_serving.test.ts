/**
 * Code-master release serving (src/core/update/code_serving.ts) — the route
 * that answers the URL `buildCodeUpdateInfo` advertises.
 *
 * Asserts the fail-closed posture: nothing is servable unless IS_A_CODE_SERVER
 * is set AND the files dir is configured; only that release's own archive (or
 * its .sha256 sidecar) resolves; traversal and neighbour-release names are
 * refused; every refusal is the SAME opaque 404.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	CODE_RELEASE_URL_PREFIX,
	resolveCodeReleaseFile,
	serveCodeReleaseRequest,
} from '../../src/core/update/code_serving.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('code_serving');
const FILES_DIR = join(ROOT, 'files');
const ARCHIVE = join(FILES_DIR, '7', '7.0', '7.0.1.zip');
const DEV_ARCHIVE = join(FILES_DIR, '7', '7.0', '7.0.1-dev.zip');
const OPEN = { isCodeServer: true, codeFilesDir: FILES_DIR };

// The 404 body is a converter-made envelope; under DEDALO_DEBUG_API_ERRORS=true
// (a dev .env convenience) it carries a `debug.stack` that differs per call site,
// so the indistinguishability assertion pins the flag OFF (process.env wins
// over ../private/.env — see error_converter_native.test.ts).
const previousDebugFlag = process.env.DEDALO_DEBUG_API_ERRORS;
beforeAll(() => {
	process.env.DEDALO_DEBUG_API_ERRORS = 'false';
	mkdirSync(join(FILES_DIR, '7', '7.0'), { recursive: true });
	writeFileSync(ARCHIVE, 'PK-not-a-real-zip');
	writeFileSync(`${ARCHIVE}.sha256`, `${'c'.repeat(64)}  7.0.1.zip\n`);
	writeFileSync(DEV_ARCHIVE, 'PK-dev-zip');
	writeFileSync(`${DEV_ARCHIVE}.sha256`, `${'d'.repeat(64)}  7.0.1-dev.zip\n`);
});
afterAll(() => {
	if (previousDebugFlag === undefined) delete process.env.DEDALO_DEBUG_API_ERRORS;
	else process.env.DEDALO_DEBUG_API_ERRORS = previousDebugFlag;
	rmSync(ROOT, { recursive: true, force: true });
});

describe('resolveCodeReleaseFile', () => {
	test('the advertised URL resolves to the archive, the sidecar to the digest file', () => {
		// This URL shape is the manifest's own: `${publicBaseUrl}/${v}/${v}.zip`.
		expect(resolveCodeReleaseFile('/dedalo/install/code/7.0.1/7.0.1.zip', OPEN)).toEqual({
			path: ARCHIVE,
			contentType: 'application/zip',
		});
		expect(resolveCodeReleaseFile('/dedalo/install/code/7.0.1/7.0.1.zip.sha256', OPEN)).toEqual({
			path: `${ARCHIVE}.sha256`,
			contentType: 'text/plain; charset=utf-8',
		});
	});

	test('fail-closed: not a code server, or no files dir → null', () => {
		const url = '/dedalo/install/code/7.0.1/7.0.1.zip';
		expect(
			resolveCodeReleaseFile(url, { isCodeServer: false, codeFilesDir: FILES_DIR }),
		).toBeNull();
		expect(resolveCodeReleaseFile(url, { isCodeServer: true, codeFilesDir: undefined })).toBeNull();
	});

	test('the -dev channel is SERVABLE (never advertised — see code_manifest.test.ts)', () => {
		// A developer build (`code_build_plan.ts` releaseFileName, non-master ref)
		// must be fetchable by an operator who knows its URL; until 2026-08-23 the
		// build produced a zip NO HTTP path would serve while the client presented
		// it as a deliverable. The manifest half of the property — a -dev zip is
		// never OFFERED as a release — is gated in code_manifest.test.ts.
		expect(resolveCodeReleaseFile('/dedalo/install/code/7.0.1/7.0.1-dev.zip', OPEN)).toEqual({
			path: DEV_ARCHIVE,
			contentType: 'application/zip',
		});
		expect(resolveCodeReleaseFile('/dedalo/install/code/7.0.1/7.0.1-dev.zip.sha256', OPEN)).toEqual(
			{
				path: `${DEV_ARCHIVE}.sha256`,
				contentType: 'text/plain; charset=utf-8',
			},
		);
	});

	test('only THIS release’s own names resolve', () => {
		for (const url of [
			'/dedalo/install/code/7.0.1/7.0.2.zip', // a neighbour release under our dir
			'/dedalo/install/code/7.0.1/7.0.2-dev.zip', // a neighbour dev build
			'/dedalo/install/code/7.0.1/7.0.2-beta.1.zip', // a neighbour triple's prerelease
			'/dedalo/install/code/7.0.1/7.0.1-pre.1.zip', // not the shared prerelease grammar
			'/dedalo/install/code/7.0.1/7.0.1-beta.1.zip.partial', // a build's staging file
			'/dedalo/install/code/7.0.1/7.0.1-dev.tar', // dev channel, wrong grammar
			'/dedalo/install/code/7.0.1/7.0.1-devx.zip', // not the fixed -dev token
			'/dedalo/install/code/7.0.1/7.0.1.tar', // not the zip grammar
			'/dedalo/install/code/7.0.1/', // no file
			'/dedalo/install/code/7.0/7.0.zip', // not a triple
			'/dedalo/install/code/7.0.1/sub/7.0.1.zip', // nested
			'/dedalo/install/code/7.0.1/..%2F..%2Fetc%2Fpasswd',
			'/dedalo/install/code/7.0.1/../../../etc/passwd',
			'/dedalo/install/code/x.y.z/x.y.z.zip',
		]) {
			expect(resolveCodeReleaseFile(url, OPEN)).toBeNull();
		}
	});
});

describe('serveCodeReleaseRequest', () => {
	test('serves the archive with no-store + the security headers', async () => {
		const res = await serveCodeReleaseRequest('/dedalo/install/code/7.0.1/7.0.1.zip', OPEN);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/zip');
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		expect(await res.text()).toBe('PK-not-a-real-zip');
		// the -dev channel serves over HTTP too (manual-testing deliverable)
		const dev = await serveCodeReleaseRequest('/dedalo/install/code/7.0.1/7.0.1-dev.zip', OPEN);
		expect(dev.status).toBe(200);
		expect(await dev.text()).toBe('PK-dev-zip');
	});

	test('a release that was never built 404s like everything else', async () => {
		const missing = await serveCodeReleaseRequest(
			'/dedalo/install/code/7.0.9/7.0.9.zip',
			OPEN,
			'req-probe',
		);
		const refused = await serveCodeReleaseRequest(
			'/dedalo/install/code/7.0.1/7.0.1.zip',
			{ isCodeServer: false, codeFilesDir: FILES_DIR },
			'req-probe',
		);
		expect(missing.status).toBe(404);
		expect(refused.status).toBe(404);
		// indistinguishable from outside: a probe cannot map the release dir —
		// the same converter-made `resource.not_found` envelope v2 for both
		const missingBody = (await missing.json()) as { ok: boolean; error: { code: string } };
		expect(missingBody.ok).toBe(false);
		expect(missingBody.error.code).toBe('resource.not_found');
		expect(await refused.text()).toBe(JSON.stringify(missingBody));
	});

	test('the exported prefix is the one the manifest URL starts with', () => {
		expect('/dedalo/install/code/7.0.1/7.0.1.zip'.startsWith(CODE_RELEASE_URL_PREFIX)).toBe(true);
	});
});
