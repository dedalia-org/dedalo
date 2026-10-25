/**
 * RDF writer — the 'rdf' DiffusionWriter (DIFFUSION_SPEC §4.3 "rdf / xml:
 * one deterministic file per record; close() does type-aware merge + ZIP,
 * all temp+rename"). PHP oracle: diffusion/class.diffusion_rdf.php (EasyRdf
 * rdfxml serialisation); merge grammar: old engine
 * diffusion/api/v1/lib/rdf_file_utils.ts merge_rdf_parts (:72-85).
 *
 * Layout — IDENTICAL to the delete-side grammar so publish and unpublish
 * stay in lockstep (diffusion_delete.ts resolvePublishedFilePath :371-386;
 * PHP get_record_file_path class.diffusion_rdf.php:275-340):
 *
 *   <root>/rdf/<serviceName>/<sanitize(rdfName_sectionTipo_sectionId)>.rdf
 *
 * where rdfName is the owl:Class label — EXACTLY what the plan compiler puts
 * in SectionPlan.tableName for file formats (compile.ts keeps rdf/xml labels
 * VERBATIM: 'nmo:NumismaticObject' is an RDF identity, not a SQL identifier)
 * and sanitize is the PHP sanitize_file_name subset — IMPORTED from the one
 * producer both sides use (core/diffusion_bridge/published_files.ts), so the
 * delete side cannot drift from it (PUB-03).
 *
 * Document shape (pinned against a REAL PHP-published file,
 * media_monedaiberica/rdf/nomisma/nmonumismaticobject-numisdata4-1-*.rdf):
 *
 *   <?xml version="1.0" encoding="utf-8" ?>
 *   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
 *            xmlns:nmo="http://nomisma.org/ontology#">
 *
 *     <nmo:NumismaticObject rdf:about="...">
 *       <dc:title xml:lang="es">...</dc:title>
 *     </nmo:NumismaticObject>
 *
 *   </rdf:RDF>
 *
 * (EasyRdf declaration with a space before '?>', 9-space xmlns continuation
 * indent, 2-space entity / 4-space predicate indents, blank lines around the
 * entity block.)
 *
 * Ledgered divergences from PHP (deliberate, determinism + the writers-do-no-
 * I/O boundary):
 * - NO wall-clock anywhere: consolidated artifacts are `diffusion_rdf_merged
 *   .rdf` / `diffusion_rdf.zip` (old engine index.ts:529-534 stamped
 *   `_<date>` tags — dropped like the markdown writer's zip, so re-runs are
 *   byte-identical; who/when live in the dd1758 activity log).
 * - Subject URIs: PHP resolves rdf:about from the dd1010 entity-publication
 *   services (resolve_base_uri — record reads a writer must not make). This
 *   writer uses the value of a column literally named 'rdf:about' when the
 *   plan provides one (the compiler/resolver's forward path to real URIs) and
 *   falls back to the deterministic `urn:dedalo:record:<st>:<id>`.
 * - Namespace URIs: PHP reads properties->xmlns of the element; the compiled
 *   plan does not carry it (yet). Prefixes are collected from the plan labels
 *   and resolved via WELL_KNOWN_XMLNS (the vocabularies pinned from the real
 *   published files); an unknown prefix gets a urn:dedalo:xmlns fallback AND
 *   a summary error — loud, never silent (spec §4.3 posture).
 *
 * removeRecords unlinks the canonical file + the legacy '{base}_*.rdf'
 * variants — the EXACT diffusion_delete.ts unlinkPublishedFiles rdf branch
 * (:412-423); missing files = idempotent success (PHP delete_record_file
 * "no file found (already removed)").
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readdirSync,
	renameSync,
	unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
	publishedRecordFileName,
	sanitizePublishedFileName,
} from '../../core/diffusion_bridge/published_files.ts';
import { DedaloError } from '../../core/errors/index.ts';
import { fsyncDirectory, mkdirDurably, writeAllSync } from '../../core/files/durable.ts';
import { tempPathFor } from '../../core/files/temp_path.ts';
import { firstHtmlTag } from '../../core/resolve/html_text.ts';
import type { PublicationPlan, SectionPlan } from '../plan/types.ts';
import type { ProjectedRow } from '../project/lang_ladder.ts';
import {
	atomicWriteFile,
	createZip,
	formatTargetDir,
	manifestPaths,
	planColumnNames,
	readManifestPart,
	sweepStaleTemps,
	WriterRunLog,
	withTrailingPath,
} from './files.ts';
import type {
	ArtifactEvent,
	DiffusionWriter,
	ManifestEntry,
	WriteBatchResult,
	WriterCloseContext,
	WriterContinuity,
	WriterOpenContext,
	WriterRunSummary,
	WriterSession,
} from './types.ts';

/** The `<rdf:RDF …>` opener, matched linearly (html_text — CodeQL #7958 shape). */
const RDF_OPENER = /<rdf:RDF/y;

