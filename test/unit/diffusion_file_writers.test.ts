/**
 * Tabular file writers (csv/json/markdown) + shared file infrastructure —
 * P3 slice-1 gates (DIFFUSION_PLAN P3; DIFFUSION_SPEC §4.3):
 *
 * - csv: RFC4180 quoting matrix (comma/quote/newline/utf8/null), header
 *   order with excludeColumn omitted, streamed temp finalized by atomic
 *   rename (no .tmp-* survivors), same-run removeRecords filtering, the
 *   honest no-write warning, multi-file zip;
 * - json: NDJSON lines parse and carry only plan columns, meta sidecar,
 *   removal line-filter;
 * - markdown: ONE file per section_id grouping every lang, the EXACT
 *   delete-side name grammar (`{section_tipo}_{section_id}.md` — kept in
 *   lockstep with diffusion_delete.ts/PHP get_record_file_path), unlink
 *   idempotency, zip;
 * - shared: abort() leaves no temps, PKZIP structure of created archives,
 *   registry resolution + UnknownDiffusionFormatError;
 * - what survives a POWER CUT (test/helpers/power_loss_model.ts): every record
 *   a checkpoint hands the run ledger (markdown/xml/rdf, written or removed),
 *   every artifact a close publishes (csv/json snapshots, archives, merged
 *   documents) and each consolidation primitive's own output is on disk when
 *   the call returns; a csv/json partial is never unlinked before the snapshot
 *   replacing it is durable.
 *
 * ALL paths live under a per-process temp root injected via the documented
 * DEDALO_DIFFUSION_FILES_ROOT override (files.ts) — the real media tree is
 * NEVER touched.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import * as nodeFs from 'node:fs';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from 'node:fs';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { openZipStream, type ZipStreamWriter } from '../../src/core/files/zip.ts';
import type { FieldPlan, PublicationPlan, SectionPlan } from '../../src/diffusion/plan/types.ts';
import type { ProjectedRow } from '../../src/diffusion/project/lang_ladder.ts';
import { csvField, csvWriter } from '../../src/diffusion/writers/csv.ts';
import {
	addZipFiles,
	atomicWriteFile,
	createZip,
	FullExportFile,
	localCloseContext,
	recordFileName,
} from '../../src/diffusion/writers/files.ts';
import { jsonWriter } from '../../src/diffusion/writers/json.ts';
import { markdownWriter, renderMarkdownRecord } from '../../src/diffusion/writers/markdown.ts';
import { rdfRecordFileName, rdfWriter, writeMergedRdf } from '../../src/diffusion/writers/rdf.ts';
import {
	getDiffusionWriter,
	UnknownDiffusionFormatError,
} from '../../src/diffusion/writers/registry.ts';
import type { WriterSession } from '../../src/diffusion/writers/types.ts';
import { writeMergedXml, xmlWriter } from '../../src/diffusion/writers/xml.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { startPowerLossModel } from '../helpers/power_loss_model.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('ts_diffusion_file_writers');
let savedRoot: string | undefined;

beforeAll(() => {
	savedRoot = process.env.DEDALO_DIFFUSION_FILES_ROOT;
	process.env.DEDALO_DIFFUSION_FILES_ROOT = ROOT;
	// The root producer (published_files.ts) asks the test-media guard for any
	// root it resolves — a scratch root must DECLARE itself one.
	markMediaRoot(ROOT);
	mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
	if (savedRoot !== undefined) process.env.DEDALO_DIFFUSION_FILES_ROOT = savedRoot;
	// assigning undefined would leave the string 'undefined' in process.env
	else delete process.env.DEDALO_DIFFUSION_FILES_ROOT;
	rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

function field(columnName: string, excludeColumn = false): FieldPlan {
	return {
		id: `fwt${columnName}`,
		columnName,
		sourceChain: [],
		transform: [],
		column: { fieldModel: 'field_text' },
		policy: {},
		excludeColumn,
	};
}

function section(tableName: string, sectionTipo: string, fields: FieldPlan[]): SectionPlan {
	return { sectionTipo, tableName, tableTipo: `${sectionTipo}_table`, fields };
}

function plan(format: string, sections: SectionPlan[], serviceName = 'testsvc'): PublicationPlan {
	return {
		planId: `filewriters_test_${format}`,
		elementTipo: 'fwtest1',
		format,
		serviceName,
		target: { kind: 'files', serviceName },
		sections,
		recursion: { maxLevels: 2 },
		langPolicy: { langs: ['lg-eng', 'lg-spa'], mainLang: 'lg-eng' },
		warnings: [],
	};
}

function row(
	sectionId: number | string,
	lang: string | null,
	columns: Record<string, string | null>,
): ProjectedRow {
	return { sectionId, lang, columns };
}

/** No stray temp artifacts under a directory (atomic-rename proof). */
function tempFilesIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.includes('.tmp-'));
}

