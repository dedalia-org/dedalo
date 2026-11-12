/**
 * R0 gate: dd_utils_api::get_system_info (the upload/import/media-edit init call).
 * Two levels:
 *  1. buildSystemInfo() emits the client-critical shape (max_size_bytes numeric,
 *     upload_service_chunk_files number|false) — the fields service_upload.js reads.
 *  2. Over the real HTTP layer, the action requires a session + CSRF (it is NOT in
 *     NO_LOGIN_ACTIONS / CSRF_EXEMPT_ACTIONS) and returns data = the payload.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemInfo } from '../../src/core/api/handlers/system_info.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { handleRequest } from '../../src/server.ts';

const context = { requestId: 'system-info-test', startedAt: 0 };

function apiRequest(body: unknown, cookie?: string, csrfToken?: string): Request {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (cookie) headers.Cookie = cookie;
	if (csrfToken !== undefined) headers['X-Dedalo-Csrf-Token'] = csrfToken;
	return new Request('http://localhost/dedalo/core/api/v1/json/', {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
}

const RQO = { action: 'get_system_info', dd_api: 'dd_utils_api', prevent_lock: true, source: {} };

describe('dd_utils_api.get_system_info (R0)', () => {
	test('buildSystemInfo emits the client-critical shape', async () => {
		const info = await buildSystemInfo();
		// The two fields service_upload.js gates transfer on.
		expect(typeof info.max_size_bytes).toBe('number');
		expect(info.max_size_bytes).toBeGreaterThan(0);
		expect(
			typeof info.upload_service_chunk_files === 'number' ||
				info.upload_service_chunk_files === false,
		).toBe(true);
		// The rest of the seven fields the client copies onto itself.
		expect(typeof info.sys_get_temp_dir).toBe('string');
		expect(typeof info.upload_tmp_dir).toBe('string');
		expect(typeof info.upload_tmp_perms).toBe('number');
		expect(typeof info.session_cache_expire).toBe('number');
		expect(typeof info.pdf_ocr_engine).toBe('boolean');
		expect(Array.isArray(info.pdf_ocr_langs)).toBe(true);
	});

	test('authenticated call returns the payload as data', async () => {
		const token = createSession(-1, 'root', true);
		const cookie = `dedalo_ts_session=${token}`;
		const csrf = getSession(token)?.csrfToken as string;
		const res = await handleRequest(apiRequest(RQO, cookie, csrf), context);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; data: { max_size_bytes?: number } };
		expect(body.ok).toBe(true);
		expect(body.data).toBeDefined();
		expect(typeof body.data.max_size_bytes).toBe('number');
	});

	test('unauthenticated call is refused (not in NO_LOGIN_ACTIONS)', async () => {
		const res = await handleRequest(apiRequest(RQO), context);
		// No session → the auth gate rejects before the handler runs.
		expect(res.status).not.toBe(200);
	});
});

// ── OCR facts (T0-11 D3): measured binaries, installed models ∩ application langs ──

const scratch = mkdtempSync(join(tmpdir(), 'dd-system-info-ocr-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A scratch executable printing `stdout` (a stand-in for ocrmypdf / tesseract). */
function scratchBinary(name: string, stdout: string, mode = 0o755): string {
	const path = join(scratch, name);
	writeFileSync(path, `#!/bin/sh\nprintf '%s' '${stdout}'\n`);
	chmodSync(path, mode);
	return path;
}

const LIST_LANGS =
	'List of available languages in "/scratch/tessdata/" (4):\neng\nosd\nspa\nchi_sim\n';

describe('get_system_info OCR facts (T0-11 D3)', () => {
	const ocrmypdf = scratchBinary('ocrmypdf', '');
	const tesseract = scratchBinary('tesseract', LIST_LANGS);
	const applicationLangs = ['lg-spa', 'lg-cat', 'lg-eng', 'lg-zho', 'lg-vlca', 'lg-xyz'];

	test('pdf_ocr_langs = application langs whose Tesseract model is installed, in application order', async () => {
		const info = await buildSystemInfo({
			ocrmypdfPath: ocrmypdf,
			tesseractPath: tesseract,
			applicationLangs,
		});
		expect(info.pdf_ocr_engine).toBe(true);
		// cat (lg-cat, lg-vlca) not installed; lg-xyz has no model; lg-zho reads chi_sim.
		expect(info.pdf_ocr_langs).toEqual(['lg-spa', 'lg-eng', 'lg-zho']);
	});

	test('pdf_ocr_engine is false when the ocrmypdf path does not exist (a configured path is not an engine)', async () => {
		const info = await buildSystemInfo({
			ocrmypdfPath: join(scratch, 'absent', 'ocrmypdf'),
			tesseractPath: tesseract,
			applicationLangs,
		});
		expect(info.pdf_ocr_engine).toBe(false);
		expect(info.pdf_ocr_langs).toEqual([]);
	});

	test('pdf_ocr_engine is false when the ocrmypdf file is not executable', async () => {
		const plain = scratchBinary('ocrmypdf_plain', '', 0o644);
		const info = await buildSystemInfo({
			ocrmypdfPath: plain,
			tesseractPath: tesseract,
			applicationLangs,
		});
		expect(info.pdf_ocr_engine).toBe(false);
	});

	test('no tesseract binary → no OCR language offered', async () => {
		const info = await buildSystemInfo({
			ocrmypdfPath: ocrmypdf,
			tesseractPath: join(scratch, 'absent', 'tesseract'),
			applicationLangs,
		});
		expect(info.pdf_ocr_engine).toBe(true);
		expect(info.pdf_ocr_langs).toEqual([]);
	});
});
