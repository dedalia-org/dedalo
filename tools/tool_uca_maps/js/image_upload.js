// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, DEDALO_MEDIA_URL, DEDALO_CORE_URL, SHOW_DEVELOPER */
/*eslint no-undef: "error"*/

/**
 * IMAGE_UPLOAD
 * The image half of "Upload file to map"; vector_upload.js builds the shared
 * button and panel. Three engine doors: `create` an Images record, the
 * `tool_upload` ingest, and `get_image_overlay`, which places the image with the
 * server's GDAL instead of v6's two browser GeoTIFF libraries.
 */

import { request_failed, response_data } from '../../../core/common/js/api_error.js';
import { data_manager } from '../../../core/common/js/data_manager.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { object_to_url_vars } from '../../../core/common/js/utils/util.js';
import { upload } from '../../../core/services/service_upload/js/service_upload.js';
import { process_uploaded_file } from '../../tool_upload/js/tool_upload.js';
import { report_client_error } from './client_error.js';
import { deliver_download } from './download_delivery.js';
import {
	DEFAULT_IMAGE_DOWNLOAD_NAME,
	name_required_text,
	sanitize_download_name,
} from './download_filename.js';
import {
	attach_carrier_drag,
	attach_handles,
	detach_carrier_drag,
	detach_handles,
	fit_carrier_to_corners,
	hull_bounds,
	is_image_editing,
	seal_carrier_from_geoman,
} from './image_edit.js';
import { commit, ensure_properties, ensure_uca_maps } from './object_console.js';
import { exception_text, upload_refusal_text } from './panel_error_text.js';
import { CONVERSION_TIMEOUT_MS } from './request_budgets.js';
import { rotated_image_overlay } from './rotated_image_overlay.js';
import { carrier_image } from './uca_maps_data.js';
import { IMAGE_UPLOAD_EXTENSIONS } from './upload_formats.js';

/** v6's own two (`render_tool_leaflet_special_tools.js`: the Resources image
 * section and component). Seed-shipped ontology in every install, not an
 * installation TLD. Exported so object_image.js uses the same pair. */
export const IMAGE_SECTION_TIPO = 'rsc170';
export const IMAGE_COMPONENT_TIPO = 'rsc29';

/** Refused in the BROWSER, before the bytes leave. Not a policy the server
 * relies on (it has its own limits) — it is what stops a mistakenly picked
 * multi-GB raster from uploading for ten minutes to be rejected at the end. */
const IMAGE_UPLOAD_MAX_BYTES = 100_000_000;
const IMAGE_UPLOAD_KEY_DIR = 'image';

/** v6's own default (`special_tools_upload.js`: imageOpacity 1, image_zIndex
 * 200) — kept so a map built in v6 and one built here stack the same way. */
const DEFAULT_IMAGE_OPACITY = 1;
const DEFAULT_IMAGE_Z_INDEX = 200;
/** v6's slider range (`special_tools.js`), and the console's. */
const MAX_IMAGE_Z_INDEX = 1000;

/**
 * IMAGE_Z_INDEX
 * The stacking value actually used, bounded to the slider's 0..1000 on read
 * AND on write: a value saved by the old number box (1500, -5) would
 * otherwise sit where the slider cannot show it, and the first nudge would
 * silently rewrite it.
 *
 * @param {*} value
 * @returns {number}
 */
const image_z_index = function (value) {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.min(MAX_IMAGE_Z_INDEX, Math.max(0, Math.trunc(value)))
		: DEFAULT_IMAGE_Z_INDEX;
}; //end image_z_index

/**
 * IMAGE_URL
 * The one place a stored image descriptor becomes a URL. `file_path` is
 * media-root-relative (as `files_info` stores it) and the record identity is kept,
 * not v6's absolute URL, so a moved install still resolves. Exported for object_image.js.
 *
 * @param {Object} image - properties.uca_maps.image descriptor
 * @returns {string}
 */
export const image_url = function (image) {
	return DEDALO_MEDIA_URL + image.file_path;
}; //end image_url

