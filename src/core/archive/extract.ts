/**
 * ARCHIVE EXTRACTION — the ONE complete, self-describing extraction of a
 * section set (audit 2026-08-26 P1-10; DATA-10/11/13).
 *
 * WHY A NEW DOOR. Every existing door was enumerated and none is an archive:
 * `pg_dump` is a Postgres container; `tool_export`'s `dedalo_raw` CSV is one
 * section at a time, re-runs the HUMAN-INPUT conform over machine cells on the
 * way back (component_text_area rewrites markup, component_geolocation loses
 * the item id), carries install-local addresses nobody checks, and no bytes;
 * the value formats are display strings; diffusion covers the published subset.
 *
 * WHAT THIS DOOR DOES INSTEAD. It reads each record's ELEVEN jsonb columns as
 * Postgres canonical text — never parsed, never conformed, never re-shaped —
 * and writes them with the ontology subtree that gives them meaning, the media
 * files they own (with digests), and a locator census that names every address
 * pointing outside the set, so the restore can refuse to re-point heritage
 * links at whatever record holds that id elsewhere. The artifact is a
 * directory; its definition is engineering/ARCHIVE_FORMAT.md; the gate that
 * proves the round trip is test/unit/raw_roundtrip_native.test.ts.
 *
 * READ-ONLY on the database. On disk it writes ONLY under `outDir`, which must
 * not already exist (an archive is never merged into a directory that holds
 * something else).
 *
 * SHAPE OF THIS MODULE. One orchestrator (`extractArchive`) over small,
 * single-purpose steps — each step is a function a reader can hold whole and
 * the complexity ratchet (crap_complexity_ratchet) can cap at 6.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { type DdOntologyRow, readDdOntologyRow } from '../db/dd_ontology.ts';
import {
	MATRIX_JSONB_COLUMNS,
	type MatrixJsonbColumn,
	type MatrixRecord,
	readExistingSectionIds,
	readMatrixRecordBatch,
	readSectionIdsOfSection,
} from '../db/matrix.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { listSectionMediaFiles } from '../media/file_ops.ts';
import { requireMediaRoot } from '../media/path.ts';
import {
	getMatrixTableFromTipo,
	getRecursiveChildrenTipos,
	getSectionRealTipo,
} from '../ontology/resolver.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import {
	ARCHIVE_FORMAT,
	ARCHIVE_FORMAT_VERSION,
	type ArchiveAddress,
	type ArchiveManifest,
	type ArchiveMediaFile,
	type ArchiveOntology,
	type ArchiveRecordLine,
	type ArchiveSection,
	addressesOf,
	addressKey,
	type ExternalReference,
	MANIFEST_FILE,
	MEDIA_DIR,
	mediaArchivePath,
	NOT_ARCHIVED,
	ONTOLOGY_FILE,
	ontologyDigest,
	RECORDS_DIR,
	sha256File,
	sha256Hex,
} from './manifest.ts';

export interface ExtractOptions {
	/** The sections to archive — every record of each. */
	sectionTipos: readonly string[];
	/** Directory to create. Refused when it already exists. */
	outDir: string;
	/** Scratch-root seam (gates); production omits it and the configured root is used. */
	mediaRoot?: string;
	/** Records read per batch. */
	batchSize?: number;
}

export interface ExtractOutcome {
	outDir: string;
	manifest: ArchiveManifest;
}

const DEFAULT_BATCH = 500;

function refuse(message: string, coordinates: Record<string, string | number> = {}): never {
	throw new DedaloError('archive.refused', { message: `archive extract: ${message}`, coordinates });
}

// ── steps ───────────────────────────────────────────────────────────────────

/** Every named tipo must resolve to a table BEFORE anything is written. */
async function resolveSectionTables(sectionTipos: readonly string[]): Promise<Map<string, string>> {
	const tables = new Map<string, string>();
	for (const tipo of sectionTipos) {
		const table = await getMatrixTableFromTipo(tipo);
		if (table === null) {
			throw new DedaloError('section.no_matrix_table', {
				message: `archive extract: '${tipo}' is not a section of this ontology (no matrix table resolves)`,
				coordinates: { section_tipo: tipo },
			});
		}
		tables.set(tipo, table);
	}
	return tables;
}

