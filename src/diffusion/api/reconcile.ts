/**
 * DIFFUSION FACADE — the diffusion reconciles as registry definitions
 * (core/reconcile/registry.ts, S-10). The ONE legal core→diffusion import
 * target for them (boundary_seam_tripwire: facade-only).
 *
 * Three definitions: `media_index` (pub/ markers derived from dbs/ markers — a
 * pure filesystem hygiene, applied at boot and on a period), `public_tier` (P1-12: what the
 * public tier holds — MariaDB rows, dbs/ markers, per-record files — against
 * what the matrix holds and flags publishable; operator-run, apply removes
 * ghosts only) and `media_copy` (pub/ ∩ public files against each copy-mode
 * publication agent's manifest, applied on its interval through the copy
 * worker's per-host lane — PUBLICATION_HOST_SPEC §5.2; its run lives in
 * media_copy_reconcile.ts).
 *
 * Stores: `.publication/dbs/<db>/<table>/<key>` (ground truth per publication
 * target, written by applyTableState) versus `.publication/pub/<key>` (the
 * union the web server stats). Drift = keys whose pub/ marker is missing or
 * stray. Apply = touch/unlink them — pure filesystem hygiene, idempotent,
 * never destructive of anything that is not itself derived, which is why the
 * SCHEDULED runs apply (the boot posture of the old engine, oracle index.ts:1183).
 */

import { runWebImageExposure } from '../../core/media/rich_text_image_reconcile.ts';
import { MEDIA_COPY_PERIOD_MS } from '../../core/publication_host/media_copy_status.ts';
import type {
	ReconcileDefinition,
	ReconcileReport,
	ReconcileRunOptions,
} from '../../core/reconcile/registry.ts';
import { retryPendingUnpublishOpportunistically } from '../jobs/pending_retry.ts';
import { runPublicTierReconcile } from '../targets/mariadb/public_tier_reconcile.ts';
import {
	diffMediaIndex,
	hasPubMarker,
	type MediaIndexFenceOptions,
	reconcileMediaIndex,
} from '../targets/mediastore/media_index.ts';
import { runMediaCopyReconcile } from './media_copy_reconcile.ts';

/**
 * The `media_index` run. The APPLY holds every marker database's fence (the
 * store's one apply door, media_index.ts reconcileMediaIndex, DIFF-2) within one
 * bounded wait; DEFERRED — a writer kept a database past it — applies nothing
 * and reports the drift a plain diff measures now (`applied` 0 against it, the
 * held target in `detail.deferred`), so the scheduler's warning and the gauge
 * show an apply that did not happen rather than a clean run — and the report's
 * `deferred` tells the scheduler the repair is still owed (it re-arms the run).
 * `fence` is the gate's seam for the bound; the registry passes none.
 *
 * THE FENCE IS EXCLUSIVE, AND THIS RUN IS PERIODIC (closure review 2026-10-22).
 * While it holds `sql:<db>`, a record delete on the request path does not wait
 * (its door is shared and `try` — residual R3 of the target fence): the
 * unpublish stays pending in dd1758. A runner's hold is followed by a publish
 * run, whose start drains that queue; this run's is followed by nothing on a
 * quiet install. So the run carries both halves itself:
 *  - NO DRIFT, NO FENCE. An unfenced diff first; in sync ⇒ done, no target
 *    held. Sound because it only decides whether to take the fence and applies
 *    nothing: drift no writer is working on (a crash's) reads the same locked or
 *    not, and a key a live writer is moving is re-derived by that writer's own
 *    union recompute (applyTableState) or the rebuild's closing reconcile.
 *  - A HOLD PAYS ITS DEBT. After an apply that held the fence, the pending
 *    unpublish queue is drained (the runner's own opportunistic door: single
 *    flight, patient, never throws) — a delete the hold left pending is settled
 *    by the same run; its lines go to `detail.pending_unpublish`, a debt still
 *    owed to the log.
 */
export async function runMediaIndexReconcile(
	{ apply }: ReconcileRunOptions,
	fence: MediaIndexFenceOptions = {},
): Promise<ReconcileReport> {
	const probe = await diffMediaIndex();
	if (probe === null) return { drift: 0, applied: 0, detail: { enabled: false } };
	const probed = probe.toAdd.length + probe.toRemove.length;
	if (!apply) {
		return {
			drift: probed,
			applied: 0,
			detail: { enabled: true, to_add: probe.toAdd, to_remove: probe.toRemove },
		};
	}
	if (probed === 0)
		return { drift: 0, applied: 0, detail: { enabled: true, added: 0, removed: 0 } };
	const healed = await reconcileMediaIndex(fence);
	if (healed === null) return { drift: 0, applied: 0, detail: { enabled: false } };
	if (healed.deferred !== undefined) {
		const diff = await diffMediaIndex();
		const drift = diff === null ? 0 : diff.toAdd.length + diff.toRemove.length;
		return {
			drift,
			applied: 0,
			detail: { enabled: true, deferred: healed.deferred },
			deferred: {
				reason: `publication target ${healed.deferred.busy_target} held by a writer past the fence budget`,
			},
		};
	}
	const drift = healed.added + healed.removed;
	const detail: Record<string, unknown> = { enabled: true, ...healed };
	const debt = await retryPendingUnpublishOpportunistically();
	if (debt.log.length > 0 || debt.errors.length > 0) detail.pending_unpublish = debt;
	for (const line of debt.errors) console.warn(`[reconcile] media_index: ${line}`);
	return { drift, applied: drift, detail };
}

