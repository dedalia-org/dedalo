/**
 * INGEST PROPERTIES GATE (audit 2026-08 §5.2, ingest half) — the three ontology
 * properties the upload path used to ignore, and the human filename it used to
 * throw away.
 *
 * 1. `properties.additional_path` — the bucket folder named by a SIBLING
 *    component's value on the record (PHP get_additional_path :753-819). It was
 *    declared on `MediaPathOptions` and resolved by NOBODY, so an install that
 *    uses it wrote and read at the numeric `max_items_folder` bucket instead:
 *    every PHP-era file of such a component (`rsc165` = the oral-history
 *    Certificate of Cession and Questionnaire; `rsc29` = the main image
 *    component) was unreachable from the TS engine.
 * 2. `properties.target_filename` / `properties.target_duration` — the
 *    ontology-declared COMPANION WRITES an upload performs (PHP
 *    component_image:742 / component_av:1113 / component_pdf:322). Nothing wrote
 *    them, so "Original filename" (rsc398) stayed empty and AV "Duration"
 *    (rsc54) read `00:00:00.000` on every TS-ingested interview.
 * 3. The human file name. The receiver returned only its SANITIZED, server-
 *    allocated staged name, so `original_file_name` was persisted as
 *    `Mar_a_Pi_n.mp4` instead of `María Piñón.mp4`. Sanitizing protects the
 *    FILESYSTEM name; it must not be mistaken for the name the archive records.
 * 4. …AND IT HAS TO REACH THE INGEST. The first restoration of (3) wired the name
 *    onto the wire only, and this gate supplied `originalFileName` to
 *    `processUploadedFile` directly — a path NO live caller takes, since none of
 *    the three ingest callers relays `file_data.name`. So the gate was green
 *    while the archive still recorded the staged name. Section (d) drives the
 *    REAL receiver and then calls the ingest exactly as `tool_upload` does, with
 *    no name at all (WC-…-ingest-companions-and-human-filename, delta 4).
 *
 * Scratch discipline: every DB write lands on a record this file creates and
 * deletes, and every media byte lands under a per-pid scratch root.
 */
// MIGRATED OFF THE INSTALL TLDs, 2026-08-19. The three ontology surfaces this
// gate reads (`additional_path`, `target_filename`, `target_duration`) are not in
// the generic `test` TLD — no `test*` media component declares them — so the gate
// now BUILDS the situation it asserts against (`ONTOLOGY`, below), which is what
// the law asks for and is also stronger: the properties are declared HERE, in the
// gate, instead of being borrowed from whatever one install happened to configure.
// The remaining `libx264` token is the ffmpeg H.264 encoder, not a tipo.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import {
	readCompanionTargets,
	resolveMediaCompanionTargets,
} from '../../src/core/media/ingest/companion_writes.ts';
import { processUploadedFile } from '../../src/core/media/ingest/process_uploaded_file.ts';
import { deleteStagedFile, listStagedFiles } from '../../src/core/media/ingest/staged_files.ts';
import {
	readStagedDisplayName,
	STAGED_NAME_DIR,
} from '../../src/core/media/ingest/staged_name_record.ts';
import {
	STAGING_ORPHAN_TTL_MS,
	sweepStagedOrphans,
} from '../../src/core/media/ingest/staging_gc.ts';
import {
	displayFileName,
	joinChunkedUpload,
	type ParsedUpload,
	receiveUpload,
} from '../../src/core/media/ingest/upload.ts';
import {
	completeMediaPathOptions,
	normalizeAdditionalPath,
	resolveMediaPathOptions,
	SECTION_SCOPED_PATH_OPTION_CALLERS,
} from '../../src/core/media/ontology_path.ts';
import { buildMediaLocation, type MediaIdentity } from '../../src/core/media/path.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { readComponentItems } from '../../src/core/resolve/component_data.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { handleRequest } from '../../src/server.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('ingest_props');
const USER_ID = -1;
/**
 * The two wire-door cases go through the real HTTP route, which takes NO media
 * root override, so they stage into the CONFIGURED tree. They are confined to
 * their own user id and key_dirs — no other test in the repo stages under user 9
 * — and both are torn down before and after that describe block.
 */
const WIRE_USER = 9;
const WIRE_KEY_DIRS = ['kd_wire_single', 'kd_wire_chunk'];
const REQUEST_CONTEXT = { requestId: 'ingest-props-gate', startedAt: 0 };
const HAVE_FFMPEG = Bun.which(config.media.binaries.ffmpeg) !== null;
const image = mediaTypeOf('component_image');
if (image === null) throw new Error('component_image spec missing');

/**
 * THE SITUATION THIS GATE ASSERTS AGAINST — the three properties, declared here.
 *
 * The audit found them on ONE install's ontology (an image component declaring
 * `additional_path` + `target_filename`, an av component declaring both companion
 * properties). Binding to that install made the gate green on one machine only,
 * so the shape is rebuilt instead: two scratch sections on `matrix_test`, an image
 * component that declares an additional_path sibling and a filename target, and an
 * av component that declares the filename + duration targets and NO additional_path
 * (the null branch needs a component that genuinely lacks the property).
 *
 * The filename target is deliberately ONE component shared by both media
 * components — that is the install shape the audit describes, and it is what makes
 * `resolveMediaCompanionTargets(IMAGE_COMPONENT).filenameTipo` equal the av one.
 */