/** Minimal PKZIP structural read: entry names + central-directory count. */
function readZipStructure(zipPath: string): { names: string[]; count: number } {
	const bytes = readFileSync(zipPath);
	// local file header signature at byte 0
	expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
	// end of central directory
	let eocd = -1;
	for (let index = bytes.length - 22; index >= 0; index--) {
		if (bytes.readUInt32LE(index) === 0x06054b50) {
			eocd = index;
			break;
		}
	}
	expect(eocd).toBeGreaterThanOrEqual(0);
	const count = bytes.readUInt16LE(eocd + 10);
	const cdSize = bytes.readUInt32LE(eocd + 12);
	const cdOffset = bytes.readUInt32LE(eocd + 16);
	// walk the central directory records
	const names: string[] = [];
	let cursor = cdOffset;
	while (cursor < cdOffset + cdSize) {
		expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
		const nameLength = bytes.readUInt16LE(cursor + 28);
		const extraLength = bytes.readUInt16LE(cursor + 30);
		const commentLength = bytes.readUInt16LE(cursor + 32);
		names.push(bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf-8'));
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	expect(names.length).toBe(count);
	return { names, count };
}

// ---------------------------------------------------------------- registry

describe('writer registry (spec §4.3: unknown format is LOUD)', () => {
	test('csv/json/markdown resolve to their writers', () => {
		expect(getDiffusionWriter('csv').format).toBe('csv');
		expect(getDiffusionWriter('json').format).toBe('json');
		expect(getDiffusionWriter('markdown').format).toBe('markdown');
	});

	test('unknown format throws UnknownDiffusionFormatError', () => {
		expect(() => getDiffusionWriter('carrier-pigeon')).toThrow(UnknownDiffusionFormatError);
	});
});

// --------------------------------------------------------------------- csv

describe('csv writer', () => {
	test('csvField: RFC4180 quoting matrix', () => {
		expect(csvField('plain')).toBe('plain');
		expect(csvField('a,b')).toBe('"a,b"');
		expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
		expect(csvField('line1\nline2')).toBe('"line1\nline2"');
		expect(csvField('cr\rlf')).toBe('"cr\rlf"');
		expect(csvField('daño λόγος 例')).toBe('daño λόγος 例'); // utf8 passes bare
		expect(csvField('')).toBe('');
	});

	test('streamed file: header order, excludeColumn omitted, quoting, no BOM, no temps', async () => {
		const sectionPlan = section('objects', 'fwt5', [
			field('name'),
			field('hidden', true), // resolution-only: MUST NOT reach the file
			field('notes'),
		]);
		const session = await csvWriter.open(plan('csv', [sectionPlan], 'svc_basic'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { name: 'comma, inc', hidden: 'NEVER', notes: 'a "quoted" word' }),
			row(1, 'lg-spa', { name: 'línea\nrota', hidden: 'NEVER', notes: null }),
		]);
		const summary = await session.close();

		const dir = `${ROOT}/csv/svc_basic`;
		const content = readFileSync(`${dir}/objects.csv`, 'utf-8');
		expect(content.charCodeAt(0)).not.toBe(0xfeff); // no BOM
		expect(content).toBe(
			'section_id,lang,name,notes\n' +
				'1,lg-eng,"comma, inc","a ""quoted"" word"\n' +
				'1,lg-spa,"línea\nrota",\n',
		);
		expect(content).not.toContain('NEVER');
		expect(tempFilesIn(dir)).toEqual([]);
		expect(summary.tables).toEqual([
			{ table_name: 'objects', records_affected: 2, records_count: 2 },
		]);
		expect(summary.errors).toEqual([]);
	});

	test('same-run removeRecords filters rows out at finalize (quoted newlines survive)', async () => {
		const sectionPlan = section('things', 'fwt6', [field('name')]);
		const session = await csvWriter.open(plan('csv', [sectionPlan], 'svc_remove'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { name: 'keep\nme' }), // embedded newline: boundary detection test
			row(2, 'lg-eng', { name: 'drop me' }),
			row(3, 'lg-eng', { name: 'keep, too' }),
		]);
		await session.removeRecords(sectionPlan, [2]);
		const summary = await session.close();

		const content = readFileSync(`${ROOT}/csv/svc_remove/things.csv`, 'utf-8');
		expect(content).toBe('section_id,lang,name\n1,lg-eng,"keep\nme"\n3,lg-eng,"keep, too"\n');
		expect(summary.tables).toEqual([
			{ table_name: 'things', records_affected: 3, records_count: 2 },
		]);
		expect(tempFilesIn(`${ROOT}/csv/svc_remove`)).toEqual([]);
	});

	test('removeRecords without a same-run write is an honest warning no-op', async () => {
		const sectionPlan = section('ghosts', 'fwt7', [field('name')]);
		const session = await csvWriter.open(plan('csv', [sectionPlan], 'svc_warn'));
		await session.ensureSchema();
		const result = await session.removeRecords(sectionPlan, [9]);
		expect(result).toEqual({ written: 0, deleted: 0 });
		const summary = await session.close();
		expect(summary.errors.length).toBe(1);
		expect(summary.errors[0]).toContain('full-export');
		expect(existsSync(`${ROOT}/csv/svc_warn/ghosts.csv`)).toBe(false);
	});

	test('two sections → two csvs + a structurally valid zip', async () => {
		const sectionA = section('alpha', 'fwt8', [field('name')]);
		const sectionB = section('beta', 'fwt9', [field('name')]);
		const session = await csvWriter.open(plan('csv', [sectionA, sectionB], 'svc_zip'));
		await session.ensureSchema();
		await session.writeRows(sectionA, [row(1, 'lg-eng', { name: 'a' })]);
		await session.writeRows(sectionB, [row(1, 'lg-eng', { name: 'b' })]);
		await session.close();

		const zip = readZipStructure(`${ROOT}/csv/svc_zip/diffusion_csv.zip`);
		expect(zip.count).toBe(2);
		expect(zip.names.sort()).toEqual(['alpha.csv', 'beta.csv']);
	});

	test('abort removes the streamed temp and never lands a final file', async () => {
		const sectionPlan = section('aborted', 'fwt10', [field('name')]);
		const session = await csvWriter.open(plan('csv', [sectionPlan], 'svc_abort'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [row(1, 'lg-eng', { name: 'gone' })]);
		await session.abort();
		const dir = `${ROOT}/csv/svc_abort`;
		expect(tempFilesIn(dir)).toEqual([]);
		expect(existsSync(`${dir}/aborted.csv`)).toBe(false);
	});
});

// -------------------------------------------------------------------- json

describe('json writer', () => {
	test('NDJSON lines parse, plan columns only, meta sidecar, no temps', async () => {
		const sectionPlan = section('objects', 'fwt11', [field('name'), field('secret', true)]);
		const session = await jsonWriter.open(plan('json', [sectionPlan], 'svc_json'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { name: 'first', secret: 'NEVER', stray: 'NEVER' }),
			row(1, 'lg-spa', { name: null }),
		]);
		const summary = await session.close();

		const dir = `${ROOT}/json/svc_json`;
		const lines = readFileSync(`${dir}/objects.ndjson`, 'utf-8').trim().split('\n');
		expect(lines.length).toBe(2);
		const first = JSON.parse(lines[0] as string);
		expect(first).toEqual({ section_id: 1, lang: 'lg-eng', columns: { name: 'first' } });
		const second = JSON.parse(lines[1] as string);
		expect(second).toEqual({ section_id: 1, lang: 'lg-spa', columns: { name: null } });

		const meta = JSON.parse(readFileSync(`${dir}/objects.meta.json`, 'utf-8'));
		expect(meta.table_name).toBe('objects');
		expect(meta.section_tipo).toBe('fwt11');
		expect(meta.columns).toEqual(['name']); // excludeColumn omitted here too
		expect(meta.langs).toEqual(['lg-eng', 'lg-spa']);
		expect(meta.records_count).toBe(2);
		expect(tempFilesIn(dir)).toEqual([]);
		expect(summary.tables).toEqual([
			{ table_name: 'objects', records_affected: 2, records_count: 2 },
		]);
	});

	test('same-run removeRecords drops the record lines; counts land in meta + summary', async () => {
		const sectionPlan = section('things', 'fwt12', [field('name')]);
		const session = await jsonWriter.open(plan('json', [sectionPlan], 'svc_json_rm'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { name: 'keep' }),
			row(2, 'lg-eng', { name: 'drop' }),
		]);
		await session.removeRecords(sectionPlan, [2]);
		const summary = await session.close();

		const dir = `${ROOT}/json/svc_json_rm`;
		const lines = readFileSync(`${dir}/things.ndjson`, 'utf-8').trim().split('\n');
		expect(lines.length).toBe(1);
		expect(JSON.parse(lines[0] as string).section_id).toBe(1);
		const meta = JSON.parse(readFileSync(`${dir}/things.meta.json`, 'utf-8'));
		expect(meta.records_count).toBe(1);
		expect(meta.records_removed).toBe(1);
		expect(summary.tables).toEqual([
			{ table_name: 'things', records_affected: 2, records_count: 1 },
		]);
	});

	test('removeRecords without a same-run write warns (full-export stance)', async () => {
		const sectionPlan = section('ghosts', 'fwt13', [field('name')]);
		const session = await jsonWriter.open(plan('json', [sectionPlan], 'svc_json_warn'));
		await session.ensureSchema();
		await session.removeRecords(sectionPlan, [5]);
		const summary = await session.close();
		expect(summary.errors.length).toBe(1);
		expect(summary.errors[0]).toContain('full-export');
	});

	test('abort removes temps, lands nothing', async () => {
		const sectionPlan = section('aborted', 'fwt14', [field('name')]);
		const session = await jsonWriter.open(plan('json', [sectionPlan], 'svc_json_abort'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [row(1, 'lg-eng', { name: 'gone' })]);
		await session.abort();
		const dir = `${ROOT}/json/svc_json_abort`;
		expect(tempFilesIn(dir)).toEqual([]);
		expect(existsSync(`${dir}/aborted.ndjson`)).toBe(false);
		expect(existsSync(`${dir}/aborted.meta.json`)).toBe(false);
	});
});

// ---------------------------------------------------------------- markdown

