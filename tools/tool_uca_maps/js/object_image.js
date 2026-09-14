// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DEDALO_MEDIA_URL*/
/*eslint no-undef: "error"*/



/**
* OBJECT_IMAGE
* Fila #3 del audit ("Consola de objeto"), la parte que faltaba: **asociar una
* imagen a un objeto vectorial y consultar su galería**
* (`special_tools.js:4528-4741`, `modal_associate_image`).
*
* NOT THE SAME THING as the image overlay of fila #11, which the audit itself
* warns is easy to confuse ("Riesgo de confusión en nomenclatura"):
*   - an IMAGE OVERLAY is a picture placed ON the map at its own coordinates,
*     carried by a transparent rectangle (`image_upload.js`);
*   - an ASSOCIATED IMAGE is a picture that belongs TO a drawn geometry — a
*     photograph of the wall that polygon outlines. It is never drawn on the
*     map, and the geometry keeps its own shape and style.
* Both travel through the same ingest (`ingest_image_upload`), because both
* are real Dédalo media; only what happens afterwards differs.
*
* WHAT PERSISTS, and why it is not what v6 persists. v6 stores an ABSOLUTE URL
* per image (`self.tool.base_url() + data.image_src`), so every association in
* an install breaks the day the host, the protocol or the media root changes.
* Here the stored descriptor is the record IDENTITY plus the media-root-
* relative `file_path` — the same decision hito 13 already took for overlays,
* for the same reason, and the same `DEDALO_MEDIA_URL + file_path` resolution.
*
* WHY THE GALLERY COSTS NO REQUESTS. `file_path` is resolved ONCE, when the
* image is associated, and stored. Rendering thirty thumbnails is then thirty
* `<img src>` the web server answers directly — no action call per image, and
* no application process anywhere in the media path
* (engineering/MEDIA_PROTECTION.md hard rule 1).
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {error_text} from '../../../core/common/js/render_api_error.js'
import {commit, ensure_properties, report_client_error} from './object_console.js'
import {ingest_image_upload} from './image_upload.js'



/** v6's own cap for the same feature (`create_pdf`: "Imágenes asociadas (Max. 30)").
 * Kept as a real limit, not just a PDF one: a console panel with hundreds of
 * thumbnails in it is not a gallery, and the geometry's properties are saved
 * inline with the record. */
export const MAX_OBJECT_IMAGES = 30

const IMAGE_SECTION_TIPO	= 'rsc170'
const IMAGE_COMPONENT_TIPO	= 'rsc29'



/**
* OBJECT_IMAGES
* The images associated with a layer, always an array (never null), read-only
* for callers that just want to render them.
*
* @param {Object} layer
* @returns {Array<Object>}
*/
export const object_images = function(layer) {

	const images = layer
		&& layer.feature
		&& layer.feature.properties
		&& layer.feature.properties.uca_maps
		&& layer.feature.properties.uca_maps.images

	return Array.isArray(images) ? images : []
}//end object_images



/**
* OBJECT_IMAGE_URL
* The one place a stored descriptor becomes a URL — same resolution as
* `image_upload.js`'s own `image_url`, deliberately duplicated as a one-liner
* rather than imported, because importing it would be importing the overlay
* module's private helper across a boundary the two sides do not otherwise
* share.
*
* @param {Object} image - a stored descriptor
* @returns {string|null}
*/
export const object_image_url = function(image) {

	return (image && typeof image.file_path==='string')
		? DEDALO_MEDIA_URL + image.file_path
		: null
}//end object_image_url