const IMAGE_SECTION = 'zzmip1';
const IMAGE_COMPONENT = 'zzmip3';
const IMAGE_ADDITIONAL_PATH_SIBLING = 'zzmip4';
const AV_SECTION = 'zzmip10';
const AV_COMPONENT = 'zzmip12';
const AV_FILENAME_TARGET = 'zzmip5';
const AV_DURATION_TARGET = 'zzmip14';

const ONTOLOGY = situation({
	name: 'ingest companion properties',
	tld: 'zzmip',
	nodes: [
		// --- the image section: additional_path + target_filename ---------------
		{
			tipo: IMAGE_SECTION,
			parent: 'test1',
			model: 'section',
			order_number: 90,
			term: { 'lg-eng': 'Ingest properties — image section' },
			// matrix_test: the suite's write surface, resolved exactly as the engine does.
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzmip2', parent: IMAGE_SECTION, model: 'section_group', order_number: 1 },
		{
			tipo: IMAGE_COMPONENT,
			parent: 'zzmip2',
			model: 'component_image',
			order_number: 1,
			properties: {
				max_items_folder: 1000,
				additional_path: IMAGE_ADDITIONAL_PATH_SIBLING,
				target_filename: AV_FILENAME_TARGET,
			},
		},
		{
			tipo: IMAGE_ADDITIONAL_PATH_SIBLING,
			parent: 'zzmip2',
			model: 'component_input_text',
			order_number: 2,
			term: { 'lg-eng': 'Bucket folder (additional_path sibling)' },
		},
		{
			tipo: AV_FILENAME_TARGET,
			parent: 'zzmip2',
			model: 'component_input_text',
			order_number: 3,
			term: { 'lg-eng': 'Original filename' },
		},
		// --- the av section: both companions, NO additional_path -----------------
		{
			tipo: AV_SECTION,
			parent: 'test1',
			model: 'section',
			order_number: 91,
			term: { 'lg-eng': 'Ingest properties — av section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: 'zzmip11', parent: AV_SECTION, model: 'section_group', order_number: 1 },
		{
			tipo: AV_COMPONENT,
			parent: 'zzmip11',
			model: 'component_av',
			order_number: 1,
			properties: {
				target_filename: AV_FILENAME_TARGET,
				target_duration: AV_DURATION_TARGET,
			},
		},
		{
			tipo: AV_DURATION_TARGET,
			parent: 'zzmip11',
			model: 'component_input_text',
			order_number: 2,
			term: { 'lg-eng': 'Duration' },
		},
	],
	// Record 1 of the av section: the "no additional_path property" case resolves
	// the options of a REAL record, as the original did against the install's row 1.
	records: [{ section_tipo: AV_SECTION, section_id: 1 }],
});

/** Records this file creates, torn down (row + TM snapshot) in afterAll. */
const scratch: { sectionTipo: string; sectionId: number }[] = [];
async function scratchRecord(sectionTipo: string): Promise<number> {
	const sectionId = await createSectionRecord(sectionTipo, USER_ID);
	scratch.push({ sectionTipo, sectionId });
	return sectionId;
}

/** The stored flat value of an input_text component on a record ('' when none). */
async function storedValue(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
): Promise<string> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return '';
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	if (record === null) return '';
	const model = await getModelByTipo(componentTipo);
	if (model === null) return '';
	const items = (readComponentItems(record, componentTipo, model) ?? []) as { value?: unknown }[];
	return items.map((item) => String(item.value ?? '')).join('');
}

async function setValue(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
	value: string,
): Promise<void> {
	const result = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value: [{ value, lang: 'lg-nolan' }] }],
		userId: USER_ID,
	});
	if (!result.ok) throw new Error(`setValue ${componentTipo}: ${result.message}`);
}

/** Stage a real tiny 1-second mp4 under the scratch upload dir. */
async function stageVideo(keyDir: string, tmpName: string): Promise<void> {
	const dir = stagingDir(USER_ID, keyDir, ROOT);
	mkdirSync(dir, { recursive: true });
	await runBinary(
		[
			config.media.binaries.ffmpeg,
			'-y',
			'-f',
			'lavfi',
			'-i',
			'testsrc=duration=1:size=160x120:rate=10',
			'-f',
			'lavfi',
			'-i',
			'anullsrc=r=44100:cl=stereo',
			'-t',
			'1',
			'-c:v',
			'libx264',
			'-pix_fmt',
			'yuv420p',
			'-c:a',
			'aac',
			'-shortest',
			`${dir}/${tmpName}`,
		],
		{ nice: false },
	);
}

/** Every .ts file under a directory, repo-relative (the scanner's file set). */
function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...tsFilesUnder(path));
		else if (entry.name.endsWith('.ts')) out.push(path);
	}
	return out;
}

