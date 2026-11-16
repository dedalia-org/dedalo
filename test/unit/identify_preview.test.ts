/**
 * PREVIEW THUMBNAILS for identification results (src/core/identify/preview.ts).
 *
 * The panel is a VISUAL comparison, so it shows pictures — and a picture is the
 * one part of this feature that can fail in a way the curator reads as "the tool
 * is broken" rather than "this record has no photograph". Hence the two gates
 * that matter here:
 *
 *  1. A profile that declares NO preview component yields no thumbs and no
 *     crash. Most sections will never declare one, so the absent case is the
 *     common path, not an edge case — and it must not cost an ontology read.
 *  2. A thumb that is NOT ON DISK yields NOTHING, never a URL. `mediaThumbUrl`
 *     is pure and will happily name a derivative nobody generated; returning it
 *     would put a broken-image icon in every row of a corpus mid-photography.
 *
 * Everything runs over the injected port with a SCRATCH media root, so no test
 * touches the shared media directory and none of it needs a database. The URL is
 * asserted against `mediaThumbUrl` itself rather than a hand-written string: the
 * point of the module is that it borrows the media subsystem's path grammar, and
 * a literal here would just be a second copy of that grammar to drift from.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import {
	type PreviewRecord,
	type PreviewSourcePort,
	resolvePreviewThumbs,
} from '../../src/core/identify/preview.ts';
import {
	type MediaIdentity,
	type MediaPathOptions,
	mediaThumbLocation,
	mediaThumbUrl,
} from '../../src/core/media/path.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';

// DECLARED on creation — the media doors refuse an unmarked root under the
// test-media seam (src/core/media/test_media_root.ts).
const SCRATCH_ROOT = markMediaRoot(join(import.meta.dir, '..', '..', '.scratch_identify_preview'));

const PATH_OPTIONS: MediaPathOptions = {
	initialMediaPath: '',
	maxItemsFolder: 1000,
	mediaRoot: SCRATCH_ROOT,
};

const PREVIEW = 'test99';
const SECTION = 'test3';

afterAll(() => {
	rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

/** A port over an in-memory ontology, counting what it was asked. */
function fakePort(
	overrides: { model?: string | null; translatable?: boolean } = {},
): PreviewSourcePort & { calls: { model: number; pathOptions: string[] } } {
	const calls = { model: 0, pathOptions: [] as string[] };
	return {
		calls,
		getModel: async () => {
			calls.model++;
			return overrides.model === undefined ? 'component_image' : overrides.model;
		},
		getTranslatable: async () => overrides.translatable === true,
		getPathOptions: async (_componentTipo, sectionTipo, sectionId) => {
			calls.pathOptions.push(`${sectionTipo}/${sectionId}`);
			return PATH_OPTIONS;
		},
		// The real filesystem, under the scratch root — the existence check is the
		// behaviour under test, so faking it would test nothing.
		fileExists: (absolutePath: string) => Bun.file(absolutePath).size > 0,
	};
}

/** Write a 1-byte stand-in for a generated thumb at the grammar's own location. */
function writeThumb(identity: MediaIdentity): string {
	const spec = mediaTypeOf('component_image');
	if (spec === null) throw new Error('component_image spec is not registered');
	const location = mediaThumbLocation(spec, identity, PATH_OPTIONS);
	if (location === null) throw new Error('component_image has no thumb tier');
	mkdirSync(dirname(location.absolutePath), { recursive: true });
	writeFileSync(location.absolutePath, 'x');
	return location.absolutePath;
}

const record = (sectionId: number): PreviewRecord => ({ sectionTipo: SECTION, sectionId });

