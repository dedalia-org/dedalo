/**
 * RDF writer — the 'rdf' DiffusionWriter (DIFFUSION_SPEC §4.3 "rdf / xml:
 * one deterministic file per record; close() does type-aware merge + ZIP,
 * all temp+rename"). PHP origin: diffusion/class.diffusion_rdf.php (EasyRdf
 * rdfxml serialisation); merge grammar: old engine
 * diffusion/api/v1/lib/rdf_file_utils.ts merge_rdf_parts (:72-85).
 *
 * Layout — IDENTICAL to the delete-side grammar so publish and unpublish
 * stay in lockstep (core/diffusion_bridge/published_files.ts):
 *
 *   <root>/rdf/<serviceName>/<sanitize(rdfName_sectionTipo_sectionId)>.rdf
 *
 * where rdfName is the owl:Class label (SectionPlan.tableName, verbatim).
 *
 * WHAT IS WRITTEN is the record's RDF GRAPH (resolve/rdf_graph.ts — the
 * build_rdf_node interpretation: owl:Class subjects from the dd1010
 * entity-publication services, owl:ObjectProperty predicates, typed literals,
 * nested portal nodes, linked rdf nodes), serialised by
 * writers/rdf_xml_serialiser.ts with the element's declared xmlns. There is
 * no column/row face: writeRows REFUSES (an rdf plan resolves graphs, never
 * rows). Deliberate divergences from PHP: WC-2026-11-12-rdf-graph-interpretation.
 *
 * - NO wall-clock anywhere: consolidated artifacts are `diffusion_rdf_merged
 *   .rdf` / `diffusion_rdf.zip` (old engine stamped `_<date>` tags — dropped,
 *   so re-runs are byte-identical; who/when live in the dd1758 activity log).
 * - The merged document declares the UNION of the parts' xmlns (EasyRdf
 *   declares only the prefixes a document uses, so the first part's envelope
 *   alone can leave a later block's prefix undeclared); a prefix bound to two
 *   URIs is a loud refusal, never a guess.
 *
 * removeRecords unlinks the canonical file + the legacy '{base}_*.rdf'
 * variants — the EXACT diffusion_delete.ts unlinkPublishedFiles rdf branch;
 * missing files = idempotent success.
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readdirSync,
	readSync,
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
import { RdfNamespaceTable, type RdfRecordDocument } from '../resolve/rdf_graph_ir.ts';
import {
	atomicWriteFile,
	createZip,
	formatTargetDir,
	manifestPaths,
	readManifestPart,
	sweepStaleTemps,
	WriterRunLog,
	withTrailingPath,
} from './files.ts';
import { serialiseRdfXml } from './rdf_xml_serialiser.ts';
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

/** XML text-node escaping (what EasyRdf/DOMDocument createTextNode does). */
export function escapeXmlText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
		await this.writeBytes(Buffer.from(text, 'utf-8'));
	}

	/** Raw bytes (a spooled body copied back — never split mid-character by a decode). */
	async writeBytes(bytes: Uint8Array): Promise<void> {
		if (bytes.byteLength === 0) return;
		if (this.fd === null) {
			mkdirDurably(dirname(this.outPath));
			this.tempPath = tempPathFor(this.outPath);
			this.fd = openSync(this.tempPath, 'w');
		}
		writeAllSync(this.fd, bytes);
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

/** `xmlns:prefix="uri"` declarations of one `<rdf:RDF …>` opener, in order. */
const XMLNS_DECLARATION = /xmlns:([A-Za-z_][\w.-]*)="([^"]*)"/g;

function openerDeclarations(opener: string): [string, string][] {
	return [...opener.matchAll(XMLNS_DECLARATION)].map((match) => [
		match[1] as string,
		match[2] as string,
	]);
}

/** A fresh copy of a (small) string — a regex/slice result may keep its whole part alive. */
function detached(value: string): string {
	return Buffer.from(value, 'utf-8').toString('utf-8');
}