/**
 * A minimal but STRUCTURALLY VALID jpeg: SOI + APP0/JFIF + padding + EOI. The
 * receiver sniffs the magic bytes and then verifies the container has its
 * terminator (engine/verify_content.ts), so a header-only stub is refused — as
 * it should be.
 */
function jpegBytes(padding = 32): Uint8Array {
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x10,
		0x4a,
		0x46,
		0x49,
		0x46,
		0x00,
		0x01,
		0x01,
		0x00,
		0x00,
		0x01,
		0x00,
		0x01,
		0x00,
		0x00,
		...new Array<number>(padding).fill(0x00),
		0xff,
		0xd9,
	]);
}

beforeAll(async () => {
	await ensureSituation(ONTOLOGY);
	rmSync(ROOT, { recursive: true, force: true });
	// DECLARE the scratch root (the media doors refuse an unmarked one under the
	// test-media seam — src/core/media/test_media_root.ts).
	markMediaRoot(ROOT);
	mkdirSync(ROOT, { recursive: true });
});

afterAll(async () => {
	const failures: string[] = [];
	for (const { sectionTipo, sectionId } of scratch) {
		try {
			const outcome = await deleteSectionRecord(sectionTipo, sectionId, USER_ID);
			if (outcome.removed !== true) {
				failures.push(`${sectionTipo}/${sectionId}: ${JSON.stringify(outcome)}`);
			}
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[sectionTipo, sectionId],
			);
		} catch (error) {
			failures.push(`${sectionTipo}/${sectionId}: ${(error as Error).message}`);
		}
	}
	rmSync(ROOT, { recursive: true, force: true });
	// The situation's own sweep is asserted, not trusted: 0 = no node and no record
	// of this gate survives it.
	expect(await dropSituation(ONTOLOGY)).toBe(0);
	if (failures.length > 0) {
		throw new Error(`scratch records left behind: ${failures.join(' | ')}`);
	}
});

// ---------------------------------------------------------------------------
// (a) properties.additional_path
// ---------------------------------------------------------------------------

describe('additional_path: PHP get_additional_path normalisation', () => {
	test('forces a leading slash and strips a trailing one', () => {
		expect(normalizeAdditionalPath('cession')).toBe('/cession');
		expect(normalizeAdditionalPath('/cession')).toBe('/cession');
		expect(normalizeAdditionalPath('cession/')).toBe('/cession');
		expect(normalizeAdditionalPath('  cession  ')).toBe('/cession');
	});

	test('an empty (or bare-slash) value means "no named bucket" — the caller falls back', () => {
		expect(normalizeAdditionalPath('')).toBe('');
		expect(normalizeAdditionalPath('   ')).toBe('');
		expect(normalizeAdditionalPath('/')).toBe('');
	});

	test('a multi-segment value is KEPT (PHP capability), an escaping one is refused', () => {
		expect(normalizeAdditionalPath('oh/cession')).toBe('/oh/cession');
		expect(() => normalizeAdditionalPath('../../etc')).toThrow(/escapes/);
		expect(() => normalizeAdditionalPath('a/../b')).toThrow(/escapes/);
		expect(() => normalizeAdditionalPath('a\0b')).toThrow(/NUL/);
	});
});

describe('additional_path: resolved from the record, not invented', () => {
	test('the section-scoped form leaves the override UNRESOLVED (never a fabricated null)', async () => {
		const options = await resolveMediaPathOptions(IMAGE_COMPONENT, IMAGE_SECTION);
		expect(options.additionalPathOverride).toBeUndefined();
		expect(options.maxItemsFolder).toBe(1000);
	});

	test('the record-scoped form resolves the sibling value into the media path', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		await setValue(IMAGE_SECTION, sectionId, IMAGE_ADDITIONAL_PATH_SIBLING, 'cession_files');
		const options = await resolveMediaPathOptions(IMAGE_COMPONENT, IMAGE_SECTION, sectionId);
		expect(options.additionalPathOverride).toBe('/cession_files');
		const identity: MediaIdentity = {
			componentTipo: IMAGE_COMPONENT,
			sectionTipo: IMAGE_SECTION,
			sectionId,
			lang: null,
		};
		const location = buildMediaLocation(image, identity, '1.5MB', 'jpg', {
			...options,
			mediaRoot: ROOT,
		});
		expect(location.relativePath).toBe(
			`/image/1.5MB/cession_files/${IMAGE_COMPONENT}_${IMAGE_SECTION}_${sectionId}.jpg`,
		);
	});

	test('an EMPTY sibling falls through to the max_items_folder bucket (PHP empty() branch)', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		const options = await resolveMediaPathOptions(IMAGE_COMPONENT, IMAGE_SECTION, sectionId);
		expect(options.additionalPathOverride).toBe('');
		const identity: MediaIdentity = {
			componentTipo: IMAGE_COMPONENT,
			sectionTipo: IMAGE_SECTION,
			sectionId,
			lang: null,
		};
		const bucket = 1000 * Math.floor(sectionId / 1000);
		expect(
			buildMediaLocation(image, identity, '1.5MB', 'jpg', { ...options, mediaRoot: ROOT })
				.relativePath,
		).toBe(`/image/1.5MB/${bucket}/${IMAGE_COMPONENT}_${IMAGE_SECTION}_${sectionId}.jpg`);
	});

	test('a component with NO additional_path property resolves to null, not ""', async () => {
		const options = await resolveMediaPathOptions(AV_COMPONENT, AV_SECTION, 1);
		expect(options.additionalPathOverride).toBeNull();
	});

	test('completeMediaPathOptions fills an unresolved override and never overrides a resolved one', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		await setValue(IMAGE_SECTION, sectionId, IMAGE_ADDITIONAL_PATH_SIBLING, 'later');
		const identity: MediaIdentity = {
			componentTipo: IMAGE_COMPONENT,
			sectionTipo: IMAGE_SECTION,
			sectionId,
			lang: null,
		};
		const filled = await completeMediaPathOptions(identity, {
			initialMediaPath: '',
			maxItemsFolder: 1000,
		});
		expect(filled.additionalPathOverride).toBe('/later');
		const kept = await completeMediaPathOptions(identity, {
			initialMediaPath: '',
			maxItemsFolder: 1000,
			additionalPathOverride: '/decided_by_caller',
		});
		expect(kept.additionalPathOverride).toBe('/decided_by_caller');
	});
});