/**
 * WriterRunSummary side-channel (shape per writers/types.ts — no new fields):
 * close() APPENDS zero-count `tables` entries whose table_name is
 * '<prefix><media-root-relative path>' for the run's consolidated artifacts.
 * The runner must lift these into the finish result the client parses
 * (jobs/sse.ts progressDataFromJob finish-parity): strip the prefix, prepend
 * the public media URL, and emit
 *   result.consolidated_files = { merged_url, zip_url }
 * plus result.diffusion_data = [{ file_url }] per published record (derived
 * from the same deterministic per-record grammar). Old engine anchor:
 * diffusion/api/v1/index.ts:529-563.
 */
export const CONSOLIDATED_MERGED_PREFIX = 'consolidated_merged:';
export const CONSOLIDATED_ZIP_PREFIX = 'consolidated_zip:';

/**
 * A close whose run manifest yields NOTHING to consolidate (every record
 * unpublished, or every file gone): the consolidated artifacts are the run's
 * manifest — removed records absent (types.ts WriterCloseContext) — so an empty
 * manifest means NO merged document and NO zip. The previous run's ones still
 * hold the withdrawn records in the public directory; they are unlinked here,
 * the directory fsynced before the runner commits the run 'completed' (the
 * withdrawal is as durable as a landing). Missing = already withdrawn
 * (idempotent); any other failure throws — the run fails and is retried, never
 * reported 'completed' with the withdrawn records still downloadable. The
 * rdf / xml / markdown closes share it (closure review cross-diffusion:r7).
 */
export function withdrawConsolidated(targetDir: string, names: readonly string[]): void {
	let withdrawn = false;
	for (const name of names) {
		try {
			unlinkSync(`${targetDir}/${name}`);
			withdrawn = true;
		} catch (error) {
			if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error;
		}
	}
	if (withdrawn) fsyncDirectory(targetDir);
}

/**
 * Loud open() gate: rdf/xml publish to a service-named files target only. A
 * thin DedaloError family with a fixed code; the plan id stays log-only.
 */
export class InvalidFileTargetError extends DedaloError {
	constructor(format: string, plan: PublicationPlan) {
		super('diffusion.invalid_target', {
			message: `${format} writer: plan '${plan.planId}' targets kind '${plan.target.kind}' — rdf/xml publish to {kind:'files', serviceName} only (check the element properties->diffusion->service_name).`,
			coordinates: { format, plan_id: plan.planId, target_kind: plan.target.kind },
		});
		this.name = 'InvalidFileTargetError';
	}
}

/** The 'files' target serviceName, or a loud typed error (never a guess). */
export function requireFilesTarget(format: string, plan: PublicationPlan): string {
	if (plan.target.kind !== 'files' || plan.target.serviceName === '') {
		throw new InvalidFileTargetError(format, plan);
	}
	return plan.target.serviceName;
}

/**
 * PHP sanitize_file_name + beautify (delete-side subset). ONE implementation —
 * the core producer's (published_files.ts sanitizePublishedFileName); this
 * name is kept for the writer's callers and tests. The duplicate copy this
 * module carried "pinned by test, not by import" was the PUB-03 class of
 * drift (2026-09-03): a lockstep that lives in two files is a promise.
 */
export const sanitizeRdfFileName = sanitizePublishedFileName;

/**
 * Per-record rdf file name — the EXACT delete-side grammar
 * (diffusion_delete.ts:385 `${sanitize(`${rdfName}_${sectionTipo}_${sectionId}`)}.rdf`;
 * PHP class.diffusion_rdf.php:324-328). rdfName = SectionPlan.tableName (the
 * verbatim owl:Class label).
 */
