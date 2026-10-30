/**
 * Server-emitted media URLs are versioned by the FILE (WC-2026-10-29-posterframe-url-version,
 * one helper: src/core/media/url_version.ts). component_av `posterframe_url`:
 * `?v=<mtime ms>-<size>` — so the client reuses the HTTP cache across renders and a regenerated
 * posterframe still gets a new URL. Built on the generic `test` TLD (test94 = av in test3),
 * the posterframe planted in the suite media root and removed after (with its bucket dir, when
 * this gate created it). Also: a stat ERROR (not only a missing file) is "no file", never a
 * failed read; the indexation grid's media cells carry the same token (versionedMediaUrl); the image
 * `base_svg_url` too (test99 = image in test3) — layer saves rewrite the envelope without touching
 * files_info, so only the stat can version it.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import { mediaEmitHook } from '../../src/core/media/component_emit.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import { posterframeLocation } from '../../src/core/media/path.ts';
import { baseSvgUrl, svgOverlayLocation } from '../../src/core/media/svg_overlay.ts';
import { versionedMediaUrl } from '../../src/core/media/url_version.ts';
import { EmissionContext } from '../../src/core/resolve/component_data.ts';

const SECTION_TIPO = 'test3';
const TIPO = 'test94';
const SECTION_ID = 987_654;

let planted: string | null = null;
let createdDir: string | null = null;
afterAll(() => {
	if (planted !== null) rmSync(planted, { force: true });
	if (createdDir !== null) rmSync(createdDir, { recursive: true, force: true });
});

async function location() {
	const spec = mediaTypeOf('component_av')!;
	const loc = posterframeLocation(
		spec,
		{ componentTipo: TIPO, sectionTipo: SECTION_TIPO, sectionId: SECTION_ID, lang: null },
		await resolveMediaPathOptions(TIPO, SECTION_TIPO),
	)!;
	// never adopt (and later delete) a file this gate did not plant
	if (existsSync(loc.absolutePath)) throw new Error(`refusing: ${loc.absolutePath} exists`);
	if (!existsSync(dirname(loc.absolutePath))) createdDir = dirname(loc.absolutePath);
	return loc;
}

async function emitPosterframeUrl(): Promise<unknown> {
	const emission = new EmissionContext();
	const record = {
		section_tipo: SECTION_TIPO,
		section_id: SECTION_ID,
		columns: { media: { [TIPO]: [{ id: 1, files_info: [] }] } },
	} as unknown as MatrixRecord;
	await mediaEmitHook.emitItem!({
		ddo: { tipo: TIPO, section_tipo: SECTION_TIPO } as never,
		record,
		row: { section_tipo: SECTION_TIPO, section_id: SECTION_ID },
		model: 'component_av',
		ddoMode: 'list',
		ddoLang: 'lg-nolan',
		defaultMode: 'list',
		defaultLang: 'lg-nolan',
		callerTipo: SECTION_TIPO,
		emission,
	});
	return (emission.items[0] as { posterframe_url?: unknown }).posterframe_url;
}

test('posterframe_url carries ?v=<mtime ms>-<size> and changes when the file does', async () => {
	const loc = await location();
	planted = loc.absolutePath;
	mkdirSync(dirname(planted), { recursive: true });
	writeFileSync(planted, 'the-posterframe');

	const t0 = new Date(2026, 0, 1);
	utimesSync(planted, t0, t0);
	const first = await emitPosterframeUrl();
	const { mtimeMs, size } = statSync(planted);
	expect(String(first)).toEndWith(`${loc.relativePath}?v=${Math.trunc(mtimeMs)}-${size}`);
	// same bytes, same mtime → same URL (the cache is reused)
	expect(await emitPosterframeUrl()).toBe(first);

	// a new still with a new mtime → new URL
	const t1 = new Date(2026, 5, 1);
	utimesSync(planted, t1, t1);
	const second = await emitPosterframeUrl();
	expect(second).not.toBe(first);

	// a new still in the SAME mtime (a second-resolution mount, two writes in one
	// second) → new URL through the size
	writeFileSync(planted, 'another-posterframe');
	utimesSync(planted, t1, t1);
	expect(await emitPosterframeUrl()).not.toBe(second);

	// the indexation grid's media cell: same token on the PHP-grammar path
	const cell = `${config.media.webBase}${loc.relativePath}`;
	const { mtimeMs: m, size: z } = statSync(planted);
	expect(versionedMediaUrl(cell)).toBe(`${cell}?v=${Math.trunc(m)}-${z}`);

	rmSync(planted);
	expect(await emitPosterframeUrl()).toBeNull();
	expect(versionedMediaUrl(cell)).toBe(cell); // no file → bare, as before
	expect(versionedMediaUrl(`${config.media.webBase}/../../etc/hosts`)).toBe(
		`${config.media.webBase}/../../etc/hosts`,
	); // escapes the root → bare, never statted
	expect(versionedMediaUrl('https://example.org/x.jpg')).toBe('https://example.org/x.jpg');
});

test('a stat ERROR (ENOTDIR) is "no posterframe", not a failed read', async () => {
	const loc = await location();
	if (createdDir === null)
		throw new Error('bucket dir pre-exists — cannot plant a file in its place');
	// a FILE where the bucket directory should be → stat answers ENOTDIR, not ENOENT
	rmSync(createdDir, { recursive: true, force: true });
	mkdirSync(dirname(createdDir), { recursive: true });
	writeFileSync(createdDir, 'not-a-directory');
	try {
		expect(await emitPosterframeUrl()).toBeNull();
		expect(versionedMediaUrl(`${config.media.webBase}${loc.relativePath}`)).toBe(
			`${config.media.webBase}${loc.relativePath}`,
		);
	} finally {
		rmSync(createdDir, { force: true });
	}
});

test('image base_svg_url carries ?v=<mtime ms>-<size> and changes when the envelope does', async () => {
	const spec = mediaTypeOf('component_image')!;
	const identity = {
		componentTipo: 'test99',
		sectionTipo: SECTION_TIPO,
		sectionId: SECTION_ID,
		lang: null,
	};
	const pathOpts = await resolveMediaPathOptions('test99', SECTION_TIPO);
	const loc = svgOverlayLocation(spec, identity, pathOpts);
	if (existsSync(loc.absolutePath)) throw new Error(`refusing: ${loc.absolutePath} exists`);
	const dir = dirname(loc.absolutePath);
	const svgCreatedDir = existsSync(dir) ? null : dir;
	try {
		expect(baseSvgUrl(spec, identity, pathOpts)).toBeNull();
		mkdirSync(dir, { recursive: true });
		writeFileSync(loc.absolutePath, '<svg/>');
		const t0 = new Date(2026, 0, 1);
		utimesSync(loc.absolutePath, t0, t0);
		const first = baseSvgUrl(spec, identity, pathOpts);
		const { mtimeMs, size } = statSync(loc.absolutePath);
		expect(first).toBe(
			`${config.media.webBase}${loc.relativePath}?v=${Math.trunc(mtimeMs)}-${size}`,
		);
		expect(baseSvgUrl(spec, identity, pathOpts)).toBe(first);
		// a layer save rewrites the envelope (same second) → new URL
		writeFileSync(loc.absolutePath, '<svg><g/></svg>');
		utimesSync(loc.absolutePath, t0, t0);
		expect(baseSvgUrl(spec, identity, pathOpts)).not.toBe(first);
	} finally {
		rmSync(loc.absolutePath, { force: true });
		if (svgCreatedDir !== null) rmSync(svgCreatedDir, { recursive: true, force: true });
	}
});