/** How much of the viewport's SHORTER side a coordinate-less image is given.
 * Not v6's 1.0 — see `corners_from_viewport`. */
const PLAIN_IMAGE_VIEWPORT_FRACTION = 0.5;

/**
 * NATURAL_SIZE
 * The image's pixel size, read by the browser, which fetches it anyway: asking
 * `gdalinfo` would leave a GDAL-less install unable to place a plain .jpg. Falls
 * back to a square: a wrong aspect ratio is visible and fixable, failing the
 * upload would discard a file already on the server.
 *
 * @param {string} url
 * @returns {Promise<{width: number, height: number}>}
 */
const natural_size = function (url) {
	return new Promise((resolve) => {
		const probe = new Image();
		probe.onload = () =>
			resolve({
				width: probe.naturalWidth || 1,
				height: probe.naturalHeight || 1,
			});
		probe.onerror = () => resolve({ width: 1, height: 1 });
		probe.src = url;
	});
}; //end natural_size

/**
 * CORNERS_FROM_VIEWPORT
 * Starting position for a NON-georeferenced image, which the user then moves.
 * Two departures from v6: the image keeps its aspect ratio, computed in container
 * pixels (v6 stretched it onto the viewport rectangle), and takes half the shorter
 * side, not the whole viewport, so the map stays visible to judge it against.
 *
 * @param {Object} map - the Leaflet map
 * @param {Object} size - the image's natural {width, height} in pixels
 * @returns {Object} {top_left, top_right, bottom_left} as [lat, lon] pairs
 */
// exported for the client gate
export const corners_from_viewport = function (map, size) {
	const viewport = map.getSize();
	const box = Math.min(viewport.x, viewport.y) * PLAIN_IMAGE_VIEWPORT_FRACTION;
	const width = size && size.width > 0 ? size.width : 1;
	const height = size && size.height > 0 ? size.height : 1;

	// fit INSIDE the box, never crop or stretch to it
	const scale = Math.min(box / width, box / height);
	const draw_w = width * scale;
	const draw_h = height * scale;

	const left = (viewport.x - draw_w) / 2;
	const top = (viewport.y - draw_h) / 2;

	const to_corner = (x, y) => {
		const latlng = map.containerPointToLatLng(L.point(x, y));
		return [latlng.lat, latlng.lng];
	};

	return {
		top_left: to_corner(left, top),
		top_right: to_corner(left + draw_w, top),
		bottom_left: to_corner(left, top + draw_h),
	};
}; //end corners_from_viewport

/**
 * CREATE_IMAGE_RECORD
 * Door 1: a fresh record in the Images section to host the file, with the rqo
 * the core itself uses to mint a record from the client (`component_text_area.js`).
 *
 * @returns {Promise<number|null>} the new section_id, or null on failure
 */
const create_image_record = async function () {
	const api_response = await data_manager.request({
		body: {
			action: 'create',
			source: {
				section_tipo: IMAGE_SECTION_TIPO,
			},
		},
	});

	const section_id = response_data(api_response);

	return typeof section_id === 'number' && section_id > 0 ? section_id : null;
}; //end create_image_record

/** Ingest refusals raised BEFORE the staged file moves, which a resend would raise
 * again. Any other code is an unknown outcome (an idempotency.* replay, a db.*
 * failure after the move, media.file_not_found on a re-run whose staged file was
 * consumed). Necessary, not sufficient: `holds_no_image_file` confirms it. */
const PRE_MOVE_REFUSALS = new Set([
	'request.invalid',
	'request.invalid_options',
	'request.invalid_model',
	'request.invalid_source',
	'tool.invalid_name',
	'tool.no_server_module',
	'tool.method_not_allowed',
	'tool.not_authorized',
	'perm.denied',
	'perm.out_of_scope',
	'media.upload_rejected',
]);

/**
 * HOLDS_NO_IMAGE_FILE
 * Whether the minted record has no file of its image component on disk, asked to
 * the server's own lookup. The code list above is a belief about where core
 * raises each refusal; this checks the fact, so a refusal core one day raises
 * after the move cannot get a record holding the file deleted. A failed check keeps it.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {number} section_id
 * @returns {Promise<boolean>}
 */
