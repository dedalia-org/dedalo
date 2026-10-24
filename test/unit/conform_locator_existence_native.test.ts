/**
 * LOCATOR EXISTENCE ACROSS THE ARCHIVE BOUNDARY — every address an archived
 * record stores is accounted for, and a restore refuses to re-point heritage
 * links at nothing (audit 2026-08-26 P1-10; DATA-11).
 *
 * A locator is `{section_tipo, section_id}` and `section_id` is a per-
 * installation counter value: an address that resolved in the source resolves
 * in the destination only by coincidence. The CSV door validates a locator's
 * SHAPE alone. The archive door, gated here, does three things instead:
 *
 *   1. the EXTRACTION censuses every address — each one is an archived record
 *      (internal) or is listed in `manifest.references.external` with whether
 *      the source held it;
 *   2. the RESTORE refuses an address that resolves neither to an archived
 *      record nor to a record the destination holds, unless told to write it
 *      dangling — and then REPORTS it;
 *   3. the artifact's identity is checked before any of that: a manifest whose
 *      ontology digest does not match, an ontology node that exists here with
 *      a different definition, a media file that exists here with different
 *      bytes — each refused, nothing written.
 *
 * CENSUS: TOTAL over the registry's relation-column models (alias-resolved):
 * every one holds a locator in the zzarc situation, floor asserted. The walk
 * is re-done here from the records files with the shared `addressesOf`, so the
 * gate does not trust the manifest's own count.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractArchive } from '../../src/core/archive/extract.ts';
import {
	type ArchiveManifest,
	addressesOf,
	addressKey,
	MANIFEST_FILE,
	readManifest,
} from '../../src/core/archive/manifest.ts';
import { restoreArchive } from '../../src/core/archive/restore.ts';
import { allComponentModels, relationDataModels } from '../../src/core/components/registry.ts';
import { readDdOntologyRow, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { absoluteFromRelative } from '../../src/core/media/path.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { ensureSituation, situation } from '../../src/core/test_data/situations/situation.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { resetMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';
import {
	dropSituation,
	ensureZzarc,
	plantZzarcMedia,
	VALUE_BY_MODEL,
	ZZARC_ARCHIVED_SECTIONS,
	ZZARC_EXTERNAL_DANGLING,
	ZZARC_EXTERNAL_EXISTING,
	ZZARC_MAIN,
	ZZARC_OUTSIDE,
	ZZARC_TLD,
	zzarcSituation,
} from '../helpers/zzarc_archive_situation.ts';

const SCRATCH = scratchDir('archive_locators');
const MEDIA_ROOT = join(SCRATCH, 'media_root');
const ARCHIVE = join(SCRATCH, 'archive');
const s = zzarcSituation();
/** The destination as a SECOND installation would look: it holds the OUTSIDE record, not the set. */
const outsideOnly = situation({
	tld: ZZARC_TLD,
	name: 'zzarc outside-only destination',
	nodes: [
		{ tipo: ZZARC_OUTSIDE, model: 'section' },
		{
			tipo: 'zzarc2001',
			model: 'component_input_text',
			parent: ZZARC_OUTSIDE,
			is_translatable: true,
		},
	],
	records: [
		{
			section_tipo: ZZARC_OUTSIDE,
			section_id: ZZARC_EXTERNAL_EXISTING.section_id,
			columns: { string: { zzarc2001: [{ value: 'outside', lang: 'lg-eng', id: 1 }] } },
		},
	],
});

let manifest: ArchiveManifest;

beforeAll(async () => {
	if (!DB_READY) return;
	rmSync(SCRATCH, { recursive: true, force: true });
	resetMediaRoot(MEDIA_ROOT);
	await dropSituation(s);
	await ensureZzarc(s);
	plantZzarcMedia(MEDIA_ROOT);
	manifest = (
		await extractArchive({
			sectionTipos: [...ZZARC_ARCHIVED_SECTIONS],
			outDir: ARCHIVE,
			mediaRoot: MEDIA_ROOT,
		})
	).manifest;
});

afterAll(async () => {
	if (DB_READY) expect(await dropSituation(s)).toBe(0);
	rmSync(SCRATCH, { recursive: true, force: true });
});

