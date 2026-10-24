/**
 * THE SVG THUMB — the rewrite gap closed on 2026-08-08, and the reason it needs a
 * gate of its own rather than a line in media_processing.test.ts.
 *
 * component_svg had `hasThumb: false` in the TS catalog, so `assertValidQuality`
 * refused the tier and the media-versions panel's thumb gear answered "Unknown
 * media quality 'thumb' for component_svg (not in ladder [original, web])" on
 * every SVG record. PHP built one (`component_svg::create_thumb`, frozen
 * class.component_svg.php:353), the spec requires one (MEDIA_SPEC §4.4 + the §11
 * fixture corpus) and the client's list view PREFERS one
 * (view_default_list_svg.js:145) — the capability was simply missing.
 *
 * THE BUILD IS THE TRIPWIRE FOR THE RENDERER CHOICE. Dédalo runs ImageMagick under
 * a hardened policy that disables the MVG coder its internal SVG renderer emits,
 * so `magick x.svg` is REFUSED (measured; see engine/svg.ts). Anyone who reroutes
 * the svg thumb back through ImageMagick — the obvious "simplification", since
 * every other type's thumb goes that way — fails `builds a thumb from a vector`
 * below with that exact policy error. That is the point: the comment cannot
 * enforce it, this can.
 *
 * The suite is honest about its binaries: librsvg and ImageMagick are probed, and
 * the cases that need them are `test.if`-gated rather than silently green.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { config } from '../../src/config/config.ts';
import { assertValidQuality, mediaTypeOf } from '../../src/core/concepts/media.ts';
import { resolveMagick } from '../../src/core/media/engine/imagemagick.ts';
import { buildRsvgArgv, rasterizeSvg, rsvgAvailable } from '../../src/core/media/engine/svg.ts';
import { scanFilesInfo } from '../../src/core/media/files_info.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import { regenerateSvg } from '../../src/core/media/processing.ts';
import { buildVersionCore } from '../../src/core/media/tools/versions.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('svg_thumb');
const svg = mediaTypeOf('component_svg')!;
const HAVE_RSVG = rsvgAvailable();
const HAVE_MAGICK = existsSync(resolveMagick());
const HAVE_BOTH = HAVE_RSVG && HAVE_MAGICK;

const identity: MediaIdentity = {
	componentTipo: 'test177',
	sectionTipo: 'test3',
	sectionId: 205,
	lang: null,
};
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };
const IDENTIFIER = 'test177_test3_205';
const thumbPath = `${ROOT}/svg/${config.media.thumb.quality}/${IDENTIFIER}.${config.media.thumb.extension}`;

/** A real vector with area and colour — a blank one would defeat the thumb's blank-guard. */
const SVG_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
	<rect width="400" height="300" fill="#204080"/>
	<circle cx="200" cy="150" r="90" fill="#f0a020"/>
	<rect x="40" y="40" width="80" height="60" fill="#ffffff"/>
