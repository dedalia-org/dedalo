/**
 * ONE AV OPERATION PER COMPONENT — the hold every av write OUTSIDE the job
 * manager takes (A1-01, owner ruling 4).
 *
 * The av build family (upload claim, ingest transcode, per-quality builds) is
 * component-scoped in the job arbiter. The other operations that write av tier
 * files run synchronously in their request — conform_headers (remux in place),
 * delete_quality / delete_version (move tiers to deleted/, then re-index), the
 * Regenerate pass and the update-cache sweep (mint the posterframe + thumb),
 * the thumb build, the posterframe create/delete. Each of them now holds the
 * SAME component claim for the whole write (and its files_info write-back), so
 * none can run while a build or an upload owns the component, and no build or
 * upload can start while one runs. The claim is the arbiter's own
 * (`mediaJobs.claimTarget`): in memory AND the cross-process lock file
 * (component_lock.ts). Released in a `finally`.
 *
 * NOT for code already running under the component's hold: the ingest (its
 * upload claim) and the transcode job call the same thumb/posterframe cores —
 * wrapping those cores would refuse the holder itself. That is why the hold is
 * taken at the OPERATION's entry, never inside the shared cores.
 */

import type { MediaTypeSpec } from '../concepts/media.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { type JobTarget, jobTargetKey, mediaJobs } from './jobs.ts';
import type { MediaIdentity } from './path.ts';

/**
 * The component-scoped target an av operation on `quality` occupies: its own
 * tier AND the whole component (`scope: 'component'`).
 */
export function avComponentTarget(identity: MediaIdentity, quality: string): JobTarget {
	return {
		section_tipo: identity.sectionTipo,
		section_id: identity.sectionId,
		component_tipo: identity.componentTipo,
		lang: identity.lang ?? null,
		quality,
		label: quality,
		scope: 'component',
	};
}

/**
 * Run `work` holding the av component — or refuse with `media.build_running`
 * when a build, an upload or another operation holds it. Any other model runs
 * `work` directly: the rule is av's (v6 component_av build lock).
 *
 * `tier` names what the operation writes (a quality, 'posterframe', …): it is
 * the claim's tier key and the log's word, never the scope — the scope is the
 * component.
 */
export async function withAvComponentClaim<T>(
	spec: MediaTypeSpec,
	identity: MediaIdentity,
	tier: string,
	work: () => Promise<T>,
): Promise<T> {
	if (spec.model !== 'component_av') return await work();
	const target = avComponentTarget(identity, tier);
	const claim = mediaJobs.claimTarget(target);
	if (claim === null) {
		throw new DedaloError('media.build_running', {
			message: `av '${tier}' refused: a build or another operation holds ${jobTargetKey(target)}`,
			coordinates: { target: jobTargetKey(target) },
		});
	}
	try {
		return await work();
	} finally {
		claim.release();
	}
}