/** Every address stored by the archived records, re-walked from the files. */
function storedAddresses(): { key: string; holder: string }[] {
	const out: { key: string; holder: string }[] = [];
	for (const section of manifest.sections) {
		for (const raw of readFileSync(join(ARCHIVE, section.file), 'utf8').split('\n')) {
			if (raw === '') continue;
			const line = JSON.parse(raw) as {
				section_id: number;
				columns: Record<string, string | null>;
			};
			const parse = (t: string | null) => (t === null ? null : JSON.parse(t));
			for (const address of addressesOf({
				relation: parse(line.columns.relation ?? null),
				relation_search: parse(line.columns.relation_search ?? null),
			})) {
				out.push({
					key: addressKey(address),
					holder: `${section.section_tipo}/${line.section_id}`,
				});
			}
		}
	}
	return out;
}

describe.if(DB_READY)(
	'census — every relation-column model stores a locator in the situation',
	() => {
		test('TOTAL over the registry: relation-column models (alias-resolved) each hold a locator; floor asserted', () => {
			const relationModels = relationDataModels();
			expect(relationModels.length).toBeGreaterThan(15);
			expect(relationModels.length).toBeLessThan(allComponentModels().length);
			for (const model of relationModels) {
				const planted = VALUE_BY_MODEL[model];
				expect(planted, model).toBeDefined();
				expect(planted?.column, model).toBe('relation');
				expect(
					addressesOf({ relation: { [planted?.tipo as string]: planted?.value } }).length,
					model,
				).toBeGreaterThan(0);
			}
		});
	},
);

describe.if(DB_READY)('the extraction accounts for every stored address', () => {
	test('each address is an archived record or is listed as an external reference; the external pair says what the source held', () => {
		const addresses = storedAddresses();
		expect(addresses.length).toBeGreaterThan(15);
		const archived = new Set<string>();
		for (const section of manifest.sections) {
			for (const raw of readFileSync(join(ARCHIVE, section.file), 'utf8').split('\n')) {
				if (raw === '') continue;
				archived.add(
					`${section.section_tipo}/${(JSON.parse(raw) as { section_id: number }).section_id}`,
				);
			}
		}
		const external = new Map(manifest.references.external.map((r) => [addressKey(r), r]));
		const unaccounted = addresses.filter((a) => !archived.has(a.key) && !external.has(a.key));
		expect(unaccounted).toEqual([]);
		expect(manifest.references.internal).toBe(addresses.filter((a) => archived.has(a.key)).length);
		expect([...external.keys()].sort()).toEqual(
			[addressKey(ZZARC_EXTERNAL_EXISTING), addressKey(ZZARC_EXTERNAL_DANGLING)].sort(),
		);
		expect(external.get(addressKey(ZZARC_EXTERNAL_EXISTING))?.exists_in_source).toBe(true);
		expect(external.get(addressKey(ZZARC_EXTERNAL_DANGLING))?.exists_in_source).toBe(false);
		// Positive control: the walk really sees relation_search addresses too —
		// zzarc1/1 holds zzarc10/1 once per relation-column value that names it,
		// PLUS the one raw-planted ancestor-index entry.
		const inRelationColumn = Object.values(VALUE_BY_MODEL).filter(
			(v) =>
				v.column === 'relation' &&
				addressesOf({ relation: { x: v.value } }).some((a) => addressKey(a) === 'zzarc10/1'),
		).length;
		expect(inRelationColumn).toBeGreaterThan(5);
		expect(
			addresses.filter((a) => a.holder === `${ZZARC_MAIN}/1` && a.key === 'zzarc10/1').length,
		).toBe(inRelationColumn + 1);
	});
});

