/**
 * XML writer — the 'xml' DiffusionWriter (DIFFUSION_SPEC §4.3 "rdf / xml:
 * one deterministic file per record; close() does type-aware merge + ZIP,
 * all temp+rename"). PHP oracle: diffusion/class.diffusion_xml.php
 * (DOMDocument render_dom + write_file); merge grammar: old engine
 * diffusion/api/v1/lib/rdf_file_utils.ts merge_xml_parts (:96-121).
 *
 * Layout — IDENTICAL to the delete-side grammar so publish and unpublish
 * stay in lockstep (diffusion_delete.ts resolvePublishedFilePath :367-369;
 * PHP get_record_file_path class.diffusion_xml.php:565-566):
 *
 *   <root>/xml/<serviceName>/<section_tipo>_<section_id>.xml
 *
 * Document shape (PHP render_dom: DOMDocument('1.0','UTF-8') with
 * formatOutput pretty-print = 2-space indent; root node = the diffusion
 * root's ontology label, fields = child elements named by their labels,
 * translatable values = per-lang alpha2 child elements — class.diffusion_xml
 * .php resolve_langs :1164-1226 "<title><en>My title</en><es>Mi título</es>
 * </title>"; real v6-published fixture media_mib/xml/numisdata5_5777_*.xml
 * shows the same declaration + 2-space nesting):
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <publication_bulletin>
 *     <title>
 *       <en>My title</en>
 *       <es>Mi título</es>
 *     </title>
 *   </publication_bulletin>
 *
 * Element names pass through sanitizeXmlNodeName — the VERBATIM port of PHP
 * sanitize_xml_node_name (:1245-1268; invalid chars → '_', digit/period
 * start → '_' prefix, reserved 'xml' prefix → 'x' prefix). The tabular ride:
 * this writer consumes ProjectedRows like csv/json/markdown — lang-null rows
 * render the value inline in the field element (PHP single-nolan-lang
 * inline case :1176-1179); lang-coded rows render per-lang children. Null
 * columns are omitted entirely; empty strings render empty elements (PHP
 * createElement without a text child).
 *
 * Ledgered divergences (deliberate, determinism):
 * - NO wall-clock: consolidated artifacts are `diffusion_xml_merged.xml` /
 *   `diffusion_xml.zip` (old engine stamped `_<date>` tags — dropped like
 *   the markdown writer's zip; who/when live in the dd1758 activity log).
 * - removeRecords unlinks the canonical file only — the TS delete-side
 *   grammar (diffusion_delete.ts has no xml legacy-variant branch; PHP
 *   delete_record_file additionally globbed pre-v7 timestamped names).
 *   Publish/delete stay in lockstep with diffusion_delete.ts, the single
 *   source of truth on this side.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { mkdirDurably } from '../../core/files/durable.ts';
import type { PublicationPlan, SectionPlan } from '../plan/types.ts';
import type { ProjectedRow } from '../project/lang_ladder.ts';
import {
	atomicWriteFile,
	createZip,
	formatTargetDir,
	manifestPaths,
	planColumnNames,
	readManifestPart,
	recordFileName,
	sweepStaleTemps,
	WriterRunLog,
	withTrailingPath,
} from './files.ts';
import {
	CONSOLIDATED_MERGED_PREFIX,
	CONSOLIDATED_ZIP_PREFIX,
	escapeXmlText,
	requireFilesTarget,
	StreamedMergeOutput,
	withdrawConsolidated,
} from './rdf.ts';
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

/**
 * Ensure a label is a legal XML element name — VERBATIM port of PHP
 * sanitize_xml_node_name (class.diffusion_xml.php:1245-1268): strip invalid
 * chars to '_', force a letter/underscore start, guard the reserved 'xml'
 * prefix. Empty input sanitizes to '_' (PHP would skip the node; the tabular
 * plan never emits empty labels — compile validates them).
 */
export function sanitizeXmlNodeName(name: string): string {
	// 1. keep letters, digits, hyphens, underscores and periods only
	let sanitized = name.replace(/[^a-zA-Z0-9_\-.]/g, '_');
	// 2. XML names must start with a letter or underscore
	if (!/^[a-zA-Z_]/.test(sanitized)) {
		sanitized = `_${sanitized}`;
	}
	// 3. reserved 'xml' prefix (case-insensitive) → prepend 'x'
	if (/^xml/i.test(sanitized)) {
		sanitized = `x${sanitized}`;
	}
	return sanitized;
}

/**
 * Render one record (all langs of one section_id) as a standalone XML
 * document — see the module doc-comment for the PHP-anchored shape.
 */
