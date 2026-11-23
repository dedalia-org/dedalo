/**
 * ACTIVITY — the ONE read model that answers "what work of mine is running?".
 *
 * There are TWO job systems in this engine, and they are legitimately different
 * rather than accidental duplicates:
 *
 *  - `mediaJobs` (core/media/jobs.ts) — the general IN-PROCESS registry. AV
 *    transcodes, every tool background action routed through
 *    core/tools/background.ts (imports, indexation), the backup widget, the
 *    unit-test runner. Ephemeral: a restart loses them, and the boot sweep flips
 *    the orphans to 'interrupted'.
 *  - the DIFFUSION queue (src/diffusion/jobs/) — a durable Postgres queue whose
 *    jobs run in SEPARATE spawned runner processes with heartbeats and a
 *    re-queueing sweeper. Publication lives here.
 *
 * A tray that read only the first would show a video transcode and SILENTLY OMIT
 * a running publication — the longest process in the system. Omission reads as
 * "nothing is happening", which is the exact bug this whole path exists to kill,
 * so the aggregation is the point of this module, not a convenience.
 *
 * WHAT THIS MODULE MUST NOT DO: unify the two wires. Diffusion's `ProgressData`
 * is pinned byte-for-byte against the old engine, with golden fixtures carrying
 * an independent copy of its constants (test/parity/fixtures/diffusion/pinned.ts)
 * and 16384-char SSE padding for proxy flushing; `JobStatusFrame` is the media
 * poll shape. Both stay exactly as they are. This is a READ-SIDE PROJECTION: it
 * writes nothing, owns no state, and every row names the stream its own system
 * already serves so the client subscribes THERE for live updates.
 *
 * HOW THE DIFFUSION HALF GETS HERE — the INVERSION, not an import. `src/core/**`
 * may not import `src/diffusion` (the boundary tripwire allows three named
 * seams, and an aggregator is not one of them). So this module owns a PROVIDER
 * REGISTRY and startServer's diffusion boot chain registers into it, exactly as
 * `core/api/counters.ts` does for the diffusion gauge. Core states the shape it
 * wants; the subsystem supplies it. An install with diffusion disabled simply
 * has no provider registered and the tray shows media work only — which is the
 * truth on that install, not a degradation.
 */

import { type JobRecord, type JobStatus, mediaJobs } from '../media/jobs.ts';

/** Which system a row came from — and therefore which SSE carries its updates. */
export type ActivitySource = 'media' | 'diffusion';

/** The tray-facing status vocabulary (the union of what both systems can be in). */
export type ActivityStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'cancelled';

/** One row of the activity read model. */
export interface ActivityRow {
	source: ActivitySource;
	/** Opaque, per-source id — deliberately NOT unified into one id space. */
	job_id: string;
	label: string;
	record: {
		section_tipo: string;
		/**
		 * INT — the canonical form — or NULL when the work targets a whole SECTION
		 * rather than one record, which is what a publication does. Deliberately
		 * not a `number | string` union: that spelling is exactly the drift
		 * WC-2026-08-10-section-id-int-canonical is burning down, and '' would be a
		 * string standing in for "not applicable" anyway. The client renders a
		 * record link only when this is a real id.
		 */
		section_id: number | null;
		component_tipo?: string;
		/**
		 * The job target's LANG — null for an untranslatable component (media rows
		 * only; additive). The server keys an av component's hold by lang
		 * (section|id|component|lang), so the panel of another lang is free: the
		 * client compares it with its own lang (tool_media_versions).
		 */
		lang?: string | null;
	} | null;
	status: ActivityStatus;
	/**
	 * OTHER tiers this same job also produces (JobTarget.also_qualities).
	 *
	 * The panel needs it or it contradicts the server: the ingest transcode
	 * writes the default tier AND the audio tier, so the guard refuses a build of
	 * EITHER — but a panel keyed only on `label` would show the audio column idle
	 * and offer a gear whose click is guaranteed to be refused. Offering an
	 * action that cannot succeed is the same class of lie as hiding one that is
	 * running.
	 */
	also_qualities?: string[];
	/**
	 * `'component'` when the job holds its WHOLE component (JobTarget.scope —
	 * the av build family, A1-01), else null. One av build per component: while
	 * such a job is live the server refuses a build of EVERY tier of that
	 * component (media.build_running), so the media-versions panel greys every
	 * tier's gear, not just the building one — the panel agreeing with the guard.
	 */
	scope?: 'component' | null;
	/**
	 * WHO started it — set only on the record-scoped listing, and only when the
	 * job is NOT the reader's own. An operator whose build button is disabled
	 * needs to know it is someone else's transcode holding the tier; without a
	 * name the disabled gear reads as a broken panel.
	 */
	owner_name?: string | null;
	/** 0..100, or null when no percentage is knowable (never a fabricated number). */
	progress: number | null;
	/** Wall-clock ms since epoch, so elapsed survives a page reload. */
	started_at: number | null;
	/**
	 * Why it failed. Present on terminal rows so the tray can state a reason
	 * instead of showing a red row the operator has to go elsewhere to explain.
	 */
	errors?: string[];
	/** Which SSE the client subscribes to for this row's live frames. */
	stream: 'job_events' | 'diffusion';
}