describe('markdown writer', () => {
	test('per-record grouping: one .md per section_id with every lang, delete-side name grammar', async () => {
		const sectionPlan = section('objects', 'fwt20', [field('name'), field('notes')]);
		const session = await markdownWriter.open(plan('markdown', [sectionPlan], 'svc_md'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(7, 'lg-eng', { name: 'Chair', notes: null }),
			row(7, 'lg-spa', { name: 'Silla', notes: 'nota' }),
			row(8, 'lg-eng', { name: 'Table', notes: '' }),
			row(8, 'lg-spa', { name: 'Mesa', notes: null }),
		]);
		const summary = await session.close();

		const dir = `${ROOT}/markdown/svc_md`;
		// EXACT delete-side grammar: {section_tipo}_{section_id}.md
		// (diffusion_delete.ts resolvePublishedFilePath / PHP get_record_file_path)
		expect(recordFileName('fwt20', 7, 'md')).toBe('fwt20_7.md');
		const doc = readFileSync(`${dir}/fwt20_7.md`, 'utf-8');
		expect(existsSync(`${dir}/fwt20_8.md`)).toBe(true);

		expect(doc.startsWith('---\n')).toBe(true);
		expect(doc).toContain('section_tipo: "fwt20"');
		expect(doc).toContain('section_id: "7"');
		expect(doc).toContain('diffusion_element: "fwtest1"');
		expect(doc).toContain('# objects');
		expect(doc).toContain('## lg-eng');
		expect(doc).toContain('## lg-spa');
		expect(doc).toContain('**name**: Chair');
		expect(doc).toContain('**name**: Silla');
		expect(doc).toContain('**notes**: nota');
		// null/empty columns omitted (compact documents)
		expect(doc.match(/\*\*notes\*\*/g)?.length).toBe(1);
		// determinism: no wall-clock anywhere (ledgered divergence from PHP)
		expect(doc).not.toMatch(/20\d\d-/);

		expect(summary.tables).toEqual([
			{ table_name: 'objects', records_affected: 2, records_count: 4 },
		]);
		expect(tempFilesIn(dir)).toEqual([]);
	});

	test('renderMarkdownRecord neutralizes structure-breaking values (PHP sanitize_md_value)', () => {
		const sectionPlan = section('objects', 'fwt21', [field('name')]);
		const doc = renderMarkdownRecord(plan('markdown', [sectionPlan]), sectionPlan, 1, [
			row(1, 'lg-eng', { name: '# fake header\n---\nrest' }),
		]);
		expect(doc).toContain('\\# fake header');
		expect(doc).toContain('\\-\\-\\-');
	});

	test('removeRecords unlinks; missing file is idempotent success', async () => {
		const sectionPlan = section('objects', 'fwt22', [field('name')]);
		const session = await markdownWriter.open(plan('markdown', [sectionPlan], 'svc_md_rm'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [row(3, 'lg-eng', { name: 'gone soon' })]);

		const first = await session.removeRecords(sectionPlan, [3]);
		expect(first).toEqual({ written: 0, deleted: 1 });
		expect(existsSync(`${ROOT}/markdown/svc_md_rm/fwt22_3.md`)).toBe(false);

		// second removal: nothing there — idempotent success, zero deletions
		const second = await session.removeRecords(sectionPlan, [3, 99]);
		expect(second).toEqual({ written: 0, deleted: 0 });

		// the removed record never reaches the zip; run wrote nothing else
		const summary = await session.close();
		expect(existsSync(`${ROOT}/markdown/svc_md_rm/diffusion_md.zip`)).toBe(false);
		expect(summary.errors).toEqual([]);
	});

	test('close zips the run files (ZIP only, no merged document — PHP parity)', async () => {
		const sectionPlan = section('objects', 'fwt23', [field('name')]);
		const session = await markdownWriter.open(plan('markdown', [sectionPlan], 'svc_md_zip'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { name: 'one' }),
			row(2, 'lg-eng', { name: 'two' }),
		]);
		await session.close();

		const dir = `${ROOT}/markdown/svc_md_zip`;
		const zip = readZipStructure(`${dir}/diffusion_md.zip`);
		expect(zip.names.sort()).toEqual(['fwt23_1.md', 'fwt23_2.md']);
		// no merged .md beyond the per-record files + zip
		expect(readdirSync(dir).sort()).toEqual(['diffusion_md.zip', 'fwt23_1.md', 'fwt23_2.md']);
	});

	// WC-2026-09-30-diffusion-run-ledger: a manifest record whose file is gone is
	// a summary line ("Partial success"), skipped — never a crash, never an entry.
	test('a manifest record whose file is GONE: close resolves, the archive omits it, the summary names it', async () => {
		const sectionPlan = section('objects', 'fwt24', [field('name')]);
		const session = await markdownWriter.open(plan('markdown', [sectionPlan], 'svc_md_missing'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { name: 'one' }),
			row(2, 'lg-eng', { name: 'two' }),
		]);
		const dir = `${ROOT}/markdown/svc_md_missing`;
		rmSync(`${dir}/fwt24_2.md`);
		const summary = await session.close(localCloseContext(session.takeArtifacts()));
		expect(readZipStructure(`${dir}/diffusion_md.zip`).names).toEqual(['fwt24_1.md']);
		expect(summary.errors).toHaveLength(1);
		expect(summary.errors[0]).toContain('published file missing');
		expect(summary.errors[0]).toContain('fwt24_2.md');
	});

	// Every record file gone by the close (removed by a hand outside the engine —
	// the engine's files-unlink door takes the close's fence): nothing to archive is the no-archive outcome plus one
	// line per record — never a failed run (the zip's zero-entry refusal is for
	// callers that just wrote their inputs).
	test("EVERY manifest record's file GONE: close resolves, no archive, the summary names each", async () => {
		const sectionPlan = section('objects', 'fwt26', [field('name')]);
		const session = await markdownWriter.open(plan('markdown', [sectionPlan], 'svc_md_all_gone'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { name: 'one' }),
			row(2, 'lg-eng', { name: 'two' }),
		]);
		const dir = `${ROOT}/markdown/svc_md_all_gone`;
		rmSync(`${dir}/fwt26_1.md`);
		rmSync(`${dir}/fwt26_2.md`);
		const summary = await session.close(localCloseContext(session.takeArtifacts()));
		expect(existsSync(`${dir}/diffusion_md.zip`)).toBe(false);
		expect(tempFilesIn(dir)).toEqual([]);
		expect(summary.errors).toHaveLength(2);
		expect(summary.errors.join('\n')).toContain('fwt26_1.md');
		expect(summary.errors.join('\n')).toContain('fwt26_2.md');
	});

	// Only a FENCED close (the runner's close unit, context.fenced) may sweep: no
	// other session can own a temp in the directory then. abort() and a close
	// without the fence never touch one.
	test("a FENCED close sweeps a dead holder's .tmp-*; abort() and an unfenced close leave it", async () => {
		const sectionPlan = section('objects', 'fwt25', [field('name')]);
		const service = 'svc_md_tmp_sweep';
		const dir = `${ROOT}/markdown/${service}`;
		const stale = `${dir}/diffusion_md.zip.tmp-crashed`;
		const openWritten = async () => {
			const session = await markdownWriter.open(plan('markdown', [sectionPlan], service));
			await session.ensureSchema();
			await session.writeRows(sectionPlan, [row(1, 'lg-eng', { name: 'one' })]);
			return session;
		};
		mkdirSync(dir, { recursive: true });
		writeFileSync(stale, 'a partial archive of a dead holder');

		await (await openWritten()).abort();
		expect(existsSync(stale), 'abort() swept a temp').toBe(true);
		await (await openWritten()).close();
		expect(existsSync(stale), 'an UNFENCED close swept a temp').toBe(true);
		const fencedSession = await openWritten();
		await fencedSession.close({
			...localCloseContext(fencedSession.takeArtifacts()),
			fenced: true,
		});
		expect(existsSync(stale), "a fenced close left a dead holder's temp behind").toBe(false);
		expect(readdirSync(dir).sort()).toEqual(['diffusion_md.zip', 'fwt25_1.md']);
	});
});

// ------------------------------------------------ run memory is the ledger

/**
 * A JOB-scoped session keeps its artifact events only until the runner takes
 * them (the run ledger is the run's memory): O(batch), never O(run). Only a
 * session opened WITHOUT a job (hand-driven) keeps a history for a close
 * without the ledger — and a job-scoped session refuses that close.
 */
describe('a job-scoped writer session holds O(batch) memory, never O(run)', () => {
	const JOB = '00000000-0000-4000-8000-0000000001a1';

	test("close() of a job-scoped session WITHOUT the ledger's context is refused, typed", async () => {
		const sectionPlan = section('objects', 'fwt26', [field('name')]);
		const session = await markdownWriter.open(plan('markdown', [sectionPlan], 'svc_md_refuse'), {
			jobId: JOB,
			resume: null,
		});
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [row(1, 'lg-eng', { name: 'one' })]);
		const refusal = await session.close().then(
			() => null,
			(error: unknown) => error,
		);
		expect(isDedaloError(refusal) && refusal.code).toBe('internal.invariant');
	});

	/** Heap growth (bytes) across `events` removal events, taken every batch as the runner does. */
	async function heapGrowth(jobScoped: boolean, events: number): Promise<number> {
		const sectionPlan = section('objects', 'fwt27', [field('name')]);
		const session = await csvWriter.open(
			plan('csv', [sectionPlan], `svc_csv_mem_${jobScoped ? 'job' : 'hand'}`),
			jobScoped ? { jobId: JOB, resume: null } : undefined,
		);
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [row(0, 'lg-eng', { name: 'started' })]);
		Bun.gc(true);
		const before = process.memoryUsage().heapUsed;
		const BATCH = 500;
		for (let first = 1; first <= events; first += BATCH) {
			const ids: number[] = [];
			for (let id = first; id < first + BATCH; id++) ids.push(id);
			await session.removeRecords(sectionPlan, ids);
			session.takeArtifacts();
		}
		Bun.gc(true);
		const growth = process.memoryUsage().heapUsed - before;
		await session.abort();
		return growth;
	}

	test('300 000 events through a job-scoped csv session: the heap stays flat (a hand-driven one grows)', async () => {
		const EVENTS = 300_000;
		// Job-scoped FIRST: the control's retained history, freed later, must not
		// be counted against it (a conservative GC frees it when it pleases).
		const jobScoped = await heapGrowth(true, EVENTS);
		const control = await heapGrowth(false, EVENTS);
		// The control proves the measurement sees a retained history at all.
		expect(control, 'the control retained nothing — the measurement is blind').toBeGreaterThan(
			8 * 1024 * 1024,
		);
		expect(
			jobScoped,
			`a job-scoped session retained ${jobScoped} bytes across ${EVENTS} events — its history is O(run)`,
		).toBeLessThan(2 * 1024 * 1024);
	}, 60_000);
});

