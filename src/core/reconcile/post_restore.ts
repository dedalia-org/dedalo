/**
 * POST-RESTORE PLAN — what the reconcile registry does right after a DATA
 * restore (audit 2026-08-26 S-7; the door is
 * src/core/area_maintenance/restore_door.ts, phase 5 — `restore` mode only:
 * a rehearsal into another database never runs it, because the registry runs
 * through the pool and the pool is bound to the configured database).
 *
 * WHY A PLAN AND NOT "run everything --apply". A restore rolls the matrix back
 * to the artifact's instant; the stores beside it (the media tree, the
 * publication marker store, observer mirror slots, the vector index, the
 * `dd_ontology` projection, the hierarchy provisioning) were NOT rolled back.
 * Every registered reconcile is therefore worth RUNNING — but only two are
 * safe to APPLY unattended:
 *
 *  - `counters_media` is raise-only and idempotent: the allocator's floor cannot
 *    see files of records created after the backup (PRODUCTION.md §6.1 step 5,
 *    "only the disk remembers"), and raising a counter never destroys anything.
 *  - `media_index` is a pure derivation (`pub/` recomputed from `dbs/`), the
 *    same auto-apply the boot scheduler already performs.
 *
 * The rest report DRIFT and hold: a `files_info` SHRINK, an observer-mirror
 * recompute, a destructive ontology re-projection, a hierarchy `ensure` are an
 * operator's decision, with the dry report in view — exactly the posture
 * PRODUCTION.md §6.5 gives the scheduler.
 *
 * TOTAL OVER THE REGISTRY. The plan names EVERY `REGISTERED_NAMES` entry with
 * an explicit apply/dry verdict and a reason (the gate holds the two sets
 * equal), so an eighth reconcile cannot land without deciding what a restore
 * does with it. A step that throws is recorded by its error CODE and the plan
 * continues: the restore already happened, and one store's reconcile failing
 * must not hide the other six verdicts from the operator.
 */

import { DedaloError } from '../errors/dedalo_error.ts';
import { registerAllReconciles } from './catalog.ts';
import { type ReconcileReport, runReconcile } from './registry.ts';

export interface PostRestoreStep {
	/** A `REGISTERED_NAMES` entry. */
	readonly name: string;
	/** true = repair; false = report drift and hold. */
	readonly apply: boolean;
	/** Why THIS verdict, in operator words. */
	readonly why: string;
}

