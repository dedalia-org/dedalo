/**
 * DEDALO_MEDIA_EXPORT_BASE — the base of media URLs that LEAVE the application
 * (config.media.exportBase): export/relation-list cells and the URL handed to an
 * external transcriber.
 *
 * Renamed 2026-07-25 from DEDALO_MEDIA_BASE_URL (retired in env.ts's
 * RETIRED_ENV_KEYS, so the old spelling refuses the boot). The pair now names its
 * AUDIENCE — WEB_BASE = the client, EXPORT_BASE = what travels — because the two
 * carry the SAME kind of value (origin + `/dedalo/<mediaDir>`) and were told
 * apart by nothing but their spelling.
 *
 * Two invariants, both of which had already been violated in live code while the
 * name was ambiguous:
 *   - the value is prefixed to the media-root relative file_path UNCHANGED, so a
 *     trailing slash must be stripped (it emitted `…/media//image/…`), and no
 *     consumer may re-append `/dedalo/<mediaDir>` (tool_transcription did, so the
 *     one value that worked there broke the export cells and vice versa);
 *   - unset stays undefined — a travelling cell is reported unresolved, never
 *     guessed. That is the difference from webBase, which has a relative default.
 *
 * `config` freezes at first import, so every env case boots a subprocess.
 *
 * THE SUITE POSTURE half also holds the suite's LANGUAGES (install campaign 3,
 * C3-40, 2026-10-13): SUITE_LANGS equals hosted_env.sh's defaults, a config
 * booted over a developer .env that declares TWO languages still declares the
 * suite's whole set once the pins are applied (and only the two without them —
 * the anti-vacuity leg), and this very run carries the set. Mutation: drop the
 * preload's pin loop (the in-run leg reds on a 2-language .env) or empty
 * suiteLangPins (the child leg reds).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUITE_LANGS, SUITE_MEDIA_EXPORT_BASE } from '../helpers/suite_posture.ts';

const ROOT = `${import.meta.dir}/../..`;
const READ_EXPORT_BASE =
	'const { config } = await import("./src/config/config.ts");' +
	'console.log(JSON.stringify(config.media.exportBase ?? null));';

/** Boot config in a child with the export base overlaid, and read it back. */
function exportBaseWith(value: string): string | null {
	const probe = Bun.spawnSync(['bun', '-e', READ_EXPORT_BASE], {
		cwd: ROOT,
		env: { ...process.env, DEDALO_MEDIA_EXPORT_BASE: value },
	});
	return JSON.parse((probe.stdout.toString().trim().split('\n').pop() ?? 'null').trim());
}

describe('media export base (DEDALO_MEDIA_EXPORT_BASE)', () => {
	test('a trailing slash is stripped, exactly like webBase', () => {
		expect(exportBaseWith('http://localhost:8080/dedalo/media/')).toBe(
			'http://localhost:8080/dedalo/media',
		);
		// Several, too — the base is concatenated with a '/'-rooted path.
		expect(exportBaseWith('http://localhost:8080/dedalo/media///')).toBe(
			'http://localhost:8080/dedalo/media',
		);
	});

	test('a clean absolute value passes through untouched', () => {
		expect(exportBaseWith('https://my_institution.org/dedalo/media')).toBe(
			'https://my_institution.org/dedalo/media',
		);
	});

	test('unset is undefined — unresolved, never a guessed origin', () => {
		expect(exportBaseWith('')).toBe(null);
	});
});

describe('the suite posture (test/helpers/suite_posture.ts)', () => {
	test('the local suite and the hosted CI tier default to the SAME export base', () => {
		const hosted = readFileSync(`${ROOT}/scripts/ci/hosted_env.sh`, 'utf8');
		const match = /^: "\$\{DEDALO_MEDIA_EXPORT_BASE:=([^}]*)\}"$/m.exec(hosted);
		expect(match?.[1], 'hosted_env.sh no longer defaults DEDALO_MEDIA_EXPORT_BASE').toBeDefined();
		expect(match?.[1]).toBe(SUITE_MEDIA_EXPORT_BASE);
	});

	test('this run actually carries it (the preload pinned it, or the shell chose one)', async () => {
		const { config } = await import('../../src/config/config.ts');
		expect(config.media.exportBase).toBeDefined();
		if (process.env.DEDALO_MEDIA_EXPORT_BASE === SUITE_MEDIA_EXPORT_BASE) {
			expect(config.media.exportBase).toBe(SUITE_MEDIA_EXPORT_BASE);
		}
	});
});

// ---------------------------------------------------------------------------
// The suite's languages (C3-40)
// ---------------------------------------------------------------------------

/** hosted_env.sh's default for one language key (the object map has its own form). */
function hostedDefault(hosted: string, key: string): string | undefined {
	const quoted = new RegExp(`^\\t${key}='([^']*)'$`, 'm').exec(hosted)?.[1];
	if (quoted !== undefined) return quoted;
	const plain = new RegExp(`^: "\\$\\{${key}:=(.*)\\}"$`, 'm').exec(hosted)?.[1];
	return plain?.replaceAll('\\"', '"');
}

