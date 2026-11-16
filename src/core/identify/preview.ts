/**
 * PREVIEW THUMBNAILS — the picture that goes next to a candidate.
 *
 * Identification is a VISUAL task. The per-criterion breakdown is what makes a
 * score readable, but a curator deciding whether two coins share a die looks at
 * the coins; a ranked list of titles and percentages asks them to take the
 * engine's word for it.
 *
 * WHY THE SERVER RESOLVES THIS. The client cannot: a candidate lives in whatever
 * section the profile covers, and nothing the tool holds says which of that
 * section's media components is "the" photograph. The profile does
 * (`previewComponent`) — it is already the curatorial statement of what this kind
 * of object IS — so the URL is built here, once, next to the record it belongs to.
 *
 * THREE RULES:
 *
 * 1. THE GRAMMAR IS BORROWED, NEVER REBUILT. `mediaThumbLocation` /
 *    `mediaThumbUrl` plus the ontology-driven `resolveMediaPathOptions` are the
 *    media subsystem's own path law (bucket folders, per-section initial path,
 *    the media-root confinement chokepoint). A hand-concatenated path would be a
 *    second, silently divergent copy of it.
 * 2. A URL IS ONLY RETURNED WHEN THE THUMB EXISTS ON DISK. `mediaThumbUrl` is
 *    pure by design and happily names a derivative nobody generated, which
 *    renders as a broken-image icon in every row. Absent thumb → no key in the
 *    map → the client paints a neutral placeholder.
 * 3. ACCESS IS THE CALLER'S ALREADY-DONE WORK, NOT A SECOND PATH. This module
 *    takes records the engine has ALREADY filtered (`match.ts` gates the seed and
 *    every candidate through the per-record scope gate before their values are
 *    read). It performs no read of record data and no ACL decision of its own —
 *    which is deliberate: a thumbnail resolver with its own weaker notion of
 *    "readable" is exactly how a media URL for a hidden record leaks.
 *
 * Reading the URL back is still gated by the web server's media rules (the
 * protection-cookie / publication-marker layer): the engine never serves media
 * bytes, so a thumb URL is a pointer, not an authorization.
 */

import { existsSync } from 'node:fs';
import { mediaTypeOf } from '../concepts/media.ts';
import { resolveMediaPathOptions } from '../media/ontology_path.ts';
import {
	type MediaIdentity,
	type MediaPathOptions,
	mediaThumbLocation,
	mediaThumbUrl,
} from '../media/path.ts';
import { getModelByTipo, getTranslatableByTipo } from '../ontology/resolver.ts';
import { currentDataLang } from '../resolve/request_lang.ts';

/** A record to illustrate (the shape both the seed and a candidate arrive in). */
export interface PreviewRecord {
	sectionTipo: string;
	sectionId: number;
}

/**
 * The ontology + filesystem facts this module needs, as a seam.
 *
 * Production passes {@link defaultPreviewSourcePort}. Tests inject a fake so the
 * two behaviours that matter — "no previewComponent yields nothing and does not
 * crash" and "an ungenerated thumb yields null, not a URL" — are provable without
 * a database, a media root, or a real image.
 */
export interface PreviewSourcePort {
	/** The component's model name, or null when the tipo is unknown. */
	getModel(componentTipo: string): Promise<string | null>;
	/** Whether the media component stores one file per language. */
	getTranslatable(componentTipo: string): Promise<boolean>;
	/**
	 * The path options for this component on THIS record — record-scoped, because
	 * an `additional_path` bucket and an image's `image_id` file stem are a
	 * sibling's value on the record (T1-10).
	 */
	getPathOptions(
		componentTipo: string,
		sectionTipo: string,
		sectionId: number,
	): Promise<MediaPathOptions>;
	/** Whether a derivative is actually on disk (rule 2). */
	fileExists(absolutePath: string): boolean;
}

export function defaultPreviewSourcePort(): PreviewSourcePort {
	return {
		getModel: getModelByTipo,
		getTranslatable: getTranslatableByTipo,
		getPathOptions: (componentTipo, sectionTipo, sectionId) =>
			resolveMediaPathOptions(componentTipo, sectionTipo, sectionId),
		fileExists: existsSync,
	};
}

/** The map key: one record's identity, in the shape the API answer keys on. */
export function previewKey(record: PreviewRecord): string {
	return `${record.sectionTipo}_${record.sectionId}`;
}

/**
 * Thumb URLs for the records that have one, keyed by {@link previewKey}.
 *
 * A record with no generated thumb — or a profile with no `previewComponent` at
 * all — is simply ABSENT from the map. There is no "" or null entry to
 * misinterpret downstream, and no error: a corpus half-way through its
 * photography is the normal state of a collection, not a failure of this call.
 *
 * @param previewComponent the profile's declared media component, or null
 * @param records the records to illustrate — ALREADY ACL-filtered by the caller
 */
export async function resolvePreviewThumbs(
	previewComponent: string | null,
	records: readonly PreviewRecord[],
	port: PreviewSourcePort = defaultPreviewSourcePort(),
): Promise<Map<string, string>> {
	const thumbs = new Map<string, string>();
	if (previewComponent === null || previewComponent === '' || records.length === 0) {
		return thumbs;
	}

	const model = await port.getModel(previewComponent);
	if (model === null) return thumbs;
	const spec = mediaTypeOf(model);
	// Not a media component, or a media type with no thumb tier (svg). The
	// profile loader refuses both at parse time; this is the runtime half, and it
	// must not throw — a bad descriptor already travelled loudly through the
	// loader, and re-raising it here would turn the whole answer into a decline.
	if (spec === null || !spec.hasThumb) return thumbs;

	// A translatable media component stores one file per language, so the
	// identifier carries a lang suffix. The data lang is the honest choice for a
	// PICTURE the curator is looking at right now — the same rule the media tools
	// apply (media/tool_support.ts). Non-translatable components take null.
	const lang = (await port.getTranslatable(previewComponent)) ? currentDataLang() : null;

	for (const record of records) {
		try {
			// PER RECORD, not per section: the options carry this record's own
			// bucket and file stem. The ontology half is cached by the resolver.
			const options = await port.getPathOptions(
				previewComponent,
				record.sectionTipo,
				record.sectionId,
			);
			const identity: MediaIdentity = {
				componentTipo: previewComponent,
				sectionTipo: record.sectionTipo,
				sectionId: record.sectionId,
				lang,
			};
			const location = mediaThumbLocation(spec, identity, options);
			if (location === null || !port.fileExists(location.absolutePath)) continue;
			const url = mediaThumbUrl(spec, identity, options);
			if (url !== null) thumbs.set(previewKey(record), url);
		} catch (error) {
			// One unusable record (a malformed identity, a path the confinement gate
			// refuses) must not cost the whole list its pictures — and must not cost
			// the caller its ANSWER, which is the breakdown, not the thumbnail.
			console.warn(
				`[identify_preview] no thumb for ${record.sectionTipo}/${record.sectionId}: ${String(error)}`,
			);
		}
	}

	return thumbs;
}