/**
 * The merged envelope's opener, accumulated part by part: the FIRST part's
 * opener verbatim, plus — in first-seen order — every prefix a later part
 * declares that the first does not (EasyRdf declares only the prefixes a
 * document uses). A prefix bound to two different URIs across the run's parts
 * is refused: the parts were not written under one namespace table, and no
 * single envelope can be right. Only the declarations are kept (detached), never
 * a part's opener — a substring would pin its whole part in memory.
 */
class RdfEnvelopeUnion {
	private readonly bound = new Map<string, string>();
	private readonly additions: [string, string][] = [];
	private readonly firstOpener: string;
	private readonly firstHasDeclarations: boolean;

	constructor(firstOpener: string) {
		this.firstOpener = detached(firstOpener);
		const declarations = openerDeclarations(this.firstOpener);
		for (const [prefix, uri] of declarations) this.bound.set(prefix, uri);
		this.firstHasDeclarations = declarations.length > 0;
	}

	add(opener: string): void {
		for (const [prefix, uri] of openerDeclarations(opener)) {
			const known = this.bound.get(prefix);
			if (known === undefined) {
				this.bound.set(detached(prefix), detached(uri));
				this.additions.push([detached(prefix), detached(uri)]);
			} else if (known !== uri) {
				throw new DedaloError('internal.invariant', {
					message: `rdf merge: prefix '${prefix}' is bound to '${known}' and '${uri}' in parts of one run — republish the element so every record is written under its current xmlns`,
				});
			}
		}
	}

	opener(): string {
		if (this.additions.length === 0) return this.firstOpener;
		const declared = this.additions.map(([prefix, uri], index) => {
			// '<rdf:RDF ' is 9 chars — continuation xmlns lines align under the first (EasyRdf).
			const separator = index === 0 && !this.firstHasDeclarations ? ' ' : '\n         ';
			return `${separator}xmlns:${prefix}="${uri}"`;
		});
		return `${this.firstOpener.slice(0, -1)}${declared.join('')}>`;
	}
}

/** The union opener of a first part's opener and later ones (RdfEnvelopeUnion). */
export function rdfUnionOpener(firstOpener: string, laterOpeners: readonly string[]): string {
	const union = new RdfEnvelopeUnion(firstOpener);
	for (const opener of laterOpeners) union.add(opener);
	return union.opener();
}

/** Spool chunk for copying the merged body back behind its envelope. */
const SPOOL_CHUNK_BYTES = 1 << 20;

/**
 * Type-aware consolidation, STREAMED (PERF-2/DIFF-4) — the old engine's
 * merge_rdf_parts (rdf_file_utils.ts:72-85; the frozen in-memory port is
 * test/helpers/merge_oracle.ts; gate: diffusion_rdfxml_writers "streamed merge
 * == frozen oracle"): envelope from the FIRST non-empty part, inner blocks of
 * every part joined by a blank line — EXCEPT the envelope declares the UNION
 * of the parts' xmlns (rdfUnionOpener; equal to the oracle whenever no later
 * part adds a prefix). The union is only known after the last part, so the
 * body is spooled to a temp sibling and copied back behind the envelope:
 * memory stays bounded by one part. A single part is written untouched. NOTE
 * the merged declaration has NO space before '?>' — old engine :84. Returns
 * how many non-empty parts were merged.
 */