const holds_no_image_file = async function (self, section_id) {
	const file_response = await self.tool_request({
		action: 'get_image_file',
		retries: 1,
		options: {
			tipo: IMAGE_COMPONENT_TIPO,
			section_tipo: IMAGE_SECTION_TIPO,
			section_id: section_id,
		},
	});

	return (
		request_failed(file_response) &&
		Boolean(file_response.error) &&
		file_response.error.code === 'resource.not_found'
	);
}; //end holds_no_image_file

/**
 * DELETE_IMAGE_RECORD
 * Undoes CREATE_IMAGE_RECORD through core's public delete door (the same rqo
 * `view_note_text_area.js` sends): Time Machine snapshot first, and the user's
 * own permissions and project scope decide, never the tool.
 *
 * @param {number} section_id
 * @returns {Promise<boolean>} true only when the server confirms the deletion
 */
const delete_image_record = async function (section_id) {
	const api_response = await data_manager.request({
		body: {
			action: 'delete',
			source: {
				delete_mode: 'delete_record',
				section_tipo: IMAGE_SECTION_TIPO,
				section_id: section_id,
			},
		},
	});

	const deleted = response_data(api_response);

	return Array.isArray(deleted) && deleted.includes(section_id);
}; //end delete_image_record

/**
 * INGEST_UPLOADED_FILE
 * Door 2: hands the staged upload to `tool_upload::process_uploaded_file`
 * through tool_upload's own helper (as tool_image_rotation does), which sends
 * it once with a long deadline: the ingest builds every derivative tier
 * synchronously. The helper wants a caller whose model is tool_upload.
 *
 * @param {number} section_id - the new rsc170 record
 * @param {Object} file_data - what service_upload's transport returned
 * @returns {Promise<Object>} the raw api_response
 */
const ingest_uploaded_file = async function (section_id, file_data) {
	return await process_uploaded_file({
		file_data: file_data,
		process_options: null,
		caller: {
			type: 'tool',
			model: 'tool_upload',
		},
		tipo: IMAGE_COMPONENT_TIPO,
		section_tipo: IMAGE_SECTION_TIPO,
		section_id: section_id,
		caller_type: 'component',
		quality: null,
		target_dir: null,
	});
}; //end ingest_uploaded_file

/**
 * IMAGE_FAILED_TEXT / TRANSPORT_FAILED_TEXT
 * The image half's two fallback texts, one copy each for every door below.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {string}
 */
const image_failed_text = function (self) {
	return self.get_tool_label('upload_image_error_failed') || 'The image could not be loaded.';
}; //end image_failed_text

const transport_failed_text = function (self) {
	return self.get_tool_label('upload_error_transport') || 'The file could not be uploaded.';
}; //end transport_failed_text

/**
 * INGEST_IMAGE_UPLOAD
 * Doors 1 + 2 (stage, mint, ingest) with nothing about the map in them: the
 * overlay upload and an object's associated images share exactly this much. One
 * copy, so the bytes-before-record order below holds for every image ingested.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {File} file
 * @returns {Promise<{ok: boolean, section_id?: number, error?: string}>}
 */
export const ingest_image_upload = async function (self, file) {
	// The bytes are staged BEFORE the record is minted: v6 does the reverse
	// and leaves an empty rsc170 record behind every refused upload. Once
	// the ingest has run, a record holding the image is a catalogue
	// resource and stays, whatever the map does with it afterwards.
	const upload_response = await upload({
		id: self.id,
		file: file,
		key_dir: IMAGE_UPLOAD_KEY_DIR,
		allowed_extensions: IMAGE_UPLOAD_EXTENSIONS,
		max_size_bytes: IMAGE_UPLOAD_MAX_BYTES,
		tipo: IMAGE_COMPONENT_TIPO,
	});

	const failed = image_failed_text(self);

	if (!response_data(upload_response)) {
		const message =
			upload_response && upload_response.error
				? upload_refusal_text(upload_response.error, failed)
				: transport_failed_text(self);
		return { ok: false, error: message };
	}

	return await ingest_staged_image(self, upload_response.file_data);
}; //end ingest_image_upload