/**
 * Media job status → tray status. 'stopped' is an operator cancellation, which
 * the tray calls 'cancelled' to match diffusion's word for the same act.
 */
const MEDIA_STATUS: Record<JobStatus, ActivityStatus> = {
	queued: 'queued',
	running: 'running',
	done: 'done',
	error: 'error',
	interrupted: 'interrupted',
	stopped: 'cancelled',
};

/**
 * Diffusion state → tray status. EXHAUSTIVE BY CONSTRUCTION: keyed by
 * `DiffusionJobState`, so adding a state to the CHECK constraint in
 * src/diffusion/jobs/schema.ts fails the typecheck here rather than silently
 * defaulting a failed publication to 'running' in the tray. The gate in
 * test/unit/activity_aggregate_native.test.ts asserts the same totality at
 * runtime, because the DB constraint and this table are edited in different
 * files by different hands.
 */
export const DIFFUSION_STATUS: Record<
	'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted',
	ActivityStatus
> = {
	queued: 'queued',
	running: 'running',
	completed: 'done',
	failed: 'error',
	cancelled: 'cancelled',
	interrupted: 'interrupted',
};

/** The row fields a media job's TARGET decides (null/empty for a record-less job). */
function targetFieldsOf(
	target: JobRecord['target'],
): Pick<ActivityRow, 'record' | 'also_qualities' | 'scope'> {
	if (target === undefined) return { record: null, also_qualities: [], scope: null };
	return {
		record: {
			section_tipo: target.section_tipo,
			section_id: target.section_id,
			component_tipo: target.component_tipo,
			lang: target.lang ?? null,
		},
		also_qualities: target.also_qualities ?? [],
		// A job is never whole-component (`'component_all'` is a claim only — jobs.ts).
		scope: target.scope === 'component' ? 'component' : null,
	};
}

/** Project one media job record into a tray row. */
export function activityRowFromMediaJob(record: JobRecord): ActivityRow {
	const target = record.target;
	return {
		source: 'media',
		job_id: record.id,
		// The tier is the useful name ("404"); the kind is the fallback for the
		// record-less jobs (backup, unit tests) that legitimately carry no target.
		label: target?.label ?? target?.quality ?? record.kind,
		...targetFieldsOf(target),
		errors: record.errors,
		status: MEDIA_STATUS[record.status],
		progress: record.progress,
		started_at: record.startedAtWall ?? null,
		stream: 'job_events',
	};
}

/** Whether a tray row still represents work in flight. */
export function isLiveActivity(status: ActivityStatus): boolean {
	return status === 'queued' || status === 'running';
}

/**
 * How long a FINISHED job stays in the activity answer.
 *
 * The window is the fix for a defect the first version shipped: with a
 * live-ONLY answer, a job that ended simply stopped appearing, and the client
 * had to INTERPRET that absence. It guessed "done" — so a failed or cancelled
 * publication was painted green and faded away, and a single dropped request
 * marked every running publication successful. Absence is not an outcome.
 *
 * With this window the server states the outcome, and absence means only "older
 * than the window" — which is safe to drop silently, because the client has by
 * then already been told what happened.
 *
 * Five minutes: long enough to survive a page reload and a distracted operator,
 * short enough that the answer never becomes a history feed (the 30-day pfile
 * retention is NOT an activity horizon — an earlier version leaked exactly that
 * and opened the tray on weeks-old news).
 */
export const RECENT_TERMINAL_MS = 5 * 60 * 1000;

/** Live, or finished inside the recency window. */
function isRecentActivity(record: JobRecord, since: number): boolean {
	if (isLiveActivity(MEDIA_STATUS[record.status])) return true;
	return (record.finishedAtWall ?? 0) >= since;
}

