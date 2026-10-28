/**
 * Media component `features` context (PHP component_<media>_json.php default
 * branch, e.g. component_image_json.php:80-95). Media components expose an
 * upload/quality descriptor the client reads to render the edit view (the
 * quality picker + upload validation). Without it the client crashes reading
 * `context.features.quality` — so any media section's edit form fails to render.
 *
 * Every value comes from the config catalog (config.media.*, the PHP
 * DEDALO_<MEDIA>_* keys, .env-overridable) — never hardcoded here. A previous
 * hardcoded copy of the sample defaults drifted from the install's real
 * DEDALO_IMAGE_EXTENSIONS_SUPPORTED / _ALTERNATIVE_EXTENSIONS overrides.
 */

import { config, type MediaTypeConfig } from '../../config/config.ts';

/** model → its config.media entry (PHP component_<model> ↔ media type). */
const MEDIA_MODEL_CONFIG: Readonly<Record<string, MediaTypeConfig>> = {
	component_image: config.media.image,
	component_pdf: config.media.pdf,
	component_av: config.media.av,
	component_svg: config.media.svg,
	component_3d: config.media.threeD,
};

/** True when the model carries a media `features` descriptor. */
export function hasMediaFeatures(model: string): boolean {
	return model in MEDIA_MODEL_CONFIG;
}

/** The client-facing media `features` object (PHP context->features). */
export interface MediaFeatures {
	allowed_extensions: string[];
	default_target_quality: string;
	ar_quality: string[];
	default_quality: string;
	quality: string;
	key_dir: string;
	alternative_extensions: string[] | null;
	extension: string;
}

/**
 * Build a media component's `features` context (PHP component_<media>_json.php).
 * `quality` is the current instance quality, which for a freshly-built context
 * is the default working quality (PHP get_quality() defaults to it).
 */
export function buildMediaFeatures(
	model: string,
	tipo: string,
	sectionTipo: string,
): MediaFeatures | null {
	const spec = MEDIA_MODEL_CONFIG[model];
	if (spec === undefined) return null;
	// The media-store shard label is the folder name (DEDALO_<M>_FOLDER, '/image' → 'image').
	const mediaType = spec.folder.replace(/^\//, '');
	return {
		allowed_extensions: [...spec.allowedExtensions],
		default_target_quality: spec.originalQuality,
		ar_quality: [...spec.qualities],
		default_quality: spec.defaultQuality,
		quality: spec.defaultQuality,
		// key_dir shards the media store. Only component_image uses the composite
		// 'image_<tipo>_<section_tipo>' (component_image_json.php:92); av/pdf/svg/3d
		// use the FIXED media-type folder label ('av'/'pdf'/'svg'/'3d') — e.g.
		// component_av_json.php:123. Applying the composite everywhere pointed AV/PDF
		// media at a non-existent shard directory.
		key_dir: model === 'component_image' ? `${mediaType}_${tipo}_${sectionTipo}` : mediaType,
		// PHP get_alternative_extensions returns the configured list (empty [] is a
		// valid value; null only on legacy installs where the constant is undefined
		// — the v7 catalog always defines it, so the wire carries the array).
		alternative_extensions: [...spec.alternateExtensions],
		extension: spec.extension,
	};
}

/**
 * The upload `features` descriptor of any model that has one: the media models'
 * (buildMediaFeatures) and component_json's — tool_upload replaces a JSON value with an
 * uploaded .json file and reads features.allowed_extensions to build its picker (PHP
 * component_json_json.php :90-98; without it the tool crashed on open). null otherwise.
 */
export function buildUploadFeatures(
	model: string,
	tipo: string,
	sectionTipo: string,
): MediaFeatures | { allowed_extensions: string[]; default_target_quality: null } | null {
	if (model === 'component_json')
		return { allowed_extensions: ['json'], default_target_quality: null };
	return buildMediaFeatures(model, tipo, sectionTipo);
}
