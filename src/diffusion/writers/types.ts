/**
 * Format-writer contract (DIFFUSION_SPEC §4.3) — the boundary between the
 * resolution pipeline (plan × records → ProjectedRow/RecordIR) and target
 * I/O (MariaDB, files). Writers know NOTHING about ontology or resolution;
 * the pipeline knows nothing about SQL dialects or file layouts.
 *
 * Lifecycle per run: open(plan, context?) → ensureSchema() ONCE (serialized per
 * table; DDL auto-commits in MariaDB so it must never sit inside a row
 * transaction) → writeRows()/removeRecords() per committed batch (idempotent:
 * upserts by (section_id, lang); deletes tolerate missing tables), each
 * followed by takeArtifacts() + checkpoint() → close(context) (merges / zips /
 * marker union / counts) or abort() (releases the session's handles).
 *
 * A RUN OUTLIVES ITS SESSION (DIFF-1, WC-2026-09-30-diffusion-run-ledger). A
 * runner can die between two batches and a NEW session resumes the run; so
 * nothing the run's final artifacts depend on may live only in a session:
 *   - every per-record file a batch wrote or removed is reported as an
 *     ArtifactEvent (takeArtifacts) — the runner appends them to the job's run
 *     ledger in the batch's own transaction, and close() reads the run's
 *     MANIFEST back from it (WriterCloseContext);
 *   - checkpoint() is a durability barrier returning the session's resumable
 *     state (counters; a streamed file's byte offset, fsynced) — the runner
 *     commits it with the batch and hands it back to open() on resume, so the
 *     run summary counts the WHOLE run and a streamed snapshot continues where
 *     it was durable (`continuity`).
 * abort() never consolidates and never deletes a file it did not create in
 * that session: a target directory is shared with other sessions (DIFF-2).
 */

import type { PublicationPlan, SectionPlan } from '../plan/types.ts';
import type { ProjectedRow } from '../project/lang_ladder.ts';
import type { RdfRecordDocument } from '../resolve/rdf_graph_ir.ts';

/** Per-batch write result (feeds the job progress + final report). */
export interface WriteBatchResult {
	written: number;
	deleted: number;
}

/**
 * One per-record file the session wrote or removed — the run ledger's artifact
 * events. `sectionId` keeps the IR's type (a number and its string form are
 * different records to the manifest, as they are to the resolver's frontier).
 */
export interface ArtifactEvent {
	op: 'wrote' | 'removed';
	sectionTipo: string;
	sectionId: number | string;
}

/** One record of a run's artifact manifest (its file path is the writer's grammar). */
export interface ManifestEntry {
	sectionTipo: string;
	sectionId: number | string;
}

/** Final per-table counts for the client result payload (old engine shape). */
export interface WriterRunSummary {
	tables: { table_name: string; records_affected: number; records_count: number }[];
	errors: string[];
}

/** What a runner hands open(): the job, and the writer checkpoint it resumes from. */
export interface WriterOpenContext {
	/** The job's id — names job-scoped partial files (csv / json). */
	jobId: string;
	/** `checkpoint().` of the last committed batch, or null for a fresh run. */
	resume: unknown | null;
}

/** What close() reads the RUN's artifacts from (the job's run ledger). */
export interface WriterCloseContext {
	/**
	 * The run's published records, in the order a Set replay of its artifact
	 * events gives: first write after the last removal, removed ones absent.
	 * May be iterated more than once (a merge pass, then a zip pass).
	 */
	manifest(): AsyncIterable<ManifestEntry>;
	/** Every id the run removed from `sectionTipo` (full-export filters). */
	removed(sectionTipo: string): AsyncIterable<number | string>;
	/**
	 * The close runs UNDER THE TARGET'S FENCE (jobs/target_fence.ts — the
	 * runner's close unit): no other session can be writing in the target
	 * directory, so a leftover `.tmp-*` sibling there is a dead holder's, and is
	 * swept (files.ts sweepStaleTemps). Absent = never sweep a temp.
	 */
	fenced?: boolean;
	/**
	 * Is the job that owns a leftover `.part-<jobId>` partial gone for good
	 * (missing, or completed)? Absent = never sweep another job's partial.
	 */
	partialIsOrphan?(jobId: string): Promise<boolean>;
}

/**
 * How a session met its resume state: `fresh` (no resume given), `resumed`
 * (the checkpoint was honoured), `restart_required` (the checkpoint cannot be
 * honoured — e.g. a job-scoped partial is gone or shorter than its checkpoint
 * — the runner resets the run and reopens fresh).
 */
export type WriterContinuity = 'fresh' | 'resumed' | 'restart_required';

export interface WriterSession {
	readonly continuity: WriterContinuity;
	/** Create/evolve the target schema for every section of the plan. */
	ensureSchema(): Promise<void>;
	/** Upsert one section's projected rows (one transaction per call). */
	writeRows(section: SectionPlan, rows: ProjectedRow[]): Promise<WriteBatchResult>;
	/**
	 * rdf only: land one document per published record (ResolvedBatch.graphs —
	 * an rdf plan resolves GRAPHS, never rows; its writeRows refuses).
	 */
	writeGraphs?(section: SectionPlan, documents: RdfRecordDocument[]): Promise<WriteBatchResult>;
	/** Remove published records (unpublish + delete propagation). */
	removeRecords(section: SectionPlan, sectionIds: (number | string)[]): Promise<WriteBatchResult>;
	/** The artifact events since the previous call (in order), and forget them. */
	takeArtifacts(): ArtifactEvent[];
	/** Durability barrier: everything written so far is durable; returns the resumable state (JSON). */
	checkpoint(): Promise<unknown>;
	/** The counters so far (resumed counts included) — e.g. a cancelled run's result. */
	runSummary(): WriterRunSummary;
	/**
	 * Finalize the RUN: consolidated artifacts from `context.manifest()`. Without
	 * a context, the session's own events stand in (files.ts localCloseContext) —
	 * only for a session opened WITHOUT a job; a job-scoped session keeps no
	 * history (the run ledger is its memory) and refuses a context-less close.
	 */
	close(context?: WriterCloseContext): Promise<WriterRunSummary>;
	/** Release handles; never consolidates; never deletes a file another session may own. */
	abort(): Promise<void>;
}

export interface DiffusionWriter {
	/** The ontology properties->diffusion->type this writer serves. */
	readonly format: string;
	open(plan: PublicationPlan, context?: WriterOpenContext): Promise<WriterSession>;
}

/** Per-table counters every writer keeps (records_affected / records_count). */
export interface TableCounters {
	records_affected: number;
	records_count: number;
}

/**
 * Counters a checkpoint carried, by table name — the resumed session starts
 * from them so the run summary covers the whole run. Anything malformed reads
 * as zero (a checkpoint is the writer's own JSON; never trusted blindly).
 */
export function restoredCounters(resume: unknown): Map<string, TableCounters> {
	const restored = new Map<string, TableCounters>();
	const tables = (resume as { tables?: unknown } | null)?.tables;
	if (tables === null || typeof tables !== 'object') return restored;
	for (const [tableName, value] of Object.entries(tables as Record<string, unknown>)) {
		const counters = value as Partial<TableCounters> | null;
		restored.set(tableName, {
			records_affected: Number(counters?.records_affected) || 0,
			records_count: Number(counters?.records_count) || 0,
		});
	}
	return restored;
}
