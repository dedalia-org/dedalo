/**
 * A RUN THAT PUBLISHES NOTHING WITHDRAWS THE CONSOLIDATED ARTIFACTS
 * (closure review cross-diffusion:r7, S2 "a run whose artifact manifest comes
 * out empty leaves the previous merged document and zip in place, so withdrawn
 * records stay downloadable").
 *
 * The consolidated artifacts (rdf/xml merged document + zip, markdown zip) are
 * the RUN's manifest — removed records absent (types.ts WriterCloseContext).
 * close() rebuilt them only when that manifest yielded a part: a run that
 * unpublished every record (its manifest empty) left the PREVIOUS run's
 * merged document and zip, still holding the withdrawn records, in the public
 * files directory, reported 'completed', and nothing ever retried.
 *
 * Outcome gate per writer: publish 2 records (run 1: merged + zip land) →
 * unpublish both in run 2 → run 2's close leaves NO merged document and NO
 * zip, its summary names none, and nothing temp is left behind. A second
 * empty close over the already-clean directory is idempotent.
 *
 * Every path lives under a marked per-process scratch root
 * (DEDALO_DIFFUSION_FILES_ROOT) — the real media tree is never touched.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { FieldPlan, PublicationPlan, SectionPlan } from '../../src/diffusion/plan/types.ts';
import type { ProjectedRow } from '../../src/diffusion/project/lang_ladder.ts';
import { localCloseContext } from '../../src/diffusion/writers/files.ts';
import { markdownWriter } from '../../src/diffusion/writers/markdown.ts';
import { rdfWriter } from '../../src/diffusion/writers/rdf.ts';
import type { DiffusionWriter, WriterSession } from '../../src/diffusion/writers/types.ts';
import { xmlWriter } from '../../src/diffusion/writers/xml.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('ts_diffusion_consolidated_withdrawn');
let savedRoot: string | undefined;

beforeAll(() => {
	savedRoot = process.env.DEDALO_DIFFUSION_FILES_ROOT;
	process.env.DEDALO_DIFFUSION_FILES_ROOT = ROOT;
	markMediaRoot(ROOT);
});

afterAll(() => {
	if (savedRoot !== undefined) process.env.DEDALO_DIFFUSION_FILES_ROOT = savedRoot;
	else delete process.env.DEDALO_DIFFUSION_FILES_ROOT;
	rmSync(ROOT, { recursive: true, force: true });
});

function field(columnName: string): FieldPlan {
	return {
		id: `cwt_${columnName}`,
		columnName,
		sourceChain: [],
		transform: [],
		column: { fieldModel: 'field_text' },
		policy: {},
		excludeColumn: false,
	};
}

function plan(format: string, section: SectionPlan, serviceName: string): PublicationPlan {
	return {
		planId: `consolidated_withdrawn_${format}`,
		elementTipo: 'test6112',
		format,
		serviceName,
		target: { kind: 'files', serviceName },
		sections: [section],
		recursion: { maxLevels: 2 },
		langPolicy: { langs: ['lg-eng'], mainLang: 'lg-eng' },
		warnings: [],
	};
}

function row(sectionId: number, column: string, value: string): ProjectedRow {
	return { sectionId, lang: 'lg-eng', columns: { [column]: value } };
}

interface Case {
	readonly writer: DiffusionWriter;
	readonly format: string;
	readonly dir: string;
	readonly section: SectionPlan;
	readonly column: string;
	/** The consolidated artifacts the writer's close lands (relative to the dir). */
	readonly consolidated: readonly string[];
}

const CASES: readonly Case[] = [
	{
		writer: rdfWriter,
		format: 'rdf',
		dir: 'rdf/svc_cw_rdf',
		section: {
			sectionTipo: 'test6100',
			tableName: 'nmo:NumismaticObject',
			tableTipo: 'test6100_table',
			fields: [field('dc:title')],
		},
		column: 'dc:title',
		consolidated: ['diffusion_rdf_merged.rdf', 'diffusion_rdf.zip'],
	},
	{
		writer: xmlWriter,
		format: 'xml',
		dir: 'xml/svc_cw_xml',
		section: {
			sectionTipo: 'test6100',
			tableName: 'objects',
			tableTipo: 'test6100_table',
			fields: [field('title')],
		},
		column: 'title',
		consolidated: ['diffusion_xml_merged.xml', 'diffusion_xml.zip'],
	},
	{
		writer: markdownWriter,
		format: 'markdown',
		dir: 'markdown/svc_cw_md',
		section: {
			sectionTipo: 'test6100',
			tableName: 'objects',
			tableTipo: 'test6100_table',
			fields: [field('title')],
		},
		column: 'title',
		consolidated: ['diffusion_md.zip'],
	},
];

async function openRun(c: Case): Promise<WriterSession> {
	const session = await c.writer.open(plan(c.format, c.section, c.dir.split('/')[1] as string));
	await session.ensureSchema();
	return session;
}

/** A fenced close over the session's own events (the run ledger's replay rule, in memory). */
async function closeRun(session: WriterSession, events: Parameters<typeof localCloseContext>[0]) {
	return session.close({ ...localCloseContext(events), fenced: true });
}

describe('a run that publishes nothing withdraws the consolidated artifacts', () => {
	for (const c of CASES) {
		test(`${c.format}: publish 2 → unpublish both → merged document and zip are gone`, async () => {
			const dir = `${ROOT}/${c.dir}`;
			// RUN 1: two records published, the consolidated artifacts land holding both.
			const first = await openRun(c);
			await first.writeRows(c.section, [
				row(1, c.column, 'withdrawn-one'),
				row(2, c.column, 'withdrawn-two'),
			]);
			const firstSummary = await closeRun(first, first.takeArtifacts?.() ?? []);
			for (const name of c.consolidated) {
				expect(existsSync(`${dir}/${name}`), `run 1 did not land ${name}`).toBe(true);
			}
			const zipName = c.consolidated[c.consolidated.length - 1] as string;
			expect(readFileSync(`${dir}/${zipName}`).includes('test6100')).toBe(true);
			expect(firstSummary.errors).toEqual([]);
			// The directory census below reads THIS directory (its floor): 2 record
			// files + the consolidated artifacts, no temp.
			expect(readdirSync(dir).filter((name) => !name.includes('.tmp-'))).toHaveLength(
				2 + c.consolidated.length,
			);

			// RUN 2: both records unpublished — the run's manifest is empty.
			const second = await openRun(c);
			const removed = await second.removeRecords(c.section, [1, 2]);
			expect(removed.deleted).toBe(2);
			const summary = await closeRun(second, second.takeArtifacts?.() ?? []);

			for (const name of c.consolidated) {
				expect(
					existsSync(`${dir}/${name}`),
					`${name} survived a run that withdrew every record: withdrawn records stay downloadable`,
				).toBe(false);
			}
			expect(summary.tables.some((t) => t.table_name.startsWith('consolidated'))).toBe(false);
			expect(summary.errors).toEqual([]);
			expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);

			// Idempotent: another empty close over the clean directory changes nothing.
			const third = await openRun(c);
			const again = await closeRun(third, []);
			expect(again.errors).toEqual([]);
			for (const name of c.consolidated) expect(existsSync(`${dir}/${name}`)).toBe(false);
		});
	}
});