export function rdfRecordFileName(section: SectionPlan, sectionId: number | string): string {
	const name = publishedRecordFileName('rdf', section.sectionTipo, sectionId, section.tableName);
	if (name === null) {
		throw new DedaloError('internal.invariant', {
			message: `rdf writer: section '${section.sectionTipo}' has no owl:Class label (tableName) to name its files`,
		});
	}
	return name;
}

/**
 * Dédalo lang code → alpha2 xml:lang (PHP lang::get_alpha2_from_code — the
 * real published files carry xml:lang="es"). Unknown codes fall back to the
 * first two letters of the ISO-639-3 tail (deterministic, never throws).
 */
const LANG_ALPHA2: Record<string, string> = {
	'lg-eng': 'en',
	'lg-spa': 'es',
	'lg-cat': 'ca',
	'lg-fra': 'fr',
	'lg-deu': 'de',
	'lg-por': 'pt',
	'lg-ita': 'it',
	'lg-nob': 'no',
	'lg-swe': 'sv',
	'lg-nld': 'nl',
	'lg-eus': 'eu',
	'lg-glg': 'gl',
	'lg-arb': 'ar',
	'lg-zho': 'zh',
	'lg-jpn': 'ja',
	'lg-rus': 'ru',
	'lg-ell': 'el',
	'lg-lat': 'la',
};

export function langToAlpha2(lang: string): string {
	return LANG_ALPHA2[lang] ?? lang.replace(/^lg-/, '').slice(0, 2);
}

/** XML text-node escaping (what EasyRdf/DOMDocument createTextNode does). */
export function escapeXmlText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** XML attribute-value escaping (double-quoted attributes). */
export function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replace(/"/g, '&quot;');
}

/** A plan label must be a legal XML QName to become a class/predicate tag. */
const QNAME_PATTERN = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

/** Loud gate: a plan label that cannot be an RDF/XML element name. */
export function requireQName(label: string, role: string): string {
	if (!QNAME_PATTERN.test(label)) {
		throw new Error(
			`rdf writer: ${role} '${label}' is not a valid XML QName — fix the ontology label (file-format labels reach the document verbatim).`,
		);
	}
	return label;
}

/**
 * Namespace URIs for the prefixes seen in real Dédalo rdf domains. rdf/nmo/
 * dc/void are pinned from the actual PHP-published monedaiberica files; the
 * rest are the canonical vocabulary URIs (PHP got all of them from the
 * element's properties->xmlns — see the module doc-comment divergence note).
 */
export const WELL_KNOWN_XMLNS: Record<string, string> = {
	rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
	rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
	nmo: 'http://nomisma.org/ontology#',
	nm: 'http://nomisma.org/id/',
	dc: 'http://purl.org/dc/terms/',
	dcterms: 'http://purl.org/dc/terms/',
	void: 'http://rdfs.org/ns/void#',
	skos: 'http://www.w3.org/2004/02/skos/core#',
	owl: 'http://www.w3.org/2002/07/owl#',
	foaf: 'http://xmlns.com/foaf/0.1/',
	xsd: 'http://www.w3.org/2001/XMLSchema#',
	geo: 'http://www.w3.org/2003/01/geo/wgs84_pos#',
	crm: 'http://www.cidoc-crm.org/cidoc-crm/',
};

/** Documented fallback for a prefix the plan uses but nobody declared. */
export function fallbackXmlnsUri(prefix: string): string {
	return `urn:dedalo:xmlns:${prefix}#`;
}

/** The subject-URI override column (see module doc-comment divergence note). */
const ABOUT_COLUMN = 'rdf:about';

export interface RdfNamespaceSet {
	/** prefix → URI, insertion-ordered: rdf first, then first-use order. */
	declarations: Map<string, string>;
	/** Prefixes resolved through the urn:dedalo fallback (summary errors). */
	unknownPrefixes: string[];
}

/**
 * Collect the namespace declarations one section's documents need: the rdf
 * prefix (envelope + rdf:about) plus every prefix used by the class label and
 * the emitted predicate columns, in first-use order (EasyRdf emitted them in
 * properties->xmlns registration order; the plan's label order is our
 * deterministic equivalent).
 */
