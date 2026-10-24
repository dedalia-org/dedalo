/**
 * THE THUMB/POSTERFRAME CENSUS TRIPWIRE — the gate that keeps the five media
 * models CONSISTENT with each other.
 *
 * The consistency work of 2026-08-08 replaced five hand-maintained answers to
 * "where does this model's thumbnail come from, and who may write its source?"
 * with two declarations in concepts/media.ts (THUMB_SOURCE_BY_MODEL,
 * POSTERFRAME_WRITER_BY_MODEL) and one handler (media/thumb.ts). Declarations rot
 * the moment nothing reads them, and a per-model divergence is exactly the kind of
 * thing a future change reintroduces one branch at a time — this is the mechanical
 * check, per the house law that an invariant is tripwired or deleted.
 *
 * It asserts four things:
 *  1. THE CENSUS IS TOTAL AND CONSISTENT — every model classified, the derived
 *     sets in agreement, the operator remedy present exactly where the engine
 *     cannot mint.
 *  2. ONE GRAMMAR — the posterframe path/URL producers agree for every model and
 *     every path-option shape, including `additionalPathOverride`, which one of
 *     the three copies used to ignore outright.
 *  3. ONE WRITER — no module outside path.ts assembles a posterframe or thumb path
 *     from string fragments.
 *  4. ONE HANDLER — every trigger goes through thumb.ts rather than resolving a
 *     thumb source for itself.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import {
	CLIENT_POSTERFRAME_REMEDY,
	type MediaModel,
	mediaTypeOf,
	POSTERFRAME_MODELS,
	POSTERFRAME_WRITER_BY_MODEL,
	THUMB_SOURCE_BY_MODEL,
} from '../../src/core/concepts/media.ts';
import {
	buildMediaSegmentLocation,
	type MediaPathOptions,
	mediaThumbLocation,
	posterframeLocation,
} from '../../src/core/media/path.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const MODELS: MediaModel[] = [
	'component_image',
	'component_av',
	'component_pdf',
	'component_svg',
	'component_3d',
];

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8');

/** Source with comments stripped — prose must never satisfy or trip a source gate. */
const code = (relative: string): string =>
	read(relative)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the census is total and self-consistent', () => {
	test('every media model declares where its thumb comes from', () => {
		for (const model of MODELS) {
			expect([model, THUMB_SOURCE_BY_MODEL[model]]).toEqual([
				model,
				expect.stringMatching(/^(default_tier|posterframe)$/),
			]);
		}
		// No sixth key: a model added to one map and not the other is the drift.
		expect(Object.keys(THUMB_SOURCE_BY_MODEL).sort()).toEqual([...MODELS].sort());
		expect(Object.keys(POSTERFRAME_WRITER_BY_MODEL).sort()).toEqual([...MODELS].sort());
	});

	test('EVERY model has a thumb tier — the five agree', () => {
		// The universal rule the svg gap violated until 2026-08-08. A model without a
		// thumb is a record with no picture in every list view of the application.
		for (const model of MODELS) {
			expect([model, mediaTypeOf(model)?.hasThumb]).toEqual([model, true]);
		}
	});

	test('POSTERFRAME_MODELS is DERIVED, never a second hand-written list', () => {
		const fromSource = MODELS.filter((m) => THUMB_SOURCE_BY_MODEL[m] === 'posterframe').sort();
		expect([...POSTERFRAME_MODELS].sort()).toEqual(fromSource);
		// And it is exactly the set with a posterframe writer.
		expect(MODELS.filter((m) => POSTERFRAME_WRITER_BY_MODEL[m] !== null).sort()).toEqual(
			fromSource,
		);
	});

	test('a model the engine cannot mint for NAMES the gear that can', () => {
		for (const model of MODELS) {
			const writer = POSTERFRAME_WRITER_BY_MODEL[model];
			const remedy = CLIENT_POSTERFRAME_REMEDY[model];
			if (writer === 'client_capture') {
				// The operator-facing half must exist, and must be actionable prose
				// rather than a shrug — this is the text a refusal ends with.
				expect([model, typeof remedy]).toEqual([model, 'string']);
				expect((remedy as string).length).toBeGreaterThan(40);
			} else {
				// A remedy where the engine CAN mint would be a lie: nobody has to act.
				expect([model, remedy]).toEqual([model, null]);
			}
		}
	});
});