/**
 * INGEST_STAGED_IMAGE
 * Door 2 alone: mint the record and ingest a file ALREADY staged, by the upload
 * above or by the server from a linked URL (`stage_external_image`), so both keep
 * the empty-record cleanup. `staged_untouched` marks a failure that certainly left
 * the staged file in place, so a caller that staged it may release it.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} file_data - the staged file's descriptor
 * @returns {Promise<{ok: boolean, section_id?: number, error?: string, refusal?: Object, staged_untouched?: boolean}>}
 */
export const ingest_staged_image = async function (self, file_data) {
	const section_id = await create_image_record();
	if (section_id === null) {
		return {
			ok: false,
			error:
				self.get_tool_label('upload_image_error_record') ||
				'A record to hold the image could not be created.',
			staged_untouched: true,
		};
	}

	const ingest_response = await ingest_uploaded_file(section_id, file_data);
	if (request_failed(ingest_response)) {
		// core's page notice says why the ingest was refused; the panel adds
		// only what that notice cannot know: a record that may be left over.
		// An error envelope alone does not prove nothing was written: only a
		// refusal raised before the file moved does. Any other answer leaves the
		// record named, never deleted (the server may still be filling it)
		const pre_move = PRE_MOVE_REFUSALS.has(ingest_response.error.code);
		const removed =
			pre_move &&
			(await holds_no_image_file(self, section_id)) &&
			(await delete_image_record(section_id));
		return {
			ok: false,
			refusal: ingest_response.error,
			...(removed
				? {}
				: {
						error:
							self.get_tool_label('upload_image_record_left', section_id) ||
							`Image record ${section_id} may have been left empty: review it.`,
					}),
			staged_untouched: pre_move,
		};
	}

	return { ok: true, section_id: section_id };
}; //end ingest_staged_image

/**
 * UPLOAD_IMAGE_FILE
 * The whole flow, exported taking a plain `file` (not a DOM event) so tests
 * can await it directly — same testability convention as
 * `vector_upload.js`'s `upload_vector_file`.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {File} file - the browser File object chosen by the user
 * @returns {Promise<{ok: boolean, error?: string, georeferenced?: boolean}>}
 */
export const upload_image_file = async function (self, file) {
	if (self._image_upload_busy) {
		return { ok: false };
	}
	if (!file) {
		return {
			ok: false,
			error: self.get_tool_label('upload_no_file') || 'Please choose a file first.',
		};
	}

	self._image_upload_busy = true;

	try {
		const ingested = await ingest_image_upload(self, file);
		if (!ingested.ok) {
			return ingested;
		}
		const section_id = ingested.section_id;

		const overlay_response = await self.tool_request({
			action: 'get_image_overlay',
			retries: 1,
			timeout: CONVERSION_TIMEOUT_MS,
			busy_notice: true,
			options: {
				tipo: IMAGE_COMPONENT_TIPO,
				section_tipo: IMAGE_SECTION_TIPO,
				section_id: section_id,
			},
		});

		// the tool may have been torn down while all of the above was in flight:
		// a late response is discarded
		if (!self.upload_panel || !self.geolocation || !self.geolocation.map) {
			return { ok: false };
		}

		// a refusal: core's page notice says why, once and translated
		if (request_failed(overlay_response)) {
			return { ok: false };
		}

		const data = response_data(overlay_response);
		if (!data || !data.file_path) {
			// NOT the "record could not be created" message: by this point the
			// record exists and the file is ingested — what failed is that the
			// answer named no displayable file
			return {
				ok: false,
				error:
					self.get_tool_label('upload_image_error_no_display') ||
					'The uploaded image has no version this browser can display.',
			};
		}

		// a coordinate-less image needs its own pixel dimensions to be placed
		// without distortion, and only the browser has them for free
		const corners = data.georeferenced
			? data.corners
			: corners_from_viewport(
					self.geolocation.map,
					await natural_size(image_url({ file_path: data.file_path })),
				);

		// natural_size awaits a network fetch — re-check the teardown
		if (!self.upload_panel || !self.geolocation || !self.geolocation.map) {
			return { ok: false };
		}

		const image = {
			file_path: data.file_path,
			quality: data.quality,
			section_tipo: IMAGE_SECTION_TIPO,
			section_id: section_id,
			tipo: IMAGE_COMPONENT_TIPO,
			corners: corners,
			opacity: DEFAULT_IMAGE_OPACITY,
			z_index: DEFAULT_IMAGE_Z_INDEX,
		};

		await create_image_object(self, image);

		return {
			ok: true,
			georeferenced: data.georeferenced === true,
			georeference_unavailable: data.georeference_unavailable === true,
		};
	} catch (error) {
		console.error('tool_uca_maps: upload_image_file failed unexpectedly', error);
		report_client_error((error && error.message) || 'Image upload failed');
		return { ok: false, error: transport_failed_text(self) };
	} finally {
		self._image_upload_busy = false;
	}
}; //end upload_image_file