export function collectRdfNamespaces(section: SectionPlan): RdfNamespaceSet {
	const declarations = new Map<string, string>();
	const unknownPrefixes: string[] = [];
	declarations.set('rdf', WELL_KNOWN_XMLNS.rdf as string);
	const labels = [section.tableName, ...planColumnNames(section)];
	for (const label of labels) {
		const colon = label.indexOf(':');
		if (colon <= 0) continue; // unprefixed element names need no xmlns
		const prefix = label.slice(0, colon);
		if (declarations.has(prefix)) continue;
		const known = WELL_KNOWN_XMLNS[prefix];
		if (known !== undefined) {
			declarations.set(prefix, known);
		} else {
			declarations.set(prefix, fallbackXmlnsUri(prefix));
			unknownPrefixes.push(prefix);
		}
	}
	return { declarations, unknownPrefixes };
}

/** Deterministic fallback subject URI (module doc-comment divergence note). */
export function defaultSubjectUri(sectionTipo: string, sectionId: number | string): string {
	return `urn:dedalo:record:${sectionTipo}:${sectionId}`;
}

/**
 * Render ONE entity block: the owl:Class element wrapping one xml:lang-
 * attributed literal per (plan column × lang row with a non-null value) —
 * null columns omitted (PHP addLiteral only fires on non-empty values,
 * class.diffusion_rdf.php:973-979). lang-null rows emit plain literals.
 * Indentation pinned from the real published file (2-space entity, 4-space
 * predicate).
 */
export function renderRdfEntity(
	section: SectionPlan,
	sectionId: number | string,
	rows: ProjectedRow[],
): string {
	const className = requireQName(section.tableName, 'class label (tableName)');
	// subject: the rdf:about override column when the plan carries one
	let subjectUri = defaultSubjectUri(section.sectionTipo, sectionId);
	for (const row of rows) {
		const about = row.columns[ABOUT_COLUMN];
		if (about !== undefined && about !== null && about !== '') {
			subjectUri = about;
			break;
		}
	}

	const lines: string[] = [];
	lines.push(`  <${className} rdf:about="${escapeXmlAttribute(subjectUri)}">`);
	for (const columnName of planColumnNames(section)) {
		if (columnName === ABOUT_COLUMN) continue; // subject identity, not a predicate
		const predicate = requireQName(columnName, 'predicate label (columnName)');
		for (const row of rows) {
			const value = row.columns[columnName] ?? null;
			if (value === null) continue; // null columns omitted
			const langAttribute = row.lang === null ? '' : ` xml:lang="${langToAlpha2(row.lang)}"`;
			lines.push(`    <${predicate}${langAttribute}>${escapeXmlText(value)}</${predicate}>`);
		}
	}
	lines.push(`  </${className}>`);
	return lines.join('\n');
}

/**
 * Render one full per-record RDF/XML document: the EasyRdf envelope (pinned
 * from the real published file — declaration with ' ?>', 9-space xmlns
 * continuation indent) around the record's entity block.
 */
export function renderRdfRecord(
	section: SectionPlan,
	sectionId: number | string,
	rows: ProjectedRow[],
	namespaces: RdfNamespaceSet,
): string {
	const xmlnsLines = [...namespaces.declarations.entries()].map(
		([prefix, uri]) => `xmlns:${prefix}="${escapeXmlAttribute(uri)}"`,
	);
	// '<rdf:RDF ' is 9 chars — continuation xmlns lines align under the first.
	const openingTag = `<rdf:RDF ${xmlnsLines.join('\n         ')}>`;
	const entity = renderRdfEntity(section, sectionId, rows);
	return `<?xml version="1.0" encoding="utf-8" ?>\n${openingTag}\n\n${entity}\n\n</rdf:RDF>\n`;
}

/**
 * A streamed consolidation's output: parts are read ONE at a time (as utf-8
 * text — a BOM is kept, like the frozen in-memory merge's readFileSync), the
 * result goes through a numeric descriptor (synchronous writes,
 * core/files/durable.ts) onto a temp sibling, fsynced, renamed over `outPath`,
 * the directory fsynced — the merged document a close reports is on disk
 * before the runner commits the run 'completed'. Memory is bounded by the two
 * largest parts (the held-back first part + the current one). Zero non-empty
 * parts ⇒ nothing is written (the caller does not consolidate).
 */
export class StreamedMergeOutput {
	private fd: number | null = null;
	private tempPath: string | null = null;

	constructor(private readonly outPath: string) {}

