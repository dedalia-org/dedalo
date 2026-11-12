/**
 * TRIPWIRE: diffusion publish/delete identifier LOCKSTEP + server-authoritative
 * publication scope (DIFF-A / DIFF-B, 2026-07-28 audit).
 *
 * DIFF-A — publish sanitized ontology labels into SQL identifiers while delete
 * used the RAW labels, so `Web`→published `web` but deleted `` `Web` ``; the
 * errno-1146 miss was counted as a successful unpublish and the record stayed
 * live in the public tier. Fix: ONE sanitizer (src/core/db/sql_identifier.ts)
 * used by BOTH sides — the publish plan (src/diffusion/plan/identifier re-exports
 * it) and the delete map (src/core/diffusion_bridge/diffusion_map, which cannot
 * import src/diffusion/**). Source invariant: the delete map routes db/table
 * names through requireSqlIdentifier, and the shared sanitizer lives in core.
 *
 * DIFF-B — `diffuse` trusted client options: skip_publication_state_check turned
 * the fail-closed per-record publication gate OFF, and `levels` was unclamped.
 * Fix: the enqueue path gates the bypass on isGlobalAdmin and clamps levels.
 *
 * PUB-03 (audit 2026-08-26, P1-12) — PATH lockstep for the FILE half, measured
 * as an OUTCOME, not a spelling: for EVERY file writer the registry serves
 * (census TOTAL over WRITER_REGISTRY minus the table formats), a file planted
 * at the path the ONE producer names (core/diffusion_bridge/published_files.ts
 * — what the delete side resolves) is the file that writer's own
 * removeRecords unlinks; a full-export format (csv/json) has NO per-record
 * path on either side and the delete side classifies it TERMINAL. The two
 * sanitizers are one function object. Hermetic: a marked scratch root, no DB.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	resolvePublishedFile,
	sanitizePublishedFileName,
} from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import {
	PER_RECORD_FILE_FORMATS,
	sanitizePublishedFileName as producerSanitize,
	publishedRecordFilePath,
} from '../../src/core/diffusion_bridge/published_files.ts';
import { TABLE_FORMATS } from '../../src/diffusion/plan/formats.ts';
import type { PublicationPlan, SectionPlan } from '../../src/diffusion/plan/types.ts';
import { diffusionFilesRoot } from '../../src/diffusion/writers/files.ts';
import { sanitizeRdfFileName } from '../../src/diffusion/writers/rdf.ts';
import { getDiffusionWriter, WRITER_REGISTRY } from '../../src/diffusion/writers/registry.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';

const ROOT = join(import.meta.dir, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('DIFF-A — publish/delete identifier lockstep', () => {
	test('the shared sanitizer lives in core (importable by both sides)', () => {
		const core = read('src/core/db/sql_identifier.ts');
		expect(core.includes('export function requireSqlIdentifier')).toBe(true);
		expect(core.includes('export function sanitizeSqlName')).toBe(true);
	});

	test('the delete map sanitizes db/table names through requireSqlIdentifier', () => {
		// The walk moved to the pure graph module (Tier-3 3.9 extraction); the
		// sanitizer chokepoint moved WITH it — assert it there, and assert the
		// map still drives that walk (no second, unsanitized materializer).
		const graph = read('src/core/diffusion_bridge/diffusion_graph.ts');
		expect(graph.includes("from '../db/sql_identifier.ts'")).toBe(true);
		expect(graph.includes("requireSqlIdentifier(hit.element.database, 'database')")).toBe(true);
		expect(graph.includes("requireSqlIdentifier(hit.table, 'table')")).toBe(true);
		const map = read('src/core/diffusion_bridge/diffusion_map.ts');
		expect(map.includes('walkDiffusionTargets')).toBe(true);
	});

	test('the publish plan uses the SAME sanitizer (re-exported from core)', () => {
		const id = read('src/diffusion/plan/identifier.ts');
		expect(id.includes("from '../../core/db/sql_identifier.ts'")).toBe(true);
		expect(id.includes('requireSqlIdentifier')).toBe(true);
	});
});

describe('DIFF-B — publication scope is server-authoritative', () => {
	const actions = read('src/diffusion/api/actions.ts');

	test('skip_publication_state_check is stripped for non-admins', () => {
		expect(actions.includes('principal.isGlobalAdmin')).toBe(true);
		expect(actions.includes('delete runnerOptions.skip_publication_state_check')).toBe(true);
	});

	test('the recursion budget is clamped to the server ceiling', () => {
		expect(actions.includes('diffusionResolveLevels()')).toBe(true);
		expect(actions.includes('Math.min(requestedLevels, diffusionResolveLevels())')).toBe(true);
	});
});

describe('PUB-03 — publish/delete PATH lockstep, TOTAL over the file writers', () => {
	const SERVICE = 'lock_svc';
	const SECTION = 'zzlk1';
	const RDF_LABEL = 'nmo:LockClass';
	const RECORD = 7;
	const OTHER = 8;
	let root = '';
	let savedRoot: string | undefined;

	beforeAll(() => {
		root = scratchMediaRoot('dedalo_scope_lockstep_');
		savedRoot = process.env.DEDALO_DIFFUSION_FILES_ROOT;
		process.env.DEDALO_DIFFUSION_FILES_ROOT = root;
	});

	afterAll(() => {
		if (savedRoot !== undefined) process.env.DEDALO_DIFFUSION_FILES_ROOT = savedRoot;
		else delete process.env.DEDALO_DIFFUSION_FILES_ROOT;
		rmSync(root, { recursive: true, force: true });
	});

	const section: SectionPlan = {
		sectionTipo: SECTION,
		tableName: RDF_LABEL,
		tableTipo: 'zzlk2',
		fields: [],
	};
	const planFor = (format: string): PublicationPlan => ({
		planId: `scope_lockstep_${format}`,
		elementTipo: 'zzlk0',
		format,
		serviceName: SERVICE,
		target: { kind: 'files', serviceName: SERVICE },
		sections: [section],
		recursion: { maxLevels: 1 },
		langPolicy: { langs: ['lg-eng'], mainLang: 'lg-eng' },
		warnings: [],
		// an rdf plan carries its compiled element (T1-4) — the writer refuses one without it
		...(format === 'rdf' ? { rdf: { namespaces: [], serviceType: 'lockstep' } } : {}),
	});

	/** The census: every writer the registry serves that is not a MariaDB table format. */
	const fileFormats = [...WRITER_REGISTRY.keys()].filter((format) => !TABLE_FORMATS.has(format));

	test('the census is the registry (floor 5) and both halves of the classification are represented', () => {
		expect(fileFormats.length).toBeGreaterThanOrEqual(5);
		expect(
			fileFormats.filter((format) => PER_RECORD_FILE_FORMATS.has(format)).length,
		).toBeGreaterThanOrEqual(3);
		expect(
			fileFormats.filter((format) => !PER_RECORD_FILE_FORMATS.has(format)).length,
		).toBeGreaterThanOrEqual(2);
		// The writers' root IS the producer's (the re-export): the same directory both sides write under.
		expect(diffusionFilesRoot()).toBe(root);
	});

	for (const format of fileFormats) {
		test(`${format}: the producer's per-record path is what the writer's removeRecords unlinks (or neither side has one)`, async () => {
			const producerPath = publishedRecordFilePath({
				root,
				type: format,
				dirLabel: SERVICE,
				sectionTipo: SECTION,
				sectionId: RECORD,
				rdfName: RDF_LABEL,
			});
			const session = await getDiffusionWriter(format).open(planFor(format));
			try {
				await session.ensureSchema();
				if (!PER_RECORD_FILE_FORMATS.has(format)) {
					// FULL-EXPORT: no per-record file on either side, and the delete side
					// says TERMINAL before touching any store (pure classification).
					expect(producerPath).toBeNull();
					const removed = await session.removeRecords(section, [RECORD]);
					expect(removed.deleted).toBe(0);
					const classified = await resolvePublishedFile('zzlk0', format, SECTION, RECORD, root);
					expect(classified.kind).toBe('terminal');
					return;
				}
				expect(producerPath).not.toBeNull();
				const path = producerPath as string;
				expect(path.startsWith(`${root}/${format}/${SERVICE}/`)).toBe(true);
				// Plant the record's file at the PRODUCER's path, and a positive
				// control: ANOTHER record's file the unlink must not touch.
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, 'published');
				const otherPath = publishedRecordFilePath({
					root,
					type: format,
					dirLabel: SERVICE,
					sectionTipo: SECTION,
					sectionId: OTHER,
					rdfName: RDF_LABEL,
				}) as string;
				writeFileSync(otherPath, 'published');

				const removed = await session.removeRecords(section, [RECORD]);
				expect(
					removed.deleted,
					`${format}: the writer did not find the file at the producer's path`,
				).toBe(1);
				expect(existsSync(path)).toBe(false);
				expect(existsSync(otherPath)).toBe(true);
			} finally {
				await session.abort();
			}
		});
	}

	test('ONE sanitizer: the rdf writer, the delete side and the producer are the same function object', () => {
		expect(sanitizeRdfFileName).toBe(producerSanitize);
		expect(sanitizePublishedFileName).toBe(producerSanitize);
		expect(producerSanitize('nmo:LockClass_zzlk1_7')).toBe('nmolockclass-zzlk1-7');
	});
});