/**
 * CREATE_IMAGE_OBJECT
 * Builds the carrier rectangle and its overlay, and fires the rectangle through
 * `pm:create` so it is saved like any drawn object (an overlay is no feature).
 * The carrier is the corners' axis-aligned hull, a selection handle; `corners`
 * keeps the real footprint, so a skewed raster is not squared off.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} image - the descriptor to store under properties.uca_maps.image
 * @returns {Object} the carrier layer
 */
export const create_image_object = function (self, image) {
	const map = self.geolocation.map;

	const carrier = L.rectangle(hull_bounds(image.corners), {
		opacity: 0,
		fillOpacity: 0,
		color: 'transparent',
	});
	carrier.feature = carrier.toGeoJSON();

	ensure_properties(carrier).color = 'transparent';
	const uca_maps = ensure_uca_maps(carrier);
	uca_maps.image = image;
	// A NEW image arrives EDITABLE, as in v6: a plain image lands at an arbitrary
	// spot, so the next gesture is moving it. Defaulted here, the one builder only
	// a new object passes through, so a stored `false` is never overwritten.
	if (typeof image.interactive !== 'boolean') {
		image.interactive = true;
	}
	// object_viewer.js splits its vector and raster lists on this flag; without it
	// every uploaded image would show as an "Untitled object" vector
	uca_maps.is_raster = true;

	attach_overlay(self, carrier);

	map.fire('pm:create', { layer: carrier });
	// padded: an image zoomed edge-to-edge leaves no map to judge its placement by
	map.fitBounds(hull_bounds(image.corners), { padding: [40, 40] });

	return carrier;
}; //end create_image_object

/**
 * ATTACH_OVERLAY
 * Creates one carrier's image overlay, tracked by the layer (for the console and
 * `pm:remove`) and by the tool (for the teardown sweep). SYNCHRONOUS on purpose:
 * `hydrate_image_overlays` runs un-serialized on every `updated_layer_data_`, and
 * with no await between the check and the assignment a second rebuild finds the
 * carrier taken.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} carrier - the transparent rectangle carrying the descriptor
 * @returns {Object|null} the overlay, or null if it could not be built
 */
