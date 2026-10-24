/**
 * Phase B unit gate: the files_info SCANNER (Index law) + FILE OPS (No-hard-
 * delete law + duplication + TM deleted-scan) against a scratch media root.
 * The scanner's dd_date/size/path shape is pinned; the byte-equal-to-live gate
 * runs read-only over the shared dir in the parity suite.
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import {
	duplicateMediaFiles,
	listDeletedVersions,
	moveToDeleted,
	renameOldFiles,
} from '../../src/core/media/file_ops.ts';
import { ddDateFromMtime, scanFilesInfo } from '../../src/core/media/files_info.ts';
import type { MediaIdentity, MediaPathOptions } from '../../src/core/media/path.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('media_fi');
/** The repo root — a child bun process is booted from it (see the pdf-cover gate). */
const REPO_ROOT = join(import.meta.dir, '../..');
const image = mediaTypeOf('component_image')!;
const pdf = mediaTypeOf('component_pdf')!;
const identity: MediaIdentity = {
	componentTipo: 'test99',
	sectionTipo: 'test3',
	sectionId: 5,
	lang: null,
};
const pathOpts: MediaPathOptions = { initialMediaPath: '', maxItemsFolder: null, mediaRoot: ROOT };

/** Write a file at a media-relative path under ROOT (creating dirs). */
function place(relative: string, content: string, mtime?: Date): void {
	const abs = `${ROOT}${relative}`;
	mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
	writeFileSync(abs, content);
	if (mtime) utimesSync(abs, mtime, mtime);
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root (the media doors refuse an unmarked one under the
	// test-media seam — src/core/media/test_media_root.ts).
	markMediaRoot(ROOT);
	// default (1.5MB) + thumb exist; original raw tif twin present.
	place('/image/1.5MB/test99_test3_5.jpg', 'jpeg-web', new Date('2024-06-25T19:25:40'));
	place('/image/thumb/test99_test3_5.jpg', 'thumb', new Date('2024-06-25T19:25:41'));
	place('/image/original/test99_test3_5.jpg', 'norm-original');
	place('/image/original/test99_test3_5.tif', 'raw-original');
	// Record 7 is the EXTENSION-ORDER fixture: one derived tier holding its own
	// normalized file plus every other extension the scan walks (see the order gate).
	place('/image/1.5MB/test99_test3_7.jpg', 'jpeg-web');
	for (const extension of ORDER_FIXTURE_EXTENSIONS) {
		place(`/image/1.5MB/test99_test3_7.${extension}`, `web-${extension}`);
	}
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe('files_info scanner (Index law)', () => {
	test('projects existing quality/extension files, skips absent', () => {
		const info = scanFilesInfo(image, identity, pathOpts, {
			originalNormalizedName: 'test99_test3_5.jpg',
		});
		const byQuality = new Map(info.map((e) => [`${e.quality}.${e.extension}`, e]));
		// present tiers
		expect(byQuality.has('1.5MB.jpg')).toBe(true);
		expect(byQuality.has('thumb.jpg')).toBe(true);
		expect(byQuality.has('original.jpg')).toBe(true);
		expect(byQuality.has('original.tif')).toBe(true); // raw twin
		// absent tiers not emitted
		expect(byQuality.has('100MB.jpg')).toBe(false);
		expect(byQuality.has('6MB.jpg')).toBe(false);
		// every emitted entry exists + carries a relative path + size + dd_date
		for (const e of info) {
			expect(e.file_exist).toBe(true);
			expect(e.file_path?.startsWith('/image/')).toBe(true);
			expect(typeof e.file_size).toBe('number');
			expect(e.file_time?.timestamp).toBeDefined();
		}
	});

	test('dd_date file_time uses the virtual-calendar encoding', () => {
		const dd = ddDateFromMtime(new Date('2024-06-25T19:25:40'));
		expect(dd.year).toBe(2024);
		expect(dd.month).toBe(6);
		expect(dd.day).toBe(25);
		expect(dd.time).toBe(65068514740); // year*372*86400 + … (matches stored samples)
		expect(dd.timestamp).toBe('2024-06-25 19:25:40');
	});

	test('file_size + file_time reproduce the on-disk file', () => {
		const info = scanFilesInfo(image, identity, pathOpts, {});
		const web = info.find((e) => e.quality === '1.5MB' && e.extension === 'jpg')!;
		const stats = statSync(`${ROOT}/image/1.5MB/test99_test3_5.jpg`);
		expect(web.file_size).toBe(stats.size);
		expect(web.file_time).toEqual(ddDateFromMtime(stats.mtime));
	});
});

describe('file ops — no-hard-delete + duplication + deleted-scan', () => {
	test('moveToDeleted → deleted/<stem>_deleted_<Y-m-d_Hi>.<ext>', () => {
		place('/image/6MB/test99_test3_5.jpg', 'to-delete');
		const target = moveToDeleted(`${ROOT}/image/6MB/test99_test3_5.jpg`, {
			now: new Date('2024-11-15T14:30:00'),
			mediaRoot: ROOT,
		});
		expect(target).toContain('/image/6MB/deleted/test99_test3_5_deleted_2024-11-15_1430.jpg');
		expect(existsSync(target as string)).toBe(true);
		expect(existsSync(`${ROOT}/image/6MB/test99_test3_5.jpg`)).toBe(false);
	});

	test('moveToDeleted on an absent file is a no-op (null)', () => {
		expect(moveToDeleted(`${ROOT}/image/25MB/nope.jpg`, { mediaRoot: ROOT })).toBeNull();
	});

	test('renameOldFiles backs up before overwrite', () => {
		place('/image/100MB/test99_test3_5.jpg', 'old');
		const backup = renameOldFiles(
			`${ROOT}/image/100MB/test99_test3_5.jpg`,
			new Date('2024-11-15T14:31:00'),
			ROOT,
		);
		expect(backup).toContain('/image/100MB/deleted/');
		expect(existsSync(`${ROOT}/image/100MB/test99_test3_5.jpg`)).toBe(false);
	});

	test('duplicateMediaFiles copies every quality/ext to the target id', async () => {
		const target: MediaIdentity = { ...identity, sectionId: 99 };
		const targetOpts: MediaPathOptions = { ...pathOpts };
		const created = await duplicateMediaFiles(image, identity, target, {
			source: pathOpts,
			target: targetOpts,
		});
		expect(created.length).toBeGreaterThan(0);
		expect(existsSync(`${ROOT}/image/1.5MB/test99_test3_99.jpg`)).toBe(true);
		expect(existsSync(`${ROOT}/image/thumb/test99_test3_99.jpg`)).toBe(true);
		expect(existsSync(`${ROOT}/image/original/test99_test3_99.tif`)).toBe(true);
	});

	test('listDeletedVersions natural-sorts recovered files', () => {
		place('/image/25MB/deleted/test99_test3_5_deleted_2024-01-01_0900.jpg', 'a');
		place('/image/25MB/deleted/test99_test3_5_deleted_2024-02-01_0900.jpg', 'b');
		const versions = listDeletedVersions(image, identity, '25MB', 'jpg', pathOpts);
		expect(versions.length).toBe(2);
		expect(versions[versions.length - 1]).toContain('2024-02-01');
	});
});

/**
 * EXTENSION ORDER WITHIN A QUALITY — load-bearing, and invisible until it breaks.
 *
 * `scanFilesInfo` emits one entry per quality × extension IN LIST ORDER, and two
 * classes of consumer pick a tier's file BY QUALITY ALONE, i.e. they take the
 * FIRST entry of that quality: `resolve/relation_list.ts` (`find(info =>
 * info.quality === defaultQuality)`) and four component_image views. Since
 * 2026-08-07 a derived tier really can hold more than one file — the engine now
 * BUILDS the alternate-extension twins it only ever scanned for before — so the
 * "there is only one entry per quality anyway" accident that used to protect
 * those consumers is gone.
 *
 * The rule: the type's own `defaultExtension` comes FIRST, and every list added
 * to the scan (upload allowlist, alternates, pdf covers) is APPENDED. Get it
 * wrong and a record silently starts serving its avif to a client that asked for
 * "the 1.5MB file" — no error anywhere, just the wrong bytes.
 */
const ORDER_FIXTURE_EXTENSIONS: readonly string[] = [
	// A NON-default extension that is on the scan list for every install (it is in
	// image's upload allowlist), so this gate can never pass vacuously on a box
	// that configures no alternates…
	'png',
	// …plus whatever this install really did configure, which is the case that
	// only exists because there is now a writer for it.
	...image.alternateExtensions.filter((extension) => extension !== image.defaultExtension),
];

describe('files_info scan order: the default extension is FIRST', () => {
	const orderIdentity: MediaIdentity = { ...identity, sectionId: 7 };

	test('the fixture really holds several extensions of one quality (positive control)', () => {
		expect(ORDER_FIXTURE_EXTENSIONS.length).toBeGreaterThan(0);
		const info = scanFilesInfo(image, orderIdentity, pathOpts, {});
		const tier = info.filter((entry) => entry.quality === image.defaultQuality);
		expect(tier.map((entry) => entry.extension).sort()).toEqual(
			[image.defaultExtension, ...ORDER_FIXTURE_EXTENSIONS].sort(),
		);
	});

	test("the FIRST entry of a quality is the type's own normalized file", () => {
		const info = scanFilesInfo(image, orderIdentity, pathOpts, {});
		const tier = info.filter((entry) => entry.quality === image.defaultQuality);
		expect(tier[0]?.extension).toBe(image.defaultExtension);
		// Written the way the consumers actually write it — this IS relation_list.ts:463.
		const asAConsumerReadsIt = info.find((entry) => entry.quality === image.defaultQuality);
		expect(asAConsumerReadsIt?.extension).toBe(image.defaultExtension);
		expect(asAConsumerReadsIt?.file_path?.endsWith(`.${image.defaultExtension}`)).toBe(true);
	});

	test('…and it leads because the SCANNER puts it there, not because a list does', () => {
		// image's upload allowlist happens to begin with 'jpg', so the gate above
		// would also pass on a scanner that simply concatenated the lists in
		// configuration order. scanFilesInfo takes the spec as a parameter, so the
		// mutation runs here: with the allowlist REORDERED (and the alternates put in
		// front of it), the type's own normalized file must still come out first.
		const reordered = {
			...image,
			allowedExtensions: [...image.allowedExtensions].reverse(),
		};
		const info = scanFilesInfo(reordered, orderIdentity, pathOpts, {});
		const tier = info.filter((entry) => entry.quality === image.defaultQuality);
		expect(tier.length).toBeGreaterThan(1);
		expect(tier[0]?.extension).toBe(image.defaultExtension);
	});
});

/**
 * THE PDF COVER IS SCANNED WHETHER OR NOT THE CONFIG LISTS IT.
 *
 * `DEDALO_PDF_ALTERNATIVE_EXTENSIONS` defaults to `['jpg']` and the jpg cover is
 * built unconditionally (`buildPdfCovers` walks `spec.coverExtensions`, whose
 * first entry is the literal cover extension). Deriving the SCAN list from the
 * config alone would therefore let an operator who empties that key un-index
 * every cover already on disk: the file keeps existing and the record stops
 * seeing it — data loss by config edit, with nothing said.
 *
 * The discriminator only exists with the key EMPTIED, and config is frozen at
 * boot, so this boots a child with the key set to `[]` (the established
 * technique — see active_ontology_tlds.test.ts). Without the union in
 * files_info.ts the child reports no `web.jpg` at all.
 */
describe('files_info scans the pdf cover independently of the config', () => {
	const PROBE = [
		"const { mediaTypeOf } = await import('./src/core/concepts/media.ts');",
		"const { scanFilesInfo } = await import('./src/core/media/files_info.ts');",
		"const pdf = mediaTypeOf('component_pdf');",
		'const info = scanFilesInfo(',
		'\tpdf,',
		"\t{ componentTipo: 'test85', sectionTipo: 'test3', sectionId: 5, lang: null },",
		"\t{ initialMediaPath: '', maxItemsFolder: null, mediaRoot: process.env.PROBE_MEDIA_ROOT },",
		'\t{},',
		');',
		'console.log(',
		'\tJSON.stringify({',
		'\t\talternates: pdf.alternateExtensions,',
		'\t\tcovers: pdf.coverExtensions,',
		'\t\tscanned: info.map((entry) => `${entry.quality}.${entry.extension}`),',
		'\t}),',
		');',
	].join('');

	/** Boot the scanner in a child with `DEDALO_PDF_ALTERNATIVE_EXTENSIONS` overridden. */
	function scanWithPdfKey(value: string): {
		alternates: string[];
		covers: string[];
		scanned: string[];
	} {
		const child = Bun.spawnSync(['bun', '-e', PROBE], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				DEDALO_PDF_ALTERNATIVE_EXTENSIONS: value,
				PROBE_MEDIA_ROOT: ROOT,
			} as Record<string, string>,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const stdout = child.stdout.toString().trim();
		if (child.exitCode !== 0) {
			throw new Error(`probe failed (${String(child.exitCode)}): ${child.stderr.toString()}`);
		}
		// The child may log boot noise; the payload is the LAST line it prints.
		return JSON.parse((stdout.split('\n').pop() ?? '').trim());
	}

	beforeAll(() => {
		place('/pdf/web/test85_test3_5.pdf', 'the document');
		place('/pdf/web/test85_test3_5.jpg', 'the cover');
	});

	test('the cover survives an EMPTIED DEDALO_PDF_ALTERNATIVE_EXTENSIONS', () => {
		const emptied = scanWithPdfKey('[]');
		// The key really is empty in the child — otherwise this proves nothing.
		expect(emptied.alternates).toEqual([]);
		// …and the cover is still declared, and still scanned.
		expect(emptied.covers).toEqual(['jpg']);
		expect(emptied.scanned).toContain('web.jpg');
		expect(emptied.scanned).toContain('web.pdf');
	});

	test('and it is the COVER UNION that carries it — the mutation, in place', () => {
		// The gate above would also pass if some other list happened to hold 'jpg'.
		// scanFilesInfo takes the spec as a parameter, so the mutation can be run here
		// rather than asserted from prose. It is run against `managedExtensions` — the
		// ONE list every enumeration of a record's files reads (concepts/media.ts) —
		// because that is where the union now lives; dropping the cover from it is
		// exactly what "scan only what the config lists" would ship.
		//
		// The real spec is asserted first, so the mutation is a mutation OF the
		// shipped state and not of an invented one.
		expect(pdf.coverExtensions).toContain('jpg');
		for (const cover of pdf.coverExtensions) expect(pdf.managedExtensions).toContain(cover);
		const withCover = scanFilesInfo(
			{ ...pdf, alternateExtensions: [], managedExtensions: ['pdf', 'jpg'] },
			{ componentTipo: 'test85', sectionTipo: 'test3', sectionId: 5, lang: null },
			pathOpts,
			{},
		);
		const withoutCover = scanFilesInfo(
			{ ...pdf, alternateExtensions: [], coverExtensions: [], managedExtensions: ['pdf'] },
			{ componentTipo: 'test85', sectionTipo: 'test3', sectionId: 5, lang: null },
			pathOpts,
			{},
		);
		const covers = (entries: typeof withCover): string[] =>
			entries.filter((entry) => entry.extension === 'jpg').map((entry) => entry.quality);
		expect(covers(withCover)).toEqual([pdf.defaultQuality]);
		expect(covers(withoutCover)).toEqual([]);
		// The document itself is unaffected either way — only the cover moved.
		expect(withoutCover.some((entry) => entry.extension === 'pdf')).toBe(true);
	});

	test('a configured alternate is APPENDED after the cover, never before it', () => {
		const configured = scanWithPdfKey('["avif","jpg"]');
		expect(configured.alternates).toEqual(['avif', 'jpg']);
		// The cover extension leads the cover list even when the config names it last.
		expect(configured.covers[0]).toBe('jpg');
		// And the document itself still comes first in the scan of its own tier.
		expect(configured.scanned.filter((entry) => entry.startsWith('web.'))[0]).toBe('web.pdf');
	});

	test('the shipped default is unchanged (Q1: no shipped default was touched)', () => {
		expect(pdf.alternateExtensions).toEqual(['jpg']);
		expect(pdf.coverExtensions).toEqual(['jpg']);
	});
});