/** The rows of one root and its recursive children, added to `subtree` (first read wins). */
async function collectSubtree(root: string, subtree: Map<string, DdOntologyRow>): Promise<void> {
	for (const nodeTipo of [root, ...(await getRecursiveChildrenTipos(root))]) {
		if (subtree.has(nodeTipo)) continue;
		const row = await readDdOntologyRow(nodeTipo);
		if (row !== null) subtree.set(nodeTipo, row);
	}
}

/**
 * The dd_ontology rows that give the archived records their meaning, keyed by
 * tipo, and the REAL section of every archived one.
 *
 * A VIRTUAL section (a thesaurus hierarchy, an alias — `getSectionRealTipo`
 * returns another tipo) stores its records under the REAL section's component
 * tipos: its own children are list/exclusion decorations. An archive of the
 * virtual section alone must therefore carry the real section's subtree too,
 * or no column key of its records is defined anywhere in the artifact and the
 * restore into an install lacking the real section resolves no table. The
 * same law every child-by-model lookup follows (AGENTS.md "Virtual sections").
 */
async function readSubtree(
	sectionTipos: readonly string[],
): Promise<{ subtree: Map<string, DdOntologyRow>; realOf: Map<string, string> }> {
	const subtree = new Map<string, DdOntologyRow>();
	const realOf = new Map<string, string>();
	for (const tipo of sectionTipos) {
		const real = await getSectionRealTipo(tipo);
		realOf.set(tipo, real);
		await collectSubtree(tipo, subtree);
		if (real !== tipo) await collectSubtree(real, subtree);
	}
	return { subtree, realOf };
}

/**
 * Context rows the subtree names but does not contain: the relation targets of
 * every section node (its matrix_table node among them) and the model node of
 * every archived node. Locator-target sections join later, from the census.
 */
function referencedBySubtree(subtree: Map<string, DdOntologyRow>): Set<string> {
	const referenced = new Set<string>();
	for (const row of subtree.values()) {
		if (row.model_tipo !== null) referenced.add(row.model_tipo);
		if (row.model !== 'section') continue;
		for (const relation of row.relations ?? []) referenced.add(relation.tipo);
	}
	return referenced;
}

/** The locator census being taken while the records are read. */
interface AddressCensus {
	/** One entry per distinct address, with how many stored locators name it. */
	holders: Map<string, { address: ArchiveAddress; holders: number }>;
	/** The media columns seen (their files are enumerated after the rows). */
	mediaColumns: { sectionTipo: string; sectionId: number; media: Record<string, unknown[]> }[];
}

/** The NDJSON line of one record: section_id + all eleven columns as raw text. */
function recordLineOf(id: number, row: MatrixRecord): ArchiveRecordLine {
	const columns = {} as Record<MatrixJsonbColumn, string | null>;
	for (const column of MATRIX_JSONB_COLUMNS) columns[column] = row.rawText[column] ?? null;
	return { section_id: id, columns };
}

/** Take one row into the census: its addresses (from the parsed twin) and its media column. */
function censusRow(
	sectionTipo: string,
	id: number,
	row: MatrixRecord,
	census: AddressCensus,
): void {
	for (const address of addressesOf(row.columns)) {
		const key = addressKey(address);
		const entry = census.holders.get(key) ?? { address, holders: 0 };
		entry.holders += 1;
		census.holders.set(key, entry);
	}
	const media = row.columns.media;
	if (media !== null && media !== undefined && typeof media === 'object') {
		census.mediaColumns.push({
			sectionTipo,
			sectionId: id,
			media: media as Record<string, unknown[]>,
		});
	}
}

