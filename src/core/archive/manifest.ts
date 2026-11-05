/**
 * THE ARCHIVE FORMAT — types, digests and the manifest reader/writer shared by
 * the extraction (extract.ts) and the restore (restore.ts).
 *
 * WHAT AN ARCHIVE IS. A DIRECTORY (the operator tars it; a container format
 * would be one more thing a reader in 2060 has to open) holding, for a SET of
 * sections, everything needed to reconstruct their records in a database that
 * never held them — and nothing that needs this codebase to be read:
 *
 *   manifest.json            engine version, format version, the section list
 *                            with matrix table + record count, the ontology
 *                            digest, the locator census (internal / external),
 *                            one sha256 per file, what is deliberately absent
 *   ontology.json            the dd_ontology rows of every archived section's
 *                            subtree (verbatim), plus the bare rows the subtree
 *                            REFERENCES (the matrix_table node, the section node
 *                            of every locator target outside the set, the model
 *                            node of every archived node) — read-only context
 *   records/<tipo>.ndjson    one line per record: section_id + ALL eleven jsonb
 *                            columns as the Postgres canonical text of each
 *                            (null = SQL NULL) — not conformed, not re-shaped
 *   media/<relative path>    byte copies of every media file the records own,
 *                            at their media-root-relative path
 *
 * WHY THE COLUMNS TRAVEL AS TEXT, NOT AS NESTED JSON. A jsonb value's canonical
 * text is the ONE lossless representation this engine has of a stored column:
 * it keeps `1.10` a numeric (a JSON.parse/stringify hop makes it `1.1`), keeps
 * key order and spacing canonical, and re-binds byte-identical through
 * `$n::text::jsonb`. The text is itself JSON, so a reader without this codebase
 * parses each string once and has the value; the cost is one level of quoting.
 *
 * WHAT IS NOT IN IT, STATED IN THE MANIFEST. Time Machine history (state is
 * archived, history is not), the `deleted/` media versions (same rule), AV
 * subtitles (not a quality slot of any media type), and the per-installation
 * counters (a restore raises them from the ids it writes). See
 * engineering/ARCHIVE_FORMAT.md — the format definition this module implements.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { canonicalJson } from '../concepts/canonical_json.ts';
import type { DdOntologyRow } from '../db/dd_ontology.ts';
import type { MatrixJsonbColumn } from '../db/matrix.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { deriveLegacyMachineName } from '../ontology/machine_name.ts';

/** The format identifier and the version this engine writes and reads. */
export const ARCHIVE_FORMAT = 'dedalo-archive';
export const ARCHIVE_FORMAT_VERSION = 1;

export const MANIFEST_FILE = 'manifest.json';
export const ONTOLOGY_FILE = 'ontology.json';
export const RECORDS_DIR = 'records';
export const MEDIA_DIR = 'media';

/** A locator target — the address every relation column stores. */
export interface ArchiveAddress {
	section_tipo: string;
	section_id: number;
}

/** An address stored by an archived record that points OUTSIDE the archived set. */
export interface ExternalReference extends ArchiveAddress {
	/** Whether the SOURCE database held that record at extraction time. */
	exists_in_source: boolean;
	/** How many archived locators point at it. */
	holders: number;
}

export interface ArchiveSection {
	section_tipo: string;
	/**
	 * The REAL section when this one is VIRTUAL (`getSectionRealTipo` — a
	 * thesaurus hierarchy, an alias): the records' column keys are ITS component
	 * tipos and its subtree travels in `ontology.subtree`. `null` for a real section.
	 */
	real_section_tipo: string | null;
	matrix_table: string;
	record_count: number;
	/** Archive-relative path of the NDJSON file. */
	file: string;
	sha256: string;
}

export interface ArchiveMediaFile {
	/** Media-root-relative path, leading slash (the files_info.file_path shape). */
	path: string;
	sha256: string;
	bytes: number;
	section_tipo: string;
	section_id: number;
}

export interface ArchiveManifest {
	format: typeof ARCHIVE_FORMAT;
	format_version: number;
	created_at: string;
	engine_version: string;
	ontology: {
		file: string;
		/** sha256 of the file bytes. */
		sha256: string;
		/** sha256 over the canonical form of the SUBTREE rows — the identity of the structure. */
		digest: string;
		subtree_count: number;
		referenced_count: number;
	};
	sections: ArchiveSection[];
	media: {
		file_count: number;
		files: ArchiveMediaFile[];
	};
	references: {
		/** Locators whose target is an archived record. */
		internal: number;
		external: ExternalReference[];
	};
	/** What the format deliberately leaves out, for the reader that would look for it. */
	not_archived: string[];
}

/** ontology.json — the subtree rows (restored) and the referenced rows (context). */
export interface ArchiveOntology {
	subtree: DdOntologyRow[];
	referenced: DdOntologyRow[];
}

/** One NDJSON line of a records file. */
export interface ArchiveRecordLine {
	section_id: number;
	/** jsonb canonical text per column; null = SQL NULL. Every column is present. */
	columns: Record<MatrixJsonbColumn, string | null>;
}