// ------------------------------------------------------------ shared infra

describe('shared file infrastructure', () => {
	test('atomicWriteFile creates parents, leaves no temp', () => {
		const target = `${ROOT}/infra/deep/nested/file.txt`;
		atomicWriteFile(target, 'payload');
		expect(readFileSync(target, 'utf-8')).toBe('payload');
		expect(tempFilesIn(`${ROOT}/infra/deep/nested`)).toEqual([]);
	});

	test('createZip: valid PKZIP with flat basename entries; skips missing inputs', async () => {
		const dir = `${ROOT}/infra/zip`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/one.txt`, 'first');
		writeFileSync(`${dir}/two.txt`, 'second');
		await createZip([`${dir}/one.txt`, `${dir}/two.txt`, `${dir}/missing.txt`], `${dir}/out.zip`);
		const zip = readZipStructure(`${dir}/out.zip`);
		expect(zip.names.sort()).toEqual(['one.txt', 'two.txt']);
		expect(tempFilesIn(dir)).toEqual([]);
	});

	/**
	 * A file that passes createZip's stat and is GONE when pass 1 opens it (the
	 * file removed by a hand outside the engine while a close runs) is
	 * skipped like any missing file — the archive equals the one built without
	 * it, byte for byte. A source failing INSIDE its entry (pass 2 — no real
	 * file can, its handle is open: see the unlink leg) cannot be skipped (a
	 * partial entry is in the sink): the typed internal.invariant. The stat →
	 * open window is driven through the writer (no real file hits it on cue).
	 */
	function vanishingWriter(
		gonePath: string,
		pass: 1 | 2,
	): { writer: ZipStreamWriter; bytes: () => Uint8Array } {
		const chunks: Uint8Array[] = [];
		const real = openZipStream({
			async write(chunk) {
				chunks.push(chunk.slice());
			},
		});
		const gone = (): Error =>
			Object.assign(new Error(`ENOENT: no such file or directory, open '${gonePath}'`), {
				code: 'ENOENT',
			});
		let opens = 0;
		const writer = new Proxy(real, {
			get(target, property) {
				if (property !== 'addStoredFile') return Reflect.get(target, property);
				return (name: string, path: string) => {
					if (path !== gonePath) return target.addStoredFile(name, path);
					return target.addStoredSource(name, async function* () {
						opens++;
						if (opens >= pass) throw gone();
						yield new TextEncoder().encode('bytes of a file about to vanish');
					});
				};
			},
		});
		return { writer, bytes: () => Buffer.concat(chunks) };
	}

	test('createZip: a file gone when PASS 1 opens it is skipped — the archive is byte-identical to one without it', async () => {
		const dir = `${ROOT}/infra/zip_vanish`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/one.txt`, 'first');
		writeFileSync(`${dir}/gone.txt`, 'passes the stat, gone at the open');
		writeFileSync(`${dir}/two.txt`, 'second');
		await createZip([`${dir}/one.txt`, `${dir}/two.txt`], `${dir}/oracle.zip`);
		const { writer, bytes } = vanishingWriter(`${dir}/gone.txt`, 1);
		const reported: string[] = [];
		const added = await addZipFiles(
			writer,
			[`${dir}/one.txt`, `${dir}/gone.txt`, `${dir}/two.txt`],
			(path) => reported.push(path),
		);
		expect(added).toBe(2);
		expect(reported, 'a skipped input must reach the close summary (onMissing)').toEqual([
			`${dir}/gone.txt`,
		]);
		await writer.finish();
		expect(Buffer.from(bytes()).equals(Buffer.from(readFileSync(`${dir}/oracle.zip`)))).toBe(true);
	});

	// The REAL door, real files: the path is unlinked after pass 1 measured it
	// and before pass 2 reads it. Both passes read ONE open handle, so the entry
	// is archived whole — the archive equals the one built with the file there.
	test('createZip: a file UNLINKED between the two passes is archived whole (one handle, both passes)', async () => {
		const dir = `${ROOT}/infra/zip_unlink_mid`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/one.txt`, 'first');
		writeFileSync(`${dir}/gone.txt`, 'measured by pass 1, unlinked before pass 2');
		writeFileSync(`${dir}/two.txt`, 'second');
		const inputs = [`${dir}/one.txt`, `${dir}/gone.txt`, `${dir}/two.txt`];
		await createZip(inputs, `${dir}/oracle.zip`);
		const chunks: Uint8Array[] = [];
		const real = openZipStream({
			async write(chunk) {
				chunks.push(chunk.slice());
			},
		});
		let unlinked = false;
		const writer = new Proxy(real, {
			get(target, property) {
				if (property !== 'addStoredFile') return Reflect.get(target, property);
				return (name: string, path: string) =>
					target.addStoredFile(name, path, {
						onChunk: () => {
							// the first chunk is pass 1's whole (small) file
							if (path === `${dir}/gone.txt` && !unlinked) {
								unlinked = true;
								rmSync(path);
							}
						},
					});
			},
		});
		const reported: string[] = [];
		const added = await addZipFiles(writer, inputs, (path) => reported.push(path));
		await writer.finish();
		expect(unlinked, 'the leg never unlinked the file between the passes').toBe(true);
		expect(existsSync(`${dir}/gone.txt`)).toBe(false);
		expect(added).toBe(3);
		expect(reported).toEqual([]);
		expect(
			Buffer.from(Buffer.concat(chunks)).equals(Buffer.from(readFileSync(`${dir}/oracle.zip`))),
			'the archive differs from one built with the file present',
		).toBe(true);
	});

	test('createZip: a file gone BETWEEN the two passes is the typed internal.invariant (never a silent partial entry)', async () => {
		const dir = `${ROOT}/infra/zip_vanish2`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/one.txt`, 'first');
		writeFileSync(`${dir}/gone.txt`, 'passes pass 1, gone at pass 2');
		const { writer } = vanishingWriter(`${dir}/gone.txt`, 2);
		let caught: unknown = null;
		try {
			await addZipFiles(writer, [`${dir}/one.txt`, `${dir}/gone.txt`]);
		} catch (error) {
			caught = error;
		}
		expect(isDedaloError(caught), `expected a DedaloError, got ${String(caught)}`).toBe(true);
		expect((caught as { code: string }).code).toBe('internal.invariant');
		expect(writer.writable).toBe(false);
	});

	test('createZip refuses zero valid entries with the TYPED internal.invariant, leaving nothing', async () => {
		const dir = `${ROOT}/infra/zip_empty`;
		mkdirSync(dir, { recursive: true });
		let caught: unknown = null;
		try {
			await createZip([`${dir}/nope.txt`], `${dir}/out.zip`);
		} catch (error) {
			caught = error;
		}
		expect(isDedaloError(caught), `expected a DedaloError, got ${String(caught)}`).toBe(true);
		expect((caught as { code: string }).code).toBe('internal.invariant');
		expect(readdirSync(dir)).toEqual([]);
	});
});

// ------------------------------------------------ csv/json resume (DIFF-1)

/**
 * DIFF-1 — a full-export writer RESUMES its snapshot instead of truncating it.
 *
 * csv and json publish ONE file per table: a complete snapshot, streamed onto a
 * job-scoped partial (`<final>.part-<jobId>`) and finalized at close. Before the
 * run ledger, a resumed run opened a FRESH temp and finalized only the rows the
 * resumed session wrote — the published "complete" file silently lost every
 * row written before the crash. The contract gated here, at WRITER level (the
 * plan compiler cannot reach csv/json today — KNOWN_FORMATS is the PHP validate
 * set — so no runner leg can publish them; the WC entry says so):
 *
 *   write batch 1 → checkpoint() (a durability barrier: flushed + fsynced, it
 *   returns the byte offset) → write batch 2 → the process "dies" (the session
 *   is dropped, no abort) → torn bytes land at the partial's tail → reopen with
 *   {jobId, resume: checkpoint} → `continuity: 'resumed'`, the partial is cut
 *   back to the checkpoint → batch 2 again → close(ctx) ⇒ every published byte
 *   equals an uninterrupted session's. A checkpoint whose partial is gone ⇒
 *   `restart_required` (the runner then resets the run).
 */
