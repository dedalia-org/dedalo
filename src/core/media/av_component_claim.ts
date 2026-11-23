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
 * (component_lock.ts). Released in a `finally`. The work runs UNDER the claim
 * (`mediaJobs.runUnderClaim`): its publication steps re-check, immediately
 * before they act, that the claim's lock is still ours on disk — an operation
 * whose hold another instance reclaimed while it awaited publishes nothing.
 *
 * NOT for code already running under the component's hold: the ingest (its
 * upload claim) and the transcode job call the same thumb/posterframe cores —
 * wrapping those cores would refuse the holder itself. That is why the hold is
 * taken at the OPERATION's entry, never inside the shared cores.
 */

import type { MediaTypeSpec } from '../concepts/media.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getModelByTipo } from '../ontology/resolver.ts';
import { declaredSectionComponents } from '../section/record/declared_components.ts';
import { type JobTarget, type JobTargetClaim, jobTargetKey, mediaJobs } from './jobs.ts';
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
		return await mediaJobs.runUnderClaim(claim, work);
	} finally {
		claim.release();
	}
}

/** The claim's tier word for a record-wide hold (a delete or a restore sweep). */
const RECORD_HOLD_TIER = 'record_media';

/**
 * A RECORD-WIDE av hold (A1-01 review M3, F4): the WHOLE av components — every
 * lang, the untranslatable slot and any lang a build may start later — that a
 * record delete, a data wipe or a Time Machine restore moves files of. Taken as
 * whole-component claims (`mediaJobs.claimWholeComponents`, scope
 * `'component_all'`): while held, no build or upload of ANY lang of those
 * components can start, on this instance or another, and the hold itself
 * refused while any lang was held. So the delete/restore cannot move files a
 * build is writing, including a build in a lang the record did not name yet.
 *
 * `takeComponents` adds components all-or-none (true when held — already or
 * now — false when another holder has any lang of one). `require` is the
 * movers' per-identity question: a component not held yet is taken or refused;
 * one already held is RE-CHECKED on disk (review F3), so a hold another
 * instance reclaimed while the sweep awaited refuses the next move. `release`
 * gives everything back (idempotent; after it nothing is taken).
 */
export class AvRecordHold {
	private readonly claims = new Map<string, JobTargetClaim>();
	private released = false;

	constructor(
		readonly sectionTipo: string,
		readonly sectionId: number,
	) {}

	takeComponents(componentTipos: readonly string[]): boolean {
		if (this.released) return false;
		const missing = [...new Set(componentTipos)].filter((tipo) => !this.claims.has(tipo));
		if (missing.length === 0) return true;
		const claims = mediaJobs.claimWholeComponents(
			this.sectionTipo,
			this.sectionId,
			missing,
			RECORD_HOLD_TIER,
		);
		if (claims === null) return false;
		for (const claim of claims) this.claims.set(claim.target.component_tipo, claim);
		return true;
	}

	/**
	 * Hold `componentTipo` (every lang) or throw `media.build_running` — and, when
	 * it is already held, re-check that its lock is still ours on disk (throws the
	 * same code when it was reclaimed). Nothing else is released.
	 */
	require(componentTipo: string): void {
		const held = this.claims.get(componentTipo);
		if (held !== undefined) {
			mediaJobs.assertClaimHolds(held.id);
			return;
		}
		if (this.takeComponents([componentTipo])) return;
		throw recordHoldRefusal(this.sectionTipo, this.sectionId, [componentTipo]);
	}

	release(): void {
		this.released = true;
		for (const claim of this.claims.values()) claim.release();
		this.claims.clear();
	}
}

/** The record hold's refusal (409 `media.build_running`). */
function recordHoldRefusal(
	sectionTipo: string,
	sectionId: number,
	componentTipos: readonly string[],
): DedaloError {
	const target = `${sectionTipo}|${sectionId}|${componentTipos.join(',')}`;
	return new DedaloError('media.build_running', {
		message: `record media refused: a build or another operation holds an av component of ${target}`,
		coordinates: { target },
	});
}

/**
 * HOLD every av component of a record — whole, every lang — or refuse with
 * `media.build_running` BEFORE the caller writes anything (a delete, a wipe, an
 * undelete). The components: the av components the section DECLARES (an upload
 * in progress has written no media key yet) plus any av key the media column
 * holds. All or none: on a refusal nothing stays held. The caller releases the
 * hold in a `finally` AFTER its file sweep, passing it to the mover
 * (`SectionMediaFilesOptions.avHold`).
 */
export async function holdRecordAvComponents(
	sectionTipo: string,
	sectionId: number,
	mediaColumn: unknown,
): Promise<AvRecordHold> {
	const components = await recordAvComponents(sectionTipo, mediaColumn);
	const hold = new AvRecordHold(sectionTipo, sectionId);
	if (!hold.takeComponents(components)) {
		throw recordHoldRefusal(sectionTipo, sectionId, components);
	}
	return hold;
}

/** The av component tipos of a record: declared by its section, or keyed in its media column. */
async function recordAvComponents(sectionTipo: string, mediaColumn: unknown): Promise<string[]> {
	const tipos = new Set<string>();
	for (const component of await declaredSectionComponents(sectionTipo)) {
		if (component.model === 'component_av') tipos.add(component.tipo);
	}
	for (const tipo of await mediaColumnAvTipos(mediaColumn, tipos)) tipos.add(tipo);
	return [...tipos];
}

/** The av tipos a media column keys that `known` does not already hold (a section that no longer declares them). */
async function mediaColumnAvTipos(
	mediaColumn: unknown,
	known: ReadonlySet<string>,
): Promise<string[]> {
	if (mediaColumn === null || typeof mediaColumn !== 'object') return [];
	const found: string[] = [];
	for (const tipo of Object.keys(mediaColumn)) {
		if (!known.has(tipo) && (await getModelByTipo(tipo)) === 'component_av') found.push(tipo);
	}
	return found;
}