/** What the archive says it leaves out — ONE list, written by extract and read by the docs gate. */
export const NOT_ARCHIVED: readonly string[] = [
	'matrix_time_machine history (state is archived, history is not)',
	'media deleted/ versions (soft-deleted history)',
	'component_av subtitles files',
	'per-installation counters (a restore raises them from the ids it writes)',
];

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(absolutePath: string): string {
	return sha256Hex(readFileSync(absolutePath));
}

/**
 * The ontology digest: sha256 over the canonical form (concepts/canonical_json.ts —
 * a PERSISTED format, pinned there) of the subtree rows, sorted by tipo.
 */
export function ontologyDigest(subtree: readonly DdOntologyRow[]): string {
	const sorted = [...subtree].sort((a, b) => (a.tipo < b.tipo ? -1 : a.tipo > b.tipo ? 1 : 0));
	return sha256Hex(canonicalJson(sorted));
}

/**
 * A row with its machine-name columns STATED, for comparison. An archive written
 * before migration 0015 carries rows WITHOUT the two keys, and a destination row
 * no parser has derived since the migration reads `use_machine_name` NULL; both
 * get the parser's own legacy derivation (ontology/machine_name.ts — the same one
 * the upsert door applies when the restore writes such a row), so an unchanged
 * definition is found unchanged, never a conflict manufactured by a schema bump.
 */
function withStatedMachineName(row: DdOntologyRow): DdOntologyRow {
	if (typeof row.use_machine_name === 'boolean') return row;
	const derived = deriveLegacyMachineName(row);
	return {
		...row,
		machine_name: row.machine_name ?? derived.machine_name,
		use_machine_name: derived.use_machine_name,
	};
}

/**
 * Two ontology rows are the same definition (jsonb columns compared structurally;
 * machine-name columns as derived — withStatedMachineName).
 */
export function ontologyRowsEqual(a: DdOntologyRow, b: DdOntologyRow): boolean {
	return canonicalJson(withStatedMachineName(a)) === canonicalJson(withStatedMachineName(b));
}

/** A refusal of a malformed or tampered artifact — nothing is written on it. */
export function invalidArchive(
	message: string,
	coordinates: Record<string, string | number> = {},
): never {
	throw new DedaloError('archive.invalid', { message: `archive: ${message}`, coordinates });
}

/**
 * Resolve an archive-relative path and CONFINE it: a manifest is untrusted input
 * (it may have been edited in transit), so a `file` or `media.path` that climbs
 * out of the archive directory is refused BEFORE it is read — otherwise
 * `verify` could be made to hash, and report on, any file on the host. The
 * write side has its own gate (the media-root chokepoint); this is the read side.
 */
export function archiveFilePath(archiveDir: string, relativePath: string): string {
	const root = resolve(archiveDir);
	const path = resolve(root, relativePath);
	if (path !== root && !path.startsWith(`${root}${sep}`)) {
		invalidArchive(`file named by the manifest escapes the archive: ${relativePath}`, {
			file: relativePath,
		});
	}
	return path;
}

/** Parse manifest.json — a missing or non-JSON file is refused, nothing is trusted yet. */
function parseManifestFile(archiveDir: string): ArchiveManifest {
	const manifestPath = join(archiveDir, MANIFEST_FILE);
	if (!existsSync(manifestPath)) invalidArchive(`no ${MANIFEST_FILE} in '${archiveDir}'`);
	try {
		return JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest;
	} catch (error) {
		return invalidArchive(`${MANIFEST_FILE} is not JSON: ${(error as Error).message}`);
	}
}

/** Format + version: this engine reads exactly one. */
function assertManifestFormat(manifest: ArchiveManifest): void {
	if (manifest.format !== ARCHIVE_FORMAT) {
		invalidArchive(`format is '${String(manifest.format)}', expected '${ARCHIVE_FORMAT}'`);
	}
	if (manifest.format_version !== ARCHIVE_FORMAT_VERSION) {
		invalidArchive(
			`format_version ${String(manifest.format_version)} is not readable by this engine (reads ${ARCHIVE_FORMAT_VERSION})`,
		);
	}
}

/** The lists every reader walks must BE lists. */
function assertManifestShape(manifest: ArchiveManifest): void {
	if (!Array.isArray(manifest.sections) || !Array.isArray(manifest.media?.files)) {
		invalidArchive('manifest lacks sections[] or media.files[]');
	}
	if (!Array.isArray(manifest.references?.external)) {
		invalidArchive('manifest lacks references.external[]');
	}
}

/** One named file: present, inside the archive, and of the stated sha256. */
function assertFileDigest(archiveDir: string, relativePath: string, expected: string): void {
	const path = archiveFilePath(archiveDir, relativePath);
	if (!existsSync(path)) invalidArchive(`file named by the manifest is missing: ${relativePath}`);
	const actual = sha256File(path);
	if (actual !== expected) {
		invalidArchive(`sha256 mismatch on ${relativePath}`, { file: relativePath, expected, actual });
	}
}

/**
 * Read and VERIFY a manifest: shape, format, and the sha256 of every file it
 * names (ontology, records, media). A manifest whose files do not match is
 * refused here, before any reader trusts a byte of them.
 */