export function renderXmlRecord(section: SectionPlan, rows: ProjectedRow[]): string {
	const rootName = sanitizeXmlNodeName(section.tableName);
	const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', `<${rootName}>`];

	for (const columnName of planColumnNames(section)) {
		const fieldName = sanitizeXmlNodeName(columnName);
		// null columns omitted: skip the element when NO row carries a value
		const valuedRows = rows.filter((row) => (row.columns[columnName] ?? null) !== null);
		if (valuedRows.length === 0) continue;

		const inline = valuedRows.length === 1 && valuedRows[0]?.lang === null;
		if (inline) {
			// nolan single value → inline text (PHP resolve_langs :1176-1179)
			const value = valuedRows[0]?.columns[columnName] ?? '';
			lines.push(
				value === ''
					? `  <${fieldName}/>`
					: `  <${fieldName}>${escapeXmlText(value)}</${fieldName}>`,
			);
			continue;
		}
		// translatable → one alpha2 child per lang (PHP :1211-1222)
		lines.push(`  <${fieldName}>`);
		for (const row of valuedRows) {
			const value = row.columns[columnName] as string;
			const langName = sanitizeXmlNodeName(row.lang === null ? 'nolan' : langToAlpha2(row.lang));
			lines.push(
				value === ''
					? `    <${langName}/>`
					: `    <${langName}>${escapeXmlText(value)}</${langName}>`,
			);
		}
		lines.push(`  </${fieldName}>`);
	}

	lines.push(`</${rootName}>`);
	return `${lines.join('\n')}\n`;
}

/**
 * Dédalo lang code → alpha2 node names (PHP lang::get_alpha2_from_code). Unknown codes fall back to the
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

/** The xml part's inner block under `rootName` (the part trimmed when it has no such root). */
function xmlInnerBlock(part: string, rootName: string): string {
	const open = part.indexOf(`<${rootName}`);
	const openEnd = part.indexOf('>', open);
	const close = part.lastIndexOf(`</${rootName}>`);
	if (open === -1 || close === -1 || openEnd === -1 || close <= openEnd) return part.trim();
	return part.slice(openEnd + 1, close).trim();
}

/**
 * Generic XML consolidation, STREAMED (PERF-2/DIFF-4) — the old engine's
 * merge_xml_parts (rdf_file_utils.ts:96-121), byte for byte (the frozen
 * in-memory port is test/helpers/merge_oracle.ts; gate:
 * diffusion_rdfxml_writers "streamed merge == frozen oracle"): root element
 * (name + attrs) from the FIRST non-empty part, every part's root-children
 * joined by a blank line under it. When the first part has no root, the parts
 * are joined by a newline (old-engine behaviour); a later part without the
 * root is included trimmed. A single part is written untouched. Parts are read
 * one at a time; memory is bounded by the two largest. Returns how many
 * non-empty parts were merged (zero ⇒ nothing written).
 */
export async function writeMergedXml(
	paths: AsyncIterable<string>,
	outPath: string,
	onMissing: (path: string) => void = () => {},
): Promise<{ parts: number }> {
	const output = new StreamedMergeOutput(outPath);
	let first: string | null = null;
	let root: { name: string; attrs: string } | null = null;
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
			if (part.trim().length === 0) continue;
			parts++;
			if (first === null) {
				first = part; // held back: alone, it is the result verbatim
				continue;
			}
			if (parts === 2) {
				const rootMatch =
					first.match(/<\?xml[^>]*\?>\s*<([A-Za-z_][\w:.-]*)([^>]*)>/) ??
					first.match(/^\s*<([A-Za-z_][\w:.-]*)([^>]*)>/);
				if (rootMatch) {
					root = { name: rootMatch[1] as string, attrs: rootMatch[2] ?? '' };
					await output.write(
						`<?xml version="1.0" encoding="utf-8"?>\n<${root.name}${root.attrs}>\n\n`,
					);
					await writeBlock(xmlInnerBlock(first, root.name));
				} else {
					await output.write(first);
				}
			}
			if (root === null) await output.write(`\n${part}`);
			else await writeBlock(xmlInnerBlock(part, root.name));
		}
		if (parts === 1) await output.write(first as string);
		else if (root !== null) await output.write(`\n\n</${root.name}>\n`);
		await output.commit();
		return { parts };
	} catch (error) {
		await output.discard();
		throw error;
	}
}

/** Consolidated artifact names — old grammar minus the wall-clock date tag. */
const XML_MERGED_NAME = 'diffusion_xml_merged.xml';
const XML_ZIP_NAME = 'diffusion_xml.zip';

class XmlWriterSession implements WriterSession {
	private readonly serviceName: string;
	private readonly targetDir: string;
	private readonly sections: Map<string, SectionPlan>;
	private readonly log: WriterRunLog;
	private schemaEnsured = false;

	constructor(plan: PublicationPlan, context?: WriterOpenContext) {
		this.serviceName = requireFilesTarget('xml', plan);
		this.targetDir = formatTargetDir('xml', this.serviceName);
		this.sections = new Map(plan.sections.map((section) => [section.sectionTipo, section]));
		this.log = new WriterRunLog(
			plan.sections.map((section) => section.tableName),
			context,
		);
	}