describe('one grammar: the posterframe path has a single producer', () => {
	const identity = {
		componentTipo: 'test94',
		sectionTipo: 'test3',
		sectionId: 1234,
		lang: null,
	};
	/**
	 * PATH MATH ONLY — nothing is written here. It is still a DECLARED root
	 * (`.dedalo_test_media`), because the one root resolver every builder shares
	 * refuses an undeclared one under the test-media seam, and a gate that asked
	 * for an exemption from that would be asking for the hole back.
	 */
	const CENSUS_ROOT = markMediaRoot(scratchDir('thumb_census_root'));
	/** The shapes that used to disagree — the override is the one a copy ignored. */
	const OPTION_SHAPES: MediaPathOptions[] = [
		{ initialMediaPath: '', maxItemsFolder: null, mediaRoot: CENSUS_ROOT },
		{ initialMediaPath: '', maxItemsFolder: 1000, mediaRoot: CENSUS_ROOT },
		{ initialMediaPath: '/sub', maxItemsFolder: 1000, mediaRoot: CENSUS_ROOT },
		{
			initialMediaPath: '/sub',
			maxItemsFolder: 1000,
			additionalPathOverride: '/custom',
			mediaRoot: CENSUS_ROOT,
		},
	];

	test('posterframeLocation === the segment builder, for every model and option shape', async () => {
		const { posterframeAbsolutePath } = await import('../../src/core/media/tools/posterframe.ts');
		for (const model of POSTERFRAME_MODELS) {
			const spec = mediaTypeOf(model as MediaModel)!;
			for (const opts of OPTION_SHAPES) {
				const viaSegment = buildMediaSegmentLocation(
					spec,
					identity,
					'posterframe',
					config.media.avExtras.posterframeExtension,
					opts,
				);
				const viaLocation = posterframeLocation(spec, identity, opts);
				expect(viaLocation?.absolutePath).toBe(viaSegment.absolutePath);
				// …and the helper every writer calls resolves to the same file.
				expect(posterframeAbsolutePath(spec, identity, opts)).toBe(viaSegment.absolutePath);
				// The override really is honoured (the defect the third copy carried).
				if (opts.additionalPathOverride != null) {
					expect(viaSegment.relativePath).toContain('/posterframe/custom/');
				}
			}
		}
	});

	test('a model with no posterframe resolves to null, never to a path', () => {
		for (const model of MODELS.filter((m) => !POSTERFRAME_MODELS.has(m))) {
			const spec = mediaTypeOf(model)!;
			expect([
				model,
				posterframeLocation(spec, identity, OPTION_SHAPES[0] as MediaPathOptions),
			]).toEqual([model, null]);
		}
	});

	test('the segment name is an ALLOWLIST, not a client string', () => {
		const spec = mediaTypeOf('component_3d')!;
		for (const evil of ['original', 'web', 'thumb', '..', 'deleted']) {
			expect(() =>
				buildMediaSegmentLocation(
					spec,
					identity,
					evil as 'posterframe',
					'jpg',
					OPTION_SHAPES[0] as MediaPathOptions,
				),
			).toThrow(/Invalid media segment/);
		}
	});

	test('the thumb of a posterframe model lands where files_info reads it', () => {
		// The av/3d thumb used to be WRITTEN through the posterframe module's own
		// ungated helper and READ BACK through buildMediaLocation. Same file, two
		// grammars — this pins that there is now one.
		for (const model of MODELS) {
			const spec = mediaTypeOf(model)!;
			for (const opts of OPTION_SHAPES) {
				const location = mediaThumbLocation(spec, identity, opts);
				expect([model, location?.relativePath]).toEqual([
					model,
					expect.stringContaining(`/${config.media.thumb.quality}`),
				]);
			}
		}
	});
});

