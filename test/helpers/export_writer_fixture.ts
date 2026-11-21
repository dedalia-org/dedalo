/**
 * EXPORT WRITER FIXTURE — build a tool_export download the way the engine does,
 * over protocol lines a gate chose, with no database.
 *
 * The situation is BUILT, never read: a scratch export-artifacts root that
 * declares itself one (the `.dedalo_test_export_artifacts` marker,
 * media_scratch_root.ts), a job created through the store's own `createJob`, a
 * spool written through the store's own spool writer, the manifest marked
 * 'ended', and the file produced by `buildArtifactFile` — the ONE door every
 * downloadable format comes out of (tools/tool_export/server/writers/index.ts).
 * A gate asserts on the BYTES that door leaves on disk.
 *
 * Hermetic: nothing here connects to Postgres (the media_zip writer does, which
 * is why the gates that use this fixture never build that format with it).
 * The CALLER owns the scratch directory's lifecycle (mkdtemp it, rm it in its
 * afterAll); this module only declares it an export root and writes through
 * the store, which refuses any root without the declaration.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type ArtifactJobRef,
	type ArtifactStore,
	type ExportFormat,
	openArtifactStore,
} from '../../tools/tool_export/server/artifact_store.ts';
import { buildArtifactFile } from '../../tools/tool_export/server/writers/index.ts';
import { markExportArtifactsRoot } from './media_scratch_root.ts';

export type ExportProtocolLine = Record<string, unknown>;

/**
 * A store on `<scratchDir>/<name>`, declared an export-artifacts root (no quota,
 * 24 h TTL). `scratchDir` is the caller's temp directory.
 */
export function scratchExportStore(scratchDir: string, name = 'artifacts'): ArtifactStore {
	return openArtifactStore({
		root: markExportArtifactsRoot(join(scratchDir, name)),
		quotaBytes: 0,
		ttlHours: 24,
	});
}

/** An ENDED job whose spool holds exactly `lines`. */
export async function endedExportJob(
	store: ArtifactStore,
	lines: readonly ExportProtocolLine[],
	userId = 11,
): Promise<ArtifactJobRef> {
	const { job } = await store.createJob({
		userId,
		sectionTipo: 'test3',
		sections: ['test3'],
		options: { data_format: 'standard', breakdown: 'rows' },
		// The writers never read it; a door (access.ts) would refuse this
		// placeholder — a fixture job is for writers, not for the doors.
		recordScope: 'writer-fixture',
		frameColumns: [],
		applicationLang: 'lg-eng',
	});
	const writer = await store.openSpoolWriter(job, { indexEvery: 4 });
	for (const line of lines) await writer.write(line);
	await writer.close();
	await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
	return job;
}

/** Build `format` from an ended job through buildArtifactFile; the file's bytes. */
export async function buildExportBytes(
	store: ArtifactStore,
	job: ArtifactJobRef,
	format: ExportFormat,
	origin = 'https://dedalo.fixture.example.test',
): Promise<Buffer> {
	const file = await buildArtifactFile({
		store,
		job,
		format,
		options: { origin, showTipoInLabel: false },
		signal: new AbortController().signal,
	});
	return readFileSync(join(job.dir, file.basename));
}

/**
 * A one-text-column export whose rows carry `values`, in order (one record per
 * value). Column 0 is the value column; the header label is `label`.
 */
export function singleColumnExport(
	values: readonly string[],
	label = 'Value',
): ExportProtocolLine[] {
	const lines: ExportProtocolLine[] = [
		{ t: 'meta', v: 1, data_format: 'standard', breakdown: 'rows', section_tipo: 'test3' },
		{ t: 'col', i: 0, key: 'value', label, cell_type: 'text', after: null },
	];
	values.forEach((value, index) => {
		lines.push({ t: 'row', rec: index + 1, sub: 0, c: { '0': value } });
	});
	lines.push({ t: 'end', columns: [0], rows: values.length, records: values.length });
	return lines;
}

/**
 * RFC-4180 reader for the export CSV dialect (';' separator, '"' quoting,
 * '""' escape, records split on '\n' outside quotes). Independent of the
 * writer: it shares no line with tools/tool_export/server/writers/delimited.ts.
 * The BOM, when present, is NOT stripped — a caller asserts on it separately.
 */
export function parseExportCsv(text: string): string[][] {
	const records: string[][] = [];
	let field = '';
	let record: string[] = [];
	let quoted = false;
	let at = 0;
	while (at < text.length) {
		const ch = text[at] as string;
		if (quoted) {
			if (ch === '"') {
				if (text[at + 1] === '"') {
					field += '"';
					at += 2;
					continue;
				}
				quoted = false;
				at++;
				continue;
			}
			field += ch;
			at++;
			continue;
		}
		if (ch === '"' && field === '') {
			quoted = true;
		} else if (ch === ';') {
			record.push(field);
			field = '';
		} else if (ch === '\n') {
			record.push(field);
			records.push(record);
			record = [];
			field = '';
		} else {
			field += ch;
		}
		at++;
	}
	if (quoted) throw new Error('csv reader: unterminated quoted field');
	record.push(field);
	records.push(record);
	return records;
}

/** The export TSV dialect: records on '\n', fields on TAB, no quoting. */
export function parseExportTsv(text: string): string[][] {
	return text.split('\n').map((line) => line.split('\t'));
}
