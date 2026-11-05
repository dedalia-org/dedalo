/**
 * THE LOGIN PANEL'S AVATAR (component_image dd522).
 *
 * The login panel shows one picture while the asset cache warms: the
 * `--user_login_image` background of the files-loader circle (login.less), fed
 * by `login.action_dispatch` from the login ANSWER. The TS engine never sent the
 * key, so every account showed the bundled grey icon — and the client read the
 * PHP-era `result_options.user_image` spelling that no TS envelope carries, so
 * even a correct server value would have been ignored.
 *
 * TWO HALVES, as the wire law requires:
 *  1. the RESOLVER (`security/user_identity.ts resolveUserImageUrl`) against
 *     real files on disk: default quality first, thumb as the fallback, null
 *     when the account has no image (the panel then keeps its icon);
 *  2. the WIRE: a real login on the suite database carries `user_image` as a
 *     top-level extension key — the shape the client reads.
 *
 * Nothing here writes a user record: the resolver reads the media TREE, naming
 * the file by the engine's own path grammar (media/path.ts), which is what the
 * production login does too.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { requireTestMediaRoot } from '../../src/core/media/test_media_root.ts';
import { resolveUserImageUrl } from '../../src/core/security/user_identity.ts';
import { mustGet } from '../helpers/assert.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const IMAGE_TIPO = 'dd522';
const USERS_SECTION = 'dd128';
/** A throwaway id: the resolver names the file by the grammar, no record needed. */
const USER_ID = 987654321;
const SPEC = mustGet(mediaTypeOf('component_image'), 'component_image media spec');

const planted: string[] = [];

/** Write a (byte-wise meaningless) avatar file: the resolver only stats it. */
async function plantAvatar(quality: string, extension: string): Promise<string> {
	requireTestMediaRoot(config.media.rootPath ?? '', 'login_user_image gate');
	const location = buildMediaLocation(
		SPEC,
		{ componentTipo: IMAGE_TIPO, sectionTipo: USERS_SECTION, sectionId: USER_ID, lang: null },
		quality,
		extension,
		await resolveMediaPathOptions(IMAGE_TIPO, USERS_SECTION),
	);
	mkdirSync(dirname(location.absolutePath), { recursive: true });
	writeFileSync(location.absolutePath, 'login avatar fixture\n');
	planted.push(location.absolutePath);
	return location.relativePath;
}

afterAll(() => {
	for (const path of planted) {
		unlinkSync(path);
		// only removes the BUCKET dir this gate created (a shared quality dir is
		// never empty and rmdir refuses it)
		try {
			rmdirSync(dirname(path));
		} catch {
			// not empty / already gone
		}
	}
});

describe.if(DB_READY)('the login avatar (dd522)', () => {
	test('resolves to the default quality, falls back to the thumb, and is null with no file', async () => {
		expect(await resolveUserImageUrl(USER_ID)).toBeNull();
		// root (-1): the media grammar names files by a POSITIVE section id, so
		// root has none. It must answer null, not throw — a login cannot fail
		// over a decorative image.
		expect(await resolveUserImageUrl(-1)).toBeNull();

		const thumbPath = await plantAvatar(config.media.thumb.quality, config.media.thumb.extension);
		const thumbUrl = await resolveUserImageUrl(USER_ID);
		expect(thumbUrl).toStartWith(`${config.media.webBase}${thumbPath}`);
		// versioned by the FILE (url_version.ts), so a re-upload is not served stale
		expect(thumbUrl).toMatch(/\?v=\d+-\d+$/);

		// the delivered tier wins over the thumbnail when both exist
		const mainPath = await plantAvatar(SPEC.defaultQuality, SPEC.defaultExtension);
		expect(await resolveUserImageUrl(USER_ID)).toStartWith(`${config.media.webBase}${mainPath}`);
	});

	test('a real login answer carries user_image as a top-level key (the shape the panel reads)', async () => {
		const { ensureSuiteLoginPassword, SUITE_LOGIN_PASSWORD } = await import(
			'../../src/core/test_data/suite_login.ts'
		);
		const { handleRequest } = await import('../../src/server.ts');
		await ensureSuiteLoginPassword('root', SUITE_LOGIN_PASSWORD);
		const response = await handleRequest(
			new Request('http://localhost/api/v1/json', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					dd_api: 'dd_utils_api',
					action: 'login',
					options: { username: 'root', auth: SUITE_LOGIN_PASSWORD },
				}),
			}),
			{ requestId: 'login_user_image', startedAt: 0 },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		// null is a real answer (the client keeps its bundled icon); a string is
		// the account's image. Anything else — an absent key, a nested
		// `result_options` — is the defect this pins. root (-1) is the account
		// whose image the media grammar cannot name, so this is also the case
		// that proves a missing avatar never fails a login.
		expect('user_image' in body).toBe(true);
		expect(body.user_image === null || typeof body.user_image === 'string').toBe(true);
	});
});