/**
* ASSOCIATE_IMAGE
* Uploads a picture and hangs it off the selected geometry.
*
* The record is minted and ingested by the shared pipeline; the only question
* left is where the ingested image is SERVED from, which `get_image_file`
* answers (`server/image_media.ts`). That path is stored, so the gallery never
* asks again.
*
* Marks the record dirty through `commit` — the tool's single dirty/save
* funnel — and nothing more: associating an image is a user GESTURE, so it
* dirties; it does not save. That is the same law the elevation line obeys by
* not writing at all ("nada auto-guarda", CLAUDE.local.md).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - the geometry the image belongs to
* @param {File} file
* @returns {Promise<{ok: boolean, error?: string}>}
*/
export const associate_image = async function(self, layer, file) {

	if (self._object_image_busy) {
		return {ok: false}
	}
	if (!file) {
		return {ok: false, error: self.get_tool_label('upload_no_file') || 'Please choose a file first.'}
	}
	if (object_images(layer).length >= MAX_OBJECT_IMAGES) {
		return {
			ok		: false,
			error	: self.get_tool_label('object_images_full')
				|| 'This object already holds the maximum number of images.'
		}
	}

	self._object_image_busy = true

	try {

		const ingested = await ingest_image_upload(self, file)
		if (!ingested.ok) {
			return ingested
		}

		const file_response = await self.tool_request({
			action	: 'get_image_file',
			options	: {
				tipo			: IMAGE_COMPONENT_TIPO,
				section_tipo	: IMAGE_SECTION_TIPO,
				section_id		: ingested.section_id
			}
		})

		if (request_failed(file_response)) {
			return {ok: false, error: error_text(file_response.error)}
		}

		const data = response_data(file_response)
		if (!data || !data.file_path) {
			// NOT "the record could not be created": by this point the record
			// exists and the file is ingested — what failed is that the answer
			// named no displayable file
			return {
				ok		: false,
				error	: self.get_tool_label('upload_image_error_no_display')
					|| 'The uploaded image has no version this browser can display.'
			}
		}

		const properties = ensure_properties(layer)
		properties.uca_maps = properties.uca_maps || {}
		if (!Array.isArray(properties.uca_maps.images)) {
			properties.uca_maps.images = []
		}
		properties.uca_maps.images.push({
			file_path		: data.file_path,
			quality			: data.quality,
			section_tipo	: IMAGE_SECTION_TIPO,
			section_id		: ingested.section_id,
			tipo			: IMAGE_COMPONENT_TIPO,
			name			: file.name || null
		})

		commit(self, layer)

		// THE ASSOCIATION IS APPLIED REGARDLESS OF WHAT IS SELECTED NOW. An
		// earlier revision bailed out here when the user had clicked another
		// shape mid-upload — and by this point the rsc170 record is minted,
		// the file is ingested and its path is resolved, so bailing out threw
		// away a real, successful upload and said nothing about it anywhere
		// (review finding, hito 16). `layer` is the captured, correct layer;
		// the hazard the old guard was written for is writing into a
		// DIFFERENT one, which capturing already prevents.
		//
		// What the guard is still needed for is the PANEL: `ok:true` tells the
		// caller to repaint a gallery that may now belong to another object,
		// so it reports whether this object is still the one on screen.
		const still_shown = Boolean(self.panel_node) && self.active_console_layer===layer

		return {ok: true, still_shown: still_shown}

	} catch (error) {
		console.error('tool_uca_maps: associate_image failed unexpectedly', error)
		report_client_error((error && error.message) || 'Image association failed')
		return {
			ok		: false,
			error	: self.get_tool_label('upload_error_transport') || 'The file could not be uploaded.'
		}
	} finally {
		self._object_image_busy = false
	}
}//end associate_image



/**
* REMOVE_OBJECT_IMAGE
* Drops one association. The MEDIA IS NOT DELETED — the rsc170 record and its
* files stay exactly where they are, and this only stops the geometry
* pointing at them.
*
* That is deliberate, not an omission: the record is a normal Resources/Image
* record a user may have catalogued, published or linked from elsewhere, and
* a map tool is not the place that decides to destroy it. v6 does the same
* (its gallery has no delete at all, so this is strictly more than parity).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {number} index - position in the stored array
* @returns {boolean} true when something was actually removed
*/
export const remove_object_image = function(self, layer, index) {

	const images = object_images(layer)
	if (!Number.isInteger(index) || index<0 || index>=images.length) {
		return false
	}

	images.splice(index, 1)
	commit(self, layer)

	return true
}//end remove_object_image



// @license-end
