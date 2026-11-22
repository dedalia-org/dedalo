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
		return await work();
	} finally {
		claim.release();
	}
}

/** The claim's tier word for a record-wide hold (a delete or a restore sweep). */
const RECORD_HOLD_TIER = 'record_media';

/** One (component, lang) slot's key inside a record hold. */
function slotKey(componentTipo: string, lang: string | null): string {
	return `${componentTipo}|${lang ?? ''}`;
}

/**
 * The claim lang of a slot: `lg-nolan` (a v6-era item's "no language") IS the
 * untranslatable slot every av build of the component claims as null — kept
 * apart, a build on null would not refuse a sweep of the `lg-nolan` item.
 */
function slotLang(lang: string | null): string | null {
	return lang === 'lg-nolan' ? null : lang;
}

/**
 * A RECORD-WIDE av hold (A1-01 review M3): the component claims a record delete,
 * a data wipe or a Time Machine restore holds over every av component it moves
 * files of — so the delete/restore cannot move files a build is writing, and no
 * build or upload can start on the record while it moves them.
 *
 * `take` adds one (component, lang) slot (true when held — already or now —
 * false when another holder has it); the file movers call it per identity they
 * are about to touch, so a lang the caller did not foresee is held, or refused,
 * there. `release` gives every slot back (idempotent; after it `take` refuses).
 */
export class AvRecordHold {
	private readonly claims = new Map<string, JobTargetClaim>();
	private released = false;

	constructor(
		readonly sectionTipo: string,
		readonly sectionId: number,
	) {}

	take(componentTipo: string, itemLang: string | null): boolean {
		if (this.released) return false;
		const lang = slotLang(itemLang);
		const key = slotKey(componentTipo, lang);
		if (this.claims.has(key)) return true;
		const claim = mediaJobs.claimTarget(
			avComponentTarget(
				{ sectionTipo: this.sectionTipo, sectionId: this.sectionId, componentTipo, lang },
				RECORD_HOLD_TIER,
			),
		);
		if (claim === null) return false;
		this.claims.set(key, claim);
		return true;
	}

	/** Take a slot or throw `media.build_running` (nothing else is released). */
	require(componentTipo: string, lang: string | null): void {
		if (this.take(componentTipo, lang)) return;
		const target = avComponentTarget(
			{
				sectionTipo: this.sectionTipo,
				sectionId: this.sectionId,
				componentTipo,
				lang: slotLang(lang),
			},
			RECORD_HOLD_TIER,
		);
		throw new DedaloError('media.build_running', {
			message: `record media refused: a build or another operation holds ${jobTargetKey(target)}`,
			coordinates: { target: jobTargetKey(target) },
		});
	}

	release(): void {
		this.released = true;
		for (const claim of this.claims.values()) claim.release();
		this.claims.clear();
	}
}

/** The langs of a media column value's items (null for an item without one). */
function itemLangs(items: unknown): (string | null)[] {
	if (!Array.isArray(items)) return [];
	return items.map((item) => {
		const lang = (item as { lang?: unknown } | null)?.lang;
		return typeof lang === 'string' && lang !== '' ? lang : null;
	});
}

/**
 * HOLD every av component of a record, or refuse with `media.build_running` —
 * BEFORE the caller writes anything (a delete, a wipe, an undelete). The
 * components: the av components the section DECLARES (an upload in progress has
 * written no media key yet) plus any av key the media column holds. The langs
 * per component: the
 * untranslatable slot, every lang its items name, and every lang a live holder
 * holds right now (`liveComponentLangs` — this instance and the lock files).
 * On a refusal every slot already taken is given back. The caller releases the
 * hold in a `finally` AFTER its file sweep, passing it to the mover
 * (`SectionMediaFilesOptions.avHold`).
 */
export async function holdRecordAvComponents(
	sectionTipo: string,
	sectionId: number,
	mediaColumn: unknown,
): Promise<AvRecordHold> {
	const components = await recordAvComponents(sectionTipo, mediaColumn);
	const media = (mediaColumn ?? {}) as Record<string, unknown>;
	const hold = new AvRecordHold(sectionTipo, sectionId);
	try {
		for (const componentTipo of components) {
			const langs = new Set<string | null>([
				null,
				...itemLangs(media[componentTipo]),
				...mediaJobs.liveComponentLangs(sectionTipo, sectionId, componentTipo),
			]);
			for (const lang of langs) hold.require(componentTipo, lang);
		}
	} catch (error) {
		hold.release();
		throw error;
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