	async write(text: string): Promise<void> {
		if (text === '') return;
		if (this.fd === null) {
			mkdirDurably(dirname(this.outPath));
			this.tempPath = tempPathFor(this.outPath);
			this.fd = openSync(this.tempPath, 'w');
		}
		writeAllSync(this.fd, Buffer.from(text, 'utf-8'));
	}

	/** Finalize: fsync + rename + directory fsync (nothing written ⇒ nothing lands). */
	async commit(): Promise<void> {
		if (this.fd === null || this.tempPath === null) return;
		fsyncSync(this.fd);
		closeSync(this.fd);
		this.fd = null;
		renameSync(this.tempPath, this.outPath);
		this.tempPath = null;
		fsyncDirectory(dirname(this.outPath));
	}

	/** Drop the temp (a failed merge leaves no partial final file). */
	async discard(): Promise<void> {
		if (this.fd !== null) {
			try {
				closeSync(this.fd);
			} catch {
				// already closed — nothing held
			}
		}
		this.fd = null;
		if (this.tempPath !== null) {
			try {
				unlinkSync(this.tempPath);
			} catch {
				// never created, or already gone — nothing left behind
			}
		}
		this.tempPath = null;
	}
}

/** A part the merge keeps: non-empty after trim (the oracle's filter). */
function isMergeablePart(part: string): boolean {
	return part.trim().length > 0;
}

/**
 * The rdf part's inner block (between its <rdf:RDF …> and its last </rdf:RDF>), trimmed.
 * Exported for its outcome gate (server_codeql_hardening_native: linear on a run
 * of unclosed `<rdf:RDF`, CodeQL #7958 shape).
 */
export function rdfInnerBlock(part: string): string {
	const open = firstHtmlTag(part, RDF_OPENER);
	const closeIndex = part.lastIndexOf('</rdf:RDF>');
	if (!open || closeIndex === -1) return '';
	const bodyStart = open.index + open.tag.length;
	return part.slice(bodyStart, closeIndex).trim();
}

/**
 * Type-aware consolidation, STREAMED (PERF-2/DIFF-4) — the old engine's
 * merge_rdf_parts (rdf_file_utils.ts:72-85), byte for byte (the frozen
 * in-memory port is test/helpers/merge_oracle.ts; gate:
 * diffusion_rdfxml_writers "streamed merge == frozen oracle"): envelope
 * (opening <rdf:RDF …> tag with its namespaces) from the FIRST non-empty part,
 * inner blocks of every part joined by a blank line. A single part is written
 * untouched. NOTE the merged declaration has NO space before '?>' — old
 * engine :84. Returns how many non-empty parts were merged.
 */
export async function writeMergedRdf(
	paths: AsyncIterable<string>,
	outPath: string,
	onMissing: (path: string) => void = () => {},
): Promise<{ parts: number }> {
	const output = new StreamedMergeOutput(outPath);
	let first: string | null = null;
	let parts = 0;
	let blocks = 0;
	const writeBlock = async (block: string): Promise<void> => {
		if (block.length === 0) return;
		await output.write(blocks > 0 ? `\n\n${block}` : block);
		blocks++;
	};
	try {
		for await (const path of paths) {
			const part = readManifestPart(path);
			if (part === null) {
				onMissing(path); // gone since the manifest pass saw it: a line, not a crash
				continue;
			}
			if (!isMergeablePart(part)) continue;
			parts++;
			if (first === null) {
				first = part; // held back: alone, it is the result verbatim
				continue;
			}
			if (parts === 2) {
				const openingTag = firstHtmlTag(first, RDF_OPENER)?.tag ?? '<rdf:RDF>';
				await output.write(`<?xml version="1.0" encoding="utf-8"?>\n${openingTag}\n\n`);
				await writeBlock(rdfInnerBlock(first));
			}
			await writeBlock(rdfInnerBlock(part));
		}
		if (parts === 1) await output.write(first as string);
		else if (parts > 1) await output.write('\n\n</rdf:RDF>\n');
		await output.commit();
		return { parts };
	} catch (error) {
		await output.discard();
		throw error;
	}
}

/** Consolidated artifact names — old grammar minus the wall-clock date tag. */
const RDF_MERGED_NAME = 'diffusion_rdf_merged.rdf';
const RDF_ZIP_NAME = 'diffusion_rdf.zip';

