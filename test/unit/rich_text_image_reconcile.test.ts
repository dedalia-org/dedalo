/**
 * TODO-069 gate: the two rich-text image reconciles
 * (src/core/media/rich_text_image_reconcile.ts).
 *
 *  - PURE: every `src` form measured on real installs on 2026-10-26 (relative
 *    `../../../media/`, `?<cachebust>`, `/dedalo/<mediaDir>/`, a v6 custom
 *    root, spaces/`%20`), the non-images (another host, the v4 `btn.php` tag
 *    buttons), and "keyed to THIS record" vs a bare grammar match.
 *  - NATIVE (suite DB + suite media root): scratch test3 records planted raw
 *    and deleted by id; `rich_text_images` dry → apply → re-run 0, the
 *    original kept, the html otherwise unchanged, a TM row per saved lang, a
 *    missing file reported and untouched; `web_image_exposure` flags a
 *    published name its record does not embed, holds a fresh one, and its
 *    apply renames it out of the grammar and repoints the text that uses it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { webImageRelDir } from '../../src/core/media/ingest/upload.ts';
import {
	isKeyedTo,
	keyOfWebImage,
	parseLegacyWebImageSrc,
	rewriteImgSrcs,
	runRichTextImages,
	runWebImageExposure,
	storedWebImageSrc,
} from '../../src/core/media/rich_text_image_reconcile.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const REL = 'image/web';

describe('parseLegacyWebImageSrc — every measured historic form', () => {
	const cases: [string, string | null][] = [
		['../../../media/image/web/pedro.jpg?1557488096859', 'pedro.jpg'],
		['/dedalo/media/image/web/celia.jpeg', 'celia.jpeg'],
		['/v6/media/media_development/image/web/albufera.jpg', 'albufera.jpg'],
		[
			'/dedalo/media/image/web/Captura%20de%20pantalla%20copia_ES.jpg',
			'Captura de pantalla copia_ES.jpg',
		],
		[
			'/dedalo/media/image/web/Captura de pantalla copia_EN.jpg',
			'Captura de pantalla copia_EN.jpg',
		],
		['https://cdn.example.org/dedalo/media/image/web/x.jpg', null],
		['//cdn.example.org/media/image/web/x.jpg', null],
		['../../../inc/btn.php/[geo-n-1-]', null],
		['http://localhost:8080/dedalo/core/themes/default/default.svg', null],
		['/dedalo/media/image/web/sub/x.jpg', null],
		['/dedalo/media/image/thumb/x.jpg', null],
	];
	for (const [src, expected] of cases) {
		test(src, () => expect(parseLegacyWebImageSrc(src, REL, '')).toBe(expected));
	}
	test('an absolute webBase (split-origin media) is this install, not another host', () => {
		expect(
			parseLegacyWebImageSrc(
				'https://media.example.org/dedalo/media/image/web/x.jpg',
				REL,
				'https://media.example.org/dedalo/media',
			),
		).toBe('x.jpg');
	});
});

describe('isKeyedTo — the record captures, never a bare grammar match', () => {
	test('a keyed name is keyed to its own record only', () => {
		expect(isKeyedTo('pic_test3_5.jpg', 'test3', 5)).toBe(true);
		expect(isKeyedTo('pic-1_test3_5.jpg', 'test3', 5)).toBe(true);
		expect(isKeyedTo('pic_test3_5.jpg', 'test3', 6)).toBe(false);
	});
	test('a legacy name that merely parses is not keyed (photo_2019_3.jpg)', () => {
		expect(isKeyedTo('photo_2019_3.jpg', 'test3', 3)).toBe(false);
		expect(isKeyedTo('pic.jpg', 'test3', 3)).toBe(false);
	});
});

describe('the .legacy rename leaves the grammar, a lang suffix included', () => {
	test('`-legacy` after a _lg- suffix would still parse; `.legacy` never does', () => {
		expect(keyOfWebImage('x_rsc170_45_lg-spa-legacy.jpg')).not.toBeNull();
		expect(keyOfWebImage('x_rsc170_45_lg-spa.legacy.jpg')).toBeNull();
		expect(keyOfWebImage('x_rsc170_45.legacy.jpg')).toBeNull();
		expect(keyOfWebImage('x_rsc170_45.legacy2.jpg')).toBeNull();
	});
	test('an entity-encoded src resolves to the same file', () => {
		expect(parseLegacyWebImageSrc('/dedalo/media/image/web/a&amp;b.jpg', REL, '')).toBe('a&b.jpg');
	});
});

describe('rewriteImgSrcs — only the matched src changes', () => {
	test('a data-src attribute is not the src', () => {
		const html =
			'<img data-src="/dedalo/media/image/web/a.jpg" src="/dedalo/media/image/web/b.jpg">';
		expect(rewriteImgSrcs(html, (src) => `${src}!`)).toBe(
			'<img data-src="/dedalo/media/image/web/a.jpg" src="/dedalo/media/image/web/b.jpg!">',
		);
	});
	test('the rest of the html is byte-identical', () => {
		const html =
			'<p class="x">a <img alt="A" src="/old/a.jpg" width="10"> b <img src="/keep.jpg"></p>';
		expect(rewriteImgSrcs(html, (src) => (src === '/old/a.jpg' ? '/new/a.jpg' : null))).toBe(
			'<p class="x">a <img alt="A" src="/new/a.jpg" width="10"> b <img src="/keep.jpg"></p>',
		);
	});
});

const TABLE = 'matrix_test';
const SECTION = 'test3';
/** test3's component_text_area (translatable). */
const TEXT = 'test17';
/** test3's NON-translatable component_text_area: every save of it is lg-nolan. */
const TEXT_NOLAN = 'test98';
/** Scratch ids this file plants raw and deletes by id. */
const LEGACY_ID = 990071;
const EXPOSED_ID = 990072;
const EMBEDDER_ID = 990073;
const HELD_ID = 990074;
const ENCODED_EMBEDDER_ID = 990075;
const LANGLESS_EMBEDDER_ID = 990076;
const OTHER_COMPONENT_ID = 990077;
/** test3's component_input_text: not a text the reconcile rewrites. */
const INPUT_TEXT = 'test52';
const IDS = [
	LEGACY_ID,
	EXPOSED_ID,
	EMBEDDER_ID,
	HELD_ID,
	ENCODED_EMBEDDER_ID,
	LANGLESS_EMBEDDER_ID,
	OTHER_COMPONENT_ID,
];