export function readManifest(archiveDir: string): ArchiveManifest {
	const manifest = parseManifestFile(archiveDir);
	assertManifestFormat(manifest);
	assertManifestShape(manifest);
	assertFileDigest(archiveDir, manifest.ontology.file, manifest.ontology.sha256);
	for (const section of manifest.sections) {
		assertFileDigest(archiveDir, section.file, section.sha256);
	}
	for (const file of manifest.media.files) {
		assertFileDigest(archiveDir, mediaArchivePath(file.path), file.sha256);
	}
	return manifest;
}

/** Archive-relative location of a media file (its root-relative path under media/). */
export function mediaArchivePath(rootRelativePath: string): string {
	return `${MEDIA_DIR}${rootRelativePath.startsWith('/') ? '' : '/'}${rootRelativePath}`;
}

/** Read ontology.json and verify its digest against the manifest. */
export function readArchiveOntology(
	archiveDir: string,
	manifest: ArchiveManifest,
): ArchiveOntology {
	const ontology = JSON.parse(
		readFileSync(archiveFilePath(archiveDir, manifest.ontology.file), 'utf8'),
	) as ArchiveOntology;
	if (!Array.isArray(ontology.subtree) || !Array.isArray(ontology.referenced)) {
		invalidArchive(`${manifest.ontology.file} lacks subtree[] or referenced[]`);
	}
	const digest = ontologyDigest(ontology.subtree);
	if (digest !== manifest.ontology.digest) {
		invalidArchive('ontology digest mismatch', {
			expected: manifest.ontology.digest,
			actual: digest,
		});
	}
	return ontology;
}

/**
 * SELF-DESCRIPTION: every archived section's own node, and the REAL section's
 * node when it is virtual, must be a row of `subtree` — the rows that define
 * the records' column keys. An artifact failing this cannot be read without a
 * copy of the source ontology, which is the property the format exists for.
 */
export function assertSectionsDescribed(
	manifest: ArchiveManifest,
	ontology: ArchiveOntology,
): void {
	const defined = new Set(ontology.subtree.map((row) => row.tipo));
	for (const section of manifest.sections) {
		for (const tipo of [section.section_tipo, section.real_section_tipo]) {
			if (tipo === null || tipo === undefined || defined.has(tipo)) continue;
			invalidArchive(
				`section '${section.section_tipo}' is not self-describing: node '${tipo}' is not in ${manifest.ontology.file} subtree`,
				{ section_tipo: section.section_tipo, tipo },
			);
		}
	}
}

/** Parse one section's NDJSON records file. */
export function readArchiveRecords(
	archiveDir: string,
	section: ArchiveSection,
): ArchiveRecordLine[] {
	const text = readFileSync(archiveFilePath(archiveDir, section.file), 'utf8');
	const lines: ArchiveRecordLine[] = [];
	for (const raw of text.split('\n')) {
		if (raw !== '') lines.push(parseRecordLine(raw, section.file));
	}
	if (lines.length !== section.record_count) {
		invalidArchive(
			`${section.file} holds ${lines.length} records, manifest says ${section.record_count}`,
			{
				file: section.file,
			},
		);
	}
	return lines;
}

function parseRecordLine(raw: string, file: string): ArchiveRecordLine {
	const line = JSON.parse(raw) as ArchiveRecordLine;
	if (!Number.isInteger(line.section_id) || typeof line.columns !== 'object') {
		invalidArchive(`malformed record line in ${file}`, { file });
	}
	return line;
}

/**
 * Every address a record's relation-bearing columns store. Walks `relation` and
 * `relation_search` (the ancestor index — also addresses): each component key
 * holds an array of items, and an item with `section_tipo` + `section_id` is a
 * locator whatever else it carries (a dataframe frame, a tag locator, an index).
 */
export function addressesOf(columns: {
	relation?: unknown;
	relation_search?: unknown;
}): ArchiveAddress[] {
	return [...addressesOfColumn(columns.relation), ...addressesOfColumn(columns.relation_search)];
}

/** The addresses of one relation-bearing column: `{ <component tipo>: [item, …] }`. */
function addressesOfColumn(column: unknown): ArchiveAddress[] {
	const out: ArchiveAddress[] = [];
	if (!isPlainObject(column)) return out;
	for (const items of Object.values(column)) {
		if (!Array.isArray(items)) continue;
		for (const item of items) {
			const address = asAddress(item);
			if (address !== null) out.push(address);
		}
	}
	return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An item is an address when it carries a non-empty `section_tipo` and an integer `section_id`. */
function asAddress(item: unknown): ArchiveAddress | null {
	if (!isPlainObject(item)) return null;
	const { section_tipo, section_id } = item;
	if (typeof section_tipo !== 'string' || section_tipo === '') return null;
	const id = integerOf(section_id);
	return id === null ? null : { section_tipo, section_id: id };
}

function integerOf(value: unknown): number | null {
	const id = typeof value === 'number' ? value : Number(value);
	return Number.isInteger(id) ? id : null;
}

export function addressKey(address: ArchiveAddress): string {
	return `${address.section_tipo}/${address.section_id}`;
}