/** Every spelling of the suite language keys a shell may carry (key + catalog alias). */
const LANG_SPELLINGS = [...Object.keys(SUITE_LANGS), 'DEDALO_PROJECTS_DEFAULT_LANGS'];

/**
 * Boot config in a child over a private dir whose .env declares only
 * lg-spa + lg-eng (a fresh developer install), with or without the suite pins,
 * and read the declared data-language set back.
 */
function declaredLangsOverTwoLangEnv(pinned: boolean): string[] {
	const dir = mkdtempSync(join(tmpdir(), 'dd-suite-langs-'));
	try {
		writeFileSync(
			join(dir, '.env'),
			[
				'ENTITY=zzlangs',
				'DB_NAME=zz_langs_none',
				'DB_HOST=127.0.0.1',
				'DB_USER=zz',
				'DEDALO_APPLICATION_LANGS={"lg-spa":"Castellano","lg-eng":"English"}',
				'DEDALO_APPLICATION_LANGS_DEFAULT=lg-spa',
				'DEDALO_DATA_LANG_DEFAULT=lg-spa',
				'DEDALO_PROJECTS_DEFAULT_LANGS=["lg-spa","lg-eng"]',
				'',
			].join('\n'),
		);
		const env: Record<string, string | undefined> = { ...process.env, DEDALO_PRIVATE_DIR: dir };
		for (const key of LANG_SPELLINGS) delete env[key];
		const pin = pinned
			? 'const { processEnvValue } = await import("./src/config/env.ts");' +
				'const { suiteLangPins } = await import("./test/helpers/suite_posture.ts");' +
				'for (const [k, v] of suiteLangPins((n) => processEnvValue(n) !== undefined)) process.env[k] = v;'
			: '';
		const probe = Bun.spawnSync(
			[
				'bun',
				'-e',
				`${pin}const c = await import("./src/config/config.ts");` +
					'console.log(JSON.stringify([...c.INSTALLED_DATA_LANGS].sort()));',
			],
			{ cwd: ROOT, env },
		);
		return JSON.parse(probe.stdout.toString().trim().split('\n').pop() ?? '[]');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const SUITE_PROJECT_LANGS: string[] = JSON.parse(SUITE_LANGS.PROJECTS_DEFAULT_LANGS ?? '[]');

describe('the suite posture — languages (C3-40)', () => {
	test('the local suite and the hosted CI tier default to the SAME languages', () => {
		const hosted = readFileSync(`${ROOT}/scripts/ci/hosted_env.sh`, 'utf8');
		for (const [key, value] of Object.entries(SUITE_LANGS)) {
			expect(hostedDefault(hosted, key), `hosted_env.sh default of ${key}`).toBe(value);
		}
	});

	test("a developer .env declaring two languages does not narrow the suite's set", () => {
		expect(SUITE_PROJECT_LANGS.length).toBeGreaterThan(2);
		// anti-vacuity: without the pins the child declares exactly what its .env says
		expect(declaredLangsOverTwoLangEnv(false).filter((lang) => lang !== 'lg-nolan')).toEqual([
			'lg-eng',
			'lg-spa',
		]);
		const pinned = declaredLangsOverTwoLangEnv(true);
		for (const lang of SUITE_PROJECT_LANGS) expect(pinned).toContain(lang);
	});

	test('this run actually carries them (the preload pinned them, or the shell chose)', async () => {
		const { INSTALLED_DATA_LANGS } = await import('../../src/config/config.ts');
		if (process.env.PROJECTS_DEFAULT_LANGS === SUITE_LANGS.PROJECTS_DEFAULT_LANGS) {
			for (const lang of SUITE_PROJECT_LANGS) expect(INSTALLED_DATA_LANGS.has(lang)).toBe(true);
		}
		expect(
			process.env.PROJECTS_DEFAULT_LANGS ?? process.env.DEDALO_PROJECTS_DEFAULT_LANGS,
		).toBeDefined();
	});

	test('the PUBLICATION languages are pinned too: a developer DEDALO_DIFFUSION_LANGS never reaches a pinned diffusion document (T1-4 review)', async () => {
		// The plan's main lang is langs[0] and its lang set orders every
		// literal: diffusion_rdf_graph_native pins a document over them.
		const pinned = SUITE_LANGS.DEDALO_DIFFUSION_LANGS;
		expect(pinned, 'SUITE_LANGS must pin DEDALO_DIFFUSION_LANGS').toBeDefined();
		const { config } = await import('../../src/config/config.ts');
		if (process.env.DEDALO_DIFFUSION_LANGS === pinned) {
			expect([...config.diffusion.langs]).toEqual(JSON.parse(pinned ?? '[]'));
		}
		// …and the pin equals what the unset key derives (CI's old value).
		expect(JSON.parse(pinned ?? '[]')).toEqual(SUITE_PROJECT_LANGS);
	});
});