	get continuity(): WriterContinuity {
		return this.log.continuity;
	}

	/**
	 * Per-record file path — the EXACT delete-side grammar
	 * (diffusion_delete.ts:367-369 `${sectionTipo}_${sectionId}.xml`; PHP
	 * class.diffusion_xml.php:565).
	 */
	private recordPath(section: SectionPlan, sectionId: number | string): string {
		return `${this.targetDir}/${recordFileName(section.sectionTipo, sectionId, 'xml')}`;
	}

	/** File-target "schema" = the run directory exists (no DDL). */
	async ensureSchema(): Promise<void> {
		mkdirDurably(this.targetDir);
		this.schemaEnsured = true;
	}

	/**
	 * Group the batch's rows per section_id (the projection emits every lang
	 * of a record together) and land ONE deterministic .xml per record, each
	 * via its own temp+rename.
	 */
	async writeRows(section: SectionPlan, rows: ProjectedRow[]): Promise<WriteBatchResult> {
		if (rows.length === 0) return { written: 0, deleted: 0 };
		if (!this.schemaEnsured) {
			throw new Error(
				`xml writer: writeRows('${section.tableName}') before ensureSchema() — the run directory is created there`,
			);
		}
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
				renderXmlRecord(section, group.rows),
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
	 * Unlink the deterministic per-record files. Missing file = idempotent
	 * success with zero deletions (diffusion_delete.ts xml grammar; PHP
	 * delete_record_file "no file found (already removed)").
	 */
	async removeRecords(
		section: SectionPlan,
		sectionIds: (number | string)[],
	): Promise<WriteBatchResult> {
		let deleted = 0;
		for (const sectionId of sectionIds) {
			const filePath = this.recordPath(section, sectionId);
			if (existsSync(filePath)) {
				unlinkSync(filePath);
				this.log.barrier.add(this.targetDir); // durable at checkpoint()
				deleted++;
			}
			this.log.note('removed', section.sectionTipo, sectionId); // never merged/zipped again
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
	 * manifest under the first document's root (writeMergedXml, streamed), then
	 * ZIP the per-record files + the merged document (old engine
	 * index.ts:543-563) — two manifest passes, everything temp+rename, memory
	 * bounded. Consolidated paths ride the summary as prefixed zero-count table
	 * entries — see rdf.ts CONSOLIDATED_MERGED_PREFIX for the runner mapping.
	 */
	async close(context?: WriterCloseContext): Promise<WriterRunSummary> {
		const run = this.log.closeContext(context);
		await sweepStaleTemps(this.targetDir, run);
		const pathOf = (entry: ManifestEntry): string | null => {
			const section = this.sections.get(entry.sectionTipo);
			return section === undefined ? null : this.recordPath(section, entry.sectionId);
		};
		const consolidated: WriterRunSummary['tables'] = [];
		const mergedPath = `${this.targetDir}/${XML_MERGED_NAME}`;
		const missing = (path: string): void => {
			this.log.errors.add(`xml close: published file missing, left out of the archive: ${path}`);
		};
		const { parts } = await writeMergedXml(
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
				`${this.targetDir}/${XML_ZIP_NAME}`,
				{ onMissing: missing },
			);
			const relativeDir = `/xml/${this.serviceName}`;
			consolidated.push(
				{
					table_name: `${CONSOLIDATED_MERGED_PREFIX}${relativeDir}/${XML_MERGED_NAME}`,
					records_affected: 0,
					records_count: 0,
				},
				{
					table_name: `${CONSOLIDATED_ZIP_PREFIX}${relativeDir}/${XML_ZIP_NAME}`,
					records_affected: 0,
					records_count: 0,
				},
			);
		} else {
			// Nothing to consolidate: the previous run's merged document and zip
			// still hold the records this run withdrew — gone, never reported.
			withdrawConsolidated(this.targetDir, [XML_MERGED_NAME, XML_ZIP_NAME]);
		}
		return this.log.summary(consolidated);
	}

	/**
	 * Per-record files land via their own temp+rename (atomicWriteFile cleans
	 * its temp on failure) and stay finalized — the PHP per-record save
	 * posture; consolidation temps clean themselves (writeMergedXml,
	 * createZip). NOTHING is swept here: abort may run unfenced, and a `.tmp-*`
	 * in the shared directory may be another session's in-flight write (DIFF-2).
	 * A crashed holder's leftovers are swept by the next FENCED close
	 * (sweepStaleTemps).
	 */
	async abort(): Promise<void> {
		// no-op by design
	}
}

/** The 'xml' format writer (registry entry). */
export const xmlWriter: DiffusionWriter = {
	format: 'xml',
	async open(plan: PublicationPlan, context?: WriterOpenContext): Promise<WriterSession> {
		return new XmlWriterSession(plan, context);
	},
};