const attach_overlay = function (self, carrier) {
	const image = carrier_image(carrier);

	if (!image || !image.corners || carrier._uca_maps_overlay) {
		return null;
	}

	// the ONE funnel both an upload and a reload pass through, so it is where
	// the carrier stops being an editable polygon for Geoman and starts
	// carrying the picture with it when dragged (image_edit.js)
	seal_carrier_from_geoman(carrier);
	attach_carrier_drag(self, carrier);
	// the corners are what draws the picture; a stored carrier that disagrees with
	// them (saved before it followed its handles) is put back over it
	fit_carrier_to_corners(carrier, image.corners);

	if (!self.geolocation || !self.geolocation.map) {
		return null;
	}

	const overlay = rotated_image_overlay(
		image_url(image),
		image.corners.top_left,
		image.corners.top_right,
		image.corners.bottom_left,
		{
			opacity: typeof image.opacity === 'number' ? image.opacity : DEFAULT_IMAGE_OPACITY,
			zIndex: image_z_index(image.z_index),
			// the CARRIER takes the clicks: the class's `pointer-events:none`
			// (tool_uca_maps.less) stops the picture covering its own selection handle
			className: 'uca-maps-image-overlay',
		},
	);

	overlay.addTo(self.geolocation.map);

	carrier._uca_maps_overlay = overlay;
	// tracked as a PAIR, not as a bare overlay: the sweep in
	// hydrate_image_overlays needs to know which carrier each one belongs to
	self._image_overlays = self._image_overlays || [];
	self._image_overlays.push({ carrier, overlay });

	// edit mode is stored, so an overlay rebuilt from saved data comes back
	// with the handles the user left showing (image_edit.js)
	if (is_image_editing(carrier)) {
		attach_handles(self, carrier);
	}

	if (SHOW_DEVELOPER === true) {
		console.log('-> tool_uca_maps image overlay added:', image);
	}

	return overlay;
}; //end attach_overlay

/**
 * DETACH_OVERLAY
 * The reverse, for one carrier the user deletes (pm:remove); the teardown sweep
 * uses release_overlay directly. Removing the carrier alone would leave the
 * image painted on a map with nothing to select it by.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} carrier
 * @returns {void}
 */
const detach_overlay = function (self, carrier) {
	const overlay = carrier && carrier._uca_maps_overlay;

	// the handles come off even when there is no overlay left to move: they
	// are markers on the map, and nothing else in the engine tracks them
	release_overlay(self, self.geolocation && self.geolocation.map, { carrier, overlay });

	if (overlay && Array.isArray(self._image_overlays)) {
		self._image_overlays = self._image_overlays.filter((el) => el.overlay !== overlay);
	}
}; //end detach_overlay

/**
 * SET_IMAGE_DISPLAY
 * Opacity/z-index for the console: writes the live overlay (what the user sees)
 * and the stored descriptor (what the save keeps). `do_commit` is false while a
 * slider is DRAGGED: commit() re-renders the panel, which would replace the
 * <input type=range> under the pointer.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} carrier
 * @param {Object} values - {opacity?: number, z_index?: number}
 * @param {boolean} do_commit - mark the record dirty and re-render
 * @returns {void}
 */
export const set_image_display = function (self, carrier, values, do_commit) {
	const image = carrier.feature.properties.uca_maps.image;
	const overlay = carrier._uca_maps_overlay;

	if (typeof values.opacity === 'number' && Number.isFinite(values.opacity)) {
		image.opacity = Math.min(1, Math.max(0, values.opacity));
		if (overlay) {
			overlay.setOpacity(image.opacity);
		}
	}

	if (typeof values.z_index === 'number' && Number.isFinite(values.z_index)) {
		image.z_index = image_z_index(values.z_index);
		if (overlay) {
			overlay.setZIndex(image.z_index);
		}
	}

	if (do_commit === true) {
		commit(self, carrier);
	}
}; //end set_image_display

/**
 * GET_IMAGE_HREF
 * The "Ver imagen" target: the Images RECORD the upload created, in edit mode,
 * as v6 does (`special_tools.js`) — not the bare derivative, which skips
 * the record where the picture is catalogued. Same URL shape as the core's
 * `edit_relation` (render_relation_list.js), but `menu=true`, v6's choice.
 *
 * @param {Object} carrier
 * @returns {string|null}
 */
export const get_image_href = function (carrier) {
	const image = carrier_image(carrier);

	if (!image || !image.section_tipo || !(image.section_id > 0)) {
		return null;
	}

	return (
		DEDALO_CORE_URL +
		'/page/?' +
		object_to_url_vars({
			tipo: image.section_tipo,
			id: image.section_id,
			mode: 'edit',
			menu: true,
			// the new tab must not overwrite this window's section navigation
			session_save: false,
		})
	);
}; //end get_image_href