/**
 * Stamp `owner_name` on the rows started by SOMEONE ELSE.
 *
 * Only foreign owners: "processing — yourself" is noise, and the name exists to
 * answer the one question a disabled build button raises ("who is holding this
 * tier?"). One lookup per distinct owner, so a record with six jobs from the
 * same colleague costs one read.
 *
 * `records` and `rows` are index-aligned — `rows` is `records.map(project)`.
 */
export async function stampForeignOwnerNames(
	records: readonly JobRecord[],
	rows: ActivityRow[],
	readerUserId: number,
): Promise<void> {
	const owners = records.map((record) => foreignOwnerOf(record, readerUserId));
	const names = await resolveOwnerNames(owners);
	for (const [index, owner] of owners.entries()) {
		const row = rows[index];
		if (owner === null || row === undefined) continue;
		row.owner_name = names.get(owner) ?? null;
	}
}

/** The job's owner when it is SOMEONE ELSE's, else null. */
function foreignOwnerOf(record: JobRecord, readerUserId: number): number | null {
	const owner = record.user_id ?? null;
	return owner === null || owner === readerUserId ? null : owner;
}

/** One name lookup per DISTINCT foreign owner. */
async function resolveOwnerNames(
	owners: readonly (number | null)[],
): Promise<Map<number, string | null>> {
	const names = new Map<number, string | null>();
	const distinct = new Set(owners.filter((owner): owner is number => owner !== null));
	if (distinct.size === 0) return names;
	const { currentApplicationLang } = await import('../resolve/request_lang.ts');
	const { resolveUserName } = await import('../security/user_identity.ts');
	const lang = currentApplicationLang();
	for (const owner of distinct) {
		names.set(owner, await resolveUserName(owner, lang));
	}
	return names;
}

/**
 * A subsystem's contribution to the tray: the caller's own LIVE rows.
 *
 * Registered at BOOT by the subsystem that owns the work — the same inversion
 * `registerOpsGauge` uses (core/api/counters.ts), and for the same reason: core
 * may not import src/diffusion, so diffusion pushes rather than core pulling.
 *
 * A provider must return only live rows. `collectActivity` does NOT re-filter
 * them: media jobs are filtered at their own source, and a provider that
 * returned terminal rows would put the "weeks-old history as news" defect back
 * through the side door.
 */
export type ActivityProvider = (userId: number) => Promise<ActivityRow[]> | ActivityRow[];

const activityProviders = new Map<string, ActivityProvider>();

/** Register a subsystem's activity provider (idempotent per name). */
export function registerActivityProvider(name: string, provider: ActivityProvider): void {
	activityProviders.set(name, provider);
}

/**
 * The caller's own activity, across both systems — LIVE WORK ONLY.
 *
 * The live-only filter is load-bearing, and was measured rather than assumed: a
 * first version returned everything `jobsForUser` knows, which includes the
 * pfile mirror going back the full 30-day retention. Probed against a real
 * server it answered with a stack of long-finished `done`/`cancelled` rows, so
 * the tray would have opened announcing weeks-old history as though it were news
 * — the mirror image of the invisibility bug this whole change exists to fix.
 *
 * It also makes the two halves symmetric: `listActiveJobsForOwner` already
 * returns only `queued`/`running`, and an aggregate whose two sources disagree
 * about what "activity" means is a bug waiting to be read as data.
 *
 * A job that FINISHES while the tray is watching still renders its outcome: the
 * client keeps the row it is already following and lingers it (job_tray.js).
 * That is the right place for it — the browser knows what it showed you; the
 * server only knows what is true now.
 *
 * A diffusion read failure must NOT take the tray down: media rows are still
 * true and useful, so the diffusion half degrades to empty and says so on the
 * server log. The inverse would be equally wrong, and both are cheap to hold —
 * an aggregator that fails whole because one of its two sources hiccupped is a
 * worse answer than a partial one that admits it.
 */
export async function collectActivity(userId: number): Promise<ActivityRow[]> {
	const since = Date.now() - RECENT_TERMINAL_MS;
	const rows: ActivityRow[] = mediaJobs
		.jobsForUser(userId)
		.filter((record) => isRecentActivity(record, since))
		.map(activityRowFromMediaJob);
	for (const [name, provider] of activityProviders) {
		try {
			rows.push(...(await provider(userId)));
		} catch (error) {
			console.error(
				`[activity] the '${name}' provider failed; the other rows are still served: ${(error as Error).message}`,
			);
		}
	}
	// Newest first. Every row here is live by construction (see the doc-block), so
	// there is no live-vs-finished ordering left to express.
	return rows.sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
}