/** Write records/<tipo>.ndjson for one section; returns its manifest entry. */
async function extractSectionRecords(
	section: { tipo: string; table: string; realTipo: string },
	ids: readonly number[],
	options: { outDir: string; batchSize: number },
	census: AddressCensus,
): Promise<ArchiveSection> {
	const { tipo, table } = section;
	const file = `${RECORDS_DIR}/${tipo}.ndjson`;
	const chunks: string[] = [];
	for (let start = 0; start < ids.length; start += options.batchSize) {
		const batch = ids.slice(start, start + options.batchSize);
		const rows = await readMatrixRecordBatch(table, tipo, batch);
		for (const id of batch) {
			const row = rows.get(id);
			if (row === undefined) refuse(`record ${tipo}/${id} vanished during extraction`);
			chunks.push(JSON.stringify(recordLineOf(id, row)));
			censusRow(tipo, id, row, census);
		}
	}
	const text = chunks.length === 0 ? '' : `${chunks.join('\n')}\n`;
	writeFileSync(join(options.outDir, file), text);
	return {
		section_tipo: tipo,
		real_section_tipo: section.realTipo === tipo ? null : section.realTipo,
		matrix_table: table,
		record_count: ids.length,
		file,
		sha256: sha256Hex(text),
	};
}

/** Split the census into internal locators (count) and distinct external references. */
function classifyReferences(
	census: AddressCensus,
	archivedIds: Map<string, Set<number>>,
): { internal: number; external: ExternalReference[] } {
	let internal = 0;
	const external: ExternalReference[] = [];
	for (const { address, holders } of census.holders.values()) {
		if (archivedIds.get(address.section_tipo)?.has(address.section_id)) {
			internal += holders;
			continue;
		}
		external.push({ ...address, exists_in_source: false, holders });
	}
	external.sort((a, b) => (addressKey(a) < addressKey(b) ? -1 : 1));
	return { internal, external };
}

function groupBySection(references: ExternalReference[]): Map<string, ExternalReference[]> {
	const bySection = new Map<string, ExternalReference[]>();
	for (const reference of references) {
		const list = bySection.get(reference.section_tipo) ?? [];
		list.push(reference);
		bySection.set(reference.section_tipo, list);
	}
	return bySection;
}

/** Existence in the SOURCE, one query per target section (an address into no section stays false). */
async function markExistsInSource(external: ExternalReference[]): Promise<void> {
	for (const [tipo, references] of groupBySection(external)) {
		const table = await getMatrixTableFromTipo(tipo);
		if (table === null) continue;
		const ids = references.map((r) => r.section_id);
		const present = await readExistingSectionIds(table, tipo, ids);
		for (const reference of references) {
			reference.exists_in_source = present.has(reference.section_id);
		}
	}
}

/** ontology.json: the subtree rows (sorted) + the referenced rows not in the subtree. */
async function writeOntologyFile(
	outDir: string,
	subtree: Map<string, DdOntologyRow>,
	referencedTipos: Set<string>,
): Promise<{ subtreeRows: DdOntologyRow[]; referenced: DdOntologyRow[]; text: string }> {
	const referenced: DdOntologyRow[] = [];
	for (const tipo of [...referencedTipos].sort()) {
		if (subtree.has(tipo)) continue;
		const row = await readDdOntologyRow(tipo);
		if (row !== null) referenced.push(row);
	}
	const subtreeRows = [...subtree.values()].sort((a, b) => (a.tipo < b.tipo ? -1 : 1));
	const ontology: ArchiveOntology = { subtree: subtreeRows, referenced };
	const text = `${JSON.stringify(ontology, null, '\t')}\n`;
	writeFileSync(join(outDir, ONTOLOGY_FILE), text);
	return { subtreeRows, referenced, text };
}

/** Copy one owned media file under media/<root-relative>; returns its manifest entry. */
function copyMediaFile(
	absolutePath: string,
	owner: { sectionTipo: string; sectionId: number },
	roots: { mediaRoot: string; outDir: string },
): ArchiveMediaFile {
	const rootRelative = `/${relative(roots.mediaRoot, absolutePath).split(sep).join('/')}`;
	const target = join(roots.outDir, mediaArchivePath(rootRelative));
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(absolutePath, target);
	return {
		path: rootRelative,
		sha256: sha256File(target),
		bytes: Bun.file(target).size,
		section_tipo: owner.sectionTipo,
		section_id: owner.sectionId,
	};
}