interface ResumableSession {
	continuity?: string;
	writeRows(section: SectionPlan, rows: ProjectedRow[]): Promise<unknown>;
	removeRecords(section: SectionPlan, ids: (number | string)[]): Promise<unknown>;
	ensureSchema(): Promise<void>;
	checkpoint?: () => Promise<unknown>;
	close(context?: unknown): Promise<unknown>;
}
type ResumableOpen = (
	plan: PublicationPlan,
	context?: { jobId: string; resume: unknown },
) => Promise<ResumableSession>;

/** The synthetic close context: an empty artifact manifest, the removed ids per section. */
function closeContext(removed: Record<string, (number | string)[]> = {}) {
	return {
		async *manifest() {},
		async *removed(sectionTipo: string) {
			for (const id of removed[sectionTipo] ?? []) yield id;
		},
	};
}

function resumeSection(): SectionPlan {
	return section('objects', 'fwt30', [field('title'), field('code')]);
}
const BATCH_1 = [
	row(1, 'lg-eng', { title: 'one', code: 'A' }),
	row(2, 'lg-eng', { title: 'two', code: 'B' }),
];
const BATCH_2 = [
	row(3, 'lg-eng', { title: 'three', code: 'C' }),
	row(4, 'lg-eng', { title: 'four', code: 'D' }),
];

/** Every file of a run directory, name → bytes (partials excluded: they are not published). */
function publishedFiles(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(dir).sort()) {
		if (name.includes('.part-') || name.includes('.tmp-')) continue;
		out[name] = readFileSync(`${dir}/${name}`, 'utf-8');
	}
	return out;
}