class RdfWriterSession implements WriterSession {
	private readonly serviceName: string;
	private readonly targetDir: string;
	private readonly sections: Map<string, SectionPlan>;
	private readonly log: WriterRunLog;
	/** Per-section namespace sets, memoized (unknown prefixes error ONCE). */
	private readonly namespacesBySection = new Map<string, RdfNamespaceSet>();
	private schemaEnsured = false;

	constructor(plan: PublicationPlan, context?: WriterOpenContext) {
		this.serviceName = requireFilesTarget('rdf', plan);
		this.targetDir = formatTargetDir('rdf', this.serviceName);
		this.sections = new Map(plan.sections.map((section) => [section.sectionTipo, section]));
		this.log = new WriterRunLog(
			plan.sections.map((section) => section.tableName),
			context,
		);
	}

	get continuity(): WriterContinuity {
		return this.log.continuity;
	}

	private namespacesFor(section: SectionPlan): RdfNamespaceSet {
		let namespaces = this.namespacesBySection.get(section.tableTipo);
		if (namespaces === undefined) {
			namespaces = collectRdfNamespaces(section);
			for (const prefix of namespaces.unknownPrefixes) {
				this.log.errors.add(
					`rdf writer: no xmlns known for prefix '${prefix}' (section '${section.tableName}') — ` +
						`emitted fallback ${fallbackXmlnsUri(prefix)}; declare the vocabulary in the element ontology.`,
				);
			}
			this.namespacesBySection.set(section.tableTipo, namespaces);
		}
		return namespaces;
	}

	private recordPath(section: SectionPlan, sectionId: number | string): string {
		return `${this.targetDir}/${rdfRecordFileName(section, sectionId)}`;
	}

	/** File-target "schema" = the run directory exists (no DDL). */
	async ensureSchema(): Promise<void> {
		mkdirDurably(this.targetDir);
		this.schemaEnsured = true;
	}

	/**
	 * Group the batch's rows per section_id (the projection emits every lang
	 * of a record together) and land ONE deterministic .rdf per record, each
	 * via its own temp+rename.
	 */
	async writeRows(section: SectionPlan, rows: ProjectedRow[]): Promise<WriteBatchResult> {
		if (rows.length === 0) return { written: 0, deleted: 0 };
		if (!this.schemaEnsured) {
			throw new Error(
				`rdf writer: writeRows('${section.tableName}') before ensureSchema() — the run directory is created there`,
			);
		}
		const namespaces = this.namespacesFor(section);
		const grouped = new Map<string, { sectionId: number | string; rows: ProjectedRow[] }>();
		for (const row of rows) {
			const key = String(row.sectionId);
			let group = grouped.get(key);
			if (group === undefined) {
				group = { sectionId: row.sectionId, rows: [] };
				grouped.set(key, group);
			}
			group.rows.push(row);
		}
		for (const group of grouped.values()) {
			atomicWriteFile(
				this.recordPath(section, group.sectionId),
				renderRdfRecord(section, group.sectionId, group.rows, namespaces),
				this.log.barrier,
			);
			this.log.note('wrote', section.sectionTipo, group.sectionId);
		}
		const counters = this.log.countersFor(section.tableName);
		counters.records_affected += grouped.size;
		counters.records_count += rows.length;
		return { written: rows.length, deleted: 0 };
	}

	/**
	 * Unlink the canonical per-record file PLUS the legacy '{base}_*.rdf'
	 * variants — the EXACT diffusion_delete.ts unlinkPublishedFiles rdf branch
	 * (:412-423; PHP delete_record_file legacy glob :369-379). Missing files =
	 * idempotent success with zero deletions. The removal event names the
	 * RECORD (its canonical file leaves the manifest); legacy variants were
	 * never in a manifest.
	 */
	async removeRecords(
		section: SectionPlan,
		sectionIds: (number | string)[],
	): Promise<WriteBatchResult> {
		let deleted = 0;
		for (const sectionId of sectionIds) {
			const filePath = this.recordPath(section, sectionId);
			const toUnlink: string[] = [];
			if (existsSync(filePath)) toUnlink.push(filePath);
			const base = rdfRecordFileName(section, sectionId).replace(/\.rdf$/, '');
			if (existsSync(this.targetDir)) {
				for (const name of readdirSync(this.targetDir)) {
					if (name.startsWith(`${base}_`) && name.endsWith('.rdf')) {
						toUnlink.push(`${this.targetDir}/${name}`);
					}
				}
			}
			for (const path of toUnlink) {
				unlinkSync(path);
				this.log.barrier.add(this.targetDir); // durable at checkpoint()
				deleted++;
			}
			this.log.note('removed', section.sectionTipo, sectionId);
		}
		this.log.countersFor(section.tableName).records_affected += deleted;
		return { written: 0, deleted };
	}