describe('one writer, one handler', () => {
	/**
	 * THE ONE EXEMPTION, named rather than omitted: `section/indexation_grid.ts`
	 * builds its own posterframe URL and MUST keep doing so. Its grammar is
	 * deliberately NOT this one — PHP's export posture omits `initial_media_path`
	 * for av/3d (component_av :253 / component_3d :200) and its `id` may come from
	 * `properties.image_id` or an external-source filename stem rather than the
	 * media identifier. Those bytes are pinned against the PHP oracle by the
	 * indexation_grid corpus; routing it through `posterframeLocation` would
	 * "unify" the code by breaking a verified wire.
	 *
	 * Everything else shares one producer.
	 */
	test('no module builds a posterframe path from string fragments', () => {
		const suspects = [
			'src/core/media/component_emit.ts',
			'src/core/media/tools/posterframe.ts',
			'src/core/media/thumb.ts',
			'src/core/media/repair.ts',
			'src/core/media/tools/versions.ts',
			'src/core/media/ingest/process_uploaded_file.ts',
		];
		for (const file of suspects) {
			const body = code(file);
			expect([file, /`[^`]*\/posterframe\$\{/.test(body)]).toEqual([file, false]);
			expect([file, /\/posterframe['"]\s*\+/.test(body)]).toEqual([file, false]);
		}
	});

	test('the exempt grid builder is still THERE (positive control)', () => {
		// Without this, the exemption above would also pass on a file that silently
		// stopped emitting a posterframe URL at all — the grid cell would go blank
		// for every av/3d record and nothing would say so.
		expect(code('src/core/section/indexation_grid.ts')).toMatch(/\/posterframe\$\{bucket\}/);
	});

	test('every thumb trigger goes through the handler, not its own source rule', () => {
		// The panel gear, the repair sweep and the ingest path each used to resolve a
		// thumb source themselves; the divergence between those rules is what left
		// av/3d thumbs unrepairable and fresh av records pictureless.
		expect(code('src/core/media/tools/versions.ts')).toContain('rebuildThumb(');
		expect(code('src/core/media/repair.ts')).toContain('rebuildThumb(');
		expect(code('src/core/media/ingest/process_uploaded_file.ts')).toContain('rebuildThumb');
		// And none of them re-implements "default tier else master" for the thumb.
		for (const file of ['src/core/media/tools/versions.ts', 'src/core/media/repair.ts']) {
			expect([file, /no .* file and no original to build the thumb/.test(code(file))]).toEqual([
				file,
				false,
			]);
		}
	});

	test('the posterframe leaves its tier by MOVING, like every other media file', () => {
		// It was the ONE hard unlink in the media subsystem (the No-hard-delete law).
		const body = code('src/core/media/tools/posterframe.ts');
		expect(/\brmSync\s*\(/.test(body)).toBe(false);
		expect(body).toContain('moveToDeleted(');
	});

	test('deleting a posterframe deals with the thumb that depicts it', () => {
		const body = code('src/core/media/tools/posterframe.ts');
		// Retire always; rebuild only where the engine can mint a replacement.
		expect(body).toContain('retireThumb(');
		expect(body).toContain(
			"POSTERFRAME_WRITER_BY_MODEL[ctx.spec.model] !== 'server_frame_extract'",
		);
	});

	test('a posterframe write is persisted by the API layer (3d has no read-time rescan)', () => {
		for (const file of [
			'src/core/api/handlers/dd_component_3d_api.ts',
			'src/core/api/handlers/dd_component_av_api.ts',
		]) {
			expect([file, code(file).includes('persistMediaFilesInfo(')]).toEqual([file, true]);
		}
	});
});