/**
 * The media_index period (D5, owner decision 2026-10-21: boot + interval,
 * re-armed until done). Boot alone heals a crash of THIS process; the period
 * heals what happens while it lives: a diffusion runner is a separate process,
 * and one that dies between a pair's `dbs/` and `pub/` writes leaves a
 * published record whose media 404s (or an unpublished one still public) — the
 * module header's "until the next publish/reconcile/rebuild" needs a next
 * reconcile. Ten minutes: the copy-mode hosts mirror pub/ on the same cadence
 * (MEDIA_COPY_PERIOD_MS), and a run in sync is two unfenced directory walks —
 * the fence (and the drain after it) only when they found drift
 * (runMediaIndexReconcile above).
 */
export const MEDIA_INDEX_RECONCILE_EVERY_MS = 10 * 60_000;

export const MEDIA_INDEX_RECONCILE: ReconcileDefinition = {
	name: 'media_index',
	stores: [
		'.publication/dbs (per-target publication truth)',
		'.publication/pub (web-server union)',
	],
	description:
		'Rebuild the pub/ publication markers from the per-target dbs/ truth — heals a crash between a publication commit and its marker write; null-drift when the marker store is off.',
	scopeLabel: null,
	schedule: { everyMs: MEDIA_INDEX_RECONCILE_EVERY_MS, atBoot: true },
	autoApply: {
		reason:
			'pub/ is a pure derivation of dbs/: recomputing it can only add a marker the truth owns or drop one it does not; two directory walks, fenced only when they disagree — and a fenced apply settles the unpublishes its hold left pending (the archive already deleted those records)',
	},
	sources: ['src/diffusion/targets/mediastore/media_index.ts', 'src/diffusion/api/reconcile.ts'],
	// The pub/ union is derived from EVERY database's dbs/ subtree: the store's
	// one apply door holds the fence of every database that can write a marker
	// pair, and applies nothing from a round a new subtree appeared in
	// (media_index.ts reconcileMediaIndex, DIFF-2).
	run: (options) => runMediaIndexReconcile(options),
};

export const PUBLIC_TIER_RECONCILE: ReconcileDefinition = {
	name: 'public_tier',
	stores: [
		'matrix (record existence + publication flag)',
		'public tier (MariaDB rows, .publication/dbs markers, per-record rdf/xml/markdown files)',
	],
	description:
		'Report public-tier GHOSTS (records the matrix no longer holds or no longer flags publishable, still served) and MISSING publications (flagged, not in a target), plus the pending/terminal dd1758 unpublish debt; apply unpublishes ghosts only — a missing publication is a job, never a reconcile side effect. An unreachable MariaDB target is reported, its markers and files still compared.',
	scopeLabel: 'section tipo',
	schedule: 'operator',
	sources: [
		'src/diffusion/targets/mariadb/public_tier_reconcile.ts',
		'src/diffusion/api/reconcile.ts',
	],
	async run({ apply, scope }) {
		return runPublicTierReconcile(scope === undefined ? { apply } : { apply, scope });
	},
};

export const MEDIA_COPY_RECONCILE: ReconcileDefinition = {
	name: 'media_copy',
	stores: [
		'work host: .publication/pub ∩ public-quality media files',
		'copy-mode publication agents: media manifest + mirrored pub/ markers',
	],
	description:
		"Diff each copy-mode publication host's media (files + mirrored pub/ markers, from the agent manifest) against what the work host publishes; apply runs through the copy worker's per-host lane — copies what is missing (sha-verified), unmarks then deletes what is no longer published, verifies deletions against the manifest — and re-plans to measure what it fixed. Non-copy hosts are skipped (one withdrawn from copy mode while still holding bytes stays failed); an unreachable host is reported with its pending deletions, never as done.",
	scopeLabel: 'publication host name',
	schedule: { everyMs: MEDIA_COPY_PERIOD_MS },
	autoApply: {
		reason:
			'pure derivation of pub/ ∩ public files: an apply can only copy a file the work host already publishes or remove one it no longer does — withdrawn consent must not wait for an operator',
	},
	applyRootOnly: {
		reason:
			'an operator apply puts and deletes files on a public machine (E10): root only, as publication_hosts.reconcile_media_copy',
	},
	sources: [
		'src/diffusion/targets/mediastore/media_copy.ts',
		'src/diffusion/api/media_copy.ts',
		'src/diffusion/api/media_copy_reconcile.ts',
		'src/diffusion/api/reconcile.ts',
	],
	run: (options) => runMediaCopyReconcile(options),
};

/**
 * `web_image_exposure` (TODO-069): the rich-text web folder against the pub/
 * markers this facade's store owns — a name that parses to a PUBLISHED record
 * whose own text does not embed it is served anonymously for no reason. The
 * logic is core's (media/rich_text_image_reconcile.ts); the marker probe is
 * injected from here so core never imports the marker store.
 */
export const WEB_IMAGE_EXPOSURE_RECONCILE: ReconcileDefinition = {
	name: 'web_image_exposure',
	stores: ['image web folder file names', '.publication/pub markers + the keyed record text'],
	description:
		'List rich-text web-folder images whose name parses to a published record that does not embed them (a legacy upload whose name ends like a record key, a keyed image removed from its text): rule B serves them anonymously. Apply renames each out of the grammar (<name>.legacy.<ext>) and repoints every text that embeds it (Time Machine row); the old name is removed only once nothing resolves to it any more; files younger than a day are held — their text may not be saved yet.',
	scopeLabel: null,
	// A listing of one folder + a marker stat and one record read per parsing name: boot-cheap, report only.
	schedule: 'boot',
	applyRootOnly: {
		reason:
			'an apply makes published files private and rewrites texts across records: root only, like the other apply that changes what the public can read (media_copy)',
	},
	sources: ['src/diffusion/api/reconcile.ts', 'src/core/media/rich_text_image_reconcile.ts'],
	run: ({ apply }) => runWebImageExposure({ apply, isPublished: hasPubMarker }),
};