for (const [format, open, extension] of [
	['csv', csvWriter.open as unknown as ResumableOpen, 'csv'],
	['json', jsonWriter.open as unknown as ResumableOpen, 'ndjson'],
] as const) {
	describe(`${format} writer — resume across a crash (DIFF-1)`, () => {
		test('a resumed session publishes byte-identically to an uninterrupted one', async () => {
			const sectionPlan = resumeSection();
			// THE REFERENCE: one uninterrupted session.
			const reference = await open(plan(format, [sectionPlan], `svc_resume_ref`), {
				jobId: '00000000-0000-4000-8000-0000000000a1',
				resume: null,
			});
			await reference.ensureSchema();
			await reference.writeRows(sectionPlan, BATCH_1);
			await reference.checkpoint?.();
			await reference.writeRows(sectionPlan, BATCH_2);
			await reference.close(closeContext());
			const referenceFiles = publishedFiles(`${ROOT}/${format}/svc_resume_ref`);

			// THE CRASHED RUN, then its resume.
			const jobId = '00000000-0000-4000-8000-0000000000b2';
			const service = 'svc_resume_crash';
			const dir = `${ROOT}/${format}/${service}`;
			const first = await open(plan(format, [sectionPlan], service), { jobId, resume: null });
			await first.ensureSchema();
			await first.writeRows(sectionPlan, BATCH_1);
			const checkpoint = await first.checkpoint?.();
			await first.writeRows(sectionPlan, BATCH_2);
			// the process dies here: no abort, no close
			const partial = `${dir}/objects.${extension}.part-${jobId}`;
			const hadPartial = existsSync(partial);
			if (hadPartial) appendFileSync(partial, 'TORN-HALF-LINE');

			const resumed = await open(plan(format, [sectionPlan], service), {
				jobId,
				resume: checkpoint ?? null,
			});
			await resumed.ensureSchema();
			await resumed.writeRows(sectionPlan, BATCH_2);
			await resumed.close(closeContext());

			expect(
				publishedFiles(dir),
				'the resumed run published a truncated snapshot (only the rows written after the crash)',
			).toEqual(referenceFiles);
			expect(hadPartial, `no job-scoped partial at ${partial}`).toBe(true);
			expect(resumed.continuity).toBe('resumed');
		});

		test('a checkpoint whose partial is gone answers restart_required', async () => {
			const sectionPlan = resumeSection();
			const jobId = '00000000-0000-4000-8000-0000000000c3';
			const service = 'svc_resume_lost';
			const first = await open(plan(format, [sectionPlan], service), { jobId, resume: null });
			await first.ensureSchema();
			await first.writeRows(sectionPlan, BATCH_1);
			const checkpoint = await first.checkpoint?.();
			rmSync(`${ROOT}/${format}/${service}/objects.${extension}.part-${jobId}`, { force: true });
			const reopened = await open(plan(format, [sectionPlan], service), {
				jobId,
				resume: checkpoint ?? null,
			});
			expect(checkpoint, 'the session has no checkpoint() durability barrier').toBeDefined();
			expect(reopened.continuity).toBe('restart_required');
		});

		// A partial SHORTER than its checkpoint: a power loss after a checkpoint
		// past the durable length, or a thawed revoked epoch cutting the shared
		// job-scoped partial back to its older checkpoint (WC R1). Honouring it
		// would make the deferred cut a truncate() UP — NUL bytes appended — and
		// finalize() would publish them. The runner's protocol on
		// restart_required (abort, reopen fresh, rewrite the run) is followed
		// here, so a mis-answered 'resumed' shows as published NUL bytes too.
		test('a partial SHORTER than its checkpoint answers restart_required, never publishes NUL', async () => {
			const sectionPlan = resumeSection();
			const reference = await open(plan(format, [sectionPlan], 'svc_resume_short_ref'), {
				jobId: '00000000-0000-4000-8000-0000000000a7',
				resume: null,
			});
			await reference.ensureSchema();
			await reference.writeRows(sectionPlan, BATCH_1);
			await reference.writeRows(sectionPlan, BATCH_2);
			await reference.close(closeContext());
			const referenceFiles = publishedFiles(`${ROOT}/${format}/svc_resume_short_ref`);

			const jobId = '00000000-0000-4000-8000-0000000000b8';
			const service = 'svc_resume_short';
			const dir = `${ROOT}/${format}/${service}`;
			const partial = `${dir}/objects.${extension}.part-${jobId}`;
			const first = await open(plan(format, [sectionPlan], service), { jobId, resume: null });
			await first.ensureSchema();
			await first.writeRows(sectionPlan, BATCH_1);
			const checkpoint = (await first.checkpoint?.()) as
				| { tables: Record<string, { bytes: number }> }
				| undefined;
			// the process dies here; the partial's durable tail is one byte short
			const checkpointBytes = checkpoint?.tables.objects?.bytes ?? 0;
			expect(checkpointBytes, 'the checkpoint names no byte offset to be short of').toBeGreaterThan(
				0,
			);
			expect(statSync(partial).size).toBe(checkpointBytes);
			truncateSync(partial, checkpointBytes - 1);

			let reopened = await open(plan(format, [sectionPlan], service), {
				jobId,
				resume: checkpoint ?? null,
			});
			const continuity = reopened.continuity;
			if (continuity === 'restart_required') {
				await (reopened as ResumableSession & { abort(): Promise<void> }).abort();
				reopened = await open(plan(format, [sectionPlan], service), { jobId, resume: null });
				await reopened.ensureSchema();
				await reopened.writeRows(sectionPlan, BATCH_1);
			}
			await reopened.writeRows(sectionPlan, BATCH_2);
			await reopened.close(closeContext());

			const published = publishedFiles(dir);
			for (const [name, text] of Object.entries(published)) {
				expect(text.includes('\u0000'), `${name} published NUL bytes (a truncate() UP)`).toBe(
					false,
				);
			}
			expect(continuity, 'a short partial was honoured as resumable').toBe('restart_required');
			expect(published).toEqual(referenceFiles);
		});

		// The runner aborts its session when a batch throws (a revoked lease, a
		// target error); the job's NEXT attempt resumes from the job-scoped
		// partial — an abort that dropped it would force a full restart.
		test('an ABORTED session keeps its job-scoped partial: the next attempt resumes', async () => {
			const sectionPlan = resumeSection();
			const jobId = '00000000-0000-4000-8000-0000000000d4';
			const service = 'svc_resume_abort';
			const first = (await open(plan(format, [sectionPlan], service), {
				jobId,
				resume: null,
			})) as ResumableSession & { abort(): Promise<void> };
			await first.ensureSchema();
			await first.writeRows(sectionPlan, BATCH_1);
			const checkpoint = await first.checkpoint?.();
			await first.abort();
			const reopened = await open(plan(format, [sectionPlan], service), {
				jobId,
				resume: checkpoint ?? null,
			});
			expect(reopened.continuity, 'abort dropped the job-scoped partial').toBe('resumed');
		});

		// A job that is gone for good (the runner's partialIsOrphan: absent or
		// completed) leaves a `.part-<its id>` nobody will resume; a successful
		// close sweeps it — and NEVER the partial of a job that can still resume.
		test('a successful close sweeps an ORPHAN job’s partial and keeps a resumable job’s', async () => {
			const sectionPlan = resumeSection();
			const service = 'svc_resume_orphans';
			const dir = `${ROOT}/${format}/${service}`;
			const orphanJob = '00000000-0000-4000-8000-0000000000e5';
			const liveJob = '00000000-0000-4000-8000-0000000000f6';
			mkdirSync(dir, { recursive: true });
			const orphanPartial = `${dir}/objects.${extension}.part-${orphanJob}`;
			const livePartial = `${dir}/objects.${extension}.part-${liveJob}`;
			writeFileSync(orphanPartial, 'orphan');
			writeFileSync(livePartial, 'live');
			const session = await open(plan(format, [sectionPlan], service), {
				jobId: '00000000-0000-4000-8000-000000000107',
				resume: null,
			});
			await session.ensureSchema();
			await session.writeRows(sectionPlan, BATCH_1);
			await session.close({
				...closeContext(),
				partialIsOrphan: async (jobId: string) => jobId === orphanJob,
			});
			expect(existsSync(orphanPartial), 'an orphan job’s partial survived the close').toBe(false);
			expect(existsSync(livePartial), 'the close swept a resumable job’s partial').toBe(true);
		});

		// The partial is named by JOB, so every epoch shares it, and the runner
		// opens its writer OUTSIDE the fence: a revoked epoch that thaws and opens
		// with its STALE checkpoint must not cut the live epoch's partial. Opening
		// only validates; the cut happens at the first (fenced) write.
		test('opening a resumed session never modifies the partial: a stale epoch cannot cut the live one', async () => {
			const sectionPlan = resumeSection();
			const jobId = '00000000-0000-4000-8000-000000000331';
			const service = 'svc_resume_stale_epoch';
			const dir = `${ROOT}/${format}/${service}`;
			const partial = `${dir}/objects.${extension}.part-${jobId}`;
			// The live epoch: batch 1 → checkpoint (the stale epoch's view), batch 2 → checkpoint.
			const live = await open(plan(format, [sectionPlan], service), { jobId, resume: null });
			await live.ensureSchema();
			await live.writeRows(sectionPlan, BATCH_1);
			const staleCheckpoint = await live.checkpoint?.();
			await live.writeRows(sectionPlan, BATCH_2);
			await live.checkpoint?.();
			const liveBytes = statSync(partial).size;
			// The revoked epoch thaws and opens with its stale checkpoint.
			const stale = await open(plan(format, [sectionPlan], service), {
				jobId,
				resume: staleCheckpoint ?? null,
			});
			// Non-degenerate: the stale checkpoint IS honourable (it would cut).
			expect(stale.continuity).toBe('resumed');
			expect(
				statSync(partial).size,
				"opening a session cut the partial back to a stale epoch's checkpoint",
			).toBe(liveBytes);
			// The live epoch finishes: its snapshot holds every row it wrote.
			await live.close(closeContext());
			const published = readFileSync(`${dir}/objects.${extension}`, 'utf-8');
			for (const title of ['one', 'two', 'three', 'four']) expect(published).toContain(title);
		});

		// …and the deferred cut is never SKIPPED: a resumed session that writes
		// nothing more must neither checkpoint nor publish the torn tail.
		test('a resumed session with nothing more to write: checkpoint and close still cut the torn tail', async () => {
			const sectionPlan = resumeSection();
			for (const via of ['checkpoint', 'close'] as const) {
				const jobId =
					via === 'checkpoint'
						? '00000000-0000-4000-8000-000000000341'
						: '00000000-0000-4000-8000-000000000342';
				const service = `svc_resume_idle_${via}`;
				const dir = `${ROOT}/${format}/${service}`;
				const partial = `${dir}/objects.${extension}.part-${jobId}`;
				const first = await open(plan(format, [sectionPlan], service), { jobId, resume: null });
				await first.ensureSchema();
				await first.writeRows(sectionPlan, BATCH_1);
				const checkpoint = (await first.checkpoint?.()) as {
					tables: Record<string, { bytes: number }>;
				};
				const durableBytes = Object.values(checkpoint.tables)[0]?.bytes as number;
				appendFileSync(partial, 'TORN-HALF-LINE');
				const resumed = await open(plan(format, [sectionPlan], service), {
					jobId,
					resume: checkpoint,
				});
				expect(resumed.continuity).toBe('resumed');
				if (via === 'checkpoint') {
					const again = (await resumed.checkpoint?.()) as {
						tables: Record<string, { bytes: number }>;
					};
					expect(
						Object.values(again.tables)[0]?.bytes,
						'a resumed checkpoint recorded the torn tail as durable',
					).toBe(durableBytes);
				} else {
					await resumed.close(closeContext());
					expect(
						readFileSync(`${dir}/objects.${extension}`, 'utf-8'),
						'the finalized snapshot carries the torn tail',
					).not.toContain('TORN-HALF-LINE');
				}
			}
		});

		// checkpoint() is a DURABILITY BARRIER (the WC entry's claim): the byte
		// length it records must be on disk, not in the page cache — after a power
		// loss a checkpoint past the durable length truncates the resumed partial.
		// A process drop (the resume legs above) cannot tell; the fd's fsync order
		// can: after the partial's last write, before checkpoint() resolves.
		test('checkpoint() fsyncs every partial after its last write, before it resolves', async () => {
			const sectionPlan = resumeSection();
			const service = 'svc_fsync_barrier';
			const jobId = '00000000-0000-4000-8000-000000000321';
			const log: string[] = [];
			const partialFds = new Set<number>();
			const realOpen = nodeFs.openSync;
			const realWrite = nodeFs.writeSync;
			const realFsync = nodeFs.fsyncSync;
			const openSpy = spyOn(nodeFs, 'openSync').mockImplementation(((
				...args: Parameters<typeof nodeFs.openSync>
			) => {
				const fd = realOpen(...args);
				if (String(args[0]).includes(`.part-${jobId}`)) partialFds.add(fd);
				return fd;
			}) as typeof nodeFs.openSync);
			const writeSpy = spyOn(nodeFs, 'writeSync').mockImplementation(((
				fd: number,
				...rest: unknown[]
			) => {
				if (partialFds.has(fd)) log.push(`write:${fd}`);
				return (realWrite as (...a: unknown[]) => number)(fd, ...rest);
			}) as typeof nodeFs.writeSync);
			const fsyncSpy = spyOn(nodeFs, 'fsyncSync').mockImplementation(((fd: number) => {
				if (partialFds.has(fd)) log.push(`fsync:${fd}`);
				return realFsync(fd);
			}) as typeof nodeFs.fsyncSync);
			try {
				const session = await open(plan(format, [sectionPlan], service), { jobId, resume: null });
				await session.ensureSchema();
				await session.writeRows(sectionPlan, BATCH_1);
				await session.checkpoint?.();
				log.push('checkpoint-resolved');
				await session.writeRows(sectionPlan, BATCH_2);
				await session.checkpoint?.();
				log.push('checkpoint-resolved');
			} finally {
				openSpy.mockRestore();
				writeSpy.mockRestore();
				fsyncSpy.mockRestore();
			}
			// Non-degenerate: the partial was written through the spied descriptor.
			expect(partialFds.size).toBe(1);
			expect(log.filter((entry) => entry.startsWith('write:')).length).toBeGreaterThan(0);
			// Every checkpoint: the partial's last write before it is followed by an
			// fsync of that descriptor before the checkpoint resolved.
			let segmentStart = 0;
			for (let i = 0; i < log.length; i++) {
				if (log[i] !== 'checkpoint-resolved') continue;
				const segment = log.slice(segmentStart, i);
				const lastWrite = segment.map((entry) => entry.startsWith('write:')).lastIndexOf(true);
				expect(lastWrite, 'a checkpoint with no write before it (vacuous)').toBeGreaterThanOrEqual(
					0,
				);
				expect(
					segment.slice(lastWrite + 1).some((entry) => entry.startsWith('fsync:')),
					"checkpoint() resolved with the partial's last write not fsynced — not a durability barrier",
				).toBe(true);
				segmentStart = i + 1;
			}
		});

		// A writer diagnostic reported before the crash is part of the run's
		// report: it rides the writer checkpoint and the resume restores it. The
		// resumed batches never re-trigger it — only the restore can report it.
		test('a writer error line reported before a crash survives the resume', async () => {
			const sectionPlan = resumeSection();
			const never = section('never_written', 'fwt31', [field('title')]);
			const jobId = '00000000-0000-4000-8000-000000000311';
			const service = 'svc_resume_errors';
			const first = await open(plan(format, [sectionPlan, never], service), {
				jobId,
				resume: null,
			});
			await first.ensureSchema();
			// A removal on a table this run never wrote: a summary error line.
			await first.removeRecords(never, [9]);
			await first.writeRows(sectionPlan, BATCH_1);
			const checkpoint = await first.checkpoint?.();
			// the process dies here: no abort, no close
			const resumed = await open(plan(format, [sectionPlan, never], service), {
				jobId,
				resume: checkpoint ?? null,
			});
			await resumed.ensureSchema();
			await resumed.writeRows(sectionPlan, BATCH_2);
			const summary = (await resumed.close(closeContext())) as { errors: string[] };
			expect(resumed.continuity).toBe('resumed');
			expect(
				summary.errors.some((line) => line.includes("removeRecords('never_written')")),
				"the resumed run forgot the crashed attempt's writer error line",
			).toBe(true);
		});

		// DIFF-2: only a FENCED close (the runner's close unit) may sweep a dead
		// holder's `.tmp-*` — abort() and an unfenced close never touch one.
		test("a FENCED close sweeps a dead holder's .tmp-*; abort() and an unfenced close leave it", async () => {
			const sectionPlan = resumeSection();
			const service = 'svc_tmp_sweep';
			const dir = `${ROOT}/${format}/${service}`;
			const stale = `${dir}/objects.${extension}.tmp-crashed`;
			let job = 0;
			const openWritten = async () => {
				job++;
				const session = (await open(plan(format, [sectionPlan], service), {
					jobId: `00000000-0000-4000-8000-00000000020${job}`,
					resume: null,
				})) as ResumableSession & { abort(): Promise<void> };
				await session.ensureSchema();
				await session.writeRows(sectionPlan, BATCH_1);
				return session;
			};
			mkdirSync(dir, { recursive: true });
			writeFileSync(stale, 'a partial of a dead holder');
			await (await openWritten()).abort();
			expect(existsSync(stale), 'abort() swept a temp').toBe(true);
			await (await openWritten()).close(closeContext());
			expect(existsSync(stale), 'an UNFENCED close swept a temp').toBe(true);
			await (await openWritten()).close({ ...closeContext(), fenced: true });
			expect(existsSync(stale), "a fenced close left a dead holder's temp behind").toBe(false);
			expect(existsSync(`${dir}/objects.${extension}`)).toBe(true);
		});

		// A session opened WITHOUT a job streams onto a `.tmp-*` partial of its
		// own: a fenced close must finalize it, never sweep it from under itself.
		test('a JOB-LESS session closed under the fence finalizes its own .tmp- partial (never sweeps it)', async () => {
			const sectionPlan = resumeSection();
			const service = 'svc_tmp_own';
			const dir = `${ROOT}/${format}/${service}`;
			const session = await open(plan(format, [sectionPlan], service));
			await session.ensureSchema();
			await session.writeRows(sectionPlan, BATCH_1);
			const ownTemps = readdirSync(dir).filter((name) => name.includes('.tmp-'));
			// Non-degenerate: the session's partial IS a temp sibling right now.
			expect(ownTemps.length).toBeGreaterThan(0);
			await session.close({ ...closeContext(), fenced: true });
			const published = readFileSync(`${dir}/objects.${extension}`, 'utf-8');
			expect(published).toContain('one');
			expect(published).toContain('two');
			expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
		});
	});
}

