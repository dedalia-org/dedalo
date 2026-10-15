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
import {tool_error_text} from './tool_error_text.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {create_source} from '../../../core/common/js/common.js'
import {commit, ensure_properties, report_client_error} from './object_console.js'
import {ingest_image_upload, ingest_staged_image} from './image_upload.js'



/** v6's own cap for the same feature (`create_pdf`: "Imágenes asociadas (Max. 30)").
 * Kept as a real limit, not just a PDF one: a console panel with hundreds of
 * thumbnails in it is not a gallery, and the geometry's properties are saved
 * inline with the record. */
export const MAX_OBJECT_IMAGES = 30

const IMAGE_SECTION_TIPO	= 'rsc170'
const IMAGE_COMPONENT_TIPO	= 'rsc29'

// The server downloads at the site's pace (one request per site every few
// seconds, robots.txt first) and may follow redirects: far past data_manager's
// 5 s per attempt, and tool_request cannot raise it.
const STAGE_EXTERNAL_IMAGE_TIMEOUT_MS = 4 * 60 * 1000



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

		const attached = await attach_ingested_image(self, layer, ingested.section_id, {
			name : file.name || null
		})
		if (!attached.ok) {
			return attached
		}

		commit(self, layer)

		return {ok: true, still_shown: is_still_shown(self, layer)}

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
* ATTACH_INGESTED_IMAGE
* Hangs an ingested rsc170 record off `layer`: asks where it is served from
* (`get_image_file`, `server/image_media.ts`) and stores that path, so the
* gallery never asks again. Does not commit: the caller decides when the
* gesture is over.
*
* THE ASSOCIATION IS APPLIED REGARDLESS OF WHAT IS SELECTED NOW. An earlier
* revision bailed out when the user had clicked another shape mid-upload —
* throwing away a real, successful ingest and saying nothing. `layer` is the
* captured, correct layer; capturing it is what prevents writing elsewhere.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {number} section_id - the ingested rsc170 record
* @param {Object} extra - fields the descriptor also keeps (`name`, `source_url`)
* @returns {Promise<{ok: boolean, error?: string}>}
*/
const attach_ingested_image = async function(self, layer, section_id, extra) {

	const file_response = await self.tool_request({
		action	: 'get_image_file',
		options	: {
			tipo			: IMAGE_COMPONENT_TIPO,
			section_tipo	: IMAGE_SECTION_TIPO,
			section_id		: section_id
		}
	})

	if (request_failed(file_response)) {
		const failed = self.get_tool_label('upload_image_error_failed') || 'The image could not be loaded.'
		return {ok: false, error: tool_error_text(file_response.error, failed)}
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
		section_id		: section_id,
		tipo			: IMAGE_COMPONENT_TIPO,
		...extra
	})

	return {ok: true}
}//end attach_ingested_image



/**
* IS_STILL_SHOWN
* Whether the console still shows `layer`: `ok:true` tells a caller to repaint
* a gallery that may by now belong to another object.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @returns {boolean}
*/
const is_still_shown = function(self, layer) {

	return Boolean(self.panel_node) && self.active_console_layer===layer
}//end is_still_shown



/**
* LINKED_IMAGES
* The images an object only LINKS to: `properties.images[]` entries with a
* `url` and no Dédalo record yet — v6's own test (`check_if_external_images`,
* `special_tools.js:7765-7875`, "section_tipo undefined"), the shape a
* GeoJSON from another system or a v6-style export carries.
*
* @param {Object} layer
* @returns {Array<Object>} the entries themselves, in order
*/
export const linked_images = function(layer) {

	const images = layer
		&& layer.feature
		&& layer.feature.properties
		&& layer.feature.properties.images

	if (!Array.isArray(images)) {
		return []
	}

	return images.filter(function(entry) {
		return entry!==null
			&& typeof entry==='object'
			&& typeof entry.url==='string'
			&& entry.url.trim()!==''
			&& entry.section_tipo===undefined
	})
}//end linked_images



/**
* EXTERNAL_IMAGES_ENABLED
* Whether this install allows the linked-image import (`get_capabilities`
* `externalImages`). Asked once per tool instance; a failed answer is "off"
* — a button that would only ever be refused is worse than no button.
*
* @param {Object} self - tool_uca_maps instance
* @returns {Promise<boolean>}
*/
export const external_images_enabled = function(self) {

	if (!self._external_images_enabled) {
		self._external_images_enabled = self.get_capabilities()
			.then(function(response) {
				const data = request_failed(response) ? null : response_data(response)
				return Boolean(data && data.externalImages===true)
			})
			.catch(function(error) {
				console.error('tool_uca_maps: external images capability lookup failed', error)
				return false
			})
	}

	return self._external_images_enabled
}//end external_images_enabled