describe('additional_path: the INGEST writes into the named bucket', () => {
	test('an ingest handed section-scoped options still lands in the sibling folder', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		await setValue(IMAGE_SECTION, sectionId, IMAGE_ADDITIONAL_PATH_SIBLING, 'cession_files');
		const dir = stagingDir(USER_ID, 'kd_bucket', ROOT);
		mkdirSync(dir, { recursive: true });
		await Bun.write(`${dir}/staged.jpg`, jpegBytes());
		// EXACTLY what tool_upload hands in today (resolveMediaToolContext resolves
		// the SECTION-scoped options): no additionalPathOverride at all. The ingest
		// must complete it from the record, or the file lands in the numeric bucket
		// and every PHP-era file of this component stays unreachable.
		const sectionScoped = await resolveMediaPathOptions(IMAGE_COMPONENT, IMAGE_SECTION);
		const result = await processUploadedFile({
			spec: image,
			identity: {
				componentTipo: IMAGE_COMPONENT,
				sectionTipo: IMAGE_SECTION,
				sectionId,
				lang: null,
			},
			pathOpts: { ...sectionScoped, mediaRoot: ROOT },
			userId: USER_ID,
			keyDir: 'kd_bucket',
			tmpName: 'staged.jpg',
			extension: 'jpg',
			originalFileName: 'Certificado de cesión.jpg',
		});
		expect(result.humanFileName).toBe('Certificado de cesión.jpg');
		expect(
			existsSync(
				`${ROOT}/image/original/cession_files/${IMAGE_COMPONENT}_${IMAGE_SECTION}_${sectionId}.jpg`,
			),
		).toBe(true);
		const bucket = 1000 * Math.floor(sectionId / 1000);
		expect(
			existsSync(
				`${ROOT}/image/original/${bucket}/${IMAGE_COMPONENT}_${IMAGE_SECTION}_${sectionId}.jpg`,
			),
		).toBe(false);
		// The companion the image component declares (target_filename) is
		// written by the same ingest, off the property — not per model.
		expect(await storedValue(IMAGE_SECTION, sectionId, AV_FILENAME_TARGET)).toBe(
			'Certificado de cesión.jpg',
		);
	}, 120_000);
});

describe('additional_path: the section-scoped call sites are a NAMED, shrink-only list', () => {
	test('every two-argument resolveMediaPathOptions call site is declared with a reason', async () => {
		const files = tsFilesUnder('src').filter((file) => file !== 'src/core/media/ontology_path.ts');
		const sectionScoped: string[] = [];
		for (const file of files) {
			const source = await Bun.file(file).text();
			if (!source.includes('resolveMediaPathOptions')) continue;
			// Only real CODE counts: naming the symbol in a comment or an import
			// binding is not calling it, and a doc comment that explains the two
			// scopes must not enrol its own file in the list.
			const body = source
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.split('\n')
				.filter((line) => !/^\s*(\/\/|import\b|\}?\s*from ')/.test(line))
				.filter((line) => !/^\s*resolveMediaPathOptions,?\s*$/.test(line))
				.join('\n');
			for (const match of body.matchAll(/resolveMediaPathOptions\s*(\(([^)]*)\))?/g)) {
				if (match[1] === undefined) {
					// A BARE REFERENCE (passed as a callback): the seam's own signature
					// decides the scope, and today every such seam is the two-argument one.
					sectionScoped.push(file);
					continue;
				}
				const args = (match[2] ?? '').split(',').filter((arg) => arg.trim() !== '');
				if (args.length === 2) sectionScoped.push(file);
			}
		}
		const declared = SECTION_SCOPED_PATH_OPTION_CALLERS.map((entry) => entry.file);
		expect([...new Set(sectionScoped)].sort()).toEqual([...new Set(declared)].sort());
		for (const entry of SECTION_SCOPED_PATH_OPTION_CALLERS) {
			expect(entry.reason.length).toBeGreaterThan(10);
		}
	});
});

