/**
 * RDF + XML file writers — P3 final slice gates (DIFFUSION_PLAN D3-P3;
 * DIFFUSION_SPEC §4.3 "rdf / xml: one deterministic file per record;
 * close() does type-aware merge + ZIP"):
 *
 * - rdf: per-record file name pinned BYTE-EQUAL to the delete-side grammar
 *   (sanitizeRdfFileName vs the imported diffusion_delete.ts
 *   sanitizePublishedFileName — the two verbatim ports must never drift),
 *   EasyRdf envelope/namespace/indent fragments pinned against a REAL
 *   PHP-published file (media_monedaiberica/rdf/nomisma/
 *   nmonumismaticobject-test6100-1-*.rdf), xml:lang alpha2 literals, null
 *   column omission, rdf:about override, unknown-prefix loudness, legacy
 *   '{base}_*.rdf' removal, merge+zip products, abort cleanup;
 * - xml: {section_tipo}_{section_id}.xml delete-side grammar, PHP
 *   sanitize_xml_node_name port, per-lang children vs nolan inline, merged
 *   document under the first root, zip;
 * - both: well-formed XML (hand tokenizer — no DOM in bun:test), open()
 *   rejects non-files targets loudly, registry lookups, determinism
 *   (re-render byte-identical, no wall-clock).
 *
 * ALL paths live under a per-process temp root injected via the documented
 * DEDALO_DIFFUSION_FILES_ROOT override (files.ts) — the real media tree is
 * NEVER touched (the real published fixtures above are READ as pinned
 * string fragments only, copied here verbatim).
 */
// Migrated to the generic `test` TLD 2026-08-19: the plans/rows are fabricated and
// every path is under the temp root — the tipos are their test-TLD twins (the pinned
// PHP fragments are copied strings, rewritten to match).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { sanitizePublishedFileName } from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import type { FieldPlan, PublicationPlan, SectionPlan } from '../../src/diffusion/plan/types.ts';
import type { ProjectedRow } from '../../src/diffusion/project/lang_ladder.ts';
import { localCloseContext } from '../../src/diffusion/writers/files.ts';
import * as rdfModule from '../../src/diffusion/writers/rdf.ts';
import {
	CONSOLIDATED_MERGED_PREFIX,
	CONSOLIDATED_ZIP_PREFIX,
	collectRdfNamespaces,
	InvalidFileTargetError,
	langToAlpha2,
	rdfRecordFileName,
	rdfWriter,
	renderRdfRecord,
	sanitizeRdfFileName,
} from '../../src/diffusion/writers/rdf.ts';
import { getDiffusionWriter } from '../../src/diffusion/writers/registry.ts';
import * as xmlModule from '../../src/diffusion/writers/xml.ts';
import {
	renderXmlRecord,
	sanitizeXmlNodeName,
	xmlWriter,
} from '../../src/diffusion/writers/xml.ts';
import { markMediaRoot } from '../helpers/media_scratch_root.ts';
// The in-memory merges are the FROZEN ORACLE now (PERF-2/DIFF-4): production
// streams its merge; these pins keep proving the oracle is the old engine's.
import {
	mergeRdfPartsOracle as mergeRdfParts,
	mergeXmlPartsOracle as mergeXmlParts,
} from '../helpers/merge_oracle.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = scratchDir('ts_diffusion_rdfxml_writers');
let savedRoot: string | undefined;