/**
 * Every file the records OWN as the engine's own path grammar resolves it
 * (every quality × extension + the AV posterframe; files_info never consulted).
 */
async function copySectionMedia(
	census: AddressCensus,
	options: ExtractOptions,
): Promise<ArchiveMediaFile[]> {
	const roots = { mediaRoot: requireMediaRoot(options.mediaRoot), outDir: options.outDir };
	const files: ArchiveMediaFile[] = [];
	for (const { sectionTipo, sectionId, media } of census.mediaColumns) {
		const outcome = await listSectionMediaFiles(sectionTipo, sectionId, media, {
			mediaRoot: options.mediaRoot,
		});
		if (outcome.errors.length > 0) {
			refuse(
				`media of ${sectionTipo}/${sectionId} could not be enumerated: ${outcome.errors.join('; ')}`,
				{ section_tipo: sectionTipo, section_id: sectionId },
			);
		}
		for (const absolutePath of outcome.files) {
			files.push(copyMediaFile(absolutePath, { sectionTipo, sectionId }, roots));
		}
	}
	files.sort((a, b) => (a.path < b.path ? -1 : 1));
	return files;
}

// ── orchestrator ────────────────────────────────────────────────────────────

/**
 * Extract `sectionTipos` into `outDir`. Order of work: ontology (so the
 * artifact is readable even if a later step fails and the operator inspects
 * it), records (with the locator census taken from the parsed twin of each row
 * while the RAW text is what gets written), media, then the manifest LAST —
 * a directory without a manifest is by definition not an archive.
 */
export async function extractArchive(options: ExtractOptions): Promise<ExtractOutcome> {
	const sectionTipos = [...new Set(options.sectionTipos)];
	if (sectionTipos.length === 0) refuse('no sections named');
	if (existsSync(options.outDir)) {
		refuse(`output directory already exists: ${options.outDir}`, { outDir: options.outDir });
	}
	const tables = await resolveSectionTables(sectionTipos);
	mkdirSync(join(options.outDir, RECORDS_DIR), { recursive: true });

	const { subtree, realOf } = await readSubtree(sectionTipos);
	const referencedTipos = referencedBySubtree(subtree);

	const census: AddressCensus = { holders: new Map(), mediaColumns: [] };
	const archivedIds = new Map<string, Set<number>>();
	const sections: ArchiveSection[] = [];
	const batch = { outDir: options.outDir, batchSize: options.batchSize ?? DEFAULT_BATCH };
	for (const tipo of sectionTipos) {
		const table = tables.get(tipo) as string;
		const ids = await readSectionIdsOfSection(table, tipo);
		archivedIds.set(tipo, new Set(ids));
		const realTipo = realOf.get(tipo) as string;
		sections.push(await extractSectionRecords({ tipo, table, realTipo }, ids, batch, census));
	}

	const references = classifyReferences(census, archivedIds);
	await markExistsInSource(references.external);
	for (const reference of references.external) referencedTipos.add(reference.section_tipo);

	const ontology = await writeOntologyFile(options.outDir, subtree, referencedTipos);
	const mediaFiles = await copySectionMedia(census, options);

	const manifest: ArchiveManifest = {
		format: ARCHIVE_FORMAT,
		format_version: ARCHIVE_FORMAT_VERSION,
		created_at: new Date().toISOString(),
		engine_version: formatVersion(DEDALO_DATA_VERSION),
		ontology: {
			file: ONTOLOGY_FILE,
			sha256: sha256Hex(ontology.text),
			digest: ontologyDigest(ontology.subtreeRows),
			subtree_count: ontology.subtreeRows.length,
			referenced_count: ontology.referenced.length,
		},
		sections,
		media: { file_count: mediaFiles.length, files: mediaFiles },
		references,
		not_archived: [...NOT_ARCHIVED],
	};
	mkdirSync(join(options.outDir, MEDIA_DIR), { recursive: true });
	writeFileSync(join(options.outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, '\t')}\n`);
	return { outDir: options.outDir, manifest };
}