</svg>
`;

/** Plant an svg file at `quality` (the web copy, the original, or both). */
function plant(quality: string, content = SVG_SOURCE): string {
	const dir = `${ROOT}/svg/${quality}`;
	mkdirSync(dir, { recursive: true });
	const path = `${dir}/${IDENTIFIER}.svg`;
	writeFileSync(path, content);
	return path;
}

beforeAll(() => resetMediaRoot(ROOT));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('component_svg has a thumb tier at all', () => {
	test('the catalog says so — the flag the panel gear died on', () => {
		expect(svg.hasThumb).toBe(true);
		// The refusal that produced the operator-visible error is gone.
		expect(assertValidQuality(svg, config.media.thumb.quality)).toBe(config.media.thumb.quality);
	});

	test('the tier is scanned into files_info once the file exists', () => {
		resetMediaRoot(ROOT);
		plant(svg.defaultQuality);
		// A scan INVENTS NOTHING: no file, no entry (getQualityFileInfo emits one
		// only for a file that exists). The panel draws its column from ar_quality,
		// not from this — the entry is what makes the cell report a real file.
		const before = scanFilesInfo(svg, identity, pathOpts);
		expect(before.find((entry) => entry.quality === config.media.thumb.quality)).toBeUndefined();

		mkdirSync(`${ROOT}/svg/${config.media.thumb.quality}`, { recursive: true });
		writeFileSync(thumbPath, 'not-a-real-jpeg-but-a-real-file');
		const after = scanFilesInfo(svg, identity, pathOpts);
		const thumbAfter = after.find((entry) => entry.quality === config.media.thumb.quality);
		expect(thumbAfter?.file_exist).toBe(true);
		expect(thumbAfter?.extension).toBe(config.media.thumb.extension);
	});
});

describe('the rasterizer (librsvg, NOT ImageMagick)', () => {
	test('argv: dpi on both axes, png out, source last', () => {
		const argv = buildRsvgArgv('/in.svg', '/out.png', 150);
		expect(argv[0]).toBe(config.media.binaries.rsvgConvert);
		expect(argv.slice(1)).toEqual([
			'--dpi-x',
			'150',
			'--dpi-y',
			'150',
			'--format',
			'png',
			'-o',
			'/out.png',
			'/in.svg',
		]);
	});

	test('a nonsense dpi is refused before anything is spawned', () => {
		expect(() => buildRsvgArgv('/in.svg', '/out.png', 0)).toThrow(/invalid dpi/);
	});

	test.if(HAVE_RSVG)('renders a vector to a real png', async () => {
		resetMediaRoot(ROOT);
		const source = plant(svg.defaultQuality);
		const target = `${ROOT}/render.png`;
		await rasterizeSvg(source, target, 96);
		expect(existsSync(target)).toBe(true);
		expect(Bun.file(target).size).toBeGreaterThan(0);
	});

	test.if(HAVE_RSVG)('an unrenderable file fails LOUDLY, never silently', async () => {
		resetMediaRoot(ROOT);
		const source = plant(svg.defaultQuality, 'this is not a vector at all');
		await expect(rasterizeSvg(source, `${ROOT}/render.png`, 96)).rejects.toThrow(/rsvg-convert/);
	});
});

describe('build_version thumb (the panel gear)', () => {
	test.if(HAVE_BOTH)('builds a thumb from a vector, within the thumb box', async () => {
		resetMediaRoot(ROOT);
		plant(svg.defaultQuality);
		const out = await buildVersionCore(svg, identity, pathOpts, config.media.thumb.quality);
		expect(out.built).toEqual([thumbPath]);
		expect(existsSync(thumbPath)).toBe(true);
		expect(Bun.file(thumbPath).size).toBeGreaterThan(0);

		const { getDimensions } = await import('../../src/core/media/engine/imagemagick.ts');
		const size = await getDimensions(thumbPath);
		expect(size).not.toBeNull();
		// Shrink-only, inside the configured box (the shared dd_thumb recipe).
		expect(size?.width).toBeLessThanOrEqual(config.media.thumb.width);
		expect(size?.height).toBeLessThanOrEqual(config.media.thumb.height);
	});

	test.if(HAVE_BOTH)('leaves NO intermediate render beside the thumb', async () => {
		resetMediaRoot(ROOT);
		plant(svg.defaultQuality);
		await buildVersionCore(svg, identity, pathOpts, config.media.thumb.quality);
		const files = readdirSync(`${ROOT}/svg/${config.media.thumb.quality}`);
		// The full-resolution png the rasterizer writes is a step, not an artifact.
		expect(files.filter((name) => name.endsWith('.png'))).toEqual([]);
		expect(files).toEqual([`${IDENTIFIER}.${config.media.thumb.extension}`]);
	});

	test.if(HAVE_BOTH)('builds from the ORIGINAL when there is no web copy yet', async () => {
		resetMediaRoot(ROOT);
		plant(svg.originalQuality);
		const out = await buildVersionCore(svg, identity, pathOpts, config.media.thumb.quality);
		expect(out.built).toEqual([thumbPath]);
		expect(existsSync(thumbPath)).toBe(true);
	});
});

describe('regenerateSvg: web copy + thumb, thumb non-fatal', () => {
	test.if(HAVE_BOTH)('writes both files from the original', async () => {
		resetMediaRoot(ROOT);
		plant(svg.originalQuality);
		const out = await regenerateSvg(svg, identity, pathOpts);
		expect(out.errors).toEqual([]);
		expect(out.created).toEqual([`${ROOT}/svg/${svg.defaultQuality}/${IDENTIFIER}.svg`, thumbPath]);
		expect(existsSync(thumbPath)).toBe(true);
	});

	test.if(HAVE_RSVG)('a thumb that cannot be rendered costs the THUMB, not the copy', async () => {
		resetMediaRoot(ROOT);
		plant(svg.originalQuality, 'this is not a vector at all');
		const out = await regenerateSvg(svg, identity, pathOpts);
		// The deliverable file landed…
		expect(existsSync(`${ROOT}/svg/${svg.defaultQuality}/${IDENTIFIER}.svg`)).toBe(true);
		expect(out.created).toHaveLength(1);
		// …and the failure is a VALUE the caller can show, not a thrown regeneration.
		expect(out.errors).toHaveLength(1);
		expect(out.errors[0]).toMatch(/thumb/i);
		expect(existsSync(thumbPath)).toBe(false);
	});
});
