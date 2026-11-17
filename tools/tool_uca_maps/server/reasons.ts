/**
 * The refusals the browser explains in the user's language: `details.reason_key`
 * → the tool's `reason_<key>` label, else this English sentence (the loader
 * puts it on the wire; engineering/ERRORS_SPEC.md §9.1). A key exists only for
 * what a user typed, chose or uploaded: a payload the tool's own client builds
 * is refused with the bare code, since no sentence would help the user fix it.
 */

import { DedaloError } from '../../../src/core/errors/index.ts';

export const REASON_KEYS = {
	search_text_required: 'Type something to search.',
	search_text_too_short: 'The search text is too short.',
	search_text_too_long: 'The search text is too long.',
	search_text_invalid: 'The search text holds characters that cannot be searched.',
	no_dataset_selected: 'Select at least one dataset to search.',
	wms_url_required: 'The WMS server URL is required.',
	wms_url_invalid: 'Please enter a valid URL.',
	wms_server_unreachable: 'The server could not be reached: check the URL.',
	file_name_unusable: 'The file name has no usable characters.',
	image_not_on_server: 'The image is no longer on the server.',
	image_not_displayable: 'The uploaded image has no version this browser can display.',
	image_cmyk: 'This image is stored in CMYK, which cannot be downloaded from the map.',
	upload_extension_unsupported: 'Only zip (shapefile), GeoJSON and KML files can be uploaded.',
	upload_too_large: 'The file is larger than 10 MB.',
	converted_layer_too_large: 'The converted layer is too large: upload a smaller file.',
	geojson_not_strict: 'This GeoJSON is not strict JSON: save it as strict JSON.',
	geojson_crs_link:
		'This GeoJSON\'s crs is a link, which is never followed: name its projection instead (for example "EPSG:25830").',
	zip_unreadable: 'The zip archive is corrupt or is not a zip archive.',
	zip_split: 'A zip archive split into several files is not supported.',
	zip64: 'A ZIP64 archive is not supported: zip the shapefile without ZIP64.',
	zip_too_many_files: 'The zip archive holds more than 1000 files.',
	zip_encrypted: 'An encrypted zip archive is not supported.',
	zip_method_unsupported: 'The zip archive uses a compression method other than store or deflate.',
	zip_too_large: 'The zip archive inflates to more than 200 MB: upload a smaller shapefile.',
	projection_epsg_missing: 'Zone and band describe an EPSG code: fill in the EPSG too.',
	projection_zone_band_pair: 'Zone and band go together: fill in both, or neither.',
	epsg_invalid: 'The EPSG code must be 4 to 6 digits.',
	epsg_unknown: 'The EPSG code is not known.',
	utm_zone_invalid: 'The UTM zone must be a number from 1 to 60.',
	utm_band_invalid: 'The UTM band must be one letter, C to X.',
	epsg_not_utm: 'This EPSG code is not a UTM projection: leave zone and band empty.',
	epsg_needs_zone_band: 'This EPSG code is a UTM projection: fill in its zone and band too.',
	epsg_zone_band_mismatch:
		"The zone and band given do not match this EPSG code's UTM zone and hemisphere.",
	projection_already_declared:
		'This file already declares its own projection: leave EPSG, zone and band empty.',
	projection_not_this_file:
		"With this EPSG code the coordinates are not longitude/latitude: it is not this file's projection.",
	projection_declared_wrong:
		"The coordinates do not fit the projection this file declares: correct the file's projection.",
	no_coordinate_system:
		'This file has no coordinate system of its own (no .prj or crs member): provide its EPSG code (and, for a UTM one, its zone and band).',
	projection_required:
		'This file does not declare its projection and its coordinates are not longitude/latitude: provide its EPSG code (and, for a UTM one, its zone and band).',
	wms_server_unavailable: 'The WMS server did not answer with its capabilities.',
	linked_image_unavailable: 'The server of the linked image did not hand it over.',
	gazetteer_service_unavailable: 'The gazetteer service did not answer properly.',
	catastro_unavailable: 'The Catastro service did not answer properly.',
	catastro_canary_islands:
		'Cadastral parcels in the Canary Islands cannot be looked up from the map yet.',
	admin_units_unavailable: 'The administrative units service did not answer properly.',
	place_search_unavailable: 'The place search service did not answer properly.',
} as const satisfies Readonly<Record<string, string>>;

export type ReasonKey = keyof typeof REASON_KEYS;

/** A caller fault; keyed only when the user can act on it. The log keeps the
 * specifics the key's fixed sentence cannot carry. */
export function invalidOptions(message: string, reason?: ReasonKey, cause?: unknown): DedaloError {
	return new DedaloError('request.invalid_options', {
		message,
		details: reason === undefined ? undefined : { reason_key: reason },
		cause,
	});
}

/** A size ceiling, not a bad option. */
export function tooLarge(message: string, reason: ReasonKey): DedaloError {
	return new DedaloError('media.too_large', { message, details: { reason_key: reason } });
}

/** The third party is down or answered nothing usable: the source failing, never
 * `request.invalid_options`, which would tell the user their input was wrong and
 * leave an outage unclassified in the log. Retryable, and every caller is a
 * readOnly action, so the resend shows it. */
export function sourceUnavailable(message: string, reason: ReasonKey): DedaloError {
	return new DedaloError('tool.source_unavailable', {
		message,
		details: { reason_key: reason },
	});
}