/**
 * WHAT SURVIVES A POWER CUT (audit 2026-09-26 Step 6 review: the run ledger
 * made the writers' effects RECORDS, so they must be on disk before the record).
 *
 * The runner commits a batch's `wrote` / `removed` events, its checkpoint and,
 * at the end, `clearRunLedger` + `finishJob('completed')` to Postgres — WAL
 * durable. Whatever the writer told it must therefore be on disk, not in the
 * page cache, when checkpoint() / close() resolves: otherwise a power cut
 * leaves a 'completed' run whose files are empty, missing or (an unlink lost)
 * resurrected, and a resume skips them because the cursor is past them. A kill
 * -9 cannot show it (the page cache outlives the process); the model can
 * (test/helpers/power_loss_model.ts: bytes durable once fsynced after the last
 * write, an entry durable once its directory is fsynced after the change —
 * what it did not see is never proven).
 */
describe('what survives a power cut: checkpoint() and close() are durability barriers', () => {
	const PER_RECORD: readonly {
		format: 'markdown' | 'xml' | 'rdf';
		writer: { open(plan: PublicationPlan, context?: unknown): Promise<WriterSession> };
		section: SectionPlan;
		fileOf: (section: SectionPlan, sectionId: number) => string;
	}[] = [
		{
			format: 'markdown',
			writer: markdownWriter,
			section: section('objects', 'fwt40', [field('title')]),
			fileOf: (plan, id) => recordFileName(plan.sectionTipo, id, 'md'),
		},
		{
			format: 'xml',
			writer: xmlWriter,
			section: section('objects', 'fwt41', [field('title')]),
			fileOf: (plan, id) => recordFileName(plan.sectionTipo, id, 'xml'),
		},
		{
			format: 'rdf',
			writer: rdfWriter,
			section: section('nmo:NumismaticObject', 'fwt42', [field('dc:title')]),
			fileOf: (plan, id) => rdfRecordFileName(plan, id),
		},
	];
	const titleRow = (sectionPlan: SectionPlan, id: number): ProjectedRow =>
		row(id, 'lg-eng', { [sectionPlan.fields[0]?.columnName as string]: `title ${id}` });

	for (const { format, writer, section: sectionPlan, fileOf } of PER_RECORD) {
		test(`${format}: every record a checkpoint hands the run ledger as written or removed survives a power cut`, async () => {
			const service = `svc_power_${format}`;
			const dir = `${ROOT}/${format}/${service}`;
			const model = startPowerLossModel(ROOT);
			const unproven: string[] = [];
			const expectBatchDurable = (events: { op: string; sectionId: number | string }[]): void => {
				for (const event of events) {
					const path = `${dir}/${fileOf(sectionPlan, Number(event.sectionId))}`;
					if (event.op === 'wrote' && !model.survives(path)) unproven.push(model.explain(path));
					if (event.op === 'removed' && !model.absenceSurvives(path)) {
						unproven.push(`${path}: its unlink was never made durable (the record resurrects)`);
					}
				}
			};
			let first: { op: string; sectionId: number | string }[] = [];
			let second: { op: string; sectionId: number | string }[] = [];
			let third: { op: string; sectionId: number | string }[] = [];
			try {
				const session = await writer.open(plan(format, [sectionPlan], service), {
					jobId: '00000000-0000-4000-8000-0000000004a1',
					resume: null,
				});
				await session.ensureSchema();
				await session.writeRows(sectionPlan, [titleRow(sectionPlan, 1), titleRow(sectionPlan, 2)]);
				first = session.takeArtifacts();
				await session.checkpoint();
				expectBatchDurable(first);
				await session.writeRows(sectionPlan, [titleRow(sectionPlan, 3)]);
				second = session.takeArtifacts();
				await session.checkpoint();
				expectBatchDurable(second);
				// A batch that only REMOVES (its records unpublished meanwhile).
				await session.removeRecords(sectionPlan, [1]);
				third = session.takeArtifacts();
				await session.checkpoint();
				expectBatchDurable(third);
			} finally {
				model.restore();
			}
			// Non-vacuous: three batches, three files written and one removed, all seen.
			expect(first.map((event) => event.op)).toEqual(['wrote', 'wrote']);
			expect(second.map((event) => event.op)).toEqual(['wrote']);
			expect(third.map((event) => event.op)).toEqual(['removed']);
			expect(existsSync(`${dir}/${fileOf(sectionPlan, 1)}`)).toBe(false);
			expect(model.seen.unlinks + model.seen.renames).toBeGreaterThanOrEqual(4);
			expect(existsSync(`${dir}/${fileOf(sectionPlan, 3)}`)).toBe(true);
			expect(
				unproven,
				'checkpoint() resolved while a record the run ledger will commit was not on disk',
			).toEqual([]);
		});

		test(`${format}: every file a close publishes survives a power cut`, async () => {
			const service = `svc_power_close_${format}`;
			const dir = `${ROOT}/${format}/${service}`;
			// The model sees the whole session: what it did not see is never proven.
			const model = startPowerLossModel(ROOT);
			try {
				const session = await writer.open(plan(format, [sectionPlan], service));
				await session.ensureSchema();
				await session.writeRows(sectionPlan, [titleRow(sectionPlan, 1), titleRow(sectionPlan, 2)]);
				await session.close();
			} finally {
				model.restore();
			}
			const published = readdirSync(dir).filter((name) => !name.includes('.tmp-'));
			// Non-vacuous: the consolidated archive and both records are among them.
			expect(published.some((name) => name.endsWith('.zip'))).toBe(true);
			expect(published.length).toBeGreaterThanOrEqual(3);
			expect(
				published
					.map((name) => `${dir}/${name}`)
					.filter((path) => !model.survives(path))
					.map((path) => model.explain(path)),
				'close() resolved — and the runner commits "completed" — with a published file not on disk',
			).toEqual([]);
		});
	}

	for (const [format, writer, extension] of [
		['csv', csvWriter, 'csv'],
		['json', jsonWriter, 'ndjson'],
	] as const) {
		test(`${format}: a close that FILTERS removed records publishes durable files and never drops the last durable copy`, async () => {
			const service = `svc_power_close_${format}`;
			const dir = `${ROOT}/${format}/${service}`;
			const objects = resumeSection();
			const extra = section('extras', 'fwt43', [field('title')]);
			// The model sees the whole session: what it did not see is never proven.
			const model = startPowerLossModel(ROOT);
			let partialSurvived = false;
			const lostCopies: string[] = [];
			// The partial is the snapshot's only durable copy until the final is.
			model.beforeUnlink((path) => {
				const match = /^(.*)\.part-[0-9a-f-]{36}$/.exec(path);
				if (match !== null && !model.survives(match[1] as string)) {
					lostCopies.push(`${path} unlinked while ${model.explain(match[1] as string)}`);
				}
			});
			try {
				const session = await (writer.open as unknown as ResumableOpen)(
					plan(format, [objects, extra], service),
					{ jobId: '00000000-0000-4000-8000-0000000004c1', resume: null },
				);
				await session.ensureSchema();
				await session.writeRows(objects, [...BATCH_1, ...BATCH_2]);
				await session.writeRows(extra, [row(7, 'lg-eng', { title: 'seven' })]);
				await session.checkpoint?.();
				// The checkpoint names the partial's bytes: the partial must survive with them.
				partialSurvived = model.survives(
					`${dir}/objects.${extension}.part-00000000-0000-4000-8000-0000000004c1`,
				);
				await session.close(closeContext({ fwt30: [2] }));
			} finally {
				model.restore();
			}
			expect(
				partialSurvived,
				'checkpoint() named the bytes of a partial whose directory entry a power cut could take back',
			).toBe(true);
			const published = readdirSync(dir).filter(
				(name) => !name.includes('.tmp-') && !name.includes('.part-'),
			);
			// Non-vacuous: the filter branch ran (record 2 is gone) and the zip landed.
			expect(readFileSync(`${dir}/objects.${extension}`, 'utf-8')).not.toContain('two');
			expect(readFileSync(`${dir}/objects.${extension}`, 'utf-8')).toContain('three');
			expect(published).toContain(`diffusion_${format}.zip`);
			expect(
				lostCopies,
				'the partial was unlinked before the filtered snapshot was on disk',
			).toEqual([]);
			expect(
				published
					.map((name) => `${dir}/${name}`)
					.filter((path) => !model.survives(path))
					.map((path) => model.explain(path)),
				'close() resolved — and the runner commits "completed" + clears the ledger — with a published file not on disk',
			).toEqual([]);
		});
	}

	for (const [format, writer, extension] of [
		['csv', csvWriter, 'csv'],
		['json', jsonWriter, 'ndjson'],
	] as const) {
		// No archive lands after it: the snapshot's own rename must be made durable.
		test(`${format}: a one-table close with nothing removed publishes a durable snapshot`, async () => {
			const service = `svc_power_single_${format}`;
			const dir = `${ROOT}/${format}/${service}`;
			const objects = resumeSection();
			const model = startPowerLossModel(ROOT);
			try {
				const session = await (writer.open as unknown as ResumableOpen)(
					plan(format, [objects], service),
					{ jobId: '00000000-0000-4000-8000-0000000004c2', resume: null },
				);
				await session.ensureSchema();
				await session.writeRows(objects, BATCH_1);
				await session.checkpoint?.();
				await session.close(closeContext());
			} finally {
				model.restore();
			}
			const snapshot = `${dir}/objects.${extension}`;
			expect(readFileSync(snapshot, 'utf-8')).toContain('two');
			expect(readdirSync(dir).some((name) => name.endsWith('.zip'))).toBe(false);
			expect(model.survives(snapshot), model.explain(snapshot)).toBe(true);
		});
	}

	// Each consolidation primitive's own contract: what it returns from is on
	// disk, whatever the caller does after it (a writer's later archive in the
	// same directory would otherwise hide a missing directory fsync).
	test('each consolidation primitive publishes durably on its own', async () => {
		const dir = `${ROOT}/infra/primitives`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/a.xml`, '<?xml version="1.0"?>\n<root><a/></root>\n');
		writeFileSync(`${dir}/b.xml`, '<?xml version="1.0"?>\n<root><b/></root>\n');
		writeFileSync(`${dir}/a.rdf`, '<?xml version="1.0"?>\n<rdf:RDF>\n<x/>\n</rdf:RDF>\n');
		writeFileSync(`${dir}/b.rdf`, '<?xml version="1.0"?>\n<rdf:RDF>\n<y/>\n</rdf:RDF>\n');
		const parts = async function* (...paths: string[]) {
			yield* paths;
		};
		const outputs: Record<string, string> = {};
		const model = startPowerLossModel(ROOT);
		try {
			outputs.zip = `${dir}/out.zip`;
			await createZip([`${dir}/a.xml`, `${dir}/b.xml`], outputs.zip);
			expect(model.survives(outputs.zip), model.explain(outputs.zip)).toBe(true);
			outputs.xml = `${dir}/merged.xml`;
			await writeMergedXml(parts(`${dir}/a.xml`, `${dir}/b.xml`), outputs.xml);
			expect(model.survives(outputs.xml), model.explain(outputs.xml)).toBe(true);
			outputs.rdf = `${dir}/merged.rdf`;
			await writeMergedRdf(parts(`${dir}/a.rdf`, `${dir}/b.rdf`), outputs.rdf);
			expect(model.survives(outputs.rdf), model.explain(outputs.rdf)).toBe(true);
			outputs.single = `${dir}/nested/new/single.json`;
			atomicWriteFile(outputs.single, '{}\n');
			expect(model.survives(outputs.single), model.explain(outputs.single)).toBe(true);
		} finally {
			model.restore();
		}
		// Non-vacuous: every output landed with content.
		for (const path of Object.values(outputs)) expect(statSync(path).size).toBeGreaterThan(0);
	});

	test('a filter that fails leaves no temp behind and keeps the partial for the next attempt', async () => {
		const dir = `${ROOT}/infra/filter_fails`;
		const finalPath = `${dir}/objects.csv`;
		const file = new FullExportFile(finalPath, '00000000-0000-4000-8000-0000000004d1');
		await file.append('section_id,title\n1,one\n');
		await file.durable();
		await expect(
			file.finalize(new Set(['1']), async (_input, output) => {
				writeFileSync(output, 'section_id,title\n');
				throw new Error('filter died half way');
			}),
		).rejects.toThrow('filter died half way');
		expect(tempFilesIn(dir), 'a failed filter left its temp in the target directory').toEqual([]);
		expect(existsSync(file.partialPath)).toBe(true);
		expect(existsSync(finalPath)).toBe(false);
	});
});