/**
 * IMAGE_DOWNLOAD_WIDTH
 * v6's "quality", kept: a factor over the width the image takes on screen with
 * the map fitted to it (v6 `fitBounds`, then `getBoundingClientRect()` x
 * scale). Computed at the zoom a fit WOULD pick, so the user's map never moves.
 *
 * @param {Object} map - the Leaflet map
 * @param {Object} corners - {top_left, top_right, bottom_left}
 * @param {number} quality - v6's factor, 0.4 … 2
 * @returns {number} output width in pixels, at least 1
 */
// exported for the client gate
export const image_download_width = function (map, corners, quality) {
	const zoom = map.getBoundsZoom(hull_bounds(corners));
	const top_left = map.project(L.latLng(corners.top_left), zoom);
	const top_right = map.project(L.latLng(corners.top_right), zoom);
	const bottom_left = map.project(L.latLng(corners.bottom_left), zoom);
	const bottom_right = top_right.add(bottom_left).subtract(top_left);

	const xs = [top_left.x, top_right.x, bottom_left.x, bottom_right.x];

	return Math.max(1, Math.round((Math.max(...xs) - Math.min(...xs)) * quality));
}; //end image_download_width

// A large PNG at "Excelente" takes seconds per GDAL run (four, each bounded at
// 60 s, server/gdal.ts), past data_manager's 5 s per attempt; the fifth minute
// leaves room for the answer to travel back.
// exported for the client gate
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * DOWNLOAD_IMAGE
 * "Descargar Imagen": the picture in its CURRENT shape (live corners, saved or
 * not), rendered by the server from the file the map shows (`image_download.ts`).
 * Opacity is not sent: it is how the map shows the image, not the image. An empty
 * name is refused as v6 refuses it.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object} carrier
 * @param {string} format - 'geotiff' | 'png' | 'jpg'
 * @param {number} quality - v6's factor
 * @param {string} [file_name]
 * @returns {Promise<{ok: boolean, error?: string}>} `error`: an empty name, a
 *   server refusal or a client-side throw, for the section's line
 */
export const download_image = async function (
	self,
	carrier,
	format,
	quality,
	file_name = DEFAULT_IMAGE_DOWNLOAD_NAME,
) {
	const image = carrier_image(carrier);
	if (!image || !self.geolocation || !self.geolocation.map) {
		return { ok: false };
	}

	const base_name = sanitize_download_name(file_name);
	if (base_name === '') {
		return { ok: false, error: name_required_text(self) };
	}

	const failed =
		self.get_tool_label('image_download_error_failed') || 'The image could not be downloaded.';

	try {
		const response = await self.tool_request({
			action: 'image_download',
			options: {
				tipo: image.tipo,
				section_tipo: image.section_tipo,
				section_id: image.section_id,
				file_path: image.file_path,
				corners: image.corners,
				format: format,
				width: image_download_width(self.geolocation.map, image.corners, quality),
				file_name: base_name,
			},
			retries: 1,
			timeout: IMAGE_DOWNLOAD_TIMEOUT_MS,
			// a timeout this long turns the page's slow-server cue off by default
			busy_notice: true,
		});

		return await deliver_download(response, failed);
	} catch (error) {
		console.error('tool_uca_maps: download_image failed unexpectedly', error);
		report_client_error((error && error.message) || 'Image download failed');
		return { ok: false, error: exception_text(error, failed) };
	}
}; //end download_image

/**
 * HYDRATE_IMAGE_OVERLAYS
 * Rebuilds every stored overlay across the FeatureGroups. Walks them here
 * rather than riding `object_console.js`'s own `reapply_all` pass: that would
 * make the two modules import each other.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {number} how many overlays were rebuilt
 */