/** The plan, in registry order. Grow/shrink only with `REGISTERED_NAMES`. */
export const POST_RESTORE_PLAN: readonly PostRestoreStep[] = [
	{
		name: 'counters_media',
		apply: true,
		why: 'raise-only and idempotent: the restore rolled matrix_counter back with the data, and only the media tree remembers the ids minted after the backup',
	},
	{
		name: 'files_info',
		apply: false,
		why: 'GROW/DIFF rewrites are safe but a SHRINK deletes cached derivative knowledge; the operator reads the dry report and applies with scripts/media_repair_files_info.ts',
	},
	{
		name: 'observer_mirrors',
		apply: false,
		why: 'a full-law mirror recompute over every observer target is an operator-budgeted run (scripts/observer_reconcile.ts --budget), not restore-day hygiene',
	},
	{
		name: 'media_index',
		apply: true,
		why: 'pub/ is a pure derivation of dbs/ — the same auto-apply the boot scheduler performs after every listen',
	},
	{
		name: 'rag_index',
		apply: false,
		why: 'apply enqueues index/delete work for the drain against a vector store that may itself have been restored separately; the dry count tells the operator whether to re-embed or restore it',
	},
	{
		name: 'ontology',
		apply: false,
		why: 'apply is a DESTRUCTIVE re-projection of dd_ontology per drifted TLD; the dry verdict names the TLDs and the operator decides',
	},
	{
		name: 'ontology_identifiers',
		apply: false,
		why: "apply DELETES every dd_ontology row it cannot re-derive from a tld source (returned whole in the report); the restored table carries its backup instant's rows and CHECK states, so the dry list is the operator's to confirm",
	},
	{
		name: 'hierarchy',
		apply: false,
		why: 'ensure re-provisions a hierarchy; the dry verdict names the broken ones and the operator applies from the maintenance area',
	},
	{
		name: 'public_tier',
		apply: false,
		why: 'a restore makes every record published after the backup a public-tier GHOST; apply UNPUBLISHES them from a museum site, which the operator confirms against the dry list rather than a door doing it unasked',
	},
	{
		name: 'publication_apis',
		apply: false,
		why: 'a DATA restore does not change the code tree, and pushing Publication API code to a public host is root-only (publication_hosts push_apis) or done by a confirmed CODE restore boot; the dry verdict names the hosts that lag',
	},
	{
		name: 'media_copy',
		apply: true,
		why: 'a data restore re-derives pub/ (media_index, applied just before in registry order); every copy-mode publication host must follow it, or a record unpublished in the restored data keeps its public bytes — the same pure derivation the scheduler applies every period',
	},
	{
		name: 'publication_probe',
		apply: false,
		why: 'an observation, never a repair: the dry run probes each host through its public URL and reports, writing nothing; after a restore its verdict tells the operator whether media unpublished since the backup instant is still served publicly (the next scheduled apply records it in the panel)',
	},
	{
		name: 'rich_text_images',
		apply: false,
		why: 'copies files and rewrites texts across records: the dry report names what a restored backup brought back as legacy, and the operator applies it from Maintenance',
	},
	{
		name: 'web_image_exposure',
		apply: false,
		why: 'a restore can bring back a web-folder file a published record does not embed; the dry run names it, and making it private stays a root decision',
	},
	{
		name: 'portal_declared_order',
		apply: false,
		why: 'a restore can bring back portal arrays stored before their declared order (or an archive written raw); apply re-sorts every drifted record through the save door with a Time Machine row each, at install scale, so the dry list names the portals and the operator applies it from Maintenance',
	},
	{
		name: 'ddo_self_depth',
		apply: false,
		why: "a definition check, never a repair: a restore can bring back an ontology whose request_config declares section_tipo 'self' below the first level; the dry list names each definition, and the correction is an edit on the master ontology (its apply is refused at the registry)",
	},
];

export interface PostRestoreStepResult {
	readonly name: string;
	readonly apply: boolean;
	/** The registry's report, or null when the step threw. */
	readonly report: ReconcileReport | null;
	/** The DedaloError CODE (or `internal.unexpected`) when the step threw. */
	readonly error: string | null;
	readonly durationMs: number;
}

export interface PostRestoreReport {
	readonly steps: readonly PostRestoreStepResult[];
	/** Names whose dry run reported drift the operator must still decide on. */
	readonly held: readonly string[];
	/** Names whose step threw. */
	readonly failed: readonly string[];
}

/**
 * Run the plan through the registry (so every verdict is also the `reconcile`
 * gauge's), in plan order, never stopping on one step's failure.
 *
 * `plan` is a test seam (default `POST_RESTORE_PLAN`): the gate prepends a
 * step the registry does not know, so the registry's own `resource.not_found`
 * is the thrown step — a real throw, recorded by code, the rest still run.
 */
export async function runPostRestore(
	options: { plan?: readonly PostRestoreStep[] } = {},
): Promise<PostRestoreReport> {
	await registerAllReconciles();
	const steps: PostRestoreStepResult[] = [];
	for (const step of options.plan ?? POST_RESTORE_PLAN) {
		const startedAt = Date.now();
		try {
			const { report } = await runReconcile(step.name, { apply: step.apply });
			steps.push({
				name: step.name,
				apply: step.apply,
				report,
				error: null,
				durationMs: Date.now() - startedAt,
			});
		} catch (error) {
			// runReconcile already logged the text and recorded the code in the gauge.
			steps.push({
				name: step.name,
				apply: step.apply,
				report: null,
				error: error instanceof DedaloError ? error.code : 'internal.unexpected',
				durationMs: Date.now() - startedAt,
			});
		}
	}
	return {
		steps,
		held: steps
			.filter((s) => !s.apply && s.report !== null && s.report.drift > 0)
			.map((s) => s.name),
		failed: steps.filter((s) => s.error !== null).map((s) => s.name),
	};
}
