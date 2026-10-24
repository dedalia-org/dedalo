/**
 * Phase B differential gate: the files_info SCANNER round-trips REAL stored
 * data. The physical media files are not synced to this dev box (DB only), so
 * we use the STORED `files_info` of the committed corpus (the rsc29 image of an
 * rsc170 record) as the ORACLE:
 * materialize a scratch tree matching each stored entry (size + mtime), scan it
 * with scanFilesInfo, and assert the scan reproduces the stored entries exactly
 * (path grammar, size, dd_date file_time, quality, extension). This proves the
 * scanner reconstructs the byte-compatible index from disk without needing the
 * real media files.
 *
 * The path-options oracle (max_items_folder=1000, no initial_media_path) is
 * resolved from the live ontology — its bucket (e.g. /373000 for id 373733)
 * matches the stored file_path, cross-checking the path builder too.
 */
// GENERIC-TLD MIGRATED 2026-08-19.
// rsc170/rsc29 are SEED-SHIPPED ontology — every installation has them — and
// the records now come from the COMMITTED corpus (`ensureTestCorpus`), never
// from whatever rows the ambient database happens to hold. The scratch tree
// this gate materializes is a DECLARED media root (test/helpers/media_scratch_root.ts):
// without the marker every media door refuses to resolve it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { scanFilesInfo } from '../../src/core/media/files_info.ts';
import { resolveMediaPathOptions } from '../../src/core/media/ontology_path.ts';
import { dropTestCorpus, ensureTestCorpus } from '../../src/core/test_data/test_corpus/ensure.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

/** A SEED-SHIPPED tipo, spelled out of the install-TLD census's token grammar. */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** The seed-shipped media section and its image component. */
const SECTION = seed('rsc', 170);
const IMAGE_COMPONENT = seed('rsc', 29);

/**
 * The scratch tree, DECLARED a media root. `scanFilesInfo` resolves it through
 * the same door production does, and an undeclared root is refused (see
 * test/helpers/media_scratch_root.ts) — the installation's media tree is never
 * reachable from here.
 */
const ROOT = markMediaRoot(scratchDir('media_fi_diff'));
const image = mediaTypeOf('component_image')!;

interface StoredEntry {
	quality: string;
	extension: string;
	file_name: string;
	file_path: string;
	file_size: number;
	file_time: { timestamp: string } & Record<string, number | string>;
	file_exist: boolean;
}

beforeAll(async () => {
	await ensureTestCorpus([SECTION]);
});

afterAll(async () => {
	rmSync(ROOT, { recursive: true, force: true });
	expect(await dropTestCorpus([SECTION])).toBe(0);
});

/** Fetch the corpus image records that carry files_info. */
async function fetchRealMediaRecords(
	limit: number,
): Promise<{ sectionId: number; item: Record<string, unknown> }[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id, media->$1->0 AS item
		 FROM matrix
		 WHERE section_tipo = $2 AND media IS NOT NULL
		   AND media->$1->0->'files_info' IS NOT NULL
		 ORDER BY section_id
		 LIMIT $3`,
		[IMAGE_COMPONENT, SECTION, limit],
	)) as { section_id: number; item: Record<string, unknown> }[];
	return rows.map((r) => ({ sectionId: Number(r.section_id), item: r.item }));
}

/** Materialize each stored files_info entry as a scratch file (size + mtime). */
function materialize(entries: StoredEntry[]): void {
	for (const entry of entries) {
		if (!entry.file_exist || !entry.file_path) continue;
		const abs = `${ROOT}${entry.file_path}`;
		mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
		// Write exactly file_size bytes so the scan reproduces the stored size.
		writeFileSync(abs, Buffer.alloc(entry.file_size, 0x20));
		// Set mtime from the stored dd_date timestamp so the scan reproduces file_time.
		const mtime = new Date(entry.file_time.timestamp.replace(' ', 'T'));
		utimesSync(abs, mtime, mtime);
	}
}

describe('files_info scanner — round-trips real stored data (Phase B oracle)', () => {
	test('scan of a materialized scratch tree reproduces the stored files_info', async () => {
		const records = await fetchRealMediaRecords(5);
		expect(records.length).toBeGreaterThan(0);
		const pathOpts = await resolveMediaPathOptions(IMAGE_COMPONENT, SECTION);
		expect(pathOpts.maxItemsFolder).toBe(1000);

		for (const { sectionId, item } of records) {
			const stored = (item.files_info as StoredEntry[]).filter((e) => e.file_exist);
			if (stored.length === 0) continue;
			materialize(stored);

			const scanned = scanFilesInfo(
				image,
				{ componentTipo: IMAGE_COMPONENT, sectionTipo: SECTION, sectionId, lang: null },
				{ ...pathOpts, mediaRoot: ROOT },
				{
					originalNormalizedName: (item.original_normalized_name as string) ?? null,
					modifiedNormalizedName: (item.modified_normalized_name as string) ?? null,
				},
			);

			// Every stored entry must be reproduced with identical shape.
			for (const s of stored) {
				const match = scanned.find((e) => e.file_path === s.file_path);
				expect(match, `missing scan for ${s.file_path}`).toBeDefined();
				expect(match!.quality).toBe(s.quality);
				expect(match!.extension).toBe(s.extension);
				expect(match!.file_name).toBe(s.file_name);
				expect(match!.file_size).toBe(s.file_size);
				expect(match!.file_exist).toBe(true);
				// dd_date file_time byte-equal (virtual-calendar 'time' included).
				expect(match!.file_time).toEqual(s.file_time as never);
			}
			// No phantom entries: the scan emits exactly the materialized files.
			expect(scanned.length).toBe(stored.length);
		}
	});
});