describe.if(DB_READY)('the reconciles on the suite database', () => {
	const webDir = (): string => join(config.media.rootPath as string, webImageRelDir());
	const pubDir = (): string => join(config.media.rootPath as string, '.publication', 'pub');
	const prefix = `/dedalo/${config.mediaDir}/${REL}`;
	const files: string[] = [];
	const plantFile = (name: string, ageMs = 3 * 24 * 3_600_000): string => {
		mkdirSync(webDir(), { recursive: true });
		const path = join(webDir(), name);
		writeFileSync(path, name);
		const at = new Date(Date.now() - ageMs);
		utimesSync(path, at, at);
		files.push(path);
		return path;
	};
	async function plantText(sectionId: number, values: Record<string, string>): Promise<void> {
		const items = Object.entries(values).map(([lang, value], index) => ({
			id: index + 1,
			lang,
			value,
		}));
		await plantRaw(sectionId, { [TEXT]: items });
	}
	async function plantRaw(sectionId: number, string: Record<string, unknown[]>): Promise<void> {
		await sql.unsafe(
			`INSERT INTO "${TABLE}" (section_id, section_tipo, string) VALUES ($1, $2, $3::text::jsonb)`,
			[sectionId, SECTION, JSON.stringify(string)],
		);
	}
	const rawString = async (sectionId: number): Promise<string> =>
		(await readMatrixRecord(TABLE, SECTION, sectionId))?.rawText.string ?? '';
	const ours = (list: unknown) => (list as string[]).filter((name) => name.startsWith('zzrt_'));
	const only = (name: string) => name.startsWith('zzrt_');
	async function textOf(sectionId: number, lang: string): Promise<string> {
		const record = await readMatrixRecord(TABLE, SECTION, sectionId);
		const items =
			(record?.columns.string as Record<string, { lang: string; value: string }[]>)?.[TEXT] ?? [];
		return items.find((item) => item.lang === lang)?.value ?? '';
	}
	const sweep = async (): Promise<void> => {
		for (const id of IDS) {
			await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
				SECTION,
				id,
			]);
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[SECTION, id],
			);
			rmSync(join(pubDir(), `${SECTION}_${id}`), { force: true });
		}
		for (const path of files.splice(0)) rmSync(path, { force: true });
		// Whatever the runs minted from the planted names (keyed copies, .legacy renames).
		if (existsSync(webDir())) {
			for (const name of (await import('node:fs')).readdirSync(webDir())) {
				if (name.startsWith('zzrt_')) rmSync(join(webDir(), name), { force: true });
			}
		}
	};
	beforeAll(async () => {
		await assertTestDatabase('rich_text_image_reconcile');
		await sweep();
	});
	afterAll(sweep);

	test('rich_text_images: dry reports, apply copies + rewrites through the save (TM), re-run is 0', async () => {
		plantFile('zzrt_old photo.jpg');
		const html = (src: string) => `<p>See <img alt="x" src="${src}"> here.</p>`;
		await plantText(LEGACY_ID, {
			'lg-eng': html('../../../media/image/web/zzrt_old%20photo.jpg?1557488096859'),
			'lg-spa': `${html('/dedalo/media/image/web/zzrt_old photo.jpg')}<img src="${prefix}/zzrt_gone.jpg">`,
		});
		const scope = [SECTION];
		const before = await runRichTextImages({ apply: false, scope });
		const mine = (list: unknown) =>
			(list as string[]).filter((line) => line.startsWith(`${SECTION}/${LEGACY_ID} `));
		expect(mine(before.detail.changes)).toHaveLength(2);
		expect(mine(before.detail.missing)).toEqual([
			`${SECTION}/${LEGACY_ID} ${TEXT} lg-spa: zzrt_gone.jpg`,
		]);
		expect(before.applied).toBe(0);
		// a dry run wrote nothing
		expect(await textOf(LEGACY_ID, 'lg-eng')).toBe(
			html('../../../media/image/web/zzrt_old%20photo.jpg?1557488096859'),
		);

		const applied = await runRichTextImages({ apply: true, scope });
		expect(applied.applied).toBeGreaterThanOrEqual(2);
		const keyed = `zzrt_old_photo_${SECTION}_${LEGACY_ID}.jpg`;
		expect(existsSync(join(webDir(), keyed))).toBe(true);
		expect(existsSync(join(webDir(), 'zzrt_old photo.jpg'))).toBe(true); // the original is kept
		// one copy for the record, shared by both langs; the rest of the html unchanged
		expect(await textOf(LEGACY_ID, 'lg-eng')).toBe(html(storedWebImageSrc(keyed, REL)));
		expect(await textOf(LEGACY_ID, 'lg-spa')).toBe(
			`${html(storedWebImageSrc(keyed, REL))}<img src="${prefix}/zzrt_gone.jpg">`,
		);
		const tm = (await sql.unsafe(
			'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, LEGACY_ID],
		)) as { n: number }[];
		expect(tm[0]?.n).toBe(2); // one TM row per saved lang

		const again = await runRichTextImages({ apply: false, scope });
		expect(mine(again.detail.changes)).toEqual([]);
		expect(mine(again.detail.missing)).toHaveLength(1); // still reported, never rewritten
	});

	test('rich_text_images HOLDS a text a save would corrupt: another-lang slice of a non-translatable text, lang-less items', async () => {
		plantFile('zzrt_held.jpg');
		const img = `<img src="${prefix}/zzrt_held.jpg">`;
		await plantRaw(HELD_ID, {
			// non-translatable, stored under lg-eng: a save would ADD an lg-nolan copy
			[TEXT_NOLAN]: [{ id: 1, lang: 'lg-eng', value: `<p>${img}</p>` }],
			// an item with no lang: any save of this component would drop it
			[TEXT]: [
				{ id: 1, lang: 'lg-eng', value: `<p>${img}</p>` },
				{ id: 2, value: `<p>${img}</p>` },
			],
		});
		const before = await rawString(HELD_ID);
		const scope = [SECTION];
		const heldOf = (report: { detail: Record<string, unknown> }) =>
			(report.detail.held as string[]).filter((line) => line.startsWith(`${SECTION}/${HELD_ID} `));
		const dry = await runRichTextImages({ apply: false, scope });
		expect(heldOf(dry).sort()).toEqual([
			`${SECTION}/${HELD_ID} ${TEXT} (no lang): items without a lang (any save of this component drops them)`,
			`${SECTION}/${HELD_ID} ${TEXT} lg-eng: items without a lang (any save of this component drops them)`,
			`${SECTION}/${HELD_ID} ${TEXT_NOLAN} lg-eng: stored as lg-eng but saved as lg-nolan (a save would add a copy, not rewrite it)`,
		]);
		const applied = await runRichTextImages({ apply: true, scope });
		expect(heldOf(applied)).toHaveLength(3);
		expect(await rawString(HELD_ID)).toBe(before); // nothing saved
		expect(existsSync(join(webDir(), `zzrt_held_${SECTION}_${HELD_ID}.jpg`))).toBe(false); // nothing copied
	});

	test('web_image_exposure: a published name its record does not embed is drift; apply renames it and repoints its embedder', async () => {
		mkdirSync(pubDir(), { recursive: true });
		writeFileSync(join(pubDir(), `${SECTION}_${EXPOSED_ID}`), '');
		const exposed = `zzrt_dl_${SECTION}_${EXPOSED_ID}.jpg`;
		const ownKeyed = `zzrt_own_${SECTION}_${EXPOSED_ID}.jpg`;
		const fresh = `zzrt_fresh_${SECTION}_${EXPOSED_ID}.jpg`;
		plantFile(exposed);
		plantFile(ownKeyed);
		plantFile(fresh, 60_000); // inside the grace window: its text may not be saved yet
		// The keyed record embeds only its own image; ANOTHER record embeds the exposed one.
		await plantText(EXPOSED_ID, {
			'lg-eng': `<p><img src="${storedWebImageSrc(ownKeyed, REL)}"></p>`,
		});
		await plantText(EMBEDDER_ID, { 'lg-eng': `<p><img src="${prefix}/${exposed}"></p>` });
		const isPublished = async (key: string) => existsSync(join(pubDir(), key));

		const dry = await runWebImageExposure({ apply: false, isPublished, only });
		expect(ours(dry.detail.exposed)).toEqual([exposed]);
		expect(ours(dry.detail.recent)).toEqual([fresh]);

		const applied = await runWebImageExposure({ apply: true, isPublished, only });
		expect(applied.applied).toBe(1);
		const renamed = `zzrt_dl_${SECTION}_${EXPOSED_ID}.legacy.jpg`;
		expect(existsSync(join(webDir(), exposed))).toBe(false);
		expect(existsSync(join(webDir(), renamed))).toBe(true);
		expect(isKeyedTo(renamed, SECTION, EXPOSED_ID)).toBe(false); // out of the grammar
		expect(await textOf(EMBEDDER_ID, 'lg-eng')).toBe(
			`<p><img src="${storedWebImageSrc(renamed, REL)}"></p>`,
		);

		const again = await runWebImageExposure({ apply: false, isPublished, only });
		expect(ours(again.detail.exposed)).toEqual([]);
		for (const path of files.splice(0)) rmSync(path, { force: true });
	});

	test('web_image_exposure: an _lg- name leaves the grammar, an encoded reference is repointed, a reference it cannot rewrite keeps BOTH names', async () => {
		const isPublished = async (key: string) => existsSync(join(pubDir(), key));
		mkdirSync(pubDir(), { recursive: true });
		writeFileSync(join(pubDir(), `${SECTION}_${EXPOSED_ID}`), '');
		const subtitle = `zzrt_lg_${SECTION}_${EXPOSED_ID}_lg-spa.jpg`;
		const spaced = `zzrt_enc x_${SECTION}_${EXPOSED_ID}.jpg`;
		const langless = `zzrt_nolang_${SECTION}_${EXPOSED_ID}.jpg`;
		const elsewhere = `zzrt_other_${SECTION}_${EXPOSED_ID}.jpg`;
		for (const name of [subtitle, spaced, langless, elsewhere]) plantFile(name);
		// referenced only from a component that is not a text_area: only the final re-scan sees it
		await plantRaw(OTHER_COMPONENT_ID, {
			[INPUT_TEXT]: [{ id: 1, lang: 'lg-nolan', value: `<img src="${prefix}/${elsewhere}">` }],
		});
		await plantText(ENCODED_EMBEDDER_ID, {
			'lg-eng': `<p><img src="${prefix}/${encodeURI(spaced)}"></p>`,
		});
		await plantRaw(LANGLESS_EMBEDDER_ID, {
			[TEXT]: [{ id: 1, value: `<p><img src="${prefix}/${langless}"></p>` }],
		});

		const applied = await runWebImageExposure({ apply: true, isPublished, only });
		expect(ours(applied.detail.exposed).sort()).toEqual(
			[elsewhere, langless, spaced, subtitle].sort(),
		);
		expect(applied.applied).toBe(2);
		// the _lg- name: renamed to a name that no longer parses
		const subtitleLegacy = `zzrt_lg_${SECTION}_${EXPOSED_ID}_lg-spa.legacy.jpg`;
		expect(existsSync(join(webDir(), subtitle))).toBe(false);
		expect(keyOfWebImage(subtitleLegacy)).toBeNull();
		expect(existsSync(join(webDir(), subtitleLegacy))).toBe(true);
		// the %20 reference was found and repointed before the old name went
		const spacedLegacy = `zzrt_enc x_${SECTION}_${EXPOSED_ID}.legacy.jpg`;
		expect(existsSync(join(webDir(), spaced))).toBe(false);
		expect(await textOf(ENCODED_EMBEDDER_ID, 'lg-eng')).toBe(
			`<p><img src="${storedWebImageSrc(spacedLegacy, REL)}"></p>`,
		);
		// a lang-less item cannot be saved: both names stay, the text still resolves, reported
		expect(existsSync(join(webDir(), langless))).toBe(true);
		expect(existsSync(join(webDir(), `zzrt_nolang_${SECTION}_${EXPOSED_ID}.legacy.jpg`))).toBe(
			true,
		);
		expect(await rawString(LANGLESS_EMBEDDER_ID)).toContain(`${prefix}/${langless}`);
		expect(
			(applied.detail.failed as string[]).filter((line) => line.startsWith(langless)),
		).toHaveLength(1);
		// the re-scan before the unlink: a reference outside any rewritable text keeps both names
		expect(existsSync(join(webDir(), elsewhere))).toBe(true);
		expect(
			(applied.detail.failed as string[]).filter((line) => line.startsWith(elsewhere)),
		).toHaveLength(1);
		// a re-run reuses the links it left, and still refuses
		const again = await runWebImageExposure({ apply: true, isPublished, only });
		expect(ours(again.detail.exposed).sort()).toEqual([elsewhere, langless].sort());
		expect(again.applied).toBe(0);
		expect(existsSync(join(webDir(), `zzrt_nolang_${SECTION}_${EXPOSED_ID}.legacy2.jpg`))).toBe(
			false,
		);
	});
});