	takeArtifacts(): ArtifactEvent[] {
		return this.log.take();
	}

	/**
	 * THE DURABILITY BARRIER (WriterRunLog.checkpoint): every record file of the
	 * batch was fsynced before its rename (atomicWriteFile); the directory —
	 * the renames and unlinks — is fsynced here, before the runner commits the
	 * batch's events to the run ledger. The state is the counters.
	 */
	async checkpoint(): Promise<unknown> {
		return this.log.checkpoint();
	}

	runSummary(): WriterRunSummary {
		return this.log.summary();
	}

	/**
	 * Consolidate the RUN: merge every per-record document of the run's
	 * manifest into ONE envelope (writeMergedRdf, streamed), then ZIP the
	 * per-record files + the merged document (old engine index.ts:543-563) —
	 * two manifest passes, everything temp+rename, memory bounded. The
	 * consolidated paths ride the summary as prefixed zero-count table entries
	 * — see CONSOLIDATED_MERGED_PREFIX for the runner mapping.
	 */
	async close(context?: WriterCloseContext): Promise<WriterRunSummary> {
		const run = this.log.closeContext(context);
		await sweepStaleTemps(this.targetDir, run);
		const pathOf = (entry: ManifestEntry): string | null => {
			const section = this.sections.get(entry.sectionTipo);
			return section === undefined ? null : this.recordPath(section, entry.sectionId);
		};
		const consolidated: WriterRunSummary['tables'] = [];
		const mergedPath = `${this.targetDir}/${RDF_MERGED_NAME}`;
		const missing = (path: string): void => {
			this.log.errors.add(`rdf close: published file missing, left out of the archive: ${path}`);
		};
		const { parts } = await writeMergedRdf(
			manifestPaths(run, pathOf, missing),
			mergedPath,
			missing,
		);
		if (parts > 0) {
			// The zip pass reports what the merge pass could not see: a record
			// file removed between the two (the merged document then names a
			// record the archive omits — the line says so). The engine's
			// files-unlink door cannot do it (it takes this close's fence, WC R2
			// closed); a hand outside the engine can.
			await createZip(
				withTrailingPath(manifestPaths(run, pathOf, missing), mergedPath),
				`${this.targetDir}/${RDF_ZIP_NAME}`,
				{ onMissing: missing },
			);
			const relativeDir = `/rdf/${this.serviceName}`;
			consolidated.push(
				{
					table_name: `${CONSOLIDATED_MERGED_PREFIX}${relativeDir}/${RDF_MERGED_NAME}`,
					records_affected: 0,
					records_count: 0,
				},
				{
					table_name: `${CONSOLIDATED_ZIP_PREFIX}${relativeDir}/${RDF_ZIP_NAME}`,
					records_affected: 0,
					records_count: 0,
				},
			);
		} else {
			// Nothing to consolidate: the previous run's merged document and zip
			// still hold the records this run withdrew — gone, never reported.
			withdrawConsolidated(this.targetDir, [RDF_MERGED_NAME, RDF_ZIP_NAME]);
		}
		return this.log.summary(consolidated);
	}

	/**
	 * Per-record files land via their own temp+rename (atomicWriteFile cleans
	 * its temp on failure) and stay finalized — the PHP per-record save
	 * posture; consolidation temps clean themselves (writeMergedRdf,
	 * createZip). NOTHING is swept here: abort may run unfenced, and a `.tmp-*`
	 * in the shared directory may be another session's in-flight write (DIFF-2).
	 * A crashed holder's leftovers are swept by the next FENCED close
	 * (sweepStaleTemps).
	 */
	async abort(): Promise<void> {
		// no-op by design
	}
}

/** The 'rdf' format writer (registry entry). */
export const rdfWriter: DiffusionWriter = {
	format: 'rdf',
	async open(plan: PublicationPlan, context?: WriterOpenContext): Promise<WriterSession> {
		return new RdfWriterSession(plan, context);
	},
};