export async function writeMergedRdf(
	paths: AsyncIterable<string>,
	outPath: string,
	onMissing: (path: string) => void = () => {},
): Promise<{ parts: number }> {
	const output = new StreamedMergeOutput(outPath);
	const spoolPath = tempPathFor(`${outPath}.body`);
	let spool: number | null = null;
	let first: string | null = null;
	let union: RdfEnvelopeUnion | null = null;
	let parts = 0;
	let blocks = 0;
	const spoolBlock = (block: string): void => {
		if (block.length === 0) return;
		if (spool === null) {
			mkdirDurably(dirname(outPath));
			spool = openSync(spoolPath, 'w+');
		}
		writeAllSync(spool, Buffer.from(blocks > 0 ? `\n\n${block}` : block, 'utf-8'));
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
			if (union === null) {
				union = new RdfEnvelopeUnion(firstHtmlTag(first, RDF_OPENER)?.tag ?? '<rdf:RDF>');
				spoolBlock(rdfInnerBlock(first));
			}
			const opener = firstHtmlTag(part, RDF_OPENER)?.tag;
			if (opener !== undefined) union.add(opener);
			spoolBlock(rdfInnerBlock(part));
		}
		if (parts === 1) await output.write(first as string);
		else if (union !== null) {
			const opener = union.opener();
			await output.write(`<?xml version="1.0" encoding="utf-8"?>\n${opener}\n\n`);
			if (spool !== null) {
				const buffer = Buffer.alloc(SPOOL_CHUNK_BYTES);
				let position = 0;
				for (;;) {
					const read = readSync(spool, buffer, 0, buffer.byteLength, position);
					if (read === 0) break;
					await output.writeBytes(buffer.subarray(0, read));
					position += read;
				}
			}
			await output.write('\n\n</rdf:RDF>\n');
		}
		await output.commit();
		return { parts };
	} catch (error) {
		await output.discard();
		throw error;
	} finally {
		if (spool !== null) {
			closeSync(spool);
			try {
				unlinkSync(spoolPath);
			} catch {
				// already gone — nothing left behind
			}
		}
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
	/** The element's declared xmlns (plan.rdf, compiled from properties.diffusion.xmlns). */
	private readonly namespaces: RdfNamespaceTable;
	private schemaEnsured = false;

	constructor(plan: PublicationPlan, context?: WriterOpenContext) {
		this.serviceName = requireFilesTarget('rdf', plan);
		if (plan.rdf === undefined) {
			throw new DedaloError('internal.invariant', {
				message: `rdf writer: plan '${plan.planId}' carries no compiled rdf element (namespaces, service type) — an rdf element compiles one or fails`,
			});
		}
		this.namespaces = new RdfNamespaceTable(plan.rdf.namespaces);
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

	private recordPath(section: SectionPlan, sectionId: number | string): string {
		return `${this.targetDir}/${rdfRecordFileName(section, sectionId)}`;
	}

	/** File-target "schema" = the run directory exists (no DDL). */
	async ensureSchema(): Promise<void> {
		mkdirDurably(this.targetDir);
		this.schemaEnsured = true;
	}

	/**
	 * An rdf plan resolves GRAPHS (ResolvedBatch.graphs), never rows: a row
	 * reaching this writer means a caller bypassed the graph interpretation —
	 * refused, never rendered as a flat column document.
	 */
	async writeRows(section: SectionPlan, rows: ProjectedRow[]): Promise<WriteBatchResult> {
		if (rows.length === 0) return { written: 0, deleted: 0 };
		throw new DedaloError('internal.invariant', {
			message: `rdf writer: writeRows('${section.tableName}') — rdf records are written as graphs (writeGraphs), never as rows`,
		});
	}

	/**
	 * Land ONE deterministic .rdf per record graph, each via its own
	 * temp+rename (PHP save_record_file per record).
	 */
	async writeGraphs(
		section: SectionPlan,
		documents: RdfRecordDocument[],
	): Promise<WriteBatchResult> {
		if (documents.length === 0) return { written: 0, deleted: 0 };
		if (!this.schemaEnsured) {
			throw new DedaloError('internal.invariant', {
				message: `rdf writer: writeGraphs('${section.tableName}') before ensureSchema() — the run directory is created there`,
			});
		}
		for (const document of documents) {
			atomicWriteFile(
				this.recordPath(section, document.sectionId),
				serialiseRdfXml(document.graph, this.namespaces),
				this.log.barrier,
			);
			this.log.note('wrote', section.sectionTipo, document.sectionId);
		}
		const counters = this.log.countersFor(section.tableName);
		counters.records_affected += documents.length;
		counters.records_count += documents.length;
		return { written: documents.length, deleted: 0 };
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

	/** C49: the held-back records whose previous file still stands join the manifest (WriterSession.keepPublished). */
	async keepPublished(
		section: SectionPlan,
		sectionIds: (number | string)[],
	): Promise<(number | string)[]> {
		const kept: (number | string)[] = [];
		for (const sectionId of sectionIds) {
			if (!existsSync(this.recordPath(section, sectionId))) continue;
			this.log.note('wrote', section.sectionTipo, sectionId);
			kept.push(sectionId);
		}
		return kept;
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