// ---------------------------------------------------------------------------
// (b) properties.target_filename / properties.target_duration
// ---------------------------------------------------------------------------

describe('companion targets are read GENERICALLY off the properties', () => {
	test('the extraction is a property read, not a per-model special case', () => {
		expect(
			readCompanionTargets({
				target_filename: AV_FILENAME_TARGET,
				target_duration: AV_DURATION_TARGET,
			}),
		).toEqual({ filenameTipo: AV_FILENAME_TARGET, durationTipo: AV_DURATION_TARGET });
		expect(readCompanionTargets({})).toEqual({ filenameTipo: null, durationTipo: null });
		expect(readCompanionTargets({ target_filename: '', target_duration: 7 })).toEqual({
			filenameTipo: null,
			durationTipo: null,
		});
	});

	test('the live ontology declares them where the audit says it does', async () => {
		expect(await resolveMediaCompanionTargets(AV_COMPONENT)).toEqual({
			filenameTipo: AV_FILENAME_TARGET,
			durationTipo: AV_DURATION_TARGET,
		});
		expect(await resolveMediaCompanionTargets(IMAGE_COMPONENT)).toEqual({
			filenameTipo: AV_FILENAME_TARGET,
			durationTipo: null,
		});
		expect(await resolveMediaCompanionTargets('test94')).toEqual({
			filenameTipo: null,
			durationTipo: null,
		});
	});
});

describe('an AV ingest populates the ontology-declared companions', () => {
	test.if(HAVE_FFMPEG)(
		'target_filename gets the HUMAN name and target_duration a real time code',
		async () => {
			const av = mediaTypeOf('component_av');
			if (av === null) throw new Error('component_av spec missing');
			const sectionId = await scratchRecord(AV_SECTION);
			await stageVideo('kd_av', 'staged_upload.mp4');
			const identity: MediaIdentity = {
				componentTipo: AV_COMPONENT,
				sectionTipo: AV_SECTION,
				sectionId,
				lang: null,
			};
			const pathOpts = await resolveMediaPathOptions(AV_COMPONENT, AV_SECTION, sectionId);
			const result = await processUploadedFile({
				spec: av,
				identity,
				pathOpts: { ...pathOpts, mediaRoot: ROOT },
				userId: USER_ID,
				keyDir: 'kd_av',
				tmpName: 'staged_upload.mp4',
				extension: 'mp4',
				originalFileName: 'María Piñón entrevista.mp4',
			});
			expect(result.humanFileName).toBe('María Piñón entrevista.mp4');
			expect(await storedValue(AV_SECTION, sectionId, AV_FILENAME_TARGET)).toBe(
				'María Piñón entrevista.mp4',
			);
			// 1 s of testsrc — the point is that it is NOT the 00:00:00.000 the
			// oh media-icons widget showed on every TS-ingested interview.
			const duration = await storedValue(AV_SECTION, sectionId, AV_DURATION_TARGET);
			expect(duration).toMatch(/^00:00:0[01]\.\d{3}$/);
			expect(duration).not.toBe('00:00:00.000');
		},
		120_000,
	);
});

// ---------------------------------------------------------------------------
// (c) the human file name survives the upload
// ---------------------------------------------------------------------------