describe('resolvePreviewThumbs — the absent cases', () => {
	test('a profile with no previewComponent yields no thumbs, and asks nothing', async () => {
		const port = fakePort();
		const thumbs = await resolvePreviewThumbs(null, [record(1), record(2)], port);
		expect(thumbs.size).toBe(0);
		// Not just "empty": the common path must not cost an ontology read either.
		expect(port.calls.model).toBe(0);
		expect(port.calls.pathOptions).toEqual([]);
	});

	test('an empty record list yields no thumbs', async () => {
		const port = fakePort();
		expect((await resolvePreviewThumbs(PREVIEW, [], port)).size).toBe(0);
		expect(port.calls.model).toBe(0);
	});

	test('a candidate whose thumb file is absent gets NO url — not a url to nothing', async () => {
		// The whole point: mediaThumbUrl would return a perfectly well-formed URL
		// for this record. Rendering it is a broken image.
		const port = fakePort();
		const thumbs = await resolvePreviewThumbs(PREVIEW, [record(4242)], port);
		expect(thumbs.get('test3_4242')).toBeUndefined();
		expect(thumbs.size).toBe(0);
	});

	test('a non-media preview component is ignored, not thrown', async () => {
		// The profile loader refuses this at parse time; the runtime half must
		// still degrade to "no picture" rather than turn the answer into a decline.
		const port = fakePort({ model: 'component_input_text' });
		expect((await resolvePreviewThumbs(PREVIEW, [record(1)], port)).size).toBe(0);
	});

	test('a media type with no thumb tier (svg) is ignored', async () => {
		const port = fakePort({ model: 'component_svg' });
		expect((await resolvePreviewThumbs(PREVIEW, [record(1)], port)).size).toBe(0);
	});

	test('an unknown component tipo is ignored', async () => {
		const port = fakePort({ model: null });
		expect((await resolvePreviewThumbs(PREVIEW, [record(1)], port)).size).toBe(0);
	});
});

describe('resolvePreviewThumbs — the present case', () => {
	test('a generated thumb yields the media subsystem OWN url', async () => {
		const identity: MediaIdentity = {
			componentTipo: PREVIEW,
			sectionTipo: SECTION,
			sectionId: 7,
			lang: null,
		};
		writeThumb(identity);

		const spec = mediaTypeOf('component_image');
		if (spec === null) throw new Error('component_image spec is not registered');

		const thumbs = await resolvePreviewThumbs(PREVIEW, [record(7)], fakePort());
		expect(thumbs.get('test3_7')).toBe(mediaThumbUrl(spec, identity, PATH_OPTIONS) as string);
		// and it really is a public media URL, not a filesystem path
		expect(thumbs.get('test3_7')?.startsWith(config.media.webBase)).toBe(true);
	});

	test('only the records that HAVE a thumb appear', async () => {
		writeThumb({ componentTipo: PREVIEW, sectionTipo: SECTION, sectionId: 8, lang: null });
		const thumbs = await resolvePreviewThumbs(PREVIEW, [record(8), record(9)], fakePort());
		expect([...thumbs.keys()]).toEqual(['test3_8']);
	});

	test('path options are resolved PER RECORD (its own bucket and image_id stem — T1-10)', async () => {
		const port = fakePort();
		await resolvePreviewThumbs(PREVIEW, [record(10), record(11), record(12)], port);
		expect(port.calls.pathOptions).toEqual([`${SECTION}/10`, `${SECTION}/11`, `${SECTION}/12`]);
	});

	test('a translatable preview component reads the request data lang', async () => {
		// One file per language: the identifier carries the lang suffix, so asking
		// for the no-lang path would find nothing and report "no picture" forever.
		const identity: MediaIdentity = {
			componentTipo: PREVIEW,
			sectionTipo: SECTION,
			sectionId: 13,
			lang: 'lg-spa',
		};
		writeThumb(identity);

		const thumbs = await runWithRequestLangs(
			{ applicationLang: 'lg-eng', dataLang: 'lg-spa' },
			() => resolvePreviewThumbs(PREVIEW, [record(13)], fakePort({ translatable: true })),
		);
		expect(thumbs.get('test3_13')).toContain(`${PREVIEW}_${SECTION}_13_lg-spa`);
	});

	test('one unusable record does not cost the others their picture', async () => {
		// section_id 0 is refused by the media identifier gate (it throws). The
		// answer is the breakdown; a thumbnail must never be able to fail the call.
		writeThumb({ componentTipo: PREVIEW, sectionTipo: SECTION, sectionId: 14, lang: null });
		const thumbs = await resolvePreviewThumbs(
			PREVIEW,
			[{ sectionTipo: SECTION, sectionId: 0 }, record(14)],
			fakePort(),
		);
		expect([...thumbs.keys()]).toEqual(['test3_14']);
	});
});