/**
* STAGE_EXTERNAL_IMAGE
* Has the server download one linked image into the caller's staging dir.
* The tool_request RQO with its own timeout (see STAGE_EXTERNAL_IMAGE_TIMEOUT_MS).
*
* @param {Object} self - tool_uca_maps instance
* @param {string} url
* @returns {Promise<Object>} the api_response
*/
const stage_external_image = async function(self, url) {

	return await data_manager.request({
		body : {
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			prevent_lock	: true,
			source			: create_source(self, 'stage_external_image'),
			options			: {
				tipo			: self.geolocation.tipo,
				section_tipo	: self.geolocation.section_tipo,
				section_id		: self.geolocation.section_id,
				url				: url
			}
		},
		timeout		: STAGE_EXTERNAL_IMAGE_TIMEOUT_MS,
		// the panel shows its own progress line
		busy_notice	: false
	})
}//end stage_external_image



/**
* RELEASE_STAGED_IMAGE
* Drops a downloaded image the ingest refused before moving it — the same
* door the upload queue uses for a removed row. Without it every retry of a
* failing link leaves another copy (up to 100 MB) in the user's staging dir.
* Best effort: a refused release is logged, the import goes on.
*
* @param {Object} file_data - what `stage_external_image` answered
* @returns {Promise<void>}
*/
const release_staged_image = async function(file_data) {

	try {
		const response = await data_manager.request({
			body : {
				dd_api	: 'dd_utils_api',
				action	: 'delete_uploaded_file',
				options	: {
					key_dir		: file_data.key_dir,
					file_name	: file_data.tmp_name
				}
			}
		})
		if (request_failed(response)) {
			console.error('tool_uca_maps: staged image release refused', response.error)
		}
	} catch (error) {
		console.error('tool_uca_maps: staged image release failed', error)
	}
}//end release_staged_image



/**
* IMPORT_LINKED_IMAGES
* The "Import N linked images" gesture: each linked image is downloaded by the
* server, ingested like a picked file and MOVED into the object's own images
* (`source_url` keeps where it came from). Three deliberate departures from
* v6: it runs on this gesture only (v6 fires on click, load and upload); it
* dirties and never saves; a link that fails STAYS, with its reason (v6 drops
* it silently).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {Function} [on_progress] - called with (done, total) before each image
* @returns {Promise<{ok: boolean, imported: number, failures: Array<{url: string, error: string}>}>}
*/
export const import_linked_images = async function(self, layer, on_progress) {

	if (self._object_image_busy) {
		return {ok: false, imported: 0, failures: []}
	}
	self._object_image_busy = true

	const failed_text	= self.get_tool_label('upload_image_error_failed') || 'The image could not be loaded.'
	const pending		= linked_images(layer)
	const imported		= []
	const failures		= []

	try {

		for (let i = 0; i < pending.length; i++) {

			const entry = pending[i]
			const url	= entry.url.trim()

			if (object_images(layer).length >= MAX_OBJECT_IMAGES) {
				const full = self.get_tool_label('object_images_full')
					|| 'This object already holds the maximum number of images.'
				pending.slice(i).forEach(function(rest) {
					failures.push({url: rest.url.trim(), error: full})
				})
				break
			}

			if (typeof on_progress==='function') {
				on_progress(i, pending.length)
			}

			try {

				const stage_response = await stage_external_image(self, url)
				const staged = response_data(stage_response)
				if (!staged || !staged.file_data) {
					failures.push({
						url		: url,
						error	: request_failed(stage_response)
							? tool_error_text(stage_response.error, failed_text)
							: failed_text
					})
					continue
				}

				const ingested = await ingest_staged_image(self, staged.file_data)
				if (!ingested.ok) {
					if (ingested.staged_untouched===true) {
						await release_staged_image(staged.file_data)
					}
					failures.push({url: url, error: ingested.error || failed_text})
					continue
				}

				const attached = await attach_ingested_image(self, layer, ingested.section_id, {
					name		: staged.file_data.name || null,
					source_url	: url
				})
				if (!attached.ok) {
					failures.push({url: url, error: attached.error || failed_text})
					continue
				}

				imported.push(entry)

			} catch (error) {
				console.error('tool_uca_maps: linked image import failed unexpectedly', error)
				report_client_error((error && error.message) || 'Linked image import failed')
				failures.push({url: url, error: failed_text})
			}
		}

		// kept on the instance: the commit below re-renders the console, and
		// the panel that asked is gone by the time this returns
		self._linked_import_report = {layer: layer, failures: failures}

		if (imported.length > 0) {
			const properties = layer.feature.properties
			if (Array.isArray(properties.images)) {
				properties.images = properties.images.filter(function(entry) {
					return !imported.includes(entry)
				})
				if (properties.images.length===0) {
					delete properties.images
				}
			}
			commit(self, layer)
		}

		return {
			ok			: failures.length===0,
			imported	: imported.length,
			failures	: failures
		}

	} finally {
		self._object_image_busy = false
	}
}//end import_linked_images



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
