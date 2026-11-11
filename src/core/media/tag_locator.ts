/**
 * TAG LOCATOR → MEDIA PATH — the ONE resolver behind every URL a text tag's
 * locator (`[svg-…-data:{section_tipo,section_id,component_tipo}:data]`, the
 * endpoint's `?id={…}`) points at (T0-10, WC-2026-11-11-svg-tag-url-full-media-path).
 *
 * Three consumers, one tail:
 *   - the tag endpoint (tag_endpoint.ts — 302 for the edit view);
 *   - the LIST read (component_text_area emit hook — served audience);
 *   - the PUBLISHED cell (diffusion parse_tag_to_html — publication audience).
 * They differ ONLY in the base they prepend (WC-042); the media-root-relative
 * tail is this function's, built by `buildMediaLocation` — the one producer of
 * the path grammar. A second, pure grammar twin is exactly what drifted before:
 * it knew neither `initial_media_path`, the `max_items_folder` bucket nor the
 * record's `additional_path` folder, and hard-coded component_svg.
 *
 * PHP component_svg::get_url_from_locator (:426-462) instantiates the locator's
 * OWN model (any media component, record-scoped) and calls its get_url() — so
 * the model comes from the ontology here too, and a non-media one is null.
 */

import { mediaTypeOf } from '../concepts/media.ts';
import { isValidTipo } from '../concepts/ontology.ts';
import { getModelByTipo } from '../ontology/resolver.ts';
import { resolveMediaPathOptions } from './ontology_path.ts';
import { buildMediaLocation } from './path.ts';

/** A tag-embedded locator as parsed from the tag text (values unvalidated). */
export interface TagLocator {
	section_tipo?: unknown;
	section_id?: unknown;
	component_tipo?: unknown;
	[extra: string]: unknown;
}

/** The validated identity of a tag locator (shape gate passed). */
export interface TagLocatorIdentity {
	readonly componentTipo: string;
	readonly sectionTipo: string;
	readonly sectionId: number;
}

/**
 * The §7.6 identifier gate: tipos well-formed, section_id a positive integer
 * (number or digits-only string). Null = not a locator any media file can
 * belong to.
 */
export function tagLocatorIdentity(locator: TagLocator): TagLocatorIdentity | null {
	const componentTipo = wellFormedTipo(locator.component_tipo);
	const sectionTipo = wellFormedTipo(locator.section_tipo);
	const sectionId = positiveSectionId(locator.section_id);
	if (componentTipo === null || sectionTipo === null || sectionId === null) return null;
	return { componentTipo, sectionTipo, sectionId };
}

/** A positive integer address spelled in decimal (leading zeros tolerated). */
const POSITIVE_SECTION_ID = /^0*[1-9][0-9]{0,14}$/;

/** The value as a tipo when it is a well-formed one (§7.6), else null. */
function wellFormedTipo(value: unknown): string | null {
	return typeof value === 'string' && isValidTipo(value) ? value : null;
}

/** A positive integer record address from a number or a digits-only string, else null. */
function positiveSectionId(value: unknown): number | null {
	if (typeof value !== 'number' && typeof value !== 'string') return null;
	// PHP spells the id as a string in the tag payload ('461'). Digits only, not
	// zero, at most 15 significant digits — always a safe integer.
	return POSITIVE_SECTION_ID.test(String(value)) ? Number(value) : null;
}

/**
 * The MEDIA-ROOT-RELATIVE path (leading slash) of the locator's default-quality
 * file — `folder + initial_media_path + '/' + quality + bucket + '/' + id.ext` —
 * or null when the locator is malformed or names a non-media model (PHP returns
 * null on both guards).
 *
 * THROWS what the path layer throws (`media.not_configured` without a media
 * root, a refused `additional_path` value, …): this function cannot know the
 * caller's failure posture — the endpoint answers a 404, a list/published
 * render degrades ONE mark to `src=""` and logs it.
 *
 * Record-scoped on purpose: `additional_path` is the value of a sibling
 * component on THIS record (one record read, only when the ontology declares
 * the property). PHP parity: the read is not principal-scoped — the folder is a
 * path segment, the file stays web-server-guarded (owner decision 2026-11-11).
 */
export async function resolveTagLocatorMediaPath(locator: TagLocator): Promise<string | null> {
	const identity = tagLocatorIdentity(locator);
	if (identity === null) return null;
	const model = await getModelByTipo(identity.componentTipo);
	const spec = model === null ? null : mediaTypeOf(model);
	if (spec === null) return null;
	const pathOptions = await resolveMediaPathOptions(
		identity.componentTipo,
		identity.sectionTipo,
		identity.sectionId,
	);
	return buildMediaLocation(
		spec,
		{
			componentTipo: identity.componentTipo,
			sectionTipo: identity.sectionTipo,
			sectionId: identity.sectionId,
			lang: null, // locator media (svg/image) are non-translatable (PHP DEDALO_DATA_NOLAN)
		},
		spec.defaultQuality,
		spec.defaultExtension,
		pathOptions,
	).relativePath;
}