beforeAll(() => {
	savedRoot = process.env.DEDALO_DIFFUSION_FILES_ROOT;
	process.env.DEDALO_DIFFUSION_FILES_ROOT = ROOT;
	// The root producer (published_files.ts) asks the test-media guard for any
	// root it resolves — a scratch root must DECLARE itself one.
	markMediaRoot(ROOT);
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
		id: `rxt_${columnName}`,
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

function plan(
	format: string,
	sections: SectionPlan[],
	serviceName = 'nomisma',
	langs: string[] = ['lg-eng', 'lg-spa'],
): PublicationPlan {
	return {
		planId: `rdfxml_test_${format}`,
		elementTipo: 'test6112',
		format,
		serviceName,
		target: { kind: 'files', serviceName },
		sections,
		recursion: { maxLevels: 2 },
		langPolicy: { langs, mainLang: langs[0] ?? null },
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

/**
 * The rdf-shaped fixture: predicate columnNames + owl:Class tableName, kept
 * VERBATIM by the plan compiler for file formats (compile.ts: "names like
 * 'nmo:TypeSeriesItem' or 'skos:prefLabel' are XML/RDF identities").
 * numisdata_mib really carries these models (owl:Class 'nmo:NumismaticObject',
 * rdf predicates, skos labels).
 */
function rdfSection(): SectionPlan {
	return section('nmo:NumismaticObject', 'test6100', [
		field('dc:title'),
		field('dc:identifier'),
		field('nmo:hasMaterial'),
		field('skos:prefLabel'),
		field('internal_notes', true), // resolution-only: never reaches a file
	]);
}

/** No stray temp artifacts under a directory (atomic-rename proof). */
function tempFilesIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.includes('.tmp-'));
}

/**
 * Hand-rolled well-formedness check (bun:test has no DOMParser): tokenizes
 * tags and verifies balanced nesting. Throws with context on any mismatch.
 */
function assertWellFormedXml(document: string): void {
	const body = document.replace(/<\?xml[^>]*\?>/, '');
	const tagPattern = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
	const stack: string[] = [];
	let cursor = 0;
	let match = tagPattern.exec(body);
	while (match !== null) {
		// no bare '<' or '&' between tags
		const between = body.slice(cursor, match.index);
		expect(between.includes('<')).toBe(false);
		expect(/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(between)).toBe(false);
		const [, closing, name, , selfClosing] = match;
		if (closing === '/') {
			expect(stack.pop()).toBe(name as string);
		} else if (selfClosing !== '/') {
			stack.push(name as string);
		}
		cursor = match.index + match[0].length;
		match = tagPattern.exec(body);
	}
	expect(stack).toEqual([]);
}

/** Minimal PKZIP structural read (shared-suite convention). */
function readZipStructure(zipPath: string): { names: string[]; count: number } {
	const bytes = readFileSync(zipPath);
	expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
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

describe('writer registry (spec §4.3: rdf/xml registered, unknown stays LOUD)', () => {
	test('rdf and xml resolve to their writers', () => {
		expect(getDiffusionWriter('rdf').format).toBe('rdf');
		expect(getDiffusionWriter('xml').format).toBe('xml');
	});

	test('open() rejects a non-files target loudly (both writers)', async () => {
		const tablePlan: PublicationPlan = {
			...plan('rdf', [rdfSection()]),
			target: { kind: 'table', database: 'somedb' },
		};
		await expect(rdfWriter.open(tablePlan)).rejects.toThrow(InvalidFileTargetError);
		await expect(xmlWriter.open({ ...tablePlan, format: 'xml' })).rejects.toThrow(
			InvalidFileTargetError,
		);
	});
});

// ------------------------------------------------------- rdf name grammar

describe('rdf file name grammar (delete-side lockstep)', () => {
	test('sanitizeRdfFileName is byte-equal to diffusion_delete.ts sanitizePublishedFileName', () => {
		const samples = [
			'nmo:NumismaticObject_test6100_1',
			'nmo:TypeSeriesItem_test6101_42',
			'Ítem raro (2ª parte)… ¡ya!_sec1_7',
			'skos:prefLabel__double__underscores_x_9',
			'..dots..and--dashes.._t_3',
		];
		for (const sample of samples) {
			expect(sanitizeRdfFileName(sample)).toBe(sanitizePublishedFileName(sample));
		}
	});

	test('rdfRecordFileName matches the REAL published canonical base name', () => {
		// Real PHP-published files: nmonumismaticobject-test6100-1-*.rdf
		// (media_monedaiberica/rdf/nomisma) — canonical deterministic name is
		// sanitize('nmo:NumismaticObject_test6100_1') + '.rdf'.
		expect(rdfRecordFileName(rdfSection(), 1)).toBe('nmonumismaticobject-test6100-1.rdf');
		expect(rdfRecordFileName(rdfSection(), 56)).toBe('nmonumismaticobject-test6100-56.rdf');
	});
});

// ------------------------------------------------------------ rdf writer

describe('rdf writer', () => {
	const rows2records2langs = [
		row(1, 'lg-eng', {
			'dc:title': 'Iberian coin',
			'dc:identifier': '1',
			'nmo:hasMaterial': 'silver & <bronze>',
			'skos:prefLabel': null, // null column: omitted for this lang
			internal_notes: 'NEVER',
		}),
		row(1, 'lg-spa', {
			'dc:title': 'Moneda ibérica',
			'dc:identifier': '1',
			'nmo:hasMaterial': 'plata',
			'skos:prefLabel': null,
			internal_notes: 'NEVER',
		}),
		row(2, 'lg-eng', {
			'dc:title': 'Second coin',
			'dc:identifier': '2',
			'nmo:hasMaterial': null,
			'skos:prefLabel': 'coin',
			internal_notes: 'NEVER',
		}),
		row(2, 'lg-spa', {
			'dc:title': 'Segunda moneda',
			'dc:identifier': '2',
			'nmo:hasMaterial': null,
			'skos:prefLabel': 'moneda',
			internal_notes: 'NEVER',
		}),
	];

	test('2 records x 2 langs: envelope, namespaces, xml:lang literals, omissions', async () => {
		const sectionPlan = rdfSection();
		const session = await rdfWriter.open(plan('rdf', [sectionPlan], 'svc_rdf'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, rows2records2langs);
		const summary = await session.close();

		const dir = `${ROOT}/rdf/svc_rdf`;
		const doc = readFileSync(`${dir}/nmonumismaticobject-test6100-1.rdf`, 'utf-8');
		expect(existsSync(`${dir}/nmonumismaticobject-test6100-2.rdf`)).toBe(true);

		// ---- REAL-FILE PINS (byte fragments from the PHP-published fixture
		// media_monedaiberica/rdf/nomisma/nmonumismaticobject-test6100-1-*.rdf):
		// EasyRdf declaration (space before '?>')
		expect(doc.startsWith('<?xml version="1.0" encoding="utf-8" ?>\n')).toBe(true);
		// envelope opening + 9-space xmlns continuation indent
		expect(doc).toContain('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"');
		expect(doc).toContain('\n         xmlns:nmo="http://nomisma.org/ontology#"');
		// dc resolves to the purl dcterms URI the real file declares
		expect(doc).toContain('xmlns:dc="http://purl.org/dc/terms/"');
		// 2-space entity indent + 4-space predicate indent, xml:lang alpha2
		expect(doc).toContain('\n  <nmo:NumismaticObject rdf:about="');
		expect(doc).toContain('\n    <dc:title xml:lang="es">Moneda ibérica</dc:title>');
		expect(doc).toContain('\n    <dc:title xml:lang="en">Iberian coin</dc:title>');
		expect(doc.trimEnd().endsWith('</rdf:RDF>')).toBe(true);

		// deterministic urn subject (no dd1010 I/O in writers — ledgered)
		expect(doc).toContain('rdf:about="urn:dedalo:record:test6100:1"');
		// escaping
		expect(doc).toContain('silver &amp; &lt;bronze&gt;');
		// null column omitted; excludeColumn never emitted
		expect(doc).not.toContain('skos:prefLabel');
		expect(doc).not.toContain('NEVER');
		// determinism: no wall-clock anywhere
		expect(doc).not.toMatch(/20\d\d-/);
		assertWellFormedXml(doc);

		// record 2: skos emitted, nmo:hasMaterial omitted
		const doc2 = readFileSync(`${dir}/nmonumismaticobject-test6100-2.rdf`, 'utf-8');
		expect(doc2).toContain('<skos:prefLabel xml:lang="es">moneda</skos:prefLabel>');
		expect(doc2).not.toContain('nmo:hasMaterial>');
		assertWellFormedXml(doc2);

		// summary: per-table counters first, consolidated entries appended
		expect(summary.tables[0]).toEqual({
			table_name: 'nmo:NumismaticObject',
			records_affected: 2,
			records_count: 4,
		});
		expect(summary.errors).toEqual([]);
		expect(tempFilesIn(dir)).toEqual([]);
	});

	test('re-render is byte-identical (determinism gate)', () => {
		const sectionPlan = rdfSection();
		const namespaces = collectRdfNamespaces(sectionPlan);
		const first = renderRdfRecord(sectionPlan, 1, rows2records2langs.slice(0, 2), namespaces);
		const second = renderRdfRecord(sectionPlan, 1, rows2records2langs.slice(0, 2), namespaces);
		expect(first).toBe(second);
	});

	test('rdf:about column overrides the urn subject and is not emitted as predicate', () => {
		const sectionPlan = section('nmo:NumismaticObject', 'test6100', [
			field('rdf:about'),
			field('dc:title'),
		]);
		const doc = renderRdfRecord(
			sectionPlan,
			7,
			[row(7, 'lg-eng', { 'rdf:about': 'https://monedaiberica.org/coin/7', 'dc:title': 'x' })],
			collectRdfNamespaces(sectionPlan),
		);
		expect(doc).toContain('rdf:about="https://monedaiberica.org/coin/7"');
		expect(doc).not.toContain('urn:dedalo:record');
		expect(doc).not.toContain('<rdf:about>');
		assertWellFormedXml(doc);
	});

	test('unknown namespace prefix: urn fallback in the doc + LOUD summary error', async () => {
		const sectionPlan = section('mystery:Thing', 'rxt1', [field('mystery:label')]);
		const session = await rdfWriter.open(plan('rdf', [sectionPlan], 'svc_rdf_unknown'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [row(1, 'lg-eng', { 'mystery:label': 'v' })]);
		const summary = await session.close();
		const doc = readFileSync(
			`${ROOT}/rdf/svc_rdf_unknown/${rdfRecordFileName(sectionPlan, 1)}`,
			'utf-8',
		);
		expect(doc).toContain('xmlns:mystery="urn:dedalo:xmlns:mystery#"');
		expect(summary.errors.length).toBe(1);
		expect(summary.errors[0]).toContain("prefix 'mystery'");
	});

	// DIFF-1: a writer diagnostic reported BEFORE a crash is part of the run's
	// report — it rides the writer checkpoint and is restored by the resume. The
	// resumed batch uses a KNOWN vocabulary, so only the restore can produce it.
	test('a writer error line reported before a crash survives the resume (checkpoint → restore)', async () => {
		const mystery = section('mystery:Thing', 'rxt9', [field('mystery:label')]);
		const known = section('dc:Thing', 'rxt10', [field('dc:title')]);
		const service = 'svc_rdf_resume_errors';
		const jobId = '00000000-0000-4000-8000-000000000301';
		const first = await rdfWriter.open(plan('rdf', [mystery, known], service), {
			jobId,
			resume: null,
		});
		await first.ensureSchema();
		await first.writeRows(mystery, [row(1, 'lg-eng', { 'mystery:label': 'v' })]);
		const events = first.takeArtifacts?.() ?? [];
		const checkpoint = await first.checkpoint?.();
		// the process dies here: no abort, no close
		const resumed = await rdfWriter.open(plan('rdf', [mystery, known], service), {
			jobId,
			resume: checkpoint ?? null,
		});
		await resumed.ensureSchema();
		await resumed.writeRows(known, [row(2, 'lg-eng', { 'dc:title': 'known' })]);
		const summary = await resumed.close(
			localCloseContext([...events, ...(resumed.takeArtifacts?.() ?? [])]),
		);
		expect(
			summary.errors.some((line) => line.includes("prefix 'mystery'")),
			"the resumed run forgot the crashed attempt's writer error line",
		).toBe(true);
	});

	test('invalid QName label throws loudly (labels reach the document verbatim)', async () => {
		const sectionPlan = section('bad label with spaces', 'rxt2', [field('dc:title')]);
		const session = await rdfWriter.open(plan('rdf', [sectionPlan], 'svc_rdf_badname'));
		await session.ensureSchema();
		await expect(
			session.writeRows(sectionPlan, [row(1, 'lg-eng', { 'dc:title': 'v' })]),
		).rejects.toThrow('not a valid XML QName');
	});

	test('removeRecords: canonical + legacy {base}_*.rdf variants, idempotent', async () => {
		const sectionPlan = rdfSection();
		const session = await rdfWriter.open(plan('rdf', [sectionPlan], 'svc_rdf_rm'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, rows2records2langs.slice(0, 2));
		const dir = `${ROOT}/rdf/svc_rdf_rm`;
		// plant a legacy timestamped variant (pre-deterministic naming era)
		const legacy = `${dir}/nmonumismaticobject-test6100-1_2019-01-01.rdf`;
		writeFileSync(legacy, 'legacy');

		const first = await session.removeRecords(sectionPlan, [1]);
		expect(first).toEqual({ written: 0, deleted: 2 }); // canonical + legacy
		expect(existsSync(`${dir}/nmonumismaticobject-test6100-1.rdf`)).toBe(false);
		expect(existsSync(legacy)).toBe(false);

		// second removal: nothing left — idempotent success, zero deletions
		const second = await session.removeRecords(sectionPlan, [1, 999]);
		expect(second).toEqual({ written: 0, deleted: 0 });

		// removed record never reaches merge/zip; run has no surviving files
		const summary = await session.close();
		expect(existsSync(`${dir}/diffusion_rdf_merged.rdf`)).toBe(false);
		expect(existsSync(`${dir}/diffusion_rdf.zip`)).toBe(false);
		expect(summary.tables.some((t) => t.table_name.startsWith('consolidated'))).toBe(false);
	});

	test('close(): type-aware merge (single envelope) + zip + summary mapping', async () => {
		const sectionPlan = rdfSection();
		const session = await rdfWriter.open(plan('rdf', [sectionPlan], 'svc_rdf_merge'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, rows2records2langs);
		const summary = await session.close();

		const dir = `${ROOT}/rdf/svc_rdf_merge`;
		const merged = readFileSync(`${dir}/diffusion_rdf_merged.rdf`, 'utf-8');
		// merged declaration has NO space before '?>' (old engine :84 pin)
		expect(merged.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
		// ONE envelope, both entities
		expect(merged.match(/<rdf:RDF/g)?.length).toBe(1);
		expect(merged.match(/<\/rdf:RDF>/g)?.length).toBe(1);
		expect(merged.match(/<nmo:NumismaticObject /g)?.length).toBe(2);
		assertWellFormedXml(merged);

		const zip = readZipStructure(`${dir}/diffusion_rdf.zip`);
		expect(zip.names.sort()).toEqual([
			'diffusion_rdf_merged.rdf',
			'nmonumismaticobject-test6100-1.rdf',
			'nmonumismaticobject-test6100-2.rdf',
		]);

		// consolidated paths ride the summary as prefixed zero-count entries
		// (runner lifts them into result.consolidated_files {merged_url,zip_url})
		const consolidatedNames = summary.tables.slice(1).map((t) => t.table_name);
		expect(consolidatedNames).toEqual([
			`${CONSOLIDATED_MERGED_PREFIX}/rdf/svc_rdf_merge/diffusion_rdf_merged.rdf`,
			`${CONSOLIDATED_ZIP_PREFIX}/rdf/svc_rdf_merge/diffusion_rdf.zip`,
		]);
		expect(tempFilesIn(dir)).toEqual([]);
	});

	test('abort sweeps NO temps (another session may own them) and leaves finalized records (DIFF-2)', async () => {
		// The target directory is SHARED: a `.tmp-*` in it may be another
		// session's in-flight write. abort() deletes only what it created in that
		// call — every writer temp cleans itself (atomicWriteFile, createZip).
		const sectionPlan = rdfSection();
		const session = await rdfWriter.open(plan('rdf', [sectionPlan], 'svc_rdf_abort'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, rows2records2langs.slice(0, 2));
		const dir = `${ROOT}/rdf/svc_rdf_abort`;
		writeFileSync(`${dir}/diffusion_rdf_merged.rdf.tmp-crashed`, 'partial');
		await session.abort();
		expect(tempFilesIn(dir)).toEqual(['diffusion_rdf_merged.rdf.tmp-crashed']);
		// finalized per-record file stays (idempotent re-publish overwrites it)
		expect(existsSync(`${dir}/nmonumismaticobject-test6100-1.rdf`)).toBe(true);
		expect(existsSync(`${dir}/diffusion_rdf_merged.rdf`)).toBe(false);
	});

	// A crashed holder's temp (createZip / the streamed merge / atomicWriteFile
	// killed mid-write) is reclaimed by the next FENCED close — the runner's
	// close unit, where no other session can own a temp in the directory.
	test("a FENCED close sweeps a dead holder's .tmp-*; an unfenced close leaves it", async () => {
		const sectionPlan = rdfSection();
		const service = 'svc_rdf_tmp_sweep';
		const dir = `${ROOT}/rdf/${service}`;
		const stale = `${dir}/diffusion_rdf.zip.tmp-crashed`;
		const openWritten = async () => {
			const session = await rdfWriter.open(plan('rdf', [sectionPlan], service));
			await session.ensureSchema();
			await session.writeRows(sectionPlan, rows2records2langs.slice(0, 2));
			writeFileSync(stale, 'a partial archive of a dead holder');
			return session;
		};
		await (await openWritten()).close();
		expect(tempFilesIn(dir), 'an UNFENCED close swept a temp').toEqual([
			'diffusion_rdf.zip.tmp-crashed',
		]);
		const fencedSession = await openWritten();
		await fencedSession.close({
			...localCloseContext(fencedSession.takeArtifacts()),
			fenced: true,
		});
		expect(tempFilesIn(dir), "a fenced close left a dead holder's temp behind").toEqual([]);
		expect(existsSync(`${dir}/diffusion_rdf.zip`)).toBe(true);
	});

	// WC-2026-09-30-diffusion-run-ledger: a manifest record whose file is gone is
	// a summary line, skipped — never a crash, never a merged part, never an entry.
	test('a manifest record whose file is GONE: close resolves; merge + archive omit it; the summary names it', async () => {
		const sectionPlan = rdfSection();
		const session = await rdfWriter.open(plan('rdf', [sectionPlan], 'svc_rdf_missing'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, rows2records2langs);
		const dir = `${ROOT}/rdf/svc_rdf_missing`;
		rmSync(`${dir}/nmonumismaticobject-test6100-2.rdf`);
		const summary = await session.close(localCloseContext(session.takeArtifacts()));
		const merged = readFileSync(`${dir}/diffusion_rdf_merged.rdf`, 'utf-8');
		expect(merged.match(/<nmo:NumismaticObject /g)?.length).toBe(1);
		expect(readZipStructure(`${dir}/diffusion_rdf.zip`).names.sort()).toEqual([
			'diffusion_rdf_merged.rdf',
			'nmonumismaticobject-test6100-1.rdf',
		]);
		const missing = summary.errors.filter((line) => line.includes('published file missing'));
		expect(missing).toHaveLength(1);
		expect(missing[0]).toContain('nmonumismaticobject-test6100-2.rdf');
	});

	test('mergeRdfParts: empty → "", single part untouched (old-engine pins)', () => {
		expect(mergeRdfParts([])).toBe('');
		expect(mergeRdfParts(['', '  '])).toBe('');
		const single = '<?xml version="1.0" encoding="utf-8" ?>\n<rdf:RDF>\n<a>1</a>\n</rdf:RDF>\n';
		expect(mergeRdfParts([single])).toBe(single);
	});
});

// ------------------------------------------------------------ xml writer

describe('xml writer', () => {
	function xmlSection(): SectionPlan {
		return section('Coins_DES', 'test6101', [
			field('title'),
			field('inventory'),
			field('secret', true),
		]);
	}

	test('sanitizeXmlNodeName: PHP sanitize_xml_node_name port', () => {
		expect(sanitizeXmlNodeName('Coins_DES')).toBe('Coins_DES');
		expect(sanitizeXmlNodeName('nmo:hasMaterial')).toBe('nmo_hasMaterial');
		expect(sanitizeXmlNodeName('1abc')).toBe('_1abc');
		expect(sanitizeXmlNodeName('.start')).toBe('_.start');
		expect(sanitizeXmlNodeName('xmlData')).toBe('xxmlData');
		expect(sanitizeXmlNodeName('XMLthing')).toBe('xXMLthing');
		expect(sanitizeXmlNodeName('tí tulo')).toBe('t__tulo');
	});

	test('2 records x 2 langs: declaration, root, per-lang alpha2 children, omissions', async () => {
		const sectionPlan = xmlSection();
		const session = await xmlWriter.open(plan('xml', [sectionPlan], 'svc_xml'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(5777, 'lg-eng', { title: 'My title', inventory: 'inv & <tag>', secret: 'NEVER' }),
			row(5777, 'lg-spa', { title: 'Mi título', inventory: null, secret: 'NEVER' }),
			row(5778, 'lg-eng', { title: null, inventory: null }),
			row(5778, 'lg-spa', { title: 'Solo español', inventory: null }),
		]);
		const summary = await session.close();

		const dir = `${ROOT}/xml/svc_xml`;
		// EXACT delete-side grammar: {section_tipo}_{section_id}.xml
		// (diffusion_delete.ts:367-369 / PHP class.diffusion_xml.php:565)
		const doc = readFileSync(`${dir}/test6101_5777.xml`, 'utf-8');
		expect(existsSync(`${dir}/test6101_5778.xml`)).toBe(true);

		// PHP DOMDocument declaration (real v6-published fixture pin:
		// media_mib/xml/test6101_5777_*.xml)
		expect(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
		expect(doc).toContain('<Coins_DES>');
		expect(doc.trimEnd().endsWith('</Coins_DES>')).toBe(true);
		// per-lang alpha2 children, 2-space nesting (PHP formatOutput)
		expect(doc).toContain('\n  <title>\n    <en>My title</en>\n    <es>Mi título</es>\n  </title>');
		// null lang value omitted; escaping applied
		expect(doc).toContain('<inventory>\n    <en>inv &amp; &lt;tag&gt;</en>\n  </inventory>');
		expect(doc).not.toContain('NEVER');
		expect(doc).not.toMatch(/20\d\d-/); // determinism: no wall-clock
		assertWellFormedXml(doc);

		// record with all-null title lang still renders the valued lang only
		const doc2 = readFileSync(`${dir}/test6101_5778.xml`, 'utf-8');
		expect(doc2).toContain('<es>Solo español</es>');
		expect(doc2).not.toContain('<en>');
		expect(doc2).not.toContain('<inventory');
		assertWellFormedXml(doc2);

		expect(summary.tables[0]).toEqual({
			table_name: 'Coins_DES',
			records_affected: 2,
			records_count: 4,
		});
		expect(tempFilesIn(dir)).toEqual([]);
	});

	test('lang-null rows render inline values (nolan single-lang PHP case)', () => {
		const sectionPlan = section('Coins_DES', 'test6101', [field('title'), field('empty')]);
		const doc = renderXmlRecord(sectionPlan, [row(9, null, { title: 'plain', empty: '' })]);
		expect(doc).toContain('  <title>plain</title>');
		// empty string renders an empty element (PHP createElement, no text child)
		expect(doc).toContain('  <empty/>');
		assertWellFormedXml(doc);
	});

	test('removeRecords unlinks; missing file is idempotent success', async () => {
		const sectionPlan = xmlSection();
		const session = await xmlWriter.open(plan('xml', [sectionPlan], 'svc_xml_rm'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [row(3, 'lg-eng', { title: 'gone soon' })]);

		const first = await session.removeRecords(sectionPlan, [3]);
		expect(first).toEqual({ written: 0, deleted: 1 });
		expect(existsSync(`${ROOT}/xml/svc_xml_rm/test6101_3.xml`)).toBe(false);

		const second = await session.removeRecords(sectionPlan, [3, 99]);
		expect(second).toEqual({ written: 0, deleted: 0 });

		const summary = await session.close();
		expect(existsSync(`${ROOT}/xml/svc_xml_rm/diffusion_xml.zip`)).toBe(false);
		expect(summary.tables.some((t) => t.table_name.startsWith('consolidated'))).toBe(false);
	});

	test('close(): merged document under the first root + zip + summary mapping', async () => {
		const sectionPlan = xmlSection();
		const session = await xmlWriter.open(plan('xml', [sectionPlan], 'svc_xml_merge'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { title: 'one' }),
			row(2, 'lg-eng', { title: 'two' }),
		]);
		const summary = await session.close();

		const dir = `${ROOT}/xml/svc_xml_merge`;
		const merged = readFileSync(`${dir}/diffusion_xml_merged.xml`, 'utf-8');
		expect(merged.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(true);
		// ONE root wrapping both records' children (old merge_xml_parts pin)
		expect(merged.match(/<Coins_DES>/g)?.length).toBe(1);
		expect(merged.match(/<\/Coins_DES>/g)?.length).toBe(1);
		expect(merged.match(/<title>/g)?.length).toBe(2);
		assertWellFormedXml(merged);

		const zip = readZipStructure(`${dir}/diffusion_xml.zip`);
		expect(zip.names.sort()).toEqual([
			'diffusion_xml_merged.xml',
			'test6101_1.xml',
			'test6101_2.xml',
		]);

		const consolidatedNames = summary.tables.slice(1).map((t) => t.table_name);
		expect(consolidatedNames).toEqual([
			`${CONSOLIDATED_MERGED_PREFIX}/xml/svc_xml_merge/diffusion_xml_merged.xml`,
			`${CONSOLIDATED_ZIP_PREFIX}/xml/svc_xml_merge/diffusion_xml.zip`,
		]);
		expect(tempFilesIn(dir)).toEqual([]);
	});

	test('abort sweeps NO temps (another session may own them) and leaves finalized records (DIFF-2)', async () => {
		const sectionPlan = xmlSection();
		const session = await xmlWriter.open(plan('xml', [sectionPlan], 'svc_xml_abort'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [row(1, 'lg-eng', { title: 'kept' })]);
		const dir = `${ROOT}/xml/svc_xml_abort`;
		writeFileSync(`${dir}/diffusion_xml_merged.xml.tmp-crashed`, 'partial');
		await session.abort();
		expect(tempFilesIn(dir)).toEqual(['diffusion_xml_merged.xml.tmp-crashed']);
		expect(existsSync(`${dir}/test6101_1.xml`)).toBe(true);
	});

	test("a FENCED close sweeps a dead holder's .tmp-*; an unfenced close leaves it", async () => {
		const sectionPlan = xmlSection();
		const service = 'svc_xml_tmp_sweep';
		const dir = `${ROOT}/xml/${service}`;
		const stale = `${dir}/diffusion_xml_merged.xml.tmp-crashed`;
		const openWritten = async () => {
			const session = await xmlWriter.open(plan('xml', [sectionPlan], service));
			await session.ensureSchema();
			await session.writeRows(sectionPlan, [row(1, 'lg-eng', { title: 'one' })]);
			writeFileSync(stale, 'a partial merge of a dead holder');
			return session;
		};
		await (await openWritten()).close();
		expect(tempFilesIn(dir), 'an UNFENCED close swept a temp').toEqual([
			'diffusion_xml_merged.xml.tmp-crashed',
		]);
		const fencedSession = await openWritten();
		await fencedSession.close({
			...localCloseContext(fencedSession.takeArtifacts()),
			fenced: true,
		});
		expect(tempFilesIn(dir), "a fenced close left a dead holder's temp behind").toEqual([]);
		expect(existsSync(`${dir}/diffusion_xml.zip`)).toBe(true);
	});

	test('a manifest record whose file is GONE: close resolves; merge + archive omit it; the summary names it', async () => {
		const sectionPlan = xmlSection();
		const session = await xmlWriter.open(plan('xml', [sectionPlan], 'svc_xml_missing'));
		await session.ensureSchema();
		await session.writeRows(sectionPlan, [
			row(1, 'lg-eng', { title: 'one' }),
			row(2, 'lg-eng', { title: 'two' }),
			row(3, 'lg-eng', { title: 'three' }),
		]);
		const dir = `${ROOT}/xml/svc_xml_missing`;
		rmSync(`${dir}/test6101_2.xml`);
		const summary = await session.close(localCloseContext(session.takeArtifacts()));
		const merged = readFileSync(`${dir}/diffusion_xml_merged.xml`, 'utf-8');
		expect(merged.match(/<title>/g)?.length).toBe(2);
		expect(merged).not.toContain('two');
		expect(readZipStructure(`${dir}/diffusion_xml.zip`).names.sort()).toEqual([
			'diffusion_xml_merged.xml',
			'test6101_1.xml',
			'test6101_3.xml',
		]);
		const missing = summary.errors.filter((line) => line.includes('published file missing'));
		expect(missing).toHaveLength(1);
		expect(missing[0]).toContain('test6101_2.xml');
	});

	test('mergeXmlParts: empty → "", single part untouched', () => {
		expect(mergeXmlParts([])).toBe('');
		const single = '<?xml version="1.0" encoding="UTF-8"?>\n<r>\n  <a>1</a>\n</r>\n';
		expect(mergeXmlParts([single])).toBe(single);
	});
});

// ---------------------------------------------------------------- shared

describe('lang mapping (PHP lang::get_alpha2_from_code)', () => {
	test('known codes map, unknown codes degrade deterministically', () => {
		expect(langToAlpha2('lg-eng')).toBe('en');
		expect(langToAlpha2('lg-spa')).toBe('es');
		expect(langToAlpha2('lg-cat')).toBe('ca');
		expect(langToAlpha2('lg-zzz')).toBe('zz');
	});
});

// ------------------------------------------------ streamed merge == oracle

/**
 * PERF-2/DIFF-4 — the consolidated rdf/xml document is merged STREAMED (one part
 * in memory at a time, plus the held-back first) and must equal, byte for byte,
 * the frozen in-memory oracle (test/helpers/merge_oracle.ts) over every shape a
 * part can take: none, one, whitespace-only, a BOM (kept — the parts are read as
 * utf-8 text, never through a BOM-stripping decoder; the `BOM visible` cases are
 * the ones whose OUTPUT carries it — with two rooted parts the envelope is a
 * constant header and a stripped BOM is invisible), a first or later part
 * without the root, CRLF, multibyte — and a seeded fuzz of all of them.
 */
type StreamedMerge = (
	paths: AsyncIterable<string>,
	outPath: string,
	onMissing?: (path: string) => void,
) => Promise<{ parts: number }>;

const MERGE_DIR = `${ROOT}/streamed_merge`;
let mergeCase = 0;

async function* iterate(paths: string[]): AsyncIterable<string> {
	for (const path of paths) yield path;
}

/** Write `parts` as files, run the production streamed merge, return what it wrote. */
async function streamedMerge(merge: unknown, name: string, parts: string[]): Promise<string> {
	expect(typeof merge, `${name} is not exported: the production merge is not streamed`).toBe(
		'function',
	);
	const dir = `${MERGE_DIR}/${mergeCase++}`;
	mkdirSync(dir, { recursive: true });
	const paths = parts.map((part, index) => {
		const path = `${dir}/part_${index}`;
		writeFileSync(path, part, 'utf-8');
		return path;
	});
	const outPath = `${dir}/merged.out`;
	await (merge as StreamedMerge)(iterate(paths), outPath);
	return existsSync(outPath) ? readFileSync(outPath, 'utf-8') : '';
}

const RDF_A =
	'<?xml version="1.0" encoding="utf-8" ?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n         xmlns:dc="http://purl.org/dc/elements/1.1/">\n\n<rdf:Description rdf:about="a"><dc:title>A</dc:title></rdf:Description>\n\n</rdf:RDF>\n';
const RDF_B =
	'<?xml version="1.0" encoding="utf-8" ?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n\n<rdf:Description rdf:about="b"><dc:title>B ñ€𝄞</dc:title></rdf:Description>\n\n</rdf:RDF>\n';
const XML_A = '<?xml version="1.0" encoding="utf-8"?>\n<root a="1">\n  <rec>1</rec>\n</root>\n';
const XML_B = '<?xml version="1.0" encoding="utf-8"?>\n<root a="2">\n  <rec>2 ñ€𝄞</rec>\n</root>\n';

const RDF_CASES: Record<string, string[]> = {
	'no part': [],
	'one part (returned verbatim)': [RDF_A],
	'two parts': [RDF_A, RDF_B],
	'whitespace-only parts dropped': ['  \n', RDF_A, '\t', RDF_B, ''],
	'a BOM on the first part': [`\uFEFF${RDF_A}`, RDF_B],
	'BOM visible: a single part keeps its BOM': [`\uFEFF${RDF_A}`],
	'BOM visible: the only non-empty part keeps its BOM': [' ', `\uFEFF${RDF_B}`],
	'first part without the root': ['not rdf at all', RDF_A, RDF_B],
	'a later part without the root': [RDF_A, 'stray text', RDF_B],
	CRLF: [RDF_A.replace(/\n/g, '\r\n'), RDF_B.replace(/\n/g, '\r\n')],
	'one non-empty among blanks': [' ', RDF_B, '\n\n'],
};
const XML_CASES: Record<string, string[]> = {
	'no part': [],
	'one part (returned verbatim)': [XML_A],
	'two parts': [XML_A, XML_B],
	'whitespace-only parts dropped': ['  \n', XML_A, '\t', XML_B, ''],
	'a BOM on the first part': [`\uFEFF${XML_A}`, XML_B],
	'BOM visible: a single part keeps its BOM': [`\uFEFF${XML_A}`],
	'BOM visible: a no-root first part keeps its BOM': [`\uFEFFplain text`, XML_A],
	'first part without a root (joined with a newline)': ['plain text', XML_A, XML_B],
	'a later part without the root (included trimmed)': [XML_A, '  <other>x</other>  ', XML_B],
	CRLF: [XML_A.replace(/\n/g, '\r\n'), XML_B.replace(/\n/g, '\r\n')],
};

/** Deterministic PRNG (mulberry32) — the fuzz is seeded, never wall-clock. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function fuzzParts(random: () => number, pool: string[]): string[] {
	const count = Math.floor(random() * 6);
	return Array.from({ length: count }, () => {
		let part = pool[Math.floor(random() * pool.length)] as string;
		if (random() < 0.2) part = `\uFEFF${part}`;
		if (random() < 0.2) part = part.replace(/\n/g, '\r\n');
		if (random() < 0.15) part = `  ${part}\n\n`;
		return part;
	});
}
const FUZZ_SEED = 20260930;
const FUZZ_ROUNDS = 60;

describe('streamed merge == frozen oracle (PERF-2/DIFF-4)', () => {
	for (const [name, parts] of Object.entries(RDF_CASES)) {
		test(`rdf: ${name}`, async () => {
			const merged = await streamedMerge(
				(rdfModule as Record<string, unknown>).writeMergedRdf,
				'writeMergedRdf',
				parts,
			);
			// A BOM case must carry the BOM INTO the merged bytes, or it gates nothing
			// (with two rooted parts the envelope is a constant header).
			if (name.startsWith('BOM visible')) expect(mergeRdfParts(parts)).toContain('\uFEFF');
			expect(merged).toBe(mergeRdfParts(parts));
		});
	}
	for (const [name, parts] of Object.entries(XML_CASES)) {
		test(`xml: ${name}`, async () => {
			const merged = await streamedMerge(
				(xmlModule as Record<string, unknown>).writeMergedXml,
				'writeMergedXml',
				parts,
			);
			if (name.startsWith('BOM visible')) expect(mergeXmlParts(parts)).toContain('\uFEFF');
			expect(merged).toBe(mergeXmlParts(parts));
		});
	}
	test(`rdf + xml: seeded fuzz (${FUZZ_ROUNDS} rounds each, seed ${FUZZ_SEED})`, async () => {
		const random = prng(FUZZ_SEED);
		for (let round = 0; round < FUZZ_ROUNDS; round++) {
			const rdfParts = fuzzParts(random, [RDF_A, RDF_B, 'junk', ' ', '']);
			expect(
				await streamedMerge(
					(rdfModule as Record<string, unknown>).writeMergedRdf,
					'writeMergedRdf',
					rdfParts,
				),
			).toBe(mergeRdfParts(rdfParts));
			const xmlParts = fuzzParts(random, [XML_A, XML_B, '<other/>', ' ', '']);
			expect(
				await streamedMerge(
					(xmlModule as Record<string, unknown>).writeMergedXml,
					'writeMergedXml',
					xmlParts,
				),
			).toBe(mergeXmlParts(xmlParts));
		}
	});
});

/**
 * The merge reads a part AFTER manifestPaths checked it exists, and a hand
 * outside the engine can remove it in that window (the engine's files-unlink
 * door takes the close's fence — WC R2, closed 2026-10-01). It is the same fact as a missing part — a
 * line through onMissing, the rest merged — never a throw that fails the run.
 */
describe('a part GONE between the manifest pass and the merge read', () => {
	/** Yields every path; `victim` is unlinked just before it is yielded (existence was seen earlier). */
	async function* unlinkedOnTheWay(paths: string[], victim: string): AsyncIterable<string> {
		for (const path of paths) {
			if (path === victim) rmSync(path);
			yield path;
		}
	}

	for (const [format, name, parts, oracle] of [
		['rdf', 'writeMergedRdf', [RDF_A, RDF_B, RDF_A], mergeRdfParts],
		['xml', 'writeMergedXml', [XML_A, XML_B, XML_A], mergeXmlParts],
	] as const) {
		test(`${format}: the merge resolves, omits the vanished part and reports it`, async () => {
			const merge = (format === 'rdf' ? rdfModule : xmlModule) as Record<string, unknown>;
			expect(typeof merge[name]).toBe('function');
			const dir = `${MERGE_DIR}/${mergeCase++}`;
			mkdirSync(dir, { recursive: true });
			const paths = parts.map((part, index) => {
				const path = `${dir}/part_${index}`;
				writeFileSync(path, part, 'utf-8');
				return path;
			});
			const victim = paths[1] as string;
			const reported: string[] = [];
			const outPath = `${dir}/merged.out`;
			const { parts: merged } = await (merge[name] as StreamedMerge)(
				unlinkedOnTheWay(paths, victim),
				outPath,
				(path) => reported.push(path),
			);
			expect(reported, 'the vanished part was not reported through onMissing').toEqual([victim]);
			expect(merged).toBe(2);
			expect(readFileSync(outPath, 'utf-8')).toBe(oracle([parts[0], parts[2]]));
		});
	}
});

/**
 * The close reads the manifest TWICE (merge, then zip) and a hand outside the
 * engine can remove a record file BETWEEN the two (the engine's files-unlink
 * door cannot: it takes the close's fence): that record lands in the merged
 * document and is missing from the archive. The two artifacts then disagree —
 * the close must SAY so (a summary line naming the file), never omit it
 * silently, and never fail the run.
 */
describe('a record GONE between the merge pass and the zip pass', () => {
	for (const format of ['rdf', 'xml'] as const) {
		test(`${format}: close resolves; the archive omits it and the summary names it`, async () => {
			const service = `svc_${format}_gone_mid_close`;
			const dir = `${ROOT}/${format}/${service}`;
			const sectionPlan =
				format === 'rdf' ? rdfSection() : section('Coins_DES', 'test6101', [field('title')]);
			const session = await (format === 'rdf' ? rdfWriter : xmlWriter).open(
				plan(format, [sectionPlan], service),
			);
			await session.ensureSchema();
			await session.writeRows(
				sectionPlan,
				format === 'rdf'
					? [
							row(1, 'lg-eng', { 'dc:title': 'one', 'dc:identifier': '1' }),
							row(2, 'lg-eng', { 'dc:title': 'two', 'dc:identifier': '2' }),
						]
					: [row(1, 'lg-eng', { title: 'one' }), row(2, 'lg-eng', { title: 'two' })],
			);
			const recordFiles = readdirSync(dir)
				.filter((name) => !name.includes('.tmp-'))
				.sort();
			expect(recordFiles).toHaveLength(2);
			const victim = recordFiles[1] as string;
			const base = localCloseContext(session.takeArtifacts?.() ?? []);
			let passes = 0;
			const summary = await session.close({
				...base,
				manifest() {
					passes++;
					if (passes === 2) rmSync(`${dir}/${victim}`); // after the merge, before the zip
					return base.manifest();
				},
			});
			expect(passes, 'the close no longer reads the manifest twice — re-aim this leg').toBe(2);
			const zip = readZipStructure(`${dir}/diffusion_${format}.zip`);
			expect(zip.names).not.toContain(victim);
			expect(zip.names).toContain(recordFiles[0] as string);
			expect(
				summary.errors.some((line) => line.includes(victim)),
				'the archive omits a record the merged document holds, and no summary line says so',
			).toBe(true);
		});
	}
});