describe('the receiver carries the human file name beside the staged one', () => {
	const parsed = (over: Partial<ParsedUpload>): ParsedUpload => ({
		keyDir: 'kd_name',
		fileName: 'María Piñón.jpg',
		chunked: false,
		chunkIndex: 0,
		totalChunks: 1,
		blob: jpegBytes(),
		uploadId: null,
		csrfToken: null,
		...over,
	});

	test('displayFileName defangs without transliterating', () => {
		expect(displayFileName('María Piñón.jpg')).toBe('María Piñón.jpg');
		expect(displayFileName('/etc/passwd')).toBe('passwd');
		expect(displayFileName('a\\b\\c.jpg')).toBe('c.jpg');
		expect(displayFileName('bad\u0000name\u0007.jpg')).toBe('badname.jpg');
		expect(displayFileName('   ')).toBe('upload.bin');
		expect(displayFileName(`${'x'.repeat(400)}.jpg`).length).toBeLessThanOrEqual(255);
	});

	test('single-shot: name is the human one, tmp_name the sanitized staged one', () => {
		const received = receiveUpload(parsed({}), USER_ID, ROOT);
		expect(received.complete).toBe(true);
		expect(received.name).toBe('María Piñón.jpg');
		// The FILESYSTEM name is still protected — a different concern, not the same value.
		expect(received.tmpName).toMatch(/^Mar_a_Pi_?_?n\.jpg$/);
		expect(received.tmpName).not.toBe(received.name);
	});

	test('chunked: the join reports the name the SERVER recorded, not the relayed hint', async () => {
		const head = jpegBytes(8).slice(0, 20);
		const tail = jpegBytes(8).slice(20);
		const uploadId = 'chunkednamecarry01';
		for (let index = 0; index < 2; index++) {
			receiveUpload(
				parsed({
					keyDir: 'kd_join',
					chunked: true,
					chunkIndex: index,
					totalChunks: 2,
					uploadId,
					blob: index === 0 ? head : tail,
				}),
				USER_ID,
				ROOT,
			);
		}
		const joined = await joinChunkedUpload({
			keyDir: 'kd_join',
			// A client hint that is NOT the human name — the join must not use it.
			tmpName: 'Mar_a_Pi_n.jpg',
			totalChunks: 2,
			userId: USER_ID,
			uploadId,
			mediaRoot: ROOT,
		});
		expect(joined.complete).toBe(true);
		expect(joined.name).toBe('María Piñón.jpg');
	});

	/**
	 * BOTH WIRE DOORS, BEHAVIOURALLY — through `handleRequest`, the real route.
	 *
	 * This replaces a source-regex assertion (`/name:\s*received\.name/`). A regex
	 * is not a gate: it stays green if the key is emitted but always null, and it
	 * reddens spuriously when somebody renames a local. What the client contract
	 * actually says is that a POST of 'María Piñón.jpg' comes back with that name
	 * in `file_data.name` on BOTH completion paths, while `tmp_name` stays a
	 * filesystem-safe segment — the two names, separated, on the wire.
	 *
	 * These two cases are the only ones in this file that touch the CONFIGURED
	 * media root (the endpoint takes no root override — that is what makes it an
	 * end-to-end gate, and it is the same trade `media_upload_endpoint.test.ts`
	 * makes). Their key_dirs are torn down before and after, and they are the only
	 * user of WIRE_USER, so nothing else in the tree is touched.
	 */
	describe('both wire doors, through the real HTTP route', () => {
		// The WHOLE user dir, not just the key_dirs: WIRE_USER is this file's alone,
		// so leaving an empty `tmp/9/` behind in the configured tree is residue.
		const clearWireStaging = (): void => {
			rmSync(dirname(stagingDir(WIRE_USER, WIRE_KEY_DIRS[0] as string)), {
				recursive: true,
				force: true,
			});
		};
		beforeAll(clearWireStaging);
		afterAll(clearWireStaging);

		const HUMAN = 'María Piñón.jpg';
		const API_URL = 'http://localhost/dedalo/core/api/v1/json/';
		/** A staged segment is filesystem-safe by construction (sanitizeSegment's charset). */
		const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

		const session = () => {
			const token = createSession(WIRE_USER, 'ingest-props-gate', false);
			const found = getSession(token);
			if (found === null) throw new Error('session not minted');
			return { cookie: `dedalo_ts_session=${token}`, csrf: found.csrfToken };
		};

		test('DOOR 1 (single-shot POST): file_data.name is the curator name', async () => {
			const s = session();
			const form = new FormData();
			form.set('key_dir', WIRE_KEY_DIRS[0] as string);
			form.set('file_name', HUMAN);
			form.set('chunked', 'false');
			form.set(
				'file_to_upload',
				new Blob([jpegBytes() as BlobPart], { type: 'image/jpeg' }),
				HUMAN,
			);
			const response = await handleRequest(
				new Request(API_URL, {
					method: 'POST',
					body: form,
					headers: { Cookie: s.cookie, 'x-dedalo-csrf-token': s.csrf },
				}),
				REQUEST_CONTEXT,
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as { file_data: Record<string, unknown> };
			expect(body.file_data.name).toBe(HUMAN);
			// …and the FILESYSTEM name is a different, sanitized value.
			expect(body.file_data.tmp_name).not.toBe(HUMAN);
			expect(String(body.file_data.tmp_name)).toMatch(SAFE_SEGMENT);
		});

		test('DOOR 2 (join_chunked_files_uploaded): the name survives the join', async () => {
			const s = session();
			const keyDir = WIRE_KEY_DIRS[1] as string;
			const form = new FormData();
			form.set('key_dir', keyDir);
			form.set('file_name', HUMAN);
			form.set('chunked', 'true');
			form.set('chunk_index', '0');
			form.set('total_chunks', '1');
			form.set(
				'file_to_upload',
				new Blob([jpegBytes() as BlobPart], { type: 'image/jpeg' }),
				HUMAN,
			);
			const chunk = await handleRequest(
				new Request(API_URL, {
					method: 'POST',
					body: form,
					headers: { Cookie: s.cookie, 'x-dedalo-csrf-token': s.csrf },
				}),
				REQUEST_CONTEXT,
			);
			expect(chunk.status).toBe(200);
			const chunkBody = (await chunk.json()) as { file_data: Record<string, unknown> };
			const joinResponse = await handleRequest(
				new Request(API_URL, {
					method: 'POST',
					body: JSON.stringify({
						dd_api: 'dd_utils_api',
						action: 'join_chunked_files_uploaded',
						options: {
							// The client relays the LAST chunk's file_data verbatim — so a
							// MISLEADING name is exactly what a hostile or stale client sends.
							// The join answers from the server's own per-transfer meta.
							file_data: { ...chunkBody.file_data, name: 'attacker-supplied.jpg' },
							files_chunked: [chunkBody.file_data.tmp_name],
						},
					}),
					headers: {
						'Content-Type': 'application/json',
						Cookie: s.cookie,
						'x-dedalo-csrf-token': s.csrf,
					},
				}),
				REQUEST_CONTEXT,
			);
			expect(joinResponse.status).toBe(200);
			const joinBody = (await joinResponse.json()) as {
				data: boolean;
				file_data: Record<string, unknown>;
			};
			expect(joinBody.data).toBe(true);
			expect(joinBody.file_data.name).toBe(HUMAN);
			expect(String(joinBody.file_data.tmp_name)).toMatch(SAFE_SEGMENT);
		});
	});
});

// ---------------------------------------------------------------------------
// (d) the human file name reaches the ARCHIVE — with no caller cooperation
//
// The wire keys above are for the CLIENT. The ingest runs in a LATER request and
// is handed only `tmp_name`; as of 2026-08-09 NONE of the three ingest callers
// (tool_upload, tool_import_files, the MCP media tool) relays `file_data.name`
// into it, so a restoration wired only at the transport was dead code and the
// archive still recorded 'Mar_a_Pi_n.jpg'. The receiver therefore persists the
// display name beside the staged file (staged_name_record.ts) and the ingest
// reads it back.
//
// EVERY TEST BELOW GOES THROUGH THE REAL DOOR — receiveUpload / joinChunkedUpload
// stage the bytes, and processUploadedFile is called with EXACTLY the arguments
// tool_upload passes today (no originalFileName). Unwiring any one of the three
// links (record at door 1, record at door 2, read in the ingest) reddens them.
// ---------------------------------------------------------------------------

describe('the ingest recovers the curator file name with NO caller cooperation', () => {
	/** The ingest arguments tool_upload builds today: file_data keys, nothing else. */
	const ingestAsToolUploadDoes = async (
		sectionId: number,
		keyDir: string,
		tmpName: string,
		extra: { originalFileName?: string } = {},
	) => {
		const sectionScoped = await resolveMediaPathOptions(IMAGE_COMPONENT, IMAGE_SECTION);
		return processUploadedFile({
			spec: image,
			identity: {
				componentTipo: IMAGE_COMPONENT,
				sectionTipo: IMAGE_SECTION,
				sectionId,
				lang: null,
			},
			pathOpts: { ...sectionScoped, mediaRoot: ROOT },
			userId: USER_ID,
			keyDir,
			tmpName,
			extension: 'jpg',
			...extra,
		});
	};

	const parsedFor = (keyDir: string, over: Partial<ParsedUpload> = {}): ParsedUpload => ({
		keyDir,
		fileName: 'María Piñón.jpg',
		chunked: false,
		chunkIndex: 0,
		totalChunks: 1,
		blob: jpegBytes(),
		uploadId: null,
		csrfToken: null,
		...over,
	});

	test('DOOR 1 (single-shot): the archive records the curator name, not the staged one', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		const received = receiveUpload(parsedFor('kd_door1'), USER_ID, ROOT);
		expect(received.complete).toBe(true);
		const tmpName = received.tmpName as string;
		// The staged segment IS lossy — that is the whole point of the two names.
		expect(tmpName).not.toBe('María Piñón.jpg');

		const result = await ingestAsToolUploadDoes(sectionId, 'kd_door1', tmpName);
		expect(result.humanFileName).toBe('María Piñón.jpg');
		// And it lands in the record, through the ontology-declared companion.
		expect(await storedValue(IMAGE_SECTION, sectionId, AV_FILENAME_TARGET)).toBe('María Piñón.jpg');
	}, 120_000);

	test('DOOR 2 (chunked join): same, for every file over the chunk threshold', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		const bytes = jpegBytes(8);
		const uploadId = 'joindoornamecarry1';
		for (let index = 0; index < 2; index++) {
			receiveUpload(
				parsedFor('kd_door2', {
					chunked: true,
					chunkIndex: index,
					totalChunks: 2,
					uploadId,
					blob: index === 0 ? bytes.slice(0, 20) : bytes.slice(20),
				}),
				USER_ID,
				ROOT,
			);
		}
		const joined = await joinChunkedUpload({
			keyDir: 'kd_door2',
			tmpName: 'Mar_a_Pi_n.jpg',
			totalChunks: 2,
			userId: USER_ID,
			uploadId,
			mediaRoot: ROOT,
		});
		const tmpName = joined.tmpName as string;
		const result = await ingestAsToolUploadDoes(sectionId, 'kd_door2', tmpName);
		expect(result.humanFileName).toBe('María Piñón.jpg');
		expect(await storedValue(IMAGE_SECTION, sectionId, AV_FILENAME_TARGET)).toBe('María Piñón.jpg');
	}, 120_000);

	test('an EXPLICIT caller name still outranks the server record (tool_import_files)', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		const received = receiveUpload(parsedFor('kd_rank'), USER_ID, ROOT);
		const result = await ingestAsToolUploadDoes(sectionId, 'kd_rank', received.tmpName as string, {
			originalFileName: 'Entrevista 1974 — cinta A.jpg',
		});
		expect(result.humanFileName).toBe('Entrevista 1974 — cinta A.jpg');
	}, 120_000);

	test('a staged file the server has NO record of falls back to the staged name', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		// A file dropped into the staging area out of band (a batch drop, a transfer
		// staged by a server older than the record): the old, lossy behaviour is the
		// honest answer, and it must stay non-throwing.
		const dir = stagingDir(USER_ID, 'kd_norecord', ROOT);
		mkdirSync(dir, { recursive: true });
		await Bun.write(`${dir}/dropped_in.jpg`, jpegBytes());
		const result = await ingestAsToolUploadDoes(sectionId, 'kd_norecord', 'dropped_in.jpg');
		expect(result.humanFileName).toBe('dropped_in.jpg');
	}, 120_000);

	test('the name record is consumed by the ingest and never shown as a staged file', async () => {
		const sectionId = await scratchRecord(IMAGE_SECTION);
		const received = receiveUpload(parsedFor('kd_residue'), USER_ID, ROOT);
		const tmpName = received.tmpName as string;
		const dir = stagingDir(USER_ID, 'kd_residue', ROOT);
		// Recorded while the file is staged...
		expect(readStagedDisplayName(dir, tmpName)).toBe('María Piñón.jpg');
		// ...and never offered to the client as a file of its own.
		const listed = listStagedFiles(USER_ID, 'kd_residue', ROOT).map((entry) => entry.name);
		expect(listed).toEqual([tmpName]);

		await ingestAsToolUploadDoes(sectionId, 'kd_residue', tmpName);
		// The staged file is gone, so its record must be too — no residue.
		expect(readStagedDisplayName(dir, tmpName)).toBeNull();
		expect(existsSync(`${dir}/${STAGED_NAME_DIR}/${tmpName}`)).toBe(false);
	}, 120_000);

	test('deleting a staged row drops its name record with the file', () => {
		const received = receiveUpload(parsedFor('kd_delete'), USER_ID, ROOT);
		const tmpName = received.tmpName as string;
		const dir = stagingDir(USER_ID, 'kd_delete', ROOT);
		expect(readStagedDisplayName(dir, tmpName)).toBe('María Piñón.jpg');
		expect(deleteStagedFile(USER_ID, 'kd_delete', tmpName, ROOT)).toBe(true);
		expect(readStagedDisplayName(dir, tmpName)).toBeNull();
	});

	test('the STAGING SWEEPER collects an orphaned record and never a live one', () => {
		const received = receiveUpload(parsedFor('kd_sweep'), USER_ID, ROOT);
		const tmpName = received.tmpName as string;
		const dir = stagingDir(USER_ID, 'kd_sweep', ROOT);
		const future = Date.now() + 10 * STAGING_ORPHAN_TTL_MS;
		// Driven through sweepStagedOrphans, not the helper: the invariant is that
		// the staging GC actually collects these, and a test on the helper alone
		// would stay green with the sweeper's call to it removed.
		//
		// Live: the staged file is there, so no age makes its record collectable.
		expect(sweepStagedOrphans(USER_ID, 'kd_sweep', ROOT, future)).toBe(0);
		expect(readStagedDisplayName(dir, tmpName)).toBe('María Piñón.jpg');
		// Orphaned but YOUNG: still kept (a record can precede its own file).
		rmSync(`${dir}/${tmpName}`, { force: true });
		expect(sweepStagedOrphans(USER_ID, 'kd_sweep', ROOT, Date.now())).toBe(0);
		expect(readStagedDisplayName(dir, tmpName)).toBe('María Piñón.jpg');
		// Orphaned and past the retention window: collected.
		expect(sweepStagedOrphans(USER_ID, 'kd_sweep', ROOT, future)).toBe(1);
		expect(readStagedDisplayName(dir, tmpName)).toBeNull();
	});

	test('the ingest has ONE door: nothing outside processUploadedFile calls addFile', async () => {
		// The recovery lives at the one chokepoint every upload passes. A second
		// caller of addFile would be a door that bypasses it — and would record the
		// staged name again without any test noticing.
		const callers: string[] = [];
		for (const file of tsFilesUnder('src')) {
			if (file === 'src/core/media/ingest/add_file.ts') continue;
			const source = await Bun.file(file).text();
			if (/(^|[^.\w])addFile\s*\(/m.test(source)) callers.push(file);
		}
		expect(callers).toEqual(['src/core/media/ingest/process_uploaded_file.ts']);
		const ingest = await Bun.file('src/core/media/ingest/process_uploaded_file.ts').text();
		// …and that chokepoint reads the server's record and hands it to addFile.
		expect(ingest).toMatch(/readStagedDisplayName\s*\(/);
		expect(ingest).toMatch(/recordedFileName/);
	});
});

/** Sanity: the scratch root never leaks into the configured media tree. */
test('the gate wrote nothing into the configured media root', () => {
	expect(existsSync(ROOT)).toBe(true);
	expect(ROOT.startsWith(tmpdir())).toBe(true);
});