describe.if(DB_READY)(
	'the restore refuses what does not resolve, and reports what it was told to write',
	() => {
		test('into a destination holding the OUTSIDE record: the dangling address is refused; with allowExternal it is written and reported', async () => {
			expect(await dropSituation(s)).toBe(0);
			resetMediaRoot(MEDIA_ROOT);
			await ensureSituation(outsideOnly);
			expect(await getMatrixTableFromTipo(ZZARC_MAIN)).toBeNull();

			let refusal: Error | null = null;
			try {
				await restoreArchive({ archiveDir: ARCHIVE, userId: 1, mediaRoot: MEDIA_ROOT });
			} catch (error) {
				refusal = error as Error;
			}
			expect(refusal?.message).toMatch(/1 stored locator\(s\) resolve neither/);
			expect(refusal?.message).toContain(addressKey(ZZARC_EXTERNAL_DANGLING));
			expect(refusal?.message).toContain('Nothing was written');
			expect(await getMatrixTableFromTipo(ZZARC_MAIN)).toBeNull();

			const outcome = await restoreArchive({
				archiveDir: ARCHIVE,
				userId: 1,
				mediaRoot: MEDIA_ROOT,
				allowExternal: true,
			});
			expect(outcome.locators.resolved_in_destination).toBe(1);
			expect(outcome.locators.dangling).toEqual([ZZARC_EXTERNAL_DANGLING]);
			expect(outcome.locators.internal).toBe(manifest.references.internal);
			// The dangling address was written AS STORED — the archive never rewrites a locator.
			const table = await getMatrixTableFromTipo(ZZARC_MAIN);
			const row = await readMatrixRecord(table as string, ZZARC_MAIN, 1);
			expect(row?.rawText.relation).toContain(
				`"section_id": ${ZZARC_EXTERNAL_DANGLING.section_id}`,
			);
		});

		test('an ontology node that exists here with a DIFFERENT definition is refused, and replaced only on request', async () => {
			const tipo = VALUE_BY_MODEL.component_input_text?.tipo as string;
			const archivedRow = await readDdOntologyRow(tipo);
			await upsertDdOntologyNode({
				...(archivedRow as NonNullable<typeof archivedRow>),
				term: { 'lg-eng': 'DRIFTED' },
			});
			await expect(
				restoreArchive({
					archiveDir: ARCHIVE,
					userId: 1,
					mediaRoot: MEDIA_ROOT,
					allowExternal: true,
					onExistingRecord: 'overwrite',
				}),
			).rejects.toThrow(
				new RegExp(`ontology node '${tipo}' exists in the destination with a different definition`),
			);
			expect((await readDdOntologyRow(tipo))?.term).toEqual({ 'lg-eng': 'DRIFTED' });
			const outcome = await restoreArchive({
				archiveDir: ARCHIVE,
				userId: 1,
				mediaRoot: MEDIA_ROOT,
				allowExternal: true,
				onExistingRecord: 'overwrite',
				onOntologyConflict: 'overwrite',
			});
			expect(outcome.ontology.overwritten).toBe(1);
			expect((await readDdOntologyRow(tipo))?.term).toEqual(
				archivedRow?.term as Record<string, string>,
			);
		});

		test('a media file that exists here with different bytes is refused; the manifest ontology digest is checked', async () => {
			const file = manifest.media.files[0] as { path: string };
			const target = absoluteFromRelative(file.path, MEDIA_ROOT);
			writeFileSync(target, 'not the archived bytes');
			await expect(
				restoreArchive({
					archiveDir: ARCHIVE,
					userId: 1,
					mediaRoot: MEDIA_ROOT,
					allowExternal: true,
					onExistingRecord: 'overwrite',
				}),
			).rejects.toThrow(/media file exists with different bytes/);
			expect(readFileSync(target, 'utf8')).toBe('not the archived bytes'); // untouched by the refusal
			const outcome = await restoreArchive({
				archiveDir: ARCHIVE,
				userId: 1,
				mediaRoot: MEDIA_ROOT,
				allowExternal: true,
				onExistingRecord: 'overwrite',
				onExistingMedia: 'overwrite',
			});
			expect(outcome.media.overwritten).toBe(1);

			const manifestPath = join(ARCHIVE, MANIFEST_FILE);
			const original = readFileSync(manifestPath, 'utf8');
			const tampered = JSON.parse(original) as ArchiveManifest;
			tampered.ontology.digest = '0'.repeat(64);
			writeFileSync(manifestPath, JSON.stringify(tampered));
			try {
				await expect(
					restoreArchive({
						archiveDir: ARCHIVE,
						userId: 1,
						mediaRoot: MEDIA_ROOT,
						allowExternal: true,
						onExistingRecord: 'overwrite',
					}),
				).rejects.toThrow(/ontology digest mismatch/);
			} finally {
				writeFileSync(manifestPath, original);
			}
			expect(readManifest(ARCHIVE).ontology.digest).toBe(manifest.ontology.digest);
		});
	},
);