const hydrate_image_overlays = function (self) {
	const feature_groups = self.geolocation && self.geolocation.FeatureGroup;
	if (!feature_groups) {
		return 0;
	}

	const carriers = [];
	for (const layer_id in feature_groups) {
		feature_groups[layer_id].eachLayer((layer) => {
			if (carrier_image(layer)) {
				carriers.push(layer);
			}
		});
	}

	// SWEEP FIRST: `layers_loader` replaces a FeatureGroup's carriers on a reload
	// without firing 'pm:remove', and an overlay is no drawn object, so the old
	// ones would stay painted and the rebuild below would stack a second copy.
	const live = new Set(carriers);
	for (const entry of self._image_overlays || []) {
		if (!live.has(entry.carrier)) {
			// the replaced carrier's handles are as orphaned as its overlay
			release_overlay(self, self.geolocation && self.geolocation.map, entry);
		}
	}
	self._image_overlays = (self._image_overlays || []).filter((entry) => live.has(entry.carrier));

	let rebuilt = 0;
	for (const carrier of carriers) {
		const overlay = attach_overlay(self, carrier);
		if (overlay) {
			rebuilt++;
		}
	}

	return rebuilt;
}; //end hydrate_image_overlays

/**
 * ATTACH_IMAGE_OVERLAYS
 * The image half's lifecycle hook (no toolbar entry: vector_upload.js owns the
 * button). `updated_layer_data_<id_base>` is when a carrier can appear,
 * `pm:remove` when one goes and its image must go with it. Idempotent.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
export const attach_image_overlays = function (self) {
	if (self._image_overlay_remove_handler || !self.geolocation || !self.geolocation.map) {
		return;
	}

	self._image_overlays = self._image_overlays || [];

	self._image_overlay_remove_handler = (event) => {
		if (event.layer) {
			detach_overlay(self, event.layer);
		}
	};
	self.geolocation.map.on('pm:remove', self._image_overlay_remove_handler);

	// runs from an event handler and an attach step: a throw (a stored descriptor
	// Leaflet cannot place) would surface nowhere a user looks, so it is reported
	const rebuild = () => {
		try {
			hydrate_image_overlays(self);
		} catch (error) {
			console.error('tool_uca_maps: image overlays could not be rebuilt', error);
			report_client_error((error && error.message) || 'Image overlays could not be rebuilt');
		}
	};

	self._image_overlay_token = event_manager.subscribe(
		'updated_layer_data_' + self.geolocation.id_base,
		rebuild,
	);

	rebuild();
}; //end attach_image_overlays

/**
 * DETACH_IMAGE_OVERLAYS
 * Every overlay this tool put on the map comes off with it: an overlay is no
 * drawn object, so nothing else in the engine would remove it.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
export const detach_image_overlays = function (self) {
	const map = self.geolocation && self.geolocation.map;

	if (self._image_overlay_remove_handler) {
		if (map) {
			map.off('pm:remove', self._image_overlay_remove_handler);
		}
		self._image_overlay_remove_handler = null;
	}

	if (self._image_overlay_token) {
		event_manager.unsubscribe(self._image_overlay_token);
		self._image_overlay_token = null;
	}

	for (const entry of self._image_overlays || []) {
		release_overlay(self, map, entry);
	}
	self._image_overlays = [];
}; //end detach_image_overlays

/**
 * RELEASE_OVERLAY
 * Takes one {carrier, overlay} pair off the map, handles and drag included;
 * the overlay may be missing. The caller owns `self._image_overlays`.
 *
 * @param {Object} self - tool_uca_maps instance
 * @param {Object|null} map - the live map, or null when it is already gone
 * @param {{carrier: Object, overlay: ?Object}} entry
 * @returns {void}
 */
const release_overlay = function (self, map, entry) {
	if (map && entry.overlay) {
		map.removeLayer(entry.overlay);
	}
	detach_handles(self, entry.carrier);
	detach_carrier_drag(entry.carrier);
	if (entry.carrier) {
		// biome-ignore lint/performance/noDelete: our own slot on a Leaflet layer: removed, not left behind on an object Leaflet owns
		delete entry.carrier._uca_maps_overlay;
	}
}; //end release_overlay

// @license-end
